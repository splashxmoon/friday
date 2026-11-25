import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

/**
 * Writing Friday's own files so that nothing a person did is lost to a crash, a full disk or a second app writing beside it
 * (spec 13, Arun 2026-11-24: "Go all out and fix these problems").
 *
 * - writeAtomic: a whole file, never half of one. A temp file in the same folder, written and flushed to the disk, then renamed
 *   over the file, then the folder flushed too, so the rename itself survives the power going (not on Windows, which can't open a
 *   folder to flush it). A rename refused because another program has the file open (Windows: an antivirus, a language server) is
 *   tried again a few times, then the file is written in place: less safe against a crash, but the save goes through.
 * - updateJson: a small JSON file (runner-sessions.json, connections.json, accounts.json) read, changed and written as one step:
 *   one at a time in this process, and under a lock file against another Friday on the same folder (the desktop app's runner and the
 *   open-source app share ~/.friday), so neither writes over what the other just added. A file that can't be read is set aside
 *   before anything is written, never written over with an empty one: a read that failed to parse used to become {}, and the next
 *   save wrote that, and the resumed conversations, plugins or accounts in it were gone.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The errors a rename over a file in use gives on Windows (antivirus, a language server holding it open). */
const isBusy = (e: unknown) => ["EPERM", "EBUSY", "EACCES"].includes((e as NodeJS.ErrnoException).code ?? "");

/**
 * The file system calls the writers use, swappable by a test (a rename that fails, a disk that is full). Never changed by Friday
 * itself.
 */
export const fsCalls = { rename: fs.rename, open: fs.open, appendFile: fs.appendFile };

/**
 * A write that fails as a full disk would, for tests: `FRIDAY_TEST_WRITE_FAIL` names part of a path ("data.json"), and every write
 * to a path with it in fails with ENOSPC until it is unset. Nothing sets it but the e2e suite (e2e/local-saves.spec.ts), which runs
 * Friday in its own process and home; a unit test may set `writeFault` instead.
 */
export let writeFault: ((target: string) => NodeJS.ErrnoException | null) | null = null;
export function setWriteFault(f: typeof writeFault): void {
  writeFault = f;
}
function faultFor(target: string): NodeJS.ErrnoException | null {
  const fromTest = writeFault?.(target);
  if (fromTest) return fromTest;
  const env = process.env.FRIDAY_TEST_WRITE_FAIL;
  if (!env || !target.includes(env)) return null;
  return Object.assign(new Error(`ENOSPC: no space left on device, write '${target}'`), { code: "ENOSPC", errno: -28, syscall: "write", path: target });
}

/** The folder flushed, so a rename in it is on the disk. Not on Windows, which can't open a folder for it; never fails a save. */
async function syncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  const h = await fsCalls.open(dir, "r").catch(() => null);
  if (!h) return;
  await h.sync().catch(() => {});
  await h.close().catch(() => {});
}

/** The rename, tried again briefly while another program has the file open. Throws the last refusal. */
async function renameRetrying(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fsCalls.rename(from, to);
    } catch (e) {
      if (!isBusy(e) || attempt >= 4) throw e;
      await sleep(40 * (attempt + 1));
    }
  }
}

export interface AtomicOptions {
  /** The file's permissions when it is new, or always with `forceMode`. An existing file keeps its own otherwise. */
  mode?: number;
  forceMode?: boolean;
  /** The file as it was, kept here (renamed, so it costs nothing) before the new one takes its place: the last good copy. */
  backup?: string;
}

/**
 * `data` written to `target` whole or not at all: temp file, flushed, renamed over, folder flushed. Keeps the file's permissions.
 * The temp file is removed when anything fails, and the error thrown.
 */
