import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, rmdir, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { DiffFile } from "../types.js";
import { mergeFeedback, parsePrUrl, type PrComment } from "../pr-feedback.js";
import { failedChecks, tailLog, type CheckFailure } from "../pr-checks.js";
import { authEnv } from "./github.js";

/** git's id for the empty tree: a base for repositories with no commits yet. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const MAX_FILES = 80;
const MAX_FILE_PATCH = 60_000;
const MAX_TOTAL = 600_000;

/**
 * Where the repository lives, when it isn't inside the folder.
 *
 * A folder somebody lends is often not a git repository at all — a scratch
 * directory, a design export, a project they never initialised — and the diff
 * panel was simply empty for all of them. This is git's own answer to that:
 * keep the repository somewhere else and point it at the folder as a work
 * tree. Nothing is written into the folder, so nobody inherits a `.git` they
 * didn't ask for.
 */
export interface Shadow {
  gitDir: string;
  /** The commit the folder was in when we first saw it. */
  head: string;
}

/** `--git-dir` and `--work-tree` first, when the repository is kept outside. */
const at = (cwd: string, shadow?: Shadow): string[] => (shadow ? ["--git-dir", shadow.gitDir, "--work-tree", cwd] : []);

/**
 * Paths past Windows' 260 characters. A checkpoint is a ref named for its commit, so `.git/refs/friday/checkpoints/<sha>.lock`
 * adds 70 characters to the repository's own path, and in a deep folder git refused to write it: no checkpoint, so no undo.
 * Git for Windows reads this; everywhere else it is an unknown key that git ignores.
 */
const LONG = ["-c", "core.longpaths=true", "-c", "core.quotePath=false"];
// quotePath: a file name past ASCII as it is. Quoted and octal-escaped, `café.ts` came back as `"b/caf\303\251.ts"`, which
// the Diff panel showed as such and no later pathspec matched, so the file couldn't be committed from the app.

/** `timeout`: how long git may take before it is killed, for the commands that can wait on a hook or a network. */
function git(cwd: string, args: string[], okCodes = [0], timeout = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...LONG, ...args], { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? ((err as unknown as { code: number }).code) : -1) : 0;
      if (okCodes.includes(code)) resolve(stdout);
      else reject(new Error(String(stderr).trim() || (err as Error).message));
    });
  });
}

/**
 * A folder's repository top, kept once git has said it: every checkpoint, starting point and diff asks, a turn takes several
 * of those, and on Windows each question is a process that costs a twentieth of a second. Only an answer is kept: a folder that
 * isn't a repository yet may become one.
 */
const tops = new Map<string, string>();
async function toplevel(cwd: string): Promise<string> {
  const had = tops.get(cwd);
  if (had) return had;
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  tops.set(cwd, root);
  return root;
}

export interface RepoInfo {
  root: string;
  /** What diffs are taken against: the commit checked out when the runner attached. */
  head: string;
  branch: string;
  /** Uncommitted work already in the folder, which means somebody is using it. */
  dirty: boolean;
}

export async function repoInfo(cwd: string): Promise<RepoInfo | null> {
  let root: string;
  try {
    root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return null;
  }
  // Three independent questions: asked together, since each is a process
  // spawn and on Windows that is most of what a session start waits for.
  const [head, branch, status] = await Promise.all([
    git(cwd, ["rev-parse", "HEAD"]).then((s) => s.trim(), () => EMPTY_TREE),
    git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).then((s) => s.trim(), () => ""),
    // Tracked changes only: an untracked build output is not somebody's work in
    // progress, and treating it as one would refuse half the repos that exist.
    git(cwd, ["status", "--porcelain", "--untracked-files=no"]).then((s) => s.trim(), () => ""),
  ]);
  return { root, head, branch, dirty: status.length > 0 };
}

/**
 * Put the folder on the session's branch, so a teammate who picks the work up
 * on their own machine checks out the same branch. Never discards anything:
 * git refuses the switch if local changes would be overwritten.
 *
 * Refusing is not the same as being safe, though — a clean switch still moves
 * a checkout somebody may be using, and their next commit lands on a branch
 * they didn't choose. See `guardBranchSwitch` for when not to ask at all.
 */
/** `from`: where a branch that has to be made starts (a branch, or `origin/<name>`), instead of whatever is checked out. */
export async function switchBranch(cwd: string, name: string, from?: string): Promise<void> {
  try {
    await git(cwd, ["switch", name]);
  } catch {
    await git(cwd, from ? ["switch", "-c", name, from] : ["switch", "-c", name]);
  }
}

/**
 * Have somebody else's branch here, with its commits: fetched from origin, or a branch of this checkout already, which
 * `trackBranch` then moves onto. False when neither has it, which is a branch that was only ever on the machine it was
 * made on: switching to it here would make a new one, the right name on the wrong code.
 *
 * Fetched even when this checkout has the branch already: that copy can be days behind what was pushed since. And fetched
 * without ever asking for a password, for twenty seconds at most: this runs before the agent connects, and a sign-in
 * window on a linked machine nobody is sitting at held the whole start for as long as it stayed open.
 */
export async function fetchBranch(cwd: string, name: string): Promise<boolean> {
  if (!BRANCH_NAME.test(name)) return false;
  await gitEnv(cwd, ["fetch", "-q", "origin", name], { ...NO_PROMPT, ...(await authEnv()) }, { timeout: 20_000 }).catch(() => {});
  const has = (ref: string) => git(cwd, ["rev-parse", "--verify", "-q", ref]).then(() => true, () => false);
  return (await has(`refs/heads/${name}`)) || has(`refs/remotes/origin/${name}`);
}

/**
 * Onto a branch `fetchBranch` found, brought up to what origin has.
 *
 * Never `switch -c`, which `switchBranch` falls back to: when this checkout can't move (an untracked file the branch has
 * would be overwritten, the branch is checked out in another worktree) it throws and stays where it is, instead of making
 * a branch of that name from whatever was checked out. Origin's copy is named outright, so a second remote with the same
 * branch, or `checkout.guess` off, can't stop it either. The catching up is fast-forward only: commits made here stay.
 */
export async function trackBranch(cwd: string, name: string): Promise<void> {
  const local = await git(cwd, ["rev-parse", "--verify", "-q", `refs/heads/${name}`]).then(() => true, () => false);
  await git(cwd, local ? ["switch", "-q", name] : ["switch", "-q", "--track", `origin/${name}`]);
  await git(cwd, ["merge", "--ff-only", "-q", `refs/remotes/origin/${name}`]).catch(() => {});
}

/**
 * Files Friday itself put in the folder.
 *
 * The old connect command downloaded the runner into whatever directory it was
 * run in, which was usually the project, and those copies are still out there —
 * so without this the first diff of a session can be six thousand lines of our
 * own script and its log. Someone's diff should only ever show their work.
 */
const OURS = /^(friday-runner\.mjs|runner\.log|\.friday\/)/;

/**
 * What never belongs in a snapshot of a folder nobody version-controlled.
 *
 * A repository has a .gitignore and the author's judgement in it. A plain
 * folder has neither, so snapshotting one means taking in node_modules and
 * every build output with it — hundreds of megabytes to say nothing, on a
 * folder somebody lent for five minutes.
 */
const NEVER = ["node_modules/", ".git/", "dist/", "build/", "out/", ".next/", ".venv/", "venv/", "__pycache__/", "target/", ".turbo/", ".cache/", "coverage/", "vendor/", ".DS_Store"];

/** How much of a folder is too much to snapshot: a count of files, their bytes, and how long looking may take. */
export interface FolderLimits {
  files: number;
  bytes: number;
  ms: number;
}
export const SNAPSHOT_LIMITS: FolderLimits = { files: 40_000, bytes: 800 * 1024 * 1024, ms: 4_000 };

/**
 * Weigh a folder without reading it all.
 *
 * The walk gives up the moment the answer is "too much" — by count, by bytes or
 * by the clock — so a folder of a million files costs a few seconds to say so
 * rather than the minutes it would take to snapshot. Generated directories are
 * not walked at all: they are not what the snapshot would take either.
 */
export async function weighFolder(cwd: string, limits: FolderLimits = SNAPSHOT_LIMITS): Promise<{ files: number; bytes: number; tooBig: "files" | "bytes" | "time" | null }> {
  const skip = new Set(NEVER.map((n) => n.replace(/\/$/, "")));
  const t0 = Date.now();
  let files = 0;
  let bytes = 0;
  const queue = [cwd];
  while (queue.length) {
    const dir = queue.pop()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const sized: Promise<number>[] = [];
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      if (e.isDirectory()) queue.push(path.join(dir, e.name));
      else if (e.isFile()) {
        files++;
        sized.push(lstat(path.join(dir, e.name)).then((s) => s.size, () => 0));
      }
    }
    for (const n of await Promise.all(sized)) bytes += n;
    if (files > limits.files) return { files, bytes, tooBig: "files" };
    if (bytes > limits.bytes) return { files, bytes, tooBig: "bytes" };
    if (Date.now() - t0 > limits.ms) return { files, bytes, tooBig: "time" };
  }
  return { files, bytes, tooBig: null };
}

/**
 * A repository for a folder that hasn't got one, kept in the temp directory.
 *
 * Returns null rather than throwing: a folder that cannot be snapshotted —
 * unreadable, enormous, git missing — should cost the session its diffs, not
 * its ability to work in the folder at all.
 */
export async function shadowSnapshot(cwd: string, onSkip?: (why: string) => void, limits?: FolderLimits): Promise<Shadow | null> {
  // A folder this big is not one to copy into git just to show a diff: the
  // session works in it all the same, it only loses the Files comparison.
  const w = await weighFolder(cwd, limits);
  if (w.tooBig) {
    onSkip?.(
      w.tooBig === "time"
        ? `${cwd} is too big to snapshot quickly, so changes in it won't be shown as a diff`
        : `${cwd} has more than ${w.tooBig === "files" ? `${(limits ?? SNAPSHOT_LIMITS).files.toLocaleString()} files` : `${Math.round((limits ?? SNAPSHOT_LIMITS).bytes / 1024 / 1024)} MB`} outside its dependency and build folders, so changes in it won't be shown as a diff`,
    );
    return null;
  }
  const gitDir = path.join(tmpdir(), `friday-shadow-${randomUUID().slice(0, 8)}`);
  const id = ["-c", "user.email=runner@friday.local", "-c", "user.name=Friday"];
  try {
    await git(cwd, ["init", "-q", "--bare", gitDir]);
    await writeFile(path.join(gitDir, "info", "exclude"), `${NEVER.join("\n")}\n`, "utf8");
    const g = at(cwd, { gitDir, head: "" });
    await git(cwd, [...g, "add", "-A"]);
    await git(cwd, [...g, ...id, "commit", "-q", "--allow-empty", "-m", "what the folder looked like when Friday arrived"]);
    const head = (await git(cwd, [...g, "rev-parse", "HEAD"])).trim();
    return { gitDir, head };
  } catch {
    await rm(gitDir, { recursive: true, force: true }).catch(() => {});
    return null;
  }
}

/** Where racing agents get their own checkouts, and one of the two places they are ever deleted from. */
const RACE_DIR = /friday-race-[0-9a-f]{8}$/;
/** A lane's own worktree: `<repo>-<id>`, under the worktrees folder and nowhere else. */
const LANE_DIR = /-[0-9a-f]{8}$/;

/**
 * Where a lane's own worktree lives.
 *
 * Not the temp folder a race uses: a racer is a throwaway, but a lane's work is
 * what the person came for, and the temp folder is swept on a reboot. A folder
 * under the home directory survives that, and the branch it is on survives
 * even the folder.
 */
