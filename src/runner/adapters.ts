import { noteClaudeEvent } from "./limits.js";
import { access, mkdir, readdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { ENGINE_EFFORTS, ENGINE_NAMES, type AgentTaskStatus, type EngineEffort, type EngineMode, type EngineTool, type ToolCall } from "../types.js";
import { testFailedInChain } from "../receipt.js";
import { contains } from "../folder-key.js";
import { execCli, noteBackground } from "./spawn-cli.js";
import { accountEnv } from "./accounts.js";
import { mcpForAgent, type AcpMcpServer } from "./mcp-servers.js";
import { reviewTarget } from "./tool-commands.js";
import { ampConfig, claudeConfig, codexConfig, type FridayMcp } from "./friday-mcp.js";
import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";

/**
 * Adapters for the coding CLIs people already have: Claude Code, Codex and
 * Cursor. Each runs headless with machine-readable output, under the user's own
 * login, and each adapter turns that output into the session's own vocabulary —
 * agent messages, tool calls, tool results — so the feed renders all three the
 * same way.
 */

export type AdapterOut =
  | { kind: "session"; id: string }
  | { kind: "delta"; text: string; channel: "text" | "reasoning" }
  | { kind: "message"; text: string; toolCalls: ToolCall[]; reasoning?: string }
  | { kind: "result"; callId: string; name: string; output: string; isError: boolean }
  /** A non-fatal problem worth reporting if the process then fails. */
  | { kind: "note"; text: string }
  /**
   * What the tool was stopped from doing because the machine is in Manual mode.
   *
   * `commands`: exact commands, which a later turn can be allowed to run. `turn`: the tool cannot ask one thing at a
   * time, so what it wanted is described and approving lets the whole turn be tried again with write access.
   */
  | { kind: "blocked"; scope: "commands" | "turn"; items: string[] }
  /** The tool is waiting, mid-turn, for a person to say whether it may use `tool` with `input` (see TurnSpec.ask). */
  | { kind: "ask"; requestId: string; tool: string; input: Record<string, unknown>; why?: string; /** How to answer, for a tool that is answered through its parser (ACP). */ reply?: (allow: boolean) => void }
  /** The `/` commands the tool answers to, as it listed them (ACP's available_commands_update): the whole list each time. */
  | { kind: "commands"; list: { name: string; description: string; hint?: string }[] }
  /** The models the tool offers, as it listed them in its `model` option (ACP): for the model picker (see Runner, `models`). */
  | { kind: "models"; list: { id: string; label: string }[] }
  /** The effort levels its `thought_level` option offers (ACP), in Friday's names: for the effort pill (see EngineInfo.efforts). */
  | { kind: "efforts"; list: EngineEffort[] }
  /** What the turn used, as the tool reported it (see the `agent.usage` event). */
  | {
      kind: "usage";
      input: number;
      cached: number;
      output: number;
      /** How full its context is now: what its last model call was handed, and the window that model has, when the tool says. */
      context?: number;
      window?: number;
    }
  /** A subagent or background task the tool started, or a change in where one stands (see the `agent.task` event). */
  | {
      kind: "task";
      id: string;
      status: AgentTaskStatus;
      description?: string;
      agentType?: string;
      background?: boolean;
      summary?: string;
      /** While it works: what it is doing now, in a few words, and how many steps it has taken (see subagentDoing). */
      doing?: string;
      steps?: number;
    }
  /**
   * The turn's final word. `held`: said while its background tasks still run, and it carries on by itself once they finish,
   * so this counts as done if the process ends here but doesn't end the turn (see noteBackground).
   */
  | { kind: "done"; error?: string; held?: boolean };

export interface TurnSpec {
  prompt: string;
  /** The CLI's own conversation id from the previous turn, so it keeps its memory. */
  resumeId: string | null;
  mode: EngineMode;
  /** Standing instructions about working in a shared session. */
  system: string;
  /**
   * Whether a tool that takes `system` as part of its prompt (Codex, Cursor) is sent it this turn. Unset, only when a
   * conversation starts. The runner sets it whenever the text is new to the conversation: one it picked up and resumed has
   * never been told, and one told before has not heard about an agent put on the lane since.
   */
  withSystem?: boolean;
  /** `system`, written to this file, for a tool that can read it from one: a long one would not fit on a command line. */
  systemFile?: string;
  /** Carry on from a copy of the resumed conversation rather than the conversation itself (Claude Code). */
  fork?: boolean;
  /** One of that CLI's own models. Empty means whatever it defaults to. */
  model?: string;
  /** In Manual mode, what a person has just said yes to. */
  grant?: { scope: "commands" | "turn"; items: string[] };
  /**
   * In Manual mode, ask a person while the turn waits, rather than refuse and ask once it is over (Claude Code, kept with
   * stream-json input, the only way it can be answered: see WarmClaude).
   */
  ask?: boolean;
  /** Claude Code's MCP servers for this folder (see claudeMcpServers), which Auto lets it use. */
  mcp?: string[];
  /**
   * How hard it thinks this turn (low, medium, high, xhigh or max), for a tool that takes it: per turn for Codex over its
   * app-server, as a flag at start for Claude Code, `codex exec` and Copilot. Unset is the tool's own default.
   */
  effort?: string;
  /** The prompt goes on stdin, never the command line: a process started ahead of its turn (see Prespawn) is handed it there. */
  stdinPrompt?: boolean;
  /**
   * The files attached to this turn, as saved on this machine. They are named in the prompt for every tool; a tool that takes a
   * picture or a file as input of its own is handed them that way too (Codex's images, ACP's image and resource_link blocks), so
   * a picture is seen and not only named (Arun, 2026-10-18: the tools as capable in Friday as on their own).
   */
  files?: string[];
  /** Which of the tool's accounts on this computer it runs as (accounts.ts), when not its own sign-in: what it says of its limits is that account's. */
  account?: string;
  /** The project's MCP servers (its .mcp.json), for a tool spoken to over ACP: passed with the conversation (see mcp-servers.ts). */
  acpMcp?: AcpMcpServer[];
  /** Flags this tool's installed version refused (see Adapter.optional): left off from then on. */
  skip?: string[];
  /** One of Codex's own commands, typed alone (see CODEX_BUILTINS): run as its app-server runs it, instead of a turn of words. */
  command?: { name: "review" | "compact"; args: string };
  /** Friday's own MCP server, through which the agents in a session talk to each other (friday-mcp.ts, agent-mesh.ts). */
  friday?: FridayMcp;
  /**
   * Folders it may work in besides its own, as the tool's own --add-dir has them: handed to a tool that takes them (see
   * Adapter.dirs), and named in the standing note of one that doesn't (Arun, 2026-10-19: the tools as capable in Friday as on
   * their own). Absolute paths, each a folder on this computer.
   */
  dirs?: string[];
  /**
   * A Work session: content and knowledge work, not code (Arun, 2026-10-26: "basic work stuff not coding ... it can handle
   * browsering, videos, etc everything that codex and claude co work can do"). Each tool starts with everything it has on its
   * own: Claude Code with Claude in Chrome and, in Auto, its own auto mode (so its connectors and skills run unasked, past its
   * safety checks); Codex with live web search and the network, beside its computer use and image generation.
   */
  work?: boolean;
}

/**
 * The standing note with the folders beside the tool's own named in it, for a tool that takes no flag for them (see
 * Adapter.dirs): it hears where else it may work, and its own tools reach them by path.
 */
export function withDirs(system: string, dirs: string[] | undefined): string {
  if (!dirs?.length || !system) return system;
  return `${system}\n\nBesides the folder you are in, you may also read and change files in these folders:\n${dirs.map((d) => `- ${d}`).join("\n")}`;
}

/** Picture files, by extension, as a tool that takes images is handed them. */
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
export const imageType = (file: string): string | undefined => IMAGE_TYPES[path.extname(file).toLowerCase()];
/** The attached pictures, at most this many bytes each: a bigger one is still named in the prompt, for the tool to open itself. */
const IMAGE_MAX = 10 * 1024 * 1024;
const images = (t: TurnSpec) => (t.files ?? []).filter((f) => !!imageType(f));
/** What Anthropic's API takes in one picture: 5 MB once encoded. A bigger one is only named, and Claude Code's Read opens it. */
const CLAUDE_IMAGE_MAX = 3.75 * 1024 * 1024;
/**
 * The pictures attached to a turn as Claude Code takes them in a message (WarmClaude): image blocks, so it sees a screenshot
 * attached in Friday as it does one pasted at its own prompt (Arun, 2026-10-25: "allow for screenshots and images to be read
 * and viewed by the coding tools like how claude does it here"). Named in the prompt as well, as every file is.
 */
export function claudePictures(t: TurnSpec): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const f of images(t)) {
    try {
      if (statSync(f).size > CLAUDE_IMAGE_MAX) continue;
      out.push({ type: "image", source: { type: "base64", media_type: imageType(f), data: readFileSync(f).toString("base64") } });
    } catch {
      // Gone or unreadable: it is still named in the prompt.
    }
  }
  return out;
}
/** Whether a flag is still to be passed: it isn't one this tool's version said it doesn't know. */
const offered = (t: TurnSpec, flag: string) => !t.skip?.includes(flag);

/**
 * Where Friday's standing text ends and the message begins, in a prompt that carries both (Codex, Cursor). Reading the
 * conversation back (imports.ts) takes what follows it as what was asked: the text before can hold blank lines of its own.
 */
export const PROMPT_MARK = "[Friday] The message:";

/**
 * Whether text is too long to go on a command line as one argument. Windows caps the whole line at 32,767 characters, and
 * every quote in it is escaped and so counts twice; elsewhere one argument may be 128 KiB, counted in bytes, which a few
 * thousand characters of CJK or emoji reach long before as many letters do.
 */
export const tooLongForArgv = (text: string): boolean => (process.platform === "win32" ? text.length > 15_000 : Buffer.byteLength(text) > 100_000);


/** For a tool that is spoken to while its turn runs (ACP): where the turn runs, and its stdin, kept open. */
export interface TurnIO {
  cwd: string;
  write(line: string): void;
  end(): void;
  /** The tool is one kept running from an earlier turn (see WarmAcp), initialized already: no `initialize` is written to it. */
  kept?: AcpKept;
}

/**
 * An ACP tool kept running between turns, as the turns on it leave it: what it said it can do, and the conversation it has open
 * with how that conversation's options stand (its `session/new` or `session/load` answer, kept up to date). `fresh`: opened
 * before any turn asked for it, so the first turn that starts a conversation takes it.
 */
export interface AcpKept {
  caps: Record<string, any>;
  sessionId?: string;
  res?: Record<string, any>;
  fresh?: boolean;
}

/** A turn's line parser. `cancel`: stop the turn the tool's own way, where it has one, rather than with a signal. */
/**
 * `steer`: a message for the turn running now, read at its next step rather than after the turn (another agent's question,
 * a redirect). True when the tool took it; false when it can't, or its turn has just ended, and it waits for the next turn.
 */
export type Parser = ((line: string) => AdapterOut[]) & { cancel?: () => void; steer?: (text: string) => Promise<boolean> };

export interface Adapter {
  tool: EngineTool;
  /** Executable names to look for. */
  bins: string[];
  /** Arguments that sign the person in, interactively, with their own account. */
  login: string[];
  /** Arguments that sign it out. Unlike login, this needs no browser. */
  logout: string[];
  args(t: TurnSpec): string[];
  /** Text written to the process's stdin; the prompt goes here so no shell quoting is involved. */
  stdin(t: TurnSpec): string;
  /** One process a turn, the next started as a turn ends (see Prespawn): with `stdinPrompt` set, its argv holds no prompt. */
  prespawn?: boolean;
  /** Its stdin stays open after `stdin`: the parser goes on talking to it through `io` (ACP). */
  interactive?: boolean;
  /** It takes TurnSpec.dirs as a flag or setting of its own. Without it, the runner names them in its standing note instead. */
  dirs?: boolean;
  /** Which JSON-RPC it speaks when kept between turns (see AcpHow.dialect): ACP unless said. */
  dialect?: "codex";
  /**
   * A protocol of its own, spoken by one process a turn and never kept between turns: the kept process (WarmAcp) answers
   * `initialize` itself, in ACP or Codex's dialect, and this tool's parser, waiting for that answer, never opened the
   * conversation (Muse Code: every turn sat at "working" until it was stopped; Arun, 2026-10-29: "check if muse works").
   */
  perTurn?: true;
  /** The modes it can be held to, when not all three: a tool that can't ask before it acts can't honour Manual or Plan. */
  modes?: EngineMode[];
  /**
   * Flags newer than some installs of it. One its version refuses as unknown is left off and the turn runs again without it, as
   * an unknown effort flag is (see Runner.turn): a newer capability never costs somebody on an older version their turn.
   */
  optional?: string[];
  /** What a turn adds to its environment: how a tool is told its model or held to a mode when no flag says it. */
  env?(t: TurnSpec): Record<string, string>;
  /** Why it can't run on this computer, when it can't: said instead of a turn that would hang. */
  unavailable?(): string | null;
  /**
   * How it says whether somebody is signed in, without Friday reading a token: a command of its own (and how its answer
   * reads, when the usual words don't say), or a look at its own files. None: nobody can tell until a turn runs, and an
   * unknown command is never tried, since for most of these tools anything unrecognised starts a session.
   */
  status?: { args: string[]; signedIn?: RegExp; signedOut?: RegExp } | ((bin: string) => Promise<boolean | null>);
  /** A fresh line parser for one turn. */
  parser(t?: TurnSpec, io?: TurnIO): Parser;
  /** Turns a raw failure into something the room can act on. */
  explain(error: string): string;
}

const MAX_ARGS = 8_000;
const MAX_OUTPUT = 20_000;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** What a coding tool is told when it asks the person something with nobody there to ask: decide, and say what was chosen. */
export const DECIDE_YOURSELF = "Nobody is being asked in Auto. Decide for yourself, and say in your answer what you chose and why.";

/** Codex's requestUserInput answered for each question it asked (`questions[].id`), with DECIDE_YOURSELF. */
export function decideAnswers(params: unknown): Record<string, { answers: string[] }> {
  const qs = (params as { questions?: unknown } | null)?.questions;
  return Object.fromEntries((Array.isArray(qs) ? qs : []).flatMap((q) => (typeof (q as { id?: unknown })?.id === "string" ? [[(q as { id: string }).id, { answers: [DECIDE_YOURSELF] }]] : [])));
}
const json = (line: string): Record<string, any> | null => {
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
};
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, name, arguments: cut(JSON.stringify(args), MAX_ARGS) });
const result = (callId: string, name: string, output: string, isError: boolean): AdapterOut => ({ kind: "result", callId, name, output: cut(output, MAX_OUTPUT), isError });

/** A subagent's status in each tool's words, as the session says it. */
const TASK_STATUS: Record<string, AgentTaskStatus> = {
  pending: "running",
  pending_init: "running",
  running: "running",
  completed: "done",
  failed: "error",
  error: "error",
  errored: "error",
  not_found: "error",
  killed: "stopped",
  stopped: "stopped",
  cancelled: "stopped",
  interrupted: "stopped",
  shutdown: "stopped",
};

/**
 * Where each subagent stands, said once per change: Claude Code reports a finish twice (task_updated, then
 * task_notification with its summary), and Codex repeats every agent's state in each of its calls.
 */
function taskTracker() {
  const said = new Map<string, string>();
  return (t: Extract<AdapterOut, { kind: "task" }>): AdapterOut[] => {
    const key = `${t.status}|${t.summary ?? ""}`;
    const before = said.get(t.id);
    if (before === key || (before?.startsWith(`${t.status}|`) && !t.summary)) return [];
    said.set(t.id, key);
    return [t];
  };
}

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
/** A turn's tokens as the session counts them: `input` read fresh (cache writes included), `cached` read from a cache. */
const usage = (input: number, cached: number, output: number, ctx?: { context: number; window?: number }): AdapterOut[] =>
  input + cached + output > 0 ? [{ kind: "usage", input, cached, output, ...(ctx && ctx.context > 0 ? { context: ctx.context, ...(ctx.window ? { window: ctx.window } : {}) } : {}) }] : [];

const firstLine = (s: string) => (s.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 120);

const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
/**
 * A subagent's step, said the way its card says it while it works: "Reading Sidebar.tsx", "Running npm test" (Arun, 2026-10-27:
 * "add a better design for tracking subagents"). From the tool name and arguments claudeTool gives.
 */
export function subagentDoing(t: { name: string; args: Record<string, unknown> }): string {
  const a = t.args;
  const short = (v: unknown, n = 60) => {
    const x = firstLine(str(v));
    return x.length > n ? `${x.slice(0, n - 1)}…` : x;
  };
  switch (t.name) {
    case "shell":
      return `Running ${short(a.command)}`;
    case "read":
      return `Reading ${base(str(a.path))}`;
    case "edit":
    case "write":
      return `Editing ${base(str(a.path))}`;
    case "search":
      return `Searching for ${short(a.pattern, 40)}`;
    case "web_search":
      return `Searching the web for ${short(a.query, 48)}`;
    case "web_fetch":
      return `Reading ${short(str(a.url).replace(/^https?:\/\/(www\.)?/, ""), 48)}`;
    case "todo":
      return "Planning its steps";
    default:
      return `Using ${t.name.replace(/^mcp__/, "").replace(/__/g, " ")}`;
  }
}

// ── Claude Code ──────────────────────────────────────────────────────

/** Claude Code's command-running tools. */
const SHELL_TOOLS = ["Bash", "PowerShell"];
/**
 * What Auto lets Claude Code do without asking, beyond editing files: run commands, and read the web, as Codex and Cursor
 * can in Auto. Through --allowedTools, never by switching its permission checks off: those also guard which paths it may
 * write, and an organisation can forbid that switch outright.
 */
const AUTO_TOOLS = [...SHELL_TOOLS, "WebFetch", "WebSearch"];
/** An MCP server's tool, as Claude Code names it: allowed by name when a person says yes to a turn that wanted it. */
const MCP_TOOL = /^mcp__[\w.-]+__[\w.-]+$/;
/** What Plan never does, so never asks about: changing a file, or leaving Plan (the plan it wrote is the answer). */
export const PLAN_REFUSES = ["Edit", "MultiEdit", "Write", "NotebookEdit", "ExitPlanMode"];

/**
 * What a person is asked to say yes to, worded as the end-of-turn refusals are (see the parser's `result`), so the one can
 * be matched against the other. Commands exactly, since a yes to one is to that command; anything else described.
 */
export function askedItem(tool: string, input: Record<string, unknown>): { scope: "commands" | "turn"; item: string } {
  if (SHELL_TOOLS.includes(tool) || tool === "shell") return { scope: "commands", item: str(input.command).trim() };
  if (tool === "WebFetch" || tool === "web_fetch") return { scope: "turn", item: `fetch ${str(input.url)}`.trim() };
  if (tool === "WebSearch") return { scope: "turn", item: `search the web for “${str(input.query)}”` };
  // Codex wanting more than its sandbox gives (see `permissions` in `codex`).
  if (tool === "permissions") return { scope: "turn", item: `more access: ${str(input.description)}` };
  const p = str(input.file_path) || str(input.notebook_path) || str(input.path);
  return { scope: "turn", item: p ? `${tool} ${p}` : tool };
}

