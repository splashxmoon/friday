/**
 * Voice input's key (VoiceMic.tsx): ⌥ Space on a Mac, Ctrl+Shift+Space on Windows and Linux. Apart from the rest of voice so the box
 * can answer it without loading voice's engine (voice-engine.ts) until it is first used.
 */

/** Which keyboard: a Mac's ⌥ Space, or Ctrl+Shift+Space where Alt+Space opens the window's menu (Windows) or the system's (Linux). */
export type KeyPlatform = "mac" | "other";
export const platformOf = (p: string): KeyPlatform => (/Mac|iPhone|iPad/.test(p) ? "mac" : "other");

/** The shortcut as the person's keyboard names it, for hints and Settings. */
export const talkKeys = (p: KeyPlatform): string[] => (p === "mac" ? ["⌥", "Space"] : ["Ctrl", "Shift", "Space"]);
export const talkLabel = (p: KeyPlatform): string => (p === "mac" ? "⌥ Space" : "Ctrl+Shift+Space");

type Key = Pick<KeyboardEvent, "code" | "key" | "altKey" | "ctrlKey" | "shiftKey" | "metaKey">;
const space = (e: Key) => e.code === "Space" || e.key === " " || e.key === "\u00a0";

/** The talk shortcut pressed: ⌥ Space alone on a Mac (⌥ makes Space a no-break space there, which is never typed), Ctrl+Shift+Space elsewhere. */
export function isTalkKey(e: Key, p: KeyPlatform): boolean {
  if (!space(e)) return false;
  return p === "mac" ? e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey : e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;
}

/** In hold mode, the key let go that ends a recording: Space, or one of the keys held with it. */
export function isTalkRelease(e: Pick<KeyboardEvent, "code" | "key">, p: KeyPlatform): boolean {
  if (e.code === "Space" || e.key === " ") return true;
  return p === "mac" ? e.key === "Alt" : e.key === "Control" || e.key === "Shift";
}