export function worktreeRoot(): string {
  return path.resolve(process.env.FRIDAY_WORKTREES || path.join(homedir(), ".friday", "worktrees"));
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);

/**
 * A second checkout of the same repository, for an agent working beside another.
 *
 * Two agents editing one folder overwrite each other, so each gets a worktree
 * of its own on its own branch, cut from wherever the folder is now. The
 * dependencies are linked rather than reinstalled: a worktree has none, and an
 * agent that cannot run the tests has nothing to show for itself.
 *
 * With a `name` the copy is a lane's own: it lives under the worktrees folder
 * and its branch is `friday/<name>-<id>`. Without one it is a racer's, in the
 * temp folder, on `friday/race-<id>`.
 *
 * With `carry` the folder's changes that are not committed yet come along, still uncommitted: an agent taking work over
 * from another carries on from where it was, not from the last commit.
 */
/**
 * The copy's node_modules link, ignored as the folder it stands for is. `node_modules/` matches only a folder: a junction
 * (Windows) is listed as one, but a symlink (Mac, Linux) is listed as a new file, `?? node_modules`, which an agent adding
 * everything in its copy would commit as a link to somebody's disk. Only where the project already ignores its node_modules
 * folder, so nothing that showed before is hidden: one line, `/node_modules`, in the repository's own exclude list, which
 * every copy shares and which, there, changes nothing (the folder was ignored already).
 */
async function ignoreLink(dir: string): Promise<void> {
  if (!(await lstat(path.join(dir, "node_modules")).then((s) => s.isSymbolicLink(), () => false))) return;
  const shown = (await git(dir, ["status", "--porcelain", "--", "node_modules"]).catch(() => "")).trim();
  if (!shown) return;
  // Ignored as a folder is what the project asked for; a project that keeps node_modules in view keeps it in view. Asked
  // where the real folder is: git won't look at a path through a link ("beyond a symbolic link").
  const real = await realpath(path.join(dir, "node_modules"));
  const asFolder = await git(path.dirname(real), ["check-ignore", "-q", "node_modules/"], [0]).then(() => true, () => false);
  if (!asFolder) return;
  const common = path.resolve(dir, (await git(dir, ["rev-parse", "--git-common-dir"])).trim());
  const file = path.join(common, "info", "exclude");
  const had = await readFile(file, "utf8").catch(() => "");
  if (had.split(/\r?\n/).includes("/node_modules")) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${had}${had && !had.endsWith("\n") ? "\n" : ""}# Friday: the node_modules link in its copies of this folder\n/node_modules\n`, "utf8");
}

/** What a folder with no .gitignore keeps out of its first commit: dependencies, builds, caches, secrets, the OS's own files. */
const START_EXCLUDE = [
  "node_modules/",
  ".env",
  ".env.*",
  "!.env.example",
  "dist/",
  "build/",
  "out/",
  ".next/",
  ".nuxt/",
  ".turbo/",
  ".cache/",
  "coverage/",
  ".venv/",
  "venv/",
  "__pycache__/",
  "*.pyc",
  "target/",
  "DerivedData/",
  "Pods/",
  ".DS_Store",
  "Thumbs.db",
  "*.log",
];

/**
 * A folder that isn't a git repository made into one, for an agent to get its own copy of it (Arun, 2026-10-21: "why i cannot
 * run the coding agents in a different work tree on a folder on my desktop, granted it was never pushed to github"). A
 * separate copy is a git worktree, so a project never put in git could only take a second agent read-only.
 *
 * On this computer only: `git init` and one first commit of what is in the folder, nothing pushed, no remote. With no
 * .gitignore of its own, dependencies, builds, caches and .env files stay out through the repository's private exclude list
 * (.git/info/exclude), so no file is added to the folder. Never the home folder or a whole disk: a project folder only.
 */
export async function startRepo(cwd: string, who: { name: string; email?: string }): Promise<void> {
  const dir = path.resolve(cwd);
  const home = path.resolve(homedir());
  if (dir === home || dir === path.parse(dir).root || path.dirname(dir) === path.parse(dir).root) throw new Error("Pick a project folder for a separate copy, not your home folder or a whole disk.");
  if (await repoInfo(dir)) return;
  await git(dir, ["init", "-q"]);
  // main, whatever the git's own default: the name every tool and page here expects for a new project.
  await git(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  if (!(await access(path.join(dir, ".gitignore")).then(() => true, () => false))) {
    const file = path.join(dir, ".git", "info", "exclude");
    const had = await readFile(file, "utf8").catch(() => "");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${had}${had && !had.endsWith("\n") ? "\n" : ""}# Friday: kept out of the first commit it made here\n${START_EXCLUDE.join("\n")}\n`, "utf8");
  }
  await git(dir, ["add", "-A"], [0], 120_000);
  // As the person, when git doesn't know who they are: the commit needs a name, and it is theirs.
  const known = (await git(dir, ["config", "user.email"], [0, 1]).catch(() => "")).trim();
  const ident = known ? [] : ["-c", `user.name=${who.name || "Friday"}`, "-c", `user.email=${who.email || "friday@localhost"}`];
  await git(dir, [...ident, "commit", "-q", "--allow-empty", "--no-verify", "-m", "Starting point\n\nWhat was in this folder when Friday made it a git repository, so each agent can work in its own copy."], [0], 120_000);
}

export async function addWorktree(cwd: string, name?: string, carry = false): Promise<{ path: string; branch: string; repo: RepoInfo | null; include?: () => Promise<string[]> }> {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const own = name ? slug(name) || "agent" : "";
  // A lane's copy is a spare made ahead of time when there is one (see topUpSpares): `worktree add` is 3-9s of the attach.
  const spare = own ? await takeSpare(root, own) : null;
  const id = spare?.id ?? randomUUID().slice(0, 8);
  const dir = spare?.dir ?? (own ? path.join(worktreeRoot(), `${slug(path.basename(root)) || "repo"}-${id}`) : path.join(tmpdir(), `friday-race-${id}`));
  const branch = own ? `friday/${own}-${id}` : `friday/race-${id}`;
  if (!spare) await git(root, ["worktree", "add", "-q", "-b", branch, dir, "HEAD"]);
  if (carry) {
    const { tree } = await snapshotTree(root);
    await git(dir, ["read-tree", "-m", "-u", "HEAD", tree]);
    await git(dir, ["reset", "-q"]);
  }
  // Carried from a lane's own copy, whose node_modules is a link: `node_modules/` doesn't match a link, so the carry wrote it
  // here as a file (with Git for Windows' symlinks off) and the link below couldn't be made. It goes, and the link is to
  // the real folder, which outlives the copy it was found through.
  const modules = path.join(root, "node_modules");
  const link = path.join(dir, "node_modules");
  if (!(await lstat(link).then((s) => s.isDirectory(), () => true))) await unlink(link).catch(() => rmdir(link)).catch(() => {});
  if (await access(modules).then(() => true, () => false)) {
    await symlink(await realpath(modules).catch(() => modules), link, "junction").catch(() => {});
    await ignoreLink(dir).catch(() => {});
  }
  // What git leaves behind that the app needs to run: `.env` and the like. Never in the way of the copy being made. The
  // `.env` files are found by directory reads that skip what git ignores, done here; what a `.worktreeinclude` names takes a walk of every ignored
  // file (all of node_modules, 3-7s), so that is handed back to run once the lane is there, and only its first turn waits.
  const listed = await access(path.join(root, ".worktreeinclude")).then(() => true, () => false);
  if (!listed) await copyIncluded(root, dir).catch(() => {});
  // The same folder inside the copy, if the agent was started from a subfolder.
  // Asked of git rather than worked out from two paths: on Windows the root and
  // the temp directory come back in different spellings of the same place, and
  // a relative path between them walks out of the copy and into the original.
  // With it, the copy's top and commit in git's own spelling, so the runner needn't ask again (Runner.start): a fresh copy
  // is on `branch` with nothing changed. Carried work can make it dirty, which only a status says, so that one asks in full.
  const [sub, top] = await Promise.all([
    git(cwd, ["rev-parse", "--show-prefix"]).then((s) => s.trim().replace(/\/$/, "")),
    carry ? null : git(dir, ["rev-parse", "--show-toplevel", "HEAD"]).then((s) => s.trim().split("\n"), () => null),
  ]);
  const at = sub ? path.join(dir, sub) : dir;
  const repo = top?.length === 2 ? { root: top[0]!, head: top[1]!, branch, dirty: false } : await repoInfo(at);
  // The next spare, once this copy is made: never beside the carry, which is what this attach is waiting on.
  if (own) void topUpSpares(root);
  return { path: at, branch, repo, ...(listed ? { include: () => copyIncluded(root, dir) } : {}) };
}

/** A spare copy's branch, until a lane takes it and it is renamed for that lane. */
const SPARE_BRANCH = "friday/spare-";
/** How long a spare waits for a lane before it goes. */
export const SPARE_IDLE_MS = 30 * 60_000;
/** How long an attach waits for a spare still being made before it makes its own copy. */
const SPARE_WAIT_MS = 15_000;
/** Spares kept ready per repository. ponytail: one, so a third attach inside a few seconds pays for its own `worktree add`. */
const SPARES = 1;
interface Spare {
  id: string;
  dir: string;
  /** The commit it was cut at, so taking it only resets when the folder's HEAD has moved since. */
  head: string;
  timer?: ReturnType<typeof setTimeout>;
}
/** Spare copies ready for a lane, by repository top. Only ever in this process's memory: a spare is never an agent or a writer. */
const spares = new Map<string, Spare[]>();
const makingSpare = new Map<string, Promise<void>>();
/** Moved on by dropSpares, so a spare that finishes being made after that goes straight away. */
let spareEpoch = 0;

/**
 * Have a spare copy of the folder's repository ready for the next lane that wants one of its own, made in the background.
 * Called once an agent attaches to the folder: the next attach (somebody bringing a second tool to a folder being edited)
 * then takes it instead of waiting for `git worktree add`.
 */
export async function primeSpares(cwd: string): Promise<void> {
  const finding = toplevel(cwd).catch(() => null);
  findingTop.add(finding);
  const root = await finding;
  findingTop.delete(finding);
  if (root) await topUpSpares(root);
}
/** primeSpares still asking git for the top: its spare isn't in makingSpare yet, so an attach that instant waits for this first. */
const findingTop = new Set<Promise<unknown>>();

function topUpSpares(root: string): Promise<void> {
  // A copy's own copies are made as they always were: its node_modules link would be in the way of carrying into a spare.
  if (ownTop(root)) return Promise.resolve();
  const making = makingSpare.get(root);
  if (making || (spares.get(root)?.length ?? 0) >= SPARES) return making ?? Promise.resolve();
  const epoch = spareEpoch;
  const p = (async () => {
    const id = randomUUID().slice(0, 8);
    const s: Spare = { id, dir: path.join(worktreeRoot(), `${slug(path.basename(root)) || "repo"}-${id}`), head: "" };
    s.head = (await git(root, ["rev-parse", "HEAD"])).trim();
    await git(root, ["worktree", "add", "-q", "-b", `${SPARE_BRANCH}${id}`, s.dir, s.head]);
    if (epoch !== spareEpoch) return dropSpare(root, s);
    s.timer = setTimeout(() => {
      const list = spares.get(root) ?? [];
      if (list.includes(s)) {
        list.splice(list.indexOf(s), 1);
        void dropSpare(root, s);
      }
    }, SPARE_IDLE_MS);
    s.timer.unref?.();
    spares.set(root, [...(spares.get(root) ?? []), s]);
  })()
    .catch(() => {})
    .finally(() => makingSpare.delete(root));
  makingSpare.set(root, p);
  return p;
}

/** A spare for a lane, on the lane's own branch at the folder's HEAD. Null when there is none, or it can't be used. */
async function takeSpare(root: string, own: string): Promise<{ id: string; dir: string } | null> {
  // One still being made (a second tool brought within seconds of the first) is waited for rather than raced with another
  // `worktree add`; bounded, so a stuck one falls back to a copy of its own. Whoever resumes first takes it, the rest find none.
  if (findingTop.size) await Promise.all(findingTop);
  const making = makingSpare.get(root);
  if (making && !spares.get(root)?.length) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([making, new Promise((r) => (timer = setTimeout(r, SPARE_WAIT_MS)))]);
    clearTimeout(timer);
  }
  const s = spares.get(root)?.shift();
  if (!s) return null;
  clearTimeout(s.timer);
  try {
    const [head] = await Promise.all([git(root, ["rev-parse", "HEAD"]).then((o) => o.trim()), git(s.dir, ["branch", "-m", `friday/${own}-${s.id}`])]);
    // Nothing is in a spare to lose: it was made clean and nobody has had it since.
    if (head !== s.head) await git(s.dir, ["reset", "-q", "--hard", head]);
    return s;
  } catch {
    void dropWorktree(s.dir, true).catch(() => {});
    return null;
  }
}

