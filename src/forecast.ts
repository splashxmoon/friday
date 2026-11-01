import { KEEP_MS } from "./route-learning.js";
import { taskTier, type ToolWindow } from "./routing.js";
import { taskKind, type TaskKind } from "./strengths.js";
import type { RouteTier } from "./types.js";

/**
 * How long a task will take, and how much of a coding tool's usage window it will spend, said before it starts; and when a tool
 * will run out at the rate it is going (Arun, 2026-10-31: Friday as the intelligence layer that plans and routes the work).
 *
 * Every run that ends leaves a record: what ran it (tool, model), how hard the task read and what kind it was, the repo, how long
 * it took, its tokens (input + output) and how it went (route-learning.ts grades it, and revises the grade when an undo, a review
 * or a correction comes later). A forecast is the median of similar runs, shrunk toward the level above when there are few: the
 * repo and kind of task, then the repo, then the workspace, then what a task of that tier typically takes. A first task here gets
 * the tier's typical time and says so.
 *
 * A window's percent is never guessed. Each person's plan is learnt as tokens per percent of the window that moves fastest (the
 * five-hour one, on Claude's plans), from the runner's limit readings: the tokens spent on that sign-in between two readings,
 * over how far the window moved. Until that is known, a forecast is a time only; a tool whose limits can't be read never gets one.
 *
 * Statistics only, no model calls: a capped log per workspace (run-log.ts), read when a task is typed or a turn starts. Pure,
 * so the page computes the same forecast as the server.
 */

/** One finished run, as forecasts and routing's learning read it. */
export interface RunRecord {
  /** When it ended. */
  at: number;
  tool: string;
  /** The model as routing names it ("opus", "gpt-6.1-sol", "base"); "" when routing has no figures for it. */
  model: string;
  tier: RouteTier;
  kind: TaskKind | null;
  repo?: string;
  /** Whose plan it ran on (the lane's host), for a coding tool. */
  host?: string;
  ms: number;
  /** Input + output tokens (cache reads not counted). */
  tokens: number;
  /** About what it cost at the model's price, in dollars (input, and output at five times it). */
  cost: number;
  /** How it went, 0 to 1 (route-learning.ts gradeOf), revised by what came after. */
  grade: number;
  /** The benchmark table it was routed under: learning starts afresh with a new one. */
  asof: string;
}

/** What a task of each tier typically takes, with nothing measured here yet. */
export const TYPICAL_MS: Record<RouteTier, number> = { light: 5 * 60_000, standard: 15 * 60_000, heavy: 40 * 60_000 };
/** How many runs the level above is worth: one run moves a forecast a little, ten stand on their own. */
const PRIOR = 3;

