import { latestPlan } from "./left-off.js";
import { runOf, type SessionState } from "./session/projection.js";
import { MAIN_LANE, type SessionEvent } from "./types.js";

/**
 * The person's goals, across everything they have going (Arun, 2026-10-31: Friday as the intelligence layer, "goals Friday
 * drives"). The engines exist: a session's goal (goal.ts, judged after every turn), a hub (hubs.ts, planned into tasks across
 * tools), a Crew room running on its own toward one (team-selfrun.ts). This reads them all into one list and says, for each,
 * whether it is on track, waiting on the person, at risk and why, or met: from the logs alone, so a restart loses nothing and
 * nothing is told twice. At risk means:
 * - overdue: its time passed;
 * - circling: its checks failed three times or more;
 * - stalled: nothing working on it and nothing moved for two hours;
 * - behind: well behind the pace its deadline needs, or due within two hours with nothing running.
 * Use cases: goals.md in the side-session notes.
 */

export type GoalKind = "goal" | "hub" | "room";
export type GoalStatus = "on-track" | "waiting" | "at-risk" | "met";
export type GoalRisk = "overdue" | "circling" | "stalled" | "behind";

export interface TrackedGoal {
  /** Stable while it is the same goal: a new goal is a new id. */
  id: string;
  kind: GoalKind;
  text: string;
  where: { sid: string; title: string; lane: string; room: boolean };
  /** Who set it: theirs to hear when it is at risk. */
  by?: string;
  since: number;
  due?: number;
  progress?: { done: number; total: number };
  /** When something last moved toward it. */
  moved: number;
  status: GoalStatus;
  risk?: GoalRisk;
  /** Why it is at risk, or what it waits on, in a line. */
  why?: string;
  /** Met: when, and the reason given. */
  met?: number;
}

/** Nothing working on it and nothing moved for this long: stalled. */
export const GOAL_STALL_MS = 2 * 3600_000;
/** Due this soon with nothing running: at risk. */
export const DUE_SOON_MS = 2 * 3600_000;
/** Checks that failed this often: going in circles. */
export const CIRCLING = 3;
/** A met goal stays in the list this long, to be seen once. */
export const MET_KEEP_MS = 24 * 3600_000;

/** What counts as moving toward a goal: a change, a finished task or turn, a check, a review. */
const MOVES = new Set(["agent.diff", "board.finished", "board.checked", "board.reviewed", "goal.checked", "hub.task.ended", "hub.merged", "run.ended"]);

const ago = (ms: number) => (ms < 3600_000 ? `${Math.max(1, Math.round(ms / 60_000))}m` : ms < 2 * 86_400_000 ? `${Math.round(ms / 3600_000)}h` : `${Math.round(ms / 86_400_000)}d`);