async function dropSpare(root: string, s: Spare): Promise<void> {
  clearTimeout(s.timer);
  await dropWorktree(s.dir, true).catch(() => false);
  await git(root, ["branch", "-D", `${SPARE_BRANCH}${s.id}`]).catch(() => {});
}

/** Every spare copy goes, and any still being made goes once it is: when nothing on this machine is attached any more. */
export async function dropSpares(): Promise<number> {
  spareEpoch++;
  await Promise.all(makingSpare.values());
  const all = [...spares].flatMap(([root, list]) => list.map((s) => [root, s] as const));
  spares.clear();
  await Promise.all(all.map(([root, s]) => dropSpare(root, s)));
  return all.length;
}

/** Files of this size or larger stay behind: a copy is for settings and secrets, not data. */
const INCLUDE_MAX_BYTES = 1024 * 1024;
const INCLUDE_MAX_FILES = 200;

/**
 * The files git ignores that a copy still needs, carried into it: by default the `.env` files at any depth (the top's and
 * each package's, as `apps/web/.env.local` in a monorepo), or what the repo's `.worktreeinclude` names (gitignore
 * patterns, the file Claude Code and Conductor read too).
 *
 * A worktree holds only what is committed, so an agent in its own copy found the app wouldn't start: no `.env`, no keys.
 * Only files that are both named and ignored come across: anything committed is in the copy already, and anything
 * untracked but not ignored is somebody's work in progress, which `carry` brings when that is wanted. Small files only,
 * at most a couple of hundred, never overwriting what the copy has.
 */
export async function copyIncluded(root: string, dir: string): Promise<string[]> {
  const listFile = path.join(root, ".worktreeinclude");
  if (!(await access(listFile).then(() => true, () => false))) {
    // The default needs no walk of every ignored file: the `.env` files found by reading the folders git doesn't ignore.
    // Still only those git ignores (asked by name, a few at most), so a secret nobody ignored never lands in a copy whose
    // commits get pushed.
    const names = await envFiles(root);
    return names.length ? copyIgnored(root, dir, names) : [];
  }
  // Untracked files matching the patterns (whether or not git ignores them), then only the ones git does ignore.
  const matching = (await git(root, ["ls-files", "-z", "--others", "--ignored", `--exclude-from=${listFile}`], [0], 15_000)).split("\0").filter(Boolean);
  return matching.length ? copyIgnored(root, dir, matching) : [];
}

const ENV_FILE = /^\.env(\..+)?$/;
/** How far down, and through how many folders, the `.env` search looks: a monorepo's packages are two or three deep. */
const ENV_MAX_DEPTH = 6;
const ENV_MAX_DIRS = 2000;

/**
 * Every file named `.env` or `.env.*` under `root`, from directory reads level by level. The folders git ignores
 * (node_modules, dist, .venv and the like) are not gone into: each level's folders go to one `check-ignore`, so the search
 * costs a git call per level and the source tree's folders, never the thousands of files in what is ignored. Nor is `.git`,
 * or a nested repository (a folder with its own `.git`), whose files are not this repository's.
 */
async function envFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  let level = [""];
  let seen = 0;
  for (let depth = 0; level.length; depth++) {
    const dirs: string[] = [];
    for (const rel of level) {
      const entries = await readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
      if (rel && entries.some((e) => e.name === ".git")) continue;
      for (const e of entries) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isFile() && ENV_FILE.test(e.name)) found.push(p);
        else if (e.isDirectory() && e.name !== ".git" && e.name !== "node_modules") dirs.push(p);
      }
    }
    // ponytail: a fixed depth and folder budget; a source tree deeper or wider than this keeps the .env files found so far.
    dirs.splice(Math.max(0, ENV_MAX_DIRS - seen));
    seen += dirs.length;
    if (!dirs.length || depth + 1 >= ENV_MAX_DEPTH) break;
    const out = await gitEnv(root, ["check-ignore", "-z", "--stdin"], {}, { input: dirs.map((d) => `${d}/`).join("\0"), timeout: 15_000 }).catch(() => "");
    const ignored = new Set(out.split("\0").filter(Boolean).map((d) => d.replace(/\/$/, "")));
    level = dirs.filter((d) => !ignored.has(d));
  }
  return found;
}

/** Of `matching`, what git ignores, copied from `root` into `dir` within the limits above. */
async function copyIgnored(root: string, dir: string, matching: string[]): Promise<string[]> {
  const ignored = new Set((await gitEnv(root, ["check-ignore", "-z", "--stdin"], {}, { input: matching.join("\0"), timeout: 15_000 }).catch(() => "")).split("\0").filter(Boolean));
  const copied: string[] = [];
  for (const rel of matching) {
    if (copied.length >= INCLUDE_MAX_FILES) break;
    if (!ignored.has(rel) || rel.split("/").includes(".git")) continue;
    const from = path.join(root, rel);
    const to = path.join(dir, rel);
    const st = await lstat(from).catch(() => null);
    if (!st?.isFile() || st.size >= INCLUDE_MAX_BYTES) continue;
    if (await lstat(to).then(() => true, () => false)) continue;
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
    copied.push(rel);
  }
  return copied;
}

/** The top of one of our worktrees that `dir` is in, or null for anything else. */
function ownTop(dir: string): string | null {
  const norm = dir.split(path.sep).join("/");
  const race = norm.match(/^(.*friday-race-[0-9a-f]{8})(\/|$)/)?.[1];
  if (race && RACE_DIR.test(race) && path.resolve(race).indexOf(path.resolve(tmpdir())) === 0) return path.resolve(race);
  const base = worktreeRoot().split(path.sep).join("/");
  if (!norm.startsWith(`${base}/`)) return null;
  const top = `${base}/${norm.slice(base.length + 1).split("/")[0]}`;
  return LANE_DIR.test(top) ? path.resolve(top) : null;
}

/**
 * What would be lost if this worktree went: files not committed, and commits on
 * no other branch. Null when it is not one of ours, or already gone.
 */
