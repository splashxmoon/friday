import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cutOff } from "../src/ide-restore.js";
import { stablePort } from "../src/runner/vscode.js";
import type { SessionState } from "../src/session/projection.js";

const state = (run: Partial<SessionState["run"]>, lanes: SessionState["laneRuns"] = {}, pending: number[] = [], lanePending: Record<string, number[]> = {}) => ({ run: { status: "idle", sinceSeq: 0, ...run }, laneRuns: lanes, pendingInstructions: pending, lanePending }) as unknown as SessionState;
const now = () => Date.now() - 1000;

test("a run the restart ended as cut off is offered, with how many of its messages are queued again", () => {
  for (const error of ["Rio lost its connection when the server restarted. It carries on from where it was when it reconnects.", "The server restarted in the middle of Rio's turn. It picks this up again when it reconnects."]) {
    assert.equal(cutOff(state({ status: "error", sinceSeq: 9, sinceAt: now(), error }))?.sinceSeq, 9);
  }
});

test("a drop that is not Friday closing is not said to be", () => {
  for (const error of ["Rio disconnected. It carries on from where it was when it reconnects.", "Rio disconnected in the middle of a turn."]) assert.equal(cutOff(state({ status: "error", sinceSeq: 9, sinceAt: now(), error })), null, error);
});

test("a cut older than a week is not when Friday closed", () => {
  const error = "The server restarted in the middle of Rio's turn. It picks this up again when it reconnects.";
  assert.equal(cutOff(state({ status: "error", sinceSeq: 9, sinceAt: Date.now() - 8 * 86_400_000, error })), null);
});

test("the cut says how many messages are back in its queue", () => {
  const error = "Rio lost its connection when the server restarted. It carries on from where it was when it reconnects.";
  assert.equal(cutOff(state({ status: "error", sinceSeq: 9, sinceAt: now(), error }, {}, [4]))?.queued, 1);
  assert.equal(cutOff(state({ status: "error", sinceSeq: 9, sinceAt: now(), error }))?.queued, 0);
  assert.equal(cutOff(state({ status: "idle" }, { b: { status: "error", sinceSeq: 3, sinceAt: now(), error } }, [], { b: [5, 6] }))?.queued, 2);
});

test("a run still saying running, a real failure, a finished run and an idle one are not offered", () => {
  assert.equal(cutOff(state({ status: "running", sinceSeq: 7, sinceAt: now() })), null, "carrying on, or about to be ended as cut");
  assert.equal(cutOff(state({ status: "error", error: "tests failed" })), null);
  assert.equal(cutOff(state({ status: "idle", sinceAt: 10 })), null);
  assert.equal(cutOff(state({ status: "waiting_for_human", sinceAt: 10 })), null);
  assert.equal(cutOff(null), null);
});

test("another lane's cut run is found, with its lane", () => {
  const c = cutOff(state({ status: "idle" }, { b: { status: "error", sinceSeq: 3, sinceAt: now(), error: "The server restarted in the middle of Rio's turn." } }));
  assert.equal(c?.lane, "b");
});

test("the IDE's port is the one used last when it is free, else a new one that is kept", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "port-"));
  const file = path.join(dir, "vscode", "port");
  try {
    let fresh = 41000;
    const next = async () => ++fresh;
    assert.equal(await stablePort(file, async () => true, next), 41001, "nothing kept yet: a new one");
    assert.equal(await stablePort(file, async () => true, next), 41001, "free: the same again");
    assert.equal(await stablePort(file, async () => false, next), 41002, "taken: another, and that is kept");
    assert.equal(await stablePort(file, async () => true, next), 41002);
    fs.writeFileSync(file, "nonsense");
    assert.equal(await stablePort(file, async () => true, next), 41003, "a damaged file is as none");
    // The real check: a port something is listening on is not free.
    const s = net.createServer().listen(0, "127.0.0.1");
    await new Promise((r) => s.once("listening", r));
    fs.writeFileSync(file, String((s.address() as net.AddressInfo).port));
    assert.equal(await stablePort(file, undefined, next), 41004);
    s.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
