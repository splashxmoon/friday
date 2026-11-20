/**
 * Pings held while you type (Arun, 2026-11-19, wave 4: "Notifications that respect focus: while you're typing in the editor, Friday
 * holds its pings; they arrive as a quiet summary when you pause."). Pure: the clock is passed in, nothing here touches the page.
 */

/** One thing an agent said while you typed: a run that finished, or something that waits on you. */
export type Held = { kind: "done" | "waiting"; sid: string; title: string; seq?: number };

/** How long after the last key the editor counts as being typed in. */
export const QUIET_MS = 20_000;

export function createHold(quietMs: number = QUIET_MS) {
  let last = -Infinity;
  let queue: Held[] = [];
  /** Whether keys were pressed in the last `quietMs`. */
  const typing = (now: number) => now - last < quietMs;
  return {
    /** A key pressed in the editor. */
    typed(now: number) {
      if (now > last) last = now;
    },
    typing,
    /** When the held ones are due, in ms from `now` (0 if nothing is held or none is due yet to wait for). */
    wait(now: number) {
      return queue.length ? Math.max(0, last + quietMs - now) : 0;
    },
    /** Hold it if you are typing: true. Otherwise false, and the caller says it now. The same run or wait held twice is one. */
    hold(item: Held, now: number): boolean {
      if (!typing(now)) return false;
      queue = queue.filter((q) => !(q.kind === item.kind && q.sid === item.sid && (item.kind === "done" || q.seq === item.seq)));
      queue.push(item);
      return true;
    },
    size: () => queue.length,
    /** Take what is held, once you have paused. Nothing while you still type (`force` takes it anyway, when holding is turned off). */
    release(now: number, force = false): Held[] {
      if (typing(now) && !force) return [];
      const out = queue;
      queue = [];
      return out;
    },
    /** Forget the keys (the setting turned off, or the IDE closed). */
    reset() {
      last = -Infinity;
    },
  };
}

/** The one line for what was held: "While you were typing: Fix login finished · 2 waiting". Empty when nothing was. */
export function summarize(items: Held[]): string {
  const done = items.filter((i) => i.kind === "done");
  const waiting = items.filter((i) => i.kind === "waiting");
  const parts: string[] = [];
  if (done.length === 1) parts.push(`${done[0]!.title || "A session"} finished`);
  else if (done.length > 1) parts.push(`${done.length} finished`);
  if (waiting.length) parts.push(`${waiting.length} waiting`);
  return parts.length ? `While you were typing: ${parts.join(" · ")}` : "";
}
