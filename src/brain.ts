import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import type { LLM } from "./agent/llm.js";
import { hideSecrets } from "./secrets.js";
import { MAIN_LANE, type SessionEvent } from "./types.js";
import { ruleWords, type RuleCheck, type RuleHow } from "./rules.js";

/** A key or password in a lesson: never kept, whoever wrote it (org memory, 2026-10-31). */
const holdsSecret = (text: string) => hideSecrets(text).hidden > 0;
const SECRET_REFUSED = "That looks like a key or password. Project memory never keeps secrets: keep it in the project's .env and note its variable name instead.";

/**
 * The project brain: what a team has learned working on a repo, from every agent that worked on it.
 *
 * Every coding tool starts cold: Claude Code doesn't know what Codex tried yesterday, and tomorrow's session forgets the
 * dead end found today. Friday sees all of them, so each finished run of any of them (Friday's agent, Claude Code, Codex,
 * Cursor and the rest) is read for what the next person would want to know, and kept per repo: decisions and why,
 * approaches that failed and why, the team's conventions, facts about the code. Whichever agent starts next on that repo
 * is briefed with the part of it that bears on its task, and the session says so. The longer a team works here, the less
 * any agent starts from nothing.
 */

/**
 * `correction`: a mistake an agent made here that a person, a check or a reviewer had to put right, and what to do instead
 * (Arun, 2026-11-02, from "How to build a harness that actually improves your agent": "turn past failures into rules", "delete
 * rules you can't prove help", "back up your rules with scripts", "garden your harness"). The same mistake corrected again is
 * the same entry, counted; one that comes back after agents were told about it is offered to the person as a check Friday runs
 * (the prose didn't hold, so a script should); and a lesson nobody needs, or a run finds out of date, is retired.
 */
export type BrainKind = "correction" | "decision" | "pitfall" | "convention" | "fact";
export const BRAIN_KINDS: BrainKind[] = ["correction", "decision", "pitfall", "convention", "fact"];

/**
 * A command that catches a correction's mistake, as Friday offers it once the mistake came back: `proposed` in the session where
 * it came back (and Needs you), until the person adds it (Friday then runs it after agents change files in the repo) or says no.
 */
export interface BrainCheck {
  /** A `command` check's shell command; a rule read off the change (`how`) keeps its words here (rules.ts ruleWords). */
  command: string;
  /**
   * How it is checked (rules.ts; Arun, 2026-11-03: "Rules that stick"): absent or `command`, the command has to pass in the
   * agent's folder; `lines`, `runs` and `paths` are read straight off the change, with `pattern` (and `only`/`except` globs).
   */
  how?: RuleHow;
  pattern?: string;
  only?: string[];
  except?: string[];
  state: "suggested" | "proposed" | "added" | "declined";
  at: number;
  /** Where it was offered: the answer is said there too. */
  sid?: string;
  lane?: string;
  /** Who added it, and how often it has run and failed since: a check that catches the mistake shows that it does. */
  by?: string;
  runs?: number;
  caught?: number;
}

export interface BrainEntry {
  id: string;
  /** A short slug: the same thing learned twice is one entry, kept current. */
  key: string;
  text: string;
  kind: BrainKind;
  /** Where it came from: the agent whose run taught it (a coding tool, Friday's agent), or a person who wrote it. */
  from: { tool: string; name: string; sid?: string; title?: string };
  at: number;
  /** How many briefings it has been in: what keeps coming up rises. */
  uses: number;
  pinned?: boolean;
  /** A correction: how many times the mistake was corrected, when last, and `uses` then (how often agents were told since). */
  seen?: number;
  seenAt?: number;
  usesAtSeen?: number;
  /** Last put in a briefing: a lesson no agent has needed in RETIRE_DAYS is retired. */
  briefedAt?: number;
  check?: BrainCheck;
  /** Out of the briefings, and why: not needed in a long while, or a run found it out of date. Restorable; gone after PURGE_DAYS. */
  retired?: { at: number; why: string };
}

