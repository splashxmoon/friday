import { ownPlan } from "../own-plan.js";
import type { GoalState } from "../goal.js";
import { engineName, MAIN_LANE, EFFORT_LEVELS, type BoardTaskDef, type EngineEffort, type EngineTool, type HubState } from "../types.js";
import { headlineClass, pieces } from "../command-class.js";
import { parseAsks, type Ask } from "../ask-parse.js";
import type {
  ActorRef,
  Attachment,
  DiffFile,
  EngineInfo,
  Lane,
  LinkRole,
  Permission,
  Role,
  SessionEvent,
  SessionOptions,
  SessionOptionsPatch,
  SessionPolicy,
} from "../types.js";

export const DEFAULT_POLICY: SessionPolicy = {
  editor: { suggest: true, control: true, upload: true, invite: false },
  viewer: { suggest: false, control: false, upload: false, invite: false },
};

export const DEFAULT_OPTIONS: SessionOptions = {
  webSearch: true,
  planFirst: false,
  signoff: 0,
  autoTest: true,
  review: true,
  thinking: "balanced",
  model: "",
  controlMode: "ask",
  mcp: true,
  policy: DEFAULT_POLICY,
  approve: { editor: [] },
  allow: [],
  agent: null,
};

export type RunStatus = "idle" | "running" | "paused" | "waiting_for_human" | "error";

export interface Section {
  id: string;
  title: string;
  content: string;
  updatedSeq: number;
  /** Code sections carry the language they should be highlighted as. */
  language?: string;
}


export interface Suggestion {
  seq: number;
  /** The agent it was written for. Sending it on goes to that agent, not to whichever one is the main lane. */
  lane: string;
  from: ActorRef;
  text: string;
  promoted: boolean;
  /** Put aside without being sent. */
  dismissed?: boolean;
  attachments?: Attachment[];
  /** Raised at one step of a run. */
  at?: { call: string; step: string };
}

export interface ThreadReply {
  by: { id: string; name: string };
  text: string;
  seq: number;
}

export interface Thread {
  id: string;
  path: string;
  line: number;
  /** The last line of the range it is about, when it spans lines. */
  endLine?: number;
  code: string;
  removed: boolean;
  text: string;
  by: { id: string; name: string };
  /** A lane or a member, when somebody is meant to act on it. */
  to?: string;
  /** A question for the agent about this code, not a change to make. */
  ask?: boolean;
  replies: ThreadReply[];
  resolved: boolean;
  seq: number;
  /** Handed to an agent as work, and where in the log. Cleared when it is reopened. */
  sent?: { lane: string; seq: number };
  /** Closed by the agent's own change rather than by a person. */
  auto?: { lane: string };
}

export interface MemberState {
  name: string;
  role: Role;
  removed?: boolean;
}

export interface SessionState {
  id: string;
  title: string;
  ownerId: string;
  /** The workspace this belongs to; "" for sessions older than workspaces. */
  workspaceId: string;
  options: SessionOptions;
  lastSeq: number;
  members: Record<string, MemberState>;
  links: Record<LinkRole, { enabled: boolean; version: number }>;
  driver: { id: string; name: string } | null;
  /** The main wheel handed to a teammate for when they are next here (handover.offered), until they take it or it is called off. */
  handover: { to: string; toName: string; from: { id: string; name: string }; note: string; brief: string; seq: number; /** They have the wheel: kept so they can still read the note. */ taken?: boolean } | null;
  /** Asks for the wheel, each for one lane: only that lane's driver answers it, and only that lane's rule says who may ask. */
  pendingRequests: { id: string; name: string; seq: number; lane: string }[];
  /** Viewers asking to edit, for an owner to answer (role.requested). Absent in a state kept before there were any. */
  roleRequests?: { id: string; name: string; seq: number }[];
  /** Messages from another session waiting here for someone who can steer their agent to let them through (peers.ts). */
  peersHeld?: { id: string; lane: string; fromTitle: string; fromName: string; seq: number }[];
  run: { status: RunStatus; sinceSeq: number; error?: string };
  /**
   * Lanes beyond "main", and their run state. `run` and `driver` above stay the
   * main lane's, so everything that predates lanes keeps working unchanged.
   */
  lanes: Lane[];
  /** The main agent's own name, when somebody gave it one. */
  mainName?: string;
  /** The agent that leads the others (lead.set), if one does. */
  lead?: string | null;
  laneRuns: Record<string, { status: RunStatus; sinceSeq: number; error?: string }>;
  /** When each lane's last turn finished well, by seq: an idle agent that has done something, not one that never ran. */
  finished?: Record<string, number>;
  /** Each lane whose last turn somebody stopped (run.pause), by seq, until its next turn starts: "stopped", not "done". */
  stopped?: Record<string, number>;
  /** Agents to wake when what they wait on happens (wake.set), until it does (wake.fired) or they're called off. */
  wakes?: Record<string, { id: string; lane: string; on: { lane?: string; task?: string; at?: number }; then: string; seq: number; auto?: true }>;
  /** Files each lane's agent said it is about to change (files.held) and hasn't let go: until it releases them or its run ends. */
  holds?: Record<string, { paths: string[]; why?: string; seq: number }>;
  laneDrivers: Record<string, { id: string; name: string } | null>;
  /** Instructions queued for an extra lane. The main lane's stay in pendingInstructions. */
  lanePending: Record<string, number[]>;
  /** What each lane has asked permission for and not yet been answered: an instruction in that lane, with or without an answer, ends the wait. */
  /** What each lane's agent is asking permission for. `live`: asked mid-turn, the tool waiting on the answer there and then. */
  approvals: Record<string, { id: string; seq: number; tool?: EngineTool; scope: "commands" | "turn"; items: string[]; live?: boolean }>;
  /** Instructions sent but not yet delivered into the agent's context. */
  pendingInstructions: number[];
  /** Instructions taken back while they were still queued. */
  withdrawn: number[];
  /**
   * Each agent's question to a person, by the lane that asked: only that agent's events settle it. One per lane, because
   * with one for the session a second agent asking replaced the first's, and the first sat waiting with no card to answer.
   */
  openQuestions: Record<string, OpenQuestion>;
  /**
   * A coding tool that ended its turn asking the person something, by lane: its last answer and the questions read off the
   * end of it (ask-parse.ts). It has no ask_human, so this is its open question; the lane's next instruction or run ends it.
   */
  asks: Record<string, { seq: number; questions: Ask[] }>;
  suggestions: Suggestion[];
  /** Thumbs on answers, by the answer's seq, then by who: the agent's record and the week read these. */
  reactions: Record<number, Record<string, { name: string; up: boolean; reason?: string }>>;
  /** Ordered by first write, so the panel doesn't reshuffle as work lands. */
  /** Notes the agent chose to keep; they survive context trimming. */
  memory: { key: string; text: string; seq: number }[];
  /** Review threads, oldest first: a remark about a line and what came of it. */
  threads: Thread[];
  /**
   * Who was @-mentioned and hasn't answered yet: the latest mention of each person, cleared the moment they say or do
   * anything in the session. Their Needs-you list shows it until then (attention.ts).
   */
  mentions?: Record<string, { seq: number; by: string; byName: string; text: string; lane: string }>;
  /**
   * Who has touched which file since the last commit.
   *
   * Not a lock. Lanes share one folder, so two of them writing the same file
   * is a real thing that happens and the log is the only place it is visible
   * at all — this is what makes it visible.
   */
  claims: FileClaim[];
  /**
   * The files each agent's current plan says it will change (intents.ts), read from its plan as it posts it: so two agents
   * heading for the same file are seen before either writes it. Cleared with the claims, when the folder is committed.
   */
  intents?: Record<string, { paths: string[]; seq: number }>;
  /**
   * Each lane's latest plan, counted: its steps and how many are finished (completed or cancelled), so a list of sessions can say
   * "stopped at 3 of 5" as the Work rail does, not "done" over a plan left short (QA, 2026-10-28; Arun: "TEST EVERYTHING").
   */
  planDone?: Record<string, { done: number; of: number }>;
  /** The most recent instruction: the session's current intent, for people joining cold. */
  lastInstruction: { seq: number; text: string; by: string } | null;
  /**
   * Lanes run by someone's local CLI instead of Friday Code, keyed by lane.
   * Present while the lane is reserved; `online` says whether the runner is
   * connected right now.
   */
  engines: Record<string, LaneEngine>;
  /** Latest change set each CLI lane reported. */
  diffs: Record<string, { seq: number; base: string; files: DiffFile[]; more?: string[] }>;
  /** The session's hub (hubs.ts), the newest one planned, and where each of its tasks stands. */
  hub: HubState | null;
  /** The done condition somebody set for an agent's work, and how the turns since have read against it (goal.ts). */
  goal: GoalState | null;
  /**
   * A folder somebody uploaded, unpacked on the server as a working copy.
   *
   * Present once an attachment arrives with a path in its name, which is what
   * a folder pick looks like and a file pick doesn't. It is what turns the
   * repo tools on for a session with no machine attached: there is a folder to
   * work in, it just isn't on anybody's laptop.
   */
  upload: { files: number; name: string } | null;
  /** Where each lane's plan was approved in the log; a run that started after that has to be approved again. */
  planApproved: Record<string, number>;
  /** Each lane's plan, as teammates have reviewed it so far. Starts over when the plan changes. */
  planReviews: Record<string, Record<string, PlanReview>>;
  /** Files and folders pinned as context, in the order they were pinned. */
  pins: string[];
  /** The pull request Friday is seeing through to merge, on which agent, since when; null when it isn't. */
  shepherd: { prUrl: string; lane: string; by: string; since: number } | null;
  /** The pull request the session's last commit opened or pushed to, and whether the session saw it merge (a shepherded one). */
  pr: { url: string; merged?: true; /** What it merges into, when known; a branch other than the default one means it is stacked. */ base?: string } | null;
  /** Lanes set to carry on by themselves at a time (a usage limit resetting), and who set it. Off once anyone writes to the lane. */
  resumes: Record<string, { at: number; by: string; byName: string; seq: number }>;
  /**
   * The effort level pinned for each lane's coding tool (`lane.effort`); a lane absent is on Auto. Kept here rather than on its
   * engine, which every attach replaces whole: a reconnect would have wiped it. May be missing from a state cached before it.
   */
  efforts?: Record<string, EngineEffort>;
  /**
   * How far others' messages may go on each lane (`lane.othersFull`): false where its host held them to Edits, absent or true
   * as far as the host's own, Auto included. Auto is Auto for everyone's messages unless the host says otherwise (Arun,
   * 2026-10-23: "auto mode should auto approve everything"); it used to be held to Edits unless the host opened it up.
   */
  othersFull?: Record<string, boolean>;
  /** The agents' messages to each other (agent-mesh.ts): whether that is paused, and every ask with its answer. Missing from a state cached before it. */
  mesh?: MeshState;
  /** The shared task board (board.ts), once an agent has posted one. */
  board?: BoardState;
}

