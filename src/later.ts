import { issueRef, prRef } from "./github-issue.js";
import { EFFORT_LEVELS, ENGINE_TOOLS, isEngineEffort, type EngineEffort, type EngineMode, type EngineTool, type IssueRef, type PrRef } from "./types.js";

/**
 * Run later (Arun, 2026-11-20, Code <-> Agents: "Tonight from the IDE: queue a task from Code to run overnight (or at a time), with the
 * results waiting in the morning").
 *
 * Friday's Automations have schedules (every hour, day or week) but nothing that runs once, at a time, from a chat's own box, so this
 * is the small honest version: a task (the folder, the words, the coding tool, what it may do) kept with the moment to start it, in
 * UTC. Friday starts it then, as a Code chat on this computer, ONLY if Friday is running at that time: nothing runs while it is
 * closed, and a task whose moment passed while it was closed is shown as missed, with Run now, rather than started hours late
 * on a surprise. Said plainly in the page, wherever the time is picked.
 *
 * Times are kept as UTC milliseconds and shown in the person's own zone (Intl, any IANA name): "Tonight at 1 AM" means the next
 * 1:00 on their clock, the page works that out and the server only ever sees the instant.
 */

export type LaterStatus = "queued" | "starting" | "running" | "missed" | "failed";

export interface LaterTask {
  id: string;
  ownerId: string;
  ownerName: string;
  /** The folder it works in, on this computer. */
  folder: string;
  /** The words it is given. */
  ask: string;
  /** The chat's name (first line of the ask). */
  title: string;
  tool: EngineTool;
  mode: EngineMode;
  /** Auto without the go-ahead list ("Full access"): only with mode "full". */
  fullAccess: boolean;
  /** One of the tool's own models; empty is its default. */
  model: string;
  /** The account of the tool picked in the box: it runs on that one, never on another (the own-plan rule). Empty is the tool's own sign-in. */
  account?: string;
  /** The tool's effort level picked in the box. */
  effort?: EngineEffort;
  /** The issue or pull request the box held: the chat is linked to it as a normal start's is. */
  issue?: IssueRef;
  pr?: PrRef;
  /** When to start it: UTC milliseconds. */
  at: number;
  created: number;
  status: LaterStatus;
  /** Set once it started: the chat it became. */
  sid?: string;
  invite?: string;
  /** When it started, and why it failed or was missed. */
  startedAt?: number;
  note?: string;
}

/** A task is started this long after its moment at the latest: later than that, Friday was closed through it. */
export const LATE_GRACE_MS = 10 * 60_000;
/** The furthest ahead a task can be queued, and how many a person keeps at once. */
export const LATER_AHEAD_MS = 31 * 24 * 3600_000;
export const LATER_MAX = 20;
/** The same limit as the page says it. */
export const LATER_MAX_AHEAD_LABEL = "within the next month";
/** A start that never finished (Friday closed in the middle of it) is called failed after this. */
export const STARTING_STUCK_MS = 10 * 60_000;
/** A task due within this long holds off the computer's idle sleep (laterWantsAwake), so the clock is still ticking when it comes. */
export const AWAKE_AHEAD_MS = 3 * 3600_000;
/** What is said when a task's moment passed unstarted: Friday closed, or the computer asleep, look the same from here. */
export const MISSED_NOTE = "Friday wasn't running, or this computer was asleep.";

const MODES: EngineMode[] = ["plan", "edits", "full"];
/** A folder on this computer, written out in full: POSIX, or a Windows drive or network path. */
export const isAbsoluteFolder = (f: string): boolean => /^\//.test(f) || /^[A-Za-z]:[\\/]/.test(f) || /^\\\\[^\\]/.test(f);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** What the clock does with a task at `now`: start it, call it missed, or leave it. Only a queued task is ever due. */
export function laterDue(t: Pick<LaterTask, "status" | "at">, now: number, grace = LATE_GRACE_MS): "run" | "missed" | null {
  if (t.status !== "queued" || now < t.at) return null;
  return now - t.at <= grace ? "run" : "missed";
}

/**
 * Whether this computer should be kept from idle sleep for the tasks waiting: one due within a few hours, or one being started. The
 * desktop app asks this with the team's own reasons (desktop.ts syncAwake). A task already running is held by its run, as any run is.
 */
export function laterWantsAwake(tasks: Pick<LaterTask, "status" | "at">[], now: number, grace = LATE_GRACE_MS): boolean {
  return tasks.some((t) => t.status === "starting" || (t.status === "queued" && t.at <= now + AWAKE_AHEAD_MS && now - t.at <= grace));
}