export async function worktreeState(dir: string): Promise<{ dirty: number; ahead: number; branch: string } | null> {
  const top = ownTop(dir);
  if (!top || !(await lstat(top).then(() => true, () => false))) return null;
  // The dependency link is ours: a symlink on Unix (`?? node_modules`), a junction on Windows, which git lists as a folder (`?? node_modules/`).
  const status = (await git(top, ["status", "--porcelain"]).catch(() => "")).split("\n").filter(Boolean).filter((l) => !/ node_modules\/?$/.test(l)).length;
  const branch = (await git(top, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim();
  const others = (await git(top, ["for-each-ref", "--format=%(refname)", "refs/heads"]).catch(() => ""))
    .split("\n")
    .filter((r) => r && r !== `refs/heads/${branch}`);
  const ahead = Number((await git(top, ["rev-list", "--count", "HEAD", "--not", ...others]).catch(() => "0")).trim()) || 0;
  return { dirty: status, ahead, branch };
}

/**
 * Take a worktree away. Refuses anything that isn't one of ours.
 *
 * A racer's copy goes whatever is in it; that is what discarding is. A lane's
 * own worktree holds somebody's work, so it stays unless it has nothing in it
 * that exists nowhere else, or the caller says to throw that away. The branch
 * is never deleted: it is the work, and costs nothing to keep.
 */
export async function dropWorktree(dir: string, force: boolean | "committed" = true): Promise<boolean> {
  const real = ownTop(dir);
  if (!real) return false;
  if (force !== true && !RACE_DIR.test(real)) {
    const s = await worktreeState(real);
    // "committed": what is committed on its branch stays there (the branch is never deleted), so only uncommitted changes, or
    // commits on no branch at all, keep it.
    if (s && (s.dirty || (s.ahead && (force === false || s.branch === "HEAD" || !s.branch)))) return false;
  }
  // Take the link to the shared dependencies out first, as a link and never
  // recursively, so removing the tree cannot reach into the real ones. If it
  // will not come out, the checkout stays: a leftover folder costs nothing, a
  // deleted node_modules costs an install.
  const link = path.join(real, "node_modules");
  if (await lstat(link).then(() => true, () => false)) {
    await unlink(link).catch(() => rmdir(link)).catch(() => {});
    if (await lstat(link).then(() => true, () => false)) return false;
  }
  // Its kept snapshot index is named for the top as git spells it, so that is asked for while git can still answer.
  const top = await git(real, ["rev-parse", "--show-toplevel"]).then((s) => s.trim(), () => null);
  await git(real, ["worktree", "remove", "--force", real]).catch(() => rm(real, { recursive: true, force: true }));
  if (top) await rm(keptIndex(top), { force: true }).catch(() => {});
  return true;
}

/**
 * Copies nothing has used for three days, cleared away. They piled up: a fortnight, and only copies whose work was on no branch
 * yet, kept nearly every one, since agents commit their work (347 copies, 7.8 GB on one computer, Arun 2026-10-25: "make sure
 * deleting sessions and stuff clears up storage on the machine too"). A copy's branch is never deleted, so its committed work
 * stays; only one with uncommitted changes, or commits on no branch, is kept. Never one an agent here is working in (`inUse`).
 * Returns how many went.
 * ponytail: "touched" is the folder's own time, which moves when files are added or removed at its top, not on every edit.
 */
export async function sweepWorktrees(olderThanMs = 3 * 24 * 60 * 60_000, inUse: ReadonlySet<string> = new Set()): Promise<number> {
  const root = worktreeRoot();
  const names = await readdir(root).catch(() => [] as string[]);
  const using = new Set([...inUse].map((d) => path.resolve(d)));
  let gone = 0;
  for (const name of names) {
    if (!LANE_DIR.test(name)) continue;
    const dir = path.join(root, name);
    if (using.has(dir)) continue;
    const st = await stat(dir).catch(() => null);
    if (!st?.isDirectory()) continue;
    const age = Date.now() - st.mtimeMs;
    // A spare left by a runner that quit (or crashed) before it could take it away: past its idle limit and in no pool here.
    if (age >= SPARE_IDLE_MS && age < olderThanMs && ![...spares.values()].flat().some((s) => path.resolve(s.dir) === dir)) {
      const branch = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim();
      const common = branch.startsWith(SPARE_BRANCH) ? (await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => "")).trim() : "";
      if (common && (await dropWorktree(dir, true).catch(() => false))) {
        gone++;
        await git(common, ["--git-dir", common, "branch", "-D", branch]).catch(() => {});
      }
      continue;
    }
    if (age < olderThanMs) continue;
    if (await dropWorktree(dir, "committed").catch(() => false)) gone++;
  }
  // The kept snapshot indexes of folders not looked at in a fortnight: a cache, made again when one is (10,600 files on one computer).
  const kept = path.join(homedir(), ".friday", "snapshot-index");
  for (const f of await readdir(kept).catch(() => [] as string[])) {
    if (!/^[0-9a-f]{16}/.test(f)) continue;
    const at = path.join(kept, f);
    const st = await stat(at).catch(() => null);
    if (st && Date.now() - st.mtimeMs > 14 * 24 * 60 * 60_000) await rm(at, { force: true, recursive: true }).catch(() => {});
  }
  return gone;
}

/** The snapshot is ours and temporary; it goes when the runner does. */
export async function dropShadow(shadow: Shadow | null): Promise<void> {
  if (shadow) await rm(shadow.gitDir, { recursive: true, force: true }).catch(() => {});
}

/**
 * A change set, at most MAX_FILES of them with their patches. `more` names the files past that, so a commit of "these
 * changes" can still name every one of them instead of sweeping in the whole folder.
 */
export type ChangeSet = DiffFile[] & { more?: string[] };

/** Everything that differs from `base` in the working tree, untracked files included. */
export async function diffSince(cwd: string, base: string, shadow?: Shadow): Promise<ChangeSet> {
  const g = at(cwd, shadow);
  // From the top of the repository: `diff` names files from there wherever it runs, and `ls-files` from where it runs, so
  // an agent started in a subfolder had its new files listed (and committed) under the wrong paths.
  const root = shadow ? cwd : await toplevel(cwd);
  const [trackedRaw, untrackedRaw] = await Promise.all([
    git(root, [...g, "diff", "-M", "--no-color", "--no-ext-diff", "--ignore-cr-at-eol", base, "--"]),
    git(root, [...g, "ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const files = splitPatch(trackedRaw).filter((f) => !OURS.test(f.path));
  const all = untrackedRaw.split("\0").filter(Boolean).filter((f) => !OURS.test(f));
  // Past the cap a new file is only named: its patch would be cut off anyway, and its name is what a commit needs.
  const untracked = all.slice(0, Math.max(0, MAX_FILES - files.length));
  /**
   * A new file's patch is a git process of its own, and a run ends when its diff is in: one after another, a turn that
   * made sixty files stayed "working" for six seconds after the CLI had finished. Eight at a time, kept in order.
   */
  // ponytail: one `--no-index` per file, 8 at a time; a single diff through a copied index with intent-to-add is faster still.
  const patches: string[] = new Array(untracked.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, untracked.length) }, async () => {
      while (next < untracked.length) {
        const i = next++;
        // Exit code 1 just means "they differ", which a new file always does.
        patches[i] = await git(root, ["diff", "--no-index", "--no-color", "--", "/dev/null", untracked[i]!], [0, 1]).catch(() => "");
      }
    }),
  );
  all.forEach((f, i) => {
    const parsed = splitPatch(patches[i] ?? "");
    files.push(...(parsed.length ? parsed.map((d) => ({ ...d, path: f, status: "added" as const })) : [{ path: f, status: "added" as const, additions: 0, deletions: 0, patch: "" }]));
  });
  // A shadow's folder isn't a repository, so nothing in it was ever ignored by a repository's rules.
  return capDiff(shadow ? files : await withoutIgnoredBefore(root, base, files));
}

/**
 * What differs between `base` (HEAD or a checkpoint) and the folder as it is now, tree against tree.
 *
 * The folder is snapshotted the way a checkpoint is, through an index that is not the person's, so a repository whose index
 * holds nothing (an uploaded copy, a fresh `git init`) reads the same as one that is fully staged: only what changed shows.
 */
export async function diffTrees(cwd: string, base: string): Promise<ChangeSet> {
  const root = await toplevel(cwd);
  const { tree } = await snapshotTree(root);
  // A snapshot keeps the bytes on disk (CRLF on a Windows checkout) while a commit holds them normalised to LF: without
  // this, every committed file read as changed on every line, for good, after a commit on such a repository.
  const files = splitPatch(await git(root, ["diff", "-M", "--no-color", "--no-ext-diff", "--ignore-cr-at-eol", base, tree, "--"])).filter((f) => !OURS.test(f.path));
  return capDiff(await withoutIgnoredBefore(root, base, files));
}

const SECRET_ENV = /^\.env(\..+)?$/i;
const SAMPLE_ENV = /^\.env\.(example|sample|template)$/i;
/**
 * A .env's patch with its values taken out: which variables were added, removed or changed, never what they hold. A diff
 * goes to everyone in the room (and an old runner's to the server), so this holds for the host's own .env too.
 */
export function envNamesOnly(f: DiffFile): DiffFile {
  const secret = [f.path, f.from ?? ""].some((p) => {
    const n = p.split("/").pop() ?? "";
    return SECRET_ENV.test(n) && !SAMPLE_ENV.test(n);
  });
  if (!secret) return f;
  let inHunk = false;
  const patch = f.patch
    .split("\n")
    .map((l) => {
      if (l.startsWith("diff ")) inHunk = false;
      // A hunk header's tail is a line of the file (git's "function context"), which in a .env is a variable and its value.
      if (l.startsWith("@@")) return (inHunk = true), l.replace(/^(@@[^@]*@@).*$/, "$1");
      if (!inHunk || !l || l.startsWith("\\")) return l;
      const m = l.match(/^([ +-])\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=/);
      return m ? `${m[1]}${m[2]}=<hidden>` : `${l[0]}<hidden>`;
    })
    .join("\n");
  return { ...f, patch };
}

/** Keep the log small: big generated files cost everyone bandwidth, forever. The files past the cap are kept by name. */
function capDiff(files: DiffFile[]): ChangeSet {
  let total = 0;
  const kept: ChangeSet = files.slice(0, MAX_FILES).map(envNamesOnly).map((f) => {
    const room = Math.max(0, Math.min(MAX_FILE_PATCH, MAX_TOTAL - total));
    const truncated = f.patch.length > room;
    const patch = truncated ? f.patch.slice(0, room) : f.patch;
    total += patch.length;
    return truncated ? { ...f, patch, truncated } : f;
  });
  const more = files.slice(MAX_FILES).flatMap((f) => (f.from ? [f.path, f.from] : [f.path]));
  if (more.length) kept.more = more;
  return kept;
}

const IGNORE_FILE = /(^|\/)\.gitignore$/;

/**
 * Which of `paths` the ignore rules in `tree` match: the .gitignore files as they were there, with the repository's own
 * exclude file and config beside them. Read through an empty work tree that holds only those rules, so nothing in the
 * folder is touched.
 */
async function ignoredIn(root: string, tree: string, paths: string[]): Promise<Set<string>> {
  if (!paths.length) return new Set();
  const rules = (await git(root, ["ls-tree", "-r", "-z", "--name-only", tree])).split("\0").filter((p) => IGNORE_FILE.test(p));
  const gitDir = (await git(root, ["rev-parse", "--absolute-git-dir"])).trim();
  const dir = await mkdtemp(path.join(tmpdir(), "friday-ignore-"));
  try {
    for (const r of rules) {
      const bytes = await blobAt(root, `${tree}:${r}`);
      if (!bytes) continue;
      await mkdir(path.dirname(path.join(dir, r)), { recursive: true });
      await writeFile(path.join(dir, r), bytes);
    }
    // Exit 1 is "none of them is ignored".
    const out = await gitEnv(dir, [...at(dir, { gitDir, head: "" }), "check-ignore", "--no-index", "--stdin", "-z"], {}, { input: `${paths.join("\0")}\0` }).catch(() => "");
    return new Set(out.split("\0").filter(Boolean));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * A change set without the files that were there all along, ignored, until the change rewrote .gitignore.
 *
 * A snapshot leaves ignored files out, so a `.env` that a run un-ignored looked brand new: listed as the run's, offered
 * for the commit (secrets and all), and removed by an undo. Only asked when a .gitignore is among the changes.
 */
async function withoutIgnoredBefore(root: string, base: string, files: DiffFile[]): Promise<DiffFile[]> {
  if (!files.some((f) => IGNORE_FILE.test(f.path))) return files;
  const ignored = await ignoredIn(root, base, files.filter((f) => f.status === "added").map((f) => f.path)).catch(() => new Set<string>());
  return ignored.size ? files.filter((f) => !(f.status === "added" && ignored.has(f.path))) : files;
}

/** Split a unified diff into one entry per file. */
export function splitPatch(text: string): DiffFile[] {
  if (!text.trim()) return [];
  const chunks = text.split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git "));
  return chunks.map((chunk) => {
    const lines = chunk.split("\n");
    let status: DiffFile["status"] = "modified";
    let pathOut = "";
    let from = "";
    // The old name of a renamed file: committing the rename takes both paths, or the old one stays deleted and uncommitted.
    let renamedFrom = "";
    let additions = 0;
    let deletions = 0;
    let inHunk = false;
    for (const l of lines) {
      if (!inHunk) {
        if (l.startsWith("new file mode")) status = "added";
        else if (l.startsWith("deleted file mode")) status = "deleted";
        else if (l.startsWith("rename from ")) renamedFrom = l.slice("rename from ".length);
        else if (l.startsWith("rename to ")) {
          status = "renamed";
          pathOut = l.slice("rename to ".length);
        } else if (l.startsWith("--- ")) from = stripPrefix(l.slice(4));
        else if (l.startsWith("+++ ")) {
          const to = stripPrefix(l.slice(4));
          if (to !== "/dev/null") pathOut = to;
        } else if (l.startsWith("@@")) inHunk = true;
        continue;
      }
      if (l.startsWith("+")) additions++;
      else if (l.startsWith("-")) deletions++;
    }
    if (!pathOut) pathOut = from !== "/dev/null" && from ? from : headerPath(lines[0] ?? "");
    return { path: pathOut, status, additions, deletions, patch: chunk.trimEnd(), ...(status === "renamed" && renamedFrom ? { from: renamedFrom } : {}) };
  });
}

const stripPrefix = (p: string) => (p === "/dev/null" ? p : p.replace(/^[ab]\//, "").replace(/\t.*$/, ""));
const headerPath = (h: string) => h.replace(/^diff --git a\//, "").replace(/ b\/.*$/, "");

// ── checkpoints ───────────────────────────────────────────────────────
//
// A snapshot of the whole working tree before a run, so the run can be undone
// with one click.
//
// Built without touching anything the person owns: a throwaway index instead of
// theirs, a commit object nobody's branch points at, and a ref under
// refs/friday/ so git's garbage collector keeps it. Their HEAD, their staged
// changes and their stash are exactly as they left them. Ignored files are
// neither saved nor restored, which is what keeps node_modules out of it.

const FRIDAY_IDENT = { GIT_AUTHOR_NAME: "Friday", GIT_AUTHOR_EMAIL: "checkpoint@friday.local", GIT_COMMITTER_NAME: "Friday", GIT_COMMITTER_EMAIL: "checkpoint@friday.local" };

/**
 * Undo has to give back the bytes that were there, so line-ending conversion is
 * off both ways: with autocrlf on (the Windows default) a file saved with LF
 * would come back CRLF and show up as changed on every line.
 * ponytail: a repo .gitattributes `text`/`eol` or filter (e.g. LFS) still applies; override via info/attributes if that bites.
 */
const RAW = ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false"];

function gitEnv(cwd: string, args: string[], env: Record<string, string>, { input, timeout = 0 }: { input?: string; timeout?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", [...LONG, ...RAW, ...args], { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr).trim() || err.message));
      else resolve(stdout);
    });
    if (input !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    }
  });
}

/**
 * Where a repository's snapshot index is kept from one snapshot to the next.
 *
 * A fresh index knows nothing about the files in the folder, so `add -A` opened and hashed every one of them before every
 * run: a second on a small repository, most of a minute on a big one, all of it before the agent could start. Kept, its
 * stat cache lets git hash only what changed since the last snapshot. It is never seeded from the person's own index:
 * theirs is written with their line-ending settings, so its cache would vouch for blobs that are not the bytes on disk,
 * and undo would put back the wrong ones.
 *
 * Under the person's own home folder, not the temp folder: on Linux that is shared by every user, and an index planted at
 * a name anyone can work out would be trusted for what the files hold, so a checkpoint, and an undo to it, would put back
 * someone else's choice of old content. A worktree's goes with the worktree (see dropWorktree).
 */
const keptIndex = (root: string) => path.join(homedir(), ".friday", "snapshot-index", createHash("sha1").update(root).digest("hex").slice(0, 16));

/** Snapshots being built ahead of time (see warmSnapshot), by repository: one wanted meanwhile waits and starts from it. */
const building = new Map<string, Promise<unknown>>();
/** How long a snapshot waits for one being built ahead of it: longer than a big repository takes, shorter than never. */
const WARM_WAIT_MS = 60_000;
/**
 * The HEAD each repository's kept index was saved against, by this process. ponytail: two snapshots finishing together
 * across a HEAD move can leave this naming the other's HEAD; the cost is a file tracked by one HEAD but ignored being
 * missed, as seedIndex would otherwise fix.
 */
const keptHead = new Map<string, string | null>();

/**
 * The working tree as a tree object, via an index that is not the person's.
 *
 * Two at once (a checkpoint and the Files tab's diff) each work on a copy of their own and each is right; whichever
 * finishes last is the one kept.
 */
async function snapshotTree(root: string): Promise<{ tree: string; head: string | null }> {
  // Built side by side, both would hash every file, and the checkpoint would be no quicker for the head start. Not waited
  // for without end, though: on Windows a CLI being started on the spawning thread (see spawn-cli) can take a git's output
  // pipe with it and hold that git open for as long as it runs, and no turn should wait on that.
  const warming = building.get(root);
  if (warming) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = await Promise.race([warming.then(() => true), new Promise<boolean>((r) => (timer = setTimeout(r, WARM_WAIT_MS, false)))]);
    clearTimeout(timer);
    if (!done && building.get(root) === warming) building.delete(root);
  }
  const kept = keptIndex(root);
  await mkdir(path.dirname(kept), { recursive: true });
  const index = `${kept}-${randomUUID().slice(0, 8)}`;
  const env = { GIT_INDEX_FILE: index };
  try {
    const head = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]).then((s) => s.trim() || null, () => null);
    // Nothing changed since the kept index was saved, at the same HEAD: its tree is the snapshot, with no file hashed.
    const warm = keptHead.has(root) && keptHead.get(root) === head ? await warmTree(root, kept, index).catch(() => null) : null;
    if (warm) return { tree: warm, head };
    let seeded = false;
    const build = async (seed: boolean) => {
      await rm(index, { force: true });
      seeded = seed && !!head && (await seedIndex(root, kept, index, head!).catch(() => false));
      if (!seeded) {
        await rm(index, { force: true });
        if (head) await gitEnv(root, ["read-tree", head], env);
      }
      await gitEnv(root, ["add", "-A", "--", "."], env);
      return (await gitEnv(root, ["write-tree"], env)).trim();
    };
    // A kept index git can't work with is started over, never trusted.
    const tree = await build(true).catch((e) => {
      if (!seeded) throw e;
      return build(false);
    });
    // Kept for next time. One that can't be saved (another process holding it) only costs the next snapshot its head start.
    await rename(index, kept).then(() => keptHead.set(root, head), () => {});
    return { tree, head };
  } finally {
    await rm(index, { force: true }).catch(() => {});
  }
}

/**
 * The kept index's tree, when the folder still matches it: no tracked file's stat has moved and nothing untracked is new.
 * Checked on a copy (the kept one may be replaced meanwhile), so the tree is that of the very index that was compared. Null
 * when anything differs; a file touched but unchanged counts as changed, and costs only the full snapshot it would have had.
 */
async function warmTree(root: string, kept: string, index: string): Promise<string | null> {
  const st = await stat(kept).catch(() => null);
  if (!st) return null;
  await copyFile(kept, index);
  await utimes(index, st.atime, st.mtime);
  const env = { GIT_INDEX_FILE: index };
  const [same, nothingNew] = await Promise.all([
    gitEnv(root, ["diff-files", "--quiet"], env).then(() => true, () => false),
    gitEnv(root, ["ls-files", "-z", "--others", "--exclude-standard"], env).then((s) => s === "", () => false),
  ]);
  return same && nothingNew ? (await gitEnv(root, ["write-tree"], env)).trim() || null : null;
}

/**
 * Start a snapshot's index from the kept one, brought back in line with HEAD.
 *
 * The kept index describes the folder as it was, against whatever HEAD was then. A fresh one starts from HEAD, and the two
 * differ once HEAD has moved (a branch switch, a pull) or the ignore rules have changed: paths in the kept index that HEAD
 * doesn't track (an untracked file that is ignored now would stay in every checkpoint), and paths HEAD tracks that the kept
 * index lacks (a tracked file matching an ignore rule would be left out). Only those paths are touched; every other entry
 * keeps its stat cache. False when there is nothing kept to start from.
 * ponytail: a changed .gitattributes (eol, filters) isn't noticed for files whose stat still matches, as with git's own index.
 */
async function seedIndex(root: string, kept: string, index: string, head: string): Promise<boolean> {
  const st = await stat(kept).catch(() => null);
  if (!st) return false;
  await copyFile(kept, index);
  // git measures "changed since it was read" against the index file's own time. A copy is newer than the original, and would
  // vouch for a file edited in the same instant the kept index was written.
  await utimes(index, st.atime, st.mtime);
  const env = { GIT_INDEX_FILE: index };
  const f = (await gitEnv(root, ["diff-index", "--cached", "--no-renames", "--name-status", "-z", "--diff-filter=AD", head], env)).split("\0").filter(Boolean);
  const untracked: string[] = [];
  const missing: string[] = [];
  for (let i = 0; i + 1 < f.length; i += 2) (f[i] === "A" ? untracked : missing).push(f[i + 1]!);
  if (untracked.length) await gitEnv(root, ["update-index", "--force-remove", "-z", "--stdin"], env, { input: `${untracked.join("\0")}\0` });
  if (missing.length) await gitEnv(root, ["--literal-pathspecs", "reset", "-q", head, "--pathspec-from-file=-", "--pathspec-file-nul"], env, { input: `${missing.join("\0")}\0` });
  return true;
}

/** Save the folder as it is now. Returns the checkpoint's id, or null outside a git repository. */
export async function checkpoint(cwd: string, label: string): Promise<string | null> {
  const root = await toplevel(cwd).catch(() => null);
  if (!root) return null;
  const { tree, head } = await snapshotTree(root);
  const sha = (await gitEnv(root, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", `friday checkpoint: ${label}`.slice(0, 200)], FRIDAY_IDENT)).trim();
  await git(root, ["update-ref", `refs/friday/checkpoints/${sha}`, sha]);
  return sha;
}

/**
 * Build a folder's kept snapshot index before its first checkpoint is wanted.
 *
 * The first checkpoint in a folder has nothing kept to start from and hashes every file, and a hand-off's new copy is
 * always such a folder, so its first turn waited for that. Done while the lane is waiting for its first instruction, the
 * checkpoint then only hashes what changed since. Nothing is saved: the tree is thrown away.
 *
 * `root` is the repository's top as git spells it (RepoInfo.root), so a checkpoint asked for a moment later finds this one
 * under the same name and waits for it, rather than hashing everything beside it.
 */
export async function warmSnapshot(root: string): Promise<void> {
  const p = snapshotTree(root).catch(() => {});
  building.set(root, p);
  await p;
  if (building.get(root) === p) building.delete(root);
}

/**
 * Put the folder back the way a checkpoint found it.
 *
 * Files the run changed get their old contents, files it created are removed,
 * files it deleted come back. The folder as it was a moment ago is saved as a
 * checkpoint first and its id returned, so undoing an undo is the same button.
 *
 * With `until` (where the run left the folder) only the files the run changed are put back: what the person edited after
 * it, in files the run never touched, stays as they left it.
 *
 * `after` is the folder once this is done, the `until` of a redo: without it a redo went back to the whole folder as it
 * was before the undo, and took with it every file edited or made since.
 */
export async function restore(cwd: string, sha: string, until?: string): Promise<{ undo: string; after: string | null; restored: number; removed: number }> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("That isn't a checkpoint.");
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const target = (await git(root, ["rev-parse", "--verify", "-q", `${sha}^{tree}`]).catch(() => "")).trim();
  if (!target) throw new Error("That checkpoint isn't in this repository any more.");
  const end = until && /^[0-9a-f]{40}$/.test(until) ? (await git(root, ["rev-parse", "--verify", "-q", `${until}^{tree}`]).catch(() => "")).trim() : "";
  const undo = await checkpoint(root, "before undo");
  const now = end || (await git(root, ["rev-parse", `${undo}^{tree}`])).trim();

  const changed = (await git(root, ["diff", "--name-only", "--no-renames", "-z", target, now])).split("\0").filter(Boolean);
  const created = (await git(root, ["diff", "--name-only", "--no-renames", "--diff-filter=A", "-z", target, now])).split("\0").filter(Boolean);
  // A file the checkpoint left out because it was ignored then, and that the run un-ignored, looks created by the run. It
  // was there before (a `.env`, say), so it is never removed: only what the checkpoint's own rules would have kept is.
  const kept = changed.some((f) => IGNORE_FILE.test(f)) ? await ignoredIn(root, target, created) : new Set<string>();
  const added = new Set(created.filter((f) => !kept.has(f)));
  const index = path.join(tmpdir(), `friday-index-${randomUUID()}`);
  try {
    await gitEnv(root, ["read-tree", target], { GIT_INDEX_FILE: index });
    const made = new Set(created);
    const back = changed.filter((f) => !made.has(f));
    // Written in batches so a thousand-file run doesn't overflow a command line.
    for (let i = 0; i < back.length; i += 200) {
      await gitEnv(root, ["checkout-index", "-f", "--", ...back.slice(i, i + 200)], { GIT_INDEX_FILE: index });
    }
    for (const f of added) await rm(path.join(root, f), { force: true });
    const after = await checkpoint(root, "after undo");
    return { undo: undo!, after, restored: back.length, removed: added.size };
  } finally {
    await rm(index, { force: true }).catch(() => {});
  }
}

// ── where a session started ───────────────────────────────────────────
//
// What an agent changed is measured from the folder as it was when the agent came to it, uncommitted work and all, not
// from the last commit: otherwise the person's own unfinished edits are listed (and shipped) as the agent's. Kept as a
// ref in the repository, so a reconnect measures from the same place instead of starting over.

const baseRef = (key: string) => `refs/friday/base/${key}`;

/** The folder's starting point for this session and folder, taken now if there isn't one yet (unless `create` is off). Null outside git. */
export async function sessionBase(cwd: string, key: string, create = true): Promise<string | null> {
  const root = await toplevel(cwd).catch(() => null);
  if (!root) return null;
  const had = (await git(root, ["rev-parse", "--verify", "-q", `${baseRef(key)}^{commit}`]).catch(() => "")).trim();
  if (had || !create) return had || null;
  const sha = await checkpoint(root, "session start");
  if (sha) await git(root, ["update-ref", baseRef(key), sha]);
  return sha;
}

/** Whether two commits hold the same files: a starting point taken in a clean folder is just its last commit. */
export async function sameTree(cwd: string, a: string, b: string): Promise<boolean> {
  const t = (r: string) => git(cwd, ["rev-parse", "--verify", "-q", `${r}^{tree}`]).then((s) => s.trim(), () => "");
  const [x, y] = await Promise.all([t(a), t(b)]);
  return !!x && x === y;
}

/** Move a session's starting point, after a commit or an apply took what was there. */
export async function setSessionBase(cwd: string, key: string, sha: string): Promise<void> {
  await git(cwd, ["update-ref", baseRef(key), sha]);
}

/**
 * The starting point after a commit: the files the commit recorded count as they were committed, everything else as it
 * was. What is left to show is what wasn't committed, and the person's own unfinished work still isn't the agent's.
 */
export async function baseAfterCommit(cwd: string, base: string, from: string, to: string): Promise<string> {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const paths = (await git(root, ["diff", "--name-only", "--no-renames", "-z", from, to])).split("\0").filter(Boolean);
  if (!paths.length) return base;
  const index = path.join(tmpdir(), `friday-index-${randomUUID()}`);
  try {
    const env = { GIT_INDEX_FILE: index };
    await gitEnv(root, ["read-tree", base], env);
    await gitEnv(root, ["--literal-pathspecs", "reset", "-q", to, "--pathspec-from-file=-", "--pathspec-file-nul"], env, { input: `${paths.join("\0")}\0` });
    const tree = (await gitEnv(root, ["write-tree"], env)).trim();
    return (await gitEnv(root, ["commit-tree", tree, "-p", to, "-m", "friday base: after a commit"], FRIDAY_IDENT)).trim();
  } finally {
    await rm(index, { force: true }).catch(() => {});
  }
}

/** A file's bytes at `spec` ("<tree>:<path>"), or null when it isn't there. Bytes, not text: it may be an image. */
function blobAt(root: string, spec: string): Promise<Buffer | null> {
  return new Promise((resolve) =>
    execFile("git", [...LONG, "cat-file", "blob", spec], { cwd: root, encoding: "buffer", maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (err, out) => resolve(err ? null : out)),
  );
}

const binary = (b: Buffer) => b.subarray(0, 8000).includes(0);
const sameBytes = (x: Buffer | null, y: Buffer | null) => (x === null ? y === null : y !== null && x.equals(y));
/**
 * Line endings, for text. A copy is checked out with this machine's settings, which on Windows can turn LF into CRLF, so
 * "the person didn't touch it" is asked with line endings set aside, and what is written back takes the person's style.
 * (latin1 keeps every byte as it is, so UTF-8 comes through unchanged.)
 */
const lf = (b: Buffer) => Buffer.from(b.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
const inStyleOf = (b: Buffer, like: Buffer | null) => (like?.includes("\r\n") ? Buffer.from(lf(b).toString("latin1").replace(/\n/g, "\r\n"), "latin1") : like ? lf(b) : b);

/**
 * One file both sides changed, merged the way git merges: the person's version, what both started from, and the agent's.
 * Overlapping edits are left as conflict markers. Null when it can't be merged line by line (one side deleted it, or it
 * is binary): the person's stays, and it is named as a clash.
 */
async function mergeOne(base: Buffer | null, ours: Buffer, theirs: Buffer): Promise<{ out: Buffer; clean: boolean } | null> {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-merge-"));
  try {
    const [o, b, t] = [path.join(dir, "ours"), path.join(dir, "base"), path.join(dir, "theirs")];
    await Promise.all([writeFile(o, lf(ours)), writeFile(b, base ? lf(base) : ""), writeFile(t, lf(theirs))]);
    return await new Promise((resolve, reject) =>
      execFile("git", ["merge-file", "-p", "-L", "your folder", "-L", "before", "-L", "the agent", o, b, t], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
        const c = err ? (err as unknown as { code: unknown }).code : 0;
        // A positive exit is the number of conflicts, and the merge is still printed; anything else is a failure.
        if (typeof c === "number" && c >= 0) resolve({ out: inStyleOf(stdout, ours), clean: c === 0 });
        else reject(err);
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Bring an agent's work from its separate copy into the folder the copy was made from.
 *
 * What the copy changed since `base` (where it started, with the person's uncommitted changes carried in) goes onto the
 * folder as it is now. As one patch when it fits. Otherwise file by file: a file the person hasn't touched since takes the
 * agent's version, and one both changed is merged, with conflict markers where they changed the same lines. The person's
 * index is never touched, so nothing ends up staged.
 */
export async function applyCopy(copy: string, base: string, into: string): Promise<{ files: string[]; conflicts: string[]; tree: string }> {
  const root = (await git(copy, ["rev-parse", "--show-toplevel"])).trim();
  const dest = (await git(into, ["rev-parse", "--show-toplevel"])).trim();
  const { tree } = await snapshotTree(root);
  const files = (await git(root, ["diff", "--name-only", "--no-renames", "-z", base, tree])).split("\0").filter((f) => f && !OURS.test(f));
  if (!files.length) return { files, conflicts: [], tree };
  const patch = await gitEnv(root, ["diff", "--binary", "--full-index", "--no-color", "--no-ext-diff", "--no-renames", base, tree, "--", ".", ":(exclude)friday-runner.mjs", ":(exclude)runner.log", ":(exclude).friday"], {});
  const plain = await gitEnv(dest, ["apply", "--whitespace=nowarn"], {}, { input: patch }).then(() => true, () => false);
  if (plain) return { files, conflicts: [], tree };
  // A copy is a worktree of the same repository, so every version of every file is readable from here.
  const conflicts: string[] = [];
  for (const f of files) {
    const target = path.join(dest, f);
    const [before, theirs, ours] = await Promise.all([blobAt(root, `${base}:${f}`), blobAt(root, `${tree}:${f}`), readFile(target).catch(() => null)]);
    const text = [before, theirs, ours].every((b) => b === null || !binary(b));
    const same = (x: Buffer | null, y: Buffer | null) => (text ? sameBytes(x && lf(x), y && lf(y)) : sameBytes(x, y));
    if (same(ours, theirs)) continue;
    if (same(ours, before)) {
      if (theirs === null) await rm(target, { force: true });
      else {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, text ? inStyleOf(theirs, ours) : theirs);
      }
      continue;
    }
    const merged = text && ours && theirs ? await mergeOne(before, ours, theirs) : null;
    if (merged) await writeFile(target, merged.out);
    if (!merged?.clean) conflicts.push(f);
  }
  return { files, conflicts, tree };
}

// ── shipping ──────────────────────────────────────────────────────────
//
// Commit what the session made, push it, and open a pull request — the step
// every run ends with and nobody wants to leave the room to do.

/** Never prompt: a push that wants a password fails at once instead of hanging a hidden terminal. */
export const NO_PROMPT = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };

const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)[\w./-]{1,100}(?<![./])$/;

export interface Committed {
  sha: string;
  branch: string;
  files: number;
}

/**
 * Stage everything and commit it, optionally on a new branch.
 *
 * Everything means what the Files tab shows: tracked changes and new files git
 * doesn't ignore, minus Friday's own runner and log. The person's own git
 * identity signs it — it is their commit, made from their session.
 */
/**
 * The branches this folder has, and which one it is on.
 *
 * Local branches only: the remote's list is long, mostly other people's, and
 * switching to one of them is a checkout decision rather than a menu item.
 */
export async function branchesOf(cwd: string): Promise<{ current: string; branches: { name: string; ahead: number; behind: number; elsewhere?: string }[] }> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]).then((s) => s.trim(), () => null);
  if (!root) throw new Error("This folder isn't a git repository, so it has no branches.");
  const current = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  // Which other folder (a worktree) has each branch checked out: git won't switch this one onto it, so the list says where it
  // is instead of offering a switch that can only fail. %(worktreepath) is git 2.27 on; an older git lists without it.
  const list = (format: string) => git(root, ["for-each-ref", "--sort=-committerdate", "--count=50", `--format=${format}`, "refs/heads"]);
  const raw = await list("%(refname:short)%09%(upstream:track)%09%(worktreepath)").catch(() => list("%(refname:short)%09%(upstream:track)"));
  const here = path.resolve(root);
  const branches = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", track = "", tree = ""] = line.split("\t");
      const elsewhere = tree && path.resolve(tree) !== here ? tree : "";
      return { name, ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0), ...(elsewhere ? { elsewhere } : {}) };
    });
  return { current: current === "HEAD" ? "" : current, branches };
}

