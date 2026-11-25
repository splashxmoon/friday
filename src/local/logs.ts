import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { appendDurable, writeAtomic } from "../safe-file.js";

/**
 * Each session's log in the local edition's store (kv.ts), read from its file when it is asked for instead of all of them held in
 * memory from the start (spec 13, Arun 2026-11-24: "Go all out and fix these problems"). With a long history Friday read every log
 * whole before it answered (85 MB of them, a third of a second) and kept them all for good: 274 MB of the heap, never let go.
 *
 * What is kept for every log is its index: which file, how many entries, how many of them the file holds and how big it is. A
 * log's entries are read when something asks for them: the newest few from the end of its file, or the whole of it, kept in a
 * cache of recently used logs with a ceiling (64 MB by default), the least recently used let go first. Entries added since the
 * last save are held until they are written (`pending`), and a log changed in place (secrets hidden, compaction: LSET) or
 * replaced whole is held whole until it is written again (`all`).
 *
 * The store underneath is ioredis-mock, whose every command, Lua scripts and MULTI included, goes through its `data` object.
 * `logData` stands in for that object: a log's key answers with a view (`LogView`) that knows the log's length without reading it,
 * reads only the entries a command looks at, and records what a command adds or sets, which `set` then applies. Everything else
 * is handed on to the mock's own data unchanged.
 */

/** A session's log (session/keys.ts): appended to, now and then changed in place. */
export const LOG = /:events$/;

/** Where a log is kept, by its key's hash: a key may hold any character. Relative to the home folder. */
export const logFile = (k: string) => `logs/${createHash("sha256").update(k).digest("hex").slice(0, 32)}.jsonl`;

/** The default ceiling on logs held in memory beyond what is still to be saved. */
export const LOG_CACHE_BYTES = 64 * 1048576;
/** A read this close to a log's end is read from the end of its file; one further back reads the whole log. */
const TAIL_MAX = 4096;
/** What an entry costs in memory beyond its text, roughly: the string's own header and the slot pointing at it. */
const ENTRY_OVERHEAD = 40;

/**
 * A log's entries from the text of its file: a line each, at most `max`. A last line cut short (the computer went off mid-write)
 * is left out, and the file is then not `whole`: added to as it was, the next entries would follow the broken line and be left out
 * with it at the next start, every start after (2026-11-04 update check: three events lost at each restart).
 */
export function parseLog(text: string, max = Infinity): { items: string[]; whole: boolean } {
  const items: string[] = [];
  let whole = !text || text.endsWith("\n");
  let at = 0;
  while (at < text.length && items.length < max) {
    const nl = text.indexOf("\n", at);
    const line = text.slice(at, nl < 0 ? text.length : nl);
    at = nl < 0 ? text.length : nl + 1;
    if (!line) continue;
    try {
      items.push(String(JSON.parse(line)));
    } catch {
      whole = false;
      break;
    }
  }
  return { items, whole };
}

const sizeOf = (items: readonly string[]) => items.reduce((n, s) => n + s.length + ENTRY_OVERHEAD, 0);
const lines = (items: readonly string[]) => (items.length ? items.map((x) => JSON.stringify(x)).join("\n") + "\n" : "");

/** One log: its index, and whatever of it is in memory. */
class Log {
  /** How many entries. */
  len: number;
  /** How many of the first entries its file holds, exactly, as its first lines. */
  saved: number;
  /** Its file's size in bytes when it is exactly the first `saved` entries. */
  size: number;
  /** The file may hold more than its first `saved` lines (a line cut short, an append that failed partway): written whole next. */
  junk = false;
  /** Entries `saved` to `len`: added, not written yet. Held until they are. */
  pending: string[] = [];
  /** Changed in place or replaced: every entry, held until written whole. The file and `pending` don't count while set. */
  all: string[] | null = null;
  /** The file's entries in memory, a cache: from `from` to `saved`. */
  cached: { from: number; items: string[]; bytes: number } | null = null;
  /** Bumped by each change other than an append, so a save or a read can tell one happened while it waited. */
  gen = 0;
  used = 0;
  /** A read of its file under way, shared by whoever asks meanwhile. */
  reading: Promise<void> | null = null;
  constructor(
    readonly key: string,
    readonly file: string,
    n: number,
    size: number,
  ) {
    this.len = n;
    this.saved = n;
    this.size = size;
  }
}

export interface LogStoreOptions {
  /** The most bytes of logs kept in memory beyond what must be (unsaved, or changed in place). */
  budget?: number;
}

