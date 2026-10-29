/**
 * Who a message names with "@" among the person's teammates (Teammates.tsx), in the order it names them: "@Kit can you…" goes
 * to Kit, "@Kit and @Nova…" to both (Arun, 2026-10-27: "be able to @ the specific agent too in the chat"). Longer names are
 * matched first, so "@Nova Prime" is never read as "@Nova".
 *
 */
export function namedIn(text: string, team: readonly { name: string; lane: string }[]): string[] {
  const named = mentionsIn(text, team).map((m) => m.lane);
  // @everyone is every teammate here, in the order they joined (Arun, 2026-10-27: "add an @everyone command too").
  if (named.includes(EVERYONE)) return [...new Set(team.map((m) => m.lane))];
  return [...new Set(named)];
}

/** The lane an @everyone stands for: all of them. */
export const EVERYONE = "*";

/** Whether a message names @everyone. */
export const namesEveryone = (text: string, team: readonly { name: string; lane: string }[]) => mentionsIn(text, team).some((m) => m.lane === EVERYONE);

/** Each @Name in the text, where it stands (`at`, `end`) and whose lane it is, in order: to draw them in the box. */
export function mentionsIn(text: string, team: readonly { name: string; lane: string }[]): { lane: string; at: number; end: number }[] {
  let rest = text;
  const found: { lane: string; at: number; end: number }[] = [];
  // @everyone, unless a teammate has that name.
  const all = team.some((m) => m.name.toLowerCase() === "everyone") ? [] : [{ name: "everyone", lane: EVERYONE }];
  for (const m of [...team, ...all].sort((a, b) => b.name.length - a.name.length)) {
    const safe = m.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[\\s(\\[{"'])@${safe}(?=$|[\\s.,:;!?'")\\]}/…—–-])`, "gi");
    for (let hit = re.exec(rest); hit; hit = re.exec(rest)) {
      const at = hit.index + hit[1]!.length;
      found.push({ lane: m.lane, at, end: at + m.name.length + 1 });
    }
    // Blanked out, so a shorter name inside one isn't found there again.
    for (const f of found) rest = rest.slice(0, f.at) + " ".repeat(f.end - f.at) + rest.slice(f.end);
  }
  return found.sort((a, b) => a.at - b.at);
}
