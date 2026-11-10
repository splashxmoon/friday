import { RATE, SPEAKING, wav } from "./voice-text.js";
import type { VoiceAsk, VoicePaths, VoiceSays } from "./voice-worker.js";

/**
 * Voice input (Arun, 2026-11-09: "how Claude Code does voice input… build it into the open-source build", design A): talk into
 * any box where you tell an agent what to do. The mic in the box, or ⌥ Space held (Ctrl+Shift+Space on Windows and Linux).
 *
 * Two ways to make speech into words, chosen in Settings › General › Voice:
 *  - On this computer (the default): Whisper in a worker (voice-worker.ts), its model downloaded once by Friday's server after the
 *    person says yes, and served from there (voice-models.ts). The audio never leaves the page.
 *  - With your own key: the recording goes to Friday's server, which sends it to the speech model of a server saved in Your models
 *    (runner/own-models.ts ownTranscribe), with that server's key, which never reaches the page.
 *
 * Claude Code's own voice mode runs on Anthropic's servers behind a claude.ai sign-in, so Friday can't use it, and never reads its
 * token. This file holds the settings, the model's download, the worker and the microphone; VoiceMic.tsx the box's part.
 */

// ── the model on this computer ───────────────────────────────────────

export interface ModelStatus {
  model: string;
  dtype: string;
  /** Where Friday serves the model, the engine and its runtime, once they are downloaded (voice-models.ts). */
  paths: VoicePaths;
  /** The model and the engine together. */
  bytes: number;
  ready: boolean;
  got?: number;
  error?: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: "same-origin", ...init });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error || `Friday answered ${r.status}.`);
  return j;
}
export const modelStatus = (): Promise<ModelStatus> => call<ModelStatus>("/api/voice/model");
/** The download, started (it runs on Friday's server, whatever the page does meanwhile). */
export const startDownload = (): Promise<ModelStatus> => call<ModelStatus>("/api/voice/model", { method: "POST" });

// ── Whisper, in its worker ───────────────────────────────────────────

type Pending = { resolve: (t: string) => void; reject: (e: Error) => void };
/**
 * The one worker for the page, shared by every box: started at the first press of a mic, and let go after five minutes unused,
 * so the model's memory isn't held all day for something used now and then.
 */
class Whisper {
  private worker: Worker | null = null;
  private loading: Promise<"webgpu" | "wasm"> | null = null;
  private pending = new Map<number, Pending>();
  private next = 1;
  private idle: ReturnType<typeof setTimeout> | undefined;
  /** How many asks are out: a live pass is skipped while one runs, rather than queued behind it. */
  busy = 0;

  load(m: Pick<ModelStatus, "model" | "dtype" | "paths">): Promise<"webgpu" | "wasm"> {
    this.touch();
    if (this.loading) return this.loading;
    const w = new Worker("/voice-worker.js", { type: "module", name: "voice" });
    this.worker = w;
    this.loading = new Promise((resolve, reject) => {
      w.onmessage = (e: MessageEvent<VoiceSays>) => {
        const d = e.data;
        if (d.type === "loaded") resolve(d.device);
        else if (d.type === "text") this.settle(d.id, (p) => p.resolve(d.text));
        else if (d.type === "error" && d.id) this.settle(d.id, (p) => p.reject(new Error(d.message)));
        else if (d.type === "error") (reject(new Error(d.message)), this.drop());
      };
      w.onerror = () => (reject(new Error("Voice input couldn't start on this computer.")), this.drop());
    });
    this.loading.catch(() => {});
    w.postMessage({ type: "load", model: m.model, dtype: m.dtype, paths: m.paths } satisfies VoiceAsk);
    return this.loading;
  }

  async transcribe(audio: Float32Array, language: string, prompt: string): Promise<string> {
    if (!this.worker || !this.loading) throw new Error("Voice input isn't loaded.");
    await this.loading;
    this.touch();
    const id = this.next++;
    this.busy++;
    try {
      return await new Promise<string>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.worker!.postMessage({ type: "transcribe", id, audio, language, prompt } satisfies VoiceAsk);
      });
    } finally {
      this.busy--;
      this.touch();
    }
  }

  private settle(id: number, f: (p: Pending) => void) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    f(p);
  }
  private touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.busy === 0 && this.drop(), 5 * 60_000);
  }
  private drop() {
    clearTimeout(this.idle);
    this.worker?.terminate();
    this.worker = null;
    this.loading = null;
    for (const p of this.pending.values()) p.reject(new Error("Voice input stopped."));
    this.pending.clear();
  }
}
export const whisper = new Whisper();

// ── through a server of your own ─────────────────────────────────────

