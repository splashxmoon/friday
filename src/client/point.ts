/**
 * Point at the thing you mean.
 *
 * "The second button on the settings page is the wrong blue" is a sentence the
 * agent has to turn into a file and a line before it can do anything. Pointing
 * at the button hands it the selector, the words on it and the component it
 * came from, which is most of that work done.
 */

export interface Pick {
  selector: string;
  tag: string;
  /** The words on the element, trimmed. */
  text: string;
  /** The element's own opening markup, without what is inside it. */
  html: string;
  /** The React component that drew it, when the page is React in development. */
  component?: string;
  /** The components it sits inside, nearest first, when the page is React in development. */
  parents?: string[];
  /** Where the component is defined (file:line), when a React development build says. */
  source?: string;
  /** The styles that give it its look, as the browser computed them: what to change to change how it looks. */
  styles?: Record<string, string>;
  url: string;
  width: number;
  height: number;
}

/**
 * Runs inside the previewed page: outlines what the pointer is over, resolves
 * with a description of what gets clicked, or with null on Escape or cancel.
 * Plain ES2015 and self-contained, because it is sent over as text.
 */
export const POINT_SCRIPT = `(() => new Promise((resolve) => {
  if (window.__fridayPointCancel) window.__fridayPointCancel();
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #17171a;background:rgba(23,23,26,.12);border-radius:4px;left:0;top:0;width:0;height:0";
  const tip = document.createElement("div");
  tip.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;padding:2px 6px;border-radius:5px;background:#17171a;color:#fff;font:600 11px/1.4 ui-monospace,monospace;white-space:nowrap";
  document.documentElement.append(box, tip);
  const prevCursor = document.documentElement.style.cursor;
  document.documentElement.style.cursor = "crosshair";
  let cur = null;
  const css = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\\w-]/g, "\\\\$&"));
  const selectorOf = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
      if (n.id) { parts.unshift("#" + css(n.id)); break; }
      let p = n.tagName.toLowerCase();
      const cls = Array.from(n.classList).filter((c) => c.length < 24 && !/\\d{3,}|^css-|^_/.test(c)).slice(0, 2);
      if (cls.length) p += "." + cls.map(css).join(".");
      else if (n.parentElement) {
        const same = Array.from(n.parentElement.children).filter((c) => c.tagName === n.tagName);
        if (same.length > 1) p += ":nth-of-type(" + (same.indexOf(n) + 1) + ")";
      }
      parts.unshift(p);
      if (n === document.body) break;
    }
    return parts.join(" > ");
  };
  // The React components it sits in, nearest first, and where the nearest is defined (a development build keeps that).
  const componentsOf = (el) => {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    let f = key ? el[key] : null;
    const names = []; let source;
    for (let i = 0; f && i < 60 && names.length < 4; i++, f = f.return) {
      const t = f.type;
      if (t && typeof t !== "string") {
        const name = t.displayName || t.name || (t.render && (t.render.displayName || t.render.name));
        if (name && !/^(Fragment|Suspense|Provider|Consumer|ForwardRef|Memo)$/.test(name)) {
          names.push(name);
          const src = f._debugSource;
          if (!source && src && src.fileName) source = String(src.fileName).replace(new RegExp("^.*?/(src|app|pages|components|lib)/"), "$1/") + ":" + src.lineNumber;
        }
      }
    }
    return { names, source };
  };
  // The styles that give it its look, skipping what is only the browser's default.
  const stylesOf = (el) => {
    const cs = getComputedStyle(el);
    const out = {};
    const skip = new RegExp("^(none|normal|auto|0px|0px 0px|0px 0px 0px 0px|rgba[(]0, 0, 0, 0[)]|transparent|static|visible|1|0)$");
    for (const k of ["display", "position", "padding", "margin", "gap", "color", "background-color", "background-image", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-align", "border", "border-radius", "box-shadow", "opacity", "overflow"]) {
      const v = cs.getPropertyValue(k).trim();
      if (v && !skip.test(v)) out[k] = v.length > 80 ? v.slice(0, 77) + "…" : v;
    }
    return out;
  };
  const describe = (el) => {
    const r = el.getBoundingClientRect();
    const text = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("alt") || "").replace(/\\s+/g, " ").trim().slice(0, 120);
    const shell = el.cloneNode(false);
    const c = componentsOf(el);
    return { selector: selectorOf(el), tag: el.tagName.toLowerCase(), text, html: shell.outerHTML.slice(0, 300), component: c.names[0], parents: c.names.slice(1), source: c.source, styles: stylesOf(el), url: location.href, width: Math.round(r.width), height: Math.round(r.height) };
  };
  const move = (e) => {
    cur = e.target;
    if (!cur || cur === document.documentElement) return;
    const r = cur.getBoundingClientRect();
    box.style.cssText += ";left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;height:" + r.height + "px";
    tip.textContent = cur.tagName.toLowerCase() + " " + Math.round(r.width) + "×" + Math.round(r.height);
    tip.style.left = Math.max(4, r.left) + "px";
    tip.style.top = (r.top > 22 ? r.top - 22 : r.bottom + 4) + "px";
  };
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
  const done = (v) => {
    for (const t of ["mousemove"]) removeEventListener(t, move, true);
    for (const t of ["click", "mousedown", "mouseup", "pointerdown", "pointerup"]) removeEventListener(t, onClick, true);
    removeEventListener("keydown", onKey, true);
    box.remove(); tip.remove();
    document.documentElement.style.cursor = prevCursor;
    window.__fridayPointCancel = undefined;
    resolve(v);
  };
  const onClick = (e) => { stop(e); if (e.type === "click" && cur) done(describe(cur)); };
  const onKey = (e) => { if (e.key === "Escape") { stop(e); done(null); } };
  addEventListener("mousemove", move, true);
  for (const t of ["click", "mousedown", "mouseup", "pointerdown", "pointerup"]) addEventListener(t, onClick, true);
  addEventListener("keydown", onKey, true);
  window.__fridayPointCancel = () => done(null);
}))()`;

