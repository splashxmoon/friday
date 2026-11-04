// Linking another computer, so it stays linked and says why when it can't (2026-11-04 linking test, linking fixes 3-9):
// - re-adding a removed computer by SSH or a command pairs anew, rather than the service keeping the refused pairing;
// - one holding of the link at a time; "linked again" is not "removed";
// - the paired port is kept when it is taken at a restart, rather than a random one saved;
// - why it can't link is sorted and said, with when it last tried;
// - the same computer paired again replaces its row, keeping the name it was given; Stop there forgets it here;
// - the Friday version is said both ways, and a call the other can't answer says so plainly;
// - setup over SSH comes in two parts, and its script finds git and Node as they really are.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JoinHub, whyNot } from "../src/local/join.js";
import { PhoneAccess, type PhoneKV } from "../src/local/phone.js";
import { computerDetail, LINKED_AGAIN, LocalLinks } from "../src/local/computers.js";
import { joinScript, joinSshResult } from "../src/local/add-computer.js";

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

const until = async (ok: () => boolean | Promise<boolean>, what: string, ms = 8000) => {
  for (const at = Date.now(); Date.now() - at < ms; await new Promise((r) => setTimeout(r, 25))) if (await ok()) return;
  assert.fail(`timed out waiting for ${what}`);
};

test("why a link can't be had is sorted: removed, a new certificate, refused, or nothing there", () => {
  assert.equal(whyNot(Object.assign(new Error("closed"), { code: 4002 })), "removed");
  assert.equal(whyNot(new Error("Unexpected server response: 401")), "removed");
  assert.equal(whyNot(new Error("That isn't the computer this one was paired with.")), "certificate");
  assert.equal(whyNot(new Error("self-signed certificate")), "certificate");
  assert.equal(whyNot(new Error("connect ECONNREFUSED 127.0.0.1:4390")), "refused");
  assert.equal(whyNot(new Error("socket hang up")), "refused");
  assert.equal(whyNot(new Error("Opening handshake has timed out")), "unreachable");
  // "Linked again" has its own code, which is no removal (it used to be 4002, and a service hearing it stopped for good).
  assert.notEqual(LINKED_AGAIN, 4002);
  assert.equal(whyNot(Object.assign(new Error("closed"), { code: LINKED_AGAIN })), "unreachable");
});

