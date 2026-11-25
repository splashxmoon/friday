/**
 * What Friday on this computer keeps of what went wrong, and what a person can send when something breaks (spec 13, "What can
 * break" 9; Arun, 2026-11-24: "Go all out and fix these problems").
 *
 * The open-source desktop app runs its server, runner and store inside Electron's main process, where nothing was written down:
 * an error there showed Electron's own dialog with a stack, or nothing, and there was no file to send. So:
 *
 * - A log of its own at `<FRIDAY_HOME>/diagnostics/friday.log`, kept to three files of 5 MB. Not in `logs/`, which holds each
 *   session's history (local/kv.ts reads every `logs/<hash>.jsonl` there). Written behind the app, never in its way: a write
 *   that fails is dropped, never thrown into the code that logged it.
 * - The process's console.error and console.warn copied into it with the time, and its uncaught errors and unhandled rejections
 *   logged and carried on from, as the server and the runner do (server.ts, runner/cli.ts), instead of Electron's stack dialog.
 * - Copy diagnostics (Settings › Updates, the crash page): which Friday on which system, how it is doing, the last of the log
 *   and the recent errors, as text to paste into an issue. Redacted first: the home folder is `~`, and anything shaped like a
 *   token, key or secret is taken out. No file contents are ever in it.
 */
import { appendFile, mkdir, open, readFile, rename, stat, statfs, unlink } from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { format } from "node:util";
import { osName } from "./feedback.js";
import { ops } from "./ops.js";

/** Where Friday keeps its data when nothing says otherwise: start.ts's own default. */
export const defaultHome = (): string => path.resolve(process.env.FRIDAY_HOME || path.join(os.homedir(), ".friday"));
export const logDir = (home: string): string => path.join(home, "diagnostics");
export const logPath = (home: string): string => path.join(logDir(home), "friday.log");

// ── Redaction ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const GONE = "[redacted]";
/**
 * Shapes a secret has. Each is taken out whole, wherever it is in a line: a key pasted into a prompt that reached an error, a
 * socket's address with its invite in it, a stack that printed a request's headers.
 */
