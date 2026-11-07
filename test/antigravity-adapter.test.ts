// Antigravity CLI over ACP (`agy acp`, #19): its profile, and the parser's side of a conversation with it. Three conversations are
// recorded from Antigravity CLI 1.5.2 itself (test/fixtures/antigravity, see its README): a command asked about in Manual and
// allowed, a failing command in Auto, and a Plan turn. The rest are written from its ACP docs
// (antigravity.google/docs/ide/extensions/acp): "Authentication required" (-32000) with nobody signed in, Stop, resuming.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { devNull, homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { installStep } from "../src/client/engines.js";
import { ADAPTERS, antigravityModels, antigravitySignedIn, childPath, type AdapterOut, type TurnSpec } from "../src/runner/adapters.js";
import { ENGINE_MODEL_INFO, ENGINE_MODELS, ENGINE_NAMES, ENGINE_TOOLS, TOOL_INFO } from "../src/types.js";

const agy = ADAPTERS.antigravity;

function agent(spec: Partial<TurnSpec> = {}) {
  const turn: TurnSpec = { prompt: "Fix the failing test", system: "Standing note", resumeId: null, mode: "edits", ask: true, ...spec };
  const sent: Record<string, any>[] = [JSON.parse(agy.stdin(turn))];
  let ended = false;
  const parse = agy.parser(turn, { cwd: "/work/repo", write: (line) => void sent.push(JSON.parse(line)), end: () => void (ended = true) });
  const say = (frame: Record<string, unknown>): AdapterOut[] => parse(JSON.stringify({ jsonrpc: "2.0", ...frame }));
  const last = () => sent.at(-1)!;
  const answer = (result: Record<string, unknown>) => say({ id: last().id, result });
  const update = (u: Record<string, unknown>) => say({ method: "session/update", params: { sessionId: "s1", update: u } });
  return { turn, sent, parse, say, last, answer, update, ended: () => ended };
}

/** Its session options as the docs describe them: the models the account has, and five thinking levels. */
const model = (currentValue = "gemini-3.8-flash") => ({
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue,
  options: [
    { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    { value: "gemini-4-argon", name: "Gemini 4 Argon" },
  ],
});
const thinking = (currentValue = "medium") => ({
  id: "thinking_level",
  name: "Thinking level",
  category: "thought_level",
  type: "select",
  currentValue,
  options: ["Low", "Medium", "High", "Extra", "Max"].map((name) => ({ value: name.toLowerCase(), name })),
});
const modes = (currentModeId = "default") => ({
  currentModeId,
  availableModes: [
    { id: "default", name: "Default" },
    { id: "accept-edits", name: "Accept edits" },
    { id: "plan", name: "Plan" },
  ],
});
const options = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];

test("Antigravity CLI is offered by name, with Google's own installer on each system and its models from the account", () => {
  assert.ok(ENGINE_TOOLS.includes("antigravity"));
  assert.equal(ENGINE_NAMES.antigravity, "Antigravity CLI");
  assert.equal(TOOL_INFO.antigravity.docs, "https://antigravity.google/docs/cli/acp/");
  assert.deepEqual(installStep("antigravity", "mac"), { shell: "Terminal", command: "curl -fsSL https://antigravity.google/cli/install.sh | bash" });
  assert.deepEqual(installStep("antigravity", "linux"), { shell: "Shell", command: "curl -fsSL https://antigravity.google/cli/install.sh | bash" });
  assert.deepEqual(installStep("antigravity", "windows"), { shell: "PowerShell", command: "irm https://antigravity.google/cli/install.ps1 | iex" });
  assert.equal(installStep("antigravity", "mac").needs, undefined, "no Node.js: it is one binary");
  assert.deepEqual(ENGINE_MODEL_INFO.antigravity, []);
  assert.deepEqual(ENGINE_MODELS.antigravity, []);
});

