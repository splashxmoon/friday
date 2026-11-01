import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import type { MeshResult, MeshToolDef } from "./agent-mesh.js";
import type { AgentTool } from "./agent/tools.js";
import type { MateNote } from "./engine/hub.js";
import type { SessionStore } from "./session/store.js";
import type { TeammateStore } from "./teammates.js";
import { MAIN_LANE } from "./types.js";

/**
 * Crew skills: named, reusable procedures the crew keeps ("cut a release", "triage a bug report", "write the weekly changelog"),
 * so work done well once is done the same way next time (Arun, 2026-10-31: skills picked as the biggest repeat-work saver, after
 * Grok's Skills, Hermes's self-taught skills and Floatboat's Combo Skills).
 *
 * A skill is a name, a line on when to use it, its steps as instructions, and, if it has them, the inputs it takes and the check
 * that proves it worked. It belongs to the crew: the person's in the open-source edition, the workspace's on the hosted service,
 * each with its author there. It is open to every teammate, or kept for some (`for`).
 *
 * Each teammate's note lists the names and one-line whens of the skills it may use, nothing more, so turns stay cheap; it fetches
 * the steps with use_skill when one fits. A teammate proposes one with save_skill after a run that went well: it lands as a card
 * for the person (skill.proposed), who keeps it or drops it, and until then it isn't offered to anyone.
 *
 * A skill is words only. It never changes who a teammate works for or on whose account it runs (own-plan.ts): the steps are done
 * as the teammate's own work, for whoever it works for.
 */

export interface SkillAuthor {
  id: string;
  name: string;
  kind: "person" | "teammate";
  /** A teammate's keeper, on the hosted service: the person it works for. */
  keeper?: { id: string; name: string };
}

export interface Skill {
  id: string;
  name: string;
  /** When to use it, in a line: what the note lists. */
  when: string;
  /** What to do, as instructions. */
  steps: string;
  /** What it takes, said in words ("the version number; the repo"). */
  inputs?: string;
  /** What proves it worked. */
  check?: string;
  /** The teammates it is kept for, by id; absent or empty, any teammate may use it. */
  for?: string[];
  author: SkillAuthor;
  /** Proposed by a teammate (save_skill): for whom to keep or drop, from where. Cleared once kept. */
  proposed?: { for: { id: string; name: string }; sid: string; lane: string; at: number };
  /** A proposed change to a kept skill, by its id: kept, it replaces that skill's when, steps, inputs and check, and goes. */
  revises?: string;
  created: number;
  updated: number;
}

/** A skill as the page shows it: with how often it was used, and whether this person may change it. */
export interface SkillView extends Skill {
  uses: number;
  lastUsed: { at: number; by: string } | null;
  mine: boolean;
}

export const MAX_SKILLS = 100;
/** Proposals waiting at once: a teammate can't fill the person's Crew with cards. */
export const MAX_PROPOSED = 10;
/** How many skills a note lists, and how long each one's line is there. */
const NOTE_MAX = 30;
const NOTE_LINE = 110;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const str = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");

/** A skill's details as sent by the page or an agent, checked; throws with what is wrong. `known`: the crew's teammate ids. */
export function cleanSkill(body: Record<string, unknown>, known?: readonly string[]): Pick<Skill, "name" | "when" | "steps"> & Partial<Pick<Skill, "inputs" | "check" | "for">> {
  const name = str(body.name, 60).replace(/\s+/g, " ");
  if (!name) throw new Error("Give the skill a name, like “Cut a release”.");
  const when = str(body.when, 240).replace(/\s+/g, " ");
  if (!when) throw new Error("Say in a line when to use it.");
  const steps = str(body.steps, 8000);
  if (!steps) throw new Error("Write its steps: what to do, as instructions.");
  const forIds = Array.isArray(body.for) ? [...new Set(body.for.filter((x): x is string => typeof x === "string" && !!x))] : null;
  if (forIds && known && forIds.some((x) => !known.includes(x))) throw new Error("One of those teammates isn't in the crew any more.");
  return {
    name,
    when,
    steps,
    ...("inputs" in body ? { inputs: str(body.inputs, 1000) || undefined } : {}),
    ...("check" in body ? { check: str(body.check, 1000) || undefined } : {}),
    ...(forIds ? { for: forIds.length ? forIds : undefined } : {}),
  };
}

