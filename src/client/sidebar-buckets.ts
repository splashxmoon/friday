import type { RecentSession } from "./storage.js";

/**
 * Which sessions the sidebar's list shows, and which it puts to bed (Arun, 2026-10-25, after T3 Code's Snoozed and Settled).
 *
 * A session you snoozed stays out of the list until the time you picked. One nobody has opened in three days, with nothing
 * going on in it, settles by itself; one can be settled by hand too. Both sit in folded groups at the foot of the list, counted.
 * Only two things bring one back early: something in it waiting on you, or an agent in it working again. A quiet session stays
 * asleep however often somebody else writes in it.
 */

/** Three days with no one opening it and nothing going on, and a session settles by itself. */
export const SETTLE_AFTER_MS = 3 * 86_400_000;

export interface Buckets {
  active: RecentSession[];
  snoozed: RecentSession[];
  settled: RecentSession[];
}

export function buckets(recents: RecentSession[], live: { needs: ReadonlySet<string>; working: ReadonlySet<string>; /** Sessions whose pull request has merged: their work has landed, so they settle (Arun, 2026-10-25, tier 2). */ merged?: ReadonlySet<string> }, now = Date.now()): Buckets {
  const out: Buckets = { active: [], snoozed: [], settled: [] };
  for (const r of recents) {
    const awake = live.needs.has(r.sid) || live.working.has(r.sid);
    if (!awake && r.snoozedUntil && r.snoozedUntil > now) out.snoozed.push(r);
    else if (!awake && (r.settledAt || live.merged?.has(r.sid) || now - r.openedAt > SETTLE_AFTER_MS)) out.settled.push(r);
    else out.active.push(r);
  }
  return out;
}

/** The times a snooze can run to: a few hours, tomorrow morning, next week. */
export function snoozePresets(now = Date.now()): { label: string; until: number }[] {
  const morning = (daysOn: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + daysOn);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  };
  const tomorrow = morning(1);
  return [
    { label: "For 3 hours", until: now + 3 * 3_600_000 },
    { label: "Until tomorrow morning", until: tomorrow },
    { label: "Until next week", until: morning(7) },
  ];
}

/** "until 9:00 tomorrow", "until Mon 9:00", "for 2 more hours": how long a snoozed session sleeps, as its row says. */
export function snoozeWord(until: number, now = Date.now()): string {
  const left = until - now;
  if (left <= 0) return "waking";
  const d = new Date(until);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = Math.floor((d.setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return left < 3 * 3_600_000 ? `for ${Math.max(1, Math.round(left / 3_600_000))} more hour${Math.round(left / 3_600_000) === 1 ? "" : "s"}` : `until ${time}`;
  if (days === 1) return `until ${time} tomorrow`;
  return `until ${new Date(until).toLocaleDateString([], { weekday: "short" })} ${time}`;
}