export interface Estimate {
  ms: number;
  /** Null with nothing measured for this tool at this tier. */
  tokens: number | null;
  /** Similar runs it stands on (the most specific level that had any). */
  runs: number;
  /** Where the figure comes from: runs on this repo, runs in the workspace, or the tier's typical time. */
  basis: "repo" | "workspace" | "typical";
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * How long a task will take on `tool` (and `model`, when known), and its tokens, from similar runs: repo and kind, repo, the
 * workspace, then the tier's typical time; each level shrunk toward the one above by PRIOR runs.
 */
export function estimate(records: RunRecord[], q: { tool: string; model?: string; tier: RouteTier; kind?: TaskKind | null; repo?: string }, now = Date.now()): Estimate {
  const same = records.filter((r) => r.tool === q.tool && r.tier === q.tier && now - r.at < KEEP_MS && r.ms > 0);
  // The model's own runs when it has any: Opus and Haiku don't take the same time over the same task.
  const pool = q.model && same.some((r) => r.model === q.model) ? same.filter((r) => r.model === q.model) : same;
  const levels = [pool, q.repo ? pool.filter((r) => r.repo === q.repo) : [], q.repo && q.kind ? pool.filter((r) => r.repo === q.repo && r.kind === q.kind) : []];
  let ms = TYPICAL_MS[q.tier];
  let tokens: number | null = null;
  let above = -1;
  for (const level of levels) {
    // A level with nothing more specific in it than the one above says nothing new: counting it again would overweight it.
    if (!level.length || level.length === above) continue;
    above = level.length;
    const n = level.length;
    ms = (PRIOR * ms + n * median(level.map((r) => r.ms))) / (PRIOR + n);
    const t = median(level.map((r) => r.tokens));
    tokens = tokens === null ? t : (PRIOR * tokens + n * t) / (PRIOR + n);
  }
  const deepest = [...levels].reverse().find((l) => l.length) ?? [];
  const basis = !deepest.length ? "typical" : q.repo && deepest !== levels[0] ? "repo" : "workspace";
  return { ms: Math.round(ms), tokens: tokens === null ? null : Math.round(tokens), runs: deepest.length, basis };
}

/** A time as a forecast reads: "~5 min", "~40 min", "~1.5 h". */
export function aboutTime(ms: number): string {
  const min = ms / 60_000;
  if (min < 1.5) return "~1 min";
  if (min < 10) return `~${Math.round(min)} min`;
  if (min < 55) return `~${Math.round(min / 5) * 5} min`;
  const h = Math.round((min / 60) * 2) / 2;
  return `~${h} h`;
}

const TIER_WORDS: Record<RouteTier, string> = { light: "a small change", standard: "everyday work", heavy: "hard work" };

/**
 * The forecast in a line: "~40 min · about 12% of your Claude window". `pct` only when this plan's tokens per percent is known;
 * a first task here says its time is the typical one.
 */
export function forecastLine(e: Estimate, o: { tier: RouteTier; pct?: number | null; tool?: string; whose?: string }): string {
  const time = e.basis === "typical" ? `${aboutTime(e.ms)}, typical for ${TIER_WORDS[o.tier]}` : aboutTime(e.ms);
  if (o.pct === null || o.pct === undefined || !o.tool) return time;
  const pct = o.pct < 1 ? "under 1%" : `about ${Math.round(o.pct)}%`;
  return `${time} · ${pct} of ${o.whose ?? "your"} ${o.tool} window`;
}

/** The share of a window `tokens` would spend, from a plan's tokens per percent; null when either isn't known. */
export const pctOf = (tokens: number | null, perPct: number | null | undefined): number | null => (tokens === null || !perPct ? null : Math.min(100, tokens / perPct));

// ── burn rate ───────────────────────────────────────────────────────

/** One sign-in's limits, as one thing: two lanes on one plan spend one window. `${tool}|${host}|${account}`. */
export const signInOf = (e: { tool?: string; hostId: string; account?: { id: string } | null } | undefined | null): string | null => (e?.tool ? `${e.tool}|${e.hostId}|${e.account?.id ?? ""}` : null);

/** The lane a reading came from, and whose plan and which tool it is. */
export interface ReadFrom {
  sid: string;
  lane: string;
  host: string;
  tool: string;
}

interface Reading {
  at: number;
  used: number;
}

/** What two readings of a sign-in's limits showed: how far its fastest window moved, and the tokens spent on it between them. */
export interface Moved {
  window: string;
  pct: number;
  tokens: number;
}

/** When a sign-in will run out at the rate it is going, and where it stands now (its last reading carried forward at that rate). */
export interface Burn {
  window: string;
  /** Percent used now, as estimated. */
  used: number;
  /** Percentage points a minute; 0 while it isn't moving. */
  perMin: number;
  /** When it reaches 100% at this rate, if before the window starts over (ms); null when it won't. */
  at: number | null;
}

/** Readings this far apart before a rate is trusted; and how far back a rate looks. */
const MIN_SPAN_MS = 5 * 60_000;
const LOOK_BACK_MS = 90 * 60_000;

/**
 * Each sign-in's limit readings over time, in memory: the runner sends them as a lane opens and after turns (runner.ts
 * shareLimits). A reading lower than the last means the window started over: what came before it is dropped.
 */
export class BurnTracker {
  private readonly readings = new Map<string, Map<string, Reading[]>>();
  private readonly resets = new Map<string, Map<string, number | null>>();
  private readonly spent = new Map<string, number>();
  private readonly label = new Map<string, Map<string, string>>();

