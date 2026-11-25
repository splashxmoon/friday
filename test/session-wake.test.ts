// A session's link after the computer sleeps (src/client/useSession.ts; spec 13). Sleep doesn't hide the page in the desktop app,
// so only the 25s ping found a dead socket: up to ~35s of "live" over nothing. Now the app's wake signal (preload.ts onResume), or
// in any edition a clock that jumped, has the link checked at once.
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { container } from "./fake-dom.js";

const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useSession, sleptBetween, WAKE_TICK_MS, WAKE_GAP_MS } = await import("../src/client/useSession.js");
const { initialState } = await import("../src/session/projection.js");

const alice = { id: "u-alice", name: "Alice" };

class FakeSocket {
  static all: FakeSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(m: string) {
    this.sent.push(m);
  }
  close() {
    this.readyState = 3;
  }
  say(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}
const pings = (s: FakeSocket) => s.sent.filter((m) => m.includes('"ping"')).length;

test("a tick late by a sleep counts as one; a busy page's late tick doesn't", () => {
  assert.equal(sleptBetween(0, WAKE_TICK_MS), false, "on time");
  assert.equal(sleptBetween(0, WAKE_TICK_MS + 3_000), false, "a few seconds late");
  assert.equal(sleptBetween(0, WAKE_TICK_MS + WAKE_GAP_MS), true);
  assert.equal(sleptBetween(0, WAKE_TICK_MS + 30 * 60_000), true, "half an hour asleep");
});

/** A live session on a fake socket, with the desktop app's onResume when `bridge`. */
function live(t: test.TestContext, bridge: boolean) {
  const g = globalThis as Record<string, unknown>;
  const saved = { WebSocket: g.WebSocket, location: g.location, fridayDesktop: g.fridayDesktop };
  FakeSocket.all = [];
  let resume: (() => void) | null = null;
  g.WebSocket = FakeSocket;
  g.location = { protocol: "http:", host: "localhost" };
  if (bridge) g.fridayDesktop = { onResume: (fn: () => void) => ((resume = fn), () => (resume = null)) };
  else delete g.fridayDesktop;
  (g.document as Record<string, unknown>).visibilityState = "visible";
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const seen: string[] = [];
  const Page = () => {
    seen.push(useSession("s-wake", "inv", alice).conn);
    return null;
  };
  const root = createRoot(container() as unknown as Element);
  t.after(() => {
    act(() => root.unmount());
    mock.timers.reset();
    Object.assign(g, saved);
    if (!saved.fridayDesktop) delete g.fridayDesktop;
  });
  act(() => root.render(h(Page)));
  const first = FakeSocket.all[0]!;
  act(() => first.open());
  act(() => first.say({ kind: "hello", you: { ...alice, role: "owner" }, state: initialState("s-wake"), events: [], digest: null }));
  assert.equal(seen.at(-1), "live");
  return { first, seen, resume: () => resume?.(), hasResume: () => !!resume };
}

test("the desktop app's wake signal checks the link at once, and a dead one is replaced within ten seconds", (t) => {
  const s = live(t, true);
  assert.ok(s.hasResume(), "listening for it");
  assert.equal(pings(s.first), 0);
  // Some time on from the hello, as a wake always is.
  act(() => mock.timers.tick(1_000));
  act(() => s.resume());
  assert.equal(pings(s.first), 1, "asked at once, not at the next 25s ping");
  // Nothing back: a socket open to nowhere.
  act(() => mock.timers.tick(10_000));
  assert.equal(s.first.readyState, 3, "given up");
  assert.equal(s.seen.at(-1), "reconnecting", "no longer says live");
  act(() => mock.timers.tick(2_250));
  assert.equal(FakeSocket.all.length, 2, "a new socket made");
});

test("without the app's signal (a browser, the product's app), a clock that jumped is noticed and the link checked", (t) => {
  const s = live(t, false);
  // Ordinary ticks: nothing asked before the 25s ping.
  act(() => mock.timers.tick(WAKE_TICK_MS * 3));
  assert.equal(pings(s.first), 0);
  // The lid shut for ten minutes: no timer ran, and the clock moved on.
  act(() => mock.timers.setTime(Date.now() + 10 * 60_000));
  act(() => mock.timers.tick(WAKE_TICK_MS));
  assert.equal(pings(s.first), 1, "checked on the first tick after waking");
  // An answer: the link is fine and stays.
  act(() => s.first.say({ kind: "pong" }));
  act(() => mock.timers.tick(10_000));
  assert.equal(s.first.readyState, 1);
  assert.equal(s.seen.at(-1), "live");
});
