import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { ENGINE_NAMES, type EngineTool } from "../types.js";
import { frontmatter, skillHomes } from "./tool-commands.js";

/**
 * The skills already on this computer, for every coding tool Friday runs (Arun, 2026-10-21: "ensure the coding tools are able
 * to use their skills and stuff that is already downloaded too").
 *
 * Each tool loads skills from its own folders only: the ones a person downloaded for Claude Code (~/.claude/skills, a plugin's,
 * a repository's .claude/skills) were there for Claude Code and nowhere else, so Codex, Cursor or Gemini working in the same
 * session never knew they existed. A skill is a folder with a SKILL.md, instructions any of them can follow, so each tool is told
 * the skills it doesn't load by itself, with where its SKILL.md is, in its standing note: nothing is copied or installed.
 */
export interface MachineSkill {
  name: string;
  description: string;
  file: string;
}

/** Where skills are kept, the repository's first: each tool's own folder, the shared ~/.agents, and Claude Code's plugins. */
export function skillDirs(cwd: string, home = homedir()): string[] {
  const project = [".claude", ".agents", ".codex", ".cursor", ".opencode", ".gemini", ".github"].map((d) => path.join(cwd, d, "skills"));
  const user = [...new Set([...Object.values(skillHomes(home)), path.join(home, ".agents", "skills"), path.join(home, ".cursor", "skills-cursor")])];
  return [...project, ...user];
}

/** The folders each tool reads skills from by itself (its docs, October 2026): what is in them it needs no note about. */
export function nativeDirs(tool: EngineTool, cwd: string, home = homedir()): string[] {
  const own = skillHomes(home)[tool];
  const agents = [path.join(cwd, ".agents", "skills"), path.join(home, ".agents", "skills")];
  const claude = [path.join(cwd, ".claude", "skills"), path.join(home, ".claude", "skills")];
  switch (tool) {
    case "claude":
      return claude;
    case "codex":
      return [own!, path.join(cwd, ".codex", "skills"), ...agents];
    // OpenCode reads Claude Code's folders as well as its own.
    case "opencode":
      return [own!, path.join(cwd, ".opencode", "skills"), ...claude, ...agents];
    case "cursor":
      return [own!, path.join(cwd, ".cursor", "skills"), path.join(home, ".cursor", "skills-cursor")];
    default:
      return own ? [own] : [];
  }
}

/** A header value over several lines (`description: >` and the indented lines under it), as one line. */
function described(text: string): { name?: string; description: string } {
  const { meta } = frontmatter(text);
  let description = meta.description ?? "";
  if (!description || /^[>|][+-]?$/.test(description)) {
    const head = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
    const m = head.match(/^description:\s*[>|]?[+-]?\s*\r?\n((?:[ \t]+.*(?:\r?\n|$))+)/m);
    description = m ? m[1]!.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(" ") : "";
  }
  return { ...(meta.name ? { name: meta.name } : {}), description };
}

/** Each `<folder>/SKILL.md` in a folder. */
async function skillsIn(dir: string): Promise<MachineSkill[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: MachineSkill[] = [];
  for (const e of entries) {
    if ((!e.isDirectory() && !e.isSymbolicLink()) || e.name.startsWith(".")) continue;
    const file = path.join(dir, e.name, "SKILL.md");
    const text = await readFile(file, "utf8").catch(() => null);
    if (text === null) continue;
    const d = described(text);
    out.push({ name: d.name || e.name, description: d.description, file });
  }
  return out;
}

/** The skills of Claude Code's installed plugins: each plugin's own skills folder. */
async function pluginSkillDirs(home: string): Promise<string[]> {
  const raw = await readFile(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "plugins", "installed_plugins.json"), "utf8").catch(() => "");
  try {
    const j = JSON.parse(raw) as { plugins?: Record<string, { installPath?: string }[]> };
    return Object.values(j.plugins ?? {}).flatMap((list) => list.map((p) => p.installPath).filter((p): p is string => !!p).map((p) => path.join(p, "skills")));
  } catch {
    return [];
  }
}

/** How many skills a note names, and how much of each one's description, so a machine with hundreds stays a short read. */
const MAX_SKILLS = 80;
const MAX_DESCRIPTION = 120;

const clipped = (s: string) => {
  const one = s.replace(/\s+/g, " ").trim();
  if (one.length <= MAX_DESCRIPTION) return one;
  const cut = one.slice(0, MAX_DESCRIPTION);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 80 ? cut.lastIndexOf(" ") : cut.length)}…`;
};

/**
 * The note for `tool` about the skills on this computer it doesn't load by itself, or "" when there are none. A name it has
 * a skill of its own by wins, and of two the same elsewhere the first found (the repository's) does.
 */
export async function skillsNote(tool: EngineTool, cwd: string, home = homedir()): Promise<string> {
  const plugins = (await pluginSkillDirs(home)).map((d) => path.resolve(d));
  // Claude Code loads its plugins' skills itself.
  const native = [...nativeDirs(tool, cwd, home).map((d) => path.resolve(d)), ...(tool === "claude" ? plugins : [])];
  const others = [...skillDirs(cwd, home).map((d) => path.resolve(d)), ...plugins].filter((d, i, all) => !native.includes(d) && all.indexOf(d) === i);
  const seen = new Set((await Promise.all(native.map(skillsIn))).flat().map((s) => s.name));
  const found: MachineSkill[] = [];
  for (const s of (await Promise.all(others.map(skillsIn))).flat()) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    found.push(s);
  }
  if (!found.length) return "";
  // By folder, each named once: a plugin's folder is a long path, and fifty of its skills repeated it fifty times.
  const at = (f: string) => (f === cwd || f.startsWith(cwd + path.sep) ? `.${f.slice(cwd.length)}` : f.startsWith(home + path.sep) ? `~${f.slice(home.length)}` : f);
  const shown = found.slice(0, MAX_SKILLS);
  const byDir = new Map<string, MachineSkill[]>();
  for (const s of shown) {
    const dir = path.dirname(path.dirname(s.file));
    byDir.set(dir, [...(byDir.get(dir) ?? []), s]);
  }
  return [
    `Skills on this computer that ${ENGINE_NAMES[tool]} doesn't load by itself, downloaded for the other coding tools. Each is a folder holding a SKILL.md (its instructions, and sometimes scripts or references beside it): <folder>/<skill>/SKILL.md. When a task matches one, read its SKILL.md first and follow it.`,
    ...[...byDir].flatMap(([dir, list]) => [
      `In ${at(dir)}:`,
      ...list.map((s) => {
        const folder = path.basename(path.dirname(s.file));
        return `- ${s.name}${folder !== s.name ? ` (folder ${folder})` : ""}${s.description ? `: ${clipped(s.description)}` : ""}`;
      }),
    ]),
    ...(found.length > shown.length ? [`…and ${found.length - shown.length} more in the same folders.`] : []),
  ].join("\n");
}
