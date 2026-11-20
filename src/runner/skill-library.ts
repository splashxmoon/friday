import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { ENGINE_NAMES, type EngineTool, type SkillBrief } from "../types.js";
import { described, pluginSkillDirs } from "./shared-skills.js";
import { frontmatter, skillHomes, skillSlug } from "./tool-commands.js";

/**
 * The person's skills on this computer, for the Skills page (Arun, 2026-11-19: "i want to work on the skills page.... that is very
 * important for the agents... allow users to creat their own skills or import skills from either their coding tools or from
 * github").
 *
 * A skill is a folder holding a SKILL.md, the form every coding tool reads. The person's own are kept in ~/.agents/skills, the
 * folder the tools share: Codex, OpenCode and others read it by themselves, and every other tool Friday runs is told what is in it
 * in its standing note (shared-skills.ts), crew mates included, so one written here works in all of them, in Friday and out of it.
 * Each coding tool's own folder is listed beside them, to copy from; Friday never writes into those.
 */

export const libraryDir = (home = homedir()) => path.join(home, ".agents", "skills");
/** Where a removed skill goes: Friday's own folder, never the bin, so it can be put back by hand. */
const trashDir = (home: string) => path.join(process.env.FRIDAY_HOME || path.join(home, ".friday"), "trash", "skills");

export interface SkillRow {
  /** Its folder's name: what the tools call it. */
  folder: string;
  name: string;
  description: string;
  dir: string;
  /** How many files it has besides its SKILL.md (references, scripts). */
  files: number;
  /** Where in its tool it comes from, when not the tool's own folder: built into the tool, synced to it, or from a plugin. */
  from?: SkillFrom;
  /** When its SKILL.md last changed, for the page's "Recently changed". */
  updated?: number;
}

/** Where a tool's skill comes from, besides its own folder (Skills page, said under its name). */
export type SkillFrom = "builtin" | "synced" | "vscode" | "plugin" | "managed";

/** One coding tool's skills (its own, built in, synced), Claude Code's plugins', or a project's (in its repository). */
export interface Shelf {
  id: string;
  label: string;
  kind: "tool" | "plugins" | "project";
  /** The tool it's for; a project's are for every tool. */
  tool?: EngineTool;
  dir: string;
  skills: SkillRow[];
  /** A project's other clones on this computer (the same repository in another folder), shown as one shelf. */
  also?: string[];
}

export interface Library {
  dir: string;
  mine: SkillRow[];
  shelves: Shelf[];
}

const MAX_BODY = 100_000;
const MAX_DESCRIPTION = 1000;
const FOLDER = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

const folderOk = (f: unknown): f is string => typeof f === "string" && FOLDER.test(f) && !f.includes("..");

/** How many files under a folder, past its SKILL.md, counting to 200 at most. */
async function countFiles(dir: string, cap = 200): Promise<number> {
  let n = 0;
  const walk = async (d: string, depth: number) => {
    if (n >= cap || depth > 6) return;
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (n >= cap) return;
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) await walk(path.join(d, e.name), depth + 1);
      else if (!(depth === 0 && e.name === "SKILL.md")) n++;
    }
  };
  await walk(dir, 0);
  return n;
}