test("Antigravity starts as `agy acp`, the folders beside its own as --add-dir, and never skipping its permission prompts", () => {
  assert.deepEqual(agy.bins, ["agy"]);
  assert.deepEqual(agy.login, [], "it signs in as it starts: `agy` once");
  assert.deepEqual(agy.logout, [], "its sign-out is its own /logout");
  assert.equal(agy.interactive, true);
  assert.equal(agy.dirs, true);
  assert.equal(agy.env, undefined);
  assert.equal(typeof agy.status, "function", "signed in or not, by `agy models`");
  for (const mode of ["edits", "full", "plan"] as const) {
    const turn: TurnSpec = { prompt: "x", system: "", resumeId: null, mode, model: "gemini-4-argon", effort: "high" };
    assert.deepEqual(agy.args(turn), ["acp"], `${mode}: the model and thinking level go over ACP, not on its command line`);
    assert.deepEqual(agy.args({ ...turn, dirs: ["/work/api", "/work/web app"] }), ["acp", "--add-dir", "/work/api", "--add-dir", "/work/web app"]);
    assert.ok(!agy.args({ ...turn, dirs: ["/x"] }).some((a) => /skip-permissions/.test(a)), `${mode}: never --dangerously-skip-permissions`);
  }
});

/** A stand-in `agy`: a Node script (behind an npm-style shim on Windows), answering `models` as FAKE_AGY says, its arguments kept. */
async function fakeAgy(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-agy-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const script = `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(path.join(dir, "args.json"))}, JSON.stringify(process.argv.slice(2)));
const say = (s) => process.stdout.write(s + "\\n");
say("Fetching available models...");
if (process.env.FAKE_AGY === "in") {
  say("gemini-3.8-flash-high\\tGemini 3.8 Flash (High)");
  say("gemini-3.8-flash-low\\tGemini 3.8 Flash (Low)");
  say("gpt-oss-120b-medium\\tGPT-OSS 120B (Medium)");
} else if (process.env.FAKE_AGY === "out") {
  process.stderr.write("Error: Please sign in to view available models. Launch the CLI without arguments to sign in.\\n");
  process.exitCode = 1;
} else {
  process.stderr.write("Error: failed to fetch models: dial tcp: lookup daily-cloudcode-pa.googleapis.com: no such host\\n");
  process.exitCode = 1;
}
`;
  let bin: string;
  if (process.platform === "win32") {
    await writeFile(path.join(dir, "fake-agy.mjs"), script);
    bin = path.join(dir, "agy.cmd");
    await writeFile(bin, `@ECHO off\r\n"%_prog%"  "%dp0%\\fake-agy.mjs" %*\r\n`);
  } else {
    bin = path.join(dir, "agy");
    await writeFile(bin, `#!/usr/bin/env node\n${script}`);
    await chmod(bin, 0o755);
  }
  return { bin, args: async () => JSON.parse(await readFile(path.join(dir, "args.json"), "utf8")) as string[] };
}

test("signed in or not is what `agy models` says, with its log sent nowhere; anything else it says is unknown", async (t) => {
  const agyBin = await fakeAgy(t);
  const was = process.env.FAKE_AGY;
  t.after(() => (was === undefined ? delete process.env.FAKE_AGY : (process.env.FAKE_AGY = was)));
  process.env.FAKE_AGY = "in";
  assert.equal(await antigravitySignedIn(agyBin.bin), true);
  assert.deepEqual(await agyBin.args(), ["--log-file", devNull, "models"], "its own log file is never left behind");
  process.env.FAKE_AGY = "out";
  assert.equal(await antigravitySignedIn(agyBin.bin), false);
  process.env.FAKE_AGY = "offline";
  assert.equal(await antigravitySignedIn(agyBin.bin), null, "no network is not signed out");
  assert.equal(await antigravitySignedIn(path.join(tmpdir(), "no-such-agy-here")), null);
  assert.equal(typeof agy.status, "function");
});

test("`agy models` is read as its ACP model option names them: one model, whatever its thinking levels (1.5.2)", () => {
  // As Antigravity CLI 1.5.2 printed it for a Google AI account, and as its ACP model option listed the same models.
  const printed = [
    "Fetching available models...",
    "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
    "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
    "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
    "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
    "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)",
    "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
  ].join("\n");
  const session = JSON.parse(readFileSync(new URL("./fixtures/antigravity/manual-command.json", import.meta.url), "utf8")).find((f: any) => f.frame?.result?.configOptions).frame.result;
  const option = session.configOptions.find((o: any) => o.category === "model");
  assert.deepEqual(antigravityModels(printed), option.options.map((o: any) => ({ id: o.value, label: o.name })));
  assert.deepEqual(antigravityModels("Error: Please sign in to view available models."), []);
});

