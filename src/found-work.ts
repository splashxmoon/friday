/**
 * Work found for you (Arun, 2026-11-21: "1. Speed baseline, Today with Tonight, and proof clips.", spec 10 A; the 11-19 mock 2, "Work
 * found for you"). Friday waited to be handed work; now it looks through the repos you've been working in and finds the small things worth
 * an agent's time: an issue assigned to you, CI on the main branch that is broken or fails now and then, a package with a known
 * vulnerability that has a safe fix, and a TODO you wrote weeks ago. Each is one row on Today with Start now or Tonight.
 *
 * The runner reads (runner/found-work.ts: gh, npm audit, git); what it read is turned into rows here, pure, so the tests and the page read
 * a finding the same way. Each row carries the words its agent is given: what it is, where to look, how to know it's done, and what not to
 * touch. Nothing found is said in one line; nothing is padded.
 */
import type { IssueRef } from "./types.js";

export type FoundKind = "broken" | "advisory" | "issue" | "flaky" | "todo";
export type FoundSize = "XS" | "S" | "M";

export interface FoundItem {
  /** Stable across looks, so a row dismissed or queued stays recognised: kind, repo and what it is about. */
  id: string;
  kind: FoundKind;
  /** owner/name when it has one on GitHub, else the folder's name. */
  repo: string;
  /** The folder on this computer it runs in. */
  folder: string;
  title: string;
  /** One line on why it's worth doing now. */
  why: string;
  size: FoundSize;
  /** About how long an agent takes, for Tonight's sum. */
  minutes: number;
  /** The words its agent is given. */
  ask: string;
  url?: string;
  issue?: IssueRef;
}

export const SIZE_MINUTES: Record<FoundSize, number> = { XS: 10, S: 20, M: 45 };
/** The order rows are shown in: what is broken for everybody first, the nice-to-haves last. */
const ORDER: Record<FoundKind, number> = { broken: 0, advisory: 1, issue: 2, flaky: 3, todo: 4 };
/** Today shows this many at most; the rest wait for the next look. */
export const FOUND_MAX = 8;

const one = (s: string, max = 140) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
const shortHash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
};
const item = (o: Omit<FoundItem, "id" | "minutes">, about: string): FoundItem => ({ ...o, id: `${o.kind}-${shortHash(`${o.repo}|${about}`)}`, minutes: SIZE_MINUTES[o.size] });

// ── CI on the main branch ─────────────────────────────────────────────────────────────────────────────────

export interface CiRun {
  workflowName: string;
  conclusion: string;
  /** ISO time. */
  createdAt?: string;
  url?: string;
}

/**
 * CI on the default branch, newest run first (`gh run list --branch <main> --json workflowName,conclusion,createdAt,url`): a workflow
 * whose last three finished runs all failed is broken; one that failed some of its last twenty but not lately in a row is flaky. Runs
 * cancelled or skipped say nothing either way and are left out.
 */
export function ciFindings(runs: CiRun[], o: { repo: string; folder: string; branch: string }): FoundItem[] {
  const by = new Map<string, CiRun[]>();
  for (const r of runs) {
    if (r.conclusion !== "success" && r.conclusion !== "failure") continue;
    const list = by.get(r.workflowName) ?? [];
    if (list.length < 20) list.push(r);
    by.set(r.workflowName, list);
  }
  const out: FoundItem[] = [];
  for (const [name, list] of by) {
    const failed = list.filter((r) => r.conclusion === "failure").length;
    if (!failed) continue;
    const broken = list.length >= 3 && list.slice(0, 3).every((r) => r.conclusion === "failure");
    if (broken) {
      out.push(
        item(
          {
            kind: "broken",
            repo: o.repo,
            folder: o.folder,
            title: `${name} is failing on ${o.branch}`,
            why: `Its last ${list.findIndex((r) => r.conclusion === "success") === -1 ? list.length : list.findIndex((r) => r.conclusion === "success")} runs on ${o.branch} failed`,
            size: "S",
            ask: `CI's "${name}" workflow has been failing on ${o.branch} in ${o.repo}${list[0]?.url ? ` (latest run: ${list[0].url})` : ""}. Read the failing run's log with gh (gh run view --log-failed), find the cause, fix it on a new branch, run the same checks here until they pass, and open a pull request. If the failure is outside the code (a secret, a runner, a service down), don't change code: say what is wrong and who can fix it.`,
            ...(list[0]?.url ? { url: list[0].url } : {}),
          },
          `broken ${name}`,
        ),
      );
      continue;
    }
    // Two failures in twenty is the least that isn't a one-off; more than half is broken more than flaky, and said as broken above
    // only once three in a row fail.
    if (failed >= 2 && list.length >= 6)
      out.push(
        item(
          {
            kind: "flaky",
            repo: o.repo,
            folder: o.folder,
            title: `${name} fails now and then on ${o.branch}`,
            why: `Failed ${failed} of its last ${list.length} runs`,
            size: "S",
            ask: `CI's "${name}" workflow in ${o.repo} failed ${failed} of its last ${list.length} runs on ${o.branch} without a change that explains it: something in it is flaky. Read the failed runs' logs with gh (gh run list --workflow "${name}" --branch ${o.branch}, then gh run view <id> --log-failed), find which test or step fails and why it only fails sometimes (timing, order, shared state, the network), fix the cause rather than adding retries, run it here several times to show it holds, and open a pull request saying what was flaky and why.`,
            ...(list.find((r) => r.conclusion === "failure")?.url ? { url: list.find((r) => r.conclusion === "failure")!.url } : {}),
          },
          `flaky ${name}`,
        ),
      );
  }
  return out;
}

