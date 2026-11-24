import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { EngineTool } from "../types.js";
import { busyness, rankComputers, toolName, type MachineFacts, type PlaceCandidate } from "../placement.js";
import { EngineMark } from "./BrandMarks.js";
import { Icon } from "./icons.js";
import { lastSeen, type State } from "./Computers.js";
import "./machines-map.css";

/**
 * The map of your computers (spec 09 step 1; Arun, 2026-11-21: "we need proper linking mapping visuals", then "make it more
 * compact and simpler with click to show more info", then "a horizontal topology map … be able to drag and resize too").
 *
 * A canvas: this computer at the left, each of your others to its right, a line from it to each that says how they link (Wi-Fi,
 * Tailscale, not connected). Every computer is a small tile (its name, its state in a few words, the coding tools signed in
 * there as marks, "Best" on the one placement would pick next); a click opens its details (placement.ts MachineFacts: system,
 * busy, disk, power, each tool's limit, repos, Xcode, Docker, local models). Tiles drag anywhere and stay where they're put (this
 * browser), the map's height drags from its bottom edge, and Arrange puts them back.
 *
 * Quiet on purpose (a quiet room): no motion but a dot travelling a line whose computer has agents running.
 */

const OS: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };
const osName = (p?: string) => OS[p ?? ""] ?? (p || "");
const TILE_W = 180;
const TILE_H = 50;
const POS_KEY = "friday.computersMap.place";
const HEIGHT_KEY = "friday.computersMap.height";

/** How a linked computer reaches this one, read from the address it linked from. */
export function routeOf(address: string | undefined, connected: boolean): string {
  if (!connected) return "Not connected";
  const a = (address ?? "").replace(/^::ffff:/, "");
  const m = /^(\d+)\.(\d+)\./.exec(a);
  if (m && m[1] === "100" && Number(m[2]) >= 64 && Number(m[2]) <= 127) return "Tailscale";
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|fd)/i.test(a)) return "Wi-Fi";
  if (/^(127\.|::1$)/.test(a)) return "This computer";
  return a ? "Internet" : "Linked";
}

interface Node {
  id: string;
  name: string;
  here: boolean;
  connected: boolean;
  platform?: string;
  seen?: number;
  address?: string;
  tools: { tool: string; name: string; loggedIn?: boolean | null }[];
  facts: MachineFacts | null;
  problem?: string;
}
type Pos = Record<string, { x: number; y: number }>;

function nodesOf(state: State): Node[] {
  const here: Node = { id: "here", name: state.here?.name || "This computer", here: true, connected: true, platform: state.here?.platform, tools: state.here?.tools ?? [], facts: state.here?.facts ?? null };
  return [
    here,
    ...state.computers.map((c) => ({ id: c.id, name: c.name, here: false, connected: c.connected, platform: c.platform, seen: c.seen, address: c.address, tools: c.tools, facts: c.facts ?? null, problem: c.problem })),
  ];
}

/** Where each tile goes when nobody has moved it: this one at the left, the others in columns to its right; on a map too narrow
 * for two side by side, this one at the top and the others down the right under it. */
function arrange(ids: string[], w: number, h: number): Pos {
  const out: Pos = {};
  const [hub, ...rest] = ids;
  if (w < TILE_W * 2 + 70) {
    if (hub) out[hub] = { x: 12, y: 12 };
    rest.forEach((id, i) => (out[id] = { x: Math.max(12, w - TILE_W - 12), y: 12 + (TILE_H + 28) * (i + 1) }));
    return out;
  }
  const perCol = Math.max(1, Math.floor((h - 24) / (TILE_H + 18)));
  const cols = Math.max(1, Math.ceil(rest.length / perCol));
  const left = 16;
  const span = Math.max(TILE_W + 60, (w - left - TILE_W - 16) / cols);
  if (hub) out[hub] = { x: left, y: Math.round(h / 2 - TILE_H / 2) };
  rest.forEach((id, i) => {
    const col = Math.floor(i / perCol);
    const inCol = Math.min(perCol, rest.length - col * perCol);
    const row = i % perCol;
    const gap = (h - inCol * TILE_H) / (inCol + 1);
    out[id] = { x: Math.round(Math.min(w - TILE_W - 16, left + span * (col + 1))), y: Math.round(gap + row * (TILE_H + gap)) };
  });
  return out;
}

