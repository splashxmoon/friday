import { announcesAction } from "./agent/announced.js";
import { heldByPerson } from "./held.js";
import { runOf, type SessionState } from "./session/projection.js";
import { MAIN_LANE, type SessionEvent } from "./types.js";

/**
 * Agents keep working until their task is done (Arun, 2026-10-20: "make sure the coding tools keep working until their task and
 * the goal they have is completed, like they need to keep going and working and stuff unless they are fully finished"). A turn
 * that ends with its own plan still open, on "Next I'll…" with nothing after it, or with a board task it never finished, is not
 * the end of the work: Friday tells the agent to carry on, a few times a run at most, and the run goes on. Friday Code does the
 * same in its own loop (runtime.ts); this is the coding tools' side (engine/hub.ts).
 */

/** Times one run of a coding tool is told to carry on before its turn's end is taken as the end. */
export const MAX_KEEP_GOING = 5;

/**
 * Steps the agent gave itself and hasn't finished.
 *
 * The newest plan on this lane since the run began — an older run's leftovers
 * are history, and another lane's plan is somebody else's work. Counting from
 * the log rather than from memory means a plan the agent revised three times
 * is read as it last left it.
 */
export function unfinishedPlan(events: SessionEvent[], lane: string, sinceSeq: number): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.seq <= sinceSeq) break;
    if ((e.lane ?? MAIN_LANE) !== lane || e.body.type !== "agent.message") continue;
    for (const c of [...e.body.toolCalls].reverse()) {
      if (c.name !== "update_plan" && c.name !== "todo") continue;
      let raw: unknown;
      try {
        raw = JSON.parse(c.arguments || "{}");
      } catch {
        continue;
      }
      const o = (raw ?? {}) as { steps?: unknown; todos?: unknown };
      const list = Array.isArray(o.steps) ? o.steps : Array.isArray(o.todos) ? o.todos : [];
      if (!list.length) continue;
      return list.filter((x) => {
        const st = String((x as { status?: unknown })?.status ?? "pending");
        return st !== "completed" && st !== "done" && st !== "cancelled";
      }).length;
    }
  }
  return 0;
}

/** How the agents stay in touch while they work, said with every nudge to carry on. */
export const CHECK_IN =
  "Between steps, call the friday check_messages tool for anything the other agents sent you, and post_update a line when you finish a piece (what is done, what is next) so the others and the people watching know where you are.";

/**
 * What to tell the coding tool on `lane` to make it carry on, or null when its turn's end is the end: the work looks finished,
 * it is waiting on a person, it is only planning, or it has been told enough times this run.
 */
export function keepGoingNote(state: SessionState, events: SessionEvent[], lane: string): string | null {
  const run = runOf(state, lane);
  if (run.status !== "running") return null;
  // Waiting on a person: a decision it asked for, a question, a command to approve. Theirs to answer, not Friday's.
  if (state.asks[lane] || state.openQuestions[lane] || state.approvals[lane]) return null;
  // Plan mode stops after the plan on purpose, and so does a run whose plan the driver is to approve first.
  if (state.engines[lane]?.mode === "plan") return null;
  if (state.options.planFirst && !((state.planApproved[lane] ?? 0) > run.sinceSeq)) return null;
  // Told to stop, or holding as told: the person's word, not Friday's, sends it on (held.ts).
  if (heldByPerson(events, lane)) return null;
  const inRun = events.filter((e) => e.seq > run.sinceSeq && (e.lane ?? MAIN_LANE) === lane);
  if (inRun.filter((e) => e.body.type === "instruction" && e.body.keepGoing).length >= MAX_KEEP_GOING) return null;
  const said = inRun.findLast((e) => e.body.type === "agent.message" && !!e.body.text.trim());
  const text = said?.body.type === "agent.message" ? said.body.text.trim() : "";
  // Ended on a question: it is asking someone, and the answer is what it needs to go on.
  if (text.endsWith("?")) return null;
  const why: string[] = [];
  const left = unfinishedPlan(events, lane, run.sinceSeq);
  if (left) why.push(`your plan still has ${left} step${left === 1 ? "" : "s"} open`);
  else if (announcesAction(text)) why.push("you said what you would do next, but the turn ended before you did it");
  const task = state.board?.tasks.find((t) => t.status === "claimed" && t.lane === lane && inRun.some((e) => e.body.type === "board.claimed" && e.body.id === t.id));
  if (task) why.push(`the board task "${task.title}" isn't finished (finish_task says it is done, or blocked)`);
  if (!why.length) return null;
  return [
    `Keep going: ${why.join("; ")}. Nobody asked you to stop, so carry on with the next step now, and keep working until the task you were given is fully done.`,
    // Only with someone to keep in touch with.
    ...(state.lanes.length ? [CHECK_IN] : []),
    "If a step can't be done, say why and mark it cancelled. If the work really is finished, mark every step completed (and finish_task any board task), then end with your summary.",
  ].join(" ");
}
