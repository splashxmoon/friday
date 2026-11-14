import { carriedOn, limitHit, planLimitHit, signedOut } from "./limit-reset.js";
import { driverOf, roleOf, runOf, type SessionState } from "./session/projection.js";
import { liveMachine, MAIN_LANE } from "./types.js";

/**
 * One agent's state, worked out once, for every place that shows it: the header's agent tab, the feed's status line, the sidebar's
 * row, the status bar's ring, the terminal view, the Tasks panel and Lanes (audit B-19, B-35, B-18). Each of those used to read the
 * run its own way, so one agent read "Thinking · 10s" in the feed, "Ready" on its tab, "Out of usage" in the sidebar and "Stopped"
 * in the status bar at the same moment, and two people looking at the same session saw "stopped" and "done".
 *
 * The words are the same for everyone, with one exception that is the point of them: what an agent is held up on is "Needs you"
 * only for the people who can answer it, and "Waiting on Ada" for everyone else (audit B-14).
 */

export type AgentPhase =
  /** Held up on a person, and this person is one who can answer. */
  | "needs"
  /** Held up on somebody else. */
  | "waiting"
  | "working"
  | "paused"
  /** Its last turn ended on an error. */
  | "failed"
  /** Out of its plan's usage, until it lifts. */
  | "limited"
  /** Its coding tool's computer is away. */
  | "offline"
  /** Somebody pressed Stop on its last turn. */
  | "stopped"
  /** Finished its turn with its plan short ("Stopped at 3 of 5"). */
  | "short"
  | "done"
  | "ready";

/** What an agent is held up on, and the people who can answer it, by id and first name. */
export interface Held {
  kind: "question" | "approval" | "ask" | "message" | "turn";
  ids: string[];
  names: string[];
  /** An approval that needs several yeses: how many are still to come. */
  left?: number;
}

export interface AgentNow {
  phase: AgentPhase;
  /** Its state in a word or two, in sentence case, the same for everyone it isn't waiting on: "Working", "Waiting on Ada". */
  word: string;
  /** Held up on this person. What counts it, turns it amber and pushes it to them. */
  needsYou: boolean;
  held: Held | null;
  /** Its last turn's error: in plain words, and the provider's own text for a details toggle. */
  error?: { plain: string; raw: string };
  /** Out of usage: when it lifts, or null when it didn't say. */
  until?: number | null;
  /**
   * Whether this person can send its last message again: whoever is in control of it, and the session's owner. Anyone else is
   * offered to ask them (`ask`, a first name).
   */
  retry?: { mine: true } | { mine: false; ask: string };
}

const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** The person whose call an agent's waits are when one person decides: whoever is in control of it, else the session's owners. */
export function steersLane(state: SessionState, meId: string, lane: string): boolean {
  const d = driverOf(state, lane);
  return d ? d.id === meId : roleOf(state, meId) === "owner";
}

export function stewards(state: SessionState, lane: string): { ids: string[]; names: string[] } {
  const d = driverOf(state, lane);
  if (d) return { ids: [d.id], names: [first(d.name)] };
  const owners = Object.entries(state.members).filter(([, m]) => !m.removed && m.role === "owner");
  return { ids: owners.map(([id]) => id), names: owners.map(([, m]) => first(m.name)) };
}

/**
 * What the agent on `lane` is held up on and who can answer it, or null when it isn't. One rule for every place it is counted:
 * a question waits on the person it was put to; a permission that needs several yeses on everyone whose yes counts and who hasn't
 * given it; one that needs one yes on the host of a machine only its host may say yes for, else whoever is in control, else the
 * owners; a coding tool's question at the end of its turn, a message held from another session or a turn waiting on a person,
 * on whoever is in control, else the owners.
 */
export function heldOn(state: SessionState, lane: string): Held | null {
  const q = state.openQuestions?.[lane];
  if (q) return { kind: "question", ids: [q.to], names: [first(q.toName)] };
  const ask = approvers(state, lane);
  if (ask) return ask;
  const run = runOf(state, lane);
  if (state.asks?.[lane]?.questions.length && run.status !== "running") return { kind: "ask", ...stewards(state, lane) };
  if ((state.peersHeld ?? []).some((h) => h.lane === lane)) return { kind: "message", ...stewards(state, lane) };
  if (run.status === "waiting_for_human") return { kind: "turn", ...stewards(state, lane) };
  return null;
}

