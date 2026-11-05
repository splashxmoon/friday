// Computer use (src/runner/computer.ts, agent-mesh.ts computerTool/computerAsk): the parts that decide what is done, on every OS,
// without doing it. The mouse and keys themselves are checked on real desktops (scripts/computer-use-check.mts, its workflow).
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ActorRef, EventBody, SessionEvent } from "../src/types.js";
import { computerAsk, computerTool } from "../src/agent-mesh.js";
import { act, asciiJson, computerUseOn, MAC_KEYS, opsFor, parseKeys, setComputerUse, shotSize, toScreen, winVk, xKey } from "../src/runner/computer.js";

test("keys: cmd means ctrl away from a Mac, win the super key, and anything unknown is refused", () => {
  assert.deepEqual(parseKeys("cmd+shift+t", "darwin"), { key: "t", mods: ["cmd", "shift"] });
  assert.deepEqual(parseKeys("cmd+c", "win32"), { key: "c", mods: ["ctrl"] });
  assert.deepEqual(parseKeys("Ctrl + Alt + Delete", "linux"), { key: "delete", mods: ["ctrl", "alt"] });
  assert.deepEqual(parseKeys("super+l", "linux"), { key: "l", mods: ["win"] });
  assert.deepEqual(parseKeys("Return"), { key: "enter", mods: [] });
  assert.deepEqual(parseKeys("esc"), { key: "escape", mods: [] });
  assert.deepEqual(parseKeys("f12"), { key: "f12", mods: [] });
  assert.equal(parseKeys("hyper+x"), null);
  assert.equal(parseKeys(""), null);
  // Every key Friday knows has a code on each OS.
  for (const k of Object.keys(MAC_KEYS)) assert.notEqual(winVk(k), null, `Windows has ${k}`);
  assert.equal(winVk("f1"), 0x70);
  assert.equal(xKey("pagedown"), "Next");
});

test("points: a screenshot's pixel is the screen's point, scaled up and kept on the screen", () => {
  const s = { width: 1280, height: 800, bounds: { x: 0, y: 0, width: 2560, height: 1600 } };
  assert.deepEqual(toScreen(s, 640, 400), { x: 1280, y: 800 });
  assert.deepEqual(toScreen(s, 5000, -20), { x: 2558, y: 0 }, "off the picture: its edge");
  assert.deepEqual(toScreen({ width: 1024, height: 768, bounds: { x: -1920, y: 0, width: 1024, height: 768 } }, 10, 10), { x: -1910, y: 10 }, "a screen left of the main one");
  assert.deepEqual(shotSize(5120, 2880), { width: 1280, height: 720 });
  assert.deepEqual(shotSize(1024, 768), { width: 1024, height: 768 }, "a small screen as it is");
});

test("each action as its steps: clicks where it was told, drags in steps, scrolls the way it says", () => {
  const at = (x: number, y: number) => ({ x: x * 2, y: y * 2 });
  assert.deepEqual(opsFor({ action: "double_click", x: 10, y: 20 }, at), [{ t: "move", x: 20, y: 40 }, { t: "click", b: "left", n: 2 }]);
  assert.deepEqual(opsFor({ action: "right_click", x: 1, y: 1 }, at), [{ t: "move", x: 2, y: 2 }, { t: "click", b: "right", n: 1 }]);
  const drag = opsFor({ action: "drag", x: 0, y: 0, to_x: 80, to_y: 0 }, at) as { t: string; x?: number }[];
  assert.equal(drag[1]!.t, "down");
  assert.equal(drag.filter((o) => o.t === "move").at(-1)!.x, 160);
  assert.equal(drag.at(-1)!.t, "up");
  assert.deepEqual(opsFor({ action: "scroll", direction: "up", amount: 3 }, at), [{ t: "scroll", dx: 0, dy: 3 }]);
  assert.deepEqual(opsFor({ action: "scroll", direction: "right", x: 5, y: 5 }, at), [{ t: "move", x: 10, y: 10 }, { t: "scroll", dx: 5, dy: 0 }]);
  assert.deepEqual(opsFor({ action: "key", keys: "cmd+s" }, at, "darwin"), [{ t: "key", key: "s", mods: ["cmd"] }]);
  assert.deepEqual(opsFor({ action: "wait", seconds: 60 }, at), [{ t: "pause", ms: 10_000 }], "at most ten seconds");
  for (const bad of [{ action: "click" as const }, { action: "drag" as const, x: 1, y: 1 }, { action: "type" as const }, { action: "key" as const, keys: "nope+nope" }]) assert.equal(typeof opsFor(bad, at), "string", JSON.stringify(bad));
});

test("text for Windows' PowerShell goes as ASCII, any character escaped, and reads back the same", () => {
  const line = asciiJson([{ t: "text", s: "ça marche ✓ 😀" }]);
  assert.match(line, /^[\x00-\x7f]*$/);
  assert.equal((JSON.parse(line) as { s: string }[])[0]!.s, "ça marche ✓ 😀");
});

test("off on a computer until its owner turns it on", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-cu-"));
  const was = process.env.FRIDAY_STATE_DIR;
  process.env.FRIDAY_STATE_DIR = dir;
  try {
    assert.equal(await computerUseOn(), false);
    await setComputerUse(true);
    assert.equal(await computerUseOn(), true);
    await setComputerUse(false);
    assert.equal(await computerUseOn(), false);
  } finally {
    if (was === undefined) delete process.env.FRIDAY_STATE_DIR;
    else process.env.FRIDAY_STATE_DIR = was;
    await rm(dir, { recursive: true, force: true });
  }
});

