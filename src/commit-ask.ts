import type { DiveHost } from "./deep-dive.js";
import { COMMIT_SYSTEM, cleanMessage, commitPrompt, detectStyle, plainWithWhy, sessionWhy, touches, type ChangedFile, type CommitSample, type Why } from "./commit-text.js";
import { dirKey } from "./ask-code.js";
import type { SessionState } from "./session/projection.js";
import type { EngineTool, SessionEvent } from "./types.js";

/**
 * "Write message" in the IDE's Source Control box (Arun, 2026-11-19, wave 3: "Commit messages and PR descriptions written from
 * what the agent did and why, in your repo's style"). The IDE sends what it sees (the staged diff, the files, the last commits);
 * this reads the repo's voice from them, finds the Code chat that made these changes for the why, and asks the person's own
 * coding tool, read-only, for the words. No tool signed in (or none that answers): the files and the ask, set in the same style.
 * It only ever answers with text: the IDE puts it in the box, and a person presses Commit.
 */

export interface CommitAsk {
  root: string;
  diff: string;
  files: ChangedFile[];
  log: CommitSample[];
  staged: boolean;
}

export interface CommitAnswer {
  message: string;
  source: "tool" | "plain";
  /** The tool that wrote it. */
  tool?: string;
  /** The Code chat whose ask and decisions it used. */
  chat?: string;
  /** Why it is the plain one, when a tool was wanted. */
  note?: string;
}

/** The order Deep Dive prefers tools in (ask-code.ts); the one the chat used goes first. */
const ORDER: EngineTool[] = ["claude", "codex", "cursor", "devin", "opencode"];
// askCli kills a child at its limit and says only that it exited with no code, so that counts as the limit too.
const TIMED_OUT = /timed? ?out|timeout|code null|SIGTERM|killed/i;

/** A short job: a minute to answer, then the plain message rather than a wait. */
const ASK_MS = 75_000;
/** All the tools together: the IDE gives up at 120 s, so the plain message is ready well before that. */
const TOTAL_MS = 90_000;

export interface Chats {
  list: () => { sid: string; title: string; folder: string; tool: string; at: number }[];
  state: (sid: string) => Promise<SessionState | null>;
  events: (sid: string) => Promise<SessionEvent[]>;
}

/** The Code chat most recently active in this folder whose changes include some of these files. */
export async function chatFor(chats: Chats, root: string, files: ChangedFile[]): Promise<{ why: Why; title: string; tool: string } | null> {
  // A chat opened on the repo's root, or on a folder inside it (its paths are then read from the root).
  const r = dirKey(root);
  const inside = (f: string) => { const k = dirKey(f); return k === r || k.startsWith(`${r}/`); };
  const here = chats.list().filter((c) => c.folder && inside(c.folder)).sort((a, b) => b.at - a.at).slice(0, 5);
  for (const c of here) {
    const st = await chats.state(c.sid).catch(() => null);
    if (!st) continue;
    const made = Object.values(st.diffs).flatMap((d) => d.files.map((f) => f.path));
    const prefix = dirKey(c.folder).slice(r.length).replace(/^\//, "");
    if (!made.length || !touches(made, files.map((f) => f.path), prefix)) continue;
    const why = sessionWhy(st, await chats.events(c.sid).catch(() => []));
    if (why) return { why, title: c.title || st.title || "", tool: c.tool };
  }
  return null;
}

export async function writeCommitMessage(host: DiveHost, chats: Chats, input: CommitAsk, opts: { totalMs?: number } = {}): Promise<CommitAnswer> {
  const deadline = Date.now() + (opts.totalMs ?? TOTAL_MS);
  const style = detectStyle(input.log);
  const found = await chatFor(chats, input.root, input.files);
  const why = found?.why ?? null;
  const base = { ...(found ? { chat: found.title || "a Code chat" } : {}) };
  const plain = (note?: string): CommitAnswer => ({ message: plainWithWhy(input.files, style, why), source: "plain", ...base, ...(note ? { note } : {}) });
  if (!input.files.length) return { message: "", source: "plain", note: "There is nothing changed to write about." };

  let usable: { tool: EngineTool; name?: string }[] = [];
  try {
    const listed = (await host("tools", {}, 30_000)) as { tools?: { tool: EngineTool; name?: string; path: string | null; loggedIn: boolean | null; unavailable?: string }[] };
    const prefer = (found?.tool || "") as EngineTool;
    const rank = (t: EngineTool) => (t === prefer ? -1 : ORDER.indexOf(t) < 0 ? 99 : ORDER.indexOf(t));
    usable = (listed.tools ?? []).filter((t) => t.path && t.loggedIn !== false && !t.unavailable).sort((a, b) => rank(a.tool) - rank(b.tool));
  } catch {
    return plain("Couldn't reach a coding tool on this computer, so this is a plain summary.");
  }
  if (!usable.length) return plain("No coding tool here is signed in, so this is a plain summary of the changed files.");

  const prompt = commitPrompt({ style, subjects: input.log.map((l) => l.subject), files: input.files, diff: input.diff, why, staged: input.staged });
  for (const t of usable) {
    const left = deadline - Date.now();
    if (left <= 0) return plain("The coding tool took too long, so this is a plain summary of the changed files.");
    const ms = Math.min(ASK_MS, left);
    try {
      // Raced against the deadline too: a tool that never answers must not keep the box waiting.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error("timed out")), left + 1_000); });
      const r = (await Promise.race([host("ask", { tool: t.tool, system: COMMIT_SYSTEM, prompt, timeoutMs: ms }, ms + 15_000), late]).finally(() => clearTimeout(timer))) as { text: string };
      const message = cleanMessage(r.text, style);
      if (message) return { message, source: "tool", tool: t.name ?? t.tool, ...base };
    } catch (e) {
      if (TIMED_OUT.test((e as Error).message)) return plain("The coding tool took too long, so this is a plain summary of the changed files.");
    }
  }
  return plain("The coding tool didn't answer, so this is a plain summary of the changed files.");
}
