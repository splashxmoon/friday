import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Voice input on this computer (client/voice.ts, client/voice-worker.ts; Arun, 2026-11-09: design A): the speech model and the
 * engine that runs it, downloaded together, once.
 *
 * The model is Whisper base, quantized to 8 bits: measured on an M-series Mac in Chrome against tiny and small, it got coding talk
 * right where tiny misheard it ("pull request" as "full request", "useEffect hook" as "user-effect token"), in about 2.5 seconds
 * for a short sentence where small took 8, at 80 MB where small is 250. The engine is transformers.js (its self-contained browser
 * build) and the onnxruntime-web WebAssembly that build was made against: not one of Friday's dependencies, which would put its
 * ~590 MB of packages (a native runtime and an image library the page never uses among them) on every install.
 *
 * Downloaded by this server into the Friday home's `models/` folder, only after the person said yes in the box: the model from
 * Hugging Face, the engine from jsDelivr's mirror of the npm registry. Those are the only calls voice makes beyond this computer;
 * the audio never leaves it. Each file is pinned (a model revision, a package version) and checked against its SHA-256 before it
 * is put in place, then served to the page from there, so it survives a change of port and works offline.
 */
const MODEL = "onnx-community/whisper-base";
const MODEL_REVISION = "27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c";
const TRANSFORMERS = "4.3.2";
/** The onnxruntime-web that transformers.js 4.3.2's browser build bundles: its WebAssembly has to be this very build. */
const ORT = "1.31.0-dev.20260914-8d85527a0";

export interface VoiceFile {
  /** Where the page asks for it (voice-server.ts). */
  served: string;
  /** Where it is kept under `models/`. */
  disk: string;
  /** Who it comes from, and its address after that host. */
  from: "model" | "engine";
  src: string;
  bytes: number;
  sha256: string;
}
export interface VoiceSpec {
  /** The model, as transformers.js names it, under `paths.models`. */
  model: string;
  /** The weights' precision, as transformers.js names it: the same files on the graphics card and on the processor. */
  dtype: string;
  /** What the worker is told: where the model's folder, the engine's script and the runtime's files are served. */
  paths: { models: string; engine: string; ort: string };
  files: readonly VoiceFile[];
}

const modelFile = (p: string, bytes: number, sha256: string): VoiceFile => ({ served: `/voice/models/${MODEL}/${p}`, disk: `${MODEL}/${p}`, from: "model", src: `${MODEL}/resolve/${MODEL_REVISION}/${p}`, bytes, sha256 });
const engineFile = (pkg: string, version: string, name: string, served: string, bytes: number, sha256: string): VoiceFile => ({ served, disk: `engine/${pkg.replace(/^@[^/]+\//, "")}-${version}/${name}`, from: "engine", src: `${pkg}@${version}/dist/${name}`, bytes, sha256 });

export const VOICE: VoiceSpec = {
  model: MODEL,
  dtype: "q8",
  paths: { models: "/voice/models/", engine: "/voice/engine/transformers.min.js", ort: "/voice/ort/" },
  files: [
    modelFile("config.json", 2243, "f4d0608f7d918166da7edb3e188de5ef1bfe70d9802e785d271fd88111e9cf4b"),
    modelFile("generation_config.json", 3832, "61070cf8de25b1e9256e8e102ded49d8d24a8369ed36ef84fdf21549e68125a0"),
    modelFile("preprocessor_config.json", 339, "a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d"),
    modelFile("tokenizer.json", 2480466, "27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566"),
    modelFile("tokenizer_config.json", 282682, "2e036e4dbacfdeb7242c7d4ec4149f4a16e86026048f94d1637e3a8ee9c6a573"),
    modelFile("onnx/encoder_model_quantized.onnx", 23201314, "5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46"),
    modelFile("onnx/decoder_model_merged_quantized.onnx", 53693315, "fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b"),
    engineFile("@huggingface/transformers", TRANSFORMERS, "transformers.min.js", "/voice/engine/transformers.min.js", 587917, "8b5a3171f8876bab2b1820a7d65eb87628e3d30bb5ea85b9dd398e76eb34decb"),
    engineFile("onnxruntime-web", ORT, "ort-wasm-simd-threaded.asyncify.mjs", "/voice/ort/ort-wasm-simd-threaded.asyncify.mjs", 53057, "0966b6105cd936744498aa60df7a22cbd47af3374dbc64a9ab561c08a71e3611"),
    engineFile("onnxruntime-web", ORT, "ort-wasm-simd-threaded.asyncify.wasm", "/voice/ort/ort-wasm-simd-threaded.asyncify.wasm", 26861777, "49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082"),
  ],
};

/** Where each part comes from, unless a test (or FRIDAY_VOICE_*_HOST) says otherwise. */
export const VOICE_HOSTS = { model: "https://huggingface.co", engine: "https://cdn.jsdelivr.net/npm" } as const;
const WHO = { model: "Hugging Face", engine: "jsDelivr" } as const;

