/**
 * The session list folds to its rail while the side panel needs its room (Arun, 2026-11-17: "when im at the smallest window size and
 * i have the side bar open, the side panel opens up fully"): with the list open, a small window left the panel no room beside the
 * chat, so it covered the chat. The panel says when the list is in its way (Workbench); the app folds it for as long as that lasts,
 * without saving it, and it is back once the panel closes or the window grows. Opened again by the person meanwhile, it stays open.
 */
let want = false;
let kept = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export const listYield = {
  sub: (f: () => void) => (subs.add(f), () => void subs.delete(f)),
  /** Whether the list is folded for the panel now. */
  folded: () => want && !kept,
  /** The panel needs the list's room, or no longer does. */
  set(v: boolean) {
    if (v === want) return;
    want = v;
    if (!v) kept = false;
    emit();
  },
  /** The person opened the list anyway: it stays open, and the panel goes over the chat. */
  keep() {
    kept = true;
    emit();
  },
};

/** Where the panel's row starts with the list open, the last time it was: what it would have back if the list opened. */
let listedLeft = 0;
export const rowLeftWithList = (now: number, listShown: boolean) => (listShown ? (listedLeft = now) : listedLeft || now + 290);