/**
 * The branches only origin has, as this checkout last fetched them, newest first: no fetch, so it costs a moment and asks for
 * no password. Ones with a branch of the same name here are left out, as is origin's HEAD.
 */
export async function remoteBranchesOf(cwd: string): Promise<string[]> {
  const raw = await git(cwd, ["for-each-ref", "--sort=-committerdate", "--count=80", "--format=%(refname:short)", "refs/remotes/origin"]).catch(() => "");
  const local = new Set((await git(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).catch(() => "")).split("\n").filter(Boolean));
  return raw
    .split("\n")
    .map((r) => r.trim().replace(/^origin\//, ""))
    .filter((n) => n && n !== "HEAD" && n !== "origin" && !local.has(n))
    .slice(0, 50);
}

/**
 * Move the folder to another branch.
 *
 * Uncommitted work is left where it is rather than carried over or stashed
 * behind your back — git refuses the switch when it would overwrite something,
 * and that refusal is the honest answer to give.
 */
export async function switchTo(cwd: string, branch: string, create = false): Promise<{ branch: string }> {
  if (!BRANCH_NAME.test(branch)) throw new Error(`"${branch}" isn't a branch name git accepts.`);
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]).then((s) => s.trim(), () => null);
  if (!root) throw new Error("This folder isn't a git repository.");
  const exists = await git(root, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]).then(() => true, () => false);
  if (exists && create) throw new Error(`There is already a branch called "${branch}".`);
  // Not here but on origin (somebody's pull request, say): take it from there rather than starting an empty one of the same name.
  // Without a stored login this fetch would open a sign-in window on a machine nobody is at, and wait: it is told not to.
  const onOrigin = !exists && !create && (await gitEnv(root, ["fetch", "origin", branch], { ...NO_PROMPT, ...(await authEnv()) }, { timeout: 60_000 }).then(() => git(root, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}`]).then(() => true, () => false), () => false));
  try {
    await git(root, exists ? ["switch", branch] : onOrigin ? ["switch", "--track", `origin/${branch}`] : ["switch", "-c", branch]);
  } catch (e) {
    throw new Error((e as Error).message.split("\n").slice(0, 3).join(" ").trim());
  }
  return { branch: (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim() };
}

/**
 * Commit, either the whole folder or the files that were named.
 *
 * Naming files is the difference between a commit and a snapshot: a run
 * usually touches more than the one thing you want to record, and "commit
 * everything" makes you clean up afterwards instead of choosing up front.
 */
export async function commitAll(cwd: string, message: string, branch?: string, only?: string[]): Promise<Committed> {
  const msg = message.trim();
  if (!msg) throw new Error("Write a commit message first.");
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]).then((s) => s.trim(), () => null);
  if (!root) throw new Error("This folder isn't a git repository, so there's nothing to commit to.");
  if (branch && !BRANCH_NAME.test(branch)) throw new Error(`"${branch}" isn't a branch name git accepts.`);
  if (only?.some((f) => f.startsWith("-") || f.includes("..") || f.includes("\0"))) throw new Error("That isn't a path in this folder.");
  // What the person had staged themselves, to give back once the commit is made (or isn't): it is theirs, not this
  // commit's. Null when the index can't be written as a tree (a merge in progress), which is left as it always was.
  const saved = await git(root, ["write-tree"]).then((s) => s.trim(), () => null);
  // Where the folder was, to go back to if the commit fails after the branch moved.
  const was = await git(root, ["symbolic-ref", "-q", "--short", "HEAD"]).then((s) => s.trim(), () => "");
  const wasAt = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]).then((s) => s.trim(), () => "");
  let made = "";
  try {
    // Only what was asked for goes in, so the rest stays in the working copy
    // rather than being swept into somebody else's commit.
    await git(root, ["reset", "-q"]);
    if (only?.length) {
      // A list read a moment ago can name a file that has gone since without ever being committed: git refuses the whole
      // commit over it. Gone from the folder and from the last commit, it has nothing to record, so it is left out.
      const tracked = new Set((await git(root, ["--literal-pathspecs", "ls-files", "-z", "--", ...only])).split("\0").filter(Boolean));
      const there = await Promise.all(only.map((f) => lstat(path.join(root, f)).then(() => true, () => tracked.has(f))));
      const named = only.filter((_, i) => there[i]);
      if (!named.length) throw new Error("There's nothing to commit — the files listed aren't in the folder any more.");
      // Literal: `app/[id].tsx` is one file, not a pattern that also takes `app/i.tsx` along.
      await git(root, ["--literal-pathspecs", "add", "-A", "--", ...named]);
    } else {
      await git(root, ["add", "-A", "--", ".", ":(exclude)friday-runner.mjs", ":(exclude)runner.log", ":(exclude).friday"]);
    }
    const staged = (await git(root, ["diff", "--cached", "--name-only", "--no-renames", "-z"])).split("\0").filter(Boolean);
    if (!staged.length) throw new Error("There's nothing to commit — the folder matches the last commit.");
    // The branch moves only once there is something to commit: a switch before that left the folder on a new branch the
    // session didn't know about, with nothing on it.
    if (branch) {
      const exists = await git(root, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]).then(() => true, () => false);
      await git(root, exists ? ["switch", branch] : ["switch", "-c", branch]);
      if (!exists) made = branch;
    }
    try {
      // Five minutes: room for a pre-commit hook that runs the tests, not forever for one that waits on a prompt.
      await git(root, ["commit", "-q", "-m", msg], [0], 300_000);
    } catch (e) {
      // A hook that said no leaves the folder where it was, not on a branch the session never heard of.
      if (branch) {
        await git(root, was ? ["switch", "-q", was] : ["switch", "-q", "--detach", wasAt]).catch(() => {});
        if (made) await git(root, ["branch", "-q", "-D", made]).catch(() => {});
      }
      const m = (e as Error).message;
      if (/tell me who you are|user\.email/i.test(m)) throw new Error("git doesn't know who you are on this machine. Run `git config --global user.name` and `user.email` there once, then commit again.");
      throw new Error(m.split("\n").slice(-3).join(" "));
    }
    // The person's other staged changes, staged again; the paths just committed match the commit. The commit is made by
    // now, so this can't fail it: at worst nothing is left staged, which is how it always was.
    // Only when the commit sits right on where the folder was: committed onto another existing branch, the saved index is
    // the old branch's, and reading it back would stage that branch's version of every file the two differ on.
    const parent = await git(root, ["rev-parse", "-q", "--verify", "HEAD^"]).then((s) => s.trim(), () => "");
    if (saved && parent === wasAt) {
      await git(root, ["read-tree", saved])
        .then(() => git(root, ["--literal-pathspecs", "reset", "-q", "HEAD", "--", ...staged]))
        .catch(() => git(root, ["reset", "-q"]).catch(() => {}));
    }
    const sha = (await git(root, ["rev-parse", "HEAD"])).trim();
    const current = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    return { sha, branch: current, files: staged.length };
  } catch (e) {
    if (saved) await git(root, ["read-tree", saved]).catch(() => {});
    throw e;
  }
}

