import type { IconName } from "./icons.js";

/**
 * What the What's new sheet says after an update (WhatsNew.tsx): the release's few changes worth stopping for, written with its
 * notes at each open-source release (the changelog's top entry says everything; this says four things). The sheet shows once for
 * each `version` here, so a release that leaves this as it was shows nothing new.
 */
export interface WhatsNewNotes {
  /** The release these are for, as tagged (v0.2.10 → "0.2.10"). */
  version: string;
  /** One sentence under the title: what the release adds up to. */
  summary: string;
  /** Up to four, in a two-by-two grid. */
  items: { icon: IconName; title: string; line: string }[];
}

export const WHATS_NEW: WhatsNewNotes = {
  version: "0.2.18",
  summary: "Run on another of your computers from the new-session page, a calmer Code Review with a real guided tour, and an Agent Board you answer from.",
  items: [
    { icon: "server", title: "Runs on, above the box", line: "Pick this computer or another of yours, or add one, right where you start." },
    { icon: "gitPullRequest", title: "Code Review, said once", line: "One card says what stands before the merge, with each fix beside it." },
    { icon: "compass", title: "A real guided tour", line: "Each file in the order to read it, with its diff and what your agents found." },
    { icon: "board", title: "Answer from the board", line: "What waits on you is across the top: answer it there, and the agent carries on." },
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
