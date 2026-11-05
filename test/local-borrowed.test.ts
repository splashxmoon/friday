import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { watchBorrowed } from "../src/local/borrowed.js";

/**
 * The open-source app opened on a Friday it didn't start (the terminal edition's, on the same folder: start.ts `already`). When
 * that one stopped, the window was left on an address nothing answered. The app now hears it go and starts its own.
 */
async function friday(): Promise<{ url: string; close: () => Promise<void> }> {
  const s = http.createServer((req, res) => (req.url === "/api/info" ? res.end("{}") : (res.statusCode = 404, res.end())));
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => new Promise((r) => (s.closeAllConnections(), s.close(() => r()))) };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a borrowed Friday that stops answering is said gone, once", async () => {
  const f = await friday();
  let gone = 0;
  const stop = watchBorrowed(f.url, () => gone++, { everyMs: 50 });
  await wait(300);
  assert.equal(gone, 0, "said gone while it answered");
  await f.close();
  for (let i = 0; i < 40 && !gone; i++) await wait(50);
  assert.equal(gone, 1);
  await wait(300);
  assert.equal(gone, 1, "said gone more than once");
  stop();
});

test("one missed answer isn't enough, and a stopped watch says nothing", async () => {
  let ok = false;
  const s = http.createServer((_req, res) => ((res.statusCode = ok ? 200 : 503), res.end()));
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  let gone = 0;
  const stop = watchBorrowed(url, () => gone++, { everyMs: 100 });
  await wait(130); // one 503
  ok = true;
  await wait(400);
  assert.equal(gone, 0);
  stop();
  ok = false;
  await wait(400);
  assert.equal(gone, 0);
  await new Promise((r) => s.close(r));
});

test("a Friday already running on the folder is handed over with its process, so the app can wait for it to be gone", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { startLocal } = await import("../src/local/start.js");
  const home = await mkdtemp(path.join(tmpdir(), "friday-borrowed-"));
  const first = await startLocal({ home, port: 0 });
  t.after(async () => {
    await first.close();
    await rm(home, { recursive: true, force: true });
  });
  const second = await startLocal({ home, port: 0 });
  assert.equal(second.already, true);
  assert.equal(second.url, first.url);
  assert.equal(second.pid, process.pid);
});
