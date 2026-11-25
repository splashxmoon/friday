import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { dropWorktree, inSparePool, inWorktreeLine, isSpareCopy, madeHere, sweepWorktrees, worktreeRoot } from "./git.js";
import { releaseStack } from "./stack.js";

/**
 * What Friday keeps on this computer, how much of it, and keeping it from piling up (Arun, 2026-11-19: "there is alot of stuff
 * saved on disk that was either deleted or removed and stuff by the user and it is still there we need to have proper storage
 * management so it doesnt pile up and take so much disk storage too"). On his Mac: 389 copies of folders (13 GB), most of them
 * spares a quit app left and nothing cleared, since the open-source app never ran the sweep; 213 left by test runs; copies of
 * deleted sessions; 1.8 GB of browser cache with no cap.
 *
 * The rules, so nobody's work is lost:
 * - A branch is never deleted: what an agent committed stays on it, whatever happens to the folder.
 * - A copy with uncommitted changes, or commits on no branch, is never deleted outright: it goes to Friday's trash, where it
 *   waits a week (TRASH_DAYS) and can be taken back.
 * - Never a copy an agent here is working in, never a spare this app keeps ready.
 */

const TRASH_DAYS = 7;
const DAY = 24 * 60 * 60_000;
const home = () => path.resolve(process.env.FRIDAY_HOME || path.join(homedir(), ".friday"));
export const trashRoot = (): string => path.join(home(), "trash");
const copiesTrash = () => path.join(trashRoot(), "copies");
const shotsDir = () => path.join(home(), "shots");
const run = promisify(execFile);

/** The browser's caches, from the desktop app (local/desktop.ts): where they are, and how to empty them. Absent elsewhere. */
let browser: { dirs: string[]; clear: () => Promise<void> } | null = null;
export function setBrowserCaches(b: { dirs: string[]; clear: () => Promise<void> }): void {
  browser = b;
}

/** How much a folder or file takes. `du` where there is one (fast on many files), else a walk; never through a link. */
export async function sizeOf(paths: string[]): Promise<number[]> {
  const there = await Promise.all(paths.map((p) => lstat(p).then(() => true, () => false)));
  const out = paths.map(() => 0);
  const live = paths.filter((_, i) => there[i]);
  if (!live.length) return out;
  if (process.platform !== "win32") {
    try {
      const { stdout } = await run("du", ["-sk", ...live], { maxBuffer: 16 * 1024 * 1024 });
      const got = new Map<string, number>();
      for (const line of stdout.split("\n")) {
        const m = /^(\d+)\s+(.+)$/.exec(line);
        if (m) got.set(path.resolve(m[2]!), Number(m[1]) * 1024);
      }
      paths.forEach((p, i) => (out[i] = got.get(path.resolve(p)) ?? 0));
      return out;
    } catch {
      // A folder that went while it was measured, or no du: walked below.
    }
  }
  for (let i = 0; i < paths.length; i++) if (there[i]) out[i] = await walkSize(paths[i]!);
  return out;
}

async function walkSize(p: string): Promise<number> {
  const st = await lstat(p).catch(() => null);
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  const entries = await readdir(p).catch(() => [] as string[]);
  for (let i = 0; i < entries.length; i += 32) {
    const sizes = await Promise.all(entries.slice(i, i + 32).map((e) => walkSize(path.join(p, e))));
    total += sizes.reduce((a, b) => a + b, 0);
  }
  return total;
}

/**
 * A copy's folders, by what it is: Friday's own (`<repo>-<id>`), and any other git checkout in the worktrees folder, which agents
 * make there by name (`git worktree add ~/.friday/worktrees/edge-c2-adapt`; 16 on his Mac, 950 MB, 2026-11-24, that nothing
 * measured or cleared). Those are never marked as made here, so they are only ever "older" or "recent": put away on his say.
 */
async function copies(): Promise<string[]> {
  const root = worktreeRoot();
  const names = await readdir(root).catch(() => [] as string[]);
  const out: string[] = [];
  for (const n of names) {
    const dir = path.join(root, n);
    if (/-[0-9a-f]{8}$/.test(n)) out.push(dir);
    else if (/^gitdir:/.test((await readFile(path.join(dir, ".git"), "utf8").catch(() => "")).trimStart())) out.push(dir);
  }
  return out;
}

