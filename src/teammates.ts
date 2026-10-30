import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Redis } from "ioredis";
import { isOwnModel, ownModelParts } from "./own-model-id.js";
import { cleanCheckIn, MAX_CHECKINS, type CheckIn } from "./teammate-checkins.js";
import { EFFORT_LEVELS, ENGINE_NAMES, ENGINE_TOOLS, isEngineEffort, type EngineEffort, type EngineMode, type EngineTool } from "./types.js";

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
   * The agent that added it (manage_teammate create), when one did: the person keeps it or removes it (teammate.proposed), and it
   * works meanwhile. Cleared once they keep it.
   */
  madeBy?: { lane: string; name: string };
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
  /** On its own model, what keeps it from running, said to the person: the model gone from Settings, or its server not answering. */
  problem?: string;
  /** How far its tool may go, always said (Teammate.mode absent is full). */
  mode: EngineMode;
  /** On hold as the person said (held.ts) on any of its lanes: POST /api/teammates/:id/lift lets it go on. */
  held: boolean;
  /** Its turns, minutes and tokens today (since local midnight) and over the last seven days. */
  usage: { today: MateUsage; week: MateUsage };
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
  created: number;
}

/** How many rooms a team keeps. */
export const MAX_ROOMS = 20;

/** A teammate's conversation in a room: its own, beside the one it has in the team (Runner keepAs). */
export const roomKeep = (teammateId: string, roomId: string) => `${teammateId}.${roomId}`;

/** A room's details as sent by the page, checked; throws with what is wrong. */
export function cleanRoom(body: Record<string, unknown>, known: readonly string[]): { name?: string; members?: string[]; purpose?: string } {
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : undefined;
  if (name !== undefined && !name) throw new Error("Give the room a name.");
  const members = Array.isArray(body.members) ? [...new Set(body.members.filter((m): m is string => typeof m === "string"))] : undefined;
  if (members && !members.length) throw new Error("Pick at least one teammate for the room.");
  if (members && members.length > MAX_TEAMMATES) throw new Error(`A room has up to ${MAX_TEAMMATES} teammates.`);
  if (members?.some((m) => !known.includes(m))) throw new Error("One of those isn't in your crew any more.");
  const purpose = typeof body.purpose === "string" ? body.purpose.trim().slice(0, 2000) : undefined;
  return { ...(name !== undefined ? { name } : {}), ...(members ? { members } : {}), ...(purpose !== undefined ? { purpose } : {}) };
}

/** The tool a teammate switches to when its own runs out: the one it picked, or the other of Claude Code and Codex. */
export const backupOf = (t: Pick<Teammate, "tool" | "backup">): EngineTool => t.backup ?? (t.tool === "claude" ? "codex" : "claude");

export { checkInDue, checkInText, cleanCheckIn, describeCheckIn, MAX_CHECKINS, NO_UPDATE, quietCheckIns, type CheckIn } from "./teammate-checkins.js";

