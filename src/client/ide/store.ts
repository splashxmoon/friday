/**
 * What Code remembers about each folder it has open: which tabs, which panels and how big, which folders of the tree are
 * open. Kept per folder in localStorage so reopening a project puts you back where you were, and so two projects don't
 * share a layout. Everything here is pure (state in, state out) except load/save, so the rules of tabs can be tested
 * without a browser.
 */

export type SideView = "explorer" | "search" | "git";
export type BottomTab = "terminal" | "problems" | "output";

/** A tab is a file, or a diff of a file against git (staged or not), or a comparison made by a save conflict. */
export interface Tab {
  /** The tab's identity: the path for a file, "diff:w:path" / "diff:s:path" for git, "cmp:path" for a conflict's comparison. */
  id: string;
  kind: "file" | "diff" | "cmp";
  path: string;
  /** Opened by a single click: shown in italics and replaced by the next one, until it is edited or double-clicked. */
  preview: boolean;
  pinned: boolean;
  staged?: boolean;
}

export interface IdeLayout {
  tabs: Tab[];
  active: string | null;
  /** Closed tabs, newest last, for ⌘⇧T. */
  closed: Tab[];
  side: { open: boolean; view: SideView; width: number };
  bottom: { open: boolean; height: number; tab: BottomTab };
  right: { open: boolean; width: number };
  /** Folders open in the tree, relative to the root ("" is the root itself). */
  expanded: string[];
  /** Files opened lately, newest first, so ⌘P offers them before anything else. */
  recent: string[];
  /** The Outline and Timeline sections at the side bar's foot. */
  sections: { outline: boolean; timeline: boolean };
}

export const LIMITS = {
  side: { min: 180, max: 560, def: 264 },
  right: { min: 280, max: 720, def: 360 },
  bottom: { min: 120, max: 720, def: 240 },
} as const;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
export const clampSide = (n: number) => clamp(Math.round(n), LIMITS.side.min, LIMITS.side.max);
export const clampRight = (n: number) => clamp(Math.round(n), LIMITS.right.min, LIMITS.right.max);
export const clampBottom = (n: number) => clamp(Math.round(n), LIMITS.bottom.min, LIMITS.bottom.max);

export const fileTab = (path: string, preview = false): Tab => ({ id: path, kind: "file", path, preview, pinned: false });
export const diffTab = (path: string, staged: boolean): Tab => ({ id: `diff:${staged ? "s" : "w"}:${path}`, kind: "diff", path, preview: false, pinned: false, staged });
export const cmpTab = (path: string): Tab => ({ id: `cmp:${path}`, kind: "cmp", path, preview: false, pinned: false });

export function initialLayout(): IdeLayout {
  return {
    tabs: [],
    active: null,
    closed: [],
    side: { open: true, view: "explorer", width: LIMITS.side.def },
    bottom: { open: false, height: LIMITS.bottom.def, tab: "terminal" },
    right: { open: true, width: LIMITS.right.def },
    expanded: [""],
    recent: [],
    sections: { outline: false, timeline: false },
  };
}

/** Open a tab, or go to it when it is open. A preview replaces the one preview tab there is; anything else lands beside the active tab. */
export function openTab(s: IdeLayout, tab: Tab): IdeLayout {
  const at = s.tabs.findIndex((t) => t.id === tab.id);
  if (at >= 0) {
    // Opening it for real (a double click) turns a preview into a tab that stays.
    const tabs = tab.preview || !s.tabs[at]!.preview ? s.tabs : s.tabs.map((t, i) => (i === at ? { ...t, preview: false } : t));
    return { ...s, tabs, active: tab.id, recent: tab.kind === "file" ? pushRecent(s.recent, tab.path) : s.recent };
  }
  let tabs = s.tabs;
  let insert = s.active ? tabs.findIndex((t) => t.id === s.active) + 1 : tabs.length;
  if (tab.preview) {
    const p = tabs.findIndex((t) => t.preview && !t.pinned);
    if (p >= 0) {
      tabs = tabs.filter((_, i) => i !== p);
      if (p < insert) insert -= 1;
      else if (p === insert) insert = p;
    }
  }
  if (insert < 0 || insert > tabs.length) insert = tabs.length;
  tabs = [...tabs.slice(0, insert), tab, ...tabs.slice(insert)];
  return { ...s, tabs, active: tab.id, recent: tab.kind === "file" ? pushRecent(s.recent, tab.path) : s.recent };
}

function pushRecent(list: string[], path: string): string[] {
  return [path, ...list.filter((p) => p !== path)].slice(0, 40);
}

/** A tab that was edited stops being a preview. */
export function keepTab(s: IdeLayout, id: string): IdeLayout {
  const t = s.tabs.find((x) => x.id === id);
  if (!t || !t.preview) return s;
  return { ...s, tabs: s.tabs.map((x) => (x.id === id ? { ...x, preview: false } : x)) };
}

export function pinTab(s: IdeLayout, id: string, pinned: boolean): IdeLayout {
  const tabs = s.tabs.map((t) => (t.id === id ? { ...t, pinned, preview: false } : t));
  // Pinned tabs sit together at the left, as in VS Code.
  const sorted = [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)];
  return { ...s, tabs: sorted };
}

