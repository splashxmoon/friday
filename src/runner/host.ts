import { Terminals, type TermIn } from "./terminals.js";
import WebSocket from "ws";
import { dialOptions } from "./dial.js";
import { closingSaid, keepAlive } from "../heartbeat.js";
import { ENGINE_NAMES, ENGINE_TOOLS } from "../types.js";
import { ADAPTERS, findBin, forgetLoginStatus, isClaudeAppBundled, loginStatusCached, loginStatusQuick } from "./adapters.js";
import { callHost, machineInfo, type HostContext, type MachineInfo } from "./local-api.js";
import { RunnerError } from "./runner.js";
import type { Runner } from "./runner.js";

/**
 * This machine, linked to a Friday.
 *
 * A hosted Friday can't see anyone's laptop, so the laptop connects to it and
 * stays: it says which coding CLIs it has, then answers questions about repos,
 * GitHub and past sessions, and starts runners when someone begins a coding
 * session. Every answer is computed here, on the machine, by the same code the
 * local server runs about itself.
 *
 * Nothing is executed that Friday didn't ask for through this socket, and the
 * link only exists because its owner ran the command carrying their token.
 */

export interface LinkOptions {
  server: string;
  token: string;
  log?: (line: string) => void;
  /**
   * The runners this machine has started, kept by whoever outlives a single link. A link that drops is replaced by a new
   * LinkHost, and the runners it started keep going: with a map of their own each time, the new link couldn't see them,
   * so Stop answered "no agent of yours is running there" and quitting left them running.
   */
  runners?: Map<string, Runner>;
}

export interface MachineTool {
  tool: (typeof ENGINE_TOOLS)[number];
  name: string;
  path: string | null;
  loggedIn: boolean | null;
  source: "cli" | "claude-app" | null;
  /** Installed, but it can't run on this computer, and why. */
  unavailable?: string;
}

/** Re-scanned on connect and after a sign-in, since that is what changes it. */
export async function scanTools(quick = false): Promise<MachineTool[]> {
  return Promise.all(
    ENGINE_TOOLS.map(async (tool) => {
      const bin = await findBin(tool);
      // Quick: don't hold a first hello back for a slow sign-in check; say
      // "don't know yet" and send the real answer when it arrives.
      const status = bin ? (quick ? loginStatusQuick(tool, bin) : loginStatusCached(tool, bin)) : null;
      return {
        tool,
        name: ENGINE_NAMES[tool],
        path: bin,
        loggedIn: await status,
        source: bin ? ((isClaudeAppBundled(bin) ? "claude-app" : "cli") as "cli" | "claude-app") : null,
        ...(bin && ADAPTERS[tool].unavailable?.() ? { unavailable: ADAPTERS[tool].unavailable!()! } : {}),
      };
    }),
  );
}

/**
 * The quick scan, said as it goes. `found` is every tool with its binary looked up and its sign-in not yet known (null): a
 * PATH lookup, a few milliseconds, so the hello carries the list at once. Each tool's own sign-in check (loginStatusQuick:
 * a process start each, 20 ms for Codex, 150 for Claude Code, 350 for OpenCode here, seconds on Windows) then runs in the
 * background, side by side, and `onChange` hears the whole list again as each one answers. `done` is the list once every
 * check has answered or run out of time. The hello used to wait for the slowest of them, which was most of linking.
 */
export function streamTools(onChange: (tools: MachineTool[]) => void = () => {}): { found: Promise<MachineTool[]>; done: Promise<MachineTool[]> } {
  // A scan that fails is an empty list, never a rejection: connect() waits on it, and a rejection there left it hanging.
  const found = Promise.all(
    ENGINE_TOOLS.map(async (tool): Promise<MachineTool> => {
      const bin = await findBin(tool);
      return {
        tool,
        name: ENGINE_NAMES[tool],
        path: bin,
        loggedIn: null,
        source: bin ? (isClaudeAppBundled(bin) ? "claude-app" : "cli") : null,
        ...(bin && ADAPTERS[tool].unavailable?.() ? { unavailable: ADAPTERS[tool].unavailable!()! } : {}),
      };
    }),
  ).catch(() => [] as MachineTool[]);
  const done = found.then(async (first) => {
    let list = first;
    await Promise.all(
      first.map(async (t, i) => {
        if (!t.path) return;
        const loggedIn = await loginStatusQuick(t.tool, t.path);
        if (loggedIn === null) return;
        list = list.map((x, j) => (j === i ? { ...x, loggedIn } : x));
        onChange(list);
      }),
    );
    return list;
  }).catch(() => [] as MachineTool[]);
  return { found, done };
}

export class LinkHost {
  machine: MachineInfo = machineInfo();
  owner: { id: string; name: string } | null = null;
  closed: Promise<{ code: number; reason: string }>;
  private ws: WebSocket | null = null;
  private readonly runners: Map<string, Runner>;
  /** Shells a browser opened on this machine (terminals.ts). They go with this link. */
  private readonly terms = new Terminals((m) => this.send(m));
  private onClosed!: (v: { code: number; reason: string }) => void;
  private readonly log: (line: string) => void;

  constructor(private opts: LinkOptions) {
    this.log = opts.log ?? (() => {});
    this.runners = opts.runners ?? new Map();
    this.closed = new Promise((r) => (this.onClosed = r));
  }

