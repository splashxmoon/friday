import { test } from "node:test";
import assert from "node:assert/strict";
import { reachFor, reachForHandoff, reachForMessage, settle } from "../src/client/smartReach.js";
import type { SessionState } from "../src/session/projection.js";

const mode = (t: string) => reachForMessage(t)?.mode ?? null;

test("questions and explanations go in Plan", () => {
  assert.equal(mode("Why does the login page flash on load?"), "plan");
  assert.equal(mode("explain how the session projection works"), "plan");
  assert.equal(mode("How do I add a new route?"), "plan");
  assert.equal(mode("review the diff before I merge"), "plan");
  assert.equal(mode("Plan the migration to Postgres"), "plan");
  assert.equal(mode("look into why the build is slow"), "plan");
});

test("asked not to change anything is Plan, whatever else it says", () => {
  assert.equal(mode("Don't change anything, just tell me what you'd fix"), "plan");
  assert.equal(mode("run the tests but do not edit any files"), "plan");
});

test("a change is Manual, a polite one too, and a question that ends in an instruction", () => {
  assert.equal(mode("add a dark mode toggle to settings"), "edits");
  assert.equal(mode("Can you rename the Board page to Agents?"), "edits");
  assert.equal(mode("What's wrong with the header? Fix it"), "edits");
  assert.equal(mode("look at the header and make it bigger"), "edits");
});

test("running checks and installing packages is Auto", () => {
  assert.equal(mode("run the tests"), "full");
  assert.equal(mode("Could you run the full test suite?"), "full");
  assert.equal(mode("fix the failing tests"), "full");
  assert.equal(mode("make the build pass"), "full");
  assert.equal(mode("npm install zod and use it for the form"), "full");
  assert.equal(mode("upgrade the dependencies"), "full");
});

test("nothing clear, and commands, leave it as it is", () => {
  assert.equal(reachForMessage("hello"), null);
  assert.equal(reachForMessage("/compact"), null);
  assert.equal(reachForMessage(""), null);
});

test("a handoff: a reviewer reads, a failing test gets Auto, out of usage carries on as it was", () => {
  assert.equal(reachForHandoff({ changed: ["a.ts"], tests: "fail" }, "Reviewer reads a diff")?.mode, "plan");
  assert.equal(reachForHandoff({ changed: ["a.ts"], tests: "fail" }, "Claude Code")?.mode, "full");
  assert.equal(reachForHandoff({ changed: ["a.ts"], tests: null }, "QA writes tests")?.mode, "full");
  assert.equal(reachForHandoff({ changed: ["README.md"], tests: null }, "Docs writer")?.mode, "edits");
  assert.equal(reachForHandoff({ changed: [], tests: null, limited: true }, "Codex", "edits")?.mode, "edits");
  assert.equal(reachForHandoff({ changed: ["a.ts"], tests: "pass" }, "Codex"), null);
});

test("a folder somebody else is editing takes only a reader", () => {
  const engine = (cwd: string, m: "plan" | "edits" | "full", online = true) => ({ cwd, mode: m, online, hostName: "Maya Chen" });
  const state = { engines: { main: engine("C:/code/app", "edits"), l2: engine("C:/code/app/", "plan") } } as unknown as SessionState;
  assert.deepEqual(settle(state, "l2", { mode: "edits", why: "it changes files" }), { mode: "plan", why: "Maya's main agent is editing this folder" });
  assert.equal(settle(state, "l2", { mode: "plan", why: "it's a question" })?.mode, "plan");
  const alone = { engines: { main: engine("C:/code/app", "edits", false), l2: engine("C:/code/app", "plan") } } as unknown as SessionState;
  assert.equal(settle(alone, "l2", { mode: "full", why: "x" })?.mode, "full");
});

test("a folder shared by choice holds nobody back, as the hub has it (a Work session's agents share one)", () => {
  const engine = (cwd: string, m: "plan" | "edits" | "full", shared: boolean) => ({ cwd, mode: m, online: true, hostName: "Maya Chen", ...(shared ? { shared: true } : {}) });
  const both = { engines: { main: engine("/w", "full", true), l2: engine("/w", "edits", true) } } as unknown as SessionState;
  assert.equal(settle(both, "l2", { mode: "edits", why: "it changes files" })?.mode, "edits", "a shared lane isn't dropped into Plan");
  assert.equal(reachFor({ engines: { main: { ...engine("/w", "edits", true), handMode: "edits" }, l2: engine("/w", "full", true) } } as unknown as SessionState, "main", "Please write a two-line intro"), null, "Manual stays Manual");
  const besideShared = { engines: { main: engine("/w", "full", true), l2: engine("/w", "edits", false) } } as unknown as SessionState;
  assert.equal(settle(besideShared, "l2", { mode: "full", why: "x" })?.mode, "full", "a shared lane beside it isn't holding the folder");
  const mineShared = { engines: { main: engine("/w", "full", false), l2: engine("/w", "edits", true) } } as unknown as SessionState;
  assert.equal(settle(mineShared, "l2", { mode: "full", why: "x" })?.mode, "full", "a lane that shares it isn't held");
});

test("each message is read against the mode picked by hand, so a question's Plan doesn't stick", () => {
  const at = (m: "plan" | "edits" | "full", hand?: "plan" | "edits" | "full") =>
    ({ engines: { main: { cwd: "/w", mode: m, online: true, hostName: "Ada", ...(hand ? { handMode: hand } : {}) } } }) as unknown as SessionState;
  const pick = (s: SessionState, t: string) => reachFor(s, "main", t)?.mode ?? null;
  // Auto picked by hand: a question reads in Plan; the next change, or anything unclear, goes back to Auto.
  assert.equal(pick(at("full"), "why does login fail?"), "plan");
  const switched = at("plan", "full");
  assert.equal(pick(switched, "fix the login redirect"), "full", "a change goes back to Auto, not on in Plan");
  assert.equal(pick(switched, "carry on"), "full", "nothing clear goes back too");
  assert.equal(pick(switched, "and what about signup?"), null, "another question: it is a reader already");
  assert.equal(pick(at("full"), "carry on"), null, "already where it was picked: nothing to do");
  assert.equal(pick(at("full"), "fix the login redirect"), null, "a change in Auto stays in Auto");
  // Manual picked by hand: a change is Manual's; running the tests is Auto; Plan picked by hand stays Plan for a change.
  assert.equal(pick(at("plan", "edits"), "add a logout button"), "edits");
  assert.equal(pick(at("edits"), "run the tests"), "full");
  assert.equal(pick(at("plan"), "add a logout button"), null, "Plan by hand is the person's call");
  assert.match(reachFor(switched, "main", "fix it")!.why, /back to Auto, the mode you picked/);
});

// QA, 2026-10-28: a lane with no mode on record showed "Auto" and was switched to Manual by the first change asked of it.
test("a lane with no mode on record is Auto, and a change keeps it there", () => {
  const s = { engines: { main: { tool: "claude", cwd: "/w", online: true, hostId: "me", hostName: "Me" } } } as unknown as SessionState;
  assert.equal(reachFor(s, "main", "Make the launch week calendar page"), null);
  assert.equal(reachFor(s, "main", "Why is the header blue?")?.mode, "plan");
  assert.equal(settle(s, "main", { mode: "edits", why: "it changes files" }), null);
});
