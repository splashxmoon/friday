import type { SelfRun } from "./team-selfrun.js";
import type { Hold, MateBudget } from "./team-budget.js";
import type { Proof } from "./team-proof.js";
import { mkdir } from "node:fs/promises";
import { CUT_OFF_CHECK } from "./handoff.js";
import { homedir } from "node:os";
import path from "node:path";
import type { GoAhead } from "./guardrails.js";
import type { Redis } from "ioredis";
import { isOwnModel, ownModelParts } from "./own-model-id.js";
import { cleanCheckIn, MAX_CHECKINS, type CheckIn } from "./teammate-checkins.js";
import { EFFORT_LEVELS, ENGINE_MODEL_INFO, ENGINE_NAMES, ENGINE_TOOLS, isEngineEffort, type EngineEffort, type EngineMode, type EngineTool } from "./types.js";
import { cleanProject, type RoomProject } from "./room-project.js";

/**
 * Teammates: persistent AI teammates on this computer (Arun, 2026-10-27: "i think my local build should be like open bot:
 * Persistent AI teammates on your own computer. and whatever they do").
 *
 * A teammate is a name, a role, one of the person's own coding tools (on their own account) and a folder of its own, and it
 * keeps one conversation going for good, across restarts. They all live as lanes of one private session, the team: it is the
 * Team room where they work and talk to each other, and each one's own chat is its lane. They finish what they are given (what
 * is queued, what teammates ask, the check-ins the person sets), and never start new work on their own.
 *
 * Every teammate runs on the person's own accounts doing the person's work only (own-plan.ts): the team session has nobody
 * else in it, each start pins the account picked, and none ever moves to another account by itself.
 *
 * Or on one of the person's own models (Settings › Your models: an OpenAI-format server such as Ollama or LM Studio, or a
 * provider on their key), through Friday Code (Arun, 2026-10-27: "be able to run your own models and stuff for teammates as
 * well"): `tool` "friday", `model` that model's id. Its lane is driven by Friday's own agent loop (agent/runtime.ts laneOwn) in
 * its folder, lent by a runner with no coding tool behind it; it has no usage limits of Friday's, so no backup and no switch.
 *
 */

/**
 * What a teammate runs on: one of the person's coding tools, or "friday", Friday Code on one of their own models (`model`).
 * A record from before own models has a coding tool, which still reads as one.
 */
export type MateTool = EngineTool | "friday";

/** Whether a teammate runs on one of the person's own models, through Friday Code, rather than on a coding tool. */
export const onOwnModel = (t: { tool: MateTool }): t is { tool: "friday" } => t.tool === "friday";

/** What a teammate runs on, in words for its note and the agents' lists: its coding tool, or the person's own model. */
export const runsOnName = (t: { tool: MateTool }): string => (t.tool === "friday" ? "own model, through Friday Code" : ENGINE_NAMES[t.tool]);

export interface Teammate {
  id: string;
  name: string;
  /** What it is for, in the person's words: its standing instructions. */
  role: string;
  tool: MateTool;
  /** One of its tool's own models; empty is the tool's default. On "friday", the person's own model it runs on (`own:<them>:<id>`). */
  model?: string;
  /** The tool it switches to when its own runs out of usage (limit), to carry the work on; absent is the other of Claude Code and Codex. */
  backup?: EngineTool;
  /**
   * Its fallbacks, in order (Arun, 2026-11-15: "add orders of fallbacks ... like claude to codex as a fall back for codex, open
   * code etc"): out of usage on its own tool it goes to the first that is ready, and when that runs out too, to the next. Set, it
   * takes the place of `backup`.
   */
  backups?: (EngineTool | Fallback)[];
  /** Out of usage: "ask" holds the switch until the person says (Arun, 2026-11-15: "ask before switching to another model/tool"); absent switches on its own. */
  onLimit?: "ask";
  /** A switch waiting on the person: where it ran out, what it would go to, and when its own tool said it is back. */
  switchAsk?: { to: EngineTool; from: EngineTool; sid: string; lane: string; endSeq: number; resetsAt: number | null; at: number };
  /** On its backup now: the tool it ran out on, when that lifts (null when it didn't say) and when it switched. */
  switched?: { from: EngineTool; fromModel?: string; fromAccount?: string; fromEffort?: EngineEffort; until: number | null; at: number };
  /** What it does by itself on a schedule (CheckIn): a stand-up, a sweep of new issues, a weekly write-up. */
  checkins?: CheckIn[];
  /** How hard its tool thinks, for a tool that takes a level (EFFORT_LEVELS); absent is the tool's own (Auto). */
  effort?: EngineEffort;
  /** Which of its tool's accounts on this computer it runs as (runner/accounts.ts); absent is the tool's own sign-in. */
  account?: string;
  /** The seed of its robot (DiceBear's Bottts, Teammates.tsx): picked in the dialog, kept when it is renamed. */
  look?: string;
  /** Its own folder, where it starts and keeps its things: ~/Friday/teammates/<Name> unless picked. */
  folder: string;
  /** The folders and repos it works in besides its own, reached beside its folder (the tool's extra folders), so its conversation carries on. */
  projects?: string[];
  /** Before 2026-10-27 a teammate had one: read as `projects` (projectsOf). */
  project?: string;
  /** Its lane in the team session. */
  lane: string;
  /**
   * Which of your other computers it runs on, by its id there (local/computers.ts), when not this one: its tool, its folder
   * (~/Friday/teammates/<Name> on that computer) and the folders it works in are that computer's (Arun, 2026-10-30: "multi
   * machine for coding and crew").
   */
  machine?: string;
  /**
   * How far its tool may go: absent is full. One an agent made runs at no more than that agent may itself (2026-10-27 audit: a
   * plan-mode agent made a full-mode teammate in a repo, then told it what to do).
   */
  mode?: EngineMode;
  /**
   * The go-aheads it may take on its own (Arun, 2026-11-15: "Trust that grows"): asked of it no more, Friday answering yes as the
   * person and leaving a receipt (app.ts trustAnswer). Given after a run of yeses, from its card, and taken back in its Decisions.
   */
  trust?: GoAhead[];
  /**
   * The agent that added it (manage_teammate create), when one did: the person keeps it or removes it (teammate.proposed), and it
   * works meanwhile. Cleared once they keep it.
   */
  madeBy?: { lane: string; name: string };
  /** Its daily caps and its work and quiet hours (team-budget.ts): nothing is capped unless set. */
  budget?: MateBudget;
  created: number;
}

