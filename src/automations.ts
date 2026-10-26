import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import { describeSchedule, dueSlot, validateSchedule, type AgentSchedule } from "./agents.js";
import { ENGINE_NAMES, ENGINE_TOOLS, type EngineMode, type EngineTool } from "./types.js";

/**
 * Automations: the coding tools working on their own (Arun, 2026-10-23: "get rid of the agents tab page and replace it with
 * automations, this will for the coding tools and stuff in sessions we need to make this very advanced but very easy to
 * understand and use").
 *
 * Each one reads as a sentence: when (a schedule, a webhook, an agent finishing in a session, or a press of Run now), who
 * (a coding tool, a team of them, or Friday's own agent, with a saved agent's instructions if picked), where (a folder on
 * its owner's computer, in its own copy), what it does (the words it is given, with what started it filled in), then (a
 * pull request, a word to its owner), and its limits (how many runs a day, what to do when the computer is off). A run is a
 * session of its own, owned by the automation's owner, started on their computer the way they would start it themselves.
 */

export type AutomationWhen =
  | { kind: "schedule"; schedule: AgentSchedule }
  | { kind: "webhook"; secret: string }
  /** An agent in this session finishing a run: "done", or stopping on an error. */
  | { kind: "session"; sessionId: string; sessionTitle: string; on: "finished" | "failed" }
  | { kind: "manual" };

export interface AutomationWho {
  /** A coding tool on the owner's computer, or Friday's own agent ("friday", Team only). */
  tool: EngineTool | "friday";
  /** More coding tools beside it, each in its own copy: the first one leads and they split the work on the board. */
  team: EngineTool[];
  mode: EngineMode;
  /** For Friday's own agent: its model ("" is Friday's). */
  model: string;
  /** A saved agent whose instructions it works by. */
  agentId: string;
}

export interface Automation {
  id: string;
  name: string;
  on: boolean;
  ownerId: string;
  ownerName: string;
  when: AutomationWhen;
  who: AutomationWho;
  /** A folder on the owner's computer; empty makes a new project folder for each run. */
  folder: string;
  /** In a copy of the folder of its own (a git worktree), so it never works over somebody's changes. */
  copy: boolean;
  does: string;
  then: { pr: boolean; notify: boolean };
  limits: { perDay: number; offline: "wait" | "skip" };
  created: number;
  /** From a saved agent's schedule, moved here when Agents became Automations. */
  from?: string;
}

export type RunStatus = "starting" | "running" | "done" | "failed" | "waiting" | "skipped";

export interface AutomationRun {
  id: string;
  at: number;
  /** What started it, in a few words: "every weekday at 09:00", "webhook", "Run now", "Codex finished in …". */
  trigger: string;
  status: RunStatus;
  sid?: string;
  invite?: string;
  /** Why it failed, was skipped or waits. */
  note?: string;
  ended?: number;
}

export interface AutomationInput {
  name?: unknown;
  on?: unknown;
  when?: unknown;
  who?: unknown;
  folder?: unknown;
  copy?: unknown;
  does?: unknown;
  then?: unknown;
  limits?: unknown;
}

const MODES: EngineMode[] = ["plan", "edits", "full"];
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const isTool = (v: unknown): v is EngineTool => typeof v === "string" && (ENGINE_TOOLS as string[]).includes(v);

