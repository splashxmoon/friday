import { describeCall, doingNow } from "./activity-line.js";
import { laneLabel, latestPlan } from "./left-off.js";
import { limitHit } from "./limit-reset.js";
import { limitedLanes } from "./limited.js";
import { commandFailed, TEST_CMD } from "./receipt.js";
import { canDriveLane, driverOf, givenName, runOf, type SessionState } from "./session/projection.js";
import { engineName, MAIN_LANE, type EngineMode, type EngineTool, type SessionEvent } from "./types.js";

/**
 * The session's agents at a glance, for the Agents hub: each one's state in a word and what it is doing in a line, how far
 * through its plan, who is driving it, on which model and mode; what has changed across all of them; how the checks came out;
 * and the last few things any of them did. Read from what the session already holds, so the hub is a view, never a second
 * source that can disagree.
 */
export type AgentStatus = "working" | "waiting" | "paused" | "offline" | "limited" | "failed" | "done" | "ready";

export interface HubAgent {
  lane: string;
  name: string;
  tool: EngineTool | null;
  status: AgentStatus;
  /** "Editing routes/billing.ts", "Needs you: rm -rf build", the first line of its answer. */
  line: string;
  /** Plan steps done and in all, when it has a plan. */
  plan: { done: number; total: number } | null;
  driver: { id: string; name: string } | null;
  /** When the run it is in (or last finished) started, and when it finished. */
  startedAt: number | null;
  endedAt: number | null;
  /** The model the host picked for it (none: the tool's default), its mode, and the branch it works on. */
  model: string | null;
  mode: EngineMode | null;
  branch: string | null;
  /** A request to run something, waiting on an answer. */
  ask: { id: string; items: string[]; scope: string } | null;
  /**
   * Held up on the person looking: a question put to them, or a permission or a decision on an agent they steer. "waiting"
   * alone can be on somebody else; this is what the agent rail, the needs-you count and ⌘J go by.
   */
  needsYou: boolean;
  /**
   * Tokens it has used in this session, read and written, as its turns counted them (agent.usage; Friday's own steps carry theirs):
   * whose subscription the session is spending, at a glance (Arun, 2026-10-25). Cache reads left out, as tool-usage.ts leaves them.
   */
  tokens: number;
}

export interface HubFile {
  path: string;
  adds: number;
  dels: number;
  /** The agents whose change sets have it: more than one is a file two agents are both changing. */
  lanes: string[];
}

export interface HubCheck {
  kind: "tests" | "typecheck" | "lint" | "build";
  command: string;
  ok: boolean;
  /** "9 passed", "2 failing", "0 errors", or nothing when the output says no count. */
  summary: string;
  ts: number;
  /** Which agent ran it, and the end of what it printed: what "Ask to fix" hands back. */
  lane: string;
  output: string;
}

