import { CloudDownloadIcon, CornerLeftUpIcon, FolderGit2Icon, FolderIcon, FolderOpenIcon, FolderSearchIcon, HistoryIcon, LockIcon, SearchIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { CliSession, CliSessionList } from "../runner/imports.js";
import { parseRepo } from "../runner/repo.js";
import type { FolderInfo, GithubRepo } from "../runner/workspace.js";
import { ENGINE_NAMES, ENGINE_TOOLS, type EngineMode, type EngineTool } from "../types.js";
import { EngineMark } from "./BrandMarks.js";
import { Icon } from "./icons.js";
import { api } from "./api.js";
import { GitHubConnect } from "./GitHubConnect.js";
import { hostApi, installedOn, type MachineMode } from "./local.js";
import { resumeProblem, type ResumeLink } from "./resume-link.js";
import { splitTools } from "./engines.js";
import { loadRecentFolders, saveRecentFolder, type Identity } from "./storage.js";
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
    void cached("folders", () => hostApi<{ recent: FolderInfo[] }>(identity, "/api/runner/folders")).then(
      async (r) => {
        const mine = await Promise.all(
          loadRecentFolders().map((p) => hostApi<{ folder: FolderInfo }>(identity, `/api/runner/describe?path=${encodeURIComponent(p)}`).then((x) => x.folder, () => null)),
        );
        const seen = new Set<string>();
        set({ recent: [...mine.filter((f): f is FolderInfo => !!f), ...r.recent].filter((f) => !seen.has(f.path) && !!seen.add(f.path)) });
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

  const label = value ? `${value.name}${value.branch ? ` · ${value.branch}` : ""}` : "Choose code";
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
  const desktop = typeof window !== "undefined" ? window.fridayDesktop : undefined;

  // Above the trigger, like the composer's other cards (Arun, 2026-10-20): with Home's box now near the top, "below where
  // there is room" had it dropping down over the page. Below only when there is no room above.
  const place = placeCard(trigger?.getBoundingClientRect(), 460, { want: 520, min: 240, prefer });

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
    if (!plain || !looksLikePath) return void setTyped(null);
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
  }, [plain, looksLikePath, query, identity]);
  const typedRows = typed && typed.q === query ? typed.entries : [];

  // Enter picks the obvious thing: clone what was pasted, use a typed path, or take the first row.
  const enter = () => {
    if (repo && !recent.length) return void clone(query);
    if (looksLikePath) return void byPath(query);
    if (recent[0]) return choose(recent[0]);
    if (sessions[0]) return void byPath(sessions[0].cwd, sessions[0]);
    if (repo) return void clone(query);
  };

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

      {only !== "repos" && (
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
      {only !== "repos" && data.sessions !== null && sessions.length === 0 && (
        // What the machine said about it, which knows the difference between none, none it can read, and none that can be continued.
        <p className="ws-empty">{query ? `No ${ENGINE_NAMES[view]} session matches “${query}”.` : (data.sessions.notes[view] ?? `No ${ENGINE_NAMES[view]} sessions on this machine yet.`)}</p>
      )}
      {only !== "repos" && sessions.length > 0 && (
        <Section label={`Continue a ${ENGINE_NAMES[view]} session`}>
          {sessions.slice(0, 6).map((s) => (
            <Row
              key={`${s.tool}-${s.id}`}
              icon={busy === s.cwd ? <span className="spinner" /> : <HistoryIcon className="size-4" />}
              title={s.title}
              // A transcript too long to read whole has no count worth showing: the part that was read says nothing about the rest.
              // No count is known for a session the tool itself listed (over ACP): it is left out rather than said as none.
              sub={[s.cwd.split(/[\\/]/).pop(), s.approx ? "long session" : s.messages ? `${s.messages} message${s.messages === 1 ? "" : "s"}` : "", relTime(s.updatedAt)].filter(Boolean).join(" · ")}
              active={resume?.id === s.id}
              onClick={() => void byPath(s.cwd, s)}
            />
          ))}
        </Section>
      )}

      {only !== "sessions" && !(plain && looksLikePath && recent.length === 0) && (
        <>
      <Section label={plain ? "Recent folders" : "Your repos"} loading={data.recent === null}>
        {recent.slice(0, 8).map((f) => (
          <Row
            key={f.path}
            icon={busy === f.path ? <span className="spinner" /> : f.isRepo && !plain ? <FolderGit2Icon className="size-4" /> : <FolderIcon className="size-4" />}
            title={f.name}
            sub={f.branch && !plain ? `${f.branch} · ${shortPath(f.path)}` : shortPath(f.path)}
            onClick={() => choose(f)}
          />
        ))}
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

  return createPortal(
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
  full: { text: "Auto", tone: "warn", why: "Runs commands without asking. Anyone driving this session can. Narrow it inside the session." },
};

/** What continuing a conversation does with it, wherever that is offered. */
const SHARED = "Its latest messages are shared with this session: every agent in it can work from them, and everyone in it can read them.";

/**
 * The folder the work happens in, as a card inside the message box, above what is being typed.
 *
 * It is part of the request, like an attached file, so it sits with the request rather than under it: the folder's name and
 * what kind of thing it is, where it lives, that it stays on the machine, and (for a repo) which branch the work lands on.
 * It takes its controls as children, so the page that owns the branch choice owns the choice.
 */
export function FolderCard({ folder, resume, where, children, onClear }: { folder: FolderInfo; resume?: CliSession; /** Which computer, in words: "this computer", or the machine's name. */ where: string; children?: ReactNode; onClear?: () => void }) {
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
          {/* Said before it happens: the conversation's latest messages go into the session, which everyone in it can read. */}
          {resume && (
            <div className="fcard-resume" title={`${resume.title}\n${SHARED}`}>
              <HistoryIcon className="size-3 shrink-0" />
              <span>Continues “{resume.title}” · its latest messages are shared with this session</span>
            </div>
          )}
        </div>
        {onClear && (
          <button type="button" className="fcard-clear" onClick={onClear} aria-label={resume ? "Remove this session and folder" : "Remove this folder"} title={resume ? "Remove this session" : "Remove this folder"}>
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
export function AlsoWorksIn({ identity, folder, value, onChange }: { identity: Identity; folder: string; value: string[] | null; onChange: (dirs: string[]) => void }) {
  const desktop = typeof window !== "undefined" ? window.fridayDesktop : undefined;
  const [kept, setKept] = useState<string[]>([]);
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState("");
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
  const add = async (p: string) => {
    if (!p.trim()) return;
    setErr("");
    try {
      const r = await hostApi<{ folder: FolderInfo }>(identity, `/api/runner/describe?path=${encodeURIComponent(p.trim())}`);
      const d = r.folder.path;
      if (d === folder) return setErr("That's the folder it works in already.");
      if (!dirs.includes(d)) onChange([...dirs, d]);
      setPath("");
      setTyping(false);
    } catch {
      setErr(`There's no folder at ${p.trim()} on this machine.`);
    }
  };
  const name = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;
  return (
    <div className="xdirs">
      <span className="xdirs-label" title="Folders the agent may read and change besides its own, as its --add-dir allows">
        Also works in
      </span>
      {dirs.map((d) => (
        <span key={d} className="xdirs-chip" title={d}>
          <FolderIcon className="size-3 shrink-0" />
          <span className="xdirs-name">{name(d)}</span>
          <button type="button" className="xdirs-x" aria-label={`Stop working in ${name(d)}`} onClick={() => onChange(dirs.filter((x) => x !== d))}>
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
            + Another folder
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
