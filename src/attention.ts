import { limitHit } from "./limit-reset.js";
import { laneName } from "./session/core.js";
import { driverOf, questionsTo, requestsTo, roleOf, runOf, type SessionState } from "./session/projection.js";
import { MAIN_LANE, type EngineTool } from "./types.js";

/**
 * What is waiting on one person, across the sessions they are in.
 *
 * A session that needs a human says so in its own feed, which works while
 * somebody is looking at that session and not at all otherwise. An agent can
 * sit blocked on a decision for an hour because the one person who could
 * answer is in a different room — and in a product whose whole premise is
 * several rooms at once, that is the normal case rather than the edge.
 *
 * So the question is asked the other way round: not "what is happening here"
 * but "where am I the thing that is missing".
 */

/** `ask`: a coding tool ended its turn asking something (ask-parse.ts), where Friday's own agents raise a `question`. */
export type AttentionKind = "approval" | "question" | "ask" | "control" | "handover" | "stopped" | "mention";

export interface Attention {
  sid: string;
  title: string;
  kind: AttentionKind;
  /** One line, already written for the person it is about. */
  text: string;
  /** Which event started it waiting, so the list can be ordered and deduped. */
  seq: number;
  /** The one agent that is waiting, when it is one, and its name as the session shows it. */
  lane?: string;
  agent?: string;
  /** A permission request's id, so it can be answered from the list without opening the session. */
  approval?: string;
  /** What the approval is for: a command to run says "Run it", anything else "Let it", as the card in the session does. */
  command?: boolean;
}

/**
 * Everything in this session waiting on you, worst first: one line per agent, since each blocked agent is its own wait.
 *
 * The order is how much it is blocked on you. A permission request or a question stops the agent dead; a control request
 * only slows somebody down; a stopped run has already happened. A permission request is yours when you drive that agent,
 * or when nobody does and the session is yours: the people who could answer it, without telling every editor about every
 * command.
 */
export function attentionIn(state: SessionState, meId: string): Attention[] {
  const of = (kind: AttentionKind, text: string, seq: number, lane?: string): Attention => ({
    sid: state.id,
    title: state.title,
    kind,
    text,
    seq,
    ...(lane ? { lane, agent: agentName(state, lane) } : {}),
  });
  const out: Attention[] = [];

  // Asked you by name, one line per agent that asked. Nothing moves until it is answered.
  for (const q of questionsTo(state, meId)) out.push(of("question", q.question, q.seq, q.lane));

  // Handed to you for when you are next here: the session is yours to drive once you open it.
  if (state.handover?.to === meId && !state.handover.taken) out.push(of("handover", `${state.handover.from.name} handed this to you${state.handover.note ? `: ${state.handover.note}` : ""}`, state.handover.seq));

  // Somebody wants a wheel you are holding. Their work is waiting on an answer
  // only you can give: asks for the agents you drive, not for anybody's.
  const asks = requestsTo(state, meId);
  if (asks.length) {
    const first = asks[0]!;
    const more = asks.length - 1;
    out.push(of("control", more ? `${first.name} and ${more} other${more === 1 ? "" : "s"} want control` : `${first.name} wants control`, first.seq));
  }

  for (const lane of [MAIN_LANE, ...state.lanes.map((l) => l.id)]) {
    const driver = driverOf(state, lane);
    // A coding tool asking before it runs something: it sits there until somebody says yes or no.
    const ask = state.approvals[lane];
    if (ask && (driver ? driver.id === meId : roleOf(state, meId) === "owner")) {
      const first = ask.items[0] ? `\`${ask.items[0].length > 80 ? `${ask.items[0].slice(0, 79)}…` : ask.items[0]}\`` : "";
      const more = ask.items.length > 1 ? ` and ${ask.items.length - 1} more` : "";
      const text = ask.scope === "commands" && first ? `${agentName(state, lane)} wants to run ${first}${more}` : `${agentName(state, lane)} is asking before it goes on`;
      out.push({ ...of("approval", text, ask.seq, lane), approval: ask.id, ...(ask.scope === "commands" ? { command: true } : {}) });
      continue;
    }
    const run = runOf(state, lane);
    // A coding tool that finished its turn on a question: it does nothing more until somebody answers. Whose it is, is the
    // permission request's rule: the lane's driver, or the owner when nobody drives it.
    const asked = state.asks[lane];
    if (asked && run.status !== "running" && (driver ? driver.id === meId : roleOf(state, meId) === "owner")) {
      const more = asked.questions.length - 1;
      out.push(of("ask", `${asked.questions[0]!.question}${more ? ` (and ${more} more)` : ""}`, asked.seq, lane));
      continue;
    }
    // It stopped, and you are the one who can restart it. Not a coding tool out on its usage limit: Friday hands its task to
    // another agent and it carries on when the limit lifts, and its tab says so; a card nagging about it sat for an hour on
    // Arun's screen (2026-10-25: "can you get rid of this for me").
    if (run.status === "error" && driver?.id === meId && !limitHit(run.error)) out.push(of("stopped", run.error || "The run stopped.", run.sinceSeq, lane));
  }

  // A message from another session waiting for someone who can steer its agent to let it through: it sat there unseen.
  for (const h of state.peersHeld ?? []) {
    const driver = driverOf(state, h.lane);
    if (driver ? driver.id === meId : roleOf(state, meId) === "owner") out.push(of("ask", `${h.fromName} in "${h.fromTitle}" sent a message: let it through or turn it down`, h.seq, h.lane));
  }

  // Somebody said your name: it waits until you say or do anything in the session (projection clears it).
  const named = state.mentions?.[meId];
  if (named) out.push(of("mention", `${named.byName}: ${named.text}`, named.seq, named.lane === MAIN_LANE ? undefined : named.lane));
  return sortAttention(out);
}

