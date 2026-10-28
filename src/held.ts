import { MAIN_LANE, type SessionEvent } from "./types.js";

/**
 * An agent the person has put on hold: told to stop, pause or hold, and nothing from them since. Friday leaves it be, rather than
 * telling it to carry on (keep-going.ts), setting a wake for it or firing one (agent-mesh.ts): each of those had it answer "I'm
 * still stopped" again and again (Arun, 2026-10-27: "Friday keeps telling the Manager to 'carry on' after you told the team to
 * stop, and it answers 'still stopped' each time"). What the other agents send it waits in its queue meanwhile (engine/hub.ts).
 */

/** Who is addressed at the start of a message: @-names, names with a comma ("Kit, stop"), and the words people open with. */
const OPENER = String.raw`^\s*(?:@[\w.-]+[\s,:]*)*(?:[A-Z][\w.'-]*\s*,\s*)*(?:(?:ok(?:ay)?|hey|please|everyone|everybody|all of you|guys|team|y'?all)[\s,!:]+)*`;
/** The words that stop an agent. */
const VERB = String.raw`(?:stop|pause|hold(?: off| on| up)?|halt|freeze|stand ?by|wait)`;
/**
 * What may follow the stop in a message that is only the stop: who and when, never what (an object, "stop using the old API", is
 * an instruction that uses the word). "it" and "that" are the stop itself (2026-10-27 audit: "stop it" and "@Nova stop that"
 * were missed), and so is being back ("Pause everything until I'm back").
 */
const AFTER = String.raw`(?:all|everything|working|work|your work|the work|now|for now|right now|please|what you'?re doing|it|that|this|for a (?:sec|second|moment|bit|minute)|(?:until|till) i(?: say(?: so)?| tell you| get back| return| come back| am back|'?m back)|for me|for my (?:word|go)|until further notice|everyone|guys)`;

/**
 * A person telling an agent, or everyone, to stop: a message that is itself the stop ("pause your work", "@Nih @Gato stop",
 * "everyone hold until I say", "STOP STOP STOP"), not one that uses the word ("stop at the first failing test", "stop using the
 * old API").
 */
const STOP_ALONE = new RegExp(`${OPENER}${VERB}(?:[\\s,!.]+${VERB})*(?:[\\s,]+${AFTER})*\\s*[.!]*\\s*$`, "i");
/**
 * A stop with its reason after it ("Stop, that's wrong", "hold on, let me check something"): the stop on its own, then words
 * about why rather than another task (2026-10-27 audit: both were missed). "I need" is a reason only when what is needed is the
 * pause itself ("I need to check something", "I need a minute"): "Hold on, I need X shipped tonight" and "Team, wait — we need…"
 * are work (Arun, 2026-10-28: "run an audit on the teams stuff, really iron out bugs").
 */
const NEED = String.raw`(?:i need|i want|we need)\s+(?:to (?:check|look|think|see|read|review|confirm|talk|test|figure|sort|decide|ask|discuss|step|go over|rethink)|a (?:sec|second|minute|moment|bit|break|word)|(?:some |more )?time|you (?:all )?to (?:stop|wait|hold|pause))\b`;
const STOP_WHY = new RegExp(`${OPENER}${VERB}(?:[\\s,]+${AFTER})*\\s*[,.!;:—–-]+\\s*(?:that'?s|that is|this is|it'?s|you'?re|you are|${NEED}|let me|i'?ll|i will|something'?s|not (?:like|what|right)|wrong|no\\b|wait)`, "i");
/**
 * A task said after the stop and its reason ("Stop, that's wrong. Use the v2 API instead."): a message is a stop only when no
 * task follows it, since the person's message is then the agent's next work.
 */
const TASK_AFTER = /[.!?;]\s+(?:please\s+)?(?:use|fix|build|add|make|ship|write|run|deploy|implement|change|switch|try|do|start|finish|merge|test|revert|undo|put|move|rename|remove|delete|update|call|create|go back to|carry on with|work on|look at|focus on)\b/i;
/**
 * A stop said to everyone inside a longer message ("Ok, now everyone stop."): the stop has to end its clause, with no object and
 * no other task after it (2026-10-27 audit: "Everyone stop what you're doing and fix the failing build", "everyone, stop editing
 * main.ts", "Everyone pause the refactor and look at the prod bug first" and "Everybody stop by the standup channel" each read
 * as a stop). "and wait" is still the stop.
 */
const STOP_EVERYONE = new RegExp(
  String.raw`\b(?:everyone|everybody|all of you|all agents|the whole team|y'?all)\b[\s,:]*(?:(?:please|now|just|to|ok(?:ay)?)[\s,]+)*${VERB}(?:[\s,]+${AFTER})*(?:\s+and\s+(?:wait|hold|stand ?by|stay (?:put|there)|listen)\b(?:[\s,]+${AFTER})*)?\s*(?:[.!?;,]|—|–|\s-\s|$)`,
  "i",
);

/** An agent saying it is stopped, paused or waiting: half of what holding as told is. */
const HOLD_WORD = /\b(?:stop(?:ped|ping)?|paus(?:e|ed|ing)|hold(?:ing)?|on hold|stand(?:ing)? ?by|wait(?:ing)?|stay(?:ing)? (?:put|idle|stopped|paused)|not (?:starting|continuing|carrying on|picking (?:it )?up|resuming|doing anything))\b/i;
/**
 * The other half: that it was told to, and waits for the word to go on. Only this phrasing (2026-10-27 audit: "I'll wait for
 * Nova to say the schema is merged", "I'm standing by for Kit's review" and "We're stopped by a failing typecheck" each read as
 * holding, and lost the agent its wake).
 */