/** A teammate's work over a stretch, from the runs on its lanes in the Team room and its rooms. */
export interface MateUsage {
  turns: number;
  minutes: number;
  /** As its tools counted them, where they said. */
  tokens?: number;
}

/** A teammate as the app shows it: its record and how it stands right now. */
export interface TeammateView extends Teammate {
  /** stopped: its last run ended on an error (its tool failed to start, signed out): said in red, never as idle or done (Arun,
   *  2026-10-29: "Yes, fix them", the redesign's leftovers). */
  status: "working" | "waiting" | "idle" | "offline" | "limited" | "stopped";
  /** One line of what it is doing, or did last. */
  line: string;
  /** How many messages wait for it. */
  queued: number;
  /** When it last did anything, anywhere it works: for the order of the Crew's conversation list (Sidebar B, 2026-11-03). */
  lastAt?: number;
  /** On its own model, what keeps it from running, said to the person: the model gone from Settings, or its server not answering. */
  problem?: string;
  /** How far its tool may go, always said (Teammate.mode absent is full). */
  mode: EngineMode;
  /** On hold as the person said (held.ts) on any of its lanes: POST /api/teammates/:id/lift lets it go on. */
  held: boolean;
  /** Its turns, minutes and tokens today (since local midnight) and over the last seven days. */
  usage: { today: MateUsage; week: MateUsage };
  /** Why it takes no new turn now, for its budget or hours (team-budget.ts Hold), and when it carries on. */
  hold?: Hold;
  /** Its last turn was stopped by a person (a stop, Stop all) and it hasn't run since: no finish to mark (audit CREW-40). */
  halted?: true;
  /** What its home chat is about: the first thing the person said there (team-views.ts), for its tab on its page. */
  homeTitle?: string;
}

/** Away mode (team-away.ts): the person away until `until`, since `since`. */
export interface TeamAway {
  until: number | null;
  since: number | null;
}

/** One run of a teammate's, anywhere it works, for its Activity and Results (GET /api/teammates/:id/activity). */
export interface MateRun {
  sid: string;
  /** The room's name, or null in the Team room. */
  room: string | null;
  lane: string;
  startedAt: number;
  endedAt: number | null;
  outcome: "done" | "waiting" | "error" | "running" | "stopped";
  /** Its last words in the run. */
  said: string;
  /** Files it changed in the run. */
  files: string[];
  /** What shows the work in it worked (team-proof.ts), for a run that changed files or handed proof in. */
  proof?: Proof;
}

/** How many folders and repos a teammate works in besides its own. */
export const MAX_PROJECTS = 8;

/** The folders and repos a teammate works in besides its own, from a record of either age. */
export const projectsOf = (t: Pick<Teammate, "projects" | "project">): string[] => t.projects ?? (t.project ? [t.project] : []);

/**
 * A room: some of the team, picked, working together on one thing, in a session of its own (Arun, 2026-10-27: "build multiple
 * Team rooms: each room has its own teammates picked from the team, and a teammate can be in more than one"). A teammate in a
 * room is a lane of it, its tool started again there with a conversation of its own for that room (roomKeep); its folder, its
 * projects and its notes are the same in every room. The Team room, with everyone, is the team session itself.
 */
