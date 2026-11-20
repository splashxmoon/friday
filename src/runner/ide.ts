import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import type {
  IdeEntry,
  IdeFilesResult,
  IdeListManyResult,
  IdeListResult,
  IdeReadResult,
  IdeReplaceParams,
  IdeReplaceResult,
  IdeSearchFile,
  IdeSearchMatch,
  IdeSearchParams,
  IdeSearchResult,
  IdeStatsResult,
  IdeWriteResult,
} from "../ide-contract.js";
import type { IdeHandlers } from "./ide-ops.js";
import { IDE_FOLDER_GONE, IDE_FOLDER_MISSING } from "../ide-contract.js";

/**
 * Code's files and search on this computer (src/ide-contract.ts). Every op takes the folder the IDE has open (`root`) and
 * paths relative to it. Nothing here ever touches a path outside that folder: the page is trusted no further than the
 * contract, so each path is checked as text (no "..", no absolute or drive paths) and again on disk (a symlink that leads
 * out of the folder is refused).
 *
 * Search uses ripgrep when it is installed. Setting FRIDAY_IDE_NO_RG=1 forces the built-in Node search instead (the tests
 * run both, and it is the way to find out whether a difference comes from ripgrep).
 */

const MAX_LIST = 5000;
const MAX_FILES = 50_000;
const MAX_READ = 5 * 1024 * 1024;
const DEFAULT_MAX_MATCHES = 2000;
const MAX_LINE = 400;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next"]);
const GIT_TIMEOUT = 20_000;
/** Time limits for a search and a replace; the tests shorten them with FRIDAY_IDE_SEARCH_MS. */
const searchLimit = () => Number(process.env.FRIDAY_IDE_SEARCH_MS) || 30_000;
const replaceLimit = () => Number(process.env.FRIDAY_IDE_SEARCH_MS) || 120_000;
/** How long a trashed batch is kept before the next trashing sweeps it. */
const TRASH_KEEP_MS = 30 * 24 * 3600 * 1000;

// ── Paths ───────────────────────────────────────────────────────────────────────

const toPosix = (p: string) => (path.sep === "/" ? p : p.split(path.sep).join("/"));

function isInside(root: string, p: string, pm: typeof path = path): boolean {
  const rel = pm.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !pm.isAbsolute(rel));
}

/**
 * Whether moving `from` to `to` puts a folder inside itself: only a place below it counts. Windows' path.relative ignores letter
 * case, so a case-only rename (other.txt to Other.txt) is the same place there, and that is a rename, not a move into itself.
 */
export function movesIntoItself(from: string, to: string, pm: typeof path = path): boolean {
  return pm.relative(from, to) !== "" && isInside(from, to, pm);
}

/** The folder's real path, or an error when it is not an absolute, existing folder. The real path (symlinks resolved) is what every later check compares against. */
export async function openRoot(root: unknown): Promise<string> {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("The folder must be an absolute path.");
  let real: string;
  try {
    real = await fs.realpath(root);
    if (!(await fs.stat(real)).isDirectory()) throw new Error("not a folder");
  } catch {
    throw new Error(`${IDE_FOLDER_MISSING}: ${root}`);
  }
  return real;
}

/** A relative path as "/"-separated segments, refusing anything that could leave the folder. */
export function cleanRel(rel: unknown, opts: { allowEmpty?: boolean } = {}): string[] {
  if (typeof rel !== "string") throw new Error("A path is needed.");
  if (rel.includes("\0")) throw new Error("The path has a null character.");
  const s = path.sep === "\\" ? rel.replace(/\\/g, "/") : rel;
  if (s.startsWith("/") || /^[a-zA-Z]:/.test(s)) throw new Error(`The path must be inside the folder: ${rel}`);
  const segs = s.split("/").filter((x) => x !== "" && x !== ".");
  if (segs.includes("..")) throw new Error(`The path must be inside the folder: ${rel}`);
  if (!segs.length && !opts.allowEmpty) throw new Error("A path is needed.");
  return segs;
}

/**
 * Where a path really is on disk, checked to be inside the folder. Walks up to the nearest part that exists and resolves
 * symlinks there, so a new file under a linked folder that leads outside is refused too. `followLast` false is for
 * rename and delete, which act on a link itself rather than on what it points to.
 */
export async function resolveIn(rootReal: string, segs: string[], followLast: boolean): Promise<string> {
  const full = path.join(rootReal, ...segs);
  let probe = followLast ? full : path.dirname(full);
  const tail: string[] = [];
  for (;;) {
    let exists = true;
    try {
      await fs.lstat(probe);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" && (e as NodeJS.ErrnoException).code !== "ENOTDIR") throw e;
      exists = false;
    }
    if (exists) {
      let real: string;
      try {
        real = await fs.realpath(probe);
      } catch {
        // A link that leads nowhere could be created through: never follow one.
        throw new Error(`The path leads outside the folder: ${segs.join("/")}`);
      }
      if (!isInside(rootReal, real)) throw new Error(`The path leads outside the folder: ${segs.join("/")}`);
      const base = path.join(real, ...tail);
      return followLast ? base : path.join(base, path.basename(full));
    }
    if (probe === rootReal || probe === path.dirname(probe)) throw new Error(`${IDE_FOLDER_GONE}.`);
    tail.unshift(path.basename(probe));
    probe = path.dirname(probe);
  }
}