/** Stops a pick that is under way, from outside the page. */
export const POINT_CANCEL = `window.__fridayPointCancel && window.__fridayPointCancel()`;

/**
 * For a preview served on a site of its own, which Friday can't reach into: Friday puts this in the page (/api/preview in
 * app.ts), and it runs POINT_SCRIPT when, and only when, Friday's window framing it asks by message, and answers Friday only.
 * Nothing it is sent is run. It takes its own tag out once run, so the page's DOM is what the dev server sent.
 */
export function pointBridge(parentOrigin: string): string {
  const to = JSON.stringify(parentOrigin);
  return `(() => {
  document.currentScript && document.currentScript.remove();
  addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== parent || e.origin !== ${to} || !d || d.type !== "friday-point") return;
    if (d.cancel) return void (window.__fridayPointCancel && window.__fridayPointCancel());
    parent.postMessage({ type: "friday-point", id: d.id, ready: true }, ${to});
    ${POINT_SCRIPT}.then((pick) => parent.postMessage({ type: "friday-point", id: d.id, pick: pick }, ${to}));
  });
})();`;
}

/** What goes in the message box: where it is, what it says, and where it came from. */
export function describePick(p: Pick): string {
  let where = p.url;
  try {
    const u = new URL(p.url);
    where = u.pathname + u.search;
  } catch {
    // Not an address; say it as it came.
  }
  const lines = [`About this element on ${where}:`, `- selector: \`${p.selector}\``];
  if (p.text) lines.push(`- text: “${p.text}”`);
  if (p.component) lines.push(`- drawn by the ${p.component} component${p.source ? ` (${p.source})` : ""}${p.parents?.length ? `, inside ${p.parents.join(" > ")}` : ""}`);
  lines.push(`- size: ${p.width}×${p.height}`);
  const styles = Object.entries(p.styles ?? {});
  if (styles.length) lines.push(`- its styles, as computed: ${styles.map(([k, v]) => `${k}: ${v}`).join("; ")}`);
  lines.push("```html", p.html, "```", "");
  return lines.join("\n");
}

/** Add to what is already in the box rather than replacing it, and leave the cursor after it. */
export function addToComposer(text: string): boolean {
  const el = document.getElementById("composer-input") as HTMLTextAreaElement | null;
  if (!el) return false;
  const next = el.value.trim() ? `${el.value.replace(/\s+$/, "")}\n\n${text}` : text;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, next);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
  el.setSelectionRange(next.length, next.length);
  return true;
}
