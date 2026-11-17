import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Arun, 2026-11-17: MCP servers set up once in Friday and handed to every coding tool (connections.ts).
process.env.FRIDAY_STATE_DIR = await mkdtemp(path.join(tmpdir(), "friday-conns-"));
const C = await import("../src/runner/connections.js");

test("a URL is a remote server, named after its host; /sse is the older transport", () => {
  assert.deepEqual(C.parseConnection("https://mcp.linear.app/mcp"), [{ name: "linear", transport: "http", url: "https://mcp.linear.app/mcp", needs: [] }]);
  assert.equal(C.parseConnection("https://example.com/sse")[0]!.transport, "sse");
});

test("claude mcp add lines: stdio with its env, http with its header, the key asked for and Bearer kept", () => {
  const [a] = C.parseConnection("claude mcp add github -e GITHUB_TOKEN=YOUR_TOKEN -- npx -y @modelcontextprotocol/server-github");
  assert.equal(a!.name, "github");
  assert.equal(a!.command, "npx");
  assert.deepEqual(a!.args, ["-y", "@modelcontextprotocol/server-github"]);
  assert.deepEqual(a!.needs, [{ where: "env", key: "GITHUB_TOKEN" }]);
  const [b] = C.parseConnection(`claude mcp add --transport http notion https://mcp.notion.com/mcp --header "Authorization: Bearer <your-token>"`);
  assert.equal(b!.transport, "http");
  assert.deepEqual(b!.needs, [{ where: "header", key: "Authorization", prefix: "Bearer " }]);
  const [c] = C.parseConnection(`claude mcp add-json weather '{"type":"stdio","command":"node","args":["w.js"],"env":{"API_KEY":"$WEATHER_KEY"}}'`);
  assert.equal(c!.name, "weather");
  assert.deepEqual(c!.needs, [{ where: "env", key: "API_KEY" }]);
});

test("a bare command: npx, uvx and docker named after what they run; docker -e NAME asked for", () => {
  assert.equal(C.parseConnection("npx -y @modelcontextprotocol/server-filesystem /tmp")[0]!.name, "filesystem");
  assert.equal(C.parseConnection("uvx mcp-server-fetch")[0]!.name, "fetch");
  assert.equal(C.parseConnection("node /srv/notion/mcp-server.js")[0]!.name, "notion");
  assert.equal(C.parseConnection("node ./dist/index.js")[0]!.name, "server");
  const [d] = C.parseConnection("docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server");
  assert.equal(d!.name, "github");
  assert.deepEqual(d!.needs, [{ where: "env", key: "GITHUB_PERSONAL_ACCESS_TOKEN" }]);
  const [e] = C.parseConnection("BRAVE_API_KEY=abc123 npx -y @brave/brave-search-mcp-server");
  assert.deepEqual(e!.env, { BRAVE_API_KEY: "abc123" });
  assert.deepEqual(e!.needs, []);
});

