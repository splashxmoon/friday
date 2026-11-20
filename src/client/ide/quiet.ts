import { awayFromApp } from "../prefs.js";
import { createHold, type Held } from "./quiet-queue.js";

/**
 * Friday's pings that respect focus (Arun, 2026-11-19, wave 4: "while you're typing in the editor, Friday holds its pings; they
 * arrive as a quiet summary when you pause"). The IDE's skin says each key pressed in an editor (vscode-skin.ts), the extension its
 * setting (friday.quietWhileTyping); Attention.tsx asks `hold` before a chime, a toast or a system notification. Held ones come back
 * as ONE toast (DoneToasts.tsx, press it to open) and a soft sound once the editor has been left alone for 20 seconds.
 *
 * Scope: Attention.tsx's pings (a run finished, something waits on you), the ones that land while you are in the IDE. The other
 * system notifications (team workflow, PR watch, tool limits, the daily brief) only fire while you are away from Friday's window,
 * where nobody types in its editor, so they are left as they are. Nothing is held while the window is away: the system notification
 * is then the only way you would hear, and a held one would be lost.
 */
// A test or a person who wants a shorter pause can set it; the default is the 20 seconds Arun asked for.
const quietMs = () => {
  try {
    const n = Number(localStorage.getItem("friday.quietMs"));
    if (n >= 500) return n;
  } catch {}
  return undefined;
};
const hold = createHold(quietMs());
// Turned off in the IDE's settings, it stays off across loads of this page (a per-person convenience; the IDE says it again when it changes).
const OFF = "friday.quiet.off";
let enabled = (() => {
  try {
    return localStorage.getItem(OFF) !== "1";
  } catch {
    return true;
  }
})();
let timer: ReturnType<typeof setTimeout> | undefined;

/** Pings from agents that block one (an approval, a question) still show, quietly: no sound. */
export const blocksAgent = (kind: string) => kind === "approval" || kind === "question" || kind === "ask";

/** What is still true, asked at release (Attention.tsx knows what waits and what runs): a wait since answered or a run started again drops out. */
let stillTrue: (h: Held) => boolean = () => true;
export const setHeldCheck = (fn: ((h: Held) => boolean) | null) => void (stillTrue = fn ?? (() => true));

/** The held ones arrive (quiet-arrive.ts, loaded only now: it is rare, and the first load stays small). */
const arrive = (all: Held[]) => void import("./quiet-arrive.js").then((m) => m.arrive(all.filter((h) => stillTrue(h))));

const flush = (force = false) => {
  clearTimeout(timer);
  timer = undefined;
  const items = hold.release(Date.now(), force);
  if (items.length) arrive(items);
  else if (hold.size()) arm();
};
// Leaving the window with pings held: they are due now, as a system notification (arrive), not lost behind the pause.
if (typeof window !== "undefined") {
  const left = () => hold.size() && awayFromApp() && flush(true);
  window.addEventListener("blur", () => setTimeout(left, 50));
  document.addEventListener("visibilitychange", left);
}
const arm = () => {
  clearTimeout(timer);
  // A little past the end of the pause, so the clock has really crossed it.
  timer = setTimeout(() => flush(), hold.wait(Date.now()) + 50);
};

/** A key pressed in the editor (or told by the IDE): the pause starts over. */
export function typed(): void {
  if (!enabled) return;
  hold.typed(Date.now());
  if (hold.size()) arm();
}

/** The setting, from the IDE. Turned off: what was held arrives now. */
export function setQuietWhileTyping(on: boolean): void {
  if (on === enabled) return;
  enabled = on;
  try {
    on ? localStorage.removeItem(OFF) : localStorage.setItem(OFF, "1");
  } catch {}
  if (!on) {
    hold.reset();
    flush(true);
  }
}

/** Whether pings are being held right now. */
export const typingNow = () => enabled && !awayFromApp() && hold.typing(Date.now());

/** Hold a ping while you type: true, and it will arrive in the summary. False: say it now. */
export function holdPing(item: Held): boolean {
  if (!enabled || awayFromApp() || !hold.hold(item, Date.now())) return false;
  arm();
  return true;
}