export async function transcribeWithKey(audio: Float32Array, o: { own: string; model: string; language: string; prompt: string }): Promise<string> {
  const r = await call<{ text: string }>("/api/voice/transcribe", {
    method: "POST",
    headers: { "Content-Type": "audio/wav", "x-voice-own": o.own, "x-voice-model": o.model, "x-voice-language": o.language, "x-voice-prompt": encodeURIComponent(o.prompt.slice(-800)) },
    body: wav(audio) as BodyInit,
  });
  return r.text ?? "";
}

// ── the microphone ───────────────────────────────────────────────────

/** Gathers the mic's sound in tenths of a second, with how loud each was: in a worklet, off the page's own thread. */
const WORKLET = `registerProcessor("friday-voice", class extends AudioWorkletProcessor {
  constructor() { super(); this.n = 0; this.size = Math.round(sampleRate / 10); this.buf = new Float32Array(this.size); }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.size) {
        let sum = 0;
        for (let j = 0; j < this.size; j++) sum += this.buf[j] * this.buf[j];
        this.port.postMessage({ pcm: this.buf, rms: Math.sqrt(sum / this.size) }, [this.buf.buffer]);
        this.buf = new Float32Array(this.size);
        this.n = 0;
      }
    }
    return true;
  }
});`;

/** Linear resampling to 16 kHz, for a microphone a 16 kHz context couldn't take as it is (a browser that won't resample). */
function to16k(x: Float32Array, from: number): Float32Array {
  if (from === RATE) return x;
  const n = Math.floor((x.length * RATE) / from);
  const out = new Float32Array(n);
  const step = from / RATE;
  for (let i = 0; i < n; i++) {
    const at = i * step;
    const k = Math.floor(at);
    const f = at - k;
    out[i] = (x[k] ?? 0) * (1 - f) + (x[k + 1] ?? x[k] ?? 0) * f;
  }
  return out;
}

/**
 * One recording: the microphone, opened at 16 kHz mono, its sound kept as it comes with the loudness of each tenth of a second.
 * `heard` hears each tenth's loudness, for the level meter and the quiet cut-off.
 */
export class Recorder {
  private parts: Float32Array[] = [];
  private levels: number[] = [];
  length = 0;
  private constructor(
    private stream: MediaStream,
    private ctx: AudioContext,
    private node: AudioWorkletNode,
    private url: string,
  ) {}

  static async open(heard: (rms: number) => void): Promise<Recorder> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: true }, video: false });
    let ctx: AudioContext;
    let source: MediaStreamAudioSourceNode;
    try {
      ctx = new AudioContext({ sampleRate: RATE });
      source = ctx.createMediaStreamSource(stream);
    } catch {
      ctx = new AudioContext();
      source = ctx.createMediaStreamSource(stream);
    }
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } catch (e) {
      URL.revokeObjectURL(url);
      for (const t of stream.getTracks()) t.stop();
      void ctx.close();
      throw e;
    }
    const node = new AudioWorkletNode(ctx, "friday-voice");
    const rec = new Recorder(stream, ctx, node, url);
    const rate = ctx.sampleRate;
    node.port.onmessage = (e: MessageEvent<{ pcm: Float32Array; rms: number }>) => {
      const pcm = to16k(e.data.pcm, rate);
      rec.parts.push(pcm);
      rec.levels.push(e.data.rms);
      rec.length += pcm.length;
      heard(e.data.rms);
    };
    source.connect(node);
    // Not to the speakers: a worklet runs only when connected onward, so to a silent gain.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute).connect(ctx.destination);
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    return rec;
  }

  /** The sound from sample `from` to `to` (to the end when left out), as one array. */
  slice(from = 0, to = this.length): Float32Array {
    const out = new Float32Array(Math.max(0, to - from));
    let at = 0;
    for (const p of this.parts) {
      const a = Math.max(from - at, 0);
      const b = Math.min(to - at, p.length);
      if (b > a) out.set(p.subarray(a, b), at + a - from);
      at += p.length;
      if (at >= to) break;
    }
    return out;
  }
  /** How loud the tenth of a second at sample `i` was. */
  levelAt = (i: number): number => this.levels[Math.floor(i / (RATE / 10))] ?? 0;
  /** Whether anything between `from` and `to` was loud enough to be speech. */
  spoke(from = 0, to = this.length): boolean {
    for (let k = Math.floor(from / (RATE / 10)); k < Math.ceil(to / (RATE / 10)) && k < this.levels.length; k++) if (this.levels[k]! >= SPEAKING) return true;
    return false;
  }

  close(): void {
    this.node.port.onmessage = null;
    for (const t of this.stream.getTracks()) t.stop();
    this.node.disconnect();
    void this.ctx.close().catch(() => {});
    URL.revokeObjectURL(this.url);
  }
}