/**
 * Any segment named .git (in any letter case: macOS and Windows disks are case-insensitive, so ".GIT/hooks/pre-commit" is the
 * same place) is git's own, whether it is the repository's or a submodule's or a nested clone's.
 */
function notGit(segs: string[]) {
  if (segs.some((x) => x.toLowerCase() === ".git")) throw new Error("The .git folder is git's own: change it with git, not here.");
}

// ── Running things ──────────────────────────────────────────────────────────────

interface RunResult { code: number; stdout: string; stderr: string }

/** Runs a program (never through a shell) and gives its output; a failing exit is a code, not a throw. */
function run(cmd: string, args: string[], opts: { cwd: string; input?: string; timeout?: number }): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeout ?? GIT_TIMEOUT, maxBuffer: 512 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException).code === "number" ? ((err as NodeJS.ErrnoException).code as unknown as number) : -1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.input ?? "");
  });
}

/**
 * Whether the folder is inside a git work tree. A "yes" is remembered for a few seconds and calls in flight are shared: the
 * tree re-lists every open folder after each change, and each of those lists would otherwise spawn its own `git rev-parse`.
 * A "no" is never remembered, so a `git init` shows at once.
 */
const repoYes = new Map<string, number>();
const repoPending = new Map<string, Promise<boolean>>();
const REPO_YES_MS = 5000;
function isRepo(root: string): Promise<boolean> {
  const at = repoYes.get(root);
  if (at !== undefined && Date.now() - at < REPO_YES_MS) return Promise.resolve(true);
  let p = repoPending.get(root);
  if (!p) {
    p = run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root })
      .then((r) => {
        const yes = r.code === 0 && r.stdout.trim() === "true";
        if (yes) repoYes.set(root, Date.now());
        else repoYes.delete(root);
        return yes;
      })
      .finally(() => repoPending.delete(root));
    repoPending.set(root, p);
  }
  return p;
}

// ── list ────────────────────────────────────────────────────────────────────────

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
const byName = (a: { name: string }, b: { name: string }) => collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

async function listIn(root: string, dirRel: unknown): Promise<IdeListResult> {
  const segs = cleanRel(dirRel ?? "", { allowEmpty: true });
  const abs = await resolveIn(root, segs, true);
  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const rel = segs.join("/");
  const entries: IdeEntry[] = [];
  await Promise.all(
    dirents
      .filter((d) => d.name.toLowerCase() !== ".git")
      .map(async (d) => {
        const isLink = d.isSymbolicLink();
        let kind: IdeEntry["kind"] = isLink ? "link" : d.isDirectory() ? "dir" : "file";
        let size = 0;
        if (isLink) {
          // A link shows as what it points to, so a linked folder opens in the tree; one that leads outside or nowhere stays a "link".
          try {
            const real = await fs.realpath(path.join(abs, d.name));
            if (isInside(root, real)) {
              const st = await fs.stat(real);
              kind = st.isDirectory() ? "dir" : "file";
              if (kind === "file") size = st.size;
            }
          } catch {
            /* a broken link */
          }
        } else if (kind === "file") {
          try {
            size = (await fs.stat(path.join(abs, d.name))).size;
          } catch {
            /* vanished while listing: leave size 0 */
          }
        }
        entries.push({ name: d.name, path: rel ? `${rel}/${d.name}` : d.name, kind, size, ignored: false, ...(isLink ? { link: true } : {}) });
      }),
  );
  entries.sort((a, b) => {
    const da = a.kind === "dir" ? 0 : 1;
    const db = b.kind === "dir" ? 0 : 1;
    return da - db || byName(a, b);
  });
  const truncated = entries.length > MAX_LIST;
  const capped = entries.slice(0, MAX_LIST);
  if (capped.length && (await isRepo(root))) {
    // The paths git is asked about are relative to the folder it runs in, with a slash after a folder so "build/" patterns match.
    const asked = capped.map((e) => (e.kind === "dir" ? `${e.path}/` : e.path));
    const r = await run("git", ["check-ignore", "--stdin", "-z"], { cwd: root, input: asked.join("\0") + "\0" });
    if (r.code === 0 || r.code === 1) {
      const hit = new Set(r.stdout.split("\0").filter(Boolean).map((x) => x.replace(/\/$/, "")));
      for (const e of capped) if (hit.has(e.path)) e.ignored = true;
    }
  }
  return truncated ? { entries: capped, truncated: true } : { entries: capped };
}

async function list(p: { root: string; dir: string }): Promise<IdeListResult> {
  return listIn(await openRoot(p.root), p.dir);
}