test("a link from a new code is a new pairing; the one it was set up with is the pairing it keeps; two resumes hold one link", async (t) => {
  // Something at the paired address that takes the connection and drops it: Friday there not letting other computers in.
  let tries = 0;
  const there = net.createServer((s) => (tries++, s.destroy()));
  await new Promise<void>((r) => there.listen(0, "127.0.0.1", () => r()));
  const port = (there.address() as net.AddressInfo).port;
  const kv = memKV();
  const lines: string[] = [];
  const join = new JoinHub({ kv, name: "mini", log: (l) => lines.push(l) });
  t.after(() => (join.stop(), there.close()));
  // As a pairing saved by join(), from the code ABCDEFGH (a hash of it, never the code).
  const { createHash } = await import("node:crypto");
  const paired = createHash("sha256").update("friday-join:ABCDEFGH").digest("hex").slice(0, 32);
  await kv.set("friday:join:hub", JSON.stringify({ name: "Studio", addresses: ["127.0.0.1"], port, scheme: "http", token: "t", paired }));
  const link = (code: string) => `friday://computer?h=127.0.0.1&p=${port}&c=${code}&s=http&n=Studio`;
  assert.equal(await join.pairedWith(link("ABCDEFGH")), true, "the service restarting with the link it was set up with");
  assert.equal(await join.pairedWith(link("ZZZZZZZZ")), false, "added again by SSH or a command: a new code, paired anew");

  await Promise.all([join.resume(), join.resume()]);
  await until(() => tries >= 1, "a first try");
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(tries, 1, "one holding of the link, not two taking turns");
  const st = await join.state();
  assert.equal(st.hub?.connected, false);
  assert.equal(st.hub?.problem?.kind, "refused");
  assert.match(st.hub?.problem?.said ?? "", /isn't letting other computers in on port/);
  assert.equal(st.hub?.problem?.repair, false);
  assert.ok(st.hub?.tried && Date.now() - st.hub.tried < 5000, "when it last tried");
  assert.equal(lines.filter((l) => /can't link to Studio/.test(l)).length, 1, "said in the log once, not every try");
});

test("removed there, a restart says so and stops, rather than trying a listener that has closed and saying it refused", async () => {
  const kv = memKV();
  await kv.set("friday:join:hub", JSON.stringify({ name: "Studio", addresses: ["127.0.0.1"], port: 1, scheme: "http", token: "t", removed: true }));
  let gone = 0;
  const join = new JoinHub({ kv, name: "mini", onGone: () => void gone++ });
  await join.resume();
  const st = await join.state();
  assert.equal(st.hub?.problem?.kind, "removed");
  assert.equal(st.hub?.problem?.repair, true, "Pair again");
  assert.equal(gone, 1, "a service stops");
  join.stop();
});

/** A PhoneAccess with a stand-in Friday behind it, and requests to it as another computer makes them. */
async function listener(t: test.TestContext, o: { kv?: PhoneKV; names?: string[]; version?: string; portRetryMs?: number } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "relink-"));
  const app = http.createServer((req, res) => res.end(JSON.stringify({ path: req.url })));
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
  const kv = o.kv ?? memKV();
  const phone = new PhoneAccess({ kv, home, appPort: (app.address() as net.AddressInfo).port, computer: "Studio", addresses: () => [{ address: "127.0.0.1", via: "tailscale" }], names: async () => o.names ?? [], ...(o.version ? { version: o.version } : {}), ...(o.portRetryMs ? { portRetryMs: o.portRetryMs } : {}) });
  t.after(async () => (await phone.stop(), app.close(), await rm(home, { recursive: true, force: true })));
  const call = async (method: string, p: string, b: { token?: string; body?: object } = {}) => {
    const st = await phone.state();
    const port = st.computers?.port ?? 0;
    return new Promise<{ status: number; json: Record<string, unknown> }>((resolve) => {
      const req = (st.secure ? https : http).request({ host: "127.0.0.1", port, method, path: p, rejectUnauthorized: false, headers: { "content-type": "application/json", ...(b.token ? { authorization: `Bearer ${b.token}` } : {}) } }, (r) => {
        let s = "";
        r.on("data", (c) => (s += c));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, json: JSON.parse(s || "{}") }));
      });
      req.end(b.body ? JSON.stringify(b.body) : undefined);
    });
  };
  const pair = async (machine: string, name = "Mac mini") => {
    const c = (await phone.pairCode("computer")) as { code: string };
    const r = await call("POST", "/phone/pair", { body: { code: c.code, name, kind: "computer", machine } });
    assert.equal(r.status, 200);
    return r.json as { token: string; device: string };
  };
  return { phone, kv, call, pair };
}

