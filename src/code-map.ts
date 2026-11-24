import type { CodeGraph } from "./code-graph.js";

/**
 * Deep Dive's code map, worked out from the graph of which file uses which (code-graph.ts; Arun, 2026-11-22: "visualizing or making
 * a web of connections or showing how your code works for the deep dive", then "Both, a switch"): the repo's parts, the links between
 * them, and the two ways of laying them out, Flow and Web. Pure, so the page draws it and the tests check it.
 *
 * Parts are the ones Deep Dive's pages already explain: each page's own files seed a part named as the page is, and every other
 * file joins the part it is most linked to; what is linked to none is grouped by its folder. So a part reads "Session core" and
 * opens on its page, rather than "src" holding four hundred files.
 */

export interface MapPage {
  id: string;
  title: string;
  /** What a reader learns on the page: said on its part's tile. */
  purpose?: string;
  files: string[];
}
/**
 * Where a part sits in the whole, read from its links (Arun, 2026-11-23: the map was "lacking basically everything, design, logic,
 * UX"): where the code starts (nothing in the repo uses it), the middle, what it rests on (it uses nothing of the repo's), and what
 * stands apart (linked to nothing). Parts that use one another in a ring share a band, since neither comes first.
 */
export type Band = "start" | "middle" | "base" | "apart";
export const BAND_WORDS: Record<Band, string> = { start: "Starts here", middle: "In the middle", base: "Foundations", apart: "Stands apart" };
export const BAND_SAYS: Record<Band, string> = {
  start: "Nothing else in the repo uses these",
  middle: "Used from above, using what's below",
  base: "Used by the rest, using nothing of their own",
  apart: "Linked to no other part",
};
export interface Part {
  id: string;
  name: string;
  /** The Deep Dive page that explains it, when one does. */
  page?: string;
  /** That page's purpose, in a sentence. */
  purpose?: string;
  /** Named after its folder, with no page about it. */
  folder: boolean;
  band: Band;
  /** Steps from where the code starts, following what uses what (rings counted once). */
  depth: number;
  /** The ring of parts that use one another it is in (an index into `rings`), or -1. */
  ring: number;
  /** Parts it uses, and parts that use it. */
  uses: number;
  usedBy: number;
  /** Indexes into the graph's files. */
  files: number[];
  lines: number;
}
export interface PartLink {
  from: number;
  to: number;
  /** Imports from one part's files to the other's. */
  n: number;
}
export interface CodeMapModel {
  parts: Part[];
  links: PartLink[];
  /** Each file's part, by its index in the graph's files. */
  partOf: number[];
  /** Parts that use one another, directly or round a loop: two or more each, the biggest first. */
  rings: number[][];
}

/** Parts past this are hard to read on one map: the smallest folder parts are gathered into "Other files". */
export const MAX_PARTS = 32;
const folderOf = (file: string) => {
  const parts = file.split("/");
  return parts.length <= 1 ? "." : parts.length === 2 ? parts[0]! : `${parts[0]}/${parts[1]}`;
};
const BOOKENDS = new Set(["overview", "glossary"]);