const SECRETS: [RegExp, string][] = [
  [/\b(Bearer)\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${GONE}`],
  // Basic's base64 has a digit or its padding somewhere, which "Basic authentication" doesn't.
  [/\b(Basic)\s+(?=[A-Za-z0-9+/]*[0-9=])[A-Za-z0-9+/]{8,}={0,2}/g, `$1 ${GONE}`],
  // A name that says what follows is secret, in a URL's query, JSON or an environment line: the name kept, its value gone.
  [/([?&](?:token|access_token|refresh_token|key|api_key|apikey|secret|password|auth|invite|actor|sig|signature|code)=)[^&\s"'<>]+/gi, `$1${GONE}`],
  [/((?:"|\b)(?:\w*?_)?(?:token|access_token|refresh_token|api[_-]?key|secret|client_secret|password|passwd|authorization|cookie)"?\s*[:=]\s*"?)(?!\[redacted\])[^"\s,;&}]{4,}/gi, `$1${GONE}`],
  // Known kinds of key, by their prefixes: OpenAI and Anthropic, GitHub, Slack, npm, AWS, Google, payment providers.
  [/\bsk-[A-Za-z0-9_-]{12,}/g, GONE],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g, GONE],
  [/\bxox[abposre]-[A-Za-z0-9-]{8,}/g, GONE],
  [/\bxapp-[A-Za-z0-9-]{8,}/g, GONE],
  [/\bnpm_[A-Za-z0-9]{20,}/g, GONE],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, GONE],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, GONE],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, GONE],
  // A signed web token: three pieces, the first always "eyJ".
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, GONE],
  // A private key block, whole.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, GONE],
  // Anything long and random: 32 or more hex digits (a GitHub token of old, a signing key; a commit's id goes too, which costs
  // nothing here), base64 that ends in its padding, and 32 or more letters and digits that mix upper, lower and digits, which a
  // word, a name or a path in this log never does.
  [/\b[0-9a-fA-F]{32,}\b/g, GONE],
  [/[A-Za-z0-9+/]{40,}={1,2}/g, GONE],
  [/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g, GONE],
];

/** Text with everything shaped like a secret taken out (the log is written this way too). */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, to] of SECRETS) out = out.replace(re, to);
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Text fit to send: this person's home folder said as `~` (in every way a path can spell it, and anyone's home the same way),
 * then every secret taken out.
 */
export function redact(text: string, home: string = os.homedir()): string {
  let out = text;
  const homes = new Set([home, home.replace(/\\/g, "/"), home.replace(/\//g, "\\")].filter((h) => h.length > 1));
  for (const h of [...homes].sort((a, b) => b.length - a.length)) out = out.replace(new RegExp(`${escape(h)}(?=$|[\\\\/\\s"'):,;\\]])`, "gi"), "~");
  // Anybody's: a path copied from another account, or the home of the user the app runs as when that differs.
  out = out.replace(/\/Users\/[^/\s"':]+|\/home\/[^/\s"':]+|\b[A-Z]:\\Users\\[^\\\s"':]+/gi, "~");
  return redactSecrets(out);
}

// ── The log ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A log file that keeps to a size: `friday.log`, then `friday.log.1` and `.2` behind it, the oldest dropped. Lines are queued
 * and written in the background, one write at a time and in order. Nothing here throws: a disk that can't be written loses the
 * lines, not the app.
 */
export class RotatingLog {
  private queue: string[] = [];
  private queued = 0;
  private size = -1;
  private writing: Promise<void> | null = null;
  readonly maxBytes: number;
  readonly keep: number;

  constructor(readonly file: string, o: { maxBytes?: number; keep?: number } = {}) {
    this.maxBytes = o.maxBytes ?? 5 * 1024 * 1024;
    this.keep = Math.max(1, o.keep ?? 3);
  }

  /** One line, with the time and how bad it was in front: `2026-11-24T10:02:11.123Z error …`. */
  line(level: "error" | "warn" | "info", text: string, at = new Date()): void {
    this.write(`${at.toISOString()} ${level.padEnd(5)} ${redactSecrets(text).replace(/\r\n/g, "\n").trimEnd()}\n`);
  }

  write(text: string): void {
    // A burst while the disk is stuck is held to a megabyte, the oldest let go first.
    this.queue.push(text);
    this.queued += text.length;
    while (this.queued > 1024 * 1024 && this.queue.length > 1) this.queued -= this.queue.shift()!.length;
    this.writing ??= this.drain();
  }

  /** Waits for what has been written so far to be on disk (or given up on). */
  async flush(): Promise<void> {
    while (this.writing) await this.writing;
  }

  private async drain(): Promise<void> {
    try {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 }).catch(() => {});
      while (this.queue.length) {
        try {
          if (this.size < 0) this.size = await stat(this.file).then((s) => s.size, () => 0);
          // As many lines as fit in this file; the rest after it rotates. A single line bigger than a whole file goes in alone.
          let batch = "";
          let bytes = 0;
          while (this.queue.length) {
            const next = this.queue[0]!;
            const n = Buffer.byteLength(next);
            if ((batch || this.size > 0) && this.size + bytes + n > this.maxBytes) break;
            batch += next;
            bytes += n;
            this.queue.shift();
            this.queued -= next.length;
          }
          if (!batch) {
            await this.rotate();
            continue;
          }
          await appendFile(this.file, batch, { mode: 0o600 });
          this.size += bytes;
        } catch {
          // Not written (a full disk, the folder taken away): these lines are lost; the size is read again next time.
          this.queue = [];
          this.queued = 0;
          this.size = -1;
        }
      }
    } finally {
      this.writing = null;
      // Lines that came in as it finished.
      if (this.queue.length) this.writing = this.drain();
    }
  }

  /** friday.log → .1 → .2, the last dropped. Windows can refuse a rename for a moment while something reads the file: tried again. */
  private async rotate(): Promise<void> {
    const name = (i: number) => (i ? `${this.file}.${i}` : this.file);
    await unlink(name(this.keep - 1)).catch(() => {});
    for (let i = this.keep - 2; i >= 0; i--) {
      for (let t = 0; t < 5; t++) {
        const err = await rename(name(i), name(i + 1)).then(() => null, (e: NodeJS.ErrnoException) => e);
        if (!err || err.code === "ENOENT" || (err.code !== "EPERM" && err.code !== "EBUSY" && err.code !== "EACCES")) break;
        await sleep(50 * (t + 1));
      }
    }
    this.size = 0;
  }
}

let installed: { log: RotatingLog; home: string } | null = null;

/** The log this process writes to, once installProcessLog has run. */
export const processLog = (): RotatingLog | null => installed?.log ?? null;

/**
 * This process's log at `<home>/diagnostics/friday.log`: its console.error and console.warn copied into it, and its uncaught
 * errors and unhandled rejections logged there and carried on from, as the server (server.ts) and the runner (runner/cli.ts) do.
 * In Electron's main process a listener here is also what keeps Electron from showing its own dialog with a stack. Once per
 * process; a second call returns the first log.
 */
export function installProcessLog(home: string = defaultHome(), o: { what?: string } = {}): RotatingLog {
  if (installed) return installed.log;
  const log = new RotatingLog(logPath(home));
  installed = { log, home };
  const tee = (level: "error" | "warn", original: (...a: unknown[]) => void) =>
    function (this: unknown, ...args: unknown[]) {
      original.apply(console, args);
      try {
        log.line(level, format(...args));
      } catch {
        // A value that can't be printed: the console had it.
      }
    };
  console.error = tee("error", console.error);
  console.warn = tee("warn", console.warn);
  const text = (x: unknown) => (x instanceof Error ? (x.stack ?? x.message) : format(x));
  process.on("unhandledRejection", (reason) => {
    console.error("[friday] unhandled rejection:", text(reason));
    ops.error("process", `unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  });
  process.on("uncaughtException", (err) => {
    console.error("[friday] uncaught exception:", text(err));
    ops.error("process", `uncaught exception: ${err?.message ?? String(err)}`);
  });
  log.line("info", `${o.what ?? "Friday"} started: ${fridayLine()}, pid ${process.pid}`);
  return log;
}

/** Logged without going to the console: what a window did (desktop.ts), which nobody watches a terminal for. */
export function logLine(level: "error" | "warn" | "info", text: string): void {
  installed?.log.line(level, text);
  if (level === "error") ops.error("app", text);
}

// ── The report ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The last `n` lines of the log, reaching into the file before it when the current one is short. */
export async function tailLog(home: string, n = 200): Promise<string[]> {
  const file = logPath(home);
  const read = async (f: string) => {
    try {
      const buf = await readFile(f);
      // The last 256 KB is far more than 200 lines; never the whole of a 5 MB file into memory to keep its end.
      return buf.subarray(Math.max(0, buf.length - 256 * 1024)).toString("utf8").replace(/\r\n/g, "\n").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  let lines = await read(file);
  if (lines.length < n) lines = [...(await read(`${file}.1`)), ...lines];
  return lines.slice(-n);
}

const mb = (b: number) => `${Math.round(b / 1048576)} MB`;
const gb = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : mb(b));
function since(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${Math.floor(s % 60)}s`;
}

/** Which edition this is and how it runs, in words. */
export function editionLine(env: NodeJS.ProcessEnv = process.env, versions: NodeJS.ProcessVersions = process.versions): string {
  const edition = env.FRIDAY_EDITION === "local" ? (env.FRIDAY_MINE === "1" ? "open source, personal build" : "open source") : "hosted";
  return `${edition}, ${versions.electron ? "desktop app" : "from the command line"}`;
}

function fridayLine(): string {
  return `${osName(process.platform)} ${os.release()} ${process.arch}, ${process.versions.electron ? `Electron ${process.versions.electron}, ` : ""}Node ${process.versions.node}`;
}

export interface DiagnosticsInput {
  home: string;
  version: string;
  /** How many sessions are kept. */
  sessions?: () => Promise<number>;
  /** How much the data folder holds, in bytes, as last measured (Settings › Storage); null when it hasn't been. */
  dataBytes?: () => Promise<number | null>;
  /** Lines of the log to include. */
  lines?: number;
}

/**
 * Copy diagnostics: the text, redacted, and where the log file is: as it is for Show log file (the page only, never in the text),
 * and as it is said (`shown`, from ~).
 */
export async function diagnostics(i: DiagnosticsInput): Promise<{ text: string; logFile: string; shown: string }> {
  const settle = <T>(p: Promise<T> | undefined, fallback: T, ms = 3000): Promise<T> =>
    p ? Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms).unref?.())]) : Promise.resolve(fallback);
  const [sessions, dataBytes, free, lines, snap] = await Promise.all([
    settle(i.sessions?.(), -1),
    settle(i.dataBytes?.(), null),
    statfs(i.home).then((s) => Number(s.bavail) * Number(s.bsize), () => -1),
    tailLog(i.home, i.lines ?? 200),
    ops.snapshot(5),
  ]);
  const mem = process.memoryUsage();
  const errors = snap.errors.slice(0, 30);
  const text = [
    "Friday diagnostics",
    `Made: ${new Date().toISOString()}`,
    `Friday ${i.version || "(version unknown)"} (${editionLine()})`,
    `System: ${fridayLine()}`,
    `Running for ${since(process.uptime())}; memory ${mb(mem.rss)} (heap ${mb(mem.heapUsed)}); computer ${gb(os.freemem())} free of ${gb(os.totalmem())}`,
    `Data folder: ${i.home}${dataBytes !== null ? `, ${gb(dataBytes)}` : ""}${free >= 0 ? `; ${gb(free)} free on its disk` : ""}`,
    `Sessions: ${sessions >= 0 ? sessions : "couldn't be counted"}`,
    `Log file: ${logPath(i.home)}`,
    "",
    `Recent errors (${errors.length ? "newest first" : "none"})`,
    ...errors.map((e) => `${new Date(e.at).toISOString()} ${e.source}: ${e.message}`),
    "",
    `Last ${lines.length} log lines`,
    ...lines,
  ].join("\n");
  return { text: redact(text), logFile: logPath(i.home), shown: redact(logPath(i.home)) };
}

