/**
 * Dragging in the sidebars, made easy (Arun, 2026-11-19: "make it much more smoother and easier to drag tabs into projects/folders
 * and stuff in the side bar for the agents"): a folded group opens by itself once a drag rests on it, as Finder's folders do, and
 * the row being carried dims where it was, so it's plain what is moving and where it can go.
 */

/** How long a drag rests on a folded group before it opens. */
const SPRING_MS = 550;
let springOn: string | null = null;
let springTimer: ReturnType<typeof setTimeout> | null = null;

/** A drag over `key`: folded, it opens after a moment's rest; open, nothing. Moving to another group starts the wait again. */
export function springHover(key: string, folded: boolean, open: () => void): void {
  if (!folded) return springOn === key ? springCancel() : undefined;
  if (springOn === key) return;
  springCancel();
  springOn = key;
  springTimer = setTimeout(() => {
    springOn = null;
    springTimer = null;
    open();
  }, SPRING_MS);
}

/** The drag left `key` (or ended): no opening. With no key, whichever was waiting. */
export function springCancel(key?: string): void {
  if (key !== undefined && springOn !== key) return;
  if (springTimer) clearTimeout(springTimer);
  springOn = null;
  springTimer = null;
}

/**
 * The row being dragged dims where it was, marked on the element itself so nothing redraws mid-drag (a redraw in dragstart can
 * cancel the drag in Chromium), and unmarked when the drag ends wherever it ends.
 */
export function markDragging(el: HTMLElement): void {
  setTimeout(() => el.setAttribute("data-dragging", ""), 0);
  const done = () => (el.removeAttribute("data-dragging"), springCancel(), removeEventListener("dragend", done, true), removeEventListener("drop", done, true));
  addEventListener("dragend", done, true);
  addEventListener("drop", done, true);
}

/** Whether a drag leaving `e.currentTarget` went outside it, not just onto one of its own children. */
export const leftFor = (e: { currentTarget: EventTarget; relatedTarget: EventTarget | null }): boolean => !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null);