test("Antigravity's installers' folders are looked in, for an app started without the shell's PATH", () => {
  const dirs = childPath().split(path.delimiter);
  if (process.platform === "win32") assert.ok(dirs.includes(path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"), "agy", "bin")));
  else assert.ok(dirs.includes(path.join(homedir(), ".local", "bin")));
});

test("a turn: initialize, session/new in the folder, its model and thinking level set by its options, then the instruction", () => {
  const a = agent({ model: "gemini-4-argon", effort: "xhigh" });
  assert.equal(a.sent[0]!.method, "initialize");
  assert.equal(a.sent[0]!.params.protocolVersion, 1);
  assert.deepEqual(a.sent[0]!.params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  assert.deepEqual(a.say({ id: 0, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true } } } }), []);
  assert.deepEqual([a.last().method, a.last().params], ["session/new", { cwd: "/work/repo", mcpServers: [] }]);

  const opened = a.answer({ sessionId: "s1", modes: modes(), configOptions: [model(), thinking()] });
  assert.deepEqual(opened[0], { kind: "session", id: "s1" });
  assert.deepEqual(opened.find((o) => o.kind === "models"), {
    kind: "models",
    list: [
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
      { id: "gemini-4-argon", label: "Gemini 4 Argon" },
    ],
  });
  assert.deepEqual([a.last().method, a.last().params], ["session/set_config_option", { sessionId: "s1", configId: "model", value: "gemini-4-argon" }]);
  const levels = a.answer({ configOptions: [model("gemini-4-argon"), thinking()] });
  assert.deepEqual(levels.find((o) => o.kind === "efforts"), { kind: "efforts", list: ["low", "medium", "high", "xhigh", "max"] }, "Extra is Friday's xhigh");
  assert.deepEqual([a.last().method, a.last().params], ["session/set_config_option", { sessionId: "s1", configId: "thinking_level", value: "extra" }]);
  a.answer({ configOptions: [model("gemini-4-argon"), thinking("extra")] });
  assert.equal(a.last().method, "session/prompt", "default is left as it is outside Plan");
  assert.match(a.last().params.prompt[0].text, /^Standing note[\s\S]*Fix the failing test$/);

  const promptId = a.last().id;
  assert.deepEqual(a.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Reading the test." } }), [{ kind: "delta", channel: "reasoning", text: "Reading the test." }]);
  assert.deepEqual(a.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Fixed." } }), [{ kind: "delta", channel: "text", text: "Fixed." }]);
  const done = a.say({ id: promptId, result: { stopReason: "end_turn", usage: { inputTokens: 1200, outputTokens: 80, totalTokens: 1280 } } });
  assert.deepEqual(done.at(-1), { kind: "done" });
  assert.ok(a.ended());
});

test("Manual puts a command to a person and edits go unasked, Auto says yes, and Plan picks its plan mode and refuses edits", () => {
  for (const mode of ["edits", "full", "plan"] as const) {
    const a = agent({ mode });
    a.say({ id: 0, result: { protocolVersion: 1 } });
    a.answer({ sessionId: "s1", modes: modes() });
    if (mode === "plan") {
      assert.deepEqual([a.last().method, a.last().params], ["session/set_mode", { sessionId: "s1", modeId: "plan" }]);
      a.answer({});
    }
    assert.equal(a.last().method, "session/prompt");

    a.update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "npm test", kind: "execute", status: "pending", rawInput: { command: "npm test" } });
    const asked = a.say({ id: 41, method: "session/request_permission", params: { sessionId: "s1", toolCall: { toolCallId: "c1" }, options } });
    if (mode === "full") assert.deepEqual(a.last().result, { outcome: { outcome: "selected", optionId: "allow" } });
    else {
      const q = asked.find((o) => o.kind === "ask");
      assert.ok(q?.kind === "ask", `${mode}: a command is put to a person`);
      assert.equal(q.tool, "shell");
      q.reply!(false);
      assert.deepEqual(a.last().result, { outcome: { outcome: "selected", optionId: "deny" } });
    }

    a.update({ sessionUpdate: "tool_call", toolCallId: "c2", title: "Edit src/total.ts", kind: "edit", status: "pending", locations: [{ path: "/work/repo/src/total.ts" }] });
    a.say({ id: 42, method: "session/request_permission", params: { sessionId: "s1", toolCall: { toolCallId: "c2" }, options } });
    assert.deepEqual(a.last().result, { outcome: { outcome: "selected", optionId: mode === "plan" ? "deny" : "allow" } }, `${mode}: an edit`);
  }
});

