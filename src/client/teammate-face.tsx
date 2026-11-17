/**
 * A teammate's face, Friday's own drawing (Arun, 2026-10-29: "those avatars should be purely circle based with different morphed
 * shapes"; "no rectangle or pill etc"): a soft round blob, a circle morphed by a few smooth harmonics,
 *
 *   r(θ) = 1 + a₂·sin(2θ + φ₂) + a₃·sin(3θ + φ₃) + a₄·sin(4θ + φ₄),
 *
 * sampled at 48 points and smoothed into Béziers, in the teammate's muted hue (teammate-look.ts), with two calm eyes: open, a
 * blink, closed asleep. The amplitudes and phases come from the teammate's look seed, so every teammate has a silhouette of its
 * own that is always round and always the same for the same seed; "Shuffle look" changes the seed and so the shape. Each shape is
 * scaled so its widest point touches its box's circle, so the presence ring (presence.tsx) sits evenly round any of them.
 *
 * A working face may breathe: its harmonics drift very slowly (an SVG animation of the outline over 9s, no pulse, no change of
 * size), and not at all with reduced motion. It replaces the Avatar Lab mascots (AGPL), so no face is anyone else's drawing.
 *
 */
import { memo, type CSSProperties } from "react";
import { isV2, shapeSeed, teamColour } from "./teammate-block.js";
import { reducedMotion } from "./presence.js";

const hash = (seed: string) => [...seed].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 2166136261);

