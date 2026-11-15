import { useEffect, useRef, useState, type KeyboardEvent } from "react";

/**
 * A time of day in Friday's own controls, not the system's time field: the hour and the minutes each a cell that opens a small grid
 * to pick from (and steps with the arrow keys), and AM or PM as a two-way switch beside them. Minutes go in fives.
 */
export function TimeField({ value, onChange }: { value: string; onChange: (hhmm: string) => void }) {
  const [h, mm] = value.split(":").map(Number) as [number, number];
  const [open, setOpen] = useState<"" | "hour" | "min">("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen("");
    const esc = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setOpen("");
    addEventListener("pointerdown", away);
    addEventListener("keydown", esc);
    return () => (removeEventListener("pointerdown", away), removeEventListener("keydown", esc));
  }, [open]);
  const pm = h >= 12;
  const h12 = h % 12 || 12;
  const set = (hour24: number, min: number) => onChange(`${String(((hour24 % 24) + 24) % 24).padStart(2, "0")}:${String(((min % 60) + 60) % 60).padStart(2, "0")}`);
  const stepH = (by: number) => set(h + by, mm);
  const stepM = (by: number) => {
    const m = mm + by;
    set(m >= 60 ? h + 1 : m < 0 ? h - 1 : h, m);
  };
  const keys = (step: (by: number) => void, big: number) => (e: KeyboardEvent) => {
    if (e.key === "ArrowUp") (e.preventDefault(), step(1));
    if (e.key === "ArrowDown") (e.preventDefault(), step(-1));
    if (e.key === "PageUp") (e.preventDefault(), step(big));
    if (e.key === "PageDown") (e.preventDefault(), step(-big));
  };
  const cell = (which: "hour" | "min", label: string, shown: string, now: number, min: number, max: number, step: (by: number) => void, big: number) => (
    <button type="button" className="rt-tf-cell" role="spinbutton" aria-label={label} aria-valuenow={now} aria-valuemin={min} aria-valuemax={max} aria-valuetext={shown} aria-expanded={open === which} data-on={open === which ? "" : undefined} onClick={() => setOpen(open === which ? "" : which)} onKeyDown={keys(step, big)}>
      {shown}
    </button>
  );
  return (
    <div className="rt-tf" ref={box} role="group" aria-label="Time">
      <span className="rt-tf-box">
        {cell("hour", "Hour", String(h12), h12, 1, 12, stepH, 3)}
        <span className="rt-tf-colon" aria-hidden="true">
          :
        </span>
        {cell("min", "Minutes", String(mm).padStart(2, "0"), mm, 0, 55, (by) => stepM(by * 5), 3)}
      </span>
      <span className="rt-seg rt-tf-ampm" role="radiogroup" aria-label="Morning or afternoon">
        <button type="button" role="radio" aria-checked={!pm} className="rt-seg-opt" onClick={() => pm && set(h - 12, mm)}>
          AM
        </button>
        <button type="button" role="radio" aria-checked={pm} className="rt-seg-opt" onClick={() => !pm && set(h + 12, mm)}>
          PM
        </button>
      </span>
      {open && (
        <div className={`rt-tf-pop is-${open}`} role="listbox" aria-label={open === "hour" ? "Pick the hour" : "Pick the minutes"}>
          {(open === "hour" ? [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] : [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]).map((v) => {
            const on = open === "hour" ? v === h12 : v === mm;
            return (
              <button key={v} type="button" role="option" aria-selected={on} className="rt-tf-opt" onClick={() => (open === "hour" ? set((v % 12) + (pm ? 12 : 0), mm) : set(h, v), setOpen(""))}>
                {open === "hour" ? v : String(v).padStart(2, "0")}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