// ── Known vulnerabilities (npm audit) ────────────────────────────────────────────────────────────────────

type AuditVuln = { severity?: string; via?: unknown[]; fixAvailable?: boolean | { isSemVerMajor?: boolean } };

/**
 * `npm audit --json` (npm 7 and later): the packages with a known high or critical vulnerability that npm can fix without a major
 * version bump, as one row per repo. A fix that needs a major version is a change somebody should choose, not a nightly chore, so
 * it is left out (and said, when it is all there is).
 */
export function auditFindings(json: unknown, o: { repo: string; folder: string }): FoundItem[] {
  const vulns = ((json as { vulnerabilities?: Record<string, AuditVuln> } | null)?.vulnerabilities ?? {}) as Record<string, AuditVuln>;
  const serious = Object.entries(vulns).filter(([, v]) => v.severity === "high" || v.severity === "critical");
  const fixable = serious.filter(([, v]) => v.fixAvailable === true || (typeof v.fixAvailable === "object" && v.fixAvailable && !v.fixAvailable.isSemVerMajor));
  if (!fixable.length) return [];
  const critical = fixable.filter(([, v]) => v.severity === "critical").length;
  const names = fixable.map(([n]) => n);
  const advisory = fixable
    .flatMap(([, v]) => (v.via ?? []).filter((x): x is { title?: string; url?: string } => typeof x === "object" && !!x))
    .find((x) => x.url);
  return [
    item(
      {
        kind: "advisory",
        repo: o.repo,
        folder: o.folder,
        title: names.length === 1 ? `${names[0]} has a known vulnerability` : `${names.length} packages have known vulnerabilities`,
        why: `${[critical ? `${critical} critical` : "", fixable.length - critical ? `${fixable.length - critical} high` : ""].filter(Boolean).join(", ")}. A safe update fixes ${names.length === 1 ? "it" : "them"}`,
        size: "XS",
        ask: `npm audit in ${o.repo} reports high or critical vulnerabilities with a fix that needs no major version: ${names.slice(0, 12).join(", ")}${names.length > 12 ? ", …" : ""}. On a new branch, update them with npm audit fix (never --force, and nothing that bumps a major version), check the lockfile changed only as expected, run the build and the tests, and open a pull request listing each advisory it fixes. If anything breaks, stop and say what.`,
        ...(advisory?.url ? { url: advisory.url } : {}),
      },
      `audit ${names.sort().join(",")}`,
    ),
  ];
}

// ── Issues assigned to you ───────────────────────────────────────────────────────────────────────────────

export interface FoundIssue {
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  updatedAt?: string;
}

/** A bug with a short body is a small fix; anything else is worth a plan first. */
export function issueSize(i: Pick<FoundIssue, "body" | "labels">): FoundSize {
  const bug = i.labels.some((l) => /bug|fix|defect|regression/i.test(l));
  return bug && i.body.length < 1500 ? "S" : "M";
}

export function issueFinding(i: FoundIssue, folder: string): FoundItem {
  const size = issueSize(i);
  return item(
    {
      kind: "issue",
      repo: i.repo,
      folder,
      title: one(i.title, 110),
      why: `Issue #${i.number}, assigned to you${i.labels.length ? ` · ${i.labels.slice(0, 2).join(", ")}` : ""}`,
      size,
      ask:
        size === "S"
          ? `Fix GitHub issue ${i.url}: "${one(i.title, 200)}". Read the issue and its comments with gh, reproduce it, fix it on a new branch with a test that fails before the fix, run the tests, and open a pull request that closes it. If it can't be reproduced or needs a decision, stop and ask.`
          : `Work on GitHub issue ${i.url}: "${one(i.title, 200)}". Read the issue and its comments with gh and the code it touches, then write a short plan (what changes, where, and how you'll check it) before changing anything. Keep public APIs as they are unless the issue asks otherwise. Then build it on a new branch with tests, and open a pull request that closes the issue.`,
      url: i.url,
      issue: { repo: i.repo, number: i.number, url: i.url, title: one(i.title, 200) },
    },
    `issue ${i.number}`,
  );
}

