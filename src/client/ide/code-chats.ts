import { useSyncExternalStore } from "react";

/**
 * Code's own agent chats, apart from Agents (Arun, 2026-11-19: "the agent chat thing, we will keep all of the session stuff and
 * agents from the agent platform seperate"). A chat started in Code's column is a session like any other underneath (the same
 * agent, steps, approvals and changes), but it is listed here, by folder, and never in Agents' sidebar, its Needs you or its
 * search; Agents' sessions are never listed in Code.
 *
 * Kept in this browser (localStorage), as Agents' own list is. App leaves these out of its list wherever sessions arrive (opening
 * one, the server's "mine" list), so one can't drift across.
 */
export interface CodeChat {
  sid: string;
  invite: string;
  /** The folder it works in, exactly as Code had it open. */
  folder: string;
  title: string;
  /** Started, then last opened: the history is newest first. */
  at: number;
  /** The coding tool it was started with, for its mark before the session has said. */
  tool?: string;
  /**
   * An Agents session opened in Code (Arun, 2026-11-19: "ensure code and agent platform can be interconnected and streamlined for
   * easy passing of work"): shown here as a tab marked "from Agents", but still Agents' own, so isCodeChat ignores it and App keeps
   * it in Agents' list. "Move to Code" (moveToCode) makes it a normal Code chat.
   */
  linked?: boolean;
  /** Started by Run later (ide/later.ts) while nobody was at the box: marked "Ran overnight" (the time it started) in its tab and the history. */
  overnight?: number;
  /** What it is called: "Ran overnight" when it began in the night, else "Ran later". */
  ran?: string;
}

const KEY = "friday.code.chats";
/** Which chat each folder shows: a sid, or "new" for the empty box. */
const CURRENT = "friday.code.current";
/** Every session ever started as a Code chat, kept when one leaves the history (removed, or past MAX): Agents never takes them in. */
const SIDS = "friday.code.sids";
/** The chats open as tabs in each folder's column, in order (Arun, 2026-11-19: "make it tabbed chats instead of just one"). */
const TABS = "friday.code.tabs";
/** A history this long is plenty; the oldest go. */
const MAX = 200;

const listeners = new Set<() => void>();
let chats: CodeChat[] | null = null;
let current: Record<string, string> | null = null;
let sids: Set<string> | null = null;
let tabs: Record<string, string[]> | null = null;
/** Bumped on every change: what the hooks hand out is rebuilt only then, so React sees the same snapshot between changes. */
let version = 0;
function loadTabs(): Record<string, string[]> {
  if (!tabs) {
    const raw = read<Record<string, unknown>>(TABS, {});
    tabs = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []]));
  }
  return tabs;
}
function loadSids(): Set<string> {
  if (!sids) sids = new Set([...read<string[]>(SIDS, []).filter((s) => typeof s === "string"), ...loadCodeChats().filter((c) => !c.linked).map((c) => c.sid)]);
  return sids;
}

function read<T>(key: string, fallback: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "null") as T | null;
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // Storage blocked: the chats last until the window closes.
  }
}

const valid = (c: Partial<CodeChat> | null | undefined): c is CodeChat =>
  !!c && typeof c.sid === "string" && !!c.sid && typeof c.invite === "string" && typeof c.folder === "string" && typeof c.title === "string" && typeof c.at === "number";

export function loadCodeChats(): CodeChat[] {
  if (!chats) chats = read<unknown[]>(KEY, []).filter((c): c is CodeChat => valid(c as CodeChat));
  return chats;
}
function loadCurrent(): Record<string, string> {
  if (!current) current = read<Record<string, string>>(CURRENT, {});
  return current;
}
function changed(nextChats?: CodeChat[], nextCurrent?: Record<string, string>, nextTabs?: Record<string, string[]>) {
  version++;
  if (nextTabs) {
    tabs = nextTabs;
    write(TABS, nextTabs);
  }
  if (nextChats) {
    chats = nextChats;
    write(KEY, nextChats);
  }
  if (nextCurrent) {
    current = nextCurrent;
    write(CURRENT, nextCurrent);
  }
  listeners.forEach((l) => l());
}

/** Whether a session is one of Code's chats: App keeps these out of Agents. */
export const isCodeChat = (sid: string): boolean => loadSids().has(sid);

/** A chat just started in Code: first in the history, and what its folder shows (unless `background`). */
export function addCodeChat(c: CodeChat, opts?: { background?: boolean }): void {
  const known = loadSids();
  if (!known.has(c.sid)) {
    known.add(c.sid);
    write(SIDS, [...known].slice(-5000));
  }
  const rest = loadCodeChats().filter((x) => x.sid !== c.sid);
  // In the background (a ⌘K edit): its tab and its place in the history, but the folder keeps showing what it was showing.
  changed([c, ...rest].slice(0, MAX), opts?.background ? undefined : { ...loadCurrent(), [key(c.folder)]: c.sid }, withTab(c.folder, c.sid));
}

