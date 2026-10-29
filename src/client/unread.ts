import { useSyncExternalStore } from "react";

/**
 * Sessions whose agents finished while you were somewhere else, until you open them: the sidebar marks them, as a mail list marks
 * what came in. A session that finished while you were away looked like every row already read (Arun, 2026-10-28: "iron
 * everything and ensure we are good… any logic errors and fixes"). Kept in this browser only, like the list itself.
 */

const KEY = "friday.unread";
const EVENT = "friday:unread";

function load(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

let current: Set<string> | null = null;
const now = () => (current ??= load());

function save(next: Set<string>): void {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify([...next].slice(-200)));
  } catch {
    // Remembered for this page only.
  }
  dispatchEvent(new Event(EVENT));
}

/** What changed between two looks at which sessions have an agent working: the ones that stopped working, and the ones that started. */
export function workingChanges(was: ReadonlySet<string>, is: ReadonlySet<string>): { finished: string[]; started: string[] } {
  return { finished: [...was].filter((s) => !is.has(s)), started: [...is].filter((s) => !was.has(s)) };
}

/** These sessions have news you haven't seen. */
export function markUnread(sids: string[]): void {
  const had = now();
  if (sids.every((s) => had.has(s))) return;
  save(new Set([...had, ...sids]));
}

/** Opened: nothing in it is news any more. */
export function clearUnread(sid: string): void {
  if (!now().has(sid)) return;
  const next = new Set(now());
  next.delete(sid);
  save(next);
}

export function useUnread(): ReadonlySet<string> {
  return useSyncExternalStore(
    (f) => {
      // Another window of Friday marking or opening one: read again.
      const heard = (e: StorageEvent) => e.key === KEY && ((current = load()), f());
      addEventListener(EVENT, f);
      addEventListener("storage", heard);
      return () => (removeEventListener(EVENT, f), removeEventListener("storage", heard));
    },
    now,
    () => new Set<string>(),
  );
}
