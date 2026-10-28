// One answer to "is its tool connected": the log says offline wherever no runner holds the lane (2026-10-27 QA: the status bar
// read the log as connected while the Tree, the branch picker and setup, asking the runner, said no). And a run's start takes
// its cause out of the queue, as the page's deliveredIn has it.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { localKV } from "../src/local/kv.js";
import { NO_MODELS } from "../src/local/no-models.js";
import { pendingFor, project } from "../src/session/projection.js";
import { MAIN_LANE, type SessionEvent } from "../src/types.js";

test("a lane no runner holds reads offline: this server's own with its runner gone, and at start one a server before it held", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-connected-"));
  const kv = await localKV(home);
  const app = await createApp({ port: 0, redisUrl: "", prefix: "friday:", secret: "s", driverGraceMs: 15_000, llm: NO_MODELS, dataDir: path.join(home, "uploads"), local: { redis: kv.redis, sub: kv.sub, user: { id: "local", name: "Me" } } });
  t.after(async () => (await app.close(), await kv.close(), await rm(home, { recursive: true, force: true })));
  const post = (p: string, body: unknown) => fetch(`${app.url}${p}`, { method: "POST", headers: { "Content-Type": "application/json", "x-friday-local": "1" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<{ sessionId: string }>);
  const me = { id: "local", name: "Me", kind: "human" } as const;
  const attached = (sid: string, node: string) => app.store.append(sid, me, { type: "engine.attached", engine: { tool: "claude", cwd: home, hostId: "local", hostName: "Me", mode: "full", node } });

  // Written as this server's, with no runner of it holding the lane.
  const mine = (await post("/api/sessions", { title: "Mine" })).sessionId;
  await attached(mine, app.hub.node);
  assert.equal((await app.store.state(mine)).engines[MAIN_LANE]?.online, true);
  await app.hub.reap(mine);
  assert.equal((await app.store.state(mine)).engines[MAIN_LANE]?.online, false, "offline: no runner here holds it");

  // A server before this one held it, and is gone: looked over at start, whether or not anyone opens it.
  const old = (await post("/api/sessions", { title: "Old" })).sessionId;
  await attached(old, "a-server-gone");
  app.hub.reapAfterLeases(async () => [old], 0);
  for (let i = 0; i < 100 && (await app.store.state(old)).engines[MAIN_LANE]?.online; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal((await app.store.state(old)).engines[MAIN_LANE]?.online, false);
});

test("a run's start takes the message that started it out of the queue", () => {
  const ev = (seq: number, lane: string, body: object) => ({ seq, ts: seq, lane, actor: { id: "u", name: "U", kind: "human" }, body }) as unknown as SessionEvent;
  const lanes = [ev(1, MAIN_LANE, { type: "lane.added", lane: { id: "l2", name: "Codex", control: { kind: "open" }, trigger: { kind: "manual" } } })];
  const s = project("s", [
    ...lanes,
    ev(2, "l2", { type: "instruction", text: "a", interrupt: false }),
    ev(3, "l2", { type: "instruction", text: "b", interrupt: false }),
    ev(4, MAIN_LANE, { type: "instruction", text: "c", interrupt: false }),
    ev(5, "l2", { type: "run.started", causedBy: 2 }),
    ev(6, MAIN_LANE, { type: "run.started", causedBy: 4 }),
  ]);
  assert.deepEqual(pendingFor(s, "l2"), [3], "its cause read, the next still waiting");
  assert.deepEqual(pendingFor(s, MAIN_LANE), []);
});