/** Several folders in one call, four at a time, so a burst of changes never means dozens of git processes at once. */
async function listMany(p: { root: string; dirs: string[] }): Promise<IdeListManyResult> {
  const root = await openRoot(p.root);
  const dirs = [...new Set(Array.isArray(p.dirs) ? p.dirs : [])].slice(0, 500);
  const results: IdeListManyResult["results"] = {};
  let next = 0;
  const lane = async () => {
    while (next < dirs.length) {
      const d = dirs[next++]!;
      try {
        results[d] = await listIn(root, d);
      } catch {
        /* a folder that is gone or refused is left out */
      }
    }
  };
  await Promise.all([lane(), lane(), lane(), lane()]);
  return { results };
}

// ── read / write ────────────────────────────────────────────────────────────────

function countEol(text: string): { crlf: number; lf: number } {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  return { crlf, lf };
}

function detectEol(text: string): "lf" | "crlf" {
  const { crlf, lf } = countEol(text);
  return crlf > lf ? "crlf" : "lf";
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The text of some bytes when they are valid UTF-8 (a BOM kept as a character), else null. */
function decodeUtf8(buf: Buffer): string | null {
  try {
    return strictUtf8.decode(buf);
  } catch {
    return null;
  }
}

async function read(p: { root: string; path: string }): Promise<IdeReadResult> {
  const root = await openRoot(p.root);
  const abs = await resolveIn(root, cleanRel(p.path), true);
  const st = await fs.stat(abs);
  if (st.isDirectory()) throw new Error("That is a folder, not a file.");
  const base = { size: st.size, mtime: st.mtimeMs };
  if (st.size > MAX_READ) return { text: "", binary: false, tooBig: true, eol: "lf", ...base };
  const buf = await fs.readFile(abs);
  if (buf.subarray(0, 8192).includes(0)) return { text: "", binary: true, tooBig: false, eol: "lf", ...base };
  // Not valid UTF-8 (Windows-1252, Shift-JIS, GBK...): shown one byte per character and saved the same way, so a save or a
  // Replace can never turn its bytes into U+FFFD.
  const utf8 = decodeUtf8(buf);
  const raw = utf8 ?? buf.toString("latin1");
  const { crlf, lf } = countEol(raw);
  const eol = crlf > lf ? "crlf" : "lf";
  // The editor works in "\n"; the file's own line endings come back on save (write's `eol`).
  return {
    text: crlf ? raw.replace(/\r\n/g, "\n") : raw,
    binary: false,
    tooBig: false,
    eol,
    ...(crlf && lf ? { mixedEol: true } : {}),
    ...(utf8 === null ? { encoding: "latin1" as const } : {}),
    ...base,
  };
}

/** True for the errors a rename over a file in use gives on Windows (antivirus, a language server holding it open). */
const isBusy = (e: unknown) => ["EPERM", "EBUSY", "EACCES"].includes((e as NodeJS.ErrnoException).code ?? "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Writes through a temp file in the same folder and renames it over the target, so a crash never leaves half a file. Keeps the
 * file's permissions. When the rename keeps failing because another program has the file open (Windows), the content is
 * written in place instead: less safe against a crash, but the save goes through.
 */
async function writeAtomic(target: string, data: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  let mode: number | undefined;
  try {
    mode = (await fs.stat(target)).mode & 0o7777;
  } catch {
    /* a new file */
  }
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await fs.writeFile(tmp, data, mode === undefined ? undefined : { mode });
    if (mode !== undefined) await fs.chmod(tmp, mode).catch(() => {});
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmp, target);
        return;
      } catch (e) {
        if (!isBusy(e)) throw e;
        if (attempt >= 4) {
          await fs.writeFile(target, data);
          await fs.rm(tmp, { force: true }).catch(() => {});
          return;
        }
        await sleep(40 * (attempt + 1));
      }
    }
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

function withEol(text: string, eol?: "lf" | "crlf"): string {
  if (eol === "crlf") return text.replace(/\r?\n/g, "\r\n");
  if (eol === "lf") return text.replace(/\r\n/g, "\n");
  return text;
}

/**
 * Text for a file that mixes line endings: lines at the start and end that did not change keep their own ending, so a
 * one-line edit is a one-line diff; lines in between that were edited in place keep theirs, and added ones take the file's most common ending.
 */
function mergeEol(oldRaw: string, text: string, majority: "lf" | "crlf"): string {
  const oldParts = oldRaw.split("\n");
  const oldBody = oldParts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const oldCr = oldParts.map((l) => l.endsWith("\r"));
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let pre = 0;
  while (pre < lines.length - 1 && pre < oldBody.length - 1 && lines[pre] === oldBody[pre]) pre++;
  let suf = 0;
  while (suf < lines.length - 1 - pre && suf < oldBody.length - 1 - pre && lines[lines.length - 2 - suf] === oldBody[oldBody.length - 2 - suf]) suf++;
  // Lines edited in place (as many in between as before) keep their own endings too.
  const sameCount = lines.length - pre - suf === oldBody.length - pre - suf;
  const eolAt = (j: number): string => {
    let cr = majority === "crlf";
    if (j < pre) cr = oldCr[j]!;
    else if (j >= lines.length - 1 - suf) cr = oldCr[oldBody.length - 1 - (lines.length - 1 - j)]!;
    else if (sameCount) cr = oldCr[j]!;
    return cr ? "\r\n" : "\n";
  };
  let out = "";
  for (let j = 0; j < lines.length; j++) out += j < lines.length - 1 ? lines[j] + eolAt(j) : lines[j];
  return out;
}