  /**
   * Connects and resolves once Friday has accepted this machine, with the coding tools found here. Their sign-in checks
   * carry on behind it: `checked` is the list once they have all answered, and Friday is sent each answer as it comes.
   */
  async connect(): Promise<{ owner: { id: string; name: string }; machine: MachineInfo; tools: MachineTool[]; checked: Promise<MachineTool[]> }> {
    // The connection and the scan of this machine's agents run side by side.
    // The scan used to come first, so every start and every reconnect waited
    // several seconds for process checks before even reaching the server.
    let linked = false;
    // The list as last found, and whether Friday has yet to hear it. Nothing goes before "linked": the server only listens
    // for updates once it has accepted the hello, and anything sent earlier would be lost.
    let current: MachineTool[] | null = null;
    let unsent = false;
    const flush = () => {
      if (!linked || !unsent || !current) return;
      unsent = false;
      this.send({ kind: "tools", tools: current });
    };
    const update = (tools: MachineTool[]) => {
      current = tools;
      unsent = true;
      flush();
    };
    const { found, done } = streamTools(update);
    void found.then((tools) => {
      // Found after a hello that couldn't wait for it (below): the list follows on its own.
      if (!current) update(tools);
    });
    // A connection that hangs half-way through opening is given up on, so the link's own retry gets to run.
    const ws = new WebSocket(`${this.opts.server.replace(/^http/, "ws")}/link?token=${encodeURIComponent(this.opts.token)}`, { handshakeTimeout: 15_000, ...dialOptions(this.opts.server) });
    this.ws = ws;

    return new Promise((resolve, reject) => {
      // What the server said as it closed this socket, for when the close itself arrives without it (see closeSaying).
      let said: { code: number; reason: string } | null = null;
      ws.on("open", () => {
        // From this side too. The server pings, but a runner that only ever
        // answers is a runner that finds out its link is dead the next time
        // somebody instructs it — which is the moment it matters most.
        // Why it gave up, for the log line about the drop (a close it causes itself carries no reason: 1006).
        keepAlive(ws, undefined, (why) => (said = { code: 1006, reason: why }));
        // Hello as soon as the tools are found (milliseconds: only their sign-in checks are slow, and those follow), and within
        // two seconds whatever happens: the server waits fifteen for it, and a PATH on a busy or just-woken computer could
        // take longer, which got the link turned away. Whatever the hello couldn't say follows once the server has said yes.
        const soon = new Promise<null>((r) => setTimeout(() => r(null), 2000).unref?.());
        void Promise.race([found, soon]).then(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ kind: "hello", machine: this.machine, tools: current ?? [] }));
          if (current) unsent = false;
        });
      });
      ws.on("message", (raw) => {
        let m: { kind?: string; owner?: { id: string; name: string }; id?: string; method?: string; params?: Record<string, unknown> };
        try {
          m = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (m.kind === "closing") {
          const c = m as { code?: unknown; reason?: unknown };
          if (typeof c.code === "number") said = { code: c.code, reason: typeof c.reason === "string" ? c.reason : "" };
          return;
        }
        if (m.kind === "linked" && m.owner) {
          linked = true;
          this.owner = m.owner;
          const owner = m.owner;
          // Any sign-in answered while the server was deciding.
          flush();
          // Whatever was still being checked when the quick checks ran out of time, said properly once they have.
          const checked = done.then(async (quick) => {
            void scanTools().then((full) => this.send({ kind: "tools", tools: full }));
            return quick;
          });
          void found.then((tools) => resolve({ owner, machine: this.machine, tools: current ?? tools, checked }));
        } else if (m.kind === "call" && typeof m.id === "string" && typeof m.method === "string") {
          void this.answer(m.id, m.method, m.params ?? {});
        } else if (m.kind === "term" && linked) {
          this.terms.handle(m as unknown as TermIn);
        }
      });
      ws.on("close", (rawCode, rawReason) => {
        this.terms.stopAll();
        const { code, reason } = closingSaid(said, rawCode, String(rawReason));
        const why = reason || `connection closed (${code})`;
        this.onClosed({ code, reason: why });
        if (!linked) reject(new RunnerError(why, code));
      });
      ws.on("error", (err) => {
        // -1: the server couldn't be reached, which retrying can fix.
        if (!linked) reject(new RunnerError(`Couldn't reach ${this.opts.server}: ${err.message}`, -1));
      });
    });
  }

  private get context(): HostContext {
    return {
      serverUrl: this.opts.server,
      user: this.owner ?? { id: "", name: "" },
      runners: this.runners,
      log: this.log,
    };
  }

  private async answer(id: string, method: string, params: Record<string, unknown>): Promise<void> {
    try {
      // Progress goes back on the same call, so the server can show the answer as it is written.
      const value = await callHost(method, params, { ...this.context, progress: (v) => this.send({ kind: "progress", id, value: v }) });
      this.send({ kind: "result", id, ok: true, value });
      this.log(`${method} ok`);
      // Signing in is the one thing that changes what this machine offers.
      if (method === "login" || method === "logout" || method === "gh-login" || method === "accounts.add" || method === "accounts.remove") {
        forgetLoginStatus();
        this.send({ kind: "tools", tools: await scanTools() });
      }
    } catch (e) {
      this.send({ kind: "result", id, ok: false, error: (e as Error).message });
      this.log(`${method} failed: ${(e as Error).message}`);
    }
  }

  private send(m: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  /** Unlink this process. Runners already attached to sessions keep going. */
  disconnect(): void {
    this.ws?.close(1000, "Unlinked by its owner");
  }

  /** Stop everything this machine is running, for a clean exit. */
  stopAll(): void {
    for (const r of this.runners.values()) r.stop();
    this.runners.clear();
  }
}
