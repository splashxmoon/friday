// Synthetic ACP contract exchanges for Qwen's profile. These are not live recordings.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { ADAPTERS, loginStatus, type AcpKept, type AdapterOut, type TurnSpec } from "../src/runner/adapters.js";

const qwen = ADAPTERS.qwen;

test("Qwen 0.26.5 recorded authenticated turn completes and streams its answer", () => {
  const recording = JSON.parse(readFileSync(new URL("./fixtures/qwen/success.json", import.meta.url), "utf8")) as { direction: string; frame: Record<string, any> }[];
  const turn: TurnSpec = { prompt: "Reply exactly FRIDAY_QWEN_OK. Do not use tools.", system: "Work only in this temporary repository. Use local file and shell tools only. Never access network or credentials. Keep your answer brief.", resumeId: null, mode: "edits", ask: true };
  const sent: Record<string, any>[] = [JSON.parse(qwen.stdin(turn))];
  let ended = false;
  const parse = qwen.parser(turn, { cwd: "/work/repo", write: (line) => void sent.push(JSON.parse(line)), end: () => void (ended = true) });
  const ids = new Map<number, number>();
  const outs: AdapterOut[] = [];
  let outgoing = 0;
  for (const { direction, frame } of recording) {
    if (direction === "out") {
      const actual = sent[outgoing++]!;
      assert.ok(actual, `Friday sent ${frame.method}`);
      ids.set(frame.id, actual.id);
      assert.deepEqual({ ...actual, id: frame.id }, frame);
    } else {
      outs.push(...parse(JSON.stringify(frame.id === undefined ? frame : { ...frame, id: ids.get(frame.id) })));
    }
  }
  assert.equal(outgoing, sent.length);
  assert.ok(ended);
  assert.deepEqual(outs.at(-1), { kind: "done" });
  assert.equal(outs.filter((o) => o.kind === "delta" && o.channel === "text").map((o) => o.kind === "delta" ? o.text : "").join(""), "FRIDAY_QWEN_OK");
  assert.ok(outs.some((o) => o.kind === "session" && o.id === "qwen-session-1"));
});

test("Qwen 0.26.5 recorded handshake and authentication failure", () => {
  const recording = JSON.parse(readFileSync(new URL("./fixtures/qwen/auth-required.json", import.meta.url), "utf8")) as { direction: string; frame: Record<string, any> }[];
  const turn: TurnSpec = { prompt: "Hello", system: "", resumeId: null, mode: "edits" };
  const sent: Record<string, any>[] = [JSON.parse(qwen.stdin(turn))];
  let ended = false;
  const parse = qwen.parser(turn, { cwd: "/work/repo", write: (line) => void sent.push(JSON.parse(line)), end: () => void (ended = true) });
  const ids = new Map<number, number>();
  const outs: AdapterOut[] = [];
  let outgoing = 0;
  for (const { direction, frame } of recording) {
    if (direction === "out") {
      const actual = sent[outgoing++]!;
      assert.ok(actual, `Friday sent ${frame.method}`);
      ids.set(frame.id, actual.id);
      assert.deepEqual({ ...actual, id: frame.id }, frame);
    } else {
      outs.push(...parse(JSON.stringify({ ...frame, id: ids.get(frame.id) })));
    }
  }
  assert.equal(outgoing, sent.length);
  assert.deepEqual(outs, [{ kind: "done", error: "Authentication required" }]);
  assert.ok(ended);
  assert.match(qwen.explain("Authentication required"), /Run `qwen`/);
});
const modes = (currentModeId = "default") => ({ currentModeId, availableModes: ["default", "plan", "auto", "yolo"].map((id) => ({ id, name: id })) });
const config = (currentValue = "default") => ({ id: "mode", name: "Mode", category: "mode", type: "select", currentValue, options: modes().availableModes.map(({ id, name }) => ({ value: id, name })) });
const options = [{ optionId: "yes", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }];

