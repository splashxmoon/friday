import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { AcpMcpServer } from "./mcp-servers.js";
import { builtInApp, providerOf } from "./builtin-apps.js";
import { NO_WRITE, readJson, updateJson } from "../safe-file.js";

/**
 * MCP servers set up once on this computer and handed to every coding tool Friday runs here (Arun, 2026-11-17: "Yes, build it",
 * the parked MCP connections unparked once DuskBot shipped central MCP for local agents; Friday Work HQ product/research
 * mcp-connections-parked.md). Before this each tool had only its own MCP setup, so a server added to Claude Code was missing
 * from Codex and the rest.
 *
 * - Added by pasting what a server's docs say (parseConnection): a URL, a `claude mcp add …` or `add-json` line, an
 *   `npx`/`uvx`/`docker run` command, or an `mcpServers` block. Only values left as `$VARS` or placeholders are asked for.
 * - Tested as it is added (testConnection): the MCP handshake and its list of tools. One that fails is kept, off, with a reason
 *   in plain words; a key refused (401/403) says so.
 * - Kept in their own file, readable by this person only (0600), never sent to a page: the page is told which keys a server
 *   has, not what they are.
 * - Handed to each tool on its next turn the way that tool takes servers (mountFor): Claude Code a private config file, Codex
 *   `-c mcp_servers.*` with its keys in its environment (never on the command line), the ACP tools and Amp in their own.
 * - Optionally, the servers in the person's own Claude Code setup handed to the other tools too: off by default, since one
 *   person's Claude Code can carry hundreds of tools, each described on every call.
 */

export type Transport = "stdio" | "http" | "sse";

export interface Connection {
  id: string;
  name: string;
  enabled: boolean;
  transport: Transport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Its last test: whether it answered, with how many tools, or why not. */
  status?: ConnStatus;
  addedAt: number;
  /** The directory entry it was added from (McpServers.tsx), for its logo and to show it as connected there. */
  catalog?: string;
  /** Signed in to with OAuth (startSignin): its client, where to refresh, and its tokens. */
  oauth?: OAuth;
}

/** A sign-in, kept with its server in the same private file: never sent to a page. */
export interface OAuth {
  clientId: string;
  clientSecret?: string;
  /** How the client proves itself at the token endpoint. */
  authMethod: "none" | "client_secret_post" | "client_secret_basic";
  tokenEndpoint: string;
  /** The server it's for (RFC 8707), sent with each token request. */
  resource: string;
  accessToken: string;
  refreshToken?: string;
  /** When the access token runs out, in ms; unknown when the provider didn't say. */
  expiresAt?: number;
}

export interface ConnStatus {
  ok: boolean;
  at: number;
  tools?: number;
  /** Their names, for the page: what an agent can now do. */
  names?: string[];
  /** Why not, in plain words. */
  error?: string;
  /** auth: a key or sign-in was refused; start: it couldn't start; protocol: it answered, but not as an MCP server. */
  kind?: "auth" | "signin" | "start" | "protocol" | "timeout";
}

/** What the page sees: everything but the values of its keys and its sign-in. */
export interface ConnectionView extends Omit<Connection, "env" | "headers" | "oauth"> {
  envKeys: string[];
  headerKeys: string[];
  /** Signed in with OAuth, rather than given a key. */
  signedIn?: boolean;
}

/** A value to fill in before a pasted server can start: where it goes, its name, and what stays around it ("Bearer "). */
export interface Need {
  where: "env" | "header";
  key: string;
  prefix?: string;
}

export interface Draft {
  name: string;
  transport: Transport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  needs: Need[];
  /** The directory entry it came from. */
  catalog?: string;
}

interface Store {
  servers: Connection[];
  /** Hand the servers in the person's own Claude Code setup to the other tools too. */
  claudeCode?: boolean;
}

const stateDir = () => process.env.FRIDAY_STATE_DIR || path.join(homedir(), ".friday");
const storeFile = () => path.join(stateDir(), "connections.json");

/** Names that are Friday's own, or its tools': refused, so a pasted server can't stand in for them. */
const RESERVED = new Set(["friday", "claude", "codex", "computer", "browser"]);

/** The file as a store, or null when it isn't one (then it is set aside before anything is written: safe-file.ts updateJson). */
const storeShape = (j: unknown): Store | null => {
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const x = j as Partial<Store>;
  return { servers: Array.isArray(x.servers) ? x.servers : [], ...(x.claudeCode ? { claudeCode: true } : {}) };
};

/** For reading. A change goes through updateStore, never a read here written back: one unreadable would be written over as empty. */
export function readStore(): Promise<Store> {
  return readJson(storeFile(), storeShape, () => ({ servers: [] }));
}

/**
 * The store read afresh, changed by `change` (in place; NO_WRITE to leave it) and written whole, one change at a time and under a
 * lock against another Friday on this folder, so a change made meanwhile (a token refreshed by a run) isn't undone. Only this
 * person can read it, as it holds the servers' keys: written before as 0644 by something else, it is made private again.
 */
function updateStore<R>(change: (s: Store) => R | Promise<R>): Promise<R> {
  return updateJson(storeFile(), { shape: storeShape, empty: () => ({ servers: [] }), mode: 0o600, forceMode: true }, change);
}

export function viewOf(c: Connection): ConnectionView {
  const { env, headers, oauth, ...rest } = c;
  return { ...rest, envKeys: Object.keys(env ?? {}), headerKeys: Object.keys(headers ?? {}), ...(oauth ? { signedIn: true } : {}) };
}

// ── Reading what was pasted ─────────────────────────────────────────

/** Words of a command line, as a shell splits them: quotes kept together, backslash-newlines joined. */
export function words(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let any = false;
  const s = line.replace(/\\\r?\n/g, " ");
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      any = true;
    } else if (/\s/.test(c)) {
      if (cur || any) out.push(cur);
      cur = "";
      any = false;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
    } else cur += c;
  }
  if (cur || any) out.push(cur);
  return out;
}

