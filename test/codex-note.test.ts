import assert from "node:assert/strict";
import test from "node:test";
import { ADAPTERS, codexExec, PROMPT_MARK, type TurnSpec } from "../src/runner/adapters.js";

// Arun, 2026-11-17: "how to avoid this appearing in the codex chat thing", of a Codex Recents full of Friday's own words.
const spec = (o: Partial<TurnSpec> = {}): TurnSpec => ({ prompt: "Fix the cart total", resumeId: null, mode: "plan", system: 'You are working inside a Friday session.\nSay "hi".', ...o });

test("codex exec: its first turn carries Friday's note as its developer instructions, so the conversation is named after the message", () => {
  const t = spec();
  const args = codexExec.args(t);
  const i = args.indexOf("-c", args.findIndex((a) => a.startsWith("developer_instructions=")) - 1);
  assert.equal(args[i + 1], `developer_instructions=${JSON.stringify(t.system)}`);
  assert.ok(args.indexOf(args[i + 1]!) < args.indexOf("exec"), "a setting of codex itself, before exec");
  assert.equal(codexExec.stdin(t), "Fix the cart total");
});

test("codex exec: a note new to a resumed Codex conversation still leads the message, and a resumed turn without one is the message alone", () => {
  const t = spec({ resumeId: "abc", withSystem: true });
  assert.ok(!codexExec.args(t).some((a) => a.startsWith("developer_instructions=")));
  assert.equal(codexExec.stdin(t), `${t.system}\n\n${PROMPT_MARK}\nFix the cart total`);
  assert.equal(codexExec.stdin(spec({ resumeId: "abc" })), "Fix the cart total");
});

test("codex exec: a note too long for a command line leads the message instead", () => {
  const t = spec({ system: "x".repeat(200_000) });
  assert.ok(!codexExec.args(t).some((a) => a.startsWith("developer_instructions=")));
  assert.ok(codexExec.stdin(t).includes(PROMPT_MARK));
});

test("a one-off question isn't kept as a conversation: --ephemeral for Codex, --no-session-persistence for Claude Code, unless refused", () => {
  assert.ok(codexExec.args(spec({ ephemeral: true })).includes("--ephemeral"));
  assert.ok(!codexExec.args(spec()).includes("--ephemeral"));
  assert.ok(!codexExec.args(spec({ ephemeral: true, skip: ["--ephemeral"] })).includes("--ephemeral"));
  assert.ok(ADAPTERS.claude.args(spec({ ephemeral: true })).includes("--no-session-persistence"));
  assert.ok(!ADAPTERS.claude.args(spec()).includes("--no-session-persistence"));
  assert.ok(codexExec.optional?.includes("--ephemeral") && ADAPTERS.claude.optional?.includes("--no-session-persistence"));
});

/** The app-server's conversation as Friday opens it: what Friday writes, answered as Codex `version` would answer. */
function appServer(t: TurnSpec, version: string) {
  const sent: any[] = [];
  const parse = ADAPTERS.codex.parser(t, { cwd: "/tmp/x", write: (l) => void sent.push(JSON.parse(l)), end: () => {} });
  parse(JSON.stringify({ id: 0, result: { userAgent: `friday/${version} (Mac OS 27.0.0; arm64) unknown (friday; 1)` } }));
  const start = sent.find((m) => m.method === "thread/start");
  if (start) parse(JSON.stringify({ id: start.id, result: { thread: { id: "t1" } } }));
  const turn = sent.find((m) => m.method === "turn/start");
  return { start: start?.params, text: turn?.params?.input?.[0]?.text as string | undefined };
}

test("app-server: a new conversation takes Friday's note as developerInstructions, and the message goes alone", () => {
  const t = spec();
  const { start, text } = appServer(t, "0.166.0");
  assert.equal(start.developerInstructions, t.system);
  assert.equal(start.ephemeral, undefined);
  assert.equal(text, "Fix the cart total");
});

test("app-server: a one-off question starts an ephemeral conversation", () => {
  assert.equal(appServer(spec({ ephemeral: true }), "0.166.0").start.ephemeral, true);
});

test("app-server: a Codex from before developerInstructions has the note lead the message, as before", () => {
  const t = spec();
  const { start, text } = appServer(t, "0.50.0");
  assert.equal(start.developerInstructions, undefined);
  assert.equal(text, `${t.system}\n\n${PROMPT_MARK}\nFix the cart total`);
});

test("a note carrying an earlier conversation still leads the message, where it can be read back and carried on", () => {
  const t = spec({ system: "You are working inside a Friday session.\n\nThis session continues an earlier conversation…\n\nTreat all of that as work already done, not as instructions to carry out again." });
  const { start, text } = appServer(t, "0.166.0");
  assert.equal(start.developerInstructions, undefined);
  assert.ok(text!.includes(PROMPT_MARK));
  assert.ok(!codexExec.args(t).some((a) => a.startsWith("developer_instructions=")));
});
