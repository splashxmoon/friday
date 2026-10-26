import type { Role } from "../types.js";

// Per-browser identity, sidebar organisation and layout. Invite links carry
// the role; nothing here is trusted by the server.

export interface Identity {
  id: string;
  name: string;
}

export interface RecentSession {
  sid: string;
  title: string;
  invite: string;
  role: Role;
  openedAt: number;
  /** Project this session is filed under (sidebar only). */
  projectId?: string;
  /** Your own label for it (sidebar only; the real title is the owner's to change). */
  alias?: string;
  /** The code folders its agents work in, remembered so the chat list can group chats by repo. */
  repos?: RepoUse[];
  /** Put to bed until this time (sidebar only): out of the list, in Snoozed, unless something in it needs you first. */
  snoozedUntil?: number;
  /** Settled by hand (sidebar only): out of the list, in Settled, until something happens in it or you bring it back. */
  settledAt?: number;
}

/** One repo a chat is working in: its name, the branch an agent is on, and whether one is connected now. */
export interface RepoUse {
  name: string;
  branch?: string;
  live: boolean;
}

export interface Project {
  id: string;
  name: string;
  collapsed: boolean;
  createdAt: number;
}

export interface Layout {
  sidebarCollapsed: boolean;
  docOpen: boolean;
  docWidth: number;
}

function get(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

function set(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    // Private mode or blocked storage: things just won't persist.
  }
}

function getJson<T>(k: string, fallback: T): T {
  try {
    const v = JSON.parse(get(k) ?? "null");
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Identity used to live here: a random id and a typed name, which meant a
 * person was whoever their browser claimed. It comes from /api/me now, backed
 * by a signed cookie, so there is nothing to keep in localStorage.
 */

/** Folders this person pointed a coding agent at, newest first. */
export function loadRecentFolders(): string[] {
  const v = getJson<string[]>("mpa.folders", []);
  return Array.isArray(v) ? v.filter((p) => typeof p === "string") : [];
}

export const saveRecentFolder = (p: string) => set("mpa.folders", JSON.stringify([p, ...loadRecentFolders().filter((x) => x !== p)].slice(0, 12)));

export function loadRecents(): RecentSession[] {
  const v = getJson<RecentSession[]>("mpa.sessions", []);
  return Array.isArray(v) ? v : [];
}
export const saveRecents = (list: RecentSession[]) => set("mpa.sessions", JSON.stringify(list.slice(0, 100)));

export function loadProjects(): Project[] {
  const v = getJson<Project[]>("mpa.projects", []);
  return Array.isArray(v) ? v : [];
}
export const saveProjects = (list: Project[]) => set("mpa.projects", JSON.stringify(list));

/**
 * Which of the sidebar's fixed sections are folded away.
 *
 * Only the closed ones are stored, so a section added later starts open rather
 * than inheriting somebody's old preference about a section that didn't exist.
 */
export function loadFolded(): string[] {
  try {
    const v = JSON.parse(get("mpa.folded") ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
export const saveFolded = (ids: string[]) => set("mpa.folded", JSON.stringify(ids));

/** The order the chat list's sections (Projects, one per repo, Recent) were dragged into. Ids it has not heard of keep their usual place. */
export function loadSectionOrder(): string[] {
  try {
    const v = JSON.parse(get("mpa.sectionOrder") ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
export const saveSectionOrder = (ids: string[]) => set("mpa.sectionOrder", JSON.stringify(ids));

export function loadLayout(): Layout {
  const narrow = typeof innerWidth === "number" && innerWidth < 1000;
  const v = getJson<Partial<Layout>>("mpa.layout", {});
  return {
    sidebarCollapsed: narrow ? true : (v.sidebarCollapsed ?? false),
    docOpen: narrow ? false : (v.docOpen ?? true),
    docWidth: v.docWidth ?? 460,
  };
}
export const saveLayout = (l: Layout) => set("mpa.layout", JSON.stringify(l));

// ── theme ────────────────────────────────────────────────────────────

export type Theme = "dark" | "light";

/**
 * Which theme is showing. "system" isn't stored as a third value: what is
 * saved is the choice someone made, and until they make one the boot script
 * in index.html follows the OS. Reading the class back is therefore the only
 * honest answer to "what am I looking at".
 */
export const currentTheme = (): Theme => (document.documentElement.classList.contains("dark") ? "dark" : "light");

/** The look showing: the two themes, or Glass (dark underneath, with the class on top). */
export const currentLook = (): Theme => currentTheme();

export function setTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  // Glass is a look on top of dark; any other choice puts it away.
  document.documentElement.classList.remove("glass");
  set("mpa.theme", theme);
  tellDesktopTheme(theme);
  forceRepaint();
}

/**
 * Chromium sometimes leaves an animated card's own text on its old paint
 * after this: framer-motion promotes anything it has animated to its own
 * GPU layer, and recolouring by a CSS custom property, with no new
 * transform or opacity to trigger a redraw, occasionally never reaches that
 * layer. The agent's question card is the one built entirely out of such
 * elements, so it is the one this shows up on — readable again the moment
 * anything else forces a real repaint, resizing the window included.
 *
 * A window resize is exactly what this fakes: toggling layout display off
 * and back tears down and rebuilds every layer under it before the next
 * frame, which is a blunter fix than tracking down which element Chromium
 * missed — but it runs once, synchronously, before that frame is ever
 * drawn, so nothing visibly flashes.
 *
 * ponytail: papers over a Chromium/framer-motion compositing gap rather
 * than removing it; if it resurfaces somewhere this doesn't reach, look at
 * dropping the `will-change` hints on the components involved instead.
 */
function forceRepaint(): void {
  const el = document.body;
  const prev = el.style.display;
  el.style.display = "none";
  void el.offsetHeight;
  el.style.display = prev;
}

/**
 * The desktop app draws the window buttons itself and can't see the page's
 * theme, so it is told — on every change, and once on load for whatever the
 * boot script settled on (which may be the OS's choice, not a saved one).
 */
export function tellDesktopTheme(theme: Theme = currentTheme()): void {
  window.fridayDesktop?.setTheme?.(theme);
}
