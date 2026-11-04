// Settings › Your computers on the hub, in the open-source edition (app.ts /api/computers, local/phone.ts, local/computers.ts):
// each row says what tells it apart and when it was last seen, can be renamed, says why it can't link when this computer can
// tell; the same computer paired again takes its old row's place with what ran on it; and Remove says what runs there, with its
// teammates offered a move to this computer (2026-11-04 linking test, linking fixes 5 and 6).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";

const edition = { skip: existsSync("src/link") ? "the open-source edition's: run in its export (scripts/oss-export.mts)" : false };
const me = { id: "local", name: "Maya" };
// Teammates are the open-source edition's; nothing of theirs really starts in a test.
process.env.FRIDAY_EDITION = "local";
process.env.FRIDAY_TEAMMATES_DRY = "1";

async function hub(t: test.TestContext) {
  const was = process.env.FRIDAY_LOCAL_RUNNER;
  process.env.FRIDAY_LOCAL_RUNNER = "0";
  const { createApp } = await import("../src/app.js");
  const { localKV } = await import("../src/local/kv.js");
  const { NO_MODELS } = await import("../src/local/no-models.js");
  const { PhoneAccess } = await import("../src/local/phone.js");
  const home = await mkdtemp(path.join(tmpdir(), "friday-comp-set-"));
  const kv = await localKV(home);
  // Friday's port isn't known until it listens: the listener is told it after.
  const phone = new PhoneAccess({ kv: kv.redis, home, appPort: 0, computer: "Studio", addresses: () => [{ address: "127.0.0.1", via: "tailscale" }], version: "0.2.11" });
  const app = await createApp({ port: 0, redisUrl: "", prefix: "friday:", secret: "s", driverGraceMs: 15_000, llm: NO_MODELS, dataDir: path.join(home, "uploads"), teammatesHome: home, local: { redis: kv.redis, sub: kv.sub, user: me, phone } });
  (phone as unknown as { o: { appPort: number } }).o.appPort = Number(new URL(app.url).port);
  const open: WebSocket[] = [];
  t.after(async () => {
    for (const w of open) w.terminate();
    await phone.stop();
    await app.close();
    await kv.close();
    if (was === undefined) delete process.env.FRIDAY_LOCAL_RUNNER;
    else process.env.FRIDAY_LOCAL_RUNNER = was;
    await rm(home, { recursive: true, force: true });
  });
  const call = async (p: string, method = "GET", json?: unknown) => {
    const r = await fetch(`${app.url}${p}`, { method, headers: { "Content-Type": "application/json", "x-friday-local": "1" }, ...(json === undefined ? {} : { body: JSON.stringify(json) }) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  /** Another computer pairing with a code, as its Friday does (join.ts): its install's id, its token and device. */
  const pair = async (machine: string, name: string) => {
    const c = (await call("/api/computers/code", "POST")).body as { code: string };
    const st = await phone.state();
    return new Promise<{ token: string; device: string }>((resolve) => {
      const req = (st.secure ? https : http).request({ host: "127.0.0.1", port: st.computers!.port!, method: "POST", path: "/phone/pair", rejectUnauthorized: false, headers: { "content-type": "application/json" } }, (r) => {
        let s = "";
        r.on("data", (d) => (s += d));
        r.on("end", () => resolve(JSON.parse(s)));
      });
      req.end(JSON.stringify({ code: c.code, name, kind: "computer", machine }));
    });
  };
  /** Its link, as the listener hands it over. */
  const link = async (device: string, name: string) => {
    const sock = new WebSocket(`${app.url.replace(/^http/, "ws")}/link`, { headers: { "x-friday-via": "computer", "x-friday-device": device, "x-friday-device-name": encodeURIComponent(name), "x-friday-device-address": "192.168.1.20" } });
    open.push(sock);
    await new Promise((r) => sock.once("open", r));
    const linked = new Promise((r) => sock.on("message", (raw) => JSON.parse(String(raw)).kind === "linked" && r(null)));
    sock.send(JSON.stringify({ kind: "hello", machine: { name: "mini-2", platform: "linux" }, tools: [] }));
    await linked;
    return sock;
  };
  const until = async (ok: () => boolean | Promise<boolean>, what: string) => {
    for (let i = 0; i < 300; i++) {
      if (await ok()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail(`timed out waiting for ${what}`);
  };
  return { app, call, pair, link, until, phone };
}

type Row = { id: string; name: string; connected: boolean; detail?: string; seen: number; problem?: string; version?: string };

test("each computer's row tells it apart, can be renamed, and the same computer paired again replaces it with its teammates", edition, async (t) => {
  const h = await hub(t);
  const M = "d".repeat(32);
  const a = await h.pair(M, "Arun's Mac Studio");
  const sock = await h.link(a.device, "Arun's Mac Studio");
  const rows = async () => ((await h.call("/api/computers")).body.computers as Row[]) ?? [];
  await h.until(async () => (await rows())[0]?.detail === "Linux · mini-2", "what it said of itself, on its row");
  // What runs there, for Remove to say: a teammate on it.
  const made = await h.call("/api/teammates", "POST", { name: "Remy", role: "Checks", tool: "claude", machine: a.device });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const uses = (await h.call(`/api/computers/${a.device}/uses`)).body as { teammates: { name: string }[]; sessions: number };
  assert.deepEqual(uses.teammates.map((x) => x.name), ["Remy"]);
  // Renamed: two of yours can have the same name.
  const renamed = (await h.call(`/api/computers/${a.device}`, "PATCH", { name: "Build box" })).body.computers as Row[];
  assert.equal(renamed[0]?.name, "Build box");
  const machines = (await h.call("/api/machines")).body.machines as { label: string; detail: string }[];
  assert.deepEqual(machines.map((m) => [m.label, m.detail]), [["Build box", "Linux · mini-2"]]);
  sock.terminate();
  await h.until(async () => (await rows())[0]?.connected === false, "it going offline");
  // Paired again (added again by SSH): one row, the name given here kept, and Remy is that computer's still.
  const b = await h.pair(M, "Arun's Mac Studio");
  const now = await rows();
  assert.deepEqual(now.map((r) => [r.id, r.name]), [[b.device, "Build box"]]);
  const again = (await h.call(`/api/computers/${b.device}/uses`)).body as { teammates: { name: string }[] };
  assert.deepEqual(again.teammates.map((x) => x.name), ["Remy"], "its teammates come back with it");
  // Removed with its teammates moved to this computer: Remy runs here now.
  await h.call(`/api/computers/${b.device}?move=teammates`, "DELETE");
  const team = (await h.call("/api/teammates")).body as { teammates?: { name: string; machine?: string }[] };
  assert.equal(team.teammates?.find((x) => x.name === "Remy")?.machine, undefined);
  assert.equal((await rows()).length, 0);
});

test("a computer paired before this one made a new certificate says so on its row, rather than only 'Not connected'", edition, async (t) => {
  const h = await hub(t);
  const a = await h.pair("e".repeat(32), "Mac mini");
  // As if its certificate files were made again: the fingerprint it paired with is no longer this computer's.
  const kv = (h.phone as unknown as { o: { kv: { hget(k: string, f: string): Promise<string | null>; hset(k: string, f: string, v: string): Promise<unknown> } } }).o.kv;
  const raw = JSON.parse((await kv.hget("friday:phone:devices", a.device)) ?? "{}") as Record<string, unknown>;
  await kv.hset("friday:phone:devices", a.device, JSON.stringify({ ...raw, fp: "0".repeat(64), port: 1 }));
  const row = ((await h.call("/api/computers")).body.computers as Row[])[0]!;
  assert.match(row.problem ?? "", /Pair it again/);
});
