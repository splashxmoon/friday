/**
 * Open a page in the browser the person actually uses.
 *
 * In the desktop app `window.open` lands in an Electron window: no saved
 * passwords, no extensions, no session they are already signed in to. That is
 * the wrong place for anything that asks a provider "is this you?" — the whole
 * point of those pages is the state the person's own browser is holding.
 *
 * Signing in to Friday itself is the exception, and it does not come through
 * here: it has to round-trip back into this window.
 */
export async function openOutside(url: string): Promise<boolean> {
  if (!url) return false;
  // Whole, always: the desktop app opens only an http(s) address, and a path like "/api/preview/…" was turned away in silence.
  const whole = new URL(url, location.href).href;
  const desktop = typeof window !== "undefined" ? window.fridayDesktop?.openExternal : undefined;
  // With noopener, window.open answers null even when the tab opened: nothing to read there.
  if (!desktop) {
    window.open(whole, "_blank", "noopener,noreferrer");
    return true;
  }
  const ok = await desktop(whole).catch(() => false);
  if (ok !== false) return true;
  // Refused. A page elsewhere still reaches the browser by window.open (the app hands those on); one on Friday's own address
  // would open in an app window instead, which is the thing this exists to avoid, so that is said rather than done.
  if (new URL(whole).origin === location.origin) return false;
  window.open(whole, "_blank", "noopener,noreferrer");
  return true;
}
