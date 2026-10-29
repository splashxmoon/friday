import type { SessionEvent } from "./types.js";
/**
 * Teammates' check-ins (teammates.ts), apart from it so the page can read them too: it has no Node in it.
 *
 */
/**
 * A check-in: something a teammate is asked on a schedule, in the Team room, in the person's time zone (Arun, 2026-10-27: "needs
 * to be on par with Open Bot", whose routines do this). One with nothing new to say answers NO_UPDATE, and the room shows
 * nothing for it, as OpenBot's quiet routine runs do.
 */
export interface CheckIn {
  id: string;
  /** What it is asked, in the person's words. */
  text: string;
  every: "hourly" | "daily" | "weekdays" | "weekly";
  /** HH:MM, for all but hourly. */
  at: string;
  /** For weekly: the days, 0 = Sunday. */
  days: number[];
  /** An IANA zone: the person's own. */
  tz: string;
  /** The slot it last ran in, so a slot runs once however often the clock is checked. */
  last?: string;
}

/** How many check-ins a teammate keeps. */
export const MAX_CHECKINS = 6;

/** What a teammate with nothing new for a check-in answers, and the room then shows nothing for it. */
export const NO_UPDATE = "NO_UPDATE";

/** A check-in as the page sent it, checked; null when it isn't one. */
export function cleanCheckIn(v: unknown, id: string): CheckIn | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  const text = typeof c.text === "string" ? c.text.trim().slice(0, 2000) : "";
  const every = ["hourly", "daily", "weekdays", "weekly"].includes(c.every as string) ? (c.every as CheckIn["every"]) : null;
  if (!text || !every) return null;
  const at = typeof c.at === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(c.at) ? c.at : "09:00";
  const days = [...new Set((Array.isArray(c.days) ? c.days : []).filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  let tz = "UTC";
  try {
    if (typeof c.tz === "string" && c.tz.length <= 64) tz = (new Intl.DateTimeFormat("en-US", { timeZone: c.tz }), c.tz);
  } catch {
    // Not a zone this computer knows: UTC.
  }
  return { id: typeof c.id === "string" && /^[\w-]{4,24}$/.test(c.id) ? c.id : id, text, every, at, days: every === "weekly" && !days.length ? [1] : days, tz, ...(typeof c.last === "string" ? { last: c.last.slice(0, 20) } : {}) };
}

/**
 * The slot a check-in is due in at `now` (one run per slot), or null. Due from its time for a while after, not only in that
 * minute: a computer asleep or a timer held back at 9:00 still has its stand-up at 9:20. Up to two hours late for one at a time
 * of day, a quarter of an hour into the hour for hourly ones.
 */
export function checkInDue(c: CheckIn, now: Date): string | null {
  const at = (d: Date) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: c.tz, hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d);
    const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
    const hh = get("hour") === "24" ? "00" : get("hour");
    return { hh, minutes: Number(hh) * 60 + Number(get("minute")), date: `${get("year")}-${get("month")}-${get("day")}`, day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")) };
  };
  let p = at(now);
  if (c.every === "hourly") return p.minutes % 60 < 15 ? `${p.date}T${p.hh}` : null;
  const [ah, am] = c.at.split(":").map(Number);
  let late = p.minutes - (ah! * 60 + am!);
  // Just past midnight, the slot is yesterday's: one at 23:30 is still due at 00:10, on the day it was for (2026-10-27 audit: a
  // check-in near midnight was missed). Three hours back is yesterday whatever the clocks did overnight.
  if (late < 0) {
    p = at(new Date(now.getTime() - 3 * 3_600_000));
    late += 24 * 60;
  }
  if (late < 0 || late >= 120) return null;
  if (c.every === "weekdays" && (p.day === 0 || p.day === 6)) return null;
  if (c.every === "weekly" && !c.days.includes(p.day)) return null;
  return p.date;
}

/** "every weekday at 09:00": a check-in's schedule in words. */
export function describeCheckIn(c: Pick<CheckIn, "every" | "at" | "days">): string {
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  if (c.every === "hourly") return "every hour";
  if (c.every === "daily") return `every day at ${c.at}`;
  if (c.every === "weekdays") return `every weekday at ${c.at}`;
  return `every ${c.days.map((d) => DAYS[d]).join(", ")} at ${c.at}`;
}

/** A check-in asked of a teammate (checkInText), as it reads it. */
export const isCheckIn = (text: string) => text.startsWith("[Check-in] ");

/** A teammate's answer that there is nothing new: NO_UPDATE, give or take the stop or quotes a model puts round it. */
export const saysNoUpdate = (text: string) => /^\s*NO_UPDATE\W*\s*$/.test(text);

/**
 * The events of check-ins that had nothing new (the teammate answered NO_UPDATE): the ask, and the turn that answered it, which
 * the room leaves out and which count as no news, as OpenBot's quiet routine runs post nothing. With the lanes on a check-in now,
 * not yet answered. One pass over the log.
 *
 * Read from what delivered the ask (instructions.delivered), not only from what started a run: a check-in that came while the
 * teammate was at work went as the next turn of that run, and was never seen as one (2026-10-27 audit).
 */
export function quietCheckIns(events: readonly SessionEvent[]): { quiet: Set<number>; checking: Set<string> } {
  const quiet = new Set<number>();
  const asks = new Set<number>();
  const open = new Map<string, { seqs: number[]; said: string }>();
  /** Each lane's run start, while nothing has been said in it yet: a check-in delivered then is the run's first turn. */
  const fresh = new Map<string, number>();
  for (const e of events) {
    const lane = e.lane ?? "main";
    const b = e.body;
    if (b.type === "instruction" && isCheckIn(b.text)) asks.add(e.seq);
    if (b.type === "run.started") {
      open.delete(lane);
      fresh.set(lane, e.seq);
      // An older log, or one written by hand: the run's cause is the ask.
      if (asks.has(b.causedBy ?? -1)) open.set(lane, { seqs: [b.causedBy!, e.seq], said: "" });
      continue;
    }
    if (b.type === "instructions.delivered" && b.seqs.some((q) => asks.has(q))) {
      const had = open.get(lane);
      const start = fresh.get(lane);
      open.set(lane, { seqs: [...(had?.seqs ?? (start !== undefined ? [start] : [])), ...b.seqs.filter((q) => asks.has(q)), e.seq], said: "" });
      continue;
    }
    const run = open.get(lane);
    if (b.type === "agent.message" && b.text.trim()) fresh.delete(lane);
    if (!run) continue;
    run.seqs.push(e.seq);
    if (b.type === "agent.message" && b.text.trim()) run.said = b.text.trim();
    if (b.type === "run.ended") {
      if (saysNoUpdate(run.said)) for (const s of run.seqs) quiet.add(s);
      open.delete(lane);
      fresh.delete(lane);
    }
  }
  return { quiet, checking: new Set(open.keys()) };
}

/** What a teammate is told when a check-in is due. */
export const checkInText = (c: CheckIn) =>
  `[Check-in] ${c.text}\n\n(Your ${describeCheckIn(c)} check-in, set by the person. Do it, then say what you found in a few lines. If there is nothing new since the last one, reply with exactly ${NO_UPDATE} and nothing else.)`;

