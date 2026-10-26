// GitHub Copilot over ACP (Agent Client Protocol): the adapter's side of the conversation, message by message, against what the
// spec says an agent sends. No process: the parser is handed the agent's lines, and what it writes back is read off.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { ADAPTERS, type AcpKept, type AdapterOut, type TurnSpec } from "../src/runner/adapters.js";
import { WarmAcp } from "../src/runner/spawn-cli.js";

const copilot = ADAPTERS.copilot;

function agent(spec: Partial<TurnSpec> = {}) {
  const t: TurnSpec = { prompt: "Fix the test", resumeId: null, mode: "edits", system: "Standing note", ...spec };
  const sent: Record<string, any>[] = [JSON.parse(copilot.stdin(t))];
  let ended = false;
  const parse = copilot.parser(t, { cwd: "/work/repo", write: (l) => void sent.push(JSON.parse(l)), end: () => void (ended = true) });
  const say = (o: Record<string, unknown>): AdapterOut[] => parse(JSON.stringify({ jsonrpc: "2.0", ...o }));
  const update = (u: Record<string, unknown>) => say({ method: "session/update", params: { sessionId: "s1", update: u } });
  return { parse, say, update, sent, last: () => sent.at(-1)!, ended: () => ended };
}

test("a new conversation: initialize, session/new in the folder, then the instruction with the standing note in front", () => {
  const a = agent();
  assert.equal(a.sent[0]!.method, "initialize");
  assert.equal(a.sent[0]!.params.protocolVersion, 1);
  assert.deepEqual(a.sent[0]!.params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, "it is offered no files or terminal of Friday's");
  assert.deepEqual(a.say({ id: 0, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }), []);
  assert.equal(a.last().method, "session/new");
  assert.deepEqual(a.last().params, { cwd: "/work/repo", mcpServers: [] });
  assert.deepEqual(a.say({ id: a.last().id, result: { sessionId: "s1" } }), [{ kind: "session", id: "s1" }]);
  assert.equal(a.last().method, "session/prompt");
  assert.equal(a.last().params.sessionId, "s1");
  assert.match(a.last().params.prompt[0].text, /^Standing note[\s\S]*Fix the test$/);
});

test("Manual: files change unasked, a command is put to a person, and the answer goes back as the option they chose", () => {
  const a = agent({ ask: true });
  a.say({ id: 0, result: { protocolVersion: 1 } });
  a.say({ id: a.last().id, result: { sessionId: "s1" } });
  const prompt = a.last().id;
  assert.deepEqual(a.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Running the tests." } }), [{ kind: "delta", text: "Running the tests.", channel: "text" }]);
  const started = a.update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "npm test", kind: "execute", status: "pending", rawInput: { command: "npm test" } });
  assert.equal(started.length, 1);
  const msg = started[0] as Extract<AdapterOut, { kind: "message" }>;
  assert.equal(msg.text, "Running the tests.", "what it said comes with the step it takes");
  assert.equal(msg.toolCalls[0]!.name, "shell");
  assert.deepEqual(JSON.parse(msg.toolCalls[0]!.arguments), { command: "npm test" });

  const options = [
    { optionId: "yes", name: "Allow", kind: "allow_once" },
    { optionId: "always", name: "Always", kind: "allow_always" },
    { optionId: "no", name: "Reject", kind: "reject_once" },
  ];
  const asked = a.say({ id: 7, method: "session/request_permission", params: { sessionId: "s1", toolCall: { toolCallId: "c1" }, options } });
  assert.equal(asked.length, 1);
  const q = asked[0] as Extract<AdapterOut, { kind: "ask" }>;
  assert.equal(q.kind, "ask");
  assert.equal(q.tool, "shell");
  assert.deepEqual(q.input, { command: "npm test" });
  q.reply!(true);
  assert.deepEqual(a.last(), { jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "selected", optionId: "yes" } } }, "once, not always: the next one is asked again");

  // An edit needs no one in Manual.
  a.update({ sessionUpdate: "tool_call", toolCallId: "c2", title: "Edit src/a.ts", kind: "edit", locations: [{ path: "/work/repo/src/a.ts" }] });
  assert.deepEqual(a.say({ id: 8, method: "session/request_permission", params: { sessionId: "s1", toolCall: { toolCallId: "c2" }, options } }), []);
  assert.deepEqual(a.last().result, { outcome: { outcome: "selected", optionId: "yes" } });

  const done = a.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "content", content: { type: "text", text: "1 passing" } }] });
  assert.deepEqual(done, [{ kind: "result", callId: "c1", name: "shell", output: "1 passing", isError: false }]);
  const edited = a.update({ sessionUpdate: "tool_call_update", toolCallId: "c2", status: "completed", content: [{ type: "diff", path: "/work/repo/src/a.ts", oldText: "a", newText: "b" }] });
  assert.deepEqual(edited, [{ kind: "result", callId: "c2", name: "edit", output: "Edited /work/repo/src/a.ts", isError: false }]);

  // As Copilot 1.0.95 counts: input holds the cache reads and writes, and the total is input plus output.
  const end = a.say({ id: prompt, result: { stopReason: "end_turn", usage: { inputTokens: 100, cachedReadTokens: 40, cachedWriteTokens: 30, outputTokens: 20, totalTokens: 120 } } });
  assert.deepEqual(end, [{ kind: "usage", input: 60, cached: 40, output: 20 }, { kind: "done" }]);
  // As OpenCode 1.19 counts: input leaves the cache reads out, and input, cache reads and output make the total.
  const other = agent();
  other.say({ id: 0, result: {} });
  other.say({ id: other.last().id, result: { sessionId: "s2" } });
  const counted = other.say({ id: other.last().id, result: { stopReason: "end_turn", usage: { inputTokens: 37836, outputTokens: 5, totalTokens: 39633, cachedReadTokens: 1792 } } });
  assert.deepEqual(counted[0], { kind: "usage", input: 37836, cached: 1792, output: 5 });
  assert.ok(a.ended(), "its stdin is closed, so it exits");
});

