// Every call to Friday ends (api.ts, spec 13): a read waits 20 s, a write 2 minutes, a call to a computer by the server's own
// limit; a read that couldn't reach the server is asked once more; a write never twice; a caller's own signal is kept.
import assert from "node:assert/strict";
import test from "node:test";
import { api, ApiTimeout, timeoutText, waitFor } from "../src/client/api.js";
import { crashLoop, homeUrl } from "../src/client/crash.js";

const me = { id: "u", name: "U" } as Parameters<typeof api>[0];
type Call = { path: string; init: RequestInit };

/** fetch, as this test says it answers; every call kept. */
function fake(answer: (c: Call, n: number) => Promise<Response>) {
  const calls: Call[] = [];
  const was = globalThis.fetch;
  globalThis.fetch = ((path: string, init: RequestInit) => {
    calls.push({ path, init });
    return answer({ path, init }, calls.length);
  }) as typeof fetch;
  return { calls, done: () => void (globalThis.fetch = was) };
}

/** A fetch that never answers, until its signal gives up on it. */
const never = (c: Call) =>
  new Promise<Response>((_, no) => c.init.signal?.addEventListener("abort", () => no(new DOMException("aborted", "AbortError"))));

test("how long each kind of call waits", () => {
  assert.equal(waitFor("/api/sessions/mine"), 20_000);
  assert.equal(waitFor("/api/runner/git.status"), 35_000);
  assert.equal(waitFor("/api/sessions/x/delete", "POST"), 120_000);
  assert.equal(waitFor("/api/runner/clone", "POST"), 0);
  assert.equal(timeoutText(20_000, true), "Friday didn't answer in 20 s. Try again in a moment.");
  assert.equal(timeoutText(120_000, false), "Friday didn't answer in 2 minutes. It may still finish, so check before trying again.");
});

test("a read that gets no answer ends with a plain error, once", async () => {
  const f = fake(never);
  try {
    await assert.rejects(api(me, "/api/sessions/mine", { timeout: 30 }), (e: Error) => e instanceof ApiTimeout && e.name === "Timeout" && e.message === "Friday didn't answer in 0 s. Try again in a moment.");
    assert.equal(f.calls.length, 1, "a timeout isn't asked again");
  } finally {
    f.done();
  }
});

test("a body that stops coming is timed too", async () => {
  const f = fake(async (c) => ({ ok: true, status: 200, json: () => never(c) }) as unknown as Response);
  try {
    await assert.rejects(api(me, "/api/x", { timeout: 30 }), ApiTimeout);
  } finally {
    f.done();
  }
});

test("a read that couldn't reach the server is asked once more; a write is not", async () => {
  const f = fake(async (_c, n) => (n === 1 ? Promise.reject(new TypeError("Failed to fetch")) : new Response(JSON.stringify({ ok: 1 }), { status: 200 })));
  try {
    assert.deepEqual(await api(me, "/api/sessions/mine"), { ok: 1 });
    assert.equal(f.calls.length, 2);
  } finally {
    f.done();
  }
  const w = fake(async () => Promise.reject(new TypeError("Failed to fetch")));
  try {
    await assert.rejects(api(me, "/api/sessions/x/delete", { method: "POST", body: "{}" }), (e: Error) => e instanceof TypeError && /Couldn't reach Friday/.test(e.message));
    assert.equal(w.calls.length, 1, "a write that may have landed is never sent twice");
  } finally {
    w.done();
  }
  const twice = fake(async () => Promise.reject(new TypeError("Failed to fetch")));
  try {
    await assert.rejects(api(me, "/api/sessions/mine"), /Couldn't reach Friday/);
    assert.equal(twice.calls.length, 2);
  } finally {
    twice.done();
  }
});

test("a caller's own signal is kept, with no wait of ours over it; the server's words still win", async () => {
  const mine = new AbortController();
  const f = fake(async (c) => {
    assert.equal(c.init.signal, mine.signal);
    return new Response(JSON.stringify({ error: "That isn't yours." }), { status: 403 });
  });
  try {
    await assert.rejects(api(me, "/api/vscode/asks?wait=1", { signal: mine.signal }), /That isn't yours\./);
  } finally {
    f.done();
  }
});

test("the crash screen calls it a loop only straight after a reload", () => {
  const now = 1_000_000;
  assert.equal(crashLoop({ sinceLoad: 2000, reloadedAt: now - 3000, reloadNav: true, now }), true);
  assert.equal(crashLoop({ sinceLoad: 2000, reloadedAt: null, reloadNav: true, now }), true, "the window's own reload counts");
  assert.equal(crashLoop({ sinceLoad: 2000, reloadedAt: null, reloadNav: false, now }), false, "a first open is not a loop");
  assert.equal(crashLoop({ sinceLoad: 60_000, reloadedAt: now - 61_000, reloadNav: true, now }), false, "a minute in is not a loop");
  assert.equal(crashLoop({ sinceLoad: 2000, reloadedAt: now - 600_000, reloadNav: false, now }), false, "an old Reload doesn't count");
  assert.equal(homeUrl("http://127.0.0.1:4545"), "http://127.0.0.1:4545/");
});
