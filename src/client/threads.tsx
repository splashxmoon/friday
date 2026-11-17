import { useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ENGINE_NAMES, ENGINE_TOOLS, type EngineTool } from "../types.js";
import { NEW_THREAD, NEW_THREAD_ON_OPEN, ThreadsCtx, type ThreadsData } from "./threads-data.js";
import { useUnread } from "./unread.js";
import { hostApi, useMachine } from "./local.js";
import { issueBranch, parseIssueUrl, parsePrLink, withIssue, withPr, type Issue, type Pr } from "../github-issue.js";
import { startSession } from "./start-session.js";
import { Icon } from "./icons.js";
import { EngineMark } from "./BrandMarks.js";
import { MenuButton, placeCard, relTime, useDismiss } from "./ui.js";
import { isTeamSid } from "./Teammates.js";
import { folderName } from "./Workspace.js";
import type { Identity, RecentSession, RepoUse } from "./storage.js";
import "./threads.css";

/**
 * Threads: several sessions in one project folder, side by side (Arun, 2026-11-15: "i kinda like s1 and A but we need to refine
 * this design more and also make it easy to use and understand with the ring working states"; "Yes, build it"). A thread is a
 * coding session like any other; the project is the folder they share. Its tabs sit in the session's header, each with the ring
 * the sidebar gives it, a card of where it stands on hover, and + for the next one, in the folder itself or in a worktree of its
 * own. Closing a tab only takes it out of the strip: the session goes on, and stays in the sidebar.
 */

/** The project a session works in: its main lane's folder (reposOf). */
export type ThreadProject = RepoUse & { path: string };

const CLOSED_KEY = "mpa.threadsClosed";
function loadClosed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(CLOSED_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(-400) : [];
  } catch {
    return [];
  }
}
function saveClosed(v: string[]): void {
  try {
    localStorage.setItem(CLOSED_KEY, JSON.stringify(v.slice(-400)));
  } catch {
    /* a preference */
  }
}

const openSession = (sid: string, invite?: string) => dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid, ...(invite ? { invite } : {}) } }));
const labelOf = (r: RecentSession) => r.alias || r.title || "Untitled";

/** Where a thread stands, as the sidebar's row has it (Sidebar.tsx ChatRow): the same ring, so a tab and its row never disagree. */
function standing(d: ThreadsData, sid: string) {
  const a = d.attention;
  const needs = a.items.find((i) => i.sid === sid) ?? null;
  const working = a.working.get(sid) ?? null;
  const crew = a.crews.get(sid) ?? null;
  const waiting = a.needSids.has(sid);
  const state: "needs" | "working" | "idle" = needs || (waiting && !working) ? "needs" : working ? "working" : "idle";
  return { needs, working, crew, state };
}

/** Its ring, the sidebar row's own (Sidebar.tsx ThreadRing, handed down by App so this chunk doesn't pull the sidebar in). */
function Ring({ d, sid, active }: { d: ThreadsData; sid: string; active: boolean }) {
  return <>{d.ring(sid, active)}</>;
}

/**
 * The project's threads in the header, in the order they were started: the open one is the session's title (pressed, it is
 * renamed, as the title was), the others open with a press, + starts another.
 */
