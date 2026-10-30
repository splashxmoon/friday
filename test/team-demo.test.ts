import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { TEST_CMD } from "../src/receipt.js";
import { demoFolder } from "../src/runner/local-api.js";
import { DEMO_FILES, demoPrompt, demoTasks, demoTeam, MOMENT_ORDER, teamMoments } from "../src/team-demo.js";
import { MAIN_LANE, type ActorRef, type EventBody, type SessionEvent } from "../src/types.js";

/**
 * The team demo (team-demo.ts, Arun, 2026-10-30: "a first run that shows the team"): the sample project works as it ships, the
 * team is made from whatever is signed in, and the guide's moments are read off the session's log as they happen.
 */

const write = (dir: string, files: Record<string, string>) => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
};
const run = (dir: string, args: string[]) => execFileSync("npm", ["run", "--silent", ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });

test("the sample project's tests pass as it ships, its receipt prints, and the README's jobs are still to do", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "friday-demo-files-"));
  try {
    write(dir, DEMO_FILES);
    run(dir, ["check"]);
    run(dir, ["check:money"]);
    run(dir, ["check:receipt"]);
    const printed = run(dir, ["receipt"]);
    assert.match(printed, /Coffee beans\s+\$29\.00/);
    // The bug the lead is asked to fix is there to fix.
    assert.match(printed, /Refund: mug\s+\$-12\.00/);
    assert.doesNotMatch(readFileSync(path.join(dir, "src/receipt.js"), "utf8"), /export function total/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each task's check is one Friday runs and then has another agent review: none reads as a test run a small change skips review on", () => {
  for (const t of demoTasks(["Claude Code", "Codex", "Gemini"])) {
    assert.ok(t.check, `${t.id} has a check`);
    assert.ok(!TEST_CMD.test(t.check!), `${t.id}'s check "${t.check}" would skip the review`);
    const script = t.check!.replace(/^npm run /, "");
    assert.ok(JSON.parse(DEMO_FILES["package.json"]!).scripts[script], `package.json has ${script}`);
  }
});

test("the team is whatever is signed in: Claude Code leads, two more of different tools join, and one tool alone gets a second lane", () => {
  assert.deepEqual(demoTeam([]), []);
  assert.deepEqual(demoTeam(["codex"]), [
    { tool: "codex", name: "Codex" },
    { tool: "codex", name: "Codex 2" },
  ]);
  assert.deepEqual(demoTeam(["copilot", "gemini", "claude", "codex"]).map((a) => a.name), ["Claude Code", "Codex", "Gemini CLI"]);
  assert.deepEqual(demoTeam(["copilot", "cursor"]).map((a) => a.tool), ["cursor", "copilot"]);
});

test("the lead's prompt names the team and the board it is to post, its own task last and named for it", () => {
  const two = demoPrompt(["Claude Code", "Codex"]);
  assert.match(two, /You \(Claude Code\) lead; Codex is in this session with you/);
  assert.match(two, /tell Codex with message_agent/);
  assert.match(two, /"agent": "Codex"/);
  const tasks = demoTasks(["Claude Code", "Codex"]);
  assert.deepEqual(tasks.map((t) => t.id), ["total", "money"]);
  assert.equal(tasks.at(-1)!.agent, "Claude Code");
  const three = demoPrompt(["Claude Code", "Codex", "Gemini"]);
  assert.match(three, /Codex and Gemini are in this session/);
  assert.match(three, /message_team/);
  assert.deepEqual(demoTasks(["a", "b", "c"]).map((t) => t.id), ["total", "errors", "money"]);
});

test("the demo's folder is a new one under the temp folder, holding the sample as a git repository", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "friday-demo-root-"));
  try {
    const a = await demoFolder({ name: "Ada" }, root);
    const b = await demoFolder({ name: "Ada" }, root);
    assert.notEqual(a, b, "a new folder each time");
    assert.equal(path.dirname(a), root);
    assert.match(path.basename(a), /^friday-team-demo-/);
    for (const rel of Object.keys(DEMO_FILES)) assert.equal(readFileSync(path.join(a, rel), "utf8"), DEMO_FILES[rel]);
    assert.ok(existsSync(path.join(a, ".git")));
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: a, encoding: "utf8" }).trim(), "", "committed as it was made");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const lead: ActorRef = { id: "agent", name: "Claude Code", kind: "agent" };
const codex: ActorRef = { id: "agent", name: "Codex", kind: "agent" };
const friday: ActorRef = { id: "friday", name: "Friday", kind: "system" };
/** The person behind the agents' messages. */
const by = { id: "u-ada", name: "Ada" };
function log(rows: [ActorRef, EventBody, string?][]): SessionEvent[] {
  return rows.map(([actor, body, lane], i) => ({ seq: i + 1, ts: 1_000 + i, actor, body, ...(lane && lane !== MAIN_LANE ? { lane } : {}) }) as SessionEvent);
}