/** A small seeded generator (mulberry32): the same numbers for the same seed, every time. */
function numbers(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A harmonic of the outline; `bump` makes it |sin|, k bumps meeting in soft dips: a cloud's scallops. */
type Wave = { k: number; a: number; p: number; bump?: true };
/**
 * The second set of faces (Arun, 2026-11-03: "add more mascot designs and colors too"), for looks marked "v2:": still round and
 * soft (since 2026-11-15 a square, a pill and a capsule too, below), now with a body of four kinds (a blob, a cloud of six soft bumps, a five-petal flower,
 * a pebble), eyes of four (dots, round ones with a shine, small beads, wide-set ovals) and one small extra or none (cheeks,
 * freckles, a sprout, round ears, an antenna). Every look made before is a plain blob with dots, as it was.
 */
export type Body = "blob" | "cloud" | "flower" | "pebble" | "square" | "pill" | "capsule";
export type EyeKind = "dot" | "round" | "bead" | "wide";
export type Extra = "none" | "cheeks" | "freckles" | "sprout" | "ears" | "antenna";
/** A body drawn as a rounded box rather than a morphed circle: its width, height and corner radius, before scaling to the circle. */
export type Box = { w: number; h: number; rc: number };
export type Look = { box?: Box; waves: Wave[]; turn: number; eyeGap: number; eyeY: number; eyeX: number; eyeW: number; eyeH: number; body: Body; eyeKind: EyeKind; extra: Extra };
const pick = <T,>(r: () => number, xs: readonly (readonly [T, number])[]): T => {
  let x = r() * xs.reduce((s, [, w]) => s + w, 0);
  for (const [v, w] of xs) if ((x -= w) < 0) return v;
  return xs[0]![0];
};
/** Something on top of the head (a sprout, ears, an antenna), which the lead's crown takes the place of. */
export const onTop = (e: Extra) => e === "sprout" || e === "ears" || e === "antenna";

const looks = new Map<string, Look>();
/** A seed's shape and eyes: three harmonics of small amplitude, and where the eyes sit. */
export function lookOf(seed: string): Look {
  // A picked colour isn't part of the shape (teammate-look.ts withColour).
  seed = shapeSeed(seed);
  const had = looks.get(seed);
  if (had) return had;
  const r = numbers(hash(seed || "Friday") ^ 0x9e3779b9);
  const between = (lo: number, hi: number) => lo + (hi - lo) * r();
  const look: Look = {
    waves: [
      { k: 2, a: between(0.025, 0.06), p: between(0, Math.PI * 2) },
      { k: 3, a: between(0.012, 0.042), p: between(0, Math.PI * 2) },
      { k: 4, a: between(0.006, 0.026), p: between(0, Math.PI * 2) },
    ],
    turn: between(0, Math.PI * 2),
    eyeGap: between(11.5, 15.5),
    eyeY: between(-5, 1),
    eyeX: between(-2.5, 2.5),
    eyeW: between(5, 6.2),
    eyeH: between(8.6, 10.6),
    body: "blob",
    eyeKind: "dot",
    extra: "none",
  };
  // Every face has a body of its own kind, old looks too (Arun, 2026-11-15: "all of the shapes ... like cloud, square, pill etc
  // instead of random circle shapes"): a cloud, a soft square, a pill lying down, a capsule standing up, a flower or a pebble;
  // the plain morphed circle is no longer dealt. Drawn from the same numbers, after the first set's, so a look stays fixed for its
  // seed. Only a v2 look also has eyes and an extra of its own kind.
  const v2 = isV2(seed);
  look.body = pick<Body>(r, [["cloud", 3], ["square", 3], ["pill", 3], ["capsule", 2], ["flower", 2], ["pebble", 1.5]]);
  if (v2) {
    look.eyeKind = pick<EyeKind>(r, [["dot", 3], ["round", 3], ["bead", 2], ["wide", 2]]);
    look.extra = pick<Extra>(r, [["none", 3], ["cheeks", 2], ["freckles", 1], ["sprout", 1.5], ["ears", 1.5], ["antenna", 1]]);
    // No ears (Arun, 2026-11-15: "get rid of the ears"): drawn from the same numbers so every other look stays as it was.
    if (look.extra === "ears") look.extra = "none";
  }
  {
    const p = () => between(0, Math.PI * 2);
    if (look.body === "square") (look.box = { w: 88, h: 86, rc: between(26, 32) }), (look.eyeY = between(-4, 0));
    else if (look.body === "pill") (look.box = { w: 100, h: between(66, 72), rc: 99 }), (look.eyeY = between(-3, 1)), (look.eyeGap = Math.max(look.eyeGap, 14));
    else if (look.body === "capsule") (look.box = { w: between(72, 78), h: 100, rc: 99 }), (look.eyeY = between(-9, -4)), (look.eyeGap = Math.min(look.eyeGap, 12.5));
    else if (look.body === "cloud") look.waves = [{ k: r() < 0.5 ? 6 : 7, a: between(0.13, 0.16), p: p(), bump: true }, { k: 2, a: between(0.02, 0.04), p: p() }];
    else if (look.body === "flower") look.waves = [{ k: 5, a: between(0.06, 0.08), p: p() }, { k: 2, a: between(0.01, 0.02), p: p() }];
    else if (look.body === "pebble") (look.waves = [{ k: 2, a: between(0.08, 0.11), p: p() }, { k: 3, a: between(0.01, 0.03), p: p() }]), (look.turn = r() < 0.5 ? 0 : Math.PI / 4);
    if (look.eyeKind === "wide") look.eyeGap = look.body === "capsule" ? 14 : between(16, 18.5);
    if (look.eyeKind === "bead") look.eyeGap = between(10, 13);
  }
  looks.set(seed, look);
  return look;
}

const N = 48;
const f = (n: number) => (Math.round(n * 100) / 100).toString();

/** The outline for a set of waves, in a box from -50 to 50, its widest point on the circle of radius 50. */
export function outline(waves: readonly Wave[], turn = 0): string {
  const radii = Array.from({ length: N }, (_, i) => {
    const t = (i / N) * Math.PI * 2;
    return 1 + waves.reduce((s, w) => s + w.a * (w.bump ? Math.abs(Math.sin((w.k / 2) * (t + turn) + w.p)) : Math.sin(w.k * (t + turn) + w.p)), 0);
  });
  const scale = 50 / Math.max(...radii);
  const pts = radii.map((rr, i) => {
    const t = (i / N) * Math.PI * 2 - Math.PI / 2;
    return [Math.cos(t) * rr * scale, Math.sin(t) * rr * scale] as const;
  });
  return smooth(pts);
}

/**
 * A rounded box (a soft square, a pill, a capsule) as the same kind of outline: 48 points evenly round its edge from the top's
 * middle, clockwise, smoothed the same way, and scaled so its farthest point is on the circle of radius 50.
 */
export function boxOutline({ w, h, rc }: Box): string {
  const r = Math.min(rc, w / 2, h / 2);
  const [hw, hh] = [w / 2, h / 2];
  // The edge as straight runs and quarter arcs, walked by length.
  const sx = hw - r, sy = hh - r;
  const segs: { len: number; at: (t: number) => readonly [number, number] }[] = [];
  const line = (x0: number, y0: number, x1: number, y1: number) => segs.push({ len: Math.hypot(x1 - x0, y1 - y0), at: (t) => [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t] });
  const arc = (cx: number, cy: number, a0: number) => segs.push({ len: (Math.PI / 2) * r, at: (t) => [cx + r * Math.cos(a0 + (t * Math.PI) / 2), cy + r * Math.sin(a0 + (t * Math.PI) / 2)] });
  line(0, -hh, sx, -hh);
  arc(sx, -sy, -Math.PI / 2);
  line(hw, -sy, hw, sy);
  arc(sx, sy, 0);
  line(sx, hh, -sx, hh);
  arc(-sx, sy, Math.PI / 2);
  line(-hw, sy, -hw, -sy);
  arc(-sx, -sy, Math.PI);
  line(-sx, -hh, 0, -hh);
  const total = segs.reduce((n, g) => n + g.len, 0);
  const raw = Array.from({ length: N }, (_, i) => {
    let d = (i / N) * total;
    for (const g of segs) {
      if (d <= g.len || g === segs[segs.length - 1]) return g.at(g.len ? Math.min(1, d / g.len) : 0);
      d -= g.len;
    }
    return [0, -hh] as const;
  });
  const scale = 50 / Math.max(...raw.map(([x, y]) => Math.hypot(x, y)));
  return smooth(raw.map(([x, y]) => [x * scale, y * scale] as const));
}

/** Catmull-Rom through every point, as cubic Béziers: smooth all the way round. */
function smooth(pts: readonly (readonly [number, number])[]): string {
  const at = (i: number) => pts[(i + N) % N]!;
  let d = `M${f(pts[0]![0])} ${f(pts[0]![1])}`;
  for (let i = 0; i < N; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return `${d}Z`;
}

const shapes = new Map<string, { still: string; breathing: string }>();
/** A seed's outline, and the slow breath a working face takes through two near neighbours of it and back. */
export function shapeOf(seed: string): { still: string; breathing: string } {
  seed = shapeSeed(seed);
  const had = shapes.get(seed);
  if (had) return had;
  const { waves, turn, box } = lookOf(seed);
  // A box keeps its shape: a working one breathes as a whole (BlobFace), never through its outline.
  if (box) {
    const still = boxOutline(box);
    const s = { still, breathing: [still, still, still, still].join(";") };
    shapes.set(seed, s);
    return s;
  }
  const still = outline(waves, turn);
  const drift = (da: number[], dp: number[]) => outline(waves.map((w, i) => ({ ...w, a: w.a * da[i]!, p: w.p + dp[i]! })), turn);
  const breathing = [still, drift([1.25, 0.8, 1.2], [0.45, -0.35, 0.3]), drift([0.8, 1.25, 0.85], [-0.35, 0.45, -0.25]), still].join(";");
  const s = { still, breathing };
  shapes.set(seed, s);
  return s;
}

/** Dark ink on the light hues, white on the darker ones: the colour of a face's letters (teammate-initials.tsx). */
export function inkOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.33 ? "rgb(17 19 22 / 0.86)" : "#fff";
}

/** A colour made deeper by `k` (0 to 1, of its brightness), for a face's own small parts. */
export function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * k).toString(16).padStart(2, "0"));
  return `#${c.join("")}`;
}

