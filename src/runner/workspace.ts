import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { childPath } from "./adapters.js";
import { authEnv, ghBin, githubGraphql, machineToken } from "./github.js";
import { cloneFailure } from "./clone-failure.js";
import { canonicalUrl, parseRepo } from "./repo.js";
import { ISSUE_QUERY, issueSearches, issuesFromGraphql, type GithubIssues } from "../issues.js";

/**
 * Finding the folder a coding agent should work in, on the host's machine:
 * their recent repos, a folder browser, a dropped folder found by name, and
 * cloning from GitHub with their own git/gh login. Friday never holds a token;
 * `gh` and `git` use whatever the person is already signed in with.
 */

export interface FolderInfo {
  path: string;
  name: string;
  isRepo: boolean;
  branch?: string;
  /** origin URL, when it's a git repo with one. */
  remote?: string;
  /** Last activity, for sorting recent work first. */
  mtime?: number;
  /** Uncommitted changes to tracked files, when asked about one folder: somebody is working in it, so it isn't moved to a new branch. */
  dirty?: boolean;
  /** The folders kept for this one that its tool may work in too (extra-dirs.ts), when asked for them. */
  dirs?: string[];
  /**
   * Its branches, when asked for them (`branches`): this checkout's, newest first, with the other folder any is checked out in
   * (git keeps a branch in one at a time); then origin's that aren't here (`remote`), as last fetched.
   */
  branches?: { name: string; elsewhere?: string; remote?: true }[];
}

export interface GithubRepo {
  slug: string;
  url: string;
  description: string;
  private: boolean;
  updatedAt: string;
}

const MAX_SCAN = 2500;
/** Folders people keep code in, relative to home. "" is home itself. */
const ROOTS = ["", "code", "Code", "dev", "Developer", "projects", "Projects", "src", "repos", "GitHub", "git", "work", "Desktop", "Documents", "Friday"];
const SKIP = new Set(["node_modules", "Library", "Applications", "Pictures", "Music", "Movies", "Public", "vendor", "dist", "build"]);

function run(cmd: string, args: string[], opts: { cwd?: string; timeout?: number; env?: Record<string, string> } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      // No terminal prompts: a clone that needs a password fails with a message instead of hanging.
      { cwd: opts.cwd, timeout: opts.timeout ?? 15_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, ...opts.env, PATH: childPath(), GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" } },
      (err, out, errOut) => (err ? reject(new Error(String(errOut).trim() || err.message)) : resolve(out)),
    );
  });
}

const exists = (p: string) => stat(p).then(() => true, () => false);

/**
 * A value, or a fallback if it takes too long. Filesystem calls on cloud-synced
 * or network folders can block for a very long time, and nothing here is worth
 * making someone wait for.
 */
function soon<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    t.unref?.();
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      () => (clearTimeout(t), resolve(fallback)),
    );
  });
}

/**
 * One name for one folder. realpath follows symlinks and returns the casing the
 * filesystem actually uses, so ~/code and ~/Code collapse to the same key on
 * macOS and Windows instead of being scanned and listed twice. A path that
 * can't be resolved (gone, or no permission) falls back to its absolute form,
 * which is still a stable key for the visited set.
 */
const canonical = (p: string) => realpath(p).catch(() => path.resolve(p));

async function subdirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * A value as git wrote it into .git/config.
 *
 * git escapes backslashes and wraps anything containing a space in quotes, so
 * a Windows remote comes back as "file://C:\\\\Users\\\\..." and a path under a
 * home directory with a space in it comes back quoted. Read raw, either one is
 * a URL that matches nothing and a clone that can never be recognised as its
 * own.
 */
function gitValue(raw: string): string {
  const v = raw.trim();
  const inner = v.startsWith('"') && v.endsWith('"') && v.length > 1 ? v.slice(1, -1) : v;
  return inner.replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
}

