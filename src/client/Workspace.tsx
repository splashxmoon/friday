import { ChevronRightIcon, ClockIcon, CloudDownloadIcon, CornerDownLeftIcon, CornerLeftUpIcon, FolderGit2Icon, FolderIcon, FolderOpenIcon, FolderSearchIcon, GitBranchIcon, HistoryIcon, LayersIcon, LockIcon, SearchIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { CliSession, CliSessionList } from "../runner/imports.js";
import { parseRepo } from "../runner/repo.js";
import type { FolderInfo, GithubRepo } from "../runner/workspace.js";
import { ENGINE_NAMES, ENGINE_TOOLS, type EngineMode, type EngineTool } from "../types.js";
import { EngineMark } from "./BrandMarks.js";
import { PresenceRing } from "./presence.js";
import { Icon } from "./icons.js";
import { api } from "./api.js";
import { GitHubConnect } from "./GitHubConnect.js";
import { hostApi, installedOn, type MachineMode } from "./local.js";
import { resumeProblem, type ResumeLink } from "./resume-link.js";
import { splitTools } from "./engines.js";
import { loadRecentFolderTimes, loadRecentFolders, saveRecentFolder, type Identity } from "./storage.js";
import { placeCard, relTime, useDismiss } from "./ui.js";

/**
 * Choosing where a coding agent works, in one card.
 *
 * Everything is one list behind one search box — the repos you already have,
 * your GitHub repos, and the sessions your CLI can continue — because the
 * question is always "which code?", not "which source of code?". Typing a
 * repo URL or a path is also just a row in that list.
 */

export interface Picked {
  folder: FolderInfo;
  /** A past CLI conversation this continues, keeping its context and memory. */
  resume?: CliSession;
}

/** What the app knows about its own version. Mirrors desktop/update.ts. */
export interface DesktopUpdate {
  stage: "idle" | "checking" | "available" | "downloading" | "ready" | "current" | "error" | "unsupported";
  version?: string;
  percent?: number;
  error?: string;
  current: string;
}

declare global {
  interface Window {
    /** Present in the Friday desktop app only. */
    fridayDesktop?: {
      /** "darwin", "win32", "linux" — which window furniture the page has to live with. */
      platform?: string;
      trafficLightY?: number;
      /** Whether the window is in full screen, as the window says it (an app built before it said nothing). */
      onFullScreen?(fn: (full: boolean) => void): () => void;
      pickFolder(): Promise<string | null>;
      pathForFile(file: File): string;
      /** Link this computer to the Friday the window is showing; the app runs the runner. */
      link?(req: { server: string; token: string }): Promise<{ ok: boolean; error?: string }>;
      /** The link this computer is already running for that server, if any. */
      linkedToken?(server: string): Promise<string>;
      /** Keeping this computer awake while an agent runs on it (from 0.1.50): whether that is on, and whether one runs now. */
      keepAwake?(): Promise<{ on: boolean; running: boolean } | null>;
      setKeepAwake?(on: boolean): Promise<boolean>;
      /** Setting up an always-on machine over SSH (from 0.1.51): the hosts in ~/.ssh/config, and the setup. */
      ssh?: {
        hosts(): Promise<string[]>;
        setup(req: { host: string; server: string; token: string; id: string }): Promise<{ ok: true; how: string; warn?: string } | { ok: false; error: string }>;
      };
      /** Open a page in the person's own browser rather than in this window. */
      openExternal?(url: string): Promise<boolean>;
      /** The quick prompt (desktop/quick.ts): the main window is handed what was typed in the floating box. */
      quick?: {
        send(text: string, snapshot?: { data: string; mimeType: string; width: number; height: number }): Promise<boolean>;
        snapshot(): Promise<{ data: string; mimeType: string; width: number; height: number } | { error: string }>;
        close(): Promise<boolean>;
        onShown(fn: () => void): () => void;
        onPrompt(fn: (m: { text: string; snapshot?: { data: string; mimeType: string; width: number; height: number } }) => void): () => void;
      };
      /** A chat site drawn by the desktop app over a rectangle the page keeps. */
      chat?: {
        show(id: string, rect: { x: number; y: number; width: number; height: number }): Promise<boolean>;
        bounds(rect: { x: number; y: number; width: number; height: number }): void;
        hide(): Promise<boolean>;
        act(id: string, action: "reload" | "back" | "forward" | "browser"): Promise<boolean>;
        forget(id: string): Promise<boolean>;
        onWhere?(fn: (id: string, host: string) => void): () => void;
        onSignIn?(fn: (id: string, on: boolean) => void): () => void;
      };
      /** Close the app and open it again (an app from before 0.1.67 doesn't have it). */
      relaunch?(): Promise<boolean>;
      /** Which version the app is on, and whether a newer one is waiting. */
      update?: {
        state(): Promise<DesktopUpdate>;
        check(): Promise<DesktopUpdate>;
        install(): Promise<boolean>;
        onState(fn: (s: DesktopUpdate) => void): () => void;
      };
      /** Open a folder, or a file at a line, in this computer's editor, file manager or terminal (from the app after 0.1.74 / 0.1.4). */
      openTargets?(): Promise<{ id: string; label: string; editor: boolean }[]>;
      openIn?(target: string, path: string, line?: number): Promise<{ ok: boolean; error?: string }>;
      openFile?(file: string): Promise<{ ok: boolean; error?: string }>;
      browser?: { tab(sid: string, tab: string, wcId: number): void; active(sid: string, tab: string): void; gone(sid: string): void; onOpen(fn: (ask: { sid: string; url: string }) => void): () => void };
      /** The dock's count of what waits on you; 0 clears it. */
      setBadge?(n: number): void;
      /** Tell the app which theme is showing, so the window buttons match it. */
      setTheme?(theme: "dark" | "light", choice?: "system" | "dark" | "light"): void;
      /** Real shells on this computer, drawn by the terminal panel. */
      terminal?: {
        start(opts: { id: string; cols: number; rows: number; cwd?: string }): Promise<{ ok: boolean; shell?: string; cwd?: string; resumed?: boolean; replay?: string; error?: string }>;
        write(id: string, data: string): void;
        resize(id: string, cols: number, rows: number): void;
        kill(id: string): void;
        onData(fn: (id: string, data: string) => void): () => void;
        onExit(fn: (id: string, code: number) => void): () => void;
      };
    };
  }
}

interface Data {
  recent: FolderInfo[] | null;
  /** The computer's home folder, for paths said from it ("~/code"). */
  home?: string;
  github: { installed: boolean; available: boolean; account?: string; reason?: string; repos: GithubRepo[]; from?: "connection" } | null;
  sessions: { sessions: CliSession[]; notes: Record<string, string> } | null;
}

// Results are the same for every card in a tab, and a fresh scan on every open
// makes the menu feel slow. 60s is long enough to help, short enough that a
// repo cloned a moment ago still shows up.
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export const forgetWorkspaceCache = () => cache.clear();

function useWorkspaceData(identity: Identity, tool: EngineTool, open: boolean, nonce = 0): Data {
  const [data, setData] = useState<Data>({ recent: null, github: null, sessions: null });
  useEffect(() => {
    if (!open) return;
    let live = true;
    const set = (patch: Partial<Data>) => live && setData((d) => ({ ...d, ...patch }));
    // Three independent requests, each rendering the moment it lands.
    void cached("folders", () => hostApi<{ recent: FolderInfo[]; home?: string }>(identity, "/api/runner/folders")).then(
      async (r) => {
        const mine = await Promise.all(
          loadRecentFolders().map((p) => hostApi<{ folder: FolderInfo }>(identity, `/api/runner/describe?path=${encodeURIComponent(p)}`).then((x) => x.folder, () => null)),
        );
        const seen = new Set<string>();
        set({ recent: [...mine.filter((f): f is FolderInfo => !!f), ...r.recent].filter((f) => !seen.has(f.path) && !!seen.add(f.path)), ...(r.home ? { home: r.home } : {}) });
      },
      () => set({ recent: [] }),
    );
    // The machine's gh first, since it can clone into a real checkout. If it
    // has nothing to say — no machine, no gh, not signed in — ask the
    // workspace's own GitHub connection, which knows the same list.
    void cached("github", () => hostApi<Data["github"]>(identity, "/api/runner/github"))
      .then(
        (r) => r,
        () => ({ installed: false, available: false, repos: [] }) as NonNullable<Data["github"]>,
      )
      .then(async (r) => {
        const fromMachine = r ?? { installed: false, available: false, repos: [] as GithubRepo[] };
        if (fromMachine.repos.length) return set({ github: fromMachine });
        const c = await api<{ connection: string; repos: GithubRepo[] }>(identity, "/api/github/repos").catch(() => null);
        if (!live) return;
        set({ github: c && c.repos.length ? { installed: true, available: true, account: c.connection, repos: c.repos, from: "connection" } : fromMachine });
      });
    // Not cached: this one is a local directory read, and a list of "your
    // recent sessions" that is a minute out of date is the list missing the
    // session you just left.
    // The runner reads only the transcripts that changed since it last looked, so asking every time costs little.
    void hostApi<Data["sessions"]>(identity, `/api/runner/sessions?tool=${tool}`).then(
      (r) => set({ sessions: r }),
      // Not "none": that this machine couldn't be asked is not the same as it having nothing.
      () => set({ sessions: { sessions: [], notes: { [tool]: "Couldn't read this machine's sessions." } } }),
    );
    return () => {
      live = false;
    };
  }, [identity, tool, open, nonce]);
  return data;
}

/**
 * A path as somebody would say it out loud.
 *
 * The home directory is the longest and least informative part of every path
 * on the screen, and the browser has no way to ask what it is — so it is
 * recognised by shape instead. Wrong only for a folder that genuinely lives
 * two levels under /Users, which is not a folder anybody keeps code in.
 */
const shortPath = (p: string, home = "") => {
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p.replace(/^(\/Users|\/home|[A-Za-z]:\\Users)[\/\\][^\/\\]+/, "~");
};

export function WorkspacePill({
  identity,
  tool,
  value,
  resume,
  onPick,
  onTool,
  className = "",
  text,
}: {
  /** Words of its own in place of the folder's name, for a way to pick another one ("Another folder or repo…"). */
  text?: string;
  identity: Identity;
  tool: EngineTool;
  value: FolderInfo | null;
  resume?: CliSession;
  onPick: (p: Picked | null) => void;
  /** A conversation of another agent was picked: switch to the agent that can continue it. */
  onTool?: (t: EngineTool) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const [drag, setDrag] = useState(false);

  const label = value ? `${folderName(value)}${value.branch ? ` · ${value.branch}` : ""}` : "Choose code";
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`menu-pill ws-pill ${open ? "on" : ""} ${drag ? "drag" : ""} ${className}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={value ? value.path : "Choose the folder or repo to work in"}
        onClick={() => setOpen((v) => !v)}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={() => {
          setDrag(false);
          setOpen(true);
        }}
      >
        {text ? <Icon name="plus" size={14} /> : value?.isRepo ? <FolderGit2Icon className="size-3.5" /> : <FolderIcon className="size-3.5" />}
        <span className="ws-pill-text">{text ?? label}</span>
        {!text && <Icon name="chevronDown" size={13} className="menu-pill-caret" />}
      </button>
      {open && <WorkspaceCard identity={identity} tool={tool} trigger={btn.current} resume={resume} onPick={onPick} {...(onTool ? { onTool } : {})} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * The card: search, what you can continue, and where the code is.
 *
 * `only` narrows it to one of those, because the composer's menu asks for one
 * at a time — you picked "Repos" already, and repeating the sessions list
 * under it is the menu asking the question twice.
 */
export function WorkspaceCard({
  identity,
  tool,
  trigger,
  resume,
  only: onlyAsked,
  onPick,
  onTool,
  onClose,
  plain = false,
  prefer = "above",
}: {
  identity: Identity;
  tool: EngineTool;
  trigger: HTMLElement | null;
  /** Which side of the trigger it opens on, where there is room: under a link below the box, below (QA, 2026-10-28). */
  prefer?: "above" | "below";
  resume?: CliSession;
  /** Show one half of the card: what you can continue, or where code lives. */
  only?: "sessions" | "repos";
  /** Folders, not repositories: no sessions to continue, no GitHub, no clone, no branches. */
  plain?: boolean;
  onPick: (p: Picked | null) => void;
  /** A session of another agent was picked: the composer should switch to that agent to continue it. */
  onTool?: (tool: EngineTool) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const only = plain ? "repos" : onlyAsked;
  useDismiss(ref, onClose, trigger);
  // Which agent's past sessions are listed. Starts on the agent the composer has.
  const [view, setView] = useState<EngineTool>(tool);
  // The tools on this computer, and the one being looked at; the rest one tab away.
  const tabs = splitTools(installedOn(identity), view);
  const [moreTabs, setMoreTabs] = useState(false);
  // Asked again once GitHub is connected from here, so the repos appear without reopening.
  const [nonce, setNonce] = useState(0);
  const data = useWorkspaceData(identity, view, true, nonce);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [browsing, setBrowsing] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  /** The repository whose other worktrees are shown under it. */
  const [worktreesOf, setWorktreesOf] = useState<string | null>(null);
  /** The source the list shows; while a name is typed every source is searched, unless one is picked (`scoped`). */
  const [source, setSource] = useState<PickSource>("recent");
  const [scoped, setScoped] = useState<PickSource | null>(null);
  const desktop = typeof window !== "undefined" ? window.fridayDesktop : undefined;

  // Above the trigger, like the composer's other cards (Arun, 2026-10-20): with Home's box now near the top, "below where
  // there is room" had it dropping down over the page. Below only when there is no room above.
  // Opened from the folder tray under the box, it lines up with the tray: its left and right edges on the tray's (Arun,
  // 2026-11-08: "it should start and end from the left and right side of the new folder section").
  const tray = only !== "sessions" ? (trigger?.closest(".composer-below") as HTMLElement | null) : null;
  const place = placeCard((tray ?? trigger)?.getBoundingClientRect(), tray ? tray.getBoundingClientRect().width : only === "sessions" ? 460 : 680, { want: 520, min: 240, prefer, gap: 8 });

  const choose = (folder: FolderInfo, session?: CliSession) => {
    saveRecentFolder(folder.path);
    // Continuing Codex's conversation with Claude would be a different
    // conversation entirely, so the agent follows the session.
    if (session) onTool?.(session.tool);
    onPick({ folder, ...(session ? { resume: session } : {}) });
    onClose();
  };

  const byPath = async (p: string, session?: CliSession) => {
    setBusy(p);
    setErr("");
    try {
      const r = await hostApi<{ folder: FolderInfo }>(identity, `/api/runner/describe?path=${encodeURIComponent(p)}`);
      choose(r.folder, session);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const clone = async (repo: string) => {
    setBusy(repo);
    setErr("");
    try {
      const r = await hostApi<{ folder: FolderInfo }>(identity, "/api/runner/clone", { method: "POST", body: JSON.stringify({ repo }) });
      cache.delete("folders");
      choose(r.folder);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const real = desktop?.pathForFile(file);
    if (real) return void byPath(real);
    // A browser only reveals the folder's name, so look it up where code lives.
    setBusy(file.name);
    try {
      const { matches } = await hostApi<{ matches: FolderInfo[] }>(identity, `/api/runner/find?name=${encodeURIComponent(file.name)}`);
      if (matches.length === 1) choose(matches[0]!);
      else if (matches.length > 1) {
        setQ(file.name);
        setErr(`Several folders are called “${file.name}”. Pick one below.`);
      } else setErr(`Couldn't find “${file.name}” in your usual code folders. Try Browse.`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const query = q.trim();
  const repo = plain ? null : parseRepo(query);
  const looksLikePath = /^(~|\/|[A-Za-z]:[\\/]|\.\.?[\\/])/.test(query);
  const match = (s: string) => s.toLowerCase().includes(query.toLowerCase());

  const sessions = (data.sessions?.sessions ?? []).filter((s) => !query || match(s.title) || match(s.cwd));
  const recent = (data.recent ?? []).filter((f) => !query || match(f.name) || match(f.path));
  const repos = (data.github?.repos ?? []).filter((r) => !query || match(r.slug) || match(r.description));
  // More while searching, because a search is somebody looking for one thing
  // in particular and eight rows is not enough room to find it in.
  const shownRepos = repos.slice(0, query ? 40 : 8);
  const moreRepos = repos.length - shownRepos.length;

  // Folders: a path being typed lists the folders it could be, as a path field does ("~/Desk" offers Desktop), not only the
  // recent ones, which said "Nothing matches" (Arun, 2026-10-28: "iron everything and ensure we are good").
  const [typed, setTyped] = useState<{ q: string; entries: FolderInfo[] } | null>(null);
  useEffect(() => {
    // Nothing set while the query isn't a path in the folder picker: a state set from this effect on every key, null over null,
    // ran a render of its own after each one, and fast typing stacked them past React's limit (#185) and lost keys (audit CODE-3,
    // Arun 2026-11-04). The rows below show only the answer for the query as it is now (typedRows), so an old one is never seen.
    if (!looksLikePath) return;
    const cut = query.search(/[\\/][^\\/]*$/);
    const parent = cut >= 0 ? query.slice(0, cut + 1) : query;
    const part = cut >= 0 ? query.slice(cut + 1).toLowerCase() : "";
    let live = true;
    const t = setTimeout(
      () =>
        void hostApi<{ entries: FolderInfo[] }>(identity, `/api/runner/browse?path=${encodeURIComponent(parent)}`).then(
          (d) => live && setTyped({ q: query, entries: d.entries.filter((f) => !f.name.startsWith(".") && f.name.toLowerCase().startsWith(part)).slice(0, 8) }),
          () => live && setTyped({ q: query, entries: [] }),
        ),
      180,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [looksLikePath, query, identity]);
  const typedRows = typed && typed.q === query ? typed.entries : [];

  // Enter picks the obvious thing: clone what was pasted, use a typed path, or take the first row.
  const enter = () => {
    if (repo && !recent.length) return void clone(query);
    if (looksLikePath) return void byPath(query);
    if (recent[0]) return choose(recent[0]);
    if (sessions[0]) return void byPath(sessions[0].cwd, sessions[0]);
    if (repo) return void clone(query);
  };

  const sessionsBlock = (
    <>
      {(
        <ScrollTabs className="ws-tabs" label="Whose sessions" active={view}>
          {[...tabs.here, ...(moreTabs ? tabs.away : [])].map((t) => (
            <button key={t} type="button" role="tab" aria-selected={view === t} className={`ws-tab ${view === t ? "on" : ""}`} onClick={() => setView(t)}>
              <EngineMark tool={t} size={14} />
              {ENGINE_NAMES[t]}
            </button>
          ))}
          {tabs.away.length > 0 && (
            <button type="button" className="ws-tab more" aria-expanded={moreTabs} onClick={() => setMoreTabs((v) => !v)}>
              {moreTabs ? "Fewer" : `+${tabs.away.length}`}
            </button>
          )}
        </ScrollTabs>
      )}
      {data.sessions !== null && sessions.length === 0 && (
        // What the machine said about it, which knows the difference between none, none it can read, and none that can be continued.
        <p className="ws-empty">{query ? `No ${ENGINE_NAMES[view]} session matches “${query}”.` : (data.sessions.notes[view] ?? `No ${ENGINE_NAMES[view]} sessions on this machine yet.`)}</p>
      )}
      {sessions.length > 0 && (
        <Section label={`Continue a ${ENGINE_NAMES[view]} session`}>
          {sessions.slice(0, 6).map((s) => (
            <Row
              key={`${s.tool}-${s.id}`}
              icon={busy === s.cwd ? <span className="spinner" /> : <HistoryIcon className="size-4" />}
              title={s.title}
              // A transcript too long to read whole has no count worth showing: the part that was read says nothing about the rest.
              // No count is known for a session the tool itself listed (over ACP): it is left out rather than said as none.
              // The folder by a person's name for it: "Scratch folder", not "scratch-2026-11-03-c0317b" (Arun's e2e pass, 2026-11-04).
              sub={[folderName({ name: s.cwd.split(/[\\/]/).filter(Boolean).pop() ?? s.cwd, path: s.cwd }), s.approx ? "long session" : s.messages ? `${s.messages} message${s.messages === 1 ? "" : "s"}` : "", relTime(s.updatedAt)].filter(Boolean).join(" · ")}
              active={resume?.id === s.id}
              onClick={() => void byPath(s.cwd, s)}
            />
          ))}
        </Section>
      )}

    </>
  );

  const body = browsing ? (
    <Browser identity={identity} path={browsing} filter={q.trim().startsWith("/") || q.trim().startsWith("~") ? "" : q.trim()} onOpen={(p) => (setQ(""), setBrowsing(p))} onUse={(f) => choose(f)} onBack={() => setBrowsing(null)} />
  ) : (
    <div className="ws-scroll">
      {err && <p className="ws-note error">{err}</p>}
      {repo && (
        <Row
          icon={busy === query ? <span className="spinner" /> : <CloudDownloadIcon className="size-4" />}
          title={`Clone ${repo.slug ?? repo.name}`}
          sub={data.github?.available === false && data.github.installed === false ? "with git" : "into ~/Friday"}
          onClick={() => void clone(query)}
        />
      )}
      {/* The folder's name first and its path under it: "Use /private/tmp/claude-501/-Users-…" cut off the name (2026-10-28 QA). */}
      {looksLikePath && <Row icon={<FolderIcon className="size-4" />} title={`Use ${query.split(/[\\/]/).filter(Boolean).pop() ?? query}`} sub={shortPath(query)} onClick={() => void byPath(query)} />}
      {typedRows.map((f) => (
        <Row key={f.path} icon={busy === f.path ? <span className="spinner" /> : <FolderIcon className="size-4" />} title={f.name} sub={shortPath(f.path)} onClick={() => choose(f)} />
      ))}

      {only !== "repos" && sessionsBlock}

      {only !== "sessions" && !(plain && looksLikePath && recent.length === 0) && (
        <>
      <Section label={plain ? "Recent folders" : "Your repos"} loading={data.recent === null}>
        {/* A row a repository, its other worktrees folded under it; a folder by the name a person gives it; under it, its branch
            and where it is from home ("fix/export-timeout · ~/code"), not a /private/tmp path cut off (audit CODE-16 A, Arun
            2026-11-04: edge-app twice, "scratch-2026-11-03-c0317b"). */}
        {ranked(byRepo(recent, plain), plain).slice(0, 8).map(({ f, more }) => {
          const row = (x: FolderInfo, inner = false) => (
            <Row
              key={x.path}
              icon={busy === x.path ? <span className="spinner" /> : x.isRepo && !plain ? <FolderGit2Icon className="size-4" /> : <FolderIcon className="size-4" />}
              title={inner ? (x.branch ?? folderName(x)) : folderName(x)}
              sub={folderLine(x, plain, data.home, inner)}
              onClick={() => choose(x)}
            />
          );
          const open = worktreesOf === f.path;
          return (
            <div key={f.path} className={`ws-repo${open ? " open" : ""}`}>
              {row(f)}
              {more.length > 0 && (
                <button type="button" className="ws-wt" aria-expanded={open} onClick={() => setWorktreesOf(open ? null : f.path)}>
                  {more.length + 1} {more.some((x) => inWorktrees(x.path)) ? "worktrees" : "copies"}
                  <ChevronRightIcon className="size-3.5" />
                </button>
              )}
              {open && <div className="ws-wt-list">{more.map((x) => row(x, true))}</div>}
            </div>
          );
        })}
        {data.recent?.length === 0 && <p className="ws-empty">{plain ? "No folders yet. Browse to one, or type its path." : "No git repos found in your usual code folders."}</p>}
        {data.recent !== null && recent.length === 0 && data.recent.length > 0 && !(plain && looksLikePath) && <p className="ws-empty">Nothing matches “{query}”.</p>}
      </Section>

      {!plain && (
      <Section label="GitHub" loading={data.github === null}>
        {shownRepos.map((r) => (
          <Row
            key={r.slug}
            icon={busy === r.slug ? <span className="spinner" /> : <CloudDownloadIcon className="size-4" />}
            title={r.slug}
            sub={r.description || "clone into ~/Friday"}
            trailing={r.private ? <LockIcon className="size-3 opacity-60" /> : undefined}
            onClick={() => void clone(r.slug)}
          />
        ))}
        {data.github && !data.github.available && (
          <div className="ws-gh-cta">
            <GitHubConnect
              identity={identity}
              compact
              why="Pick from your repos and clone them here."
              onChange={() => {
                cache.delete("github");
                setNonce((x) => x + 1);
              }}
            />
          </div>
        )}
        {/* Said, not hidden. Eight of two hundred with nothing to mark the
            other hundred and ninety-two is how somebody concludes their
            repos are missing. Typing narrows the list rather than paging it,
            because you know the name of the one you want. */}
        {moreRepos > 0 && <p className="ws-empty">{moreRepos} more — type to narrow.</p>}

        {/* Nowhere to get repos from: the GitHubConnect card above is the one pointer. A second "Connect GitHub" under it, to the
            same place in other words, read as two ways to do two things (2026-10-28 QA; Arun: "TEST EVERYTHING… EVERY VISUAL"). */}
        {data.github?.available && repos.length === 0 && <p className="ws-empty">{query ? `No repo matches “${query}”.` : "No repos on this account."}</p>}
      </Section>
      )}
        </>
      )}
    </div>
  );

  const sessionsCard =
    only === "sessions"
      ? createPortal(
    <div
      ref={ref}
      data-owned-floating
      className={`ws-card ${drag ? "drag" : ""}`}
      role="dialog"
      aria-label={plain ? "Choose a folder" : "Choose where the agent works"}
      style={place}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => void onDrop(e)}
    >
      <div className="ws-search">
        <SearchIcon className="size-4 shrink-0 opacity-60" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              enter();
            }
          }}
          placeholder={browsing ? "Find a folder in here, or type a path" : plain ? "Find a folder, or type its path" : "Search your repos, paste a GitHub URL, or type a path"}
          spellCheck={false}
          aria-label={plain ? "Find a folder" : "Search repos"}
        />
      </div>
      {body}
      <div className="ws-foot">
        {/* Two ways to look for a folder, each saying which: in this card, or (in the desktop app) in the system's own window,
            "Browse…" beside "Choose folder…" having read as two names for one thing (Arun, 2026-10-28: "TEST EVERYTHING… EVERY
            INTERACTION, EVERY VISUAL"). */}
        {browsing ? (
          <button type="button" className="btn ghost small" onClick={() => setBrowsing(null)}>
            Back to search
          </button>
        ) : (
          // The search starts empty in the folders: a query left from the search filtered nothing there and read as stale (2026-10-28 QA).
          <button type="button" className="btn ghost small" onClick={() => (setQ(""), setBrowsing("~"))} title="Go through the folders on this computer, here">
            <FolderSearchIcon className="size-3.5" /> {desktop ? "Browse here…" : "Browse…"}
          </button>
        )}
        {desktop && (
          <button
            type="button"
            className="btn ghost small"
            title={`Pick a folder in ${systemPicker(desktop.platform)}`}
            onClick={async () => {
              const p = await desktop.pickFolder();
              if (p) await byPath(p);
            }}
          >
            <FolderOpenIcon className="size-3.5" /> {desktop.platform === "darwin" ? "Choose in Finder…" : desktop.platform === "win32" ? "Choose in Explorer…" : "Choose folder…"}
          </button>
        )}
        <span className="ws-drop-hint">or drop a folder here</span>
      </div>
    </div>,
    document.body,
  )
      : null;

  // ── The picker (Arun, 2026-11-08: B with A's rows): where the code is, by source on the left, each folder as a row on the
  // right that says what it is (a repository's branch, where it lives, when it was last picked). Continuing a CLI's past
  // conversation keeps its own card, above.
  const all = data.recent ?? [];
  const groups = ranked(byRepo(all, plain), plain);
  const times = loadRecentFolderTimes();
  const stored = loadRecentFolders();
  const usedAt = (g: { f: FolderInfo; more: FolderInfo[] }) => {
    const paths = [g.f.path, ...g.more.map((x) => x.path)];
    const at = Math.max(0, ...paths.map((p) => times[p] ?? 0));
    return at || g.f.mtime || 0;
  };
  const storedAt = (g: { f: FolderInfo; more: FolderInfo[] }) => {
    const i = [g.f.path, ...g.more.map((x) => x.path)].map((p) => stored.indexOf(p)).filter((i) => i >= 0);
    return i.length ? Math.min(...i) : Infinity;
  };
  // Recent: the ones picked here, last first, then what was worked in most lately; six at most.
  const recentGroups = [...groups].sort((a, b) => storedAt(a) - storedAt(b) || usedAt(b) - usedAt(a)).slice(0, 6);
  const repoGroups = plain ? [] : groups.filter((g) => g.f.isRepo);
  const worktreeList = plain ? [] : all.filter((f) => f.isRepo && inWorktrees(f.path));
  const folderGroups = groups.filter((g) => plain || !g.f.isRepo);
  const ghRepos = data.github?.repos ?? [];
  const SOURCES: { id: PickSource; label: string; icon: ReactNode }[] = [
    { id: "recent", label: "Recent", icon: <ClockIcon className="size-3.5" /> },
    ...(plain
      ? []
      : ([
          { id: "repos", label: "Repos", icon: <GitBranchIcon className="size-3.5" /> },
          { id: "worktrees", label: "Worktrees", icon: <LayersIcon className="size-3.5" /> },
        ] as const)),
    { id: "folders", label: "Folders", icon: <FolderIcon className="size-3.5" /> },
    ...(plain ? [] : ([{ id: "github", label: "GitHub", icon: <CloudDownloadIcon className="size-3.5" /> }] as const)),
    // The card opened from a folder pill with no `only` offers a past conversation to continue too, as it did.
    ...(!onlyAsked && !plain ? ([{ id: "sessions", label: "Sessions", icon: <HistoryIcon className="size-3.5" /> }] as const) : []),
  ];

  const parentOf = (p: string) => p.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]+$/, "") || p;
  const where = (f: FolderInfo) => scratchSub(f) ?? (plain ? shortPath(f.path, data.home) : shortPath(parentOf(f.path), data.home));
  const has = (f: FolderInfo) => match(f.name) || match(f.path) || (!!f.branch && match(f.branch));
  const groupItem = (g: { f: FolderInfo; more: FolderInfo[] }, src: PickSource, when?: number): PickItem[] => {
    const f = g.f;
    const open = worktreesOf === f.path && src !== "recent" && !query;
    const copies = g.more.some((x) => inWorktrees(x.path)) ? "worktree" : "copy";
    const extra = g.more.length ? ` · ${g.more.length} ${copies === "worktree" ? (g.more.length === 1 ? "worktree" : "worktrees") : g.more.length === 1 ? "copy" : "copies"}` : "";
    const head: PickItem = {
      key: `${src}:${f.path}`,
      kind: f.isRepo && !plain ? "repo" : "folder",
      title: data.home && f.path.replace(/[\\/]+$/, "") === data.home.replace(/[\\/]+$/, "") ? "Home" : folderName(f),
      ...(f.isRepo && !plain && f.branch ? { branch: f.branch } : {}),
      sub: (data.home && f.path.replace(/[\\/]+$/, "") === data.home.replace(/[\\/]+$/, "") ? "~" : where(f)) + extra,
      ...(when ? { when: relTime(when) } : {}),
      busy: busy === f.path,
      run: () => choose(f),
      ...(g.more.length && src === "repos" && !query ? { toggle: { open, label: `${g.more.length} other ${copies === "worktree" ? (g.more.length === 1 ? "worktree" : "worktrees") : g.more.length === 1 ? "copy" : "copies"} of ${folderName(f)}`, run: () => setWorktreesOf(open ? null : f.path) } } : {}),
    };
    const inner: PickItem[] = open
      ? g.more.map((x) => ({ key: `${src}:${x.path}`, kind: "worktree", nested: true, title: x.branch ?? folderName(x), ...(x.branch ? { branch: x.branch, title: "" } : {}), sub: shortPath(x.path, data.home), busy: busy === x.path, run: () => choose(x) }))
      : [];
    return [head, ...inner];
  };
  const worktreeItem = (f: FolderInfo): PickItem => ({ key: `wt:${f.path}`, kind: "worktree", title: folderName(f).replace(/-[0-9a-f]{8}$/, ""), ...(f.branch ? { branch: f.branch } : {}), sub: shortPath(f.path, data.home), busy: busy === f.path, run: () => choose(f) });
  const ghItem = (r: GithubRepo): PickItem => ({ key: `gh:${r.slug}`, kind: "github", title: r.slug, sub: r.description || "Clone into ~/Friday", lock: r.private, ...(r.updatedAt ? { when: relTime(Date.parse(r.updatedAt)) } : {}), busy: busy === r.slug, verb: "Clone", run: () => void clone(r.slug) });

  // What each source holds, or, while a name is typed, how many of it match.
  const searching = !!query && !looksLikePath && !repo;
  const per: Record<PickSource, PickItem[]> = {
    recent: recentGroups.filter((g) => !searching || has(g.f) || g.more.some(has)).flatMap((g) => groupItem(g, "recent", usedAt(g) || undefined)),
    repos: repoGroups.filter((g) => !searching || has(g.f) || g.more.some(has)).flatMap((g) => groupItem(g, "repos")),
    worktrees: worktreeList.filter((f) => !searching || has(f)).map(worktreeItem),
    folders: folderGroups.filter((g) => !searching || has(g.f)).flatMap((g) => groupItem(g, "folders")),
    github: ghRepos.filter((r) => !searching || match(r.slug) || match(r.description)).map(ghItem),
    sessions: [],
  };
  const count = (s: PickSource) => (s === "recent" ? (searching ? per.recent.length : recentGroups.length) : s === "repos" ? (searching ? per.repos.length : repoGroups.length) : s === "folders" ? (searching ? per.folders.length : folderGroups.length) : s === "sessions" ? null : per[s].length);

  const sections: { label: string; right?: ReactNode; items: PickItem[]; /** One source's list: no heading, the rail says it. */ bare?: boolean }[] = [];
  if (repo) sections.push({ label: "Clone", items: [{ key: "clone", kind: "github", title: `Clone ${repo.slug ?? repo.name}`, sub: data.github?.available === false && data.github.installed === false ? "with git" : "into ~/Friday", busy: busy === query, verb: "Clone", run: () => void clone(query) }] });
  if (looksLikePath) {
    const cut = query.search(/[\\/][^\\/]*$/);
    const parent = cut >= 0 ? query.slice(0, cut + 1) : query;
    sections.push({
      label: `In ${parent.replace(/[\\/]$/, "") || parent}`,
      right: (
        <span className="wsp-hint">
          <kbd>tab</kbd> completes
        </span>
      ),
      items: [
        ...typedRows.map((f): PickItem => ({ key: `path:${f.path}`, kind: f.isRepo && !plain ? "repo" : "folder", title: f.name, ...(f.isRepo && !plain && f.branch ? { branch: f.branch } : {}), sub: shortPath(f.path, data.home), busy: busy === f.path, complete: shortPath(f.path, data.home), run: () => choose(f) })),
        // The path as typed, for a folder the list can't show (a hidden one, or one typed whole).
        { key: "use", kind: "use", title: `Use ${query.split(/[\\/]/).filter(Boolean).pop() ?? query}`, sub: shortPath(query), busy: busy === query, run: () => void byPath(query) },
      ],
    });
  } else if (searching && !scoped) {
    // A name searches every source at once, the recent ones first; a folder already listed isn't listed again under another.
    const seen = new Set<string>();
    const once = (items: PickItem[]) => items.filter((i) => {
      const p = i.key.slice(i.key.indexOf(":") + 1);
      return !seen.has(p) && !!seen.add(p);
    });
    for (const s of SOURCES) if (s.id !== "sessions") {
      const items = once(per[s.id]);
      if (items.length) sections.push({ label: s.id === "recent" ? `Best matches for “${query}”` : s.label, items: s.id === "github" ? items.slice(0, 12) : items.slice(0, 20) });
    }
  } else if (source !== "sessions") {
    const items = source === "github" ? per.github.slice(0, query ? 40 : 30) : per[source];
    const label = source === "recent" ? (plain ? "Recent folders" : "Recent") : source === "repos" ? "Repos on this computer" : source === "worktrees" ? "Worktrees" : source === "folders" ? (plain ? "Your folders" : "Folders") : data.github?.account ? `${data.github.account} on GitHub` : "GitHub";
    const right = source === "recent" ? "Last used first" : source === "github" ? (data.github?.available ? "Clones into ~/Friday" : "") : source === "worktrees" ? "Each on its own branch" : "";
    sections.push({ label, ...(right ? { right: <span className="wsp-hint">{right}</span> } : {}), items, bare: true });
  }
  const flat = sections.flatMap((s) => s.items);
  const [sel, setSel] = useState(0);
  const at = Math.min(sel, Math.max(0, flat.length - 1));
  const list = useRef<HTMLDivElement>(null);
  // A new list starts at its first row.
  useEffect(() => setSel(0), [query, source, scoped]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-idx="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);
  const cycle = (dir: 1 | -1) => {
    const ids = SOURCES.map((s) => s.id);
    const from = ids.indexOf(scoped ?? source);
    const next = ids[(from + dir + ids.length) % ids.length]!;
    setBrowsing(null);
    if (searching) setScoped(next);
    else setSource(next);
  };
  const pickSource = (s: PickSource) => {
    setBrowsing(null);
    if (searching) setScoped(scoped === s ? null : s);
    else setSource(s);
  };
  const keys = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") return (e.preventDefault(), onClose());
    if (browsing) {
      if (e.key === "Enter") e.preventDefault();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length) setSel((at + (e.key === "ArrowDown" ? 1 : -1) + flat.length) % flat.length);
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      // A path completes like a terminal; anything else steps to the next source.
      const done = looksLikePath ? flat[at]?.complete : undefined;
      if (done) return setQ(`${done}/`);
      return cycle(e.shiftKey ? -1 : 1);
    }
    if (e.key === "ArrowRight" && flat[at]?.toggle && !flat[at]!.toggle!.open && (e.currentTarget.selectionStart ?? 0) >= e.currentTarget.value.length) {
      e.preventDefault();
      return flat[at]!.toggle!.run();
    }
    if (e.key === "ArrowLeft" && flat[at]?.toggle?.open && (e.currentTarget.selectionStart ?? 0) >= e.currentTarget.value.length) {
      e.preventDefault();
      return flat[at]!.toggle!.run();
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (flat[at]) flat[at]!.run();
      else enter();
    }
  };
  // No source is "on" while browsing, typing a path or a repo's address: the list is none of them.
  const railOn = browsing || looksLikePath || repo ? null : searching ? scoped : source;
  let idx = 0;
  const listBody =
    browsing ? (
      <Browser identity={identity} path={browsing} filter={q.trim().startsWith("/") || q.trim().startsWith("~") ? "" : q.trim()} onOpen={(p) => (setQ(""), setBrowsing(p))} onUse={(f) => choose(f)} onBack={() => setBrowsing(null)} />
    ) : source === "sessions" && !searching ? (
      <div className="ws-scroll">{sessionsBlock}</div>
    ) : (
      <div className="wsp-list" ref={list}>
        {err && <p className="ws-note error">{err}</p>}
        {data.recent === null && source !== "github" && !looksLikePath && (
          <p className="wsp-empty">
            <span className="spinner tiny" /> Looking for your folders…
          </p>
        )}
        {sections.map((s) => (
          <div key={s.label} className={`wsp-section${s.bare ? " bare" : ""}`}>
            {!s.bare && (
              <div className="wsp-head">
                <span>{s.label}</span>
                {s.right}
              </div>
            )}
            {s.items.map((it) => {
              const i = idx++;
              return <PickRow key={it.key} item={it} idx={i} on={i === at} query={searching ? query : ""} onHover={() => setSel(i)} />;
            })}
          </div>
        ))}
        {/* What each source says when it has nothing, in its own words. */}
        {!flat.length && data.recent !== null && !looksLikePath && !repo && (
          <p className="wsp-empty">
            {searching
              ? scoped
                ? `No ${SOURCES.find((x) => x.id === scoped)?.label.toLowerCase()} match “${query}”.`
                : `Nothing called “${query}” in your folders${plain ? "" : ", repos or GitHub"}. Type its path, or browse to it.`
              : source === "repos"
                ? "No git repos found in your usual code folders."
                : source === "worktrees"
                  ? "No worktrees yet. Friday makes one when a session works on its own branch."
                  : source === "folders"
                    ? plain
                      ? "No folders yet. Browse to one, or type its path."
                      : "No plain folders yet: every one here is a repo."
                    : source === "github"
                      ? data.github === null
                        ? "Asking GitHub…"
                        : data.github.available
                          ? "No repos on this account."
                          : ""
                      : plain
                        ? "No folders yet. Browse to one, or type its path."
                        : "Nothing picked yet. Your repos are one source down."}
          </p>
        )}
        {source === "github" && !searching && data.github && !data.github.available && (
          <div className="ws-gh-cta">
            <GitHubConnect
              identity={identity}
              compact
              why="Pick from your repos and clone them here."
              onChange={() => {
                cache.delete("github");
                setNonce((x) => x + 1);
              }}
            />
          </div>
        )}
        {source === "github" && !searching && ghRepos.length > 30 && <p className="wsp-empty">{ghRepos.length - 30} more. Type to narrow.</p>}
      </div>
    );

  if (sessionsCard) return sessionsCard;
  return createPortal(
    <div
      ref={ref}
      data-owned-floating
      className={`ws-card wsp ${drag ? "drag" : ""}`}
      role="dialog"
      aria-label={plain ? "Choose a folder" : "Choose where the agent works"}
      style={place}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDrag(false)}
      onDrop={(e) => void onDrop(e)}
    >
      <div className="ws-search wsp-search">
        <SearchIcon className="size-4 shrink-0 opacity-60" />
        <input
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            if (!e.target.value.trim()) setScoped(null);
          }}
          onKeyDown={keys}
          placeholder={browsing ? "Find a folder in here, or type a path" : plain ? "Find a folder, or type its path" : "Search folders and repos, or type a path"}
          spellCheck={false}
          aria-label={plain ? "Find a folder" : "Search repos"}
          aria-controls={undefined}
        />
        <kbd className="wsp-kbd" aria-hidden>
          esc
        </kbd>
      </div>
      <div className="wsp-body">
        <nav className="wsp-rail" aria-label="Where to look">
          <div className="wsp-sources" role="tablist" aria-orientation="vertical">
            {SOURCES.map((s) => {
              const n = count(s.id);
              const faded = searching && !scoped && n === 0;
              return (
                <button key={s.id} type="button" role="tab" aria-selected={railOn === s.id} tabIndex={-1} className={`wsp-src${railOn === s.id ? " on" : ""}${faded ? " faded" : ""}`} onClick={() => pickSource(s.id)}>
                  {s.icon}
                  <span>{s.label}</span>
                  {n !== null && (s.id !== "github" || data.github?.available) && <span className="wsp-n">{data.recent === null && s.id !== "github" ? "" : n}</span>}
                </button>
              );
            })}
          </div>
        </nav>
        <div className="wsp-main">{listBody}</div>
      </div>
      {/* Always in sight, whatever the window's height: the ways to a folder that isn't listed, then the keys. */}
      <div className="wsp-foot">
        <button type="button" className="wsp-foot-btn" onClick={() => (setQ(""), setBrowsing(browsing ? null : "~"))} title="Go through the folders on this computer, here" aria-pressed={!!browsing}>
          <FolderSearchIcon className="size-3.5" />
          {desktop ? "Browse here…" : "Browse…"}
        </button>
        {desktop && (
          <button
            type="button"
            className="wsp-foot-btn"
            title={`Pick a folder in ${systemPicker(desktop.platform)}`}
            onClick={async () => {
              const p = await desktop.pickFolder();
              if (p) await byPath(p);
            }}
          >
            <FolderOpenIcon className="size-3.5" />
            {desktop.platform === "darwin" ? "Choose in Finder…" : desktop.platform === "win32" ? "Choose in Explorer…" : "Choose folder…"}
          </button>
        )}
        <span className="wsp-drop">or drop one here</span>
        <span className="wsp-keys" aria-hidden>
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd>
          </span>
          <span>
            <kbd>tab</kbd> {looksLikePath ? "complete" : "source"}
          </span>
          <span>
            <kbd>↵</kbd> {flat[at]?.verb === "Clone" ? "clone" : "open"}
          </span>
        </span>
      </div>
      {drag && (
        <div className="wsp-dropzone" aria-hidden>
          <FolderIcon className="size-7" strokeWidth={1.5} />
          <b>Drop to work in this folder</b>
        </div>
      )}
    </div>,
    document.body,
  );
}