const PLACEHOLDER = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$|YOUR[_\- ]|<[^>]+>|^x{3,}$|REPLACE|CHANGE[_\- ]?ME|\.\.\.$|^(?:sk|ghp|pat)[-_]?\.\.\.|TODO/i;
const isPlaceholder = (v: string) => !v.trim() || PLACEHOLDER.test(v.trim());

/** What must be filled in: empty values and placeholders; "Bearer YOUR_KEY" asks for the key and keeps "Bearer ". */
function needsOf(env: Record<string, string> | undefined, headers: Record<string, string> | undefined): Need[] {
  const out: Need[] = [];
  for (const [key, v] of Object.entries(env ?? {})) if (isPlaceholder(v)) out.push({ where: "env", key });
  for (const [key, v] of Object.entries(headers ?? {})) {
    const m = /^(Bearer|Token|Basic)\s+(.*)$/i.exec(v.trim());
    if (m && isPlaceholder(m[2]!)) out.push({ where: "header", key, prefix: `${m[1]} ` });
    else if (!m && isPlaceholder(v)) out.push({ where: "header", key });
  }
  return out;
}

/** A name for a server from its package, image or host: "@modelcontextprotocol/server-github" → "github". */
export function nameFrom(s: string): string {
  let n = s.trim();
  try {
    if (/^https?:\/\//i.test(n)) {
      const u = new URL(n);
      const parts = u.hostname.split(".").filter((p) => !["www", "mcp", "api", "app", "com", "io", "ai", "dev", "net", "org", "co", "sh", "run"].includes(p));
      n = parts[0] ?? u.hostname;
    }
  } catch {
    /* not a URL */
  }
  n = n.replace(/@[\d^~<>=.x*-]+$/, ""); // a version
  n = n.replace(/:[^/\\]*$/, ""); // a docker tag
  // The last part of a path or package that says something: "/srv/notion/mcp-server.js" → "notion".
  const parts = n.split(/[\\/]/).filter(Boolean).reverse();
  for (const part of parts) {
    const p = part
      .replace(/\.(m?js|cjs|ts|py|sh|exe|cmd|bat)$/i, "")
      .replace(/^(?:mcp[-_]?server[-_]?|server[-_]?|mcp[-_])/i, "")
      .replace(/(?:[-_]mcp[-_]?server|[-_]mcp|[-_]server)$/i, "");
    if (clean(p) && !/^(?:mcp|server|index|main|dist|build|src|bin|lib)$/i.test(p)) return clean(p);
  }
  return "server";
}

const clean = (n: string) =>
  n
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

/** The package a launcher runs: the first word after its own flags ("npx -y @x/y" → "@x/y"). */
function packageOf(argv: string[]): string {
  const [cmd, ...rest] = argv;
  const base = path.basename(cmd ?? "").replace(/\.(cmd|exe)$/i, "");
  if (base === "docker") {
    // docker run [flags…] image [args…]: flags that take a value skip it.
    const takes = new Set(["-e", "--env", "-v", "--volume", "--name", "-p", "--network", "--env-file", "-w", "--workdir", "--entrypoint", "-u", "--user", "--platform"]);
    for (let i = rest[0] === "run" ? 1 : 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (takes.has(a)) i++;
      else if (!a.startsWith("-")) return a;
    }
    return "docker";
  }
  const skipVal = new Set(["--from", "--with", "-p", "--package", "--python"]);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (skipVal.has(a)) i++;
    else if (a === "run" && (base === "uv" || base === "pnpm" || base === "deno")) continue;
    else if (a === "dlx" || a === "x") continue;
    else if (!a.startsWith("-")) return a;
  }
  return base;
}

function fromJsonServer(name: string, s: Record<string, any>): Draft | null {
  if (typeof s.url === "string" && s.url.trim()) {
    const headers = strMap(s.headers);
    const transport: Transport = s.type === "sse" || s.transport === "sse" ? "sse" : "http";
    return { name: clean(name) || nameFrom(s.url), transport, url: s.url.trim(), ...(headers ? { headers } : {}), needs: needsOf(undefined, headers) };
  }
  if (typeof s.command === "string" && s.command.trim()) {
    const env = strMap(s.env);
    const args = Array.isArray(s.args) ? s.args.map(String) : [];
    return { name: clean(name) || nameFrom(packageOf([s.command, ...args])), transport: "stdio", command: s.command.trim(), args, ...(env ? { env } : {}), needs: needsOf(env, undefined) };
  }
  return null;
}

