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
import { EllipsisIcon, FileCodeIcon, FileTextIcon, GitPullRequestIcon, ImageIcon, PackageIcon, CirclePauseIcon, KanbanSquareIcon, MessagesSquareIcon, MoonIcon, PlayIcon, SquareIcon, SunIcon, WorkflowIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SessionEvent } from "../types.js";
import type { SessionState } from "../session/projection.js";
import { api } from "./api.js";
import { useConfirm } from "./ui.js";
import type { Identity } from "./storage.js";
import type { Send } from "./useSession.js";
import { nextAt, nextEight, setAway, setPaused, stopAll, untilOf } from "./team-api.js";
import { threadsOf } from "./team-threads.js";
import { teamCommand } from "./team-commands.js";
import { plainLine } from "./team-room.js";
import { agoShort, Face, mateOn, mateStatus, openThread, refreshTeam, threadSaid, useTeamNow } from "./Teammates.js";
import { assignedTasks, TeamBoard } from "./TeamBoard.js";
import { openWorkflows } from "./team-workflow-view.js";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The teammates at work now, anywhere: whom Stop all cuts short. */
function useWorking() {
  const t = useTeamNow();
  return (t?.teammates ?? []).filter((m) => m.status === "working" || m.status === "waiting");
}

/** Stop every teammate's running turn, after saying whose; the queues stay. */
export function useStopAll(identity: Identity, notify: (m: string) => void): [() => void, React.ReactNode] {
  const [ask, confirmUI] = useConfirm();
  const working = useWorking();
  const run = () => {
    if (!working.length) return notify("Nobody in the crew is working.");
    const names = working.map((m) => `${m.name}${m.line ? ` (${m.line.slice(0, 48)})` : ""}`);
    ask({
      title: working.length === 1 ? `Stop ${working[0]!.name}?` : `Stop all ${working.length} teammates?`,
      body: `Cut short now: ${names.join("; ")}. What is queued for them stays queued, and they pick it up when you send something or press Resume.`,
      action: working.length === 1 ? "Stop" : "Stop all",
      icon: "stop", // A stop, not a deletion: no trash can (polish-crew, 2026-10-28).
      onConfirm: () =>
        stopAll(identity)
          .then((r) => (notify(r.stopped.length ? `Stopped ${r.stopped.length === 1 ? "1 teammate" : `${r.stopped.length} teammates`}. Their queues are kept.` : "Nobody was working."), refreshTeam(identity)))
          // An older server without stop-all: each teammate's own stop, which keeps its queue too.
          .catch(() => Promise.all(working.map((m) => api(identity, `/api/teammates/${m.id}/stop`, { method: "POST" }))).then(() => refreshTeam(identity))),
    });
  };
  return [run, confirmUI];
}

/** The team's controls in a team chat's header: Threads, Board, Stop all and the Away / Pause switch. */
export function TeamHeaderControls({ identity, state, events, send, notify }: { identity: Identity; state: SessionState; events: SessionEvent[]; send: Send; notify: (m: string) => void }) {
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
      <ThreadsButton sid={state.id} events={events} />
      <ResultsButton events={events} />
      {tasks.length ? (
        <button type="button" className="panel-tab icon tm-hd-btn" aria-label={`Board, ${open} open of ${tasks.length}`} title={`Board: ${open} open of ${tasks.length}`} onClick={() => setBoard(true)}>
          <KanbanSquareIcon className="size-[17px]" />
          {open > 0 && <span className="tm-hd-n">{open}</span>}
        </button>
      ) : (
        // Empty, a card under its button says so: a whole dialog, its own close box and all, for one sentence was too much (QA,
        // 2026-10-28; Arun: "TEST EVERYTHING… EVERY VISUAL"). /board still opens the dialog.
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" className="panel-tab icon tm-hd-btn" aria-label="Board" title="Board: the tasks the lead hands out">
              <KanbanSquareIcon className="size-[17px]" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="tm-pop tm-board-empty">
            <div className="tm-pop-head">
              <b>Board</b>
              <span>Nothing on it yet</span>
            </div>
            <p className="tm-board-empty-text">Give the lead a goal: they split the work into tasks here and hand them out.</p>
          </PopoverContent>
        </Popover>
      )}
      {/* The team's workflows: its automations, each run a board here or in a room (TeamWorkflows.tsx; Arun, 2026-10-28). */}
      <button type="button" className="panel-tab icon tm-hd-btn" aria-label="Workflows" title="Workflows: the crew's automations" onClick={openWorkflows}>
        <WorkflowIcon className="size-[17px]" />
      </button>
      {busy && (
        // A quiet ghost that turns red only under the pointer: the faces beside the title already say how many work (Arun,
        // 2026-10-29: "so clean and beautiful…"; DIRECTION.md §9.1). It was a red pill with a count.
        <button type="button" className="tm-stop-all" onClick={stop} aria-label={`Stop all: ${working.length} working`} title={`Stop every teammate's turn, keeping their queues (${isMac ? "⌘" : "Ctrl+"}.)`}>
          <SquareIcon className="size-3" />
          <span className="tm-stop-all-label">Stop all</span>
        </button>
      )}
      <AwaySwitch identity={identity} notify={notify} />
      {board && <TeamBoard state={state} send={send} onClose={() => setBoard(false)} />}
    </>
  );
}