export type Eyes = "open" | "blink" | "closed";
const EYE = "#111316";

/**
 * The eyes, in the face's own units (100 across). At small sizes they keep a floor in real pixels, so a 16px face still has two
 * clear eyes rather than a smudge: 1.1px wide and 2px tall at least, and closed eyes a 1px line at least.
 */
function EyesOf({ look, eyes, size }: { look: Look; eyes: Eyes; size: number }) {
  const px = 100 / size;
  const w = Math.max(look.eyeW, 0.55 * px);
  const h = Math.max(look.eyeH, 1 * px);
  const gap = Math.max(look.eyeGap, w + 1.4 * px);
  const xs = [look.eyeX - gap, look.eyeX + gap];
  if (eyes === "open" && (look.eyeKind === "round" || look.eyeKind === "bead")) {
    const rr = look.eyeKind === "round" ? Math.max(7.2, 1 * px) : Math.max(4.4, 0.9 * px);
    return (
      <g>
        {xs.map((x) => (
          <g key={x}>
            <circle cx={f(x)} cy={f(look.eyeY)} r={f(rr)} fill={EYE} fillOpacity={0.88} />
            {/* No shine in the eyes (Arun, 2026-11-15: "get rid of ... the white glitter in their eyes"). */}
          </g>
        ))}
      </g>
    );
  }
  if (eyes === "open")
    return (
      <g fill={EYE} fillOpacity={0.88}>
        {xs.map((x) => <ellipse key={x} cx={f(x)} cy={f(look.eyeY)} rx={f(look.eyeKind === "wide" ? w * 0.9 : w)} ry={f(look.eyeKind === "wide" ? h * 0.78 : h)} />)}
      </g>
    );
  // A blink is a short straight line; asleep, each eye a soft downward curve.
  const line = Math.max(3.2, 1 * px);
  return (
    <g fill="none" stroke={EYE} strokeOpacity={0.88} strokeWidth={f(line)} strokeLinecap="round">
      {xs.map((x) =>
        eyes === "blink" ? (
          <path key={x} d={`M${f(x - w * 1.25)} ${f(look.eyeY + 2)}H${f(x + w * 1.25)}`} />
        ) : (
          <path key={x} d={`M${f(x - w * 1.5)} ${f(look.eyeY + 1)}Q${f(x)} ${f(look.eyeY + 1 + w * 1.3)} ${f(x + w * 1.5)} ${f(look.eyeY + 1)}`} />
        ),
      )}
    </g>
  );
}

