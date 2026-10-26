import type { SessionState } from "./session/projection.js";

/**
 * Who a message @-mentions: the people in the session it names after an "@", by their full name or, when nobody else here
 * shares it, their first name ("@Maya" or "@Maya Chen"). Never the writer, never someone removed, never an agent: an agent is
 * written to by choosing it, so "@Claude" in a message is just text.
 */
export function mentionsIn(text: string, state: SessionState, writer: string): string[] {
  if (!text.includes("@")) return [];
  const lower = text.toLowerCase();
  const people = Object.entries(state.members).filter(([id, m]) => !m.removed && id !== writer);
  const firsts = new Map<string, number>();
  for (const [, m] of Object.entries(state.members)) {
    const f = m.name.trim().split(/\s+/)[0]?.toLowerCase();
    if (f) firsts.set(f, (firsts.get(f) ?? 0) + 1);
  }
  const named = (name: string) => {
    const at = lower.indexOf(`@${name}`);
    if (at < 0) return false;
    // The name ends where a word would: "@Maya," and "@Maya" count, "@Mayan" doesn't.
    const next = lower[at + 1 + name.length];
    return next === undefined || !/[\p{L}\p{N}_]/u.test(next);
  };
  const out: string[] = [];
  for (const [id, m] of people) {
    const full = m.name.trim().toLowerCase();
    const first = full.split(/\s+/)[0] ?? "";
    if ((full && named(full)) || (first && firsts.get(first) === 1 && named(first))) out.push(id);
  }
  return out;
}
