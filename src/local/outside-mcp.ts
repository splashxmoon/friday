import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { OUTSIDE_INSTRUCTIONS, OUTSIDE_TOOLS } from "../outside-agents.js";

/**
 * Friday's MCP server for agents outside it (outside-agents.ts): Claude Code, Codex, Cursor and anything else that speaks MCP,
 * on this computer, started by that agent as a stdio server (Arun, 2026-10-30).
 *
 * Like the server Friday hands the agents inside it (runner/friday-mcp.ts SHIM), it is a small script with no dependencies,
 * written beside Friday's data, that any Node runs (the desktop app's own, with ELECTRON_RUN_AS_NODE). It knows the tools, so
 * they list while Friday is closed, and nothing else: each call goes to the Friday running on this folder (running.json), at
 * 127.0.0.1 only, with the token in `outside-token` beside it. That file is this person's alone (0600): another account on the
 * computer can't read it, and a web page can't reach either (app.ts localOnly turns away any page but Friday's own, and the
 * route any request that comes from a page at all). Nothing secret goes into the agent's own config: the script reads the token
 * when it calls, so `claude mcp add` and the rest only ever hold a path.
 */

export const TOKEN_FILE = "outside-token";
export const SHIM_FILE = "outside-mcp.mjs";

/** This install's token, made the first time (as start.ts makes the signing secret), and kept to its owner alone. */
export function outsideToken(home: string): string {
  const file = path.join(home, TOKEN_FILE);
  mkdirSync(home, { recursive: true });
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("base64url"), { mode: 0o600 });
  // A copy put back by hand, or a folder restored, may come with its mode wider than this person: narrowed again.
  if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
  return readFileSync(file, "utf8").trim();
}

/**
 * The script. Its folder is Friday's (the file is written there), so a second Friday on another folder (FRIDAY_HOME) has its own,
 * and the one an agent was given talks to that Friday only. FRIDAY_AGENT_NAME names the agent when its client doesn't say.
 */
export const outsideShim = () => `// Friday's MCP server for agents outside Friday (Claude Code, Codex, Cursor...). Written by Friday; safe to delete, Friday writes it again.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
const home = dirname(fileURLToPath(import.meta.url));
const TOOLS = ${JSON.stringify(OUTSIDE_TOOLS)};
const INSTRUCTIONS = ${JSON.stringify(OUTSIDE_INSTRUCTIONS)};
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const text = (t, isError) => ({ content: [{ type: "text", text: String(t ?? "") }], ...(isError ? { isError: true } : {}) });
const live = new Map();
let agent = process.env.FRIDAY_AGENT_NAME || "";
// Where Friday is now: read each call, since it may have started, stopped or moved port since. Only ever this computer.
function friday() {
  let url = "", token = "";
  try { url = JSON.parse(readFileSync(join(home, "running.json"), "utf8")).url || ""; } catch {}
  try { token = readFileSync(join(home, "${TOKEN_FILE}"), "utf8").trim(); } catch {}
  return /^http:\\/\\/127\\.0\\.0\\.1:\\d+$/.test(url) && token ? { url, token } : null;
}
async function call(name, args, signal) {
  const f = friday();
  if (!f) return text("Friday isn't running on this computer. Open Friday, then try again.", true);
  let r;
  try {
    r = await fetch(f.url + "/api/outside/call", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + f.token }, body: JSON.stringify({ name, arguments: args || {}, agent }), signal });
  } catch (e) {
    if (signal.aborted) throw e;
    return text("Friday isn't answering on this computer. Open Friday, then try again.", true);
  }
  const body = (await r.text()).trim();
  let j = {};
  try { j = JSON.parse(body || "{}"); } catch {}
  if (!r.ok) return text(j.error || j.output || "Friday answered " + r.status, true);
  return text(j.output, j.isError);
}
createInterface({ input: process.stdin }).on("line", async (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  const { id, method, params } = m || {};
  if (method === "notifications/cancelled") return void live.get(params?.requestId)?.abort();
  if (id === undefined || id === null) return;
  try {
    if (method === "initialize") {
      agent ||= params?.clientInfo?.title || params?.clientInfo?.name || "";
      return out({ id, result: { protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "friday", title: "Friday", version: "1" }, instructions: INSTRUCTIONS } });
    }
    if (method === "ping") return out({ id, result: {} });
    if (method === "tools/list") return out({ id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      const stop = new AbortController();
      live.set(id, stop);
      try {
        return out({ id, result: await call(params?.name, params?.arguments, stop.signal) });
      } finally {
        live.delete(id);
      }
    }
    out({ id, error: { code: -32601, message: "Friday's server doesn't offer " + method } });
  } catch (e) {
    out({ id, result: text("Friday couldn't do that: " + (e && e.message), true) });
  }
});
`;

