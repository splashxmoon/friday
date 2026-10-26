// While one agent's answer streams, only the small component drawing that lane's words redraws: the session view (and the
// feed and its rows, which it draws) and the other lanes stay as they were, frame after frame.
import { container } from "./fake-dom.js";
import assert from "node:assert/strict";
import test from "node:test";

const { act, createElement: h, memo, Profiler } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useSession } = await import("../src/client/useSession.js");
const { LiveStream } = await import("../src/client/Activity.js");
const { initialState } = await import("../src/session/projection.js");

/** One socket the page opens, driven by the test instead of a server. */
class FakeSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static last: FakeSocket;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  say(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}
const g = globalThis as Record<string, unknown>;
g.WebSocket = FakeSocket;
g.location = { protocol: "http:", host: "localhost" };
(g.document as Record<string, unknown>).visibilityState = "visible";

const SID = "s-stream";
const me = { id: "u1", name: "Ada" };
const frame = () => new Promise((r) => setTimeout(r, 0));

test("200 deltas into one lane redraw only that lane's words: not the session, its feed rows, or the other lane", async () => {
  const counts = { session: 0, row: 0, main: 0, seo: 0 };
  // Stands for a feed row: drawn by the session view, memoised as the run blocks are.
  const Row = memo(function Row() {
    counts.row++;
    return h("p", null, "a row");
  });
  const lane = (id: "main" | "seo") => h(Profiler, { id, onRender: () => void counts[id]++ }, h(LiveStream, { sid: SID, lane: id }));
  function Session() {
    const s = useSession(SID, "inv", me);
    counts.session++;
    // As Activity does: the live block is there while the lane is typing, its words drawn by LiveStream.
    return h("div", null, h(Row), s.streams.main && h("div", { className: "lane-main" }, lane("main")), s.streams.seo && h("div", { className: "lane-seo" }, lane("seo")));
  }
  const el = container();
  const root = createRoot(el as never);
  await act(async () => root.render(h(Session)));
  const ws = FakeSocket.last;
  await act(async () => {
    ws.say({ kind: "hello", you: { ...me, role: "owner" }, state: initialState(SID), events: [], digest: null });
    ws.say({ kind: "delta", text: "The other lane says hello.", lane: "seo" });
    ws.say({ kind: "delta", text: "## Plan\n\n" });
    await frame();
  });
  const before = { ...counts };
  assert.ok(before.main >= 1 && before.seo >= 1, "both lanes are drawn");

  let said = "## Plan\n\n";
  await act(async () => {
    for (let i = 0; i < 199; i++) {
      const piece = i % 10 === 9 ? "\n\n" : `word${i} `;
      said += piece;
      ws.say({ kind: "delta", text: piece });
      if (i % 4 === 3) await frame();
    }
    await frame();
  });
  assert.equal(counts.session, before.session, "the session view (and so the feed) did not redraw");
  assert.equal(counts.row, before.row, "no feed row redrew");
  assert.equal(counts.seo, before.seo, "the other lane did not redraw");
  assert.ok(counts.main - before.main >= 40, `the streaming lane redrew a frame at a time (${counts.main - before.main})`);
  assert.ok(counts.main - before.main <= 60, "once a frame, not once a delta");
  const text = el.all("lane-main")[0]!.textContent;
  assert.match(text, /^Plan/);
  assert.match(text, /word198/, "every word is on screen");
  assert.equal(el.all("lane-seo")[0]!.textContent, "The other lane says hello.");

  // The agent's message lands in the log: its stream closes and the session redraws to show the message in its place.
  await act(async () => {
    ws.say({ kind: "event", event: { seq: 1, ts: Date.now(), actor: { id: "agent", name: "Agent", kind: "agent" }, body: { type: "agent.message", text: said, toolCalls: [] } } });
    await frame();
  });
  assert.equal(counts.session, before.session + 1, "one redraw for the message landing");
  assert.equal(el.all("lane-main").length, 0, "the stream is gone, replaced by the logged message");
  assert.equal(el.all("lane-seo")[0]!.textContent, "The other lane says hello.", "the other lane is still typing");
  await act(async () => root.unmount());
});
