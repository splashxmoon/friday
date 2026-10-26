import { useEffect, useState } from "react";
import { ChevronDownIcon, GitForkIcon } from "lucide-react";
import { TaskMark, type TaskMarkState } from "./TaskMark.js";
import { duration, type SubTask } from "./Tasks.js";

/**
 * The subagents a coding tool sent off during a run (Claude Code's Task/Agent, Codex's spawned agents, Cursor's tasks), as one
 * card in the reply where they were started, rather than a plain "Task …" step (Arun, 2026-10-24: "add designs for sub agents
 * to the coding tools"). Each is a branch off the agent: its mark (a turning ring while it works, a check once it is back, a red
 * stop when it failed), what it was sent to do, what kind of agent it is, how long it has taken, and once it is back what it
 * found, in a line or two that opens to the whole of it.
 */

/** A subagent as the card shows it: the tool's own record of it when there is one, else the call that started it. */
export interface SubagentRow {
  key: string;
  description: string;
  agentType?: string;
  state: TaskMarkState;
  /** When it started and, once back, when it came back. */
  start?: number;
  end?: number;
  summary?: string;
}

const MARK: Record<SubTask["status"], TaskMarkState> = { running: "working", done: "done", error: "blocked", stopped: "open" };
export const subagentState = (t: SubTask): TaskMarkState => MARK[t.status];

/** The names coding tools give the call that starts a subagent. */
export const SUBAGENT_CALL = /^(task|agent|spawn_agent|subagent)$/i;

/** A clock that moves while anything in the card is still out, and stops when everything is back. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

export function Subagents({ rows }: { rows: SubagentRow[] }) {
  const out = rows.filter((r) => r.state === "working").length;
  const now = useNow(out > 0);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (!rows.length) return null;
  return (
    <section className="subs" aria-label={`${rows.length} subagent${rows.length === 1 ? "" : "s"}`}>
      <header className="subs-head">
        <span className="subs-icon" aria-hidden="true">
          <GitForkIcon className="size-3.5" />
        </span>
        <span className="subs-title">{rows.length === 1 ? "Subagent" : `${rows.length} subagents`}</span>
        <span className="subs-state">{out ? `${out} working` : "All back"}</span>
      </header>
      <ol className="subs-list">
        {rows.map((r) => {
          const took = r.start ? duration((r.end ?? now) - r.start) : "";
          const long = !!r.summary && r.summary.length > 160;
          const shown = !!open[r.key];
          return (
            <li key={r.key} className="sub" data-state={r.state}>
              <span className="sub-mark">
                <TaskMark state={r.state} />
              </span>
              <div className="sub-body">
                <div className="sub-line">
                  <span className="sub-name">{r.description}</span>
                  {r.agentType && <span className="sub-type">{r.agentType}</span>}
                  {took && <span className="sub-time">{took}</span>}
                </div>
                {r.state === "working" ? (
                  <span className="sub-doing">Working…</span>
                ) : r.summary ? (
                  <>
                    <p className={`sub-summary${shown ? " open" : ""}`}>{r.summary}</p>
                    {long && (
                      <button type="button" className="sub-more" aria-expanded={shown} onClick={() => setOpen((o) => ({ ...o, [r.key]: !shown }))}>
                        {shown ? "Show less" : "Show all"}
                        <ChevronDownIcon className={`size-3 transition-transform ${shown ? "rotate-180" : ""}`} />
                      </button>
                    )}
                  </>
                ) : r.state === "blocked" ? (
                  <span className="sub-doing bad">Stopped with an error</span>
                ) : r.state === "open" ? (
                  <span className="sub-doing">Stopped</span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
