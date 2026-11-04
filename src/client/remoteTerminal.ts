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

let conn: { machine: string; ws: WebSocket; open: Promise<void> } | null = null;
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
let reqs = 0;

function socket(machine: string): { ws: WebSocket; open: Promise<void> } {
  if (conn && conn.machine === machine && conn.ws.readyState <= WebSocket.OPEN) return conn;
  conn?.ws.close();
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
    } else if (m.op === "data" && m.id && typeof m.data === "string") for (const f of dataFns) f(m.id, m.data);
    else if (m.op === "exit" && m.id) for (const f of exitFns) f(m.id, m.code ?? 0);
  });
  ws.addEventListener("close", (e) => {
    // Every terminal still waiting to start is told why, rather than spinning; the next start opens a new connection.
    for (const [req, f] of waiting) {
      f({ ok: false, error: e.reason || "The connection to the machine closed." });
      waiting.delete(req);
    }
    // Only the connection in use: one closed because another machine was picked is not a drop.
    if (conn?.ws !== ws) return;
    conn = null;
    if (up) for (const f of dropFns) f();
  });
  conn = { machine, ws, open };
  return conn;
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
      const req = String(++reqs);
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
