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
  version: "0.2.26",
  title: "Crews, completely reworked",
  summary: "Meet your AI team. Hand a teammate a job, research, writing, planning or code, and it gets it done and keeps going while you're away.",
  items: [
    { icon: "users", title: "A team that works for you", line: "Each teammate has a role, its own memory and a profile. They run on the coding tools you already have." },
    { icon: "chat", title: "Rooms like a group chat", line: "Whole replies, their back-and-forth in one card, and side threads beside the room." },
    { icon: "clock", title: "Routines on their own", line: "Stand-ups, weekly reviews, an eye on new issues, on a schedule, while you sleep." },
    { icon: "shield", title: "Never stuck on a limit", line: "Fallbacks in order, each with its model and effort. It can ask you before it switches." },
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
