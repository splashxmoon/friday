import { useEffect, useRef, useState } from "react";

/**
 * The sidebar's order, settled (Arun, 2026-11-03, after Orca's sort-settle): rows never move under the pointer, and a burst of
 * changes (three agents finishing in a second) moves them once, a moment later, rather than a row at a time.
 *
 * What stays keeps its place; what is gone goes at once; what is new comes in at once, where the order would put it. Only the
 * reordering of rows already shown waits: while the pointer or keyboard is in the list, and for SETTLE_MS after the first change.
 */
export const SETTLE_MS = 2500;

/** The shown order with the target's rows: gone ones out, new ones in after the row the target puts before them (or first). */
export function settleOrder(shown: readonly string[], target: readonly string[]): string[] {
  const keep = new Set(target);
  const out = shown.filter((id) => keep.has(id));
  const have = new Set(out);
  target.forEach((id, i) => {
    if (have.has(id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = out.indexOf(target[j]!);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    out.splice(at, 0, id);
    have.add(id);
  });
  return out;
}

export function useSettledOrder(target: readonly string[], held: boolean, ms = SETTLE_MS): string[] {
  const [, bump] = useState(0);
  const shown = useRef<string[]>([...target]);
  const latest = useRef(target);
  latest.current = target;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const merged = settleOrder(shown.current, target);
  shown.current = merged;
  const same = merged.length === target.length && merged.every((id, i) => id === target[i]);
  useEffect(() => {
    if (held || same) {
      clearTimeout(timer.current);
      timer.current = undefined;
      return;
    }
    // One wait for the whole burst: a change while one is pending joins it.
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      shown.current = [...latest.current];
      bump((n) => n + 1);
    }, ms);
  }, [held, same, ms]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return merged;
}