test("Auto answers yes itself; Plan is put in the agent's plan mode and refused anything that changes something", () => {
  const auto = agent({ mode: "full" });
  auto.say({ id: 0, result: {} });
  auto.say({ id: auto.last().id, result: { sessionId: "s1" } });
  auto.update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "rm -rf dist", kind: "execute", rawInput: { command: "rm -rf dist" } });
  auto.say({ id: 3, method: "session/request_permission", params: { toolCall: { toolCallId: "c1" }, options: [{ optionId: "ok", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }] } });
  assert.deepEqual(auto.last().result, { outcome: { outcome: "selected", optionId: "ok" } });

  const plan = agent({ mode: "plan" });
  plan.say({ id: 0, result: {} });
  const modes = { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "agent", options: [{ value: "agent", name: "Agent" }, { value: "plan", name: "Plan" }, { value: "autopilot", name: "Autopilot" }] };
  plan.say({ id: plan.last().id, result: { sessionId: "s1", configOptions: [modes] } });
  assert.equal(plan.last().method, "session/set_config_option");
  assert.deepEqual(plan.last().params, { sessionId: "s1", configId: "mode", value: "plan" });
  plan.say({ id: plan.last().id, result: { configOptions: [{ ...modes, currentValue: "plan" }] } });
  assert.equal(plan.last().method, "session/prompt", "the instruction follows once the mode is set");
  plan.update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Edit", kind: "edit" });
  plan.say({ id: 9, method: "session/request_permission", params: { toolCall: { toolCallId: "c1" }, options: [{ optionId: "ok", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }] } });
  assert.deepEqual(plan.last().result, { outcome: { outcome: "selected", optionId: "no" } });
  // A command is a person's call, as in Manual, rather than a refusal that ends the turn.
  const looking = agent({ mode: "plan", ask: true });
  looking.say({ id: 0, result: {} });
  looking.say({ id: looking.last().id, result: { sessionId: "s1" } });
  looking.update({ sessionUpdate: "tool_call", toolCallId: "c2", title: "git status", kind: "execute", rawInput: { command: "git status" } });
  const q = looking.say({ id: 10, method: "session/request_permission", params: { toolCall: { toolCallId: "c2" }, options: [{ optionId: "ok", kind: "allow_once" }] } });
  assert.equal(q[0]!.kind, "ask");

  // A later turn that isn't Plan takes it out again, to its ordinary mode rather than its autopilot.
  const after = agent({ mode: "edits" });
  after.say({ id: 0, result: {} });
  after.say({ id: after.last().id, result: { sessionId: "s1", modes: { currentModeId: "plan", availableModes: [{ id: "autopilot", name: "Autopilot" }, { id: "plan", name: "Plan" }, { id: "agent", name: "Agent" }] } } });
  assert.deepEqual(after.last().params, { sessionId: "s1", modeId: "agent" });
});

