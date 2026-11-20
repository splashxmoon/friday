import { aboutTime, taskOf, type Burn } from "./forecast.js";
import type { Learned } from "./route-learning.js";
import { rankTools, type ToolOption, type ToolWindow } from "./routing.js";
import { ENGINE_NAMES, type EngineTool } from "./types.js";

/**
 * Usage-aware routing in Code (Arun, 2026-11-20, wave 5: "Friday picks the coding tool for a Code chat by what's left on each plan,
 * and hands on before a limit stops the work"). Two things, both pure so they can be read and tested from the numbers alone:
 *
 * - Auto in the composer's tool picker (`autoPick`): the tool with the most room left on the person's own plans for this kind of
 *   task, from routing.ts's own ranking (room left, how well each tool takes the work, what it costs), with one line saying why.
 *   Opt-in: the picker keeps the person's last pick until they choose Auto.
 * - The slim bar in a running chat's column (`limitBar`): its tool is predicted to run out mid-task (forecast.ts's burn rate, as
 *   limit-ahead.ts reads it), with who could take the work now.
 *
 * Account safety (Arun, 2026-10-27: "i do not want my account banned"): only other tools are ever offered, each on the person's own
 * plan on their own computer. Never the same tool on another sign-in, and Friday reads only the usage numbers the runner already
 * reports, never a tool's token.
 */

/** A window as people name it: "5h" is the five-hour window, "Weekly" the week's. */
export function windowWords(label: string | undefined, kind?: string): string {
  // The kind says it best ("five_hour"), the label as the tool names it ("Session", "5h", "Weekly · Opus").
  for (const l of [kind, label].map((x) => (x ?? "").trim()).filter(Boolean)) {
    if (/^(5h|five[_ -]?hour|5[- ]hour|session)/i.test(l)) return "5-hour window";
    if (/^(week|7d|seven[_ -]?day)/i.test(l)) return "weekly limit";
    if (/^month/i.test(l)) return "monthly limit";
  }
  const l = (label || kind || "").trim();
  return l ? `${l} limit` : "limit";
}

/** The fullest of a tool's windows, as a figure and in words; null when none has a reading. */
export function fullestOf(windows: ToolWindow[] | undefined): { used: number; words: string } | null {
  const w = (windows ?? []).filter((x) => x.usedPercent !== null).sort((a, b) => b.usedPercent! - a.usedPercent!)[0];
  return w ? { used: Math.max(0, Math.min(100, Math.round(w.usedPercent!))), words: windowWords(w.label, w.kind) } : null;
}

export interface AutoPick {
  tool: EngineTool;
  /** One line under the picker: "Codex: Claude Code is at 92% of its 5-hour window". */
  why: string;
}

/** A person's usual tool is passed over only for one with this much more room (percentage points of its fullest window). */
const MARGIN = 10;
/** Past this much used, the usual tool gives way to one with no reading yet. */
const HIGH = 80;

/**
 * The tool Auto picks for a task, from the tools ready on this computer with each one's windows: null with none ready.
 *
 * `usual` is the tool the picker would otherwise start on (the person's last pick). It is kept unless it is out of room or another
 * tool has clearly more (`MARGIN`), so the pick doesn't flip between two tools with about the same room as the words are typed.
 */
export function autoPick(o: { ready: ToolOption[]; text?: string; usual?: EngineTool | ""; learned?: Learned; now?: number }): AutoPick | null {
  const now = o.now ?? Date.now();
  const text = o.text?.trim() ?? "";
  const read = text ? taskOf(text) : { tier: "standard" as const, kind: null };
  const tier = read.tier;
  const kind = read.kind;
  const ranked = rankTools(tier, o.ready, "", o.learned ?? {}, { now, ...(kind ? { kind } : {}) }).filter((r) => !r.out);
  const by = (t: EngineTool) => o.ready.find((x) => x.tool === t);
  const top = ranked[0];
  // Every tool is at its limit: nothing to move to, so the person's own stays and the line says why.
  if (!top) {
    const keep = o.usual && by(o.usual) ? o.usual : o.ready[0]?.tool;
    return keep ? { tool: keep, why: "Every tool is at its limit, so nothing to switch to" } : null;
  }
  const usual = o.usual ? ranked.find((r) => r.tool === o.usual) : undefined;
  // Kept when the usual tool is about as good: its room (a window about to start over counts as all free) within the margin of
  // the best's, or when either is not known.
  let pick = top;
  if (usual && usual !== top) {
    if (usual.room === null || top.room === null || (top.room - usual.room) * 100 < MARGIN) pick = usual;
  }
  // A usual tool well past the high mark is not kept for a tool nobody has read yet: it may well have more room (2026-11-20 review).
  const usualUsed = o.usual ? fullestOf(by(o.usual)?.windows)?.used ?? 0 : 0;
  if (pick === usual && usualUsed >= HIGH) {
    const fresh = ranked.find((r) => r.tool !== o.usual && !fullestOf(by(r.tool)?.windows));
    if (fresh) pick = fresh;
  }
  const name = ENGINE_NAMES[pick.tool];
  const left = fullestOf(by(pick.tool)?.windows);
  // Who it passed over, when the person's usual tool is one and is the reason: "Codex: Claude Code is at 92% of its 5-hour window".
  if (o.usual && o.usual !== pick.tool && by(o.usual)) {
    const gone = o.ready.find((x) => x.tool === o.usual)!;
    const f = fullestOf(gone.windows) ?? (gone.fullest !== null ? { used: Math.round(gone.fullest), words: "limit" } : null);
    if (!gone.ready) return { tool: pick.tool, why: `${name}: ${ENGINE_NAMES[o.usual]} isn't signed in here` };
    if (f && f.used >= 50) return { tool: pick.tool, why: `${name}: ${ENGINE_NAMES[o.usual]} is at ${f.used}% of its ${f.words}` };
  }
  // Another tool that is ready but out of room is the reason there is no choice: say which, not "the only tool".
  const outOf = o.ready.filter((x) => x.tool !== pick.tool && !ranked.some((r) => r.tool === x.tool));
  const full = outOf.map((x) => ({ x, f: fullestOf(x.windows) })).find((y) => y.f);
  if (full?.f) return { tool: pick.tool, why: `${name}: ${ENGINE_NAMES[full.x.tool]} is at ${full.f.used}% of its ${full.f.words}` };
  if (o.ready.length === 1) return { tool: pick.tool, why: `${name}: the only tool ready here` };
  if (left) {
    // "The most room" only when every other tool has a reading and has less left; one nobody has read is not compared.
    const others = ranked.filter((r) => r.tool !== pick.tool).map((r) => fullestOf(by(r.tool)?.windows));
    const most = others.every((f) => f && f.used >= left.used);
    return { tool: pick.tool, why: `${name}: ${100 - left.used}% of its ${left.words} left${most ? ", the most room you have" : ""}` };
  }
  return { tool: pick.tool, why: `${name}: no usage numbers yet, so the one that suits this task` };
}

