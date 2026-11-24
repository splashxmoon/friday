/**
 * Today (Arun, 2026-11-21: "1. Speed baseline, Today with Tonight, and proof clips.", spec 10 A): the first thing on Home in the morning.
 * What landed from last night's queue, the work Friday found in your repos (found-work.ts), and Tonight, the queue you approve. Tonight is
 * Run later (later.ts) at the night's hour: nothing new runs things, and nothing runs that you didn't put there.
 *
 * Pure, so the route and the tests shape a row the same way.
 */
import type { LaterTask } from "./later.js";
import { readyIn } from "./ready.js";
import { runOf, type SessionState } from "./session/projection.js";
import { MAIN_LANE, type EngineTool } from "./types.js";
import { SIZE_MINUTES, type FoundItem } from "./found-work.js";
import { taskOf, TYPICAL_MS } from "./forecast.js";

/** A queued task started within this long is "last night's" on Today. */
export const LANDED_MS = 20 * 3600_000;
/** A task queued at least this far ahead was put in the queue; one due sooner was started with Start (or Run now). */
export const QUEUED_AHEAD_MS = 10 * 60_000;
/** Tonight lists what is queued to start within this long. */
export const TONIGHT_MS = 24 * 3600_000;

export type LandedState = "working" | "needs" | "ready" | "pr" | "merged" | "nothing" | "failed" | "gone";

export interface LandedRow {
  task: string;
  title: string;
  folder: string;
  tool: EngineTool;
  startedAt: number;
  sid?: string;
  invite?: string;
  state: LandedState;
  /** What changed, when it changed anything. */
  files?: number;
  additions?: number;
  deletions?: number;
  checks?: { ok: boolean; command: string };
  review?: { ok: boolean; by: string };
  pr?: { url: string; merged: boolean };
  /** Why it failed, or what the agent's question is. */
  note?: string;
  /** Its work changed a page and has no clip yet: Record a proof clip is offered (proof clips set to When I ask, or one not made). */
  clipable?: true;
  /** Its proof clip (a file of the chat), one being made, or why none could be. */
  clip?: { file?: string; page?: string; durationMs?: number; making?: boolean; failed?: string; /** The page before the change, and at a phone's width, when asked for in Settings. */ before?: string; phone?: string; /** What the walk did and when: "New: …", "Clicked …". */ marks?: { atMs: number; label: string }[] };
}

/** A task Friday started overnight, with how its chat stands now. A chat deleted since is said as gone, never dropped quietly. */
export function landedRow(t: LaterTask, state: SessionState | null): LandedRow {
  const base = { task: t.id, title: t.title, folder: t.folder, tool: t.tool, startedAt: t.startedAt ?? t.at, ...(t.sid ? { sid: t.sid, invite: t.invite } : {}) };
  if (t.status === "failed" || t.status === "missed") return { ...base, state: "failed", ...(t.note ? { note: t.note } : {}) };
  if (!state) return { ...base, state: "gone" };
  const run = runOf(state, MAIN_LANE);
  const ready = readyIn(state).find((r) => r.lane === MAIN_LANE);
  const changed = ready ? { files: ready.files, additions: ready.additions, deletions: ready.deletions, ...(ready.checks ? { checks: { ok: ready.checks.ok, command: ready.checks.command } } : {}), ...(ready.review ? { review: { ok: ready.review.ok, by: ready.review.by } } : {}) } : {};
  const pr = state.pr ? { pr: { url: state.pr.url, merged: !!state.pr.merged } } : {};
  if (run.status === "running") return { ...base, state: "working", ...pr };
  if (run.status === "waiting_for_human") return { ...base, state: "needs", ...changed, ...pr };
  // Cut off by Friday restarting: its turn was put back and carries on once the runner is back (engine/hub.ts), so it is still working.
  if (run.status === "error" && /server restarted in the middle of|lost its connection when the server restarted/i.test(run.error ?? "")) return { ...base, state: "working", ...pr };
  if (run.status === "error") return { ...base, state: "failed", ...(run.error ? { note: run.error.slice(0, 200) } : {}), ...changed, ...pr };
  if (state.pr?.merged) return { ...base, state: "merged", ...pr };
  if (state.pr) return { ...base, state: "pr", ...changed, ...pr };
  return { ...base, state: ready ? "ready" : "nothing", ...changed };
}

/** The most pressing first: what needs you, then what failed, then finished work, then what is still going. */
const RANK: Record<LandedState, number> = { needs: 0, failed: 1, ready: 2, pr: 3, working: 4, merged: 5, nothing: 6, gone: 7 };
export const sortLanded = (rows: LandedRow[]): LandedRow[] => [...rows].sort((a, b) => RANK[a.state] - RANK[b.state] || b.startedAt - a.startedAt);

export interface TonightRow {
  id: string;
  title: string;
  folder: string;
  tool: EngineTool;
  at: number;
  /** About how long its agent takes. */
  minutes: number;
}

/** A queued task's likely length: a found one says its size in the title's queue, anything else is read from its words. */
export function minutesFor(t: Pick<LaterTask, "ask">, found?: Pick<FoundItem, "size"> | null): number {
  if (found) return SIZE_MINUTES[found.size];
  return Math.round(TYPICAL_MS[taskOf(t.ask).tier] / 60_000);
}

export interface Today {
  landed: LandedRow[];
  tonight: TonightRow[];
  found: FoundItem[];
  /** The repos looked through for found work. */
  looked: string[];
  /** When found work was last looked for; 0 while the first look is out. */
  foundAt: number;
  /** Why found work couldn't be looked for (no computer connected). */
  foundError?: string;
}

/** One window of a tool's limit as Today reads it: how much is used (0-100) and when it starts again. */
export interface FitWindow {
  minutes: number;
  used: number | null;
  /** Unix seconds. */
  resetsAt: number | null;
}

/**
 * Whether Tonight fits in the tool's limits, in a line: its short window (five hours) is fresh by the start or how full it is until when,
 * and a warning when its week is nearly gone, since a run stopped by the week waits days. Empty when nothing is known: no guess.
 */
export function fitLine(name: string, windows: FitWindow[], at: number, clock: (ms: number) => string): string {
  const short = windows.find((w) => w.minutes <= 300);
  const week = windows.find((w) => w.minutes >= 7 * 24 * 60 && (w.used ?? 0) >= 85);
  const parts: string[] = [];
  if (short && short.used !== null) {
    if (short.resetsAt && short.resetsAt * 1000 <= at) parts.push(`${name}'s 5-hour limit is fresh by then`);
    else if (short.used >= 50) parts.push(`${name} is at ${Math.round(short.used)}% of its 5-hour limit${short.resetsAt ? ` until ${clock(short.resetsAt * 1000)}` : ""}`);
    else parts.push(`${name} has room in its 5-hour limit`);
  }
  if (week) parts.push(`its week is at ${Math.round(week.used!)}%, so tonight may stop early`);
  return parts.join("; ");
}
