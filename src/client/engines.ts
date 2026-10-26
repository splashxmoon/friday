import { ENGINE_TOOLS, TOOL_INFO, type EngineTool } from "../types.js";

/** The four most people have: shown first while it isn't known yet what a computer has, or when it has none of them. */
export const FIRST_TOOLS: EngineTool[] = ["claude", "codex", "cursor", "copilot"];

/**
 * The tools on this computer, then the rest, which every list folds behind a "more" row: fourteen rows of mostly "not installed"
 * buried the three somebody has. `installed` is null while it isn't known; `keep` is one that stays up top whatever (the one chosen).
 */
export function splitTools(installed: ((t: EngineTool) => boolean) | null, keep?: EngineTool | ""): { here: EngineTool[]; away: EngineTool[] } {
  let here = ENGINE_TOOLS.filter((t) => t === keep || (installed ? installed(t) : FIRST_TOOLS.includes(t)));
  if (!here.length) here = FIRST_TOOLS;
  return { here, away: ENGINE_TOOLS.filter((t) => !here.includes(t)) };
}

/**
 * What a person needs to know about each coding agent before it is on their
 * machine: what it is, and the one line that puts it there.
 *
 * These are the vendors' own install commands. Friday never installs anything
 * on somebody's computer itself — it shows the line, and the person runs it.
 */
export type Os = "windows" | "mac" | "linux";

/** The computer this window is on: the desktop app says so, a browser says it in its user agent. */
export function osOf(platform?: string, ua = typeof navigator !== "undefined" ? navigator.userAgent : ""): Os {
  const p = platform ?? "";
  if (p === "win32" || /Windows/i.test(ua)) return "windows";
  if (p === "darwin" || /Mac OS X|Macintosh/i.test(ua)) return "mac";
  return "linux";
}

export interface InstallStep {
  /** Where to paste it: the name of the shell on that system. */
  shell: string;
  command: string;
  /** What has to be there already. */
  needs?: string;
}

/**
 * The line that installs a tool, for the system it will be run on (see ToolInfo.install): an npm package is the same line
 * everywhere and wants Node.js; the others have a PowerShell line for Windows and a shell one for macOS and Linux.
 */
export function installStep(tool: EngineTool, os: Os): InstallStep {
  const shell = os === "windows" ? "PowerShell" : os === "mac" ? "Terminal" : "Shell";
  const i = TOOL_INFO[tool].install;
  if (i.npm) return { shell, command: `npm install -g ${i.npm}`, needs: "Needs Node.js (nodejs.org)" };
  return { shell, command: (os === "windows" ? i.windows : i.unix) ?? i.unix ?? i.windows ?? "" };
}

/** What each tool is and where its docs are, with the line that installs it on macOS and Linux. */
export const ENGINE_INFO = Object.fromEntries(
  (Object.keys(TOOL_INFO) as EngineTool[]).map((t) => [t, { blurb: TOOL_INFO[t].blurb, install: installStep(t, "linux").command, docs: TOOL_INFO[t].docs }]),
) as Record<EngineTool, { blurb: string; install: string; docs: string }>;
