// A crew room's files, and a session's whose coding tool is asleep, open from this computer's disk in the open-source edition
// (Arun, 2026-11-14: "say i hand over the work to the crew / crew room i cannot see the tree file stuff"). Another computer's
// folder still waits for that computer.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { localKV } from "../src/local/kv.js";
import { NO_MODELS } from "../src/local/no-models.js";

test("with its coding tool offline, a session's folder on this computer is still listed and read, live; another computer's isn't", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-offline-files-"));
  const kv = await localKV(home);
  const app = await createApp({ port: 0, redisUrl: "", prefix: "friday:", secret: "s", driverGraceMs: 15_000, llm: NO_MODELS, dataDir: path.join(home, "uploads"), local: { redis: kv.redis, sub: kv.sub, user: { id: "local", name: "Me" } }, teammatesHome: home });
  t.after(async () => (await app.close(), await kv.close(), await rm(home, { recursive: true, force: true })));
  const headers = { "Content-Type": "application/json", "x-friday-local": "1" };
  const me = { id: "local", name: "Me", kind: "human" } as const;

  // Kit's copy of the project, with the migration it wrote.
  const copy = path.join(home, "Kit", "copies", "edge");
  await mkdir(path.join(copy, "supabase", "migrations"), { recursive: true });
  await writeFile(path.join(copy, "package.json"), "{}\n");
  await writeFile(path.join(copy, "supabase", "migrations", "2026_vuln_cvelist.sql"), "create table vuln_cvelist ();\n");

  const { sessionId: sid } = (await (await fetch(`${app.url}/api/sessions`, { method: "POST", headers, body: JSON.stringify({ title: "EDAI300" }) })).json()) as { sessionId: string };
  const mine = (await (await fetch(`${app.url}/api/sessions/mine`, { headers })).json()) as { sessions: { sid: string; invite: string }[] };
  const invite = mine.sessions.find((x) => x.sid === sid)!.invite;
  await app.store.append(sid, me, { type: "engine.attached", engine: { hostId: "local", hostName: "Me", cwd: copy, mode: "full", tool: "claude" } });
  await app.store.append(sid, me, { type: "engine.detached", reason: "disconnected" });
  const repo = async (q: string) => (await (await fetch(`${app.url}/api/sessions/${sid}/repo?${q}&invite=${encodeURIComponent(invite)}`, { headers })).json()) as { output?: string; error?: string; stale?: unknown };

  const tree = await repo("op=tree");
  assert.match(tree.output ?? "", /package\.json/);
  assert.equal(tree.stale, undefined, "read now, not a listing kept from when its tool last ran");
  const read = await repo(`op=read&raw=1&path=${encodeURIComponent("supabase/migrations/2026_vuln_cvelist.sql")}`);
  assert.equal(read.error, undefined);
  assert.match(read.output ?? "", /create table vuln_cvelist/);
  assert.match((await repo("op=read&raw=1&path=nope.sql")).error ?? "", /^There's no file at nope\.sql/, "a file that isn't there says so, so the Tree tries the next crew mate's copy");

  // A crew mate's own lane in a room (or a coding session it was handed): the hub won't act in another folder for an offline lane,
  // but looking at the files in its folder on this computer works.
  const added = await app.core.handle(sid, { id: "local", name: "Me" }, { type: "lane.add", name: "Kit", engine: true });
  assert.ok(added.ok);
  const lane = ((await app.store.events(sid)).find((e) => e.seq === added.seq)!.body as { lane: { id: string } }).lane.id;
  await app.store.append(sid, me, { type: "engine.attached", engine: { hostId: "local", hostName: "Me", cwd: copy, mode: "full", tool: "claude" } }, { lane });
  await app.store.append(sid, me, { type: "engine.detached", reason: "disconnected" }, { lane });
  const kit = await repo(`lane=${lane}&op=read&raw=1&path=${encodeURIComponent("supabase/migrations/2026_vuln_cvelist.sql")}`);
  assert.equal(kit.error, undefined, kit.error);
  assert.match(kit.output ?? "", /create table vuln_cvelist/);
  assert.match((await repo(`lane=${lane}&op=tree`)).output ?? "", /supabase/);

  // A folder on another linked computer isn't on this disk: nothing is read from here in its place.
  const { sessionId: far } = (await (await fetch(`${app.url}/api/sessions`, { method: "POST", headers, body: JSON.stringify({ title: "On the Studio" }) })).json()) as { sessionId: string };
  const farInvite = ((await (await fetch(`${app.url}/api/sessions/mine`, { headers })).json()) as { sessions: { sid: string; invite: string }[] }).sessions.find((x) => x.sid === far)!.invite;
  await app.store.append(far, me, { type: "engine.attached", engine: { hostId: "local", hostName: "Studio", cwd: copy, mode: "full", tool: "claude", computer: "studio" } });
  await app.store.append(far, me, { type: "engine.detached", reason: "disconnected" });
  const farRead = (await (await fetch(`${app.url}/api/sessions/${far}/repo?op=read&raw=1&path=package.json&invite=${encodeURIComponent(farInvite)}`, { headers })).json()) as { output?: string; error?: string };
  assert.doesNotMatch(farRead.output ?? "", /^\{\}/);
});
