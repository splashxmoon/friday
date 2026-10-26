import { MAIN_LANE, type SessionEvent } from "./types.js";
import type { Thread } from "./session/projection.js";

/**
 * A remark on a line, handed to an agent as work.
 *
 * Review comments are only worth leaving if something comes of them. Sending one to an agent turns it into an instruction that
 * carries the file, the line, the code that was there and the conversation under it, and records that it is with that agent.
 * When that agent's run ends having changed the file, the comment is closed by it, as a fact in the log that anybody can undo.
 */

/** The same file, whether one side says it from the folder's root and the other from a level below. */
const samePath = (a: string, b: string) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One note, as the message that carries several lists it: the place, the code, the words. */
export interface NoteLike {
  path: string;
  line: number;
  endLine?: number | undefined;
  removed: boolean;
  code: string;
  text: string;
}

/**
 * Several notes on a change, as one instruction: the agent is best at acting on them together, since it can see that two
 * notes are the same problem and make one pass over the files. Each says exactly where it points, the file, the line or
 * lines, and the code itself, so the agent never guesses which of three similar lines was meant.
 */
export function notesPrompt(notes: NoteLike[]): string {
  const sorted = [...notes].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  const items = sorted.map((c) => {
    const range = !!c.endLine && c.endLine > c.line;
    const where = `${c.path}:${c.line}${range ? `–${c.endLine}` : ""}${c.removed ? (range ? " (lines that were removed)" : " (a line that was removed)") : ""}`;
    const snippet = c.code.trim();
    // A block of lines goes on lines of its own, fenced; a single line sits inline.
    const code = !snippet ? "" : snippet.includes("\n") ? `\n  \`\`\`\n  ${snippet.slice(0, 1600).replace(/```/g, "'''").replace(/\n/g, "\n  ")}\n  \`\`\`` : ` — \`${snippet.slice(0, 160).replace(/`/g, "'")}\``;
    return `- ${where}${code}\n  ${c.text.trim().replace(/\n+/g, "\n  ")}`;
  });
  return `Review of your changes — address each of these, then say what you changed:\n\n${items.join("\n")}`;
}

/** What the agent is told: the place, what was there, and what people said about it. */
export function threadPrompt(t: Pick<Thread, "path" | "line" | "code" | "removed" | "text" | "by" | "replies"> & { ask?: boolean; endLine?: number }): string {
  const range = !!t.endLine && t.endLine > t.line;
  const at = range ? `${t.line}–${t.endLine}` : String(t.line);
  const where = t.removed ? `the line${range ? "s" : ""} that ${range ? "were" : "was"} removed at ${t.path}:${at}` : `${t.path}:${at}`;
  const lines = [`${t.by.name} ${t.ask ? "asked a question about" : "left a review comment on"} ${where}.`, "", t.code ? `The code there:\n\`\`\`\n${clip(t.code, range ? 1600 : 400)}\n\`\`\`` : "", `Their ${t.ask ? "question" : "comment"}: “${clip(t.text, 1500)}”`];
  if (t.replies.length) lines.push("", "The conversation since:", ...t.replies.slice(-8).map((r) => `- ${r.by.name}: ${clip(r.text, 500)}`));
  // A question wants an answer about the code as it is; a comment wants the code changed.
  if (t.ask) lines.push("", "Answer the question in a few plain sentences about this code: what it does, why it is this way, and anything they should know. Change nothing unless they asked you to.");
  else lines.push("", "Address it with the smallest change that does, and say in a sentence what you changed. If you think the comment is mistaken, say why instead of changing anything.");
  return lines.filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
}

/**
 * Threads that an agent has answered with a change.
 *
 * A thread was sent to a lane; the lane's run has now ended; and a file edit on the thread's path landed after it was sent.
 * Only then. A run that ended without touching the file has not answered the comment, and a thread sent to one agent is not
 * closed by another's work.
 */
export function threadsToSettle(events: SessionEvent[], threads: Thread[], lane: string): string[] {
  const open = threads.filter((t) => !t.resolved && t.sent?.lane === lane);
  if (!open.length) return [];
  // Where that lane's latest run ended: what happened after it was already counted by the run that began then.
  const ended = events.findLast((e) => (e.lane ?? MAIN_LANE) === lane && e.body.type === "run.ended" && e.body.outcome === "done");
  if (!ended) return [];
  // What the lane changed while it worked: files its edit tools wrote, files a machine reported edited, and files in a diff.
  const results = new Map<string, boolean>();
  for (const e of events) if (e.body.type === "tool.result") results.set(e.body.callId, !e.body.isError);
  const touched = (t: Thread, e: SessionEvent): boolean => {
    if (e.seq <= t.sent!.seq || e.seq > ended.seq || (e.lane ?? MAIN_LANE) !== lane) return false;
    const b = e.body;
    if (b.type === "folder.edited") return samePath(b.path, t.path);
    if (b.type === "agent.diff") return b.files.some((f) => samePath(f.path, t.path));
    if (b.type === "agent.message")
      return b.toolCalls.some((c) => {
        if (!WRITES.has(c.name) || results.get(c.id) !== true) return false;
        try {
          const p = (JSON.parse(c.arguments || "{}") as { path?: unknown }).path;
          return typeof p === "string" && samePath(p, t.path);
        } catch {
          return false;
        }
      });
    return false;
  };
  return open.filter((t) => events.some((e) => touched(t, e))).map((t) => t.id);
}

/** Friday's own editing tools, and the names the coding tools' runner gives theirs. */
const WRITES = new Set(["edit_file", "write_file", "edit", "write"]);