async function write(p: { root: string; path: string; text: string; mtime?: number; size?: number; eol?: "lf" | "crlf"; encoding?: "utf8" | "latin1" }): Promise<IdeWriteResult> {
  const root = await openRoot(p.root);
  const segs = cleanRel(p.path);
  notGit(segs);
  if (typeof p.text !== "string") throw new Error("The text is missing.");
  const abs = await resolveIn(root, segs, true);
  let st: Awaited<ReturnType<typeof fs.stat>> | null = null;
  try {
    st = await fs.stat(abs);
  } catch {
    /* new file, or deleted meanwhile: written either way */
  }
  if (st?.isDirectory()) throw new Error("That is a folder, not a file.");
  if (st && ((typeof p.mtime === "number" && Math.abs(st.mtimeMs - p.mtime) > 1) || (typeof p.size === "number" && st.size !== p.size))) {
    return { mtime: st.mtimeMs, size: st.size, conflict: true };
  }
  let text = p.text;
  let encoding = p.encoding;
  if (st && st.size <= MAX_READ) {
    // The file as it is now tells how to write the new text: its encoding when the page did not say, its line endings line by line when it mixes them.
    let old: Buffer | null = null;
    try {
      old = await fs.readFile(abs);
    } catch {
      /* unreadable: written as asked */
    }
    if (old) {
      const utf8 = decodeUtf8(old);
      if (encoding === undefined && utf8 === null && !old.subarray(0, 8192).includes(0)) encoding = "latin1";
      const oldRaw = utf8 ?? old.toString("latin1");
      const { crlf, lf } = countEol(oldRaw);
      if (crlf && lf) text = mergeEol(oldRaw, text, crlf > lf ? "crlf" : "lf");
      else text = withEol(text, p.eol);
    } else text = withEol(text, p.eol);
  } else text = withEol(text, p.eol);
  let data: string | Buffer = text;
  if (encoding === "latin1") {
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) > 0xff) throw new Error("This file is not UTF-8, so it can only hold Latin-1 characters. Remove the others, or re-save it as UTF-8 outside Code.");
    }
    data = Buffer.from(text, "latin1");
  }
  await writeAtomic(abs, data);
  const after = await fs.stat(abs);
  return { mtime: after.mtimeMs, size: after.size };
}

// ── create / rename / delete ────────────────────────────────────────────────────

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function create(p: { root: string; path: string; kind: "file" | "dir" }) {
  const root = await openRoot(p.root);
  const segs = cleanRel(p.path);
  notGit(segs);
  const abs = await resolveIn(root, segs, false);
  if (await exists(abs)) throw new Error(`${segs.join("/")} already exists.`);
  await fs.mkdir(p.kind === "dir" ? abs : path.dirname(abs), { recursive: true });
  if (p.kind !== "dir") await fs.writeFile(abs, "", { flag: "wx" });
  return { ok: true as const };
}

async function rename(p: { root: string; from: string; to: string }) {
  const root = await openRoot(p.root);
  const from = cleanRel(p.from);
  const to = cleanRel(p.to);
  notGit(from);
  notGit(to);
  const a = await resolveIn(root, from, false);
  const b = await resolveIn(root, to, false);
  if (!(await exists(a))) throw new Error(`${from.join("/")} does not exist.`);
  if (isInside(a, b) && a !== b) throw new Error("A folder cannot be moved into itself.");
  if (a !== b && (await exists(b))) {
    // A case-only rename (Readme to README) looks like "already exists" on a case-insensitive disk: it is the same file then.
    const [sa, sb] = await Promise.all([fs.lstat(a), fs.lstat(b)]);
    if (!(a.toLowerCase() === b.toLowerCase() && sa.ino === sb.ino && sa.dev === sb.dev)) throw new Error(`${to.join("/")} already exists.`);
  }
  await fs.mkdir(path.dirname(b), { recursive: true });
  await fs.rename(a, b);
  return { ok: true as const };
}

/** Friday's trash for the IDE: where deleted, discarded and replaced-over things wait. Honours FRIDAY_HOME, as the rest of Friday does. */
export function trashFolder(): string {
  const home = process.env.FRIDAY_HOME || path.join(os.homedir(), ".friday");
  return path.join(home, "trash", "ide");
}