/** Branch and origin, read from .git directly: no process per repo. */
export async function describe(dir: string): Promise<FolderInfo> {
  const name = path.basename(dir) || dir;
  const git = path.join(dir, ".git");
  const s = await stat(git).catch(() => null);
  if (!s) return { path: dir, name, isRepo: false };
  const info: FolderInfo = { path: dir, name, isRepo: true };
  if (s.isDirectory()) {
    const head = await readFile(path.join(git, "HEAD"), "utf8").catch(() => "");
    const m = head.match(/^ref: refs\/heads\/(.+)$/m);
    info.branch = m ? m[1]!.trim() : head.trim().slice(0, 7) || undefined;
    const config = await readFile(path.join(git, "config"), "utf8").catch(() => "");
    const origin = config.match(/\[remote "origin"\][^[]*?url\s*=\s*([^\n]+)/);
    // A login in the URL (a clone made with a token) is the one thing here that must never reach a browser.
    if (origin) info.remote = gitValue(origin[1]!).replace(/\/\/[^/@]+@/, "//");
    // The index is rewritten on most git activity, so it tracks "last worked on".
    info.mtime = (await stat(path.join(git, "index")).catch(() => s)).mtimeMs;
  } else info.mtime = s.mtimeMs;
  return info;
}

/**
 * Walk the usual code folders, breadth-first, and hand each folder's entries to
 * `onDir`, which returns false to stop descending into it.
 *
 * Speed is the whole design here, because this runs while someone waits with a
 * menu open. One directory read per folder (the entry list also answers "is
 * this a repo?"), a dozen folders in flight at once, and a hard time budget:
 * home directories can include cloud-synced trees where a single read takes
 * hundreds of milliseconds, and a partial answer now beats a full one later.
 */
async function scan(home: string, budgetMs: number, onDir: (dir: string, names: Set<string>, dirs: string[]) => boolean): Promise<void> {
  const deadline = Date.now() + budgetMs;
  // A cloud-synced folder (iCloud Desktop, OneDrive) can leave a single
  // directory read hanging for minutes, which would pin the whole scan no
  // matter what the budget said. So every read races a short timer, and the
  // scan as a whole races the budget.
  const stop = { now: false };
  setTimeout(() => (stop.now = true), budgetMs).unref?.();
  // Lower-cased paths: ~/code and ~/Code are the same folder on macOS and
  // Windows, and comparing strings is far cheaper than resolving each one.
  const seen = new Set<string>();
  const queue: { dir: string; depth: number }[] = [];
  const push = (dir: string, depth: number) => {
    const key = dir.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    queue.push({ dir, depth });
  };
  for (const r of ROOTS) push(path.join(home, r), r === "" ? 1 : 2);

  let scanned = 0;
  while (queue.length && !stop.now && Date.now() < deadline && scanned < MAX_SCAN) {
    const batch = queue.splice(0, 12);
    const read = await Promise.all(
      batch.map(({ dir, depth }) =>
        soon(
          readdir(dir, { withFileTypes: true }).then((entries) => ({ dir, depth, entries })),
          Math.min(400, Math.max(50, deadline - Date.now())),
          null,
        ),
      ),
    );
    for (const r of read) {
      if (!r) continue;
      scanned++;
      // Every name, because .git is a file in a worktree and a folder elsewhere.
      const names = new Set(r.entries.map((e) => e.name));
      const dirs = r.entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name)).map((e) => e.name);
      if (!onDir(r.dir, names, dirs) || r.depth === 0) continue;
      for (const n of dirs) push(path.join(r.dir, n), r.depth - 1);
    }
  }
}

/** Git repos under the usual code folders, most recently touched first. */
export async function recentRepos(limit = 24, home = homedir(), budgetMs = 1500): Promise<FolderInfo[]> {
  const repos: string[] = [];
  await scan(home, budgetMs, (dir, names) => {
    if (dir !== home && names.has(".git")) {
      repos.push(dir);
      return false; // a repo's subfolders are part of it
    }
    return true;
  });
  // Reading HEAD and config costs a few file reads each, so only for what's shown.
  const found = await Promise.all(repos.slice(0, 60).map((d) => soon(describe(d), 600, null)));
  return found
    .filter((f): f is FolderInfo => !!f)
    .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
    .slice(0, limit);
}

let repoCache: { at: number; value: FolderInfo[]; home: string } | null = null;
let refreshing: Promise<FolderInfo[]> | null = null;
const CACHE_MS = 30_000;

