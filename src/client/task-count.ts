import type { SessionState } from "../session/projection.js";
import { teamTasks } from "./AgentTalk.js";

/**
 * The team's tasks as the Tasks tab counts them (Workbench `badges.tasks`): done of all ("3/7"), or null when there are none. Apart
 * from TaskBoard.tsx, which loads only once the tab is shown.
 */
export function taskCount(state: SessionState): string | null {
  if (state.options.team) return null;
  const all = liveTasks(teamTasks(state, () => {}).filter((t) => !(state.board?.proposed && t.id.startsWith("b:"))));
  if (!all.length) return null;
  return `${all.filter((t) => t.status === "completed" || t.status === "cancelled").length}/${all.length}`;
}

/** The team's tasks while any is still to finish; none once every one is done or dropped, so a finished board goes (TaskBoard, the tab's count). */
export function liveTasks<T extends { status: string }>(all: T[]): T[] {
  return all.some((t) => t.status !== "completed" && t.status !== "cancelled") ? all : [];
}
