// The open-source app's anonymous usage counts (usage.ts): nothing before the notice, nothing when turned off, and only plain
// counts and words when on.
import test from "node:test";
import assert from "node:assert/strict";
import { clean, offByEnv, usageCounts, USAGE_HOST } from "../src/usage.js";

function rig(env: NodeJS.ProcessEnv = {}, tools = [{ tool: "claude", ready: true }, { tool: "codex", ready: false }]) {
  const kept = new Map<string, string>();
  const sent: { api_key: string; batch: { event: string; distinct_id: string; properties: Record<string, unknown> }[] }[] = [];
  let day = "2026-10-30T09:00:00Z";
  const u = usageCounts({
    store: { hget: async (_k, f) => kept.get(f) ?? null, hset: async (_k, f, v) => void kept.set(f, v) },
    key: "friday:usage",
    version: async () => "0.2.1",
    tools: async () => tools,
    desktop: true,
    env,
    send: async (b) => void sent.push(JSON.parse(b)),
    now: () => new Date(day),
  });
  return { u, sent, kept, next: (d: string) => (day = d) };
}

test("usage counts: nothing is sent until the notice has been shown, and then once a day with the tools found", async () => {
  const { u, sent, next } = rig();
  await u.tick();
  await u.sessionStarted("code");
  await u.once("first_turn");
  assert.equal(sent.length, 0, "not told yet: nothing");
  await u.set({ told: true });
  await u.tick();
  const events = sent.map((b) => b.batch[0]!.event);
  assert.deepEqual(events, ["tool_ready", "app_active"]);
  const active = sent[1]!.batch[0]!;
  assert.equal(active.properties.tools, "claude,codex");
  assert.equal(active.properties.tools_ready, 1);
  assert.equal(active.properties.version, "0.2.1");
  assert.equal(active.properties.app, "desktop");
  assert.equal(active.properties.$process_person_profile, false);
  assert.equal(active.properties.$geoip_disable, true);
  await u.tick();
  assert.equal(sent.length, 2, "the same day: no second active, no second tool_ready");
  next("2026-10-31T09:00:00Z");
  await u.tick();
  assert.equal(sent.length, 3, "the next day counts again");
  await u.sessionStarted("work");
  await u.once("first_turn");
  await u.once("first_turn");
  assert.deepEqual(sent.slice(3).map((b) => [b.batch[0]!.event, b.batch[0]!.properties.kind]), [["session_started", "work"], ["first_turn", undefined]]);
  assert.equal(new Set(sent.map((b) => b.batch[0]!.distinct_id)).size, 1, "one random id for the install");
  assert.match(sent[0]!.batch[0]!.distinct_id, /^[0-9a-f-]{36}$/);
  assert.ok(USAGE_HOST.startsWith("https://"));
});

test("usage counts: turned off in Settings, by FRIDAY_NO_TELEMETRY or by DO_NOT_TRACK, nothing goes", async () => {
  const off = rig();
  await off.u.set({ told: true, on: false });
  await off.u.tick();
  await off.u.sessionStarted("crew");
  assert.equal(off.sent.length, 0);
  for (const env of [{ FRIDAY_NO_TELEMETRY: "1" }, { DO_NOT_TRACK: "1" }, { DO_NOT_TRACK: "true" }]) {
    const r = rig(env);
    await r.u.set({ told: true });
    await r.u.tick();
    await r.u.sessionStarted("code");
    assert.equal(r.sent.length, 0, JSON.stringify(env));
    assert.notEqual((await r.u.state()).offBy, null);
  }
  assert.equal(offByEnv({ DO_NOT_TRACK: "0" }), null, "0 means tracking is allowed");
});

test("usage counts: only the listed properties, each with the values it may hold, can leave", () => {
  assert.deepEqual(
    clean({ version: "0.2.1", os: "macos", arch: "arm64", app: "desktop", kind: "work", tools: "claude,codex", tools_found: 2, tools_ready: 1 }),
    { version: "0.2.1", os: "macos", arch: "arm64", app: "desktop", kind: "work", tools: "claude,codex", tools_found: 2, tools_ready: 1 },
  );
  // Not listed, or not fitting: a folder, a prompt, a host name, a tool that isn't one, a count that isn't.
  assert.deepEqual(clean({ path: "/Users/maya/code", prompt: "fix it", host: "mayas-mbp", n: 3, ok: true }), {});
  assert.deepEqual(clean({ tools: "claude,mayas-mbp", kind: "secret", version: "0.2.1 /Users/maya", tools_found: 1.5, os: "MacIntel" }), {});
  assert.deepEqual(clean({ tools: "none", version: "0.2.1-mine.202610300015" }), { tools: "none", version: "0.2.1-mine.202610300015" });
});

test("usage counts: a send that fails is dropped quietly", async () => {
  const kept = new Map<string, string>([["told", "1"]]);
  const u = usageCounts({ store: { hget: async (_k, f) => kept.get(f) ?? null, hset: async (_k, f, v) => void kept.set(f, v) }, key: "k", version: async () => "1", tools: async () => [], desktop: false, env: {}, send: async () => Promise.reject(new Error("offline")) });
  await u.tick();
  await u.sessionStarted("code");
});
