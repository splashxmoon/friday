import { commandFailed } from "./receipt.js";
import { MAIN_LANE, type SessionEvent } from "./types.js";

/**
 * An agent stuck in a loop, from the log.
 *
 * The expensive way an agent goes wrong is not a wrong answer but the same wrong move again and again: `npm test` failing
 * the same way, run after run, with nothing changed in between, until the window or the budget is gone. Running tests
 * over and over while fixing things is ordinary work, so what counts as stuck is the same command failing several times
 * in a row with no file touched between, or failing so many times in one run that it has stopped helping.
 */

/** The same command failing this many times in a row, with no edit between, is a loop. */
export const STUCK_REPEATS = 3;
/** And this many failures of one command in one run is too many, edits or not. */
export const MAX_FAILURES = 8;

const EDITS = new Set(["edit", "write", "write_file", "edit_file", "apply_patch", "create_file", "delete_file"]);
const norm = (c: string) => c.trim().replace(/\s+/g, " ");

export interface Runaway {
  command: string;
  times: number;
  /** "stuck": the same failure in a row, nothing changed between; "many": too many failures of it in one run. */
  kind: "stuck" | "many";
}

/** Whether the run now going on this lane is looping, and on what. */
export function runawayIn(events: SessionEvent[], lane: string): Runaway | null {
  const onLane = events.filter((e) => (e.lane ?? MAIN_LANE) === lane);
  // This run only: from its start, or from where it was last resumed (a person said "go on" after a pause, so the count starts over).
  const from = onLane.findLastIndex((e) => e.body.type === "run.started" || e.body.type === "run.resume");
  const run = from < 0 ? onLane : onLane.slice(from);
  const commands = new Map<string, string>();
  const streak = new Map<string, number>();
  const total = new Map<string, number>();
  for (const e of run) {
    const b = e.body;
    if (b.type === "folder.edited") streak.clear();
    if (b.type === "agent.message") {
      for (const c of b.toolCalls ?? []) {
        if (EDITS.has(c.name)) streak.clear();
        if (c.name !== "shell" && c.name !== "run_command") continue;
        try {
          const cmd = norm(String((JSON.parse(c.arguments || "{}") as { command?: unknown }).command ?? ""));
          if (cmd) commands.set(c.id, cmd);
        } catch {
          /* not a command we can read */
        }
      }
    }
    if (b.type !== "tool.result") continue;
    const cmd = commands.get(b.callId);
    if (!cmd) continue;
    const failed = commandFailed(b);
    if (failed === false) {
      streak.delete(cmd);
      continue;
    }
    if (failed !== true) continue;
    const s = (streak.get(cmd) ?? 0) + 1;
    const t = (total.get(cmd) ?? 0) + 1;
    streak.set(cmd, s);
    total.set(cmd, t);
    if (s >= STUCK_REPEATS) return { command: cmd, times: s, kind: "stuck" };
    if (t >= MAX_FAILURES) return { command: cmd, times: t, kind: "many" };
  }
  return null;
}

/** What the session says when it pauses a looping agent, in a person's words. */
export function runawayText(r: Runaway): string {
  const cmd = r.command.length > 70 ? `${r.command.slice(0, 69)}…` : r.command;
  return r.kind === "stuck"
    ? `Stopped: it ran \`${cmd}\` ${r.times} times in a row, failing each time with nothing changed in between. Tell it to carry on, or what to try instead.`
    : `Stopped: \`${cmd}\` has failed ${r.times} times in this run. Tell it to carry on, or what to try instead.`;
}