function agent(spec: Partial<TurnSpec> = {}, kept?: AcpKept) {
  const turn: TurnSpec = { prompt: "Check the tests", system: "Standing note", resumeId: null, mode: "edits", ask: true, ...spec };
  const sent: Record<string, any>[] = kept ? [] : [JSON.parse(qwen.stdin(turn))];
  let ended = false;
  const parse = qwen.parser(turn, { cwd: "/work/repo", write: (line) => void sent.push(JSON.parse(line)), end: () => void (ended = true), kept });
  const say = (frame: Record<string, unknown>) => parse(JSON.stringify({ jsonrpc: "2.0", ...frame }));
  const last = () => sent.at(-1)!;
  const answer = (result: Record<string, unknown>) => say({ id: last().id, result });
  const update = (u: Record<string, unknown>) => say({ method: "session/update", params: { sessionId: "s1", update: u } });
  const open = (res: Record<string, unknown> = { modes: modes() }) => {
    say({ id: 0, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    return answer({ sessionId: "s1", ...res });
  };
  return { turn, sent, parse, say, answer, update, open, last, ended: () => ended };
}

test("Qwen uses ACP, streams a command and its result, then ends the turn", () => {
  const a = agent();
  assert.deepEqual(qwen.bins, ["qwen"]);
  assert.deepEqual(qwen.args(a.turn), ["--acp"]);
  assert.deepEqual(qwen.login, []);
  assert.deepEqual(qwen.logout, []);
  assert.equal(a.last().method, "initialize");
  a.say({ id: 0, result: { protocolVersion: 1 } });
  assert.equal(a.last().method, "session/new");
  assert.deepEqual(a.last().params, { cwd: "/work/repo", mcpServers: [] });
  a.answer({ sessionId: "s1", modes: modes() });
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

test("Qwen Manual asks, Auto approves, and Plan refuses edits", () => {
  for (const mode of ["edits", "full", "plan"] as const) {
    const a = agent({ mode });
    a.open({ configOptions: [config(mode === "plan" ? "plan" : "default")] });
    assert.equal(a.last().method, "session/prompt");
    a.update({ sessionUpdate: "tool_call", toolCallId: "c1", title: mode === "plan" ? "Edit file" : "npm test", kind: mode === "plan" ? "edit" : "execute", rawInput: { command: "npm test" } });
    const out = a.say({ id: 99, method: "session/request_permission", params: { toolCall: { toolCallId: "c1" }, options } });
    if (mode === "edits") {
      const ask = out.find((o) => o.kind === "ask");
      assert.ok(ask?.kind === "ask");
      ask.reply!(false);
    }
    assert.deepEqual(a.last().result, { outcome: { outcome: "selected", optionId: mode === "full" ? "yes" : "no" } });
  }
});

test("new and resumed Qwen sessions leave saved automatic modes before prompting", () => {
  for (const resumeId of [null, "old-session"]) {
    for (const current of ["auto", "yolo"]) {
      const a = agent({ resumeId });
      a.say({ id: 0, result: { agentCapabilities: { loadSession: true } } });
      assert.equal(a.last().method, resumeId ? "session/load" : "session/new");
      a.answer({ sessionId: "s1", configOptions: [config(current)] });
      assert.equal(a.last().method, "session/set_config_option");
      assert.equal(a.last().params.value, "default");
      assert.ok(!a.sent.some((m) => m.method === "session/prompt"));
      a.answer({});
      assert.equal(a.last().method, "session/prompt");
    }
  }
});

test("kept Qwen sessions select Plan, and leaving Plan restores default", () => {
  const kept: AcpKept = { caps: {}, sessionId: "s1", res: { modes: modes("yolo") } };
  const a = agent({ resumeId: "s1", mode: "plan" }, kept);
  assert.equal(a.last().method, "session/set_mode");
  assert.equal(a.last().params.modeId, "plan");
  a.answer({});
  assert.equal(kept.res!.modes.currentModeId, "plan");
  assert.equal(a.last().method, "session/prompt");
  const b = agent({ resumeId: "s1", mode: "edits" }, kept);
  assert.equal(b.last().params.modeId, "default");
  b.answer({});
  assert.equal(kept.res!.modes.currentModeId, "default");
  assert.deepEqual(agent({ resumeId: "s1" }, kept).sent.map((m) => m.method), ["session/prompt"]);
});

test("Qwen never receives a prompt when a required permission mode is missing or rejected", () => {
  const missing = agent();
  const out = missing.open({});
  assert.ok(out.some((o) => o.kind === "done" && /required permission mode/.test(o.error ?? "")));
  assert.ok(missing.ended());
  assert.ok(!missing.sent.some((m) => m.method === "session/prompt"));
  const refused = agent();
  refused.open({ modes: modes("yolo") });
  const failed = refused.say({ id: refused.last().id, error: { code: -32602, message: "Mode refused" } });
  assert.ok(failed.some((o) => o.kind === "done" && /Mode refused/.test(o.error ?? "")));
  assert.ok(!refused.sent.some((m) => m.method === "session/prompt"));
});

test("Qwen authentication errors explain interactive recovery and Stop cancels pending permission", () => {
  const a = agent();
  a.say({ id: 0, result: {} });
  const failed = a.say({ id: a.last().id, error: { code: -32000, message: "Authentication required" } });
  const done = failed.find((o) => o.kind === "done");
  assert.ok(done?.kind === "done");
  assert.match(qwen.explain(done.error!), /Run `qwen`/);
  const b = agent();
  b.open();
  b.update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "npm test", kind: "execute", rawInput: { command: "npm test" } });
  b.say({ id: 99, method: "session/request_permission", params: { toolCall: { toolCallId: "c1" }, options } });
  b.parse.cancel!();
  assert.deepEqual(b.sent.at(-2)!.result, { outcome: { outcome: "cancelled" } });
  assert.equal(b.last().method, "session/cancel");
});

test("Qwen's key presence is a hint, while unrecognized configurations remain unknown", async () => {
  const keys = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];
  const saved = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(await loginStatus("qwen", "unused"), null);
    for (const key of keys) {
      process.env[key] = "test-only-placeholder";
      assert.equal(await loginStatus("qwen", "unused"), true);
      process.env[key] = "";
      assert.equal(await loginStatus("qwen", "unused"), null);
    }
  } finally {
    keys.forEach((key, i) => saved[i] === undefined ? delete process.env[key] : process.env[key] = saved[i]);
  }
});
