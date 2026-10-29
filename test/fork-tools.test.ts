// A fork carries on with the source session's coding tools, in its folders (2026-10-27 QA: in the open-source edition a fork came
// up on Friday Code with no model, and every message in it queued for good).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp, forkKind, forkTools } from "../src/app.js";
import { localKV } from "../src/local/kv.js";
import { NO_MODELS } from "../src/local/no-models.js";
import type { SessionState } from "../src/session/projection.js";

// No computer here to start a tool on: the fork says so rather than starting a real one.
process.env.FRIDAY_LOCAL_RUNNER = "0";

test("a fork's tools: each lane's, the main lane's first, in the folder it was given and at its mode", () => {
  const engine = (tool: string, cwd: string, mode: string, copyOf?: string) => ({ tool, cwd, mode, hostId: "u", hostName: "U", online: true, sinceSeq: 1, ...(copyOf ? { copyOf } : {}) });
  const state = (engines: Record<string, unknown>, lanes: { id: string; name: string }[] = []) => ({ engines, lanes, options: {} }) as unknown as SessionState;
  assert.deepEqual(
    forkTools(state({ main: engine("claude", "/w/app-copy", "edits", "/w/app"), l2: engine("codex", "/w/api", "full") }, [{ id: "l2", name: "Codex" }]), true),
    [
      { tool: "claude", cwd: "/w/app", mode: "edits" },
      { lane: "Codex", tool: "codex", cwd: "/w/api", mode: "full" },
    ],
  );
  assert.deepEqual(forkTools(state({ l2: engine("codex", "/w/api", "full") }, [{ id: "l2", name: "Codex" }]), true), [{ tool: "codex", cwd: "/w/api", mode: "full" }], "the only tool takes the main lane");
  assert.match(forkTools(state({}), true) as string, /no coding tool to carry on/, "nothing to carry on here");
  assert.deepEqual(forkTools(state({}), false), [], "Friday's own agent carries it where there is one");
});

test("forking where the tool can't start says why, and makes no fork nobody can work in", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-fork-"));
  const kv = await localKV(home);
  const app = await createApp({ port: 0, redisUrl: "", prefix: "friday:", secret: "s", driverGraceMs: 15_000, llm: NO_MODELS, dataDir: path.join(home, "uploads"), local: { redis: kv.redis, sub: kv.sub, user: { id: "local", name: "Me" } } });
  t.after(async () => (await app.close(), await kv.close(), await rm(home, { recursive: true, force: true })));
  const post = (p: string, body?: unknown) => fetch(`${app.url}${p}`, { method: "POST", headers: { "Content-Type": "application/json", "x-friday-local": "1" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const made = (await (await post("/api/sessions", { title: "Checkout" })).json()) as { sessionId: string; invites: { owner: string } };
  const fork = () => post(`/api/sessions/${made.sessionId}/fork?invite=${encodeURIComponent(made.invites.owner)}`);
  const before = (await app.store.mine("local")).length;

  const none = await fork();
  assert.equal(none.status, 409);
  assert.match(((await none.json()) as { error: string }).error, /no coding tool/);

  await app.store.append(made.sessionId, { id: "local", name: "Me", kind: "human" }, { type: "engine.attached", engine: { tool: "claude", cwd: home, hostId: "local", hostName: "Me", mode: "edits" } });
  const away = await fork();
  assert.equal(away.status, 409);
  assert.match(((await away.json()) as { error: string }).error, /Claude Code runs on your computer, which isn't connected/);
  assert.equal((await app.store.mine("local")).length, before, "no fork made");
});

test("a fork is the kind of session it came from: a Code fork is Code, and only the open-source edition makes a Work one", () => {
  const of = (options: Record<string, unknown>, lead?: string) => ({ options, ...(lead ? { lead } : {}) }) as unknown as SessionState;
  assert.deepEqual(forkKind(of({}), true), { options: { webSearch: false, controlMode: "ask", mcp: true, model: "", agent: null }, lead: false, copy: true });
  assert.equal(forkKind(of({ work: true }, "main"), false).options.work, undefined, "nowhere else is a fork Work");
  // Arun, 2026-10-28: "iron everything and ensure we are good… any logic errors and fixes".
  const work = forkKind(of({ work: true, webSearch: true }, "main"), true);
  assert.equal(work.options.work, true, "a Work session's fork is Work");
  assert.equal(work.options.webSearch, true);
  assert.equal(work.lead, true, "its agents lead as they did");
  assert.equal(work.copy, false, "in the same folder: Work's agents never work in copies");
  assert.equal(forkKind(of({ team: true }), true).options.team, undefined, "a Crew room's fork is a session of its own");
});
