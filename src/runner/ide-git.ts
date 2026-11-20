import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { isAbsolute, join, relative, resolve, sep, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { IdeGitCode, IdeGitFile, IdeOkResult, IdeOps } from "../ide-contract.js";
import type { IdeHandlers } from "./ide-ops.js";
import { cleanRel, newTrashBatch, openRoot, resolveIn } from "./ide.js";

/**
 * Code's source control on this computer (src/ide-contract.ts). Every call runs `git` with an argument list (never through a
 * shell) in the folder the IDE has open, with a timeout and a buffer cap, so a stuck remote or a huge repo can't hang the runner.
 */

const QUICK_MS = 30_000;
/** Push, pull and fetch talk to a remote: slower, but still bounded (a login prompt can never be answered here). */
const NET_MS = 120_000;
/** A commit runs the repository's hooks and may wait on a GPG pinentry: allowed ten minutes, then the whole process group is stopped. */
const COMMIT_MS = 10 * 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;
/** A side of a diff bigger than this is shown as "too big to compare", the same bound as ide.read's 5 MB. */
const MAX_DIFF_BYTES = 5 * 1024 * 1024;

interface Run { stdout: string; stderr: string }

/** What a failed git call says, in the person's terms: git's own message, not a stack. */
class GitError extends Error {
  constructor(message: string, readonly code?: number | string) { super(message); }
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1", LC_MESSAGES: "C" };
  // LANGUAGE beats LC_MESSAGES: left set, the error texts matched below could come back translated.
  delete env.LANGUAGE;
  return env;
}

function run(root: string, args: string[], timeout = QUICK_MS, opts: { group?: boolean } = {}): Promise<Run> {
  if (opts.group) return runGroup(root, args, timeout);
  return new Promise((ok, fail) => {
    execFile("git", args, { cwd: root, timeout, maxBuffer: MAX_BUFFER, env: gitEnv(), windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
      if (!err) return ok({ stdout, stderr });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
      if (e.code === "ENOENT") return fail(new GitError("Git isn't installed on this computer.", "ENOENT"));
      if (e.killed) return fail(new GitError(`git ${args[0]} took too long and was stopped.`, "TIMEOUT"));
      const text = (String(stderr || "") + String(stdout || "")).trim();
      fail(new GitError(text || e.message, e.code));
    });
  });
}

/**
 * A git call that may start other programs (commit hooks, push hooks, a credential helper). On timeout the whole process group
 * is stopped, not only git: the plain timeout kills git alone, and the hook's children would keep running with index.lock held.
 * Windows has no process groups; `taskkill /T` stops the tree there.
 */
function runGroup(root: string, args: string[], timeout: number): Promise<Run> {
  return new Promise((ok, fail) => {
    const win = process.platform === "win32";
    const child = spawn("git", args, { cwd: root, env: gitEnv(), windowsHide: true, detached: !win, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const stop = () => {
      try {
        if (win) execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
        else process.kill(-child.pid!, "SIGTERM");
      } catch { child.kill(); }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    child.stdout.setEncoding("utf8").on("data", (d: string) => { if (stdout.length < MAX_BUFFER) stdout += d; });
    child.stderr.setEncoding("utf8").on("data", (d: string) => { if (stderr.length < MAX_BUFFER) stderr += d; });
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      fail(e.code === "ENOENT" ? new GitError("Git isn't installed on this computer.", "ENOENT") : new GitError(e.message, e.code));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return fail(new GitError(`git ${args[0]} took too long and was stopped.`, "TIMEOUT"));
      if (code === 0) return ok({ stdout, stderr });
      fail(new GitError((stderr + stdout).trim() || `git exited with ${code}`, code ?? undefined));
    });
  });
}

/** The raw bytes of a git call, for blobs: they may be binary or not UTF-8. */
function runBytes(root: string, args: string[]): Promise<Buffer> {
  return new Promise((ok, fail) => {
    execFile("git", args, { cwd: root, timeout: QUICK_MS, maxBuffer: MAX_DIFF_BYTES + 1024, env: gitEnv(), windowsHide: true, encoding: "buffer" }, (err, stdout, stderr) => {
      if (!err) return ok(stdout);
      const e = err as NodeJS.ErrnoException & { code?: number | string };
      const text = String(stderr || "").trim();
      fail(new GitError(e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "too big" : text || e.message, e.code));
    });
  });
}

/** root must be an absolute path to a folder that exists. */
async function checkRoot(root: unknown): Promise<string> {
  if (typeof root !== "string" || !root || !isAbsolute(root)) throw new Error("The folder must be an absolute path.");
  let st;
  try { st = await fs.stat(root); } catch { throw new Error(`The folder ${root} doesn't exist.`); }
  if (!st.isDirectory()) throw new Error(`${root} is not a folder.`);
  return resolve(root);
}

/** A path from the page, relative to root with "/" separators, checked never to leave root ("." is root itself). */
function inside(root: string, p: unknown): string {
  if (typeof p !== "string") throw new Error("A path is missing.");
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new Error(`${p} is outside the folder.`);
  return rel === "" ? "." : rel.split(sep).join("/");
}

function insideAll(root: string, paths: unknown): string[] {
  if (!Array.isArray(paths)) throw new Error("No paths given.");
  return paths.map((p) => inside(root, p));
}

async function isRepo(root: string): Promise<boolean> {
  try { return (await run(root, ["rev-parse", "--is-inside-work-tree"])).stdout.trim() === "true"; } catch { return false; }
}

/** Whether root is inside a work tree, and root's place inside it ("" at the top, "pkg/" in a subfolder), from one git call. */
async function repoPlace(root: string): Promise<{ repo: boolean; prefix: string }> {
  try {
    const [inside, prefix = ""] = (await run(root, ["rev-parse", "--is-inside-work-tree", "--show-prefix"])).stdout.split("\n");
    return { repo: inside?.trim() === "true", prefix: prefix.trim() };
  } catch { return { repo: false, prefix: "" }; }
}

async function hasHead(root: string): Promise<boolean> {
  try { await run(root, ["rev-parse", "--verify", "-q", "HEAD"]); return true; } catch { return false; }
}

// ── status ──────────────────────────────────────────────────────────────────────

function code(c: string): IdeGitCode | null {
  switch (c) {
    case "M": case "T": return "M";
    case "A": return "A";
    case "D": return "D";
    case "R": return "R";
    case "C": return "C";
    default: return null;
  }
}

/** Parses `git status --porcelain=v2 --branch -z`. Paths are relative to the repository's top, so `prefix` (root's place inside it) is cut off. */
export function parseStatus(out: string, prefix = ""): Omit<IdeOps["git.status"][1], "repo"> {
  const toks = out.split("\0");
  let branch = "";
  let oid = "";
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: IdeGitFile[] = [];
  const rel = (p: string): string | null => (prefix ? (p.startsWith(prefix) ? p.slice(prefix.length) : null) : p);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t) continue;
    if (t.startsWith("# ")) {
      const [key, ...rest] = t.slice(2).split(" ");
      const val = rest.join(" ");
      if (key === "branch.head") branch = val;
      else if (key === "branch.oid") oid = val;
      else if (key === "branch.upstream") upstream = val;
      else if (key === "branch.ab") {
        const m = val.match(/^\+(\d+) -(\d+)$/);
        if (m) { ahead = Number(m[1]); behind = Number(m[2]); }
      }
    } else if (t[0] === "1") {
      // 1 XY sub mH mI mW hH hI path
      const f = t.split(" ");
      const path = rel(f.slice(8).join(" "));
      if (path !== null) files.push({ path, index: code(f[1][0]), work: code(f[1][1]) });
    } else if (t[0] === "2") {
      // 2 XY sub mH mI mW hH hI Xscore path, then the old path as the next token
      const f = t.split(" ");
      const from = toks[++i] ?? "";
      const path = rel(f.slice(9).join(" "));
      if (path !== null) {
        const x = code(f[1][0]);
        const y = code(f[1][1]);
        files.push({ path, from: rel(from) ?? from, index: x, work: y });
      }
    } else if (t[0] === "u") {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path: a conflict, shown as one entry the person resolves in the file
      const f = t.split(" ");
      const path = rel(f.slice(10).join(" "));
      if (path !== null) files.push({ path, index: null, work: "U" });
    } else if (t[0] === "?") {
      const path = rel(t.slice(2));
      if (path !== null) files.push({ path, index: null, work: "?" });
    }
  }
  if (branch === "(detached)") branch = oid && oid !== "(initial)" ? oid.slice(0, 7) : "HEAD";
  return { branch, upstream, ahead, behind, files };
}

