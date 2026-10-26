import { useEffect, useState } from "react";

/**
 * A new deploy reaches windows that are already open.
 *
 * The desktop app opens the hosted product and stays open for days, so after a deploy it kept running the interface it
 * loaded until somebody quit it, which is why interface changes seemed to need a new desktop version. This asks the server
 * which client it hands out (/api/build) when the window comes back into view and every few minutes, and on a new one:
 * reloads by itself when nobody would lose anything (the window is hidden, or nobody has touched it for a minute, nothing is
 * typed in a box and no dialog is open), and otherwise offers it as a quiet pill to press when it suits.
 */

const EVERY_MS = 5 * 60_000;
const IDLE_MS = 60_000;
/** Spread over this, so a room of people on one deploy don't all reload in the same second. */
const JITTER_MS = 20_000;
const RELOADED = "mpa.reloadedFor";
const CHUNK_RELOAD = "mpa.chunkReloadAt";

const session = {
  get: (k: string) => {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      sessionStorage.setItem(k, v);
    } catch {
      /* this tab only */
    }
  },
};

/**
 * A piece of the app that no longer exists: after a deploy the old build's code-split chunks are gone, so the next lazy
 * import in a window opened before it fails, and React drops the whole page, leaving it white. Chrome, Firefox and Safari
 * word it differently.
 */
export const isChunkError = (e: unknown) => /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk \S+ failed|ChunkLoadError/i.test(e instanceof Error ? `${e.name} ${e.message}` : String(e ?? ""));

/** Reload onto the current build after a chunk failed to load: once in thirty seconds at most, so a real outage can't loop. */
export function reloadForChunk(e: unknown): boolean {
  if (!isChunkError(e)) return false;
  const last = Number(session.get(CHUNK_RELOAD) ?? 0);
  if (Date.now() - last < 30_000) return false;
  session.set(CHUNK_RELOAD, String(Date.now()));
  location.reload();
  return true;
}

/** Catches the failures React doesn't see: a lazy import rejected outside a render. Installed once, at boot. */
export function watchChunkErrors(): void {
  addEventListener("unhandledrejection", (ev) => void reloadForChunk(ev.reason));
  addEventListener("error", (ev) => void reloadForChunk(ev.error ?? ev.message));
}

/** Whether a reload now would cost anybody something: words typed in a box, a dialog half-filled. */
export function busyPage(doc: Document = document): boolean {
  if (doc.querySelector(".overlay, [role='dialog'], [role='alertdialog']")) return true;
  // Somebody in a box, even an empty one: they're about to type.
  const at = doc.activeElement as HTMLElement | null;
  if (at && (at.tagName === "TEXTAREA" || at.tagName === "INPUT" || at.isContentEditable)) return true;
  for (const el of Array.from(doc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("textarea, input:not([type]), input[type='text'], input[type='search'], [contenteditable='true']"))) {
    const v = "value" in el ? el.value : (el as HTMLElement).textContent;
    if (v && v.trim()) return true;
  }
  return false;
}

async function current(): Promise<string | null> {
  try {
    const r = await fetch("/api/build", { cache: "no-store", credentials: "same-origin" });
    return r.ok ? ((await r.json()) as { build?: string }).build ?? null : null;
  } catch {
    return null;
  }
}

/**
 * Reload, pressed (Arun, 2026-10-18): in the desktop app, the whole app closes and opens again, so the window, the runner and
 * the page all start on what is new; into the new version of the app itself when one is downloaded and waiting. A browser, or
 * an app from before it could do this, reloads the page as it always did.
 */
async function reloadAll() {
  const d = window.fridayDesktop;
  try {
    const u = await d?.update?.state().catch(() => null);
    if (u?.stage === "ready" && (await d?.update?.install().catch(() => false))) return;
    if (d?.relaunch && (await d.relaunch().catch(() => false))) return;
  } catch {
    /* the page, then */
  }
  location.reload();
}

export function BuildWatch() {
  // The new build, once the server hands one out that this page isn't running.
  const [stale, setStale] = useState<string | null>(null);
  useEffect(() => {
    let mine: string | null = null;
    let live = true;
    const check = async () => {
      const b = await current();
      if (!live || !b) return;
      if (mine === null) mine = b;
      else if (b !== mine) setStale(b);
    };
    void check();
    // Hidden too: a window left in the background all afternoon is the one to bring up to date before anyone looks.
    const t = setInterval(() => void check(), EVERY_MS);
    const back = () => !document.hidden && void check();
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => {
      live = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
    };
  }, []);

  // Once there is a new one: take it the moment nobody would lose anything.
  useEffect(() => {
    if (!stale) return;
    let touched = Date.now();
    const touch = () => (touched = Date.now());
    // Once per build per tab: if a reload somehow lands on the old build, the pill stays instead of reloading again.
    const already = session.get(RELOADED) === stale;
    const after = Date.now() + Math.random() * JITTER_MS;
    const quietly = () => {
      const idle = document.hidden || Date.now() - touched > IDLE_MS;
      if (already || Date.now() < after || !idle || busyPage()) return;
      session.set(RELOADED, stale);
      location.reload();
    };
    for (const ev of ["pointerdown", "keydown", "wheel"]) window.addEventListener(ev, touch, { passive: true, capture: true });
    const t = setInterval(quietly, 15_000);
    document.addEventListener("visibilitychange", quietly);
    quietly();
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", quietly);
      for (const ev of ["pointerdown", "keydown", "wheel"]) window.removeEventListener(ev, touch, { capture: true });
    };
  }, [stale]);

  if (!stale) return null;
  return (
    <div className="build-pill" role="status">
      <span className="build-pill-dot" aria-hidden />
      Friday was updated
      <button type="button" onClick={() => void reloadAll()}>
        Reload
      </button>
    </div>
  );
}