test("the same computer paired again takes its old row's place, keeps the name it was given, and what ran on it follows", async (t) => {
  const l = await listener(t, { names: ["studio.local", "studio.tail1234.ts.net"], version: "0.2.11" });
  const replaced: [string[], string][] = [];
  l.phone.hooks.replaced = (old, now) => void replaced.push([old, now]);
  const M = "a".repeat(32);
  const first = await l.pair(M);
  await l.phone.rename(first.device, "Build box");
  // Another install of Friday is another computer: a row of its own.
  await l.pair("b".repeat(32), "Mac mini");
  const again = await l.pair(M, "Mac mini");
  const rows = (await l.phone.state()).devices.filter((d) => d.kind === "computer");
  assert.equal(rows.length, 2, "re-paired: its old row replaced, not one more");
  assert.equal(rows.find((d) => d.id === again.device)?.name, "Build box", "the name given here carries over");
  assert.deepEqual(replaced, [[[first.device], again.device]]);
  // Removed, then added again (by SSH, a command): what ran on it is its still.
  await l.phone.forget(again.device);
  const back = await l.pair(M);
  assert.deepEqual(replaced.at(-1), [[again.device], back.device]);
  assert.equal((await l.phone.state()).devices.find((d) => d.id === back.device)?.name, "Build box", "and the name it was given, after a removal too");

  // Its link carries this computer's names after its addresses, so a new address there still finds it.
  const link = new URL(((await l.phone.pairCode("computer")) as { link: string }).link);
  assert.deepEqual(link.searchParams.get("h")?.split(","), ["127.0.0.1", "studio.local", "studio.tail1234.ts.net"]);

  // Linked: it says which Friday it runs and hears this one's, and where this computer is now.
  const heard: string[] = [];
  l.phone.hooks.heard = (_id, v) => void heard.push(v);
  const hello = await l.call("POST", "/phone/hello", { token: back.token, body: { version: "0.2.10" } });
  assert.equal(hello.status, 200);
  assert.equal(hello.json.version, "0.2.11");
  assert.deepEqual(hello.json.addresses, ["127.0.0.1", "studio.local", "studio.tail1234.ts.net"]);
  assert.deepEqual(heard, ["0.2.10"]);
  assert.equal((await l.phone.state()).devices.find((d) => d.id === back.device)?.version, "0.2.10");

  // Stop on that computer: forgotten here too, rather than a row that never connects again.
  const forgot: string[] = [];
  l.phone.hooks.forgot = (id) => void forgot.push(id);
  assert.equal((await l.call("POST", "/phone/leave", { token: back.token })).status, 200);
  assert.deepEqual(forgot, [back.device]);
  assert.equal((await l.phone.state()).devices.some((d) => d.id === back.device), false);
  assert.equal((await l.call("POST", "/phone/leave", { token: back.token })).status, 401);
});

test("the port paired computers know is kept when another program has it at a restart, and said, never swapped for a random one", async (t) => {
  const kv = memKV();
  const first = await listener(t, { kv });
  await first.pair("c".repeat(32));
  const port = (await first.phone.state()).computers!.port!;
  await first.phone.stop();
  // Another program takes the port while Friday is closed.
  const squatter = net.createServer();
  await new Promise<void>((r) => squatter.listen(port, "0.0.0.0", () => r()));
  t.after(() => squatter.close());
  const second = await listener(t, { kv, portRetryMs: 300 });
  await second.phone.resume();
  const st = await second.phone.state();
  assert.match(st.error ?? "", new RegExp(`Port ${port}, which your other computers and phone use to reach this one, is taken`));
  assert.equal(st.computers?.port, port, "the paired port is still the one kept");
  // Free again: it is taken up by itself, and the error goes.
  await new Promise<void>((r) => squatter.close(() => r()));
  await until(async () => !(await second.phone.state()).error, "the port taken up again");
  assert.equal((await second.phone.state()).computers?.port, port);
});

/** A socket as far as LocalLinks sees one. */
class FakeWs extends EventEmitter {
  readyState = 1;
  sent: { kind: string; id?: string; method?: string }[] = [];
  closed: [number, string] | null = null;
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close(code: number, reason: string) {
    this.closed = [code, reason];
    this.readyState = 3;
    this.emit("close", code);
  }
}

