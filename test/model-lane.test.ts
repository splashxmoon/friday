// An agent on one of your own models, added to a coding session from Add an agent (model-lane.ts; Arun, 2026-11-20: "look into why i
// cannot load up my local models or api key based models into coding session as add agents"): the menu's rows, the runtime's answer
// for such a lane (laneOwn), and the whole path on this computer with a model server standing in.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { signInvite } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { mayAddModelLane, modelLaneName, modelLaneRows, sessionFolderHere } from "../src/client/model-lane-add.js";
import type { OwnChoice } from "../src/client/ownModelStore.js";
import { localKV } from "../src/local/kv.js";
import { NO_MODELS } from "../src/local/no-models.js";
import { laneOwnModel, ownLaneNote, ownLaneRun } from "../src/model-lane.js";
import { initialState, type LaneEngine, type SessionState } from "../src/session/projection.js";
import { MAIN_LANE, SESSION_LANES, type Lane } from "../src/types.js";

process.env.FRIDAY_TEAMMATES_DRY = "1";

const lane = (id: string, name: string, more: Partial<Lane> = {}): Lane => ({ id, name, agent: null, control: { kind: "open" }, controlMode: "ask", trigger: { kind: "manual" }, ...more });
const engine = (more: Partial<LaneEngine> = {}): LaneEngine => ({ hostId: "local", hostName: "Me", cwd: "/code/shop", mode: "full", online: true, sinceSeq: 1, ...more }) as LaneEngine;

/** A session of Me's on Claude Code, with an agent on one of Me's own models beside it. */
function session(): SessionState {
  const s = initialState("s1");
  s.ownerId = "local";
  s.title = "Checkout";
  s.lanes = [lane("lk", "kimi-k3.1-pro", { engine: true }), lane("lc", "Codex", { engine: true })];
  s.engines = { [MAIN_LANE]: engine({ tool: "claude" }), lk: engine({ model: "own:local:ab12cd34" }), lc: engine({ tool: "codex", model: "gpt-6" }) };
  return s;
}

test("laneOwn: an agent on the owner's own model runs on it, told who it is and who is with it; any other lane is not one", () => {
  const s = session();
  assert.equal(laneOwnModel(s, "lk"), "own:local:ab12cd34");
  const run = ownLaneRun(s, "lk")!;
  assert.equal(run.model, "own:local:ab12cd34");
  assert.match(run.note, /^You are kimi-k3\.1-pro, an agent the person added to the coding session "Checkout" beside Claude Code, Codex, running on one of their own models/);
  assert.match(run.note, /list_agents, message_agent and ask_agent/);
  assert.match(run.note, /claim_files/);
  // Not the main lane, not a coding tool's (whose model is its own CLI's), not a lane that has gone, not one with no model.
  assert.equal(ownLaneRun(s, MAIN_LANE), null);
  assert.equal(ownLaneRun(s, "lc"), null);
  assert.equal(ownLaneRun({ ...s, lanes: s.lanes.filter((l) => l.id !== "lk") }, "lk"), null);
  assert.equal(ownLaneRun({ ...s, engines: { ...s.engines, lk: engine() } }, "lk"), null);
  // Somebody else's own model is never run in Me's session.
  assert.equal(ownLaneRun({ ...s, engines: { ...s.engines, lk: engine({ model: "own:bea:ab12cd34" }) } }, "lk"), null);
  assert.equal(ownLaneRun({ ...s, ownerId: "bea" }, "lk"), null);
  assert.equal(ownLaneNote("Qwen", { title: "T", with: [] }).split("\n")[0], 'You are Qwen, an agent the person added to the coding session "T", running on one of their own models through Friday.');
});

const kimi: OwnChoice = { id: "ab12cd34", choice: "own:local:ab12cd34", name: "moonshotai/kimi-k3.1-pro", model: "moonshotai/kimi-k3.1-pro", baseUrl: "https://integrate.api.nvidia.com/v1", provider: "custom", hasKey: true, local: false, sees: false };
const llama: OwnChoice = { id: "ee55ff66", choice: "own:local:ee55ff66", name: "Llama at home", model: "llama3.1:8b", baseUrl: "http://localhost:11434/v1", provider: "ollama", hasKey: false, local: true, sees: false };