/** The goals in one session: its own, its hub's, and its room's run on its own. */
export function goalsIn(state: SessionState, events: readonly SessionEvent[], now = Date.now()): TrackedGoal[] {
  const out: TrackedGoal[] = [];
  const tsOf = (seq: number) => events.find((e) => e.seq === seq)?.ts ?? now;
  const room = !!state.options.team;
  const lanesOf = (lane?: string) => (lane ? [lane] : [MAIN_LANE, ...state.lanes.map((l) => l.id)]);
  const movedSince = (seq: number, lane?: string) => {
    for (let i = events.length - 1; i >= 0 && events[i]!.seq > seq; i--) {
      const e = events[i]!;
      if (MOVES.has(e.body.type) && (!lane || (e.lane ?? MAIN_LANE) === lane)) return e.ts;
    }
    return tsOf(seq);
  };
  const working = (lane?: string) => lanesOf(lane).some((l) => runOf(state, l).status === "running");
  const waitingOn = (lane?: string) => lanesOf(lane).some((l) => !!state.approvals[l] || !!state.openQuestions[l] || runOf(state, l).status === "waiting_for_human");
  const judge = (g: Omit<TrackedGoal, "status">, lane: string | undefined, extra?: { nudges?: number; lastWhy?: string }): TrackedGoal => {
    if (g.met) return { ...g, status: "met" };
    if (g.due && now > g.due) return { ...g, status: "at-risk", risk: "overdue", why: `It was due ${ago(now - g.due)} ago.` };
    if ((extra?.nudges ?? 0) >= CIRCLING) return { ...g, status: "at-risk", risk: "circling", why: `Its check failed ${extra!.nudges} times${extra?.lastWhy ? `: ${extra.lastWhy}` : "."}` };
    if (waitingOn(lane)) return { ...g, status: "waiting", why: "It waits on your answer." };
    const busy = working(lane);
    if (!busy && now - g.moved > GOAL_STALL_MS) return { ...g, status: "at-risk", risk: "stalled", why: `Nothing has moved for ${ago(now - g.moved)} and nobody is on it.` };
    if (g.due) {
      if (!busy && g.due - now < DUE_SOON_MS) return { ...g, status: "at-risk", risk: "behind", why: `It's due in ${ago(g.due - now)} and nothing is running.` };
      const p = g.progress;
      if (p && p.total > 0 && g.due > g.since) {
        const spent = (now - g.since) / (g.due - g.since);
        const done = p.done / p.total;
        if (spent > 0.5 && spent - done > 0.3) return { ...g, status: "at-risk", risk: "behind", why: `${p.done} of ${p.total} done with ${Math.round(spent * 100)}% of the time gone.` };
      }
    }
    return { ...g, status: "on-track" };
  };

  // The session's own goal (goal.ts).
  const sg = state.goal;
  if (sg) {
    const steps = latestPlan(events as never, sg.lane);
    out.push(
      judge(
        {
          id: `${state.id}~goal~${sg.seq}`,
          kind: "goal",
          text: sg.text,
          where: { sid: state.id, title: state.title, lane: sg.lane, room },
          by: sg.by.id,
          since: tsOf(sg.seq),
          ...(sg.due ? { due: sg.due } : {}),
          ...(steps.length ? { progress: { done: steps.filter((s) => s.done).length, total: steps.length } } : {}),
          moved: movedSince(sg.seq, sg.lane),
          ...(sg.met ? { met: tsOf(sg.met.seq) } : {}),
        },
        sg.lane,
        { nudges: sg.nudges, ...(sg.last && !sg.last.met ? { lastWhy: sg.last.why } : {}) },
      ),
    );
  }

  // A hub (hubs.ts): one goal planned into tasks across tools.
  const hub = state.hub;
  if (hub && hub.status !== "cancelled") {
    const planned = events.findLast((e) => e.body.type === "hub.planned" && e.body.id === hub.id);
    const runs = Object.values(hub.runs);
    const g: Omit<TrackedGoal, "status"> = {
      id: `${state.id}~hub~${hub.id}`,
      kind: "hub",
      text: hub.goal,
      where: { sid: state.id, title: state.title, lane: MAIN_LANE, room },
      ...(planned ? { by: planned.actor.id } : {}),
      since: planned?.ts ?? now,
      progress: { done: runs.filter((r) => r.status === "done" || r.status === "skipped").length, total: runs.length },
      moved: movedSince(planned?.seq ?? 0),
      ...(hub.status === "done" ? { met: events.findLast((e) => e.body.type === "hub.ended")?.ts ?? now } : {}),
    };
    out.push(hub.status === "failed" ? { ...g, status: "at-risk", risk: "stalled", why: hub.why ? `It failed: ${hub.why}` : "It failed." } : hub.status === "planned" ? { ...g, status: "waiting", why: "Its plan waits on your OK." } : judge(g, undefined));
  }

  // A room running on its own (team-selfrun.ts): the latest turn on or off.
  const run = events.findLast((e) => e.body.type === "team.selfrun");
  if (run?.body.type === "team.selfrun") {
    const on = run.body.on ? run : events.findLast((e) => e.seq < run.seq && e.body.type === "team.selfrun" && e.body.on);
    const reached = !run.body.on && /goal is reached/i.test(run.body.why ?? "");
    if (on?.body.type === "team.selfrun" && on.body.goal && (run.body.on || reached)) {
      const tasks = (state.board?.tasks ?? []).filter((t) => t.status !== "cancelled");
      out.push(
        judge(
          {
            id: `${state.id}~room~${on.seq}`,
            kind: "room",
            text: on.body.goal,
            where: { sid: state.id, title: state.title, lane: state.lead ?? state.lanes[0]?.id ?? MAIN_LANE, room },
            by: on.actor.id,
            since: on.ts,
            ...(on.body.due ? { due: on.body.due } : {}),
            ...(tasks.length ? { progress: { done: tasks.filter((t) => t.status === "done").length, total: tasks.length } } : {}),
            moved: movedSince(on.seq),
            ...(reached ? { met: run.ts } : {}),
          },
          undefined,
        ),
      );
    }
  }
  // Met long ago: told already, gone from the list.
  return out.filter((g) => g.status !== "met" || now - (g.met ?? 0) < MET_KEEP_MS);
}

/** Across sessions: at risk first, then waiting on you, then the nearest deadline, then the newest. */
export function rankGoals(goals: TrackedGoal[]): TrackedGoal[] {
  const order: Record<GoalStatus, number> = { "at-risk": 0, waiting: 1, "on-track": 2, met: 3 };
  return [...goals].sort((a, b) => order[a.status] - order[b.status] || (a.due ?? Infinity) - (b.due ?? Infinity) || b.since - a.since);
}

/** The one-tap answers for a goal at risk: carry on with the next step, or step back and re-plan. Sent to the agent on it. */
export function goalChoices(g: TrackedGoal): { label: string; value: string }[] {
  return [
    { label: "Keep going", value: `[Friday] The goal "${g.text}" is at risk: ${g.why ?? ""} Decide the next step toward it and do it now; if something is in your way, say what.` },
    { label: "Re-plan", value: `[Friday] The goal "${g.text}" is off track: ${g.why ?? ""} Re-plan it: say what's done, what's left and what's in the way, then the new plan, and start on it.` },
  ];
}