/** Claude Code tool names → the session's names, so every CLI's shell call is a "shell" card. */
function claudeTool(name: string, input: Record<string, unknown>): { name: string; args: Record<string, unknown> } {
  const p = str(input.file_path) || str(input.notebook_path) || str(input.path);
  switch (name) {
    // On Windows Claude Code runs commands with a PowerShell tool as well as Bash; both are the room's shell.
    case "Bash":
    case "PowerShell":
      return { name: "shell", args: { command: str(input.command), ...(input.description ? { description: input.description } : {}) } };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { name: "edit", args: { path: p, ...(input.old_string !== undefined ? { old_string: input.old_string, new_string: input.new_string } : {}) } };
    case "Write":
      return { name: "write", args: { path: p, content: cut(str(input.content), 2000) } };
    case "Read":
      return { name: "read", args: { path: p } };
    case "Grep":
    case "Glob":
      return { name: "search", args: { pattern: str(input.pattern), ...(p ? { path: p } : {}) } };
    case "WebSearch":
      return { name: "web_search", args: { query: str(input.query) } };
    case "WebFetch":
      return { name: "web_fetch", args: { url: str(input.url) } };
    case "TodoWrite":
      return { name: "todo", args: input };
    default:
      return { name, args: input };
  }
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (c && typeof c === "object" && c.type === "text" ? str(c.text) : "")).join("");
}

const withChrome = (t: TurnSpec) => (!!t.work || process.env.FRIDAY_MINE === "1") && offered(t, "--chrome");

/**
 * Claude Code's auto mode, as TurnSpec.skip names it once refused: a version from before it, or an account it isn't open to,
 * turns `--permission-mode auto` away, and from then on the lane's Work turns in Auto run as Auto does everywhere else (edits
 * allowed and Auto's tools by --allowedTools), rather than every one failing (Arun, 2026-10-28: "iron everything and ensure we
 * are good… any logic errors").
 */
export const AUTO_MODE = "--permission-mode=auto";

/** Whether Claude Code's failure is it turning auto mode away: its value refused for the flag, or the mode said to be unavailable. */
export const autoModeRefused = (error: string): boolean =>
  /permission[- ]mode[^\n]*\bauto\b[^\n]*(invalid|not (?:a )?valid|allowed choices|not allowed)/i.test(error) ||
  /\bauto mode\b[^\n]*(not (?:available|enabled|supported|allowed)|unavailable|isn't available|requires|disabled)/i.test(error);

/** Claude Code's own permission mode for a turn: Plan's, or edits allowed and the rest by --allowedTools. */
function claudeMode(t: TurnSpec): string {
  // A Work session in Auto runs in Claude Code's auto mode: every tool and connector it has, its own classifier in place of asking.
  if (t.work && t.mode === "full" && offered(t, AUTO_MODE)) return "auto";
  return t.mode === "plan" ? "plan" : "acceptEdits";
}

export const claude: Adapter = {
  tool: "claude",
  bins: ["claude"],
  dirs: true,
  login: ["auth", "login"],
  logout: ["auth", "logout"],
  status: { args: ["auth", "status", "--json"] },
  optional: ["--chrome"],
  args: (t) => [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    // No --bare: that skips the user's own login, which is the whole point.
    ...(t.model ? ["--model", t.model] : []),
    // A flag of the process, so the kept one (keyed on its arguments) starts again for the next turn when it changes.
    ...(t.effort ? ["--effort", t.effort] : []),
    "--permission-mode",
    claudeMode(t),
    // Claude in Chrome, the person's own browser with their sign-ins, when its extension is there: in a Work session, and in
    // every session of a build with FRIDAY_MINE set (local/start.ts); in Auto its tools run unasked, as the web's do.
    ...(withChrome(t) ? ["--chrome"] : []),
    ...(withChrome(t) && t.mode === "full" && claudeMode(t) !== "auto" ? ["--allowedTools", "mcp__claude-in-chrome"] : []),
    // Folders beside its own, one flag each: the flag takes several, and a value of its own never swallows the next flag.
    ...(t.dirs ?? []).flatMap((d) => ["--add-dir", d]),
    // What needs a yes is asked as a control_request on stdout, and the turn waits for the answer on stdin.
    // In Plan too: a command (mostly to look around) is put to a person; a change to a file is refused unasked (see the runner).
    ...(t.ask ? ["--permission-prompt-tool", "stdio"] : []),
    // Both shells: on Windows it reaches for PowerShell as often as Bash, and allowing only Bash left Auto refusing its commands.
    // A yes to a whole turn (asked when it was refused the web or an MCP tool) gives that turn what Auto has, and the MCP
    // tools it was refused by name.
    // Auto also lets it use the MCP servers set up for this folder, each allowed by server, as its own permission rules name them.
    ...(t.mode === "full" || t.grant?.scope === "turn"
      ? ["--allowedTools", ...AUTO_TOOLS, ...(t.mode === "full" ? (t.mcp ?? []).map((s) => `mcp__${s}`) : []), ...(t.grant?.scope === "turn" ? t.grant.items.filter((i) => MCP_TOOL.test(i)) : [])]
      : t.grant?.scope === "commands"
        ? ["--allowedTools", ...t.grant.items.flatMap((c) => SHELL_TOOLS.map((s) => `${s}(${c})`))]
        : []),
    // From a file when it is too long for the command line (the runner decides): Windows caps a whole one at 32,767 characters,
    // and an imported conversation alone came close to that. Others stay inline, which every version takes.
    // Friday's MCP server beside the person's own, its tools allowed in every mode: they only talk to the other agents here.
    ...(t.friday ? ["--mcp-config", claudeConfig(t.friday), "--allowedTools", "mcp__friday"] : []),
    // The person's skills in every mode, unasked: a skill is instructions to read, and anything it then runs or changes is
    // asked about as usual. In Manual a skill's use stopped the turn for a yes that told nobody anything.
    "--allowedTools",
    "Skill",
    ...(t.systemFile ? ["--append-system-prompt-file", t.systemFile] : ["--append-system-prompt", t.system]),
    ...(t.resumeId ? ["--resume", t.resumeId, ...(t.fork ? ["--fork-session"] : [])] : []),
  ],
  stdin: (t) => t.prompt,
  parser(t) {
    const names = new Map<string, string>();
    /** How much its last model call was handed (fresh, written to the cache and read from it): the context it is at now. */
    let context = 0;
    /** Its background tasks still running: a `result` while there are any is not the end of the turn. */
    const running = new Set<string>();
    const task = taskTracker();
    /**
     * The subagents it sent off, by the call that started them: what each is doing and how many steps it has taken, said on its
     * task at most every few seconds while it works, so its card and the status bar can follow it without the log filling up.
     */
    const subs = new Map<string, { id: string; steps: number; at: number }>();
    /**
     * Calls that sent a subagent off and haven't been matched to their task yet, oldest first: a task_started that doesn't name
     * its call is the next of these, so its steps still reach its row, which otherwise said "Starting…" until it came back
     * (Arun, 2026-10-28: "iron everything and ensure we are good… any logic errors and fixes").
     */
    const unmatched: string[] = [];
    /** What each command was, so a test that failed inside a chain is reported as failing. */
    const commands = new Map<string, string>();
    return (line) => {
      const m = json(line);
      if (!m) return [];
      switch (m.type) {
        case "system":
          noteBackground(running, m);
          // Its subagents and background commands, for the Tasks panel.
          if (m.task_id && (m.subtype === "task_started" || m.subtype === "task_updated" || m.subtype === "task_notification")) {
            const id = str(m.task_id);
            if (m.subtype === "task_started") {
              const named = str(m.tool_use_id);
              const at = named ? unmatched.indexOf(named) : -1;
              if (at >= 0) unmatched.splice(at, 1);
              const callId = named || (m.task_type !== "local_bash" && !m.is_backgrounded ? (unmatched.shift() ?? "") : "");
              if (callId && m.task_type !== "local_bash") subs.set(callId, { id, steps: 0, at: 0 });
              const agentType = str(m.subagent_type) || (m.task_type === "local_bash" ? "command" : "");
              return task({ kind: "task", id, status: "running", description: str(m.description) || firstLine(str(m.prompt)), ...(agentType ? { agentType } : {}), background: !!m.is_backgrounded });
            }
            const status = TASK_STATUS[str(m.patch?.status ?? m.status)];
            // Back: how many steps it took, said with how it ended.
            const steps = m.tool_use_id ? subs.get(str(m.tool_use_id))?.steps : undefined;
            return status ? task({ kind: "task", id, status, ...(str(m.summary) ? { summary: cut(str(m.summary), 2000) } : {}), ...(steps ? { steps } : {}) }) : [];
          }
          // A request that failed and will be tried again (an overloaded API, a dropped connection). Said where the room
          // can see it, or the lane sits silent for the minutes the retries take.
          if (m.subtype === "api_retry") {
            const why = m.error_status ? ` after HTTP ${m.error_status}` : " after a connection error";
            return [{ kind: "delta", channel: "reasoning", text: `\nRetrying the request (${m.attempt}/${m.max_retries})${why}, in ${Math.round((Number(m.retry_delay_ms) || 0) / 1000)}s…\n` }];
          }
          return m.subtype === "init" && m.session_id ? [{ kind: "session", id: String(m.session_id) }] : [];
        case "stream_event": {
          const e = m.event;
          // Subagent internals stream too; the room sees the subagent's result instead.
          if (m.parent_tool_use_id || e?.type !== "content_block_delta") return [];
          if (e.delta?.type === "text_delta") return [{ kind: "delta", text: str(e.delta.text), channel: "text" }];
          if (e.delta?.type === "thinking_delta") return [{ kind: "delta", text: str(e.delta.thinking), channel: "reasoning" }];
          return [];
        }
        case "assistant": {
          if (m.parent_tool_use_id) {
            // A subagent's own step: counted, and said on its task now and then.
            const sub = subs.get(str(m.parent_tool_use_id));
            const uses: any[] = Array.isArray(m.message?.content) ? m.message.content.filter((b: any) => b?.type === "tool_use") : [];
            if (!sub || !uses.length) return [];
            sub.steps += uses.length;
            const last = uses.at(-1);
            const doing = subagentDoing(claudeTool(str(last.name), last.input && typeof last.input === "object" ? last.input : {}));
            const now = Date.now();
            if (now - sub.at < 4000) return [];
            sub.at = now;
            return [{ kind: "task", id: sub.id, status: "running", doing, steps: sub.steps }];
          }
          const mu = m.message?.usage;
          if (mu) {
            const held = count(mu.input_tokens) + count(mu.cache_creation_input_tokens) + count(mu.cache_read_input_tokens);
            if (held > 0) context = held;
          }
          const blocks: any[] = Array.isArray(m.message?.content) ? m.message.content : [];
          const text = blocks.filter((b) => b?.type === "text").map((b) => str(b.text)).join("");
          const reasoning = blocks.filter((b) => b?.type === "thinking").map((b) => str(b.thinking)).join("");
          const toolCalls = blocks
            .filter((b) => b?.type === "tool_use")
            .map((b) => {
              const t = claudeTool(str(b.name), b.input && typeof b.input === "object" ? b.input : {});
              names.set(str(b.id), t.name);
              if (t.name === "shell") commands.set(str(b.id), str(t.args.command));
              if (/^(task|agent)$/i.test(str(b.name)) && b.input?.run_in_background !== true) unmatched.push(str(b.id));
              return call(str(b.id), t.name, t.args);
            });
          if (!text && !toolCalls.length && !reasoning) return [];
          return [{ kind: "message", text, toolCalls, ...(reasoning ? { reasoning } : {}) }];
        }
        case "user": {
          if (m.parent_tool_use_id) return [];
          const blocks: any[] = Array.isArray(m.message?.content) ? m.message.content : [];
          return blocks
            .filter((b) => b?.type === "tool_result")
            .map((b) => {
              const id = str(b.tool_use_id);
              const out = blockText(b.content);
              return result(id, names.get(id) ?? "tool", out, !!b.is_error || testFailedInChain(commands.get(id), out));
            });
        }
        case "rate_limit_event":
          noteClaudeEvent(m, t?.account);
          return [];
        case "control_request": {
          const r = m.request;
          if (r?.subtype !== "can_use_tool" || typeof m.request_id !== "string") return [];
          const why = str(r.decision_reason);
          return [{ kind: "ask", requestId: m.request_id, tool: str(r.tool_name), input: r.input && typeof r.input === "object" ? r.input : {}, ...(why ? { why } : {}) }];
        }
        case "result": {
          const out: AdapterOut[] = m.session_id ? [{ kind: "session", id: String(m.session_id) }] : [];
          const denials: any[] = Array.isArray(m.permission_denials) ? m.permission_denials : [];
          // Commands it asked to run and was refused: a person can say yes to those.
          const denied: string[] = denials.flatMap((d: any) => (SHELL_TOOLS.includes(d?.tool_name) && typeof d?.tool_input?.command === "string" ? [d.tool_input.command.trim()] : []));
          // The web and MCP tools were refused without a word: nothing asked, and the agent just said it couldn't. They
          // can't be allowed one call at a time from here, so a yes is to the turn, as with Codex and Cursor.
          const tools: string[] = denials.flatMap((d: any) => {
            const name = str(d?.tool_name);
            if (name === "WebFetch") return [`fetch ${str(d.tool_input?.url)}`.trim()];
            if (name === "WebSearch") return [`search the web for “${str(d.tool_input?.query)}”`];
            return MCP_TOOL.test(name) ? [name] : [];
          });
          if (tools.length) out.push({ kind: "blocked", scope: "turn", items: [...new Set([...denied, ...tools])].slice(0, 6) });
          else if (denied.length) out.push({ kind: "blocked", scope: "commands", items: [...new Set(denied)].slice(0, 6) });
          // Per turn (its cost is the whole process's so far, so it isn't used): fresh input with what it wrote to the cache.
          const u = m.usage ?? {};
          // The window of the model that did the turn's work: the one that read the most, of those it reports (a background
          // Haiku reads little).
          const models: any[] = Object.values(m.modelUsage && typeof m.modelUsage === "object" ? m.modelUsage : {});
          const main = models.sort((a, b) => count(b?.inputTokens) + count(b?.cacheReadInputTokens) - count(a?.inputTokens) - count(a?.cacheReadInputTokens))[0];
          out.push(...usage(count(u.input_tokens) + count(u.cache_creation_input_tokens), count(u.cache_read_input_tokens), count(u.output_tokens), { context, window: count(main?.contextWindow) }));
          // Said while its background tasks still run: it carries on by itself when they finish (see noteBackground).
          const held = running.size > 0 && !m.is_error;
          if (held) out.push({ kind: "delta", channel: "reasoning", text: `\nWaiting for ${running.size === 1 ? "a background task" : `${running.size} background tasks`} to finish…\n` });
          out.push({ kind: "done", ...(m.is_error ? { error: str(m.result) || str(m.subtype) || "Claude Code reported an error." } : {}), ...(held ? { held: true } : {}) });
          return out;
        }
      }
      return [];
    };
  },
  explain(e) {
    // "authenticat" on purpose: the CLI says "authentication" in one version
    // and "Re-authenticate" in another, and an expired token says neither.
    if (/not logged in|\/login|invalid api key|authenticat|token has expired|oauth/i.test(e))
      return "Claude Code isn't signed in on the computer it runs on, or its login has expired. Run `claude auth login` in a terminal there, then send the instruction again. Signing in to the Claude app doesn't sign in Claude Code.";
    // Before the limit check: the conversation's id is in these messages, and an id can contain "429".
    if (/is running as a background session/i.test(e))
      return "That Claude Code conversation is still running as a background agent on the computer it runs on (`claude agents` lists it), so it can't be carried on here too. Stop it there, then send the instruction again.";
    // Only Claude Code's own words ("No conversation found with session ID", "No conversation found to continue"): a looser match
    // took a hook's "command not found" for it, and the conversation was let go for good.
    if (/no conversation found/i.test(e)) return "Claude Code couldn't find its earlier conversation, so the next instruction starts a fresh one.";
    // The limit belongs to the Claude account that machine is signed in as —
    // not to Friday, and not to whoever is driving the session.
    // Claude Code says it as "5-hour limit reached ∙ resets 3pm" and "Weekly limit reached", which the older words missed, so
    // the run ended on the bare message with nothing about what to do.
    if (/usage limit|session limit|limit reached|hit your limit|weekly limit|5-hour limit|rate limit|quota|too many requests|\b429\b/i.test(e))
      return `${e.trim()} — that's the limit on the Claude account this machine's Claude Code is signed in as, not on Friday or on whoever is driving. Have it carry on when the limit resets, or hand the work to another agent (both are under this run), or sign in as another account with \`claude auth login\`.`;
    return e;
  },
};

/**
 * The MCP servers Claude Code has for a folder: the person's own (~/.claude.json), those set up for that folder alone
 * (its entry in the same file) and the project's (.mcp.json). Named as Claude Code names them in its tool names.
 *
 * Auto runs without asking, but Claude Code still asks before an MCP tool, and with nobody to answer in -p it was refused
 * without a word: the agent just said it couldn't. Allowing each server by name is what its permission rules offer.
 * ponytail: servers that come with plugins or an organisation's managed settings aren't read; they are still refused in Auto.
 */
export async function claudeMcpServers(cwd: string): Promise<string[]> {
  // A file that is broken, or caught half written (Claude Code rewrites ~/.claude.json all the time), is read as none: a parse
  // error thrown here rejected the whole lookup, failing every Auto turn and, unhandled, taking the runner down with it.
  const read = (file: string) =>
    readFile(file, "utf8")
      .then((s) => JSON.parse(s) as Record<string, any>)
      .catch(() => null);
  const [mine, project] = await Promise.all([read(path.join(homedir(), ".claude.json")), read(path.join(cwd, ".mcp.json"))]);
  // Claude Code keys its folders with forward slashes, on Windows too.
  const here = mine?.projects?.[cwd] ?? mine?.projects?.[cwd.replace(/\\/g, "/")];
  const names = [mine?.mcpServers, here?.mcpServers, project?.mcpServers].flatMap((s) => (s && typeof s === "object" ? Object.keys(s) : []));
  return [...new Set(names.map((n) => n.replace(/[^\w-]/g, "_")))].sort();
}

// ── Codex ────────────────────────────────────────────────────────────

/**
 * Codex's subagents (spawn_agent, wait_agent…), each call carrying the state of every agent it touches. Only the new ones and
 * the changes go on: the Tasks panel keeps the rest. The same for `exec --json` and the app-server, which name the fields alike.
 */
function collabAgents(): (it: Record<string, any>) => AdapterOut[] {
  const task = taskTracker();
  /** What each agent it started was asked to do, by thread: only its spawn_agent call says. */
  const asked = new Map<string, string>();
  return (it) => {
    const states: Record<string, any> = it.agents_states && typeof it.agents_states === "object" ? it.agents_states : {};
    const ids = new Set<string>([...(Array.isArray(it.receiver_thread_ids) ? it.receiver_thread_ids.map(String) : []), ...Object.keys(states)]);
    return [...ids].flatMap((id) => {
      const status = TASK_STATUS[str(states[id]?.status)] ?? (it.tool === "spawn_agent" ? "running" : undefined);
      if (!status) return [];
      const fresh = !asked.has(id);
      if (fresh) asked.set(id, it.tool === "spawn_agent" ? firstLine(str(it.prompt)) : "");
      const description = fresh ? asked.get(id) : "";
      const summary = str(states[id]?.message);
      return task({ kind: "task", id, status, ...(description ? { description } : {}), ...(summary ? { summary: cut(summary, 2000) } : {}) });
    });
  };
}

/**
 * Codex run as `codex exec --json`, one process a turn: how every turn ran before its app-server (see `codex` below), and how a
 * Codex too old to have one still runs.
 */
export const codexExec: Adapter = {
  tool: "codex",
  bins: ["codex"],
  dirs: true,
  login: ["login"],
  logout: ["logout"],
  status: { args: ["login", "status"] },
  args: (t) => {
    // Codex's own sandbox does the gating: read-only, or writes confined to the folder.
    // Manual is read-only until a person says yes to the turn: Codex cannot ask about one command at a time.
    const writes = t.mode === "full" || (t.mode === "edits" && !!t.grant);
    // --skip-git-repo-check: Codex refuses to start outside a git repository unless told otherwise, which stopped it picking up a conversation that was
    // in any other kind of folder. Whether the folder is a repository is the runner's to know and say (it tracks changes against a snapshot when not).
    /**
     * On Windows, once it may change things, its commands run as the person, the way Claude Code's and Cursor's do then. Codex's
     * Windows sandbox runs them as another account that may not look at the person's own profile folder, and Node resolves
     * every folder above a script: in a folder under C:\Users\<name> (Friday's worktrees, most people's repos) every npm script
     * and Node tool failed with "EPERM: lstat 'C:\Users\<name>'", and a yes couldn't help. Until then it stays read-only.
     */
    // So on Windows its shell commands are NOT confined to the folder once it may write: only its own file changes are held to it.
    const sandbox = !writes ? "read-only" : process.platform === "win32" ? "danger-full-access" : "workspace-write";
    // One argument for the whole setting, so its quotes reach Codex as written on Windows too.
    const base = [...(t.friday ? codexConfig(t.friday) : []), ...codexExtras(t), "exec", "--json", "--skip-git-repo-check", ...(t.model ? ["--model", t.model] : []), ...(t.effort ? ["-c", `model_reasoning_effort="${t.effort}"`] : []), "--sandbox", sandbox];
    if (t.mode === "full" && sandbox === "workspace-write") base.push("-c", "sandbox_workspace_write.network_access=true");
    // The folders beside its own, writable as the folder is. Read-only reads them anyway, and danger-full-access holds it to none.
    if (sandbox === "workspace-write") for (const d of t.dirs ?? []) base.push("--add-dir", d);
    // Attached pictures as pictures. `--image` takes several values, so each is given with `=`: written apart, the next one
    // would swallow the `-` that says the prompt is on stdin. After `resume`, its own `--image` attaches to the prompt it sends.
    const pics = images(t).map((f) => `--image=${f}`);
    return t.resumeId ? [...base, "resume", t.resumeId, ...pics, "-"] : [...base, ...pics, "-"];
  },
  // Codex has no system-prompt flag, so the standing note leads the turn it is new to (see `withSystem`).
  stdin: (t) => ((t.withSystem ?? !t.resumeId) ? `${t.system}\n\n${PROMPT_MARK}\n${t.prompt}` : t.prompt),
  prespawn: true,
  parser() {
    const started = new Set<string>();
    const agents = collabAgents();
    // What the sandbox refused this turn, for the Manual approval.
    const blocked: string[] = [];
    /** What has been shown of each message still being written (item.updated). */
    const shown = new Map<string, string>();
    return (line) => {
      const m = json(line);
      if (!m) return [];
      const it = m.item ?? {};
      const id = str(it.id);
      switch (m.type) {
        case "thread.started":
          return m.thread_id ? [{ kind: "session", id: String(m.thread_id) }] : [];
        case "item.started": {
          if (it.type === "collab_tool_call") return agents(it);
          const c = codexCall(it);
          if (!c) return [];
          started.add(id);
          return [{ kind: "message", text: "", toolCalls: [c] }];
        }
        // A message or its reasoning, as far as it has been written: the new part is shown as it comes, and the whole is the
        // message once it is complete. Only what extends what was shown; a rewrite waits for the whole.
        case "item.updated": {
          if (it.type === "collab_tool_call") return agents(it);
          if (it.type !== "agent_message" && it.type !== "reasoning") return [];
          const text = str(it.text);
          const had = shown.get(id) ?? "";
          if (!text.startsWith(had) || text.length === had.length) return [];
          shown.set(id, text);
          return [{ kind: "delta", text: text.slice(had.length), channel: it.type === "reasoning" ? "reasoning" : "text" }];
        }
        case "item.completed": {
          shown.delete(id);
          if (it.type === "collab_tool_call") return agents(it);
          if (it.type === "agent_message") return str(it.text) ? [{ kind: "message", text: str(it.text), toolCalls: [] }] : [];
          if (it.type === "reasoning") return str(it.text) ? [{ kind: "message", text: "", toolCalls: [], reasoning: str(it.text) }] : [];
          const c = codexCall(it);
          if (!c) return [];
          const out: AdapterOut[] = started.has(id) ? [] : [{ kind: "message", text: "", toolCalls: [c] }];
          out.push(codexResult(it, c.name));
          const refused = it.status === "declined" || (it.status === "failed" && (it.type === "file_change" || /denied|read-only|not permitted|permission|sandbox|EPERM/i.test(str(it.aggregated_output))));
          if (refused) blocked.push(it.type === "file_change" ? `edit ${(Array.isArray(it.changes) ? it.changes : []).map((x: any) => str(x.path)).join(", ")}` : codexCommand(str(it.command)));
          return out;
        }
        case "turn.completed": {
          // Its input counts what it read from the cache as well.
          const u = m.usage ?? {};
          const cached = count(u.cached_input_tokens);
          return [...usage(Math.max(0, count(u.input_tokens) - cached), cached, count(u.output_tokens)), ...(blocked.length ? [{ kind: "blocked" as const, scope: "turn" as const, items: [...new Set(blocked)].slice(0, 6) }] : []), { kind: "done" }];
        }
        case "turn.failed":
          return [{ kind: "done", error: str(m.error?.message) || "Codex couldn't finish the turn." }];
        case "error":
          // "Reconnecting… 2/5" and the like: shown as it happens, not only if the turn then fails.
          return str(m.message) ? [{ kind: "note", text: str(m.message) }, { kind: "delta", channel: "reasoning", text: `\n${str(m.message)}\n` }] : [];
      }
      return [];
    };
  },
  explain(e) {
    // What `codex exec resume` says for a conversation that was archived or deleted. First, because the id in it can contain "401".
    // Only this: a thread that is still open in Codex fails to resume too, and that conversation is fine to keep.
    if (/no rollout found|no saved session found/i.test(e)) return "Codex couldn't find its earlier conversation, so the next instruction starts a fresh one.";
    if (/log ?in|not authenticated|unauthorized|\b401\b/i.test(e)) return "Codex isn't logged in on the computer it runs on. Run `codex login` there, then send the instruction again.";
    if (/not.*git repo|trusted directory/i.test(e)) return "Codex only runs inside a git repository. Point the runner at a repo folder.";
    return e;
  },
};

/**
 * The command inside the shell Codex wrapped it in.
 *
 * Codex reports what it spawned: `"C:\\WINDOWS\\…\\powershell.exe" -Command 'npm test'` on Windows, `/bin/bash -lc 'npm test'`
 * elsewhere. The person asked for `npm test`, and a yes is a yes to that. Anything with quoting inside is left as it was.
 */
const SHELL_NAME = String.raw`(?:powershell|pwsh|bash|zsh|sh)(?:\.exe)?`;
const SHELL_WRAP = new RegExp(String.raw`^(?:"(?:[^"]*[\\/])?${SHELL_NAME}"|(?:\S*[\\/])?${SHELL_NAME})\s+(?:-NoProfile\s+)?(?:-Command|-lc|-c)\s+(['"])((?:(?!\1)[\s\S])*)\1$`, "i");
export const codexCommand = (raw: string): string => SHELL_WRAP.exec(raw.trim())?.[2] ?? raw;

function codexCall(it: Record<string, any>): ToolCall | null {
  const id = str(it.id);
  switch (it.type) {
    case "command_execution":
      return call(id, "shell", { command: codexCommand(str(it.command)) });
    case "file_change": {
      const changes: any[] = Array.isArray(it.changes) ? it.changes : [];
      return call(id, "edit", { path: changes.map((c) => str(c.path)).join(", "), changes });
    }
    case "mcp_tool_call":
      return call(id, `mcp__${str(it.server)}__${str(it.tool)}`, it.arguments && typeof it.arguments === "object" ? it.arguments : {});
    case "web_search":
      return call(id, "web_search", { query: str(it.query) });
  }
  return null;
}

function codexResult(it: Record<string, any>, name: string): AdapterOut {
  const id = str(it.id);
  const failed = it.status === "failed" || it.status === "declined";
  switch (it.type) {
    case "command_execution":
      return result(id, name, str(it.aggregated_output) || (failed ? "Command failed." : ""), failed || (typeof it.exit_code === "number" && it.exit_code !== 0) || testFailedInChain(codexCommand(str(it.command)), str(it.aggregated_output)));
    case "file_change": {
      const changes: any[] = Array.isArray(it.changes) ? it.changes : [];
      return result(id, name, changes.map((c) => `${str(c.kind) || "update"} ${str(c.path)}`).join("\n") || "No files changed.", failed);
    }
    case "mcp_tool_call":
      return result(id, name, JSON.stringify(it.error ?? it.result ?? {}), failed || !!it.error);
    default:
      return result(id, name, failed ? "Failed." : "Done.", failed);
  }
}

// ── Codex over its app-server ────────────────────────────────────────

/** App-server items as the `exec --json` parser knows them, so one set of card and result rules serves both. */
const APP_TYPE: Record<string, string> = { commandExecution: "command_execution", fileChange: "file_change", mcpToolCall: "mcp_tool_call", webSearch: "web_search", collabAgentToolCall: "collab_tool_call" };
const APP_STATUS: Record<string, string> = { inProgress: "in_progress", completed: "completed", failed: "failed", declined: "declined" };
function legacyItem(it: Record<string, any>): Record<string, any> {
  return { ...it, type: APP_TYPE[str(it.type)] ?? it.type, status: APP_STATUS[str(it.status)] ?? it.status, aggregated_output: it.aggregatedOutput, exit_code: it.exitCode, agents_states: it.agentsStates, receiver_thread_ids: it.receiverThreadIds };
}

/** What a reasoning item says, its summary first: its content is the long form, shown only when there is no summary. */
function reasoningText(it: Record<string, any>): string {
  const lines = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : str(x?.text))).filter(Boolean) : []);
  const summary = lines(it.summary);
  return (summary.length ? summary : lines(it.content)).join("\n").trim();
}

