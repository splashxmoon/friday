import { flushSync } from "react-dom";
import { modelStatus, Recorder, startDownload, transcribeWithKey, whisper, type ModelStatus } from "./voice.js";
import { isTalkRelease, platformOf, talkLabel } from "./voice-keys.js";
import { voicePrefs, type VoicePrefs } from "./voice-prefs.js";
import { autoSends, cleanText, cutOff, cutOffLine, insertAt, joinParts, micRefusedLine, promptFor, quietestCut, RATE, SPEAKING } from "./voice-text.js";
import type { VoicePhase } from "./VoiceMic.js";

/**
 * One box's voice input, at work (VoiceMic.tsx): the microphone opened, the live passes, the long recording cut into Whisper's
 * windows, the cut-offs, the words put in the box, the model's download followed. Loaded the first time a mic is pressed, so the
 * app's first load doesn't carry it (test/client-bundle.test.ts).
 */

/** What the box gives voice: its textarea, how to set its text and send it, and what it is about. */
export interface VoiceHost {
  box(): HTMLTextAreaElement | null;
  onText(value: string): void;
  send(): void;
  context(): { repo?: string; branch?: string };
  /** Whether the talk key is still held, for a release heard before the microphone had opened. */
  held(): boolean;
}

/** How voice stands in one box, for the box to draw (VoiceMic.tsx). */
export interface VoiceState {
  phase: VoicePhase;
  /** The grey words still being heard. */
  live: string;
  /** Whether grey words can show: only on this computer, not through a server of your own. */
  liveText: boolean;
  ms: number;
  levels: number[];
}

export interface VoiceEngine {
  get(): VoiceState;
  subscribe(f: () => void): () => void;
  /** The mic pressed: start, or stop what is under way. */
  press(): void;
  /** The talk key pressed (not a repeat): start, or in tap mode stop. */
  talk(): void;
  /** Another key in the box while voice is up: true when voice took it. */
  key(e: KeyboardEvent): boolean;
  /** A key let go in the box: true when it ended a held recording. */
  release(e: KeyboardEvent): boolean;
  cancel(): void;
  download(): void;
  dispose(): void;
}

const METER = 7;
const STILL = Array<number>(METER).fill(0);

/** A live pass on the words so far, this often (Whisper takes 2 seconds or so a pass; one runs at a time). */
const LIVE_MS = 1500;
/** Whisper hears 30 seconds at a time: a longer recording is cut, at a quiet moment, before this. */
const WINDOW = 28 * RATE;

interface Run {
  prefs: VoicePrefs;
  prompt: string;
  rec: Recorder | null;
  t0: number;
  quietMs: number;
  /** Where the words go: the caret or selection when it started, and the box's text then. */
  sel: { start: number; end: number; value: string };
  /** The part of a long recording not yet closed off, from this sample. */
  from: number;
  /** The closed parts' final words, in order, and those already known. */
  parts: Promise<string>[];
  known: string[];
  lastPass: number;
  ready: boolean;
  byKey: boolean;
  /** Let go of the key (or pressed Stop) before the microphone had opened. */
  stopSoon: boolean;
  stopping: boolean;
  over: boolean;
  timer?: ReturnType<typeof setInterval>;
}

