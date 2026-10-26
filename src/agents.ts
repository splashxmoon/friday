import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import { catalogBrief } from "./skill-catalog.js";
import type { SkillRegistry } from "./skills.js";
import type { AgentSnapshot, AgentTools, SkillBrief } from "./types.js";

/**
 * Custom agents: saved instructions + tool choices + optional model, owned by
 * one person and optionally shared with specific people or the whole
 * workspace. Sessions store a snapshot of the agent at the moment it's chosen,
 * so later edits never silently change what an earlier run was told.
 */

export type SharingMode = "private" | "people" | "workspace";

/** Something the agent should always know. Folded into its instructions when a session starts. */
export interface MemoryNote {
  id: string;
  title: string;
  text: string;
}
/** Where a finished run reports to: one of the person's connections, and where in it. */
export interface AgentChannel {
  id: string;
  connectionId: string;
  /** The connection's name, kept so the agent can be told which tools to reach for. */
  connection: string;
  target: string;
}
/** A way in from outside: a URL that starts a session running this agent. */
export interface AgentTrigger {
  id: string;
  kind: "webhook";
  label: string;
  secret: string;
}

/**
 * When an agent runs by itself. The time is read in the time zone of whoever set it, so "every weekday at 9" means their
 * nine, not the server's. A run is a session of its own, owned by the agent's owner, exactly as a webhook starts one.
 */
export interface AgentSchedule {
  every: "hourly" | "daily" | "weekly";
  /** HH:MM, for daily and weekly. Hourly runs at the top of the hour. */
  at: string;
  /** Weekdays for weekly, 0 = Sunday. */
  days: number[];
  /** An IANA zone, e.g. "Europe/London". */
  tz: string;
}

/** A helper that belongs to one agent: a brief it hands part of a job to. Not an agent of its own. */
export interface AgentHelper {
  id: string;
  name: string;
  description: string;
  icon: string;
  instructions: string;
}

export interface AgentDef {
  id: string;
  name: string;
  description: string;
  instructions: string;
  icon: string;
  color: string;
  tools: AgentTools;
  /** Document skeleton this agent builds: section ids, in order. Empty = freeform. */
  /**
   * Skills this agent may reach for, by id: `catalog:<id>` for a built-in,
   * or the id of one of the workspace's own skills. The agent picks among them
   * by trigger when the job matches; it doesn't run them all.
   */
  skills: string[];
  memory?: MemoryNote[];
  channels?: AgentChannel[];
  /** Other agents that run after this one finishes, as lanes beside it. */
  subagents?: string[];
  /** Helpers written into this agent. It hands them tasks; they are not listed as agents. */
  helpers?: AgentHelper[];
  triggers?: AgentTrigger[];
  schedule?: AgentSchedule;
  /** The session its schedule last started, so the owner can find it: the sidebar only knows sessions a browser opened. */
  lastRun?: { sid: string; at: number; invite: string };
  model?: string;
  /** Where it came from, when it was imported from a coding tool's own files: importing the same file again updates it. */
  imported?: { source: string; key: string };
  ownerId: string;
  ownerName: string;
  sharing: { mode: SharingMode; people: string[] };
  createdAt: number;
  updatedAt: number;
  version: number;
}

export type AgentView = AgentDef & { access: "owner" | "shared" };
export type AgentInput = Partial<Pick<AgentDef, "name" | "description" | "instructions" | "icon" | "color" | "tools" | "skills" | "model" | "sharing" | "memory" | "channels" | "subagents" | "helpers" | "triggers">> & {
  /** Null (or `every: "manual"`) turns the schedule off; absent leaves it as it was. */
  schedule?: (Partial<AgentSchedule> & { every?: string }) | null;
};

export interface Person {
  id: string;
  name: string;
}

/** A directory entry: a person plus when the server last saw them. */
export type PersonListing = Person & { seenAt: number };

export class AgentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const COLORS = ["indigo", "green", "violet", "amber", "pink", "teal"];