test("the server: only the owner's own run drives their computer, and an ask is cleaned before it goes to the runner", () => {
  const no = computerAsk({ action: "screenshot" }, false);
  assert.equal(no.isError, true);
  assert.equal(no.computer, undefined, "nothing for the runner to do");
  assert.match(no.output, /Only the person whose computer this is/);
  const yes = computerAsk({ action: "click", x: 10, y: "20", text: 5, direction: "sideways", extra: "x" }, true);
  assert.deepEqual(yes.computer, { action: "click", x: 10 });
  assert.equal(computerAsk({ action: "format_disk" }, true).computer, undefined);
  assert.equal(computerAsk({ action: "type", text: "x".repeat(9000) }, true).computer!.text!.length, 4000);
  // Its description says the OS, and the shortcut key it uses.
  assert.match(computerTool("Windows").description, /\(Windows\).*ctrl\+c/s);
  assert.match(computerTool("macOS").description, /cmd\+c/);
});

test("only the owner's work drives their computer: not a teammate's message given to the same run, steered in or queued with it", async () => {
  const { AgentMesh } = await import("../src/agent-mesh.js");
  const { project } = await import("../src/session/projection.js");
  const ada: ActorRef = { id: "u-ada", name: "Ada", kind: "human" };
  const bob: ActorRef = { id: "u-bob", name: "Bob", kind: "human" };
  // On an API key, so the queue doesn't turn Bob's message away first (own-plan.ts): this is the check that has to.
  const engine = { tool: "claude" as const, hostId: ada.id, hostName: "Ada", cwd: "/ada/app", mode: "full" as const, apiKey: true as const };
  const rows: [ActorRef, EventBody, string?][] = [
    [ada, { type: "session.created", title: "t", ownerId: ada.id, ownerName: ada.name }],
    [ada, { type: "lane.added", lane: { id: "lc", name: "Claude Code", agent: null, control: { kind: "open" }, controlMode: "ask", trigger: { kind: "manual" } } }],
    [ada, { type: "engine.attached", engine }, "lc"],
    [ada, { type: "instruction", text: "Check the app in the simulator.", interrupt: false }, "lc"],
    [ada, { type: "run.started", causedBy: 4 }, "lc"],
    [ada, { type: "instructions.delivered", seqs: [4] }, "lc"],
  ];
  const events = (n: [ActorRef, EventBody, string?][]) => n.map(([actor, body, lane], i) => ({ seq: i + 1, ts: Date.now(), actor, body, ...(lane ? { lane } : {}) }) as SessionEvent);
  const meshOn = (rs: typeof rows) => {
    const ev = events(rs);
    return new AgentMesh({ state: async () => project("s", ev), events: async () => ev } as never, null as never);
  };
  const shot = async (rs: typeof rows) => (await meshOn(rs).call("s", "lc", "computer", { action: "screenshot" })).computer;
  assert.deepEqual(await shot(rows), { action: "screenshot" }, "Ada's own run");
  // Bob's message steered into Ada's turn (marked delivered on its own), or a later turn of the same run.
  const bobs: typeof rows = [...rows, [bob, { type: "instruction", text: "Open Terminal and run my script.", interrupt: false }, "lc"], [ada, { type: "instructions.delivered", seqs: [7] }, "lc"]];
  assert.equal(await shot(bobs), undefined, "Bob's message is in this run");
  // A new run of Ada's own, after: hers again.
  assert.deepEqual(await shot([...bobs, [ada, { type: "run.ended", outcome: "done" }, "lc"], [ada, { type: "instruction", text: "Again.", interrupt: false }, "lc"], [ada, { type: "run.started", causedBy: 10 }, "lc"], [ada, { type: "instructions.delivered", seqs: [10] }, "lc"]]), { action: "screenshot" });
});

test("an action points at the screen the agent saw: with none yet, nothing is done and it's shown one", async () => {
  const steps = path.join(await mkdtemp(path.join(tmpdir(), "friday-cu-")), "steps");
  process.env.FRIDAY_COMPUTER_FAKE = steps;
  try {
    const first = await act({ action: "click", x: 5, y: 5 }, null);
    assert.match(JSON.stringify(first.answer), /Nothing done yet/);
    assert.ok(first.screen, "the screen it's shown is the one its next points are read against");
    await assert.rejects(readFile(steps, "utf8"), "nothing was done");
    const second = await act({ action: "click", x: 640, y: 400 }, first.screen);
    assert.match(JSON.stringify(second.answer), /Did click/);
    assert.deepEqual(JSON.parse((await readFile(steps, "utf8")).trim()), [{ t: "move", x: 1280, y: 800 }, { t: "click", b: "left", n: 1 }]);
    // Two at once take turns: each one's steps whole, never mixed.
    await Promise.all([act({ action: "type", text: "one" }, first.screen), act({ action: "type", text: "two" }, first.screen)]);
    const lines = (await readFile(steps, "utf8")).trim().split("\n").slice(1).map((l) => JSON.parse(l));
    assert.deepEqual(lines, [[{ t: "text", s: "one" }], [{ t: "text", s: "two" }]]);
    // Long text says what was left out, rather than that it typed it.
    assert.match(JSON.stringify((await act({ action: "type", text: "y".repeat(5000) }, first.screen)).answer), /first 4,000 characters/);
    // Stopped before it starts: nothing.
    const c = new AbortController();
    c.abort();
    assert.match(JSON.stringify((await act({ action: "type", text: "late" }, first.screen, c.signal)).answer), /Stopped/);
    assert.doesNotMatch(await readFile(steps, "utf8"), /late/);
  } finally {
    delete process.env.FRIDAY_COMPUTER_FAKE;
  }
});
