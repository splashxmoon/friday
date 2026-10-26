import { BENCH, benchFor, type Bench } from "./model-bench.js";
import { CORRECTION, learnedSuccess, type Learned } from "./route-learning.js";
import { ENGINE_MODEL_INFO, type EngineEffort, type EngineTool, type RouteTier } from "./types.js";

/**
 * Picking a model from the task.
 *
 * Nothing used to: Friday's agent ran the session's one model on every step, and a coding tool ran the model its lane was
 * started with. Here a task is read for how hard it is (a few words count: a refactor across the codebase is not a typo), and
 * that, with what the run is doing and how much allowance is left, picks the model: Friday for the everyday steps, Friday Pro
 * for the hard parts while its window has room. Every pick comes with why, said in a line and shown at a glance (RouteWhy).
 *
 * Pure: the same task and state always pick the same, so a pick can be explained and tested. Sessions on Auto run what it picks;
 * the rest only log what it would have (`shadow`), which is how its rules get checked against what really happened.
 */

/** The router itself only ever picks low, medium or high; the higher two are a person's pin (`lane.effort`). */
export type Effort = EngineEffort;

/** The model a session picks to have Friday choose for it. */
export const AUTO_MODEL = "auto";
export const isAuto = (id: string | undefined | null): boolean => id === AUTO_MODEL;
/** Friday Pro: the frontier model Auto reaches for. The hosted Friday's; the open-source edition has no Friday models. */
export let FRONTIER_MODEL = "";

const HEAVY: [RegExp, string][] = [
  [/\b(refactor|re-?architect|architecture|redesign|rewrite|restructure)/i, "a refactor"],
  [/\bmigrat(e|ion|ing)\b/i, "a migration"],
  [/\b(race condition|deadlock|memory leak|flaky|intermittent|concurren)/i, "a hard bug"],
  [/\b(root cause|investigate|why\b|debug)/i, "finding a cause"],
  [/\b(performance|optimi[sz]e|slow|latency)\b/i, "performance"],
  [/\b(security|vulnerab|auth(entication|orization)?)\b/i, "security"],
  [/\b(across (the|all|every)|whole (codebase|repo|app)|end[- ]to[- ]end|every (file|module|page))/i, "the whole codebase"],
  [/\b(design|plan out|architect)\b/i, "design"],
];
const LIGHT = /\b(typo|rename|bump|format|lint|wording|reword|spelling|comment|readme|changelog|one[- ]?liner|tiny|small change|quick fix)\b/i;
const PATH = /(?:^|\s)[\w.-]+\/[\w./-]+\.\w{1,5}\b/g;

/**
 * How hard a task reads, and the words of why. Points for what makes work hard (a refactor, a race, the whole codebase, a long
 * brief, a correction after a miss), points off for what makes it small (a typo, a rename, a short note about one file).
 */
export function taskTier(text: string, o: { planFirst?: boolean; attachments?: number; linked?: boolean } = {}): { tier: RouteTier; why: string } {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  let score = 0;
  const reasons: string[] = [];
  const heavy = HEAVY.filter(([re]) => re.test(text)).map(([, why]) => why);
  if (heavy.length) {
    score += Math.min(4, heavy.length * 2);
    reasons.push(...heavy.slice(0, 2));
  }
  if (CORRECTION.test(text)) {
    score += 2;
    reasons.push("a second try");
  }
  if (words > 400) {
    score += 2;
    reasons.push("a long brief");
  } else if (words > 120) score += 1;
  const paths = new Set(text.match(PATH) ?? []).size;
  if (paths >= 3) {
    score += 1;
    reasons.push(`${paths} files named`);
  }
  if (o.planFirst) score += 1;
  if (o.attachments) score += 1;
  if (o.linked) score += 1;
  if (LIGHT.test(text) && words < 40 && !heavy.length) {
    score -= 3;
    reasons.push("a small change");
  } else if (words < 12 && !heavy.length) score -= 1;
  const tier: RouteTier = score >= 3 ? "heavy" : score <= -1 ? "light" : "standard";
  return { tier, why: reasons.length ? reasons.slice(0, 2).join(", ") : tier === "light" ? "a short task" : "an everyday task" };
}