/**
 * The sandbox and the asking a turn runs under, as the app-server takes them per turn: what `codexExec` passes as flags. Manual,
 * which asks one thing at a time, keeps the sandbox read-only and has Codex ask for anything beyond it, so each command (and, in
 * Plan, each change to a file) is put to a person as it comes up rather than refused and reported once the turn is over.
 */
function appPolicy(t: TurnSpec): { sandboxPolicy: Record<string, unknown>; approvalPolicy: string } {
  const writes = t.mode === "full" || (t.mode === "edits" && !!t.grant);
  // On Windows its sandbox runs commands as another account that can't look at the person's own profile folder (see codexExec).
  // dangerFullAccess there confines nothing to the folder: whenever it writes, approvalPolicy is "never", so Codex never asks and
  // the grantRoot check in `approval` (in `codex`) never runs. Neither its shell commands nor its file changes are held to the folder.
  const sandboxPolicy: Record<string, unknown> = !writes ? { type: "readOnly", networkAccess: true } : process.platform === "win32" ? { type: "dangerFullAccess" } : { type: "workspaceWrite", networkAccess: t.mode === "full", writableRoots: t.dirs ?? [] };
  // A Work session reaches the web whenever it may write, in Edits as in Auto.
  if (t.work && sandboxPolicy.type === "workspaceWrite") sandboxPolicy.networkAccess = true;
  // Auto asks too, and Friday answers yes itself (see `approval` in `codex`): Codex stays in its sandbox until something needs
  // more, then goes beyond it as it would for a person who always approves. With "never" a command that needed more (a global
  // install, a cache outside the folder) just failed in Auto, with nobody to ask (Arun, 2026-10-18).
  return { sandboxPolicy, approvalPolicy: t.mode === "full" || (t.ask && !writes) ? "on-request" : "never" };
}

/** Settings the session adds to Codex's own, as `-c` overrides ahead of the subcommand. */
function codexExtras(t: TurnSpec): string[] {
  // A Work session: live web search, and the network in its sandbox whenever it may write.
  if (t.work) return ["-c", 'web_search="live"', "-c", "sandbox_workspace_write.network_access=true"];
  void t;
  return [];
}

/** What Codex asks for when it wants more reach than its sandbox gives (`item/permissions/requestApproval`), in a few words. */
function morePermissions(p: Record<string, any> | undefined): string {
  const fs = p?.fileSystem ?? {};
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  const bits = [
    ...(p?.network?.enabled ? ["the network"] : []),
    ...(list(fs.write).length ? [`writing to ${list(fs.write).join(", ")}`] : []),
    ...(list(fs.read).length ? [`reading ${list(fs.read).join(", ")}`] : []),
  ];
  return bits.join("; ") || "more access than its sandbox gives";
}

type Rpc = { result?: any; error?: { code?: number; message?: string } };

/**
 * Codex spoken to over its app-server: one process kept for the lane (see WarmAcp, dialect "codex"), a thread started or resumed
 * in it once, and a turn per instruction. Unlike `codex exec --json`, which says a message only once it is whole, this streams it
 * as it is written (item/agentMessage/delta), and asks about one command or file change at a time, so Manual can answer each.
 * JSON-RPC 2.0 over stdio, one message a line, with the `jsonrpc` field left off as its own docs do.
 */
