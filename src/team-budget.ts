import { shortTokens } from "./tool-usage.js";
import { MAIN_LANE, type SessionEvent, type TeamBrief } from "./types.js";

/**
 * Budgets and work hours for Crew teammates, and a budget for a room running on its own (Arun, 2026-10-31: picked as the top Crew
 * feature, so that "Run on its own" and Away mode are safe to leave running overnight or all weekend).
 *
 * - A teammate's daily cap, in tokens and/or dollars (where its model's price is known), and optionally "stop at N% of my plan's
 *   usage window" for a coding tool that says its limits. A day is its keeper's, in their time zone, as check-ins are.
 * - Its work hours and quiet hours, in the same time zone.
 * - A room running on its own: a budget for the run (tokens since it started) and an end time. A run gets a default overnight
 *   budget, which the person can change; nothing else is capped unless set.
 *
 * Held, a teammate finishes the turn it is on (nothing is cut mid-edit) and takes no new one: what is queued for it waits (the
 * hub's teamWaits, through EngineHub.teamPaused, the hook Pause already uses), it says why once in a line where the work waits,
 * the brief records it, and it carries on at the next window or the next day (the re-pump wakes it). A message from the person
 * still runs: they asked for it.
 *
 * Tokens are counted as everywhere else in Friday: read fresh and written, not cache reads (tool-usage.ts, ca454705).
 *
 * No Node in here: the page reads the rules and the lines too (TeammateBudget.tsx, team-status.ts).
 */

/** A teammate's budget and hours: all optional, nothing capped unless set. */
export interface MateBudget {
  /** An IANA zone: the keeper's own, where its days and hours are. */
  tz: string;
  /** Tokens a day, read fresh and written. */
  tokens?: number;
  /** Dollars a day, at its model's list price; counted only where that price is known (priceOf). */
  usd?: number;
  /** Stop at this percent of its plan's usage window (the five-hour or the week), for a tool that says them. */
  planPct?: number;
  /** When it works: HH:MM to HH:MM on these days (0 = Sunday); a window past midnight belongs to the day it starts. */
  hours?: { from: string; to: string; days: number[] };
  /** When it never works, every day: HH:MM to HH:MM, often past midnight. */
  quiet?: { from: string; to: string };
}

/** A room's run on its own (team-selfrun.ts SelfRun.budget): tokens for the whole run, and when it ends at the latest. */
export interface RunBudget {
  tokens?: number;
  /** Ms. */
  until?: number;
  /** The zone it was set in, to say the end time in. */
  tz?: string;
}

/** What a run on its own gets unless the person says otherwise: enough for a night's work, not a month's. */
export const DEFAULT_RUN_TOKENS = 5_000_000;
/** The caps the page offers for a run, in tokens. */
export const RUN_BUDGETS = [1_000_000, 2_000_000, 5_000_000, 10_000_000, 25_000_000] as const;

export type HoldWhy = "quiet" | "hours" | "tokens" | "usd" | "plan";

/** Why a teammate takes no new turn now, and when it carries on (null: not by itself, its hours never open). */
export interface Hold {
  why: HoldWhy;
  until: number | null;
  /** What it spent toward the cap it reached, and the cap: tokens, dollars or percent. */
  spent?: number;
  cap?: number;
}

/** The event that says it, in the room where its work waits, naming its lane there, as a tool switch is said (types.ts "team.budget"). */
export type BudgetEvent = { type: "team.budget"; name: string; lane: string; why: HoldWhy; until: number | null; text: string };

// ── Checking what the page sent ──────────────────────────────────────────────────────────────────────────────────────────────

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const zoneOr = (v: unknown, or = "UTC"): string => {
  try {
    if (typeof v === "string" && v.length <= 64) return (new Intl.DateTimeFormat("en-US", { timeZone: v }), v);
  } catch {
    // Not a zone this computer knows.
  }
  return or;
};

