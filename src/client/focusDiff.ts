/**
 * "Show me that file's diff", across a change of session.
 *
 * Following a warning that another session is changing a file is only useful if it ends at that file's change, not at the top
 * of somebody else's chat. The request survives the navigation in the tab's own storage, is good for twenty seconds (long
 * enough to open a session, short enough that a stale one never opens a panel by surprise), and is read once the session is up.
 */
const KEY = "mpa.focusDiff";
const TTL = 20_000;

export function askToShowDiff(sid: string, path: string): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ sid, path, at: Date.now() }));
  } catch {
    // No storage: the session still opens, just not on the file.
  }
}

/** The file asked for in this session, if somebody asked recently. */
export function readDiffRequest(sid: string, now = Date.now()): string | null {
  try {
    const r = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as { sid?: string; path?: string; at?: number } | null;
    return r && r.sid === sid && typeof r.path === "string" && typeof r.at === "number" && now - r.at < TTL ? r.path : null;
  } catch {
    return null;
  }
}

export function clearDiffRequest(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}

/** The same file whether one side says it from the folder's root and the other from a level below. */
export const sameFile = (a: string, b: string): boolean => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

/** Asks the Diff panel to bring a file into view. False once a panel has taken it, so nobody asks again. */
export const showDiff = (path: string): boolean => window.dispatchEvent(new CustomEvent("friday:show-diff", { detail: { path }, cancelable: true }));

/** Asks again while the panel is still drawing, and stops at the first panel that takes it. Returns a way to stop early. */
export function showDiffSoon(path: string, delays = [350, 900, 1700]): () => void {
  const stop = () => tries.forEach(clearTimeout);
  const tries = delays.map((ms) => setTimeout(() => !showDiff(path) && stop(), ms));
  return stop;
}

/** Whether this diff of `path`, at `el`, is the one to answer a show-diff: in the Diff panel, and first. Taking it tells the asker. */
export function takesShowDiff(e: Event, path: string, el: Element | null): boolean {
  const want = (e as CustomEvent<{ path: string }>).detail?.path;
  if (e.defaultPrevented || !want || !sameFile(want, path) || !el?.closest(".bench-body")) return false;
  e.preventDefault();
  return true;
}

/** How long a dismissed notice stays dismissed. A week: long enough to stop nagging, short enough to come back if it is still true. */
export const DISMISS_MS = 7 * 24 * 3600 * 1000;
