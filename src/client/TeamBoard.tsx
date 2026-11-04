/**
 * A team chat's task board, from the header's Board button or /board: one list by what each task needs, what needs you first,
 * then what is being done, what waits, and what is done, folded away (Arun, 2026-11-03, of the kanban: "design this better", then
 * of this one: "i like this tbh"). A row is the teammate's face and name, the task and how it went on one line under it, its
 * proof and the one thing to do with it; its menu hands it to another teammate, tries it again, sends it back or drops it.
 *
 */
import { useMemo, useState } from "react";
import { EllipsisIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { meshOf, pendingFor, runOf, type BoardTask, type SessionState } from "../session/projection.js";
import { ContextMenu, type MenuItem } from "./ui.js";
import type { Send } from "./useSession.js";
import { boardTitle, plainError } from "./team-api.js";
import { plainLine } from "./team-room.js";
import { focusAgent } from "./agentFocus.js";
import { Face, mateOn, matesIn, mateStatus } from "./Teammates.js";
import type { SessionEvent } from "../types.js";
import { taskProof, type Proof } from "../team-proof.js";
import { ProofButton } from "./ProofCard.js";

type Col = "todo" | "doing" | "needs" | "done";
/** The groups, in the order the list reads: what is yours to do first. */
const COLS: { id: Col; title: string }[] = [
  { id: "needs", title: "Needs you" },
  { id: "doing", title: "Doing" },
  { id: "todo", title: "To do" },
  { id: "done", title: "Done" },
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

export function TeamBoard({ state, events = [], send, onClose }: { state: SessionState; events?: SessionEvent[]; send: Send; onClose: () => void }) {
  const board = state.board;
  const tasks: Task[] = [...(board?.tasks ?? []), ...assignedTasks(state)].filter((t) => colOf(t));
  // Each handed-in task's proof (team-proof.ts): what the person checks it by, on its card.
  const proofs = useMemo(() => new Map((board?.tasks ?? []).filter((t) => t.status === "review" || t.status === "done" || t.status === "blocked").flatMap((t) => {
    const p = taskProof(events, t.id, state.id);
    return p ? [[t.id, p] as const] : [];
  })), [board, events, state.id]);
  const mates = matesIn(state.id);
  const [menu, setMenu] = useState<{ t: Task; x: number; y: number } | null>(null);
  const [err, setErr] = useState("");
  const [doneOpen, setDoneOpen] = useState(true);
  const leadName = mateOn(state.lead ?? "")?.name ?? "the lead";
  /** Work the lead handed out isn't the board's to move: the lead is asked to, in the room. */
  const askLead = (t: Task, to: string) =>
    void send({ type: "instruct", lane: state.lead, text: `Please hand "${boardTitle(t.title)}" from ${t.name ?? "its teammate"} to ${to}.` }).then((r) => setErr(r.ok ? `Asked ${leadName} to hand it to ${to}.` : (r.error ?? "Couldn't ask the lead.")));
  const control = (id: string, action: "reassign" | "retry" | "sendback" | "cancel", to?: string) => {
    const t = byId.get(id);
    if (t?.assigned) return action === "reassign" && to ? askLead(t, to) : undefined;
    void send({ type: "board.task", id, action, ...(to ? { to } : {}) }).then((r) => setErr(r.ok ? "" : (r.error ?? "Couldn't change that task.")));
  };
  const laneOfTask = (t: Task) => (t.lane && mates.some((x) => x.lane === t.lane) ? t.lane : "");
  const byId = new Map(tasks.map((t) => [t.id, t]));
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
  const needs = tasks.filter((t) => colOf(t) === "needs").length;
  const open = (t: Task) => t.lane && (focusAgent(state.id, t.lane), onClose());
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* Escape with a row's menu open closes the menu, not the board under it (Arun, 2026-10-28: "really iron out bugs…"). An
          empty board is a dialog's width for its one line. */}
      <DialogContent className={`tm-board-dialog max-h-[calc(100dvh-2rem)] overflow-hidden ${tasks.length ? "sm:max-w-[min(860px,calc(100vw-2rem))]" : "sm:max-w-md"}`} onEscapeKeyDown={(e) => menu && (e.preventDefault(), setMenu(null))}>
        <DialogHeader>
          <DialogTitle>Board</DialogTitle>
          <DialogDescription className={tasks.length ? "tm-bl-sum" : undefined}>
            {tasks.length ? (
              <>
                {/* How far the round has got, in the colours of where its tasks stand. */}
                <span className="tm-bl-bar" aria-hidden="true">
                  {(["done", "needs", "doing", "todo"] as const).map((c) => {
                    const n = tasks.filter((t) => colOf(t) === c).length;
                    return n ? <i key={c} data-col={c} style={{ flex: n }} /> : null;
                  })}
                </span>
                <span>
                  <b>
                    {done} of {tasks.length} done
                  </b>
                  {needs ? ` · ${needs} need${needs === 1 ? "s" : ""} you` : ""}
                  {board ? ` · ${board.fromName} posted it` : ""}
                </span>
              </>
            ) : (
              "Nothing on the board yet. Give the lead a goal: they split the work into tasks here and hand them out."
            )}
          </DialogDescription>
        </DialogHeader>
        {err && (
          <p className="tm-err" role="alert">
            {err}
          </p>
        )}
        {tasks.length > 0 && (
          <div className="tm-bl" aria-label="Tasks by what they need">
            {COLS.map((c) => {
              const here = tasks.filter((t) => colOf(t) === c.id);
              if (!here.length) return null;
              const folds = c.id === "done";
              return (
                <section key={c.id} className="tm-bl-group" data-col={c.id} aria-label={`${c.title}: ${here.length}`}>
                  <h3 className="tm-bl-head">
                    <span className="tm-bl-dot" data-col={c.id} aria-hidden="true" />
                    {c.title}
                    <b>{here.length}</b>
                    {folds && (
                      <button type="button" className="tm-bl-fold" aria-expanded={doneOpen} onClick={() => setDoneOpen((o) => !o)}>
                        {doneOpen ? "Hide" : "Show"}
                      </button>
                    )}
                  </h3>
                  {(!folds || doneOpen) && here.map((t) => <Row key={t.id} t={t} state={state} lane={laneOfTask(t)} proof={proofs.get(t.id)} onMenu={(x, y) => setMenu({ t, x, y })} onOpen={() => open(t)} />)}
                </section>
              );
            })}
          </div>
        )}
        {menu && <ContextMenu at={menu} items={() => items(menu.t)} onClose={() => setMenu(null)} />}
      </DialogContent>
    </Dialog>
  );
}

/** One task: its teammate, its title and how it stands, its proof, and the one thing to do with it. */
function Row({ t, state, lane, proof, onMenu, onOpen }: { t: Task; state: SessionState; lane: string; proof?: Proof; onMenu: (x: number, y: number) => void; onOpen: () => void }) {
  const m = lane ? mateOn(lane) : null;
  const s = m ? mateStatus(m, { sid: state.id, lane }) : null;
  const waits = t.status === "open" ? t.after.filter((d) => state.board?.tasks.find((x) => x.id === d)?.status !== "done") : [];
  const line =
    t.status === "blocked"
      ? plainError(t.report ?? "Blocked")
      : t.status === "review"
        ? `${t.reviewer?.name ?? "A teammate"} is checking it`
        : t.status === "done"
          ? // Its words, not its markdown ("**Notes**", backticks; QA, 2026-10-28), nor Friday's record under them: its proof says that.
            plainLine((t.report ?? "").split("\n\n[Friday, from the record]")[0]!)
          : t.status === "claimed"
            ? t.checks?.running
              ? "Running its checks"
              : (s?.line ?? "On it")
            : waits.length
              ? `After “${waits.map((d) => plainLine(boardTitle(state.board?.tasks.find((x) => x.id === d)?.title ?? d))).join("”, “")}”`
              : t.next
                ? `Next for ${t.next}`
                : "Ready for whoever is free";
  const col = colOf(t);
  // A workflow's check is posted as "Check: …": said as its tag, not as the first word of every one.
  const said = plainLine(boardTitle(t.title));
  const check = /^check:\s*/i.test(said);
  const title = check ? said.replace(/^check:\s*/i, "") : said;
  return (
    <article className="tm-bl-row" data-col={col ?? undefined} onContextMenu={(e) => (e.preventDefault(), onMenu(e.clientX, e.clientY))}>
      {m ? <Face seed={m.look ?? m.name} size={30} status={s?.state ?? m.status} lead={lane === state.lead} /> : <span className="tm-kb-nobody" aria-hidden="true" />}
      <div className="tm-bl-main">
        <p className="tm-bl-title" title={title}>
          <span className="tm-bl-name">{m?.name || t.name || "Nobody yet"}</span>
          {check && <span className="tm-bl-kind">Check</span>}
          <span className="tm-bl-words">{title}</span>
        </p>
        {line && (
          <p className="tm-bl-line" data-col={col ?? undefined} title={line}>
            {col === "doing" && <span className="tm-bl-dots" aria-hidden="true"><i /><i /><i /></span>}
            {line}
          </p>
        )}
      </div>
      <div className="tm-bl-side">
        {/* Its proof, a press away: the checks, the files, the picture and its own review (ProofCard.tsx). */}
        {proof && t.status !== "claimed" && <ProofButton proof={proof} />}
        {!proof && t.checks && !t.checks.running && t.checks.ok !== undefined && <span className={t.checks.ok ? "tm-kb-check ok" : "tm-kb-check bad"}>{t.checks.ok ? "Checks pass" : "Checks failed"}</span>}
        {t.rounds > 0 && <span className="tm-bl-chip">Round {t.rounds + 1}</span>}
        {t.assigned && <span className="tm-bl-chip">From the lead</span>}
        {lane && (
          <button type="button" className={col === "needs" ? "btn primary small" : "btn small"} onClick={onOpen}>
            {col === "done" ? "Result" : col === "needs" ? "Answer" : "Open chat"}
          </button>
        )}
        <button
          type="button"
          className="tm-kb-more"
          aria-label={`Change "${title}"`}
          onClick={(e) => {
            const b = e.currentTarget.getBoundingClientRect();
            onMenu(b.left, b.bottom + 4);
          }}
        >
          <EllipsisIcon className="size-3.5" />
        </button>
      </div>
    </article>
  );
}