/**
 * A teammate's face at `size` px: its blob in its hue and its eyes, or (`letters`) its initials on the same blob. `breathing`
 * lets a working face drift; it holds still with reduced motion.
 */
/** Each face's own rhythm, from its seed: when in its cycle it blinks, so a sidebar of faces never blinks as one. */
function lifeOf(seed: string): CSSProperties {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return { "--blink-d": `${-(h % 70) / 10}s`, "--blink-t": `${5.5 + (h % 30) / 10}s` } as CSSProperties;
}

export const BlobFace = memo(function BlobFace({ seed, size, eyes = "open", breathing = false, letters, crowned = false, dozing = false }: { seed: string; size: number; eyes?: Eyes; breathing?: boolean; letters?: string; /** The lead: its crown is on its head, so nothing else is. */ crowned?: boolean; /** Asleep at rest: eyes shut until hovered (Teammates.tsx useDozing). */ dozing?: boolean }) {
  const look = lookOf(seed);
  const shape = shapeOf(seed);
  const fill = teamColour(seed);
  const moving = breathing && !reducedMotion();
  // A face as large as a page's header morphs its outline; a smaller one, which is nearly every face (rows, the sidebar, the
  // chat), breathes as a whole by transform, which the compositor runs: eight agents at work had their outlines re-drawn on the
  // main thread every frame, in every place their faces showed (Arun, 2026-11-04: "look at app performance… a lot of agents").
  const morph = moving && size >= 40 && !look.box;
  const extra = letters || (crowned && onTop(look.extra)) ? "none" : look.extra;
  // Something on its head: the body a little smaller and lower, so all of it stays in the face's circle and its ring.
  const top = onTop(extra);
  return (
    // Its size inline: the places a face sits size their own icons' svgs (".rsp-avatar svg" and the like), never a face's.
    <svg className={`tm-face tm-blob${moving && !morph ? " tm-breathe" : ""}${dozing ? " tm-dozing" : ""}`} width={size} height={size} style={{ width: size, height: size, ...lifeOf(seed) }} viewBox="-50 -50 100 100" aria-hidden="true" focusable="false">
      {extra === "antenna" && (
        // In a deeper shade of its own colour, so it reads on either ground and grows out of its head rather than floating.
        <g>
          <path d="M0 -32V-43" stroke={shade(fill, 0.68)} strokeWidth={3.6} strokeLinecap="round" />
          <circle cx={0} cy={-44.5} r={5.2} fill={fill} stroke={shade(fill, 0.68)} strokeWidth={2.6} />
        </g>
      )}
      {extra === "sprout" && (
        <g>
          <path d="M0 -35C0 -40 0.5 -43 1.5 -46" fill="none" stroke="#5f9e5c" strokeWidth={3} strokeLinecap="round" />
          <ellipse cx={-6} cy={-45} rx={6.5} ry={3.6} transform="rotate(-25 -6 -45)" fill="#74b86f" />
          <ellipse cx={7.5} cy={-47} rx={6} ry={3.4} transform="rotate(20 7.5 -47)" fill="#86c47f" />
        </g>
      )}
      <g transform={top ? "translate(0 7) scale(0.85)" : undefined}>
        <path className="tm-blob-body" d={shape.still} fill={fill}>
          {morph && <animate attributeName="d" dur="9s" repeatCount="indefinite" values={shape.breathing} keyTimes="0;0.34;0.67;1" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1;0.45 0 0.55 1" />}
        </path>
        {letters ? (
          <text x="0" y="1" textAnchor="middle" dominantBaseline="central" fill={inkOn(fill)} fontSize={letters.length > 1 ? 40 : 48} fontWeight={600} letterSpacing="-0.02em" style={{ fontFamily: "var(--font)" }}>
            {letters}
          </text>
        ) : (
          <>
            {extra === "cheeks" && size >= 18 && (
              <g fill="#ff6f8a" fillOpacity={0.42}>
                {[-1, 1].map((s) => <ellipse key={s} cx={f(look.eyeX + s * (look.eyeGap + 9))} cy={f(look.eyeY + 13)} rx={7} ry={4.6} />)}
              </g>
            )}
            {extra === "freckles" && size >= 22 && (
              <g fill={EYE} fillOpacity={0.3}>
                {[-1, 1].flatMap((s) => [0, 1, 2].map((i) => <circle key={`${s}${i}`} cx={f(look.eyeX + s * (look.eyeGap + 4 + i * 4))} cy={f(look.eyeY + 13 + (i === 1 ? 2.5 : 0))} r={1.5} />))}
              </g>
            )}
            {/* Its eyes as one group, for the blink and the glance teammates.css gives them (Arun, 2026-11-15: "make the mascots feel
                alive and have some movement over hover"). */}
            <g className="tm-look">
              <g className="tm-eyes">
                <EyesOf look={look} eyes={eyes} size={size} />
              </g>
            </g>
            {/* Dozing, its shut eyes over the open ones, which a hover brings back (teammates.css). */}
            {dozing && eyes === "open" && (
              <g className="tm-eyes-shut">
                <EyesOf look={look} eyes="closed" size={size} />
              </g>
            )}
          </>
        )}
      </g>
    </svg>
  );
});

/** The lead's one accessory: a small crown on the top of its face, outlined in the ground so it reads over the ring. */
export function Crown() {
  return (
    <svg className="tm-face-lead" viewBox="0 0 20 12" aria-hidden="true" focusable="false">
      <path d="M2 10.5V3.2l4.4 3.6L10 1.5l3.6 5.3L18 3.2v7.3Z" strokeLinejoin="round" />
    </svg>
  );
}