export class AgentRegistry {
  constructor(
    private redis: Redis,
    private prefix: string,
    /** Resolves an agent's own-workspace skills. Absent: only built-ins resolve. */
    private skills?: SkillRegistry,
    /** Lets the server's scheduler find this workspace: a registry is per workspace, the clock is one for all of them. */
    private scheduling?: { workspaceId: string; globalPrefix: string },
  ) {}

  private get key() {
    return `${this.prefix}agents`;
  }

  /** Where the workspaces with at least one scheduled agent are listed, under the server-wide prefix. */
  static scheduledKey(globalPrefix: string) {
    return `${globalPrefix}scheduled-workspaces`;
  }

  private async put(a: AgentDef): Promise<void> {
    await this.redis.hset(this.key, a.id, JSON.stringify(a));
    // Never removed: a workspace whose schedules were all turned off is one cheap read per minute, not a bookkeeping problem.
    if (a.schedule && this.scheduling) await this.redis.sadd(AgentRegistry.scheduledKey(this.scheduling.globalPrefix), this.scheduling.workspaceId);
  }

  /** Every agent here that runs by itself. */
  async scheduled(): Promise<AgentDef[]> {
    return (await this.all()).filter((a) => a.schedule);
  }

  /** Note the session a schedule just started. */
  async recordRun(id: string, lastRun: NonNullable<AgentDef["lastRun"]>): Promise<void> {
    const a = await this.get(id);
    if (a) await this.put({ ...a, lastRun });
  }
  private get usersKey() {
    return `${this.prefix}users`;
  }

  /** The workspace directory: everyone who has used this server, for the share picker. */
  async touchUser(id: string, name: string): Promise<void> {
    if (!id || !name) return;
    await this.redis.hset(this.usersKey, id, JSON.stringify({ name, seenAt: Date.now() }));
  }

  /** Drop someone from the workspace directory. They reappear if they join again. */
  async forgetUser(id: string): Promise<void> {
    await this.redis.hdel(this.usersKey, id);
  }

  async people(): Promise<PersonListing[]> {
    const h = await this.redis.hgetall(this.usersKey);
    return Object.entries(h)
      .map(([id, v]) => {
        const u = JSON.parse(v) as { name: string; seenAt?: number };
        return { id, name: u.name, seenAt: u.seenAt ?? 0 };
      })
      .sort((a, b) => b.seenAt - a.seenAt || a.name.localeCompare(b.name));
  }

  canUse(a: AgentDef, userId: string): boolean {
    return a.ownerId === userId || a.sharing.mode === "workspace" || (a.sharing.mode === "people" && a.sharing.people.includes(userId));
  }

  private async all(): Promise<AgentDef[]> {
    const h = await this.redis.hgetall(this.key);
    return Object.values(h).map((v) => JSON.parse(v) as AgentDef);
  }

  async get(id: string): Promise<AgentDef | null> {
    const v = await this.redis.hget(this.key, id);
    return v ? (JSON.parse(v) as AgentDef) : null;
  }

  async listFor(userId: string): Promise<AgentView[]> {
    return (await this.all())
      .filter((a) => this.canUse(a, userId))
      // The URL that starts an agent is the owner's alone: people it is shared with can use the agent, not fire it from outside.
      .map((a) => ({ ...a, ...(a.ownerId === userId ? {} : { triggers: [], lastRun: undefined }), access: a.ownerId === userId ? ("owner" as const) : ("shared" as const) }))
      .sort((a, b) => Number(b.access === "owner") - Number(a.access === "owner") || b.updatedAt - a.updatedAt);
  }

