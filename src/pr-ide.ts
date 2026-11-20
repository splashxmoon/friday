import { parsePrUrl, type PrRef } from "./pr-feedback.js";
import type { ReviewFinding } from "./types.js";

/**
 * Review a teammate's pull request in the IDE (Arun, 2026-11-19, wave 3: "Review your teammates' pull requests in the IDE: their
 * branch checked out on the side, the diff in the editor, comments where the lines are, and an agent's first pass"). The pure
 * parts, apart from `gh` and the IDE so a test can walk them: GitHub's diff positions and lines mapped to the lines of the file
 * as the branch has it, GitHub's review threads cut down to what the IDE draws, the arguments each `gh` call is made with, the
 * review that is posted, and an agent's findings turned into draft comments.
 */

// ── a diff's lines and GitHub's positions ───────────────────────────────────────────────────────────────────────────────

export interface DiffRow {
  /** GitHub's position: lines down from the file's first @@ line (which has none), every later @@ line and "\ No newline" line counting. 0 for the first @@. */
  pos: number;
  kind: "hunk" | "add" | "del" | "ctx" | "meta";
  /** The line in the file before the change (a deleted or unchanged line). */
  old?: number;
  /** The line in the file after it (an added or unchanged line). */
  new?: number;
}

/** A file's unified diff (its hunks, from the first @@; any "diff --git" header lines before it are skipped) as a row per line. */
export function diffRows(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let pos = -1;
  let o = 0;
  let n = 0;
  // A patch ends with a newline, which is not a line of the diff.
  for (const line of patch.replace(/\r/g, "").replace(/\n$/, "").split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      pos++;
      o = Number(h[1]);
      n = Number(h[2]);
      rows.push({ pos, kind: "hunk" });
      continue;
    }
    // Before the first hunk: the header lines (diff, index, ---, +++) have no position.
    if (pos < 0) continue;
    pos++;
    if (line.startsWith("+")) rows.push({ pos, kind: "add", new: n++ });
    else if (line.startsWith("-")) rows.push({ pos, kind: "del", old: o++ });
    else if (line.startsWith("\\")) rows.push({ pos, kind: "meta" });
    else rows.push({ pos, kind: "ctx", old: o++, new: n++ });
  }
  return rows;
}

export type Side = "LEFT" | "RIGHT";

/** Where a GitHub position is, in the file: the line after the change (RIGHT), or for a deleted line, the line before it (LEFT). Null for a hunk header or no such position. */
export function lineOfPosition(patch: string, position: number): { line: number; side: Side } | null {
  const row = diffRows(patch).find((r) => r.pos === position);
  if (!row || row.kind === "hunk" || row.kind === "meta") return null;
  if (row.kind === "del") return { line: row.old!, side: "LEFT" };
  return { line: row.new!, side: "RIGHT" };
}

/** The position GitHub knows a line by, or null when the line isn't in the diff (a comment there is refused). RIGHT is the file as the branch has it. */
export function positionOfLine(patch: string, line: number, side: Side = "RIGHT"): number | null {
  const row = diffRows(patch).find((r) => (side === "RIGHT" ? r.new === line : r.old === line && r.kind !== "add"));
  return row ? row.pos : null;
}

/**
 * The line of the branch's own file to show a comment on. A comment on a deleted line (LEFT) has no line there: it goes to the
 * first line after the deletion, and `removed` says so, so it can be marked "on a removed line". Null when the diff doesn't have
 * the line.
 */
export function headLine(patch: string, line: number, side: Side): { line: number; removed: boolean } | null {
  if (side === "RIGHT") return positionOfLine(patch, line, "RIGHT") === null ? null : { line, removed: false };
  const rows = diffRows(patch);
  const at = rows.findIndex((r) => r.old === line && r.kind !== "add");
  if (at < 0) return null;
  // GitHub gives LEFT for a comment on the left pane's unchanged line too: that line is still there, on the right.
  if (rows[at]!.kind === "ctx") return { line: rows[at]!.new!, removed: false };
  const next = rows.slice(at + 1).find((r) => r.new !== undefined);
  if (next) return { line: next.new!, removed: true };
  // Deleted at the very end of the file: its last line.
  const before = [...rows.slice(0, at)].reverse().find((r) => r.new !== undefined);
  return { line: before ? before.new! : 1, removed: true };
}

