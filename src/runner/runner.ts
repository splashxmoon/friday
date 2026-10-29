import { realpathSync } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir, hostname, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import WebSocket from "ws";
import { clock, closingSaid, keepAlive } from "../heartbeat.js";
import { CLI_ID, ENGINE_NAMES, isEngineEffort, type Attachment, type EngineMode, type EngineTool, type ToolCommand, type DiffFile } from "../types.js";
import { ADAPTERS, DECIDE_YOURSELF, PLAN_REFUSES, askedItem, childEnv, claudeMcpServers, claudePictures, imageType, codexExec, findBin, launcher, loginStatusCached, loginStatusQuick, tooLongForArgv, withDirs, type Adapter, type AdapterOut, type Launch, type TurnSpec } from "./adapters.js";
import { folderVars } from "./environment.js";
import { applyCopy, baseAfterCommit, checkpoint, diffSince, diffTrees, dropShadow, fetchBranch, repoInfo, sameTree, sessionBase, setSessionBase, shadowSnapshot, switchBranch, trackBranch, warmSnapshot, type RepoInfo, type Shadow } from "./git.js";
import { hasCliTranscript, readCliTranscript } from "./imports.js";
import { readRepo, type RepoRequest } from "./repo-read.js";
import { noteClaudeStarting, readLimits } from "./limits.js";
import { accountEnv, DEFAULT_ACCOUNT, getAccount, hasAccounts, isOut, listAccounts, markOut, nextAccount, prepareAccountDir, type ToolAccount } from "./accounts.js";
import { usesApiKey } from "./api-key.js";
import { limitHit } from "../limit-reset.js";
import { shellName } from "./background.js";
import { Prespawn, spawnCli, WarmAcp, WarmClaude, type AcpHow, type CliProcess } from "./spawn-cli.js";
import { CODEX_BUILTINS, expandCommand, skillCommands, toolCommandsIn } from "./tool-commands.js";
import { skillsNote } from "./shared-skills.js";
import { parseContextReport, type ToolContext } from "./context-report.js";
import { projectMcpServers, type AcpMcpServer } from "./mcp-servers.js";
import { nodeForScripts } from "./adapters.js";
import { AUTO_MODE, autoModeRefused } from "./adapters.js";
import { acpEntry, ensureCursorEntry, openFridayMcp, type FridayMcp, type MeshAnswer } from "./friday-mcp.js";
import { canScreenshot, screenshot } from "./screenshot.js";
import { firstWordMs, hungMs, isHung, neverStarted, quietMs, treeCpu } from "./hung.js";
import { localEdition } from "../local-edition.js";

/**
 * The runner: a small process on the host's machine that attaches their own
 * logged-in coding CLI to a Friday session.
 *
 * It holds no model key and makes no model calls. It receives the driver's
 * instructions, runs the CLI headless in the host's folder, and reports back
 * what the CLI said and did, plus a git diff of what changed. Everything else —
 * who may steer, queueing, interrupts, the log — stays on the server.
 */

export interface RunnerOptions {
  /** Friday server origin, e.g. http://localhost:3000 */
  server: string;
  /** A teammate's id: its conversation is kept under it, not under the server, session, lane and folder (resumeKey). */
  keepAs?: string;
  session: string;
  invite: string;
  userId: string;
  name: string;
  /**
   * The CLI to run. Omitted to lend the folder without one: the runner still
   * bridges reads, edits, commands, previews and diffs, and Friday's own agent
   * does the work on the server side.
   */
  tool?: EngineTool;
  cwd: string;
  /** The folder this one is a separate copy of (a worktree made for it): where Apply puts the agent's work. */
  copyOf?: string;
  /** Works in the folder beside another agent that edits it, by choice, rather than in a copy (EngineInfo.shared). */
  share?: boolean;
  /** Folders its tool may work in besides `cwd`, as the tool's own --add-dir has them (see TurnSpec.dirs). */
  dirs?: string[];
  mode?: EngineMode;
  /**
   * The mode its host picked by hand, when `mode` was chosen automatically for the host's next piece of work (smartReach.ts):
   * the server then holds everyone else's turns to it (`turn.mode`).
   */
  handMode?: EngineMode;
  /** Attach to an existing lane. Defaults to the main lane. */
  lane?: string;
  /** Or create a lane beside Friday Code, with this name (owners only). */
  newLane?: string;
  /** Switch the folder to this branch before starting. */
  branch?: string;
  /**
   * Where `branch` starts when it has to be made (a branch, or `origin/<name>`): the branch picked on the new-session page,
   * rather than whatever the folder happens to be on. A runner too old to know it makes the branch from the checkout.
   */
  branchFrom?: string;
  /**
   * The session's branch, from another machine: switched to like `branch` when it can be had with its commits (here
   * already, or fetched from origin), and left alone when it can't, rather than made up from whatever this checkout is on.
   * Its own option, not `branch`, so a runner too old to know it stays where it is instead of making one up.
   */
  followBranch?: string;
  /**
   * Continue one of the CLI's own past conversations instead of starting a new
   * one: its context and memory come with it.
   */
  resumeId?: string;
  /**
   * Resume it only if this machine has it, and otherwise start fresh with the session's copy as history: a hand-off, which
   * can land on a teammate's computer or the person's other one. Without it the id is the CLI's to resolve, as chosen.
   */
  resumeIfHere?: boolean;
  /**
   * Carry on from a copy of that conversation (Claude Code's --fork-session, Codex's thread/fork) rather than the conversation
   * itself: it was shared from a terminal where it is still open, and two writers on one transcript would garble it.
   */
  resumeFork?: boolean;
  resumeTitle?: string;
  resumeMessages?: number;
  /** The tool that conversation was with. Another tool cannot resume it, so it is shared into the session as history instead. */
  resumeTool?: EngineTool;
  /** One of that CLI's own models; its default when omitted. */
  model?: string;
  /**
   * Which of the tool's accounts on this computer it runs as (accounts.ts): Claude Code and Codex can have more than one. Its own
   * sign-in when omitted, unless that is out of usage and another isn't.
   */
  account?: string;
  /** Permission to act as this person in this session, minted by the server. */
  actorToken?: string;
  /** Path to the CLI; found automatically if omitted. */
  bin?: string;
  /** Attaching again to a lane it held until its connection dropped (see stayAttached). */
  reattach?: boolean;
  /** The repository of a copy made a moment ago (addWorktree), which is not asked again. */
  repo?: RepoInfo | null;
  /** What the copy's `.worktreeinclude` names, brought over once the lane is there: its first turn waits for it (addWorktree). */
  include?: () => Promise<unknown>;
  log?: (line: string) => void;
}

type ServerMsg =
  /**
   * `imported`: the conversation this runner was started from is in the session already, so it needn't be read and sent again.
   * `system`: what the lane's next turn will be told besides its instruction, so the CLI can be started before it comes.
   * `effort`: the lane's level (see laneEffort), so that CLI is started with the flag the first turn will carry.
   */
  | { kind: "attached"; lane: string; laneName: string; imported?: boolean; system?: string; effort?: string }
  /** An approval carries what was asked, read back from the log: the runner that asked may not be the one that hears the answer. */
  /** `command`: the message as typed when it is a lone `/command`, which the tool's own (see ownCommand) is used as instead. */
  | { kind: "turn"; id: string; prompt: string; system: string; attachments?: Attachment[]; approval?: { id: string; approve: boolean; scope?: "commands" | "turn"; items?: string[] }; command?: string; /** The model an Auto lane runs this turn on (routing.ts), and how hard it thinks, for a tool that takes that. */ model?: string; effort?: string; /** The most this turn may do: someone other than the host's, on a lane switched automatically (capMode). */ mode?: EngineMode; /** This turn starts a run: take its checkpoint before the tool hears it, and say it (see turnCheckpoint). */ checkpoint?: boolean; /** Handed back after a dropped connection: the turn a runner before this one may still have running (see adopt). */ again?: boolean }
  | { kind: "stop"; reason: string }
  /** A message for the turn running now, to read at its next step (Parser.steer); answered with `steer.result`. */
  | { kind: "steer"; id: string; text: string }
  /** A person's answer to what the tool is waiting on mid-turn (an `engine.approval` sent `live`). */
  | { kind: "approval"; id: string; approve: boolean }
  /** Someone else in the session asking to read the folder this runner opened. */
  | ({ kind: "repo"; id: string } & Omit<RepoRequest, "mode">)
  | { kind: "released" }
  /** The server's answer to one of its tool's `friday` MCP calls (friday-mcp.ts). */
  | ({ kind: "mesh.result"; id: string } & MeshAnswer);

/** Questions about the folder that change nothing in it, so they needn't wait for the snapshot. */
/** What Runner.start asks before connecting, as one object so a test can watch the order the questions are asked in. */
export const startChecks = { findBin, loginStatusQuick, loginStatusCached, launcher, repoInfo, warmSnapshot };

const READ_ONLY = new Set<string>(["tree", "read", "search", "remote", "branches", "prcomments", "prstatus", "commands", "context", "status", "log", "show", "gitdiff", "compare"]);

/** A run stopped by the account's allowance running out, not a rate limit a moment's wait clears (limit-reset.ts reads both). */
export const OUT_OF_USAGE = /usage limit|session limit|weekly limit|5-hour limit|hit your limit|limit reached|out of (?:usage|credits)/i;

/**
 * One model the account can't run, not the account out of usage: "Fable 5.1 requires usage credits. Switch to another model".
 * Claude Code set to Fable stopped there before doing anything, and stayed stopped until a person reconnected it on another
 * model (Arun, 2026-10-25). Its turns run on MODEL_FALLBACK instead, from then on.
 */
