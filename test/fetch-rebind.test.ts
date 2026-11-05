import assert from "node:assert/strict";
import dns from "node:dns";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fetchUrl, publicFetch } from "../src/agent/fetch-url.js";

/**
 * DNS rebinding: a name that answers a public address when it is checked and a private one when the connection is made. The
 * check and the connection each looked the name up, so a name with a short TTL got Friday's server to request its own private
 * network (Redis, cloud metadata) anyway. The connection now uses the one lookup it checks.
 *
 * Here the lookup the old check made (dns.promises) says public, and the one a connection makes (dns.lookup) says this
 * computer, where a server is listening: anything it serves is a request that should never have been made.
 */
let server: http.Server;
let port = 0;
let hits = 0;
const realLookup = dns.lookup;
const realPromise = dns.promises.lookup;

before(async () => {
  server = http.createServer((_req, res) => (hits++, res.writeHead(200, { "content-type": "text/plain" }), res.end("INTERNAL SECRET")));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
  const rebinds = (host: string) => host === "rebind.example";
  dns.promises.lookup = (async (host: string, opts?: unknown) => (rebinds(host) ? [{ address: "93.184.216.34", family: 4 }] : realPromise(host, opts as never))) as typeof dns.promises.lookup;
  dns.lookup = ((host: string, opts: unknown, cb?: unknown) => {
    const done = (typeof opts === "function" ? opts : cb) as (e: Error | null, a: unknown, f?: number) => void;
    const o = (typeof opts === "object" && opts) || {};
    if (!rebinds(host)) return (realLookup as (...a: unknown[]) => void)(host, opts, cb);
    return (o as { all?: boolean }).all ? done(null, [{ address: "127.0.0.1", family: 4 }]) : done(null, "127.0.0.1", 4);
  }) as typeof dns.lookup;
  // So `import { lookup } from "node:dns/promises"` and friends see these too.
  syncBuiltinESMExports();
});
after(() => {
  dns.lookup = realLookup;
  dns.promises.lookup = realPromise;
  syncBuiltinESMExports();
  server.close();
});

test("a name that rebinds to a private address between the check and the connection is never requested", async () => {
  const url = `http://rebind.example:${port}/`;
  const read = await fetchUrl(url, AbortSignal.timeout(5000));
  assert.doesNotMatch(read, /INTERNAL SECRET/);
  await assert.rejects(async () => {
    const r = await publicFetch(url);
    assert.doesNotMatch(await r.text(), /INTERNAL SECRET/);
  });
  assert.equal(hits, 0, "the private server was requested");
});
