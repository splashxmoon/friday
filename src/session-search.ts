import { MAIN_LANE, type SessionEvent } from "./types.js";

/**
 * Finding a session by what was said in it, not only by its title.
 *
 * The sidebar searched titles, and a title is the first line somebody typed: the session where the login bug was found is
 * called "tidy up the auth code". This reads what people asked, what the agents answered, suggestions and review comments,
 * and returns where each match is, so a press opens the session at that message.
 *
 * Every word, in any order; "quoted words" as a phrase. Narrowed by who said it, what kind of message it is, and how
 * recently; ranked by how well and how recently it matches, or by time alone.
 */

export interface SearchHit {
  seq: number;
  at: number;
  /** Who said it: a person's name, or the agent's. */
  who: string;
  /** Who it was, as the filter sees it. */
  by: "me" | "people" | "agents";
  /** What kind of message: something asked or suggested, an agent's answer, a comment on a line. */
  kind: "asked" | "answer" | "comment";
  /** The words around the match, on one line. */
  snippet: string;
  /** Where each searched term appears inside the snippet, in order, for marking. */
  marks: [number, number][];
  score: number;
}

export interface SearchFilters {
  from?: "any" | "me" | "people" | "agents";
  kind?: "any" | "asked" | "answer" | "comment";
  /** Only what was said at or after this time (ms). */
  since?: number;
  /** Who is searching, for "me". */
  me?: string;
  /** An agent's name by its lane, as the session shows it: a coding tool's messages carry its host's name. */
  agentName?: (lane: string) => string;
}

/** The terms of a query: each "quoted phrase" whole, and every other word of two letters or more. */
export function termsOf(q: string): string[] {
  const out: string[] = [];
  const rest = q.toLowerCase().replace(/"([^"]+)"/g, (_, p: string) => {
    const phrase = p.replace(/\s+/g, " ").trim();
    if (phrase.length >= 2 && !out.includes(phrase)) out.push(phrase);
    return " ";
  });
  for (const w of rest.split(/\s+/)) if (w.length >= 2 && !out.includes(w)) out.push(w);
  return out.slice(0, 8);
}

/** Kept for callers that only want the terms. */
export const wordsOf = termsOf;

type Said = { text: string; kind: SearchHit["kind"] };
const saidIn = (e: SessionEvent): Said | null => {
  const b = e.body;
  if (b.type === "instruction" || b.type === "suggestion") return { text: b.text, kind: "asked" };
  if (b.type === "agent.message") return { text: b.text, kind: "answer" };
  if (b.type === "thread.opened") return { text: b.text, kind: "comment" };
  return null;
};

const byOf = (e: SessionEvent, me?: string): SearchHit["by"] => (e.actor.kind === "human" ? (me && e.actor.id === me ? "me" : "people") : "agents");

/** The words around where the first of them is found, squeezed onto one line, about `width` characters long. */
export function snippetOf(text: string, words: string[], width = 160): { snippet: string; marks: [number, number][] } {
  // Read as words: a table's bars, headings' hashes, emphasis and code ticks are markup, not what was said.
  const flat = text.replace(/```[\s\S]*?```/g, " ").replace(/[|*#`>_~]+/g, " ").replace(/-{3,}|={3,}/g, " ").replace(/\s+/g, " ").trim();
  const low = flat.toLowerCase();
  let at = -1;
  let len = 0;
  for (const w of words) {
    const i = low.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) [at, len] = [i, w.length];
  }
  if (at < 0) return { snippet: flat.slice(0, width), marks: [] };
  const start = Math.max(0, Math.min(at - Math.floor((width - len) / 3), flat.length - width));
  const lead = start > 0 ? "…" : "";
  const body = flat.slice(start, start + width);
  const tail = start + width < flat.length ? "…" : "";
  const snippet = `${lead}${body}${tail}`;
  return { snippet, marks: marksIn(snippet, words) };
}

/** Every place any of the words appears in a piece of text, without overlaps, in order. */
export function marksIn(text: string, words: string[]): [number, number][] {
  const low = text.toLowerCase();
  const found: [number, number][] = [];
  for (const w of words) for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + w.length)) found.push([i, i + w.length]);
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const out: [number, number][] = [];
  for (const m of found) if (!out.length || m[0] >= out.at(-1)![1]) out.push(m);
  return out;
}

/**
 * How well a text matches, or 0 when a term is missing: each term counts for being there and a little for each time
 * again, a whole word more than a piece of one, a phrase more than a word, and a short message that is mostly the match
 * beats a long one that mentions it.
 */
export function scoreOf(text: string, terms: string[]): number {
  const low = text.toLowerCase();
  let score = 0;
  for (const t of terms) {
    let n = 0;
    let whole = false;
    for (let i = low.indexOf(t); i >= 0 && n < 10; i = low.indexOf(t, i + t.length), n++) {
      if (!whole && !/\w/.test(low[i - 1] ?? "") && !/\w/.test(low[i + t.length] ?? "")) whole = true;
    }
    if (!n) return 0;
    score += 10 + Math.min(n - 1, 5) + (whole ? 4 : 0) + (t.includes(" ") ? 6 : 0);
  }
  return score + Math.max(0, 6 - Math.floor(low.length / 400));
}

/** The messages in one session that hold every term, best first, at most `limit`, reading at most the last `scan` events. */
export function searchEvents(events: SessionEvent[], q: string, limit = 3, scan = Infinity, f: SearchFilters = {}): SearchHit[] {
  const terms = termsOf(q);
  if (!terms.length) return [];
  const hits: SearchHit[] = [];
  const stop = Math.max(0, events.length - scan);
  for (let i = events.length - 1; i >= stop; i--) {
    const e = events[i]!;
    if (f.since && e.ts < f.since) break;
    const said = saidIn(e);
    if (!said) continue;
    if (f.kind && f.kind !== "any" && said.kind !== f.kind) continue;
    const by = byOf(e, f.me);
    if (f.from && f.from !== "any" && by !== f.from) continue;
    const score = scoreOf(said.text, terms);
    if (!score) continue;
    const who = by === "agents" && f.agentName ? f.agentName(e.lane ?? MAIN_LANE) : e.actor.name;
    hits.push({ seq: e.seq, at: e.ts, who, by, kind: said.kind, ...snippetOf(said.text, terms), score });
  }
  return hits.sort((a, b) => b.score - a.score || b.at - a.at).slice(0, limit);
}

/** Whether a session's title holds every term. */
export function titleMatches(title: string, q: string): boolean {
  const terms = termsOf(q);
  const low = title.toLowerCase();
  return terms.length > 0 && terms.every((t) => low.includes(t));
}

/** One session's place in the results: its best message, lifted when the title matches too, and a little for being recent. */
export function rankOf(r: { titleMatch: boolean; hits: SearchHit[]; at: number }, now = Date.now()): number {
  const best = r.hits[0]?.score ?? 0;
  const days = Math.max(0, (now - r.at) / 86_400_000);
  return best + (r.titleMatch ? 25 : 0) + Math.max(0, 10 - days / 3);
}
