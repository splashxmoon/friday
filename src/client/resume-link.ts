import { CLI_ID, ENGINE_NAMES, type EngineTool } from "../types.js";

/**
 * `/?resume=<tool>:<id>&cwd=<path>`: open the new-session page on that folder with that CLI conversation picked to continue,
 * as `/friday:share` in Claude Code links to (integrations/claude-code/link.mjs builds it).
 *
 * Only tools whose conversations Friday both lists and can carry on from a copy of (Claude Code's --fork-session, Codex's
 * thread/fork): the conversation is still open in the terminal that shared it, and two writers on one transcript corrupt it.
 * The id must pass the CLI id rule, since it goes on a command line. The folder is data: it is only ever looked up on the
 * machine (`/api/runner/describe`), never joined to anything here.
 */
export const RESUME_TOOLS = ["claude", "codex"] as const satisfies readonly EngineTool[];
export type ResumeTool = (typeof RESUME_TOOLS)[number];

export interface ResumeLink {
  tool: ResumeTool;
  id: string;
  cwd: string;
}

export function parseResumeLink(search: string | URLSearchParams): ResumeLink | null {
  const p = typeof search === "string" ? new URLSearchParams(search) : search;
  const resume = p.get("resume") ?? "";
  const cwd = (p.get("cwd") ?? "").trim();
  const colon = resume.indexOf(":");
  if (colon < 1 || !cwd || cwd.length > 1000 || /[\0\r\n]/.test(cwd)) return null;
  const tool = resume.slice(0, colon);
  const id = resume.slice(colon + 1);
  if (!(RESUME_TOOLS as readonly string[]).includes(tool) || !CLI_ID.test(id)) return null;
  return { tool: tool as ResumeTool, id, cwd };
}

/** The one line the page says when a link's session can't be picked, naming which and what to do. */
export function resumeProblem(link: ResumeLink, why: "no-machine" | "not-found" | "no-folder", machine = "your machine"): string {
  const tool = ENGINE_NAMES[link.tool];
  if (why === "no-machine") return `Link this computer to Friday to continue that ${tool} session: it is on the machine that shared it.`;
  if (why === "no-folder") return `Couldn't open ${link.cwd} on ${machine}. Is this the machine that shared the ${tool} session?`;
  return `Couldn't find ${tool} session ${link.id.slice(0, 8)}… on ${machine}, so only its folder is picked. Pick it under “Continue a ${tool} session”, or share again from the machine it ran on.`;
}
