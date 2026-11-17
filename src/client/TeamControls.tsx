/**
 * The team's own controls in a team chat's header, and the banners that say what they set (Arun, 2026-10-28: "go all out and
 * improve and make this better", "do not stop till the teams stuff is fully solid and actually really good"):
 *
 * - Stop all, while anyone works: every teammate's running turn cut short, everywhere, their queues kept (⌘., asked first with who
 *   is cut short).
 * - Away until 8:00 AM: the team decides for itself and notes what it assumed, until then, or until the person writes or says
 *   they're back; then the morning brief (Arun, 2026-10-28: "we need to ensure teams can work basically while you are away").
 * - Pause team: every queue, check-in and wake held, a banner saying so.
 * - Threads: the room's side threads, open and answered, in one list.
 * - Board: the room's task board as a kanban (TeamBoard.tsx).
 * - Workflows: the team's automations, each run a board in a room (TeamWorkflows.tsx).
 *
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons.js";
import { TimeField } from "./time-field.js";
import { ChartColumnIcon, SendIcon, ChevronLeftIcon, ChevronRightIcon, EllipsisIcon, PencilIcon, PlusIcon, XIcon, InfinityIcon, PanelRightIcon, ListChecksIcon, FileCodeIcon, FileTextIcon, GitPullRequestIcon, ImageIcon, PackageIcon, CirclePauseIcon, KanbanSquareIcon, MessagesSquareIcon, MoonIcon, PlayIcon, SquareIcon, SunIcon, WorkflowIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { SessionEvent } from "../types.js";
import type { SessionState } from "../session/projection.js";
import { api } from "./api.js";
import { MenuButton, Picker, useConfirm, type MenuItem } from "./ui.js";
import { focusAgent } from "./agentFocus.js";
import type { Identity } from "./storage.js";
import type { Send } from "./useSession.js";
import { comeBack, nextAt, nextEight, setAway, setPaused, setSelfRun, stopAll, untilOf } from "./team-api.js";
import { threadsOf } from "./team-threads.js";
import { teamCommand } from "./team-commands.js";
import { plainLine } from "./team-room.js";
import { agoShort, Face, foldersOf, MateRing, markStopped, mateOn, mateStatus, openThread, ownOf, refreshTeam, RoomFaces, short, threadSaid, useTeamNow, isTeamSid, type RoomView } from "./Teammates.js";
import type { TeammateView } from "../teammates.js";
import { WorkspaceCard } from "./Workspace.js";
import { SpendPage } from "./SpendPage.js";
import { openBring } from "./crew-carry-open.js";
import { loadRecents } from "./storage.js";
import { assignedTasks, TeamBoard } from "./TeamBoard.js";
import { proofsIn } from "../team-proof.js";
import { ProofToggle } from "./ProofCard.js";
import { openWorkflows } from "./team-workflow-view.js";
import { SkillsDialog, skillsWaiting, useSkills } from "./CrewSkills.js";
import { isLocal } from "./edition.js";
import { DEFAULT_RUN_TOKENS, RUN_BUDGETS, runBudgetLine } from "../team-budget.js";

/**
 * In the local edition, stepping away, coming back and a stop are each a line in the Crew room (Activity.tsx team.away, run.pause),
 * so no toast says them again over it (audit CREW-23, 2026-11-04); the hosted service posts no such line and keeps its toasts.
 */
