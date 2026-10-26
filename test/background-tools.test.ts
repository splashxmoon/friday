import assert from "node:assert/strict";
import { test } from "node:test";
import { readBackground, runBackground, stopBackground } from "../src/agent/tools.js";
import type { RepoCall } from "../src/types.js";

/** The agent's three tools over a pretend machine: what it is told is what the machine said, in words it can act on. */

const machine = (answer: (c: RepoCall) => string) => {
  const calls: RepoCall[] = [];
  const ctx = { readRepo: async (c: RepoCall) => (calls.push(c), { output: answer(c) }) } as never;
  return { calls, ctx };
};
const bg = (over: Record<string, unknown> = {}) => JSON.stringify({ background: { id: "bg1", command: "npm test -- --watch", running: true, log: ["watching"], ...over } });

test("starting one passes the command through and reports it running", async () => {
  const m = machine(() => bg());
  const r = await runBackground.run({ command: "npm test -- --watch" }, m.ctx, "c1");
  assert.deepEqual(m.calls[0], { op: "bgstart", command: "npm test -- --watch" });
  assert.match(r.output, /bg1: npm test -- --watch\n\(still running\)\nwatching/);
  assert.ok(!r.isError);
});

test("one that failed at once is an error, with its output", async () => {
  const m = machine(() => bg({ running: false, exitCode: 2, log: ["no such script"] }));
  const r = await runBackground.run({ command: "npm run nope" }, m.ctx, "c1");
  assert.match(r.output, /\(exited 2\)\nno such script/);
  assert.ok(r.isError);
});

test("a person's no, from the gate, is passed on and nothing is started", async () => {
  const m = machine(() => bg());
  (m.ctx as { commandGate: unknown }).commandGate = async () => ({ go: false, output: "Waiting for the driver to approve it.", endTurn: true });
  const r = await runBackground.run({ command: "make watch" }, m.ctx, "c1");
  assert.equal(m.calls.length, 0);
  assert.equal(r.output, "Waiting for the driver to approve it.");
});

test("a yes from the gate is told to the machine; a machine that doesn't ask is told nothing", async () => {
  const m = machine(() => bg());
  (m.ctx as { commandGate: unknown }).commandGate = async () => ({ go: true, approved: true });
  await runBackground.run({ command: "make watch" }, m.ctx, "c1");
  assert.equal(m.calls[0]!.approved, true);
  const auto = machine(() => bg());
  (auto.ctx as { commandGate: unknown }).commandGate = async () => ({ go: true });
  await runBackground.run({ command: "make watch" }, auto.ctx, "c1");
  assert.equal(auto.calls[0]!.approved, undefined);
});

test("reading asks for the latest lines, within bounds, and stopping says it stopped", async () => {
  const m = machine((c) => (c.op === "bgstop" ? bg({ running: false, stopped: true, log: ["bye"] }) : bg({ log: ["a", "b"] })));
  const read = await readBackground.run({ id: "bg1", lines: 5000 }, m.ctx, "c1");
  assert.deepEqual(m.calls[0], { op: "bgread", query: "bg1", offset: 400 });
  assert.match(read.output, /\(still running\)\na\nb/);
  await readBackground.run({ id: "bg1" }, m.ctx, "c1");
  assert.equal(m.calls[1]!.offset, 80);
  const stop = await stopBackground.run({ id: "bg1" }, m.ctx, "c1");
  assert.match(stop.output, /\(stopped\)/);
  assert.ok(!stop.isError, "stopping on purpose is not a failure");
});

test("a machine that predates this, or won't allow it, answers in a sentence and that reaches the agent", async () => {
  const old = machine(() => "Unknown request.");
  const r = await runBackground.run({ command: "x" }, old.ctx, "c1");
  assert.equal(r.output, "Unknown request.");
  assert.ok(r.isError);
  const refuse = machine(() => JSON.stringify({ error: "Background commands aren't started on Friday's server. Connect a machine to this session to run them there." }));
  assert.match((await runBackground.run({ command: "x" }, refuse.ctx, "c1")).output, /Connect a machine/);
});

test("no folder, and an empty command or id, are answered plainly", async () => {
  assert.ok((await runBackground.run({ command: "x" }, {} as never, "c1")).isError);
  const m = machine(() => bg());
  assert.match((await runBackground.run({ command: "  " }, m.ctx, "c1")).output, /Give a command/);
  assert.equal(m.calls.length, 0);
});
