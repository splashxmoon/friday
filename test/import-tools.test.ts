import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { buildContext } from "../src/agent/context.js";
import { cursorRuleFiles, cursorRuleText, rulesBlock } from "../src/project-rules.js";
import { listCliSessions, readCliTranscript } from "../src/runner/imports.js";
import type { ActorRef, EventBody, SessionEvent } from "../src/types.js";

/**
 * A conversation people had in Claude Code, Codex or Cursor has to reach everyone else in the session the same way, whichever it
 * came from: what was said, without what the tool wrote into it, and with the long ones carrying what they decided.
 */

let home = "";
let cwd = "";
const jsonl = (...recs: unknown[]) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";

before(async () => {
  home = await mkdtemp(path.join(tmpdir(), "friday-import-tools-"));
  cwd = path.join(home, "shop");
  await mkdir(cwd, { recursive: true });
});
after(() => rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

test("Codex: what was said, and not the project's rules or the environment the CLI wrote in as if somebody had", async () => {
  const dir = path.join(home, ".codex", "sessions", "2026", "10", "01");
  await mkdir(dir, { recursive: true });
  const id = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb";
  const msg = (role: string, text: string, kind = role === "assistant" ? "output_text" : "input_text") => ({ type: "response_item", payload: { type: "message", role, content: [{ type: kind, text }] } });
  await writeFile(
    path.join(dir, `rollout-2026-10-01T09-00-00-${id}.jsonl`),
    jsonl(
      { type: "session_meta", payload: { id, cwd } },
      msg("user", "# AGENTS.md instructions for /work/shop\n\n<INSTRUCTIONS>Always use pnpm.</INSTRUCTIONS>"),
      msg("user", "<environment_context>\n  <cwd>/work/shop</cwd>\n</environment_context>"),
      msg("user", "The cart total is wrong when a coupon and a gift card are both applied."),
      { type: "response_item", payload: { type: "reasoning", summary: [] } },
      { type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{}" } },
      msg("assistant", "The coupon is applied after the gift card, so the card is spent on the wrong total. Fixed the order and added a test."),
    ),
  );
  const t = await readCliTranscript({ tool: "codex", id, home });
  assert.equal(t.found, true);
  assert.deepEqual(
    t.turns.map((x) => x.role),
    ["user", "assistant"],
    "the injected instructions and environment are not part of the conversation",
  );
  assert.match(t.turns[0]!.text, /coupon and a gift card/);
  assert.doesNotMatch(JSON.stringify(t.turns), /pnpm|environment_context/);
});

test("Codex: the older rollout shape, with the message at the top level, still reads", async () => {
  const dir = path.join(home, ".codex", "sessions", "2026", "05", "02");
  await mkdir(dir, { recursive: true });
  const id = "cccccccc-1111-2222-3333-dddddddddddd";
  await writeFile(
    path.join(dir, `rollout-2026-05-02T09-00-00-${id}.jsonl`),
    jsonl({ id, cwd, timestamp: "2026-05-02T09:00:00Z" }, { type: "message", role: "user", content: [{ type: "input_text", text: "Rename the helper" }] }, { type: "message", role: "assistant", content: [{ type: "output_text", text: "Renamed it everywhere." }] }),
  );
  const t = await readCliTranscript({ tool: "codex", id, home });
  assert.equal(t.turns.length, 2);
  assert.match(t.turns[1]!.text, /Renamed it everywhere/);
});

test("Cursor: a chat kept as one JSON object, with its messages inside, is read and listed", async () => {
  const dir = path.join(home, ".cursor", "chats", "w1");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "chat-1.json"),
    JSON.stringify({
      chatId: "chat-1",
      cwd,
      title: "Speed up the product page",
      updatedAt: Date.parse("2026-10-02T10:00:00Z"),
      messages: [
        { role: "user", content: "The product page takes four seconds to load." },
        { role: "assistant", content: [{ type: "text", text: "The hero image is 6 MB. Resized it and lazy-loaded the gallery." }] },
        { role: "user", text: "Great, now the same for the cart." },
        { role: "assistant", text: "Done: cart images were already small, so only the script was split." },
      ],
    }),
  );
  const listed = await listCliSessions({ home, tools: ["cursor"] });
  const s = listed.sessions.find((x) => x.id === "chat-1");
  assert.ok(s, "the chat is offered");
  assert.equal(s!.messages, 4, "its messages are counted, not just the one object");
  assert.equal(s!.title, "Speed up the product page");

  const t = await readCliTranscript({ tool: "cursor", id: "chat-1", home });
  assert.equal(t.found, true);
  assert.deepEqual(
    t.turns.map((x) => x.role),
    ["user", "assistant", "user", "assistant"],
  );
  assert.match(t.turns[1]!.text, /hero image is 6 MB/);
  assert.match(t.turns[2]!.text, /same for the cart/);
});

