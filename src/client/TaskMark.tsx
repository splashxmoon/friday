import { CheckIcon, CircleDashedIcon, OctagonAlertIcon, SearchCheckIcon } from "lucide-react";

/** Where a task stands, as the task board marks it. */
export type TaskMarkState = "open" | "working" | "review" | "done" | "blocked";

/**
 * A task's mark as the agents' task board draws it (AgentTalk BoardCard): a faint dashed circle while it waits, a turning ring
 * while it is being done, a check once it is. Team tasks and the Tasks panel use it too, so a task looks the same wherever it
 * is listed (Arun, 2026-10-23: "have this team tasks circle thing be like the task board circle thing", "do the same for the
 * tasks side panel circle things too").
 */
export function TaskMark({ state }: { state: TaskMarkState }) {
  if (state === "done") return <CheckIcon className="size-3.5 shrink-0 text-[var(--agent)]" aria-hidden="true" />;
  if (state === "working") return <span className="ring-spin" aria-hidden="true" />;
  if (state === "review") return <SearchCheckIcon className="size-3.5 shrink-0" aria-hidden="true" />;
  if (state === "blocked") return <OctagonAlertIcon className="size-3.5 shrink-0 text-[var(--red)]" aria-hidden="true" />;
  return <CircleDashedIcon className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />;
}