export function buildMap(graph: CodeGraph, pages: readonly MapPage[] = []): CodeMapModel {
  const n = graph.files.length;
  const label = new Array<string>(n).fill("");
  const index = new Map(graph.files.map((f, i) => [f, i]));
  // Seeds: each page's own files (the overview and glossary cover everything, so seed nothing). A file two pages name goes to the
  // page about fewer files, the more particular one.
  const named = pages.filter((p) => !BOOKENDS.has(p.id) && p.files.length);
  const bySize = [...named].sort((a, b) => b.files.length - a.files.length);
  for (const p of bySize) for (const f of p.files) if (index.has(f)) label[index.get(f)!] = `p:${p.id}`;
  // Who may pull a file into their part: a file that uses it (a helper only the engine uses is the engine's), and a file in its own
  // folder it uses. Never a part it merely uses from elsewhere: a way in (cli.ts using the engine) stays where things start, or the
  // Flow view would lose its left side.
  const near: Map<number, number>[] = Array.from({ length: n }, () => new Map());
  const folder = graph.files.map(folderOf);
  for (const [a, b, k] of graph.edges) {
    near[b]!.set(a, (near[b]!.get(a) ?? 0) + k);
    if (folder[a] === folder[b]) near[a]!.set(b, (near[a]!.get(b) ?? 0) + k);
  }
  // Each file not yet in a part joins the part those files are most in, a round at a time, so parts grow out from their seeds.
  for (let round = 0; round < 8; round++) {
    const next = label.slice();
    let moved = 0;
    for (let i = 0; i < n; i++) {
      if (label[i]) continue;
      const votes = new Map<string, number>();
      for (const [j, k] of near[i]!) if (label[j]) votes.set(label[j]!, (votes.get(label[j]!) ?? 0) + k);
      let best = "";
      let most = 0;
      for (const [l, v] of votes) if (v > most || (v === most && l < best)) (best = l), (most = v);
      if (best) (next[i] = best), moved++;
    }
    label.splice(0, n, ...next);
    if (!moved) break;
  }
  for (let i = 0; i < n; i++) if (!label[i]) label[i] = `f:${folderOf(graph.files[i]!)}`;
  // The parts, biggest first; past MAX_PARTS the smallest folder parts become "Other files".
  const groups = new Map<string, number[]>();
  for (let i = 0; i < n; i++) (groups.get(label[i]!) ?? groups.set(label[i]!, []).get(label[i]!)!).push(i);
  const sizeOf = (fs: number[]) => fs.reduce((s, i) => s + (graph.lines[i] ?? 0), 0) || fs.length;
  let entries = [...groups].sort((a, b) => sizeOf(b[1]) - sizeOf(a[1]));
  if (entries.length > MAX_PARTS) {
    const keep = entries.filter(([l]) => l.startsWith("p:"));
    const folders = entries.filter(([l]) => l.startsWith("f:"));
    const room = Math.max(0, MAX_PARTS - 1 - keep.length);
    const other = folders.slice(room).flatMap(([, fs]) => fs);
    entries = [...keep, ...folders.slice(0, room), ...(other.length ? [["o:other", other] as [string, number[]]] : [])].sort((a, b) => sizeOf(b[1]) - sizeOf(a[1]));
  }
  const pageById = new Map(pages.map((p) => [p.id, p]));
  const parts: Part[] = entries.map(([l, fs]) => {
    const page = l.startsWith("p:") ? pageById.get(l.slice(2)) : undefined;
    return {
      id: l,
      name: page ? page.title : l === "o:other" ? "Other files" : l.slice(2) === "." ? "Top level" : l.slice(2),
      ...(page ? { page: page.id } : {}),
      ...(page?.purpose ? { purpose: page.purpose } : {}),
      folder: !page && l !== "o:other",
      files: fs,
      lines: fs.reduce((s, i) => s + (graph.lines[i] ?? 0), 0),
      band: "apart" as Band,
      depth: 0,
      ring: -1,
      uses: 0,
      usedBy: 0,
    };
  });
  const partOf = new Array<number>(n).fill(-1);
  parts.forEach((p, pi) => p.files.forEach((i) => (partOf[i] = pi)));
  const linkN = new Map<string, number>();
  for (const [a, b, k] of graph.edges) {
    const pa = partOf[a]!, pb = partOf[b]!;
    if (pa < 0 || pb < 0 || pa === pb) continue;
    linkN.set(`${pa}>${pb}`, (linkN.get(`${pa}>${pb}`) ?? 0) + k);
  }
  const links = [...linkN].map(([key, k]) => {
    const [from, to] = key.split(">").map(Number) as [number, number];
    return { from, to, n: k };
  });
  for (const l of links) (parts[l.from]!.uses++, parts[l.to]!.usedBy++);
  const rings = placeParts(parts, links);
  return { parts, links, partOf, rings };
}

