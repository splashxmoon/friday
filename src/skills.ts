import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import { AgentError, type Person, type SharingMode } from "./agents.js";
import type { SkillBrief } from "./types.js";

/**
 * Skills: a named piece of instruction the team reuses.
 *
 * An agent is a standing identity — a role with its own tools and its own idea
 * of what it is for. A skill is smaller and more portable: how to do one thing
 * well, dropped into whatever session needs it. "Write a postmortem this way",
 * "review SQL against these rules", "summarise a call in our format".
 *
 * They are separate from agents because the same skill belongs in many agents,
 * and folding it into one would mean copying it into each.
 */
export interface SkillDef {
  id: string;
  name: string;
  description: string;
  /** The instruction itself, delivered to the agent when the skill is used. */
  instructions: string;
  icon: string;
  /** Words that suggest this skill fits the work at hand. */
  keywords: string[];
  /** Reference material handed to the agent alongside the instruction.
   *  Small and inline on purpose: a template or a schema, not a corpus. */
  resources: { name: string; text: string }[];
  ownerId: string;
  ownerName: string;
  sharing: { mode: SharingMode; people: string[] };
  /** Where it was imported from, so importing the same file again updates this skill instead of adding a copy. */
  source?: { repo: string; path: string };
  /** The collection it belongs to, when it came in with a whole repository. */
  collectionId?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * A repository imported whole: a container for the skills that came with it.
 *
 * Hundreds of skills cannot be a page of cards or a list of ids on an agent, so
 * the collection is the unit: you import it, browse it, hand it to an agent and
 * remove it as one thing. Its skills are still ordinary skills underneath.
 */
export interface SkillCollection {
  id: string;
  ownerId: string;
  ownerName: string;
  /** owner/repo, which is also what it is called. */
  name: string;
  repo: string;
  /** A folder inside the repository, when only part of it was imported. */
  path: string;
  createdAt: number;
  updatedAt: number;
}

export type CollectionView = SkillCollection & { count: number };
/** What a skill looks like in a long list: no instructions, which are the heavy part. */
export type SkillLine = { id: string; name: string; description: string; path: string };

export type SkillView = SkillDef & { access: "owner" | "shared" };
export type SkillInput = Partial<Pick<SkillDef, "name" | "description" | "instructions" | "icon" | "keywords" | "resources" | "sharing">>;

export class SkillRegistry {
  constructor(
    private redis: Redis,
    private prefix: string,
  ) {}

  private get key() {
    return `${this.prefix}skills`;
  }

  private async all(): Promise<SkillDef[]> {
    const h = await this.redis.hgetall(this.key);
    return Object.values(h).map((v) => read(v));
  }

  private canUse(s: SkillDef, userId: string): boolean {
    return s.ownerId === userId || s.sharing.mode === "workspace" || (s.sharing.mode === "people" && s.sharing.people.includes(userId));
  }

  async listFor(userId: string): Promise<SkillView[]> {
    await this.ready();
    return (await this.all())
      // A collection's skills live inside it: listed here they would bury everything else.
      .filter((s) => this.canUse(s, userId) && !s.collectionId)
      .map((s) => ({ ...s, access: s.ownerId === userId ? ("owner" as const) : ("shared" as const) }))
      .sort((a, b) => Number(b.access === "owner") - Number(a.access === "owner") || b.updatedAt - a.updatedAt);
  }

  /**
   * One skill as an agent carries it, or null if it's gone or `forUserId` can't
   * use it. Resources ride along with the instruction, since a template or a
   * schema is useless arriving separately.
   */
  async brief(id: string, forUserId: string): Promise<{ id: string; name: string; description: string; instructions: string } | null> {
    const s = await this.get(id);
    if (!s || !this.canUse(s, forUserId)) return null;
    const resources = s.resources.map((r) => `\n\n--- ${r.name} ---\n${r.text}`).join("");
    return { id: s.id, name: s.name, description: s.description, instructions: s.instructions + resources };
  }

  async get(id: string): Promise<SkillDef | null> {
    const raw = await this.redis.hget(this.key, id);
    return raw ? read(raw) : null;
  }

  async create(user: Person, input: SkillInput): Promise<SkillView> {
    const now = Date.now();
    const s: SkillDef = {
      id: randomBytes(6).toString("base64url"),
      ownerId: user.id,
      ownerName: user.name,
      createdAt: now,
      updatedAt: now,
      ...validate(input, { name: "", description: "", instructions: "", icon: "book", keywords: [], resources: [], sharing: { mode: "private", people: [] } }),
    };
    await this.redis.hset(this.key, s.id, JSON.stringify(s));
    return { ...s, access: "owner" };
  }

