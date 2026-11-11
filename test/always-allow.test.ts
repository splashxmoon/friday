import assert from "node:assert/strict";
import test from "node:test";
import { Redis } from "ioredis";
import { SessionCore } from "../src/session/core.js";
import { allowedCommand, alwaysAllowEntry, initialState } from "../src/session/projection.js";
import { SessionStore } from "../src/session/store.js";

/**
 * "Always allow": the yes a driver gives in advance for one exact command.
 *
 * It is a session setting, so it is the driver's or an owner's to change, it is kept exactly as the agent asked, and
 * taking it away means the agent asks again.
 */

const ada = { id: "u-ada", name: "Ada" };
const bea = { id: "u-bea", name: "Bea" };

test("the driver allows a command in advance, exactly as asked; a viewer can't; removing it asks again", async (t) => {
  const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  const prefix = `mpatest:${Math.random().toString(36).slice(2, 10)}:`;
  t.after(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  });
  const store = new SessionStore(redis, prefix);
  const core = new SessionCore(store, () => {});
  await store.create("s1", "Cart", { ...ada, role: "owner" }, {}, "w");
  assert.equal(allowedCommand(await store.state("s1"), "npm test"), false, "nothing is allowed to begin with");

  let r = await core.handle("s1", ada, { type: "settings.update", allow: [" npm test ", "npm test", "", 42 as unknown as string] });
  assert.equal(r.ok, true);
  const state = await store.state("s1");
  assert.deepEqual(state.options.allow, ["npm test"], "trimmed, deduplicated, strings only");
  assert.equal(allowedCommand(state, "npm test"), true);
  assert.equal(allowedCommand(state, "npm test -- --watch"), false, "only the exact command");

  // Somebody who may not steer may not hand out the machine either.
  await store.ensureMember("s1", { ...bea, role: "viewer" }, state);
  r = await core.handle("s1", bea, { type: "settings.update", allow: ["rm -rf /"] });
  assert.equal(r.ok, false);
  assert.deepEqual((await store.state("s1")).options.allow, ["npm test"]);

  r = await core.handle("s1", ada, { type: "settings.update", allow: [] });
  assert.equal(r.ok, true);
  assert.equal(allowedCommand(await store.state("s1"), "npm test"), false, "taken away, it asks again");
});

test("one press of Always allow: the pattern for safe kinds of command, exactly itself for anything that could do harm", () => {
  assert.equal(alwaysAllowEntry("npm test"), "npm test*");
  assert.equal(alwaysAllowEntry("  npm run build --prod "), "npm run*");
  assert.equal(alwaysAllowEntry("git status"), "git status*");
  assert.equal(alwaysAllowEntry("rm -rf build"), "rm -rf build", "a delete never widens");
  assert.equal(alwaysAllowEntry("npm install left-pad"), "npm install left-pad", "an install runs other people's code");
  assert.equal(alwaysAllowEntry("git push origin main"), "git push origin main", "publishing never widens");
  const s = initialState("s");
  s.options.allow = [alwaysAllowEntry("npm test")];
  assert.ok(allowedCommand(s, "npm test -- --watch"), "the pattern covers the same command with more arguments");
  assert.ok(!allowedCommand(s, "npm testify"), "but not a different word");
  assert.ok(!allowedCommand(s, "npm test && rm -rf ."), "nor a second command chained on");
});

test("Allow for this task: commands like the one allowed are let through in that lane until its run ends, and nowhere else", async () => {
  const { project } = await import("../src/session/projection.js");
  const human = { kind: "human", id: ada.id, name: ada.name } as const;
  const tool = { kind: "agent", id: "kit", name: "Kit" } as const;
  const rows: [typeof human | typeof tool, Record<string, unknown>, string][] = [
    [human, { type: "session.created", title: "t", ownerId: ada.id, ownerName: ada.name }, "main"],
    [tool, { type: "run.started", causedBy: 1 }, "kit"],
    [tool, { type: "engine.approval", id: "a1", scope: "commands", items: ["npm test"], live: true }, "kit"],
    [human, { type: "instruction", text: "Yes", interrupt: false, approval: { id: "a1", approve: true, task: true } }, "kit"],
  ];
  const events = () => rows.map(([actor, body, lane], i) => ({ seq: i + 1, ts: 1, actor, body, ...(lane !== "main" ? { lane } : {}) })) as never;
  let s = project("s", events());
  assert.ok(allowedCommand(s, "npm test -- --watch", "kit"), "the same safe command with more arguments, in its lane");
  assert.ok(!allowedCommand(s, "npm test", "nova"), "not another teammate's");
  assert.ok(!allowedCommand(s, "npm test"), "nor the session's own list");
  rows.push([tool, { type: "engine.approval", id: "a2", scope: "commands", items: ["git push origin main"], live: true }, "kit"]);
  rows.push([human, { type: "instruction", text: "Yes", interrupt: false, approval: { id: "a2", approve: true, task: true } }, "kit"]);
  s = project("s", events());
  assert.ok(allowedCommand(s, "git push origin main", "kit"), "a risky one, exactly itself");
  assert.ok(!allowedCommand(s, "git push origin main --force", "kit"), "never widened");
  rows.push([tool, { type: "run.ended", outcome: "waiting" }, "kit"]);
  assert.ok(allowedCommand(project("s", events()), "npm test", "kit"), "waiting on a person is still the task");
  rows.push([tool, { type: "run.ended", outcome: "done" }, "kit"]);
  assert.ok(!allowedCommand(project("s", events()), "npm test", "kit"), "the task over, it asks again");
});