// ── the column's bar ────────────────────────────────────────────────

/** Who could take the work on: another tool on the person's own plan, with room. */
export interface HandTarget {
  tool: EngineTool;
  name: string;
  /** The lane it already has in this session, when it has one. */
  lane?: string;
}

/** The slim bar over a running chat: a tool heading for its limit. */
export interface LimitBar {
  tool: EngineTool;
  name: string;
  window: string;
  /** Percent of the window used now, as estimated. */
  used: number;
  /** Milliseconds until it runs out at this rate; null when it is only nearly full, not moving. */
  inMs: number | null;
  /** One line that fits the column: "Claude Code: limit in ~20 min", or "Claude Code ran out of usage". */
  text: string;
  /** The same in full, for the bar's tip: "Claude Code may hit its limit in ~20 min". */
  full: string;
  /** The limit is already hit: the work stopped, and the bar offers to carry it on elsewhere. */
  out?: boolean;
  to: HandTarget[];
}

/** How far ahead the bar looks: a limit further away than this isn't news yet. */
export const LOOK_AHEAD_MS = 60 * 60_000;
/** So full that the bar is shown even when the window isn't moving: the work in hand won't fit. */
export const NEARLY_FULL = 95;

/**
 * Whether a chat's column shows the bar, and what it says. Shown only while the tool is at work (mid-task), and only when someone
 * could take it on: its window runs out at the rate it is going before the turn is expected to end (`runEndsAt`), within the hour,
 * or it is nearly full. Not in a crew's room (its own hand-off looks after it), not once the work has gone on to another tool, nor
 * once the limit is hit (the hand-on that follows says so: `handedOnLine`).
 */
export function limitBar(o: { tool: EngineTool | undefined; running: boolean; team?: boolean; now: number; burn: Burn | null; runEndsAt: number; handedOn?: boolean; limited?: boolean; targets: HandTarget[] }): LimitBar | null {
  if (!o.tool || !o.running || o.team || o.handedOn || o.limited || !o.burn || !o.targets.length) return null;
  const b = o.burn;
  const name = ENGINE_NAMES[o.tool];
  const soon = b.at !== null && b.at > o.now && b.at - o.now <= LOOK_AHEAD_MS && b.at < Math.max(o.runEndsAt, o.now);
  const full = b.used >= NEARLY_FULL && b.used < 100;
  if (!soon && !full) return null;
  const window = windowWords(b.window);
  const inMs = soon ? b.at! - o.now : null;
  const sentence = inMs !== null ? `${name} may hit its limit in ${aboutTime(inMs)}` : `${name} has ${Math.max(0, Math.round(100 - b.used))}% of its ${window} left`;
  // One line at the column's default width (no wrapping labels): the sentence is in the tip.
  const text = inMs !== null ? `${name}: limit in ${aboutTime(inMs)}` : `${name}: ${Math.max(0, Math.round(100 - b.used))}% left`;
  return { tool: o.tool, name, window, used: Math.round(b.used), inMs, text, full: sentence, to: o.targets };
}

/**
 * The bar after the limit is hit, when the work stopped there (a chat with one tool: limit-handoff.ts only reaches tools already in
 * the session): the work can still go on to a tool with room, by the same hand-on, on the press (2026-11-20 review of wave 5).
 * Not once it has gone on, nor in a crew's room.
 */
export function outBar(o: { tool: EngineTool | undefined; team?: boolean; handedOn?: boolean; window?: string; targets: HandTarget[] }): LimitBar | null {
  if (!o.tool || o.team || o.handedOn || !o.targets.length) return null;
  const name = ENGINE_NAMES[o.tool];
  const text = `${name} ran out of usage`;
  return { tool: o.tool, name, window: o.window ?? "limit", used: 100, inMs: null, text, full: `${text}. Friday can carry the work on in another tool.`, out: true, to: o.targets };
}

/** What the column says once a tool ran out and its work went on: "Claude Code ran out of usage. Codex carried on." */
export function handedOnLine(o: { from: string; to: string; auto: boolean }): string {
  return o.auto ? `${o.from} ran out of usage. Friday handed the work to ${o.to}, which carried on.` : `${o.from} ran out of usage. ${o.to} carried on.`;
}
