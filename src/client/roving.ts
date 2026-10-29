/**
 * A tab list's keys, as the ARIA tab pattern has them, for any `role="tablist"` (Arun, 2026-10-28: "TEST EVERYTHING… EVERY
 * INTERACTION, EVERY VISUAL"): only the picked tab is a Tab stop (a roving tabindex), the arrow keys move to the next or the
 * previous tab and pick it, Home and End go to either end, and focus stays on the list while what was picked draws, even when
 * that page puts the cursor in its own message box, so the arrows can keep going until Tab leaves.
 */
import { useLayoutEffect, type KeyboardEvent, type RefObject } from "react";

/** The list's own tabs (not those of a list inside it) that can be picked, in order. */
function tabsOf(list: HTMLElement): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>('[role="tab"]')].filter((t) => t.closest('[role="tablist"]') === list && !(t as HTMLButtonElement).disabled);
}

/** Only the picked tab (the first when none is) takes a Tab press; the others are reached with the arrows. */
export function rove(list: HTMLElement): void {
  const tabs = tabsOf(list);
  const picked = tabs.find((t) => t.getAttribute("aria-selected") === "true") ?? tabs[0];
  for (const t of tabs) t.tabIndex = t === picked ? 0 : -1;
}

/** Keeps the roving tabindex after every render of the list's owner: tabs come and go, and which is picked changes. */
export function useRovingTabs(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    if (ref.current) rove(ref.current);
  });
}

/**
 * Focus stays on `el` for a moment while the page it picked draws: a page that focuses its own box as it opens would take it
 * from the tab list. Ends at the next key or press, so Tab and a click go where they are meant to, or after `ms`.
 */
export function holdFocus(el: HTMLElement, again: () => HTMLElement | null, ms = 1200): void {
  const back = (e: FocusEvent) => {
    const to = el.isConnected ? el : again();
    if (to && e.target !== to) to.focus({ preventScroll: true });
  };
  const stop = () => {
    clearTimeout(timer);
    document.removeEventListener("focusin", back, true);
    document.removeEventListener("keydown", stop, true);
    document.removeEventListener("pointerdown", stop, true);
  };
  const timer = setTimeout(stop, ms);
  document.addEventListener("focusin", back, true);
  document.addEventListener("keydown", stop, true);
  document.addEventListener("pointerdown", stop, true);
}

/** The tab list's onKeyDown: the arrows (either axis), Home and End move to a tab and pick it (a click on it). */
export function tabListKeys(e: KeyboardEvent<HTMLElement>): void {
  const list = e.currentTarget;
  const tabs = tabsOf(list);
  const from = (e.target as HTMLElement).closest<HTMLElement>('[role="tab"]');
  const at = from ? tabs.indexOf(from) : -1;
  if (at < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
  const step: Record<string, number> = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: tabs.length - 1 };
  const to = step[e.key];
  if (to === undefined) return;
  e.preventDefault();
  const next = tabs[(to + tabs.length) % tabs.length]!;
  if (next === from) return;
  next.focus();
  next.click();
  const label = list.getAttribute("aria-label");
  holdFocus(next, () => (label ? document.querySelector<HTMLElement>(`[role="tablist"][aria-label="${CSS.escape(label)}"] [role="tab"][aria-selected="true"]`) : null));
}
