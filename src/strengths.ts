import type { Redis } from "ioredis";

/**
 * What each coding tool is good at here, learned from how its board tasks went (Arun, 2026-10-25: "smarter routing by
 * strength": a task to the agent best at that kind of work, not only whichever is free).
 *
 * A task is read for its kind from its title and brief. When it settles, its tool's record for that kind gets a grade: through
 * review the first time 1, after being sent back 0.6, stuck 0. Kept per workspace, as routing's model outcomes are
 * (route-learning.ts). A tool with no record for a kind stands at PRIOR, and a few outcomes only nudge it, so one lucky task
 * doesn't decide where the next ten go.
 */

export type TaskKind = "tests" | "docs" | "devops" | "data" | "ui" | "api" | "refactor" | "bugfix";

/** In order: the first that matches is the kind. "Fix the tests" is test work before it is a fix. */
const KINDS: [TaskKind, RegExp][] = [
  ["tests", /\b(tests?|specs?|coverage|e2e|playwright|jest|vitest|pytest)\b/i],
  ["docs", /\b(docs?|readme|documentation|changelog|guide)\b/i],
  ["devops", /\b(ci|cd|deploy(s|ment)?|docker(file)?|pipelines?|workflows?|kubernetes|terraform|release)\b/i],
  ["data", /\b(schema|migrations?|database|sql|postgres|sqlite|queries|query|indexes)\b/i],
  ["ui", /\b(ui|ux|css|styles?|layout|components?|pages?|screens?|buttons?|frontend|react|dark mode|design)\b/i],
  ["api", /\b(api|endpoints?|routes?|server|backend|handlers?|graphql|rest|webhooks?)\b/i],
  ["refactor", /\b(refactor(ing)?|clean ?up|restructure|extract|split up)\b/i],
  ["bugfix", /\b(fix(es)?|bugs?|crash(es)?|errors?|broken|regressions?)\b/i],
];

export const KIND_WORDS: Record<TaskKind, string> = { tests: "tests", docs: "docs", devops: "CI and deploys", data: "database work", ui: "UI work", api: "API and server work", refactor: "refactors", bugfix: "bug fixes" };

export function taskKind(text: string): TaskKind | null {
  return KINDS.find(([, re]) => re.test(text))?.[0] ?? null;
}

/** Outcomes by `${tool}|${kind}`: tasks, and their grades added up. */
export type Skills = Record<string, { n: number; ok: number }>;

/** Where a tool stands on a kind it has no record for, and how many tasks that is worth. */
const PRIOR = 0.7;
const PRIOR_TASKS = 3;

export function skillOf(skills: Skills, tool: string, kind: TaskKind): number {
  const s = skills[`${tool}|${kind}`];
  return (PRIOR_TASKS * PRIOR + (s?.ok ?? 0)) / (PRIOR_TASKS + (s?.n ?? 0));
}

/** What a tool has shown it is good at, best first: three tasks of a kind at least, most of them through first time. */
export function strongAt(skills: Skills, tool: string): { kind: TaskKind; n: number; firstTime: number }[] {
  return (Object.keys(KIND_WORDS) as TaskKind[])
    .flatMap((kind) => {
      const s = skills[`${tool}|${kind}`];
      return s && s.n >= 3 && s.ok / s.n >= 0.8 ? [{ kind, n: s.n, firstTime: Math.round(s.ok), score: skillOf(skills, tool, kind) }] : [];
    })
    .sort((a, b) => b.score - a.score)
    .map(({ kind, n, firstTime }) => ({ kind, n, firstTime }));
}

export class Strengths {
  constructor(
    private redis: Redis,
    private prefix: string,
  ) {}

  private key(workspaceId: string): string {
    return `${this.prefix}strengths:${workspaceId}`;
  }

  /** One task's grade for its tool and kind, once per `once` (a session and task), however often the task is settled again. */
  async learn(workspaceId: string, tool: string, kind: TaskKind, grade: number, once: string): Promise<void> {
    if (!(await this.redis.set(`${this.key(workspaceId)}:once:${once}`, "1", "EX", 30 * 86_400, "NX"))) return;
    await this.redis.hincrbyfloat(this.key(workspaceId), `${tool}|${kind}|n`, 1);
    await this.redis.hincrbyfloat(this.key(workspaceId), `${tool}|${kind}|ok`, Math.max(0, Math.min(1, grade)));
  }

  async get(workspaceId: string): Promise<Skills> {
    const h = await this.redis.hgetall(this.key(workspaceId)).catch(() => ({}) as Record<string, string>);
    const out: Skills = {};
    for (const [field, v] of Object.entries(h)) {
      const at = field.lastIndexOf("|");
      const which = field.slice(at + 1);
      if (which !== "n" && which !== "ok") continue;
      (out[field.slice(0, at)] ??= { n: 0, ok: 0 })[which] = Number(v) || 0;
    }
    return out;
  }
}