export const codex: Adapter = {
  tool: "codex",
  bins: ["codex"],
  dirs: true,
  login: ["login"],
  logout: ["logout"],
  status: { args: ["login", "status"] },
  dialect: "codex",
  // Friday's MCP server as `-c` settings ahead of the subcommand (friday-mcp.ts).
  args: (t) => [...(t.friday ? codexConfig(t.friday) : []), ...codexExtras(t), "app-server"],
  interactive: true,
  stdin: () => `${JSON.stringify({ id: 0, method: "initialize", params: { clientInfo: { name: "friday", title: "Friday", version: "1" } } })}\n`,
  parser(t, io) {
    if (!t || !io) return () => [];
    const turn = t;
    const wire = io;
    const kept = io.kept;
    const line = (msg: Record<string, unknown>) => `${JSON.stringify(msg)}\n`;
    const keep = (patch: Record<string, unknown>) => {
      if (kept) kept.res = { ...kept.res, ...patch };
    };
    const waiting = new Map<number, (r: Rpc) => AdapterOut[]>();
    const ask = (method: string, params: unknown, then: (r: Rpc) => AdapterOut[]) => {
      const id = acpIds++;
      waiting.set(id, then);
      wire.write(line({ id, method, params }));
    };
    let tid = kept?.sessionId ?? "";
    let turnId = "";
    /** Stop came after the turn was asked for and before Codex named it: interrupted as soon as it does. */
    let cancelWanted = false;
    let turnAsked = false;
    const interruptIfWanted = () => {
      if (cancelWanted && tid && turnId) ask("turn/interrupt", { threadId: tid, turnId }, () => []);
    };
    let over = false;
    let text = "";
    let thought = "";
    const agents = collabAgents();
    /** Calls whose card is in the feed, and each card's name, for its result. */
    const drawn = new Set<string>();
    /** Approvals not yet answered, by their JSON-RPC id. */
    const open = new Map<string | number, (allow: boolean | null) => void>();
    const blocked: { scope: "commands" | "turn"; item: string }[] = [];
    /** Tokens as the thread counts them, in all: this turn's are what it counts at the end less what it counted as the turn began. */
    type Tok = { input: number; cached: number; output: number };
    const tok = (b: any): Tok => ({ input: count(b?.inputTokens), cached: count(b?.cachedInputTokens), output: count(b?.outputTokens) });
    let base: Tok | null = kept?.res?.tokenTotals ?? null;
    let total: Tok | null = null;
    let lastCall: { context: number; window: number } | null = null;

    const step = (toolCalls: ToolCall[]): AdapterOut[] => {
      if (!text && !thought && !toolCalls.length) return [];
      const out: AdapterOut = { kind: "message", text, toolCalls, ...(thought ? { reasoning: thought } : {}) };
      text = "";
      thought = "";
      return [out];
    };
    const finish = (error?: string): AdapterOut[] => {
      if (over) return [];
      over = true;
      for (const answer of [...open.values()]) answer(null);
      wire.end();
      const items = blocked.slice(0, 6);
      return [
        ...step([]),
        ...(items.length ? [{ kind: "blocked" as const, scope: items.every((b) => b.scope === "commands") ? ("commands" as const) : ("turn" as const), items: [...new Set(items.map((b) => b.item))] }] : []),
        { kind: "done", ...(error ? { error } : {}) },
      ];
    };
    const failed = (what: string, e: { code?: number; message?: string } | undefined) => finish(`${what}: ${str(e?.message) || `error ${e?.code}`}`);

    /** The instruction, as this turn: its model and effort, and what it may do, go with it. */
    const go = (): AdapterOut[] => {
      const { sandboxPolicy, approvalPolicy } = appPolicy(turn);
      turnAsked = true;
      // Its own /review and /compact, as its terminal runs them: a review of the changes in this thread (it reads, and asks as any
      // turn does), or the conversation summarised to free up room. Each is a turn of its own, which ends as any turn does.
      if (turn.command) {
        const review = turn.command.name === "review";
        ask(review ? "review/start" : "thread/compact/start", review ? { threadId: tid, target: reviewTarget(turn.command.args), delivery: "inline" } : { threadId: tid }, (r) => {
          if (r.error) return failed(review ? "The review couldn't start" : "Compacting the conversation failed", r.error);
          turnId ||= str(r.result?.turn?.id);
          interruptIfWanted();
          return [];
        });
        return [];
      }
      // Attached pictures as pictures (its `localImage` input), beside the text that names them.
      const input = [{ type: "text", text: notedPrompt(turn) }, ...images(turn).map((p) => ({ type: "localImage", path: p }))];
      ask("turn/start", { threadId: tid, input, cwd: wire.cwd, sandboxPolicy, approvalPolicy, ...(turn.model ? { model: turn.model } : {}), ...(turn.effort ? { effort: turn.effort } : {}) }, (r) => {
        if (r.error) return failed("The turn failed", r.error);
        turnId ||= str(r.result?.turn?.id);
        interruptIfWanted();
        return [];
      });
      return [];
    };
    const opened = (how: "start" | "resume" | "fork") => (s: Rpc): AdapterOut[] => {
      // Open in another program as well (the ChatGPT app's Codex, a terminal): Codex lets one writer have a conversation, so it
      // carries on from a copy of it, its memory with a new id, rather than not at all (Arun, 2026-10-26: Codex "couldn't find its
      // earlier conversation" while it was open in the Codex app).
      if (how === "resume" && turn.resumeId && /active writer/i.test(s.error?.message ?? "")) {
        ask("thread/fork", { threadId: turn.resumeId, cwd: wire.cwd }, opened("fork"));
        return [];
      }
      if (s.error) return failed(how === "start" ? "It couldn't start a conversation" : `thread/${how} failed`, s.error);
      tid = str(s.result?.thread?.id);
      if (!tid) return finish("It didn't start a conversation.");
      if (kept) Object.assign(kept, { sessionId: tid, res: s.result ?? {}, fresh: false });
      return [{ kind: "session" as const, id: tid }, ...go()];
    };
    const openThread = (): AdapterOut[] => {
      // A copy of it when the thread itself is busy elsewhere (see Runner.turn), as Claude Code's --fork-session: its memory, a new id.
      if (turn.resumeId && turn.fork) ask("thread/fork", { threadId: turn.resumeId, cwd: wire.cwd }, opened("fork"));
      else if (turn.resumeId) ask("thread/resume", { threadId: turn.resumeId, cwd: wire.cwd }, opened("resume"));
      else ask("thread/start", { cwd: wire.cwd, serviceName: "friday" }, opened("start"));
      return [];
    };
    const initialized = (r: Rpc): AdapterOut[] => {
      if (r.error) return failed("It couldn't start", r.error);
      wire.write(line({ method: "initialized", params: {} }));
      return openThread();
    };
    /** What a kept Codex's turn says before its first line: its turn starts as the parser does. */
    let early: AdapterOut[] = [];
    if (!kept) waiting.set(0, initialized);
    else if (kept.sessionId && !turn.fork && (kept.sessionId === turn.resumeId || (!turn.resumeId && kept.fresh))) {
      kept.fresh = false;
      early = [...(turn.resumeId === tid ? [] : [{ kind: "session" as const, id: tid }]), ...go()];
    } else early = openThread();

    /** Whether a yes already given covers this: the whole turn, or this very command. */
    const granted = (name: string, args: Record<string, unknown>) => turn.grant?.scope === "turn" || (turn.grant?.scope === "commands" && name === "shell" && turn.grant.items.includes(str(args.command)));
    /** Codex asking whether it may: a command, or a change to a file. Answered as Manual answers, or by a person, mid-turn. */
    const approval = (id: string | number, method: string, params: Record<string, any> | undefined): AdapterOut[] => {
      const command = method === "item/commandExecution/requestApproval";
      const card = command ? { name: "shell", args: { command: codexCommand(str(params?.command)) } } : { name: "edit", args: { path: str(params?.grantRoot) || wire.cwd } };
      const answer = (allow: boolean | null) => {
        if (!open.delete(id)) return;
        wire.write(line({ id, result: { decision: allow ? "accept" : allow === null ? "cancel" : "decline" } }));
      };
      open.set(id, answer);
      // Its card first, so the question has something to point at; the result draws it again otherwise.
      const itemId = str(params?.itemId);
      const first = itemId && !drawn.has(itemId) ? (drawn.add(itemId), step([call(itemId, card.name, card.args)])) : [];
      // A change to a file needs nobody in Edits, as long as it stays in the folder or one given beside it: one asking to write
      // beyond them (grantRoot elsewhere) is put to a person like a command, or refused when there is nobody to ask. Plan never
      // changes one.
      const grantRoot = str(params?.grantRoot);
      const inFolder = !grantRoot || [wire.cwd, ...(turn.dirs ?? [])].some((d) => contains(d, grantRoot));
      if (turn.mode === "full" || (!command && turn.mode === "edits" && inFolder) || granted(card.name, card.args)) {
        answer(true);
        return first;
      }
      if (turn.mode === "plan" && !command) {
        answer(false);
        return first;
      }
      if (turn.ask) return [...first, { kind: "ask", requestId: String(id), tool: card.name, input: card.args, ...(str(params?.reason) ? { why: str(params?.reason) } : {}), reply: (allow) => answer(allow) }];
      answer(false);
      blocked.push(askedItem(card.name, card.args));
      return first;
    };

    /**
     * Codex asking for more reach than its sandbox gives it (`item/permissions/requestApproval`: the network, or a folder to
     * read or write). Granted for the turn in Auto, put to a person in Manual (and in Plan, unless it wants to write), refused
     * and reported otherwise. It was answered "Friday doesn't offer" before, which failed whatever asked, in every mode.
     */
    const permissions = (id: string | number, params: Record<string, any> | undefined): AdapterOut[] => {
      const asked: Record<string, any> = params?.permissions ?? {};
      const granted = { ...(asked.network ? { network: asked.network } : {}), ...(asked.fileSystem ? { fileSystem: asked.fileSystem } : {}) };
      const answer = (allow: boolean | null) => {
        if (!open.delete(id)) return;
        wire.write(line({ id, result: { permissions: allow ? granted : {}, scope: "turn" } }));
      };
      open.set(id, answer);
      const description = morePermissions(asked);
      const writes = (Array.isArray(asked.fileSystem?.write) && asked.fileSystem.write.length > 0) || (Array.isArray(asked.fileSystem?.entries) && asked.fileSystem.entries.length > 0);
      if (turn.mode === "full" || turn.grant?.scope === "turn") {
        answer(true);
        return [];
      }
      if (turn.mode === "plan" && writes) {
        answer(false);
        return [];
      }
      if (turn.ask) return [{ kind: "ask", requestId: String(id), tool: "permissions", input: { description }, ...(str(params?.reason) ? { why: str(params?.reason) } : {}), reply: (allow) => answer(allow) }];
      answer(false);
      blocked.push(askedItem("permissions", { description }));
      return [];
    };

    /**
     * An MCP server asking, through Codex, before it goes on (`mcpServer/elicitation/request`): how Codex puts its MCP tools'
     * approvals, among other things. A yes or no is answered by the mode, as a command is; a form with fields to fill, or a page
     * to open, is something nobody here can do for the person, so it is declined, and said.
     */
    const elicit = (id: string | number, params: Record<string, any> | undefined): AdapterOut[] => {
      const server = str(params?.serverName) || "server";
      const message = str(params?.message);
      const fields = params?.mode === "url" || (Array.isArray(params?.requestedSchema?.required) && params.requestedSchema.required.length > 0);
      const answer = (allow: boolean | null) => {
        if (!open.delete(id)) return;
        wire.write(line({ id, result: { action: allow ? "accept" : allow === null ? "cancel" : "decline", content: allow ? {} : null, _meta: null } }));
      };
      open.set(id, answer);
      if (fields) {
        answer(false);
        const where = params?.mode === "url" && str(params?.url) ? ` (${str(params.url)})` : "";
        return [{ kind: "delta", channel: "reasoning", text: `\nThe ${server} MCP server asked for something only a person can give${where}${message ? `: ${message}` : ""}. Declined here.\n` }];
      }
      // Friday's own tools only reach the agents and people in this session (messages, the board, the preview): never asked
      // about in any mode, as Claude Code is let use them in every mode. A turn held to Edits asked for each one otherwise.
      if (server === "friday" || turn.mode === "full" || turn.grant?.scope === "turn") {
        answer(true);
        return [];
      }
      const tool = `mcp__${server}`;
      if (turn.ask) return [{ kind: "ask", requestId: String(id), tool, input: message ? { message } : {}, ...(message ? { why: message } : {}), reply: (allow) => answer(allow) }];
      answer(false);
      blocked.push({ scope: "turn", item: tool });
      return [];
    };

    const notice = (method: string, p: Record<string, any> | undefined): AdapterOut[] => {
      switch (method) {
        case "thread/started":
          tid ||= str(p?.thread?.id);
          return [];
        case "turn/started":
          turnId = str(p?.turn?.id) || turnId;
          interruptIfWanted();
          return [];
        case "item/agentMessage/delta": {
          const s = str(p?.delta);
          if (!s) return [];
          text += s;
          return [{ kind: "delta", text: s, channel: "text" }];
        }
        case "item/reasoning/textDelta":
        case "item/reasoning/summaryTextDelta": {
          const s = str(p?.delta);
          if (!s) return [];
          thought += s;
          return [{ kind: "delta", text: s, channel: "reasoning" }];
        }
        case "item/started": {
          const it = legacyItem(p?.item ?? {});
          if (it.type === "collab_tool_call") return agents(it);
          const c = codexCall(it);
          if (!c || drawn.has(c.id)) return [];
          drawn.add(c.id);
          return step([c]);
        }
        case "item/completed": {
          const raw: Record<string, any> = p?.item ?? {};
          const it = legacyItem(raw);
          if (it.type === "collab_tool_call") return agents(it);
          // What /review found, whole as it leaves review mode; and word that /compact did its work.
          if (it.type === "exitedReviewMode") return str(raw.review) ? [...step([]), { kind: "message", text: str(raw.review), toolCalls: [] }] : [];
          if (it.type === "contextCompaction") return [{ kind: "message", text: "Compacted the conversation so far, to make room for what comes next.", toolCalls: [] }];
          // Said whole once it is complete: the message, where its pieces were the live preview.
          if (it.type === "agentMessage") {
            text = "";
            return str(it.text) ? [{ kind: "message", text: str(it.text), toolCalls: [] }] : [];
          }
          if (it.type === "reasoning") {
            const r = reasoningText(raw);
            thought = "";
            return r ? [{ kind: "message", text: "", toolCalls: [], reasoning: r }] : [];
          }
          const c = codexCall(it);
          if (!c) return [];
          const out: AdapterOut[] = drawn.has(c.id) ? [] : (drawn.add(c.id), step([c]));
          out.push(codexResult(it, c.name));
          const refused = it.status === "declined" || (it.status === "failed" && (it.type === "file_change" || /denied|read-only|not permitted|permission|sandbox|EPERM/i.test(str(it.aggregated_output))));
          if (refused) blocked.push(it.type === "file_change" ? { scope: "turn", item: `edit ${(Array.isArray(it.changes) ? it.changes : []).map((x: any) => str(x.path)).join(", ")}` } : { scope: "commands", item: codexCommand(str(it.command)) });
          return out;
        }
        case "thread/tokenUsage/updated": {
          const u = p?.tokenUsage ?? {};
          total = tok(u.total);
          // Its last call's input (cached included) is the context it is at; the window is the model's own.
          lastCall = { context: count(u.last?.inputTokens), window: count(u.modelContextWindow) };
          // The thread's count as this turn began: what it counts now, less what this turn has used so far.
          if (!base) {
            const last = tok(u.last);
            base = { input: total.input - last.input, cached: total.cached - last.cached, output: total.output - last.output };
          }
          return [];
        }
        case "turn/completed": {
          const spent = total && base ? { input: Math.max(0, total.input - base.input), cached: Math.max(0, total.cached - base.cached), output: Math.max(0, total.output - base.output) } : null;
          if (total) keep({ tokenTotals: total });
          const out = spent ? usage(Math.max(0, spent.input - spent.cached), spent.cached, spent.output, lastCall ?? undefined) : [];
          const status = str(p?.turn?.status);
          const err = status === "failed" ? str(p?.turn?.error?.message) || "Codex couldn't finish the turn." : undefined;
          return [...out, ...finish(err)];
        }
        case "error": {
          // "Reconnecting… 2/5" and the like: shown as it happens, not only if the turn then fails.
          const msg = str(p?.error?.message);
          return msg ? [{ kind: "note", text: msg }, { kind: "delta", channel: "reasoning", text: `\n${msg}\n` }] : [];
        }
      }
      return [];
    };

    const parse = ((l: string): AdapterOut[] => (early.length ? [...early.splice(0), ...heard(l)] : heard(l))) as Parser;
    const heard = (l: string): AdapterOut[] => {
      const m = json(l);
      if (!m || over) return [];
      const hasId = m.id !== undefined && m.id !== null;
      // An answer to something asked of it.
      if (hasId && !m.method) {
        const then = waiting.get(Number(m.id));
        waiting.delete(Number(m.id));
        return then ? then({ result: m.result, error: m.error }) : [];
      }
      // Something it asks of Friday: whether it may, or an answer to a question Friday never offered to take.
      if (hasId) {
        if (m.method === "item/commandExecution/requestApproval" || m.method === "item/fileChange/requestApproval") return approval(m.id, str(m.method), m.params);
        if (m.method === "item/permissions/requestApproval") return permissions(m.id, m.params);
        if (m.method === "mcpServer/elicitation/request") return elicit(m.id, m.params);
        // A question for the person mid-turn: nobody is asked here, so each question is answered with what Claude Code's
        // AskUserQuestion is told in Auto (runner.ts), rather than nothing, which left it waiting on an answer that was empty
        // (Arun, 2026-10-28: "we need to ensure teams can work basically while you are away").
        if (m.method === "item/tool/requestUserInput") wire.write(line({ id: m.id, result: { answers: decideAnswers(m.params) } }));
        else wire.write(line({ id: m.id, error: { code: -32601, message: `Friday doesn't offer ${str(m.method)}` } }));
        return [];
      }
      return notice(str(m.method), m.params);
    };
    // A message for this turn while it runs (`turn/steer`): Codex reads it at its next step. Refused by Codex once the turn it
    // names has ended, so a late one waits for the next turn rather than starting one nobody is listening to.
    parse.steer = (text) =>
      new Promise<boolean>((resolve) => {
        if (over || !tid || !turnId) return resolve(false);
        ask("turn/steer", { threadId: tid, expectedTurnId: turnId, input: [{ type: "text", text, text_elements: [] }] }, (r) => {
          resolve(!r.error);
          return [];
        });
      });
    // Stop as it says to: the turn ends "interrupted", and its thread is kept. Not yet in a turn, there is nothing to interrupt.
    parse.cancel = () => {
      if (over) return;
      for (const answer of [...open.values()]) answer(null);
      if (tid && turnId) ask("turn/interrupt", { threadId: tid, turnId }, () => []);
      // Asked for and not yet named: ending here left Codex working with nobody listening, and its turn's last messages arriving
      // in the next one. It is interrupted the moment its id is known instead.
      else if (tid && turnAsked) cancelWanted = true;
      else wire.end();
    };
    return parse;
  },
  explain(e) {
    if (/thread\/resume failed/i.test(e)) return "Codex couldn't find its earlier conversation, so the next instruction starts a fresh one.";
    return codexExec.explain(e);
  },
};

// ── Cursor ───────────────────────────────────────────────────────────

const CURSOR_TOOLS: Record<string, string> = {
  shellToolCall: "shell",
  readToolCall: "read",
  lsToolCall: "read",
  editToolCall: "edit",
  deleteToolCall: "edit",
  grepToolCall: "search",
  globToolCall: "search",
};

/** Cursor has no system-prompt flag either, nor has ACP: the standing note leads the turn it is new to (see `withSystem`). */
const notedPrompt = (t: TurnSpec) => ((t.withSystem ?? !t.resumeId) ? `${t.system}\n\n${PROMPT_MARK}\n${t.prompt}` : t.prompt);

/** Cursor's to-do statuses, by the number its newer builds send, as the session's plan card names them. */
const CURSOR_TODO = ["pending", "pending", "in_progress", "completed", "cancelled"];

/** Cursor tool names → the session's, with the arguments its cards read, so a web search or a to-do list is drawn as one. */
function cursorTool(key: string, args: Record<string, any>): { name: string; args: Record<string, unknown> } {
  switch (key) {
    case "webSearchToolCall":
      return { name: "web_search", args: { query: str(args.searchTerm) || str(args.query) } };
    case "webFetchToolCall":
    case "fetchToolCall":
      return { name: "web_fetch", args: { url: str(args.url) } };
    case "semSearchToolCall": {
      const dirs: unknown[] = Array.isArray(args.targetDirectories) ? args.targetDirectories : [];
      return { name: "search", args: { pattern: str(args.query), ...(dirs.length ? { path: dirs.map(String).join(", ") } : {}) } };
    }
    case "updateTodosToolCall": {
      const todos: any[] = Array.isArray(args.todos) ? args.todos : [];
      const status = (s: unknown) => (typeof s === "number" ? (CURSOR_TODO[s] ?? "pending") : String(s ?? "pending").replace(/^TODO_STATUS_/, "").toLowerCase());
      return { name: "todo", args: { todos: todos.map((t) => ({ content: str(t?.content), status: status(t?.status) })) } };
    }
    case "mcpToolCall":
      return { name: `mcp__${str(args.providerIdentifier) || str(args.serverIdentifier) || "server"}__${str(args.toolName) || str(args.name) || "tool"}`, args: args.args && typeof args.args === "object" ? args.args : {} };
  }
  return { name: CURSOR_TOOLS[key] ?? key.replace(/ToolCall$/, ""), args };
}

export const cursor: Adapter = {
  tool: "cursor",
  bins: ["cursor-agent"],
  login: ["login"],
  logout: ["logout"],
  status: { args: ["status"] },
  args: (t) => [
    "-p",
    "--output-format",
    "stream-json",
    // Text as it is written. Without this Cursor holds it back until a tool starts or the turn ends, and a long answer
    // appeared all at once at the end.
    "--stream-partial-output",
    // The folder is one the person chose to work in. Without this, headless Cursor stops at "Workspace Trust Required" in any
    // folder it has not seen. It only trusts the folder: what Cursor may change is still --force below.
    "--trust",
    ...(t.model ? ["--model", t.model] : []),
    // Without --force, headless Cursor only proposes changes. It has no flag
    // that allows edits but not commands, so "edits" and "full" both need it.
    // Manual is propose-only until a person says yes to the turn: Cursor cannot ask about one thing at a time.
    ...(t.mode === "full" || (t.mode === "edits" && t.grant) ? ["--force"] : []),
    // Headless, it uses an MCP server only once told to trust it: in Auto, as its own `--approve-mcps` says, it is (Arun,
    // 2026-10-18: nothing a tool can do on its own held back in Friday). Elsewhere it is left to what the person has approved.
    ...(t.mode === "full" && offered(t, "--approve-mcps") ? ["--approve-mcps"] : []),
    // Plan in its own plan mode, which plans rather than only holding back its changes.
    ...(t.mode === "plan" && offered(t, "--mode") ? ["--mode", "plan"] : []),
    ...(t.resumeId ? ["--resume", t.resumeId] : []),
    // A leading space keeps a prompt from ever being read as a flag.
    ...(t.stdinPrompt || tooLongForArgv(notedPrompt(t)) ? [] : [` ${notedPrompt(t)}`]),
  ],
  // Only a prompt the command line can't take goes on stdin, which cursor-agent reads when the command line has none (2026.09.28
  // does; an older one may not). On Windows the standing note with an imported conversation in it came close to the limit on
  // its own; elsewhere that takes a great deal more.
  stdin: (t) => (t.stdinPrompt || tooLongForArgv(notedPrompt(t)) ? notedPrompt(t) : ""),
  prespawn: true,
  optional: ["--approve-mcps", "--mode"],
  parser() {
    const blocked: string[] = [];
    /** Text streamed since the last whole block. */
    let buf = "";
    /** Whatever was streamed and not yet sent whole, as a message: before a tool starts, and before the result. */
    const flush = (): AdapterOut[] => {
      const text = buf;
      buf = "";
      return text ? [{ kind: "message", text, toolCalls: [] }] : [];
    };
    return (line) => {
      const m = json(line);
      if (!m) return [];
      switch (m.type) {
        case "system":
          return m.session_id ? [{ kind: "session", id: String(m.session_id) }] : [];
        case "assistant": {
          const text = blockText(m.message?.content);
          if (!text) return [];
          // Each piece comes as it is written, then the same block again, whole, before a tool starts and before the
          // result. The pieces are the live preview; the whole block is the message.
          if (buf && text === buf) return flush();
          buf += text;
          return [{ kind: "delta", text, channel: "text" }];
        }
        case "tool_call": {
          const tc = m.tool_call && typeof m.tool_call === "object" ? m.tool_call : {};
          const key = Object.keys(tc)[0] ?? "tool";
          const inner = tc[key] ?? {};
          const { name, args } = cursorTool(key, inner.args && typeof inner.args === "object" ? inner.args : {});
          const id = str(m.call_id);
          // Its subagents, for the Tasks panel as well as the step in the run.
          const sub = key === "taskToolCall";
          const subArgs: Record<string, any> = inner.args && typeof inner.args === "object" ? inner.args : {};
          const agentType = str(subArgs.subagentType) || str(subArgs.subagent_type);
          if (m.subtype === "started")
            return [
              ...flush(),
              { kind: "message", text: "", toolCalls: [call(id, name, args)] },
              ...(sub ? [{ kind: "task" as const, id, status: "running" as const, description: str(subArgs.description) || firstLine(str(subArgs.prompt)), ...(agentType ? { agentType } : {}) }] : []),
            ];
          if (m.subtype === "completed") {
            const r = inner.result ?? {};
            if (sub) {
              const status: AgentTaskStatus = r.success ? "done" : r.error ? "error" : "stopped";
              const said = r.success ? ([str(r.success.result), str(r.success.content), str(r.success.summary)].find(Boolean) ?? "") : "";
              return [result(id, name, said || JSON.stringify(r.error ?? r.rejected ?? r.success ?? r), status !== "done"), { kind: "task", id, status, ...(said ? { summary: cut(said, 2000) } : {}) }];
            }
            if (r.success) {
              const s = r.success;
              const out = [str(s.stdout), str(s.stderr)].filter(Boolean).join("\n") || str(s.content) || (typeof s.linesCreated === "number" ? `Wrote ${s.linesCreated} lines.` : JSON.stringify(s));
              return [result(id, name, out, (typeof s.exitCode === "number" && s.exitCode !== 0) || (name === "shell" && testFailedInChain(str(args.command), out)))];
            }
            if (r.rejected) blocked.push(name === "shell" ? str(args.command) : `${name} ${str(args.path)}`.trim());
            return [result(id, name, JSON.stringify(r.error ?? r.rejected ?? r), true)];
          }
          return [];
        }
        case "result": {
          const out: AdapterOut[] = [...flush(), ...(m.session_id ? [{ kind: "session" as const, id: String(m.session_id) }] : [])];
          const u = m.usage ?? {};
          out.push(...usage(count(u.inputTokens) + count(u.cacheWriteTokens), count(u.cacheReadTokens), count(u.outputTokens)));
          if (blocked.length) out.push({ kind: "blocked", scope: "turn", items: [...new Set(blocked)].slice(0, 6) });
          out.push({ kind: "done", ...(m.is_error ? { error: str(m.result) || "Cursor reported an error." } : {}) });
          return out;
        }
      }
      return [];
    };
  },
  explain(e) {
    // What cursor-agent says when `--resume` can't open the chat: deleted, or started in another folder than the one Cursor keyed
    // it by.
    if (/failed to resume chat/i.test(e)) return "Cursor couldn't find its earlier conversation, so the next instruction starts a fresh one.";
    if (/log ?in|not authenticated|unauthorized/i.test(e)) return "Cursor isn't logged in on the computer it runs on. Run `cursor-agent login` there, then send the instruction again.";
    return e;
  },
};

