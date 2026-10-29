import { MAIN_LANE, type SessionEvent } from "../types.js";
import { runOf, type SessionState } from "../session/projection.js";
import { limitHit, signedOut } from "../limit-reset.js";

/**
 * The agent the box writes to when a room opens: `want` (the lead, or the main agent), unless that one can't work now (out of
 * usage, or not signed in) and another here can, which it then is. After a usage limit was handed to Codex, the box still opened
 * on "To Claude Code", the agent that was out (Arun, 2026-10-28: "iron everything and ensure we are good… any logic errors").
 */
export function openingTarget(state: SessionState, want: string): string {
  const stuck = (lane: string) => {
    const run = runOf(state, lane);
    return run.status === "error" && (!!limitHit(run.error) || signedOut(run.error));
  };
  if (!stuck(want)) return want;
  const lanes = [MAIN_LANE, ...state.lanes.filter((l) => l.control.kind !== "standing").map((l) => l.id)];
  const usable = (l: string) => l !== want && !stuck(l) && (!state.engines[l]?.tool || state.engines[l]!.online);
  return lanes.find((l) => usable(l) && runOf(state, l).status === "running") ?? lanes.find(usable) ?? want;
}

/**
 * Which agent the message box should be writing to, as the work moves.
 *
 * The box used to stay on whatever was picked last. Codex handed the work to Kiro, and the next message still went to Codex,
 * which had finished; an agent asked a question while the box pointed at another, and the answer went to the wrong one.
 * The box now follows the work, in the few moments where where it should go is plain from the log, and never while the
 * person is typing or has just chosen for themselves.
 */

export interface Follow {
  lane: string;
  /** Said when it moves, so a switch is never a surprise: "Writing to Kiro: it took over from Codex." */
  why: string;
}

/** How long a person's own pick of an agent outranks the box following the work. */
export const PICKED_HOLD_MS = 20_000;

export function followTarget(o: {
  target: string;
  me: string;
  state: SessionState;
  /** Events that arrived since the last look, oldest first. */
  fresh: SessionEvent[];
  /** Words are in the box: whatever is half-written was meant for where it points. */
  typing: boolean;
  /** When the person last chose an agent themselves. */
  pickedAt: number;
  now: number;
  /** Whether this person may write to that agent at all. */
  mayWrite: (lane: string) => boolean;
  name: (lane: string) => string;
}): Follow | null {
  const { target, me, state, fresh, now } = o;
  const lanes = new Set([MAIN_LANE, ...state.lanes.map((l) => l.id)]);
  const ok = (lane: string) => lane !== target && lanes.has(lane) && o.mayWrite(lane);

  // The agent being written to has gone (removed, or its tool let go): to one that is working for this person, else Main.
  if (!lanes.has(target) || (state.engines[target] === undefined && fresh.some((e) => e.body.type === "engine.detached" && e.body.reason === "released" && (e.lane ?? MAIN_LANE) === target))) {
    const working = [...lanes].find((l) => l !== target && o.mayWrite(l) && (state.laneRuns[l]?.status === "running" || (l === MAIN_LANE && state.run.status === "running")));
    const lane = working ?? MAIN_LANE;
    return lane === target ? null : { lane, why: `Writing to ${o.name(lane)}: ${o.name(target) || "the agent you were writing to"} isn't here any more.` };
  }

  if (o.typing || now - o.pickedAt < PICKED_HOLD_MS) return null;

  let move: Follow | null = null;
  for (const e of fresh) {
    const lane = e.lane ?? MAIN_LANE;
    const b = e.body;
    // The work moved: a handoff from the agent being written to, or one this person sent.
    if (b.type === "instruction" && b.handoff && (b.handoff.fromLane === target || e.actor.id === me) && ok(lane)) {
      move = { lane, why: `Writing to ${o.name(lane)}: it took over from ${b.handoff.fromName}.` };
    }
    // An agent asked this person something: the answer goes to the one that asked.
    else if (b.type === "agent.question" && b.to === me && ok(lane)) {
      move = { lane, why: `Writing to ${o.name(lane)}: it asked you something.` };
    }
    // An agent this person drives is waiting on their yes or no: what they say next is most likely to it.
    else if (b.type === "engine.approval" && ok(lane) && (lane === MAIN_LANE ? state.driver?.id : state.laneDrivers[lane]?.id) === me) {
      move = { lane, why: `Writing to ${o.name(lane)}: it's waiting on you.` };
    }
    // A coding tool ended its answer asking this person, its driver, something (its answer card is under it).
    else if (b.type === "agent.message" && state.asks[lane]?.seq === e.seq && ok(lane) && (lane === MAIN_LANE ? state.driver?.id : state.laneDrivers[lane]?.id) === me) {
      move = { lane, why: `Writing to ${o.name(lane)}: it asked you something.` };
    }
  }
  return move;
}
