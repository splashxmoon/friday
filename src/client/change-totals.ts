import type { SessionState } from "../session/projection.js";
import type { DiffFile } from "../types.js";

/**
 * Every agent's changes together, each file once by the folder it is in, with who changed it: the one count the status bar, the
 * side panel's badge and the Changes panel's Everyone all say (2026-11-09 audit C-9: 16, 17, 22 and 23 for the same changes, when
 * two agents changed one file). The first agent's version of a shared file is the one counted.
 */
export function changeTotals(state: SessionState, ids = Object.keys(state.diffs)): { files: DiffFile[]; who: Map<string, string[]>; adds: number; dels: number } {
  const seen = new Map<string, DiffFile>();
  const who = new Map<string, string[]>();
  for (const id of ids) {
    const en = state.engines[id];
    for (const f of state.diffs[id]?.files ?? []) {
      const folder = f.repo ?? en?.root ?? en?.cwd ?? "";
      const k = `${folder}\0${f.path}`;
      if (!seen.has(k)) seen.set(k, { ...f, repo: folder });
      const w = who.get(folder) ?? [];
      if (!w.includes(id)) who.set(folder, [...w, id]);
    }
  }
  const files = [...seen.values()];
  return { files, who, adds: files.reduce((n, f) => n + f.additions, 0), dels: files.reduce((n, f) => n + f.deletions, 0) };
}
