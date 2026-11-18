import { execFile } from "node:child_process";

/**
 * Stop one command a coding tool is running, and only it (Arun, 2026-11-18: "be able to stop any task"): the Tasks tab's stop on a
 * command row. A command an agent runs (Claude Code's Bash, Codex's shell, a background one) is a shell under the tool's own process
 * whose command line carries the command's words. That shell and everything it started are stopped, politely first; the tool sees
 * its command end, says so, and carries on with its task rather than the whole task being stopped.
 */

export interface Proc {
  pid: number;
  ppid: number;
  cmd: string;
}

/** Quotes, backslashes and runs of spaces taken out, as a shell's `eval '…'` re-quotes the command it was given. */
const plain = (s: string) => s.replace(/["'\\`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/** The words of a command to look for: without a leading `cd <folder> &&`, cut to a length a command line keeps whole. */
export function needleOf(command: string): string {
  return plain(command.replace(/^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/, "")).slice(0, 120);
}

/** `ps -A -o pid=,ppid=,command=` as rows. */
export function parsePs(out: string): Proc[] {
  return out.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3]! }] : [];
  });
}

/**
 * The processes to stop for `command` under `root`: the highest ones in its tree whose command line carries the command's words
 * (a shell running it, not each of its children again), and all under them. Empty when nothing matches.
 */
export function matchTree(procs: readonly Proc[], root: number, command: string): number[] {
  const needle = needleOf(command);
  if (needle.length < 3) return [];
  const kids = new Map<number, Proc[]>();
  for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  const out: number[] = [];
  const all = (pid: number): number[] => [pid, ...(kids.get(pid) ?? []).flatMap((k) => all(k.pid))];
  const walk = (pid: number, depth: number) => {
    if (depth > 30) return;
    for (const k of kids.get(pid) ?? []) {
      if (plain(k.cmd).includes(needle)) out.push(...all(k.pid));
      else walk(k.pid, depth + 1);
    }
  };
  walk(root, 0);
  return [...new Set(out)];
}

function list(): Promise<Proc[]> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      const ps = "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)\" }";
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 15_000, maxBuffer: 32 << 20, windowsHide: true }, (err, out) => resolve(err ? [] : parsePs(String(out).replace(/\r/g, ""))));
      return;
    }
    execFile("ps", ["-A", "-o", "pid=,ppid=,command="], { timeout: 10_000, maxBuffer: 32 << 20 }, (err, out) => resolve(err ? [] : parsePs(String(out))));
  });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Stop `command` under the process `root` (the coding tool): how many processes were asked to stop, 0 when none matched. */
export async function stopCommand(root: number | undefined, command: string): Promise<number> {
  if (!root) return 0;
  const pids = matchTree(await list(), root, command);
  if (!pids.length) return 0;
  if (process.platform === "win32") {
    // The tree from its top, at once: Windows has no polite stop a shell passes on.
    await new Promise<void>((r) => execFile("taskkill", ["/T", "/F", ...pids.flatMap((p) => ["/PID", String(p)])], { windowsHide: true, timeout: 15_000 }, () => r()));
    return pids.length;
  }
  for (const p of pids) {
    try {
      process.kill(p, "SIGTERM");
    } catch {
      // Gone already.
    }
  }
  // Whatever ignores the polite stop goes after three seconds.
  setTimeout(() => {
    for (const p of pids) if (alive(p)) try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
  }, 3000).unref?.();
  return pids.length;
}
