// Your phone and this computer (local/phone.ts): what it may ask, what it is asked with, where it can reach, and pairing.
import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { explicitCurve, passedHeaders, PhoneAccess, phoneAllowed, reachable, type PhoneKV } from "../src/local/phone.js";

test("the phone may ask only what the phone app needs", () => {
  for (const [m, p] of [["GET", "/api/sessions/mine"], ["POST", "/api/sessions/abc123/instruct"], ["POST", "/api/sessions/abc123/answer"], ["GET", "/api/sessions/abc123/history"], ["GET", "/api/teammates"], ["POST", "/api/teammates/away"], ["POST", "/api/runner/tools"], ["GET", "/ws"]] as const) {
    assert.ok(phoneAllowed(m, p), `${m} ${p}`);
  }
  for (const [m, p] of [["POST", "/api/runner/login"], ["POST", "/api/runner/install"], ["POST", "/api/runner/start"], ["POST", "/api/phone"], ["GET", "/api/phone"], ["POST", "/api/usage-sharing"], ["GET", "/api/preview/x"], ["POST", "/api/teammates"], ["DELETE", "/api/sessions/abc123"], ["GET", "/api/sessions/../phone"], ["GET", "/"]] as const) {
    assert.ok(!phoneAllowed(m, p), `${m} ${p}`);
  }
});

test("what is passed on carries nothing of who asked or from where", () => {
  const h = passedHeaders({ authorization: "Bearer t", cookie: "a=b", origin: "https://x", referer: "https://x/", "x-forwarded-for": "1.2.3.4", "x-friday-link": "z", "content-type": "application/json", host: "192.168.1.5:4390" }, 4321);
  assert.deepEqual(h, { "content-type": "application/json", host: "127.0.0.1:4321", "x-friday-local": "1", "x-friday-via": "phone" });
});

test("the addresses offered are this computer's network's and Tailscale's, never its own loopback or a public one", () => {
  const got = reachable({ lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as never], en0: [{ address: "192.168.1.20", family: "IPv4", internal: false } as never, { address: "fe80::1", family: "IPv6", internal: false } as never], utun4: [{ address: "100.101.5.6", family: "IPv4", internal: false } as never], en1: [{ address: "8.8.8.8", family: "IPv4", internal: false } as never] });
  assert.deepEqual(got, [{ address: "192.168.1.20", via: "wifi" }, { address: "100.101.5.6", via: "tailscale" }]);
});

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