export const MODEL_UNPAID = /requires (?:usage )?credits|switch to another model|(?:isn't|is not|not) (?:available|included) (?:on|in|with) your (?:plan|subscription)/i;
const MODEL_FALLBACK: Partial<Record<EngineTool, string>> = { claude: "sonnet" };

export class RunnerError extends Error {
  constructor(
    message: string,
    /** WebSocket close code, when the server turned the runner away. */
    readonly code?: number,
  ) {
    super(message);
  }
}

/** Where each CLI's conversation id is remembered between runs. */
const stateFile = () => process.env.FRIDAY_RUNNER_STATE ?? path.join(homedir(), ".friday", "runner-sessions.json");
/** Everything in it, or nothing when there is no file yet or it can't be read. */
async function remembered(): Promise<Record<string, string>> {
  try {
    const all = JSON.parse(await readFile(stateFile(), "utf8")) as Record<string, string> | null;
    return all && typeof all === "object" ? all : {};
  } catch {
    return {};
  }
}

/**
 * Close codes the server turns a runner away with. Retrying won't change its answer. 4010 is a folder another agent is
 * already editing: it stays theirs until they stop, and asking every thirty seconds doesn't make it sooner.
 */
export const FINAL = new Set([4000, 4001, 4003, 4004, 4009, 4010]);
/** What a tool says that isn't it working on the turn: which conversation it is in, what it offers (see Runner.turn, `spoke`). */
const BOOKKEEPING = new Set<string>(["session", "models", "efforts", "commands"]);
/** A notification from a tool spoken to over JSON-RPC (Codex's app-server, ACP), as against a reply to a request of ours. */
const TOOL_NOTICE = /"method"\s*:\s*"/;
/** One about the conversation or the account, not the turn's work. */
const SETUP_NOTICE = /"method"\s*:\s*"(?:thread\/(?:started|loaded|name)|account\/|config\/|mcpServer|session\/(?:new|load)\b)/;

/** How long a turn cut off by a dropped connection is kept running for the runner that reconnects to take on (see keepTurn). */
export const KEEP_TURN_MS = 5 * 60_000;
/**
 * What `connect` (the desktop app's link) exits with when the server ends it for good, read by desktop/main.ts:
 * 0, unlinked by its owner; 3, the link token was refused (expired, or forgotten), so the app forgets it and makes a new one;
 * 4, another connection with the same link took over, so this one stops without forgetting anything; 1, anything else.
 * Only 3 may make the app forget the link: it used to forget it on any of them, so a hiccup left the computer unlinked.
 */
export function linkExit(code: number): number {
  return code === 4000 ? 0 : code === 4001 ? 3 : code === 4009 ? 4 : 1;
}

/**
 * 1s, 2s, 4s… up to 10s between attempts, each spread by half either way: after a deploy every runner and link loses the
 * server at the same moment, and without it they all came back at the same moments too. It was up to 30s (45 with the
 * spread), so a laptop that woke up while its Wi-Fi was still joining sat offline for most of a minute after it had joined.
 */
/** "10 minutes", for what the room is told about a quiet tool. */
const minutes = (ms: number) => `${Math.round(ms / 60_000)} minute${Math.round(ms / 60_000) === 1 ? "" : "s"}`;

export const backoff = (attempt: number) => Math.min(10_000, 1000 * 2 ** Math.min(attempt, 4)) * (0.5 + Math.random());

/** Claude Code commands only its own terminal can run (its `terminal_slash_commands`). */
const MODE_RANK: Record<EngineMode, number> = { plan: 0, edits: 1, full: 2 };

/** The lower of a machine's mode and a turn's cap: a cap never raises what the machine's host chose. */
export function capMode(own: EngineMode, cap?: EngineMode): EngineMode {
  return cap && MODE_RANK[cap] !== undefined && MODE_RANK[cap] < MODE_RANK[own] ? cap : own;
}

const TERMINAL_ONLY = new Set(["doctor", "color"]);
/** How long a command list read from a tool's folders is kept before they are read again. */
const SCAN_MS = 15_000;

/**
 * The `/` commands a tool spoken to over ACP last listed, by tool. It says them only once a conversation is open, and opening
 * one just to ask leaves an empty conversation in its history, so the list from the last turn is kept, on disk as well, and
 * is what the menu shows before this lane's first.
 */
const acpCommands = new Map<EngineTool, ToolCommand[]>();
// FRIDAY_STATE_DIR: the tests' own, so a fake tool's commands are never what a real one on this computer shows.
const acpCommandsFile = (tool: EngineTool) => path.join(process.env.FRIDAY_STATE_DIR || path.join(homedir(), ".friday"), `${tool}-commands.json`);
async function knownCommands(tool: EngineTool): Promise<ToolCommand[]> {
  const known = acpCommands.get(tool);
  if (known) return known;
  const saved = await readFile(acpCommandsFile(tool), "utf8")
    .then((t) => JSON.parse(t) as ToolCommand[])
    .catch(() => []);
  const list = Array.isArray(saved) ? saved.filter((c) => typeof c?.name === "string" && typeof c.insert === "string") : [];
  acpCommands.set(tool, list);
  return list;
}
/** Keep a tool's list for next time: the menu shows it before that tool has said its own in a session. */
function rememberCommands(tool: EngineTool, list: ToolCommand[]): void {
  if (JSON.stringify(acpCommands.get(tool)) === JSON.stringify(list)) return;
  acpCommands.set(tool, list);
  const file = acpCommandsFile(tool);
  void mkdir(path.dirname(file), { recursive: true })
    .then(() => writeFile(file, JSON.stringify(list)))
    .catch(() => {});
}
/**
 * The models a tool spoken to over ACP last listed in its `model` option, by tool: for the model picker (local-api `models`),
 * kept on disk as its commands are, since it says them only once a conversation is open.
 */
const acpModels = new Map<EngineTool, { id: string; label: string }[]>();
const acpModelsFile = (tool: EngineTool) => path.join(process.env.FRIDAY_STATE_DIR || path.join(homedir(), ".friday"), `${tool}-models.json`);
export async function knownModels(tool: EngineTool): Promise<{ id: string; label: string }[]> {
  const known = acpModels.get(tool);
  if (known) return known;
  const saved = await readFile(acpModelsFile(tool), "utf8")
    .then((t) => JSON.parse(t) as { id: string; label: string }[])
    .catch(() => []);
  const list = Array.isArray(saved) ? saved.filter((m) => typeof m?.id === "string" && m.id && typeof m.label === "string") : [];
  acpModels.set(tool, list);
  return list;
}
/**
 * The effort levels a tool spoken to over ACP said it has (its `thought_level` option), kept on disk by tool, as its models are:
 * said to the server as the lane attaches (EngineInfo.efforts), so the effort pill offers them. Learned in a conversation, they
 * show from the next time the agent connects.
 */
const effortsFile = (tool: EngineTool) => path.join(process.env.FRIDAY_STATE_DIR || path.join(homedir(), ".friday"), `${tool}-efforts.json`);
export async function knownEfforts(tool: EngineTool): Promise<string[]> {
  const saved = await readFile(effortsFile(tool), "utf8")
    .then((t) => JSON.parse(t) as unknown)
    .catch(() => []);
  return Array.isArray(saved) ? saved.filter(isEngineEffort) : [];
}
function rememberEfforts(tool: EngineTool, list: string[]): void {
  const file = effortsFile(tool);
  void mkdir(path.dirname(file), { recursive: true })
    .then(() => writeFile(file, JSON.stringify(list.filter(isEngineEffort))))
    .catch(() => {});
}

/** Codex's own /review or /compact as typed, as TurnSpec.command: what follows the name is what to review. */
export function builtinOf(text: string): { command: NonNullable<TurnSpec["command"]> } | Record<string, never> {
  const m = /^\/(review|compact)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { command: { name: m[1] as "review" | "compact", args: (m[2] ?? "").trim() } } : {};
}

/** A conversation that couldn't be opened because it is open somewhere else (Codex's app-server, an ACP tool), by how they say it. */
export const busyElsewhere = (error: string): boolean =>
  /(?:thread\/resume|session\/load) failed/.test(error) && /in use|already (?:open|loaded|running|active|attached|subscribed)|locked|busy|another (?:process|client|session)/i.test(error);

function rememberModels(tool: EngineTool, list: { id: string; label: string }[]): void {
  if (!list.length || JSON.stringify(acpModels.get(tool)) === JSON.stringify(list)) return;
  acpModels.set(tool, list);
  const file = acpModelsFile(tool);
  void mkdir(path.dirname(file), { recursive: true })
    .then(() => writeFile(file, JSON.stringify(list)))
    .catch(() => {});
}

/**
 * Which of `flags` a CLI said it doesn't know, from how it failed: commander's "unknown option '--approve-mcps'", clap's
 * "unexpected argument '--mode' found", or a value it won't take for one ("invalid value for --mode"). Null for any other failure.
 */
export function refusedFlag(error: string, flags: string[]): string | null {
  if (!/unknown (?:option|argument|flag)|unrecognized|unexpected argument|invalid (?:value|argument|choice)|is invalid|not a valid|is not allowed/i.test(error)) return null;
  // The flag whole, not the start of a longer one: "--mode" is not named by "--model".
  const named = (f: string) => error.split(f).slice(1).some((after) => !/^[\w-]/.test(after));
  return flags.find(named) ?? null;
}

/**
 * Whether the server's message makes this a Work session's turn: only from the open-source edition's own server (localEdition), whatever another server says.
 * A signed product runner never starts a tool in auto mode, with the person's browser and the network, because a session said so
 * (Arun, 2026-10-28: "iron everything and ensure we are good… any logic errors").
 */
export const workAsked = (m: unknown): boolean => !!(m as { work?: boolean } | null)?.work && localEdition();

/** How long a CLI that has given its final answer gets to exit by itself. */
const FINISH_GRACE_MS = 10_000;

/**
 * How many agent turns are running on this machine, across every lane, said on a line of its own whenever it goes between
 * none and some (`[friday] busy 1` / `[friday] busy 0`). The desktop app reads the runner's output and keeps the computer
 * from sleeping while it is 1 (desktop/main.ts), so a run left going isn't cut off by the computer idling to sleep.
 */
let turnsRunning = 0;
export const BUSY_LINE = "[friday] busy ";
function busy(d: 1 | -1): void {
  const was = turnsRunning > 0;
  turnsRunning = Math.max(0, turnsRunning + d);
  if (turnsRunning > 0 !== was) process.stdout.write(`${BUSY_LINE}${turnsRunning > 0 ? 1 : 0}\n`);
}

/**
 * Keep a runner's lane attached after its connection drops.
 *
 * A deploy, a server restart, a Wi-Fi change or a laptop waking up all close the runner's socket, and the lane stays
 * reserved for this machine meanwhile ("instructions wait until it reconnects"). Only the terminal command used to come
 * back by itself; a lane started from the page or the desktop app stayed offline until its host noticed and pressed
 * Reconnect, and anyone else in the room just saw an agent that never answered.
 *
 * So: attach again to the same lane, backing off, with the same tool, folder and mode. Not the branch (the folder is on
 * it already) and not a new lane (this is that lane). It stops when the server turns it away for good (the lane was
 * removed, released, or taken over by another runner) or when its host stops it. `onRunner` hears each new runner, so
 * whoever keeps a list of them can stop the current one. Resolves with how the last connection ended.
 */
export async function stayAttached(first: Runner, onRunner: (r: Runner) => void = () => {}): Promise<{ code: number; reason: string }> {
  const log = first.opts.log ?? (() => {});
  const lane = first.lane;
  let runner = first;
  let end = await runner.closed;
  let why = `Disconnected at ${clock()} (${end.reason}). Reconnecting…`;
  for (let attempt = 0; !runner.stopped && !FINAL.has(end.code); attempt++) {
    log(why);
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, backoff(attempt));
      void runner.halted.then(() => (clearTimeout(t), resolve()));
    });
    if (runner.stopped) {
      runner.dropKept();
      break;
    }
    // A copy that was thrown away while it was offline has nothing to come back to.
    if (!(await stat(first.opts.cwd).then((s) => s.isDirectory(), () => false))) {
      runner.dropKept();
      return { code: -1, reason: `${first.opts.cwd} isn't there any more.` };
    }
    // Asked again after that look: a Stop, or a new start that stopped this one, in the meantime would otherwise be undone
    // by the runner made next, which would bring the lane back or take it from its replacement.
    if (runner.stopped) break;
    // The branch it was set up on is where it already is: following it again would fetch from origin and could move the checkout.
    const next = new Runner({ ...first.opts, lane, newLane: undefined, branch: undefined, followBranch: undefined, repo: undefined, include: undefined, reattach: true });
    // The turn the one before kept going through the drop is this one's to take on (Runner.adopt): the runner holding it, past
    // any attempt in between that never got connected.
    next.prev = runner.holdsKept() || !runner.prev ? runner : runner.prev;
    runner = next;
    onRunner(next);
    try {
      await next.start();
      attempt = -1;
      end = await next.closed;
      why = `Disconnected at ${clock()} (${end.reason}). Reconnecting…`;
    } catch (e) {
      const err = e as RunnerError;
      // Refused by the server for something retrying can't fix: a folder with somebody's work in it, a lane taken over.
      if (err.code !== undefined && FINAL.has(err.code)) {
        next.prev?.dropKept();
        return { code: err.code, reason: err.message };
      }
      // Anything else is tried again: a CLI not found or "not logged in" just after a wake, before the disk or the network
      // is back, used to end the loop for good, and the lane stayed offline until somebody pressed Reconnect.
      end = { code: err.code ?? -1, reason: err.message };
      why = `${err.message}. Retrying…`;
    }
  }
  // Not coming back: a turn kept going for when it did stops now.
  runner.dropKept();
  runner.prev?.dropKept();
  return end;
}

/**
 * Whether a lane starts its coding tool before its first turn. Not when reconnecting (a lane coming back after a drop would
 * start another one whether or not anyone gives it a turn), and not when its first turn carries on from a copy of a
 * conversation still open in a terminal: a tool started warm opens that conversation itself, and two writers garble it.
 */
export function warmAtStart(o: { reattach?: boolean }, forkNext: boolean): boolean {
  return !o.reattach && !forkNext;
}

export class Runner {
  lane = "";
  laneName = "";
  closed: Promise<{ code: number; reason: string }>;
  /** Stopped by its host: nothing is to bring it back. */
  stopped = false;
  /** Settles when it is stopped, so a wait to reconnect can end early. */
  readonly halted: Promise<void>;
  private onHalted!: () => void;
  private ws: WebSocket | null = null;
  private child: CliProcess | null = null;
  private stopping = false;
  /** A prompt that was stopped before the CLI ever saw it, carried into the next turn. */
  private unrun: string | null = null;
  /** Why the last stop came, as the server put it: what the next turn is told about a prompt that never ran. */
  private stopReason = "";
  private resumeId: string | null = null;
  /** The account its tool runs as, for a tool with more than one (accounts.ts); null for the others. */
  private account: ToolAccount | null = null;
  /** Its tool runs on an API key or a cloud provider, not on its host's own plan (api-key.ts). */
  private apiKey = false;
  /** The picked conversation couldn't be found, so this lane's CLI carries on in a fresh one, which has none of its memory. */
  private lost = false;
  /** The standing instructions the CLI's conversation was last given, so a tool that takes them in its prompt is told again only when they change. */
  private sentSystem: string | null = null;
  /** The skills on this computer this tool doesn't load by itself, for its standing note (shared-skills.ts), and when they were looked at. */
  private skills = "";
  private skillsAt = 0;
  /** The next turn carries on from a copy of the conversation: the conversation itself is busy elsewhere (see `turn`). */
  private forkNext = false;
  /** A Work session, as the server said when the lane attached and with each turn: the tools start with everything they have. */
  private work = false;
  /** This tool turned its effort flag away as unknown (an older version): its turns run without one from then on. */
  private noEffort = false;
  /** Flags of its own this tool's version refused as unknown (see Adapter.optional): left off from then on. */
  private skipFlags = new Set<string>();
  /** The project's MCP servers, for a tool spoken to over ACP (see mcp-servers.ts): read as the lane opens and before each turn. */
  private acpMcp: AcpMcpServer[] = [];
  /** Friday's own MCP server for this lane's tool, through which it talks to the other agents in the session (friday-mcp.ts). */
  private friday: { spec: FridayMcp; close(): void } | null = null;
  /** Its calls the server hasn't answered yet, by id. */
  private meshWaits = new Map<string, (r: MeshAnswer) => void>();
  /** Turns already started again once after their tool hung (hung.ts): a second hang ends the turn. */
  private unstuck = new Set<string>();
  private repo: RepoInfo | null = null;
  /** `branch` is `followBranch`, found here or on origin: moved onto as origin has it, or not at all (onAttached). */
  private following = false;
  /** On the session's branch as it was pushed, which is what the person is told came along (local-api `start`). */
  followed = false;
  private lastDiff = "";
  /**
   * A repository kept outside a folder that hasn't got one.
   *
   * Without it a plain folder — a scratch directory, an export, a project
   * nobody initialised — showed no diffs at all: every change the agent made
   * was invisible to the one panel meant to show changes.
   */
  private shadow: Shadow | null = null;
  /** The snapshot, being taken while the session opens. Anything that changes the folder waits for it. */
  private shadowReady: Promise<void> = Promise.resolve();
  /** The copy's `.worktreeinclude` files being brought over (RunnerOptions.include): a turn waits for them, nothing else does. */
  private included: Promise<unknown> = Promise.resolve();
  /**
   * Where the folder stood when this session's agent came to it, uncommitted work included (see sessionBase). Changes are
   * measured from here, not from the last commit, so the person's own unfinished edits are never listed as the agent's.
   */
  private base: string | null = null;
  private basing: Promise<string | null> | null = null;
  /** The checkpoint the session took just before a turn (see `ensureBase`), and when. */
  private before: { sha: string; at: number } | null = null;
  /** Settles when the checkpoints being taken now are: Claude Code started ahead waits for them, and only for them (see start). */
  private checkpointing: Promise<unknown> = Promise.resolve();
  private checkpoint<T>(p: Promise<T>): Promise<T> {
    const all = Promise.all([this.checkpointing, p]).catch(() => {});
    this.checkpointing = all;
    return p;
  }
  /**
   * The starting point holds the same files as HEAD: the folder was clean when the agent came. Then the quick diff against
   * it says the same as the full one, and that is what is used; the full one (a snapshot of every file) only when there
   * was uncommitted work to leave out.
   */
  private baseIsHead = false;
  private async setBase(sha: string | null): Promise<void> {
    this.base = sha;
    this.baseIsHead = !!sha && (await sameTree(this.opts.cwd, sha, "HEAD").catch(() => false));
  }
  /** This session and folder, as the base's ref names them. */
  private get baseKey(): string {
    return `${this.opts.session.replace(/[^\w-]/g, "")}/${createHash("sha1").update(this.opts.cwd).digest("hex").slice(0, 12)}`;
  }
  private diffTimer: ReturnType<typeof setTimeout> | null = null;
  private bin = "";
  /** How to start `bin`: itself, or node plus the script it wraps. */
  private launch: Launch = { command: "", prefix: [] };
  /** Claude Code kept running between turns (see WarmClaude). Not for a --bin given by hand, which is run as it is given. */
  private warm: WarmClaude | null = null;
  /** A tool spoken to over ACP, kept running from one turn to the next (see WarmAcp). */
  private acp: WarmAcp | null = null;
  /** Cursor's, Amp's or `codex exec`'s process for the next turn, started as the last one ended (see Prespawn). */
  private readonly next = new Prespawn();
  /** Codex on this computer has no app-server (too old for one): its turns run `codex exec`, one process each, as they used to. */
  private legacyCodex = false;
  private onClosed!: (v: { code: number; reason: string }) => void;
  private readonly log: (line: string) => void;

  constructor(readonly opts: RunnerOptions) {
    this.log = opts.log ?? (() => {});
    this.closed = new Promise((r) => (this.onClosed = r));
    this.halted = new Promise((r) => (this.onHalted = r));
    // The id goes on the CLI's command line, and can come from a teammate's page: one that starts with a dash would be read
    // there as a flag. Left out here, it is neither resumed, read, nor named to the server.
    if (opts.resumeId && !CLI_ID.test(opts.resumeId)) {
      this.log(`not continuing “${opts.resumeId.slice(0, 40)}”: that isn't a conversation id`);
      this.opts = { ...opts, resumeId: undefined };
    }
    this.forkNext = !!this.opts.resumeId && !!opts.resumeFork;
  }

