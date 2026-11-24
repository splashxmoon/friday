// A crew mate's routines from its own chat and from any session (agent-mesh.ts ROUTINE_TOOL; Arun, 2026-11-23: Ivy, asked to
// track the downloads every day, could only make a Code automation, which ran as a coding session apart from its chat).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { localKV } from "../src/local/kv.js";
import { NO_MODELS } from "../src/local/no-models.js";
import { teammateNote, type Teammate, type TeammateView } from "../src/teammates.js";
import { MAIN_LANE } from "../src/types.js";

process.env.FRIDAY_MINE = "1";
process.env.FRIDAY_TEAMMATES_DRY = "1";

test("a crew mate keeps its own routines with manage_routine; another session names whose, and may change only one that may do no more than it", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-routine-tool-"));
  const kv = await localKV(home);
  const app = await createApp({ port: 0, redisUrl: "", prefix: "friday:", secret: "s", driverGraceMs: 15_000, llm: NO_MODELS, dataDir: path.join(home, "uploads"), local: { redis: kv.redis, sub: kv.sub, user: { id: "local", name: "Me" } }, teammatesHome: home });
  t.after(async () => (await app.close(), await kv.close(), await rm(home, { recursive: true, force: true })));
  const local = { "Content-Type": "application/json", "x-friday-local": "1" };
  const post = <T>(url: string, body: unknown) => fetch(`${app.url}${url}`, { method: "POST", headers: local, body: JSON.stringify(body) }).then((r) => r.json() as Promise<T>);
  const team = await post<{ sid: string; teammates: TeammateView[] }>("/api/teammates", { name: "Ivy", tool: "claude", folder: path.join(home, "Ivy") });
  const ivy = team.teammates[0]!;
  const routinesOf = async () => (await fetch(`${app.url}/api/teammates`, { headers: local }).then((r) => r.json() as Promise<{ teammates: TeammateView[] }>)).teammates.find((x) => x.id === ivy.id)!.checkins ?? [];

  // Offered where manage_teammate is, in a Code session too.
  const code = await post<{ sessionId: string }>("/api/sessions", { title: "Release notes" });
  const tools = (await app.mesh.listingFor(code.sessionId, false)).tools.map((x) => x.name);
  assert.ok(tools.includes("manage_routine") && tools.includes("manage_teammate"));

  // From Ivy's own chat: its own routine, nobody named.
  const asIvy = (args: Record<string, unknown>) => app.mesh.call(team.sid, ivy.lane, "manage_routine", args);
  assert.match((await asIvy({ action: "list" })).output, /Ivy has no routines yet/);
  const does = "Count the installer downloads of splashxmoon/friday and say the change since yesterday.";
  const made = await asIvy({ action: "create", name: "Daily downloads update", does, at: "9:00" });
  assert.ok(!made.isError, made.output);
  assert.match(made.output, /Made Ivy's routine "Daily downloads update" \[id [\w-]+\]: every day at 09:00, in Ivy's own chat, next /);
  let [r] = await routinesOf();
  assert.equal(r?.name, "Daily downloads update");
  assert.equal(r?.text, does);
  assert.equal(r?.every, "daily");
  assert.equal(r?.at, "09:00");
  assert.equal(r?.where, undefined, "its own chat");
  assert.match((await asIvy({ action: "list" })).output, /- Daily downloads update \[id [\w-]+\] · on, next .* · every day at 09:00 · in its own chat\n {2}Does: Count the installer/);
  assert.match((await asIvy({ action: "create", name: "daily downloads update", does: "x" })).output, /already has a routine called "Daily downloads update"/);
  assert.match((await asIvy({ action: "create", name: "Nothing" })).output, /a name and what it does/);
  assert.match((await asIvy({ action: "create", name: "Odd", does: "x", at: "25:00" })).output, /isn't a time/);

  // Changed by its name, paused and resumed; days make it weekly; a new thread each time, always reporting.
  const changed = await asIvy({ action: "update", routine: "downloads", every: "weekdays", at: "08:30" });
  assert.ok(!changed.isError, changed.output);
  assert.match(changed.output, /every weekday at 08:30/);
  assert.match((await asIvy({ action: "update", routine: "downloads", days: ["mon", "fri"], where: "thread", quiet: false })).output, /every Monday, Friday at 08:30, in a new thread each time/);
  [r] = await routinesOf();
  assert.deepEqual([r?.every, r?.days, r?.where, r?.quiet], ["weekly", [1, 5], "thread", false]);
  assert.match((await asIvy({ action: "pause", routine: r!.id })).output, /is paused/);
  assert.equal((await routinesOf())[0]?.off, true);
  assert.match((await asIvy({ action: "list" })).output, /· paused ·/);
  assert.match((await asIvy({ action: "resume", routine: "Daily downloads update" })).output, /is on again, next /);
  assert.equal((await routinesOf())[0]?.off, undefined);
  assert.match((await asIvy({ action: "update", routine: "weekly report" })).output, /Ivy has no routine "weekly report"\. It has: "Daily downloads update"/);

  // From a Code session: whose has to be said, and Ivy (full access) may do more than an agent there (edits), so it only looks.
  const fromCode = (args: Record<string, unknown>) => app.mesh.call(code.sessionId, MAIN_LANE, "manage_routine", args);
  assert.match((await fromCode({ action: "list" })).output, /Say whose routines: teammate, by name \(Ivy\)/);
  assert.match((await fromCode({ action: "list", teammate: "Zed" })).output, /no crew mate called Zed/);
  assert.match((await fromCode({ action: "list", teammate: "@ivy" })).output, /Ivy's routines:\n- Daily downloads update/);
  assert.match((await fromCode({ action: "delete", teammate: "Ivy", routine: "Daily downloads update" })).output, /Ivy may do more than you may \(full, you edits\)/);
  assert.equal((await routinesOf()).length, 1);

  // Run now, as its Run now does: asked in its chat (here a new thread, as it is set), as a check-in.
  const ran = await asIvy({ action: "run", routine: "downloads" });
  assert.ok(!ran.isError, ran.output);
  assert.match(ran.output, /"Daily downloads update" is running now, in a new thread/);

  // Deleted by Ivy itself.
  assert.match((await asIvy({ action: "delete", routine: "Daily downloads update" })).output, /Deleted Ivy's routine/);
  assert.equal((await routinesOf()).length, 0);
});

test("a crew mate is told recurring work is a routine of its own, not an automation", () => {
  const t = { id: "t1", name: "Ivy", role: "Growth", tool: "claude", folder: "/tmp/Ivy", lane: "l1", created: 0 } as unknown as Teammate;
  assert.match(teammateNote(t, []), /make it one of your routines with Friday's manage_routine: it runs here, in your chat/);
});