export interface BrainRepo {
  key: string;
  name: string;
  count: number;
  at: number;
  /** Sessions it has learned from, the newest few. */
  sessions: number;
}

/** A briefing: the text an agent is given, and enough about it to say so in the session. */
export interface Brief {
  text: string;
  count: number;
  sessions: number;
  tools: string[];
}

const MAX_PER_REPO = 200;
const MAX_TEXT = 400;
const DAY = 86_400_000;
/** A lesson no briefing has picked in this long, unpinned and no correction with a check behind it, is retired. */
export const RETIRE_DAYS = 60;
/** And a retired one is deleted this long after. */
export const PURGE_DAYS = 30;
/** Corrected this many times, the last after agents had been told: the prose isn't holding, so a check is offered. */
export const CHECK_AFTER = 2;
/** A check that fails after a turn sends it back this many times in a row, and then leaves it to the person. */
export const AFTER_RUN_TRIES = 2;
/** How much of an agent's opening prompt a briefing may take, in characters. */
export const BRIEF_BUDGET = 2400;

export { repoKeyOf, repoNameOf } from "./repo-key.js";
import { repoKeyOf } from "./repo-key.js";

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9_.-]+/).filter((w) => w.length > 3));
const KIND_TITLE: Record<BrainKind, string> = { correction: "Corrected before: don't do these again", decision: "Decided", pitfall: "Tried before, and why it didn't work", convention: "How it's done here", fact: "Worth knowing" };

/**
 * What to tell an agent starting on this task: pinned first, then what the task's own words touch, then what keeps
 * coming up, then what is newest, as far as the budget goes. Grouped by kind so it reads as a briefing, not a log. A mistake
 * someone had to correct weighs most after a pin, the more so the more often it came back; a retired lesson is left out.
 */
export function pickBrief(entries: BrainEntry[], task: string, budget = BRIEF_BUDGET): BrainEntry[] {
  const asked = words(task);
  const now = Date.now();
  const score = (e: BrainEntry) => {
    const overlap = [...words(e.text)].filter((w) => asked.has(w)).length;
    const days = (now - e.at) / DAY;
    const corrected = e.kind === "correction" ? 15 + Math.min(e.seen ?? 1, 5) * 5 : 0;
    return (e.pinned ? 1000 : 0) + overlap * 20 + Math.min(e.uses, 20) * 2 + Math.max(0, 10 - days) + (e.kind === "pitfall" ? 3 : 0) + corrected;
  };
  const out: BrainEntry[] = [];
  let used = 0;
  for (const e of [...entries].filter((x) => !x.retired).sort((a, b) => score(b) - score(a))) {
    if (used + e.text.length + 4 > budget) continue;
    out.push(e);
    used += e.text.length + 4;
  }
  return out.sort((a, b) => BRAIN_KINDS.indexOf(a.kind) - BRAIN_KINDS.indexOf(b.kind));
}

/** The briefing as an agent reads it. */
export function briefText(name: string, chosen: BrainEntry[], sessions: number): string {
  if (!chosen.length) return "";
  const parts = BRAIN_KINDS.flatMap((k) => {
    const of = chosen.filter((e) => e.kind === k);
    return of.length ? [`${KIND_TITLE[k]}:\n${of.map((e) => `- ${e.text}${e.check?.state === "added" ? (e.check.how && e.check.how !== "command" ? " Friday checks every change here for it." : ` Friday runs \`${e.check.command}\` after changes here to catch it.`) : ""}`).join("\n")}`] : [];
  });
  return `[Friday] What this team has learned working on ${name}, from ${sessions} earlier session${sessions === 1 ? "" : "s"} with any coding agent. It is background and may be out of date: where it and the code disagree, the code is right, and say so.\n\n${parts.join("\n\n")}\n\n`;
}

// ── reading a run for what it taught ─────────────────────────────────