/** A teammate's budget as the page sent it, checked: null when nothing is set (or it is cleared). Throws with what is wrong. */
export function cleanBudget(v: unknown): MateBudget | null {
  if (!v || typeof v !== "object") return null;
  const b = v as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : undefined);
  const tokens = num(b.tokens) && Math.round(Math.min(num(b.tokens)!, 1e11));
  const usd = num(b.usd) && Math.round(Math.min(num(b.usd)!, 100_000) * 100) / 100;
  const planPct = num(b.planPct) && Math.round(Math.min(Math.max(num(b.planPct)!, 10), 100));
  const win = (x: unknown) => {
    if (!x || typeof x !== "object") return null;
    const w = x as Record<string, unknown>;
    if (typeof w.from !== "string" || typeof w.to !== "string" || !HHMM.test(w.from) || !HHMM.test(w.to)) throw new Error("Give its hours as times, like 09:00 to 18:00.");
    if (w.from === w.to) throw new Error("Its hours start and end at the same time: pick two different times.");
    return { from: w.from, to: w.to };
  };
  const h = win(b.hours);
  const days = h ? [...new Set((Array.isArray((b.hours as { days?: unknown }).days) ? (b.hours as { days: unknown[] }).days : []).filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6))].sort() : [];
  if (h && !days.length) throw new Error("Pick at least one day it works.");
  const quiet = win(b.quiet);
  if (!tokens && !usd && !planPct && !h && !quiet) return null;
  return { tz: zoneOr(b.tz), ...(tokens ? { tokens } : {}), ...(usd ? { usd } : {}), ...(planPct ? { planPct } : {}), ...(h ? { hours: { ...h, days } } : {}), ...(quiet ? { quiet } : {}) };
}

/** A teammate's budget from an edit's body: said (set, or cleared with null), or nothing when the edit didn't touch it. */
export const budgetPatch = (body: Record<string, unknown>): { budget?: MateBudget } => ("budget" in body ? { budget: cleanBudget(body.budget) ?? undefined } : {});

/** A run's budget as the page sent it, checked: the default overnight budget when none was said; `tokens: 0` is none. */
export function cleanRunBudget(v: unknown, now = Date.now()): RunBudget {
  const b = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const tokens = typeof b.tokens === "number" && Number.isFinite(b.tokens) && b.tokens >= 0 ? Math.round(Math.min(b.tokens, 1e11)) : DEFAULT_RUN_TOKENS;
  const until = typeof b.until === "number" && Number.isFinite(b.until) ? b.until : undefined;
  if (until !== undefined && (until <= now || until > now + 14 * 86_400_000)) throw new Error("Pick an end time in the next two weeks.");
  return { ...(tokens ? { tokens } : {}), ...(until ? { until } : {}), tz: zoneOr(b.tz) };
}

// ── Time in the keeper's zone ────────────────────────────────────────────────────────────────────────────────────────────────

