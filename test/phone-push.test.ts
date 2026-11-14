// Notifications on your phone from the Friday on this computer (local/phone-push.ts, local/phone.ts): sealed so only the phone
// reads them, each once, only to phones that said where, and none while phone access is off.
import test from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, randomBytes } from "node:crypto";
import https from "node:https";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PhonePush, noteFor, pushKey, relayFromEnv, seal, type PushNote, type PushTarget } from "../src/local/phone-push.js";
import { PhoneAccess, pushOf, type PhoneKV } from "../src/local/phone.js";
import type { Attention } from "../src/attention.js";

const approval: Attention = { sid: "s1", title: "Checkout", kind: "approval", text: "Claude Code wants to run `npm test`", seq: 7, lane: "l1", agent: "Claude Code", approval: "ap1", command: true };

/** As the phone's notification extension opens it (NotificationService.swift): nonce, ciphertext, tag. */
function open(key: Buffer, sealed: string): PushNote {
  const b = Buffer.from(sealed, "base64url");
  const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(b.length - 16));
  return JSON.parse(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString("utf8")) as PushNote;
}

function memKV(): PhoneKV {
  const s = new Map<string, string>();
  const h = new Map<string, Map<string, string>>();
  const hm = (k: string) => (h.get(k) ?? (h.set(k, new Map()), h.get(k)!));
  return {
    get: async (k) => s.get(k) ?? null,
    set: async (k, v) => void s.set(k, v),
    del: async (k) => void s.delete(k),
    hget: async (k, f) => hm(k).get(f) ?? null,
    hset: async (k, f, v) => void hm(k).set(f, v),
    hdel: async (k, f) => void hm(k).delete(f),
    hgetall: async (k) => Object.fromEntries(hm(k)),
  };
}

test("sealed for the phone's key only: it opens with that key, and a changed byte or another key fails", () => {
  const key = randomBytes(32);
  const note = noteFor(approval);
  const sealed = seal(key, note);
  assert.deepEqual(open(key, sealed), { title: "Checkout", body: "Claude Code wants to run `npm test`", sid: "s1", kind: "approval", lane: "l1", approval: "ap1" });
  assert.ok(!sealed.includes("npm"), "nothing readable in it");
  assert.notEqual(seal(key, note), sealed, "a new nonce each time");
  assert.throws(() => open(randomBytes(32), sealed));
  const b = Buffer.from(sealed, "base64url");
  b[20] = b[20]! ^ 1;
  assert.throws(() => open(key, b.toString("base64url")));
});

test("a phone's key and token are checked; the service is Friday's unless one is named or it is off", () => {
  const key = randomBytes(32);
  assert.equal(pushKey(key.toString("base64"))?.length, 32);
  assert.equal(pushKey(key.toString("base64url"))?.length, 32);
  assert.equal(pushKey("short"), null);
  assert.deepEqual(pushOf({ token: "AB".repeat(32), key: key.toString("base64url"), env: "sandbox" }), { token: "ab".repeat(32), env: "sandbox", key: key.toString("base64") });
  assert.equal(pushOf({ token: "not hex", key: key.toString("base64") }), null);
  assert.equal(pushOf({ token: "ab".repeat(32), key: "short" }), null);
  assert.equal(relayFromEnv({}), "https://www.app.tryfridaywork.com/api/push/relay");
  assert.equal(relayFromEnv({ FRIDAY_PUSH_RELAY: "https://push.example.com/relay" }), "https://push.example.com/relay");
  assert.equal(relayFromEnv({ FRIDAY_PUSH_RELAY: "off" }), null);
});

test("each wait is sent once to each phone, sealed with its own key; a phone Apple says is gone stops being sent to", async () => {
  const keys = { a: randomBytes(32), b: randomBytes(32) };
  let targets: PushTarget[] = [
    { id: "a", token: "a".repeat(64), env: "production", key: keys.a.toString("base64") },
    { id: "b", token: "b".repeat(64), env: "sandbox", key: keys.b.toString("base64") },
  ];
  const sent: { token: string; sealed: string; level: string; thread: string; env: string }[] = [];
  const gone: string[] = [];
  const push = new PhonePush({
    kv: memKV(),
    targets: async () => targets,
    gone: async (id) => (gone.push(id), (targets = targets.filter((t) => t.id !== id))),
    relay: "https://relay.test/push",
    send: async (_u, body) => (sent.push(body as never), (body.token as string).startsWith("b") ? 410 : 200),
  });
  assert.equal(await push.notify([approval]), 1);
  assert.equal(sent.length, 2);
  assert.equal(open(keys.a, sent[0]!.sealed).approval, "ap1");
  assert.equal(open(keys.b, sent[1]!.sealed).sid, "s1");
  assert.throws(() => open(keys.a, sent[1]!.sealed), "each phone's own key");
  assert.equal(sent[0]!.level, "time-sensitive");
  assert.ok(!sent[0]!.thread.includes("s1"), "the service never learns the session");
  assert.deepEqual(gone, ["b"]);
  assert.equal(await push.notify([approval]), 0, "the same wait isn't sent twice");
  assert.equal(await push.notify([{ ...approval, seq: 9, kind: "stopped", approval: undefined }]), 1);
  assert.equal(sent.at(-1)!.level, "active");
  assert.equal(await push.done("done:s1:12", { title: "Checkout", body: "The run finished.", sid: "s1", kind: "done" }), 1);
  assert.equal(await push.done("done:s1:12", { title: "Checkout", body: "The run finished.", sid: "s1", kind: "done" }), 0);
  const off = new PhonePush({ kv: memKV(), targets: async () => targets, gone: async () => {}, relay: null, send: async () => 200 });
  assert.equal(await off.notify([approval]), 0, "FRIDAY_PUSH_RELAY=off sends nothing");
});