// ── how likely, and at what cost ────────────────────────────────────
//
// Benchmarks measure hard work; easier work fails less. A model's misses on everyday work are taken as about half its misses on
// hard work, and on light work a quarter. Picking then follows what router research keeps finding: rank by the expected cost of a
// correct result, never by price alone, and only among models good enough for the work: within a few points of the best, or
// above a floor for that kind of task. Hard work goes straight to the strongest model; a cheap attempt that fails costs more
// than the strong one would have.
//
// The cost of a correct result is priced as the two tries it may take: the model's own attempt, and, as often as that misses,
// the strongest model's after it. A cheap model that fails a third of the time carries a third of the strong attempt in its
// price. Ranking by price over odds alone would have the same model retried for ever, which nobody does.

const MISS_SHARE: Record<RouteTier, number> = { heavy: 1, standard: 0.55, light: 0.25 };
/** How far behind the best a model may be and still be picked. */
const SLACK: Record<RouteTier, number> = { heavy: 0.04, standard: 0.05, light: 0.08 };
/** Good enough for the work whatever the best can do: an everyday task needs a model that gets it right nine times in ten. */
const FLOOR: Record<RouteTier, number> = { heavy: 0.95, standard: 0.88, light: 0.85 };

/** How likely a model is to get a task of this tier right, from its share of hard tasks solved. */
export const successFor = (solve: number, tier: RouteTier) => 1 - (1 - solve) * MISS_SHARE[tier];

/**
 * Effort, for a tool that takes it per turn (Codex): light work at low, the rest at medium, and high only to think harder after
 * a miss on the strongest model. On coding work the gain above medium is small and the cost steep (about 1.7× a task for a few
 * points), and a stronger model at medium beats a weaker one at high per dollar. The figures below are estimates from the
 * published effort curves, not scores.
 */
const EFFORT_TOOLS = new Set<EngineTool>(["codex"]);
const EFFORT_ADJ: Record<Effort, { solve: number; cost: number }> = { low: { solve: -0.04, cost: 0.6 }, medium: { solve: 0, cost: 1 }, high: { solve: 0.03, cost: 1.7 }, xhigh: { solve: 0.04, cost: 2.4 }, max: { solve: 0.05, cost: 3.2 } };
const effortFor = (tier: RouteTier): Effort => (tier === "light" ? "low" : "medium");

/** A model weighed for a task: how likely it is to get it right, a task's cost on it, and the cost of a correct result. */
export interface ModelFit {
  model: string;
  success: number;
  cost: number;
  /** Expected cost of a correct result: this attempt, and the strongest model's as often as this one misses. */
  ecc: number;
  est: boolean;
  /** Runs of this kind seen on it here (on this repo, when one is known), which moved `success` from the benchmark figure. */
  runs: number;
  /** Can't be picked now (a limit of its own nearly spent), with why. */
  out?: string;
  /** The effort it would run at, for a tool that takes one per turn. */
  effort?: Effort;
  /** Picked to find out: untested here, and cheap enough that its odds at the top of their plausible range would make it the pick. */
  trial?: boolean;
}

/** Each model a tool can be routed to, by its id in the tool, weighed for the task. Empty for a tool Friday has no figures for. */
const ROUTABLE: Partial<Record<EngineTool, string[]>> = {
  claude: ["opus", "sonnet", "haiku", "fable"],
  codex: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"],
};

/** What runs here have shown for a model and tier: for the workspace, and for the repo when one is known. */
const seenOf = (learned: Learned, key: string, repo?: string) => ({ seen: learned[key], local: repo ? learned[`${key}@${repo}`] : undefined });