/** Statuses in flight, so a poll that arrives while the last one is still running (a big repository) shares it instead of piling a second git on top. */
const statusPending = new Map<string, Promise<IdeOps["git.status"][1]>>();

function status(root: string, untracked: "all" | "normal" = "all"): Promise<IdeOps["git.status"][1]> {
  const key = `${untracked}\0${root}`;
  let p = statusPending.get(key);
  if (!p) {
    p = (async () => {
      const place = await repoPlace(root);
      if (!place.repo) return { repo: false, branch: "", upstream: null, ahead: 0, behind: 0, files: [] };
      // --no-optional-locks: the page polls this while agents run git too, and a status must never block their index lock.
      const { stdout } = await run(root, ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z", `--untracked-files=${untracked}`]);
      return { repo: true, ...parseStatus(stdout, place.prefix) };
    })().finally(() => statusPending.delete(key));
    statusPending.set(key, p);
  }
  return p;
}

// ── diff ────────────────────────────────────────────────────────────────────────

const MISSING = /does not exist|exists on disk|not a valid object|unknown revision|bad revision|not in the index|invalid object name|unmerged|bad object/i;

/** A blob at a revision ("HEAD:path", ":path" for the index) as bytes; null when that side has no such file. */
async function blob(root: string, rev: string): Promise<Buffer | null> {
  try { return await runBytes(root, ["--no-optional-locks", "cat-file", "blob", rev]); }
  catch (e) {
    if (e instanceof GitError && (e.message === "too big" || !MISSING.test(e.message))) throw e;
    return null;
  }
}

async function workFile(root: string, rel: string): Promise<Buffer | null> {
  let abs: string;
  try {
    // A link that leads outside the folder is not read: the same check the file operations make.
    abs = await resolveIn(await openRoot(root), cleanRel(rel), true);
  } catch { return null; }
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) return null;
    if (st.size > MAX_DIFF_BYTES) throw new GitError("too big");
    return await fs.readFile(abs);
  } catch (e) {
    if (e instanceof GitError) throw e;
    return null;
  }
}