const strMap = (o: unknown): Record<string, string> | undefined =>
  o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length ? Object.fromEntries(Object.entries(o as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")])) : undefined;

/**
 * What was pasted, as servers to add. Throws, in plain words, when it isn't one of: a URL; a `claude mcp add …` or
 * `claude mcp add-json …` line; a `codex mcp add …` line; a command that starts one (npx, uvx, docker run, node, python…); a
 * JSON block (an `mcpServers` map, a map of servers by name, or one server).
 */
export function parseConnection(text: string): Draft[] {
  const t = text.trim().replace(/^\$\s+/, "");
  if (!t) throw new Error("Paste a server's address, command or JSON.");
  if (/^https?:\/\/\S+$/i.test(t)) return [{ name: nameFrom(t), transport: /\/sse\/?(\?|$)/i.test(t) ? "sse" : "http", url: t, needs: [] }];
  if (t.startsWith("{")) {
    let j: Record<string, any>;
    try {
      j = JSON.parse(t);
    } catch {
      throw new Error("That looks like JSON, but it doesn't read as JSON. Check its brackets and commas.");
    }
    const map = j.mcpServers && typeof j.mcpServers === "object" ? j.mcpServers : j.servers && typeof j.servers === "object" ? j.servers : j.command || j.url ? { "": j } : j;
    const out = Object.entries(map as Record<string, any>).flatMap(([n, s]) => (s && typeof s === "object" ? [fromJsonServer(n, s)].filter((d): d is Draft => !!d) : []));
    if (!out.length) throw new Error("No server in that JSON: each needs a \"command\" or a \"url\".");
    return out;
  }
  let w = words(t);
  // KEY=value before the command, as a shell takes them.
  const lead: Record<string, string> = {};
  while (w[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) {
    const [k, ...v] = w.shift()!.split("=");
    lead[k!] = v.join("=");
  }
  if ((w[0] === "claude" || w[0] === "codex") && w[1] === "mcp") {
    const tool = w[0];
    const sub = w[2];
    w = w.slice(3);
    if (tool === "claude" && sub === "add-json") {
      const rest = w.filter((x, i) => !(x.startsWith("-") || (i > 0 && /^-(s|-scope)$/.test(w[i - 1]!))));
      const [name, json] = rest;
      if (!name || !json) throw new Error("`claude mcp add-json` needs a name and the server's JSON.");
      let s: Record<string, any>;
      try {
        s = JSON.parse(json);
      } catch {
        throw new Error("The JSON in that line doesn't read as JSON.");
      }
      const d = fromJsonServer(name, s);
      if (!d) throw new Error("That JSON has no \"command\" or \"url\".");
      return [d];
    }
    if (sub !== "add") throw new Error(`Only \`${tool} mcp add\` lines can be pasted here.`);
    let transport: Transport | null = null;
    const env: Record<string, string> = { ...lead };
    const headers: Record<string, string> = {};
    const pos: string[] = [];
    let after: string[] | null = null;
    for (let i = 0; i < w.length; i++) {
      const a = w[i]!;
      if (a === "--") {
        after = w.slice(i + 1);
        break;
      }
      if (a === "-t" || a === "--transport") transport = (w[++i] as Transport) ?? null;
      else if (a.startsWith("--transport=")) transport = a.slice(12) as Transport;
      else if (a === "-e" || a === "--env") {
        const [k, ...v] = (w[++i] ?? "").split("=");
        if (k) env[k] = v.join("=");
      } else if (a === "-H" || a === "--header") {
        const h = w[++i] ?? "";
        const c = h.indexOf(":");
        if (c > 0) headers[h.slice(0, c).trim()] = h.slice(c + 1).trim();
      } else if (a === "-s" || a === "--scope" || a === "--client-id" || a === "--callback-port") i++;
      else if (a.startsWith("-")) continue;
      else pos.push(a);
    }
    const name = pos[0];
    if (!name) throw new Error("That line has no server name.");
    const target = after ?? pos.slice(1);
    if (!target.length) throw new Error("That line has no command or address after the server's name.");
    if (/^https?:\/\//i.test(target[0]!) && transport !== "stdio") {
      const h = Object.keys(headers).length ? headers : undefined;
      return [{ name: clean(name) || nameFrom(target[0]!), transport: transport === "sse" ? "sse" : "http", url: target[0]!, ...(h ? { headers: h } : {}), needs: needsOf(undefined, h) }];
    }
    const e = Object.keys(env).length ? env : undefined;
    return [{ name: clean(name) || nameFrom(packageOf(target)), transport: "stdio", command: target[0]!, args: target.slice(1), ...(e ? { env: e } : {}), needs: needsOf(e, undefined) }];
  }
  // A command that starts a server. docker's `-e NAME` (no value) passes NAME from the environment: it is asked for.
  if (!w.length) throw new Error("Paste a server's address, command or JSON.");
  const env: Record<string, string> = { ...lead };
  if (path.basename(w[0]!) === "docker") {
    for (let i = 1; i < w.length; i++) {
      if ((w[i] === "-e" || w[i] === "--env") && w[i + 1]) {
        const [k, ...v] = w[i + 1]!.split("=");
        if (k) env[k] = v.length ? v.join("=") : (env[k] ?? "");
      }
    }
  }
  const first = w[0]!;
  const LAUNCHERS = /^(npx|npm|pnpm|pnpx|yarn|bunx|bun|uvx|uv|pipx|python3?|py|node|deno|docker|podman|java|go|cargo|dotnet|ruby|php)(\.exe|\.cmd)?$/i;
  const looksLike = LAUNCHERS.test(path.basename(first)) || /[\\/]/.test(first) || /\.(js|mjs|cjs|py|sh|exe|cmd|bat)$/i.test(first) || /mcp/i.test(first);
  if (!looksLike || !/^[\w./\\:@~-]+$/.test(first)) throw new Error("That isn't an address, a command or JSON Friday can read.");
  const e = Object.keys(env).length ? env : undefined;
  return [{ name: nameFrom(packageOf(w)), transport: "stdio", command: w[0]!, args: w.slice(1), ...(e ? { env: e } : {}), needs: needsOf(e, undefined) }];
}

/** The draft with what was asked for filled in. */
export function fillDraft(d: Draft, values: Record<string, string>): Draft {
  const env = d.env ? { ...d.env } : undefined;
  const headers = d.headers ? { ...d.headers } : undefined;
  for (const n of d.needs) {
    const v = values[`${n.where}:${n.key}`];
    if (v === undefined) continue;
    if (n.where === "env" && env) env[n.key] = v;
    if (n.where === "header" && headers) headers[n.key] = `${n.prefix ?? ""}${v}`;
  }
  return { ...d, ...(env ? { env } : {}), ...(headers ? { headers } : {}), needs: needsOf(env, headers) };
}

// ── Testing ─────────────────────────────────────────────────────────

const CLIENT = { name: "friday", version: "1" };
const PROTOCOL = "2025-06-18";

/** One server's handshake and tool list, or why not. Commands are stopped once they've answered, or after `ms`. */
export async function testConnection(c: Pick<Connection, "transport" | "command" | "args" | "env" | "url" | "headers">, ms = 30_000): Promise<ConnStatus> {
  const at = Date.now();
  try {
    const tools = c.transport === "stdio" ? await testStdio(c, ms) : c.transport === "sse" ? await testSse(c, Math.min(ms, 20_000)) : await testHttp(c, Math.min(ms, 20_000));
    return { ok: true, at, tools: tools.length, names: tools.slice(0, 200) };
  } catch (e) {
    const f = e as ConnError;
    return { ok: false, at, error: f.plain ?? "It didn't answer as an MCP server.", kind: f.kind ?? "protocol" };
  }
}

/** Nothing at an address: on this computer, start it; elsewhere, check it and the connection. */
const nothingAt = (url: string) => (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url) ? "Nothing answers at that address on this computer: start it first." : "Nothing answers at that address: check it, and that this computer is online.");

class ConnError extends Error {
  constructor(
    readonly plain: string,
    readonly kind: ConnStatus["kind"],
  ) {
    super(plain);
  }
}

function testStdio(c: Pick<Connection, "command" | "args" | "env">, ms: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const win = process.platform === "win32";
    let child;
    try {
      // npx, uvx and the like are .cmd files on Windows, which only a shell starts.
      child = spawn(c.command!, c.args ?? [], { env: { ...process.env, ...(c.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"], shell: win, windowsHide: true });
    } catch {
      return reject(new ConnError(`${c.command} couldn't be started.`, "start"));
    }
    let buf = "";
    let done = false;
    const tools: string[] = [];
    const finish = (err: ConnError | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* gone already */
      }
      if (err) reject(err);
      else resolve(tools);
    };
    const timer = setTimeout(() => finish(new ConnError(`It didn't answer within ${Math.round(ms / 1000)} seconds.`, "timeout")), ms);
    const send = (m: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
    child.on("error", (e: NodeJS.ErrnoException) => finish(new ConnError(e.code === "ENOENT" ? `${path.basename(c.command!)} isn't installed on this computer.` : `${c.command} couldn't be started.`, "start")));
    child.on("exit", () => finish(new ConnError("It stopped before it answered: check its command, and any key it needs.", "start")));
    child.stdin.on("error", () => {});
    // Its own messages (stderr) never reach the page: they can carry its keys.
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("{")) continue;
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1) {
          if (m.error) return finish(new ConnError(`It refused to start a session: ${String(m.error.message ?? "no reason given").slice(0, 160)}`, "protocol"));
          send({ method: "notifications/initialized" });
          send({ id: 2, method: "tools/list", params: {} });
        } else if (typeof m.id === "number" && m.id >= 2) {
          if (m.error) return finish(new ConnError(`It wouldn't list its tools: ${String(m.error.message ?? "no reason given").slice(0, 160)}`, "protocol"));
          for (const t of m.result?.tools ?? []) if (t?.name) tools.push(String(t.name));
          const next = m.result?.nextCursor;
          if (next && m.id < 12) send({ id: m.id + 1, method: "tools/list", params: { cursor: next } });
          else finish(null);
        }
      }
    });
    send({ id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT } });
  });
}

