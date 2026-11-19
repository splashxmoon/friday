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
/**
 * Editing in circles (Arun, 2026-11-15, after other products' agents "repairing" the same thing for hours): one file edited this
 * many times while its checks keep failing, with none passing since.
 */
export const CIRCLE_EDITS = 8;
/** And the same call, the same arguments, this many times with nothing changed between: reading or fetching the same thing over. */
export const SAME_CALL = 4;

const EDITS = new Set(["edit", "write", "write_file", "edit_file", "apply_patch", "create_file", "delete_file"]);
/**
 * Looking at a browser page: Friday's own Browser panel (the friday `browser` tool, any of its actions), or another browser tool's
 * read, screenshot, page text, console or network. A page changes without any file here changing (it reloads, the app it shows
 * moves on, a person clicks in the panel), so reading it again is watching it, never a loop (Arun, 2026-11-16: "Stopped: it did
 * browser read 4 times with nothing changed in between ... get rid of this since it is viewing browser panel").
 */
const watching = (name: string, args: string | undefined) => {
  const bare = name.replace(/^mcp__.+?__/, "");
  if (bare === "browser" || /(^|_)browser$/.test(name)) return true;
  if (!/browser|chrome|playwright|puppeteer|preview/i.test(name)) return false;
  if (/^(read_page|get_page_text|read_console_messages|read_network_requests|tabs_context\w*|find|screenshot|take_screenshot|snapshot|browser_snapshot|browser_take_screenshot|browser_console_messages|browser_network_requests|wait|browser_wait_for)$/.test(bare)) return true;
  // The browser tools' one "computer" call: a screenshot, a zoom or a wait only looks.
  return bare === "computer" && /"action"\s*:\s*"(screenshot|zoom|wait|scroll)"/.test(args ?? "");
};
const norm = (c: string) => c.trim().replace(/\s+/g, " ");

export interface Runaway {
  command: string;
  times: number;
  /**
   * "stuck": the same failure in a row, nothing changed between; "many": too many failures of it in one run; "circles": one file
   * edited over and over while the checks keep failing (`command` is the file); "repeat": the same call again and again with
   * nothing changed (`command` says the call).
   */
  kind: "stuck" | "many" | "circles" | "repeat" | "refused";
}

/** Refused this many times in a row (the go-ahead list's "never", or a person's no) and the agent is handed back to the person. */
export const REFUSALS = 3;

/** The file a call edits, from its arguments. */
function pathOf(args: string | undefined): string {
  try {
    const a = JSON.parse(args || "{}") as { path?: unknown; file_path?: unknown };
    return String(a.path ?? a.file_path ?? "").trim();
  } catch {
    return "";
  }
}

/** A call said for a person: "read README.md", "web_fetch https://…". */
function callWords(name: string, args: string | undefined): string {
  try {
    const a = JSON.parse(args || "{}") as Record<string, unknown>;
    const first = Object.values(a).find((v) => typeof v === "string") as string | undefined;
    return `${name.replace(/^mcp__[^_]+__/, "")}${first ? ` ${first}` : ""}`;
  } catch {
    return name;
  }
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
  /** Edits to each file since a check last passed, and the failed checks since. */
  const edits = new Map<string, number>();
  let failedSince = 0;
  /** Each call, by what it is, since anything last changed. */
  const same = new Map<string, number>();
  /** Refusals since a step last went through: Friday's "never" and a person's no to a go-ahead. */
  let refused = 0;
  /** What each go-ahead asked, by its id, to say what a no was to. */
  const asked = new Map<string, string>();
  for (const e of run) {
    const b = e.body;
    if (b.type === "engine.approval") asked.set(b.id, b.items[0] ?? "");
    if (b.type === "guard.refused" || (b.type === "instruction" && b.approval && b.approval.approve === false)) {
      refused += 1;
      const what = b.type === "guard.refused" ? b.item : asked.get(b.approval!.id) || "what it asked";
      if (refused >= REFUSALS) return { command: what, times: refused, kind: "refused" };
      continue;
    }
    if (b.type === "tool.result" && !b.isError) refused = 0;
    if (b.type === "folder.edited") (streak.clear(), same.clear());
    if (b.type === "agent.message") {
      for (const c of b.toolCalls ?? []) {
        if (EDITS.has(c.name)) {
          streak.clear();
          same.clear();
          const file = pathOf(c.arguments);
          if (file) {
            const n = (edits.get(file) ?? 0) + 1;
            edits.set(file, n);
            if (n >= CIRCLE_EDITS && failedSince >= 2) return { command: file, times: n, kind: "circles" };
          }
          continue;
        }
        const key = `${c.name} ${norm(c.arguments || "")}`;
        const n = (same.get(key) ?? 0) + 1;
        same.set(key, n);
        if (n >= SAME_CALL && c.name !== "shell" && c.name !== "run_command" && !/^(update_plan|todo|check_messages|wait_for_agent|list_tasks)$/.test(c.name) && !watching(c.name, c.arguments)) return { command: callWords(c.name, c.arguments), times: n, kind: "repeat" };
        if (c.name !== "shell" && c.name !== "run_command") continue;
        // A command can change what the next read sees (a screenshot taken again, a file rebuilt): reading it after one is reading
        // something new, not the same thing over (benchmark, 2026-11-17: a run looking at each new screenshot was stopped as a loop).
        same.clear();
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
      // A check passed: the edits since were getting somewhere.
      edits.clear();
      failedSince = 0;
      continue;
    }
    if (failed !== true) continue;
    failedSince += 1;
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
  if (r.kind === "refused") return `Stopped: it was refused ${r.times} times in a row (last: \`${cmd}\`). Friday paused it rather than let it look for a way round. Tell it to carry on, or what to do instead.`;
  return r.kind === "stuck"
    ? `Stopped: it ran \`${cmd}\` ${r.times} times in a row, failing each time with nothing changed in between. Tell it to carry on, or what to try instead.`
    : r.kind === "circles"
      ? `Stopped: it has edited \`${cmd}\` ${r.times} times while the checks kept failing. Tell it to carry on, or what to try instead.`
      : r.kind === "repeat"
        ? `Stopped: it did \`${cmd}\` ${r.times} times with nothing changed in between. Tell it to carry on, or what to try instead.`
        : `Stopped: \`${cmd}\` has failed ${r.times} times in this run. Tell it to carry on, or what to try instead.`;
}
