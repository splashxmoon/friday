// Automations in the open-source edition (Arun, 2026-10-26: "get rid of the profile button ... and instead add automations"):
// your coding tools working on their own, on a schedule, a webhook or another session's end, on this computer. Friday's own
// agent isn't one of them here, and saying so is the run's whole outcome rather than a session that never moves.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startLocal } from "../src/local/start.js";

test("on this computer, automations are made, listed, changed and removed, and one for Friday's own agent says it can't run", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-autos-"));
  const friday = await startLocal({ home, port: 0 });
  t.after(async () => {
    await friday.close();
    await rm(home, { recursive: true, force: true });
  });
  const call = async <T,>(p: string, method = "GET", json?: unknown): Promise<T> => {
    const r = await fetch(`${friday.url}${p}`, { method, headers: { "Content-Type": "application/json", "x-friday-local": "1" }, ...(json === undefined ? {} : { body: JSON.stringify(json) }) });
    const text = await r.text();
    assert.ok(r.ok, `${method} ${p}: ${r.status} ${text}`);
    return JSON.parse(text) as T;
  };
  type View = { id: string; name: string; mine: boolean; says: { when: string; who: string }; when: { kind: string; url?: string } };

  const { automation: nightly } = await call<{ automation: View }>("/api/automations", "POST", {
    name: "Nightly tests",
    does: "Run the tests and fix what fails.",
    when: { kind: "schedule", schedule: { every: "daily", at: "02:00", days: [], tz: "UTC" } },
    who: { tool: "codex", team: ["claude"] },
    folder: home,
  });
  assert.ok(nightly.mine);
  assert.equal(nightly.says.who, "Codex leading Claude Code");
  assert.match(nightly.says.when, /02:00/);

  const { automation: hook } = await call<{ automation: View }>("/api/automations", "POST", { name: "On deploy", when: { kind: "webhook" }, who: { tool: "claude" } });
  assert.match(hook.when.url ?? "", new RegExp(`^${friday.url.replace(/[.]/g, "\\.")}/api/hooks/automation/.+\\?key=`), "its webhook is this computer's own address");

  assert.deepEqual((await call<{ automations: View[] }>("/api/automations")).automations.map((a) => a.name).sort(), ["Nightly tests", "On deploy"]);
  assert.equal((await call<{ automation: View }>(`/api/automations/${nightly.id}`, "PATCH", { name: "Nightly checks" })).automation.name, "Nightly checks");
  await call(`/api/automations/${hook.id}`, "DELETE");
  assert.deepEqual((await call<{ automations: View[] }>("/api/automations")).automations.map((a) => a.name), ["Nightly checks"]);

  const { automation: cloud } = await call<{ automation: View }>("/api/automations", "POST", { name: "Friday", who: { tool: "friday" } });
  const { run } = await call<{ run: { status: string; note?: string } }>(`/api/automations/${cloud.id}/run`, "POST", {});
  assert.equal(run.status, "failed");
  assert.match(run.note ?? "", /coding tools/);
});

test("on this computer, an automation's run is marked done when its session's run ends, and \"an agent finishes\" starts the one watching (2026-10-27 QA)", async (t) => {
  // No computer to start a tool on: a run that starts waits for one, rather than starting a real coding tool here.
  process.env.FRIDAY_LOCAL_RUNNER = "0";
  const { createApp } = await import("../src/app.js");
  const { localKV } = await import("../src/local/kv.js");
  const { NO_MODELS } = await import("../src/local/no-models.js");
  const home = await mkdtemp(path.join(tmpdir(), "friday-autos-end-"));
  const kv = await localKV(home);
  const app = await createApp({ port: 0, redisUrl: "", prefix: "friday:", secret: "s", driverGraceMs: 15_000, llm: NO_MODELS, dataDir: path.join(home, "uploads"), local: { redis: kv.redis, sub: kv.sub, user: { id: "local", name: "Me" } } });
  t.after(async () => (await app.close(), await kv.close(), await rm(home, { recursive: true, force: true })));
  const call = async <T,>(p: string, method = "GET", json?: unknown): Promise<T> => {
    const r = await fetch(`${app.url}${p}`, { method, headers: { "Content-Type": "application/json", "x-friday-local": "1" }, ...(json === undefined ? {} : { body: JSON.stringify(json) }) });
    const text = await r.text();
    assert.ok(r.ok, `${method} ${p}: ${r.status} ${text}`);
    return JSON.parse(text) as T;
  };
  type Run = { id: string; status: string };
  const { sessionId } = await call<{ sessionId: string }>("/api/sessions", "POST", { title: "Nightly run" });
  const { automation: nightly } = await call<{ automation: { id: string } }>("/api/automations", "POST", { name: "Nightly tests", does: "Run the tests.", who: { tool: "codex" } });
  // The session is that automation's run, as running it makes one.
  await kv.redis.lpush(`friday:automation-runs:local:${nightly.id}`, JSON.stringify({ id: "r1", at: Date.now(), trigger: "Run now", status: "running", sid: sessionId }));
  await kv.redis.set(`friday:automation-run:${sessionId}`, JSON.stringify({ ws: "local", id: nightly.id, run: "r1" }));
  const { automation: after } = await call<{ automation: { id: string } }>("/api/automations", "POST", { name: "Then review", does: "Review what it did.", when: { kind: "session", sessionId, on: "finished" }, who: { tool: "claude" } });

  await app.store.append(sessionId, { id: "agent", name: "Codex", kind: "agent" }, { type: "run.ended", outcome: "done" });
  const until = async (p: () => Promise<boolean>) => {
    for (let i = 0; i < 200 && !(await p()); i++) await new Promise((r) => setTimeout(r, 10));
  };
  await until(async () => (await call<{ runs: Run[] }>(`/api/automations/${nightly.id}/runs`)).runs[0]?.status === "done");
  assert.equal((await call<{ runs: Run[] }>(`/api/automations/${nightly.id}/runs`)).runs[0]?.status, "done", "Done, not Running for good");
  await until(async () => (await call<{ runs: Run[] }>(`/api/automations/${after.id}/runs`)).runs.length > 0);
  assert.equal((await call<{ runs: Run[] }>(`/api/automations/${after.id}/runs`)).runs.length, 1, "the one watching for an agent to finish started");
});