type PickSource = "recent" | "repos" | "worktrees" | "folders" | "github" | "sessions";
interface PickItem {
  key: string;
  kind: "repo" | "folder" | "worktree" | "github" | "use";
  title: string;
  branch?: string;
  sub: string;
  when?: string;
  lock?: boolean;
  nested?: boolean;
  busy?: boolean;
  /** What Enter does, said on the chosen row: "Open", or "Clone" for a repo on GitHub. */
  verb?: string;
  /** A path row: what Tab fills the search with. */
  complete?: string;
  toggle?: { open: boolean; label: string; run: () => void };
  run: () => void;
}

/** A part of a name that matches what is typed, marked. */
function marked(text: string, q: string): ReactNode {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="wsp-hit">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

/** One folder: what it is (its tile), its name and branch, where it lives, and when it was last picked or what Enter does. */
function PickRow({ item, idx, on, query, onHover }: { item: PickItem; idx: number; on: boolean; query: string; onHover: () => void }) {
  const tile = item.busy ? <span className="spinner" /> : item.kind === "repo" ? <GitBranchIcon className="size-3.5" /> : item.kind === "worktree" ? <LayersIcon className="size-3.5" /> : item.kind === "github" ? <CloudDownloadIcon className="size-3.5" /> : item.kind === "use" ? <CornerDownLeftIcon className="size-3.5" /> : <FolderIcon className="size-3.5" />;
  return (
    <div className={`wsp-item${item.nested ? " nested" : ""}${item.toggle ? " has-toggle" : ""}`}>
      <button type="button" aria-current={on ? "true" : undefined} data-idx={idx} className={`wsp-row${on ? " on" : ""}${item.kind === "use" ? " use" : ""}`} onMouseMove={on ? undefined : onHover} onClick={item.run}>
        {!item.nested && <span className="wsp-tile">{tile}</span>}
        <span className="wsp-text">
          <span className="wsp-line">
            {item.title && <span className="wsp-name">{marked(item.title, query)}</span>}
            {item.branch && (
              <span className="wsp-branch" title={item.branch}>
                <GitBranchIcon className="size-3" />
                <span>{marked(item.branch, query)}</span>
              </span>
            )}
            {item.lock && <LockIcon className="size-3 shrink-0 opacity-60" aria-label="Private" />}
          </span>
          <span className="wsp-sub">{item.sub}</span>
        </span>
        {on ? (
          <span className="wsp-open" aria-hidden>
            {item.verb ?? "Open"} <CornerDownLeftIcon className="size-3" />
          </span>
        ) : (
          item.when && <span className="wsp-when">{item.when}</span>
        )}
      </button>
      {item.toggle && (
        <button type="button" className="wsp-toggle" aria-expanded={item.toggle.open} aria-label={item.toggle.open ? `Hide the ${item.toggle.label}` : `Show the ${item.toggle.label}`} title={item.toggle.label} onClick={item.toggle.run}>
          <ChevronRightIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}


/** The system's own folder window, by name, for the desktop app's "Choose in …" button. */
function systemPicker(platform: string | undefined): string {
  return platform === "darwin" ? "the Finder" : platform === "win32" ? "File Explorer" : "the system's folder window";
}

function Section({ label, children, loading }: { label: string; children?: ReactNode; loading?: boolean }) {
  return (
    <div className="ws-section">
      <div className="ws-section-label">
        {label}
        {loading && <span className="spinner tiny" />}
      </div>
      {children}
    </div>
  );
}

function Row({ icon, title, sub, trailing, active, onClick }: { icon: ReactNode; title: string; sub?: string; trailing?: ReactNode; active?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`ws-row ${active ? "on" : ""}`} onClick={onClick}>
      <span className="ws-row-icon">{icon}</span>
      <span className="ws-row-text">
        <span className="ws-name">{title}</span>
        {sub && <span className="ws-path">{sub}</span>}
      </span>
      {trailing}
    </button>
  );
}

function Browser({ identity, path, filter = "", onOpen, onUse, onBack }: { identity: Identity; path: string; /** What is typed in the card's search: the folders here whose names have it. */ filter?: string; onOpen: (p: string) => void; onUse: (f: FolderInfo) => void; onBack: () => void }) {
  const [dir, setDir] = useState<{ path: string; parent: string | null; isRepo: boolean; entries: FolderInfo[] } | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    hostApi<{ path: string; parent: string | null; isRepo: boolean; entries: FolderInfo[] }>(identity, `/api/runner/browse?path=${encodeURIComponent(path)}`).then(
      (d) => live && (setDir(d), setErr("")),
      (e) => live && setErr((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [identity, path]);

  if (err)
    return (
      <div className="ws-scroll">
        <p className="ws-note error">{err}</p>
        <button type="button" className="btn ghost small" onClick={onBack}>
          Back
        </button>
      </div>
    );
  if (!dir) return <p className="ws-empty">Opening…</p>;
  const name = dir.path.split(/[\\/]/).filter(Boolean).pop() ?? dir.path;
  const shown = filter ? dir.entries.filter((f) => f.name.toLowerCase().includes(filter.toLowerCase())) : dir.entries;
  return (
    <>
      <div className="ws-crumb">
        <button type="button" className="icon-btn tiny" disabled={!dir.parent} title="Up one folder" aria-label="Up one folder" onClick={() => dir.parent && onOpen(dir.parent)}>
          <CornerLeftUpIcon className="size-3.5" />
        </button>
        {/* The folder you are in by name, where it is after it: the whole path cut at its end hid the one part that changes as you
            go up and down (2026-10-28 QA). */}
        <span className="ws-path ws-crumb-path" title={dir.path}>
          <b className="ws-crumb-name">{name}</b>
          {dir.parent && <span> in {shortPath(dir.parent)}</span>}
        </span>
        <button type="button" className="btn primary small" onClick={() => onUse({ path: dir.path, name, isRepo: dir.isRepo })}>
          Use this folder
        </button>
      </div>
      <div className="ws-scroll">
        {shown.map((f) => (
          <Row
            key={f.path}
            icon={f.isRepo ? <FolderGit2Icon className="size-4" /> : <FolderIcon className="size-4" />}
            title={f.name}
            sub={f.branch}
            onClick={() => (f.isRepo ? onUse(f) : onOpen(f.path))}
          />
        ))}
        {dir.entries.length === 0 ? <p className="ws-empty">No folders in here.</p> : shown.length === 0 && <p className="ws-empty">No folder here has “{filter}” in its name.</p>}
      </div>
    </>
  );
}

/** What each mode lets the session do, in the fewest words that are still true. */
const MODE_PILL: Record<EngineMode, { text: string; tone: string; why: string }> = {
  plan: { text: "Plan", tone: "calm", why: "Reads and proposes, and asks before it runs a command. Changes nothing." },
  edits: { text: "Manual", tone: "calm", why: "Edits files, and asks before it runs a command." },
  full: { text: "Auto", tone: "warn", why: "Runs commands without asking. Narrow it inside the session." },
};

/** What continuing a conversation does with it, wherever that is offered. */
const SHARED = "Its latest messages are shared with this session: every agent in it can work from them, and everyone in it can read them.";

/** A worktree Friday made for a session or keeps spare: in its own folder under worktrees, not where the repository is. */
const inWorktrees = (p: string) => /[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(p);

/**
 * The folder picker's rows: a repository once, the checkout someone keeps first and its other worktrees under it; any other
 * folder as itself (audit CODE-16 A).
 */
export function byRepo(list: FolderInfo[], plain = false): { f: FolderInfo; more: FolderInfo[] }[] {
  // One repository: the same origin, or a worktree of it, known by its name. Two clones with nothing to tie them stay two.
  const groups: FolderInfo[][] = [];
  // A worktree's folder is "<repo>-<id>" (git.ts addWorktree): it is the repository's.
  const base = (x: FolderInfo) => (inWorktrees(x.path) ? x.name.replace(/-[0-9a-f]{8}$/, "") : x.name);
  const same = (g: FolderInfo[], f: FolderInfo) => g.some((x) => (!!f.remote && x.remote === f.remote) || ((inWorktrees(f.path) || inWorktrees(x.path)) && base(x) === base(f)));
  for (const f of list) {
    const g = f.isRepo && !plain ? groups.find((g) => g[0]!.isRepo && same(g, f)) : undefined;
    if (g) g.push(f);
    else groups.push([f]);
  }
  return groups.map((all) => {
    const f = all.find((x) => !inWorktrees(x.path)) ?? all[0]!;
    return { f, more: all.filter((x) => x !== f) };
  });
}

/** A folder Friday made for a session nobody gave one: ~/Friday/Projects/<what was asked> (local-api.ts projectFolder, CODE-20). */
export const madeByFriday = (p: string): boolean => /[\\/]Friday[\\/]Projects[\\/][^\\/]+[\\/]?$/.test(p);

/**
 * Your repos before the folders Friday made for "New folder" sessions, each kept in its order of use: a day of those filled the
 * list's eight and pushed the real repositories out of it (Arun's e2e pass, 2026-11-04). A plain folder list is left as used.
 */
export function ranked<T extends { f: FolderInfo }>(groups: T[], plain = false): T[] {
  if (plain) return groups;
  return [...groups.filter((g) => !madeByFriday(g.f.path)), ...groups.filter((g) => madeByFriday(g.f.path))];
}

/** A folder's second line: its branch and where it is from home ("fix/export-timeout · ~/code"); a scratch folder, whose it is. */
export function folderLine(f: FolderInfo, plain: boolean, home: string | undefined, inner = false): string {
  // A coding app's scratch folder by its app and day (audit CREW-19); any other in one, whose it is.
  const scratch = scratchSub(f);
  if (scratch) return scratch;
  if (/[\\/]scratch-workspaces[\\/]/.test(f.path)) return /[\\/]Claude[\\/]/.test(f.path) ? "Claude Desktop · this computer" : "this computer";
  const at = (p: string) => shortPath(p, home);
  const parent = f.path.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]+$/, "") || f.path;
  if (plain) return at(f.path);
  if (inner) return at(f.path);
  return f.branch ? `${f.branch} · ${at(parent)}` : at(parent);
}

/** A coding app's scratch folder said by its app and day ("Claude Desktop · Tue 3 Nov"); null for any other folder. */
export function scratchSub(folder: { name: string; path: string }): string | null {
  if (folderName(folder) !== "Scratch folder") return null;
  const app = /[\\/]Claude[\\/]scratch-workspaces[\\/]/.test(folder.path) ? "Claude Desktop" : "Scratch";
  const d = /scratch-(\d{4})-(\d{2})-(\d{2})/.exec(folder.name || folder.path);
  if (!d) return app;
  const day = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]));
  return `${app} · ${day.toLocaleDateString([], { weekday: "short" })} ${day.getDate()} ${day.toLocaleDateString([], { month: "short" })}`;
}

/**
 * A folder by the name a person would give it: a coding app's own scratch folder ("scratch-2026-11-03-c0317b" under Claude's
 * scratch-workspaces) is a "Scratch folder", not its generated name.
 */
export function folderName(folder: { name: string; path: string }): string {
  return /[\\/]scratch-workspaces[\\/]/.test(folder.path) || /^scratch-\d{4}-\d{2}-\d{2}\b/.test(folder.name) ? "Scratch folder" : folder.name;
}

/**
 * A conversation picked up again, as a card in the message box (Arun, 2026-11-04, design A of three: "beautiful see this is what
 * im talking about"). The conversation leads: its tool's mark at rest, its title, that it is being continued, how long it is and
 * when it was last worked on, and (on the dot) what continuing does with it. Under it, one row: the folder, then its branch when
 * it is a repository (the page's controls, `children`) or else where it is, then the other folders it may work in (`extra`).
 */
function ConversationCard({ folder, resume, where, children, extra, onClear }: { folder: FolderInfo; resume: CliSession; where: string; children?: ReactNode; extra?: ReactNode; onClear?: () => void }) {
  const ago = relTime(resume.updatedAt);
  const size = resume.approx ? "a long conversation" : resume.messages ? `${resume.messages} message${resume.messages === 1 ? "" : "s"}` : "";
  return (
    <div className="ccard">
      <div className="ccard-top">
        <PresenceRing state="idle" size={18} square className="ccard-mark">
          <EngineMark tool={resume.tool} size={18} />
        </PresenceRing>
        <div className="ccard-body">
          <div className="ccard-title" title={resume.title}>
            {resume.title}
          </div>
          <div className="ccard-meta">
            <span>Continuing</span>
            {size && <span>{size}</span>}
            <span>{ago === "now" ? "just now" : `${ago} ago`}</span>
            {/* Said before it happens: the conversation's latest messages go into the session, which everyone in it can read. */}
            <span className="ccard-info" tabIndex={0} role="img" aria-label={SHARED} title={SHARED}>
              i
            </span>
          </div>
        </div>
        {onClear && (
          <button type="button" className="ccard-clear" onClick={onClear} aria-label="Remove this conversation and folder" title="Remove this conversation">
            <Icon name="x" size={13} />
          </button>
        )}
      </div>
      <div className="ccard-foot">
        <span className="ccard-folder" title={`${folder.path}\nThe folder stays on ${where}.`}>
          {folder.isRepo ? <FolderGit2Icon className="size-3 shrink-0" /> : <FolderIcon className="size-3 shrink-0" />}
          <span>{folderName(folder)}</span>
        </span>
        <span className="ccard-dot" aria-hidden>
          ·
        </span>
        {children ?? <span className="ccard-where">{where}</span>}
        {extra && <span className="ccard-sep" aria-hidden />}
        {extra}
      </div>
    </div>
  );
}

/**
 * The folder the work happens in, as a card inside the message box, above what is being typed.
 *
 * It is part of the request, like an attached file, so it sits with the request rather than under it: the folder's name and
 * what kind of thing it is, where it lives, that it stays on the machine, and (for a repo) which branch the work lands on.
 * It takes its controls as children, so the page that owns the branch choice owns the choice.
 */
export function FolderCard({ folder, resume, where, children, extra, onClear }: { folder: FolderInfo; resume?: CliSession; /** Which computer, in words: "this computer", or the machine's name. */ where: string; children?: ReactNode; /** With a conversation: the other folders it may work in, at the end of the card's last row (AlsoWorksIn inCard). */ extra?: ReactNode; onClear?: () => void }) {
  if (resume) return <ConversationCard folder={folder} resume={resume} where={where} {...(children ? { children } : {})} {...(extra ? { extra } : {})} {...(onClear ? { onClear } : {})} />;
  return (
    <div className="fcard">
      <div className="fcard-top">
        <span className="fcard-icon" aria-hidden>
          {folder.isRepo ? <FolderGit2Icon className="size-4" /> : <FolderIcon className="size-4" />}
        </span>
        <div className="fcard-body">
          <div className="fcard-head">
            <span className="fcard-name" title={folder.name}>
              {folder.name}
            </span>
          </div>
          {/* Where it is, and that it stays there: the lock says so on hover, and the words say where. */}
          <div className="fcard-path" title={`${folder.path}
The folder stays on this machine.`}>
            <span className="fcard-p">{shortPath(folder.path)}</span>
            <span className="fcard-dot">·</span>
            <LockIcon className="size-3 shrink-0" />
            <span className="fcard-where">on {where}</span>
          </div>
        </div>
        {onClear && (
          <button type="button" className="fcard-clear" onClick={onClear} aria-label="Remove this folder" title="Remove this folder">
            <Icon name="x" size={13} />
          </button>
        )}
      </div>
      {children && <div className="fcard-controls">{children}</div>}
    </div>
  );
}

/**
 * Where this session will run, before it runs.
 *
 * Three facts, and they are not equal: the folder is the one people check,
 * the branch is a decision they sometimes change, and what the session is
 * allowed to do is a thing to be aware of rather than to read. So the folder
 * leads, the branch sits under it, and the permission is a pill rather than
 * the sentence of amber prose it used to be — a whole line of warning under
 * every session is a line nobody reads by the third time.
 */
export function WorkspaceSummary({ folder, resume, mode, children, onClear }: { folder: FolderInfo; resume?: CliSession; mode?: EngineMode; children?: ReactNode; /** Let go of the choice: picked by accident, or changed your mind. */ onClear?: () => void }) {
  const m = mode ? MODE_PILL[mode] : null;
  return (
    <div className="ws-summary">
      {onClear && (
        <button type="button" className="ws-sum-clear" onClick={onClear} aria-label={resume ? "Remove this session and folder" : "Remove this folder"} title={resume ? "Remove this session" : "Remove this folder"}>
          <Icon name="x" size={13} />
        </button>
      )}
      <span className="ws-sum-where">
        {folder.isRepo ? <FolderGit2Icon className="size-4 shrink-0 opacity-70" /> : <FolderIcon className="size-4 shrink-0 opacity-70" />}
        <span className="ws-sum-name">{folder.name}</span>
        <span className="ws-sum-path" title={folder.path}>
          {shortPath(folder.path)}
        </span>
      </span>
      <span className="ws-sum-tags">
        {resume && (
          <span className="ws-chip" title={`${resume.title}\n${SHARED}`}>
            continues “{resume.title.slice(0, 32)}”
          </span>
        )}
        {m && (
          <span className={`ws-mode ${m.tone}`} title={m.why}>
            {m.tone === "warn" && <Icon name="shield" size={11} />}
            {m.text}
          </span>
        )}
      </span>
      {/* The controls get a row of their own rather than sharing a column
          with the path above: sharing meant the branch field was sized by
          how long the folder's name happened to be. */}
      {children && <span className="ws-sum-controls">{children}</span>}
    </div>
  );
}

/**
 * A row of tabs that scrolls sideways when there are more than fit: the wheel moves it while the pointer is over it (a mouse has no
 * sideways wheel), a thin bar shows on hover, the edges fade where more is hidden, and the chosen tab is brought into view.
 */
function ScrollTabs({ className, label, active, children }: { className: string; label: string; active: string; children: ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    const measure = () => setEdges({ left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
    // Not passive, so the page itself doesn't scroll while the row does; a row with nothing hidden lets the wheel through.
    const wheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const before = el.scrollLeft;
      el.scrollLeft += e.deltaY;
      if (el.scrollLeft !== before) e.preventDefault();
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    el.addEventListener("wheel", wheel, { passive: false });
    const sized = new ResizeObserver(measure);
    sized.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      el.removeEventListener("wheel", wheel);
      sized.disconnect();
    };
  }, []);
  useEffect(() => {
    row.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  return (
    <div ref={row} className={`${className} scroll-tabs${edges.left ? " fade-left" : ""}${edges.right ? " fade-right" : ""}`} role="tablist" aria-label={label}>
      {children}
    </div>
  );
}

/**
 * The folders the agent may work in besides its own, as each tool's --add-dir has them (Arun, 2026-10-19: every tool as
 * capable in Friday as on its own): another repository it depends on, a shared library, a docs folder. Offered where the
 * folder is picked. The runner keeps them for the folder, so they are shown again the next time it is picked, and a lane
 * started again keeps them; `value` is null until the person changes them, and then is what the start sends (see startDirs).
 */
/**
 * The other folders an agent may work in, kept by the runner for its folder (see AlsoWorksIn): what they are now, and adding one
 * by its path (checked on the machine) or taking one away. Shared by the conversation card's row and the box's folder menu.
 */
export function useExtraDirs(identity: Identity, folder: string, value: string[] | null, onChange: (dirs: string[]) => void) {
  const [kept, setKept] = useState<string[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    setKept([]);
    setErr("");
    void hostApi<{ folder: FolderInfo }>(identity, `/api/runner/describe?path=${encodeURIComponent(folder)}&dirs=1`).then(
      (r) => live && setKept(r.folder.dirs ?? []),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [folder]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirs = value ?? kept;
  /** True once it is added (or was already there). */
  const add = async (p: string): Promise<boolean> => {
    if (!p.trim()) return false;
    setErr("");
    try {
      const r = await hostApi<{ folder: FolderInfo }>(identity, `/api/runner/describe?path=${encodeURIComponent(p.trim())}`);
      const d = r.folder.path;
      if (d === folder) return (setErr("That's the folder it works in already."), false);
      if (!dirs.includes(d)) onChange([...dirs, d]);
      return true;
    } catch {
      setErr(`There's no folder at ${p.trim()} on this machine.`);
      return false;
    }
  };
  const remove = (d: string) => onChange(dirs.filter((x) => x !== d));
  return { dirs, add, remove, err };
}

export function AlsoWorksIn({ identity, folder, value, onChange, inCard = false }: { identity: Identity; folder: string; value: string[] | null; onChange: (dirs: string[]) => void; /** In a conversation's card, after its folder: no label of its own, and "Add a folder". */ inCard?: boolean }) {
  const desktop = typeof window !== "undefined" ? window.fridayDesktop : undefined;
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState("");
  const extra = useExtraDirs(identity, folder, value, onChange);
  const { dirs, err } = extra;
  const add = async (p: string) => {
    if (await extra.add(p)) (setPath(""), setTyping(false));
  };
  const name = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;
  return (
    <div className={`xdirs${inCard ? " in-card" : ""}`}>
      {!inCard && (
        <span className="xdirs-label" title="Folders the agent may read and change besides its own, as its --add-dir allows">
          Also works in
        </span>
      )}
      {dirs.map((d) => (
        <span key={d} className="xdirs-chip" title={d}>
          <FolderIcon className="size-3 shrink-0" />
          <span className="xdirs-name">{name(d)}</span>
          <button type="button" className="xdirs-x" aria-label={`Stop working in ${name(d)}`} onClick={() => extra.remove(d)}>
            <Icon name="x" size={11} />
          </button>
        </span>
      ))}
      {typing ? (
        <input
          className="ws-branch-input xdirs-input"
          autoFocus
          value={path}
          placeholder="Path to another folder"
          spellCheck={false}
          aria-label="Another folder it may work in"
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void add(path);
            } else if (e.key === "Escape") {
              e.stopPropagation();
              setTyping(false);
              setPath("");
            }
          }}
          onBlur={() => !path.trim() && setTyping(false)}
        />
      ) : (
        dirs.length < 8 && (
          <button
            type="button"
            className="link-btn xdirs-add"
            onClick={async () => {
              // The desktop app's own folder chooser; in a browser the path is typed, as the picker's search takes one.
              if (!desktop) return setTyping(true);
              const p = await desktop.pickFolder();
              if (p) await add(p);
            }}
          >
            {inCard ? (
              <>
                <Icon name="plus" size={12} />
                Add a folder
              </>
            ) : (
              "+ Another folder"
            )}
          </button>
        )
      )}
      {err && <span className="xdirs-err">{err}</span>}
    </div>
  );
}

/**
 * A `?resume=<tool>:<id>&cwd=<path>` link (resume-link.ts): once the machine has said what it is, the link's folder is picked
 * with that conversation to continue, when the machine lists it. Asked once per link. What it returns is the one line to show
 * when it can't be done: no machine linked, the folder isn't there, or the conversation isn't in the machine's list (the folder
 * is still picked then).
 */
export function useResumeLink(identity: Identity, link: ResumeLink | undefined, machine: MachineMode, where: string, onPicked: (p: Picked) => void): string {
  const [note, setNote] = useState("");
  const asked = useRef("");
  const picked = useRef(onPicked);
  picked.current = onPicked;
  useEffect(() => {
    if (!link || machine === "checking") return;
    if (machine === "none") return void setNote(resumeProblem(link, "no-machine"));
    const key = `${link.tool}:${link.id}:${link.cwd}`;
    if (asked.current === key) return;
    asked.current = key;
    setNote("");
    let live = true;
    void (async () => {
      const list = await hostApi<CliSessionList>(identity, `/api/runner/sessions?tool=${link.tool}`).catch(() => null);
      const session = list?.sessions.find((s) => s.tool === link.tool && s.id === link.id);
      // Where the conversation ran is where it has to be resumed; the link's folder when the machine doesn't list it.
      const r = await hostApi<{ folder: FolderInfo }>(identity, `/api/runner/describe?path=${encodeURIComponent(session?.cwd ?? link.cwd)}`).catch(() => null);
      if (!live) return;
      if (!r) return setNote(resumeProblem(link, "no-folder", where));
      picked.current({ folder: r.folder, ...(session ? { resume: session } : {}) });
      if (!session) setNote(resumeProblem(link, "not-found", where));
    })();
    return () => {
      live = false;
      asked.current = "";
    };
  }, [identity, link, machine, where]);
  return link ? note : "";
}
