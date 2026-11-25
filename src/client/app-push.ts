/**
 * What this computer's Friday says changed for its page (app.ts appChanged), over the one stream the page keeps open to it
 * (backdrop.tsx startBackdrops): "sessions" when a session's log grows, "offers" when a Friday nearby offers a link,
 * "computers" when one links or goes.
 *
 * A list that asked every few seconds asks when it is told, and once a minute besides (spec 13, Arun 2026-11-24: "Go all out and
 * fix these problems": an idle Home asked for three lists every 3 to 10 seconds and laid the page out eight times a second). Where
 * nothing tells it (the hosted app, the menu bar panel, the stream down for a moment) it asks as often as it always did. Either way
 * it doesn't ask on its own while the window is hidden, and asks as it comes back.
 */
let live = false;
let ever = false;
const subs = new Map<string, Set<() => void>>();

/** The stream opened or dropped. Opened again after a drop, everything is read again: what changed meanwhile wasn't told. */
export function pushOpen(on: boolean): void {
  const back = on && !live && ever;
  live = on;
  if (on) ever = true;
  if (back) for (const set of subs.values()) for (const f of set) f();
}

/** Told that `what` changed. */
export function pushed(what: string): void {
  for (const f of subs.get(what) ?? []) f();
}

export const pushLive = (): boolean => live;

export function onPushed(what: string, f: () => void): () => void {
  let set = subs.get(what);
  if (!set) subs.set(what, (set = new Set()));
  set.add(f);
  return () => void set.delete(f);
}

const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

/**
 * Read now, again when told any of `on` changed, and on its own every `every` ms where nothing tells it, else once a minute; never
 * on its own while the window is hidden, and at once as it comes back if a read was due. `whileHidden`: told while hidden, read
 * anyway (what says an agent needs you, which has to reach a window in the background). Returns how to stop.
 */
export function pollWhileShown(read: () => void, o: { every: number; on: string[]; whileHidden?: boolean; /** Read at once (the default), or only from the first tick. */ now?: boolean }): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let soon: ReturnType<typeof setTimeout> | undefined;
  let due = false;
  let stopped = false;
  const go = () => {
    clearTimeout(timer);
    clearTimeout(soon);
    due = false;
    read();
    next();
  };
  const next = () => {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(() => (hidden() ? (due = true) : go()), live ? Math.max(o.every, 60_000) : o.every);
  };
  // Several told at once (a burst of events, two lists changing): read once.
  const told = () => {
    if (stopped) return;
    if (hidden() && !o.whileHidden) return void (due = true);
    clearTimeout(soon);
    soon = setTimeout(go, 150);
  };
  const back = () => !hidden() && due && go();
  const offs = o.on.map((w) => onPushed(w, told));
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", back);
  if (o.now === false) next();
  else go();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(soon);
    for (const off of offs) off();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", back);
  };
}
