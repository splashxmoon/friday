import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Friday's own MCP server, handed to every coding tool a runner starts, so the agents in a session can talk to each other
 * (docs/agent-to-agent.md, agent-mesh.ts; Arun, 2026-10-19).
 *
 * Every one of those tools speaks MCP as a client, and stdio is the transport they all take, so the server is a small script
 * the tool starts itself (SHIM below). It knows nothing: each call goes over HTTP to this runner, on 127.0.0.1 and behind a
 * token only this runner's tool is told, and the runner passes it to the Friday server on the connection it already has, as
 * its lane. The tool list, what each tool does and every rule live on the server, so they change with a deploy, not a release.
 */

/** How a tool starts the server: what goes in its MCP config. */
export interface FridayMcp {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface MeshAnswer {
  output?: string;
  isError?: boolean;
  tools?: unknown[];
  instructions?: string;
  /** The answer as MCP content blocks, when it is more than text (preview_screenshot's image). */
  content?: unknown[];
  /** From the server: a page for this runner to capture (agent-mesh.ts's PreviewCapture, screenshot.ts). */
  capture?: { url: string; width: number; height: number; fullPage: boolean };
}

interface Handler {
  /** The tools and the instructions, from the server. */
  tools(): Promise<MeshAnswer>;
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<MeshAnswer>;
}

/**
 * The server a tool starts: newline-delimited JSON-RPC on stdin and stdout, as MCP's stdio transport is, with no dependencies
 * so any Node the machine has runs it (the desktop app's own, with ELECTRON_RUN_AS_NODE, when there is no other). Outside a
 * Friday turn (Cursor's global config names it for every run) FRIDAY_MESH_URL is unset and it offers no tools.
 *
 * The runner sends its answer's headers at once and a space every 30 seconds while an ask waits, because Node's fetch gives up
 * on a response that says nothing for five minutes, and an ask may wait fifteen.
 */
export const SHIM = `// Friday's MCP server for a coding tool in a Friday session. Written by Friday's runner; safe to delete.
import { createInterface } from "node:readline";
const base = process.env.FRIDAY_MESH_URL || "";
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const live = new Map();
async function post(where, body, signal) {
  const r = await fetch(base + where, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  if (!r.ok) throw new Error("Friday answered " + r.status);
  return JSON.parse((await r.text()).trim() || "{}");
}
let listed = null;
async function list() {
  if (!base) return { tools: [] };
  try {
    return (listed ??= await post("/tools", {}, AbortSignal.timeout(20000)));
  } catch {
    listed = null;
    return { tools: [] };
  }
}
const text = (t, isError) => ({ content: [{ type: "text", text: String(t ?? "") }], ...(isError ? { isError: true } : {}) });
createInterface({ input: process.stdin }).on("line", async (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  const { id, method, params } = m || {};
  if (method === "notifications/cancelled") return void live.get(params?.requestId)?.abort();
  if (id === undefined || id === null) return;
  try {
    if (method === "initialize") {
      const l = await list();
      return out({ id, result: { protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "friday", version: "1" }, ...(l.instructions ? { instructions: l.instructions } : {}) } });
    }
    if (method === "ping") return out({ id, result: {} });
    if (method === "tools/list") return out({ id, result: { tools: (await list()).tools || [] } });
    if (method === "tools/call") {
      if (!base) return out({ id, result: text("Friday's tools only work in a Friday session.", true) });
      const stop = new AbortController();
      live.set(id, stop);
      try {
        const r = await post("/call", { name: params?.name, arguments: params?.arguments || {} }, stop.signal);
        // An image (preview_screenshot) comes as content blocks of its own.
        if (Array.isArray(r.content)) return out({ id, result: { content: r.content, ...(r.isError ? { isError: true } : {}) } });
        return out({ id, result: text(r.output, r.isError) });
      } finally {
        live.delete(id);
      }
    }
    out({ id, error: { code: -32601, message: "Friday's server doesn't offer " + method } });
  } catch (e) {
    out({ id, result: text("Friday couldn't be reached: " + (e && e.message), true) });
  }
});
`;

const stateDir = () => process.env.FRIDAY_STATE_DIR || path.join(homedir(), ".friday");
export const shimPath = () => path.join(stateDir(), "friday-mcp.mjs");

/** The script on disk, written when it is missing or this runner's is newer. */
async function ensureShim(): Promise<string> {
  const file = shimPath();
  if ((await readFile(file, "utf8").catch(() => "")) !== SHIM) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, SHIM);
  }
  return file;
}

const handlers = new Map<string, Handler>();
let serving: Promise<number> | null = null;
const MAX_BODY = 1024 * 1024;

/** One loopback server for every runner in this process, each reached under its own token. */
function serve(): Promise<number> {
  serving ??= new Promise<number>((resolve, reject) => {
    const s = http.createServer((req, res) => void answer(req, res));
    s.on("error", (e) => {
      serving = null;
      reject(e);
    });
    s.listen(0, "127.0.0.1", () => {
      s.unref();
      resolve((s.address() as AddressInfo).port);
    });
  });
  return serving;
}

