import assert from "node:assert/strict";
import test from "node:test";
import { CIRCLE_EDITS, MAX_FAILURES, SAME_CALL, runawayIn, runawayText } from "../src/runaway.js";
import type { EventBody, SessionEvent } from "../src/types.js";

let seq = 0;
const ev = (body: EventBody, lane?: string): SessionEvent => ({ seq: ++seq, ts: seq, actor: { id: "a", name: "Agent", kind: "agent" }, body, ...(lane ? { lane } : {}) });
const shell = (id: string, command: string) => ev({ type: "agent.message", text: "", toolCalls: [{ id, name: "shell", arguments: JSON.stringify({ command }) }] });
const result = (id: string, ok: boolean) => ev({ type: "tool.result", callId: id, name: "shell", output: ok ? "ok" : "Error: Cannot find module 'x'", isError: !ok });
const edit = (id: string) => ev({ type: "agent.message", text: "", toolCalls: [{ id, name: "edit", arguments: JSON.stringify({ path: "a.ts" }) }] });
const started = () => ev({ type: "run.started", causedBy: 1 });

test("the same failing command three times in a row, nothing changed between, is a loop", () => {
  const log = [started(), shell("1", "npm test"), result("1", false), shell("2", "npm  test"), result("2", false), shell("3", "npm test"), result("3", false)];
  assert.deepEqual(runawayIn(log, "main"), { command: "npm test", times: 3, kind: "stuck" });
  assert.match(runawayText(runawayIn(log, "main")!), /ran `npm test` 3 times in a row/);
});

test("running the tests again after changing something is ordinary work, until it has failed too often", () => {
  const log = [started()];
  for (let i = 0; i < MAX_FAILURES - 1; i++) log.push(shell(`c${i}`, "npm test"), result(`c${i}`, false), edit(`e${i}`));
  assert.equal(runawayIn(log, "main"), null, "edits between the failures: it's trying things");
  log.push(shell("last", "npm test"), result("last", false));
  assert.deepEqual(runawayIn(log, "main"), { command: "npm test", times: MAX_FAILURES, kind: "many" });
});

test("a pass breaks the streak, another lane's failures don't count, and a resume starts the count over", () => {
  const passed = [started(), shell("1", "npm test"), result("1", false), shell("2", "npm test"), result("2", true), shell("3", "npm test"), result("3", false), shell("4", "npm test"), result("4", false)];
  assert.equal(runawayIn(passed, "main"), null);
  const other = [started(), shell("1", "npm test"), result("1", false), shell("2", "npm test"), result("2", false), { ...shell("3", "npm test"), lane: "b" }, { ...result("3", false), lane: "b" }];
  assert.equal(runawayIn(other, "main"), null);
  const resumed = [started(), shell("1", "npm test"), result("1", false), shell("2", "npm test"), result("2", false), ev({ type: "run.resume" }), shell("3", "npm test"), result("3", false)];
  assert.equal(runawayIn(resumed, "main"), null, "a person said carry on");
});

test("one file edited in circles while the checks keep failing is a loop; a passing check clears it", () => {
  const editOf = (id: string, path: string) => ev({ type: "agent.message", text: "", toolCalls: [{ id, name: "edit", arguments: JSON.stringify({ path }) }] });
  const log = [started(), shell("t1", "npm test"), result("t1", false), shell("t2", "npm run lint"), result("t2", false)];
  for (let i = 0; i < CIRCLE_EDITS - 1; i++) log.push(editOf(`e${i}`, "src/cart.ts"));
  assert.equal(runawayIn(log, "main"), null);
  log.push(editOf("last", "src/cart.ts"));
  const r = runawayIn(log, "main")!;
  assert.deepEqual(r, { command: "src/cart.ts", times: CIRCLE_EDITS, kind: "circles" });
  assert.match(runawayText(r), /edited `src\/cart.ts` 8 times while the checks kept failing/);
  const passed = [started(), shell("t1", "npm test"), result("t1", false), shell("t2", "npm test"), result("t2", false), shell("t3", "npm test"), result("t3", true)];
  for (let i = 0; i < CIRCLE_EDITS; i++) passed.push(editOf(`p${i}`, "src/cart.ts"));
  assert.equal(runawayIn(passed, "main"), null, "the checks passed since: it is getting somewhere");
});

test("the same call with the same arguments over and over, nothing changed between, is a loop; plans and waits are not", () => {
  const fetchOf = (id: string) => ev({ type: "agent.message", text: "", toolCalls: [{ id, name: "web_fetch", arguments: JSON.stringify({ url: "https://linear.app/pricing" }) }] });
  const log = [started()];
  for (let i = 0; i < SAME_CALL - 1; i++) log.push(fetchOf(`f${i}`));
  assert.equal(runawayIn(log, "main"), null);
  log.push(fetchOf("f-last"));
  assert.deepEqual(runawayIn(log, "main"), { command: "web_fetch https://linear.app/pricing", times: SAME_CALL, kind: "repeat" });
  const plans = [started()];
  for (let i = 0; i < 6; i++) plans.push(ev({ type: "agent.message", text: "", toolCalls: [{ id: `u${i}`, name: "update_plan", arguments: "{}" }] }));
  assert.equal(runawayIn(plans, "main"), null);
  // Watching a page in the Browser panel (it reloads, the app moves on): never a loop (Arun, 2026-11-16).
  for (const [name, args] of [["mcp__friday__browser", { action: "read" }], ["browser", { action: "screenshot" }], ["mcp__claude-in-chrome__read_page", {}], ["mcp__Claude_Browser__computer", { action: "screenshot" }]] as const) {
    const watch = [started()];
    for (let i = 0; i < SAME_CALL + 4; i++) watch.push(ev({ type: "agent.message", text: "", toolCalls: [{ id: `w${i}`, name, arguments: JSON.stringify(args) }] }));
    assert.equal(runawayIn(watch, "main"), null, name);
  }
  // Clicking the same spot over and over still is.
  const clicks = [started()];
  for (let i = 0; i < SAME_CALL; i++) clicks.push(ev({ type: "agent.message", text: "", toolCalls: [{ id: `c${i}`, name: "mcp__Claude_Browser__computer", arguments: JSON.stringify({ action: "left_click", coordinate: [1, 2] }) }] }));
  assert.equal(runawayIn(clicks, "main")?.kind, "repeat");
});
