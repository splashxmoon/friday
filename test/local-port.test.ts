import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { freePort } from "../src/local/start.js";

/**
 * The port the local Friday listens on (start.ts freePort). Its default, 4321, is also Astro's dev server's, which listens on
 * "localhost": ::1 on a Mac. Binding 127.0.0.1 there still works, so Friday took the same port, and its previews at
 * http://localhost:4321 went to the other server.
 */
async function holder(host: string): Promise<{ port: number; close: () => Promise<void> }> {
  const s = net.createServer((c) => c.end());
  await new Promise<void>((resolve, reject) => (s.once("error", reject), s.listen(0, host, resolve)));
  return { port: (s.address() as net.AddressInfo).port, close: () => new Promise((r) => s.close(() => r())) };
}

const ipv6 = await holder("::1").then(
  (h) => (void h.close(), true),
  () => false,
);

for (const host of ["::1", "0.0.0.0", "::"]) {
  test(`a port another server listens on at ${host} is not handed out`, { skip: host.includes(":") && !ipv6 }, async () => {
    const other = await holder(host);
    try {
      const got = await freePort(other.port);
      assert.notEqual(got, other.port);
      assert.ok(got > 0);
    } finally {
      await other.close();
    }
  });
}

test("a free port asked for is the one given", async () => {
  const h = await holder("127.0.0.1");
  await h.close();
  assert.equal(await freePort(h.port), h.port);
});
