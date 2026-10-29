// The app, for the agents in it (Arun, 2026-10-27: "make the app fully agentic and allow the coding tools to utiilize the
// features of the app too").
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { scheduleOf } from "../src/app-tools.js";
import { createApp } from "../src/app.js";
import { localKV } from "../src/local/kv.js";
import { NO_MODELS } from "../src/local/no-models.js";
import type { TeammateView } from "../src/teammates.js";
import { MAIN_LANE } from "../src/types.js";

process.env.FRIDAY_MINE = "1";
process.env.FRIDAY_TEAMMATES_DRY = "1";

test("an automation's schedule from what an agent says: days, a time, every hour", () => {
  assert.equal(scheduleOf(undefined), null);
  assert.deepEqual(scheduleOf({ time: "9:30" }, "UTC"), { every: "daily", at: "09:30", days: [], tz: "UTC" });
  assert.deepEqual(scheduleOf({ days: ["mon", "Wednesday", "fri"], time: "02:00" }, "UTC"), { every: "weekly", at: "02:00", days: [1, 3, 5], tz: "UTC" });
  assert.deepEqual(scheduleOf({ every: "hour", time: "00:15" }, "UTC"), { every: "hourly", at: "00:15", days: [], tz: "UTC" });
  assert.equal(scheduleOf({ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] }, "UTC")!.every, "daily", "every day is daily");
});

