import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CompatibleLLM } from "../src/agent/compatible.js";
import { ProviderError } from "../src/agent/llm.js";
import { startLocal } from "../src/local/start.js";

/**
 * Your own models in the open-source edition (Arun, 2026-10-26: "for open source let people also run their own models and stuff
 * too like we have for production"): a key, or a model on this computer, added in Settings › Your models, and Friday Code runs
 * on it. Friday's own models stay out, so a session on anything else waits for a coding tool as before.
 */

type Seen = { auth?: string; model?: string; text: string };
/** An OpenAI-format server that streams `reply` in pieces, after `busy` 429s, and says what it was asked. */
async function fakeServer(reply: string, o: { busy?: number; tool?: boolean } = {}) {
  const seen: Seen[] = [];
  let busy = o.busy ?? 0;
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") return void res.end(JSON.stringify({ data: [{ id: "fake-1" }] }));
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (busy-- > 0) return void (res.writeHead(429, { "retry-after": "0.01" }), res.end(JSON.stringify({ error: { message: "slow down" } })));
      const j = JSON.parse(body) as { model: string; messages: { role: string; content: unknown }[] };
      const user = j.messages.filter((m) => m.role === "user").at(-1);
      seen.push({ auth: req.headers.authorization, model: j.model, text: typeof user?.content === "string" ? user.content : JSON.stringify(user?.content) });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const part of reply.match(/.{1,6}/g) ?? []) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
      if (o.tool) res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "update_plan", arguments: "{\"steps\":" } }] } }] })}\n\n: keep-alive\n\ndata: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "[]}" } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: o.tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { seen, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("an OpenAI-format server's answer streams back with its tool calls; a key goes only when there is one, and a busy server is waited out", async (t) => {
  const fake = await fakeServer("Hello there.", { busy: 1, tool: true });
  t.after(fake.close);
  const said: string[] = [];
  const c = new CompatibleLLM({ baseUrl: `${fake.url}/`, model: "fake-1" });
  const r = await c.complete({ system: "Be brief.", messages: [{ role: "user", content: "Hi" }], tools: [], signal: AbortSignal.timeout(10_000), onDelta: (d) => said.push(d) });
  assert.equal(r.text, "Hello there.");
  assert.equal(said.join(""), "Hello there.", "as it is written");
  assert.deepEqual(r.toolCalls, [{ id: "c1", name: "update_plan", arguments: '{"steps":[]}' }]);
  assert.equal(r.usage?.total, 17);
  assert.equal(fake.seen.length, 1, "the 429 was asked again, once");
  assert.equal(fake.seen[0]!.auth, undefined, "a local server is sent no key");
  await new CompatibleLLM({ baseUrl: fake.url, model: "fake-1", apiKey: "sk-test-1234567890" }).complete({ system: "", messages: [{ role: "user", content: "Hi" }], tools: [], signal: AbortSignal.timeout(10_000) });
  assert.equal(fake.seen[1]!.auth, "Bearer sk-test-1234567890");
  await assert.rejects(c.search(), ProviderError, "it has no web search");
});

test("on this computer, a session on your own model runs Friday Code on it, and any other waits for a coding tool", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-own-"));
  // runner/own-models.ts keeps them in ~/.friday/models.json: this test's, never the real one.
  // USERPROFILE too: Windows finds the home folder there, and another test's models were read from the CI machine's own.
  const real = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, { HOME: home, USERPROFILE: home });
  const REPLY = "Hello from your own model.";
  const fake = await fakeServer(REPLY);
  const friday = await startLocal({ home: path.join(home, "friday"), port: 0 });
  t.after(async () => {
    await friday.close();
    await fake.close();
    for (const [k, v] of Object.entries(real)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
    // Windows may still hold a teammate's folder a moment after the app closes (EBUSY): a temp folder left behind is no failure.
    await rm(home, { recursive: true, force: true, maxRetries: 10 }).catch(() => {});
  });
  const call = async <T,>(p: string, json?: unknown): Promise<T> => {
    const r = await fetch(`${friday.url}${p}`, { method: json === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "x-friday-local": "1" }, ...(json === undefined ? {} : { body: JSON.stringify(json) }) });
    const text = await r.text();
    assert.ok(r.ok, `${p}: ${r.status} ${text}`);
    return JSON.parse(text) as T;
  };
  type Ev = { body: { type: string; text?: string; error?: string; outcome?: string } };
  const events = async (s: { sessionId: string; invites: { owner: string } }) => (await call<{ events: Ev[] }>(`/api/sessions/${s.sessionId}/history?invite=${encodeURIComponent(s.invites.owner)}&limit=200`)).events;
  const instruct = (s: { sessionId: string; invites: { owner: string } }, text: string) => call(`/api/sessions/${s.sessionId}/instruct?invite=${encodeURIComponent(s.invites.owner)}`, { text });
  type Made = { sessionId: string; invites: { owner: string } };

  const listed = await call<{ models: string[] }>("/api/runner/models.own.discover", { baseUrl: fake.url });
  assert.deepEqual(listed.models, ["fake-1"], "its models are listed through this computer's runner");
  const { model } = await call<{ model: { id: string; local: boolean } }>("/api/runner/models.own.save", { provider: "custom", baseUrl: fake.url, model: "fake-1", name: "Fake" });
  assert.ok(model.local);
  assert.equal((await call<{ reply: string }>("/api/runner/models.own.test", { id: model.id })).reply, REPLY, "Settings' Test asks it");

  const own = await call<Made>("/api/sessions", { title: "Own", model: `own:local:${model.id}` });
  const before = fake.seen.length;
  await instruct(own, "Say hello, please.");
  let ev: Ev[] = [];
  for (const end = Date.now() + 20_000; Date.now() < end && !ev.some((e) => e.body.type === "run.ended"); await new Promise((r) => setTimeout(r, 100))) ev = await events(own);
  const ended = ev.findLast((e) => e.body.type === "run.ended");
  assert.equal(ended?.body.outcome, "done", ended?.body.error);
  assert.equal(ev.find((e) => e.body.type === "agent.message")?.body.text, REPLY, "Friday Code's answer is the model's");
  assert.equal(fake.seen.length - before, 1);
  assert.match(fake.seen.at(-1)!.text, /Say hello, please\./, "with what was asked");

  // Anything else: no Friday agent here to run it, and not an error either. Somebody else's own model can't be chosen.
  const none = await call<Made>("/api/sessions", { title: "None", goal: "Do something." });
  const theirs = await call<Made>("/api/sessions", { title: "Theirs", model: "own:someone:abcd1234" });
  await instruct(theirs, "Hi");
  await new Promise((r) => setTimeout(r, 1500));
  for (const s of [none, theirs]) assert.ok(!(await events(s)).some((e) => e.body.type === "run.started" || e.body.type === "run.ended"), "it waits");
  assert.equal(fake.seen.length - before, 1, "and nothing more reached the model");
});
