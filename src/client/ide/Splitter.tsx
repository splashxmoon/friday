import { useRef, type KeyboardEvent, type PointerEvent } from "react";

/**
 * The line between two panels: drag it, or focus it and press the arrow keys (Shift for bigger steps, Home/End for the ends),
 * and double-click to put it back. `edge` is the side of the resized panel the line sits on, which decides which way a drag grows it.
 */
export function Splitter({
  edge,
  value,
  min,
  max,
  onChange,
  onReset,
  label,
}: {
  /** "right": the panel is to the left of the line (a side bar). "left": to its right (the chat). "top": the panel is below it. */
  edge: "right" | "left" | "top";
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  onReset: () => void;
  label: string;
}) {
  const drag = useRef<{ from: number; start: number } | null>(null);
  const horizontal = edge !== "top";
  const sign = edge === "right" ? 1 : -1;

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { from: horizontal ? e.clientX : e.clientY, start: value };
    document.documentElement.classList.add("ix-dragging", horizontal ? "ix-dragging-x" : "ix-dragging-y");
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const delta = (horizontal ? e.clientX : e.clientY) - d.from;
    onChange(Math.min(max, Math.max(min, d.start + sign * delta)));
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    document.documentElement.classList.remove("ix-dragging", "ix-dragging-x", "ix-dragging-y");
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    // The arrow that points toward the panel's growth grows it.
    const grow = horizontal ? (edge === "right" ? "ArrowRight" : "ArrowLeft") : "ArrowUp";
    const shrink = horizontal ? (edge === "right" ? "ArrowLeft" : "ArrowRight") : "ArrowDown";
    if (e.key === grow) onChange(Math.min(max, value + step));
    else if (e.key === shrink) onChange(Math.max(min, value - step));
    else if (e.key === "Home") onChange(min);
    else if (e.key === "End") onChange(max);
    else if (e.key === "Enter") onReset();
    else return;
    e.preventDefault();
  };

  return (
    <div
      className={`ix-split ${horizontal ? "x" : "y"} ${edge}`}
      role="separator"
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={onReset}
      onKeyDown={key}
    />
  );
}
