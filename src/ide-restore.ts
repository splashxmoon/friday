import type { SessionState } from "./session/projection.js";
import { MAIN_LANE } from "./types.js";

/**
 * Session restore (Arun, 2026-11-19, wave 4: "quit Friday mid-work and come back exactly where you were: the folder, open files and
 * layout, the chat tabs, scroll positions, and agents that were running").
 *
 * Whether a task's coding tool was cut off by Friday closing and is not at work again, read from the session itself: its run ended
 * "cut" by a restart (the engine hub's reap writes "...lost its connection when the server restarted", or the turn itself said "The
 * server restarted in the middle of"), an error on the run that is not the work failing.
 *
 * Most tools never get here: Friday brings back the lanes a computer held, in the background, and a turn cut off by the close is
 * given to the tool again (reattach.ts, engine/hub.ts), so the run carries on by itself. This is for the ones that don't: a tool
 * that won't start now, a folder moved, more lanes than a launch brings back. A run that still says "running" is not offered: it is
 * either carrying on or about to be ended as cut, and one of those is what this reads.
 */
export interface CutOff {
  lane: string;
  /** The seq of the run's end, which is the run: "Leave it" is remembered for it and not for the next one. */
  sinceSeq: number;
  since: number;
  /** How many of its messages are back in its queue: a turn the close cut is given to the tool again by itself, so Carry on only brings it back. */
  queued: number;
}

// Only the two words a restart writes (hub.ts reap and the "shutdown" drop). A Wi-Fi drop, a sleeping laptop or a tool that died
// says "disconnected", which is not Friday closing, and those reconnect by themselves. (Review, 2026-11-19.)
const CUT_ERROR = /lost its connection when the server restarted|server restarted in the middle of/i;
/** A cut older than the time a computer's lanes are brought back for (reattach.ts, 7 days) is not "when Friday closed" any more. */
const CUT_WINDOW = 7 * 24 * 3600 * 1000;

export function cutOff(st: SessionState | null): CutOff | null {
  if (!st) return null;
  const lanes: [string, { status: string; sinceSeq: number; sinceAt?: number; error?: string }][] = [[MAIN_LANE, st.run], ...Object.entries(st.laneRuns ?? {})];
  for (const [lane, r] of lanes) {
    if (!r || r.status !== "error" || !CUT_ERROR.test(r.error ?? "")) continue;
    if (r.sinceAt && Date.now() - r.sinceAt > CUT_WINDOW) continue;
    const queued = (lane === MAIN_LANE ? st.pendingInstructions : st.lanePending?.[lane] ?? []).length;
    return { lane, sinceSeq: r.sinceSeq, since: r.sinceAt ?? 0, queued };
  }
  return null;
}

/** The words Carry on sends the tool: it was cut off mid-turn, so an edit may be half made. */
export const CARRY_ON_TEXT =
  "Friday was closed while you were working, so you were cut off mid-turn and an edit may be half made. Look at the files you were changing (git status and git diff), then carry on with what you were doing and finish it.";
