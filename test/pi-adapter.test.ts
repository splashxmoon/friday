import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ADAPTERS, pi, piGate, piSignedIn, type AdapterOut, type TurnSpec } from "../src/runner/adapters.js";
import { EFFORT_LEVELS, TOOL_INFO } from "../src/types.js";
import { skillHomes } from "../src/runner/tool-commands.js";

/**
 * Pi over its RPC mode (runner/adapters.ts pi), checked against real `pi --mode rpc` sessions (0.73.1) recorded with a stand-in
 * model (test/fixtures/pi): what it said is played back line by line, and what Friday writes back is kept to look at.
 */
const DIR = path.join(import.meta.dirname, "fixtures", "pi");
const lines = (name: string) => readFileSync(path.join(DIR, `${name}.ndjson`), "utf8").trim().split("\n");
const spec = (extra: Partial<TurnSpec> = {}): TurnSpec => ({ prompt: "Do the thing", resumeId: null, mode: "edits", system: "Standing note", ...extra });

function play(name: string, t: Partial<TurnSpec>, during?: (got: AdapterOut[], line: string) => void) {
  const writes: Record<string, any>[] = [];
  let ended = false;
  const parse = pi.parser(spec(t), { cwd: "/work", write: (l) => writes.push(JSON.parse(l)), end: () => (ended = true) });
  const outs: AdapterOut[] = [];
  for (const l of lines(name)) {
    const got = parse(l);
    outs.push(...got);
    during?.(got, l);
  }
  return { outs, writes, ended: () => ended, parse };
}
/** One gate question, as Pi's extension UI asks it. */
const gateLine = (id: string, tool: string, input: Record<string, unknown>) => JSON.stringify({ type: "extension_ui_request", id, method: "input", title: "friday:tool", placeholder: JSON.stringify({ id: `call_${id}`, tool, input }) });
function gated(t: Partial<TurnSpec>, tool: string, input: Record<string, unknown>) {
  const writes: Record<string, any>[] = [];
  const parse = pi.parser(spec(t), { cwd: "/work", write: (l) => writes.push(JSON.parse(l)), end: () => {} });
  parse(JSON.stringify({ type: "agent_start" }));
  const outs = parse(gateLine("q1", tool, input));
  return { outs, writes, parse };
}
const said = (outs: AdapterOut[], channel: "text" | "reasoning") => outs.filter((o): o is Extract<AdapterOut, { kind: "delta" }> => o.kind === "delta" && o.channel === channel).map((o) => o.text).join("");
const has = (args: string[], a: string, b?: string) => args.some((x, i) => x === a && (b === undefined || args[i + 1] === b));

test("Pi is one of Friday's coding tools, installed from npm and started in its RPC mode", () => {
  assert.equal(ADAPTERS.pi, pi);
  assert.equal(TOOL_INFO.pi.install.npm, "@mariozechner/pi-coding-agent");
  assert.deepEqual(EFFORT_LEVELS.pi, ["low", "medium", "high", "xhigh"]);
  assert.match(skillHomes("/home/me").pi!, /\.pi[/\\]agent[/\\]skills$/);
  const full = pi.args(spec({ mode: "full" }));
  assert.deepEqual(full.slice(0, 2), ["--mode", "rpc"]);
  assert.ok(!has(full, "-e") && !has(full, "--tools"), "your own Auto: Pi as it is on its own, no gate");
  const manual = pi.args(spec({ mode: "edits" }));
  assert.ok(has(manual, "-e", piGate()), "Manual: the gate asks before each tool call");
  assert.ok(!has(manual, "--tools"), "Manual keeps all of its tools");
  const plan = pi.args(spec({ mode: "plan" }));
  assert.ok(has(plan, "--tools", "read,grep,find,ls,bash") && has(plan, "-e", piGate()), "Plan: reading tools and bash, gated");
  assert.ok(has(pi.args(spec({ mode: "full", guarded: true })), "-e"), "a teammate's Auto is gated, for the go-ahead list");
});

