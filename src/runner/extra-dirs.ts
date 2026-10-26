import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { contains } from "../folder-key.js";

/**
 * The folders a lane's tool may work in besides its own, as each tool's --add-dir has them (Arun, 2026-10-19: every tool as
 * capable in Friday as on its own). Kept on this computer for the folder they were given with, so the lane started again (a
 * new mode or model, Reconnect, the app opened again) still has them though the page that starts it doesn't say them.
 */

/** More than this is a list nobody chose folder by folder. */
export const MAX_DIRS = 8;

const file = () => process.env.FRIDAY_EXTRA_DIRS ?? path.join(homedir(), ".friday", "extra-dirs.json");
const key = (folder: string) => path.resolve(folder);
const isDir = (p: string) => stat(p).then((s) => s.isDirectory(), () => false);

async function readAll(): Promise<Record<string, string[]>> {
  try {
    const all = JSON.parse(await readFile(file(), "utf8")) as Record<string, unknown> | null;
    if (!all || typeof all !== "object") return {};
    return Object.fromEntries(Object.entries(all).map(([k, v]) => [k, Array.isArray(v) ? v.filter((d): d is string => typeof d === "string") : []]));
  } catch {
    return {};
  }
}

/** The folders kept for this one, those still there. */
export async function savedDirs(folder: string): Promise<string[]> {
  const dirs = (await readAll())[key(folder)] ?? [];
  const there = await Promise.all(dirs.map(isDir));
  return dirs.filter((_, i) => there[i]);
}

async function save(folder: string, dirs: string[]): Promise<void> {
  const all = await readAll();
  if (dirs.length) all[key(folder)] = dirs;
  else delete all[key(folder)];
  await mkdir(path.dirname(file()), { recursive: true });
  await writeFile(file(), JSON.stringify(all, null, 2));
}

/**
 * The folders a start gives its tool. A list (empty too) is what the person chose now, and is kept for the folder; none said
 * is whatever was kept for it. One that isn't there is refused, rather than a tool told about a folder it can't open; the
 * folder itself, one inside it and one said twice are left out, since the tool has those already.
 */
export async function startDirs(given: unknown, folder: string, resolve: (p: unknown) => string): Promise<string[]> {
  if (!Array.isArray(given)) return savedDirs(folder);
  const dirs: string[] = [];
  for (const raw of given.slice(0, MAX_DIRS * 2)) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const d = resolve(raw);
    if (contains(folder, d) || dirs.some((x) => contains(x, d))) continue;
    if (!(await isDir(d))) throw new Error(`There's no folder at ${d}.`);
    // One that holds another already listed takes its place: the tool reaches the inner one through it.
    for (let i = dirs.length - 1; i >= 0; i--) if (contains(d, dirs[i]!)) dirs.splice(i, 1);
    dirs.push(d);
  }
  if (dirs.length > MAX_DIRS) throw new Error(`At most ${MAX_DIRS} other folders.`);
  await save(folder, dirs).catch(() => {});
  return dirs;
}
