// Voice input (Arun, 2026-11-09: design A): where the words go in the box, when they are sent, when a recording stops by itself,
// which key talks on which computer, the model's download and serving, and a recording made into words on a server of your own.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { autoSends, cleanText, cutOff, insertAt, joinParts, MOST_MS, promptFor, QUIET_MS, quietestCut, wav, wordCount } from "../src/client/voice-text.js";
import { isTalkKey, isTalkRelease, platformOf, talkLabel } from "../src/client/voice-keys.js";
import { VOICE, VOICE_HOSTS, VoiceModels, type VoiceFile, type VoiceSpec } from "../src/voice-models.js";
import { voiceHttp } from "../src/voice-server.js";

test("voice: the words go in at the caret, spaced from what is on either side, and the caret goes after them", () => {
  assert.deepEqual(insertAt("", 0, 0, " Now add a test. "), { value: "Now add a test.", caret: 15 }, "an empty box: the words, trimmed");
  assert.deepEqual(insertAt("Please", 6, 6, "add a test"), { value: "Please add a test", caret: 17 }, "after a word: one space before");
  assert.deepEqual(insertAt("Fix this. Thanks", 9, 9, "Now add a test."), { value: "Fix this. Now add a test. Thanks", caret: 25 }, "mid-sentence: a space each side");
  assert.deepEqual(insertAt("Fix this. ", 10, 10, "Then commit"), { value: "Fix this. Then commit", caret: 21 }, "after a space: none added");
  assert.deepEqual(insertAt("Fix ,then", 4, 4, "this"), { value: "Fix this,then", caret: 8 }, "before a comma: none after");
  assert.deepEqual(insertAt("line one\n", 9, 9, "line two"), { value: "line one\nline two", caret: 17 }, "a new line needs no space");
  assert.deepEqual(insertAt("rename foo to bar", 7, 10, "the hook"), { value: "rename the hook to bar", caret: 15 }, "over what is selected");
  assert.deepEqual(insertAt("abc", 99, 99, "x"), { value: "abc x", caret: 5 }, "a caret past the end is the end");
  assert.deepEqual(insertAt("same", 2, 2, "   "), { value: "same", caret: 2 }, "nothing heard: the box as it was");
});

test("voice: Send when you stop sends three words or more, only when it's on", () => {
  assert.equal(wordCount("Run the tests."), 3);
  assert.equal(wordCount(" , . "), 0, "marks alone are no words");
  assert.equal(autoSends("Run the tests.", true), true);
  assert.equal(autoSends("Run tests", true), false, "two words wait in the box");
  assert.equal(autoSends("Run the tests and fix what fails", false), false, "off: never");
});

test("voice: a recording stops after 15 seconds of quiet, and at 2 minutes in all", () => {
  assert.equal(QUIET_MS, 15_000);
  assert.equal(MOST_MS, 120_000);
  assert.equal(cutOff({ elapsedMs: 60_000, quietMs: 14_900 }), null);
  assert.equal(cutOff({ elapsedMs: 60_000, quietMs: 15_000 }), "quiet");
  assert.equal(cutOff({ elapsedMs: 119_900, quietMs: 0 }), null);
  assert.equal(cutOff({ elapsedMs: 120_000, quietMs: 0 }), "long");
  assert.equal(cutOff({ elapsedMs: 120_000, quietMs: 20_000 }), "long", "2 minutes says so, whatever the quiet");
});

test("voice: ⌥ Space talks on a Mac, Ctrl+Shift+Space on Windows and Linux, where Alt+Space opens the window menu", () => {
  const k = (o: Partial<KeyboardEvent>) => ({ code: "Space", key: " ", altKey: false, ctrlKey: false, shiftKey: false, metaKey: false, ...o });
  assert.equal(platformOf("MacIntel"), "mac");
  assert.equal(platformOf("Win32"), "other");
  assert.equal(platformOf("Linux x86_64"), "other");
  // On a Mac ⌥ Space gives a no-break space as its key: still the shortcut.
  assert.ok(isTalkKey(k({ altKey: true, key: " " }), "mac"));
  assert.ok(!isTalkKey(k({ altKey: true, metaKey: true }), "mac"), "⌘⌥ Space is somebody else's");
  assert.ok(!isTalkKey(k({ ctrlKey: true, shiftKey: true }), "mac"));
  assert.ok(isTalkKey(k({ ctrlKey: true, shiftKey: true }), "other"));
  assert.ok(!isTalkKey(k({ altKey: true }), "other"), "Alt+Space is the window menu's on Windows");
  assert.ok(!isTalkKey(k({ ctrlKey: true }), "other"));
  assert.ok(!isTalkKey(k({ code: "KeyA", key: "a", altKey: true }), "mac"));
  // Held: letting go of Space or a key held with it ends it.
  assert.ok(isTalkRelease({ code: "Space", key: " " }, "mac"));
  assert.ok(isTalkRelease({ code: "AltLeft", key: "Alt" }, "mac"));
  assert.ok(!isTalkRelease({ code: "ShiftLeft", key: "Shift" }, "mac"));
  assert.ok(isTalkRelease({ code: "ControlLeft", key: "Control" }, "other"));
  assert.ok(isTalkRelease({ code: "ShiftLeft", key: "Shift" }, "other"));
  assert.equal(talkLabel("mac"), "⌥ Space");
  assert.equal(talkLabel("other"), "Ctrl+Shift+Space");
});