/** Which tab takes over when `id` closes: its neighbour to the right, else to the left. */
function neighbour(tabs: Tab[], id: string): string | null {
  const i = tabs.findIndex((t) => t.id === id);
  const rest = tabs.filter((t) => t.id !== id);
  return rest[Math.min(i, rest.length - 1)]?.id ?? null;
}

export function closeTabs(s: IdeLayout, ids: string[]): IdeLayout {
  const gone = new Set(ids);
  const dying = s.tabs.filter((t) => gone.has(t.id));
  if (!dying.length) return s;
  let active = s.active;
  if (active && gone.has(active)) {
    const left = s.tabs.filter((t) => !gone.has(t.id));
    // The nearest survivor of the active tab, looking right first.
    const from = s.tabs.findIndex((t) => t.id === active);
    active = s.tabs.slice(from).find((t) => !gone.has(t.id))?.id ?? [...s.tabs.slice(0, from)].reverse().find((t) => !gone.has(t.id))?.id ?? left[0]?.id ?? null;
  }
  const closed = [...s.closed, ...dying.filter((t) => t.kind === "file")].slice(-20);
  return { ...s, tabs: s.tabs.filter((t) => !gone.has(t.id)), active, closed };
}

export const closeTab = (s: IdeLayout, id: string) => closeTabs(s, [id]);
export const closeOthers = (s: IdeLayout, id: string) => closeTabs(s, s.tabs.filter((t) => t.id !== id && !t.pinned).map((t) => t.id));
export function closeToRight(s: IdeLayout, id: string): IdeLayout {
  const i = s.tabs.findIndex((t) => t.id === id);
  return closeTabs(s, i < 0 ? [] : s.tabs.slice(i + 1).filter((t) => !t.pinned).map((t) => t.id));
}

/** ⌘⇧T: the last closed file comes back. */
export function reopenClosed(s: IdeLayout): IdeLayout {
  const last = s.closed[s.closed.length - 1];
  if (!last) return s;
  return openTab({ ...s, closed: s.closed.slice(0, -1) }, { ...last, preview: false });
}

/** Ctrl-Tab: the next tab (dir 1) or the previous (-1), wrapping round. */
export function cycleTab(s: IdeLayout, dir: 1 | -1): IdeLayout {
  if (s.tabs.length < 2) return s;
  const i = Math.max(0, s.tabs.findIndex((t) => t.id === s.active));
  return { ...s, active: s.tabs[(i + dir + s.tabs.length) % s.tabs.length]!.id };
}

export function moveTab(s: IdeLayout, id: string, before: string | null): IdeLayout {
  const t = s.tabs.find((x) => x.id === id);
  if (!t || id === before) return s;
  const rest = s.tabs.filter((x) => x.id !== id);
  const at = before === null ? rest.length : rest.findIndex((x) => x.id === before);
  if (at < 0) return s;
  return { ...s, tabs: [...rest.slice(0, at), t, ...rest.slice(at)] };
}

export const activateTab = (s: IdeLayout, id: string): IdeLayout => (s.tabs.some((t) => t.id === id) ? { ...s, active: id } : s);

/** A file or folder was renamed or moved: tabs under it follow it, and so do open folders. */
export function renamePaths(s: IdeLayout, from: string, to: string): IdeLayout {
  const map = (p: string) => (p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p);
  const tabId = (t: Tab) => (t.kind === "file" ? map(t.path) : t.kind === "cmp" ? `cmp:${map(t.path)}` : `diff:${t.staged ? "s" : "w"}:${map(t.path)}`);
  const tabs = s.tabs.map((t) => ({ ...t, path: map(t.path), id: tabId(t) }));
  const activeTab = s.tabs.find((t) => t.id === s.active);
  return {
    ...s,
    tabs,
    active: activeTab ? tabId(activeTab) : s.active,
    expanded: s.expanded.map(map),
    recent: s.recent.map(map),
    closed: s.closed.map((t) => ({ ...t, path: map(t.path), id: tabId(t) })),
  };
}

/** A file or folder was deleted: its tabs close without being offered back. */
export function removePaths(s: IdeLayout, path: string): IdeLayout {
  const under = (p: string) => p === path || p.startsWith(path + "/");
  const next = closeTabs(s, s.tabs.filter((t) => under(t.path)).map((t) => t.id));
  return { ...next, closed: next.closed.filter((t) => !under(t.path)), expanded: next.expanded.filter((p) => !under(p)), recent: next.recent.filter((p) => !under(p)) };
}

export function toggleExpanded(s: IdeLayout, dir: string, on?: boolean): IdeLayout {
  const has = s.expanded.includes(dir);
  const want = on ?? !has;
  if (want === has) return s;
  return { ...s, expanded: want ? [...s.expanded, dir] : s.expanded.filter((d) => d !== dir) };
}