// ── ACP: GitHub Copilot, and the tools after it ──────────────────────

/**
 * The Agent Client Protocol (agentclientprotocol.com, v1): JSON-RPC, one message a line each way on stdio. Copilot speaks it
 * (`copilot --acp`), and so do OpenCode, Devin, Gemini CLI, Junie, Kiro and others, so each is a profile on `acp` below.
 *
 * One process per turn, as Codex and Cursor have: it is started, opens the conversation (`session/load` for one it had, so it
 * keeps its memory), is handed the instruction, and is let go by closing its stdin once the turn is over. It asks as it goes
 * (`session/request_permission`), so Manual puts one thing at a time to a person, as Claude Code does. Friday offers it no
 * file or terminal access of its own: it uses its own tools, and the diff after each turn sees what they changed.
 */
interface AcpProfile {
  tool: EngineTool;
  bins: string[];
  /** What signs it in, run in a terminal of its own: none means the tool itself, which asks as it starts. */
  login: string[];
  logout: string[];
  status?: Adapter["status"];
  /** How it is started in ACP mode, with the model when it takes one as it starts. */
  args(t: TurnSpec): string[];
  /** It takes the model as it starts (see `args` and `env`), rather than by its `model` option over ACP. */
  modelAtStart?: boolean;
  /** It takes the effort as it starts (Copilot's --reasoning-effort), rather than by its `thought_level` option over ACP. */
  effortAtStart?: boolean;
  /** Its `args` pass TurnSpec.dirs, as a flag it is started with. */
  dirs?: boolean;
  env?: Adapter["env"];
  unavailable?: Adapter["unavailable"];
  explain?(error: string): string;
}

type AcpCall = {
  toolCallId: string;
  title?: string;
  name?: string | null;
  kind?: string;
  status?: string;
  content?: Record<string, any>[];
  locations?: { path: string }[];
  rawInput?: unknown;
  rawOutput?: unknown;
};

/** ACP's kinds of tool call, as the session's cards are named. */
const ACP_CARD: Record<string, string> = { execute: "shell", edit: "edit", delete: "edit", move: "edit", read: "read", search: "search", fetch: "web_fetch" };
/** What it may do unasked. Manual: read and change files, as Claude Code's acceptEdits; Plan: only read. */
const ACP_FREE: Record<EngineMode, Set<string>> = {
  plan: new Set(["read", "search", "think", "fetch"]),
  edits: new Set(["read", "search", "think", "edit", "delete", "move"]),
  full: new Set(),
};

const rpc = (msg: Record<string, unknown>) => `${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`;
/** Ids for what Friday asks a tool, never used twice: a tool kept from one turn to the next may answer the last turn late. 0 is `initialize`'s. */
let acpIds = 1;

/** An ACP tool call as one of the session's cards. */
/** One of Friday's own MCP tools, however a tool over ACP names it ("friday_message_agent", "mcp__friday__…", "friday.ask_agent"). */
const FRIDAY_TOOL = /^(?:mcp__)?friday(?:__|[_.:/])/i;

function acpCard(tc: AcpCall): { name: string; args: Record<string, unknown> } {
  const raw: Record<string, unknown> = tc.rawInput && typeof tc.rawInput === "object" ? (tc.rawInput as Record<string, unknown>) : {};
  const title = str(tc.title);
  // Copilot's apply_patch hands over the patch itself, whose first `*** Update File:` line names the file.
  const patched = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m.exec(str(tc.rawInput))?.[1]?.trim() ?? "";
  const files: any[] = Array.isArray(raw.files) ? raw.files : [];
  const where = tc.locations?.[0]?.path || str(raw.path) || str(raw.file_path) || str(raw.filePath) || str(raw.fileName) || str(files[0]?.path) || patched;
  // Cline's commands come as a list.
  const commands = Array.isArray(raw.commands) ? (raw.commands as unknown[]).map(String).join("\n") : "";
  const diff = tc.content?.find((c) => c?.type === "diff");
  // Copilot files a search for files by name under "read", with a pattern and no file.
  const kind = tc.kind === "read" && raw.pattern && !where ? "search" : (tc.kind ?? "");
  switch (ACP_CARD[kind]) {
    case "shell":
      return { name: "shell", args: { command: codexCommand(str(raw.command) || str(raw.cmd) || commands || title), ...(raw.description ? { description: raw.description } : {}) } };
    case "edit":
      return diff && diff.oldText == null ? { name: "write", args: { path: str(diff.path) || where, content: cut(str(diff.newText), 2000) } } : { name: "edit", args: { path: where || str(diff?.path) || title } };
    case "read":
      return { name: "read", args: { path: where || title } };
    case "search":
      return { name: "search", args: { pattern: str(raw.pattern) || str(raw.query) || title, ...(where ? { path: where } : {}) } };
    case "web_fetch":
      return { name: "web_fetch", args: { url: str(raw.url) || title } };
  }
  return { name: str(tc.name) || title || "tool", args: Object.keys(raw).length ? raw : title ? { title } : {} };
}

/** What a finished tool call said: its text, a line for each file it changed, or else its raw output. */
function acpOutput(tc: AcpCall): string {
  const said = (tc.content ?? [])
    .map((c) => (c?.type === "content" ? blockText([c.content]) : c?.type === "diff" ? `${c.oldText == null ? "Wrote" : "Edited"} ${str(c.path)}` : ""))
    .filter(Boolean);
  if (said.length) return said.join("\n");
  const r = tc.rawOutput as { content?: unknown; output?: unknown; items?: unknown; result?: unknown } | string | null | undefined;
  if (r == null) return "";
  if (typeof r === "string") return r;
  // Cline's: `{ query, result, success }`, or a list of them.
  const results = (Array.isArray(r) ? r : [r]).map((x: any) => (typeof x?.result === "string" ? x.result : null)).filter((x): x is string => x !== null);
  if (results.length) return results.join("\n");
  if (typeof r.content === "string") return r.content;
  if (typeof r.output === "string") return r.output;
  // Kiro's: `{ items: [{ Text }, { Json }] }`.
  if (Array.isArray(r.items)) return (r.items as any[]).map((i) => (typeof i?.Text === "string" ? i.Text : i?.Json !== undefined ? JSON.stringify(i.Json) : "")).filter(Boolean).join("\n");
  return JSON.stringify(r);
}

/** A command's exit code where the tool only says it in words (Copilot: "<shellId: 0 completed with exit code 1>"). */
const saidExit = (output: string): number | null => {
  const m = /completed with exit code (-?\d+)/.exec(output);
  return m ? Number(m[1]) : null;
};

/** Each of Friday's effort levels by the words a tool may use for it, in its `thought_level` option's values or names. */
const EFFORT_WORDS: Record<EngineEffort, string[]> = {
  low: ["low"],
  medium: ["medium", "med"],
  high: ["high"],
  xhigh: ["xhigh", "x-high", "extra high", "extra-high", "extra", "very high", "very-high"],
  max: ["max", "maximum", "highest"],
};
/** Which of an option's choices is each of Friday's effort levels, where it has one. */
export function effortOptions(options: { id: string; name: string }[]): Partial<Record<EngineEffort, string>> {
  const out: Partial<Record<EngineEffort, string>> = {};
  for (const e of ENGINE_EFFORTS) {
    const hit = options.find((o) => EFFORT_WORDS[e].includes(o.id.toLowerCase()) || EFFORT_WORDS[e].includes(o.name.toLowerCase()));
    if (hit) out[e] = hit.id;
  }
  return out;
}

/** A select option's choices, flat or in groups. */
const choices = (options: unknown): { id: string; name: string }[] =>
  (Array.isArray(options) ? options : []).flatMap((o: any) => (Array.isArray(o?.options) ? o.options : [o])).map((o: any) => ({ id: str(o?.value), name: str(o?.name) }));

