// Crew: a teammate on one of the person's own models, run by Friday Code (Arun, 2026-10-27: "be able to run your own models and
// stuff for teammates as well").
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { localKV } from "../src/local/kv.js";
import { NO_MODELS } from "../src/local/no-models.js";
import { MEMORY_FILE, cleanTeammate, teammateNote, type Teammate, type TeammateView } from "../src/teammates.js";
import type { SessionEvent } from "../src/types.js";

process.env.FRIDAY_MINE = "1";
process.env.FRIDAY_TEAMMATES_DRY = "1";

type Asked = { model: string; system: string; last: string; tools: string[] };
/**
 * An OpenAI-format model server, as Ollama or LM Studio run one: it says what it was asked, and answers by what the last message
 * says. "remember" has it call update_memory; "use up" answers as a provider whose allowance is spent; a tool's result, or
 * anything else, a short answer.
 */
async function fakeModel() {
  const asked: Asked[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") return void res.end(JSON.stringify({ data: [{ id: "fake-1" }] }));
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = JSON.parse(body) as { model: string; messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] };
      const lastMsg = j.messages.at(-1)!;
      const text = (m: { content: unknown }) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
      const system = j.messages.filter((m) => m.role === "system").map(text).join("\n");
      asked.push({ model: j.model, system, last: text(lastMsg), tools: (j.tools ?? []).map((t) => t.function.name) });
      if (lastMsg.role === "user" && /use up/i.test(text(lastMsg))) {
        res.writeHead(402, { "Content-Type": "application/json" });
        return void res.end(JSON.stringify({ error: { message: "You've hit your usage limit. Try again in 2 hours." } }));
      }
      const call = lastMsg.role === "user" && /remember/i.test(text(lastMsg));
      const reply = lastMsg.role === "tool" ? "Noted." : call ? "" : "Hi from your own model.";
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (reply) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`);
      if (call) res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "m1", function: { name: "update_memory", arguments: JSON.stringify({ add: "Arun likes tea." }) } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { asked, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("a teammate may run on its owner's own model only: never another person's, and with no coding tool's account, effort or backup", () => {
  const c = cleanTeammate({ name: "Ollie", tool: "friday", model: "own:local:abc123", effort: "high", backup: "codex", account: "work" }, undefined, "local");
  assert.deepEqual(c, { name: "Ollie", role: "", tool: "friday", model: "own:local:abc123" });
  assert.throws(() => cleanTeammate({ name: "Ollie", tool: "friday", model: "own:someone:abc123" }, undefined, "local"), /one of your own models/, "somebody else's");
  assert.throws(() => cleanTeammate({ name: "Ollie", tool: "friday", model: "own:local:abc123" }), /one of your own models/, "nobody said whose team it is");
  assert.throws(() => cleanTeammate({ name: "Ollie", tool: "friday", model: "gpt-5" }, undefined, "local"), /one of your own models/, "not an own model");
  assert.equal(cleanTeammate({ name: "Kit", tool: "claude", model: "own:local:abc123" }, undefined, "local").model, undefined, "a coding tool never gets an own model's id");
  const ollie: Teammate = { id: "t1", name: "Ollie", role: "Reads the issues", tool: "friday", model: "own:local:abc123", folder: "/u/Friday/teammates/Ollie", lane: "l1", created: 1 };
  const kit: Teammate = { id: "t2", name: "Kit", role: "Builds the site", tool: "codex", folder: "/u/Friday/teammates/Kit", lane: "l2", created: 2 };
  const note = teammateNote(ollie, [ollie, kit]);
  assert.match(note, /running on their own model, through Friday Code/);
  assert.match(note, /Add to it with update_memory/, "it keeps its memory with its own tool");
  assert.match(teammateNote(kit, [ollie, kit]), /Ollie \(own model: Reads the issues\)/, "the others see what it runs on");
});

test("on this computer: a teammate on your own model is made, run by Friday Code in its folder, reached by the team, and never switched for usage", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-team-own-"));
  // runner/own-models.ts keeps the models in ~/.friday/models.json: this test's, never the real one.
  // USERPROFILE too: Windows finds the home folder there, and another test's models were read from the CI machine's own.
  const real = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, { HOME: home, USERPROFILE: home });
  const fake = await fakeModel();
  const kv = await localKV(home);
  const app = await createApp({ port: 0, redisUrl: "", prefix: "friday:", secret: "s", driverGraceMs: 15_000, llm: NO_MODELS, dataDir: path.join(home, "uploads"), local: { redis: kv.redis, sub: kv.sub, user: { id: "local", name: "Me" } }, teammatesHome: home });
  t.after(async () => {
    await app.close();
    await kv.close();
    await fake.close();
    for (const [k, v] of Object.entries(real)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
    // Windows may still hold a teammate's folder a moment after the app closes (EBUSY): a temp folder left behind is no failure.
    await rm(home, { recursive: true, force: true, maxRetries: 10 }).catch(() => {});
  });
  type Team = { sid: string; teammates: TeammateView[]; rooms: { id: string; sid: string; lanes: Record<string, string> }[]; room?: string };
  const call = async <T = Team & { error?: string },>(p: string, method = "GET", json?: unknown): Promise<{ status: number; body: T }> => {
    const r = await fetch(`${app.url}${p}`, { method, headers: { "Content-Type": "application/json", "x-friday-local": "1" }, ...(json === undefined ? {} : { body: JSON.stringify(json) }) });
    return { status: r.status, body: (await r.json()) as T };
  };
  const me = { id: "local", name: "Me" };
  const until = async <X,>(what: string, f: () => Promise<X | null | undefined | false>, ms = 20_000): Promise<X> => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
      const x = await f();
      if (x) return x;
    }
    throw new Error(`timed out: ${what}`);
  };

  // A model set up in Settings › Your models, on this computer.
  const saved = await call<{ model: { id: string } }>("/api/runner/models.own.save", "POST", { provider: "custom", baseUrl: fake.url, model: "fake-1", name: "Fake Llama" });
  assert.equal(saved.status, 200);
  const model = `own:local:${saved.body.model.id}`;

  const team = (await call("/api/teammates")).body;
  const sid = team.sid;
  // A coding-tool teammate first, to lead and to message the other.
  const nova = (await call("/api/teammates", "POST", { name: "Nova", tool: "claude" })).body.teammates[0]!;

  // Not somebody else's, and not one that isn't set up here.
  assert.equal((await call("/api/teammates", "POST", { name: "Zed", tool: "friday", model: "own:someone:abc123" })).status, 400);
  const missing = await call("/api/teammates", "POST", { name: "Zed", tool: "friday", model: "own:local:nothere1" });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error ?? "", /isn't set up on this computer/);

  // As the dialog sends it: what it runs on is Your models, with the model picked; effort and backup as the form left them.
  const made = await call("/api/teammates", "POST", { name: "Ollie", role: "Reads the issues", tool: "friday", model, effort: "", backup: "", checkins: [], look: "Ollie", projects: [] });
  assert.equal(made.status, 200, made.body.error);
  const ollie = made.body.teammates.find((x) => x.name === "Ollie")!;
  assert.equal(ollie.tool, "friday");
  assert.equal(ollie.model, model);
  assert.equal(ollie.backup, undefined);
  const start = app.teammates.starts.at(-1)!;
  assert.equal(start.lane, ollie.lane);
  assert.equal(start.tool, undefined, "no coding tool is started for it");
  assert.equal(start.model, undefined, "its model is Friday Code's to run, not a runner's");
  assert.equal(start.cwd, ollie.folder, "its folder, lent to its lane");

  // Its folder attaches with no tool behind it, and it is online.
  await until("its folder attached", async () => {
    const e = (await app.store.state(sid)).engines[ollie.lane];
    return e?.online && !e.tool;
  });
  const view = await until("it is online", async () => (await call("/api/teammates")).body.teammates.find((x) => x.id === ollie.id && x.status === "idle"));
  assert.equal(view.problem, undefined);

  // What the person says in its chat is run by Friday Code, on that model, with who it is and its tools.
  const ran = async (lane: string, s = sid) => (await app.store.events(s)).filter((e) => e.body.type === "run.ended" && e.lane === lane);
  const before = fake.asked.length;
  await app.core.handle(sid, me, { type: "instruct", text: "Hello Ollie.", lane: ollie.lane });
  await until("its first run", async () => (await ran(ollie.lane)).length >= 1);
  const first = fake.asked[before]!;
  assert.equal(first.model, "fake-1", "the model it was put on");
  assert.match(first.system, /You are Ollie, one of the person's AI teammates/);
  assert.match(first.system, /Your role, in their words: Reads the issues/);
  for (const tool of ["message_agent", "ask_agent", "update_memory", "read_file"]) assert.ok(first.tools.includes(tool), `it has ${tool}`);
  const said = (await app.store.events(sid)).findLast((e) => e.body.type === "agent.message" && e.lane === ollie.lane);
  assert.equal(said?.body.type === "agent.message" && said.body.text, "Hi from your own model.");

  // Its memory, kept with its own tool, and read back with its next turn.
  await app.core.handle(sid, me, { type: "instruct", text: "Please remember I like tea.", lane: ollie.lane });
  await until("its second run", async () => (await ran(ollie.lane)).length >= 2);
  assert.match(await readFile(path.join(ollie.folder, MEMORY_FILE), "utf8"), /Arun likes tea\./);
  await app.core.handle(sid, me, { type: "instruct", text: "Thanks.", lane: ollie.lane });
  await until("its third run", async () => (await ran(ollie.lane)).length >= 3);
  assert.match(fake.asked.at(-1)!.system, /What it holds now:\nArun likes tea\./);

  // Another teammate's message reaches it, and it answers.
  const asked = fake.asked.length;
  const sent = await app.mesh.call(sid, nova.lane, "message_agent", { to: "Ollie", text: "Can you look at issue 12?" });
  assert.ok(!sent.isError, sent.output);
  await until("a run for Nova's message", async () => (await ran(ollie.lane)).length >= 4);
  assert.ok(fake.asked.slice(asked).some((a) => /issue 12/.test(a.last)), "Nova's message is what it was asked");

  // Agents may make one on the person's own model, by its name; never one the person hasn't got.
  const listed = await app.mesh.call(sid, nova.lane, "manage_teammate", { action: "list" });
  assert.match(listed.output, /Ollie: own model Fake Llama/);
  assert.match(listed.output, /own models a teammate can run on .*Fake Llama/);
  const byAgent = await app.mesh.call(sid, nova.lane, "manage_teammate", { action: "create", name: "Pip", tool: "friday", model: "fake llama" });
  assert.ok(!byAgent.isError, byAgent.output);
  assert.equal((await call("/api/teammates")).body.teammates.find((x) => x.name === "Pip")?.model, model);
  const nope = await app.mesh.call(sid, nova.lane, "manage_teammate", { action: "create", name: "Rex", tool: "friday", model: "gpt-9" });
  assert.ok(nope.isError);
  assert.match(nope.output, /by name: Fake Llama/);

  // In a room: a lane of its own there, run on its model, told the room it is in.
  const room = await call("/api/teammates/rooms", "POST", { name: "Issues", members: [ollie.id], purpose: "Triage" });
  assert.equal(room.status, 200, (room.body as { error?: string }).error);
  const r = room.body.rooms.find((x) => x.id === room.body.room)!;
  const roomLane = r.lanes[ollie.id]!;
  await until("its folder attached in the room", async () => (await app.store.state(r.sid)).engines[roomLane]?.online);
  await app.core.handle(r.sid, me, { type: "instruct", text: "What's first?", lane: roomLane });
  await until("its run in the room", async () => (await ran(roomLane, r.sid)).length >= 1);
  assert.match(fake.asked.at(-1)!.system, /You are in the room "Issues"/);

  // Its allowance spent at the provider: said in its chat, and never a switch to a coding tool.
  const starts = app.teammates.starts.length;
  await app.core.handle(sid, me, { type: "instruct", text: "Use up the rest.", lane: ollie.lane });
  const end = await until("the run that hit the limit", async () => (await ran(ollie.lane)).find((e) => e.body.type === "run.ended" && e.body.outcome === "error"));
  assert.match(end.body.type === "run.ended" ? (end.body.error ?? "") : "", /usage limit/);
  await new Promise((r2) => setTimeout(r2, 500));
  const events: SessionEvent[] = await app.store.events(sid);
  assert.ok(!events.some((e) => e.body.type === "teammate.switched"), "no switch");
  assert.ok(!app.teammates.starts.slice(starts).some((p) => p.tool), "no coding tool started for it");
  assert.equal((await call("/api/teammates")).body.teammates.find((x) => x.id === ollie.id)!.tool, "friday");

  // Edited as the dialog does: back to a coding tool (its own model's id never goes with it), and onto another own model.
  const onClaude = await call(`/api/teammates/${ollie.id}`, "PATCH", { tool: "claude", model: "auto" });
  assert.equal(onClaude.status, 200, onClaude.body.error);
  assert.equal(app.teammates.starts.at(-1)!.tool, "claude");
  const down = await call<{ model: { id: string } }>("/api/runner/models.own.save", "POST", { provider: "custom", baseUrl: "http://127.0.0.1:9/v1", model: "gone-1", name: "Off" });
  const offModel = `own:local:${down.body.model.id}`;
  const onOff = await call(`/api/teammates/${ollie.id}`, "PATCH", { tool: "friday", model: offModel });
  assert.equal(onOff.status, 200, onOff.body.error);
  assert.equal(app.teammates.starts.at(-1)!.tool, undefined);
  // A model server on this computer that doesn't answer: offline, and why.
  const off = (await call("/api/teammates")).body.teammates.find((x) => x.id === ollie.id)!;
  assert.equal(off.status, "offline");
  assert.match(off.problem ?? "", /Nothing answers at http:\/\/127\.0\.0\.1:9\/v1/);
});