test("Cursor: a chat kept one message to a line is read too", async () => {
  const dir = path.join(home, ".cursor", "chats", "w2");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "chat-2.jsonl"),
    jsonl({ chatId: "chat-2", cwd, title: "Tidy the CSS", updatedAt: 1 }, { role: "user", content: "Tidy the CSS" }, { role: "assistant", content: "Removed 40 unused rules." }),
  );
  const t = await readCliTranscript({ tool: "cursor", id: "chat-2", home });
  assert.equal(t.turns.length, 2);
  assert.match(t.turns[1]!.text, /40 unused rules/);
});

test("Claude Code: what a tool inserted, and what a helper agent said among themselves, is not the conversation", async () => {
  const dir = path.join(home, ".claude", "projects", "-shop");
  await mkdir(dir, { recursive: true });
  const rec = (o: Record<string, unknown>) => ({ cwd, sessionId: "claude-meta", timestamp: new Date().toISOString(), ...o });
  await writeFile(
    path.join(dir, "claude-meta.jsonl"),
    jsonl(
      rec({ type: "user", isMeta: true, message: { role: "user", content: "Caveat: the messages below were generated by the user while running local commands." } }),
      rec({ type: "user", message: { role: "user", content: "Why does checkout hang on a slow card?" } }),
      rec({ type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "(helper) scanning files…" }] } }),
      rec({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "The request has no timeout, so it waits for the bank forever." }] } }),
    ),
  );
  const t = await readCliTranscript({ tool: "claude", id: "claude-meta", home });
  assert.deepEqual(
    t.turns.map((x) => x.role),
    ["user", "assistant"],
  );
  assert.doesNotMatch(JSON.stringify(t.turns), /Caveat|helper/);
});

test("Claude Code: a compacted session brings its own summary of everything before, kept whole and first", async () => {
  const dir = path.join(home, ".claude", "projects", "-shop");
  await mkdir(dir, { recursive: true });
  const rec = (i: number, o: Record<string, unknown>) => JSON.stringify({ cwd, sessionId: "claude-long", timestamp: new Date(1_760_000_000_000 + i).toISOString(), ...o });
  const summary = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion. ${"We decided to key the cart on the shopper, not the session. ".repeat(60)}END-OF-SUMMARY`;
  const rows = [rec(0, { type: "user", message: { role: "user", content: summary } })];
  for (let i = 1; i <= 40; i++) rows.push(rec(i, { type: i % 2 ? "assistant" : "user", message: { role: i % 2 ? "assistant" : "user", content: `step ${i}` } }));
  await writeFile(path.join(dir, "claude-long.jsonl"), rows.join("\n"));
  const t = await readCliTranscript({ tool: "claude", id: "claude-long", home, maxTurns: 6 });
  assert.match(t.turns[0]!.text, /key the cart on the shopper/, "the summary leads, though it is far outside the last six turns");
  assert.match(t.turns[0]!.text, /END-OF-SUMMARY/, "and is not cut at the length an ordinary turn is");
  assert.match(t.turns.at(-1)!.text, /step 40/);
});

test("every tool's imported conversation reaches Friday's agent under that tool's own name", () => {
  const HOST: ActorRef = { id: "u1", name: "Ada", kind: "human" };
  let seq = 0;
  const ev = (body: EventBody, actor: ActorRef = HOST): SessionEvent => ({ seq: ++seq, ts: Date.now(), actor, body });
  for (const [tool, name] of [
    ["claude", "Claude Code"],
    ["codex", "Codex"],
    ["cursor", "Cursor"],
  ] as const) {
    const all = JSON.stringify(buildContext([ev({ type: "session.imported", tool, sourceId: `s-${tool}`, title: "Earlier work", total: 1, turns: [{ role: "user", text: `from ${tool}` }] })]));
    assert.match(all, new RegExp(`earlier ${name} conversation`), tool);
    assert.match(all, new RegExp(`from ${tool}`));
  }
});

test("Cursor's rules are read as standing instructions, with when they apply", () => {
  const listing = ["12 files under .cursor/rules:", ".cursor/rules/style.mdc", ".cursor/rules/notes.txt", ".cursor/rules/testing.md", "src/other.mdc"].join("\n");
  assert.deepEqual(cursorRuleFiles(listing), [".cursor/rules/style.mdc", ".cursor/rules/testing.md"]);
  assert.equal(cursorRuleText("---\nglobs: src/**/*.ts\nalwaysApply: false\n---\nUse named exports."), "Applies to: src/**/*.ts\n\nUse named exports.");
  assert.equal(cursorRuleText("---\nalwaysApply: true\n---\nNo default exports."), "Always applies.\n\nNo default exports.");
  assert.equal(cursorRuleText("Plain rule with no front matter."), "Plain rule with no front matter.");
  const block = rulesBlock([
    { path: "AGENTS.md", text: "Run pnpm test." },
    { path: ".cursor/rules/style.mdc", text: cursorRuleText("---\nalwaysApply: true\n---\nNo default exports.") },
  ]);
  assert.match(block, /--- \.cursor\/rules\/style\.mdc ---\nAlways applies\./);
});