export function ThreadTabs({ sid, title, project, identity, tool, running, onRename }: { sid: string; title: string; project: ThreadProject; identity: Identity; /** The coding tool this session runs, the new thread's to start with. */ tool?: EngineTool | undefined; /** This session's agents are at work now, in the folder unless it is in a worktree. */ running: boolean; /** Pressing the open tab's name: rename it, when you may. */ onRename?: (() => void) | undefined }) {
  const d = useContext(ThreadsCtx);
  const [closed, setClosed] = useState(loadClosed);
  const [adding, setAdding] = useState(false);
  const plus = useRef<HTMLButtonElement>(null);
  const unread = useUnread();
  const now = Date.now();
  // Opened again from the sidebar or a link: back in the strip.
  useEffect(() => {
    if (!closed.includes(sid)) return;
    const next = closed.filter((x) => x !== sid);
    setClosed(next);
    saveClosed(next);
  }, [sid]); // eslint-disable-line react-hooks/exhaustive-deps
  // Opened from a folder's + in the sidebar (Sidebar.tsx): with New thread up.
  useEffect(() => {
    try {
      if (sessionStorage.getItem(NEW_THREAD_ON_OPEN) !== sid) return;
      sessionStorage.removeItem(NEW_THREAD_ON_OPEN);
    } catch {
      return;
    }
    // Once the header has drawn, so the box is placed under its +.
    requestAnimationFrame(() => setAdding(true));
  }, [sid]);
  // ⌘N (App.tsx): this project's New thread.
  useEffect(() => {
    const on = (e: Event) => {
      (e as CustomEvent<{ handled: boolean }>).detail.handled = true;
      setAdding(true);
    };
    addEventListener(NEW_THREAD, on);
    return () => removeEventListener(NEW_THREAD, on);
  }, []);
  if (!d) return null;
  const here: RecentSession = d.recents.find((r) => r.sid === sid) ?? { sid, title, invite: "", role: "owner", openedAt: now };
  // The project's sessions you have: the one open here always, the others unless closed from the strip, settled or snoozed.
  const threads = d.recents
    .filter((r) => r.sid !== sid && r.repos?.[0]?.name === project.name && !isTeamSid(r.sid) && !closed.includes(r.sid) && !r.settledAt && !(r.snoozedUntil && r.snoozedUntil > now))
    .concat(here)
    .sort((a, b) => a.openedAt - b.openedAt);
  const close = (r: RecentSession) => {
    const next = [...closed.filter((x) => x !== r.sid), r.sid];
    setClosed(next);
    saveClosed(next);
    if (r.sid !== sid) return;
    // The open one closed: its neighbour opens, the one after it, else the one before.
    const at = threads.findIndex((t) => t.sid === sid);
    const to = threads[at + 1] ?? threads[at - 1];
    if (to) openSession(to.sid, to.invite);
  };
  // Another of the project's threads at work in the folder itself, not a worktree of its own: a new one goes in a worktree.
  const inFolder = [...(running && !project.worktree ? [here] : []), ...threads.filter((r) => r.sid !== sid && !r.repos?.[0]?.worktree && d.attention.working.has(r.sid))];
  const name = folderName({ name: project.name, path: project.path });
  return (
    <div className="thr-tabs" role="tablist" aria-label={`Threads in ${name}`}>
      {threads.map((r) => (
        <ThreadTab key={r.sid} d={d} r={r} label={r.sid === sid ? title : labelOf(r)} active={r.sid === sid} unread={unread.has(r.sid)} closable={threads.length > 1} onOpen={() => (r.sid === sid ? onRename?.() : openSession(r.sid, r.invite))} onClose={() => close(r)} renamable={r.sid === sid && !!onRename} />
      ))}
      <button ref={plus} type="button" className={`thr-new${adding ? " on" : ""}`} aria-label={`New thread in ${name}`} title={`New thread in ${name} (${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘N" : "Ctrl+N"})`} aria-haspopup="dialog" aria-expanded={adding} onClick={() => setAdding((v) => !v)}>
        <Icon name="plus" size={14} />
      </button>
      {adding && <NewThread trigger={plus.current} d={d} project={project} name={name} identity={identity} tool={tool} busy={inFolder.map(labelOf)} onClose={() => setAdding(false)} />}
    </div>
  );
}

