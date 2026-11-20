import type { Redis } from "ioredis";

/**
 * Pull request autopilot (Arun, 2026-11-19: "I want this to be like Devin… people are addicted to this software", the first of
 * four, mocked and then "Yes, build #1").
 *
 * Friday looks at the person's own open pull requests now and then and, when one needs work (a check gone red, a reviewer's
 * comment, a conflict with its base), starts a session on its branch, in a separate copy of their clone, with Friday's shepherd
 * on (shepherd.ts): the agent fixes it, Friday commits and pushes, and keeps watching until it is merged or closed. Merging stays
 * the person's. Each pull request keeps a short log of what autopilot did, for Code Review's Yours tab.
 *
 * This is the decision and the record; app.ts runs the loop and starts the sessions.
 */

export interface AutopilotSettings {
  on: boolean;
  /** Fix failing checks. */
  checks: boolean;
  /** Change the code for reviewers' comments. */
  comments: boolean;
  /** Merge the base in and resolve conflicts. */
  conflicts: boolean;
  /**
   * Once a pull request it saw through merges or closes, its session's agent is stopped and the session leaves the sidebar (its
   * history stays, a press away in Code Review). Arun, 2026-11-20: "i think it should auto close its session or whatever when it
   * is done".
   */
  closeWhenDone: boolean;
  /** How many pull requests it works on at once. */
  max: number;
  /** Which coding tool does the work: one of this computer's, or "auto" for the one best placed for the task. */
  tool: string;
  /** Pull requests it leaves alone, by link: the person's "Leave this one alone". */
  skip: string[];
}

export const AUTOPILOT_DEFAULTS: AutopilotSettings = { on: false, checks: true, comments: true, conflicts: true, closeWhenDone: true, max: 3, tool: "auto", skip: [] };
/** The choices of how many at once. */
export const AUTOPILOT_MAX = [1, 2, 3, 5] as const;

/** A pull request as Code Review lists it (runner/workspace.ts PullRequest): what autopilot reads of it. */
export interface PilotPr {
  url: string;
  repo: string;
  number: number;
  title: string;
  branch: string;
  base: string;
  head: string;
  draft: boolean;
  checks: "passing" | "failing" | "pending" | "none";
  failing?: { name: string }[];
  unresolved: number;
  mergeable: boolean | null;
  canPush?: boolean;
}

export type PilotReason = "checks" | "comments" | "conflicts";

/** What a pull request needs from autopilot, by what the person lets it do; none for a draft or one they can't push to. */
export function reasonsFor(pr: PilotPr, s: AutopilotSettings): PilotReason[] {
  if (pr.draft || pr.canPush === false || (s.skip ?? []).includes(pr.url)) return [];
  const out: PilotReason[] = [];
  if (s.conflicts && pr.mergeable === false) out.push("conflicts");
  if (s.checks && pr.checks === "failing") out.push("checks");
  if (s.comments && pr.unresolved > 0) out.push("comments");
  return out;
}

/** What it needs, in words: "2 checks failing (lint, test) · a conflict with main". */
export function needsText(pr: PilotPr, reasons: PilotReason[]): string {
  const parts = reasons.map((r) => {
    if (r === "checks") {
      const names = (pr.failing ?? []).map((f) => f.name).slice(0, 3);
      const n = pr.failing?.length || 1;
      return `${n} check${n === 1 ? "" : "s"} failing${names.length ? ` (${names.join(", ")})` : ""}`;
    }
    if (r === "comments") return `${pr.unresolved} unresolved review comment${pr.unresolved === 1 ? "" : "s"}`;
    return `a conflict with ${pr.base || "its base branch"}`;
  });
  return parts.join(" · ");
}

export type PilotState = "working" | "watching" | "done" | "stopped";

export interface PilotEntry {
  at: number;
  kind: "started" | "restarted" | "checks" | "comments" | "conflicts" | "pushed" | "merged" | "closed" | "stopped" | "skipped" | "tidied";
  text: string;
  sha?: string;
}

/** A pull request autopilot has worked on: its session, where it stands, and what it did. */
export interface PilotPrRecord {
  url: string;
  repo: string;
  number: number;
  title: string;
  sid: string | null;
  state: PilotState;
  /** The commit the pull request was on when autopilot stopped: it tries again only once somebody pushes past it. */
  head: string;
  log: PilotEntry[];
  updated: number;
  /** Its session's link, as the server sends the record to the page (never kept). */
  invite?: string;
}

const LOG_MAX = 30;
const KEEP_DONE_MS = 14 * 24 * 3_600_000;

/** Where autopilot keeps its switch and its record of each pull request. */
export class AutopilotStore {
  constructor(
    private redis: Redis,
    private prefix: string,
  ) {}

  private key = () => `${this.prefix}autopilot`;
  private prsKey = () => `${this.prefix}autopilot:prs`;

  async settings(): Promise<AutopilotSettings> {
    const raw = await this.redis.get(this.key()).catch(() => null);
    try {
      return { ...AUTOPILOT_DEFAULTS, ...(raw ? (JSON.parse(raw) as Partial<AutopilotSettings>) : {}) };
    } catch {
      return { ...AUTOPILOT_DEFAULTS };
    }
  }

