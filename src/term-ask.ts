import type { DiveHost } from "./deep-dive.js";
import { TERM_SYSTEM, dangerOf, explainPrompt, parseCommand, parseExplain, writePrompt, type RecentCommand, type TermContext } from "./term-text.js";
import type { EngineTool } from "./types.js";

/**
 * The terminal helper's asks (Arun, 2026-11-20, wave 4: "type what you want in plain words in the terminal and get the command; a
 * command that fails gets explained and fixed"). The IDE sends the request (or the failed command and its output) with the shell,
 * the system, the folder and the last commands; the person's own coding tool answers read-only, as a quick one-shot; this reads
 * the answer as a command and a line about it. It only ever answers with text: the IDE puts the command in the terminal's input
 * without pressing Enter.
 */

export interface TermAsk extends Omit<TermContext, "recent"> {
  mode: "write" | "explain";
  /** The request in plain words ("write"). */
  request: string;
  /** The command that failed, with its output ("explain"). */
  failed?: { cmd: string; output: string; exit?: number };
  recent: RecentCommand[];
  /** The folder the open IDE is on: the tool answers there, so it can look at the project's scripts. */
  root: string;
}

export interface TermAnswer {
  /** The command to put in the terminal; empty when there is none. */
  command: string;
  /** What it does ("write"), or why it failed ("explain"), in a line or two. */
  explain: string;
  /** A warning for the command, when it is risky. */
  danger: string;
  tool?: string;
  /** Why there is no command, when a tool was wanted. */
  note?: string;
}

const ORDER: EngineTool[] = ["claude", "codex", "cursor", "devin", "opencode"];
const TIMED_OUT = /timed? ?out|timeout|code null|SIGTERM|killed/i;
/** A quick job: forty seconds a tool, a minute in all, as the person is looking at the prompt waiting. */
const ASK_MS = 40_000;
const TOTAL_MS = 60_000;

export async function askTerminal(host: DiveHost, input: TermAsk, opts: { totalMs?: number } = {}): Promise<TermAnswer> {
  const deadline = Date.now() + (opts.totalMs ?? TOTAL_MS);
  const none = (note: string): TermAnswer => ({ command: "", explain: "", danger: "", note });
  if (input.mode === "write" && !input.request.trim()) return none("Say what you want the command to do.");
  if (input.mode === "explain" && !input.failed?.cmd.trim()) return none("There is no failed command to explain.");

  let usable: { tool: EngineTool; name?: string }[] = [];
  try {
    const listed = (await host("tools", {}, 30_000)) as { tools?: { tool: EngineTool; name?: string; path: string | null; loggedIn: boolean | null; unavailable?: string }[] };
    const rank = (t: EngineTool) => (ORDER.indexOf(t) < 0 ? 99 : ORDER.indexOf(t));
    usable = (listed.tools ?? []).filter((t) => t.path && t.loggedIn !== false && !t.unavailable).sort((a, b) => rank(a.tool) - rank(b.tool));
  } catch {
    return none("Couldn't reach a coding tool on this computer.");
  }
  if (!usable.length) return none("No coding tool here is signed in, so there is nobody to write the command. Sign in to Claude Code, Codex or Cursor in Friday, then try again.");

  const ctx: TermContext = { shell: input.shell, os: input.os, cwd: input.cwd, recent: input.recent };
  const prompt = input.mode === "write" ? writePrompt(input.request, ctx) : explainPrompt(input.failed!, ctx);
  for (const t of usable) {
    const left = deadline - Date.now();
    if (left <= 0) return none("The coding tool took too long. Try again.");
    const ms = Math.min(ASK_MS, left);
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error("timed out")), left + 1_000); });
      const params: Record<string, unknown> = { tool: t.tool, system: TERM_SYSTEM, prompt, timeoutMs: ms };
      if (input.root) params.cwd = input.root;
      const r = (await Promise.race([host("ask", params, ms + 15_000), late]).finally(() => clearTimeout(timer))) as { text: string };
      const tool = t.name ?? t.tool;
      if (input.mode === "write") {
        const a = parseCommand(r.text);
        if (a.command) return { command: a.command, explain: a.explain, danger: dangerOf(a.command), tool };
        if (a.explain) return { command: "", explain: a.explain, danger: "", tool, note: a.explain };
      } else {
        const a = parseExplain(r.text);
        if (a.why || a.fix) return { command: a.fix, explain: a.why, danger: a.fix ? dangerOf(a.fix) : "", tool };
      }
    } catch (e) {
      if (TIMED_OUT.test((e as Error).message)) return none("The coding tool took too long. Try again.");
    }
  }
  return none("The coding tool didn't answer. Try again.");
}