/**
 * The same list, but instant after the first time: a stale answer is served
 * while a fresh scan runs behind it. Opening the picker shouldn't ever wait.
 */
export function recentReposCached(home = homedir()): Promise<FolderInfo[]> {
  const stale = !repoCache || repoCache.home !== home || Date.now() - repoCache.at > CACHE_MS;
  if (stale && !refreshing) {
    refreshing = recentRepos(24, home).then(
      (value) => {
        repoCache = { at: Date.now(), value, home };
        refreshing = null;
        return value;
      },
      (err) => {
        refreshing = null;
        throw err;
      },
    );
  }
  if (repoCache?.home === home) return Promise.resolve(repoCache.value);
  return refreshing ?? Promise.resolve([]);
}

/** One level of a folder, for the picker. Repos first. */
export async function browse(dir: string): Promise<{ path: string; parent: string | null; isRepo: boolean; entries: FolderInfo[] }> {
  const abs = path.resolve(dir);
  const s = await stat(abs).catch(() => null);
  if (!s?.isDirectory()) throw new Error(`There's no folder at ${abs}.`);
  const entries = await Promise.all((await subdirs(abs)).slice(0, 400).map(describe));
  entries.sort((a, b) => Number(b.isRepo) - Number(a.isRepo) || a.name.localeCompare(b.name));
  const parent = path.dirname(abs);
  return { path: abs, parent: parent === abs ? null : parent, isRepo: await exists(path.join(abs, ".git")), entries };
}

/**
 * A browser only tells a page the *name* of a dropped folder, never its path.
 * So look for folders with that name where code usually lives.
 */
export async function findByName(name: string, home = homedir(), budgetMs = 1500): Promise<FolderInfo[]> {
  if (!name || /[\\/]/.test(name) || name.startsWith(".")) return [];
  const hits: string[] = [];
  const wanted = name.toLowerCase();
  await scan(home, budgetMs, (dir, names, dirs) => {
    for (const d of dirs) if (d.toLowerCase() === wanted) hits.push(path.join(dir, d));
    // Don't walk into a repo looking for another one, and stop once there's a choice to make.
    return hits.length < 10 && !names.has(".git");
  });
  return (await Promise.all([...new Set(hits)].slice(0, 10).map((d) => soon(describe(d), 600, null)))).filter((f): f is FolderInfo => !!f);
}

export { parseRepo };

export { ghBin };
const findGh = ghBin;

export interface GithubState {
  /** gh is on this machine. */
  installed: boolean;
  /** gh is installed *and* signed in, so the list is real. */
  available: boolean;
  /** Who it's signed in as, for "not the right account?" moments. */
  account?: string;
  reason?: string;
  repos: GithubRepo[];
}

/**
 * A GitHub token, without asking anyone to install or paste anything: the login this computer already has (gh, or the
 * credential git keeps for github.com), or the one Connect added. See github.ts.
 */
async function githubToken(): Promise<string | null> {
  return (await machineToken())?.token ?? null;
}

/** Who that token belongs to, so the list can say whose repos these are. */
async function githubApi<T>(token: string, path_: string): Promise<T> {
  const res = await fetch(`https://api.github.com${path_}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "friday" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(res.status === 401 ? "GitHub didn't accept the login git has saved for it." : `GitHub answered ${res.status}.`);
  return (await res.json()) as T;
}

/** How many repos are worth listing. Past this, a picker is the wrong tool anyway. */
const MAX_REPOS = 1000;
const PER_PAGE = 100;

/**
 * The repos that token can see, newest first — all of them.
 *
 * One page of a hundred is what this used to ask for, so anybody with more
 * than a hundred repositories simply could not see the rest, and nothing
 * said so. GitHub pages at a hundred, so the only way to have them all is to
 * keep asking until a page comes back short.
 */
async function reposFromToken(token: string): Promise<{ account?: string; repos: GithubRepo[] }> {
  type ApiRepo = { full_name: string; html_url: string; description: string | null; private: boolean; updated_at: string };
  const me = await githubApi<{ login: string }>(token, "/user").catch(() => null);

  const list: ApiRepo[] = [];
  for (let page = 1; list.length < MAX_REPOS; page++) {
    const batch = await githubApi<ApiRepo[]>(
      token,
      `/user/repos?per_page=${PER_PAGE}&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
    );
    list.push(...batch);
    // A short page is the last page. This is also what stops the loop when a
    // server ignores `page` and keeps answering with the same hundred.
    if (batch.length < PER_PAGE) break;
  }

  return {
    ...(me?.login ? { account: me.login } : {}),
    repos: list.map((r) => ({ slug: r.full_name, url: r.html_url, description: r.description ?? "", private: r.private, updatedAt: r.updated_at })),
  };
}