export async function writeAtomic(target: string, data: string | Buffer, o: AtomicOptions = {}): Promise<void> {
  const fault = faultFor(target);
  if (fault) throw fault;
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  let mode = o.mode;
  if (!o.forceMode) mode = await fs.stat(target).then((s) => s.mode & 0o7777, () => o.mode);
  const tmp = path.join(dir, `.${path.basename(target)}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    const h = await fsCalls.open(tmp, "w", mode ?? 0o666);
    try {
      await h.writeFile(data);
      await h.sync();
    } finally {
      await h.close();
    }
    if (mode !== undefined) await fs.chmod(tmp, mode).catch(() => {});
    if (o.backup) await renameRetrying(target, o.backup).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
    });
    try {
      await renameRetrying(tmp, target);
    } catch (e) {
      if (!isBusy(e)) throw e;
      // Still held open after five tries: written in place, so the save isn't lost.
      await fs.writeFile(target, data, mode === undefined ? undefined : { mode });
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
    await syncDir(dir);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/** Added to the end of a file (a session's log), with the same test fault as writeAtomic. A failure is thrown, never swallowed. */
export async function appendDurable(target: string, data: string, mode?: number): Promise<void> {
  const fault = faultFor(target);
  if (fault) throw fault;
  await fsCalls.appendFile(target, data, mode === undefined ? undefined : { mode });
}

/** A file that couldn't be read, moved beside itself with the time, so nothing writes over it. Its new name, or null. */
export async function setAside(file: string, why = "unreadable"): Promise<string | null> {
  const aside = `${file}.${why}-${Date.now()}`;
  return fsCalls.rename(file, aside).then(() => aside, () => null);
}

/**
 * Why a save failed, in plain words for the person: "the disk is full", not ENOSPC. `where` is the folder, for the ones where it
 * helps to know which.
 */
export function plainReason(e: unknown, where?: string): string {
  const code = (e as NodeJS.ErrnoException)?.code;
  const at = where ? ` (${where})` : "";
  switch (code) {
    case "ENOSPC":
      return "the disk is full";
    case "EDQUOT":
      return "you're over your disk quota";
    case "EROFS":
      return "the disk is read-only";
    case "EACCES":
    case "EPERM":
      return `Friday isn't allowed to write to its folder${at}`;
    case "ENOENT":
    case "ENOTDIR":
      return `its folder isn't there any more${at}`;
    case "EIO":
      return "the disk reported an error";
    case "EMFILE":
    case "ENFILE":
      return "too many files are open";
    case "EBUSY":
      return "another program has its file open";
    default:
      return (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 160) || "something went wrong";
  }
}

// ── read, change, write ─────────────────────────────────────────────────────────

/** Each file's changes in this process, one after another. */
const lines = new Map<string, Promise<unknown>>();

/**
 * The lock file another process holds while it changes `file`: taken with an exclusive create, waited on for two seconds at most
 * (a change takes milliseconds), and taken over when it is older than ten (its process died holding it). Never blocks a save for
 * good: past the wait, the change goes ahead as it did before there was a lock.
 */
async function crossProcess<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  let held = false;
  for (const end = Date.now() + 2000; Date.now() < end; ) {
    try {
      const h = await fs.open(lock, "wx");
      await h.writeFile(String(process.pid)).catch(() => {});
      await h.close();
      held = true;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") break;
      const age = await fs.stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > 10_000) await fs.rm(lock, { force: true }).catch(() => {});
      else await sleep(15 + Math.random() * 25);
    }
  }
  try {
    return await fn();
  } finally {
    if (held) await fs.rm(lock, { force: true }).catch(() => {});
  }
}

/** Returned by an updateJson change that writes nothing. */
export const NO_WRITE: unique symbol = Symbol("no write");

/** What a JSON file holds, or null when there is no file. Throws when it is there and can't be read as `shape` accepts it. */
async function readShaped<T>(file: string, shape: (v: unknown) => T | null): Promise<T | null> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const got = shape(JSON.parse(text));
  if (got === null) throw new Error("not what was expected");
  return got;
}

/**
 * A JSON file read for looking: what it holds, or `empty()` when there is none or it can't be read. Never writes or moves anything
 * (updateJson sets an unreadable one aside before it writes).
 */
export async function readJson<T>(file: string, shape: (v: unknown) => T | null, empty: () => T): Promise<T> {
  return (await readShaped(file, shape).catch(() => null)) ?? empty();
}

/**
 * `file` read, handed to `change` (which changes it in place, or returns NO_WRITE to leave it be), and written back atomically:
 * one change at a time per file in this process, under a lock against another process, read afresh each time so a change made
 * meanwhile elsewhere is kept. A file there but unreadable is set aside first (logged with where it went), and the change starts
 * from `empty()`. Returns what `change` returned.
 */
export function updateJson<T, R>(file: string, o: { shape: (v: unknown) => T | null; empty: () => T; mode?: number; forceMode?: boolean }, change: (cur: T) => R | Promise<R>): Promise<R> {
  const key = path.resolve(file);
  const run = (lines.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(() =>
      crossProcess(file, async () => {
        let cur: T;
        try {
          cur = (await readShaped(file, o.shape)) ?? o.empty();
        } catch (e) {
          const aside = await setAside(file);
          console.error(`[friday] couldn't read ${file} (${(e as Error).message}); kept it as ${aside ?? "it was"} and started it again.`);
          // Not moved (it went meanwhile, or can't be): nothing is written over it either.
          if (!aside && (await fs.stat(file).then(() => true, () => false))) throw new Error(`Friday couldn't read ${file}, and couldn't set it aside to start it again.`);
          cur = o.empty();
        }
        const out = await change(cur);
        if (out !== NO_WRITE) await writeAtomic(file, JSON.stringify(cur, null, 2), { ...(o.mode !== undefined ? { mode: o.mode } : {}), ...(o.forceMode ? { forceMode: true } : {}) });
        return out;
      }),
    );
  lines.set(key, run);
  void run.catch(() => {}).then(() => void (lines.get(key) === run && lines.delete(key)));
  return run;
}

/** A plain JSON object, or null: the shape most of these files have. */
export const objectShape = <T extends object>(v: unknown): T | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as T) : null);
