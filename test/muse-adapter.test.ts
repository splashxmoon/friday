import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ADAPTERS, muse, uuidv7, type AdapterOut, type TurnSpec } from "../src/runner/adapters.js";

/**
 * Muse Code over its session protocol (runner/adapters.ts muse), checked against real `muse serve` sessions recorded by T3 Code
 * (test/fixtures/muse, MIT, see NOTICE). Each recording is played back as the tool's side: Friday's requests are answered with
 * the recorded answers to the same method, its notifications and questions are fed in order, up to the first turn's end.
 */
const DIR = path.join(import.meta.dirname, "fixtures", "muse");
const recorded = existsSync(DIR);

type Frame = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: any; result?: any; error?: any };

function replay(name: string, spec: Partial<TurnSpec>, during?: (outs: AdapterOut[], parser: ReturnType<typeof muse.parser>, writes: Frame[], frame: Frame) => void) {
  const lines = readFileSync(path.join(DIR, `${name}.ndjson`), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string; label?: string; frame?: Frame });
  const writes: Frame[] = [];
  let ended = false;
  const turn = { prompt: "Do the thing", system: "", resumeId: null, mode: "full", ...spec } as TurnSpec;
  const parser = muse.parser(turn, { cwd: "/work", write: (l) => writes.push(JSON.parse(l)), end: () => (ended = true) });
  const outs: AdapterOut[] = [];
  /** Friday's requests not answered yet, by method: the recorded answer to that method goes to the latest one. */
  const answered = new Set<number | string>();
  const ours = (method: string) => (method === "initialize" ? 0 : [...writes].reverse().find((w) => w.method === method && w.id !== undefined && !answered.has(w.id))?.id);
  for (const l of lines) {
    if (ended || l.type !== "emit_inbound" || !l.frame) continue;
    const f = { ...l.frame };
    if (f.id !== undefined && !f.method) {
      const method = (l.label ?? "").replace(/^response:/, "");
      const id = ours(method);
      if (id === undefined) continue;
      answered.add(id);
      f.id = id;
    }
    const got = parser(JSON.stringify(f));
    outs.push(...got);
    during?.(got, parser, writes, f);
  }
  return { outs, writes, ended };
}

test("Muse Code is one of Friday's coding tools, started as `muse serve`", () => {
  assert.equal(ADAPTERS.muse, muse);
  assert.deepEqual(muse.args({ mode: "full" } as TurnSpec), ["serve", "--trust-workspace", "--disable-sandbox"]);
  assert.deepEqual(muse.args({ mode: "edits" } as TurnSpec), ["serve", "--trust-workspace"]);
  const hello = JSON.parse(muse.stdin({} as TurnSpec));
  assert.equal(hello.method, "initialize");
  assert.equal(hello.id, 0);
});

test("a turn: the conversation opened, the instruction given, its words streamed, the turn over", { skip: !recorded }, () => {
  const { outs, writes, ended } = replay("simple", { mode: "full", effort: "high", dirs: ["/work/docs"] });
  assert.ok(writes.some((w) => w.method === "initialized"));
  const start = writes.find((w) => w.method === "session/start")!;
  assert.equal(start.params.workspaceRoot, "/work");
  assert.equal(start.params.approvalMode, "allowAll");
  assert.equal(start.params.permissionProfile, ":unrestricted");
  const turn = writes.find((w) => w.method === "turn/start")!;
  assert.match(turn.params.input[0].text, /Do the thing/);
  assert.equal(turn.params.reasoningEffort, "high");
  assert.deepEqual(turn.params.workspaceRoots, ["/work", "/work/docs"], "the other folders it may work in, beside its own");
  assert.ok(outs.some((o) => o.kind === "session" && o.id === "01a11a6a-bbb5-7000-ad0b-0c9e728406e5"), "the conversation is kept for the next turn");
  const said = outs.filter((o): o is Extract<AdapterOut, { kind: "delta" }> => o.kind === "delta" && o.channel === "text").map((o) => o.text).join("");
  assert.equal(said, "fixture simple ok", "said once: the completed item doesn't repeat the streamed words");
  const message = outs.find((o): o is Extract<AdapterOut, { kind: "message" }> => o.kind === "message");
  assert.equal(message?.text, "fixture simple ok");
  assert.ok(outs.some((o) => o.kind === "usage"));
  assert.deepEqual(outs.at(-1), { kind: "done" });
  assert.ok(ended, "stdin closed once the turn is over");
});

