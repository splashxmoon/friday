import type { DiffFile } from "./types.js";

/**
 * The paths a commit of these files names: each file, a renamed one's old path too, and the change set's unshown rest. A file of its
 * own so the commit box (Ship.tsx, ShipFlow.tsx, in the first load) doesn't bring shepherd.ts with it, which the Pull request panel
 * loads (client-bundle.test.ts).
 */
export const commitPaths = (files: DiffFile[], more: string[] = []): string[] => [...files.flatMap((f) => (f.from ? [f.path, f.from] : [f.path])), ...more];