/**
 * Claude Code's record of a lane's conversation is kept by folder (~/.claude/projects/<the folder, every other character a "-">),
 * and stays when the copy goes: 37 folders, 409 MB on his Mac (2026-11-24, "past sessions that were deleted"). A record whose copy
 * is gone can't be resumed (Claude Code looks a conversation up by the folder it runs in), so it goes as the copy does: to the
 * trash for a week, a day after anything last wrote to it. Only records of folders in the worktrees folder, never anyone's own.
 */
const claudeProjects = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), "projects");
export const claudeKey = (p: string): string => p.replace(/[^a-zA-Z0-9]/g, "-");
const transcriptsTrash = () => path.join(trashRoot(), "transcripts");
export async function goneTranscripts(graceMs = DAY): Promise<string[]> {
  const root = worktreeRoot();
  const pre = claudeKey(root) + "-";
  // Every folder there now, copy or not: a record of a folder in one (a project a level down) is kept too.
  const live = (await readdir(root).catch(() => [] as string[])).map((n) => claudeKey(path.join(root, n)));
  const out: string[] = [];
  for (const name of await readdir(claudeProjects()).catch(() => [] as string[])) {
    if (!name.startsWith(pre) || live.some((k) => name === k || name.startsWith(k + "-"))) continue;
    const at = path.join(claudeProjects(), name);
    const st = await stat(at).catch(() => null);
    if (!st?.isDirectory()) continue;
    const inside = await readdir(at).catch(() => [] as string[]);
    const times = await Promise.all(inside.map((f) => stat(path.join(at, f)).then((x) => x.mtimeMs, () => 0)));
    if (Date.now() - Math.max(st.mtimeMs, ...times) >= graceMs) out.push(at);
  }
  return out;
}

/**
 * Where a copy's git folder points, and whether it is still there. A copy whose repository is gone can't be used or committed
 * from; one whose repository was in the system's temporary folder was made by a test.
 */
async function gitLink(dir: string): Promise<{ to: string; there: boolean; temp: boolean } | null> {
  const text = await readFile(path.join(dir, ".git"), "utf8").catch(() => null);
  const m = text && /^gitdir:\s*(.+)$/m.exec(text);
  if (!m) return null;
  const to = path.resolve(dir, m[1]!.trim());
  const there = await stat(to).then(() => true, () => false);
  const temps = [tmpdir(), "/tmp", "/private/tmp", "/private/var/folders", "/var/folders"].map((t) => path.resolve(t));
  return { to, there, temp: temps.some((t) => to.startsWith(t + path.sep)) };
}

/** When a folder was made: its birth time where the system keeps one, else when it last changed. */
const madeAt = (st: { birthtimeMs: number; mtimeMs: number }) => (st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs);

/**
 * A copy put away: deleted when nothing in it is only there (its changes committed on a branch, or none), else moved to Friday's
 * trash for a week. Returns what happened.
 */
export async function retireCopy(dir: string): Promise<"dropped" | "trashed" | "kept"> {
  if (await dropWorktree(dir, "committed").catch(() => false)) return "dropped";
  if (!(await lstat(dir).then(() => true, () => false))) return "dropped";
  await releaseStack(dir).catch(() => undefined);
  const link = await gitLink(dir);
  await mkdir(copiesTrash(), { recursive: true });
  const to = path.join(copiesTrash(), `${path.basename(dir)}-${Date.now()}`);
  try {
    await rename(dir, to);
  } catch {
    return "kept";
  }
  // Its week starts now: a move keeps the folder's own date, and a copy untouched for a month was emptied from the trash at the
  // next clean-up, minutes after it was put there (2026-11-19, 42 of his 44 older copies).
  await utimes(to, new Date(), new Date()).catch(() => undefined);
  // git forgets the copy (its branch stays), so `git worktree list` doesn't name a folder that isn't there.
  if (link?.there) {
    const common = path.resolve(link.to, "..", "..");
    await inWorktreeLine(common, () => run("git", ["--git-dir", common, "worktree", "prune"])).catch(() => undefined);
  }
  return "trashed";
}

/** Each in turn, a few at once: hundreds of copies each asking git. */
async function eachLimited<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, xs.length) }, async () => {
      while (next < xs.length) {
        const i = next++;
        out[i] = await f(xs[i]!);
      }
    }),
  );
  return out;
}

/**
 * When anything last happened in a copy: its folder, or git's record of its commits and checkouts. Not git's index, which any
 * `git status` rewrites (the three-day sweep asks each old copy), so every copy looked touched today.
 */