export function voiceEngine(host: VoiceHost): VoiceEngine {
  let run: Run | null = null;
  let poll: ReturnType<typeof setInterval> | undefined;
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  const platform = platformOf(navigator.platform);
  // The box's state, as a small store the box reads with useSyncExternalStore.
  let state: VoiceState = { phase: { kind: "idle" }, live: "", liveText: voicePrefs().engine === "here", ms: 0, levels: STILL };
  const subs = new Set<() => void>();
  const set = (patch: Partial<VoiceState>) => {
    state = { ...state, ...patch };
    for (const f of subs) f();
  };
  const show = (p: VoicePhase) => {
    clearTimeout(noteTimer);
    set({ phase: p, ...(p.kind === "idle" ? { liveText: voicePrefs().engine === "here" } : {}) });
    listen(p.kind === "listening" || p.kind === "starting" || p.kind === "finishing");
    // A note that only informs goes by itself; one that asks something of you stays until you act on it.
    if (p.kind === "note" && !p.bad && !p.settings) noteTimer = setTimeout(() => state.phase === p && show({ kind: "idle" }), 6000);
  };
  const h = {
    ...host,
    show,
    phase: () => state.phase,
    live: (live: string) => set({ live }),
    ms: (ms: number) => set({ ms }),
    level: (rms: number | null) => set({ levels: rms === null ? STILL : [...state.levels.slice(1 - METER), rms] }),
    platform,
  };

  // Esc anywhere while it listens, and the key let go anywhere when it was held: the box may have lost the keyboard meanwhile.
  let listening = false;
  const esc = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };
  const up = (e: KeyboardEvent) => void release(e);
  function listen(on: boolean) {
    if (on === listening) return;
    listening = on;
    if (on) (addEventListener("keydown", esc, true), addEventListener("keyup", up, true));
    else (removeEventListener("keydown", esc, true), removeEventListener("keyup", up, true));
  }

  const end = (r: Run) => {
    r.over = true;
    clearInterval(r.timer);
    r.rec?.close();
    if (run === r) run = null;
    h.live("");
    h.level(null);
  };

  /** Following a download the server is doing, until the model is here or it stopped. */
  const follow = (s: ModelStatus) => {
    h.show({ kind: "downloading", got: s.got ?? 0, bytes: s.bytes });
    clearInterval(poll);
    poll = setInterval(() => {
      void modelStatus().then(
        (now) => {
          if (h.phase().kind !== "downloading") return void clearInterval(poll);
          if (now.ready) {
            clearInterval(poll);
            h.show({ kind: "note", text: `Voice is ready. Press the mic, or ${voicePrefs().start === "tap" ? "press" : "hold"} ${talkLabel(h.platform)}, and talk.` });
          } else if (now.got === undefined) {
            clearInterval(poll);
            h.show({ kind: "note", text: now.error || "The download stopped. Press the mic to try again.", bad: true });
          } else h.show({ kind: "downloading", got: now.got, bytes: now.bytes });
        },
        () => {},
      );
    }, 500);
  };

  /** Puts what was heard in the box, and sends it when that's asked for. */
  const land = (r: Run, text: string) => {
    const el = h.box();
    if (!el) return;
    const now = el.value;
    // Typed into meanwhile: at the caret as it is now (or the end), not where it was.
    const at = now === r.sel.value ? r.sel : document.activeElement === el ? { start: el.selectionStart, end: el.selectionEnd } : { start: now.length, end: now.length };
    const put = insertAt(now, at.start, at.end, text);
    flushSync(() => h.onText(put.value));
    if (el.value !== put.value) el.value = put.value;
    el.focus();
    el.setSelectionRange(put.caret, put.caret);
    if (autoSends(text, r.prefs.send)) h.send();
  };

  const stop = async (why?: "quiet" | "long") => {
    const r = run;
    // Once: the key let go is heard by the box and by the page, and ⌥ after Space.
    if (!r || r.over || r.stopping) return;
    if (!r.rec) return void (r.stopSoon = true);
    r.stopping = true;
    clearInterval(r.timer);
    r.rec.close();
    h.level(null);
    h.show({ kind: "finishing" });
    const rec = r.rec;
    let text = "";
    try {
      if (r.prefs.engine === "key") {
        text = rec.spoke() ? cleanText(await transcribeWithKey(rec.slice(), { own: r.prefs.own, model: r.prefs.ownModel, language: r.prefs.language, prompt: r.prompt })) : "";
      } else {
        const before = (await Promise.all(r.parts)).map(cleanText);
        const last = rec.spoke(r.from) ? cleanText(await whisper.transcribe(rec.slice(r.from), r.prefs.language, joinParts([r.prompt, ...before]))) : "";
        text = joinParts([...before, last]);
      }
    } catch (e) {
      if (r.over) return;
      end(r);
      return h.show({ kind: "note", text: e instanceof Error ? e.message : String(e), bad: true });
    }
    if (r.over) return;
    end(r);
    // Nothing heard: the box stays as it was.
    if (text) land(r, text);
    h.show(why ? { kind: "note", text: cutOffLine(why) } : { kind: "idle" });
  };

  /** A live pass, and closing off a part of a long recording at a quiet moment. */
  const tick = (r: Run) => {
    const rec = r.rec;
    if (!rec || r.over) return;
    const elapsed = performance.now() - r.t0;
    h.ms(elapsed);
    const why = cutOff({ elapsedMs: elapsed, quietMs: r.quietMs });
    if (why) return void stop(why);
    if (r.prefs.engine !== "here" || !r.ready) return;
    if (rec.length - r.from > WINDOW) {
      const cut = quietestCut(r.from + 20 * RATE, r.from + WINDOW, rec.levelAt);
      const part = rec.spoke(r.from, cut) ? whisper.transcribe(rec.slice(r.from, cut), r.prefs.language, joinParts([r.prompt, ...r.known])).then(cleanText) : Promise.resolve("");
      r.parts.push(part);
      void part.then((t) => void r.known.push(t), () => {});
      r.from = cut;
    }
    if (whisper.busy || elapsed - r.lastPass < LIVE_MS || !rec.spoke(r.from)) return;
    r.lastPass = elapsed;
    void whisper
      .transcribe(rec.slice(r.from), r.prefs.language, joinParts([r.prompt, ...r.known]))
      .then((t) => !r.over && !r.stopping && h.live(joinParts([...r.known, cleanText(t)])))
      .catch(() => {});
  };

  const begin = async (byKey: boolean) => {
    if (run) return;
    const p = voicePrefs();
    if (p.engine === "key" && (!p.own || !p.ownModel)) return h.show({ kind: "note", text: "Pick the speech model to use in Settings › General › Voice.", settings: true });
    const el = h.box();
    const value = el?.value ?? "";
    const r: Run = {
      prefs: p,
      prompt: promptFor({ ...h.context(), text: value }),
      rec: null,
      t0: performance.now(),
      quietMs: 0,
      sel: el && document.activeElement === el ? { start: el.selectionStart, end: el.selectionEnd, value } : { start: value.length, end: value.length, value },
      from: 0,
      parts: [],
      known: [],
      lastPass: 0,
      ready: false,
      byKey,
      stopSoon: false,
      stopping: false,
      over: false,
    };
    run = r;
    h.live("");
    set({ liveText: p.engine === "here" });
    if (p.engine === "here") {
      let s: ModelStatus;
      try {
        s = await modelStatus();
      } catch (e) {
        end(r);
        return h.show({ kind: "note", text: (e as Error).message, bad: true });
      }
      if (r.over) return;
      if (!s.ready) {
        end(r);
        return s.got !== undefined ? follow(s) : h.show({ kind: "offer", bytes: s.bytes });
      }
      void whisper.load(s).then(
        () => void (r.ready = true),
        (e: Error) => {
          if (r.over) return;
          end(r);
          h.show({ kind: "note", text: `Voice couldn't start on this computer: ${e.message}`, bad: true });
        },
      );
    }
    h.show({ kind: "starting" });
    try {
      r.rec = await Recorder.open((rms) => {
        r.quietMs = rms >= SPEAKING ? 0 : r.quietMs + 100;
        h.level(rms);
      });
    } catch (e) {
      end(r);
      const name = (e as { name?: string }).name ?? "";
      const text = name === "NotAllowedError" || name === "SecurityError" ? micRefusedLine(navigator.platform, !!window.fridayDesktop) : name === "NotFoundError" ? "No microphone found. Connect one and try again." : `The microphone didn't start: ${(e as Error).message}`;
      return h.show({ kind: "note", text, bad: true });
    }
    if (r.over) return void r.rec.close();
    r.t0 = performance.now();
    h.ms(0);
    h.show({ kind: "listening" });
    r.timer = setInterval(() => tick(r), 100);
    // Let go (hold) or Stop pressed while the microphone was opening.
    if (r.stopSoon || (byKey && p.start === "hold" && !h.held())) void stop();
  };

  function cancel() {
    if (run) end(run);
    clearInterval(poll);
    show({ kind: "idle" });
  }
  function release(e: KeyboardEvent): boolean {
    if (!isTalkRelease(e, platform) || !run?.byKey || run.prefs.start !== "hold") return false;
    e.preventDefault();
    void stop();
    return true;
  }
  const press = () => {
    const k = state.phase.kind;
    if (k === "listening" || k === "starting") return void stop();
    if (k === "finishing") return;
    if (k === "offer" || k === "downloading") return show({ kind: "idle" });
    void begin(false);
  };

  return {
    get: () => state,
    subscribe: (f) => (subs.add(f), () => void subs.delete(f)),
    press,
    talk: () => (voicePrefs().start === "tap" ? press() : !run && void begin(true)),
    key: (e) => {
      const k = state.phase.kind;
      // Held, with ⌥ let go first: Space goes on repeating, and isn't typed while the recording is held.
      if (run?.byKey && (k === "starting" || k === "listening") && e.code === "Space") return (e.preventDefault(), true);
      if ((k === "note" || k === "offer") && e.key === "Escape") return (e.preventDefault(), cancel(), true);
      // Typing puts a note away.
      if (k === "note") show({ kind: "idle" });
      return false;
    },
    release,
    cancel,
    download: () => void startDownload().then(follow, (e: Error) => show({ kind: "note", text: e.message, bad: true })),
    dispose: () => {
      if (run) end(run);
      clearInterval(poll);
      clearTimeout(noteTimer);
      listen(false);
    },
  };
}
