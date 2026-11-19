// Friday in Slack, from this computer (spec 08, Arun 2026-11-18): over Socket Mode, an @mention, a DM or `/friday` becomes a
// thread here; plain replies in the Slack thread steer it; one status message shows the tool, its step and plan, with Stop; the
// answer goes to the thread; a teammate's ask waits for the person's Start in their DMs. Slack is a stand-in: its Web API, which
// keeps what Friday posted, and a Socket Mode WebSocket that sends events and checks each is acknowledged.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { cutForSlack, plainSlack, slackManifest, toMrkdwn, withoutMention } from "../src/channels/slack.js";
import { writeFakeClaude } from "./fake-claude.js";

const root = await mkdtemp(path.join(tmpdir(), "friday-slack-"));
process.env.HOME = path.join(root, "home");
process.env.USERPROFILE = process.env.HOME;
process.env.FRIDAY_STATE_DIR = path.join(root, "state");
process.env.FRIDAY_RUNNER_STATE = path.join(root, "runner-state.json");
process.env.FRIDAY_NO_TELEMETRY = "1";
await mkdir(process.env.HOME, { recursive: true });
process.env.FRIDAY_CLAUDE_BIN = await writeFakeClaude(root);

// ── Slack's stand-in ───────────────────────────────────────────────────────────────────────────────────────────────────
type Msg = { channel: string; ts: string; text: string; thread_ts?: string; blocks?: { type: string; text?: { text: string }; elements?: { value?: string; text?: { text: string } }[] }[]; updated?: number };
const slack = { msgs: [] as Msg[], acks: new Set<string>(), responses: [] as { text: string }[] };
let tsN = 1000;
const nextTs = () => `${tsN++}.000100`;
const people: Record<string, { id: string; name: string; profile: { display_name: string; email: string } }> = {
  UADA: { id: "UADA", name: "ada", profile: { display_name: "Ada", email: "ada@x.dev" } },
  USAM: { id: "USAM", name: "sam", profile: { display_name: "Sam", email: "sam@x.dev" } },
};
let socket: WebSocket | null = null;
const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws) => {
  socket = ws;
  ws.on("message", (raw) => slack.acks.add(String(JSON.parse(String(raw)).envelope_id)));
  ws.send(JSON.stringify({ type: "hello" }));
});
const stand = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const send = (o: unknown) => (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify(o)));
    if (req.url === "/respond") return (slack.responses.push(JSON.parse(raw)), send({ ok: true }));
    const method = (req.url ?? "").replace(/^\/api\//, "");
    const auth = String(req.headers.authorization ?? "");
    const a = raw ? (JSON.parse(raw) as Record<string, any>) : {};
    if (method === "apps.connections.open") return send(auth === "Bearer xapp-good" ? { ok: true, url: `ws://127.0.0.1:${port}/socket` } : { ok: false, error: "invalid_auth" });
    if (auth !== "Bearer xoxb-good") return send({ ok: false, error: "invalid_auth" });
    if (method === "auth.test") return send({ ok: true, team: "Acme", team_id: "T1", user_id: "UBOT", url: "https://acme.slack.com/" });
    if (method === "chat.postMessage") {
      const m: Msg = { channel: a.channel, ts: nextTs(), text: a.text, ...(a.thread_ts ? { thread_ts: a.thread_ts } : {}), ...(a.blocks ? { blocks: a.blocks } : {}) };
      slack.msgs.push(m);
      return send({ ok: true, ts: m.ts, channel: a.channel });
    }
    if (method === "chat.update") {
      const m = slack.msgs.find((x) => x.channel === a.channel && x.ts === a.ts);
      if (m) Object.assign(m, { text: a.text, blocks: a.blocks, updated: (m.updated ?? 0) + 1 });
      return send({ ok: !!m, ...(m ? {} : { error: "message_not_found" }) });
    }
    if (method === "chat.postEphemeral") return send({ ok: true });
    if (method === "chat.getPermalink") return send({ ok: true, permalink: `https://acme.slack.com/archives/${a.channel}/p${String(a.message_ts).replace(".", "")}` });
    if (method === "users.info") return send({ ok: true, user: people[a.user] });
    if (method === "users.list") return send({ ok: true, members: [...Object.values(people), { id: "UBOT", name: "friday", is_bot: true }] });
    if (method === "conversations.open") return send({ ok: true, channel: { id: `D-${a.users}` } });
    if (method === "conversations.replies") return send({ ok: true, messages: slack.msgs.filter((m) => m.ts === a.ts || m.thread_ts === a.ts) });
    return send({ ok: false, error: "unknown_method" });
  });
});
stand.on("upgrade", (req, sock, head) => wss.handleUpgrade(req, sock, head, (ws) => wss.emit("connection", ws, req)));
await new Promise<void>((r) => stand.listen(0, "127.0.0.1", r));
const port = (stand.address() as { port: number }).port;
process.env.FRIDAY_SLACK_URL = `http://127.0.0.1:${port}/api`;
test.after(() => (wss.close(), stand.close()));