/** A file's kind, for its mark on the shelf. */
const kindOf = (p: string) => (/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(p) ? "image" : /\.(mp4|mov|webm|m4v)$/i.test(p) ? "video" : /\.(md|mdx|txt|docx?|pdf)$/i.test(p) ? "doc" : "code");

/**
 * What this room's teammates made, on one shelf (Arun, 2026-10-28: the critique's "results shelf per room: the files and PRs
 * produced"): the files they changed, newest first, each opening where the session opens a file, and the pull requests they named.
 */
function ResultsButton({ events }: { events: SessionEvent[] }) {
  const [open, setOpen] = useState(false);
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
  if (!files.length && !prs.length) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="panel-tab icon tm-hd-btn tm-hd-extra" aria-label={`Results: ${files.length} files${prs.length ? `, ${prs.length} pull requests` : ""}`} title="What the crew made here">
          <PackageIcon className="size-[17px]" />
          <span className="tm-hd-n">{files.length + prs.length}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="tm-pop tm-results-pop">
        <div className="tm-pop-head">
          <b>Results</b>
          <span>
            {files.length} file{files.length === 1 ? "" : "s"}
            {prs.length ? ` · ${prs.length} PR${prs.length === 1 ? "" : "s"}` : ""}
          </span>
        </div>
        <ul className="tm-threads-list">
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
                <button type="button" className="tm-shelf-row" title={f.path} onClick={() => (dispatchEvent(new CustomEvent("friday:open-file", { detail: { path: f.path, lane: f.lane } })), setOpen(false))}>
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
      </PopoverContent>
    </Popover>
  );
}

/** The room's side threads in one list, open first: each a press from the thread (team-threads.ts). */
function ThreadsButton({ sid, events }: { sid: string; events: SessionEvent[] }) {
  const [open, setOpen] = useState(false);
  const threads = threadsOf(events);
  const list = useMemo(() => {
    const out: { root: number; lane: string; text: string; replies: number; last: number; state: string | undefined }[] = [];
    for (const [root, replies] of threads.byRoot) {
      const first = events.find((e) => e.seq === root);
      if (!first) continue;
      const text = first.body.type === "agent.message" || first.body.type === "instruction" ? first.body.text : "";
      out.push({ root, lane: first.lane ?? "main", text: plainLine(text), replies: replies.length, last: replies.at(-1)?.ts ?? first.ts, state: threads.state.get(root) });
    }
    // Waiting on a teammate first, then by the newest reply.
    return out.sort((a, b) => Number(b.state === "answering") - Number(a.state === "answering") || b.last - a.last);
  }, [threads, events]);
  if (!list.length) return null;
  const waiting = list.filter((x) => x.state === "answering").length;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="panel-tab icon tm-hd-btn tm-hd-threads" aria-label={`Threads: ${list.length}${waiting ? `, ${waiting} waiting for an answer` : ""}`} title="Threads in this room">
          <MessagesSquareIcon className="size-[17px]" />
          <span className={waiting ? "tm-hd-n live" : "tm-hd-n"}>{list.length}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="tm-pop tm-threads-pop">
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
                <button type="button" onClick={() => (openThread({ sid, root: x.root, lane: x.lane }), setOpen(false))}>
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
      </PopoverContent>
    </Popover>
  );
}

/**
 * Away until a time, and Pause team, in one place (Arun, 2026-10-28: "Away until 8:00 AM", with a time picker defaulting to the
 * next 8 AM). While away the button says until when; pressed, it says "I'm back".
 */