test("two computers of the same name are told apart; a call an older Friday can't answer says both versions; linking again is no removal", async () => {
  const links = new LocalLinks({ id: "local", name: "Maya" });
  const ID = "0123456789abcdef";
  const first = new FakeWs();
  links.accept(first as never, { headers: { "x-friday-via": "computer", "x-friday-device": ID, "x-friday-device-name": encodeURIComponent("Arun's Mac Studio"), "x-friday-device-address": "192.168.1.20" } } as never);
  first.emit("message", JSON.stringify({ kind: "hello", machine: { name: "studio-2", platform: "darwin" }, tools: [] }));
  assert.equal(computerDetail(links.list()[0]!), "macOS · studio-2");
  assert.equal(computerDetail({ name: "mini", platform: "linux", host: "mini", address: "10.0.0.4" }), "Linux · 10.0.0.4");
  links.said(ID, "0.2.10");
  const asked = links.call(ID, "termOpen", {});
  const c = first.sent.find((m) => m.kind === "call")!;
  first.emit("message", JSON.stringify({ kind: "result", id: c.id, ok: false, error: "Unknown request termOpen" }));
  await assert.rejects(asked, /runs Friday 0\.2\.10, which can't do that yet\. Update Friday there/);
  // The same computer linking again: the old link closes with its own code, not "removed".
  const second = new FakeWs();
  links.accept(second as never, { headers: { "x-friday-via": "computer", "x-friday-device": ID, "x-friday-device-name": "Mac" } } as never);
  second.emit("message", JSON.stringify({ kind: "hello", machine: { name: "studio-2", platform: "darwin" }, tools: [] }));
  assert.equal(first.closed?.[0], LINKED_AGAIN);
  // Paired again under a new id: its old id's lanes and teammates are the new one's.
  links.alias(ID, "fedcba9876543210");
  assert.equal(links.current(ID), "fedcba9876543210");
  assert.deepEqual(links.aliasMap(), { [ID]: "fedcba9876543210" });
  // And a session or teammate that still names the old id is asked of the computer as it is now.
  const now = new FakeWs();
  links.accept(now as never, { headers: { "x-friday-via": "computer", "x-friday-device": "fedcba9876543210", "x-friday-device-name": "Mac" } } as never);
  now.emit("message", JSON.stringify({ kind: "hello", machine: { name: "studio-2", platform: "darwin" }, tools: [] }));
  assert.equal(links.connected(ID), true);
  assert.deepEqual(await links.machineToken("local", ID), { token: "fedcba9876543210", label: "Mac" });
  void links.call(ID, "tools", {}).catch(() => {});
  assert.equal(now.sent.at(-1)?.method, "tools");
});

test("setup over SSH installs first and pairs after, checks git itself, finds Node from fnm, volta and mise, and tells a new host from a changed one", () => {
  const LINK = "friday://computer?h=192.168.1.5&p=4390&c=ABCDEFGH&s=https&f=" + "0".repeat(64);
  const install = joinScript("", "mini", "install");
  const service = joinScript(LINK, "mini", "service");
  assert.ok(!install.includes("friday://"), "the install carries no code, so a slow one can't outlive it");
  assert.match(install, /"\$NPM" install --prefix/);
  assert.match(install, /^FRIDAY_INSTALLED|say "FRIDAY_INSTALLED"/m);
  assert.match(install, /git --version >\/dev\/null 2>&1 \|\| \{ say "FRIDAY_ERROR no-git"/);
  assert.ok(!/command -v git/.test(install), "macOS's placeholder git passes command -v");
  for (const where of [".local/share/fnm/node-versions", ".volta/bin/node", ".local/share/mise/installs/node"]) assert.ok(install.includes(where), where);
  assert.ok(service.includes(LINK) && !/"\$NPM" install/.test(service), "the service part pairs, and installs nothing");
  assert.ok(joinScript(LINK, "mini").includes("FRIDAY_INSTALLED") && joinScript(LINK, "mini").includes("FRIDAY_DONE"), "both at once still");
  const fresh = joinSshResult(255, "No ED25519 host key is known for newbox and you have requested strict checking.\r\nHost key verification failed.\r\n", "newbox");
  assert.ok(!fresh.ok && /haven't connected to newbox over SSH before/.test(fresh.error) && !/changed/.test(fresh.error), JSON.stringify(fresh));
  const changed = joinSshResult(255, "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.", "oldbox");
  assert.ok(!changed.ok && /identity has changed/.test(changed.error));
});
