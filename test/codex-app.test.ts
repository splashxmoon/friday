// Codex over its app-server: the adapter's side of the conversation, message by message, against the protocol's own schema
// (`codex app-server generate-json-schema`, 0.159). No process: the parser is handed the server's lines, and what it writes back
// is read off. Then the kept process itself, against a stand-in server, and a Codex too old to have one.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { ADAPTERS, codexExec, type AcpKept, type AdapterOut, type TurnSpec } from "../src/runner/adapters.js";
import { WarmAcp } from "../src/runner/spawn-cli.js";

const codex = ADAPTERS.codex;

function server(spec: Partial<TurnSpec> = {}, cwd = "/work/repo") {
  const t: TurnSpec = { prompt: "Fix the test", resumeId: null, mode: "edits", system: "Standing note", ...spec };
  const sent: Record<string, any>[] = [JSON.parse(codex.stdin(t))];
  let ended = false;
  const parse = codex.parser(t, { cwd, write: (l) => void sent.push(JSON.parse(l)), end: () => void (ended = true) });
  const say = (o: Record<string, unknown>): AdapterOut[] => parse(JSON.stringify(o));
  const notify = (method: string, params: Record<string, unknown>) => say({ method, params });
  return { parse, say, notify, sent, last: () => sent.at(-1)!, ended: () => ended };
}

/** Up to the thread open: initialize answered, the thread started, the turn sent. */
function opened(spec: Partial<TurnSpec> = {}, cwd?: string) {
  const s = server(spec, cwd);
  s.say({ id: 0, result: { userAgent: "codex" } });
  s.say({ id: s.last().id, result: { thread: { id: "thr_1" } } });
  return s;
}

test("a new conversation: initialize, initialized, a thread in the folder, then the turn with the standing note in front", () => {
  const s = server({ model: "gpt-6.1-sol", effort: "xhigh" });
  assert.deepEqual(s.sent[0], { id: 0, method: "initialize", params: { clientInfo: { name: "friday", title: "Friday", version: "1" } } }, "no jsonrpc field, as its docs have it");
  assert.deepEqual(s.say({ id: 0, result: { userAgent: "codex" } }), []);
  assert.deepEqual(s.sent[1], { method: "initialized", params: {} });
  assert.equal(s.last().method, "thread/start");
  assert.deepEqual(s.last().params, { cwd: "/work/repo", serviceName: "friday" });
  assert.deepEqual(s.say({ id: s.last().id, result: { thread: { id: "thr_1" } } }), [{ kind: "session", id: "thr_1" }]);
  const turn = s.last();
  assert.equal(turn.method, "turn/start");
  assert.equal(turn.params.threadId, "thr_1");
  assert.match(turn.params.input[0].text, /^Standing note[\s\S]*Fix the test$/);
  assert.deepEqual([turn.params.model, turn.params.effort], ["gpt-6.1-sol", "xhigh"], "the model and effort picked in Friday go with the turn");
  assert.deepEqual(turn.params.sandboxPolicy, { type: "readOnly", networkAccess: true }, "Edits with no yes yet: it reads");
  assert.equal(turn.params.approvalPolicy, "never");
});

