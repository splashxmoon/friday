/**
 * Where a pull request stands on GitHub: open, merged or closed, whether it is a draft, what the reviewers decided, whether
 * its checks pass and whether it can be merged.
 *
 * Two places can say, and either is enough. GitHub's own API, with the token from the workspace's GitHub connection, works from
 * anywhere. The person's own `gh` on their linked machine works with no connection at all. `statusOf` tries them in order and
 * takes the first answer, so each is the other's backup. Both are turned into the same small shape here.
 */

export interface PrStatus {
  state: "open" | "merged" | "closed";
  draft: boolean;
  review: "approved" | "changes_requested" | "review_required" | "none";
  checks: "passing" | "failing" | "pending" | "none";
  /** False when GitHub says it conflicts, null when it has not worked that out yet. */
  mergeable: boolean | null;
  /** Which of the two answered. */
  source: "github" | "gh";
}

type Source = () => Promise<PrStatus | null>;

/** The first source with an answer. A source that throws or answers nothing is passed over. */
export async function statusOf(sources: Source[]): Promise<PrStatus | null> {
  for (const s of sources) {
    const got = await s().catch(() => null);
    if (got) return got;
  }
  return null;
}

const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR", "STALE"]);
const PENDING = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED"]);

/** A list of check conclusions, as one word. Anything failing beats anything pending beats passing. */
function rollup(items: { status?: string; conclusion?: string | null }[]): PrStatus["checks"] {
  if (!items.length) return "none";
  let pending = false;
  for (const i of items) {
    const done = (i.conclusion ?? "").toUpperCase();
    const status = (i.status ?? "").toUpperCase();
    if (FAILED.has(done)) return "failing";
    if (!done || PENDING.has(status) || PENDING.has(done)) pending = true;
  }
  return pending ? "pending" : "passing";
}

/** `gh pr view --json state,isDraft,reviewDecision,statusCheckRollup,mergeable`. */
export function fromGh(j: unknown): PrStatus | null {
  const o = j as { state?: string; isDraft?: boolean; reviewDecision?: string; statusCheckRollup?: { status?: string; conclusion?: string | null; state?: string }[]; mergeable?: string; error?: string } | null;
  if (!o || o.error || !o.state) return null;
  const state = o.state.toUpperCase() === "MERGED" ? "merged" : o.state.toUpperCase() === "CLOSED" ? "closed" : "open";
  const decision = (o.reviewDecision ?? "").toUpperCase();
  return {
    state,
    draft: !!o.isDraft,
    review: decision === "APPROVED" ? "approved" : decision === "CHANGES_REQUESTED" ? "changes_requested" : decision === "REVIEW_REQUIRED" ? "review_required" : "none",
    // A status context reports `state`; a check run reports `status` and `conclusion`.
    checks: rollup((o.statusCheckRollup ?? []).map((c) => ({ status: c.status, conclusion: c.conclusion ?? c.state ?? null }))),
    mergeable: o.mergeable === "MERGEABLE" ? true : o.mergeable === "CONFLICTING" ? false : null,
    source: "gh",
  };
}

/** GitHub's REST pieces for one pull request: the PR, its reviews, and the check runs on its head commit. */
export function fromApi(pr: { state?: string; merged?: boolean; draft?: boolean; mergeable?: boolean | null }, reviews: { user?: { login?: string } | null; state?: string }[], runs: { status?: string; conclusion?: string | null }[]): PrStatus {
  // Each reviewer's last say counts: an approval after a change request clears it.
  const last = new Map<string, string>();
  for (const r of reviews) {
    const s = (r.state ?? "").toUpperCase();
    if ((s === "APPROVED" || s === "CHANGES_REQUESTED") && r.user?.login) last.set(r.user.login, s);
  }
  const says = [...last.values()];
  return {
    state: pr.merged ? "merged" : pr.state === "closed" ? "closed" : "open",
    draft: !!pr.draft,
    review: says.includes("CHANGES_REQUESTED") ? "changes_requested" : says.includes("APPROVED") ? "approved" : "none",
    checks: rollup(runs.map((r) => ({ status: r.status, conclusion: r.conclusion ?? null }))),
    mergeable: typeof pr.mergeable === "boolean" ? pr.mergeable : null,
    source: "github",
  };
}

/** Ask these people to review a pull request again, once what they asked for is pushed. False on any trouble: it is a courtesy, not a step. */
export async function rerequestReview(token: string, prUrl: string, logins: string[], fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(prUrl);
  if (!m || !logins.length) return false;
  const r = await fetchImpl(`https://api.github.com/repos/${m[1]}/${m[2]}/pulls/${m[3]}/requested_reviewers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "friday-board", "Content-Type": "application/json" },
    body: JSON.stringify({ reviewers: logins.slice(0, 15) }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  return !!r?.ok;
}

/** One pull request through GitHub's API with a connection's token. Null on any trouble: the other source gets its turn. */
export async function fromGithubApi(token: string, prUrl: string, fetchImpl: typeof fetch = fetch): Promise<PrStatus | null> {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(prUrl);
  if (!m) return null;
  const [, owner, repo, num] = m;
  const get = async <T>(path: string): Promise<T> => {
    const r = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "friday-board" },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    return (await r.json()) as T;
  };
  const pr = await get<{ state?: string; merged?: boolean; draft?: boolean; mergeable?: boolean | null; head?: { sha?: string } }>(`pulls/${num}`);
  const [reviews, runs] = await Promise.all([
    get<{ user?: { login?: string } | null; state?: string }[]>(`pulls/${num}/reviews?per_page=100`).catch(() => []),
    pr.head?.sha ? get<{ check_runs?: { status?: string; conclusion?: string | null }[] }>(`commits/${pr.head.sha}/check-runs?per_page=100`).then((x) => x.check_runs ?? []).catch(() => []) : Promise.resolve([]),
  ]);
  return fromApi(pr, reviews, runs);
}