  async create(user: Person, input: AgentInput): Promise<AgentView> {
    const now = Date.now();
    const a: AgentDef = {
      id: randomBytes(6).toString("base64url"),
      ownerId: user.id,
      ownerName: user.name,
      createdAt: now,
      updatedAt: now,
      version: 1,
      ...validate(input, {
        name: "",
        description: "",
        instructions: "",
        icon: "agent",
        color: "indigo",
        tools: { webSearch: true, askHuman: true, connections: "all" },
        skills: [],
        sharing: { mode: "private", people: [] },
        memory: [],
        channels: [],
        subagents: [],
        triggers: [],
      }),
    };
    await this.put(a);
    return { ...a, access: "owner" };
  }

  /**
   * Agents written for other coding tools, brought in as ordinary private agents.
   *
   * What comes in is the prompt and a name and a line about it, nothing else:
   * no connections, no web search, no triggers, so an imported agent never has
   * more reach than somebody gave it here. The same file imported again
   * updates the agent it made before rather than adding a copy.
   */
  async importMany(user: Person, items: { source: string; key: string; name: string; description: string; instructions: string }[]): Promise<{ agents: AgentView[]; created: number; updated: number }> {
    const mine = (await this.all()).filter((a) => a.ownerId === user.id && a.imported);
    const agents: AgentView[] = [];
    let created = 0;
    let updated = 0;
    for (const it of items.slice(0, 40)) {
      if (typeof it.key !== "string" || !/^(claude|cursor|codex):[\w .@/+-]{1,200}$/.test(it.key)) continue;
      const source = it.key.split(":")[0]!;
      const input: AgentInput = {
        name: it.name,
        description: it.description,
        instructions: it.instructions,
        tools: { webSearch: false, askHuman: true, connections: "none" },
        sharing: { mode: "private", people: [] },
      };
      const had = mine.find((a) => a.imported!.key === it.key);
      if (had) {
        const next: AgentDef = { ...had, ...validate({ name: input.name, description: input.description, instructions: input.instructions }, had), ownerName: user.name, updatedAt: Date.now(), version: had.version + 1 };
        await this.redis.hset(this.key, had.id, JSON.stringify(next));
        agents.push({ ...next, access: "owner" });
        updated++;
      } else {
        const made = await this.create(user, input);
        const withMark: AgentDef = { ...made, imported: { source, key: it.key } };
        const { access: _a, ...stored } = withMark as AgentView;
        await this.redis.hset(this.key, made.id, JSON.stringify(stored));
        agents.push({ ...stored, access: "owner" });
        created++;
      }
    }
    return { agents, created, updated };
  }

  async update(user: Person, id: string, input: AgentInput): Promise<AgentView> {
    const a = await this.owned(user, id);
    const next: AgentDef = { ...a, ...validate(input, a), ownerName: user.name, updatedAt: Date.now(), version: a.version + 1 };
    await this.put(next);
    return { ...next, access: "owner" };
  }

  async remove(user: Person, id: string): Promise<void> {
    await this.owned(user, id);
    await this.redis.hdel(this.key, id);
  }

  /**
   * Decline an agent someone shared with you: it drops out of your list without
   * touching anyone else's. You can only ever remove yourself, so this isn't a
   * way to un-share someone else's agent from them.
   *
   * A workspace-wide agent has no per-person list to leave, so that is refused
   * rather than silently doing nothing.
   */
  async leaveShared(user: Person, id: string): Promise<void> {
    const a = await this.get(id);
    if (!a || !this.canUse(a, user.id)) throw new AgentError(404, "Agent not found.");
    if (a.ownerId === user.id) throw new AgentError(400, "You own this agent. Delete it instead.");
    if (a.sharing.mode === "workspace") throw new AgentError(400, `${a.name} is shared with the whole workspace, so it can't be removed from your list alone.`);
    if (!a.sharing.people.includes(user.id)) throw new AgentError(404, "Agent not found.");

    a.sharing = { ...a.sharing, people: a.sharing.people.filter((p) => p !== user.id) };
    a.updatedAt = Date.now();
    await this.redis.hset(this.key, a.id, JSON.stringify(a));
  }