const formats = new Map<string, Intl.DateTimeFormat>();
/** The day of the week (0 = Sunday), minute of the day and second, at `ts` in `tz`. */
function localAt(tz: string, ts: number): { day: number; minutes: number; seconds: number } {
  let f = formats.get(tz);
  if (!f) formats.set(tz, (f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" })));
  const parts = f.formatToParts(new Date(ts));
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "0";
  const hh = Number(get("hour")) % 24;
  return { day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")), minutes: hh * 60 + Number(get("minute")), seconds: Number(get("second")) };
}

const minOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** When the day `ts` is in began, in `tz` (its local midnight). */
export function dayStart(tz: string, ts: number): number {
  const p = localAt(tz, ts);
  const at = ts - (p.minutes * 60 + p.seconds) * 1000 - (ts % 1000);
  // On a day the clocks change, that lands an hour off midnight: put right by what the clock reads there.
  const q = localAt(tz, at).minutes;
  return q ? at + (q >= 720 ? 1440 - q : -q) * 60_000 : at;
}

/** When the next day begins in `tz`: a day of 23 or 25 hours (the clocks changing) is still one day. */
export const nextDayStart = (tz: string, ts: number) => dayStart(tz, dayStart(tz, ts) + 26 * 3_600_000);

/** Whether `minutes` (of the day) is inside from–to; a window past midnight wraps. */
const inside = (minutes: number, from: string, to: string) => {
  const a = minOf(from);
  const z = minOf(to);
  return a < z ? minutes >= a && minutes < z : minutes >= a || minutes < z;
};

/** Why the hours keep a teammate still at `ts`, or null when it may work then. */
function hoursHold(b: MateBudget, ts: number): "quiet" | "hours" | null {
  if (!b.quiet && !b.hours) return null;
  const p = localAt(b.tz, ts);
  if (b.quiet && inside(p.minutes, b.quiet.from, b.quiet.to)) return "quiet";
  if (b.hours) {
    if (!inside(p.minutes, b.hours.from, b.hours.to)) return "hours";
    // The early part of a window past midnight is the day before's.
    const day = minOf(b.hours.from) > minOf(b.hours.to) && p.minutes < minOf(b.hours.to) ? (p.day + 6) % 7 : p.day;
    if (!b.hours.days.includes(day)) return "hours";
  }
  return null;
}

/** The first minute from `now` its hours let it work, within eight days; null when they never do. */
function hoursOpen(b: MateBudget, now: number): number | null {
  const start = now - (now % 60_000);
  const STEP = 15 * 60_000;
  for (let t = start + 60_000, k = 0; k < (8 * 86_400_000) / STEP; t += STEP, k++) {
    if (hoursHold(b, t)) continue;
    // Back to the first open minute in the last step.
    let at = t;
    while (at - 60_000 > now && !hoursHold(b, at - 60_000)) at -= 60_000;
    return at;
  }
  return null;
}

// ── What it spent ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Read fresh and written on `lane` from `from` (ms) on: what its tools said (agent.usage), and Friday's own steps' tokens. What a
 * turn read back from its cache counts at a tenth, as it is priced: on a long conversation it is most of what a plan's usage
 * goes on, and left out, a budget let through far more than it said (2026-10-31: usage).
 */
export function spentOn(events: readonly SessionEvent[], lane: string, from: number): { input: number; output: number } {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid]!.ts < from) lo = mid + 1;
    else hi = mid;
  }
  let input = 0;
  let output = 0;
  for (let i = lo; i < events.length; i++) {
    const e = events[i]!;
    if ((e.lane ?? MAIN_LANE) !== lane) continue;
    const b = e.body;
    if (b.type === "agent.usage") (input += (b.input ?? 0) + Math.round((b.cached ?? 0) / 10)), (output += b.output ?? 0);
    else if (b.type === "agent.message") input += b.tokens ?? 0;
  }
  return { input, output };
}

/**
 * Dollars per million tokens, in and out, of the models Friday knows a list price for: Anthropic's API prices (as of
 * 2026-11-09), by Claude Code's aliases and ids. On a subscription this is what the work would have cost on the API, the only
 * dollar figure there is. Smart routing, a tool's own default and every other tool: not known, so no dollar cap applies.
 */
const PRICES: Record<string, [number, number]> = {
  fable: [8, 40],
  "claude-fable-5-2": [8, 40],
  "claude-fable-5-1": [10, 50],
  "claude-fable-5": [10, 50],
  opus: [4, 20],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  sonnet: [2, 10],
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  haiku: [0.1, 0.5],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-haiku-4-5": [1, 5],
};
export const priceOf = (t: { tool: string; model?: string }): [number, number] | null => (t.tool === "claude" && t.model ? (PRICES[t.model] ?? null) : null);
export const dollarsOf = (s: { input: number; output: number }, price: [number, number]) => (s.input * price[0] + s.output * price[1]) / 1e6;

/** A usage window of its tool as its runner last read it (routing.ts ToolWindow): percent used, and when it starts over (s). */
export interface PlanWindow {
  kind: string;
  label?: string;
  usedPercent: number | null;
  resetsAt?: number | null;
}

// ── The rules ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Why a teammate takes no new turn at `now`, or null. Its hours first (they say when it carries on), then its caps: tokens and
 * dollars spent today, and its plan's window. `spent`: what it used today, everywhere it works.
 */