async function lastTouched(dir: string, gitDir?: string): Promise<number> {
  const times = await Promise.all([dir, ...(gitDir ? [path.join(gitDir, "HEAD"), path.join(gitDir, "logs", "HEAD")] : [])].map((p) => stat(p).then((x) => x.mtimeMs, () => 0)));
  return Math.max(...times);
}

const OLDER_DAYS = 3;
type Kind = "using" | "named" | "broken-temp" | "broken" | "spare" | "leftover" | "older" | "recent";

/**
 * What a copy is. `named`: copies a session here names (a lane's folder, or one inside it). "leftover": made by this app, named by
 * no session. "older": named by no session, unmarked (made before copies were marked, or by a linked Friday that shares the
 * folder), untouched OLDER_DAYS: put away only when someone says so (Settings › Storage). "recent": the same, touched lately.
 */
async function kindOf(dir: string, using: ReadonlySet<string>, named: ReadonlySet<string> | null): Promise<{ kind: Kind; age: number }> {
  const st = await stat(dir).catch(() => null);
  const age = st ? Date.now() - madeAt(st) : 0;
  if (using.has(dir)) return { kind: "using", age };
  const link = await gitLink(dir);
  if (link && !link.there) return { kind: link.temp ? "broken-temp" : "broken", age };
  if (named?.has(dir)) return { kind: "named", age };
  if (inSparePool(dir) || (await isSpareCopy(dir))) return { kind: "spare", age };
  if (!named) return { kind: "named", age };
  if (await madeHere(dir)) return { kind: "leftover", age };
  const touched = await lastTouched(dir, link?.to);
  return { kind: Date.now() - touched > OLDER_DAYS * DAY ? "older" : "recent", age };
}

/** The copies sessions name: a lane's folder is a copy, or a folder inside one (a project kept a level down). */
function copiesNamed(referenced: ReadonlySet<string> | null): Set<string> | null {
  if (!referenced) return null;
  const root = worktreeRoot();
  const out = new Set<string>();
  for (const r of referenced) {
    const p = path.resolve(r);
    if (!p.startsWith(root + path.sep)) continue;
    out.add(path.join(root, p.slice(root.length + 1).split(path.sep)[0]!));
  }
  return out;
}

export interface TidyResult {
  dropped: number;
  trashed: number;
  purged: number;
  files: number;
}

/**
 * Everything that piles up, cleared by the rules above. `inUse`: folders an agent here works in now. `referenced`: every folder a
 * session that still exists names (its lanes'), or null when that isn't known (then no copy counts as left behind). `liveSids`:
 * the sessions that exist, for their screenshots (null: none are touched). `since`: when this app started; files a lane writes
 * as it starts (its MCP settings, its link to the other agents) from before then belong to lanes that have gone.
 */
export async function tidy(o: { inUse: ReadonlySet<string>; referenced: ReadonlySet<string> | null; liveSids: ReadonlySet<string> | null; since: number; /** How old a copy must be before it counts as left behind (tests). */ graceMs?: number }): Promise<TidyResult> {
  const grace = o.graceMs ?? DAY;
  const res: TidyResult = { dropped: 0, trashed: 0, purged: 0, files: 0 };
  const using = new Set([...o.inUse].map((d) => path.resolve(d)));
  const named = copiesNamed(o.referenced);
  // Spares a quit app left, copies untouched three days with nothing only in them, the old snapshot indexes (git.ts).
  res.dropped += await sweepWorktrees(undefined, using).catch(() => 0);
  for (const dir of await copies()) {
    const { kind, age } = await kindOf(dir, using, named);
    // Its repository gone: a test's (in the temporary folder) deleted, anyone else's to the trash, an hour on.
    if ((kind === "broken-temp" || kind === "broken") && age >= Math.min(grace, 60 * 60_000)) {
      if (kind === "broken-temp") await rm(dir, { recursive: true, force: true }).then(() => res.dropped++, () => undefined);
      else if ((await retireCopy(dir)) === "trashed") res.trashed++;
    }
    // One this app made that no session names any more (its session deleted, its agent removed), a day on: put away.
    if (kind === "leftover" && age >= grace) {
      const r = await retireCopy(dir);
      if (r === "dropped") res.dropped++;
      else if (r === "trashed") res.trashed++;
    }
  }
  // Claude Code's records of copies that are gone.
  for (const at of await goneTranscripts(grace)) {
    await mkdir(transcriptsTrash(), { recursive: true });
    const to = path.join(transcriptsTrash(), `${path.basename(at)}-${Date.now()}`);
    await rename(at, to).then(() => res.files++, () => undefined);
  }
  // The trash: a week for copies and records, a month for skills, from when each went in.
  for (const [dir, days] of [
    [copiesTrash(), TRASH_DAYS],
    [transcriptsTrash(), TRASH_DAYS],
    [path.join(trashRoot(), "skills"), 30],
  ] as const) {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const at = path.join(dir, name);
      const when = await trashedAt(at);
      if (when && Date.now() - when > days * DAY) await rm(at, { recursive: true, force: true }).then(() => res.purged++, () => undefined);
    }
  }
  // A lane's MCP settings and its link to the other agents, written as it starts, from lanes before this app started.
  for (const [dir, re] of [
    [path.join(home(), "run"), /^mcp-.+\.json$/],
    [path.join(home(), "mesh"), /\.url$/],
  ] as const) {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!re.test(name)) continue;
      const st = await stat(path.join(dir, name)).catch(() => null);
      // Two days old too: a linked Friday's runner writes here as well, and its lanes may have started before this app.
      if (st && st.mtimeMs < o.since && Date.now() - st.mtimeMs > 2 * DAY) await rm(path.join(dir, name), { force: true }).then(() => res.files++, () => undefined);
    }
  }
  // Screenshots of sessions that are gone.
  if (o.liveSids) for (const name of await readdir(shotsDir()).catch(() => [] as string[])) {
    const sid = shotSid(name);
    if (sid && !o.liveSids.has(sid)) await rm(path.join(shotsDir(), name), { force: true }).then(() => res.files++, () => undefined);
  }
  return res;
}