  get label(): string {
    return this.opts.tool ? ENGINE_NAMES[this.opts.tool] : "This folder";
  }

  /** Connects and resolves once the server has given this runner a lane. */
  async start(): Promise<void> {
    // The skills on this computer looked at now, beside connecting: Claude Code started ahead waits on them, not on a read after.
    void this.loadSkills();
    const o = this.opts;
    // Whether this machine has the conversation a hand-off continues, looked up by its file's name beside the checks below:
    // it decides what the server is told (see where it is awaited). A look that fails is "don't know", not "not here".
    const resumeFrom = o.resumeTool ?? o.tool;
    const here = o.resumeIfHere && o.resumeId && resumeFrom ? hasCliTranscript(resumeFrom, o.resumeId).catch(() => true) : null;
    // The conversation being continued is read while everything else starts up, rather than after: the hand-off used to wait
    // for it once the lane was already there.
    const shared = o.resumeId ? this.readResumed(o.resumeId) : null;
    // Lending the folder alone skips every CLI check: there is no binary to
    // find, nothing to be logged into, and no process to launch.
    // The CLI's checks and the folder's repository, side by side: each is a few processes, and one after the other they were a
    // second or more of every start. A copy made a moment ago says its repository itself (addWorktree).
    const tool = o.tool;
    const checks = async (tool: EngineTool): Promise<void> => {
      if (hasAccounts(tool)) this.account = await this.startAccount(tool, o.account);
      const acct = this.account && this.account.id !== DEFAULT_ACCOUNT ? this.account.id : undefined;
      // On a key its owner pays for by use, or on a person's own plan: the server keeps a personal plan to its owner's work
      // (api-key.ts, own-plan.ts). Read from the settings it starts with, never from a key or a token.
      this.apiKey = await usesApiKey(tool, { ...childEnv(), ...accountEnv(tool, this.account?.id) }).catch(() => false);
      const bin = o.bin ?? (await startChecks.findBin(tool));
      if (!bin) throw new RunnerError(`Couldn't find ${this.label} on this machine. Install it and log in, then try again.`);
      // Say so now rather than after the team's first instruction fails. An
      // explicitly given --bin is trusted as-is.
      // Signed in last time it was asked is believed at once, while the check runs again behind it: a sign-out since then
      // shows up as that turn's own sign-in error. Anything else waits for a real answer, so a CLI signed in a moment ago in
      // a terminal is never turned away on an old "no".
      // How to start it is resolved beside that, so an unlaunchable wrapper is reported here rather than as a failed turn
      // after someone sends an instruction. Not being signed in is said first, as it always was.
      const [signedIn, launch] = await Promise.all([
        o.bin ? true : startChecks.loginStatusQuick(tool, bin, 0, acct).then(async (q) => q === true || (await startChecks.loginStatusCached(tool, bin, acct)) !== false),
        startChecks.launcher(bin).then((l) => ({ l }), (e: Error) => ({ e })),
      ]);
      if (!signedIn && acct) throw new RunnerError(`${this.label}'s ${this.account!.label} account isn't signed in on this machine. Sign in to it from Friday's tool settings, then connect again.`);
      if (!signedIn) throw new RunnerError(`${this.label} isn't logged in on this machine. Run \`${[ADAPTERS[tool].bins[0], ...ADAPTERS[tool].login].join(" ")}\` once, then connect again.`);
      if ("e" in launch) throw new RunnerError(launch.e.message);
      this.bin = bin;
      this.launch = launch.l;
      if (tool === "claude" && !o.bin) this.warm = new WarmClaude();
      else if (ADAPTERS[tool].interactive) this.acp = new WarmAcp();
    };
    const repo = o.repo !== undefined ? Promise.resolve(o.repo) : startChecks.repoInfo(o.cwd);
    [, this.repo] = await Promise.all([tool ? checks(tool) : null, repo]);
    if (tool && !this.friday) await this.openFriday();
    // The session's branch, from another machine. Fetching only moves origin's refs, so it is safe before the server has
    // said this folder is ours; switching waits for that (onAttached). Fetched when the checkout is on it already, too,
    // which can be well behind what was pushed. A checkout with uncommitted changes is somebody's, and stays as it is: the
    // agent works there rather than the hand-off failing.
    if (o.followBranch && !o.branch && this.repo) {
      const on = this.repo.branch || "the commit checked out";
      if (this.repo.dirty) this.log(`${o.cwd} has uncommitted changes on ${on}, so ${this.label} works there as it is rather than on ${o.followBranch} as pushed`);
      else if (await fetchBranch(o.cwd, o.followBranch)) {
        o.branch = o.followBranch;
        this.following = true;
      } else this.log(`${o.followBranch} isn't on origin, so ${this.label} works on ${on} here: only pushed work comes along`);
    }
    // Refused here, before the server is told anything: refused after attaching, the session had already announced a branch
    // that was never made, and the agent went on working on the old one.
    if (o.branch && this.repo?.dirty && o.branch !== this.repo.branch) throw this.dirtyRefusal(o.branch);
    // The first turn's snapshot, begun now while the server admits the lane rather than after: it reads the folder into an
    // index of its own and changes no file. Not when the checkout is about to be moved onto another branch (onAttached):
    // that one is taken once it has.
    const editing = !!o.tool && !!this.repo && (o.mode ?? "full") !== "plan";
    const moving = this.following || (!!o.branch && o.branch !== this.repo?.branch);
    const early = editing && !moving ? startChecks.warmSnapshot(this.repo!.root) : null;
    // Codex used to be refused outside a git repository. A conversation carried over from another tool is often in a plain folder, a scratch
    // directory or a worktree, and the refusal was Codex's own check, not a limit of this one: it is switched off (see the adapter).
    // The branch is switched *after* the server accepts, not before. The
    // server is the only thing that knows whether somebody else is already
    // working in this folder, and a refused runner that has already moved the
    // checkout has done the damage it was refused to prevent.

    /**
     * A conversation is resumed only where it is kept.
     *
     * A hand-off continues the session's conversation with whoever presses it, and that can be a teammate, or the same
     * person on their other computer. The CLI there has never seen the id: `--resume` failed the first turn, and the
     * server, told this lane was continuing it, kept the session's copy of it from the agent on every turn after. Not
     * resumed, nothing claims to continue it, and the server hands the agent that copy as history instead.
     *
     * Only for a hand-off (`resumeIfHere`), and only when the conversation's file is not here by name: a conversation
     * picked from this machine's own list is this machine's, and its CLI finds it better than a scan of the newest files.
     */
    if (here && !(await here)) {
      this.log(`the conversation ${o.resumeId} isn't on this machine, so it isn't resumed here; the session's copy of it comes in as history`);
      delete o.resumeId;
      delete o.resumeTool;
      delete o.resumeTitle;
      delete o.resumeMessages;
    }

    // The effort levels its ACP tool said it has, last time it was asked (see knownEfforts), for the effort pill.
    const efforts = o.tool && ADAPTERS[o.tool].interactive && !ADAPTERS[o.tool].dialect ? await knownEfforts(o.tool) : [];
    const qs = new URLSearchParams({
      ...(efforts.length ? { efforts: efforts.join(",") } : {}),
      session: o.session,
      invite: o.invite,
      ...(o.actorToken ? { token: o.actorToken } : {}),
      ...(o.tool ? { tool: o.tool } : {}),
      mode: o.mode ?? "full",
      ...(o.handMode && o.handMode !== (o.mode ?? "full") ? { handMode: o.handMode } : {}),
      cwd: o.cwd,
      ...(o.copyOf ? { copyOf: o.copyOf } : {}),
      ...(o.share ? { share: "1" } : {}),
      // The folder and its repository as they really are on this disk, so the server can tell one checkout from another
      // whatever the spelling, and two subfolders of one repository as one place to write (see EngineHub.admit).
      real: real(o.cwd),
      root: real(this.repo?.root ?? o.cwd),
      os: process.platform,
      machine: process.env.FRIDAY_MACHINE_NAME || hostname().replace(/\.local$/i, ""),
      shell: shellName(),
      ...(o.model ? { model: o.model } : {}),
      ...(this.account ? { account: this.account.id, accountLabel: this.account.label } : {}),
      ...(this.apiKey ? { apiKey: "1" } : {}),
      // The branch this will be on once attached, which is the one to show: the switch itself waits until the server has
      // accepted the folder. Except the session's branch from another machine, which may not be had (trackBranch): the lane
      // shows the branch the folder is on, and moves when the switch has happened (onAttached).
      ...(this.following ? (this.repo?.branch ? { branch: this.repo.branch } : {}) : o.branch || this.repo?.branch ? { branch: o.branch || this.repo!.branch! } : {}),
      ...(o.lane ? { lane: o.lane } : {}),
      ...(o.newLane ? { newLane: o.newLane } : {}),
      ...(o.resumeId ? { resumeId: o.resumeId, resumeTitle: o.resumeTitle ?? "", resumeMessages: String(o.resumeMessages ?? 0), ...(o.resumeTool ? { resumeTool: o.resumeTool } : {}) } : {}),
      // A run's checkpoint is taken here, as its first turn is handed to the tool, rather than asked for first (turnCheckpoint).
      caps: "checkpoint,steer",
    });
    // Stopped while it was still finding its CLI or reading the folder: it never connects.
    if (this.stopped) throw new RunnerError("Runner stopped by its host", 1000);
    // A connection that hangs half-way through opening is given up on, so whatever reconnects gets to try again.
    const ws = new WebSocket(`${o.server.replace(/^http/, "ws")}/runner?${qs}`, { handshakeTimeout: 15_000 });
    this.ws = ws;

    let imported = false;
    let system: string | undefined;
    let effort: string | undefined;
    await new Promise<void>((resolve, reject) => {
      let attached = false;
      // What the server said as it closed this socket, for when the close itself arrives without it (see closeSaying).
      let said: { code: number; reason: string } | null = null;
      // Pinged from this side too, as the link is. A runner only ever answers, so after a laptop sleeps or the network
      // changes its socket stays open to nothing: the server has long marked the lane offline, and nothing here ever
      // notices, so nothing reconnects. A missed answer closes it, and the close is what brings it back.
      // Why it gave up, said in the log for the drop: a close it causes itself carries no reason of its own (1006).
      ws.on("open", () => keepAlive(ws, undefined, (why) => (said = { code: 1006, reason: why })));
      ws.on("message", (raw) => {
        let m: ServerMsg;
        try {
          m = JSON.parse(String(raw));
        } catch {
          return;
        }
        if ((m as { kind?: string }).kind === "closing") {
          const c = m as unknown as { code?: unknown; reason?: unknown };
          if (typeof c.code === "number") said = { code: c.code, reason: typeof c.reason === "string" ? c.reason : "" };
          return;
        }
        if (m.kind === "attached") {
          attached = true;
          this.lane = m.lane;
          this.laneName = m.laneName;
          imported = !!m.imported;
          system = m.system;
          effort = m.effort;
          this.work = workAsked(m);
          // Begun here, before anything else can run, so no turn starts ahead of it.
          if (o.include) this.included = o.include().catch(() => {});
          // A runner that couldn't set the folder up leaves the lane, rather than taking turns in a state nobody asked for.
          void this.onAttached().then(
            () => resolve(),
            (e: Error) => {
              ws.close(4000, e.message.slice(0, 120));
              reject(e);
            },
          );
        } else this.onMessage(m);
      });
      ws.on("close", (rawCode, rawReason) => {
        const { code, reason } = closingSaid(said, rawCode, String(rawReason));
        // Cut off mid-turn by a drop that reconnecting fixes (a server restarting, the network): the tool keeps working, for the
        // runner that reconnects to take on (keepTurn, adopt). Anything else stops it, as before.
        const turnId = this.cap?.id;
        if (attached && turnId && this.child && !this.stopped && !this.stopping && !FINAL.has(code)) this.keepTurn(turnId);
        else {
          this.killChild();
          // The snapshot was ours and only for this run; the folder it describes
          // keeps nothing of it either way.
          void dropShadow(this.shadow);
          this.shadow = null;
        }
        for (const wait of [...this.meshWaits.values()]) wait({ output: "Friday's connection dropped before it answered. If you asked another agent something, its answer reaches you as a message.", isError: true, tools: [] });
        const why = String(reason) || `connection closed (${code})`;
        this.onClosed({ code, reason: why });
        if (!attached) reject(new RunnerError(why, code));
      });
      ws.on("error", (err) => {
        // -1: the server couldn't be reached, which retrying can fix (unlike a missing CLI).
        if (!attached) reject(new RunnerError(`Couldn't reach ${o.server}: ${err.message}`, -1));
      });
    });
    this.log(`${this.label} ${o.tool ? "attached to" : "is open to"} “${this.laneName}” · ${o.cwd}${this.repo ? ` · ${this.repo.branch || "detached"}` : ""}`);
    // Back after a dropped connection: a turn cut off by it never got to report what it had changed, and this runner is a
    // new one that has reported nothing, so the Files tab missed that work. What is in the folder now says it.
    if (o.reattach) void this.reportDiff(true);
    // Continuing a conversation of my own: my CLI has it in memory, but nobody
    // else in the room does. Put it in the log so Friday Code and anyone
    // else's CLI can work on the same material. Read while everything else started (see above), and sent before this
    // returns: the first instruction is often sent the moment it does, and its turn is built from the log as it is then.
    // Not when the server says the log has it already (a hand-off of it, a runner reconnecting).
    // Not when the conversation turned out not to be on this machine (see resumeIfHere): it comes in as history instead.
    if (shared && o.resumeId && !imported) this.shareResumed(await shared);
    // Ready before the first instruction rather than after it: the snapshot index its checkpoint starts from, and Claude
    // Code itself, told what that turn will be told. Not when another tool's conversation was just shared, which changes that.
    const warming = early ?? (editing && this.repo ? startChecks.warmSnapshot(this.repo.root) : Promise.resolve());
    const warm = this.warm;
    const note = system;
    // Not when reconnecting: a lane that comes back after a dropped connection, a deploy or a wake would start another one
    // (a few hundred MB each, for every lane) whether or not anyone gives it a turn; its next turn starts its own.
    // Nor for a first turn on a copy: a Claude Code kept warm is in the conversation itself, and would be handed that turn.
    if (warm && warmAtStart(o, this.forkNext) && note !== undefined && !(o.resumeId && !imported && o.resumeTool && o.resumeTool !== o.tool)) {
      // Claude Code after the snapshot and any checkpoint being taken, not beside them: on Windows a CLI being started holds the
      // pipes of the gits running then, and the checkpoint before the first turn took three times as long. With no checkpoint
      // running it starts as soon as the snapshot is in, rather than a fixed 1.5s later in case a turn came.
      void Promise.all([warming, this.mcpServers(), this.loadSkills().then(() => this.systemFileFor(this.noted(note)))]).then(async ([, mcp, systemFile]) => {
        await this.checkpointing;
        warm.prepare(this.launch.command, [...this.launch.prefix, ...ADAPTERS.claude.args({ ...this.spec("", note, mcp, undefined, undefined, effort), ...(systemFile ? { systemFile } : {}) })], this.spawnOptions());
      }).catch(() => {
        // Not kept warm this time: the turn starts its own, and an unhandled rejection here would end the runner.
      });
    }
    this.shareLimits();
    // An ACP tool too, with the conversation the first turn carries on open in it, or a new one.
    const acp = this.acp;
    // Nor on a copy: Codex's warm server would open the shared thread itself, which the terminal still has open.
    if (acp && warmAtStart(o, this.forkNext) && o.tool && !ADAPTERS[o.tool].unavailable?.()) void Promise.all([warming, this.readAcpMcp(), this.loadSkills()]).then(() => acp.prepare(this.acpHow(this.spec("", "", [], undefined, undefined, effort))));
  }

