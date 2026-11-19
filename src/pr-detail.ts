/**
 * A pull request in full, for the side panel's Pull request (PrPanel.tsx; Arun, 2026-11-19: "a more better design of this, with
 * more details and info and stuff like how others do it"): what GitHub's own page has, its description, commits, files, every
 * check, its reviewers, labels and the issues it closes, read from the person's `gh` (runner git.ts prDetailJson) and cut down
 * here to what the panel draws. Nobody's email leaves this file: `gh` sends commit authors' addresses, which are dropped.
 */

export interface PrPerson {
  login: string;
  name?: string;
  bot?: true;
}

export type PrCheckState = "pass" | "fail" | "pending" | "skip" | "neutral";

export interface PrDetail {
  number: number;
  title: string;
  /** Its description, as written (Markdown). */
  body: string;
  author: PrPerson | null;
  base: string;
  head: string;
  createdAt: number;
  updatedAt?: number;
  mergedAt?: number;
  closedAt?: number;
  mergedBy?: PrPerson;
  /** The merge commit's sha. */
  mergeCommit?: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: { name: string; color: string }[];
  assignees: PrPerson[];
  /** Each reviewer's last say, and those asked who haven't said anything yet (pending). */
  reviewers: { who: PrPerson; state: "approved" | "changes" | "commented" | "pending" | "dismissed"; at?: number; body?: string }[];
  /** The issues it closes when it merges. */
  closes: { number: number; url: string; repo?: string }[];
  /** Oldest first, at most 100; `commitCount` is all of them. */
  commits: { sha: string; headline: string; who?: string; login?: string; at: number }[];
  commitCount: number;
  /** At most 100; `changedFiles` is all of them. */
  files: { path: string; additions: number; deletions: number; change: "added" | "modified" | "deleted" | "renamed" }[];
  checks: { name: string; workflow?: string; state: PrCheckState; startedAt?: number; completedAt?: number; link?: string }[];
  comments: number;
  /** GitHub's merge state (mergeStateStatus): CLEAN, BEHIND, BLOCKED, DIRTY, UNSTABLE, DRAFT, HAS_HOOKS, UNKNOWN. */
  mergeState?: string;
}

const str = (v: unknown, max = 400): string => (typeof v === "string" ? v.slice(0, max) : "");
const time = (v: unknown): number | undefined => {
  const t = typeof v === "string" && v ? Date.parse(v) : NaN;
  return Number.isFinite(t) && t > 0 ? t : undefined;
};
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const person = (v: unknown): PrPerson | null => {
  const o = v as { login?: unknown; name?: unknown; is_bot?: unknown } | null;
  const login = str(o?.login, 80);
  if (!login) return null;
  const name = str(o?.name, 120).trim();
  return { login, ...(name && name !== login ? { name } : {}), ...(o?.is_bot === true ? { bot: true as const } : {}) };
};

const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR", "STALE"]);

/** One check run or status context as a word: passed, failed, still going, skipped or neutral. */
export function checkState(c: { status?: unknown; conclusion?: unknown; state?: unknown }): PrCheckState {
  const done = str(c.conclusion ?? c.state).toUpperCase();
  const status = str(c.status).toUpperCase();
  if (FAILED.has(done)) return "fail";
  if (done === "SUCCESS") return "pass";
  if (done === "SKIPPED") return "skip";
  if (done === "NEUTRAL") return "neutral";
  if (!done || done === "PENDING" || done === "EXPECTED" || (status && status !== "COMPLETED")) return "pending";
  return "neutral";
}

const REVIEW: Record<string, PrDetail["reviewers"][number]["state"]> = { APPROVED: "approved", CHANGES_REQUESTED: "changes", COMMENTED: "commented", DISMISSED: "dismissed", PENDING: "pending" };
const CHANGE: Record<string, PrDetail["files"][number]["change"]> = { ADDED: "added", DELETED: "deleted", RENAMED: "renamed", MODIFIED: "modified", CHANGED: "modified", COPIED: "added" };

