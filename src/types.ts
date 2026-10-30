// Every durable fact about a session is one of these events. The log is the
// source of truth: session state, the agent's context window, the catch-up
// digest and the audit trail are all projections of it.

export type Role = "owner" | "editor" | "viewer";
export type LinkRole = "editor" | "viewer";

/**
 * How control changes hands. "ask": requesting control asks the driver, who
 * approves (so the log shows who approved each handoff). "takeover": anyone
 * allowed to drive can grab control immediately.
 */
export type ControlMode = "ask" | "takeover";

/** What non-owners may do. Owners can always do everything. */
import type { CommandClass } from "./command-class.js";
export type Permission = "suggest" | "control" | "upload" | "invite";
export type RolePolicy = Record<Permission, boolean>;
export interface SessionPolicy {
  editor: RolePolicy;
  viewer: RolePolicy;
}
export type PolicyPatch = { editor?: Partial<RolePolicy>; viewer?: Partial<RolePolicy> };

export interface AgentTools {
  webSearch: boolean;
  askHuman: boolean;
  /** Which MCP connections the agent may use. */
  connections: "all" | "none" | string[];
}

/** A copy of an agent's configuration, frozen into the session log when it's chosen. */
/**
 * One skill as an agent carries it: the trigger it is recognised by, and the
 * brief it follows once recognised. Frozen into the session with the agent, so
 * editing a skill later doesn't rewrite what a running session was told.
 */
export interface SkillBrief {
  id: string;
  name: string;
  /** When this skill applies — what the agent matches the job against. */
  description: string;
  instructions: string;
  /** What kind of job it belongs to, so a long menu reads as a menu. */
  group?: string;
  /** The brief is fetched when the skill is used, not carried: set for the skills in a big collection. */
  lazy?: { owner: string; /** The collection it sits in, when it came with one. */ collection?: string };
}

export interface AgentSnapshot {
  id: string;
  name: string;
  icon: string;
  color: string;
  instructions: string;
  tools: AgentTools;
  /** Skills this agent reaches for, by trigger. Empty means it has none. */
  skills?: SkillBrief[];
  /** Document skeleton this agent builds: section ids, in order. */
  model?: string;
  /** Specialists this agent may deploy on its own, frozen with it. They never carry a team of their own. */
  subagents?: AgentSnapshot[];
  version: number;
  ownerName: string;
}

/**
 * A lane is one agent with its own driver and its own control epoch. Sessions
 * always have the "main" lane; extra lanes run beside it, appending to the same
 * ordered log and writing into the same document.
 */
export const MAIN_LANE = "main";

/**
 * The most agents a session runs beside its main one, whoever brought them. Friday's own agents also count against the
 * plan's `lanes` (10 on Team), and someone's own coding tools only against this. One number, so the plan, the errors and
 * the hub's width can't disagree again (they did: Team promised 10 while every session stopped at 6).
 */
export const SESSION_LANES = 12;

/** Who may drive a lane. */
export type LaneControl =
  | { kind: "open" }
  | { kind: "role"; role: Role }
  | { kind: "people"; people: string[] }
  /** Nobody drives; the lane wakes on triggers and takes no instructions. */
  | { kind: "standing" };

/**
 * What makes a lane run without anyone instructing it.
 *
 * Every trigger is a predicate over the session log, which is why this works at
 * all: the log is the single ordered record of everything that happened, so
 * "when the document changes" and "when that lane finishes" are the same kind
 * of question asked of the same stream.
 */
export type LaneTrigger =
  /** Only runs when someone instructs it. */
  | { kind: "manual" }
  /** Wakes when another lane's run ends, which is how pipelines are built. */
  | { kind: "lane-finished"; laneId?: string }
  /** Wakes when the agent asks a human, e.g. to draft options for the answer. */
  | { kind: "question" };

export interface Lane {
  id: string;
  name: string;
  agent: AgentSnapshot | null;
  control: LaneControl;
  controlMode: ControlMode;
  trigger: LaneTrigger;
  /** Made for somebody's own coding tool, which runs on their machine: a plan's limit on Friday's agents does not count it. */
  engine?: boolean;
}

/** How hard the model thinks before answering. Maps to OpenRouter's reasoning effort. */
export type Thinking = "fast" | "balanced" | "deep";

export interface SessionOptions {
  /** Off by default: the code in front of the agent is the source of truth. */
  webSearch: boolean;
  /** The agent may read and plan, but may not change anything until the driver approves its plan. */
  planFirst: boolean;
  /** How many teammates other than the approver must sign off on the plan first. 0 is the driver's call alone. */
  signoff: number;
  /** After changing code the agent finds the project's tests and runs them. On unless turned off. */
  autoTest: boolean;
  /** A second agent reads each change for real problems before a person does, and the agent fixes what it finds. On unless turned off. */
  review: boolean;
  /**
   * Put the session's recording link in pull requests Friday opens even when the repository is public (Security APP-3):
   * anyone who can read the pull request can then read the whole session. Off unless the owner turns it on; a private
   * repository's pull requests carry the link either way.
   */
  prReplay?: boolean;
  /** A Work session: content and knowledge work rather than code (engine/work.ts). */
  work?: boolean;
  /** The team: the private session the person's AI teammates live in, one lane each (teammates.ts). */
  team?: boolean;
  thinking: Thinking;
  /**
   * Which model Friday's own agent runs. "" is the workspace default (Ling).
   * A custom agent can carry its own, but this is what the session settles on
   * — including when a shared agent's model is one this plan can't run.
   */
  model: string;
  controlMode: ControlMode;
  /** Let the agent use tools from the workspace's MCP connections. */
  mcp: boolean;
  policy: SessionPolicy;
  /**
   * Which kinds of command a teammate may approve for an agent that asks first. The driver and the owner always may.
   * Empty means only they can, which is how a session starts.
   */
  approve: { editor: CommandClass[] };
  /** Commands the driver said may run without asking again, exactly as the agent asked for them. */
  allow: string[];
  /** The custom agent running this session, or null for Friday's coding agent. */
  agent: AgentSnapshot | null;
  /** The GitHub issue this session was started from, when it was: the pull request says it closes it. */
  issue?: IssueRef;
  /** The pull request this session was started from, when it was: its checks and review comments reach the agent. */
  pr?: PrRef;
  /**
   * Kept to the people in it: off the team's overlap radar and out of the team's sessions. Said by the owner. Unset in a
   * session from before the switch existed, which then counts as private when both of its invite links are off.
   */
  private?: boolean;
}
/** A GitHub issue, by link: enough to name a branch and close it from a pull request. */
export interface IssueRef {
  url: string;
  /** owner/name */
  repo: string;
  number: number;
  title: string;
}
/** A pull request, by link: enough to switch to its branch and ask GitHub about it. */
export interface PrRef {
  url: string;
  /** owner/name */
  repo: string;
  number: number;
  title: string;
  /** The branch the change is on. */
  head: string;
}
export type SessionOptionsPatch = Partial<Omit<SessionOptions, "policy">> & { policy?: PolicyPatch };

/**
 * A coding agent CLI the user already has and is logged into. Friday never
 * holds a key for these: the CLI runs on the host's machine, under their login,
 * and a small runner relays the session to it.
 */
export type EngineTool = "claude" | "codex" | "cursor" | "copilot" | "opencode" | "gemini" | "devin" | "junie" | "kiro" | "droid" | "grok" | "cline" | "kilo" | "amp" | "muse" | "acp";

/** What a person sees about a coding tool before and after it is on their machine. Its runner side is in runner/adapters.ts. */
export interface ToolInfo {
  name: string;
  /** Whose it is, in a few words. */
  blurb: string;
  docs: string;
  /**
   * The vendor's own install line. `npm` is a package, installed the same way everywhere (and needing Node.js); otherwise one
   * line for Windows (PowerShell) and one for macOS and Linux. Friday shows the line, and runs it only when the person presses
   * Run in Terminal, in a Terminal window of their own where they see it run (runner/local-api.ts install).
   */
  install: { npm?: string; windows?: string; unix?: string };
  /** Its mark's colour where a mark is tinted (a hand-off's two ends). */
  tint: string;
  /** Where its own plan's usage is shown, when Friday can't read it on the machine. */
  usage?: string;
  /** What it runs on, said where somebody picks it: "Claude plans don't work here". */
  note?: string;
}

/**
 * Every coding tool Friday drives, in the order they are offered. Everything else reads from here — menus, the machine scan,
 * what the server accepts, and which past sessions can be continued — so taking one out switches it off everywhere at once.
 */
