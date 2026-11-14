/**
 * "@Rex review this diff" in a session's box (Code and Crew, connected, 2026-11-13: "'@Rex review this diff' works in the box like
 * it would in a channel"): an agent of the session named at the start, then a space or a comma, is that agent's lane, and the words
 * after it are for it. The box turns to it as you type (Activity.tsx Composer, as the lanes' own box always did), so what you write
 * reaches it as the box would for it: an instruction when you may drive it, else a suggestion to whoever does. Only at the start,
 * so a name said in passing ("as @Rex said") goes where the box points. The longest name wins ("Claude Code 2" over "Claude
 * Code"), case aside, and a name has to end there: "@Rexford" isn't Rex, and "@Rex" alone isn't yet.
 */
export function laneAt(text: string, lanes: readonly { id: string; name: string }[]): { lane: string; text: string } | null {
  const t = text.trimStart();
  if (!t.startsWith("@")) return null;
  const byLength = lanes.filter((l) => l.name.trim()).sort((a, b) => b.name.trim().length - a.name.trim().length);
  for (const l of byLength) {
    const n = l.name.trim();
    if (t.slice(1, 1 + n.length).toLowerCase() !== n.toLowerCase()) continue;
    const after = t.slice(1 + n.length);
    if (!/^[\s,:;]/.test(after)) continue;
    return { lane: l.id, text: after.replace(/^[\s,:;]+/, "") };
  }
  return null;
}
