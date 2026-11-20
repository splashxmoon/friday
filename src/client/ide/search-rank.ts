import { fuzzy } from "./fuzzy.js";

/**
 * One search for Code (Arun, 2026-11-20: "One search: the window bar's search finds files and symbols in the IDE's folder AND Code
 * chats AND Agents sessions, in one list"). The ranking and merging, pure: CodeSearch.tsx gives it what the page knows and draws
 * what comes back. Files are matched the way the IDE's own quick open does (util.ts fuzzy), chats and sessions by every word of
 * the query being in the title.
 */

export interface SearchChat { sid: string; title: string; folder: string; at: number }
export interface SearchSession { sid: string; title: string; at: number }
/** What the server's message search found in a session (GET /api/sessions/search): the first snippet is shown under it. */
export interface SearchFound { sid: string; title: string; at: number; snippet?: string; who?: string; titleMatch?: boolean; invite?: string }

export type SearchRow =
  | { kind: "file"; key: string; path: string; name: string; dir: string; line?: number; marks: number[] }
  | { kind: "chat"; key: string; sid: string; title: string; folder: string; here: boolean; at: number; snippet?: string }
  | { kind: "session"; key: string; sid: string; title: string; at: number; snippet?: string; invite?: string }
  | { kind: "symbols" | "text"; key: string; query: string };

export interface SearchGroup { id: "files" | "chats" | "sessions" | "ide"; label: string; rows: SearchRow[] }

/** "src/app.ts:42" is the file and the line. */
export function splitLine(q: string): { q: string; line?: number } {
  const m = /^(.*?[^\s:]):(\d{1,7})$/.exec(q);
  return m ? { q: m[1]!, line: Number(m[2]) } : { q };
}

/** The best `limit` files for the query, best first. Only a file with every letter in order is a match (util.ts fuzzy). */
export function rankFiles(files: readonly string[], query: string, limit = 8): SearchRow[] {
  // A path typed the Windows way ("src\\app.ts"): the listing is slashes.
  const { q, line } = splitLine(query.trim().replace(/\\/g, "/"));
  if (!q) return [];
  // The top few kept as they come: one pass, no sort of everything found (a 20 000 file folder answers in a few milliseconds).
  const top: { path: string; score: number; at: number[] }[] = [];
  let floor = -Infinity;
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    const h = fuzzy(q, f);
    if (!h || (top.length >= limit && h.score <= floor)) continue;
    let j = top.length;
    while (j > 0 && top[j - 1]!.score < h.score) j--;
    top.splice(j, 0, { path: f, score: h.score, at: h.at });
    if (top.length > limit) top.pop();
    if (top.length >= limit) floor = top[top.length - 1]!.score;
  }
  return top.map((t) => {
    const cut = t.path.lastIndexOf("/") + 1;
    return { kind: "file", key: `f:${t.path}`, path: t.path, name: t.path.slice(cut), dir: cut ? t.path.slice(0, cut - 1) : "", ...(line ? { line } : {}), marks: t.at };
  });
}