export type BoardStatus = "open" | "claimed" | "review" | "done" | "blocked" | "cancelled";

export interface BoardTask extends BoardTaskDef {
  status: BoardStatus;
  /** Who has it (claimed, or who did it once it's done), by lane and name. */
  lane?: string;
  name?: string;
  report?: string;
  /** The agent checking it, and what it found. */
  reviewer?: { lane: string; name: string };
  review?: { ok: boolean; note: string; by: string };
  /** Times it went back to its agent after a review or its checks found something. */
  rounds: number;
  /** Its checks: running now (`running`), or how they went last. */
  checks?: { command: string; running?: boolean; ok?: boolean; skipped?: boolean; output?: string };
  /** Who a person asked to take it next (board.released with `to`). */
  next?: string;
  /** Agents that turned it down as not theirs (finish_task decline): it is never offered to them again. */
  declined?: string[];
  /** Why the board gave it to the agent it is with (board.claimed), when it picked one for a reason beyond being free. */
  why?: string;
}

export interface BoardState {
  /** The agent that posted the plan, which hears how it went. */
  fromLane: string;
  fromName: string;
  seq: number;
  tasks: BoardTask[];
  /** What proves a task works, for tasks without their own. */
  check?: string;
}

/** Tasks whose every dependency is done and that nobody has: the ones an agent can take now. */
export function readyTasks(s: SessionState): BoardTask[] {
  const b = s.board;
  if (!b) return [];
  // A dropped task waits on nothing and holds nothing up: what waited on it goes ahead without it.
  const done = new Set(b.tasks.filter((t) => t.status === "done" || t.status === "cancelled").map((t) => t.id));
  return b.tasks.filter((t) => t.status === "open" && t.after.every((d) => done.has(d)));
}

/** Whether the board still has work on it: anything not done (a blocked task waits for the lead or a person). */
export function boardBusy(s: SessionState): boolean {
  return !!s.board?.tasks.some((t) => t.status !== "done" && t.status !== "blocked" && t.status !== "cancelled");
}

/** One agent's question to another (ask_agent), and where it stands. */
export interface MeshAsk {
  id: string;
  /** The instruction that carried it, on the asked agent's lane. */
  seq: number;
  fromLane: string;
  fromName: string;
  toLane: string;
  toName: string;
  text: string;
  hop: number;
  by: { id: string; name: string } | null;
  reply?: { text: string; seq: number; auto?: boolean; /** Stopped before it was done (mesh.replied short): not a result. */ short?: boolean };
  /** Work the lead assigned (assign_task), not a question. */
  task?: boolean;
  /** Where the asker stopped waiting (mesh.unwaited): an answer logged after this reaches it as a message. */
  unwaitedSeq?: number;
}

/** One agent's team update (mesh.posted). */
export interface MeshPost {
  seq: number;
  id: string;
  fromLane: string;
  fromName: string;
  text: string;
  ts: number;
}

export interface MeshState {
  /** Always null now: agent talk is never paused (Arun, 2026-10-20). Kept so an old log's `mesh.paused` and a cached state read the same. */
  paused: { by: string; why?: string; seq: number } | null;
  asks: Record<string, MeshAsk>;
  /** The instructions that are agent messages. */
  msgs: number[];
  /** Those that hand over work (a task, a board task or its review): each starts a turn of its own, never mid-turn (inbox). */
  work?: number[];
  /** The team updates, newest last, the last MAX_POSTS kept. Missing from a state cached before them. */
  posts?: MeshPost[];
  /** Per lane, the seq up to which its agent has read the team updates. */
  readUpTo?: Record<string, number>;
}

/** The team updates kept in the state: enough for any agent's next turn, never the whole history. */
export const MAX_POSTS = 40;

/**
 * The name somebody gave an agent (lane.renamed, or a name it was added under), or null when it only has its tool's: every
 * place that names an agent says this one first (Arun, 2026-10-19: a renamed coding tool kept its tool's name in the Agents
 * panel and the chat). A lane named after its own tool ("Codex") hasn't been given a name.
 */
