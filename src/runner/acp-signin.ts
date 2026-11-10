import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EngineTool } from "../types.js";
import { ADAPTERS, childEnv, forgetLoginStatus, launcher, toolEnv, type TurnSpec } from "./adapters.js";
import { spawnCli, type CliProcess } from "./spawn-cli.js";

/**
 * Signing in to a coding tool spoken to over ACP by the ways it says it has (Arun, 2026-11-10: "ok lets begin we need to ensure
 * everything is stable and ready", after T3 Code, which signs every ACP agent in by the methods its `initialize` lists).
 *
 * The tool is started and asked (`initialize`, saying Friday can run a terminal sign-in and open a page for it). What it lists:
 *
 * - a terminal sign-in (`type: "terminal"`, or Zed's `_meta["terminal-auth"]`, as GitHub Copilot 1.0.103 lists its own): its
 *   command is handed back, to run in Friday's terminal or a window of its own, and a fresh conversation proves it after.
 * - a sign-in it does itself (`type: "agent"`, the default): `authenticate` is asked for. It opens its page in the browser, or
 *   asks Friday to (`elicitation/create`), and its link is handed to the page either way. Signed in is a conversation that
 *   opens (Orca: "Authentication alone does not prove a chat can start").
 * - a key (`env_var`), or nothing Friday can use: the tool's own login command, or the tool started in a terminal, as before.
 *
 * Antigravity takes this way with its personal Google sign-in (oauth-personal), and only Google's page is ever handed on for it.
 * While a sign-in waits, the tool's sign-in check answers from here (`acpSignInState`), rather than starting the tool every few
 * seconds to ask: an Antigravity start unpacks about a gigabyte (T3 Code's note).
 */
export type SignInPhase = "starting" | "waiting" | "terminal" | "verifying" | "done" | "failed";
export type SignInState = { phase: SignInPhase; url?: string; error?: string; at: number };
export type SignInStart =
  | { url?: string; open?: true }
  | { terminal: { argv: string[]; env: Record<string, string> }; method: string }
  | { fixed: true }
  | { fallback: true };

/** How long the person has to finish. */
const WAIT_MS = 10 * 60_000;
/** How long the sign-in route waits for the tool's link before answering the page without one. */
const LINK_MS = 8_000;
const PROMPT = "Open the following link to authenticate the ACP server:";

type Current = SignInState & { child?: CliProcess; done: Promise<void> };
const current = new Map<EngineTool, Current>();
/**
 * The tools whose sign-in Friday proved here (a conversation opened after it), while this runs: for a tool whose sign-in it
 * can't otherwise check (Gemini CLI without its Google file, Qwen, Droid), that is its answer, rather than "can't tell".
 * Forgotten as it signs out.
 */
const proven = new Set<EngineTool>();
export const wasProven = (tool: EngineTool) => proven.has(tool);
export const forgetProof = (tool: EngineTool) => void proven.delete(tool);

/** Where a sign-in Friday is carrying out stands; null when none was started, or it ended a minute ago. */
export function acpSignInState(tool: EngineTool): SignInState | null {
  const c = current.get(tool);
  if (!c) return null;
  if ((c.phase === "done" || c.phase === "failed") && Date.now() - c.at > 60_000) return null;
  const { phase, url, error, at } = c;
  return { phase, ...(url ? { url } : {}), ...(error ? { error } : {}), at };
}

/** Said by the route once a terminal sign-in's command has run and a conversation opened (or didn't) after it. */
export function settleSignIn(tool: EngineTool, ok: boolean, error?: string): void {
  current.set(tool, { phase: ok ? "done" : "failed", ...(error ? { error } : {}), at: Date.now(), done: Promise.resolve() });
  if (ok) proven.add(tool);
  else proven.delete(tool);
  if (ok) forgetLoginStatus();
}
export function noteTerminalSignIn(tool: EngineTool): void {
  current.set(tool, { phase: "terminal", at: Date.now(), done: Promise.resolve() });
}

/**
 * The redirect a browser sign-in sends the browser back to on this computer (`http://127.0.0.1:<port>/…`), when it has one: on
 * another device the browser lands on a page that won't load, and its address is pasted back here (callbackFromElsewhere).
 */