let env = 0;
/** An envelope down the socket, and Friday's acknowledgement of it. */
async function deliver(type: string, payload: Record<string, unknown>) {
  const id = `env-${env++}`;
  socket!.send(JSON.stringify({ envelope_id: id, type, payload }));
  await until(() => slack.acks.has(id), `the ack of ${type}`, 3000);
}
const event = (e: Record<string, unknown>) => deliver("events_api", { event: e });
const click = (user: string, channel: string, m: Msg, label: string) => {
  const b = m.blocks?.flatMap((x) => x.elements ?? []).find((el) => el.text?.text === label);
  assert.ok(b, `a "${label}" button on: ${m.text}`);
  return deliver("interactive", { type: "block_actions", user: { id: user }, channel: { id: channel }, message: { ts: m.ts, ...(m.thread_ts ? { thread_ts: m.thread_ts } : {}) }, actions: [{ action_id: "x", value: b.value }] });
};
const inThread = (ts: string) => slack.msgs.filter((m) => m.thread_ts === ts);
const words = (m: Msg) => [m.text, ...(m.blocks ?? []).map((b) => b.text?.text ?? "")].join("\n");

async function until<T>(f: () => T | Promise<T>, what: string, ms = 30_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(slack.msgs.map((m) => [m.channel, m.thread_ts ?? "-", m.text]))}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("Slack's words in and Friday's out", () => {
  assert.equal(withoutMention("<@UBOT> fix the test", "UBOT"), "fix the test");
  assert.equal(plainSlack("see <https://x.dev|the docs> in <#C1|web>"), "see the docs (https://x.dev) in #web");
  assert.equal(toMrkdwn("## Done\n**Fixed** the [cart](https://x.dev/pr/1) & tests\n- one\n`a<b`"), "*Done*\n*Fixed* the <https://x.dev/pr/1|cart> &amp; tests\n• one\n`a<b`");
  assert.equal(toMrkdwn("```ts\nconst a = 1 < 2;\n```"), "```\nconst a = 1 < 2;\n```", "code kept as code");
  assert.ok(cutForSlack("x\n".repeat(3000)).length <= 2802);
  const m = slackManifest();
  assert.equal(m.settings.socket_mode_enabled, true, "nothing has to reach this computer");
  assert.ok(m.settings.event_subscriptions.bot_events.includes("message.channels"), "thread replies come too");
  assert.deepEqual(m.features.slash_commands.map((c) => c.command), ["/friday"]);
});