test("a conversation it had is loaded, and the history it plays back is not this turn's", () => {
  const a = agent({ resumeId: "old-1", withSystem: false });
  a.say({ id: 0, result: { agentCapabilities: { loadSession: true } } });
  assert.equal(a.last().method, "session/load");
  assert.deepEqual(a.last().params, { cwd: "/work/repo", mcpServers: [], sessionId: "old-1" });
  assert.deepEqual(a.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "said last week" } }), []);
  assert.deepEqual(a.say({ id: a.last().id, result: {} }), [{ kind: "session", id: "old-1" }]);
  assert.equal(a.last().params.prompt[0].text, "Fix the test", "nothing repeated that it already remembers");

  // One it no longer has fails the way the runner knows to start afresh from.
  const gone = agent({ resumeId: "old-2" });
  gone.say({ id: 0, result: { agentCapabilities: { loadSession: true } } });
  const out = gone.say({ id: gone.last().id, error: { code: -32002, message: "Session not found" } });
  const d = out.at(-1) as Extract<AdapterOut, { kind: "done" }>;
  assert.match(copilot.explain(d.error!), /couldn't find its earlier conversation/);
});

test("Copilot's own shapes: a name search filed under read, apply_patch's file, words for an exit code, and output kept in rawOutput", () => {
  const a = agent({ mode: "full" });
  a.say({ id: 0, result: {} });
  a.say({ id: a.last().id, result: { sessionId: "s1" } });
  const glob = a.update({ sessionUpdate: "tool_call", toolCallId: "g", title: "Finding files matching **/math.js", kind: "read", rawInput: { pattern: "**/math.js" } });
  const g = (glob[0] as Extract<AdapterOut, { kind: "message" }>).toolCalls[0]!;
  assert.deepEqual([g.name, JSON.parse(g.arguments)], ["search", { pattern: "**/math.js" }]);
  const patch = a.update({ sessionUpdate: "tool_call", toolCallId: "p", title: "apply_patch", kind: "edit", rawInput: "*** Begin Patch\n*** Update File: math.js\n@@\n-a\n+b\n*** End Patch\n" });
  assert.deepEqual(JSON.parse((patch[0] as Extract<AdapterOut, { kind: "message" }>).toolCalls[0]!.arguments), { path: "math.js" });
  a.update({ sessionUpdate: "tool_call", toolCallId: "x", title: "Run tests", kind: "execute", rawInput: { command: "npm test" } });
  const failed = a.update({ sessionUpdate: "tool_call_update", toolCallId: "x", status: "completed", content: [{ type: "content", content: { type: "text", text: "\n<shellId: 0 completed with exit code 1>" } }] });
  assert.equal((failed[0] as { isError: boolean }).isError, true, "a command that exited 1 is a failed step");
  a.update({ sessionUpdate: "tool_call", toolCallId: "r", title: "Viewing a.ts", kind: "read", locations: [{ path: "/work/repo/a.ts" }] });
  const read = a.update({ sessionUpdate: "tool_call_update", toolCallId: "r", status: "completed", rawOutput: { content: "const a = 1;\n", detailedContent: "diff --git ..." } });
  assert.equal((read[0] as { output: string }).output, "const a = 1;\n");
  // Kiro's: its text in items.
  a.update({ sessionUpdate: "tool_call", toolCallId: "k", title: "Reading a.ts", kind: "read", locations: [{ path: "/work/repo/a.ts" }] });
  const kiro = a.update({ sessionUpdate: "tool_call_update", toolCallId: "k", status: "completed", rawOutput: { items: [{ Text: "export const b = 2;\n" }] } });
  assert.equal((kiro[0] as { output: string }).output, "export const b = 2;\n");
  // Cline's: commands in a list, results as { query, result, success }.
  const cl = a.update({ sessionUpdate: "tool_call_update", toolCallId: "c", title: "run_commands: npm test", kind: "execute", status: "pending", rawInput: { commands: ["npm test"] } });
  assert.deepEqual(JSON.parse((cl[0] as Extract<AdapterOut, { kind: "message" }>).toolCalls[0]!.arguments), { command: "npm test" });
  const ran = a.update({ sessionUpdate: "tool_call_update", toolCallId: "c", status: "completed", rawOutput: [{ query: "npm test", result: "1 failing", success: false }] });
  assert.deepEqual([(ran[0] as { output: string }).output, (ran[0] as { isError: boolean }).isError], ["1 failing", true]);
});

