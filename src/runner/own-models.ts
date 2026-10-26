import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import type { Completion, CompletionRequest } from "../agent/llm.js";
import { CompatibleLLM } from "../agent/compatible.js";
import { seesByName } from "../own-vision.js";

/**
 * Your own models: a key at OpenAI, Anthropic, Google, Groq or anywhere else that speaks the OpenAI chat format, or a model running on this computer (Ollama, LM Studio, llama.cpp, vLLM).
 *
 * They live here, on this computer, in a file only this user can read, and Friday's agent reaches them through this
 * computer when somebody picks one: the key goes to the model's own server and nowhere else, Friday's server never holds
 * it, and a local model works because the call starts next to it.
 */

export interface OwnModel {
  id: string;
  name: string;
  /** The server's OpenAI-compatible base, ending before /chat/completions: https://api.openai.com/v1, http://localhost:11434/v1. */
  baseUrl: string;
  /** The model's name at that server: gpt-6.1-sol, claude-sonnet-5-5, llama3.1:8b. */
  model: string;
  apiKey?: string;
  /** Which preset it was made from, for its mark. */
  provider?: string;
  /** It can see pictures, as its owner set it. Unset: guessed from its name (see seesImages). */
  vision?: boolean;
}
/** What leaves this computer about a model: everything but the key. `sees`: whether it is sent pictures, set or guessed. */
export type OwnModelView = Omit<OwnModel, "apiKey"> & { hasKey: boolean; local: boolean; sees: boolean };

/** Whether an own model is sent pictures (Arun, 2026-10-18: your own models as capable as the tools behind them). */
export const seesImages = (m: Pick<OwnModel, "model" | "vision">): boolean => m.vision ?? seesByName(m.model);

const FILE = () => path.join(homedir(), ".friday", "models.json");

