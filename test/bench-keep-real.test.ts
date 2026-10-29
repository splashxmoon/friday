import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { container, propsOf, type FakeElement } from "./fake-dom.js";

/**
 * The real workbench, with the real Preview and Terminal in it: what bench-keep.test.ts proves with stand-ins, proved with the
 * panels people use. The desktop app's pieces are faked at their edges only: its webview tag, its shells (fridayDesktop), and
 * xterm (a canvas this page has no way to draw), which counts the screens made.
 */
const XTERM = `export class Terminal {
  constructor() { globalThis.__xterms = (globalThis.__xterms ?? 0) + 1; this.cols = 80; this.rows = 24; this.options = {}; this.written = ""; globalThis.__xterm = this; }
  loadAddon() {} open() {} focus() {} dispose() {} attachCustomKeyEventHandler() {}
  registerLinkProvider() { return { dispose() {} }; }
  write(d) { this.written += d; }
  onData(f) { this.typed = f; return { dispose() {} }; }
}`;
register(
  "data:text/javascript," +
    encodeURIComponent(`
      const fake = { "@xterm/xterm": ${JSON.stringify(XTERM)}, "@xterm/addon-fit": "export class FitAddon { fit() {} }" };
      export async function resolve(spec, ctx, next) {
        if (fake[spec]) return { url: "data:text/javascript," + encodeURIComponent(fake[spec]), shortCircuit: true };
        return next(spec, ctx);
      }`),
);

const g = globalThis as Record<string, unknown>;
const store = new Map<string, string>();
g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k) };
g.location = { origin: "http://localhost:4000", protocol: "http:", href: "http://localhost:4000/s/s1" };
g.innerWidth = 1200;
g.innerHeight = 800;
g.MutationObserver = class {
  observe() {}
  disconnect() {}
};
g.getComputedStyle = () => ({ color: "rgb(0, 0, 0)", getPropertyValue: () => "", paddingLeft: "0", paddingRight: "0", paddingTop: "0", paddingBottom: "0" });
g.DOMRect = class {
  constructor(
    public x = 0,
    public y = 0,
    public width = 0,
    public height = 0,
  ) {}
  get left() {
    return this.x;
  }
  get top() {
    return this.y;
  }
  get right() {
    return this.x + this.width;
  }
  get bottom() {
    return this.y + this.height;
  }
};
Object.defineProperty(Object.getPrototypeOf(container()), "getBoundingClientRect", { value: () => new (g.DOMRect as typeof DOMRect)(0, 0, 400, 300) });
g.HTMLElement = g.Element = Object.getPrototypeOf(container()).constructor;
Object.defineProperty(Object.getPrototypeOf(container()), "querySelector", { value: () => null });
Object.defineProperty(Object.getPrototypeOf(container()), "querySelectorAll", { value: () => [] });
Object.defineProperty(Object.getPrototypeOf(container()), "remove", {
  value(this: FakeElement) {
    this.parentNode?.removeChild(this);
  },
});

/** The desktop app's shells: each start is counted, and says whether it found the shell already running. */
const shells = { starts: 0, resumed: 0, running: new Set<string>(), data: new Set<(id: string, d: string) => void>() };
g.fridayDesktop = {
  terminal: {
    async start(o: { id: string }) {
      shells.starts++;
      const resumed = shells.running.has(o.id);
      if (resumed) shells.resumed++;
      shells.running.add(o.id);
      return { ok: true, shell: "zsh", cwd: "/repo", resumed, replay: "" };
    },
    write() {},
    resize() {},
    kill() {},
    onData: (f: (id: string, d: string) => void) => (shells.data.add(f), () => void shells.data.delete(f)),
    onExit: () => () => {},
  },
};

/** Every request the page made, by path, and answers good enough for the panels. */
const asked: string[] = [];
/** The dev server says it is still coming up, which a showing Preview polls every 1.5s. */
let comingUp = false;
g.fetch = async (url: string) => {
  asked.push(url);
  const path = url.split("?")[0]!;
  const body = path.endsWith("preview.status") ? { preview: comingUp ? { url: "http://localhost:5173/", port: 5173, ready: false, command: "npm run dev" } : null } : path.endsWith("preview.options") ? { scripts: [], static: false } : path.endsWith("background.list") ? { tasks: [] } : { output: "" };
  return { ok: true, status: 200, json: async () => body };
};

