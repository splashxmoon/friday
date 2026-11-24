/**
 * A proof clip as an MP4 an iPhone plays (2026-11-22: Arun's iPhone 14 Pro, on iOS 26.6.2, doesn't play the VP9 WebM at all; AVPlayer
 * plays H.264 in MP4 and can seek it). Chromium's MediaRecorder writes H.264 as a fragmented MP4: a moov with no samples in it, then
 * the video in pieces, each with its own little index (moof). Players that stream handle that; a player handed a file wants one index
 * up front saying how long it is and where every frame is. This rewrites it so: ftyp, then a moov with the whole sample table and the
 * duration, then one mdat with the frames in order ("fast start"). And an ordinary MP4 whose moov comes after its frames gets the moov
 * moved first, its chunk offsets shifted to match.
 *
 * Only the boxes a recorder's single video track uses are read; anything shaped otherwise comes back as it was, since a clip that plays
 * on fewer devices is better than none.
 */

type Box = { type: string; start: number; size: number; head: number };

const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
const u64 = (b: Uint8Array, o: number) => u32(b, o) * 2 ** 32 + u32(b, o + 4);
const s32 = (b: Uint8Array, o: number) => u32(b, o) | 0;

function boxes(b: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = [];
  for (let o = start; o + 8 <= end; ) {
    let size = u32(b, o);
    const type = String.fromCharCode(b[o + 4]!, b[o + 5]!, b[o + 6]!, b[o + 7]!);
    let head = 8;
    if (size === 1) (size = u64(b, o + 8)), (head = 16);
    else if (size === 0) size = end - o;
    if (size < head || o + size > end) break;
    out.push({ type, start: o, size, head });
    o += size;
  }
  return out;
}
const child = (b: Uint8Array, parent: Box, type: string) => boxes(b, parent.start + parent.head, parent.start + parent.size).find((x) => x.type === type);
const path = (b: Uint8Array, parent: Box, ...types: string[]): Box | undefined => types.reduce<Box | undefined>((p, t) => (p ? child(b, p, t) : undefined), parent);
const bytes = (b: Uint8Array, x: Box) => b.subarray(x.start, x.start + x.size);

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const size = 8 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer, out.byteOffset, out.byteLength);
  v.setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let o = 8;
  for (const p of parts) out.set(p, o), (o += p.length);
  return out;
}
const full = (type: string, version: number, flags: number, body: Uint8Array) => box(type, Uint8Array.from([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), body);
function words(list: number[]): Uint8Array {
  const out = new Uint8Array(list.length * 4);
  const v = new DataView(out.buffer);
  list.forEach((n, i) => v.setUint32(i * 4, n >>> 0));
  return out;
}
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, o), (o += p.length);
  return out;
};

/** A copy of a full box (mvhd, tkhd, mdhd) with its duration set, in either of its versions. */
function withDuration(b: Uint8Array, x: Box, duration: number, durationAt: { v0: number; v1: number }): Uint8Array {
  const copy = bytes(b, x).slice();
  const v = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  const version = copy[x.head]!;
  const at = x.head + 4 + (version === 1 ? durationAt.v1 : durationAt.v0);
  if (version === 1) v.setBigUint64(at, BigInt(Math.round(duration)));
  else v.setUint32(at, Math.min(0xffffffff, Math.round(duration)));
  return copy;
}

interface Sample {
  pos: number;
  size: number;
  duration: number;
  sync: boolean;
  cto: number;
}

