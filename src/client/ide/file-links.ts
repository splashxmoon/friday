import { isLocal } from "../edition.js";
import { getMode } from "./mode.js";

/**
 * Every file mention opens in the IDE (Arun, 2026-11-20, Code and Agents wired together: "Every file mention opens in the IDE"). In
 * Agents a file named anywhere (a chip in an answer, a step row, the changes card's files, a Deep Dive citation) fires
 * "friday:open-file", and the page that is showing takes it into its own viewer: that stays the plain click. Shift-click, or the
 * "Open in the IDE" entry beside it, asks for the IDE instead: the event says `ide`, and the page that knows where its files are (a
 * session: SessionView, a repo's Deep Dive) opens Code on that folder with the file at its line (mode.ts openInCode).
 *
 * This is the Shift part: it notes the click and marks the event of that click, before the page's own handler reads it. Loaded
 * after the first paint (App): nobody has pressed a file yet.
 */

/** The detail of a "friday:open-file" event. */
export interface FileOpenDetail {
  path?: string;
  line?: number;
  lane?: string;
  /** The IDE, not the page's own viewer: Shift-click, or the menu's "Open in the IDE". */
  ide?: boolean;
  /** ⌘/Ctrl-click: the person's own editor, which is the page's to open. */
  outside?: boolean;
  /** Where the click was, so a page only takes a file named inside itself (side by side, each chat has its own folder). */
  from?: Element | null;
  /** Set by the page that opened it in the IDE: the one that knows the folder takes it, and the others leave it. */
  taken?: boolean;
}

/**
 * Open a file in the IDE, as a mention's own menu does: the page that shows the file takes the event and knows its folder. Whether one
 * did is what comes back (not whether somebody took the event: a Work session takes it for its own viewer), so a mention can say so.
 */
export const askForIde = (d: { path: string; line?: number; lane?: string; from?: Element | null }): boolean => {
  const detail: FileOpenDetail = { ...d, ide: true, taken: false };
  window.dispatchEvent(new CustomEvent("friday:open-file", { detail, cancelable: true }));
  return !!detail.taken;
};

/** Listens for the click and marks the file events of a Shift-click, once, from App. */
export function installFileLinks(): () => void {
  // The mentions fire a custom event from their own click handlers and most never pass the click on: the last click is noted and read in the same turn.
  let click = { shift: false, at: -1e9 };
  const onClick = (e: MouseEvent) => (click = { shift: e.shiftKey, at: performance.now() });
  const onOpen = (e: Event) => {
    const d = (e as CustomEvent<FileOpenDetail | undefined>).detail;
    // A mention that read its own click (the chip) says so, and the timed mark is for the cards, which don't pass the click on.
    if (!d?.path || d.outside || d.ide !== undefined || !isLocal() || getMode() !== "agents") return;
    if (click.shift && performance.now() - click.at < 120) d.ide = true;
  };
  window.addEventListener("click", onClick, true);
  window.addEventListener("friday:open-file", onOpen, true);
  return () => {
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("friday:open-file", onOpen, true);
  };
}
