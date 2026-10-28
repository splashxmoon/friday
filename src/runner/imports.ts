import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { CLI_ID, ENGINE_NAMES, ENGINE_TOOLS, type EngineTool, type ImportedTurn } from "../types.js";
import { ADAPTERS, PROMPT_MARK } from "./adapters.js";
import { acpSessions, acpTranscript } from "./acp-history.js";
import { recentReposCached } from "./workspace.js";

/**
 * Sessions people already have in their own coding CLIs.
 *
 * Every one of these tools keeps its conversations on disk and can resume one
 * by id. So a Friday session can *continue* one instead of starting cold: the
 * runner passes the id to the CLI, which brings its own context and memory
 * with it. Friday reads these files to list them. When a session continues
 * one, the runner also shares its latest messages (see readCliTranscript for
 * how many) with the Friday session, so the other agents in it can work from
 * them; the files themselves stay where they are.
 */

export interface CliSession {
  tool: EngineTool;
  /** What the CLI resumes by. */
  id: string;
  title: string;
  /** Folder the session ran in; resuming has to happen there. */
  cwd: string;
  branch?: string;
  updatedAt: number;
  /** Messages people and the agent said to each other, counted the way readCliTranscript reads them. */
  messages: number;
  /** True when the file was too big to read whole: `messages` then counts only the ends that were read, which says nothing. */
  approx?: boolean;
}

/** A parsed transcript before its folder is settled: a Claude conversation can name several, newest first. */
type Parsed = CliSession & { cwds?: { cwd: string; branch?: string }[] };

export interface CliSessionList {
  sessions: CliSession[];
  /** Why a tool contributed nothing, when that's worth saying. */
  notes: Partial<Record<EngineTool, string>>;
}

const MAX_FILES = 150;
const WHOLE_FILE = 1_500_000;
const HEAD = 400_000;
/** How far the head may grow looking for whole lines. */
const MAX_HEAD = 25_600_000;
const TAIL = 120_000;
/** Reading a long conversation back from its end: the first window, and the last before giving up on reaching further. */
const BACK_FROM = 512_000;
const BACK_MAX = 32_000_000;

type Loaded = { text: string; whole: boolean; /** The file the text came from, when it is not the one listed. */ file?: string; size?: number };

/** Read a transcript, or its ends when it's large: the title is at the start, the timing at the end. */
async function readEnds(file: string, size: number): Promise<Loaded> {
  if (size <= WHOLE_FILE) return { text: await readFile(file, "utf8"), whole: true };
  const fh = await open(file, "r");
  try {
    // The head grows until it actually holds whole lines. A fixed window
    // assumed lines are small, and in a long session they are not: one pasted
    // file or one big tool result is wider than the window, so every line in
    // it came back truncated, nothing parsed, and the session vanished from
    // the list. Which hit the newest sessions hardest, those being the long ones.
    let head = "";
    for (let want = HEAD; want <= MAX_HEAD; want *= 4) {
      const buf = Buffer.alloc(Math.min(want, size));
      await fh.read(buf, 0, buf.length, 0);
      head = buf.toString("utf8");
      if ((head.match(/\n/g)?.length ?? 0) >= 8 || want >= size) break;
    }
    const tail = Buffer.alloc(Math.min(TAIL, size));
    await fh.read(tail, 0, tail.length, Math.max(0, size - tail.length));
    return { text: `${head}\n${tail.toString("utf8")}`, whole: false };
  } finally {
    await fh.close();
  }
}

/** The last `bytes` of a file, from the first whole line in them. */
async function readBack(file: string, size: number, bytes: number): Promise<string> {
  const n = Math.min(bytes, size);
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(n);
    await fh.read(buf, 0, n, size - n);
    const text = buf.toString("utf8");
    return n < size ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await fh.close();
  }
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, any>;
      } catch {
        return null;
      }
    })
    .filter((v): v is Record<string, any> => !!v);

/**
 * Openings that are not what the session is about.
 *
 * A transcript's first user message is very often something the CLI put
 * there: the preamble a worktree session starts with, the summary a
 * compacted session resumes from, the output of a slash command. Taking any
 * of them as the title gives a list where several sessions are called "You
 * are operating in a git worktree. Worktree path: …" and none of them says
 * what it was for.
 */
const BOILERPLATE = [
  /^you are operating in a git worktree/i,
  /^this session is being continued from a previous conversation/i,
  /^caveat: the messages below were generated/i,
  /^<(command-name|command-message|local-command|system-reminder)/i,
  /^analysis:/i,
  // Friday's own wrapping, in case a version of it isn't recognised below: ten sessions all called that tell nobody anything.
  /^you are working inside a friday session/i,
  /^\[friday\]/i,
];

/** A title is one line of what somebody asked for, short enough to read in a list. */
function titleFrom(text: string): string {
  const clean = text
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    // A link is its words: a skill mentioned in Codex is `[$name](path to it)`.
    .replace(/\[([^\]]*)\]\\?\([^)]*\)/g, "$1")
    // Codex's stand-in for a pasted image.
    .replace(/\[external unsupported block: [^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean || BOILERPLATE.some((re) => re.test(clean))) return "";
  // 80, not 120: this is drawn in a menu row, and a title long enough to be
  // cut by the layout is a title that tells you nothing the short one didn't.
  return clean.length > 80 ? `${clean.slice(0, 79).trimEnd()}…` : clean;
}

async function newestFiles(roots: string[], match: (name: string) => boolean, depth = 5, limit = MAX_FILES): Promise<{ file: string; size: number; mtime: number }[]> {
  const out: { file: string; size: number; mtime: number }[] = [];
  const walk = async (dir: string, depth: number) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth > 0) await walk(p, depth - 1);
      } else if (match(e.name)) {
        const s = await stat(p).catch(() => null);
        if (s) out.push({ file: p, size: s.size, mtime: s.mtimeMs });
      }
    }
  };
  for (const r of roots) await walk(r, depth);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