/** `gh pr view --json …` (git.ts PR_DETAIL_FIELDS) as the panel's PrDetail; null when it isn't one. */
export function prDetailFromGh(j: unknown): PrDetail | null {
  const o = j as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || o.error || typeof o.number !== "number") return null;
  const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  const createdAt = time(o.createdAt) ?? 0;
  // Each reviewer's last say, then anyone asked who hasn't said anything yet.
  const reviewers: PrDetail["reviewers"] = [];
  for (const r of list(o.latestReviews)) {
    const who = person(r.author);
    const state = REVIEW[str(r.state).toUpperCase()];
    if (!who || !state) continue;
    const body = str(r.body, 600).trim();
    const at = time(r.submittedAt);
    reviewers.push({ who, state, ...(at ? { at } : {}), ...(body ? { body } : {}) });
  }
  for (const r of list(o.reviewRequests)) {
    // A team asked to review has a name and slug, not a login.
    const who = person(r) ?? (str(r.slug ?? r.name, 80) ? { login: str(r.slug ?? r.name, 80) } : null);
    if (who && !reviewers.some((x) => x.who.login === who.login)) reviewers.push({ who, state: "pending" });
  }
  const commits = list(o.commits);
  const mergedAt = time(o.mergedAt);
  const closedAt = time(o.closedAt);
  const updatedAt = time(o.updatedAt);
  const mergedBy = person(o.mergedBy);
  const mergeCommit = str((o.mergeCommit as { oid?: unknown } | null)?.oid, 40);
  const mergeState = str(o.mergeStateStatus, 20);
  return {
    number: o.number,
    title: str(o.title, 300),
    body: str(o.body, 20_000),
    author: person(o.author),
    base: str(o.baseRefName, 200),
    head: str(o.headRefName, 200),
    createdAt,
    ...(updatedAt ? { updatedAt } : {}),
    ...(mergedAt ? { mergedAt } : {}),
    ...(closedAt ? { closedAt } : {}),
    ...(mergedBy ? { mergedBy } : {}),
    ...(mergeCommit ? { mergeCommit } : {}),
    additions: num(o.additions),
    deletions: num(o.deletions),
    changedFiles: num(o.changedFiles),
    labels: list(o.labels)
      .map((l) => ({ name: str(l.name, 80), color: /^[0-9a-f]{6}$/i.test(str(l.color)) ? str(l.color) : "888888" }))
      .filter((l) => l.name),
    assignees: list(o.assignees).map(person).filter((p): p is PrPerson => !!p),
    reviewers,
    closes: list(o.closingIssuesReferences)
      .map((i) => {
        const repo = i.repository as { name?: unknown; owner?: { login?: unknown } } | undefined;
        const r = repo && str(repo.owner?.login) && str(repo.name) ? `${str(repo.owner?.login)}/${str(repo.name)}` : "";
        return { number: num(i.number), url: str(i.url, 300), ...(r ? { repo: r } : {}) };
      })
      .filter((i) => i.number > 0 && /^https:\/\/github\.com\//.test(i.url)),
    commits: commits.slice(-100).map((c) => {
      const a = list(c.authors)[0];
      const who = str(a?.name, 120) || str(a?.login, 80);
      const login = str(a?.login, 80);
      return { sha: str(c.oid, 40), headline: str(c.messageHeadline, 300), ...(who ? { who } : {}), ...(login ? { login } : {}), at: time(c.committedDate) ?? time(c.authoredDate) ?? 0 };
    }),
    commitCount: commits.length,
    files: list(o.files)
      .slice(0, 100)
      .map((f) => ({ path: str(f.path, 500), additions: num(f.additions), deletions: num(f.deletions), change: CHANGE[str(f.changeType).toUpperCase()] ?? "modified" }))
      .filter((f) => f.path),
    checks: list(o.statusCheckRollup)
      .map((c) => {
        const name = str(c.name ?? c.context, 200);
        const workflow = str(c.workflowName, 200);
        const link = str(c.detailsUrl ?? c.targetUrl, 500);
        const startedAt = time(c.startedAt);
        const completedAt = time(c.completedAt);
        return { name, ...(workflow && workflow !== name ? { workflow } : {}), state: checkState(c), ...(startedAt ? { startedAt } : {}), ...(completedAt ? { completedAt } : {}), ...(/^https:\/\//.test(link) ? { link } : {}) };
      })
      .filter((c) => c.name),
    comments: typeof o.comments === "number" ? o.comments : list(o.comments).length,
    ...(mergeState ? { mergeState } : {}),
  };
}
