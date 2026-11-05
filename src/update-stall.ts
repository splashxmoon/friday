/**
 * Whether an app update has stopped moving (desktop-update.ts): `poke` on every sign of life (a check starting, a version found,
 * download progress), `stop` when it ends either way. Quiet for `ms` after a poke, `onStall` is called, once.
 */
export function stallGuard(ms: number, onStall: () => void): { poke(): void; stop(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    poke() {
      stop();
      timer = setTimeout(() => {
        timer = null;
        onStall();
      }, ms);
      timer.unref?.();
    },
    stop,
  };
}
