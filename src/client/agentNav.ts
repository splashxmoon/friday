import { MAIN_LANE, type SessionEvent } from "../types.js";

/**
 * Getting around several agents in one session (Arun, 2026-10-18: "it feels like a chore to keep track of everything"),
 * the parts that are only arithmetic: how much of each agent's work this person hasn't seen, where that starts, which
 * agents a split chat shows, and the agent in the address. Kept apart from the page so they can be tested on their own;
 * agentFocus.ts holds the state and the views call these.
 */

export const ALL = "all";

/** What a rail chip carries when it is dragged onto the chat to open beside it. */
export const AGENT_DRAG = "application/x-friday-agent";

/** Work worth a count on an agent's tab: something it said, or a run that finished. Its steps alone are not. */
const counts = (e: SessionEvent) => (e.body.type === "agent.message" && !!e.body.text.trim()) || e.body.type === "run.ended";

/**
 * Per agent, how many things it said or finished since this person last looked: after their seen mark for it, or, for an
 * agent they have not looked at on this page, after the point the page opened at. Their own doings never count.
 */
export function unreadByLane(events: SessionEvent[], seen: Record<string, number>, openSeq: number, me: string): Record<string, number> {
  const out: Record<string, number> = {};
  const from = (l: string) => seen[l] ?? openSeq;
  const floor = Math.min(openSeq, ...Object.values(seen));
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.seq <= floor) break;
    const l = e.lane ?? MAIN_LANE;
    if (e.seq <= from(l) || e.actor.id === me) continue;
    if (counts(e)) out[l] = (out[l] ?? 0) + 1;
  }
  return out;
}

/** The first thing of `lane`'s that this person hasn't seen: the one its catch-up opens at. */
export function firstUnread(events: SessionEvent[], lane: string, after: number, me: string): number | null {
  for (const e of events) {
    if (e.seq <= after || (e.lane ?? MAIN_LANE) !== lane || e.actor.id === me) continue;
    if (counts(e)) return e.seq;
  }
  return null;
}

/**
 * Which item of the feed the "New since you looked" line goes over: the first of that agent's that holds the unread
 * thing or comes after it. A run block holds many events, so it is the block's last one that is compared: a run that
 * started before you looked and answered after is where the new part starts.
 */
export function catchUpIndex(items: { lane: string; last: number }[], lane: string, seq: number): number {
  return items.findIndex((it) => it.lane === lane && it.last >= seq);
}

// ── split columns ──────────────────────────────────────────────────────

/** How many chats fit side by side: three on a wide screen, two on a laptop, one below that. */
export function maxColumns(width: number): number {
  return width >= 1500 ? 3 : width >= 1100 ? 2 : 1;
}

/**
 * An agent dropped on the chat: it opens beside the one in view. Dropped on a column (`at`), it goes just after that
 * column while there is room, and takes that column's place when there isn't. An agent already showing stays where it is.
 * `current` is the agent in view, or ALL for the overview, where the first agent other than the dropped one is used.
 */
export function dropAgent(cols: string[] | null, o: { lane: string; current: string; everyone: string[]; max: number; at?: number }): string[] | null {
  if (o.max < 2) return cols;
  if (!cols || cols.length < 2) {
    const beside = o.current !== ALL && o.current !== o.lane && o.everyone.includes(o.current) ? o.current : o.everyone.find((id) => id !== o.lane);
    return beside ? [beside, o.lane] : cols;
  }
  if (cols.includes(o.lane)) return cols;
  const at = o.at !== undefined && o.at >= 0 && o.at < cols.length ? o.at : cols.length - 1;
  if (cols.length < o.max) return [...cols.slice(0, at + 1), o.lane, ...cols.slice(at + 1)];
  return cols.map((c, i) => (i === at ? o.lane : c));
}

/** A column's agent changed from its header: one already in another column swaps places with it, so none shows twice. */
export function pickInColumn(cols: string[], at: number, lane: string): string[] {
  const out = [...cols];
  const was = out.indexOf(lane);
  if (was === at) return cols;
  if (was !== -1) out[was] = out[at]!;
  out[at] = lane;
  return out;
}

/** A column closed: one left is no split at all. */
export function closeColumn(cols: string[], at: number): string[] | null {
  const out = cols.filter((_, i) => i !== at);
  return out.length >= 2 ? out : null;
}

/**
 * The window narrowed: as many columns as still fit, keeping the one in view. Agents that have left go too.
 */
export function fitColumns(cols: string[] | null, max: number, keep: string, here: string[]): string[] | null {
  if (!cols) return null;
  let out = cols.filter((c) => here.includes(c));
  while (out.length > max) {
    const drop = out.findLastIndex((c) => c !== keep);
    out = out.filter((_, i) => i !== drop);
  }
  return out.length >= 2 ? out : null;
}

/**
 * Dragging the grip between columns `i` and `i + 1` to `x` (a percentage of the row): only those two change, and neither
 * gets narrower than `min` percent.
 */
export function resizeAt(widths: number[], i: number, x: number, min = 20): number[] {
  const start = widths.slice(0, i).reduce((a, b) => a + b, 0);
  const end = start + widths[i]! + widths[i + 1]!;
  const edge = Math.min(end - min, Math.max(start + min, x));
  const out = [...widths];
  out[i] = edge - start;
  out[i + 1] = end - edge;
  return out;
}

export const evenWidths = (n: number) => Array.from({ length: n }, () => 100 / n);

// ── the agent in the address ───────────────────────────────────────────

/** The agent a link names (`?agent=`), when it is a link to this session. */
export function agentInSearch(search: string, sid: string): string | null {
  const q = new URLSearchParams(search);
  return q.get("session") === sid ? q.get("agent") || null : null;
}

/**
 * The address with the agent in view in it, so a reload or a link sent to someone opens on that agent. Everything else
 * in it (the session, the invite) is left as it was; the overview needs no word. Null when the address is not this
 * session's, which is left alone.
 */
export function searchWithAgent(search: string, sid: string, lane: string): string | null {
  const q = new URLSearchParams(search);
  if (q.get("session") !== sid) return null;
  if (lane === ALL) q.delete("agent");
  else q.set("agent", lane);
  const s = q.toString();
  return s ? `?${s}` : "";
}
