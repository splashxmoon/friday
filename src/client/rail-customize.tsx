import { useLayoutEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./icons.js";
import { isDefaultRail, placeAt, readRail, saveRail, setShown, useRailLayout, type RailPlace } from "./rail-layout.js";
import { floating, placeCard, Switch, useDismiss } from "./ui.js";
import "./rail-customize.css";

/**
 * Customize rail (Arun, 2026-11-19: "add the option to customize what tabs can be on the rail", then "very simple and clean please
 * not extra BS"): every place in its order, a switch for whether it's on the rail (off, it's off it: the palette still has it; the ⋯
 * that once held them is gone, Arun 2026-11-21), dragged by its handle
 * or moved with ↑ ↓. The rail beside it changes as you go.
 */
export interface RailPlaceInfo {
  id: RailPlace;
  icon: IconName;
  label: string;
}

export function RailCustomize({ places, anchor, onClose }: { places: RailPlaceInfo[]; anchor: DOMRect; onClose: () => void }) {
  const layout = useRailLayout();
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useDismiss(ref, onClose);
  const has = (id: RailPlace) => places.some((p) => p.id === id);
  const info = (id: RailPlace) => places.find((p) => p.id === id)!;
  const list = layout.order.filter(has);
  const [held, setHeld] = useState<RailPlace | null>(null);
  const [say, setSay] = useState("");
  // A move from the keyboard keeps the focus on the handle that moved.
  const [focusOn, setFocusOn] = useState<RailPlace | null>(null);
  useLayoutEffect(() => {
    if (!focusOn) return;
    listRef.current?.querySelector<HTMLElement>(`[data-place="${focusOn}"] .rc-grip`)?.focus();
    setFocusOn(null);
  }, [focusOn]);

  const where = (id: RailPlace) => {
    const l = readRail();
    const off = l.hidden.includes(id);
    const group = l.order.filter((p) => has(p) && l.hidden.includes(p) === off);
    return `${group.indexOf(id) + 1} of ${group.length} ${off ? "off the rail" : "on the rail"}`;
  };

  // Dragging: the row under the pointer gives up its place to the held one, so the rail shows the order as it forms. The list
  // holds the pointer, so a row drawn again as it moves can't drop it.
  const onDown = (e: React.PointerEvent, id: RailPlace) => {
    if (e.button !== 0) return;
    e.preventDefault();
    listRef.current?.setPointerCapture(e.pointerId);
    setHeld(id);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!held) return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-place]") ?? [])];
    const over = rows.find((r) => {
      const b = r.getBoundingClientRect();
      return e.clientY >= b.top && e.clientY < b.bottom;
    });
    const at = over?.dataset.place as RailPlace | undefined;
    if (at && at !== held) saveRail(placeAt(readRail(), held, at));
  };
  const onUp = () => {
    if (held) setSay(`${info(held).label}, ${where(held)}`);
    setHeld(null);
  };
  const onKey = (e: React.KeyboardEvent, id: RailPlace) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const other = list[list.indexOf(id) + (e.key === "ArrowUp" ? -1 : 1)];
    if (!other) return;
    saveRail(placeAt(readRail(), id, other));
    setSay(`${info(id).label}, ${where(id)}`);
    setFocusOn(id);
  };

  const pos = placeCard(anchor, 264, { beside: true, want: 520, min: 240 });
  return floating(
    <div ref={ref} className="rc" role="dialog" aria-label="Customize rail" style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width, maxHeight: pos.maxHeight }}>
      <div className="rc-head">
        <b>Customize rail</b>
        {!isDefaultRail(layout) && (
          <button type="button" className="rc-reset" onClick={() => (saveRail(null), setSay("Rail reset"))}>
            Reset
          </button>
        )}
        <button type="button" className="rc-x" aria-label="Close" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <ul ref={listRef} className="rc-list" onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        {list.map((id) => {
          const p = info(id);
          const on = !layout.hidden.includes(id);
          return (
            <li key={id} data-place={id} className={`rc-row${held === id ? " is-held" : ""}${on ? "" : " is-off"}`}>
              <button type="button" className="rc-grip" aria-label={`Move ${p.label}`} title="Drag, or press ↑ ↓" onPointerDown={(e) => onDown(e, id)} onKeyDown={(e) => onKey(e, id)}>
                <svg width="8" height="12" viewBox="0 0 8 12" aria-hidden="true">
                  {[2, 6, 10].map((y) => [2, 6].map((x) => <circle key={`${x}${y}`} cx={x} cy={y} r="1.2" fill="currentColor" />))}
                </svg>
              </button>
              <Icon name={p.icon} size={16} className="rc-ic" />
              <span className="rc-name">{p.label}</span>
              <span title={id === "sessions" ? "Sessions stays on the rail" : on ? "On the rail" : "Off the rail"}>
                <Switch on={on} disabled={id === "sessions"} label={`Show ${p.label} on the rail`} onChange={(v) => (saveRail(setShown(readRail(), id, v)), setSay(`${p.label} ${v ? "on the rail" : "off the rail"}`))} />
              </span>
            </li>
          );
        })}
      </ul>
      <div className="sr-only" aria-live="polite">
        {say}
      </div>
    </div>,
  );
}
