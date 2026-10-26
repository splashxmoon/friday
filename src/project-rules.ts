/**
 * The project's standing instructions: the file a team keeps for how work is done in this repository.
 *
 * Claude Code reads `CLAUDE.md`, Codex reads `AGENTS.md`, and a team that uses both keeps both. Their own tools load them
 * natively. Friday's agent reads them from the folder at the start of every run, so the same rules hold whichever agent is
 * doing the work, and the session has one place where people can see and change them.
 */

export const RULE_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
export type RuleFile = (typeof RULE_FILES)[number];

/** Each file is capped, and so are they together: a rules file is guidance, not a second repository. */
export const RULE_FILE_CAP = 20_000;
const RULES_TOTAL_CAP = 32_000;

/** What `read` says when there is nothing to read. */
export function isMissing(output: string): boolean {
  return /^There's no file at /.test(output) || /^That path is outside/.test(output) || /^.* isn't a text file/.test(output);
}

/** A numbered read (a viewer's: the server won't hand a viewer raw bytes) as the file's text: no header, no line numbers. */
export function unnumbered(output: string): string {
  const m = /^.* \(\d+ lines\)\n/.exec(output);
  return m ? output.slice(m[0].length).replace(/^\d+\t/gm, "") : output;
}

/**
 * Whether a read of a folder failed, as against returning a file.
 *
 * The bridge answers in sentences either way: the file's own text, or why there isn't any. Anything that is about to be shown as a
 * file, and above all anything that could be saved back over one, has to tell the two apart, or a refusal gets written into a file.
 */
export function readFailed(output: string): boolean {
  return (
    isMissing(output) ||
    /^This session has no folder yet\./.test(output) ||
    /machine isn't connected right now\.$/.test(output) ||
    /^This machine is connected in "/.test(output) ||
    output === "Unknown request."
  );
}

/**
 * Cursor's rules, which are standing instructions like the two files above but live in `.cursorrules` or one file each under
 * `.cursor/rules/`. A team on Cursor keeps its conventions there, so an agent that never read them would keep breaking them.
 */
export const CURSOR_RULES_FILE = ".cursorrules";
export const CURSOR_RULES_DIR = ".cursor/rules";
/** Rules past this many are not read: a folder of rules is guidance, and the block has a budget. */
export const CURSOR_RULES_MAX = 12;

/** The files of a folder listing that are Cursor rules, in the order given and no more than can be used. */
export function cursorRuleFiles(listing: string): string[] {
  return listing
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith(`${CURSOR_RULES_DIR}/`) && /\.mdc?$/i.test(l))
    .slice(0, CURSOR_RULES_MAX);
}

/** A Cursor rule as text for an agent: its front matter becomes one line saying when it applies. */
export function cursorRuleText(raw: string): string {
  const m = raw.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/);
  if (!m) return raw.trim();
  const get = (k: string) => m[1]!.match(new RegExp(`^${k}:\\s*(.*)$`, "im"))?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  const globs = get("globs");
  const always = get("alwaysApply") === "true";
  const about = get("description");
  const when = always ? "Always applies." : globs ? `Applies to: ${globs}` : about ? `When relevant: ${about}` : "";
  const body = m[2]!.trim();
  return when && body ? `${when}\n\n${body}` : body;
}

/** The block the agent is given, from whichever of the files exist. Empty when none do. */
export function rulesBlock(files: { path: string; text: string }[]): string {
  const out: string[] = [];
  let budget = RULES_TOTAL_CAP;
  const seen = new Set<string>();
  for (const f of files) {
    const text = f.text.trim();
    // A file that only points at another (`@AGENTS.md`, which Claude Code follows itself) says nothing new here.
    if (/^(@\S+\s*)+$/.test(text)) continue;
    // Two files that say the same thing (one often points at the other) are one instruction, not two.
    if (!text || seen.has(text) || budget <= 0) continue;
    seen.add(text);
    const cut = text.slice(0, Math.min(RULE_FILE_CAP, budget));
    budget -= cut.length;
    out.push(`--- ${f.path} ---\n${cut}${cut.length < text.length ? "\n[…cut]" : ""}`);
  }
  return out.join("\n\n");
}

export const RULES_TEMPLATE = `# Project instructions

Standing rules for anyone working in this repository, people and agents alike.

## How to work here
- Read the code around a change before making it, and match how the codebase already does things.
- Keep changes small and focused. Say what you changed and why.

## Commands
- Install: 
- Run the tests: 
- Typecheck and lint: 

## Don't
- Don't skip, disable or delete a test to make it pass.
- Don't commit secrets or edit generated files by hand.
`;

/** What each file is read by, for the line under its name. */
export const READ_BY: Record<RuleFile, string> = {
  "AGENTS.md": "Friday Code, Codex and Cursor",
  "CLAUDE.md": "Friday Code and Claude Code",
};

/** A CLAUDE.md that hands over to AGENTS.md, so a team keeps one set of rules for both. */
export const CLAUDE_POINTER = "@AGENTS.md\n";

/**
 * What Friday remembers, written into the rules file so it travels with the code.
 *
 * Memory lives on the account and the workspace; a rules file lives in the repository, where every agent and every
 * tool reads it. One press moves the first into the second, under its own heading, without repeating a line that is
 * already there.
 */
export const MEMORY_HEADING = "## How we do things here";
export function withMemoryRules(existing: string, entries: { text: string }[]): string {
  const lines = entries.map((e) => e.text.replace(/\s+/g, " ").trim().replace(/\.$/, "")).filter(Boolean);
  const fresh = lines.filter((l) => !existing.includes(l));
  if (!fresh.length) return existing;
  const bullets = fresh.map((l) => `- ${l}`).join("\n");
  const base = existing.replace(/\s+$/, "");
  if (base.includes(MEMORY_HEADING)) return `${base}\n${bullets}\n`;
  return `${base ? `${base}\n\n` : ""}${MEMORY_HEADING}\n${bullets}\n`;
}