export const TOOL_INFO: Record<EngineTool, ToolInfo> = {
  claude: { name: "Claude Code", blurb: "Anthropic's coding agent", docs: "https://docs.claude.com/en/docs/claude-code/overview", install: { windows: "irm https://claude.ai/install.ps1 | iex", unix: "curl -fsSL https://claude.ai/install.sh | bash" }, tint: "#d97757", usage: "https://claude.ai/settings/usage" },
  codex: { name: "Codex", blurb: "OpenAI's coding agent", docs: "https://github.com/openai/codex", install: { npm: "@openai/codex" }, tint: "#7c7c86", usage: "https://chatgpt.com/codex/settings/usage" },
  cursor: {
    name: "Cursor",
    blurb: "Cursor's coding agent",
    docs: "https://cursor.com/docs/cli/installation",
    install: { windows: "irm 'https://cursor.com/install?win32=true' | iex", unix: "curl https://cursor.com/install -fsS | bash" },
    tint: "#8f8f9a",
    usage: "https://cursor.com/dashboard?tab=usage",
  },
  copilot: { name: "GitHub Copilot", blurb: "GitHub's coding agent", docs: "https://docs.github.com/en/copilot/how-tos/copilot-cli", install: { npm: "@github/copilot" }, tint: "#8957e5", usage: "https://github.com/settings/copilot/features" },
  opencode: {
    name: "OpenCode",
    blurb: "The open-source coding agent",
    docs: "https://opencode.ai/docs/",
    install: { npm: "opencode-ai" },
    tint: "#9aa0a6",
    note: "Runs on ChatGPT, GitHub Copilot or OpenCode Zen. Claude plans can't be used in it.",
  },
  gemini: { name: "Gemini CLI", blurb: "Google's coding agent", docs: "https://geminicli.com/docs/", install: { npm: "@google/gemini-cli" }, tint: "#4285f4", note: "Needs a Gemini API key, Vertex AI or Gemini Code Assist: Google AI plans moved to Antigravity." },
  devin: {
    name: "Devin",
    blurb: "Cognition's coding agent",
    docs: "https://docs.devin.ai/cli",
    install: { windows: "irm https://static.devin.ai/cli/setup.ps1 | iex", unix: "curl -fsSL https://cli.devin.ai/install.sh | bash" },
    tint: "#2ec4b6",
    usage: "https://app.devin.ai/settings/usage",
  },
  junie: {
    name: "Junie",
    blurb: "JetBrains' coding agent",
    docs: "https://junie.jetbrains.com/docs/",
    install: { windows: "irm https://junie.jetbrains.com/install.ps1 | iex", unix: "curl -fsSL https://junie.jetbrains.com/install.sh | bash" },
    tint: "#47e054",
    usage: "https://account.jetbrains.com/licenses",
  },
  kiro: {
    name: "Kiro",
    blurb: "AWS's coding agent",
    docs: "https://kiro.dev/docs/cli/",
    install: { windows: "irm 'https://cli.kiro.dev/install.ps1' | iex", unix: "curl -fsSL https://cli.kiro.dev/install | bash" },
    tint: "#9046ff",
    usage: "https://app.kiro.dev/account/usage",
  },
  droid: {
    name: "Factory Droid",
    blurb: "Factory's coding agent",
    docs: "https://docs.factory.com/docs/droid-cli/quickstart",
    install: { windows: "irm https://app.factory.ai/cli/windows | iex", unix: "curl -fsSL https://app.factory.ai/cli | sh" },
    tint: "#f97316",
    usage: "https://app.factory.ai/settings/billing",
  },
  grok: { name: "Grok Build", blurb: "xAI's coding agent", docs: "https://docs.x.ai/build/overview", install: { windows: "irm https://x.ai/cli/install.ps1 | iex", unix: "curl -fsSL https://x.ai/cli/install.sh | bash" }, tint: "#a1a1aa", usage: "https://grok.com/settings" },
  cline: { name: "Cline", blurb: "The open-source coding agent from Cline", docs: "https://docs.cline.bot/cli/cli-reference", install: { npm: "cline" }, tint: "#e5e5e5" },
  kilo: { name: "Kilo", blurb: "Kilo Code's coding agent", docs: "https://kilo.ai/docs/cli", install: { npm: "@kilocode/cli" }, tint: "#f8f675", note: "Runs on ChatGPT, SuperGrok or Kilo credits. Claude plans can't be used in it." },
  amp: {
    name: "Amp",
    blurb: "Amp's coding agent",
    docs: "https://ampcode.com/manual",
    install: { npm: "@ampcode/cli" },
    tint: "#f34e3f",
    usage: "https://ampcode.com/settings",
    note: "Runs only in Auto: it doesn't ask before it acts.",
  },
  // Meta's coding agent, over its own protocol (runner/adapters.ts muse). It doesn't run on Windows outside WSL.
  muse: {
    name: "Muse Code",
    blurb: "Meta's coding agent",
    docs: "https://dev.meta.ai/docs/muse-code",
    install: { windows: "irm https://dev.meta.ai/install.ps1 | iex", unix: "curl -fsSL https://dev.meta.ai/install.sh | sh" },
    tint: "#0866ff",
    note: "macOS and Linux; on Windows, inside WSL.",
  },
  // Any other agent in the ACP registry (Qwen Code, goose, Mistral Vibe, Auggie, Kimi...), by the command somebody sets on their computer.
  acp: {
    name: "Other ACP agent",
    blurb: "Any coding agent that speaks ACP",
    docs: "https://agentclientprotocol.com/get-started/agents",
    install: {},
    tint: "#8f8f9a",
    note: "Set its command on this computer: qwen --acp, goose acp, vibe-acp, or any other agent in the ACP registry.",
  },
};

export const ENGINE_TOOLS = Object.keys(TOOL_INFO) as EngineTool[];
export const ENGINE_NAMES = Object.fromEntries(ENGINE_TOOLS.map((t) => [t, TOOL_INFO[t].name])) as Record<EngineTool, string>;
/**
 * What to call whatever is attached to a lane.
 *
 * A folder lent without a CLI has no product name, and calling it one would be
 * a lie in the one place people look to find out what is running their code.
 */
export const engineName = (tool?: EngineTool): string => (tool ? ENGINE_NAMES[tool] : "folder");
/** The coding tools said as a list that keeps up with ENGINE_TOOLS and stays readable: "Claude Code, Codex, Cursor, GitHub Copilot or 10 more". */
export const toolList = (last: "and" | "or" = "or"): string => {
  const names = ENGINE_TOOLS.map((t) => ENGINE_NAMES[t]);
  if (names.length > 5) return `${names.slice(0, 4).join(", ")} ${last} ${names.length - 4} more`;
  return `${names.slice(0, -1).join(", ")} ${last} ${names.at(-1)}`;
};
/**
 * What a CLI's own conversation id looks like, checked wherever one arrives from elsewhere: it goes on that CLI's command line
 * and into a path. Never starting with a dash, which `--resume <id>` would read as a flag of its own.
 */
export const CLI_ID = /^[A-Za-z0-9][\w-]{0,127}$/;

/**
 * How much the host lets the CLI do unattended. Nobody can approve a prompt on
 * someone else's laptop mid-run, so this is decided up front by the host.
 * "plan": read and propose only. "edits" (shown as Manual): change files, and
 * ask before running anything. "full" (shown as Auto): edits and shell commands
 * with nobody asked.
 */
export type EngineMode = "plan" | "edits" | "full";

/**
 * One question, or one change, asked of the folder a connected machine has
 * open. Friday's own agent has never seen those files, so everything it does
 * to a repository goes down this one channel -- and the machine answering it
 * refuses anything past the mode its host chose.
 */