test("its `/` commands are passed on as listed, even while a conversation is played back", () => {
  const a = agent({ resumeId: "old-1" });
  a.say({ id: 0, result: { agentCapabilities: { loadSession: true } } });
  const out = a.update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Summarize the conversation" }, { name: "model", description: "Pick a model", input: { hint: "model" } }] });
  assert.deepEqual(out, [{ kind: "commands", list: [{ name: "compact", description: "Summarize the conversation" }, { name: "model", description: "Pick a model", hint: "model" }] }]);
});

test("a call announced before its input (OpenCode) is drawn once it says what it is doing", () => {
  const a = agent({ mode: "full" });
  a.say({ id: 0, result: {} });
  a.say({ id: a.last().id, result: { sessionId: "s1" } });
  assert.deepEqual(a.update({ sessionUpdate: "tool_call", toolCallId: "b", title: "bash", kind: "execute", status: "pending", rawInput: { cwd: "/work/repo" } }), []);
  const drawn = a.update({ sessionUpdate: "tool_call_update", toolCallId: "b", status: "in_progress", title: "ls -la", rawInput: { command: "ls -la", cwd: "/work/repo" } });
  assert.deepEqual(JSON.parse((drawn[0] as Extract<AdapterOut, { kind: "message" }>).toolCalls[0]!.arguments), { command: "ls -la" });
  assert.deepEqual(a.update({ sessionUpdate: "tool_call_update", toolCallId: "b", status: "in_progress", rawInput: { command: "ls -la" } }), [], "drawn once");
  // One that finishes without ever saying is still drawn, before its result.
  a.update({ sessionUpdate: "tool_call", toolCallId: "r", title: "read", kind: "read", status: "pending", rawInput: {} });
  const done = a.update({ sessionUpdate: "tool_call_update", toolCallId: "r", status: "completed", locations: [{ path: "/work/repo/a.ts" }], content: [{ type: "content", content: { type: "text", text: "x" } }] });
  assert.deepEqual(done.map((o) => o.kind), ["message", "result"]);
});

test("not signed in, Stop, and requests Friday never offered", () => {
  const a = agent();
  a.say({ id: 0, result: {} });
  const out = a.say({ id: a.last().id, error: { code: -32000, message: "Authentication required" } });
  assert.match(copilot.explain((out.at(-1) as { error: string }).error), /copilot login/);

  const b = agent({ ask: true });
  b.say({ id: 0, result: {} });
  b.say({ id: b.last().id, result: { sessionId: "s1" } });
  b.say({ id: 11, method: "fs/read_text_file", params: { path: "/etc/passwd" } });
  assert.equal(b.last().error.code, -32601);
  b.update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "make", kind: "execute", rawInput: { command: "make" } });
  b.say({ id: 12, method: "session/request_permission", params: { toolCall: { toolCallId: "c1" }, options: [{ optionId: "ok", kind: "allow_once" }] } });
  b.parse.cancel!();
  const tail = b.sent.slice(-2);
  assert.deepEqual(tail[0], { jsonrpc: "2.0", id: 12, result: { outcome: { outcome: "cancelled" } } }, "what it was waiting on is answered cancelled");
  assert.deepEqual(tail[1], { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s1" } });
});

