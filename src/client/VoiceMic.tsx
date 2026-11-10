import { lazy, Suspense, useEffect, useRef, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { isLocal } from "./edition.js";
import { Icon } from "./icons.js";
import type { VoiceEngine, VoiceState } from "./voice-engine.js";
import { isTalkKey, isTalkRelease, platformOf, talkLabel } from "./voice-keys.js";

/**
 * Voice input in a box (design A, Arun 2026-11-09): the mic just before Send, and while it listens, the footer's left side says
 * "● Listening · 0:07" with a level meter that moves only with the voice, "Esc to cancel" on the right and the mic a filled Stop.
 * The words still being heard show grey under the text; on stop they go in at the caret, spaced, editable before sending.
 *
 * One hook for every box (the session's, the Crew room's, a teammate's chat, the home box), which hands it the textarea, a way to
 * set its text, and a way to send it. Only in the open-source edition for now (isLocal). What does the work (voice-engine.ts) and
 * the footer's line (voice-bar.tsx) load at the first press: the app's first load carries the mic and the key, nothing more.
 */

export type VoicePhase =
  | { kind: "idle" }
  /** The first press: the model isn't here yet, and the box asks before downloading it. */
  | { kind: "offer"; bytes: number }
  | { kind: "downloading"; got: number; bytes: number }
  | { kind: "starting" }
  | { kind: "listening" }
  | { kind: "finishing" }
  | { kind: "note"; text: string; bad?: boolean; settings?: boolean };

export interface Voice extends VoiceState {
  on: boolean;
  press(): void;
  cancel(): void;
  download(): void;
  /** The talk shortcut and Esc, from the box's own key handlers: true when voice took the key. */
  keyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>): boolean;
  keyUp(e: ReactKeyboardEvent<HTMLTextAreaElement>): boolean;
}

const PLATFORM = platformOf(typeof navigator === "undefined" ? "" : navigator.platform);
const IDLE: VoiceState = { phase: { kind: "idle" }, live: "", liveText: true, ms: 0, levels: [] };
let code: Promise<typeof import("./voice-engine.js")> | null = null;

export function useVoice(o: {
  box: RefObject<HTMLTextAreaElement | null>;
  /** The box's text, set by voice: the composer's own state, or the home box's. */
  onText: (value: string) => void;
  /** Sends the box, for "Send when you stop". */
  send: () => void;
  /** The session's repo and branch, for the words Whisper should expect. */
  context?: () => { repo?: string; branch?: string };
}): Voice {
  const on = isLocal();
  const latest = useRef(o);
  latest.current = o;
  const held = useRef(false);
  const engine = useRef<VoiceEngine | null>(null);
  const loading = useRef<Promise<VoiceEngine> | null>(null);
  // Read through a stable pair of functions, so the engine arriving later is picked up without a new subscription each render.
  const subs = useRef(new Set<() => void>());
  const subscribe = useRef((f: () => void) => (subs.current.add(f), () => void subs.current.delete(f))).current;
  const st = useSyncExternalStore(subscribe, () => engine.current?.get() ?? IDLE);
  const ready = (): Promise<VoiceEngine> =>
    (loading.current ??= (code ??= import("./voice-engine.js")).then((m) => {
      const e = m.voiceEngine({
        box: () => latest.current.box.current,
        onText: (v) => latest.current.onText(v),
        send: () => latest.current.send(),
        context: () => latest.current.context?.() ?? {},
        held: () => held.current,
      });
      e.subscribe(() => subs.current.forEach((f) => f()));
      engine.current = e;
      return e;
    }));
  // Gone from the page mid-recording (the session closed): the microphone is let go.
  useEffect(() => () => engine.current?.dispose(), []);

  return {
    ...st,
    on,
    press: () => void ready().then((e) => e.press()),
    cancel: () => engine.current?.cancel(),
    download: () => void ready().then((e) => e.download()),
    keyDown: (e) => {
      if (!on) return false;
      if (!isTalkKey(e, PLATFORM)) return engine.current?.key(e.nativeEvent) ?? false;
      // ⌥ Space types a no-break space on a Mac: never, here.
      e.preventDefault();
      if (!e.repeat) {
        held.current = true;
        void ready().then((x) => x.talk());
      }
      return true;
    },
    keyUp: (e) => {
      if (!isTalkRelease(e, PLATFORM)) return false;
      held.current = false;
      return engine.current?.release(e.nativeEvent) ?? false;
    },
  };
}

const Bar = lazy(() => import("./voice-bar.js"));

/** The footer's left side while voice has something to say: listening, the download, or one line on what happened. */
export function VoiceBar({ v }: { v: Voice }) {
  if (!v.on || v.phase.kind === "idle") return null;
  return (
    <Suspense fallback={<span className="voice-bar" />}>
      <Bar v={v} />
    </Suspense>
  );
}

/** The grey words still being heard, inside the box under what is typed. */
export function VoiceLive({ v }: { v: Voice }) {
  if (!v.on || !v.liveText || (v.phase.kind !== "listening" && v.phase.kind !== "finishing")) return null;
  return (
    <div className="voice-live" aria-live="polite">
      {v.live}
    </div>
  );
}

/**
 * The mic, just before Send; while it listens, "Esc to cancel" and a filled Stop. `kind`: the session's box (its prompt buttons'
 * size) or the home box (its icon buttons').
 */
export function VoiceButton({ v, kind }: { v: Voice; kind: "prompt" | "home" }) {
  if (!v.on) return null;
  const k = v.phase.kind;
  const live = k === "listening" || k === "starting" || k === "finishing";
  return (
    <span className={`voice-right in-${kind}`}>
      {live && <span className="voice-esc">Esc to cancel</span>}
      <button
        type="button"
        className={live ? "voice-mic voice-stop" : "voice-mic"}
        aria-label={live ? "Stop, and put the words in the box" : "Talk instead of typing"}
        title={live ? "Stop: the words go in the box" : `Talk instead of typing (${talkLabel(PLATFORM)})`}
        disabled={k === "finishing"}
        // The box keeps the keyboard, and where its caret is: the words go there.
        onMouseDown={(e) => e.preventDefault()}
        onClick={v.press}
      >
        {live ? <Icon name="stop" size={12} strokeWidth={0} className="voice-stop-mark" /> : <Icon name="mic" size={16} />}
      </button>
    </span>
  );
}
