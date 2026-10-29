/**
 * The team's round-two endpoints as the page reads them (Arun, 2026-10-28: "go all out and improve and make this better"): away
 * mode, the morning brief and "since you left", stop all and pause, each teammate's usage and its activity everywhere it works.
 * Typed here from the contract the server builds to (team2 CONTRACT.md), so the page can be built and tested while the server
 * catches up; each read answers null when the endpoint isn't there (an older server) and the page leaves that part out.
 *
 */
import { api } from "./api.js";
import { isRawError, stoppedLine } from "../activity-line.js";
import { clockUntil } from "../limit-reset.js";
import type { Identity } from "./storage.js";
import type { TeamBrief } from "../types.js";
import type { MateRun, MateUsage, TeamAway } from "../teammates.js";

/** Away mode: until when, and since when (null: here). */
export type Away = TeamAway;

/** Turns, minutes and tokens a teammate spent today and this week, across the Team room and its rooms. */
export type { MateUsage };

/** What the team did over a stretch of time: the morning brief's body, and "since you left" (types.ts TeamBrief). */
export type Brief = TeamBrief;

/** One of a teammate's turns, anywhere it works. */
export type ActivityRun = MateRun;

const JSON_BODY = { "Content-Type": "application/json" };

/** A read that answers null rather than throwing: the endpoint missing (404) or down leaves its part of the page out. */
async function quietly<T>(identity: Identity, path: string): Promise<T | null> {
  try {
    return await api<T>(identity, path);
  } catch {
    return null;
  }
}

export const readAway = (identity: Identity) => quietly<Away>(identity, "/api/teammates/away");
export const setAway = (identity: Identity, until: number | null) => api<Away>(identity, "/api/teammates/away", { method: "POST", body: JSON.stringify({ until }), headers: JSON_BODY });
export const readSince = (identity: Identity, ts: number) => quietly<Brief>(identity, `/api/teammates/since?ts=${Math.floor(ts)}`);
export const stopAll = (identity: Identity) => api<{ stopped: string[] }>(identity, "/api/teammates/stop-all", { method: "POST", body: "{}", headers: JSON_BODY });
export const setPaused = (identity: Identity, paused: boolean) => api<unknown>(identity, "/api/teammates/pause", { method: "POST", body: JSON.stringify({ paused }), headers: JSON_BODY });
export const readActivity = (identity: Identity, id: string, days = 7) => quietly<{ runs: ActivityRun[] }>(identity, `/api/teammates/${id}/activity?days=${days}`);

/** Whether a brief has anything in it worth a card. */
export const briefEmpty = (b: Brief) => !b.done.length && !b.failed.length && !b.waiting.length && !b.assumptions.length;

/** The next 8:00 AM from now: away mode's default end (Arun, 2026-10-28: "Away until 8:00 AM"). */
export function nextEight(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(8, 0, 0, 0);
  if (d.getTime() <= now + 60_000) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** A time of day typed as "HH:MM" (an <input type="time">), as the next time it comes round. */
export function nextAt(hhmm: string, now = Date.now()): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  // Not a time of day: "7:99" rolled over to 8:39 (2026-10-28 QA).
  if (!m || +m[1]! > 23 || +m[2]! > 59) return null;
  const d = new Date(now);
  d.setHours(+m[1]!, +m[2]!, 0, 0);
  if (d.getTime() <= now + 60_000) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** "8:00" from a time: the banner's short form, "8:00 AM" otherwise. */
export function clockOf(ts: number, ampm = true): string {
  const s = new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return ampm ? s : s.replace(/\s?[AP]M$/i, "");
}

/**
 * A time ahead, said with its day when it isn't today: "8:00 AM tomorrow", "8:00 AM Saturday". "Away until 8:00 PM" set at 9:26 PM
 * meant the next evening and didn't say so (QA, 2026-10-28; Arun: "TEST EVERYTHING… EVERY VISUAL").
 */
export function untilOf(ts: number, now = Date.now()): string {
  const at = new Date(ts);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(at) - day(new Date(now))) / 86_400_000);
  const clock = clockOf(ts);
  return days <= 0 ? clock : days === 1 ? `${clock} tomorrow` : days < 7 ? `${clock} ${at.toLocaleDateString([], { weekday: "long" })}` : `${clock} ${at.toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

/** "Board task "repo": Audit the README" → "Audit the README": the board's own prefix is never drawn (contract item 8). */
export const boardTitle = (text: string): string => text.replace(/^Board task\s+"[^"]*"\s*:\s*/i, "");

/** An error's words for a person: never a raw usage-limit token ("Claude AI usage limit reached|1793205493"). */
export function plainError(text: string): string {
  const limit = /usage limit reached\|(\d{9,})/i.exec(text);
  if (limit) {
    const at = +limit[1]! * (limit[1]!.length <= 10 ? 1000 : 1);
    return `Out of usage until ${clockUntil(at)}`;
  }
  if (/usage limit|rate limit|429/i.test(text)) return "Out of usage";
  // A stack trace or a tool's raw output is said as what it means (Arun, 2026-10-29: "node:internal/modules/cjs/loader:1…").
  if (isRawError(text)) return stoppedLine(text);
  return text.replace(/\|\d{9,}/g, "").replace(/^\[Friday\]\s*/, "");
}