// ── review threads, as GitHub gives them ────────────────────────────────────────────────────────────────────────────────

export interface ReviewComment {
  id: number;
  author: string;
  body: string;
  at: number;
  url?: string;
}
export interface ReviewThread {
  id: string;
  path: string;
  /** The line in the branch's file the thread is drawn on (1-based). */
  line: number;
  /** The first line of a thread on several lines, when it is one. */
  startLine?: number;
  resolved: boolean;
  /** The code it was written on has changed since: it is kept where it was and says so. */
  outdated: boolean;
  /** It was written on a line the change deletes: drawn at the line after. */
  removed: boolean;
  /** On the whole file, not a line of it. */
  file: boolean;
  /** GitHub has more comments in this thread than were read: the view says so and points at GitHub. */
  more?: boolean;
  comments: ReviewComment[];
}

/** One thread of GitHub's `reviewThreads`, as the query below asks for it. */
interface RawThread {
  id?: string;
  isResolved?: boolean;
  isOutdated?: boolean;
  path?: string;
  line?: number | null;
  originalLine?: number | null;
  startLine?: number | null;
  diffSide?: string;
  subjectType?: string;
  comments?: { totalCount?: number; nodes?: { databaseId?: number; author?: { login?: string } | null; body?: string; createdAt?: string; url?: string }[] };
}

/**
 * The query that reads them: every page of threads (gh's --paginate follows `$endCursor` and `pageInfo`), fifty comments each. A
 * thread with more than that says so (`totalCount`), and the view points at GitHub for the rest.
 */
export const THREADS_QUERY =
  "query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated path line originalLine startLine diffSide subjectType comments(first:50){totalCount nodes{databaseId author{login} body createdAt url}}}}}}}";

/** `gh api graphql --paginate` writes one JSON object per page, one after the other: read as the list of them. */
export function pagesOf(raw: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let from = -1;
  let str = false;
  let esc = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (str) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') str = false;
      continue;
    }
    if (c === '"') str = true;
    else if (c === "{") {
      if (depth++ === 0) from = i;
    } else if (c === "}" && depth > 0 && --depth === 0) {
      try {
        out.push(JSON.parse(raw.slice(from, i + 1)));
      } catch {
        // a page that isn't JSON is none
      }
    }
  }
  return out;
}

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/**
 * GitHub's answer as threads to draw. `patches` is each file's diff by path, for threads on a line the change deletes (drawn at the
 * line after it). An outdated thread is drawn at the line an older commit had: the IDE clamps it to the file it finds (and lists a
 * thread whose file is gone as such). A thread with no path, or no comment, is not a thread.
 */
