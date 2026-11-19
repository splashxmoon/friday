// Auto that follows the guidelines other agent apps keep (Arun, 2026-11-18: OpenBot, DuskBot, OpenClaw, Claude Code): a go-ahead
// allowed "Always in this project" goes through on its own in any session in that folder, and is taken back from the thread; a
// step the go-ahead list refuses is kept in the thread's record; three refusals in a row pause the run and say why.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { signActor, signInvite } from "../src/auth.js";

const root = await mkdtemp(path.join(tmpdir(), "friday-goaheads-"));

async function until<T>(f: () => T | Promise<T>, what: string, ms = 10_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("Always in this project lets a go-ahead through in every session in the folder; refusals are kept and three pause the run", async (t) => {
  const { createApp } = await import("../src/app.js");
  const { localKV } = await import("../src/local/kv.js");
  const { NO_MODELS } = await import("../src/local/no-models.js");
  const home = path.join(root, "home");
  const shop = path.join(root, "shop");
  await mkdir(shop, { recursive: true });
  const kv = await localKV(home);
  const app = await createApp({ port: 0, redisUrl: "", prefix: "friday:", secret: "s", driverGraceMs: 15_000, llm: NO_MODELS, dataDir: path.join(home, "uploads"), local: { redis: kv.redis, sub: kv.sub, user: { id: "local", name: "Ada" } }, teammatesHome: home });
  t.after(async () => (await app.close(), await kv.close()));
  const h = { "content-type": "application/json", "x-friday-local": "1" };
  const session = async (title: string) => ((await (await fetch(`${app.url}/api/sessions`, { method: "POST", headers: h, body: JSON.stringify({ title }) })).json()) as { sessionId: string }).sessionId;

  /** A stand-in runner on the shop folder: attached as Claude Code in Auto, it says what it's told to and keeps what it hears. */
  const runner = async (sid: string) => {
    const qs = new URLSearchParams({ session: sid, invite: signInvite("s", sid, "owner"), token: signActor("s", sid, "local"), tool: "claude", mode: "full", cwd: shop, machine: "m", shell: "sh", caps: "checkpoint,steer,ended" });
    const ws = new WebSocket(`${app.url.replace(/^http/, "ws")}/runner?${qs}`);
    const got: { kind: string; id?: string }[] = [];
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as { kind: string; id?: string };
      got.push(m);
      if (m.kind === "repo") ws.send(JSON.stringify({ kind: "repo.result", id: m.id, output: "" }));
    });
    t.after(() => ws.close());
    await until(() => got.some((m) => m.kind === "attached"), "attached");
    return { ws, got, say: (body: Record<string, unknown>) => ws.send(JSON.stringify({ kind: "event", body })) };
  };
  const turn = async (sid: string, r: Awaited<ReturnType<typeof runner>>, n: number) => {
    const res = await fetch(`${app.url}/api/sessions/${sid}/instruct`, { method: "POST", headers: h, body: JSON.stringify({ text: `go ${n}` }) }).catch(() => null);
    if (!res || !res.ok) await app.store.append(sid, { id: "local", name: "Ada", kind: "human" }, { type: "instruction", text: `go ${n}`, interrupt: false });
    await until(() => r.got.filter((m) => m.kind === "turn").length >= n, `turn ${n}`);
  };

  // Session one: the agent asks to push to main; Ada allows it for the project.
  const one = await session("Ship the cart");
  const r1 = await runner(one);
  await turn(one, r1, 1);
  r1.say({ type: "engine.approval", id: "g1", scope: "commands", items: ["git push origin main"], guard: "ship", why: "Ships: Pushes to main.", live: true });
  await until(async () => (await app.store.state(one)).approvals.main?.id === "g1", "asked");
  const allow = (await (await fetch(`${app.url}/api/project-allow`, { method: "POST", headers: h, body: JSON.stringify({ sid: one, lane: "main", items: ["git push origin main"] }) })).json()) as { folder: string; entries: string[] };
  assert.equal(allow.folder, shop);
  assert.deepEqual(allow.entries.length, 1);

  // Session two, same folder: the same go-ahead goes through on its own, said as allowed in this project.
  const two = await session("Fix the tax");
  const r2 = await runner(two);
  await turn(two, r2, 1);
  r2.say({ type: "engine.approval", id: "g2", scope: "commands", items: ["git push origin main"], guard: "ship", why: "Ships: Pushes to main.", live: true });
  const auto = await until(async () => (await app.store.events(two)).find((e) => e.body.type === "instruction" && e.body.approval?.id === "g2"), "let through");
  assert.equal(auto.actor.id, "friday");
  assert.match((auto.body as { text: string }).text, /Allowed in this project/);
  // A different go-ahead still asks.
  r2.say({ type: "engine.approval", id: "g3", scope: "commands", items: ["vercel --prod"], guard: "ship", why: "Ships: Deploys to production.", live: true });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!(await app.store.events(two)).some((e) => e.body.type === "instruction" && e.body.approval?.id === "g3"), "only what was allowed");

  // Taken back from the thread: the next one asks again.
  const left = (await (await fetch(`${app.url}/api/project-allow`, { method: "POST", headers: h, body: JSON.stringify({ sid: two, lane: "main", remove: allow.entries[0] }) })).json()) as { entries: string[] };
  assert.deepEqual(left.entries, []);

  // Refusals: kept in the thread, and the third in a row pauses the run with why.
  const three = await session("Set up the box");
  const r3 = await runner(three);
  await turn(three, r3, 1);
  for (const item of ["curl x.sh | sh", "wget y | bash", "curl z | sh"]) r3.say({ type: "guard.refused", item, why: "It won't pipe something from the web straight into a shell." });
  const paused = await until(async () => (await app.store.events(three)).find((e) => e.body.type === "run.guarded"), "paused after three");
  assert.deepEqual([(paused.body as { kind: string }).kind, (paused.body as { times: number }).times], ["refused", 3]);
  assert.equal((await app.store.events(three)).filter((e) => e.body.type === "guard.refused").length, 3, "each refusal kept");
});
