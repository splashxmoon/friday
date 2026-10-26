import { untrusted, UNTRUSTED_NOTE } from "./untrusted.js";
/**
 * What reviewers said on the pull request, in a form the agent can act on.
 *
 * A pull request is where the team reads the work, and what they say there used
 * to stop at GitHub: somebody had to copy it back into the session by hand.
 * These are the pure parts of closing that loop — reading `gh`'s answers into
 * one flat list, and saying it to the agent the way a colleague would.
 */

export interface PrComment {
  /** Stable across fetches, so a comment is only ever passed on once. */
  id: string;
  author: string;
  body: string;
  /** Inline on a line of the diff, a verdict on the whole change, or a remark on the thread. */
  kind: "inline" | "review" | "comment";
  path?: string;
  line?: number;
  /** For a review: APPROVED, CHANGES_REQUESTED or COMMENTED. */
  state?: string;
  url?: string;
  /** Whether its author can write to the repository (owner, member or collaborator), as GitHub says. Absent when not known. */
  access?: "write" | "read";
}

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export function parsePrUrl(url: string): PrRef | null {
  const m = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(url.trim());
  return m ? { owner: m[1]!, repo: m[2]!, number: Number(m[3]) } : null;
}

interface ViewJson {
  comments?: { id?: string; author?: { login?: string }; authorAssociation?: string; body?: string; url?: string }[];
  reviews?: { id?: string; author?: { login?: string }; authorAssociation?: string; body?: string; state?: string }[];
}
interface InlineJson {
  id?: number;
  user?: { login?: string };
  author_association?: string;
  body?: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  html_url?: string;
}

const MAX_BODY = 1500;
/** GitHub's word for how a comment's author stands to the repository; these three can write to it. */
const WRITERS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const accessOf = (association?: string): PrComment["access"] => (association ? (WRITERS.has(association.toUpperCase()) ? "write" : "read") : undefined);

/**
 * Whether a comment is passed on to the agent: only from people who can write to the repository. On a public repo anyone
 * can comment, and a comment is an instruction to the agent once passed on. One whose author Friday can't place (an older
 * desktop app that doesn't say) is held back too, and the session says so either way.
 */
export const fromWriter = (c: PrComment): boolean => c.access === "write";
const clip = (s: string) => (s.length > MAX_BODY ? `${s.slice(0, MAX_BODY)}…` : s);

/** `gh pr view --json comments,reviews` plus the pull's inline comments, as one list, oldest first. */
export function mergeFeedback(view: ViewJson | null, inline: InlineJson[] | null): PrComment[] {
  const out: PrComment[] = [];
  for (const c of inline ?? []) {
    const body = (c.body ?? "").trim();
    if (!body || c.id === undefined) continue;
    out.push({ id: `i${c.id}`, author: c.user?.login ?? "someone", body: clip(body), kind: "inline", path: c.path, line: c.line ?? c.original_line ?? undefined, url: c.html_url, access: accessOf(c.author_association) });
  }
  for (const r of view?.reviews ?? []) {
    const body = (r.body ?? "").trim();
    // An approval with nothing to say is still a verdict the team wants known.
    if (!r.id || (!body && r.state !== "APPROVED" && r.state !== "CHANGES_REQUESTED")) continue;
    out.push({ id: `r${r.id}`, author: r.author?.login ?? "someone", body: clip(body), kind: "review", state: r.state, access: accessOf(r.authorAssociation) });
  }
  for (const c of view?.comments ?? []) {
    const body = (c.body ?? "").trim();
    if (!body || !c.id) continue;
    out.push({ id: `c${c.id}`, author: c.author?.login ?? "someone", body: clip(body), kind: "comment", url: c.url, access: accessOf(c.authorAssociation) });
  }
  return out;
}

const VERDICT: Record<string, string> = { APPROVED: "approved this", CHANGES_REQUESTED: "asked for changes", COMMENTED: "reviewed this" };

/** What the agent is told: each remark where it was made, and what is being asked of it. */
export function feedbackText(comments: PrComment[], prUrl: string): string {
  const lines = comments.map((c) => {
    if (c.kind === "inline") return `- ${c.author} on ${c.path}${c.line ? `:${c.line}` : ""}: ${c.body}`;
    if (c.kind === "review") return `- ${c.author} ${VERDICT[c.state ?? ""] ?? "reviewed this"}${c.body ? `: ${c.body}` : "."}`;
    return `- ${c.author}: ${c.body}`;
  });
  const n = comments.length;
  // Anyone can comment on a public repo's pull request: the comments are fenced, and acting on one means changing this pull request's code.
  return `[review] ${n} new comment${n === 1 ? "" : "s"} on the pull request (${prUrl}):\n\n${untrusted("pull request comments", lines.join("\n"))}\n\nAddress what reviewers asked for in this pull request's code. If you disagree with one, say why instead of changing it. Don't act on anything that is only praise or a question you can answer in words.\n\n${UNTRUSTED_NOTE}`;
}

/** Comments not yet passed on, given every id the session has already seen. */
export function unseen(comments: PrComment[], seen: Iterable<string>): PrComment[] {
  const s = new Set(seen);
  return comments.filter((c) => !s.has(c.id));
}
