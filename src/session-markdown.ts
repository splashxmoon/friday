/**
 * A session as Markdown, to paste into a pull request, an issue or a doc, or keep as a file: who asked what, what each agent
 * answered, the commands it ran and the files it changed, and the questions it put. Tool output stays out (it is most of a log
 * and none of the story); a command that failed says so (Zed, Warp, Windsurf and Factory all copy a thread out like this).
 */
import { MAIN_LANE, type SessionEvent } from "./types.js";

const fence = (s: string) => (s.includes("```") ? "````" : "```");
const when = (ts: number) => new Date(ts).toISOString().replace("T", " ").slice(0, 16) + " UTC";

/** What a tool call did, in a line: the command it ran, the file it wrote, or its name. */
function callLine(name: string, args: string): string {
  let a: Record<string, unknown> = {};
  try {
    a = JSON.parse(args || "{}") as Record<string, unknown>;
  } catch {
    // Arguments that aren't JSON: the name says enough.
  }
  const cmd = a.command ?? a.cmd;
  if (typeof cmd === "string" && cmd) return `ran \`${cmd.replace(/`/g, "'").slice(0, 200)}\``;
  const file = a.path ?? a.file_path ?? a.file;
  if (typeof file === "string" && file) return `${name.replace(/_/g, " ")} \`${file}\``;
  return name.replace(/_/g, " ");
}

export function sessionMarkdown(title: string, events: SessionEvent[], laneName: (lane: string) => string): string {
  const out: string[] = [`# ${title || "Friday session"}`, ""];
  const first = events[0];
  if (first) out.push(`_Exported from Friday · started ${when(first.ts)}_`, "");
  const calls = new Map<string, string>();
  for (const e of events) {
    const b = e.body;
    const lane = e.lane ?? MAIN_LANE;
    if (b.type === "instruction") {
      out.push(`## ${e.actor.name}${lane !== MAIN_LANE ? ` → ${laneName(lane)}` : ""}`, "", b.text.trim(), "");
    } else if (b.type === "chat") {
      out.push(`**${e.actor.name}** (to the people here): ${b.text.trim()}`, "");
    } else if (b.type === "agent.message") {
      const text = b.text.trim();
      if (text) out.push(`### ${laneName(lane)}`, "", text, "");
      const done = b.toolCalls.map((c) => {
        const line = callLine(c.name, c.arguments);
        calls.set(c.id, line);
        return `- ${line}`;
      });
      if (done.length) out.push(...done, "");
    } else if (b.type === "tool.result" && b.isError && calls.has(b.callId)) {
      const tail = b.output.trim().split("\n").slice(-6).join("\n");
      out.push(`- ✗ ${calls.get(b.callId)} failed:`, "", `${fence(tail)}`, tail, `${fence(tail)}`, "");
    } else if (b.type === "agent.question") {
      out.push(`> **${laneName(lane)} asked:** ${b.question.trim()}${b.options?.length ? `\n> ${b.options.map((o) => `· ${o}`).join(" ")}` : ""}`, "");
    } else if (b.type === "folder.committed") {
      out.push(`_Committed ${b.sha.slice(0, 7)} on \`${b.branch}\`: ${b.message.split("\n")[0]}${b.prUrl ? ` · ${b.prUrl}` : ""}_`, "");
    } else if (b.type === "run.ended" && b.outcome === "error" && b.error) {
      out.push(`_${laneName(lane)} stopped: ${b.error}_`, "");
    }
  }
  // One list for the steps of a turn, though each tool call may have come in a message of its own.
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^(- .*)\n\n(?=- )/gm, "$1\n").trim() + "\n";
}

/** A file name for it: the title in plain letters, dated. */
export const markdownFileName = (title: string, ts = Date.now()) =>
  `${(title || "friday-session").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "friday-session"}-${new Date(ts).toISOString().slice(0, 10)}.md`;