test("JSON: an mcpServers block of several, a map, one server; and plain words when it isn't any", () => {
  const two = C.parseConnection(JSON.stringify({ mcpServers: { a: { command: "node", args: ["a.js"] }, b: { url: "https://b.example/mcp", headers: { "X-Key": "${B_KEY}" } } } }));
  assert.deepEqual(two.map((d) => [d.name, d.transport, d.needs.length]), [["a", "stdio", 0], ["b", "http", 1]]);
  assert.equal(C.parseConnection(JSON.stringify({ command: "uvx", args: ["mcp-server-time"] }))[0]!.name, "time");
  assert.throws(() => C.parseConnection("{nope"), /doesn't read as JSON/);
  assert.throws(() => C.parseConnection("hello there, friend!"), /isn't an address, a command or JSON/);
  assert.throws(() => C.parseConnection("claude mcp list"), /Only `claude mcp add` lines/);
});

test("filling in what was asked for keeps Bearer, and leaves nothing to ask", () => {
  const [d] = C.parseConnection(`claude mcp add --transport http n https://x.example/mcp -H "Authorization: Bearer YOUR_KEY"`);
  const f = C.fillDraft(d!, { "header:Authorization": "s3cret" });
  assert.equal(f.headers!.Authorization, "Bearer s3cret");
  assert.deepEqual(f.needs, []);
});

/** A stand-in MCP server over stdio: answers initialize and tools/list, and nothing else. */
async function stdioStub(tools: string[]): Promise<string> {
  const f = path.join(process.env.FRIDAY_STATE_DIR!, `stub-${tools.length}.mjs`);
  await writeFile(
    f,
    `import { createInterface } from "node:readline";
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
for await (const l of createInterface({ input: process.stdin })) {
  const m = JSON.parse(l);
  if (m.method === "initialize") out({ id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1" } } });
  if (m.method === "tools/list") out({ id: m.id, result: { tools: ${JSON.stringify(tools.map((name) => ({ name, inputSchema: { type: "object" } })))} } });
}`,
  );
  return f;
}

test("testing a stdio server: its tools; one that isn't installed or quits says so plainly", async () => {
  const f = await stdioStub(["read", "write", "search"]);
  const ok = await C.testConnection({ transport: "stdio", command: process.execPath, args: [f] });
  assert.equal(ok.ok, true);
  assert.equal(ok.tools, 3);
  const missing = await C.testConnection({ transport: "stdio", command: "no-such-mcp-command-xyz", args: [] });
  assert.equal(missing.ok, false);
  assert.equal(missing.kind, "start");
  const quits = await C.testConnection({ transport: "stdio", command: process.execPath, args: ["-e", "process.exit(1)"] });
  assert.equal(quits.ok, false);
  assert.match(quits.error!, /stopped before it answered/);
});

/** A stand-in remote server: Streamable HTTP (JSON or an event stream), a key it checks, and the older SSE transport. */
function remoteStub(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.url === "/needs-key" && req.headers.authorization !== "Bearer good") return void res.writeHead(401).end();
    if (req.url === "/signin") return void res.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="https://x.example/.well-known/oauth-protected-resource"' }).end();
    if (req.url === "/sse" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: endpoint\ndata: /messages?s=1\n\n");
      (server as any).sse = res;
      return;
    }
    const m = body ? JSON.parse(body) : {};
    const answer = m.method === "initialize" ? { jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "r", version: "1" } } } : m.method === "tools/list" ? { jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "a" }, { name: "b" }] } } : null;
    if (req.url?.startsWith("/messages")) {
      if (answer) (server as any).sse.write(`event: message\ndata: ${JSON.stringify(answer)}\n\n`);
      return void res.writeHead(202).end();
    }
    if (!answer) return void res.writeHead(202).end();
    if (req.url === "/stream") return void res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "s1" }).end(`event: message\ndata: ${JSON.stringify(answer)}\n\n`);
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" }).end(JSON.stringify(answer));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${(server.address() as any).port}`, close: () => (server.closeAllConnections(), server.close()) })));
}

test("testing a remote server: JSON and event-stream answers, a refused key, a sign-in, and the older SSE transport", async () => {
  const s = await remoteStub();
  try {
    const first = await C.testConnection({ transport: "http", url: `${s.url}/mcp` });
    assert.equal(first.tools, 2, JSON.stringify(first));
    assert.equal((await C.testConnection({ transport: "http", url: `${s.url}/stream` })).tools, 2);
    const bad = await C.testConnection({ transport: "http", url: `${s.url}/needs-key`, headers: { Authorization: "Bearer wrong" } });
    assert.equal(bad.kind, "auth");
    assert.match(bad.error!, /refused the key/);
    assert.equal((await C.testConnection({ transport: "http", url: `${s.url}/needs-key`, headers: { Authorization: "Bearer good" } })).ok, true);
    assert.equal((await C.testConnection({ transport: "http", url: `${s.url}/signin` })).kind, "signin");
    assert.equal((await C.testConnection({ transport: "sse", url: `${s.url}/sse` })).tools, 2);
  } finally {
    s.close();
  }
});

test("added: on when it answers, off with its reason when it doesn't; kept in a file only this person can read, keys never in the view", async () => {
  const f = await stdioStub(["one"]);
  const good = await C.addConnection({ name: "friday", transport: "stdio", command: process.execPath, args: [f], env: { TOKEN: "secret-value" }, needs: [] });
  assert.equal(good.name, "friday-mcp", "Friday's own name is never taken");
  assert.equal(good.enabled, true);
  const bad = await C.addConnection({ name: "broken", transport: "stdio", command: "no-such-mcp-command-xyz", args: [], needs: [] });
  assert.equal(bad.enabled, false);
  assert.equal(bad.status!.ok, false);
  const file = path.join(process.env.FRIDAY_STATE_DIR!, "connections.json");
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
  const view = C.viewOf(good);
  assert.deepEqual(view.envKeys, ["TOKEN"]);
  assert.ok(!JSON.stringify(view).includes("secret-value"));
  await assert.rejects(C.addConnection({ name: "x", transport: "stdio", command: "npx", args: [], env: { K: "" }, needs: [{ where: "env", key: "K" }] }), /Fill in K first/);
});

