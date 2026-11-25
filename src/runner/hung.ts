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

/**
 * Time a tool has been silent while the computer was awake (spec 13, Arun 2026-11-24: "Go all out and fix these problems").
 *
 * Silence was measured on the wall clock, which goes on while a laptop's lid is closed, while the timers that look at it, and the
 * tool's own CPU, don't: back from a night asleep, a tool mid-way through a long, quiet command could be ended as hung on its next
 * look. So silence is measured on the monotonic clock (performance.now(), which stops while the computer sleeps on a Mac and on
 * Linux), and any sleep noticed in the window, on any system, starts the silence over: the CPU the window compares was taken
 * across the sleep, and says nothing about the tool.
 */

/** A gap this much longer than the watch's beat means the computer was asleep (or this process was stopped). */
const SLEPT_SLACK_MS = 60_000;

/**
 * Notices the computer sleeping: it looks every `everyMs` while something holds it, and a look that comes much later than that
 * means the time between was spent asleep. Whatever clock timers keep (they pause in sleep on a Mac, and fire late on Windows),
 * the wall clock between two looks shows it. Runs only while a turn holds it, unref'd.
 */
export class SleepWatch {
  private last: number;
  /** How many sleeps (or clock jumps, forward or back) it has noticed. */
  private jumps = 0;
  private holders = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(
    private readonly wall: () => number = Date.now,
    private readonly everyMs = 30_000,
  ) {
    this.last = wall();
  }
  /** One look. */
  look(): void {
    const t = this.wall();
    if (t - this.last > this.everyMs + SLEPT_SLACK_MS || t < this.last) this.jumps++;
    this.last = t;
  }
  /** The sleeps noticed so far, after a look now: a count that changed since an earlier call means one came in between. */
  sleeps(): number {
    this.look();
    return this.jumps;
  }
  /** Looking, while a turn runs. Returns the way to let go. */
  hold(): () => void {
    if (this.holders++ === 0) {
      this.last = this.wall();
      this.timer = setInterval(() => this.look(), this.everyMs);
      this.timer.unref?.();
    }
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      if (--this.holders === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }
}

/** The one every turn shares. */
export const sleepWatch = new SleepWatch();

/** How long it has been quiet, awake: `heard()` at each word, `quiet()` at each look. */
export class Silence {
  private since: number;
  private slept: number;
  constructor(
    private readonly watch: Pick<SleepWatch, "sleeps"> = sleepWatch,
    private readonly mono: () => number = () => performance.now(),
  ) {
    this.since = mono();
    this.slept = watch.sleeps();
  }
  heard(): void {
    this.since = this.mono();
    this.slept = this.watch.sleeps();
  }
  /** Milliseconds quiet on the monotonic clock; 0, and started over, when the computer slept since it began. */
  quiet(): number {
    if (this.watch.sleeps() !== this.slept) {
      this.heard();
      return 0;
    }
    return Math.max(0, this.mono() - this.since);
  }
}
