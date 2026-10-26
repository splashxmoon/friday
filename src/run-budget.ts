import { shortTokens } from "./tool-usage.js";
import { MAIN_LANE, type SessionEvent } from "./types.js";

/**
 * What a run has spent, and a cap that pauses it.
 *
 * The costly way an agent goes wrong is not one bad answer but a run that never stops: a tool that spawns agents, or one
 * that re-reads a huge context step after step, can spend in an afternoon what a team spends in a month. Friday counts
 * tokens rather than money (most people are on a subscription, and coding tools don't say which model ran), so the cap is
 * in tokens too: a workspace setting, off unless someone turns it on, checked as each turn's usage comes in.
 *
 * Counted as tool-usage.ts counts "spent": what each tool reported reading fresh and writing, without cache reads, which
 * are its own instructions re-read every turn and cheap. Friday's own agent says its tokens on each step.
 */

/** The caps a workspace can pick, in tokens per run. 0 is off. */
export const RUN_CAPS = [0, 500_000, 2_000_000, 10_000_000] as const;

/** Tokens agents on `lane` used in the log between two seqs (inclusive). */
export function tokensUsed(events: SessionEvent[], lane: string, from = 0, to = Infinity): number {
  let used = 0;
  // The log is in seq order: start at the first event at or after `from` (found by halving) and stop past `to`. Every run block
  // in the chat asks this on every new event, and walking the whole log each time grew with runs × events.
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid]!.seq < from) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < events.length; i++) {
    const e = events[i]!;
    if (e.seq > to) break;
    if ((e.lane ?? MAIN_LANE) !== lane) continue;
    const b = e.body;
    if (b.type === "agent.usage") used += b.input + b.output;
    else if (b.type === "agent.message") used += b.tokens ?? 0;
  }
  return used;
}

/** What the run now going on this lane has spent toward the cap: from its start, or from where a person last resumed it. */
export function runSpend(events: SessionEvent[], lane: string): number {
  const from = events.findLast((e) => (e.lane ?? MAIN_LANE) === lane && (e.body.type === "run.started" || e.body.type === "run.resume"))?.seq ?? 0;
  return tokensUsed(events, lane, from);
}

/** What the session says when it pauses a run at the cap. */
export function cappedText(spent: number, cap: number): string {
  return `Stopped: this run has used ${shortTokens(spent)} tokens, past this workspace's cap of ${shortTokens(cap)} a run. Tell it to carry on for up to another ${shortTokens(cap)}, or what to do instead.`;
}