  /** Make your own copy of an agent you can see (the usual way to customise a shared one). */
  async duplicate(user: Person, id: string): Promise<AgentView> {
    const a = await this.get(id);
    if (!a || !this.canUse(a, user.id)) throw new AgentError(404, "Agent not found.");
    return this.create(user, { ...a, name: `${a.name} (copy)`.slice(0, 40), sharing: { mode: "private", people: [] }, triggers: [], subagents: [], schedule: null });
  }

  async snapshotFor(userId: string, id: string, nested = false): Promise<AgentSnapshot | null> {
    const a = await this.get(id);
    if (!a || !this.canUse(a, userId)) return null;
    // The team is one level deep: a specialist that could deploy its own is how a run fans out without end.
    const others = nested ? [] : (await Promise.all((a.subagents ?? []).filter((s) => s !== a.id).slice(0, 5).map((s) => this.snapshotFor(userId, s, true)))).filter((s): s is AgentSnapshot => !!s);
    // Its own helpers deploy the same way, but are made of the lead's brief and colour: they have no row in Agents.
    const own: AgentSnapshot[] = nested
      ? []
      : (a.helpers ?? []).map((h) => ({
          id: `${a.id}.${h.id}`,
          name: h.name,
          icon: h.icon,
          color: a.color,
          instructions: `${h.instructions}\n\nYou are a helper to "${a.name}", which hands you one piece of its job. Do that piece, then report what you found or did so it can carry on.`,
          tools: { webSearch: a.tools.webSearch, askHuman: false, connections: "none" as const },
          version: a.version,
          ownerName: a.ownerName,
        }));
    const team = [...own, ...others];
    return {
      id: a.id,
      name: a.name,
      icon: a.icon,
      color: a.color,
      instructions: withContext(a),
      tools: a.tools,
      // Resolved as the agent's owner: the skills are part of what they built,
      // and a teammate running a shared agent should get the same behaviour.
      ...(await this.briefs(a)),
      ...(a.model ? { model: a.model } : {}),
      ...(team.length ? { subagents: team } : {}),
      version: a.version,
      ownerName: a.ownerName,
    };
  }

  /**
   * The briefs behind an agent's skill ids. A skill that has been deleted, or
   * that the owner lost access to, is dropped silently — the agent still works,
   * with one fewer thing it knows how to do.
   */
  private async briefs(a: AgentDef): Promise<{ skills?: SkillBrief[] }> {
    const ids = a.skills ?? [];
    if (!ids.length) return {};
    const skills = (
      await Promise.all(
        ids.slice(0, 12).map(async (id): Promise<SkillBrief[]> => {
          if (id.startsWith("catalog:")) return [catalogBrief(id)].filter((b): b is SkillBrief => !!b);
          // A collection is one entry on the agent and many on its menu.
          // collection:<id> is all of it; collection:<id>:<skill> is one skill from it.
          if (id.startsWith("collection:")) {
            const [cid, sid] = id.slice("collection:".length).split(":");
            return this.skills ? this.skills.collectionBriefs(cid!, a.ownerId, sid ? [sid] : undefined) : [];
          }
          return [this.skills ? await this.skills.brief(id, a.ownerId) : null].filter((b): b is SkillBrief => !!b);
        }),
      )
    ).flat();
    return skills.length ? { skills } : {};
  }

  private async owned(user: Person, id: string): Promise<AgentDef> {
    const a = await this.get(id);
    if (!a || !this.canUse(a, user.id)) throw new AgentError(404, "Agent not found.");
    if (a.ownerId !== user.id) throw new AgentError(403, `Only ${a.ownerName} can change this agent. Duplicate it to make your own version.`);
    return a;
  }
}

type Editable = Pick<AgentDef, "name" | "description" | "instructions" | "icon" | "color" | "tools" | "skills" | "sharing" | "memory" | "channels" | "subagents" | "helpers" | "triggers"> & { model?: string; schedule?: AgentSchedule };

