import { createContext, useSyncExternalStore, type ReactNode } from "react";
import type { RecentSession } from "../storage.js";
import { editorOf, type Editor } from "./vscode-util.js";
import { sameFolder } from "./code-chats.js";

/**
 * Agents or Code: which of Friday's two views fills the window (Arun, 2026-11-19: "make it a toggle for switching back and forth
 * with our current ADE to the IDE"). Agents is the app as it always was; Code is the built-in IDE (src/client/ide/IdeView.tsx).
 *
 * Kept tiny on purpose: the window bar and App read it, so it is part of the first load. Everything of the IDE itself is in the
 * lazy chunk behind IdeView.
 */
export type FridayMode = "agents" | "code";

const KEY = "friday.mode";
const listeners = new Set<() => void>();
let current: FridayMode | null = null;

function read(): FridayMode {
  if (current) return current;
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    // Private window or blocked storage: it just starts on Agents each time.
  }
  return (current = saved === "code" ? "code" : "agents");
}

export const getMode = (): FridayMode => read();

export function setMode(next: FridayMode): void {
  if (read() === next) return;
  current = next;
  // Review changes was asked for Code; leaving Code withdraws it, so it can't pop open some other time.
  if (next === "agents") reviewWanted = null;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // A preference: losing it costs one click.
  }
  listeners.forEach((l) => l());
}

export const toggleMode = (): void => setMode(read() === "code" ? "agents" : "code");

/**
 * ⌘E, and the keys inside the IDE that mean it: Agents or Code, keeping your place (Arun, 2026-11-19: "ensure code and agent
 * platform can be interconnected and streamlined for easy passing of work"). App hears it (friday:swap-mode) and knows the session
 * and the chat: from a session in Agents it opens that session in Code, from a linked chat in Code it goes back to that session.
 * Without App to hear it (a test page), it is the plain toggle.
 */
export function swapMode(): void {
  const ev = new CustomEvent("friday:swap-mode", { cancelable: true });
  window.dispatchEvent(ev);
  if (!ev.defaultPrevented) toggleMode();
}

/**
 * Review changes in the IDE, asked for by "Open in Code" on a session that has some: VsCodeView does it once the IDE has drawn on
 * that folder. It carries the folder and a time, so it is dropped when another folder shows, or when it is old (the IDE never
 * started), and it is withdrawn when Code is left.
 */
let reviewWanted: { root: string; at: number } | null = null;
const REVIEW_FOR_MS = 45_000;
export function wantReview(root: string): void {
  reviewWanted = { root, at: Date.now() };
  window.dispatchEvent(new Event("friday:code-review"));
}
export const takeReviewWanted = (root: string): boolean => {
  const w = reviewWanted;
  if (!w) return false;
  if (Date.now() - w.at > REVIEW_FOR_MS) {
    reviewWanted = null;
    return false;
  }
  if (!sameFolder(w.root, root)) return false;
  reviewWanted = null;
  return true;
};

const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

/** The current mode and a way to change it, shared by every component that asks (and kept between runs). */
export function useMode(): [FridayMode, (m: FridayMode) => void] {
  return [useSyncExternalStore(subscribe, read, () => "agents" as FridayMode), setMode];
}

/**
 * Which editor Code shows: real VS Code (an optional download, ide/VsCodeView.tsx) or Friday's own (ide/IdeView.tsx). VS Code is
 * the default where it can run; where it can't, or is not installed and the person says so, Friday's own fills in. Kept between
 * runs. Opening a file from elsewhere (openInCode) reaches either: VsCodeView and IdeView both listen for "friday:ide-open"
 * and take the pending request, and VsCodeView hands it to the runner's vscode.open.
 */
const EDITOR_KEY = "friday.ide.editor";
const editorListeners = new Set<() => void>();
let editorNow: Editor | undefined;
function readEditor(): Editor {
  if (editorNow) return editorNow;
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(EDITOR_KEY);
  } catch {
    // Blocked storage: VS Code each run.
  }
  return (editorNow = editorOf(saved));
}
export const getEditor = (): Editor => readEditor();
export function setEditor(next: Editor): void {
  if (readEditor() === next) return;
  editorNow = next;
  try {
    localStorage.setItem(EDITOR_KEY, next);
  } catch {
    // A preference: losing it costs one click.
  }
  editorListeners.forEach((l) => l());
}
/** The editor Code shows and a way to change it, shared by every component that asks. */
export function useEditorPref(): [Editor, (e: Editor) => void] {
  return [useSyncExternalStore((l) => (editorListeners.add(l), () => void editorListeners.delete(l)), readEditor, () => "vscode" as Editor), setEditor];
}

/**
 * Whether real VS Code is what Code is showing right now (VsCodeView sets it while its frame is up). The window bar reads it:
 * its sidebar, quick-open and bottom-panel buttons drive Friday's own editor and do nothing to VS Code's frame, so they are
 * left off while it shows. Not stored.
 */
