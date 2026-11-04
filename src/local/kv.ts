import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command, type Redis } from "ioredis";
import RedisMock from "ioredis-mock";

/**
 * The local edition's Redis: in this process, nothing to install, kept in one file on this computer.
 *
 * Friday's stores are written against Redis (sessions, the bus, everything else), and on someone's own computer there is no
 * Redis to point at. ioredis-mock speaks the same commands in memory, Lua scripts and pub/sub included, so every store works
 * unchanged. What it holds is written to `<home>/data.json` a moment after it changes and as the app closes, and read back as
 * it starts.
 *
 * Except each session's log (LOG), which is most of it and only grows: it is kept in `<home>/logs/<key's hash>.jsonl`, an entry
 * a line, and a save adds only the entries new since the last one. Written whole with the rest, a crew's day rewrote 150 MB every
 * two seconds and held the server for a quarter of a second each time (2026-11-04 soak: six agents made 10 MB in half an hour).
 * A log changed in place (secrets hidden, compaction: LSET) or cut is written whole again, that one file.
 */
/** A session's log (session/keys.ts): appended to, now and then changed in place. */
const LOG = /:events$/;
/** Commands that add to the end of a list and nothing else: a log they touch can be saved by adding its new entries. */
const APPENDS = new Set(["rpush", "rpushx"]);

/** Commands that only read: anything else may have changed something, so the next save writes. */
const READS = new Set([
  "get", "mget", "exists", "type", "ttl", "pttl", "keys", "scan", "strlen", "getrange",
  "lrange", "llen", "lindex", "hget", "hgetall", "hmget", "hkeys", "hvals", "hlen", "hexists", "hscan",
  "smembers", "sismember", "smismember", "scard", "srandmember", "sscan", "sinter", "sunion", "sdiff",
  "zrange", "zrevrange", "zrangebyscore", "zrevrangebyscore", "zscore", "zcard", "zcount", "zrank", "zrevrank", "zscan", "zmscore",
  "ping", "echo", "info", "dbsize", "time", "subscribe", "psubscribe", "unsubscribe", "punsubscribe", "publish",
  "on", "once", "off", "removeListener", "emit", "duplicate", "disconnect", "quit", "connect", "status", "options",
]);

type Dumped = { k: string; t: "string" | "list" | "hash" | "set" | "zset"; v: unknown; px?: number; /** A log kept in a file of its own (logs/). */ file?: string };