/** Open every folder on the way to a file, so it can be revealed in the tree. */
export function expandTo(s: IdeLayout, path: string): IdeLayout {
  const parts = path.split("/").slice(0, -1);
  const need: string[] = [""];
  for (let i = 0; i < parts.length; i++) need.push(parts.slice(0, i + 1).join("/"));
  const missing = need.filter((d) => !s.expanded.includes(d));
  return missing.length ? { ...s, expanded: [...s.expanded, ...missing] } : s;
}

export const collapseAll = (s: IdeLayout): IdeLayout => ({ ...s, expanded: [""] });

export function setSideView(s: IdeLayout, view: SideView): IdeLayout {
  // Pressing the view that is showing hides the side bar, like the activity bar in VS Code.
  if (s.side.open && s.side.view === view) return { ...s, side: { ...s.side, open: false } };
  return { ...s, side: { ...s.side, open: true, view } };
}

export function showBottom(s: IdeLayout, tab: BottomTab): IdeLayout {
  return { ...s, bottom: { ...s.bottom, open: true, tab } };
}

/** ⌘J: toggle the panel. */
export const toggleBottom = (s: IdeLayout): IdeLayout => ({ ...s, bottom: { ...s.bottom, open: !s.bottom.open } });
export const toggleSide = (s: IdeLayout): IdeLayout => ({ ...s, side: { ...s.side, open: !s.side.open } });
export const toggleRight = (s: IdeLayout): IdeLayout => ({ ...s, right: { ...s.right, open: !s.right.open } });

// ── Remembering it ──────────────────────────────────────────────────────────────

const KEY = (root: string) => `friday.ide.layout.${root}`;

const isStr = (x: unknown): x is string => typeof x === "string";

/** Whatever was stored, made safe: a layout from an older version, or hand-edited, must not break the page. */
export function sanitize(raw: unknown): IdeLayout {
  const base = initialLayout();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const tab = (x: unknown): Tab | null => {
    if (!x || typeof x !== "object") return null;
    const t = x as Record<string, unknown>;
    if (!isStr(t.path) || !isStr(t.id)) return null;
    const kind = t.kind === "diff" || t.kind === "cmp" ? t.kind : "file";
    // A comparison held texts in memory only: it can't come back.
    if (kind === "cmp") return null;
    return { id: t.id, kind, path: t.path, preview: t.preview === true, pinned: t.pinned === true, ...(t.staged === true ? { staged: true } : {}) };
  };
  const tabs = (Array.isArray(r.tabs) ? r.tabs : []).map(tab).filter((t): t is Tab => !!t);
  const seen = new Set<string>();
  const unique = tabs.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
  const num = (x: unknown, f: number) => (typeof x === "number" && Number.isFinite(x) ? x : f);
  const obj = (x: unknown): Record<string, unknown> => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});
  const side = obj(r.side);
  const bottom = obj(r.bottom);
  const right = obj(r.right);
  const sections = obj(r.sections);
  return {
    tabs: unique,
    active: isStr(r.active) && unique.some((t) => t.id === r.active) ? r.active : (unique[0]?.id ?? null),
    closed: (Array.isArray(r.closed) ? r.closed : []).map(tab).filter((t): t is Tab => !!t).slice(-20),
    side: {
      open: side.open !== false,
      view: side.view === "search" || side.view === "git" ? side.view : "explorer",
      width: clampSide(num(side.width, base.side.width)),
    },
    bottom: {
      open: bottom.open === true,
      height: clampBottom(num(bottom.height, base.bottom.height)),
      tab: bottom.tab === "problems" || bottom.tab === "output" ? bottom.tab : "terminal",
    },
    right: { open: right.open !== false, width: clampRight(num(right.width, base.right.width)) },
    expanded: Array.isArray(r.expanded) ? r.expanded.filter(isStr).slice(0, 500) : base.expanded,
    recent: Array.isArray(r.recent) ? r.recent.filter(isStr).slice(0, 40) : [],
    sections: { outline: sections.outline === true, timeline: sections.timeline === true },
  };
}

export function loadLayout(root: string): IdeLayout {
  try {
    const raw = localStorage.getItem(KEY(root));
    return raw ? sanitize(JSON.parse(raw)) : initialLayout();
  } catch {
    return initialLayout();
  }
}

export function saveLayout(root: string, s: IdeLayout): void {
  try {
    localStorage.setItem(KEY(root), JSON.stringify(s));
  } catch {
    // Not kept: the layout lasts until the window closes.
  }
}

/** The folders opened by hand (the path box), for the empty state, newest first. */
const FOLDERS = "friday.ide.folders";
export function loadFolders(): { path: string; name: string }[] {
  try {
    const v = JSON.parse(localStorage.getItem(FOLDERS) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is { path: string; name: string } => !!x && isStr((x as { path?: unknown }).path) && isStr((x as { name?: unknown }).name)).slice(0, 12) : [];
  } catch {
    return [];
  }
}
export function rememberFolder(path: string, name: string): void {
  try {
    const next = [{ path, name }, ...loadFolders().filter((f) => f.path !== path)].slice(0, 12);
    localStorage.setItem(FOLDERS, JSON.stringify(next));
  } catch {
    // Courtesy only.
  }
}
