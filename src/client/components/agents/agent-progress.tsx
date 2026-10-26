import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Agent Progress — a multi-step plan, while the agent works through it.
 *
 * One block that answers the question people actually have while an agent
 * runs: how much of this is left. Done steps are struck through and get out of
 * the way, the step being worked on is the only one that looks live, and what
 * hasn't started yet is visible but quiet — so the shape of the remaining work
 * is readable at a glance rather than by counting.
 *
 * It holds its own minimised state, which survives the plan changing
 * underneath it: an agent that rewrites its list nine times shouldn't reopen a
 * block somebody deliberately folded away.
 *
 * (boardui's own `agent-progress` is a Pro component and needs a licence key;
 * this is the same design, built on our tokens.)
 */

export type ProgressStatus = "completed" | "active" | "pending" | "cancelled";

export interface ProgressStep {
  id: string;
  title: string;
  status: ProgressStatus;
}

/** The ring on the header and the active step: one turn, shared timing. */
function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg className="ap-ring" width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.6" opacity="0.2" />
      <path d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function Mark({ status }: { status: ProgressStatus }) {
  if (status === "completed")
    return (
      <svg className="ap-mark done" width={14} height={14} viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r="7" fill="currentColor" opacity="0.18" />
        <path d="m4.8 8.2 2.2 2.2 4.2-4.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (status === "cancelled")
    return (
      <svg className="ap-mark skipped" width={14} height={14} viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.5" />
        <path d="M5.4 8h5.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  if (status === "active") return <Spinner />;
  // Not started: dotted, so it reads as an outline of work rather than a thing
  // that has failed to happen.
  return (
    <svg className="ap-mark todo" width={14} height={14} viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2 2.2" />
    </svg>
  );
}

/** "3 steps left", or what to say when there is nothing left to do. */
export function progressLabel(steps: ProgressStep[]): string {
  const left = steps.filter((s) => s.status === "pending" || s.status === "active").length;
  if (!steps.length) return "No steps yet";
  if (!left) return `Done · ${steps.length} step${steps.length === 1 ? "" : "s"}`;
  return `${left} step${left === 1 ? "" : "s"} left`;
}

export function AgentProgress({
  steps,
  title,
  className,
  defaultMinimized = false,
}: {
  steps: ProgressStep[];
  /** Replaces "N steps left" in the header, when something better is known. */
  title?: string;
  className?: string;
  defaultMinimized?: boolean;
}) {
  const [minimized, setMinimized] = useState(defaultMinimized);
  const done = steps.filter((s) => s.status === "completed").length;
  const left = steps.filter((s) => s.status === "pending" || s.status === "active").length;
  const finished = steps.length > 0 && left === 0;
  // Steps arriving later are the ones worth animating in; the first render is
  // a list that was already there, and staggering it just delays reading it.
  const seen = useRef(0);
  const introFrom = seen.current;
  useEffect(() => {
    seen.current = steps.length;
  }, [steps.length]);

  return (
    <div className={cn("ap", finished && "ap-finished", className)} role="group" aria-label="Agent progress">
      <div className="ap-head">
        {finished ? <Mark status="completed" /> : <Spinner />}
        <span className="ap-title">{title ?? progressLabel(steps)}</span>
        <span className="ap-count" aria-hidden>
          {done}/{steps.length}
        </span>
        <button
          type="button"
          className="ap-min"
          aria-expanded={!minimized}
          aria-label={minimized ? "Show the steps" : "Hide the steps"}
          title={minimized ? "Show the steps" : "Hide the steps"}
          onClick={() => setMinimized((v) => !v)}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
            {minimized ? <path d="M3 8h10M8 3v10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /> : <path d="M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
          </svg>
        </button>
      </div>
      {!minimized && (
        <ol className="ap-steps">
          {steps.map((s, i) => (
            <li
              key={s.id}
              className={cn("ap-step", `is-${s.status}`, i >= introFrom && "ap-in")}
              style={i >= introFrom ? { animationDelay: `${Math.min(i - introFrom, 6) * 55}ms` } : undefined}
            >
              <Mark status={s.status} />
              <span className="ap-step-text">{s.title}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