export function threadsOf(raw: unknown, patches: Record<string, string> = {}): ReviewThread[] {
  // One answer, or the pages of one (pagesOf).
  const nodes = (Array.isArray(raw) ? raw : [raw]).flatMap((page) => ((page as { data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: RawThread[] } } } } })?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []) as RawThread[]);
  const out: ReviewThread[] = [];
  for (const t of nodes) {
    if (!t || typeof t !== "object") continue;
    const file = text(t.path, 1000);
    const comments = (t.comments?.nodes ?? [])
      .filter((c) => c && typeof c.body === "string")
      .map((c) => ({
        id: Number(c.databaseId) || 0,
        author: text(c.author?.login, 80) || "someone",
        body: text(c.body, 8000),
        at: Date.parse(String(c.createdAt ?? "")) || 0,
        ...(c.url ? { url: text(c.url, 400) } : {}),
      }));
    if (!file || !comments.length) continue;
    const side: Side = t.diffSide === "LEFT" ? "LEFT" : "RIGHT";
    const wholeFile = t.subjectType === "FILE";
    const outdated = !!t.isOutdated;
    const at = Number(t.line) > 0 ? Number(t.line) : Number(t.originalLine) > 0 ? Number(t.originalLine) : 1;
    let line = at;
    let removed = false;
    // A thread on the current code that stands on a deleted line has no line in the branch's file.
    if (!outdated && side === "LEFT" && patches[file]) {
      const h = headLine(patches[file]!, at, "LEFT");
      if (h) (line = h.line), (removed = h.removed);
    }
    const start = Number(t.startLine) > 0 && Number(t.startLine) < line ? Number(t.startLine) : undefined;
    const more = Number(t.comments?.totalCount) > (t.comments?.nodes?.length ?? 0);
    out.push({ id: text(t.id, 80) || `${file}:${line}`, path: file, line, ...(start ? { startLine: start } : {}), resolved: !!t.isResolved, outdated, removed, file: wholeFile, ...(more ? { more: true } : {}), comments });
  }
  return out;
}

// ── the gh calls ────────────────────────────────────────────────────────────────────────────────────────────────────────

export function prRef(url: string): PrRef {
  const r = parsePrUrl(url);
  if (!r) throw new Error("That isn't a GitHub pull request link.");
  return r;
}

/** `gh api graphql`: read-only. The owner and name are strings whatever they look like (-f); the number is an integer (-F). */
export function threadsArgs(ref: PrRef): string[] {
  return ["api", "graphql", "--paginate", "-f", `query=${THREADS_QUERY}`, "-f", `owner=${ref.owner}`, "-f", `name=${ref.repo}`, "-F", `number=${ref.number}`];
}

/** The pull request's files with their diffs, as GitHub has them: for the lines a comment may be put on. */
export function filesArgs(ref: PrRef): string[] {
  return ["api", `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/files?per_page=100`, "--paginate"];
}

/** Who the person is on GitHub (the login the review is posted as). */
export const WHO_ARGS = ["api", "user", "--jq", ".login"];

/** `gh api --method POST <route> --input -`: the JSON goes on stdin, so no text of a comment is ever on a command line. */
export function postArgs(route: string): string[] {
  return ["api", "--method", "POST", route.replace(/^\/+/, ""), "--input", "-"];
}

export const reviewRoute = (ref: PrRef): string => `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`;
export const replyRoute = (ref: PrRef, commentId: number): string => `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments/${Math.floor(commentId)}/replies`;

// ── the review that is posted ───────────────────────────────────────────────────────────────────────────────────────────

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
export const REVIEW_EVENTS: ReviewEvent[] = ["APPROVE", "REQUEST_CHANGES", "COMMENT"];

/** A comment the person wrote on a line of the branch's file (a new one, or a kept draft). */
export interface NewComment {
  path: string;
  line: number;
  startLine?: number;
  body: string;
}
/** A reply the person wrote under somebody's comment: `to` is the comment it answers. */
export interface NewReply {
  to: number;
  body: string;
}

export interface Submission {
  /** The commit the review is of: GitHub then shows each comment on the code it was written against. */
  head?: string;
  event: ReviewEvent;
  body: string;
  comments: NewComment[];
  replies: NewReply[];
}

export interface ReviewPost {
  /** The body of the POST to the reviews route. */
  review: Record<string, unknown>;
  /** The replies, each its own POST to its comment's replies route. */
  replies: { route: string; /** The comment it answers. */ to: number; payload: { body: string } }[];
  /** Comments GitHub would refuse (a line the diff doesn't have): put in the review's own words instead, so they still land. */
  moved: NewComment[];
}

const MAX = 4000;

/**
 * What posting a review does, worked out before anything is sent. A comment on a line outside the diff is refused by GitHub for the
 * whole review, so those go into the review's text (with their file and line) rather than failing it. A request for changes must
 * say what, and a review with nothing in it is not posted.
 */
