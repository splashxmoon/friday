/**
 * Deep Dive's code map: how a repo's code fits together, read from its own imports with no model (code-graph.ts, code-map.ts). Built
 * 2026-11-22 ("visualizing or making a web of connections or showing how your code works", "Both, a switch"), rebuilt 2026-11-23
 * (Arun: "you have to completely rewrite and redesign and actually put in the effort for the code map thing … design, logic, UX").
 *
 * It opens on a sentence saying how the code runs ("Starts in 5 places, runs through a ring of 13 parts that all use one another,
 * and rests on Router management"), over two drawings of the same parts:
 * - Layers, an architecture diagram read top to bottom: where the code starts, the middle, what it rests on, with the parts standing
 *   apart as chips at the foot. A block's width is its size, and it says what the part does, from the Deep Dive page about it. No
 *   lines at rest, so nothing tangles.
 * - Web, every link at once: the same parts as names, pulled near what they talk to, still reading top to bottom.
 * The parts slide from one drawing to the other.
 *
 * Pointing at a part draws its own links: blue to what it uses, amber from what uses it, each counted on the part at the other end;
 * the rest fades. Choosing one keeps that and opens it at the side: its page, what it uses and what uses it (each a way on to that
 * part), everything it needs or a change to it could reach in all, and its files, each opening its code. The line along the foot
 * always says what's shown. A file can be found by name; arrows move between parts; Escape lets go.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Choice } from "@/components/dass";
import type { CodeGraph } from "../code-graph.js";
import { BAND_SAYS, BAND_WORDS, buildMap, describeMap, reach, routeLayers, separate, stackLayout, STACK, webLayout, type Band, type Box, type CodeMapModel, type Part } from "../code-map.js";
import { Icon } from "./icons.js";
import { Switch } from "./ui.js";
import "./code-map.css";

type Shape = "layers" | "web";
type Reach = "needs" | "affects" | null;
const SHAPE_KEY = "friday.deepdive.mapShape";
/** A part's name as a chip or a pill: 12.5px type, an icon or dot, and the padding round them. */
const PILL_H = 30;
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;
const kLines = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const baseName = (f: string) => f.slice(f.lastIndexOf("/") + 1);
const dirName = (f: string) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "");

/** What a part does: its page's purpose, else what its links say. */
const sayOf = (p: Part) =>
  p.purpose ||
  (p.band === "start" ? `Uses ${plural(p.uses, "part")}; nothing here uses it` : p.band === "base" ? `Used by ${plural(p.usedBy, "part")}; uses none` : p.band === "apart" ? "Linked to no other part" : `Used by ${plural(p.usedBy, "part")}, uses ${p.uses}`);
/** Where a part sits, in words, for the panel. */
const whereOf = (m: CodeMapModel, i: number) => {
  const p = m.parts[i]!;
  const ring = p.ring >= 0 ? m.rings[p.ring]! : null;
  if (p.band === "start") return "Where the code starts: nothing in the repo uses it";
  if (p.band === "base") return "A foundation: it uses nothing of the repo's own";
  if (p.band === "apart") return "Stands apart: linked to no other part";
  if (ring && ring.length >= 3) return `In the middle, in a ring of ${ring.length} parts that use one another`;
  if (ring) return `In the middle; it and ${m.parts[ring.find((j) => j !== i)!]!.name} use each other`;
  return "In the middle";
};

/** Text widths, measured with the page's own font, so chips and pills fit their names. */
function useMeasure(font: string) {
  return useMemo(() => {
    const ctx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
    if (ctx) ctx.font = font;
    return (s: string) => (ctx ? ctx.measureText(s).width : s.length * 7);
  }, [font]);
}

interface Drawn {
  boxes: Box[];
  height: number;
  bands: { band: Band; y: number; h: number; n: number }[];
  rings: (Box & { n: number })[];
  /** Where Web's row of parts standing apart starts. */
  apartY?: number;
}