const isBinary = (b: Buffer | null) => !!b && b.subarray(0, 8000).includes(0);

async function diff(root: string, path: string, staged: boolean): Promise<IdeOps["git.diff"][1]> {
  const rel = inside(root, path);
  if (rel === ".") throw new Error("Pick a file to compare.");
  // Git's rev syntax is relative to the repository top for "HEAD:path" but to the folder with "HEAD:./path": ./ keeps a
  // subfolder-rooted IDE right.
  const spec = `./${rel}`;
  let original: Buffer | null;
  let modified: Buffer | null;
  try {
    if (staged) {
      original = await blob(root, `HEAD:${spec}`);
      modified = await blob(root, `:${spec}`);
    } else {
      // The index holds the staged version when there is one (HEAD's otherwise): a file staged and then edited again shows only the new edit.
      original = (await blob(root, `:${spec}`)) ?? (await blob(root, `HEAD:${spec}`));
      modified = await workFile(root, rel);
    }
  } catch (e) {
    if (e instanceof GitError && e.message === "too big") return { original: "", modified: "", binary: true };
    throw e;
  }
  if (isBinary(original) || isBinary(modified)) return { original: "", modified: "", binary: true };
  return { original: original?.toString("utf8") ?? "", modified: modified?.toString("utf8") ?? "", binary: false };
}