/** The script on disk beside Friday's data, written when it is missing or this Friday's is newer. Its path. */
export function writeOutsideShim(home: string): string {
  const file = path.join(home, SHIM_FILE);
  const want = outsideShim();
  if ((existsSync(file) ? readFileSync(file, "utf8") : "") !== want) {
    mkdirSync(home, { recursive: true });
    writeFileSync(file, want);
  }
  return file;
}

/** How an agent starts the server: a Node and the script. The desktop app is a Node only when told so (ELECTRON_RUN_AS_NODE). */
export interface OutsideCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}
export function outsideCommand(shim: string, exe = process.execPath, electron = !!process.versions.electron): OutsideCommand {
  return { command: exe, args: [shim], env: electron ? { ELECTRON_RUN_AS_NODE: "1" } : {} };
}

/** A word on a command line, quoted when it has to be, for the shell it will be pasted into. */
const shellWord = (s: string, win = process.platform === "win32") => (/^[\w@%+=:,./\\-]+$/.test(s) ? s : win ? `"${s.replace(/"/g, '\\"')}"` : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * What each outside agent is given, to copy, and what Add runs, in a Terminal window of the person's own (runner/terminal.ts):
 * the agent's own `mcp add`, where it has one. Claude Code's is added for this person everywhere (--scope user), not only in
 * the folder the terminal opens in. Codex's file gets a longer call timeout than its one-minute default, since a wait may be
 * long; its `mcp add` can't set that, so wait_for_idle waits 50 seconds unless asked. Cursor has no `mcp add`: its file only.
 */
export function outsideSetup(c: OutsideCommand): { claude: { line: string; argv: string[] }; codex: { line: string; toml: string; argv: string[] }; cursor: { json: string; file: string }; stdio: { line: string } } {
  const envFlags = Object.entries(c.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
  const claude = ["claude", "mcp", "add", "friday", "--scope", "user", ...envFlags, "--", c.command, ...c.args];
  const codex = ["codex", "mcp", "add", "friday", ...envFlags, "--", c.command, ...c.args];
  const toml = [
    "[mcp_servers.friday]",
    `command = ${JSON.stringify(c.command)}`,
    `args = [${c.args.map((a) => JSON.stringify(a)).join(", ")}]`,
    ...(Object.keys(c.env).length ? [`env = { ${Object.entries(c.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", ")} }`] : []),
    "tool_timeout_sec = 660",
  ].join("\n");
  const cursor = JSON.stringify({ mcpServers: { friday: { command: c.command, args: c.args, ...(Object.keys(c.env).length ? { env: c.env } : {}) } } }, null, 2);
  return {
    claude: { line: claude.map((w) => shellWord(w)).join(" "), argv: claude },
    codex: { line: codex.map((w) => shellWord(w)).join(" "), toml, argv: codex },
    cursor: { json: cursor, file: path.join(os.homedir(), ".cursor", "mcp.json") },
    // For any other client: the command, with what it has to be started with said before it.
    stdio: { line: [...Object.entries(c.env).map(([k, v]) => `${k}=${v}`), c.command, ...c.args].map((w) => shellWord(w)).join(" ") },
  };
}

/**
 * `friday mcp`: the server on this terminal's stdin and stdout, for an agent pointed at the command rather than the script. The
 * script is written beside Friday's data (FRIDAY_HOME, else ~/.friday) and run here, so both ways are the same server.
 */
export async function serveOutsideMcp(home = path.resolve(process.env.FRIDAY_HOME || path.join(os.homedir(), ".friday"))): Promise<void> {
  await import(pathToFileURL(writeOutsideShim(home)).href);
}