/** Each `<folder>/SKILL.md` in a folder, by name. */
async function rowsIn(dir: string): Promise<SkillRow[]> {
  const out: SkillRow[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if ((!e.isDirectory() && !e.isSymbolicLink()) || e.name.startsWith(".")) continue;
    const at = path.join(dir, e.name);
    const text = await readFile(path.join(at, "SKILL.md"), "utf8").catch(() => null);
    if (text === null) continue;
    const d = described(text);
    const updated = await stat(path.join(at, "SKILL.md")).then((s) => s.mtimeMs, () => 0);
    out.push({ folder: e.name, name: d.name || e.name, description: d.description.replace(/\s+/g, " ").trim(), dir: at, files: await countFiles(at), ...(updated ? { updated: Math.round(updated) } : {}) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** A folder of skills of a tool's: its own, or one it reads besides (built in, synced, from VS Code). */
interface Source {
  dir: string;
  from?: SkillFrom;
  /** A folder of folders of skills (Claude Code's synced/<set>/<skill>, VS Code's agent-plugins/<host>/<id>/skills, plugins/<p>/skills). */
  nested?: "sets" | "vscode" | "plugins";
}

/**
 * Where each coding tool keeps skills on this computer, besides the shared ~/.agents/skills (Arun, 2026-11-19: "ensure we are able
 * to fetch and gather skills from all coding tools"): its own folder (tool-commands.ts skillHomes) and the ones its docs and this
 * Mac showed it reads too: Claude Code's skills synced from claude.ai, Codex's and Cursor's and Antigravity's built-in ones, and
 * Copilot's and Codex's synced from VS Code.
 */
export function toolSources(home = homedir()): Partial<Record<EngineTool, Source[]>> {
  const homes = skillHomes(home);
  const codex = process.env.CODEX_HOME || path.join(home, ".codex");
  const vscode = path.join(home, ".vscode", "agent-plugins");
  const out: Partial<Record<EngineTool, Source[]>> = {};
  for (const [tool, dir] of Object.entries(homes) as [EngineTool, string][]) out[tool] = [{ dir }];
  out.claude = [...(out.claude ?? []), { dir: path.join(home, ".claude", "skills", "synced"), from: "synced", nested: "sets" }];
  out.codex = [...(out.codex ?? []), { dir: path.join(codex, "skills", ".system"), from: "builtin" }, { dir: vscode, from: "vscode", nested: "vscode" }];
  out.cursor = [...(out.cursor ?? []), { dir: path.join(home, ".cursor", "skills-cursor"), from: "builtin" }];
  out.copilot = [...(out.copilot ?? []), { dir: vscode, from: "vscode", nested: "vscode" }];
  out.antigravity = [
    ...(out.antigravity ?? []),
    { dir: path.join(home, ".gemini", "antigravity-cli", "skills") },
    { dir: path.join(home, ".gemini", "antigravity", "skills") },
    { dir: path.join(home, ".gemini", "config", "plugins"), from: "plugin", nested: "plugins" },
    { dir: path.join(home, ".gemini", "antigravity-cli", "builtin", "skills"), from: "builtin" },
  ];
  // Each tool's docs, November 2026 (Arun, 2026-11-19, "fetch and gather skills from all coding tools"): the folders each reads
  // besides its own and ~/.agents/skills. Managed ones are what an organisation installs for everybody on the computer.
  const managedClaude = process.platform === "darwin" ? "/Library/Application Support/ClaudeCode" : process.platform === "win32" ? "C:\\Program Files\\ClaudeCode" : "/etc/claude-code";
  out.claude = [...(out.claude ?? []), { dir: path.join(managedClaude, ".claude", "skills"), from: "managed" }];
  if (process.platform !== "win32") out.codex = [...(out.codex ?? []), { dir: "/etc/codex/skills", from: "managed" }];
  out.amp = [...(out.amp ?? []), { dir: path.join(home, ".config", "agents", "skills") }];
  out.droid = [...(out.droid ?? []), { dir: path.join(home, ".agent", "skills") }];
  out.devin = [...(out.devin ?? []), ...["windsurf", "windsurf-next", "windsurf-insiders"].map((w) => ({ dir: path.join(home, ".codeium", w, "skills") }))];
  return out;
}

/** VS Code's agent hosts, by the tool each is for: agent-plugins/vscode-synced-customization-agent-host-<host>-<n>/<id>/skills. */
const VSCODE_HOST: Record<string, EngineTool> = { copilotcli: "copilot", codex: "codex", claude: "claude" };

/** The skill folders a source holds: itself, or each set inside it. */
async function sourceDirs(s: Source, tool: EngineTool): Promise<string[]> {
  if (!s.nested) return [s.dir];
  const out: string[] = [];
  for (const a of await readdir(s.dir, { withFileTypes: true }).catch(() => [])) {
    if (!a.isDirectory() || a.name.startsWith(".")) continue;
    if (s.nested === "sets") {
      out.push(path.join(s.dir, a.name));
      continue;
    }
    if (s.nested === "plugins") {
      out.push(path.join(s.dir, a.name, "skills"));
      continue;
    }
    const host = a.name.match(/agent-host-([a-z]+)-/)?.[1] ?? "";
    if (VSCODE_HOST[host] !== tool) continue;
    for (const b of await readdir(path.join(s.dir, a.name), { withFileTypes: true }).catch(() => [])) if (b.isDirectory()) out.push(path.join(s.dir, a.name, b.name, "skills"));
  }
  return out;
}

/** Where skills are kept inside a repository, for every tool that reads its own there. */
const PROJECT_DIRS = [".claude", ".agents", ".codex", ".cursor", ".github", ".opencode", ".gemini", ".kiro", ".junie", ".factory", ".kilo", ".cline", ".clinerules", ".devin", ".windsurf", ".grok", ".qwen", ".roo", ".augment", ".agent"].map((d) => path.join(d, "skills"));

/**
 * Which repository a folder is a clone of: its origin, read from its own git config without running git ("git@github.com:a/b.git"
 * and "https://github.com/a/b" are the same), or the folder itself when it has none.
 */
export async function repoKey(dir: string): Promise<string> {
  const cfg = await readFile(path.join(dir, ".git", "config"), "utf8").catch(() => "");
  const url = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(cfg)?.[1];
  if (!url) return path.resolve(dir);
  return url
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(/:(?!\d)/, "/")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * Where a repository keeps skills, as the Skills page reads them: each tool's folder at its root, and a folder down (a monorepo's
 * client/.claude/skills). The skills note (shared-skills.ts) tells the coding tools about the same ones the page lists.
 */
export async function projectSkillDirs(root: string): Promise<string[]> {
  const roots = [root];
  for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (roots.length > 40) break;
    if (e.isDirectory() && !e.name.startsWith(".") && !/^(node_modules|dist|build|out|vendor|target|coverage)$/.test(e.name)) roots.push(path.join(root, e.name));
  }
  return roots.flatMap((r) => PROJECT_DIRS.map((d) => path.join(r, d)));
}

/** Your projects' own skills: each recent repository's (runner/workspace.ts recentReposCached), one shelf a project, Friday's copies left out. */
async function projectShelves(home: string, taken: Set<string>): Promise<Shelf[]> {
  const { recentReposCached } = await import("./workspace.js");
  const repos = await recentReposCached(home).catch(() => []);
  const worktrees = path.join(process.env.FRIDAY_HOME || path.join(home, ".friday"), "worktrees") + path.sep;
  const out: Shelf[] = [];
  // Two clones of one repository are one shelf (Arun, 2026-11-20: "look into duplicate skills": ~/Desktop/edge/edge and
  // ~/Friday/edge were two "edge" shelves of the same eight skills), the most recently used first.
  const byRepo = new Map<string, Shelf>();
  for (const r of repos.slice(0, 24)) {
    if (!r.path || r.path.startsWith(worktrees) || path.resolve(r.path) === path.resolve(home)) continue;
    const key = await repoKey(r.path);
    const had = byRepo.get(key);
    if (had) {
      (had.also ??= []).push(r.path);
      continue;
    }
    const named = new Set<string>();
    const skills: SkillRow[] = [];
    // The repository's own, and its packages' a folder down (a monorepo's client/.claude/skills), as a tool working there reads them.
    const roots = [r.path];
    for (const e of await readdir(r.path, { withFileTypes: true }).catch(() => [])) {
      if (roots.length > 40) break;
      if (e.isDirectory() && !e.name.startsWith(".") && !/^(node_modules|dist|build|out|vendor|target|coverage)$/.test(e.name)) roots.push(path.join(r.path, e.name));
    }
    for (const d of roots.flatMap((root) => PROJECT_DIRS.map((x) => path.join(path.relative(r.path, root), x)))) {
      const at = path.join(r.path, d);
      if (taken.has(path.resolve(at))) continue;
      taken.add(path.resolve(at));
      for (const s of await rowsIn(at)) if (!named.has(s.name) && named.add(s.name)) skills.push(s);
    }
    if (skills.length) {
      const shelf: Shelf = { id: `project:${r.path}`, label: r.name || path.basename(r.path), kind: "project", dir: r.path, skills: skills.sort((a, b) => a.name.localeCompare(b.name)) };
      byRepo.set(key, shelf);
      out.push(shelf);
    }
  }
  // Different repositories by one name: each said with the folder it's in ("edge · Desktop", "edge · Friday").
  const names = new Map<string, number>();
  for (const sh of out) names.set(sh.label, (names.get(sh.label) ?? 0) + 1);
  for (const sh of out) if ((names.get(sh.label) ?? 0) > 1) sh.label = `${sh.label} · ${path.basename(path.dirname(sh.dir))}`;
  return out;
}

/** The person's own skills, each coding tool's that has any (its own, built in, synced), its plugins', and your projects'. */
export async function readLibrary(home = homedir()): Promise<Library> {
  const dir = libraryDir(home);
  const mine = await rowsIn(dir);
  const shelves: Shelf[] = [];
  const seen = new Set([path.resolve(dir)]);
  for (const [tool, sources] of Object.entries(toolSources(home)) as [EngineTool, Source[]][]) {
    const named = new Set<string>();
    const skills: SkillRow[] = [];
    for (const s of sources) {
      for (const at of await sourceDirs(s, tool)) {
        const key = path.resolve(at);
        // A folder two tools share (OpenCode's and Claude Code's, say) is the first one's.
        if (seen.has(key)) continue;
        seen.add(key);
        // One skill by a name: the same skill synced in four sets, or in a tool's folder and its built-in one, shows once.
        for (const row of await rowsIn(at)) if (!named.has(row.name) && named.add(row.name)) skills.push(s.from ? { ...row, from: s.from } : row);
      }
    }
    if (skills.length) shelves.push({ id: tool, label: ENGINE_NAMES[tool], kind: "tool", tool, dir: sources[0]!.dir, skills: skills.sort((a, b) => a.name.localeCompare(b.name)) });
  }
  // Claude Code's plugins, one shelf for all of them: a person with a few plugins has dozens of these.
  const plugins = (await Promise.all((await pluginSkillDirs(home)).map(rowsIn))).flat();
  if (plugins.length) {
    const named = new Set<string>();
    const once = plugins.filter((s) => !named.has(s.name) && !!named.add(s.name)).sort((a, b) => a.name.localeCompare(b.name));
    shelves.push({ id: "claude-plugins", label: "Claude Code plugins", kind: "plugins", tool: "claude", dir: path.join(home, ".claude", "plugins"), skills: once.map((s) => ({ ...s, from: "plugin" as const })) });
  }
  shelves.push(...(await projectShelves(home, seen)));
  return { dir, mine, shelves };
}

/** Every file under a skill's folder, by its path inside it, SKILL.md left out. */
async function filesOf(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, rel: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (out.length >= 200 || e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(d, e.name), r);
      else if (r !== "SKILL.md") out.push(r);
    }
  };
  await walk(dir, "");
  return out.sort();
}

export interface SkillText {
  folder: string;
  name: string;
  description: string;
  body: string;
  files: string[];
}

/** One of the person's skills as written. */
export async function readSkill(folder: unknown, home = homedir()): Promise<SkillText> {
  if (!folderOk(folder)) throw new Error("That isn't one of your skills.");
  const dir = path.join(libraryDir(home), folder);
  const text = await readFile(path.join(dir, "SKILL.md"), "utf8").catch(() => null);
  if (text === null) throw new Error("That skill isn't in your skills any more.");
  const d = described(text);
  return { folder, name: d.name || folder, description: d.description.replace(/\s+/g, " ").trim(), body: frontmatter(text).body.replace(/^\s*\n/, "").trimEnd(), files: await filesOf(dir) };
}

/**
 * The header lines of a SKILL.md other than its name and description (license, metadata, allowed-tools…), kept as they were when
 * the page saves it: they are the author's, and the tools read some of them.
 */
function otherHeader(text: string): string {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return "";
  const keep: string[] = [];
  let skipping = false;
  for (const line of m[1]!.split(/\r?\n/)) {
    if (/^(name|description):/.test(line)) {
      skipping = true;
      continue;
    }
    // A name or description over several lines: its indented lines go with it.
    if (skipping && /^\s+\S/.test(line)) continue;
    skipping = false;
    keep.push(line);
  }
  return keep.join("\n").trim();
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** A SKILL.md: its name and description in the header (with any other lines it had), then its instructions. */
export function skillFile(o: { folder: string; description: string; body: string; header?: string }): string {
  const description = oneLine(o.description).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `---\nname: ${o.folder}\ndescription: "${description}"\n${o.header ? `${o.header}\n` : ""}---\n\n${o.body.trim()}\n`;
}

/**
 * A new skill, or one of the person's changed. Its folder is its name as the tools call it (lower case and hyphens), so a new name
 * moves the folder, with everything in it; a name another skill has is refused, never written over.
 */
export async function saveSkill(input: { folder?: unknown; name?: unknown; description?: unknown; body?: unknown }, home = homedir()): Promise<SkillRow> {
  const name = typeof input.name === "string" ? oneLine(input.name).slice(0, 80) : "";
  const description = typeof input.description === "string" ? oneLine(input.description).slice(0, MAX_DESCRIPTION) : "";
  const body = typeof input.body === "string" ? input.body.slice(0, MAX_BODY) : "";
  if (!name) throw new Error("Give the skill a name.");
  if (!description) throw new Error("Say when an agent should use it: that line is how the tools decide.");
  if (!body.trim()) throw new Error("Write what the agent should do.");
  const lib = libraryDir(home);
  const folder = skillSlug(name);
  const was = input.folder === undefined || input.folder === "" ? null : input.folder;
  if (was !== null && !folderOk(was)) throw new Error("That isn't one of your skills.");
  const target = path.join(lib, folder);
  const taken = await stat(target).then(() => true, () => false);
  if (was === null && taken) throw new Error(`You already have a skill called ${folder}. Give this one another name, or open that one.`);
  let header = "";
  if (was !== null) {
    const from = path.join(lib, was);
    const before = await readFile(path.join(from, "SKILL.md"), "utf8").catch(() => null);
    if (before === null) throw new Error("That skill isn't in your skills any more.");
    header = otherHeader(before);
    if (was !== folder) {
      if (taken) throw new Error(`You already have a skill called ${folder}. Give this one another name.`);
      await rename(from, target);
    }
  }
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "SKILL.md"), skillFile({ folder, description, body, header }), "utf8");
  return { folder, name: folder, description, dir: target, files: await countFiles(target) };
}