/**
 * GET /api/local/diagnostics, for the open-source edition's own page (app.ts calls this behind its localOnly check, which refuses
 * any other page, another host and a phone): the report and the log file's place. True when it answered.
 */
export async function diagnosticsHttp(i: DiagnosticsInput, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== "/api/local/diagnostics") return false;
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json", Allow: "GET" }).end(JSON.stringify({ error: "Only GET." }));
    return true;
  }
  // Only where the log is, for Settings to say and show it, without gathering the rest.
  if (url.searchParams.get("path") === "1") {
    const file = logPath(i.home);
    const exists = await stat(file).then((st) => st.isFile(), () => false);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({ logFile: file, shown: redact(file), exists }));
    return true;
  }
  const body = await diagnostics(i).catch((e: Error) => ({ error: `Diagnostics couldn't be gathered: ${redact(e.message)}` }));
  res.writeHead("error" in body ? 500 : 200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
  return true;
}

// ── Health ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * How Friday on this computer is doing, for Settings › Updates › Health (spec 13 Wave 4; Arun, 2026-11-24: "Go all out and fix these
 * problems"): when it last saved and whether it can, the disk's free space, the data folder's size, the log's size and how many
 * errors it logged this week. Numbers only: the page says them, and what to do when one is off (client/health-line.ts).
 */
