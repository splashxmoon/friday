import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDownIcon, GitForkIcon } from "lucide-react";
import type { EngineTool } from "../types.js";
import { EngineMark } from "./BrandMarks.js";
import { TaskMark, type TaskMarkState } from "./TaskMark.js";
import { duration, type SubTask } from "./Tasks.js";

/**
 * The subagents a coding tool sent off during a run (Claude Code's Task/Agent, Codex's spawned agents, Cursor's tasks), as one
 * card in the reply where they were started, rather than a plain "Task …" step (Arun, 2026-10-24: "add designs for sub agents
 * to the coding tools"). Each is a branch off the agent: its mark (a turning ring while it works, a check once it is back, a red
 * stop when it failed), what it was sent to do, what kind of agent it is, how long it has taken and how many steps, what it is
 * doing this moment while it works, and once it is back what it found, in a line or two that opens to the whole of it.
 *
 * And every agent's subagents in one place (SubagentsTray), an item in the session's status bar (Arun, 2026-10-27: "add a better
 * design for tracking subagents"; "need a easy to view all of the agents subagents easily in one place too").
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
  /** While it works: what it is doing now ("Reading Sidebar.tsx"), from the tool's own steps. */
  doing?: string;
  /** How many steps it has taken. */
  steps?: number;
  /** When the tool last said anything of it. */
  heard?: number;
}

/** A subagent at work this long without a word from its tool is said to have gone quiet: it may be stuck. */
export const QUIET_MS = 10 * 60_000;

/**
 * What a subagent's row says under its errand, once it isn't working: its report; or, failed, the error as the tool said it,
 * else what it was doing when it failed (2026-10-27 audit: a failed one said only "Stopped with an error"). While it works,
 * what it is doing, and that it has gone quiet when nothing has come from it for a long while (it counted 40 minutes and more
 * with no sign it might be stuck).
 */
export function subagentLine(r: Pick<SubagentRow, "state" | "summary" | "doing" | "heard">, now: number): { text: string; tone?: "bad" | "warn" } | null {
  if (r.state === "working") {
    const quiet = r.heard ? now - r.heard : 0;
    return quiet >= QUIET_MS ? { text: `${r.doing ?? "Working"} · nothing from it for ${duration(quiet)}: it may be stuck`, tone: "warn" } : { text: r.doing ?? "Starting…" };
  }
  if (r.state === "blocked") return { text: r.summary ? `Failed: ${r.summary}` : r.doing ? `Failed while ${r.doing.charAt(0).toLowerCase()}${r.doing.slice(1)}` : "Failed, and its tool didn't say why", tone: "bad" };
  if (r.state === "open" && !r.summary) return { text: "Stopped before it was done" };
  return null;
}

const MARK: Record<SubTask["status"], TaskMarkState> = { running: "working", done: "done", error: "blocked", stopped: "open" };
export const subagentState = (t: SubTask): TaskMarkState => MARK[t.status];

/** A subagent's record as a row of the card. */
export const subagentRowOf = (t: SubTask): SubagentRow => ({
  key: t.key,
  description: t.description,
  ...(t.agentType && t.agentType !== "general-purpose" ? { agentType: t.agentType } : {}),
  state: subagentState(t),
  start: t.start,
  ...(t.end ? { end: t.end } : {}),
  ...(t.summary ? { summary: t.summary } : {}),
  ...(t.doing ? { doing: t.doing } : {}),
  ...(t.steps ? { steps: t.steps } : {}),
  heard: t.heard,
});

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

/**
 * "2 working · 3 back · 1 stopped · 1 failed": where a set of subagents stands, said once. One stopped before it was done isn't
 * back with anything, and is said apart (2026-10-27 audit: stopped ones were counted as back, and a stopped set read "All back").
 */
export function tallyOf(rows: SubagentRow[]): { working: number; back: number; stopped: number; failed: number; text: string } {
  const working = rows.filter((r) => r.state === "working").length;
  const failed = rows.filter((r) => r.state === "blocked").length;
  const stopped = rows.filter((r) => r.state === "open").length;
  const back = rows.length - working - failed - stopped;
  const text = [working ? `${working} working` : "", back ? (working || failed || stopped ? `${back} back` : "All back") : "", stopped ? `${stopped} stopped` : "", failed ? `${failed} failed` : ""].filter(Boolean).join(" · ");
  return { working, back, stopped, failed, text };
}