test("a phone pairs with where its notifications go, can change it, and is sent nothing while phone access is off", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "phone-push-"));
  const app = http.createServer((_req, res) => res.end("{}"));
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
  const phone = new PhoneAccess({ kv: memKV(), home, appPort: (app.address() as { port: number }).port, computer: "Test Mac", addresses: () => [{ address: "127.0.0.1", via: "tailscale" }], version: "0.2.24" });
  try {
    await phone.setOn(true);
    const code = (await phone.pairCode()) as { code: string; link: string };
    const link = new URL(code.link);
    const call = (method: string, p: string, o: { token?: string; body?: object } = {}) =>
      new Promise<[number, Record<string, unknown>]>((resolve) => {
        const req = (link.searchParams.get("s") === "https" ? https : http).request({ host: "127.0.0.1", port: Number(link.searchParams.get("p")), method, path: p, rejectUnauthorized: false, agent: false, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) } }, (r) => {
          let b = "";
          r.on("data", (c) => (b += c));
          r.on("end", () => resolve([r.statusCode ?? 0, JSON.parse(b || "{}") as Record<string, unknown>]));
        });
        req.end(o.body ? JSON.stringify(o.body) : undefined);
      });
    const key = randomBytes(32).toString("base64");
    const [ok, paired] = await call("POST", "/phone/pair", { body: { code: code.code, name: "Maya's iPhone", push: { token: "c".repeat(64), env: "sandbox", key } } });
    assert.equal(ok, 200);
    const token = paired.token as string;
    assert.deepEqual(await phone.pushTargets(), [{ id: paired.device, token: "c".repeat(64), env: "sandbox", key }]);
    const st = await phone.state();
    assert.equal(st.devices[0]?.notifies, true);
    assert.ok(!JSON.stringify(st).includes(key), "Settings never sees the key");
    const [, hello] = await call("GET", "/phone/hello", { token });
    assert.equal(hello.notifies, true);
    assert.equal(hello.version, "0.2.24");
    // A new token from Apple.
    assert.equal((await call("POST", "/phone/push", { token, body: { token: "e".repeat(64), env: "production", key } }))[0], 200);
    assert.equal((await phone.pushTargets())[0]?.token, "e".repeat(64));
    assert.equal((await call("POST", "/phone/push", { token, body: { token: "zz", key } }))[0], 400);
    // Phone access off: nothing is sent, and its details come back with it.
    await phone.setOn(false);
    assert.deepEqual(await phone.pushTargets(), []);
    await phone.setOn(true);
    assert.equal((await phone.pushTargets()).length, 1);
    assert.equal((await call("POST", "/phone/push", { token, body: { off: true } }))[0], 200);
    assert.deepEqual(await phone.pushTargets(), []);
    await call("POST", "/phone/push", { token, body: { token: "e".repeat(64), env: "production", key } });
    await phone.dropPush(paired.device as string);
    assert.deepEqual(await phone.pushTargets(), [], "gone at Apple: dropped");
    assert.equal((await phone.state()).devices.length, 1, "the phone itself stays paired");
  } finally {
    await phone.stop();
    app.closeAllConnections();
    app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a test notification goes to the phone that asked, sealed, at most once every ten seconds", async () => {
  const key = randomBytes(32);
  const sent: { token: string; sealed: string }[] = [];
  const push = new PhonePush({
    kv: memKV(),
    targets: async () => [{ id: "a", token: "a".repeat(64), env: "production", key: key.toString("base64") }],
    gone: async () => {},
    relay: "https://relay.test/push",
    send: async (_u, body) => (sent.push(body as never), 200),
  });
  assert.equal(await push.test("a", "Maya's Mac"), 200);
  assert.equal(open(key, sent[0]!.sealed).body, "Notifications from Maya's Mac reach this phone.");
  assert.equal(await push.test("a", "Maya's Mac"), 0, "too soon");
  assert.equal(await push.test("nobody", "Maya's Mac"), 0);
  assert.equal(sent.length, 1);
});