// ── Claude Code (the CLI and the copy inside the Claude app share this) ──

/**
 * Where Claude Code keeps transcripts, one folder per project. The CLI and the
 * copy inside the Claude desktop app write to the same place, so both show up.
 * `env` is off when a caller names its own home (tests), so the machine's real
 * configuration can't leak in.
 */
export const claudeRoots = (home: string, env = true) => [
  path.join(home, ".claude", "projects"),
  ...(env && process.env.CLAUDE_CONFIG_DIR ? [path.join(process.env.CLAUDE_CONFIG_DIR, "projects")] : []),
];

/** How Claude Code names a project folder after the path it ran in (its own rule, cut where it cuts long ones). */
const claudeSlug = (p: string) => p.replace(/[^A-Za-z0-9]/g, "-").slice(0, 200).toLowerCase();

function claudeSession(file: string, text: string, whole: boolean, mtime: number): Parsed | null {
  const recs = lines(text);
  if (!recs.length) return null;
  let id = path.basename(file, ".jsonl");
  /** Every folder it ran in, with the branch it was last on there, oldest first. */
  const seen = new Map<string, string | undefined>();
  let custom = "";
  let written = "";
  let first = "";
  let messages = 0;
  let updatedAt = 0;
  for (const r of recs) {
    if (typeof r.cwd === "string" && r.cwd) {
      // Moved to the end each time, so the order is by last use. The branch is the one it was on the last time it was in that
      // folder: a conversation that made a branch partway through carries on there, not where it began, and continuing it
      // used to move the checkout back to the branch it started on.
      const branch = typeof r.gitBranch === "string" && r.gitBranch && r.gitBranch !== "HEAD" ? r.gitBranch : undefined;
      const before = seen.get(r.cwd);
      seen.delete(r.cwd);
      seen.set(r.cwd, typeof r.gitBranch === "string" ? branch : before);
    }
    // A helper agent's records carry the session's id too; only the conversation's own records say whose it is.
    if (typeof r.sessionId === "string" && r.sessionId && !r.isSidechain) id = r.sessionId;
    // The title somebody set, and the one Claude wrote for them. The field is
    // `customTitle`, which is what this looked for as `title` — so every
    // session anybody had named was listed under its first message instead,
    // and that first message is very often a pasted document or a preamble.
    if (r.type === "custom-title" && typeof r.customTitle === "string" && r.customTitle.trim()) custom = r.customTitle.trim();
    if (r.type === "ai-title" && typeof r.aiTitle === "string" && r.aiTitle.trim()) written = r.aiTitle.trim();
    const turn = turnOf("claude", r);
    if (turn) {
      messages++;
      if (!first && turn.role === "user") first = titleFrom(turn.text);
    }
    const ts = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : 0;
    if (ts > updatedAt) updatedAt = ts;
  }
  const cwds = [...seen].reverse().map(([cwd, branch]) => ({ cwd, ...(branch ? { branch } : {}) }));
  if (!cwds.length) return null;
  return {
    tool: "claude",
    id,
    // What somebody named it, then what Claude named it, then what they
    // first asked for. Each is a better answer to "which session is this"
    // than the one after it.
    title: custom || written || first || "Untitled session",
    cwd: cwds[0]!.cwd,
    ...(cwds[0]!.branch ? { branch: cwds[0]!.branch } : {}),
    updatedAt: updatedAt || mtime,
    messages,
    ...(whole ? {} : { approx: true }),
    cwds,
  };
}

// ── Codex ────────────────────────────────────────────────────────────

export const codexRoots = (home: string, env = true) => [path.join(env && process.env.CODEX_HOME ? process.env.CODEX_HOME : path.join(home, ".codex"), "sessions")];

function codexSession(file: string, text: string, whole: boolean, mtime: number): Parsed | null {
  const recs = lines(text);
  if (!recs.length) return null;
  let id = "";
  let cwd = "";
  let branch: string | undefined;
  let first = "";
  let messages = 0;
  let updatedAt = 0;
  for (const r of recs) {
    const p = (r.payload ?? {}) as Record<string, any>;
    if (r.type === "session_meta" || p.type === "session_meta") {
      // A rollout written by one of Codex's own helper agents opens with its own meta and then repeats its parent's. Only the
      // first is this thread's: taking the last listed the parent under a helper's file, and the room was sent the helper's
      // three messages as the conversation being continued. A helper's thread is not a conversation anybody had, and Codex
      // doesn't list it either.
      if (!id && typeof p.id === "string") {
        if (p.thread_source === "subagent" || p.source?.subagent) return null;
        id = p.id;
        if (typeof p.cwd === "string") cwd = p.cwd;
        // Codex records the repository's branch with the session.
        if (typeof p.git?.branch === "string" && p.git.branch && p.git.branch !== "HEAD") branch = p.git.branch;
      }
    }
    if (typeof r.id === "string" && !id) id = r.id;
    if (typeof r.cwd === "string" && !cwd) cwd = r.cwd;
    const turn = turnOf("codex", r);
    if (turn) {
      messages++;
      if (!first && turn.role === "user") first = titleFrom(turn.text);
    }
    const ts = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : 0;
    if (ts > updatedAt) updatedAt = ts;
  }
  // rollout-2026-09-11T12-00-00-<uuid>.jsonl
  if (!id) id = path.basename(file, ".jsonl").match(/([0-9a-f-]{36})$/i)?.[1] ?? "";
  if (!id || !cwd) return null;
  return { tool: "codex", id, title: first || "Untitled session", cwd, ...(branch ? { branch } : {}), updatedAt: updatedAt || mtime, messages, ...(whole ? {} : { approx: true }) };
}

