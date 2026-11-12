import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { contains } from "../folder-key.js";
import { remoteOf } from "./git.js";

/**
 * What Deep Dive needs from the computer the repo is on (deep-dive.ts; Arun, 2026-11-11: "Repo wiki and Q&A … Deep Dive is what
 * we should call it"), read here so the code itself never leaves it: only names, counts, the head of the repo's own notes, and
 * the lines a page cites when somebody opens one.
 *
 * - `surveyRepo`: the repo's shape before any model is asked, so the outline is planned from what is there (DeepWiki scores
 *   files from their folders and git history the same way): every file's path, each folder's files, lines and how often it
 *   changed in the last six months, the commit, and the first part of its README, AGENTS.md and CLAUDE.md.
 * - `lineCounts`: how many lines each cited file has, so a citation that points past a file's end, or at a file that isn't
 *   there, is caught before a page is kept (the confident wrong page is what people hold against DeepWiki).
 * - `citedLines`: the lines one citation points at, with a little around them, for the reader to see the code itself.
 *
 * Inside the folder only, the same as repo-read: never `..` out of it, never git's own folder, never a .env or a key.
 */

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".venv", "venv", "__pycache__", "target", ".turbo", ".cache", "coverage", "vendor", ".friday", ".svelte-kit", "Pods", "DerivedData"]);
const MAX_FILES = 6000;
/** A file past this is data or generated, not something a page explains by its lines: counted as a file, its lines not read. */
const MAX_BYTES = 1_000_000;
const SECRET = /(^|\/)\.env(\.(?!example$|sample$|template$)[^/]+)?$|\.(pem|key|p12)$|(^|\/)(id_rsa|id_ed25519)[^/]*$|(^|\/)\.(npmrc|pypirc|netrc)$/i;
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|icns|pdf|zip|gz|tgz|bz2|xz|7z|jar|woff2?|ttf|otf|eot|mp[34]|mov|webm|m4v|wav|ogg|bin|exe|dll|so|dylib|a|o|class|pyc|wasm|sqlite|db|lockb)$/i;

export interface FolderFacts {
  /** "src" or "src/runner": the first two levels. */
  path: string;
  files: number;
  lines: number;
  /** Commits that touched it in the last six months. */
  changes: number;
}
export interface Survey {
  files: string[];
  /** There were more files than `files` holds. */
  more: boolean;
  folders: FolderFacts[];
  lines: number;
  head: string;
  branch: string;
  remote: { url: string; github: string | null };
  docs: { name: string; text: string }[];
}

const run = (cwd: string, args: string[]) =>
  new Promise<string>((resolve) => execFile("git", args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 30_000, windowsHide: true }, (err, out) => resolve(err ? "" : String(out))));

/** Forward slashes, whatever the computer: a page cites `src/app.ts`, never `src\app.ts`. */
export const slash = (p: string) => p.replace(/\\/g, "/");
const skipped = (rel: string) => rel.split("/").some((s) => SKIP.has(s));