/**
 * Each part's band and depth, and the rings: Tarjan's strongly connected parts, then the longest path from where the code starts over
 * the rings taken as one. A ring nothing outside uses starts the code; one that uses nothing outside is a foundation.
 */
function placeParts(parts: Part[], links: readonly PartLink[]): number[][] {
  const n = parts.length;
  const comp = strongParts(n, links);
  const comps = Math.max(0, ...comp) + 1;
  const cOut: Set<number>[] = Array.from({ length: comps }, () => new Set());
  const cIn: Set<number>[] = Array.from({ length: comps }, () => new Set());
  for (const l of links) {
    const a = comp[l.from]!, b = comp[l.to]!;
    if (a !== b) (cOut[a]!.add(b), cIn[b]!.add(a));
  }
  const depth = new Array<number>(comps).fill(0);
  const left = cIn.map((s) => s.size);
  const queue = [...Array(comps).keys()].filter((c) => !left[c]);
  while (queue.length) {
    const c = queue.shift()!;
    for (const d of cOut[c]!) {
      depth[d] = Math.max(depth[d]!, depth[c]! + 1);
      if (--left[d]! === 0) queue.push(d);
    }
  }
  const members: number[][] = Array.from({ length: comps }, () => []);
  parts.forEach((_, i) => members[comp[i]!]!.push(i));
  const rings = members.filter((m) => m.length > 1).sort((a, b) => b.length - a.length || a[0]! - b[0]!);
  rings.forEach((r, k) => r.forEach((i) => (parts[i]!.ring = k)));
  parts.forEach((p, i) => {
    const c = comp[i]!;
    p.depth = depth[c]!;
    p.band = !p.uses && !p.usedBy ? "apart" : !cIn[c]!.size ? "start" : !cOut[c]!.size ? "base" : "middle";
  });
  return rings;
}

/** Each part's strongly connected group (iterative Tarjan, so a long chain can't run out of stack). */
function strongParts(n: number, links: readonly PartLink[]): number[] {
  const out: number[][] = Array.from({ length: n }, () => []);
  for (const l of links) out[l.from]!.push(l.to);
  const comp = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const num = new Array<number>(n).fill(-1);
  const stack: number[] = [];
  const on = new Array<boolean>(n).fill(false);
  let counter = 0;
  let comps = 0;
  for (let v = 0; v < n; v++) {
    if (num[v] !== -1) continue;
    const work: [number, number][] = [[v, 0]];
    num[v] = low[v] = counter++;
    stack.push(v);
    on[v] = true;
    while (work.length) {
      const top = work[work.length - 1]!;
      const [u, i] = top;
      if (i < out[u]!.length) {
        top[1]++;
        const w = out[u]![i]!;
        if (num[w] === -1) {
          num[w] = low[w] = counter++;
          stack.push(w);
          on[w] = true;
          work.push([w, 0]);
        } else if (on[w]) low[u] = Math.min(low[u]!, num[w]!);
      } else {
        work.pop();
        if (work.length) {
          const p = work[work.length - 1]![0];
          low[p] = Math.min(low[p]!, low[u]!);
        }
        if (low[u] === num[u]) {
          let w: number;
          do {
            w = stack.pop()!;
            on[w] = false;
            comp[w] = comps;
          } while (w !== u);
          comps++;
        }
      }
    }
  }
  return comp;
}

const list = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);
/**
 * The map in a sentence, said over it: where the code starts, what it runs through, what it rests on. "Starts in 5 places, runs
 * through a ring of 13 parts that all use one another, and rests on Router management. 10 more stand apart."
 */