  /**
   * Skills brought in from a repository. One that was imported before, from
   * the same file, is brought up to date in place: keeping its id means the
   * agents that already use it keep using it, and its sharing stays as set.
   */
  async importMany(user: Person, items: (SkillInput & { source: { repo: string; path: string } })[]): Promise<{ created: SkillView[]; updated: SkillView[] }> {
    await this.ready();
    const mine = (await this.all()).filter((s) => s.ownerId === user.id);
    const created: SkillView[] = [];
    const updated: SkillView[] = [];
    for (const { source, ...input } of items) {
      const was = mine.find((s) => s.source?.repo === source.repo && s.source.path === source.path);
      if (was) {
        const next: SkillDef = { ...was, ...validate(input, was), source, updatedAt: Date.now() };
        await this.redis.hset(this.key, was.id, JSON.stringify(next));
        updated.push({ ...next, access: "owner" });
      } else {
        const now = Date.now();
        const s: SkillDef = {
          id: randomBytes(6).toString("base64url"),
          ownerId: user.id,
          ownerName: user.name,
          createdAt: now,
          updatedAt: now,
          source,
          ...validate(input, { name: "", description: "", instructions: "", icon: "book", keywords: [], resources: [], sharing: { mode: "private", people: [] } }),
        };
        await this.redis.hset(this.key, s.id, JSON.stringify(s));
        created.push({ ...s, access: "owner" });
      }
    }
    return { created, updated };
  }

  private get collectionsKey() {
    return `${this.prefix}skill-collections`;
  }

  /** A collection's skills, in full. Kept apart from your own skills so the page that lists those never reads these. */
  private membersKey(cid: string) {
    return `${this.prefix}skillcol:${cid}`;
  }

  /** The same skills as one short line each: what a list, a menu and a search need, without the instructions. */
  private linesKey(cid: string) {
    return `${this.prefix}skillcol-lines:${cid}`;
  }

  private migration: Promise<void> | null = null;

  /**
   * Collections used to keep their skills in the same hash as everything else,
   * so every visit to the skills page read all of them (hundreds of full
   * briefs) to show a handful of cards. Moved out once, on first use.
   */
  private ready(): Promise<void> {
    return (this.migration ??= (async () => {
      const flag = `${this.prefix}skills-split`;
      if (await this.redis.get(flag)) return;
      const members = new Map<string, SkillDef[]>();
      for (const s of (await this.all()).filter((x) => x.collectionId)) members.set(s.collectionId!, [...(members.get(s.collectionId!) ?? []), s]);
      for (const [cid, list] of members) {
        const p = this.redis.pipeline();
        for (const s of list) {
          p.hset(this.membersKey(cid), s.id, JSON.stringify(s));
          p.hset(this.linesKey(cid), s.id, JSON.stringify({ name: s.name, description: s.description, path: s.source?.path ?? "" }));
          p.hdel(this.key, s.id);
        }
        await p.exec();
      }
      await this.redis.set(flag, "1");
    })());
  }

  private async allCollections(): Promise<SkillCollection[]> {
    await this.ready();
    return Object.values(await this.redis.hgetall(this.collectionsKey)).map((v) => JSON.parse(v) as SkillCollection);
  }

  private async lines(cid: string): Promise<(SkillLine & { id: string })[]> {
    const h = await this.redis.hgetall(this.linesKey(cid));
    return Object.entries(h)
      .map(([id, v]) => ({ id, ...(JSON.parse(v) as Omit<SkillLine, "id">) }))
      .sort((a, b) => byPath(a.path, b.path));
  }

