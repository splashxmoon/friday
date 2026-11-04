import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localKV } from "../src/local/kv.js";

/**
 * Sessions keep their history through an update and whatever cuts it short (2026-11-04 update check, v0.2.10 to the build with
 * each session's log in a file of its own: Arun, "ensure when the user updates their sessions and things dont disappear").
 */

const LOG = "friday:{s1}:events";
const CONTROL = "friday:{s1}:control";

async function home(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-kv-update-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const logs = (dir: string) => readdir(path.join(dir, "logs"));
const logFile = async (dir: string) => path.join(dir, "logs", (await logs(dir)).find((f) => f.endsWith(".jsonl"))!);

/** What v0.2.10 does with this build's data.json: reads every log as empty (`v: []`) and saves without them. */
async function openedByV0210(dir: string) {
  const file = path.join(dir, "data.json");
  const rows = JSON.parse(await readFile(file, "utf8")) as { t: string; v: unknown }[];
  await writeFile(file, JSON.stringify(rows.filter((r) => !(r.t === "list" && Array.isArray(r.v) && !r.v.length)).map(({ ...r }) => (delete (r as { file?: string }).file, r))));
}

test("a save cut off mid-line: what is added after it is kept at the next start, and the start after", async (t) => {
  const dir = await home(t);
  const kv = await localKV(dir, 60_000);
  await kv.redis.rpush(LOG, "a", "b");
  await kv.close();
  // Killed while adding "c": half a line, no line break.
  await appendFile(await logFile(dir), '"c');
  const second = await localKV(dir, 60_000);
  assert.deepEqual(await second.redis.lrange(LOG, 0, -1), ["a", "b"]);
  await second.redis.rpush(LOG, "d");
  await second.close();
  const third = await localKV(dir, 60_000);
  t.after(() => third.close());
  assert.deepEqual(await third.redis.lrange(LOG, 0, -1), ["a", "b", "d"]);
});

test("a save cut off just before its line break: the last entry and the next are both kept", async (t) => {
  const dir = await home(t);
  const kv = await localKV(dir, 60_000);
  await kv.redis.rpush(LOG, "a");
  await kv.close();
  await appendFile(await logFile(dir), '"b"');
  const second = await localKV(dir, 60_000);
  assert.deepEqual(await second.redis.lrange(LOG, 0, -1), ["a", "b"]);
  await second.redis.rpush(LOG, "c");
  await second.close();
  const third = await localKV(dir, 60_000);
  t.after(() => third.close());
  assert.deepEqual(await third.redis.lrange(LOG, 0, -1), ["a", "b", "c"]);
});

test("back to v0.2.10 and forward again: every session's log is read back from its file", async (t) => {
  const dir = await home(t);
  const kv = await localKV(dir, 60_000);
  await kv.redis.rpush(LOG, "a", "b", "c");
  await kv.redis.hset(CONTROL, { epoch: "1" });
  await kv.close();
  await openedByV0210(dir);
  assert.ok(!(await readFile(path.join(dir, "data.json"), "utf8")).includes(":events"), "v0.2.10 saved without it");
  const again = await localKV(dir, 60_000);
  assert.deepEqual(await again.redis.lrange(LOG, 0, -1), ["a", "b", "c"]);
  assert.deepEqual(await again.redis.hgetall(CONTROL), { epoch: "1" });
  // Added to and saved, then opened again: data.json names its file once more.
  await again.redis.rpush(LOG, "d");
  await again.close();
  const third = await localKV(dir, 60_000);
  t.after(() => third.close());
  assert.deepEqual(await third.redis.lrange(LOG, 0, -1), ["a", "b", "c", "d"]);
});

test("a log v0.2.10 started again under the same name is kept, and the file's history is set aside, not written over", async (t) => {
  const dir = await home(t);
  const kv = await localKV(dir, 60_000);
  await kv.redis.rpush(LOG, "a", "b", "c");
  await kv.redis.hset(CONTROL, { epoch: "1" });
  await kv.close();
  await openedByV0210(dir);
  const file = path.join(dir, "data.json");
  await writeFile(file, JSON.stringify([...JSON.parse(await readFile(file, "utf8")), { k: LOG, t: "list", v: ["x"] }]));
  const again = await localKV(dir, 60_000);
  assert.deepEqual(await again.redis.lrange(LOG, 0, -1), ["x"]);
  await again.redis.rpush(LOG, "y");
  await again.close();
  const aside = (await logs(dir)).find((f) => f.includes(".aside-"));
  assert.ok(aside, "set aside");
  assert.deepEqual((await readFile(path.join(dir, "logs", aside), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l)), ["a", "b", "c"]);
});

test("cut off during the first save after the update: data.json still holds the logs whole, and the longer of the two is kept", async (t) => {
  const dir = await home(t);
  const kv = await localKV(dir, 60_000);
  await kv.redis.rpush(LOG, "x", "y", "z");
  await kv.redis.hset(CONTROL, { epoch: "1" });
  await kv.close();
  // data.json as v0.2.10 left it (the log inside it, two entries), and the file the interrupted save had written (three).
  await writeFile(path.join(dir, "data.json"), JSON.stringify([{ k: LOG, t: "list", v: ["x", "y"] }, { k: CONTROL, t: "hash", v: { epoch: "1" } }]));
  const again = await localKV(dir, 60_000);
  t.after(() => again.close());
  assert.deepEqual(await again.redis.lrange(LOG, 0, -1), ["x", "y", "z"]);
});
