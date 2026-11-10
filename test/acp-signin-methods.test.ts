// Signing in to an ACP tool by the ways it says it has (runner/acp-signin.ts), after T3 Code; and a sign-in proven by a
// conversation that opens, closed again where the tool can (runner/model-lists.ts openConversation). Stand-in tools answer
// `initialize` as real ones do: Kilo 7.8.27 ("Run `kilo auth login` in the terminal"), Copilot 1.0.103 (Zed's terminal-auth).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { acpSignInState, cancelAcpSignIn, pickMethod, startAcpSignIn, webLink } from "../src/runner/acp-signin.js";
import { loginStatus } from "../src/runner/adapters.js";
import { openConversation } from "../src/runner/model-lists.js";

type How = { methods?: unknown[]; caps?: unknown; authError?: { code: number; message: string }; elicit?: string; print?: string; sessionError?: string };
async function standIn(how: How): Promise<{ bin: string; dir: string; sent: () => string; go: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-acp-signin-"));
  const bin = path.join(dir, "agent.mjs");
  const go = path.join(dir, "go");
  await writeFile(
    bin,
    `import { existsSync, appendFileSync } from "node:fs";
const how = ${JSON.stringify(how)};
let buf = "";
const say = (o) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\\n");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    appendFileSync(${JSON.stringify(path.join(dir, "sent.txt"))}, (m.method ?? ("answer " + m.id + " " + JSON.stringify(m.result ?? m.error))) + " " + JSON.stringify(m.params?.methodId ?? m.params?.sessionId ?? "") + "\\n");
    if (m.method === "initialize") say({ id: m.id, result: { protocolVersion: 1, agentCapabilities: how.caps ?? {}, ...(how.methods ? { authMethods: how.methods } : {}) } });
    if (m.method === "authenticate") {
      if (how.authError) { say({ id: m.id, error: how.authError }); continue; }
      if (how.print) process.stderr.write(how.print + "\\n");
      if (how.elicit) say({ id: 50, method: "elicitation/create", params: { mode: "url", elicitationId: "e1", url: how.elicit, message: "Sign in" } });
      const t = setInterval(() => { if (existsSync(${JSON.stringify(go)})) { clearInterval(t); say({ id: m.id, result: {} }); } }, 50);
    }
    if (m.method === "session/new") say(how.sessionError ? { id: m.id, error: { code: -32000, message: how.sessionError } } : { id: m.id, result: { sessionId: "s9" } });
    if (m.method === "session/close") say({ id: m.id, result: {} });
  }
});
`,
  );
  return { bin, dir, sent: () => readFileSync(path.join(dir, "sent.txt"), "utf8"), go: () => writeFile(go, "") };
}
const until = async (f: () => boolean, ms = 8_000) => {
  const t0 = Date.now();
  while (!f() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 40));
  return f();
};

test("which way a tool signs in: its terminal sign-in first, then one it does itself, a key's never", () => {
  const launch = ["/usr/bin/node", "/x/agent.js", "--acp"];
  assert.deepEqual(pickMethod({ authMethods: [{ id: "oauth", name: "Google" }, { id: "term", type: "terminal", args: ["login"], env: { X: "1", "bad key": "y", N: 2 } }] }, launch), {
    terminal: { argv: [...launch, "login"], env: { X: "1" } },
    method: "term",
  });
  // Zed's way, as Copilot 1.0.103 lists it: only a command that is there.
  assert.deepEqual(pickMethod({ authMethods: [{ id: "copilot-login", _meta: { "terminal-auth": { command: process.execPath, args: ["login"] } } }] }, launch), {
    terminal: { argv: [process.execPath, "login"], env: {} },
    method: "copilot-login",
  });
  assert.deepEqual(pickMethod({ authMethods: [{ id: "copilot-login", _meta: { "terminal-auth": { command: "/nowhere/copilot", args: ["login"] } } }] }, launch), { agent: "copilot-login" });
  assert.deepEqual(pickMethod({ authMethods: [{ id: "gemini-api-key", name: "Use a key" }, { id: "oauth-personal", name: "Log in with Google" }, { id: "vertex-ai" }] }, launch), { agent: "oauth-personal" });
  assert.equal(pickMethod({ authMethods: [{ id: "api-key", type: "env_var", vars: [{ name: "K" }] }] }, launch), null);
  assert.equal(pickMethod({}, launch), null);
  assert.equal(webLink("Visit https://example.com/device?code=AB12. Then come back"), "https://example.com/device?code=AB12");
  assert.equal(webLink("http://example.com/login"), null, "never a page that isn't https");
  assert.equal(webLink("https://user:pw@example.com/"), null);
});

