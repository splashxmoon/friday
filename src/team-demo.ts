import { ENGINE_NAMES, ENGINE_TOOLS, type BoardTaskDef, type EngineTool, type SessionEvent } from "./types.js";

/**
 * The team demo: the first thing a new person is offered once a coding tool works, so that within their first minutes they see
 * what Friday does that a terminal doesn't (Arun, 2026-10-30: "a first run that shows the team"). Their own agents, in one
 * session, split a small job on the shared board (agent-mesh.ts post_tasks), each take a piece, tell each other what changed,
 * and have Friday run the checks and another agent review each piece before it counts.
 *
 * It runs for real: the person's own signed-in tools, on a small project made for it (DEMO_FILES), in a folder Friday makes
 * under the system's temp folder (runner/local-api.ts `demo`), never one of theirs. With one tool ready, a second lane of the
 * same tool joins, so there are still two agents talking.
 */

export const DEMO_TITLE = "See your agents work as a team";

/** The most agents it brings: the lead and two more. Each is a run on the person's own plan. */
export const DEMO_MOST = 3;

/** Who leads when several are ready: the tools that follow a plan of Friday's tools best, then the rest as Friday lists them. */
const LEAD_ORDER: EngineTool[] = ["claude", "codex", "gemini", "cursor"];

export interface DemoAgent {
  tool: EngineTool;
  /** The lane's name in the session: the tool's own, or "Claude Code 2" for a second lane of the same tool. */
  name: string;
}

/**
 * The team, from the tools that are ready: the first in LEAD_ORDER leads, up to two others of different tools join it; with one
 * tool, a second lane of it. Nothing ready, no team.
 */
export function demoTeam(ready: EngineTool[]): DemoAgent[] {
  const order = [...LEAD_ORDER, ...ENGINE_TOOLS.filter((t) => !LEAD_ORDER.includes(t) && t !== "acp"), "acp" as EngineTool];
  const tools = order.filter((t) => ready.includes(t)).slice(0, DEMO_MOST);
  if (!tools.length) return [];
  if (tools.length === 1) return [{ tool: tools[0]!, name: ENGINE_NAMES[tools[0]!] }, { tool: tools[0]!, name: `${ENGINE_NAMES[tools[0]!]} 2` }];
  return tools.map((tool) => ({ tool, name: ENGINE_NAMES[tool] }));
}

/**
 * The sample project: a receipt printer in plain Node, nothing to install, with two jobs in its README that touch each other
 * (a rename one agent makes and another's code depends on). Its tests pass as it ships (test/team-demo.test.ts runs them).
 *
 * The checks are npm scripts named `check:…` rather than `npm test`: a small change whose own tests passed goes through without
 * a second agent's look (agent-mesh.ts reviewOrPass), and a second agent's look is what this is here to show.
 */
