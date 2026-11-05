// A session's agent on another of your computers (local/computers.ts), in the open-source edition: it stays on that computer.
// When the computer links again after a drop, its agents come back there by themselves; a start or a stop of its lane goes
// there whatever computer the page has picked; and with that computer away, nothing is started here in its place (2026-11-04
// linking test: the agent never came back, and opening the session started it on this computer in this computer's copy of the
// same path).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { signActor, signInvite } from "../src/auth.js";
import { lanesToReattach } from "../src/reattach.js";
import { initialState } from "../src/session/projection.js";
import { MAIN_LANE } from "../src/types.js";

const MINI = "0123456789abcdef";
/** Your other computers are the open-source edition's (app.ts LocalLinks): here, with the hosted service's links, they run in its export. */
const edition = { skip: existsSync("src/link") ? "the open-source edition's: run in its export (scripts/oss-export.mts)" : false };
const me = { id: "local", name: "Maya" };

async function hub(t: test.TestContext) {
  // Nothing is started on the computer running the test: a start here would be a real coding tool.
  const was = process.env.FRIDAY_LOCAL_RUNNER;
  process.env.FRIDAY_LOCAL_RUNNER = "0";
  const { createApp } = await import("../src/app.js");
  const { localKV } = await import("../src/local/kv.js");
  const { NO_MODELS } = await import("../src/local/no-models.js");
  const home = await mkdtemp(path.join(tmpdir(), "friday-computers-"));
  const kv = await localKV(home);
  const app = await createApp({ port: 0, redisUrl: "", prefix: "friday:", secret: "s", driverGraceMs: 15_000, llm: NO_MODELS, dataDir: path.join(home, "uploads"), local: { redis: kv.redis, sub: kv.sub, user: me } });
  const open: WebSocket[] = [];
  t.after(async () => {
    for (const w of open) w.terminate();
    await app.close();
    await kv.close();
    if (was === undefined) delete process.env.FRIDAY_LOCAL_RUNNER;
    else process.env.FRIDAY_LOCAL_RUNNER = was;
    await rm(home, { recursive: true, force: true });
  });
  const call = async (p: string, method = "GET", json?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${app.url}${p}`, { method, headers: { "Content-Type": "application/json", "x-friday-local": "1", ...headers }, ...(json === undefined ? {} : { body: JSON.stringify(json) }) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const ws = app.url.replace(/^http/, "ws");
  /** The other computer's link, as the device listener hands it over: what it is asked to start, and what it answers. */
  const computer = async (id = MINI) => {
    const asked: { method: string; params: Record<string, unknown> }[] = [];
    const sock = new WebSocket(`${ws}/link`, { headers: { "x-friday-via": "computer", "x-friday-device": id, "x-friday-device-name": encodeURIComponent("Mac mini"), "x-friday-device-address": "192.168.1.20" } });
    open.push(sock);
    sock.on("error", () => {});
    await new Promise((r) => sock.once("open", r));
    const linked = new Promise((r) => sock.on("message", (raw) => JSON.parse(String(raw)).kind === "linked" && r(null)));
    sock.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as { kind?: string; id?: string; method?: string; params?: Record<string, unknown> };
      if (m.kind !== "call") return;
      asked.push({ method: m.method!, params: m.params ?? {} });
      sock.send(JSON.stringify({ kind: "result", id: m.id, ok: true, value: m.method === "start" ? { lane: m.params?.lane ?? MAIN_LANE } : {} }));
    });
    sock.send(JSON.stringify({ kind: "hello", machine: { name: "mini", platform: "linux" }, tools: [{ tool: "claude", name: "Claude Code", loggedIn: true }] }));
    await linked;
    return { asked, sock };
  };
  const until = async (ok: () => boolean | Promise<boolean>, what: string) => {
    for (let i = 0; i < 300; i++) {
      if (await ok()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail(`timed out waiting for ${what}`);
  };
  return { app, call, computer, ws, until };
}

test("a session's agent on another computer comes back there when that computer links again, and its lane's starts go there", edition, async (t) => {
  const h = await hub(t);
  const { sessionId: sid } = (await h.call("/api/sessions", "POST", { title: "Billing" })).body as { sessionId: string };
  const mini = await h.computer();

  // Its runner attaches through the listener, which says which computer it is: the lane keeps that.
  const actor = signActor("s", sid, me.id);
  const runner = new WebSocket(`${h.ws}/runner?session=${sid}&token=${encodeURIComponent(actor)}&invite=${encodeURIComponent(signInvite("s", sid, "owner"))}&tool=claude&cwd=${encodeURIComponent("/home/maya/code/billing")}&machine=mini&os=linux&mode=full`, {
    headers: { "x-friday-via": "computer", "x-friday-device": MINI },
  });
  // Open on this side too before it is dropped: the server can count it attached first, and ending a socket still opening threw
  // "WebSocket was closed before the connection was established" on CI's slower Mac and Windows (2026-11-04).
  runner.on("error", () => {});
  await new Promise((r) => runner.once("open", r));
  await h.until(async () => !!(await h.app.store.state(sid)).engines[MAIN_LANE]?.online, "the runner to attach");
  assert.equal((await h.app.store.state(sid)).engines[MAIN_LANE]?.computer, MINI);

  // The computer drops (killed mid-turn): its runner goes with it.
  runner.terminate();
  mini.sock.terminate();
  await h.until(async () => !((await h.call("/api/machines")).body.machines as unknown[]).length, "the computer to be gone");
  await h.app.store.append(sid, { id: me.id, name: me.name, kind: "human" }, { type: "engine.detached", reason: "disconnected", tool: "claude" }, { lane: MAIN_LANE });

  // Away: a start of its lane from the page (the quiet reconnect on opening the session) is not run here, and says why.
  const away = await h.call("/api/runner/start", "POST", { sid, invite: signInvite("s", sid, "owner"), tool: "claude", cwd: "/home/maya/code/billing", lane: MAIN_LANE, ifOffline: true });
  assert.equal(away.status, 503);
  assert.match(String(away.body.error), /Mac mini isn't connected.*carries on there once Mac mini links again/);

  // Back: its agent is started there by itself, in its own folder, carrying on (ifOffline leaves one already back alone).
  const back = await h.computer();
  await h.until(() => back.asked.some((a) => a.method === "start"), "the agent to be started on the computer again");
  const start = back.asked.find((a) => a.method === "start")!.params;
  assert.equal(start.lane, MAIN_LANE);
  assert.equal(start.cwd, "/home/maya/code/billing");
  assert.equal(start.ifOffline, true);

  // And the page's own start of that lane goes there too, with no computer named and another one picked.
  const n = back.asked.length;
  const again = await h.call("/api/runner/start", "POST", { sid, invite: signInvite("s", sid, "owner"), tool: "claude", cwd: "/home/maya/code/billing", lane: MAIN_LANE, mode: "plan" });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal(back.asked.length, n + 1);
  assert.equal(back.asked.at(-1)!.params.mode, "plan");
});

test("a new session's first agent goes to the computer picked for it, though its lane was made before it started anywhere", edition, async (t) => {
  const h = await hub(t);
  // As the page makes one: the session with its tool named, then its agent started on the computer picked in Runs on.
  const { sessionId: sid } = (await h.call("/api/sessions", "POST", { title: "New", kind: "code", engine: "claude" })).body as { sessionId: string };
  const mini = await h.computer();
  const r = await h.call("/api/runner/start", "POST", { sid, invite: signInvite("s", sid, "owner"), tool: "claude", cwd: "/home/maya/code/billing" }, { "x-friday-machine": MINI });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(mini.asked.filter((a) => a.method === "start").length, 1, "started there, not here in that computer's folder path");
});

test("Friday opening again brings back only this computer's lanes; another computer's wait for it", () => {
  const s = initialState("s1");
  const engine = (extra: Record<string, unknown>) => ({ tool: "claude" as const, hostId: me.id, hostName: me.name, cwd: "/code/app", mode: "full" as const, online: false, sinceSeq: 1, ...extra });
  s.engines[MAIN_LANE] = engine({ computer: MINI, machine: "mini" });
  s.lanes.push({ id: "l2", name: "Codex" } as never);
  s.engines.l2 = engine({ machine: "studio" });
  assert.deepEqual(lanesToReattach(s, me.id, "studio", null).map((x) => x.lane), ["l2"], "this computer's own");
  assert.deepEqual(lanesToReattach(s, me.id, "studio", MINI).map((x) => x.lane), [MAIN_LANE], "the Mac mini's, as it links");
  // Paired again under a new id: the lanes the old id carries are that computer's still.
  assert.deepEqual(lanesToReattach(s, me.id, "studio", "fedcba9876543210", [MINI]).map((x) => x.lane), [MAIN_LANE]);
  assert.deepEqual(lanesToReattach(s, me.id, "studio", "fedcba9876543210").length, 0);
});

test("a terminal on another computer goes to that computer's shells, and closes when it drops", edition, async (t) => {
  const h = await hub(t);
  const mini = await h.computer();
  const term = new WebSocket(`${h.ws}/term?machine=${MINI}`);
  term.on("error", () => {});
  const got: Record<string, unknown>[] = [];
  term.on("message", (raw) => got.push(JSON.parse(String(raw))));
  await h.until(() => got.some((m) => m.op === "ready"), "the terminal to be ready");
  const toMini: Record<string, unknown>[] = [];
  mini.sock.on("message", (raw) => toMini.push(JSON.parse(String(raw))));
  term.send(JSON.stringify({ op: "start", req: "1", id: "t1", cols: 80, rows: 24 }));
  await h.until(() => toMini.some((m) => m.kind === "term" && m.op === "start"), "the start to reach the computer");
  const owner = toMini.find((m) => m.kind === "term")!.owner;
  mini.sock.send(JSON.stringify({ kind: "term", op: "data", owner, id: "t1", data: "maya@mini $ " }));
  await h.until(() => got.some((m) => m.op === "data" && m.data === "maya@mini $ "), "its output to come back");
  const closed = new Promise<number>((r) => term.on("close", (code) => r(code)));
  mini.sock.terminate();
  assert.equal(await closed, 4004);
});