export function fitModels(tool: EngineTool, tier: RouteTier, windows: ToolWindow[] = [], learned: Learned = {}, o: { repo?: string } = {}): ModelFit[] {
  const effort = EFFORT_TOOLS.has(tool) ? effortFor(tier) : undefined;
  const adj = effort ? EFFORT_ADJ[effort] : EFFORT_ADJ.medium;
  const fits = (ROUTABLE[tool] ?? []).flatMap((model): ModelFit[] => {
    const b = benchFor(tool, model);
    if (!b) return [];
    const { seen, local } = seenOf(learned, `${tool}:${model}:${tier}`, o.repo);
    const success = learnedSuccess(successFor(Math.max(0, b.solve + adj.solve), tier), seen, local);
    // Fable has a weekly limit of its own on Claude's plans (half the week on Max).
    const own = model === "fable" ? usedOf(windows, /fable/i) : -1;
    const runs = o.repo ? (local?.n ?? 0) : (seen?.n ?? 0);
    return [{ model, success, cost: b.cost * adj.cost, ecc: 0, est: !!b.est, runs, ...(effort ? { effort } : {}), ...(own >= 80 ? { out: `its week is ${Math.round(own)}% used` } : {}) }];
  });
  // Priced against the strongest that can be picked: what a miss here costs, after.
  const open = fits.filter((f) => !f.out);
  const strongest = open.length ? open.reduce((a, b) => (b.success > a.success ? b : a)) : null;
  const after = strongest ? strongest.cost / strongest.success : 0;
  for (const f of fits) f.ecc = f.cost + (1 - f.success) * after;
  return fits;
}

/** A chance as the person reads it: whole percent. Two that read the same are the same; nobody should be told 89 beat 90. */
export const shownPct = (p: number) => Math.round(p * 100);

/**
 * How much cheaper a less likely option has to be, per correct result, to be picked over a more likely one: to six tenths of its
 * cost or less. A saving smaller than that isn't worth the lower odds, and a pick that reads as worse needs a clear reason. When
 * nobody is waiting (a scheduled run, a hub's task), eight tenths: a retry costs no one's afternoon.
 */
const VALUE_GAP = 0.6;
const VALUE_GAP_UNATTENDED = 0.8;
const gapFor = (attended?: boolean) => (attended === false ? VALUE_GAP_UNATTENDED : VALUE_GAP);

/**
 * The pick between two options good enough for the work: the more likely to get it right, unless the other reads the same or is
 * clearly cheaper per correct result. `cost` is what to compare them by (the cost of a correct result, made dearer by scarcity).
 */
export function better<T extends { success: number }>(a: T, b: T, cost: (x: T) => number, gap = VALUE_GAP): T {
  const [hi, lo] = shownPct(a.success) >= shownPct(b.success) ? [a, b] : [b, a];
  if (shownPct(hi.success) === shownPct(lo.success)) return cost(lo) < cost(hi) ? lo : hi;
  return cost(lo) <= gap * cost(hi) ? lo : hi;
}

/** Runs seen on a model before its odds are taken as known here; and how wide its odds may plausibly be with fewer. */
const TRIAL_RUNS = 5;
const TRIAL_REACH = 0.08;

/**
 * The pick among weighed models: the most likely to get it right among those good enough, or one nearly as likely for clearly less.
 * One run in five on light work, or when nobody is waiting, a cheaper model barely tried here is picked instead when its odds at
 * the top of their plausible range would make it the pick: that is how routing finds out whether the cheap model is enough on
 * this repo, rather than assuming the benchmark. Never on hard work. The fifth run by count, not a coin, so the pick stays
 * explainable.
 */
export function pickFit(fits: ModelFit[], tier: RouteTier, o: { attended?: boolean } = {}): ModelFit | null {
  const open = fits.filter((f) => !f.out);
  if (!open.length) return null;
  const best = Math.max(...open.map((f) => f.success));
  const goodEnough = (s: number) => s >= best - SLACK[tier] || s >= FLOOR[tier];
  const gap = gapFor(o.attended);
  const pick = open.filter((f) => goodEnough(f.success)).reduce((a, b) => better(a, b, (x) => x.ecc, gap));
  if (tier === "heavy" || (o.attended !== false && tier !== "light")) return pick;
  const total = open.reduce((n, f) => n + f.runs, 0);
  if (total % TRIAL_RUNS !== TRIAL_RUNS - 1) return pick;
  const strongest = open.reduce((a, b) => (b.success > a.success ? b : a));
  const after = strongest.cost / strongest.success;
  const trials = open
    .filter((f) => f !== pick && f.cost < pick.cost && f.runs < TRIAL_RUNS)
    .map((f) => ({ ...f, success: Math.min(1, f.success + TRIAL_REACH / Math.sqrt(f.runs + 1)) }))
    .map((f) => ({ ...f, ecc: f.cost + (1 - f.success) * after }))
    .filter((f) => goodEnough(f.success) && f.ecc < pick.ecc);
  if (!trials.length) return pick;
  const trial = trials.reduce((a, b) => (b.cost < a.cost ? b : a));
  const real = open.find((f) => f.model === trial.model)!;
  return { ...real, trial: true };
}