/** Fragmented to plain: every moof's samples into one table, their bytes into one mdat after the moov. Null when it isn't one. */
function defragment(b: Uint8Array, top: Box[]): Uint8Array | null {
  const ftyp = top.find((x) => x.type === "ftyp");
  const moov = top.find((x) => x.type === "moov");
  if (!ftyp || !moov) return null;
  const traks = boxes(b, moov.start + moov.head, moov.start + moov.size).filter((x) => x.type === "trak");
  if (traks.length !== 1) return null;
  const trak = traks[0]!;
  const mvhd = child(b, moov, "mvhd");
  const tkhd = child(b, trak, "tkhd");
  const mdia = child(b, trak, "mdia");
  const mdhd = mdia && child(b, mdia, "mdhd");
  const hdlr = mdia && child(b, mdia, "hdlr");
  const minf = mdia && child(b, mdia, "minf");
  const stsd = minf && path(b, minf, "stbl", "stsd");
  if (!mvhd || !tkhd || !mdhd || !hdlr || !minf || !stsd) return null;
  const movieScale = u32(b, mvhd.start + mvhd.head + 4 + (b[mvhd.start + mvhd.head] === 1 ? 16 : 8));
  const mediaScale = u32(b, mdhd.start + mdhd.head + 4 + (b[mdhd.start + mdhd.head] === 1 ? 16 : 8));
  // The track's defaults, for a fragment that leaves a sample's duration, size or flags to them.
  const trex = path(b, moov, "mvex", "trex");
  const dflt = trex ? { duration: u32(b, trex.start + trex.head + 12), size: u32(b, trex.start + trex.head + 16), flags: u32(b, trex.start + trex.head + 20) } : { duration: 0, size: 0, flags: 0 };
  const samples: Sample[] = [];
  for (const moof of top.filter((x) => x.type === "moof")) {
    for (const traf of boxes(b, moof.start + moof.head, moof.start + moof.size).filter((x) => x.type === "traf")) {
      const tfhd = child(b, traf, "tfhd");
      if (!tfhd) return null;
      let o = tfhd.start + tfhd.head;
      const tf = u32(b, o) & 0xffffff;
      o += 8; // flags, then track id
      let base = moof.start;
      if (tf & 0x01) (base = u64(b, o)), (o += 8);
      if (tf & 0x02) o += 4;
      const d = { ...dflt };
      if (tf & 0x08) (d.duration = u32(b, o)), (o += 4);
      if (tf & 0x10) (d.size = u32(b, o)), (o += 4);
      if (tf & 0x20) (d.flags = u32(b, o)), (o += 4);
      // Where this fragment starts in time (tfdt): the last frame before it lasts until then, whatever its own duration said. A
      // recorder's fragments are cut at the moment it flushes, and the frame before the cut is given a guessed length.
      const tfdt = child(b, traf, "tfdt");
      if (tfdt && samples.length) {
        const at = b[tfdt.start + tfdt.head] === 1 ? u64(b, tfdt.start + tfdt.head + 4) : u32(b, tfdt.start + tfdt.head + 4);
        const last = samples[samples.length - 1]!;
        const lastAt = samples.reduce((n, x) => n + x.duration, 0) - last.duration;
        if (at > lastAt) last.duration = at - lastAt;
      }
      for (const trun of boxes(b, traf.start + traf.head, traf.start + traf.size).filter((x) => x.type === "trun")) {
        let p = trun.start + trun.head;
        const version = b[p]!;
        const fl = u32(b, p) & 0xffffff;
        const count = u32(b, p + 4);
        p += 8;
        let pos = base;
        if (fl & 0x01) (pos = base + s32(b, p)), (p += 4);
        let first: number | null = null;
        if (fl & 0x04) (first = u32(b, p)), (p += 4);
        for (let i = 0; i < count; i++) {
          const duration = fl & 0x100 ? u32(b, (p += 4) - 4) : d.duration;
          const size = fl & 0x200 ? u32(b, (p += 4) - 4) : d.size;
          let flags = fl & 0x400 ? u32(b, (p += 4) - 4) : d.flags;
          if (i === 0 && first !== null) flags = first;
          const cto = fl & 0x800 ? (version === 1 ? s32(b, (p += 4) - 4) : u32(b, (p += 4) - 4)) : 0;
          if (pos + size > b.length) return null;
          samples.push({ pos, size, duration, sync: ((flags >> 16) & 1) === 0, cto });
          pos += size;
        }
      }
    }
  }
  if (!samples.length) return null;
  const mediaDur = samples.reduce((n, s) => n + s.duration, 0);
  const movieDur = (mediaDur * movieScale) / mediaScale;
  // The sample table: durations run-length coded, the frames a player may start from, one chunk holding them all.
  const stts: number[] = [];
  for (const s of samples) {
    if (stts.length && stts[stts.length - 1] === s.duration) stts[stts.length - 2]!++;
    else stts.push(1, s.duration);
  }
  const syncs = samples.flatMap((s, i) => (s.sync ? [i + 1] : []));
  const ctts: number[] = [];
  if (samples.some((s) => s.cto)) for (const s of samples) ctts.length && ctts[ctts.length - 1] === s.cto ? ctts[ctts.length - 2]!++ : ctts.push(1, s.cto);
  const stbl = (offset: number) =>
    box(
      "stbl",
      bytes(b, stsd),
      full("stts", 0, 0, words([stts.length / 2, ...stts])),
      ...(ctts.length ? [full("ctts", 0, 0, words([ctts.length / 2, ...ctts]))] : []),
      ...(syncs.length < samples.length ? [full("stss", 0, 0, words([syncs.length, ...syncs]))] : []),
      full("stsc", 0, 0, words([1, 1, samples.length, 1])),
      full("stsz", 0, 0, words([0, samples.length, ...samples.map((s) => s.size)])),
      full("stco", 0, 0, words([1, offset])),
    );
  const minfKids = boxes(b, minf.start + minf.head, minf.start + minf.size).filter((x) => x.type !== "stbl");
  const build = (offset: number) =>
    box(
      "moov",
      withDuration(b, mvhd, movieDur, { v0: 12, v1: 20 }),
      box("trak", withDuration(b, tkhd, movieDur, { v0: 16, v1: 24 }), box("mdia", withDuration(b, mdhd, mediaDur, { v0: 12, v1: 20 }), bytes(b, hdlr), box("minf", ...minfKids.map((x) => bytes(b, x)), stbl(offset)))),
    );
  const head = bytes(b, ftyp);
  const moovLen = build(0).length;
  const dataStart = head.length + moovLen + 8;
  const data = concat(samples.map((s) => b.subarray(s.pos, s.pos + s.size)));
  if (data.length + 8 > 0xffffffff) return null;
  return concat([head, build(dataStart), box("mdat", data)]);
}