test("handed to each tool: only those on; Claude Code a private file, Codex its keys in its environment and never on argv, ACP its list", async () => {
  const mounted = await C.mountedServers("codex");
  assert.deepEqual(mounted.map((m) => m.name), ["friday-mcp"]);
  const codex = C.codexMount([...mounted, { name: "remote", transport: "http", url: "https://r.example/mcp", headers: { Authorization: "Bearer tok-123" } }]);
  assert.ok(!codex.args.join(" ").includes("secret-value") && !codex.args.join(" ").includes("tok-123"), "no key on the command line");
  assert.ok(codex.args.includes('mcp_servers.friday-mcp.env_vars=["TOKEN"]'));
  assert.equal(codex.env.TOKEN, "secret-value");
  assert.ok(codex.args.some((a) => a.startsWith("mcp_servers.remote.env_http_headers=")));
  assert.equal(codex.env.FRIDAY_MCP_REMOTE_AUTHORIZATION, "Bearer tok-123");
  const file = await C.claudeMountFile(mounted, "t1");
  const j = JSON.parse(await readFile(file!, "utf8"));
  assert.equal(j.mcpServers["friday-mcp"].env.TOKEN, "secret-value");
  if (process.platform !== "win32") assert.equal((await stat(file!)).mode & 0o777, 0o600);
  assert.deepEqual(C.acpMount(mounted)[0], { name: "friday-mcp", command: process.execPath, args: mounted[0]!.args, env: [{ name: "TOKEN", value: "secret-value" }] });
});

test("each tool's command line carries them: Claude Code its file (allowed in Auto), Codex its settings with the keys in its environment", async () => {
  const { ADAPTERS, codexExec } = await import("../src/runner/adapters.js");
  const connections = { names: ["stub"], claudeFile: "/tmp/mcp-x.json", codexArgs: ["-c", "mcp_servers.stub.command=\"node\""], codexEnv: { STUB_TOKEN: "k" }, amp: { stub: { command: "node", args: [] } } };
  const t = { prompt: "hi", resumeId: null, mode: "full" as const, system: "", connections };
  const claude = ADAPTERS.claude.args(t);
  assert.ok(claude.join(" ").includes("--mcp-config /tmp/mcp-x.json"));
  assert.ok(claude.includes("mcp__stub"), "allowed in Auto like the person's own servers");
  assert.ok(!ADAPTERS.claude.args({ ...t, mode: "edits" as const }).includes("mcp__stub"), "asked about otherwise");
  for (const a of [ADAPTERS.codex, codexExec]) {
    const args = a.args(t);
    assert.ok(args.indexOf('mcp_servers.stub.command="node"') < args.indexOf(a === codexExec ? "exec" : "app-server"));
    assert.deepEqual(a.env?.(t), { STUB_TOKEN: "k" });
    assert.ok(!args.join(" ").includes("STUB_TOKEN=k"));
  }
  assert.ok(ADAPTERS.amp.args(t).some((x) => x.includes('"stub"')));
});

