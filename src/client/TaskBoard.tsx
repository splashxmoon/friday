/**
 * The team's tasks, at the top of the side panel's Tasks tab (Arun, 2026-11-18: "move this somewhere else and add more control over
 * this as well", picking the Tasks tab and every control offered). It was a pill in the session's header opening a card; here it has
 * the room to be steered: add a task, reword one, move what waits up or down the line (the board hands out in its order), give one
 * to an agent or hand it on, hold one or the whole board and let it go, mark one done, try a stuck one again, send one back, drop
 * one. The tab itself carries the count (Workbench `badges.tasks`).
 */
import { useMemo, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { TodoStep } from "@/components/aicss/TodoList";
import { laneLabel } from "../left-off.js";
import { laneOf, type BoardTask, type SessionState } from "../session/projection.js";
import { MAIN_LANE } from "../types.js";
import { teamTasks } from "./AgentTalk.js";
import { liveTasks } from "./task-count.js";
import { agentLook } from "./handoff-ui.js";
import { Icon } from "./icons.js";
import { MenuButton, type MenuItem } from "./ui.js";
import type { Send } from "./useSession.js";
import "./team-tasks.css";

type Steer = { action: "add" | "edit" | "move" | "hold" | "resume" | "done" | "reassign" | "retry" | "sendback" | "cancel"; id?: string; to?: string; title?: string; detail?: string; at?: number };

/** How far along: done of all, as a ring. */
function Ring({ done, total, tone }: { done: number; total: number; tone: string }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg className={`tt2-ring is-${tone}`} width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r={r} className="tt2-ring-bg" />
      <circle cx="9" cy="9" r={r} className="tt2-ring-fg" strokeDasharray={`${c * (total ? done / total : 0)} ${c}`} transform="rotate(-90 9 9)" />
    </svg>
  );
}

function Glyph({ t, held }: { t: TodoStep; held: boolean }) {
  if (held) return <span className="tt2-glyph is-held" aria-label="Held" />;
  if (t.status === "completed") return <span className="tt2-glyph is-done" aria-label="Done" />;
  if (t.status === "cancelled") return <span className="tt2-glyph is-dropped" aria-label="Dropped" />;
  if (t.tone === "bad") return <span className="tt2-glyph is-bad" aria-label="Stuck" />;
  if (t.tone === "warn") return <span className="tt2-glyph is-warn" aria-label="Needs a look" />;
  if (t.status === "active") return <span className="tt2-glyph is-work" aria-label="Working" />;
  return <span className="tt2-glyph is-next" aria-label="Waiting" />;
}

/** Its words, written or rewritten: a name, and what to do and what done looks like. */
function TaskForm({ title, detail, agents, onSave, onCancel, adding }: { title: string; detail: string; agents?: { id: string; name: string; mark?: ReactNode }[]; onSave: (v: { title: string; detail: string; to?: string }) => void; onCancel: () => void; adding?: boolean }) {
  const [name, setName] = useState(title);
  const [words, setWords] = useState(detail);
  const [to, setTo] = useState("");
  const save = (e?: FormEvent) => {
    e?.preventDefault();
    if (name.trim()) onSave({ title: name.trim(), detail: words.trim(), ...(to ? { to } : {}) });
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") (e.stopPropagation(), onCancel());
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
  };
  return (
    <form className="tb-form" onSubmit={save} onKeyDown={keys}>
      <input className="tb-input" autoFocus onFocus={(e) => !adding && e.currentTarget.select()} value={name} onChange={(e) => setName(e.target.value)} placeholder="What needs doing" aria-label="Task" maxLength={200} />
      <textarea className="tb-input tb-detail" value={words} onChange={(e) => setWords(e.target.value)} placeholder="Details: what to do, and what done looks like (optional)" aria-label="Details" rows={2} maxLength={4000} />
      <div className="tb-form-bar">
        {agents && agents.length > 0 && (
          // The app's own menu, never the system's select (Arun, 2026-11-18: "also no native controls").
          <span className="tb-for">
            <span>For</span>
            <MenuButton
              className="tb-for-btn"
              label="Who does it"
              compact
              items={() => [
                { label: "Whoever is free", checked: !to, onSelect: () => setTo("") },
                ...agents.map((a) => ({ label: a.name, ...(a.mark ? { mark: a.mark } : {}), checked: to === a.name, onSelect: () => setTo(a.name) })),
              ]}
            >
              {agents.find((a) => a.name === to)?.mark}
              <span>{to || "Whoever is free"}</span>
              <Icon name="chevronsUpDown" size={12} />
            </MenuButton>
          </span>
        )}
        <span className="tb-form-gap" />
        <button type="button" className="rsp-text-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn primary small" disabled={!name.trim()}>
          {adding ? "Add task" : "Save"}
        </button>
      </div>
    </form>
  );
}

