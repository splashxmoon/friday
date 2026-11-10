import { currentMachine, linkToken } from "./local.js";

/**
 * Terminals in a browser: the same shape as the desktop app's (window.fridayDesktop.terminal), carried over one
 * WebSocket to Friday (`/term`), which hands them to the runner on the picked machine (src/runner/terminals.ts). So the
 * Terminal panel draws a real shell on that machine whether or not the desktop app is around it.
 *
 * Shells live as long as this page's connection: a reload ends them, as closing a desktop window does.
 */

type TermApi = NonNullable<NonNullable<Window["fridayDesktop"]>["terminal"]>;
type Started = Awaited<ReturnType<TermApi["start"]>>;

type Conn = { machine: string; ws: WebSocket; open: Promise<void>; reqs: Set<string> };
let conn: Conn | null = null;
/**
 * This computer's own shells, for a page with no desktop app (`/term?machine=here`, open-source edition): a coding tool's
 * sign-in under its row in Settings. A connection of its own, so it never closes the panel's to another computer, nor the panel's
 * closing it; its end is not a drop the panel restarts its shells for.
 */
let hereConn: Conn | null = null;
const waiting = new Map<string, (r: Started) => void>();
const dataFns = new Set<(id: string, data: string) => void>();
const exitFns = new Set<(id: string, code: number) => void>();
const dropFns = new Set<() => void>();
/**
 * Told when the connection to the machine drops after it was up: its shells ended with it (src/runner/terminals.ts), so a
 * panel kept on screen starts a new one rather than showing a screen that takes keys and does nothing. A panel used to be
 * drawn again on every tab switch, which started one by accident; now it stays, so it has to be told.
 */
export function onTermDrop(fn: () => void): () => void {
  dropFns.add(fn);
  return () => void dropFns.delete(fn);
}
let reqCount = 0;

function socket(machine: string): Conn {
  const here = machine === "here";
  const was = here ? hereConn : conn;
  if (was && was.machine === machine && was.ws.readyState <= WebSocket.OPEN) return was;
  if (!here) conn?.ws.close();
  const reqs = new Set<string>();
  const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/term?machine=${encodeURIComponent(machine)}`);
  let up = false;
  const open = new Promise<void>((resolve, reject) => {
    ws.addEventListener("message", function ready(e) {
      if ((JSON.parse(String(e.data)) as { op?: string }).op === "ready") {
        ws.removeEventListener("message", ready);
        up = true;
        resolve();
      }
    });
    ws.addEventListener("close", (e) => reject(new Error(e.reason || "The machine's terminal connection closed.")));
  });
  open.catch(() => {});
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data)) as { op?: string; req?: string; result?: Started; id?: string; data?: string; code?: number };
    if (m.op === "started" && m.req) {
      waiting.get(m.req)?.(m.result ?? { ok: false, error: "No answer." });
      waiting.delete(m.req);
      reqs.delete(m.req);
    } else if (m.op === "data" && m.id && typeof m.data === "string") for (const f of dataFns) f(m.id, m.data);
    else if (m.op === "exit" && m.id) for (const f of exitFns) f(m.id, m.code ?? 0);
  });
  ws.addEventListener("close", (e) => {
    // Every terminal still waiting to start on it is told why, rather than spinning; the next start opens a new connection.
    for (const req of reqs) {
      waiting.get(req)?.({ ok: false, error: e.reason || "The connection to the machine closed." });
      waiting.delete(req);
    }
    if (here) {
      if (hereConn?.ws === ws) hereConn = null;
      return;
    }
    // Only the connection in use: one closed because another machine was picked is not a drop.
    if (conn?.ws !== ws) return;
    conn = null;
    if (up) for (const f of dropFns) f();
  });
  const made = { machine, ws, open, reqs };
  if (here) hereConn = made;
  else conn = made;
  return made;
}

const send = (machine: string, m: Record<string, unknown>) => {
  const c = socket(machine);
  void c.open.then(() => c.ws.send(JSON.stringify(m)), () => {});
};

function remote(machine: string): TermApi {
  return {
    async start(opts) {
      const c = socket(machine);
      try {
        await c.open;
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      const req = String(++reqCount);
      c.reqs.add(req);
      const answer = new Promise<Started>((resolve) => waiting.set(req, resolve));
      c.ws.send(JSON.stringify({ op: "start", req, ...opts }));
      return answer;
    },
    write: (id, data) => send(machine, { op: "write", id, data }),
    resize: (id, cols, rows) => send(machine, { op: "resize", id, cols, rows }),
    kill: (id) => send(machine, { op: "kill", id }),
    onData: (fn) => (dataFns.add(fn), () => void dataFns.delete(fn)),
    onExit: (fn) => (exitFns.add(fn), () => void exitFns.delete(fn)),
  };
}

/**
 * The terminals the panel draws: the picked always-on (or browser-connected) machine's, over Friday; otherwise the desktop
 * app's own. None in a browser with no machine picked.
 */
/** This computer's own shells: the desktop app's, else (the open-source edition in a browser) over its own Friday. */
export function hereTerminalApi(): TermApi {
  return window.fridayDesktop?.terminal ?? remote("here");
}

export function terminalApi(): TermApi | undefined {
  if (typeof window === "undefined") return undefined;
  // The open session's computer when it runs on another of yours (local.ts currentMachine), else the one picked.
  const machine = currentMachine();
  return machine ? remote(machine) : window.fridayDesktop?.terminal;
}

/**
 * Where a coding agent's own screen opens (the terminal view, Terminal.tsx LaneTui): on the computer the agent runs on, by the
 * name its runner gave (EngineInfo.machine), whatever machine the Terminal panel has picked. One of your always-on or
 * browser-connected machines when it is one of those; otherwise this computer's, in the desktop app (the asking app's own link
 * is never on the list, AlwaysOn.tsx).
 */
export async function laneTerminalApi(machine?: string): Promise<TermApi | undefined> {
  if (typeof window === "undefined") return undefined;
  const here = window.fridayDesktop?.terminal ?? terminalApi();
  if (!machine) return here;
  // Another of your computers, by its id, in the open-source edition (EngineInfo.computer): its screen is there.
  if (/^[0-9a-f]{16}$/.test(machine)) return remote(machine);
  const token = linkToken();
  const r = (await fetch("/api/machines", { credentials: "same-origin", headers: token ? { "x-friday-link": token } : {} })
    .then((x) => x.json())
    .catch(() => null)) as { machines?: { id: string; connected: boolean; machine?: { name?: string } }[] } | null;
  const there = r?.machines?.find((m) => m.connected && m.machine?.name === machine);
  return there ? remote(there.id) : here;
}
