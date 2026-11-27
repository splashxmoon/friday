// Aider prints plain text, not an event stream: these are written from their documented output, not live recordings.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ADAPTERS, aiderLine, plainText, type AdapterOut, type TurnSpec } from "../src/runner/adapters.js";
import { installStep } from "../src/client/engines.js";
import { ENGINE_MODEL_INFO, ENGINE_NAMES, ENGINE_TOOLS, TOOL_INFO } from "../src/types.js";

const run = (parse: ReturnType<typeof plainText>, lines: string[], code: number | null = 0): AdapterOut[] => [...lines.flatMap((l) => parse(l)), ...(parse.end?.(code) ?? [])];
const said = (outs: AdapterOut[]) => outs.filter((o) => o.kind === "delta" && o.channel === "text").map((o) => (o.kind === "delta" ? o.text : "")).join("");

test("a plain-text tool streams its lines, keeps them as its answer and is done when it exits cleanly", () => {
  const outs = run(plainText(), ["", "Hello.", "", "Second paragraph.\r", ""]);
  assert.equal(said(outs), "Hello.\n\nSecond paragraph.\n\n");
  assert.deepEqual(outs.slice(-2), [{ kind: "message", text: "Hello.\n\nSecond paragraph.", toolCalls: [] }, { kind: "done" }]);
});

test("a plain-text tool that exits with an error is not done, so the runner says what it printed on stderr", () => {
  const outs = run(plainText(), ["partial"], 1);
  assert.ok(!outs.some((o) => o.kind === "done"));
  assert.deepEqual(outs.at(-1), { kind: "message", text: "partial", toolCalls: [] });
});

test("Aider's token line is usage, its banner is set aside, and each file it changed is an edit card", () => {
  let n = 0;
  const id = () => `a-${++n}`;
  assert.deepEqual(aiderLine("Tokens: 2.6k sent, 1.5k cache write, 92 received. Cost: $0.01 message, $0.01 session.", id)?.[0], { kind: "usage", input: 2600, cached: 0, output: 92, cacheWrite: 1500 });
  assert.deepEqual(aiderLine("Tokens: 4.5k sent, 3.2k cache hit, 245 received.", id)?.[0], { kind: "usage", input: 4500, cached: 3200, output: 245 });
  assert.deepEqual(aiderLine("Aider v0.86.1", id), [{ kind: "delta", text: "Aider v0.86.1\n", channel: "reasoning" }]);
  const edit = aiderLine("Applied edit to src/app.py", id)!;
  assert.equal(edit[0]!.kind, "message");
  assert.equal(edit[0]!.kind === "message" && edit[0]!.toolCalls[0]!.name, "edit");
  assert.deepEqual(edit[1], { kind: "result", callId: "a-1", name: "edit", output: "Edited src/app.py", isError: false });
  assert.equal(aiderLine("Just some words.", id), null);
});

test("an Aider turn: the answer before an edit is kept as a message, then the card, then its conversation id", () => {
  const aider = ADAPTERS.aider;
  const turn: TurnSpec = { prompt: "Fix the bug", system: "Be brief.", resumeId: null, mode: "full" };
  const args = aider.args(turn);
  const history = args[args.indexOf("--chat-history-file") + 1]!;
  assert.ok(path.isAbsolute(history) && history.endsWith(".md"));
  assert.ok(!args.includes("--restore-chat-history"));
  for (const flag of ["--yes-always", "--no-pretty", "--no-auto-commits", "--no-gitignore"]) assert.ok(args.includes(flag), flag);
  assert.match(args[args.indexOf("--message") + 1]!, /Be brief\.[\s\S]*Fix the bug$/);
  const outs = run(aider.parser(turn), ["Aider v0.86.1", "Main model: sonnet", "I'll fix it.", "Applied edit to app.py", "Done.", "Tokens: 1k sent, 50 received."]);
  assert.deepEqual(
    outs.map((o) => o.kind),
    ["delta", "delta", "delta", "message", "message", "result", "delta", "usage", "message", "session", "done"],
  );
  assert.deepEqual(outs.at(-2), { kind: "session", id: history });
});

test("Aider carries on a conversation from its history file, and holds Plan with its ask mode", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "friday-aider-"));
  const history = path.join(dir, "kept.md");
  writeFileSync(history, "# aider chat\n");
  const args = ADAPTERS.aider.args({ prompt: "and now?", system: "", resumeId: history, mode: "plan", model: "sonnet", effort: "max" });
  assert.equal(args[args.indexOf("--chat-history-file") + 1], history);
  assert.ok(args.includes("--restore-chat-history"));
  assert.deepEqual(args.slice(args.indexOf("--chat-mode"), args.indexOf("--chat-mode") + 2), ["--chat-mode", "ask"]);
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "sonnet"]);
  assert.deepEqual(args.slice(args.indexOf("--reasoning-effort"), args.indexOf("--reasoning-effort") + 2), ["--reasoning-effort", "high"]);
  // An id that isn't one of its history files starts a fresh conversation rather than failing.
  assert.ok(!ADAPTERS.aider.args({ prompt: "x", system: "", resumeId: "nope", mode: "full" }).includes("--restore-chat-history"));
  assert.deepEqual(ADAPTERS.aider.modes, ["full", "plan"]);
  assert.match(ADAPTERS.aider.explain("litellm.AuthenticationError: missing api key"), /API key/);
});

test("Aider is offered by name with its install lines", () => {
  assert.ok(ENGINE_TOOLS.includes("aider"));
  assert.deepEqual(ENGINE_MODEL_INFO.aider, []);
  assert.equal(ENGINE_NAMES.aider, "Aider");
  assert.equal(installStep("aider", "mac").command, TOOL_INFO.aider.install.unix);
  assert.equal(installStep("aider", "windows").command, TOOL_INFO.aider.install.windows);
});