/** Web's places, fitted to the stage: the web scaled into the room over the row of parts standing apart, then pulled clear of overlaps. */
function fitWeb(m: CodeMapModel, at: ({ x: number; y: number } | null)[], W: number, H: number, pill: (i: number) => number): Drawn {
  const pad = 24;
  const boxes: Box[] = new Array(m.parts.length);
  // The row of parts standing apart, at the foot.
  const apart = m.parts.map((_, i) => i).filter((i) => !at[i]);
  const rows: number[][] = [[]];
  let used = 0;
  for (const i of apart) {
    const w = pill(i);
    if (rows[rows.length - 1]!.length && used + 8 + w > W - 2 * pad) rows.push([]), (used = 0);
    used += (used ? 8 : 0) + w;
    rows[rows.length - 1]!.push(i);
  }
  const apartH = apart.length ? STACK.head + rows.length * (PILL_H + 8) - 8 : 0;
  const height = Math.max(H, 460);
  const apartY = height - pad - apartH;
  rows.forEach((r, k) => {
    const total = r.reduce((s, i) => s + pill(i), 0) + 8 * (r.length - 1);
    let x = (W - total) / 2;
    for (const i of r) (boxes[i] = { x, y: apartY + STACK.head + k * (PILL_H + 8), w: pill(i), h: PILL_H }), (x += pill(i) + 8);
  });
  const placed = m.parts.map((_, i) => i).filter((i) => at[i]);
  if (placed.length) {
    const xs = placed.map((i) => at[i]!.x), ys = placed.map((i) => at[i]!.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const widest = Math.max(...placed.map(pill));
    const roomW = W - 2 * pad - widest, roomH = apartY - (apart.length ? 18 : 0) - 2 * pad - PILL_H;
    const s = Math.min(roomW / Math.max(1, x1 - x0), roomH / Math.max(1, y1 - y0), 1.6);
    const ox = (W - (x1 - x0) * s) / 2, oy = pad + PILL_H / 2 + (roomH - (y1 - y0) * s) / 2;
    const room = { x: pad, y: pad, w: W - 2 * pad, h: apartY - (apart.length ? 18 : 0) - pad };
    separate(
      placed.map((i) => ({ x: ox + (at[i]!.x - x0) * s - pill(i) / 2, y: oy + (at[i]!.y - y0) * s - PILL_H / 2, w: pill(i), h: PILL_H })),
      10,
      160,
      room,
    ).forEach((b, k) => (boxes[placed[k]!] = b));
  }
  return { boxes, height, bands: [], rings: [], ...(apart.length ? { apartY } : {}) };
}

/** A route's corner points as a path, each square turn eased into a small round one, as a diagram's lines turn. */
function rounded(pts: { x: number; y: number }[], r = 7) {
  const p = pts.filter((q, i) => !i || Math.hypot(q.x - pts[i - 1]!.x, q.y - pts[i - 1]!.y) > 0.5);
  let d = `M ${p[0]!.x} ${p[0]!.y}`;
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1]!, c = p[i]!, b = p[i + 1]!;
    const la = Math.hypot(c.x - a.x, c.y - a.y), lb = Math.hypot(b.x - c.x, b.y - c.y);
    const k = Math.min(r, la / 2, lb / 2);
    d += ` L ${c.x - ((c.x - a.x) / la) * k} ${c.y - ((c.y - a.y) / la) * k} Q ${c.x} ${c.y} ${c.x + ((b.x - c.x) / lb) * k} ${c.y + ((b.y - c.y) / lb) * k}`;
  }
  const z = p[p.length - 1]!;
  return `${d} L ${z.x} ${z.y}`;
}

/** Web's line from one name to another: a gentle bend, always to the same side, from edge to edge of their pills. */
function webPath(a: Box, b: Box) {
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2;
  const d = Math.max(1, Math.hypot(bx - ax, by - ay));
  const qx = (ax + bx) / 2 - ((by - ay) / d) * d * 0.1, qy = (ay + by) / 2 + ((bx - ax) / d) * d * 0.1;
  // Where the way from a box's centre towards the bend leaves the box.
  const edge = (bx0: Box, cx: number, cy: number, extra: number) => {
    const ox = bx0.x + bx0.w / 2, oy = bx0.y + bx0.h / 2;
    const dx = cx - ox, dy = cy - oy;
    const t = Math.min(Math.abs(bx0.w / 2 / (dx || 1e-6)), Math.abs(bx0.h / 2 / (dy || 1e-6)));
    const len = Math.hypot(dx, dy) || 1;
    return `${ox + dx * t + (dx / len) * extra} ${oy + dy * t + (dy / len) * extra}`;
  };
  return `M ${edge(a, qx, qy, 1)} Q ${qx} ${qy} ${edge(b, qx, qy, 4)}`;
}