const awaySaid = (until: number) => (isLocal() ? "" : `Away until ${untilOf(until)}. The crew carries on without asking.`);
const sayIf = (notify: (m: string) => void, said: string) => void (said && notify(said));

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The teammates at work now, anywhere: whom Stop all cuts short (on the hosted service, the person's own). */
function useWorking() {
  const t = useTeamNow();
  let all = t?.teammates ?? [];
  // One waiting on the person isn't at work: it has nothing to stop (audit CREW-2, 2026-11-04).
  return all.filter((m) => m.status === "working");
}

/** Where the crew's computer is said to stay on: this Mac, or the person's own computer the hosted service runs them on. */
const KEEP_ON = isLocal() ? "Keep the lid open and the Mac on power: it stays awake while they work." : "Keep your computer on and Friday's desktop app open: your teammates run there.";

/** The crew's workflows, from a crew chat's header: its automations, each run a board here or in a room. */
/** Stop every teammate's running turn, after saying whose; the queues stay. */
export function useStopAll(identity: Identity, notify: (m: string) => void): [() => void, React.ReactNode] {
  const [ask, confirmUI] = useConfirm();
  const working = useWorking();
  const run = () => {
    if (!working.length) return notify("Nobody in the crew is working.");
    // Their names said plainly, what each is on only when it says more than "Writing its answer" three times over, and no Resume:
    // there is none after a stop, only the next message (2026-11-02 crew walk-through).
    const names = working.map((m) => m.name);
    const said = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
    const lines = new Set(working.map((m) => m.line).filter(Boolean));
    const on = working.length === 1 && working[0]!.line ? ` (${working[0]!.line.slice(0, 60)})` : lines.size > 1 ? `: ${working.filter((m) => m.line).map((m) => `${m.name}, ${m.line!.slice(0, 40)}`).join("; ")}` : "";
    ask({
      title: working.length === 1 ? `Stop ${working[0]!.name}?` : `Stop all ${working.length} teammates?`,
      body: `${said} ${working.length === 1 ? "stops" : "stop"} now, partway through${on}. What is queued for them stays queued, and they pick it up the next time you send them something.`,
      action: working.length === 1 ? "Stop" : "Stop all",
      icon: "stop", // A stop, not a deletion: no trash can (polish-crew, 2026-10-28).
      onConfirm: () =>
        (markStopped(working), stopAll(identity))
          .then((r) => ((!isLocal() || !r.stopped.length) && notify(r.stopped.length ? `Stopped ${r.stopped.length === 1 ? "1 teammate" : `${r.stopped.length} teammates`}. Their queues are kept.` : "Nobody was working."), refreshTeam(identity)))
          // An older server without stop-all: each teammate's own stop, which keeps its queue too.
          .catch(() => Promise.all(working.map((m) => api(identity, `/api/teammates/${m.id}/stop`, { method: "POST" }))).then(() => refreshTeam(identity))),
    });
  };
  return [run, confirmUI];
}

/** The team's controls in a team chat's header: the room's ⋯ (the board, threads, Stop all, Away / Pause and the rest). */
export function TeamHeaderControls({ identity, state, events, send, notify, panel }: { identity: Identity; state: SessionState; events: SessionEvent[]; send: Send; notify: (m: string) => void; /** The side panel, opened from the room's menu: its button and the ⋯ are one (Arun, 2026-11-01: "can we combine these two?"). */ panel?: { on: boolean; toggle: () => void } }) {
  const t = useTeamNow();
  const working = useWorking();
  const [stop, stopUI] = useStopAll(identity, notify);
  const [board, setBoard] = useState(false);
  const tasks = [...(state.board?.tasks ?? []), ...assignedTasks(state)].filter((x) => x.status !== "cancelled");
  const open = tasks.filter((x) => x.status !== "done").length;
  // ⌘. stops them all while anyone works, asked first; with nobody working it is the app's own (the side document).
  const stopRef = useRef(stop);
  stopRef.current = stop;
  const busy = working.length > 0;
  useEffect(() => {
    if (!busy) return;
    const key = (e: KeyboardEvent) => {
      if (!(isMac ? e.metaKey : e.ctrlKey) || e.key !== "." || e.shiftKey || e.altKey) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      stopRef.current();
    };
    addEventListener("keydown", key, true);
    return () => removeEventListener("keydown", key, true);
  }, [busy]);
  // The board opens from a /board typed in the box too (team-commands.ts).
  useEffect(() => {
    const on = () => setBoard(true);
    addEventListener("friday:team-board", on);
    return () => removeEventListener("friday:team-board", on);
  }, []);
  if (!t) return null;
  return (
    <>
      {stopUI}
      {/* No stop in the header: the box's own stop is the one, and with several at work it opens a menu of each and all (audit
          CREW-15, 2026-11-04). ⌘. still stops them all, asked first. */}
      {/* One ⋯ for the room: the board, its threads and the rest (Arun, 2026-11-01: "i want to be simplier and easy to digest as
          a user for crew"). The faces by the title and the line over the box say who works. */}
      {isLocal() ? (
        // The room's one button opens its profile in the side panel, where the board, threads and the rest are now (Arun,
        // 2026-11-15: "move those things over to the side panel").
        panel && (
          <button type="button" className={`panel-tab icon tm-hd-btn ${panel.on ? "on" : ""}`} aria-pressed={panel.on} aria-label={panel.on ? "Close the room's profile" : "The room's profile"} title="The room's profile" onClick={panel.toggle} data-on={t.paused ? "paused" : t.away?.until ? "away" : t.selfRuns?.[state.id] ? "run" : undefined}>
            <Icon name="sidePanel" size={18} />
            {(t.paused || !!t.away?.until || !!t.selfRuns?.[state.id]) && <i className="panel-tab-dot" />}
          </button>
        )
      ) : (
        <RoomMore identity={identity} sid={state.id} events={events} notify={notify} board={tasks.length ? { open, all: tasks.length, show: () => setBoard(true) } : null} {...(panel ? { panel } : {})} />
      )}
      {board && <TeamBoard state={state} events={events} send={send} onClose={() => setBoard(false)} />}
    </>
  );
}

/** A file's kind, for its mark on the shelf. */
const kindOf = (p: string) => (/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(p) ? "image" : /\.(mp4|mov|webm|m4v)$/i.test(p) ? "video" : /\.(md|mdx|txt|docx?|pdf)$/i.test(p) ? "doc" : "code");

/**
 * What this room's teammates made, on one shelf (Arun, 2026-10-28: the critique's "results shelf per room: the files and PRs
 * produced"): the files they changed, newest first, each opening where the session opens a file, and the pull requests they named.
 */
/** What the crew made in a room: tasks handed in with their proof, pull requests, files, newest first. */
function useResults(sid: string, events: SessionEvent[]) {
  // What was handed in here, newest first, each with its proof (team-proof.ts): checked at a glance, before the files.
  const handed = useMemo(() => proofsIn(events, sid, (lane) => mateOn(lane)?.name).slice(0, 20), [events, sid]);
  const { files, prs } = useMemo(() => {
    const files = new Map<string, { path: string; lane: string; ts: number; status: string; add: number; del: number }>();
    const prs = new Map<string, { url: string; lane: string; ts: number }>();
    for (const e of events) {
      const b = e.body;
      if (b.type === "agent.diff") for (const f of b.files) files.set(f.path, { path: f.path, lane: e.lane ?? "main", ts: e.ts, status: f.status, add: f.additions, del: f.deletions });
      if (b.type === "agent.message") for (const u of b.text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g) ?? []) prs.set(u, { url: u, lane: e.lane ?? "main", ts: e.ts });
    }
    return { files: [...files.values()].sort((a, b) => b.ts - a.ts), prs: [...prs.values()].sort((a, b) => b.ts - a.ts) };
  }, [events]);
  return { handed, files, prs, count: files.length + prs.length };
}

