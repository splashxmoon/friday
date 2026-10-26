import { commandFailed } from "../receipt.js";
import { MAIN_LANE, type Member, type SessionEvent } from "../types.js";
import { questionsTo, requestsTo, type SessionState } from "./projection.js";

export interface DigestGroup {
  label: string;
  items: string[];
}

export interface Digest {
  sinceSeq: number;
  missed: number;
  /** When the first missed event happened, for "you were away 12 minutes". */
  since: number | null;
  /** Waiting on this person specifically. Shown first, because it is the point. */
  needsYou: string[];
  /** Where the session stands now: status and who holds the wheel. */
  status: string;
  driver: string;
  /** What happened, grouped so it can be skimmed rather than read. */
  groups: DigestGroup[];
  /** Flat form of the same summary, for text surfaces. */
  lines: string[];
}

/**
 * "What happened while I was away": a deterministic summary of the events a
 * member missed, built from the log instead of making them reread a transcript.
 * No model call, so it's instant, free, and can't invent anything.
 *
 * Pure on purpose: the server sends it on a cold join, and the client runs the
 * same function over its own events when someone comes back to an open tab.
 */
export function buildDigest(missed: SessionEvent[], state: SessionState, me: Member, sinceSeq: number): Digest | null {
  const others = missed.filter((e) => e.actor.id !== me.id);
  if (others.length === 0) return null;

  const instructionsBy = new Map<string, number>();
  // Asides: what people said to each other, which no agent read.
  const chatsBy = new Map<string, number>();
  const decided: string[] = [];
  const control: string[] = [];
  const questions: string[] = [];
  let suggestions = 0;
  let toolCalls = 0;
  let failures = 0;
  // Each agent's share, for a session running several: answers, files changed, tasks finished, and whether it stopped.
  const byLane = new Map<string, { answers: number; files: Set<string>; tasks: number; stopped: boolean }>();
  const laneOf = (lane: string) => {
    let l = byLane.get(lane);
    if (!l) byLane.set(lane, (l = { answers: 0, files: new Set(), tasks: 0, stopped: false }));
    return l;
  };
  let agentTalk = 0;

  for (const e of others) {
    const b = e.body;
    if (b.type === "instruction") instructionsBy.set(e.actor.name, (instructionsBy.get(e.actor.name) ?? 0) + 1);
    else if (b.type === "chat") chatsBy.set(e.actor.name, (chatsBy.get(e.actor.name) ?? 0) + 1);
    else if (b.type === "suggestion") suggestions++;
    // What the agent decided matters more to someone coming back than what it ran.
    else if (b.type === "memory.saved") { if (b.text) decided.push(b.text); }
    // Arriving to a session that already has a history is worth saying plainly.
    else if (b.type === "session.imported") control.push(`${e.actor.name} brought in an earlier conversation, “${truncate(b.title, 60)}”`);
    else if (b.type === "tool.result") {
      toolCalls++;
      if (commandFailed(b) === true) failures++;
    } else if (b.type === "control.granted") control.push(`${b.toName} took control (${b.reason})`);
    else if (b.type === "control.released") control.push(`control was released (${b.reason})`);
    else if (b.type === "run.cancel") control.push(`${e.actor.name} cancelled the run`);
    else if (b.type === "folder.restored") control.push(`${e.actor.name} undid a run's changes`);
    else if (b.type === "folder.committed") control.push(`${e.actor.name} committed ${b.files} file${b.files === 1 ? "" : "s"}${b.prUrl && b.prCreated ? " and opened a pull request" : b.pushed ? " and pushed" : ""}`);
    else if (b.type === "agent.question") questions.push(b.question);
    if (b.type === "agent.message" && b.text.trim()) laneOf(e.lane ?? MAIN_LANE).answers++;
    else if (b.type === "agent.diff") for (const f of b.files) laneOf(e.lane ?? MAIN_LANE).files.add(f.path);
    else if (b.type === "board.finished" && b.status === "done") laneOf(b.lane).tasks++;
    else if (b.type === "run.ended" && b.outcome === "error") laneOf(e.lane ?? MAIN_LANE).stopped = true;
    else if (b.type === "mesh.posted" || b.type === "mesh.replied") agentTalk++;
  }

  // What is actually blocking this person, separated from general activity.
  const needsYou: string[] = [];
  for (const q of questionsTo(state, me.id)) needsYou.push(`The agent is waiting on your answer: “${truncate(q.question, 240)}”`);
  const asks = requestsTo(state, me.id);
  if (asks.length) {
    const names = asks.map((r) => r.name).join(", ");
    needsYou.push(`${names} ${asks.length === 1 ? "is" : "are"} asking for control.`);
  }
  if (state.run.status === "error") needsYou.push(`The run stopped on an error${state.run.error ? `: ${truncate(state.run.error, 160)}` : "."}`);

  const groups: DigestGroup[] = [];

  const people: string[] = [];
  for (const [name, n] of instructionsBy) people.push(`${name} sent ${n} instruction${n > 1 ? "s" : ""}`);
  for (const [name, n] of chatsBy) people.push(`${name} wrote ${n === 1 ? "a message" : `${n} messages`} to the people here`);
  if (suggestions) people.push(`${suggestions} new suggestion${suggestions > 1 ? "s" : ""}`);
  if (control.length) people.push(...control);
  if (people.length) groups.push({ label: "The team", items: people });

  const agent: string[] = [];
  // With more than one agent, a line each: who did what is the question someone coming back asks first.
  if (byLane.size > 1 || state.lanes.length > 0) {
    for (const [lane, l] of byLane) {
      const did: string[] = [];
      if (l.answers) did.push(`answered ${l.answers === 1 ? "once" : `${l.answers} times`}`);
      if (l.files.size) did.push(`changed ${l.files.size} file${l.files.size === 1 ? "" : "s"}`);
      if (l.tasks) did.push(`finished ${l.tasks} task${l.tasks === 1 ? "" : "s"}`);
      if (l.stopped) did.push("stopped on an error");
      if (did.length) agent.push(`${laneName(state, lane)} ${did.join(", ")}`);
    }
    if (agentTalk) agent.push(`The agents sent each other ${agentTalk} message${agentTalk === 1 ? "" : "s"}`);
  }
  for (const d of decided) agent.push(`Noted: ${truncate(d, 160)}`);
  if (toolCalls) agent.push(`Ran ${toolCalls} tool call${toolCalls > 1 ? "s" : ""}${failures ? ` (${failures} failed)` : ""}`);
  for (const q of questions) agent.push(`Asked: “${truncate(q, 160)}”`);
  if (agent.length) groups.push({ label: byLane.size > 1 || state.lanes.length > 0 ? "The agents" : "The agent", items: agent });

  if (state.lastInstruction) {
    groups.push({ label: "Current intent", items: [`${state.lastInstruction.by}: “${truncate(state.lastInstruction.text, 240)}”`] });
  }

  const driver = state.driver ? (state.driver.id === me.id ? "you" : state.driver.name) : "nobody";
  const status = statusText(state);

  // The flat form keeps every fact the grouped form carries.
  const lines: string[] = [];
  for (const [name, n] of instructionsBy) lines.push(`${name} sent ${n} instruction${n > 1 ? "s" : ""}.`);
  for (const [name, n] of chatsBy) lines.push(`${name} wrote ${n === 1 ? "a message" : `${n} messages`} to the people here.`);
  if (state.lastInstruction) lines.push(`Current intent (${state.lastInstruction.by}): “${truncate(state.lastInstruction.text, 200)}”`);
  if (control.length) lines.push(cap(control.join("; ")) + ".");
  for (const d of decided) lines.push(`Noted: ${truncate(d, 160)}`);
  if (toolCalls) lines.push(`${toolCalls} tool call${toolCalls > 1 ? "s" : ""} ran.`);
  if (suggestions) lines.push(`${suggestions} new suggestion${suggestions > 1 ? "s" : ""}.`);
  lines.push(`Agent is ${status}; ${driver} ${driver === "you" ? "are" : "is"} driving.`);
  for (const n of needsYou) lines.push(n);

  return {
    sinceSeq,
    missed: others.length,
    since: others[0]?.ts ?? null,
    needsYou,
    status,
    driver,
    groups,
    lines,
  };
}

function statusText(s: SessionState): string {
  switch (s.run.status) {
    case "waiting_for_human":
      return `waiting for ${s.openQuestions[MAIN_LANE]?.toName ?? "a human"}`;
    case "error":
      return "stopped on an error";
    default:
      return s.run.status;
  }
}

/** An agent by the name the session shows it under. */
function laneName(s: SessionState, lane: string): string {
  if (lane === MAIN_LANE) return s.mainName?.trim() || "Friday";
  return s.lanes.find((l) => l.id === lane)?.name ?? "An agent";
}

const truncate = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