// ── stage / unstage / discard ───────────────────────────────────────────────────

async function stage(root: string, paths: string[]): Promise<IdeOkResult> {
  if (!paths.length) return { ok: true };
  // -A so a deleted file's removal is staged too.
  await run(root, ["add", "-A", "--", ...paths]);
  return { ok: true };
}

async function unstage(root: string, paths: string[]): Promise<IdeOkResult> {
  if (!paths.length) return { ok: true };
  // Unstaging a rename must put the old name back too, or the file would show as a lone deletion.
  const st = await status(root);
  const all = new Set(paths);
  for (const f of st.files) if (f.from && all.has(f.path)) all.add(f.from);
  const list = [...all];
  if (await hasHead(root)) await run(root, ["restore", "--staged", "--", ...list]);
  else await run(root, ["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--", ...list]);
  return { ok: true };
}

/** Moves untracked files into a new trash batch (the same folder ide.delete uses), where they wait instead of being gone for good. */
async function toTrash(root: string, batch: string, rels: string[]): Promise<void> {
  for (const rel of rels) {
    const dest = join(batch, rel);
    await fs.mkdir(dirname(dest), { recursive: true });
    const src = join(root, rel);
    try { await fs.rename(src, dest); }
    catch (e) {
      // A different drive can't be renamed across: copy, then remove.
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
      await fs.cp(src, dest, { recursive: true });
      await fs.rm(src, { recursive: true, force: true });
    }
  }
}