test("a Plan turn on a conversation left in Plan goes back to its default mode next time", () => {
  const a = agent({ mode: "edits", resumeId: "s1" });
  a.say({ id: 0, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  assert.deepEqual([a.last().method, a.last().params], ["session/load", { cwd: "/work/repo", mcpServers: [], sessionId: "s1" }]);
  a.answer({ modes: modes("plan") });
  assert.deepEqual([a.last().method, a.last().params], ["session/set_mode", { sessionId: "s1", modeId: "default" }]);
});

test("not signed in: Authentication required (-32000) ends the turn, and the way out is to run agy once", () => {
  const a = agent();
  a.say({ id: 0, result: { protocolVersion: 1, authMethods: [{ id: "oauth-personal", name: "Log in with Google" }, { id: "gemini-api-key", name: "Gemini API key" }] } });
  assert.equal(a.last().method, "session/new");
  const out = a.say({ id: a.last().id, error: { code: -32000, message: "Authentication required" } });
  assert.deepEqual(out, [{ kind: "done", error: "Authentication required" }]);
  assert.ok(a.ended());
  assert.equal(agy.explain("Authentication required"), `${ENGINE_NAMES.antigravity} isn't signed in on the computer it runs on. Run \`agy\` there, then send the instruction again.`);
});

test("Stop: a question it was waiting on is answered cancelled, then the turn is cancelled over ACP", () => {
  const a = agent();
  a.say({ id: 0, result: { protocolVersion: 1 } });
  a.answer({ sessionId: "s1", modes: modes() });
  const promptId = a.last().id;
  a.update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "rm -rf build", kind: "execute", status: "pending", rawInput: { command: "rm -rf build" } });
  assert.ok(a.say({ id: 7, method: "session/request_permission", params: { sessionId: "s1", toolCall: { toolCallId: "c1" }, options } }).some((o) => o.kind === "ask"));
  a.parse.cancel!();
  assert.deepEqual(a.sent.at(-2), { jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "cancelled" } } });
  assert.deepEqual(a.sent.at(-1), { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s1" } });
  assert.deepEqual(a.say({ id: promptId, result: { stopReason: "cancelled" } }).at(-1), { kind: "done" });
});

test("a Plan turn with a model picked still goes into its plan mode", () => {
  const a = agent({ mode: "plan", model: "gemini-4-argon" });
  a.say({ id: 0, result: { protocolVersion: 1 } });
  a.answer({ sessionId: "s1", modes: modes(), configOptions: [model(), thinking()] });
  assert.equal(a.last().params.configId, "model");
  a.answer({ configOptions: [model("gemini-4-argon"), thinking()] });
  assert.deepEqual([a.last().method, a.last().params], ["session/set_mode", { sessionId: "s1", modeId: "plan" }]);
  a.answer({});
  assert.equal(a.last().method, "session/prompt");
});

test("a Plan turn with a thinking level picked still goes into its plan mode", () => {
  const a = agent({ mode: "plan", effort: "high" });
  a.say({ id: 0, result: { protocolVersion: 1 } });
  a.answer({ sessionId: "s1", modes: modes(), configOptions: [model(), thinking()] });
  assert.deepEqual([a.last().method, a.last().params], ["session/set_config_option", { sessionId: "s1", configId: "thinking_level", value: "high" }]);
  a.answer({ configOptions: [model(), thinking("high")] });
  assert.deepEqual([a.last().method, a.last().params], ["session/set_mode", { sessionId: "s1", modeId: "plan" }]);
  a.answer({});
  assert.equal(a.last().method, "session/prompt");
});

// ── recorded from Antigravity CLI 1.5.2 ─────────────────────────────────────────────────────────────────────────────────

/**
 * One of the recorded conversations played back to the parser: what Friday sends has to be what was sent (its own requests' ids
 * aside, which count up across a process), and what Antigravity said goes back in. A question it asks is answered `allow`.
 */
