import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EngineTool } from "../types.js";
import { ADAPTERS, childEnv, findBin, launcher, modelMenu, runCli, toolEnv, type TurnSpec } from "./adapters.js";
import { spawnCli } from "./spawn-cli.js";

/**
 * A coding tool's models before its first conversation here (Arun, 2026-11-10: "Build all four", after how T3 Code and Orca do
 * it). A tool spoken to over ACP says its models only as a conversation opens, so until one had, its picker offered nothing but
 * a box to type a name in. Now the picker asks, and this answers:
 *
 * - Kilo and OpenCode list theirs with `models` (provider/model, the ids their ACP `model` option takes), signed in or not:
 *   no conversation is opened, so nothing lands in their history. Orca reads OpenCode's the same way.
 * - Any other ACP tool is asked as T3 Code and Orca ask: a conversation opened and closed in an empty folder of Friday's own,
 *   with nothing said in it, and its `model` option (or older `models` list) read.
 *
 * Either way the list is the tool's, and the one it gives when a real conversation opens replaces it (runner rememberModels).
 */
export type ListedModel = { id: string; label: string; group?: string };

/** The tools with a `models` command of their own (Kilo is OpenCode's fork: `kilo models [provider]`, 7.8.28). */
const LISTS_ITSELF: Partial<Record<EngineTool, string[]>> = { kilo: ["models"], opencode: ["models"] };

/** Long lists are grouped, free ones first: Kilo lists 322 models, ten of them free ("kilo/kilo-auto/free", "…:free"). */
export const isFree = (m: { id: string; label: string }) => /(?:[:/]free$)|\(free\)/i.test(m.id) || /\bfree\b/i.test(m.label);
export function grouped(list: ListedModel[]): ListedModel[] {
  if (list.length <= 12) return list;
  const free = list.filter(isFree);
  if (!free.length) return list;
  return [...free.map((m) => ({ ...m, group: "Free" })), ...list.filter((m) => !isFree(m)).map((m) => ({ ...m, group: "Other models" }))];
}

/** `kilo models` / `opencode models`: one `provider/model` a line, after a banner of block characters. */
export function parseProviderModels(out: string): ListedModel[] {
  const seen = new Set<string>();
  const rows: ListedModel[] = [];
  for (const raw of out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/\r?\n/)) {
    const id = raw.trim();
    if (!/^[\w.~@-]+\/[\w.~@:/+-]+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    // Read without Kilo's own prefix and its "~" (a model that follows its family's latest); ":free" is said by its heading.
    rows.push({ id, label: id.replace(/^kilo\//, "").replace(/~/g, "").replace(/:free$/, "") });
  }
  return rows.slice(0, 600);
}

/** How long a look may take: a tool that has to fetch its catalogue (Kilo from models.dev) can take a few seconds. */
const LOOK_MS = 25_000;

/** One look at a time per tool: a picker opened twice while the first look runs waits for that one. */
const looking = new Map<EngineTool, Promise<ListedModel[]>>();
export function listModels(tool: EngineTool): Promise<ListedModel[]> {
  const going = looking.get(tool);
  if (going) return going;
  const run = look(tool)
    .catch(() => [])
    .finally(() => looking.delete(tool));
  looking.set(tool, run);
  return run;
}

async function look(tool: EngineTool): Promise<ListedModel[]> {
  const a = ADAPTERS[tool];
  if (!a.interactive || a.dialect || a.perTurn || tool === "antigravity" || a.unavailable?.()) return [];
  const bin = await findBin(tool);
  if (!bin) return [];
  const own = LISTS_ITSELF[tool];
  if (own) {
    const r = await runCli(bin, own, LOOK_MS).catch(() => null);
    return r && r.code === 0 ? grouped(parseProviderModels(r.out)) : [];
  }
  return grouped(await probeAcp(tool, bin));
}

/** A folder of Friday's own with nothing in it, for the conversations opened only to read their models or prove a sign-in. */
const PROBE_DIR = path.join(tmpdir(), "friday-model-look");

/** What a probe's models were: the tool's own list, as it gave it. */
export async function probeAcp(tool: EngineTool, bin: string, timeoutMs = LOOK_MS): Promise<ListedModel[]> {
  const r = await openConversation(tool, bin, timeoutMs);
  return r.models;
}

/**
 * Open a conversation and close it: `initialize`, `session/new`, and `session/close` where the tool has it (Kilo 7.8, Copilot 1.0
 * do), so it isn't left in the tool's history; the tool is ended either way. `ok` when the conversation opened, which is how a
 * sign-in is proven (T3 Code, Orca), with what the tool said when it didn't; its models, read from its answer. Ended at once
 * if it asks for anything (a sign-in, a permission), which is never answered here, or when it hasn't answered in `timeoutMs`.
 */
export async function openConversation(tool: EngineTool, bin: string, timeoutMs = LOOK_MS): Promise<{ ok: boolean; error?: string; models: ListedModel[] }> {
  const a = ADAPTERS[tool];
  await mkdir(PROBE_DIR, { recursive: true });
  const turn: TurnSpec = { prompt: "", system: "", resumeId: null, mode: "plan", ask: true };
  const how = await launcher(bin);
  const child = spawnCli(how.command, [...how.prefix, ...a.args(turn)], { cwd: PROBE_DIR, env: toolEnv(tool, { ...childEnv(), ...how.env, ...(a.env?.(turn) ?? {}) }) });
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    let caps: any = {};
    const end = (r: { ok: boolean; error?: string; models: ListedModel[] }, closing?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const stop = () => {
        try {
          child.stdin?.end();
        } catch {}
        child.kill("SIGTERM");
      };
      if (closing) {
        send({ id: 2, method: "session/close", params: { sessionId: closing } });
        setTimeout(stop, 300).unref?.();
      } else stop();
      resolve(r);
    };
    const timer = setTimeout(() => end({ ok: false, error: "It didn't answer in time.", models: [] }), timeoutMs);
    const send = (o: Record<string, unknown>) => {
      try {
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...o })}\n`);
      } catch {
        end({ ok: false, error: "It couldn't be started.", models: [] });
      }
    };
    let err = "";
    child.stdin?.on("error", () => end({ ok: false, error: "It couldn't be started.", models: [] }));
    child.on("error", () => end({ ok: false, error: "It couldn't be started.", models: [] }));
    child.on("exit", () => end({ ok: false, error: err.trim().split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 200) || "It stopped before a conversation opened.", models: [] }));
    child.stderr?.on("data", (d: Buffer) => void (err = (err + d.toString()).slice(-4_000)));
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        // A request of its own (a sign-in, a permission) is never answered here.
        if (m?.method && m.id !== undefined) return end({ ok: false, error: "It asked for something before a conversation opened.", models: [] });
        if (m?.id === 0) {
          if (m.error) return end({ ok: false, error: String(m.error.message || "It couldn't start."), models: [] });
          caps = m.result?.agentCapabilities ?? {};
          send({ id: 1, method: "session/new", params: { cwd: PROBE_DIR, mcpServers: [] } });
        } else if (m?.id === 1) {
          if (m.error) return end({ ok: false, error: String(m.error.message || "It couldn't open a conversation."), models: [] });
          const menu = modelMenu(m.result);
          const models = menu ? menu.list.filter((c) => c.id).map((c) => ({ id: c.id, label: c.name || c.id })) : [];
          const sid = typeof m.result?.sessionId === "string" ? m.result.sessionId : "";
          end({ ok: true, models }, caps?.sessionCapabilities?.close && sid ? sid : undefined);
        }
      }
    });
    send({ id: 0, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "friday", version: "1" } } });
  });
}
