import { api } from "../api.js";
import type { Identity } from "../storage.js";

/**
 * One look at the tasks for later (/api/later) for everything on the page that wants it: the box's Run later (its count and list) and the
 * taking in of chats it started (later-adopt.ts). Every 20 seconds while anything is listening, and on a call to feedRefresh, so two
 * pollers never ask the same thing twice (Arun, 2026-11-20: "Tonight from the IDE"; the goal is speed).
 */
type Row = { id: string; status: string; [k: string]: unknown };

const listeners = new Set<(rows: Row[]) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let last: Row[] | null = null;
let looking: Promise<void> | null = null;
/** Set when this Friday has no such list (the hosted one): not asked again by this page. */
let absent = false;

export function feedRefresh(identity: Identity): Promise<void> {
  if (absent) return Promise.resolve();
  if (looking) return looking;
  looking = api<{ tasks: Row[] }>(identity, "/api/later")
    .then(
      (r) => {
        last = r.tasks;
        for (const f of listeners) f(r.tasks);
      },
      // A failed look (away a moment) changes nothing.
      (e: Error) => void (absent = /not found/i.test(e.message)),
    )
    .finally(() => (looking = null));
  return looking;
}

/** Hears every look; the latest one at once. Gives back the way to stop. */
export function feedSubscribe(identity: Identity, f: (rows: Row[]) => void): () => void {
  listeners.add(f);
  if (last) f(last);
  if (!timer) timer = setInterval(() => void feedRefresh(identity), 20_000);
  void feedRefresh(identity);
  return () => {
    listeners.delete(f);
    if (!listeners.size && timer) (clearInterval(timer), (timer = null), (last = null));
  };
}
