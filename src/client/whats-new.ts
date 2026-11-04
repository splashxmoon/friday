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
  version: "0.2.10",
  summary: "Your crew checks its work against your rules, knows which tests were failing before it started, and each agent runs its own copy of the app.",
  items: [
    { icon: "shield", title: "Rules that stick", line: "Say “never touch the migrations” once and every agent's work is checked against it." },
    { icon: "rewind", title: "Was it already broken?", line: "A failing test is checked against the code from before the agent started." },
    { icon: "box", title: "Every agent its own app", line: "Its own ports and its own copy of the database, so two can run the app at once." },
    { icon: "terminal", title: "Add a computer", line: "Run agents on another machine over SSH, or with one command pasted there." },
  ],
};

/** The release's own page, for everything else it changed. */
export const notesUrl = (version: string) => `https://github.com/splashxmoon/friday/releases/tag/v${version}`;

/** The sheet is due: someone who has used Friday before, on notes they haven't been shown. Someone new has the welcome instead. */
export function whatsNewDue(notes: string, seen: string | null, returning: boolean): boolean {
  return returning && seen !== notes;
}