test("in Manual a command is put to a person mid-turn, and the answer goes back as Muse asks for it", { skip: !recorded }, () => {
  let asked = 0;
  const { outs, writes } = replay("muse_permission", { mode: "edits", ask: true }, (got) => {
    for (const o of got) if (o.kind === "ask") (asked++, o.reply!(true));
  });
  assert.equal(writes.find((w) => w.method === "session/start")!.params.approvalMode, "promptUnmatched");
  const ask = outs.find((o): o is Extract<AdapterOut, { kind: "ask" }> => o.kind === "ask")!;
  assert.equal(ask.tool, "shell");
  assert.equal(ask.input.command, "touch muse-approved.txt");
  assert.equal(asked, 1);
  // Acknowledged at once, then decided.
  assert.ok(writes.some((w) => w.id === 1 && w.result && !w.method));
  const decide = writes.find((w) => w.method === "approval/decide")!;
  assert.equal(decide.params.choiceId, "allow_once");
  assert.equal(decide.params.approvalId, "01a11a6d-4730-75f1-bc60-4e5df1a3cdc0");
  assert.deepEqual(decide.params.requirementId, { approvalId: "01a11a6d-4730-75f1-bc60-4e5df1a3cdc0", sourceIndex: 0 });
  // The command, as a step with its output.
  const shell = outs.flatMap((o) => (o.kind === "message" ? o.toolCalls : [])).find((c) => c.name === "shell");
  assert.ok(shell);
  assert.match(JSON.parse(shell.arguments).command, /touch muse-approved\.txt/);
  assert.ok(outs.some((o) => o.kind === "result" && o.callId === shell.id && !o.isError));
  assert.deepEqual(outs.at(-1), { kind: "done" });
});

test("in Manual with nobody to ask, the command is refused and listed for a yes after the turn", { skip: !recorded }, () => {
  const { outs, writes } = replay("muse_permission", { mode: "edits", ask: false });
  assert.equal(writes.find((w) => w.method === "approval/decide")!.params.choiceId, "abort");
  const blocked = outs.find((o): o is Extract<AdapterOut, { kind: "blocked" }> => o.kind === "blocked");
  assert.deepEqual(blocked?.items, ["touch muse-approved.txt"]);
});

test("a subagent it sends off is tracked, back with what it found; its bookkeeping calls are not steps", { skip: !recorded }, () => {
  const { outs } = replay("subagent_v2", { mode: "full" });
  const tasks = outs.filter((o): o is Extract<AdapterOut, { kind: "task" }> => o.kind === "task");
  assert.equal(tasks[0]?.id, "subagent-1");
  assert.equal(tasks[0]?.status, "running");
  assert.ok(tasks[0]?.description);
  assert.deepEqual(tasks.at(-1), { kind: "task", id: "subagent-1", status: "done", summary: "Hello" });
  assert.equal(tasks.length, 2, "started once, back once");
  const names = outs.flatMap((o) => (o.kind === "message" ? o.toolCalls.map((c) => c.name) : []));
  assert.ok(!names.some((n) => /subagent|read/.test(n)), `no subagent_* calls as steps: ${names.join(", ")}`);
});

test("Stop interrupts the turn Muse's way, and the turn ends", { skip: !recorded }, () => {
  let stopped = false;
  const { writes, outs } = replay("turn_interrupt", { mode: "full" }, (_got, parser, _writes, frame) => {
    // Once the turn has begun (its id is known by then): the person presses Stop.
    if (!stopped && frame.method === "turn/started") {
      stopped = true;
      parser.cancel?.();
    }
  });
  const stop = writes.find((w) => w.method === "turn/interrupt")!;
  assert.equal(stop.params.turnId, "01a11a6d-2ee0-7000-be19-f20eda7ce5d5");
  assert.equal(outs.at(-1)?.kind, "done");
});

test("Grok Build is held to Friday's mode on its command line, whatever its own config says", async () => {
  const { grok } = await import("../src/runner/adapters.js");
  assert.deepEqual(grok.args({ mode: "edits" } as TurnSpec), ["--permission-mode", "default", "agent", "stdio"]);
  assert.deepEqual(grok.args({ mode: "plan", model: "grok-code-2" } as TurnSpec), ["--permission-mode", "default", "agent", "-m", "grok-code-2", "stdio"]);
  assert.deepEqual(grok.args({ mode: "full" } as TurnSpec), ["agent", "--always-approve", "stdio"]);
});

// Muse 1.4 (Arun, 2026-10-29: "check if muse works"): every turn sat at "working" until it was stopped.
const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("Muse's command and session ids are UUIDv7, the only kind Muse 1.4 takes, time first", { skip: !recorded }, () => {
  const { writes } = replay("simple", { mode: "full" });
  const asked = writes.filter((w) => w.method && w.id !== undefined && w.id !== 0);
  assert.ok(asked.length >= 2);
  for (const w of asked) assert.match(w.params.commandId, V7, `${w.method}'s commandId`);
  assert.match(writes.find((w) => w.method === "session/start")!.params.sessionId, V7);
  const at = Date.UTC(2026, 9, 29, 22, 0, 0);
  assert.equal(parseInt(uuidv7(at).replace(/-/g, "").slice(0, 12), 16), at, "its first 48 bits are the time");
  assert.notEqual(uuidv7(at), uuidv7(at));
});

test("Muse runs one process a turn, never the kept ACP process, and says whether it is signed in by its allowance", () => {
  assert.equal(muse.perTurn, true, "the kept process answers initialize itself, and Muse's parser waited for that answer forever");
  const status = muse.status as { args: string[]; signedIn?: RegExp };
  assert.deepEqual(status.args, ["usage", "--json"]);
  assert.ok(status.signedIn!.test('{"plan":"free"}'));
  assert.ok(!status.signedIn!.test("muse usage: not logged in: run `muse login` first"));
});
