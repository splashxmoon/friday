import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough, Writable } from "node:stream";
import type { AcpKept } from "./adapters.js";
import { mcpForAgent, type AcpMcpServer } from "./mcp-servers.js";

/**
 * Starting a coding CLI.
 *
 * On the thread that asked, always. On Windows, creating a process waits for whatever inspects a new executable to be done
 * with it, close to two seconds for Claude Code's claude.exe, and this was moved to a worker thread to spare the rest of
 * the process that wait. That traded it for something worse: a process created on the other thread while git was being
 * started on this one could take git's output pipe with it, and that git then never finished until the CLI exited, which
 * for a kept Claude Code (below) is a quarter of an hour. Node starts processes one at a time on a thread, so here they
 * can't take each other's pipes, and keeping Claude Code from turn to turn means the wait is paid once, not every turn.
 */

/** What callers use of a child process; a turn on a kept Claude Code (below) has the same shape. */
export type CliProcess = Pick<ChildProcess, "pid" | "stdin" | "stdout" | "stderr" | "exitCode" | "signalCode" | "kill" | "on" | "once">;

export interface CliSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const drained = (s: PassThrough) =>
  new Promise<void>((resolve) => {
    if (s.readableEnded || s.destroyed) return resolve();
    s.once("end", resolve);
    s.once("close", resolve);
    s.end();
    // Nobody reading it would hold "close" back for good.
    if (!s.readableFlowing) s.resume();
  });

/** A process that couldn't be started, as a child process says so: an "error" (with its code, ENAMETOOLONG or E2BIG), then "close". */
class NotStarted extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new Writable({ write: (_c, _e, cb) => cb() });
  readonly pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(e: Error) {
    super();
    this.stdout.end();
    this.stderr.end();
    process.nextTick(() => {
      this.emit("error", e);
      this.exitCode = -1;
      this.emit("exit", -1, null);
      this.emit("close", -1, null);
    });
  }
  kill(): boolean {
    return false;
  }
}

/** Start a CLI. Its output, exit and errors arrive as a child process's do, a failure to start included: it never throws. */
export function spawnCli(command: string, args: string[], opts: CliSpawnOptions = {}): CliProcess {
  try {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    if (process.platform === "win32") {
      // A CLI started through a wrapper (Kilo's npm script starts kilo.exe) left its real process running when only the wrapper
      // was ended, and a sign-in check that timed out left one more behind on every look. On Windows the whole tree goes. Not
      // for SIGINT, which a CLI may answer by ending its turn and saving its conversation.
      const own = child.kill.bind(child);
      child.kill = ((signal?: NodeJS.Signals | number) => {
        // SIGINT too: Windows has no gentle signal to send, so Node ends that one process outright and its children (a build,
        // a dev server the agent started) ran on with nothing to stop them. The whole tree goes, the same as for the others.
        if (!child.pid || child.exitCode !== null) return own(signal);
        const tk = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        tk.on("error", () => own(signal));
        return true;
      }) as typeof child.kill;
    }
    return child;
  } catch (e) {
    return new NotStarted(e as Error) as unknown as CliProcess;
  }
}

/**
 * Run a CLI to the end and collect what it said: for the short, non-interactive commands (a sign-in check, a sign-out).
 * `code` is -1 when it couldn't be started, was killed, or ran out of time.
 */
export function execCli(command: string, args: string[], opts: CliSpawnOptions & { timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawnCli(command, args, opts);
    let stdout = "";
    let stderr = "";
    let killed = false;
    child.stdout!.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
    child.stdin!.on("error", () => {});
    // These never read stdin; closing it stops one from waiting forever.
    child.stdin!.end();
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
    }, opts.timeoutMs ?? 20_000);
    let settled = false;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: killed || code === null ? -1 : code, stdout, stderr });
    };
    child.on("error", (e: Error) => {
      stderr += e.message;
      done(-1);
    });
    child.on("close", (code: number | null) => done(code));
  });
}

// ── Claude Code, kept from one turn to the next ─────────────────────

/** How long a kept Claude Code may sit with nothing to do before it is ended, and the MCP servers it started with it. */
const IDLE_MS = 15 * 60_000;
/**
 * One started ahead of a first turn that never came: ended sooner. Each is a few hundred MB (Claude Code with its MCP servers),
 * and a lane left open for days kept one for every reconnect.
 */
