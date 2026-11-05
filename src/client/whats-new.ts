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
  version: "0.2.12",
  summary: "Friday tidies up after itself when it quits, keeps secrets out of sight, reaches your phone, and stays quick in long sessions.",
  items: [
    { icon: "phone", title: "Alerts on your phone", line: "When an agent needs you, Friday can tell an ntfy topic or any webhook." },
    { icon: "stop", title: "Nothing left running", line: "Coding tools, commands and terminals end when Friday quits, even a force-quit." },
    { icon: "shield", title: "Secrets stay hidden", line: "Tokens and webhook URLs are hidden in the chat, the Git panel and its diffs." },
    { icon: "zap", title: "Long sessions stay quick", line: "The chat draws its newest items first, so a 20,000-event session stays smooth." },
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