/** Whether a pick was made for its value: another option reads as likelier to get it right. */
export const forValue = (pick: { success: number }, all: { success: number }[]) => all.some((o) => shownPct(o.success) > shownPct(pick.success));

const pctOf = (p: number) => `${Math.round(p * 100)}%`;

// ── Friday's own agent ──────────────────────────────────────────────

/** How full a window may get before Auto stops reaching for it by itself: the rest is left for picking it by hand. */
const KEEP_BACK = 0.9;

export interface FridayStep {
  tier: RouteTier;
  /** Why the task reads as its tier (taskTier). */
  tierWhy: string;
  /** Steps in a row that only read: the hard thinking is done, and reading needs no frontier model. */
  exploring: number;
  /** Steps in a row whose tools failed. */
  failing: number;
  /** Friday Pro's allowance in this window: whether the plan has it at all, how much of it is spent, and when it starts over. */
  frontier: { allowed: boolean; used: number; limit: number; resetsAt?: number | null };
  /** What runs here have shown (route-learning.ts). */
  learned?: Learned;
  /** The repo this lane is on, for what runs on it have shown. */
  repo?: string;
}

/** What Auto runs for one step of Friday's agent. `model` "" is Friday's own. */
export interface FridayPick {
  model: string;
  effort: Effort;
  why: string;
  /** Friday Pro's share of its window still free, 0 to 1, for the glance; null without it on the plan. */
  frontierLeft: number | null;
}

const EFFORT: Record<RouteTier, Effort> = { light: "low", standard: "medium", heavy: "high" };

/**
 * One step of Friday's agent. Friday Pro gets hard work right far more often than Friday's own model, and costs a window that is
 * small, so it goes where it changes the result: hard work, a run that keeps failing, and everyday work while the window has room
 * to spare (an allowance left unused when the window starts over is worth nothing). Reading the code, and light work, stay on
 * Friday's own. The last tenth of the window is left for picking Pro by hand.
 */
export function routeFriday(s: FridayStep): FridayPick {
  const { allowed, used, limit } = s.frontier;
  const frontierLeft = !allowed ? null : limit >= Number.MAX_SAFE_INTEGER ? 1 : limit > 0 ? Math.max(0, 1 - used / limit) : 0;
  const roomy = frontierLeft !== null && frontierLeft > 1 - KEEP_BACK;
  // Plenty left, or about to start over with some left: spending it now costs nothing later.
  const soon = !!s.frontier.resetsAt && s.frontier.resetsAt - Date.now() < 30 * 60_000;
  const spare = frontierLeft !== null && (frontierLeft >= 0.5 || (soon && frontierLeft >= 0.15));
  const base = BENCH["friday:base"]!;
  const pro = BENCH["friday:pro"]!;
  const likely = (model: string, b: Bench) => {
    const { seen, local } = seenOf(s.learned ?? {}, `friday:${model}:${s.tier}`, s.repo);
    return learnedSuccess(successFor(b.solve, s.tier), seen, local);
  };
  const odds = (model: string, b: Bench) => pctOf(likely(model, b));
  const onBase = (why: string, effort: Effort = EFFORT[s.tier]): FridayPick => ({ model: "", effort, why, frontierLeft });
  const onPro = (why: string, effort: Effort): FridayPick => ({ model: FRONTIER_MODEL, effort, why, frontierLeft });
  if (s.failing >= 2) return roomy ? onPro("its last steps failed", "high") : onBase(allowed ? "its last steps failed; Pro's window is nearly spent" : "its last steps failed", "high");
  if (s.exploring >= 2) return onBase("reading the code", s.tier === "heavy" ? "medium" : EFFORT[s.tier]);
  // Friday's own is enough for hard work only once runs here have shown it is, as good as Pro or above the floor.
  const baseOk = likely("base", base) >= Math.min(FLOOR[s.tier], likely("pro", pro) - SLACK[s.tier]);
  if ((s.tier === "heavy" && !baseOk) || (!baseOk && s.tier === "standard" && spare)) {
    if (roomy) return onPro(`${s.tierWhy} · Pro ${odds("pro", pro)} vs ${odds("base", base)}`, "medium");
    return onBase(allowed ? `${s.tierWhy}; Pro's window is nearly spent` : s.tierWhy);
  }
  return onBase(`${s.tierWhy} · ${odds("base", base)} likely`);
}