/** A refused request, said for what it is. A 401 that points at its sign-in (RFC 9728) is a sign-in, not a wrong key. */
function refused(r: Response): ConnError {
  const www = r.headers.get("www-authenticate") ?? "";
  if (r.status === 401 && /resource_metadata|Bearer/i.test(www) && /resource_metadata/i.test(www)) return new ConnError("It needs you to sign in to it. Friday can't sign in to a server for you yet: add a key it takes instead, if it offers one.", "signin");
  if (r.status === 401 || r.status === 403) return new ConnError(r.status === 401 ? "It refused the key: it's missing or wrong." : "It refused the key: it doesn't allow this.", "auth");
  if (r.status === 404) return new ConnError("Nothing answers at that address (404).", "protocol");
  return new ConnError(`It answered ${r.status}${r.statusText ? ` ${r.statusText}` : ""}.`, "protocol");
}

/** A JSON-RPC answer from a Streamable HTTP response: the body, or the event with its id. */
async function rpcAnswer(r: Response, id: number): Promise<any> {
  const type = r.headers.get("content-type") ?? "";
  const text = await r.text();
  if (/event-stream/.test(type)) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      if (!data) continue;
      try {
        const m = JSON.parse(data);
        if (m.id === id) return m;
      } catch {
        /* not JSON */
      }
    }
    throw new ConnError("It answered, but not as an MCP server.", "protocol");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ConnError("It answered, but not as an MCP server.", "protocol");
  }
}