/** An ordinary MP4 with its moov last: moved before the frames, every chunk offset (stco, co64) moved by as much. */
function moovFirst(b: Uint8Array, top: Box[]): Uint8Array {
  const moov = top.find((x) => x.type === "moov")!;
  const shift = moov.size;
  const copy = bytes(b, moov).slice();
  const v = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  const walk = (start: number, end: number) => {
    for (const x of boxes(copy, start, end)) {
      if (["trak", "mdia", "minf", "stbl"].includes(x.type)) walk(x.start + x.head, x.start + x.size);
      else if (x.type === "stco" || x.type === "co64") {
        const n = v.getUint32(x.start + x.head + 4);
        for (let i = 0, o = x.start + x.head + 8; i < n; i++)
          if (x.type === "stco") v.setUint32(o + i * 4, v.getUint32(o + i * 4) + shift);
          else v.setBigUint64(o + i * 8, v.getBigUint64(o + i * 8) + BigInt(shift));
      }
    }
  };
  walk(moov.head, moov.size);
  const before = top.filter((x) => x.start < moov.start && (x.type === "ftyp" || x.type === "free" || x.type === "wide" || x.type === "skip"));
  const rest = top.filter((x) => x !== moov && !before.includes(x));
  return concat([...before.map((x) => bytes(b, x)), copy, ...rest.map((x) => bytes(b, x))]);
}

/** The MP4 laid out for playing from a file: fragments joined, the moov first. As it was when it isn't an MP4 this can read. */
export function fastStartMp4(given: Uint8Array): Uint8Array {
  // A plain copy of its own: a Node Buffer's slice shares its memory and its .buffer is a whole pool, so a box copied out of it and
  // written through a DataView would land somewhere else entirely.
  const input = new Uint8Array(given);
  try {
    const top = boxes(input, 0, input.length);
    if (!top.length || top[0]!.type !== "ftyp") return given;
    if (top.some((x) => x.type === "moof")) return defragment(input, top) ?? given;
    const moov = top.findIndex((x) => x.type === "moov");
    const mdat = top.findIndex((x) => x.type === "mdat");
    if (moov > mdat && mdat >= 0) return moovFirst(input, top);
    return given;
  } catch {
    return given;
  }
}