/** An automation as the page sent it, made safe: anything missing or wrong becomes the plain default. */
export function cleanAutomation(input: AutomationInput, prev?: Automation): Omit<Automation, "id" | "ownerId" | "ownerName" | "created"> {
  const w = (input.when ?? prev?.when ?? { kind: "manual" }) as Record<string, any>;
  const when: AutomationWhen =
    w.kind === "schedule"
      ? { kind: "schedule", schedule: validateSchedule(w.schedule) ?? { every: "daily", at: "09:00", days: [], tz: "UTC" } }
      : w.kind === "webhook"
        ? { kind: "webhook", secret: prev?.when.kind === "webhook" ? prev.when.secret : randomBytes(18).toString("base64url") }
        : w.kind === "session" && str(w.sessionId, 64)
          ? { kind: "session", sessionId: str(w.sessionId, 64), sessionTitle: str(w.sessionTitle, 120), on: w.on === "failed" ? "failed" : "finished" }
          : { kind: "manual" };
  const h = (input.who ?? prev?.who ?? {}) as Record<string, any>;
  const tool: AutomationWho["tool"] = h.tool === "friday" ? "friday" : isTool(h.tool) ? h.tool : "claude";
  const team = tool === "friday" ? [] : [...new Set((Array.isArray(h.team) ? h.team : []).filter(isTool))].filter((t) => t !== tool).slice(0, 4);
  const who: AutomationWho = { tool, team, mode: MODES.includes(h.mode) ? h.mode : "full", model: str(h.model, 80), agentId: str(h.agentId, 64) };
  const t = (input.then ?? prev?.then ?? {}) as Record<string, any>;
  const l = (input.limits ?? prev?.limits ?? {}) as Record<string, any>;
  const perDay = Number(l.perDay);
  return {
    name: str(input.name, 80) || prev?.name || "New automation",
    on: typeof input.on === "boolean" ? input.on : (prev?.on ?? true),
    when,
    who,
    folder: input.folder === undefined ? (prev?.folder ?? "") : str(input.folder, 600),
    copy: typeof input.copy === "boolean" ? input.copy : (prev?.copy ?? true),
    does: input.does === undefined ? (prev?.does ?? "") : str(input.does, 8000),
    then: { pr: t.pr === true, notify: t.notify !== false },
    limits: { perDay: Number.isFinite(perDay) && perDay > 0 ? Math.min(200, Math.max(1, Math.round(perDay))) : 10, offline: l.offline === "skip" ? "skip" : "wait" },
    ...(prev?.from ? { from: prev.from } : {}),
  };
}

/** "every weekday at 09:00 (Europe/London)", "when a webhook is called", …: the "when" of the sentence. */
export function describeWhen(w: AutomationWhen): string {
  if (w.kind === "schedule") return describeSchedule(w.schedule);
  if (w.kind === "webhook") return "when its webhook is called";
  if (w.kind === "session") return `when an agent ${w.on === "failed" ? "stops on an error" : "finishes"} in “${w.sessionTitle || "a session"}”`;
  return "when you press Run now";
}

/** "Claude Code, with Codex and Cursor", "Friday": the "who" of the sentence. */
export function describeWho(h: AutomationWho): string {
  const name = h.tool === "friday" ? "Friday" : ENGINE_NAMES[h.tool];
  return h.team.length ? `${name} leading ${h.team.map((t) => ENGINE_NAMES[t]).join(" and ")}` : name;
}

/** What started a run, filled into what it was told to do: {{event}} where it says, else after it. */
export function promptFor(a: Automation, event: string): string {
  const base = a.does.trim() || "Do what you were set up to do.";
  const told = base.includes("{{event}}") ? base.replaceAll("{{event}}", event) : event ? `${base}\n\nWhat started this run:\n${event}` : base;
  const parts = [`[Friday] This is an automation, “${a.name}”, running ${describeWhen(a.when)}. Nobody is watching it start: do the work, then finish with a short summary of what you did and anything a person should check.`, told];
  if (a.then.pr) parts.push("When you're done and the change works, commit it on a new branch and open a pull request with a short description (gh pr create). If there is nothing to change, say so instead.");
  if (a.who.team.length) parts.push("You lead the agents in this session: split the work onto the shared board so they start on it at once, do your own piece, then check it all fits.");
  return parts.join("\n\n");
}

/** Where automations are kept in Redis: per workspace, beside the workspace's other things. */
export class AutomationStore {
  constructor(
    private redis: Redis,
    private prefix: string,
  ) {}

  private key = (ws: string) => `${this.prefix}automations:${ws}`;
  private runsKey = (ws: string, id: string) => `${this.prefix}automation-runs:${ws}:${id}`;
  /** Workspaces with at least one automation, for the clock. */
  readonly workspacesKey = () => `${this.prefix}automation-workspaces`;
  /** Automations watching a session, as "<workspace> <id>". */
  watchKey = (sid: string) => `${this.prefix}automation-watch:${sid}`;
  /** The run a session is, when an automation started it. */
  runOfKey = (sid: string) => `${this.prefix}automation-run:${sid}`;
  /** Runs waiting for their owner's computer, as "<workspace> <id> <run>", by when they began to wait. */
  readonly waitingKey = () => `${this.prefix}automation-waiting`;