export interface RepoCall {
  /** `commands`: the `/` commands the lane's own coding tool answers to (see ToolCommand). */
  /** `apply`: a separate copy's work, brought into the folder it was copied from. */
  /** `terminal`: the line that carries the lane's conversation on in the person's own terminal (terminal-line.ts); with `query` "closed", that it is back. */
  op: "tree" | "read" | "search" | "write" | "edit" | "shell" | "checkpoint" | "restore" | "commit" | "publish" | "remote" | "branches" | "switch" | "prcomments" | "prstatus" | "prchecks" | "preview" | "ios" | "environment" | "context" | "bgstart" | "bgread" | "bgstop" | "diff" | "commands" | "apply" | "status" | "log" | "show" | "gitdiff" | "stage" | "unstage" | "discard" | "hunk" | "pull" | "compare" | "terminal";
  /** For `stage`, `unstage` and `discard`: the files. */
  paths?: string[];
  /** For `hunk`: one hunk as a unified diff with its file header, applied to the index (`cached`) or taken back (`reverse`). */
  patch?: string;
  cached?: boolean;
  reverse?: boolean;
  /** For `log`: how many commits. */
  limit?: number;
  /** For `gitdiff`: the index against HEAD (staged) rather than the working files against the index. */
  staged?: boolean;
  /** For `discard`: untracked files among `paths` are deleted too. */
  untracked?: boolean;
  /** For `restore`: the checkpoint to put the folder back to. */
  ref?: string;
  /** For `restore`: where the run left the folder, so only what it changed is put back. */
  until?: string;
  /** For `commit`: the message. For `publish`: the pull request's title and body. */
  message?: string;
  /** For `publish`: the branch the pull request merges into, when not the default one (a stacked pull request). */
  base?: string;
  /** The folder to act in, when not the lane's own: one of the folders the agent also works in. The runner refuses any other. */
  dir?: string;
  /** For `commit` and `switch`: the branch, created if it doesn't exist. */
  branch?: string;
  /** For `switch`: refuse if the branch is already there, rather than moving to it. */
  create?: boolean;
  /** For `commit`: the paths to record, when the whole folder isn't what is wanted. */
  only?: string[];
  /** For `publish`: open a pull request after pushing. */
  pr?: boolean;
  path?: string;
  /** For `bgread` and `bgstop`: which background command, by id. */
  query?: string;
  offset?: number;
  /** For `read`: the file exactly as it is, no line numbers or header — what an editor needs. */
  raw?: boolean;
  /**
   * For `read`: the host asked, through the file view, about their own machine's file, not an agent: they see a .env as
   * it is. Everyone else, and every agent, only ever sees which variables it sets (see hub.readRepo).
   */
  person?: boolean;
  /**
   * Who that person is. `person` reaches a machine only when this is its host: a .env's values are the host's own, and
   * an editor reading it on somebody else's machine sees its names only. Never sent to a machine.
   */
  personId?: string;
  content?: string;
  find?: string;
  command?: string;
  /**
   * For `shell`, `bgstart` and `preview` on a Manual machine: a person said yes to this exact command; for `publish`: a
   * person pressed the push. Set by the session's own agent after a yes, and by the session's commit and run commands,
   * which only a person can send.
   */
  approved?: boolean;
  /**
   * Who said yes (a person's id). On a machine someone attached, `approved` counts only when this is that machine's host:
   * the host's Manual is theirs to say yes for, not the driver's or an owner's (see hub.readRepo). Uploads ignore it.
   */
  approvedBy?: string;
  /** For `shell`: how long it may run, in seconds. Two minutes when absent; the machine holds it to between 10 and 600. */
  timeoutSec?: number;
}

/**
 * Models each CLI offers, as starting points rather than a closed list: they
 * change faster than Friday does, and every one of these tools accepts a model
 * name we've never heard of — so the UI suggests these and lets people type any
 * other. They run on that CLI's own account, not on anything Friday pays for.
 */
export interface EngineModelInfo {
  /** What the CLI is given as `--model`. */
  id: string;
  label: string;
  /** One line on what it is for. */
  blurb: string;
  /** A heading to list it under, when the list is long enough to want one. */
  group?: string;
}

/**
 * The models each CLI offers, with what each is for.
 *
 * Each id is what that CLI accepts after `--model`, taken from that CLI's own
 * documentation (checked October 2026). Claude Code takes aliases that follow
 * its newest of each family, and full model names for a specific version.
 * Codex takes the model's own name. Cursor's list is long and per-account, so
 * the pill reads it from the installed `cursor-agent` and this is only what is
 * shown before it has. Copilot's depends on the plan, so it starts at Auto too. A model not listed is still welcome: the picker lets
 * people type any id their CLI knows, and an empty choice is the CLI's default.
 */
export const ENGINE_MODEL_INFO: Record<EngineTool, EngineModelInfo[]> = {
  // As Claude Code's own model menu lists them (October 2026): the four latest by alias, then the earlier versions it still runs.
  claude: [
    // Friday picks for each message (routing.ts): Haiku, Sonnet or Opus, from how hard it reads and how much of the limits is left.
    // "Smart", not "Auto": beside the Auto mode pill, "Claude Code · Auto" read as two of one thing (Arun, 2026-10-28: "iron
    // everything and ensure we are good").
    { group: "Smart routing", id: "auto", label: "Smart", blurb: "Haiku, Sonnet or Opus, picked for each message" },
    { group: "Latest", id: "opus", label: "Opus 5.5", blurb: "Complex reasoning and big pieces of work." },
    { group: "Latest", id: "fable", label: "Fable 5.1", blurb: "Most capable. For the longest, hardest tasks." },
    { group: "Latest", id: "sonnet", label: "Sonnet 5.5", blurb: "Everyday work at a good pace." },
    { group: "Latest", id: "haiku", label: "Haiku 5.5", blurb: "Fast and light, for simple tasks." },
    { group: "More models", id: "claude-haiku-4-5", label: "Haiku 4.5", blurb: "claude-haiku-4-5" },
    { group: "More models", id: "claude-sonnet-5", label: "Sonnet 5", blurb: "claude-sonnet-5" },
    { group: "More models", id: "claude-opus-5", label: "Opus 5", blurb: "claude-opus-5" },
    { group: "More models", id: "claude-fable-5", label: "Fable 5", blurb: "claude-fable-5" },
    { group: "More models", id: "claude-opus-4-8", label: "Opus 4.8", blurb: "claude-opus-4-8" },
    { group: "More models", id: "claude-opus-4-7", label: "Opus 4.7", blurb: "claude-opus-4-7" },
    { group: "More models", id: "claude-opus-4-6", label: "Opus 4.6", blurb: "claude-opus-4-6" },
    { group: "More models", id: "claude-sonnet-4-6", label: "Sonnet 4.6", blurb: "claude-sonnet-4-6" },
  ],
  codex: [
    { group: "Smart routing", id: "auto", label: "Smart", blurb: "Luna or Sol, picked for each message" },
    { group: "Models", id: "gpt-6.1-sol", label: "GPT-6.1 Sol", blurb: "Codex's recommended model: near-Astra work at lower cost." },
    { group: "Models", id: "gpt-6-astra", label: "GPT-6 Astra", blurb: "Most capable, for complex work across code, apps and research." },
    { group: "Models", id: "gpt-6-luna", label: "GPT-6 Luna", blurb: "Most efficient, for focused, high-volume tasks." },
    { group: "Models", id: "gpt-5.5", label: "GPT-5.5", blurb: "Previous generation. Retires October 14, 2026." },
  ],
  cursor: [{ id: "auto", label: "Auto", blurb: "Cursor picks a model for each task." }],
  copilot: [{ id: "auto", label: "Auto", blurb: "Copilot picks a model for each task." }],
  // The rest take whatever model name their own docs give, typed in the picker: their lists depend on the account.
  opencode: [],
  gemini: [],
  devin: [],
  junie: [],
  kiro: [],
  droid: [],
  grok: [],
  cline: [],
  kilo: [],
  // Muse Code's own default model unless one is typed: its list depends on the account.
  muse: [],
  // Amp picks its own models for each of its modes; the mode is what is chosen.
  amp: [
    { id: "medium", label: "Medium", blurb: "Amp's everyday mode." },
    { id: "low", label: "Low", blurb: "Quicker and lighter, for small tasks." },
    { id: "high", label: "High", blurb: "More reasoning, for harder work." },
    { id: "ultra", label: "Ultra", blurb: "Its strongest, for the hardest tasks." },
  ],
  acp: [],
};

/**
 * How hard a coding tool thinks, pinned per lane by whoever can steer it (`lane.effort`). Auto, the default, is no value at all:
 * no flag is passed, and the tool's own default or the router's pick applies. "xhigh" is shown as "Extra".
 */
export type EngineEffort = "low" | "medium" | "high" | "xhigh" | "max";
export const ENGINE_EFFORTS: readonly EngineEffort[] = ["low", "medium", "high", "xhigh", "max"];
export const ENGINE_EFFORT_INFO: Record<EngineEffort, { label: string; blurb: string }> = {
  low: { label: "Low", blurb: "Quick answers, for small and clear tasks." },
  medium: { label: "Medium", blurb: "A balance of speed and depth." },
  high: { label: "High", blurb: "Thinks longer, for harder changes." },
  xhigh: { label: "Extra", blurb: "Deeper still, for tricky bugs and designs." },
  max: { label: "Max", blurb: "Its most thorough, and the slowest and costliest." },
};

/**
 * The effort levels each tool takes, as checked on a real install (October 2026): Claude Code's `--effort` (2.1.251), Codex's
 * `model_reasoning_effort` (per turn over its app-server, `-c` for `codex exec`), Copilot's `--reasoning-effort` (1.0.95). The
 * rest have no such control, so nothing is guessed for them. The composer's effort pill offers these and no others.
 */
export const EFFORT_LEVELS: Partial<Record<EngineTool, readonly EngineEffort[]>> = { claude: ENGINE_EFFORTS, codex: ENGINE_EFFORTS, copilot: ENGINE_EFFORTS };

