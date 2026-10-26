import { lstat, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Agents people already wrote for their own coding tools.
 *
 * Claude Code keeps each as a Markdown file with a little front matter (name,
 * description) and the prompt as the body. Cursor keeps rules the same way, as
 * `.mdc` files, and Codex keeps an `AGENTS.md` and a folder of custom prompts.
 * Friday reads the ones on this machine and offers them; the person chooses.
 *
 * Only these folders are ever read, only plain files in them (a link is
 * skipped, so a folder cannot point this at something else), and nothing
 * leaves the machine until the person has ticked it.
 */

export type AgentSource = "claude" | "cursor" | "codex";

export interface FoundAgent {
  source: AgentSource;
  /** Where it lives: yours everywhere, or one project's. */
  scope: "user" | "project";
  /** What a second import of the same file is recognised by, so it updates rather than adds. */
  key: string;
  name: string;
  description: string;
  /** What the agent is told. */
  instructions: string;
  /** The file it came from, shown so people can tell two of the same name apart. */
  path: string;
  /** Said when the prompt was cut to fit. */
  note?: string;
}

const MAX_PER_FOLDER = 60;
const MAX_READ = 200_000;
/** What an agent may be told: the same ceiling the agent store enforces. */
export const MAX_INSTRUCTIONS = 8000;

/** `---` fenced `key: value` lines, then the rest. Only the flat shape these tools write. */
export function frontMatter(text: string): { data: Record<string, string>; body: string } {
  const m = text.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    data[kv[1]!.toLowerCase()] = v;
  }
  return { data, body: m[2]! };
}

const humanise = (file: string) =>
  file
    .replace(/\.(mdc?|markdown)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();

const firstLine = (body: string) => (body.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "").slice(0, 200);

/** The plain files of a folder with these extensions, and nothing that is a link or a folder. */
async function filesIn(dir: string, ext: RegExp): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile() && !e.isSymbolicLink() && ext.test(e.name))
    .map((e) => e.name)
    .sort()
    .slice(0, MAX_PER_FOLDER);
}

async function readPlain(file: string): Promise<string | null> {
  const st = await lstat(file).catch(() => null);
  if (!st || !st.isFile() || st.isSymbolicLink() || st.size > MAX_READ * 5) return null;
  return readFile(file, "utf8").then((t) => t.slice(0, MAX_READ), () => null);
}

function make(source: AgentSource, scope: FoundAgent["scope"], key: string, file: string, fallbackName: string, text: string, extra?: (d: Record<string, string>) => string): FoundAgent | null {
  const { data, body } = frontMatter(text);
  let instructions = body.trim();
  if (!instructions) return null;
  const about = extra?.(data);
  if (about) instructions = `${about}\n\n${instructions}`;
  let note: string | undefined;
  if (instructions.length > MAX_INSTRUCTIONS) {
    instructions = instructions.slice(0, MAX_INSTRUCTIONS - 1).trimEnd() + "…";
    note = "Cut to fit: agents hold 8,000 characters.";
  }
  return {
    source,
    scope,
    key,
    name: (data.name || fallbackName).slice(0, 40),
    description: (data.description || firstLine(body)).slice(0, 200),
    instructions,
    path: file,
    ...(note ? { note } : {}),
  };
}

/**
 * Everything agent-like on this machine: the person's own, and each project folder's.
 * `roots` are folders already known to the app (the ones sessions have used); nothing else is walked.
 */
export async function discoverAgentFiles(roots: string[], home = homedir()): Promise<FoundAgent[]> {
  const out: FoundAgent[] = [];
  const add = (a: FoundAgent | null) => a && out.push(a);

  // Claude Code: ~/.claude/agents/*.md, and <project>/.claude/agents/*.md.
  const claude = async (dir: string, scope: "user" | "project", tag: string) => {
    for (const f of await filesIn(dir, /\.md$/i)) {
      const t = await readPlain(path.join(dir, f));
      if (t) add(make("claude", scope, `claude:${tag}/${f}`, path.join(dir, f), humanise(f), t));
    }
  };
  await claude(path.join(home, ".claude", "agents"), "user", "user");

  // Codex: ~/.codex/AGENTS.md and ~/.codex/prompts/*.md, and <project>/AGENTS.md.
  const agentsMd = await readPlain(path.join(home, ".codex", "AGENTS.md"));
  if (agentsMd) add(make("codex", "user", "codex:user/AGENTS.md", path.join(home, ".codex", "AGENTS.md"), "Codex instructions", agentsMd));
  const prompts = path.join(home, ".codex", "prompts");
  for (const f of await filesIn(prompts, /\.md$/i)) {
    const t = await readPlain(path.join(prompts, f));
    if (t) add(make("codex", "user", `codex:user/prompts/${f}`, path.join(prompts, f), humanise(f), t));
  }

  for (const root of [...new Set(roots)].slice(0, 12)) {
    const tag = path.basename(root) || "project";
    await claude(path.join(root, ".claude", "agents"), "project", tag);
    // Cursor: .cursor/rules/*.mdc (or .md), and the older single-file .cursorrules.
    const rules = path.join(root, ".cursor", "rules");
    for (const f of await filesIn(rules, /\.mdc?$/i)) {
      const t = await readPlain(path.join(rules, f));
      if (t)
        add(
          make("cursor", "project", `cursor:${tag}/${f}`, path.join(rules, f), humanise(f), t, (d) =>
            d.globs ? `Applies to: ${d.globs}` : d.alwaysapply === "true" ? "Always applies." : "",
          ),
        );
    }
    const legacy = await readPlain(path.join(root, ".cursorrules"));
    if (legacy) add(make("cursor", "project", `cursor:${tag}/.cursorrules`, path.join(root, ".cursorrules"), `${humanise(tag)} rules`, legacy));
    const project = await readPlain(path.join(root, "AGENTS.md"));
    if (project) add(make("codex", "project", `codex:${tag}/AGENTS.md`, path.join(root, "AGENTS.md"), `${humanise(tag)} instructions`, project));
  }
  return out;
}


/**
 * What `cursor-agent models` prints, as a list.
 *
 * One `id - Name` per line, with the account's current and default marked in
 * brackets. Anything that is not that shape (a heading, a tip) is skipped, so
 * an answer this cannot read is an empty list, and the pill falls back to its own.
 */
export function parseModelList(out: string): { id: string; label: string; current?: boolean }[] {
  const rows: { id: string; label: string; current?: boolean }[] = [];
  for (const raw of out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split(/\r?\n/)) {
    const m = raw.trim().match(/^([\w][\w.\-/[\]]{1,59})\s+-\s+(.+)$/);
    if (!m) continue;
    const flags = /\((?:[^)]*\b)?(current|default)\b[^)]*\)\s*$/i.exec(m[2]!);
    const label = m[2]!.replace(/\s*\([^)]*\)\s*$/, "").trim() || m[1]!;
    if (!rows.some((r) => r.id === m[1])) rows.push({ id: m[1]!, label, ...(flags ? { current: true } : {}) });
  }
  return rows.slice(0, 200);
}