function acp(p: AcpProfile): Adapter {
  const name = ENGINE_NAMES[p.tool];
  return {
    tool: p.tool,
    bins: p.bins,
    login: p.login,
    logout: p.logout,
    ...(p.status ? { status: p.status } : {}),
    ...(p.env ? { env: p.env } : {}),
    ...(p.unavailable ? { unavailable: p.unavailable } : {}),
    ...(p.dirs ? { dirs: true } : {}),
    args: p.args,
    interactive: true,
    stdin: () =>
      rpc({ id: 0, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "friday", title: "Friday", version: "1" } } }),
    parser(t, io) {
      if (!t || !io) return () => [];
      const turn = t;
      const wire = io;
      const kept = io.kept;
      /** The conversation's options as they now stand, for the next turn on a kept tool. */
      const keep = (patch: Record<string, unknown>) => {
        if (kept) kept.res = { ...kept.res, ...patch };
      };
      const waiting = new Map<number, (r: { result?: any; error?: { code?: number; message?: string } }) => AdapterOut[]>();
      const ask = (method: string, params: unknown, then: (r: { result?: any; error?: { code?: number; message?: string } }) => AdapterOut[]) => {
        const id = acpIds++;
        waiting.set(id, then);
        wire.write(rpc({ id, method, params }));
      };
      let sid = "";
      /** `session/load` plays the conversation back before it answers: that is history, not this turn. */
      let replaying = false;
      let over = false;
      let text = "";
      let thought = "";
      let plans = 0;
      const calls = new Map<string, AcpCall>();
      /** Calls whose card is in the feed. One is drawn once it says what it is doing: OpenCode announces a call before its input. */
      const drawn = new Set<string>();
      const reported = new Set<string>();
      const said = (tc: AcpCall) =>
        tc.status !== "pending" ||
        (typeof tc.rawInput === "string" ? !!tc.rawInput.trim() : !!tc.rawInput && typeof tc.rawInput === "object" && Object.keys(tc.rawInput).some((k) => k !== "cwd"));
      /** Its card, the first time it can be drawn: before it asks, and before its result, at the latest. */
      const draw = (tc: AcpCall, now = false): AdapterOut[] => {
        if (drawn.has(tc.toolCallId) || !(now || said(tc))) return [];
        drawn.add(tc.toolCallId);
        const card = acpCard(tc);
        return step([call(tc.toolCallId, card.name, card.args)]);
      };
      /** Permission requests not yet answered, by their JSON-RPC id. */
      const open = new Map<string | number, (allow: boolean | null) => void>();
      const blocked: { scope: "commands" | "turn"; item: string }[] = [];

      /** A step: what it said since the last one, and the tool call it is making. */
      const step = (toolCalls: ToolCall[]): AdapterOut[] => {
        if (!text && !thought && !toolCalls.length) return [];
        const out: AdapterOut = { kind: "message", text, toolCalls, ...(thought ? { reasoning: thought } : {}) };
        text = "";
        thought = "";
        return [out];
      };
      const finish = (error?: string): AdapterOut[] => {
        if (over) return [];
        over = true;
        for (const answer of [...open.values()]) answer(null);
        wire.end();
        const items = blocked.slice(0, 6);
        return [
          ...step([]),
          ...(items.length ? [{ kind: "blocked" as const, scope: items.every((b) => b.scope === "commands") ? ("commands" as const) : ("turn" as const), items: items.map((b) => b.item) }] : []),
          { kind: "done", ...(error ? { error } : {}) },
        ];
      };
      const failed = (what: string, e: { code?: number; message?: string }) => finish(e.code === -32000 ? "Authentication required" : `${what}: ${str(e.message) || `error ${e.code}`}`);
      /** What it said it can take (`initialize`'s agentCapabilities): pictures, the MCP transports. */
      let caps: Record<string, any> = kept?.caps ?? {};
      /**
       * The instruction, and the files attached to it as content of their own: a picture as an image when it takes images, any
       * other file (or a picture it can't take) as a link to it, which every ACP agent must read. Gemini CLI, for one, can't open
       * Friday's attachment folder by path at all, since it is outside the folder it works in.
       */
      const blocks = (): Record<string, unknown>[] => {
        const out: Record<string, unknown>[] = [{ type: "text", text: notedPrompt(turn) }];
        for (const f of turn.files ?? []) {
          const mimeType = imageType(f);
          if (mimeType && caps.promptCapabilities?.image) {
            try {
              if (statSync(f).size <= IMAGE_MAX) {
                out.push({ type: "image", mimeType, data: readFileSync(f).toString("base64") });
                continue;
              }
            } catch {
              continue;
            }
          }
          out.push({ type: "resource_link", uri: pathToFileURL(f).href, name: path.basename(f), ...(mimeType ? { mimeType } : {}) });
        }
        return out;
      };
      const prompt = (): AdapterOut[] => {
        ask("session/prompt", { sessionId: sid, prompt: blocks() }, (r) => {
          if (r.error) return failed("The turn failed", r.error);
          // Tools count input two ways: Copilot's holds what was read from a cache (its total is input plus output), OpenCode's
          // doesn't (input, cache reads and output add up to its total). Its own total says which; the thinking is in output.
          const u = r.result?.usage ?? {};
          const [inp, cached, outp, total] = [count(u.inputTokens), count(u.cachedReadTokens), count(u.outputTokens), count(u.totalTokens)];
          const holdsCache = !total || Math.abs(total - (inp + outp)) <= Math.abs(total - (inp + cached + outp));
          const out = usage(holdsCache ? Math.max(0, inp - cached) : inp, cached, outp);
          const stop = str(r.result?.stopReason);
          const why =
            stop === "refusal" ? "It declined to do that." : stop === "max_tokens" ? "It ran out of room for its answer." : stop === "max_turn_requests" ? "It reached its limit of steps for one turn." : undefined;
          return [...out, ...finish(why)];
        });
        return [];
      };
      /** Into Plan for a Plan turn, and out of it otherwise: by its `mode` option, or its older modes. Its auto mode is never picked, since Friday answers its questions itself. */
      const mode = (res: any): AdapterOut[] => {
        const isPlan = (m: { id: string; name: string }) => /plan/i.test(`${m.id} ${m.name}`);
        const pick = (modes: { id: string; name: string }[], current: string): string | null => {
          const now = modes.find((m) => m.id === current);
          if (turn.mode === "plan") return now && isPlan(now) ? null : (modes.find(isPlan)?.id ?? null);
          if (!now || !isPlan(now)) return null;
          const plain = (m: { id: string; name: string }) => /\b(?:default|agent|build|code|normal|act|interactive)\b|#agent$/i.test(`${m.id} ${m.name}`);
          return (modes.find((m) => !isPlan(m) && plain(m)) ?? modes.find((m) => !isPlan(m) && !/auto|yolo|help|ask/i.test(`${m.id} ${m.name}`)) ?? modes.find((m) => !isPlan(m)))?.id ?? null;
        };
        const opt = (Array.isArray(res?.configOptions) ? res.configOptions : []).find((o: any) => o?.category === "mode" && o.type === "select");
        const modes = res?.modes && Array.isArray(res.modes.availableModes) ? res.modes : null;
        const to = opt ? pick(choices(opt.options), str(opt.currentValue)) : modes ? pick(choices(modes.availableModes.map((m: any) => ({ value: m?.id, name: m?.name }))), str(modes.currentModeId)) : null;
        if (!to) return prompt();
        // Whether or not it takes, the turn goes on: Plan is held to reading below either way.
        ask(opt ? "session/set_config_option" : "session/set_mode", opt ? { sessionId: sid, configId: opt.id, value: to } : { sessionId: sid, modeId: to }, (r) => {
          if (!r.error) keep(opt ? { configOptions: r.result?.configOptions ?? res.configOptions.map((o: any) => (o === opt ? { ...o, currentValue: to } : o)) } : { modes: { ...modes, currentModeId: to } });
          return prompt();
        });
        return [];
      };
      /** The model picked in Friday, by the tool's `model` option, for a tool that doesn't take one as it starts. One it doesn't know is said, and the turn goes on with its own. */
      const model = (res: any): AdapterOut[] => {
        const opt = (Array.isArray(res?.configOptions) ? res.configOptions : []).find((o: any) => o?.category === "model" && o.type === "select");
        // What it offers, for the model picker, once a turn: Friday's own list for these tools is empty, since it depends on the account.
        const offers = listedModels ? [] : choices(opt?.options).filter((c) => c.id);
        if (offers.length) {
          listedModels = true;
          return [{ kind: "models", list: offers.map((c) => ({ id: c.id, label: c.name || c.id })) }, ...pickModel(res, opt)];
        }
        return pickModel(res, opt);
      };
      let listedModels = false;
      const pickModel = (res: any, opt: any): AdapterOut[] => {
        if (p.modelAtStart || !turn.model || !opt || str(opt.currentValue) === turn.model) return effortStep(res);
        const known = choices(opt.options).find((c) => c.id === turn.model || c.name.toLowerCase() === turn.model!.toLowerCase());
        if (!known) return [{ kind: "delta", channel: "reasoning", text: `\n${name} doesn't offer “${turn.model}” here, so it uses ${str(opt.currentValue) || "its own choice"}.\n` }, ...effortStep(res)];
        ask("session/set_config_option", { sessionId: sid, configId: opt.id, value: known.id }, (r) => {
          if (r.result?.configOptions) keep({ configOptions: r.result.configOptions });
          return effortStep(r.result ?? res);
        });
        return [];
      };
      /**
       * How hard it thinks, by its `thought_level` option (ACP's name for an effort setting), after the model and before the mode.
       * The levels it has are passed on once, in Friday's names, for the effort pill; a level it doesn't have is said, and the turn
       * goes on as it is set.
       */
      let listedEfforts = false;
      const effortStep = (res: any): AdapterOut[] => {
        if (p.effortAtStart) return mode(res);
        const opt = (Array.isArray(res?.configOptions) ? res.configOptions : []).find(
          (o: any) => o?.type === "select" && (o.category === "thought_level" || ((!o.category || str(o.category).startsWith("_")) && /effort|reasoning|thinking|thought/i.test(`${str(o.id)} ${str(o.name)}`))),
        );
        const levels = opt ? effortOptions(choices(opt.options)) : {};
        const said: AdapterOut[] = [];
        if (opt && !listedEfforts) {
          listedEfforts = true;
          said.push({ kind: "efforts", list: ENGINE_EFFORTS.filter((e) => levels[e]) });
        }
        if (!turn.effort) return [...said, ...mode(res)];
        const to = levels[turn.effort as EngineEffort];
        if (!to) return [...said, { kind: "delta", channel: "reasoning", text: `\n${name} ${opt ? "doesn't offer that effort level here" : "has no effort setting here"}, so it thinks as it is set to.\n` }, ...mode(res)];
        if (str(opt.currentValue) === to) return [...said, ...mode(res)];
        ask("session/set_config_option", { sessionId: sid, configId: opt.id, value: to }, (r) => {
          if (r.result?.configOptions) keep({ configOptions: r.result.configOptions });
          return mode(r.result ?? res);
        });
        return said;
      };
      const started = (r: { result?: any; error?: { code?: number; message?: string } }): AdapterOut[] => {
        if (r.error) return failed("It couldn't start", r.error);
        const session = (id: string | null) => (s: { result?: any; error?: { code?: number; message?: string } }) => {
          replaying = false;
          if (s.error) return id ? failed("session/load failed", s.error) : failed("It couldn't start a conversation", s.error);
          sid = id ?? str(s.result?.sessionId);
          if (!sid) return finish("It didn't start a conversation.");
          if (kept) Object.assign(kept, { sessionId: sid, res: s.result ?? {}, fresh: false });
          return [{ kind: "session" as const, id: sid }, ...model(s.result)];
        };
        caps = r.result?.agentCapabilities ?? caps;
        // The project's MCP servers go with the conversation, as ACP has the client pass them (see mcp-servers.ts).
        const params = { cwd: wire.cwd, mcpServers: mcpForAgent(turn.acpMcp, caps) };
        // A copy of it when it is busy elsewhere (see Runner.turn), where the agent can fork one (ACP's session/fork).
        if (turn.resumeId && turn.fork && caps.sessionCapabilities?.fork) ask("session/fork", { ...params, sessionId: turn.resumeId }, session(null));
        else if (turn.resumeId && r.result?.agentCapabilities?.loadSession) {
          replaying = true;
          ask("session/load", { ...params, sessionId: turn.resumeId }, session(turn.resumeId));
        } else ask("session/new", params, session(null));
        return [];
      };
      /** What a kept tool's turn says before the tool's first line: its turn starts as the parser does. */
      let early: AdapterOut[] = [];
      if (!kept) waiting.set(0, started);
      else if (kept.sessionId && !turn.fork && (kept.sessionId === turn.resumeId || (!turn.resumeId && kept.fresh))) {
        // Its conversation is open in it already: only the instruction goes.
        sid = kept.sessionId;
        kept.fresh = false;
        early = [...(turn.resumeId === sid ? [] : [{ kind: "session" as const, id: sid }]), ...model(kept.res)];
      } else early = started({ result: { agentCapabilities: kept.caps } });

      /** Whether a yes already given covers this: the whole turn, or this very command. */
      const granted = (card: { name: string; args: Record<string, unknown> }) =>
        turn.grant?.scope === "turn" || (turn.grant?.scope === "commands" && card.name === "shell" && turn.grant.items.includes(str(card.args.command)));

      const permission = (id: string | number, params: any): AdapterOut[] => {
        const known = calls.get(str(params?.toolCall?.toolCallId));
        const tc: AcpCall = { ...known, ...(params?.toolCall ?? {}) };
        const options: any[] = Array.isArray(params?.options) ? params.options : [];
        const answer = (allow: boolean | null) => {
          if (!open.delete(id)) return;
          const o = allow === null ? null : (options.find((x) => x?.kind === (allow ? "allow_once" : "reject_once")) ?? options.find((x) => str(x?.kind).startsWith(allow ? "allow" : "reject")));
          wire.write(rpc({ id, result: { outcome: o ? { outcome: "selected", optionId: o.optionId } : { outcome: "cancelled" } } }));
        };
        open.set(id, answer);
        const card = acpCard(tc);
        const first = tc.toolCallId ? draw(tc, true) : [];
        // Friday's own tools (messages to the other agents, the board, the preview) in any mode, as for Claude Code and Codex.
        if (turn.mode === "full" || ACP_FREE[turn.mode].has(tc.kind ?? "other") || granted(card) || FRIDAY_TOOL.test(str(tc.title))) {
          answer(true);
          return first;
        }
        // Plan never changes a file. Anything else (a command, mostly to look around) is put to a person as in Manual: Copilot
        // ends the whole turn on a refusal, and refusing every `git status` left Plan turns with no answer at all.
        if (turn.mode === "plan" && ["edit", "delete", "move"].includes(tc.kind ?? "")) {
          answer(false);
          return first;
        }
        if (turn.ask) return [...first, { kind: "ask", requestId: String(id), tool: card.name, input: card.args, reply: (allow) => answer(allow) }];
        answer(false);
        blocked.push(askedItem(card.name, card.args));
        return first;
      };

      const update = (u: any): AdapterOut[] => {
        switch (u?.sessionUpdate) {
          case "agent_message_chunk":
          case "agent_thought_chunk": {
            const s = blockText([u.content]);
            if (!s) return [];
            const reasoning = u.sessionUpdate === "agent_thought_chunk";
            if (reasoning) thought += s;
            else text += s;
            return [{ kind: "delta", text: s, channel: reasoning ? "reasoning" : "text" }];
          }
          case "tool_call":
          case "tool_call_update": {
            const id = str(u.toolCallId);
            if (!id) return [];
            const before = calls.get(id);
            const tc: AcpCall = { ...before, toolCallId: id };
            // A patch: what it leaves out (or sends as null) stays as it was.
            for (const k of ["title", "name", "kind", "status", "content", "locations", "rawInput", "rawOutput"] as const) if (u[k] != null) (tc as any)[k] = u[k];
            calls.set(id, tc);
            const card = acpCard(tc);
            const over = tc.status === "completed" || tc.status === "failed";
            const out = draw(tc, over);
            if (over && !reported.has(id)) {
              reported.add(id);
              const said = acpOutput(tc);
              const shell = card.name === "shell";
              const refused = (Array.isArray(tc.rawOutput) ? tc.rawOutput : [tc.rawOutput]).some((x: any) => x?.success === false);
              out.push(result(id, card.name, said, tc.status === "failed" || refused || (shell && (testFailedInChain(str(card.args.command), said) || (saidExit(said) ?? 0) !== 0))));
            }
            return out;
          }
          case "plan": {
            const entries: any[] = Array.isArray(u.entries) ? u.entries : [];
            // Copilot sends an empty plan as it starts one: nothing to draw yet.
            if (!entries.length && !plans) return [];
            return step([call(`plan-${++plans}`, "todo", { todos: entries.map((e) => ({ content: str(e?.content), status: str(e?.status) || "pending" })) })]);
          }
        }
        return [];
      };

      const parse = ((line: string): AdapterOut[] => (early.length ? [...early.splice(0), ...heard(line)] : heard(line))) as Parser;
      const heard = (line: string): AdapterOut[] => {
        const m = json(line);
        if (!m || over) return [];
        const hasId = m.id !== undefined && m.id !== null;
        // An answer to something asked of it.
        if (hasId && !m.method) {
          const then = waiting.get(Number(m.id));
          waiting.delete(Number(m.id));
          return then ? then({ result: m.result, error: m.error }) : [];
        }
        // Something it asks of Friday: whether it may, or (never offered, so not expected) a file or a terminal.
        if (hasId) {
          if (m.method === "session/request_permission") return permission(m.id, m.params);
          wire.write(rpc({ id: m.id, error: { code: -32601, message: `Friday doesn't offer ${str(m.method)}` } }));
          return [];
        }
        if (m.method !== "session/update") return [];
        const u = m.params?.update;
        // It changed its mode or options itself: a kept tool's next turn reads them from here.
        if (u?.sessionUpdate === "current_mode_update" && kept?.res?.modes) keep({ modes: { ...kept.res.modes, currentModeId: u.currentModeId } });
        if (u?.sessionUpdate === "config_option_update" && Array.isArray(u.configOptions)) keep({ configOptions: u.configOptions });
        // Its commands (built in, and the person's skills), said as a conversation opens, even one being played back.
        if (u?.sessionUpdate === "available_commands_update" && Array.isArray(u.availableCommands)) {
          const list = (u.availableCommands as any[])
            .filter((c) => typeof c?.name === "string" && c.name)
            .map((c) => ({ name: str(c.name).replace(/^\//, ""), description: str(c.description), ...(str(c.input?.hint) ? { hint: str(c.input.hint) } : {}) }));
          return [{ kind: "commands", list }];
        }
        return replaying ? [] : update(u);
      };
      // Stop as ACP says to: the turn ends with "cancelled", and its conversation is kept. Anything it was waiting to hear is
      // answered "cancelled" too. Not yet in a conversation, there is nothing to cancel: it is let go.
      parse.cancel = () => {
        if (over) return;
        for (const answer of [...open.values()]) answer(null);
        if (sid) wire.write(rpc({ method: "session/cancel", params: { sessionId: sid } }));
        else wire.end();
      };
      return parse;
    },
    explain(e) {
      const own = p.explain?.(e);
      if (own && own !== e) return own;
      if (/authentication required|auth_required|not (?:logged|signed) in|unauthori[sz]ed|please (?:log|sign) in/i.test(e))
        return `${name} isn't signed in on the computer it runs on. Run \`${[p.bins[0], ...p.login].join(" ")}\` there, then send the instruction again.`;
      if (/session\/load failed/i.test(e)) return `${name} couldn't find its earlier conversation, so the next instruction starts a fresh one.`;
      return e;
    },
  };
}

/**
 * A command whose answer lists the sign-ins it holds ("2 credentials"), as OpenCode says it. None is not "signed out": it runs
 * free models without one, so it is left as unknown rather than turning it away.
 */
const credentials = (args: string[]) => ({ args, signedIn: /\b[1-9]\d* credentials?\b/i, signedOut: /(?!)/ });
/**
 * Signed in when one of these files is there, or the tool's own key is set: only whether it exists is looked at. `absent` is
 * what no file says: unknown for most, since a tool may keep its sign-in elsewhere; signed out where the file is the only place.
 */
const anyOf =
  (files: string[], keys: string[] = [], absent: boolean | null = null) =>
  async (): Promise<boolean | null> => {
    if (keys.some((k) => process.env[k])) return true;
    for (const f of files) if (await access(path.join(homedir(), f)).then(() => true, () => false)) return true;
    return absent;
  };

/**
 * Kilo: signed in to its own gateway (`kilo profile --json` succeeds, and prints no token), or holding another provider's sign-in.
 * Neither, and it hangs on the first instruction rather than saying so (7.8.8, even on its free models), so that is "signed out".
 */
async function kiloSignedIn(bin: string): Promise<boolean | null> {
  const profile = await runCli(bin, ["profile", "--json"], 15_000).catch(() => null);
  if (!profile || profile.code === -1) return null;
  if (profile.code === 0) return true;
  const list = await runCli(bin, ["auth", "list"], 15_000).catch(() => null);
  if (list && /\b[1-9]\d* credentials?\b/i.test(list.out)) return true;
  return /not authenticated/i.test(profile.out) ? false : null;
}

export const copilot: Adapter = acp({
  tool: "copilot",
  bins: ["copilot"],
  login: ["login"],
  // It has no command for this (October 2026): signing out is done in Copilot itself.
  logout: [],
  // Not updating itself while Friday has it mid-turn. The model is set as it starts: 1.0.85 to 1.0.91 offer none to change over ACP.
  // Its effort, like its model, is set as it starts: a change starts the kept process again for the next turn.
  // The folders beside its own as its --add-dir allows them, which it then reads and writes without asking about the path.
  args: (t) => ["--acp", "--no-auto-update", ...(t.model ? ["--model", t.model] : []), ...(t.effort ? ["--reasoning-effort", t.effort] : []), ...(t.dirs ?? []).flatMap((d) => ["--add-dir", d])],
  status: () => copilotSignedIn(),
  modelAtStart: true,
  effortAtStart: true,
  dirs: true,
});

/**
 * OpenCode allows everything unless told otherwise (1.19), so a turn tells it, in the permissions it reads from
 * OPENCODE_PERMISSION: Manual asks before a command or a fetch, Plan never edits. Its plan mode alone still runs bash.
 */
const openCodeRules = (mode: EngineMode): Record<string, string> =>
  mode === "full" ? {} : mode === "plan" ? { edit: "deny", bash: "ask", webfetch: "ask" } : { bash: "ask", webfetch: "ask" };

// No sign-in is still a working OpenCode: it runs OpenCode Zen's free models with none ("Big Pickle", 1.19.0).
export const opencode: Adapter = acp({
  tool: "opencode",
  bins: ["opencode"],
  login: ["auth", "login"],
  logout: ["auth", "logout"],
  status: credentials(["auth", "list"]),
  args: () => ["acp"],
  env: (t): Record<string, string> => (t.mode === "full" ? {} : { OPENCODE_PERMISSION: JSON.stringify(openCodeRules(t.mode)) }),
});

// Kilo asks before a command by itself, and its plan mode only reads. On Windows its ACP server opens a conversation and then
// never answers an instruction (7.8.8, signed in or not, on its free models too): said, rather than a turn that hangs.
export const kilo: Adapter = acp({
  tool: "kilo",
  bins: ["kilo"],
  login: ["auth", "login"],
  logout: ["auth", "logout"],
  status: kiloSignedIn,
  args: () => ["acp"],
  unavailable: () => (process.platform === "win32" ? "Kilo's ACP mode doesn't answer instructions on Windows yet (Kilo 7.8.8). It works on macOS and Linux." : null),
});

export const devin: Adapter = acp({
  tool: "devin",
  bins: ["devin"],
  login: ["auth", "login"],
  logout: ["auth", "logout"],
  // "Not logged in", or who it is signed in as (3000.11.3): no token either way.
  status: { args: ["auth", "status"] },
  args: (t) => ["acp", ...(t.model ? ["--model", t.model] : [])],
  modelAtStart: true,
});

export const gemini: Adapter = acp({
  tool: "gemini",
  bins: ["gemini"],
  login: [],
  logout: [],
  status: anyOf([".gemini/oauth_creds.json"], ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI"]),
  // Its workspace, the folder and those beside it: one comma-separated list, which it reads as its own --include-directories.
  args: (t) => ["--acp", ...(t.model ? ["-m", t.model] : []), ...(t.dirs?.length ? ["--include-directories", t.dirs.join(",")] : [])],
  modelAtStart: true,
  dirs: true,
});

// Junie signs in on its own welcome screen, and has no command that says whether it is.
export const junie: Adapter = acp({
  tool: "junie",
  bins: ["junie"],
  login: [],
  logout: [],
  status: anyOf([], ["JUNIE_API_KEY"]),
  args: (t) => ["--acp=true", ...(t.model ? ["--model", t.model] : [])],
  modelAtStart: true,
});

export const kiro: Adapter = acp({
  tool: "kiro",
  bins: ["kiro-cli"],
  login: ["login"],
  logout: ["logout"],
  status: { args: ["whoami", "--format", "json"], signedIn: /"(?:email|accountType|startUrl|userId|authMethod)"/i, signedOut: /not logged in|no active session|login required/i },
  // Its first ACP server (V2), the one that takes these flags; its read-only planner is `kiro_planner`.
  args: (t) => ["acp", ...(t.model ? ["--model", t.model] : [])],
  modelAtStart: true,
});

// With no --auto, droid puts every step to the client over ACP, and Friday answers by the mode. It signs in on its own /login.
export const droid: Adapter = acp({
  tool: "droid",
  bins: ["droid"],
  login: [],
  logout: [],
  status: anyOf([], ["FACTORY_API_KEY"]),
  args: () => ["exec", "--output-format", "acp-daemon"],
  env: () => ({ DROID_DISABLE_AUTO_UPDATE: "true" }),
});

// Grok's plan mode can still write with bash, so a Plan turn also runs in its read-only sandbox.
export const grok: Adapter = acp({
  tool: "grok",
  bins: ["grok"],
  login: ["login"],
  logout: ["logout"],
  status: anyOf([".grok/auth.json"], ["XAI_API_KEY"]),
  // Its permission mode said on the command line every turn, so a `grok` config set to always-approve can't skip Friday's
  // questions in Manual or Plan; Auto approves in Grok itself, as Friday would answer yes to everything anyway (Arun,
  // 2026-10-27: "can we look into adding support for … grok"; as T3 Code starts it).
  args: (t) => [...(t.mode === "full" ? [] : ["--permission-mode", "default"]), "agent", ...(t.mode === "full" ? ["--always-approve"] : []), ...(t.model ? ["-m", t.model] : []), "stdio"],
  modelAtStart: true,
  env: (t): Record<string, string> => ({ GROK_DISABLE_AUTOUPDATER: "1", ...(t.mode === "plan" ? { GROK_SANDBOX: "read-only" } : {}) }),
});

// Cline asks before each step over ACP, and ignores a model flag there: CLINE_MODEL is how it is told.
/** The agent somebody set for "Other ACP agent": its command, and what it is started with. Kept on this computer. */
export interface CustomAcp {
  command: string;
  args: string[];
}
const customAcpFile = () => path.join(homedir(), ".friday", "acp-agent.json");
/** As last read: findBin reads it before a turn or a question starts the agent, and args is synchronous. */
let customAcp: CustomAcp | null = null;

export async function readCustomAcp(): Promise<CustomAcp | null> {
  try {
    const j = JSON.parse(await readFile(customAcpFile(), "utf8")) as Partial<CustomAcp>;
    customAcp = typeof j.command === "string" && j.command.trim() ? { command: j.command.trim(), args: Array.isArray(j.args) ? j.args.map(String) : [] } : null;
  } catch {
    customAcp = null;
  }
  return customAcp;
}

/** A command line as a shell splits it, quotes kept together: `goose acp`, `"C:\Tools\my agent.exe" --acp`. */
export function splitCommandLine(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
}

/** Set the agent for "Other ACP agent" from a command line, or clear it with an empty one. */
export async function saveCustomAcp(line: string): Promise<CustomAcp | null> {
  const [command, ...args] = splitCommandLine(line.trim());
  const file = customAcpFile();
  if (!command) {
    await unlink(file).catch(() => {});
    customAcp = null;
    return null;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ command, args }, null, 2));
  customAcp = { command, args };
  forgetLoginStatus();
  return customAcp;
}

/** Whatever it is, it is spoken to the way every ACP agent is; whether it is signed in is for it to say when it starts. */
export const custom: Adapter = acp({ tool: "acp", bins: [], login: [], logout: [], args: () => customAcp?.args ?? [] });

export const cline: Adapter = acp({
  tool: "cline",
  bins: ["cline"],
  login: ["auth"],
  logout: [],
  // Its providers file is where every way of signing in to it is kept: none, and it refuses to start a conversation.
  status: anyOf([".cline/data/settings/providers.json"], ["CLINE_API_KEY"], false),
  args: () => ["--acp"],
  modelAtStart: true,
  env: (t): Record<string, string> => (t.model ? { CLINE_MODEL: t.model } : {}),
});

// ── Amp ──────────────────────────────────────────────────────────────

/**
 * Amp, which speaks no ACP of its own: `amp --execute --stream-json` writes Claude Code's stream-json, so Claude Code's parser
 * reads it. It doesn't ask before it acts, and has no plan mode, so it runs only where nobody needs asking: Auto.
 */
export const amp: Adapter = {
  tool: "amp",
  bins: ["amp"],
  login: ["login"],
  logout: ["logout"],
  modes: ["full"],
  prespawn: true,
  // `--mode` (low, medium, high, ultra) is how Amp picks its models, and a thread keeps the one it started with.
  args: (t) => [
    ...(t.resumeId ? ["threads", "continue", t.resumeId] : []),
    "--execute",
    "--stream-json",
    "--dangerously-allow-all",
    ...(t.model && !t.resumeId ? ["--mode", t.model] : []),
    // Friday's MCP server (friday-mcp.ts); an Amp too old for the flag runs the turn again without it.
    ...(t.friday && offered(t, "--mcp-config") ? ["--mcp-config", ampConfig(t.friday)] : []),
  ],
  optional: ["--mcp-config"],
  status: anyOf([], ["AMP_API_KEY"]),
  stdin: (t) => notedPrompt(t),
  parser: () => claude.parser(),
  explain(e) {
    if (/not (?:logged|signed) in|unauthori[sz]ed|login required|api key/i.test(e)) return "Amp isn't signed in on the computer it runs on. Run `amp login` there, then send the instruction again.";
    if (/thread not found|no such thread/i.test(e)) return "Amp couldn't find its earlier conversation, so the next instruction starts a fresh one.";
    return e;
  },
};

/**
 * Muse Code (Meta's coding agent, `muse`), over its own Muse Session Protocol (Arun, 2026-10-27: "can we look into adding
 * support for muse"): `muse serve` speaks JSON-RPC, one message a line each way on stdio, as T3 Code and OpenClaw drive it.
 *
 * One process a turn, as the ACP tools are: `initialize`, then the conversation opened (`session/resume` for one it had, so it
 * keeps its memory, else `session/start` under an id Friday mints), then `turn/start`, and stdin closed once `turn/completed`
 * says the turn is over. What it does comes as items (`item/started`, `item/delta`, `item/completed`): its words, its
 * reasoning, its tool calls with their output, and the subagents it sends off. Auto starts it with `approvalMode: allowAll`;
 * Manual and Plan with `promptUnmatched`, so it asks (`approval/request`, acknowledged, then answered by `approval/decide`):
 * Manual lets a change to a file through and puts a command to a person, Plan refuses any change and asks about the rest.
 */
/**
 * A UUIDv7, its first 48 bits the time in milliseconds: Muse 1.4 refuses any other kind of command id ("invalid session/start
 * commandId: expected UUIDv7"), so every turn failed before it began (Arun, 2026-10-29: "check if muse works"). Its own session
 * ids are made the same way, so Friday's are too.
 */
export function uuidv7(now = Date.now()): string {
  const b = randomBytes(16);
  for (let i = 0; i < 6; i++) b[i] = Math.floor(now / 2 ** (8 * (5 - i))) & 0xff;
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Muse's tools as the session's cards are named, by the words in their names. */
function museCard(tool: string, raw: Record<string, unknown>): { name: string; args: Record<string, unknown> } {
  const where = str(raw.path) || str(raw.file_path) || str(raw.filePath) || str(raw.file);
  const t = tool.toLowerCase();
  if (/bash|shell|exec|command|terminal/.test(t)) return { name: "shell", args: { command: str(raw.command) || str(raw.cmd), ...(raw.description ? { description: raw.description } : {}) } };
  if (/web_?search/.test(t)) return { name: "web_search", args: { query: str(raw.query) } };
  if (/fetch|browse|url/.test(t)) return { name: "web_fetch", args: { url: str(raw.url) } };
  if (/grep|glob|search|find|list|ls/.test(t)) return { name: "search", args: { pattern: str(raw.pattern) || str(raw.query) || str(raw.glob), ...(where ? { path: where } : {}) } };
  if (/write|create/.test(t)) return { name: "write", args: { path: where, content: cut(str(raw.content), 2000) } };
  if (/edit|patch|replace|apply/.test(t)) return { name: "edit", args: { path: where } };
  if (/read|view|cat|open/.test(t)) return { name: "read", args: { path: where } };
  return { name: tool || "tool", args: raw };
}
const museArgs = (v: unknown): Record<string, unknown> => {
  if (v && typeof v === "object") return v as Record<string, unknown>;
  const j = typeof v === "string" ? json(v) : null;
  return j ?? {};
};
/** The kinds of change Manual lets through unasked, as Claude Code's acceptEdits does. */
const MUSE_FREE_IN_EDITS = new Set(["read", "search", "edit", "write", "web_search", "web_fetch"]);

export const muse: Adapter = {
  tool: "muse",
  bins: ["muse"],
  login: ["login"],
  logout: ["logout"],
  dirs: true,
  interactive: true,
  perTurn: true,
  // Its allowance, which needs the account and no model turn: "not logged in: run `muse login` first" when signed out, a JSON
  // object when signed in (with META_API_KEY set too, which Muse puts before the account).
  status: { args: ["usage", "--json"], signedIn: /^\s*\{/ },
  unavailable: () => (process.platform === "win32" ? "Muse Code doesn't run on Windows itself: install it inside WSL." : null),
  // Its own sandbox off only where Friday lets it act unasked; the workspace trusted, since Friday opened it there.
  args: (t) => ["serve", "--trust-workspace", ...(t.mode === "full" ? ["--disable-sandbox"] : [])],
  env: (): Record<string, string> => ({ MUSE_NO_AUTO_UPDATE: "1" }),
  stdin: () => rpc({ id: 0, method: "initialize", params: { clientInfo: { name: "friday", title: "Friday", version: "1" }, capabilities: { requestedCapabilities: [] } } }),
  parser(t, io) {
    if (!t || !io) return () => [];
    const turn = t;
    const wire = io;
    const waiting = new Map<number, (r: { result?: any; error?: { code?: number; message?: string } }) => AdapterOut[]>();
    const ask = (method: string, params: Record<string, unknown>, then: (r: { result?: any; error?: { code?: number; message?: string } }) => AdapterOut[]) => {
      const id = acpIds++;
      waiting.set(id, then);
      wire.write(rpc({ id, method, params: { ...params, commandId: uuidv7() } }));
    };
    let sid = "";
    let turnId = "";
    let over = false;
    let text = "";
    let thought = "";
    /** Each item's kind, by its id, so a delta goes to the words or the reasoning. */
    const kinds = new Map<string, string>();
    /** Text already said for an item, so its completion doesn't say it twice. */
    const streamed = new Map<string, number>();
    const drawn = new Set<string>();
    /** Subagents said to have started, and to be back: each once. */
    const subsSeen = new Set<string>();
    const subsBack = new Set<string>();
    const blocked: { scope: "commands" | "turn"; item: string }[] = [];
    let used = { input: 0, cached: 0, output: 0 };
    let ctx = { context: 0, window: 0 };
    const open = new Map<string, (allow: boolean | null) => void>();
    const granted = (card: { name: string; args: Record<string, unknown> }) =>
      turn.grant?.scope === "turn" || (turn.grant?.scope === "commands" && card.name === "shell" && turn.grant.items.includes(str(card.args.command)));

    const step = (toolCalls: ToolCall[]): AdapterOut[] => {
      if (!text && !thought && !toolCalls.length) return [];
      const out: AdapterOut = { kind: "message", text, toolCalls, ...(thought ? { reasoning: thought } : {}) };
      text = "";
      thought = "";
      return [out];
    };
    const finish = (error?: string): AdapterOut[] => {
      if (over) return [];
      over = true;
      for (const answer of [...open.values()]) answer(null);
      wire.end();
      const items = blocked.slice(0, 6);
      return [
        ...step([]),
        ...usage(used.input, used.cached, used.output, ctx),
        ...(items.length ? [{ kind: "blocked" as const, scope: items.every((b) => b.scope === "commands") ? ("commands" as const) : ("turn" as const), items: items.map((b) => b.item) }] : []),
        { kind: "done", ...(error ? { error } : {}) },
      ];
    };
    const failed = (what: string, e: { code?: number; message?: string }) => finish(/auth|login|sign/i.test(str(e.message)) ? "Authentication required" : `${what}: ${str(e.message) || `error ${e.code}`}`);

    const startTurn = (): AdapterOut[] => {
      const input: Record<string, unknown>[] = [{ type: "text", text: notedPrompt(turn) }];
      for (const f of turn.files ?? []) {
        const mimeType = imageType(f);
        if (!mimeType) continue;
        try {
          if (statSync(f).size <= IMAGE_MAX) input.push({ type: "image", mimeType, data: readFileSync(f).toString("base64") });
        } catch {
          // A file gone since it was attached: the prompt still names it.
        }
      }
      ask(
        "turn/start",
        {
          sessionId: sid,
          input,
          displayText: turn.prompt.slice(0, 2000) || "Attachment",
          workspaceRoots: [wire.cwd, ...(turn.dirs ?? [])],
          ifBusy: "queue",
          ...(turn.effort ? { reasoningEffort: turn.effort } : {}),
        },
        (r) => {
          if (r.error) return failed("The turn failed", r.error);
          turnId = str(r.result?.turnId);
          return [];
        },
      );
      return [];
    };
    const opened = (r: { result?: any }): AdapterOut[] => {
      sid = str(r.result?.session?.sessionId) || sid;
      return [{ kind: "session", id: sid }, ...startTurn()];
    };
    const startFresh = (): AdapterOut[] => {
      sid = uuidv7();
      ask(
        "session/start",
        {
          sessionId: sid,
          workspaceRoot: wire.cwd,
          ...(turn.model ? { modelId: turn.model } : {}),
          providerId: "meta",
          approvalMode: turn.mode === "full" ? "allowAll" : "promptUnmatched",
          permissionProfile: turn.mode === "full" ? ":unrestricted" : ":ask-me",
        },
        (r) => (r.error ? failed("Muse Code couldn't start the conversation", r.error) : opened(r)),
      );
      return [];
    };
    const openSession = (): AdapterOut[] => {
      if (!turn.resumeId) return startFresh();
      sid = turn.resumeId;
      // Its own conversation again, so it remembers; one it no longer has starts over.
      ask("session/resume", { sessionId: sid, excludeItems: true, permissionProfile: turn.mode === "full" ? ":unrestricted" : ":ask-me" }, (r) => (r.error ? startFresh() : opened(r)));
      return [];
    };

    /** Its question, answered as Manual and Plan answer, or by a person while the turn waits. */
    const approval = (id: string | number, params: Record<string, any>): AdapterOut[] => {
      wire.write(rpc({ id, result: {} }));
      const approvalId = str(params.approvalId);
      const requirementId = params.subject?.stages?.[0]?.requirementId ?? { approvalId, sourceIndex: 0 };
      const choices: string[] = (Array.isArray(params.availableChoices) ? params.availableChoices : []).map((c: any) => str(c?.choiceId ?? c?.id ?? c)).filter(Boolean);
      const pick = (allow: boolean) => (allow ? (choices.find((c) => c === "allow_once") ?? choices.find((c) => c.startsWith("allow")) ?? "allow_once") : (choices.find((c) => c === "abort" || c === "deny" || c.startsWith("reject")) ?? "abort"));
      const raw = museArgs(params.rawArgs);
      const card = params.subject?.kind === "shell" ? { name: "shell", args: { command: str(params.subject.command) || str(raw.command) } } : museCard(str(params.toolName), raw);
      const answer = (allow: boolean | null) => {
        if (!open.delete(approvalId)) return;
        ask("approval/decide", { sessionId: sid, approvalId, requirementId, choiceId: pick(!!allow) }, () => []);
      };
      open.set(approvalId, answer);
      if (turn.mode === "full" || granted(card) || (turn.mode === "edits" && MUSE_FREE_IN_EDITS.has(card.name)) || (turn.mode === "plan" && ["read", "search", "web_search", "web_fetch"].includes(card.name))) {
        answer(true);
        return [];
      }
      if (turn.mode === "plan" && (card.name === "edit" || card.name === "write")) {
        answer(false);
        return [];
      }
      if (turn.ask) return [{ kind: "ask", requestId: approvalId, tool: card.name, input: card.args, reply: (allow) => answer(allow) }];
      answer(false);
      blocked.push(askedItem(card.name, card.args));
      return [];
    };

    const item = (method: string, it: Record<string, any>): AdapterOut[] => {
      const id = str(it.itemId);
      const kind = str(it.kind);
      if (id && kind) kinds.set(id, kind);
      switch (kind) {
        case "agentMessage":
        case "reasoning": {
          if (method !== "item/completed") return [];
          const full = kind === "reasoning" ? (Array.isArray(it.summary) ? it.summary.map(str).join("\n") : str(it.summary)) : str(it.text);
          const rest = full.slice(streamed.get(id) ?? 0);
          if (!rest) return [];
          if (kind === "reasoning") thought += rest;
          else text += rest;
          return [{ kind: "delta", text: rest, channel: kind === "reasoning" ? "reasoning" : "text" }];
        }
        case "toolCall": {
          // Sending a subagent off, waiting on it and reading what it found are its subagent card, not steps of their own.
          if (/^subagent_/.test(str(it.tool))) return [];
          const callId = str(it.callId) || id;
          const card = museCard(str(it.tool), museArgs(it.args));
          const out: AdapterOut[] = [];
          if (!drawn.has(callId)) {
            drawn.add(callId);
            out.push(...step([call(callId, card.name, card.args)]));
          }
          if (method === "item/completed") {
            const bad = it.status === "failed" || it.status === "cancelled" || !!it.failureReason;
            out.push(result(callId, card.name, str(it.visibleOutput) || str(it.output) || str(it.failureReason), bad));
          }
          return out;
        }
        case "subagent": {
          const taskId = str(it.subagentId) || id;
          const description = firstLine(str(it.objective) || str(it.fallbackText).replace(/^Subagent:\s*/, ""));
          const out: AdapterOut[] = [];
          if (!subsSeen.has(taskId)) {
            subsSeen.add(taskId);
            out.push({ kind: "task", id: taskId, status: "running", ...(description ? { description } : {}), ...(it.role ? { agentType: str(it.role) } : {}) });
          }
          // Back once it has a result (Muse says so on an update, still "inProgress"), or once its item ends.
          const summary = str(it.result?.summary) || str(it.result?.text);
          const ended = method === "item/completed" || !!summary || !!it.failureReason;
          if (ended && !subsBack.has(taskId)) {
            subsBack.add(taskId);
            const status = it.status === "failed" || (it.failureReason && !summary) ? "error" : it.status === "cancelled" ? "stopped" : "done";
            out.push({ kind: "task", id: taskId, status, ...(summary ? { summary: cut(summary, 2000) } : {}) });
          }
          return out;
        }
        default:
          // Its own reminders, workflows and the echo of the instruction: the room sees what they lead to instead.
          return [];
      }
    };

    const parse = ((line: string): AdapterOut[] => {
      const m = json(line);
      if (!m || over) return [];
      // A question it asks, with an id of its own to answer.
      if (m.method && m.id !== undefined) {
        if (m.method === "approval/request") return approval(m.id, m.params ?? {});
        wire.write(rpc({ id: m.id, error: { code: -32601, message: `Friday doesn't handle ${str(m.method)}` } }));
        return [];
      }
      // The answer to something Friday asked.
      if (m.id !== undefined && !m.method) {
        if (m.id === 0) {
          if (m.error) return failed("Muse Code didn't start", m.error);
          wire.write(rpc({ method: "initialized" }));
          return openSession();
        }
        const then = waiting.get(Number(m.id));
        waiting.delete(Number(m.id));
        return then ? then(m) : [];
      }
      const p = m.params ?? {};
      if (sid && p.sessionId && p.sessionId !== sid) {
        // A subagent's own session: its approvals come to Friday by request; what it does is its parent's subagent item.
        return [];
      }
      switch (m.method) {
        case "item/delta": {
          const id = str(p.itemId);
          const kind = kinds.get(id);
          const d = str(p.delta);
          if (!d || (kind !== "agentMessage" && kind !== "reasoning")) return [];
          streamed.set(id, (streamed.get(id) ?? 0) + d.length);
          if (kind === "reasoning") thought += d;
          else text += d;
          return [{ kind: "delta", text: d, channel: kind === "reasoning" ? "reasoning" : "text" }];
        }
        case "item/started":
        case "item/updated":
        case "item/completed":
          return p.item && typeof p.item === "object" ? item(m.method, p.item) : [];
        case "session/tokenUsage": {
          const u = p.usage ?? {};
          const cached = count(u.cacheReadTokens) || count(u.cachedTokens);
          used = { input: used.input + Math.max(0, count(u.inputTokens) - cached), cached: used.cached + cached, output: used.output + count(u.outputTokens) };
          return [];
        }
        case "session/contextUsage":
          ctx = { context: count(p.usedTokens), window: count(p.windowTokens) };
          return [];
        case "turn/completed": {
          if (turnId && p.turnId && p.turnId !== turnId) return [];
          const end = str(p.terminal);
          return finish(end === "failed" ? str(p.error?.message) || str(p.failureReason) || "The turn failed" : undefined);
        }
        case "session/closed":
          return finish(turnId ? undefined : "Muse Code closed the conversation before the turn began");
        default:
          return [];
      }
    }) as Parser;
    parse.cancel = () => {
      if (sid && turnId && !over) ask("turn/interrupt", { sessionId: sid, turnId }, () => []);
    };
    return parse;
  },
  explain(error) {
    if (/authentication required|not logged in|muse login/i.test(error)) return "Muse Code isn't signed in on this computer: run `muse login` in a terminal there, then try again.";
    return error;
  },
};

export const ADAPTERS: Record<EngineTool, Adapter> = { claude, codex, cursor, copilot, opencode, gemini, devin, junie, kiro, droid, grok, cline, kilo, amp, muse, acp: custom };

// ── finding the executables ──────────────────────────────────────────

const WINDOWS = process.platform === "win32";

/**
 * Places these CLIs install to. An app launched from the Dock (or the Start
 * menu) gets a bare PATH, so looking only at PATH would miss nearly everyone's.
 */
function extraDirs(): string[] {
  const h = homedir();
  if (WINDOWS) {
    const roaming = process.env.APPDATA ?? path.join(h, "AppData", "Roaming");
    const local = process.env.LOCALAPPDATA ?? path.join(h, "AppData", "Local");
    return [
      path.join(h, ".local", "bin"),
      path.join(roaming, "npm"),
      path.join(local, "Microsoft", "WinGet", "Links"),
      path.join(local, "Programs", "cursor", "resources", "app", "bin"),
      path.join(h, ".bun", "bin"),
      path.join(h, ".volta", "bin"),
      path.join(h, ".cursor", "bin"),
      // Where Cursor's command-line agent installs itself on Windows.
      path.join(local, "cursor-agent"),
      // Devin's and Kiro's own installers: on PATH only for programs started after them, so Friday looks here itself.
      path.join(local, "devin", "cli", "bin"),
      path.join(local, "Kiro-Cli"),
    ];
  }
  return [
    path.join(h, ".local", "bin"),
    path.join(h, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(h, ".npm-global", "bin"),
    path.join(h, ".bun", "bin"),
    path.join(h, ".volta", "bin"),
    path.join(h, ".cursor", "bin"),
  ];
}

/** PATH for the child: node-based CLIs need `node` findable too. */
export function childPath(): string {
  return [...new Set([...(process.env.PATH ?? "").split(path.delimiter), ...extraDirs()].filter(Boolean))].join(path.delimiter);
}

/**
 * Variables a Claude app (or Claude Code) session sets for the tools *it* runs.
 * If the runner is started from inside one, passing these on would hand the
 * CLI that session's private messaging channel and host-provided sign-in —
 * to a process that other people in the room are steering. So they're dropped.
 * Settings a person chose themselves (CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_USE_BEDROCK…) stay.
 */
const HOST_SESSION_VARS = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_DESKTOP_APP_VERSION",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES",
  "CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL",
  "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
  "CLAUDE_CODE_REPORT_FINDINGS",
  "CLAUDE_CODE_EAGER_FLUSH",
  "CLAUDE_CODE_DISABLE_CRON",
  "CLAUDE_CODE_DISABLE_TERMINAL_TITLE",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_PREVIEW_CLASSIFIER_FLOOR",
  "AI_AGENT",
  "BAGGAGE",
]);

/**
 * A person's own shell's variables: this process's, less the ones a host Claude Code session set, which a coding tool started in
 * the shell would take as its own. Claude Code reading an inherited CLAUDE_CODE_CHILD_SESSION stopped saving its transcript, so
 * the conversation carried on in the terminal view was lost to Friday (Arun's screenshot, 2026-10-30).
 */
export function shellEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !HOST_SESSION_VARS.has(k) && !k.startsWith("CLAUDE_CODE_SDK_")) env[k] = v;
  return env;
}