export function givenName(s: SessionState, lane: string): string | null {
  const own = (lane === MAIN_LANE ? s.mainName : s.lanes.find((l) => l.id === lane)?.name)?.trim();
  if (!own) return null;
  const tool = s.engines[lane]?.tool;
  return tool && own.toLowerCase() === engineName(tool).toLowerCase() ? null : own;
}

/** The session's agent messaging, whether or not it has started. */
export function meshOf(s: SessionState): MeshState {
  // A state cached while agent talk was paused still says so: never read as paused.
  return s.mesh ? (s.mesh.paused ? { ...s.mesh, paused: null } : s.mesh) : { paused: null, asks: {}, msgs: [] };
}

/** The team updates the agent on `lane` hasn't read: everyone else's, after where it last read. */
export function unreadPosts(s: SessionState, lane: string): MeshPost[] {
  const m = meshOf(s);
  const from = m.readUpTo?.[lane] ?? 0;
  return (m.posts ?? []).filter((p) => p.seq > from && p.fromLane !== lane);
}

export interface LaneEngine extends EngineInfo {
  online: boolean;
  sinceSeq: number;
  /** When it went offline, or was reserved and never attached: the hold on the lane runs from here. */
  offlineAt?: number;
}

/** How long a lane stays its host's once their machine drops, or after they reserve it: long enough for a blip, a sleep or a restart. */
export const LANE_HOLD_MS = 5 * 60_000;

/**
 * Why `me` can't attach to or reserve a lane over its engine, or null when they can.
 *
 * Someone else's engine keeps the lane while it is online, and for LANE_HOLD_MS after it drops, so a network blip is not a
 * handover. After that the lane frees itself: a laptop shut for the night can't lock the room out. The host always gets back in.
 */
export function laneHeld(e: LaneEngine | undefined, me: string, now = Date.now()): string | null {
  if (!e || e.hostId === me) return null;
  const who = `${e.hostName}'s ${engineName(e.tool)}`;
  if (e.online) return `${who} is already running that lane.`;
  const left = e.offlineAt === undefined ? 0 : e.offlineAt + LANE_HOLD_MS - now;
  if (left <= 0) return null;
  const mins = Math.ceil(left / 60_000);
  return `${who} is reconnecting to that lane, so it's held for ${e.hostName} for ${mins} more minute${mins === 1 ? "" : "s"}. Try again then.`;
}

/**
 * A folder arriving, counted.
 *
 * A path in the name is the whole test: `src/app.ts` came from a folder pick,
 * `notes.md` did not. One loose file shouldn't turn a session into a
 * codebase, and a folder should, without anybody saying so.
 */
function noteUpload(s: SessionState, atts?: { name: string }[]): void {
  const folder = (atts ?? []).filter((a) => a.name.includes("/"));
  if (!folder.length) return;
  const top = folder[0]!.name.split("/")[0]!;
  s.upload = { files: (s.upload?.files ?? 0) + folder.length, name: s.upload?.name ?? top };
}

export function initialState(id: string): SessionState {
  return {
    id,
    title: "",
    ownerId: "",
    workspaceId: "",
    options: structuredClone(DEFAULT_OPTIONS),
    lastSeq: 0,
    members: {},
    links: { editor: { enabled: true, version: 1 }, viewer: { enabled: true, version: 1 } },
    driver: null,
    handover: null,
    pendingRequests: [],
    run: { status: "idle", sinceSeq: 0 },
    lanes: [],
    laneRuns: {},
    laneDrivers: {},
    lanePending: {},
    approvals: {},
    pendingInstructions: [],
    withdrawn: [],
    openQuestions: {},
    asks: {},
    suggestions: [],
    reactions: {},
    memory: [],
    threads: [],
    claims: [],
    lastInstruction: null,
    engines: {},
    diffs: {},
    hub: null,
    goal: null,
    upload: null,
    planApproved: {},
    planReviews: {},
    pins: [],
    shepherd: null,
    pr: null,
    resumes: {},
    efforts: {},
  };
}

/**
 * The effort a lane's next turn runs at: its pinned level when its tool takes that level, else what the router picked (Auto
 * passes that through). A tool with no effort control gets none from either. Undefined passes no effort at all.
 */
export function laneEffort(s: SessionState, lane: string, tool: EngineTool | undefined, routed?: string): string | undefined {
  const e = s.engines[lane];
  const takes = (tool && EFFORT_LEVELS[tool]) || (e?.tool === tool ? e?.efforts : undefined) || [];
  if (!takes.length) return undefined;
  const pinned = s.efforts?.[lane];
  return pinned && takes.includes(pinned) ? pinned : routed;
}

/**
 * Whether a lane's pinned effort goes when `next` takes the lane: a level picked for one tool on one person's computer is not
 * a pick for another tool, or for somebody else's. The same host coming back with the same tool keeps it.
 */
export function effortResets(s: SessionState, lane: string, next: { tool?: EngineTool; hostId: string }): boolean {
  if (!s.efforts?.[lane]) return false;
  const prev = s.engines[lane];
  return !prev || prev.tool !== next.tool || prev.hostId !== next.hostId;
}

/** The local CLI reserved for a lane, if any. */
export function engineOf(s: SessionState, lane: string): LaneEngine | null {
  return s.engines[lane] ?? null;
}

export function mergeOptions(o: SessionOptions, patch?: SessionOptionsPatch): SessionOptions {
  if (!patch) return o;
  const { policy, ...rest } = patch;
  const next: SessionOptions = { ...o };
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
  if (policy) {
    next.policy = {
      editor: { ...o.policy.editor, ...policy.editor },
      viewer: { ...o.policy.viewer, ...policy.viewer },
    };
  }
  return next;
}

/**
 * Allowed in advance: the exact command, or one that starts with an entry ending in `*` ("npm test*").
 *
 * A `*` entry allows that command with more arguments, not a line that goes on to do something else. `npm test && curl
 * … | sh`, `git status; rm -rf .` and `npm test > package.json` each ask, and so does anything that could hide a second
 * command where nobody would see it: `$(…)`, backticks, or the parentheses and braces PowerShell evaluates inside an
 * argument. The entry also has to end where a word does, so "npm test*" is not "npm testify". Asking is the fallback
 * for anything unusual, which costs a question and nothing more.
 */
export const allowedCommand = (s: SessionState, command: string): boolean => {
  const c = command.trim();
  return (s.options.allow ?? []).some((a) => {
    if (!a.endsWith("*")) return a === c;
    const prefix = a.slice(0, -1).trimEnd();
    const rest = c.slice(prefix.length);
    return c.startsWith(prefix) && (!/\w$/.test(prefix) || !rest || /^\s/.test(rest)) && pieces(c)?.length === 1 && !/[(){}]/.test(c);
  });
};
/** The pattern that would allow commands like this one: its first two words, then anything. */
export const allowPrefix = (command: string): string => {
  const words = command.trim().split(/\s+/);
  return `${words.slice(0, Math.min(2, words.length)).join(" ")}*`;
};

/**
 * What one press of "Always allow" adds for a command. Commands that look around, check, build or work git on this machine
 * get the pattern (allow "npm test" and "npm test -- --watch" is allowed too); anything that installs, publishes, deploys,
 * deletes or isn't recognised gets exactly itself, so "rm -rf build" never quietly becomes "rm -rf" anything.
 */
export const alwaysAllowEntry = (command: string): string => {
  const c = command.trim();
  return ["read", "checks", "build", "git"].includes(headlineClass(c)) ? allowPrefix(c) : c;
};

/** The member's role, or null if they aren't (or are no longer) in the session. */
export function roleOf(s: SessionState, userId: string): Role | null {
  const m = s.members[userId];
  return m && !m.removed ? m.role : null;
}