// ── coding tools ────────────────────────────────────────────────────

/** One of a tool's limits, as much of it as routing needs. */
export interface ToolWindow {
  kind: string;
  label?: string;
  usedPercent: number | null;
  /** When it starts over, in unix seconds: one about to, with something left, is as good as free. */
  resetsAt?: number | null;
}

const usedOf = (windows: ToolWindow[], re: RegExp) => Math.max(-1, ...windows.filter((w) => re.test(`${w.kind} ${w.label ?? ""}`)).map((w) => w.usedPercent ?? -1));

/**
 * The window an agent is close to the end of: 90% or more used, and not starting over within half an hour. Work handed out goes
 * to an agent with room first, so a long task doesn't start on one about to run out partway (Arun, 2026-10-25). Null with room.
 */
export function nearLimit(windows: ToolWindow[], now = Date.now()): { pct: number; label: string } | null {
  const full = windows
    .filter((w) => w.usedPercent !== null && w.usedPercent >= 90 && !(w.resetsAt && w.resetsAt * 1000 - now < RESET_SOON_MS))
    .sort((a, b) => b.usedPercent! - a.usedPercent!)[0];
  return full ? { pct: Math.min(100, Math.round(full.usedPercent!)), label: full.label || full.kind } : null;
}

/** A window that starts over within half an hour with at least a seventh left: spending it now costs nothing later. */
const RESET_SOON_MS = 30 * 60_000;
const resetsSoon = (w: ToolWindow, now: number) => !!w.resetsAt && w.resetsAt * 1000 - now < RESET_SOON_MS && (w.usedPercent ?? 100) <= 85;

/** Extra words the picker takes: the repo, whether a person is waiting, and the model whose run just missed (routing escalates). */
export interface RouteOpts {
  repo?: string;
  attended?: boolean;
  missedOn?: string | null;
}

const nameOf = (tool: EngineTool, m: string) => ENGINE_MODEL_INFO[tool].find((x) => x.id === m)?.label ?? m;

/**
 * The model a coding tool would run a task on: the cheapest correct result among its models good enough for the work (pickFit), and
 * the words of why. After a miss, one model up from the one that missed, whatever the tier reads; on the strongest already, it
 * thinks harder instead where the tool takes an effort. Null for a tool Friday has no figures for: it picks its own.
 */