export function holdOf(b: MateBudget | undefined, now: number, spent: { input: number; output: number }, price: [number, number] | null, windows: readonly PlanWindow[] = []): Hold | null {
  if (!b) return null;
  const h = hoursHold(b, now);
  if (h) return { why: h, until: hoursOpen(b, now) };
  // Over a cap for the day: on again tomorrow, or later when its hours say so.
  const tomorrow = () => {
    const next = nextDayStart(b.tz, now);
    return hoursHold(b, next) ? hoursOpen(b, next) : next;
  };
  const tokens = spent.input + spent.output;
  if (b.tokens && tokens >= b.tokens) return { why: "tokens", until: tomorrow(), spent: tokens, cap: b.tokens };
  if (b.usd && price) {
    const usd = dollarsOf(spent, price);
    if (usd >= b.usd) return { why: "usd", until: tomorrow(), spent: Math.round(usd * 100) / 100, cap: b.usd };
  }
  if (b.planPct) {
    const over = windows.filter((w) => w.usedPercent !== null && w.usedPercent >= b.planPct!).sort((x, y) => (y.resetsAt ?? Infinity) - (x.resetsAt ?? Infinity))[0];
    if (over) return { why: "plan", until: over.resetsAt ? over.resetsAt * 1000 : null, spent: Math.round(over.usedPercent!), cap: b.planPct };
  }
  return null;
}

/** "8:00 AM", or "Mon 9:00 AM" when it isn't today, in `tz` (or this computer's zone). */
export function clockIn(ts: number, tz?: string, now = Date.now()): string {
  const opts = { ...(tz ? { timeZone: tz } : {}) };
  const day = (x: number) => new Date(x).toLocaleDateString("en-US", { ...opts, year: "numeric", month: "numeric", day: "numeric" });
  return new Date(ts).toLocaleString("en-US", { ...opts, ...(day(ts) === day(now) ? {} : { weekday: "short" }), hour: "numeric", minute: "2-digit" });
}

/** The teammate's status line while held: "Paused till 8:00 AM · quiet hours", "Daily budget reached · back at 12:00 AM". */
export function holdLine(h: Hold, clock: (ts: number) => string = (ts) => clockIn(ts)): string {
  const at = h.until ? clock(h.until) : "";
  if (h.why === "quiet") return at ? `Paused till ${at} · quiet hours` : "Paused · quiet hours";
  if (h.why === "hours") return at ? `Paused till ${at} · outside its work hours` : "Paused · outside its work hours";
  if (h.why === "plan") return `At ${h.spent}% of its plan's window${at ? ` · back at ${at}` : ""}`;
  return `Daily budget reached${at ? ` · back at ${at}` : ""}`;
}

/** What it says in the room, once, as it stops: why, that its queue is kept, and when it carries on. */
export function holdText(name: string, h: Hold, clock: (ts: number) => string): string {
  const when = h.until ? `It carries on at ${clock(h.until)}.` : "It carries on when its hours are changed.";
  const why =
    h.why === "quiet"
      ? "its quiet hours have started"
      : h.why === "hours"
        ? "it is outside its work hours"
        : h.why === "plan"
          ? `its plan's usage window is at ${h.spent}%, past the ${h.cap}% it stops at`
          : h.why === "usd"
            ? `its daily budget of $${h.cap} is spent ($${h.spent} today at list price)`
            : `its daily budget of ${shortTokens(h.cap ?? 0)} tokens is spent (${shortTokens(h.spent ?? 0)} today)`;
  return `${name} stops for now: ${why}. What's queued for it is kept. ${when}`;
}

/** The run's caps in words, for the card: "5M tokens, until 7:00 AM". */
export function runBudgetLine(b: RunBudget | undefined): string {
  if (!b || (!b.tokens && !b.until)) return "No budget";
  return [b.tokens ? `${shortTokens(b.tokens)} tokens` : "", b.until ? `until ${clockIn(b.until, b.tz)}` : ""].filter(Boolean).join(", ");
}

/** Why a room running on its own stops now for its budget or end time, or null. `lanes`: the room's teammates' lanes. */
export function runOver(run: { since: number; budget?: RunBudget }, events: readonly SessionEvent[], lanes: readonly string[], now = Date.now()): string | null {
  const b = run.budget;
  if (!b) return null;
  if (b.until && now >= b.until) return `Its end time came (${clockIn(b.until, b.tz, now)}).`;
  if (b.tokens) {
    const spent = runSpent(events, lanes, run.since);
    if (spent >= b.tokens) return `Its budget is spent: ${shortTokens(spent)} of ${shortTokens(b.tokens)} tokens.`;
  }
  return null;
}