/** The session a screenshot is of: its name is `<sid>-<time>.png`, and a session's id may itself have a "-" in it. */
export const shotSid = (name: string): string | null => {
  const m = /^(.+)-\d{10,}\.png$/.exec(name);
  return m ? m[1]! : null;
};

/**
 * When something went into the trash: the time in its name (a copy's `-<ms>`, a skill's ISO time, skill-library.ts), which a move
 * can't carry over from the folder's own date; else the folder's date, which retireCopy sets as it moves one in.
 */
export async function trashedAt(at: string): Promise<number | null> {
  const name = path.basename(at);
  const ms = /-(\d{13})$/.exec(name);
  if (ms) return Number(ms[1]);
  const iso = /-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(name);
  if (iso) {
    const t = Date.parse(`${iso[1]}T${iso[2]}:${iso[3]}:${iso[4]}.${iso[5]}Z`);
    if (Number.isFinite(t)) return t;
  }
  return (await stat(at).catch(() => null))?.mtimeMs ?? null;
}

/** A deleted session's screenshots. */
export async function dropShots(sid: string): Promise<number> {
  let n = 0;
  for (const name of await readdir(shotsDir()).catch(() => [] as string[])) if (shotSid(name) === sid) await rm(path.join(shotsDir(), name), { force: true }).then(() => n++, () => undefined);
  return n;
}

export async function emptyTrash(): Promise<number> {
  const before = (await sizeOf([trashRoot()]))[0]!;
  await rm(trashRoot(), { recursive: true, force: true }).catch(() => undefined);
  return before;
}

export async function clearBrowserCaches(): Promise<number> {
  if (!browser) return 0;
  const before = (await sizeOf(browser.dirs)).reduce((a, b) => a + b, 0);
  await browser.clear().catch(() => undefined);
  const after = (await sizeOf(browser.dirs)).reduce((a, b) => a + b, 0);
  return Math.max(0, before - after);
}

export type PileId = "copies" | "spares" | "leftover" | "older" | "transcripts" | "trash" | "cache" | "index" | "shots" | "logs" | "models" | "other";
export interface Pile {
  id: PileId;
  bytes: number;
  count?: number;
}

/** The copies of a kind now, for an action on them. */
async function copiesOfKind(want: Kind, referenced: ReadonlySet<string> | null, inUse: ReadonlySet<string>): Promise<string[]> {
  const using = new Set([...inUse].map((d) => path.resolve(d)));
  const named = copiesNamed(referenced);
  const all = await copies();
  const kinds = await eachLimited(all, 12, (d) => kindOf(d, using, named));
  return all.filter((_, i) => kinds[i]!.kind === want);
}

/** The older copies, put away when someone asks (Settings › Storage): committed work stays on its branch, the rest to the trash. */
export async function retireOlder(referenced: ReadonlySet<string> | null, inUse: ReadonlySet<string>): Promise<{ dropped: number; trashed: number }> {
  const res = { dropped: 0, trashed: 0 };
  if (!referenced) return res;
  for (const dir of await copiesOfKind("older", referenced, inUse)) {
    const r = await retireCopy(dir);
    if (r === "dropped") res.dropped++;
    else if (r === "trashed") res.trashed++;
  }
  return res;
}

