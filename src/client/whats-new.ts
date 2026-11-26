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
  version: "0.4.3",
  title: "Captains",
  summary: "A Captain minds a project's coding sessions for you: it keeps work going, checks what's finished, and brings you only what needs you.",
  items: [
    { icon: "crown", title: "Captains", line: "Turn one on for a project and it minds every thread there; its row in the sidebar says what it's doing now." },
    { icon: "check", title: "Checked and ready", line: "Finished work is tested by itself, a failure goes back once, and checked work waits for your Review & ship." },
    { icon: "message", title: "Talk to it", line: "Say what should get done and it follows it to ready, splitting big tasks across your coding tools." },
    { icon: "zap", title: "Fast, solid, live", line: "Working rows show their step and clock, nothing is lost to a full disk or a crash, and long sessions open at once." },
  ],
};

/** The open-source repository, to star (2026-11-25: "I want more users and stars and contributors"). */
export const REPO_URL = "https://github.com/splashxmoon/friday";

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