  async collectionsFor(userId: string): Promise<CollectionView[]> {
    const mine = (await this.allCollections()).filter((c) => c.ownerId === userId);
    const counts = await Promise.all(mine.map((c) => this.redis.hlen(this.linesKey(c.id))));
    return mine.map((c, i) => ({ ...c, count: counts[i]! })).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * A whole repository, as one collection. Importing the same repository again
   * refreshes the collection that is already there, so its id, and every agent
   * that was given it, carry on working.
   */
  async importCollection(user: Person, repo: string, path: string, items: (SkillInput & { source: { repo: string; path: string } })[]): Promise<{ collection: CollectionView; added: number; updated: number }> {
    const now = Date.now();
    const was = (await this.allCollections()).find((c) => c.ownerId === user.id && c.repo === repo && c.path === path);
    const col: SkillCollection = was
      ? { ...was, updatedAt: now }
      : { id: randomBytes(6).toString("base64url"), ownerId: user.id, ownerName: user.name, name: repo, repo, path, createdAt: now, updatedAt: now };
    const have = new Map((await this.lines(col.id)).map((l) => [l.path, l.id]));
    let added = 0;
    let updated = 0;
    const p = this.redis.pipeline();
    for (const { source, ...input } of items) {
      const id = have.get(source.path);
      const old = id ? (JSON.parse((await this.redis.hget(this.membersKey(col.id), id)) ?? "null") as SkillDef | null) : null;
      const base: Editable = old ?? { name: "", description: "", instructions: "", icon: "book", keywords: [], resources: [], sharing: { mode: "private", people: [] } };
      const s: SkillDef = {
        id: old?.id ?? randomBytes(6).toString("base64url"),
        ownerId: user.id,
        ownerName: user.name,
        createdAt: old?.createdAt ?? now,
        ...validate(input, base),
        source,
        collectionId: col.id,
        updatedAt: now,
      };
      p.hset(this.membersKey(col.id), s.id, JSON.stringify(s));
      p.hset(this.linesKey(col.id), s.id, JSON.stringify({ name: s.name, description: s.description, path: source.path }));
      if (old) updated++;
      else added++;
    }
    p.hset(this.collectionsKey, col.id, JSON.stringify(col));
    await p.exec();
    return { collection: { ...col, count: have.size + added }, added, updated };
  }

  /** What is in a collection, light enough to list: names and descriptions, not the instructions. */
  async collectionSkills(user: Person, id: string): Promise<{ collection: CollectionView; skills: SkillLine[] }> {
    const col = (await this.allCollections()).find((c) => c.id === id);
    if (!col || col.ownerId !== user.id) throw new AgentError(404, "Collection not found.");
    const skills = await this.lines(id);
    return { collection: { ...col, count: skills.length }, skills };
  }

  async removeCollection(user: Person, id: string): Promise<number> {
    const col = (await this.allCollections()).find((c) => c.id === id);
    if (!col || col.ownerId !== user.id) throw new AgentError(404, "Collection not found.");
    const n = await this.redis.hlen(this.linesKey(id));
    await this.redis.del(this.membersKey(id), this.linesKey(id));
    await this.redis.hdel(this.collectionsKey, id);
    return n;
  }

  /**
   * A collection as an agent carries it: the menu without the contents. Each
   * entry says what the skill is for and where to fetch it from when it is
   * wanted, so an agent handed four hundred skills starts a session with a list
   * of names rather than four hundred briefs.
   */
  async collectionBriefs(id: string, ownerId: string, only?: string[]): Promise<SkillBrief[]> {
    const col = (await this.allCollections()).find((c) => c.id === id);
    if (!col || col.ownerId !== ownerId) return [];
    const want = only ? new Set(only) : null;
    return (await this.lines(id)).filter((l) => !want || want.has(l.id)).map((l) => {
      const parts = l.path.split("/");
      const folder = parts.length > 2 ? parts[0]!.replace(/[-_]+/g, " ") : "";
      return { id: l.id, name: l.name, description: l.description, instructions: "", group: folder ? `${col.name} › ${folder}` : col.name, lazy: { owner: ownerId, collection: id } };
    });
  }

  /**
   * Every skill in every collection this person has, one line each, named by the
   * id an agent is given it by: `collection:<collection>:<skill>`. What the agent
   * builder chooses from, so it can pick the few that fit a job instead of
   * handing an agent a whole repository.
   */
  async poolFor(userId: string): Promise<{ ref: string; name: string; description: string; path: string; collection: string }[]> {
    const cols = (await this.allCollections()).filter((c) => c.ownerId === userId);
    const lists = await Promise.all(cols.map((c) => this.lines(c.id)));
    return cols.flatMap((c, i) => lists[i]!.map((l) => ({ ref: `collection:${c.id}:${l.id}`, name: l.name, description: l.description, path: l.path, collection: c.name })));
  }

  /** One skill out of a collection, in full, as its owner's agent would carry it. */
  async collectionBrief(collectionId: string, id: string, ownerId: string): Promise<string | null> {
    const col = (await this.allCollections()).find((c) => c.id === collectionId);
    if (!col || col.ownerId !== ownerId) return null;
    const raw = await this.redis.hget(this.membersKey(collectionId), id);
    if (!raw) return null;
    const s = read(raw);
    return s.instructions + s.resources.map((r) => `\n\n--- ${r.name} ---\n${r.text}`).join("");
  }

  async update(user: Person, id: string, input: SkillInput): Promise<SkillView> {
    const s = await this.owned(user, id);
    const next: SkillDef = { ...s, ...validate(input, s), updatedAt: Date.now() };
    await this.redis.hset(this.key, id, JSON.stringify(next));
    return { ...next, access: "owner" };
  }

  async remove(user: Person, id: string): Promise<void> {
    await this.owned(user, id);
    await this.redis.hdel(this.key, id);
  }

  /** Decline a skill shared with you: it leaves your list and nobody else's. */
  async leaveShared(user: Person, id: string): Promise<void> {
    const s = await this.get(id);
    if (!s || !this.canUse(s, user.id)) throw new AgentError(404, "Skill not found.");
    if (s.ownerId === user.id) throw new AgentError(400, "You own this skill. Delete it instead.");
    if (s.sharing.mode === "workspace") throw new AgentError(400, `${s.name} is shared with the whole workspace, so it can't be removed from your list alone.`);
    if (!s.sharing.people.includes(user.id)) throw new AgentError(404, "Skill not found.");
    s.sharing = { ...s.sharing, people: s.sharing.people.filter((p) => p !== user.id) };
    s.updatedAt = Date.now();
    await this.redis.hset(this.key, id, JSON.stringify(s));
  }

  private async owned(user: Person, id: string): Promise<SkillDef> {
    const s = await this.get(id);
    if (!s) throw new AgentError(404, "Skill not found.");
    if (s.ownerId !== user.id) throw new AgentError(403, "Only its owner can change this skill.");
    return s;
  }
}

/** Paths in order, with the tool-specific dot-folders (.gemini, .codex) after the real ones. */
const byPath = (a: string, b: string) => Number(a.startsWith(".")) - Number(b.startsWith(".")) || a.localeCompare(b);

/** Skills saved before a field existed still have to load. */
function read(raw: string): SkillDef {
  const s = JSON.parse(raw) as SkillDef;
  return { ...s, resources: s.resources ?? [] };
}

type Editable = Pick<SkillDef, "name" | "description" | "instructions" | "icon" | "keywords" | "resources" | "sharing">;

function validate(input: SkillInput, base: Editable): Editable {
  const str = (v: unknown, max: number, fallback = "") => (typeof v === "string" ? v.trim().slice(0, max) : fallback);

  const name = str(input.name, 40, base.name);
  if (!name) throw new AgentError(400, "Give the skill a name.");
  const instructions = str(input.instructions, 8000, base.instructions);
  if (!instructions) throw new AgentError(400, "A skill needs instructions: say how to do the thing.");

  const keywords = Array.isArray(input.keywords)
    ? [...new Set(input.keywords.filter((k): k is string => typeof k === "string").map((k) => k.trim().toLowerCase().slice(0, 24)).filter(Boolean))].slice(0, 12)
    : base.keywords;

  // Capped hard: these travel in every prompt that uses the skill, so a big
  // file here is a cost on every run rather than a one-off upload.
  const resources = Array.isArray(input.resources)
    ? input.resources
        .filter((r): r is { name: string; text: string } => !!r && typeof r.name === "string" && typeof r.text === "string")
        .map((r) => ({ name: r.name.trim().slice(0, 80), text: r.text.slice(0, 20_000) }))
        .filter((r) => r.name && r.text.trim())
        .slice(0, 5)
    : base.resources;

  const sh = (input.sharing ?? base.sharing) as Partial<SkillDef["sharing"]>;
  const mode: SharingMode = sh.mode === "people" || sh.mode === "workspace" ? sh.mode : "private";
  const people = Array.isArray(sh.people) ? sh.people.filter((p) => typeof p === "string" && p.length <= 64).slice(0, 200) : [];

  return {
    name,
    description: str(input.description, 200, base.description),
    instructions,
    icon: str(input.icon, 24, base.icon) || "book",
    keywords,
    resources,
    sharing: { mode, people: mode === "people" ? people : [] },
  };
}