/** The driver of a lane. The main lane's lives on `driver` for compatibility. */
export function driverOf(s: SessionState, lane: string): { id: string; name: string } | null {
  return lane === MAIN_LANE ? s.driver : (s.laneDrivers[lane] ?? null);
}

export type OpenQuestion = { seq: number; lane: string; question: string; detail?: string; options?: string[]; recommended?: string; to: string; toName: string };

/** The agents' questions waiting on this person, oldest first. */
export function questionsTo(s: SessionState, userId: string): OpenQuestion[] {
  return Object.values(s.openQuestions).filter((q) => q.to === userId).sort((a, b) => a.seq - b.seq);
}

/** Requests for the wheel of the lanes this person drives: the ones waiting on their answer. */
export function requestsTo(s: SessionState, userId: string): SessionState["pendingRequests"] {
  return s.pendingRequests.filter((r) => driverOf(s, r.lane)?.id === userId);
}

/** Instructions queued for a lane but not yet delivered into its context. */
export function pendingFor(s: SessionState, lane: string): number[] {
  // Every agent's messages go through, a person's and another agent's alike: agent talk is never held back (Arun, 2026-10-20:
  // "do not pause agent to agent talking too ever"), so an agent stopped or idle is always reachable.
  return lane === MAIN_LANE ? s.pendingInstructions : (s.lanePending[lane] ?? []);
}

/**
 * The lanes a lane takes its brief from: the ones it waits on, and the ones they wait on in turn.
 *
 * A reviewer that wakes when the main lane finishes has no driver and nobody instructs it, so what it
 * knows of the task is what the lane before it was told. A lane someone drives is told its own things and
 * only those: another lane's instructions are that lane's business, not its.
 */
export function upstreamOf(s: SessionState, lane: string): string[] {
  const out = new Set<string>();
  let cur = lane;
  for (let i = 0; i < 8; i++) {
    const def = laneOf(s, cur);
    if (!def || def.trigger.kind !== "lane-finished") break;
    const up = def.trigger.laneId ?? MAIN_LANE;
    if (out.has(up) || up === lane) break;
    out.add(up);
    cur = up;
  }
  return [...out];
}

/** A plan tool call's steps, counted (todo / TodoWrite's `todos`, update_plan's `plan` or `steps`), or null when it lists none. */
export function planStepsOf(args: string): { done: number; of: number } | null {
  try {
    const a = JSON.parse(args || "{}") as Record<string, unknown>;
    const raw = [a.todos, a.plan, a.steps, a.items].find(Array.isArray) as unknown[] | undefined;
    if (!raw?.length) return null;
    const done = raw.filter((t) => ["completed", "done", "cancelled"].includes(String((t as { status?: unknown } | null)?.status ?? ""))).length;
    return { done, of: raw.length };
  } catch {
    return null;
  }
}

