import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gifMaker, gifSize } from "../src/gif.js";
import { gifTries } from "../src/clip-walk.js";

// Proof clips as GIFs (Arun, 2026-11-21: "add clips to PRs and the phone too also see where else we can intergrate it"): Friday's own
// encoder, checked by decoding what it writes with ffmpeg where it is installed, and by its bytes everywhere.

const W = 240, H = 150;
const page = (shift: number, noise = false) => {
  const a = new Uint8ClampedArray(W * H * 4);
  let seed = 7 + shift;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const box = x > 10 + shift * 8 && x < 70 + shift * 8 && y > 40 && y < 90;
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const n = noise ? seed & 255 : 0;
      a[i] = box ? 64 : noise ? n : 246;
      a[i + 1] = box ? 132 : noise ? (n * 7) & 255 : 245;
      a[i + 2] = box ? 255 : noise ? (n * 13) & 255 : 241;
      a[i + 3] = 255;
    }
  return a;
};
const ffprobe = (() => {
  try {
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const probe = (gif: Uint8Array) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "friday-gif-"));
  try {
    const f = path.join(dir, "t.gif");
    writeFileSync(f, gif);
    const out = execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=width,height,nb_read_frames:format=duration", "-of", "json", f]).toString();
    // A full decode: ffmpeg fails loudly on a broken LZW stream.
    execFileSync("ffmpeg", ["-v", "error", "-i", f, "-f", "null", "-"]);
    const j = JSON.parse(out) as { streams: { width: number; height: number; nb_read_frames: string }[]; format: { duration: string } };
    return { w: j.streams[0]!.width, h: j.streams[0]!.height, frames: Number(j.streams[0]!.nb_read_frames), seconds: Number(j.format.duration) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("a moving box: a GIF89a that loops, each frame only what changed, a still moment folded into the one before", () => {
  const g = gifMaker(W, H, [page(0), page(9)]);
  for (let n = 0; n < 10; n++) g.add(page(n), 12.5);
  g.add(page(9), 50);
  const gif = g.finish();
  assert.equal(Buffer.from(gif.subarray(0, 6)).toString(), "GIF89a");
  assert.ok(Buffer.from(gif).includes(Buffer.from("NETSCAPE2.0")), "it loops");
  assert.equal(gif.at(-1), 0x3b);
  assert.ok(gif.length < 20_000, `${gif.length} bytes: the page around the box isn't sent again`);
  if (ffprobe) {
    const p = probe(gif);
    assert.deepEqual([p.w, p.h, p.frames], [W, H, 10], "ten frames: the last, unchanged, only held longer");
    assert.ok(Math.abs(p.seconds - (9 * 0.13 + 0.63)) < 0.1, `${p.seconds}s`);
  }
});

test("noise that fills the LZW table many times over still decodes", { skip: !ffprobe && "ffmpeg isn't installed" }, () => {
  const g = gifMaker(W, H, [page(0, true)]);
  for (let n = 0; n < 3; n++) g.add(page(n, true), 10);
  const p = probe(g.finish());
  assert.equal(p.frames, 3);
});

test("a clip's GIF is about 800 wide, never wider than it was recorded, and gets smaller and slower to fit", () => {
  assert.deepEqual(gifSize(1280, 800), { w: 800, h: 500 });
  assert.deepEqual(gifSize(390, 844), { w: 390, h: 844 });
  assert.deepEqual(gifTries(1280, 800), [{ width: 800, height: 500, fps: 8 }, { width: 640, height: 400, fps: 6 }, { width: 480, height: 300, fps: 5 }]);
  assert.deepEqual(gifTries(390, 844)[0], { width: 390, height: 844, fps: 8 });
});
