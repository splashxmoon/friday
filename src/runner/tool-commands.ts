import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { ENGINE_NAMES, type EngineTool, type ToolCommand } from "../types.js";

/**
 * The `/` commands Codex and Cursor have that still work when Friday runs them, and what each becomes.
 *
 * Their built-in ones (/model, /compact, /review…) belong to their interactive terminals: run headless, a message that starts
 * with one is plain text. What carries over is what people wrote for them, prompt and command files, which their terminals
 * expand into the message, and skills. Friday expands those the same way (`expandCommand`). Claude Code's come from Claude
 * Code itself (WarmClaude.commands), which runs its own.
 */
export interface FoundCommand extends ToolCommand {
  file: string;
  kind: "prompt" | "skill";
}

/**
 * Codex's own `/review` and `/compact`, which its terminal runs and `codex exec` doesn't: over its app-server Friday runs them the
 * same way (`review/start`, `thread/compact/start`; see `codex` in adapters.ts), so they are in its menu too (Arun, 2026-10-18:
 * the tools as capable in Friday as on their own).
 */
export const CODEX_BUILTINS: ToolCommand[] = [
  { name: "review", description: "Review the changes not yet committed, or those against a branch (base main), a commit, or what you describe", hint: "[base <branch> | <commit> | what to look at]", insert: "/review " },
  { name: "compact", description: "Summarise the conversation so far, to free up room for what comes next", insert: "/compact" },
];

/**
 * What `/review` was asked to look at, as Codex's `review/start` takes it: the uncommitted changes by default, a branch to compare
 * with ("base main", "against main"), a commit by its hash, or anything else as what to look for.
 */
export function reviewTarget(args: string): Record<string, unknown> {
  const a = args.trim();
  if (!a) return { type: "uncommittedChanges" };
  const base = /^(?:base|against|vs\.?|branch)\s+(\S+)$/i.exec(a);
  if (base) return { type: "baseBranch", branch: base[1] };
  const sha = /^(?:commit\s+)?([0-9a-f]{7,40})$/i.exec(a);
  if (sha) return { type: "commit", sha: sha[1], title: null };
  return { type: "custom", instructions: a };
}

/** A Markdown file's `---` header, as key: value, and what follows it. */
export function frontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const meta: Record<string, string> = {};
  if (m) {
    for (const line of m[1]!.split(/\r?\n/)) {
      const kv = line.match(/^([\w-]+):\s*(.*)$/);
      if (kv) meta[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "").trim();
    }
  }
  return { meta, body: m ? text.slice(m[0].length) : text };
}

const firstLine = (s: string) => (s.split("\n").find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").trim().slice(0, 160);

/** Each `<name>.md` in a folder, as the command `name(stem)`. */
async function promptFiles(dir: string, name: (stem: string) => string): Promise<FoundCommand[]> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.toLowerCase().endsWith(".md"));
  return Promise.all(
    files.map(async (f) => {
      const file = path.join(dir, f);
      const { meta, body } = frontmatter(await readFile(file, "utf8").catch(() => ""));
      const n = name(f.slice(0, -3));
      return { name: n, description: meta.description || firstLine(body), ...(meta["argument-hint"] ? { hint: meta["argument-hint"] } : {}), insert: `/${n} `, file, kind: "prompt" as const };
    }),
  );
}

/** Each `<folder>/SKILL.md` in a folder, as the skill its header names. */
async function skills(dir: string, insert: (name: string) => string): Promise<FoundCommand[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: FoundCommand[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const file = path.join(dir, e.name, "SKILL.md");
    const text = await readFile(file, "utf8").catch(() => null);
    if (text === null) continue;
    const { meta } = frontmatter(text);
    const n = meta.name || e.name;
    out.push({ name: n, description: meta.description ?? "", insert: insert(n), file, kind: "skill" });
  }
  return out;
}

/**
 * Codex: its prompts (~/.codex/prompts, `/prompts:<name>` as its terminal names them) and skills (`$<name>`, its own way of
 * calling one, which it reads in any message). Cursor: its commands (the project's .cursor/commands, then the person's) and
 * skills. The first of a name wins: the project's over the person's.
 */
export async function toolCommandsIn(tool: "codex" | "cursor", cwd: string, home = homedir()): Promise<FoundCommand[]> {
  const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
  const slash = (n: string) => `/${n} `;
  const lists =
    tool === "codex"
      ? [promptFiles(path.join(codexHome, "prompts"), (s) => `prompts:${s}`), skills(path.join(cwd, ".codex", "skills"), (n) => `$${n} `), skills(path.join(codexHome, "skills"), (n) => `$${n} `)]
      : [
          promptFiles(path.join(cwd, ".cursor", "commands"), (s) => s),
          promptFiles(path.join(home, ".cursor", "commands"), (s) => s),
          skills(path.join(cwd, ".cursor", "skills"), slash),
          skills(path.join(home, ".cursor", "skills"), slash),
          skills(path.join(home, ".cursor", "skills-cursor"), slash),
        ];
  const seen = new Set<string>();
  return (await Promise.all(lists)).flat().filter((c) => !seen.has(c.name) && !!seen.add(c.name));
}