export interface Room {
  id: string;
  name: string;
  sid: string;
  /** Each member's lane in the room, by teammate id, in the order they joined. */
  lanes: Record<string, string>;
  /** What it is for, in the person's words: told to its teammates with every turn there. */
  purpose?: string;
  /**
   * Folders every crew mate in it may work in here, on top of those from its own page, which it brings with it (Arun, 2026-11-15:
   * "be able to add and remove folders the agents can work in ... but by default they will carry over the folders they work in
   * from their own individual pages"). Whole paths on this computer.
   */
  folders?: string[];
  created: number;
  /** Who made it, on the hosted service: its rooms are capped per person (crew-room-cap.ts). */
  by?: string;
  /**
   * A thread of one crew mate's, by its id: a conversation of its own with the person, apart from its main chat (Arun, 2026-11-15:
   * "adding new threads and stuff when chatting with the agents"). Kept as a room of one, so it has its own session and its own
   * conversation with its tool (roomKeep), and listed in that crew mate's chat rather than with the rooms.
   */
  thread?: string;
  /**
   * A thread made for work handed on from a coding session ("Keep this going", crew-carry.ts): its crew mate works in a copy of that
   * session's folder of its own (`cwd`, copied on its first start, what is uncommitted carried in with `carry`), not its own
   * project, and keeps that copy when it starts again. `from` is the coding session.
   */
  work?: { cwd: string; carry?: boolean; from: string };
  /**
   * The repo its work is on, and the branch that work starts from (splashxmoon/friday-code#24): a reference each crew mate's own copy
   * is found by (room-project.ts), never a checkout or the room's folder. Absent: No project. Named rooms only, not threads.
   */
  project?: RoomProject;
}

/** What a new thread is called until the person's first message names it (team-views.ts). */
export const NEW_THREAD = "New thread";
/** How many threads one crew mate keeps. */
export const MAX_THREADS = 40;

/** How many rooms a team keeps (on the hosted service, how many each person keeps: crew-room-cap.ts). */
export const MAX_ROOMS = 20;

/** A teammate's conversation in a room: its own, beside the one it has in the team (Runner keepAs). */
export const roomKeep = (teammateId: string, roomId: string) => `${teammateId}.${roomId}`;

/** A room's details as sent by the page, checked; throws with what is wrong. */
/** A crew mate's trust as the page sends it: go-aheads only, once each, never a sign-in (that is a hand-off, not a yes). */
export function cleanTrust(v: unknown): GoAhead[] | undefined {
  const all: GoAhead[] = ["outside", "ship", "delete", "money", "keys", "computer"];
  const t = Array.isArray(v) ? [...new Set(v.filter((x): x is GoAhead => typeof x === "string" && (all as string[]).includes(x)))] : [];
  return t.length ? t : undefined;
}

/** How many folders a room adds for its crew mates. */
export const MAX_ROOM_FOLDERS = 12;

export function cleanRoom(body: Record<string, unknown>, known: readonly string[]): { name?: string; members?: string[]; purpose?: string; folders?: string[]; /** null: take the project off. */ project?: RoomProject | null } {
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : undefined;
  if (name !== undefined && !name) throw new Error("Give the room a name.");
  const members = Array.isArray(body.members) ? [...new Set(body.members.filter((m): m is string => typeof m === "string"))] : undefined;
  if (members && !members.length) throw new Error("Pick at least one agent for the room.");
  if (members && members.length > MAX_TEAMMATES) throw new Error(`A room has up to ${MAX_TEAMMATES} crew mates.`);
  if (members?.some((m) => !known.includes(m))) throw new Error("One of those isn't in your crew any more.");
  const purpose = typeof body.purpose === "string" ? body.purpose.trim().slice(0, 2000) : undefined;
  let folders: string[] | undefined;
  if (body.folders !== undefined) {
    if (!Array.isArray(body.folders)) throw new Error("Folders are a list of folders.");
    folders = [...new Set(body.folders.filter((f): f is string => typeof f === "string").map((f) => f.trim().replace(/^~(?=$|[\\/])/, homedir()).replace(/[\\/]+$/, "")).filter(Boolean))];
    if (folders.some((f) => !path.isAbsolute(f) || f.split(/[\\/]/).includes(".."))) throw new Error("Give each folder as its whole path on this computer.");
    if (folders.length > MAX_ROOM_FOLDERS) throw new Error(`A room adds up to ${MAX_ROOM_FOLDERS} folders.`);
  }
  const project = cleanProject(body.project);
  return { ...(name !== undefined ? { name } : {}), ...(members ? { members } : {}), ...(purpose !== undefined ? { purpose } : {}), ...(folders ? { folders } : {}), ...(project !== undefined ? { project } : {}) };
}

/** The tool a teammate switches to when its own runs out: the one it picked, or the other of Claude Code and Codex. */
export const backupOf = (t: Pick<Teammate, "tool" | "backup" | "backups" | "switched">): EngineTool => backupsOf(t)[0] ?? (t.tool === "claude" ? "codex" : "claude");

export { backupsOf, cleanBackups, fallbackFor, fallbacksOf, MAX_BACKUPS, type Fallback } from "./teammate-backups.js";
import { backupsOf, fallbackFor, type Fallback } from "./teammate-backups.js";

export { checkInDue, checkInText, cleanCheckIn, describeCheckIn, MAX_CHECKINS, missedSlot, NO_UPDATE, quietCheckIns, type CheckIn } from "./teammate-checkins.js";

