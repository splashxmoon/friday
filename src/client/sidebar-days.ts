/**
 * A long Recent list told by day, as Synara and T3 Code tell theirs (Arun, 2026-10-27: "take some inspo from like t3, synara,
 * orca"): Today, Yesterday, This week, Earlier, each said once above its first session. Only when the list runs newest first and
 * spans more than one of them; a list with what needs you pulled to the top keeps that order and goes unlabelled.
 */
export function byDay<T extends { openedAt: number }>(rows: T[], now: number): (T | string)[] {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  const day = 86_400_000;
  const label = (at: number) => (at >= today ? "Today" : at >= today - day ? "Yesterday" : at >= today - 6 * day ? "This week" : "Earlier");
  const ordered = rows.every((r, i) => i === 0 || rows[i - 1]!.openedAt >= r.openedAt);
  if (!ordered || new Set(rows.map((r) => label(r.openedAt))).size < 2) return rows;
  const out: (T | string)[] = [];
  let last = "";
  for (const r of rows) {
    const l = label(r.openedAt);
    if (l !== last) out.push((last = l));
    out.push(r);
  }
  return out;
}