export interface LocalKV {
  redis: Redis;
  sub: Redis;
  /** Writes what changed now; the app calls it as it closes. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

async function dump(r: Redis): Promise<Dumped[]> {
  const out: Dumped[] = [];
  for (const k of await r.keys("*")) {
    const t = (await r.type(k)) as Dumped["t"] | "none";
    const px = await r.pttl(k);
    let v: unknown;
    if (t === "list" && LOG.test(k)) {
      out.push({ k, t, v: [], file: logFile(k), ...(px > 0 ? { px } : {}) });
      continue;
    }
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

/** Where a log is kept, by its key's hash: a key may hold any character. */
const logFile = (k: string) => `logs/${createHash("sha256").update(k).digest("hex").slice(0, 32)}.jsonl`;

/**
 * A log's entries from its file: a line each. A last line cut short (the computer went off mid-write) is left out, and the file is
 * then not `whole`: added to as it was, the next entries would follow the broken line and be left out with it at the next start,
 * every start after (2026-11-04 update check: three events lost at each restart).
 */
async function readLog(home: string, file: string): Promise<{ items: string[]; whole: boolean }> {
  const text = await readFile(path.join(home, file), "utf8").catch(() => "");
  const items: string[] = [];
  let whole = !text || text.endsWith("\n");
  for (const line of text.split("\n")) {
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

async function rpushAll(r: Redis, k: string, items: string[]): Promise<void> {
  // In pieces: a day's log is many thousand entries, too many arguments for one call.
  for (let i = 0; i < items.length; i += 1000) await r.rpush(k, ...items.slice(i, i + 1000));
}

async function load(r: Redis, rows: Dumped[], home: string): Promise<Map<string, number>> {
  /** Each log read from its file, and how many entries it held. */
  const kept = new Map<string, number>();
  for (const { k, t, v, px, file } of rows) {
    if (file) {
      const { items, whole } = await readLog(home, file);
      await rpushAll(r, k, items);
      // Cut short: written whole at the next save, never added to after the broken line.
      if (whole) kept.set(k, items.length);
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
    const { items, whole } = await readLog(home, file);
    const had = await r.lrange(k, 0, -1);
    const starts = (a: string[], b: string[]) => b.every((x, i) => a[i] === x);
    if (had.length >= items.length && starts(had, items)) continue;
    if (!starts(items, had)) {
      await rename(path.join(home, file), path.join(home, `${file}.aside-${Date.now()}`)).catch(() => {});
      continue;
    }
    const px = await r.pttl(k);
    await r.del(k);
    await rpushAll(r, k, items);
    if (px > 0) await r.pexpire(k, px);
    if (whole) kept.set(k, items.length);
    console.log(`[friday] read ${k} back from ${file} (${items.length} entries): data.json didn't name it.`);
  }
  return kept;
}

/**
 * What a call does to the logs it names: "append" for a push to the end, "rewrite" for anything else (LSET, LTRIM, DEL, RENAME,
 * a script: whatever names a log's key and isn't a push changes it some other way, as far as a save can tell).
 */
type LogTouch = (key: string, how: "append" | "rewrite") => void;
/** Commands that change when a key expires and nothing in it: data.json says when, every save. */
const TIMING = new Set(["expire", "pexpire", "expireat", "pexpireat", "persist"]);
/** What in a script changes a list other than adding to its end (or a key whole). */
const CHANGES_IN_PLACE = /\b(LSET|LTRIM|LREM|LINSERT|LPOP|RPOP|LPUSHX?|B?LMOVE|B?RPOPLPUSH|LMPOP|DEL|UNLINK|RENAME(NX)?|RESTORE|COPY|SORT|FLUSHALL|FLUSHDB|SET)\b/i;
function touchLogs(name: string, args: unknown[], touch: LogTouch): void {
  if (TIMING.has(name)) return;
  // A script: the session store's append only pushes (session/store.ts APPEND_LUA); compaction sets entries in place (LSET).
  if (name === "eval") {
    const keys = args.slice(2, 2 + Number(args[1])).filter((a): a is string => typeof a === "string" && LOG.test(a));
    for (const k of keys) touch(k, CHANGES_IN_PLACE.test(String(args[0])) ? "rewrite" : "append");
    return;
  }
  const how = APPENDS.has(name) ? "append" : "rewrite";
  for (const a of args.flat(2)) if (typeof a === "string" && LOG.test(a)) touch(a, how === "append" && a !== args[0] ? "rewrite" : how);
}

/**
 * Marks the store changed on any call that isn't a read, then hands the call on. Multi and eval count as writes. What each call
 * does to a log is told to `touch`, the calls queued in a MULTI or a pipeline included.
 */
function watched(r: Redis, changed: () => void, touch: LogTouch): Redis {
  const queued = (p: object): object =>
    new Proxy(p, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== "function" || typeof prop !== "string") return v;
        if (prop === "exec" || prop === "then" || READS.has(prop.toLowerCase())) return v.bind(target);
        return (...args: unknown[]) => {
          touchLogs(prop.toLowerCase(), args, touch);
          const out = (v as (...a: unknown[]) => unknown).apply(target, args);
          return out === target ? receiver : out;
        };
      },
    });
  return new Proxy(r, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function" || typeof prop !== "string") return v;
      if (READS.has(prop.toLowerCase())) return v.bind(target);
      return (...args: unknown[]) => {
        changed();
        const name = prop.toLowerCase();
        // MULTI or a pipeline given its commands at once: [["lset", key, i, v], …].
        if ((name === "multi" || name === "pipeline") && Array.isArray(args[0])) for (const c of args[0] as unknown[][]) touchLogs(String(c[0]).toLowerCase(), c.slice(1), touch);
        else touchLogs(name, args, touch);
        const out = (v as (...a: unknown[]) => unknown).apply(target, args);
        return (name === "multi" || name === "pipeline") && out && typeof out === "object" ? queued(out) : out;
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

/** `home`: where Friday keeps its things on this computer (data.json, uploads). `saveMs`: how long after a change it is written. */
export async function localKV(home: string, saveMs = 2000): Promise<LocalKV> {
  fitRepliesToMock();
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, "data.json");
  const raw = new (RedisMock as unknown as new () => Redis)();
  // Mocks in one process share their data (as connections to one server would): what this one holds is the file's, not a
  // store opened earlier in the same process.
  await raw.flushall();
  /** Each log as its file holds it: how many entries. A log not here is written whole at the next save. */
  let kept = new Map<string, number>();
  if (existsSync(file)) {
    try {
      kept = await load(raw, JSON.parse(await readFile(file, "utf8")) as Dumped[], home);
    } catch (e) {
      // A file that can't be read is set aside rather than written over, so nothing is lost by starting.
      const aside = `${file}.unreadable-${Date.now()}`;
      await rename(file, aside).catch(() => {});
      console.error(`[friday] couldn't read ${file} (${(e as Error).message}); kept it as ${aside} and started empty.`);
    }
  }
  let dirty = false;
  let timer: NodeJS.Timeout | null = null;
  let saving: Promise<void> = Promise.resolve();
  /** The logs changed since the last save, and how: a log only appended to gets its new entries added to its file. */
  let touched = new Map<string, "append" | "rewrite">();
  const touch: LogTouch = (k, how) => void touched.set(k, touched.get(k) === "rewrite" ? "rewrite" : how);
  const logs = path.join(home, "logs");
  // Only this person's: the sessions in them are their work.
  const writeWhole = async (to: string, text: string) => {
    await writeFile(`${to}.tmp`, text, { mode: 0o600 });
    await rename(`${to}.tmp`, to);
  };
  const saveLog = async (k: string, how: "append" | "rewrite" | undefined) => {
    const to = path.join(home, logFile(k));
    if ((await raw.type(k)) !== "list") {
      kept.delete(k);
      await rm(to, { force: true });
      return;
    }
    const had = kept.get(k);
    if (how === "append" && had !== undefined && (await raw.llen(k)) >= had) {
      const items = await raw.lrange(k, had, -1);
      if (items.length) await appendFile(to, items.map((x) => JSON.stringify(x)).join("\n") + "\n", { mode: 0o600 });
      kept.set(k, had + items.length);
      return;
    }
    const items = await raw.lrange(k, 0, -1);
    await writeWhole(to, items.length ? items.map((x) => JSON.stringify(x)).join("\n") + "\n" : "");
    kept.set(k, items.length);
  };
  const save = () => {
    timer = null;
    if (!dirty) return saving;
    dirty = false;
    const now = touched;
    touched = new Map();
    saving = saving.then(async () => {
      await mkdir(logs, { recursive: true, mode: 0o700 });
      // The logs first: data.json names them, so it never names one whose file isn't written yet. Every log is saved the first
      // time (a data.json from before logs had files holds them whole), then only the ones that changed.
      for (const k of await raw.keys("*")) if (LOG.test(k) && (!kept.has(k) || now.has(k))) await saveLog(k, kept.has(k) ? now.get(k) : "rewrite");
      for (const k of now.keys()) if (!(await raw.exists(k))) await saveLog(k, "rewrite");
      await writeWhole(file, JSON.stringify(await dump(raw)));
    }).catch((e) => {
      // Not saved: the next save writes every log whole, whatever it missed.
      kept = new Map();
      console.error(`[friday] couldn't save to ${file}: ${(e as Error).message}`);
    });
    return saving;
  };
  const changed = () => {
    dirty = true;
    timer ??= setTimeout(() => void save(), saveMs);
    timer.unref?.();
  };
  const redis = watched(raw, changed, touch);
  // The bus's own connection: the same data, its own subscriptions.
  const sub = raw.duplicate() as Redis;
  return {
    redis,
    sub,
    flush: async () => {
      if (timer) clearTimeout(timer);
      await save();
    },
    close: async () => {
      if (timer) clearTimeout(timer);
      await save();
      sub.disconnect();
      raw.disconnect();
    },
  };
}