/**
 * An Agents session opened in Code: a linked tab, shown in its folder's column. One already there (linked or not) is only shown.
 * It is not added to the sessions Agents drops (SIDS), so it stays in Agents' list.
 */
export function linkCodeChat(c: { sid: string; invite: string; folder: string; title: string; tool?: string }): void {
  const old = loadCodeChats().find((x) => x.sid === c.sid);
  if (old?.linked && !sameFolder(old.folder, c.folder)) {
    // The session's folder changed since it was linked (a worktree made later): the link follows it, with its tab, so the column
    // Code opens on has it.
    const oldKey = key(old.folder);
    const tabsNow = Object.fromEntries(Object.entries(loadTabs()).map(([f, l]) => [f, f === oldKey ? l.filter((s) => s !== old.sid) : l]));
    const moved = loadCodeChats().map((x) => (x.sid === old.sid ? { ...x, folder: c.folder, at: Date.now() } : x)).sort((a, b) => b.at - a.at);
    const k = key(c.folder);
    const list = tabsNow[k] ?? [];
    const cur = { ...loadCurrent(), [k]: old.sid };
    if (loadCurrent()[oldKey] === old.sid) delete cur[oldKey];
    return changed(moved, cur, list.includes(old.sid) ? tabsNow : { ...tabsNow, [k]: [...list, old.sid].slice(-12) });
  }
  if (old) return showCodeChat(old.folder, old.sid);
  const chat: CodeChat = { ...c, at: Date.now(), linked: true };
  changed([chat, ...loadCodeChats()].slice(0, MAX), { ...loadCurrent(), [key(c.folder)]: c.sid }, withTab(c.folder, c.sid));
}

/** The chat a folder shows, when it is an Agents session linked into Code (not one of Code's own). */
export const linkedChatFor = (folder: string): CodeChat | null => {
  const c = codeChatFor(folder);
  return c?.linked ? c : null;
};

/**
 * "Move to Code": a linked chat becomes one of Code's own, and leaves Agents' list (App hears "friday:code-moved" and drops it).
 */
export function moveToCode(sid: string): void {
  const list = loadCodeChats();
  const i = list.findIndex((c) => c.sid === sid);
  if (i < 0 || !list[i]!.linked) return;
  const known = loadSids();
  known.add(sid);
  write(SIDS, [...known].slice(-5000));
  const copy = list.slice();
  const { linked: _linked, ...rest } = copy[i]!;
  copy[i] = rest;
  changed(copy);
  window.dispatchEvent(new CustomEvent("friday:code-moved", { detail: { sid } }));
}

/**
 * "Undo" of Move to Code: the chat is Agents' again, linked in Code as it was (App hears "friday:code-handed-back" and puts the
 * session back in Agents' list).
 */
export function handBack(sid: string): void {
  const list = loadCodeChats();
  const i = list.findIndex((c) => c.sid === sid);
  if (i < 0 || list[i]!.linked) return;
  const known = loadSids();
  known.delete(sid);
  write(SIDS, [...known].slice(-5000));
  const copy = list.slice();
  copy[i] = { ...copy[i]!, linked: true };
  changed(copy);
  window.dispatchEvent(new CustomEvent("friday:code-handed-back", { detail: { chat: copy[i] } }));
}

/** The session left Agents' list (removed, deleted, forgotten on another device): its link in Code goes too. Code's own are left alone. */
export function dropLinkedChat(sid: string): void {
  if (loadCodeChats().some((c) => c.sid === sid && c.linked)) removeCodeChat(sid);
}

/** The folder's tabs with this chat open (at the end), unless it already is. */
function withTab(folder: string, sid: string): Record<string, string[]> {
  const all = loadTabs();
  const k = key(folder);
  const list = all[k] ?? [];
  return list.includes(sid) ? all : { ...all, [k]: [...list, sid].slice(-12) };
}

/** A tab closed: the chat stays in the history. The one shown goes to the next tab along, or to a new chat when it was the last. */
export function closeCodeTab(folder: string, sid: string): void {
  const all = loadTabs();
  const k = key(folder);
  const list = all[k] ?? [];
  const i = list.indexOf(sid);
  const next = list.filter((s) => s !== sid);
  const cur = { ...loadCurrent() };
  if (cur[k] === sid || (cur[k] === undefined && i >= 0)) cur[k] = next[Math.min(i, next.length - 1)] ?? "new";
  // A linked chat is only an Agents session shown here: closing its tab ends the link, so links don't pile up in Code's history.
  const linkedOne = loadCodeChats().some((c) => c.sid === sid && c.linked);
  changed(linkedOne ? loadCodeChats().filter((c) => c.sid !== sid) : undefined, cur, { ...all, [k]: next });
}

