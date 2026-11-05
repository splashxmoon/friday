import { execFileSync } from "node:child_process";

/**
 * What Friday started on this computer and must not leave behind: the coding tools (spawn-cli.ts), the commands agents leave
 * running (background.ts), and the shells of the terminal panels (terminals.ts, desktop-terminal.ts). Ended as Friday quits,
 * with the same steps for all: a moment to stop on what they were already sent, SIGTERM, then SIGKILL. Only what is listed
 * here, which is only what Friday started (and what that started in turn): never anything the person started elsewhere.
 */
export interface Owned {
  alive(): boolean;
  signal(sig: NodeJS.Signals): void;
}

const owned = new Set<Owned>();

/** Listed until it's gone. Returns what takes it off the list. */
export function own(o: Owned): () => void {
  owned.add(o);
  return () => void owned.delete(o);
}

/** Whatever is still running, killed outright: the last thing a process does as it exits. */
export function killTools(): void {
  for (const o of owned) {
    try {
      if (o.alive()) o.signal("SIGKILL");
    } catch {
      // Nothing more to do for it.
    }
    owned.delete(o);
  }
}
process.on("exit", killTools);

/**
 * Friday quitting: whatever is still running has half of `ms` to finish what it was already told (a tool's Ctrl-C, a shell's
 * hangup), then SIGTERM, then SIGKILL when `ms` is up. Resolves as soon as nothing is left.
 */
export async function endTools(ms: number): Promise<void> {
  const left = () => [...owned].filter((o) => o.alive() || (owned.delete(o), false));
  const until = async (end: number) => {
    while (left().length && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  };
  const start = Date.now();
  await until(start + ms / 2);
  for (const o of left()) o.signal("SIGTERM");
  await until(start + ms);
  killTools();
}

/** Every process now, with its parent and when it started (which tells a pid reused since from the one we saw). */
type Table = Map<number, { ppid: number; started: string }>;
let cached: { at: number; t: Table } | null = null;
function table(): Table {
  if (cached && Date.now() - cached.at < 80) return cached.t;
  const t: Table = new Map();
  try {
    const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,lstart="], { encoding: "utf8", timeout: 5000, maxBuffer: 16 << 20, stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (m) t.set(Number(m[1]), { ppid: Number(m[2]), started: m[3]! });
    }
  } catch {
    // No ps: nothing can be told apart, so nothing is signalled.
  }
  cached = { at: Date.now(), t };
  return t;
}

/**
 * A process and everything under it: a terminal's shell, whose jobs each have a process group of their own. Each one seen is
 * remembered with its start time, so one whose parent is gone (moved under launchd or init) is still found, and a pid reused
 * since by something else is not. `signal` looks again first; call it before ending the root by other means (a pty's kill),
 * so what is under it is seen while it is still there. On Windows, `fallback` (a pty's own kill, which ends its tree there).
 */
export function processTree(root: number, fallback: () => void): Owned {
  if (process.platform === "win32") {
    let gone = false;
    return {
      alive: () => !gone,
      signal: () => {
        gone = true;
        fallback();
      },
    };
  }
  const seen = new Map<number, string>();
  const look = (t: Table) => {
    const r = t.get(root);
    if (r && !seen.has(root)) seen.set(root, r.started);
    const kids = new Map<number, number[]>();
    for (const [pid, p] of t) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), pid]);
    const stack = [...seen.keys()].filter((pid) => t.get(pid)?.started === seen.get(pid));
    while (stack.length) {
      for (const k of kids.get(stack.pop()!) ?? []) {
        if (seen.has(k) || k === process.pid) continue;
        seen.set(k, t.get(k)!.started);
        stack.push(k);
      }
    }
  };
  const living = (t: Table) => [...seen].filter(([pid, started]) => t.get(pid)?.started === started).map(([pid]) => pid);
  return {
    alive: () => {
      const t = table();
      look(t);
      return living(t).length > 0;
    },
    signal: (sig) => {
      cached = null;
      const t = table();
      look(t);
      for (const pid of living(t)) {
        try {
          process.kill(pid, sig);
        } catch {
          // Gone between the look and the signal.
        }
      }
    },
  };
}