test("a tool kept from the last turn is not initialized again, and its open conversation only gets the instruction", () => {
  const modes = { currentModeId: "agent", availableModes: [{ id: "agent", name: "Agent" }, { id: "plan", name: "Plan" }] };
  const kept: AcpKept = { caps: { loadSession: true }, sessionId: "s1", res: { modes } };
  const on = (spec: Partial<TurnSpec>) => {
    const sent: Record<string, any>[] = [];
    const t: TurnSpec = { prompt: "Next", resumeId: "s1", mode: "edits", system: "", withSystem: false, ...spec };
    const parse = copilot.parser(t, { cwd: "/work/repo", write: (l) => void sent.push(JSON.parse(l)), end: () => {}, kept });
    return { parse, sent };
  };
  const a = on({});
  assert.deepEqual(a.sent.map((m) => m.method), ["session/prompt"], "no initialize, no session/load");
  assert.equal(a.sent[0]!.params.sessionId, "s1");

  // A Plan turn on it puts it in plan mode, and the next Plan turn knows it is there.
  const b = on({ mode: "plan" });
  assert.deepEqual(b.sent.map((m) => m.method), ["session/set_mode"]);
  b.parse(JSON.stringify({ jsonrpc: "2.0", id: b.sent[0]!.id, result: {} }));
  assert.equal(kept.res!.modes.currentModeId, "plan");
  assert.deepEqual(on({ mode: "plan" }).sent.map((m) => m.method), ["session/prompt"]);
  // …and it saying it left plan mode by itself counts too.
  const c = on({ mode: "plan" });
  c.parse(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "current_mode_update", currentModeId: "agent" } } }));
  assert.equal(kept.res!.modes.currentModeId, "agent");

  // A conversation opened before anybody asked is the first new one's, said as it starts; a turn after carries on its own.
  const fresh: AcpKept = { caps: {}, sessionId: "f1", res: {}, fresh: true };
  const sent: Record<string, any>[] = [];
  const parse = copilot.parser({ prompt: "First", resumeId: null, mode: "edits", system: "Note" }, { cwd: "/w", write: (l) => void sent.push(JSON.parse(l)), end: () => {}, kept: fresh });
  assert.deepEqual(sent.map((m) => m.method), ["session/prompt"]);
  assert.deepEqual(parse(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: {} } })), [{ kind: "session", id: "f1" }]);
  assert.equal(fresh.fresh, false, "taken once");

  // One whose conversation isn't open in it loads it, still without initializing, and keeps it open for the next turn.
  const bare: AcpKept = { caps: { loadSession: true } };
  const d: Record<string, any>[] = [];
  const p = copilot.parser({ prompt: "Go", resumeId: "old", mode: "edits", system: "" }, { cwd: "/w", write: (l) => void d.push(JSON.parse(l)), end: () => {}, kept: bare });
  assert.deepEqual(d.map((m) => m.method), ["session/load"]);
  p(JSON.stringify({ jsonrpc: "2.0", id: d[0]!.id, result: { modes } }));
  assert.equal(bare.sessionId, "old");
  assert.equal(d.at(-1)!.method, "session/prompt");
});

test("WarmAcp: one process for every turn, started and with its conversation open before the first", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-acp-"));
  const warm = new WarmAcp(10_000);
  t.after(async () => {
    warm.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const fake = path.join(dir, "agent.mjs");
  await writeFile(
    fake,
    `import { createInterface } from "node:readline";
const out = (o) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\\n");
let inits = 0, news = 0;
createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") (inits++, out({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }));
  else if (m.method === "session/new") {
    news++;
    out({ method: "session/update", params: { sessionId: "s" + news, update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "review", description: "Review" }] } } });
    out({ id: m.id, result: { sessionId: "s" + news } });
  } else if (m.method === "session/prompt") {
    out({ method: "session/update", params: { sessionId: m.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pid " + process.pid + " inits " + inits + " news " + news } } } });
    out({ id: m.id, result: { stopReason: "end_turn" } });
  }
});
`,
  );
  const spec = (resumeId: string | null): TurnSpec => ({ prompt: "Hi", resumeId, mode: "full", system: "", withSystem: false });
  const how = (resumeId: string | null) => ({ command: process.execPath, args: [fake], opts: { cwd: dir }, init: copilot.stdin(spec(resumeId)), resumeId });
  const turn = async (resumeId: string | null) => {
    const taken = await warm.take(how(resumeId));
    assert.ok(taken, "the kept tool takes the turn");
    const outs: AdapterOut[] = [];
    const parse = copilot.parser(spec(resumeId), { cwd: dir, write: (l) => void taken.child.stdin!.write(l), end: () => void taken.child.stdin!.end(), kept: taken.kept });
    createInterface({ input: taken.child.stdout! }).on("line", (l) => outs.push(...parse(l)));
    await new Promise((r) => taken.child.on("close", r));
    return outs;
  };
  warm.prepare(how(null));
  const first = await turn(null);
  assert.deepEqual(first.find((o) => o.kind === "commands"), { kind: "commands", list: [{ name: "review", description: "Review" }] }, "its commands, said as it opened, reach the first turn");
  assert.deepEqual(first.find((o) => o.kind === "session"), { kind: "session", id: "s1" });
  const said = (outs: AdapterOut[]) => (outs.find((o) => o.kind === "delta") as { text: string }).text;
  assert.match(said(first), /inits 1 news 1$/);
  assert.equal(first.at(-1)!.kind, "done");
  const second = await turn("s1");
  assert.equal(said(second), said(first), "the same process, initialized once, with the same conversation");
  assert.ok(!second.some((o) => o.kind === "session"));
});