/** The person's own repos, through their signed-in GitHub CLI. */
export async function githubRepos(): Promise<GithubState> {
  const gh = await findGh();
  let account: string | undefined;
  if (gh) {
    try {
      // --json keeps this parseable; older gh versions don't have it, hence the fallback.
      const status = await run(gh, ["auth", "status"]).catch((e: Error) => e.message);
      account = status.match(/account (\S+)/)?.[1] ?? status.match(/Logged in to \S+ as (\S+)/)?.[1];
      if (!/not logged|no accounts/i.test(status)) {
        // gh pages for us, so --limit is the only ceiling; a hundred was
        // cutting off anybody with more repositories than that.
        const out = await run(gh, ["repo", "list", "--limit", String(MAX_REPOS), "--json", "nameWithOwner,url,description,isPrivate,updatedAt"], { timeout: 30_000 });
        const list = JSON.parse(out) as { nameWithOwner: string; url: string; description: string | null; isPrivate: boolean; updatedAt: string }[];
        return {
          installed: true,
          available: true,
          ...(account ? { account } : {}),
          repos: list
            .map((r) => ({ slug: r.nameWithOwner, url: r.url, description: r.description ?? "", private: r.isPrivate, updatedAt: r.updatedAt }))
            .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
        };
      }
    } catch {
      // gh is here but couldn't answer. The credential git uses still might.
    }
  }

  // No gh, or gh with nothing to say: ask GitHub directly with the login git
  // already has. Nobody has to install a CLI to see their own repos.
  const token = await githubToken().catch(() => null);
  if (token) {
    try {
      const { account: who, repos } = await reposFromToken(token);
      return {
        installed: !!gh,
        available: true,
        ...(who ?? account ? { account: who ?? account! } : {}),
        repos: repos.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
      };
    } catch (e) {
      return { installed: !!gh, available: false, ...(account ? { account } : {}), reason: `${(e as Error).message} You can still paste any repo URL.`, repos: [] };
    }
  }
  return {
    installed: !!gh,
    available: false,
    reason: "No GitHub login found on this computer yet. Sign in to GitHub once in your git client — or just paste any repo URL here and Friday will clone it.",
    repos: [],
  };
}

// ── pull requests ────────────────────────────────────────────────────

/** A check on a pull request that failed or is still running, with where to read it. */
export interface PrCheck {
  name: string;
  url: string;
  state: "failing" | "pending";
}

/** One pull request, as Code Review shows it. */
export interface PullRequest {
  /** GitHub's node id, for what only its GraphQL API does (marking a draft ready). */
  id?: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  avatar: string;
  branch: string;
  base?: string;
  /** The commit at its head: its checks are re-run on it, and a review is kept to the code it read. */
  head?: string;
  draft: boolean;
  createdAt?: string;
  updatedAt: string;
  mergedAt?: string;
  review: "approved" | "changes_requested" | "review_required" | "none";
  checks: "passing" | "failing" | "pending" | "none";
  /** The checks that failed or are still running, by name. */
  failing?: PrCheck[];
  /** False when it conflicts, null while GitHub is still working it out. */
  mergeable: boolean | null;
  /** GitHub's word for whether it can merge now: "clean", "behind" (its base moved on), "blocked", "dirty", "unstable"… */
  mergeState?: string;
  additions: number;
  deletions: number;
  comments: number;
  /** Review threads nobody has resolved. */
  unresolved?: number;
  changedFiles?: number;
  /** The files it changes, as many as GitHub lists in one answer. */
  files?: { path: string; additions: number; deletions: number }[];
  /** Who has been asked to review it and hasn't yet. */
  requested?: { login: string; avatar: string }[];
  /** When a review was last asked for, so a wait can be said in days. */
  requestedAt?: string;
}