  async list(ws: string): Promise<Automation[]> {
    const all = await this.redis.hvals(this.key(ws));
    return all.flatMap((r) => {
      try {
        return [JSON.parse(r) as Automation];
      } catch {
        return [];
      }
    }).sort((a, b) => a.created - b.created);
  }

  async get(ws: string, id: string): Promise<Automation | null> {
    const raw = await this.redis.hget(this.key(ws), id);
    return raw ? (JSON.parse(raw) as Automation) : null;
  }

  async put(ws: string, a: Automation, before?: Automation | null): Promise<void> {
    const m = this.redis.multi().hset(this.key(ws), a.id, JSON.stringify(a)).sadd(this.workspacesKey(), ws);
    if (before?.when.kind === "session" && (a.when.kind !== "session" || a.when.sessionId !== before.when.sessionId)) m.srem(this.watchKey(before.when.sessionId), `${ws} ${a.id}`);
    if (a.when.kind === "session") m.sadd(this.watchKey(a.when.sessionId), `${ws} ${a.id}`);
    await m.exec();
  }

  async remove(ws: string, id: string): Promise<void> {
    const a = await this.get(ws, id);
    const m = this.redis.multi().hdel(this.key(ws), id).del(this.runsKey(ws, id));
    if (a?.when.kind === "session") m.srem(this.watchKey(a.when.sessionId), `${ws} ${id}`);
    await m.exec();
  }

  async runs(ws: string, id: string, n = 30): Promise<AutomationRun[]> {
    return (await this.redis.lrange(this.runsKey(ws, id), 0, n - 1)).flatMap((r) => {
      try {
        return [JSON.parse(r) as AutomationRun];
      } catch {
        return [];
      }
    });
  }

  /** A run added at the front, the list kept to its last fifty. */
  async addRun(ws: string, id: string, run: AutomationRun): Promise<void> {
    await this.redis.multi().lpush(this.runsKey(ws, id), JSON.stringify(run)).ltrim(this.runsKey(ws, id), 0, 49).exec();
  }

  /** A run changed where it stands, by its id. */
  async updateRun(ws: string, id: string, runId: string, change: Partial<AutomationRun>): Promise<AutomationRun | null> {
    const key = this.runsKey(ws, id);
    const list = await this.redis.lrange(key, 0, 49);
    for (let i = 0; i < list.length; i++) {
      const r = JSON.parse(list[i]!) as AutomationRun;
      if (r.id !== runId) continue;
      const next = { ...r, ...change };
      await this.redis.lset(key, i, JSON.stringify(next));
      return next;
    }
    return null;
  }

  /** Counted against its runs a day, in the owner's day as the server keeps it (UTC). Over the limit: false, and not counted. */
  async countRun(ws: string, id: string, perDay: number, now = new Date()): Promise<boolean> {
    const key = `${this.prefix}automation-count:${ws}:${id}:${now.toISOString().slice(0, 10)}`;
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, 2 * 24 * 3600);
    if (n > perDay) {
      await this.redis.decr(key);
      return false;
    }
    return true;
  }

  async runsToday(ws: string, id: string, now = new Date()): Promise<number> {
    return Number(await this.redis.get(`${this.prefix}automation-count:${ws}:${id}:${now.toISOString().slice(0, 10)}`)) || 0;
  }

  /** The schedule slot claimed once across every node: a minute checked twice, or by two servers, still runs once. */
  async claimSlot(ws: string, id: string, slot: string): Promise<boolean> {
    return (await this.redis.set(`${this.prefix}automation-fired:${ws}:${id}:${slot}`, "1", "EX", 2 * 24 * 3600, "NX")) === "OK";
  }
}

/** Whether a scheduled automation is due in the minute `now` is in, as its slot's name. */
export const dueAutomation = (a: Automation, now: Date): string | null => (a.on && a.when.kind === "schedule" ? dueSlot(a.when.schedule, now) : null);

/** How long a run waits for its owner's computer before it is skipped. */
export const WAIT_FOR_COMPUTER_MS = 12 * 60 * 60_000;