/**
 * The effort levels a lane's tool takes: those checked for it (EFFORT_LEVELS), or for another tool spoken to over ACP, those its own
 * `thought_level` option offers (EngineInfo.efforts; Arun, 2026-10-19: the tools as capable in Friday as on their own).
 */
export const effortLevelsOf = (e: { tool?: EngineTool; efforts?: readonly EngineEffort[] } | undefined): readonly EngineEffort[] =>
  (e?.tool && EFFORT_LEVELS[e.tool]) || (e?.tool ? e.efforts : undefined) || [];

/** Said where a lane's pin was dropped because a different tool, or somebody else's computer, took the lane over. */
export const EFFORT_RESET_NOTE = "Effort reset to Auto (different tool or host)";

export const isEngineEffort = (v: unknown): v is EngineEffort => typeof v === "string" && (ENGINE_EFFORTS as readonly string[]).includes(v);

/** The timeline's line for a `lane.effort`: "Ana set Claude Code effort to High, from the next message". */
export function effortNote(who: string, tool: EngineTool | undefined, effort: EngineEffort | null, running?: boolean): string {
  const level = effort ? ENGINE_EFFORT_INFO[effort].label : "Auto";
  return `${who} set ${tool ? ENGINE_NAMES[tool] : "the agent's"} effort to ${level}, from the next message${running ? " (after the current turn)" : ""}`;
}

/** Just the ids, for anything that only needs to know what is accepted. */
export const ENGINE_MODELS = Object.fromEntries(ENGINE_TOOLS.map((t) => [t, ENGINE_MODEL_INFO[t].map((m) => m.id)])) as Record<EngineTool, string[]>;

/**
 * Whether a lane with no machine of its own may send its folder calls to this one. A folder lent to the session (no coding
 * tool) is shared. A coding tool's machine is its host's own: it answers only when its host drives the lane asking, so a
 * teammate's commands, edits and commits never land on it. hub.readRepo, repoWhere and the tool list all follow this.
 */
export function mayBorrow(s: { driver: { id: string } | null; laneDrivers: Record<string, { id: string } | null> }, lane: string, e: { tool?: EngineTool; hostId: string }): boolean {
  return !e.tool || e.hostId === (lane === MAIN_LANE ? s.driver : s.laneDrivers[lane])?.id;
}

/** Why a yes to a command on somebody else's Manual machine doesn't count: only its host may give it. */
export function hostOnlyYes(host: string): string {
  return `${host}'s computer is in Manual, so only ${host} can say yes to commands on it. Ask ${host}, or ${host} can switch it to Auto.`;
}

/** The connected machine a lane's folder calls go to: its own, otherwise the first it may borrow, in the session's order. */
export function liveMachine<E extends { tool?: EngineTool; hostId: string; online: boolean }>(
  s: { engines: Record<string, E>; driver: { id: string } | null; laneDrivers: Record<string, { id: string } | null> },
  lane: string = MAIN_LANE,
): E | undefined {
  const own = s.engines[lane];
  return own?.online ? own : Object.values(s.engines).find((e) => e.online && mayBorrow(s, lane, e));
}

export interface EngineInfo {
  /**
   * Works in a folder another agent here edits too, by choice: one writer per folder doesn't hold either back (EngineHub.attach).
   * Friday made a separate copy for each extra agent by itself, and folders of copies piled up (Arun, 2026-10-24: "fix logic where
   * the agents won't create a folder unless told to do so", meaning a copy only when asked).
   */
  shared?: true;
  /**
   * The CLI running this lane — absent when a folder is attached without one.
   *
   * A machine can join a session just to lend its folder: Friday's own agent
   * then reads, edits and runs commands there through the same bridge, and the
   * files, terminal and preview panels work exactly as they do for a CLI. The
   * difference is who does the thinking, so it is the one thing recorded here.
   */
  tool?: EngineTool;
  hostId: string;
  hostName: string;
  /** Folder the CLI runs in, on the host's machine. Shown so people know where changes land. */
  cwd: string;
  /** The folder `cwd` is a separate copy of: the agent works there, and Apply brings its work back here. */
  copyOf?: string;
  /**
   * Where it writes, for "one writer per folder": the git repository `cwd` is in, or `cwd` itself outside one, with its links
   * resolved on the host's machine. Absent from older runners, which are compared by `cwd`.
   */
  root?: string;
  /** The host's platform, which says whether its paths differ by case. */
  os?: string;
  /** Which machine that is, when someone has more than one. */
  machine?: string;
  /** The shell commands run in there ("sh", "git-bash" or "powershell"), so the agent writes them in its syntax. Absent from older runners. */
  shell?: string;
  /**
   * The effort levels a tool spoken to over ACP said its own `thought_level` option offers, as its runner remembered them from its
   * last conversation: what the effort pill offers for it (see effortLevelsOf). Absent for the tools whose levels Friday knows.
   */
  efforts?: EngineEffort[];
  /** One of that CLI's own models, when the host picked one. */
  model?: string;
  /**
   * Which of the tool's accounts on the host's computer it runs as, when it has more than one there (runner/accounts.ts): Claude
   * Code's work and personal sign-ins, two Codex accounts. Absent: its only one.
   */
  account?: { id: string; label: string };
  /**
   * "api": its tool runs on an API key or a cloud provider its host set up (runner/api-key.ts), which the host may let a session
   * share. Absent: on its host's own plan (Claude Free, Pro or Max; ChatGPT; the others'), so it takes its host's work alone
   * (own-plan.ts). An older runner that doesn't say is taken as a personal plan.
   */
  apiKey?: true;
  branch?: string;
  mode: EngineMode;
  /**
   * The mode its host picked by hand, when `mode` was chosen automatically for the host's own next piece of work (smartReach.ts).
   * Only the host's turn runs in `mode`: anyone else's (a teammate, a hand-off, another agent) is held to this. Absent: hand-picked.
   */
  handMode?: EngineMode;
  /** The repo the lane was set up for, so another computer can clone it first. */
  repo?: string;
  /**
   * An existing conversation in the host's own CLI that this lane continues,
   * so the agent keeps the context and memory it already had.
   */
  resumedFrom?: { id: string; title: string; messages: number };
  /** The server process holding the runner's socket, so a lane left "online" by one that died can be told apart from a live one. */
  node?: string;
}

/**
 * Work passed from one agent to another, and why.
 *
 * A handoff is an instruction to the receiving agent — it queues, is delivered
 * and is answered exactly like one — that also says where it came from, the
 * reason it moved, and what the first agent had already established. The
 * receiving agent starts from that instead of from nothing, and the room can
 * see why the work changed hands.
 */
export interface Handoff {
  fromLane: string;
  fromName: string;
  toName: string;
  reason: string;
  /** What came along: findings, files, the failing test. Short lines. */
  carried: string[];
}

/**
 * Where a message from another session came from (peers.ts).
 *
 * Sessions in a workspace talk to each other through their agents: one tells another what it changed, found or needs. The
 * message arrives as an instruction carrying this, so it queues and is delivered like any other, and the receiving agent is
 * told it is information from another agent, not a request from the people in its own session.
 */
export interface PeerNote {
  fromSid: string;
  fromTitle: string;
  fromLane: string;
  /** The agent that wrote it, as its session shows it. */
  fromName: string;
  /** The person that agent was working for: what they could do in this session is all the message may do. */
  by: { id: string; name: string };
  /** Who let it through, when it waited for someone here to say yes. */
  approvedBy?: string;
  /** How many agent-to-agent steps led to it, counted across sessions: the turn it starts goes on from there (agent-mesh behindRun). */
  hop?: number;
}

/**
 * A message from another agent in this same session (agent-mesh.ts): Claude Code telling Codex what it changed, asking it
 * something and waiting, or the answer coming back after the asker stopped waiting. It arrives as an instruction carrying this,
 * so it queues and wakes the agent like any other, and the receiving agent is told who it is from (Arun, 2026-10-19: the coding
 * tools in a session talking to each other).
 */
/**
 * What the team did while the person was away, for the morning brief (team.brief) and the "Since you left" card (GET
 * /api/teammates/since). Each line names the teammate by its Team room lane and name; `sid` is the session it happened in when
 * that isn't the Team room (one of its rooms), and `seq` the message there to jump to.
 */