export interface Health {
  at: number;
  save: { savedAt: number | null; pending: boolean; failing?: { reason: string; since: number } };
  /** The disk the data folder is on; null where it can't be read. */
  disk: { free: number; total: number } | null;
  /** The data folder, as Settings › Storage last measured it; `measuring` while a measurement is under way. */
  data: { bytes: number | null; at: number | null; measuring: boolean };
  /** This log's files together (friday.log and the two kept behind it), and the most they are kept to. */
  log: { bytes: number; most: number };
  /** Errors logged in the last seven days, and when the newest was. */
  errors: { week: number; last: number | null };
}

export interface HealthInput {
  home: string;
  saves?: { state(): { failing?: { reason: string; since: number } }; last?(): { savedAt: number | null; pending: boolean } };
  data?: () => Promise<Health["data"]>;
  now?: number;
}

const WEEK = 7 * 86_400_000;
/** An error line's time: `2026-11-24T10:02:11.123Z error …` (RotatingLog.line). A stack's lines after it have none, so count once. */
const ERROR_LINE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) error /;
/**
 * Each log file's error times as last read: read again only when the file has changed, and then only what was added to it (the
 * log only grows until it rotates). A health check every few seconds while Settings is open costs a stat per file.
 */
const errorsRead = new Map<string, { ino: number; size: number; mtime: number; times: number[]; rest: string }>();

