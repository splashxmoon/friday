/**
 * The terminal helper's words (Arun, 2026-11-20, wave 4: "Terminal helper: type what you want in plain words in the terminal and
 * get the command; a command that fails gets explained and fixed."). Three small jobs, all plain text in and out so they can be
 * tested without a model:
 *
 *   termPrompt        what the person's coding tool is asked: the request (or the failed command and its output), the shell,
 *                     the system, the folder and the last few commands
 *   parseCommand      the tool's answer read as one command and one line of why (fences, prompts and labels stripped)
 *   parseExplain      the answer to a failed command: why it failed, and the command that fixes it, if one does
 *   dangerOf          what is risky in a command (deletes for good, rewrites history, runs a download, runs as admin...)
 *
 * It only reads what it is given. Nothing here runs a command or calls a model.
 */

export interface RecentCommand {
  cmd: string;
  /** Its exit code, when the terminal said (shell integration). */
  exit?: number;
}

export interface TermContext {
  /** The shell's name: zsh, bash, fish, pwsh, cmd. */
  shell: string;
  /** The system, as a person says it: macOS, Windows, Linux. */
  os: string;
  /** The folder the terminal is in. */
  cwd: string;
  /** The last few commands, oldest first. */
  recent: RecentCommand[];
}

export const TERM_SYSTEM =
  "You are a command-line helper inside a developer's terminal. You answer in the exact shape you are asked for, with no preamble, no code fences and no markdown. You change nothing: never run commands or edit files, and read a file only when the answer truly depends on it.";

const MAX_REQUEST = 1000;
const MAX_OUTPUT = 5000;
const MAX_CMD = 600;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** How a shell's name is said in the prompt, with what it needs to be told about the dialect. */
function shellNote(shell: string): string {
  const s = shell.toLowerCase();
  if (/^(pwsh|powershell)/.test(s)) return `${shell} (PowerShell: use its cmdlets, not Unix tools)`;
  if (s === "cmd") return "cmd.exe (Windows Command Prompt: use its commands, not Unix tools)";
  return shell || "a Unix shell";
}

function context(c: TermContext): string {
  const lines = [`Shell: ${shellNote(c.shell)}`, `System: ${c.os || "unknown"}`, `Folder: ${c.cwd || "unknown"}`];
  const recent = c.recent.filter((r) => r.cmd.trim()).slice(-6);
  if (recent.length) lines.push(`The last commands typed here, oldest first:\n${recent.map((r) => `- ${cut(r.cmd.trim(), 200)}${r.exit ? ` (failed, exit ${r.exit})` : ""}`).join("\n")}`);
  return lines.join("\n");
}

/** "Friday: Write a command": the request in plain words, to be answered with one command and one line about it. */
export function writePrompt(request: string, c: TermContext): string {
  return [
    "Write one shell command for this request.",
    `Request: ${cut(request.trim(), MAX_REQUEST)}`,
    context(c),
    "Reply in exactly two lines. Line 1: the command itself, as it is typed at the prompt (no $ or > prompt, no backticks, no code fence), written for the shell and system above. Line 2: one short sentence in plain words saying what it does. If it takes more than one step, chain them with && (or ; in PowerShell) on line 1. If you cannot tell what is wanted, make line 1 just NONE and say what you need to know on line 2.",
  ].join("\n\n");
}

/** A command that failed: why, in plain words, and the one command that fixes it when there is one. */
export function explainPrompt(failed: { cmd: string; output: string; exit?: number }, c: TermContext): string {
  const out = failed.output.trim();
  return [
    "A command failed in the terminal. Say why, and give the command that fixes it.",
    `The command: ${cut(failed.cmd.trim(), MAX_CMD)}${failed.exit ? `\nIt exited with code ${failed.exit}.` : ""}`,
    out ? `What it printed (the end of it):\n${out.slice(-MAX_OUTPUT)}` : "It printed nothing.",
    context(c),
    "Reply in exactly two lines. Line 1: WHY: and then the reason in one or two short plain sentences. Line 2: FIX: and then the one command that fixes it, as typed at the prompt (no $ prompt, no backticks, no code fence), written for the shell and system above; or FIX: none when no single command fixes it (then say in WHY what to change by hand).",
  ].join("\n\n");
}