export interface PullRequests {
  available: boolean;
  account?: string;
  reason?: string;
  /** Yours, open. */
  mine: PullRequest[];
  /** Somebody asked you to review. */
  review: PullRequest[];
  /** Yours, merged in the last week. */
  merged: PullRequest[];
}

const PR_FIELDS = `fragment P on PullRequest {
  id number title url isDraft createdAt updatedAt mergedAt headRefName headRefOid baseRefName reviewDecision mergeable mergeStateStatus
  additions deletions changedFiles
  repository { nameWithOwner }
  author { login avatarUrl }
  comments { totalCount }
  reviewThreads(first: 50) { nodes { isResolved } }
  files(first: 60) { nodes { path additions deletions } }
  reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login avatarUrl } ... on Team { name } } } }
  timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 1) { nodes { ... on ReviewRequestedEvent { createdAt } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 40) { nodes {
    __typename
    ... on CheckRun { name conclusion status detailsUrl }
    ... on StatusContext { context state targetUrl }
  } } } } } }
}`;

const PR_QUERY = `query($mine: String!, $review: String!, $merged: String!) {
  viewer { login }
  mine: search(query: $mine, type: ISSUE, first: 30) { nodes { ...P } }
  review: search(query: $review, type: ISSUE, first: 30) { nodes { ...P } }
  merged: search(query: $merged, type: ISSUE, first: 15) { nodes { ...P } }
}
${PR_FIELDS}`;

const TEAM_QUERY = `query($q: String!) { team: search(query: $q, type: ISSUE, first: 40) { nodes { ...P } } }
${PR_FIELDS}`;

/** The three searches, as GitHub's own search box would take them. */
export function prSearches(now = Date.now()): { mine: string; review: string; merged: string } {
  const week = new Date(now - 7 * 86_400_000).toISOString().slice(0, 10);
  return {
    mine: "is:pr is:open author:@me archived:false sort:updated-desc",
    review: "is:pr is:open review-requested:@me archived:false sort:updated-desc",
    merged: `is:pr is:merged author:@me merged:>=${week} sort:updated-desc`,
  };
}

/** Everybody else's open pull requests in these repos: what the team has in flight where you work. */
export function teamSearch(repos: string[]): string | null {
  const ok = [...new Set(repos.filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r)))].slice(0, 12);
  return ok.length ? `is:pr is:open archived:false -author:@me sort:updated-desc ${ok.map((r) => `repo:${r}`).join(" ")}` : null;
}

type Node = {
  id?: string; number?: number; title?: string; url?: string; isDraft?: boolean; createdAt?: string; updatedAt?: string; mergedAt?: string | null;
  headRefName?: string; headRefOid?: string; baseRefName?: string; reviewDecision?: string | null; mergeable?: string; mergeStateStatus?: string;
  additions?: number; deletions?: number; changedFiles?: number;
  repository?: { nameWithOwner?: string }; author?: { login?: string; avatarUrl?: string } | null; comments?: { totalCount?: number };
  reviewThreads?: { nodes?: { isResolved?: boolean }[] };
  files?: { nodes?: { path?: string; additions?: number; deletions?: number }[] };
  reviewRequests?: { nodes?: { requestedReviewer?: { login?: string; avatarUrl?: string; name?: string } | null }[] };
  timelineItems?: { nodes?: { createdAt?: string }[] };
  commits?: { nodes?: { commit?: { statusCheckRollup?: { state?: string; contexts?: { nodes?: Record<string, unknown>[] } } | null } }[] };
};

const checksWord = (s?: string): PullRequest["checks"] => (s === "SUCCESS" ? "passing" : s === "FAILURE" || s === "ERROR" ? "failing" : s === "PENDING" || s === "EXPECTED" ? "pending" : "none");
const reviewWord = (s?: string | null): PullRequest["review"] => (s === "APPROVED" ? "approved" : s === "CHANGES_REQUESTED" ? "changes_requested" : s === "REVIEW_REQUIRED" ? "review_required" : "none");