// ── Cursor ───────────────────────────────────────────────────────────

/** Cursor's CLI has moved its store between versions, so several are tried. */
export const cursorRoots = (home: string, env = true) => [
  path.join(home, ".cursor", "chats"),
  path.join(home, ".cursor", "agent", "sessions"),
  path.join(home, ".cursor-agent", "chats"),
  ...(env && process.env.APPDATA ? [path.join(process.env.APPDATA, "Cursor", "chats")] : []),
];

/**
 * A Cursor chat as a flat list of records.
 *
 * Cursor writes a JSON object per chat or JSONL, depending on version, and a chat's messages may sit inside the object
 * (`messages`, `conversation`, `history`) rather than beside its id. Those are lifted out so the same reading counts and quotes them
 * either way, with the chat's own details kept on the first record.
 */
function cursorRecords(text: string): Record<string, any>[] {
  let recs: Record<string, any>[] = lines(text);
  if (!recs.length) {
    try {
      const one = JSON.parse(text) as Record<string, any>;
      recs = Array.isArray(one) ? one : [one];
    } catch {
      return [];
    }
  }
  const out: Record<string, any>[] = [];
  for (const r of recs) {
    const inside = ["messages", "conversation", "history"].map((k) => r?.[k]).find((v) => Array.isArray(v)) as Record<string, any>[] | undefined;
    if (inside) {
      const { messages: _m, conversation: _c, history: _h, ...meta } = r;
      out.push(meta, ...inside.filter((x) => x && typeof x === "object"));
    } else out.push(r);
  }
  return out;
}

/**
 * A chat in the store today's cursor-agent keeps: `chats/<md5 of the folder>/<chat id>/meta.json`, with the conversation in a
 * SQLite `store.db` beside it and a readable copy under `projects/<folder>/agent-transcripts/<chat id>/`.
 *
 * meta.json holds only the folder and the times, so it is read as a first record carrying the chat's id, followed by the
 * conversation, and the ordinary Cursor reading takes it from there. The folder is kept exactly as written: Cursor finds a chat
 * by the md5 of that string, so `--resume` only works when started in it.
 */
async function cursorLoad(file: string, size: number, home: string): Promise<Loaded> {
  if (path.basename(file) !== "meta.json") return readEnds(file, size);
  const meta = JSON.parse(await readFile(file, "utf8")) as Record<string, any>;
  // A chat that was opened and never said anything has nothing to continue.
  if (meta.hasConversation === false || typeof meta.cwd !== "string") return { text: "", whole: true };
  const id = path.basename(path.dirname(file));
  const head = JSON.stringify({ chatId: id, cwd: meta.cwd, updatedAt: meta.updatedAtMs ?? meta.createdAtMs });
  const t = (await cursorTranscript(home, id, meta.cwd)) ?? (await cursorStore(path.dirname(file)));
  return { ...t, text: `${head}\n${t?.text ?? ""}`, whole: t?.whole ?? true };
}

/** The readable copy, found under the folder's own name first. Only for a chat the CLI has: the editor's chats live here too, and the CLI can't resume those. */
async function cursorTranscript(home: string, id: string, cwd: string): Promise<Loaded | null> {
  const projects = path.join(home, ".cursor", "projects");
  const at = (p: string) => path.join(projects, p, "agent-transcripts", id, `${id}.jsonl`);
  const named = cwd.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  for (const p of [named, ...(await readdir(projects).catch(() => [] as string[])).filter((p) => p !== named)]) {
    const s = await stat(at(p)).catch(() => null);
    if (s?.isFile()) return { ...(await readEnds(at(p), s.size)), file: at(p), size: s.size };
  }
  return null;
}

let sqlite: Promise<any> | undefined;
/** The largest Cursor store read for a chat. A conversation's messages are a small part of one. */
const STORE_MAX = 20 * 1024 * 1024;

/**
 * The conversation out of Cursor's own store, when the readable copy is missing.
 *
 * node:sqlite is in Node 22.13 and later, which the desktop app has; the runner may also be run on an older Node, where this
 * finds nothing and the chat is left out rather than the runner failing to load. Named through a variable so nothing resolves
 * it ahead of time.
 *
 * Read in one go on the runner's only thread, which also carries every lane's connection, so a store past STORE_MAX is left
 * alone, and only the rows that are JSON come out of it: the rest are the store's tree of the conversation, in binary, and the
 * tools' output, which can be most of it.
 */
