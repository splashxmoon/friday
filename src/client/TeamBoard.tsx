/**
 * A team chat's task board as a kanban, from the header's Board button or /board (Arun, 2026-10-28: the critique's "a Board button
 * in the team header opens a kanban: To do / Doing / Needs you / Done, swimlanes per teammate with mascots, links to results"):
 * one row per teammate who has a task, and one for what nobody has yet. A card dragged to another teammate's row goes to them
 * (board.task reassign, the same as the task's own menu); its menu also tries again, sends back or drops it.
 *
 */
import { useState, type DragEvent } from "react";
import { EllipsisIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { meshOf, pendingFor, runOf, type BoardTask, type SessionState } from "../session/projection.js";
import { ContextMenu, type MenuItem } from "./ui.js";
import type { Send } from "./useSession.js";
import { boardTitle, plainError } from "./team-api.js";
import { plainLine } from "./team-room.js";
import { focusAgent } from "./agentFocus.js";
import { Face, mateOn, matesIn, mateStatus } from "./Teammates.js";

type Col = "todo" | "doing" | "needs" | "done";
const COLS: { id: Col; title: string; empty: string }[] = [
  { id: "todo", title: "To do", empty: "Nothing waiting" },
  { id: "doing", title: "Doing", empty: "Nobody on one" },
  { id: "needs", title: "Needs you", empty: "Nothing stuck" },
  { id: "done", title: "Done", empty: "Nothing yet" },
];

/** Which column a task is in: blocked is the person's to look at; under review is still being done. */
export function colOf(t: Pick<BoardTask, "status">): Col | null {
  if (t.status === "cancelled") return null;
  if (t.status === "open") return "todo";
  if (t.status === "claimed" || t.status === "review") return "doing";
  if (t.status === "blocked") return "needs";
  return "done";
}

/** A board task, or work the lead handed out by assign_task (`assigned`): the board shows both, as the Team tasks list does. */
type Task = BoardTask & { assigned?: boolean };

/** Where a task the lead handed out stands, from its reply, its queue and its teammate's run. */
export function assignedStatus(a: { reply?: { short?: boolean } }, run: string, queued: boolean): BoardTask["status"] {
  if (a.reply) return a.reply.short ? "blocked" : "done";
  return queued ? "open" : run === "running" ? "claimed" : "blocked";
}

/** The lead's assigned tasks of the current round as board cards (AgentTalk.tsx teamTasks: a round ends when all reported back). */
export function assignedTasks(state: SessionState): Task[] {
  const asks = Object.values(meshOf(state).asks).filter((a) => a.task).sort((x, y) => x.seq - y.seq);
  let from = 0;
  asks.forEach((a, i) => {
    if (i && asks.slice(0, i).every((p) => p.reply && p.reply.seq < a.seq)) from = i;
  });
  return asks.slice(from).map((a): Task => {
    const run = runOf(state, a.toLane).status;
    const queued = pendingFor(state, a.toLane).includes(a.seq);
    // A reply that says it stopped short (a stop, an error, a usage limit) is the person's to look at, not done (2026-10-28 QA:
    // "Arun stopped Kit's task before it finished" sat in Done, and the board said "1 of 1 done").
    const status = assignedStatus(a, run, queued);
    const report = a.reply?.text ?? (run === "waiting_for_human" ? "Needs you" : run === "error" ? "Stopped on an error" : status === "blocked" ? "No report yet" : "");
    return { id: `a:${a.id}`, title: boardTitle(a.text.split("\n").find((l) => l.trim()) ?? a.text).slice(0, 120), detail: a.text, owns: [], after: [], status, lane: a.toLane, name: a.toName, rounds: 0, assigned: true, ...(report ? { report } : {}), ...(queued ? { next: a.toName } : {}) };
  });
}

export function TeamBoard({ state, send, onClose }: { state: SessionState; send: Send; onClose: () => void }) {
  const board = state.board;
  const tasks: Task[] = [...(board?.tasks ?? []), ...assignedTasks(state)].filter((t) => colOf(t));
  const mates = matesIn(state.id);
  const [menu, setMenu] = useState<{ t: Task; x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const leadName = mateOn(state.lead ?? "")?.name ?? "the lead";
  /** Work the lead handed out isn't the board's to move: the lead is asked to, in the room. */
  const askLead = (t: Task, to: string) =>
    void send({ type: "instruct", lane: state.lead, text: `Please hand "${boardTitle(t.title)}" from ${t.name ?? "its teammate"} to ${to}.` }).then((r) => setErr(r.ok ? `Asked ${leadName} to hand it to ${to}.` : (r.error ?? "Couldn't ask the lead.")));
  const control = (id: string, action: "reassign" | "retry" | "sendback" | "cancel", to?: string) => {
    const t = byId.get(id);
    if (t?.assigned) return action === "reassign" && to ? askLead(t, to) : undefined;
    void send({ type: "board.task", id, action, ...(to ? { to } : {}) }).then((r) => setErr(r.ok ? "" : (r.error ?? "Couldn't change that task.")));
  };
  // Rows: every teammate here, the lead's first, so a card always has another row to be dragged to (2026-10-28 QA: with rows only
  // for those holding a task, one task left nowhere to drop it); then what nobody has.
  const laneOfTask = (t: Task) => (t.lane && mates.some((x) => x.lane === t.lane) ? t.lane : "");
  const rows = [...new Set([...mates.map((x) => x.lane), ...tasks.map(laneOfTask)])].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : Number(b === state.lead) - Number(a === state.lead)));
  const movable = mates.length > 1 && tasks.some((t) => t.status !== "done");
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const drop = (lane: string) => (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const t = byId.get(e.dataTransfer.getData("text/x-board-task") || drag || "");
    setDrag(null);
    const m = mateOn(lane);
    if (!t || !m || laneOfTask(t) === lane || t.status === "done") return;
    control(t.id, "reassign", m.name);
  };
  /** "Open Kit's chat" (2026-10-28 QA: "Open Kit chat"). */
  const chatOf = (lane: string) => (mateOn(lane)?.name ? `Open ${mateOn(lane)!.name}'s chat` : "Open their chat");
  const items = (t: Task): MenuItem[] => {
    const out: MenuItem[] = [];
    if (t.assigned) {
      if (t.lane) out.push({ label: chatOf(t.lane), icon: "chat", onSelect: () => (focusAgent(state.id, t.lane!), onClose()) });
      // The lead is the one asked, so not one of those it is asked to hand it to (2026-10-28 QA).
      const to = mates.filter((x) => x.lane !== t.lane && x.lane !== state.lead);
      if (t.status !== "done" && state.lead && to.length) {
        out.push({ heading: `Ask ${leadName} to hand it to` });
        for (const x of to) out.push({ label: x.m.name, mark: <Face seed={x.m.look ?? x.m.name} size={16} />, onSelect: () => askLead(t, x.m.name) });
      }
      return out;
    }
    if (t.lane) out.push({ label: chatOf(t.lane), icon: "chat", onSelect: () => (focusAgent(state.id, t.lane!), onClose()) });
    if (t.status === "blocked") out.push({ label: "Try again", icon: "refresh", onSelect: () => control(t.id, "retry") });
    if (t.status !== "done") {
      const others = mates.filter((x) => x.lane !== t.lane);
      if (others.length) out.push({ heading: t.status === "open" ? "Give it to" : "Hand it to" });
      for (const x of others) out.push({ label: x.m.name, mark: <Face seed={x.m.look ?? x.m.name} size={16} />, hint: mateStatus(x.m, { sid: state.id, lane: x.lane }).line.slice(0, 28), onSelect: () => control(t.id, "reassign", x.m.name) });
    }
    if (t.status === "done" || t.status === "review") out.push({ label: "Send back", icon: "rewind", onSelect: () => control(t.id, "sendback") });
    if (t.status !== "done") out.push({ label: "Drop it", icon: "x", danger: true, onSelect: () => control(t.id, "cancel") });
    return out;
  };
  const done = tasks.filter((t) => t.status === "done").length;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* Escape with a card's menu open closes the menu, not the board under it (Arun, 2026-10-28: "really iron out bugs…"). An
          empty board is a dialog's width for its one line, not the lanes' 1180px (Arun, 2026-10-28: "look for like the little
          details and designs"). */}
      <DialogContent className={`tm-board-dialog max-h-[calc(100dvh-2rem)] overflow-hidden ${tasks.length ? "sm:max-w-[min(1180px,calc(100vw-2rem))]" : "sm:max-w-md"}`} onEscapeKeyDown={(e) => menu && (e.preventDefault(), setMenu(null))}>
        <DialogHeader>
          <DialogTitle>Board</DialogTitle>
          <DialogDescription>
            {tasks.length ? `${done} of ${tasks.length} done${board ? ` · ${board.fromName} posted the board` : ""}.${movable ? " Drag a card to another teammate's row to hand it to them." : ""}` : "Nothing on the board yet. Give the lead a goal: they split the work into tasks here and hand them out."}
          </DialogDescription>
        </DialogHeader>
        {err && (
          <p className="tm-err" role="alert">
            {err}
          </p>
        )}
        {tasks.length > 0 && (
          <div className="tm-kb" role="grid" aria-label="Tasks by teammate and stage">
            <div className="tm-kb-row tm-kb-head" role="row">
              <span className="tm-kb-who" role="columnheader" />
              {COLS.map((c) => (
                <span key={c.id} className="tm-kb-colhead" data-col={c.id} role="columnheader">
                  {c.title}
                  <b>{tasks.filter((t) => colOf(t) === c.id).length}</b>
                </span>
              ))}
            </div>
            {rows.map((lane) => {
              const m = lane ? mateOn(lane) : null;
              const s = m ? mateStatus(m, { sid: state.id, lane }) : null;
              return (
                <div key={lane || "none"} className="tm-kb-row" role="row" data-over={over === lane ? "true" : undefined} onDragOver={(e) => lane && drag && (e.preventDefault(), setOver(lane))} onDragLeave={() => setOver((o) => (o === lane ? null : o))} onDrop={drop(lane)}>
                  <span className="tm-kb-who" role="rowheader">
                    {/* The face stands as the line beside it does, in this room: "Idle here" with a working dot read two ways. */}
                    {m ? <Face seed={m.look ?? m.name} size={24} status={s?.state ?? m.status} lead={lane === state.lead} /> : <span className="tm-kb-nobody" aria-hidden="true" />}
                    <span className="tm-text">
                      <span className="tm-name">{m?.name ?? "Nobody yet"}</span>
                      <span className={`tm-sub s-${s?.state ?? "idle"}`}>{s?.line ?? "Waiting for a teammate"}</span>
                    </span>
                  </span>
                  {COLS.map((c) => {
                    const here = tasks.filter((t) => laneOfTask(t) === lane && colOf(t) === c.id);
                    return (
                      <div key={c.id} className="tm-kb-cell" role="gridcell" data-col={c.id} aria-label={`${m?.name ?? "Nobody"}, ${c.title}: ${here.length}`}>
                        {here.map((t) => (
                          <Card key={t.id} t={t} state={state} dragging={drag === t.id} onDrag={(on) => setDrag(on ? t.id : null)} onMenu={(x, y) => setMenu({ t, x, y })} onOpen={() => t.lane && (focusAgent(state.id, t.lane), onClose())} />
                        ))}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
        {menu && <ContextMenu at={menu} items={() => items(menu.t)} onClose={() => setMenu(null)} />}
      </DialogContent>
    </Dialog>
  );
}

/** One task: its title, what it waits on or how it went, and its result a press away. */
function Card({ t, state, dragging, onDrag, onMenu, onOpen }: { t: Task; state: SessionState; dragging: boolean; onDrag: (on: boolean) => void; onMenu: (x: number, y: number) => void; onOpen: () => void }) {
  const waits = t.status === "open" ? t.after.filter((d) => state.board?.tasks.find((x) => x.id === d)?.status !== "done") : [];
  const line =
    t.status === "blocked"
      ? plainError(t.report ?? "Blocked")
      : t.status === "review"
        ? `${t.reviewer?.name ?? "A teammate"} is checking it`
        : t.status === "done"
          ? plainLine(t.report ?? "") // Its words, not its markdown ("**Notes**", backticks; QA, 2026-10-28).
          : t.status === "claimed"
            ? // No "On it" under every card in Doing: the column says it, and the row's head carries the teammate's live line
              // beside its ringed face (Arun, 2026-10-29: "so clean and beautiful…"; DIRECTION.md §9.4).
              t.checks?.running
              ? "Running its checks"
              : ""
            : waits.length
              ? `After ${waits.map((d) => state.board?.tasks.find((x) => x.id === d)?.title ?? d).join(", ")}`
              : t.next
                ? `Next for ${t.next}`
                : "Ready for whoever is free";
  return (
    <article
      className="tm-kb-card"
      data-status={t.status}
      data-dragging={dragging ? "true" : undefined}
      draggable={t.status !== "done"}
      onDragStart={(e) => (e.dataTransfer.setData("text/x-board-task", t.id), (e.dataTransfer.effectAllowed = "move"), onDrag(true))}
      onDragEnd={() => onDrag(false)}
      onContextMenu={(e) => (e.preventDefault(), onMenu(e.clientX, e.clientY))}
    >
      {/* The "…" beside the title, where it has a place of its own: at the foot it wrapped onto a row alone (QA, 2026-10-28). */}
      <span className="tm-kb-top">
        <span className="tm-kb-title">{plainLine(boardTitle(t.title))}</span>
        <button
          type="button"
          className="tm-kb-more"
          aria-label={`Change "${plainLine(boardTitle(t.title))}"`}
          onClick={(e) => {
            const b = e.currentTarget.getBoundingClientRect();
            onMenu(b.left, b.bottom + 4);
          }}
        >
          <EllipsisIcon className="size-3.5" />
        </button>
      </span>
      {t.assigned && <span className="tm-kb-from">Handed out by the lead</span>}
      {line && <span className="tm-kb-line">{line}</span>}
      <span className="tm-kb-foot">
        {t.checks && !t.checks.running && t.checks.ok !== undefined && <span className={t.checks.ok ? "tm-kb-check ok" : "tm-kb-check bad"}>{t.checks.ok ? "Checks pass" : "Checks failed"}</span>}
        {t.rounds > 0 && <span className="tm-kb-check">Round {t.rounds + 1}</span>}
        {t.lane && (
          <button type="button" className="tm-kb-link" onClick={onOpen}>
            {t.status === "done" ? "See the result" : "Open chat"} →
          </button>
        )}
      </span>
    </article>
  );
}
