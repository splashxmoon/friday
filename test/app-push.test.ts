import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

/**
 * An idle Home asks for nothing every few seconds (spec 13, Arun 2026-11-24: "Go all out and fix these problems"): what it showed
 * by asking (link offers, teammates, what needs you, computers) is read when this computer's Friday says it changed, over the
 * stream the page keeps open, and once a minute besides; never on its own while the window is hidden.
 */

// A document whose visibility the test sets.
const doc = { visibilityState: "visible", listeners: new Set<() => void>(), addEventListener(_: string, f: () => void) { this.listeners.add(f); }, removeEventListener(_: string, f: () => void) { this.listeners.delete(f); } };
(globalThis as Record<string, unknown>).document = doc;
const setVisible = (on: boolean) => ((doc.visibilityState = on ? "visible" : "hidden"), doc.listeners.forEach((f) => f()));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const { pollWhileShown, pushOpen, pushed } = await import("../src/client/app-push.js");

test("where nothing tells it, a list asks as often as it did; told, it asks then and not on its own", async () => {
  let reads = 0;
  const stop = pollWhileShown(() => reads++, { every: 40, on: ["offers"] });
  assert.equal(reads, 1, "read at once");
  await wait(130);
  assert.ok(reads >= 3, `asked on its own while nothing tells it (${reads})`);
  pushOpen(true);
  await wait(60);
  const was = reads;
  await wait(200);
  assert.ok(reads <= was + 1, `once the stream is open, at most the tick already set (${reads - was})`);
  const before = reads;
  pushed("offers");
  pushed("offers");
  pushed("sessions");
  await wait(250);
  assert.equal(reads, before + 1, "told twice at once, read once; told of something else, not at all");
  stop();
  pushed("offers");
  await wait(200);
  assert.equal(reads, before + 1, "stopped, it reads nothing");
});

test("hidden, it waits: told meanwhile, it reads as the window comes back; a list that must reach the background reads anyway", async () => {
  pushOpen(true);
  let reads = 0;
  let notices = 0;
  const stopA = pollWhileShown(() => reads++, { every: 40, on: ["sessions"], now: false });
  const stopB = pollWhileShown(() => notices++, { every: 40, on: ["sessions"], now: false, whileHidden: true });
  setVisible(false);
  pushed("sessions");
  await wait(250);
  assert.equal(reads, 0, "nothing while hidden");
  assert.equal(notices, 1, "what has to reach a hidden window still reads");
  setVisible(true);
  assert.equal(reads, 1, "read as it comes back, the change it was told of");
  stopA();
  stopB();
});

test("the stream dropped and opened again reads every list: what changed meanwhile was never told", async () => {
  pushOpen(true);
  let reads = 0;
  const stop = pollWhileShown(() => reads++, { every: 60_000, on: ["computers"], now: false });
  pushOpen(false);
  pushOpen(true);
  await wait(250);
  assert.equal(reads, 1);
  stop();
});

test("the page's stream says what changed, as `changed` events beside the backdrops it was for", async (t) => {
  const { BackdropStore, backdropsHttp } = await import("../src/backdrops.js");
  const dir = await mkdtemp(path.join(tmpdir(), "friday-push-"));
  const store = new BackdropStore({ root: path.join(dir, "backdrops"), trash: path.join(dir, "trash") });
  const tell = new Set<(what: string) => void>();
  const server = http.createServer((req, res) => void backdropsHttp(store, req, res, new URL(req.url ?? "/", "http://x"), (f) => (tell.add(f), () => void tell.delete(f))));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => (server.closeAllConnections(), server.close(), await rm(dir, { recursive: true, force: true })));
  const { port } = server.address() as { port: number };
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/local/backdrops/events`, { signal: ac.signal });
  const reader = res.body!.getReader();
  let text = "";
  const until = async (re: RegExp) => {
    while (!re.test(text)) text += new TextDecoder().decode((await reader.read()).value);
  };
  await until(/data: /);
  assert.equal(tell.size, 1, "the stream listens while it is open");
  for (const f of tell) f("sessions");
  await until(/event: changed\ndata: sessions\n\n/);
  ac.abort();
  await wait(100);
  assert.equal(tell.size, 0, "and stops as it closes");
});
