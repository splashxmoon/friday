/**
 * Voice input's rules, apart from the microphone and the page (voice.ts, VoiceMic.tsx), so each can be checked on its own
 * (test/voice.test.ts): where the words go in the box, when they are sent, when a recording stops by itself, which key talks,
 * and the WAV a server of your own is sent.
 */

/** A recording stops after this long with nothing said, as Claude Code's does. */
export const QUIET_MS = 15_000;
/** And at this length in all. */
export const MOST_MS = 120_000;
/** How loud (RMS, 0–1) counts as speaking: about -42 dBFS, over a quiet room's hiss and under a voice at arm's length. */
export const SPEAKING = 0.008;
/** The rate Whisper hears at. */
export const RATE = 16_000;

/** Why a recording stopped by itself, or null while it may go on. */
export function cutOff(at: { elapsedMs: number; quietMs: number }): "quiet" | "long" | null {
  if (at.elapsedMs >= MOST_MS) return "long";
  if (at.quietMs >= QUIET_MS) return "quiet";
  return null;
}

/** The one line that says why it stopped by itself. */
export const cutOffLine = (why: "quiet" | "long"): string => (why === "quiet" ? "Stopped after 15 seconds of quiet." : "Stopped at 2 minutes, the longest one recording runs.");

/**
 * The words heard, put in the box at the caret (or over what is selected), spaced from what is on either side: a space before them
 * unless they start the box or a new line, and one after unless what follows already starts with a space or a mark that sits
 * against a word ("," "." ")"). Returns the box's new text and where the caret goes: after the words.
 */
export function insertAt(value: string, start: number, end: number, words: string): { value: string; caret: number } {
  const said = words.trim();
  const s = Math.max(0, Math.min(start, value.length));
  const e = Math.max(s, Math.min(end, value.length));
  if (!said) return { value, caret: e };
  const before = value.slice(0, s);
  const after = value.slice(e);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^[\s,.;:!?)\]}]/.test(after) ? " " : "";
  const put = `${lead}${said}${trail}`;
  return { value: before + put + after, caret: before.length + lead.length + said.length };
}

/** How many words, for the send-when-you-stop rule. */
export const wordCount = (text: string): number => text.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** "Send when you stop": only when it's on, and only for three words or more, as Claude Code does; fewer stay in the box to read. */
export const autoSends = (text: string, on: boolean): boolean => on && wordCount(text) >= 3;

/**
 * What Whisper wrote, made fit for the box: its own markers for silence and noise ("[BLANK_AUDIO]", "(music)") taken out, its
 * leading space trimmed, and the few words it makes up from nothing ("Thank you.", "you") dropped when they are all there is.
 */
export function cleanText(raw: string): string {
  const t = raw
    .replace(/\[(?:BLANK_AUDIO|blank_audio|silence|Silence|MUSIC|Music|music|NOISE|noise|inaudible)\]|\((?:silence|music|noise|inaudible|blank audio|wind blowing)\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^(thank you\.?|thanks for watching!?|you|\.+)$/i.test(t) ? "" : t;
}

/** Texts heard in order (each part of a long recording), as one. */
export const joinParts = (parts: string[]): string => parts.map((p) => p.trim()).filter(Boolean).join(" ");

/**
 * What Whisper is told came before, so a session's own words come out as they are written: the repo and branch, then the end of
 * what is in the box (Claude Code prompts with its project's words the same way). Short: Whisper reads about 200 tokens of it.
 */
export function promptFor(o: { repo?: string; branch?: string; text?: string }): string {
  const where = [o.repo ? `Repo ${o.repo}` : "", o.branch ? `branch ${o.branch}` : ""].filter(Boolean).join(", ");
  const box = (o.text ?? "").replace(/\s+/g, " ").trim().slice(-400);
  return [where ? `${where}.` : "", box].filter(Boolean).join(" ");
}

/** One line on turning the microphone on, for where Friday runs: the desktop app, or a browser (which asks for the page first). */
export function micRefusedLine(p: string, desktop: boolean): string {
  const where = /Mac/.test(p) ? "System Settings › Privacy & Security › Microphone" : /Win/.test(p) ? "Settings › Privacy › Microphone" : "";
  if (desktop) return where ? `Turn on the microphone for Friday in ${where}.` : "Friday can't use the microphone: check it's connected and allowed in your sound settings.";
  return where ? `Allow the microphone for this page, and in ${where}.` : "Allow the microphone for this page, in the address bar.";
}

/** Megabytes, as the download prompt says them: "80 MB". */
export const mb = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1e6))} MB`;

/** "0:07", "1:42". */
export const clock = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Where to cut a long recording into Whisper's 30-second windows: the quietest tenth of a second between `from` and `to` (in
 * samples), so a word is seldom cut in half. `level(i)` is the loudness of the tenth starting at sample i.
 */
export function quietestCut(from: number, to: number, level: (i: number) => number, step = RATE / 10): number {
  let best = to;
  let low = Infinity;
  for (let i = from; i + step <= to; i += step) {
    const l = level(i);
    if (l < low) (low = l), (best = i + step / 2);
  }
  return Math.round(best);
}

/** 16-bit PCM WAV of mono samples, for a speech server of your own. */
export function wav(samples: Float32Array, rate = RATE): Uint8Array {
  const out = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(out);
  const str = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 0x7fff), true);
  return new Uint8Array(out);
}

/** The languages voice input offers, as Whisper names them: the ones it hears best, about as many as Claude Code offers. */
export const LANGUAGES: readonly (readonly [string, string])[] = [
  ["en", "English"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["nl", "Dutch"],
  ["sv", "Swedish"],
  ["pl", "Polish"],
  ["cs", "Czech"],
  ["uk", "Ukrainian"],
  ["ru", "Russian"],
  ["tr", "Turkish"],
  ["ar", "Arabic"],
  ["hi", "Hindi"],
  ["id", "Indonesian"],
  ["vi", "Vietnamese"],
  ["zh", "Chinese"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
];

/** A speech-to-text model by its name at a server: Whisper, and the "transcribe" models OpenAI and others name so. */
export const isSpeechModel = (name: string): boolean => /whisper|transcri|speech-to-text|\bstt\b|parakeet|canary|voxtral/i.test(name) && !/\btts\b|text-to-speech/i.test(name);
