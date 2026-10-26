import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * One small tooltip for a session's controls, in place of the browser's own: the header, the chat, the message box and the
 * status bar.
 *
 * Every button there already says what it does in its `title`. The browser shows that late, in the system's font, and
 * nowhere near the app's look. This takes the same words and shows them the app's way: after a short rest on a control,
 * then at once for the next one while one is showing (moving along a toolbar shouldn't wait each time), above the control,
 * or below it at the top of the window. A shortcut at the end ("Files · Ctrl+2") is set as keys. Shown on keyboard focus
 * too. The title becomes `data-tip`, so the browser's tooltip doesn't show as well, and an icon-only control keeps its
 * spoken name.
 */

const SCOPE = ".session-view, #band-left, #band-slot, .topbar, .status-bar, .board-page, .review-page, .usage-page, .ap-strip";
const FIRST_MS = 450;
/** A tip shown less than this long ago makes the next one instant. */
const WARM_MS = 500;
/** From its control, and the least it keeps from a window edge. */
const GAP = 8;
const EDGE = 8;

type Tip = TipShape & { rect: DOMRect; instant: boolean };

export type TipShape = { head: string; /** A line each, under the name. */ body: string[]; keys: string | null };

/** A line telling you what you can do with the control (drag it, double-click it), set quieter than what it is. */
export const isHowTo = (line: string) => /^(drag|double-click|right-click|click|press|hold|shift-click|scroll)\b/i.test(line);

const KEYS = /^(?:(?:⌘|⌃|Ctrl\+|Alt\+|Shift\+|⇧|⌥)\S*|[A-Za-z?] then [A-Za-z]|g [a-z])$/;

/**
 * A tip's words as a name and what it says about it (Arun, 2026-10-24: "design the hover tooltips better ... they need
 * proper typography"): one bold line, and under it, in a quieter line, the rest. "Manual: Edits files, and asks you…" is
 * Manual over the sentence; a run of parts ("Codex · ⌃2 · drag onto the chat to open beside") is the first part over the
 * others, once it is too long for one line. A shortcut, wherever it is among the parts, is set as keys beside the name.
 */
export function shapeTip(t: string): TipShape {
  const parts = t.split(/\s+·\s+/);
  const k = parts.findIndex((p, i) => i > 0 && KEYS.test(p));
  const keys = k > 0 ? parts.splice(k, 1)[0]! : null;
  const all = parts.join(" · ");
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
  // "Name: what it is", with a short name and a sentence after it. "6:34 PM" has no space after its colon, so it stays whole.
  // "Name: what it is" in the first part, with a short name and a sentence after it. "6:34 PM" has no space after its colon,
  // so it stays whole; a colon further along ("Codex · Asking you: …") belongs to its own line, not to the name.
  const named = /^([^:.]{2,40}):\s+(.{12,})$/s.exec(parts[0]!);
  if (named) return { head: named[1]!, body: [named[2]!, ...parts.slice(1)].map(cap), keys };
  if (parts.length > 1 && all.length > 44) return { head: parts[0]!, body: parts.slice(1).map(cap), keys };
  return { head: all, body: [], keys };
}

/** "Files · Ctrl+2" → the words and the shortcut, when the last part reads as one. */
export function splitTip(t: string): { text: string; keys: string | null } {
  const m = t.match(/^(.*?)\s*·\s*((?:⌘|Ctrl\+|Alt\+|Shift\+|⇧|⌥)[^\s·]*|[A-Za-z?] then [A-Za-z]|g [a-z])$/);
  return m && m[1] ? { text: m[1], keys: m[2]! } : { text: t, keys: null };
}

/**
 * Whether a control's tip tells anybody anything. A button that says what it does in words ("Commit on branch") doesn't
 * need it said again in a box: only one without words (an icon, or an icon and a count), one whose words are cut off, and
 * one with a shortcut to learn get one.
 */
export function worthATip(said: string, tip: string, truncated: boolean): boolean {
  if (!/[a-z]{3}/i.test(said)) return true;
  if (shapeTip(tip).keys) return true;
  return truncated;
}

const cutOff = (el: HTMLElement) =>
  el.scrollWidth > el.clientWidth + 1 || Array.from(el.querySelectorAll<HTMLElement>("*")).some((c) => c.scrollWidth > c.clientWidth + 1 && getComputedStyle(c).textOverflow === "ellipsis");

function targetOf(e: Event): HTMLElement | null {
  const el = (e.target as Element | null)?.closest?.("[title], [data-tip]") as HTMLElement | null;
  if (!el || !el.closest(SCOPE) || el.closest("svg")) return null;
  const t = el.getAttribute("title");
  if (t) {
    // An icon-only control was named by its title: keep that name for screen readers once the title is gone.
    if (!el.getAttribute("aria-label") && !el.textContent?.trim()) el.setAttribute("aria-label", t);
    el.setAttribute("data-tip", t);
    // Gone either way: a control that isn't worth a tip shouldn't get the browser's own instead.
    el.removeAttribute("title");
  }
  const tip = el.getAttribute("data-tip");
  return tip && worthATip((el.textContent ?? "").replace(/\s+/g, " ").trim(), tip, cutOff(el)) ? el : null;
}

export function Tooltips() {
  const [tip, setTip] = useState<Tip | null>(null);
  useEffect(() => {
    let timer: number | undefined;
    let shownAt = 0;
    let current: HTMLElement | null = null;
    // Where the control was when its tip went up: a scroll somewhere else (the chat following new words) leaves it be.
    let at = "";
    const show = (el: HTMLElement, instant: boolean) => {
      const r = el.getBoundingClientRect();
      at = `${Math.round(r.left)},${Math.round(r.top)}`;
      setTip({ ...shapeTip(el.getAttribute("data-tip")!), rect: r, instant });
      shownAt = Date.now();
    };
    const hide = () => {
      window.clearTimeout(timer);
      if (current) shownAt = Date.now();
      current = null;
      setTip(null);
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const el = targetOf(e);
      if (el === current) return;
      window.clearTimeout(timer);
      if (!el) return hide();
      current = el;
      const r = el.getBoundingClientRect();
      at = `${Math.round(r.left)},${Math.round(r.top)}`;
      const warm = Date.now() - shownAt < WARM_MS;
      if (warm) show(el, true);
      else {
        setTip(null);
        timer = window.setTimeout(() => current === el && el.isConnected && show(el, false), FIRST_MS);
      }
    };
    const focus = (e: FocusEvent) => {
      const el = targetOf(e);
      if (!el || !(e.target as HTMLElement).matches(":focus-visible")) return;
      current = el;
      show(el, true);
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", hide);
    document.addEventListener("keydown", hide, true);
    const scrolled = () => {
      if (!current) return;
      const r = current.getBoundingClientRect();
      if (`${Math.round(r.left)},${Math.round(r.top)}` !== at) hide();
    };
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("blur", hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("keydown", hide, true);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  // Placed once its size is known, before it is drawn: above its control, or below where there is no room above (or the
  // control is in the window's top bar); centred on it, moved in from a window edge only as far as its width needs, and
  // its pointer still under the control's middle.
  const el = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const t = el.current;
    if (!tip || !t) return;
    const r = tip.rect;
    const w = t.offsetWidth;
    const h = t.offsetHeight;
    const above = r.top - GAP - h >= EDGE;
    const below = r.bottom + GAP + h <= innerHeight - EDGE;
    const under = below && (r.top < 64 || !above);
    const mid = r.left + r.width / 2;
    const left = Math.min(Math.max(mid - w / 2, EDGE), innerWidth - w - EDGE);
    t.style.left = `${Math.round(left)}px`;
    t.style.top = `${Math.round(under ? r.bottom + GAP : Math.max(EDGE, r.top - GAP - h))}px`;
    t.style.setProperty("--arrow", `${Math.round(Math.min(Math.max(mid - left, 12), w - 12))}px`);
    t.dataset.side = under ? "below" : "above";
  }, [tip]);
  if (!tip) return null;
  // On the page's body, beside the popovers (which are portalled there too): drawn inside the shell, a tip on a control in
  // a popover, such as the agent picker's tool icons, sat behind the popover it belonged to.
  return createPortal(
    <div ref={el} className={`tip${tip.body.length ? " two" : ""}${tip.instant ? " instant" : ""}`} role="tooltip">
      <span className="tip-head">
        <span>{tip.head}</span>
        {tip.keys && <kbd>{tip.keys}</kbd>}
      </span>
      {tip.body.map((line, i) => (
        <span key={i} className={`tip-body${isHowTo(line) ? " how" : ""}`}>
          {line}
        </span>
      ))}
    </div>,
    document.body,
  );
}
