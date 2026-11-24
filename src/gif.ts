/**
 * Animated GIFs of proof clips, with no library (Arun, 2026-11-21: "add clips to PRs and the phone too also see where else we can
 * intergrate it"). GitHub plays a video only when it was uploaded on its own site, but it shows a GIF anywhere, so a pull request's
 * description can carry the walk itself. Written here rather than vendored: a GIF is a palette, LZW and a few headers, about 150 lines.
 *
 * The encoder is plain JavaScript in a string so the same code runs where the clip is made (the recorder's page: the frames are
 * already drawn on its canvas, with the cursor and captions) and in Node for the tests. One palette for the whole clip, picked from a few
 * of its frames by how often each colour appears (with the overlay's own colours always in), so a page's greys and its accent survive.
 * Each frame after the first carries only the box that changed, with what stayed the same left transparent, which is what keeps a
 * scrolling walk of a page under a few megabytes; a frame that changed nothing just lengthens the one before it.
 */
export const GIF_JS = String.raw`function fridayGif(W, H, samples, fixed) {
  // The palette: 255 colours (the 256th is "unchanged"), the overlay's first, then the clip's commonest, spread so near-twins don't crowd out an accent.
  const counts = new Uint32Array(32768);
  for (const px of samples) for (let i = 0; i < px.length; i += 12) counts[((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3)]++;
  const order = [];
  for (let c = 0; c < 32768; c++) if (counts[c]) order.push(c);
  order.sort((a, b) => counts[b] - counts[a]);
  const pal = fixed.slice(0, 32).map((c) => [c[0], c[1], c[2]]);
  const near = (r, g, b, d) => pal.some((p) => (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2 < d);
  for (const d of [600, 150, 0]) {
    for (const c of order) {
      if (pal.length >= 255) break;
      const r = ((c >> 10) << 3) | 4, g = (((c >> 5) & 31) << 3) | 4, b = ((c & 31) << 3) | 4;
      if (!near(r, g, b, d || 1)) pal.push([r, g, b]);
    }
  }
  while (pal.length < 255) pal.push([0, 0, 0]);
  const lut = new Uint8Array(32768);
  for (let c = 0; c < 32768; c++) {
    const r = ((c >> 10) << 3) | 4, g = (((c >> 5) & 31) << 3) | 4, b = ((c & 31) << 3) | 4;
    let best = 0, bd = Infinity;
    for (let i = 0; i < 255; i++) { const p = pal[i]; const d = (p[0] - r) ** 2 * 3 + (p[1] - g) ** 2 * 4 + (p[2] - b) ** 2 * 2; if (d < bd) { bd = d; best = i; } }
    lut[c] = best;
  }
  const TRANSPARENT = 255;
  const lzw = (px, out) => {
    // GIF's LZW: 8-bit pixels, codes from 9 to 12 bits, a clear when the table fills (as omggif and giflib write it).
    const clear = 256, eoi = 257;
    let size = 9, next = 258, table = new Map(), cur = 0, bits = 0;
    const bytes = [];
    const emit = (code) => { cur |= code << bits; bits += size; while (bits >= 8) { bytes.push(cur & 255); cur >>>= 8; bits -= 8; } };
    emit(clear);
    let prefix = px[0];
    for (let i = 1; i < px.length; i++) {
      const k = px[i], key = (prefix << 8) | k, code = table.get(key);
      if (code !== undefined) { prefix = code; continue; }
      emit(prefix);
      if (next === 4096) { emit(clear); next = 258; size = 9; table = new Map(); }
      else { if (next >= 1 << size) size++; table.set(key, next++); }
      prefix = k;
    }
    emit(prefix); emit(eoi);
    if (bits > 0) bytes.push(cur & 255);
    out.push(8);
    for (let i = 0; i < bytes.length; i += 255) { const n = Math.min(255, bytes.length - i); out.push(n); for (let j = 0; j < n; j++) out.push(bytes[i + j]); }
    out.push(0);
  };
  let prev = null;
  const frames = [];
  return {
    add(rgba, delayCs) {
      const idx = new Uint8Array(W * H);
      for (let i = 0, p = 0; i < idx.length; i++, p += 4) idx[i] = lut[((rgba[p] >> 3) << 10) | ((rgba[p + 1] >> 3) << 5) | (rgba[p + 2] >> 3)];
      let x0 = 0, y0 = 0, x1 = W - 1, y1 = H - 1;
      if (prev) {
        x0 = W; y0 = H; x1 = -1; y1 = -1;
        for (let y = 0; y < H; y++) for (let x = 0, i = y * W; x < W; x++, i++) if (idx[i] !== prev[i]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        if (x1 < 0) { frames[frames.length - 1].delay += delayCs; return; }
      }
      const w = x1 - x0 + 1, h = y1 - y0 + 1, box = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y0 + y) * W + x0 + x; box[y * w + x] = prev && idx[i] === prev[i] ? TRANSPARENT : idx[i]; }
      const data = [];
      lzw(box, data);
      frames.push({ x: x0, y: y0, w, h, data: Uint8Array.from(data), delay: delayCs, see: !!prev });
      prev = idx;
    },
    size() { return frames.reduce((n, f) => n + f.data.length + 20, 800); },
    finish() {
      const head = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, W & 255, W >> 8, H & 255, H >> 8, 0xf7, 0, 0];
      for (let i = 0; i < 256; i++) { const p = pal[i] || [0, 0, 0]; head.push(p[0], p[1], p[2]); }
      // Played again and again, as a clip in a description should.
      head.push(0x21, 0xff, 0x0b, ...Array.from("NETSCAPE2.0", (c) => c.charCodeAt(0)), 0x03, 0x01, 0, 0, 0);
      const parts = [Uint8Array.from(head)];
      for (const f of frames) {
        const d = Math.max(2, Math.min(65535, Math.round(f.delay)));
        parts.push(Uint8Array.from([0x21, 0xf9, 0x04, (1 << 2) | (f.see ? 1 : 0), d & 255, d >> 8, TRANSPARENT, 0, 0x2c, f.x & 255, f.x >> 8, f.y & 255, f.y >> 8, f.w & 255, f.w >> 8, f.h & 255, f.h >> 8, 0]));
        parts.push(f.data);
      }
      parts.push(Uint8Array.from([0x3b]));
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return out;
    },
  };
}`;

/** The overlay's colours, always in the palette: the ring's blue, the caption's dark chip and its white text, the cursor, the badge's amber. */
export const GIF_FIXED: [number, number, number][] = [
  [255, 255, 255],
  [0, 0, 0],
  [17, 17, 17],
  [20, 20, 22],
  [64, 132, 255],
  [120, 168, 255],
  [245, 165, 36],
];

export interface GifMaker {
  add(rgba: Uint8Array | Uint8ClampedArray, delayCs: number): void;
  size(): number;
  finish(): Uint8Array;
}

/** The same encoder for Node: frames as RGBA, the palette from `samples`. */
export function gifMaker(width: number, height: number, samples: (Uint8Array | Uint8ClampedArray)[]): GifMaker {
  return new Function(`${GIF_JS}; return fridayGif;`)()(width, height, samples, GIF_FIXED) as GifMaker;
}

/** A GIF's size for a clip: about 800 wide (never wider than it was recorded), its height to scale. */
export function gifSize(width: number, height: number, max = 800): { w: number; h: number } {
  const w = Math.min(width, max);
  return { w: Math.round(w), h: Math.round((height * w) / width) };
}
