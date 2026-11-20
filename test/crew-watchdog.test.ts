process.env.FRIDAY_TEAMMATES_DRY = "1";
process.env.FRIDAY_EDITION = "local";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { localKV } from "../src/local/kv.js";
import { NO_MODELS } from "../src/local/no-models.js";

/**
 * One hook, in order: the app and its store closed first, then the folder removed. Two hooks ran the removal first (node:test
 * runs after hooks in the order they're added), while the app still wrote into the folder: ENOTEMPTY on CI, and the app left
 * open kept the file running until its 10-minute timeout.
 */
async function closeThenRemove(app: { close: () => Promise<unknown> }, kv: { close: () => Promise<unknown> }, home: string) {
  try {
    await app.close();
    await kv.close();
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** A crew mate quiet mid-turn is said in its chat once a quiet spell, and asked once how it stands (app.ts watchQuiet). */
test("the watchdog: a crew mate quiet mid-turn is said once and nudged once; one waiting on a command it ran is said, not nudged", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-quiet-"));
  const kv = await localKV(home);
  const app = await createApp({ port: 0, redisUrl: "", prefix: "friday:", secret: "s", driverGraceMs: 15_000, llm: NO_MODELS, dataDir: path.join(home, "uploads"), local: { redis: kv.redis, sub: kv.sub, user: { id: "local", name: "Me" } }, teammatesHome: home });
  t.after(() => closeThenRemove(app, kv, home));
  const call = async (p: string, method = "GET", json?: unknown) => (await fetch(`${app.url}${p}`, { method, headers: { "Content-Type": "application/json", "x-friday-local": "1" }, ...(json === undefined ? {} : { body: JSON.stringify(json) }) })).json() as Promise<any>;
  await call("/api/teammates", "POST", { name: "Sage", tool: "claude", folder: path.join(home, "Sage") });
  await call("/api/teammates", "POST", { name: "Ivy", tool: "claude", folder: path.join(home, "Ivy") });
  const team = await call("/api/teammates");
  const sid = team.sid as string;
  const lane = (n: string) => team.teammates.find((m: any) => m.name === n).lane as string;
  const bot = (n: string) => ({ id: "engine:local", name: n, kind: "agent" as const });
  const me = { id: "local", name: "Me", kind: "human" as const };
  for (const n of ["Sage", "Ivy"]) {
    const asked = (await app.store.append(sid, me, { type: "instruction", text: "Do the thing", interrupt: false, attachments: [] }, { lane: lane(n) })) as { seq: number };
    await app.store.append(sid, bot(n), { type: "instructions.delivered", seqs: [asked.seq] }, { lane: lane(n) });
    await app.store.append(sid, bot(n), { type: "run.started", causedBy: asked.seq }, { lane: lane(n) });
  }
  await app.store.append(sid, bot("Ivy"), { type: "agent.message", text: "", toolCalls: [{ id: "c1", name: "shell", arguments: JSON.stringify({ command: "npm install" }) }] }, { lane: lane("Ivy") });

  await app.teammates.quiet(Date.now() + 5 * 60_000);
  assert.equal((await app.store.events(sid)).filter((e) => e.body.type === "run.quiet").length, 0, "five minutes is not quiet");
  await app.teammates.quiet(Date.now() + 13 * 60_000);
  const evs = await app.store.events(sid);
  const quiet = evs.filter((e) => e.body.type === "run.quiet");
  assert.equal(quiet.length, 2);
  const sage = quiet.find((e) => e.lane === lane("Sage"))!;
  assert.equal(sage.body.type === "run.quiet" && sage.body.nudged, true);
  const ivy = quiet.find((e) => e.lane === lane("Ivy"))!;
  assert.equal(ivy.body.type === "run.quiet" && ivy.body.command, "npm install", "waiting on a command it ran");
  const nudges = evs.filter((e) => e.body.type === "instruction" && e.body.text.startsWith("[Friday] Nothing has happened"));
  assert.deepEqual(nudges.map((e) => e.lane), [lane("Sage")], "only the one not waiting on a command is asked");
  await app.teammates.quiet(Date.now() + 14 * 60_000);
  assert.equal((await app.store.events(sid)).filter((e) => e.body.type === "run.quiet").length, 2, "once a quiet spell");
});

test("trust that grows: a go-ahead of a kind its crew mate is trusted with is said yes to, with a receipt; another kind still waits", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-trust-"));
  const kv = await localKV(home);
  const app = await createApp({ port: 0, redisUrl: "", prefix: "friday:", secret: "s", driverGraceMs: 15_000, llm: NO_MODELS, dataDir: path.join(home, "uploads"), local: { redis: kv.redis, sub: kv.sub, user: { id: "local", name: "Me" } }, teammatesHome: home });
  t.after(() => closeThenRemove(app, kv, home));
  const call = async (p: string, method = "GET", json?: unknown) => (await fetch(`${app.url}${p}`, { method, headers: { "Content-Type": "application/json", "x-friday-local": "1" }, ...(json === undefined ? {} : { body: JSON.stringify(json) }) })).json() as Promise<any>;
  await call("/api/teammates", "POST", { name: "Kit", tool: "claude", folder: path.join(home, "Kit") });
  const team = await call("/api/teammates");
  const kit = team.teammates[0];
  const patched = await call(`/api/teammates/${kit.id}`, "PATCH", { trust: ["ship", "takeover", "nonsense", "ship"] });
  assert.deepEqual(patched.teammates[0].trust, ["ship"], "go-aheads only, once each, never a sign-in");
  const bot = { id: "engine:local", name: "Kit", kind: "agent" as const };
  const me = { id: "local", name: "Me", kind: "human" as const };
  const asked = (await app.store.append(team.sid, me, { type: "instruction", text: "Ship it", interrupt: false, attachments: [] }, { lane: kit.lane })) as { seq: number };
  await app.store.append(team.sid, bot, { type: "instructions.delivered", seqs: [asked.seq] }, { lane: kit.lane });
  await app.store.append(team.sid, bot, { type: "run.started", causedBy: asked.seq }, { lane: kit.lane });
  await app.store.append(team.sid, bot, { type: "engine.approval", id: "a1", scope: "commands", items: ["git push origin main"], why: "Ships: pushes to main", guard: "ship", live: true }, { lane: kit.lane });
  const waitFor = async (f: () => Promise<boolean>) => {
    for (let i = 0; i < 100 && !(await f()); i++) await new Promise((r) => setTimeout(r, 20));
  };
  await waitFor(async () => (await app.store.events(team.sid)).some((e) => e.body.type === "instruction" && e.body.approval?.id === "a1"));
  const evs = await app.store.events(team.sid);
  assert.ok(evs.some((e) => e.body.type === "goahead.trusted" && e.body.id === "a1"), "a receipt that it was trusted");
  assert.equal(evs.find((e) => e.body.type === "instruction" && e.body.approval?.id === "a1")?.body.type === "instruction" && (evs.find((e) => e.body.type === "instruction" && e.body.approval?.id === "a1")!.body as { approval: { approve: boolean } }).approval.approve, true);
  await app.store.append(team.sid, bot, { type: "engine.approval", id: "a2", scope: "commands", items: ["rm -rf ../other"], why: "Deletes what isn't its own", guard: "delete", live: true }, { lane: kit.lane });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await app.store.state(team.sid)).approvals[kit.lane]?.id, "a2", "not trusted with deleting: it waits for the person");
  const log = await call(`/api/teammates/decisions?mate=${kit.id}`);
  assert.deepEqual(log.decisions.map((d: { answer: string }) => d.answer), ["waiting", "trusted"]);
});
