import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BRANCH_NAME, checksState, partDetail, planRestack, planStack, restackHandoff, stackBody, stackBranches, type StackPart, type StackPlan } from "../stack-plan.js";
import { authEnv } from "./github.js";
import { githubSlug } from "./git.js";

/**
 * Stacked pull requests, carried out (Arun, 2026-11-19, wave 3: "Stacked PRs: split a big change into a stack of small PRs, each based
 * on the last, kept rebased for you."). The plan and the order of the steps are src/stack-plan.ts; this runs them with git and gh.
 *
 * The person's own checkout is never moved: no branch is switched, no file touched, nothing stashed. Each part is a commit built
 * from the folder's files in a temporary index (git's plumbing: read-tree, update-index, write-tree, commit-tree) on a new branch
 * named from theirs (`<branch>-1`, `-2`…), and a restack rebases in a temporary worktree. A stack is remembered in the repository's
 * own git folder (friday-stacks.json), which the IDE's Stack view reads.
 */

const QUICK_MS = 30_000;
const NET_MS = 120_000;
const ZERO = "0000000000000000000000000000000000000000";
const STATE = "friday-stacks.json";

/** What a failed git or gh call says, in the person's terms: the tool's own last lines. */
const tail = (s: string, n = 3) => s.trim().split("\n").filter(Boolean).slice(-n).join(" ");

function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1", LC_MESSAGES: "C", GIT_EDITOR: "true", ...extra };
  // LANGUAGE beats LC_MESSAGES: left set, the messages matched below could come back translated.
  delete env.LANGUAGE;
  return env;
}

interface GitOpts {
  env?: Record<string, string>;
  input?: string;
  timeout?: number;
  /** Exit codes that are answers, not failures. */
  ok?: number[];
}

/** One git call, never through a shell: stdout on success, an Error with git's own words on failure. */
function git(cwd: string, args: string[], o: GitOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, { cwd, timeout: o.timeout ?? QUICK_MS, maxBuffer: 64 * 1024 * 1024, env: gitEnv(o.env), windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
      if (typeof e.code === "number" && o.ok?.includes(e.code)) return resolve(stdout);
      if (e.code === "ENOENT") return reject(new Error("Git isn't installed on this computer."));
      if (e.killed) return reject(new Error(`git ${args[0]} took too long and was stopped.`));
      reject(Object.assign(new Error(tail(`${stderr}\n${stdout}`, 6) || e.message), { code: e.code }));
    });
    if (o.input !== undefined) child.stdin?.end(o.input);
  });
}

const sh = (cwd: string, args: string[], o?: GitOpts) => git(cwd, args, o).then((s) => s.trim());
const yes = (cwd: string, args: string[]) => git(cwd, args).then(() => true, () => false);

interface Gh {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** gh isn't installed here. */
  missing?: boolean;
}

/** When gh last answered "not installed" or "not signed in": the Stack view asks gh once per part every minute, so it is left alone for a few minutes after that. */
let ghDownUntil = 0;
const GH_DOWN_MS = 5 * 60_000;

/** One gh call with the login this computer already has; never a prompt. Never rejects: what it said is the answer. */
async function gh(cwd: string, args: string[], timeout = 60_000): Promise<Gh> {
  const auth = await authEnv();
  return new Promise((resolve) => {
    execFile("gh", args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...auth, GH_PROMPT_DISABLED: "1" }, windowsHide: true }, (err, stdout, stderr) => {
      const missing = !!err && (err as NodeJS.ErrnoException).code === "ENOENT";
      if (missing || (err && /not logged in|gh auth login/i.test(String(stderr)))) ghDownUntil = Date.now() + GH_DOWN_MS;
      else if (!err) ghDownUntil = 0;
      resolve({ ok: !err, stdout: String(stdout), stderr: missing ? "the GitHub CLI (gh) isn't installed on this machine" : tail(String(stderr)) || (err ? err.message : ""), ...(missing ? { missing } : {}) });
    });
  });
}

/** A folder the page names: absolute and there. */
async function checkRoot(root: unknown): Promise<string> {
  if (typeof root !== "string" || !root || !path.isAbsolute(root)) throw new Error("The folder must be an absolute path.");
  const st = await lstat(root).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`The folder ${root} doesn't exist.`);
  return path.resolve(root);
}

interface Repo {
  /** The repository's top folder: every git call here runs in it, so every path is from it. */
  top: string;
  /** Where the folder the IDE has open sits inside the top ("" at the top, "pkg/" below it). */
  prefix: string;
  /** The folder holding what every worktree shares: the stacks are kept here. */
  common: string;
  gitDir: string;
}

async function repoOf(root: string): Promise<Repo> {
  const out = await git(root, ["rev-parse", "--show-toplevel", "--show-prefix", "--git-dir", "--git-common-dir"]).catch(() => "");
  const [top, prefix = "", gitDir, common] = out.split("\n");
  if (!top || !gitDir || !common) throw new Error("This folder isn't a git repository, so there's nothing to stack.");
  return { top, prefix: prefix.trim(), gitDir: path.resolve(root, gitDir), common: path.resolve(root, common) };
}

interface Base {
  /** The branch the first pull request merges into: "main". */
  name: string;
  /** What to compare with: origin's copy when there is one, else the local branch. */
  ref: string;
}