/** The share that is back, working and failed, as one thin bar: how far along the set is, without a made-up percentage. */
function TallyBar({ rows }: { rows: SubagentRow[] }) {
  const t = tallyOf(rows);
  const pct = (n: number) => `${(n / rows.length) * 100}%`;
  return (
    <span className="subs-bar" aria-hidden="true">
      {t.back > 0 && <i className="back" style={{ width: pct(t.back) }} />}
      {t.stopped > 0 && <i className="stopped" style={{ width: pct(t.stopped), background: "var(--faint)" }} />}
      {t.failed > 0 && <i className="failed" style={{ width: pct(t.failed) }} />}
      {t.working > 0 && <i className="working" style={{ width: pct(t.working) }} />}
    </span>
  );
}

/** One subagent: its mark, its errand, its kind, its time and steps, and what it is doing or what it found. */
function SubRow({ r, now, open, onToggle, onJump }: { r: SubagentRow; now: number; open: boolean; onToggle: () => void; onJump?: () => void }) {
  // Under a second says no time at all, as a reply's "Worked for" does.
  const ms = r.start ? (r.end ?? now) - r.start : 0;
  const took = r.start && (r.state === "working" || ms >= 1000) ? duration(ms) : "";
  const long = !!r.summary && r.summary.length > 160;
  const meta = [took, r.steps ? `${r.steps} step${r.steps === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
  return (
    <li className="sub" data-state={r.state}>
      <span className="sub-mark">
        <TaskMark state={r.state} />
      </span>
      <div className="sub-body">
        <div className="sub-line">
          {onJump ? (
            <button type="button" className="sub-name sub-jump" title="Go to where it was sent off" onClick={onJump}>
              {r.description}
            </button>
          ) : (
            <span className="sub-name">{r.description}</span>
          )}
          {r.agentType && <span className="sub-type">{r.agentType}</span>}
          {meta && <span className="sub-time">{meta}</span>}
        </div>
        {r.state === "working" || (r.state === "blocked" && !r.summary) ? (
          ((l) => l && <span className={`sub-doing${l.tone ? ` ${l.tone}` : ""}`}>{l.text}</span>)(subagentLine(r, now))
        ) : r.summary ? (
          <>
            <p className={`sub-summary${open ? " open" : ""}`}>{r.summary}</p>
            {long && (
              <button type="button" className="sub-more" aria-expanded={open} onClick={onToggle}>
                {open ? "Show less" : "Show all"}
                <ChevronDownIcon className={`size-3 transition-transform ${open ? "rotate-180" : ""}`} />
              </button>
            )}
          </>
        ) : r.state === "open" ? (
          <span className="sub-doing">{subagentLine(r, now)?.text}</span>
        ) : null}
      </div>
    </li>
  );
}

export function Subagents({ rows }: { rows: SubagentRow[] }) {
  const t = tallyOf(rows);
  const now = useNow(t.working > 0);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (!rows.length) return null;
  return (
    <section className="subs" aria-label={`${rows.length} subagent${rows.length === 1 ? "" : "s"}: ${t.text}`}>
      <header className="subs-head">
        <span className="subs-icon" aria-hidden="true">
          <GitForkIcon className="size-3.5" />
        </span>
        <span className="subs-title">{rows.length === 1 ? "Subagent" : `${rows.length} subagents`}</span>
        <span className="subs-state">{t.text}</span>
        {rows.length > 1 && <TallyBar rows={rows} />}
      </header>
      <ol className="subs-list">
        {rows.map((r) => (
          <SubRow key={r.key} r={r} now={now} open={!!open[r.key]} onToggle={() => setOpen((o) => ({ ...o, [r.key]: !o[r.key] }))} />
        ))}
      </ol>
    </section>
  );
}

/** Scrolls the conversation to the reply that sent a subagent off, and lets it flash, as the Jump menu does. */
function jumpTo(seq: number) {
  let best: HTMLElement | null = null;
  let bestSeq = 0;
  for (const el of document.querySelectorAll<HTMLElement>("[data-seq]")) {
    const n = Number(el.dataset.seq);
    if (n <= seq && n > bestSeq) [best, bestSeq] = [el, n];
  }
  if (!best) return;
  best.scrollIntoView({ block: "center", behavior: "smooth" });
  best.classList.add("jump-flash");
  const el = best;
  setTimeout(() => el.classList.remove("jump-flash"), 1400);
}

/**
 * Every agent's subagents in one place: an item in the status bar ("2 subagents working", or "5 subagents" once all are back)
 * that opens a list grouped by the agent that sent them, working ones first, each live, each a press away from where it was sent
 * off. Nothing is drawn while no agent has sent one. Background commands are the Tasks panel's.
 */
export function SubagentsTray({ tasks, slot, agentOf }: { tasks: SubTask[]; slot: HTMLElement | null; /** The agent a lane is: its name and coding tool. */ agentOf: (lane: string) => { name: string; tool?: EngineTool } }) {
  const subs = useMemo(() => tasks.filter((t) => t.opened && t.agentType !== "command"), [tasks]);
  const rows = useMemo(() => subs.map(subagentRowOf), [subs]);
  const t = tallyOf(rows);
  const now = useNow(t.working > 0);
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState<Record<string, boolean>>({});
  const [pos, setPos] = useState<{ left: number; bottom: number }>({ left: 16, bottom: 52 });
  const at = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => !at.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      at.current?.querySelector<HTMLElement>(".subs-item")?.focus();
    };
    addEventListener("pointerdown", away);
    addEventListener("keydown", esc);
    return () => (removeEventListener("pointerdown", away), removeEventListener("keydown", esc));
  }, [open]);
  if (!slot || !subs.length) return null;
  // By agent, the one with work out first; inside each, working first, then the latest back.
  const lanes = [...new Set(subs.map((s) => s.lane))]
    .map((lane) => ({ lane, list: subs.filter((s) => s.lane === lane).sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || (b.end ?? b.start) - (a.end ?? a.start)) }))
    .sort((a, b) => Number(b.list.some((s) => s.status === "running")) - Number(a.list.some((s) => s.status === "running")));
  const label = t.working ? `${t.working} subagent${t.working === 1 ? "" : "s"} working` : `${subs.length} subagent${subs.length === 1 ? "" : "s"}`;
  return createPortal(
    <span className="subs-tray" ref={at}>
      <button
        type="button"
        className={`stb-item subs-item${open ? " on" : ""}${t.working ? " live" : ""}`}
        aria-expanded={open}
        title="Every agent's subagents"
        onClick={(e) => {
          // Right over the button, its right edge on the button's, kept on the screen (Arun, 2026-10-27: "make sure the sub agents
          // card appears above the subagents button in the footer"); it used to sit over the message box, off to one side.
          const r = e.currentTarget.getBoundingClientRect();
          const w = Math.min(460, innerWidth - 32);
          setPos({ left: Math.max(16, Math.min(r.right - w, innerWidth - w - 16)), bottom: innerHeight - r.top + 8 });
          setOpen(!open);
        }}
      >
        {t.working ? <span className="ring-spin" aria-hidden="true" /> : <GitForkIcon className="size-3.5" aria-hidden="true" />}
        {label}
      </button>
      {open && (
        <div className="subs-pop" style={pos} role="dialog" aria-label="Every agent's subagents">
          <header className="subs-pop-head">
            <b>Subagents</b>
            <span>{t.text}</span>
            {rows.length > 1 && <TallyBar rows={rows} />}
          </header>
          <div className="subs-pop-body">
            {lanes.map(({ lane, list }) => {
              const a = agentOf(lane);
              return (
                <section key={lane} className="subs-group">
                  <h3 className="subs-group-head">
                    <EngineMark tool={a.tool ?? ""} size={14} />
                    {a.name}
                    {lanes.length > 1 && <span>{tallyOf(list.map(subagentRowOf)).text}</span>}
                  </h3>
                  <ol className="subs-list">
                    {list.map((s) => (
                      <SubRow key={s.key} r={subagentRowOf(s)} now={now} open={!!more[s.key]} onToggle={() => setMore((o) => ({ ...o, [s.key]: !o[s.key] }))} onJump={() => (setOpen(false), jumpTo(s.seq))} />
                    ))}
                  </ol>
                </section>
              );
            })}
          </div>
        </div>
      )}
    </span>,
    slot,
  );
}
