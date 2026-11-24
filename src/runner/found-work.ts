/**
 * Work found for you, the runner's half (src/found-work.ts; Arun, 2026-11-21: "1. Speed baseline, Today with Tonight, and proof clips.").
 * The repos you've been working in (recentReposCached: the folders your coding tools last worked in first), each asked, read-only, with
 * the person's own logins:
 * - CI on the default branch, through their `gh` (`gh run list`), for a workflow broken or flaky there;
 * - `npm audit` where the repo has a package-lock.json, for a high or critical vulnerability with a safe fix;
 * - `git grep` for TODO and FIXME, and `git blame` on a few of them, for the ones they wrote weeks ago;
 * and once for all of them, the issues assigned to them (workspace.ts issues()), kept where a clone of the issue's repo is here.
 *
 * A look costs seconds (npm audit asks the registry), so each repo's answer is kept for an hour and a second ask while one is out waits
 * for it. Nothing here writes to a folder or starts anything.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { auditFindings, ciFindings, issueFinding, rankFound, readBlame, readGrep, todoFindings, type BlamedTodo, type CiRun, type FoundItem } from "../found-work.js";
import { gh } from "./git.js";
import { issues, parseRepo, recentReposCached } from "./workspace.js";

/** How many of the most recent repos are looked through. */
const REPOS = 6;
const KEEP_MS = 60 * 60_000;
const isWin = process.platform === "win32";

function run(cmd: string, args: string[], cwd: string, timeout = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    // npm is npm.cmd on Windows, which only a shell runs; its arguments here are fixed words, never a person's text.
    execFile(cmd, args, { cwd, timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true, shell: isWin && cmd === "npm" }, (err, stdout) => {
      // npm audit and git grep say what they found with a non-zero exit (vulnerabilities found, nothing matched): the output is the answer.
      if (err && !stdout) reject(err);
      else resolve(String(stdout));
    });
  });
}

async function defaultBranch(cwd: string): Promise<string> {
  const head = await run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd, 5000).catch(() => "");
  const b = head.trim().replace(/^origin\//, "");
  if (b) return b;
  for (const name of ["main", "master"]) if ((await run("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`], cwd, 5000).catch(() => "")).trim()) return name;
  return "main";
}

async function ci(cwd: string, repo: string): Promise<FoundItem[]> {
  const branch = await defaultBranch(cwd);
  const out = await gh(cwd, ["run", "list", "--branch", branch, "--limit", "40", "--json", "workflowName,conclusion,createdAt,url"]).catch(() => "[]");
  let runs: CiRun[] = [];
  try {
    runs = JSON.parse(out) as CiRun[];
  } catch {}
  return ciFindings(Array.isArray(runs) ? runs : [], { repo, folder: cwd, branch });
}

async function audit(cwd: string, repo: string): Promise<FoundItem[]> {
  if (!existsSync(path.join(cwd, "package-lock.json"))) return [];
  const out = await run("npm", ["audit", "--json", "--audit-level=high"], cwd, 45_000).catch(() => "");
  try {
    return auditFindings(JSON.parse(out), { repo, folder: cwd });
  } catch {
    return [];
  }
}

async function todos(cwd: string, repo: string): Promise<FoundItem[]> {
  // Who "you" are is whoever git would write as here: its own answer covers an email set in config and one it makes up from the machine.
  const me = (await run("git", ["var", "GIT_AUTHOR_IDENT"], cwd, 5000).catch(() => "")).match(/<([^>]+)>/)?.[1] ?? "";
  if (!me) return [];
  const hits = readGrep(await run("git", ["grep", "-n", "-I", "-w", "-E", "TODO|FIXME", "--", ".", ":(exclude)*.min.*", ":(exclude)**/vendor/**", ":(exclude)**/node_modules/**"], cwd, 10_000).catch(() => ""), 200);
  const blamed: BlamedTodo[] = [];
  // A blame a line is a git process each: the first 25 hits are enough to find a couple of old ones.
  for (const h of hits.slice(0, 25)) {
    const b = readBlame(await run("git", ["blame", "--line-porcelain", "-L", `${h.line},${h.line}`, "--", h.file], cwd, 5000).catch(() => ""));
    if (b) blamed.push({ ...h, ...b });
  }
  return todoFindings(blamed, { repo, folder: cwd, me });
}

const kept = new Map<string, { at: number; items: FoundItem[] }>();
const pending = new Map<string, Promise<FoundItem[]>>();

/** One repo's findings, from the last hour's look or a fresh one. */
function lookAt(cwd: string, repo: string, fresh: boolean): Promise<FoundItem[]> {
  const k = kept.get(cwd);
  if (!fresh && k && Date.now() - k.at < KEEP_MS) return Promise.resolve(k.items);
  const out = pending.get(cwd);
  if (out) return out;
  const p = Promise.all([ci(cwd, repo).catch(() => []), audit(cwd, repo).catch(() => []), todos(cwd, repo).catch(() => [])])
    .then((parts) => parts.flat())
    .then((items) => (kept.set(cwd, { at: Date.now(), items }), items))
    .finally(() => pending.delete(cwd));
  pending.set(cwd, p);
  return p;
}

export interface FoundWork {
  items: FoundItem[];
  /** The repos looked through, by name, for the line under the list. */
  looked: string[];
  at: number;
}

/** Work found across the recent repos, ranked, without the ones the page says it already queued or put away. */
export async function findWork(o: { skip?: string[]; fresh?: boolean } = {}): Promise<FoundWork> {
  const folders = (await recentReposCached().catch(() => [])).filter((f) => f.isRepo).slice(0, REPOS * 2);
  // Two clones of one repository (a worktree, a second checkout) are looked at once: the most recently used.
  const seen = new Set<string>();
  const named = folders.map((f) => ({ f, slug: (f.remote && parseRepo(f.remote)?.slug) || "" })).filter((n) => !seen.has((n.slug || n.f.path).toLowerCase()) && !!seen.add((n.slug || n.f.path).toLowerCase()));
  const [perRepo, mine] = await Promise.all([
    Promise.all(named.slice(0, REPOS).map(({ f, slug }) => lookAt(f.path, slug || f.name, !!o.fresh))),
    issues().catch(() => null),
  ]);
  const bySlug = new Map(named.filter((n) => n.slug).map((n) => [n.slug.toLowerCase(), n.f.path]));
  const issueItems = (mine?.available ? mine.assigned : [])
    .filter((i) => i.source === "github" && i.repo && i.number && bySlug.has(i.repo.toLowerCase()))
    .map((i) => issueFinding({ repo: i.repo!, number: i.number!, title: i.title, body: i.body ?? "", url: i.url, labels: i.labels.map((l) => l.name), updatedAt: i.updatedAt }, bySlug.get(i.repo!.toLowerCase())!));
  return { items: rankFound([...perRepo.flat(), ...issueItems], new Set(o.skip ?? [])), looked: named.slice(0, REPOS).map((n) => n.slug || n.f.name), at: Date.now() };
}