export interface HubStep {
  lane: string;
  /** "Edited login.js", "Ran npm test". */
  text: string;
  ts: number;
  failed: boolean;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** A step said as done, for a list of what already happened: "Running npm test" → "Ran npm test". */
const PAST: Record<string, string> = { Reading: "Read", Looking: "Looked", Searching: "Searched", Editing: "Edited", Writing: "Wrote", Running: "Ran", Starting: "Started", Checking: "Checked", Stopping: "Stopped", Asking: "Asked", Handing: "Handed", Deploying: "Deployed", Making: "Made", Adding: "Added", Using: "Used" };
const past = (s: string) => s.replace(/^\w+/, (w) => PAST[w] ?? w);

const KIND: [HubCheck["kind"], RegExp][] = [
  ["typecheck", /\btsc\b|typecheck|type-check|\bmypy\b|\bpyright\b/i],
  ["lint", /\blint\b|eslint|ruff|clippy|golangci/i],
  // A build is a build tool asked to build, not any command with the word in it ("rm -rf build" is not one).
  ["build", /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|\b(?:cargo|go|gradle|dotnet|swift)\s+build\b|\btsc\s+(?:-b|--build)\b|\bvite\s+build\b|\bnext\s+build\b|^make\b/i],
  ["tests", TEST_CMD],
];

/** A count the output states, in the words tools use: "9 passed", "2 failing", "0 errors". */
function summaryOf(kind: HubCheck["kind"], ok: boolean, output: string): string {
  const pass = output.match(/(\d+)\s+(passed|passing)/i);
  const fail = output.match(/(\d+)\s+(failed|failing)/i);
  const errs = output.match(/(\d+)\s+errors?\b/i);
  if (kind === "tests") return fail && !ok ? `${fail[1]} failing` : pass ? `${pass[1]} passed` : ok ? "passed" : "failed";
  if (errs) return `${errs[1]} error${errs[1] === "1" ? "" : "s"}`;
  return ok ? (kind === "typecheck" ? "0 errors" : "ok") : "failed";
}

/** `meId`: who is looking, so their own tools read as just "Claude Code" and somebody else's as "Maya's Claude Code". */
export function hubOf(state: SessionState, events: SessionEvent[], meId = ""): { agents: HubAgent[]; files: HubFile[]; checks: HubCheck[]; recent: HubStep[] } {
  const lanes = [MAIN_LANE, ...state.lanes.map((l) => l.id)];
  // Per lane: when its current or last run started and ended, how that ended, its last words.
  const runs = new Map<string, { started: number | null; ended: number | null; outcome: string | null; error: string; answer: string }>();
  const calls = new Map<string, { command: string; step: HubStep }>();
  const steps: HubStep[] = [];
  const checks = new Map<HubCheck["kind"], HubCheck>();
  const spent = new Map<string, number>();
  for (const e of events) {
    const lane = e.lane ?? MAIN_LANE;
    if (e.body.type === "agent.usage") spent.set(lane, (spent.get(lane) ?? 0) + e.body.input + e.body.output);
    else if (e.body.type === "agent.message" && e.body.tokens) spent.set(lane, (spent.get(lane) ?? 0) + e.body.tokens);
    const r = runs.get(lane) ?? { started: null, ended: null, outcome: null, error: "", answer: "" };
    runs.set(lane, r);
    const b = e.body;
    if (b.type === "run.started") Object.assign(r, { started: e.ts, ended: null, outcome: null, error: "", answer: "" });
    else if (b.type === "run.ended") Object.assign(r, { ended: e.ts, outcome: b.outcome, error: b.error ?? "" });
    else if (b.type === "agent.message") {
      if (b.text.trim()) r.answer = b.text.trim().split("\n").find((l) => l.trim()) ?? "";
      for (const c of b.toolCalls) {
        if (c.name === "update_plan") continue;
        const step = { lane, text: past(describeCall(c)), ts: e.ts, failed: false };
        steps.push(step);
        let command = "";
        if (c.name === "run_command" || c.name === "shell") {
          try {
            command = String((JSON.parse(c.arguments || "{}") as { command?: unknown }).command ?? "").trim();
          } catch {
            // Arguments that aren't JSON name no command.
          }
        }
        calls.set(c.id, { command, step });
      }
    } else if (b.type === "tool.result") {
      const call = calls.get(b.callId);
      const failed = commandFailed(b);
      if (call && b.isError) call.step.failed = true;
      if (!call?.command || failed === null) continue;
      const kind = KIND.find(([, re]) => re.test(call.command))?.[0];
      if (kind) checks.set(kind, { kind, command: clip(call.command, 48), ok: !failed, summary: summaryOf(kind, !failed, b.output), ts: e.ts, lane, output: b.output.slice(-1500) });
    }
  }

  const limited = limitedLanes(state, events);
  const agents = lanes.map((lane): HubAgent => {
    const engine = state.engines[lane];
    const r = runs.get(lane);
    const run = runOf(state, lane).status;
    const ask = state.approvals[lane];
    const plan = latestPlan(events, lane);
    const base = {
      lane,
      name: engine?.tool ? (engine.hostId === meId ? (givenName(state, lane) ?? engineName(engine.tool)) : `${engine.hostName.split(/\s+/)[0]}'s ${givenName(state, lane) ?? engineName(engine.tool)}`) : laneLabel(state, lane),
      tool: engine?.tool ?? null,
      plan: plan.length ? { done: plan.filter((s) => s.done).length, total: plan.length } : null,
      driver: driverOf(state, lane),
      startedAt: r?.started ?? null,
      endedAt: r?.ended ?? null,
      model: engine?.model ?? null,
      mode: engine?.mode ?? null,
      branch: engine?.branch ?? null,
      ask: ask ? { id: ask.id, items: ask.items, scope: ask.scope } : null,
      tokens: spent.get(lane) ?? 0,
    };
    // Who answers what this agent is held up on: whoever drives it, or anyone who may when nobody does.
    const driver = driverOf(state, lane);
    const steers = !!meId && (driver ? driver.id === meId : canDriveLane(state, meId, lane));
    const question = state.openQuestions[lane];
    const decision = run !== "running" ? state.asks[lane]?.questions[0] : undefined;
    if (engine?.tool && !engine.online) return { ...base, needsYou: false, status: "offline", line: engine.hostId === meId ? "Offline · reconnect it from the chat" : `Offline · ${engine.hostName.split(/\s+/)[0]}'s computer` };
    if (ask) {
      const on = steers || !meId || !driver ? "you" : driver.name.split(/\s+/)[0];
      return { ...base, needsYou: steers || !meId, status: "waiting", line: ask.items.length ? `Needs ${on}: ${clip(ask.items[0]!, 44)}` : `Waiting on ${on}` };
    }
    // A question was counted as working, or as ready once the run paused for it: the hub said nothing was asked.
    if (question) {
      const mine = !meId || question.to === meId;
      return { ...base, needsYou: mine, status: "waiting", line: `${mine ? "Asking you" : `Asking ${question.toName.split(/\s+/)[0]}`}: ${clip(question.question.split("\n")[0]!, 44)}` };
    }
    if (decision) return { ...base, needsYou: steers || !meId, status: "waiting", line: `Needs a decision: ${clip(decision.question, 44)}` };
    const rest = { ...base, needsYou: false };
    if (run === "paused") return { ...rest, status: "paused", line: "Paused" };
    if (run === "running") return { ...rest, status: "working", line: doingNow(events, lane)?.text ?? "Working" };
    // Out of usage, its own or its account's (limited.ts), with when it comes back; once that has passed, ready again.
    const out = limited.get(lane);
    if (out) return { ...rest, status: "limited", line: `Out of usage${out.until ? ` until ${new Date(out.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}${out.via ? ` · same account as ${laneLabel(state, out.via)}` : ""}` };
    if (r?.outcome === "error") return limitHit(r.error) ? { ...rest, status: "ready", line: "Usage back · ready for a task" } : { ...rest, status: "failed", line: clip(r.error || "Stopped on an error", 60) };
    if (r?.outcome === "done") return { ...rest, status: "done", line: clip(r.answer || "Done", 60) };
    return { ...rest, status: "ready", line: "Ready for a task" };
  });

  const byPath = new Map<string, HubFile>();
  for (const lane of lanes)
    for (const f of state.diffs[lane]?.files ?? []) {
      const had = byPath.get(f.path);
      if (had) (had.lanes.push(lane), (had.adds = Math.max(had.adds, f.additions)), (had.dels = Math.max(had.dels, f.deletions)));
      else byPath.set(f.path, { path: f.path, adds: f.additions, dels: f.deletions, lanes: [lane] });
    }

  const order: HubCheck["kind"][] = ["tests", "typecheck", "lint", "build"];
  return {
    agents,
    files: [...byPath.values()],
    checks: order.flatMap((k) => (checks.get(k) ? [checks.get(k)!] : [])),
    recent: steps.slice(-6).reverse(),
  };
}