test("voice: what Whisper writes is cleaned for the box, and told the session's words first", () => {
  assert.equal(cleanText(" [BLANK_AUDIO] "), "");
  assert.equal(cleanText(" Thank you."), "", "made up from silence");
  assert.equal(cleanText(" Run the tests (music) now."), "Run the tests now.");
  assert.equal(joinParts([" first part. ", "", "second part."]), "first part. second part.");
  assert.equal(promptFor({ repo: "friday", branch: "voice-input", text: "Fix the useEffect in price.ts" }), "Repo friday, branch voice-input. Fix the useEffect in price.ts");
  assert.equal(promptFor({}), "");
  // A long recording is cut at its quietest tenth of a second within the window.
  const levels = [5, 5, 1, 5, 5];
  assert.equal(quietestCut(0, 8000, (i) => levels[Math.floor(i / 1600)]!), 1600 * 2 + 800);
  // The WAV a server of your own is sent: 16-bit mono at 16 kHz.
  const w = wav(new Float32Array([0, 1, -1, 0.5]));
  const v = new DataView(w.buffer);
  assert.equal(Buffer.from(w.subarray(0, 4)).toString(), "RIFF");
  assert.equal(Buffer.from(w.subarray(8, 12)).toString(), "WAVE");
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(w.length, 44 + 8);
  assert.deepEqual([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true)], [0, 32767, -32767]);
});

/** An http server answering with `handle`, closed after the test. */
async function serve(t: { after(f: () => unknown): void }, handle: http.RequestListener): Promise<string> {
  const s = http.createServer(handle);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => s.close(() => r())));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