const TOLD =
  /\b(?:as (?:you|the person|they|i was|we were|i've been|we've been|[A-Z][\w.-]*)? ?(?:asked|said|told(?: me| us)?|instructed|requested)\b|(?:until|till|unless) (?:you|the person|they|someone|[A-Z][\w.-]*) (?:say|says|tell|tells|give|gives|lift|lifts)\b|(?:asked|told|ordered|instructed) (?:me|us|everyone|everybody|all of us|the team) to (?:stop|pause|hold|stand ?by|wait)\b(?!\s+(?:\w+ing|the|my|our|your|on|by|for)\b))/i;

export const asksToStop = (text: string) => STOP_ALONE.test(text) || (STOP_WHY.test(text) && !TASK_AFTER.test(text)) || STOP_EVERYONE.test(text);
/** Its own words that it is holding because it was told to: a hold word and being told, in one sentence. */
export const saysHolding = (text: string) => text.split(/(?<=[.!?])\s+|\n+/).some((s) => HOLD_WORD.test(s) && TOLD.test(s));

/**
 * A message from a person that is to everyone: one that opens by naming everyone ("everyone carry on", "team, back to it"), or
 * a stop to everyone. Not any that mentions them (2026-10-27 audit: "@Kit, everyone is waiting on you" lifted every hold).
 */
const TO_ALL = /^\s*(?:(?:ok(?:ay)?|hey|please|right|alright|so|now)[\s,!:]+)*@?(?:everyone|everybody|all of you|all agents|team|the team|guys|y'?all)\b/i;
const toEveryone = (text: string) => TO_ALL.test(text) || STOP_EVERYONE.test(text);

/** The team's lead in the log as it stands: the lane a person last made it, if it is still there. */
function leadOf(events: readonly SessionEvent[]): string | null {
  let lead: string | null = null;
  for (const e of events) {
    if (e.body.type === "lead.set") lead = e.body.lane;
    else if (e.body.type === "lane.removed" && e.body.laneId === lead) lead = null;
  }
  return lead;
}

/**
 * Whether the agent on `lane` is on hold: the latest a person said to it (or to everyone, on any lane, where the team hears it
 * through its lead) asks it to stop; or its lead's latest message to it is a stop, and its own words since say it is holding as
 * told. Its own words count only when they answer a stop (2026-10-27 audit: an agent saying it waited on a teammate was taken as
 * on hold, and the wake it asked for was spent on nothing).
 */
export function heldByPerson(events: SessionEvent[], lane: string): boolean {
  const onLane = (e: SessionEvent) => (e.lane ?? MAIN_LANE) === lane;
  const human = (e: SessionEvent) => e.body.type === "instruction" && e.actor.kind === "human";
  const lead = leadOf(events);
  let toMe: SessionEvent | undefined;
  let toAll: SessionEvent | undefined;
  let fromLead: SessionEvent | undefined;
  /** A person's new task to the lead: work for the whole team, so it lifts every hold (Arun, 2026-10-28). */
  let toLead: SessionEvent | undefined;
  /** The person's one-click lift, or a switch that clears every hold at once. */
  let lifted: SessionEvent | undefined;
  for (let i = events.length - 1; i >= 0 && !(toMe && toAll && fromLead && toLead); i--) {
    const e = events[i]!;
    if (e.body.type !== "instruction") continue;
    if (human(e) && onLane(e)) toMe ??= e;
    // The latest a person said to everyone, whatever it says: "everyone carry on" lifts "everyone stop".
    else if (human(e) && toEveryone(e.body.text)) toAll ??= e;
    else if (human(e) && lead && lead !== lane && (e.lane ?? MAIN_LANE) === lead && !asksToStop(e.body.text)) toLead ??= e;
    else if (onLane(e) && lead && lead !== lane && e.body.mesh?.fromLane === lead) fromLead ??= e;
  }
  const last = [toMe, toAll, fromLead, toLead, lifted].filter((e): e is SessionEvent => !!e).sort((a, b) => b.seq - a.seq)[0];
  if (last === toLead || last === lifted) return false;
  if (last?.body.type !== "instruction" || !asksToStop(last.body.text)) return false;
  if (last !== fromLead) return true;
  // Its lead's stop: on hold once it says it is holding as told, the person's own word still the one that lifts it.
  const said = events.findLast((e) => onLane(e) && e.body.type === "agent.message" && !!e.body.text.trim());
  return !!said && said.body.type === "agent.message" && said.seq > last.seq && saysHolding(said.body.text);
}

/**
 * What of the queue on `lane` may start a turn: none of it while the agent is on hold and all of it is the other agents' or
 * Friday's (2026-10-27 audit: a hold stopped Friday's nudges, but a teammate's message or the lead's report batch still woke it).
 * It waits there, and goes with the next turn a person starts.
 */
export function runnableQueue(events: SessionEvent[], lane: string, queued: number[]): number[] {
  if (!queued.length) return queued;
  const bySeq = new Map<number, SessionEvent>();
  for (let i = events.length - 1; i >= 0 && bySeq.size < queued.length; i--) if (queued.includes(events[i]!.seq)) bySeq.set(events[i]!.seq, events[i]!);
  if (queued.some((q) => bySeq.get(q)?.actor.kind === "human")) return queued;
  return heldByPerson(events, lane) ? [] : queued;
}
