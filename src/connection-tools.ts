import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentTool } from "./agent/tools.js";
import { mountedServers, type Mounted } from "./runner/connections.js";

/**
 * The MCP servers set up on this computer (runner/connections.ts), as tools for Friday's own agent too (Arun, 2026-11-17: "like
 * these connections can be used by any of my agents too"). The coding tools get them in their own configs on each turn; Friday's
 * agent speaks MCP itself, here: each server opened when first used, kept open while it's used, closed after five idle minutes.
 * A server that's down is left out of that step's tools rather than holding it up.
 */

interface Tool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

interface Live {
  key: string;
  tools: Tool[];
  fetchedAt: number;
  lastUsed: number;
  call(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<any>;
  close(): void;
}

const PROTOCOL = "2025-06-18";
const CLIENT = { name: "friday", version: "1" };
const IDLE_MS = 5 * 60_000;
const TOOLS_TTL_MS = 5 * 60_000;
const live = new Map<string, Live>();
const opening = new Map<string, Promise<Live>>();
/** A server that failed to open isn't tried again on every step for a minute. */
const failedAt = new Map<string, number>();

const keyOf = (m: Mounted) => JSON.stringify([m.name, m.transport, m.command, m.args, m.env, m.url, m.headers]);

async function openStdio(m: Mounted, key: string): Promise<Live> {
  const child: ChildProcess = spawn(m.command!, m.args ?? [], { env: { ...process.env, ...(m.env ?? {}) }, stdio: ["pipe", "pipe", "ignore"], shell: process.platform === "win32", windowsHide: true });
  let next = 1;
  const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const fail = (e: Error) => {
    for (const w of waiting.values()) w.reject(e);
    waiting.clear();
    if (live.get(key)?.close === close) live.delete(key);
  };
  child.on("error", (e) => fail(new Error(`${m.name} couldn't start: ${e.message}`)));
  child.on("exit", () => fail(new Error(`${m.name} stopped.`)));
  child.stdin!.on("error", () => {});
  createInterface({ input: child.stdout! }).on("line", (line) => {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const w = typeof msg.id === "number" ? waiting.get(msg.id) : undefined;
    if (!w) return;
    waiting.delete(msg.id);
    if (msg.error) w.reject(new Error(String(msg.error.message ?? "It refused.")));
    else w.resolve(msg.result);
  });
  const send = (m2: Record<string, unknown>) => child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", ...m2 })}\n`);
  const call = (method: string, params: Record<string, unknown>, signal?: AbortSignal) =>
    new Promise<any>((resolve, reject) => {
      const id = next++;
      waiting.set(id, { resolve, reject });
      send({ id, method, params });
      const timer = setTimeout(() => (waiting.delete(id), reject(new Error(`${m.name} didn't answer in time.`))), 120_000);
      timer.unref?.();
      signal?.addEventListener("abort", () => (waiting.delete(id), clearTimeout(timer), reject(new Error("Stopped."))), { once: true });
    });
  const close = () => {
    try {
      child.kill();
    } catch {
      /* gone */
    }
  };
  await call("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT });
  send({ method: "notifications/initialized" });
  return { key, tools: [], fetchedAt: 0, lastUsed: Date.now(), call, close };
}

/** A JSON-RPC answer from a Streamable HTTP response: the body, or the event carrying its id. */
async function answerOf(r: Response, id: number): Promise<any> {
  const text = await r.text();
  if (/event-stream/.test(r.headers.get("content-type") ?? "")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      try {
        const msg = JSON.parse(data);
        if (msg.id === id) return msg;
      } catch {
        /* not this one */
      }
    }
    throw new Error("It answered, but not as an MCP server.");
  }
  return JSON.parse(text);
}

async function openHttp(m: Mounted, key: string): Promise<Live> {
  let session = "";
  let next = 1;
  const post = (body: Record<string, unknown>, signal?: AbortSignal) =>
    fetch(m.url!, {
      method: "POST",
      signal: signal ?? AbortSignal.timeout(120_000),
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL, ...(session ? { "mcp-session-id": session } : {}), ...(m.headers ?? {}) },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
    });
  const call = async (method: string, params: Record<string, unknown>, signal?: AbortSignal) => {
    const id = next++;
    const r = await post({ id, method, params }, signal);
    if (!r.ok) {
      if (live.get(key)?.call === call) live.delete(key);
      throw new Error(r.status === 401 || r.status === 403 ? `${m.name} refused its key or sign-in.` : `${m.name} answered ${r.status}.`);
    }
    if (method === "initialize") session = r.headers.get("mcp-session-id") ?? "";
    const msg = await answerOf(r, id);
    if (msg.error) throw new Error(String(msg.error.message ?? "It refused."));
    return msg.result;
  };
  await call("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT });
  await post({ method: "notifications/initialized" }).then((r) => r.body?.cancel().catch(() => {}));
  return { key, tools: [], fetchedAt: 0, lastUsed: Date.now(), call, close: () => {} };
}

async function open(m: Mounted): Promise<Live> {
  const key = keyOf(m);
  const have = live.get(key);
  if (have) return have;
  const p = opening.get(key) ?? (m.transport === "stdio" ? openStdio(m, key) : m.transport === "http" ? openHttp(m, key) : Promise.reject(new Error("The older SSE transport isn't spoken here yet.")));
  opening.set(key, p);
  try {
    const l = await p;
    // Whatever was open for this server under its old settings (a key changed, a token refreshed) is closed.
    for (const [k, other] of live) if (k !== key && JSON.parse(k)[0] === m.name) (other.close(), live.delete(k));
    live.set(key, l);
    return l;
  } finally {
    opening.delete(key);
  }
}

/** Every server Friday's agent has open, closed: at shutdown, and for a test to end. */
export function closeConnectionTools(): void {
  for (const l of live.values()) l.close();
  live.clear();
}

// Idle servers are closed; the timer holds nothing open.
setInterval(() => {
  for (const [k, l] of live) if (Date.now() - l.lastUsed > IDLE_MS) (l.close(), live.delete(k));
}, 60_000).unref?.();

/** What a tool call returned, as text for the agent: its text blocks, and a word for anything else. */
function rendered(r: any): string {
  const parts = (Array.isArray(r?.content) ? r.content : []).map((b: any) => (b?.type === "text" ? String(b.text ?? "") : b?.type === "image" ? "[an image]" : b?.type === "resource" ? String(b.resource?.text ?? `[${b.resource?.uri ?? "a resource"}]`) : ""));
  const text = parts.filter(Boolean).join("\n").trim();
  return text || (r?.structuredContent ? JSON.stringify(r.structuredContent) : "(no output)");
}

/** Every connected server's tools, for one step of Friday's agent: mcp__<server>__<tool>, as the hosted edition names them. */
export async function connectionTools(): Promise<AgentTool[]> {
  const servers = await mountedServers("friday").catch(() => [] as Mounted[]);
  const out: AgentTool[] = [];
  await Promise.all(
    servers.map(async (m) => {
      if (Date.now() - (failedAt.get(m.name) ?? 0) < 60_000) return;
      try {
        const l = await open(m);
        if (Date.now() - l.fetchedAt > TOOLS_TTL_MS) {
          const tools: Tool[] = [];
          let cursor: string | undefined;
          for (let i = 0; i < 10; i++) {
            const r = await l.call("tools/list", cursor ? { cursor } : {});
            tools.push(...(r?.tools ?? []));
            cursor = r?.nextCursor;
            if (!cursor) break;
          }
          l.tools = tools;
          l.fetchedAt = Date.now();
        }
        failedAt.delete(m.name);
        for (const t of l.tools)
          out.push({
            name: `mcp__${m.name}__${t.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
            description: `[${m.name}] ${t.description ?? t.name}`.slice(0, 1024),
            parameters: t.inputSchema ?? { type: "object", properties: {} },
            // Only a tool that says it only reads may be cut off mid-call: anything else runs to the end, so the log says what happened.
            cancellable: t.annotations?.readOnlyHint === true,
            run: async (args, ctx) => {
              const now = await open(m);
              now.lastUsed = Date.now();
              const r = await now.call("tools/call", { name: t.name, arguments: args }, ctx.signal);
              return { output: rendered(r), ...(r?.isError ? { isError: true } : {}) };
            },
          });
      } catch {
        failedAt.set(m.name, Date.now());
      }
    }),
  );
  return out;
}
