import { useContext, useEffect, useMemo, useState } from "react";
import { ThreadsCtx } from "./threads-data.js";
import { ArrowRightIcon, UsersIcon } from "lucide-react";
import { MenuButton } from "./ui.js";
import { lanesOf } from "../agent-state.js";
import { cn } from "@/lib/utils";
import { agentNameFor as laneLabel } from "./agent-name.js";
import { doingNow } from "../activity-line.js";
import { agentLook } from "./handoff-ui.js";
import { focusAgent } from "./agentFocus.js";
import { useNow } from "./presence.js";
import { meshOf, runOf, type SessionState } from "../session/projection.js";
import { missedSince } from "../session/catchup.js";
import { MAIN_LANE, type MeshNote, type SessionEvent } from "../types.js";
import type { Send } from "./useSession.js";
import { span, type TeamInfo } from "./team-thread.js";
import "./team-card.css";

export { teamsIn, type TeamInfo } from "./team-thread.js";

/**
 * The lead's team card (Arun, 2026-11-16, multi-agent mockup A: "build A with B"): when one agent hands work to two or more
 * others between two of the person's messages, the whole team is one live card where the work was handed out, rather than a
 * card per task. A row per agent: its part, where it is this minute, how long, and Answer when it is waiting on the person.
 * Stop all stops every agent of the team at work. The reports back fold into the rows (each ends "Done · …").
 */

type RowState = "work" | "need" | "done" | "bad" | "wait";
interface Row {
  lane: string;
  name: string;
  role: string;
  state: RowState;
  line: string;
  start: number;
  end: number | null;
}

