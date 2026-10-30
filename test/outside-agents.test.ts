// Agents outside Friday driving it over MCP (Arun, 2026-10-30: Friday becomes the place agents hand work to): Claude Code, Codex,
// Cursor on this computer start sessions, steer them, read and wait on them, and answer what their agents ask, through the
// script Friday writes beside its data (local/outside-mcp.ts), with the token only this person can read.
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { createInterface } from "node:readline";
import test from "node:test";
import { outsideName, titleOf } from "../src/outside-agents.js";
import { outsideCommand, outsideSetup } from "../src/local/outside-mcp.js";

// Everything this file starts keeps to a folder of its own: the runner's state, the coding tool (a stand-in for Claude Code that
// answers each task with the marker in it), and the home folder, so nothing reads or writes the person's own.
const root = await mkdtemp(path.join(tmpdir(), "friday-outside-"));
process.env.HOME = path.join(root, "home");
process.env.USERPROFILE = process.env.HOME;
process.env.FRIDAY_STATE_DIR = path.join(root, "state");
process.env.FRIDAY_RUNNER_STATE = path.join(root, "runner-state.json");
await mkdir(process.env.HOME, { recursive: true });
const fake = path.join(root, "fake-claude.mjs");
await writeFile(
  fake,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (args[0] === "auth") { out({ loggedIn: true, authMethod: "claude.ai" }); process.exit(0); }
if (args.includes("--version")) { console.log("2.0.0 (Claude Code)"); process.exit(0); }
const sid = "fake-" + process.pid;
const answer = (input) => {
  const marks = input.match(/MARKER-\\w+/g) || [];
  const said = "Got " + (marks[marks.length - 1] || "nothing");
  out({ type: "assistant", message: { content: [{ type: "text", text: said }] }, parent_tool_use_id: null, session_id: sid });
  out({ type: "result", subtype: "success", is_error: false, result: said, session_id: sid });
};
out({ type: "system", subtype: "init", session_id: sid, cwd: process.cwd() });
let input = "";
if (args.includes("--input-format")) {
  // Kept running, a turn a line, each read said back (--replay-user-messages), as Claude Code does.
  process.stdin.on("data", (d) => {
    input += d;
    let i;
    while ((i = input.indexOf("\\n")) >= 0) {
      const line = input.slice(0, i);
      input = input.slice(i + 1);
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.type !== "user") continue;
      out({ ...m, session_id: sid });
      answer(typeof m.message.content === "string" ? m.message.content : JSON.stringify(m.message.content));
    }
  });
} else {
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => answer(input));
}
`,
);
await chmod(fake, 0o755);
process.env.FRIDAY_CLAUDE_BIN = fake;
const { startLocal } = await import("../src/local/start.js");
test.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

/** An MCP client over the script's stdin and stdout, as an outside agent starts it. */
function client(shim: string, env: Record<string, string> = {}) {
  const p: ChildProcessWithoutNullStreams = spawn(process.execPath, [shim], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map<number, (m: { result?: { content?: { text: string }[]; isError?: boolean; tools?: { name: string }[]; instructions?: string }; error?: unknown }) => void>();
  createInterface({ input: p.stdout }).on("line", (l) => {
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m);
    waiting.delete(m.id);
  });
  let n = 0;
  const rpc = (method: string, params: unknown) =>
    new Promise<Parameters<NonNullable<ReturnType<typeof waiting.get>>>[0]>((resolve) => {
      const id = ++n;
      waiting.set(id, resolve);
      p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await rpc("tools/call", { name, arguments: args })).result!;
    const text = r.content?.[0]?.text ?? "";
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text);
    } catch {
      // Refusals are said in words.
    }
    return { text, json, isError: r.isError === true };
  };
  return { rpc, call, close: () => p.kill() };
}

test("names, titles and statuses as an outside agent reads them", () => {
  assert.equal(outsideName("claude-code"), "Claude Code");
  assert.equal(outsideName("codex-mcp-client"), "Codex");
  assert.equal(outsideName("cursor-vscode"), "Cursor");
  assert.equal(outsideName("my-bot<script>"), "my-botscript");
  assert.equal(outsideName(""), "An outside agent");
  assert.equal(titleOf("Fix the flaky checkout test in the payments package and make sure it passes on CI every time\nmore"), "Fix the flaky checkout test in the payments package and…");
  const lines = outsideSetup(outsideCommand("/Users/a b/.friday/outside-mcp.mjs", "/usr/local/bin/node", false));
  // Quoted for the shell it is pasted into: PowerShell or cmd on Windows, a POSIX shell elsewhere.
  const shim = process.platform === "win32" ? '"/Users/a b/.friday/outside-mcp.mjs"' : "'/Users/a b/.friday/outside-mcp.mjs'";
  assert.equal(lines.claude.line, `claude mcp add friday --scope user -- /usr/local/bin/node ${shim}`);
  assert.equal(lines.codex.line, `codex mcp add friday -- /usr/local/bin/node ${shim}`);
  assert.match(lines.codex.toml, /^\[mcp_servers\.friday\]\ncommand = "\/usr\/local\/bin\/node"\nargs = \["\/Users\/a b\/\.friday\/outside-mcp\.mjs"\]\ntool_timeout_sec = 660$/);
  assert.deepEqual(JSON.parse(lines.cursor.json), { mcpServers: { friday: { command: "/usr/local/bin/node", args: ["/Users/a b/.friday/outside-mcp.mjs"] } } });
  // The desktop app is a Node only when told so.
  const desk = outsideSetup(outsideCommand("/x/outside-mcp.mjs", "/Applications/Friday.app/Contents/MacOS/Friday", true));
  assert.equal(desk.claude.line, "claude mcp add friday --scope user --env ELECTRON_RUN_AS_NODE=1 -- /Applications/Friday.app/Contents/MacOS/Friday /x/outside-mcp.mjs");
  assert.match(desk.codex.toml, /env = \{ ELECTRON_RUN_AS_NODE = "1" \}/);
});

test("only an agent on this computer with this install's token gets in: not a page, not another site, not a wrong token", async (t) => {
  const home = path.join(root, "auth");
  const friday = await startLocal({ home, port: 0 });
  t.after(() => friday.close());
  const token = (await readFile(path.join(home, "outside-token"), "utf8")).trim();
  assert.ok(token.length >= 40);
  if (process.platform !== "win32") assert.equal((await stat(path.join(home, "outside-token"))).mode & 0o077, 0, "nobody but this person can read it");
  const shim = await readFile(path.join(home, "outside-mcp.mjs"), "utf8");
  assert.ok(!shim.includes(token), "the script holds no secret: it reads the token when it calls");

  const call = (headers: Record<string, string>) =>
    fetch(`${friday.url}/api/outside/call`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ name: "list_sessions", arguments: {}, agent: "claude-code" }) });
  assert.equal((await call({})).status, 401, "no token");
  assert.equal((await call({ authorization: `Bearer ${"x".repeat(token.length)}` })).status, 401, "a wrong one");
  assert.equal((await call({ authorization: `Bearer ${token}`, origin: "https://evil.example" })).status, 403, "a page on another site");
  assert.equal((await call({ authorization: `Bearer ${token}`, origin: friday.url })).status, 403, "even Friday's own page: only an agent");
  // fetch won't send a Host of its own choosing; a page that rebinds its name to 127.0.0.1 would.
  const rebound = await new Promise<number>((resolve, reject) => {
    const u = new URL(friday.url);
    const req = http.request({ host: "127.0.0.1", port: u.port, path: "/api/outside/call", method: "POST", headers: { host: `evil.example:${u.port}`, authorization: `Bearer ${token}`, "content-type": "application/json" } }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
    req.on("error", reject);
    req.end(JSON.stringify({ name: "list_sessions" }));
  });
  assert.equal(rebound, 403, "another name for this computer (DNS rebinding)");
  const ok = await call({ authorization: `Bearer ${token}` });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(JSON.parse((await ok.text()).trim()).output), { sessions: [] });

  // Settings' lines, for Friday's own page.
  const setup = (await (await fetch(`${friday.url}/api/outside/setup`, { headers: { "x-friday-local": "1" } })).json()) as { claude: { line: string }; codex: { toml: string }; shim: string };
  assert.equal(setup.shim, path.join(home, "outside-mcp.mjs"));
  assert.ok(setup.claude.line.startsWith("claude mcp add friday --scope user -- "), setup.claude.line);
  assert.ok(setup.claude.line.replace(/["']$/, "").endsWith(path.join(home, "outside-mcp.mjs")), setup.claude.line);
  const add = await fetch(`${friday.url}/api/outside/setup`, { method: "POST", headers: { "content-type": "application/json", "x-friday-local": "1" }, body: JSON.stringify({ tool: "cursor" }) });
  assert.equal(add.status, 400, "Cursor has no mcp add: its file only");
});

test("an outside agent starts a session, waits for it, steers it and reads it back, and Friday shows it came from that agent", async (t) => {
  const home = path.join(root, "e2e");
  const folder = path.join(root, "project");
  await mkdir(folder, { recursive: true });
  const friday = await startLocal({ home, port: 0 });
  t.after(() => friday.close());
  const mcp = client(path.join(home, "outside-mcp.mjs"));
  t.after(() => mcp.close());

  const init = (await mcp.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.0.0" } })).result!;
  assert.match(init.instructions ?? "", /Hand work to it with start_session/);
  const tools = (await mcp.rpc("tools/list", {})).result!.tools!.map((x) => x.name);
  assert.deepEqual(tools, ["list_sessions", "start_session", "send_message", "read_session", "wait_for_idle", "answer", "list_teammates", "ask_teammate"]);

  assert.ok((await mcp.call("start_session", { prompt: "x", folder: path.join(root, "nope") })).isError, "a folder that isn't there");
  assert.ok((await mcp.call("start_session", { prompt: "x", tool: "notatool" })).isError, "a tool that isn't one");
  const started = await mcp.call("start_session", { prompt: "Write MARKER-one in the notes", tool: "claude", folder });
  assert.ok(!started.isError, started.text);
  const sid = started.json.id as string;
  assert.equal(started.json.tool, "claude");

  const waited = await mcp.call("wait_for_idle", { session: sid, timeout_seconds: 60 });
  assert.equal(waited.json.status, "idle", waited.text);
  const replies = (m: unknown) => (m as { kind: string; text: string }[]).filter((x) => x.kind === "agent_reply").map((x) => x.text);
  assert.ok(replies(waited.json.messages).includes("Got MARKER-one"), waited.text);
  const sent = await mcp.call("send_message", { session: sid, text: "Now MARKER-two" });
  assert.ok(!sent.isError, sent.text);
  const again = await mcp.call("wait_for_idle", { session: sid, timeout_seconds: 60 });
  assert.equal(again.json.status, "idle", again.text);
  assert.ok(replies(again.json.messages).includes("Got MARKER-two"), again.text);

  const read = await mcp.call("read_session", { session: sid });
  assert.equal(read.json.kind, "code");
  assert.deepEqual(replies(read.json.messages), ["Got MARKER-one", "Got MARKER-two"]);
  const asked = (read.json.messages as { kind: string; from: string; text: string }[]).filter((x) => x.kind === "to_agent");
  assert.deepEqual(asked.map((x) => x.text), ["Write MARKER-one in the notes", "Now MARKER-two"]);
  for (const x of asked) assert.match(x.from, /^Claude Code, for /, "the session says who sent it");
  assert.equal((read.json.agents as { tool: string; status: string }[])[0]!.tool, "claude");
  assert.equal((read.json.agents as { tool: string; status: string }[])[0]!.status, "idle");
  const page = await mcp.call("read_session", { session: sid, after: read.json.next_after as number });
  assert.deepEqual(page.json.messages, [], "nothing new after the last read");

  const listed = await mcp.call("list_sessions");
  assert.deepEqual((listed.json.sessions as { id: string }[]).map((s) => s.id), [sid]);
  assert.ok((await mcp.call("answer", { session: sid, approve: true })).isError, "nothing is asking");
  assert.match((await mcp.call("list_teammates")).text, /No Crew yet/);
  assert.ok((await mcp.call("read_session", { session: "no-such-session" })).isError);

  // Friday closed: the agent is told so, and its tools still list.
  await friday.close();
  assert.match((await mcp.call("list_sessions")).text, /Friday isn't running/);
  assert.equal((await mcp.rpc("tools/list", {})).result!.tools!.length, 8);
});

test("an outside agent sees what waits on the person and answers it, and the session says which agent did", async (t) => {
  const { createApp } = await import("../src/app.js");
  const { localKV } = await import("../src/local/kv.js");
  const { NO_MODELS } = await import("../src/local/no-models.js");
  const home = path.join(root, "approve");
  const kv = await localKV(home);
  const token = "t".repeat(43);
  // Teammates said to start rather than started (app.ts teammateStarts), so no coding tool runs for the Crew here.
  process.env.FRIDAY_TEAMMATES_DRY = "1";
  const app = await createApp({ port: 0, redisUrl: "", prefix: "friday:", secret: "s", driverGraceMs: 15_000, llm: NO_MODELS, dataDir: path.join(home, "uploads"), local: { redis: kv.redis, sub: kv.sub, user: { id: "local", name: "Ada" }, outside: { token, shim: path.join(home, "outside-mcp.mjs") } }, teammatesHome: home });
  t.after(async () => (await app.close(), await kv.close()));
  const call = async (name: string, args: Record<string, unknown>, agent = "codex-mcp-client") => {
    const r = await fetch(`${app.url}/api/outside/call`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ name, arguments: args, agent }) });
    const j = JSON.parse((await r.text()).trim()) as { output: string; isError?: boolean };
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(j.output);
    } catch {
      // words
    }
    return { ...j, json };
  };
  const r = await fetch(`${app.url}/api/sessions`, { method: "POST", headers: { "content-type": "application/json", "x-friday-local": "1" }, body: JSON.stringify({ title: "Deploy the docs" }) });
  const { sessionId: sid } = (await r.json()) as { sessionId: string };
  // A coding tool asking before it runs a command, as its runner reports it.
  await app.store.append(sid, { id: "agent", name: "Claude Code", kind: "agent" }, { type: "engine.approval", id: "ap1", tool: "claude", scope: "commands", items: ["npm run deploy"] });

  const read = await call("read_session", { session: "Deploy the docs" });
  const waiting = read.json.waiting as { kind: string; asks_to?: string[]; how: string }[];
  assert.equal(waiting[0]?.kind, "approval", read.output);
  assert.deepEqual(waiting[0]?.asks_to, ["npm run deploy"]);
  assert.equal((await call("wait_for_idle", { session: sid, timeout_seconds: 5 })).json.status, "needs_you", "a wait ends on what needs the person");
  assert.equal((await call("list_sessions", {})).json.sessions && ((await call("list_sessions", {})).json.sessions as { waiting: string[] }[])[0]!.waiting.length, 1);

  const yes = await call("answer", { session: sid, approve: true });
  assert.ok(!yes.isError, yes.output);
  const said = (await app.store.events(sid)).find((e) => e.body.type === "instruction" && e.body.approval?.id === "ap1");
  assert.equal(said?.actor.id, "local", "it acts as the person");
  assert.equal(said?.actor.via, "Codex", "and says which agent it was");
  assert.equal((await app.store.state(sid)).approvals.main, undefined, "the request is answered");
  assert.ok((await call("answer", { session: sid, approve: false })).isError, "answered once only");

  // A note for the people, not the agent, also from the agent.
  const note = await call("send_message", { session: sid, text: "Deployed, have a look", to: "people" }, "cursor-vscode");
  assert.ok(!note.isError, note.output);
  const chat = (await app.store.events(sid)).find((e) => e.body.type === "chat");
  assert.equal(chat?.actor.via, "Cursor");

  // The Crew: listed, and a teammate asked in its room, as from the agent.
  const nova = path.join(home, "nova");
  await mkdir(nova, { recursive: true });
  const added = await fetch(`${app.url}/api/teammates`, { method: "POST", headers: { "content-type": "application/json", "x-friday-local": "1" }, body: JSON.stringify({ name: "Nova", role: "Writes the launch posts", tool: "claude", folder: nova }) });
  assert.equal(added.status, 200, await added.clone().text());
  const crew = await call("list_teammates", {});
  assert.deepEqual((crew.json.teammates as { name: string; role: string; tool: string }[]).map((m) => [m.name, m.role, m.tool]), [["Nova", "Writes the launch posts", "claude"]]);
  assert.ok((await call("ask_teammate", { name: "Pip", text: "hi" })).isError, "nobody by that name");
  const asked = await call("ask_teammate", { name: "nova", text: "Draft the launch thread", wait_seconds: 0 }, "claude-code");
  assert.ok(!asked.isError, asked.output);
  const room = crew.json.room as string;
  const toNova = (await app.store.events(room)).find((e) => e.body.type === "instruction" && e.body.text === "Draft the launch thread");
  assert.equal(toNova?.actor.via, "Claude Code");
});

