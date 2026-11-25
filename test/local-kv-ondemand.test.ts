import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Redis } from "ioredis";
import RedisMock from "ioredis-mock";
import { localKV } from "../src/local/kv.js";
import { logFile } from "../src/local/logs.js";

/**
 * Session logs read from their files when asked for, not all of them at start, with a bounded cache of recently used ones (spec
 * 13, Wave 2 · G, Arun 2026-11-24: "Go all out and fix these problems"). Every Redis-like command the app uses on a log answers
 * as the in-memory store did, which is checked here against a plain ioredis-mock on random sequences of commands.
 */

async function home(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-kv-od-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const key = (i: number) => `friday:{s${i}}:events`;
/** A plain mock of its own (its own port, so not sharing the store's data). */
let port = 17000;
const plain = () => new (RedisMock as unknown as new (o: object) => Redis)({ port: port++ });

// The session store's own scripts' shape: append (only pushes) and a script that sets in place.
const APPEND = "local n = redis.call('LLEN', KEYS[1]) redis.call('RPUSH', KEYS[1], ARGV[1]) return n + 1";
const SET_IN_PLACE = "redis.call('LSET', KEYS[1], tonumber(ARGV[1]), ARGV[2]) return 1";

let seed = 1;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const int = (n: number) => Math.floor(rnd() * n);
const pick = <T>(xs: readonly T[]) => xs[int(xs.length)]!;

/** A random command on the logs, as the app uses them; run on both, the replies compared. Every choice made before either runs. */
function randomOp(step: number): [string, (r: Redis) => Promise<unknown>] {
  const k = key(int(4));
  const k2 = key(int(4));
  const values = Array.from({ length: 8 }, () => `{"v":${step}-${int(1000)},"text":"é ✓ ${"x".repeat(int(60))}"}`);
  const idxs = Array.from({ length: 2 }, () => int(30) - 10);
  const [n, small, a, b, maybe] = [1 + int(5), int(5), int(3), int(3), rnd()];
  let vi = 0;
  let ii = 0;
  const v = () => values[vi++ % values.length]!;
  const idx = () => idxs[ii++ % idxs.length]!;
  const ops: [string, (r: Redis) => Promise<unknown>][] = [
    [`rpush ${k}`, (r) => ((vi = 0), r.rpush(k, ...Array.from({ length: n }, v)))],
    [`rpush ${k}`, (r) => ((vi = 0), r.rpush(k, v()))],
    [`lrange ${k}`, (r) => ((ii = 0), r.lrange(k, idx(), idx()))],
    [`lrange ${k} whole`, (r) => r.lrange(k, 0, -1)],
    [`lrange ${k} tail`, (r) => r.lrange(k, -1 - small, -1)],
    [`llen ${k}`, (r) => r.llen(k)],
    [`lindex ${k}`, (r) => ((ii = 0), r.lindex(k, idx()))],
    [`lset ${k}`, async (r) => ((vi = 0), r.lset(k, small % Math.max(1, await r.llen(k)), v())).catch((e: Error) => `error: ${/no such key|out of range/i.test(e.message) ? "x" : e.message}`)],
    [`ltrim ${k}`, (r) => r.ltrim(k, a, -1 - b)],
    [`exists ${k}`, (r) => r.exists(k)],
    [`type ${k}`, (r) => r.type(k)],
    [`del ${k}`, (r) => (maybe < 0.3 ? r.del(k) : r.llen(k))],
    [`eval append ${k}`, (r) => r.eval(APPEND, 1, k, "n")],
    [`eval set ${k}`, (r) => ((vi = 0), r.eval(SET_IN_PLACE, 1, k, "0", v()).catch(() => "error"))],
    [`multi ${k}`, async (r) => ((vi = 0), await r.multi().lset(k, 0, v()).rpush(k, v()).llen(k).exec())?.map(([e, x]) => (e ? "error" : x))],
    [`keys`, async (r) => (await r.keys("friday:{*}:events")).sort()],
    [`scan`, async (r) => (await r.scan("0", "MATCH", "friday:{*}:events", "COUNT", 1000))[1].sort()],
    [`rename ${k} ${k2}`, async (r) => (k !== k2 && maybe < 0.2 && (await r.exists(k)) ? r.rename(k, k2) : r.llen(k2))],
    [`lpop ${k}`, (r) => r.lpop(k)],
    [`rpop ${k}`, (r) => r.rpop(k)],
  ];
  return pick(ops);
}

test("every list command the app uses on a log answers as the in-memory store did, on random sequences, across saves and restarts", async (t) => {
  const dir = await home(t);
  // KV_FUZZ_SEEDS=20 for a longer run.
  for (let s = 1; s <= Number(process.env.KV_FUZZ_SEEDS ?? 3); s++) {
    seed = s * 7919;
    const ref = plain();
    for (let i = 0; i < 4; i++) await ref.del(key(i));
    // A ceiling of a few hundred bytes: nearly every read has to go back to the file.
    let kv = await localKV(path.join(dir, `run${s}`), 60_000, { logCache: 600 });
    for (let step = 0; step < 600; step++) {
      const [what, op] = randomOp(step);
      const want = await op(ref).catch((e: Error) => `error: ${e.message}`);
      const got = await op(kv.redis).catch((e: Error) => `error: ${e.message}`);
      assert.deepEqual(got, want, `seed ${s}, step ${step}: ${what}`);
      if (step % 50 === 25) await kv.flush();
      if (step % 150 === 149) {
        // Quit and start again: everything as it was, read back from the files.
        await kv.close();
        kv = await localKV(path.join(dir, `run${s}`), 60_000, { logCache: 600 });
        // A list emptied (LTRIM, LPOP) isn't there after a restart, as it wasn't with every log in memory either.
        for (let i = 0; i < 4; i++) if ((await ref.exists(key(i))) && (await ref.llen(key(i))) === 0) await ref.del(key(i));
        for (let i = 0; i < 4; i++) assert.deepEqual(await kv.redis.lrange(key(i), 0, -1), await ref.lrange(key(i), 0, -1), `seed ${s}, after a restart at ${step}: ${key(i)}`);
      }
    }
    await kv.close();
    ref.disconnect();
  }
});

test("starting reads no log, only the index; a log's length is known without reading it", async (t) => {
  const dir = await home(t);
  const kv = await localKV(dir, 60_000);
  for (let i = 0; i < 20; i++) await kv.redis.rpush(key(i), ...Array.from({ length: 200 }, (_, j) => `{"seq":${j + 1},"i":${i}}`));
  await kv.close();
  const data = JSON.parse(await readFile(path.join(dir, "data.json"), "utf8")) as { k: string; n?: number; b?: number }[];
  assert.ok(data.filter((r) => /:events$/.test(r.k)).every((r) => r.n === 200 && r.b! > 0), "data.json keeps each log's count and size");
  const again = await localKV(dir, 60_000);
  t.after(() => again.close());
  assert.deepEqual(again.logs.memory(), { cached: 0, held: 0 }, "nothing of any log is in memory");
  assert.equal(await again.redis.llen(key(3)), 200);
  assert.equal(await again.redis.exists(key(3)), 1);
  assert.equal(await again.redis.type(key(3)), "list");
  assert.equal((await again.redis.keys("friday:{*}:events")).length, 20);
  assert.deepEqual(again.logs.memory(), { cached: 0, held: 0 }, "nor after its length, type and name were asked");
  assert.deepEqual(await again.redis.lrange(key(3), -2, -1), ['{"seq":199,"i":3}', '{"seq":200,"i":3}'], "its newest entries, from the end of its file");
  assert.ok(again.logs.memory().cached < 2000, "only those read");
});

test("the cache of logs in memory stays under its ceiling, however many are opened", async (t) => {
  const dir = await home(t);
  const kv = await localKV(dir, 60_000);
  const big = "x".repeat(1000);
  for (let i = 0; i < 30; i++) await kv.redis.rpush(key(i), ...Array.from({ length: 100 }, (_, j) => `{"seq":${j + 1},"t":"${big}"}`));
  await kv.close();
  const ceiling = 400_000;
  const syncReads: string[] = [];
  const again = await localKV(dir, 60_000, { logCache: ceiling });
  again.logs.onSyncRead = (k) => syncReads.push(k);
  t.after(() => again.close());
  for (let i = 0; i < 30; i++) {
    const all = await again.redis.lrange(key(i), 0, -1);
    assert.equal(all.length, 100);
    assert.ok(again.logs.memory().cached <= ceiling, `after opening ${i + 1}: ${again.logs.memory().cached} bytes held`);
  }
  // A log bigger than the whole ceiling is still read whole, and kept until another is read.
  const tiny = await localKV(path.join(dir, "tiny"), 60_000, { logCache: 1000 });
  t.after(() => tiny.close());
  await tiny.redis.rpush(key(1), ...Array.from({ length: 50 }, () => big));
  await tiny.flush();
  assert.equal((await tiny.redis.lrange(key(1), 0, -1)).length, 50);
  assert.deepEqual(syncReads, [], "each read off the file without holding the server");
});

test("added to after a restart: appended to its file, read back with what was there, never read synchronously", async (t) => {
  const dir = await home(t);
  const kv = await localKV(dir, 60_000);
  await kv.redis.rpush(key(1), "a", "b", "c");
  await kv.close();
  const synced: string[] = [];
  const again = await localKV(dir, 60_000);
  again.logs.onSyncRead = (k) => synced.push(k);
  // As the session store appends: a script that reads the length and pushes.
  assert.equal(await again.redis.eval(APPEND, 1, key(1), "d"), 4);
  await again.redis.rpush(key(1), "e");
  assert.deepEqual(again.logs.memory().cached, 0, "an append reads nothing of the log");
  assert.deepEqual(await again.redis.lrange(key(1), 3, -1), ["d", "e"], "the new entries, from memory");
  await again.flush();
  assert.deepEqual(await again.redis.lrange(key(1), 0, -1), ["a", "b", "c", "d", "e"]);
  const lines = (await readFile(path.join(dir, logFile(key(1))), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as string);
  assert.deepEqual(lines, ["a", "b", "c", "d", "e"], "added to its file");
  assert.deepEqual(synced, [], "every read went through the API's own read, off the file without holding the server");
  await again.close();
  const third = await localKV(dir, 60_000);
  t.after(() => third.close());
  assert.deepEqual(await third.redis.lrange(key(1), 0, -1), ["a", "b", "c", "d", "e"]);
});

test("a data.json from before the index, or a log added to after data.json was written: its file is read, and the index written soon", async (t) => {
  const dir = await home(t);
  const kv = await localKV(dir, 60_000);
  await kv.redis.rpush(key(1), "a", "b");
  await kv.redis.rpush(key(2), "x");
  await kv.close();
  const dataFile = path.join(dir, "data.json");
  const rows = JSON.parse(await readFile(dataFile, "utf8")) as { k: string; n?: number; b?: number }[];
  // No index for key 1 (an older data.json); key 2's file added to after data.json was written (the computer went off between).
  for (const r of rows) if (r.k === key(1)) (delete r.n, delete r.b);
  await writeFile(dataFile, JSON.stringify(rows));
  await appendFile(path.join(dir, logFile(key(2))), JSON.stringify("y") + "\n");
  const again = await localKV(dir, 50);
  assert.deepEqual(await again.redis.lrange(key(1), 0, -1), ["a", "b"]);
  assert.deepEqual(await again.redis.lrange(key(2), 0, -1), ["x", "y"], "the file is the truth");
  await new Promise((r) => setTimeout(r, 300));
  const after = JSON.parse(await readFile(dataFile, "utf8")) as { k: string; n?: number; b?: number }[];
  assert.equal(after.find((r) => r.k === key(1))?.n, 2, "the index written without anything else changing");
  assert.equal(after.find((r) => r.k === key(2))?.n, 2);
  await again.close();
});

test("a log changed in place while only its tail was in memory is read whole for it, and saved whole", async (t) => {
  const dir = await home(t);
  const kv = await localKV(dir, 60_000);
  await kv.redis.rpush(key(1), ...Array.from({ length: 5000 }, (_, i) => `e${i}`));
  await kv.close();
  const again = await localKV(dir, 60_000);
  assert.deepEqual(await again.redis.lrange(key(1), -1, -1), ["e4999"]);
  await again.redis.multi().lset(key(1), 2, "E2").set("friday:{s1}:shielded", "5000").exec();
  await again.redis.rpush(key(1), "e5000");
  await again.close();
  const files = await readdir(path.join(dir, "logs"));
  assert.equal(files.length, 1);
  const third = await localKV(dir, 60_000);
  t.after(() => third.close());
  const all = await third.redis.lrange(key(1), 0, -1);
  assert.equal(all.length, 5001);
  assert.deepEqual(all.slice(0, 4), ["e0", "e1", "E2", "e3"]);
  assert.equal(all.at(-1), "e5000");
});