/** The results shelf: its own button, or (embedded) a page of the room's ⋯ menu, `done` closing it. */
function ResultsButton({ sid, events, embedded }: { sid: string; events: SessionEvent[]; embedded?: () => void }) {
  const [open, setOpen] = useState(false);
  const { handed, files, prs } = useResults(sid, events);
  const close = () => (embedded ? embedded() : setOpen(false));
  if (!files.length && !prs.length && !handed.length) return null;
  const list = (
    <>
        <div className="tm-pop-head">
          <b>Results</b>
          <span>
            {handed.length ? `${handed.length} handed in · ` : ""}
            {files.length} file{files.length === 1 ? "" : "s"}
            {prs.length ? ` · ${prs.length} PR${prs.length === 1 ? "" : "s"}` : ""}
          </span>
        </div>
        <ul className="tm-threads-list">
          {handed.map((p) => (
            <li key={`${p.task ?? "run"}:${p.seq}`} className="pf-handed">
              <span className="pf-handed-title">
                <span title={p.title}>{plainLine(p.title)}</span>
                <span className="pf-num">
                  {mateOn(p.lane)?.name ?? p.name} · {agoShort(p.at)}
                </span>
              </span>
              <ProofToggle proof={p} />
            </li>
          ))}
          {prs.map((p) => {
            const m = mateOn(p.lane);
            return (
              <li key={p.url}>
                <a className="tm-shelf-row" href={p.url} target="_blank" rel="noreferrer">
                  <span className="tm-shelf-mark" data-kind="pr">
                    <GitPullRequestIcon className="size-3.5" />
                  </span>
                  <span className="tm-text">
                    <span className="tm-threads-text">PR #{/\/pull\/(\d+)/.exec(p.url)![1]}</span>
                    <span className="tm-sub">
                      {m?.name ?? "A teammate"} · {agoShort(p.ts)}
                    </span>
                  </span>
                </a>
              </li>
            );
          })}
          {files.slice(0, 80).map((f) => {
            const m = mateOn(f.lane);
            return (
              <li key={f.path}>
                <button type="button" className="tm-shelf-row" title={f.path} onClick={() => (dispatchEvent(new CustomEvent("friday:open-file", { detail: { path: f.path, lane: f.lane } })), close())}>
                  <span className="tm-shelf-mark" data-kind={kindOf(f.path)}>
                    {kindOf(f.path) === "image" ? <ImageIcon className="size-3.5" /> : kindOf(f.path) === "doc" ? <FileTextIcon className="size-3.5" /> : <FileCodeIcon className="size-3.5" />}
                  </span>
                  <span className="tm-text">
                    <span className="tm-threads-text">{f.path.split("/").pop()}</span>
                    <span className="tm-sub">
                      {m?.name ?? "A teammate"} · {f.status === "added" ? "new" : f.status === "deleted" ? "deleted" : `+${f.add} −${f.del}`} · {agoShort(f.ts)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
    </>
  );
  if (embedded) return list;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="panel-tab icon tm-hd-btn tm-hd-extra" aria-label={`Results: ${handed.length ? `${handed.length} handed in, ` : ""}${files.length} files${prs.length ? `, ${prs.length} pull requests` : ""}`} title="What the crew made here">
          <PackageIcon className="size-[17px]" />
          <span className="tm-hd-n">{files.length + prs.length}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="tm-pop tm-results-pop">
        {list}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The room's ⋯: what the header no longer shows as buttons of their own (Arun, 2026-10-31: "there is too many buttons here, we
 * need to simplify this and make it easier for the user to use"). The header keeps Threads and the Board, what a person reaches
 * for while the room works; the rest is a list here, each with how it stands, opening as a page of this menu (Results, Run on
 * its own, Away and Pause) or its own place (Skills, Workflows). While the room runs on its own, or you are away, or the crew is
 * paused, the ⋯ itself says so with its mark.
 */
function RoomMore({ identity, sid, events, notify, board, panel }: { panel?: { on: boolean; toggle: () => void }; identity: Identity; sid: string; events: SessionEvent[]; notify: (m: string) => void; /** The room's board, when it has tasks. */ board: { open: number; all: number; show: () => void } | null }) {
  const t = useTeamNow();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<null | "results" | "run" | "away" | "threads">(null);
  const threads = useThreads(sid, events);
  const [skills, setSkills] = useState(false);
  const results = useResults(sid, events);
  const waiting = skillsWaiting(useSkills());
  const run = t?.selfRuns?.[sid] ?? null;
  const away = t?.away?.until ? t.away : null;
  const paused = !!t?.paused;
  const done = () => (setOpen(false), setPage(null));
  const on = paused ? "paused" : away ? "away" : run ? "run" : undefined;
  const say = paused ? "the crew is paused" : away ? `you're away until ${untilOf(away.until!)}` : run ? `running on its own: ${run.goal}` : "";
  const Row = ({ icon, name, detail, onClick, n }: { icon: React.ReactNode; name: string; detail?: string; onClick: () => void; n?: number }) => (
    <li>
      <button type="button" className="tm-more-row" onClick={onClick}>
        <span className="tm-more-icon">{icon}</span>
        <span className="tm-text">
          <span className="tm-name">{name}</span>
          {detail && <span className="tm-sub">{detail}</span>}
        </span>
        {n ? <span className="tm-hd-n">{n}</span> : null}
      </button>
    </li>
  );
  return (
    <>
      <Popover open={open} onOpenChange={(o) => (setOpen(o), o || setPage(null))}>
        <PopoverTrigger asChild>
          <button type="button" className="panel-tab icon tm-hd-btn tm-more-btn" data-on={on} aria-label={say ? `More: ${say}` : "More: board, threads, results, run on its own, away, skills, workflows"} title={say ? `${say[0]!.toUpperCase()}${say.slice(1)}` : "More"}>
            {/* The side panel's mark, the room's one button (Arun, 2026-11-01: "swap out the three dot icon with the icon to the
                right"); while the room runs on its own, or you are away, or the crew is paused, a dot on it says so. */}
            <Icon name="sidePanel" size={18} />
            {on && <i className="panel-tab-dot" />}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className={page ? "tm-pop tm-away-pop" : "tm-pop tm-more-pop"}>
          {page ? (
            <>
              <button type="button" className="tm-more-back" onClick={() => setPage(null)}>
                ← Back
              </button>
              {page === "results" && <ResultsButton sid={sid} events={events} embedded={done} />}
              {page === "threads" && <ThreadsList sid={sid} list={threads} onOpen={done} />}
              {page === "run" && <SelfRunSwitch identity={identity} sid={sid} notify={notify} embedded={done} />}
              {page === "away" && <AwaySwitch identity={identity} notify={notify} embedded={done} />}
            </>
          ) : (
            <ul className="tm-more-list">
              {panel && <Row icon={<PanelRightIcon className="size-4" />} name={panel.on ? "Close the side panel" : "Side panel"} detail={panel.on ? undefined : "Changes, terminal, preview and more"} onClick={() => (done(), panel.toggle())} />}
              {board && <Row icon={<KanbanSquareIcon className="size-4" />} name="Board" detail={`${board.open} open of ${board.all}`} n={board.open} onClick={() => (done(), board.show())} />}
              {threads.length > 0 && <Row icon={<MessagesSquareIcon className="size-4" />} name="Threads" detail={`${threads.length} in this room`} n={threads.filter((x) => x.state === "answering").length} onClick={() => setPage("threads")} />}
              {results.handed.length + results.count > 0 && <Row icon={<PackageIcon className="size-4" />} name="Results" detail="What the crew made here" n={results.handed.length + results.count} onClick={() => setPage("results")} />}
              <Row icon={<InfinityIcon className="size-4" />} name="Run on its own" detail={run ? `On · ${run.goal}` : "Work toward a goal by itself"} onClick={() => setPage("run")} />
              <Row icon={paused ? <CirclePauseIcon className="size-4" /> : <MoonIcon className="size-4" />} name="Away and pause" detail={away ? `Away until ${untilOf(away.until!)}${paused ? " · paused" : ""}` : paused ? "The crew is paused" : "The crew carries on without you"} onClick={() => setPage("away")} />
              <Row icon={<ListChecksIcon className="size-4" />} name="Skills" detail={waiting ? `${waiting} to keep or drop` : "How the crew does what it repeats"} n={waiting} onClick={() => (done(), setSkills(true))} />
              <Row icon={<WorkflowIcon className="size-4" />} name="Workflows" detail="The crew's automations" onClick={() => (done(), openWorkflows())} />
            </ul>
          )}
        </PopoverContent>
      </Popover>
      {skills && <SkillsDialog onClose={() => setSkills(false)} />}
    </>
  );
}

/**
 * A room's profile, in the side panel, as a crew mate's is (Arun, 2026-11-15: "we need to have the profile be for the team room too
 * and we need to move those things over to the side panel too"): who it is (its faces, its name, what it is for), who is in it and
 * who leads, and what the room's menu held (the board, its threads, what it made, running on its own, away and pause, skills,
 * workflows), each a row that opens as a page here. The Crew room has no name or purpose to change and everyone is in it.
 */
export function RoomProfile({ identity, state, events, send, notify }: { identity: Identity; state: SessionState; events: SessionEvent[]; send: Send; notify: (m: string) => void }) {
  const t = useTeamNow();
  const sid = state.id;
  const [page, setPage] = useState<null | "results" | "run" | "away" | "threads" | "spend" | "send">(null);
  const [board, setBoard] = useState(false);
  const [skills, setSkills] = useState(false);
  const [ask, confirmUI] = useConfirm();
  const threads = useThreads(sid, events);
  const results = useResults(sid, events);
  const waiting = skillsWaiting(useSkills());
  const r = t?.rooms?.find((x) => x.sid === sid && !x.thread) ?? null;
  const [name, setName] = useState(r?.name ?? "");
  const [purpose, setPurpose] = useState(r?.purpose ?? "");
  useEffect(() => (setName(r?.name ?? ""), setPurpose(r?.purpose ?? "")), [r?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!t) return null;
  const crew = sid === t.sid;
  if (!crew && !r) return null;
  const mates = ownOf(t);
  const members = crew ? mates.map((m) => ({ m, lane: m.lane })) : mates.filter((m) => r!.lanes[m.id]).map((m) => ({ m, lane: r!.lanes[m.id]! }));
  const others = crew ? [] : mates.filter((m) => !r!.lanes[m.id]);
  const lead = state.lead ?? null;
  const tasks = [...(state.board?.tasks ?? []), ...assignedTasks(state)].filter((x) => x.status !== "cancelled");
  const open = tasks.filter((x) => x.status !== "done").length;
  const selfRun = t.selfRuns?.[sid] ?? null;
  const away = t.away?.until ? t.away : null;
  const paused = !!t.paused;
  const patch = (body: Record<string, unknown>) => api(identity, `/api/teammates/rooms/${r!.id}`, { method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }).then(() => refreshTeam(identity)).catch((e: Error) => notify(e.message || "That didn't save."));
  const done = () => setPage(null);
  if (page)
    return (
      <section className="msd" aria-label="This room's profile">
        <button type="button" className="msd-back" onClick={done} aria-label="Back to the room's profile">
          <ChevronLeftIcon aria-hidden="true" />
          Back
        </button>
        <div className="msd-page">
          {page === "results" && <ResultsButton sid={sid} events={events} embedded={done} />}
          {page === "threads" && <ThreadsList sid={sid} list={threads} onOpen={done} />}
          {page === "run" && <SelfRunSwitch identity={identity} sid={sid} notify={notify} embedded={done} />}
          {page === "away" && <AwaySwitch identity={identity} notify={notify} embedded={done} />}
          {page === "send" && <RoomSend identity={identity} sid={sid} roomId={crew ? null : r!.id} name={crew ? "the Crew room" : r!.name} notify={notify} />}
          {page === "spend" && <SpendPage identity={identity} query={crew ? "crew=1" : `room=${encodeURIComponent(r!.id)}`} who={crew ? "The crew" : r!.name} />}
        </div>
      </section>
    );
  type Row = { key: string; label: string; icon: React.ReactNode; now?: string; n?: number; onClick: () => void };
  const rows: Row[] = [
    ...(tasks.length ? [{ key: "board", label: "Board", icon: <KanbanSquareIcon />, now: `${open} open of ${tasks.length}`, n: open, onClick: () => setBoard(true) }] : []),
    ...(threads.length ? [{ key: "threads", label: "Threads", icon: <MessagesSquareIcon />, now: `${threads.length}`, n: threads.filter((x) => x.state === "answering").length, onClick: () => setPage("threads") }] : []),
    { key: "send", label: "Send its work", icon: <SendIcon />, onClick: () => setPage("send") },
    { key: "spend", label: "Spend", icon: <ChartColumnIcon />, onClick: () => setPage("spend") },
    { key: "results", label: "Results", icon: <PackageIcon />, now: results.handed.length + results.count ? `${results.handed.length + results.count}` : "Nothing yet", onClick: () => setPage("results") },
    { key: "run", label: "Run on its own", icon: <InfinityIcon />, now: selfRun ? "On" : "Off", onClick: () => setPage("run") },
    { key: "away", label: "Away and pause", icon: paused ? <CirclePauseIcon /> : <MoonIcon />, now: away ? `Away until ${untilOf(away.until!)}` : paused ? "Paused" : "Here", onClick: () => setPage("away") },
    { key: "skills", label: "Skills", icon: <ListChecksIcon />, ...(waiting ? { now: `${waiting} to keep or drop`, n: waiting } : {}), onClick: () => setSkills(true) },
    { key: "workflows", label: "Workflows", icon: <WorkflowIcon />, onClick: () => openWorkflows() },
  ];
  const memberItems = (m: (typeof members)[number]): MenuItem[] => [
    { label: `Open ${m.m.name}'s chat here`, icon: "chat", onSelect: () => focusAgent(sid, m.lane) },
    lead !== m.lane && { label: "Make them the lead", icon: "crown", onSelect: () => void send({ type: "lead.set", lane: m.lane }).then((x) => !x.ok && notify(x.error ?? "Couldn't do that.")) },
    !crew && members.length > 1 && { label: `Take ${m.m.name} out of the room`, icon: "x", danger: true, onSelect: () => void patch({ members: members.filter((x) => x.m.id !== m.m.id).map((x) => x.m.id) }) },
  ];
  return (
    <section className="msd msd-home" aria-label="This room's profile">
      <div className="msd-id">
        <span className="msd-id-face rp-faces" aria-hidden="true">
          <RoomFaces seeds={members.slice(0, 3).map(({ m }) => m.look ?? m.name)} size={30} />
        </span>
        <div className="msd-id-text">
          {crew ? (
            <h3 className="msd-id-name rp-name">Crew room</h3>
          ) : (
            <input className="msd-id-name" value={name} maxLength={60} aria-label="Room name" onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name.trim() !== r!.name && void patch({ name: name.trim() })} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), e.currentTarget.blur())} />
          )}
          <span className="msd-id-line">
            <span>
              {members.length} {members.length === 1 ? "crew mate" : "crew mates"}
              {lead && mateOn(lead) ? ` · ${mateOn(lead)!.name} leads` : ""}
            </span>
          </span>
        </div>
      </div>
      {!crew && (
        <label className="msd-field">
          <span>What it's for</span>
          <Textarea value={purpose} maxLength={2000} rows={2} placeholder="Ship the new pricing page" onChange={(e) => setPurpose(e.target.value)} onBlur={() => purpose.trim() !== (r!.purpose ?? "") && void patch({ purpose: purpose.trim() })} />
          <small>Its crew mates hear it with every message here.</small>
        </label>
      )}
      <div className="msd-group">
        <h3 className="msd-group-name">In this room</h3>
        <ul className="msd-rows">
          {members.map((x) => (
            <li key={x.m.id} className="rp-member">
              <button type="button" className="msd-row" onClick={() => focusAgent(sid, x.lane)} title={`Open ${x.m.name}'s chat here`}>
                <Face seed={x.m.look ?? x.m.name} size={20} />
                <span className="msd-row-label">{x.m.name}</span>
                <MateRing status={x.m.status} />
                {lead === x.lane && <span className="rp-lead">Lead</span>}
                <span className="msd-row-now">{mateStatus(x.m, { sid, lane: x.lane }).line}</span>
              </button>
              <MenuButton className="rp-more" label={`More for ${x.m.name}`} items={() => memberItems(x)} />
            </li>
          ))}
          {others.length > 0 && (
            <li>
              <MenuButton className="msd-row rp-add" label="Add a crew mate to this room" items={() => others.map((m): MenuItem => ({ label: m.name, mark: <Face seed={m.look ?? m.name} size={18} />, onSelect: () => void patch({ members: [...members.map((x) => x.m.id), m.id] }) }))}>
                <span className="msd-row-icon" aria-hidden="true">
                  <PlusIcon />
                </span>
                <span className="msd-row-label">Add a crew mate</span>
              </MenuButton>
            </li>
          )}
        </ul>
      </div>
      {!crew && <RoomFolders identity={identity} room={r!} members={members.map((x) => x.m)} patch={patch} notify={notify} />}
      <div className="msd-group">
        <h3 className="msd-group-name">The room</h3>
        <ul className="msd-rows">
          {rows.map((x) => (
            <li key={x.key}>
              <button type="button" className="msd-row" onClick={x.onClick}>
                <span className="msd-row-icon" aria-hidden="true">{x.icon}</span>
                <span className="msd-row-label">{x.label}</span>
                {x.now && <span className="msd-row-now">{x.now}</span>}
                <ChevronRightIcon className="msd-row-chev" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      </div>
      {!crew && (
        <button
          type="button"
          className="msd-remove"
          onClick={() =>
            ask({
              title: `Remove ${r!.name}?`,
              body: "Its crew mates stop working in it. They stay in your crew, with their folders and everything they made; the room's conversation is kept, out of sight.",
              action: "Remove room",
              onConfirm: () => void api(identity, `/api/teammates/rooms/${r!.id}`, { method: "DELETE" }).then(() => refreshTeam(identity)).catch((e: Error) => notify(e.message)),
            })
          }
        >
          Remove this room
        </button>
      )}
      {board && <TeamBoard state={state} events={events} send={send} onClose={() => setBoard(false)} />}
      {skills && <SkillsDialog onClose={() => setSkills(false)} />}
      {confirmUI}
    </section>
  );
}

/**
 * A room's work, whole, taken on elsewhere (Arun, 2026-11-15: "allow for like crew work in a room to be send too.. with proper
 * context and stuff as well.... not just individual agent work"): the brief it goes with, to read first (room-brief.ts), then into a
 * coding session (Bring it in there: the room's finished work, looked at before it comes in) or to another room's lead with the brief.
 */
function RoomSend({ identity, sid, roomId, name, notify }: { identity: Identity; sid: string; roomId: string | null; name: string; notify: (m: string) => void }) {
  const t = useTeamNow();
  const [brief, setBrief] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<{ brief: string }>(identity, `/api/teammates/brief?${roomId ? `room=${encodeURIComponent(roomId)}` : "crew=1"}`)
      .then((b) => live && setBrief(b.brief))
      .catch((e: Error) => live && setErr(e.message || "Couldn't put its work together."));
    return () => void (live = false);
  }, [identity, roomId]);
  const coding = loadRecents()
    .filter((x) => x.sid !== sid && !isTeamSid(x.sid) && !x.settledAt)
    .sort((a, b) => b.openedAt - a.openedAt)
    .slice(0, 6);
  const rooms = [...(t && t.sid !== sid ? [{ sid: t.sid, invite: t.invite, name: "Crew room", lead: null as string | null }] : []), ...(t?.rooms ?? []).filter((x) => !x.thread && x.sid !== sid).map((x) => ({ sid: x.sid, invite: x.invite, name: x.name, lead: x.lead ?? null }))];
  const toRoom = async (x: (typeof rooms)[number]) => {
    if (!brief) return;
    try {
      await api(identity, `/api/sessions/${encodeURIComponent(x.sid)}/instruct?invite=${encodeURIComponent(x.invite)}`, { method: "POST", body: JSON.stringify({ text: brief, ...(x.lead ? { lane: x.lead } : {}) }), headers: { "Content-Type": "application/json" } });
      setSent(x.name);
      notify(`Sent ${name}'s work to ${x.name}.`);
    } catch (e) {
      notify((e as Error).message || `Couldn't send it to ${x.name}.`);
    }
  };
  return (
    <div className="rs">
      <div className="tm-pop-head">
        <b>Send its work</b>
        <span>Everything {name} did, with what it is for, its board, what each crew mate found and their files.</span>
      </div>
      {err && <p className="sp-err">{err}</p>}
      <details className="rs-brief" open>
        <summary>What goes with it</summary>
        {brief ? <pre>{brief}</pre> : !err && <p className="sp-quiet">Putting it together…</p>}
      </details>
      <div className="msd-group">
        <h3 className="msd-group-name">Into a coding session</h3>
        <ul className="msd-rows">
          {coding.length ? (
            coding.map((x) => (
              <li key={x.sid}>
                <button type="button" className="msd-row" onClick={() => openBring({ sid: x.sid, invite: x.invite, from: roomId ? `room:${roomId}` : "all", name })}>
                  <span className="msd-row-icon" aria-hidden="true">
                    <Icon name="code" size={14} />
                  </span>
                  <span className="msd-row-label">{x.alias || x.title || "Untitled"}</span>
                  <span className="msd-row-now">Look, then bring it in</span>
                  <ChevronRightIcon className="msd-row-chev" aria-hidden="true" />
                </button>
              </li>
            ))
          ) : (
            <li>
              <span className="msd-row rf-row">
                <span className="msd-row-label">No coding sessions yet</span>
              </span>
            </li>
          )}
        </ul>
      </div>
      {rooms.length > 0 && (
        <div className="msd-group">
          <h3 className="msd-group-name">To a crew room</h3>
          <ul className="msd-rows">
            {rooms.map((x) => (
              <li key={x.sid}>
                <button type="button" className="msd-row" disabled={!brief} onClick={() => void toRoom(x)}>
                  <span className="msd-row-icon" aria-hidden="true">
                    <Icon name="users" size={14} />
                  </span>
                  <span className="msd-row-label">{x.name}</span>
                  <span className="msd-row-now">{sent === x.name ? "Sent" : "To its lead, with the brief"}</span>
                  <ChevronRightIcon className="msd-row-chev" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The folders a room's crew mates work in (Arun, 2026-11-15: "be able to add and remove folders the agents can work in ... but by
 * default they will carry over the folders they work in from their own individual pages"): each one's own, from its page, said as
 * whose and changed there; and the room's own for all of them here, added and taken away here (teammates.ts Room.folders).
 */
function RoomFolders({ identity, room, members, patch, notify }: { identity: Identity; room: RoomView; members: TeammateView[]; patch: (body: Record<string, unknown>) => Promise<unknown>; notify: (m: string) => void }) {
  const [adding, setAdding] = useState(false);
  const addRow = useRef<HTMLButtonElement>(null);
  const own = room.folders ?? [];
  // Carried over: each folder from the members' own pages, once, with whose it is.
  const carried = new Map<string, string[]>();
  for (const m of members) for (const d of foldersOf(m)) if (!own.includes(d)) carried.set(d, [...(carried.get(d) ?? []), m.name]);
  const names = (who: string[]) => (who.length > 2 ? `${who.slice(0, 2).join(", ")} and ${who.length - 2} more` : who.join(" and "));
  const add = (dir: string) => {
    if (own.includes(dir)) return notify(`${short(dir)} is already in this room.`);
    if (carried.has(dir)) return notify(`${short(dir)} is already ${names(carried.get(dir)!)}'s, from ${carried.get(dir)!.length === 1 ? "its" : "their"} own page.`);
    void patch({ folders: [...own, dir] }).then(() => notify(`Everyone in ${room.name} can work in ${short(dir)} now.`));
  };
  const pick = async () => {
    const desk = window.fridayDesktop;
    if (!desk?.pickFolder) return setAdding(true);
    const dir = await desk.pickFolder();
    if (dir) add(dir);
  };
  return (
    <div className="msd-group">
      <h3 className="msd-group-name">Folders</h3>
      <ul className="msd-rows">
        {[...carried].map(([dir, who]) => (
          <li key={`c:${dir}`}>
            <span className="msd-row rf-row" title={`${dir}\nFrom ${names(who)}'s own page: change it there.`}>
              <span className="msd-row-icon" aria-hidden="true">
                <Icon name="folder" size={14} />
              </span>
              <span className="msd-row-label">{short(dir)}</span>
              <span className="msd-row-now">From {names(who)}</span>
            </span>
          </li>
        ))}
        {own.map((dir) => (
          <li key={`o:${dir}`} className="rf-own">
            <span className="msd-row rf-row" title={dir}>
              <span className="msd-row-icon" aria-hidden="true">
                <Icon name="folder" size={14} />
              </span>
              <span className="msd-row-label">{short(dir)}</span>
              <span className="msd-row-now">This room</span>
            </span>
            <button type="button" className="rf-x" aria-label={`Take ${short(dir)} out of this room`} title="Take it out of this room" onClick={() => void patch({ folders: own.filter((x) => x !== dir) }).then(() => notify(`${short(dir)} is out of ${room.name}.`))}>
              <XIcon aria-hidden="true" />
            </button>
          </li>
        ))}
        <li>
          <button ref={addRow} type="button" className="msd-row rp-add" onClick={() => void pick()}>
            <span className="msd-row-icon" aria-hidden="true">
              <PlusIcon />
            </span>
            <span className="msd-row-label">Add a folder for this room</span>
          </button>
        </li>
      </ul>
      <small className="rf-note">{carried.size ? "Each crew mate brings the folders from its own page. " : ""}Folders added here are for everyone in this room.</small>
      {adding && (
        <WorkspaceCard
          identity={identity}
          tool="claude"
          trigger={addRow.current}
          only="repos"
          onClose={() => setAdding(false)}
          onPick={(p) => {
            setAdding(false);
            if (p) add(p.folder.path);
          }}
        />
      )}
    </div>
  );
}

/** The room's side threads, waiting on a teammate first, then by the newest reply (team-threads.ts). */
function useThreads(sid: string, events: SessionEvent[]) {
  const threads = threadsOf(events);
  return useMemo(() => {
    const out: { root: number; lane: string; text: string; replies: number; last: number; state: string | undefined }[] = [];
    for (const [root, replies] of threads.byRoot) {
      const first = events.find((e) => e.seq === root);
      if (!first) continue;
      const text = first.body.type === "agent.message" || first.body.type === "instruction" ? first.body.text : "";
      out.push({ root, lane: first.lane ?? "main", text: plainLine(text), replies: replies.length, last: replies.at(-1)?.ts ?? first.ts, state: threads.state.get(root) });
    }
    return out.sort((a, b) => Number(b.state === "answering") - Number(a.state === "answering") || b.last - a.last);
  }, [threads, events, sid]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The room's threads as a page of its ⋯ menu, each a press from the thread. */
function ThreadsList({ sid, list, onOpen }: { sid: string; list: ReturnType<typeof useThreads>; onOpen: () => void }) {
  const waiting = list.filter((x) => x.state === "answering").length;
  return (
    <>
      <div className="tm-pop-head">
        <b>Threads</b>
        <span>{waiting ? `${waiting} waiting for an answer` : `${list.length} in this room`}</span>
      </div>
      <ul className="tm-threads-list">
        {list.map((x) => {
          const m = mateOn(x.lane);
          const said = threadSaid(x.state as never, m?.name ?? "It", x.lane, sid);
          return (
            <li key={x.root}>
              <button type="button" onClick={() => (openThread({ sid, root: x.root, lane: x.lane }), onOpen())}>
                {m ? <Face seed={m.look ?? m.name} size={22} /> : <span className="tm-dot" />}
                <span className="tm-text">
                  <span className="tm-threads-text">{x.text || "A message"}</span>
                  <span className={`tm-sub${x.state === "answering" ? " s-working" : x.state === "failed" || x.state === "stopped" ? " s-limited" : ""}`}>
                    {x.replies} {x.replies === 1 ? "reply" : "replies"} · {said ?? `answered ${agoShort(x.last)}`}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * Away until a time, and Pause team, in one place (Arun, 2026-10-28: "Away until 8:00 AM", with a time picker defaulting to the
 * next 8 AM). While away the button says until when; pressed, it says "I'm back".
 */
/**
 * Run on its own: the room works at full access toward its goal without anyone (Arun, 2026-10-31: "full access for crew that
 * basically runs and self sustains it selfs… making decisions and achieving a goal as a team"; team-selfrun.ts). Its mark is lit
 * while it runs; the card says toward what, since when, and stops it. The goal starts as the room's purpose.
 */
function SelfRunSwitch({ identity, sid, notify, embedded }: { identity: Identity; sid: string; notify: (m: string) => void; /** A page of the room's ⋯ menu, this closing it. */ embedded?: () => void }) {
  const t = useTeamNow();
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState("");
  // Its budget (tokens for the whole run, 0 for none) and an end time if one is set: an overnight budget unless changed.
  const [tokens, setTokens] = useState<number>(DEFAULT_RUN_TOKENS);
  const [ends, setEnds] = useState("");
  const [busy, setBusy] = useState(false);
  const run = t?.selfRuns?.[sid] ?? null;
  const purpose = t?.rooms?.find((r) => r.sid === sid)?.purpose ?? "";
  // On the hosted service a run drives the teammates of whoever started it and of those who joined; anyone else with a teammate
  // in the room may join with theirs, or take them out again, and its starter or the room's owner stops it (hosted-crew.ts).
  let hosted = null as { mine: string[]; joined: boolean; mayStop: boolean; others: number; runners: string[] } | null;
  const names = (list: string[]) => (list.length < 3 ? list.join(" and ") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`);
  const act = (p: Promise<unknown>, said: string) => {
    setBusy(true);
    p.then(() => (notify(said), refreshTeam(identity), (embedded ? embedded() : setOpen(false))))
      .catch((e: Error) => notify(/not found|404/i.test(e.message) ? "This Friday doesn't have that yet. Update it, then try again." : e.message))
      .finally(() => setBusy(false));
  };
  // Nothing to run with: none of the person's teammates in the room, and nothing running.
  // Opened as a page of the ⋯ menu: the form starts as the popover's opening sets it.
  useEffect(() => {
    if (embedded) setGoal(run?.goal ?? purpose);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (hosted && !run && !hosted.mine.length) return embedded ? <p className="tm-away-body">Bring one of your teammates into the room first: running on its own drives your teammates, on your plan.</p> : null;
  const body = (
    <>
        {run ? (
          <div className="tm-away-body">
            <b className="tm-away-title">Running on its own</b>
            <p className="tm-selfrun-goal">{run.goal}</p>
            <p>
              Since {untilOf(run.since)}{hosted ? `, with ${names(hosted.runners)} teammates` : ""}. The lead keeps the board going, the crew decides and approves for itself, and it stops when
              the lead says the goal is reached, nothing moves for three nudges{run.budget?.tokens || run.budget?.until ? ", or its budget is spent" : ""}.
            </p>
            {run.budget && <p className="tm-away-note">Budget: {runBudgetLine(run.budget)}.</p>}
            {hosted && !hosted.joined && hosted.mine.length > 0 && (
              <p>
                Join, and {names(hosted.mine)} work{hosted.mine.length === 1 ? "s" : ""} toward it too, on your plan.
              </p>
            )}
            {(!hosted || hosted.mayStop) && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => act(setSelfRun(identity, sid, null), "The room is back to waiting for you.")}>
                <SquareIcon className="size-3" /> Stop running on its own
              </Button>
            )}
          </div>
        ) : (
          <form
            className="tm-away-body"
            onSubmit={(e) => {
              e.preventDefault();
              const until = ends ? (nextAt(ends) ?? undefined) : undefined;
              if (goal.trim()) act(setSelfRun(identity, sid, goal.trim(), { tokens, ...(until ? { until } : {}), tz: Intl.DateTimeFormat().resolvedOptions().timeZone }), "The room runs on its own now.");
            }}
          >
            <b className="tm-away-title">Run on its own</b>
            <p>
              {hosted ? `${names(hosted.mine)} work${hosted.mine.length === 1 ? "s" : ""} toward this goal by ${hosted.mine.length === 1 ? "itself" : "themselves"}, at full access, on your plan: plans, hands out tasks, decides and approves until the lead says it's done.${hosted.others ? " Other people's teammates here keep to their keepers' work, and can join." : ""}` : "The crew works toward this goal by itself, at full access: it plans, hands out tasks, decides, approves and keeps going until the lead says it's done."}
            </p>
            <Textarea value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What should this room get done?" aria-label="The room's goal" rows={3} className="tm-selfrun-input" />
            <div className="tm-selfrun-budget">
              <label>
                <span>Budget</span>
                <Picker className="tm-select" value={tokens} label="The run's budget" onChange={setTokens} options={[...RUN_BUDGETS.map((n) => ({ value: n, label: `${n / 1_000_000}M tokens`, ...(n === DEFAULT_RUN_TOKENS ? { hint: "a night's work" } : {}) })), { value: 0, label: "No budget" }]} />
              </label>
              <div className="tm-selfrun-ends">
                <span>Ends at</span>
                {/* No end until one is set; then Friday's own time field, with × to have none again (no native time field). */}
                {ends ? (
                  <span className="tm-ends-set">
                    <TimeField value={ends} onChange={setEnds} />
                    <button type="button" className="tm-ends-clear" aria-label="No end time" title="No end time" onClick={() => setEnds("")}>
                      <XIcon className="size-3.5" aria-hidden="true" />
                    </button>
                  </span>
                ) : (
                  <button type="button" className="rt-chip tm-ends-add" onClick={() => setEnds("06:00")}>
                    No end time · Set one
                  </button>
                )}
              </div>
            </div>
            <p className="tm-away-note">It never pushes to a default branch, deploys, deletes data or spends money. {isLocal() ? "Keep the Mac on power: it stays awake while the room runs." : "Keep your computer on: the room runs there."}</p>
            <Button type="submit" size="sm" disabled={busy || !goal.trim()}>
              <InfinityIcon className="size-4" /> Start
            </Button>
          </form>
        )}
    </>
  );
  if (embedded) return body;
  return (
    <Popover open={open} onOpenChange={(o) => (setOpen(o), o && (setGoal(run?.goal ?? purpose), setTokens(DEFAULT_RUN_TOKENS), setEnds("")))}>
      <PopoverTrigger asChild>
        <button type="button" className="panel-tab icon tm-hd-btn tm-selfrun-btn" data-on={run ? "on" : undefined} aria-label={run ? `Running on its own: ${run.goal}` : "Run on its own"} title={run ? `Running on its own toward: ${run.goal}` : "Run on its own: the crew works toward a goal by itself"}>
          <InfinityIcon className="size-[17px]" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="tm-pop tm-away-pop">
        {body}
      </PopoverContent>
    </Popover>
  );
}

/** "8:00 AM" from "08:00", in this computer's way of saying times. */
const clockOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h!, m!, 0, 0);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

function AwaySwitch({ identity, notify, embedded }: { identity: Identity; notify: (m: string) => void; /** A page of the room's ⋯ menu, this closing it. */ embedded?: () => void }) {
  const t = useTeamNow();
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState("08:00");
  const [busy, setBusy] = useState(false);
  const away = t?.away?.until ? t.away : null;
  const paused = !!t?.paused;
  const until = nextAt(at) ?? nextEight();
  // Away and I'm back close the card; the Pause switch, a switch, stays where it is to be read and turned back (QA, 2026-10-28).
  const act = (p: Promise<unknown>, said: string | ((r: unknown) => string), close = true) => {
    setBusy(true);
    p.then((r) => (sayIf(notify, typeof said === "string" ? said : said(r)), refreshTeam(identity), close && (embedded ? embedded() : setOpen(false))))
      .catch((e: Error) => notify(/not found|404/i.test(e.message) ? "This Friday doesn't have that yet. Update it, then try again." : e.message))
      .finally(() => setBusy(false));
  };
  const body = (
    <>
        {away ? (
          <div className="tm-away-body">
            <b className="tm-away-title">You're away until {untilOf(away.until!)}</b>
            <p>The crew decides for itself and notes what it assumed. You get the brief when you're back.</p>
            <Button size="sm" disabled={busy} onClick={() => act(comeBack(identity), (said) => String(said))}>
              <SunIcon className="size-4" /> I'm back
            </Button>
          </div>
        ) : (
          <form
            className="tm-away-body"
            onSubmit={(e) => {
              e.preventDefault();
              act(setAway(identity, until), awaySaid(until));
            }}
          >
            <b className="tm-away-title">Step away</b>
            <p>Until then the crew decides for itself and notes what it assumed. Writing in any crew chat brings you back.</p>
            {/* When you're back, on Friday's own time field with the usual mornings a press away (Arun, 2026-11-15: "design this
                better no native controls"). */}
            <div className="rt-when tm-away-card">
              <div className="rt-when-rows">
                <div className="rt-when-row">
                  <span className="rt-when-label">Back at</span>
                  <TimeField value={at} onChange={setAt} />
                </div>
                <div className="rt-when-row">
                  <span aria-hidden="true" />
                  <div className="rt-chips" role="radiogroup" aria-label="Usual times">
                    {["07:00", "08:00", "09:00", "13:00", "18:00"].map((v) => (
                      <button key={v} type="button" role="radio" aria-checked={at === v} className="rt-chip" onClick={() => setAt(v)}>
                        {clockOf(v)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="rt-when-foot">
                <MoonIcon className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="rt-when-next">
                  Away until <b>{untilOf(until)}</b>
                </span>
              </div>
            </div>
            <p className="tm-away-note">{KEEP_ON}</p>
            <Button type="submit" size="sm" disabled={busy}>
              <MoonIcon className="size-4" /> Step away
            </Button>
          </form>
        )}
        <label className="tm-pause-row">
          <span className="tm-text">
            <span className="tm-name">Pause crew</span>
            <span className="tm-sub">Nothing new starts: queues, check-ins and wakes wait. Turns under way finish.</span>
          </span>
          <Switch checked={paused} disabled={busy} onCheckedChange={(on) => act(setPaused(identity, on), on ? "The crew is paused. Nothing new starts until you resume it." : "The crew is back at work.", false)} />
        </label>
    </>
  );
  if (embedded) return body;
  return (
    <Popover open={open} onOpenChange={(o) => (setOpen(o), o && setAt("08:00"))}>
      <PopoverTrigger asChild>
        {/* Away and paused at once says both, and the time with AM or PM (Arun, 2026-10-28: "really iron out bugs and feature
            problems and gaps"; a pause while away didn't show, and "Away until 8:00" read as the morning for 8 PM). */}
        {/* The header's overflow: Away and Pause live in it (DIRECTION.md §9.1), so the header keeps to the room's name, its faces
            and its few icons. While away or paused its mark says so (moon, pause), and the banner over the box says the rest. */}
        <button type="button" className="panel-tab icon tm-hd-btn tm-more-btn" data-on={paused ? "paused" : away ? "away" : undefined} aria-label={away ? `Crew options: away until ${untilOf(away.until!)}${paused ? ", the crew paused" : ""}` : paused ? "Crew options: the crew is paused" : "Crew options: away or pause"} title={away ? `You're away until ${untilOf(away.until!)}${paused ? ": the crew is paused" : ""}` : paused ? "The crew is paused" : "Away or pause"}>
          {paused ? <CirclePauseIcon className="size-4" /> : away ? <MoonIcon className="size-4" /> : <EllipsisIcon className="size-4" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="tm-pop tm-away-pop">
        {body}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Over a team chat's box while away mode or a pause is on: what it means, calmly, and the one press that ends it (Arun,
 * 2026-10-28: "You're away until 8:00. The team decides for itself and notes what it assumed. Keep the lid open and the Mac on
 * power.", with "I'm back").
 */
export function TeamBanner({ identity, notify }: { identity: Identity; notify: (m: string) => void }) {
  const t = useTeamNow();
  const [busy, setBusy] = useState(false);
  if (!t) return null;
  const away = t.away?.until ? t.away : null;
  const act = (p: Promise<unknown>, said: string | ((r: unknown) => string)) => {
    setBusy(true);
    p.then((r) => (sayIf(notify, typeof said === "string" ? said : said(r)), refreshTeam(identity))).catch((e: Error) => notify(e.message)).finally(() => setBusy(false));
  };
  if (away)
    return (
      <div className="tm-banner" data-kind={t.paused ? "paused" : "away"} role="status">
        {t.paused ? <CirclePauseIcon className="size-4 tm-banner-icon" /> : <MoonIcon className="size-4 tm-banner-icon" />}
        <p>
          <b>You're away until {untilOf(away.until!)}.</b>{" "}
          {t.paused ? "The crew is paused too: nothing new starts until you resume it." : `The crew decides for itself and notes what it assumed. ${KEEP_ON.split(":")[0]}.`}
        </p>
        {t.paused && (
          <button type="button" className="tm-banner-btn" disabled={busy} onClick={() => act(setPaused(identity, false), "The crew is back at work.")}>
            <PlayIcon className="size-3.5" /> Resume
          </button>
        )}
        <button type="button" className="tm-banner-btn" disabled={busy} onClick={() => act(comeBack(identity), (said) => String(said))}>
          I'm back
        </button>
      </div>
    );
  if (t.paused)
    return (
      <div className="tm-banner" data-kind="paused" role="status">
        <CirclePauseIcon className="size-4 tm-banner-icon" />
        <p>
          <b>The crew is paused.</b> Nothing new starts: what you send waits with their queues, check-ins and wakes.
        </p>
        <button type="button" className="tm-banner-btn" disabled={busy} onClick={() => act(setPaused(identity, false), "The crew is back at work.")}>
          <PlayIcon className="size-3.5" /> Resume
        </button>
      </div>
    );
  return null;
}


/**
 * A team command typed in a team chat's box (team-commands.ts): done here, answering null, or the words it stands for, to send as
 * any message is. One that isn't the team's goes as it was typed.
 */
export async function runTeamCommand(text: string, { identity, notify }: { identity: Identity; notify: (m: string) => void; sid: string }): Promise<string | null> {
  const c = teamCommand(text);
  if (!c) return text;
  // `said` may come from what was done: coming back says the brief is there only when it is (team-api.ts comeBack).
  const done = (p: Promise<unknown>, said: string | ((r: unknown) => string)) =>
    p.then((r) => (sayIf(notify, typeof said === "string" ? said : said(r)), void refreshTeam(identity))).catch((e: Error) => notify(/not found|404/i.test(e.message) ? "This Friday doesn't have that yet. Update it, then try again." : e.message));
  switch (c.kind) {
    case "bad":
      notify(c.why);
      throw new Error(c.why);
    case "say":
      return c.text;
    case "stop":
      // Says who it stopped, or that nobody was working (2026-10-28 QA: it always said it stopped everyone).
      await stopAll(identity)
        .then((r) => ((!isLocal() || !r.stopped.length) && notify(r.stopped.length ? `Stopped ${r.stopped.join(", ")}. Their queues are kept.` : "Nobody was working."), void refreshTeam(identity)))
        .catch((e: Error) => notify(/not found|404/i.test(e.message) ? "This Friday doesn't have that yet. Update it, then try again." : e.message));
      return null;
    case "pause":
    case "resume":
      await done(setPaused(identity, c.kind === "pause"), c.kind === "pause" ? "The crew is paused. Nothing new starts until /resume." : "The crew is back at work.");
      return null;
    case "away": {
      const until = nextAt(c.at) ?? nextEight();
      await done(setAway(identity, until), awaySaid(until));
      return null;
    }
    case "back":
      await done(comeBack(identity), (said) => String(said));
      return null;
    case "board":
      dispatchEvent(new Event("friday:team-board"));
      return null;
    case "brief":
      dispatchEvent(new CustomEvent("friday:brief", { detail: {} }));
      return null;
  }
}

/**
 * Under a message still waiting for a teammate: Edit (taken back and put in the box to change) and Cancel (taken back), for each
 * copy of it still unread (a message to several is a copy on each lane).
 */
export function QueuedActions({ seqs, send, onEdit }: { seqs: { lane: string; seq: number }[]; send: Send; onEdit: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!seqs.length) return null;
  const withdraw = async (toEdit = false) => {
    setBusy(true);
    try {
      // Taken back to be changed: the feed leaves it out, rather than a "Taken back" bubble over the one sent after the edit (2026-10-28 QA).
      for (const c of seqs) await send({ type: "instruction.withdraw", seq: c.seq, ...(c.lane !== "main" ? { lane: c.lane } : {}), ...(toEdit ? { toEdit: true } : {}) });
    } finally {
      setBusy(false);
      // The sidebar's count of what waits for them is read again now, and once more a moment later, rather than at the next poll:
      // Kit's row kept a "1" after its message was taken back to edit (Arun, 2026-10-29: the verification's leftovers).
      dispatchEvent(new Event("friday:teammates"));
      setTimeout(() => dispatchEvent(new Event("friday:teammates")), 1200);
    }
  };
  return (
    // Icons, each named on hover and to a screen reader (Arun, 2026-11-15: "use svg icons for this", the Edit and Cancel words).
    <span className="tm-queued-acts">
      <button type="button" className="tm-queued-btn" disabled={busy} aria-label="Edit before it's read" title="Edit before it's read" onClick={() => void withdraw(true).then(onEdit)}>
        <PencilIcon aria-hidden="true" />
      </button>
      <button type="button" className="tm-queued-btn" disabled={busy} aria-label="Take it back" title="Take it back" onClick={() => void withdraw()}>
        <XIcon aria-hidden="true" />
      </button>
    </span>
  );
}