const UNUSED_MS = 3 * 60_000;

/** How a turn is started, less the conversation it resumes: a kept process is in that conversation already. */
export function keyOf(command: string, args: string[], cwd = ""): string {
  const i = args.lastIndexOf("--resume");
  const rest = i >= 0 ? [...args.slice(0, i), ...args.slice(i + 2)] : args;
  // Carrying on from a copy of the conversation (--fork-session) is about the conversation too, not how the process starts.
  return JSON.stringify([command, cwd, ...rest.filter((a) => a !== "--fork-session")]);
}

/**
 * Claude Code's background tasks (subagents, commands) still running, kept up to date from a line it printed.
 *
 * Its turn's `result` comes while they run, and once they finish it carries on by itself and writes another: "three audits
 * are running, I'll write the plan when they finish". Ended at the first, the turn lost everything after it.
 */
export function noteBackground(running: Set<string>, m: Record<string, any> | null): void {
  if (m?.type !== "system") return;
  const id = typeof m.task_id === "string" ? m.task_id : "";
  // Not a shell left running in the background: a dev server never finishes, and a turn held for it never ended, the lane
  // "running" and every queued message waiting behind it. Claude Code reads a finite command's output itself before answering.
  const shell = (t: Record<string, any>) => t?.task_type === "local_bash";
  if (m.subtype === "background_tasks_changed" && Array.isArray(m.tasks)) {
    running.clear();
    for (const t of m.tasks) if (typeof t?.task_id === "string" && !shell(t)) running.add(t.task_id);
  } else if (m.subtype === "task_started" && m.is_backgrounded && id && !shell(m)) running.add(id);
  else if (m.subtype === "task_notification" || (m.subtype === "task_updated" && m.patch?.status && m.patch.status !== "running")) running.delete(id);
}

/** One of Claude Code's `/` commands, as its `initialize` answer gives it. */
export interface ClaudeCommand {
  name: string;
  description: string;
  argumentHint: string;
}

/** How long a turn held open for its background tasks waits, once they are done, for Claude Code to carry on before it is ended. */
const SETTLE_MS = 60_000;

/**
 * A turn run as a process of its own has its stdin closed once the instruction is written, so nothing could answer a
 * question it asked mid-turn: it is started without asking, and what needs a yes is refused and asked about once it ends.
 */
function withoutAsking(args: string[]): string[] {
  const i = args.indexOf("--permission-prompt-tool");
  return i < 0 ? args : [...args.slice(0, i), ...args.slice(i + 2)];
}

/** One turn on a kept process, shaped like a process of its own: its output is the turn's lines, and it "exits" when the turn is over. */
class KeptTurn extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  over = false;

  line(l: string): void {
    if (!this.over) this.stdout.write(`${l}\n`);
  }

  end(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.over) return;
    this.over = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    void Promise.all([drained(this.stdout), drained(this.stderr)]).then(() => this.emit("close", code, signal));
  }
}

/**
 * A user message as Claude Code takes it on stdin (--input-format stream-json): its words, and the pictures attached to it as
 * content blocks of their own after them, so it sees them as it does a screenshot pasted at its own prompt.
 */
const userLine = (text: string, pictures: Record<string, unknown>[] = []) => {
  const content = pictures.length ? [{ type: "text", text }, ...pictures] : text;
  return `${JSON.stringify({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "" })}\n`;
};

/** One turn on a kept Claude Code. */
class ClaudeTurn extends KeptTurn {
  readonly stdin: Writable;
  /** The instruction, once all of it has been written to stdin. */
  prompt: string | null = null;
  /** Its `result` came while background tasks still ran: it is over at the one after they finish (see noteBackground). */
  held = false;
  /** The kept process running this turn, for telling whether it is still doing anything (hung.ts). */
  pid: number | undefined = undefined;
  /** Messages sent to it while it runs (WarmClaude.steer) that it hasn't read yet: until it has, its turn isn't over. */
  steering: string[] = [];
  /** How a kill reaches whatever is running this turn. */
  onKill: (signal: NodeJS.Signals | number) => boolean = () => false;

  constructor(
    readonly how: { command: string; args: string[]; opts: CliSpawnOptions; pictures?: Record<string, unknown>[] },
    onPrompt: (t: ClaudeTurn) => void,
  ) {
    super();
    const chunks: Buffer[] = [];
    this.stdin = new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        chunks.push(chunk);
        cb();
      },
      final: (cb) => {
        this.prompt = Buffer.concat(chunks).toString();
        onPrompt(this);
        cb();
      },
    });
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    return !this.over && this.onKill(signal);
  }
}