test("a mention, a thread reply, a DM, /friday, a teammate's ask and Stop, through Socket Mode", async (t) => {
  const { startLocal } = await import("../src/local/start.js");
  const home = path.join(root, "friday");
  const web = path.join(root, "web");
  await mkdir(web, { recursive: true });
  const friday = await startLocal({ home, port: 0 });
  t.after(() => friday.close());
  const h = { "content-type": "application/json", "x-friday-local": "1" };
  const post = (p: string, body: unknown) => fetch(`${friday.url}${p}`, { method: "POST", headers: h, body: JSON.stringify(body) });

  // Connecting: each token checked with Slack first.
  const bad = await post("/api/channels/slack/connect", { bot: "xoxb-bad", app: "xapp-good" });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /didn't accept that token/);
  assert.equal((await post("/api/channels/slack/connect", { bot: "xapp-good", app: "xoxb-good" })).status, 400, "the tokens the wrong way round");
  const ok = (await (await post("/api/channels/slack/connect", { bot: "xoxb-good", app: "xapp-good" })).json()) as { slack: { connected: boolean; team: string } };
  assert.deepEqual([ok.slack.connected, ok.slack.team], [true, "Acme"]);
  await until(() => socket, "Socket Mode connected");
  const ppl = (await (await fetch(`${friday.url}/api/channels/slack/people`, { headers: h })).json()) as { people: { id: string }[] };
  assert.deepEqual(ppl.people.map((p) => p.id), ["UADA", "USAM"], "people, not bots");
  await post("/api/channels/slack", { me: { id: "UADA", name: "Ada" }, channel: { id: "C1", folder: web } });
  const st = (await (await fetch(`${friday.url}/api/channels`, { headers: h })).json()) as { slack: { state: string; me: { name: string }; dms: boolean }; slackNewApp: string };
  assert.deepEqual([st.slack.state, st.slack.me.name, st.slack.dms], ["on", "Ada", false], "needs-you DMs off until turned on");
  assert.match(st.slackNewApp, /^https:\/\/api\.slack\.com\/apps\?new_app=1&manifest_json=/);

  // Ada mentions Friday in #web: a status message in the thread, then the answer; the status says Done, without Stop.
  await event({ type: "app_mention", user: "UADA", channel: "C1", ts: "100.1", text: "<@UBOT> fix MARKER-one" });
  await until(() => inThread("100.1").some((m) => m.text === "Got MARKER-one"), "the answer in the thread");
  const status = inThread("100.1")[0]!;
  assert.match(words(status), /Claude Code · Done\./);
  assert.match(words(status), /✓ Fix it/, "the plan on the status message");
  assert.ok(!status.blocks!.some((b) => b.type === "actions"), "no Stop once done");

  // A plain reply in the thread steers it: no mention needed.
  await event({ type: "message", channel_type: "channel", user: "UADA", channel: "C1", ts: "100.5", thread_ts: "100.1", text: "now MARKER-two" });
  await until(() => inThread("100.1").some((m) => m.text === "Got MARKER-two"), "the steer answered");
  // Someone else's reply in a thread that isn't Friday's: nothing.
  await event({ type: "message", channel_type: "channel", user: "USAM", channel: "C1", ts: "150.2", thread_ts: "150.1", text: "MARKER-ignored" });

  // Stop, from the status message, while it works.
  await event({ type: "message", channel_type: "channel", user: "UADA", channel: "C1", ts: "100.7", thread_ts: "100.1", text: "take a while: MARKER-slow" });
  await until(() => inThread("100.1")[0]!.blocks?.some((b) => b.type === "actions"), "Stop on the status while it works");
  await click("UADA", "C1", inThread("100.1")[0]!, "Stop");
  await until(() => /Stopped\./.test(words(inThread("100.1")[0]!)), "stopped from Slack");

  // Sam asks: it waits; Ada gets a DM to Start it; Sam can't press Start for her.
  await event({ type: "app_mention", user: "USAM", channel: "C1", ts: "200.1", text: "<@UBOT> please MARKER-sam" });
  const dm = await until(() => slack.msgs.find((m) => m.channel === "D-UADA" && /Sam asked Friday/.test(m.text)), "Ada's DM");
  assert.match(words(inThread("200.1")[0]!), /Waiting for Ada to start this/);
  await new Promise((r) => setTimeout(r, 800));
  assert.ok(!inThread("200.1").some((m) => m.text === "Got MARKER-sam"), "nothing ran yet");
  await click("UADA", "D-UADA", dm, "Start");
  await until(() => inThread("200.1").some((m) => m.text === "Got MARKER-sam"), "Sam's ask run once Ada started it");
  assert.equal(slack.msgs.find((m) => m.ts === dm.ts)!.text, "Started by Ada.");

  // A DM to Friday is work too, in a thread on it.
  await event({ type: "message", channel_type: "im", user: "UADA", channel: "D-UADA", ts: "300.1", text: "MARKER-dm in web" });
  await until(() => inThread("300.1").some((m) => m.text === "Got MARKER-dm"), "the DM answered in its thread");

  // /friday on its own lists what came from Slack.
  await deliver("slash_commands", { command: "/friday", text: "", user_id: "UADA", channel_id: "C1", response_url: `http://127.0.0.1:${port}/respond` });
  const listed = await until(() => slack.responses.at(-1), "the list");
  assert.match(listed.text, /What Friday has from Slack/);
});