function ThreadTab({ d, r, label, active, unread, closable, renamable, onOpen, onClose }: { d: ThreadsData; r: RecentSession; label: string; active: boolean; unread: boolean; closable: boolean; renamable: boolean; onOpen: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [card, setCard] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hover = (on: boolean) => {
    clearTimeout(timer.current);
    // The open one's card would say what the page already shows.
    if (active) return;
    timer.current = setTimeout(() => setCard(on), on ? 450 : 160);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div
      ref={ref}
      role="tab"
      aria-selected={active}
      tabIndex={0}
      className={`thr-tab${active ? " on" : ""}${unread && !active ? " new" : ""}`}
      title={active && renamable ? `${label}: rename` : undefined}
      onClick={onOpen}
      onAuxClick={(e) => e.button === 1 && closable && (e.preventDefault(), onClose())}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") (e.preventDefault(), onOpen());
        // Left and right along the strip, as tabs move.
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          const tabs = [...(ref.current?.parentElement?.querySelectorAll<HTMLElement>(".thr-tab") ?? [])];
          const to = tabs[tabs.indexOf(ref.current!) + (e.key === "ArrowRight" ? 1 : -1)];
          if (to) (e.preventDefault(), to.focus());
        }
      }}
      onPointerEnter={() => hover(true)}
      onPointerLeave={() => hover(false)}
    >
      <Ring d={d} sid={r.sid} active={active} />
      {/* The open one's name renames it, as the title did: a button by that name, for the keyboard and a screen reader. */}
      {active && renamable ? (
        <span className="thr-name" role="button" aria-label={`${label}: rename`}>
          {label}
        </span>
      ) : (
        <span className="thr-name">{label}</span>
      )}
      {closable && (
        <button
          type="button"
          className="thr-x"
          aria-label={`Close the tab ${label} (it keeps going)`}
          title="Close the tab: the thread keeps going, and stays in the sidebar"
          onClick={(e) => (e.stopPropagation(), onClose())}
        >
          <Icon name="x" size={12} />
        </button>
      )}
      {card && <ThreadCard anchor={ref.current} d={d} r={r} label={label} onEnter={() => hover(true)} onLeave={() => hover(false)} />}
    </div>
  );
}