export class LogStore {
  private logs = new Map<string, Log>();
  /** Logs deleted since the last save: their files go then, unless a log of the same name took their place. */
  private gone = new Set<string>();
  private cachedBytes = 0;
  private budget: number;
  private tick = 0;
  /** Told when a log's file is read synchronously, which a read through the Redis-like API never needs (for the tests). */
  onSyncRead?: (key: string) => void;

  constructor(
    readonly home: string,
    o: LogStoreOptions = {},
  ) {
    this.budget = o.budget ?? LOG_CACHE_BYTES;
  }

  has(key: string): boolean {
    return this.logs.has(key);
  }
  keys(): string[] {
    return [...this.logs.keys()];
  }
  length(key: string): number {
    return this.logs.get(key)?.len ?? 0;
  }
  /** Bytes of logs in memory, the cache's and what must be held. */
  memory(): { cached: number; held: number } {
    let held = 0;
    for (const l of this.logs.values()) held += l.all ? sizeOf(l.all) : sizeOf(l.pending);
    return { cached: this.cachedBytes, held };
  }

  /** A log read back as Friday starts: from data.json's index when its file is as it says, else from the file itself. */
  adopt(key: string, file: string, n: number, size: number): void {
    const l = new Log(key, file, n, size);
    this.logs.set(key, l);
  }
  /** A log whose file was read whole as Friday started (no index for it, or the file isn't as the index says). */
  adoptRead(key: string, file: string, items: string[], whole: boolean, size: number): void {
    const l = new Log(key, file, items.length, size);
    l.junk = !whole;
    this.logs.set(key, l);
    this.fill(l, 0, items);
  }

  /** What data.json says of a log: its file, and, when the file is exactly its entries, how many and how big. */
  index(key: string): { file: string; n?: number; b?: number } | null {
    const l = this.logs.get(key);
    if (!l) return null;
    return !l.all && !l.junk ? { file: l.file, n: l.saved, b: l.size } : { file: l.file };
  }

  /** Entries `start` to `end` (not included), clipped to the log. Reads its file synchronously if they aren't in memory. */
  range(key: string, start: number, end: number): string[] {
    const l = this.logs.get(key);
    if (!l) return [];
    const s = Math.max(0, start);
    const e = Math.min(l.len, end);
    if (s >= e) return [];
    this.touch(l);
    if (l.all) return l.all.slice(s, e);
    const out: string[] = [];
    if (s < l.saved) {
      const to = Math.min(e, l.saved);
      if (!l.cached || l.cached.from > s) this.readSync(l, s);
      out.push(...l.cached!.items.slice(s - l.cached!.from, to - l.cached!.from));
    }
    if (e > l.saved) out.push(...l.pending.slice(Math.max(0, s - l.saved), e - l.saved));
    return out;
  }
  at(key: string, i: number): string | undefined {
    return this.range(key, i, i + 1)[0];
  }

  /**
   * Have entries `start` to `end` in memory, read from the file without holding the server up: the newest few from the end of
   * the file, more than that the whole log. What the Redis-like API calls before a read (kv.ts), so `range` never reads synchronously.
   */
  async warm(key: string, start: number, end: number): Promise<void> {
    for (let tries = 0; tries < 3; tries++) {
      const l = this.logs.get(key);
      if (!l || l.all) return;
      const s = Math.max(0, start);
      if (s >= Math.min(l.len, end) || s >= l.saved) return;
      if (l.cached && l.cached.from <= s) return;
      if (l.reading) {
        await l.reading.catch(() => {});
        continue;
      }
      const from = l.saved - s <= TAIL_MAX && !l.junk ? s : 0;
      const [saved, gen, size] = [l.saved, l.gen, l.size];
      l.reading = (async () => {
        const items = from > 0 ? await this.readTail(l, from, saved, size) : await this.readWhole(l, saved);
        // Saved or changed while it read: what was read may not be what the index says now; read again.
        if (this.logs.get(key) !== l || l.saved !== saved || l.gen !== gen || l.all || items.length !== saved - from) return;
        this.fill(l, from, items);
      })().finally(() => (l.reading = null));
      await l.reading.catch(() => {});
    }
  }

  /** Adds entries to the end of a log, making it if there is none. */
  append(key: string, items: string[]): number {
    const l = this.logs.get(key);
    if (!l) return this.replace(key, items);
    if (l.all) l.all.push(...items);
    else l.pending.push(...items);
    l.len += items.length;
    this.touch(l);
    return l.len;
  }

