// What the new-session box calls each permission, and what each means: one set of words for the box's pill and the folder
// card's, so the two never say it differently (Friday Teams' StartControls.tsx, whose words these are). Teams also keeps the
// box's controls themselves here, shared with a channel's Start a session sheet and a task's "Hand to ▾"; the open-source
// edition has neither, so its controls stay in Code.tsx.
import type { EngineMode } from "../types.js";

/** The new-session box's last permission choice, on this computer. */
export const MODE_KEY = "friday.newSession.mode";
/** How the choice is named on the button and in the list. */
export const MODE_NAME: Record<EngineMode, string> = { plan: "Read only", edits: "Edits", full: "Full access" };
export const MODE_BLURB: Record<EngineMode, string> = {
  plan: "Reads and proposes, and asks before it runs a command. Changes nothing.",
  edits: "Edits files, and asks before it runs a command.",
  full: "Runs commands without asking.",
};
