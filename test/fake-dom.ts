/**
 * Just enough of a page for react-dom to draw into, so a test can mount client components and watch what stays mounted.
 *
 * No jsdom in this repo, and the tests that need a page only need the tree itself: elements, text, attributes, style, and
 * where each node sits. Layout is faked as "a node has 400px unless it or a parent is display:none, [hidden] or .off".
 * Import this before react-dom: react-dom decides whether it is in a browser when it loads.
 */
class FakeNode {
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  private listeners = new EventTarget();
  constructor(
    readonly nodeType: number,
    readonly nodeName: string,
    readonly ownerDocument: FakeDocument | null,
  ) {}
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes.at(-1) ?? null;
  }
  get nextSibling(): FakeNode | null {
    const p = this.parentNode?.childNodes;
    return p ? (p[p.indexOf(this) + 1] ?? null) : null;
  }
  get parentElement(): FakeElement | null {
    return this.parentNode instanceof FakeElement ? this.parentNode : null;
  }
  appendChild<T extends FakeNode>(c: T): T {
    c.parentNode?.removeChild(c);
    this.childNodes.push(c);
    c.parentNode = this;
    return c;
  }
  insertBefore<T extends FakeNode>(c: T, ref: FakeNode | null): T {
    if (!ref) return this.appendChild(c);
    c.parentNode?.removeChild(c);
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, c);
    c.parentNode = this;
    return c;
  }
  removeChild<T extends FakeNode>(c: T): T {
    this.childNodes.splice(this.childNodes.indexOf(c), 1);
    c.parentNode = null;
    return c;
  }
  contains(n: FakeNode | null): boolean {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v) this.appendChild(this.ownerDocument!.createTextNode(v));
  }
  addEventListener(type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) {
    this.listeners.addEventListener(type, fn, opts);
  }
  removeEventListener(type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions) {
    this.listeners.removeEventListener(type, fn, opts);
  }
  /** On this node only, no bubbling: enough for a Radix focus scope's own mount and unmount events (ui.tsx floating). */
  dispatchEvent(e: Event): boolean {
    return this.listeners.dispatchEvent(e);
  }
}

class FakeText extends FakeNode {
  constructor(
    public nodeValue: string,
    doc: FakeDocument,
  ) {
    super(3, "#text", doc);
  }
  override get textContent() {
    return this.nodeValue;
  }
  override set textContent(v: string) {
    this.nodeValue = v;
  }
}

type Style = Record<string, string> & { setProperty(k: string, v: string): void; removeProperty(k: string): void };

class FakeElement extends FakeNode {
  attrs = new Map<string, string>();
  dataset: Record<string, string> = {};
  style: Style;
  constructor(tag: string, doc: FakeDocument) {
    super(1, tag.toUpperCase(), doc);
    const style = {} as Style;
    Object.defineProperties(style, {
      setProperty: { value: (k: string, v: string) => void (style[k] = v) },
      removeProperty: { value: (k: string) => void delete style[k] },
    });
    this.style = style;
  }
  get tagName() {
    return this.nodeName;
  }
  get localName() {
    return this.nodeName.toLowerCase();
  }
  get namespaceURI() {
    return "http://www.w3.org/1999/xhtml";
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  hasAttribute(k: string) {
    return this.attrs.has(k);
  }
  get className() {
    return this.getAttribute("class") ?? "";
  }
  /** As a page's: the Workbench marks the root while it is docked (bench-docked), and a page without one threw there. */
  get classList() {
    const names = () => new Set(this.className.split(/\s+/).filter(Boolean));
    const save = (s: Set<string>) => this.setAttribute("class", [...s].join(" "));
    return {
      add: (...c: string[]) => save(new Set([...names(), ...c])),
      remove: (...c: string[]) => {
        const s = names();
        for (const x of c) s.delete(x);
        save(s);
      },
      contains: (c: string) => names().has(c),
      toggle: (c: string, on?: boolean) => {
        const s = names();
        const want = on ?? !s.has(c);
        if (want) s.add(c);
        else s.delete(c);
        save(s);
        return want;
      },
    };
  }
  /** Put away by any of the ways the workbench puts things away. */
  get away(): boolean {
    for (let x: FakeNode | null = this; x; x = x.parentNode)
      if (x instanceof FakeElement && (x.style.display === "none" || x.hasAttribute("hidden") || /(^|\s)off(\s|$)/.test(x.className))) return true;
    return false;
  }
  get clientWidth() {
    return this.away ? 0 : 400;
  }
  get clientHeight() {
    return this.away ? 0 : 300;
  }
  closest(sel: string): FakeElement | null {
    const cls = sel.replace(/^\./, "");
    for (let x: FakeNode | null = this; x; x = x.parentNode) if (x instanceof FakeElement && x.className.split(/\s+/).includes(cls)) return x;
    return null;
  }
  /** Every element under this one with all of `classes`. */
  all(...classes: string[]): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (n: FakeNode) => {
      for (const c of n.childNodes) {
        if (c instanceof FakeElement && classes.every((k) => c.className.split(/\s+/).includes(k))) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  focus() {}
  blur() {}
  scrollIntoView() {}
}

class FakeDocument extends FakeNode {
  body: FakeElement;
  documentElement: FakeElement;
  activeElement: FakeElement;
  constructor() {
    super(9, "#document", null);
    this.documentElement = this.appendChild(new FakeElement("html", this));
    this.body = this.documentElement.appendChild(new FakeElement("body", this));
    this.activeElement = this.body;
  }
  createElement(tag: string) {
    return new FakeElement(tag, this);
  }
  createElementNS(_ns: string, tag: string) {
    return new FakeElement(tag, this);
  }
  createTextNode(text: string) {
    return new FakeText(text, this);
  }
}

/** Every ResizeObserver the page made, so a test can say "the size changed" to all of them. */
const observers: { cb: () => void; live: boolean }[] = [];
export const resized = () => observers.filter((o) => o.live).forEach((o) => o.cb());

const g = globalThis as Record<string, unknown>;
const doc = new FakeDocument();
const win = new EventTarget();
g.window = globalThis;
g.document = doc;
g.addEventListener = win.addEventListener.bind(win);
g.removeEventListener = win.removeEventListener.bind(win);
g.dispatchEvent = win.dispatchEvent.bind(win);
g.HTMLIFrameElement = class {};
if (!g.navigator) g.navigator = { userAgent: "node" };
g.ResizeObserver = class {
  private o: { cb: () => void; live: boolean };
  constructor(cb: () => void) {
    this.o = { cb, live: true };
    observers.push(this.o);
  }
  observe() {}
  disconnect() {
    this.o.live = false;
  }
};
g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
g.cancelAnimationFrame = (t: ReturnType<typeof setTimeout>) => clearTimeout(t);
g.IS_REACT_ACT_ENVIRONMENT = true;

export type { FakeElement };
/** A fresh element to mount into. */
export const container = (): FakeElement => doc.body.appendChild(doc.createElement("div"));
/** The props React last gave this node, for calling a handler as a user's input would. */
export const propsOf = (n: FakeElement): Record<string, unknown> => (n as unknown as Record<string, Record<string, unknown>>)[Object.keys(n).find((k) => k.startsWith("__reactProps$"))!]!;
