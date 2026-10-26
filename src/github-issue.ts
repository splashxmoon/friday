import type { IssueRef, PrRef } from "./types.js";
import { untrusted, UNTRUSTED_NOTE } from "./untrusted.js";

/**
 * A GitHub issue as the thing a session starts from.
 *
 * Somebody pastes an issue link into the box, and that is the whole setup: the issue's title and text go to the agent
 * with whatever else they typed, the branch is named after it, and the pull request says it closes it. Pure where it
 * can be, so the browser reads a link the same way the server does.
 */

export interface Issue extends IssueRef {
  body: string;
  state: "open" | "closed";
}

const LINK = /https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)\b/;

/** The first issue link in some text, or null. A pull request link is not one. */
export function parseIssueUrl(text: string): Pick<IssueRef, "url" | "repo" | "number"> | null {
  const m = LINK.exec(text);
  if (!m) return null;
  return { url: `https://github.com/${m[1]}/${m[2]}/issues/${m[3]}`, repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
}

/** What a client sent as the session's issue, checked, or null. */
export function issueRef(v: unknown): IssueRef | null {
  const o = v as Partial<IssueRef> | null | undefined;
  const ref = typeof o?.url === "string" ? parseIssueUrl(o.url) : null;
  if (!ref) return null;
  return { ...ref, title: typeof o?.title === "string" ? o.title.trim().slice(0, 200) : "" };
}

/** The issue itself, through GitHub's API: with a connection's token for private repos, without one for public ones. */
export async function fetchIssue(url: string, token: string | null, fetchImpl: typeof fetch = fetch): Promise<Issue> {
  const ref = parseIssueUrl(url);
  if (!ref) throw new Error("That isn't a GitHub issue link.");
  const r = await fetchImpl(`https://api.github.com/repos/${ref.repo}/issues/${ref.number}`, {
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "friday", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(8000),
  });
  if (r.status === 404) throw new Error(token ? "GitHub can't find that issue." : "GitHub can't find that issue. If the repo is private, connect GitHub under Connections first.");
  if (!r.ok) throw new Error(`GitHub answered ${r.status}.`);
  const j = (await r.json()) as { title?: string; body?: string | null; state?: string; pull_request?: unknown };
  if (j.pull_request) throw new Error("That's a pull request, not an issue.");
  return { ...ref, title: String(j.title ?? "").trim().slice(0, 200), body: String(j.body ?? "").slice(0, 6000), state: j.state === "closed" ? "closed" : "open" };
}

/**
 * The first instruction: what the person typed, then the issue in full, so the agent reads the task as they would. The
 * issue's title and text are anyone's on a public repo, so they go in fenced as material, never as orders (untrusted.ts).
 */
export function withIssue(text: string, issue: Issue): string {
  const head = `GitHub issue #${issue.number}: ${issue.url}`;
  const said = untrusted(`GitHub issue #${issue.number}`, `${issue.title}\n\n${issue.body.trim() || "(The issue has no description.)"}`);
  return [text.trim(), "---", head, said, UNTRUSTED_NOTE].filter(Boolean).join("\n\n");
}

// ── Pull requests: the same idea, for reviewing or carrying on somebody's change ──────────────────

export interface Pr extends PrRef {
  body: string;
  base: string;
  state: "open" | "closed" | "merged";
  /** From a fork: the head branch is not on origin, so it cannot be switched to by name. */
  fork: boolean;
}

const PR_LINK = /https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\b/;

/** The first pull-request link in some text, or null. */
export function parsePrLink(text: string): Pick<PrRef, "url" | "repo" | "number"> | null {
  const m = PR_LINK.exec(text);
  if (!m) return null;
  return { url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`, repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
}

/** What a client sent as the session's pull request, checked, or null. */
export function prRef(v: unknown): PrRef | null {
  const o = v as Partial<PrRef> | null | undefined;
  const ref = typeof o?.url === "string" ? parsePrLink(o.url) : null;
  if (!ref) return null;
  return { ...ref, title: typeof o?.title === "string" ? o.title.trim().slice(0, 200) : "", head: typeof o?.head === "string" ? o.head.trim().slice(0, 200) : "" };
}

/** The pull request through GitHub's API: title, text, and the branches it joins. */
export async function fetchPr(url: string, token: string | null, fetchImpl: typeof fetch = fetch): Promise<Pr> {
  const ref = parsePrLink(url);
  if (!ref) throw new Error("That isn't a GitHub pull request link.");
  const r = await fetchImpl(`https://api.github.com/repos/${ref.repo}/pulls/${ref.number}`, {
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "friday", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(8000),
  });
  if (r.status === 404) throw new Error(token ? "GitHub can't find that pull request." : "GitHub can't find that pull request. If the repo is private, connect GitHub under Connections first.");
  if (!r.ok) throw new Error(`GitHub answered ${r.status}.`);
  const j = (await r.json()) as { title?: string; body?: string | null; state?: string; merged?: boolean; head?: { ref?: string; repo?: { full_name?: string } | null }; base?: { ref?: string } };
  return {
    ...ref,
    title: String(j.title ?? "").trim().slice(0, 200),
    body: String(j.body ?? "").slice(0, 6000),
    head: String(j.head?.ref ?? "").slice(0, 200),
    base: String(j.base?.ref ?? "").slice(0, 200),
    state: j.merged ? "merged" : j.state === "closed" ? "closed" : "open",
    fork: !!j.head?.repo?.full_name && j.head.repo.full_name.toLowerCase() !== ref.repo.toLowerCase(),
  };
}

/** The first instruction: what the person typed, then the pull request, so the agent knows which change it is looking at. Fenced like an issue. */
export function withPr(text: string, pr: Pr): string {
  const head = `GitHub pull request #${pr.number}: ${pr.url}\nBranch ${pr.head || "?"} into ${pr.base || "?"}${pr.state !== "open" ? ` (${pr.state})` : ""}`;
  const said = untrusted(`GitHub pull request #${pr.number}`, `${pr.title}\n\n${pr.body.trim() || "(The pull request has no description.)"}`);
  return [text.trim(), "---", head, said, UNTRUSTED_NOTE].filter(Boolean).join("\n\n");
}

/** `friday/12-fix-login-redirect`: the number first, so the branch is findable from the issue. */
export function issueBranch(issue: Pick<IssueRef, "number" | "title">): string {
  const slug = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return `friday/${issue.number}${slug ? `-${slug}` : ""}`;
}
