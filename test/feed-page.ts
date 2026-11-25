/**
 * The rest of a page the whole session feed (Activity) needs to draw into test/fake-dom.ts, and a realistic long log for it:
 * shared by test/feed-window.test.ts and scripts/perf-feed.tsx. Import after fake-dom and before react-dom. Leaves
 * IntersectionObserver to the caller: with none, the feed draws every item (feed-near.ts, feed-window.ts).
 */
import { performance } from "node:perf_hooks";
import { container } from "./fake-dom.js";
import type { EventBody, SessionEvent } from "../src/types.js";

// The feed measures tab names on a canvas: a stand-in that gives every character 7px.
{
  const doc = (globalThis as unknown as { document: { createElement: (t: string) => Record<string, unknown> } }).document;
  const make = doc.createElement.bind(doc);
  doc.createElement = (t: string) => {
    const el = make(t);
    if (t === "canvas") el.getContext = () => ({ font: "", measureText: (s: string) => ({ width: s.length * 7 }) });
    return el;
  };
}
// fake-dom's className is read-only; the dropdown layer sets it.
{
  const proto = Object.getPrototypeOf(container()) as object;
  const d = Object.getOwnPropertyDescriptor(proto, "className");
  const p = proto as Record<string, unknown>;
  p.append ??= function (this: { appendChild: (n: unknown) => void }, ...ns: unknown[]) { for (const n of ns) this.appendChild(n); };
  p.remove ??= function (this: { parentNode: { removeChild: (n: unknown) => void } | null }) { this.parentNode?.removeChild(this); };
  if (typeof p.querySelectorAll !== "function") p.querySelectorAll = () => [];
  if (typeof p.querySelector !== "function") p.querySelector = () => null;
  if (typeof p.closest !== "function") p.closest = () => null;
  p.getBoundingClientRect ??= () => ({ x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 400, width: 400, height: 400 });
  p.scrollTo ??= () => {};
  p.scrollIntoView ??= () => {};
  if (d && !d.set) Object.defineProperty(proto, "className", { ...d, set(this: { setAttribute: (k: string, v: string) => void }, v: string) { this.setAttribute("class", v); } });
}
const gx = globalThis as Record<string, unknown>;
gx.innerWidth ??= 1440;
{
  const doc = gx.document as Record<string, unknown>;
  doc.getElementById ??= () => null;
  if (typeof doc.querySelectorAll !== "function") doc.querySelectorAll = () => [];
  if (typeof doc.querySelector !== "function") doc.querySelector = () => null;
  doc.hasFocus ??= () => true;
}
gx.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
for (const k of ["ResizeObserver", "MutationObserver"]) gx[k] ??= class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
gx.innerHeight ??= 900;
gx.devicePixelRatio ??= 2;
gx.getComputedStyle ??= () => ({ font: "14px sans-serif", fontSize: "14px", getPropertyValue: () => "" });
gx.requestAnimationFrame ??= (f: (t: number) => void) => setTimeout(() => f(performance.now()), 0);
gx.cancelAnimationFrame ??= (id: number) => clearTimeout(id);

const ada = { id: "u1", name: "Ada", kind: "human" as const };
const bot = { id: "agent", name: "Friday", kind: "agent" as const };
const VOCAB = "the a to of and in is it that for on with as this file test run src const function return error build agent".split(" ");
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const text = (n: number) => { let s = ""; while (s.length < n) s += VOCAB[Math.floor(rnd() * VOCAB.length)] + (rnd() < 0.1 ? ".\n\n" : " "); return s.slice(0, n); };

/** A session of n events: turns of an instruction, a run with a command and its output, and an answer. */
export function feedLog(n: number): SessionEvent[] {
  const out: SessionEvent[] = [];
  const push = (actor: SessionEvent["actor"], body: EventBody) => out.push({ seq: out.length + 1, ts: 1_700_000_000_000 + out.length * 1000, actor, body });
  push(ada, { type: "session.created", title: "Perf", ownerId: ada.id, ownerName: ada.name } as never);
  push(ada, { type: "member.joined", role: "owner" } as never);
  for (let i = 0; out.length < n; i++) {
    push(ada, { type: "instruction", text: `Step ${i}: ${text(100)}`, interrupt: false } as never);
    const cause = out.length;
    push(bot, { type: "run.started", causedBy: cause } as never);
    push(bot, { type: "agent.message", text: text(200), toolCalls: [{ id: `c${i}`, name: "bash", arguments: JSON.stringify({ command: `ls src/${i}` }) }] } as never);
    push(bot, { type: "tool.result", callId: `c${i}`, name: "bash", output: text(800), isError: false } as never);
    push(bot, { type: "agent.message", text: text(500), toolCalls: [] } as never);
    push(bot, { type: "run.ended", outcome: "done" } as never);
  }
  return out.slice(0, n);
}

