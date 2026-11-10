import { useSyncExternalStore } from "react";

/** Voice input's settings (Settings › General › Voice, VoiceSettings.tsx), read by every box (VoiceMic.tsx). */

export interface VoicePrefs {
  /** Where speech is made into words: "here" on this computer, "key" through a server saved in Your models. */
  engine: "here" | "key";
  /** For "key": the saved model whose server (and key) is used, by its id in Your models. */
  own: string;
  /** For "key": the speech model's name at that server ("whisper-large-v3-turbo", "gpt-4o-mini-transcribe"). */
  ownModel: string;
  /** Hold the shortcut to talk, or tap it once to start and once to stop. */
  start: "hold" | "tap";
  language: string;
  /** Send what was said when you stop (three words or more). Off: it waits in the box. */
  send: boolean;
}
export const VOICE_DEFAULTS: VoicePrefs = { engine: "here", own: "", ownModel: "", start: "hold", language: "en", send: false };
// mpa.*: kept beside the data too (page-keep.ts), so a change of port keeps them.
const KEY = "mpa.voice";
const CHANGED = "friday:voice";
let cached: { raw: string | null; prefs: VoicePrefs } | null = null;

export function voicePrefs(): VoicePrefs {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    // Storage blocked: the defaults.
  }
  if (cached && cached.raw === raw) return cached.prefs;
  let got: Partial<VoicePrefs> = {};
  try {
    got = raw ? (JSON.parse(raw) as Partial<VoicePrefs>) : {};
  } catch {
    got = {};
  }
  const prefs: VoicePrefs = {
    engine: got.engine === "key" ? "key" : "here",
    own: typeof got.own === "string" ? got.own : "",
    ownModel: typeof got.ownModel === "string" ? got.ownModel : "",
    start: got.start === "tap" ? "tap" : "hold",
    language: typeof got.language === "string" && /^[a-z]{2,3}$/.test(got.language) ? got.language : "en",
    send: got.send === true,
  };
  cached = { raw, prefs };
  return prefs;
}

export function setVoicePrefs(patch: Partial<VoicePrefs>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...voicePrefs(), ...patch }));
  } catch {
    // Storage blocked: the choice lasts as long as nothing reads it again.
  }
  dispatchEvent(new Event(CHANGED));
}

const onPrefs = (f: () => void) => {
  addEventListener(CHANGED, f);
  addEventListener("storage", f);
  return () => (removeEventListener(CHANGED, f), removeEventListener("storage", f));
};
export const useVoicePrefs = (): VoicePrefs => useSyncExternalStore(onPrefs, voicePrefs);