/** The checks worth naming: what failed, and what is still running. A passing or skipped one says nothing. */
function namedChecks(nodes: Record<string, unknown>[] = []): PrCheck[] {
  const out: PrCheck[] = [];
  for (const c of nodes) {
    if (c.__typename === "CheckRun") {
      const done = c.status === "COMPLETED";
      const bad = ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(String(c.conclusion));
      if (bad || !done) out.push({ name: String(c.name ?? "check"), url: String(c.detailsUrl ?? ""), state: bad ? "failing" : "pending" });
    } else if (c.__typename === "StatusContext") {
      const s = String(c.state);
      if (s === "FAILURE" || s === "ERROR" || s === "PENDING" || s === "EXPECTED") out.push({ name: String(c.context ?? "status"), url: String(c.targetUrl ?? ""), state: s === "PENDING" || s === "EXPECTED" ? "pending" : "failing" });
    }
  }
  return out.sort((a, b) => (a.state === b.state ? 0 : a.state === "failing" ? -1 : 1));
}

// A search can turn up something that isn't a pull request (an empty node); those are left out.
function prList(nodes?: Node[]): PullRequest[] {
  return (nodes ?? [])
    .filter((n) => n.url && n.number)
    .map((n) => {
      const rollup = n.commits?.nodes?.[0]?.commit?.statusCheckRollup;
      const failing = namedChecks(rollup?.contexts?.nodes);
      const requested = (n.reviewRequests?.nodes ?? []).map((r) => r.requestedReviewer).filter((r): r is { login: string; avatarUrl?: string } => !!r?.login).map((r) => ({ login: r.login, avatar: r.avatarUrl ?? "" }));
      const files = (n.files?.nodes ?? []).filter((f) => f.path).map((f) => ({ path: f.path!, additions: f.additions ?? 0, deletions: f.deletions ?? 0 }));
      const unresolved = (n.reviewThreads?.nodes ?? []).filter((t) => t.isResolved === false).length;
      const requestedAt = n.timelineItems?.nodes?.[0]?.createdAt;
      return {
        ...(n.id ? { id: n.id } : {}),
        repo: n.repository?.nameWithOwner ?? "",
        number: n.number!,
        title: n.title ?? "",
        url: n.url!,
        author: n.author?.login ?? "",
        avatar: n.author?.avatarUrl ?? "",
        branch: n.headRefName ?? "",
        ...(n.baseRefName ? { base: n.baseRefName } : {}),
        ...(n.headRefOid ? { head: n.headRefOid } : {}),
        draft: !!n.isDraft,
        ...(n.createdAt ? { createdAt: n.createdAt } : {}),
        updatedAt: n.updatedAt ?? "",
        ...(n.mergedAt ? { mergedAt: n.mergedAt } : {}),
        review: reviewWord(n.reviewDecision),
        checks: checksWord(rollup?.state),
        ...(failing.length ? { failing } : {}),
        mergeable: n.mergeable === "MERGEABLE" ? true : n.mergeable === "CONFLICTING" ? false : null,
        ...(n.mergeStateStatus ? { mergeState: n.mergeStateStatus.toLowerCase() } : {}),
        additions: n.additions ?? 0,
        deletions: n.deletions ?? 0,
        comments: n.comments?.totalCount ?? 0,
        ...(unresolved ? { unresolved } : {}),
        ...(n.changedFiles !== undefined ? { changedFiles: n.changedFiles } : {}),
        ...(files.length ? { files } : {}),
        ...(requested.length ? { requested } : {}),
        ...(requestedAt ? { requestedAt } : {}),
      };
    });
}

/** GitHub's answer to PR_QUERY, as the lists Code Review shows. */
export function prsFromGraphql(j: unknown): Omit<PullRequests, "available"> {
  const d = (j as { data?: { viewer?: { login?: string }; mine?: { nodes?: Node[] }; review?: { nodes?: Node[] }; merged?: { nodes?: Node[] } } } | null)?.data;
  return { ...(d?.viewer?.login ? { account: d.viewer.login } : {}), mine: prList(d?.mine?.nodes), review: prList(d?.review?.nodes), merged: prList(d?.merged?.nodes) };
}