test("Add an agent: a Your models heading and a row per model, named and marked, its model on hover; none without models or rights", () => {
  const picked: string[] = [];
  const rows = modelLaneRows([kimi, llama], { may: true, full: false }, (m) => picked.push(m.choice));
  assert.deepEqual(rows[0], { heading: "Your models" });
  const [a, b] = rows.slice(1) as { label: string; title: string; mark: unknown; disabled?: boolean; hint?: string; onSelect: () => void }[];
  assert.equal(a!.label, "kimi-k3.1-pro", "the model's name without its maker");
  assert.equal(a!.title, "moonshotai/kimi-k3.1-pro · your key");
  assert.equal(b!.label, "Llama at home", "the name it was given");
  assert.equal(b!.title, "llama3.1:8b · on this computer");
  assert.ok(a!.mark && b!.mark, "each has its host's mark");
  assert.equal(a!.disabled, undefined);
  b!.onSelect();
  assert.deepEqual(picked, ["own:local:ee55ff66"]);
  // A full session says so on each row, and they can't be picked.
  const full = modelLaneRows([kimi], { may: true, full: true }, () => {}).slice(1) as { disabled?: boolean; hint?: string }[];
  assert.deepEqual([full[0]!.disabled, full[0]!.hint], [true, `${SESSION_LANES} is the most`]);
  assert.deepEqual(modelLaneRows([], { may: true, full: false }, () => {}), [], "no models, no group");
  assert.deepEqual(modelLaneRows([kimi], { may: false, full: false }, () => {}), [], "not theirs to add");
  assert.equal(modelLaneName({ name: "a".repeat(60), model: "x" }).length, 40, "a lane's name fits");

  // Only the session's owner, who may steer it, in a coding session; never a viewer, and not in a crew room.
  const s = session();
  assert.equal(mayAddModelLane(s, { id: "local", role: "owner" }, true), true);
  assert.equal(mayAddModelLane(s, { id: "local", role: "owner" }, false), false);
  assert.equal(mayAddModelLane(s, { id: "bea", role: "editor" }, true), false);
  assert.equal(mayAddModelLane({ ...s, options: { ...s.options, team: true } }, { id: "local", role: "owner" }, true), false);
  // Its folder: the session's own on this computer; none when the agents' folders are somebody else's or another computer's.
  assert.equal(sessionFolderHere(s, "local"), "/code/shop");
  assert.equal(sessionFolderHere(s, "bea"), null);
  assert.equal(sessionFolderHere({ ...s, engines: { [MAIN_LANE]: engine({ tool: "claude", computer: "0123456789abcdef" }) } }, "local"), null);
});