export function describeMap(m: CodeMapModel): string {
  const by = (b: Band) => m.parts.filter((p) => p.band === b);
  const start = by("start"), middle = by("middle"), base = by("base"), apart = by("apart");
  if (!m.links.length) return m.parts.length === 1 ? "One part, all its own." : `${m.parts.length} parts, none of them using another.`;
  const bits: string[] = [];
  bits.push(start.length === 1 ? `Starts in ${start[0]!.name}` : start.length ? `Starts in ${start.length} places` : "Has no clear way in");
  if (middle.length) {
    const ring = m.rings[0] && m.rings[0].length >= 3 && m.parts[m.rings[0][0]!]!.band === "middle" ? m.rings[0].length : 0;
    const rest = middle.length - ring;
    bits.push(
      ring
        ? `runs through a ring of ${ring} parts that all use one another${rest ? ` and ${rest} more` : ""}`
        : `runs through ${middle.length === 1 ? middle[0]!.name : `${middle.length} parts`}`,
    );
  }
  if (base.length) bits.push(`rests on ${base.length <= 2 ? list(base.map((p) => p.name)) : `${base.length} foundations`}`);
  const said = bits.length === 1 ? bits[0]! : `${bits.slice(0, -1).join(", ")}${bits.length > 2 ? "," : ""} and ${bits[bits.length - 1]}`;
  return `${said}.${apart.length ? ` ${apart.length === 1 ? "One more stands" : `${apart.length} more stand`} apart.` : ""}`;
}