/**
 * Who can say yes to what the agent on `lane` asks permission for, or null when it asks nothing: with several yeses needed,
 * everyone whose yes counts and who hasn't given it; with one, the host of a machine only its host may say yes for, else whoever
 * is in control, else the owners. Others the owner allowed to answer some kinds of command can still answer on its card; this is
 * who it waits on.
 */
export function approvers(state: SessionState, lane: string): Held | null {
  const ask = state.approvals[lane];
  if (!ask) return null;
  // A Manual machine: only its host's yes counts. The open-source edition has one person and no several-yeses rule.
  const machine = liveMachine(state, lane) ?? state.engines[lane];
  if (machine && machine.mode === "edits") return { kind: "approval", ids: [machine.hostId], names: [first(machine.hostName)] };
  return { kind: "approval", ...stewards(state, lane) };
}

/** "Waiting on Ada", "Waiting on Ada and Bea", "Waiting on 2 more yeses". */
export function waitingWord(h: Held): string {
  if (h.kind === "approval" && h.left !== undefined) return `Waiting on ${h.left} more yes${h.left === 1 ? "" : "es"}`;
  if (!h.names.length) return "Waiting on a person";
  const names = h.names.length > 2 ? [h.names[0]!, `${h.names.length - 1} others`] : h.names;
  return `Waiting on ${names.join(" and ")}`;
}

/** A turn the server's restart cut off picks up by itself when its tool reconnects (engine/hub.ts): nothing failed. */
const RESTARTED = /^The server restarted in the middle of /;

/**
 * A run's error as what it means, in a few plain words for a line that already says who: "Rio hit an error · too many requests,
 * try again in a minute". The provider's own text stays behind a details toggle (AgentNow.error.raw).
 */