export function routeTool(tool: EngineTool, tier: RouteTier, tierWhy: string, windows: ToolWindow[] = [], learned: Learned = {}, o: RouteOpts = {}): { model: string; effort?: Effort; why: string; fit: ModelFit } | null {
  const fits = fitModels(tool, tier, windows, learned, { ...(o.repo ? { repo: o.repo } : {}) });
  const open = fits.filter((f) => !f.out);
  if (!open.length) return null;
  const strongest = open.reduce((a, b) => (b.success > a.success ? b : a));
  const missed = o.missedOn ? open.find((f) => f.model === o.missedOn) : undefined;
  if (missed) {
    const above = open.filter((f) => f.success > missed.success);
    if (above.length) {
      // The pick among those stronger, by the usual rule: the likelier, unless another reads the same or is clearly cheaper.
      const up = above.reduce((a, b) => better(a, b, (x) => x.ecc, gapFor(o.attended)));
      return { model: up.model, ...(up.effort ? { effort: up.effort } : {}), why: `its last run missed on ${nameOf(tool, missed.model)} · ${pctOf(up.success)} likely on ${nameOf(tool, up.model)}`, fit: up };
    }
    const harder = EFFORT_TOOLS.has(tool);
    return { model: missed.model, ...(harder ? { effort: "high" as const } : {}), why: `its last run missed on ${nameOf(tool, missed.model)}, the strongest${harder ? ": thinking harder this time" : " already"}`, fit: missed };
  }
  const pick = pickFit(fits, tier, { ...(o.attended !== undefined ? { attended: o.attended } : {}) });
  if (!pick) return null;
  const effort = pick.effort ? { effort: pick.effort } : {};
  if (pick.trial) {
    const saving = Math.max(1, Math.round(pickFit(fits.filter((f) => f.model !== pick.model), tier, { attended: true })!.cost / Math.max(pick.cost, 0.001)));
    return { model: pick.model, ...effort, why: `${tierWhy} · trying ${nameOf(tool, pick.model)} here: ${pick.runs ? `only ${pick.runs} run${pick.runs === 1 ? "" : "s"}` : "untested"} on this repo, could be ${saving}× cheaper`, fit: pick };
  }
  const why =
    pick === strongest
      ? `${tierWhy} · ${pctOf(pick.success)} likely, the strongest at it`
      : `${tierWhy} · ${pctOf(pick.success)} likely at ${Math.max(1, Math.round(strongest.cost / Math.max(pick.cost, 0.001)))}× less than ${nameOf(tool, strongest.model)}`;
  return { model: pick.model, ...effort, why, fit: pick };
}

/**
 * The model an Auto lane runs its next message on (Phase 3): the pick for the task (routeTool), unless the lane is on another model
 * already and moving would cost more than it saves. A switch leaves the conversation's cache behind, so the new model reads it all
 * again at the price of a cache write, where staying reads it back at a tenth; a kept Claude Code is started again too. Moving up
 * for harder work is always taken: a correct result is the point. Moving down is taken only when the cheaper result, plus that
 * re-read, still comes in under nine tenths of staying. After a miss, the lane goes one up from the model that missed (routeTool).
 */
export function stickyPick(
  tool: EngineTool,
  tier: RouteTier,
  tierWhy: string,
  o: { windows?: ToolWindow[]; learned?: Learned; current?: string | null; contextTokens?: number; repo?: string; attended?: boolean; missed?: boolean } = {},
): { model: string; effort?: Effort; why: string; fit: ModelFit } | null {
  const opts: RouteOpts = { ...(o.repo ? { repo: o.repo } : {}), ...(o.attended !== undefined ? { attended: o.attended } : {}), ...(o.missed && o.current ? { missedOn: o.current } : {}) };
  const r = routeTool(tool, tier, tierWhy, o.windows, o.learned, opts);
  if (!r || !o.current || r.model === o.current || o.missed) return r;
  const cur = fitModels(tool, tier, o.windows, o.learned, { ...(o.repo ? { repo: o.repo } : {}) }).find((f) => f.model === o.current);
  if (!cur || cur.out || r.fit.success > cur.success) return r;
  const ctx = (o.contextTokens ?? 0) / 1e6;
  const switchCost = ctx * (benchFor(tool, r.model)?.inPrice ?? 0) * 1.25;
  const stayCost = ctx * (benchFor(tool, o.current)?.inPrice ?? 0) * 0.1;
  if (r.fit.ecc + switchCost < 0.9 * (cur.ecc + stayCost)) return r;
  return { model: o.current, ...(cur.effort ? { effort: cur.effort } : {}), why: `${tierWhy} · stays on ${nameOf(tool, o.current)}: moving would re-read the conversation for little saving`, fit: cur };
}

