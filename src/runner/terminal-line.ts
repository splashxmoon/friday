/**
 * A lane's own conversation, carried on in the person's terminal (Arun, 2026-10-30: "add a CLI view too to the coding
 * sessions… utilize the users terminal and have their claude code, codex or whatever already there… kinda like herdr").
 *
 * The page opens a shell in the lane's folder and types this line into it: the same program, the same account and the same
 * conversation the lane's turns run, now in the tool's own screen. Typed rather than started directly, so what runs is there
 * to read, and closing the tool leaves the person at a prompt in that folder, not a dead pane.
 */

/** Tools whose own screen can pick up a conversation by its id, and how. */
export const TERMINAL_TOOLS = {
  claude: { resume: (id: string) => ["--resume", id], fresh: (id: string) => ["--session-id", id] },
  codex: { resume: (id: string) => ["resume", id], fresh: null },
} as const;

export type TerminalTool = keyof typeof TERMINAL_TOOLS;
export const isTerminalTool = (tool: string | undefined): tool is TerminalTool => !!tool && Object.hasOwn(TERMINAL_TOOLS, tool);

/** A conversation id as the tools make them: never anything a shell would read as more than one word. */
const ID = /^[\w-]{1,100}$/;

/** One word to a POSIX shell, quoted only when it has to be. */
const posix = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
/** One word to PowerShell: single-quoted, its quotes doubled. */
const pwsh = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * The line to type: variables first (the account the lane runs as), then the program and its arguments. PowerShell on
 * Windows, which sets variables apart and runs a quoted path with `&`; a POSIX shell anywhere else.
 */
export function shellLine(env: Record<string, string>, argv: string[], platform: NodeJS.Platform = process.platform): string {
  const names = Object.keys(env).filter((k) => /^[A-Za-z_]\w*$/.test(k));
  if (platform === "win32") {
    const sets = names.map((k) => `$env:${k}=${pwsh(env[k]!)}; `).join("");
    return `${sets}& ${argv.map(pwsh).join(" ")}`;
  }
  const sets = names.map((k) => `${k}=${posix(env[k]!)} `).join("");
  return `${sets}${argv.map(posix).join(" ")}`;
}

/**
 * What to run for `tool` to carry on conversation `id`, or to start one with that id where the tool lets its id be chosen
 * (Claude Code), so the lane carries on from it after. Null when neither can be done: a tool with no screen of its own to
 * resume in, or Codex before its first turn here, whose ids it makes itself.
 */
export function terminalArgs(tool: string | undefined, id: string | null, mint: () => string): { args: string[]; minted: string | null } | null {
  if (!isTerminalTool(tool)) return null;
  const how = TERMINAL_TOOLS[tool];
  if (id && ID.test(id)) return { args: how.resume(id), minted: null };
  if (!how.fresh) return null;
  const made = mint();
  return { args: how.fresh(made), minted: made };
}