let lastSweep = 0;
/** Removes trashed batches older than a month. Best effort and at most once an hour: it never delays or fails the trashing itself. */
export function sweepTrash(): void {
  const now = Date.now();
  if (now - lastSweep < 3600_000) return;
  lastSweep = now;
  const dir = trashFolder();
  void (async () => {
    for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
      const m = /^(\d{13})-/.exec(name);
      if (m && now - Number(m[1]) > TRASH_KEEP_MS) await fs.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
    }
  })();
}

/** A new, empty batch folder in the trash ("<time>-<what>-<random>"), for copies of files about to be changed. */
export async function newTrashBatch(what: string): Promise<string> {
  sweepTrash();
  const batch = path.join(trashFolder(), `${Date.now()}-${what}-${randomBytes(3).toString("hex")}`);
  await fs.mkdir(batch, { recursive: true });
  return batch;
}

/** Moves a file or folder out of the project to the trash folder, across disks too (copy then remove). */
async function moveToTrash(abs: string): Promise<string> {
  const dir = trashFolder();
  await fs.mkdir(dir, { recursive: true });
  sweepTrash();
  const stamp = Date.now();
  let dest = path.join(dir, `${stamp}-${path.basename(abs)}`);
  for (let n = 2; await exists(dest); n++) dest = path.join(dir, `${stamp}-${n}-${path.basename(abs)}`);
  try {
    await fs.rename(abs, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    await fs.cp(abs, dest, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
    await fs.rm(abs, { recursive: true, force: true });
  }
  return dest;
}

async function del(p: { root: string; path: string }) {
  const root = await openRoot(p.root);
  const segs = cleanRel(p.path);
  notGit(segs);
  const abs = await resolveIn(root, segs, false);
  if (!(await exists(abs))) throw new Error(`${segs.join("/")} does not exist.`);
  return { ok: true as const, trashed: await moveToTrash(abs) };
}

// ── files / stats ───────────────────────────────────────────────────────────────

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [""];
  while (stack.length && out.length <= MAX_FILES) {
    const rel = stack.pop()!;
    let dirents;
    try {
      dirents = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) stack.push(r);
      } else if (d.isFile()) out.push(r);
    }
  }
  return out.sort();
}

async function allFiles(root: string): Promise<IdeFilesResult> {
  let files: string[];
  if (await isRepo(root)) {
    const [a, gone] = await Promise.all([
      run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, timeout: 60_000 }),
      run("git", ["ls-files", "--deleted", "-z"], { cwd: root, timeout: 60_000 }),
    ]);
    const deleted = new Set(gone.stdout.split("\0").filter(Boolean));
    files = [...new Set(a.stdout.split("\0").filter(Boolean))].filter((f) => !deleted.has(f)).sort();
  } else files = await walk(root);
  const truncated = files.length > MAX_FILES;
  return { files: truncated ? files.slice(0, MAX_FILES) : files, truncated };
}

async function files(p: { root: string }): Promise<IdeFilesResult> {
  return allFiles(await openRoot(p.root));
}

async function stats(p: { root: string; paths: string[] }): Promise<IdeStatsResult> {
  const root = await openRoot(p.root);
  const out: IdeStatsResult["stats"] = {};
  await Promise.all(
    (Array.isArray(p.paths) ? p.paths : []).map(async (rel) => {
      try {
        const st = await fs.stat(await resolveIn(root, cleanRel(rel), true));
        out[rel] = { mtime: st.mtimeMs, size: st.size };
      } catch {
        out[rel] = null;
      }
    }),
  );
  return { stats: out };
}

// ── search ──────────────────────────────────────────────────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The search as one JS regex (global): the Node search and replace use it; ripgrep gets the flags instead. */
function searchRegex(p: IdeSearchParams): RegExp {
  let src = p.regex ? p.query : escapeRe(p.query);
  if (p.wholeWord) src = `(?<![\\w])(?:${src})(?![\\w])`;
  return new RegExp(src, p.caseSensitive ? "gu" : "giu");
}