test("what it writes streams as it is written, its steps are cards, and the turn ends with what it used", () => {
  const s = opened();
  s.notify("turn/started", { threadId: "thr_1", turn: { id: "turn_1", status: "inProgress" } });
  assert.deepEqual(s.notify("item/reasoning/summaryTextDelta", { threadId: "thr_1", turnId: "turn_1", itemId: "r1", delta: "Looking at the test." }), [{ kind: "delta", text: "Looking at the test.", channel: "reasoning" }]);
  assert.deepEqual(s.notify("item/agentMessage/delta", { threadId: "thr_1", turnId: "turn_1", itemId: "m1", delta: "Running " }), [{ kind: "delta", text: "Running ", channel: "text" }]);
  assert.deepEqual(s.notify("item/agentMessage/delta", { threadId: "thr_1", turnId: "turn_1", itemId: "m1", delta: "the tests." }), [{ kind: "delta", text: "the tests.", channel: "text" }]);
  const started = s.notify("item/started", { threadId: "thr_1", turnId: "turn_1", item: { id: "c1", type: "commandExecution", command: "/bin/zsh -lc 'npm test'", cwd: "/work/repo", status: "inProgress" } });
  assert.equal(started.length, 1);
  const msg = started[0] as Extract<AdapterOut, { kind: "message" }>;
  assert.equal(msg.text, "Running the tests.", "what it said comes with the step it takes");
  assert.equal(msg.reasoning, "Looking at the test.");
  assert.equal(msg.toolCalls[0]!.name, "shell");
  assert.deepEqual(JSON.parse(msg.toolCalls[0]!.arguments), { command: "npm test" });
  assert.deepEqual(s.notify("item/commandExecution/outputDelta", { threadId: "thr_1", turnId: "turn_1", itemId: "c1", delta: "1 passing" }), [], "a command's output waits for the result");
  const done = s.notify("item/completed", { threadId: "thr_1", turnId: "turn_1", item: { id: "c1", type: "commandExecution", command: "/bin/zsh -lc 'npm test'", aggregatedOutput: "1 passing\n", exitCode: 0, status: "completed" } });
  assert.deepEqual(done, [{ kind: "result", callId: "c1", name: "shell", output: "1 passing\n", isError: false }]);
  // A step not announced first (an older server) is drawn with its result.
  const edit = s.notify("item/completed", { threadId: "thr_1", turnId: "turn_1", item: { id: "e1", type: "fileChange", changes: [{ path: "src/a.ts", kind: "update", diff: "" }], status: "completed" } });
  assert.equal(edit.length, 2);
  assert.equal((edit[0] as Extract<AdapterOut, { kind: "message" }>).toolCalls[0]!.name, "edit");
  assert.deepEqual(edit[1], { kind: "result", callId: "e1", name: "edit", output: "update src/a.ts", isError: false });
  assert.deepEqual(s.notify("item/completed", { threadId: "thr_1", turnId: "turn_1", item: { id: "m1", type: "agentMessage", text: "Running the tests. They pass." } }), [{ kind: "message", text: "Running the tests. They pass.", toolCalls: [] }], "whole, once it is complete");
  // Its count is for the thread in all: this turn's is the difference from where it stood as the turn began.
  s.notify("thread/tokenUsage/updated", { threadId: "thr_1", turnId: "turn_1", tokenUsage: { last: { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 50, reasoningOutputTokens: 10, cacheWriteInputTokens: 0, totalTokens: 1050 }, total: { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 50, reasoningOutputTokens: 10, cacheWriteInputTokens: 0, totalTokens: 1050 } } });
  s.notify("thread/tokenUsage/updated", { threadId: "thr_1", turnId: "turn_1", tokenUsage: { last: { inputTokens: 1200, cachedInputTokens: 900, outputTokens: 30, reasoningOutputTokens: 0, cacheWriteInputTokens: 0, totalTokens: 1230 }, total: { inputTokens: 2200, cachedInputTokens: 1300, outputTokens: 80, reasoningOutputTokens: 10, cacheWriteInputTokens: 0, totalTokens: 2280 } } });
  const end = s.notify("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "completed", items: [] } });
  // And how full its context is: its last call's input (cached included). With no window said, none is guessed here.
  assert.deepEqual(end, [{ kind: "usage", input: 900, cached: 1300, output: 80, context: 1200 }, { kind: "done" }]);
  assert.ok(s.ended(), "the turn is over; the process stays for the next");
});

test("Manual: a command is put to a person as it comes up, the answer goes back as its decision, and a file change needs nobody in Edits", () => {
  const s = opened({ ask: true });
  assert.equal(s.last().params.approvalPolicy, "on-request", "it asks before going beyond its read-only sandbox");
  const asked = s.say({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "thr_1", turnId: "turn_1", itemId: "c1", command: "/bin/zsh -lc 'npm test'", cwd: "/work/repo", reason: "to run the tests", startedAtMs: 1 } });
  assert.equal(asked.length, 2, "its card, then the question");
  const card = asked[0] as Extract<AdapterOut, { kind: "message" }>;
  assert.deepEqual([card.toolCalls[0]!.id, card.toolCalls[0]!.name], ["c1", "shell"]);
  const q = asked[1] as Extract<AdapterOut, { kind: "ask" }>;
  assert.deepEqual([q.kind, q.tool, q.input, q.why, q.requestId], ["ask", "shell", { command: "npm test" }, "to run the tests", "7"]);
  q.reply!(true);
  assert.deepEqual(s.last(), { id: 7, result: { decision: "accept" } }, "once: the next one is asked again");
  assert.deepEqual(s.notify("item/started", { threadId: "thr_1", turnId: "turn_1", item: { id: "c1", type: "commandExecution", command: "/bin/zsh -lc 'npm test'", status: "inProgress" } }), [], "drawn already");
  assert.deepEqual(s.say({ id: 8, method: "item/fileChange/requestApproval", params: { threadId: "thr_1", turnId: "turn_1", itemId: "e1", grantRoot: "/work/repo", startedAtMs: 2 } }).filter((o) => o.kind === "ask"), []);
  assert.deepEqual(s.last(), { id: 8, result: { decision: "accept" } });
  const no = s.say({ id: 9, method: "item/commandExecution/requestApproval", params: { threadId: "thr_1", turnId: "turn_1", itemId: "c2", command: "rm -rf dist", startedAtMs: 3 } });
  (no.at(-1) as Extract<AdapterOut, { kind: "ask" }>).reply!(false);
  assert.deepEqual(s.last(), { id: 9, result: { decision: "decline" } });
  // Stop mid-turn: the turn is interrupted, its thread kept, and the question still open is answered "cancel".
  s.say({ id: 10, method: "item/commandExecution/requestApproval", params: { threadId: "thr_1", turnId: "turn_1", itemId: "c3", command: "npm run build", startedAtMs: 4 } });
  s.notify("turn/started", { threadId: "thr_1", turn: { id: "turn_1" } });
  s.parse.cancel!();
  assert.deepEqual(s.sent.find((m) => m.id === 10), { id: 10, result: { decision: "cancel" } });
  assert.deepEqual(s.last(), { id: s.last().id, method: "turn/interrupt", params: { threadId: "thr_1", turnId: "turn_1" } });
  assert.deepEqual(s.notify("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "interrupted" } }).at(-1), { kind: "done" });
});

test("Auto answers yes itself and runs with the folder writable; Plan reads only and declines a change; what Manual refused is reported", () => {
  const auto = opened({ mode: "full" });
  assert.equal(auto.last().params.sandboxPolicy.type, process.platform === "win32" ? "dangerFullAccess" : "workspaceWrite");
  assert.deepEqual(auto.say({ id: 5, method: "item/commandExecution/requestApproval", params: { threadId: "thr_1", turnId: "t", itemId: "c1", command: "npm test", startedAtMs: 1 } }).filter((o) => o.kind === "ask"), []);
  assert.deepEqual(auto.last(), { id: 5, result: { decision: "accept" } });

  const plan = opened({ mode: "plan" });
  assert.deepEqual(plan.last().params.sandboxPolicy, { type: "readOnly", networkAccess: true });
  plan.say({ id: 6, method: "item/fileChange/requestApproval", params: { threadId: "thr_1", turnId: "t", itemId: "e1", startedAtMs: 1 } });
  assert.deepEqual(plan.last(), { id: 6, result: { decision: "decline" } });

  // Manual with nobody to ask (a reconnect's turn): refused, and said at the end for a person to allow next time.
  const manual = opened();
  manual.say({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "thr_1", turnId: "t", itemId: "c1", command: "npm test", startedAtMs: 1 } });
  assert.deepEqual(manual.last(), { id: 7, result: { decision: "decline" } });
  manual.notify("item/completed", { threadId: "thr_1", turnId: "t", item: { id: "c2", type: "commandExecution", command: "npm run lint", aggregatedOutput: "permission denied", exitCode: 1, status: "failed" } });
  const end = manual.notify("turn/completed", { threadId: "thr_1", turn: { id: "t", status: "completed" } });
  assert.deepEqual(end.find((o) => o.kind === "blocked"), { kind: "blocked", scope: "commands", items: ["npm test", "npm run lint"] });
});

test("Edits: a file change is let through only inside the folder; one reaching beyond it is asked about, or refused with nobody to ask; Auto lets all through", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-grant-"));
  const repo = path.join(dir, "repo");
  const outside = path.join(dir, "elsewhere");
  try {
    const change = (s: ReturnType<typeof opened>, id: number, grantRoot?: string) => {
      const out = s.say({ id, method: "item/fileChange/requestApproval", params: { threadId: "thr_1", turnId: "t", itemId: `e${id}`, ...(grantRoot ? { grantRoot } : {}), startedAtMs: id } });
      return { asks: out.filter((o) => o.kind === "ask") as Extract<AdapterOut, { kind: "ask" }>[], answer: s.sent.find((m) => m.id === id && m.result)?.result.decision };
    };
    const edits = opened({ ask: true }, repo);
    assert.deepEqual(change(edits, 1), { asks: [], answer: "accept" }, "no grantRoot: as before");
    assert.deepEqual(change(edits, 2, path.join(repo, "src")), { asks: [], answer: "accept" }, "inside the folder");
    if (process.platform === "win32" || process.platform === "darwin") assert.deepEqual(change(edits, 3, repo.toUpperCase()), { asks: [], answer: "accept" }, "the folder spelt in another case");
    const beyond = change(edits, 4, outside);
    assert.equal(beyond.answer, undefined, "not answered until a person does");
    assert.deepEqual([beyond.asks.length, beyond.asks[0]!.tool, beyond.asks[0]!.input], [1, "edit", { path: outside }]);
    beyond.asks[0]!.reply!(false);
    assert.equal(edits.sent.find((m) => m.id === 4 && m.result)?.result.decision, "decline");
    assert.deepEqual(change(edits, 5, path.join(repo, "..", "elsewhere")).asks.length, 1, "a .. out of the folder is beyond it");

    const nobody = opened({}, repo);
    assert.deepEqual(change(nobody, 6, outside), { asks: [], answer: "decline" });
    assert.deepEqual(change(nobody, 7, repo), { asks: [], answer: "accept" });
    const end = nobody.notify("turn/completed", { threadId: "thr_1", turn: { id: "t", status: "completed" } });
    assert.deepEqual(end.find((o) => o.kind === "blocked"), { kind: "blocked", scope: "turn", items: [`edit ${outside}`] });

    const auto = opened({ mode: "full" }, repo);
    for (const [id, root] of [[8, undefined], [9, repo], [10, outside]] as const) assert.deepEqual(change(auto, id, root), { asks: [], answer: "accept" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a thread it had is resumed; one it can't find ends the turn saying so, for the next to start fresh; a failed turn says why", () => {
  const s = server({ resumeId: "thr_old" });
  s.say({ id: 0, result: {} });
  assert.deepEqual([s.last().method, s.last().params], ["thread/resume", { threadId: "thr_old", cwd: "/work/repo" }]);
  const lost = s.say({ id: s.last().id, error: { code: -32600, message: "thread thr_old not found" } });
  assert.equal(lost.at(-1)!.kind, "done");
  assert.match((lost.at(-1) as { error?: string }).error ?? "", /thread\/resume failed/);
  assert.match(codex.explain((lost.at(-1) as { error: string }).error), /couldn't find its earlier conversation/);

  const f = opened();
  const failed = f.notify("turn/completed", { threadId: "thr_1", turn: { id: "t", status: "failed", error: { message: "The model is overloaded" } } });
  assert.deepEqual(failed.at(-1), { kind: "done", error: "The model is overloaded" });
  assert.deepEqual(f.notify("error", { threadId: "thr_1", turnId: "t", error: { message: "late" }, willRetry: false }), [], "nothing after it is over");
});

test("a Codex kept from the last turn is not initialized again: its open thread only gets the turn", () => {
  const kept: AcpKept = { caps: {}, sessionId: "thr_1", res: { tokenTotals: { input: 2200, cached: 1300, output: 80 } } };
  const sent: Record<string, any>[] = [];
  const parse = codex.parser({ prompt: "Next", resumeId: "thr_1", mode: "full", system: "", withSystem: false }, { cwd: "/w", write: (l) => void sent.push(JSON.parse(l)), end: () => {}, kept });
  assert.deepEqual(sent.map((m) => m.method), ["turn/start"], "no initialize, no thread/resume");
  assert.deepEqual([sent[0]!.params.threadId, sent[0]!.params.input[0].text], ["thr_1", "Next"]);
  // Only this turn's tokens, from where the thread's count stood as the last one ended.
  parse(JSON.stringify({ method: "thread/tokenUsage/updated", params: { threadId: "thr_1", turnId: "t2", tokenUsage: { last: {}, total: { inputTokens: 2700, cachedInputTokens: 1700, outputTokens: 100 } } } }));
  const end = parse(JSON.stringify({ method: "turn/completed", params: { threadId: "thr_1", turn: { id: "t2", status: "completed" } } }));
  assert.deepEqual(end, [{ kind: "usage", input: 100, cached: 400, output: 20 }, { kind: "done" }]);
  assert.deepEqual(kept.res!.tokenTotals, { input: 2700, cached: 1700, output: 100 });

  // A thread opened before anybody asked is the first new turn's, said as it starts.
  const fresh: AcpKept = { caps: {}, sessionId: "thr_new", res: {}, fresh: true };
  const d: Record<string, any>[] = [];
  const p = codex.parser({ prompt: "First", resumeId: null, mode: "edits", system: "Note" }, { cwd: "/w", write: (l) => void d.push(JSON.parse(l)), end: () => {}, kept: fresh });
  assert.deepEqual(d.map((m) => m.method), ["turn/start"]);
  assert.deepEqual(p(JSON.stringify({ method: "turn/started", params: { threadId: "thr_new", turn: { id: "t" } } })), [{ kind: "session", id: "thr_new" }]);
  assert.equal(fresh.fresh, false, "taken once");

  // One whose thread isn't open in it resumes it, still without initializing.
  const bare: AcpKept = { caps: {} };
  const e: Record<string, any>[] = [];
  codex.parser({ prompt: "Go", resumeId: "thr_old", mode: "edits", system: "" }, { cwd: "/w", write: (l) => void e.push(JSON.parse(l)), end: () => {}, kept: bare });
  assert.deepEqual(e.map((m) => m.method), ["thread/resume"]);
});

const FAKE_SERVER = `import { createInterface } from "node:readline";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let inits = 0, threads = 0, initialized = 0, turns = 0;
createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") (inits++, out({ id: m.id, result: { userAgent: "fake" } }));
  else if (m.method === "initialized") initialized++;
  else if (m.method === "thread/start") {
    threads++;
    out({ method: "thread/started", params: { thread: { id: "thr_" + threads } } });
    out({ id: m.id, result: { thread: { id: "thr_" + threads } } });
  } else if (m.method === "thread/resume") out({ id: m.id, result: { thread: { id: m.params.threadId } } });
  else if (m.method === "turn/start") {
    turns++;
    out({ id: m.id, result: { turn: { id: "turn_" + turns, status: "inProgress" } } });
    out({ method: "turn/started", params: { threadId: m.params.threadId, turn: { id: "turn_" + turns } } });
    out({ method: "item/agentMessage/delta", params: { threadId: m.params.threadId, turnId: "turn_" + turns, itemId: "m", delta: "pid " + process.pid + " inits " + inits + " initialized " + initialized + " threads " + threads } });
    out({ method: "turn/completed", params: { threadId: m.params.threadId, turn: { id: "turn_" + turns, status: "completed" } } });
  }
});
`;

test("WarmAcp speaking Codex: one process for every turn, its thread open before the first, initialized once", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-codex-"));
  const warm = new WarmAcp(10_000);
  t.after(async () => {
    warm.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const fake = path.join(dir, "codex-app.mjs");
  await writeFile(fake, FAKE_SERVER);
  const spec = (resumeId: string | null): TurnSpec => ({ prompt: "Hi", resumeId, mode: "full", system: "", withSystem: false });
  const how = (resumeId: string | null) => ({ command: process.execPath, args: [fake], opts: { cwd: dir }, init: codex.stdin(spec(resumeId)), resumeId, dialect: "codex" as const });
  const turn = async (resumeId: string | null) => {
    const taken = await warm.take(how(resumeId));
    assert.ok(taken, "the kept Codex takes the turn");
    const outs: AdapterOut[] = [];
    const parse = codex.parser(spec(resumeId), { cwd: dir, write: (l) => void taken.child.stdin!.write(l), end: () => void taken.child.stdin!.end(), kept: taken.kept });
    createInterface({ input: taken.child.stdout! }).on("line", (l) => outs.push(...parse(l)));
    await new Promise((r) => taken.child.on("close", r));
    return outs;
  };
  warm.prepare(how(null));
  const first = await turn(null);
  assert.deepEqual(first.find((o) => o.kind === "session"), { kind: "session", id: "thr_1" });
  const said = (outs: AdapterOut[]) => (outs.find((o) => o.kind === "delta") as { text: string }).text;
  assert.match(said(first), /inits 1 initialized 1 threads 1$/);
  assert.equal(first.at(-1)!.kind, "done");
  const second = await turn("thr_1");
  assert.equal(said(second), said(first), "the same process, initialized once, with the same thread");
  assert.ok(!second.some((o) => o.kind === "session"));
  assert.equal(warm.unsupported, false);
});

test("a Codex too old for an app-server is known at once, and its turns run the old way", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-codex-old-"));
  const warm = new WarmAcp(10_000);
  t.after(async () => {
    warm.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const old = path.join(dir, "codex-old.mjs");
  await writeFile(old, `process.stderr.write("error: unrecognized subcommand 'app-server'\\n"); process.exit(2);\n`);
  const spec: TurnSpec = { prompt: "Hi", resumeId: null, mode: "full", system: "", withSystem: false };
  const taken = await warm.take({ command: process.execPath, args: [old], opts: { cwd: dir }, init: codex.stdin(spec), resumeId: null, dialect: "codex" });
  assert.equal(taken, null);
  assert.equal(warm.unsupported, true);
  assert.deepEqual(codexExec.args(spec).slice(0, 2), ["exec", "--json"], "the old way is still here for it");
});
