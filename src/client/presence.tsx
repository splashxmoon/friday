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
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type RefObject } from "react";
import { runClock } from "../step-words.js";

export type Presence = "working" | "needs" | "queued" | "done" | "error" | "asleep" | "idle" | "limited";

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

/**
 * A state as a small ring of its own, set just after a name (Arun, 2026-11-03: "use the small ring instead of this big ring around
 * the icon"): the sidebar's rows and the agents' tabs. Nothing at rest, so the ones at work stand out.
 */
export function StateRing({ state, title }: { state: Presence | null; title?: string | undefined }) {
  if (!state || state === "idle" || state === "done" || state === "asleep") return null;
  return (
    <span className="state-ring" title={title}>
      <PresenceRing state={state} size={8} label={title ?? { working: "Working", needs: "Needs you", error: "Hit an error", queued: "Waiting", limited: "Out of usage" }[state]}>
        <span />
      </PresenceRing>
    </span>
  );
}

/**
 * A session tab's finished ring (Sidebar.tsx SessionRing): green where the ring turned, the presence ring's own size (10.5px
 * across, a 1.75px line, in the 12px slot), lit while you haven't seen it, quieter once you have.
 */
export function DoneRing({ fresh = false, title }: { fresh?: boolean; title?: string | undefined }) {
  return (
    <span className={`state-ring sb-done${fresh ? " new" : ""}`} role="img" aria-label="Finished" title={title ?? (fresh ? "Finished while you were away" : "Finished")}>
      <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
        <circle cx="6" cy="6" r="4.375" />
      </svg>
    </span>
  );
}

/**
 * The ring a session tab shows, for anything else that says how a thread or an agent stands (the menu bar's panel, the thread
 * card's agents), so every ring in the app is the same one (Arun, 2026-11-16: "make sure we are using the same exact ring design
 * … found on the coding session tabs"). Nothing to say keeps its 14px slot, empty.
 */
export function TabRing({ state, fresh = false, title }: { state: Presence | "done" | null; fresh?: boolean; title?: string | undefined }) {
  if (state === "done") return <DoneRing fresh={fresh} title={title} />;
  if (!state || state === "idle" || state === "asleep") return <span className="state-ring" aria-hidden="true" />;
  return <StateRing state={state} title={title} />;
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
  useEffect(() => tickEvery(ms, setNow), [ms]);
  return now;
}

/**
 * One clock for everything that counts seconds where many sit side by side (the sidebar's working rows, the thread list): a single
 * timer on the turn of each second for all of them, running only while one is on screen, so twenty working rows cost one timer, and
 * only the time's own text redraws (Arun, 2026-11-20: "everything needs to feel like a working clock"). The time is the second it
 * turned, so every clock on screen moves together and a read in the same second gives the same answer.
 */
const second = () => Math.floor(Date.now() / 1000) * 1000;
let secNow = second();
let secTimer: ReturnType<typeof setTimeout> | undefined;
const secSubs = new Set<() => void>();
const secTick = () => {
  secNow = second();
  for (const s of secSubs) s();
  secTimer = setTimeout(secTick, 1000 - (Date.now() % 1000) + 5);
};
const onSecond = (cb: () => void) => {
  secSubs.add(cb);
  if (!secTimer) (secNow = second()), (secTimer = setTimeout(secTick, 1000 - (Date.now() % 1000) + 5));
  return () => {
    secSubs.delete(cb);
    if (!secSubs.size) (clearTimeout(secTimer), (secTimer = undefined));
  };
};
/** Now, to the second, from the one shared clock. */
export const useSecond = (): number => useSyncExternalStore(onSecond, () => (secTimer ? secNow : second()));

/** How long since `since`, counting up every second on the shared clock: "14s", "2m 14s", "1h 5m" (step-words.ts runClock). */
export function LiveClock({ since, className, title }: { since: number; className?: string; title?: string }) {
  const now = useSecond();
  return (
    <span className={className} title={title}>
      {runClock(now - since)}
    </span>
  );
}

/**
 * One ticker for every clock that moves at the same pace, so they move together in one draw rather than each on a timer of its
 * own, and none while the window is hidden: they catch up as it comes back (spec 13: an idle Home was laid out eight times a
 * second, clocks among the reasons). Returns how to stop.
 */
const tickers = new Map<number, { subs: Set<(now: number) => void>; timer: ReturnType<typeof setInterval> }>();
export function tickEvery(ms: number, f: (now: number) => void): () => void {
  let t = tickers.get(ms);
  if (!t) {
    const subs = new Set<(now: number) => void>();
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const now = Date.now();
      for (const s of subs) s(now);
    }, ms);
    tickers.set(ms, (t = { subs, timer }));
  }
  t.subs.add(f);
  const back = () => document.visibilityState === "visible" && f(Date.now());
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", back);
  return () => {
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", back);
    t.subs.delete(f);
    if (t.subs.size === 0 && tickers.get(ms) === t) (clearInterval(t.timer), tickers.delete(ms));
  };
}

// "quiet": working, but unheard a while (Sidebar.tsx crewQuiet), after those at work and before the rest.
const RANK: Record<string, number> = { needs: 0, waiting: 0, done: 1, working: 2, quiet: 2.5 };
/**
 * Needs you, then finished and not yet read, then working, then the rest, each in the order it was in (owner call D; "done"
 * from Herdr's priority order, 2026-11-01: what finished is yours to look at, what works isn't yet): a stable sort by state.
 */
export function byState<T>(items: readonly T[], stateOf: (it: T) => string | null | undefined): T[] {
  return items
    .map((it, i) => ({ it, i, r: RANK[stateOf(it) ?? ""] ?? 3 }))
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
  /** The rows' keys in order as last measured. */
  const order = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const rows = [...el.querySelectorAll<HTMLElement>("[data-flip]")];
    // Measured only when the rows changed: reading where they are lays the page out there and then, and the sidebar draws on every
    // event, so every draw was a layout of its own (spec 13: about 8 a second on a quiet Home). Its first measure, where nothing can
    // move yet, waits until after the window has drawn: in the task that opened a session it was 17 ms of an 80 ms stall.
    const keys = rows.map((r) => r.dataset.flip!).join("\n");
    if (keys === order.current) return;
    const measure = () => {
      order.current = keys;
      // Measured from the list's own top, so scrolling the list (or the page) never reads as a row moving.
      const top = el.getBoundingClientRect().top;
      const now = new Map<string, number>();
      for (const r of rows) now.set(r.dataset.flip!, r.getBoundingClientRect().top - top);
      if (!reducedMotion())
        for (const r of rows) {
          const before = was.current.get(r.dataset.flip!);
          const dy = before === undefined ? 0 : before - now.get(r.dataset.flip!)!;
          if (Math.abs(dy) > 1 && Math.abs(dy) < 600) r.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 240, easing: "cubic-bezier(.2, .8, .2, 1)" });
        }
      was.current = now;
    };
    if (order.current !== null) return measure();
    const t = setTimeout(measure, 0);
    return () => clearTimeout(t);
  });
  return box;
}
