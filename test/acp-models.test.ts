// A tool spoken to over ACP that lists its models the older way: `models` beside the conversation it opened (availableModels,
// currentModelId), one taken by `session/set_model`. T3 Code and Orca read both shapes; Friday read only the `model` option, so
// such a tool's picker stayed empty and a picked model was never sent.
import assert from "node:assert/strict";
import test from "node:test";
import { ADAPTERS, modelMenu, type AdapterOut, type TurnSpec } from "../src/runner/adapters.js";

function agent(spec: Partial<TurnSpec> = {}) {
  const tool = ADAPTERS.kilo;
  const turn: TurnSpec = { prompt: "Fix the failing test", system: "", resumeId: null, mode: "edits", ask: true, ...spec };
  const sent: Record<string, any>[] = [JSON.parse(tool.stdin(turn))];
  const parse = tool.parser(turn, { cwd: "/work/repo", write: (line) => void sent.push(JSON.parse(line)), end: () => {} });
  const say = (frame: Record<string, unknown>): AdapterOut[] => parse(JSON.stringify({ jsonrpc: "2.0", ...frame }));
  const last = () => sent.at(-1)!;
  const answer = (result: Record<string, unknown>) => say({ id: last().id, result });
  const fail = (message: string) => say({ id: last().id, error: { code: -32602, message } });
  return { sent, say, last, answer, fail };
}

const older = (currentModelId = "kilo/kilo-auto/free") => ({
  currentModelId,
  availableModels: [
    { modelId: "kilo/kilo-auto/free", name: "Kilo Auto (free)" },
    { modelId: "kilo/~anthropic/claude-sonnet-latest", name: "Claude Sonnet" },
  ],
});

test("the older models list is read: offered to the picker, and a pick sent by session/set_model", () => {
  const a = agent({ model: "kilo/~anthropic/claude-sonnet-latest" });
  a.say({ id: 0, result: { protocolVersion: 1 } });
  const opened = a.answer({ sessionId: "s1", models: older() });
  assert.deepEqual(opened.find((o) => o.kind === "models"), {
    kind: "models",
    list: [
      { id: "kilo/kilo-auto/free", label: "Kilo Auto (free)" },
      { id: "kilo/~anthropic/claude-sonnet-latest", label: "Claude Sonnet" },
    ],
  });
  assert.deepEqual([a.last().method, a.last().params], ["session/set_model", { sessionId: "s1", modelId: "kilo/~anthropic/claude-sonnet-latest" }]);
  a.answer({});
  assert.equal(a.last().method, "session/prompt");
});

test("a model the tool turns down is said, and the turn goes on with its own", () => {
  const a = agent({ model: "Claude Sonnet" });
  a.say({ id: 0, result: { protocolVersion: 1 } });
  a.answer({ sessionId: "s1", models: older() });
  assert.equal(a.last().method, "session/set_model", "found by its name too");
  const out = a.fail("Model not available");
  assert.ok(out.some((o) => o.kind === "delta" && /didn't take “Claude Sonnet”, so it uses kilo\/kilo-auto\/free/.test(o.text)));
  assert.equal(a.last().method, "session/prompt");
});

test("the model it already has is not sent again, and one it doesn't list is said", () => {
  const same = agent({ model: "kilo/kilo-auto/free" });
  same.say({ id: 0, result: { protocolVersion: 1 } });
  same.answer({ sessionId: "s1", models: older() });
  assert.equal(same.last().method, "session/prompt");

  const unknown = agent({ model: "gpt-nine" });
  unknown.say({ id: 0, result: { protocolVersion: 1 } });
  const out = unknown.answer({ sessionId: "s1", models: older() });
  assert.ok(out.some((o) => o.kind === "delta" && /doesn't offer “gpt-nine”/.test(o.text)));
  assert.equal(unknown.last().method, "session/prompt");
});

test("the `model` option wins when a tool sends both", () => {
  const both = { configOptions: [{ id: "model", category: "model", type: "select", currentValue: "a", options: [{ value: "a", name: "A" }, { value: "b", name: "B" }] }], models: older() };
  assert.deepEqual(modelMenu(both), { opt: { id: "model" }, list: [{ id: "a", name: "A" }, { id: "b", name: "B" }], current: "a" });
  assert.equal(modelMenu({ models: { availableModels: [] } }), null);
  assert.equal(modelMenu({}), null);
});
