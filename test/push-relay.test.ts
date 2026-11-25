// Friday's push service (src/push-relay.ts), as anyone runs it: what Apple is given, the limits, and the HTTP route.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { PushRelay, relayServer, PER_PHONE, type PushConfig } from "../src/push-relay.js";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const config: PushConfig = { key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), keyId: "KEY123", teamId: "TEAM456", topic: "com.example.friday" };
const phone = { token: "d".repeat(64), env: "production" as const };
const sealed = "x".repeat(80);

test("Apple is given 'Friday' and the sealed bytes, nothing of the work", async () => {
  const sent: Record<string, unknown>[] = [];
  const relay = new PushRelay(config, undefined, async (_c, _d, _j, p) => (sent.push(p), 200));
  assert.equal(await relay.relay(phone, sealed, "time-sensitive", "thread1", "1.2.3.4"), 200);
  assert.deepEqual(sent[0], { aps: { alert: { title: "Friday", body: "Something needs you" }, "mutable-content": 1, sound: "default", "interruption-level": "time-sensitive", "thread-id": "thread1" }, s: sealed });
  assert.equal(await relay.relay({ ...phone, token: "not hex" }, sealed, "active", "", "1.2.3.4"), 400);
  assert.equal(await relay.relay(phone, "short", "active", "", "1.2.3.4"), 400);
  assert.equal(await new PushRelay(null).relay(phone, sealed, "active", "", "1.2.3.4"), 503, "no Apple key: refused");
});

test("a phone gets at most its hourly share, and a debug build's token is tried in the sandbox", async () => {
  const envs: string[] = [];
  const relay = new PushRelay(config, undefined, async (_c, d) => (envs.push(d.env), d.env === "sandbox" ? 200 : 400));
  assert.equal(await relay.relay(phone, sealed, "active", "", "a"), 200);
  assert.deepEqual(envs, ["production", "sandbox"]);
  for (let i = 1; i < PER_PHONE; i++) await relay.relay(phone, sealed, "active", "", "a");
  assert.equal(await relay.relay(phone, sealed, "active", "", "a"), 429);
  assert.equal(await relay.relay({ ...phone, token: "e".repeat(64) }, sealed, "active", "", "a"), 200, "another phone still gets its own");
});

test("run on its own, it answers its one route and says nothing else", async (t) => {
  const server = relayServer(new PushRelay(config, undefined, async () => 200));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const ok = await fetch(`${base}/api/push/relay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: phone.token, env: "production", sealed, level: "active", thread: "" }) });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  assert.equal((await fetch(`${base}/api/push/relay`, { method: "POST", body: "{nope" })).status, 400);
  assert.equal((await fetch(`${base}/`, {})).status, 404);
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true, push: true });
});

test("a .p8 key pasted on one line, with its breaks as spaces, as \\n or run together, still signs (Render, 2026-11-24)", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { pemOf, providerToken } = await import("../src/push-relay.js");
  const pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim();
  const lines = pem.split("\n");
  for (const pasted of [pem, lines.join(" "), lines.join("\\n"), `${lines[0]}${lines.slice(1, -1).join("")}${lines.at(-1)}`, `  ${pem}\n`]) {
    const key = pemOf(pasted)!;
    assert.match(providerToken({ key, keyId: "ABC123DEFG", teamId: "24DXLQLMPR", topic: "com.tryfridaywork.friday" }), /^[\w-]+\.[\w-]+\.[\w-]+$/);
  }
  assert.equal(pemOf(undefined), undefined);
  assert.equal(pemOf("  "), undefined);
});
