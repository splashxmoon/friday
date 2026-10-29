/**
 * Unsaved work that asks before it is left, whichever way out is taken: the app's own navigation (the sidebar, a toast, the
 * palette), the browser's Back, switching between Code, Work and Crew, and closing or reloading the window. Only its own Back
 * arrow asked before, and a workflow's unsaved steps went without a word by every other route (QA, 2026-10-28; Arun: "TEST
 * EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
 *
 * One screen holds it at a time (the one with the unsaved work), with its own question; whoever is about to take the person
 * elsewhere calls `leaving(go)` first, and goes only if it returns false. Asked and confirmed, the hold is let go and `go` runs.
 */
interface Hold {
  /** Asks, in the screen's own words, and calls `go` if the person says to leave. */
  ask: (go: () => void) => void;
  /** Where the page was when it took hold: the address Back is undone to while it asks. */
  url: string;
}

let hold: Hold | null = null;

/** Hold the way out while there is unsaved work; the returned function lets go. */
export function holdLeave(ask: Hold["ask"]): () => void {
  const mine: Hold = { ask, url: location.href };
  hold = mine;
  const unload = (e: BeforeUnloadEvent) => {
    e.preventDefault();
    e.returnValue = "";
  };
  addEventListener("beforeunload", unload);
  return () => {
    removeEventListener("beforeunload", unload);
    if (hold === mine) hold = null;
  };
}

/** About to leave: true when something holds the way and is asking (it calls `go` itself if the person agrees). */
export function leaving(go: () => void): boolean {
  const h = hold;
  if (!h) return false;
  h.ask(() => {
    if (hold === h) hold = null;
    go();
  });
  return true;
}

/**
 * The browser's Back (or Forward) while something holds: the address it moved to is undone at once, and the question asked; agreed,
 * it goes back again for real. True when it was held.
 */
export function leavingByHistory(): boolean {
  const h = hold;
  if (!h) return false;
  history.pushState(null, "", h.url);
  return leaving(() => history.back());
}
