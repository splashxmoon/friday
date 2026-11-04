/**
 * A teammate's colour from its look (its seed), and a look for a new one in a colour none of the team has: kept apart from
 * drawing them (client/teammate-block.tsx) so the server picks the same when a teammate is made without a look (Arun, 2026-10-28:
 * "really iron out bugs and feature problems and gaps"; Lead and QA, made in a row through the API, came out the same pink).
 *
 */

/**
 * Their colours: eight muted hues, each a face fill that reads on both grounds, and never text, a background or a border (owner
 * call E; Arun, 2026-10-29: "so clean and beautiful really with a clear direction in design language"; DIRECTION.md §2). Muted,
 * so the blue working ring stands out on any of them. Amber, violet, slate, blue, green, coral, teal, rose.
 */
export const TEAM_COLOURS = ["#e3a33c", "#9a7cf0", "#7f8ea6", "#5b8def", "#4fb07f", "#e6735f", "#3eaeae", "#d680b2"];

/**
 * A seed still lands on the slot it had among the ten brighter colours before, and each old colour on the muted hue nearest it,
 * so every teammate keeps its colour family: blue, orange, green, amber, purple, cyan, pink, slate, lime (now green) and red
 * (now coral).
 */
const SLOTS = [3, 5, 4, 0, 1, 6, 7, 2, 4, 5];

const hash = (seed: string) => [...seed].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 2166136261);

/**
 * Eight more, for the looks made since there were more faces to choose from (Arun, 2026-11-03: "add more mascot designs and
 * colors too"): sunflower, sky, lavender, mint, salmon, cocoa, lime and apricot, as muted as the first eight. A look made that way
 * is marked "v2:" (teammate-face.tsx), so every teammate made before keeps the colour it has.
 */
export const MORE_COLOURS = ["#e8c14f", "#78b8ec", "#b6a1e6", "#79c79a", "#f0907e", "#b38b6d", "#a6c25c", "#f1a76c"];
export const ALL_COLOURS = [...TEAM_COLOURS, ...MORE_COLOURS];
/** A look from the second set of faces: more shapes, eyes and colours (teammate-face.tsx lookOf). */
export const isV2 = (seed: string) => seed.startsWith("v2:");

/** A teammate's colour: its mascot, its @name in the box, its name over its words. */
export const teamColour = (seed: string) => (isV2(seed) ? ALL_COLOURS[(hash(seed) >>> 3) % ALL_COLOURS.length]! : TEAM_COLOURS[SLOTS[(hash(seed || "Friday") >>> 3) % SLOTS.length]!]!);

/**
 * A look for a new teammate whose colour none of the team's has, while one is free: `seed` itself when its colour is free, else
 * the first of seed-2, seed-3… that is (2026-10-27 audit: Kit and Pip came out nearly the same purple, and a shuffle landed on a
 * pink beside Nova's). With every colour taken, `seed` as it is.
 */
export function distinctLook(seed: string, taken: readonly string[]): string {
  const used = new Set(taken.map((t) => teamColour(t)));
  if (used.size >= (isV2(seed) ? ALL_COLOURS : TEAM_COLOURS).length || !used.has(teamColour(seed))) return seed;
  for (let n = 2; n < 200; n++) if (!used.has(teamColour(`${seed}-${n}`))) return `${seed}-${n}`;
  return seed;
}