/** The remote's default branch, as origin sees it. */
async function defaultBranch(root: string): Promise<string> {
  const head = await git(root, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]).then((s) => s.trim().replace(/^origin\//, ""), () => "");
  if (head) return head;
  for (const b of ["main", "master"]) if (await git(root, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${b}`]).then(() => true, () => false)) return b;
  return "main";
}

/** owner/repo for a GitHub remote, in any of the shapes a remote URL takes. */
export function githubSlug(remote: string): string | null {
  const m = remote.trim().match(/github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Where this folder would push to, for saying so before anyone presses the button. */
export async function remoteOf(cwd: string): Promise<{ url: string; github: string | null; branch: string }> {
  const url = (await git(cwd, ["remote", "get-url", "origin"]).catch(() => "")).trim();
  const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim();
  // Credentials in a remote URL are the one thing here that must never reach a browser. Up to the last "@" before the path:
  // a password can hold an "@" of its own, and stopping at the first left the rest of it in.
  const safe = url.replace(/\/\/[^/]*@/, "//");
  return { url: safe, github: githubSlug(url), branch: branch === "HEAD" ? "" : branch };
}

export interface Published {
  branch: string;
  pushed: boolean;
  /** What the pull request merges into: the default branch, or the branch below it in a stack. */
  base?: string;
  /** The pull request, or GitHub's page for opening one when it couldn't be created from here. */
  prUrl?: string;
  prCreated?: boolean;
  /** Why it couldn't be created from here, in gh's words, when it couldn't. */
  prError?: string;
}

/**
 * Push the current branch, and open a pull request for it if asked.
 *
 * `gh` creates the pull request when it is installed and logged in. When it
 * isn't, GitHub's own compare page is the next best thing: one click there,
 * with the branch already picked, instead of an error.
 */
export async function publish(cwd: string, opts: { pr: boolean; title: string; body?: string; /** Open the pull request onto this branch instead of the default one: a stacked pull request (Arun, 2026-10-25, tier 2). */ base?: string }): Promise<Published> {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
  if (!root) throw new Error("This folder isn't a git repository.");
  const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (branch === "HEAD") throw new Error("The folder isn't on a branch, so there's nothing to push. Commit to a new branch first.");
  const remote = (await git(root, ["remote", "get-url", "origin"]).catch(() => "")).trim();
  if (!remote) throw new Error("This repository has no remote called origin to push to.");
  const base = opts.base?.trim() || (await defaultBranch(root));
  if (opts.pr && branch === base) throw new Error(`You're on ${base}, which is what a pull request would merge into. Commit to a new branch to open one.`);

  try {
    // Three minutes: a big first push, not forever on a network that went away.
    await gitEnv(root, ["push", "-u", "origin", "HEAD"], { ...NO_PROMPT, ...(await authEnv()) }, { timeout: 180_000 });
  } catch (e) {
    const m = (e as Error).message;
    if (/could not read (Username|Password)|Authentication failed|terminal prompts disabled|permission denied/i.test(m)) {
      throw new Error("git couldn't sign in to the remote from this machine. Push once from a terminal there so it remembers the login, then try again.");
    }
    // Before the general "rejected": a protected branch is refused with that word too, and "pull first" is the wrong advice for it.
    if (/protected branch/i.test(m)) throw new Error(`${branch} is protected on the remote, so it can't be pushed to directly. Commit to a new branch and open a pull request.`);
    // Only git's own "behind" answers: `! [remote rejected]` is the remote saying no (a hook, a rule), which pulling doesn't
    // fix, so git's last lines say why instead.
    if (/non-fast-forward|fetch first|\[rejected\]/i.test(m)) throw new Error(`The remote ${branch} has commits this folder doesn't. Pull first, then push.`);
    throw new Error(m.split("\n").slice(-3).join(" "));
  }
  if (!opts.pr) return { branch, pushed: true };
  const onto = { base };

  const slug = githubSlug(remote);
  // The body goes through a file: a session's account of itself can run past what a command line holds (32 K characters
  // on Windows), and that failed silently. And gh's own reason for not opening the pull request is kept, so the person
  // reads why (not signed in, gh not installed, the base branch missing) instead of just getting GitHub's page.
  const bodyFile = path.join(tmpdir(), `friday-pr-${randomUUID()}.md`);
  await writeFile(bodyFile, opts.body ?? "");
  const auth = await authEnv();
  const { url: created, why } = await new Promise<{ url: string | null; why: string }>((resolve) => {
    execFile(
      "gh",
      ["pr", "create", "--head", branch, "--base", base, "--title", opts.title.slice(0, 250), "--body-file", bodyFile],
      { cwd: root, timeout: 60_000, env: { ...process.env, ...auth, GH_PROMPT_DISABLED: "1" }, windowsHide: true },
      (err, stdout, stderr) => {
        const out = `${stdout}\n${stderr}`;
        // Already open is as good as created: the link is what people want.
        const url = out.match(/https:\/\/\S+\/pull\/\d+/)?.[0] ?? null;
        const missing = !!err && (err as NodeJS.ErrnoException).code === "ENOENT";
        resolve({ url, why: url ? "" : missing ? "the GitHub CLI (gh) isn't installed on this machine" : String(stderr).trim().split("\n").filter(Boolean).slice(-2).join(" ") || err?.message || "" });
      },
    );
  }).finally(() => rm(bodyFile, { force: true }).catch(() => {}));
  if (created) return { branch, pushed: true, ...onto, prUrl: created, prCreated: true };
  if (!slug) return { branch, pushed: true, ...onto, ...(why ? { prError: why } : {}) };
  return { branch, pushed: true, ...onto, prUrl: `https://github.com/${slug}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`, prCreated: false, ...(why ? { prError: why } : {}) };
}

async function gh(cwd: string, args: string[]): Promise<string> {
  const auth = await authEnv();
  return new Promise((resolve, reject) => {
    execFile("gh", args, { cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...auth, GH_PROMPT_DISABLED: "1" }, windowsHide: true }, (err, stdout, stderr) => {
      // The stdout rides along with the error: `gh pr checks` exits non-zero to say a check failed, with the JSON still there.
      if (err) reject(Object.assign(new Error(String(stderr).trim().split("\n").slice(-2).join(" ") || err.message), { stdout: String(stdout) }));
      else resolve(stdout);
    });
  });
}

/** What reviewers have said on a pull request, through the gh this machine is already logged in with. */
export async function prFeedback(cwd: string, prUrl: string): Promise<{ comments: PrComment[] } | { error: string }> {
  const ref = parsePrUrl(prUrl);
  if (!ref) return { error: "That isn't a GitHub pull request link." };
  try {
    const view = JSON.parse(await gh(cwd, ["pr", "view", prUrl, "--json", "comments,reviews"]));
    const inline = JSON.parse(await gh(cwd, ["api", `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`, "--paginate"]).catch(() => "[]"));
    return { comments: mergeFeedback(view, Array.isArray(inline) ? inline : []) };
  } catch (e) {
    const m = (e as Error).message;
    return { error: /ENOENT|not found|command/i.test(m) && /gh/i.test(m) ? "The GitHub CLI (gh) isn't installed on this machine, so review comments can't be read." : m };
  }
}

/**
 * Where a pull request stands on GitHub, asked through the person's own `gh`: its state, review decision, checks and
 * whether it can be merged. Read-only. The answer is `gh`'s own JSON, which the server turns into the board's words.
 */
export async function prStatusJson(cwd: string, prUrl: string): Promise<Record<string, unknown> | { error: string }> {
  if (!parsePrUrl(prUrl)) return { error: "That isn't a GitHub pull request link." };
  try {
    return JSON.parse(await gh(cwd, ["pr", "view", prUrl, "--json", "state,isDraft,reviewDecision,statusCheckRollup,mergeable,mergeStateStatus"]));
  } catch (e) {
    const m = (e as Error).message;
    return { error: /ENOENT|not found|command/i.test(m) && /gh/i.test(m) ? "The GitHub CLI (gh) isn't installed on this machine." : m };
  }
}

/**
 * The checks that failed on a pull request, with the failing part of each one's log, through the person's own `gh`.
 * Read-only. A log is only there for GitHub Actions jobs, which is what most checks are; anything else is named with
 * its link. `pending` says how many are still running, so "nothing failed" can be told from "nothing finished".
 */
export async function prFailures(cwd: string, prUrl: string): Promise<{ failures: CheckFailure[]; pending: number } | { error: string }> {
  if (!parsePrUrl(prUrl)) return { error: "That isn't a GitHub pull request link." };
  try {
    // gh exits 8 when any check failed, which is the usual case here: the JSON is still on stdout.
    const raw = await gh(cwd, ["pr", "checks", prUrl, "--json", "name,workflow,link,bucket,state"]).catch((e: Error & { stdout?: string }) => e.stdout ?? "");
    const all = JSON.parse(raw || "[]") as { bucket?: string }[];
    const pending = Array.isArray(all) ? all.filter((c) => (c.bucket ?? "").toLowerCase() === "pending").length : 0;
    const failures = failedChecks(all).slice(0, 3);
    for (const f of failures) {
      if (!f.runId || !f.jobId) continue;
      const log = await gh(cwd, ["run", "view", f.runId, "--job", f.jobId, "--log-failed"]).catch(() => "");
      if (log.trim()) f.log = tailLog(log);
    }
    return { failures, pending };
  } catch (e) {
    const m = (e as Error).message;
    return { error: /ENOENT|not found|command/i.test(m) && /gh/i.test(m) ? "The GitHub CLI (gh) isn't installed on this machine, so the checks can't be read." : m };
  }
}

// ── The Git panel's operations (Arun, 2026-10-25: stage or discard by file or by hunk, history, pull, compare) ──────────────

export interface StatusEntry {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  from?: string;
}
export interface RepoStatus {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: StatusEntry[];
  unstaged: StatusEntry[];
  untracked: string[];
  conflicted: string[];
}

const STATUS_WORD: Record<string, StatusEntry["status"]> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "added", T: "modified" };

/** `git status --porcelain -z` read into staged, unstaged, untracked and conflicted files. Exported for its test. */
export function parseStatus(raw: string): Pick<RepoStatus, "staged" | "unstaged" | "untracked" | "conflicted"> {
  const out: Pick<RepoStatus, "staged" | "unstaged" | "untracked" | "conflicted"> = { staged: [], unstaged: [], untracked: [], conflicted: [] };
  const parts = raw.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const x = entry[0]!;
    const y = entry[1]!;
    const p = entry.slice(3);
    if (x === "?" && y === "?") {
      out.untracked.push(p);
      continue;
    }
    if (x === "!" && y === "!") continue;
    if ((x === "U" || y === "U") || (x === "A" && y === "A") || (x === "D" && y === "D")) {
      out.conflicted.push(p);
      continue;
    }
    // A rename or copy carries the old path in the next entry.
    const from = x === "R" || x === "C" || y === "R" || y === "C" ? parts[++i] : undefined;
    if (x !== " " && x !== "?") out.staged.push({ path: p, status: STATUS_WORD[x] ?? "modified", ...(from ? { from } : {}) });
    if (y !== " " && y !== "?") out.unstaged.push({ path: p, status: STATUS_WORD[y] ?? "modified", ...(from && !(x !== " ") ? { from } : {}) });
  }
  return out;
}