/** The teammates a skill is kept for that are still in the crew (`live`): when none is left, it is open to all rather than dead. */
const keptFor = (s: Skill, live?: (id: string) => boolean) => (s.for ?? []).filter((id) => !live || live(id));

/** Whether a teammate may use a skill: kept (not a proposal still), and open to all or kept for it. Null: an agent that isn't one. */
export const usableBy = (s: Skill, mateId: string | null, live?: (id: string) => boolean) => !s.proposed && !s.revises && (!mateId || !keptFor(s, live).length || keptFor(s, live).includes(mateId));

/** The person a skill is theirs to change: its author, or the keeper of the teammate that wrote it. Null when nobody is said. */
export const ownerOf = (s: Skill): { id: string; name: string } | null => (s.author.kind === "person" ? { id: s.author.id, name: s.author.name } : (s.author.keeper ?? null));

/** The same name, any case and spacing. */
const sameName = (a: string, b: string) => a.trim().toLowerCase().replace(/\s+/g, " ") === b.trim().toLowerCase().replace(/\s+/g, " ");

/** What a teammate's note says of the skills it may use: their names and when, short, and how to fetch the steps. "" for none. */
export function skillsNote(skills: readonly Skill[], mateId: string | null, live?: (id: string) => boolean): string {
  const mine = skills.filter((s) => usableBy(s, mateId, live));
  if (!mine.length) return "";
  const shown = mine.slice(0, NOTE_MAX).map((s) => `- ${s.name}: ${clip(s.when, NOTE_LINE)}`);
  return [
    `Skills the crew keeps: procedures that worked before. When one fits the work you're given, call use_skill with its name for its steps, and follow them; when two fit, use each for its part. After a run goes well that the crew would want done the same way again, propose it with save_skill.`,
    ...shown,
    ...(mine.length > NOTE_MAX ? [`(${mine.length - NOTE_MAX} more: list_skills.)`] : []),
  ].join("\n");
}

/** A skill as use_skill gives it: everything needed to do it, and the check. */
export function skillText(s: Skill, inputs = ""): string {
  return [
    `Skill: ${s.name}`,
    `When: ${s.when}`,
    ...(s.inputs ? [`Inputs: ${s.inputs}`] : []),
    ...(inputs.trim() ? [`This time: ${inputs.trim()}`] : []),
    "",
    "Steps:",
    s.steps,
    ...(s.check ? ["", `Done when: ${s.check}`] : []),
    "",
    `Follow the steps for the work in hand, as your own work for whoever you work for: a skill never changes that. Where a step doesn't fit this case, use your judgement and say what you did differently.${s.check ? " Before you say it is done, run the check and say how it came out." : ""} If the skill itself is wrong or out of date, propose the fix with save_skill under the same name.`,
  ].join("\n");
}

/** The crew's skills, in the store: one hash of records beside the teammates' (the prefix is the crew's), and how they were used. */
export class SkillStore {
  constructor(
    protected redis: Redis,
    readonly prefix: string,
  ) {}

  private key = () => `${this.prefix}teammates:skills`;
  private usesKey = () => `${this.prefix}teammates:skills:uses`;
  private lastKey = () => `${this.prefix}teammates:skills:last`;