test("a terminal sign-in is handed back to run, and the tool's check speaks for itself meanwhile", async () => {
  const a = await standIn({ methods: [{ id: "login", name: "Log in", type: "terminal", args: ["auth", "login"] }] });
  try {
    const r = await startAcpSignIn("gemini", a.bin, { linkMs: 3_000 });
    assert.ok("terminal" in r, JSON.stringify(r));
    // The tool's own command as Friday starts it, then the method's arguments.
    assert.ok(r.terminal.argv.includes(a.bin), r.terminal.argv.join(" "));
    assert.deepEqual(r.terminal.argv.slice(-2), ["auth", "login"]);
    assert.equal(acpSignInState("gemini")?.phase, "terminal");
  } finally {
    await rm(a.dir, { recursive: true, force: true });
  }
});

test("a sign-in the tool does itself: the page it asks Friday to open is handed on, and a conversation proves it, closed after", async () => {
  const a = await standIn({ methods: [{ id: "oauth-personal", name: "Log in with Google" }], caps: { sessionCapabilities: { close: {} } }, elicit: "https://accounts.example.com/signin?x=1" });
  try {
    const r = await startAcpSignIn("gemini", a.bin, { linkMs: 5_000 });
    assert.deepEqual(r, { url: "https://accounts.example.com/signin?x=1", open: true });
    assert.equal(await loginStatus("gemini", "/nowhere/gemini"), false, "waiting: answered from here, no tool started");
    await a.go();
    assert.ok(await until(() => acpSignInState("gemini")?.phase === "done"));
    assert.equal(await loginStatus("gemini", "/nowhere/gemini"), true);
    assert.ok(await until(() => /session\/close "s9"/.test(a.sent())), a.sent());
    assert.match(a.sent(), /^initialize ""\nauthenticate "oauth-personal"\nanswer 50 \{"action":"accept"\} ""\nsession\/new ""\nsession\/close "s9"\n$/);
  } finally {
    await rm(a.dir, { recursive: true, force: true });
  }
});

test("a printed link counts too; one that only says to run a command goes to the tool's own login, or the terminal", async () => {
  const p = await standIn({ methods: [{ id: "device", name: "Sign in with your account" }], print: "Go to https://example.com/device and enter ABCD-1234" });
  try {
    assert.deepEqual(await startAcpSignIn("qwen", p.bin, { linkMs: 5_000 }), { url: "https://example.com/device" });
    cancelAcpSignIn("qwen");
    assert.equal(acpSignInState("qwen")?.error, "Stopped.");
  } finally {
    await rm(p.dir, { recursive: true, force: true });
  }
  // Kilo 7.8.27 lists only "Run `kilo auth login` in the terminal": its own login command, which Friday has.
  const k = await standIn({ methods: [{ id: "kilo-login", name: "Login with Kilo", description: "Run `kilo auth login` in the terminal" }] });
  try {
    assert.deepEqual(await startAcpSignIn("kilo", k.bin, { linkMs: 3_000 }), { fixed: true });
    assert.deepEqual(await startAcpSignIn("gemini", k.bin, { linkMs: 3_000 }), { fallback: true }, "no login command of its own: the terminal");
    assert.deepEqual(await startAcpSignIn("gemini", k.bin.replace("agent.mjs", "nope.mjs"), { linkMs: 3_000 }).catch(() => ({})), {}, "can't be started: nothing");
  } finally {
    await rm(k.dir, { recursive: true, force: true });
  }
  const key = await standIn({ methods: [{ id: "api-key", type: "env_var", vars: [{ name: "QWEN_KEY" }] }] });
  try {
    assert.deepEqual(await startAcpSignIn("qwen", key.bin, { linkMs: 3_000 }), { fallback: true }, "a key alone: as before");
  } finally {
    await rm(key.dir, { recursive: true, force: true });
  }
});