/** The base branch: the remote's default branch, as origin sees it, else main or master. */
async function baseOf(top: string, want?: string): Promise<Base> {
  const has = (ref: string) => yes(top, ["rev-parse", "--verify", "-q", ref]);
  let name = want && BRANCH_NAME.test(want) ? want : "";
  if (!name) name = (await sh(top, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]).catch(() => "")).replace(/^origin\//, "");
  if (!name) for (const b of ["main", "master"]) if ((await has(`refs/remotes/origin/${b}`)) || (await has(`refs/heads/${b}`))) { name = b; break; }
  if (!name) throw new Error("Couldn't tell which branch the stack builds on (no main or master here). Name it in the proposal's first line and try again.");
  const ref = (await has(`refs/remotes/origin/${name}`)) ? `origin/${name}` : (await has(`refs/heads/${name}`)) ? name : "";
  if (!ref) throw new Error(`The branch ${name} isn't in this repository.`);
  return { name, ref };
}

/** Where the stack starts: the newest commit the folder's branch and the base branch share. */
async function startOf(top: string, base: Base): Promise<string> {
  const mb = await sh(top, ["merge-base", "HEAD", base.ref]).catch(() => "");
  if (mb) return mb;
  return sh(top, ["rev-parse", "--verify", "HEAD^{commit}"]).catch(() => {
    throw new Error("This repository has no commits yet, so there's nothing to stack on.");
  });
}

/** The files the folder has changed since `start`, from the top: edited, added and deleted, and new files git doesn't ignore. */
async function changedSince(top: string, start: string): Promise<Set<string>> {
  const [tracked, fresh] = await Promise.all([git(top, ["diff", "--name-only", "-z", "--no-renames", start]), git(top, ["ls-files", "--others", "--exclude-standard", "-z"])]);
  return new Set([...tracked.split("\0"), ...fresh.split("\0")].filter(Boolean));
}

export interface Cleaned {
  parts: StackPart[];
  /** Files the proposal names that the folder hasn't changed. */
  skipped: string[];
  /** Changed files the proposal left out: they go in the last part. */
  left: string[];
}

/** The proposal held to what the folder really changed: paths from the top, nothing the folder didn't change, nothing left out. */
export function cleanPlan(plan: StackPlan, changed: ReadonlySet<string>, prefix: string): Cleaned {
  const skipped: string[] = [];
  const used = new Set<string>();
  const parts: StackPart[] = [];
  for (const p of plan.parts) {
    const files: string[] = [];
    for (const f of p.files) {
      // The agent names paths from the repository's top; one named from the open folder is found under its prefix.
      const at = changed.has(f) ? f : prefix && changed.has(prefix + f) ? prefix + f : "";
      if (!at) skipped.push(f);
      else if (!used.has(at)) {
        used.add(at);
        files.push(at);
      }
    }
    if (files.length) parts.push({ ...p, files });
  }
  const left = [...changed].filter((f) => !used.has(f)).sort();
  if (parts.length && left.length) parts[parts.length - 1] = { ...parts[parts.length - 1]!, files: [...parts[parts.length - 1]!.files, ...left] };
  return { parts, skipped, left };
}

function asPlan(v: unknown): StackPlan {
  const parts = (v && typeof v === "object" ? (v as { parts?: unknown }).parts : null) as unknown;
  if (!Array.isArray(parts) || !parts.length || parts.length > 12) throw new Error("There is no proposal to make a stack from.");
  const out: StackPart[] = [];
  for (const x of parts) {
    const o = (x ?? {}) as Record<string, unknown>;
    const files = (Array.isArray(o.files) ? o.files : []).filter((f): f is string => typeof f === "string" && !!f && !f.startsWith("-") && !f.includes("\0") && !f.split(/[\\/]/).includes(".."));
    if (!files.length) continue;
    out.push({ title: typeof o.title === "string" && o.title.trim() ? o.title.trim().slice(0, 120) : `Part ${out.length + 1}`, why: typeof o.why === "string" ? o.why.slice(0, 400) : "", files: files.slice(0, 500) });
  }
  if (!out.length) throw new Error("There is no proposal to make a stack from.");
  return { parts: out };
}