  /** Told of each reading a lane's runner sends, with which lane: the app learns the plan's tokens per percent and checks the lane. */
  private readonly listeners = new Set<(moved: Moved | null, from: ReadFrom) => Promise<void> | void>();
  listen(fn: (moved: Moved | null, from: ReadFrom) => Promise<void> | void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Tokens a turn on this sign-in spent (agent.usage), counted toward what the next reading shows. */
  spend(key: string, tokens: number): void {
    if (tokens > 0) this.spent.set(key, (this.spent.get(key) ?? 0) + tokens);
  }

  /** A reading of the sign-in's windows. Returns how far its fastest window moved since the last, with the tokens spent meanwhile. */
  read(key: string, windows: ToolWindow[], now = Date.now(), from?: ReadFrom): Moved | null {
    const byWin = this.readings.get(key) ?? new Map<string, Reading[]>();
    const resets = this.resets.get(key) ?? new Map<string, number | null>();
    const labels = this.label.get(key) ?? new Map<string, string>();
    let moved: Moved | null = null;
    for (const w of windows) {
      if (w.usedPercent === null) continue;
      const id = w.kind || w.label || "limit";
      labels.set(id, w.label || w.kind);
      let rs = byWin.get(id) ?? [];
      const last = rs.at(-1);
      // Started over: a lower reading, or a different reset time.
      if (last && (w.usedPercent < last.used - 0.5 || (w.resetsAt && resets.get(id) && w.resetsAt !== resets.get(id)))) rs = [];
      else if (last && w.usedPercent - last.used > (moved?.pct ?? 0)) moved = { window: id, pct: w.usedPercent - last.used, tokens: 0 };
      resets.set(id, w.resetsAt ?? null);
      rs = [...rs.filter((r) => now - r.at < LOOK_BACK_MS * 2), { at: now, used: w.usedPercent }].slice(-40);
      byWin.set(id, rs);
    }
    this.readings.set(key, byWin);
    this.resets.set(key, resets);
    this.label.set(key, labels);
    const tokens = this.spent.get(key) ?? 0;
    this.spent.set(key, 0);
    const out = moved ? { ...moved, tokens } : null;
    if (from) for (const fn of this.listeners) void Promise.resolve(fn(out, from)).catch((e) => console.error("[forecast] reading:", e));
    return out;
  }

  /** The window that runs out first at the rate it is going, or the fullest when none is moving; null with no readings. */
  burn(key: string, now = Date.now()): Burn | null {
    const byWin = this.readings.get(key);
    if (!byWin) return null;
    let best: Burn | null = null;
    for (const [id, rs] of byWin) {
      const last = rs.at(-1);
      if (!last) continue;
      const recent = rs.filter((r) => last.at - r.at <= LOOK_BACK_MS);
      const first = recent[0]!;
      const span = last.at - first.at;
      const perMin = span >= MIN_SPAN_MS && last.used > first.used ? (last.used - first.used) / (span / 60_000) : 0;
      const used = Math.min(100, last.used + perMin * ((now - last.at) / 60_000));
      const reset = this.resets.get(key)?.get(id);
      let at = perMin > 0 ? last.at + ((100 - last.used) / perMin) * 60_000 : null;
      if (at !== null && reset && at >= reset * 1000) at = null;
      const label = this.label.get(key)?.get(id) ?? id;
      const b: Burn = { window: label, used, perMin, at };
      if (!best || (b.at !== null && (best.at === null || b.at < best.at)) || (b.at === null && best.at === null && b.used > best.used)) best = b;
    }
    return best;
  }
}

/** The one tracker the server keeps: every lane's runner readings go here (engine/hub.ts), every turn's tokens too (app.ts). */
export const burn = new BurnTracker();

// ── acting before the limit ─────────────────────────────────────────

/**
 * Whether the next queued task should go to another agent before this one runs out, and why in words; null to leave it.
 * Either the window runs out at this rate before the current turn and the next task would both be done, or it is already so
 * full that the next task won't fit (its own share, when known, else five points).
 */
export function aheadOfLimit(b: Burn | null, o: { now: number; runEndsAt: number; nextMs: number; nextPct: number | null }): string | null {
  if (!b) return null;
  const finish = Math.max(o.runEndsAt, o.now) + o.nextMs;
  // In minutes from now, not a clock time: the server's clock isn't the reader's zone.
  if (b.at !== null && b.at > o.now && b.at < finish) return `is heading for its ${b.window} limit in ${aboutTime(b.at - o.now).replace("~", "about ")}, before its next task would be done`;
  if (b.used + (o.nextPct ?? 5) >= 100) return `has ${Math.max(0, Math.round(100 - b.used))}% of its ${b.window} limit left, too little for its next task`;
  return null;
}

/** What a task reads as, for its forecast and its record: tier and kind. */
export function taskOf(text: string): { tier: RouteTier; kind: TaskKind | null } {
  return { tier: taskTier(text).tier, kind: taskKind(text) };
}