test("a sign-in that signs in but opens no conversation says so", async () => {
  const a = await standIn({ methods: [{ id: "oauth" }], sessionError: "Authentication required" });
  try {
    await startAcpSignIn("droid", a.bin, { linkMs: 1_000 });
    await a.go();
    assert.ok(await until(() => acpSignInState("droid")?.phase === "failed"));
    assert.match(acpSignInState("droid")!.error!, /Signed in, but it couldn't open a conversation: Authentication required/);
  } finally {
    await rm(a.dir, { recursive: true, force: true });
  }
});

test("a conversation opened to prove a sign-in or read models is closed again where the tool can, and says why when it can't open", async () => {
  const a = await standIn({ caps: { sessionCapabilities: { close: {} } } });
  try {
    assert.deepEqual(await openConversation("gemini", a.bin, 5_000), { ok: true, models: [] });
    assert.ok(await until(() => /session\/close "s9"/.test(a.sent())));
  } finally {
    await rm(a.dir, { recursive: true, force: true });
  }
  const b = await standIn({ sessionError: "Please sign in first" });
  try {
    assert.deepEqual(await openConversation("gemini", b.bin, 5_000), { ok: false, error: "Please sign in first", models: [] });
  } finally {
    await rm(b.dir, { recursive: true, force: true });
  }
});

test("a browser sign-in finished on another device: only this sign-in's own address, for its port and state, is sent on", async () => {
  const { callbackFromElsewhere, loopbackOf } = await import("../src/runner/acp-signin.js");
  const link = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A50123%2F&response_type=code&state=st8";
  assert.deepEqual(loopbackOf(link), { port: 50123, state: "st8" });
  assert.equal(loopbackOf("https://example.com/device"), null);
  const a = await standIn({ methods: [{ id: "oauth-personal" }], print: `Open the following link to authenticate the ACP server: ${link}` });
  const sent: string[] = [];
  const fetchImpl = (async (u: string | URL) => (sent.push(String(u)), new Response("ok"))) as typeof fetch;
  try {
    assert.equal((await startAcpSignIn("antigravity", a.bin, { linkMs: 5_000 }) as { url?: string }).url, link);
    for (const [pasted, said] of [
      ["not a url", /whole address/],
      ["http://127.0.0.1:9999/?code=c&state=st8", /isn't the one this sign-in sends the browser back to/],
      ["http://127.0.0.1:50123/?code=c&state=other", /from another sign-in/],
      ["http://127.0.0.1:50123/?state=st8", /no sign-in code/],
      ["http://evil.example:50123/?code=c&state=st8", /isn't the one/],
    ] as const)
      await assert.rejects(callbackFromElsewhere("antigravity", pasted, fetchImpl), said, pasted);
    assert.deepEqual(sent, [], "nothing sent for any of those");
    await callbackFromElsewhere("antigravity", " http://localhost:50123/?state=st8&code=4%2F0Ab&scope=x ", fetchImpl);
    assert.deepEqual(sent, ["http://127.0.0.1:50123/?state=st8&code=4%2F0Ab&scope=x"]);
    cancelAcpSignIn("antigravity");
    await assert.rejects(callbackFromElsewhere("antigravity", "http://127.0.0.1:50123/?code=c&state=st8", fetchImpl), /isn't waiting any more/);
  } finally {
    await rm(a.dir, { recursive: true, force: true });
  }
});

test("a tool that can't say whether it's signed in counts as signed in once Friday proved it, until it signs out", async () => {
  const { forgetProof, settleSignIn } = await import("../src/runner/acp-signin.js");
  const { ADAPTERS } = await import("../src/runner/adapters.js");
  const was = ADAPTERS.junie.status;
  // Junie as one whose check can't tell.
  (ADAPTERS.junie as { status?: unknown }).status = async () => null;
  try {
    assert.equal(await loginStatus("junie", "/nowhere/junie"), null);
    settleSignIn("junie", true);
    assert.equal(await loginStatus("junie", "/nowhere/junie"), true);
    forgetProof("junie");
    settleSignIn("junie", false, "no");
    assert.equal(await loginStatus("junie", "/nowhere/junie"), null);
  } finally {
    (ADAPTERS.junie as { status?: unknown }).status = was;
  }
});
