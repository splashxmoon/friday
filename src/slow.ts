/**
 * Saying which piece of work held the server up.
 *
 * The server stalled for three seconds at a time, a few times an hour, and every socket on it went unanswered meanwhile
 * ([stall] in ops.ts, Arun, 2026-10-23: "look into what's freezing the server for seconds at a time and fix it"). A stall
 * says only that it happened. Each piece of work that grows with a session's length (a page's hello, the older log sent after
 * it, a whole log read and folded) says, when it was slow, how long it took and how much it handled, so the next one is named.
 */

/** Over this, a piece of work is said: a tenth of the stall the server reports. */
export const SLOW_MS = 300;

/** How many events the older log after a hello goes in at a time, the server free between them. */
export const EARLIER_PIECE = 400;

export function slowly(what: string, since: number, about: Record<string, number> = {}): void {
  const ms = performance.now() - since;
  if (ms < SLOW_MS) return;
  const said = Object.entries(about)
    .map(([k, v]) => `${k} ${Number.isInteger(v) ? v : `${Math.round(v)}ms`}`)
    .join(", ");
  console.warn(`[slow] ${what} took ${Math.round(ms)}ms${said ? ` (${said})` : ""}`);
}