async function testHttp(c: Pick<Connection, "url" | "headers">, ms: number): Promise<string[]> {
  const signal = AbortSignal.timeout(ms);
  let session = "";
  const post = async (body: Record<string, unknown>) => {
    let r: Response;
    try {
      r = await fetch(c.url!, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL, ...(session ? { "mcp-session-id": session } : {}), ...(c.headers ?? {}) },
        body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      });
    } catch (e) {
      throw (e as Error).name === "TimeoutError" ? new ConnError(`It didn't answer within ${Math.round(ms / 1000)} seconds.`, "timeout") : new ConnError(nothingAt(c.url!), "start");
    }
    return r;
  };
  const init = await post({ id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT } });
  if (!init.ok) throw refused(init);
  session = init.headers.get("mcp-session-id") ?? "";
  const hello = await rpcAnswer(init, 1);
  if (hello.error) throw new ConnError(`It refused to start a session: ${String(hello.error.message ?? "").slice(0, 160)}`, "protocol");
  await post({ method: "notifications/initialized" }).then((r) => r.body?.cancel().catch(() => {}));
  const tools: string[] = [];
  let cursor: string | undefined;
  for (let id = 2; id < 12; id++) {
    const r = await post({ id, method: "tools/list", params: cursor ? { cursor } : {} });
    if (!r.ok) throw refused(r);
    const m = await rpcAnswer(r, id);
    if (m.error) throw new ConnError(`It wouldn't list its tools: ${String(m.error.message ?? "").slice(0, 160)}`, "protocol");
    for (const t of m.result?.tools ?? []) if (t?.name) tools.push(String(t.name));
    cursor = m.result?.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

/** The older SSE transport: a stream that names where to post, and answers on the stream. */
async function testSse(c: Pick<Connection, "url" | "headers">, ms: number): Promise<string[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    let r: Response;
    try {
      r = await fetch(c.url!, { headers: { accept: "text/event-stream", ...(c.headers ?? {}) }, signal: ctl.signal });
    } catch {
      throw new ConnError(nothingAt(c.url!), "start");
    }
    if (!r.ok || !r.body) throw refused(r);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const events = async function* () {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
          const ev = /^event:\s*(.*)$/m.exec(block)?.[1]?.trim() ?? "message";
          const data = block
            .split(/\r?\n/)
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("\n");
          yield { ev, data };
        }
      }
    };
    const it = events();
    // Read one event at a time: leaving a for-await loop early would close the stream the answers come on.
    let endpoint = "";
    for (let e = await it.next(); !e.done; e = await it.next()) {
      if (e.value.ev === "endpoint") {
        endpoint = new URL(e.value.data, c.url!).toString();
        break;
      }
    }
    if (!endpoint) throw new ConnError("It answered, but not as an MCP server.", "protocol");
    const post = (body: Record<string, unknown>) => fetch(endpoint, { method: "POST", signal: ctl.signal, headers: { "content-type": "application/json", ...(c.headers ?? {}) }, body: JSON.stringify({ jsonrpc: "2.0", ...body }) });
    const wait = async (id: number) => {
      for (let e = await it.next(); !e.done; e = await it.next()) {
        try {
          const m = JSON.parse(e.value.data);
          if (m.id === id) return m;
        } catch {
          /* not JSON */
        }
      }
      throw new ConnError("It stopped before it answered.", "protocol");
    };
    const p1 = await post({ id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT } });
    if (!p1.ok) throw refused(p1);
    const hello = await wait(1);
    if (hello.error) throw new ConnError(`It refused to start a session: ${String(hello.error.message ?? "").slice(0, 160)}`, "protocol");
    await post({ method: "notifications/initialized" });
    await post({ id: 2, method: "tools/list", params: {} });
    const m = await wait(2);
    return (m.result?.tools ?? []).filter((t: any) => t?.name).map((t: any) => String(t.name));
  } catch (e) {
    if (ctl.signal.aborted && !(e instanceof ConnError)) throw new ConnError(`It didn't answer within ${Math.round(ms / 1000)} seconds.`, "timeout");
    throw e;
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
}

// ── Keeping them ────────────────────────────────────────────────────

/** A name of its own: cleaned, never one of Friday's, never one already here. */
function freeName(want: string, taken: string[]): string {
  let n = clean(want) || "server";
  if (RESERVED.has(n)) n = `${n}-mcp`;
  let out = n;
  for (let i = 2; taken.includes(out); i++) out = `${n}-${i}`;
  return out;
}

/** Added and tested: on when it answered, kept off with its reason when not. */
export async function addConnection(d: Draft, test = testConnection): Promise<Connection> {
  if (d.needs.length) throw new Error(`Fill in ${d.needs.map((n) => n.key).join(", ")} first.`);
  const s = await readStore();
  const c: Connection = {
    id: randomBytes(6).toString("hex"),
    name: freeName(d.name, s.servers.map((x) => x.name)),
    enabled: false,
    transport: d.transport,
    ...(d.command ? { command: d.command, args: d.args ?? [] } : {}),
    ...(d.env ? { env: d.env } : {}),
    ...(d.url ? { url: d.url } : {}),
    ...(d.headers ? { headers: d.headers } : {}),
    ...(d.catalog ? { catalog: d.catalog } : {}),
    addedAt: Date.now(),
  };
  c.status = await test(c);
  c.enabled = c.status.ok;
  await updateStore((now) => {
    // Named again against the store as it is now: another server added meanwhile may have taken the name.
    c.name = freeName(d.name, now.servers.map((x) => x.name));
    now.servers.push(c);
  });
  return c;
}

export async function retestConnection(id: string, test = testConnection): Promise<Connection> {
  const s = await readStore();
  const c = s.servers.find((x) => x.id === id);
  if (!c) throw new Error("There's no such server.");
  const status = await test({ ...c, headers: await authHeaders(c) });
  return updateStore((now) => {
    const x = now.servers.find((y) => y.id === id);
    if (!x) throw new Error("There's no such server.");
    x.status = status;
    return x;
  });
}

/** Turned on or off, renamed, or given new values for its keys (a value left empty keeps the one it has). */
export function updateConnection(id: string, p: { enabled?: boolean; name?: string; env?: Record<string, string>; headers?: Record<string, string> }): Promise<Connection> {
  return updateStore((s) => {
    const c = s.servers.find((x) => x.id === id);
    if (!c) throw new Error("There's no such server.");
    if (p.enabled !== undefined) c.enabled = p.enabled;
    if (p.name && clean(p.name) !== c.name) c.name = freeName(p.name, s.servers.filter((x) => x.id !== id).map((x) => x.name));
    for (const [k, v] of Object.entries(p.env ?? {})) if (v && c.env && k in c.env) c.env[k] = v;
    for (const [k, v] of Object.entries(p.headers ?? {})) if (v && c.headers && k in c.headers) c.headers[k] = /^(Bearer|Token|Basic)\s/i.test(v) ? v : (/^(Bearer|Token|Basic)\s/i.exec(c.headers[k]!)?.[0] ?? "") + v;
    return c;
  });
}

