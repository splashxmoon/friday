import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Command, type Redis } from "ioredis";
import RedisMock from "ioredis-mock";
import { plainReason, setAside, writeAtomic } from "../safe-file.js";
import { LOG, LOG_CACHE_BYTES, LogStore, logData, logFile, parseLog, type MockData } from "./logs.js";

/**
 * The local edition's Redis: in this process, nothing to install, kept in one file on this computer.
 *
 * Friday's stores are written against Redis (sessions, the bus, everything else), and on someone's own computer there is no
 * Redis to point at. ioredis-mock speaks the same commands in memory, Lua scripts and pub/sub included, so every store works
 * unchanged. What it holds is written to `<home>/data.json` a moment after it changes and as the app closes, and read back as
 * it starts. Written whole or not at all (safe-file.ts writeAtomic), the file it replaces kept as `data.json.bak`: one that can't be
 * read is set aside and the copy opened, and the person told (SavesState). A save that fails is tried again until it goes through.
 *
 * Except each session's log, which is most of it and only grows: it is kept in `<home>/logs/<key's hash>.jsonl`, an entry a line,
 * and a save adds only the entries new since the last one. Written whole with the rest, a crew's day rewrote 150 MB every two
 * seconds and held the server for a quarter of a second each time (2026-11-04 soak: six agents made 10 MB in half an hour). A log
 * changed in place (secrets hidden, compaction: LSET) or cut is written whole again, that one file. The logs aren't read as Friday
 * starts, only their index (data.json says how many entries each file holds and its size): each is read from its file when it is
 * asked for, and the recently used ones kept in memory up to a ceiling (logs.ts).
 */

/** Commands that only read: anything else may have changed something, so the next save writes. */
const READS = new Set([
  "get", "mget", "exists", "type", "ttl", "pttl", "keys", "scan", "strlen", "getrange",
  "lrange", "llen", "lindex", "hget", "hgetall", "hmget", "hkeys", "hvals", "hlen", "hexists", "hscan",
  "smembers", "sismember", "smismember", "scard", "srandmember", "sscan", "sinter", "sunion", "sdiff",
  "zrange", "zrevrange", "zrangebyscore", "zrevrangebyscore", "zscore", "zcard", "zcount", "zrank", "zrevrank", "zscan", "zmscore",
  "ping", "echo", "info", "dbsize", "time", "subscribe", "psubscribe", "unsubscribe", "punsubscribe", "publish",
  "on", "once", "off", "removeListener", "emit", "duplicate", "disconnect", "quit", "connect", "status", "options",
]);

/** A row of data.json. A log's has its file, and how many entries the file holds and its size when that is all it holds. */
type Dumped = { k: string; t: "string" | "list" | "hash" | "set" | "zset"; v: unknown; px?: number; /** A log kept in a file of its own (logs/). */ file?: string; n?: number; b?: number };

