/**
 * Popups drawn over a dialog scroll with the wheel and a finger (Arun, 2026-10-28: "cant scroll", the model list of the
 * picker opened from the teammate dialog). An open dialog locks scrolling everywhere outside itself by stopping wheel and
 * touch events once they reach the document (react-remove-scroll). A picker, menu or list portaled to the body is outside
 * the dialog, so it couldn't scroll. Stopped at the body when they come from such a popup, the lock never hears of them;
 * the page behind the dialog stays still all the same, since the lock has already hidden its overflow.
 */
const POPUP = '[role="dialog"]:not([data-slot="dialog-content"]), [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], [data-scroll-free]';

/** Whether a wheel or touch at `t` is in a popup outside the open dialog: inside the dialog the lock lets it through already. */
export function inFreePopup(t: EventTarget | null): boolean {
  const el = t instanceof Element ? t : null;
  const pop = el?.closest(POPUP);
  return !!pop && !pop.closest('[data-slot="dialog-content"]');
}

export function freeScrollInPopups(): void {
  const pass = (e: Event) => {
    if (inFreePopup(e.target)) e.stopPropagation();
  };
  for (const type of ["wheel", "touchstart", "touchmove"]) document.body.addEventListener(type, pass, { passive: true });
}