/** The folder's git status: its branch, how it stands to its upstream, and every changed file by where it is. */
export async function statusOf(cwd: string): Promise<RepoStatus> {
  const root = await toplevel(cwd);
  const [raw, branch, upstream] = await Promise.all([
    git(root, ["status", "--porcelain", "-z", "--untracked-files=all"]),
    git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).then((s) => s.trim(), () => "HEAD"),
    git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).then((s) => s.trim(), () => null),
  ]);
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const [a, b] = (await git(root, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]).catch(() => "0\t0")).trim().split(/\s+/);
    ahead = Number(a) || 0;
    behind = Number(b) || 0;
  }
  return { branch, upstream, ahead, behind, ...parseStatus(raw) };
}

export interface LogEntry {
  sha: string;
  author: string;
  /** Unix ms. */
  at: number;
  subject: string;
  /** Whether it has been pushed to the upstream, when there is one. */
  pushed?: boolean;
}

/** The last `limit` commits on the branch, newest first, each marked if the upstream has it. */
export async function logOf(cwd: string, limit = 30, path?: string): Promise<LogEntry[]> {
  const root = await toplevel(cwd);
  const n = Math.max(1, Math.min(200, Math.round(limit)));
  const raw = await git(root, ["log", "--no-color", "--date=unix", "--format=%H%x1f%an%x1f%ad%x1f%s", `-n${n}`, ...(path ? ["--", path] : [])]).catch(() => "");
  const unpushed = new Set((await git(root, ["rev-list", "@{u}..HEAD"]).catch(() => "")).split("\n").filter(Boolean));
  const hasUpstream = await git(root, ["rev-parse", "--abbrev-ref", "@{u}"]).then(() => true, () => false);
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", author = "", at = "0", subject = ""] = line.split("\x1f");
      return { sha, author, at: Number(at) * 1000, subject, ...(hasUpstream ? { pushed: !unpushed.has(sha) } : {}) };
    });
}

