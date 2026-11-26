// Synthetic ACP contract exchanges for Goose's profile. These are not live recordings.
import assert from "node:assert/strict";
import test from "node:test";
import { ADAPTERS, loginStatus, type AdapterOut, type TurnSpec } from "../src/runner/adapters.js";

const goose = ADAPTERS.goose;

function agent(spec: Partial<TurnSpec> = {}) {
  const turn: TurnSpec = { prompt: "Check the tests", system: "Standing note", resumeId: null, mode: "edits", ask: true, ...spec };
  const sent: Record<string, any>[] = [JSON.parse(goose.stdin(turn))];
  let ended = false;
  const parse = goose.parser(turn, { cwd: "/work/repo", write: (line) => void sent.push(JSON.parse(line)), end: () => void (ended = true) });
  const say = (frame: Record<string, unknown>) => parse(JSON.stringify({ jsonrpc: "2.0", ...frame }));
  const last = () => sent.at(-1)!;
  const answer = (result: Record<string, unknown>) => say({ id: last().id, result });
  const update = (u: Record<string, unknown>) => say({ method: "session/update", params: { sessionId: "s1", update: u } });
  return { turn, sent, parse, say, answer, update, last, ended: () => ended };
}

test("Goose uses ACP, streams a command and its result, then ends the turn", () => {
  const a = agent();
  assert.deepEqual(goose.bins, ["goose"]);
  assert.deepEqual(goose.args(a.turn), ["acp"]);
  assert.deepEqual(goose.login, []);
  assert.deepEqual(goose.logout, []);
  assert.equal(a.last().method, "initialize");
  a.say({ id: 0, result: { protocolVersion: 1 } });
  assert.equal(a.last().method, "session/new");
  assert.deepEqual(a.last().params, { cwd: "/work/repo", mcpServers: [] });
  a.answer({ sessionId: "s1" });
  assert.equal(a.last().method, "session/prompt");
  assert.match(a.last().params.prompt[0].text, /^Standing note[\s\S]*Check the tests$/);
  const promptId = a.last().id;
  assert.deepEqual(a.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Checking." } }), [{ kind: "delta", channel: "text", text: "Checking." }]);
  const call = a.update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "npm test", kind: "execute", rawInput: { command: "npm test" } })[0] as Extract<AdapterOut, { kind: "message" }>;
  assert.equal(call.text, "Checking.");
  assert.equal(call.toolCalls[0]!.name, "shell");
  assert.deepEqual(JSON.parse(call.toolCalls[0]!.arguments), { command: "npm test" });
  assert.deepEqual(a.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "content", content: { type: "text", text: "Passing" } }] }), [{ kind: "result", callId: "c1", name: "shell", output: "Passing", isError: false }]);
  assert.deepEqual(a.say({ id: promptId, result: { stopReason: "end_turn" } }), [{ kind: "done" }]);
  assert.ok(a.ended());
});

test("Goose authentication errors explain interactive recovery", () => {
  const a = agent();
  a.say({ id: 0, result: {} });
  const failed = a.say({ id: a.last().id, error: { code: -32000, message: "Authentication required" } });
  const done = failed.find((o) => o.kind === "done");
  assert.ok(done?.kind === "done");
  assert.match(goose.explain(done.error!), /Run `goose`/);
});

test("Goose's key presence is a hint, while unrecognized configurations remain unknown", async () => {
  const keys = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];
  const saved = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(await loginStatus("goose", "unused"), null);
    for (const key of keys) {
      process.env[key] = "test-only-placeholder";
      assert.equal(await loginStatus("goose", "unused"), true);
      process.env[key] = "";
      assert.equal(await loginStatus("goose", "unused"), null);
    }
  } finally {
    keys.forEach((key, i) => saved[i] === undefined ? delete process.env[key] : process.env[key] = saved[i]);
  }
});