/** A skill out of the person's skills, into Friday's trash folder, from where it can be moved back. */
export async function removeSkill(folder: unknown, home = homedir()): Promise<{ trashed: string }> {
  if (!folderOk(folder)) throw new Error("That isn't one of your skills.");
  const from = path.join(libraryDir(home), folder);
  if (!(await stat(from).then((s) => s.isDirectory(), () => false))) throw new Error("That skill isn't in your skills any more.");
  const to = path.join(trashDir(home), `${folder}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(path.dirname(to), { recursive: true });
  await rename(from, to).catch(async () => {
    // Another disk: copy, then the original goes.
    await cp(from, to, { recursive: true });
    await rm(from, { recursive: true, force: true });
  });
  return { trashed: to };
}

/**
 * A coding tool's own skill, or a project's, deleted (Arun, 2026-11-20: "also allow for deleting of skills too"): its folder moves to
 * Friday's trash, as one of yours does, so it can be put back. Only a skill the page listed in a tool's own folder or a project's:
 * one that comes with the tool, a plugin's, a synced set's or one an organisation manages is theirs, and isn't deleted here.
 */
export async function removeAt(dir: unknown, home = homedir()): Promise<{ trashed: string }> {
  if (typeof dir !== "string" || !path.isAbsolute(dir)) throw new Error("Which skill?");
  const lib = await readLibrary(home);
  const shelf = lib.shelves.find((s) => s.skills.some((k) => path.resolve(k.dir) === path.resolve(dir)));
  const row = shelf?.skills.find((k) => path.resolve(k.dir) === path.resolve(dir));
  if (!shelf || !row) throw new Error("That skill isn't in one of your coding tools' folders any more.");
  if (shelf.kind === "plugins" || row.from) throw new Error("That skill comes with its tool or a plugin, so it can't be deleted on its own.");
  const name = folderOk(row.folder) ? row.folder : skillSlug(row.name);
  const to = path.join(trashDir(home), `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(path.dirname(to), { recursive: true });
  await rename(row.dir, to).catch(async () => {
    await cp(row.dir, to, { recursive: true });
    await rm(row.dir, { recursive: true, force: true });
  });
  return { trashed: to };
}

/**
 * A coding tool's skill copied into the person's skills, the whole folder (scripts and references too), so every tool has it and
 * it can be changed here. Only from a folder the page listed; the tool keeps its own.
 */
export async function copyIn(dir: unknown, home = homedir()): Promise<SkillRow> {
  if (typeof dir !== "string" || !path.isAbsolute(dir)) throw new Error("Which skill?");
  const lib = await readLibrary(home);
  const row = lib.shelves.flatMap((s) => s.skills).find((s) => path.resolve(s.dir) === path.resolve(dir));
  if (!row) throw new Error("That skill isn't in one of your coding tools' folders.");
  const folder = folderOk(row.folder) ? row.folder : skillSlug(row.name);
  const target = path.join(lib.dir, folder);
  if (await stat(target).then(() => true, () => false)) throw new Error(`You already have a skill called ${folder}.`);
  await mkdir(lib.dir, { recursive: true });
  await cp(row.dir, target, { recursive: true, dereference: true, filter: (src) => !path.basename(src).startsWith(".git") });
  return { ...row, folder, dir: target };
}

/** A file's path inside a skill's folder, when it stays inside it. */
const safeRel = (p: unknown): string | null => {
  if (typeof p !== "string" || !p || p.length > 300 || path.isAbsolute(p) || /^[a-z]:/i.test(p)) return null;
  const parts = p.split(/[\\/]+/);
  return parts.some((x) => !x || x === "." || x === "..") ? null : parts.join(path.sep);
};

/**
 * Skills brought from GitHub (skill-import.ts readSkillFolders), each written as its folder with its files at their own paths. One
 * the person already has by that name is left as it is, and said.
 */
export async function writeFolders(folders: unknown, home = homedir()): Promise<{ added: SkillRow[]; skipped: { folder: string; why: string }[] }> {
  const list = Array.isArray(folders) ? folders.slice(0, 25) : [];
  const lib = libraryDir(home);
  const added: SkillRow[] = [];
  const skipped: { folder: string; why: string }[] = [];
  for (const f of list as { folder?: unknown; skill?: unknown; files?: unknown }[]) {
    const raw = typeof f?.folder === "string" ? f.folder : "";
    const folder = folderOk(raw) ? raw : skillSlug(raw);
    if (typeof f?.skill !== "string" || !f.skill.trim()) {
      skipped.push({ folder, why: "It had no SKILL.md to bring." });
      continue;
    }
    const target = path.join(lib, folder);
    if (await stat(target).then(() => true, () => false)) {
      skipped.push({ folder, why: "You already have a skill by that name, so it was left as it is." });
      continue;
    }
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "SKILL.md"), f.skill.slice(0, MAX_BODY * 2), "utf8");
    for (const file of Array.isArray(f.files) ? (f.files as { path?: unknown; text?: unknown }[]).slice(0, 40) : []) {
      const rel = safeRel(file?.path);
      if (!rel || typeof file.text !== "string" || rel === "SKILL.md") continue;
      await mkdir(path.dirname(path.join(target, rel)), { recursive: true });
      await writeFile(path.join(target, rel), file.text.slice(0, 200_000), "utf8");
    }
    const text = f.skill;
    const d = described(text);
    added.push({ folder, name: d.name || folder, description: oneLine(d.description), dir: target, files: await countFiles(target) });
  }
  return { added, skipped };
}