export const DEMO_FILES: Record<string, string> = {
  "README.md": `# receipt

A small receipt printer, made for Friday's team demo. Amounts are whole cents.

- \`src/money.js\` turns cents into dollars: \`fmt(1234)\` is \`$12.34\`.
- \`src/receipt.js\` lays out a receipt's lines.
- \`bin/receipt.js\` prints a receipt for \`items.json\`: \`npm run receipt\`.

\`npm run check\` runs every test with Node's own test runner. There is nothing to install.

## To do

- \`fmt\` should be called \`formatMoney\`, and a refund prints as \`$-12.00\` instead of \`-$12.00\`.
- A receipt has no total yet: a subtotal, the tax and the total, each to the cent.
- A missing or broken items file ends in a stack trace instead of a line saying what is wrong.
`,
  "package.json": `${JSON.stringify(
    {
      name: "receipt",
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: {
        check: "node --test",
        "check:money": "node --test test/money.test.js",
        "check:receipt": "node --test test/receipt.test.js",
        receipt: "node bin/receipt.js items.json",
      },
    },
    null,
    2,
  )}\n`,
  "src/money.js": `/** Whole cents as dollars: fmt(1234) is "$12.34". */
export function fmt(cents) {
  return "$" + (cents / 100).toFixed(2);
}
`,
  "src/receipt.js": `import { fmt } from "./money.js";

/** One line of a receipt: the item's name, padded, and what that many of it cost. */
export function line(item) {
  return \`\${item.name.padEnd(16)} \${fmt(item.cents * item.qty)}\`;
}

/** Every item's line, one under another. */
export function lines(items) {
  return items.map(line).join("\\n");
}
`,
  "bin/receipt.js": `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { lines } from "../src/receipt.js";

const items = JSON.parse(readFileSync(process.argv[2] ?? "items.json", "utf8"));
console.log(lines(items));
`,
  "items.json": `[
  { "name": "Coffee beans", "cents": 1450, "qty": 2 },
  { "name": "Oat milk", "cents": 389, "qty": 1 },
  { "name": "Refund: mug", "cents": -1200, "qty": 1 }
]
`,
  "test/money.test.js": `import assert from "node:assert/strict";
import test from "node:test";
import { fmt } from "../src/money.js";

test("cents come out as dollars", () => {
  assert.equal(fmt(1234), "$12.34");
  assert.equal(fmt(5), "$0.05");
});
`,
  "test/receipt.test.js": `import assert from "node:assert/strict";
import test from "node:test";
import { line } from "../src/receipt.js";

test("a line is the name and what that many cost", () => {
  assert.equal(line({ name: "Oat milk", cents: 389, qty: 2 }), "Oat milk         $7.78");
});
`,
  ".gitignore": "node_modules/\n",
};

/** The board the lead posts, one task for each agent, as post_tasks takes it. `names[0]` is the lead's. */
export function demoTasks(names: string[]): BoardTaskDef[] {
  const [lead, second, third] = names;
  const tasks: BoardTaskDef[] = [
    {
      id: "total",
      title: "Add a total to the receipt",
      detail:
        "In src/receipt.js add total(items, taxRate) returning { subtotal, tax, total } in cents, the tax rounded to the cent, and test it in test/receipt.test.js. src/money.js is being changed at the same time: its fmt() is becoming formatMoney(), so use whatever its author tells you.",
      owns: ["src/receipt.js", "test/receipt.test.js"],
      after: [],
      ...(second ? { agent: second } : {}),
      check: "npm run check:receipt",
    },
  ];
  if (third)
    tasks.push({
      id: "errors",
      title: "Say what is wrong with a bad items file",
      detail: "In bin/receipt.js, a missing items file or one that isn't a JSON list prints one line saying which and exits with 1, instead of a stack trace. Keep printing the lines as it does now.",
      owns: ["bin/receipt.js"],
      after: [],
      agent: third,
      check: "npm run receipt",
    });
  tasks.push({
    id: "money",
    title: "Rename fmt to formatMoney, and print refunds right",
    detail:
      "In src/money.js rename fmt() to formatMoney(), keeping `export const fmt = formatMoney;` so nothing breaks yet, and print a refund as -$12.00 rather than $-12.00. Add a refund to test/money.test.js.",
    owns: ["src/money.js", "test/money.test.js"],
    after: [],
    ...(lead ? { agent: lead } : {}),
    check: "npm run check:money",
  });
  return tasks;
}

/**
 * What the lead is asked, naming the team as the session does. Its own task goes last on the board and is named for it, so the
 * board hands the others theirs as it is posted and leaves the lead's for it to claim (agent-mesh.ts dispatch).
 */