export interface LocalKV {
  redis: Redis;
  sub: Redis;
  /** How saving is going, for the page. */
  saves: SavesHealth;
  /** The session logs (logs.ts): how much of them is in memory, for the tests. */
  logs: LogStore;
  /** Writes what changed now; the app calls it as it closes. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

async function dump(r: Redis, logs: LogStore): Promise<Dumped[]> {
  const out: Dumped[] = [];
  for (const k of await r.keys("*")) {
    const px = await r.pttl(k);
    const log = logs.index(k);
    if (log) {
      out.push({ k, t: "list", v: [], ...log, ...(px > 0 ? { px } : {}) });
      continue;
    }
    const t = (await r.type(k)) as Dumped["t"] | "none";
    let v: unknown;
    if (t === "string") v = await r.get(k);
    else if (t === "list") v = await r.lrange(k, 0, -1);
    else if (t === "hash") v = await r.hgetall(k);
    else if (t === "set") v = await r.smembers(k);
    else if (t === "zset") v = (await r.zrange(k, 0, "-1", "WITHSCORES")) as unknown as string[];
    else continue;
    out.push({ k, t, v, ...(px > 0 ? { px } : {}) });
  }
  return out;
}

/** A log's entries read from its file whole, and whether its last line is whole. */
async function readLog(home: string, file: string): Promise<{ items: string[]; whole: boolean; size: number }> {
  const text = await readFile(path.join(home, file), "utf8").catch(() => "");
  return { ...parseLog(text), size: Buffer.byteLength(text) };
}

async function rpushAll(r: Redis, k: string, items: string[]): Promise<void> {
  // In pieces: a day's log is many thousand entries, too many arguments for one call.
  for (let i = 0; i < items.length; i += 1000) await r.rpush(k, ...items.slice(i, i + 1000));
}

/**
 * Reads data.json's rows back. Each log is taken at the index's word when its file is the size the index says (it was written
 * with them and nothing since), and nothing of it read; otherwise (a data.json from before the index, or a file added to after it
 * was written, as when the computer went off between the two) its file is read now, and the next save writes the index.
 * Returns whether any log was read that way.
 */
async function load(r: Redis, logs: LogStore, rows: Dumped[], home: string): Promise<boolean> {
  let unindexed = false;
  const sizes = await Promise.all(rows.map((x) => (x.file ? stat(path.join(home, x.file)).then((s) => s.size, () => -1) : Promise.resolve(-1))));
  for (const [i, { k, t, v, px, file, n, b }] of rows.entries()) {
    if (file) {
      if (n !== undefined && b !== undefined && sizes[i] === b) {
        if (n > 0) logs.adopt(k, file, n, b);
      } else {
        unindexed = true;
        const { items, whole, size } = await readLog(home, file);
        // Cut short: written whole at the next save, never added to after the broken line.
        if (items.length) logs.adoptRead(k, file, items, whole, size);
      }
    } else if (t === "string") await r.set(k, String(v));
    else if (t === "list" && (v as string[]).length) await rpushAll(r, k, v as string[]);
    else if (t === "hash" && Object.keys(v as object).length) await r.hset(k, v as Record<string, string>);
    else if (t === "set" && (v as string[]).length) await r.sadd(k, ...(v as string[]));
    else if (t === "zset" && (v as string[]).length) {
      const flat = v as string[];
      const pairs: (string | number)[] = [];
      for (let i = 0; i < flat.length; i += 2) pairs.push(Number(flat[i + 1]), flat[i]!);
      await r.zadd(k, ...pairs);
    }
    if (px) await r.pexpire(k, px);
  }
  // A session's log with a file that data.json doesn't name. A Friday from before logs had files (v0.2.10) reads such a data.json
  // as every log empty and saves it without them; started again on this one, every session's history would be gone and the next
  // write under its name would write over its file (2026-11-04 update check, going back to v0.2.10 and forward again). The
  // session's other keys are still there ({sid}), so its file is found by them and read back. A data.json written before the
  // first save finished (cut off mid-move to files) names its logs whole, so whichever of the two holds more is kept; one that
  // isn't the other's start is set aside beside it, never written over.
  const named = new Set(rows.filter((x) => x.file).map((x) => x.k));
  const sessions = new Set(rows.map((x) => /^(.*?\{[^{}]+\})/.exec(x.k)?.[1]).filter((b): b is string => !!b));
  for (const k of [...sessions].map((b) => `${b}:events`)) {
    const file = logFile(k);
    if (named.has(k) || !existsSync(path.join(home, file))) continue;
    const { items, whole, size } = await readLog(home, file);
    const had = logs.has(k) ? logs.all(k) : [];
    const starts = (a: string[], b: string[]) => b.every((x, i) => a[i] === x);
    if (had.length >= items.length && starts(had, items)) continue;
    if (!starts(items, had)) {
      await rename(path.join(home, file), path.join(home, `${file}.aside-${Date.now()}`)).catch(() => {});
      continue;
    }
    const px = await r.pttl(k);
    logs.delete(k, false);
    logs.adoptRead(k, file, items, whole, size);
    if (px > 0) await r.pexpire(k, px);
    unindexed = true;
    console.log(`[friday] read ${k} back from ${file} (${items.length} entries): data.json didn't name it.`);
  }
  return unindexed;
}

/**
 * Marks the store changed on any call that isn't a read, then hands the call on. Multi and eval count as writes. A read of a
 * log's entries (LRANGE, LINDEX) has them read from its file first, without holding the server up (logs.ts warm), so the mock's
 * own synchronous read finds them in memory.
 */
function watched(r: Redis, changed: () => void, logs: LogStore): Redis {
  const at = (key: string, i: unknown) => {
    const n = parseInt(String(i), 10);
    return n < 0 ? logs.length(key) + n : n;
  };
  return new Proxy(r, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function" || typeof prop !== "string") return v;
      const name = prop.toLowerCase();
      if (name === "lrange" || name === "lindex")
        return (...args: unknown[]) => {
          const key = String(args[0]);
          if (!logs.has(key)) return (v as (...a: unknown[]) => unknown).apply(target, args);
          const s = at(key, args[1]);
          const e = name === "lrange" ? at(key, args[2]) + 1 : s + 1;
          return logs.warm(key, s, e).then(() => (v as (...a: unknown[]) => unknown).apply(target, args));
        };
      if (READS.has(name)) return v.bind(target);
      return (...args: unknown[]) => {
        changed();
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/**
 * ioredis 6 turns some replies (WITHSCORES, HGETALL and the like) into shape with a context saying which protocol answered;
 * ioredis-mock calls those with none, and every such reply threw. Given none, they get the protocol the mock speaks (RESP2).
 * Once per process, and only here: the hosted service never makes a mock.
 */
let patched = false;
function fitRepliesToMock(): void {
  if (patched) return;
  patched = true;
  // The mock's own table is ioredis's (Command._transformer); a real client always passes its context, so it is unchanged.
  const reply = (Command as unknown as { _transformer: { reply: Record<string, (r: unknown, c?: unknown) => unknown> } })._transformer.reply;
  for (const [name, fn] of Object.entries(reply)) reply[name] = (r: unknown, c?: unknown) => fn(r, c ?? { protocol: 2, replyMapping: "legacy" });
}


/**
 * How saving is going, for the page (SaveBanner.tsx): whether it is failing now and why, and what was found wrong with the saved
 * state as Friday started, said once (spec 13, Arun 2026-11-24: "nothing a person did is ever lost"). A full disk only logged, and
 * a data.json that couldn't be read was set aside and Friday opened empty, with no word to the person either time.
 */
export interface SavesState {
  /** Saving fails now: why, in plain words ("the disk is full"), and since when. Gone by itself once a save goes through. */
  failing?: { reason: string; since: number };
  /** Friday couldn't read its saved state as it started: it opened the last good copy, from `copyAt`, or started fresh with the old file kept at `kept`. */
  notice?: { kind: "copy"; copyAt: number; at: number } | { kind: "fresh"; kept: string; at: number };
}
export interface SavesHealth {
  state(): SavesState;
  /** Told each time the state changes. Returns the way to stop. */
  on(fn: (s: SavesState) => void): () => void;
  /** The notice has been shown: not again. */
  seen(): Promise<void>;
  /** Its routes (savesHttp), for app.ts, which then needn't load this file. */
  http(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /**
   * For Settings › Updates › Health (diagnostics.ts health): when a save last went through (data.json's own time until this Friday
   * has saved), and whether a change is still waiting to be written.
   */
  last?(): { savedAt: number | null; pending: boolean };
}

/** Where the notice waits until it is shown, in the store itself, so it is still there after a restart nobody saw. */
const NOTICE_KEY = "kv:saves-notice";
/** The longest wait between tries of a save that keeps failing. */
const RETRY_MAX_MS = 60_000;
/** A temp file one of our writes left behind when the computer went off mid-save (safe-file.ts writeAtomic). */
const LEFT_TEMP = /^\..+\.[0-9a-f]{8}\.tmp$/;

/**
 * `home`: where Friday keeps its things on this computer (data.json, uploads). `saveMs`: how long after a change it is written.
 * `logCache`: the most bytes of session logs kept in memory beyond what must be (FRIDAY_LOG_CACHE_MB, else 64 MB).
 */
export async function localKV(home: string, saveMs = 2000, o: { logCache?: number } = {}): Promise<LocalKV> {
  fitRepliesToMock();
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, "data.json");
  /** The copy data.json was before the last save: the last good one, opened when data.json can't be. */
  const bak = `${file}.bak`;
  const logsDir = path.join(home, "logs");
  const raw = new (RedisMock as unknown as new () => Redis)();
  // Mocks in one process share their data (as connections to one server would): what this one holds is the file's, not a
  // store opened earlier in the same process.
  await raw.flushall();
  // The session logs: kept by the store in logs.ts, read from their files as they are asked for. Every command reaches the
  // mock's data through its `data` object, Lua scripts and MULTI too, so this one stands in for it (and for `sub`'s, a duplicate).
  const fromEnv = Number(process.env.FRIDAY_LOG_CACHE_MB) * 1048576;
  const logs = new LogStore(home, { budget: o.logCache ?? (fromEnv > 0 ? fromEnv : LOG_CACHE_BYTES) });
  const mock = raw as unknown as { data: MockData; expires: { has(k: string): boolean; isExpired(k: string): boolean; delete(k: string): void }; context: { modifiedKeyEvents: { emit(e: string, k: string): void } } };
  mock.data = logData(mock.data, logs, mock.expires, (k) => mock.context.modifiedKeyEvents.emit("modified", k));
  // Left by a save the computer went off in the middle of: never read, so they'd only pile up.
  for (const dir of [home, logsDir]) for (const f of await readdir(dir).catch(() => [] as string[])) if (LEFT_TEMP.test(f)) await rm(path.join(dir, f), { force: true }).catch(() => {});
  /** A log read whole as it started, its index not there or not right: the next save, soon, writes it. */
  let unindexed = false;
  const read = async (from: string) => {
    const rows = JSON.parse(await readFile(from, "utf8")) as unknown;
    if (!Array.isArray(rows)) throw new Error("it isn't a list of keys");
    try {
      unindexed = await load(raw, logs, rows as Dumped[], home);
    } catch (e) {
      // Half read is not read: nothing of it is kept, so what comes next starts clean. The logs' files are left as they are.
      logs.clear(false);
      await raw.flushall();
      throw e;
    }
  };
  let notice: SavesState["notice"] | undefined;
  /** data.json couldn't be read (it is set aside as `aside`): the last good copy, else a fresh start, and the person told which. */
  const fallBack = async (aside: string) => {
    if (existsSync(bak)) {
      try {
        await read(bak);
        notice = { kind: "copy", copyAt: (await stat(bak)).mtimeMs, at: Date.now() };
        console.error(`[friday] opened the last good copy (${bak}) instead.`);
        return;
      } catch (e) {
        // Kept as well, beside the other: the next saves would rename over it.
        const also = await setAside(bak);
        console.error(`[friday] couldn't read ${bak} either (${(e as Error).message}); kept it as ${also ?? bak}.`);
      }
    }
    notice = { kind: "fresh", kept: aside, at: Date.now() };
    console.error(`[friday] started fresh; the old file is kept at ${aside}.`);
  };
  if (existsSync(file)) {
    try {
      await read(file);
    } catch (e) {
      // A file that can't be read is set aside rather than written over, so nothing is lost by starting.
      const aside = (await setAside(file)) ?? file;
      console.error(`[friday] couldn't read ${file} (${(e as Error).message}); kept it as ${aside}.`);
      await fallBack(aside);
    }
  } else if (existsSync(bak)) {
    // Cut off between keeping the last copy and putting the new one in its place: the last copy is the newest whole one, and the
    // save after it is in the logs, which are their own files. Nothing to tell: nothing was lost.
    try {
      await read(bak);
      console.log(`[friday] ${file} wasn't there; opened ${bak}, the copy from the save before.`);
    } catch (e) {
      const aside = (await setAside(bak)) ?? bak;
      console.error(`[friday] couldn't read ${bak} (${(e as Error).message}); kept it as ${aside}.`);
      notice = { kind: "fresh", kept: aside, at: Date.now() };
    }
  }
  if (notice) await raw.set(NOTICE_KEY, JSON.stringify(notice));
  else {
    // One from a start before that the person hasn't seen yet.
    try {
      notice = (JSON.parse((await raw.get(NOTICE_KEY)) ?? "null") as SavesState["notice"] | null) ?? undefined;
    } catch {
      notice = undefined;
    }
  }

  // A log read whole as it started has its index written soon, so the next start needn't read it again.
  let dirty = !!notice || unindexed;
  /** When a save last went through: the file's own time until this Friday has saved. */
  let savedAt: number | null = await stat(file).then((s) => s.mtimeMs, () => null);
  let timer: NodeJS.Timeout | null = null;
  let saving: Promise<void> = Promise.resolve();
  let closing = false;
  /** Saving fails now, and how many times in a row: each try waits twice as long as the last, to a minute. */
  let failing: SavesState["failing"] | undefined;
  let failures = 0;
  const listeners = new Set<(s: SavesState) => void>();
  const state = (): SavesState => ({ ...(failing ? { failing } : {}), ...(notice ? { notice } : {}) });
  const tell = () => {
    const s = state();
    for (const l of listeners) l(s);
  };
  const schedule = (ms: number) => {
    if (closing) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void save(), ms);
    timer.unref?.();
  };
  const save = (): Promise<void> => {
    timer = null;
    if (!dirty) return saving;
    dirty = false;
    saving = saving
      .then(async () => {
        await mkdir(logsDir, { recursive: true, mode: 0o700 });
        // The logs first: data.json names them, so it never names one whose file isn't written yet. Only what changed: a log added
        // to gets its new entries added to its file, one changed in place (or never saved yet) is written whole (logs.ts save).
        await logs.save();
        // The file it replaces is kept as the last good copy (renamed, so it costs nothing).
        await writeAtomic(file, JSON.stringify(await dump(raw, logs)), { mode: 0o600, backup: bak });
      })
      .then(
        () => {
          savedAt = Date.now();
          if (!failing) return;
          console.log(`[friday] saving works again (after ${failures} ${failures === 1 ? "try" : "tries"}).`);
          failing = undefined;
          failures = 0;
          tell();
        },
        (e) => {
          // Not saved, so not forgotten: still to save. A log whose append failed is written whole next time (one cut short by a
          // full disk may have left half a line), and the logs not reached yet keep what they have to write (logs.ts save).
          dirty = true;
          failures++;
          const reason = plainReason(e, home);
          if (failures === 1 || failures % 10 === 0 || failing?.reason !== reason) console.error(`[friday] couldn't save to ${file} (try ${failures}): ${(e as Error).message}`);
          if (failing?.reason !== reason) {
            failing = { reason, since: failing?.since ?? Date.now() };
            tell();
          }
          // Tried again by itself: two seconds, then four, eight, up to a minute between tries, until it goes through.
          schedule(Math.min(saveMs * 2 ** (failures - 1), RETRY_MAX_MS));
        },
      );
    return saving;
  };
  const changed = () => {
    dirty = true;
    if (!timer) schedule(saveMs);
  };
  // A notice just made is saved soon, so it is there after a restart even if nothing else changes first.
  if (dirty) schedule(saveMs);
  const redis = watched(raw, changed, logs);
  // The bus's own connection: the same data, its own subscriptions.
  const sub = raw.duplicate() as Redis;
  const saves: SavesHealth = {
    state,
    on: (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
    seen: async () => {
      if (!notice) return;
      notice = undefined;
      await raw.del(NOTICE_KEY);
      changed();
      tell();
    },
    http: (req, res, url) => savesHttp(saves, req, res, url),
    last: () => ({ savedAt, pending: dirty || !!timer || logs.dirty() }),
  };
  return {
    redis,
    sub,
    saves,
    logs,
    flush: async () => {
      if (timer) clearTimeout(timer);
      timer = null;
      await save();
    },
    close: async () => {
      if (timer) clearTimeout(timer);
      timer = null;
      closing = true;
      await save();
      listeners.clear();
      sub.disconnect();
      raw.disconnect();
    },
  };
}

/**
 * The page's view of saving (SaveBanner.tsx), from this computer's own page only (app.ts):
 *   GET  /api/local/saves          how saving is going now
 *   GET  /api/local/saves/events   told each time that changes (server-sent events), and once as it opens
 *   POST /api/local/saves/seen     the notice has been shown
 */
export async function savesHttp(saves: SavesHealth, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname;
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
    return true;
  };
  if (p === "/api/local/saves" && req.method === "GET") return send(200, saves.state());
  if (p === "/api/local/saves/seen" && req.method === "POST") {
    await saves.seen();
    return send(200, saves.state());
  }
  if (p === "/api/local/saves/events" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", Connection: "keep-alive" });
    res.write(`retry: 3000\ndata: ${JSON.stringify(saves.state())}\n\n`);
    const off = saves.on((s) => void res.write(`data: ${JSON.stringify(s)}\n\n`));
    const keep = setInterval(() => void res.write(": still here\n\n"), 45_000);
    keep.unref?.();
    const end = () => (off(), clearInterval(keep));
    req.on("close", end);
    res.on("close", end);
    return true;
  }
  return false;
}