test("its model and thinking are flags, Max and Ultra think as hard as Pi can", () => {
  const t = pi.args(spec({ model: "anthropic/claude-sonnet-4-5", effort: "high" }));
  assert.ok(has(t, "--model", "anthropic/claude-sonnet-4-5") && has(t, "--thinking", "high"));
  assert.ok(has(pi.args(spec({ effort: "max" })), "--thinking", "xhigh"));
  assert.ok(has(pi.args(spec({ effort: "ultra" })), "--thinking", "xhigh"));
  assert.ok(!pi.args(spec()).some((a) => a === "--thinking" || a === "--model"), "nothing set: Pi's own defaults");
});

test("a conversation is carried on by its session file while the file is there, and a question keeps none", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-sess-"));
  try {
    const file = path.join(dir, "2026-11-20T12-00-00-000Z_abc.jsonl");
    await writeFile(file, "{}\n");
    assert.ok(has(pi.args(spec({ resumeId: file })), "--session", file));
    assert.ok(has(pi.args(spec({ resumeId: file, fork: true })), "--fork", file), "a fork carries on from a copy");
    assert.ok(!has(pi.args(spec({ resumeId: path.join(dir, "gone.jsonl") })), "--session"), "a file gone: a new conversation, not a failed start");
    assert.ok(!has(pi.args(spec({ resumeId: "01a1f8d3-b8f1" })), "--session"), "not a path of its own: a new conversation");
    const q = pi.args(spec({ resumeId: file, ephemeral: true }));
    assert.ok(has(q, "--no-session") && !has(q, "--session"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("its first lines ask what it has, then give the instruction with the standing note and any picture", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-img-"));
  try {
    const png = path.join(dir, "shot.png");
    await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const sent = pi.stdin(spec({ files: [png, path.join(dir, "notes.txt")] })).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(sent.map((s) => s.type), ["get_state", "get_available_models", "get_commands", "prompt"]);
    const prompt = sent[3];
    assert.match(prompt.message, /Standing note[\s\S]*Do the thing/);
    assert.equal(prompt.images.length, 1, "the picture handed over, the text file only named");
    assert.equal(prompt.images[0].mimeType, "image/png");
    assert.doesNotMatch(JSON.parse(pi.stdin(spec({ resumeId: "/x.jsonl", withSystem: false })).trim().split("\n")[3]).message, /Standing note/, "told once");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a turn: its conversation kept, its models and commands listed, its thinking and words streamed, usage, over", () => {
  const { outs, ended } = play("simple", { mode: "full" });
  const session = outs.find((o): o is Extract<AdapterOut, { kind: "session" }> => o.kind === "session");
  assert.match(session!.id, /^\/home\/me\/\.pi\/agent\/sessions\/.*\.jsonl$/, "its session file, for --session next turn");
  const models = outs.find((o): o is Extract<AdapterOut, { kind: "models" }> => o.kind === "models");
  assert.deepEqual(models!.list, [
    { id: "standin/stand-in", label: "Stand-in" },
    { id: "standin/stand-in-2", label: "Stand-in Two" },
  ]);
  const commands = outs.find((o): o is Extract<AdapterOut, { kind: "commands" }> => o.kind === "commands");
  assert.deepEqual(commands!.list, [
    { name: "skill:release-notes", description: "Write release notes from the merged pull requests." },
    { name: "fix-tests", description: "Fix failing tests" },
  ]);
  assert.equal(said(outs, "reasoning"), "Considering it. Done thinking.");
  assert.equal(said(outs, "text"), "Hello from the stand-in.");
  const message = outs.find((o): o is Extract<AdapterOut, { kind: "message" }> => o.kind === "message");
  assert.equal(message!.text, "Hello from the stand-in.");
  assert.equal(message!.reasoning, "Considering it. Done thinking.");
  const u = outs.find((o): o is Extract<AdapterOut, { kind: "usage" }> => o.kind === "usage")!;
  assert.deepEqual([u.input, u.cached, u.output, u.context, u.window, u.model], [100, 20, 30, 150, 100000, "standin/stand-in"]);
  assert.deepEqual(outs.at(-1), { kind: "done" });
  assert.ok(ended(), "stdin closed once the turn is over, so Pi exits");
});

test("a question run in the background keeps no conversation of Pi's", () => {
  const { outs } = play("simple", { mode: "full", ephemeral: true });
  assert.ok(!outs.some((o) => o.kind === "session"));
});

test("in Manual a command is put to a person mid-turn, and runs once they say yes", () => {
  let asked: Extract<AdapterOut, { kind: "ask" }> | undefined;
  const { outs, writes } = play("bash_allowed", { mode: "edits", ask: true }, (got) => {
    for (const o of got) if (o.kind === "ask") (asked = o).reply!(true);
  });
  assert.equal(asked?.tool, "shell");
  assert.deepEqual(asked?.input, { command: "echo hi-from-bash" });
  const answer = writes.find((w) => w.type === "extension_ui_response")!;
  assert.equal(answer.value, "yes");
  const call = outs.find((o): o is Extract<AdapterOut, { kind: "message" }> => o.kind === "message" && o.toolCalls.length > 0)!;
  assert.equal(call.toolCalls[0]!.name, "shell");
  const result = outs.find((o): o is Extract<AdapterOut, { kind: "result" }> => o.kind === "result")!;
  assert.deepEqual([result.name, result.output, result.isError], ["shell", "hi-from-bash\n", false]);
  assert.deepEqual(outs.at(-1), { kind: "done" });
});

test("a no goes back as Pi's refusal, and the turn carries on", () => {
  const { outs, writes } = play("bash_refused", { mode: "edits", ask: true }, (got) => {
    for (const o of got) if (o.kind === "ask") o.reply!(false);
  });
  assert.match(writes.find((w) => w.type === "extension_ui_response")!.value, /said no/);
  const result = outs.find((o): o is Extract<AdapterOut, { kind: "result" }> => o.kind === "result")!;
  assert.equal(result.isError, true);
  assert.deepEqual(outs.at(-1), { kind: "done" });
});

test("Manual with nobody to ask refuses a command and asks once the turn is over", () => {
  const { outs, writes, parse } = gated({ mode: "edits" }, "bash", { command: "rm -rf build" });
  assert.deepEqual(outs, []);
  assert.match(writes[0]!.value, /go-ahead/);
  const end = parse(JSON.stringify({ type: "agent_end", messages: [] }));
  assert.deepEqual(end.find((o) => o.kind === "blocked"), { kind: "blocked", scope: "commands", items: ["rm -rf build"] });
});

test("what Manual lets through unasked: reading anywhere, changes inside the folder and the ones beside it", () => {
  for (const [tool, input] of [
    ["read", { path: "/etc/hosts" }],
    ["grep", { pattern: "x" }],
    ["edit", { path: "src/a.ts", oldText: "a", newText: "b" }],
    ["write", { path: "/work/docs/b.md", content: "x" }],
    ["write", { path: "/beside/c.md", content: "x" }],
  ] as const) {
    const { outs, writes } = gated({ mode: "edits", ask: true, dirs: ["/beside"] }, tool, input);
    assert.deepEqual(outs, [], `${tool} not asked`);
    assert.equal(writes[0]!.value, "yes", `${tool} ${JSON.stringify(input)}`);
  }
  const outside = gated({ mode: "edits", ask: true }, "write", { path: "/etc/passwd", content: "x" });
  assert.equal(outside.outs[0]?.kind, "ask", "a change outside the folder is put to a person");
  const granted = gated({ mode: "edits", grant: { scope: "commands", items: ["npm test"] } }, "bash", { command: "npm test" });
  assert.equal(granted.writes[0]!.value, "yes", "a command said yes to before runs");
});

test("Plan reads, never changes a file, and puts its commands to a person", () => {
  assert.equal(gated({ mode: "plan", ask: true }, "read", { path: "a.ts" }).writes[0]!.value, "yes");
  const write = gated({ mode: "plan", ask: true }, "write", { path: "a.ts", content: "x" });
  assert.deepEqual(write.outs, []);
  assert.match(write.writes[0]!.value, /Plan mode doesn't change files/);
  assert.equal(gated({ mode: "plan", ask: true }, "bash", { command: "ls" }).outs[0]?.kind, "ask");
});

test("a teammate's Auto puts every call to the runner, which holds it to the go-ahead list", () => {
  const { outs } = gated({ mode: "full", guarded: true, ask: true }, "read", { path: "a.ts" });
  const ask = outs[0] as Extract<AdapterOut, { kind: "ask" }>;
  assert.equal(ask.kind, "ask");
  assert.equal(ask.tool, "read");
});

test("a gate question Friday can't read is refused, never let through", () => {
  const writes: Record<string, any>[] = [];
  const parse = pi.parser(spec(), { cwd: "/work", write: (l) => writes.push(JSON.parse(l)), end: () => {} });
  parse(JSON.stringify({ type: "extension_ui_request", id: "q", method: "input", title: "friday:tool", placeholder: "not json" }));
  assert.notEqual(writes[0]!.value, "yes");
});

test("a yes-or-no from one of the person's own Pi extensions is theirs, and anything else is passed by", () => {
  const writes: Record<string, any>[] = [];
  const parse = pi.parser(spec({ mode: "edits", ask: true }), { cwd: "/work", write: (l) => writes.push(JSON.parse(l)), end: () => {} });
  const outs = parse(JSON.stringify({ type: "extension_ui_request", id: "c1", method: "confirm", title: "Dangerous!", message: "Allow rm -rf?" }));
  const ask = outs[0] as Extract<AdapterOut, { kind: "ask" }>;
  assert.equal(ask.tool, "Dangerous!");
  ask.reply!(true);
  assert.deepEqual(writes.at(-1), { type: "extension_ui_response", id: "c1", confirmed: true });
  parse(JSON.stringify({ type: "extension_ui_request", id: "s1", method: "select", title: "Pick", options: ["a", "b"] }));
  assert.deepEqual(writes.at(-1), { type: "extension_ui_response", id: "s1", cancelled: true });
  const auto: Record<string, any>[] = [];
  pi.parser(spec({ mode: "full" }), { cwd: "/work", write: (l) => auto.push(JSON.parse(l)), end: () => {} })(JSON.stringify({ type: "extension_ui_request", id: "c2", method: "confirm", title: "Sure?" }));
  assert.equal(auto[0]!.confirmed, true, "Auto says yes, as a person who always does");
});

test("stopped from Friday: abort is sent, and the turn ends as stopped, not failed", () => {
  const { outs, writes, parse } = play("aborted", { mode: "full" });
  assert.deepEqual(outs.at(-1), { kind: "done" });
  const p2: Record<string, any>[] = [];
  const q = pi.parser(spec(), { cwd: "/work", write: (l) => p2.push(JSON.parse(l)), end: () => {} });
  q.cancel!();
  assert.deepEqual(p2, [{ type: "abort" }]);
  void writes;
  void parse;
});

test("a message for the running turn goes as Pi's steer, and waits once the turn is over", async () => {
  const writes: Record<string, any>[] = [];
  const parse = pi.parser(spec(), { cwd: "/work", write: (l) => writes.push(JSON.parse(l)), end: () => {} });
  assert.equal(await parse.steer!("too early"), false, "before it began");
  parse(JSON.stringify({ type: "agent_start" }));
  assert.equal(await parse.steer!("Use the other file"), true);
  assert.deepEqual(writes.at(-1), { type: "steer", message: "Use the other file" });
  parse(JSON.stringify({ type: "agent_end", messages: [] }));
  assert.equal(await parse.steer!("late"), false);
});

test("signed out: the turn ends on Pi's own words, said as what to do", () => {
  const { outs } = play("signed_out", { mode: "full" });
  const done = outs.at(-1) as Extract<AdapterOut, { kind: "done" }>;
  assert.match(done.error!, /No API key found/);
  assert.match(pi.explain(done.error!), /type \/login/);
});

test("signed in: a provider's key, a kept /login or providers of your own; never what the sign-in holds", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "pi-home-"));
  const keep = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  const others = Object.keys(process.env).filter((k) => /_API_KEY$|^HF_TOKEN$|^AWS_PROFILE$|^GOOGLE_CLOUD_PROJECT$/.test(k));
  const saved = Object.fromEntries(others.map((k) => [k, process.env[k]]));
  for (const k of [...others, "PI_CODING_AGENT_DIR"]) delete process.env[k];
  try {
    const dir = path.join(home, ".pi", "agent");
    assert.equal(await piSignedIn(home), false, "never set up");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "auth.json"), "{}");
    assert.equal(await piSignedIn(home), false, "its empty sign-in file");
    await writeFile(path.join(dir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth" } }));
    assert.equal(await piSignedIn(home), true, "signed in with /login");
    await writeFile(path.join(dir, "auth.json"), "{}");
    await writeFile(path.join(dir, "models.json"), "{}");
    assert.equal(await piSignedIn(home), true, "providers of its own");
    await rm(path.join(dir, "models.json"));
    process.env.ANTHROPIC_API_KEY = "x";
    assert.equal(await piSignedIn(home), true, "a provider's key");
  } finally {
    for (const [k, v] of Object.entries({ ...saved, ...keep })) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    await rm(home, { recursive: true, force: true });
  }
});

test("the gate is written once into Friday's folder, and asks Friday about every tool call", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "pi-gate-"));
  try {
    const file = piGate(home);
    assert.ok(file.startsWith(path.join(home, ".friday", "pi")));
    const src = await readFile(file, "utf8");
    assert.match(src, /pi\.on\("tool_call"/);
    assert.match(src, /friday:tool/);
    assert.match(src, /said !== "yes"/, "anything but a yes blocks the call");
    assert.equal(piGate(home), file, "the same file for the same gate");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("its models before its first turn here, named as its RPC mode names them", async () => {
  const { piModelList } = await import("../src/runner/adapters.js");
  const data = JSON.parse(lines("simple").find((l) => l.includes('"id":"models"'))!).data;
  assert.deepEqual(piModelList(data), [
    { id: "standin/stand-in", label: "Stand-in" },
    { id: "standin/stand-in-2", label: "Stand-in Two" },
  ]);
  const two = piModelList({ models: [{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic" }, { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", provider: "openrouter" }] });
  assert.deepEqual(two.map((m) => m.label), ["Claude Sonnet 4.5 · anthropic", "Claude Sonnet 4.5 · openrouter"], "the same name from two providers says whose");
  assert.deepEqual(piModelList({ models: [] }), [], "signed out: none");
});

test("a reply holding a line separator still ends its turn: the line Node's reader cut in two is put back together", () => {
  const outs: AdapterOut[] = [];
  const parse = pi.parser(spec({ mode: "full" }), { cwd: "/work", write: () => {}, end: () => {} });
  const said = "First\u2028second\u2029third";
  const end = JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: said }], stopReason: "stop" }] });
  outs.push(...parse(JSON.stringify({ type: "agent_start" })));
  outs.push(...parse(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: said }], usage: {} } })));
  // As readline hands it over: three lines where Pi wrote one.
  for (const piece of end.split(/[\u2028\u2029]/)) outs.push(...parse(piece));
  assert.deepEqual(outs.at(-1), { kind: "done" });
});

test("a line that isn't the rest of a cut one is read on its own", () => {
  const parse = pi.parser(spec({ mode: "full" }), { cwd: "/work", write: () => {}, end: () => {} });
  parse(JSON.stringify({ type: "agent_start" }));
  assert.deepEqual(parse("{not json from an extension"), []);
  assert.deepEqual(parse(JSON.stringify({ type: "agent_end", messages: [] })).at(-1), { kind: "done" });
});
