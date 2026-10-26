import { execFile } from "node:child_process";

/**
 * Telling a coding tool that has hung from one that is busy.
 *
 * Silence alone says nothing: a build or a test suite prints nothing until it is over. What a busy tool always does is use
 * the computer: the tool itself thinking aloud to its model, or a command it started compiling, testing, downloading. A tool
 * whose whole process tree has used almost no CPU for twenty minutes, with nobody's answer awaited, is waiting on something
 * that is never coming back: Codex sat for eight hours on a model call that never returned, "Thinking…" in the room, until
 * somebody noticed (Arun, 2026-10-23: "look into codex", "and other coding tools too, for like this error/bug").
 */

/** How long a tool may say nothing before the room is told; it is still left to run. FRIDAY_QUIET_MS is for tests. */
export const quietMs = (): number => Number(process.env.FRIDAY_QUIET_MS) || 10 * 60_000;
/** Silent this long, and idle all the while, is hung: two of the room's notes, twenty minutes. */
export const hungMs = (): number => 2 * quietMs();
/** The most CPU, in seconds, a hung tree uses over the last of those windows: an idle Codex uses about a second an hour. */
export const HUNG_CPU_S = 3;

/** CPU time as `ps` prints it: "591:36.57" (macOS: minutes and seconds), "02:03:04" or "1-02:03:04" (Linux). */
export function cpuSeconds(t: string): number {
  const [days, rest] = t.includes("-") ? [Number(t.split("-")[0]), t.split("-")[1]!] : [0, t];
  const parts = rest.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  const [h, m, s] = parts.length === 3 ? parts : [0, parts[0] ?? 0, parts[1] ?? 0];
  return days * 86_400 + h! * 3600 + m! * 60 + s!;
}

/** The CPU seconds `root` and everything under it have used, from `ps -A -o pid=,ppid=,time=`. Null when root isn't there. */
export function treeSeconds(table: string, root: number): number | null {
  const kids = new Map<number, number[]>();
  const used = new Map<number, number>();
  for (const line of table.split("\n")) {
    const [pid, ppid, time] = line.trim().split(/\s+/);
    if (!pid || !ppid || !time) continue;
    const p = Number(pid);
    used.set(p, cpuSeconds(time));
    kids.set(Number(ppid), [...(kids.get(Number(ppid)) ?? []), p]);
  }
  if (!used.has(root)) return null;
  let total = 0;
  const todo = [root];
  const seen = new Set<number>();
  while (todo.length) {
    const p = todo.pop()!;
    if (seen.has(p)) continue;
    seen.add(p);
    total += used.get(p) || 0;
    todo.push(...(kids.get(p) ?? []));
  }
  return total;
}

/** The CPU seconds a tool's process tree has used so far. Null when it can't be told (Windows, or `ps` failing): never hung then. */
export function treeCpu(pid: number | undefined): Promise<number | null> {
  if (!pid || process.platform === "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid=,time="], { timeout: 10_000, maxBuffer: 8 << 20 }, (err, out) => resolve(err ? null : treeSeconds(String(out), pid)));
  });
}

/**
 * How long a turn may go without a single word from its tool. A working tool says something within seconds of being handed a
 * turn (Claude Code its first event, Codex that the turn started), whatever it then goes on to run, so one with nothing at all
 * after this long, its processes idle the whole time, never got going: Codex sat on a review this way while the room waited the
 * full twenty minutes (Arun, 2026-10-24). FRIDAY_FIRST_WORD_MS is for tests.
 */
export const firstWordMs = (): number => Number(process.env.FRIDAY_FIRST_WORD_MS) || 5 * 60_000;

/** Whether a turn that has said nothing since it began `silent` ms ago, with its tree at `start` CPU seconds then and `now` now, never started. */
export function neverStarted(silent: number, start: number | null, now: number | null): boolean {
  return silent >= firstWordMs() && start !== null && now !== null && now - start < HUNG_CPU_S;
}

/** Whether a tool silent for `quietMs` that used `then` CPU seconds a window ago and `now` seconds now is hung. */
export function isHung(quiet: number, then: number | null, now: number | null): boolean {
  return quiet >= hungMs() && then !== null && now !== null && now - then < HUNG_CPU_S;
}