/** When each error in `file` was logged. Never throws: a file that can't be read has none. */
export async function errorTimes(file: string): Promise<number[]> {
  const st = await stat(file).catch(() => null);
  if (!st?.isFile()) {
    errorsRead.delete(file);
    return [];
  }
  const was = errorsRead.get(file);
  if (was && was.ino === st.ino && was.size === st.size && was.mtime === st.mtimeMs) return was.times;
  // Added to since: only the new part. Rotated or rewritten (smaller, or another file by now): read again from the start.
  const from = was && was.ino === st.ino && st.size > was.size ? was.size : 0;
  // The newest 5 MB at most (one file's whole size): never more of a file into memory than that.
  const start = Math.max(from, st.size - 5 * 1024 * 1024);
  let text = "";
  try {
    const h = await open(file, "r");
    try {
      const buf = Buffer.alloc(st.size - start);
      const { bytesRead } = await h.read(buf, 0, buf.length, start);
      text = buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await h.close();
    }
  } catch {
    return was?.times ?? [];
  }
  const lines = ((start === from && from > 0 ? was!.rest : "") + text).replace(/\r\n/g, "\n").split("\n");
  // What follows the last newline is a line still being written: kept for the next read.
  const rest = lines.pop() ?? "";
  const times = start === from && from > 0 ? [...was!.times] : [];
  for (const l of lines) {
    const m = ERROR_LINE.exec(l);
    if (m) times.push(Date.parse(m[1]!));
  }
  // Only what a week's count can use is kept.
  const since = Date.now() - WEEK;
  const kept = times.filter((t) => t >= since);
  errorsRead.set(file, { ino: st.ino, size: st.size, mtime: st.mtimeMs, times: kept, rest });
  return kept;
}

export async function health(i: HealthInput): Promise<Health> {
  const now = i.now ?? Date.now();
  const file = logPath(i.home);
  const files = [file, `${file}.1`, `${file}.2`];
  const [disk, data, sizes, times] = await Promise.all([
    statfs(i.home).then((s) => ({ free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) }), () => null),
    i.data ? i.data().catch(() => ({ bytes: null, at: null, measuring: false })) : Promise.resolve({ bytes: null, at: null, measuring: false }),
    Promise.all(files.map((f) => stat(f).then((s) => s.size, () => 0))),
    Promise.all(files.map(errorTimes)),
  ]);
  const week = times.flat().filter((t) => t >= now - WEEK && t <= now + 60_000);
  const failing = i.saves?.state().failing;
  const last = i.saves?.last?.() ?? { savedAt: null, pending: false };
  return {
    at: now,
    save: { ...last, ...(failing ? { failing } : {}) },
    disk,
    data,
    log: { bytes: sizes.reduce((a, b) => a + b, 0), most: 3 * 5 * 1024 * 1024 },
    errors: { week: week.length, last: week.length ? Math.max(...week) : null },
  };
}

/** GET /api/local/health, for the open-source edition's own page (app.ts, behind localOnly). True when it answered. */
export async function healthHttp(i: HealthInput, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== "/api/local/health") return false;
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json", Allow: "GET" }).end(JSON.stringify({ error: "Only GET." }));
    return true;
  }
  const body = await health(i).catch((e: Error) => ({ error: `Friday's health couldn't be read: ${redact(e.message)}` }));
  res.writeHead("error" in body ? 500 : 200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
  return true;
}