  /** How this lane's tool is driven: its adapter, or the old way of running Codex when its app-server can't be started here. */
  private adapter(): Adapter {
    return this.legacyCodex ? codexExec : ADAPTERS[this.opts.tool!];
  }

  /** The app-server couldn't be started: from here on Codex runs as `codex exec`, a process a turn. */
  private useLegacyCodex(): void {
    if (this.legacyCodex) return;
    this.log("Codex here has no app-server, so its turns run `codex exec`, one process each");
    this.acp?.close();
    this.acp = null;
    this.legacyCodex = true;
  }

  /** How this lane's ACP tool is started for a turn like `spec`, kept from one turn to the next (see WarmAcp). */
  private acpHow(spec: TurnSpec): AcpHow {
    const adapter = ADAPTERS[this.opts.tool!];
    return {
      command: this.launch.command,
      args: [...this.launch.prefix, ...adapter.args(spec)],
      opts: this.spawnOptions(adapter.env?.(spec)),
      init: adapter.stdin(spec),
      resumeId: this.resumeId,
      ...(adapter.dialect ? { dialect: adapter.dialect } : {}),
      ...(spec.acpMcp?.length ? { mcpServers: spec.acpMcp } : {}),
    };
  }

  /**
   * Friday's MCP server for this lane's tool (friday-mcp.ts): opened once for the runner, its calls passed to the server as this
   * lane. Without it the tool works as before, only without the other agents.
   */
  private async openFriday(): Promise<void> {
    try {
      // preview_screenshot is offered only when the desktop app is here to take it, and its picture is taken here: the server
      // checks the ask and says what to capture.
      const call = async (name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<MeshAnswer> => {
        const r = await this.meshAsk(name, args, signal);
        return r.capture && canScreenshot() ? screenshot(r.capture, signal) : r;
      };
      this.friday = await openFridayMcp({ tools: () => this.meshAsk("__list", canScreenshot() ? { screenshot: true } : {}), call }, await nodeForScripts());
      if (this.opts.tool === "cursor") await ensureCursorEntry(this.friday.spec).catch(() => {});
    } catch (e) {
      this.log(`The tools for talking to the other agents couldn't be set up: ${(e as Error).message}`);
    }
  }

  /** One `friday` MCP call, put to the server on this runner's connection. Never rejects: what went wrong is the tool's answer. */
  private meshAsk(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<MeshAnswer> {
    return new Promise((resolve) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return resolve({ output: "Friday isn't connected right now. Try again in a moment.", isError: true, tools: [] });
      const id = randomUUID();
      const done = (r: MeshAnswer) => {
        this.meshWaits.delete(id);
        signal?.removeEventListener("abort", onAbort);
        clearTimeout(timer);
        resolve(r);
      };
      const onAbort = () => {
        this.send({ kind: "mesh.cancel", id });
        done({ output: "Stopped.", isError: true });
      };
      // A server older than these tools never answers the list: the tool then simply has none.
      const timer = setTimeout(() => done({ output: "Friday didn't answer.", isError: true, tools: [] }), tool === "__list" ? 10_000 : 20 * 60_000);
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort);
      this.meshWaits.set(id, done);
      this.send({ kind: "mesh.call", id, tool, args });
    });
  }

  /** The project's MCP servers for this lane's ACP tool, read afresh: one added to .mcp.json since counts from the next turn. */
  private async readAcpMcp(): Promise<void> {
    const tool = this.opts.tool;
    if (!tool || !ADAPTERS[tool].interactive || ADAPTERS[tool].dialect) return;
    this.acpMcp = await projectMcpServers(this.opts.cwd).catch(() => []);
  }

  /** Claude Code's MCP servers for this folder, which Auto lets it use. Read each time: one added since then counts. */
  private async mcpServers(): Promise<string[]> {
    return this.opts.tool === "claude" && this.mode === "full" ? claudeMcpServers(this.opts.cwd) : [];
  }

  /**
   * The `/` commands this lane's tool answers to, for the composer's menu: Claude Code's as it gave them, Codex's and Cursor's
   * prompt and command files and skills (see tool-commands.ts).
   */
  /** The last list read from the tool's folders, and when (see toolCommands). */
  private scanned: { at: number; list: ToolCommand[] } | null = null;

  /**
   * Its context, by category, as Claude Code's own `/context` says it (context-report.ts): a command it answers without the
   * model, so it costs nothing. Asked of a copy of the conversation (--fork-session), so the conversation itself is never
   * touched, and that copy is deleted once read. The same answer for twenty seconds: a card opened twice asks once.
   */
  private contextAsked: { at: number; p: Promise<ToolContext | null> } | null = null;
  /** Its last report, and when, answered at once while a fresh one is asked behind it (see toolContext). */
  private contextKept: ToolContext | null = null;
  /** When somebody last asked for it: a turn ending within CONTEXT_WATCHED_MS asks again then, so the card is current. */
  private contextWanted = 0;

  /**
   * Its context, at once: the last report while a new one is asked behind it, and the new one only when there is none yet.
   * Each ask starts Claude Code with the conversation's MCP servers (three seconds in an empty folder, past the server's twenty
   * for a lane with many), so the card sat empty or came back with nothing (Arun, 2026-10-24: "stabler and fast same with
   * context"). The report says when it was read (`at`).
   */
  private toolContext(): Promise<ToolContext | null> {
    if (this.opts.tool !== "claude" || !this.launch) return Promise.resolve(null);
    this.contextWanted = Date.now();
    const fresh = this.askContext();
    return this.contextKept ? Promise.resolve(this.contextKept) : fresh;
  }

  /** After a turn, while somebody has looked at the context lately: read again, so the card opens on this turn's. */
  private contextAfterTurn(): void {
    if (this.opts.tool === "claude" && this.launch && Date.now() - this.contextWanted < CONTEXT_WATCHED_MS) void this.askContext().catch(() => {});
  }

  private askContext(): Promise<ToolContext | null> {
    if (this.contextAsked && Date.now() - this.contextAsked.at < 20_000) return this.contextAsked.p;
    const p = (async () => {
      const mcp = await this.mcpServers().catch(() => [] as string[]);
      const { ask: _, ...spec } = this.spec("/context", this.noted(this.sentSystem ?? ""), mcp);
      const args = ADAPTERS.claude.args({ ...spec, ...(this.resumeId ? { fork: true } : {}) });
      const proc = spawnCli(this.launch!.command, [...this.launch!.prefix, ...args], this.spawnOptions());
      let out = "";
      proc.stdout?.on("data", (d: Buffer) => (out += d.toString()));
      proc.stdin?.end("/context");
      const done = new Promise<void>((resolve) => proc.on("exit", () => resolve()));
      const timer = setTimeout(() => proc.kill("SIGKILL"), 60_000);
      await done;
      clearTimeout(timer);
      const result = out
        .split("\n")
        .map((l) => { try { return JSON.parse(l) as { type?: string; result?: string; session_id?: string }; } catch { return null; } })
        .findLast((m) => m?.type === "result");
      // The copy it made of the conversation, gone: Claude Code keeps one file per conversation, and these would pile up.
      const copy = result?.session_id;
      if (this.resumeId && copy && copy !== this.resumeId && CLI_ID.test(copy)) void dropClaudeConversation(copy);
      const report = result?.result ? parseContextReport(result.result) : null;
      if (report) this.contextKept = { ...report, at: Date.now() };
      return report ? this.contextKept : null;
    })();
    this.contextAsked = { at: Date.now(), p };
    p.catch(() => (this.contextAsked = null));
    return p;
  }

  private async toolCommands(): Promise<ToolCommand[]> {
    const tool = this.opts.tool;
    if (tool === "claude") {
      const live = (await this.warm?.commands()) ?? [];
      // Internal ones (a leading "__") and those only Claude Code's own terminal can run are left out.
      const list = live.filter((c) => !c.name.startsWith("__") && !TERMINAL_ONLY.has(c.name)).map((c) => ({ name: c.name, description: c.description, ...(c.argumentHint ? { hint: c.argumentHint } : {}), insert: `/${c.name} ` }));
      // Claude Code says its commands only once it has started, at the first message: until then, the list it gave last time
      // on this computer, so the menu isn't empty at the moment people first reach for it.
      if (!list.length) return knownCommands("claude");
      rememberCommands("claude", list);
      return list;
    }
    // Read from the tool's prompt and skill folders: kept a few seconds, since a menu opening asks again and again and each
    // ask read every file in those folders afresh.
    if (this.scanned && Date.now() - this.scanned.at < SCAN_MS) return this.scanned.list;
    let list: ToolCommand[] = [];
    // Codex's own /review and /compact first, over its app-server (not `codex exec`, which has neither).
    if (tool === "codex" || tool === "cursor")
      list = [...(tool === "codex" && !this.legacyCodex ? CODEX_BUILTINS : []), ...(await toolCommandsIn(tool, this.opts.cwd)).map(({ name, description, hint, insert }) => ({ name, description, ...(hint ? { hint } : {}), insert }))];
    // Over ACP: what the tool listed last, and the skills in its own folder, which it takes as /name.
    else if (tool && ADAPTERS[tool].interactive) {
      const known = await knownCommands(tool);
      const have = new Set(known.map((c) => c.name));
      list = [...known, ...(await skillCommands(tool)).filter((c) => !have.has(c.name)).map(({ name, description, insert }) => ({ name, description, insert }))];
    }
    if (list.length) this.scanned = { at: Date.now(), list };
    return list;
  }

  /**
   * What a lone `/command` becomes for this tool, or null when the tool has no such command and the message goes as the words
   * it is. Claude Code runs its own, so it gets the text as typed; Codex's and Cursor's are expanded as their terminals would.
   * A tool that hasn't listed its commands yet (not started, or its first turn here) is trusted with one as typed: it reads
   * one it doesn't have as words, which is what it would have got anyway.
   */
  private async ownCommand(text: string): Promise<string | null> {
    const tool = this.opts.tool;
    const name = /^\/([\w:.-]+)/.exec(text)?.[1];
    if (!name) return null;
    if (tool === "claude") {
      const list = await this.warm?.commands();
      return !TERMINAL_ONLY.has(name) && (!list || list.some((c) => c.name === name)) ? text : null;
    }
    if (tool === "codex" && !this.legacyCodex && CODEX_BUILTINS.some((c) => c.name === name)) return text;
    if (tool === "codex" || tool === "cursor") return expandCommand(text, await toolCommandsIn(tool, this.opts.cwd));
    // Over ACP a command is sent as it was typed, and the tool runs it.
    if (tool && ADAPTERS[tool].interactive) {
      const known = await knownCommands(tool);
      return !known.length || known.some((c) => c.name === name) || (await skillCommands(tool)).some((c) => c.name === name) ? text : null;
    }
    return null;
  }

  /** The turn now running and the most it may do, when the server said (a teammate's turn on a lane switched automatically). */
  private cap: { id: string; mode?: EngineMode } | null = null;

  /** What this machine may do right now: its own mode, held to the running turn's when that is lower. */
  private get mode(): EngineMode {
    return capMode(this.opts.mode ?? "full", this.cap?.mode);
  }

  /** A turn as the adapter takes it. */
  /**
   * `model`: the one the session picked for this turn, on an Auto lane. Auto itself is never passed to a tool: with no pick (a server
   * from before routing) the tool runs its own default.
   */
  private spec(prompt: string, system: string, mcp: string[], grant?: TurnSpec["grant"], model?: string, effort?: string): TurnSpec {
    const mode = this.mode;
    const runs = model || (this.opts.model === "auto" ? "" : this.opts.model);
    // A kept Claude Code, or a tool spoken to over ACP, can be answered mid-turn, so Manual asks then, not once the turn is over (see
    // TurnSpec.ask). An ACP tool asks in Plan too, about anything that isn't changing a file (see `acp`).
    const live = !!this.opts.tool && !!ADAPTERS[this.opts.tool].interactive;
    // In Auto too: what the tool would ask a person about is answered yes by the runner (see `forward`, "ask"), rather than refused
    // with nobody to ask. For Claude Code that is an MCP server from a plugin, a file outside the folder, a skill: everything its
    // own --allowedTools couldn't name (Arun, 2026-10-18: the tools as capable in Friday as on their own).
    const ask = !!this.warm || live;
    // Only a level every tool that takes one knows: it goes on the tool's command line.
    const thinks = !this.noEffort && isEngineEffort(effort) ? effort : undefined;
    // A tool spoken to over ACP gets Friday's MCP server with the project's, passed with the conversation.
    const acpTool = !!this.opts.tool && !!ADAPTERS[this.opts.tool].interactive && !ADAPTERS[this.opts.tool].dialect;
    const dirs = this.opts.dirs ?? [];
    // A tool with no flag for the folders beside its own is told them in its standing note instead (see withDirs).
    const own = !!this.opts.tool && !!ADAPTERS[this.opts.tool].dirs;
    return {
      prompt,
      resumeId: this.resumeId,
      mode,
      system: own ? this.noted(system) : withDirs(this.noted(system), dirs),
      ...(dirs.length ? { dirs } : {}),
      ...(grant ? { grant } : {}),
      ...(runs ? { model: runs } : {}),
      ...(thinks ? { effort: thinks } : {}),
      ...(mcp.length ? { mcp } : {}),
      ...(ask ? { ask: true } : {}),
      ...(this.acpMcp.length || (this.friday && acpTool) ? { acpMcp: [...this.acpMcp, ...(this.friday && acpTool ? [acpEntry(this.friday.spec)] : [])] } : {}),
      ...(this.friday ? { friday: this.friday.spec } : {}),
      ...(this.skipFlags.size ? { skip: [...this.skipFlags] } : {}),
      ...(this.work ? { work: true } : {}),
    };
  }

  /**
   * Long standing instructions reach Claude Code through a file of their own, only when they would not fit on the command line
   * (see tooLongForArgv), since a Claude Code older than the flag takes them inline only. Named for this runner and the text, not
   * afresh each turn: a kept Claude Code (see WarmClaude) is used again only while it would be started the same way, and a new
   * name every turn started a new process every turn. Removed after each turn and when the runner stops.
   */
  /**
   * The skills already on this computer that this tool doesn't load by itself (Arun, 2026-10-21: "ensure the coding tools are able
   * to use their skills and stuff that is already downloaded too"): looked at again at most once a minute, so one downloaded
   * mid-session reaches the next turn without a read of every skill folder on each one.
   */
  private loadSkills(): Promise<void> {
    const tool = this.opts.tool;
    // A look under way is waited for, not skipped: a turn right after the start would otherwise go without the note.
    if (!tool || Date.now() - this.skillsAt < 60_000) return this.skillsLook;
    this.skillsAt = Date.now();
    this.skillsLook = skillsNote(tool, this.opts.cwd).then(
      (n) => void (this.skills = n),
      () => {},
    );
    return this.skillsLook;
  }
  private skillsLook: Promise<void> = Promise.resolve();
  /** A standing note with the skills note after it; none to add to, none added. */
  private noted(system: string): string {
    return system && this.skills ? `${system}\n\n${this.skills}` : system;
  }

