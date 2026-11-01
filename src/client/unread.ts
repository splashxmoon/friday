import { useSyncExternalStore } from "react";

/**
 * Sessions whose agents finished while you were somewhere else, until you open them: the sidebar marks them, as a mail list marks
 * what came in. A session that finished while you were away looked like every row already read (Arun, 2026-10-28: "iron
 * everything and ensure we are good… any logic errors and fixes").
 *
 * Two sources, joined: this browser's own marks, set the moment a run ends here; and the server's, which knows how far you have
 * read each session on any device (the page's ack, sent only while it is in sight), so a session finished while you were on your
 * phone shows here, and one you read there doesn't (Herdr's "done, not seen yet", 2026-11-01). One you have just opened isn't
 * new again for the few seconds before the server hears you read it.
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

let local: Set<string> | null = null;
/** The server's, as the attention poll last said them. */
let server = new Set<string>();
/** Opened here: not new, whatever the server says, until it stops saying so (it heard the read). */
const opened = new Set<string>();
let current: Set<string> | null = null;
const join = () => new Set([...(local ??= load()), ...[...server].filter((s) => !opened.has(s))]);
/** The sessions marked new right now. */
export const unreadNow = (): ReadonlySet<string> => (current ??= join());
const now = unreadNow;
const changed = () => {
  current = join();
  dispatchEvent(new Event(EVENT));
};

function save(next: Set<string>): void {
  local = next;
  try {
    localStorage.setItem(KEY, JSON.stringify([...next].slice(-200)));
  } catch {
    // Remembered for this page only.
  }
  changed();
}

/** What the server says finished since you last looked, on any device (Attention.tsx). */
export function setServerUnread(sids: string[]): void {
  const next = new Set(sids);
  // Opened here, and now read as far as the server knows: let go, so it can be new again when it next finishes.
  for (const s of [...opened]) if (!next.has(s)) opened.delete(s);
  if (next.size === server.size && [...next].every((s) => server.has(s))) return;
  server = next;
  changed();
}

/** What changed between two looks at which sessions have an agent working: the ones that stopped working, and the ones that started. */
export function workingChanges(was: ReadonlySet<string>, is: ReadonlySet<string>): { finished: string[]; started: string[] } {
  return { finished: [...was].filter((s) => !is.has(s)), started: [...is].filter((s) => !was.has(s)) };
}

/** These sessions have news you haven't seen. */
export function markUnread(sids: string[]): void {
  const had = local ?? load();
  for (const s of sids) opened.delete(s);
  if (sids.every((s) => had.has(s))) return changed();
  save(new Set([...had, ...sids]));
}

/** Opened: nothing in it is news any more. */
export function clearUnread(sid: string): void {
  if (server.has(sid)) opened.add(sid);
  const had = local ?? load();
  if (!had.has(sid)) return changed();
  const next = new Set(had);
  next.delete(sid);
  save(next);
}

export function useUnread(): ReadonlySet<string> {
  return useSyncExternalStore(
    (f) => {
      // Another window of Friday marking or opening one: read again.
      const heard = (e: StorageEvent) => e.key === KEY && ((local = load()), (current = join()), f());
      addEventListener(EVENT, f);
      addEventListener("storage", heard);
      return () => (removeEventListener(EVENT, f), removeEventListener("storage", heard));
    },
    now,
    () => new Set<string>(),
  );
}
