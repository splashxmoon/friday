import { runOf, type SessionState } from "./session/projection.js";
import { ENGINE_NAMES, MAIN_LANE, type EngineTool } from "./types.js";

/**
 * Ready to ship (Arun, 2026-11-01, the impress map: "review lives in too many places"; after Conductor's Checks tab, Codex's
 * review queue and Devin Review): every agent's finished work across your sessions in one list, each with what proves it (its
 * tests, a second agent's review), how big it is, and where its pull request stands, so shipping is a look and a press rather
 * than a hunt through rooms. Read from each session's folded state alone, never its whole log: a list asked for on every home
 * screen can't read megabytes of every session.
 *
 * Finished means: its agent isn't working, and its folder holds changes that aren't in a merged pull request yet. In a session
 * with a board (a Crew room), only a lane with a task done or being checked: a teammate's folder with changes and no finished
 * task is work in progress, not work to ship (Arun, 2026-11-01, a list of twelve "Nova's changes": "i dont like this").
 */
export interface ReadyItem {
  sid: string;
  /** The session's title. */
  where: string;
  lane: string;
  /** The agent or teammate who did it. */
  who: string;
  tool?: EngineTool;
  /** Its board task, when the work was one. */
  task?: string;
  files: number;
  additions: number;
  deletions: number;
  /** Its own tests, as last run: passed or not, and the command. */
  checks?: { ok: boolean; command: string };
  /** A second agent's read of it. */
  review?: { ok: boolean; by: string; note: string };
  pr?: { url: string; merged: boolean };
  /** When its diff was last seen (the session's last event time stands in). */
  seq: number;
  /** Waiting on the person (a question or an approval): it isn't finished, it needs them. */
  waiting: boolean;
}

export function readyIn(state: SessionState): ReadyItem[] {
  if (state.pr?.merged) return [];
  const out: ReadyItem[] = [];
  for (const [lane, d] of Object.entries(state.diffs ?? {})) {
    if (!d.files.length) continue;
    const run = runOf(state, lane);
    if (run.status === "running") continue;
    const name = lane === MAIN_LANE ? (state.mainName ?? "Main") : (state.lanes.find((l) => l.id === lane)?.name ?? lane);
    const tool = state.engines[lane]?.tool;
    // The newest board task of this lane that is done or being checked: what this work was.
    const task = [...(state.board?.tasks ?? [])].reverse().find((t) => t.lane === lane && (t.status === "done" || t.status === "review"));
    if (!task && state.board?.tasks.length) continue;
    const checks = task?.checks && !task.checks.running && !task.checks.skipped && task.checks.ok !== undefined ? { ok: task.checks.ok, command: task.checks.command } : undefined;
    out.push({
      sid: state.id,
      where: state.title || "A session",
      lane,
      who: name,
      ...(tool ? { tool } : {}),
      ...(task ? { task: task.title } : {}),
      files: d.files.length + (d.more?.length ?? 0),
      additions: d.files.reduce((n, f) => n + (f.additions ?? 0), 0),
      deletions: d.files.reduce((n, f) => n + (f.deletions ?? 0), 0),
      ...(checks ? { checks } : {}),
      ...(task?.review ? { review: { ok: task.review.ok, by: task.review.by, note: task.review.note.slice(0, 200) } } : {}),
      ...(state.pr ? { pr: { url: state.pr.url, merged: !!state.pr.merged } } : {}),
      seq: d.seq,
      waiting: run.status === "waiting_for_human",
    });
  }
  return out;
}

/**
 * Most worth a look first: proven and unshipped (tests passed or reviewed, no pull request yet), then the rest unshipped, then
 * those with a pull request open; newest first in each. The same teammate's same changes seen from two rooms (one folder, two
 * rooms it works in) show once.
 */
export function rankReady(items: ReadyItem[], at: (i: ReadyItem) => number): ReadyItem[] {
  const tier = (i: ReadyItem) => (i.pr ? 2 : i.checks?.ok || i.review?.ok ? 0 : 1);
  const seen = new Set<string>();
  return [...items]
    .sort((a, b) => tier(a) - tier(b) || at(b) - at(a))
    .filter((i) => {
      const key = `${i.who}|${i.task ?? ""}|${i.files}|${i.additions}|${i.deletions}`;
      return !seen.has(key) && !!seen.add(key);
    });
}

/** The line under an item: what proves it, in words. */
export function proofLine(i: ReadyItem): string {
  const parts: string[] = [];
  if (i.checks) parts.push(i.checks.ok ? "tests passed" : "tests failing");
  if (i.review) parts.push(i.review.ok ? `reviewed by ${i.review.by}` : `${i.review.by} asked for changes`);
  if (!parts.length) parts.push("not checked yet");
  return parts.join(" · ");
}

export const toolName = (t?: EngineTool) => (t ? ENGINE_NAMES[t] : "");