// ── TODOs you left ─────────────────────────────────────────────────────────────────────────────────────

export interface BlamedTodo {
  file: string;
  line: number;
  text: string;
  /** Seconds since 1970, from git blame. */
  authorTime: number;
  authorMail: string;
}

/** A TODO or FIXME you wrote at least this long ago: newer ones are still yours to get to. */
export const TODO_AGE_MS = 14 * 24 * 3600_000;

/** TODOs this person wrote two weeks ago or more, oldest first, two per repo at most. */
export function todoFindings(todos: BlamedTodo[], o: { repo: string; folder: string; me: string; now?: number }): FoundItem[] {
  const now = o.now ?? Date.now();
  const me = o.me.trim().toLowerCase().replace(/^<|>$/g, "");
  if (!me) return [];
  return todos
    .filter((t) => t.authorMail.trim().toLowerCase().replace(/^<|>$/g, "") === me && now - t.authorTime * 1000 >= TODO_AGE_MS)
    .sort((a, b) => a.authorTime - b.authorTime)
    .slice(0, 2)
    .map((t) => {
      const what = one(t.text.replace(/^.*?\b(?:TODO|FIXME)\b(?:\([^)]*\))?[:\s-]*/i, "").replace(/\s*(\*\/|-->)\s*$/, ""), 100) || "a TODO";
      const weeks = Math.floor((now - t.authorTime * 1000) / (7 * 24 * 3600_000));
      return item(
        {
          kind: "todo",
          repo: o.repo,
          folder: o.folder,
          title: `TODO: ${what}`,
          why: `${t.file}:${t.line} · you left it ${weeks} week${weeks === 1 ? "" : "s"} ago`,
          size: "S",
          ask: `In ${o.repo}, ${t.file}:${t.line} has a TODO you left ${weeks} weeks ago: "${one(t.text, 300)}". Read the code around it and decide what it needs. If it is small and clear, do it on a new branch with a test, remove the TODO, run the tests and open a pull request. If it needs a decision (an API change, a product choice), don't change code: write a short plan with the choices and ask.`,
        },
        `todo ${t.file} ${one(t.text, 80)}`,
      );
    });
}

/** Lines of `git blame --line-porcelain -L n,n file`: the author's mail and time. */
export function readBlame(porcelain: string): { authorMail: string; authorTime: number } | null {
  const mail = porcelain.match(/^author-mail (.+)$/m)?.[1];
  const time = Number(porcelain.match(/^author-time (\d+)$/m)?.[1]);
  return mail && Number.isFinite(time) ? { authorMail: mail, authorTime: time } : null;
}

/** Lines of `git grep -n -I -E <pattern>`: file, line and text. A path with a colon in it is read up to the line number. */
export function readGrep(out: string, max = 200): { file: string; line: number; text: string }[] {
  const hits: { file: string; line: number; text: string }[] = [];
  for (const l of out.split(/\r?\n/)) {
    const m = l.match(/^(.+?):(\d+):(.*)$/);
    if (m && hits.length < max) hits.push({ file: m[1]!, line: Number(m[2]), text: m[3]!.trim() });
  }
  return hits;
}

// ── All of it ───────────────────────────────────────────────────────────────────────────────────────────

/** What every repo turned up, in the order to show it, each once, at most FOUND_MAX; rows already queued or dismissed left out. */
export function rankFound(all: FoundItem[], skip: ReadonlySet<string> = new Set()): FoundItem[] {
  const seen = new Set<string>();
  return all
    .filter((f) => !skip.has(f.id) && !seen.has(f.id) && seen.add(f.id))
    .sort((a, b) => ORDER[a.kind] - ORDER[b.kind])
    .slice(0, FOUND_MAX);
}

/** "About 1h 5m", for Tonight's line. */
export function aboutMinutes(m: number): string {
  if (m < 60) return `about ${Math.max(5, Math.round(m / 5) * 5)}m`;
  const h = Math.floor(m / 60);
  const r = Math.round((m - h * 60) / 5) * 5;
  return `about ${h}h${r ? ` ${r}m` : ""}`;
}