test("signing in with OAuth: discovery, registration, PKCE, the token used to test it and to hand it on, and refreshed before it runs out", async () => {
  const { createHash } = await import("node:crypto");
  let challenge = "";
  let issued = 0;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const u = new URL(req.url!, "http://x");
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const json = (o: unknown, code = 200) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(o));
    if (u.pathname === "/.well-known/oauth-protected-resource/mcp") return json({ resource: `${base}/mcp`, authorization_servers: [base] });
    if (u.pathname === "/.well-known/oauth-authorization-server") return json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register` });
    if (u.pathname === "/register") return json({ client_id: "friday-client" }, 201);
    if (u.pathname === "/token") {
      const f = new URLSearchParams(body);
      if (f.get("grant_type") === "authorization_code") {
        const ok = f.get("code") === "the-code" && createHash("sha256").update(f.get("code_verifier")!).digest("base64url") === challenge && f.get("client_id") === "friday-client";
        if (!ok) return json({ error: "invalid_grant" }, 400);
        return json({ access_token: `tok-${++issued}`, refresh_token: "r1", expires_in: 60 });
      }
      if (f.get("grant_type") === "refresh_token" && f.get("refresh_token") === "r1") return json({ access_token: `tok-${++issued}`, expires_in: 3600 });
      return json({ error: "invalid_grant" }, 400);
    }
    if (u.pathname === "/mcp") {
      if (!/^Bearer tok-/.test(String(req.headers.authorization))) return void res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` }).end();
      const m = body ? JSON.parse(body) : {};
      if (m.method === "initialize") return json({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "o", version: "1" } } });
      if (m.method === "tools/list") return json({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "issues" }] } });
      return void res.writeHead(202).end();
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const before = await C.testConnection({ transport: "http", url: `${base}/mcp` });
    assert.equal(before.kind, "signin", "a 401 pointing at its sign-in says so");
    const { authorizeUrl } = await C.startSignin({ url: `${base}/mcp`, name: "issues", catalog: "linear", redirect: "http://127.0.0.1:4321/api/mcp/signed-in" });
    const a = new URL(authorizeUrl);
    assert.equal(a.origin + a.pathname, `${base}/authorize`);
    assert.equal(a.searchParams.get("client_id"), "friday-client");
    assert.equal(a.searchParams.get("code_challenge_method"), "S256");
    assert.equal(a.searchParams.get("resource"), `${base}/mcp`);
    challenge = a.searchParams.get("code_challenge")!;
    const c = await C.finishSignin(a.searchParams.get("state")!, "the-code");
    assert.equal(c.status?.ok, true);
    assert.equal(c.enabled, true);
    assert.equal(c.catalog, "linear");
    assert.ok(!JSON.stringify(C.viewOf(c)).includes("tok-"), "the page never sees the token");
    assert.equal(C.viewOf(c).signedIn, true);
    await assert.rejects(C.finishSignin(a.searchParams.get("state")!, "the-code"), /expired/, "a state is used once");
    // Its token runs out in a minute: the next turn's hands on a fresh one.
    const mounted = (await C.mountedServers("codex")).find((m) => m.name === c.name)!;
    assert.equal(mounted.headers!.Authorization, "Bearer tok-2");
    const again = (await C.mountedServers("codex")).find((m) => m.name === c.name)!;
    assert.equal(again.headers!.Authorization, "Bearer tok-2", "and keeps it, rather than refreshing every turn");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("no resource named when the server's metadata doesn't name its own address (Cloudflare has none; Semgrep names its root and then refuses it)", async () => {
  const seen: { authorize?: URLSearchParams; token?: URLSearchParams } = {};
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const u = new URL(req.url!, "http://x");
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const json = (o: unknown, code = 200) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(o));
    // Its metadata names the root, not /sse.
    if (u.pathname === "/.well-known/oauth-protected-resource") return json({ resource: `${base}/`, authorization_servers: [base] });
    if (u.pathname === "/.well-known/oauth-authorization-server") return json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register` });
    if (u.pathname === "/register") return json({ client_id: "c1" }, 201);
    if (u.pathname === "/token") return (seen.token = new URLSearchParams(body)), json({ access_token: "tok-x", expires_in: 3600 });
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const { authorizeUrl } = await C.startSignin({ url: `${base}/sse`, name: "semgrepish", redirect: "http://127.0.0.1:4321/api/mcp/signed-in" });
    const a = new URL(authorizeUrl);
    assert.equal(a.searchParams.has("resource"), false, "not on the sign-in");
    await C.finishSignin(a.searchParams.get("state")!, "code", async () => ({ ok: true, at: Date.now(), tools: 1 }));
    assert.equal(seen.token?.has("resource"), false, "nor on the token request");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("Friday's own agent gets them too: each connected server's tools, called over MCP, its key reaching it", async (t0) => {
  const f = path.join(process.env.FRIDAY_STATE_DIR!, "callable.mjs");
  await writeFile(
    f,
    `import { createInterface } from "node:readline";
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
for await (const l of createInterface({ input: process.stdin })) {
  const m = JSON.parse(l);
  if (m.method === "initialize") out({ id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "c", version: "1" } } });
  if (m.method === "tools/list") out({ id: m.id, result: { tools: [{ name: "secret_word", description: "The secret word.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] } });
  if (m.method === "tools/call") out({ id: m.id, result: { content: [{ type: "text", text: "word: " + process.env.WORD }] } });
}`,
  );
  await C.addConnection({ name: "callable", transport: "stdio", command: process.execPath, args: [f], env: { WORD: "PLUM-44" }, needs: [] });
  const { closeConnectionTools, connectionTools } = await import("../src/connection-tools.js");
  t0.after(closeConnectionTools);
  const tools = await connectionTools();
  const t = tools.find((x) => x.name === "mcp__callable__secret_word");
  assert.ok(t, `its tool is offered: ${tools.map((x) => x.name).join(", ")}`);
  assert.equal(t!.cancellable, true, "a tool that only reads may be cut off");
  const r = await t!.run({}, { signal: new AbortController().signal } as never, "c1");
  assert.equal(r.output, "word: PLUM-44");
});
