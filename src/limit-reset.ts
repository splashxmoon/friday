/**
 * A coding tool out of usage, read from how its run ended, and when it can go on.
 *
 * Claude Code and Codex stop mid-task when the account's 5-hour or weekly allowance runs out, and say when it comes back
 * in their own words: "resets 3pm (America/New_York)", "try again in 2 hours 13 minutes", an epoch after a bar. Read
 * here on the client, which knows the clock the person reads, so "3pm" without a zone is their 3pm.
 */

import { MAIN_LANE } from "./types.js";

/**
 * When a limit lifts, as a person reads it: "3:00 PM" today, "3:00 PM tomorrow", or "Tue 3:00 PM". A bare time read as today's:
 * "Out of usage until 3:00 PM" at 4:25 PM meant tomorrow, beside a card that said "about 23 hours" (Arun, 2026-10-28: "iron
 * everything and ensure we are good… any logic errors and fixes").
 */
export function clockUntil(at: number, now = Date.now()): string {
  const t = new Date(at);
  const time = t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((day(t) - day(new Date(now))) / 86_400_000);
  return days === 0 ? time : days === 1 ? `${time} tomorrow` : `${t.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/**
 * A coding tool that stopped because it isn't signed in on the computer it runs on, from how its run ended: the tool's own words
 * ("Not logged in · Please run /login") or the runner's explanation of them (runner/adapters.ts explain). Not a limit.
 */
export function signedOut(error: string | undefined): boolean {
  return !!error && /isn't (signed|logged) in on the computer it runs on|login has expired|not logged in|please run \/login|not authenticated/i.test(error);
}

type RunLike = { status: string; sinceSeq: number; error?: string };
/**
 * A lane that ran out of usage (or isn't signed in) whose task another agent here carried on (the hand-off out of usage makes by itself): one at work
 * since, or one that finished a turn after it stopped. The session reads as stopped no longer: the status bar and the sidebar
 * said "Claude Code stopped" in red after Codex had finished the work (Arun, 2026-10-28: "iron everything and ensure we are good").
 */
export function carriedOn(state: { run: RunLike; laneRuns: Record<string, RunLike>; finished?: Record<string, number>; lanes: { id: string }[] }, lane: string): boolean {
  const runOf = (id: string) => (id === MAIN_LANE ? state.run : state.laneRuns[id]);
  const run = runOf(lane);
  if (run?.status !== "error" || !(limitHit(run.error) || signedOut(run.error))) return false;
  return [MAIN_LANE, ...state.lanes.map((l) => l.id)].some((id) => id !== lane && (runOf(id)?.status === "running" || (state.finished?.[id] ?? 0) > run.sinceSeq));
}

export const LIMIT = /usage limit|session limit|weekly limit|5-hour limit|rate limit|quota|too many requests|hit your limit|\b429\b/i;

export interface LimitHit {
  /** When the allowance comes back, as a time; null when the message didn't say. */
  resetsAt: number | null;
}

const UNIT: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** How far `tz` runs ahead of UTC at `t`, in ms. */
function offsetAt(t: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(new Date(t))
      .map((x) => [x.type, Number(x.value)]),
  ) as Record<string, number>;
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - t;
}

/** A wall-clock time in a zone, as a time. */
function wallTime(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo, d, h, mi);
  const t = guess - offsetAt(guess, tz);
  // Across a clock change the first guess is an hour out; the offset at the answer settles it.
  return guess - offsetAt(t, tz);
}

/** Whether this run ended on a usage limit, and when it lifts. */
export function limitHit(error: string | undefined, now = Date.now(), tz?: string): LimitHit | null {
  if (!error || !LIMIT.test(error)) return null;
  // Claude Code's older form: "Claude AI usage limit reached|1760000000".
  const epoch = /\|(\d{10})\b/.exec(error);
  if (epoch) return { resetsAt: Number(epoch[1]) * 1000 };
  // "try again in 2 hours 13 minutes", "resets in 4h 12m", "retry in 37s".
  const span = /\b(?:try again|retry|resets?|available)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i.exec(error);
  if (span) {
    let ms = 0;
    for (const [, n, u] of span[1]!.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) ms += Number(n) * (UNIT[u!.toLowerCase()[0]!] ?? 0);
    if (ms > 0) return { resetsAt: now + Math.round(ms) };
  }
  // "resets 3pm (America/New_York)", "resets Oct 14, 3pm", "reset at 3:04 PM", "try again at Oct 14th, 2025 3:04 PM".
  const at = /\b(?:resets?|try again|retry|available again)\s+(?:at\s+|on\s+)?(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?!\d)(?:st|nd|rd|th)?,?\s*(?:(\d{4}),?\s*)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)*)\))?/i.exec(error);
  if (at) {
    const [, mon, day, year, hh, mm, ap, zone] = at;
    const month = mon ? MONTHS.indexOf(mon.toLowerCase()) : -1;
    let h = Number(hh);
    const mi = Number(mm ?? 0);
    // A bare number with no colon, no am/pm and no date is a count of something, not a time.
    if ((mon && month < 0) || (!mm && !ap && !mon) || h > 23 || mi > 59 || (ap && (h < 1 || h > 12))) return { resetsAt: null };
    if (ap) h = (h % 12) + (ap.toLowerCase() === "pm" ? 12 : 0);
    let zoneId = zone || tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      offsetAt(now, zoneId);
    } catch {
      zoneId = tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
    }
    const today = new Intl.DateTimeFormat("en-US", { timeZone: zoneId, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date(now));
    const part = (k: string) => Number(today.find((x) => x.type === k)!.value);
    if (month >= 0) {
      let t = wallTime(year ? Number(year) : part("year"), month, Number(day), h, mi, zoneId);
      // "Jan 2" read on Dec 30 is next year's.
      if (!year && t < now - 86_400_000) t = wallTime(part("year") + 1, month, Number(day), h, mi, zoneId);
      return { resetsAt: t };
    }
    let t = wallTime(part("year"), part("month") - 1, part("day"), h, mi, zoneId);
    if (t <= now - 60_000) t = wallTime(part("year"), part("month") - 1, part("day") + 1, h, mi, zoneId);
    return { resetsAt: t };
  }
  return { resetsAt: null };
}

/** An account's allowance spent: its 5-hour, weekly or session limit, said in the tool's own words. */
const PLAN_LIMIT = /usage limit|session limit|weekly limit|(?:5|five)[- ]hour limit|hit your (?:usage )?limit|plan(?:'s)? limit|out of (?:usage|credits|extra usage)|credit balance is too low/i;
/** A limit on how fast requests come, gone in a minute: a per-minute 429, "too many requests". */
const RATE_ONLY = /per[- ](?:minute|second)|requests? per|tokens per|\b[rt]pm\b/i;

/**
 * Whether this run ended on its account's allowance, not on a passing rate limit: plan wording, or a reset far enough off to be
 * the allowance's. What moving the work to another tool for hours should wait for (2026-10-27 audit: a per-minute 429 moved it
 * for five hours); a passing one is worth trying again in a moment instead.
 */
export function planLimitHit(error: string | undefined, now = Date.now(), tz?: string): LimitHit | null {
  const hit = limitHit(error, now, tz);
  if (!hit || !error) return null;
  if (PLAN_LIMIT.test(error) && !RATE_ONLY.test(error)) return hit;
  return hit.resetsAt !== null && hit.resetsAt - now >= 15 * 60_000 ? hit : null;
}