  /** Entries changed in place: the log is held whole until it is written whole. */
  setAt(key: string, changes: Map<number, string>): void {
    const l = this.logs.get(key);
    if (!l || !changes.size) return;
    const all = this.whole(l);
    for (const [i, v] of changes) if (i >= 0 && i < all.length) all[i] = v;
    this.pin(l, all);
  }

  /**
   * The log's entries replaced, all of them (a new log, or a command that rewrote it). An empty one is kept while Friday runs, as
   * the in-memory store kept one, and not read back at the next start, as it wasn't.
   */
  replace(key: string, items: string[]): number {
    let l = this.logs.get(key);
    if (!l) {
      // A new log: whatever file a log of the name had before isn't this one's, so it is written whole.
      l = new Log(key, logFile(key), 0, 0);
      l.saved = 0;
      l.junk = true;
      this.logs.set(key, l);
    }
    this.pin(l, items.slice());
    return l.len;
  }

  /** `gone`: its file goes at the next save. Not when the store is only letting go of what it read (a start that failed partway). */
  delete(key: string, gone = true): boolean {
    const l = this.logs.get(key);
    if (!l) return false;
    this.drop(l);
    this.logs.delete(key);
    if (gone) this.gone.add(key);
    return true;
  }

  clear(gone = true): void {
    for (const k of [...this.logs.keys()]) this.delete(k, gone);
  }

  /** Every entry, read synchronously if need be: for a command that changes the log in place. */
  all(key: string): string[] {
    const l = this.logs.get(key);
    return l ? this.whole(l).slice() : [];
  }

  /** Whether anything is still to be written. */
  dirty(): boolean {
    if (this.gone.size) return true;
    for (const l of this.logs.values()) if (l.all || l.junk || l.pending.length) return true;
    return false;
  }

  /**
   * Writes what changed: the files of deleted logs removed, a log changed in place or with a broken file written whole, and a
   * log only added to gets its new entries added to its file. Throws the first write that fails, after marking that log to be
   * written whole next time (an append cut short by a full disk may have left half a line); the rest wait for the next save.
   */
  async save(): Promise<void> {
    for (const k of [...this.gone]) {
      this.gone.delete(k);
      if (this.logs.has(k)) continue;
      try {
        await rm(path.join(this.home, logFile(k)), { force: true });
      } catch (e) {
        this.gone.add(k);
        throw e;
      }
    }
    for (const l of [...this.logs.values()]) {
      if (this.logs.get(l.key) !== l) continue;
      const to = path.join(this.home, l.file);
      if (l.all || l.junk) {
        const gen = l.gen;
        const all = l.all ? l.all.slice() : [...this.fileEntries(l, await this.readWholeFor(l)), ...l.pending];
        const text = lines(all);
        await writeAtomic(to, text, { mode: 0o600 });
        if (this.logs.get(l.key) !== l || l.gen !== gen) continue;
        // Written: held as the cache now, and whatever was added while it wrote is still to add.
        const after = l.all ? l.all.slice(all.length) : l.pending.slice(all.length - l.saved);
        this.drop(l);
        l.all = null;
        l.junk = false;
        l.saved = all.length;
        l.size = Buffer.byteLength(text);
        l.pending = after;
        this.fill(l, 0, all);
        continue;
      }
      if (!l.pending.length) continue;
      const add = l.pending.slice();
      const text = lines(add);
      try {
        await appendDurable(to, text, 0o600);
      } catch (e) {
        if (this.logs.get(l.key) === l && !l.all) l.junk = true;
        throw e;
      }
      if (this.logs.get(l.key) !== l || l.all) continue;
      l.pending.splice(0, add.length);
      l.saved += add.length;
      l.size += Buffer.byteLength(text);
      if (l.cached) {
        l.cached.items.push(...add);
        const more = sizeOf(add);
        l.cached.bytes += more;
        this.cachedBytes += more;
        this.evict(l);
      }
    }
  }

  // ── in memory ──