/** Everything a part reaches by what it uses, and what it uses, and so on (`down`), or everything that reaches it (`up`). */
export function reach(m: CodeMapModel, from: number, way: "down" | "up"): Set<number> {
  const next: number[][] = Array.from({ length: m.parts.length }, () => []);
  for (const l of m.links) way === "down" ? next[l.from]!.push(l.to) : next[l.to]!.push(l.from);
  const seen = new Set<number>();
  const stack = [from];
  while (stack.length) for (const w of next[stack.pop()!]!) if (w !== from && !seen.has(w)) (seen.add(w), stack.push(w));
  return seen;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface StackLayout {
  /** Each part's block, by its index; every part has one. */
  boxes: Box[];
  /** Each band's heading line and the room under it. */
  bands: { band: Band; y: number; h: number; n: number }[];
  /** A soft box round each ring of three or more, with how many are in it. */
  rings: (Box & { ring: number; n: number })[];
  width: number;
  height: number;
}
/** Sizes of the stack, in CSS pixels. */
export const STACK = { pad: 20, head: 30, gap: 10, bandGap: 26, blockH: 100, chipH: 30, chipGap: 8, ringPad: 10, ringHead: 30, minW: 184 } as const;

/** How much room a block wants, before its row shares out the band's width: more for more lines, on a log scale. */
export const blockWant = (lines: number) => 1 + Math.min(0.5, 0.09 * Math.log2(Math.max(1, lines / 300)));
/** A part's name as a chip, roughly, when the page can't measure it: about 7px a letter, plus its padding. */
const guessChip = (name: string) => name.length * 7 + 40;

/**
 * Layers: the code as an architecture diagram, top to bottom (Arun, 2026-11-23): where it starts, the middle, what it rests on, each
 * band rows of blocks, and the parts standing apart as small chips at the foot. A full row shares the band's width by size, so a
 * bigger part is a wider block; a row with room to spare is centred, so one foundation sits under the middle of what rests on it. A
 * ring of three or more parts that use one another sits together in a soft box of its own. No lines at rest: the bands say which way
 * the code runs, and a part's own links draw when it's pointed at or chosen. `chip` measures a chip's width from its name.
 */
export function stackLayout(m: CodeMapModel, width: number, chip: (name: string) => number = guessChip): StackLayout {
  const W = Math.max(160, width - 2 * STACK.pad);
  const boxes: Box[] = new Array(m.parts.length);
  const bands: StackLayout["bands"] = [];
  const ringBoxes: StackLayout["rings"] = [];
  let y = STACK.pad;
  const blocks = (items: number[], x0: number, w: number) => {
    const cols = Math.max(1, Math.floor((w + STACK.gap) / (STACK.minW + STACK.gap)));
    const cw = (w - (cols - 1) * STACK.gap) / cols;
    const want = items.map((i) => blockWant(m.parts[i]!.lines));
    const mean = want.reduce((s, v) => s + v, 0) / Math.max(1, want.length);
    for (let k = 0; k < items.length; k += cols) {
      const row = want.slice(k, k + cols);
      const free = w - (row.length - 1) * STACK.gap;
      let ws: number[];
      if (row.length === cols) {
        const sum = row.reduce((s, v) => s + v, 0);
        ws = row.map((v) => (free * v) / sum);
      } else {
        ws = row.map((v) => cw * Math.min(1.3, Math.max(0.85, v / mean)));
        const sum = ws.reduce((s, v) => s + v, 0);
        if (sum > free) ws = ws.map((v) => (v * free) / sum);
      }
      const used = ws.reduce((s, v) => s + v, 0) + (row.length - 1) * STACK.gap;
      let x = x0 + (w - used) / 2;
      ws.forEach((bw, j) => {
        boxes[items[k + j]!] = { x: Math.round(x), y, w: Math.round(x + bw) - Math.round(x), h: STACK.blockH };
        x += bw + STACK.gap;
      });
      y += STACK.blockH + STACK.gap;
    }
    y -= STACK.gap;
  };
  const chips = (items: number[], x0: number, w: number) => {
    let row: { i: number; w: number }[] = [];
    let used = 0;
    const flush = () => {
      let x = x0 + (w - used) / 2;
      for (const c of row) (boxes[c.i] = { x: Math.round(x), y, w: c.w, h: STACK.chipH }), (x += c.w + STACK.chipGap);
      y += STACK.chipH + STACK.chipGap;
      (row = []), (used = 0);
    };
    for (const i of items) {
      const cw = Math.min(w, Math.ceil(chip(m.parts[i]!.name)));
      if (row.length && used + STACK.chipGap + cw > w) flush();
      used += (row.length ? STACK.chipGap : 0) + cw;
      row.push({ i, w: cw });
    }
    if (row.length) flush();
    y -= STACK.chipGap;
  };
  const order = (a: number, b: number) => {
    const p = m.parts[a]!, q = m.parts[b]!;
    return p.depth - q.depth || q.usedBy - p.usedBy || q.lines - p.lines || a - b;
  };
  const bigFirst = (a: number, b: number) => m.parts[b]!.lines - m.parts[a]!.lines || a - b;
  for (const band of ["start", "middle", "base", "apart"] as Band[]) {
    const here = m.parts.map((_, i) => i).filter((i) => m.parts[i]!.band === band);
    if (!here.length) continue;
    const top = y;
    y += STACK.head;
    if (band === "apart") chips(here.sort(bigFirst), STACK.pad, W);
    else if (band === "start") blocks(here.sort(bigFirst), STACK.pad, W);
    else {
      // The band's big rings first, each in its box, then the rest, a pair that uses each other side by side.
      const big = m.rings.map((r, k) => ({ r, k })).filter(({ r }) => r.length >= 3 && m.parts[r[0]!]!.band === band);
      for (const { r, k } of big) {
        const y0 = y;
        y += STACK.ringHead;
        blocks([...r].sort((a, b) => m.parts[b]!.usedBy - m.parts[a]!.usedBy || order(a, b)), STACK.pad + STACK.ringPad, W - 2 * STACK.ringPad);
        y += STACK.ringPad;
        ringBoxes.push({ x: STACK.pad, y: y0, w: W, h: y - y0, ring: k, n: r.length });
        y += STACK.gap;
      }
      const inBig = new Set(big.flatMap(({ r }) => r));
      const rest = here.filter((i) => !inBig.has(i));
      const lead = (i: number) => {
        const ring = m.parts[i]!.ring;
        return ring < 0 ? i : [...m.rings[ring]!].sort(order)[0]!;
      };
      rest.sort((a, b) => order(lead(a), lead(b)) || order(a, b));
      if (rest.length) blocks(rest, STACK.pad, W);
      else y -= STACK.gap;
    }
    bands.push({ band, y: top, h: y - top, n: here.length });
    y += STACK.bandGap;
  }
  return { boxes, bands, rings: ringBoxes, width: W + 2 * STACK.pad, height: y - STACK.bandGap + STACK.pad };
}

/**
 * Web: parts pull towards those they are linked to (more imports, a stronger pull) and push the near ones away, so what talks together
 * sits together; and each is drawn towards its band's height, so the web reads top to bottom like Layers, from where the code starts
 * to what it rests on. Worked out ahead, the same every time for the same repo: it starts from fixed places, never from chance. Parts
 * standing apart have no place here (null): the page sets them in a row of their own.
 */
export function webLayout(m: CodeMapModel, size = 900): ({ x: number; y: number } | null)[] {
  const n = m.parts.length;
  const deg = new Array<number>(n).fill(0);
  for (const l of m.links) (deg[l.from]! += l.n, deg[l.to]! += l.n);
  const linked = [...Array(n).keys()].filter((v) => m.parts[v]!.band !== "apart");
  if (!linked.length) return new Array(n).fill(null);
  const k = Math.max(110, Math.sqrt((size * size) / Math.max(1, linked.length)) * 0.55);
  const maxDepth = Math.max(1, ...linked.map((v) => m.parts[v]!.depth));
  const goalY = (v: number) => {
    const p = m.parts[v]!;
    return (p.band === "start" ? -0.85 : p.band === "base" ? 0.85 : -0.4 + (0.8 * p.depth) / maxDepth) * k * 1.7;
  };
  const x = new Array<number>(n).fill(0);
  const y = new Array<number>(n).fill(0);
  // Each band starts spread in a line at its height, its best-linked parts in the middle.
  for (const band of ["start", "middle", "base"] as Band[]) {
    const here = linked.filter((v) => m.parts[v]!.band === band).sort((a, b) => deg[b]! - deg[a]! || a - b);
    here.forEach((v, i) => {
      const side = i % 2 ? -1 : 1;
      x[v] = side * Math.ceil(i / 2) * k * 0.8;
      y[v] = goalY(v) + ((i % 3) - 1) * k * 0.25;
    });
  }
  const pairs = m.links.map((l) => ({ a: l.from, b: l.to, w: Math.min(3, 1 + Math.log2(1 + l.n) / 3) }));
  let t = k;
  for (let it = 0; it < 360; it++) {
    const dx = new Array<number>(n).fill(0);
    const dy = new Array<number>(n).fill(0);
    for (let i = 0; i < linked.length; i++)
      for (let j = i + 1; j < linked.length; j++) {
        const a = linked[i]!, b = linked[j]!;
        let ex = x[a]! - x[b]!, ey = y[a]! - y[b]!;
        let d = Math.hypot(ex, ey);
        if (d < 0.01) (ex = 0.01 * (i - j)), (ey = 0.01), (d = Math.hypot(ex, ey));
        if (d > 2.4 * k) continue;
        // Wider than tall, as names are: a push across counts for less than one up or down.
        const f = (k * k) / (d * d);
        dx[a]! += ex * f * 1.4;
        dy[a]! += ey * f * 0.8;
        dx[b]! -= ex * f * 1.4;
        dy[b]! -= ey * f * 0.8;
      }
    for (const { a, b, w } of pairs) {
      const ex = x[a]! - x[b]!, ey = y[a]! - y[b]!;
      const d = Math.max(0.01, Math.hypot(ex, ey));
      const f = (d / k) * w * 0.3;
      dx[a]! -= ex * f;
      dy[a]! -= ey * f;
      dx[b]! += ex * f;
      dy[b]! += ey * f;
    }
    for (const v of linked) {
      dx[v]! -= x[v]! * 0.02;
      dy[v]! += (goalY(v) - y[v]!) * 0.25;
      // Where the code starts stays along the top and its foundations along the foot, however hard their links pull.
      if (m.parts[v]!.band !== "middle") dy[v] = (goalY(v) - y[v]!) * 0.5;
      const d = Math.max(0.01, Math.hypot(dx[v]!, dy[v]!));
      x[v]! += (dx[v]! / d) * Math.min(d, t);
      y[v]! += (dy[v]! / d) * Math.min(d, t);
      // The middle stays between the two: never above where the code starts or under what it rests on.
      if (m.parts[v]!.band === "middle") y[v] = Math.min(0.6 * k * 1.7, Math.max(-0.6 * k * 1.7, y[v]!));
    }
    t = Math.max(0.5, t * 0.985);
  }
  return m.parts.map((_, i) => (m.parts[i]!.band === "apart" ? null : { x: Math.round(x[i]!), y: Math.round(y[i]!) }));
}

/**
 * Pushes boxes apart until none overlap (with `gap` between), each along the way it overlaps least; boxes keep their sizes. With
 * `inside`, every box stays within it as it moves, so pushing one off an edge can't land it back on another.
 */
export function separate(boxes: Box[], gap = 8, rounds = 120, inside?: Box): Box[] {
  const out = boxes.map((b) => ({ ...b }));
  const keep = (b: Box) => {
    if (!inside) return;
    b.x = Math.min(inside.x + inside.w - b.w, Math.max(inside.x, b.x));
    b.y = Math.min(inside.y + inside.h - b.h, Math.max(inside.y, b.y));
  };
  out.forEach(keep);
  for (let r = 0; r < rounds; r++) {
    let moved = false;
    for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!, b = out[j]!;
        const ox = Math.min(a.x + a.w, b.x + b.w) + gap - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) + gap - Math.max(a.y, b.y);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        // Across when that's the smaller move, else up and down; every other round the other way, so a box held at an edge one
        // way is freed the other.
        if ((ox / (a.w + b.w) < oy / (a.h + b.h)) !== (r % 7 === 6)) {
          const s = (a.x + a.w / 2 <= b.x + b.w / 2 ? -1 : 1) * (ox / 2 + 0.5);
          a.x += s;
          b.x -= s;
        } else {
          const s = (a.y + a.h / 2 <= b.y + b.h / 2 ? -1 : 1) * (oy / 2 + 0.5);
          a.y += s;
          b.y -= s;
        }
        keep(a);
        keep(b);
      }
    if (!moved) break;
  }
  return out;
}

