import { useState, type ReactNode } from "react";
import { ArrowRightIcon, CheckIcon, KanbanSquareIcon, MegaphoneIcon, PauseIcon, ReplyIcon } from "lucide-react";
import { TaskMark, type TaskMarkState } from "./TaskMark.js";
import { cn } from "@/lib/utils";
import { laneLabel } from "../left-off.js";
import { agentLook } from "./handoff-ui.js";
import { laneOf, meshOf, pendingFor, runOf, type SessionState } from "../session/projection.js";
import { MenuButton, type MenuItem } from "./ui.js";
import type { TodoStep } from "@/components/aicss/TodoList";
import { MAIN_LANE, type Member, type MeshNote, type SessionEvent } from "../types.js";
import type { Send } from "./useSession.js";
import { mateOn, TeamTalk } from "./Teammates.js";

/**
 * The agents in a session talking to each other (agent-mesh.ts), as the people watching read it: who wrote to whom, what, and
 * for a question the answer under it, one thread per exchange. Agent talk is never paused (Arun, 2026-10-20): an old log's
 * pause reads as settled.
 */

/** A message's words, cut to a few lines with the rest a press away: a full report pasted back can fill the screen. */
function Clamped({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 320 || text.split("\n").length > 4;
  return (
    <>
      <p className={cn("tk-text", long && !open && "clamped")}>{text}</p>
      {long && (
        <button type="button" className="tk-more" onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </>
  );
}

const KIND_WORD: Record<MeshNote["kind"], string> = { tell: "Told", ask: "Asked", task: "Task", reply: "Answer" };

type TalkStatus = { word: string; how: "wait" | "work" | "read" | "done" | "hold" | "quiet" | "bad" | "review" };

/**
 * Where a task handed to an agent stands now, read off the board and the agent's run: "on it" stayed on the card after the
 * agent stopped on its usage limit and the task had moved on (Arun, 2026-10-24: "make this entire coding session thing stable").
 */
export function taskStatus(state: SessionState, m: MeshNote, lane: string): TalkStatus {
  const run = runOf(state, lane).status;
  const t = m.board ? state.board?.tasks.find((x) => x.id === m.board) : undefined;
  if (t) {
    if (t.status === "cancelled") return { word: "Dropped", how: "quiet" };
    if (t.lane && t.lane !== lane && t.status !== "review") return { word: `Moved to ${t.name ?? laneLabel(state, t.lane)}`, how: "quiet" };
    if (t.status === "open") return { word: t.next ? `Moved, waiting for ${t.next}` : "Back on the board", how: "quiet" };
    if (t.status === "done") return { word: t.review?.ok ? "Done and checked" : "Done", how: "done" };
    if (t.status === "blocked") return { word: "Stuck", how: "bad" };
    if (t.status === "review") return { word: t.reviewer ? `${t.reviewer.name} is checking it` : "Waiting for a check", how: "review" };
  } else if (meshOf(state).asks[m.id]?.reply) return { word: "Reported back", how: "done" };
  if (run === "running") return { word: `${m.toName} is on it`, how: "work" };
  if (run === "waiting_for_human") return { word: `${m.toName} is waiting on a person`, how: "wait" };
  if (run === "error") return { word: `${m.toName} stopped`, how: "bad" };
  return { word: `${m.toName} hasn't finished it`, how: "wait" };
}

/**
 * One agent's message to another, drawn like the task board (Arun, 2026-10-19: "design this better like you did with the
 * task board"): who to whom with each one's mark, what kind of message in a word, the words in an inset panel cut to a few
 * lines, the answer or report in its own panel under it, and where it stands as a small pill at the foot, with the brake
 * while it is in motion.
 */
export function AgentTalkCard({ ev, state, me, send, notify, delivered, stamp, team }: { ev: SessionEvent; state: SessionState; me: Member; send: Send; notify: (m: string) => void; delivered: Set<number>; stamp: ReactNode; /** Everyone a message to the team went to (message_team), drawn once. */ team?: string[] }) {
  if (ev.body.type !== "instruction" || !ev.body.mesh) return null;
  const m: MeshNote = ev.body.mesh;
  const lane = ev.lane ?? MAIN_LANE;
  const mesh = meshOf(state);
  const ask = m.kind === "ask" ? mesh.asks[m.id] : undefined;
  const queued = pendingFor(state, lane).includes(ev.seq) || (!!mesh.paused && mesh.msgs.includes(ev.seq) && !delivered.has(ev.seq));
  const held = queued && !!mesh.paused;
  const from = agentLook(state, m.fromLane, 13);
  const to = agentLook(state, lane, 13);
  const kind = m.carriedFrom ? "Carried on" : team && team.length > 1 ? "To the team" : m.kind === "reply" && m.ofTask ? "Report" : m.board && m.review ? "Review" : KIND_WORD[m.kind];
  // Why it went to this agent, when Friday sent it: the one doing it ran out of usage partway (agent-mesh carryOn).
  const why = m.carriedFrom ? `${laneLabel(state, m.carriedFrom)} ran out of usage partway through, so Friday gave the task to ${m.toName}, with what it had done.` : "";
  // Where it stands, in a word or two and its colour (style.css --st-*): queued, held, being worked on, read, answered.
  const status: TalkStatus | null = held
    ? { word: "Held: agent talk is paused", how: "hold" }
    : queued
      ? { word: team && team.length > 1 ? `Sent to ${team.length} agents` : `Queued for ${m.toName}`, how: "wait" }
      : ask?.reply
        ? { word: "Answered", how: "done" }
        : ask && ask.unwaitedSeq !== undefined
          ? { word: `${m.fromName} stopped waiting; the answer goes to it as a message`, how: "quiet" }
          : ask
            ? { word: `${m.toName} is answering`, how: "work" }
            : m.kind === "task"
              ? taskStatus(state, m, lane)
              : delivered.has(ev.seq)
                ? { word: `Read by ${m.toName}`, how: "read" }
                : null;
  const moving = queued || (!!ask && !ask.reply);
  // A team (teammates.ts) reads it as a group chat (Teammates.tsx TeamTalk).
  if (state.options.team) return <TeamTalk fromLane={m.fromLane} toLane={lane} fromName={m.fromName} toName={m.toName} kind={m.kind} report={!!m.ofTask} review={!!(m.board && m.review)} carried={!!m.carriedFrom} {...(team ? { team } : {})} text={ev.body.text} why={why} {...(ask?.reply ? { answer: { text: ask.reply.text, auto: !!ask.reply.auto } } : {})} status={status} stamp={stamp} fromMark={from.mark} toMark={to.mark} />;
  return (
    <div className={cn("tk-card", moving && "waiting")}>
      <div className="tk-head">
        <span className="tk-route">
          <span className="tk-mark" style={{ "--tint": from.tint } as React.CSSProperties}>{from.mark}</span>
          <span className="tk-name">{m.fromName}</span>
          <ArrowRightIcon className="size-3 shrink-0 opacity-60" />
          {team && team.length > 1 ? (
            <span className="tk-name">{team.join(", ")}</span>
          ) : (
            <>
              <span className="tk-mark" style={{ "--tint": to.tint } as React.CSSProperties}>{to.mark}</span>
              <span className="tk-name">{m.toName}</span>
            </>
          )}
        </span>
        <span className={cn("tk-kind", `is-${m.kind}`)}>{kind}</span>
        {stamp}
      </div>
      {why && <p className="tk-why">{why}</p>}
      <div className="tk-panel">
        <Clamped text={ev.body.text} />
      </div>
      {ask?.reply && (
        <div className="tk-panel tk-answer">
          <div className="tk-answer-head">
            <ReplyIcon className="size-3.5 shrink-0" />
            <span>
              {m.toName} answered{ask.reply.auto ? " at the end of its turn" : ""}
            </span>
          </div>
          <Clamped text={ask.reply.text} />
        </div>
      )}
      {(status || moving) && (
        <div className="tk-foot">
          {status && (
            <span className={cn("tk-status", `is-${status.how}`)}>
              {status.how === "work" ? <span className="ring-spin" aria-hidden="true" /> : status.how === "done" || status.how === "read" ? <CheckIcon className="size-3 shrink-0" /> : <i className="tk-dot" aria-hidden="true" />}
              {status.word}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * An agent's update to the rest (post_update): the open line, which wakes nobody. Who has read it so far, since that is what
 * the people watching want to know of a message to everyone.
 */
export function AgentUpdateCard({ ev, state, stamp }: { ev: SessionEvent; state: SessionState; stamp: ReactNode }) {
  if (ev.body.type !== "mesh.posted") return null;
  const b = ev.body;
  const read = meshOf(state).readUpTo ?? {};
  const others = [MAIN_LANE, ...state.lanes.map((l) => l.id)].filter((l) => l !== b.fromLane);
  const readers = others.filter((l) => (read[l] ?? 0) >= ev.seq).map((l) => laneLabel(state, l));
  const status = !others.length ? "" : readers.length === others.length ? (others.length === 1 ? `Read by ${readers[0]}` : "Read by every agent") : readers.length ? `Read by ${readers.join(", ")}` : "Not read yet";
  const look = agentLook(state, b.fromLane, 13);
  // A team (teammates.ts) reads it as a group chat: one teammate's word to the rest.
  if (state.options.team) return <TeamTalk fromLane={b.fromLane} toLane="" fromName={b.fromName} toName="everyone" kind="tell" team={others} text={b.text} status={status ? { word: status, how: readers.length === others.length ? "done" : "wait" } : null} stamp={stamp} fromMark={look.mark} />;
  return (
    <div className="tk-card">
      <div className="tk-head">
        <span className="tk-route">
          <span className="tk-mark" style={{ "--tint": look.tint } as React.CSSProperties}>{look.mark}</span>
          <span className="tk-name">{b.fromName}</span>
          <ArrowRightIcon className="size-3 shrink-0 opacity-60" />
          <span className="tk-mark"><MegaphoneIcon className="size-3" /></span>
          <span className="tk-name">Everyone</span>
        </span>
        <span className="tk-kind is-update">Update</span>
        {stamp}
      </div>
      <div className="tk-panel">
        <Clamped text={b.text} />
      </div>
      {status && (
        <div className="tk-foot">
          <span className={cn("tk-status", readers.length === others.length ? "is-done" : "is-wait")}>
            {readers.length === others.length ? <CheckIcon className="size-3 shrink-0" /> : <i className="tk-dot" aria-hidden="true" />}
            {status}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * The shared task board (agent-mesh.ts post_tasks), as it stands now: each task, who has it, what it waits on, and whether it
 * is done and checked. Live on the newest board; an older one says it was replaced.
 */
export function BoardCard({ ev, state, stamp }: { ev: SessionEvent; state: SessionState; stamp: ReactNode }) {
  if (ev.body.type !== "board.posted" || !ev.body.tasks.length) return null;
  const live = state.board?.seq === ev.seq ? state.board : null;
  const tasks = live?.tasks ?? ev.body.tasks.map((t) => ({ ...t, status: "open" as const, rounds: 0 }));
  const done = tasks.filter((t) => t.status === "done").length;
  // Who has it by its name now, not the name its lane had when it took it (a teammate's lane read "Main"); and "is on it" only
  // while that agent is at work: a task held by an agent that was stopped spun on as if it were being done (2026-10-27 audit).
  let nameOf = (lane: string): string | undefined => state.lanes.find((l) => l.id === lane)?.name;
  nameOf = (lane) => mateOn(lane)?.name ?? state.lanes.find((l) => l.id === lane)?.name;
  // A lane since taken away is told by the name it had, never by its id ("blocked · lyXFP7w", 2026-10-28 audit).
  const who = (t: (typeof tasks)[number]) => {
    const lane = "lane" in t ? t.lane : undefined;
    const said = "name" in t ? t.name : undefined;
    return (lane ? nameOf(lane) : undefined) ?? (said && said !== lane ? said : undefined);
  };
  const atWork = (t: (typeof tasks)[number]) => !("lane" in t && t.lane) || ["running", "waiting_for_human"].includes(runOf(state, t.lane).status);
  const mark = (t: (typeof tasks)[number]): TaskMarkState => (t.status === "done" ? "done" : t.status === "claimed" ? (atWork(t) ? "working" : "open") : t.status === "review" ? "review" : t.status === "blocked" ? "blocked" : "open");
  const word = (t: (typeof tasks)[number]) =>
    // A board since replaced shows its tasks as they were posted, not as "ready": it isn't live, and its tasks' state moved on
    // to the newer one (2026-10-28 audit, Arun's room).
    !live
      ? ""
      : "checks" in t && t.checks?.running
      ? `${who(t)} finished · checks running`
      : t.status === "cancelled"
        ? "dropped"
        : t.status === "done"
      ? `${who(t) ?? ""}${"review" in t && t.review ? ` · checked by ${t.review.by}` : ""}`
      : t.status === "claimed" && !atWork(t)
        ? `${who(t)} has it · not working on it now`
      : t.status === "claimed"
        ? `${who(t)} is on it${"rounds" in t && t.rounds ? ("checks" in t && t.checks?.ok === false ? " again, after its checks failed" : " again, after a review") : ""}`
        : t.status === "review"
          ? `${who(t)} finished${"reviewer" in t && t.reviewer ? ` · ${t.reviewer.name} is checking` : " · waiting for a check"}`
          : t.status === "blocked"
            ? `blocked${who(t) ? ` · ${who(t)}` : ""}`
            : t.after.length
              ? `after ${t.after.join(", ")}`
              : "ready";
  return (
    <div className="peer-card talk-card board-card">
      <div className="peer-head">
        <KanbanSquareIcon className="size-3.5 shrink-0" />
        <span className="peer-title">
          {ev.body.fromName}'s task board <span className="talk-verb">· {live ? `${done} of ${tasks.length} done` : "replaced by a newer one"}</span>
        </span>
        {stamp}
      </div>
      <ul className="board-tasks">
        {tasks.map((t) => (
          <li key={t.id} className={cn("board-task", `is-${t.status}`)} data-task={t.id}>
            <TaskMark state={mark(t)} />
            <span className="board-title">{t.title}</span>
            <span className="board-who">{word(t)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Agent talk paused, as a card like the agents' messages: what stopped it and why, how many messages wait behind it, and the
 * way to let them go on. Once resumed (or paused again since) it settles, with the reason still there to read.
 */
export function MeshPauseCard({ ev, state, me, send, notify, stamp }: { ev: SessionEvent; state: SessionState; me: Member; send: Send; notify: (m: string) => void; stamp: ReactNode }) {
  if (ev.body.type !== "mesh.paused" || !ev.body.on) return null;
  const mesh = meshOf(state);
  const current = mesh.paused?.seq === ev.seq;
  const byFriday = ev.actor.kind === "system";
  const who = ev.actor.id === me.id ? "You" : ev.actor.name;
  // The agents' messages waiting in a queue while it holds: they go the moment someone resumes.
  const queues = [state.pendingInstructions, ...Object.values(state.lanePending)];
  const held = current ? queues.flat().filter((seq) => mesh.msgs.includes(seq)).length : 0;
  const why = ev.body.why ? ev.body.why.charAt(0).toUpperCase() + ev.body.why.slice(1) : "";
  return (
    <div className={cn("tk-card pause-card", current && "is-live")}>
      <div className="tk-head">
        <span className="tk-route">
          <span className="tk-mark pause-mark">
            <PauseIcon className="size-3" />
          </span>
          <span className="tk-name">{byFriday ? "Agent talk paused" : `${who} paused agent talk`}</span>
        </span>
        <span className={cn("tk-kind", byFriday ? "is-ask" : "")}>{byFriday ? "Limit reached" : "Paused"}</span>
        {stamp}
      </div>
      {(why || byFriday) && (
        <div className="tk-panel">
          {why && <p className="tk-text">{why.endsWith(".") ? why : `${why}.`}</p>}
          {byFriday && current && <p className="pause-hint">Friday stopped them so they don't go round in circles. Read the thread above, then let them go on or tell them what to do.</p>}
        </div>
      )}
      <div className="tk-foot">
        <span className={cn("tk-status", current ? "is-hold" : "is-done")}>
          {current ? <i className="tk-dot" aria-hidden="true" /> : <CheckIcon className="size-3 shrink-0" />}
          {current ? (held ? `${held} message${held === 1 ? "" : "s"} held` : "Waiting for you") : "Resumed"}
        </span>
      </div>
    </div>
  );
}

/** "Agent talk paused", or resumed, in a line, with the way back. */
export function MeshPauseText({ ev, state, me, send, notify }: { ev: SessionEvent; state: SessionState; me: Member; send: Send; notify: (m: string) => void }) {
  if (ev.body.type !== "mesh.paused") return null;
  const who = ev.actor.id === me.id ? "You" : ev.actor.name;
  const current = meshOf(state).paused?.seq === ev.seq;
  if (!ev.body.on) return <>{who} let the agents message each other again</>;
  return (
    <>
      {ev.actor.kind === "system" ? `Agent talk paused: ${ev.body.why ?? "a limit was reached"}. Read the thread before letting it go on.` : `${who} paused the agents messaging each other`}
    </>
  );
}

/** A message as a task's name: its first line, without a greeting or a "please", cut to fit a row. */
function taskTitle(text: string): string {
  const line = (text.split("\n").find((l) => l.trim()) ?? text).trim().replace(/^(?:hi|hey|hello)[^,.:!]*[,.:!]\s*/i, "").replace(/^please\s+/i, "");
  const t = line.charAt(0).toUpperCase() + line.slice(1);
  return t.length > 90 ? `${t.slice(0, 89).trimEnd()}…` : t;
}

/**
 * Everything the agents handed each other to do, and where each stands, for the list above the composer (Arun, 2026-10-19: "the
 * tasks to do list thing but for the agents talking and working together, so I can see the status of each of the tasks that was
 * delegated"): the shared board's tasks, then what an agent assigned another (assign_task). A row says who has it and in a word
 * where it is, and pressing it goes to where it was handed over.
 */
export type TaskAction = "reassign" | "retry" | "sendback" | "cancel";

export function teamTasks(state: SessionState, jump: (seq: number) => void, control?: (id: string, action: TaskAction, to?: string) => void): TodoStep[] {
  const mesh = meshOf(state);
  let boardName = (_lane: string): string | undefined => undefined;
  boardName = (lane) => mateOn(lane)?.name;
  const who = (lane: string | undefined, name: string | undefined) => {
    if (!lane && !name) return undefined;
    const look = lane ? agentLook(state, lane, 12) : null;
    return (
      <>
        {look && (
          <span className="tk-mark tt-mark" style={{ "--tint": look.tint } as React.CSSProperties}>
            {look.mark}
          </span>
        )}
        {/* The teammate's name as it is now, and never a lane's id for a name (a lane since taken away). */}
        <span>{(lane && boardName(lane)) || (name && name !== lane ? name : lane ? laneLabel(state, lane) : "")}</span>
      </>
    );
  };
  const out: TodoStep[] = [];
  const board = state.board;
  if (board) {
    const byId = new Map(board.tasks.map((t) => [t.id, t]));
    for (const t of board.tasks) {
      const waits = t.after.map((d) => byId.get(d)).filter((d) => d && d.status !== "done");
      const base = { id: `b:${t.id}`, title: t.title, detail: t.detail ? `${t.title}: ${t.detail}` : t.title, onSelect: () => jump(board.seq), ...(control ? { actions: taskMenu(state, t, control) } : {}) };
      if (t.status === "cancelled") out.push({ ...base, status: "cancelled", note: "Dropped" });
      else if (t.checks?.running) out.push({ ...base, status: "active", note: "Running checks", who: who(t.lane, t.name) });
      else if (t.status === "claimed" && t.rounds && t.checks?.ok === false) out.push({ ...base, status: "active", note: "Fixing failed checks", tone: "warn", who: who(t.lane, t.name) });
      else if (t.status === "done") out.push({ ...base, status: "completed", note: t.review?.ok ? "Checked" : "Done", who: who(t.lane, t.name) });
      // Why, in its agent's own words, on hover: "Stuck" alone left a person guessing which of five reasons it was.
      else if (t.status === "blocked") out.push({ ...base, status: "pending", note: "Stuck", tone: "bad", who: who(t.lane, t.name), detail: `${t.title}: ${(t.report ?? "").split("\n").find((l) => l.trim())?.slice(0, 240) ?? "no report"}` });
      else if (t.status === "review") out.push({ ...base, status: "active", note: t.reviewer ? `${t.reviewer.name} checking` : "Waiting for a check", who: who(t.lane, t.name) });
      else if (t.status === "claimed" && t.why) {
        // Why the board picked this agent, on hover with the task: "best at tests here", "the others are nearly out of usage".
        const run = t.lane ? runOf(state, t.lane).status : "running";
        out.push({ ...base, detail: `${base.detail}\n\nWhy ${t.name}: ${t.why}.`, status: run === "running" ? "active" : "pending", note: run === "running" ? (t.rounds ? "Fixing" : "Working") : run === "error" ? "Stopped" : "Not finished", ...(run === "error" ? { tone: "bad" as const } : run !== "running" ? { tone: "warn" as const } : {}), who: who(t.lane, t.name) });
      } else if (t.status === "claimed") {
        // Claimed says who took it, not that they are on it now: "Working" only while that agent's run goes (Arun, 2026-10-20:
        // "actually accurate"). One that stopped, failed or went quiet without finishing says so.
        const run = t.lane ? runOf(state, t.lane).status : "running";
        if (run === "running") out.push({ ...base, status: "active", note: t.rounds ? "Fixing" : "Working", who: who(t.lane, t.name) });
        else if (run === "waiting_for_human") out.push({ ...base, status: "active", note: "Needs you", tone: "warn", who: who(t.lane, t.name) });
        else if (run === "error") out.push({ ...base, status: "pending", note: "Stopped", tone: "bad", who: who(t.lane, t.name) });
        else out.push({ ...base, status: "pending", note: "Not finished", tone: "warn", who: who(t.lane, t.name) });
      }
      else if (waits.length) out.push({ ...base, status: "pending", note: `After ${waits[0]!.title.length > 24 ? `${waits[0]!.title.slice(0, 23)}…` : waits[0]!.title}${waits.length > 1 ? ` +${waits.length - 1}` : ""}` });
      else out.push({ ...base, status: "pending", note: t.next ? `Waiting for ${t.next}` : "Ready", ...(t.next || t.agent ? { who: who(undefined, t.next ?? t.agent) } : {}) });
    }
  }
  // The current round only: a task assigned once everything before it had reported back starts a new one, so a long session
  // shows what is being worked on now rather than every task it ever handed out.
  const assigned = Object.values(mesh.asks).filter((a) => a.task).sort((x, y) => x.seq - y.seq);
  let from = 0;
  assigned.forEach((a, i) => {
    if (i && assigned.slice(0, i).every((p) => p.reply && p.reply.seq < a.seq)) from = i;
  });
  const round = assigned.slice(from);
  // A board from before this round, all of it done, is the last round's.
  if (board && round.length && board.seq < round[0]!.seq && board.tasks.every((t) => t.status === "done")) out.length = 0;
  for (const a of round) {
    const base = { id: `a:${a.id}`, title: taskTitle(a.text), detail: `${a.fromName} → ${a.toName}: ${a.text.slice(0, 400)}`, onSelect: () => jump(a.seq), who: who(a.toLane, a.toName) };
    const queued = pendingFor(state, a.toLane).includes(a.seq) || (!!mesh.paused && (a.toLane === MAIN_LANE ? state.pendingInstructions : (state.lanePending[a.toLane] ?? [])).includes(a.seq));
    // Stopped before it was done (a stop, an error, a usage limit): still to do, not reported back.
    if (a.reply?.short) out.push({ ...base, status: "pending", note: "Stopped", tone: "bad" });
    else if (a.reply) out.push({ ...base, status: "completed", note: "Reported back" });
    else if (queued) out.push({ ...base, status: "pending", note: mesh.paused ? "Held" : "Queued", ...(mesh.paused ? { tone: "warn" as const } : {}) });
    else if (runOf(state, a.toLane).status === "running") out.push({ ...base, status: "active", note: "Working" });
    else if (runOf(state, a.toLane).status === "waiting_for_human") out.push({ ...base, status: "active", note: "Needs you", tone: "warn" });
    else if (runOf(state, a.toLane).status === "error") out.push({ ...base, status: "pending", note: "Stopped", tone: "bad" });
    else out.push({ ...base, status: "active", note: "No report yet", tone: "warn" });
  }
  // What is being worked on first, then what waits, then what is finished (Arun, 2026-10-21: "the ones being worked on should
  // be on top, then queued, then finished"). In the order handed out within each.
  return out.map((t, i) => [t, i] as const).sort(([x, i], [y, j]) => RANK[x.status] - RANK[y.status] || i - j).map(([t]) => t);
}
const RANK: Record<TodoStep["status"], number> = { active: 0, pending: 1, completed: 2, cancelled: 3 };

/** What a person can do to a board task from the team's list, as a small menu at the end of its row. */
function taskMenu(state: SessionState, t: NonNullable<SessionState["board"]>["tasks"][number], control: (id: string, action: TaskAction, to?: string) => void): ReactNode {
  if (t.status === "done" && !t.lane) return null;
  const agents = [MAIN_LANE, ...state.lanes.map((l) => l.id)].filter((l) => laneOf(state, l)?.control.kind !== "standing" && l !== t.lane);
  const items: MenuItem[] = [];
  if (t.status === "blocked" || t.status === "cancelled") items.push({ label: "Try again", icon: "refresh", onSelect: () => control(t.id, "retry") });
  if (t.status !== "done" && t.status !== "cancelled") {
    if (agents.length) items.push({ heading: t.status === "open" ? "Give it to" : "Hand it to" });
    for (const l of agents) items.push({ label: laneLabel(state, l), mark: agentLook(state, l, 13).mark, onSelect: () => control(t.id, "reassign", laneLabel(state, l)) });
  }
  if (t.status === "done" || t.status === "review") items.push({ label: "Send back", icon: "rewind", onSelect: () => control(t.id, "sendback") });
  if (t.status !== "done" && t.status !== "cancelled") items.push({ label: "Drop it", icon: "x", danger: true, onSelect: () => control(t.id, "cancel") });
  if (!items.length) return null;
  return <MenuButton items={() => items} label={`Change "${t.title}"`} icon="moreV" compact className="icon-btn tiny tt-more" />;
}