const firstLine = (t: string) => (t.split("\n").find((l) => l.trim()) ?? t).trim().replace(/^[#>*\-\s]+/, "").replace(/\*\*/g, "");
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** An agent held up on the person: a question to them, a permission to answer, or its run waiting. */
const onPerson = (state: SessionState, lane: string) => runOf(state, lane).status === "waiting_for_human" || !!state.openQuestions[lane] || !!state.approvals[lane];

function needLine(state: SessionState, lane: string, name: string): string {
  const q = state.openQuestions[lane];
  if (q) return `${name} asks: ${firstLine(q.question)}`;
  const a = state.approvals[lane];
  if (a?.items[0]) return `${name} asks to run ${firstLine(a.items[0])}`;
  return `${name} is waiting on you`;
}

export function teamRows(info: TeamInfo, state: SessionState, events: readonly SessionEvent[]): Row[] {
  const mesh = meshOf(state);
  const tsOf = (seq: number) => events.find((e) => e.seq === seq)?.ts ?? null;
  const evs = events as SessionEvent[];
  // One row an agent: a second task to the same agent is its part now.
  const latest = new Map<string, SessionEvent>();
  for (const e of info.tasks) latest.set(e.lane ?? MAIN_LANE, e);
  const rows: Row[] = [];
  for (const [lane, e] of latest) {
    const m = (e.body as { mesh: MeshNote }).mesh;
    const name = laneLabel(state, lane);
    const ask = mesh.asks[m.id];
    const run = runOf(state, lane).status;
    const role = clip(m.title ?? firstLine((e.body as { text: string }).text), 60);
    const reply = ask?.reply;
    let st: RowState;
    let line: string;
    if (onPerson(state, lane)) (st = "need"), (line = needLine(state, lane, name));
    else if (run === "running") (st = "work"), (line = `${name} · ${doingNow(evs, lane)?.text ?? "Working"}`);
    else if (reply && !reply.short) (st = "done"), (line = `Done · ${firstLine(reply.text)}`);
    else if (reply?.short || run === "error") (st = "bad"), (line = `${name} stopped before it was done`);
    else (st = "wait"), (line = `${name} hasn't started it yet`);
    const end = st === "work" || st === "need" ? null : reply ? tsOf(reply.seq) : null;
    rows.push({ lane, name, role, state: st, line, start: e.ts, end });
  }
  // The lead's own row: its part is to bring the pieces together.
  const leadRun = runOf(state, info.lead).status;
  const open = rows.some((r) => r.state === "work" || r.state === "need" || r.state === "wait");
  const leadName = laneLabel(state, info.lead);
  const lead: Row = onPerson(state, info.lead)
    ? { lane: info.lead, name: leadName, role: "Lead", state: "need", line: needLine(state, info.lead, leadName), start: info.tasks[0]!.ts, end: null }
    : leadRun === "running"
      ? { lane: info.lead, name: leadName, role: "Lead", state: "work", line: `${leadName} · ${doingNow(evs, info.lead)?.text ?? "Working"}`, start: info.tasks[0]!.ts, end: null }
      : { lane: info.lead, name: leadName, role: "Lead", state: open ? "wait" : "done", line: open ? `${leadName} · waiting on the team` : `${leadName} · brought it together`, start: info.tasks[0]!.ts, end: open ? null : Math.max(...rows.map((r) => r.end ?? 0)) || null };
  return [lead, ...rows];
}

export function TeamCard({ info, state, events, send, notify, sid }: { info: TeamInfo; state: SessionState; events: readonly SessionEvent[]; send: Send; notify: (m: string) => void; sid: string }) {
  const rows = teamRows(info, state, events);
  const working = rows.filter((r) => r.state === "work").length;
  const needs = rows.filter((r) => r.state === "need").length;
  const live = working + needs > 0;
  const now = useNow(live ? 1000 : 60_000);
  const start = info.tasks[0]!.ts;
  const end = live ? now : Math.max(start, ...rows.map((r) => r.end ?? 0));
  const sum = [working ? `${working} working` : "", needs ? `${needs} need${needs > 1 ? "" : "s"} you` : "", !live ? (rows.every((r) => r.state === "done") ? "all done" : "stopped") : ""].filter(Boolean).join(" · ");
  const stopAll = () => {
    const lanes = rows.filter((r) => r.state === "work").map((r) => r.lane);
    void Promise.all(lanes.map((lane) => send({ type: "run.pause", ...(lane !== MAIN_LANE ? { lane } : {}) }))).then((rs) => notify(rs.every((r) => r.ok) ? `Stopped ${lanes.length === 1 ? rows.find((r) => r.state === "work")!.name : `${lanes.length} agents`}.` : "Couldn't stop every agent."));
  };
  const open = (lane: string) => focusAgent(sid, lane);
  return (
    <div className={cn("team-card", live && "live")}>
      <div className="team-head">
        <UsersIcon className="size-3.5 team-head-icon" aria-hidden />
        <b>Team of {rows.length}</b>
        <span className="team-sum">
          {sum} · {span(end - start)}
        </span>
        {working > 0 && (
          <button type="button" className="team-stop" onClick={stopAll} title="Stop every agent of this team at work (each stays free for the next task)">
            Stop all
          </button>
        )}
      </div>
      <ul className="team-rows">
        {rows.map((r) => {
          const look = agentLook(state, r.lane, 14);
          return (
            <li key={r.lane}>
              <button type="button" className={cn("team-row", `is-${r.state}`)} onClick={() => open(r.lane)} title={`Open ${r.name}'s tab`}>
                <span className={cn("team-ring", `is-${r.state}`)} aria-hidden />
                <span className="team-mark" style={{ "--tint": look.tint } as React.CSSProperties}>
                  {look.mark}
                </span>
                <span className="team-role" title={r.role}>
                  {r.role}
                </span>
                <span className="team-line" title={r.line}>
                  {r.line}
                </span>
                {r.state === "need" ? (
                  <span
                    role="button"
                    tabIndex={0}
                    className="team-answer"
                    onClick={(e) => {
                      e.stopPropagation();
                      open(r.lane);
                      requestAnimationFrame(() => document.querySelector(`[data-needs="${CSS.escape(r.lane)}"]`)?.scrollIntoView({ block: "nearest" }));
                    }}
                    onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLElement).click()}
                  >
                    Answer
                  </span>
                ) : (
                  <span className="team-time">{r.state === "wait" ? "" : span((r.end ?? now) - r.start)}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Under a person's message that turns to another agent than the one that worked last (mockup B): "Claude Code → Codex · Codex
 * took over · given what it missed: 1 turn, 2 files". What it was given is what the hub hands it (catchup.ts missedSince), from
 * the same log, so the line says what the agent was told, no more.
 */
export function TakeOver({ ev, state, events }: { ev: SessionEvent; state: SessionState; events: readonly SessionEvent[] }) {
  const info = useMemo(() => {
    const b = ev.body;
    if (b.type !== "instruction" || b.mesh || b.peer || b.handoff || b.approval || ev.actor.kind !== "human" || state.options.team) return null;
    if (Object.keys(state.engines).length < 2) return null;
    const to = ev.lane ?? MAIN_LANE;
    // A message sent to several agents at once is a copy on each lane: nobody took over from anybody.
    if (events.some((e) => e.seq !== ev.seq && Math.abs(e.seq - ev.seq) < 8 && e.body.type === "instruction" && e.body.text === b.text && (e.lane ?? MAIN_LANE) !== to)) return null;
    // Who the thread was with: the agent that last worked, or the one the person last wrote to, whichever came later.
    let from: string | null = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.seq >= ev.seq) continue;
      const x = e.body;
      if (x.type === "run.started" || (x.type === "instruction" && e.actor.kind === "human" && !x.mesh && !x.peer && !x.approval)) {
        from = e.lane ?? MAIN_LANE;
        break;
      }
    }
    if (from === null || from === to) return null;
    const before = events.some((e) => e.seq < ev.seq && (e.lane ?? MAIN_LANE) === to && e.body.type === "instructions.delivered");
    const missed = before ? missedSince(state, events, to, [ev.seq], ev.seq) : [];
    const files = new Set(missed.flatMap((m) => m.files)).size;
    return { from, to, before, turns: missed.length, files };
  }, [ev, state, events]);
  if (!info) return null;
  const toName = laneLabel(state, info.to);
  const what = !info.before
    ? `${toName} joins · given where the thread stands`
    : info.turns
      ? `${toName} took over · given what it missed: ${info.turns} turn${info.turns > 1 ? "s" : ""}${info.files ? `, ${info.files} file${info.files > 1 ? "s" : ""}` : ""}`
      : `${toName} took over`;
  const mark = (lane: string) => {
    const look = agentLook(state, lane, 12);
    return (
      <span className="team-mark small" style={{ "--tint": look.tint } as React.CSSProperties} title={laneLabel(state, lane)}>
        {look.mark}
      </span>
    );
  };
  return (
    <div className="takeover" role="separator" aria-label={`${laneLabel(state, info.from)} to ${what}`}>
      {mark(info.from)}
      <ArrowRightIcon className="size-3 takeover-arrow" aria-hidden />
      {mark(info.to)}
      <span>{what}</span>
    </div>
  );
}


/**
 * The lead's team put to the person before it starts (Arun, 2026-11-16, "Do 5", the multi-agent mockups' option 2): each task, the
 * agent it is meant for (changed in place) and the files it owns. Start the team hands them out; Just you do it drops them and
 * tells the lead to do the whole of it itself. Nothing has started while it shows.
 */
export function ProposedTeam({ ev, state, send, notify }: { ev: SessionEvent; state: SessionState; send: Send; notify: (m: string) => void }) {
  const [busy, setBusy] = useState("");
  if (ev.body.type !== "board.posted") return null;
  const b = state.board;
  const tasks = b?.seq === ev.seq ? b.tasks : [];
  const lead = ev.body.fromLane;
  const lanes = lanesOf(state);
  const laneByName = (n: string | undefined) => (n ? lanes.find((l) => laneLabel(state, l).toLowerCase() === n.toLowerCase() || state.lanes.find((x) => x.id === l)?.name.toLowerCase() === n.toLowerCase()) : undefined);
  const act = (action: "start" | "decline") => {
    setBusy(action);
    void send({ type: "board.task", id: "", action }).then((r) => {
      setBusy("");
      if (!r.ok) notify(r.error ?? "Couldn't do that.");
    });
  };
  const leadLook = agentLook(state, lead, 14);
  return (
    <div className="team-card proposed">
      <div className="team-head">
        <UsersIcon className="size-3.5 team-head-icon" aria-hidden />
        <b>Proposed team</b>
        <span className="team-sum">
          {tasks.length} task{tasks.length === 1 ? "" : "s"} from {laneLabel(state, lead)} · nothing has started
        </span>
      </div>
      <ul className="team-rows">
        {tasks.map((t) => {
          const lane = laneByName(t.next ?? t.agent);
          const look = lane ? agentLook(state, lane, 14) : null;
          return (
            <li key={t.id}>
              <div className="team-row is-prop">
                <span className="team-ring" aria-hidden />
                <span className="team-mark" style={look ? ({ "--tint": look.tint } as React.CSSProperties) : undefined}>
                  {look?.mark ?? <UsersIcon className="size-3" />}
                </span>
                <span className="team-role" title={t.title}>
                  {t.title}
                </span>
                <span className="team-line" title={t.owns.join(", ")}>
                  {t.owns.length ? t.owns.slice(0, 3).join(", ") + (t.owns.length > 3 ? ` +${t.owns.length - 3}` : "") : t.after.length ? `after ${t.after.join(", ")}` : ""}
                </span>
                <MenuButton
                  compact
                  className="team-pick"
                  label={`Who does “${t.title}”`}
                  text={lane ? laneLabel(state, lane) : "Next free agent"}
                  items={() => [
                    { heading: "Who does it" },
                    ...lanes.map((l) => ({ label: laneLabel(state, l), mark: agentLook(state, l, 14).mark, checked: l === lane, onSelect: () => void send({ type: "board.task", id: t.id, action: "reassign", to: laneLabel(state, l) }).then((r) => !r.ok && notify(r.error ?? "Couldn't change that.")) })),
                  ]}
                />
              </div>
            </li>
          );
        })}
      </ul>
      <div className="team-foot">
        <button type="button" className="team-go" disabled={!!busy} onClick={() => act("start")}>
          {busy === "start" ? <span className="spinner" /> : null}
          Start the team
        </button>
        <button type="button" className="team-stop" disabled={!!busy} onClick={() => act("decline")} title={`Drop these tasks and have ${laneLabel(state, lead)} do all of it`}>
          Just {laneLabel(state, lead)} does it
        </button>
        <span className="team-foot-note">
          <span className="team-mark small" style={{ "--tint": leadLook.tint } as React.CSSProperties}>
            {leadLook.mark}
          </span>
          leads it
        </span>
      </div>
    </div>
  );
}

const openSession = (sid: string, invite?: string) => dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid, ...(invite ? { invite } : {}) } }));

/**
 * A thread an agent here opened for a separate piece of work (app-tools start_session; Arun, 2026-11-16, "Also work on 8", T3's
 * agents opening threads): one line where it happened, its ring and Open, and the thread filed with the project's others, so it
 * is a tab and a sidebar row at once.
 */
export function OpenedThread({ ev, state }: { ev: SessionEvent; state: SessionState }) {
  const threads = useContext(ThreadsCtx);
  const b = ev.body.type === "thread.started" ? ev.body : null;
  // Filed in this thread's project, as soon as that is known: on the list without it (from the session list, or before this
  // thread's own folder was), it would be a sidebar row but not a tab here.
  const here = threads?.recents.find((r) => r.sid === state.id);
  const repo = here?.repos?.find((r) => r.path);
  const filedIn = !!b && !!threads?.recents.find((r) => r.sid === b.sid)?.repos?.some((x) => x.path === repo?.path);
  useEffect(() => {
    if (!b || !threads || filedIn || !repo) return;
    threads.remember({ sid: b.sid, title: b.title, invite: b.invite, role: "owner", openedAt: ev.ts, ...(here?.projectId ? { projectId: here.projectId } : {}), repos: [{ ...repo, live: true, worktree: true }] });
  }, [b?.sid, filedIn, repo?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!b) return null;
  return (
    <div className="opened-thread">
      <span className="opened-ring">{threads?.ring(b.sid, false)}</span>
      <span className="opened-text">
        <b>{b.fromName}</b> opened a thread · <span className="opened-title">{b.title}</span>
      </span>
      <button type="button" className="team-stop" onClick={() => openSession(b.sid, b.invite)}>
        Open
      </button>
    </div>
  );
}