/**
 * Claude Code, kept running from one turn to the next.
 *
 * Started afresh for every turn, Claude Code spent seconds getting going before each reply: two or three on Windows for
 * the executable alone, then the person's settings, hooks, plugins and MCP servers, then the conversation it resumes.
 * With --input-format stream-json it takes one turn after another on stdin, so one process serves the lane: a turn is a
 * line written to it, and is over at that turn's `result` line. A new one is started only when how it is started has to
 * change (another system note, a Manual yes that widens what it may do), when it died or a turn failed, and after it has
 * sat idle a while, so it doesn't hold the person's MCP servers open for nothing. It can be started before the first
 * turn too, while somebody is still typing that turn's instruction.
 *
 * Each turn is handed out shaped like a process of its own, so the runner treats it as it treats any CLI: its output is
 * that turn's lines, it "exits" at the result, kill("SIGINT") asks Claude Code to stop the turn as Ctrl-C would, and a
 * harder kill ends the process, which the next turn starts again with --resume.
 *
 * A build that can't be run this way dies without a word. That turn is run the old way, one process for the turn, and
 * once that works every later turn is run that way too.
 */
export class WarmClaude {
  private proc: CliProcess | null = null;
  private key = "";
  private turn: ClaudeTurn | null = null;
  private idle: ReturnType<typeof setTimeout> | undefined;
  /** Given a turn at least once: kept for the next one longer than one started ahead that was never used. */
  private used = false;
  /** A turn run the old way worked where the kept process didn't: every turn is run that way from now on. */
  private cold = false;
  /** Closed for good: nothing is kept any more. */
  private shut = false;
  /** The kept process has said something: it is running this way, whatever happens to it later. */
  private spoke = false;
  /** Its `/` commands, as the kept process gave them when it started (see `commands`). */
  private known: Promise<ClaudeCommand[] | null> | null = null;
  /** Control requests sent to the kept process, waiting for their answer, by request id. */
  private readonly asks = new Map<string, (response: Record<string, any> | null) => void>();

  /** `silentMs`: how long a kept process that has never said a word gets to answer its first instruction (see send). */
  constructor(private readonly silentMs = 60_000) {}

  /** Start it now, as the first turn will start it, so that turn finds it ready. */
  prepare(command: string, args: string[], opts: CliSpawnOptions = {}): void {
    if (this.cold || this.shut || this.turn) return;
    this.ensure(command, args, opts);
    this.rest();
  }

  /** A turn. The instruction is written to the stdin of what this returns, which is then ended, as with a process. */
  start(command: string, args: string[], opts: CliSpawnOptions = {}, pictures: Record<string, unknown>[] = []): CliProcess {
    if (this.cold || this.shut) return spawnCli(command, withoutAsking(args), opts);
    clearTimeout(this.idle);
    const t = new ClaudeTurn({ command, args, opts, pictures }, (t) => this.send(t));
    this.turn = t;
    this.used = true;
    return t as unknown as CliProcess;
  }

