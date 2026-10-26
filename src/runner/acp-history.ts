import { homedir } from "node:os";
import { createInterface } from "node:readline";
import type { EngineTool, ImportedTurn } from "../types.js";
import { ADAPTERS, childEnv, findBin, launcher } from "./adapters.js";
import { spawnCli } from "./spawn-cli.js";

/**
 * A tool's earlier conversations, asked of the tool itself over ACP, for the tools whose own store isn't documented: `session/list`
 * says which there are, and `session/load` plays one back. The tool is started for the question and let go after it; nothing new
 * is opened, so its own history is left as it was.
 */

type Rpc = { result?: any; error?: { code?: number; message?: string } };

/** One short conversation with the tool: started in `cwd`, initialized, and ended by `close`. */
async function connect(tool: EngineTool, cwd: string) {
  const bin = await findBin(tool);
  if (!bin) throw new Error("not installed");
  const how = await launcher(bin);
  const adapter = ADAPTERS[tool];
  const spec = { prompt: "", resumeId: null, mode: "plan" as const, system: "" };
  const child = spawnCli(how.command, [...how.prefix, ...adapter.args(spec)], { cwd, env: { ...childEnv(), ...how.env, ...adapter.env?.(spec) } });
  child.stdin!.on("error", () => {});
  let next = 0;
  const waiting = new Map<number, (r: Rpc) => void>();
  const updates: ((u: any) => void)[] = [];
  const write = (o: object) => child.stdin!.writableEnded || child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", ...o })}\n`);
  createInterface({ input: child.stdout! }).on("line", (line) => {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m?.id != null && !m.method) {
      waiting.get(Number(m.id))?.({ result: m.result, error: m.error });
      waiting.delete(Number(m.id));
    } else if (m?.id != null) {
      // Nothing is being done, so nothing it asks is allowed.
      write(m.method === "session/request_permission" ? { id: m.id, result: { outcome: { outcome: "cancelled" } } } : { id: m.id, error: { code: -32601, message: "Not offered" } });
    } else if (m?.method === "session/update") for (const f of updates) f(m.params?.update);
  });
  const gone = new Promise<void>((resolve) => child.on("close", () => resolve()));
  child.on("error", () => {});
  const request = (method: string, params: unknown, ms = 20_000) =>
    new Promise<Rpc>((resolve) => {
      const id = next++;
      const timer = setTimeout(() => (waiting.delete(id), resolve({ error: { message: `${method} didn't answer` } })), ms);
      waiting.set(id, (r) => (clearTimeout(timer), resolve(r)));
      void gone.then(() => resolve({ error: { message: "it stopped" } }));
      write({ id, method, params });
    });
  const close = () => {
    child.stdin!.end();
    setTimeout(() => child.exitCode === null && child.kill(), 3000).unref?.();
  };
  const init = await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "friday", title: "Friday", version: "1" } });
  if (init.error) {
    close();
    throw new Error(init.error.message ?? "it couldn't start");
  }
  return { caps: init.result?.agentCapabilities ?? {}, request, onUpdate: (f: (u: any) => void) => updates.push(f), close };
}

export interface AcpSession {
  id: string;
  cwd: string;
  title: string;
  updatedAt: number;
}

/**
 * Its conversations, newest first, or why there are none to show. Some tools list only the folder they are asked about (OpenCode
 * files them by project, and lists none from the home folder), so each of `cwds` is asked about too, in the one conversation.
 */
export async function acpSessions(tool: EngineTool, cwds: string[] = [], limit = 150): Promise<AcpSession[] | { why: string }> {
  const c = await connect(tool, homedir()).catch((e: Error) => e);
  if (c instanceof Error) return { why: `Couldn't ask it for its sessions: ${c.message}.` };
  try {
    if (!c.caps?.sessionCapabilities?.list) return { why: "It can't list its earlier sessions to anything but itself." };
    const out = new Map<string, AcpSession>();
    let failed = "";
    for (const cwd of [undefined, ...new Set(cwds)]) {
      let cursor: string | undefined;
      // A few pages at most for each: the picker shows the newest.
      for (let page = 0; page < 3 && out.size < limit; page++) {
        const r = await c.request("session/list", { ...(cwd ? { cwd } : {}), ...(cursor ? { cursor } : {}) });
        if (r.error) {
          failed ||= r.error.message ?? "no answer";
          break;
        }
        for (const s of Array.isArray(r.result?.sessions) ? r.result.sessions : []) {
          if (typeof s?.sessionId !== "string" || typeof s.cwd !== "string") continue;
          out.set(s.sessionId, { id: s.sessionId, cwd: s.cwd, title: typeof s.title === "string" ? s.title : "", updatedAt: Date.parse(String(s.updatedAt ?? "")) || 0 });
        }
        cursor = typeof r.result?.nextCursor === "string" ? r.result.nextCursor : undefined;
        if (!cursor) break;
      }
    }
    if (!out.size && failed) return { why: `It didn't list its sessions: ${failed}.` };
    return [...out.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  } finally {
    c.close();
  }
}

/** One conversation, as it plays it back: what each side said, with the tool calls left out. */
export async function acpTranscript(tool: EngineTool, id: string, cwd: string): Promise<ImportedTurn[] | null> {
  const c = await connect(tool, cwd).catch(() => null);
  if (!c) return null;
  try {
    if (!c.caps?.loadSession) return null;
    const turns: ImportedTurn[] = [];
    let last: { role: "user" | "assistant"; key: string } | null = null;
    c.onUpdate((u) => {
      const role = u?.sessionUpdate === "user_message_chunk" ? "user" : u?.sessionUpdate === "agent_message_chunk" ? "assistant" : null;
      if (!role) {
        // A tool call between two pieces of the agent's text makes them two messages, as the run showed them.
        if (u?.sessionUpdate === "tool_call") last = null;
        return;
      }
      const text = u.content?.type === "text" && typeof u.content.text === "string" ? u.content.text : "";
      if (!text) return;
      const key = typeof u.messageId === "string" ? u.messageId : role;
      if (last && last.role === role && last.key === key) turns[turns.length - 1]!.text += text;
      else turns.push({ role, text });
      last = { role, key };
    });
    const r = await c.request("session/load", { sessionId: id, cwd, mcpServers: [] }, 60_000);
    return r.error ? null : turns;
  } finally {
    c.close();
  }
}