  private async systemFileFor(system: string): Promise<string | undefined> {
    if (this.opts.tool !== "claude" || !tooLongForArgv(system)) return undefined;
    const file = path.join(tmpdir(), `friday-system-${this.fileTag}-${createHash("sha1").update(system).digest("hex").slice(0, 12)}.txt`);
    await writeFile(file, system, { mode: 0o600 });
    this.systemFiles.add(file);
    return file;
  }
  private readonly fileTag = randomUUID().slice(0, 8);
  private readonly systemFiles = new Set<string>();

  private spawnOptions(extra?: Record<string, string>) {
    // The folder's own variables (Environment, environment.ts) under the tool's own launch settings and what this turn adds.
    // FRIDAY_MESH_URL too, for an MCP server the tool starts from its own config with what it inherits (Cursor's; see friday-mcp.ts).
    const mesh = this.friday ? { FRIDAY_MESH_URL: this.friday.spec.env.FRIDAY_MESH_URL! } : {};
    // The account it runs as goes over everything else: a CLAUDE_CONFIG_DIR in the folder's variables would sign it in as another.
    return { cwd: this.opts.cwd, env: { ...childEnv(), ...folderVars(this.opts.cwd), ...this.launch.env, ...mesh, ...extra, ...accountEnv(this.opts.tool, this.account?.id) } };
  }

  private dirtyRefusal(branch: string): RunnerError {
    return new RunnerError(
      `${this.opts.cwd} has uncommitted changes on ${this.repo?.branch || "its current branch"}, so it isn't mine to move onto ${branch}. ` +
        `Commit or stash them, or start this session on the branch it is already on.`,
    );
  }

  /**
   * Everything that touches the folder, once the lane is ours.
   *
   * Switching branches is the destructive part of starting up — it moves
   * files under whoever is looking at them — so it waits for the server to
   * say this folder is not already somebody else's.
   */
  private async onAttached(): Promise<void> {
    const o = this.opts;
    if (this.following && this.repo) {
      // The session's branch as origin has it, or the checkout as it is (see trackBranch). Not being able to move is no
      // reason to leave: the agent works on what is here, and the person is told it isn't what was pushed.
      const from = this.repo.branch;
      await trackBranch(o.cwd, o.branch!).then(
        () => (this.followed = true),
        (e: Error) => this.log(`couldn't move ${o.cwd} onto ${o.branch} (${e.message.split("\n")[0]}), so ${this.label} works on ${from || "the commit checked out"} here`),
      );
      this.repo = await repoInfo(o.cwd);
      if (this.repo?.branch && this.repo.branch !== from) {
        this.log(`switched ${o.cwd} from ${from || "a detached head"} to ${this.repo.branch}`);
        // Only now: the session was told the branch the folder was on, and hears of this one once it is true.
        this.send({ kind: "switched", branch: this.repo.branch, from: from || "" });
      }
    } else if (o.branch && this.repo && o.branch !== this.repo.branch) {
      /**
       * Don't move a checkout somebody is standing in.
       *
       * Git refuses a switch that would overwrite local changes, which sounds
       * like enough and isn't: a *clean* switch succeeds, and the person whose
       * folder it is carries on committing to a branch they never chose. It
       * happened to this project's own repo — a session branched it under the
       * person working in it, and the next hour of commits went somewhere
       * nobody was looking.
       *
       * Uncommitted work is the one signal available from here that the
       * folder is in use, so it is the one that stops this.
       */
      if (this.repo.dirty) throw this.dirtyRefusal(o.branch);
      await switchBranch(o.cwd, o.branch, o.branchFrom).catch((e: Error) => {
        throw new RunnerError(`Couldn't switch to branch ${o.branch}: ${e.message}`);
      });
      const from = this.repo.branch;
      this.repo = await repoInfo(o.cwd);
      // Said where the room can see it: the checkout on somebody's machine
      // moved, and that is a fact about their machine, not a detail of ours.
      this.log(`switched ${o.cwd} from ${from || "a detached head"} to ${this.repo?.branch ?? o.branch}`);
    }
    // A folder that is not a repository gets one of its own, in the temp
    // directory, so its changes can be shown like anybody else's.
    // Taken behind the session opening, not in front of it: a big folder used
    // to hold the whole start-up for as long as git took to read it. Nothing
    // changes the folder until it is done (see `turn` and the repo bridge).
    if (!this.repo) {
      this.shadowReady = shadowSnapshot(this.opts.cwd, (why) => this.log(why))
        .then((s) => {
          this.shadow = s;
          if (s) this.log(`${this.opts.cwd} isn't a git repository, so changes are tracked against a snapshot taken just now`);
        })
        .catch(() => {});
    }
    await this.loadResume();
  }

  /** The conversation being continued, from its tool's own files. Never fails: the CLI still resumes with its own memory, and only the room would miss out. */
  private readResumed(id: string): Promise<Awaited<ReturnType<typeof readCliTranscript>> | null> {
    // Whose conversation it was, which is the tool whose files it is read from, not necessarily the one that will carry on.
    const tool = this.opts.resumeTool ?? this.opts.tool;
    if (!tool) return Promise.resolve(null);
    return readCliTranscript({ tool, id }).catch((e: Error) => {
      this.log(`couldn't read the earlier conversation: ${e.message}`);
      return null;
    });
  }

  /** Send the imported conversation to the session, once, after attaching. */
  private shareResumed(t: Awaited<ReturnType<typeof readCliTranscript>> | null): void {
    // Answered even with nothing, which the server ignores, so a server that waits for this before a lane's first turn never
    // waits out its time.
    if (!t || !t.found || !t.turns.length) {
      this.send({ kind: "imported", sourceId: this.opts.resumeId, turns: [] });
      // Said, rather than skipped in silence: nothing reaching the room is otherwise indistinguishable from nothing to share.
      if (t) this.log(`found nothing to share with the session from the earlier conversation ${this.opts.resumeId}`);
      return;
    }
    this.send({ kind: "imported", sourceId: this.opts.resumeId, title: t.title, turns: t.turns, total: t.total, ...(t.partial ? { partial: true } : {}), cwd: t.cwd, ...(t.branch ? { branch: t.branch } : {}) });
    this.log(`shared ${t.partial ? `the last ${t.turns.length}` : `${t.turns.length} of ${t.total}`} messages from “${t.title.slice(0, 60)}” with the session`);
  }

  stop(): void {
    this.stopped = true;
    this.friday?.close();
    for (const f of this.systemFiles) void unlink(f).catch(() => {});
    this.onHalted();
    this.killChild();
    this.ws?.close(1000, "Runner stopped by its host");
  }

  private send(m: unknown): void {
    if (this.handOn) return this.handOn(m);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
    else if (this.kept && this.kept.outbox.length < 20_000) this.kept.outbox.push(m);
  }

  /** Cut off mid-turn: the turn goes on, what it says is kept, and it is stopped after all if nobody takes it on in time. */
  private keepTurn(id: string): void {
    this.log(`${this.label}'s connection to Friday dropped mid-turn; the turn keeps going for when it is back`);
    this.kept = { id, outbox: [], timer: setTimeout(() => this.dropKept(), KEEP_TURN_MS) };
    this.kept.timer.unref?.();
  }

  holdsKept(): boolean {
    return !!this.kept;
  }

  /** Nobody took the kept turn on (or the lane is gone): stopped as a dropped connection always stopped it. */
  dropKept(): void {
    if (!this.kept) return;
    clearTimeout(this.kept.timer);
    this.kept = null;
    this.killChild();
    void dropShadow(this.shadow);
    this.shadow = null;
  }

  /** The kept turn, for the runner after this one to take on; null when there is none, or it ended and said so already. */
  private takeKept(): { id: string; outbox: unknown[] } | null {
    if (!this.kept) return null;
    clearTimeout(this.kept.timer);
    const k = this.kept;
    this.kept = null;
    return { id: k.id, outbox: k.outbox };
  }

  /**
   * Take on the turn the runner before this one kept going through a dropped connection, as the server's turn `id` handed back
   * to carry it on: what it said meanwhile goes out now, in order, then everything it says as it happens, and its end ends this
   * turn. A stop, an answer to what it asked, a friday tool's answer or a message mid-turn reach it through this runner.
   */
  private adopt(prev: Runner, kept: { id: string; outbox: unknown[] }, id: string): void {
    this.log(`${this.label} carries on the turn it was on when the connection dropped`);
    this.adopted = prev;
    this.cap = { id };
    busy(1);
    let over = false;
    prev.handOn = (msg) => {
      const x = msg as { kind?: string; id?: string };
      this.send(x.id === kept.id ? { ...x, id } : x);
      if (x.kind !== "turn.end" || x.id !== kept.id || over) return;
      over = true;
      busy(-1);
      if (this.cap?.id === id) this.cap = null;
      // What it reports after its end (the diff) still comes through for a while; then it is let go of for good.
      setTimeout(() => {
        if (this.adopted === prev) this.adopted = null;
        prev.handOn = null;
        prev.stop();
      }, 30_000).unref?.();
    };
    for (const msg of kept.outbox) prev.handOn(msg);
  }

  private onMessage(m: ServerMsg): void {
    // The `/` commands of this lane's tool, for the composer: this runner's to answer, not the folder's.
    if (m.kind === "repo" && m.op === "context") {
      void this.toolContext().then(
        (context) => this.send({ kind: "repo.result", id: m.id, output: JSON.stringify({ context }) }),
        () => this.send({ kind: "repo.result", id: m.id, output: JSON.stringify({ context: null }) }),
      );
      return;
    }
    if (m.kind === "repo" && m.op === "commands") {
      void this.toolCommands().then(
        (commands) => this.send({ kind: "repo.result", id: m.id, output: JSON.stringify({ commands }) }),
        () => this.send({ kind: "repo.result", id: m.id, output: JSON.stringify({ commands: [] }) }),
      );
      return;
    }
    // Once stopped, the folder is left alone: whatever is still asked of it is the session tidying up after a runner it lost.
    if (m.kind === "repo" && this.stopped) return this.send({ kind: "repo.result", id: m.id, output: "This machine has stopped working in this folder." });
    if (m.kind === "repo" && m.op === "apply") {
      void this.shadowReady
        .then(() => this.applyToOrigin())
        .then((output) => this.send({ kind: "repo.result", id: m.id, output }))
        .catch((e: Error) => this.send({ kind: "repo.result", id: m.id, output: JSON.stringify({ error: e.message }) }));
      return;
    }
    if (m.kind === "repo") {
      // Inside this folder only, and never beyond the mode this machine's host
      // chose. Answered even mid-turn: a read touches nothing the CLI is doing,
      // and a write is the same class of change the CLI is already making.
      // A diff or a checkpoint changes no file either: neither waits for the starting point, so another lane reading this
      // folder isn't held behind it.
      const reading = READ_ONLY.has(m.op) || m.op === "diff" || m.op === "checkpoint";
      // One of the folders the agent also works in (--add-dir), by exact path; anything else is this folder.
      const root = typeof m.dir === "string" && (this.opts.dirs ?? []).includes(m.dir) ? m.dir : this.opts.cwd;
      const read = (reading ? Promise.resolve() : this.shadowReady.then(() => this.ensureBase())).then(() => readRepo(root, { ...m, mode: this.mode }));
      void (m.op === "checkpoint" ? this.checkpoint(read) : read)
        .then((output) => {
          this.send({ kind: "repo.result", id: m.id, output });
          if (m.op === "checkpoint" && m.query === "run" && /^[0-9a-f]{40}$/.test(output)) this.before = { sha: output, at: Date.now() };
          // A CLI reports its diff when its turn ends. Nothing ends a turn when
          // the folder was lent without one, so a change made through this
          // bridge reports itself — otherwise the files panel stays empty while
          // the agent is visibly editing.
          if (m.op === "commit" && output.includes('"sha"')) {
            // Committed work isn't a change any more: the Files tab measures
            // from the new commit, so it shows what is still left to ship.
            void repoInfo(this.opts.cwd).then(async (r) => {
              if (r) this.repo = r;
              // The starting point takes the committed files as committed; the rest is measured as it was.
              if (r && this.base) {
                const next = await baseAfterCommit(this.opts.cwd, this.base, `${r.head}^`, r.head).catch(() => r.head);
                await this.setBase(next);
                await setSessionBase(this.opts.cwd, this.baseKey, next).catch(() => {});
              }
              this.scheduleDiff();
            });
          } else if (m.op === "write" || m.op === "edit" || m.op === "shell" || m.op === "restore") this.scheduleDiff();
        })
        .catch((e: Error) => this.send({ kind: "repo.result", id: m.id, output: `${m.op === "restore" ? "Couldn't undo that" : "Couldn't read that"}: ${e.message}` }));
      return;
    }
    if (m.kind === "turn") {
      // Handed back after a dropped connection, with the runner before this one still on it: taken on, not started again.
      const kept = m.again ? this.prev?.takeKept() : null;
      if (kept && this.prev) return this.adopt(this.prev, kept, m.id);
      // Any other turn: one kept going from before the drop must not run beside it, in the same folder and conversation.
      this.prev?.dropKept();
      busy(1);
      // For this turn and what is asked of the folder while it runs: no further than the turn says (see `mode`).
      this.cap = { id: m.id, ...(m.mode ? { mode: m.mode } : {}) };
      void this.turn(m)
        .catch((e) => this.send({ kind: "turn.end", id: m.id, outcome: "error", error: (e as Error).message }))
        .finally(() => {
          if (this.cap?.id === m.id) this.cap = null;
          busy(-1);
        });
    }
    else if (m.kind === "stop") {
      this.log(`stopping: ${m.reason}`);
      this.stopReason = m.reason;
      this.adopted?.onMessage(m);
      this.prev?.dropKept();
      this.interrupt();
    } else if (m.kind === "approval") {
      const asked = this.live.get(m.id);
      if (!asked) return void this.adopted?.onMessage(m);
      this.live.delete(m.id);
      if (asked.reply) asked.reply(m.approve);
      else this.warm?.answer(asked.requestId, m.approve, asked.input, "The person driving said no to that. Don't try to get round it: do it another way, or ask them what they would rather.");
      this.log(`${m.approve ? "allowed" : "refused"} what it asked (${m.id})`);
      // The next one it asked meanwhile, now that this one is answered.
      const next = this.waitingAsks.shift();
      if (next) this.putAsk(next);
    } else if (m.kind === "released") this.log("The lane was handed back to Friday Code.");
    else if (m.kind === "mesh.result") (this.meshWaits.get(m.id) ?? this.adopted?.meshWaits.get(m.id))?.(m);
    else if (m.kind === "steer") void (this.adopted ?? this).steerNow(m.id, m.text);
  }

