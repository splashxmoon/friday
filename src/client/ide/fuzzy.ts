/**
 * The subsequence match behind ⌘P and Friday's one search (CodeSearch.tsx), on its own so the search loads it without the rest
 * of util.ts (a chunk shared with the first load: test/client-bundle.test.ts). util.ts does not re-export it (the first load is at its budget): import it from here.
 */

export interface FuzzyHit {
  score: number;
  /** Indexes of the characters of the haystack that matched, for highlighting. */
  at: number[];
}

/**
 * A subsequence match, scored so that what a person means comes first: matches in the file's name beat matches in its folders,
 * starts of words and runs of characters beat scattered ones, shorter paths beat longer.
 */
/** Whether q's letters from `qi` on can still be found, in order, in h from `from`. */
function fitsAfter(h: string, q: string, qi: number, from: number): boolean {
  let at = from;
  for (let i = qi; i < q.length; i++) {
    at = h.indexOf(q[i]!, at);
    if (at < 0) return false;
    at++;
  }
  return true;
}

export function fuzzy(query: string, hay: string): FuzzyHit | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return { score: 0, at: [] };
  const h = hay.toLowerCase();
  const nameStart = hay.lastIndexOf("/") + 1;
  const at: number[] = [];
  let score = 0;
  let from = 0;
  let prev = -2;
  for (let i = 0; i < q.length; i++) {
    let j = h.indexOf(q[i]!, from);
    if (j < 0) return null;
    // Prefer an occurrence that starts a word over an earlier one in the middle of one, when it is close by.
    const boundary = (k: number) => k === 0 || "/_-. ".includes(h[k - 1]!) || (hay[k]! >= "A" && hay[k]! <= "Z" && hay[k - 1]! >= "a" && hay[k - 1]! <= "z");
    if (!boundary(j)) {
      const k = h.indexOf(q[i]!, j + 1);
      // Only when the rest of the query still fits after it: "util" in src/lib/util.ts jumped its t to the one in ".ts", and the i was lost.
      if (k > 0 && k - j < 6 && boundary(k) && (prev < 0 || k - prev < 12) && fitsAfter(h, q, i + 1, k + 1)) j = k;
    }
    at.push(j);
    let s = 1;
    if (j === prev + 1) s += 5;
    if (boundary(j)) s += 4;
    if (j >= nameStart) s += 3;
    score += s;
    prev = j;
    from = j + 1;
  }
  // A query that is a whole stretch of the file's name is the best of all.
  const name = h.slice(nameStart);
  if (name.startsWith(q)) score += 30;
  else if (name.includes(q)) score += 15;
  // Marks show that stretch, not the greedy letters from the left ("search" in src/search.ts marked the s of "src" first).
  const whole = name.indexOf(q);
  if (whole >= 0) at.splice(0, at.length, ...Array.from({ length: q.length }, (_, i) => nameStart + whole + i));
  score -= hay.length * 0.05;
  return { score, at };
}