/**
 * A teammate put on its backup tool as its own runs out of usage (the open-source edition's and the hosted service's one rule): the
 * backup's routing model when it has one, its effort if the backup takes that level, no account (the one picked is its own
 * tool's, never lent to another), and what it ran on before to go back to. Null when there is nothing to switch to.
 */
export function onBackup<T extends Teammate>(t: T, resetsAt: number | null, now = Date.now(), pick?: EngineTool): (T & { tool: EngineTool }) | null {
  if (t.tool === "friday") return null;
  const to = pick ?? backupOf(t);
  if (to === t.tool) return null;
  const routes = ENGINE_MODEL_INFO[to].some((m) => m.id === "auto");
  // The model and effort set for that fallback, else its routing model and the effort it had, where that tool takes it.
  const f = fallbackFor(t, to);
  const model = f?.model ?? (routes ? "auto" : undefined);
  const effort = f?.effort ?? (t.effort && (EFFORT_LEVELS[to] ?? []).includes(t.effort) ? t.effort : undefined);
  // Already on a fallback that ran out too: on to the next, still going back to its own tool when that is back.
  if (t.switched) return { ...t, tool: to, model, effort, account: undefined, switchAsk: undefined };
  return {
    ...t,
    tool: to,
    model,
    effort,
    account: undefined,
    switchAsk: undefined,
    switched: { from: t.tool, ...(t.model ? { fromModel: t.model } : {}), ...(t.account ? { fromAccount: t.account } : {}), ...(t.effort ? { fromEffort: t.effort } : {}), until: resetsAt, at: now },
  };
}

/** When a switched teammate goes back to its own tool: when its limit lifts, or five hours on when it never said. */
export const backAt = (sw: NonNullable<Teammate["switched"]>) => sw.until ?? sw.at + 5 * 3_600_000;

/** A switched teammate back on its own tool, model, account and effort. */
export const offBackup = <T extends Teammate>(t: T): T => (t.switched ? { ...t, tool: t.switched.from, model: t.switched.fromModel, account: t.switched.fromAccount, effort: t.switched.fromEffort, switched: undefined } : t);

/** What a teammate on its backup is told as it carries on: where it was, as the turn that ran out (handoff.ts handoffBrief). */
export const backupText = (from: EngineTool, to: EngineTool, brief: string) =>
  `[Friday] ${ENGINE_NAMES[from]} ran out of usage partway through your work, so you are on ${ENGINE_NAMES[to]} now. Carry on where you left off and finish it. ${CUT_OFF_CHECK}${brief ? `\n\n${brief}` : ""}`;

/** A teammate's memory, in its own folder: read into its note with every turn, editable by the person. */
export const MEMORY_FILE = "MEMORY.md";
/** How much of it is read into the note: its first page or so. */
export const MEMORY_MAX = 6000;

/**
 * A teammate's memory as it is read into its turns: all of it up to a page; past that its newest page, from a line's start, with a
 * word to tidy it (2026-11-11 audit: its first page was read, so what it learned most recently was what it never saw, and nobody
 * was told). Coding tools append to the file with their own tools, so the end is the newest.
 */
export function memoryText(m: string): string {
  if (m.length <= MEMORY_MAX) return m;
  const note = `[Friday] Your memory (${MEMORY_FILE}) is ${m.length.toLocaleString("en-US")} characters, over a page, so only its newest part is here. Tidy it: merge what repeats, drop what's stale, keep it under a page.\n\n`;
  const tail = m.slice(-(MEMORY_MAX - note.length));
  const cut = tail.indexOf("\n");
  return note + (cut >= 0 && cut < 400 ? tail.slice(cut + 1) : tail);
}

/** A session runs up to twelve lanes beside its main one (SESSION_LANES): the team's size. */
export const MAX_TEAMMATES = 12;

/**
 * Which worktree already has `branch` checked out, from `git worktree list --porcelain`, or null. A teammate's copy of a shared repo
 * is kept on its own branch (app.ts copyFor), and git refuses to check one branch out twice: a copy made at another path (before
 * the home folder moved, or by an older build) is the teammate's copy, found again after a restart rather than refused, which
 * left the teammate in the shared repo itself (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
 */
export function worktreeHolding(porcelain: string, branch: string): string | null {
  for (const block of porcelain.split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const at = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
    if (at && lines.some((l) => l.trim() === `branch refs/heads/${branch}`)) return at.trim();
  }
  return null;
}

/** Where a teammate keeps its things when no folder is picked: ~/Friday/teammates/<Name>, the name made safe for a folder. */
export function defaultFolder(name: string, home = homedir()): string {
  const safe = name.replace(/[^\p{L}\p{N} ._-]+/gu, "").replace(/\s+/g, " ").trim().slice(0, 40) || "Teammate";
  return path.join(home, "Friday", "teammates", safe);
}

/**
 * A teammate's details as sent by the page, checked; throws with what is wrong. `owner`: who the team is, the only person whose
 * own models a teammate may run on (own-plan.ts: a person's own model runs their work only); without it none may be picked.
 */
