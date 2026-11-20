/**
 * The files the IDE holds unsaved edits in, as its extension last said (Arun, 2026-11-19, wave 4: "Rewind an agent run… if the person
 * has unsaved edits in a file the rewind touches, say so in the confirm and keep their buffer"). A rewind changes files on disk; the
 * IDE keeps a dirty buffer as it is and asks before an overwrite, so nothing is lost, but the person should hear it first.
 *
 * The extension posts the list when it changes, and again every few seconds while it isn't empty; one that stops saying is stale and
 * counts as empty (a closed window can't clear its own list). Each window (its `root`) has its own list, so two windows don't overwrite
 * each other's.
 */
export interface DirtyFiles {
  root: string;
  /** Relative to `root`, with forward slashes. */
  paths: string[];
  /** The same files as absolute paths with forward slashes, which is what the page matches on (it knows other folders' roots, not this one's). */
  files: string[];
  at: number;
}

/** Longer than the extension's heartbeat, which is every 15 seconds. */
export const DIRTY_FRESH_MS = 45_000;

export function readDirty(body: Record<string, unknown>, now: number): DirtyFiles {
  const paths = Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === "string" && !!p).map((p) => p.slice(0, 1000)) : [];
  const files = Array.isArray(body.files) ? body.files.filter((p): p is string => typeof p === "string" && !!p).map((p) => p.slice(0, 2000)) : [];
  return { root: typeof body.root === "string" ? body.root.slice(0, 4000) : "", paths: [...new Set(paths)].slice(0, 200), files: [...new Set(files)].slice(0, 200), at: now };
}

/** Each window's list, by its root: a new one replaces that window's last, an empty one is forgotten, and the stale are dropped. */
export function rememberDirty(all: Map<string, DirtyFiles>, d: DirtyFiles, now: number): void {
  for (const [k, v] of all) if (now - v.at >= DIRTY_FRESH_MS) all.delete(k);
  if (d.paths.length || d.files.length) all.set(d.root, d);
  else all.delete(d.root);
}

/** What is unsaved in every window that is still talking: the files as absolute paths, and each window's own list. */
export function freshAllDirty(all: Map<string, DirtyFiles>, now: number): { root: string; paths: string[]; files: string[]; windows: { root: string; paths: string[] }[] } {
  const live = [...all.values()].filter((d) => now - d.at < DIRTY_FRESH_MS);
  return { root: live[0]?.root ?? "", paths: live[0]?.paths ?? [], files: [...new Set(live.flatMap((d) => d.files))], windows: live.map((d) => ({ root: d.root, paths: d.paths })) };
}

/** What is unsaved now: nothing when the extension has gone quiet. */
export function freshDirty(d: DirtyFiles | null, now: number): { root: string; paths: string[] } {
  return d && now - d.at < DIRTY_FRESH_MS ? { root: d.root, paths: d.paths } : { root: "", paths: [] };
}
