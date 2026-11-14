/**
 * The one sentence a usage limit is said in, in Code and in Crew (the "Why Crew" plan, 2026-11-13: "Claude is out until 2:10.
 * Codex carried on."). Code hands the task to another agent (limit-handoff.ts); Crew puts the crew mate on its backup tool
 * (teammates.ts onBackup). Who carried on differs, the sentence doesn't: the chat's limit note, the Lanes board and a crew mate's
 * line in its crew's chats all say it from here.
 */
export interface LimitSaid {
  /** What ran out: the coding tool's name ("Claude Code"), or the agent's when it has no tool. */
  out: string;
  /** When it is back, as a clock says it ("2:10 PM", "2:10 PM tomorrow"); left out when its limit didn't say. */
  until?: string | null;
  /** Who carried on: the agent the task went to, or the crew mate itself. */
  carrier: string;
  /** The tool it carried on with, when that isn't the carrier's own name (a crew mate on its backup). */
  with?: string | null;
  /** For whom, when Friday moved it by itself: " for you", " for Ada" (limit-card.ts forWhomText). */
  forWhom?: string;
}

export function limitLine(o: LimitSaid): string {
  const until = o.until ? ` until ${o.until}` : "";
  const using = o.with && o.with !== o.carrier ? ` with ${o.with}` : "";
  return `${o.out} is out${until}. ${o.carrier} carried on${using}${o.forWhom ?? ""}.`;
}