export async function removeConnection(id: string): Promise<void> {
  await updateStore((s) => void (s.servers = s.servers.filter((x) => x.id !== id)));
}

export async function setClaudeCodeShared(on: boolean): Promise<void> {
  await updateStore((s) => {
    if (on) s.claudeCode = true;
    else delete s.claudeCode;
  });
}

/** The servers in the person's own Claude Code setup (~/.claude.json's own), by name: what the switch would hand on. Friday's own is never one. */
export async function claudeCodeServers(): Promise<Record<string, Record<string, any>>> {
  const j = await readFile(path.join(homedir(), ".claude.json"), "utf8")
    .then((t) => JSON.parse(t) as { mcpServers?: Record<string, any> })
    .catch(() => null);
  const all = j?.mcpServers && typeof j.mcpServers === "object" ? j.mcpServers : {};
  return Object.fromEntries(Object.entries(all).filter(([n]) => !RESERVED.has(clean(n))));
}

// ── Handing them to a tool ──────────────────────────────────────────

/** A server as each tool's config names it, its values filled in. */
export interface Mounted {
  name: string;
  transport: Transport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/**
 * What a turn's tool gets: every server that is on, and, when the switch is on, Claude Code's own for the tools that aren't
 * Claude Code (which has them already). A name Friday keeps for itself is never handed on.
 */
export async function mountedServers(forTool: string): Promise<Mounted[]> {
  const s = await readStore();
  const out: Mounted[] = [];
  for (const c of s.servers.filter((x) => x.enabled && !RESERVED.has(x.name))) {
    const headers = await authHeaders(c).catch(() => c.headers);
    out.push({ name: c.name, transport: c.transport, ...(c.command ? { command: c.command, args: c.args ?? [] } : {}), ...(c.env ? { env: c.env } : {}), ...(c.url ? { url: c.url } : {}), ...(headers && Object.keys(headers).length ? { headers } : {}) });
  }
  if (s.claudeCode && forTool !== "claude") {
    const taken = new Set(out.map((m) => m.name));
    for (const [n, raw] of Object.entries(await claudeCodeServers())) {
      const d = raw && typeof raw === "object" ? fromJsonServer(n, raw) : null;
      if (!d || taken.has(d.name) || RESERVED.has(d.name) || d.needs.length) continue;
      taken.add(d.name);
      out.push({ name: d.name, transport: d.transport, ...(d.command ? { command: d.command, args: d.args ?? [] } : {}), ...(d.env ? { env: d.env } : {}), ...(d.url ? { url: d.url } : {}), ...(d.headers ? { headers: d.headers } : {}) });
    }
  }
  return out;
}

/** Claude Code: its --mcp-config, written to a file only this person can read, as it carries the servers' keys. */
export async function claudeMountFile(servers: Mounted[], key: string): Promise<string | null> {
  if (!servers.length) return null;
  const dir = path.join(stateDir(), "run");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `mcp-${key.replace(/[^\w-]/g, "_")}.json`);
  const mcpServers = Object.fromEntries(servers.map((m) => [m.name, m.transport === "stdio" ? { type: "stdio", command: m.command, args: m.args ?? [], env: m.env ?? {} } : { type: m.transport, url: m.url, headers: m.headers ?? {} }]));
  await writeFile(file, JSON.stringify({ mcpServers }), { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
  return file;
}

const toml = (v: string | string[] | Record<string, string>): string =>
  typeof v === "string" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(", ")}]` : `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)} = ${JSON.stringify(x)}`).join(", ")}}`;