export function demoPrompt(names: string[]): string {
  const [lead, ...rest] = names;
  const others = rest.join(" and ");
  const tasks = demoTasks(names);
  const told = rest.length > 1 ? `the team with message_team (to "everyone")` : `${rest[0]} with message_agent`;
  return [
    `This is Friday's team demo: a small project made for it, in a folder Friday made, with someone new watching to see how agents work together here. You (${lead}) lead; ${others} ${rest.length > 1 ? "are" : "is"} in this session with you. Use Friday's tools (the friday MCP server) for each step below, keep every piece small, and don't touch other files.`,
    "",
    `1. Post this plan with post_tasks, exactly as given (ids, owns, agent and check):`,
    "```json",
    JSON.stringify({ tasks }, null, 2),
    "```",
    `2. Take "money" yourself with claim_task, and do it.`,
    `3. As soon as formatMoney() is in, tell ${told}, in a line or two: src/receipt.js still calls fmt(), which is now formatMoney() (fmt stays as an alias for now).`,
    `4. Finish "money" with finish_task and a two-line report. Friday runs its check, and another agent reviews it.`,
    `5. Leave the other tasks to their agents. When Friday asks you to review one, read the change and begin your answer with "Approved", or say what to fix.`,
    `6. When the board is done, say in three short lines what each agent did.`,
  ].join("\n");
}

/** A moment the guide beside the session points out (TeamGuide.tsx), in the order they come. */
export type MomentId = "board" | "claim" | "message" | "check" | "done";
export const MOMENT_ORDER: MomentId[] = ["board", "claim", "message", "check", "done"];

export interface Moment {
  id: MomentId;
  /** The event it happened at. */
  seq: number;
  /** What happened, in a line: "Claude Code split the work on the board". */
  line: string;
  /** A second line, quieter, when there is more to say. */
  detail?: string;
  /** What to point at: the board's card (its seq), a task's row on it, or an event's own row in the feed. */
  target: { seq: number; task?: string };
}

/** What each moment waits for, said before it happens. */
export const MOMENT_WAITING: Record<MomentId, string> = {
  board: "The lead splits the job on a shared board",
  claim: "Each agent takes a task",
  message: "One agent tells another what changed",
  check: "Friday runs the checks, then another agent reviews",
  done: "Every task done and checked",
};

const quote = (t: string) => `“${t}”`;

/**
 * The moments so far, read from the session's log: the first board posted, the tasks taken, the first message between agents,
 * the first review, and every task done and checked. Each is there once it has happened, at the event it happened at; the
 * claim line grows as more agents take tasks.
 */