/** An OpenAI-format model server: says what it was asked, and answers "Hi from <model>." */
async function fakeModel() {
  const asked: { model: string; system: string; last: string; tools: string[] }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = JSON.parse(body || "{}") as { model: string; messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] };
      const text = (m: { content: unknown }) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
      asked.push({ model: j.model, system: j.messages.filter((m) => m.role === "system").map(text).join("\n"), last: text(j.messages.at(-1)!), tools: (j.tools ?? []).map((t) => t.function.name) });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `Hi from ${j.model}.` } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { asked, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("on this computer: added on your own model, it joins in the session's folder, answers on its lane, is reached by another agent, and swaps model in place", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-model-lane-"));
  // runner/own-models.ts keeps the models in ~/.friday/models.json: this test's, never the real one (USERPROFILE for Windows).
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
    await rm(home, { recursive: true, force: true, maxRetries: 10 }).catch(() => {});
  });
  const call = async <T = Record<string, unknown>,>(p: string, method = "GET", json?: unknown): Promise<{ status: number; body: T & { error?: string } }> => {
    const r = await fetch(`${app.url}${p}`, { method, headers: { "Content-Type": "application/json", "x-friday-local": "1" }, ...(json === undefined ? {} : { body: JSON.stringify(json) }) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as T & { error?: string } };
  };
  const until = async <X,>(what: string, f: () => Promise<X | null | undefined | false>, ms = 20_000): Promise<X> => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
      const x = await f();
      if (x) return x;
    }
    throw new Error(`timed out: ${what}`);
  };
  const me = { id: "local", name: "Me" };

  const saved = await call<{ model: { id: string } }>("/api/runner/models.own.save", "POST", { provider: "custom", baseUrl: fake.url, model: "fake-1" });
  assert.ok(saved.status < 300, saved.body.error);
  const model = `own:local:${saved.body.model.id}`;
  const sid = (await call<{ sessionId: string }>("/api/sessions", "POST", { title: "Checkout" })).body.sessionId;
  const invite = signInvite("s", sid, "owner");

  // Somebody else's own model is refused, and leaves no lane behind.
  const theirs = await call("/api/runner/start", "POST", { sid, invite, cwd: home, share: true, mode: "full", newLane: "fake-1", model: "own:bea:ab12cd34" });
  assert.ok(theirs.status >= 400, "refused");
  assert.match(theirs.body.error ?? "", /owner can add an agent on their own model/);
  assert.equal((await app.store.state(sid)).lanes.length, 0);

  // As the menu adds it: the session's folder lent to a new lane named after the model, its model with it.
  const added = await call<{ lane: string }>("/api/runner/start", "POST", { sid, invite, cwd: home, share: true, mode: "full", newLane: "fake-1", model });
  assert.ok(added.status < 300, added.body.error);
  const ln = added.body.lane;
  const st = await until("its folder attached", async () => ((s) => (s.engines[ln]?.online ? s : null))(await app.store.state(sid)));
  assert.equal(st.lanes.find((l) => l.id === ln)?.name, "fake-1");
  assert.equal(st.lanes.find((l) => l.id === ln)?.engine, true, "the person's own, which no plan limits");
  assert.deepEqual([st.engines[ln]!.tool, st.engines[ln]!.model, st.engines[ln]!.cwd, st.engines[ln]!.shared], [undefined, model, home, true]);

  // A message to it is run by Friday Code on that model, told who it is, with the agents' tools; its answer is on its lane.
  const ran = async (l: string) => (await app.store.events(sid)).filter((e) => e.body.type === "run.ended" && e.lane === l);
  await app.core.handle(sid, me, { type: "instruct", text: "Say hello.", lane: ln });
  await until("its first run", async () => (await ran(ln)).length >= 1);
  const first = fake.asked.at(-1)!;
  assert.equal(first.model, "fake-1");
  assert.match(first.system, /You are fake-1, an agent the person added to the coding session "Checkout"/);
  for (const tool of ["list_agents", "message_agent", "ask_agent", "claim_files", "read_file"]) assert.ok(first.tools.includes(tool), `it has ${tool}`);
  const said = (await app.store.events(sid)).findLast((e) => e.body.type === "agent.message" && e.lane === ln);
  assert.equal(said?.body.type === "agent.message" && said.body.text, "Hi from fake-1.");

  // Another agent reaches it by name, and it answers that agent.
  const asked = fake.asked.length;
  const answer = await app.mesh.call(sid, MAIN_LANE, "ask_agent", { to: "fake-1", question: "Which model are you?", wait_seconds: 30 });
  assert.ok(!answer.isError, answer.output);
  assert.match(answer.output, /Hi from fake-1\./);
  assert.ok(fake.asked.slice(asked).some((a) => /Which model are you\?/.test(a.last)), "the question is what it was asked");

  // Another of your models, picked in the box for it: the same folder and lane, the new model's from its next run.
  const other = await call<{ model: { id: string } }>("/api/runner/models.own.save", "POST", { provider: "custom", baseUrl: fake.url, model: "fake-2" });
  const model2 = `own:local:${other.body.model.id}`;
  const swapped = await call("/api/runner/start", "POST", { sid, invite, cwd: home, share: true, mode: "full", lane: ln, model: model2 });
  assert.ok(swapped.status < 300, swapped.body.error);
  await until("its new model", async () => (await app.store.state(sid)).engines[ln]?.model === model2 && (await app.store.state(sid)).engines[ln]?.online);
  const runs = (await ran(ln)).length;
  await app.core.handle(sid, me, { type: "instruct", text: "Again.", lane: ln });
  await until("its run on the new model", async () => (await ran(ln)).length > runs);
  assert.equal(fake.asked.at(-1)!.model, "fake-2");
});
