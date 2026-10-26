import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * A project's MCP servers, as an ACP tool is handed them when a conversation opens (`session/new`, `session/load`).
 *
 * The project's `.mcp.json` is the one MCP file most tools and teams share, and Claude Code reads it by itself. The tools Friday
 * speaks to over ACP each read only their own config, and Friday passed them none (`mcpServers: []`), so a project's servers were
 * there for Claude Code and nobody else. ACP's way is for the client to pass them, so Friday does now (Arun, 2026-10-18: every
 * tool as capable in Friday as on its own). Only the project's own file: the person's own servers are each tool's own business.
 */

type Pair = { name: string; value: string };
export type AcpMcpServer =
  | { name: string; command: string; args: string[]; env: Pair[] }
  | { type: "http" | "sse"; name: string; url: string; headers: Pair[] };

/**
 * `${VAR}` and `${VAR:-default}` filled in from the environment, as Claude Code does in .mcp.json. Null when one is unset and
 * has no default: that server couldn't start as written, so it isn't passed rather than passed broken.
 */
export function expandVars(s: string, env: NodeJS.ProcessEnv = process.env): string | null {
  let missing = false;
  const out = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, dflt?: string) => {
    const v = env[name];
    if (v !== undefined && v !== "") return v;
    if (dflt !== undefined) return dflt;
    missing = true;
    return "";
  });
  return missing ? null : out;
}

const pairs = (o: unknown, env: NodeJS.ProcessEnv): Pair[] | null => {
  if (!o || typeof o !== "object") return [];
  const out: Pair[] = [];
  for (const [name, raw] of Object.entries(o as Record<string, unknown>)) {
    const value = expandVars(String(raw ?? ""), env);
    if (value === null) return null;
    out.push({ name, value });
  }
  return out;
};

/** The servers in a folder's .mcp.json, as ACP names them. A file that is missing or broken is none. */
export async function projectMcpServers(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<AcpMcpServer[]> {
  const j = await readFile(path.join(cwd, ".mcp.json"), "utf8")
    .then((t) => JSON.parse(t) as { mcpServers?: Record<string, any> })
    .catch(() => null);
  const servers = j?.mcpServers && typeof j.mcpServers === "object" ? j.mcpServers : {};
  const out: AcpMcpServer[] = [];
  for (const [name, s] of Object.entries(servers)) {
    if (!s || typeof s !== "object" || s.disabled === true) continue;
    if (typeof s.command === "string" && s.command.trim()) {
      const command = expandVars(s.command, env);
      const args = (Array.isArray(s.args) ? s.args : []).map((a: unknown) => expandVars(String(a), env));
      const vars = pairs(s.env, env);
      if (command === null || args.includes(null) || vars === null) continue;
      out.push({ name, command, args: args as string[], env: vars });
    } else if (typeof s.url === "string" && s.url.trim()) {
      const url = expandVars(s.url, env);
      const headers = pairs(s.headers, env);
      if (url === null || headers === null) continue;
      out.push({ type: s.type === "sse" ? "sse" : "http", name, url, headers });
    }
  }
  return out;
}

/** Those an agent can take: every one that it starts itself, and the remote ones only when it says it speaks their transport. */
export function mcpForAgent(servers: AcpMcpServer[] | undefined, caps: Record<string, any> | undefined): AcpMcpServer[] {
  const remote = caps?.mcpCapabilities ?? caps?.mcp ?? {};
  return (servers ?? []).filter((s) => !("type" in s) || (s.type === "http" ? !!remote.http : !!remote.sse));
}
