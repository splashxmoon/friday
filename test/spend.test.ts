import assert from "node:assert/strict";
import test from "node:test";
import { plainModel, priceFor, spendOf, turnTokens, usdOf } from "../src/spend.js";
import type { SessionEvent } from "../src/types.js";

/** Every token a crew mate or a room used, by kind, model, day and run, at list price (spend.ts). */
const human = { id: "p", name: "Ada", kind: "human" as const };
const bot = { id: "engine:local", name: "Sage", kind: "agent" as const };
let seq = 0;
const ev = (body: SessionEvent["body"], lane: string, ts: number, actor: SessionEvent["actor"] = bot): SessionEvent => ({ seq: ++seq, ts, actor, body, lane });

test("a model id is read plainly and priced at its list price, each kind at its own rate", () => {
  assert.equal(plainModel("claude-opus-4-8-20251101"), "claude-opus-4-8");
  assert.equal(plainModel("anthropic/claude-sonnet-4-6[1m]"), "claude-sonnet-4-6");
  const p = priceFor("claude", "claude-sonnet-4-6-20251001")!;
  assert.deepEqual(p, { in: 3, out: 15, read: 0.3, write: 3.75 });
  assert.equal(priceFor("codex", "gpt-5-codex")!.read, 0.125);
  assert.equal(priceFor("codex", "some-new-model"), null, "no made-up price");
  assert.equal(priceFor("claude", undefined), null);
  const t = turnTokens({ input: 1_000_000, cached: 2_000_000, output: 100_000, cacheWrite: 400_000, reasoning: 30_000 });
  assert.deepEqual(t, { input: 600_000, cacheWrite: 400_000, cacheRead: 2_000_000, output: 100_000, reasoning: 30_000 });
  assert.equal(Math.round(usdOf(t, p) * 100) / 100, 1.8 + 1.5 + 0.6 + 1.5);
});

test("spend split by model, day, lane and run, who started each, unpriced tokens kept apart", () => {
  const now = Date.UTC(2026, 10, 15, 12);
  const asked = ev({ type: "instruction", text: "Research seat pricing\nin detail", interrupt: false, attachments: [] }, "L1", now - 3000, human);
  const events = [
    asked,
    ev({ type: "run.started", causedBy: asked.seq }, "L1", now - 2000),
    ev({ type: "agent.usage", tool: "claude", input: 1000, cached: 9000, output: 500, cacheWrite: 200, model: "claude-sonnet-4-6" }, "L1", now - 1000),
    ev({ type: "run.ended", outcome: "done" }, "L1", now - 500),
    ev({ type: "run.started", causedBy: 99_999 }, "L2", now - 400),
    ev({ type: "agent.usage", tool: "codex", input: 300, cached: 0, output: 100 }, "L2", now - 300),
    ev({ type: "agent.usage", tool: "claude", input: 999, cached: 0, output: 999, model: "claude-sonnet-4-6" }, "L3", now - 200),
  ];
  const s = spendOf([{ sid: "s1", lanes: ["L1", "L2"], events, engines: { L2: { tool: "codex", model: "mystery" } } }], now - 86_400_000, "UTC");
  assert.deepEqual(s.tokens, { input: 1100, cacheWrite: 200, cacheRead: 9000, output: 600, reasoning: 0 }, "L3 is not one of its lanes");
  assert.equal(s.turns, 2);
  assert.equal(s.unpriced, 400, "the codex turn on a model with no list price");
  assert.equal(s.byModel.length, 2);
  assert.equal(s.byDay.length, 1);
  assert.equal(s.runs.length, 2);
  const r = s.runs.find((x) => x.lane === "L1")!;
  assert.equal(r.ask, "Research seat pricing");
  assert.deepEqual(r.by, { kind: "asked", label: "Ada asked" });
  assert.ok(r.usd! > 0 && r.endedAt === now - 500);
  assert.deepEqual(s.runs.find((x) => x.lane === "L2")!.by, { kind: "friday", label: "Friday started it" }, "nobody asked: Friday started it");
});