export interface TeamBrief {
  since: number;
  until: number;
  /** Work finished: a board task done, or a turn that ended with a result. Its files changed, and a pull request it opened. */
  done: { lane: string; name: string; title: string; files?: string[]; pr?: string; sid?: string; seq?: number }[];
  /** Work that stopped short: a board task blocked or dropped, or a turn that ended on an error. */
  failed: { lane: string; name: string; title: string; why: string; sid?: string; seq?: number }[];
  /** What waits on the person: a question asked of them and not answered. */
  waiting: { lane: string; name: string; text: string; seq: number; sid?: string }[];
  /** What a teammate decided for itself while the person was away, and noted (write_note "assumption: …"). */
  assumptions: { lane: string; name: string; text: string; seq: number; sid?: string }[];
  /** Each teammate's turns, minutes working and tokens (where its tool said) over the stretch. */
  usage: { lane: string; name: string; turns: number; minutes: number; tokens?: number }[];
  /**
   * A team workflow's run, when the brief is one's (team-workflows.ts): which, how it ended, and what it came to (Arun,
   * 2026-10-28: "make the automation for the teams platform different…").
   */
  workflow?: { id: string; name: string; run: string; status: "done" | "failed"; result?: string };
}

export interface MeshNote {
  id: string;
  /** A board task's title alone (the instruction's text leads with it), for the page to show without the brief. */
  title?: string;
  /**
   * `ask`: the sender waits for the answer (mesh.replied). `reply`: an answer that came after the asker stopped waiting.
   * `task`: work the session's lead assigned; what the agent says at the end of it goes back to the lead as a `reply`.
   */
  kind: "tell" | "ask" | "reply" | "task";
  /** A reply that is the report on a task, not the answer to a question. */
  ofTask?: boolean;
  /** The lead's reports handed together: `done` when every task it assigned is, `early` when one was blocked or failed. */
  batch?: "done" | "early";
  /** A task from the shared board (board.posted), by its id: the board, not an ask, keeps where it stands. */
  board?: string;
  /** That board task is to be checked, not done: the agent reviews another's work on it. */
  review?: boolean;
  /** The lane that ran out of usage partway through this task, when Friday handed it on (agent-mesh carryOn). */
  carriedFrom?: string;
  /** One message to several agents at once (message_team): the same id on each, so it counts once toward what a run may send. */
  team?: string;
  fromLane: string;
  fromName: string;
  toName: string;
  /** The ask a reply answers. */
  re?: string;
  /** How many agent-to-agent steps led here: a person's message is 0, a message from a run that a message started is one more. */
  hop: number;
  /** The person the sending agent was working for: what they could do here is all the message may do. */
  by: { id: string; name: string } | null;
}

/** A task as it is posted to the board. */
export interface BoardTaskDef {
  id: string;
  title: string;
  /** What to do and what done looks like. */
  detail: string;
  /** Files or folders it owns: nobody else's task edits them. */
  owns: string[];
  /** Ids of tasks it waits on. */
  after: string[];
  /** An agent it suits, by name, if the poster has one in mind. */
  agent?: string;
  /** A command that proves it works ("npm test -- api"), run when it is done; the board's check otherwise. */
  check?: string;
}

/**
 * One task of a hub (hubs.ts): a piece of the work one agent does by itself in its own copy of the folder. The files it owns no
 * other task touches, so the copies come back together; what it depends on runs first.
 */
export interface HubTask {
  id: string;
  title: string;
  instruction: string;
  files: string[];
  dependsOn: string[];
  tier: RouteTier;
  /** A command that proves it done, run in its copy; none when the planner had none to give. */
  check?: string;
  /** The coding tool it runs on: the router's pick, or the person's. */
  tool?: EngineTool;
}

/** Where a session's hub stands, folded from its events. */
export interface HubState {
  id: string;
  goal: string;
  status: "planned" | "running" | "merging" | "done" | "failed" | "cancelled";
  /** How many tasks run at once. */
  width: number;
  tasks: HubTask[];
  /** The coding tools on the machine that could take a task, for the card's choice. */
  tools: EngineTool[];
  runs: Record<string, { status: "waiting" | "running" | "done" | "failed" | "skipped"; lane?: string; attempt: number; grade?: number; tests?: "pass" | "fail" | "none"; summary?: string; files?: number }>;
  prUrl?: string;
  sha?: string;
  why?: string;
}

/** One problem a second agent found in a change, before any person read it. */
export interface ReviewFinding {
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  path?: string;
  line?: number;
}

export interface DiffFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  /** A renamed file's old path, which a commit of the rename has to take too. */
  from?: string;
  additions: number;
  deletions: number;
  /** Unified diff for this file, possibly cut short. */
  patch: string;
  truncated?: boolean;
  /** The folder this file is in, when it isn't the lane's own: one of the folders the agent also works in (multi-repo, tier 2). */
  repo?: string;
  /**
   * The seq of the logged change set holding this patch's text, when it is the same as one logged before (session/patches.ts):
   * the log keeps each patch once, and this one is written as a reference to it, empty, and filled back in as it is read.
   */
  at?: number;
  /** Its text left on the server (an older change set, sent to a page without it): the seq to ask for it by, when opened. */
  later?: number;
}

export interface Attachment {
  id: string;
  name: string;
  type: string;
  size: number;
}

export interface ActorRef {
  id: string;
  name: string;
  kind: "human" | "agent" | "system";
  /**
   * A person's command sent by an agent outside Friday on their behalf (Claude Code, Codex, Cursor over Friday's MCP server,
   * outside-agents.ts), by that agent's name, so the session shows who started what. Only the server sets it.
   */
  via?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string exactly as the model produced it. */
  arguments: string;
}

/** How hard a task reads to the router (routing.ts). */
export type RouteTier = "light" | "standard" | "heavy";

