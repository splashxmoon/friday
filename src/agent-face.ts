import type { SessionState } from "./session/projection.js";
import { MAIN_LANE } from "./types.js";

/**
 * Each of Friday's own agents in a session wears a face of its own (audit B-20: Friday Code and Juno had the same face, so which
 * one had spoken was in the name alone). A face is one of the mascot's bodies in a colour of its own, picked from the agent's lane
 * the same way on every page and the server alike, so the same agent looks the same in the header, the feed, the sidebar and the
 * roster, and no two agents in a session share one while there are faces to go round.
 */
export type FaceKind = "sprout" | "bot" | "ghost" | "cat";
export interface Face {
  kind: FaceKind;
  /** The body's colour. */
  hue: string;
  /** The same colour, deeper: the agent's tint wherever it is coloured (its tab, its chips), readable on either theme. */
  tint: string;
}

/** The session's own agent keeps Friday's look; the others take the next free one, in this order. */
export const FACES: readonly Face[] = [
  { kind: "sprout", hue: "#8d9cff", tint: "#7c5cff" },
  { kind: "cat", hue: "#ffb886", tint: "#e07a2f" },
  { kind: "bot", hue: "#8fe3cf", tint: "#14a394" },
  { kind: "ghost", hue: "#d9ccff", tint: "#9b7bf0" },
  { kind: "sprout", hue: "#f2c46b", tint: "#c98a12" },
  { kind: "cat", hue: "#f9a8d4", tint: "#db4b98" },
  { kind: "bot", hue: "#9cc8ff", tint: "#3b7ff0" },
  { kind: "ghost", hue: "#b8f0c8", tint: "#2fa85a" },
];

/** A lane id to a number, the same everywhere (FNV-1a). */
function hash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/**
 * Which face the agent on `lane` wears: the main lane Friday's own, every other lane the face its id picks, moved on to the next
 * free one when an agent added before it already wears that one. Only the lanes added before it count, so an agent keeps its face
 * when others come after it.
 */
export function faceIndex(state: Pick<SessionState, "lanes">, lane: string): number {
  if (lane === MAIN_LANE) return 0;
  const taken = new Set<number>([0]);
  for (const l of state.lanes) {
    const free = FACES.length - taken.size;
    let at = hash(l.id) % FACES.length;
    if (free > 0) while (taken.has(at)) at = (at + 1) % FACES.length;
    if (l.id === lane) return at;
    taken.add(at);
  }
  return hash(lane) % FACES.length || 1;
}

export const faceOf = (state: Pick<SessionState, "lanes">, lane: string): Face => FACES[faceIndex(state, lane)]!;
