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
import { memo } from "react";
import { teamColour } from "./teammate-block.js";
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

type Wave = { k: number; a: number; p: number };
export type Look = { waves: Wave[]; turn: number; eyeGap: number; eyeY: number; eyeX: number; eyeW: number; eyeH: number };

const looks = new Map<string, Look>();
/** A seed's shape and eyes: three harmonics of small amplitude, and where the eyes sit. */
export function lookOf(seed: string): Look {
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
  };
  looks.set(seed, look);
  return look;
}

const N = 48;
const f = (n: number) => (Math.round(n * 100) / 100).toString();

/** The outline for a set of waves, in a box from -50 to 50, its widest point on the circle of radius 50. */
export function outline(waves: readonly Wave[], turn = 0): string {
  const radii = Array.from({ length: N }, (_, i) => {
    const t = (i / N) * Math.PI * 2;
    return 1 + waves.reduce((s, w) => s + w.a * Math.sin(w.k * (t + turn) + w.p), 0);
  });
  const scale = 50 / Math.max(...radii);
  const pts = radii.map((rr, i) => {
    const t = (i / N) * Math.PI * 2 - Math.PI / 2;
    return [Math.cos(t) * rr * scale, Math.sin(t) * rr * scale] as const;
  });
  // Catmull-Rom through every point, as cubic Béziers: smooth all the way round, no corner anywhere.
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
  const had = shapes.get(seed);
  if (had) return had;
  const { waves, turn } = lookOf(seed);
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
  if (eyes === "open")
    return (
      <g fill={EYE} fillOpacity={0.88}>
        {xs.map((x) => <ellipse key={x} cx={f(x)} cy={f(look.eyeY)} rx={f(w)} ry={f(h)} />)}
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
export const BlobFace = memo(function BlobFace({ seed, size, eyes = "open", breathing = false, letters }: { seed: string; size: number; eyes?: Eyes; breathing?: boolean; letters?: string }) {
  const look = lookOf(seed);
  const shape = shapeOf(seed);
  const fill = teamColour(seed);
  const moving = breathing && !reducedMotion();
  return (
    // Its size inline: the places a face sits size their own icons' svgs (".rsp-avatar svg" and the like), never a face's.
    <svg className="tm-face tm-blob" width={size} height={size} style={{ width: size, height: size }} viewBox="-50 -50 100 100" aria-hidden="true" focusable="false">
      <path className="tm-blob-body" d={shape.still} fill={fill}>
        {moving && <animate attributeName="d" dur="9s" repeatCount="indefinite" values={shape.breathing} keyTimes="0;0.34;0.67;1" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1;0.45 0 0.55 1" />}
      </path>
      {letters ? (
        <text x="0" y="1" textAnchor="middle" dominantBaseline="central" fill={inkOn(fill)} fontSize={letters.length > 1 ? 40 : 48} fontWeight={600} letterSpacing="-0.02em" style={{ fontFamily: "var(--font)" }}>
          {letters}
        </text>
      ) : (
        <EyesOf look={look} eyes={eyes} size={size} />
      )}
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
