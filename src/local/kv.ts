import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command, type Redis } from "ioredis";
import RedisMock from "ioredis-mock";

/**
 * The local edition's Redis: in this process, nothing to install, kept in one file on this computer.
 *
 * Friday's stores are written against Redis (sessions, the bus, everything else), and on someone's own computer there is no
 * Redis to point at. ioredis-mock speaks the same commands in memory, Lua scripts and pub/sub included, so every store works
 * unchanged. What it holds is written to `<home>/data.json` a moment after it changes and as the app closes, and read back as
 * it starts. One person on one computer: a few megabytes, written whole.
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

type Dumped = { k: string; t: "string" | "list" | "hash" | "set" | "zset"; v: unknown; px?: number };

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

async function load(r: Redis, rows: Dumped[]): Promise<void> {
  for (const { k, t, v, px } of rows) {
    if (t === "string") await r.set(k, String(v));
    else if (t === "list" && (v as string[]).length) await r.rpush(k, ...(v as string[]));
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
}

/** Marks the store changed on any call that isn't a read, then hands the call on. Multi and eval count as writes. */
function watched(r: Redis, changed: () => void): Redis {
  return new Proxy(r, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function" || typeof prop !== "string") return v;
      if (READS.has(prop.toLowerCase())) return v.bind(target);
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

/** `home`: where Friday keeps its things on this computer (data.json, uploads). `saveMs`: how long after a change it is written. */
export async function localKV(home: string, saveMs = 2000): Promise<LocalKV> {
  fitRepliesToMock();
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, "data.json");
  const raw = new (RedisMock as unknown as new () => Redis)();
  // Mocks in one process share their data (as connections to one server would): what this one holds is the file's, not a
  // store opened earlier in the same process.
  await raw.flushall();
  if (existsSync(file)) {
    try {
      await load(raw, JSON.parse(await readFile(file, "utf8")) as Dumped[]);
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
  const save = () => {
    timer = null;
    if (!dirty) return saving;
    dirty = false;
    saving = saving.then(async () => {
      const tmp = `${file}.tmp`;
      // Only this person's: the sessions in it are their work.
      await writeFile(tmp, JSON.stringify(await dump(raw)), { mode: 0o600 });
      await rename(tmp, file);
    }).catch((e) => console.error(`[friday] couldn't save to ${file}: ${(e as Error).message}`));
    return saving;
  };
  const changed = () => {
    dirty = true;
    timer ??= setTimeout(() => void save(), saveMs);
    timer.unref?.();
  };
  const redis = watched(raw, changed);
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