export function CodeMap({ graph, pages, onPage }: { graph: CodeGraph; pages: readonly { id: string; title: string; purpose?: string; files: string[] }[]; onPage: (id: string) => void }) {
  const [shape, setShape] = useState<Shape>(() => {
    try {
      return localStorage.getItem(SHAPE_KEY) === "web" ? "web" : "layers";
    } catch {
      return "layers";
    }
  });
  const model = useMemo(() => buildMap(graph, pages), [graph, pages]);
  const summary = useMemo(() => describeMap(model), [model]);
  const web = useMemo(() => webLayout(model), [model]);

  // The stage's size, followed as the window or the side panel changes it.
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [font, setFont] = useState("500 12.5px sans-serif");
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ff = getComputedStyle(el).fontFamily;
    if (ff) setFont(`500 12.5px ${ff}`);
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  // Measured again once the app's own font has loaded, so names measured in a fallback font don't end up cut short.
  const [fonts, setFonts] = useState(0);
  useEffect(() => void document.fonts?.ready.then(() => setFonts((n) => n + 1)), []);
  const measure = useMeasure(`${font}${fonts ? "" : " "}`);
  const dotOf = (p: Part) => Math.round(6 + Math.min(8, Math.sqrt(p.lines) / 24));
  // A chip (Layers' parts standing apart): icon, gap, name, padding and border. A pill (Web): its dot in place of the icon.
  const chipW = useCallback((name: string) => Math.ceil(measure(name) + 12 + 7 + 22 + 2 + 4), [measure]);
  const pillW = useCallback((i: number) => Math.ceil(measure(model.parts[i]!.name) + dotOf(model.parts[i]!) + 8 + 22 + 2 + 4), [measure, model]);

  const [hover, setHover] = useState<number | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [peek, setPeek] = useState<number | null>(null);
  const [found, setFound] = useState<number | null>(null);
  const [reachOf, setReachOf] = useState<Reach>(null);

  const drawn: Drawn | null = useMemo(() => {
    if (!size.w) return null;
    if (shape === "web") return fitWeb(model, web, size.w, size.h, pillW);
    const s = stackLayout(model, size.w, chipW);
    return { boxes: s.boxes, height: Math.max(s.height, size.h), bands: s.bands, rings: s.rings };
  }, [shape, model, web, size.w, size.h, pillW, chipW]);

  // The parts slide to their new places when the drawing changes; the lines wait until they're there.
  const [settling, setSettling] = useState(false);
  const [ready, setReady] = useState(false);
  const firstDrawn = useRef(true);
  useEffect(() => {
    if (!drawn) return;
    if (firstDrawn.current) {
      firstDrawn.current = false;
      const r = requestAnimationFrame(() => setReady(true));
      return () => cancelAnimationFrame(r);
    }
    setSettling(true);
    const t = setTimeout(() => setSettling(false), 460);
    return () => clearTimeout(t);
  }, [drawn]); // eslint-disable-line react-hooks/exhaustive-deps

  // What's shown: the part pointed at, else the one chosen; its own links, and with the panel's switch, all it needs or could reach.
  const focus = hover ?? sel;
  const rel = useMemo(() => {
    if (focus === null) return null;
    const uses = new Map<number, number>(), by = new Map<number, number>();
    for (const l of model.links) {
      if (l.from === focus) uses.set(l.to, l.n);
      if (l.to === focus) by.set(l.from, l.n);
    }
    const wide = hover === null && sel !== null && reachOf ? reach(model, sel, reachOf === "needs" ? "down" : "up") : null;
    return { uses, by, wide };
  }, [focus, hover, sel, reachOf, model]);

  const links = useMemo(() => {
    if (!drawn) return [];
    const max = Math.max(1, ...model.links.map((l) => l.n));
    // In Layers a ring's parts sit together in their box, and its links to one another are counted on the parts instead of drawn:
    // drawn, a ring of thirteen was a knot of two dozen lines inside one box.
    const inBox = (a: number, b: number) => {
      const r = model.parts[a]!.ring;
      return r >= 0 && r === model.parts[b]!.ring && model.rings[r]!.length >= 3;
    };
    const shown = shape === "web" ? model.links : focus === null ? [] : model.links.filter((l) => (l.from === focus || l.to === focus) && !inBox(l.from, l.to));
    // Layers' lines keep clear of the bands' and rings' names as well as the blocks.
    const keep = [...drawn.bands.map((b) => ({ x: STACK.pad - 4, y: b.y, w: 420, h: 22 })), ...drawn.rings.map((r) => ({ x: r.x, y: r.y, w: 240, h: 21 }))];
    const d = shape === "web" ? shown.map((l) => webPath(drawn.boxes[l.from]!, drawn.boxes[l.to]!)) : routeLayers(drawn.boxes, shown, size.w, keep).map((r) => rounded(r));
    return shown.map((l, k) => ({
      key: `${l.from}>${l.to}`,
      d: d[k]!,
      w: 1 + 1.8 * Math.sqrt(l.n / max),
      kind: focus === null ? "" : l.from === focus ? "uses" : l.to === focus ? "by" : "dim",
      title: `${model.parts[l.from]!.name} uses ${model.parts[l.to]!.name}: ${plural(l.n, "import")}`,
    }));
  }, [drawn, shape, focus, model, size.w]);

  const choose = (i: number | null) => {
    setSel((s) => (i === null || s === i ? null : i));
    setReachOf(null);
    setFound(null);
    setHover(null);
  };
  // A part chosen from the panel or found by a file comes into view.
  const show = (i: number) => {
    const el = stage.current, b = drawn?.boxes[i];
    if (!el || !b) return;
    if (b.y < el.scrollTop + 8 || b.y + b.h > el.scrollTop + el.clientHeight - 48) el.scrollTo({ top: Math.max(0, b.y - 60), behavior: "smooth" });
  };
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (reachOf) setReachOf(null);
      else (setSel(null), setFound(null));
    };
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [reachOf]);
  // Arrows move between parts: to the nearest one that way.
  const arrow = (e: ReactKeyboardEvent, i: number) => {
    const way = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key];
    if (!way || !drawn) return;
    e.preventDefault();
    const c = (b: Box) => [b.x + b.w / 2, b.y + b.h / 2] as const;
    const [x, y] = c(drawn.boxes[i]!);
    let best = -1, score = Infinity;
    drawn.boxes.forEach((b, j) => {
      if (j === i || !b) return;
      const [bx, by] = c(b);
      const along = (bx - x) * way[0] + (by - y) * way[1];
      if (along <= 4) return;
      const across = Math.abs((bx - x) * way[1]) + Math.abs((by - y) * way[0]);
      if (along + across * 2.2 < score) (score = along + across * 2.2), (best = j);
    });
    if (best >= 0) stage.current?.querySelector<HTMLElement>(`[data-part="${best}"]`)?.focus();
  };

  const changeShape = (s: Shape) => {
    setShape(s);
    try {
      localStorage.setItem(SHAPE_KEY, s);
    } catch {}
  };

  const relOf = (i: number): string => {
    if (!rel || focus === null) return "";
    if (i === focus) return " is-focus";
    if (rel.wide) return rel.wide.has(i) ? (reachOf === "needs" ? " is-uses" : " is-by") : " is-dim";
    const u = rel.uses.has(i), b = rel.by.has(i);
    return u && b ? " is-uses is-by" : u ? " is-uses" : b ? " is-by" : " is-dim";
  };
  const part = sel !== null ? model.parts[sel]! : null;
  const fp = focus !== null ? model.parts[focus]! : null;

  return (
    <section className="cm" aria-label="Code map">
      <header className="cm-head">
        <div className="cm-title">
          <h2>
            Code map
            <span>
              {plural(graph.files.length, "file")}
              {graph.more ? " read" : ""} · {plural(model.parts.length, "part")}
              {graph.tests ? ` · ${plural(graph.tests, "test file")} left out` : ""}
            </span>
          </h2>
          <p>{summary}</p>
        </div>
        <div className="cm-tools">
          <FindFile graph={graph} onFind={(i) => (setSel(model.partOf[i]!), setReachOf(null), setFound(i), show(model.partOf[i]!))} />
          <Choice<Shape> label="Drawing" value={shape} onChange={changeShape} options={[["layers", "Layers"], ["web", "Web"]]} />
        </div>
      </header>
      <div className={`cm-body${part ? " has-panel" : ""}`}>
        <div className="cm-frame">
          <div
            ref={stage}
            className={`cm-stage cm-${shape}${ready ? " is-ready" : ""}${focus !== null ? " is-focused" : ""}`}
            onClick={(e) => e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("cm-plane") ? choose(null) : undefined}
          >
            {drawn && (
              <div className="cm-plane" style={{ height: drawn.height }} onClick={(e) => e.target === e.currentTarget && choose(null)}>
                {drawn.bands.map((b, k) => (
                  <div key={b.band} className="cm-band" style={{ top: b.y, left: STACK.pad, right: STACK.pad }}>
                    <b>{BAND_WORDS[b.band]}</b>
                    <span>{BAND_SAYS[b.band]}</span>
                    {k > 0 && <Icon name="arrowDown" size={13} className="cm-band-down" />}
                  </div>
                ))}
                {drawn.rings.map((r) => (
                  <div key={r.y} className="cm-ring" style={{ top: r.y, left: r.x, width: r.w, height: r.h }}>
                    <span>{r.n} parts that all use one another</span>
                  </div>
                ))}
                {drawn.apartY !== undefined && (
                  <div className="cm-band" style={{ top: drawn.apartY, left: STACK.pad, right: STACK.pad }}>
                    <b>{BAND_WORDS.apart}</b>
                    <span>{BAND_SAYS.apart}</span>
                  </div>
                )}
                <svg className={`cm-lines${settling ? " is-settling" : ""}`} width="100%" height={drawn.height} aria-hidden="true">
                  <defs>
                    {(["uses", "by"] as const).map((k) => (
                      <marker key={k} id={`cm-head-${k}`} viewBox="0 0 8 8" refX="6.5" refY="4" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                        <path d="M 0 0.8 L 7 4 L 0 7.2 z" className={`cm-head-${k}`} />
                      </marker>
                    ))}
                  </defs>
                  {shape === "layers" && links.map((l) => <path key={`h${l.key}`} d={l.d} className="cm-halo" />)}
                  {links.map((l) => (
                    <path key={l.key} d={l.d} className={`cm-line ${l.kind}`} style={{ strokeWidth: l.w }} markerEnd={l.kind === "uses" || l.kind === "by" ? `url(#cm-head-${l.kind})` : undefined}>
                      <title>{l.title}</title>
                    </path>
                  ))}
                </svg>
                {model.parts.map((p, i) => {
                  const b = drawn.boxes[i];
                  if (!b) return null;
                  const kind = shape === "web" ? "pill" : p.band === "apart" ? "chip" : "block";
                  const uses = rel?.uses.get(i), by = rel?.by.get(i);
                  const dot = dotOf(p);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      data-part={i}
                      className={`cm-part is-${kind}${sel === i ? " is-sel" : ""}${peek === i ? " is-peek" : ""}${relOf(i)}`}
                      style={{ transform: `translate(${b.x}px, ${b.y}px)`, width: b.w, height: b.h, "--dot": `${dot}px` } as CSSProperties}
                      aria-pressed={sel === i}
                      aria-label={`${p.name}. ${sayOf(p).replace(/\.$/, "")}. ${plural(p.files.length, "file")}, ${kLines(p.lines)} lines`}
                      onPointerEnter={() => setHover(i)}
                      onPointerLeave={() => setHover((h) => (h === i ? null : h))}
                      onFocus={() => setHover(i)}
                      onBlur={() => setHover((h) => (h === i ? null : h))}
                      onClick={() => (choose(i), sel !== i && requestAnimationFrame(() => show(i)))}
                      onKeyDown={(e) => arrow(e, i)}
                    >
                      <span className="cm-part-name">
                        <span className="cm-part-dot" aria-hidden="true" />
                        <Icon name={p.page ? "book" : "folder"} size={12} className="cm-part-icon" />
                        <span className="cm-part-label" title={p.name}>{p.name}</span>
                      </span>
                      {kind === "block" && (
                        <>
                          <span className="cm-part-say">{sayOf(p)}</span>
                          <span className="cm-part-meta">
                            <span>
                              {plural(p.files.length, "file")} · {kLines(p.lines)} lines
                            </span>
                            {p.usedBy > 0 && <span>used by {p.usedBy}</span>}
                          </span>
                        </>
                      )}
                      {kind !== "pill" && (uses !== undefined || by !== undefined) && (
                        <span className="cm-tags" aria-hidden="true">
                          {uses !== undefined && (
                            <span className="cm-tag uses" title={`${fp?.name} uses it: ${plural(uses, "import")}`}>
                              {uses}
                            </span>
                          )}
                          {by !== undefined && (
                            <span className="cm-tag by" title={`It uses ${fp?.name}: ${plural(by, "import")}`}>
                              {by}
                            </span>
                          )}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {/* What's shown, always said along the foot. */}
          <p className="cm-status" aria-live="polite">
            {fp === null || rel === null ? (
              "Point at a part to see what it uses and what uses it · choose one to follow it"
            ) : rel.wide ? (
              <>
                <b>{fp.name}</b>
                {reachOf === "needs" ? (
                  <>
                    <i className="cm-key uses" /> needs {plural(rel.wide.size, "part")} in all, directly or through others
                  </>
                ) : (
                  <>
                    <i className="cm-key by" /> a change to it can reach {plural(rel.wide.size, "part")}
                  </>
                )}
              </>
            ) : (
              <>
                <b>{fp.name}</b>
                {fp.uses > 0 && (
                  <span className="cm-status-key">
                    <i className="cm-key uses" /> uses {fp.uses}
                  </span>
                )}
                {fp.usedBy > 0 && (
                  <span className="cm-status-key">
                    <i className="cm-key by" /> used by {fp.usedBy}
                  </span>
                )}
                {!fp.uses && !fp.usedBy && <span>linked to no other part</span>}
                {/* Web shows names only: what the part does is said here. */}
                {shape === "web" && fp.purpose && <span className="cm-status-say">{fp.purpose}</span>}
                {sel !== null && hover === null && <span className="cm-status-esc">Esc to let go</span>}
              </>
            )}
          </p>
        </div>
        {part && sel !== null && (
          <PartPanel
            key={part.id}
            graph={graph}
            model={model}
            index={sel}
            found={found}
            reachOf={reachOf}
            onReach={setReachOf}
            onClose={() => choose(null)}
            onPart={(i) => (setSel(i), setReachOf(null), setFound(null), setPeek(null), requestAnimationFrame(() => show(i)))}
            onPeek={setPeek}
            onPage={onPage}
          />
        )}
      </div>
    </section>
  );
}

type Tab = "uses" | "by" | "files";

/**
 * The chosen part, beside the drawing (Arun, 2026-11-23: "design this better"). Its name, where it sits and what it does, then three
 * tabs that are also its numbers: what it uses, what uses it, its files. Each list is ranked, and each row is its own bar, tinted the
 * colour of its lines on the map. A switch over each list lights the whole chain that way on the map: all it needs, or all a change to
 * it could reach.
 */
function PartPanel({
  graph,
  model,
  index,
  found,
  reachOf,
  onReach,
  onClose,
  onPart,
  onPeek,
  onPage,
}: {
  graph: CodeGraph;
  model: CodeMapModel;
  index: number;
  found: number | null;
  reachOf: Reach;
  onReach: (r: Reach) => void;
  onClose: () => void;
  onPart: (i: number) => void;
  onPeek: (i: number | null) => void;
  onPage: (id: string) => void;
}) {
  const p = model.parts[index]!;
  const uses = useMemo(() => model.links.filter((l) => l.from === index).sort((a, b) => b.n - a.n), [model, index]);
  const usedBy = useMemo(() => model.links.filter((l) => l.to === index).sort((a, b) => b.n - a.n), [model, index]);
  const needs = useMemo(() => reach(model, index, "down").size, [model, index]);
  const affects = useMemo(() => reach(model, index, "up").size, [model, index]);
  // Each file's links: how many of the repo's files use it, and how many it uses.
  const counts = useMemo(() => {
    const c = new Map<number, { out: number; in: number }>();
    for (const i of p.files) c.set(i, { out: 0, in: 0 });
    for (const [a, b] of graph.edges) {
      if (c.has(a)) c.get(a)!.out++;
      if (c.has(b)) c.get(b)!.in++;
    }
    return c;
  }, [graph, p]);
  const [tab, setTab] = useState<Tab>(() => (found !== null ? "files" : uses.length ? "uses" : usedBy.length ? "by" : "files"));
  const [all, setAll] = useState(false);
  const files = useMemo(
    () => [...p.files].sort((a, b) => (a === found ? -1 : b === found ? 1 : counts.get(b)!.in - counts.get(a)!.in || (graph.lines[b] ?? 0) - (graph.lines[a] ?? 0))),
    [p, found, counts, graph],
  );
  const list = all ? files : files.slice(0, 24);
  // The folder its files share, said once over the list rather than on every row.
  const shared = useMemo(() => {
    const dirs = p.files.map((i) => dirName(graph.files[i]!).split("/"));
    const out: string[] = [];
    for (let k = 0; dirs.every((d) => d[k] !== undefined && d[k] !== "" && d[k] === dirs[0]![k]); k++) out.push(dirs[0]![k]!);
    return out.length ? out.join("/") : null;
  }, [p, graph]);
  const most = Math.max(1, ...files.map((i) => counts.get(i)!.in));
  const open = (f: string) => dispatchEvent(new CustomEvent("friday:open-file", { detail: { path: f, line: 1 }, cancelable: true }));
  const ring = p.ring >= 0 ? model.rings[p.ring]! : null;
  const where = [BAND_WORDS[p.band], ring && ring.length >= 3 ? `ring of ${ring.length}` : ring ? `pair with ${model.parts[ring.find((j) => j !== index)!]!.name}` : null, plural(p.files.length, "file"), `${kLines(p.lines)} lines`].filter(Boolean);
  const pick = (t: Tab) => {
    setTab(t);
    // The chain lit on the map belongs to the list it was lit from.
    if (reachOf && !((t === "uses" && reachOf === "needs") || (t === "by" && reachOf === "affects"))) onReach(null);
  };
  const tabs: { id: Tab; n: number; label: string }[] = [
    { id: "uses", n: uses.length, label: "Uses" },
    { id: "by", n: usedBy.length, label: "Used by" },
    { id: "files", n: p.files.length, label: p.files.length === 1 ? "File" : "Files" },
  ];
  const rows = (ls: typeof uses, side: "to" | "from", kind: "uses" | "by") => {
    const top = Math.max(1, ...ls.map((l) => l.n));
    return (
      <ul className={`cm-rows ${kind}`}>
        {ls.map((l) => {
          const o = model.parts[l[side]]!;
          return (
            <li key={l[side]}>
              <button
                type="button"
                className="cm-row"
                onClick={() => onPart(l[side])}
                onPointerEnter={() => onPeek(l[side])}
                onPointerLeave={() => onPeek(null)}
                onFocus={() => onPeek(l[side])}
                onBlur={() => onPeek(null)}
                title={`${kind === "uses" ? `${p.name} uses ${o.name}` : `${o.name} uses ${p.name}`}: ${plural(l.n, "import")}`}
              >
                <i className="cm-row-bar" style={{ width: `${Math.max(4, (l.n / top) * 100).toFixed(1)}%` }} aria-hidden="true" />
                <span className="cm-row-name">{o.name}</span>
                <span className="cm-row-n">{l.n}</span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  };
  const chain = (kind: "needs" | "affects", n: number) =>
    n > 0 && (
      <label className={`cm-chain ${kind === "needs" ? "uses" : "by"}`}>
        <span>
          <b>{kind === "needs" ? `All ${plural(n, "part")} it needs` : `All ${plural(n, "part")} a change reaches`}</b>
          <small>Directly or not, lit on the map</small>
        </span>
        <Switch on={reachOf === kind} onChange={(v) => onReach(v ? kind : null)} label={kind === "needs" ? "Light up all it needs" : "Light up all a change reaches"} />
      </label>
    );
  return (
    <aside className="cm-panel" aria-label={p.name}>
      <header className="cm-panel-head">
        <div className="cm-panel-title">
          <h3>{p.name}</h3>
          <button type="button" className="icon-btn tiny" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={13} />
          </button>
        </div>
        <p className="cm-where" title={whereOf(model, index)}>
          {where.map((w, i) => (
            <span key={i}>{w}</span>
          ))}
        </p>
        {p.purpose && <p className="cm-purpose">{p.purpose}</p>}
        {p.page && (
          <button type="button" className="cm-read" onClick={() => onPage(p.page!)}>
            <Icon name="book" size={13} />
            <span>Read how it works</span>
            <Icon name="chevronRight" size={13} />
          </button>
        )}
      </header>
      <div className="cm-tabs" role="tablist" aria-label="Its links and files">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" id={`cm-tab-${t.id}`} aria-selected={tab === t.id} aria-controls="cm-tabpanel" disabled={!t.n} className={`cm-tab ${t.id}`} onClick={() => pick(t.id)}>
            <b>{t.n}</b>
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      <div className="cm-tabpanel" id="cm-tabpanel" role="tabpanel" aria-labelledby={`cm-tab-${tab}`}>
        {tab === "uses" && (
          <>
            {chain("needs", needs)}
            <p className="cm-list-head">
              <span>Parts it imports from</span>
              <span>imports</span>
            </p>
            {rows(uses, "to", "uses")}
          </>
        )}
        {tab === "by" && (
          <>
            {chain("affects", affects)}
            <p className="cm-list-head">
              <span>Parts that import it</span>
              <span>imports</span>
            </p>
            {rows(usedBy, "from", "by")}
          </>
        )}
        {tab === "files" && (
          <>
            <p className="cm-list-head">
              <span>{shared ? <>In <code>{shared}/</code>, most used first</> : "Most used first"}</span>
              <span>used by</span>
            </p>
            <ul className="cm-files">
              {list.map((i) => {
                const f = graph.files[i]!;
                const c = counts.get(i)!;
                return (
                  <li key={i}>
                    <button type="button" className={`cm-file${i === found ? " is-found" : ""}`} onClick={() => open(f)} title={`${f}\nUsed by ${plural(c.in, "file")} · uses ${c.out}`}>
                      {c.in > 0 && <i className="cm-row-bar" style={{ width: `${Math.max(4, (c.in / most) * 100).toFixed(1)}%` }} aria-hidden="true" />}
                      <span className="cm-file-name">{baseName(f)}</span>
                      <span className="cm-file-dir">{shared === null ? dirName(f) : dirName(f).slice(shared.length).replace(/^\//, "")}</span>
                      <span className="cm-file-n">{c.in > 0 ? c.in : "–"}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {files.length > list.length && (
              <button type="button" className="cm-more" onClick={() => setAll(true)}>
                Show {plural(files.length - list.length, "more file")}
              </button>
            )}
          </>
        )}
        {tab !== "files" && !uses.length && !usedBy.length && <p className="cm-quiet">Nothing else in the repo uses it, and it uses nothing of the repo's.</p>}
      </div>
    </aside>
  );
}

/** Find a file by name: the first few that match; choosing one opens its part with the file at the top of its list. */
function FindFile({ graph, onFind }: { graph: CodeGraph; onFind: (i: number) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const out: { i: number; score: number }[] = [];
    graph.files.forEach((f, i) => {
      const lf = f.toLowerCase();
      const b = baseName(lf);
      const score = b.startsWith(s) ? 0 : b.includes(s) ? 1 : lf.includes(s) ? 2 : -1;
      if (score >= 0) out.push({ i, score });
    });
    return out.sort((a, b) => a.score - b.score || graph.files[a.i]!.length - graph.files[b.i]!.length).slice(0, 8);
  }, [q, graph]);
  const choose = (i: number) => (onFind(i), setOpen(false), setQ(""));
  return (
    <div className="cm-find">
      <Icon name="search" size={13} />
      <input
        value={q}
        placeholder="Find a file"
        aria-label="Find a file"
        role="combobox"
        aria-expanded={open && hits.length > 0}
        onChange={(e) => (setQ(e.target.value), setOpen(true), setAt(0))}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setAt((a) => Math.min(hits.length - 1, a + 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setAt((a) => Math.max(0, a - 1)));
          else if (e.key === "Enter" && hits[at]) (e.preventDefault(), choose(hits[at]!.i));
          // Escape clears what's typed; in an empty box it goes on to the map, letting go of the chosen part.
          else if (e.key === "Escape" && q) (e.preventDefault(), setQ(""), setOpen(false));
          else if (e.key === "Escape") (e.currentTarget.blur(), setOpen(false));
        }}
      />
      {open && hits.length > 0 && (
        <ul className="cm-find-list" role="listbox">
          {hits.map((h, k) => (
            <li key={h.i} role="option" aria-selected={k === at}>
              <button type="button" onMouseDown={(e) => (e.preventDefault(), choose(h.i))}>
                <span>{baseName(graph.files[h.i]!)}</span>
                <span className="cm-file-dir">{dirName(graph.files[h.i]!)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