/** File paths written in a plan ("Edit src/cart.ts", "update `Sources/App/Cart.swift`"): what an agent says it will change. */
const PATH = /(?:^|[\s`'"(\[])((?:[\w@.-]+\/)*[\w@-]+(?:\.[\w-]+)*\.(?:tsx?|jsx?|mjs|cjs|swift|py|go|rs|rb|java|kt|css|scss|html|json|md|ya?ml|toml|sql|sh|vue|svelte|cc?|cpp|hpp?|cs|php|m|mm))(?=$|[\s`'"),.:;\]])/g;
export function pathsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.replace(/\\n/g, "\n").matchAll(PATH)) {
    const p = m[1]!.replace(/^\.\//, "");
    if (!/^\d/.test(p) && p.length < 200) out.add(p);
    if (out.size >= 40) break;
  }
  return [...out];
}

/** A lane's run state, defaulting to idle for a lane that has never run. */
export function runOf(s: SessionState, lane: string): { status: RunStatus; sinceSeq: number; error?: string } {
  return lane === MAIN_LANE ? s.run : (s.laneRuns[lane] ?? { status: "idle", sinceSeq: 0 });
}

/** A lane by id, or null for the main lane which is implicit and always present. */
export function laneOf(s: SessionState, laneId: string): Lane | null {
  return laneId === MAIN_LANE ? null : (s.lanes.find((l) => l.id === laneId) ?? null);
}

/**
 * Whether someone may take the wheel of a lane. The main lane follows the
 * session policy, as it always has. Extra lanes carry their own rule, so a
 * session can run an open research lane beside a named-approver drafting lane.
 */
export function canDriveLane(s: SessionState, userId: string, laneId: string): boolean {
  // A coding tool on its host's own plan is steered by its host alone, whatever the session lets others do (own-plan.ts). Gone,
  // the lane is anyone's to hold again; what is sent to that tool is still refused if it comes back (EngineHub.drain).
  const e = s.engines[laneId];
  if (ownPlan(e) && e.online !== false && e.hostId !== userId) return false;
  const lane = laneOf(s, laneId);
  if (!lane) return can(s, userId, "control");
  const role = roleOf(s, userId);
  if (!role) return false;
  switch (lane.control.kind) {
    case "open":
      return can(s, userId, "control");
    // The lane narrows who may drive it; the session's policy is still the ceiling. An editors-only lane in a session
    // where the owner turned control off for editors is driven by nobody but the owner.
    case "role":
      return role === "owner" || (role === lane.control.role && can(s, userId, "control"));
    case "people":
      return role === "owner" || lane.control.people.includes(userId);
    // Nobody drives a standing lane; it wakes on triggers and takes no instructions.
    case "standing":
      return false;
  }
}

/** Owners can do everything; everyone else is governed by the session policy. */
export function can(s: SessionState, userId: string, perm: Permission): boolean {
  const role = roleOf(s, userId);
  if (!role) return false;
  return role === "owner" || s.options.policy[role][perm];
}

/** Pure-ish reducer (mutates `s` for speed; callers own the object). */
function addLane(s: SessionState, lane: Lane, seq: number): void {
  s.lanes = [...s.lanes.filter((l) => l.id !== lane.id), lane];
  s.laneRuns[lane.id] ??= { status: "idle", sinceSeq: seq };
  s.laneDrivers[lane.id] ??= null;
  s.lanePending[lane.id] ??= [];
}

/** One lane's mark on one file, standing until the folder is committed. */
export interface FileClaim {
  path: string;
  lane: string;
  by: { id: string; name: string };
  /** When this lane last touched it, so the newer of two claims can be named. */
  seq: number;
}

/**
 * Record that a lane touched a file.
 *
 * One claim per lane per path: a lane editing the same file eight times is
 * still one lane working on one file, and eight rows would make every long
 * run look like a collision with itself.
 */
function claim(s: SessionState, ev: SessionEvent, path: string): void {
  const lane = ev.lane ?? MAIN_LANE;
  const had = s.claims.find((c) => c.path === path && c.lane === lane);
  if (had) {
    had.seq = ev.seq;
    had.by = { id: ev.actor.id, name: ev.actor.name };
    return;
  }
  s.claims.push({ path, lane, by: { id: ev.actor.id, name: ev.actor.name }, seq: ev.seq });
}

export function apply(s: SessionState, ev: SessionEvent): SessionState {
  s.lastSeq = ev.seq;
  const b = ev.body;
  const lane = ev.lane ?? MAIN_LANE;
  // A person doing anything here has seen what they were mentioned in; a new mention of someone replaces their last.
  if (s.mentions?.[ev.actor.id] && ev.actor.kind === "human") delete s.mentions[ev.actor.id];
  if ("mentions" in b && Array.isArray(b.mentions) && b.mentions.length && "text" in b && typeof b.text === "string") {
    s.mentions ??= {};
    for (const id of b.mentions) if (id !== ev.actor.id) s.mentions[id] = { seq: ev.seq, by: ev.actor.id, byName: ev.actor.name, text: b.text.slice(0, 280), lane };
  }
  const setRun = (status: RunStatus, error?: string) => {
    const next = { status, sinceSeq: ev.seq, ...(error ? { error } : {}) };
    if (lane === MAIN_LANE) s.run = next;
    else s.laneRuns[lane] = next;
  };

  switch (b.type) {
    case "session.moved":
      s.workspaceId = b.workspaceId;
      break;
    case "session.created":
      s.title = b.title;
      s.ownerId = b.ownerId;
      if (b.workspaceId) s.workspaceId = b.workspaceId;
      s.options = mergeOptions(s.options, b.options);
      s.driver = { id: b.ownerId, name: b.ownerName };
      s.members[b.ownerId] = { name: b.ownerName, role: "owner" };
      break;
    case "session.updated":
      s.options = mergeOptions(s.options, b.options);
      if (b.title) s.title = b.title;
      // A policy that no longer lets somebody drive takes their asks with it: left standing, a handoff could still grant them the wheel.
      if (b.options?.policy) s.pendingRequests = s.pendingRequests.filter((r) => canDriveLane(s, r.id, r.lane));
      break;
    case "member.joined":
      s.members[ev.actor.id] = { name: ev.actor.name, role: b.role };
      break;
    case "member.role_changed":
      if (s.members[b.userId]) s.members[b.userId]!.role = b.role;
      if (s.roleRequests) s.roleRequests = s.roleRequests.filter((r) => r.id !== b.userId);
      // A request for the wheel from somebody who can no longer have it is not a request any more, on whichever lane it was made.
      s.pendingRequests = s.pendingRequests.filter((r) => r.id !== b.userId || canDriveLane(s, b.userId, r.lane));
      break;
    case "member.removed":
      if (s.members[b.userId]) s.members[b.userId]!.removed = true;
      if (s.roleRequests) s.roleRequests = s.roleRequests.filter((r) => r.id !== b.userId);
      s.pendingRequests = s.pendingRequests.filter((r) => r.id !== b.userId);
      break;
    case "link.updated":
      s.links[b.role] = { enabled: b.enabled, version: b.version };
      break;
    case "engine.approval":
      s.approvals[lane] = { id: b.id, seq: ev.seq, ...(b.tool ? { tool: b.tool } : {}), scope: b.scope, items: b.items, ...(b.live ? { live: true } : {}) };
      break;
    case "instruction": {
      // A live ask (the tool waiting mid-turn) stays until it is answered or the turn is interrupted. A message written
      // meanwhile waits for the turn like any queued one: clearing the ask hid its card while the tool went on waiting for an
      // answer nobody could give any more, and the lane never moved again.
      if (!s.approvals[lane]?.live || b.approval || b.interrupt) delete s.approvals[lane];
      delete s.resumes[lane];
      delete s.asks[lane];
      // A person writing to the agent has taken it from there: a wake Friday set by itself is no longer its next step.
      if (ev.actor.kind === "human") for (const w of Object.values(s.wakes ?? {})) if (w.lane === lane && w.auto) delete s.wakes![w.id];
      noteUpload(s, b.attachments);
      // An edit takes the place of the message it replaces, which is taken back; anything else joins the end of the queue.
      const queue = lane === MAIN_LANE ? s.pendingInstructions : (s.lanePending[lane] ??= []);
      const at = b.replaces !== undefined ? queue.indexOf(b.replaces) : -1;
      if (at >= 0) {
        queue[at] = ev.seq;
        if (!s.withdrawn.includes(b.replaces!)) s.withdrawn.push(b.replaces!);
      } else queue.push(ev.seq);
      s.lastInstruction = { seq: ev.seq, text: b.text, by: ev.actor.name };
      if (b.mesh) {
        const m = (s.mesh ??= { paused: null, asks: {}, msgs: [] });
        m.msgs.push(ev.seq);
        if (b.mesh.kind === "task" || b.mesh.board) (m.work ??= []).push(ev.seq);
        if ((b.mesh.kind === "ask" || b.mesh.kind === "task") && !b.mesh.board) m.asks[b.mesh.id] = { id: b.mesh.id, seq: ev.seq, fromLane: b.mesh.fromLane, fromName: b.mesh.fromName, toLane: lane, toName: b.mesh.toName, text: b.text, hop: b.mesh.hop, by: b.mesh.by, ...(b.mesh.kind === "task" ? { task: true } : {}) };
      }
      if (b.fromSuggestion !== undefined) {
        const sug = s.suggestions.find((x) => x.seq === b.fromSuggestion);
        if (sug) sug.promoted = true;
      }
      break;
    }
    case "suggestion":
      noteUpload(s, b.attachments);
      s.suggestions.push({ seq: ev.seq, lane, from: ev.actor, text: b.text, promoted: false, attachments: b.attachments, ...(b.at ? { at: b.at } : {}) });
      break;
    // Kept with its lane. One session-wide list read every ask as one for the main agent: it showed to the wrong driver, and a
    // handoff could give somebody the main wheel on the strength of an ask for an agent they were only allowed to drive.
    case "peer.held":
      s.peersHeld = [...(s.peersHeld ?? []), { id: b.id, lane, fromTitle: b.from.fromTitle, fromName: b.from.fromName, seq: ev.seq }];
      break;
    case "peer.settled":
      if (s.peersHeld) s.peersHeld = s.peersHeld.filter((h) => h.id !== b.id);
      break;
    case "role.requested":
      if (!(s.roleRequests ?? []).some((r) => r.id === ev.actor.id)) s.roleRequests = [...(s.roleRequests ?? []), { id: ev.actor.id, name: ev.actor.name, seq: ev.seq }];
      break;
    case "role.declined":
      if (s.roleRequests) s.roleRequests = s.roleRequests.filter((r) => r.id !== b.userId);
      break;
    case "control.requested":
      if (!s.pendingRequests.some((r) => r.id === ev.actor.id && r.lane === lane)) {
        s.pendingRequests.push({ id: ev.actor.id, name: ev.actor.name, seq: ev.seq, lane });
      }
      break;
    case "handover.offered":
      s.handover = { to: b.to, toName: b.toName, from: { id: ev.actor.id, name: ev.actor.name }, note: b.note, brief: b.brief, seq: ev.seq };
      break;
    case "handover.cancelled":
      s.handover = null;
      break;
    case "control.granted":
      // Taken by the one it was handed to: done, and kept for them to read. Taken by anybody else, it still waits for them.
      if (lane === MAIN_LANE && s.handover?.to === b.to) s.handover.taken = true;
      if (lane === MAIN_LANE) s.driver = { id: b.to, name: b.toName };
      else s.laneDrivers[lane] = { id: b.to, name: b.toName };
      s.pendingRequests = s.pendingRequests.filter((r) => r.id !== b.to || r.lane !== lane);
      break;
    case "control.denied":
      s.pendingRequests = s.pendingRequests.filter((r) => r.id !== b.to || r.lane !== lane);
      break;
    case "control.released":
      if (lane === MAIN_LANE) s.driver = null;
      else s.laneDrivers[lane] = null;
      break;
    case "pin.added":
      if (!s.pins.includes(b.path)) s.pins.push(b.path);
      break;
    case "pin.removed":
      s.pins = s.pins.filter((p) => p !== b.path);
      break;
    case "plan.approved":
      s.planApproved[lane] = ev.seq;
      delete s.planReviews[lane];
      break;
    case "plan.reviewed":
      (s.planReviews[lane] ??= {})[ev.actor.id] = { name: ev.actor.name, verdict: b.verdict, ...(b.note ? { note: b.note } : {}), seq: ev.seq };
      break;
    case "pr.shepherd":
      s.shepherd = b.on ? { prUrl: b.prUrl, lane, by: ev.actor.name, since: ev.seq } : null;
      break;
    case "pr.shepherd.ended":
      if (b.outcome === "merged" && (s.pr || s.shepherd)) s.pr = { url: s.pr?.url ?? s.shepherd!.prUrl, merged: true };
      s.shepherd = null;
      break;
    case "resume.scheduled":
      s.resumes[lane] = { at: b.at, by: ev.actor.id, byName: ev.actor.name, seq: ev.seq };
      break;
    case "resume.cancelled":
      delete s.resumes[lane];
      break;
    case "pr.feedback":
      break;
    case "folder.uploaded":
      s.upload = { files: (s.upload?.files ?? 0) + b.files, name: s.upload?.name ?? b.name };
      break;
    case "lane.added":
      addLane(s, b.lane, ev.seq);
      break;
    // A crew's lanes are already wired to each other by the time they get
    // here; folding them is folding several lane.added at one seq.
    case "crew.applied":
      for (const lane of b.lanes) addLane(s, lane, ev.seq);
      break;
    case "hub.planned":
      s.hub = { id: b.id, goal: b.goal, status: "planned", width: b.width, tasks: b.tasks, tools: b.tools, runs: Object.fromEntries(b.tasks.map((t) => [t.id, { status: "waiting", attempt: 0 }])) };
      break;
    case "hub.approved":
      if (s.hub?.id === b.id) {
        s.hub.tasks = b.tasks;
        s.hub.status = "running";
        s.hub.runs = Object.fromEntries(b.tasks.map((t) => [t.id, s.hub!.runs[t.id] ?? { status: "waiting", attempt: 0 }]));
      }
      break;
    case "hub.task.started":
      if (s.hub?.id === b.id) s.hub.runs[b.task] = { ...s.hub.runs[b.task], status: "running", lane: b.lane, attempt: b.attempt };
      break;
    case "hub.task.ended":
      if (s.hub?.id === b.id) s.hub.runs[b.task] = { ...s.hub.runs[b.task], status: b.outcome, attempt: b.attempt, grade: b.grade, tests: b.tests, summary: b.summary, files: b.files };
      break;
    case "hub.merged":
      if (s.hub?.id === b.id) s.hub.status = "merging";
      break;
    case "goal.set":
      s.goal = { text: b.text, ...(b.check ? { check: b.check } : {}), lane: ev.lane ?? MAIN_LANE, by: { id: ev.actor.id, name: ev.actor.name }, seq: ev.seq, checks: 0, nudges: 0 };
      break;
    case "goal.checked": {
      const g = s.goal;
      if (!g) break;
      g.checks++;
      if (b.nudge) g.nudges++;
      g.last = { met: b.met, why: b.why, seq: ev.seq };
      if (b.met) g.met = { seq: ev.seq, why: b.why };
      break;
    }
    case "goal.cleared":
      s.goal = null;
      break;
    case "hub.ended":
      if (s.hub?.id === b.id) Object.assign(s.hub, { status: b.outcome, ...(b.prUrl ? { prUrl: b.prUrl } : {}), ...(b.sha ? { sha: b.sha } : {}), ...(b.why ? { why: b.why } : {}) });
      break;
    case "lane.renamed":
      if (b.laneId === MAIN_LANE) s.mainName = b.name;
      else s.lanes = s.lanes.map((l) => (l.id === b.laneId ? { ...l, name: b.name } : l));
      break;
    case "lane.othersFull":
      (s.othersFull ??= {})[lane] = b.on;
      break;
    case "lane.effort":
      if (b.effort) (s.efforts ??= {})[lane] = b.effort;
      else if (s.efforts) delete s.efforts[lane];
      break;
    case "lead.set":
      s.lead = b.lane;
      // A board whose poster has gone is the new lead's: its reports and the right to post the next go to it (2026-10-28 audit).
      if (s.board && b.lane && s.board.fromLane !== MAIN_LANE && !s.lanes.some((l) => l.id === s.board!.fromLane)) s.board = { ...s.board, fromLane: b.lane, fromName: s.lanes.find((l) => l.id === b.lane)?.name ?? s.board.fromName };
      break;
    case "board.posted":
      s.board = { fromLane: b.fromLane, fromName: b.fromName, seq: ev.seq, tasks: b.tasks.map((t) => ({ ...t, status: "open", rounds: 0 })), ...(b.check ? { check: b.check } : {}) };
      break;
    case "board.checking":
    case "board.checked":
    case "board.released":
    case "board.cancelled": {
      const t = s.board?.tasks.find((x) => x.id === b.id);
      if (!t) break;
      if (b.type === "board.checking") t.checks = { command: b.command, running: true };
      else if (b.type === "board.checked") {
        t.checks = { command: b.command, ok: b.ok, output: b.output, ...(b.skipped ? { skipped: true } : {}) };
        // Failed: back to the agent that did it, as a review that found something does.
        if (!b.ok && !b.skipped) Object.assign(t, { status: "claimed", rounds: t.rounds + 1, reviewer: undefined });
      } else if (b.type === "board.released") {
        Object.assign(t, { status: "open", lane: undefined, name: undefined, reviewer: undefined, checks: undefined, ...(b.to ? { next: b.to } : { next: undefined }) });
        if (b.declined) t.declined = [...new Set([...(t.declined ?? []), b.declined])];
      } else t.status = "cancelled";
      break;
    }
    case "board.claimed":
    case "board.finished":
    case "board.review":
    case "board.reviewed": {
      const t = s.board?.tasks.find((x) => x.id === b.id);
      if (!t) break;
      if (b.type === "board.claimed") Object.assign(t, { status: "claimed", lane: b.lane, name: b.name, next: undefined, why: b.why });
      else if (b.type === "board.finished") Object.assign(t, { status: b.status === "blocked" ? "blocked" : "review", lane: b.lane, name: b.name, report: b.report });
      // An empty lane takes the reviewer off: the one asked ran out of usage, and another is found (agent-mesh boardRunEnded).
      else if (b.type === "board.review") t.reviewer = b.lane ? { lane: b.lane, name: b.name } : undefined;
      else {
        t.review = { ok: b.ok, note: b.note, by: b.name };
        // Passed: done. Found something: back to the agent that did it, which picks it up again.
        if (b.ok) t.status = "done";
        else Object.assign(t, { status: "claimed", rounds: t.rounds + 1, reviewer: undefined });
      }
      break;
    }
    case "wake.set":
      (s.wakes ??= {})[b.id] = { id: b.id, lane, on: b.on, then: b.then, seq: ev.seq, ...(b.auto ? { auto: true } : {}) };
      break;
    case "wake.fired":
    case "wake.cancelled":
      if (s.wakes) delete s.wakes[b.id];
      break;
    case "files.held": {
      const had = s.holds?.[lane]?.paths ?? [];
      (s.holds ??= {})[lane] = { paths: [...new Set([...had, ...b.paths])].slice(0, 60), ...(b.why ? { why: b.why } : {}), seq: ev.seq };
      break;
    }
    case "files.released":
      if (!s.holds?.[lane]) break;
      if (!b.paths?.length) delete s.holds[lane];
      else {
        const left = s.holds[lane]!.paths.filter((p) => !b.paths!.includes(p));
        if (left.length) s.holds[lane]!.paths = left;
        else delete s.holds[lane];
      }
      break;
    case "lane.removed":
      // The board's poster leaving hands the board to the lead (one is made the lead before a teammate goes), or to the lead set
      // next (lead.set): its reports went to nobody, and nobody else could post another (2026-10-28 audit).
      if (s.board?.fromLane === b.laneId && s.lead && s.lead !== b.laneId) s.board = { ...s.board, fromLane: s.lead, fromName: s.lanes.find((l) => l.id === s.lead)?.name ?? s.board.fromName };
      if (s.lead === b.laneId) s.lead = null;
      if (s.holds) delete s.holds[b.laneId];
      for (const w of Object.values(s.wakes ?? {})) if (w.lane === b.laneId || w.on.lane === b.laneId) delete s.wakes![w.id];
      if (s.efforts) delete s.efforts[b.laneId];
      if (s.othersFull) delete s.othersFull[b.laneId];
      s.lanes = s.lanes.filter((l) => l.id !== b.laneId);
      delete s.laneRuns[b.laneId];
      delete s.laneDrivers[b.laneId];
      delete s.lanePending[b.laneId];
      delete s.engines[b.laneId];
      delete s.diffs[b.laneId];
      delete s.resumes[b.laneId];
      delete s.approvals[b.laneId];
      s.pendingRequests = s.pendingRequests.filter((r) => r.lane !== b.laneId);
      delete s.openQuestions[b.laneId];
      delete s.asks[b.laneId];
      // The shepherd hands its fixes to its agent: with that agent gone it went on handing them to nobody.
      if (s.shepherd?.lane === b.laneId) s.shepherd = null;
      break;
    case "engine.expected":
      if (effortResets(s, lane, b)) delete s.efforts![lane];
      // Whose computer it is, whose say: another host starts from the default, others' messages stopping at Edits.
      if (s.othersFull && s.engines[lane]?.hostId !== b.hostId) delete s.othersFull[lane];
      s.engines[lane] = { tool: b.tool, hostId: b.hostId, hostName: b.hostName, cwd: "", mode: "full", online: false, sinceSeq: ev.seq, offlineAt: ev.ts, ...(b.repo ? { repo: b.repo } : {}) };
      break;
    case "engine.attached": {
      // Decided here from the engine it replaces, so every client folding the log drops the same pin on the same attach.
      if (effortResets(s, lane, b.engine)) delete s.efforts![lane];
      if (s.othersFull && s.engines[lane]?.hostId !== b.engine.hostId) delete s.othersFull[lane];
      const repo = s.engines[lane]?.repo;
      s.engines[lane] = { ...(repo ? { repo } : {}), ...b.engine, online: true, sinceSeq: ev.seq };
      break;
    }
    case "engine.detached":
      // A tool waiting mid-turn on an answer went with its connection; its card kept offering a yes nothing could act on.
      if (s.approvals[lane]?.live) delete s.approvals[lane];
      // Handed back to Friday Code, which has its own thinking setting: the pinned effort goes with the tool.
      if (b.reason === "released") {
        delete s.engines[lane];
        if (s.efforts) delete s.efforts[lane];
        if (s.othersFull) delete s.othersFull[lane];
      } else if (s.engines[lane]) s.engines[lane] = { ...s.engines[lane]!, online: false, sinceSeq: ev.seq, offlineAt: ev.ts };
      break;
    case "account.switched":
      // The lane's tool carries on as another of its host's accounts: the header names the one it is on.
      if (s.engines[lane]) s.engines[lane] = { ...s.engines[lane]!, account: b.to };
      break;
    case "folder.switched": {
      // The folder moved, so everything working in it is on the new branch: the header, the review card and the agents all
      // read it from here, and kept naming the branch the agent attached on.
      const cwd = s.engines[lane]?.cwd;
      for (const [id, e] of Object.entries(s.engines)) if (!cwd || id === lane || e.cwd === cwd) s.engines[id] = { ...e, branch: b.branch };
      break;
    }
    case "agent.diff":
      s.diffs[lane] = { seq: ev.seq, base: b.base, files: b.files, ...(b.more?.length ? { more: b.more } : {}) };
      // What a run actually changed is the strongest claim there is: it is
      // not what somebody meant to touch, it is what is now different.
      for (const f of b.files) claim(s, ev, f.path);
      break;
    // A person saving a file from the editor, which is the other way a file
    // in the shared folder changes.
    case "folder.edited":
      claim(s, ev, b.path);
      break;
    // Committing lands everything, so nobody is mid-edit on anything any
    // more. Restoring puts the folder back, which does the same.
    case "folder.committed":
    case "folder.restored":
      s.claims = [];
      s.intents = {};
      // A commit to a new branch moves the folder onto it: the header, the review card, the next commit's suggestion and a
      // hand-off all read the branch from here, and kept the old one, so every commit after offered yet another new branch.
      if (b.type === "folder.committed" && b.prUrl && !b.error && s.pr?.url !== b.prUrl) s.pr = { url: b.prUrl, ...(b.base ? { base: b.base } : {}) };
      if (b.type === "folder.committed" && b.branch && !b.error) {
        const cwd = s.engines[lane]?.cwd;
        for (const [id, e] of Object.entries(s.engines)) if (!cwd || id === lane || e.cwd === cwd) s.engines[id] = { ...e, branch: b.branch };
      }
      break;
    // Stop (Arun, 2026-10-20: "stop its task but not like fully be paused from doing any more work"): the turn under way
    // ends and the agent is free again, so what is queued goes next and new work reaches it, with no Resume to find. Unlike
    // a cancel, nobody's queued messages are thrown away. Its question and a live ask end with the turn they were asked in.
    // A log with an old pause in it reads the same way: no agent is left paused with nothing able to wake it.
    case "run.pause":
      setRun("idle");
      (s.stopped ??= {})[lane] = ev.seq;
      delete s.openQuestions[lane];
      if (s.approvals[lane]?.live) delete s.approvals[lane];
      break;
    case "run.resume":
      setRun("running");
      break;
    case "run.cancel":
      setRun("idle");
      if (lane === MAIN_LANE) s.pendingInstructions = [];
      else s.lanePending[lane] = [];
      // Cancelling one agent settles that agent's question, not another's. A live ask goes too: the turn it waited in is over.
      delete s.openQuestions[lane];
      if (s.approvals[lane]?.live) delete s.approvals[lane];
      break;
    case "run.started":
      setRun("running");
      if (s.stopped?.[lane] !== undefined) delete s.stopped[lane];
      delete s.asks[lane];
      // What started it is being read: out of the queue, as the page has it (client deliveredIn), even where its delivery is a
      // separate event or none came (a log written by hand, a runner cut off between the two).
      if (lane === MAIN_LANE) s.pendingInstructions = s.pendingInstructions.filter((q) => q !== b.causedBy);
      else if (s.lanePending[lane]) s.lanePending[lane] = s.lanePending[lane]!.filter((q) => q !== b.causedBy);
      break;
    case "run.ended":
      // What it held was for this run's work. Not a run cut off by a lost connection, which carries on when it is back, nor
      // one waiting on a person.
      if (b.outcome !== "waiting" && !b.cut && s.holds) delete s.holds[lane];
      if (b.outcome === "done") {
        setRun("idle");
        (s.finished ??= {})[lane] = ev.seq;
      }
      else if (b.outcome === "waiting") setRun("waiting_for_human");
      else setRun("error", b.error);
      break;
    case "suggestion.dismissed": {
      const sug = s.suggestions.find((x) => x.seq === b.seq);
      if (sug) sug.dismissed = true;
      break;
    }
    case "instruction.withdrawn":
    case "instruction.refused":
      s.pendingInstructions = s.pendingInstructions.filter((q) => q !== b.seq);
      for (const l of Object.keys(s.lanePending)) s.lanePending[l] = s.lanePending[l]!.filter((q) => q !== b.seq);
      if (!s.withdrawn.includes(b.seq)) s.withdrawn.push(b.seq);
      break;
    case "instructions.delivered":
      if (lane === MAIN_LANE) s.pendingInstructions = s.pendingInstructions.filter((q) => !b.seqs.includes(q));
      else s.lanePending[lane] = (s.lanePending[lane] ?? []).filter((q) => !b.seqs.includes(q));
      delete s.openQuestions[lane];
      break;
    case "instructions.requeued": {
      // Back at the front, in their order: they were first when they were delivered. Not one taken back since, nor one already waiting.
      const queue = pendingFor(s, lane);
      const back = b.seqs.filter((q) => !s.withdrawn.includes(q) && !queue.includes(q));
      if (lane === MAIN_LANE) s.pendingInstructions = [...back, ...queue];
      else s.lanePending[lane] = [...back, ...queue];
      break;
    }
    case "agent.question":
      // An old log's question has no lane, and was the main agent's: `lane` already says so.
      s.openQuestions[lane] = {
        seq: ev.seq,
        lane,
        question: b.question,
        ...(b.detail ? { detail: b.detail } : {}),
        ...(b.options?.length ? { options: b.options } : {}),
        ...(b.recommended ? { recommended: b.recommended } : {}),
        to: b.to,
        toName: b.toName,
      };
      break;
    case "message.reacted": {
      const at = (s.reactions[b.seq] ??= {});
      if (b.up === null) delete at[ev.actor.id];
      else at[ev.actor.id] = { name: ev.actor.name, up: b.up, ...(b.reason ? { reason: b.reason } : {}) };
      if (!Object.keys(at).length) delete s.reactions[b.seq];
      break;
    }
    case "thread.opened":
      s.threads.push({
        id: b.id,
        path: b.path,
        line: b.line,
        ...(b.endLine ? { endLine: b.endLine } : {}),
        code: b.code,
        removed: Boolean(b.removed),
        text: b.text,
        by: { id: ev.actor.id, name: ev.actor.name },
        ...(b.to ? { to: b.to } : {}),
        ...(b.ask ? { ask: true } : {}),
        replies: [],
        resolved: false,
        seq: ev.seq,
      });
      break;

    case "thread.replied": {
      const t = s.threads.find((x) => x.id === b.id);
      // A reply to a thread that never opened is a reply to nothing: the
      // event is in the log either way, and the projection stays honest by
      // ignoring it rather than inventing a thread to hang it on.
      if (t) t.replies.push({ by: { id: ev.actor.id, name: ev.actor.name }, text: b.text, seq: ev.seq });
      break;
    }

    case "thread.sent": {
      const t = s.threads.find((x) => x.id === b.id);
      if (t) t.sent = { lane: b.lane, seq: ev.seq };
      break;
    }

    case "thread.resolved": {
      const t = s.threads.find((x) => x.id === b.id);
      if (t) {
        t.resolved = true;
        if (b.auto) t.auto = b.auto;
      }
      break;
    }

    case "thread.reopened": {
      const t = s.threads.find((x) => x.id === b.id);
      if (t) {
        t.resolved = false;
        delete t.sent;
        delete t.auto;
      }
      break;
    }

    case "mesh.replied": {
      const a = s.mesh?.asks[b.id];
      if (a && !a.reply) a.reply = { text: b.text, seq: ev.seq, ...(b.auto ? { auto: true } : {}), ...(b.short ? { short: true } : {}) };
      break;
    }
    case "mesh.unwaited": {
      const a = s.mesh?.asks[b.id];
      if (a && a.unwaitedSeq === undefined) a.unwaitedSeq = ev.seq;
      break;
    }
    case "mesh.posted": {
      const m = (s.mesh ??= { paused: null, asks: {}, msgs: [] });
      m.posts = [...(m.posts ?? []), { seq: ev.seq, id: b.id, fromLane: b.fromLane, fromName: b.fromName, text: b.text, ts: ev.ts }].slice(-MAX_POSTS);
      break;
    }
    case "mesh.read": {
      const m = (s.mesh ??= { paused: null, asks: {}, msgs: [] });
      m.readUpTo = { ...m.readUpTo, [lane]: Math.max(m.readUpTo?.[lane] ?? 0, b.upTo) };
      break;
    }
    // An old log's pause of agent talk holds nothing back now: agent talk is never paused (Arun, 2026-10-20).
    case "mesh.paused":
      if (s.mesh) s.mesh.paused = null;
      break;
    case "memory.saved": {
      const at = s.memory.findIndex((m) => m.key === b.key);
      const entry = { key: b.key, text: b.text, seq: ev.seq };
      if (at === -1) s.memory.push(entry);
      else s.memory[at] = entry;
      break;
    }
    case "agent.message":
      // A revised plan is a different plan: what people said of the old one doesn't carry over.
      if (b.toolCalls.some((c) => c.name === "update_plan")) delete s.planReviews[lane];
      // The files a plan names are what the agent means to change: kept, so an overlap with another agent shows before it writes.
      {
        const plan = b.toolCalls.filter((c) => c.name === "update_plan" || c.name === "todo" || c.name === "TodoWrite");
        const paths = plan.length ? pathsIn(plan.map((c) => c.arguments).join("\n")) : [];
        if (paths.length) (s.intents ??= {})[lane] = { paths, seq: ev.seq };
        const steps = plan.length ? planStepsOf(plan.at(-1)!.arguments) : null;
        if (steps) (s.planDone ??= {})[lane] = steps;
      }
      {
        // Only a coding tool's: Friday's own agents ask with ask_human. Whatever it says next, its last words decide.
        const questions = s.engines[lane] && !b.toolCalls.length && !b.interrupted ? parseAsks(b.text) : [];
        if (questions.length) s.asks[lane] = { seq: ev.seq, questions };
        else delete s.asks[lane];
      }
      break;
    case "run.interrupt":
    case "tool.result":
      break;
  }
  return s;
}

export function project(id: string, events: SessionEvent[]): SessionState {
  const s = initialState(id);
  for (const ev of events) apply(s, ev);
  return s;
}

export interface PlanReview {
  name: string;
  verdict: "approve" | "changes";
  note?: string;
  seq: number;
}

/**
 * Where a plan stands with the team, for the person about to approve it.
 *
 * The approver's own opinion isn't a sign-off: the point is a second pair of
 * eyes. And the count is capped by the people there are to ask, so a session
 * with one other editor can't be made to wait on three.
 */
export function signoffStatus(s: SessionState, lane: string, approverId: string): { need: number; have: number; changes: (PlanReview & { id: string })[]; ready: boolean } {
  const others = Object.entries(s.members).filter(([id, m]) => id !== approverId && !m.removed && m.role !== "viewer");
  const need = Math.min(Math.max(0, s.options.signoff | 0), others.length);
  const reviews = Object.entries(s.planReviews[lane] ?? {}).filter(([id]) => id !== approverId && s.members[id] && !s.members[id]!.removed && s.members[id]!.role !== "viewer");
  const have = reviews.filter(([, r]) => r.verdict === "approve").length;
  const changes = need > 0 ? reviews.filter(([, r]) => r.verdict === "changes").map(([id, r]) => ({ id, ...r })) : [];
  return { need, have, changes, ready: changes.length === 0 && have >= need };
}