/** An environment variable's name for one of a server's keys, for Codex to read it from (FRIDAY_MCP_<SERVER>_<KEY>). */
const envName = (server: string, key: string) => `FRIDAY_MCP_${`${server}_${key}`.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;

/**
 * Codex: `-c mcp_servers.<name>.*` before the subcommand, with every key in Codex's own environment, named on the command line
 * only (env_vars, env_http_headers), so no key is on it. The older SSE transport Codex doesn't take is left out.
 */
export function codexMount(servers: Mounted[]): { args: string[]; env: Record<string, string> } {
  const args: string[] = [];
  const env: Record<string, string> = {};
  for (const m of servers) {
    // Names are kept to a-z, 0-9, - and _ (clean), plain TOML keys: Codex splits a -c path on its dots.
    const k = `mcp_servers.${m.name}`;
    if (m.transport === "stdio") {
      args.push("-c", `${k}.command=${toml(m.command!)}`, "-c", `${k}.args=${toml(m.args ?? [])}`);
      const names = Object.keys(m.env ?? {});
      // Its env as Codex passes it on: the variable a server reads, set on Codex to the value kept here.
      for (const n of names) env[n] = m.env![n]!;
      if (names.length) args.push("-c", `${k}.env_vars=${toml(names)}`);
      args.push("-c", `${k}.startup_timeout_sec=60`);
    } else if (m.transport === "http") {
      args.push("-c", `${k}.url=${toml(m.url!)}`);
      const hv: Record<string, string> = {};
      for (const [h, v] of Object.entries(m.headers ?? {})) {
        const n = envName(m.name, h);
        env[n] = v;
        hv[h] = n;
      }
      if (Object.keys(hv).length) args.push("-c", `${k}.env_http_headers=${toml(hv)}`);
    }
  }
  return { args, env };
}

/** An ACP tool: the servers with the conversation, as the project's own are (mcp-servers.ts). */
export const acpMount = (servers: Mounted[]): AcpMcpServer[] =>
  servers.map((m) =>
    m.transport === "stdio"
      ? { name: m.name, command: m.command!, args: m.args ?? [], env: Object.entries(m.env ?? {}).map(([name, value]) => ({ name, value })) }
      : { type: m.transport as "http" | "sse", name: m.name, url: m.url!, headers: Object.entries(m.headers ?? {}).map(([name, value]) => ({ name, value })) },
  );

// ── Signing in (OAuth) ──────────────────────────────────────────────

/**
 * Signing in to a remote server, as the MCP spec has it: its protected-resource metadata (RFC 9728) names its authorization
 * server; that server's metadata (RFC 8414) names where to sign in and get tokens; Friday registers itself there (RFC 7591), or
 * uses an app the person registered when the provider doesn't allow that; the sign-in runs in the person's browser with PKCE
 * (S256) and comes back to this computer's Friday, which swaps the code for tokens and keeps them with the server, in the
 * private file. A token about to run out is refreshed before a turn hands it on (authHeaders).
 */

interface Pending {
  verifier: string;
  redirect: string;
  url: string;
  name: string;
  catalog?: string;
  id?: string;
  clientId: string;
  clientSecret?: string;
  authMethod: OAuth["authMethod"];
  tokenEndpoint: string;
  resource: string;
  at: number;
}
/** Sign-ins started and not yet back, by their `state`: ten minutes each, used once. */
const pending = new Map<string, Pending>();
const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function getJson(url: string): Promise<Record<string, any> | null> {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    return r.ok ? ((await r.json()) as Record<string, any>) : null;
  } catch {
    return null;
  }
}

/** Sign-in servers whose app takes this computer's address only at /callback (app.ts serves it there too). */
const CALLBACK_AT_ROOT = new Set(["oauth2.service.newrelic.com"]);
const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
};

/** Where to sign in for a server: its resource metadata, from its 401 or the well-known place, then its authorization server's. */
async function discover(url: string): Promise<{ as: Record<string, any>; resource: string; scopes?: string[] }> {
  const u = new URL(url);
  let prmUrl = "";
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT } }), signal: AbortSignal.timeout(10_000) });
    prmUrl = /resource_metadata="([^"]+)"/.exec(r.headers.get("www-authenticate") ?? "")?.[1] ?? "";
    await r.body?.cancel().catch(() => {});
  } catch {
    /* asked below */
  }
  const prm = (prmUrl ? await getJson(prmUrl) : null) ?? (await getJson(`${u.origin}/.well-known/oauth-protected-resource${u.pathname.replace(/\/$/, "")}`)) ?? (await getJson(`${u.origin}/.well-known/oauth-protected-resource`));
  const asUrl = (prm?.authorization_servers as string[] | undefined)?.[0] ?? u.origin;
  const a = new URL(asUrl);
  const path_ = a.pathname.replace(/\/$/, "");
  const as =
    (await getJson(`${a.origin}/.well-known/oauth-authorization-server${path_}`)) ??
    (await getJson(`${a.origin}/.well-known/openid-configuration${path_}`)) ??
    (await getJson(`${asUrl.replace(/\/$/, "")}/.well-known/oauth-authorization-server`)) ??
    (await getJson(`${asUrl.replace(/\/$/, "")}/.well-known/openid-configuration`));
  if (!as?.authorization_endpoint || !as?.token_endpoint) throw new Error("It doesn't say where to sign in to it. Paste its key instead, if it offers one.");
  // The resource named (RFC 8707) only when its own metadata names this very address: Cloudflare's servers publish none and refuse
  // their address as one, and Semgrep's names its root, which its sign-in then refuses ("invalid_target"). Left out, the sign-in
  // is for the server the authorization server serves, as before the parameter.
  const same = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
  const resource = typeof prm?.resource === "string" && same(prm.resource, url) ? prm.resource : "";
  return { as, resource, ...(Array.isArray(prm?.scopes_supported) ? { scopes: prm.scopes_supported.map(String) } : {}) };
}

/**
 * A sign-in started: where to send the person's browser. `client`: an app the person registered with a provider that won't let
 * Friday register itself. `id`: a server already here, signed in to again.
 */
export async function startSignin(o: { url: string; name: string; catalog?: string; id?: string; redirect: string; client?: { id: string; secret?: string } }): Promise<{ authorizeUrl: string }> {
  const { as, resource, scopes } = await discover(o.url);
  // New Relic hands every app one shared client, which takes a loopback address only at /callback.
  const redirect = CALLBACK_AT_ROOT.has(hostOf(String(as.authorization_endpoint))) ? o.redirect.replace(/\/api\/mcp\/signed-in$/, "/callback") : o.redirect;
  // An app of the person's own when they gave one; else Friday's own with a provider that won't let one register itself.
  const builtIn = !o.client?.id?.trim() && !as.registration_endpoint ? builtInApp(providerOf(o.url)) : null;
  let clientId = o.client?.id?.trim() || builtIn?.id || "";
  let clientSecret = o.client?.secret?.trim() || builtIn?.secret || undefined;
  let authMethod: OAuth["authMethod"] = clientSecret ? (((as.token_endpoint_auth_methods_supported as string[] | undefined) ?? []).includes("client_secret_post") ? "client_secret_post" : "client_secret_basic") : "none";
  if (!clientId) {
    if (!as.registration_endpoint) throw Object.assign(new Error("It doesn't let apps register themselves: it needs an app of your own."), { needsClient: true });
    const r = await fetch(as.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_name: "Friday", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    const j = r ? ((await r.json().catch(() => null)) as Record<string, any> | null) : null;
    if (!r?.ok || !j?.client_id) {
      // Its own reason, when it gives one: Calendly's "must start with https" says why Friday on this computer can't sign in there.
      const why = String(j?.error_description ?? Object.values((j?.errors as Record<string, unknown>) ?? {}).flat()[0] ?? "").slice(0, 160);
      throw new Error(/https/i.test(why) ? "It only signs in apps at an https address, and Friday on this computer isn't one, so it can't be signed in to from here." : `It wouldn't register Friday to sign in${why ? `: ${why}` : r ? ` (${r.status})` : ""}.`);
    }
    clientId = String(j.client_id);
    if (j.client_secret) {
      clientSecret = String(j.client_secret);
      authMethod = j.token_endpoint_auth_method === "client_secret_basic" ? "client_secret_basic" : "client_secret_post";
    }
  }
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(24));
  for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60_000) pending.delete(k);
  pending.set(state, { verifier, redirect, url: o.url, name: o.name, ...(o.catalog ? { catalog: o.catalog } : {}), ...(o.id ? { id: o.id } : {}), clientId, ...(clientSecret ? { clientSecret } : {}), authMethod, tokenEndpoint: String(as.token_endpoint), resource, at: Date.now() });
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state, ...(resource ? { resource } : {}) });
  if (scopes?.length) q.set("scope", scopes.join(" "));
  const authorize = new URL(String(as.authorization_endpoint));
  for (const [k, v] of q) authorize.searchParams.set(k, v);
  // Google gives a refresh token only when asked for one, and only on a fresh consent: without it a sign-in lasts an hour.
  if (/(^|\.)google\.com$/i.test(authorize.hostname)) (authorize.searchParams.set("access_type", "offline"), authorize.searchParams.set("prompt", "consent"));
  return { authorizeUrl: authorize.toString() };
}

