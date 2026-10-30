/**
 * How an agent or a teammate stands, drawn on its face: one treatment for every place one shows, so "a blue ring turning" means
 * working everywhere in the app (Arun, 2026-10-29: "so clean and beautiful really with a clear direction in design language";
 * design-ref/DIRECTION.md §8). It replaces the separate blue dot beside a face and the blue status words.
 *
 * - working: a --live comet, a bright head with its tail fading behind it, turning once every 2.4s at a constant speed;
 * - needs: a static --needs ring and a small "?" badge at the bottom right;
 * - queued: a static dashed --ink-3 ring;
 * - done: a --ready check badge (shown for 8s after a run ends, then idle);
 * - error: a static --danger ring;
 * - asleep: the face at 60% (a face with eyes closes them itself);
 * - idle: the plain face; a coding tool's mark at rest sits in a thin dashed circle, the empty circle a resting row had before
 *   (Arun, 2026-10-29: "i did like that dashed circle ring thing we had before").
 *
 * Every ring is about 2px at a 24-32px face, 1.75px at 16px and 2.5px at 56px, with a clear gap between it and the face (Arun,
 * 2026-10-29: "the ring things should be slightly thicker too"; the widths are set in style.css's Presence block from --pr-size).
 *
 * Reduced motion: the working ring is a static full circle. A coding tool's mark (a glyph, not a face) wears the same ring where
 * state isn't shown otherwise (rows, tabs, cards, the status bar), but not beside a reply in the feed: there it is identity only
 * (Arun, 2026-10-29: "i dont like the ring/circle thing around the claude icon in the chat... since it is already shown in the
 * header").
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";

export type Presence = "working" | "needs" | "queued" | "done" | "error" | "asleep" | "idle";

export function PresenceRing({ state, size, children, className = "", label, square = false }: {
  state: Presence;
  /** The face's own size in px: the ring sits a small gap outside it. */
  size: number;
  children: ReactNode;
  className?: string;
  /** Said to a screen reader as the state, when nothing beside the face says it. */
  label?: string;
  /** A tool's square mark rather than a round face: the ring still draws a circle round it. */
  square?: boolean;
}) {
  return (
    <span
      className={`pr${className ? ` ${className}` : ""}`}
      data-pr={state}
      data-square={square || undefined}
      style={{ "--pr-size": `${size}px` } as CSSProperties}
      {...(label ? { role: "img", "aria-label": label } : {})}
    >
      {children}
      {((state !== "idle" && state !== "asleep") || (state === "idle" && square)) && <span className="pr-ring" aria-hidden="true" />}
      {state === "needs" && <span className="pr-badge" aria-hidden="true">?</span>}
      {state === "done" && (
        <span className="pr-badge" aria-hidden="true">
          <svg viewBox="0 0 12 12" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m3.2 6.3 1.9 1.9 3.8-4.2" />
          </svg>
        </span>
      )}
    </span>
  );
}

/** "now", "4m", "1h 5m", "3h": how long something has been at it, in tabular figures, counted up by the caller's tick. */
export function elapsed(since: number, now = Date.now()): string {
  const m = Math.floor((now - since) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 10 && m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** The clock elapsed times count from, moved every `ms` (20s by default): counts change in place, never animated. */
export function useNow(ms = 20_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const RANK: Record<string, number> = { needs: 0, waiting: 0, working: 1 };
/** Needs you, then working, then the rest, each in the order it was in (owner call D): a stable sort by state. */
export function byState<T>(items: readonly T[], stateOf: (it: T) => string | null | undefined): T[] {
  return items
    .map((it, i) => ({ it, i, r: RANK[stateOf(it) ?? ""] ?? 2 }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.it);
}

/** A face blinks now and then while it works: about every five seconds, never on the beat. Off for reduced motion. */
export function useBlink(on: boolean): boolean {
  const [shut, setShut] = useState(false);
  useEffect(() => {
    if (!on || reducedMotion()) return;
    let t: ReturnType<typeof setTimeout>;
    const next = () => {
      t = setTimeout(() => {
        setShut(true);
        t = setTimeout(() => (setShut(false), next()), 150);
      }, 3500 + Math.random() * 3500);
    };
    next();
    return () => (clearTimeout(t), setShut(false));
  }, [on]);
  return shut;
}

/** Whether this window asks for less motion (the system's setting, or Friday's own: html.reduce-motion). */
export const reducedMotion = () => (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) || (typeof document !== "undefined" && document.documentElement.classList.contains("reduce-motion"));

/**
 * Rows that move (a row rising to "Needs you", the list re-sorting by state) slide to their new place in 240ms, so the eye can
 * follow them (FLIP). Each row to follow carries `data-flip` with a key of its own. With reduced motion they just move.
 */
export function useFlip<T extends HTMLElement>(): RefObject<T | null> {
  const box = useRef<T | null>(null);
  const was = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    // Measured from the list's own top, so scrolling the list (or the page) never reads as a row moving.
    const top = el.getBoundingClientRect().top;
    const now = new Map<string, number>();
    const rows = [...el.querySelectorAll<HTMLElement>("[data-flip]")];
    for (const r of rows) now.set(r.dataset.flip!, r.getBoundingClientRect().top - top);
    if (!reducedMotion())
      for (const r of rows) {
        const before = was.current.get(r.dataset.flip!);
        const dy = before === undefined ? 0 : before - now.get(r.dataset.flip!)!;
        if (Math.abs(dy) > 1 && Math.abs(dy) < 600) r.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 240, easing: "cubic-bezier(.2, .8, .2, 1)" });
      }
    was.current = now;
  });
  return box;
}