/** A teammate's memory, in its own folder: read into its note with every turn, editable by the person. */
export const MEMORY_FILE = "MEMORY.md";
/** How much of it is read into the note: its first page or so. */
export const MEMORY_MAX = 6000;

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
  const machine = "machine" in body ? (typeof body.machine === "string" && /^[0-9a-f]{16}$/.test(body.machine) ? body.machine : "") : null;
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
export function teammateNote(t: Teammate, team: readonly Pick<Teammate, "name" | "tool" | "role">[], room?: { name: string; with: string[]; purpose?: string; /** The Team room's session, where the rest of the team is reached. */ team?: string }, memory = "", copy?: { repo: string; path: string; branch: string }): string {
  const others = team.filter((o) => o.name !== t.name);
  const who = (o: Pick<Teammate, "name" | "tool" | "role">) => `${o.name} (${o.tool === "friday" ? "own model" : ENGINE_NAMES[o.tool]}${o.role ? `: ${o.role.split("\n")[0]!.slice(0, 80)}` : ""})`;
  // In a room only its members are lanes beside it, reachable with message_agent; the rest of the team is in the Team room
  // (2026-10-28 audit: a room's note offered the whole team, and message_agent to one not there failed).
  const here = room ? others.filter((o) => room.with.includes(o.name)) : others;
  const away = room ? others.filter((o) => !room.with.includes(o.name)) : [];
  return [
    ...(room ? [`You are in the room "${room.name}"${room.with.length ? ` with ${room.with.join(", ")}` : ", on your own"}: what is said here is about this room's work. You have a conversation of your own in each room you are in; your folder and notes are the same in all of them.${room.purpose ? ` The room is for: ${room.purpose}` : ""}`] : []),
    `You are ${t.name}, one of the person's AI teammates in Friday, running on their ${runsOnName(t)} on their own computer.`,
    t.role ? `Your role, in their words: ${t.role}` : "You have no set role: help with whatever you are given.",
    projectsOf(t).length
      ? `You work in ${projectsOf(t)[0]}${projectsOf(t).length > 1 ? `, and also in ${projectsOf(t).slice(1).join(", ")}` : ""}: the person's project${projectsOf(t).length > 1 ? "s" : ""}, where the work is done. Your own folder, ${t.folder}, is for your notes and anything of yours.`
      : `Your own folder is ${t.folder}: keep your notes and anything of yours there, and do the work in it until the person gives you a project.`,
    here.length ? `${room ? "Your teammates in this room" : "Your teammates"}: ${here.map(who).join("; ")}. Message, ask or hand them work with Friday's agent tools when it is theirs to do, and answer them when they ask.` : room ? "Nobody else is in this room." : "You are the only teammate for now.",
    ...(away.length ? [`The rest of the crew isn't in this room: ${away.map(who).join("; ")}. Reach them with message_session to the Crew room${room?.team ? ` (session ${room.team})` : ""}, naming them as agent.`] : []),
    // Its own copy of a repo it shares with other teammates (a git worktree), so none of them edits over another (2026-10-28).
    ...(copy ? [`Other teammates work in ${copy.repo} too, so you have a copy of your own: ${copy.path}, on the branch ${copy.branch}. Work and commit there, on that branch, never in ${copy.repo} itself. Before a new task, bring it up to date with the branch the crew's goal is on (git merge it). The lead merges everyone's branches into one pull request.`] : []),
    "Finish what you are given: what the person sends you, what your teammates ask, and the check-ins the person set. When nothing is left, stop and say so in one line. Never start new work of your own accord.",
    "Before you change files in a project another teammate may be in, claim them with Friday's claim_files, so you don't edit over each other.",
    // What reaches the room, as OpenBot's channels have it (Arun, 2026-10-27: "keep the room chat clean and clear"): the answer,
    // once; the coordination among teammates kept to the agent tools, where the room folds it to a line.
    "What you say ends up in the crew's chat, which the person reads. Lead with the answer and give the shortest complete one: the outcome, what blocks you, what you need from them, in a few lines; no setup, no narration, no acknowledgements, no recap of what others said. Say your result once and end the turn: don't repeat it, and don't add a closing line. Keep the coordination with your teammates to Friday's agent tools (message, ask, post_update, tasks) rather than your reply. When nothing needs the person to read it (a routine check, nothing new, still waiting), end without any text. Your steps stay in your own chat. Name a file you made, a picture or a video by its path in backticks and it shows there.",
    // How a teammate answers work it was handed, and keeps to its own, as OpenBot's agent communication policy has it.
    `When a teammate handed you the work, end with four short lines: Status (done, partly, blocked), Result (what you made or found), Evidence (files, tests, links), Unblock (what you need, or nothing). Never hand a task back to whoever gave it to you; say what blocks you instead. Decisions the crew should keep to go in ${onOwnModel(t) ? "remember" : "write_note"}.`,
    // Friday Code reaches only the folder it works in, which may be a project rather than its own: it keeps its memory with a
    // tool of its own (update_memory) instead of editing the file.
    `Your memory is ${path.join(t.folder, MEMORY_FILE)}: what you learn that you will want next time (how the person likes things, where things are, what didn't work). ${onOwnModel(t) ? "Add to it with update_memory as you go" : "Add to it as you go"}, in short lines; keep it under a page.${memory.trim() ? `\nWhat it holds now:\n${memory.trim()}` : " It is empty so far."}`,
  ].join("\n");
}

/** The teammates and the team session, kept in the local store like the automations are. */
export class TeammateStore {
  constructor(
    private redis: Redis,
    private prefix: string,
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

  /** The team session's id, once there is one. */
  async team(): Promise<string | null> {
    return (await this.redis.get(this.teamKey())) || null;
  }

  async setTeam(sid: string): Promise<void> {
    await this.redis.set(this.teamKey(), sid);
  }
}
