import type { DiffLine } from "./DiffView.js";

/**
 * A diff's lines, paired: what each removed line became.
 *
 * Within a change (removed lines followed by the added ones that replace them), the first removed line goes with the first added
 * one, and so on: that is the pairing git's own word diff and every review tool make, and it is right for the common case of a line
 * edited in place. Pairs are what the split view puts side by side, and what the word marks are worked out between.
 */
export type SplitRow = { hunk: DiffLine } | { left?: DiffLine; right?: DiffLine };

export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) rows.push({ ...(removed[i] ? { left: removed[i] } : {}), ...(added[i] ? { right: added[i] } : {}) });
    removed = [];
    added = [];
  };
  for (const l of lines) {
    if (l.type === "removed") {
      // A removal after additions starts a new change.
      if (added.length) flush();
      removed.push(l);
    } else if (l.type === "added") added.push(l);
    else {
      flush();
      if (l.oldLine === undefined && l.newLine === undefined) rows.push({ hunk: l });
      else rows.push({ left: l, right: l });
    }
  }
  flush();
  return rows;
}

const WORD = /\w/;

/**
 * Where a paired line actually changed: the part between what the two have in common at either end, widened to whole words.
 *
 * Marking only that part is what lets a reader see a one-character fix in a long line. A line rewritten from end to end is left
 * unmarked: a mark across nearly all of it says nothing the line's own colour doesn't.
 */
export function changedRange(from: string, to: string): { from: [number, number]; to: [number, number] } | null {
  if (from === to) return null;
  const shortest = Math.min(from.length, to.length);
  let p = 0;
  while (p < shortest && from[p] === to[p]) p++;
  let q = 0;
  while (q < shortest - p && from[from.length - 1 - q] === to[to.length - 1 - q]) q++;
  // Whole words: "count" against "counter" marks the word, not "er".
  while (p > 0 && WORD.test(from[p - 1]!)) p--;
  while (q > 0 && WORD.test(from[from.length - q]!)) q--;
  const a: [number, number] = [p, from.length - q];
  const b: [number, number] = [p, to.length - q];
  const longest = Math.max(from.length, to.length);
  if (Math.max(a[1] - a[0], b[1] - b[0]) > longest * 0.7) return null;
  return { from: a, to: b };
}

/** For each changed line that has a partner, the span of it that changed (see changedRange). */
export function wordMarks(lines: DiffLine[]): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  for (const row of splitRows(lines)) {
    if ("hunk" in row || !row.left || !row.right || row.left === row.right) continue;
    const r = changedRange(row.left.content, row.right.content);
    if (!r) continue;
    out.set(row.left.id, r.from);
    out.set(row.right.id, r.to);
  }
  return out;
}

/** "src/client/App.tsx" as the name a reader looks for and the folder it is in. */
export function splitPath(path: string): { dir: string; name: string } {
  const at = path.lastIndexOf("/");
  return at < 0 ? { dir: "", name: path } : { dir: path.slice(0, at + 1), name: path.slice(at + 1) };
}