const { act, createElement: h, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { BenchOrHistory, Workbench } = await import("../src/client/Workbench.js");
type Tab = import("../src/client/Workbench.js").Tab;
const { FocusContext } = await import("../src/client/focusStore.js");
const { openInPreview } = await import("../src/client/previewBus.js");
const { initialState } = await import("../src/session/projection.js");

const PATCH = "@@ -1,1 +1,1 @@\n-a\n+b\n";
const settle = () => act(async () => new Promise((r) => setTimeout(r, 10)));
const click = async (n: FakeElement | undefined, e: object = {}) => {
  assert.ok(n, "there to press");
  await act(async () => (propsOf(n!).onClick as (e: unknown) => void)({ stopPropagation() {}, preventDefault() {}, ...e }));
  await settle();
};
const text = (n: FakeElement) => n.textContent;
const walk = (n: FakeElement, out: FakeElement[] = []): FakeElement[] => {
  for (const c of n.childNodes as FakeElement[]) if (c.nodeType === 1) (out.push(c), walk(c, out));
  return out;
};
const tags = (n: FakeElement, tag: string) => walk(n).filter((x) => x.localName === tag);

/** A session at /repo on the desktop app, with a change to src/a.ts, mounted as SessionView mounts it. */
function session(sid = "s1", twoAgents = false) {
  const state = initialState(sid);
  const change = (path: string) => ({ seq: 1, base: "b", files: [{ path, status: "modified" as const, additions: 1, deletions: 1, patch: PATCH }] });
  state.engines = { main: { cwd: "/repo", hostName: "mac", online: true, mode: "edits" } } as never;
  state.diffs = twoAgents ? { main: change("src/a.ts"), codex: change("src/b.ts") } : { main: change("src/a.ts") };
  const me = { id: "u-ada", name: "Ada", role: "owner" } as never;
  const identity = { id: "u-ada", name: "Ada" } as never;
  const send = (async () => ({ ok: true })) as never;
  const el = container();
  const root = createRoot(el as never);
  type At = { tab: Tab; bench: boolean; history: boolean };
  let set: (p: Partial<At>) => void = () => {};
  // As SessionView holds them: the tab, whether the bench is open, whether History is.
  function Host() {
    const [at, setAt] = useState<At>({ tab: "preview", bench: true, history: false });
    set = (p) => setAt((a) => ({ ...a, ...p }));
    return h(
      FocusContext.Provider,
      { value: { others: {}, here: () => {} } },
      h(
        BenchOrHistory,
        { bench: at.bench, history: at.history && h("section", { className: "history-stub" }, "History"), children: null },
        h(Workbench, { open: at.bench, state, events: [], identity, sid, invite: "i", me, send, tab: at.tab, onTab: (tab: Tab) => set({ tab }), width: 600, onWidth() {}, onClose: () => set({ bench: false }) }),
      ),
    );
  }
  let drawn = false;
  const draw = async (p: Partial<At> = {}) => {
    await act(async () => {
      if (!drawn) root.render(h(Host));
      drawn = true;
    });
    await act(async () => set(p));
    await settle();
  };
  return { el, draw, unmount: () => act(async () => root.unmount()) };
}

/** Pick from the workbench's "Show two panels" menu. */
async function menu(el: FakeElement, label: string) {
  await click(el.all("split-btn")[0], { currentTarget: { getBoundingClientRect: () => ({ right: 600, bottom: 40 }) } });
  const item = walk(document.body as never).find((n) => n.getAttribute("role")?.startsWith("menuitem") && text(n).includes(label));
  await click(item);
}

test("the real Preview keeps its tabs and pages through the Diff, a swap, another second panel, the bench closed and History", async (t) => {
  const s = session();
  t.after(s.unmount);
  await s.draw({ tab: "preview" });
  openInPreview("http://localhost:5173/about", "s1"); // pressed in the conversation
  await settle();
  // A second tab, on another page.
  await click(walk(s.el).find((n) => n.getAttribute("aria-label") === "Open a new tab"));
  const bar = () => tags(s.el, "input").find((n) => n.className.includes("browser-url"))!;
  await act(async () => (propsOf(bar()).onChange as (e: unknown) => void)({ target: { value: "localhost:5173/settings" } }));
  await act(async () => (propsOf(bar().parentElement!).onSubmit as (e: unknown) => void)({ preventDefault() {} }));
  await settle();
  const pages = () => tags(s.el, "webview");
  const before = pages();
  assert.deepEqual(
    before.map((w) => w.getAttribute("src")),
    ["http://localhost:5173/about", "http://localhost:5173/settings"],
  );
  const mounted = s.el.all("bench-body").length;

  await s.draw({ tab: "files" });
  await s.draw({ tab: "preview" });
  await menu(s.el, "Diff"); // Diff as the second panel
  await menu(s.el, "Swap the two"); // Preview below, Diff on top
  assert.ok(pages()[0]!.closest("bench-body")!.className.includes("split"), "the Preview is now second");
  await menu(s.el, "Rules"); // another second panel: the Preview is put away
  await menu(s.el, "Just one panel");
  await s.draw({ bench: false }); // closed
  await s.draw({ history: true }); // History in its place
  assert.equal(s.el.all("history-stub").length, 1, "History shows while the bench is closed");
  await s.draw({ history: false, bench: true, tab: "preview" });
  assert.equal(s.el.all("history-stub").length, 0);

  const after = pages();
  assert.equal(after.length, 2);
  after.forEach((w, i) => assert.equal(w, before[i], "the very same page, never moved to another parent or drawn again"));
  assert.ok(s.el.contains(after[0]!));
  assert.deepEqual(
    after.map((w) => w.getAttribute("src")),
    ["http://localhost:5173/about", "http://localhost:5173/settings"],
  );
  const on = walk(s.el).find((n) => n.className.includes("bw-tab-name") && n.getAttribute("aria-selected") === "true");
  assert.equal(on?.getAttribute("title"), "http://localhost:5173/settings", "the second tab is still the one showing");
  assert.equal(s.el.all("bench-stack").length, 1);
  assert.ok(s.el.all("bench-body").length >= mounted);
});

test("a put-away Preview asks the machine nothing: no background.list and no coming-up poll", async (t) => {
  comingUp = true;
  t.after(() => void (comingUp = false));
  const s = session("s2");
  t.after(s.unmount);
  await s.draw({ tab: "preview" });
  const count = (what: string) => asked.filter((u) => u.includes(what)).length;
  const wait = (ms: number) => act(async () => new Promise((r) => setTimeout(r, ms)));
  let lists = count("background.list");
  let polls = count("preview.status");
  await wait(1700);
  assert.ok(count("background.list") > lists || lists > 0, "asks what is running while it shows");
  assert.ok(count("preview.status") > polls, "and polls a server coming up");

  await s.draw({ tab: "rules" });
  [lists, polls] = [count("background.list"), count("preview.status")];
  await wait(1700);
  assert.equal(count("background.list"), lists, "no background.list while put away");
  assert.equal(count("preview.status"), polls, "no coming-up poll while put away");
  await s.draw({ bench: false });
  await wait(1700);
  assert.equal(count("background.list"), lists, "nor while the bench is closed");
  assert.equal(count("preview.status"), polls);
  await s.draw({ bench: true, tab: "preview" });
  await wait(1700);
  assert.ok(count("preview.status") > polls, "polling again once shown");
});

test("the Preview comes back on its tabs after another session and a reload, and the conversation's address is not lost", async (t) => {
  const a = session("s3");
  await a.draw({ tab: "rules" }); // the Preview not drawn yet
  openInPreview("http://localhost:3000/cart", "s3"); // pressed while it was not there
  openInPreview("http://localhost:9999/", "elsewhere"); // another session's
  await a.draw({ tab: "preview" });
  const src = () => tags(a.el, "webview").map((w) => w.getAttribute("src"));
  assert.deepEqual(src(), ["http://localhost:3000/cart"], "opened from the conversation, and only this session's");
  await a.unmount(); // to another session, or a reload

  const b = session("s3");
  t.after(b.unmount);
  await b.draw({ tab: "preview" });
  assert.deepEqual(
    tags(b.el, "webview").map((w) => w.getAttribute("src")),
    ["http://localhost:3000/cart"],
    "the same page, and the ask is not taken a second time over it",
  );
});

test("the real Terminal: one screen and one start, through the Diff and back, the bench closed and History", async (t) => {
  const s = session("s4");
  t.after(s.unmount);
  await s.draw({ tab: "terminal" });
  await act(async () => new Promise((r) => setTimeout(r, 30))); // xterm arrives on its own chunk
  const xterms = () => (g.__xterms as number | undefined) ?? 0;
  assert.equal(xterms(), 1, "one screen");
  assert.equal(shells.starts, 1);
  for (const f of shells.data) f([...shells.running][0]!, "npm run dev\r\n  VITE ready\r\n");
  const screen = (g.__xterm as { written: string }).written;
  const host = s.el.all("term-shell-host")[0];

  await s.draw({ tab: "files" });
  await s.draw({ tab: "terminal" });
  await s.draw({ bench: false });
  await s.draw({ history: true });
  await s.draw({ history: false, bench: true });
  await act(async () => new Promise((r) => setTimeout(r, 30)));
  assert.equal(xterms(), 1, "no second screen");
  assert.equal(shells.starts, 1, "not started again");
  assert.equal(shells.resumed, 0, "so never resumed or replayed");
  assert.equal(s.el.all("term-shell-host")[0], host, "the same node");
  assert.equal((g.__xterm as { written: string }).written, screen, "nothing drawn over it again");
});

test("the Diff stays on the agent picked, through a switch and into a new view of the session", async (t) => {
  const a = session("s5", true);
  await a.draw({ tab: "files" });
  const lanes = (el: FakeElement) => walk(el).filter((n) => n.getAttribute("role") === "tab" && n.className.includes("art-tab"));
  const picked = (el: FakeElement) => lanes(el).find((n) => n.getAttribute("aria-selected") === "true")?.textContent;
  assert.equal(lanes(a.el).length, 2);
  const first = picked(a.el);
  await click(lanes(a.el).find((n) => n.getAttribute("aria-selected") !== "true"));
  const second = picked(a.el);
  assert.notEqual(second, first);
  await a.draw({ tab: "tree" });
  await a.draw({ tab: "files" });
  assert.equal(picked(a.el), second, "kept while the session is open");
  await a.unmount();

  const b = session("s5", true);
  t.after(b.unmount);
  await b.draw({ tab: "files" });
  assert.equal(picked(b.el), second, "and when it is opened again");
});