  /**
   * Answer what the turn now running asked (a `can_use_tool` control_request): allow it as asked, or refuse it with words
   * for the agent to read. False when there is no such turn to answer any more.
   */
  answer(requestId: string, allow: boolean, input: Record<string, unknown>, message: string): boolean {
    const proc = this.proc;
    if (!proc || !this.turn || this.turn.over) return false;
    const response = allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message };
    proc.stdin!.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response } })}\n`);
    return true;
  }

  /**
   * The `/` commands Claude Code answers to: its built-in ones, the person's and the project's, plugins' and skills'. Asked of
   * the kept process as it starts, as the Agent SDK asks (`initialize`), which costs no model call. Null until one has started.
   */
  commands(): Promise<ClaudeCommand[] | null> {
    return this.known ?? Promise.resolve(null);
  }

  /** End the kept process, and a turn running on it, for good. */
  close(): void {
    this.shut = true;
    const t = this.turn;
    this.turn = null;
    t?.kill("SIGTERM");
    t?.end(null, "SIGTERM");
    this.drop();
  }

  private send(t: ClaudeTurn): void {
    if (t.over || this.turn !== t) return;
    const proc = this.ensure(t.how.command, t.how.args, t.how.opts);
    t.pid = proc.pid;
    t.onKill = (signal) => {
      if (signal === "SIGINT") {
        // Claude Code's own way of stopping a turn: what Ctrl-C does at its prompt, and the process stays for the next.
        proc.stdin!.write(`${JSON.stringify({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } })}\n`);
        return true;
      }
      if (this.proc === proc) this.drop();
      if (this.turn === t) this.turn = null;
      t.end(null, typeof signal === "string" ? signal : null);
      return true;
    };
    proc.stdin!.write(userLine(t.prompt ?? "", t.how.pictures));
    // A build that takes the flag but not the turns may neither speak nor exit, and every turn would wait for Stop. One
    // that hasn't said a word a minute after its first instruction is given up on, and the turn run the old way. Only for
    // this turn: a slow start (a long list of MCP servers) is no reason to stop keeping it for good.
    if (!this.spoke) {
      setTimeout(() => {
        if (this.proc !== proc || this.spoke || this.turn !== t || t.over) return;
        this.drop();
        this.alone(t, false);
      }, this.silentMs).unref?.();
    }
  }

  /**
   * A message for the turn running now, read at its next step (Runner: another agent's question, a redirect). Claude Code
   * takes a user message mid-turn and folds it into the turn; one that comes as it finishes starts a turn of its own after
   * the result, and the echo of what it read (--replay-user-messages) says which: the turn here is over only once every
   * message sent to it has been read and the last result after that is in. False when there is no turn to take it.
   */
  steer(text: string): boolean {
    const proc = this.proc;
    const t = this.turn;
    if (!proc || !t || t.over || t.prompt === null || !this.spoke) return false;
    t.steering.push(text);
    proc.stdin!.write(userLine(text));
    return true;
  }

  /** The kept process, started again if a turn has to start differently or it has gone. */
  private ensure(command: string, args: string[], opts: CliSpawnOptions): CliProcess {
    // Which account it runs as is how it starts too (accounts.ts): a kept process signed in as one isn't used for another.
    const key = `${keyOf(command, args, opts.cwd)}|${opts.env?.CLAUDE_CONFIG_DIR ?? ""}`;
    if (this.proc && this.key === key) return this.proc;
    this.drop();
    // Each message it reads is said back as it reads it (--replay-user-messages), for steer: when a message sent mid-turn was read.
    const proc = spawnCli(command, [...args, "--input-format", "stream-json", "--replay-user-messages"], opts);
    this.proc = proc;
    this.key = key;
    this.spoke = false;
    proc.stdin!.on("error", () => {});
    // What it answers to with `/`, asked before anything else as the Agent SDK does. Kept from the last process meanwhile.
    const rid = `friday-init-${randomUUID().slice(0, 8)}`;
    const known = new Promise<ClaudeCommand[] | null>((resolve) => {
      const timer = setTimeout(() => this.asks.delete(rid) && resolve(null), 30_000);
      timer.unref?.();
      this.asks.set(rid, (r) => {
        clearTimeout(timer);
        const list: unknown[] = Array.isArray(r?.commands) ? r.commands : [];
        resolve(list.length ? list.flatMap((c: any) => (c && typeof c.name === "string" ? [{ name: c.name, description: typeof c.description === "string" ? c.description : "", argumentHint: typeof c.argumentHint === "string" ? c.argumentHint : "" }] : [])) : null);
      });
    });
    const before = this.known;
    this.known = known.then((list) => list ?? (before ? before : null));
    proc.stdin!.write(`${JSON.stringify({ type: "control_request", request_id: rid, request: { subtype: "initialize" } })}
