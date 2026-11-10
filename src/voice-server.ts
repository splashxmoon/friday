import type http from "node:http";
import { ownTranscribe } from "./runner/own-models.js";
import { sendFile, type VoiceModels } from "./voice-models.js";

/**
 * Voice input's routes (client/voice.ts), in the open-source edition only, from this computer's own page only (app.ts localOnly):
 *
 *   GET  /api/voice/model         whether the model is here, its size, and how much of a download has arrived
 *   POST /api/voice/model         download it and its engine, once the person said yes in the box (voice-models.ts)
 *   GET  /voice/models/<id>/<f>   the model's files, from `<FRIDAY_HOME>/models`
 *   GET  /voice/engine/<f>        the engine (transformers.js), downloaded with the model and kept beside it
 *   GET  /voice/ort/<f>           the engine's runtime: its script and .wasm, the same
 *   POST /api/voice/transcribe    "With your own key": the recording, made into words on a server saved in Your models
 *
 * Returns whether it answered.
 */
export async function voiceHttp(models: VoiceModels, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname;
  const read = req.method === "GET" || req.method === "HEAD";
  if (p === "/api/voice/model") {
    if (req.method === "POST") void models.download();
    else if (!read) return reply(res, 405, { error: "Method not allowed." });
    return reply(res, 200, await models.status());
  }
  if (p.startsWith("/voice/")) {
    // Only voice's own files, by the paths it serves them at: nothing else in the folder, nothing outside it.
    const f = read ? await models.file(p) : null;
    if (!f) return reply(res, read ? 404 : 405, { error: read ? "Not found" : "Method not allowed." });
    sendFile(req, res, f.path, f.bytes, f.type);
    return true;
  }
  if (p === "/api/voice/transcribe") {
    if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed." });
    const h = (k: string) => {
      const v = req.headers[k];
      return typeof v === "string" ? v : "";
    };
    let audio: Buffer;
    try {
      // Two minutes at 16 kHz is under 4 MB as a WAV.
      audio = await readAll(req, 12 * 1024 * 1024);
    } catch {
      return reply(res, 413, { error: "That recording is too long to send." });
    }
    if (!audio.length) return reply(res, 400, { error: "Nothing was recorded." });
    try {
      const said = await ownTranscribe({
        id: h("x-voice-own").slice(0, 20),
        model: h("x-voice-model").slice(0, 200),
        audio,
        type: h("content-type").split(";")[0]!.trim() || "audio/wav",
        language: h("x-voice-language").slice(0, 3),
        prompt: safeDecode(h("x-voice-prompt")).slice(0, 2000),
      });
      return reply(res, 200, said);
    } catch (e) {
      return reply(res, 502, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  return false;
}

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return "";
  }
};

function reply(res: http.ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
  return true;
}

async function readAll(req: http.IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) {
      req.destroy();
      throw new Error("too large");
    }
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}