// ── Reading any skill the page lists, and copies ───────────────────────────────

/** The folder of a skill the page lists (one of the person's, or a coding tool's), or null for anything else. */
async function listedDir(dir: unknown, home: string): Promise<{ dir: string; mine: boolean } | null> {
  if (typeof dir !== "string" || !path.isAbsolute(dir)) return null;
  const lib = await readLibrary(home);
  const want = path.resolve(dir);
  if (lib.mine.some((s) => path.resolve(s.dir) === want)) return { dir: want, mine: true };
  if (lib.shelves.some((sh) => sh.skills.some((s) => path.resolve(s.dir) === want))) return { dir: want, mine: false };
  return null;
}

/** Any skill the page lists, as written: the person's own or a coding tool's (to read before copying it). */
export async function readSkillAt(dir: unknown, home = homedir()): Promise<SkillText & { mine: boolean; dir: string }> {
  const at = await listedDir(dir, home);
  if (!at) throw new Error("That skill isn't on this computer any more.");
  const text = await readFile(path.join(at.dir, "SKILL.md"), "utf8").catch(() => null);
  if (text === null) throw new Error("That skill isn't on this computer any more.");
  const d = described(text);
  const folder = path.basename(at.dir);
  return { folder, name: d.name || folder, description: d.description.replace(/\s+/g, " ").trim(), body: frontmatter(text).body.replace(/^\s*\n/, "").trimEnd(), files: await filesOf(at.dir), mine: at.mine, dir: at.dir };
}

