// One piece that can't be drawn stays one piece (guard.tsx, spec 13): the rest keeps drawing, the piece says so in its place under
// one console tag, tries again when its content changes or Try again is pressed, and a fixed piece draws again.
import { container, propsOf, type FakeElement } from "./fake-dom.js";
import assert from "node:assert/strict";
import test from "node:test";

const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Guard, GUARD_TAG, detailsOf } = await import("../src/client/guard.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let broken = true;
function Row({ label }: { label: string }) {
  if (broken) throw new Error(`can't draw ${label}`);
  return h("p", null, label);
}

function buttons(n: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (x: FakeElement) => {
    if (x.nodeName === "BUTTON") out.push(x);
    for (const c of x.childNodes) if (c.nodeType === 1) walk(c as FakeElement);
  };
  walk(n);
  return out;
}

test("a row that throws is one quiet line; its neighbours draw; it tries again on new content and on Try again", async () => {
  const said: unknown[][] = [];
  const was = console.error;
  console.error = (...a: unknown[]) => void said.push(a);
  try {
    const el = container();
    const root = createRoot(el as never, { onCaughtError: () => {} });
    const draw = (seq: number) => h("div", null, h(Guard, { where: "feed row", reset: seq, children: h(Row, { label: `row ${seq}` }) }), h("p", null, "the next row"));
    broken = true;
    await act(async () => root.render(draw(1)));
    assert.match(el.textContent, /This step couldn't be shown/);
    assert.match(el.textContent, /the next row/);
    const tagged = said.filter((a) => a[0] === GUARD_TAG);
    assert.equal(tagged.length, 1, "said once in the console, under the tag");
    assert.equal(tagged[0]![1], "feed row");

    // Still broken, Try again: the line again, and not said in the console a second time.
    const [again] = buttons(el).filter((b) => b.textContent === "Try again");
    await act(async () => (propsOf(again!).onClick as () => void)());
    assert.match(el.textContent, /This step couldn't be shown/);
    assert.equal(said.filter((a) => a[0] === GUARD_TAG).length, 1);

    // Fixed, Try again draws it.
    broken = false;
    const [now] = buttons(el).filter((b) => b.textContent === "Try again");
    await act(async () => (propsOf(now!).onClick as () => void)());
    assert.match(el.textContent, /row 1/);
    assert.doesNotMatch(el.textContent, /couldn't be shown/);

    // Broken again, then its content changes (the run went on) once it can be drawn: drawn afresh, without a press.
    broken = true;
    await act(async () => root.render(draw(2)));
    assert.match(el.textContent, /couldn't be shown/);
    broken = false;
    await act(async () => root.render(draw(3)));
    assert.match(el.textContent, /row 3/);
    await act(async () => root.unmount());
  } finally {
    console.error = was;
  }
});

test("a panel's fallback is its own; the details say where and what, in a few lines", async () => {
  const was = console.error;
  console.error = () => {};
  try {
    const el = container();
    const root = createRoot(el as never, { onCaughtError: () => {} });
    broken = true;
    await act(async () => root.render(h(Guard, { where: "preview", reset: "a", fallback: (c) => h("div", null, `The preview couldn't be shown · ${c.error.message}`), children: h(Row, { label: "x" }) })));
    assert.equal(el.textContent, "The preview couldn't be shown · can't draw x");
    await act(async () => root.unmount());
  } finally {
    console.error = was;
  }
  const e = new Error("boom");
  e.stack = `Error: boom\n${Array.from({ length: 20 }, (_, i) => `    at f${i} (app.js:${i})`).join("\n")}`;
  const d = detailsOf("feed row", e, "\n    at Row\n    at Guard\n    at div");
  assert.match(d, /^Friday couldn't draw a feed row: boom/);
  assert.ok(d.split("\n").length < 24, "a few lines, not the whole stack");
  assert.match(d, /In:\n {4}at Row/);
});