async function localBranches(top: string): Promise<string[]> {
  return (await sh(top, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).split("\n").filter(Boolean);
}

export interface Preview {
  /** The folder's branch, "" when it is on no branch. */
  branch: string;
  base: string;
  prefix: string;
  names: string[];
  parts: StackPart[];
  skipped: string[];
  left: string[];
  /** There is an origin to push to, and which GitHub repository it is. */
  remote: boolean;
  github: string | null;
  /** gh is here and signed in: the pull requests are opened by it; when not, why, and the branches come with GitHub's own link. */
  gh: { ok: boolean; why: string };
}

/** Which GitHub repository origin is: every gh call names it, since in a fork gh's own default is the upstream, where the part branches aren't. */
async function slugOf(top: string): Promise<string | null> {
  const url = await sh(top, ["remote", "get-url", "origin"]).catch(() => "");
  return url ? githubSlug(url) : null;
}
const repoArgs = (slug: string | null) => (slug ? ["--repo", slug] : []);

async function ghReady(cwd: string): Promise<{ ok: boolean; why: string }> {
  const r = await gh(cwd, ["auth", "status"], 15_000);
  return r.ok ? { ok: true, why: "" } : { ok: false, why: r.missing ? r.stderr : "the GitHub CLI (gh) isn't signed in on this machine" };
}

/** What making the stack would do, said before anyone presses the button: the names, the base, what is left out, whether gh can open the pull requests. */
export async function preview(p: { root: string; plan: unknown; base?: string }): Promise<Preview> {
  const repo = await repoOf(await checkRoot(p.root));
  const plan = asPlan(p.plan);
  const base = await baseOf(repo.top, p.base);
  const start = await startOf(repo.top, base);
  const cleaned = cleanPlan(plan, await changedSince(repo.top, start), repo.prefix);
  const current = await sh(repo.top, ["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => "");
  const { prefix, names } = stackBranches(current, base.name, cleaned.parts[0]?.title ?? "", cleaned.parts.length, await localBranches(repo.top));
  const remoteUrl = await sh(repo.top, ["remote", "get-url", "origin"]).catch(() => "");
  return { branch: current, base: base.name, prefix, names, ...cleaned, remote: !!remoteUrl, github: remoteUrl ? githubSlug(remoteUrl) : null, gh: await ghReady(repo.top) };
}

// ── the record of a stack ───────────────────────────────────────────────────

interface PartRec {
  branch: string;
  title: string;
  why?: string;
  url?: string;
  number?: number;
  /** The commit this part was last built on: the tip of the part below (or the start) when it was made or restacked. */
  onto: string;
  /** The branch its pull request merges into, as last set. */
  baseName: string;
  /** The tip Friday last pushed or saw on the remote: what a restack's push is leased against, so a commit someone else pushed is never overwritten. */
  pushed?: string;
}
interface StackRec {
  id: string;
  base: string;
  at: number;
  parts: PartRec[];
}

async function readStacks(repo: Repo): Promise<StackRec[]> {
  try {
    const raw = JSON.parse(await readFile(path.join(repo.common, STATE), "utf8")) as { stacks?: StackRec[] };
    return (Array.isArray(raw.stacks) ? raw.stacks : [])
      .filter((s) => s && typeof s.id === "string" && Array.isArray(s.parts) && s.parts.length)
      // The file is the repository's, which a pull can change: only names git accepts ever reach a git command.
      .filter((s) => s.parts.every((x) => x && typeof x.branch === "string" && BRANCH_NAME.test(x.branch) && typeof x.onto === "string" && /^[0-9a-f]{40}$/.test(x.onto) && (x.pushed === undefined || /^[0-9a-f]{40}$/.test(String(x.pushed)))))
      .map((s) => ({ ...s, base: BRANCH_NAME.test(String(s.base)) ? s.base : "main" }));
  } catch {
    return [];
  }
}

async function writeStacks(repo: Repo, stacks: StackRec[]): Promise<void> {
  await mkdir(repo.common, { recursive: true });
  const tmp = path.join(repo.common, `${STATE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(tmp, JSON.stringify({ stacks }, null, 2));
  await rename(tmp, path.join(repo.common, STATE));
}

/** One stack's record saved: replaced when it is there already (by id), else added. */
async function saveStack(repo: Repo, rec: StackRec): Promise<void> {
  const all = await readStacks(repo);
  const i = all.findIndex((s) => s.id === rec.id);
  if (i >= 0) all[i] = rec;
  else all.push(rec);
  await writeStacks(repo, all);
}

/** One stack at a time per repository: a second press while the first runs is told so, not run on top of it. */
const busy = new Set<string>();
async function exclusive<T>(repo: Repo, what: string, f: () => Promise<T>): Promise<T> {
  if (busy.has(repo.common)) throw new Error(`A stack is already being ${what} in this repository. Wait for it to finish.`);
  busy.add(repo.common);
  try {
    return await f();
  } finally {
    busy.delete(repo.common);
  }
}

/** Stacks none of whose branches exist any more are forgotten. Only under the lock, from a fresh read. */
async function prune(repo: Repo): Promise<void> {
  const all = await readStacks(repo);
  const keep: StackRec[] = [];
  for (const rec of all) {
    const here = await Promise.all(rec.parts.map((x) => yes(repo.top, ["rev-parse", "--verify", "-q", `refs/heads/${x.branch}`])));
    if (here.some(Boolean)) keep.push(rec);
  }
  if (keep.length !== all.length) await writeStacks(repo, keep).catch(() => {});
}

// ── making a stack ──────────────────────────────────────────────────────────

/**
 * One part's commit, built without touching the checkout: its files as they are in the folder, on top of the tree below. A file the
 * folder no longer has is removed in it. Returns the commit's hash.
 */
async function commitPart(repo: Repo, parent: string, files: string[], message: string): Promise<string> {
  const idx = path.join(repo.gitDir, `friday-stack-${randomBytes(6).toString("hex")}.idx`);
  const env = { GIT_INDEX_FILE: idx };
  try {
    await git(repo.top, ["read-tree", parent], { env });
    // The mode is the file's own, as `git add` takes it (the executable bit); on Windows, or where core.fileMode is off, the mode
    // the index already has stays, and a new file is plain.
    const modes = new Map<string, string>();
    const names = files.map((f) => f.replace(/\/+$/, ""));
    const known = await git(repo.top, ["ls-files", "-s", "-z", "--", ...names], { env });
    for (const row of known.split("\0").filter(Boolean)) {
      const m = /^(\d+) [0-9a-f]+ \d\t([\s\S]+)$/.exec(row);
      if (m) modes.set(m[2]!, m[1]!);
    }
    const trustBits = process.platform !== "win32" && (await sh(repo.top, ["config", "--type=bool", "core.fileMode"]).catch(() => "true")) !== "false";
    let info = "";
    for (const f of files) {
      const name = f.replace(/\/+$/, "");
      const abs = path.join(repo.top, ...name.split("/"));
      const st = await lstat(abs).catch(() => null);
      if (st?.isDirectory()) {
        // A folder is a submodule (or a nested repository `git add` would record as one): its pointer moves to the commit it is on.
        // Never a removal: the folder is there.
        const head = await sh(abs, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]).catch(() => "");
        if (/^[0-9a-f]{40}$/.test(head) && (await yes(abs, ["rev-parse", "--git-dir"]))) info += `160000 ${head}\t${name}\0`;
        continue;
      }
      if (!st) {
        info += `0 ${ZERO}\t${name}\0`;
        continue;
      }
      let sha: string;
      let mode = trustBits ? (st.mode & 0o111 ? "100755" : "100644") : (modes.get(name) ?? "100644");
      if (st.isSymbolicLink()) {
        sha = await sh(repo.top, ["hash-object", "-w", "--stdin"], { input: await readlink(abs) });
        mode = "120000";
      } else {
        // --path: the file goes in as it would by `git add` (line endings and filters of the repository's own settings).
        sha = await sh(repo.top, ["hash-object", "-w", `--path=${name}`, "--", abs]);
      }
      info += `${mode} ${sha}\t${name}\0`;
    }
    await git(repo.top, ["update-index", "-z", "--index-info"], { env, input: info });
    const tree = await sh(repo.top, ["write-tree"], { env });
    // commit-tree skips commit.gpgsign: a repository that asks for signed commits gets them.
    const sign = (await sh(repo.top, ["config", "--type=bool", "commit.gpgsign"]).catch(() => "false")) === "true";
    return await sh(repo.top, ["commit-tree", tree, "-p", parent, ...(sign ? ["-S"] : []), "-m", message]);
  } catch (e) {
    const m = (e as Error).message;
    if (/tell me who you are|user\.email|identity unknown/i.test(m)) throw new Error("git doesn't know who you are on this machine. Run `git config --global user.name` and `user.email` there once, then try again.");
    throw e;
  } finally {
    await rm(idx, { force: true }).catch(() => {});
  }
}

export interface MadePart {
  branch: string;
  title: string;
  url?: string;
  number?: number;
  /** The pull request was opened here; false when only GitHub's page for opening it is given. */
  created: boolean;
  /** Why it wasn't opened here, in gh's words. */
  error?: string;
}
export interface Made {
  ok: true;
  base: string;
  parts: MadePart[];
  notes: string[];
}

/** What opening the pull requests came to, for one part. */
interface Opened {
  created: boolean;
  url?: string;
  number?: number;
  error?: string;
}

/**
 * Open the pull request of every part that is pushed, open and has none yet, bottom first (each one's base branch is on the remote
 * by then), then write every description again with the links. Resumable: a part whose `gh pr create` failed once, or whose push
 * came late, is picked up by the next call (the next restack) with the same arguments, from the title and why kept in the record.
 * `skip` names parts to leave alone (merged). Returns what each part has now.
 */
async function openPullRequests(repo: Repo, rec: StackRec, skip: ReadonlySet<string>, notes: string[]): Promise<Opened[]> {
  const slug = await slugOf(repo.top);
  const ready = await ghReady(repo.top);
  const plan: StackPlan = { parts: rec.parts.map((x) => ({ title: x.title, why: x.why ?? "", files: [] })) };
  const out: Opened[] = rec.parts.map((x) => (x.number ? { created: true, url: x.url, number: x.number } : { created: false }));
  let opened = 0;
  for (let i = 0; i < rec.parts.length; i++) {
    const x = rec.parts[i]!;
    if (x.number || skip.has(x.branch)) continue;
    if (!(await yes(repo.top, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${x.branch}`]))) continue;
    const dir = await mkdtemp(path.join(tmpdir(), "friday-stack-"));
    const file = path.join(dir, "body.md");
    try {
      await writeFile(file, stackBody(i, plan, [], rec.base));
      const r = ready.ok ? await gh(repo.top, ["pr", "create", ...repoArgs(slug), "--head", x.branch, "--base", x.baseName, "--title", x.title.slice(0, 250), "--body-file", file]) : null;
      const url = r ? `${r.stdout}\n${r.stderr}`.match(/https:\/\/\S+\/pull\/\d+/)?.[0] : undefined;
      if (url) {
        const num = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
        x.url = url;
        if (num) x.number = num;
        out[i] = { created: true, url, ...(num ? { number: num } : {}) };
        opened++;
      } else {
        out[i] = { created: false, error: r ? r.stderr || "gh didn't say why" : ready.why, ...(slug ? { url: `https://github.com/${slug}/compare/${encodeURIComponent(x.baseName)}...${encodeURIComponent(x.branch)}?expand=1` } : {}) };
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  // Every description again, with the links to the others, when anything new was opened.
  if (opened) {
    const urls = out.map((x) => (x.created ? x.url : undefined));
    for (let i = 0; i < rec.parts.length; i++) {
      const x = rec.parts[i]!;
      if (!out[i]!.created || !x.url || skip.has(x.branch)) continue;
      const dir = await mkdtemp(path.join(tmpdir(), "friday-stack-"));
      try {
        await writeFile(path.join(dir, "body.md"), stackBody(i, plan, urls, rec.base));
        const r = await gh(repo.top, ["pr", "edit", x.url, "--body-file", path.join(dir, "body.md")]);
        if (!r.ok) notes.push(`Part ${i + 1}'s description couldn't be updated with the links: ${r.stderr}`);
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
  return out;
}

/**
 * Make the stack. The branches are built first and only on this computer (a failure there leaves nothing behind), then pushed, then
 * the pull requests opened and described. Where gh can't open them, each branch still comes with GitHub's own page for opening its
 * pull request, as a single publish does.
 */
export async function make(p: { root: string; plan: unknown; base?: string }): Promise<Made> {
  const repo = await repoOf(await checkRoot(p.root));
  return exclusive(repo, "made", async () => {
    await prune(repo);
    const plan0 = asPlan(p.plan);
    const base = await baseOf(repo.top, p.base);
    const start = await startOf(repo.top, base);
    const cleaned = cleanPlan(plan0, await changedSince(repo.top, start), repo.prefix);
    if (cleaned.parts.length < 2) throw new Error(cleaned.parts.length ? "Only one part has changes in the folder, and a stack needs two. Split it differently, or open a single pull request." : "None of the files in that proposal have changed in this folder.");
    const remote = await sh(repo.top, ["remote", "get-url", "origin"]).catch(() => "");
    if (!remote) throw new Error("This repository has no remote called origin to push to.");
    const plan: StackPlan = { parts: cleaned.parts };
    const current = await sh(repo.top, ["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => "");
    const { names } = stackBranches(current, base.name, plan.parts[0]!.title, plan.parts.length, await localBranches(repo.top));
    const steps = planStack(plan, names, base.name);
    const notes: string[] = [];
    if (cleaned.left.length) notes.push(`${cleaned.left.length} changed file${cleaned.left.length === 1 ? " was" : "s were"} not in the proposal, so ${cleaned.left.length === 1 ? "it is" : "they are"} in the last part.`);
    if (cleaned.skipped.length) notes.push(`${cleaned.skipped.length} file${cleaned.skipped.length === 1 ? "" : "s"} in the proposal ${cleaned.skipped.length === 1 ? "has" : "have"} no changes in the folder and ${cleaned.skipped.length === 1 ? "was" : "were"} left out.`);

    // 1. The branches, here only.
    const tips = new Map<string, string>();
    const rec: StackRec = { id: names[0]!, base: base.name, at: Date.now(), parts: [] };
    const made: string[] = [];
    const rollback = async () => {
      for (const b of made) await git(repo.top, ["update-ref", "-d", `refs/heads/${b}`]).catch(() => {});
    };
    try {
      for (const s of steps) {
        if (s.kind !== "commit") continue;
        const parent = s.below ? tips.get(s.below)! : start;
        const sha = await commitPart(repo, parent, s.files, s.message);
        // A branch of that name made in the meantime is not overwritten.
        await git(repo.top, ["update-ref", `refs/heads/${s.branch}`, sha, ZERO]);
        made.push(s.branch);
        tips.set(s.branch, sha);
        rec.parts.push({ branch: s.branch, title: plan.parts[s.part - 1]!.title, why: plan.parts[s.part - 1]!.why, onto: parent, baseName: s.below ?? base.name });
      }
    } catch (e) {
      await rollback();
      throw e;
    }
    await saveStack(repo, rec);

    // 2. Pushed, bottom first. A refusal on the first leaves nothing behind; later, what is pushed stays, the record keeps it, and
    // Restack (the card's "Finish the stack") pushes the rest and opens the pull requests.
    const auth = await authEnv();
    let pushed = 0;
    for (const s of steps) {
      if (s.kind !== "push") continue;
      try {
        await git(repo.top, ["push", "--set-upstream", "origin", `refs/heads/${s.branch}:refs/heads/${s.branch}`], { env: { GCM_INTERACTIVE: "never", ...auth }, timeout: NET_MS });
        pushed++;
        rec.parts.find((x) => x.branch === s.branch)!.pushed = tips.get(s.branch);
      } catch (e) {
        const m = (e as Error).message;
        const why = /could not read (Username|Password)|Authentication failed|terminal prompts disabled|permission denied/i.test(m) ? "git couldn't sign in to the remote from this machine. Push once from a terminal there so it remembers the login, then try again." : m;
        if (!pushed) {
          await rollback();
          await writeStacks(repo, (await readStacks(repo)).filter((x) => x.id !== rec.id));
          throw new Error(why);
        }
        await saveStack(repo, rec);
        throw new Error(`Pushed ${pushed} of ${plan.parts.length} parts, then: ${why} The stack is kept: fix that and press Finish the stack (or Restack in the Stack view) to push the rest and open the pull requests.`);
      }
    }

    // 3. The pull requests and their links.
    const opened = await openPullRequests(repo, rec, new Set(), notes);
    const out: MadePart[] = plan.parts.map((x, i) => ({ branch: names[i]!, title: x.title, ...opened[i]! }));
    await saveStack(repo, rec);
    if (current) notes.push(`Your own branch, ${current}, and your files are as they were.`);
    else notes.push("Your files are as they were.");
    return { ok: true as const, base: base.name, parts: out, notes };
  });
}

// ── the stack's standing ────────────────────────────────────────────────────

export interface PartStatus {
  branch: string;
  title: string;
  url: string;
  pr: number | null;
  state: "open" | "merged" | "closed" | "unknown";
  checks: "pass" | "fail" | "pending" | "none" | "unknown";
  /** Commits it has that the part below doesn't, and the other way round: "behind" means the part below changed and it wants a restack. */
  ahead: number;
  behind: number;
  head: string;
  pushed: boolean;
  /** It is the branch checked out in the person's folder. */
  current: boolean;
  /** The line the Stack view says beside it ("#12 · checks passing · 2 behind"). */
  detail: string;
}
export interface StackStatus {
  id: string;
  base: string;
  parts: PartStatus[];
}

interface PrInfo {
  number: number;
  state: PartStatus["state"];
  url: string;
  checks: PartStatus["checks"];
  baseRef: string;
}

/** A part's pull request as gh sees it (by its link, else its branch); null when gh can't say. */
async function prInfo(repo: Repo, p: PartRec, slug: string | null): Promise<PrInfo | null> {
  // gh missing or signed out a moment ago: not asked again for every part on every refresh.
  if (Date.now() < ghDownUntil) return null;
  const byUrl = !!p.url && /\/pull\/\d+/.test(p.url);
  const r = await gh(repo.top, ["pr", "view", byUrl ? p.url! : p.branch, ...(byUrl ? [] : repoArgs(slug)), "--json", "number,state,url,statusCheckRollup,baseRefName"], 20_000);
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.stdout) as { number?: number; state?: string; url?: string; statusCheckRollup?: unknown; baseRefName?: string };
    const st = String(j.state || "").toUpperCase();
    return { number: Number(j.number) || 0, state: st === "MERGED" ? "merged" : st === "CLOSED" ? "closed" : st === "OPEN" ? "open" : "unknown", url: String(j.url || ""), checks: checksState(j.statusCheckRollup), baseRef: String(j.baseRefName || "") };
  } catch {
    return null;
  }
}

/** The branches checked out in some folder, and which folder. */
async function worktreeBranches(top: string): Promise<Map<string, string>> {
  const out = await git(top, ["worktree", "list", "--porcelain"]).catch(() => "");
  const map = new Map<string, string>();
  for (const block of out.split(/\n\n+/)) {
    const dir = /^worktree (.+)$/m.exec(block)?.[1];
    const br = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (dir && br) map.set(br, dir);
  }
  return map;
}

/** Every stack this repository has, with where each part stands: its pull request, its checks, how far it is from the part below. */
export async function status(p: { root: string }): Promise<{ stacks: StackStatus[]; base: string }> {
  const repo = await repoOf(await checkRoot(p.root));
  const all = await readStacks(repo);
  const base = await baseOf(repo.top).catch(() => null);
  const current = await sh(repo.top, ["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => "");
  const slug = await slugOf(repo.top);
  const stacks: StackStatus[] = [];
  for (const rec of all) {
    // A part whose branch is gone (deleted after its merge) is no longer one; a stack with none left is forgotten.
    const here = (await Promise.all(rec.parts.map((x) => yes(repo.top, ["rev-parse", "--verify", "-q", `refs/heads/${x.branch}`])))).map(Boolean);
    const parts = rec.parts.filter((_, i) => here[i]);
    if (!parts.length) continue;
    const infos = await Promise.all(parts.map((x) => prInfo(repo, x, slug)));
    const baseRef = rec.base === base?.name ? base.ref : (await yes(repo.top, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${rec.base}`])) ? `origin/${rec.base}` : rec.base;
    const rows: PartStatus[] = [];
    let below = baseRef;
    for (let i = 0; i < parts.length; i++) {
      const x = parts[i]!;
      const info = infos[i];
      const [counts, head, pushed] = await Promise.all([
        sh(repo.top, ["rev-list", "--left-right", "--count", `${below}...refs/heads/${x.branch}`]).catch(() => "0\t0"),
        sh(repo.top, ["rev-parse", "--short", `refs/heads/${x.branch}`]).catch(() => ""),
        yes(repo.top, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${x.branch}`]),
      ]);
      const [behind = 0, ahead = 0] = counts.split(/\s+/).map(Number);
      const merged = info?.state === "merged";
      const row = {
        branch: x.branch,
        title: x.title,
        url: info?.url || x.url || "",
        pr: info?.number || x.number || null,
        state: info?.state ?? (x.number ? ("open" as const) : ("unknown" as const)),
        checks: info ? info.checks : ("unknown" as const),
        ahead,
        behind,
        head,
        pushed,
        current: x.branch === current,
      };
      rows.push({ ...row, detail: partDetail(row) });
      if (!merged) below = `refs/heads/${x.branch}`;
    }
    stacks.push({ id: rec.id, base: rec.base, parts: rows });
  }
  // Stacks with no branch left are forgotten by make and restack (under the lock), not here: this runs every minute beside them.
  return { stacks, base: base?.name ?? "" };
}

// ── restacking ──────────────────────────────────────────────────────────────

export interface RestackConflict {
  part: number;
  total: number;
  branch: string;
  onto: string;
  files: string[];
  /** What to hand the agent. */
  handoff: string;
}
export interface Restacked {
  ok: boolean;
  base: string;
  /** What each part came to: "rebased", "up to date", "merged" (left out). */
  parts: { branch: string; did: "rebased" | "current" | "merged"; pushed: boolean; title?: string; url?: string; number?: number }[];
  conflict?: RestackConflict;
  /** Something other than a conflict stopped it. */
  error?: string;
  notes: string[];
}

/** Rebase one branch onto a commit, in a worktree of its own: the branch moves only when the rebase succeeded whole. A conflict leaves everything as it was. */
async function rebaseBranch(repo: Repo, branch: string, upstream: string, onto: string): Promise<{ ok: true } | { ok: false; files: string[]; error?: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-restack-"));
  const wt = path.join(dir, "wt");
  const tip = await sh(repo.top, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
  try {
    // A worktree that can't be made is a plain error (thrown), never a conflict.
    await git(repo.top, ["worktree", "add", "--detach", wt, tip]);
    try {
      await git(wt, ["-c", "rebase.autoStash=false", "rebase", "--onto", onto, upstream], { timeout: 5 * 60_000 });
    } catch (e) {
      const files = (await git(wt, ["diff", "--name-only", "--diff-filter=U", "-z"]).catch(() => "")).split("\0").filter(Boolean);
      await git(wt, ["rebase", "--abort"]).catch(() => {});
      // A conflict only when git stopped on unmerged paths; anything else (a hook, no identity, a timeout) is said in git's words.
      if (files.length) return { ok: false, files };
      return { ok: false, files: [], error: (e as Error).message };
    }
    const next = await sh(wt, ["rev-parse", "HEAD"]);
    // Moved only if nobody moved it meanwhile.
    await git(repo.top, ["update-ref", `refs/heads/${branch}`, next, tip]);
    return { ok: true };
  } finally {
    await git(repo.top, ["worktree", "remove", "--force", wt]).catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    await git(repo.top, ["worktree", "prune"]).catch(() => {});
  }
}

/**
 * Restack: the bottom of a stack changed (a review fix, a merge into the base branch), so each part above is rebased onto the one
 * below it, bottom first, and force-pushed (with a lease) and its pull request's base follows. A part that merged drops out. On a
 * conflict it stops where it is, changes nothing on that part, and answers with what the agent needs to take it from there.
 */
export async function restack(p: { root: string; id?: string }): Promise<Restacked> {
  const repo = await repoOf(await checkRoot(p.root));
  return exclusive(repo, "restacked", async () => {
    await prune(repo);
    const stacks = (await readStacks(repo)).filter((s) => !p.id || s.id === p.id);
    if (!stacks.length) throw new Error("There is no stack here to restack.");
    const auth = await authEnv();
    // What the remote has now: the base branch may have moved, and a reviewer may have pushed to a part. Not having it (offline)
    // restacks on what is here.
    await git(repo.top, ["fetch", "--quiet", "origin"], { env: { GCM_INTERACTIVE: "never", ...auth }, timeout: NET_MS }).catch(() => {});
    const slug = await slugOf(repo.top);
    const checkedOut = await worktreeBranches(repo.top);
    const result: Restacked = { ok: true, base: stacks[0]!.base, parts: [], notes: [] };
    const stop = (error: string) => {
      result.ok = false;
      result.error = error;
      return result;
    };
    for (const rec of stacks) {
      const base = await baseOf(repo.top, rec.base);
      const here = (await Promise.all(rec.parts.map((x) => yes(repo.top, ["rev-parse", "--verify", "-q", `refs/heads/${x.branch}`])))).map(Boolean);
      const parts = rec.parts.filter((_, i) => here[i]);
      const infos = await Promise.all(parts.map((x) => prInfo(repo, x, slug)));
      const states = await Promise.all(
        parts.map(async (x, i) => {
          // A part whose branch is inside the base branch is merged, whatever gh says (or can't).
          const inside = await yes(repo.top, ["merge-base", "--is-ancestor", `refs/heads/${x.branch}`, base.ref]);
          return { branch: x.branch, state: infos[i]?.state === "merged" || inside ? ("merged" as const) : (infos[i]?.state ?? ("unknown" as const)) };
        }),
      );
      const steps = planRestack(states, base.name);
      const ref = (name: string) => (name === base.name ? base.ref : `refs/heads/${name}`);
      const save = () => saveStack(repo, rec);
      for (const s of steps) {
        const rec1 = parts[s.part - 1]!;
        if (s.kind === "skip") {
          result.parts.push({ branch: s.branch, did: "merged", pushed: false });
          continue;
        }
        const inFolder = checkedOut.get(s.branch);
        let tipSha = await sh(repo.top, ["rev-parse", `refs/heads/${s.branch}`]);
        // What GitHub has on this branch that Friday didn't put there (a suggestion committed in review, "Update branch", a teammate's
        // push) is never thrown away: a remote that is ahead is taken in first, and one that has gone its own way stops the restack.
        const remoteTip = await sh(repo.top, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${s.branch}^{commit}`]).catch(() => "");
        if (remoteTip && remoteTip !== tipSha) {
          if (await yes(repo.top, ["merge-base", "--is-ancestor", tipSha, remoteTip])) {
            if (inFolder) return stop(`${s.branch} (part ${s.part}) has commits on GitHub that this computer doesn't, and it is checked out in ${inFolder}. Pull them there, or switch that folder to another branch, then press Restack again.`);
            await git(repo.top, ["update-ref", `refs/heads/${s.branch}`, remoteTip, tipSha]);
            tipSha = remoteTip;
            result.notes.push(`Part ${s.part} (${s.branch}) had commits pushed to GitHub: they are kept.`);
          } else if (!(await yes(repo.top, ["merge-base", "--is-ancestor", remoteTip, tipSha])) && remoteTip !== rec1.pushed) {
            return stop(`Part ${s.part} (${s.branch}) has commits on GitHub that aren't here, and commits here that aren't on GitHub. Nothing was changed. Bring them together first (pull ${s.branch} where it is checked out, or ask the agent), then press Restack again.`);
          }
        }
        const ontoSha = await sh(repo.top, ["rev-parse", "--verify", `${ref(s.onto)}^{commit}`]);
        // Already on top of the part below (an agent rebased it there, a fix was committed on it, or nothing changed below): nothing to rebase.
        const sits = await yes(repo.top, ["merge-base", "--is-ancestor", ontoSha, tipSha]);
        // Where it sat: the recorded commit when the branch still has it below it, else where it last met the branch below.
        let from = rec1.onto;
        if (!sits && !(await yes(repo.top, ["merge-base", "--is-ancestor", from, tipSha]))) from = await sh(repo.top, ["merge-base", tipSha, ontoSha]).catch(() => "");
        let did: "rebased" | "current" = "current";
        if (!sits) {
          // Only a part that has to move is refused for being checked out; one that sits is just pushed.
          if (inFolder) return stop(`${s.branch} is checked out in ${inFolder} (part ${s.part}), and a restack would move it under you. Switch that folder to another branch first, then press Restack again.`);
          if (!from) return stop(`Couldn't tell where part ${s.part} (${s.branch}) sat in the stack, so it was left as it is.`);
          const r = await rebaseBranch(repo, s.branch, from, ontoSha);
          if (!r.ok) {
            if (r.error !== undefined) return stop(`Part ${s.part} (${s.branch}) couldn't be rebased onto ${s.onto}: ${r.error}`);
            result.ok = false;
            result.conflict = { part: s.part, total: parts.length, branch: s.branch, onto: s.onto, files: r.files.slice(0, 20), handoff: restackHandoff({ part: s.part, total: parts.length, branch: s.branch, onto: s.onto, ontoRef: ref(s.onto), files: r.files.slice(0, 20), recorded: from }) };
            return result;
          }
          did = "rebased";
        }
        rec1.onto = ontoSha;
        // The branch below is only ever in the chain by its own tip: a later part is rebased onto what this one is now.
        let pushedNow = false;
        const newTip = await sh(repo.top, ["rev-parse", `refs/heads/${s.branch}`]);
        if (newTip !== remoteTip) {
          try {
            // Leased on what was checked above: a push that landed since the fetch is refused, not overwritten. A branch the remote
            // doesn't have yet is plain-pushed.
            const lease = remoteTip ? [`--force-with-lease=refs/heads/${s.branch}:${remoteTip}`] : [];
            await git(repo.top, ["push", "--set-upstream", ...lease, "origin", `refs/heads/${s.branch}:refs/heads/${s.branch}`], { env: { GCM_INTERACTIVE: "never", ...auth }, timeout: NET_MS });
            pushedNow = true;
            rec1.pushed = newTip;
          } catch (e) {
            await save();
            return stop(`Part ${s.part} (${s.branch}) is rebased here but couldn't be pushed: ${(e as Error).message}`);
          }
        } else rec1.pushed = newTip;
        // Its pull request now merges into the branch below (or the base branch, once the ones below are merged).
        const prBase = infos[s.part - 1]?.baseRef ?? rec1.baseName;
        if (prBase !== s.retarget && (rec1.url || rec1.number)) {
          const r = await gh(repo.top, ["pr", "edit", rec1.url || String(rec1.number), ...(rec1.url ? [] : repoArgs(slug)), "--base", s.retarget]);
          if (r.ok) rec1.baseName = s.retarget;
          else result.notes.push(`Part ${s.part}'s pull request couldn't be pointed at ${s.retarget}: ${r.stderr}`);
        } else rec1.baseName = s.retarget;
        result.parts.push({ branch: s.branch, did, pushed: pushedNow });
        await save();
      }
      // A part that is pushed but has no pull request (a push or gh failed when the stack was made) gets it now.
      const merged = new Set(states.filter((x) => x.state === "merged").map((x) => x.branch));
      const had = new Set(parts.filter((x) => x.number).map((x) => x.branch));
      const opened = await openPullRequests(repo, { ...rec, parts }, merged, result.notes);
      parts.forEach((x, i) => {
        const o = opened[i]!;
        if (o.created && o.number && !had.has(x.branch)) result.notes.push(`Opened the pull request for part ${i + 1}: #${o.number}.`);
        else if (o.error && Date.now() >= ghDownUntil && !x.number) result.notes.push(`Part ${i + 1}'s pull request couldn't be opened: ${o.error}`);
      });
      await save();
      for (const r of result.parts) {
        const x = parts.find((y) => y.branch === r.branch);
        if (x) Object.assign(r, { title: x.title, ...(x.url ? { url: x.url } : {}), ...(x.number ? { number: x.number } : {}) });
      }
    }
    return result;
  });
}

/** The ops the page and the IDE call (runner/local-api.ts `stack.<name>`). */
export async function stackOp(method: string, params: Record<string, unknown>): Promise<unknown> {
  const root = params.root;
  const base = typeof params.base === "string" ? params.base : undefined;
  switch (method) {
    case "stack.preview":
      return preview({ root: root as string, plan: params.plan, ...(base ? { base } : {}) });
    case "stack.make":
      return make({ root: root as string, plan: params.plan, ...(base ? { base } : {}) });
    case "stack.status":
      return status({ root: root as string });
    case "stack.restack":
      return restack({ root: root as string, ...(typeof params.id === "string" ? { id: params.id } : {}) });
    default:
      throw new Error(`Unknown stack op: ${method}`);
  }
}
