import { limitHit } from "./limit-reset.js";
import type { SessionState } from "./session/projection.js";
import { MAIN_LANE, type SessionEvent } from "./types.js";

/**
 * Which agents are out of usage now, read from how their runs ended: for the server's routing and hand-offs (limit-handoff.ts,
 * agent-mesh.ts) and for the page's agent tabs alike (agents-hub.ts), so both say the same agent is out until the same time.
 */

/** Its latest run ended on a usage limit that hasn't lifted yet (or said no time, within the last five hours). */
export function stillLimited(events: SessionEvent[], lane: string, now = Date.now()): boolean {
  return !!ownLimit(events, lane, now);
}

/** The lane's own latest run's usage limit, still in force: when it lifts (null when it didn't say) and when it was hit. */
function ownLimit(events: SessionEvent[], lane: string, now: number): { until: number | null; at: number } | null {
  const end = events.findLast((e) => e.body.type === "run.ended" && (e.lane ?? MAIN_LANE) === lane);
  if (end?.body.type !== "run.ended" || end.body.outcome !== "error") return null;
  const hit = limitHit(end.body.error, end.ts);
  if (!hit || !(hit.resetsAt ? hit.resetsAt > now : now - end.ts < 5 * 3_600_000)) return null;
  return { until: hit.resetsAt, at: end.ts };
}

/** Out of usage now: the lane, when it comes back (null when nobody said), and the agent whose run hit it when that wasn't this one. */
export interface Limited {
  until: number | null;
  via?: string;
}

/**
 * Every agent out of usage right now. One whose own last run hit a limit, and each other agent of the same tool on the same
 * computer and sign-in, whose next run would hit the same limit: two Claude Codes on one account ran out a few seconds apart in a
 * real session (Arun, 2026-10-25: "maximum performance smart routing of tasks to other agents when usage limit hits"). One of
 * those that has finished a run since the hit is working again, and isn't counted.
 */
export function limitedLanes(state: SessionState, events: SessionEvent[], now = Date.now()): Map<string, Limited> {
  const lanes = [MAIN_LANE, ...state.lanes.map((l) => l.id)];
  const out = new Map<string, Limited>();
  const own = new Map<string, { until: number | null; at: number }>();
  for (const l of lanes) {
    const hit = ownLimit(events, l, now);
    if (hit) {
      own.set(l, hit);
      out.set(l, { until: hit.until });
    }
  }
  const signIn = (l: string) => {
    const e = state.engines[l];
    return e?.tool ? `${e.tool}|${e.hostId}|${e.account?.id ?? ""}` : null;
  };
  for (const [from, hit] of own) {
    const key = signIn(from);
    if (!key) continue;
    for (const l of lanes) {
      if (out.has(l) || signIn(l) !== key) continue;
      if (events.some((e) => e.ts > hit.at && e.body.type === "run.ended" && e.body.outcome === "done" && (e.lane ?? MAIN_LANE) === l)) continue;
      out.set(l, { until: hit.until, via: from });
    }
  }
  return out;
}