const NO_LOGIN = "No GitHub login on this computer yet. Connect GitHub and your pull requests show here.";

/**
 * Your pull requests on GitHub: open ones, ones waiting on your review, and what merged this week.
 *
 * Asked as the login this computer already has (gh, or the one git keeps), or the one Connect added. Read only.
 */
export async function pullRequests(): Promise<PullRequests> {
  if (!(await machineToken())) return { available: false, reason: NO_LOGIN, mine: [], review: [], merged: [] };
  try {
    return { available: true, ...prsFromGraphql({ data: await githubGraphql(PR_QUERY, prSearches()) }) };
  } catch (e) {
    return { available: false, reason: (e as Error).message, mine: [], review: [], merged: [] };
  }
}

/** Your open GitHub issues: assigned to you, and the ones you opened. Asked the same way as the pull requests, read only. */
export async function issues(): Promise<GithubIssues> {
  if (!(await machineToken())) return { available: false, reason: NO_LOGIN.replace("pull requests", "issues"), assigned: [], authored: [] };
  try {
    return { available: true, ...issuesFromGraphql({ data: await githubGraphql(ISSUE_QUERY, issueSearches()) }) };
  } catch (e) {
    return { available: false, reason: (e as Error).message, assigned: [], authored: [] };
  }
}

/** Everybody else's open pull requests in the repos you work in. */
export async function teamPullRequests(repos: string[]): Promise<{ team: PullRequest[] }> {
  const q = teamSearch(repos);
  if (!q) return { team: [] };
  const d = await githubGraphql<{ team?: { nodes?: Node[] } }>(TEAM_QUERY, { q });
  return { team: prList(d?.team?.nodes) };
}

/** Where cloned repos go unless the person picks somewhere else. */
export const defaultCloneRoot = () => path.join(homedir(), "Friday");

/**
 * Clone a repo onto this machine, or reuse the copy already there. With `gh`
 * signed in, private repos just work; otherwise git uses its own credentials.
 */
export async function cloneRepo(input: string, parent = defaultCloneRoot()): Promise<FolderInfo & { reused: boolean }> {
  const repo = parseRepo(input);
  if (!repo) throw new Error("That doesn't look like a repo. Try owner/name or a GitHub URL.");
  await mkdir(parent, { recursive: true });
  const dest = path.join(parent, repo.name);
  if (await exists(dest)) {
    const info = await describe(dest);
    const same = info.remote && canonicalUrl(parseRepo(info.remote)?.url ?? info.remote) === canonicalUrl(repo.url);
    if (info.isRepo && (same || !info.remote)) {
      // Bring it up to date without touching the working tree.
      await run("git", ["fetch", "--quiet", "--all"], { cwd: dest, timeout: 120_000 }).catch(() => {});
      return { ...info, reused: true };
    }
    throw new Error(`${dest} already exists and isn't a clone of ${repo.slug ?? repo.url}. Pick another folder.`);
  }
  // gh first when there is one (it signs in the way the person already did), and
  // plain git after it either way: a clone that gh couldn't do, because its
  // token or its install is the thing that is off, is often one git's own
  // stored login can.
  const gh = repo.slug ? await findGh() : null;
  const tries: [string, string[]][] = [];
  if (gh) tries.push([gh, ["repo", "clone", repo.slug!, dest]]);
  tries.push(["git", ["clone", "--", repo.url, dest]]);
  let why = "";
  let cloned = false;
  // The login Friday keeps, for a machine where neither gh nor git holds one of their own.
  const auth = await authEnv();
  for (const [cmd, args] of tries) {
    try {
      await run(cmd, args, { timeout: 600_000, env: auth });
      cloned = true;
      break;
    } catch (e) {
      why = why ? `${why} | ${(e as Error).message}` : (e as Error).message;
      // A half-made folder would be taken for an existing clone next time.
      await rm(dest, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (!cloned) throw new Error(cloneFailure(repo.slug ?? repo.url, why));
  return { ...(await describe(dest)), reused: false };
}

