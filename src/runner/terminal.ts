import { execFile, spawn, type ChildProcess } from "node:child_process";

/**
 * Open a terminal on this machine running one fixed command.
 *
 * The sign-ins that matter here (Claude Code, Codex, Cursor, gh) are browser
 * flows owned by those tools, and Friday must not stand in the middle of one.
 * So it opens the tool's own login in a real terminal and steps back. The
 * command is returned either way, so a platform we can't open a terminal on
 * can still show it to copy.
 */
/**
 * How Windows opens a terminal window running `command`: cmd's `start`, in a window of its own that stays open. Given to cmd as
 * written (windowsVerbatimArguments): Node's own quoting (\" inside quotes) is not cmd's, so a path with a space in it came out
 * broken. `/s` drops the quotes round what follows /c, and the extra pair round the command does the same for `cmd /k`, so a quoted
 * "C:\Program Files\…" survives both (splashxmoon/friday#21).
 */
export function windowsTerminalArgs(command: string): string[] {
  return ["/d", "/s", "/c", `"start "" cmd /k "${command}""`];
}

/**
 * The line that runs `argv` (with `env` set for it) when typed into the shell Friday's own terminal starts on this computer: its
 * login shell on a Mac or Linux, PowerShell on Windows (desktop-terminal.ts), or the one FRIDAY_SHELL names. For a sign-in run
 * inside Friday rather than in a window of its own (Arun, 2026-11-10: "Build all four", after T3 Code's sign-ins in its own page).
 */