export function cleanTeammate(body: Record<string, unknown>, tools: readonly string[] = ENGINE_TOOLS, owner?: string): Pick<Teammate, "name" | "role" | "tool"> & Partial<Pick<Teammate, "model" | "account" | "folder" | "projects" | "look" | "effort" | "backup" | "checkins" | "mode" | "machine">> {
  const s = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  // Letters, digits, spaces and . _ - ' only: a name is how it is @-named, and "C++" or "Nova!" never could be.
  const name = s(body.name, 40).replace(/[^\p{L}\p{N} ._'-]+/gu, "").replace(/\s+/g, " ").trim();
  if (!name) throw new Error("Give your teammate a name: letters, numbers and spaces.");
  const tool = s(body.tool, 20) as MateTool;
  const own = tool === "friday";
  if (!own && !tools.includes(tool)) throw new Error("Pick which coding tool it runs on.");
  // On the person's own model: one of theirs, by its id, and never somebody else's (Arun, 2026-10-27: "be able to run your own
  // models and stuff for teammates as well"). A coding tool's model is its own name, never an own model's id.
  const model = s(body.model, 200);
  if (own && !(isOwnModel(model) && !!owner && ownModelParts(model)?.owner === owner)) throw new Error("Pick one of your own models for it to run on (Settings › Your models).");
  // On another computer of yours: its id there, or "" for this one. Its paths are that computer's, kept as written (~ is its home).
  // An id is 16 hex characters in the open-source edition (local/computers.ts) and 12 on the hosted service (link/registry.ts).
  const machine = "machine" in body ? (typeof body.machine === "string" && /^[0-9a-f]{12}(?:[0-9a-f]{4})?$/.test(body.machine) ? body.machine : "") : null;
  const folder = s(body.folder, 600);
  if (folder && !path.isAbsolute(folder.replace(/^~(?=$|\/)/, homedir()))) throw new Error("Its folder has to be a full path, like ~/Friday/teammates/Nova.");
  // A list (`projects`), or the one (`project`) as the page sent it before; absent, none was said.
  const home = (p: string) => (machine ? p : p.replace(/^~(?=$|\/)/, homedir()));
  const said = Array.isArray(body.projects) ? body.projects : "project" in body ? [body.project] : null;
  const projects = said ? [...new Set(said.map((p) => home(s(p, 600))).filter(Boolean))] : null;
  if (projects?.some((p) => !path.isAbsolute(p.replace(/^~(?=$|\/)/, "/")))) throw new Error("A folder it works in has to be a full path, like ~/code/site.");
  if (projects && projects.length > MAX_PROJECTS) throw new Error(`A teammate works in up to ${MAX_PROJECTS} folders besides its own.`);
  return {
    name,
    role: s(body.role, 4000),
    tool,
    ...(own ? { model } : model && !isOwnModel(model) ? { model: s(body.model, 60) } : {}),
    // An account, a backup and an effort level are a coding tool's: a teammate on its own model has none of them.
    ...(!own && s(body.account, 40) ? { account: s(body.account, 40) } : {}),
    ...(s(body.look, 40) ? { look: s(body.look, 40) } : {}),
    // A level its tool takes, or none: one it doesn't is dropped rather than refused, as a tool changed in the same edit may not.
    ...(Array.isArray(body.checkins)
      ? { checkins: body.checkins.slice(0, MAX_CHECKINS).flatMap((c, i) => cleanCheckIn(c, `c${Date.now().toString(36)}${i}`) ?? []) }
      : {}),
    ...(!own && typeof body.backup === "string" && tools.includes(body.backup) && body.backup !== tool ? { backup: body.backup as EngineTool } : {}),
    ...(!own && isEngineEffort(body.effort) && (EFFORT_LEVELS[tool] ?? []).includes(body.effort) ? { effort: body.effort } : {}),
    ...(body.mode === "plan" || body.mode === "edits" || body.mode === "full" ? { mode: body.mode } : {}),
    ...(folder ? { folder: folder.replace(/^~(?=$|\/)/, homedir()) } : {}),
    ...(projects ? { projects } : {}),
    // Said: that computer, or back on this one (undefined, which is dropped as it is kept).
    ...(machine !== null ? { machine: machine || undefined } : {}),
  };
}

/** Makes a teammate's folder if it isn't there. */
export async function makeFolder(folder: string): Promise<void> {
  await mkdir(folder, { recursive: true });
}

/**
 * What a teammate's tool is told with every turn, besides Friday's own note: who it is, what it is for, where it works and how
 * the team works. Read from its record each turn, so a changed role applies from the next.
 */
export function teammateNote(t: Teammate, team: readonly Pick<Teammate, "name" | "tool" | "role">[], room?: { name: string; with: string[]; purpose?: string; /** The Team room's session, where the rest of the team is reached. */ team?: string; /** One of its own threads with the person, not a room. */ thread?: boolean; /** Folders the room adds for its crew mates (Room.folders). */ folders?: string[] }, memory = "", copy?: { repo: string; path: string; branch: string }, /** Said another way where Friday keeps it elsewhere: who it is, and where its memory is and how it adds to it. */ kept?: { intro: string; memory: string; how: string }): string {
  const others = team.filter((o) => o.name !== t.name);
  const who = (o: Pick<Teammate, "name" | "tool" | "role">) => `${o.name} (${o.tool === "friday" ? "own model" : ENGINE_NAMES[o.tool]}${o.role ? `: ${o.role.split("\n")[0]!.slice(0, 80)}` : ""})`;
  // In a room only its members are lanes beside it, reachable with message_agent; the rest of the team is in the Team room
  // (2026-10-28 audit: a room's note offered the whole team, and message_agent to one not there failed).
  const here = room ? others.filter((o) => room.with.includes(o.name)) : others;
  const away = room ? others.filter((o) => !room.with.includes(o.name)) : [];
  return [
    ...(room?.thread ? [`This is one of your threads with the person${room.name !== NEW_THREAD ? `, "${room.name}"` : ""}: a conversation of its own, apart from your main chat and your other threads. Your folder, notes and memory are the same in all of them.`] : []),
    ...(room && !room.thread ? [`You are in the room "${room.name}"${room.with.length ? ` with ${room.with.join(", ")}` : ", on your own"}: what is said here is about this room's work. You have a conversation of your own in each room you are in; your folder and notes are the same in all of them.${room.purpose ? ` The room is for: ${room.purpose}` : ""}${room.folders?.length ? ` In this room you may also work in ${room.folders.join(", ")}.` : ""}`] : []),
    kept ? kept.intro : `You are ${t.name}, one of the person's AI teammates in Friday, running on their ${runsOnName(t)} on their own computer.`,
    t.role ? `Your role, in their words: ${t.role}` : "You have no set role: help with whatever you are given.",
    projectsOf(t).length
      ? `You work in ${projectsOf(t)[0]}${projectsOf(t).length > 1 ? `, and also in ${projectsOf(t).slice(1).join(", ")}` : ""}: the person's project${projectsOf(t).length > 1 ? "s" : ""}, where the work is done. Your own folder, ${t.folder}, is for your notes and anything of yours.`
      : `Your own folder is ${t.folder}: keep your notes and anything of yours there, and do the work in it until the person gives you a project.`,
    here.length ? `${room ? "Your teammates in this room" : "Your teammates"}: ${here.map(who).join("; ")}. Message, ask or hand them work with Friday's agent tools when it is theirs to do, and answer them when they ask.` : room ? "Nobody else is in this room." : "You are the only teammate for now.",
    ...(away.length ? [`The rest of the crew isn't in this room: ${away.map(who).join("; ")}. Reach them with message_session to the Crew room${room?.team ? ` (session ${room.team})` : ""}, naming them as agent, or to the room they are working in (the rooms are listed with your turns); read_session reads where another room stands.`] : []),
    // Its own copy of a repo it shares with other teammates (a git worktree), so none of them edits over another (2026-10-28).
    ...(copy ? [`Other teammates work in ${copy.repo} too, so you have a copy of your own: ${copy.path}, on the branch ${copy.branch}. Work and commit there, on that branch, never in ${copy.repo} itself. Before a new task, bring it up to date with the branch the crew's goal is on (git merge it). The lead merges everyone's branches into one pull request.`] : []),
    "Finish what you are given: what the person sends you, what your teammates ask, and the check-ins the person set. When nothing is left, stop and say so in one line. Never start new work of your own accord.",
    "Before you change files in a project another teammate may be in, claim them with Friday's claim_files, so you don't edit over each other.",
    // What reaches the room, as OpenBot's channels have it (Arun, 2026-10-27: "keep the room chat clean and clear"): the answer,
    // once; the coordination among teammates kept to the agent tools, where the room folds it to a line.
    "What you say ends up in the crew's chat, which the person reads. Lead with the answer and give the shortest complete one: the outcome, what blocks you, what you need from them, in a few lines; no setup, no narration, no acknowledgements, no recap of what others said. Say your result once and end the turn: don't repeat it, and don't add a closing line. Keep the coordination with your teammates to Friday's agent tools (message, ask, post_update, tasks) rather than your reply. When nothing needs the person to read it (a routine check, nothing new, still waiting), end without any text. Your steps stay in your own chat. Name a file you made, a picture or a video by its path in backticks and it shows there.",
    // A reply is a chat message, and what it made is a file attached to it (Arun, 2026-11-15: "make the agent responses in crew and
    // crew rooms feel like responses like short ... THE CHAT NEEDS TO FEEL CLEAN AND SIMPLE AND EASY TO UNDERSTAND NOT EXTRA BS").
    "Write as you would in a chat with a colleague: plain sentences, usually under 80 words, no headings, a list only when the answer is a list.",
    // Answers in the chat, files only when asked for (Arun, 2026-11-18: "see the logic for the agents always writing docs", as
    // Claude Code, OpenBot and DuskBot keep it): every plan, report and finding used to go to a .md file nobody asked for.
    "Your answer is your reply, in the chat: findings, plans, research and reviews go there, as short as they can be, never into a report, notes or summary file. Don't create documentation or Markdown files unless the person asked for that file, or it is a deliverable they will keep using (a document they asked you to write, a changelog the project keeps). When you do make one, name it by its path in backticks in a sentence and it shows under your message. Your scratch work stays out of the person's way; anything that will be stale within a week belongs in the conversation, not in a file or your memory.",
    // Friday's browser, which the person watches beside the chat (agent-mesh.ts BROWSER_TOOL; Arun, 2026-11-15: "make sure the agents
    // also have access to the browser too").
    "To look something up, read a page or check a site, use Friday's browser tool when you have it: the page opens beside your chat, where the person can watch. Never launch or install a browser of your own.",
    // How it works and replies as a teammate, after Rakazo's and OpenBot's agents (Arun, 2026-11-15: "look at their github repos, i
    // want to see how their agents function and reply, we need ours to be the same"; "do all five").
    "On a task that will take minutes, start with one line: what you understood, what you look at first, and about how long it takes. A quick answer gets no preface. While you work, post an update only when a finding changes the plan, something fails, or you need the person; never only to say you are still working.",
    "Finish the whole request before you stop. Never end by asking whether to go on, and never end on what you are about to do (\"I'll now run the tests\") without doing it.",
    "When you finish, lead with the verdict, then the key facts, then anything you couldn't check. Say done only once you have checked the result; otherwise say where it stands (drafted, waiting, blocked) and why.",
    "Ask the person only what you can't find out yourself: one question at a time, with the likely answers to pick from.",
    // Recurring work is a routine of its own, run here (Arun, 2026-11-23: Ivy, asked to track the downloads daily, made a Code
    // automation, which ran as a coding session apart from its chat).
    "When the person asks you to do something regularly (every day, each morning, weekly), make it one of your routines with Friday's manage_routine: it runs here, in your chat, and you report here. Not an automation, unless they ask for one.",
    "Before anything leaves this computer (an email, a message, a post, a comment, a release, a deploy, a payment), show it with Friday's propose_send and wait for the person's answer. Never send it on your own.",
    "If the person writes while you are working, answer a question in one line, take in a correction, and carry on from where you are without starting over.",
    "When you hand work to a teammate, write the message so it stands on its own: the goal, what they need to know, what they may do, and what finished looks like. What a teammate reports is theirs: check it before you pass it on as yours, or say it is unverified. In a room, speak when you are addressed or have something useful to add.",
    // How a teammate answers work it was handed, and keeps to its own, as OpenBot's agent communication policy has it.
    `When a teammate handed you the work, end with four short lines: Status (done, partly, blocked), Result (what you made or found), Evidence (files, tests, links), Unblock (what you need, or nothing). Never hand a task back to whoever gave it to you; say what blocks you instead. Decisions the crew should keep to go in ${onOwnModel(t) ? "remember" : "write_note"}.`,
    // Friday Code reaches only the folder it works in, which may be a project rather than its own: it keeps its memory with a
    // tool of its own (update_memory) instead of editing the file.
    `Your memory is ${kept ? kept.memory : path.join(t.folder, MEMORY_FILE)}: what you learn that you will want next time (how the person likes things, where things are, what didn't work). ${kept ? kept.how : onOwnModel(t) ? "Add to it with update_memory as you go" : "Add to it as you go"}, in short lines; keep it under a page.${memory.trim() ? `\nWhat it holds now:\n${memory.trim()}` : " It is empty so far."}`,
  ].join("\n");
}

/** The teammates and the team session, kept in the local store like the automations are. */
export class TeammateStore {
  constructor(
    protected redis: Redis,
    protected prefix: string,
  ) {}

  private key = () => `${this.prefix}teammates`;
  private teamKey = () => `${this.prefix}teammates:team`;

  async list(): Promise<Teammate[]> {
    const all = await this.redis.hvals(this.key());
    return all
      .flatMap((r) => {
        try {
          return [JSON.parse(r) as Teammate];
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.created - b.created);
  }

  async get(id: string): Promise<Teammate | null> {
    const raw = await this.redis.hget(this.key(), id);
    return raw ? (JSON.parse(raw) as Teammate) : null;
  }

  async put(t: Teammate): Promise<void> {
    await this.redis.hset(this.key(), t.id, JSON.stringify(t));
  }

  /**
   * One at a time per key, in this process (Friday runs one on this computer): a change reads what is there, writes what it
   * makes of it, and nothing else writes in between. The edit, a usage-limit switch, a check-in and a room's change each wrote
   * the whole record it had read earlier, so one could undo another.
   */
  private held = new Map<string, Promise<unknown>>();
  async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const before = this.held.get(key) ?? Promise.resolve();
    const run = before.then(fn, fn);
    const tail = run.catch(() => {});
    this.held.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.held.get(key) === tail) this.held.delete(key);
    }
  }

  /** A teammate changed by `fn` under its lock, from what is stored now: null when it is gone, or when `fn` says no change. */
  async update(id: string, fn: (t: Teammate) => Teammate | null | Promise<Teammate | null>): Promise<Teammate | null> {
    return this.locked(`t:${id}`, async () => {
      const t = await this.get(id);
      if (!t) return null;
      const next = await fn(t);
      if (next) await this.put(next);
      return next;
    });
  }

  async remove(id: string): Promise<void> {
    await this.redis.hdel(this.key(), id);
  }

  private roomsKey = () => `${this.prefix}teammates:rooms`;
  private goneKey = () => `${this.prefix}teammates:gone`;

  async rooms(): Promise<Room[]> {
    const all = await this.redis.hvals(this.roomsKey());
    return all.flatMap((r) => {
      try {
        return [JSON.parse(r) as Room];
      } catch {
        return [];
      }
    }).sort((a, b) => a.created - b.created);
  }

  async room(id: string): Promise<Room | null> {
    const raw = await this.redis.hget(this.roomsKey(), id);
    return raw ? (JSON.parse(raw) as Room) : null;
  }

  async putRoom(r: Room): Promise<void> {
    await this.redis.hset(this.roomsKey(), r.id, JSON.stringify(r));
  }

  /** A room taken away: its session is kept (sessions here are never deleted), out of every list. */
  async removeRoom(r: Room): Promise<void> {
    await this.redis.hdel(this.roomsKey(), r.id);
    await this.redis.sadd(this.goneKey(), r.sid);
  }

  /** The sessions of rooms taken away: kept in the store, never listed or reached again. */
  async gone(): Promise<Set<string>> {
    return new Set(await this.redis.smembers(this.goneKey()));
  }

  /** Every session that is the team's: its own, its rooms', and rooms taken away. None of them is listed with the sessions. */
  async sessions(): Promise<string[]> {
    const [team, rooms, gone] = await Promise.all([this.team(), this.rooms(), this.redis.smembers(this.goneKey())]);
    return [...(team ? [team] : []), ...rooms.map((r) => r.sid), ...gone];
  }

  private awayKey = () => `${this.prefix}teammates:away`;
  private pausedKey = () => `${this.prefix}teammates:paused`;

  /**
   * Away mode (team-away.ts): until when the person is away, and since when; null when they aren't. Kept in the store, so it
   * survives a restart in the night (Arun, 2026-10-28: "we need to ensure teams can work basically while you are away").
   */
  async away(): Promise<{ until: number; since: number } | null> {
    const raw = await this.redis.get(this.awayKey());
    if (!raw) return null;
    try {
      const a = JSON.parse(raw) as { until?: unknown; since?: unknown };
      return typeof a.until === "number" && typeof a.since === "number" ? { until: a.until, since: a.since } : null;
    } catch {
      return null;
    }
  }

  async setAway(a: { until: number; since: number } | null): Promise<void> {
    if (a) await this.redis.set(this.awayKey(), JSON.stringify(a));
    else await this.redis.del(this.awayKey());
  }

  /** The whole team paused by the person: no queue runs, no check-in or wake goes off, until they unpause it. */
  async paused(): Promise<boolean> {
    return (await this.redis.get(this.pausedKey())) === "1";
  }

  async setPaused(on: boolean): Promise<void> {
    if (on) await this.redis.set(this.pausedKey(), "1");
    else await this.redis.del(this.pausedKey());
  }

  private selfRunKey = () => `${this.prefix}teammates:selfrun`;

  /** The rooms running on their own (team-selfrun.ts), by session id: each one's goal, since when, and who turned it on. */
  async selfRuns(): Promise<Record<string, SelfRun>> {
    const all = await this.redis.hgetall(this.selfRunKey());
    const out: Record<string, SelfRun> = {};
    for (const [sid, raw] of Object.entries(all)) {
      try {
        const r = JSON.parse(raw) as SelfRun;
        if (typeof r.goal === "string" && typeof r.since === "number") out[sid] = r;
      } catch {
        // A broken record runs nothing.
      }
    }
    return out;
  }

  async setSelfRun(sid: string, r: SelfRun | null): Promise<void> {
    if (r) await this.redis.hset(this.selfRunKey(), sid, JSON.stringify(r));
    else await this.redis.hdel(this.selfRunKey(), sid);
  }

  /** The team session's id, once there is one. */
  async team(): Promise<string | null> {
    return (await this.redis.get(this.teamKey())) || null;
  }

  async setTeam(sid: string): Promise<void> {
    await this.redis.set(this.teamKey(), sid);
  }
}

/** A thread's name from the person's first message in it: its first line, plain, cut at a word near 48 characters. */
export function threadTitle(text: string): string {
  const line = (text.split("\n").find((l) => l.trim()) ?? "").replace(/[`*_#>]+/g, "").replace(/\s+/g, " ").trim();
  if (line.length <= 48) return line || NEW_THREAD;
  const cut = line.slice(0, 48);
  const at = cut.lastIndexOf(" ");
  return `${(at > 24 ? cut.slice(0, at) : cut).replace(/[,.;:!?-]+$/, "")}…`;
}
