import type { Redis } from "ioredis";
import { ENGINE_TOOLS, MAIN_LANE, type EngineTool, type SessionEvent } from "./types.js";

/**
 * Tokens, for every agent a workspace runs: Friday's own and the coding tools people bring (Claude Code, Codex, Cursor, Copilot).
 *
 * The meter (metering.ts) is Friday's allowance and counts only Friday's agent, weighted by model. This counts what each tool
 * said it used, as it said it, so one page can show all of them side by side. Tokens, not money: most people run those tools on
 * a subscription, where what they notice is a limit, not a bill.
 *
 * It also keeps "tokens saved": when an agent joins or takes over, Friday hands it what the others already did. What those
 * agents spent getting there is measured; so is what Friday passed on. Saved is the difference, an estimate that redoing the
 * work would have cost about what it cost the first time.
 */

export type UsageTool = "friday" | EngineTool;
export const USAGE_TOOLS: UsageTool[] = ["friday", ...ENGINE_TOOLS];

export interface Tokens {
  /** Read fresh, including what was written to a cache. */
  input: number;
  /** Read back from a cache. */
  cached: number;
  output: number;
}

export interface UsageDay {
  day: string;
  tools: Partial<Record<UsageTool, Tokens & { turns: number }>>;
  carried: { spent: number; sent: number; count: number };
}

export interface CarriedEntry {
  at: number;
  sid: string;
  title: string;
  kind: "catchup" | "handoff";
  to: string;
  from: string[];
  spent: number;
  sent: number;
}

/** The detail (each tool's tokens, what hand-offs carried and the latest hand-offs by title): a hundred days. */
export const KEEP_S = 100 * 86_400;
/**
 * A count of turns per tool per day, and nothing else: no tokens, no titles, nothing said. Kept a year and a bit, for the home
 * screen's graph of the last 52 weeks, which only needs how much happened each day.
 */