/** A file beside a skill's SKILL.md, as text, to read on the page: 200 KB at most, and only inside the skill's folder. */
export async function readSkillFile(dir: unknown, file: unknown, home = homedir()): Promise<{ text: string; cut: boolean }> {
  const at = await listedDir(dir, home);
  const rel = safeRel(file);
  if (!at || !rel) throw new Error("That file isn't in the skill.");
  const full = path.join(at.dir, rel);
  if (!full.startsWith(at.dir + path.sep)) throw new Error("That file isn't in the skill.");
  const buf = await readFile(full).catch(() => null);
  if (!buf) throw new Error("That file isn't there any more.");
  if (buf.subarray(0, 8000).includes(0)) return { text: "", cut: true };
  return { text: buf.subarray(0, 200_000).toString("utf8"), cut: buf.length > 200_000 };
}

/** A copy of one of the person's skills under a free name (<folder>-copy, -copy-2…), with everything in its folder. */
export async function duplicateSkill(folder: unknown, home = homedir()): Promise<SkillRow> {
  if (!folderOk(folder)) throw new Error("That isn't one of your skills.");
  const lib = libraryDir(home);
  const from = path.join(lib, folder);
  const text = await readFile(path.join(from, "SKILL.md"), "utf8").catch(() => null);
  if (text === null) throw new Error("That skill isn't in your skills any more.");
  let to = `${folder}-copy`.slice(0, 80);
  for (let n = 2; await stat(path.join(lib, to)).then(() => true, () => false); n++) to = `${folder}-copy-${n}`.slice(0, 80);
  await cp(from, path.join(lib, to), { recursive: true });
  const d = described(text);
  await writeFile(path.join(lib, to, "SKILL.md"), skillFile({ folder: to, description: d.description, body: frontmatter(text).body, header: otherHeader(text) }), "utf8");
  return { folder: to, name: to, description: oneLine(d.description), dir: path.join(lib, to), files: await countFiles(path.join(lib, to)) };
}