let vscodeShowing = false;
const showingListeners = new Set<() => void>();
export function setVscodeShowing(on: boolean): void {
  if (vscodeShowing === on) return;
  vscodeShowing = on;
  showingListeners.forEach((l) => l());
}
export const useVscodeShowing = (): boolean => useSyncExternalStore((l) => (showingListeners.add(l), () => void showingListeners.delete(l)), () => vscodeShowing, () => false);

/**
 * What the shell part (IdeView) listens for: `window` event "friday:ide-open" with detail `{ path: string; line?: number }`, a
 * file to open in the editor. `path` is relative to the IDE's root when it can be told, else absolute: IdeView resolves it.
 * Sent after the switch, so IdeView may not be mounted yet: openInCode keeps the last request in `pendingOpen`, which IdeView
 * takes with takePendingOpen() when it mounts, and an event reaches it when it was already there (cancelable: IdeView calls preventDefault() once it has opened the file).
 */
export interface IdeOpenDetail {
  path: string;
  line?: number;
  /** Opened from Friday's search (CodeSearch.tsx): the editor takes the keyboard, and `side` opens it in a column beside. */
  focus?: boolean;
  side?: boolean;
}
let pending: IdeOpenDetail | null = null;
export const takePendingOpen = (): IdeOpenDetail | null => {
  const p = pending;
  pending = null;
  return p;
};

/**
 * The pages that can honour "Open in the IDE" for a file mention (Arun, 2026-11-20: "Every file mention opens in the IDE"): a session
 * that has a folder on this computer, a repo's Deep Dive. A mention offers the IDE only while one of them is showing, and none is
 * there for a Work session (its files are documents) or a page with no folder.
 */
const ideTakers = new Set<() => boolean>();
export const registerIdeTaker = (can: () => boolean): (() => void) => (ideTakers.add(can), () => void ideTakers.delete(can));
export const ideCanOpen = (): boolean => [...ideTakers].some((can) => can());
/** The end of a file button's tooltip that tells the gesture, where the IDE is on offer (the cards have no menu of their own). */
export const ideHint = (): string => (getMode() === "agents" && ideCanOpen() ? " · Shift-click for the IDE" : "");

/** Whether a path lies inside a folder: slashes either way, case ignored only on a drive letter or a network share. */
export function isUnder(file: string, root: string): boolean {
  const norm = (p: string) => {
    const r = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return /^[a-zA-Z]:/.test(r) || p.startsWith("\\\\") ? r.toLowerCase() : r;
  };
  const f = norm(file);
  const r = norm(root);
  return !!r && f.startsWith(`${r}/`);
}

/** Switch to Code, with a file open there when one is named. */
export function openInCode(path?: string, line?: number, opts: { review?: boolean; /** A folder that is no session's (a repo's Deep Dive): Code opens on it as it is. */ folder?: string; /** The folder the file was found in (a lane's own): Code is on it when it isn't on one holding the file. */ dir?: string } = {}): void {
  // A session's file: Code opens that session's folder and shows the session as a linked tab (App's friday:code-session-root, the
  // one place it takes a session's), before the switch so it knows the mode was Agents.
  if (opts.folder) setIdeRoot(opts.folder);
  else if (path) window.dispatchEvent(new CustomEvent("friday:code-session-root", { detail: { review: !!opts.review, ...(opts.dir ? { folder: opts.dir } : {}) } }));
  // A session App can't place (not in its list), or a teammate's or race lane's own folder: the file would open outside the
  // workspace, or on the last session's folder. The folder it was found in is where Code goes then.
  if (path && opts.dir) {
    const here = getIdeRoot();
    if (!here || !isUnder(path, here)) setIdeRoot(opts.dir);
  }
  setMode("code");
  if (!path) return;
  const detail: IdeOpenDetail = { path, ...(line ? { line } : {}) };
  pending = detail;
  // After the switch has drawn: when IdeView was already there the event opens it and clears the wait.
  setTimeout(() => {
    if (pending !== detail) return;
    const ev = new CustomEvent("friday:ide-open", { detail, cancelable: true });
    window.dispatchEvent(ev);
    // Taken by an IdeView that was already there (it calls preventDefault): nothing left to hand a later mount.
    if (ev.defaultPrevented) pending = null;
  }, 0);
}

/**
 * A session's folder on this computer: the folder its agents actually edit, not a project folder Friday made for it. A main lane
 * working in a worktree edits the worktree (`cwd`), not the repo it was copied from (`path`): looking at the repo would show none
 * of the agent's changes.
 */
export function folderOf(r: Pick<RecentSession, "repos"> | undefined): string | null {
  const repos = r?.repos?.filter((x) => x.path) ?? [];
  const use = repos.find((x) => !x.made) ?? repos[0];
  return (use?.worktree && use.cwd ? use.cwd : use?.path) ?? null;
}

/** Every folder a session works in (a multi-repo session has several), in the order folderOf would pick them. */
export function foldersOf(r: Pick<RecentSession, "repos"> | undefined): string[] {
  const repos = (r?.repos ?? []).filter((x) => x.path);
  const ordered = [...repos.filter((x) => !x.made), ...repos.filter((x) => x.made)];
  return [...new Set(ordered.map((x) => (x.worktree && x.cwd ? x.cwd : x.path!)))];
}