  private touch(l: Log): void {
    l.used = ++this.tick;
  }
  /** The file's entries from `from` held in memory, then the least recently used logs let go until it is back under its ceiling. */
  private fill(l: Log, from: number, items: string[]): void {
    this.drop(l);
    const bytes = sizeOf(items);
    l.cached = { from, items, bytes };
    this.cachedBytes += bytes;
    this.touch(l);
    this.evict(l);
  }
  private drop(l: Log): void {
    if (!l.cached) return;
    this.cachedBytes -= l.cached.bytes;
    l.cached = null;
  }
  /** Least recently used first, never `keep` (just read: a log bigger than the whole ceiling stays until another is used). */
  private evict(keep: Log): void {
    if (this.cachedBytes <= this.budget) return;
    const by = [...this.logs.values()].filter((l) => l.cached && l !== keep).sort((a, b) => a.used - b.used);
    for (const l of by) {
      if (this.cachedBytes <= this.budget) break;
      this.drop(l);
    }
  }
  private pin(l: Log, all: string[]): void {
    this.drop(l);
    l.all = all;
    l.len = all.length;
    l.pending = [];
    l.gen++;
    this.touch(l);
  }
  /** Every entry, from memory or read from the file now. */
  private whole(l: Log): string[] {
    if (l.all) return l.all;
    if (!l.cached || l.cached.from > 0) this.readSync(l, 0);
    return [...l.cached!.items, ...l.pending];
  }
  private readSync(l: Log, _from: number): void {
    this.onSyncRead?.(l.key);
    const text = (() => {
      try {
        return readFileSync(path.join(this.home, l.file), "utf8");
      } catch {
        return "";
      }
    })();
    this.fill(l, 0, this.fileEntries(l, text));
  }
  /** The first `saved` entries of a file's text; fewer if the file has fewer (it was changed outside Friday). */
  private fileEntries(l: Log, text: string): string[] {
    return parseLog(text, l.saved).items;
  }
  private async readWholeFor(l: Log): Promise<string> {
    return readFile(path.join(this.home, l.file), "utf8").catch(() => "");
  }
  private async readWhole(l: Log, saved: number): Promise<string[]> {
    return parseLog(await this.readWholeFor(l), saved).items;
  }
  /**
   * Entries `from` to `saved` from the end of a file of exactly `saved` entries in `size` bytes, read backwards a piece at a time
   * until enough lines are in. A line is a JSON string, which never holds a newline, and a newline byte is never part of another
   * character in UTF-8, so the pieces are cut at newlines safely.
   */
  private async readTail(l: Log, from: number, saved: number, size: number): Promise<string[]> {
    const want = saved - from;
    const h = await open(path.join(this.home, l.file), "r");
    try {
      const chunks: Buffer[] = [];
      let pos = size;
      let newlines = 0;
      // One more newline than lines wanted: the one ending the line before the first wanted (or the file's start).
      while (pos > 0 && newlines <= want) {
        const n = Math.min(256 * 1024, pos);
        pos -= n;
        const b = Buffer.alloc(n);
        const { bytesRead } = await h.read(b, 0, n, pos);
        const got = b.subarray(0, bytesRead);
        for (let i = 0; i < got.length; i++) if (got[i] === 10) newlines++;
        chunks.unshift(got);
      }
      const text = Buffer.concat(chunks).toString("utf8");
      const all = text.split("\n");
      // The last element is what follows the final newline: nothing, in a file of whole lines.
      if (all.at(-1) === "") all.pop();
      return all.slice(Math.max(0, all.length - want)).map((x) => String(JSON.parse(x)));
    } finally {
      await h.close();
    }
  }
}

/**
 * ioredis-mock's data object (its `data`), with each log's key answered by the store above. See the top of this file.
 */
export interface MockData {
  get(key: string): unknown;
  set(key: string, v: unknown): void;
  has(key: string): boolean;
  delete(key: string): void;
  keys(): string[];
  clear(): void;
  withKeyPrefix(p: string): MockData;
}
interface MockExpires {
  has(key: string): boolean;
  isExpired(key: string): boolean;
  delete(key: string): void;
}

/** What a view recorded: entries set in place, entries added, or (any other change) the whole list it now is. */
interface ViewState {
  key: string;
  base: number;
  sets: Map<number, string>;
  pushed: string[];
  whole: string[] | null;
}
const views = new WeakMap<object, ViewState>();
const INDEX = /^(0|[1-9]\d*)$/;

/**
 * A log as a list a command can read and change: its length without reading it, the entries a command looks at read as it looks,
 * and what it sets or adds recorded. Anything else a command does to it (splice, shift, sort, iterating it) reads the whole log
 * into a plain list first, and from then on it is that list.
 */
