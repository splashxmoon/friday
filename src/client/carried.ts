/**
 * Lanes opened by switching tools, and the lane each took over from.
 *
 * Switching from Codex to Kiro in the message box opens Kiro on a lane of its own (Codex's work and conversation stay where
 * they were), and the first thing said to Kiro there goes as a handoff from Codex, so it starts with everything Codex did
 * (handoffBrief) instead of from nothing. Kept for this tab only: by the time anyone reloads, that first message is long sent.
 */
const from = new Map<string, { fromLane: string; fromName: string }>();
const key = (sid: string, lane: string) => `${sid}|${lane}`;

export function carryInto(sid: string, lane: string, fromLane: string, fromName: string): void {
  from.set(key(sid, lane), { fromLane, fromName });
}

/** The lane this one took over from, while its first message is still to be sent. */
export function carriedFrom(sid: string, lane: string): { fromLane: string; fromName: string } | undefined {
  return from.get(key(sid, lane));
}

export function carried(sid: string, lane: string): void {
  from.delete(key(sid, lane));
}