/** A task as the page sent it, made safe, or why not. Times in the past by a few seconds are fine (Run now sends "now"). */
export function cleanLater(input: Record<string, unknown>, now = Date.now()): { ok: true; task: Omit<LaterTask, "id" | "ownerId" | "ownerName" | "created" | "status"> } | { ok: false; error: string } {
  const folder = str(input.folder, 1000);
  const ask = str(input.ask, 8000);
  if (!folder) return { ok: false, error: "Open a folder first: a task runs in it." };
  if (!isAbsoluteFolder(folder)) return { ok: false, error: "The folder has to be written out in full, from the top (like /Users/you/app or C:\\app)." };
  if (!ask) return { ok: false, error: "Write what it should do first." };
  if (!(ENGINE_TOOLS as string[]).includes(String(input.tool))) return { ok: false, error: "Pick a coding tool first." };
  const at = Number(input.at);
  if (!Number.isFinite(at)) return { ok: false, error: "Pick a time." };
  if (at < now - 60_000) return { ok: false, error: "That time has already gone by." };
  if (at > now + LATER_AHEAD_MS) return { ok: false, error: "Pick a time within the next month." };
  const mode = MODES.includes(input.mode as EngineMode) ? (input.mode as EngineMode) : "full";
  const tool = input.tool as EngineTool;
  const account = str(input.account, 60);
  if (account && !/^[\w.@-]+$/.test(account)) return { ok: false, error: "That account isn't one this computer has." };
  const effort = isEngineEffort(input.effort) && EFFORT_LEVELS[tool]?.includes(input.effort) ? input.effort : undefined;
  const issue = issueRef(input.issue);
  const pr = prRef(input.pr);
  const named = str(input.title, 120);
  return {
    ok: true,
    task: {
      folder,
      ask,
      title: named || ask.split("\n")[0]!.trim().slice(0, 120) || "Task for later",
      tool,
      mode,
      fullAccess: input.fullAccess === true && mode === "full",
      model: str(input.model, 80),
      ...(account && account !== "default" ? { account } : {}),
      ...(effort ? { effort } : {}),
      ...(issue ? { issue } : {}),
      ...(pr ? { pr } : {}),
      at: Math.round(at),
    },
  };
}

// ── Time zones: stored as UTC, shown as the person's own clock ─────────────────────────────────────────────

/** A moment's wall clock in a zone. */
function parts(ms: number, tz: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== "literal") o[p.type] = Number(p.value);
  return { y: o.year!, m: o.month!, d: o.day!, h: o.hour! % 24, mi: o.minute!, s: o.second! };
}

/** How far a zone is ahead of UTC at a moment, in minutes. */
export function offsetAt(ms: number, tz: string): number {
  const p = parts(ms, tz);
  return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000) / 60_000);
}

/**
 * The UTC instant at which a zone's clock reads this date and time (month 1-12; a day or hour past the end rolls over, as a Date's
 * does). A time the clock skips (the hour spring forward takes) lands just after the gap; one it shows twice is the first.
 */
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - offsetAt(guess, tz) * 60_000;
  const second = guess - offsetAt(first, tz) * 60_000;
  // A clock time the zone skips matches neither: the later of the two reads just after the gap.
  const reads = (ms: number) => Date.UTC(...(((p) => [p.y, p.m - 1, p.d, p.h, p.mi] as const)(parts(ms, tz)))) === guess;
  return reads(second) ? second : reads(first) ? first : Math.max(first, second);
}

/** The next time a zone's clock reads `hour`:00, at least a minute from now: "Tonight at 1 AM". */
export function tonightAt(now: number, tz: string, hour = 1): number {
  const p = parts(now, tz);
  const today = zonedToUtc(p.y, p.m, p.d, hour, 0, tz);
  return today - now >= 60_000 ? today : zonedToUtc(p.y, p.m, p.d + 1, hour, 0, tz);
}

/** "In 1 hour". */
export const inAnHour = (now: number): number => now + 3600_000;

/** What a datetime-local field holds ("2026-11-21T09:30", the person's wall clock) as the UTC instant, or null when it is not a time. */
export function pickedToUtc(value: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  return zonedToUtc(y, mo, d, h, mi, tz);
}

/** An instant as a datetime-local field's value in a zone: the field's starting point. */
export function utcToPicked(ms: number, tz: string): string {
  const p = parts(ms, tz);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${String(p.y).padStart(4, "0")}-${two(p.m)}-${two(p.d)}T${two(p.h)}:${two(p.mi)}`;
}

/** Whether an instant is in the night on the person's clock: between nine in the evening and five in the morning. */
export function isNightAt(at: number, tz: string): boolean {
  const h = parts(at, tz).h;
  return h >= 21 || h < 5;
}

/**
 * When, in words, on the person's own clock: "tonight at 1:00 AM", "today at 3:30 PM", "tomorrow at 9:00 AM", "Fri 9:00 AM".
 * "Tonight" is only the coming night: nine in the evening to five in the morning today, and the small hours after the coming midnight
 * (tomorrow's date, from a daytime or evening now). Tomorrow's evening, or the small hours a day after that, is "tomorrow".
 */
export function describeAt(at: number, now: number, tz: string): string {
  const a = parts(at, tz);
  const n = parts(now, tz);
  const days = Math.round((Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(n.y, n.m - 1, n.d)) / 86_400_000);
  const clock = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(at));
  const night = a.h >= 21 || a.h < 5;
  if (night && (days === 0 || (days === 1 && a.h < 5 && n.h >= 5))) return `tonight at ${clock}`;
  if (days === 0) return `today at ${clock}`;
  if (days === 1) return `tomorrow at ${clock}`;
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", ...(days > 6 ? { month: "short", day: "numeric" } : {}) }).format(new Date(at));
  return `${day} ${clock}`;
}

/** How far off a moment is, in words: "in 40 min", "in 5 h", "in 2 days". */
export function countdown(at: number, now: number): string {
  const min = Math.max(1, Math.round((at - now) / 60_000));
  if (min < 60) return `in ${min} min`;
  const h = Math.round(min / 60);
  if (h < 36) return `in ${h} h`;
  return `in ${Math.round(h / 24)} days`;
}