function logView(store: LogStore, key: string): unknown[] {
  const st: ViewState = { key, base: store.length(key), sets: new Map(), pushed: [], whole: null };
  const len = () => st.base + st.pushed.length;
  const read = (i: number): string | undefined => (i < st.base ? (st.sets.get(i) ?? store.at(key, i)) : st.pushed[i - st.base]);
  const materialise = (): string[] => {
    if (!st.whole) {
      const w = store.range(key, 0, st.base);
      for (const [i, v] of st.sets) w[i] = v;
      w.push(...st.pushed);
      st.whole = w;
    }
    return st.whole;
  };
  const slice = (a?: number, b?: number): string[] => {
    const n = len();
    const rel = (x: number | undefined, d: number) => (x === undefined ? d : x < 0 ? Math.max(0, n + Math.trunc(x)) : Math.min(n, Math.trunc(x)));
    const s = rel(a, 0);
    const e = rel(b, n);
    if (s >= e) return [];
    const out = s < st.base ? store.range(key, s, Math.min(e, st.base)) : [];
    for (const [i, v] of st.sets) if (i >= s && i < e && i < st.base) out[i - s] = v;
    if (e > st.base) out.push(...st.pushed.slice(Math.max(0, s - st.base), e - st.base));
    return out;
  };
  const proxy: unknown[] = new Proxy([] as unknown[], {
    get(target, prop, receiver) {
      if (st.whole) return prop === "length" ? st.whole.length : Reflect.get(st.whole, prop);
      if (prop === "length") return len();
      if (typeof prop === "string" && INDEX.test(prop)) return read(Number(prop));
      if (prop === "slice") return slice;
      if (prop === "push") return (...v: unknown[]) => (st.pushed.push(...v.map(String)), len());
      if (prop === "constructor") return Array;
      if (typeof prop === "symbol" && prop !== Symbol.iterator) return Reflect.get(target, prop, receiver);
      return Reflect.get(materialise(), prop);
    },
    set(_t, prop, value) {
      if (!st.whole && typeof prop === "string" && INDEX.test(prop)) {
        const i = Number(prop);
        if (i < st.base) return st.sets.set(i, String(value)), true;
        if (i < len()) return (st.pushed[i - st.base] = String(value)), true;
        if (i === len()) return st.pushed.push(String(value)), true;
      }
      return Reflect.set(materialise(), prop, value);
    },
    has(_t, prop) {
      return Reflect.has(materialise(), prop);
    },
    deleteProperty(_t, prop) {
      return Reflect.deleteProperty(materialise(), prop);
    },
    ownKeys() {
      return Reflect.ownKeys(materialise());
    },
    getOwnPropertyDescriptor(_t, prop) {
      const d = Reflect.getOwnPropertyDescriptor(materialise(), prop);
      // The target's own length can't be said to be configurable: it isn't.
      return d && prop === "length" ? { ...d, configurable: false } : d;
    },
    defineProperty(_t, prop, d) {
      return Reflect.defineProperty(materialise(), prop, d);
    },
  });
  views.set(proxy, st);
  return proxy;
}

/**
 * The mock's data with the logs in the store: `base` keeps every other key. `expires` is the mock's own, so a log given a time to
 * live goes when it runs out, as any key does. `modified` is told of each change to a log, for WATCH.
 */
export function logData(base: MockData, store: LogStore, expires: MockExpires, modified: (key: string) => void): MockData {
  const live = (key: string): boolean => {
    if (!store.has(key)) return false;
    if (expires.has(key) && expires.isExpired(key)) {
      expires.delete(key);
      store.delete(key);
      modified(key);
      return false;
    }
    return true;
  };
  const data: MockData = {
    get: (key) => (live(key) ? logView(store, key) : base.get(key)),
    has: (key) => live(key) || base.has(key),
    set(key, v) {
      const st = Array.isArray(v) ? views.get(v as object) : undefined;
      if (st && st.key === key && !st.whole && store.has(key) && store.length(key) === st.base) {
        // The view of this log a command just read and changed: what it set, then what it added.
        if (st.sets.size) store.setAt(key, st.sets);
        if (st.pushed.length) store.append(key, st.pushed);
      } else if (Array.isArray(v) && LOG.test(key)) {
        base.delete(key);
        store.replace(key, st ? (st.whole ?? [...(v as string[])]).map(String) : (v as unknown[]).map(String));
      } else {
        if (store.has(key)) store.delete(key);
        base.set(key, v);
        return;
      }
      modified(key);
    },
    delete(key) {
      if (store.delete(key)) modified(key);
      base.delete(key);
    },
    keys: () => [...base.keys(), ...store.keys().filter(live)],
    clear() {
      store.clear();
      base.clear();
    },
    withKeyPrefix: () => data,
  };
  return data;
}
