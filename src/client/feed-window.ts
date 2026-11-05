/**
 * Opens the chat back to a point in the log (Activity's feed draws its newest FEED_WINDOW items; "friday:feed-from" draws back
 * from an older one), for a view outside the feed that is about to look for that point's row: search, the team brief, the
 * subagents list. Activity's own jumpTo does the same and jumps once the row is drawn.
 */
export function revealSeq(seq: number): void {
  if (typeof dispatchEvent === "function") dispatchEvent(new CustomEvent("friday:feed-from", { detail: seq }));
}
