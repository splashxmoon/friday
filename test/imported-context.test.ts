import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { buildContext } from "../src/agent/context.js";
import { readCliTranscript } from "../src/runner/imports.js";
import type { ActorRef, EventBody, SessionEvent } from "../src/types.js";

/**
 * An imported session has to be something the whole room can work on.
 *
 * The host's own CLI resumes it from its own memory. Nobody else has that:
 * not Friday's agent, and not a teammate's Claude Code, because the transcript
 * is a file on one machine. So the conversation goes in the log, and these
 * tests hold every consumer of it to that.
 */

let home = "";
const HOST: ActorRef = { id: "u1", name: "Ada", kind: "human" };
const AGENT: ActorRef = { id: "engine:u1", name: "Ada's Claude Code", kind: "agent" };

let seq = 0;
const ev = (body: EventBody, actor = AGENT): SessionEvent => ({ seq: ++seq, ts: Date.now(), actor, body });

before(async () => {
  home = await mkdtemp(path.join(tmpdir(), "friday-imported-"));
  const project = path.join(home, ".claude", "projects", "C--work-api");
  await mkdir(project, { recursive: true });
  const cwd = path.join(home, "api");
  await mkdir(cwd, { recursive: true });
  const rec = (o: Record<string, unknown>) => JSON.stringify({ cwd, sessionId: "sess-42", timestamp: new Date().toISOString(), ...o });
  await writeFile(
    path.join(project, "sess-42.jsonl"),
    [
      rec({ type: "user", message: { role: "user", content: "The retry helper double-counts attempts." } }),
      rec({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: {} }] } }),
      rec({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Found it: the counter increments in both the catch and the loop." }] } }),
      rec({ type: "user", message: { role: "user", content: "<system-reminder>ignore me</system-reminder>Fix it then." } }),
      rec({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Fixed, and added a test that fails on the old behaviour." }] } }),
    ].join("\n"),
  );
});
after(() => rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

test("a transcript reads back as the conversation, without the machinery", async () => {
  const t = await readCliTranscript({ tool: "claude", id: "sess-42", home });
  assert.equal(t.found, true);
  assert.equal(t.turns.length, 4, "the tool-only turn is dropped");
  assert.deepEqual(
    t.turns.map((x) => x.role),
    ["user", "assistant", "user", "assistant"],
  );
  assert.match(t.turns[0]!.text, /double-counts/);
  assert.doesNotMatch(JSON.stringify(t.turns), /ignore me/, "injected context is not part of the conversation");
  assert.match(t.turns[3]!.text, /added a test/);
});

test("an older conversation is found by its file's name, however many newer ones there are", async () => {
  const other = path.join(home, ".claude", "projects", "C--work-busy");
  await mkdir(other, { recursive: true });
  const old = new Date(Date.now() - 86_400_000);
  const target = path.join(other, "0ld0ld00-1111-2222-3333-444444444444.jsonl");
  await writeFile(target, JSON.stringify({ type: "user", cwd: home, sessionId: "0ld0ld00-1111-2222-3333-444444444444", message: { role: "user", content: "The one from yesterday." } }) + "\n");
  await utimes(target, old, old);
  // More newer conversations than a scan of the newest reads.
  for (let i = 0; i < 160; i++) {
    const id = `new${String(i).padStart(5, "0")}-1111-2222-3333-444444444444`;
    await writeFile(path.join(other, `${id}.jsonl`), JSON.stringify({ type: "user", cwd: home, sessionId: id, message: { role: "user", content: `newer ${i}` } }) + "\n");
  }
  const t = await readCliTranscript({ tool: "claude", id: "0ld0ld00-1111-2222-3333-444444444444", home });
  assert.equal(t.found, true);
  assert.match(t.turns[0]!.text, /from yesterday/);
});

test("an unknown id is reported as missing rather than guessed at", async () => {
  const t = await readCliTranscript({ tool: "claude", id: "nope", home });
  assert.equal(t.found, false);
  assert.deepEqual(t.turns, []);
});

test("Friday's agent gets the imported conversation as history, not as an instruction", () => {
  const msgs = buildContext([
    ev({
      type: "session.imported",
      tool: "claude",
      sourceId: "sess-42",
      title: "Retry helper",
      total: 4,
      turns: [
        { role: "user", text: "The retry helper double-counts attempts." },
        { role: "assistant", text: "Fixed, and added a test." },
      ],
    }),
    ev({ type: "instruction", text: "Now make the backoff configurable.", interrupt: false }, HOST),
    ev({ type: "instructions.delivered", seqs: [seq] }),
  ]);
  const all = JSON.stringify(msgs);
  assert.match(all, /double-counts/, "the earlier conversation has to reach the model");
  assert.match(all, /Retry helper/);
  assert.match(all, /background, not a new instruction/, "or it will redo the work");
  assert.match(all, /backoff configurable/, "and the actual instruction still arrives");
});

test("only the tail travels when the original was long", async () => {
  const many = Array.from({ length: 200 }, (_, i) =>
    JSON.stringify({
      cwd: path.join(home, "api"),
      sessionId: "sess-long",
      timestamp: new Date().toISOString(),
      type: i % 2 ? "assistant" : "user",
      message: { role: i % 2 ? "assistant" : "user", content: `message ${i}` },
    }),
  );
  const dir = path.join(home, ".claude", "projects", "C--work-api");
  await writeFile(path.join(dir, "sess-long.jsonl"), many.join("\n"));
  const t = await readCliTranscript({ tool: "claude", id: "sess-long", home, maxTurns: 10 });
  assert.equal(t.turns.length, 10);
  assert.equal(t.total, 200, "the count is of the whole conversation, not what fitted");
  assert.match(t.turns.at(-1)!.text, /message 199/, "the tail is what the next instruction follows on from");
});
