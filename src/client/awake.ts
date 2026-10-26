import { useSyncExternalStore } from "react";

/**
 * Whether Friday is the window being used: shown and focused (Arun, 2026-10-19: "optimizing this app to be lightweight").
 * Every endless animation (a pulse, a shimmer, a spinner, the thinking orb) drew a frame on every refresh of the screen, 120 a
 * second on a ProMotion Mac, for as long as the window was visible, even behind another app's: the page sat at a fifth of a
 * core and the GPU near that while nothing changed. While Friday isn't the window in use, the endless ones are held still (holdEndless)
 * and canvases stop drawing (`html.asleep` says so to anything that asks); what they say (working, waiting on you) is still shown, and
 * the moment the window is used again they move.
 */

const subs = new Set<() => void>();
/** Shown and focused; a page with no notion of focus (a test's stand-in document) counts as in use. */
const inUse = () => !document.hidden && (typeof document.hasFocus !== "function" || document.hasFocus());
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
  window.addEventListener("focus", update);
  // A click into a preview's page moves the focus into its frame: that is still Friday in use, so blur is checked a moment
  // later, once the focus has landed, and only a window that really lost it sleeps.
  window.addEventListener("blur", () => setTimeout(update, 50));
  document.addEventListener("visibilitychange", update);
}

/** True while Friday is the window in use; a component that animates draws still while it is false. */
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