// A prompt a shell prints, left on the front of a line the tool copied from a terminal. A cmd.exe prompt is only taken when its
// path has no spaces and a command follows the `>` (C:\Users\me>dir or C:\proj> dir), so `C:\Python312\python.exe x.py > out.txt` and a
// bare `> file` (truncate it) are commands, not prompts.
const PROMPT = /^(?:PS [^>\n]*>\s*|[A-Za-z]:\\[^>\s]*>\s*(?=\S)|[\w.-]+@[\w.-]+[: ][^$#%\n]*[$#%]\s+|[$%#]\s+)/;
// A label only counts with its colon: `command -v git` and `fix-perms --all` are commands, `Command: ls` is a label.
const LABEL = /^\**\s*(command|cmd|answer|fix|why|explanation|explain|reason|line [12])\s*\**\s*:\s*\**\s*/i;
const CMD_LABEL = /^\**\s*(command|cmd|fix|answer)\s*\**\s*:\s*\**\s*/i;

/** A tool's reply as plain lines: fences, quotes around the whole reply and blank lines gone; backslash-continued lines joined. */
function linesOf(text: string): string[] {
  const raw = String(text ?? "").replace(/\r/g, "").split("\n").map((l) => l.trim());
  const joined: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    let l = raw[i]!;
    // `docker run \` goes on to the next line; a path ending in a backslash does not (no space before it). In PowerShell a lone
    // backtick at the end does the same (an even count is a `command` in backticks).
    while ((/\s\\$/.test(l) || (/`$/.test(l) && !/^`{3}/.test(l) && (l.match(/`/g) ?? []).length % 2 === 1)) && i + 1 < raw.length && raw[i + 1]) {
      l = `${l.slice(0, -1).trimEnd()} ${raw[++i]}`;
    }
    joined.push(l);
  }
  return joined.filter((l) => l && !/^```/.test(l) && !/^~~~/.test(l));
}

/** A command line without its prompt, label, backticks or quotes. */
export function cleanCommand(line: string): string {
  let s = line.trim();
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(CMD_LABEL, "").replace(PROMPT, "").trim();
    if (s === before) break;
  }
  // `cmd` or "cmd" around the whole line.
  const wrapped = /^(`+)([^`]+)\1$/.exec(s) ?? /^"([^"]*)"$/.exec(s);
  if (wrapped) s = (wrapped[2] ?? wrapped[1] ?? "").trim();
  return s.replace(/\s+$/, "");
}

/** One line that reads as a sentence to a person ("I can't tell what you mean without more detail."), not as a command. */
function isSentence(l: string): boolean {
  const words = l.split(/\s+/);
  return /^[A-Z]/.test(l) && /[.?!]$/.test(l) && words.length >= 4 && !words.some((w) => w.startsWith("-")) && !/[|&;<>$(){}[\]=\\"`*]/.test(l);
}

const NONE = /^(none|n\/a|no command|nothing)\.?$/i;

/** The answer to "write a command": { command, explain }. The command is empty when the tool could not tell what was wanted. */
export function parseCommand(text: string): { command: string; explain: string } {
  const lines = linesOf(text);
  const whole = String(text ?? "").replace(/\r/g, "");
  // A reply in a fence keeps the command as the first line of the fence, whatever words come before it.
  const fenced = /```[\w-]*\n([\s\S]*?)```/.exec(whole);
  const fromFence = fenced ? linesOf(fenced[1] ?? "")[0] : undefined;
  const labelled = lines.find((l) => /^\**\s*(command|cmd)\s*\**\s*:/i.test(l));
  const first = labelled ?? fromFence ?? lines[0] ?? "";
  // The tool answered in words and no command (no NONE either): it is its question or its reason, not something to type.
  if (!labelled && !fromFence && lines.length === 1 && isSentence(first)) return { command: "", explain: first };
  const command = cleanCommand(first);
  // With a fence, the line after it says what it does; the words before it are a lead-in.
  const after = fenced ? linesOf(whole.slice((fenced.index ?? 0) + fenced[0].length)) : [];
  const rest = fenced ? after : lines.filter((l) => l !== first && l !== fromFence);
  const why = lines.find((l) => /^\**\s*(explanation|explain|why|reason)\s*\**\s*:/i.test(l)) ?? rest[0] ?? "";
  const explain = why.replace(LABEL, "").replace(/^[-*•]\s+/, "").replace(/\*\*/g, "").trim();
  if (NONE.test(command)) return { command: "", explain };
  return { command, explain };
}

/** The answer to "a command failed": { why, fix }. fix is empty when no single command fixes it. */
export function parseExplain(text: string): { why: string; fix: string } {
  const lines = linesOf(text);
  const fixLine = lines.find((l) => /^\**\s*fix\s*\**\s*:/i.test(l));
  const whyLine = lines.find((l) => /^\**\s*why\s*\**\s*:/i.test(l));
  const fix = fixLine ? cleanCommand(fixLine) : "";
  const whyLines = whyLine ? [whyLine, ...lines.slice(lines.indexOf(whyLine) + 1).filter((l) => l !== fixLine && !/^\**\s*fix\s*\**\s*:/i.test(l))] : lines.filter((l) => l !== fixLine);
  const why = whyLines.map((l) => l.replace(LABEL, "").replace(/\*\*/g, "")).join(" ").replace(/\s+/g, " ").trim();
  return { why, fix: NONE.test(fix) ? "" : fix };
}

// What makes a command worth a second look: the pattern, and what to say about it. A word, not a promise: it matches the
// command as typed, so `rm -rf` inside a script it calls is not seen.
const DANGERS: [RegExp, string][] = [
  // rm as a word anywhere a command can stand: after find -exec, in a for loop, as /bin/rm, \rm, "command rm", "time rm"; not npm rm / git rm.
  [/(?<![\w.-])(?<!\b(?:npm|yarn|pnpm|git|brew|pip|apt|cargo)\s+)\\?rm\s+(?:[^;&|]*\s)?(?:-[a-z]*r[a-z]*|--recursive)\b/i, "it deletes folders and everything in them, for good"],
  [/(?<![\w.-])(?<!\b(?:npm|yarn|pnpm|git|brew|pip|apt|cargo)\s+)\\?rm\s+(?:[^;&|]*\s)?[^\s;&|]*[*][^\s;&|]*/i, "it deletes every file that matches, for good"],
  [/\bfind\b[^;&|]*\s-delete\b|\b(?:-exec|xargs)\s+(?:-\S+\s+)*(?:sudo\s+)?(?:\S*\/)?rm\b/i, "it deletes every file it finds, for good"],
  [/\b(remove-item|ri|del|erase|rd|rmdir)\b[^;&|]*(-recurse|\s\/s\b)/i, "it deletes folders and everything in them, for good"],
  [/\b(remove-item|ri|del|erase)\b[^;&|]*\s-force\b/i, "it deletes files for good, read-only ones too"],
  [/\bgit\s+push\b[^;&|]*(\s--force(?!-with-lease)\b|\s-[a-z]*f[a-z]*\b|\s\+\S)/i, "it overwrites what others may have pushed"],
  [/\bgit\s+push\b[^;&|]*--force-with-lease/i, "it rewrites the remote branch"],
  [/\bgit\s+reset\s+[^;&|]*--hard/i, "it throws away changes you have not committed"],
  [/\bgit\s+clean\b[^;&|]*\s-[a-z]*f/i, "it deletes files git does not track, for good"],
  [/\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/i, "it throws away the changes in every file here"],
  [/\bgit\s+checkout\b[^;&|]*\s(?:-f|--force)\b/i, "it throws away changes you have not committed"],
  [/\bgit\s+stash\s+(clear|drop)\b/i, "it deletes saved stashes for good"],
  [/\brsync\b[^;&|]*\s--delete/i, "it deletes files at the destination that are not at the source"],
  [/\bgit\s+branch\s+[^;&|]*-D\b/, "it deletes a branch even if it is not merged"],
  [/\bdrop\s+(table|database|schema|index|view|user)\b/i, "it deletes data from a database, for good"],
  [/\btruncate\s+(table\s+)?\w/i, "it empties a table, for good"],
  [/\bdelete\s+from\s+\w+(?![^;]*\bwhere\b)/i, "it deletes every row, there is no WHERE"],
  [/\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^;&]*\|\s*(sudo\s+)?(?:\S*\/)?(sh|bash|zsh|fish|python3?|node|iex|invoke-expression)\b/i, "it runs a script it downloads without you reading it"],
  [/\b(?:sh|bash|zsh|fish|python3?|node|perl|ruby|source|eval)\b[^;&|\n]*(?:\$\(|<\(|`)\s*(?:curl|wget)\b|(?:^|\s)\.\s+<\(\s*(?:curl|wget)\b/i, "it runs a script it downloads without you reading it"],
  [/\b(iex|invoke-expression)\b[^;&]*\b(curl|wget|iwr|irm|invoke-webrequest|downloadstring)\b/i, "it runs a script it downloads without you reading it"],
  [/(^|[;&|(]\s*|\b(?:time|command|env|exec|nohup|then|do|xargs|-exec)\s+)(?:\S*\/)?sudo\s+\S/i, "it runs as the administrator"],
  [/\b(runas|start-process\b[^;&|]*-verb\s+runas)\b/i, "it runs as the administrator"],
  [/\bdd\s+[^;&|]*\bof=\/dev\//i, "it writes straight to a disk"],
  [/\bmkfs(\.\w+)?\b|(^|[;&|(]\s*)format\s+[a-z]:/i, "it erases a whole disk"],
  [/>\s*\/dev\/(sd|nvme|disk)\w*/i, "it writes straight to a disk"],
  [/\bchmod\s+(-[a-z]*R[a-z]*\s+)?[0-7]*777\b/i, "it lets everybody change these files"],
  [/\b(chmod|chown)\s+(-[a-z]*R[a-z]*)\s/i, "it changes the owner or rights of a whole folder tree"],
  [/:\(\)\s*\{\s*:\s*\|\s*:/, "it is a fork bomb that freezes the computer"],
  [/\b(docker|podman)\s+system\s+prune\b[^;&|]*(-a|--all|--volumes)/i, "it deletes every unused image and volume"],
  [/\b(shutdown|reboot|halt|poweroff)\b/i, "it turns the computer off or restarts it"],
];

/** What is risky in a command, as short phrases (none when nothing is), most serious first. */
export function dangersOf(cmd: string): string[] {
  const out: string[] = [];
  for (const [re, why] of DANGERS) if (re.test(cmd) && !out.includes(why)) out.push(why);
  return out;
}

/** The warning line for a command, or "" when nothing is risky: "Careful: it deletes folders for good, and it runs as the administrator." */
export function dangerOf(cmd: string): string {
  const d = dangersOf(cmd);
  if (!d.length) return "";
  return `Careful: ${d.length === 1 ? d[0] : `${d.slice(0, -1).join(", ")} and ${d[d.length - 1]}`}.`;
}