function splitGlobs(s?: string): string[] {
  return (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
}

/** A comma-list of globs as a test on a relative path, git-style: a name without a slash matches at any depth, a folder matches what is inside it. */
function globTester(list: string[]): ((rel: string) => boolean) | null {
  if (!list.length) return null;
  const res = list.map((g) => {
    const anchored = g.startsWith("/") || g.replace(/\/+$/, "").includes("/");
    let body = g.replace(/^\/+/, "").replace(/\/+$/, "");
    let re = "";
    for (let i = 0; i < body.length; i++) {
      const c = body[i]!;
      if (c === "*") {
        if (body[i + 1] === "*") {
          i++;
          if (body[i + 1] === "/") {
            i++;
            re += "(?:.*/)?";
          } else re += ".*";
        } else re += "[^/]*";
      } else if (c === "?") re += "[^/]";
      else re += escapeRe(c);
    }
    return new RegExp(`${anchored ? "^" : "(?:^|/)"}${re}(?:/|$)`);
  });
  return (rel) => res.some((r) => r.test(rel));
}

let rgProbe: Promise<boolean> | null = null;
function hasRg(): Promise<boolean> {
  if (process.env.FRIDAY_IDE_NO_RG) return Promise.resolve(false);
  rgProbe ??= run("rg", ["--version"], { cwd: os.tmpdir(), timeout: 5000 }).then((r) => r.code === 0);
  return rgProbe;
}

function collect(byFile: Map<string, IdeSearchMatch[]>, total: number, truncated: boolean): IdeSearchResult {
  const files: IdeSearchFile[] = [...byFile.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([file, matches]) => ({ path: file, matches: matches.sort((a, b) => a.line - b.line || a.col - b.col) }));
  return { files, total, truncated };
}

/** One running search: a newer search of the same folder cancels it (see `search`). */
interface Cancel { cancelled: boolean; stop: (() => void) | null }
const EMPTY_CANCELLED: IdeSearchResult = { files: [], total: 0, truncated: false, cancelled: true };

async function searchRg(root: string, p: IdeSearchParams, max: number, repo: boolean, ctl: Cancel): Promise<IdeSearchResult> {
  const args = ["--json", "--no-config", "--hidden", "--no-require-git", "--max-filesize", "5M", "-g", "!.git"];
  if (!repo) for (const d of SKIP_DIRS) args.push("-g", `!${d}`);
  for (const g of splitGlobs(p.include)) args.push("-g", g);
  for (const g of splitGlobs(p.exclude)) args.push("-g", g.startsWith("!") ? g.slice(1) : `!${g}`);
  args.push(p.caseSensitive ? "-s" : "-i");
  if (p.wholeWord) args.push("-w");
  if (!p.regex) args.push("-F");
  args.push("-e", p.query);
  return new Promise((resolve, reject) => {
    const child = spawn("rg", args, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const byFile = new Map<string, IdeSearchMatch[]>();
    let total = 0;
    let truncated = false;
    let buf = "";
    let err = "";
    let done = false;
    // Out of time counts as a cut result, not a complete one.
    const timer = setTimeout(() => {
      truncated = true;
      child.kill();
    }, searchLimit());
    ctl.stop = () => child.kill();
    const line = (l: string) => {
      if (!l || done) return;
      let ev: { type: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number; submatches?: { start: number; end: number }[] } };
      try {
        ev = JSON.parse(l);
      } catch {
        return;
      }
      if (ev.type !== "match" || !ev.data?.path?.text || ev.data.lines?.text === undefined) return;
      const file = toPosix(ev.data.path.text).replace(/^\.\//, "");
      const full = ev.data.lines.text;
      const shown = full.replace(/\r?\n$/, "").slice(0, MAX_LINE);
      // ripgrep counts bytes; columns here count characters. The line is encoded once and walked forward, so a minified
      // line with thousands of hits costs one pass, not one copy of the line per hit.
      const bytes = Buffer.from(full);
      let bytePos = 0;
      let charPos = 0;
      for (const m of ev.data.submatches ?? []) {
        if (total >= max) {
          truncated = true;
          done = true;
          child.kill();
          return;
        }
        charPos += bytes.subarray(bytePos, m.start).toString().length;
        const len = bytes.subarray(m.start, m.end).toString().length;
        const list = byFile.get(file) ?? [];
        list.push({ line: ev.data.line_number ?? 0, col: charPos, length: len, text: shown });
        byFile.set(file, list);
        total++;
        charPos += len;
        bytePos = m.end;
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        line(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (ctl.cancelled) return resolve(EMPTY_CANCELLED);
      line(buf);
      // Exit 2 with nothing found is a bad pattern (unreadable files alone still leave their matches).
      if (code === 2 && !done && !truncated && total === 0 && err.trim()) return reject(new Error(err.trim().split("\n")[0]!.replace(/^rg: /, "")));
      resolve(collect(byFile, total, truncated));
    });
  });
}

// ── The Node search and replace run in a worker ─────────────────────────────────
//
// A person's regex can take forever on the wrong text ((a+)+$ on 33 characters is minutes), and JavaScript cannot interrupt a
// regex that is running. On the runner's own thread that would freeze every agent's stream and the terminal, so the scanning
// happens in a worker thread that is terminated at a deadline or when a newer search replaces it. The worker is plain
// JavaScript in a string so it needs no file next to this one (the runner ships as one signed bundle).

const WORKER_SRC = String.raw`
const { parentPort, workerData: d } = require("node:worker_threads");
const fs = require("node:fs");
const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const re = new RegExp(d.source, d.flags);
function expand(rep, match, caps, offset, whole, groups) {
  return rep.replace(/\$(\$|&|\x60|'|\d{1,2}|<[^>]*>)/g, function (all, t) {
    if (t === "$") return "$";
    if (t === "&") return match;
    if (t === "\x60") return whole.slice(0, offset);
    if (t === "'") return whole.slice(offset + match.length);
    if (t[0] === "<") return groups ? (groups[t.slice(1, -1)] === undefined ? "" : groups[t.slice(1, -1)]) : all;
    var n = Number(t);
    if (n >= 1 && n <= caps.length) return caps[n - 1] === undefined ? "" : caps[n - 1];
    if (t.length === 2) {
      var one = Number(t[0]);
      if (one >= 1 && one <= caps.length) return (caps[one - 1] === undefined ? "" : caps[one - 1]) + t[1];
    }
    return all;
  });
}
var total = 0;
for (var k = 0; k < d.items.length; k++) {
  var it = d.items[k], st, buf;
  try {
    st = fs.lstatSync(it.abs);
    if (!st.isFile() || st.size > d.maxRead) continue;
    buf = fs.readFileSync(it.abs);
  } catch (e) { continue; }
  if (buf.subarray(0, 8192).includes(0)) continue;
  if (d.mode === "search") {
    var lines = buf.toString("utf8").split("\n"), found = [];
    for (var i = 0; i < lines.length; i++) {
      var text = lines[i].replace(/\r$/, "");
      re.lastIndex = 0;
      for (var m = re.exec(text); m; m = re.exec(text)) {
        if (m[0] === "") { re.lastIndex++; continue; }
        found.push({ line: i + 1, col: m.index, length: m[0].length, text: text.slice(0, d.maxLine) });
      }
    }
    if (found.length) {
      parentPort.postMessage({ t: "file", rel: it.rel, matches: found });
      total += found.length;
      if (total > d.max) break;
    }
  } else {
    var raw;
    try { raw = dec.decode(buf); } catch (e) { parentPort.postMessage({ t: "skip", rel: it.rel, reason: "not UTF-8" }); continue; }
    var parts = raw.split("\n"), n = 0;
    var out = parts.map(function (line) {
      var cr = line.endsWith("\r");
      var body = cr ? line.slice(0, -1) : line;
      re.lastIndex = 0;
      var next = body.replace(re, function () {
        var args = Array.prototype.slice.call(arguments), mt = args[0];
        if (mt === "") return mt;
        n++;
        if (!d.regex) return d.replacement;
        var groups = typeof args[args.length - 1] === "object" ? args[args.length - 1] : undefined;
        var tail = groups ? 3 : 2;
        return expand(d.replacement, mt, args.slice(1, args.length - tail), args[args.length - tail], body, groups);
      });
      return cr ? next + "\r" : next;
    });
    if (n) parentPort.postMessage({ t: "rep", rel: it.rel, abs: it.abs, text: out.join("\n"), n: n, mtime: st.mtimeMs });
  }
}
parentPort.postMessage({ t: "done" });
`;

interface WorkItem { rel: string; abs: string }
type WorkerMsg =
  | { t: "file"; rel: string; matches: IdeSearchMatch[] }
  | { t: "skip"; rel: string; reason: string }
  | { t: "rep"; rel: string; abs: string; text: string; n: number; mtime: number }
  | { t: "done" };

/**
 * Runs the scanning worker over `items`, handing each message to `onMsg` in order (one at a time, so a handler may write files).
 * Resolves with how it ended: "done", "timeout" (terminated at the deadline: what came so far stands) or "cancelled".
 */
function runWorker(
  data: Record<string, unknown> & { items: WorkItem[] },
  onMsg: (m: WorkerMsg) => void | Promise<void>,
  timeoutMs: number,
  ctl?: Cancel,
): Promise<"done" | "timeout" | "cancelled"> {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER_SRC, { eval: true, workerData: { maxRead: MAX_READ, maxLine: MAX_LINE, ...data } });
    let queue: Promise<void> = Promise.resolve();
    let ended: "done" | "timeout" | "cancelled" | null = null;
    const finish = (how: "done" | "timeout" | "cancelled", err?: unknown) => {
      if (ended) return;
      ended = how;
      clearTimeout(timer);
      void w.terminate();
      queue.then(() => (err ? reject(err) : resolve(how)), reject);
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    if (ctl) ctl.stop = () => finish("cancelled");
    w.on("message", (m: WorkerMsg) => {
      if (ended) return;
      if (m.t === "done") {
        // "done" is queued behind the file messages so every one of them has been handled first.
        ended = "done";
        clearTimeout(timer);
        queue.then(() => resolve("done"), reject);
        void w.terminate();
        return;
      }
      queue = queue.then(() => onMsg(m));
      queue.catch(() => {});
    });
    w.on("error", (e) => finish("done", e));
  });
}

async function searchNode(root: string, p: IdeSearchParams, max: number, ctl: Cancel): Promise<IdeSearchResult> {
  const inc = globTester(splitGlobs(p.include));
  const exc = globTester(splitGlobs(p.exclude));
  const { files: all } = await allFiles(root);
  if (ctl.cancelled) return EMPTY_CANCELLED;
  const items = all.filter((f) => (!inc || inc(f)) && (!exc || !exc(f))).map((rel) => ({ rel, abs: path.join(root, rel) }));
  const byFile = new Map<string, IdeSearchMatch[]>();
  let total = 0;
  const re = searchRegex(p);
  const how = await runWorker(
    { mode: "search", items, source: re.source, flags: re.flags, max },
    (m) => {
      if (m.t !== "file") return;
      byFile.set(m.rel, m.matches);
      total += m.matches.length;
    },
    searchLimit(),
    ctl,
  );
  if (how === "cancelled" || ctl.cancelled) return EMPTY_CANCELLED;
  let truncated = how === "timeout";
  if (total > max) {
    truncated = true;
    // Keep the first `max` matches in path order, as ripgrep's cut would be.
    let left = max;
    for (const k of [...byFile.keys()].sort()) {
      const m = byFile.get(k)!;
      if (left <= 0) byFile.delete(k);
      else if (m.length > left) {
        byFile.set(k, m.slice(0, left));
        left = 0;
      } else left -= m.length;
    }
    total = max;
  }
  return collect(byFile, total, truncated);
}

/** The search that is running for each folder: typing in the search box starts a new one every pause, and only the newest matters. */
const running = new Map<string, Cancel>();

async function search(p: IdeSearchParams): Promise<IdeSearchResult> {
  const root = await openRoot(p.root);
  if (typeof p.query !== "string" || p.query === "") return { files: [], total: 0, truncated: false };
  const max = Math.max(1, Math.floor(p.max ?? DEFAULT_MAX_MATCHES));
  if (p.regex) searchRegex(p); // a bad pattern is the same error from either engine
  const ctl: Cancel = { cancelled: false, stop: null };
  const before = running.get(root);
  if (before) {
    before.cancelled = true;
    before.stop?.();
  }
  running.set(root, ctl);
  try {
    if (await hasRg()) {
      try {
        const repo = await isRepo(root);
        if (ctl.cancelled) return EMPTY_CANCELLED;
        return await searchRg(root, p, max, repo, ctl);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        rgProbe = Promise.resolve(false);
      }
    }
    return await searchNode(root, p, max, ctl);
  } finally {
    if (running.get(root) === ctl) running.delete(root);
  }
}

// ── replace ─────────────────────────────────────────────────────────────────────

async function replace(p: IdeReplaceParams): Promise<IdeReplaceResult> {
  const root = await openRoot(p.root);
  if (typeof p.query !== "string" || p.query === "") return { files: 0, replaced: 0 };
  if (typeof p.replacement !== "string") throw new Error("The replacement is missing.");
  const re = searchRegex(p);
  const skip = new Set((Array.isArray(p.skipPaths) ? p.skipPaths : []).map((s) => cleanRel(s).join("/")));
  const failed: { path: string; reason: string }[] = [];
  const items: WorkItem[] = [];
  if (p.paths) {
    for (const rel of p.paths) {
      const segs = cleanRel(rel);
      notGit(segs);
      if (skip.has(segs.join("/"))) continue;
      try {
        items.push({ rel: segs.join("/"), abs: await resolveIn(root, segs, true) });
      } catch (e) {
        failed.push({ path: segs.join("/"), reason: (e as Error).message });
      }
    }
  } else {
    const inc = globTester(splitGlobs(p.include));
    const exc = globTester(splitGlobs(p.exclude));
    for (const rel of (await allFiles(root)).files) {
      if ((inc && !inc(rel)) || (exc && exc(rel)) || skip.has(rel)) continue;
      items.push({ rel, abs: path.join(root, rel) });
    }
  }
  let changed = 0;
  let replaced = 0;
  let batch: string | undefined;
  const how = await runWorker(
    { mode: "replace", items, source: re.source, flags: re.flags, regex: !!p.regex, replacement: p.replacement },
    async (m) => {
      if (m.t === "skip") {
        failed.push({ path: m.rel, reason: m.reason });
        return;
      }
      if (m.t !== "rep") return;
      try {
        // A file an agent or the person changed since the scan is left alone: the new text was made from the old.
        const st = await fs.stat(m.abs);
        if (Math.abs(st.mtimeMs - m.mtime) > 1) {
          failed.push({ path: m.rel, reason: "changed on disk while replacing" });
          return;
        }
        // The original goes to the trash first: Replace All is the one edit with no undo in the editor.
        batch ??= await newTrashBatch("replace");
        const keep = path.join(batch, ...m.rel.split("/"));
        await fs.mkdir(path.dirname(keep), { recursive: true });
        await fs.copyFile(m.abs, keep);
        await writeAtomic(m.abs, m.text);
        changed++;
        replaced += m.n;
      } catch (e) {
        failed.push({ path: m.rel, reason: (e as Error).message });
      }
    },
    replaceLimit(),
  );
  return { files: changed, replaced, ...(batch ? { trashed: batch } : {}), ...(failed.length ? { failed } : {}), ...(how === "timeout" ? { truncated: true } : {}) };
}

export const IDE_FS: IdeHandlers = {
  list,
  listMany,
  read,
  write,
  create,
  rename,
  delete: del,
  files,
  stats,
  search,
  replace,
};