/**
 * The skills any other tool reads from its own folder (skillHomes), each as the `/name` it is called by there: what its menu
 * can offer before the tool has listed its own commands (over ACP it does so only once a conversation is open).
 */
export async function skillCommands(tool: EngineTool, home = homedir()): Promise<FoundCommand[]> {
  const at = skillHomes(home)[tool];
  return at ? skills(at, (n) => `/${n} `) : [];
}

/**
 * A `/command args` message as the tool's terminal would send it: a prompt or command file's text with the arguments put in
 * ($ARGUMENTS, $1…$9, or after it when it has neither), or a skill to read and follow. Null when it isn't one of them.
 */
export async function expandCommand(text: string, found: FoundCommand[]): Promise<string | null> {
  const m = text.trim().match(/^\/([\w:.-]+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const c = found.find((f) => f.insert.trim() === `/${m[1]}`);
  if (!c) return null;
  const args = (m[2] ?? "").trim();
  if (c.kind === "skill") return `Use the "${c.name}" skill: read ${c.file} and follow it.${args ? `\n\n${args}` : ""}`;
  const { body } = frontmatter(await readFile(c.file, "utf8").catch(() => ""));
  const words = args.split(/\s+/).filter(Boolean);
  const placed = /\$ARGUMENTS|\$[1-9]/.test(body);
  const out = body.replace(/\$ARGUMENTS/g, args).replace(/\$([1-9])/g, (_, n: string) => words[Number(n) - 1] ?? "");
  return `${out.trim()}${args && !placed ? `\n\n${args}` : ""}`;
}

// ── Putting a skill into a coding tool ──────────────────────────────────

/** Where each tool reads the person's own skills: one folder per skill, holding its SKILL.md. A tool not here reads none Friday can add. */
export function skillHomes(home = homedir()): Partial<Record<EngineTool, string>> {
  return {
    claude: path.join(home, ".claude", "skills"),
    codex: path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "skills"),
    cursor: path.join(home, ".cursor", "skills"),
    copilot: path.join(home, ".copilot", "skills"),
    // Each tool's own folder, from its docs (October 2026). Several also read ~/.agents/skills, which is shared.
    opencode: path.join(home, ".config", "opencode", "skills"),
    gemini: path.join(process.env.GEMINI_CLI_HOME || home, ".gemini", "skills"),
    devin: process.platform === "win32" && process.env.APPDATA ? path.join(process.env.APPDATA, "devin", "skills") : path.join(home, ".config", "devin", "skills"),
    junie: path.join(home, ".junie", "skills"),
    kiro: path.join(home, ".kiro", "skills"),
    droid: path.join(home, ".factory", "skills"),
    grok: path.join(home, ".grok", "skills"),
    cline: path.join(home, ".cline", "skills"),
    kilo: path.join(home, ".kilo", "skills"),
    amp: path.join(home, ".config", "amp", "skills"),
  };
}

/** A skill's folder name and the name the tools call it by: lower case, digits and hyphens. */
export const skillSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "skill";

/** Marks a SKILL.md that Friday wrote, so adding it again updates it and one somebody wrote is never overwritten. */
const WRITTEN_BY_FRIDAY = "<!-- Added from Friday. Adding it again from Friday updates this file. -->";

/**
 * One of Friday's skills, written into each chosen tool as a skill of its own: it is then in that tool's `/` menu (`$name` in
 * Codex), in a Friday session and outside one. A skill of the same name that Friday didn't write is left alone, and said.
 */
export async function installSkill(
  s: { name: string; description: string; instructions: string },
  tools: EngineTool[],
  home = homedir(),
): Promise<{ added: { tool: EngineTool; file: string; call: string }[]; skipped: { tool: EngineTool; why: string }[] }> {
  const slug = skillSlug(s.name);
  const homes = skillHomes(home);
  // One line, in quotes, with nothing that could end the quote or the header.
  const description = (s.description || s.name).replace(/\s+/g, " ").replace(/["\\]/g, "'").trim().slice(0, 300);
  const text = `---\nname: ${slug}\ndescription: "${description}"\n---\n\n${WRITTEN_BY_FRIDAY}\n\n${s.instructions.trim()}\n`;
  const added: { tool: EngineTool; file: string; call: string }[] = [];
  const skipped: { tool: EngineTool; why: string }[] = [];
  for (const tool of tools) {
    const at = homes[tool];
    if (!at) {
      skipped.push({ tool, why: `${ENGINE_NAMES[tool]} doesn't read skills from a folder Friday can add to.` });
      continue;
    }
    const file = path.join(at, slug, "SKILL.md");
    const before = await readFile(file, "utf8").catch(() => null);
    if (before !== null && !before.includes(WRITTEN_BY_FRIDAY)) {
      skipped.push({ tool, why: `${ENGINE_NAMES[tool]} already has a skill called ${slug} of its own, so it was left as it is.` });
      continue;
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, "utf8");
    added.push({ tool, file, call: tool === "codex" ? `$${slug}` : `/${slug}` });
  }
  return { added, skipped };
}