export function shellLine(argv: string[], env: Record<string, string> = {}, platform: NodeJS.Platform = process.platform, shell = process.env.FRIDAY_SHELL ?? "", exit = false): string {
  const kind = /(?:^|[\\/])cmd(?:\.exe)?$/i.test(shell) ? "cmd" : platform === "win32" && !/(?:ba|z|fi)?sh(?:\.exe)?$/i.test(shell) ? "pwsh" : "posix";
  const vars = Object.entries(env);
  if (kind === "pwsh") {
    const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
    // `&` runs a quoted path as a command; a variable set first lasts for this shell, which is the sign-in's own.
    return [...vars.map(([k, v]) => `$env:${k}=${q(v)}; `), `& ${argv.map(q).join(" ")}`, exit ? "; exit $LASTEXITCODE" : ""].join("");
  }
  if (kind === "cmd") {
    const q = (v: string) => (/[\s"&|<>^]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    return [...vars.map(([k, v]) => `set "${k}=${v}" && `), argv.map(q).join(" "), exit ? " & exit" : ""].join("");
  }
  const q = (v: string) => (/^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);
  // `exit`: the shell ends with the command, so its end says the sign-in's command is over (and how it went).
  return (vars.length ? `env ${vars.map(([k, v]) => q(`${k}=${v}`)).join(" ")} ` : "") + argv.map(q).join(" ") + (exit ? "; exit" : "");
}

export async function openInTerminal(argv: string[], env: Record<string, string> = {}): Promise<{ opened: boolean; command: string }> {
  const win = process.platform === "win32";
  const quote = (s: string) => (win ? (/[\s"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s) : `'${s.replace(/'/g, `'\\''`)}'`);
  // What it runs with besides (one of a tool's accounts: CODEX_HOME), said in the command, since the terminal is its own process.
  const vars = Object.entries(env);
  const command = (win ? vars.map(([k, v]) => `set "${k}=${v}" && `).join("") : vars.length ? `env ${vars.map(([k, v]) => quote(`${k}=${v}`)).join(" ")} ` : "") + argv.map(quote).join(" ");
  const run = (cmd: string, args: string[]) => new Promise<void>((resolve, reject) => execFile(cmd, args, { windowsHide: true }, (err) => (err ? reject(err) : resolve())));
  try {
    if (process.platform === "darwin") {
      const script = `"${command.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
      await run("osascript", ["-e", 'tell application "Terminal" to activate', "-e", `tell application "Terminal" to do script ${script}`]);
      return { opened: true, command };
    }
    if (win) {
      // `start "" cmd /k` leaves the window open after the sign-in finishes. Not hidden: started hidden, the window it opened could
      // be hidden too, and a sign-in waited in a window nobody could see.
      await new Promise<void>((resolve, reject) =>
        execFile(process.env.COMSPEC ?? "cmd.exe", windowsTerminalArgs(command), { windowsVerbatimArguments: true }, (err) => (err ? reject(err) : resolve())),
      );
      return { opened: true, command };
    }
    const shell = `${command}; exec ${process.env.SHELL ?? "bash"}`;
    for (const [c, a] of [
      ["x-terminal-emulator", ["-e", "bash", "-lc", shell]],
      ["gnome-terminal", ["--", "bash", "-lc", shell]],
      ["konsole", ["-e", "bash", "-lc", shell]],
      ["xterm", ["-e", "bash", "-lc", shell]],
    ] as [string, string[]][]) {
      try {
        await run(c, a);
        return { opened: true, command };
      } catch {
        // try the next terminal
      }
    }
  } catch {
    // Fall through: the command is still shown for the person to run.
  }
  return { opened: false, command };
}

/**
 * Start a CLI's sign-in, hand back the link it prints, and keep it alive.
 *
 * These flows do not end at the browser. Claude Code prints a URL, opens it
 * itself, and then waits on *stdin* for the code that page shows — so a child
 * started with no stdin can never finish signing in, however well the browser
 * half went. That is what used to happen: the URL was captured, the page was
 * opened a second time from the app, and the process sat there forever
 * holding a flow nobody could complete.
 *
 * So the child is kept, with a writable stdin, until either it exits on its
 * own (the flows that come back over a local callback) or `finishLogin` hands
 * it the code somebody pasted.
 */
interface Pending {
  child: ChildProcess;
  /** Everything it has said, so a failure can be shown rather than guessed at. */
  out: string;
  code: number | null;
}

const pending = new Map<string, Pending>();

/**
 * How long a sign-in waits for its code before it is ended. A tool's sign-in code expires well within this; one nobody finished
 * (the page closed, the person went off) used to hold its CLI open on the machine for as long as the runner ran.
 */
export const LOGIN_TTL_MS = 20 * 60_000;

export function startLogin(key: string, argv: string[], opts: { env?: NodeJS.ProcessEnv; waitMs?: number; expireMs?: number } = {}): Promise<{ url?: string; command: string; pid?: number }> {
  const [cmd, ...args] = argv;
  const quote = (s: string) => (process.platform === "win32" ? (/[\s"]/.test(s) ? `"${s}"` : s) : `'${s.replace(/'/g, `'\''`)}'`);
  const command = argv.map(quote).join(" ");
  // One sign-in at a time per tool: a second one would be racing the first for
  // the same credential file.
  cancelLogin(key);
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd!, args, { env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"], detached: false, windowsHide: true });
    } catch {
      return resolve({ command });
    }
    const held: Pending = { child, out: "", code: null };
    pending.set(key, held);
    const expiry = setTimeout(() => {
      if (pending.get(key) === held) cancelLogin(key);
      else if (held.code === null) child.kill();
    }, opts.expireMs ?? LOGIN_TTL_MS);
    expiry.unref?.();
    child.once("exit", () => clearTimeout(expiry));
    let done = false;
    const finish = (url?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ url, command, pid: child.pid });
    };
    // The first https:// the tool prints is the page to open. Anything after
    // it is progress output for a flow that is already under way.
    const scan = (chunk: Buffer) => {
      held.out = (held.out + chunk.toString()).slice(-8_000);
      const m = held.out.match(/https:\/\/[^\s"'<>()]+/);
      if (m) finish(m[0]);
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
    child.on("error", () => finish());
    child.on("exit", (code) => {
      held.code = code ?? 0;
      finish();
    });
    // Long enough for a CLI that has to start a runtime first, short enough
    // that nobody wonders whether the button worked.
    const timer = setTimeout(() => finish(), opts.waitMs ?? 8_000);
  });
}

/** Whether a sign-in started here is still waiting for something. */
export const loginPending = (key: string) => pending.get(key)?.code === null;

/**
 * Hand a sign-in the code the browser showed, and wait for it to land.
 *
 * The CLI answers by exiting: zero when the code was good, non-zero when it
 * wasn't. Its own last words are returned either way, because "that code has
 * expired" is the CLI's sentence to write, not ours.
 */
export function finishLogin(key: string, code: string): Promise<{ ok: boolean; output: string }> {
  const held = pending.get(key);
  if (!held) return Promise.resolve({ ok: false, output: "That sign-in isn't running any more. Start it again." });
  if (held.code !== null) return Promise.resolve({ ok: held.code === 0, output: held.out.slice(-600) });
  return new Promise((resolve) => {
    const settle = (ok: boolean) => {
      clearTimeout(timer);
      pending.delete(key);
      resolve({ ok, output: held.out.slice(-600) });
    };
    held.child.once("exit", (c) => settle((c ?? 1) === 0));
    held.child.once("error", () => settle(false));
    // Newline included: it is a prompt, and a prompt reads a line.
    held.child.stdin?.write(`${code}\n`);
    // Nothing should take this long. Leaving it hanging would leave the
    // spinner hanging with it.
    const timer = setTimeout(() => settle(false), 60_000);
  });
}

/** Stop a sign-in nobody is going to finish. */
export function cancelLogin(key: string): void {
  const held = pending.get(key);
  pending.delete(key);
  if (held && held.code === null) held.child.kill();
}