async function discard(root: string, paths: string[]): Promise<IdeOkResult> {
  if (!paths.length) return { ok: true };
  const st = await status(root);
  const hit = (f: IdeGitFile) => paths.some((p) => p === "." || f.path === p || f.path.startsWith(p.replace(/\/$/, "") + "/"));
  const matched = st.files.filter(hit);
  const untracked = matched.filter((f) => f.work === "?").map((f) => f.path);
  // Only files with an unstaged change: a staged-only file has nothing to throw away, and a conflicted one is for the person to resolve.
  const tracked = matched.filter((f) => f.work && f.work !== "?" && f.work !== "U").map((f) => f.path);
  if (!tracked.length && !untracked.length) return { ok: true };
  // Everything goes to the trash first, tracked files as copies of their working version, untracked ones moved: only then is
  // anything changed, so a failure while saving leaves the project as it was.
  const batch = await newTrashBatch("discard");
  for (const rel of tracked) {
    const src = join(root, rel);
    const dest = join(batch, rel);
    try {
      const real = await fs.lstat(src);
      if (!real.isFile() && !real.isSymbolicLink()) continue;
      await fs.mkdir(dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
    } catch (e) {
      // A tracked file that is already gone from disk has no working copy to keep.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  if (tracked.length) await run(root, ["restore", "--worktree", "--", ...tracked]);
  if (untracked.length) await toTrash(root, batch, untracked);
  return { ok: true, trashed: batch };
}

// ── commit ──────────────────────────────────────────────────────────────────────

async function commit(root: string, message: string, all: boolean): Promise<{ sha: string }> {
  const msg = typeof message === "string" ? message.trim() : "";
  if (!msg) throw new Error("Write a commit message first.");
  const { prefix } = await repoPlace(root);
  // "-- ." limits the check to this folder: staged changes elsewhere in the repository are not what the person is looking at.
  const hasStaged = async () => {
    try { await run(root, ["diff", "--cached", "--quiet", "--", "."]); return false; }
    catch (e) { if (e instanceof GitError && e.code === 1) return true; throw e; }
  };
  // On a repository with no commits yet `diff --cached` compares against the empty tree, so the same check works there.
  // "add -A -- ." stages this folder only; a bare "add -A" would stage the whole repository, other packages and an agent's work in a sibling folder included.
  if (all && !(await hasStaged())) await run(root, ["add", "-A", "--", "."]);
  if (!(await hasStaged())) throw new Error("There is nothing to commit.");
  if (prefix) {
    // A plain commit takes everything staged in the repository. Staged files outside this folder would go in unseen, so refuse and name them.
    const staged = (await run(root, ["diff", "--cached", "--name-only", "-z"])).stdout.split("\0").filter(Boolean);
    const outside = staged.filter((f) => !f.startsWith(prefix));
    if (outside.length) {
      const shown = outside.slice(0, 5).join(", ") + (outside.length > 5 ? `, and ${outside.length - 5} more` : "");
      throw new Error(`Other files outside this folder are staged too (${shown}). Unstage them first, so they don't go into this commit.`);
    }
  }
  try { await run(root, ["var", "GIT_AUTHOR_IDENT"]); }
  catch { throw new Error("Git doesn't know who you are. Set your name and email first: git config --global user.name \"Your Name\" and git config --global user.email \"you@example.com\"."); }
  // The message is an argument, not a shell string, so quotes and newlines in it are safe; hooks run as they would in a terminal.
  await run(root, ["commit", "-m", msg], COMMIT_MS, { group: true });
  const sha = (await run(root, ["rev-parse", "HEAD"])).stdout.trim();
  return { sha };
}

// ── branches / checkout ─────────────────────────────────────────────────────────

async function currentBranch(root: string): Promise<string> {
  try {
    const b = (await run(root, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim();
    if (b) return b;
  } catch { /* detached */ }
  try { return (await run(root, ["rev-parse", "--short", "HEAD"])).stdout.trim(); } catch { return ""; }
}

async function branches(root: string) {
  const [{ stdout }, current] = await Promise.all([
    run(root, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]),
    currentBranch(root),
  ]);
  const local: string[] = [];
  const remote: string[] = [];
  for (const ref of stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (ref.startsWith("refs/heads/")) local.push(ref.slice("refs/heads/".length));
    // refs/remotes/origin/HEAD is only a pointer to the default branch, not a branch of its own.
    else if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD")) remote.push(ref.slice("refs/remotes/".length));
  }
  return { current, local, remote };
}

async function checkout(root: string, branch: string, create: boolean): Promise<IdeOkResult> {
  const name = typeof branch === "string" ? branch.trim() : "";
  if (!name || name.startsWith("-")) throw new Error("That isn't a branch name.");
  if (create) {
    try { await run(root, ["check-ref-format", "--branch", name]); } catch { throw new Error(`"${name}" isn't a valid branch name.`); }
    await run(root, ["switch", "-c", name]);
    return { ok: true };
  }
  const b = await branches(root);
  // A remote branch with no local twin is checked out as a local branch that tracks it, as VS Code does. "origin/x" names
  // it exactly; a bare "x" is taken as the remote one only when a single remote has it, because git itself would guess.
  if (!b.local.includes(name)) {
    let remote = b.remote.includes(name) ? name : undefined;
    if (!remote) {
      const hits = b.remote.filter((r) => r.slice(r.indexOf("/") + 1) === name);
      if (hits.length > 1) throw new Error(`More than one remote has "${name}" (${hits.join(", ")}). Pick one of them by its full name.`);
      remote = hits[0];
    }
    if (remote) { await run(root, ["switch", "--track", remote]); return { ok: true }; }
  }
  await run(root, ["switch", name]);
  return { ok: true };
}

// ── sync / log / init ───────────────────────────────────────────────────────────

/** Syncs in flight per folder and action: a second click while one runs shares it instead of starting a second push. */
const syncPending = new Map<string, Promise<{ ok: true; output: string }>>();

/** The remote a first push goes to: the branch's own configured one, else the only remote, else "origin". */
async function pushRemote(root: string): Promise<string> {
  try {
    const branch = (await run(root, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim();
    const configured = branch ? (await run(root, ["config", "--get", `branch.${branch}.remote`]).catch(() => ({ stdout: "" }))).stdout.trim() : "";
    if (configured && configured !== ".") return configured;
  } catch { /* detached */ }
  const remotes = (await run(root, ["remote"]).catch(() => ({ stdout: "" }))).stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!remotes.length) throw new Error("This repository has no remote to push to. Add one first: git remote add origin <url>.");
  return remotes.length === 1 || !remotes.includes("origin") ? remotes[0]! : "origin";
}

function sync(root: string, action: string): Promise<{ ok: true; output: string }> {
  const key = `${action}\0${root}`;
  let p = syncPending.get(key);
  if (!p) {
    p = syncNow(root, action).finally(() => syncPending.delete(key));
    syncPending.set(key, p);
  }
  return p;
}

async function syncNow(root: string, action: string): Promise<{ ok: true; output: string }> {
  const out = ({ stdout, stderr }: Run) => [stderr, stdout].map((s) => s.trim()).filter(Boolean).join("\n");
  if (action === "fetch") return { ok: true, output: out(await run(root, ["fetch", "--prune"], NET_MS, { group: true })) };
  if (action === "pull") return { ok: true, output: out(await run(root, ["pull", "--ff-only"], NET_MS, { group: true })) };
  if (action === "push") {
    let hasUpstream = true;
    try { await run(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]); } catch { hasUpstream = false; }
    const args = hasUpstream ? ["push"] : ["push", "-u", await pushRemote(root), "HEAD"];
    return { ok: true, output: out(await run(root, args, NET_MS, { group: true })) };
  }
  throw new Error(`Unknown sync action: ${action}`);
}

async function log(root: string, path: string | undefined, max: number | undefined) {
  const n = Math.max(1, Math.min(1000, Math.floor(Number(max) || 50)));
  const args = ["--no-optional-locks", "log", "-z", "--format=%H%x1f%s%x1f%an%x1f%at", "-n", String(n)];
  if (path) {
    const rel = inside(root, path);
    // --follow keeps a file's history across renames, which is what a Timeline is for.
    args.push("--follow", "--", rel);
  }
  let stdout: string;
  try { stdout = (await run(root, args)).stdout; }
  catch (e) {
    // A fresh repository has no commits to list.
    if (e instanceof GitError && /does not have any commits|unknown revision|bad default revision/i.test(e.message)) return { commits: [] };
    throw e;
  }
  const commits = stdout.split("\0").map((r) => r.replace(/^\n/, "")).filter(Boolean).map((r) => {
    const [sha, subject, author, at] = r.split("\x1f");
    return { sha, subject, author, at: Number(at) };
  });
  return { commits };
}

export const IDE_GIT: IdeHandlers = {
  "git.status": async ({ root, untracked }) => status(await checkRoot(root), untracked === "normal" ? "normal" : "all"),
  "git.diff": async ({ root, path, staged }) => diff(await checkRoot(root), path, !!staged),
  "git.stage": async ({ root, paths }) => { const r = await checkRoot(root); return stage(r, insideAll(r, paths)); },
  "git.unstage": async ({ root, paths }) => { const r = await checkRoot(root); return unstage(r, insideAll(r, paths)); },
  "git.discard": async ({ root, paths }) => { const r = await checkRoot(root); return discard(r, insideAll(r, paths)); },
  "git.commit": async ({ root, message, all }) => commit(await checkRoot(root), message, !!all),
  "git.branches": async ({ root }) => branches(await checkRoot(root)),
  "git.checkout": async ({ root, branch, create }) => checkout(await checkRoot(root), branch, !!create),
  "git.sync": async ({ root, action }) => sync(await checkRoot(root), action),
  "git.log": async ({ root, path, max }) => log(await checkRoot(root), path, max),
  "git.init": async ({ root }) => { await run(await checkRoot(root), ["init"]); return { ok: true }; },
};
