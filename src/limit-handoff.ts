import { ownPlan, taskOwner } from "./own-plan.js";
import { limitHit } from "./limit-reset.js";
import { limitedLanes, stillLimited } from "./limited.js";
import { laneName } from "./session/core.js";
import { driverOf, laneOf, runOf, type SessionState } from "./session/projection.js";
import { engineName, liveMachine, MAIN_LANE, type EventBody, type SessionEvent } from "./types.js";

/**
 * A coding tool out of usage hands its task on by itself (Arun, 2026-10-20: "look into auto hand off if a coding tool hits its
 * limit, make it smart"). Its run ends on the limit mid-task; until now the session showed a card and waited for a person to
 * pick who carries on. Now Friday picks, from who could do it right now:
 *
 * - never the same tool, on this computer or anyone's: carrying on the same tool on another sign-in is getting round its usage
 *   limit, which its maker's terms don't allow (Arun, 2026-10-27: "i do not want my account banned"), and switching to another
 *   account of one's own is the person's choice, not Friday's (runner/accounts.ts);
 * - never a coding tool on someone else's own plan: it takes its host's work alone (own-plan.ts), so this person's task can't
 *   go to a teammate's Claude Code or Codex. A tool on an API key its host shares, or Friday Code, can take it;
 * - never one that is itself out of usage until later, one that is offline, one that runs on its own triggers, or one that wakes
 *   by itself when this one finishes (it is already the next step);
 * - only one working on the same code: a coding tool in the same folder, a copy of it or the same repo, or Friday Code with a
 *   machine to work in;
 * - a free one before a busy one (a busy one takes it after what it is doing), and another coding tool, which runs on its own
 *   subscription, before Friday Code, which spends the workspace's.
 *
 * The hand-off carries the whole record (handoffBrief), so it carries on rather than starting over. Whoever started the run
 * decides who the work may go to, as for any hand-off. With nobody to take it and a time the limit lifts, the agent is set to
 * carry on by itself then, as that person; with neither, the card is left for a person, as before.
 */

/** Who should carry on the limited run on `lane`, best first, each with why. */
export function limitTargets(state: SessionState, events: SessionEvent[], lane: string, now = Date.now()): { id: string; why: string }[] {
  const from = state.engines[lane];
  if (!from?.tool) return [];
  // Whose work this is: the person the limited lane was working for (its host's, on a plan of its own).
  const owner = taskOwner(events, lane, Number.MAX_SAFE_INTEGER) ?? from.hostId;
  const rootOf = (e: { cwd: string; copyOf?: string; root?: string }) => e.copyOf ?? e.root ?? e.cwd;
  const limited = limitedLanes(state, events, now);
  const out: { id: string; why: string; score: number }[] = [];
  for (const id of [MAIN_LANE, ...state.lanes.map((l) => l.id)]) {
    if (id === lane) continue;
    const def = laneOf(state, id);
    if (def?.control.kind === "standing") continue;
    const t = def?.trigger;
    if (t?.kind === "lane-finished" && (!t.laneId || t.laneId === lane)) continue;
    const e = state.engines[id];
    if (e?.tool) {
      if (!e.online) continue;
      if (e.tool === from.tool) continue;
      if (ownPlan(e) && e.hostId !== owner) continue;
      if (!(rootOf(e) === rootOf(from) || (!!e.repo && e.repo === from.repo))) continue;
    } else if (!liveMachine(state, id)) continue;
    if (limited.has(id)) continue;
    const busy = runOf(state, id).status !== "idle";
    const score = (busy ? 0 : 4) + (e?.tool ? 2 : 1);
    const name = e?.tool ? engineName(e.tool) : laneName(state, id);
    const why = `${name} ${busy ? "takes it after what it is doing" : "is free"}`;
    out.push({ id, why, score });
  }
  return out.sort((a, b) => b.score - a.score).map(({ id, why }) => ({ id, why }));
}

export { limitedLanes, stillLimited, type Limited } from "./limited.js";

/**
 * What an agent back from its usage limit is told with its first turn after it: that it was out, and what of its work went to
 * other agents meanwhile and how far they got, so it doesn't pick up and redo a task someone else already finished. Its own
 * conversation still ends where it stopped, mid-task (Arun, 2026-10-25). Empty when its last run didn't end on a limit, or the
 * limit hasn't lifted.
 */
export function backNote(state: SessionState, events: SessionEvent[], lane: string, now = Date.now()): string {
  const end = events.findLast((e) => e.body.type === "run.ended" && (e.lane ?? MAIN_LANE) === lane);
  if (end?.body.type !== "run.ended" || end.body.outcome !== "error" || !limitHit(end.body.error, end.ts)) return "";
  if (stillLimited(events, lane, now) || events.some((e) => e.seq > end.seq && e.body.type === "run.started" && (e.lane ?? MAIN_LANE) === lane)) return "";
  const moved = events.filter((e) => e.seq > end.seq && e.body.type === "instruction" && (e.body.handoff?.fromLane === lane || e.body.mesh?.carriedFrom === lane));
  const rows = moved.map((e) => {
    const b = e.body as Extract<EventBody, { type: "instruction" }>;
    const to = e.lane ?? MAIN_LANE;
    const task = (b.mesh ? (/\nThe task:\n([^\n]+)/.exec(b.text)?.[1] ?? b.text) : b.text).trim().replace(/\s+/g, " ").slice(0, 160);
    const done = events.some((x) => x.seq > e.seq && x.body.type === "run.ended" && x.body.outcome === "done" && (x.lane ?? MAIN_LANE) === to);
    return `- ${laneName(state, to)} took over "${task}"${done ? " and has finished a turn on it since" : " and is on it"}.`;
  });
  const ago = Math.max(1, Math.round((now - end.ts) / 60_000));
  const when = ago < 90 ? `${ago} minute${ago === 1 ? "" : "s"} ago` : `about ${Math.round(ago / 60)} hours ago`;
  return `[Friday] You ran out of usage ${when}, partway through what you were doing; your limit has lifted, so you're working again.${
    rows.length ? ` While you were out, Friday handed on what you were in the middle of. Don't redo it or pick it back up unless you're asked to:\n${rows.join("\n")}` : ""
  }`;
}

/** What the limited run was asked to do: its instructions, in order, as the next agent's task. */
export function limitedTask(events: SessionEvent[], lane: string, startSeq: number, endSeq: number): string {
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const asked: string[] = [];
  for (const e of events) {
    if (e.seq < startSeq || e.seq > endSeq || (e.lane ?? MAIN_LANE) !== lane || e.body.type !== "instructions.delivered") continue;
    for (const q of e.body.seqs) {
      const i = bySeq.get(q);
      // Friday's own nudges to keep going are not the task; the task is what they kept it going on.
      if (i?.body.type !== "instruction" || i.body.keepGoing || i.body.approval) continue;
      asked.push(i.actor.kind === "human" ? `${i.actor.name}: ${i.body.text}` : i.body.text);
    }
  }
  return asked.join("\n\n").trim().slice(0, 7000);
}

/** The person behind the run on `lane`: who asked for it, else whoever steers the lane. Who a hand-off or a resume acts for. */
export function personBehind(state: SessionState, events: SessionEvent[], lane: string, startSeq: number): { id: string; name: string } | null {
  const started = events.find((e) => e.seq === startSeq);
  const cause = started?.body.type === "run.started" ? events.find((e) => e.seq === (started.body as { causedBy: number }).causedBy) : undefined;
  if (cause?.body.type === "instruction" && cause.actor.kind === "human") return { id: cause.actor.id, name: cause.actor.name };
  return driverOf(state, lane);
}