  async setSettings(patch: Partial<Record<keyof AutopilotSettings, unknown>>): Promise<AutopilotSettings> {
    const next: AutopilotSettings = { ...(await this.settings()) };
    for (const k of ["on", "checks", "comments", "conflicts", "closeWhenDone"] as const) if (typeof patch[k] === "boolean") next[k] = patch[k] as boolean;
    if (typeof patch.max === "number" && (AUTOPILOT_MAX as readonly number[]).includes(patch.max)) next.max = patch.max;
    if (typeof patch.tool === "string" && /^[a-z]{2,20}$/.test(patch.tool)) next.tool = patch.tool;
    if (Array.isArray(patch.skip)) next.skip = [...new Set(patch.skip.filter((u): u is string => typeof u === "string" && /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/.test(u)))].slice(-200);
    await this.redis.set(this.key(), JSON.stringify(next));
    return next;
  }

  async get(url: string): Promise<PilotPrRecord | null> {
    const raw = await this.redis.hget(this.prsKey(), url).catch(() => null);
    try {
      return raw ? (JSON.parse(raw) as PilotPrRecord) : null;
    } catch {
      return null;
    }
  }

  /** Every pull request it has a record of, the ones finished more than two weeks ago forgotten. */
  async all(now = Date.now()): Promise<PilotPrRecord[]> {
    const all = await this.redis.hgetall(this.prsKey()).catch(() => ({}) as Record<string, string>);
    const out: PilotPrRecord[] = [];
    for (const [url, raw] of Object.entries(all)) {
      try {
        const r = JSON.parse(raw) as PilotPrRecord;
        if ((r.state === "done" || r.state === "stopped") && now - r.updated > KEEP_DONE_MS) void this.redis.hdel(this.prsKey(), url).catch(() => {});
        else out.push(r);
      } catch {
        void this.redis.hdel(this.prsKey(), url).catch(() => {});
      }
    }
    return out.sort((a, b) => b.updated - a.updated);
  }

  async put(r: PilotPrRecord): Promise<void> {
    await this.redis.hset(this.prsKey(), r.url, JSON.stringify({ ...r, log: r.log.slice(-LOG_MAX) }));
  }

  /** A line in a pull request's log, and where it stands after it. */
  async note(url: string, entry: PilotEntry, state?: PilotState, head?: string): Promise<PilotPrRecord | null> {
    const r = await this.get(url);
    if (!r) return null;
    // A time it can draw: an event heard without one was logged with none, and Code Review's log couldn't be drawn (Arun, 2026-11-20).
    if (!Number.isFinite(entry.at)) entry = { ...entry, at: Date.now() };
    const next: PilotPrRecord = { ...r, log: [...r.log, entry].slice(-LOG_MAX), ...(state ? { state } : {}), ...(head !== undefined ? { head } : {}), updated: entry.at };
    await this.put(next);
    return next;
  }

  /**
   * Off the list (Arun, 2026-11-20: "remove it too... so it doesnt clog the page"): one finished record, or every one that is (stopped or
   * done). One it's working on or watching stays: Stop it first. Its next start begins a new record.
   */
  async forget(url: string | null): Promise<number> {
    const gone = (await this.all()).filter((r) => (url === null || r.url === url) && r.state !== "working" && r.state !== "watching");
    if (gone.length) await this.redis.hdel(this.prsKey(), ...gone.map((r) => r.url));
    return gone.length;
  }

  /** The record for the pull request a session is autopilot's for, if it is one. */
  async bySession(sid: string): Promise<PilotPrRecord | null> {
    return (await this.all()).find((r) => r.sid === sid) ?? null;
  }
}

/** Whether autopilot starts on a pull request now: it needs work, nothing of autopilot's is on it, and it isn't one it gave up on. */
export function shouldStart(pr: PilotPr, reasons: PilotReason[], rec: PilotPrRecord | null, live: boolean): boolean {
  if (!reasons.length) return false;
  if (rec && (rec.state === "working" || rec.state === "watching") && live) return false;
  // Stopped (a person is needed), or a branch with nothing of its own on this computer: not again until somebody pushes past it.
  if (rec && rec.state === "stopped" && rec.head && rec.head === pr.head) return false;
  return true;
}

/** The first message of an autopilot session: what it is for, before Friday's shepherd hands it each thing to fix. */
export function pilotBrief(pr: PilotPr, reasons: PilotReason[]): string {
  return [
    `Autopilot on pull request #${pr.number}, “${pr.title}” (${pr.url}), on its branch ${pr.branch}${pr.base ? ` into ${pr.base}` : ""}.`,
    `It needs: ${needsText(pr, reasons)}. Friday hands you each failing check, review comment or conflict as it comes, with what it says.`,
    "Fix each one properly on this branch, run the project's tests, and say in a sentence what you changed. Friday commits and pushes your changes; don't open a new pull request, and never merge.",
    "If something needs the person to decide (a reviewer asks a question only they can answer, or a fix would change what the pull request does), stop and ask instead of guessing.",
  ].join("\n\n");
}
