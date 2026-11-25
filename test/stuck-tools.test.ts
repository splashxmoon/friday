// A tool that never answers can't hold an agent's turn (Arun, 2026-11-24: "we need to ensure long horizon tasks/ long running tasks
// are stable and not getting hung up or stuck"). In his CRM session two agents testing their own app's pages waited 19 and 4 minutes
// on a browser click and a read that never came back, and a wake and a hold handed to one of them went unread meanwhile.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentMesh } from "../src/agent-mesh.js";
import { browserCall, setBrowserDriver, type BrowserAsk } from "../src/browser-driver.js";

const quick = { other: 60, open: 60, screenshot: 60 };
const never = () => new Promise<never>(() => {});

test("a page that never answers: the agent hears so in time, the driver puts its page right, and the agent's next action still runs", async () => {
  const wedged: string[] = [];
  const asked: string[] = [];
  setBrowserDriver({
    act: (_sid, ask) => (asked.push(ask.action), ask.action === "click" ? never() : Promise.resolve({ output: `did ${ask.action}` })),
    wedged: (sid, lane) => void wedged.push(`${sid}|${lane}`),
  });
  try {
    const t0 = Date.now();
    const r = await browserCall("s1", { action: "click", ref: 47 }, undefined, "l4", quick);
    assert.ok(Date.now() - t0 < 1_000, "answered at the deadline, not left waiting");
    assert.equal(r.isError, true);
    assert.match(r.output, /didn't answer within/);
    assert.match(r.output, /open it again to load it fresh/);
    assert.deepEqual(wedged, ["s1|l4"], "the driver is told whose page stuck");
    const next = await browserCall("s1", { action: "read" }, undefined, "l4", quick);
    assert.equal(next.output, "did read", "the agent's next action goes ahead");
  } finally {
    setBrowserDriver(null);
  }
});

test("two actions sent at once land one after the other on the agent's page, and another agent's never waits behind them", async () => {
  const log: string[] = [];
  setBrowserDriver({
    act: async (_sid, ask: BrowserAsk, _s, lane) => {
      log.push(`start ${lane} ${ask.ref ?? ask.action}`);
      await new Promise((r) => setTimeout(r, ask.ref === 48 ? 40 : 5));
      log.push(`end ${lane} ${ask.ref ?? ask.action}`);
      return { output: "ok" };
    },
  });
  try {
    const a = browserCall("s1", { action: "click", ref: 48 }, undefined, "l4", { other: 1_000 });
    const b = browserCall("s1", { action: "click", ref: 47 }, undefined, "l4", { other: 1_000 });
    const c = browserCall("s1", { action: "read" }, undefined, "l2", { other: 1_000 });
    await Promise.all([a, b, c]);
    const at = (x: string) => log.indexOf(x);
    assert.ok(at("end l4 48") < at("start l4 47"), `47 waits for 48 to finish: ${log.join(", ")}`);
    assert.ok(at("start l2 read") < at("end l4 48"), `another agent's read doesn't wait behind them: ${log.join(", ")}`);
  } finally {
    setBrowserDriver(null);
  }
});

test("a call stopped while its page is busy is answered at once with why", async () => {
  setBrowserDriver({ act: never });
  try {
    const ac = new AbortController();
    const p = browserCall("s1", { action: "read" }, ac.signal, "l2", { other: 60_000 });
    setTimeout(() => ac.abort("A message came for you."), 20);
    const t0 = Date.now();
    const r = await p;
    assert.ok(Date.now() - t0 < 1_000);
    assert.deepEqual(r, { output: "A message came for you.", isError: true });
  } finally {
    setBrowserDriver(null);
  }
});

test("a message handed to a turn waiting on one of Friday's tools: a call waiting a while gives way and says why; a quick one isn't cut short", async () => {
  setBrowserDriver({ act: never });
  const mesh = new AgentMesh(null as never, null as never);
  try {
    const p = mesh.call("s1", "l4", "browser", { action: "click", ref: 47 });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(mesh.giveWay("s1", "l4", 60_000), 0, "not waiting long enough yet: left alone");
    assert.equal(mesh.giveWay("s1", "l2", 0), 0, "another agent's lane: nothing of its own under way");
    assert.equal(mesh.giveWay("s1", "l4", 10), 1);
    const r = await p;
    assert.equal(r.isError, true);
    assert.match(r.output, /A message came for you while browser was still waiting/);
    assert.match(r.output, /Read the message first/);
    assert.equal(mesh.giveWay("s1", "l4", 0), 0, "nothing left under way once it answered");
  } finally {
    setBrowserDriver(null);
  }
});