test("a phone pairs once with the code on screen, gets a token, and is refused without it; a removed phone is refused", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "phone-"));
  // Friday itself, as far as the phone can see: one route.
  const app = http.createServer((req, res) => res.end(JSON.stringify({ path: req.url, host: req.headers.host, auth: req.headers.authorization ?? null })));
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
  const appPort = (app.address() as { port: number }).port;
  // Tailscale's, so it is offered with or without a certificate (a Windows runner may have no openssl).
  const phone = new PhoneAccess({ kv: memKV(), home, appPort, computer: "Test Mac", addresses: () => [{ address: "127.0.0.1", via: "tailscale" }] });
  try {
    const st = await phone.setOn(true);
    assert.ok(st.listening && st.port);
    const code = (await phone.pairCode()) as { code: string; link: string };
    const link = new URL(code.link);
    const port = Number(link.searchParams.get("p"));
    const call = (method: string, p: string, o: { token?: string; body?: object } = {}) =>
      new Promise<[number, string]>((resolve) => {
        const req = (link.searchParams.get("s") === "https" ? https : http).request({ host: "127.0.0.1", port, method, path: p, rejectUnauthorized: false, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) } }, (r) => {
          let b = "";
          r.on("data", (c) => (b += c));
          r.on("end", () => resolve([r.statusCode ?? 0, b]));
        });
        req.end(o.body ? JSON.stringify(o.body) : undefined);
      });
    for (let i = 0; i < 4; i++) assert.equal((await call("POST", "/phone/pair", { body: { code: "AAAAAAAA" } }))[0], 401);
    const [ok, body] = await call("POST", "/phone/pair", { body: { code: code.code.toLowerCase(), name: "Maya's iPhone" } });
    assert.equal(ok, 200, "lower case and four wrong tries before still pair");
    const { token, device } = JSON.parse(body) as { token: string; device: string };
    assert.equal((await call("POST", "/phone/pair", { body: { code: code.code } }))[0], 401, "used once");
    assert.equal((await call("GET", "/api/sessions/mine"))[0], 401);
    const [st2, passed] = await call("GET", "/api/sessions/mine", { token });
    assert.equal(st2, 200);
    assert.deepEqual(JSON.parse(passed), { path: "/api/sessions/mine", host: `127.0.0.1:${appPort}`, auth: null });
    assert.equal((await call("POST", "/api/runner/login", { token }))[0], 404);
    assert.equal((await phone.state()).devices[0]?.name, "Maya's iPhone");
    await phone.forget(device);
    assert.equal((await call("GET", "/api/sessions/mine", { token }))[0], 401, "removed in Settings: refused");
    // Five wrong codes and the one on screen is gone.
    const again = (await phone.pairCode()) as { code: string };
    for (let i = 0; i < 5; i++) await call("POST", "/phone/pair", { body: { code: "BBBBBBBB" } });
    assert.equal((await call("POST", "/phone/pair", { body: { code: again.code } }))[0], 401);
  } finally {
    await phone.stop();
    app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a phone removed, or access turned off, loses its open session socket at once; two turn-ons open one listener", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "phone-"));
  // Friday's socket, as far as the phone can see: an upgrade that stays open.
  const app = http.createServer((_q, res) => res.end("{}"));
  const appSockets = new Set<import("node:stream").Duplex>();
  // Ending its side when the other does, as Friday's own socket server (ws) does: Node keeps an upgraded socket half open otherwise.
  app.on("upgrade", (_q, sock) => (appSockets.add(sock), sock.on("end", () => sock.end()), sock.on("close", () => appSockets.delete(sock)), sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")));
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
  const appPort = (app.address() as { port: number }).port;
  const phone = new PhoneAccess({ kv: memKV(), home, appPort, computer: "Test Mac", addresses: () => [{ address: "127.0.0.1", via: "tailscale" }] });
  try {
    await Promise.all([phone.setOn(true), phone.setOn(true)]);
    const port = (await phone.state()).port!;
    const code = (await phone.pairCode()) as { code: string; link: string };
    const secure = new URL(code.link).searchParams.get("s") === "https";
    const pairOnce = () =>
      new Promise<{ token: string; device: string }>((resolve) => {
        const req = (secure ? https : http).request({ host: "127.0.0.1", port, method: "POST", path: "/phone/pair", rejectUnauthorized: false, headers: { "content-type": "application/json" } }, (r) => {
          let b = "";
          r.on("data", (c) => (b += c));
          r.on("end", () => resolve(JSON.parse(b)));
        });
        req.end(JSON.stringify({ code: code.code }));
      });
    const { token, device } = await pairOnce();
    const openSocket = () =>
      new Promise<import("node:net").Socket>((resolve, reject) => {
        const req = (secure ? https : http).request({ host: "127.0.0.1", port, path: "/ws?session=x", rejectUnauthorized: false, headers: { connection: "Upgrade", upgrade: "websocket", authorization: `Bearer ${token}` } });
        req.on("upgrade", (_r, sock) => resolve(sock));
        req.on("response", (r) => reject(new Error(`refused ${r.statusCode}`)));
        req.end();
      });
    const closed = (sock: import("node:net").Socket) => new Promise<boolean>((resolve) => (sock.on("close", () => resolve(true)), setTimeout(() => resolve(false), 2000)));
    const first = await openSocket();
    const gone = closed(first);
    await phone.forget(device);
    assert.equal(await gone, true, "removed: its socket closed");
    for (let i = 0; i < 20 && appSockets.size; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(appSockets.size, 0, "and the listener's socket to Friday with it");
  } finally {
    await phone.stop();
    for (const sk of appSockets) sk.destroy();
    app.close();
    await rm(home, { recursive: true, force: true });
  }
});

// macOS's own openssl spelled the curve's parameters out unless told otherwise, and the iPhone's TLS refuses such a key: one
// made that way is found and made again (the first was; the second is how they are made now).
const SPELLED_OUT = `-----BEGIN CERTIFICATE-----
MIICJzCCAc4CCQD0F43zTg3LoTAKBggqhkjOPQQDAjAiMSAwHgYDVQQDDBdGcmlk
YXkgb24gdGhpcyBjb21wdXRlcjAeFw0yNjEwMzAxNjMzMjZaFw0zNjEwMjcxNjMz
MjZaMCIxIDAeBgNVBAMMF0ZyaWRheSBvbiB0aGlzIGNvbXB1dGVyMIIBSzCCAQMG
ByqGSM49AgEwgfcCAQEwLAYHKoZIzj0BAQIhAP////8AAAABAAAAAAAAAAAAAAAA
////////////////MFsEIP////8AAAABAAAAAAAAAAAAAAAA///////////////8
BCBaxjXYqjqT57PrvVV2mIa8ZR0GsMxTsPY7zjw+J9JgSwMVAMSdNgiG5wSTamZ4
4ROdJreBn36QBEEEaxfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpZP40Li
/hp/m47n60p8D54WK84zV2sxXs7LtkBoN79R9QIhAP////8AAAAA//////////+8
5vqtpxeehPO5ysL8YyVRAgEBA0IABKKnDExn8jfpzd+2IDA5U4jtvAjbgdDltokQ
xcPAs16i0F8Mi+FEy/TIXtGvsLes+yD7B9qhCNzwXslQbn4pb5wwCgYIKoZIzj0E
AwIDRwAwRAIgZx4tmT8eYvLXuhUaCmpVIOiVsQhR1o32BKJIDT8lY/UCIDJBNoef
/k9NbMD3LPtyNBq3EjLTe00UbkuCLG35YkAf
-----END CERTIFICATE-----`;
const NAMED = `-----BEGIN CERTIFICATE-----
MIIBMzCB2gIJAKA1+1AzF3s+MAoGCCqGSM49BAMCMCIxIDAeBgNVBAMMF0ZyaWRh
eSBvbiB0aGlzIGNvbXB1dGVyMB4XDTI2MTAzMDE3MzMyMVoXDTM2MTAyNzE3MzMy
MVowIjEgMB4GA1UEAwwXRnJpZGF5IG9uIHRoaXMgY29tcHV0ZXIwWTATBgcqhkjO
PQIBBggqhkjOPQMBBwNCAASoCVVQkox3J02H2uqdyKzzTsHV/I/Yo83JXcLaNRAh
DSF7Qc8kyOyDPQ+20wIG+R2pv89Lq1sWi5y0FL8zM+HjMAoGCCqGSM49BAMCA0gA
MEUCIQCW8ezMD2OTdWyg4Ld3BNRXKh16ul9oNEvAuw/1hs46pwIgRdr1DiBTUvT7
VAYIIFx9tY0IMRo+k7qBPWJsA98euwQ=
-----END CERTIFICATE-----`;

test("a certificate whose curve is spelled out, which no iPhone accepts, is found to be made again", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-cert-"));
  try {
    await writeFile(path.join(dir, "old.pem"), SPELLED_OUT);
    await writeFile(path.join(dir, "new.pem"), NAMED);
    assert.equal(explicitCurve(path.join(dir, "old.pem")), true);
    assert.equal(explicitCurve(path.join(dir, "new.pem")), false);
    assert.equal(explicitCurve(path.join(dir, "missing.pem")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