/** One commit's changes, as the Diff panel draws a run's. */
export async function showOf(cwd: string, sha: string): Promise<ChangeSet> {
  const root = await toplevel(cwd);
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error("Not a commit.");
  return capDiff(splitPatch(await git(root, ["show", "--no-color", "--no-ext-diff", "-M", "--format=", sha, "--"])));
}

/** The working files against the index, or (`staged`) the index against HEAD, for one file or all: what the Git panel stages by hunk. */
export async function gitDiffOf(cwd: string, staged: boolean, path?: string): Promise<ChangeSet> {
  const root = await toplevel(cwd);
  const head = await git(root, ["rev-parse", "--verify", "HEAD"]).then(() => true, () => false);
  const args = ["diff", "--no-color", "--no-ext-diff", "-M", ...(staged ? ["--cached", ...(head ? [] : [EMPTY_TREE])] : []), "--", ...(path ? [path] : [])];
  const files = splitPatch(await git(root, args));
  // An untracked file has no diff: shown as wholly new, so it can be read and staged like the rest.
  if (!staged && path) {
    const tracked = await git(root, ["ls-files", "--error-unmatch", "--", path]).then(() => true, () => false);
    if (!tracked && !files.length) {
      const text = await readFile(path.startsWith("/") ? path : `${root}/${path}`, "utf8").catch(() => "");
      const lines = text.split("\n");
      if (text.endsWith("\n")) lines.pop();
      const patch = `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;
      files.push({ path, status: "added", additions: lines.length, deletions: 0, patch });
    }
  }
  return capDiff(files);
}


const safePaths = (paths: string[]) => paths.map((p) => p.trim()).filter((p) => p && !p.startsWith("-") && !p.includes("..")).slice(0, 500);

export async function stageFiles(cwd: string, paths: string[]): Promise<{ staged: number }> {
  const root = await toplevel(cwd);
  const ps = safePaths(paths);
  if (!ps.length) throw new Error("Nothing to stage.");
  await git(root, ["add", "-A", "--", ...ps]);
  return { staged: ps.length };
}

export async function unstageFiles(cwd: string, paths: string[]): Promise<{ unstaged: number }> {
  const root = await toplevel(cwd);
  const ps = safePaths(paths);
  if (!ps.length) throw new Error("Nothing to unstage.");
  const head = await git(root, ["rev-parse", "--verify", "HEAD"]).then(() => true, () => false);
  if (head) await git(root, ["reset", "-q", "HEAD", "--", ...ps]);
  else await git(root, ["rm", "-r", "--cached", "-q", "--", ...ps]);
  return { unstaged: ps.length };
}

/** Changes to these files thrown away, staged or not; an untracked file only when asked (`untracked`), since nothing else keeps it. */
export async function discardFiles(cwd: string, paths: string[], untracked: boolean): Promise<{ discarded: number }> {
  const root = await toplevel(cwd);
  const ps = safePaths(paths);
  if (!ps.length) throw new Error("Nothing to discard.");
  const tracked = (await git(root, ["ls-files", "-z", "--", ...ps]).catch(() => "")).split("\0").filter(Boolean);
  if (tracked.length) await git(root, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked]).catch(() => git(root, ["checkout", "HEAD", "--", ...tracked]));
  const rest = ps.filter((p) => !tracked.includes(p));
  if (rest.length && untracked) await git(root, ["clean", "-f", "-q", "--", ...rest]);
  return { discarded: tracked.length + (untracked ? rest.length : 0) };
}

/** One hunk, with its file header, put into the index (`cached`), or taken out of the working files or the index (`reverse`). */
export async function applyPatch(cwd: string, patch: string, o: { cached?: boolean; reverse?: boolean }): Promise<{ applied: true }> {
  const root = await toplevel(cwd);
  if (!/^diff --git /m.test(patch) || !/^@@ /m.test(patch)) throw new Error("That isn't a hunk with its file header.");
  const file = path.join(tmpdir(), `friday-hunk-${randomUUID().slice(0, 12)}.patch`);
  await writeFile(file, patch.endsWith("\n") ? patch : `${patch}\n`);
  try {
    await git(root, ["apply", "--recount", "--whitespace=nowarn", ...(o.cached ? ["--cached"] : []), ...(o.reverse ? ["-R"] : []), file]);
  } finally {
    await rm(file, { force: true }).catch(() => {});
  }
  return { applied: true };
}

/** The upstream's new commits brought in, fast-forward only: a merge is a person's to do, with the conflicts in front of them. */
export async function pullOf(cwd: string): Promise<{ pulled: true; output: string }> {
  const root = await toplevel(cwd);
  const output = await git(root, ["pull", "--ff-only", "--no-rebase"], [0], 120_000);
  return { pulled: true, output: output.trim().slice(-2000) };
}

/** How the branch stands to another ref: commits each way, and the files that differ. */
export interface Compare {
  base: string;
  ahead: number;
  behind: number;
  files: number;
  additions: number;
  deletions: number;
  /** No branch of that name here, local or on origin (nor master, when main was asked): nothing to compare to. */
  missing?: true;
}

/**
 * How HEAD stands to a branch: commits each way, and the files and lines HEAD adds over it. The branch is found as named, then
 * on origin, and master stands in for main when there is no main (Arun, 2026-10-25: "fatal: ambiguous argument 'HEAD...main'"
 * in a folder whose main lives only on origin); when none of those exist the answer says so instead of failing.
 */
export async function compareOf(cwd: string, base: string): Promise<Compare> {
  const root = await toplevel(cwd);
  const asked = base.trim();
  if (!asked || asked.startsWith("-")) throw new Error("Which branch?");
  const names = asked === "main" ? ["main", "origin/main", "master", "origin/master"] : [asked, `origin/${asked}`];
  let ref: string | null = null;
  for (const n of names) {
    if (await git(root, ["rev-parse", "--verify", "--quiet", `${n}^{commit}`]).then(() => true, () => false)) {
      ref = n;
      break;
    }
  }
  if (!ref) return { base: asked, ahead: 0, behind: 0, files: 0, additions: 0, deletions: 0, missing: true };
  const [a, b] = (await git(root, ["rev-list", "--left-right", "--count", `HEAD...${ref}`])).trim().split(/\s+/);
  const stat = await git(root, ["diff", "--numstat", `${ref}...HEAD`, "--"]).catch(() => "");
  let additions = 0;
  let deletions = 0;
  let files = 0;
  for (const line of stat.split("\n").filter(Boolean)) {
    const [add, del] = line.split("\t");
    files++;
    additions += Number(add) || 0;
    deletions += Number(del) || 0;
  }
  return { base: ref.replace(/^origin\//, ""), ahead: Number(a) || 0, behind: Number(b) || 0, files, additions, deletions };
}