export function plainError(raw: string | undefined | null): string {
  const e = (raw ?? "").trim();
  if (!e) return "it stopped without saying why";
  if (planLimitHit(e)) return "out of usage";
  if (limitHit(e)) return "too many requests, try again in a minute";
  if (signedOut(e)) return "not signed in on its computer";
  if (/cannot find module|MODULE_NOT_FOUND|\bspawn\s+\S+\s+(?:ENOENT|EACCES)\b|command not found|didn't start|failed to start/i.test(e)) return "its tool didn't start";
  if (/\btests? (?:failed|failing)\b|\b\d+ failing\b|\bfailed tests?\b/i.test(e)) return "tests failed";
  if (/context (?:length|window)|too many tokens|prompt is too long|maximum context/i.test(e)) return "the conversation got too long for its model";
  if (/\b(?:401|403)\b|invalid (?:api )?key|unauthori[sz]ed|forbidden|permission denied/i.test(e)) return "its key or sign-in was refused";
  if (RESTARTED.test(e)) return "the server restarted mid-turn";
  // A short line of words is already plain ("The folder disconnected."); anything with a trace, a code, a status or a path isn't.
  const one = e.split(/\r?\n/).filter((l) => l.trim()).length === 1;
  const raw_ = /node:internal|\x1b\[|^\s*at\s|\(\S+:\d+:\d+\)|\S+\.(?:[cm]?[jt]sx?|py|rb|go|rs|java):\d+|\b[A-Z][A-Za-z]*(?:Error|Exception)\b|\bTraceback\b|\b(?:E[A-Z]{3,}|ERR_[A-Z_]+)\b|^\s*[{<[]|npm ERR!|^panic:|\berrno\b|\b\d{3}\b|\berror\b|fetch failed|socket hang up/im.test(e);
  if (one && !raw_ && e.length <= 90) return e.replace(/\.$/, "").replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase());
  if (/timed? ?out|ETIMEDOUT|deadline exceeded/i.test(e)) return "it timed out";
  if (/\b5\d\d\b|overloaded|internal server error|service unavailable|bad gateway/i.test(e)) return "its model's service had a problem";
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up|network|fetch failed|disconnected|connection (?:closed|lost|dropped)/i.test(e)) return "it lost its connection";
  return "something went wrong";
}

/** Whether the plain words say no more than the provider's own did ("The folder disconnected."): no details to show then. */
export const saysItAll = (raw: string | undefined | null): boolean => {
  const r = (raw ?? "").trim();
  return !!r && plainError(r).toLowerCase() === r.replace(/\.$/, "").toLowerCase();
};

/** The words for each state that doesn't name a person. */
export const PHASE_WORD: Record<Exclude<AgentPhase, "waiting" | "short">, string> = {
  needs: "Needs you",
  working: "Working",
  paused: "Paused",
  failed: "Hit an error",
  limited: "Out of usage",
  offline: "Offline",
  stopped: "Stopped",
  done: "Done",
  ready: "Ready",
};

/** The small ring a state is drawn with (presence.tsx): amber only for the people it waits on. */
export type AgentRing = "working" | "needs" | "error" | "queued" | "limited" | null;
export function phaseRing(a: Pick<AgentNow, "phase" | "needsYou">): AgentRing {
  switch (a.phase) {
    case "working":
      return "working";
    case "needs":
      return "needs";
    case "short":
      return a.needsYou ? "needs" : null;
    case "waiting":
    case "paused":
      return "queued";
    case "failed":
      return "error";
    case "limited":
      return "limited";
    default:
      return null;
  }
}

// One agent's line, its name first (agent-line.ts): kept apart so the sidebar, in every page's first load, needs none of the rest.
export { agentLine, lowerWord } from "./agent-line.js";

export interface AgentStateOpts {
  now?: number;
  /** Whether a computer is linked now: a tool that isn't attached is only offline when its computer is (attention.ts crewOf). */
  hostUp?: (hostId: string) => boolean;
  /** Out of usage, read from the log (limited.ts limitedLanes), when the caller has it: the same account's other agents included. */
  limited?: { until: number | null; via?: string } | null;
}

/**
 * The one selector: where the agent on `lane` stands, for the person `meId`. Read from the session's state alone, so the server's
 * sidebar and the page's tabs, feed and bar say the same thing (`limited` lets a page that has the log add the same account's
 * other agents).
 */
export function agentState(state: SessionState, lane: string, meId: string, o: AgentStateOpts = {}): AgentNow {
  const now = o.now ?? Date.now();
  const held = heldOn(state, lane);
  if (held) {
    const needsYou = !!meId && held.ids.includes(meId);
    return { phase: needsYou ? "needs" : "waiting", word: needsYou ? PHASE_WORD.needs : waitingWord(held), needsYou, held };
  }
  const run = runOf(state, lane);
  const base = { needsYou: false, held: null };
  if (run.status === "running") return { ...base, phase: "working", word: PHASE_WORD.working };
  if (run.status === "paused") return { ...base, phase: "paused", word: PHASE_WORD.paused };
  const engine = state.engines[lane];
  const away = !!engine?.tool && engine.online === false && !(engine.hostId && o.hostUp?.(engine.hostId));
  if (run.status === "error" && !carriedOn(state, lane) && !RESTARTED.test(run.error ?? "")) {
    const err = run.error ?? "";
    // Out of its plan's usage, still: amber and when it lifts, never the red of an error. A passing per-minute 429 is an error to try again.
    const plan = planLimitHit(err, run.sinceAt ?? now);
    const still = plan && (plan.resetsAt ? plan.resetsAt > now : now - (run.sinceAt ?? now) < 5 * 3_600_000);
    if (still) return { ...base, phase: "limited", word: PHASE_WORD.limited, until: o.limited?.until ?? plan.resetsAt };
    if (!plan) {
      const mine = !!meId && (driverOf(state, lane)?.id === meId || roleOf(state, meId) === "owner");
      const retry = mine ? { mine: true as const } : { mine: false as const, ask: stewards(state, lane).names[0] ?? "the owner" };
      return { ...base, phase: "failed", word: PHASE_WORD.failed, error: { plain: plainError(err), raw: err }, retry };
    }
  }
  if (o.limited) return { ...base, phase: "limited", word: PHASE_WORD.limited, until: o.limited.until };
  if (away) return { ...base, phase: "offline", word: PHASE_WORD.offline };
  if (state.stopped?.[lane] !== undefined) return { ...base, phase: "stopped", word: PHASE_WORD.stopped };
  const plan = state.planDone?.[lane];
  const ran = state.finished?.[lane] !== undefined;
  if (ran && plan && plan.done < plan.of) return { ...base, phase: "short", word: `Stopped at ${plan.done} of ${plan.of}`, needsYou: !!meId && steersLane(state, meId, lane) };
  if (ran) return { ...base, phase: "done", word: PHASE_WORD.done };
  return { ...base, phase: "ready", word: PHASE_WORD.ready };
}

/** The lanes a session's agents are on, the main one first. */
export const lanesOf = (state: SessionState): string[] => [MAIN_LANE, ...state.lanes.map((l) => l.id)];