export const DAILY_KEEP_S = 400 * 86_400;
const RECENT = 40;
const dayOf = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
/** A day "YYYY-MM-DD" moved by `n` days, on the calendar. */
const shiftDay = (day: string, n: number) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
};
/** The day it is at a time in an IANA time zone, as "YYYY-MM-DD"; UTC for a zone this computer doesn't know, or none. */
export function dayInZone(tz?: string): (t: number) => string {
  let f: Intl.DateTimeFormat;
  try {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz && tz.length <= 64 ? tz : "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    return dayOf;
  }
  return (t) => {
    const p = f.formatToParts(new Date(t));
    const get = (k: string) => p.find((x) => x.type === k)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  };
}
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** A token count as people read it: 950, 12.4k, 3.1M. */
export function shortTokens(t: number): string {
  if (t < 1000) return String(Math.round(t));
  if (t < 1_000_000) return `${(t / 1000).toFixed(t < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(t / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** Roughly how many tokens some text is: about four characters each in English and code. */
export const tokensIn = (text: string) => Math.ceil(text.length / 4);

/**
 * What agents spent before `before` (a seq), as the log has it: Friday's own steps carry `tokens`, a coding tool's turns an
 * `agent.usage`. Only what was counted: a tool from before Friday recorded usage adds nothing. A tool's cache reads are left
 * out: they are its own instructions and tools re-read every turn, cheap, and paid again by any agent whatever it was handed,
 * so counting them made one short session's "saved" three times what the work was.
 */
export function spentBefore(events: SessionEvent[], before: number, include: (e: SessionEvent) => boolean): { tokens: number; by: string[] } {
  let tokens = 0;
  const by = new Set<string>();
  for (const e of events) {
    if (e.seq >= before) break;
    const b = e.body;
    const t = b.type === "agent.usage" ? b.input + b.output : b.type === "agent.message" ? (b.tokens ?? 0) : 0;
    if (!t || !include(e)) continue;
    tokens += t;
    by.add(e.actor.name);
  }
  return { tokens, by: [...by] };
}

/** Where a lane's latest run began, for what a hand-off from it carries: that run's work, not the lane's whole past. */
export function lastRunStart(events: SessionEvent[], lane: string, before: number): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.seq < before && e.body.type === "run.started" && (e.lane ?? MAIN_LANE) === lane) return e.seq;
  }
  return 0;
}

export class ToolUsage {
  constructor(
    private redis: Redis,
    private prefix: string,
  ) {}

  private key(ws: string, d = dayOf()) {
    return `${this.prefix}toolusage:${ws}:${d}`;
  }

  private dailyKey(ws: string, d = dayOf()) {
    return `${this.prefix}tooldays:${ws}:${d}`;
  }

  /** One turn's tokens for a tool. Never throws: a lost count must not cost the work. */
  async record(ws: string, tool: UsageTool, t: Tokens): Promise<void> {
    if (!ws || n(t.input) + n(t.cached) + n(t.output) === 0) return;
    const k = this.key(ws);
    const daily = this.dailyKey(ws);
    try {
      await this.redis
        .multi()
        .hincrby(k, `${tool}:input`, n(t.input))
        .hincrby(k, `${tool}:cached`, n(t.cached))
        .hincrby(k, `${tool}:output`, n(t.output))
        .hincrby(k, `${tool}:turns`, 1)
        .expire(k, KEEP_S)
        .hincrby(daily, tool, 1)
        // And by the hour it came in (UTC), so the year can be told in the person's own days (daily).
        .hincrby(daily, `h:${new Date().getUTCHours()}`, 1)
        .expire(daily, DAILY_KEEP_S)
        .exec();
    } catch {
      // Counting is not the work.
    }
  }

  /** An agent handed what others already did: the day's totals, and the hand-off itself for the list. */
  async carried(ws: string, entry: CarriedEntry): Promise<void> {
    if (!ws || entry.spent <= 0) return;
    const k = this.key(ws, dayOf(entry.at));
    const list = `${this.prefix}carried:${ws}`;
    try {
      await this.redis
        .multi()
        .hincrby(k, "carried:spent", n(entry.spent))
        .hincrby(k, "carried:sent", n(entry.sent))
        .hincrby(k, "carried:count", 1)
        .expire(k, KEEP_S)
        .lpush(list, JSON.stringify(entry))
        .ltrim(list, 0, RECENT - 1)
        .expire(list, KEEP_S)
        .exec();
    } catch {
      // As above.
    }
  }

  /** The last `days` days, oldest first. */
  async history(ws: string, days = 30): Promise<UsageDay[]> {
    const dates = Array.from({ length: days }, (_, i) => dayOf(Date.now() - (days - 1 - i) * 86_400_000));
    const rows = await Promise.all(dates.map((d) => this.redis.hgetall(this.key(ws, d)).catch(() => ({}) as Record<string, string>)));
    return rows.map((h, i) => {
      const tools: UsageDay["tools"] = {};
      for (const tool of USAGE_TOOLS) {
        const get = (f: string) => Number(h[`${tool}:${f}`] ?? 0);
        if (get("turns") || get("input") || get("output")) tools[tool] = { input: get("input"), cached: get("cached"), output: get("output"), turns: get("turns") };
      }
      return { day: dates[i]!, tools, carried: { spent: Number(h["carried:spent"] ?? 0), sent: Number(h["carried:sent"] ?? 0), count: Number(h["carried:count"] ?? 0) } };
    });
  }

  /**
   * Turns each day for the last `days` days in the time zone `tz` (an IANA name; UTC when absent or unknown), oldest first, the
   * last being today there: the daily counts, which outlast the detail. They are kept by UTC day with the hour each turn came
   * in, and each hour is put on the day it was there (2026-10-27 QA: west of UTC, an evening's work landed on tomorrow and the
   * home screen's year showed nothing). A turn counted before the hours were kept, or a day from before the counts were (read
   * from its detail while that is still there), stays on its UTC day.
   */
  async daily(ws: string, days = 371, tz?: string, now = Date.now()): Promise<{ day: string; turns: number }[]> {
    const dayIn = dayInZone(tz);
    const local = Array.from({ length: days }, (_, i) => shiftDay(dayIn(now), i - (days - 1)));
    // The UTC days that hold those: a day either side of them.
    const utc = Array.from({ length: days + 2 }, (_, i) => shiftDay(local[0]!, i - 1));
    const read = (k: string) => this.redis.hgetall(k).catch(() => ({}) as Record<string, string>);
    const counts = await Promise.all(utc.map((d) => read(this.dailyKey(ws, d))));
    const kept = dayOf(now - KEEP_S * 1000);
    const detail = await Promise.all(utc.map((d, i) => (!Object.keys(counts[i]!).length && d >= kept ? read(this.key(ws, d)) : ({} as Record<string, string>))));
    const turns = new Map(local.map((d) => [d, 0]));
    const add = (day: string, n: number) => turns.has(day) && n > 0 && turns.set(day, turns.get(day)! + n);
    utc.forEach((day, i) => {
      const c = counts[i]!;
      const total = Object.keys(c).length ? USAGE_TOOLS.reduce((sum, t) => sum + (Number(c[t]) || 0), 0) : USAGE_TOOLS.reduce((sum, t) => sum + (Number(detail[i]![`${t}:turns`]) || 0), 0);
      let placed = 0;
      for (let h = 0; h < 24; h++) {
        const n = Number(c[`h:${h}`]) || 0;
        if (!n) continue;
        // The middle of the hour: in a zone a half or quarter hour off UTC, an hour spans two of its days, and this is the nearer.
        const [y, m, d] = day.split("-").map(Number);
        add(dayIn(Date.UTC(y!, m! - 1, d!, h, 30)), n);
        placed += n;
      }
      add(day, total - placed);
    });
    return local.map((day) => ({ day, turns: turns.get(day)! }));
  }

  /**
   * The detail kept no longer than a hundred days, whatever it was written with: for a while it was written to last 400, and a
   * shorter limit now doesn't shorten one already set. Run at start; cheap when there is nothing to cap. Returns how many it capped.
   */
  async capDetail(): Promise<number> {
    let capped = 0;
    for (const pattern of [`${this.prefix}toolusage:*`, `${this.prefix}carried:*`]) {
      let cursor = "0";
      do {
        const [next, keys] = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", 500);
        cursor = next;
        for (const k of keys) {
          if ((await this.redis.ttl(k)) > KEEP_S) {
            await this.redis.expire(k, KEEP_S);
            capped++;
          }
        }
      } while (cursor !== "0");
    }
    return capped;
  }

  /** The latest hand-offs, newest first. */
  async recent(ws: string): Promise<CarriedEntry[]> {
    const raw = await this.redis.lrange(`${this.prefix}carried:${ws}`, 0, RECENT - 1).catch(() => [] as string[]);
    return raw.flatMap((r) => {
      try {
        return [JSON.parse(r) as CarriedEntry];
      } catch {
        return [];
      }
    });
  }
}
