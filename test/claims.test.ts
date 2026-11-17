import assert from "node:assert/strict";
import test from "node:test";
import { checkedIn, claimOf, commandFor } from "../src/claims.js";
import type { EventBody, SessionEvent } from "../src/types.js";

/** "Done", checked rather than claimed (claims.ts). */
let seq = 0;
const ev = (body: EventBody): SessionEvent => ({ seq: ++seq, ts: seq, actor: { id: "a", name: "Kit", kind: "agent" }, body, lane: "k" });

test("an answer's claim that something passes, and not one that says it didn't", () => {
  assert.equal(claimOf("Fixed the rounding. All tests pass now.")?.kind, "tests");
  assert.equal(claimOf("Tests: green, 42 passing.")?.kind, "tests");
  assert.equal(claimOf("The build succeeds and the page loads.")?.kind, "build");
  assert.equal(claimOf("Lint is clean.")?.kind, "lint");
  assert.equal(claimOf("tsc passes with no errors")?.kind, "types");
  assert.equal(claimOf("I couldn't run the tests, so they're unverified."), null);
  assert.equal(claimOf("Two tests still fail."), null);
  assert.equal(claimOf("Drafted the announcement in announcement.md."), null);
});

test("what in the turn backs it: the last matching command and how it went", () => {
  const call = (id: string, command: string) => ev({ type: "agent.message", text: "", toolCalls: [{ id, name: "shell", arguments: JSON.stringify({ command }) }] });
  const res = (id: string, ok: boolean) => ev({ type: "tool.result", callId: id, name: "shell", output: ok ? "42 passing" : "1 failing", isError: !ok });
  const log = [call("1", "npm test"), res("1", false), call("2", "npm run build"), res("2", true), call("3", "npm test"), res("3", true)];
  assert.deepEqual(checkedIn(log, "k", 0, Infinity, "tests"), { command: "npm test", ok: true });
  assert.deepEqual(checkedIn(log.slice(0, 4), "k", 0, Infinity, "tests"), { command: "npm test", ok: false });
  assert.equal(checkedIn(log, "k", 0, Infinity, "lint"), null);
  assert.equal(checkedIn(log, "other", 0, Infinity, "tests"), null);
});

test("the project's own command for a claim, from what is in its folder", () => {
  const files = (...f: string[]) => (x: string) => f.includes(x);
  assert.equal(commandFor("tests", JSON.stringify({ scripts: { test: "vitest run" } }), files("package.json")), "npm test");
  assert.equal(commandFor("tests", JSON.stringify({ scripts: { test: "vitest" } }), files("package.json", "pnpm-lock.yaml")), "pnpm test");
  assert.equal(commandFor("tests", JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }), files("package.json")), "");
  assert.equal(commandFor("tests", null, files("pyproject.toml")), "python -m pytest -q");
  assert.equal(commandFor("build", JSON.stringify({ scripts: { build: "vite build" } }), files("package.json", "yarn.lock")), "yarn build");
  assert.equal(commandFor("types", null, files("tsconfig.json")), "npx tsc --noEmit");
  assert.equal(commandFor("lint", null, files()), "");
});