const EVERY: AgentSchedule["every"][] = ["hourly", "daily", "weekly"];
const zoneOk = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** A schedule as the client sent it, or undefined for off. */
export function validateSchedule(s: AgentInput["schedule"]): AgentSchedule | undefined {
  if (!s || !EVERY.includes(s.every as AgentSchedule["every"])) return undefined;
  const at = typeof s.at === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s.at) ? s.at : "09:00";
  const days = [...new Set((Array.isArray(s.days) ? s.days : []).filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  return {
    every: s.every as AgentSchedule["every"],
    at,
    days: s.every === "weekly" && !days.length ? [1, 2, 3, 4, 5] : days,
    tz: typeof s.tz === "string" && s.tz.length <= 64 && zoneOk(s.tz) ? s.tz : "UTC",
  };
}

/** The wall clock in a zone, as the pieces a schedule is written in. */
function clockIn(now: Date, tz: string): { day: number; date: string; hh: string; mm: string } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(now);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  const hh = get("hour") === "24" ? "00" : get("hour");
  return { day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")), date: `${get("year")}-${get("month")}-${get("day")}`, hh, mm: get("minute") };
}

/**
 * Whether a schedule fires in the minute `now` falls in, as the name of that slot — one run per slot however many times
 * the clock is checked during it — or null.
 */
export function dueSlot(s: AgentSchedule, now: Date): string | null {
  const c = clockIn(now, s.tz);
  if (s.every === "hourly") return c.mm === "00" ? `${c.date}T${c.hh}` : null;
  if (`${c.hh}:${c.mm}` !== s.at) return null;
  if (s.every === "weekly" && !s.days.includes(c.day)) return null;
  return c.date;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** "every weekday at 09:00 (Europe/London)": for the first line of the session it starts. */
export function describeSchedule(s: AgentSchedule): string {
  if (s.every === "hourly") return "every hour";
  const when = `at ${s.at} (${s.tz})`;
  if (s.every === "daily") return `every day ${when}`;
  const d = [...s.days].sort();
  const days = d.join() === "1,2,3,4,5" ? "every weekday" : d.length === 7 ? "every day" : `on ${d.map((x) => DAY_NAMES[x]).join(", ")}`;
  return `${days} ${when}`;
}

/**
 * What an agent is told: its brief, then what it should remember, then where to
 * report. Memory and channels are written into the instructions rather than
 * given their own machinery, so they work on every engine and every model.
 */
function withContext(a: AgentDef): string {
  const parts = [a.instructions];
  const memory = (a.memory ?? []).filter((m) => m.text);
  if (memory.length) parts.push(`## Remember\n${memory.map((m) => `- ${m.title ? `${m.title}: ` : ""}${m.text}`).join("\n")}`);
  const channels = a.channels ?? [];
  if (channels.length) {
    parts.push(`## When you finish\nReport what you did, briefly, to ${channels.map((c) => `${c.target} using the ${c.connection} tools`).join(" and to ")}. If those tools are not available to you, say so in your final answer instead of skipping it silently.`);
  }
  return parts.join("\n\n");
}

const rid = () => randomBytes(5).toString("base64url");
const idOk = (v: unknown): v is string => typeof v === "string" && /^[\w-]{4,40}$/.test(v);

function validate(input: AgentInput, base: Editable): Editable {
  const str = (v: unknown, max: number, fallback: string) => (typeof v === "string" ? v.trim().slice(0, max) : fallback);
  const name = str(input.name, 40, base.name);
  if (!name) throw new AgentError(400, "Give the agent a name.");
  const instructions = str(input.instructions, 8000, base.instructions);
  if (!instructions) throw new AgentError(400, "Tell the agent what it's for (instructions).");

  const t = (input.tools ?? base.tools) as Partial<AgentTools>;
  const connections =
    t.connections === "all" || t.connections === "none"
      ? t.connections
      : Array.isArray(t.connections)
        ? t.connections.filter((c) => typeof c === "string" && /^[a-z0-9]{1,24}$/.test(c)).slice(0, 50)
        : base.tools.connections;

  const s = (input.sharing ?? base.sharing) as Partial<AgentDef["sharing"]>;
  const mode: SharingMode = s.mode === "people" || s.mode === "workspace" ? s.mode : "private";
  const people = Array.isArray(s.people) ? s.people.filter((p) => typeof p === "string" && p.length <= 64).slice(0, 200) : [];

  // Section ids share the agent-facing format enforced by write_section.

  // Skill ids: a built-in ("catalog:postmortem") or one of the workspace's own.
  const skills = Array.isArray(input.skills)
    ? [...new Set(input.skills.filter((x): x is string => typeof x === "string" && /^[\w:-]{1,60}$/.test(x)))].slice(0, 12)
    : base.skills;

  const list = <T,>(v: unknown, max: number, one: (x: Record<string, unknown>) => T | null, fallback: T[] | undefined): T[] =>
    Array.isArray(v) ? v.slice(0, max).flatMap((x) => (x && typeof x === "object" ? (one(x as Record<string, unknown>) ?? []) : [])) : (fallback ?? []);
  const memory = list<MemoryNote>(input.memory, 12, (m) => (typeof m.text === "string" && m.text.trim() ? { id: idOk(m.id) ? m.id : rid(), title: str(m.title, 60, ""), text: str(m.text, 2000, "") } : null), base.memory);
  const channels = list<AgentChannel>(
    input.channels,
    6,
    (c) => (typeof c.connectionId === "string" && /^[a-z0-9]{1,24}$/.test(c.connectionId) && typeof c.target === "string" && c.target.trim() ? { id: idOk(c.id) ? c.id : rid(), connectionId: c.connectionId, connection: str(c.connection, 60, "the connected service"), target: str(c.target, 80, "") } : null),
    base.channels,
  );
  const helpers = list<AgentHelper>(
    input.helpers,
    4,
    (h) => (str(h.name, 40, "") && str(h.instructions, 4000, "") ? { id: idOk(h.id) ? h.id : rid(), name: str(h.name, 40, ""), description: str(h.description, 200, ""), icon: str(h.icon, 24, "agent") || "agent", instructions: str(h.instructions, 4000, "") } : null),
    base.helpers,
  );
  const subagents = Array.isArray(input.subagents) ? [...new Set(input.subagents.filter(idOk))].slice(0, 5) : (base.subagents ?? []);
  const triggers = list<AgentTrigger>(
    input.triggers,
    5,
    (t) => ({ id: idOk(t.id) ? t.id : rid(), kind: "webhook", label: str(t.label, 40, "Webhook") || "Webhook", secret: typeof t.secret === "string" && /^[\w-]{16,48}$/.test(t.secret) ? t.secret : randomBytes(18).toString("base64url") }),
    base.triggers,
  );

  const model = input.model === undefined ? base.model : typeof input.model === "string" && /^[\w.\-/:]{3,100}$/.test(input.model.trim()) ? input.model.trim() : undefined;
  const schedule = input.schedule === undefined ? base.schedule : validateSchedule(input.schedule);

  return {
    name,
    description: str(input.description, 200, base.description),
    instructions,
    icon: str(input.icon, 24, base.icon) || "agent",
    color: COLORS.includes(input.color as string) ? (input.color as string) : base.color,
    tools: {
      webSearch: typeof t.webSearch === "boolean" ? t.webSearch : base.tools.webSearch,
      askHuman: typeof t.askHuman === "boolean" ? t.askHuman : base.tools.askHuman,
      connections,
    },
    skills,
    memory,
    channels,
    subagents,
    helpers,
    triggers,
    ...(model ? { model } : {}),
    // Spread as a key so an update that turns the schedule off removes it, rather than leaving the old one under the new.
    schedule,
    sharing: { mode, people: mode === "people" ? people : [] },
  };
}