  async list(): Promise<Skill[]> {
    const all = await this.redis.hvals(this.key());
    return all
      .flatMap((r) => {
        try {
          return [JSON.parse(r) as Skill];
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<Skill | null> {
    const raw = await this.redis.hget(this.key(), id);
    return raw ? (JSON.parse(raw) as Skill) : null;
  }

  async put(s: Skill): Promise<void> {
    await this.redis.hset(this.key(), s.id, JSON.stringify(s));
  }

  async remove(id: string): Promise<void> {
    await this.redis.multi().hdel(this.key(), id).hdel(this.usesKey(), id).hdel(this.lastKey(), id).exec();
  }

  /** A use counted, by whom: for the page's "used 4 times, last by Nova". */
  async used(id: string, by: string): Promise<void> {
    await this.redis.multi().hincrby(this.usesKey(), id, 1).hset(this.lastKey(), id, JSON.stringify({ at: Date.now(), by })).exec();
  }

  async views(mine: (s: Skill) => boolean): Promise<SkillView[]> {
    const [list, uses, last] = await Promise.all([this.list(), this.redis.hgetall(this.usesKey()), this.redis.hgetall(this.lastKey())]);
    return list.map((s) => {
      let lastUsed: SkillView["lastUsed"] = null;
      try {
        lastUsed = last[s.id] ? (JSON.parse(last[s.id]!) as { at: number; by: string }) : null;
      } catch {
        // Unread, as never used.
      }
      return { ...s, uses: Number(uses[s.id] ?? 0), lastUsed, mine: mine(s) };
    });
  }

  /** A new skill, its name the crew's only one; throws with what is wrong. */
  async add(c: ReturnType<typeof cleanSkill>, author: SkillAuthor, proposed?: Skill["proposed"]): Promise<Skill> {
    const list = await this.list();
    if (list.length >= MAX_SKILLS) throw new Error(`The crew keeps up to ${MAX_SKILLS} skills. Delete one you don't use first.`);
    if (list.some((s) => !s.revises && sameName(s.name, c.name))) throw new Error(`The crew already has a skill called “${c.name}”.`);
    if (proposed && list.filter((s) => s.proposed).length >= MAX_PROPOSED) throw new Error(`${MAX_PROPOSED} proposed skills already wait for the person to keep or drop. Say in your reply what you'd save instead.`);
    const now = Date.now();
    const s: Skill = { id: randomBytes(5).toString("hex"), ...c, author, ...(proposed ? { proposed } : {}), created: now, updated: now };
    await this.put(s);
    return s;
  }

  /**
   * A teammate's proposal (save_skill), for `proposed.for` to keep or drop. Named as a kept skill, it is a change to that skill
   * (`revises`); proposed again by the same author, the proposal waiting is updated rather than another made. `again`: it was.
   */
  async propose(c: ReturnType<typeof cleanSkill>, author: SkillAuthor, proposed: NonNullable<Skill["proposed"]>): Promise<{ s: Skill; again: boolean }> {
    const list = await this.list();
    const same = list.find((s) => !s.revises && sameName(s.name, c.name));
    const had = same && !same.proposed ? list.find((s) => s.revises === same.id && s.author.id === author.id) : same;
    if (had && had.author.id !== author.id) throw new Error(`${had.author.name} already proposed “${had.name}”, and it waits on the person. Pick another name.`);
    if (!had && list.filter((s) => s.proposed).length >= MAX_PROPOSED) throw new Error(`${MAX_PROPOSED} proposed skills already wait for the person to keep or drop. Say in your reply what you'd save instead.`);
    const now = Date.now();
    if (had) {
      const next: Skill = { ...had, ...c, name: had.name, proposed, updated: now };
      await this.put(next);
      return { s: next, again: true };
    }
    if (same) {
      const s: Skill = { id: randomBytes(5).toString("hex"), ...c, name: same.name, author, proposed, revises: same.id, created: now, updated: now };
      await this.put(s);
      return { s, again: false };
    }
    return { s: await this.add(c, author, proposed), again: false };
  }

  /** A skill changed: its details and/or kept (a proposal no more). Throws with what is wrong; null when it is gone. */
  async edit(id: string, body: Record<string, unknown>, known?: readonly string[]): Promise<Skill | null> {
    const had = await this.get(id);
    if (!had) return null;
    // A change to a kept skill, kept: that skill takes its words, keeping its name, who it's for and its author; this one goes.
    if (body.keep === true && had.revises) {
      const was = await this.get(had.revises);
      if (was) {
        const c = cleanSkill({ ...had, ...body });
        const next: Skill = { ...was, when: c.when, steps: c.steps, ...(c.inputs ? { inputs: c.inputs } : {}), ...(c.check ? { check: c.check } : {}), updated: Date.now() };
        await this.put(next);
        await this.remove(id);
        return next;
      }
      // That skill was deleted meanwhile: kept as a skill of its own.
      delete had.revises;
    }
    const changing = ["name", "when", "steps", "inputs", "check", "for"].some((k) => k in body);
    const c = changing ? cleanSkill({ ...had, ...body }, known) : null;
    if (c && !sameName(c.name, had.name) && (await this.list()).some((s) => s.id !== id && sameName(s.name, c.name))) throw new Error(`The crew already has a skill called “${c.name}”.`);
    const next: Skill = { ...had, ...(c ?? {}), ...(body.keep === true ? { proposed: undefined } : {}), updated: Date.now() };
    for (const k of ["inputs", "check", "for", "proposed"] as const) if (next[k] === undefined) delete next[k];
    await this.put(next);
    return next;
  }
}

// ── The agents' tools ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });

/** list_skills, use_skill and save_skill: offered wherever there is a crew, beside manage_teammate. */
export const SKILL_TOOLS: MeshToolDef[] = [
  {
    name: "list_skills",
    description: "The crew's skills you may use: reusable procedures that worked before, each with its name and when to use it. Your instructions list them too; this has them all.",
    inputSchema: obj({}, []),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "use_skill",
    description: "A crew skill's steps, by its name: call it when a skill fits the work you're given, then follow the steps and run its check before you say it's done.",
    inputSchema: obj({ name: { type: "string", description: "The skill's name, as listed." }, inputs: { type: "string", description: "What it is for this time, if it takes inputs: the version, the issue, the folder." } }, ["name"]),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "save_skill",
    description:
      "Propose a new crew skill from work that went well and will come up again, or when the person asks you to save what you did as one. Write it for anyone in the crew, not this one case: name the inputs rather than this time's values. Named as a skill the crew already keeps, it proposes a change to that skill (send it whole: when, steps, inputs, check). It goes to the person as a card to keep or drop, and isn't offered to the crew until they keep it.",
    inputSchema: obj(
      {
        name: { type: "string", description: "Short, as a verb: “Cut a release”, “Triage a bug report”." },
        when: { type: "string", description: "One line on when to use it." },
        steps: { type: "string", description: "What to do, as numbered instructions." },
        inputs: { type: "string", description: "What it takes, if anything: “the version number; the repo”." },
        check: { type: "string", description: "What proves it worked: a test that passes, a page that loads, a link that answers." },
      },
      ["name", "when", "steps"],
    ),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
];
/** The same tools as Friday Code's own, for a teammate on one of the person's own models (agent/runtime.ts laneOwn). */
const SKILL_AGENT_TOOLS: AgentTool[] = SKILL_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  parameters: t.inputSchema,
  cancellable: false,
  async run(args, ctx) {
    if (!ctx.mesh) return { output: "There's no crew here, so no skills.", isError: true };
    const r = await ctx.mesh.call(t.name, args, ctx.signal);
    return { output: r.output, ...(r.isError ? { isError: true } : {}) };
  },
}));

/** Where an agent is, as the skills see it: its crew's skills, the teammate it is (if one), and whom a proposal goes to. */
export interface SkillPlace {
  store: SkillStore;
  /** The teammate on the lane, when it is one. */
  mate: { id: string; name: string; keeper?: { id: string; name: string } } | null;
  /** The agent's name, as a teammate's or its lane's. */
  name: string;
  /** Whom a proposal is for: the person it works for. */
  person: { id: string; name: string };
  /** A teammate's name by id, for "kept for Kit". */
  mateName: (id: string) => string | undefined;
  /** The card for `to` to keep or drop it (skill.proposed), posted in their Crew. */
  card: (s: Skill, madeBy: { lane: string; name: string }, to: { id: string; name: string }) => Promise<void>;
}

/** The skills' tools and the note's line, for the app: `place` says where an agent is, null where there is no crew. */
export function skillTools(place: (sid: string, lane: string) => Promise<SkillPlace | null>) {
  const offered = async (sid: string) => !!(await place(sid, MAIN_LANE).catch(() => null));

  const call = async (sid: string, lane: string, name: string, args: Record<string, unknown>): Promise<MeshResult> => {
    const p = await place(sid, lane);
    if (!p) return { output: "There's no crew here, so no skills.", isError: true };
    const all = await p.store.list();
    const live = (id: string) => !!p.mateName(id);
    const me = p.mate?.id ?? null;
    const kept = all.filter((s) => !s.proposed && !s.revises);
    const forWho = (s: Skill) => (keptFor(s, live).length ? ` (kept for ${keptFor(s, live).map((id) => (id === me ? "you" : p.mateName(id))).join(", ")})` : "");
    switch (name) {
      case "list_skills": {
        const mine = all.filter((s) => usableBy(s, me, live));
        if (!mine.length) return { output: kept.length ? "No skills are kept for you. save_skill proposes one." : "The crew has no skills yet. save_skill proposes one after a run that went well." };
        return { output: mine.map((s) => `${s.name}${forWho(s)}: ${s.when}${s.inputs ? `\n  Inputs: ${s.inputs}` : ""}`).join("\n") };
      }
      case "use_skill": {
        const want = str(args.name, 80);
        const s = kept.find((x) => sameName(x.name, want)) ?? (want.length >= 3 ? kept.find((x) => x.name.toLowerCase().includes(want.toLowerCase())) : undefined);
        // Renamed or deleted since a workflow step or a note named it: what there is, so it carries on without.
        if (!s) {
          const mine = kept.filter((x) => usableBy(x, me, live));
          return { output: `There's no skill called “${want}” now.${mine.length ? ` The crew's: ${mine.map((x) => x.name).join(", ")}.` : ""} Do the work without it, or use one of those if it fits.`, isError: true };
        }
        if (!usableBy(s, me, live)) return { output: `“${s.name}” is kept for ${keptFor(s, live).map((id) => p.mateName(id)).join(", ")}. Hand the work to them, or ask the person to open it to you.`, isError: true };
        await p.store.used(s.id, p.name);
        return { output: skillText(s, str(args.inputs, 2000)) };
      }
      case "save_skill": {
        let c: ReturnType<typeof cleanSkill>;
        try {
          c = cleanSkill({ name: args.name, when: args.when, steps: args.steps, inputs: args.inputs, check: args.check });
        } catch (e) {
          return { output: (e as Error).message, isError: true };
        }
        const author: SkillAuthor = p.mate ? { id: p.mate.id, name: p.mate.name, kind: "teammate", ...(p.mate.keeper ? { keeper: p.mate.keeper } : {}) } : { id: `agent:${lane}`, name: p.name, kind: "teammate" };
        // A change to a kept skill is its owner's to keep (on the hosted service, perhaps someone else than whom this agent works for).
        const revised = kept.find((x) => sameName(x.name, c.name));
        const to = (revised && ownerOf(revised)) || p.person;
        let r: { s: Skill; again: boolean };
        try {
          r = await p.store.propose(c, author, { for: to, sid, lane, at: Date.now() });
        } catch (e) {
          return { output: (e as Error).message, isError: true };
        }
        if (!r.again) await p.card(r.s, { lane, name: p.name }, to);
        const whom = to.name || "the person";
        return {
          output: r.again
            ? `Updated your proposal “${r.s.name}”, still waiting on ${whom}.`
            : revised
              ? `Proposed your change to “${revised.name}” to ${whom}: theirs to keep or drop. Until then the crew uses it as it is. Carry on with your work.`
              : `Proposed “${r.s.name}” to ${whom}: theirs to keep or drop. It isn't offered to the crew until they keep it. Carry on with your work.`,
        };
      }
      default:
        return { output: "That isn't a skills tool.", isError: true };
    }
  };

  /** The note's line of skills, for the teammate on `lane`: "" for none, or no crew. */
  const note = async (sid: string, lane: string): Promise<string> => {
    const p = await place(sid, lane).catch(() => null);
    if (!p?.mate) return "";
    return skillsNote(await p.store.list(), p.mate.id, (id) => !!p.mateName(id));
  };

  /** A teammate's note (EngineHub.teammate) with its skills' line added: the hook both editions wrap theirs in. */
  const withNote =
    (base: (sid: string, lane: string) => Promise<MateNote | null>) =>
    async (sid: string, lane: string): Promise<MateNote | null> => {
      const n = await base(sid, lane);
      if (!n) return n;
      const line = await note(sid, lane).catch(() => "");
      return line ? { ...n, note: `${n.note}\n${line}` } : n;
    };

  /** The same for a teammate on its own model, run by Friday Code (agent/runtime.ts laneOwn): the line, and the tools as its own. */
  const withOwn =
    (base: (sid: string, lane: string) => Promise<{ model: string; note: string; tools?: AgentTool[] } | null>) =>
    async (sid: string, lane: string) => {
      const r = await base(sid, lane);
      if (!r) return r;
      const line = await note(sid, lane).catch(() => "");
      return { ...r, note: line ? `${r.note}\n\n${line}` : r.note, tools: [...(r.tools ?? []), ...SKILL_AGENT_TOOLS] };
    };

  return { offered, call, note, withNote, withOwn };
}

export type SkillTools = ReturnType<typeof skillTools>;

// ── The page's API: GET/POST /api/teammates/skills, PATCH/DELETE /api/teammates/skills/:id, POST …/write-up ──────────────────

/** Who is asking on the page, and what they may do: their crew's skills, the teammates there, and the edition's own rules. */
export interface SkillsScope {
  store: SkillStore;
  me: { id: string; name: string };
  /** The crew's teammate ids, for `for`. */
  mateIds: () => Promise<string[]>;
  /** Whether they may change or delete this skill. */
  mayEdit: (s: Skill) => boolean;
  /** They may keep any proposal (the open-source edition's one person, a workspace's owner or admin), not only those for them. */
  admin: boolean;
  /**
   * Ask the teammate on `lane` in `sid` to write what it just did up as a skill (save_skill): their own teammate only. Throws with
   * what is wrong.
   */
  writeUp: (sid: string, lane: string, text: string) => Promise<void>;
}

/** What a teammate is told, as the person, when they press "Save as a skill" on what it did: short, as it reads in the chat. */
export const WRITE_UP = "Save what you just did as a crew skill with save_skill, for anyone in the crew to repeat: a short name, when to use it, the steps with the inputs named rather than this time's values, and the check that proves it worked. Don't redo the work; reply in one line.";

/** One request to the skills API: the answer's status and body. Throws nothing. */
export async function skillsHttp(scope: SkillsScope, method: string, path: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  // `keep`: a proposal this person may keep (whom it is for, or an owner or admin).
  const page = async (more: Record<string, unknown> = {}) => ({ status: 200, body: { skills: (await scope.store.views(scope.mayEdit)).map((s) => ({ ...s, keep: !!s.proposed && (s.proposed.for.id === scope.me.id || scope.admin) })), ...more } });
  const rest = path.replace(/^\/api\/teammates\/skills\/?/, "");
  try {
    if (!rest) {
      if (method === "GET") return await page();
      if (method === "POST") {
        const made = await scope.store.add(cleanSkill(body, await scope.mateIds()), { id: scope.me.id, name: scope.me.name, kind: "person" });
        return await page({ made: made.id });
      }
      return { status: 405, body: { error: "Not allowed" } };
    }
    if (rest === "write-up") {
      if (method !== "POST") return { status: 405, body: { error: "Not allowed" } };
      const sid = str(body.sid, 80);
      const lane = str(body.lane, 80);
      if (!sid || !lane) return { status: 400, body: { error: "Say which teammate's run." } };
      await scope.writeUp(sid, lane, WRITE_UP);
      return { status: 200, body: { asked: true } };
    }
    const id = decodeURIComponent(rest);
    const s = await scope.store.get(id);
    if (!s) return { status: 404, body: { error: "That skill isn't there any more." } };
    if (!scope.mayEdit(s)) return { status: 403, body: { error: `“${s.name}” is ${s.author.kind === "person" ? s.author.name : (s.author.keeper?.name ?? s.author.name)}'s to change.` } };
    // A proposal is kept by whom it is for: a change to someone's skill by its owner, not by the proposer's keeper.
    if (method === "PATCH" && body.keep === true && s.proposed && s.proposed.for.id !== scope.me.id && !scope.admin) return { status: 403, body: { error: `“${s.name}” is ${s.proposed.for.name}'s to keep.` } };
    if (method === "PATCH") {
      await scope.store.edit(id, body, await scope.mateIds());
      return await page();
    }
    if (method === "DELETE") {
      await scope.store.remove(id);
      return await page();
    }
    return { status: 405, body: { error: "Not allowed" } };
  } catch (e) {
    return { status: 400, body: { error: (e as Error).message } };
  }
}

// ── The open-source edition's crew: the person's own, on this computer ─────────────────────────────────────────────────────

const FRIDAY = { id: "friday", name: "Friday", kind: "system" as const };

/**
 * Skills in the open-source edition: kept beside the person's teammates (the local store's prefix), proposals posted in the Crew
 * room for them. Whoever an agent here works for is the one person on this computer.
 */
export function localSkills(d: { redis: Redis; prefix: string; teammates: TeammateStore; store: SessionStore; person: { id: string; name: string }; wake: (sid: string, lane: string) => Promise<void> }) {
  const store = new SkillStore(d.redis, d.prefix);
  /** The teammate on a lane of the Crew room or one of its rooms. */
  const mateOn = async (sid: string, lane: string) => {
    const [list, team] = await Promise.all([d.teammates.list(), d.teammates.team()]);
    if (team === sid) return list.find((t) => t.lane === lane) ?? null;
    const r = (await d.teammates.rooms()).find((x) => x.sid === sid);
    const id = r && Object.entries(r.lanes).find(([, l]) => l === lane)?.[0];
    return id ? (list.find((t) => t.id === id) ?? null) : null;
  };
  const tools = skillTools(async (sid, lane) => {
    const [list, team] = await Promise.all([d.teammates.list(), d.teammates.team()]);
    if (!team && !list.length) return null;
    const t = await mateOn(sid, lane);
    const state = t ? null : await d.store.state(sid).catch(() => null);
    return {
      store,
      mate: t ? { id: t.id, name: t.name } : null,
      name: t?.name ?? (state?.lanes.find((l) => l.id === lane)?.name || "An agent"),
      person: d.person,
      mateName: (id) => list.find((x) => x.id === id)?.name,
      card: async (s, madeBy) => {
        if (team) await d.store.append(team, FRIDAY, { type: "skill.proposed", id: s.id, name: s.name, when: s.when, madeBy, ...(s.revises ? { revises: s.revises } : {}) }, { lane: MAIN_LANE });
      },
    };
  });
  const scope = (me: { id: string; name: string }): SkillsScope => ({
    store,
    me,
    mateIds: async () => (await d.teammates.list()).map((t) => t.id),
    mayEdit: () => true,
    admin: true,
    writeUp: async (sid, lane, text) => {
      if (!(await mateOn(sid, lane))) throw new Error("That isn't one of your teammates' chats.");
      const r = await d.store.append(sid, { id: me.id, name: me.name, kind: "human" }, { type: "instruction", text, interrupt: false }, { lane });
      if (!r.ok) throw new Error("Couldn't reach their chat. Try again in a moment.");
      await d.wake(sid, lane);
    },
  });
  return { store, tools, scope };
}
