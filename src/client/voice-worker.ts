/**
 * Voice input on this computer (voice.ts): Whisper, run in this worker with transformers.js, so the page never waits on it.
 *
 * transformers.js isn't part of Friday: Friday's server downloads it once with the model, after the person said yes, and serves
 * it from the Friday home's models folder (voice-models.ts), as it does the runtime's .wasm and the model. So the library is
 * imported here at run time from that address, never bundled, and nothing is fetched from anywhere else; the audio never leaves
 * the page. On the graphics card (WebGPU) when this machine has one, otherwise on the processor (WASM).
 *
 * The page asks for text with a prompt: the session's repo and branch and what is already in the box, which Whisper reads as the
 * words that came before, so "useEffect", "pnpm" and the repo's own names come out as they are written (as Claude Code does).
 */

/** Where Friday serves what the worker loads (voice-models.ts VOICE.paths), and the model's name and precision. */
export interface VoicePaths {
  models: string;
  engine: string;
  ort: string;
}
export type VoiceAsk =
  | { type: "load"; model: string; dtype: string; paths: VoicePaths }
  | { type: "transcribe"; id: number; audio: Float32Array; language: string; prompt: string };
export type VoiceSays =
  | { type: "loaded"; device: "webgpu" | "wasm"; ms: number }
  | { type: "text"; id: number; text: string; ms: number }
  | { type: "error"; id?: number; message: string };

// The little of transformers.js this calls (its browser build, transformers.min.js 4.3.2), typed here: the library itself is
// no dependency of Friday's.
interface Tensor {
  tolist(): unknown[];
}
interface Tokenizer {
  get_vocab(): Map<string, number>;
  encode(text: string, o?: { add_special_tokens?: boolean }): number[];
  decode(ids: number[], o?: { skip_special_tokens?: boolean }): string;
}
interface Whisper {
  generate(o: { inputs: Tensor; decoder_input_ids: number[]; max_new_tokens: number }): Promise<Tensor>;
}
interface Transformers {
  env: { allowRemoteModels: boolean; allowLocalModels: boolean; localModelPath: string; useBrowserCache: boolean; backends: { onnx: { wasm?: { wasmPaths?: unknown } } } };
  WhisperForConditionalGeneration: { from_pretrained(id: string, o: { device: string; dtype: Record<string, string> }): Promise<Whisper> };
  AutoProcessor: { from_pretrained(id: string): Promise<(audio: Float32Array) => Promise<{ input_features: Tensor }>> };
  AutoTokenizer: { from_pretrained(id: string): Promise<Tokenizer> };
}

let loaded: Promise<{ model: Whisper; processor: (audio: Float32Array) => Promise<{ input_features: Tensor }>; tokenizer: Tokenizer; device: "webgpu" | "wasm" }> | null = null;

const say = (m: VoiceSays) => (self as unknown as Worker).postMessage(m);

async function gpu(): Promise<boolean> {
  try {
    const nav = navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } };
    return !!(await nav.gpu?.requestAdapter());
  } catch {
    return false;
  }
}

function load(a: Extract<VoiceAsk, { type: "load" }>) {
  return (loaded ??= (async () => {
    const t0 = performance.now();
    // From Friday's own server, at run time: an address the bundler can't see, so the library is never part of Friday's build.
    const at = new URL(a.paths.engine, self.location.origin).href;
    const tf = (await import(/* @vite-ignore */ at)) as Transformers;
    const { env } = tf;
    // Friday's server only: the model from the folder it was downloaded to, the runtime from beside it.
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = a.paths.models;
    // The model is on disk beside Friday already; a second copy in the browser's cache would only double it.
    env.useBrowserCache = false;
    const onnx = env.backends.onnx;
    if (onnx.wasm) onnx.wasm.wasmPaths = { mjs: `${a.paths.ort}ort-wasm-simd-threaded.asyncify.mjs`, wasm: `${a.paths.ort}ort-wasm-simd-threaded.asyncify.wasm` };
    const open = (device: "webgpu" | "wasm") => tf.WhisperForConditionalGeneration.from_pretrained(a.model, { device, dtype: { encoder_model: a.dtype, decoder_model_merged: a.dtype } });
    let device: "webgpu" | "wasm" = (await gpu()) ? "webgpu" : "wasm";
    let model: Whisper;
    try {
      model = await open(device);
    } catch (e) {
      if (device === "wasm") throw e;
      // A graphics card that can't run it (an old driver, a missing feature): the processor can.
      device = "wasm";
      model = await open(device);
    }
    const [processor, tokenizer] = await Promise.all([tf.AutoProcessor.from_pretrained(a.model), tf.AutoTokenizer.from_pretrained(a.model)]);
    say({ type: "loaded", device, ms: Math.round(performance.now() - t0) });
    return { model, processor, tokenizer, device };
  })());
}

let vocabs: Map<string, number> | null = null;
/** The tokens Whisper starts from: the prompt as "what came before", then transcribe in this language with no timestamps. */
function startTokens(tokenizer: Tokenizer, language: string, prompt: string): number[] {
  const vocab = (vocabs ??= tokenizer.get_vocab());
  const id = (t: string) => vocab.get(t);
  const start = [id("<|startoftranscript|>"), id(`<|${language}|>`) ?? id("<|en|>"), id("<|transcribe|>"), id("<|notimestamps|>")].filter((x): x is number => typeof x === "number");
  const words = prompt.trim();
  if (!words) return start;
  // Whisper reads at most 224 tokens of what came before; the last ones are the closest to what is said next.
  const prev = tokenizer.encode(` ${words}`, { add_special_tokens: false }).slice(-200);
  const sop = id("<|startofprev|>");
  return typeof sop === "number" ? [sop, ...prev, ...start] : start;
}

async function transcribe(a: Extract<VoiceAsk, { type: "transcribe" }>) {
  const t0 = performance.now();
  const { model, processor, tokenizer } = await loaded!;
  const { input_features } = await processor(a.audio);
  const first = startTokens(tokenizer, a.language, a.prompt);
  // About three words a second at most, and never past Whisper's 448: a stuck loop stops instead of filling the box.
  const most = Math.min(440 - first.length, Math.max(24, Math.round((a.audio.length / 16000) * 5)));
  const out = await model.generate({ inputs: input_features, decoder_input_ids: first, max_new_tokens: most });
  const ids = Array.from(out.tolist()[0] as (number | bigint)[], Number).slice(first.length);
  const text = tokenizer.decode(ids, { skip_special_tokens: true });
  say({ type: "text", id: a.id, text, ms: Math.round(performance.now() - t0) });
}

self.onmessage = (e: MessageEvent<VoiceAsk>) => {
  const a = e.data;
  if (a.type === "load") void load(a).catch((x: unknown) => ((loaded = null), say({ type: "error", message: x instanceof Error ? x.message : String(x) })));
  else if (a.type === "transcribe") void transcribe(a).catch((x: unknown) => say({ type: "error", id: a.id, message: x instanceof Error ? x.message : String(x) }));
};