export type EventBody =
  /**
   * `workspaceId` says whose this session is: who may open it, whose plan sets
   * its limits, and which workspace its model use is charged to. Absent on
   * sessions written before workspaces existed.
   */
  | { type: "session.created"; title: string; ownerId: string; ownerName: string; workspaceId?: string; options?: SessionOptionsPatch }
  | { type: "session.updated"; options: SessionOptionsPatch; title?: string }
  /** A teammate's redirect put aside without being sent: by its author, the person driving that agent, or an owner. */
  | { type: "suggestion.dismissed"; seq: number }
  /** An instruction taken back before the agent read it: it leaves the queue, and the feed says so. */
  | { type: "instruction.withdrawn"; seq: number; /** Taken back to be changed and sent again (a teammate's Edit): the feed leaves it out. */ toEdit?: true }
  /** A queued message a coding tool won't take: it runs on its host's own plan, and this is somebody else's work (own-plan.ts). Out of the queue, with why. */
  | { type: "instruction.refused"; seq: number; why: string }
  /** The driver approved the plan a lane proposed; its editing and running tools come back. */
  | { type: "plan.approved"; /** Set when the approver changed the plan: the version that was approved. */ steps?: string[] }
  /** A teammate's verdict on the plan in front of the room: it is fine, or it needs changing first. */
  | { type: "plan.reviewed"; verdict: "approve" | "changes"; note?: string }
  /** Reviewers' comments on the pull request, passed to the agent. `ids` are what has been handed over already. */
  /** Review comments read from the pull request: `count` passed to the agent, `held` not (their authors can't write to the repo). */
  | { type: "pr.feedback"; prUrl: string; ids: string[]; count: number; held?: number }
  /** A second agent started reading the change a run made (`runSeq` is that run's `run.ended`). */
  /** A second opinion on a turn (aside.ts): a person's question about the turn that ended at `anchor`, to a model of their choosing. */
  | { type: "aside.asked"; id: string; anchor: number; text: string; model: string; modelName: string }
  | { type: "aside.answered"; id: string; text: string; model: string; error?: string }
  | { type: "review.started"; runSeq: number; round: number }
  /** What it found. `sent` when the findings went back to the agent to fix; otherwise they are left for the person. */
  | { type: "review.done"; runSeq: number; round: number; findings: ReviewFinding[]; sent: boolean; error?: string }
  /** A person handed the pull request to Friday to see through to merge, or took it back. */
  | { type: "pr.shepherd"; on: boolean; prUrl: string }
  /** One thing Friday did on the way: handed over the checks or comments, pushed a fix, asked for review again. */
  | { type: "pr.shepherd.step"; step: "checks" | "comments" | "pushed" | "rerequested"; text: string; sha?: string; count?: number; /** For comments: who wrote them, to ask again once they are addressed. */ who?: string[] }
  /** Friday stopped: merged, closed, or a person is needed. */
  | { type: "pr.shepherd.ended"; outcome: "merged" | "closed" | "stopped"; text: string }
  /** A file or folder the team keeps in front of the agent at the start of every run. */
  | { type: "pin.added"; path: string }
  | { type: "pin.removed"; path: string }
  // A lane added to (or removed from) the session. The "main" lane always
  // exists and is never in this list.
  | { type: "lane.added"; lane: Lane }
  // A whole pipeline at once. One event rather than several lane.added, so a
  // crew either arrives complete or not at all — a half-applied pipeline has
  // stages waiting on lanes that were never created.
  | { type: "crew.applied"; crewId: string; name: string; lanes: Lane[] }
  | { type: "lane.removed"; laneId: string }
  /**
   * One agent leads the others: it can assign them work (assign_task) and gets each one's report back when it is done; null,
   * none does (Arun, 2026-10-19: "have a coding tool or agent be the boss and orchestrate the other agents").
   */
  | { type: "lead.set"; lane: string | null; /** Friday picked it as the agents changed (a room made, a lead removed), not a person. */ auto?: true }
  /**
   * A coding tool asked to show a page it started in the session's Preview panel (the friday MCP tool show_preview), or the
   * folder's iOS app: every open page of the session opens it, as Friday Code's own show_preview does.
   */
  | { type: "preview.asked"; url?: string; ios?: boolean; /** A tab of its own, rather than the one already on that server or a free one. */ newTab?: boolean; /** For the iOS app: the folder its Xcode project is in, when it isn't the agent's own (show_preview `folder`). */ folder?: string }
  /**
   * The shared task board (board.ts): a plan of tasks with the files each owns and what each waits on, posted by an agent (the
   * lead, when there is one). Agents claim ready tasks themselves, idle ones are handed them, a finished task unlocks what waits
   * on it and is checked by another agent before it counts (Arun, 2026-10-19: "a shared task board… and peer review").
   */
  | { type: "board.posted"; fromLane: string; fromName: string; tasks: BoardTaskDef[]; /** What proves a task works, run in its agent's folder when it is done (each task's own `check` first). */ check?: string }
  | { type: "board.claimed"; id: string; lane: string; name: string; /** Why this agent, when the board picked it: "best at tests here", "the others are nearly out of usage". */ why?: string }
  | { type: "board.finished"; id: string; lane: string; name: string; status: "done" | "blocked"; report: string }
  | { type: "board.review"; id: string; lane: string; name: string }
  | { type: "board.reviewed"; id: string; lane: string; name: string; ok: boolean; note: string }
  /**
   * A finished task's checks, run by Friday in its agent's folder before anyone reviews it (Arun, 2026-10-19: "find gaps and
   * see how we can improve"): started, then how they went. Failed, the task goes back to its agent with the output.
   */
  | { type: "board.checking"; id: string; lane: string; command: string }
  | { type: "board.checked"; id: string; lane: string; command: string; ok: boolean; output: string; /** It couldn't be run there (a Manual machine, no shell): neither passed nor failed. */ skipped?: boolean }
  /** A person's say over a task from the team's list: taken back to be handed to someone else, opened again, or dropped. */
  | { type: "board.released"; id: string; why: string; /** Who it should go to next, when a person picked. */ to?: string; /** The agent that turned it down: not offered to it again. */ declined?: string }
  | { type: "board.cancelled"; id: string }
  /** An agent given a name of its own ("Reviewer" for the second Claude Code); the main lane's too. */
  | { type: "lane.renamed"; laneId: string; name: string }
  /**
   * The effort level this lane's coding tool runs at from its next message, set by someone who can steer it; null is Auto. Kept
   * per lane outside its engine (an attach replaces that), and read as each turn is built: a turn already running keeps its own.
   * `tool`, and `running` (said while a turn was under way), are for the timeline's line.
   */
  | { type: "lane.effort"; effort: EngineEffort | null; tool?: EngineTool; running?: boolean }
  /**
   * The lane's coding tool opened in its host's own terminal, on the lane's conversation (`open`), or back (terminal-line.ts).
   * While it is open the lane takes no turns: what is sent to it waits, and runs once it is back, where the terminal left it.
   */
  | { type: "lane.terminal"; open: boolean }
  /**
   * Whether anyone else's message may run this lane's coding tool in Full on its host's computer (Security R2). Off, the
   * default: a teammate's, a hand-off's or an app's turn runs no further than Edits. Only the host turns it on.
   */
  | { type: "lane.othersFull"; on: boolean }
  /** The lane's coding tool turned its effort flag away (an older version): that turn ran again without it, at its default. */
  | { type: "effort.skipped"; effort: EngineEffort; tool?: EngineTool }
  /**
   * The lane's coding tool ran out of usage on one of its host's accounts and carries on, on the same conversation, as another
   * (runner/accounts.ts). `until`: when the first comes back, in ms, when it said.
   */
  | { type: "account.switched"; from: { id: string; label: string }; to: { id: string; label: string }; until?: number; tool?: EngineTool }
  | { type: "member.joined"; role: Role }
  | { type: "member.role_changed"; userId: string; name: string; role: Role }
  | { type: "member.removed"; userId: string; name: string }
  | { type: "link.updated"; role: LinkRole; enabled: boolean; version: number }
  // Human → agent. Only the driver can append these.
  | { type: "instruction"; text: string; interrupt: boolean; /** The people it @-mentions, by id (mentions.ts). */ mentions?: string[]; fromSuggestion?: number; attachments?: Attachment[]; handoff?: Handoff; /** A message from another session's agent (peers.ts). */ peer?: PeerNote; /** A message from another agent in this session (agent-mesh.ts). */ mesh?: MeshNote; /** Answers an `engine.approval`: the driver said yes or no to it. */ approval?: { id: string; approve: boolean }; /** An edit of a message still queued: this one takes its place in the queue, and that one is taken back. */ replaces?: number; /** Friday telling a coding tool whose turn ended short of its task to carry on (keep-going.ts). */ keepGoing?: true; /** A reply in a side thread on an earlier message (by its seq): its answer stays in the thread, not the room's main flow. */ thread?: { root: number }; /** Posted by an app on the person's behalf (Friday's token API or MCP, `sessions:write`), not typed by them: capped like a teammate's (Security R3). */ via?: "api"; /** Friday's own message carrying on what agents set going (a wake, a carry-on): how many agent-to-agent steps led to it, so the turn it starts counts on from there rather than from nothing (agent-mesh behindRun). */ hop?: number; /** A turn of its own: never handed to a turn under way, since its answer is read from the turn it starts. */ ownTurn?: true }
  /**
   * An agent in Manual mode wants to do something it may not do unasked.
   *
   * `commands`: these exact commands, which the agent can then be allowed to run. `turn`: a coding tool that cannot
   * ask one command at a time (Codex, Cursor) was stopped from changing things, and approving lets it try the turn
   * again with write access. Answered by an instruction that carries the same id.
   */
  | {
      type: "engine.approval";
      id: string;
      tool?: EngineTool;
      scope: "commands" | "turn";
      items: string[];
      /** Asked mid-turn by a tool that is waiting for the answer (Claude Code in Manual): a yes lets that one thing through, there and then. */
      live?: boolean;
      /** The tool's own reason for asking, e.g. "This command changes directory before running git". */
      why?: string;
    }
  // Anyone allowed to suggest who isn't driving. Never reaches the agent unless promoted.
  | { type: "suggestion"; text: string; mentions?: string[]; attachments?: Attachment[]; /** Raised at one step of a run: the tool call it is about, and the step's label. */ at?: { call: string; step: string } }
  // Control token
  /**
   * The wheel handed to a teammate for when they are next here (the end of a day, another time zone): with a note and where
   * the session stands, written as it was handed over. They take it when they next open the session, on their own computer.
   */
  | { type: "handover.offered"; to: string; toName: string; note: string; brief: string }
  /** Two agents heading for the same file before either has written it: one's plan names a file another has changed or plans to (intents.ts). */
  | { type: "files.overlap"; lane: string; path: string; with: string[] }
  /** Said to the people in the session, not to an agent: no agent reads it, steers by it or answers it (an aside). */
  | { type: "chat"; text: string; mentions?: string[] }
  | { type: "handover.cancelled" }
  | { type: "control.requested" }
  /** A viewer asking to edit (Arun, 2026-10-24: UX gaps): an owner makes them an editor (member.role_changed), or says not now. */
  | { type: "role.requested" }
  | { type: "role.declined"; userId: string }
  | { type: "control.granted"; to: string; toName: string; reason: "claim" | "yield" | "force" | "handoff" | "takeover" }
  | { type: "control.denied"; to: string }
  | { type: "control.released"; from: string; reason: "yield" | "disconnect" | "removed" | "revoked" }
  // Run control (human-issued)
  | { type: "run.pause" }
  | { type: "run.resume" }
  | { type: "run.cancel" }
  /** Cut the current step short so queued instructions are delivered now. */
  | { type: "run.interrupt" }
  // Agent runtime
  /**
   * `checkpoint` is the folder as it was the moment before this run touched
   * it, when there is a folder under git: what "Undo this run" goes back to.
   */
  | { type: "run.started"; causedBy: number; checkpoint?: string }
  /**
   * The run's checkpoint from a runner that takes it itself, just before it hands its tool the turn (`checkpoint` on the
   * turn): said just after `run.started` instead of on it, and read as that start's own (see startCheckpoint in rewind.ts).
   */
  | { type: "run.checkpoint"; checkpoint: string }
  /** Somebody committed the session's changes, and perhaps pushed them and opened a pull request. */
  | { type: "folder.committed"; sha: string; branch: string; message: string; files: number; pushed?: boolean; prUrl?: string; prCreated?: boolean; /** What the pull request merges into, when it was opened: the default branch, or the one below it in a stack. */ base?: string; error?: string }
  /** The folder's git worked by hand from the Git panel: changes thrown away, or the branch pulled. Staging is said nowhere: it changes no file. */
  | { type: "folder.git"; action: "discard" | "pull"; paths?: string[]; note?: string }
  /** The folder moved to another branch. */
  /** noticed: nobody switched through Friday; a listing found the folder on another branch (an agent's or a terminal's git switch). */
  | { type: "folder.switched"; branch: string; from: string; noticed?: true }
  /** Somebody ran a command in the folder themselves, rather than asking an agent to. */
  | { type: "folder.ran"; command: string; output: string; isError?: boolean }
  /** Somebody edited a file in the folder by hand. */
  | { type: "folder.edited"; path: string; bytes: number; created?: boolean }
  /** Somebody put the folder back to a checkpoint. `undo` is the folder as it was just before, so it can be redone. */
  | { type: "folder.applied"; files: number; into: string; conflicts?: string[] }
  | {
      type: "folder.restored";
      sha: string;
      undo: string;
      restored: number;
      removed: number;
      /** A rewind: the message it went back to before. That message and what followed it in this lane are set aside. */
      rewoundTo?: number;
      /** A checkpoint of the folder just after this, so a redo puts back only what this changed. */
      after?: string;
    }
  | { type: "run.ended"; outcome: "done" | "waiting" | "error"; error?: string; /** Cut off by a lost connection, its turn put back to carry on when the machine is back: not a failure of the work. */ cut?: true; /** A checkpoint of where the run left the folder, so its undo puts back only what it changed. */ after?: string }
  // The moment queued instructions entered the agent's context. Instructions
  // are placed in the context here, not at the position they were sent, so the
  // log records exactly what the agent knew at each step.
  | { type: "instructions.delivered"; seqs: number[] }
  /** A coding tool's machine dropped in the middle of a turn (a lost connection, a server restart): what it was working on waits again, first in line, for when it is back. */
  | { type: "instructions.requeued"; seqs: number[] }
  | {
      type: "agent.message";
      text: string;
      toolCalls: ToolCall[];
      interrupted?: boolean;
      /** What this step cost, as the provider counted it, for the usage meter. */
      tokens?: number;
      /** Opaque provider reasoning blocks that must be replayed with tool calls. */
      reasoning?: unknown[];
    }
  | {
      type: "tool.result";
      callId: string;
      name: string;
      output: string;
      isError: boolean;
      interrupted?: boolean;
    }
  /**
   * A decision the agent needs from a person. Options are separate from the
   * question on purpose: a card that has to cut a paragraph into choices
   * produces fragments, and a fragment is not an answer anybody can pick.
   */
  | { type: "agent.question"; callId: string; question: string; detail?: string; options?: string[]; recommended?: string; to: string; toName: string }
  /**
   * A remark about one place in the code, and the conversation under it.
   *
   * Review comments used to live in the browser of whoever typed them: not
   * visible to the room, gone on refresh, and sent as one lump of prose that
   * nothing could answer or close. In the log they are shared the moment they
   * are written, they survive, and each one can be handed to a person or a
   * lane and marked done when the code changes.
   */
  | {
      type: "thread.opened";
      /** A question for the agent about this code, rather than a change to make. */
      ask?: boolean;
      id: string;
      path: string;
      /** The line as the diff numbered it, and the code that was on it. */
      line: number;
      /** The last line of a range the remark is about, when it spans lines (Arun, 2026-10-25: a note on a block, as Orca has). */
      endLine?: number;
      code: string;
      /** A removed line is a remark about what went, not about what is there. */
      removed?: boolean;
      text: string;
      /** A lane, when the remark is work for an agent; a member id when it is for a person. */
      to?: string;
    }
  | { type: "thread.replied"; id: string; text: string }
  /** Handed to an agent as work: it is with that lane until its change lands or somebody takes it back. */
  | { type: "thread.sent"; id: string; lane: string }
  /** `auto` is set when the agent's own change closed it, and names the agent's lane, so the feed can say so and anybody can reopen it. */
  | { type: "thread.resolved"; id: string; auto?: { lane: string } }
  | { type: "thread.reopened"; id: string }
  /** Something worth carrying past the context window. */
  // `auto`: filed by Friday from a finished run rather than written by anyone, and `at` is where in the log that run ended.
  | { type: "memory.saved"; key: string; text: string; auto?: boolean; at?: number }
  /**
   * Files (or folders, ending in /) an agent says it is about to change, so the others keep off them until it is done
   * (claim_files). Ahead of the edit, where the lane's FileClaims (projection) are files it already touched.
   */
  | { type: "files.held"; paths: string[]; why?: string }
  /**
   * Wake this lane's agent when something it waits on happens (wake_me_when, or Friday from how its turn ended): another agent's
   * turn ending (`on.lane`), a board task landing (`on.task`), or a time (`on.at`), whichever comes first. `then` is what it
   * said it would do.
   */
  | { type: "wake.set"; id: string; on: { lane?: string; task?: string; at?: number }; then: string; /** Set by Friday from a turn that ended waiting, not asked for. */ auto?: true }
  /** The wake went off (`why` what happened) or was called off: the agent was told, or a person took over. */
  | { type: "wake.fired"; id: string; why: string }
  | { type: "wake.cancelled"; id: string }
  /** Some or (no paths) all of the files the lane held, let go (release_files). Its run ending lets go of them too. */
  | { type: "files.released"; paths?: string[] }
  /** A thumb on an agent's answer: up, down (with a reason, which the agent's memory keeps), or taken back. */
  | { type: "message.reacted"; seq: number; up: boolean | null; reason?: string }
  /** A whole folder arrived and was unpacked on the server as the session's working copy. */
  | { type: "folder.uploaded"; name: string; files: number }
  /**
   * A lane is reserved for someone's local CLI before it connects. Instructions
   * queue for it instead of going to Friday's own agent.
   */
  | { type: "engine.expected"; tool: EngineTool; hostId: string; hostName: string; repo?: string; /** The lane's pinned effort was dropped: see effortResets. */ effortReset?: true }
  /** Someone's local CLI took over a lane. The actor is the host. */
  | { type: "engine.attached"; engine: EngineInfo; /** The lane's pinned effort was dropped, a different tool or host taking it (see effortResets): for the note. */ effortReset?: true }
  /**
   * "disconnected" keeps the lane reserved, so work waits for the host to come
   * back. "released" hands the lane back to Friday's own agent.
   */
  | { type: "engine.detached"; reason: "disconnected" | "released"; tool?: EngineTool }
  /** What the CLI changed in its folder since it attached, taken with git after each turn. */
  | { type: "agent.diff"; base: string; files: DiffFile[]; /** Files past the 80 shown, by name only, so a commit can still name them all. */ more?: string[] }
  /**
   * A subagent (or background command) a coding tool started, as it starts and each time its status changes: Claude Code's
   * Agent tool, Codex's spawn_agent, Cursor's task tool. The latest for an `id` in a lane is where it stands. For the Tasks panel.
   */
  | {
      type: "agent.task";
      id: string;
      status: AgentTaskStatus;
      description?: string;
      agentType?: string;
      background?: boolean;
      summary?: string;
      /** A subagent at work: what it is doing now ("Reading Sidebar.tsx") and how many steps it has taken so far. */
      doing?: string;
      steps?: number;
    }
  /**
   * What a coding tool's turn used, as the tool reported it at the end: `input` read fresh (written to a cache included),
   * `cached` read back from one. Friday's own steps carry theirs on `agent.message.tokens`.
   */
  | {
      type: "agent.usage";
      tool?: EngineTool;
      input: number;
      cached: number;
      output: number;
      /** How full its context was at the end of the turn (its last model call's input), and that model's window, when the tool says. */
      context?: number;
      window?: number;
    }
  /**
   * What the router picked for Friday's agent or a coding tool, and why (see routing.ts): said when the pick changes, not every
   * step. `shadow`: only what Auto would have picked, in a session not on it; nothing ran differently. `current`: what did run.
   * `room`: Friday Pro's window still free (0 to 1), for the glance.
   */
  | {
      type: "model.routed";
      model: string;
      effort?: EngineEffort;
      tier: RouteTier;
      why: string;
      shadow?: boolean;
      tool?: EngineTool;
      current?: string;
      room?: number | null;
      /** The tool's models as they were weighed for this task, for the glance: how likely each was to get it right, and its cost. */
      options?: { model: string; success: number; cost: number }[];
    }
  /**
   * An agent handed what others already did, instead of starting from nothing: the catch-up a newcomer is sent, or a hand-off.
   * `spent`: what those agents had used getting there, as counted. `sent`: about what Friday passed on (see tool-usage.ts).
   */
  | { type: "context.carried"; kind: "catchup" | "handoff"; from: string[]; spent: number; sent: number }
  /**
   * A coding tool's conversation compacted by its own /compact before a turn, its context having grown past COMPACT_AT: every
   * step of a turn reads the whole conversation again, so a long one costs that much on every step (engine/hub.ts).
   */
  | { type: "context.compacted"; tool: EngineTool; before: number; window?: number }
  /** This session's agent wrote to another session (peers.ts). `held`: it waits there for someone who can steer that agent to say yes. */
  /** The answer to an agent's ask_agent (agent-mesh.ts), on the asker's lane. `auto`: taken from the end of the turn that handled it. */
  | { type: "mesh.replied"; id: string; fromLane: string; fromName: string; toLane: string; toName: string; text: string; auto?: boolean; /** The work stopped before it was done (a stop, an error, a usage limit, its agent gone): a report on that, not a result. */ short?: boolean }
  /** The asker stopped waiting for that answer: when it comes, it reaches the asker as a message (a MeshNote of kind `reply`). */
  | { type: "mesh.unwaited"; id: string }
  /** Agents in this session may not message each other until a person resumes it: by a person, or by Friday when a limit was hit. */
  | { type: "mesh.paused"; on: boolean; why?: string }
  /**
   * A team update (post_update, agent-mesh.ts) on the poster's lane: every other agent reads it when it checks its messages or
   * at the start of its next turn. Nobody is woken by one: it is the open line, not a knock on the door.
   */
  | { type: "mesh.posted"; id: string; fromLane: string; fromName: string; text: string }
  /** A teammate given folders or repos to work in, or one taken away (teammates.ts): a line in each of its team's chats. */
  | { type: "teammate.folders"; name: string; lane: string; added: string[]; removed: string[] }
  /** A teammate's tool ran out of usage and it switched to its backup to carry on (teammates.ts). */
  | { type: "teammate.switched"; name: string; lane: string; from: EngineTool; to: EngineTool; until: number | null; /** Back on its own tool, its limit lifted. */ back?: boolean; /** Back: what it did on its backup, told to its own tool with its next turn (hub.teammate). */ brief?: string }
  /** A teammate added, or its role changed, by a teammate in the Team room (manage_teammate, agent-mesh.ts). */
  | { type: "teammate.changed"; name: string; lane: string; added: boolean; role: string }
  /**
   * The morning brief (team-away.ts teamBrief), in the Team room: what the team did while the person was away, posted as they
   * come back (or at the time they set), and when a board finishes while they are away (Arun, 2026-10-28: "we need to ensure
   * teams can work basically while you are away").
   */
  | ({ type: "team.brief" } & TeamBrief)
  /**
   * A teammate an agent added (manage_teammate create), for the person to keep or remove: it works meanwhile. In the Team room,
   * as news. `id` is its record's (DELETE /api/teammates/:id removes it); `lane` its Team room lane.
   */
  | { type: "teammate.proposed"; id: string; name: string; lane: string; madeBy: { lane: string; name: string } }
  /**
   * Every hold a person put on agents here lifted (held.ts), or only those on `lanes`: by a person's one-click lift, or by
   * away mode turning on (old holds would keep the team idle all night).
   */
  | { type: "holds.lifted"; lanes?: string[]; why: string }
  /** The agent on this lane has read the team updates up to `upTo`: it checked (check_messages) or a turn carried them to it. */
  | { type: "mesh.read"; upTo: number }
  | { type: "peer.sent"; to: { sid: string; title: string; lane: string; name: string }; text: string; held: boolean }
  /** A message from another session for an agent the sender's person may not steer: it waits here for someone who can. */
  | { type: "peer.held"; id: string; from: PeerNote; text: string }
  /** Someone who can steer that agent let a held message through, or turned it away. */
  | { type: "peer.settled"; id: string; delivered: boolean }
  // A hub (hubs.ts): one plan, several agents at once in their own copies, the results brought together and shipped as one.
  /** Goal mode (goal.ts): when the work is done, in the person's words, read against every finished turn on that agent. */
  | { type: "goal.set"; text: string; check?: string }
  | { type: "goal.checked"; runSeq: number; met: boolean; why: string; /** The agent was told to carry on. */ nudge?: true }
  | { type: "goal.cleared" }
  | { type: "hub.planned"; id: string; goal: string; tasks: HubTask[]; width: number; tools: EngineTool[]; by: string }
  | { type: "hub.approved"; id: string; tasks: HubTask[] }
  | { type: "hub.task.started"; id: string; task: string; lane: string; tool: EngineTool; attempt: number }
  | { type: "hub.task.ended"; id: string; task: string; outcome: "done" | "failed" | "skipped"; grade: number; tests: "pass" | "fail" | "none"; summary: string; files: number; attempt: number }
  | { type: "hub.merged"; id: string; task: string; files: number; conflicts: string[] }
  | { type: "hub.ended"; id: string; outcome: "done" | "failed" | "cancelled"; why?: string; prUrl?: string; sha?: string; tasks: number; done: number }
  /** Friday paused this lane's run: it had used more tokens than the workspace allows one run (run-budget.ts). */
  | { type: "run.capped"; spent: number; cap: number }
  /** Friday paused this lane's run: the agent was repeating the same failing command (runaway.ts). */
  | { type: "run.guarded"; command: string; times: number; kind: "stuck" | "many" }
  /** Somebody set this lane's agent to carry on by itself at `at`: its coding tool ran out of usage and that is when it comes back. */
  | { type: "resume.scheduled"; at: number; /** Set by Friday, for the person who asked: the agent ran out of usage and no other could take it (limit-handoff.ts). */ auto?: true }
  /** That timed carry-on is off: called off by a person, or it couldn't go ahead (`why`). */
  | { type: "resume.cancelled"; why?: string }
  /** An agent on this lane was briefed from the project brain: what the team learned on this repo in earlier sessions. */
  | { type: "brain.briefed"; repo: string; count: number; sessions: number; tools: string[] }
  /** The session now belongs to another workspace: its owner brought it into a team to work on it together. */
  | { type: "session.moved"; workspaceId: string; workspaceName: string }
  /**
   * The conversation an imported CLI session had before Friday saw it.
   *
   * The host's own CLI resumes that conversation from its own memory, but
   * nobody else in the room has it: not Friday Code, and not a teammate who
   * attaches their own Claude Code, since the transcript is a file on one
   * person's machine. Putting the turns in the log is what makes an imported
   * session something the whole room can actually work on.
   */
  | {
      type: "session.imported";
      tool: EngineTool;
      /** The CLI's own id for it, which is what its host resumed. */
      sourceId: string;
      title: string;
      turns: ImportedTurn[];
      /** Messages in the original; `turns` may be only the tail of it. */
      total: number;
      /** The original was too long to read to its start: `turns` are its latest messages, and how many came before is not known. */
      partial?: boolean;
      /** Set when the original is another Friday session rather than a CLI's: this is a fork of it. */
      fork?: boolean;
      /** The folder's name and the branch the original conversation was working on, so what carries on from it knows where it was. */
      folder?: string;
      branch?: string;
    };