export interface Point {
  x: number;
  y: number;
}
/**
 * Layers' lines, routed as an architecture diagram's are (Arun, 2026-11-23): out of a block's bottom (or top), along the gutter
 * between rows, down a clear channel (a column's gutter, the side of a ring's box, the margin) and in at the other block, every turn
 * square, so a line never runs over another block's words. Where lines meet a block they spread along its edge in the order of the
 * blocks at their other ends; lines sharing a gutter keep to lanes a few pixels apart. `keep` are other things to keep clear of, such
 * as the bands' names. Each route is its corner points, first on `from`'s edge and last on `to`'s.
 */
export function routeLayers(boxes: Box[], lines: readonly { from: number; to: number }[], width: number, keep: Box[] = []): Point[][] {
  const gap = STACK.gap;
  const all = [...boxes.filter(Boolean), ...keep];
  const cx = (b: Box) => b.x + b.w / 2;
  const way = (a: Box, b: Box) => (Math.abs(a.y - b.y) < a.h / 2 ? "row" : b.y > a.y ? "down" : "up");
  // Ports: each line's end on its block's top or bottom edge, spread in the order of the other ends.
  const ends = new Map<string, { k: number; end: 0 | 1; other: number }[]>();
  const push = (key: string, v: { k: number; end: 0 | 1; other: number }) => (ends.get(key) ?? ends.set(key, []).get(key)!).push(v);
  lines.forEach((l, k) => {
    const a = boxes[l.from]!, b = boxes[l.to]!;
    const w = way(a, b);
    push(`${l.from}:${w === "down" ? "b" : "t"}`, { k, end: 0, other: cx(b) });
    push(`${l.to}:${w === "up" ? "b" : "t"}`, { k, end: 1, other: cx(a) });
  });
  const port: [number, number][] = lines.map(() => [0, 0]);
  for (const [key, list] of ends) {
    const box = boxes[Number(key.slice(0, key.indexOf(":")))]!;
    list.sort((p, q) => p.other - q.other || p.k - q.k);
    const span = Math.min(box.w * 0.6, (list.length - 1) * 12);
    list.forEach((e, j) => (port[e.k]![e.end] = Math.round(cx(box) + (list.length > 1 ? -span / 2 + (span * j) / (list.length - 1) : 0))));
  }
  // Whether a stretch up or down at x, or across at y, keeps off every block.
  const vClear = (x: number, y1: number, y2: number) => all.every((b) => !(x > b.x - 2 && x < b.x + b.w + 2 && b.y < Math.max(y1, y2) && b.y + b.h > Math.min(y1, y2)));
  const hClear = (y: number, x1: number, x2: number) => all.every((b) => !(y > b.y - 1 && y < b.y + b.h + 1 && b.x < Math.max(x1, x2) && b.x + b.w > Math.min(x1, x2)));
  const channels = [STACK.pad / 2, width - STACK.pad / 2, ...boxes.filter(Boolean).flatMap((b) => [b.x - gap / 2, b.x + b.w + gap / 2])];
  return lines.map((l, k) => {
    const a = boxes[l.from]!, b = boxes[l.to]!;
    const [xa, xb] = port[k]!;
    const lane = ((k % 3) - 1) * 2.5;
    const w = way(a, b);
    if (w === "row") {
      const y = a.y - gap / 2 + lane;
      return [{ x: xa, y: a.y }, { x: xa, y }, { x: xb, y }, { x: xb, y: b.y }];
    }
    const down = w === "down";
    const ya = down ? a.y + a.h : a.y, yb = down ? b.y : b.y + b.h;
    const y1 = ya + (down ? 1 : -1) * (gap / 2) + lane, y2 = yb - (down ? 1 : -1) * (gap / 2) + lane;
    // Straight down at the far end, or at the near end, when either is clear; else through the nearest clear channel.
    if (vClear(xb, y1, y2) && hClear(y1, xa, xb)) return [{ x: xa, y: ya }, { x: xa, y: y1 }, { x: xb, y: y1 }, { x: xb, y: yb }];
    if (vClear(xa, y1, y2) && hClear(y2, xa, xb)) return [{ x: xa, y: ya }, { x: xa, y: y2 }, { x: xb, y: y2 }, { x: xb, y: yb }];
    let best: number | null = null;
    for (const c of channels) {
      const x = c + lane;
      if (!vClear(x, y1, y2) || !hClear(y1, xa, x) || !hClear(y2, x, xb)) continue;
      if (best === null || Math.abs(x - xa) + Math.abs(x - xb) < Math.abs(best - xa) + Math.abs(best - xb)) best = x;
    }
    if (best === null) return [{ x: xa, y: ya }, { x: xa, y: y1 }, { x: xb, y: y1 }, { x: xb, y: yb }];
    return [{ x: xa, y: ya }, { x: xa, y: y1 }, { x: best, y: y1 }, { x: best, y: y2 }, { x: xb, y: y2 }, { x: xb, y: yb }];
  });
}
