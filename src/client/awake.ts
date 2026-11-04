import { useSyncExternalStore } from "react";

/**
 * Whether Friday can be seen (Arun, 2026-10-19: "optimizing this app to be lightweight"). While it can't (minimised, on another
 * desktop, covered), the endless animations (a pulse, a shimmer, a spinner, the thinking orb) are held still (holdEndless) and
 * canvases stop drawing (`html.asleep` says so to anything that asks), so a page nobody sees draws nothing; the moment it shows
 * again they move. A window in sight behind another app's keeps moving (Arun, 2026-11-03: "make sure all of the animations and
 * stuff are still running visibily even if you click off the app … i dont like how it looks static when not on the app"): it
 * was held still on losing focus, and a working session's ring sat frozen beside the app he was in.
 */

const subs = new Set<() => void>();
/** Shown, focused or not. */
const inUse = () => !document.hidden;
let awake = typeof document === "undefined" ? true : inUse();

/**
 * Only what loops forever is held still: a blanket pause on every animation (the stylesheet's old `html.asleep *`) also froze
 * the one-off entrances on their first frame, so a message, a menu or a list row arriving while Friday was in sight behind
 * another app stayed invisible until it was clicked (2026-10-19). Paused here by the browser's own list of running
 * animations, looked over again every couple of seconds while asleep for new ones, and resumed on waking.
 */
let held: Animation[] = [];
let sweep: ReturnType<typeof setInterval> | undefined;
const holdEndless = () => {
  if (typeof document.getAnimations !== "function") return;
  for (const a of document.getAnimations()) {
    if (a.playState === "running" && a.effect?.getComputedTiming().iterations === Infinity) {
      a.pause();
      held.push(a);
    }
  }
};
const release = () => {
  for (const a of held) if (a.playState === "paused") a.play();
  held = [];
};

function update() {
  const now = inUse();
  if (now === awake) return;
  awake = now;
  document.documentElement.classList.toggle("asleep", !now);
  clearInterval(sweep);
  if (now) release();
  else {
    holdEndless();
    sweep = setInterval(holdEndless, 2000);
  }
  subs.forEach((f) => f());
}

if (typeof window !== "undefined" && typeof document !== "undefined" && document.documentElement?.classList) {
  document.documentElement.classList.toggle("asleep", !awake);
  if (!awake) {
    holdEndless();
    sweep = setInterval(holdEndless, 2000);
  }
  document.addEventListener("visibilitychange", update);
}

/** True while Friday can be seen; a component that animates draws still while it is false. */
export function useAwake(): boolean {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => awake,
    () => true,
  );
}