/** Every file git knows here (tracked and not ignored), or, outside git, every file walked with the same folders left out. */
async function listFiles(root: string): Promise<string[]> {
  const out = await run(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (out) return out.split("\0").filter(Boolean).map(slash).filter((f) => !skipped(f));
  const files: string[] = [];
  const walk = async (dir: string) => {
    if (files.length > MAX_FILES) return;
    const entries = await readdir(path.join(root, dir), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (SKIP.has(e.name)) continue;
      if (e.isDirectory()) await walk(rel);
      else if (e.isFile()) files.push(rel);
    }
  };
  await walk("");
  return files;
}

/** Lines the way an editor numbers them: CRLF or LF alike, and a last line without its newline still a line. */
export const countLines = (text: string) => (text ? text.split(/\r\n|\r|\n/).length - (/(\r\n|\r|\n)$/.test(text) ? 1 : 0) : 0);

/** The folder a file is counted under: its first two levels, or the repo itself for a file at the top. */
export const folderOf = (file: string) => {
  const parts = file.split("/");
  return parts.length <= 1 ? "." : parts.length === 2 ? parts[0]! : `${parts[0]}/${parts[1]}`;
};

export async function surveyRepo(root: string): Promise<Survey> {
  const base = path.resolve(root);
  if (!(await stat(base).then((s) => s.isDirectory(), () => false))) throw new Error(`There's no folder at ${base}.`);
  const all = await listFiles(base);
  const files = all.slice(0, MAX_FILES);
  const byFolder = new Map<string, FolderFacts>();
  const at = (p: string) => byFolder.get(p) ?? (byFolder.set(p, { path: p, files: 0, lines: 0, changes: 0 }), byFolder.get(p)!);
  let total = 0;
  // A few files at a time: reading thousands at once runs a computer out of file handles.
  for (let i = 0; i < files.length; i += 64) {
    await Promise.all(
      files.slice(i, i + 64).map(async (f) => {
        const facts = at(folderOf(f));
        facts.files++;
        if (BINARY.test(f) || SECRET.test(f)) return;
        const s = await stat(path.join(base, f)).catch(() => null);
        if (!s || s.size > MAX_BYTES) return;
        const n = countLines(await readFile(path.join(base, f), "utf8").catch(() => ""));
        facts.lines += n;
        total += n;
      }),
    );
  }
  const log = await run(base, ["log", "--since=6.months", "--name-only", "--pretty=format:%x00"]);
  for (const commit of log.split("\0")) {
    const touched = new Set(commit.split("\n").map((l) => l.trim()).filter(Boolean).map((f) => folderOf(slash(f))));
    for (const p of touched) byFolder.get(p) && byFolder.get(p)!.changes++;
  }
  const docs: Survey["docs"] = [];
  for (const name of ["README.md", "readme.md", "README", "AGENTS.md", "CLAUDE.md", "ARCHITECTURE.md"]) {
    if (!files.includes(name) || docs.some((d) => d.name.toLowerCase() === name.toLowerCase())) continue;
    const text = await readFile(path.join(base, name), "utf8").catch(() => "");
    if (text.trim()) docs.push({ name, text: text.slice(0, 3000) });
  }
  const remote = await remoteOf(base).catch(() => ({ url: "", github: null, branch: "" }));
  return {
    files,
    more: all.length > files.length,
    folders: [...byFolder.values()].sort((a, b) => a.path.localeCompare(b.path)),
    lines: total,
    head: (await run(base, ["rev-parse", "HEAD"])).trim(),
    branch: remote.branch,
    remote: { url: remote.url, github: remote.github },
    docs,
  };
}

/** A path inside the folder, or nothing: never out of it, never into git's own folder, never a secret. */
function inside(root: string, rel: string): string | null {
  const clean = slash(rel).replace(/^\.\//, "");
  if (!clean || clean.startsWith("/") || /^[A-Za-z]:/.test(clean) || clean.split("/").some((s) => s === ".." || s.toLowerCase() === ".git") || SECRET.test(clean)) return null;
  const full = path.resolve(root, clean);
  return contains(path.resolve(root), full) ? full : null;
}

/** Each file's line count, or null for one that isn't there (or isn't a file the folder will show). */
export async function lineCounts(root: string, files: string[]): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {};
  for (const f of [...new Set(files.map(slash))].slice(0, 400)) {
    const full = inside(root, f);
    const s = full ? await stat(full).catch(() => null) : null;
    out[f] = s?.isFile() && s.size <= MAX_BYTES * 4 ? countLines(await readFile(full!, "utf8").catch(() => "")) : null;
  }
  return out;
}

/**
 * A page's files, read here and handed to the tool with its question, each line numbered so a citation is exact (Arun,
 * 2026-11-12: "optimize the deep dive somehow because it is taking forever"). A coding tool opening them itself spent a turn of
 * the model on every file; given them, it writes the page in one. Each file to `perFile` characters and all of them to `budget`,
 * a cut said where it falls, so the tool knows to read on if the page needs it; a file the folder won't show is left out.
 */
export async function readForPage(root: string, files: string[], budget = 60_000, perFile = 16_000): Promise<{ file: string; text: string; total: number; cut: boolean }[]> {
  const out: { file: string; text: string; total: number; cut: boolean }[] = [];
  let left = budget;
  for (const f of [...new Set(files.map(slash))].slice(0, 12)) {
    if (left < 2_000) break;
    const full = inside(root, f);
    const s = full ? await stat(full).catch(() => null) : null;
    if (!s?.isFile() || s.size > MAX_BYTES) continue;
    const all = (await readFile(full!, "utf8").catch(() => "")).split(/\r\n|\r|\n/);
    if (all.length > 1 && all.at(-1) === "") all.pop();
    if (all.some((l) => l.includes("\u0000"))) continue;
    const cap = Math.min(perFile, left);
    let text = "";
    let n = 0;
    for (; n < all.length; n++) {
      const line = `${n + 1}| ${all[n]}\n`;
      if (text.length + line.length > cap) break;
      text += line;
    }
    left -= text.length;
    out.push({ file: slash(f), text, total: all.length, cut: n < all.length });
  }
  return out;
}

/** The lines a citation points at, and up to `around` either side, numbered from 1. */
export async function citedLines(root: string, file: string, start: number, end = start, around = 12): Promise<{ file: string; from: number; lines: string[]; total: number }> {
  const full = inside(root, file);
  if (!full) throw new Error("That file isn't one Deep Dive shows.");
  const s = await stat(full).catch(() => null);
  if (!s?.isFile()) throw new Error(`${slash(file)} isn't in this repo any more.`);
  if (s.size > MAX_BYTES * 4) throw new Error(`${slash(file)} is too big to show here.`);
  const all = (await readFile(full, "utf8")).split(/\r\n|\r|\n/);
  // A file's last newline ends its last line; it doesn't start another.
  if (all.length > 1 && all.at(-1) === "") all.pop();
  const lo = Math.max(1, Math.min(start, end) - around);
  const hi = Math.min(all.length, Math.max(start, end) + around, lo + 400);
  return { file: slash(file), from: lo, lines: all.slice(lo - 1, hi), total: all.length };
}