`);
    const background = new Set<string>();
    let settle: ReturnType<typeof setTimeout> | undefined;
    const parse = (l: string): Record<string, any> | null => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    };
    createInterface({ input: proc.stdout! }).on("line", (l) => {
      if (this.proc !== proc) return;
      this.spoke = true;
      if (l.includes('"system"')) noteBackground(background, parse(l));
      // The answer to a control request Friday sent (its commands): Friday's, not the turn's.
      if (l.includes('"control_response"')) {
        const r = parse(l)?.response;
        const answer = typeof r?.request_id === "string" ? this.asks.get(r.request_id) : undefined;
        if (answer) {
          this.asks.delete(r.request_id);
          answer(r.subtype === "success" ? (r.response ?? null) : null);
          return;
        }
      }
      const t = this.turn;
      if (!t || t.over || t.prompt === null) return;
      // What it read, said back (--replay-user-messages): Friday's own words, not the turn's output. One sent mid-turn is read now.
      if (l.includes('"type":"user"')) {
        const m = parse(l);
        if (m?.type === "user" && typeof m.message?.content === "string") {
          const i = t.steering.indexOf(m.message.content);
          if (i >= 0) t.steering.splice(i, 1);
          return;
        }
      }
      // Its result while a message sent mid-turn is still unread: it reads that next and answers it in a turn of its own,
      // whose result ends this one. Ended here, that answer went to nobody.
      if (t.steering.length && l.includes('"result"') && parse(l)?.type === "result") return;
      t.line(l);
      // Held for its background tasks, and they are done: it carries on by itself, and is ended if it then says nothing.
      if (t.held && !background.size) {
        clearTimeout(settle);
        settle = setTimeout(() => {
          if (this.turn !== t || t.over || background.size) return;
          t.line(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "", session_id: "" }));
          this.turn = null;
          t.end(0, null);
          this.rest();
        }, SETTLE_MS);
        settle.unref?.();
      }
      if (!l.includes('"result"')) return;
      const m = parse(l);
      if (m?.type !== "result") return;
      if (background.size && !m.is_error) {
        t.held = true;
        return;
      }
      clearTimeout(settle);
      this.turn = null;
      t.end(0, null);
      // A failed turn may have left it unable to carry on (a conversation it couldn't resume): the next starts a new one.
      if (m.is_error) this.drop();
      else this.rest();
    });
    proc.stderr!.on("data", (d: Buffer) => {
      const t = this.proc === proc ? this.turn : null;
      if (t && !t.over) t.stderr.write(d);
    });
    let gone = false;
    const ended = (code: number | null, signal: NodeJS.Signals | null) => {
      if (gone) return;
      gone = true;
      if (this.proc !== proc) return;
      this.proc = null;
      this.key = "";
      const t = this.turn;
      if (!t || t.over || t.prompt === null) return;
      // Gone before saying anything: perhaps a build that can't take turns this way. This one is run the old way.
      if (!this.spoke) return this.alone(t, true);
      this.turn = null;
      t.end(code, signal);
    };
    proc.on("error", (e: Error) => {
      const t = this.proc === proc ? this.turn : null;
      if (t && !t.over) t.stderr.write(e.message);
      // Couldn't be started (it would have spoken otherwise): there is no process to wait for.
      if (this.proc === proc && !this.spoke) ended(-1, null);
    });
    // Over when the process is, even if something it started still holds its output open (as in Runner.turn).
    proc.once("exit", (code: number | null, signal: NodeJS.Signals | null) => setTimeout(() => ended(code, signal), 2000).unref?.());
    proc.once("close", ended);
    return proc;
  }

  /** A turn run as a process of its own, the way every turn used to be. `learn`: if that works, every later turn is run so. */
  private alone(t: ClaudeTurn, learn: boolean): void {
    const child = spawnCli(t.how.command, withoutAsking(t.how.args), t.how.opts);
    t.onKill = (signal) => child.kill(signal);
    child.stdin!.on("error", () => {});
    child.stdin!.end(t.prompt ?? "");
    createInterface({ input: child.stdout! }).on("line", (l) => t.line(l));
    child.stderr!.on("data", (d: Buffer) => t.over || t.stderr.write(d));
    child.on("error", (e: Error) => t.over || t.emit("error", e));
    let done = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (done) return;
      done = true;
      if (code === 0 && learn) this.cold = true;
      if (this.turn === t) this.turn = null;
      t.end(code, signal);
    };
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => setTimeout(() => finish(code, signal), 2000).unref?.());
    child.once("close", finish);
  }

  /** Nothing to do for now: ended if that lasts. */
  private rest(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.turn || this.drop(), this.used ? IDLE_MS : UNUSED_MS);
    this.idle.unref?.();
  }

  /** End the kept process. A turn on it is the caller's to end. */
  private drop(): void {
    clearTimeout(this.idle);
    const proc = this.proc;
    this.proc = null;
    this.key = "";
    if (!proc) return;
    proc.stdin?.end();
    proc.kill("SIGTERM");
  }
}

// ── a tool spoken to over ACP, kept from one turn to the next ───────

/** How a kept ACP tool is started: the command, its `initialize` line (the adapter's stdin), and the conversation the first turn carries on. */
export interface AcpHow {
  command: string;
  args: string[];
  opts: CliSpawnOptions;
  init: string;
  resumeId: string | null;
  /**
   * Codex's app-server speaks its own JSON-RPC rather than ACP: `initialized` once `initialize` is answered, then `thread/start`
   * or `thread/resume` for the conversation (see `codex` in adapters.ts). The turns on it are shaped the same.
   */
  dialect?: "acp" | "codex";
  /** The project's MCP servers, passed as the conversation opens (see mcp-servers.ts): a change starts it afresh. */
  mcpServers?: AcpMcpServer[];
}

/** One turn on a kept ACP tool. Its stdin is the tool's, and ending it ends the turn: the tool stays for the next. */
class AcpTurn extends KeptTurn {
  readonly stdin: Writable;
  /** The kept process running this turn, for telling whether it is still doing anything (hung.ts). */
  readonly pid: number | undefined;

  constructor(
    proc: CliProcess,
    private readonly onKill: () => void,
    onDone: () => void,
  ) {
    super();
    this.pid = proc.pid;
    this.stdin = new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        if (!this.over) proc.stdin!.write(chunk);
        cb();
      },
      final: (cb) => {
        cb();
        if (this.over) return;
        this.end(0, null);
        onDone();
      },
    });
  }

  /** Any signal ends the tool: the parser stops a turn ACP's own way (Parser.cancel), and a kill is for one that won't. */
  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.over) return false;
    this.onKill();
    this.end(null, typeof signal === "string" ? signal : null);
    return true;
  }
}

/**
 * A tool spoken to over ACP (see `acp` in adapters.ts), kept running from one turn to the next.
 *
 * Started afresh for every turn, each turn waited for the tool to start and answer `initialize`, two and a half seconds for
 * GitHub Copilot, then for it to open the conversation again: a second and a half more for Copilot, over four for a new
 * OpenCode one. ACP is made for one process that holds its conversations, so the tool is started as the lane opens, initialized,
 * and the conversation the first turn carries on (or a new one) opened while somebody is still typing. A turn on it then only
 * sends its instruction.
 *
 * Each turn is handed out shaped like a process of its own, so the runner treats it as any CLI. A new one is started when how
 * it is started has to change, when it has gone, after a turn that failed (it may have been signed in since, or lost its
 * conversation), and once it has sat idle a while. One that won't start or answer costs nothing over before: the turn starts a
 * process of its own, as every turn used to.
 */
export class WarmAcp {
  private proc: CliProcess | null = null;
  private key = "";
  private opening: Promise<AcpKept | null> = Promise.resolve(null);
  private turn: AcpTurn | null = null;
  private idle: ReturnType<typeof setTimeout> | undefined;
  /** Given a turn at least once: kept for the next one longer than one started ahead that was never used. */
  private used = false;
  private shut = false;
  /** Its `/` commands as it said them between turns, as a conversation opened: the next turn's parser reports them. */
  private commands: string | null = null;
  /** What was asked of it as it opened, waiting for the answer, by JSON-RPC id. */
  private readonly asks = new Map<string, (m: Record<string, any> | null) => void>();
  /**
   * It can't be started this way at all: the process ended before it answered `initialize` (a Codex too old to have an app-server
   * says "unrecognized subcommand" and exits). The runner then runs Codex's turns the old way, one process each.
   */
  unsupported = false;

  /** `quietMs`: how long it gets to answer as it starts before it is given up on. */
  constructor(private readonly quietMs = 60_000) {}

  /** Start it now, as the first turn would, so that turn finds it ready. */
  prepare(how: AcpHow): void {
    if (this.shut || this.turn || (this.proc && this.key === keyOfAcp(how))) return;
    this.open(how);
  }

  /** A turn on the kept tool, once it is ready, with what its parser needs to know of it. Null when it can't be kept: the turn starts its own. */
  async take(how: AcpHow): Promise<{ child: CliProcess; kept: AcpKept } | null> {
    if (this.shut || this.turn) return null;
    if (!this.proc || this.key !== keyOfAcp(how)) this.open(how);
    const proc = this.proc;
    const kept = await this.opening;
    if (!kept || !proc || this.proc !== proc || this.turn || this.shut) return null;
    clearTimeout(this.idle);
    const t: AcpTurn = new AcpTurn(
      proc,
      () => {
        if (this.turn === t) this.turn = null;
        if (this.proc === proc) this.drop();
      },
      () => {
        if (this.turn !== t) return;
        this.turn = null;
        this.rest();
      },
    );
    this.turn = t;
    this.used = true;
    if (this.commands) t.line(this.commands);
    this.commands = null;
    return { child: t as unknown as CliProcess, kept };
  }

  /** Start afresh next turn: this one failed, and may have left it unable to carry on. */
  reset(): void {
    if (!this.turn) this.drop();
  }

  /** End it, and a turn running on it, for good. */
  close(): void {
    this.shut = true;
    const t = this.turn;
    this.turn = null;
    t?.end(null, "SIGTERM");
    this.drop();
  }

  private open(how: AcpHow): void {
    this.drop();
    const proc = spawnCli(how.command, how.args, how.opts);
    this.proc = proc;
    this.key = keyOfAcp(how);
    proc.stdin!.on("error", () => {});
    const call = (id: string, line: string) =>
      new Promise<Record<string, any> | null>((resolve) => {
        const timer = setTimeout(() => this.asks.delete(id) && resolve(null), this.quietMs);
        timer.unref?.();
        this.asks.set(id, (m) => {
          clearTimeout(timer);
          resolve(m);
        });
        proc.stdin!.write(line);
      });
    createInterface({ input: proc.stdout! }).on("line", (l) => {
      if (this.proc !== proc) return;
      if (this.asks.size) {
        let m: Record<string, any> | null = null;
        try {
          m = JSON.parse(l);
        } catch {}
        const answer = m && m.method === undefined && m.id != null ? this.asks.get(String(m.id)) : undefined;
        if (answer) {
          this.asks.delete(String(m!.id));
          return answer(m);
        }
      }
      const t = this.turn;
      if (t && !t.over) return t.line(l);
      if (l.includes('"available_commands_update"')) this.commands = l;
    });
    proc.stderr!.on("data", (d: Buffer) => {
      const t = this.proc === proc ? this.turn : null;
      if (t && !t.over) t.stderr.write(d);
    });
    let gone = false;
    const ended = (code: number | null, signal: NodeJS.Signals | null) => {
      if (gone) return;
      gone = true;
      if (this.proc !== proc) return;
      // Gone before it ever answered `initialize`: this isn't a tool that can be kept this way, and it is not tried again.
      if (this.asks.has("0")) this.unsupported = true;
      const t = this.turn;
      this.turn = null;
      this.drop();
      t?.end(code, signal);
    };
    proc.on("error", (e: Error) => {
      const t = this.proc === proc ? this.turn : null;
      if (t && !t.over) t.stderr.write(e.message);
      ended(-1, null);
    });
    // Over when the process is, even if something it started still holds its output open (as in Runner.turn).
    proc.once("exit", (code: number | null, signal: NodeJS.Signals | null) => setTimeout(() => ended(code, signal), 2000).unref?.());
    proc.once("close", ended);
    this.opening = (async () => {
      const init = await call("0", how.init);
      if (this.proc !== proc) return null;
      // It couldn't start, or wouldn't answer: the turn starts one of its own, which says why. One that neither answered nor
      // ended in all that time isn't speaking this at all: for Codex, the old way is taken from here (see Runner.useLegacyCodex).
      if (!init?.result) {
        if (how.dialect === "codex") this.unsupported = true;
        this.drop();
        return null;
      }
      if (how.dialect === "codex") {
        // Its handshake: `initialized` back, then the conversation. One it can't resume is left to the turn to open, and to say why.
        proc.stdin!.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
        const kept: AcpKept = { caps: {} };
        const cwd = how.opts.cwd ?? process.cwd();
        const params = how.resumeId ? { threadId: how.resumeId, cwd } : { cwd, serviceName: "friday" };
        const s = await call("friday-open", `${JSON.stringify({ id: "friday-open", method: how.resumeId ? "thread/resume" : "thread/start", params })}\n`);
        const threadId = typeof s?.result?.thread?.id === "string" ? s.result.thread.id : "";
        if (s?.result && threadId) Object.assign(kept, { sessionId: threadId, res: s.result, fresh: !how.resumeId });
        return kept;
      }
      const kept: AcpKept = { caps: init.result.agentCapabilities ?? {} };
      const load = !!how.resumeId && !!kept.caps.loadSession;
      if (how.resumeId && !load) return kept;
      const params = { cwd: how.opts.cwd ?? process.cwd(), mcpServers: mcpForAgent(how.mcpServers, kept.caps) };
      const s = await call("friday-open", `${JSON.stringify({ jsonrpc: "2.0", id: "friday-open", method: load ? "session/load" : "session/new", params: load ? { ...params, sessionId: how.resumeId } : params })}\n`);
      const sessionId = load ? how.resumeId! : typeof s?.result?.sessionId === "string" ? s.result.sessionId : "";
      // One it couldn't open (not signed in, a conversation gone) is the turn's to open, and to say why it couldn't.
      if (s?.result && sessionId) Object.assign(kept, { sessionId, res: s.result, fresh: !load });
      return kept;
    })();
    this.rest();
  }

  /** Nothing to do for now: ended if that lasts. */
  private rest(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.turn || this.drop(), this.used ? IDLE_MS : UNUSED_MS);
    this.idle.unref?.();
  }

  /** End the kept tool. A turn on it is the caller's to end. */
  private drop(): void {
    clearTimeout(this.idle);
    const proc = this.proc;
    this.proc = null;
    this.key = "";
    this.opening = Promise.resolve(null);
    this.commands = null;
    for (const answer of [...this.asks.values()]) answer(null);
    this.asks.clear();
    if (!proc) return;
    proc.stdin?.end();
    proc.kill("SIGTERM");
  }
}

/** How a kept ACP tool was started, less the conversation: one started any other way (another mode, model or folder) isn't used. */
export const keyOfAcp = (how: AcpHow) => JSON.stringify([how.command, how.args, how.opts.cwd ?? "", how.opts.env ?? {}, how.dialect ?? "acp", how.mcpServers ?? []]);

// ── the next turn's process, for a CLI that runs one a turn ─────────

/**
 * Cursor, Amp and `codex exec` run one process a turn and have no way to be handed a second turn (cursor-agent 2026.09.28, codex
 * 0.159; Amp has only --execute). Their next process is started as a turn ends instead, with the argv the next turn will most
 * likely have and its prompt left for stdin, so its startup (1 to 4s on Windows) is paid before the next message rather than on
 * it. It does nothing until it reads that prompt. A turn that would start differently (another model, effort or mode, a yes in
 * Manual, another conversation) ends it and starts its own: only an exact match of command, argv, folder and environment is used.
 */
export class Prespawn {
  private kept: { key: string; child: CliProcess; idle: ReturnType<typeof setTimeout> } | null = null;
  private shut = false;

  start(command: string, args: string[], opts: CliSpawnOptions = {}): void {
    if (this.shut) return;
    this.drop();
    const child = spawnCli(command, args, opts);
    child.stdin!.on("error", () => {});
    const idle = setTimeout(() => this.kept?.child === child && this.drop(), IDLE_MS);
    idle.unref?.();
    const kept = { key: JSON.stringify([command, args, opts.cwd ?? "", opts.env ?? {}]), child, idle };
    this.kept = kept;
    // Gone by itself (it timed out on its stdin, or couldn't start): the next turn starts its own.
    child.once("exit", () => this.kept === kept && (clearTimeout(idle), (this.kept = null)));
  }

  /** The process kept for a turn started exactly so, still running; anything else kept is ended. */
  take(command: string, args: string[], opts: CliSpawnOptions = {}): CliProcess | null {
    const k = this.kept;
    if (!k) return null;
    this.kept = null;
    clearTimeout(k.idle);
    if (k.key === JSON.stringify([command, args, opts.cwd ?? "", opts.env ?? {}]) && k.child.exitCode === null && k.child.signalCode === null) return k.child;
    // Not its stdin first: ended, it would read an empty prompt and start a turn before the kill lands.
    k.child.kill("SIGTERM");
    return null;
  }

  /** End what is kept, for good. */
  close(): void {
    this.shut = true;
    this.drop();
  }

  private drop(): void {
    const k = this.kept;
    this.kept = null;
    if (!k) return;
    clearTimeout(k.idle);
    // Not its stdin first: ended, it would read an empty prompt and start a turn before the kill lands.
    k.child.kill("SIGTERM");
  }
}