async function answer(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const m = /^\/mesh\/([\w-]{16,})\/(tools|call)$/.exec(req.url ?? "");
  const h = m ? handlers.get(m[1]!) : undefined;
  if (!m || !h || req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) return void res.writeHead(413).end();
  }
  let body: { name?: unknown; arguments?: unknown } = {};
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return void res.writeHead(400).end();
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.flushHeaders();
  const beat = setInterval(() => res.write(" "), 30_000);
  const stop = new AbortController();
  // The tool gave up on the call (its own timeout, or a person stopped it): the server is told, and stops waiting.
  res.on("close", () => {
    if (!res.writableEnded) stop.abort();
  });
  try {
    const args = body.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments) ? (body.arguments as Record<string, unknown>) : {};
    const r = m[2] === "tools" ? await h.tools() : await h.call(typeof body.name === "string" ? body.name : "", args, stop.signal);
    res.end(JSON.stringify(r));
  } catch (e) {
    res.end(JSON.stringify({ output: `Friday couldn't do that: ${(e as Error).message}`, isError: true }));
  } finally {
    clearInterval(beat);
  }
}

/**
 * Open this runner's way in, and say how its tool starts the server. `node` is the Node to run the script with (see
 * nodeForScripts); the desktop app's own binary runs it as Node only when told to.
 */
export async function openFridayMcp(handler: Handler, node: string): Promise<{ spec: FridayMcp; close(): void }> {
  const [port, file] = await Promise.all([serve(), ensureShim()]);
  const token = randomBytes(18).toString("base64url");
  handlers.set(token, handler);
  const asNode: Record<string, string> = process.versions.electron && node === process.execPath ? { ELECTRON_RUN_AS_NODE: "1" } : {};
  return {
    spec: { command: node, args: [file], env: { FRIDAY_MESH_URL: `http://127.0.0.1:${port}/mesh/${token}`, ...asNode } },
    close: () => void handlers.delete(token),
  };
}

// ── how each tool is told about it ──────────────────────────────────

/** Claude Code: `--mcp-config` takes the JSON itself, beside the person's own servers (no --strict-mcp-config). */
export const claudeConfig = (f: FridayMcp) => JSON.stringify({ mcpServers: { friday: { type: "stdio", command: f.command, args: f.args, env: f.env } } });

/** A TOML value from a string, a list or a table of strings: JSON's string escapes are TOML's too. */
const toml = (v: string | string[] | Record<string, string>): string =>
  typeof v === "string" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(", ")}]` : `{${Object.entries(v).map(([k, x]) => `${k} = ${JSON.stringify(x)}`).join(", ")}}`;

/**
 * Codex: `-c` settings before the subcommand, which it applies to every subcommand. Its env given whole, since Codex starts an
 * MCP server with only a few of its own variables. A tool call may wait for another agent's answer, so it is given 16 minutes
 * (an ask waits 15 at most) where Codex's own default is one.
 */
export const codexConfig = (f: FridayMcp): string[] => [
  "-c",
  `mcp_servers.friday.command=${toml(f.command)}`,
  "-c",
  `mcp_servers.friday.args=${toml(f.args)}`,
  "-c",
  `mcp_servers.friday.env=${toml(f.env)}`,
  "-c",
  "mcp_servers.friday.tool_timeout_sec=960",
];

/** An ACP tool: one more server passed with the conversation (`session/new`), as the project's own are (mcp-servers.ts). */
export const acpEntry = (f: FridayMcp) => ({ name: "friday", command: f.command, args: f.args, env: Object.entries(f.env).map(([name, value]) => ({ name, value })) });

/** Amp: its `--mcp-config`, a map of servers by name. */
export const ampConfig = (f: FridayMcp) => JSON.stringify({ friday: { command: f.command, args: f.args, env: f.env } });

/**
 * Cursor's headless agent takes no MCP flag and reads ~/.cursor/mcp.json, so the server is named there, once, without its URL:
 * the script finds that in FRIDAY_MESH_URL, which the runner sets on Cursor's own process and Cursor passes on. Started outside
 * Friday it offers nothing. A file that isn't plain JSON (comments, a typo) is left alone rather than rewritten.
 */
export async function ensureCursorEntry(f: FridayMcp): Promise<void> {
  const file = path.join(homedir(), ".cursor", "mcp.json");
  const text = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? "" : null));
  if (text === null) return;
  let j: { mcpServers?: Record<string, unknown> };
  try {
    j = text.trim() ? JSON.parse(text) : {};
  } catch {
    return;
  }
  const want = { command: f.command, args: f.args, ...(f.env.ELECTRON_RUN_AS_NODE ? { env: { ELECTRON_RUN_AS_NODE: "1" } } : {}) };
  if (JSON.stringify(j.mcpServers?.friday) === JSON.stringify(want)) return;
  j.mcpServers = { ...(j.mcpServers ?? {}), friday: want };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(j, null, 2)}\n`);
}
