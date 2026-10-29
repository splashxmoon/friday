/**
 * A teammate's face: a block of Friday's own mark, the hexagon of three faces round a hollow core, as on its app icon,
 * in the teammate's colour (Arun, 2026-10-27: "can we have our own spin on this so it doesnt just look like a rip off of open
 * bot"). It replaces the round characters with eyes, which looked like OpenBot's and were AGPL besides. A room is the same mark
 * with each face in one of its members' colours: the team built into Friday.
 *
 * Each teammate's block is lit from its own side (which face is lightest, from its seed), so two in one colour still differ. How
 * it stands is told without moving: needing the person, its core lights; out of usage, red; working, the dot beside it.
 *
 */
import { memo, useId } from "react";

// The colours and the pick of a free one, shared with the server (teammate-look.ts).
import { teamColour } from "../teammate-look.js";
export { TEAM_COLOURS, teamColour, distinctLook } from "../teammate-look.js";

const hash = (seed: string) => [...seed].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 2166136261);

/** A point on a hexagon round the middle of a 100 box, pointing up: 0 is the top corner, then clockwise. */
const at = (r: number, corner: number): string => {
  const a = ((corner * 60 - 90) * Math.PI) / 180;
  return `${(50 + r * Math.cos(a)).toFixed(2)},${(50 + r * Math.sin(a)).toFixed(2)}`;
};
const OUT = 42;
const CORE = 19;
const piece = (corners: number[]) => [...corners.map((c) => at(OUT, c)), ...[...corners].reverse().map((c) => at(CORE, c))].join(" ");

/** The mark's three faces, as it draws them: the left from the top corner round to the lower left, the right, the bottom. */
const FACES = [
  { points: piece([0, 5, 4]) },
  { points: piece([0, 1, 2]) },
  { points: piece([4, 3, 2]) },
] as const;
/** The seams between them, from the core out past the edge, at the top, lower right and lower left corners. */
const SEAMS = [0, 2, 4].map((c) => [at(CORE - 2, c), at(60, c)]);
/** What lights in the hollow: a little inside it, so a dark ring keeps it apart from the faces. */
const CORE_POINTS = [0, 1, 2, 3, 4, 5].map((c) => at(CORE - 5.5, c)).join(" ");

type Status = "working" | "waiting" | "idle" | "offline" | "limited";

function Block({ fills, size, status, lead, className }: { fills: [string, string, string]; size: number; status?: Status; lead?: boolean; className?: string }) {
  const id = `tb${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg className={className ? `tb ${className}` : "tb"} width={size} height={size} viewBox="0 0 100 100" style={{ width: size, height: size }} data-state={status} data-lead={lead ? "true" : undefined} aria-hidden="true">
      <mask id={id} maskUnits="userSpaceOnUse" x="-10" y="-10" width="120" height="120">
        <rect x="-10" y="-10" width="120" height="120" fill="#fff" />
        {SEAMS.map(([a, b], i) => {
          const [x1, y1] = a!.split(",");
          const [x2, y2] = b!.split(",");
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#000" strokeWidth="5" strokeLinecap="round" />;
        })}
      </mask>
      <g mask={`url(#${id})`}>
        {FACES.map((f, i) => (
          <polygon
            key={i}
            className="tb-face"
            points={f.points}
            style={{ fill: fills[i], stroke: fills[i] }}
          />
        ))}
      </g>
      <polygon className="tb-core" points={CORE_POINTS} />
    </svg>
  );
}

const lit = (c: string) => `color-mix(in oklab, ${c} 70%, white)`;
const shade = (c: string) => `color-mix(in oklab, ${c} 80%, black)`;

/** One teammate's block, lit from the side its seed gives it. The lead's core is solid: the one the others' work comes back to. */
export const TeamBlock = memo(function TeamBlock({ seed, size, status, lead }: { seed: string; size: number; status?: Status; lead?: boolean }) {
  const c = teamColour(seed);
  const turn = (hash(seed || "Friday") >>> 7) % 3;
  const tones = [lit(c), c, shade(c)];
  const fills = [0, 1, 2].map((i) => tones[(i + turn) % 3]!) as [string, string, string];
  return <Block fills={fills} size={size} lead={!!lead} {...(status ? { status } : {})} />;
});

/** A room's mark: Friday's, each face in a member's colour (fewer than three take turns; none, the plain mark). */
export const RoomBlock = memo(function RoomBlock({ seeds, size }: { seeds: string[]; size: number }) {
  const cs = seeds.length ? seeds.map(teamColour) : ["var(--text-muted)"];
  const fills = [0, 1, 2].map((i) => cs[i % cs.length]!) as [string, string, string];
  return <Block fills={fills} size={size} className="tb-room" />;
});
