import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localKV } from "../src/local/kv.js";

/**
 * Each session's log kept in a file of its own, a save adding only its new entries (2026-11-04 soak: a crew's day rewrote 150 MB
 * every two seconds). Whatever way a log changes, opening the store again gives back exactly what it held.
 */

const LOG = "friday:{s1}:events";
const APPEND = "redis.call('RPUSH', KEYS[1], ARGV[1]) return redis.call('LLEN', KEYS[1])";
const SET_IN_PLACE = "redis.call('LSET', KEYS[1], tonumber(ARGV[1]), ARGV[2]) return 1";

async function home(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-kv-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const logFile = async (dir: string) => path.join(dir, "logs", (await readdir(path.join(dir, "logs")))[0]!);
const lines = async (dir: string) => (await readFile(await logFile(dir), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as string);

test("a log only added to is saved by adding its new entries to its file, and data.json holds none of it", async (t) => {
  const dir = await home(t);
  const kv = await localKV(dir, 60_000);
  await kv.redis.rpush(LOG, '{"seq":1}', '{"seq":2}');
  await kv.redis.hset("friday:{s1}:control", { epoch: "1" });
  await kv.flush();
  const file = await logFile(dir);
  const ino = (await stat(file)).ino;
  assert.deepEqual(await lines(dir), ['{"seq":1}', '{"seq":2}']);
  const data = await readFile(path.join(dir, "data.json"), "utf8");
  assert.ok(!data.includes('"seq"'), "the log's entries aren't in data.json");
  // The session store's way in: a script that only pushes.
  await kv.redis.eval(APPEND, 1, LOG, '{"seq":3}');
  await kv.redis.rpush(LOG, '{"seq":4}');
  await kv.redis.pexpire(LOG, 3_600_000);
  await kv.flush();
  assert.equal((await stat(file)).ino, ino, "added to, not written again");
  assert.deepEqual(await lines(dir), ['{"seq":1}', '{"seq":2}', '{"seq":3}', '{"seq":4}']);
  await kv.close();
  const again = await localKV(dir, 60_000);
  t.after(() => again.close());
  assert.deepEqual(await again.redis.lrange(LOG, 0, -1), ['{"seq":1}', '{"seq":2}', '{"seq":3}', '{"seq":4}']);
  assert.ok((await again.redis.pttl(LOG)) > 3_000_000, "and when it expires is kept");
  assert.deepEqual(await again.redis.hgetall("friday:{s1}:control"), { epoch: "1" });
});

test("a log changed in place, by a call, a MULTI or a script, is written whole again", async (t) => {
  const dir = await home(t);
  const kv = await localKV(dir, 60_000);
  await kv.redis.rpush(LOG, "a", "b", "c");
  await kv.flush();
  let ino = (await stat(await logFile(dir))).ino;
  // Secrets hidden after the fact (session/store.ts): LSET in a MULTI.
  await kv.redis.multi().lset(LOG, 1, "B").set("shield", "1").exec();
  await kv.flush();
  assert.notEqual((await stat(await logFile(dir))).ino, ino, "written again");
  assert.deepEqual(await lines(dir), ["a", "B", "c"]);
  ino = (await stat(await logFile(dir))).ino;
  // Compaction (session/compact.ts): LSET in a script.
  await kv.redis.eval(SET_IN_PLACE, 1, LOG, "0", "A");
  await kv.redis.rpush(LOG, "d");
  await kv.flush();
  assert.notEqual((await stat(await logFile(dir))).ino, ino);
  assert.deepEqual(await lines(dir), ["A", "B", "c", "d"]);
  // Cut short, then added to before the save.
  await kv.redis.ltrim(LOG, 2, -1);
  await kv.redis.rpush(LOG, "e");
  await kv.flush();
  assert.deepEqual(await lines(dir), ["c", "d", "e"]);
  await kv.close();
  const again = await localKV(dir, 60_000);
  t.after(() => again.close());
  assert.deepEqual(await again.redis.lrange(LOG, 0, -1), ["c", "d", "e"]);
});

test("a log deleted takes its file with it; a session made again starts a new one", async (t) => {
  const dir = await home(t);
  const kv = await localKV(dir, 60_000);
  await kv.redis.rpush(LOG, "a");
  await kv.flush();
  await kv.redis.del(LOG);
  await kv.flush();
  assert.deepEqual(await readdir(path.join(dir, "logs")), []);
  await kv.redis.rpush(LOG, "z");
  await kv.close();
  const again = await localKV(dir, 60_000);
  t.after(() => again.close());
  assert.deepEqual(await again.redis.lrange(LOG, 0, -1), ["z"]);
});

test("a data.json from before logs had files is read as it was, and its logs move to files at the next save", async (t) => {
  const dir = await home(t);
  await writeFile(path.join(dir, "data.json"), JSON.stringify([{ k: LOG, t: "list", v: ["x", "y"] }, { k: "k", t: "string", v: "v" }]));
  const kv = await localKV(dir, 60_000);
  assert.deepEqual(await kv.redis.lrange(LOG, 0, -1), ["x", "y"]);
  await kv.redis.set("k2", "v2");
  await kv.flush();
  assert.deepEqual(await lines(dir), ["x", "y"]);
  assert.ok(!(await readFile(path.join(dir, "data.json"), "utf8")).includes('"x"'));
  await kv.close();
  const again = await localKV(dir, 60_000);
  t.after(() => again.close());
  assert.deepEqual(await again.redis.lrange(LOG, 0, -1), ["x", "y"]);
  assert.equal(await again.redis.get("k"), "v");
});

test("a last line cut short (the computer went off mid-save) is left out, and the rest is read", async (t) => {
  const dir = await home(t);
  const kv = await localKV(dir, 60_000);
  await kv.redis.rpush(LOG, "a", "b");
  await kv.close();
  await appendFile(await logFile(dir), '"c');
  const again = await localKV(dir, 60_000);
  t.after(() => again.close());
  assert.deepEqual(await again.redis.lrange(LOG, 0, -1), ["a", "b"]);
});