export interface ImportedTurn {
  role: "user" | "assistant";
  text: string;
}

export type EventType = EventBody["type"];

export type AgentTaskStatus = "running" | "done" | "error" | "stopped";

/**
 * A `/` command a coding tool answers to: Claude Code's own (built-in, the person's, plugins', skills'), Codex's prompts and
 * skills, Cursor's commands and skills. `insert` is what picking it writes in the message box.
 */
export interface ToolCommand {
  name: string;
  description: string;
  /** What it takes after the name, as the tool describes it ("<file>"). */
  hint?: string;
  insert: string;
}

export interface SessionEvent {
  seq: number;
  ts: number;
  actor: ActorRef;
  body: EventBody;
  /** Which lane produced this. Absent means the main lane. */
  lane?: string;
}

export interface Member {
  id: string;
  name: string;
  role: Role;
}

export interface PresenceMember extends Member {
  online: boolean;
}

/** Why a session can't be opened when its log is nowhere: said by the server (admit), recognised by the page to say it plainly. */
export const SESSION_GONE = "This session's history is no longer on the server";

/** A coding tool found on a computer, as its runner reports it (link/registry.ts, runner/host.ts). */
export interface MachineTool {
  tool: EngineTool;
  name: string;
  path: string | null;
  loggedIn: boolean | null;
  source: "cli" | "claude-app" | null;
}