/** The height the tiles need when they stack (a narrow map): never less than what fits them all. */
const neededHeight = (n: number, w: number) => (w && w < TILE_W * 2 + 70 ? 12 + n * (TILE_H + 28) : 0);

const readJson = <T,>(key: string, fallback: T): T => {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? "null") as T) ?? fallback;
  } catch {
    return fallback;
  }
};

export function MachinesMap({ state, onAdd }: { state: State; onAdd?: () => void }) {
  const nodes = nodesOf(state);
  const ranked = rankComputers(nodes.map((n): PlaceCandidate => ({ id: n.id, name: n.name, connected: n.connected, tools: n.tools, facts: n.facts })));
  const best = ranked[0]?.ok && nodes.length > 1 ? ranked[0] : null;
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: readJson<number>(HEIGHT_KEY, 240) });
  const [moved, setMoved] = useState<Pos>(() => readJson<Pos>(POS_KEY, {}));
  const [open, setOpen] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const ids = nodes.map((n) => n.id);
  const height = Math.max(size.h || 240, neededHeight(nodes.length, size.w));
  const auto = arrange(ids, size.w, height);
  // A tile stays inside the map, whatever size the map is now. Moved ones are kept as fractions of the room the map has, so
  // they keep their place as it grows or narrows.
  const roomX = Math.max(1, size.w - TILE_W - 8), roomY = Math.max(1, height - TILE_H - 8);
  const at = (id: string) => {
    const m = moved[id];
    const p = m ? { x: 4 + m.x * roomX, y: 4 + m.y * roomY } : (auto[id] ?? { x: 16, y: 16 });
    return { x: Math.max(4, Math.min(p.x, size.w - TILE_W - 4)), y: Math.max(4, Math.min(p.y, height - TILE_H - 4)) };
  };

  // The map's width from its box, and its height as the person drags its bottom edge (kept for next time).
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize((s) => (Math.round(r.width) === s.w && Math.round(r.height) === s.h ? s : { w: Math.round(r.width), h: Math.round(r.height) }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!size.w) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(HEIGHT_KEY, String(size.h));
      } catch {}
    }, 300);
    return () => clearTimeout(t);
  }, [size.h, size.w]);

  // Dragging a tile: a press that moves more than a few pixels is a drag; one that doesn't is a click (details).
  const drag = useRef<{ id: string; dx: number; dy: number; x0: number; y0: number; moved: boolean } | null>(null);
  const down = (id: string, e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const p = at(id);
    drag.current = { id, dx: e.clientX - p.x, dy: e.clientY - p.y, x0: e.clientX, y0: e.clientY, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
    if (!d.moved) setDragging(d.id);
    d.moved = true;
    setMoved((m) => ({ ...m, [d.id]: { x: Math.min(1, Math.max(0, (e.clientX - d.dx - 4) / roomX)), y: Math.min(1, Math.max(0, (e.clientY - d.dy - 4) / roomY)) } }));
  };
  const up = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    setDragging(null);
    if (!d) return;
    if (!d.moved) return void setOpen((o) => (o === d.id ? null : d.id));
    setMoved((m) => {
      try {
        localStorage.setItem(POS_KEY, JSON.stringify(m));
      } catch {}
      return m;
    });
  }, []);
  const rearrange = () => {
    setMoved({});
    try {
      localStorage.removeItem(POS_KEY);
    } catch {}
  };
  // Details close on Escape, or a press on the map itself.
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [open]);

  const openNode = nodes.find((n) => n.id === open) ?? null;
  const hub = nodes[0];
  const from = hub ? at(hub.id) : { x: 0, y: 0 };
  const lines = nodes.slice(1).map((n) => {
    const to = at(n.id);
    // From the sides of the two tiles that face each other: left and right when they sit apart across, top and bottom when one
    // is mostly above the other.
    const dx = to.x - from.x, dy = to.y - from.y;
    let d: string;
    let x0: number, y0: number, x1: number, y1: number;
    if (Math.abs(dx) >= TILE_W * 0.75 || Math.abs(dx) > Math.abs(dy)) {
      x0 = dx >= 0 ? from.x + TILE_W : from.x;
      x1 = dx >= 0 ? to.x : to.x + TILE_W;
      y0 = from.y + TILE_H / 2;
      y1 = to.y + TILE_H / 2;
      const mx = (x0 + x1) / 2;
      d = `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1}`;
    } else {
      x0 = from.x + TILE_W / 2;
      x1 = to.x + TILE_W / 2;
      y0 = dy >= 0 ? from.y + TILE_H : from.y;
      y1 = dy >= 0 ? to.y : to.y + TILE_H;
      const my = (y0 + y1) / 2;
      d = `M${x0},${y0} C${x0},${my} ${x1},${my} ${x1},${y1}`;
    }
    return { id: n.id, d, x: (x0 + x1) / 2, y: (y0 + y1) / 2, on: n.connected, busy: !!n.facts?.agents, label: routeOf(n.address, n.connected) };
  });

  return (
    <div className="cmap-frame">
      <div className="cmap-bar">
        <span className="muted small">{nodes.length === 1 ? "Just this computer so far." : `${nodes.filter((n) => n.connected).length} of ${nodes.length} connected · drag to move, click for details`}</span>
        <span className="cmap-bar-actions">
          {Object.keys(moved).length > 0 && (
            <button type="button" className="link-btn small" onClick={rearrange}>
              Arrange
            </button>
          )}
          {onAdd && (
            <button type="button" className="link-btn small" onClick={onAdd}>
              Add a computer
            </button>
          )}
        </span>
      </div>
      <div
        className="cmap"
        ref={wrap}
        style={{ height }}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onPointerDown={(e) => e.target === e.currentTarget && setOpen(null)}
      >
        <svg className="cmap-lines" width={size.w} height={height} aria-hidden="true">
          {lines.map((l) => (
            <g key={l.id} className={l.on ? "on" : "off"}>
              <path d={l.d} />
              {l.busy && l.on && (
                <circle r="2.5" className="cmap-pulse">
                  <animateMotion dur="2.6s" repeatCount="indefinite" path={l.d} />
                </circle>
              )}
            </g>
          ))}
        </svg>
        {lines.map((l) => (
          <span key={l.id} className={`cmap-route${l.on ? "" : " off"}`} style={{ left: l.x, top: l.y }}>
            {l.label}
          </span>
        ))}
        {size.w > 0 &&
          nodes.map((n) => {
            const p = at(n.id);
            return (
              <Tile
                key={n.id}
                n={n}
                x={p.x}
                y={p.y}
                best={best?.id === n.id ? best.why : null}
                open={open === n.id}
                dragging={dragging === n.id}
                onDown={(e) => down(n.id, e)}
                onKey={() => setOpen((o) => (o === n.id ? null : n.id))}
              />
            );
          })}
      </div>
      {openNode && (
        <div className="cmap-info">
          <button type="button" className="icon-btn tiny cmap-info-x" aria-label="Hide details" onClick={() => setOpen(null)}>
            <Icon name="x" size={12} />
          </button>
          <Details n={openNode} best={best?.id === openNode.id ? best.why : null} />
        </div>
      )}
    </div>
  );
}