function AwaySwitch({ identity, notify }: { identity: Identity; notify: (m: string) => void }) {
  const t = useTeamNow();
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState("08:00");
  const [busy, setBusy] = useState(false);
  const away = t?.away?.until ? t.away : null;
  const paused = !!t?.paused;
  const until = nextAt(at) ?? nextEight();
  // Away and I'm back close the card; the Pause switch, a switch, stays where it is to be read and turned back (QA, 2026-10-28).
  const act = (p: Promise<unknown>, said: string, close = true) => {
    setBusy(true);
    p.then(() => (notify(said), refreshTeam(identity), close && setOpen(false)))
      .catch((e: Error) => notify(/not found|404/i.test(e.message) ? "This Friday doesn't have that yet. Update it, then try again." : e.message))
      .finally(() => setBusy(false));
  };
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
        {away ? (
          <div className="tm-away-body">
            <b className="tm-away-title">You're away until {untilOf(away.until!)}</b>
            <p>The crew decides for itself and notes what it assumed. You get the brief when you're back.</p>
            <Button size="sm" disabled={busy} onClick={() => act(setAway(identity, null), "Welcome back. The brief is in the Crew room.")}>
              <SunIcon className="size-4" /> I'm back
            </Button>
          </div>
        ) : (
          <form
            className="tm-away-body"
            onSubmit={(e) => {
              e.preventDefault();
              act(setAway(identity, until), `Away until ${untilOf(until)}. The crew carries on without asking.`);
            }}
          >
            <b className="tm-away-title">Step away</b>
            <p>Until then the crew decides for itself and notes what it assumed. Writing in any crew chat brings you back.</p>
            <label className="tm-away-time">
              <span>Back at</span>
              <Input type="time" value={at} onChange={(e) => setAt(e.target.value || "08:00")} aria-label="Back at" />
            </label>
            <p className="tm-away-note">Keep the lid open and the Mac on power: it stays awake while they work.</p>
            <Button type="submit" size="sm" disabled={busy}>
              <MoonIcon className="size-4" /> Away until {untilOf(until)}
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
  const act = (p: Promise<unknown>, said: string) => {
    setBusy(true);
    p.then(() => (notify(said), refreshTeam(identity))).catch((e: Error) => notify(e.message)).finally(() => setBusy(false));
  };
  if (away)
    return (
      <div className="tm-banner" data-kind={t.paused ? "paused" : "away"} role="status">
        {t.paused ? <CirclePauseIcon className="size-4 tm-banner-icon" /> : <MoonIcon className="size-4 tm-banner-icon" />}
        <p>
          <b>You're away until {untilOf(away.until!)}.</b>{" "}
          {t.paused ? "The crew is paused too: nothing new starts until you resume it." : "The crew decides for itself and notes what it assumed. Keep the lid open and the Mac on power."}
        </p>
        {t.paused && (
          <button type="button" className="tm-banner-btn" disabled={busy} onClick={() => act(setPaused(identity, false), "The crew is back at work.")}>
            <PlayIcon className="size-3.5" /> Resume
          </button>
        )}
        <button type="button" className="tm-banner-btn" disabled={busy} onClick={() => act(setAway(identity, null), "Welcome back. The brief is in the Crew room.")}>
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
  const done = (p: Promise<unknown>, said: string) =>
    p.then(() => (notify(said), void refreshTeam(identity))).catch((e: Error) => notify(/not found|404/i.test(e.message) ? "This Friday doesn't have that yet. Update it, then try again." : e.message));
  switch (c.kind) {
    case "bad":
      notify(c.why);
      throw new Error(c.why);
    case "say":
      return c.text;
    case "stop":
      // Says who it stopped, or that nobody was working (2026-10-28 QA: it always said it stopped everyone).
      await stopAll(identity)
        .then((r) => (notify(r.stopped.length ? `Stopped ${r.stopped.join(", ")}. Their queues are kept.` : "Nobody was working."), void refreshTeam(identity)))
        .catch((e: Error) => notify(/not found|404/i.test(e.message) ? "This Friday doesn't have that yet. Update it, then try again." : e.message));
      return null;
    case "pause":
    case "resume":
      await done(setPaused(identity, c.kind === "pause"), c.kind === "pause" ? "The crew is paused. Nothing new starts until /resume." : "The crew is back at work.");
      return null;
    case "away": {
      const until = nextAt(c.at) ?? nextEight();
      await done(setAway(identity, until), `Away until ${untilOf(until)}. The crew carries on without asking.`);
      return null;
    }
    case "back":
      await done(setAway(identity, null), "Welcome back. The brief is in the Crew room.");
      return null;
    case "board":
      dispatchEvent(new Event("friday:team-board"));
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
    <span className="tm-queued-acts">
      <button type="button" className="link-btn" disabled={busy} onClick={() => void withdraw(true).then(onEdit)}>
        Edit
      </button>
      <button type="button" className="link-btn" disabled={busy} onClick={() => void withdraw()}>
        Cancel
      </button>
    </span>
  );
}