export interface VoiceModelStatus {
  model: string;
  dtype: string;
  paths: VoiceSpec["paths"];
  /** All of it, model and engine, in bytes: what the download prompt says. */
  bytes: number;
  /** On this computer, every file whole. */
  ready: boolean;
  /** Downloading now: how much of it has arrived. */
  got?: number;
  error?: string;
}

const TYPES: Record<string, string> = { ".json": "application/json", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".wasm": "application/wasm" };

/** Voice's folder under `models/`, and its files there: only the files the spec names are ever written or served. */
export class VoiceModels {
  private got = 0;
  private running: Promise<void> | null = null;
  private error = "";
  private whole: boolean | null = null;
  constructor(
    private o: {
      /** `<FRIDAY_HOME>/models`. */
      dir: string;
      /** Where the files come from: Hugging Face and jsDelivr, or stand-ins in tests. */
      hosts?: Partial<Record<VoiceFile["from"], string>>;
      spec?: VoiceSpec;
      fetch?: typeof fetch;
    },
  ) {}
  get spec(): VoiceSpec {
    return this.o.spec ?? VOICE;
  }
  private at = (f: VoiceFile) => path.join(this.o.dir, ...f.disk.split("/"));
  private isWhole = (f: VoiceFile) => stat(this.at(f)).then((s) => s.size === f.bytes, () => false);

  /** Whether every file is there at its size (its hash was checked when it was put there). Read from disk once, then known. */
  async ready(): Promise<boolean> {
    this.whole ??= (await Promise.all(this.spec.files.map(this.isWhole))).every(Boolean);
    return this.whole;
  }

  async status(): Promise<VoiceModelStatus> {
    return {
      model: this.spec.model,
      dtype: this.spec.dtype,
      paths: this.spec.paths,
      bytes: this.spec.files.reduce((n, f) => n + f.bytes, 0),
      ready: await this.ready(),
      ...(this.running ? { got: this.got } : {}),
      ...(this.error && !this.running ? { error: this.error } : {}),
    };
  }

  /** Fetches whatever isn't here yet. One download at a time: asking again while it runs joins it. */
  download(): Promise<void> {
    this.running ??= this.fetchAll().finally(() => (this.running = null));
    return this.running;
  }

  private async fetchAll(): Promise<void> {
    this.error = "";
    this.got = 0;
    const get = this.o.fetch ?? fetch;
    try {
      for (const f of this.spec.files) {
        if (await this.isWhole(f)) {
          this.got += f.bytes;
          continue;
        }
        const to = this.at(f);
        await mkdir(path.dirname(to), { recursive: true });
        const host = (this.o.hosts?.[f.from] ?? VOICE_HOSTS[f.from]).replace(/\/+$/, "");
        const r = await get(`${host}/${f.src}`, { redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) }).catch(() => {
          throw new Error(`Couldn't reach ${WHO[f.from]} to download it. Check the connection and try again.`);
        });
        if (!r.ok || !r.body) throw new Error(`The download stopped: ${WHO[f.from]} answered ${r.status}. Try again in a moment.`);
        const part = `${to}.part`;
        const hash = createHash("sha256");
        const start = this.got;
        let n = 0;
        const body = Readable.fromWeb(r.body as import("node:stream/web").ReadableStream<Uint8Array>);
        body.on("data", (c: Buffer) => {
          hash.update(c);
          n += c.length;
          this.got = start + Math.min(n, f.bytes);
        });
        try {
          await pipeline(body, createWriteStream(part));
        } catch {
          await rm(part, { force: true });
          throw new Error("The download was cut off. Try again: what arrived whole is kept.");
        }
        if (n !== f.bytes || hash.digest("hex") !== f.sha256) {
          await rm(part, { force: true });
          throw new Error(`A file from ${WHO[f.from]} didn't arrive as it should, so it wasn't kept. Try again.`);
        }
        await rename(part, to);
      }
      this.whole = true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.whole = false;
    }
  }

  /** The file on disk for a path the page asked for, when it is one of voice's own files and it is here. */
  async file(served: string): Promise<{ path: string; bytes: number; type: string } | null> {
    const f = this.spec.files.find((x) => x.served === served);
    if (!f || !(await this.isWhole(f))) return null;
    return { path: this.at(f), bytes: f.bytes, type: TYPES[path.extname(f.disk)] ?? "application/octet-stream" };
  }
}

/** A file from disk, streamed: the model's are tens of megabytes, more than a page's file should be held in memory for. */
export function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: string, bytes: number, type: string): void {
  res.writeHead(200, { "Content-Type": type, "Content-Length": String(bytes), "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
  if (req.method === "HEAD") return void res.end();
  createReadStream(file)
    .on("error", () => res.destroy())
    .pipe(res);
}