/** A thread's card, from its tab: where it stands, what waits on you, its branch and folder, its agents, the last thing asked. */
function ThreadCard({ anchor, d, r, label, onEnter, onLeave }: { anchor: HTMLElement | null; d: ThreadsData; r: RecentSession; label: string; onEnter: () => void; onLeave: () => void }) {
  const { needs, crew, working } = standing(d, r.sid);
  const since = d.attention.since.get(r.sid);
  const preview = d.attention.previews.get(r.sid);
  const pr = d.attention.prs.get(r.sid);
  const repo = r.repos?.[0];
  const agents = crew?.agents ?? [];
  const place = placeCard(anchor?.getBoundingClientRect(), 300, { want: 320, min: 160, prefer: "below" });
  // What was asked, only when it says more than the name: a thread is often named from it word for word.
  const plain = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const asked = preview && !plain(preview.text).startsWith(plain(label)) ? preview.text : "";
  return createPortal(
    <div className="thr-card surface" role="dialog" aria-label={label} style={{ ...place, position: "fixed" }} onPointerEnter={onEnter} onPointerLeave={onLeave} onClick={(e) => e.stopPropagation()}>
      <div className="thr-card-head">
        <Ring d={d} sid={r.sid} active={false} />
        <b>{label}</b>
        {since ? <span className="thr-card-when">{relTime(since)}</span> : null}
      </div>
      {needs && <p className={`thr-card-needs${needs.kind === "stopped" ? " stopped" : ""}`}>{needs.kind === "stopped" ? needs.text : `Needs you: ${needs.text}`}</p>}
      {!needs && working && <p className="thr-card-now">{working.what}</p>}
      <dl className="thr-kv">
        {repo?.branch && (
          <>
            <dt>Branch</dt>
            <dd>
              <code className="thr-branch" title={repo.branch}>{repo.branch}</code>
            </dd>
          </>
        )}
        <dt>Works in</dt>
        <dd className="thr-in">
          <Icon name={repo?.worktree ? "gitBranch" : "folder"} size={12} />
          {repo?.worktree ? "Its own worktree" : "This folder"}
        </dd>
        {agents.length > 0 && (
          <>
            <dt>{agents.length === 1 ? "Agent" : "Agents"}</dt>
            <dd className="thr-agents">
              {agents.slice(0, 4).map((a) => (
                <span key={a.lane}>
                  {a.tool && <EngineMark tool={a.tool} size={12} />}
                  <span className="thr-agent-name">{a.name.replace(/^[^']+'s /, "")}</span>
                  <span className="thr-word">{a.word}</span>
                </span>
              ))}
            </dd>
          </>
        )}
        {asked && (
          <>
            <dt>Asked</dt>
            <dd className="thr-asked">{asked}</dd>
          </>
        )}
        {pr && (
          <>
            <dt>Pull request</dt>
            <dd>
              #{pr.url.split("/").pop()} <span className="thr-word">{pr.merged ? "merged" : "open"}</span>
            </dd>
          </>
        )}
      </dl>
    </div>,
    document.body,
  );
}


/**
 * A new thread in the project: what to do, where (the folder itself, or a worktree of its own on a new branch, chosen for you when
 * another thread is at work in the folder), which coding tool, Start. The steps are the new-session page's (Code.tsx submit): the
 * session, its tool in the folder, then the task. ⌘Enter starts it and leaves the box open for the next one.
 */
function NewThread({ trigger, d, project, name, identity, tool: first, busy, onClose }: { trigger: HTMLElement | null; d: ThreadsData; project: ThreadProject; name: string; identity: Identity; tool?: EngineTool | undefined; /** The threads at work in the folder itself now. */ busy: string[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose, trigger);
  const { state: machine } = useMachine(identity);
  const tools = ENGINE_TOOLS.filter((t) => machine.tools.some((x) => x.tool === t && x.path));
  const [tool, setTool] = useState<EngineTool | "">(first ?? "");
  useEffect(() => {
    if (!tool || (tools.length && !tools.includes(tool))) setTool(tools.find((t) => machine.tools.some((x) => x.tool === t && x.loggedIn === true)) ?? tools[0] ?? "claude");
  }, [tools.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const [where, setWhere] = useState<"folder" | "worktree">(busy.length ? "worktree" : "folder");
  const [task, setTask] = useState("");
  // What it starts from besides words (Arun, 2026-11-16, Orca's Create worktree): one of the repo's issues, pull requests or branches.
  const [from, setFrom] = useState<From | null>(null);
  const [picking, setPicking] = useState<"issue" | "pr" | "branch" | null>(null);
  const [busyNow, setBusyNow] = useState(false);
  const [err, setErr] = useState("");
  const [said, setSaid] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => box.current?.focus(), []);

  const start = async (again: boolean) => {
    // The task is optional, as a new thread is in other tools: without one it opens empty, to be asked in its own composer.
    let text = task.trim();
    if (busyNow || !tool) return;
    setBusyNow(true);
    setErr("");
    setSaid("");
    try {
      // An issue or pull request link pasted in the box is that issue or pull request, as on the new-session page.
      const pasted = !from ? (parsePrLink(text) ? { kind: "pr" as const, url: parsePrLink(text)!.url } : parseIssueUrl(text) ? { kind: "issue" as const, url: parseIssueUrl(text)!.url } : null) : null;
      const pick = from ?? pasted;
      let aside: { branch: string; base?: string; fetch?: boolean } | undefined;
      let named: string | undefined;
      let inFolder = where === "folder";
      if (pick?.kind === "issue") {
        const { issue } = await hostApi<{ issue: Issue }>(identity, `/api/runner/github.item?url=${encodeURIComponent(pick.url)}`);
        text = withIssue(pasted ? text.replace(pick.url, "").trim() : text, issue);
        named = `#${issue.number} ${issue.title}`;
        aside = { branch: issueBranch(issue), base: project.branch || "HEAD" };
        inFolder = false;
      } else if (pick?.kind === "pr") {
        const { pr } = await hostApi<{ pr: Pr }>(identity, `/api/runner/github.item?url=${encodeURIComponent(pick.url)}`);
        if (pr.fork) throw new Error(`#${pr.number} is from a fork, so its branch isn't on origin. Open its link on the new-session page instead.`);
        text = withPr(pasted ? text.replace(pick.url, "").trim() : text, pr);
        named = `PR #${pr.number} ${pr.title}`;
        // Its own branch, fetched first; in the folder itself when that is the branch checked out there.
        if (pr.head && pr.head === project.branch) inFolder = true;
        else ((aside = { branch: pr.head, fetch: true }), (inFolder = false));
      } else if (pick?.kind === "branch") {
        if (pick.name === project.branch) inFolder = true;
        else ((aside = { branch: pick.name, fetch: true }), (inFolder = false));
      }
      const { sid, invite, title } = await startSession(identity, { path: project.path, tool, text, worktree: !inFolder, ...(aside ? { aside } : {}), ...(named ? { title: named } : {}) });
      // On the list now, so it is a tab and a sidebar row before it is opened.
      d.remember({ sid, title, invite, role: "owner", openedAt: Date.now(), repos: [{ name: project.name, path: project.path, live: true, ...(!inFolder ? { worktree: true, ...(aside ? { branch: aside.branch } : {}) } : project.branch ? { branch: project.branch } : {}) }] });
      setBusyNow(false);
      if (!again) return (onClose(), openSession(sid, invite));
      // The next one: the box empties, in a worktree now that this one works in the folder.
      setTask("");
      setFrom(null);
      if (box.current) box.current.style.height = "";
      setSaid(`Started “${title}”`);
      if (where === "folder") setWhere("worktree");
      box.current?.focus();
    } catch (e) {
      setErr((e as Error).message || "That didn't start.");
      setBusyNow(false);
    }
  };

  const place = placeCard(trigger?.getBoundingClientRect(), 400, { want: 380, min: 240, prefer: "below" });
  const who = busy.length ? `${busy[0]}${busy.length > 1 ? ` and ${busy.length - 1} more` : ""}` : "";
  const ready = !busyNow && !!tool;
  return createPortal(
    <div ref={ref} className="thr-pop surface" role="dialog" aria-label={`New thread in ${name}`} style={{ ...place, position: "fixed" }}>
      <div className="thr-pop-head">
        <span className="thr-pop-title">New thread</span>
        <span className="thr-pop-in">
          <Icon name="folder" size={12} />
          <span>{name}</span>
        </span>
        <kbd className="thr-kbd">⌘N</kbd>
      </div>
      {/* The task and how it runs in one box, as the composer has them: the coding tool at its foot, Start beside it. */}
      <div className="thr-box">
        {from && (
          <div className="thr-from-chip">
            <Icon name={from.kind === "branch" ? "gitBranch" : from.kind === "pr" ? "gitPullRequest" : "flag"} size={12} />
            <span className="thr-from-text">{from.kind === "branch" ? from.name : `#${from.number} ${from.title}`}</span>
            <button type="button" className="thr-from-x" aria-label="Start from nothing" onClick={() => setFrom(null)}>
              <Icon name="x" size={11} />
            </button>
          </div>
        )}
        <textarea
          ref={box}
          className="thr-task"
          rows={2}
          value={task}
          placeholder={from ? "Anything to add? (optional)" : "What should it work on? Or paste an issue or PR link"}
          aria-label="What the new thread should work on"
          onChange={(e) => {
            setTask(e.target.value);
            // Grows with what is typed, as the composer does, rather than a grip to drag.
            const el = e.target;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            void start(e.metaKey || e.ctrlKey);
          }}
        />
        <div className="thr-box-foot">
          <MenuButton
            text={tool ? ENGINE_NAMES[tool] : "Coding tool"}
            mark={tool ? <EngineMark tool={tool} size={13} /> : undefined}
            label="Which coding tool"
            className="thr-tool"
            compact
            items={() => (tools.length ? tools : ENGINE_TOOLS.slice(0, 1)).map((t) => ({ label: ENGINE_NAMES[t], mark: <EngineMark tool={t} size={14} />, checked: t === tool, onSelect: () => setTool(t) }))}
          />
          <span className="thr-grow" />
          <button type="button" className="thr-start" disabled={!ready} onClick={() => void start(false)}>
            {busyNow ? <span className="spinner" /> : null}
            <span>{busyNow ? "Starting" : task.trim() || from ? "Start" : "Open empty"}</span>
            {!busyNow && <kbd aria-hidden="true">↵</kbd>}
          </button>
        </div>
      </div>
      <div className="thr-from-row" role="group" aria-label="Start from">
        <span className="thr-label">From</span>
        {(["issue", "pr", "branch"] as const).map((k) => (
          <button key={k} type="button" className={`thr-from-btn${picking === k ? " on" : ""}${from?.kind === k ? " picked" : ""}`} aria-expanded={picking === k} onClick={() => setPicking(picking === k ? null : k)}>
            <Icon name={k === "branch" ? "gitBranch" : k === "pr" ? "gitPullRequest" : "flag"} size={12} />
            {k === "issue" ? "Issue" : k === "pr" ? "Pull request" : "Branch"}
          </button>
        ))}
      </div>
      {picking && <FromList kind={picking} identity={identity} project={project} onPick={(f) => (setFrom(f), setPicking(null), box.current?.focus())} />}
      {from ? (
        <p className="thr-where-note thr-from-where">
          <Icon name="gitBranch" size={12} />
          {from.kind === "issue" ? (
            <>
              <span>New worktree on</span> <code>{issueBranch({ number: from.number, title: from.title })}</code>
            </>
          ) : (from.kind === "branch" ? from.name : from.head) === project.branch ? (
            <>
              <span>In this folder, on</span> <code>{project.branch}</code>
            </>
          ) : (
            <>
              <span>New worktree on</span> <code>{from.kind === "branch" ? from.name : from.head}</code>
            </>
          )}
        </p>
      ) : picking ? null : (
      <div className="thr-where-block">
        <div className="thr-label" id="thr-where">Where it works</div>
        {/* A track with the choice lifted off it, as Friday's segmented controls are. */}
        <div className="thr-where" role="radiogroup" aria-labelledby="thr-where">
          <button type="button" role="radio" aria-checked={where === "folder"} className="thr-opt" onClick={() => setWhere("folder")}>
            <span className="thr-opt-name">
              <Icon name="folder" size={13} /> This folder
            </span>
            <small>Your checkout, as it is</small>
          </button>
          <button type="button" role="radio" aria-checked={where === "worktree"} className="thr-opt" onClick={() => setWhere("worktree")}>
            <span className="thr-opt-name">
              <Icon name="gitBranch" size={13} /> New worktree
            </span>
            <small>Its own copy and branch</small>
          </button>
        </div>
        <p className="thr-where-note">
          {where === "folder" && who ? (
            <span className="thr-warn">
              <span className="thr-warn-dot" aria-hidden="true" />
              {who} {busy.length > 1 ? "are" : "is"} working in this folder now
            </span>
          ) : (
            <>
              <Icon name="gitBranch" size={12} />
              <span>{where === "folder" ? "On" : "From"}</span>
              <code title={project.branch}>{project.branch ?? "the current branch"}</code>
            </>
          )}
        </p>
      </div>
      )}
      {err ? (
        <p className="thr-note error" role="alert">{err}</p>
      ) : (
        <p className="thr-note" role="status">
          {said ? (
            <span className="thr-said">
              <Icon name="check" size={12} /> {said}
            </span>
          ) : (
            <>
              <kbd className="thr-kbd">↵</kbd> starts and opens it <span className="thr-dot">·</span> <kbd className="thr-kbd">⌘↵</kbd> starts it, then the next
            </>
          )}
        </p>
      )}
    </div>,
    document.body,
  );
}

type From = { kind: "issue"; number: number; title: string; url: string } | { kind: "pr"; number: number; title: string; url: string; head: string } | { kind: "branch"; name: string };
type Item = { number: number; title: string; url: string; head?: string; fork?: boolean; labels?: string[]; author?: string; updatedAt?: string };
const lists = new Map<string, Promise<{ issues: Item[]; prs: Item[] } | { error: string }>>();

/** The repo's open issues, pull requests or branches, with a box to narrow them: one press starts the thread from it. */
function FromList({ kind, identity, project, onPick }: { kind: "issue" | "pr" | "branch"; identity: Identity; project: ThreadProject; onPick: (f: From) => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<{ key: string; title: string; sub: string; from: From; dim?: boolean }[] | null>(null);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), [kind]);
  useEffect(() => {
    let gone = false;
    setRows(null);
    setError("");
    if (kind === "branch") {
      void hostApi<{ folder: { branches?: { name: string; remote?: true }[] } }>(identity, `/api/runner/describe?path=${encodeURIComponent(project.path)}&branches=1`).then(
        (r) => {
          if (gone) return;
          const seen = new Set<string>();
          const all = (r.folder.branches ?? []).filter((b) => !seen.has(b.name) && seen.add(b.name));
          setRows(all.map((b) => ({ key: b.name, title: b.name, sub: b.name === project.branch ? "checked out here" : b.remote ? "on origin" : "", from: { kind: "branch", name: b.name } })));
        },
        (e: Error) => !gone && setError(e.message),
      );
    } else {
      const key = project.path;
      if (!lists.has(key)) lists.set(key, hostApi<{ issues: Item[]; prs: Item[] } | { error: string }>(identity, `/api/runner/repo.items?path=${encodeURIComponent(project.path)}`));
      void lists.get(key)!.then(
        (r) => {
          if (gone) return;
          if ("error" in r) return (lists.delete(key), setError(r.error));
          const items = kind === "issue" ? r.issues : r.prs;
          setRows(
            items.map((x) => ({
              key: x.url,
              title: `#${x.number} ${x.title}`,
              sub: [kind === "pr" ? x.head : "", x.author ? `by ${x.author}` : "", x.updatedAt ? relTime(Date.parse(x.updatedAt)) : "", ...(x.labels ?? []).slice(0, 2)].filter(Boolean).join(" · "),
              dim: !!x.fork,
              from: kind === "issue" ? { kind: "issue", number: x.number, title: x.title, url: x.url } : { kind: "pr", number: x.number, title: x.title, url: x.url, head: x.head ?? "" },
            })),
          );
        },
        (e: Error) => (lists.delete(key), !gone && setError(e.message)),
      );
    }
    return () => void (gone = true);
  }, [kind, project.path]); // eslint-disable-line react-hooks/exhaustive-deps
  const words = q.trim().toLowerCase();
  const shown = (rows ?? []).filter((r) => !words || `${r.title} ${r.sub}`.toLowerCase().includes(words)).slice(0, 40);
  const noun = kind === "issue" ? "issues" : kind === "pr" ? "pull requests" : "branches";
  return (
    <div className="thr-from-list">
      <input
        ref={input}
        className="thr-from-find"
        value={q}
        placeholder={`Find ${kind === "branch" ? "a branch" : kind === "pr" ? "a pull request" : "an issue"}`}
        aria-label={`Find one of the ${noun}`}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && shown[0]) (e.preventDefault(), onPick(shown[0].from));
        }}
      />
      <ul className="thr-from-rows" role="listbox" aria-label={`Open ${noun}`}>
        {error ? (
          <li className="thr-from-empty">{error}</li>
        ) : rows === null ? (
          <li className="thr-from-empty">
            <span className="spinner" /> Loading {noun}…
          </li>
        ) : !shown.length ? (
          <li className="thr-from-empty">{rows.length ? `No ${noun} match “${q.trim()}”` : `No open ${noun}`}</li>
        ) : (
          shown.map((r) => (
            <li key={r.key}>
              <button type="button" role="option" aria-selected={false} className={`thr-from-item${r.dim ? " dim" : ""}`} onClick={() => onPick(r.from)} title={r.dim ? "From a fork: its branch isn't on origin" : r.title}>
                <span className="thr-from-item-title">{r.title}</span>
                {r.sub && <span className="thr-from-item-sub">{r.sub}</span>}
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
