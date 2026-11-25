/**
 * Asked from outside a session, done inside it: the Agent Board's Commit and Review on a ready card (Arun, 2026-11-21, the board's
 * cards with their one action). The commit is the session's own (its dialog drafts the message and shows the files), so the board
 * asks here and opens the session; that lane's newest changes card (RunReview.tsx ReviewCard) takes the ask once it is drawn.
 * Kept a minute, for a session that takes a moment to load. Code Review's Push & open PR, with no GitHub on the page, asks "pr":
 * the same commit dialog, opened at Push and open PR.
 */
export type CardAsk = "commit" | "review" | "pr";

let asked: { sid: string; lane: string; what: CardAsk; at: number } | null = null;
export const CARD_ASK = "friday:card-ask";

export function askCard(sid: string, lane: string, what: CardAsk): void {
  asked = { sid, lane, what, at: Date.now() };
  dispatchEvent(new Event(CARD_ASK));
}

/** The ask for this session's lane, once: taken, it is gone. */
export function takeCardAsk(sid: string, lane: string): CardAsk | null {
  if (!asked || asked.sid !== sid || asked.lane !== lane || Date.now() - asked.at > 60_000) return null;
  const what = asked.what;
  asked = null;
  return what;
}