const SYSTEM = `You read a finished run of a coding session and file what the next person, or the next coding agent, working on this repository will want to know. Answer with only a JSON array of at most 5 objects, each {"key": "a-short-slug", "kind": "correction" | "decision" | "pitfall" | "convention" | "fact", "text": "one or two sentences"}.

- correction: only when the run began with a correction (a person saying the last run got something wrong, a check that failed, work sent back): the mistake, said as a rule for next time ("Run the migrations before the API tests: agents keep forgetting and the tests fail on a missing column"). If the project memory below already holds that mistake, use its key exactly. Add "check": a shell command that would catch this mistake if it happened again, when the run shows one that exists in this repository and only reads (a test, typecheck or lint script, a grep that exits non-zero); leave it out otherwise.
- decision: a choice that was made, and why.
- pitfall: an approach that was tried and didn't work, and why, so nobody tries it again.
- convention: how this team or codebase does something (a command, a pattern, a rule it follows).
- fact: something true about the code that took finding out (where a thing lives, what depends on what).

Keep only what will still be true next week. Leave out status updates, anything the diff already shows, and anything that was only true for this run. Name files, commands and functions exactly.

If this run showed that something in the project memory below is wrong or out of date (a file it names is gone, a command it gives no longer works, the code now does otherwise), add {"key": "its key", "stale": "what the run found, in a line"}.

If there is nothing worth keeping, answer [].`;

export interface Lesson {
  key: string;
  kind: BrainKind;
  text: string;
  /** A correction's command that would catch the mistake, as the model offered it: never run until a person adds it. */
  check?: string;
}