export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const hosted = !!(base.CLAUDECODE || base.CLAUDE_CODE_ENTRYPOINT || base.CLAUDE_CODE_DESKTOP_APP_VERSION);
  const env: NodeJS.ProcessEnv = { ...base, PATH: childPath() };
  for (const k of Object.keys(env)) if (HOST_SESSION_VARS.has(k) || k.startsWith("CLAUDE_CODE_SDK_")) delete env[k];
  // Inside a host session this points at the host's local auth proxy, not at
  // anything the person configured, and it only works with the host's token.
  if (hosted && env.ANTHROPIC_BASE_URL && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(env.ANTHROPIC_BASE_URL)) delete env.ANTHROPIC_BASE_URL;
  return env;
}

/** Claude Code that came inside the Claude desktop app, rather than a separate install. */
export const isClaudeAppBundled = (bin: string) => {
  // Compared with forward slashes whatever the host: a path can arrive from
  // either platform, so path.sep would only recognise the local one's shape.
  const p = bin.replace(/\\/g, "/");
  return p.includes("/Application Support/Claude/claude-code/") || p.includes("/Roaming/Claude/claude-code/");
};

/**
 * Run a CLI and collect what it said. For the short, non-interactive commands.
 *
 * Through `launcher`, like every other start: on Windows Codex and Cursor are found as `.cmd` shims, which Node refuses to
 * spawn without a shell ("spawn EINVAL"), so signing out of either never ran and said "still signed in: spawn EINVAL".
 */
