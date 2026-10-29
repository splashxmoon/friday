/**
 * A teammate's face as plain initials: its round blob in its colour with one or two letters, the size of its face (Arun,
 * 2026-10-28, for the website's pictures of Crew). Chosen on this computer with `localStorage["friday.faces"] = "initials"`,
 * read once a load.
 *
 */
import { BlobFace } from "./teammate-face.js";

const KEY = "friday.faces";
let read: boolean | null = null;

/** Whether faces are drawn as initials on this computer (eyes otherwise). */
export function initialsFaces(): boolean {
  if (read !== null) return read;
  try {
    read = localStorage.getItem(KEY) === "initials";
  } catch {
    read = false;
  }
  return read;
}

/** A look is its teammate's name, or that name with a shuffle's "-2" or "-k3x9q" after it (Teammates.tsx distinctLook). */
const nameOf = (seed: string) => seed.replace(/(-[a-z0-9]{1,5})+$/, "").trim() || "Friday";

/** "Nova" N, "Ada Park" AP. */
export function initialsOf(seed: string): string {
  const words = nameOf(seed).split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0]!, words[1]!].map((w) => [...w][0]) : [[...words[0]!][0]];
  return letters.join("").toUpperCase();
}

/**
 * In a box of `size`: the teammate's own round blob (teammate-face.tsx) with its letters on it, no longer a rounded square (Arun,
 * 2026-10-29: "those avatars should be purely circle based with different morphed shapes").
 */
export function Initials({ seed, size }: { seed: string; size: number }) {
  return <BlobFace seed={seed} size={size} letters={initialsOf(seed)} />;
}
