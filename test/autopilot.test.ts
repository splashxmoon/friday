// Pull request autopilot (autopilot.ts): which of the person's pull requests it starts on, what it says they need, when it leaves
// one alone, and its record of each, kept in the local Redis.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AUTOPILOT_DEFAULTS, AutopilotStore, needsText, pilotBrief, reasonsFor, shouldStart, type PilotPr, type PilotPrRecord } from "../src/autopilot.js";
import { localKV } from "../src/local/kv.js";

const pr = (over: Partial<PilotPr> = {}): PilotPr => ({ url: "https://github.com/a/b/pull/412", repo: "a/b", number: 412, title: "Retry webhooks", branch: "retry", base: "main", head: "abc", draft: false, checks: "passing", unresolved: 0, mergeable: true, canPush: true, ...over });
const on = { ...AUTOPILOT_DEFAULTS, on: true };

test("it starts on what the person lets it fix, never a draft or one they can't push to, and says what's needed", () => {
  assert.deepEqual(reasonsFor(pr(), on), []);
  const all = pr({ checks: "failing", failing: [{ name: "lint" }, { name: "test" }], unresolved: 2, mergeable: false });
  assert.deepEqual(reasonsFor(all, on), ["conflicts", "checks", "comments"]);
  assert.deepEqual(reasonsFor(all, { ...on, checks: false, conflicts: false }), ["comments"]);
  assert.deepEqual(reasonsFor({ ...all, draft: true }, on), []);
  assert.deepEqual(reasonsFor({ ...all, canPush: false }, on), []);
  assert.deepEqual(reasonsFor(all, { ...on, skip: [all.url] }), [], "one the person told it to leave alone");
  assert.equal(needsText(all, reasonsFor(all, on)), "a conflict with main · 2 checks failing (lint, test) · 2 unresolved review comments");
  assert.equal(needsText(pr({ checks: "failing", unresolved: 1 }), ["checks", "comments"]), "1 check failing · 1 unresolved review comment");
  const brief = pilotBrief(all, ["checks"]);
  assert.match(brief, /#412, “Retry webhooks”[\s\S]*on its branch retry into main/);
  assert.match(brief, /never merge/);
  assert.match(brief, /stop and ask instead of guessing/);
});

test("it leaves alone a pull request it's already on, and one it stopped on until somebody pushes past that commit", () => {
  const red = pr({ checks: "failing" });
  const rec = (over: Partial<PilotPrRecord>): PilotPrRecord => ({ url: red.url, repo: "a/b", number: 412, title: "t", sid: "s1", state: "working", head: "abc", log: [], updated: 1, ...over });
  assert.equal(shouldStart(red, ["checks"], null, false), true);
  assert.equal(shouldStart(red, [], null, false), false, "nothing needed");
  assert.equal(shouldStart(red, ["checks"], rec({ state: "working" }), true), false, "already on it");
  assert.equal(shouldStart(red, ["checks"], rec({ state: "watching" }), false), true, "its session stopped watching");
  assert.equal(shouldStart(red, ["checks"], rec({ state: "stopped", head: "abc" }), false), false, "stopped on this commit");
  assert.equal(shouldStart({ ...red, head: "def" }, ["checks"], rec({ state: "stopped", head: "abc" }), false), true, "pushed past it");
  assert.equal(shouldStart(red, ["checks"], rec({ state: "done" }), false), true);
});

test("its record: settings kept, a log per pull request with where it stands, found by its session, finished ones forgotten after two weeks", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-autopilot-"));
  const kv = await localKV(home);
  t.after(async () => (await kv.close(), await rm(home, { recursive: true, force: true })));
  const s = new AutopilotStore(kv.redis, "friday:");
  assert.deepEqual(await s.settings(), AUTOPILOT_DEFAULTS);
  assert.deepEqual(await s.setSettings({ on: true, comments: false, nonsense: true, checks: "yes" } as Record<string, unknown>), { ...AUTOPILOT_DEFAULTS, on: true, comments: false });
  // How many at once, which agent, closing when done, and the ones it leaves alone (Arun, 2026-11-20: "more controls").
  const more = await s.setSettings({ max: 5, tool: "codex", closeWhenDone: false, skip: ["https://github.com/a/b/pull/7", "not a link", "https://github.com/a/b/pull/7"] });
  assert.deepEqual([more.max, more.tool, more.closeWhenDone, more.skip], [5, "codex", false, ["https://github.com/a/b/pull/7"]]);
  const bad = await s.setSettings({ max: 40, tool: "rm -rf" } as Record<string, unknown>);
  assert.deepEqual([bad.max, bad.tool], [5, "codex"], "only the offered counts, and a tool's name");
  await s.setSettings({ max: AUTOPILOT_DEFAULTS.max, tool: "auto", closeWhenDone: true, skip: [] });
  const now = Date.now();
  await s.put({ url: "u1", repo: "a/b", number: 1, title: "One", sid: "s1", state: "working", head: "abc", log: [{ at: now, kind: "started", text: "Started" }], updated: now });
  await s.note("u1", { at: now + 1, kind: "pushed", text: "Pushed the fix", sha: "a1b2c3d" }, "watching");
  const one = await s.get("u1");
  assert.equal(one?.state, "watching");
  assert.deepEqual(one?.log.map((e) => e.kind), ["started", "pushed"]);
  assert.equal((await s.bySession("s1"))?.url, "u1");
  assert.equal(await s.note("nobody", { at: now, kind: "pushed", text: "x" }), null);
  // An event heard without a time is logged with one: Code Review's log couldn't draw it (Arun, 2026-11-20: "Invalid time value").
  const timed = await s.note("u1", { at: undefined as unknown as number, kind: "pushed", text: "no time" });
  assert.ok(Number.isFinite(timed!.log.at(-1)!.at) && Number.isFinite(timed!.updated));
  for (let i = 0; i < 40; i++) await s.note("u1", { at: now + 10 + i, kind: "checks", text: `round ${i}` });
  assert.equal((await s.get("u1"))?.log.length, 30, "the last 30 kept");
  await s.put({ url: "u2", repo: "a/b", number: 2, title: "Old", sid: null, state: "done", head: "", log: [], updated: now - 15 * 86_400_000 });
  assert.deepEqual((await s.all(now)).map((r) => r.url), ["u1"]);
  // Cleared from the list: a finished one, or all finished at once; never one it's on.
  await s.put({ url: "u3", repo: "a/b", number: 3, title: "Stopped", sid: null, state: "stopped", head: "", log: [], updated: now });
  await s.put({ url: "u4", repo: "a/b", number: 4, title: "Done", sid: null, state: "done", head: "", log: [], updated: now });
  assert.equal(await s.forget("u1"), 0, "it's watching u1");
  assert.equal(await s.forget("u3"), 1);
  await s.put({ url: "u3", repo: "a/b", number: 3, title: "Stopped", sid: null, state: "stopped", head: "", log: [], updated: now });
  assert.equal(await s.forget(null), 2);
  assert.deepEqual((await s.all(now)).map((r) => r.url), ["u1"]);
});