/** A token request: the client's proof as its method says. */
async function tokenRequest(p: Pick<OAuth, "clientId" | "clientSecret" | "authMethod" | "tokenEndpoint" | "resource">, body: Record<string, string>): Promise<Record<string, any>> {
  const form = new URLSearchParams({ ...body, ...(p.resource ? { resource: p.resource } : {}) });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (p.authMethod === "client_secret_basic" && p.clientSecret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(p.clientId)}:${encodeURIComponent(p.clientSecret)}`).toString("base64")}`;
  else {
    form.set("client_id", p.clientId);
    if (p.authMethod === "client_secret_post" && p.clientSecret) form.set("client_secret", p.clientSecret);
  }
  const r = await fetch(p.tokenEndpoint, { method: "POST", headers, body: form, signal: AbortSignal.timeout(15_000) });
  const text = await r.text();
  let j: Record<string, any> = {};
  try {
    j = JSON.parse(text);
  } catch {
    j = Object.fromEntries(new URLSearchParams(text));
  }
  if (!r.ok || !j.access_token) throw new Error(j.error_description ?? j.error ?? `The sign-in wasn't accepted (${r.status}).`);
  return j;
}

/** The sign-in back from the browser: tokens kept, the server added (or signed in again) and tested. */
export async function finishSignin(state: string, code: string, test = testConnection): Promise<Connection> {
  const p = pending.get(state);
  pending.delete(state);
  if (!p || Date.now() - p.at > 10 * 60_000) throw new Error("That sign-in has expired. Start it again from Friday.");
  const t = await tokenRequest(p, { grant_type: "authorization_code", code, redirect_uri: p.redirect, code_verifier: p.verifier });
  const oauth: OAuth = {
    clientId: p.clientId,
    ...(p.clientSecret ? { clientSecret: p.clientSecret } : {}),
    authMethod: p.authMethod,
    tokenEndpoint: p.tokenEndpoint,
    resource: p.resource,
    accessToken: String(t.access_token),
    ...(t.refresh_token ? { refreshToken: String(t.refresh_token) } : {}),
    ...(t.expires_in ? { expiresAt: Date.now() + Number(t.expires_in) * 1000 } : {}),
  };
  // The tokens kept first, before the test (which can take a while): the sign-in isn't lost if the test is.
  const c = await updateStore((s) => {
    let c = (p.id && s.servers.find((x) => x.id === p.id)) || (p.catalog ? s.servers.find((x) => x.catalog === p.catalog) : undefined);
    if (c) c.oauth = oauth;
    else {
      c = { id: randomBytes(6).toString("hex"), name: freeName(p.name, s.servers.map((x) => x.name)), enabled: false, transport: /\/sse\/?(\?|$)/i.test(p.url) ? "sse" : "http", url: p.url, addedAt: Date.now(), ...(p.catalog ? { catalog: p.catalog } : {}), oauth };
      s.servers.push(c);
    }
    return { ...c };
  });
  const status = await test({ ...c, headers: { ...(c.headers ?? {}), Authorization: `Bearer ${oauth.accessToken}` } });
  return updateStore((s) => {
    const x = s.servers.find((y) => y.id === c.id);
    if (!x) return Object.assign(c, { status, enabled: status.ok });
    x.status = status;
    x.enabled = status.ok;
    return x;
  });
}

/**
 * A server's headers with its sign-in's token, refreshed first when it runs out within two minutes (and kept). A refresh that's
 * refused leaves the old token, so the server's test says it needs signing in again.
 */
export async function authHeaders(c: Connection): Promise<Record<string, string> | undefined> {
  if (!c.oauth) return c.headers;
  let o = c.oauth;
  if (o.refreshToken && o.expiresAt && o.expiresAt - Date.now() < 2 * 60_000) {
    try {
      const t = await tokenRequest(o, { grant_type: "refresh_token", refresh_token: o.refreshToken });
      o = { ...o, accessToken: String(t.access_token), ...(t.refresh_token ? { refreshToken: String(t.refresh_token) } : {}), ...(t.expires_in ? { expiresAt: Date.now() + Number(t.expires_in) * 1000 } : {}) };
      const got = o;
      await updateStore((s) => {
        const x = s.servers.find((y) => y.id === c.id);
        if (!x) return NO_WRITE;
        x.oauth = got;
      });
      c.oauth = o;
    } catch {
      /* the old one goes on; its test will say */
    }
  }
  return { ...(c.headers ?? {}), Authorization: `Bearer ${o.accessToken}` };
}
