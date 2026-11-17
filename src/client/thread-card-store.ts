import { useSyncExternalStore } from "react";

/** Whether the thread card (ThreadCard.tsx) is open, peeking over a narrow chat, and whether the chat has room for it beside: kept apart from the card so the session screen reads it without loading the card. */

const OPEN_KEY = "friday.threadCard";
export const FOLD_KEY = "friday.threadCard.agents";
export const read = (k: string, dflt: boolean) => {
  try {
    const v = localStorage.getItem(k);
    return v === null ? dflt : v === "1";
  } catch {
    return dflt;
  }
};
export const write = (k: string, v: boolean) => {
  try {
    localStorage.setItem(k, v ? "1" : "0");
  } catch {
    // A preference: losing it costs nothing.
  }
};

/** Open (kept, where the chat has room for it beside), peeking (over a narrow chat, until a press elsewhere), and the room. */
let card = { open: read(OPEN_KEY, true), peek: false, wide: true };
const subs = new Set<() => void>();
const set = (next: Partial<typeof card>) => {
  card = { ...card, ...next };
  for (const f of subs) f();
};
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
export const useThreadCard = () => useSyncExternalStore(subscribe, () => card);
/** Whether the card shows now. */
export const cardShown = (c: typeof card) => (c.wide ? c.open : c.peek);
export function toggleThreadCard() {
  if (card.wide) {
    write(OPEN_KEY, !card.open);
    set({ open: !card.open, peek: false });
  } else set({ peek: !card.peek });
}
export const setCardWide = (wide: boolean) => card.wide !== wide && set({ wide, peek: false });
export const closePeek = () => card.peek && set({ peek: false });