export async function runCli(bin: string, args: string[], timeoutMs = 20_000, extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const how = await launcher(bin);
  const r = await execCli(how.command, [...how.prefix, ...args], { env: { ...childEnv(), ...how.env, ...extraEnv }, timeoutMs });
  return { code: r.code, out: `${r.stdout}${r.stderr}`.trim() };
}

/**
 * Whether the CLI is signed in, without making a model call. null when the
 * CLI can't say (an older version, or one that prints something unexpected).
 */
export async function loginStatus(tool: EngineTool, bin: string, account?: string): Promise<boolean | null> {
  const status = ADAPTERS[tool].status;
  if (!status) return null;
  if (typeof status === "function") return status(bin);
  const args = status.args;
  // Can't be launched at all: that is a question for start(), not a sign-in answer.
  const how = await launcher(bin).catch(() => null);
  if (!how) return null;
  // As one of its accounts (accounts.ts), when it is run as one.
  const { code, stdout, stderr } = await execCli(how.command, [...how.prefix, ...args], { env: { ...childEnv(), ...how.env, ...accountEnv(tool, account) }, timeoutMs: 8000 });
  const out = `${stdout}\n${stderr}`;
  if (tool === "claude") {
    try {
      const j = JSON.parse(stdout);
      return typeof j.loggedIn === "boolean" ? j.loggedIn : null;
    } catch {
      return null;
    }
  }
  if ((status.signedOut ?? /not logged in|logged out|no credentials|unauthenticated/i).test(out)) return false;
  if (code === 0 && (status.signedIn ?? /logged in|signed in|authenticated/i).test(out)) return true;
  return code === -1 ? null : code === 0 ? null : false;
}

/**
 * Whether Copilot has anyone signed in, from the list of users in its config: it has no command that says (October 2026), and
 * `copilot <anything else>` starts a session. Only whether that list has anyone in it is read, never a token. The file starts
 * with `//` comment lines (1.0.95), which JSON.parse refuses. The key has been spelled both ways in versions people have
 * reported; null when neither is there.
 *
 * No config at all is a Copilot never signed in on this computer, unless a token is set for it: that read "can't tell", which
 * the app takes as ready, so a fresh install offered Copilot as Ready and its first turn stopped on "isn't signed in" (Arun,
 * 2026-10-30: the first few minutes after install are where people quit).
 */
export async function copilotSignedIn(home = process.env.COPILOT_HOME || path.join(homedir(), ".copilot"), env: NodeJS.ProcessEnv = process.env): Promise<boolean | null> {
  try {
    const text = (await readFile(path.join(home, "config.json"), "utf8")).replace(/^\s*\/\/.*$/gm, "");
    const j = JSON.parse(text) as Record<string, unknown>;
    const users = j.loggedInUsers ?? j.logged_in_users;
    return Array.isArray(users) ? users.length > 0 : null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return null;
    return env.COPILOT_GITHUB_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN ? null : false;
  }
}

/** FRIDAY_CLAUDE_BIN, FRIDAY_COPILOT_BIN...: a tool's executable named by hand. */
const envBin = (tool: EngineTool) => `FRIDAY_${tool.toUpperCase()}_BIN`;

/**
 * Extensions a Windows executable can carry, best first.
 *
 * `.exe` is preferred because it can be spawned directly; a `.cmd` is an npm
 * shim that has to be unwrapped (see `launcher`). The extensionless file npm
 * also writes is a shell script, useless outside a POSIX shell, so it comes
 * last and is only ever reached through a shebang.
 */
const WIN_EXTS = [".exe", ".cmd", ".bat", ""];

async function executable(p: string): Promise<boolean> {
  try {
    // Windows has no execute bit: X_OK there is the same as "exists", and the
    // extension is what decides whether a file can run.
    await access(p, WINDOWS ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Candidate filenames for one command, in the order worth trying. */
function candidates(name: string): string[] {
  if (!WINDOWS) return [name];
  return path.extname(name) ? [name] : WIN_EXTS.map((e) => name + e);
}

/** Claude Code as bundled with the Claude desktop app, newest version first. */
async function bundledClaude(): Promise<string[]> {
  const roots = WINDOWS
    ? [path.join(process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"), "Claude", "claude-code")]
    : [path.join(homedir(), "Library", "Application Support", "Claude", "claude-code")];
  const out: string[] = [];
  for (const root of roots) {
    const versions = await readdir(root).catch(() => []);
    for (const v of versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      // Windows ships the executable straight in the version folder; macOS puts
      // it inside an .app bundle.
      out.push(WINDOWS ? path.join(root, v, "claude.exe") : path.join(root, v, "claude.app", "Contents", "MacOS", "claude"));
    }
  }
  return out;
}

/**
 * loginStatus, remembered briefly.
 *
 * Asking costs a process start each, and a card that refreshes every few
 * seconds was starting three of them every few seconds. Anything but signed in
 * is looked at again after five seconds, because somebody who has just signed
 * in is watching for it to change.
 *
 * Signed in is answered at once, and looked at again behind the answer once it
 * is ten minutes old. Waiting on that look, the next hand-off (which comes at the
 * end of a long run, so nearly always after ten minutes) sat for three seconds on
 * Claude Code's own check before anything else began; never looking again, a
 * login that expired or was signed out of in a terminal said Ready for as long as
 * the app ran. Now one answer after the change is the stale one.
 */
const statusMemo = new Map<string, { at: number; value: Promise<boolean | null> }>();
/** The last answer each CLI actually gave, kept while a newer one is being worked out. */
const lastStatus = new Map<string, boolean>();
/** CLIs whose signed-in answer is being looked at again, so a card refreshing every few seconds starts one look, not many. */
const refreshing = new Set<string>();
export async function loginStatusCached(tool: EngineTool, bin: string, account?: string): Promise<boolean | null> {
  const key = `${tool}|${bin}|${account ?? ""}`;
  const hit = statusMemo.get(key);
  if (hit) {
    const value = await hit.value;
    if (value === true) {
      if (Date.now() - hit.at >= 600_000 && !refreshing.has(key)) {
        refreshing.add(key);
        void Promise.race([loginStatus(tool, bin, account), new Promise<null>((r) => setTimeout(() => r(null), 5_000))])
          .then((v) => {
            // Not over a sign-in or sign-out through Friday that happened meanwhile (forgetLoginStatus).
            if (v === null || statusMemo.get(key) !== hit) return;
            statusMemo.set(key, { at: Date.now(), value: Promise.resolve(v) });
            lastStatus.set(key, v);
          })
          .finally(() => refreshing.delete(key));
      }
      return true;
    }
    if (Date.now() - hit.at < 5_000) return value;
  }
  const entry = { at: Date.now(), value: Promise.race([loginStatus(tool, bin, account), new Promise<null>((r) => setTimeout(() => r(null), 5_000))]) };
  statusMemo.set(key, entry);
  const value = await entry.value;
  entry.at = Date.now();
  if (value !== null) lastStatus.set(key, value);
  return value;
}
/**
 * loginStatusCached, answered within `ms`.
 *
 * Claude Code's own check takes two or three seconds on Windows. Past the budget this answers with what the CLI said last
 * time rather than "don't know": a "not logged in" that is five seconds old would otherwise be replaced by a fresh check
 * on every look, which never finishes in time, so the card said "ready" for a CLI that could not run.
 */
export function loginStatusQuick(tool: EngineTool, bin: string, ms = 1_500, account?: string): Promise<boolean | null> {
  return Promise.race([loginStatusCached(tool, bin, account), new Promise<boolean | null>((r) => setTimeout(() => r(lastStatus.get(`${tool}|${bin}|${account ?? ""}`) ?? null), ms))]);
}
/** Forget what was learned: after a sign-in or sign-out the answer has changed. */
export function forgetLoginStatus(): void {
  statusMemo.clear();
  lastStatus.clear();
}

/**
 * Where each CLI was found, by tool and PATH, for as long as this process runs: a hand-off or a start used to walk every
 * folder on PATH again for a binary that had not moved. A hit is checked to still be there (one look, not thirty), and a
 * miss is never kept, so a CLI installed a moment ago is found on the next look.
 */
const binMemo = new Map<string, string>();
/** How many times findBin walked PATH rather than answering from memory (for tests). */
export const binScans = { count: 0 };

export async function findBin(tool: EngineTool): Promise<string | null> {
  const override = process.env[envBin(tool)];
  if (override) return (await executable(override)) ? override : null;
  // "Other ACP agent" is whatever its saved setting says now, so it is read each time.
  if (tool === "acp") return scanBin(tool);
  const key = `${tool}|${childPath()}`;
  const hit = binMemo.get(key);
  if (hit && (await executable(hit))) return hit;
  const found = await scanBin(tool);
  if (found) binMemo.set(key, found);
  else binMemo.delete(key);
  return found;
}

async function scanBin(tool: EngineTool): Promise<string | null> {
  binScans.count++;
  const dirs = childPath().split(path.delimiter);
  // The agent set for "Other ACP agent": its own path, or a name looked for on PATH like any other.
  if (tool === "acp") {
    const set = await readCustomAcp();
    if (!set) return null;
    if (path.isAbsolute(set.command)) return (await executable(set.command)) ? set.command : null;
    for (const c of candidates(set.command)) {
      const hits = await Promise.all(dirs.map((d) => executable(path.join(d, c))));
      const at = hits.indexOf(true);
      if (at >= 0) return path.join(dirs[at]!, c);
    }
    return null;
  }
  for (const name of ADAPTERS[tool].bins) {
    // Every folder on PATH, asked at once: one after another this was most of
    // two seconds on a machine with a long PATH and a virus scanner. The
    // order still decides — the first folder that has it wins.
    for (const c of candidates(name)) {
      const hits = await Promise.all(dirs.map((d) => executable(path.join(d, c))));
      const at = hits.indexOf(true);
      if (at >= 0) return path.join(dirs[at]!, c);
    }
  }
  if (tool === "claude") for (const p of await bundledClaude()) if (await executable(p)) return p;
  return null;
}

/**
 * The app behind a tool is here, even when its command-line agent is not.
 *
 * Cursor is the case that matters: the editor is what most people download,
 * and it ships a `cursor` command that only opens files. The headless agent
 * Friday drives is a separate install, so "Cursor is on this computer" and
 * "Friday can use Cursor" are different facts and the card should say which.
 */
export async function findApp(tool: EngineTool): Promise<boolean> {
  if (tool !== "cursor") return false;
  if (process.platform === "darwin" && (await executable("/Applications/Cursor.app"))) return true;
  for (const d of childPath().split(path.delimiter)) {
    for (const c of candidates("cursor")) if (await executable(path.join(d, c))) return true;
  }
  return false;
}

export interface Launch {
  command: string;
  /** Arguments that come before the CLI's own, e.g. the script for `node`. */
  prefix: string[];
  /** Variables its own launcher would have set, added to the child's environment. */
  env?: Record<string, string>;
}

/** Codex's npm entry point: a node script whose only job is to find Codex's own executable and start it. */
const CODEX_JS = "@openai/codex/bin/codex.js";
/** The platforms Codex ships an executable for, as its launcher names them. */
const CODEX_TRIPLES: Record<string, string> = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
};

/**
 * Codex's own executable, from behind its npm launcher.
 *
 * The launcher starts a whole node process to look up where the executable is and start that: on Windows most of a
 * second before every Codex turn and every hand-off to it. Started directly it is the same program with the same
 * arguments, found where the launcher looks; the two variables the launcher sets only tell Codex how it was installed,
 * for its update notices. Null for anything else, which is started the way it always was.
 */
export async function codexNative(script: string): Promise<Launch | null> {
  if (!script.replace(/\\/g, "/").endsWith(CODEX_JS)) return null;
  const triple = CODEX_TRIPLES[`${process.platform}-${process.arch}`];
  if (!triple) return null;
  const root = await realpath(path.join(path.dirname(script), "..")).catch(() => null);
  if (!root) return null;
  let platformDir: string | null = null;
  try {
    platformDir = path.dirname(createRequire(path.join(root, "bin", "codex.js")).resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`));
  } catch {
    // An older layout keeps the executable in the package itself.
  }
  for (const dir of [platformDir, root]) {
    const exe = dir && path.join(dir, "vendor", triple, "bin", WINDOWS ? "codex.exe" : "codex");
    if (exe && (await executable(exe))) return { command: exe, prefix: [], env: { CODEX_MANAGED_BY_NPM: "1", CODEX_MANAGED_PACKAGE_ROOT: root } };
  }
  return null;
}

/** The JS file an npm `.cmd` shim actually runs. */
const SHIM_TARGET = /"%(?:~)?dp0%?\\?([^"]+\.(?:js|mjs|cjs))"/i;
/**
 * The other two shapes an npm shim takes: a native executable it runs as it is (OpenCode's `bin\opencode.exe`), and a Node
 * script with no extension it hands to node (Kilo's and Cline's `bin\kilo`, `bin\cline`).
 */
// The line that runs it, followed by `%*`: a shim also names `%dp0%\node.exe` when it checks for a node beside itself.
const SHIM_EXE = /"%(?:~)?dp0%?\\?([^"]+\.exe)"\s+%\*/i;
const SHIM_NODE = /"%_prog%"\s+"%(?:~)?dp0%?\\?([^"]+)"/i;

/**
 * How to start a resolved binary.
 *
 * A native executable is spawned as itself. Everything else needs unwrapping,
 * and on Windows that matters more than it looks: `spawn` cannot run a `.cmd`
 * at all without a shell, and a shell is not an option here — the Claude
 * adapter passes a multi-line system prompt as one argv element, and cmd.exe
 * cannot carry a newline through a command line at any quoting level. So an
 * npm shim is read for the JS file it points at, and that is run with this
 * process's own node, which takes the arguments verbatim.
 */
/**
 * Cursor's CLI on Windows is a .cmd that runs a PowerShell script that picks
 * the newest folder under versions/ and runs node.exe on its index.js. None of
 * that can be started without a shell, so go straight to what it would run.
 */
async function versionedNode(bin: string): Promise<Launch | null> {
  const root = path.dirname(bin);
  const day = (n: string) => {
    const m = n.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})/);
    return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : 0;
  };
  const found = await readdir(path.join(root, "versions"), { withFileTypes: true }).catch(() => []);
  const names = found
    .filter((d) => d.isDirectory() && day(d.name) > 0)
    .map((d) => d.name)
    .sort((a, b) => day(b) - day(a) || b.localeCompare(a));
  for (const n of ["", ...names.map((x) => path.join("versions", x))]) {
    const dir = path.join(root, n);
    if ((await executable(path.join(dir, "node.exe"))) && (await executable(path.join(dir, "index.js")))) return { command: path.join(dir, "node.exe"), prefix: [path.join(dir, "index.js")] };
  }
  return null;
}

/**
 * The program that runs a CLI's JavaScript.
 *
 * Inside the desktop app, `process.execPath` is the app itself: a window
 * program with no console. A script it runs that starts the real executable —
 * which is exactly what Codex's launcher does — hands that executable a console
 * of its own, because there is none to share, and Windows draws it. Hiding the
 * first process doesn't reach the one it starts. A real `node` has a console
 * (hidden, when we start it hidden) that everything under it shares, so the
 * whole chain stays out of sight. Without node on the machine, the app itself
 * is all there is.
 */
let nodeFound: Promise<string> | null = null;
export function nodeForScripts(): Promise<string> {
  if (!process.versions.electron) return Promise.resolve(process.execPath);
  nodeFound ??= (async () => {
    for (const d of childPath().split(path.delimiter)) {
      for (const name of WINDOWS ? ["node.exe"] : ["node"]) {
        const p = path.join(d, name);
        if (await executable(p)) return p;
      }
    }
    return process.execPath;
  })();
  return nodeFound;
}

export async function launcher(bin: string): Promise<Launch> {
  const ext = path.extname(bin).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return (await codexNative(bin)) ?? { command: await nodeForScripts(), prefix: [bin] };
  if (WINDOWS && (ext === ".cmd" || ext === ".bat")) {
    const shim = await readFile(bin, "utf8").catch(() => "");
    const m = shim.match(SHIM_TARGET);
    if (m) {
      const script = path.resolve(path.dirname(bin), m[1]!);
      return (await codexNative(script)) ?? { command: await nodeForScripts(), prefix: [script] };
    }
    const exe = shim.match(SHIM_EXE);
    if (exe) return { command: path.resolve(path.dirname(bin), exe[1]!), prefix: [] };
    const script = shim.match(SHIM_NODE);
    if (script) return { command: await nodeForScripts(), prefix: [path.resolve(path.dirname(bin), script[1]!)] };
    const versioned = await versionedNode(bin);
    if (versioned) return versioned;
    throw new Error(
      `${bin} is a script wrapper this runner can't start directly. Point its FRIDAY_<TOOL>_BIN (FRIDAY_CODEX_BIN, FRIDAY_COPILOT_BIN...) at the real executable (a .exe, or the CLI's own .js entry point).`,
    );
  }
  // On macOS and Linux npm's `codex` is a link to that same launcher script.
  if (!WINDOWS && path.basename(bin) === "codex") {
    const native = await codexNative(await realpath(bin).catch(() => bin));
    if (native) return native;
  }
  return { command: bin, prefix: [] };
}