export function teamMoments(events: SessionEvent[]): Moment[] {
  const out: Moment[] = [];
  const posted = events.find((e) => e.body.type === "board.posted" && e.body.tasks.length);
  if (!posted || posted.body.type !== "board.posted") return messageMoment(events, out);
  const board = posted.body;
  const titleOf = (id: string) => board.tasks.find((t) => t.id === id)?.title ?? id;
  out.push({ id: "board", seq: posted.seq, line: `${board.fromName} split the work on the board`, detail: `${board.tasks.length} tasks, each owning its own files`, target: { seq: posted.seq } });

  // From the newest board on (a lead may post again): what moved on the one the person is looking at.
  const latest = [...events].reverse().find((e) => e.body.type === "board.posted" && e.body.tasks.length)!;
  const after = events.filter((e) => e.seq > latest.seq);
  const ids = latest.body.type === "board.posted" ? latest.body.tasks.map((t) => t.id) : [];

  const claims = events.filter((e) => e.seq > posted.seq && e.body.type === "board.claimed");
  if (claims.length) {
    const first = claims[0]!;
    const who = [...new Set(claims.map((e) => (e.body.type === "board.claimed" ? e.body.name : "")))].filter(Boolean);
    const b = first.body.type === "board.claimed" ? first.body : null;
    const line = who.length === 1 ? `${who[0]} took ${quote(titleOf(b!.id))}` : `${who.slice(0, -1).join(", ")} and ${who[who.length - 1]} each took a task`;
    out.push({ id: "claim", seq: first.seq, line, detail: "The board hands each agent its piece, and nobody edits another's files", target: { seq: posted.seq, task: b!.id } });
  }

  messageMoment(events, out);

  const review = events.find((e) => e.seq > posted.seq && e.body.type === "board.review");
  if (review && review.body.type === "board.review") {
    const id = review.body.id;
    const by = review.body.name;
    const finished = [...events].reverse().find((e) => e.seq < review.seq && e.body.type === "board.finished" && e.body.id === id);
    const author = finished?.body.type === "board.finished" ? finished.body.name : "";
    const ran = [...events].reverse().find((e) => e.seq < review.seq && e.body.type === "board.checked" && e.body.id === id);
    const check = ran?.body.type === "board.checked" && !ran.body.skipped ? ` after Friday ran ${ran.body.command}` : "";
    // The brief the reviewer was sent, where it is in the feed; else the task's row on the board.
    const brief = [...events].reverse().find((e) => e.seq <= review.seq && e.body.type === "instruction" && e.body.mesh?.board === id && e.body.mesh.review);
    out.push({ id: "check", seq: review.seq, line: "Another agent is checking this", detail: `${by} reviews ${author ? `${author}'s ` : ""}${quote(titleOf(id))}${check}`, target: brief ? { seq: brief.seq } : { seq: posted.seq, task: id } });
  }

  // Done: every task on the newest board approved (or dropped), the last approval the moment.
  const okAt = new Map<string, number>();
  for (const e of after) {
    if (e.body.type === "board.reviewed") {
      if (e.body.ok) okAt.set(e.body.id, e.seq);
      else okAt.delete(e.body.id);
    } else if (e.body.type === "board.cancelled") okAt.set(e.body.id, e.seq);
    else if ((e.body.type === "board.released" || e.body.type === "board.claimed") && okAt.has(e.body.id)) okAt.delete(e.body.id);
  }
  if (ids.length && ids.every((id) => okAt.has(id))) {
    const seq = Math.max(...ids.map((id) => okAt.get(id)!));
    const n = ids.length;
    // The board's report to the lead, which comes as it finishes, where it is in the feed; else the board's own card.
    const report = events.find((e) => e.seq > seq && e.body.type === "instruction" && !!e.body.mesh?.batch);
    out.push({ id: "done", seq, line: "The board is done", detail: `${n} of ${n} tasks, each one checked before it counted`, target: { seq: report?.seq ?? latest.seq } });
  }
  return out.sort((a, b) => MOMENT_ORDER.indexOf(a.id) - MOMENT_ORDER.indexOf(b.id));
}

/**
 * The first message one agent sent another (message_agent, message_team, ask_agent, post_update), added to `out`. Not Friday's
 * own word to the lead (a board's report, a stuck task): that comes as a message too, from nobody's agent.
 */
function messageMoment(events: SessionEvent[], out: Moment[]): Moment[] {
  const fromAgent = (m: { by: unknown; fromName: string }) => !(m.by === null && m.fromName === "Friday");
  const said = events.find((e) => (e.body.type === "instruction" && e.body.mesh && (e.body.mesh.kind === "tell" || e.body.mesh.kind === "ask") && !e.body.mesh.board && fromAgent(e.body.mesh)) || e.body.type === "mesh.posted");
  if (!said) return out;
  const b = said.body;
  if (b.type === "mesh.posted") {
    out.push({ id: "message", seq: said.seq, line: `${b.fromName} told the others what changed`, detail: firstLine(b.text), target: { seq: said.seq } });
    return out;
  }
  if (b.type !== "instruction" || !b.mesh) return out;
  const m = b.mesh;
  const copies = m.team ? events.filter((e) => e.body.type === "instruction" && e.body.mesh?.team === m.team).length : 1;
  const to = copies > 1 ? "the team" : m.toName;
  const about = /\brenam/i.test(b.text) ? "about a rename" : m.kind === "ask" ? "" : "what changed";
  const line = m.kind === "ask" ? `${m.fromName} asked ${to} a question` : `${m.fromName} told ${to} ${about}`;
  out.push({ id: "message", seq: said.seq, line, detail: firstLine(b.text), target: { seq: said.seq } });
  return out;
}

const firstLine = (t: string) => {
  const l = (t.split("\n").find((x) => x.trim()) ?? "").trim();
  return l.length > 140 ? `${l.slice(0, 139).trimEnd()}…` : l;
};