/**
 * The folder Code has open: only one the person chose (Open Folder, a recent, "Open in Code" on a session's changes). Code opens
 * with none, on its start screen, and doesn't follow the agents' sessions (Arun, 2026-11-19: "make sure the ide opens blank and not
 * like agent work, like the user needs to select the stuff to get started"). Kept through a reload, and, since wave 4, to the next
 * launch: the last folder the person chose is where they come back to (Arun, 2026-11-19: "quit Friday mid-work and come back
 * exactly where you were"). This window's own choice (sessionStorage) wins over the last one kept (localStorage), which is what a
 * new window or a launch starts from; closing the folder forgets both.
 */
const ROOT_KEY = "friday.ide.root";
const LAST_ROOT_KEY = "friday.ide.last";
const rootListeners = new Set<() => void>();
let rootNow: string | null | undefined;
/** Whether the folder came from the last launch and not from a choice made in this window: App checks it still exists. */
let rootRestored = false;
/** A restored folder is shown as none until restore.ts has checked it is still there (or two seconds have passed): the IDE isn't started on a missing one. */
let rootHeld = false;
export function releaseRestoredRoot(): void {
  if (!rootHeld) return;
  rootHeld = false;
  rootListeners.forEach((l) => l());
}
function readRoot(): string | null {
  if (rootNow !== undefined) return rootNow;
  try {
    localStorage.removeItem(ROOT_KEY);
    rootNow = sessionStorage.getItem(ROOT_KEY) || null;
    if (rootNow) localStorage.setItem(LAST_ROOT_KEY, rootNow);
    else {
      rootNow = localStorage.getItem(LAST_ROOT_KEY) || null;
      rootRestored = !!rootNow;
      if (rootRestored) {
        rootHeld = true;
        setTimeout(releaseRestoredRoot, 2000);
      }
    }
  } catch {
    rootNow = null;
  }
  return rootNow;
}
/** The folder Code was left on, if that is what it opened on this time (not one chosen since). */
export const restoredIdeRoot = (): string | null => (readRoot() && rootRestored ? rootNow! : null);
export const getIdeRoot = (): string | null => (readRoot() && rootHeld ? null : readRoot());
export function setIdeRoot(next: string | null): void {
  if (readRoot() === next) return;
  rootNow = next;
  rootRestored = false;
  rootHeld = false;
  try {
    if (next) (sessionStorage.setItem(ROOT_KEY, next), localStorage.setItem(LAST_ROOT_KEY, next));
    else (sessionStorage.removeItem(ROOT_KEY), localStorage.removeItem(LAST_ROOT_KEY));
  } catch {
    // A preference: losing it costs one click.
  }
  rootListeners.forEach((l) => l());
}
export const useIdeRoot = (): string | null =>
  useSyncExternalStore((l) => (rootListeners.add(l), () => void rootListeners.delete(l)), () => (readRoot() && rootHeld ? null : readRoot()), () => null);

/**
 * Press a Code shortcut for the window bar's buttons. Code's own key handler (IdeView) is the one place that knows what each
 * chord does to its layout, so the bar sends it the chord instead of keeping a second copy of the layout.
 */
export function ideKey(code: string, opts: { alt?: boolean; shift?: boolean } = {}): void {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  window.dispatchEvent(new KeyboardEvent("keydown", { code, key: code.replace(/^Key/, "").toLowerCase(), metaKey: mac, ctrlKey: !mac, altKey: !!opts.alt, shiftKey: !!opts.shift, bubbles: true, cancelable: true }));
}

/** Which parts of Code are showing, read from the page (Code keeps its layout to itself), for the bar's buttons to be pressed or not. */
export function ideParts(): { side: boolean; panel: boolean; chat: boolean } {
  const q = (s: string) => document.querySelector(s);
  return { side: !!q(".ix-side"), panel: !!q(".ix-bottom:not([hidden])"), chat: !!q(".ix-right:not([hidden])") };
}

/**
 * A chat started with no one looking (⌘K, Arun, 2026-11-19: "No chat needed for small edits"): the composer is mounted out of sight,
 * takes `text` as its task, and starts it when the folder and the coding tool are ready, with a draft of its own and without making
 * the new chat the one shown. `done` says when it started or why it could not.
 */
export interface QuietStart {
  id: string;
  text: string;
  done: (failed?: string) => void;
}

/**
 * How Code's agent column reaches what App has (ide/AgentPanel.tsx): a Code chat's session screen (SessionView needs App's agents,
 * plan and connections, which the lazy IDE chunk can't see), the box that starts a new one in a folder, and the coding tool last
 * seen at work in a session. Null outside App.
 */
export interface IdeChat {
  identity: import("../storage.js").Identity;
  chat: (sid: string, invite: string) => ReactNode;
  start: (folder: string, quiet?: QuietStart) => ReactNode;
  agentOf: (sid: string) => string;
}
export const IdeChatContext = createContext<IdeChat | null>(null);