export const isLocalUrl = (u: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(u);

/**
 * The key a saved model may send to `base`: its own, only when `base` is the very address it was saved for (both cleaned the same
 * way). These calls can come over the link from the hosted page; a saved id with another address would otherwise hand the key to
 * whatever that address is, and a gateway that tells accounts apart by path shares its host with other people's.
 */
const keyFor = (had: OwnModel | undefined, base: string) => (had?.apiKey && had.baseUrl === base ? had.apiKey : undefined);

/** A key as a header can carry it: one line of printable characters. One pasted across two lines would be echoed back whole by a failed request. */
const KEY = /^[\x21-\x7e]{8,500}$/;
function checkKey(key: string | undefined): void {
  if (key && !KEY.test(key)) throw new Error("That key has spaces or line breaks in it. Paste it again as one line.");
  // What `claude setup-token` prints is a sign-in for Claude Code only; Anthropic refuses it anywhere else, with a 400 that says
  // nothing a person can act on.
  if (key && /^sk-ant-oat/i.test(key)) throw new Error("That's a Claude Code sign-in token, not an API key: it only works inside Claude Code. Create an API key at console.anthropic.com/settings/keys and paste that.");
}
/** An error with any key in it taken out: errors travel to the session and its log, and a key must never go with them. */
function redacted(e: unknown, ...keys: (string | undefined)[]): Error {
  let msg = e instanceof Error ? e.message : String(e);
  for (const k of keys) if (k && k.length >= 8) msg = msg.split(k).join("[key]");
  return Object.assign(new Error(msg), e instanceof Error && "status" in e ? { status: (e as { status: unknown }).status } : {});
}
const MOVED = "Enter the key again: a saved key only goes to the address it was saved for.";
const view = (m: OwnModel): OwnModelView => ({ id: m.id, name: m.name, baseUrl: m.baseUrl, model: m.model, ...(m.provider ? { provider: m.provider } : {}), ...(m.vision !== undefined ? { vision: m.vision } : {}), hasKey: !!m.apiKey, local: isLocalUrl(m.baseUrl), sees: seesImages(m) });

async function load(): Promise<OwnModel[]> {
  let raw: string;
  try {
    raw = await readFile(FILE(), "utf8");
  } catch {
    return [];
  }
  // A file that is there but won't read is never taken for an empty one: the next save would wipe every model and key in it.
  let j: { models?: OwnModel[] };
  try {
    j = JSON.parse(raw) as { models?: OwnModel[] };
  } catch {
    throw new Error(`Your models file (${FILE()}) couldn't be read, so nothing was changed. Fix or remove it, then try again.`);
  }
  return Array.isArray(j.models) ? j.models.filter((m) => m && m.id && m.baseUrl && m.model) : [];
}
/** Written whole and then put in place, so a crash or a second save mid-write never leaves half a file. */
async function store(models: OwnModel[]): Promise<void> {
  await mkdir(path.dirname(FILE()), { recursive: true });
  const tmp = `${FILE()}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify({ models }, null, 2), { mode: 0o600 });
  await rename(tmp, FILE());
  await chmod(FILE(), 0o600).catch(() => {});
}

export async function listOwnModels(): Promise<{ models: OwnModelView[] }> {
  return { models: (await load()).map(view) };
}

function cleanUrl(u: string): string {
  const s = u.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new Error("That address doesn't look like a URL. It starts with https:// (or http://localhost for a model on this computer).");
  }
  // Only an address: a name and password in it, or a query, would travel in every error and choose another path for the calls.
  if (url.username || url.password || url.search || url.hash) throw new Error("Give the address alone, with no name, password or ?query in it: the key goes in its own field.");
  // Your own network by its numbers: 10.evil.com is a name on the internet, not a machine on your network.
  const privateIp = isIPv4(url.hostname) && /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (isLocalUrl(s) || privateIp))) throw new Error("Use https:// for a model on the internet; http:// is only for one on this computer or your own network.");
  return s;
}

/** Add one, or change one: a change that leaves the key out keeps the key it had. */
export async function saveOwnModel(p: { id?: string; name?: string; baseUrl?: string; model?: string; apiKey?: string; provider?: string; vision?: boolean }): Promise<{ model: OwnModelView }> {
  const models = await load();
  const had = p.id ? models.find((m) => m.id === p.id) : undefined;
  if (p.id && !had) throw new Error("That model isn't on this computer any more.");
  const model = (p.model ?? had?.model ?? "").trim().slice(0, 200);
  if (!model) throw new Error("Which model? Its name at that server, like gpt-6.1-sol or llama3.1:8b.");
  const baseUrl = cleanUrl(p.baseUrl ?? had?.baseUrl ?? "");
  checkKey(p.apiKey?.trim());
  // A model moved to another server takes its key along only when that key is given again.
  const kept = p.apiKey?.trim() ? undefined : keyFor(had, baseUrl);
  if (!p.apiKey?.trim() && had?.apiKey && !kept) throw new Error(MOVED);
  const next: OwnModel = {
    id: had?.id ?? randomBytes(4).toString("hex"),
    name: (p.name ?? had?.name ?? "").trim().slice(0, 60) || model,
    baseUrl,
    model,
    ...(p.apiKey?.trim() ? { apiKey: p.apiKey.trim() } : kept ? { apiKey: kept } : {}),
    ...((p.provider ?? had?.provider) ? { provider: (p.provider ?? had?.provider)!.slice(0, 30) } : {}),
    ...((p.vision ?? had?.vision) !== undefined ? { vision: (p.vision ?? had?.vision)! } : {}),
  };
  await store(had ? models.map((m) => (m.id === had.id ? next : m)) : [...models, next].slice(-40));
  return { model: view(next) };
}

export async function removeOwnModel(p: { id: string }): Promise<{ ok: true }> {
  await store((await load()).filter((m) => m.id !== p.id));
  return { ok: true };
}

/** The models a server offers, from its /models list: what to pick from instead of typing a name. */
export async function discoverModels(p: { baseUrl: string; apiKey?: string; id?: string }): Promise<{ models: string[] }> {
  const had = p.id ? (await load()).find((m) => m.id === p.id) : undefined;
  const base = cleanUrl(p.baseUrl || had?.baseUrl || "");
  checkKey(p.apiKey?.trim());
  const key = p.apiKey?.trim() || keyFor(had, base);
  if (!p.apiKey?.trim() && had?.apiKey && !key) throw new Error(MOVED);
  // Anthropic's list wants its own headers; everyone else's the OpenAI one.
  const anthropic = /(^|\.)anthropic\.com$/i.test(new URL(base).hostname);
  const headers: Record<string, string> = !key ? {} : anthropic ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { Authorization: `Bearer ${key}` };
  // Never followed elsewhere: a redirect to another host would carry the key there (Anthropic's header isn't dropped on the way).
  const r = await fetch(`${base}/models`, { headers, redirect: "error", signal: AbortSignal.timeout(8000) }).catch((e: Error & { cause?: { code?: string } }) => {
    throw redacted(new Error(isLocalUrl(base) ? `Nothing answered at ${base}. Is the model server running?` : `Couldn't reach ${base}${e.cause?.code ? ` (${e.cause.code})` : ""}.`), key);
  });
  if (!r.ok) {
    // The server's own words for why, so a refusal can be acted on ("invalid x-api-key", "credit balance is too low") rather than
    // guessed at from a number. Never with the key in them: a careless server says it back.
    const said = await r.text().catch(() => "");
    let why = "";
    try {
      const j = JSON.parse(said) as { error?: { message?: string } | string; message?: string; detail?: string };
      why = String((typeof j.error === "object" ? j.error?.message : j.error) ?? j.message ?? j.detail ?? "");
    } catch {
      why = /^\s*</.test(said) ? "" : said;
    }
    why = why.replace(/\s+/g, " ").trim().slice(0, 200);
    const reason = why ? `: “${why}”` : "";
    if (r.status === 401 || r.status === 403) throw redacted(new Error(`That server didn't accept the key${reason}.`), key);
    throw redacted(new Error(`That server answered ${r.status} for its model list${reason}. You can still type the model's name.`), key);
  }
  const j = (await r.json().catch(() => ({}))) as { data?: { id?: string }[]; models?: { id?: string; name?: string }[] };
  // Google's ids come as "models/gemini-…", which its chat endpoint takes without the prefix.
  const ids = [...(j.data ?? []), ...(j.models ?? [])].map((m) => String(m.id ?? (m as { name?: string }).name ?? "").replace(/^models\//, "")).filter(Boolean);
  return { models: [...new Set(ids)].sort().slice(0, 400) };
}

/** The model servers people run on their own computer, at the addresses they listen on unless told otherwise. */
const LOCAL = [
  { provider: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1" },
  { provider: "lmstudio", name: "LM Studio", baseUrl: "http://localhost:1234/v1" },
  { provider: "llamacpp", name: "llama.cpp", baseUrl: "http://localhost:8080/v1" },
  { provider: "vllm", name: "vLLM", baseUrl: "http://localhost:8000/v1" },
];
/** Which of those are running here now, and what models each has. Quick: a server that isn't there doesn't answer at all. */
export async function detectLocal(): Promise<{ servers: { provider: string; name: string; baseUrl: string; models: string[] }[] }> {
  const found = await Promise.all(
    LOCAL.map(async (s) => {
      try {
        const r = await fetch(`${s.baseUrl}/models`, { signal: AbortSignal.timeout(900) });
        if (!r.ok) return null;
        const j = (await r.json()) as { data?: { id?: string }[] };
        return { ...s, models: (j.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean).slice(0, 200) };
      } catch {
        return null;
      }
    }),
  );
  return { servers: found.filter((s): s is NonNullable<typeof s> => !!s) };
}

const clientFor = (m: OwnModel) => new CompatibleLLM({ baseUrl: m.baseUrl, model: m.model, ...(m.apiKey ? { apiKey: m.apiKey } : {}) });
async function find(id: string): Promise<OwnModel> {
  const m = (await load()).find((x) => x.id === id);
  if (!m) throw new Error("That model isn't set up on this computer any more. Pick another, or add it again in Settings › Your models.");
  return m;
}

/** One call to an own model: what Friday's agent asks of it, step by step, from wherever the session is. */
export async function ownComplete(
  p: { id: string; system: string; messages: CompletionRequest["messages"]; tools: CompletionRequest["tools"]; reasoningEffort?: string; timeoutMs?: number },
  on: { delta?: (t: string) => void; reasoning?: (t: string) => void } = {},
): Promise<Completion> {
  const m = await find(p.id);
  // ponytail: the session can't stop a call it already sent here; it runs to the end or the timeout. A cancel message over the link would end it sooner.
  return clientFor(m)
    .complete({
    system: p.system,
    messages: p.messages,
    tools: p.tools ?? [],
    signal: AbortSignal.timeout(p.timeoutMs ?? 10 * 60_000),
    ...(p.reasoningEffort ? { reasoningEffort: p.reasoningEffort } : {}),
      onDelta: on.delta,
      onReasoning: on.reasoning,
    })
    // What goes back to the session, and into its log, never carries the key.
    .catch((e: unknown) => {
      throw redacted(e, m.apiKey);
    });
}

/** Whether Friday's agent may send this model the pictures attached to a step. An unknown id is no. */
export async function ownVision(p: { id: string }): Promise<{ vision: boolean }> {
  const m = (await load()).find((x) => x.id === p.id);
  return { vision: !!m && seesImages(m) };
}

/** Does it answer? A short question, with how long it took. */
export async function testOwnModel(p: { id: string }): Promise<{ ok: true; ms: number; reply: string }> {
  const start = Date.now();
  const r = await ownComplete({ id: p.id, system: "Answer in one word.", messages: [{ role: "user", content: "Say OK." }], tools: [], timeoutMs: 60_000 });
  return { ok: true, ms: Date.now() - start, reply: r.text.trim().slice(0, 80) };
}