/** A coding tool as a candidate for a task: whether it can run here, its limits, and the fullest of them (null when unknown). */
export interface ToolOption {
  tool: EngineTool;
  ready: boolean;
  fullest: number | null;
  windows?: ToolWindow[];
}

export interface ToolRank {
  tool: EngineTool;
  /** Ranked first for its value rather than its odds: another tool reads as likelier to get it right (see `better`). */
  value?: boolean;
  /** The model it would run the task on (routeTool); null for a tool that picks its own. */
  model: string | null;
  /** How likely that model is to get it right; null for a tool Friday has no figures for. */
  success: number | null;
  /** 0 to 1: how much of its fullest limit is free; null when it doesn't say. */
  room: number | null;
  /** Can't take it now: not signed in, or at a limit. */
  out: string | null;
  score: number;
}

/** How much of a tool is free: its windows, the tightest of them, with one about to start over counted as free. */
function roomOf(o: ToolOption, now: number): number | null {
  if (o.windows?.some((w) => w.usedPercent !== null)) {
    return Math.min(...o.windows.filter((w) => w.usedPercent !== null).map((w) => (resetsSoon(w, now) ? 1 : Math.max(0, 1 - (w.usedPercent ?? 0) / 100))));
  }
  return o.fullest === null ? null : Math.max(0, 1 - o.fullest / 100);
}

/**
 * The coding tools in order of fit for a task, each with the model it would take it on. Tools that can't run it come last. Among
 * the rest, those whose model is good enough (as pickFit judges, across tools) come first, ordered by the cost of a correct result,
 * made dearer as a tool's limits fill: a window nearly spent is worth more than one with room, unless it starts over soon. Then
 * tools Friday has no figures for, by room left. A suggestion only: the person picks.
 */
export function rankTools(tier: RouteTier, options: ToolOption[], tierWhy = "", learned: Learned = {}, o: { repo?: string; attended?: boolean; now?: number } = {}): ToolRank[] {
  const now = o.now ?? Date.now();
  const opts: RouteOpts = { ...(o.repo ? { repo: o.repo } : {}), ...(o.attended !== undefined ? { attended: o.attended } : {}) };
  const weighed = options.map((opt) => {
    const room = roomOf(opt, now);
    const out = !opt.ready ? "not set up" : room !== null && room <= 0.1 ? "at its limit" : null;
    const r = out ? null : routeTool(opt.tool, tier, tierWhy, opt.windows, learned, opts);
    return { o: opt, room, out, r };
  });
  const known = weighed.filter((w) => w.r).map((w) => w.r!.fit);
  const best = known.length ? Math.max(...known.map((f) => f.success)) : 0;
  // Scarcer is dearer: the cost of a correct result rises steeply as the tool's fullest window fills.
  const scarce = (room: number | null) => 1 + 3 * Math.pow(1 - (room ?? 0.5), 2);
  const ranked = weighed
    .map(({ o: opt, room, out, r }): ToolRank & { ecc: number; good: boolean } => {
      const good = !!r && (r.fit.success >= best - SLACK[tier] || r.fit.success >= FLOOR[tier]);
      const ecc = r ? r.fit.ecc * scarce(room) : Infinity;
      const score = out ? -1 : good ? 10 - ecc : r ? 5 - ecc + r.fit.success : 2 + (room ?? 0.5);
      return { tool: opt.tool, model: r?.model ?? null, success: r?.fit.success ?? null, room, out, score, ecc, good };
    })
    .sort((a, b) => b.score - a.score);
  // First among the good ones by the same rule as a tool's own models: the likelier, unless another reads the same or is clearly
  // cheaper per correct result. Then say whether it was put first for its value.
  const good = ranked.filter((r): r is typeof r & { success: number } => r.good && !r.out && r.success !== null);
  if (good.length > 1) {
    const top = good.reduce((a, b) => better(a, b, (x) => x.ecc, gapFor(o.attended)));
    ranked.splice(ranked.indexOf(top), 1);
    ranked.unshift(top);
    if (forValue(top, good)) top.value = true;
  }
  return ranked.map(({ ecc: _e, good: _g, ...r }) => r);
}
