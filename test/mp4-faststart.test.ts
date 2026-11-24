import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fastStartMp4 } from "../src/mp4-faststart.js";

// Proof clips as MP4s an iPhone plays (2026-11-22: Arun's iPhone 14 Pro doesn't play the VP9 WebM): a fragmented MP4, as Chromium's
// MediaRecorder writes H.264, joined into one with its index first and its duration; and an ordinary one with its moov last, moved first.
// The inputs are made with ffmpeg and libx264, so these run where they are installed.

const has = (() => {
  try {
    return execFileSync("ffmpeg", ["-hide_banner", "-encoders"]).toString().includes("libx264");
  } catch {
    return false;
  }
})();
const skip = !has && "ffmpeg with libx264 isn't installed";
const dir = has ? mkdtempSync(path.join(os.tmpdir(), "friday-mp4-")) : "";
const make = (name: string, flags: string[]) => {
  const f = path.join(dir, name);
  // 3 seconds at 15 frames a second, keyframes every second, as a recorder's would be.
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x200:rate=15:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "baseline", "-g", "15", ...flags, f]);
  return readFileSync(f);
};
const probe = (b: Uint8Array) => {
  const f = path.join(dir, `p-${Math.random().toString(36).slice(2)}.mp4`);
  writeFileSync(f, b);
  const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_name,nb_frames,nb_read_frames,duration", "-of", "json", f]).toString()) as { streams: { codec_name: string; nb_frames: string; nb_read_frames: string; duration: string }[] };
  execFileSync("ffmpeg", ["-v", "error", "-xerror", "-i", f, "-f", "null", "-"]);
  const s = j.streams[0]!;
  return { codec: s.codec_name, frames: Number(s.nb_read_frames), indexed: Number(s.nb_frames), seconds: Number(s.duration) };
};
const boxOrder = (b: Uint8Array) => {
  const out: string[] = [];
  for (let o = 0; o + 8 <= b.length; ) {
    const size = (b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!;
    out.push(String.fromCharCode(...b.subarray(o + 4, o + 8)));
    if (size < 8) break;
    o += size;
  }
  return out;
};

test("a fragmented MP4 becomes one with its index first: every frame, the same timing, a duration a player reads", { skip }, () => {
  const frag = make("frag.mp4", ["-movflags", "frag_keyframe+empty_moov+default_base_moof"]);
  assert.ok(boxOrder(frag).includes("moof"), "the input is in fragments");
  const out = fastStartMp4(frag);
  assert.deepEqual(boxOrder(out), ["ftyp", "moov", "mdat"]);
  const p = probe(out);
  assert.equal(p.codec, "h264");
  assert.equal(p.frames, 45);
  assert.equal(p.indexed, 45, "every frame in the moov's own table");
  assert.ok(Math.abs(p.seconds - 3) < 0.1, `${p.seconds}s`);
});

test("an MP4 with its moov last gets it moved first, its chunk offsets moved with it", { skip }, () => {
  const late = make("late.mp4", []);
  assert.deepEqual(boxOrder(late).filter((t) => t === "moov" || t === "mdat"), ["mdat", "moov"], "ffmpeg writes the moov last unless asked");
  const out = fastStartMp4(late);
  assert.deepEqual(boxOrder(out).filter((t) => t === "moov" || t === "mdat"), ["moov", "mdat"]);
  const p = probe(out);
  assert.equal(p.frames, 45, "every frame still found where the moov says");
  assert.equal(out.length, late.length);
});

test("a Node Buffer is read as well as a plain array, and what isn't an MP4 comes back as it was", { skip }, () => {
  const frag = make("frag2.mp4", ["-movflags", "frag_keyframe+empty_moov+default_base_moof"]);
  // A Buffer from a pool, offset into it, as Buffer.from(base64) gives: its boxes must still be patched in the right place.
  const pooled = Buffer.concat([Buffer.alloc(17), frag]).subarray(17);
  assert.ok(Math.abs(probe(fastStartMp4(pooled)).seconds - 3) < 0.1);
  const junk = Buffer.from("not an mp4 at all");
  assert.equal(fastStartMp4(junk), junk);
  const fast = make("fast.mp4", ["-movflags", "+faststart"]);
  assert.equal(fastStartMp4(fast), fast, "already laid out: the same bytes");
});

test.after(() => dir && rmSync(dir, { recursive: true, force: true }));
