import type { Limits } from "../runner/limits.js";
import type { EngineTool } from "../types.js";

/**
 * The coding tools' limits over time, kept on this computer, and what they say about the next few hours.
 *
 * Friday reads each tool's limits every couple of minutes while something shows them (toolLimits.ts). Each reading is kept
 * here, a week of them, so the Usage hub can say how fast a window is being used, when it would run out at that pace, how
 * the week will likely end, and which five-hour windows ran hot. Only percentages and reset times are kept: nothing about
 * what the work was.
 */

/** One limit window of one tool, the same shape for every tool. */
export interface Win {
  tool: EngineTool;
  /** Stable within a tool: "five_hour", "seven_day", "primary"... */
  key: string;
  /** "5h", "Weekly", "Weekly · Opus", "Monthly", or the tool's own name for it. */
  label: string;
  /** Its length when known: 300 is five hours, 10080 a week. */
  minutes: number | null;
  /** 0 to 100. */
  used: number;
  /** Unix seconds, when known. */
  resetsAt: number | null;
}

const CLAUDE: Record<string, { label: string; minutes: number | null }> = {
  five_hour: { label: "5h", minutes: 300 },
  seven_day: { label: "Weekly", minutes: 10_080 },
  seven_day_opus: { label: "Weekly · Opus", minutes: 10_080 },
  seven_day_sonnet: { label: "Weekly · Sonnet", minutes: 10_080 },
};
const nameFor = (minutes: number | null, label?: string) =>
  label ?? (minutes === null ? "Limit" : minutes >= 40_000 ? "Monthly" : minutes >= 10_080 ? "Weekly" : minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${minutes}m`);

/** Every window a reading has, as of `now` (a window whose reset has passed has started over). */
export function windowsOf(limits: Limits | null | "none", now = Date.now()): Win[] {
  if (!limits || limits === "none") return [];
  const out: Win[] = [];
  const add = (w: Win) => out.push(w.resetsAt && w.resetsAt * 1000 <= now ? { ...w, used: 0 } : w);
  for (const w of limits.claudeWindows ?? []) {
    if (w.utilization === null || w.kind === "overage") continue;
    const k = CLAUDE[w.kind ?? ""];
    add({ tool: "claude", key: w.kind ?? "limit", label: w.label ?? k?.label ?? "Limit", minutes: k?.minutes ?? null, used: w.utilization * 100, resetsAt: w.resetsAt });
  }
  const codex = limits.codexWindows?.length ? limits.codexWindows : limits.codex ? [{ kind: "primary", windowMinutes: limits.codex.windowMinutes, usedPercent: limits.codex.usedPercent, resetsAt: limits.codex.resetsAt, at: limits.codex.at }] : [];
  for (const w of codex) if (w.usedPercent !== null) add({ tool: "codex", key: w.kind, label: nameFor(w.windowMinutes), minutes: w.windowMinutes, used: w.usedPercent, resetsAt: w.resetsAt });
  for (const [tool, ws] of [["cursor", limits.cursor?.windows ?? []], ["copilot", limits.copilot?.windows ?? []]] as const)
    for (const w of ws) if (w.usedPercent !== null) add({ tool, key: w.kind || w.label || "limit", label: w.label ?? nameFor(w.windowMinutes), minutes: w.windowMinutes, used: w.usedPercent, resetsAt: w.resetsAt });
  for (const [tool, a] of Object.entries(limits.tools ?? {}))
    for (const w of a?.windows ?? []) if (w.usedPercent !== null) add({ tool: tool as EngineTool, key: w.kind || w.label || "limit", label: nameFor(w.windowMinutes, w.label), minutes: w.windowMinutes, used: w.usedPercent, resetsAt: w.resetsAt });
  return out;
}

export const isFiveHour = (w: Win) => w.minutes === 300 || w.label === "5h";
export const isWeekly = (w: Win) => w.minutes === 10_080 || w.label.startsWith("Weekly");

// ── the readings kept ───────────────────────────────────────────────────

/** One reading of one window: when, how much was used, and which cycle of the window it was in (its reset). */
export interface Sample {
  at: number;
  used: number;
  resetsAt: number | null;
}
/** "claude:five_hour" → its readings, oldest first. */
export type History = Record<string, Sample[]>;

const KEY = "mpa.limitHistory";
const KEEP_MS = 7 * 24 * 3600_000;
/** Readings closer together than this are one reading: a card refreshing doesn't need its own row. */
const MIN_GAP_MS = 60_000;

export const idOf = (w: Pick<Win, "tool" | "key">) => `${w.tool}:${w.key}`;

/** The history with these windows added at `now`, older than a week dropped. Pure, so it is tested without storage. */
export function withReading(h: History, wins: Win[], now = Date.now()): History {
  const out: History = {};
  for (const [id, ss] of Object.entries(h)) {
    const kept = ss.filter((s) => now - s.at < KEEP_MS);
    if (kept.length) out[id] = kept;
  }
  for (const w of wins) {
    const id = idOf(w);
    const ss = out[id] ?? [];
    const last = ss.at(-1);
    const sample = { at: now, used: Math.round(w.used * 10) / 10, resetsAt: w.resetsAt };
    // Within a minute of the last one: replace it, so the newest figure wins without piling up near-duplicates.
    if (last && now - last.at < MIN_GAP_MS) ss[ss.length - 1] = sample;
    else ss.push(sample);
    out[id] = ss;
  }
  return out;
}

export function readHistory(): History {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? "{}") as History) ?? {};
  } catch {
    return {};
  }
}

/** Keep this reading. Called with every fresh reading of the limits (toolLimits.ts). */
export function recordReading(limits: Limits | null | "none", now = Date.now()): History {
  const h = withReading(readHistory(), windowsOf(limits, now), now);
  try {
    localStorage.setItem(KEY, JSON.stringify(h));
  } catch {
    // Storage full or blocked: the forecast just has less to go on.
  }
  return h;
}

// ── what the readings say ───────────────────────────────────────────────

export interface Forecast {
  /** Percentage points an hour, over the last stretch of this cycle. */
  perHour: number;
  /** Where it ends at this pace when the window resets (capped at 100). */
  atReset: number | null;
  /** When it would reach 100% at this pace, if before the reset (ms). */
  fullAt: number | null;
}

/**
 * The pace of a window from its readings in the current cycle: the last hour of them (the last six for a five-hour window),
 * which follows a burst of work without being thrown by one reading. Null until there are two readings ten minutes apart, or
 * while nothing is being used.
 */
export function forecastOf(w: Win, samples: Sample[], now = Date.now()): Forecast | null {
  const cycle = samples.filter((s) => s.resetsAt === w.resetsAt);
  const span = (w.minutes ?? 300) <= 300 ? 60 * 60_000 : 6 * 3600_000;
  const recent = cycle.filter((s) => now - s.at <= span);
  const first = recent[0];
  const last = recent.at(-1);
  if (!first || !last || last.at - first.at < 10 * 60_000) return null;
  const perHour = ((last.used - first.used) / (last.at - first.at)) * 3600_000;
  if (perHour <= 0.05) return { perHour: 0, atReset: w.resetsAt ? Math.round(w.used) : null, fullAt: null };
  const resetMs = w.resetsAt ? w.resetsAt * 1000 : null;
  const hoursLeft = resetMs ? Math.max(0, (resetMs - now) / 3600_000) : null;
  const atReset = hoursLeft === null ? null : Math.min(100, Math.round(w.used + perHour * hoursLeft));
  const fullIn = ((100 - w.used) / perHour) * 3600_000;
  const fullAt = now + fullIn;
  return { perHour, atReset, fullAt: resetMs && fullAt >= resetMs ? null : Math.round(fullAt) };
}

/** A week of five-hour windows for one tool, oldest first: each cycle's highest reading. */
export function cyclesOf(samples: Sample[]): { resetsAt: number; peak: number }[] {
  const by = new Map<number, number>();
  for (const s of samples) if (s.resetsAt) by.set(s.resetsAt, Math.max(by.get(s.resetsAt) ?? 0, s.used));
  return [...by].sort((a, b) => a[0] - b[0]).map(([resetsAt, peak]) => ({ resetsAt, peak }));
}

/** The tool with the most room in its five-hour window, among those whose week isn't nearly spent. */
export function mostRoom(wins: Win[]): { tool: EngineTool; left: number } | null {
  const five = wins.filter(isFiveHour);
  const weekFull = new Set(wins.filter((w) => isWeekly(w) && w.used >= 90).map((w) => w.tool));
  const best = five.filter((w) => !weekFull.has(w.tool)).sort((a, b) => a.used - b.used)[0];
  return five.length > 1 && best ? { tool: best.tool, left: Math.round(100 - best.used) } : null;
}

// ── what each plan costs ────────────────────────────────────────────────

/**
 * Published monthly list prices in US dollars, checked October 2026, matched on the plan name each tool reports. A plan that
 * reads ambiguously (Claude says "Max" for both Max tiers) takes the lower price; every figure can be corrected on the Usage
 * page, and a corrected figure is what is used from then on.
 */
export const PRICES_CHECKED = "October 2026";
const LIST: Partial<Record<EngineTool, [RegExp, number, string][]>> = {
  claude: [[/20x/i, 200, "Max 20×"], [/max/i, 100, "Max"], [/pro/i, 20, "Pro"], [/team/i, 30, "Team"], [/free/i, 0, "Free"]],
  codex: [[/pro/i, 200, "Pro"], [/plus/i, 20, "Plus"], [/team|business/i, 30, "Business"], [/free/i, 0, "Free"]],
  cursor: [[/ultra/i, 200, "Ultra"], [/pro\s*\+|pro_plus|proplus/i, 60, "Pro+"], [/pro/i, 20, "Pro"], [/team|business/i, 40, "Teams"], [/free|hobby/i, 0, "Hobby"]],
  copilot: [[/pro\s*\+|pro_plus|proplus/i, 39, "Pro+"], [/enterprise/i, 39, "Enterprise"], [/business/i, 19, "Business"], [/pro|individual/i, 10, "Pro"], [/free/i, 0, "Free"]],
  gemini: [[/ultra/i, 250, "AI Ultra"], [/pro/i, 20, "AI Pro"], [/free|api/i, 0, "Free"]],
};

/** The list price for a tool's plan, when the plan name matches one. */
export function listPrice(tool: EngineTool, plan: string | null | undefined): { usd: number; tier: string } | null {
  if (!plan) return null;
  const hit = (LIST[tool] ?? []).find(([re]) => re.test(plan));
  return hit ? { usd: hit[1], tier: hit[2] } : null;
}

/** The next cheaper personal tier of a tool, for the right-sizing hint: a team plan is never the way down for one person. */
export function cheaperTier(tool: EngineTool, usd: number): { usd: number; tier: string } | null {
  const tiers = (LIST[tool] ?? []).map(([, p, t]) => ({ usd: p, tier: t })).filter((t) => t.usd > 0 && t.usd < usd && !/team|business|enterprise/i.test(t.tier));
  return tiers.sort((a, b) => b.usd - a.usd)[0] ?? null;
}

/**
 * Whether a plan looks bigger than the work: the week is at least a third gone and, at its pace so far, would end under 40%.
 * Says nothing earlier in the week, or about a plan with no cheaper tier; a hint, never a verdict.
 */
export function rightSize(tool: EngineTool, usd: number, weekly: Win | undefined, now = Date.now()): { usd: number; tier: string; pace: number } | null {
  if (!weekly?.resetsAt || usd <= 0) return null;
  const length = (weekly.minutes ?? 10_080) * 60_000;
  const elapsed = 1 - (weekly.resetsAt * 1000 - now) / length;
  if (elapsed < 1 / 3 || elapsed > 1) return null;
  const pace = Math.round(weekly.used / elapsed);
  const cheaper = cheaperTier(tool, usd);
  return pace < 40 && cheaper ? { ...cheaper, pace } : null;
}

// ── costs you corrected ─────────────────────────────────────────────────

const COSTS = "mpa.planCosts";
export function readCosts(): Partial<Record<EngineTool, number>> {
  try {
    return JSON.parse(localStorage.getItem(COSTS) ?? "{}") as Partial<Record<EngineTool, number>>;
  } catch {
    return {};
  }
}
export function saveCost(tool: EngineTool, usd: number | null): Partial<Record<EngineTool, number>> {
  const c = readCosts();
  if (usd === null || !Number.isFinite(usd) || usd < 0) delete c[tool];
  else c[tool] = Math.round(usd * 100) / 100;
  try {
    localStorage.setItem(COSTS, JSON.stringify(c));
  } catch {
    // Kept for this visit only.
  }
  return c;
}

// ── the 80% alert ───────────────────────────────────────────────────────

const ALERTS = "mpa.limitAlerts";
export const limitAlertsOn = () => {
  try {
    return localStorage.getItem(ALERTS) !== "0";
  } catch {
    return true;
  }
};
export const chooseLimitAlerts = (on: boolean) => {
  try {
    localStorage.setItem(ALERTS, on ? "1" : "0");
  } catch {
    // Kept for this visit only.
  }
};

/** Five-hour windows that crossed 80% between two readings: each one is said once per cycle. */
export function crossedEighty(before: History, wins: Win[]): Win[] {
  return wins.filter((w) => {
    if (!isFiveHour(w) || w.used < 80) return false;
    const prev = before[idOf(w)]?.filter((s) => s.resetsAt === w.resetsAt) ?? [];
    return prev.length > 0 && prev.every((s) => s.used < 80);
  });
}

/**
 * A week of a five-hour window as a heatmap: seven rows of days (today last), twenty-four hours each, every cell the highest
 * the window stood at in that hour (null when Friday wasn't reading). Local time, as people think of their days.
 */
export function weekGrid(samples: Sample[], now = Date.now()): { days: { label: string; hours: (number | null)[] }[]; hits: number; busiest: { day: string; hour: number; used: number } | null } {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (6 - i));
    return { start: d.getTime(), label: i === 6 ? "Today" : d.toLocaleDateString([], { weekday: "short" }), hours: Array<number | null>(24).fill(null) };
  });
  let busiest: { day: string; hour: number; used: number } | null = null;
  for (const s of samples) {
    const di = days.findIndex((d) => s.at >= d.start && s.at < d.start + 24 * 3600_000);
    if (di === -1) continue;
    const h = new Date(s.at).getHours();
    const day = days[di]!;
    day.hours[h] = Math.max(day.hours[h] ?? 0, s.used);
    if (!busiest || s.used > busiest.used) busiest = { day: day.label, hour: h, used: s.used };
  }
  const hits = cyclesOf(samples.filter((s) => s.at >= days[0]!.start)).filter((c) => c.peak >= 90).length;
  return { days: days.map(({ label, hours }) => ({ label, hours })), hits, busiest };
}
