// What the new-session box calls each permission, and what each means: one set of words for the box's pill and the folder
// card's, so the two never say it differently (Friday Teams' StartControls.tsx, whose words these are). Teams also keeps the
// box's controls themselves here, shared with a channel's Start a session sheet and a task's "Hand to ▾"; the open-source
// edition has neither, so its controls stay in Code.tsx.
import type { EngineMode } from "../types.js";

/** The new-session box's last permission choice, on this computer. */
export const MODE_KEY = "friday.newSession.mode";
/** How the choice is named on the button and in the list. */
export const MODE_NAME: Record<EngineMode, string> = { plan: "Read only", edits: "Edits", full: "Auto" };
/** Each permission's mark: reading only, editing, Auto a bolt; Full access, past the go-ahead list, the shield (Code.tsx, ReachPill). */
export const MODE_ICON: Record<EngineMode, "eye" | "pencil" | "zap"> = { plan: "eye", edits: "pencil", full: "zap" };
export const MODE_BLURB: Record<EngineMode, string> = {
  plan: "Reads and proposes, and asks before it runs a command. Changes nothing.",
  edits: "Edits files, and asks before it runs a command.",
  full: "Edits and runs commands without asking, except the go-ahead list: shipping, sending out, deleting what isn't its own, money and keys.",
};

/**
 * Full access: Auto without the go-ahead list, everything unasked (Arun, 2026-11-18: Auto follows the guidelines other agent apps
 * keep, OpenBot's, DuskBot's, OpenClaw's and Claude Code's, and this is the way out). Its mode is full; the lane says fullAccess.
 */
export const FULL_ACCESS = {
  name: "Full access",
  icon: "shield" as const,
  blurb: "Runs everything without asking, the go-ahead list too: pushing to main, deploying, deleting, sending.",
};
/** A permission picked in the box: a mode, or Full access. */
export type Access = EngineMode | "bypass";