/** What Friday keeps here, by kind, for Settings › Storage. `referenced` as for tidy. */
export async function measure(referenced: ReadonlySet<string> | null, inUse: ReadonlySet<string> = new Set()): Promise<{ piles: Pile[]; total: number; home: string; /** What Clean up now would clear this moment (see tidy): copies no session uses once a day old, ones whose repository is gone an hour on. */ due: number; /** Copies no session uses that aren't a day old yet: they go by themselves once they are. */ soon: number }> {
  const using = new Set([...inUse].map((d) => path.resolve(d)));
  const named = copiesNamed(referenced);
  const all = await copies();
  const kinds = await eachLimited(all, 12, (d) => kindOf(d, using, named));
  const pileOf = (k: Kind): PileId => (k === "spare" ? "spares" : k === "leftover" || k === "broken" || k === "broken-temp" ? "leftover" : k === "older" ? "older" : "copies");
  const sizes = await sizeOf(all);
  const sum = (id: PileId) => sizes.reduce((a, b, i) => a + (pileOf(kinds[i]!.kind) === id ? b : 0), 0);
  const count = (id: PileId) => kinds.filter((k) => pileOf(k.kind) === id).length;
  // As tidy decides (Arun, 2026-11-20: "grey out the clean up now if nothing is there to clear"): a copy left behind goes a day on.
  const isDue = (k: { kind: Kind; age: number }) => (k.kind === "leftover" && k.age >= DAY) || ((k.kind === "broken" || k.kind === "broken-temp") && k.age >= 60 * 60_000);
  // And what the trash holds past its week, which a clean-up empties too.
  const expired: string[] = [];
  for (const dir of [copiesTrash(), transcriptsTrash()])
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const at = path.join(dir, name);
      const when = await trashedAt(at);
      if (when && Date.now() - when > TRASH_DAYS * DAY) expired.push(at);
    }
  // Claude Code's records of copies that are gone, a day on (tidy): outside Friday's folder, so counted on their own.
  const gone = await goneTranscripts();
  const transcripts = gone.length ? (await sizeOf(gone)).reduce((a, b) => a + b, 0) : 0;
  const due = sizes.reduce((a, b, i) => a + (isDue(kinds[i]!) ? b : 0), 0) + transcripts + (expired.length ? (await sizeOf(expired)).reduce((a, b) => a + b, 0) || expired.length : 0);
  const soon = sizes.reduce((a, b, i) => a + (pileOf(kinds[i]!.kind) === "leftover" && !isDue(kinds[i]!) ? b : 0), 0);
  const h = home();
  const [trash, index, shots, logs, models] = await sizeOf([trashRoot(), path.join(h, "snapshot-index"), shotsDir(), path.join(h, "logs"), path.join(h, "models")]);
  const cache = browser ? (await sizeOf(browser.dirs)).reduce((a, b) => a + b, 0) : 0;
  const whole = (await sizeOf([h]))[0]!;
  const piles: Pile[] = [
    { id: "copies", bytes: sum("copies"), count: count("copies") },
    { id: "leftover", bytes: sum("leftover"), count: count("leftover") },
    { id: "older", bytes: sum("older"), count: count("older") },
    { id: "spares", bytes: sum("spares"), count: count("spares") },
    { id: "transcripts", bytes: transcripts, count: gone.length },
    { id: "trash", bytes: trash! },
    { id: "cache", bytes: cache },
    { id: "index", bytes: index! },
    { id: "shots", bytes: shots! },
    { id: "logs", bytes: logs! },
    { id: "models", bytes: models! },
  ];
  // The rest of Friday's folder: its settings, uploads, keys. The worktrees folder and the trash are inside it unless moved.
  const inside = (p: string) => p === h || p.startsWith(h + path.sep);
  const copiesIn = inside(worktreeRoot());
  const counted = piles.filter((p) => p.id !== "cache" && p.id !== "transcripts" && (copiesIn || !["copies", "leftover", "older", "spares"].includes(p.id))).reduce((a, p) => a + p.bytes, 0);
  piles.push({ id: "other", bytes: Math.max(0, whole - counted) });
  return { piles, total: piles.reduce((a, p) => a + p.bytes, 0), home: h, due, soon };
}

/** When this app started: what a lane wrote before then belongs to a lane that has gone (tidy). */
export const appStarted = Date.now();