/** What a session says about itself as it is watched (its title): kept on the chat. */
export function updateCodeChat(sid: string, patch: Partial<Pick<CodeChat, "title" | "tool">>): void {
  const list = loadCodeChats();
  const i = list.findIndex((c) => c.sid === sid);
  if (i < 0) return;
  const old = list[i]!;
  const next = { ...old, ...(patch.title ? { title: patch.title } : {}), ...(patch.tool ? { tool: patch.tool } : {}) };
  if (next.title === old.title && next.tool === old.tool) return;
  const copy = list.slice();
  copy[i] = next;
  changed(copy);
}

/** Taken off the history (the session itself is left alone). The folder goes back to a new chat if it was showing it. */
export function removeCodeChat(sid: string): void {
  const cur = { ...loadCurrent() };
  const all = loadTabs();
  const nextTabs = Object.fromEntries(Object.entries(all).map(([f, l]) => [f, l.filter((s) => s !== sid)]));
  for (const [f, s] of Object.entries(cur)) if (s === sid) cur[f] = nextTabs[f]?.at(-1) ?? "new";
  changed(loadCodeChats().filter((c) => c.sid !== sid), cur, nextTabs);
}

/**
 * A chat leaving Code for Agents ("Send to Agents"): off the history, its tab, and the never-trimmed SIDS, so Agents' list takes
 * it in (App's remember() and reloadMine skip only what isCodeChat knows). Returns the chat as it was.
 */
export function unclaimCodeChat(sid: string): CodeChat | null {
  const old = loadCodeChats().find((c) => c.sid === sid) ?? null;
  const known = loadSids();
  if (known.delete(sid)) write(SIDS, [...known].slice(-5000));
  removeCodeChat(sid);
  return old;
}

/** Show this chat in its folder (from the history), or a new one ("new"). */
export function showCodeChat(folder: string, sid: string | "new"): void {
  const list = loadCodeChats();
  const next = sid === "new" ? list : list.map((c) => (c.sid === sid ? { ...c, at: Date.now() } : c)).sort((a, b) => b.at - a.at);
  changed(next, { ...loadCurrent(), [key(folder)]: sid }, sid === "new" ? undefined : withTab(folder, sid));
  // Someone chose what the column shows: a "Moved to Agents" panel over it steps aside (ide/AgentPanel.tsx).
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("friday:code-shown", { detail: { folder } }));
}

/**
 * The chat a folder shows: the one picked there, else its newest, else none (the empty box). A chat taken off the history is
 * never shown.
 */
export function codeChatFor(folder: string): CodeChat | null {
  if (!folder) return null;
  const list = loadCodeChats();
  const picked = loadCurrent()[key(folder)];
  if (picked === "new") return null;
  const open = loadTabs()[key(folder)] ?? [];
  return list.find((c) => c.sid === picked) ?? list.find((c) => c.sid === open.at(-1)) ?? list.find((c) => key(c.folder) === key(folder)) ?? null;
}

/** Folders compared as Code's are: one slash style, no trailing slash, any case on Windows drives. */
function key(folder: string): string {
  const f = folder.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(f) ? f.toLowerCase() : f;
}
export const sameFolder = (a: string, b: string): boolean => key(a) === key(b);

const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
/** The chats, kept current wherever they change. */
/** Every session Code counts as its own, for the server (app.ts /api/sessions/code-chats), and a call on each change. */
export const codeChatSids = (): string[] => [...loadSids()];
export const onCodeChatsChange = (l: () => void): (() => void) => subscribe(l);

export const useCodeChats = (): CodeChat[] => useSyncExternalStore(subscribe, loadCodeChats, () => []);
/** Re-reads what a folder shows when anything changes. */
export const useCodeChatFor = (folder: string): CodeChat | null =>
  useSyncExternalStore(subscribe, () => codeChatFor(folder), () => null);

/** The folder's open tabs, as chats, in order; a chat it shows that isn't open yet is put at the end. */
const tabMemo = new Map<string, { v: number; list: CodeChat[] }>();
function tabsSnapshot(folder: string): CodeChat[] {
  const k = key(folder);
  const memo = tabMemo.get(k);
  if (memo && memo.v === version) return memo.list;
  const byId = new Map(loadCodeChats().map((c) => [c.sid, c]));
  const ids = [...(loadTabs()[k] ?? [])];
  const shown = codeChatFor(folder);
  if (shown && !ids.includes(shown.sid)) ids.push(shown.sid);
  const list = ids.map((s) => byId.get(s)).filter((c): c is CodeChat => !!c);
  tabMemo.set(k, { v: version, list });
  return list;
}
const EMPTY: CodeChat[] = [];
export const useCodeTabs = (folder: string): CodeChat[] =>
  useSyncExternalStore(subscribe, () => (folder ? tabsSnapshot(folder) : EMPTY), () => EMPTY);

// Another window of Friday's changed them: read again.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY && e.key !== CURRENT && e.key !== SIDS && e.key !== TABS) return;
    chats = null;
    current = null;
    sids = null;
    tabs = null;
    version++;
    listeners.forEach((l) => l());
  });
}