export default function TaskBoard({ state, send, notify, jump, readOnly }: { state: SessionState; send?: Send; notify: (m: string) => void; jump: (seq: number) => void; readOnly?: boolean }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const can = !readOnly && !!send;
  const steer = (s: Steer) => void send?.({ type: "board.task", id: s.id ?? "", ...s }).then((r) => !r.ok && notify(r.error ?? "Couldn't change that task."));
  // A team only proposed isn't work yet: its card waits over the message box (ProposedTeam), and its tasks show here once started.
  const listed = useMemo(() => teamTasks(state, jump).filter((t) => !(state.board?.proposed && t.id.startsWith("b:"))), [state, state.lastSeq]); // eslint-disable-line react-hooks/exhaustive-deps
  // Once every task is done or dropped, the team's list goes (Arun, 2026-11-18: "make sure the team tasks disappear after being
  // completed too"): a finished board has nothing left to steer, and the chat keeps the record of who did what.
  const all = liveTasks(listed);
  const board = state.board;
  const bt = (t: TodoStep): BoardTask | undefined => (t.id.startsWith("b:") ? board?.tasks.find((x) => x.id === t.id.slice(2)) : undefined);
  const agents = [MAIN_LANE, ...state.lanes.map((l) => l.id)].filter((l) => laneOf(state, l)?.control.kind !== "standing").map((l) => ({ id: l, name: laneLabel(state, l), mark: agentLook(state, l, 13).mark }));
  if (state.options.team) return null;
  // Nothing on it and nobody to add one: no section at all, as the empty Tasks tab says what shows there.
  if (!all.length && !can) return null;
  const finished = (t: TodoStep) => t.status === "completed" || t.status === "cancelled";
  const done = all.filter(finished).length;
  const stuck = all.filter((t) => t.tone === "bad").length;
  const working = all.filter((t) => t.status === "active" && !t.tone).length;
  const tone = stuck ? "bad" : all.some((t) => t.tone === "warn") ? "warn" : working ? "work" : "idle";
  const now = all.filter((t) => t.status === "active");
  const next = all.filter((t) => t.status === "pending");
  const over = all.filter(finished);
  // What waits on the board, in its order: what ↑ and ↓ move among.
  const line = next.flatMap((t) => (bt(t)?.status === "open" ? [bt(t)!] : []));
  const at = (id: string) => board?.tasks.findIndex((x) => x.id === id) ?? -1;
  const busy = !!board && board.tasks.some((t) => t.status !== "done" && t.status !== "cancelled");

  const menu = (b: BoardTask): MenuItem[] => {
    const open = b.status !== "done" && b.status !== "cancelled";
    const others = agents.filter((a) => a.id !== b.lane);
    return [
      open && { label: "Edit", icon: "pencil" as const, onSelect: () => setEditing(b.id) },
      (b.status === "blocked" || b.status === "cancelled") && { label: "Try again", icon: "refresh" as const, onSelect: () => steer({ action: "retry", id: b.id }) },
      open && others.length > 0 && { heading: b.status === "open" ? "Give it to" : "Hand it to" },
      ...(open ? others.map((a) => ({ label: a.name, mark: agentLook(state, a.id, 13).mark, checked: b.status === "open" && b.next === a.name, onSelect: () => steer({ action: "reassign", id: b.id, to: a.name }) })) : []),
      open && { heading: "This task" },
      open && (b.held ? { label: "Let it go", icon: "play" as const, onSelect: () => steer({ action: "resume", id: b.id }) } : { label: b.status === "open" ? "Hold it back" : "Stop and hold it", icon: "pause" as const, onSelect: () => steer({ action: "hold", id: b.id }) }),
      open && { label: "Mark done", icon: "check" as const, onSelect: () => steer({ action: "done", id: b.id }) },
      (b.status === "done" || b.status === "review") && !b.doneBy && { label: "Send back", icon: "rewind" as const, onSelect: () => steer({ action: "sendback", id: b.id }) },
      open && { label: "Drop it", icon: "x" as const, danger: true, onSelect: () => steer({ action: "cancel", id: b.id }) },
    ];
  };

  const row = (t: TodoStep) => {
    const b = bt(t);
    const held = !!b?.held && b.status === "open";
    if (b && editing === b.id)
      return (
        <li key={t.id} className="tt2-row tb-editing">
          <TaskForm title={b.title} detail={b.detail} onCancel={() => setEditing(null)} onSave={(v) => (steer({ action: "edit", id: b.id, title: v.title, detail: v.detail }), setEditing(null))} />
        </li>
      );
    const note = held ? "Held" : b?.doneBy ? `Marked done by ${b.doneBy}` : t.note;
    const i = b ? line.indexOf(b) : -1;
    return (
      <li key={t.id} className={`tt2-row${held ? " is-held" : ""}`}>
        <button type="button" className="tt2-main" onClick={t.onSelect} title={t.detail && t.detail !== t.title ? t.detail : undefined} disabled={!t.onSelect}>
          <Glyph t={t} held={held} />
          <span className="tt2-text">
            <span className="tt2-title">{t.title}</span>
            {(t.who || note) && (
              <span className="tt2-meta">
                {t.who && <span className="tt2-who">{t.who}</span>}
                {note && <span className={`tt2-note${held ? " is-held" : t.tone ? ` is-${t.tone}` : ""}`}>{note}</span>}
              </span>
            )}
          </span>
        </button>
        {can && b && (
          <span className="tb-acts">
            {i >= 0 && line.length > 1 && (
              <>
                <button type="button" className="icon-btn tiny" aria-label={`Move "${b.title}" up`} title="Hand it out sooner" disabled={i === 0} onClick={() => steer({ action: "move", id: b.id, at: at(line[i - 1]!.id) })}>
                  <Icon name="chevronUp" size={13} />
                </button>
                <button type="button" className="icon-btn tiny" aria-label={`Move "${b.title}" down`} title="Hand it out later" disabled={i === line.length - 1} onClick={() => steer({ action: "move", id: b.id, at: at(line[i + 1]!.id) })}>
                  <Icon name="chevronDown" size={13} />
                </button>
              </>
            )}
            <MenuButton items={() => menu(b)} label={`Change "${b.title}"`} icon="moreV" compact className="icon-btn tiny tt-more" />
          </span>
        )}
      </li>
    );
  };

  const group = (id: string, title: string, rows: TodoStep[], folded?: boolean) =>
    rows.length > 0 && (
      <section key={id} className={`tt2-group is-${id}`}>
        <h4>
          {folded !== undefined ? (
            <button type="button" className="tb-fold" aria-expanded={!folded} onClick={() => setDoneOpen((o) => !o)}>
              <Icon name={folded ? "chevronRight" : "chevronDown"} size={11} />
              {title} <span>{rows.length}</span>
            </button>
          ) : (
            <>
              {title} <span>{rows.length}</span>
            </>
          )}
        </h4>
        {!folded && <ul>{rows.map(row)}</ul>}
      </section>
    );

  return (
    <section className="tb" aria-label="Team tasks">
      <div className="tb-head">
        {all.length > 0 && <Ring done={done} total={all.length} tone={tone} />}
        <b>Team tasks</b>
        {all.length > 0 && (
          <span className="tb-count">
            {done} of {all.length} done
          </span>
        )}
        <span className="tb-gap" />
        {can && busy && (
          <button type="button" className="rsp-text-btn tb-hold" onClick={() => steer({ action: board?.held ? "resume" : "hold" })} title={board?.held ? "Hand out what waits again" : "Hand out nothing more until you let it go; what is under way carries on"}>
            <Icon name={board?.held ? "play" : "pause"} size={12} />
            {board?.held ? "Let go" : "Hold all"}
          </button>
        )}
        {can && !adding && (
          <button type="button" className="rsp-text-btn tb-add" onClick={() => setAdding(true)}>
            <Icon name="plus" size={12} />
            Add task
          </button>
        )}
      </div>
      {all.length > 0 && (
        <div className="tt2-bar" aria-hidden="true">
          <i style={{ width: `${Math.round((done / all.length) * 100)}%` }} />
        </div>
      )}
      {board?.held && <p className="tb-held">Held: nothing more is handed out until you let it go. What's under way carries on.</p>}
      {adding && (
        <div className="tb-adding">
          <TaskForm adding title="" detail="" agents={agents} onCancel={() => setAdding(false)} onSave={(v) => (steer({ action: "add", ...v }), setAdding(false))} />
        </div>
      )}
      {!all.length && !adding && <p className="tb-empty">Tasks here go to whoever is free.</p>}
      {all.length > 0 && (
        <div className="tb-list">
          {group("now", "In progress", now)}
          {group("next", "Up next", next)}
          {group("done", "Done", over, over.length > 3 ? !doneOpen : undefined)}
        </div>
      )}
    </section>
  );
}