test("voice: the model and its engine are downloaded once, pinned and checked, kept in models/, and served only from there", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-voice-models-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // A small model and engine of the real one's shape: the model from one host, transformers.js and its runtime from another.
  const body: Record<string, Buffer> = {
    "m/whisper-test/resolve/rev/config.json": Buffer.from('{"model_type":"whisper"}'),
    "m/whisper-test/resolve/rev/onnx/encoder_model_quantized.onnx": Buffer.alloc(300_000, 7),
    "@huggingface/transformers@9.9.9/dist/transformers.min.js": Buffer.from("export const env = {};"),
    "onnxruntime-web@1.0.0/dist/ort-wasm-simd-threaded.asyncify.wasm": Buffer.alloc(200_000, 3),
  };
  const file = (served: string, disk: string, from: VoiceFile["from"], src: string): VoiceFile => ({ served, disk, from, src, bytes: body[src]!.length, sha256: sha(body[src]!) });
  const spec: VoiceSpec = {
    model: "m/whisper-test",
    dtype: "q8",
    paths: { models: "/voice/models/", engine: "/voice/engine/transformers.min.js", ort: "/voice/ort/" },
    files: [
      file("/voice/models/m/whisper-test/config.json", "m/whisper-test/config.json", "model", "m/whisper-test/resolve/rev/config.json"),
      file("/voice/models/m/whisper-test/onnx/encoder_model_quantized.onnx", "m/whisper-test/onnx/encoder_model_quantized.onnx", "model", "m/whisper-test/resolve/rev/onnx/encoder_model_quantized.onnx"),
      file("/voice/engine/transformers.min.js", "engine/transformers-9.9.9/transformers.min.js", "engine", "@huggingface/transformers@9.9.9/dist/transformers.min.js"),
      file("/voice/ort/ort-wasm-simd-threaded.asyncify.wasm", "engine/onnxruntime-web-1.0.0/ort-wasm-simd-threaded.asyncify.wasm", "engine", "onnxruntime-web@1.0.0/dist/ort-wasm-simd-threaded.asyncify.wasm"),
    ],
  };
  // Stand-ins for Hugging Face and jsDelivr, which count what they are asked for and can be told to send a wrong file.
  const asked: string[] = [];
  let corrupt = "";
  const host = (prefix: string) =>
    serve(t, (req, res) => {
      const src = decodeURIComponent(req.url!.slice(1));
      asked.push(`${prefix} ${src}`);
      const b = body[src];
      if (!b) return void (res.writeHead(404), res.end());
      res.writeHead(200, { "Content-Length": b.length });
      res.end(corrupt && src.endsWith(corrupt) ? Buffer.alloc(b.length, 9) : b);
    });
  const hosts = { model: await host("hf"), engine: await host("npm") };
  const models = new VoiceModels({ dir, hosts, spec });
  // Friday's routes for it, as app.ts mounts them.
  const app = await serve(t, (req, res) => void voiceHttp(models, req, res, new URL(req.url!, "http://x")).then((done) => done || (res.writeHead(404), res.end())));
  type Status = { ready: boolean; bytes: number; got?: number; error?: string; paths: VoiceSpec["paths"] };
  const status = async () => (await (await fetch(`${app}/api/voice/model`)).json()) as Status;

  let s = await status();
  assert.equal(s.ready, false);
  assert.equal(s.bytes, Object.values(body).reduce((n, b) => n + b.length, 0), "the model and the engine together, for the download prompt");
  assert.deepEqual(s.paths, spec.paths, "where the worker finds each part");
  assert.equal(asked.length, 0, "nothing is fetched until the person says yes");
  assert.equal((await fetch(`${app}/voice/engine/transformers.min.js`)).status, 404, "nothing is served before it is here");

  // An engine file that doesn't match its hash isn't kept, and says where it came from.
  corrupt = ".wasm";
  await models.download();
  s = await status();
  assert.equal(s.ready, false);
  assert.match(s.error ?? "", /from jsDelivr didn't arrive as it should/);
  await assert.rejects(readFile(path.join(dir, "engine/onnxruntime-web-1.0.0/ort-wasm-simd-threaded.asyncify.wasm")));
  assert.equal((await fetch(`${app}/voice/ort/ort-wasm-simd-threaded.asyncify.wasm`)).status, 404);

  // A wrong model file is refused too.
  corrupt = ".onnx";
  await rm(path.join(dir, "m"), { recursive: true, force: true });
  await models.download();
  assert.match((await status()).error ?? "", /from Hugging Face didn't arrive as it should/);

  // Yes, from the box: the download runs on the server, each file from its own host by its pinned address.
  corrupt = "";
  asked.length = 0;
  assert.equal(((await (await fetch(`${app}/api/voice/model`, { method: "POST" })).json()) as Status).ready, false);
  await models.download();
  assert.deepEqual(asked, ["hf m/whisper-test/resolve/rev/onnx/encoder_model_quantized.onnx", "npm onnxruntime-web@1.0.0/dist/ort-wasm-simd-threaded.asyncify.wasm"], "only what wasn't whole already: what arrived whole before is kept");
  s = await status();
  assert.equal(s.ready, true);
  assert.equal(s.got, undefined);

  // Served from the folder, to the page, whatever port Friday is on: a new server on the same folder has it all, with no download.
  const again = new VoiceModels({ dir, hosts: { model: "http://127.0.0.1:9", engine: "http://127.0.0.1:9" }, spec });
  assert.equal(await again.ready(), true);
  const types: Record<string, string> = {
    "/voice/models/m/whisper-test/config.json": "application/json",
    "/voice/models/m/whisper-test/onnx/encoder_model_quantized.onnx": "application/octet-stream",
    "/voice/engine/transformers.min.js": "text/javascript; charset=utf-8",
    "/voice/ort/ort-wasm-simd-threaded.asyncify.wasm": "application/wasm",
  };
  for (const f of spec.files) {
    const r = await fetch(`${app}${f.served}`);
    assert.equal(r.status, 200, f.served);
    assert.equal(r.headers.get("content-type"), types[f.served], f.served);
    assert.equal(Buffer.from(await r.arrayBuffer()).equals(body[f.src]!), true, f.served);
  }
  // Only voice's own files: nothing else in the folder, nothing outside it.
  await writeFile(path.join(dir, "secret.txt"), "no");
  for (const p of ["/voice/models/secret.txt", "/voice/models/m/whisper-test/../../secret.txt", "/voice/models/m/whisper-test/%2e%2e/%2e%2e/secret.txt", "/voice/ort/ort.webgpu.min.mjs", "/voice/engine/m/whisper-test/config.json"]) assert.equal((await fetch(`${app}${p}`)).status, 404, p);
  assert.equal((await fetch(`${app}/voice/engine/transformers.min.js`, { method: "POST" })).status, 405);
});

test("voice: the real model and engine are pinned, hashed, from Hugging Face and jsDelivr, and 107 MB in all", () => {
  assert.ok(VOICE.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256) && f.bytes > 0));
  assert.ok(VOICE.files.filter((f) => f.from === "model").every((f) => /\/resolve\/[0-9a-f]{40}\//.test(f.src)), "the model at one revision");
  assert.ok(VOICE.files.filter((f) => f.from === "engine").every((f) => /@\d+\.\d+\.\d+[\w.-]*\/dist\//.test(f.src)), "the engine at exact versions");
  assert.deepEqual(VOICE.files.filter((f) => f.from === "engine").map((f) => f.served), ["/voice/engine/transformers.min.js", "/voice/ort/ort-wasm-simd-threaded.asyncify.mjs", "/voice/ort/ort-wasm-simd-threaded.asyncify.wasm"]);
  assert.deepEqual(VOICE_HOSTS, { model: "https://huggingface.co", engine: "https://cdn.jsdelivr.net/npm" });
  assert.equal(Math.round(VOICE.files.reduce((n, f) => n + f.bytes, 0) / 1e6), 107);
});

test("voice: with your own key, the server sends the recording to that server's /audio/transcriptions with its key, which never reaches the page", async (t) => {
  // runner/own-models.ts keeps them in ~/.friday/models.json: this test's, never the real one (USERPROFILE for Windows).
  const home = await mkdtemp(path.join(tmpdir(), "friday-voice-key-"));
  const real = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, { HOME: home, USERPROFILE: home });
  t.after(async () => {
    for (const [k, v] of Object.entries(real)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
    await rm(home, { recursive: true, force: true });
  });
  const KEY = "sk-voice-test-0123456789";
  // A stand-in OpenAI-compatible server: it checks the key, reads the form, and says what it heard.
  const heard: { model: string; language: string; prompt: string; bytes: number; riff: string }[] = [];
  const speech = await serve(t, async (req, res) => {
    const send = (status: number, body: unknown) => (res.writeHead(status, { "Content-Type": "application/json" }), res.end(JSON.stringify(body)));
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: { message: `Incorrect API key provided: ${String(req.headers.authorization).slice(7)}` } });
    if (req.url !== "/v1/audio/transcriptions" || req.method !== "POST") return send(404, { error: { message: "Not found" } });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const form = await new Request("http://x/", { method: "POST", headers: { "content-type": String(req.headers["content-type"]) }, body: Buffer.concat(chunks) }).formData();
    const file = Buffer.from(await (form.get("file") as Blob).arrayBuffer());
    heard.push({ model: String(form.get("model")), language: String(form.get("language")), prompt: String(form.get("prompt")), bytes: file.length, riff: file.subarray(0, 4).toString() });
    send(200, { text: " Run the tests and fix what fails. " });
  });
  const { saveOwnModel } = await import("../src/runner/own-models.js");
  const { model } = await saveOwnModel({ provider: "openai", baseUrl: `${speech}/v1`, model: "gpt-chat", apiKey: KEY });
  const models = new VoiceModels({ dir: path.join(home, "models") });
  const app = await serve(t, (req, res) => void voiceHttp(models, req, res, new URL(req.url!, "http://x")).then((done) => done || (res.writeHead(404), res.end())));
  const audio = wav(new Float32Array(16000));
  const ask = (headers: Record<string, string>) => fetch(`${app}/api/voice/transcribe`, { method: "POST", headers: { "Content-Type": "audio/wav", "x-voice-own": model.id, "x-voice-model": "whisper-1", "x-voice-language": "en", "x-voice-prompt": encodeURIComponent("Repo friday, branch voice-input."), ...headers }, body: audio as BodyInit });

  const r = await ask({});
  const said = await r.text();
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(said), { text: "Run the tests and fix what fails." });
  assert.deepEqual(heard, [{ model: "whisper-1", language: "en", prompt: "Repo friday, branch voice-input.", bytes: audio.length, riff: "RIFF" }]);
  assert.ok(!said.includes(KEY));

  // A key the server refuses: said in Friday's words, the key never echoed back to the page.
  const json = JSON.parse(await readFile(path.join(home, ".friday", "models.json"), "utf8")) as { models: { apiKey: string }[] };
  json.models[0]!.apiKey = "sk-wrong-key-98765";
  await writeFile(path.join(home, ".friday", "models.json"), JSON.stringify(json));
  const bad = await ask({});
  const why = await bad.text();
  assert.equal(bad.status, 502);
  assert.match(why, /didn't accept the key/);
  assert.ok(!why.includes("sk-wrong-key-98765"), "the key the server said back is taken out");

  // A saved model that isn't there, and an empty recording.
  assert.match(await (await ask({ "x-voice-own": "nope1234" })).text(), /isn't set up on this computer/);
  assert.equal((await fetch(`${app}/api/voice/transcribe`, { method: "POST", headers: { "Content-Type": "audio/wav" } })).status, 400);
});