test("the guide's moments come from the log as they happen, each once, pointing at the board, a task's row or the message", () => {
  const tasks = demoTasks(["Claude Code", "Codex"]);
  const rows: [ActorRef, EventBody, string?][] = [
    [lead, { type: "instruction", text: "This is Friday's team demo…", interrupt: false }],
    [lead, { type: "board.posted", fromLane: MAIN_LANE, fromName: "Claude Code", tasks, check: "" }],
    [codex, { type: "board.claimed", id: "total", lane: "lc", name: "Codex", why: "the plan named it for this" }, "lc"],
  ];
  let m = teamMoments(log(rows));
  assert.deepEqual(m.map((x) => x.id), ["board", "claim"]);
  assert.equal(m[0]!.line, "Claude Code split the work on the board");
  assert.deepEqual(m[0]!.target, { seq: 2 });
  assert.equal(m[1]!.line, "Codex took “Add a total to the receipt”");
  assert.deepEqual(m[1]!.target, { seq: 2, task: "total" });

  rows.push(
    [lead, { type: "board.claimed", id: "money", lane: MAIN_LANE, name: "Claude Code" }],
    // A board task's brief is no message between agents; the lead telling Codex about the rename is.
    [friday, { type: "instruction", text: "Your task…", interrupt: false, mesh: { id: "b1", kind: "task", board: "total", fromLane: MAIN_LANE, fromName: "Claude Code", toName: "Codex", hop: 1, by } }, "lc"],
    [lead, { type: "instruction", text: "Heads up: I renamed fmt() to formatMoney() in src/money.js; fmt stays as an alias.", interrupt: false, mesh: { id: "m1", kind: "tell", fromLane: MAIN_LANE, fromName: "Claude Code", toName: "Codex", hop: 1, by } }, "lc"],
    [lead, { type: "board.finished", id: "money", lane: MAIN_LANE, name: "Claude Code", status: "done", report: "Done." }],
    [friday, { type: "board.checking", id: "money", lane: MAIN_LANE, command: "npm run check:money" }],
    [friday, { type: "board.checked", id: "money", lane: MAIN_LANE, command: "npm run check:money", ok: true, output: "ok" }],
    [friday, { type: "board.review", id: "money", lane: "lc", name: "Codex" }, "lc"],
  );
  m = teamMoments(log(rows));
  assert.deepEqual(m.map((x) => x.id), ["board", "claim", "message", "check"]);
  assert.equal(m[1]!.line, "Codex and Claude Code each took a task");
  assert.equal(m[2]!.line, "Claude Code told Codex about a rename");
  assert.deepEqual(m[2]!.target, { seq: 6 });
  assert.equal(m[3]!.line, "Another agent is checking this");
  assert.equal(m[3]!.detail, "Codex reviews Claude Code's “Rename fmt to formatMoney, and print refunds right” after Friday ran npm run check:money");
  assert.deepEqual(m[3]!.target, { seq: 2, task: "money" }, "the task's row, with no brief in the feed to point at");
  // With the reviewer's brief in the log, the brief, where it is in the feed.
  const briefed = [...rows.slice(0, -1), [friday, { type: "instruction", text: "Check Claude Code's work…", interrupt: false, mesh: { id: "r1", kind: "task", board: "money", review: true, fromLane: MAIN_LANE, fromName: "Claude Code", toName: "Codex", hop: 1, by } }, "lc"] as [ActorRef, EventBody, string], rows.at(-1)!];
  assert.deepEqual(teamMoments(log(briefed)).find((x) => x.id === "check")!.target, { seq: 10 });

  // Done once every task on the board is approved; a review that sends one back undoes it until it passes again.
  rows.push([codex, { type: "board.reviewed", id: "money", lane: "lc", name: "Codex", ok: true, note: "Approved." }, "lc"]);
  rows.push([lead, { type: "board.reviewed", id: "total", lane: MAIN_LANE, name: "Claude Code", ok: false, note: "The tax isn't rounded." }]);
  assert.ok(!teamMoments(log(rows)).some((x) => x.id === "done"));
  rows.push([lead, { type: "board.reviewed", id: "total", lane: MAIN_LANE, name: "Claude Code", ok: true, note: "Approved." }]);
  m = teamMoments(log(rows));
  assert.deepEqual(m.map((x) => x.id), MOMENT_ORDER);
  assert.equal(m.at(-1)!.line, "The board is done");
  assert.equal(m.at(-1)!.detail, "2 of 2 tasks, each one checked before it counted");
  assert.deepEqual(m.at(-1)!.target, { seq: 2 }, "the board, until its report comes");
  rows.push([{ id: "agent", name: "The board", kind: "agent" }, { type: "instruction", text: "## money…", interrupt: false, mesh: { id: "rp", kind: "reply", ofTask: true, batch: "done", fromLane: MAIN_LANE, fromName: "The board", toName: "Claude Code", hop: 1, by: null } }]);
  assert.deepEqual(teamMoments(log(rows)).at(-1)!.target, { seq: rows.length }, "then the report");
});

test("a message to the whole team is one moment, said as to the team; Friday's own word to the lead isn't one", () => {
  const rows: [ActorRef, EventBody, string?][] = [
    [{ id: "agent", name: "Friday", kind: "agent" }, { type: "instruction", text: "The board is stuck…", interrupt: false, mesh: { id: "f", kind: "tell", fromLane: MAIN_LANE, fromName: "Friday", toName: "Claude Code", hop: 1, by: null } }],
    [lead, { type: "instruction", text: "fmt is now formatMoney.", interrupt: false, mesh: { id: "a", team: "t1", kind: "tell", fromLane: MAIN_LANE, fromName: "Claude Code", toName: "Codex", hop: 1, by } }, "lc"],
    [lead, { type: "instruction", text: "fmt is now formatMoney.", interrupt: false, mesh: { id: "b", team: "t1", kind: "tell", fromLane: MAIN_LANE, fromName: "Claude Code", toName: "Gemini", hop: 1, by } }, "lg"],
  ];
  const m = teamMoments(log(rows));
  assert.deepEqual(m.map((x) => x.id), ["message"]);
  assert.equal(m[0]!.line, "Claude Code told the team what changed");
});
