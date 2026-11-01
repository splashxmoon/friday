import type { RunBudget } from "./team-budget.js";
import { MAIN_LANE, type SessionEvent } from "./types.js";

/**
 * A room that runs on its own (Arun, 2026-10-31: "a rule or mode that is full access for crew that basically runs and self
 * sustains it selfs for the teammates in a room… everything is running all the time and working and making decisions and
 * achieving a goal as a team"). On, its teammates work at full access toward the room's goal without asking anyone: their
 * questions go to the lead or are decided, their approvals are given, and whenever the room goes quiet Friday hands the lead the
 * goal again to pick the next step. It ends when the lead says the goal is reached, when the room stops getting anywhere, or when
 * a person turns it off. Away mode is for the person; this is for a room, for as long as its goal takes.
 */

export interface SelfRun {
  /** What the room works toward, in the person's words. */
  goal: string;
  since: number;
  by: { id: string; name: string };
  /** Its budget and end time (team-budget.ts): it stops when either is reached. Absent on a run from before budgets. */
  budget?: RunBudget;
}

/** Nudges in a row that got the room nowhere (nothing changed, no task moved) before it stops by itself. */
export const STALL_NUDGES = 3;
/** How long the room is quiet before the lead is nudged, and the least time between two nudges. */
export const QUIET_MS = 45_000;
export const NUDGE_GAP_MS = 3 * 60_000;

/** What leads every turn in the room while it runs on its own: short, and the rules that matter. */
export function selfRunNote(goal: string, lead: boolean): string {
  return [
    `[Friday] This room runs on its own toward its goal: "${goal}". Nobody is watching to answer you, and you have full access.`,
    lead
      ? "You lead it: keep the board full of the next most valuable tasks, hand them out, check what comes back, and decide every open question yourself. When the goal is fully met and checked, say so on a line of its own starting with GOAL REACHED, then a short summary of what was done."
      : "Decide for yourself; when it is the team's call, ask your lead with ask_agent and carry on with what you can meanwhile. When your task is done, say so and pick up the next one.",
    'Note every assumption with write_note under a key starting "assumption". Never push to a default branch, deploy, delete data or spend money: leave those for a person, say so, and do the rest.',
  ].join(" ");
}

/** Friday's word to the lead when the room has gone quiet: the goal again, where the board stands, and what to do now. */
export function selfRunNudge(goal: string, board: string): string {
  return [
    `[Friday] The room has gone quiet, and it runs on its own toward: "${goal}".`,
    board ? `The board: ${board}.` : "Nothing is on the board.",
    "Decide the next most valuable step toward the goal and get the team on it (post_tasks, assign_task, or do it yourself). If the goal is fully met and checked, say GOAL REACHED on a line of its own and summarise what was done.",
  ].join(" ");
}

/** Friday's one answer to a teammate whose turn ended on a question while the room runs on its own. */
export function selfRunAnswer(lead: boolean): string {
  return lead
    ? '[Friday] Nobody will answer that: this room runs on its own. Decide it yourself (the safest reasonable option that moves the goal forward), note it with write_note under a key starting "assumption", and carry on.'
    : '[Friday] Nobody will answer that: this room runs on its own. Ask your lead with ask_agent if it is the team\'s call, otherwise decide it yourself, note it with write_note under a key starting "assumption", and carry on.';
}

/** The lead saying the goal is met: a line of its own starting GOAL REACHED. */
export const saysGoalReached = (text: string) => /^\s*(?:[*_#>\s-]*)GOAL REACHED\b/m.test(text);

/**
 * Whether anything moved in a room after `seq`: files changed, a task finished, checked or reviewed. Not a task posted or claimed:
 * a lead that only re-plans when nudged never stalled, and every nudge was another turn (2026-10-31: usage).
 */
export function movedSince(events: SessionEvent[], seq: number): boolean {
  for (let i = events.length - 1; i >= 0 && events[i]!.seq > seq; i--) {
    const t = events[i]!.body.type;
    if (t === "agent.diff" || t === "board.finished" || t === "board.checked" || t === "board.reviewed" || t === "folder.applied") return true;
  }
  return false;
}

/** The lead's last words in a room after `seq`, if any. */
export function leadSaid(events: SessionEvent[], lead: string, after: number): string {
  for (let i = events.length - 1; i >= 0 && events[i]!.seq > after; i--) {
    const e = events[i]!;
    if ((e.lane ?? MAIN_LANE) === lead && e.body.type === "agent.message" && e.body.text.trim()) return e.body.text;
  }
  return "";
}
