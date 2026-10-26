/**
 * The order of the "All agents" feed (Arun, 2026-10-24: "say for example two agents are running together, and im on the all
 * agents tab chat thing, i want the agent that is currently working be in my view and move the agent that was just finished
 * like its chat above the agent chat that is still working").
 *
 * The log's own order puts each agent's turn where it started, so the one that started last sat at the bottom even after it
 * had finished, and the agent still working was pushed up out of view. Here a turn (what was asked of an agent, and the block
 * of its work) takes its place when it finished: an agent that has just finished settles above the ones still working, and an
 * agent at work stays at the bottom, in view. Nothing else moves: notes, people joining and the room's chat keep their place.
 */

/** What the order needs to know of one item of the feed. */
export type OrderInfo =
  /** An agent's block of work: when it finished (the seq of its end), or that it is still going. */
  | { kind: "run"; lane: string; ended?: number; live: boolean }
  /** Something asked of an agent: it goes with the run that answers it. */
  | { kind: "ask"; lane: string; seq: number }
  /** Anything else, at its place in the log. */
  | { kind: "other"; seq: number };

/**
 * The items in finishing order: each run at the seq it ended, a run still going after everything, and what was asked of an
 * agent just before the run that took it up (with the agent's working run, when no run has taken it up yet and the agent is
 * at work). Stable: items with the same place keep the log's order. `last` is the seq of a closed run that has no end of its
 * own (closed by a permission card or a message), so it stays where it stood.
 */
export function finishingOrder<T>(items: T[], info: (t: T) => OrderInfo, last: (t: T) => number, working: ReadonlySet<string>): T[] {
  const infos = items.map(info);
  const place = new Array<number>(items.length);
  infos.forEach((x, i) => {
    if (x.kind === "other") place[i] = x.seq;
    else if (x.kind === "run") place[i] = x.ended ?? (x.live ? Infinity : last(items[i]!));
  });
  infos.forEach((x, i) => {
    if (x.kind !== "ask") return;
    // The run of the same agent that came after it, which is the one that took it up.
    const next = infos.findIndex((y, j) => j > i && y.kind === "run" && y.lane === x.lane);
    place[i] = next !== -1 ? place[next]! : working.has(x.lane) ? Infinity : x.seq;
  });
  return items
    .map((it, i) => ({ it, i, at: place[i]! }))
    .sort((a, b) => (a.at === b.at ? a.i - b.i : a.at - b.at))
    .map((x) => x.it);
}

/**
 * The order while someone is reading further up: what they were shown, as it was, with anything new after it. A turn moving
 * above the view while it is being read would pull the words out from under them; it moves once they are back at the bottom.
 */
export function heldOrder<K>(shown: readonly K[], next: readonly K[]): K[] {
  const now = new Set(next);
  const had = new Set(shown);
  return [...shown.filter((k) => now.has(k)), ...next.filter((k) => !had.has(k))];
}
