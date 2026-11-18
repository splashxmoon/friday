import type { IconName } from "./icons.js";

/**
 * What the What's new sheet says after an update (WhatsNew.tsx): the release's few changes worth stopping for, written with its
 * notes at each open-source release (the changelog's top entry says everything; this says four things). The sheet shows once for
 * each `version` here, so a release that leaves this as it was shows nothing new.
 */
export interface WhatsNewNotes {
  /** The release these are for, as tagged (v0.2.10 → "0.2.10"). */
  version: string;
  /** The release's own headline, when it has one worth leading with; else "What's new in Friday". */
  title?: string;
  /** One sentence under the title: what the release adds up to. */
  summary: string;
  /** Up to four, in a two-by-two grid. */
  items: { icon: IconName; title: string; line: string }[];
}

export const WHATS_NEW: WhatsNewNotes = {
  version: "0.3.4",
  title: "Pictures in the chat",
  summary: "Coding tools show you pictures, threads ask each other, a team's tasks get a tab of their own, and picking a model takes a click.",
  items: [
    { icon: "image", title: "Pictures in the chat", line: "Screenshots and images your agents make show in the chat, open large, and step through with the arrow keys." },
    { icon: "handoff", title: "Threads ask each other", line: "An agent can ask another thread on the same project what it knows, and gets the answer back." },
    { icon: "list", title: "A team's tasks, in reach", line: "The side panel's Tasks tab shows every task with who has it; stop any of them, and a finished list clears itself." },
    { icon: "key", title: "A simpler model picker", line: "Search every model, star your favourites, and switch between a subscription and your own keys or local models in a click." },
  ],
};

/** The release's own page, for everything else it changed. */
export const notesUrl = (version: string) => `https://github.com/splashxmoon/friday/releases/tag/v${version}`;

/** A version as its release is tagged: 0.2.10-mine.202611040538 is 0.2.10. */
export const releaseOf = (version: string) => version.trim().replace(/^v/, "").replace(/[-+].*$/, "");

/**
 * The sheet is due only on the first start after an update (Arun, 2026-11-04: "only appears after ugrading to new version the
 * first time... like not randomly"): this Friday is a different version from the one that ran here last, these notes are this
 * version's, and they haven't been shown. Before Friday kept the last version (`last` null), someone it already knew (past the
 * welcome) counts as updated; someone new doesn't, and never sees notes for the version they installed.
 */
export function whatsNewDue(p: { notes: string; running: string; last: string | null; shown: string | null; knew: boolean }): boolean {
  const now = releaseOf(p.running);
  if (!now || p.notes !== now || p.shown === p.notes) return false;
  return p.last ? releaseOf(p.last) !== now : p.knew;
}