test("an agent's approval comes to its Slack thread as buttons, and, with needs-you DMs on, any thread's to the person's DMs", async (t) => {
  const { createApp } = await import("../src/app.js");
  const { localKV } = await import("../src/local/kv.js");
  const { NO_MODELS } = await import("../src/local/no-models.js");
  const { writeFile } = await import("node:fs/promises");
  const home = path.join(root, "approvals");
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, "channels.json"), JSON.stringify({ slack: { bot: "xoxb-good", app: "xapp-good", team: { id: "T1", name: "Acme" }, botUser: "UBOT", me: { id: "UADA", name: "Ada" }, dms: true } }), { mode: 0o600 });
  const kv = await localKV(home);
  const app = await createApp({ port: 0, redisUrl: "", prefix: "friday:", secret: "s", driverGraceMs: 15_000, llm: NO_MODELS, dataDir: path.join(home, "uploads"), local: { redis: kv.redis, sub: kv.sub, user: { id: "local", name: "Ada" }, channels: path.join(home, "channels.json") }, teammatesHome: home });
  t.after(async () => (await app.close(), await kv.close()));
  await until(() => app.channels?.slack.status().state === "on", "connected");
  const made = async (title: string) => {
    const r = await fetch(`${app.url}/api/sessions`, { method: "POST", headers: { "content-type": "application/json", "x-friday-local": "1" }, body: JSON.stringify({ title }) });
    return ((await r.json()) as { sessionId: string }).sessionId;
  };
  // A thread from Slack (linked as a mention would link it), and its agent asking to run a command.
  const sid = await made("Deploy");
  await app.channels!.bridge.save({ side: "slack", ref: "C9:900.1", sid, lane: "main", by: { id: "UADA", name: "Ada", me: true }, label: "Slack thread", meta: { channel: "C9", thread: "900.1" } });
  await app.store.append(sid, { id: "agent", name: "Claude Code", kind: "agent" }, { type: "engine.approval", id: "ap1", tool: "claude", scope: "commands", items: ["npm run deploy"] });
  const ask = await until(() => inThread("900.1").find((m) => /asks to run/.test(m.text)), "the approval in the thread");
  assert.match(words(ask), /`npm run deploy`/);
  await click("USAM", "C9", ask, "Approve");
  await new Promise((r) => setTimeout(r, 300));
  assert.ok((await app.store.state(sid)).approvals.main, "Sam's press doesn't answer for Ada");
  await click("UADA", "C9", ask, "Approve");
  await until(async () => !(await app.store.state(sid)).approvals.main, "approved");
  assert.equal(slack.msgs.find((m) => m.ts === ask.ts)!.text, "Approved by Ada.");
  const said = (await app.store.events(sid)).find((e) => e.body.type === "instruction" && e.body.approval?.id === "ap1");
  assert.equal(said?.actor.via, "Slack", "it says it was answered from Slack");

  // Needs-you DMs: a thread that never touched Slack asks a question; it comes to Ada's DMs, and her press answers it.
  const other = await made("Refactor");
  await app.store.append(other, { id: "agent", name: "Claude Code", kind: "agent" }, { type: "agent.question", callId: "q1", question: "Keep the old API?", options: ["Keep it", "Drop it"], to: "local", toName: "Ada" });
  const q = await until(() => slack.msgs.find((m) => m.channel === "D-UADA" && /Keep the old API/.test(m.text)), "the question in Ada's DMs");
  assert.ok(slack.msgs.some((m) => m.channel === "D-UADA" && /In “Refactor”/.test(m.text)), "which thread it's from");
  await click("UADA", "D-UADA", q, "Drop it");
  await until(async () => (await app.store.events(other)).some((e) => e.body.type === "instruction" && e.body.text === "Drop it" && e.actor.via === "Slack"), "answered");
});