/**
 * Every folder of skills each tool reads besides its own main one (synced, built in, from VS Code, plugins, managed), expanded: for
 * the note that tells every other tool what's there (shared-skills.ts), so an agent in Codex can use a skill synced to Claude Code.
 */
export async function toolSkillDirs(home = homedir()): Promise<{ tool: EngineTool; dir: string }[]> {
  const out: { tool: EngineTool; dir: string }[] = [];
  for (const [tool, sources] of Object.entries(toolSources(home)) as [EngineTool, Source[]][]) for (const s of sources.slice(1)) for (const dir of await sourceDirs(s, tool)) out.push({ tool, dir });
  return out;
}

/**
 * Every skill on this computer as Friday's own agent carries them, for a teammate on one of your own models in the open-source edition
 * (Arun, 2026-11-20: "make sure all of the codings tools and agent crews are able to use the skills"): it had none at all. Yours first,
 * then each tool's, its plugins' and your projects', by name and what each is for; the instructions are read when it uses one
 * (localSkillText), so a hundred and fifty skills cost a menu, not their text. A name already listed isn't listed again.
 */
let briefsKept: { at: number; briefs: SkillBrief[] } | null = null;
export async function localSkillBriefs(home = homedir()): Promise<SkillBrief[]> {
  if (briefsKept && Date.now() - briefsKept.at < 60_000) return briefsKept.briefs;
  const lib = await readLibrary(home);
  const seen = new Set<string>();
  const briefs: SkillBrief[] = [];
  const add = (rows: SkillRow[], group: string) => {
    for (const r of rows) {
      const key = r.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      briefs.push({ id: r.dir, name: r.name, description: r.description, instructions: "", group, lazy: { owner: "local" } });
    }
  };
  add(lib.mine, "Yours");
  for (const sh of lib.shelves) add(sh.skills, sh.label);
  briefsKept = { at: Date.now(), briefs };
  return briefs;
}

/** A skill's instructions when the agent uses one: its SKILL.md, and where its folder is for the scripts and references it names. */
export async function localSkillText(dir: string, home = homedir()): Promise<string | null> {
  const s = await readSkillAt(dir, home).catch(() => null);
  return s ? `${s.body}\n\n(Its folder, with any scripts or references it names: ${s.dir})` : null;
}
