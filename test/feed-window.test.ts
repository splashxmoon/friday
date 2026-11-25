// A long chat draws its newest part, not every item it has ever had (Activity's FEED_WINDOW): a 20,000-event session was
// 167,000 elements, all drawn again on each new event (scripts/perf-feed.tsx). What is older comes back on Show earlier or when
// something outside the feed opens it back to a point (revealSeq: search, the team brief, the subagents list).
import { container } from "./fake-dom.js";
import { feedLog } from "./feed-page.js";
import assert from "node:assert/strict";
import test from "node:test";

const g = globalThis as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Activity } = await import("../src/client/Activity.js");
const { FEED_WINDOW } = await import("../src/client/Activity.js");
const { revealSeq } = await import("../src/client/feed-window.js");
const { project } = await import("../src/session/projection.js");

type El = { childNodes: El[]; getAttribute?: (k: string) => string | null; nodeName: string };
const rows = (el: El): number[] => {
  const out: number[] = [];
  const walk = (n: El) => {
    const s = n.getAttribute?.("data-seq");
    if (s != null && /feed-item/.test(n.getAttribute?.("class") ?? "")) out.push(Number(s));
    for (const c of n.childNodes) walk(c);
  };
  walk(el);
  return out;
};
const find = (el: El, test: (n: El) => boolean): El | null => {
  if (test(el)) return el;
  for (const c of el.childNodes) {
    const f = find(c, test);
    if (f) return f;
  }
  return null;
};

const SID = "s-window";
const ada = { id: "u1", name: "Ada" };
const draw = (events: ReturnType<typeof feedLog>) =>
  h(Activity, { plan: "pro", connections: [], state: project(SID, events), me: { ...ada, role: "owner" }, events, streams: {}, send: async () => ({ ok: true }), sid: SID, invite: "inv", notify: () => {}, identity: ada } as never);

test("a 3,000-event chat draws its newest items; Show earlier and a jump from outside the feed bring back the rest", async (t) => {
  const log = feedLog(3000);
  const el = container() as unknown as El;
  const root = createRoot(el as never);
  t.after(() => act(async () => root.unmount()));
  await act(async () => root.render(draw(log)));
  const first = rows(el);
  assert.equal(first.length, FEED_WINDOW, "the newest FEED_WINDOW items, not all ~1,000");
  assert.equal(first.at(-1), Math.max(...first), "ending at the newest");
  const earliest = Math.min(...first);

  // A new event: still FEED_WINDOW items, the window moving with the end while the reader follows it.
  const more = feedLog(3006);
  await act(async () => root.render(draw(more)));
  assert.equal(rows(el).length, FEED_WINDOW);

  // Show earlier draws more above.
  const button = find(el, (n) => n.nodeName === "BUTTON" && /feed-earlier/.test(n.getAttribute?.("class") ?? ""));
  assert.ok(button, "a Show earlier line at the top");
  // fake-dom doesn't bubble, so the press goes straight to the props React gave the button.
  const props = (button as unknown as Record<string, { onClick: (e: unknown) => void }>)[Object.keys(button!).find((k) => k.startsWith("__reactProps$"))!]!;
  // A press carries its event, which the button reads to keep the reader's place (CREW-22); fake-dom has no scroller to find.
  await act(async () => props.onClick({ currentTarget: { closest: () => null } }));
  const afterPress = rows(el);
  assert.ok(afterPress.length > FEED_WINDOW && Math.min(...afterPress) < earliest, `more drawn above (${afterPress.length})`);

  // A jump to the very start (search, the Jump menu) finds its row there at once.
  await act(async () => revealSeq(5));
  assert.ok(rows(el).some((s) => s <= 5), "the first turn is drawn for the jump");
});