  // ── one turn ─────────────────────────────────────────────────────

  /** `retry`: the files the first attempt downloaded, when this is the same instruction going again on a copy (see below). */
  private async turn(m: Extract<ServerMsg, { kind: "turn" }>, retry?: string[]): Promise<void> {
    // From here on a stop is this turn's, even one that comes while it is still getting ready (see below). Not when it is the
    // same instruction going again on a copy: a Stop that came in between was meant for it, and is kept rather than run over.
    if (!retry) this.stopping = false;
    this.work = workAsked(m);
    await this.shadowReady;
    await this.included;
    // A lent folder has no CLI to hand a turn to. The server doesn't send one —
    // Friday Code keeps the lane — so this is only reachable if that ever
    // stops being true, and saying so beats spawning `undefined`.
    if (!this.opts.tool) {
      this.send({ kind: "turn.end", id: m.id, outcome: "error", error: "This machine lent its folder without a coding agent, so it has nothing to run the turn with." });
      return;
    }
    if (this.acp?.unsupported && this.opts.tool === "codex") this.useLegacyCodex();
    const adapter = this.adapter();
    // A tool that can't be held to this machine's mode (Amp asks nobody) doesn't run in it, rather than act unasked.
    const mode = this.mode;
    const cannot = adapter.unavailable?.();
    if (cannot) {
      this.send({ kind: "turn.end", id: m.id, outcome: "error", error: cannot });
      return;
    }
    if (adapter.modes && !adapter.modes.includes(mode)) {
      this.send({ kind: "turn.end", id: m.id, outcome: "error", error: `${this.label} can't ask before it acts, so it only runs in Auto. Switch this lane to Auto to use it.` });
      return;
    }
    // The run's checkpoint, taken while the turn gets ready (its command, its files, its MCP servers, its note's file) and in
    // hand before the tool hears anything. The folder's starting point follows it: the first one is that checkpoint (ensureBase).
    const based = (m.checkpoint && !retry ? this.turnCheckpoint(m.id) : Promise.resolve()).then(() => this.ensureBase());
    await this.loadSkills();
    const systemFiling = this.systemFileFor(this.noted(m.system));
    systemFiling.catch(() => {}); // awaited below, where it fails the turn; a turn stopped before then leaves it unread
    // One of the tool's own `/` commands, typed alone: sent as the tool takes it, and nothing put in front of it.
    const own = m.command ? await this.ownCommand(m.command).catch(() => null) : null;
    // As typed is the tool's own to run (Claude Code, a tool over ACP); one expanded from a file is words, and gets what any prompt gets.
    const asTyped = own !== null && own === m.command;
    // A tool whose standing note leads the prompt (ACP) is not sent it ahead of a command, which then wouldn't be one; the turn
    // after carries it.
    const bare = asTyped && !!adapter.interactive;
    let prompt = own ?? m.prompt;
    const files = retry ?? (await this.download(m.attachments ?? []));
    const [mcp] = await Promise.all([this.mcpServers(), this.readAcpMcp()]);
    if (files.length && !asTyped) prompt += `\n\nFiles attached to the session, saved on this machine:\n${files.map((f) => `- ${f}`).join("\n")}`;
    // Pictures, said to be looked at: a tool handed them as images sees them already, and one that isn't (Cursor, Amp, an ACP
    // tool that takes none) opens them itself, as it would a screenshot named to it at its own prompt.
    if (files.some((f) => imageType(f)) && !asTyped) prompt += `\nThe pictures among them (screenshots or images) are part of the request: look at each one, opening it with your file-reading tool if it isn't already shown to you.`;
    // Said with why it was stopped, and left to the new instruction: a cancel meant it, and isn't a reminder to do it anyway.
    // Kept until the turn has really gone: a turn tried again (the old way, or on a copy) rebuilds its prompt and would drop it.
    const carried = this.unrun;
    if (this.unrun && !asTyped) {
      prompt = `[Friday] Before you started on the instruction below, ${this.stopReason || "it was stopped"}, so none of it was done. Only do it if the new instruction still wants it:\n${this.unrun}\n\n[Friday] Now:\n${prompt}`;
      this.unrun = null;
    }
    await based;
    // Stopped while the checkpoint and the folder's starting point were being taken: nothing is started that nobody will stop.
    // Nor a run's first turn on a link that went meanwhile: the session may never have heard its checkpoint and asks for it
    // again when this machine is back, and a tool already editing then would put its edits inside that one.
    if (this.stopped || (m.checkpoint && this.ws?.readyState !== WebSocket.OPEN)) return;
    /**
     * Stopped before the CLI started: a pause, a cancel or an interrupting instruction that landed while attachments
     * were downloading. It used to be dropped, and the CLI then ran, and edited files for, the whole turn somebody had
     * just stopped. The instructions in it were handed over all the same, so they ride along with the next turn, which
     * is what the CLI's own memory would hold had it been stopped part-way through.
     */
    if (this.stopping) {
      this.unrun = prompt;
      this.send({ kind: "turn.end", id: m.id, outcome: "stopped" });
      this.log(`turn ${m.id} stopped before it began`);
      return;
    }

    // Manual mode: a yes lets this turn do what was asked about, and a no is only words for the tool to read. What was
    // asked comes back with the answer, from the log, so a runner that reconnected in between still knows what the yes
    // was to. A server from before that sends only the id and the answer, so the question is still remembered here as
    // well, and used when the answer doesn't carry it: otherwise every yes came back as a new card.
    let grant: { scope: "commands" | "turn"; items: string[] } | undefined;
    const a = m.approval;
    const mine = this.asked;
    this.asked = null;
    const what = a?.scope && a.items?.length ? { scope: a.scope, items: a.items } : a && mine?.id === a.id ? mine : null;
    if (a?.approve && what && this.mode === "edits" && !asTyped) {
      grant = { scope: what.scope === "commands" ? "commands" : "turn", items: what.items.slice(0, 6).map(String) };
      prompt = `[Friday] You have been given permission for what you were blocked on (${grant.items.join("; ")}). Go ahead with it now.

${prompt}`;
    }
    const fork = this.forkNext;
    this.forkNext = false;
    const systemFile = await systemFiling;
    const spec: TurnSpec = {
      ...this.spec(prompt, m.system, mcp, grant, this.unpaid !== null && (m.model ?? "") === this.unpaid ? MODEL_FALLBACK[this.opts.tool] : m.model, m.effort),
      // A conversation picked up and resumed has never been told, and one that was told has not heard what changed since. A new
      // one always is: a turn the CLI gave no id for leaves the next to start another.
      withSystem: !bare && (!this.resumeId || m.system !== this.sentSystem),
      ...(this.account && this.account.id !== DEFAULT_ACCOUNT ? { account: this.account.id } : {}),
      ...(systemFile ? { systemFile } : {}),
      ...(fork ? { fork } : {}),
      // The attached files as input of the tool's own, where it takes them (pictures to Codex, content blocks over ACP).
      ...(files.length && !asTyped ? { files } : {}),
      // Codex's own /review or /compact, typed alone: its app-server runs it (see CODEX_BUILTINS).
      ...(asTyped && this.opts.tool === "codex" && !this.legacyCodex ? builtinOf(prompt) : {}),
    };
    this.blocked = null;
    this.live.clear();
    this.waitingAsks.length = 0;
    this.askedLive.clear();
    this.log(`turn ${m.id}: ${m.prompt.split("\n")[0]!.slice(0, 100)}`);
    const argv = [...this.launch.prefix, ...adapter.args(spec)];
    // An ACP tool kept from the last turn, or started as the lane opened, takes it once it is ready: a first instruction sent the
    // moment the lane opens can wait a little for it, still less than starting one.
    const taken = this.acp ? await this.acp.take(this.acpHow(spec)) : null;
    // It couldn't be started this way at all, as the turn found out: the same turn goes again the old way.
    if (!taken && this.acp?.unsupported && this.opts.tool === "codex") {
      this.useLegacyCodex();
      this.asked = mine;
      this.unrun = carried;
      return this.turn(m, files);
    }
    // Stopped while it waited for that: as stopped before it began (see above).
    if (this.stopping) {
      taken?.child.stdin!.end();
      this.unrun = prompt;
      this.send({ kind: "turn.end", id: m.id, outcome: "stopped" });
      this.log(`turn ${m.id} stopped before it began`);
      return;
    }
    // Claude Code takes the turn in the process kept from the last one, as an ACP tool does; the other CLIs start one for each
    // turn. None throws: a CLI that couldn't be started says so as an "error" (ENAMETOOLONG among them, see `exit` below).
    // Stopped while this turn was getting ready (its files, its MCP servers): no process is started that nobody will stop.
    if (this.stopped) {
      taken?.child.stdin!.end();
      return;
    }
    // No asking Claude Code for its usage (limits.ts) while it is being started for this turn.
    if (this.opts.tool === "claude") noteClaudeStarting();
    // Cursor, Amp or `codex exec` started as the last turn ended, when this turn starts exactly as it was started; else its own.
    const ahead = adapter.prespawn && !taken ? this.next.take(this.launch.command, [...this.launch.prefix, ...adapter.args({ ...spec, stdinPrompt: true })], this.spawnOptions(adapter.env?.(spec))) : null;
    const child = taken ? taken.child : ahead ? ahead : this.warm ? this.warm.start(this.launch.command, argv, this.spawnOptions(), claudePictures(spec)) : spawnCli(this.launch.command, argv, this.spawnOptions(adapter.env?.(spec)));
    this.child = child;
    const input = adapter.stdin(ahead ? { ...spec, stdinPrompt: true } : spec);
    child.stdin!.on("error", () => {});
    const stdin = child.stdin!;
    if (!adapter.interactive) stdin.end(input);
    // A kept ACP tool was initialized as it started.
    else if (!taken) stdin.write(input);

    const parse = adapter.parser(
      spec,
      adapter.interactive
        ? { cwd: this.opts.cwd, write: (l) => void (stdin.writableEnded || stdin.write(l)), end: () => void (stdin.writableEnded || stdin.end()), ...(taken ? { kept: taken.kept } : {}) }
        : undefined,
    );
    this.cancelTurn = parse.cancel ?? null;
    // How a message reaches this turn while it runs: Codex's own steer, or the kept Claude Code's stdin. Others can't take one.
    const warm = this.warm;
    this.steerTurn = parse.steer ?? (warm && !taken && !ahead && child !== null ? (text: string) => Promise.resolve(warm.steer(text)) : null);
    let done: { error?: string } | null = null;
    let note = "";
    let stderr = "";
    let grace: ReturnType<typeof setTimeout> | undefined;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let held: ReturnType<typeof setTimeout> | undefined;
    let tooLong = false;
    // Its final word is in. A CLI that then doesn't exit (a hook, an MCP server that won't shut down) is ended after a
    // while, and the turn still counts as done: it was.
    const onDone = (d: { error?: string; held?: boolean }) => {
      done = d;
      // Held for its background tasks, it isn't finished: it carries on by itself once they are (see noteBackground).
      if (!d.held) grace ??= setTimeout(() => child.exitCode === null && child.kill("SIGTERM"), FINISH_GRACE_MS);
    };
    // Silence is not a fault — a build or a test suite says nothing until it is over — so a long one is only said, where
    // the room can see it and decide. Silence with nothing running is (hung.ts): the tool is ended and the turn goes again.
    let heard = Date.now();
    /** When the turn was handed over: with nothing of the work since, how long it has been silent (see neverStarted). */
    const began = heard;
    /** Its process tree's CPU seconds at the last quiet note, while it has said nothing since. */
    let cpuMark: number | null = null;
    let hung = false;
    /** Nothing from the tool yet this turn, and its tree's CPU seconds as the turn began: see neverStarted. */
    let spoke = false;
    let startCpu: number | null = null;
    void treeCpu(child.pid).then((c) => (startCpu = c));
    /** How long it had been silent when it was ended, for what the room is told. */
    let hungFor = hungMs();
    const end = (why: string, after: number) => {
      hung = true;
      hungFor = after;
      this.log(why);
      child.kill("SIGTERM");
      setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill("SIGKILL"), 5000).unref?.();
    };
    // Not a word after firstWordMs, idle all the while: it never got going, so it goes again now rather than at hungMs.
    const firstWord = setTimeout(
      () =>
        void (async () => {
          if (spoke || done || this.live.size > 0 || this.meshWaits.size > 0) return;
          const cpu = await treeCpu(child.pid);
          if (spoke || child.exitCode !== null || child.signalCode !== null) return;
          if (neverStarted(Date.now() - began, startCpu, cpu)) end(`${this.label} said nothing and ran nothing for ${minutes(firstWordMs())} after it was handed the turn; ending it so the turn can go again`, firstWordMs());
        })(),
      firstWordMs(),
    );
    const listen = () => {
      clearTimeout(quiet);
      quiet = setTimeout(
        () =>
          void (async () => {
            // Waiting on a person's answer, or another agent's, is not being stuck.
            const waiting = this.live.size > 0 || this.meshWaits.size > 0;
            const cpu = waiting || done ? null : await treeCpu(child.pid);
            if (child.exitCode !== null || child.signalCode !== null) return;
            if (hung) return;
            if (!waiting && !done && isHung(Date.now() - heard, cpuMark, cpu)) {
              end(`${this.label} said nothing and ran nothing for ${minutes(hungMs())}; ending it so the turn can go again`, hungMs());
              return;
            }
            cpuMark = cpu;
            if (!this.live.size) this.send({ kind: "delta", channel: "reasoning", text: `\n${this.label} hasn't said anything for ${minutes(quietMs())}. It may still be busy with a long command; Stop it if it's stuck.\n` });
            listen();
          })(),
        quietMs(),
      );
    };
    listen();
    child.stderr!.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      heard = Date.now();
      const outs = parse(line);
      // Only the tool getting on with the turn counts as it having spoken: a word, a thought, a step, or a notice of its turn.
      // A reply to the request that handed it the turn, or which conversation it is in, isn't: Codex answered a turn that way
      // and then did nothing, and since it had "spoken" the turn sat twenty minutes rather than five before being restarted
      // (Edge Defense, 2026-10-25: "still being stuck").
      if (outs.some((o) => !BOOKKEEPING.has(o.kind)) || (TOOL_NOTICE.test(line) && !SETUP_NOTICE.test(line))) spoke = true;
      cpuMark = null;
      listen();
      for (const out of outs) this.forward(out, onDone, (n) => (note = n));
    });

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("close", (code, signal) => resolve({ code, signal }));
      child.on("error", (err: NodeJS.ErrnoException) => {
        stderr += err.message;
        // Node reports these as "spawn ENAMETOOLONG", which tells nobody anything.
        if (err.code === "ENAMETOOLONG" || err.code === "E2BIG") tooLong = true;
        resolve({ code: -1, signal: null });
      });
      // Over when the process is, not only once its output closes: something it started (an MCP server, a command left
      // running in the background) can hold that open long after, and with it the turn and the Stop button.
      child.once("exit", () => {
        held = setTimeout(() => resolve({ code: child.exitCode, signal: child.signalCode }), 2000);
      });
    });
    clearTimeout(grace);
    clearTimeout(quiet);
    clearTimeout(firstWord);
    clearTimeout(held);
    lines.close();
    child.stdout?.destroy();
    child.stderr?.destroy();
    this.child = null;
    this.cancelTurn = null;
    this.steerTurn = null;
    if (systemFile) void unlink(systemFile).catch(() => {});

    const finished = done as { error?: string } | null;
    let outcome: "done" | "stopped" | "error" = "done";
    let error: string | undefined;
    if (this.stopping) outcome = "stopped";
    else if (hung && !this.unstuck.has(m.id)) {
      // Hung (hung.ts): the same turn goes again once, on its own conversation, so it carries on where it stopped. The room is
      // told why it went quiet, rather than reading "Thinking…" until somebody notices.
      this.unstuck.add(m.id);
      this.send({ kind: "delta", channel: "reasoning", text: `\n${this.label} stopped responding: it said nothing and ran nothing for ${minutes(hungFor)}. Friday restarted it to carry on.\n` });
      this.asked = mine;
      this.unrun = carried;
      return this.turn(m, files);
    } else if (!finished || finished.error) {
      outcome = "error";
      const raw = hung
        ? `${this.label} stopped responding again after Friday restarted it (nothing said or run for ${minutes(hungFor)}), so the turn was ended. Send it again, or try another agent.`
        : finished?.error || note || stderr.trim() || `${this.label} exited with ${exit.signal ?? `code ${exit.code}`}.`;
      // A Claude Code conversation still running as a background agent can't be resumed in place, only copied. It refuses
      // before doing anything, so the same instruction goes again at once, on a copy, and nothing is lost; the copy's id then
      // replaces the original's for the turns after (see `forward`).
      // Codex's thread or an ACP tool's session that is open somewhere else the same way: carried on from a fork of it.
      if (!fork && this.resumeId && (/is running as a background session/i.test(raw) || busyElsewhere(raw))) {
        this.log(`${this.label}'s conversation ${this.resumeId} is running in the background on this machine, so this carries on from a copy of it`);
        this.forkNext = true;
        this.asked = mine;
        this.unrun = carried;
        return this.turn(m, files);
      }
      // Out of usage on this account: the run ends on its limit, saying so, and when another account of this tool here has room
      // (accounts.ts) that it is there to switch to. Never switched to by itself: going on as another sign-in is the person's own
      // call, not Friday's, as the tool's maker keeps each plan to "ordinary, individual usage" (Arun, 2026-10-27: "i do not want
      // my account banned"). The hand-off to another tool (limit-handoff.ts) takes it from there.
      const other = this.account && OUT_OF_USAGE.test(raw) && !this.stopping && !this.stopped ? await this.otherAccount(raw) : null;
      // A model this account can't run (MODEL_UNPAID): the same turn goes again on the tool's everyday model, as will every turn
      // asked of that model after it, and the room is told. Once: a fallback refused too ends the run as it would have.
      const fallback = MODEL_FALLBACK[this.opts.tool];
      if (fallback && MODEL_UNPAID.test(raw) && !OUT_OF_USAGE.test(raw) && this.unpaid === null && spec.model !== fallback && !this.stopping && !this.stopped) {
        this.unpaid = m.model ?? "";
        const named = /^(\S+(?:\s+[\d.]+)?)\s+requires/i.exec(raw)?.[1] ?? (m.model || "its usual model");
        this.log(`${this.label} can't run ${named} on this account; its turns run on ${fallback} instead`);
        this.send({ kind: "delta", channel: "reasoning", text: `\n${named} needs usage credits on this account, so ${this.label} carries on with ${fallback} instead.\n` });
        this.asked = mine;
        this.unrun = carried;
        return this.turn(m, files);
      }
      // A version from before its effort flag stops at it before doing anything: the same turn goes again without it, and the
      // room is told the level wasn't applied rather than the run failing.
      if (spec.effort && !this.noEffort && /effort/i.test(raw) && /unknown (option|argument)|unrecognized|unexpected argument|unknown variant|invalid value/i.test(raw)) {
        this.log(`${this.label} here doesn't take an effort level, so its turns run without one`);
        this.noEffort = true;
        this.send({ kind: "event", body: { type: "effort.skipped", effort: spec.effort } });
        this.asked = mine;
        this.unrun = carried;
        return this.turn(m, files);
      }
      // The same for a newer flag of its own (Adapter.optional): an older version that stops at it runs the turn again without.
      const refused = refusedFlag(raw, (adapter.optional ?? []).filter((f) => argv.includes(f) && !this.skipFlags.has(f)));
      if (refused) {
        this.log(`${this.label} here doesn't take ${refused}, so its turns run without it`);
        this.skipFlags.add(refused);
        this.asked = mine;
        this.unrun = carried;
        return this.turn(m, files);
      }
      // Claude Code without auto mode turning a Work turn's away: the same turn goes again as Auto runs everywhere else (AUTO_MODE).
      if (argv[argv.indexOf("--permission-mode") + 1] === "auto" && !this.skipFlags.has(AUTO_MODE) && autoModeRefused(raw)) {
        this.log(`${this.label} here doesn't take auto mode, so its turns in Auto run with edits allowed and Auto's tools`);
        this.skipFlags.add(AUTO_MODE);
        this.asked = mine;
        this.unrun = carried;
        return this.turn(m, files);
      }
      error = tooLong ? `What ${this.label} was handed this turn is too long for this computer to start it with. Send a shorter instruction, or several.` : adapter.explain(raw);
      if (other) error = `${error} Your ${other.label} account is signed in here too: switch this agent to it from its account menu to carry on.`;
      // A failed resume would fail the same way every time; start fresh next turn. Remembered as lost (see `saveResume`), so a
      // reconnect for the same pick doesn't bring the dead id back, and the server is told, here and on each reconnect, so the
      // fresh conversation is sent the history it no longer has.
      if (/couldn't find its earlier conversation/.test(error)) {
        this.resumeId = null;
        this.lost = true;
        this.sentSystem = null;
        this.send({ kind: "resume.lost" });
      }
    }
    // Whatever the conversation is now, it was given these instructions, unless the tool failed before reading them.
    if (outcome !== "error" && !bare) this.sentSystem = m.system;
    // A kept ACP tool that failed a turn may not get past it (signed in since, its conversation gone): the next starts it afresh.
    if (outcome === "error") this.acp?.reset();

    await this.reportDiff();
    await this.saveResume();
    // Stopped from doing something in Manual mode: say so, where the driver can answer, before the turn is over. Not what was
    // asked about while it ran: that was refused because a person said no, or the turn ended before they answered, and the
    // question is still there for them.
    this.live.clear();
    this.waitingAsks.length = 0;
    const refused = this.blocked as { scope: "commands" | "turn"; items: string[] } | null;
    const left = refused?.items.filter((i) => !this.askedLive.has(i)) ?? [];
    const blocked = refused && left.length ? { scope: refused.scope, items: left } : null;
    // Already given everything a yes can give (the whole turn, or these very commands) and still refused: that was the tool's
    // own sandbox, not Friday. Asking again would grant nothing new, and the card would come back after every yes.
    const nothingMore = !!grant && !!blocked && (grant.scope === "turn" || blocked.items.every((i) => grant.items.includes(i)));
    if (outcome === "done" && blocked && nothingMore) {
      outcome = "error";
      error = `${this.label} still couldn't do this after you said yes: ${blocked.items.join("; ")}. It wasn't Friday holding it back, so another yes won't help: its steps above show what went wrong.`;
    } else if (outcome === "done" && blocked && this.mode !== "full") {
      this.asked = { id: randomUUID().slice(0, 8), scope: blocked.scope, items: blocked.items };
      this.send({ kind: "event", body: { type: "engine.approval", ...this.asked } });
    }
    this.send({ kind: "turn.end", id: m.id, outcome, ...(error ? { error } : {}) });
    this.log(`turn ${m.id} ${outcome}${error ? `: ${error}` : ""}`);
    this.shareLimits();
    this.contextAfterTurn();
    // The next turn's process, started now as that turn will most likely start it (this one's model, effort and mode, the
    // conversation as it now is, no yes), after the end is said. Not after a failure, which the same start would likely repeat.
    if (adapter.prespawn && outcome !== "error" && !this.stopped) {
      const next = { ...this.spec("", m.system, mcp, undefined, m.model, m.effort), stdinPrompt: true };
      this.next.start(this.launch.command, [...this.launch.prefix, ...adapter.args(next)], this.spawnOptions(adapter.env?.(next)));
    }
  }

  /** When this lane's tool last told the server its limits (see shareLimits). */
  private limitsAt = 0;

  /**
   * The turn this runner was on when its connection dropped, kept running for the runner that reconnects to take on (adopt)
   * rather than stopped and started again: about 80 runs a week were cut by server restarts, each losing what it had going, a
   * test run, a build, the step it was on (Arun, 2026-10-25). What it says meanwhile waits in `outbox`, in order.
   */
  private kept: { id: string; outbox: unknown[]; timer: NodeJS.Timeout } | null = null;
  /** Where this runner's messages go once the runner after it took its kept turn on. */
  private handOn: ((m: unknown) => void) | null = null;
  /** The runner whose kept turn this one took on, while that turn runs. */
  private adopted: Runner | null = null;
  /** The runner before this one on the lane (stayAttached): its kept turn, if it has one, is this one's to take on. */
  prev: Runner | null = null;
  /** The model this lane's turns were asked for that its account can't run ("" for the tool's own default), once found: run on MODEL_FALLBACK. */
  private unpaid: string | null = null;

  /**
   * The account a lane opens on: the one asked for, else the tool's own sign-in, even when it is out of usage: which account to go
   * on as is the person's pick, never Friday's (otherAccount). An added one's folder is linked up again first, in case a link went
   * (a folder moved, a skills folder made since).
   */
  private async startAccount(tool: EngineTool, wanted: string | undefined): Promise<ToolAccount> {
    if (!hasAccounts(tool)) throw new RunnerError(`${ENGINE_NAMES[tool]} has one account on a computer.`);
    const all = await listAccounts(tool);
    let pick = wanted ? all.find((a) => a.id === wanted) : undefined;
    if (wanted && !pick) throw new RunnerError(`${ENGINE_NAMES[tool]} has no account called “${wanted}” on this computer. Pick another, or add it in Friday's tool settings.`);
    pick ??= all[0]!;
    if (pick.id !== DEFAULT_ACCOUNT) await prepareAccountDir(tool, pick.id);
    return pick;
  }

  /**
   * This account out of usage: marked so until its limit lifts, and the next account of the tool here that is signed in and not
   * out itself, if any, named for the person to switch to. Nothing is switched.
   */
  private async otherAccount(raw: string): Promise<ToolAccount | null> {
    const tool = this.opts.tool;
    const from = this.account;
    if (!hasAccounts(tool) || !from) return null;
    await markOut(tool, from.id, limitHit(raw)?.resetsAt ?? null).catch(() => {});
    const bin = this.bin;
    return nextAccount(tool, from.id, (id) => (this.opts.bin || !bin ? Promise.resolve(null) : startChecks.loginStatusCached(tool, bin, id === DEFAULT_ACCOUNT ? undefined : id))).catch(() => null);
  }

  /**
   * The tool's limits, read on this machine and sent to the session for routing (routing.ts): only the numbers, never a sign-in.
   * As the lane opens and after a turn, at most every five minutes, and only for a tool with models of more than one size.
   */
  private shareLimits(): void {
    const tool = this.opts.tool;
    if ((tool !== "claude" && tool !== "codex") || this.opts.bin || Date.now() - this.limitsAt < 5 * 60_000) return;
    this.limitsAt = Date.now();
    // As last said: asking Claude Code itself (limits.ts) waits for the card or a hand-off, not a lane that is starting it.
    void readLimits({ askClaude: false }).then(
      (l) => {
        // The account it runs as, when it isn't the tool's own sign-in: its windows are the ones its turns spend.
        const acct = this.account && this.account.id !== DEFAULT_ACCOUNT ? l.accounts?.[tool]?.find((a) => a.id === this.account!.id) : undefined;
        const windows = acct
          ? acct.windows.map((w) => ({ kind: w.kind, ...(w.label ? { label: w.label } : {}), usedPercent: w.usedPercent }))
          : tool === "claude"
            ? l.claudeWindows.map((w) => ({ kind: w.kind ?? "", ...(w.label ? { label: w.label } : {}), usedPercent: w.utilization === null ? null : w.utilization * 100 }))
            : (l.codexWindows ?? []).map((w) => ({ kind: w.kind, ...(w.label ? { label: w.label } : {}), usedPercent: w.usedPercent }));
        this.send({ kind: "limits", windows });
      },
      () => {},
    );
  }

  /** What the tool was stopped from doing in the turn now running, if the machine is in Manual mode. */
  private blocked: { scope: "commands" | "turn"; items: string[] } | null = null;
  /** What this machine, in Manual mode, last asked a person's permission for: an answer from an older server doesn't say. */
  private asked: { id: string; scope: "commands" | "turn"; items: string[] } | null = null;
  /** What the tool is waiting on a person for in the turn now running, by the id of the question put to them. */
  private readonly live = new Map<string, { requestId: string; input: Record<string, unknown>; reply?: (allow: boolean) => void }>();
  /**
   * Asks that came while another was open (two subagents, or two fetches at once). The session shows one request per agent
   * at a time, so a second card replaced the first, and the first could then never be answered: these wait their turn and
   * are put one after another, each once the one before is answered.
   */
  private readonly waitingAsks: { scope: "commands" | "turn"; item: string; why?: string; requestId: string; input: Record<string, unknown>; reply?: (allow: boolean) => void }[] = [];

  /** Put an ask to the session as its card. */
  private putAsk(a: (typeof this.waitingAsks)[number]): void {
    const id = randomUUID().slice(0, 8);
    this.live.set(id, { requestId: a.requestId, input: a.input, ...(a.reply ? { reply: a.reply } : {}) });
    this.askedLive.add(a.item);
    this.send({ kind: "event", body: { type: "engine.approval", id, scope: a.scope, items: [a.item], live: true, ...(a.why ? { why: a.why } : {}) } });
  }
  /** How the turn now running is stopped, for a tool that has a way of its own (see Parser.cancel). */
  private cancelTurn: (() => void) | null = null;
  /** Hands a message to the turn running now (see Parser.steer); null when this tool, or this turn, can't take one. */
  private steerTurn: ((text: string) => Promise<boolean>) | null = null;

  /** A message from the server for the turn running now: given to the tool at its next step when it can be, said either way. */
  private async steerNow(id: string, text: string): Promise<void> {
    const steer = this.steerTurn;
    const ok = steer ? await steer(text).catch(() => false) : false;
    this.send({ kind: "steer.result", id, ok });
    this.log(`${this.label} ${ok ? "was given a message mid-turn" : "couldn't take a message mid-turn; it waits for the next turn"}`);
  }
  /** Everything asked about while this turn ran, as the card worded it. */
  private readonly askedLive = new Set<string>();

  private forward(out: AdapterOut, onDone: (d: { error?: string; held?: boolean }) => void, onNote: (n: string) => void): void {
    switch (out.kind) {
      case "task": {
        const { kind: _, ...task } = out;
        this.send({ kind: "event", body: { type: "agent.task", ...task } });
        break;
      }
      case "usage":
        this.send({ kind: "event", body: { type: "agent.usage", input: out.input, cached: out.cached, output: out.output, ...(out.context ? { context: out.context, ...(out.window ? { window: out.window } : {}) } : {}) } });
        break;
      case "models":
        if (this.opts.tool) rememberModels(this.opts.tool, out.list);
        break;
      case "efforts":
        if (this.opts.tool) rememberEfforts(this.opts.tool, out.list);
        break;
      case "commands": {
        const tool = this.opts.tool;
        if (!tool) break;
        const list: ToolCommand[] = out.list.map((c) => ({ name: c.name, description: c.description, ...(c.hint ? { hint: c.hint } : {}), insert: `/${c.name} ` }));
        rememberCommands(tool, list);
        break;
      }
      case "ask": {
        // Auto: nobody is asked, so what the tool would have asked about goes ahead, as for a person who always says yes. A
        // question for the person (Claude Code's AskUserQuestion) is the one thing not answered for them.
        if (this.mode === "full") {
          const allow = out.tool !== "AskUserQuestion";
          if (out.reply) out.reply(allow);
          else this.warm?.answer(out.requestId, allow, out.input, DECIDE_YOURSELF);
          break;
        }
        // Plan changes nothing, so a change is refused without asking anyone; its commands are still put to a person.
        if (this.mode === "plan" && PLAN_REFUSES.includes(out.tool)) {
          if (out.reply) out.reply(false);
          else this.warm?.answer(out.requestId, false, out.input, out.tool === "ExitPlanMode" ? "Plan mode: the plan you wrote is shown to the person, who decides when it is carried out. Stop here." : "Plan mode doesn't change files. Say what you would change instead.");
          break;
        }
        const { scope, item } = askedItem(out.tool, out.input);
        // Nothing to put to a person (an empty command): refused, with a word for the agent, rather than left waiting.
        if (!item) {
          if (out.reply) out.reply(false);
          else this.warm?.answer(out.requestId, false, out.input, "That needs a person's approval, and there was nothing to show them. Try again with the full command.");
          break;
        }
        const ask = { scope, item, ...(out.why ? { why: out.why } : {}), requestId: out.requestId, input: out.input, ...(out.reply ? { reply: out.reply } : {}) };
        if (this.live.size) this.waitingAsks.push(ask);
        else this.putAsk(ask);
        break;
      }
      case "blocked":
        this.blocked = { scope: out.scope, items: out.items };
        break;
      case "session":
        this.resumeId = out.id;
        break;
      case "delta":
        if (out.text) this.send({ kind: "delta", text: out.text, channel: out.channel });
        break;
      case "message":
        this.send({
          kind: "event",
          body: { type: "agent.message", text: out.text, toolCalls: out.toolCalls, ...(out.reasoning ? { reasoning: [{ type: "reasoning.text", text: out.reasoning }] } : {}) },
        });
        break;
      case "result":
        this.send({ kind: "event", body: { type: "tool.result", callId: out.callId, name: out.name, output: out.output, isError: out.isError } });
        break;
      case "note":
        if (out.text) onNote(out.text);
        break;
      case "done":
        onDone({ error: out.error, ...(out.held ? { held: true } : {}) });
        break;
    }
  }

  /**
   * Stop the CLI the way a person at the keyboard would: Ctrl-C first, which
   * lets it end the turn and save its conversation, then harder if it hangs.
   */
  private interrupt(): void {
    // Marked even with no CLI running yet: a turn still getting ready checks it before starting one, and a turn going again on
    // a copy of its conversation has none for a moment (see `turn`).
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    if (this.cancelTurn) this.cancelTurn();
    else child.kill("SIGINT");
    const t1 = setTimeout(() => child.exitCode === null && child.kill("SIGTERM"), 4000);
    const t2 = setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 8000);
    child.once("close", () => (clearTimeout(t1), clearTimeout(t2)));
  }

  private killChild(): void {
    // Always, a CLI or not: a turn still getting ready (a download, the snapshot, a tool warming up) checks it before starting
    // one, and without it a dropped connection let that turn start a CLI nobody could see or stop.
    this.interrupt();
    // Only ever called as this runner ends: a kept Claude Code or ACP tool goes with it.
    this.warm?.close();
    this.acp?.close();
    this.next.close();
  }

  /**
   * Report the diff shortly, and only once for a burst.
   *
   * An agent editing a folder writes ten files in a few seconds; running git
   * after each one costs more than it tells anybody, and the panel only needs
   * to be right a moment later.
   */
  private scheduleDiff(): void {
    if (this.diffTimer) return;
    this.diffTimer = setTimeout(() => {
      this.diffTimer = null;
      void this.reportDiff();
    }, 1200);
    // Never hold the process open for a diff.
    this.diffTimer.unref?.();
  }

  /**
   * Apply: the agent's work in this separate copy goes into the folder it was copied from (see applyCopy). Afterwards the
   * copy starts again from where it is, so what it shows is what hasn't been brought over yet.
   */
  private async applyToOrigin(): Promise<string> {
    const into = this.opts.copyOf;
    if (into && !this.base) await this.setBase(await sessionBase(this.opts.cwd, this.baseKey, false).catch(() => null));
    if (!into || !this.base) return JSON.stringify({ error: "This agent isn't working in a separate copy, so there's nothing to bring over." });
    if (this.mode === "plan") return JSON.stringify({ error: "This machine is in plan mode, so it doesn't change files." });
    const r = await applyCopy(this.opts.cwd, this.base, into);
    if (r.files.length) {
      const sha = await checkpoint(this.opts.cwd, "brought over");
      if (sha) {
        await this.setBase(sha);
        await setSessionBase(this.opts.cwd, this.baseKey, sha).catch(() => {});
      }
      this.scheduleDiff();
    }
    return JSON.stringify({ files: r.files, conflicts: r.conflicts, into });
  }

  /**
   * The run's checkpoint, taken here as its first turn is handed to the tool rather than asked for by the session before it
   * sent the turn (a round trip and several gits, 0.3 to 1.5s on Windows). Said as soon as it is taken, so ahead of anything
   * the tool does: the session logs it as the run's. In this machine's own mode, as the session's asking was, whatever the
   * turn is capped to; plan mode and a folder outside git answer with no id, and that run has no undo.
   */
  private async turnCheckpoint(id: string): Promise<void> {
    const sha = await this.checkpoint(readRepo(this.opts.cwd, { op: "checkpoint", query: "run", mode: this.opts.mode ?? "full" })).catch(() => "");
    if (/^[0-9a-f]{40}$/.test(sha)) {
      this.before = { sha, at: Date.now() };
      this.send({ kind: "checkpoint", id, sha });
    }
  }

  /**
   * Where the folder started for this session, taken the first time the agent is about to change something: a lane that
   * only looks never takes one. A runner coming back to the session finds the one taken before (sessionBase keeps it).
   */
  private ensureBase(): Promise<string | null> {
    if (!this.repo || (this.opts.mode ?? "full") === "plan") return Promise.resolve(null);
    return (this.basing ??= (async () => {
      // The session saved the folder a moment ago, just before sending this first turn, so it can be undone: that is where the
      // folder started too, and taking it again held the turn back by as long as the first.
      const just = !this.opts.reattach && this.before && Date.now() - this.before.at < 10_000 ? this.before.sha : null;
      let b = await sessionBase(this.opts.cwd, this.baseKey, !this.opts.reattach && !just);
      if (!b && just) {
        b = just;
        await setSessionBase(this.opts.cwd, this.baseKey, b).catch(() => {});
      }
      // Coming back to a session that kept no starting point (it began on an older Friday, or the turn cut off took none):
      // measured from the last commit, as it always was, so nothing the agent did before is hidden as the person's.
      if (!b && this.opts.reattach && this.repo) {
        b = this.repo.head;
        await setSessionBase(this.opts.cwd, this.baseKey, b).catch(() => {});
      }
      await this.setBase(b);
      return b;
    })().catch((e: Error) => {
      this.log(`couldn't note where the folder started, so changes are measured from the last commit: ${e.message}`);
      return null;
    }));
  }

  /** Send the change set if it moved since the last one. `quietIfEmpty`: a clean folder is not news. */
  /** Where each of the agent's other folders stood when the session first looked there (reportDiff). */
  private dirBases = new Map<string, string>();

  private async reportDiff(quietIfEmpty = false): Promise<void> {
    if (this.stopped) return;
    // Measured from where the session started. Before the agent has changed anything there is none yet, and nothing of
    // its own to show: the folder's uncommitted work is the person's.
    const editing = !!this.repo && (this.opts.mode ?? "full") !== "plan";
    if (editing && !this.base) {
      if (this.opts.reattach) await this.ensureBase();
      else await this.setBase(await sessionBase(this.opts.cwd, this.baseKey, false).catch(() => null));
      if (!this.base) return;
    }
    const base = this.base ?? this.repo?.head ?? this.shadow?.head;
    if (!base) return;
    try {
      const own = this.base && !this.baseIsHead ? await diffTrees(this.opts.cwd, this.base) : await diffSince(this.opts.cwd, base, this.repo ? undefined : (this.shadow ?? undefined));
      // The folders the agent also works in, each measured from where it stood when this session first looked (kept in the
      // repository like the folder's own base, so a runner coming back finds it); a folder that isn't a repository shows nothing.
      const elsewhere: DiffFile[] = [];
      for (const dir of this.opts.dirs ?? []) {
        if (dir === this.opts.cwd) continue;
        try {
          let b = this.dirBases.get(dir) ?? (await sessionBase(dir, this.baseKey, true));
          if (!b) continue;
          this.dirBases.set(dir, b);
          for (const f of await diffTrees(dir, b)) elsewhere.push({ ...f, repo: dir });
        } catch {
          // Not a repository, or one that can't be read: nothing to show for it.
        }
      }
      const files = Object.assign([...own, ...elsewhere], own.more ? { more: own.more } : {});
      if (quietIfEmpty && !files.length) return;
      const key = JSON.stringify([files, files.more]);
      if (key === this.lastDiff) return;
      this.lastDiff = key;
      this.send({ kind: "event", body: { type: "agent.diff", base, files: [...files], ...(files.more ? { more: files.more } : {}) } });
    } catch (e) {
      this.log(`couldn't read the diff: ${(e as Error).message}`);
    }
  }

  /** Attachments land in a temp folder, not the repo, so they never show up as changes. */
  private async download(atts: Attachment[]): Promise<string[]> {
    if (!atts.length) return [];
    const dir = path.join(tmpdir(), `friday-${this.opts.session}`);
    await mkdir(dir, { recursive: true });
    const out: string[] = [];
    for (const a of atts) {
      try {
        const res = await fetch(`${this.opts.server}/api/sessions/${encodeURIComponent(this.opts.session)}/files/${encodeURIComponent(a.id)}?invite=${encodeURIComponent(this.opts.invite)}`);
        if (!res.ok) continue;
        const p = path.join(dir, `${a.id}-${a.name.replace(/[/\\]/g, "_")}`);
        await writeFile(p, Buffer.from(await res.arrayBuffer()));
        out.push(p);
      } catch {
        // A file that can't be fetched is mentioned by name in the instruction anyway.
      }
    }
    return out;
  }

  // The CLI's conversation id survives a runner restart, so reconnecting
  // continues the same conversation instead of starting over.
  private get resumeKey(): string {
    // A teammate's is who it is and its tool: the same conversation whatever port the app opens on and whichever project it
    // is pointed at (teammates.ts). A new tool is a new conversation.
    if (this.opts.keepAs) return ["teammate", this.opts.keepAs, this.opts.tool].join("|");
    return [this.opts.server, this.opts.session, this.lane, this.opts.tool, this.opts.cwd].join("|");
  }

  /** The conversation the person picked, when it is this tool's own: another tool's was shared as history when the lane attached. */
  private get picked(): string | undefined {
    const o = this.opts;
    return o.resumeId && (!o.resumeTool || o.resumeTool === o.tool) ? o.resumeId : undefined;
  }

  private async loadResume(): Promise<void> {
    const all = await remembered();
    const key = this.resumeKey;
    const picked = this.picked;
    // Attaching again for the pick this lane already carries on, as a reconnect does: where it got to wins over the pick itself.
    // The pick may be a conversation Claude Code still runs elsewhere, carried on from a copy since, which resuming the original
    // would lose; or one that turned out not to exist, which would only fail again.
    if (picked && all[`${key}|from`] === picked) {
      this.resumeId = all[key] || null;
      this.lost = all[`${key}|lost`] === "1";
      // The server took the pick for this lane's memory again on attaching, and would keep its history from the fresh one.
      if (this.lost) this.send({ kind: "resume.lost" });
      this.log(this.lost ? `${this.label} session ${picked} couldn't be found earlier, so this lane carries on without it` : `continuing ${this.label} session ${this.resumeId ?? picked}`);
      return;
    }
    // Continuing a conversation the person picked wins over whatever this lane used last time, and is remembered from here on.
    if (picked) {
      this.resumeId = picked;
      await this.saveResume();
      this.log(`continuing ${this.label} session ${picked}`);
      return;
    }
    this.resumeId = all[key] || null;
  }

  private async saveResume(): Promise<void> {
    try {
      const all = await remembered();
      const key = this.resumeKey;
      const picked = this.picked;
      if (picked) {
        // Which pick this lane's entry is for, and whether it was lost, so attaching for it again carries on from here (see
        // `loadResume`). With no conversation yet it is kept, empty, rather than dropped, which would bring the pick back.
        all[key] = this.resumeId ?? "";
        all[`${key}|from`] = picked;
        if (this.lost) all[`${key}|lost`] = "1";
        else delete all[`${key}|lost`];
      } else if (this.resumeId) all[key] = this.resumeId;
      // One that turned out not to exist any more is forgotten, or every reconnect would try it again.
      else if (key in all) delete all[key];
      else return;
      await mkdir(path.dirname(stateFile()), { recursive: true });
      await writeFile(stateFile(), JSON.stringify(all, null, 2));
    } catch {
      // Not being able to remember only costs continuity, never correctness.
    }
  }
}

/** A folder as it really is on this disk, links resolved; as given when it can't be read. */
function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/** How recently somebody must have looked at a lane's context for a turn's end to read it again (Runner.contextAfterTurn). */
const CONTEXT_WATCHED_MS = 30 * 60_000;

/** A conversation of Claude Code's deleted by its id: the copy `/context` was asked of (Runner.toolContext). */
async function dropClaudeConversation(id: string): Promise<void> {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), "projects");
  const { readdir } = await import("node:fs/promises");
  for (const dir of await readdir(root).catch(() => [] as string[])) await unlink(path.join(root, dir, `${id}.jsonl`)).catch(() => {});
}