/** A command a check may be: one line that reads and reports. Nothing that deletes, pushes, rewrites history or writes files. */
export function checkCommand(v: unknown): string | undefined {
  const c = typeof v === "string" ? v.trim() : "";
  if (!c || c.length > 200 || /[\n\r]/.test(c)) return undefined;
  if (/(^|[\s;&|(])(rm|rmdir|mv|sudo|curl|wget|chmod|chown|dd|mkfs|kill|pkill)\b|\bgit\s+(push|reset|checkout|clean|commit|rebase|stash|switch|restore)\b|\bnpm\s+(publish|install|i|ci|uninstall)\b|(^|[^>&2])>(?!&)|\|\s*(sh|bash|zsh)\b/.test(c)) return undefined;
  return c;
}

const ruleRegexOk = (p: string) => {
  try {
    return p.length > 0 && p.length <= 200 && !!new RegExp(p);
  } catch {
    return false;
  }
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

function jsonArray(raw: string): Record<string, unknown>[] {
  const from = raw.indexOf("[");
  const to = raw.lastIndexOf("]");
  if (from < 0 || to <= from) return [];
  try {
    const list = JSON.parse(raw.slice(from, to + 1)) as unknown;
    return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}

/** The model's answer as lessons; anything not in the shape asked for is no lesson at all, never a guess. */
export function parseLessons(raw: string): Lesson[] {
  const out: Lesson[] = [];
  for (const it of jsonArray(raw)) {
    const text = typeof it?.text === "string" ? it.text.trim().slice(0, MAX_TEXT) : "";
    if (text.length < 12) continue;
    const kind = BRAIN_KINDS.includes(it.kind as BrainKind) ? (it.kind as BrainKind) : "decision";
    const key = slug(typeof it.key === "string" && it.key ? it.key : text);
    const check = kind === "correction" ? checkCommand(it.check) : undefined;
    if (key) out.push({ key, kind, text, ...(check ? { check } : {}) });
    if (out.length >= 5) break;
  }
  return out;
}

/** What the model said the run found out of date in the project memory, by key, and why. */
export function parseStale(raw: string): { key: string; why: string }[] {
  return jsonArray(raw).flatMap((it) => (typeof it?.key === "string" && typeof it.stale === "string" && it.stale.trim() ? [{ key: slug(it.key), why: it.stale.trim().slice(0, 300) }] : [])).slice(0, 5);
}

/**
 * What a run taught, read with what the project memory already holds (`known`, so a mistake made again keeps its key and a
 * lesson the run proved wrong can be named) and how the run began (`began`: a correction, when it was one).
 */
export async function extractLessons(llm: LLM, transcript: string, signal: AbortSignal, model?: string, ctx: { known?: BrainEntry[]; began?: string } = {}): Promise<{ lessons: Lesson[]; stale: { key: string; why: string }[] }> {
  const known = (ctx.known ?? []).filter((e) => !e.retired).slice(0, 30);
  const head = [
    ctx.began ? `How this run began:\n${ctx.began}` : "",
    known.length ? `The project memory already holds (key: lesson):\n${known.map((e) => `- ${e.key}: ${e.text}`).join("\n")}` : "",
  ].filter(Boolean);
  const content = head.length ? `${head.join("\n\n")}\n\nThe run:\n${transcript}` : transcript;
  const done = await llm.complete({ system: SYSTEM, messages: [{ role: "user", content }], tools: [], signal, reasoningEffort: "low", ...(model ? { model } : {}) });
  return { lessons: parseLessons(done.text), stale: parseStale(done.text) };
}

export const clipText = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);

/**
 * Whether the run on `lane` after `since` (the end of the run before it) began with a correction, and what it said, for the
 * model to read the run as the fix of a mistake: a check Friday ran that failed, work a person or a reviewer sent back, a
 * workflow's check or OK that didn't pass, or a person's own next message after the last run finished (which may only be the
 * next ask: the model tells). Empty when it began with none of these.
 */
export function correctionOf(events: SessionEvent[], lane: string, since: number): string {
  const on = (e: SessionEvent) => (e.lane ?? MAIN_LANE) === lane;
  const start = events.find((e) => e.seq > since && on(e) && e.body.type === "run.started");
  const opening = events.filter((e) => e.seq > since && (!start || e.seq < start.seq) && on(e) && e.body.type === "instruction");
  for (const e of opening) {
    if (e.body.type !== "instruction") continue;
    const b = e.body;
    if (b.check) return `A check failed: Friday ran \`${b.check}\` after the agent's last change, and it failed.\n${clipText(b.text, 1200)}`;
    if (!b.mesh) continue;
    if (/^Friday ran `[^`]+` in your folder after you finished/.test(b.text)) return `A check failed:\n${clipText(b.text, 1200)}`;
    if (/ sent "[^"]+" back to you:\n/.test(b.text) || /checked your work on "[^"]+" and found:\n/.test(b.text)) return `The work was sent back:\n${clipText(b.text, 1200)}`;
    if (/^This is try \d+ of \d+\. (You were sent back|The check)/.test(b.text)) return `A workflow sent the work back:\n${clipText(b.text.split("\n\nWhat it came to last time:")[0]!, 1200)}`;
  }
  const said = opening.find((e) => e.actor.kind === "human" && e.body.type === "instruction" && !e.body.handoff && !e.body.peer && !e.body.mesh && !e.body.approval && !e.body.keepGoing);
  const ended = events.find((e) => e.seq === since);
  if (!said || said.body.type !== "instruction" || !ended || ended.body.type !== "run.ended" || ended.body.outcome !== "done") return "";
  const before = events.findLast((e) => e.seq < since && on(e) && e.body.type === "agent.message" && e.body.text.trim());
  const last = before?.body.type === "agent.message" ? `The agent had ended its previous run saying: "${clipText(before.body.text.trim(), 600)}"\n` : "";
  return `${last}Then ${said.actor.name} wrote: "${clipText(said.body.text.trim(), 800)}"\nIf that says the previous run got something wrong, this run is its correction; if it is only the next ask, it is no correction.`;
}

/** A correction learned: the same mistake again counts up (and is current again if it was retired); a command to catch it is kept. */
export function corrected(before: BrainEntry | undefined, entry: BrainEntry, check: string | undefined, now: number): BrainEntry {
  const again = before?.kind === "correction";
  const next: BrainEntry = { ...entry, seen: again ? (before!.seen ?? 1) + 1 : 1, seenAt: now, usesAtSeen: entry.uses };
  delete next.retired;
  if (check && (!next.check || next.check.state === "suggested")) next.check = { command: check, state: "suggested", at: now };
  return next;
}

/** Whether a correction just made again should be offered as a check: back CHECK_AFTER times, agents told since the last, a command named, not asked yet. */
export function offersCheck(before: BrainEntry | undefined, after: BrainEntry): boolean {
  return after.kind === "correction" && before?.kind === "correction" && (after.seen ?? 0) >= CHECK_AFTER && before.uses > (before.usesAtSeen ?? 0) && after.check?.state === "suggested";
}

// ── where it is kept ─────────────────────────────────────────────────

/** One workspace's brains, a hash of entries per repo, and the repos it knows. */
export class BrainRegistry {
  constructor(
    private redis: Redis,
    private prefix: string,
  ) {}

  private entriesKey = (repo: string) => `${this.prefix}brain:${repo}`;
  private get reposKey() {
    return `${this.prefix}brain-repos`;
  }

  /** Learning from runs is on unless the workspace turned it off. */
  async enabled(): Promise<boolean> {
    return (await this.redis.get(`${this.prefix}brain-off`)) !== "1";
  }
  async setEnabled(on: boolean): Promise<void> {
    if (on) await this.redis.del(`${this.prefix}brain-off`);
    else await this.redis.set(`${this.prefix}brain-off`, "1");
  }

  async repos(): Promise<BrainRepo[]> {
    const all = await this.redis.hgetall(this.reposKey);
    const out: BrainRepo[] = [];
    for (const [key, raw] of Object.entries(all)) {
      try {
        const r = JSON.parse(raw) as { name: string; at: number; sids?: string[] };
        // What agents can still be told: a retired lesson isn't counted, but a repo with only retired ones stays, to bring them back.
        const all = await this.list(key);
        if (all.length) out.push({ key, name: r.name, at: r.at, sessions: r.sids?.length ?? 0, count: all.filter((e) => !e.retired).length });
      } catch {
        /* a damaged record is left out */
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }

  async list(repo: string): Promise<BrainEntry[]> {
    const all = await this.redis.hgetall(this.entriesKey(repo));
    return Object.values(all)
      .flatMap((raw) => {
        try {
          return [JSON.parse(raw) as BrainEntry];
        } catch {
          return [];
        }
      })
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.at - a.at);
  }

  private async touchRepo(repo: string, name: string, sid?: string) {
    const raw = await this.redis.hget(this.reposKey, repo);
    const had = raw ? (JSON.parse(raw) as { name: string; at: number; sids?: string[] }) : { name, at: 0, sids: [] };
    const sids = sid ? [sid, ...(had.sids ?? []).filter((s) => s !== sid)].slice(0, 200) : (had.sids ?? []);
    await this.redis.hset(this.reposKey, repo, JSON.stringify({ name: had.name || name, at: Date.now(), sids }));
  }

  /**
   * What a run taught: the same key, or the same words, is the one entry kept current rather than a second one. A correction
   * made again counts up; once it is back CHECK_AFTER times, the last after agents had been told about it, and the model named a
   * command that would catch it, the check is offered (into `offered`, for the session it came back in to ask).
   */
  async learn(repo: string, name: string, lessons: Lesson[], from: BrainEntry["from"], offered?: BrainEntry[]): Promise<BrainEntry[]> {
    // A run that read a .env or a token can teach one in passing: such a lesson is dropped, never kept.
    lessons = lessons.filter((l) => !holdsSecret(l.text) && !(l.check && holdsSecret(l.check)));
    if (!lessons.length) return [];
    const have = await this.list(repo);
    const saved: BrainEntry[] = [];
    const now = Date.now();
    for (const l of lessons) {
      const same = have.find((e) => e.key === l.key || e.text.toLowerCase() === l.text.toLowerCase());
      let entry: BrainEntry = same ? { ...same, text: l.text, kind: l.kind, from, at: now } : { id: randomBytes(5).toString("hex"), key: l.key, text: l.text, kind: l.kind, from, at: now, uses: 0 };
      if (l.kind === "correction") entry = corrected(same, entry, l.check, now);
      if (offered && offersCheck(same, entry)) {
        entry = { ...entry, check: { ...entry.check!, state: "proposed", at: now, ...(from.sid ? { sid: from.sid } : {}) } };
        offered.push(entry);
      }
      await this.redis.hset(this.entriesKey(repo), entry.id, JSON.stringify(entry));
      saved.push(entry);
    }
    await this.touchRepo(repo, name, from.sid);
    await this.sweep(repo);
    await this.trim(repo);
    return saved;
  }

  /** A run found these out of date: out of the briefings, saying why. A pinned one is the person's to judge, so it stays. */
  async retire(repo: string, stale: { key: string; why: string }[]): Promise<BrainEntry[]> {
    if (!stale.length) return [];
    const have = await this.list(repo);
    const out: BrainEntry[] = [];
    for (const s of stale) {
      const e = have.find((x) => x.key === s.key && !x.pinned && !x.retired);
      if (!e) continue;
      const next = { ...e, retired: { at: Date.now(), why: s.why } };
      await this.redis.hset(this.entriesKey(repo), e.id, JSON.stringify(next));
      out.push(next);
    }
    return out;
  }

  /**
   * The harness kept small: a lesson no briefing has picked, no run added to and no mistake brought back in RETIRE_DAYS is
   * retired (pinned ones, and corrections a check now holds, stay), and one retired PURGE_DAYS ago is gone.
   */
  async sweep(repo: string, now = Date.now()): Promise<void> {
    for (const e of await this.list(repo)) {
      if (e.retired) {
        if (now - e.retired.at > PURGE_DAYS * DAY) await this.redis.hdel(this.entriesKey(repo), e.id);
        continue;
      }
      if (e.pinned || e.check?.state === "added") continue;
      if (now - Math.max(e.at, e.briefedAt ?? 0, e.seenAt ?? 0) <= RETIRE_DAYS * DAY) continue;
      await this.redis.hset(this.entriesKey(repo), e.id, JSON.stringify({ ...e, retired: { at: now, why: `No agent needed it in ${RETIRE_DAYS} days` } }));
    }
  }

  /** The person's answer to an offered check: added, Friday runs it after agents change files here; or not wanted. */
  async answerCheck(repo: string, id: string, take: boolean, by: string): Promise<BrainEntry> {
    const raw = await this.redis.hget(this.entriesKey(repo), id);
    if (!raw) throw new Error("That's no longer in project memory.");
    const e = JSON.parse(raw) as BrainEntry;
    if (!e.check) throw new Error("There's no check for that one.");
    const next: BrainEntry = { ...e, check: { ...e.check, state: take ? "added" : "declined", at: Date.now(), by } };
    await this.redis.hset(this.entriesKey(repo), id, JSON.stringify(next));
    return next;
  }

  /** The checks people added for this repo that are commands to run, with the mistake each catches. */
  async checks(repo: string): Promise<{ id: string; command: string; why: string }[]> {
    return (await this.list(repo)).flatMap((e) => (e.check?.state === "added" && (!e.check.how || e.check.how === "command") ? [{ id: e.id, command: e.check.command, why: e.text }] : []));
  }

  /** The rules kept for this repo that are read off a change (rules.ts): what each says, and how it is checked. */
  async rules(repo: string): Promise<{ id: string; rule: string; check: RuleCheck }[]> {
    return (await this.list(repo)).flatMap((e) => {
      const c = e.check;
      if (c?.state !== "added" || !c.how || c.how === "command" || !c.pattern) return [];
      return [{ id: e.id, rule: e.text, check: { how: c.how, pattern: c.pattern, ...(c.only?.length ? { only: c.only } : {}), ...(c.except?.length ? { except: c.except } : {}) } }];
    });
  }

  /**
   * A rule drafted from a person's correction (rules.ts draftRule), offered in the session where they said it: kept as a
   * correction whose check is proposed until they keep it. Null when the repo already has it, kept or still being asked about.
   */
  async offerRule(repo: string, name: string, p: { text: string; check: RuleCheck }, from: BrainEntry["from"], where: { sid: string; lane: string }): Promise<BrainEntry | null> {
    if (holdsSecret(p.text) || holdsSecret(p.check.pattern)) return null;
    const have = await this.list(repo);
    if (have.some((e) => e.check?.how === p.check.how && e.check.pattern === p.check.pattern && e.check.state !== "declined")) return null;
    const now = Date.now();
    const key = slug(p.text) || randomBytes(4).toString("hex");
    const same = have.find((e) => e.key === key);
    const entry: BrainEntry = {
      ...(same ?? { id: randomBytes(5).toString("hex"), key, uses: 0 }),
      text: p.text.trim().slice(0, MAX_TEXT),
      kind: "correction",
      from,
      at: now,
      seen: (same?.seen ?? 0) + 1,
      seenAt: now,
      check: { command: ruleWords(p.check), state: "proposed", at: now, sid: where.sid, lane: where.lane, ...p.check },
    };
    delete entry.retired;
    await this.redis.hset(this.entriesKey(repo), entry.id, JSON.stringify(entry));
    await this.touchRepo(repo, name, where.sid);
    await this.trim(repo);
    return entry;
  }

  /**
   * A rule written or changed by a person, from the project memory page or the offer's Edit: kept at once (a person wrote it).
   * `id` changes that entry; without one it is a new rule.
   */
  async putRule(repo: string, name: string, p: { id?: string; text: string; check: RuleCheck }, by: { id: string; name: string }): Promise<BrainEntry> {
    const text = p.text.trim().slice(0, MAX_TEXT);
    if (text.length < 3) throw new Error("Say what the rule is.");
    if (holdsSecret(text) || holdsSecret(p.check.pattern)) throw new Error(SECRET_REFUSED);
    if (p.check.how !== "paths" && !ruleRegexOk(p.check.pattern)) throw new Error("That pattern isn't a regular expression Friday can read.");
    if (p.check.how === "paths" && !p.check.pattern.trim()) throw new Error("Name the files or folders.");
    const now = Date.now();
    const had = p.id ? await this.redis.hget(this.entriesKey(repo), p.id) : null;
    if (p.id && !had) throw new Error("That's no longer in project memory.");
    const before = had ? (JSON.parse(had) as BrainEntry) : null;
    const check: BrainCheck = { ...(before?.check ?? {}), command: ruleWords(p.check), state: "added", at: now, by: by.name, how: p.check.how, pattern: p.check.pattern };
    if (p.check.only?.length) check.only = p.check.only;
    else delete check.only;
    if (p.check.except?.length) check.except = p.check.except;
    else delete check.except;
    const entry: BrainEntry = { ...(before ?? { id: randomBytes(5).toString("hex"), key: slug(text) || randomBytes(4).toString("hex"), uses: 0, from: { tool: "person", name: by.name }, at: now }), text, kind: "correction", check };
    delete entry.retired;
    await this.redis.hset(this.entriesKey(repo), entry.id, JSON.stringify(entry));
    await this.touchRepo(repo, name);
    return entry;
  }

  /** A check ran after a change: counted, and counted as caught when it failed, so the page shows whether it earns its place. */
  async checkRan(repo: string, id: string, failed: boolean): Promise<void> {
    const raw = await this.redis.hget(this.entriesKey(repo), id);
    if (!raw) return;
    const e = JSON.parse(raw) as BrainEntry;
    if (!e.check) return;
    await this.redis.hset(this.entriesKey(repo), id, JSON.stringify({ ...e, check: { ...e.check, runs: (e.check.runs ?? 0) + 1, caught: (e.check.caught ?? 0) + (failed ? 1 : 0) } }));
  }

  /** Written by a person, from the brain's page. */
  async add(repo: string, name: string, p: { text: string; kind?: BrainKind }, by: { id: string; name: string }): Promise<BrainEntry> {
    const text = p.text.trim().slice(0, MAX_TEXT);
    if (text.length < 3) throw new Error("Write what the team should know.");
    if (holdsSecret(text)) throw new Error(SECRET_REFUSED);
    const [entry] = await this.learn(repo, name, [{ key: text.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40), kind: p.kind ?? "fact", text }], { tool: "person", name: by.name });
    return entry!;
  }

  async update(repo: string, id: string, patch: { text?: string; kind?: BrainKind; pinned?: boolean; /** Back into the briefings. */ restore?: boolean }): Promise<BrainEntry> {
    const raw = await this.redis.hget(this.entriesKey(repo), id);
    if (!raw) throw new Error("That's no longer in Agent Memory.");
    const e = JSON.parse(raw) as BrainEntry;
    if (patch.text && holdsSecret(patch.text)) throw new Error(SECRET_REFUSED);
    const next: BrainEntry = {
      ...e,
      ...(patch.text?.trim() ? { text: patch.text.trim().slice(0, MAX_TEXT) } : {}),
      ...(patch.kind && BRAIN_KINDS.includes(patch.kind) ? { kind: patch.kind } : {}),
      ...(typeof patch.pinned === "boolean" ? { pinned: patch.pinned } : {}),
    };
    // Put right or brought back by a person: in the briefings again, and its 60 days start over.
    if (patch.restore || patch.text?.trim()) {
      delete next.retired;
      next.at = Date.now();
    }
    await this.redis.hset(this.entriesKey(repo), id, JSON.stringify(next));
    return next;
  }

  async remove(repo: string, id: string): Promise<void> {
    await this.redis.hdel(this.entriesKey(repo), id);
  }

  /** The retired, then the oldest, least used, unpinned go first once a repo holds more than it can usefully brief from. */
  private async trim(repo: string) {
    const all = await this.list(repo);
    if (all.length <= MAX_PER_REPO) return;
    const drop = all.filter((e) => !e.pinned).sort((a, b) => Number(!!b.retired) - Number(!!a.retired) || a.uses - b.uses || a.at - b.at).slice(0, all.length - MAX_PER_REPO);
    if (drop.length) await this.redis.hdel(this.entriesKey(repo), ...drop.map((e) => e.id));
  }

  /** A briefing for an agent starting on `task` here, counting each entry it used. Null when there is nothing yet. */
  async brief(repo: string, task: string): Promise<Brief | null> {
    const all = await this.list(repo);
    if (!all.length) return null;
    const chosen = pickBrief(all, task);
    if (!chosen.length) return null;
    const raw = await this.redis.hget(this.reposKey, repo);
    const meta = raw ? (JSON.parse(raw) as { name: string; sids?: string[] }) : { name: repo, sids: [] };
    const sessions = new Set(chosen.map((e) => e.from.sid).filter(Boolean)).size || meta.sids?.length || 0;
    const now = Date.now();
    await Promise.all(chosen.map((e) => this.redis.hset(this.entriesKey(repo), e.id, JSON.stringify({ ...e, uses: e.uses + 1, briefedAt: now }))));
    return { text: briefText(meta.name, chosen, Math.max(sessions, meta.sids?.length ?? 0)), count: chosen.length, sessions: Math.max(sessions, meta.sids?.length ?? 0), tools: [...new Set(chosen.map((e) => e.from.tool).filter((t) => t !== "person"))] };
  }
}