/**
 * One computer: its tile, its name and one line, what it is doing (Arun, 2026-11-22: "refine and simplify this design... no need for
 * so much info that where you get when you click on it"). Its tools, power, limits and the rest open under the map (MachinesMap).
 */
function Tile({ n, x, y, best, open, dragging, onDown, onKey }: { n: Node; x: number; y: number; best: string[] | null; open: boolean; dragging: boolean; onDown: (e: ReactPointerEvent) => void; onKey: () => void }) {
  const f = n.facts;
  const doing = !n.connected
    ? n.problem
      ? "Needs pairing again"
      : `Last seen ${n.seen ? lastSeen(n.seen) : "a while ago"}`
    : !f
      ? "Linked"
      : f.agents
        ? `${f.agents} running`
        : "Idle";
  const here = (f?.platform ?? n.platform) === "darwin" ? "This Mac" : (f?.platform ?? n.platform) === "win32" ? "This PC" : "This computer";
  const status = n.here ? `${here} · ${doing}` : doing;
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`${n.name}: ${status}. Show details`}
        className={`cmap-tile${n.connected ? "" : " off"}${best ? " best" : ""}${open ? " open" : ""}${dragging ? " dragging" : ""}`}
        style={{ left: x, top: y, width: TILE_W, height: TILE_H }}
        onPointerDown={onDown}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onKey())}
      >
        <div className="cmap-l1">
          <span className={`cmap-dot${n.connected ? " on" : ""}`} />
          <span className="cmap-name">{n.name}</span>
          {best && <span className="cmap-best">Best</span>}
        </div>
        <div className="cmap-l2">{status}</div>
      </div>
    </>
  );
}