const words = (q: string) => q.toLowerCase().replace(/"/g, "").split(/\s+/).filter(Boolean);
const has = (title: string, terms: string[]) => {
  const low = title.toLowerCase();
  return terms.every((t) => low.includes(t));
};

/** Code chats whose title has every word: this folder's first, then newest. With no words, this folder's newest. */
export function rankChats(chats: readonly SearchChat[], query: string, folder: string | null, same: (a: string, b: string) => boolean, limit = 5): SearchRow[] {
  const terms = words(query);
  return chats
    .filter((c) => (terms.length ? has(c.title, terms) : !!folder && same(c.folder, folder)))
    .map((c) => ({ c, here: !!folder && same(c.folder, folder) }))
    .sort((a, b) => Number(b.here) - Number(a.here) || b.c.at - a.c.at)
    .slice(0, limit)
    .map(({ c, here }) => ({ kind: "chat", key: `c:${c.sid}`, sid: c.sid, title: c.title || "Untitled chat", folder: c.folder, here, at: c.at }));
}

/** Agents sessions: the title (or the name given to it) has every word; then what the server found said in them. Each once. */
export function rankSessions(sessions: readonly SearchSession[], found: readonly SearchFound[], query: string, skip: ReadonlySet<string>, limit = 6): SearchRow[] {
  const terms = words(query);
  const out: SearchRow[] = [];
  const seen = new Set<string>(skip);
  const byFound = new Map(found.map((f) => [f.sid, f]));
  for (const s of [...sessions].sort((a, b) => b.at - a.at)) {
    if (seen.has(s.sid) || (terms.length && !has(s.title, terms))) continue;
    seen.add(s.sid);
    const f = byFound.get(s.sid);
    out.push({ kind: "session", key: `s:${s.sid}`, sid: s.sid, title: s.title || "Untitled session", at: s.at, ...(f?.snippet ? { snippet: snippetOf(f) } : {}) });
  }
  for (const f of found) {
    if (seen.has(f.sid)) continue;
    seen.add(f.sid);
    out.push({ kind: "session", key: `s:${f.sid}`, sid: f.sid, title: f.title || "Untitled session", at: f.at, ...(f.snippet ? { snippet: snippetOf(f) } : {}), ...(f.invite ? { invite: f.invite } : {}) });
  }
  return out.slice(0, limit);
}
const snippetOf = (f: SearchFound) => (f.who ? `${f.who}: ` : "") + (f.snippet ?? "");

export interface MergeInput {
  query: string;
  files: readonly string[];
  chats: readonly SearchChat[];
  sessions: readonly SearchSession[];
  found?: readonly SearchFound[];
  /** The IDE is up: its own searches can be handed the words. Default yes. */
  ide?: boolean;
  folder: string | null;
  same: (a: string, b: string) => boolean;
}

/**
 * The one list, in order: files, Code chats, Agents sessions, then the two hand-offs to the IDE's own searches (always last, and
 * only once there is something typed). Before anything is typed: this folder's chats and the latest sessions to go back to.
 */
export function mergeSearch(i: MergeInput): SearchGroup[] {
  const query = i.query.trim();
  const groups: SearchGroup[] = [];
  const add = (g: SearchGroup) => void (g.rows.length && groups.push(g));
  const chatSids = new Set(i.chats.map((c) => c.sid));
  // What the server found in a Code chat is the chat's, not Agents'.
  const foundChats = (i.found ?? []).filter((f) => chatSids.has(f.sid));
  const chats = rankChats(i.chats, query, i.folder, i.same, query ? 5 : 4);
  const shown = new Set(chats.map((c) => (c as { sid: string }).sid));
  // A chat matched only by what was said in it comes after the ones matched by title.
  if (query) {
    const byId = new Map(i.chats.map((c) => [c.sid, c]));
    for (const f of foundChats) {
      const c = byId.get(f.sid);
      if (!c || shown.has(c.sid) || chats.length >= 5) continue;
      shown.add(c.sid);
      chats.push({ kind: "chat", key: `c:${c.sid}`, sid: c.sid, title: c.title || "Untitled chat", folder: c.folder, here: !!i.folder && i.same(c.folder, i.folder), at: c.at, ...(f.snippet ? { snippet: snippetOf(f) } : {}) });
    }
  }
  const sessions = rankSessions(i.sessions, (i.found ?? []).filter((f) => !chatSids.has(f.sid)), query, chatSids, query ? 6 : 4);
  if (query) add({ id: "files", label: "Files", rows: rankFiles(i.files, query) });
  add({ id: "chats", label: "Code chats", rows: chats });
  add({ id: "sessions", label: "Agents sessions", rows: sessions });
  if (query && i.ide !== false) {
    const { q } = splitLine(query);
    add({ id: "ide", label: "In the IDE", rows: [{ kind: "symbols", key: "ide:symbols", query: q }, { kind: "text", key: "ide:text", query }] });
  }
  return groups;
}

/** The rows in the order the arrow keys walk them. */
export const flatRows = (groups: readonly SearchGroup[]): SearchRow[] => groups.flatMap((g) => g.rows);

/**
 * What the server found, as shown for the words typed now: hits found for other words are dropped (they linger while the new
 * ones are on the way), and a chat taken off Code's history, which is still Code's (code-chats.ts), is not offered as an Agents session.
 */
export function foundNow(kept: { q: string; rows: readonly SearchFound[] }, query: string, chats: readonly SearchChat[], isCodeChat: (sid: string) => boolean): SearchFound[] {
  if (kept.q !== query) return [];
  return kept.rows.filter((f) => !isCodeChat(f.sid) || chats.some((c) => c.sid === f.sid));
}