/** Tokens the room's teammates spent since the run started. */
export const runSpent = (events: readonly SessionEvent[], lanes: readonly string[], since: number) =>
  lanes.reduce((n, l) => {
    const s = spentOn(events, l, since);
    return n + s.input + s.output;
  }, 0);

/** The stops a stretch's brief records: each teammate held by its budget or hours, and a run stopped by its own (team-away.ts). */
export function budgetStops(events: readonly SessionEvent[], nameOf: (lane: string) => { lane: string; name: string } | undefined, since: number, until: number, sid?: string): NonNullable<TeamBrief["stops"]> {
  const out: NonNullable<TeamBrief["stops"]> = [];
  for (const e of events) {
    if (e.ts < since || e.ts > until) continue;
    const b = e.body;
    if (b.type === "team.budget") {
      const m = nameOf(b.lane);
      if (m) out.push({ lane: m.lane, name: m.name, text: b.text, seq: e.seq, ...(sid ? { sid } : {}) });
    } else if (b.type === "team.selfrun" && !b.on && b.budget) out.push({ name: "Run on its own", text: `Stopped. ${b.why ?? ""}`.trim(), seq: e.seq, ...(sid ? { sid } : {}) });
  }
  return out;
}

// ── Keeping it, for either edition ───────────────────────────────────────────────────────────────────────────────────────────

/** A teammate as the rules read it. */
export interface BudgetMate {
  id: string;
  name: string;
  tool: string;
  model?: string;
  budget?: MateBudget;
}

/**
 * The rules applied for an edition: how a teammate stands now, read from its lanes everywhere it works, and the hub's gate, which
 * says why in the room once a window.
 */
export class CrewBudget {
  constructor(
    private d: {
      events: (sid: string) => Promise<readonly SessionEvent[]>;
      /** Its tool's usage windows on that lane, as its runner last read them (EngineHub.usage). */
      windows?: (sid: string, lane: string) => readonly PlanWindow[];
      /** Claims a key once (Redis SET NX, a couple of days): false when it was already claimed. */
      claim: (key: string) => Promise<boolean>;
      /** Writes the line in the room, as Friday. */
      say: (sid: string, body: BudgetEvent) => Promise<unknown>;
    },
  ) {}

  /** How `t` stands now across `places` (each place's session and its lane there): null when nothing holds it. */
  async hold(t: BudgetMate, places: readonly { sid: string; lane: string }[], now = Date.now()): Promise<Hold | null> {
    const b = t.budget;
    if (!b) return null;
    // Hours alone need no log read; today's spend is read from today's events only (spentOn), in logs kept in memory.
    let hold = holdOf({ tz: b.tz, ...(b.hours ? { hours: b.hours } : {}), ...(b.quiet ? { quiet: b.quiet } : {}) }, now, { input: 0, output: 0 }, null);
    if (!hold && (b.tokens || b.usd || b.planPct)) {
      const from = dayStart(b.tz, now);
      const spent = { input: 0, output: 0 };
      const windows: PlanWindow[] = [];
      for (const p of places) {
        const s = spentOn(await this.d.events(p.sid).catch(() => []), p.lane, from);
        spent.input += s.input;
        spent.output += s.output;
        if (b.planPct) windows.push(...(this.d.windows?.(p.sid, p.lane) ?? []));
      }
      hold = holdOf(b, now, spent, priceOf(t), windows);
    }
    return hold;
  }

  /**
   * The hub's gate for a teammate's lane with work waiting (EngineHub.teamPaused): whether it waits, and when it starts to, the
   * line in the room that says why, once for each place and window.
   */
  async gate(t: BudgetMate, places: readonly { sid: string; lane: string }[], sid: string, lane: string, now = Date.now()): Promise<boolean> {
    const h = await this.hold(t, places, now);
    if (!h) return false;
    const window = h.why === "tokens" || h.why === "usd" ? `day:${dayStart(t.budget!.tz, now)}` : `${h.why}:${h.until ?? "never"}`;
    if (await this.d.claim(`${t.id}:${sid}:${lane}:${window}`).catch(() => false))
      await this.d.say(sid, { type: "team.budget", name: t.name, lane, why: h.why, until: h.until, text: holdText(t.name, h, (ts) => clockIn(ts, t.budget!.tz, now)) }).catch(() => undefined);
    return true;
  }
}