async function cursorStore(dir: string): Promise<Loaded | null> {
  const file = path.join(dir, "store.db");
  const s = await stat(file).catch(() => null);
  if (!s || s.size > STORE_MAX) return null;
  const name = "node:sqlite";
  sqlite ??= import(name).catch(() => null);
  const sq = await sqlite;
  if (!sq?.DatabaseSync) return null;
  let db: any;
  try {
    db = new sq.DatabaseSync(file, { readOnly: true });
    const out: string[] = [];
    // Starting with "{", whether SQLite holds the row as a blob or as text.
    for (const row of db.prepare("select data from blobs where cast(substr(data, 1, 1) as blob) = X'7B' order by rowid").all() as { data: Uint8Array }[]) {
      try {
        const r = JSON.parse(Buffer.from(row.data).toString("utf8"));
        // The rest are the store's own tree of the conversation, in binary.
        if (r?.role === "user" || r?.role === "assistant") out.push(JSON.stringify({ role: r.role, content: r.content }));
      } catch {
        // not one of the JSON messages
      }
    }
    return { text: out.join("\n"), whole: true };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function cursorSession(file: string, text: string, whole: boolean, mtime: number): Parsed | null {
  const recs = cursorRecords(text);
  if (!recs.length) return null;
  let id = "";
  let cwd = "";
  let title = "";
  let first = "";
  let messages = 0;
  let updatedAt = 0;
  for (const r of recs) {
    for (const k of ["chatId", "sessionId", "id"]) if (!id && typeof r[k] === "string") id = r[k];
    for (const k of ["cwd", "workspacePath", "rootPath", "workspace"]) if (!cwd && typeof r[k] === "string") cwd = r[k];
    if (!title && typeof r.title === "string") title = titleFrom(r.title);
    const turn = turnOf("cursor", r);
    if (turn) {
      messages++;
      if (!first && turn.role === "user") first = titleFrom(turn.text);
    }
    const ts = typeof r.updatedAt === "number" ? r.updatedAt : typeof r.createdAt === "number" ? r.createdAt : typeof r.timestamp === "string" ? Date.parse(r.timestamp) : 0;
    if (ts > updatedAt) updatedAt = ts;
  }
  if (!id) id = path.basename(file).replace(/\.(jsonl?|json)$/i, "");
  if (!id || !cwd) return null;
  return { tool: "cursor", id, title: title || first || "Untitled session", cwd, updatedAt: updatedAt || mtime, messages, ...(whole ? {} : { approx: true }) };
}

// ── GitHub Copilot ───────────────────────────────────────────────────

/** Copilot keeps each conversation in a folder named for it, its events one JSON object a line (`events.jsonl`). */
export const copilotRoots = (home: string, env = true) => [path.join(env && process.env.COPILOT_HOME ? process.env.COPILOT_HOME : path.join(home, ".copilot"), "session-state")];

/**
 * A Copilot conversation from its events (1.0.95): `session.start` says where it ran and on which branch, and the
 * conversation is its `user.message` and `assistant.message` events. The name Copilot gives a conversation is the start of its
 * first message, which for one Friday drove is Friday's own note, so the title is taken from what was asked instead.
 */
function copilotSession(file: string, text: string, whole: boolean, mtime: number): Parsed | null {
  const recs = lines(text);
  let id = path.basename(path.dirname(file));
  let cwd = "";
  let branch: string | undefined;
  let named = "";
  let first = "";
  let messages = 0;
  let updatedAt = 0;
  for (const r of recs) {
    const d = (r.data ?? {}) as Record<string, any>;
    if (r.type === "session.start") {
      if (typeof d.sessionId === "string" && d.sessionId) id = d.sessionId;
      if (typeof d.context?.cwd === "string") cwd = d.context.cwd;
      if (typeof d.context?.branch === "string" && d.context.branch && d.context.branch !== "HEAD") branch = d.context.branch;
    }
    // A name somebody gave it with /rename.
    if (r.type === "session.title_changed" && typeof d.title === "string" && d.title.trim()) named = d.title.trim();
    const turn = turnOf("copilot", r);
    if (turn) {
      messages++;
      if (!first && turn.role === "user") first = titleFrom(turn.text);
    }
    const ts = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : 0;
    if (ts > updatedAt) updatedAt = ts;
  }
  // Opened and never spoken in: nothing to carry on.
  if (!cwd || !messages) return null;
  return { tool: "copilot", id, title: titleFrom(named) || first || "Untitled session", cwd, ...(branch ? { branch } : {}), updatedAt: updatedAt || mtime, messages, ...(whole ? {} : { approx: true }) };
}

// ── all of them ──────────────────────────────────────────────────────

const READERS: Partial<Record<
  EngineTool,
  {
    roots: (home: string, env?: boolean) => string[];
    match: (name: string) => boolean;
    /** How deep under a root conversations are kept. */
    depth: number;
    load: (file: string, size: number, home: string) => Promise<Loaded>;
    parse: (file: string, text: string, whole: boolean, mtime: number) => Parsed | null;
    missing: string;
  }
>> = {
  // Only `<project>/<id>.jsonl`. Claude Code keeps each helper agent's conversation under `<project>/<id>/subagents/`, with the
  // session's own id in every record: read as sessions, they were listed under the session with a helper's title, and continuing
  // the session brought a helper's conversation (often nothing) instead of its own. Older versions kept them beside the session
  // as `agent-*.jsonl`.
  claude: { roots: claudeRoots, match: (n) => n.endsWith(".jsonl") && !n.startsWith("agent-"), depth: 1, load: readEnds, parse: claudeSession, missing: "No Claude Code sessions on this machine yet." },
  codex: { roots: codexRoots, match: (n) => n.endsWith(".jsonl"), depth: 5, load: readEnds, parse: codexSession, missing: "No Codex sessions on this machine yet." },
  cursor: {
    roots: cursorRoots,
    match: (n) => /\.jsonl?$/i.test(n),
    depth: 5,
    load: cursorLoad,
    parse: cursorSession,
    missing: "No Cursor CLI chats on this machine yet. Chats from the Cursor editor can't be continued from here.",
  },
  copilot: { roots: copilotRoots, match: (n) => n === "events.jsonl", depth: 1, load: readEnds, parse: copilotSession, missing: "No GitHub Copilot sessions on this machine yet." },
};

/**
 * The folder a conversation is continued in, or null when none of its folders is still there.
 *
 * For Claude Code, the folder its project is filed under, which is where its own `--resume` looks and what the conversation was
 * about. The last recorded folder is wherever the shell last `cd`-ed into: a subfolder, or a sibling that has since been
 * deleted, which dropped long-running sessions from the list. So the project's own folder is looked for first, among the
 * folders it worked in and their parents, then the newest of them that still exists.
 */
async function where(s: Parsed, file: string): Promise<CliSession | null> {
  const isDir = (p: string) => stat(p).then((x) => x.isDirectory(), () => false);
  const { cwds, ...session } = s;
  if (!cwds) return (await isDir(s.cwd)) ? session : null;
  const want = path.basename(path.dirname(file)).slice(0, 200).toLowerCase();
  const at = (cwd: string, branch?: string): CliSession => {
    const { branch: _, ...rest } = session;
    return { ...rest, cwd, ...(branch ? { branch } : {}) };
  };
  for (const c of cwds) for (let p = c.cwd; ; p = path.dirname(p)) {
    if (claudeSlug(p) === want && (await isDir(p))) return at(p, c.branch);
    if (path.dirname(p) === p) break;
  }
  for (const c of cwds) if (await isDir(c.cwd)) return at(c.cwd, c.branch);
  return null;
}

/**
 * Where Friday asks a person's CLI a question of its own (the agent builder; see ask.ts). Those runs are the CLI's history
 * too, and they filled the list of the person's own sessions.
 */
const askDir = () => realpath(path.join(tmpdir(), "friday-ask")).catch(() => path.join(tmpdir(), "friday-ask"));
const isAsk = async (cwd: string) => path.basename(cwd).toLowerCase() === "friday-ask" && (await realpath(cwd).catch(() => cwd)).toLowerCase() === (await askDir()).toLowerCase();

/**
 * Transcripts already read, by path, size and time: opening the picker again only reads what changed since. The folder checks
 * are made fresh every time.
 */
// ponytail: grows with the newest 150 files per tool and is pruned to them on each listing; a byte budget if transcripts get huge.
const parsed = new Map<string, Parsed | null>();

/**
 * Past sessions from every installed CLI, newest first. Sessions whose folder
 * is gone are dropped: resuming one has to happen where it ran.
 */
export async function listCliSessions(opts: { home?: string; limit?: number; tools?: EngineTool[] } = {}): Promise<CliSessionList> {
  const home = opts.home ?? homedir();
  const tools = opts.tools ?? ENGINE_TOOLS;
  const sessions: CliSession[] = [];
  const notes: Partial<Record<EngineTool, string>> = {};

  for (const tool of tools) {
    const r = READERS[tool];
    if (!r) {
      // A tool spoken to over ACP is asked for its own, when it can say.
      if (ADAPTERS[tool].interactive && !opts.home) {
        const got = await acpSessions(tool, await acpFolders(home));
        if ("why" in got) notes[tool] = got.why;
        const isDir = (p: string) => stat(p).then((x) => x.isDirectory(), () => false);
        for (const s of "why" in got ? [] : got) {
          if (!(await isDir(s.cwd)) || (await isAsk(s.cwd))) continue;
          sessions.push({ tool, id: s.id, title: titleFrom(asked(s.title)) || "Untitled session", cwd: s.cwd, updatedAt: s.updatedAt, messages: 0 });
        }
        if (!("why" in got) && !sessions.some((s) => s.tool === tool)) notes[tool] = `No ${ENGINE_NAMES[tool]} sessions on this machine yet.`;
      } else notes[tool] = `Earlier ${ENGINE_NAMES[tool]} sessions can't be brought in yet.`;
      continue;
    }
    const files = await newestFiles(r.roots(home, !opts.home), r.match, r.depth);
    if (!files.length) {
      notes[tool] = r.missing;
      continue;
    }
    const found: CliSession[] = [];
    const keys = new Set<string>();
    for (const f of files) {
      const key = `${tool}|${f.file}|${f.size}|${f.mtime}`;
      keys.add(key);
      let s = parsed.get(key);
      if (s === undefined) {
        // Kept only when what was read is the file the key describes. A Cursor chat's readable copy is written apart from its
        // meta.json, sometimes seconds after it, and kept by meta.json alone it held on to a count and title it had outgrown.
        let keep = true;
        try {
          const loaded = await r.load(f.file, f.size, home);
          s = loaded.text ? r.parse(f.file, loaded.text, loaded.whole, f.mtime) : null;
          keep = !loaded.file;
        } catch {
          // An unreadable transcript just doesn't appear in the list.
          s = null;
        }
        if (keep) parsed.set(key, s);
      }
      // A long one counts as a conversation whatever its two ends happened to hold.
      if (!s || (!s.messages && !s.approx)) continue;
      // A session whose folder no longer exists can't be resumed.
      const at = await where(s, f.file);
      if (at && !(await isAsk(at.cwd))) found.push(at);
    }
    for (const k of parsed.keys()) if (k.startsWith(`${tool}|`) && !keys.has(k)) parsed.delete(k);
    if (!found.length) notes[tool] = `None of the ${ENGINE_NAMES[tool]} conversations on this machine can be continued from here: they are empty, Friday's own, or in folders that are gone.`;
    sessions.push(...found);
  }

  // One entry per conversation: the newest file wins if a tool wrote several.
  const byId = new Map<string, CliSession>();
  for (const s of sessions.sort((a, b) => b.updatedAt - a.updatedAt)) if (!byId.has(`${s.tool}|${s.id}`)) byId.set(`${s.tool}|${s.id}`, s);
  return { sessions: [...byId.values()].slice(0, opts.limit ?? 60), notes };
}

// ── reading one back ─────────────────────────────────────────────────

/** Turns a `[used Bash]`-style line, and nothing else, into noise worth dropping. */
const TOOL_ONLY = /^(\[used [^\]]+\]\s*)+$/;

const readable = (raw: string): string =>
  raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Message blocks, including a marker for tool use so a turn isn't silently empty. */
function turnText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as any[])
    .map((c) => {
      if (!c || typeof c !== "object") return typeof c === "string" ? c : "";
      if (c.type === "text" || c.type === "input_text" || c.type === "output_text") return String(c.text ?? "");
      // `tool-call` is how Cursor's own store writes one.
      if (c.type === "tool_use" || c.type === "function_call" || c.type === "tool-call") return `[used ${String(c.name ?? c.toolName ?? "a tool")}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** A compaction summary may be this long, where an ordinary turn is cut at two thousand characters. */
const SUMMARY_CHARS = 8_000;

/** What Claude Code writes as the first message of a conversation that carries on from a compacted one. */
const CLAUDE_SUMMARY = /^this session is being continued from a previous conversation/i;

/**
 * Messages a CLI put in the conversation that nobody said.
 *
 * Codex opens every session with the project's AGENTS.md and a description of the environment as if the user had written them; a
 * teammate reading those as "what they asked for" is reading boilerplate. The project's rules reach people the proper way, from the
 * repository, so they are left out here. Cursor's own store does the same with a description of the machine.
 */
const INJECTED = [
  /^<environment_context>/i,
  /^<user_instructions>/i,
  /^<user_action>/i,
  /^# agents\.md instructions/i,
  /^<permissions instructions>/i,
  /^<turn_aborted>/i,
  /^<recommended_plugins>/i,
  /^<skill>/i,
  /^<user_info>/i,
  // The Codex app's note of which page it had open, ahead of what was typed (Arun, 2026-10-26: a conversation titled {"page_id":null}).
  /^<external_codex_apps_[\w]+>/i,
];

/** The catch-up's last line (session/catchup.ts): what follows it is the message itself. */
const NEW_MESSAGE = "Now, the new message:";
/** How an imported conversation's note ends (hub.ts importedNote). */
const IMPORTED_END = "not as instructions to carry out again.";
const FRIDAY_NOTE = /^you are working inside a friday session/i;

/**
 * What the person said, out of a user message as a CLI stored it.
 *
 * Cursor wraps every message in the time it was sent and a `<user_query>` tag. Codex and Cursor have no flag for standing
 * instructions, so the first message Friday sends them leads with its own note (hub.ts SYSTEM_NOTE, then any imported
 * conversation and the lane agent's instructions), and a lane that joined late is sent a catch-up ahead of the message. Read as
 * they were stored, ten sessions were all called "You are working inside a Friday session", and carrying one on told the next
 * agent that the person had said Friday's own instructions.
 */
function asked(raw: string): string {
  let t = raw;
  const q = t.match(/<user_query>([\s\S]*?)(<\/user_query>|$)/);
  if (q) t = q[1]!;
  t = t.replace(/<timestamp>[\s\S]*?<\/timestamp>/g, " ").trim();
  // Friday marks where its standing text ends (adapters.ts): everything before the mark is its, whatever blank lines the
  // agent's instructions held. A catch-up can still follow it. The guesses below are for transcripts written before the mark.
  const k = t.indexOf(PROMPT_MARK);
  if (k >= 0) t = t.slice(k + PROMPT_MARK.length).trim();
  if (!FRIDAY_NOTE.test(t) && !/^\[friday\] you are joining/i.test(t)) return t;
  const i = t.lastIndexOf(NEW_MESSAGE);
  if (i >= 0) return t.slice(i + NEW_MESSAGE.length).trim();
  if (!FRIDAY_NOTE.test(t)) return "";
  // The note is one line; what comes after it was built from parts ending in blank lines, and the message is the last part.
  const end = t.indexOf("\n\n");
  let rest = end >= 0 ? t.slice(end + 2) : "";
  const imported = rest.lastIndexOf(IMPORTED_END);
  if (/^this session continues an earlier conversation/i.test(rest) && imported >= 0) rest = rest.slice(imported + IMPORTED_END.length).trim();
  // An agent's instructions can hold blank lines of their own, so only the last part is safe to take.
  if (/^you are working as the agent/i.test(rest)) rest = rest.slice(rest.lastIndexOf("\n\n") + 2);
  return rest.trim();
}

type RawTurn = ImportedTurn & { summary?: boolean };

/**
 * One record as a turn of the conversation, or null when it is machinery: a tool call or its result, something the CLI put
 * there itself, a helper agent talking to itself.
 *
 * The listing counts with this and readCliTranscript reads with it, so the number somebody is shown is the number of messages
 * that would come with the conversation. They used to differ: every tool result, thinking block and injected environment was
 * counted, and a two-message conversation was listed, and described to the next agent, as forty-nine.
 */
function turnOf(tool: EngineTool, r: Record<string, any>): RawTurn | null {
  let role: unknown;
  let raw: string;
  if (tool === "cursor") {
    role = r.role ?? r.message?.role;
    raw = turnText(r.content ?? r.text ?? r.message?.content);
  } else if (tool === "claude") {
    // `isMeta` is a message the CLI inserted (a command's caveat, a reminder) and `isSidechain` one from a helper agent's own
    // conversation: neither is what the person and the agent said to each other.
    if ((r.type !== "user" && r.type !== "assistant") || r.message?.content === undefined || r.isMeta || r.isSidechain) return null;
    role = r.type;
    raw = turnText(r.message.content);
  } else if (tool === "copilot") {
    if (r.type !== "user.message" && r.type !== "assistant.message") return null;
    role = r.type === "user.message" ? "user" : "assistant";
    raw = turnText(r.data?.content);
  } else if (r.type === "response_item" && r.payload?.type === "message") {
    role = r.payload.role;
    raw = turnText(r.payload.content);
  } else if (r.type === "message" && r.role) {
    // The older rollout shape, with the message at the top level.
    role = r.role;
    raw = turnText(r.content);
  } else return null;
  if (role !== "user" && role !== "assistant") return null;
  if (INJECTED.some((re) => re.test(raw.trimStart()))) return null;
  const text = readable(role === "user" ? asked(raw) : raw);
  if (!text || text.length < 2 || TOOL_ONLY.test(text)) return null;
  return { role, text, ...(tool === "claude" && role === "user" && CLAUDE_SUMMARY.test(text) ? { summary: true } : {}) };
}

/** One CLI's conversation, in order, without the machinery. */
function turnsOf(tool: EngineTool, text: string): RawTurn[] {
  return (tool === "cursor" ? cursorRecords(text) : lines(text)).map((r) => turnOf(tool, r)).filter((t): t is RawTurn => !!t);
}

/**
 * The file a conversation is kept in, found by its id: one directory listing and a few stats, where reading every transcript
 * to see whose it was took a second, and held up the hand-off while it did.
 */
async function byId(tool: EngineTool, id: string, home: string, env: boolean): Promise<{ file: string; size: number; mtime: number }[]> {
  // The id comes from the page, and is about to be part of a path.
  if (!CLI_ID.test(id)) return [];
  const roots = READERS[tool]?.roots(home, env) ?? [];
  if (tool === "codex") return newestFiles(roots, (n) => n.endsWith(`-${id}.jsonl`), 5);
  if (tool === "copilot") {
    const found = await Promise.all(roots.map(async (r) => ({ file: path.join(r, id, "events.jsonl"), s: await stat(path.join(r, id, "events.jsonl")).catch(() => null) })));
    return found.filter((f) => f.s?.isFile()).map((f) => ({ file: f.file, size: f.s!.size, mtime: f.s!.mtimeMs }));
  }
  const out: { file: string; size: number; mtime: number }[] = [];
  for (const root of roots) {
    for (const d of await readdir(root).catch(() => [] as string[])) {
      const file = tool === "claude" ? path.join(root, d, `${id}.jsonl`) : path.join(root, d, id, "meta.json");
      const s = await stat(file).catch(() => null);
      if (s?.isFile()) out.push({ file, size: s.size, mtime: s.mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** The folders a tool spoken to over ACP is asked about for its sessions: the repos in the home folder, and Friday's own copies of them. */
async function acpFolders(home: string): Promise<string[]> {
  const copies = path.join(home, ".friday", "worktrees");
  const [repos, made] = await Promise.all([recentReposCached(home).catch(() => []), readdir(copies).catch(() => [] as string[])]);
  return [...repos.map((r) => r.path), ...made.map((d) => path.join(copies, d))];
}

/** A conversation of a tool with no store Friday reads, as the tool plays it back (see acp-history.ts), cut as readCliTranscript cuts. */
async function acpRead(tool: EngineTool, id: string, maxTurns: number, maxChars: number) {
  const empty = { found: false, title: "", cwd: "", turns: [] as ImportedTurn[], total: 0 };
  const list = await acpSessions(tool, await acpFolders(homedir()));
  const s = "why" in list ? undefined : list.find((x) => x.id === id);
  if (!s) return empty;
  const played = await acpTranscript(tool, id, s.cwd);
  if (!played) return empty;
  const turns = played.map((t) => ({ role: t.role, text: readable(t.role === "user" ? asked(t.text) : t.text) })).filter((t) => t.text.length >= 2);
  const tail: ImportedTurn[] = [];
  let chars = 0;
  for (let i = turns.length - 1; i >= 0 && tail.length < maxTurns; i--) {
    const text = turns[i]!.text.slice(0, 2_000);
    if (tail.length && chars + text.length > maxChars) break;
    chars += text.length;
    tail.unshift({ role: turns[i]!.role, text });
  }
  return { found: true, title: titleFrom(asked(s.title)) || "Untitled session", cwd: s.cwd, turns: tail, total: turns.length };
}

/** Whether the newest of these turns already fill what is carried, cut the way the carrying cuts them. */
function fills(turns: RawTurn[], maxTurns: number, maxChars: number): boolean {
  return turns.length >= maxTurns || turns.reduce((n, t) => n + Math.min(t.text.length, 2_000), 0) >= maxChars;
}

/**
 * What was actually said in a past CLI session.
 *
 * Tool calls and their output are left out. The point isn't to reconstruct the
 * run — the host's own CLI still has all of it, and a teammate's agent would
 * only be confused by tool results it never asked for. What travels is the
 * conversation: what was wanted, and what was reported back.
 */
export async function readCliTranscript(opts: { tool: EngineTool; id: string; home?: string; maxTurns?: number; maxChars?: number }): Promise<{
  found: boolean;
  title: string;
  cwd: string;
  /** The branch the conversation was on when it ended, when its tool recorded one. */
  branch?: string;
  turns: ImportedTurn[];
  /** Messages in the original, which may be more than `turns` carries. When `partial`, only what was read. */
  total: number;
  /** The conversation was too long to read to its start, so how many messages came before these is not known. */
  partial?: boolean;
}> {
  const home = opts.home ?? homedir();
  const maxTurns = opts.maxTurns ?? 60;
  const maxChars = opts.maxChars ?? 24_000;
  const empty = { found: false, title: "", cwd: "", turns: [] as ImportedTurn[], total: 0 };

  const reader = READERS[opts.tool];
  if (!reader) return ADAPTERS[opts.tool].interactive && !opts.home ? acpRead(opts.tool, opts.id, maxTurns, maxChars) : empty;
  const env = !opts.home;
  // By its id first; the slow way only when that finds nothing.
  for (const files of [await byId(opts.tool, opts.id, home, env), null]) {
    for (const f of files ?? (await newestFiles(reader.roots(home, env), reader.match, reader.depth))) {
      const loaded = await reader.load(f.file, f.size, home).catch(() => ({ text: "", whole: true }) as Loaded);
      if (!loaded.text) continue;
      const meta = reader.parse(f.file, loaded.text, loaded.whole, f.mtime);
      if (!meta || meta.id !== opts.id) continue;
      const at = (await where(meta, f.file)) ?? meta;

      // A long conversation is read back from its end, in growing windows, until the newest turns fill what is carried. It used
      // to be read at both ends and the turns joined: its opening request followed by the last few replies, presented as "its
      // last messages", with the request those replies answered nowhere in it.
      let turns: RawTurn[] = [];
      let partial = false;
      if (loaded.whole) turns = turnsOf(opts.tool, loaded.text);
      else {
        const file = loaded.file ?? f.file;
        const size = loaded.size ?? f.size;
        for (let bytes = BACK_FROM; ; bytes *= 4) {
          turns = turnsOf(opts.tool, await readBack(file, size, bytes));
          partial = bytes < size;
          if (!partial || bytes >= BACK_MAX || fills(turns, maxTurns, maxChars)) break;
        }
      }

      // A long session that was compacted carries the best account of everything before the tail: the summary the CLI wrote of
      // it. It is worth more than the older turns that would have fitted, and it is longer than a turn is allowed to be, so it is
      // kept whole (within reason) and first. A compaction is at the start of what it summarised, so for a long file it is looked
      // for in the head that was read to identify it, though no ordinary turn is ever taken from there.
      const summary = [...turns].reverse().find((t) => t.summary) ?? (partial ? turnsOf(opts.tool, loaded.text).reverse().find((t) => t.summary) : undefined);
      const kept = summary ? summary.text.slice(0, SUMMARY_CHARS) : "";
      // The summary's room is taken out first, so the whole stays inside maxChars: what is carried goes on every turn of every
      // other lane, and on Windows it once went on a command line, which has a limit.
      let chars = kept.length;
      let placed = false;
      const tail: ImportedTurn[] = [];
      // The tail is what the next instruction follows on from, and it is what
      // fits: an all-day session would otherwise swamp every later prompt.
      for (let i = turns.length - 1; i >= 0 && tail.length < maxTurns && chars < maxChars; i--) {
        const t = turns[i]!;
        if (t === summary) {
          tail.unshift({ role: t.role, text: kept });
          placed = true;
          continue;
        }
        const text = t.text.slice(0, 2_000);
        // Measured before it is added, or the last turn in took the whole past maxChars.
        if (tail.length && chars + text.length > maxChars) break;
        chars += text.length;
        tail.unshift({ role: t.role, text });
      }
      // In front of the tail, and inside maxTurns: the hub keeps only the last of what it is sent, and a summary sent as one
      // turn too many was the one it dropped.
      if (summary && !placed) {
        if (tail.length >= maxTurns) tail.shift();
        tail.unshift({ role: summary.role, text: kept });
      }
      return {
        found: true,
        title: at.title,
        cwd: at.cwd,
        ...(at.branch ? { branch: at.branch } : {}),
        turns: tail,
        total: partial ? tail.length : turns.length,
        ...(partial ? { partial: true } : {}),
      };
    }
  }
  return empty;
}

/**
 * Whether this machine has that conversation, by its file's name alone: nothing is opened, and nothing is left out for
 * being old.
 *
 * Asked before a hand-off resumes a conversation (Runner.start). Finding it by reading transcripts took two seconds, before
 * the agent could connect, and missed anything past the newest hundred and fifty files, which subagents' transcripts fill
 * in a few days: a conversation that was here went unresumed. Claude Code keeps `<id>.jsonl` in a folder per project and
 * Codex `rollout-<time>-<id>.jsonl` in a folder per day. Cursor's names differ between versions, so it is read for.
 */
export async function hasCliTranscript(tool: EngineTool, id: string, home?: string): Promise<boolean> {
  if (tool === "cursor") return (await readCliTranscript({ tool, id, ...(home ? { home } : {}) })).found;
  // Copilot keeps each session in a folder named for it.
  if (tool === "copilot") return CLI_ID.test(id) && (await byId(tool, id, home ?? homedir(), !home)).length > 0;
  const reader = READERS[tool];
  // Over ACP, whether it has the conversation is found out by loading it; one it hasn't fails, and starts afresh with the history.
  if (!reader && ADAPTERS[tool].interactive) return CLI_ID.test(id);
  if (!reader || !id || /[\\/]/.test(id)) return false;
  const hit = (n: string) => n === `${id}.jsonl` || (tool === "codex" && n.endsWith(`-${id}.jsonl`));
  const seek = async (dir: string, depth: number): Promise<boolean> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    if (entries.some((e) => !e.isDirectory() && hit(e.name))) return true;
    if (depth <= 0) return false;
    return (await Promise.all(entries.filter((e) => e.isDirectory()).map((e) => seek(path.join(dir, e.name), depth - 1)))).some(Boolean);
  };
  // A project's folder holds its conversations directly; a day's is under its year and month.
  return (await Promise.all(reader.roots(home ?? homedir(), !home).map((r) => seek(r, tool === "claude" ? 1 : 4)))).some(Boolean);
}