function replay(name: string, spec: Partial<TurnSpec>, allow = true) {
  const recording = JSON.parse(readFileSync(new URL(`./fixtures/antigravity/${name}.json`, import.meta.url), "utf8")) as { direction: "in" | "out"; frame: Record<string, any> }[];
  const turn: TurnSpec = { prompt: "", system: "Work only in this temporary repository. Keep your answer brief.", resumeId: null, mode: "edits", ask: true, model: "gemini-3.8-flash", effort: "low", ...spec };
  const sent: Record<string, any>[] = [JSON.parse(agy.stdin(turn))];
  let ended = false;
  const parse = agy.parser(turn, { cwd: "/work/repo", write: (line) => void sent.push(JSON.parse(line)), end: () => void (ended = true) });
  const ids = new Map<number, number>();
  const outs: AdapterOut[] = [];
  let at = 0;
  for (const { direction, frame } of recording) {
    if (direction === "out") {
      const actual = sent[at++];
      assert.ok(actual, `Friday sent ${frame.method ?? "its answer"}`);
      if (frame.method && frame.id !== undefined) {
        ids.set(frame.id, actual.id);
        assert.deepEqual({ ...actual, id: frame.id }, frame);
      } else assert.deepEqual(actual, frame);
    } else {
      const f = frame.method || frame.id === undefined ? frame : { ...frame, id: ids.get(frame.id) };
      for (const o of parse(JSON.stringify(f))) {
        outs.push(o);
        if (o.kind === "ask") o.reply!(allow);
      }
    }
  }
  assert.equal(at, sent.length, "nothing sent that wasn't recorded");
  return { outs, ended: () => ended, text: outs.filter((o) => o.kind === "delta" && o.channel === "text").map((o) => (o.kind === "delta" ? o.text : "")).join("") };
}

test("recorded (1.5.2): Manual puts its command to you, allowed it runs, and the answer and the account's models come back", () => {
  const r = replay("manual-command", { prompt: "Run the shell command: echo FRIDAY_AGY_CMD — then reply with exactly what it printed.", mode: "edits" });
  const models = r.outs.find((o) => o.kind === "models");
  assert.deepEqual(models?.kind === "models" && models.list.map((m) => m.id), ["gemini-3.8-flash", "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"]);
  assert.deepEqual(r.outs.find((o) => o.kind === "efforts"), { kind: "efforts", list: ["low", "medium", "high"] });
  const ask = r.outs.find((o) => o.kind === "ask");
  assert.ok(ask?.kind === "ask" && ask.tool === "shell" && ask.input.command === "echo FRIDAY_AGY_CMD", "the command is put to a person");
  const ran = r.outs.find((o) => o.kind === "result");
  assert.ok(ran?.kind === "result" && !ran.isError && /FRIDAY_AGY_CMD/.test(ran.output));
  assert.equal(r.text.trim(), "FRIDAY_AGY_CMD");
  assert.deepEqual(r.outs.at(-1), { kind: "done" });
  assert.ok(r.ended());
});

test("recorded (1.5.2): a command that fails is an error, though Antigravity calls the call completed (its exit_code)", () => {
  const r = replay("failing-command", { prompt: "Run exactly this shell command once: ls /no-such-dir-friday — then reply with just its exit code as a number.", mode: "full" });
  const ran = r.outs.find((o) => o.kind === "result");
  assert.ok(ran?.kind === "result" && ran.name === "shell");
  assert.match(ran.output, /exited with code 1/);
  assert.equal(ran.isError, true);
  assert.ok(!r.outs.some((o) => o.kind === "ask"), "Auto asks nobody");
  assert.equal(r.text.trim(), "1");
});

test("recorded (1.5.2): a Plan turn sets its thinking level, then its mode to plan, before the instruction", () => {
  const r = replay("plan", { prompt: "Reply exactly FRIDAY_AGY_PLAN. Do not use tools.", mode: "plan" });
  assert.equal(r.text.trim(), "FRIDAY_AGY_PLAN");
  assert.deepEqual(r.outs.at(-1), { kind: "done" });
});

test("a command's exit code is read from its words when there is no number beside it", () => {
  const a = agent({ mode: "full" });
  a.say({ id: 0, result: { protocolVersion: 1 } });
  a.answer({ sessionId: "s1", modes: modes() });
  a.update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "npm test", kind: "execute", status: "pending", rawInput: { CommandLine: "npm test" } });
  const out = a.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "content", content: { type: "text", text: "Command exited with code 2.\n\nCommand output:\nfailing\n" } }] });
  assert.deepEqual(out.at(-1), { kind: "result", callId: "c1", name: "shell", output: "Command exited with code 2.\n\nCommand output:\nfailing\n", isError: true });
  const call = a.update({ sessionUpdate: "tool_call", toolCallId: "c2", title: "Run tests", kind: "execute", status: "pending", rawInput: { CommandLine: "npm run lint" } })[0] as Extract<AdapterOut, { kind: "message" }>;
  assert.deepEqual(JSON.parse(call.toolCalls[0]!.arguments), { command: "npm run lint" }, "its CommandLine is the command, whatever its title says");
});
