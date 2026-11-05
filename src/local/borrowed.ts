/**
 * A Friday the desktop app opened but didn't start: the terminal edition's, running on the same folder (start.ts `already`).
 * Asked every `everyMs` whether it still answers as Friday; two misses running and `onGone` is called, once, so the app can
 * start its own instead of leaving its window on an address nothing answers. Returns what stops the watch.
 */
export function watchBorrowed(url: string, onGone: () => void, o: { everyMs?: number; misses?: number } = {}): () => void {
  const every = o.everyMs ?? 5000;
  const allowed = o.misses ?? 2;
  let missed = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const ask = async () => {
    const ok = await fetch(`${url}/api/info`, { signal: AbortSignal.timeout(Math.max(1500, every)) }).then(
      (r) => (void r.body?.cancel().catch(() => {}), r.ok),
      () => false,
    );
    if (stopped) return;
    missed = ok ? 0 : missed + 1;
    if (missed >= allowed) {
      stopped = true;
      return onGone();
    }
    timer = setTimeout(() => void ask(), every);
    timer.unref?.();
  };
  timer = setTimeout(() => void ask(), every);
  timer.unref?.();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