test("from any session a coding tool sees, reads, searches and tells the others (Code, Work and the team's), starts one, runs automations and the team", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-app-tools-"));
  const kv = await localKV(home);
  const app = await createApp({ port: 0, redisUrl: "", prefix: "friday:", secret: "s", driverGraceMs: 15_000, llm: NO_MODELS, dataDir: path.join(home, "uploads"), local: { redis: kv.redis, sub: kv.sub, user: { id: "local", name: "Me" } }, teammatesHome: home });
  t.after(async () => (await app.close(), await kv.close(), await rm(home, { recursive: true, force: true })));
  const post = <T>(url: string, body: unknown) => fetch(`${app.url}${url}`, { method: "POST", headers: { "Content-Type": "application/json", "x-friday-local": "1" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<T>);
  const me = { id: "local", name: "Me", kind: "human" } as const;
  const agent = { id: "agent", name: "Claude Code", kind: "agent" } as const;

  const code = await post<{ sessionId: string }>("/api/sessions", { title: "Fix the checkout total" });
  const work = await post<{ sessionId: string }>("/api/sessions", { title: "Launch posts", work: true });
  await app.store.append(work.sessionId, me, { type: "instruction", text: "Draft the launch thread", interrupt: false });
  await app.store.append(work.sessionId, agent, { type: "agent.message", text: "Drafted it. The launch date is November 3, and the thread opens with the demo video.", toolCalls: [] });
  // Looking at a team nobody has made yet doesn't make one.
  assert.match((await app.mesh.call(code.sessionId, MAIN_LANE, "manage_teammate", { action: "list" })).output, /no teammates yet/);
  assert.ok(!(await app.store.mine("local", 20)).some((r) => r.sid !== code.sessionId && r.sid !== work.sessionId), "no Team session made by a look");
  const team = await post<{ sid: string; teammates: TeammateView[] }>("/api/teammates", { name: "Nova", tool: "codex", folder: path.join(home, "Nova") });
  const nova = team.teammates[0]!;
  const call = (name: string, args: Record<string, unknown>) => app.mesh.call(code.sessionId, MAIN_LANE, name, args);

  const tools = (await app.mesh.listingFor(code.sessionId, false)).tools.map((x) => x.name);
  for (const n of ["list_sessions", "read_session", "message_session", "search_sessions", "start_session", "manage_automation", "manage_teammate"]) assert.ok(tools.includes(n), `${n} is offered in a Code session`);

  const listed = await call("list_sessions", {});
  assert.ok(!listed.isError, listed.output);
  assert.match(listed.output, /"Launch posts" \[id [\w-]+\] · Work session/);
  assert.match(listed.output, /"Crew" \[id [\w-]+\] · Crew room · Nova/, "the Crew room, by its teammates");
  assert.doesNotMatch(listed.output, /Fix the checkout total/, "not the session asking");

  const read = await call("read_session", { to: "launch" });
  assert.ok(!read.isError, read.output);
  assert.match(read.output, /Last asked by Me .*Draft the launch thread/);
  assert.match(read.output, /The launch date is November 3/);

  const found = await call("search_sessions", { query: "launch date" });
  assert.match(found.output, /"Launch posts" .*Work session\n  - .*November 3/);
  assert.match((await call("search_sessions", { query: "zz" })).output, /three letters/);

  const told = await call("message_session", { to: "Launch posts", text: "The date moved to November 5." });
  assert.ok(!told.isError, told.output);
  const got = (await app.store.events(work.sessionId)).findLast((e) => e.body.type === "instruction");
  assert.equal(got?.body.type === "instruction" && got.body.peer?.fromSid, code.sessionId, "it reaches the Work session as a message from this one");
  assert.ok((await app.store.events(code.sessionId)).some((e) => e.body.type === "peer.sent"), "and is kept here too");

  const toNova = await call("message_session", { to: "Crew", agent: "nova", text: "Can you review the checkout fix?" });
  assert.ok(!toNova.isError, toNova.output);
  const atNova = (await app.store.events(team.sid)).findLast((e) => e.body.type === "instruction");
  assert.equal(atNova?.lane, nova.lane, "a teammate, by its name, in the Team room");

  // Automations: made, listed, paused and changed by an agent.
  const made = await call("manage_automation", { action: "create", name: "Nightly tests", does: "Run the tests and fix what fails", schedule: { days: ["mon", "tue", "wed", "thu", "fri"], time: "02:00" } });
  assert.ok(!made.isError, made.output);
  assert.match((await call("manage_automation", { action: "list" })).output, /Nightly tests \[id [\w-]+\] · on · .*02:00/);
  assert.match((await call("manage_automation", { action: "pause", name: "nightly" })).output, /paused/);
  assert.match((await call("manage_automation", { action: "list" })).output, /· paused ·/);
  assert.match((await call("manage_automation", { action: "update", name: "Nightly tests", does: "Run the tests" })).output, /Changed "Nightly tests"/);
  assert.match((await call("manage_automation", { action: "runs", name: "Nightly tests" })).output, /hasn't run yet/);
  assert.ok((await call("manage_automation", { action: "pause", name: "nope" })).isError);
  // An agent's automation may do no more than the agent may: this one, with no tool yet, is allowed edits.
  type Auto = { name: string; who: { mode: string } };
  const autos = () => fetch(`${app.url}/api/automations`, { headers: { "x-friday-local": "1" } }).then((r) => r.json() as Promise<{ automations: Auto[] }>);
  assert.equal((await autos()).automations.find((a) => a.name === "Nightly tests")?.who.mode, "edits");
  // One the person made with full access is theirs to run: the agent can pause it, not run or change it.
  await post("/api/automations", { name: "Deploy", does: "Deploy the site", who: { tool: "claude", mode: "full" } });
  assert.match((await call("manage_automation", { action: "run", name: "Deploy" })).output, /more access than you have/);
  assert.match((await call("manage_automation", { action: "update", name: "Deploy", does: "Deploy everything" })).output, /more access than you have/);
  assert.match((await call("manage_automation", { action: "pause", name: "Deploy" })).output, /paused/);

  // A new Work session with its task: made and told, though no computer is here to start its tool on.
  const started = await call("start_session", { kind: "work", title: "Launch video script", task: "Write a 60-second script for the launch video" });
  const id = /\[id ([\w-]+)\]/.exec(started.output)?.[1];
  assert.ok(id, started.output);
  const s = await app.store.state(id!);
  assert.equal(s.options.work, true);
  const task = (await app.store.events(id!)).find((e) => e.body.type === "instruction");
  assert.equal(task?.actor.kind, "agent", "its task is the agent's, not said as the person's");
  assert.equal(task?.body.type === "instruction" && task.body.peer?.fromSid, code.sessionId);
  assert.match(task?.body.type === "instruction" ? task.body.text : "", /60-second script[\s\S]*Started by .* from "Fix the checkout total"\. .*message_session, to "[\w-]+" and agent/);
  assert.ok((await call("start_session", { title: "x", task: "y", folder: path.join(home, "nope") })).isError, "a folder that isn't there");
  // A session an agent started starts none of its own: sessions don't fan out into sessions.
  assert.match((await app.mesh.call(id!, MAIN_LANE, "start_session", { title: "More", task: "Go on" })).output, /started by another agent/);
  // Many at once from one run: no more than the run may start, however they arrive.
  const burst = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => call("start_session", { title: `Burst ${i}`, task: "Do a thing" })));
  assert.equal(burst.filter((r) => /\[id [\w-]+\]/.test(r.output)).length, 3, "four a run, one already started");
  assert.ok(burst.some((r) => /started 4 sessions already/.test(r.output)));

  // The team, from a Code session: a teammate made, said in the Team room; a room of it.
  const site = path.join(home, "site");
  await mkdir(site);
  const pip = await call("manage_teammate", { action: "create", name: "Pip", role: "Tests the site on phones", folders: [site] });
  assert.ok(!pip.isError, pip.output);
  const line = (await app.store.events(team.sid)).findLast((e) => e.body.type === "teammate.changed");
  assert.equal(line?.body.type === "teammate.changed" && line.body.name, "Pip", "said in the Team room");
  // Made by an agent allowed edits (this session has no tool yet), Pip is allowed no more; and a room with Nova, which may do
  // everything, is the person's to make (2026-10-27 audit).
  assert.match(pip.output, /in edits mode as you are/);
  assert.match((await call("manage_teammate", { action: "create_room", name: "Mobile", members: ["Pip", "nova"] })).output, /Nova may do more than you may \(you edits\)/);
  const room = await call("manage_teammate", { action: "create_room", name: "Mobile", members: ["Pip"], role: "The phone layout" });
  assert.ok(!room.isError, room.output);
  assert.match((await call("manage_teammate", { action: "rooms" })).output, /"Mobile" .*: Pip\. For: The phone layout/);
  assert.match((await call("manage_teammate", { action: "create_room", name: "X", members: ["Zed"] })).output, /Not in the crew: zed/);
  // A room the person removed is gone for the agents too.
  const mobile = (await fetch(`${app.url}/api/teammates`, { headers: { "x-friday-local": "1" } }).then((r) => r.json() as Promise<{ rooms: { id: string; name: string; sid: string }[] }>)).rooms.find((r) => r.name === "Mobile")!;
  assert.match((await call("list_sessions", {})).output, /Crew room "Mobile"/);
  await fetch(`${app.url}/api/teammates/rooms/${mobile.id}`, { method: "DELETE", headers: { "x-friday-local": "1" } });
  assert.doesNotMatch((await call("list_sessions", {})).output, /Mobile/);
  assert.ok((await call("read_session", { to: mobile.sid })).isError, "not by its id either");
});