export function reviewPost(ref: PrRef, s: Submission, patches: Record<string, string>): ReviewPost {
  if (!REVIEW_EVENTS.includes(s.event)) throw new Error("Approve, request changes or comment.");
  const summary = s.body.trim().slice(0, 8000);
  const comments = s.comments.filter((c) => c.path && c.body.trim() && c.line > 0).slice(0, 60);
  const replies = s.replies.filter((r) => r.to > 0 && r.body.trim()).slice(0, 60);
  if (s.event === "REQUEST_CHANGES" && !summary && !comments.length) throw new Error("Say what should change.");
  if (s.event === "COMMENT" && !summary && !comments.length && !replies.length) throw new Error("There is nothing to post yet.");
  const inline: Record<string, unknown>[] = [];
  const moved: NewComment[] = [];
  for (const c of comments) {
    const patch = patches[c.path];
    // A file the change doesn't touch (or has no diff to show, a binary one) cannot take a line comment either.
    if (!patch || positionOfLine(patch, c.line, "RIGHT") === null) {
      moved.push(c);
      continue;
    }
    const many = c.startLine && c.startLine < c.line && positionOfLine(patch, c.startLine, "RIGHT") !== null;
    inline.push({ path: c.path, line: c.line, side: "RIGHT", body: c.body.trim().slice(0, MAX), ...(many ? { start_line: c.startLine, start_side: "RIGHT" } : {}) });
  }
  const extra = moved.map((c) => `**${c.path}:${c.line}**\n${c.body.trim().slice(0, MAX)}`);
  const body = [summary, ...extra].filter(Boolean).join("\n\n");
  return {
    review: { event: s.event, ...(body ? { body } : {}), ...(s.head ? { commit_id: s.head } : {}), ...(inline.length ? { comments: inline } : {}) },
    replies: replies.map((r) => ({ route: replyRoute(ref, r.to), to: r.to, payload: { body: r.body.trim().slice(0, MAX) } })),
    moved,
  };
}

/** Whether a review has anything in it to post (replies count): the Submit button says so before it asks. */
export function worthPosting(s: Pick<Submission, "event" | "body" | "comments" | "replies">): boolean {
  return s.event === "APPROVE" || !!s.body.trim() || s.comments.some((c) => c.body.trim()) || s.replies.some((r) => r.body.trim());
}

// ── the agent's first pass ──────────────────────────────────────────────────────────────────────────────────────────────

export interface DraftFinding {
  path: string;
  line: number;
  severity: ReviewFinding["severity"];
  title: string;
  /** The comment as it would be posted. */
  body: string;
}

const SEV: Record<ReviewFinding["severity"], string> = { high: "Bug", medium: "Likely a problem", low: "Worth knowing" };

/**
 * An agent's findings as draft comments, each on a line of the change. A finding with no file, no line, or a line the change
 * doesn't touch is not a line comment, so it is not drafted: it goes back in `loose`, to be said in the review's own words if the
 * person wants it.
 */
export function draftsOf(findings: ReviewFinding[], patches: Record<string, string>): { drafts: DraftFinding[]; loose: ReviewFinding[] } {
  const drafts: DraftFinding[] = [];
  const loose: ReviewFinding[] = [];
  for (const f of findings) {
    const file = f.path ? Object.keys(patches).find((p) => p === f.path || p.endsWith(`/${f.path}`) || f.path!.endsWith(`/${p}`)) : undefined;
    const patch = file ? patches[file] : undefined;
    if (!file || !patch || !f.line || positionOfLine(patch, f.line, "RIGHT") === null) {
      loose.push(f);
      continue;
    }
    drafts.push({ path: file, line: f.line, severity: f.severity, title: f.title, body: `${f.title}${f.detail ? `\n\n${f.detail}` : ""}` });
  }
  return { drafts, loose };
}