export function loopbackOf(link: string): { port: number; state: string } | null {
  try {
    const back = new URL(new URL(link).searchParams.get("redirect_uri") ?? "");
    if (back.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(back.hostname)) return null;
    const port = Number(back.port);
    return port >= 1024 && port <= 65_535 ? { port, state: new URL(link).searchParams.get("state") ?? "" } : null;
  } catch {
    return null;
  }
}

/**
 * Finish a browser sign-in done on another device (as T3 Code and Orca take a pasted callback): the address its browser ended
 * on, for this computer's port, carrying the same `state` as the sign-in's link, is opened here, where the tool is waiting.
 */
export async function callbackFromElsewhere(tool: EngineTool, pasted: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const c = current.get(tool);
  if (!c || c.phase !== "waiting" || !c.url) throw new Error("That sign-in isn't waiting any more. Start it again.");
  const want = loopbackOf(c.url);
  if (!want) throw new Error("This sign-in finishes in its own page: there's nothing to paste.");
  let got: URL;
  try {
    got = new URL(pasted.trim());
  } catch {
    throw new Error("Paste the whole address from the browser's address bar.");
  }
  if (!["127.0.0.1", "localhost"].includes(got.hostname) || Number(got.port) !== want.port) throw new Error("That address isn't the one this sign-in sends the browser back to.");
  if (want.state && got.searchParams.get("state") !== want.state) throw new Error("That address is from another sign-in. Use the one from this sign-in's page.");
  if (!got.searchParams.get("code") && !got.searchParams.get("error")) throw new Error("That address has no sign-in code in it. Paste it once the page has sent you on.");
  const r = await fetchImpl(`http://127.0.0.1:${want.port}${got.pathname}${got.search}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!r) throw new Error("The tool on this computer didn't take it. Start the sign-in again.");
}

export function cancelAcpSignIn(tool: EngineTool): void {
  const c = current.get(tool);
  if (!c || c.phase === "done" || c.phase === "failed") return;
  Object.assign(c, { phase: "failed", error: "Stopped.", at: Date.now() });
  end(c.child);
}

function end(c: CliProcess | undefined): void {
  if (!c) return;
  try {
    c.stdin?.end();
  } catch {}
  c.kill("SIGTERM");
  // A bundle that unpacks itself (Antigravity) can outlast its first signal: the whole tree goes (spawnCli), by force soon after.
  setTimeout(() => c.exitCode === null && c.signalCode === null && c.kill("SIGKILL"), 4_000).unref?.();
}

/** A sign-in link for Antigravity: only Google's sign-in page, sending the browser back to this computer (as Orca checks). */
export function agyLink(line: string): string | null {
  const m = /(https:\/\/accounts\.google\.com\/\S+)/.exec(line);
  if (!m) return null;
  try {
    const u = new URL(m[1]!);
    if (u.origin !== "https://accounts.google.com" || u.username || u.password) return null;
    const back = u.searchParams.get("redirect_uri") ?? "";
    if (back && !/^http:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}(?:\/\S*)?$/.test(back)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** A sign-in link for any other tool: a web page (https), as it printed or asked for it, never one carrying a password. */
export function webLink(line: string): string | null {
  const m = /(https:\/\/[^\s"'<>]+)/.exec(line);
  if (!m) return null;
  try {
    const u = new URL(m[1]!.replace(/[).,;\]]+$/, ""));
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

type Method = { id: string; name?: string; description?: string; type?: string; args?: unknown; env?: unknown; _meta?: any };

/** Antigravity's: its personal Google sign-in when it lists it (or lists none), never a key or a company account. */
export function agyMethod(init: any): string | null {
  const methods: Method[] = Array.isArray(init?.authMethods) ? init.authMethods : [];
  if (!methods.length) return "oauth-personal";
  const ids = methods.map((m) => String(m?.id ?? ""));
  return ids.find((id) => id === "oauth-personal") ?? ids.find((id) => /oauth|google/i.test(id) && !/business|enterprise|key|vertex|platform/i.test(id)) ?? null;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const vars = (v: unknown): Record<string, string> =>
  v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k, x]) => /^[A-Za-z_][\w]*$/.test(k) && typeof x === "string") as [string, string][]) : {};

/**
 * Which of a tool's sign-in methods Friday takes, and how. A terminal sign-in first (it is the tool's own screen, nothing for
 * Friday to stand in the middle of), then one the tool does itself, the account kind before a key's or a company's; a key's
 * alone is left to the tool's own login command.
 */
export function pickMethod(init: any, launch: string[]): { terminal: { argv: string[]; env: Record<string, string> }; method: string } | { agent: string } | null {
  const methods: Method[] = (Array.isArray(init?.authMethods) ? init.authMethods : []).filter((m: any) => m && typeof m.id === "string" && m.id.length <= 128).slice(0, 32);
  for (const m of methods) if (m.type === "terminal") return { terminal: { argv: [...launch, ...strings(m.args)], env: vars(m.env) }, method: m.id };
  for (const m of methods) {
    const t = m._meta?.["terminal-auth"];
    if (t && typeof t.command === "string" && path.isAbsolute(t.command) && existsSync(t.command)) return { terminal: { argv: [t.command, ...strings(t.args)], env: vars(t.env) }, method: m.id };
  }
  const own = methods.filter((m) => !m.type || m.type === "agent");
  const account = own.find((m) => /oauth|login|google|github|browser|account|sign/i.test(`${m.id} ${m.name ?? ""}`) && !/key|vertex|enterprise|business|platform|token/i.test(`${m.id} ${m.name ?? ""}`));
  const pick = account ?? own.find((m) => !/key|token/i.test(`${m.id} ${m.name ?? ""}`));
  return pick ? { agent: pick.id } : null;
}

/** A description that only says to run a command in the terminal ("Run `kilo auth login` in the terminal"): not something `authenticate` does. */
const onlyTerminal = (m: Method | undefined) => !!m && /\brun\b[^.]*\bin (?:the|a|your) terminal\b/i.test(m.description ?? "");

/**
 * Start it. Answers with the link once the tool gives one (or after a few seconds without), a terminal command to run, or
 * `fixed`/`fallback` for the route's own ways: the tool's login command, or the tool started in a terminal.
 */
export async function startAcpSignIn(tool: EngineTool, bin: string, opts: { waitMs?: number; linkMs?: number } = {}): Promise<SignInStart> {
  const going = current.get(tool);
  if (going && (going.phase === "starting" || going.phase === "waiting" || going.phase === "verifying")) {
    if (going.url) return { url: going.url };
    cancelAcpSignIn(tool);
  }
  const a = ADAPTERS[tool];
  const agy = tool === "antigravity";
  const dir = path.join(tmpdir(), "friday-signin");
  await mkdir(dir, { recursive: true });
  const how = await launcher(bin);
  const turn: TurnSpec = { prompt: "", system: "", resumeId: null, mode: "plan", ask: true };
  const launch = [how.command, ...how.prefix, ...a.args(turn)];
  const child = spawnCli(launch[0]!, launch.slice(1), { cwd: dir, env: toolEnv(tool, { ...childEnv(), ...how.env, ...(a.env?.(turn) ?? {}), PYTHONUNBUFFERED: "1" }) });
  let settle!: () => void;
  const me: Current = { phase: "starting", at: Date.now(), child, done: new Promise<void>((r) => (settle = r)) };
  current.set(tool, me);
  const mine = () => current.get(tool) === me;
  const set = (patch: Partial<SignInState>) => Object.assign(me, patch, { at: Date.now() });

  let answer!: (r: SignInStart) => void;
  const answered = new Promise<SignInStart>((r) => (answer = r));
  let said = false;
  const reply = (r: SignInStart) => {
    if (said) return;
    said = true;
    answer(r);
  };
  /** Not Friday's way after all: forgotten, the tool ended, and the route told which of its own ways to take. */
  const handBack = (r: SignInStart) => {
    if (mine()) current.delete(tool);
    reply(r);
    end(child);
    settle();
  };
  const fail = (error: string) => {
    if (!mine() || me.phase === "done" || me.phase === "failed") return;
    set({ phase: "failed", error });
    reply({});
    end(child);
    settle();
  };
  const giveUp = setTimeout(() => fail("The sign-in wasn't finished in time. Start it again."), opts.waitMs ?? WAIT_MS);
  giveUp.unref?.();
  const linkWait = setTimeout(() => reply(me.url ? { url: me.url } : {}), opts.linkMs ?? LINK_MS);
  linkWait.unref?.();

  const send = (o: Record<string, unknown>) => {
    try {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...o })}\n`);
    } catch {}
  };
  const heardLink = (url: string | null, open = false) => {
    if (!url || me.url) return;
    set({ url });
    reply(open ? { url, open: true } : { url });
  };
  const heard = (line: string) => {
    if (me.url || !/https:\/\//.test(line)) return;
    if (agy) heardLink(line.includes("accounts.google.com") ? agyLink(line.includes(PROMPT) ? line.slice(line.indexOf(PROMPT) + PROMPT.length) : line) : null);
    else if (me.phase === "waiting") heardLink(webLink(line));
  };
  let err = "";
  child.stderr?.on("data", (d: Buffer) => {
    err = (err + d.toString()).slice(-8_000);
    for (const l of d.toString().split(/\r?\n/)) heard(l);
  });
  child.on("error", () => fail(`${a.tool === "acp" ? "The agent" : tool} couldn't be started.`));
  child.on("exit", () => {
    clearTimeout(giveUp);
    clearTimeout(linkWait);
    if (mine() && me.phase !== "done" && me.phase !== "failed") {
      const last = err.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
      fail(`It stopped before the sign-in finished${last ? `: ${last.slice(0, 200)}` : "."}`);
    }
    settle();
  });
  child.stdin?.on("error", () => {});

  let caps: any = {};
  let methods: Method[] = [];
  let methodId = "";
  let buf = "";
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
        heard(line);
        continue;
      }
      if (m?.method && m.id !== undefined) {
        // A page it asks Friday to open for its sign-in (ACP's URL elicitation): handed to the page, which opens it.
        if (m.method === "elicitation/create" && m.params?.mode === "url" && me.phase === "waiting") {
          const url = agy ? agyLink(String(m.params.url ?? "")) : webLink(String(m.params.url ?? ""));
          if (url) {
            heardLink(url, true);
            send({ id: m.id, result: { action: "accept" } });
            continue;
          }
          send({ id: m.id, result: { action: "decline" } });
          continue;
        }
        // Nothing else it may ask for is part of signing in: turned down, so it never waits on an answer.
        send({ id: m.id, error: { code: -32601, message: "Not available while signing in." } });
        continue;
      }
      if (m?.id === 0) {
        if (m.error) return fail(String(m.error.message || "It couldn't start."));
        caps = m.result?.agentCapabilities ?? {};
        methods = Array.isArray(m.result?.authMethods) ? m.result.authMethods : [];
        if (agy) {
          const id = agyMethod(m.result);
          if (!id) return handBack({ fallback: true });
          methodId = id;
        } else {
          const how = pickMethod(m.result, launch);
          if (how && "terminal" in how) {
            noteTerminalSignIn(tool);
            reply(how);
            end(child);
            return settle();
          }
          const chosen = how ? methods.find((x) => x.id === how.agent) : undefined;
          // Nothing it does itself, or one that only says to run a command: the tool's own login command, else the terminal.
          if (!how || onlyTerminal(chosen)) return handBack(a.login.length ? { fixed: true } : { fallback: true });
          methodId = how.agent;
        }
        set({ phase: "waiting" });
        send({ id: 1, method: "authenticate", params: { methodId } });
      } else if (m?.id === 1) {
        if (m.error) {
          // A tool that doesn't take that method signs in its old way.
          if (!said && (m.error.code === -32601 || m.error.code === -32602)) return handBack(a.login.length ? { fixed: true } : { fallback: true });
          return fail(String(m.error.message || "The sign-in didn't finish."));
        }
        set({ phase: "verifying" });
        reply(me.url ? { url: me.url } : {});
        // Signed in is a conversation that opens.
        send({ id: 2, method: "session/new", params: { cwd: dir, mcpServers: [] } });
      } else if (m?.id === 2) {
        if (m.error) return fail(`Signed in, but it couldn't open a conversation: ${String(m.error.message || "it said no")}`);
        // Closed again where it can be, so it isn't left in the tool's history (ACP's session/close).
        if (caps?.sessionCapabilities?.close && m.result?.sessionId) send({ id: 3, method: "session/close", params: { sessionId: m.result.sessionId } });
        proven.add(tool);
        forgetLoginStatus();
        set({ phase: "done" });
        clearTimeout(giveUp);
        setTimeout(() => end(child), caps?.sessionCapabilities?.close ? 300 : 0).unref?.();
        settle();
      }
    }
  });
  send({
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: true }, elicitation: { url: {} } },
      clientInfo: { name: "friday", title: "Friday", version: "1" },
    },
  });
  return answered;
}
