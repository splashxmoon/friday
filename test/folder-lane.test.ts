import assert from "node:assert/strict";
import test from "node:test";
import { Redis } from "ioredis";
import { SessionCore } from "../src/session/core.js";
import { SessionStore } from "../src/session/store.js";

const ada = { id: "u-ada", name: "Ada" };

test("a commit, a command and a push for a lane go to that lane's own folder", async (t) => {
  const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  const prefix = `mpatest:${Math.random().toString(36).slice(2, 10)}:`;
  t.after(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  });
  const store = new SessionStore(redis, prefix);
  const seen: { op: string; lane?: string }[] = [];
  const folder = async (_sid: string, req: { op: string }, lane?: string) => {
    seen.push({ op: req.op, ...(lane ? { lane } : {}) });
    if (req.op === "commit") return { output: JSON.stringify({ sha: "b".repeat(40), branch: "friday/seo-1", files: 1 }) };
    if (req.op === "publish") return { output: JSON.stringify({ pushed: true }) };
    if (req.op === "shell") return { output: "$ npm test\n(exited 0)" };
    return { output: "" };
  };
  const core = new SessionCore(store, () => {}, undefined, undefined, undefined, folder as never);
  await store.create("s1", "t", { ...ada, role: "owner" }, {}, "w");

  assert.equal((await core.handle("s1", ada, { type: "lane.add", name: "SEO", control: { kind: "open" }, trigger: { kind: "manual" } })).ok, true);
  const lane = (await store.state("s1")).lanes[0]!.id;
  await core.handle("s1", ada, { type: "folder.run", command: "npm test", lane });
  await core.handle("s1", ada, { type: "folder.commit", message: "Add schema", push: true, lane });
  assert.deepEqual(
    seen.map((s) => `${s.op}:${s.lane}`),
    [`shell:${lane}`, `commit:${lane}`, `publish:${lane}`],
  );

  seen.length = 0;
  await core.handle("s1", ada, { type: "folder.run", command: "npm test" });
  assert.deepEqual(seen.map((s) => `${s.op}:${s.lane}`), ["shell:main"], "no lane means the main one");
});