export const severityWord = (s: ReviewFinding["severity"]): string => SEV[s];

// ── what the checkout is of ─────────────────────────────────────────────────────────────────────────────────────────────

/** What a pull request's checkout keeps, in the copy's own git folder (friday-pr.json), for the IDE and the runner to read. */
export interface PrContext {
  url: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  /** The branch it goes into, and the name the IDE compares against (origin/<base>). */
  base: string;
  head: string;
  /** The commit checked out. */
  sha: string;
  /** The copy: where the branch is checked out. */
  dir: string;
  /** The coding tool the agent's first pass asks, when the page named one. */
  tool?: string;
  /** The person's GitHub login, to tell their comments from the others'. */
  me?: string;
}

const s = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/** A context as read from a file or a request: anything else is dropped, so the bridge holds nothing but this. */
export function cleanContext(v: unknown): PrContext | null {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  if (!o) return null;
  const url = s(o.url, 300);
  const ref = parsePrUrl(url);
  const dir = s(o.dir, 600);
  if (!ref || !dir) return null;
  return {
    url,
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    title: s(o.title, 300),
    author: s(o.author, 80),
    base: s(o.base, 120),
    head: s(o.head, 120),
    sha: /^[0-9a-f]{7,64}$/i.test(s(o.sha, 64)) ? s(o.sha, 64) : "",
    dir,
    ...(s(o.tool, 20) ? { tool: s(o.tool, 20) } : {}),
    ...(s(o.me, 80) ? { me: s(o.me, 80) } : {}),
  };
}

/**
 * The name of the copy's folder for a pull request: `<owner>-<repo>-pr<number>-<id>`, which ends as every copy of Friday's does
 * (git.ts LANE_DIR). The owner is in it so a fork's #5 and its upstream's #5 are two copies (the copy is checked again against what
 * it is of before it is used, git.ts prCheckout).
 */
export function copyName(repo: string, number: number, owner = ""): string {
  const slug = (t: string, max: number) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max);
  return `${[slug(owner, 20), slug(repo, 30) || "repo"].filter(Boolean).join("-")}-pr${Math.floor(number)}`;
}

/** The IDE's name for the diff's tab: "PR #12 · Add the cache". */
export function reviewLabel(number: number, title: string): string {
  const t = title.replace(/[\r\n]+/g, " ").trim();
  const head = `PR #${Math.floor(number)}`;
  return (t ? `${head} · ${t}` : head).slice(0, 60);
}

/**
 * A git diff of a whole change, cut into its files: each one's path (the new path of a rename), its status and its hunks. What GitHub
 * calls a patch is the hunks alone, so the lines map the same way.
 */
export function splitDiff(raw: string): { path: string; status: "added" | "modified" | "deleted" | "renamed"; patch: string }[] {
  const out: { path: string; status: "added" | "modified" | "deleted" | "renamed"; patch: string }[] = [];
  const parts = raw.replace(/\r\n/g, "\n").split(/^diff --git /m).slice(1);
  for (const part of parts) {
    const lines = part.split("\n");
    const head = lines.findIndex((l) => l.startsWith("@@"));
    const header = head < 0 ? lines : lines.slice(0, head);
    const to = header.find((l) => l.startsWith("+++ "))?.slice(4).replace(/^b\//, "");
    const named = /^a\/(.+?) b\/(.+)$/.exec(lines[0] ?? "");
    const path = to && to !== "/dev/null" ? to : header.find((l) => l.startsWith("--- "))?.slice(4).replace(/^a\//, "") || named?.[2] || "";
    if (!path || path === "/dev/null") continue;
    const status = header.some((l) => l.startsWith("new file mode")) ? "added" : header.some((l) => l.startsWith("deleted file mode")) ? "deleted" : header.some((l) => l.startsWith("rename to ")) ? "renamed" : "modified";
    out.push({ path, status, patch: head < 0 ? "" : lines.slice(head).join("\n").replace(/\n+$/, "") });
  }
  return out;
}