/** The worst thing in this session waiting on you, or null: one line per session, where a list of sessions is what is shown. */
export function attentionFor(state: SessionState, meId: string): Attention | null {
  return attentionIn(state, meId)[0] ?? null;
}

/** "Claude Code", "Reviewer", or Friday's own agent: the lane tabs say "Main", which means nothing outside the session. */
function agentName(state: SessionState, lane: string): string {
  const name = laneName(state, lane);
  return lane === MAIN_LANE && name === "Main" ? "Friday Code" : name;
}

/** Newest first: what just started waiting is what somebody is standing next to. */
export function sortAttention(items: Attention[]): Attention[] {
  const rank: Record<AttentionKind, number> = { approval: 0, question: 0, ask: 0, handover: 1, control: 1, mention: 1, stopped: 2 };
  return [...items].sort((a, b) => rank[a.kind] - rank[b.kind] || b.seq - a.seq);
}

/**
 * Whether a session is working right now, and on what.
 *
 * "Which of these is actually doing something" is a question the sidebar
 * could not answer at all: every session looked the same whether an agent
 * had been running in it for ten minutes or nobody had touched it since
 * Tuesday. The log already knows — a run is running or it is not — and the
 * attention poll already reads every recent session's state to ask a
 * different question, so this costs nothing extra.
 */
export interface Working {
  sid: string;
  /** How many lanes are going, so several agents at once reads as several. */
  lanes: number;
  /** One of them, for the tooltip: an agent's lane, or the main one. */
  what: string;
  /** The coding tool the first of them runs on, for its mark beside its name; none for Friday Code. */
  tool?: EngineTool;
}

export function workingIn(state: SessionState): Working | null {
  const live: string[] = [];
  let tool: EngineTool | undefined;
  const add = (lane: string, name: string) => {
    if (!live.length) tool = state.engines[lane]?.tool;
    live.push(name);
  };
  if (state.run.status === "running") add(MAIN_LANE, "Main");
  for (const [id, run] of Object.entries(state.laneRuns)) {
    if (run.status !== "running") continue;
    add(id, state.lanes.find((l) => l.id === id)?.name ?? "a lane");
  }
  if (!live.length) return null;
  return { sid: state.id, lanes: live.length, what: live.join(", "), ...(tool ? { tool } : {}) };
}

/**
 * Who works in a session and where each stands, for its row in the sidebar (Arun, 2026-10-24: "instead of the secondary text like
 * the most recent message maybe we add the agent status and stuff with their icons"): each agent's name, the coding tool it runs
 * on and its state in a word, read off the state the attention poll has already read, so it costs nothing extra.
 */
export type CrewState = "needs" | "working" | "failed" | "offline" | "done" | "idle";
export interface Crew {
  sid: string;
  agents: { lane: string; name: string; tool?: EngineTool; state: CrewState }[];
}
/** The most agents a row shows. */
const CREW_MAX = 6;

export function crewOf(state: SessionState): Crew | null {
  const lanes = [MAIN_LANE, ...state.lanes.filter((l) => l.control.kind !== "standing").map((l) => l.id)];
  // The main lane counts once something is in it: a coding tool attached, or a run that has gone; a session of coding tools
  // alone has an empty main lane that is no one.
  const used = (lane: string) => lane !== MAIN_LANE || !!state.engines[MAIN_LANE] || !!state.finished?.[MAIN_LANE] || state.run.status !== "idle" || state.lanes.length === 0;
  const agents = lanes.filter(used).map((lane) => {
    const engine = state.engines[lane];
    const run = runOf(state, lane);
    const ran = !!state.finished?.[lane];
    const st: CrewState = state.openQuestions[lane] || state.approvals?.[lane] || run.status === "waiting_for_human" ? "needs" : run.status === "running" ? "working" : run.status === "error" ? "failed" : engine?.tool && !engine.online ? "offline" : ran ? "done" : "idle";
    return { lane, name: laneName(state, lane), ...(engine?.tool ? { tool: engine.tool } : {}), state: st };
  });
  return agents.length ? { sid: state.id, agents: agents.slice(0, CREW_MAX) } : null;
}

/**
 * What a session is about, in a line, for a list of them.
 *
 * A list of titles only tells you what you called each one, which is rarely
 * what you are trying to remember when you look for it — that is what was
 * last asked. The projection already keeps that as the session's current
 * intent, so this is a read of something known, not a new thing to track.
 */
export interface Preview {
  sid: string;
  text: string;
  /** Who said it, so a room with several people reads as one. */
  by: string;
}

/** The session's pull request, for the sidebar to settle the session once it merges (sidebar-buckets.ts). */
export interface SessionPr {
  sid: string;
  url: string;
  merged: boolean;
}

export function prOf(state: SessionState): SessionPr | null {
  return state.pr ? { sid: state.id, url: state.pr.url, merged: !!state.pr.merged } : null;
}

export function previewOf(state: SessionState): Preview | null {
  const last = state.lastInstruction;
  const text = last?.text.replace(/\s+/g, " ").trim();
  if (!last || !text) return null;
  return { sid: state.id, text: text.slice(0, 160), by: last.by };
}