function Details({ n, best }: { n: Node; best: string[] | null }) {
  const f = n.facts;
  const signed = n.tools.filter((t) => t.loggedIn === true);
  const busy = busyness(f);
  const spec = f ? [osName(f.platform), f.arch === "arm64" && f.platform === "darwin" ? "Apple silicon" : f.arch, `${f.cpus} cores`, `${f.memGb} GB`].filter(Boolean).join(" · ") : osName(n.platform);
  return (
    <>
      <div className="cmap-info-head">
        <b>{n.name}</b>
        <span className="muted small">{n.connected ? spec : (n.problem ?? spec)}</span>
      </div>
      {n.connected && f && (
        <div className="cmap-gauges">
          <Gauge label="Busy" value={busy} text={f.agents ? `${f.agents} agent${f.agents === 1 ? "" : "s"}` : busy > 0.8 ? "Busy" : "Idle"} />
          <Gauge label="Disk" value={f.freeDiskGb == null ? 0 : Math.max(0, 1 - f.freeDiskGb / 500)} text={f.freeDiskGb == null ? "?" : `${f.freeDiskGb} GB free`} warn={f.freeDiskGb != null && f.freeDiskGb < 10} />
          <span className={`cmap-power${f.power === "battery" ? " batt" : ""}`}>
            <Icon name={f.power === "battery" ? "battery" : "zap"} size={12} />
            {f.power === "battery" ? `${f.batteryPercent ?? "?"}%` : f.power === "ac" ? "On power" : "Power ?"}
          </span>
        </div>
      )}
      {n.connected && signed.length > 0 && (
        <div className="cmap-tools">
          {signed.map((t) => {
            const lim = f?.limits[t.tool];
            return (
              <span key={t.tool} className="cmap-tool" title={lim ? `${toolName(t.tool)}: ${Math.round(lim.usedPercent)}% of its ${lim.window} limit used` : t.name}>
                <EngineMark tool={t.tool as EngineTool} size={12} />
                <span className="cmap-tool-name">{t.name}</span>
                {lim && (
                  <span className={`cmap-lim${lim.usedPercent >= 90 ? " hot" : lim.usedPercent >= 70 ? " warm" : ""}`}>
                    <i style={{ width: `${Math.max(4, lim.usedPercent)}%` }} />
                  </span>
                )}
              </span>
            );
          })}
        </div>
      )}
      {f && (f.repos.length > 0 || f.xcode || f.docker || f.localModels.length > 0) && (
        <div className="cmap-has">
          {f.repos.length > 0 && <span title={f.repos.slice(0, 12).map((r) => r.name).join("\n")}>{f.repos.length} repo{f.repos.length === 1 ? "" : "s"}</span>}
          {f.xcode && <span>Xcode</span>}
          {f.docker && <span>Docker</span>}
          {f.localModels.map((m) => (
            <span key={m}>{m}</span>
          ))}
        </div>
      )}
      {best && <div className="cmap-why">Best for the next run: {best.slice(0, 3).join(", ")}</div>}
    </>
  );
}

function Gauge({ label, value, text, warn }: { label: string; value: number; text: string; warn?: boolean }) {
  return (
    <span className={`cmap-gauge${warn ? " warn" : ""}`} title={`${label}: ${text}`}>
      <span className="cmap-bar-track">
        <i style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }} />
      </span>
      {text}
    </span>
  );
}
