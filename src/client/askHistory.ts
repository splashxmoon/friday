/**
 * What you've asked before, as a shell keeps its history: ↑ in an empty message box brings back your last ask, ↑ again the one
 * before, ↓ the way back to an empty box. Across sessions, newest first, on this computer only (Claude Code, Factory and Amp
 * all have it; Arun, 2026-10-26: "map out more QoL features that our competitors have").
 */
const KEY = "mpa.asks";
const KEEP = 50;

export function pastAsks(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Kept once, at the front: asking the same thing again moves it up rather than listing it twice. */
export function rememberAsk(text: string): void {
  const t = text.trim();
  if (!t || t.length > 4000) return;
  try {
    localStorage.setItem(KEY, JSON.stringify([t, ...pastAsks().filter((x) => x !== t)].slice(0, KEEP)));
  } catch {
    // Full or blocked storage: the history is a convenience.
  }
}

/**
 * The arrow keys in the message box, while it holds nothing of yours or one of your past asks: true when it took the key.
 * `at` is where in the history the box is (-1 for your own text), kept by the caller between presses.
 */
export function walkAsks(e: { key: string; altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; preventDefault(): void }, el: HTMLTextAreaElement, at: { current: number }, set: (text: string) => void): boolean {
  if ((e.key !== "ArrowUp" && e.key !== "ArrowDown") || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return false;
  const asks = pastAsks();
  const value = el.value;
  // Only from an empty box, or one still showing a past ask untouched: arrows in your own text move the caret, as always.
  const browsing = at.current >= 0 && value === asks[at.current];
  if (!browsing) at.current = -1;
  if (!browsing && value !== "") return false;
  // Up from the first line only, down from the last, so a long past ask can still be moved through.
  if (browsing && e.key === "ArrowUp" && value.lastIndexOf("\n", el.selectionStart - 1) !== -1) return false;
  if (browsing && e.key === "ArrowDown" && value.indexOf("\n", el.selectionEnd) !== -1) return false;
  const next = e.key === "ArrowUp" ? at.current + 1 : at.current - 1;
  if (next >= asks.length || (next < 0 && !browsing)) return false;
  e.preventDefault();
  at.current = next;
  set(next < 0 ? "" : asks[next]!);
  return true;
}
