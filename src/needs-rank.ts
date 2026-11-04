/**
 * The "Needs you" queue's shape and its order (needs-you.ts collects it): one list of everything waiting on a person, across
 * their sessions, Crew rooms and teammates, worst first, each with Friday's suggested answer (Arun, 2026-10-31: Friday as the
 * intelligence layer, "most decisions take one tap").
 *
 * No imports, so the page (client/NeedsYou.tsx) ranks what only it knows (pull requests waiting on your review, read from your
 * computer) the same way the server ranks the rest.
 *
 * The API, for the web app and later the phone's Inbox:
 *
 *   GET  /api/needs-you                  → { items: Need[] }   (the person's sessions the server knows of, plus Crew asks)
 *   POST /api/needs-you {sids?}          → { items: Need[] }   (and these sessions too: a browser's list, Crew rooms)
 *   POST /api/needs-you/answer {id, answer, edited?} → { ok: true, said } | 4xx { error }
 *   POST /api/needs-you/dismiss {id}     → { ok: true }        ("Not now": off this person's queue until it waits again)
 *   POST /api/attention                  → { needs: NeedMark[], off: string[], … }   (the same list, as every count reads it)
 *
 * `answer` is one of the item's `choices[].value` (one tap), or words of the person's own when `free` (an edit). Nothing is
 * ever answered without the person: the suggestion is a suggestion.
 */

export type NeedKind =
  /** An agent's question (agent.question), asked of you by name. */
  | "question"
  /** A coding tool ended its turn asking, in prose read into choices (ask-parse.ts). */
  | "ask"
  /** A command or a turn waiting on your OK. */
  | "approval"
  /** A plan waiting on your OK before the agent starts (Plan first). */
  | "plan"
  /** A message from another session held until someone who steers the agent lets it through. */
  | "held"
  /** Somebody wants a wheel you are holding. */
  | "control"
  | "handover"
  | "stopped"
  | "mention"
  /** An agent out of usage that nobody could take the work from: carry on when it resets, or leave it. */
  | "limit"
  /** Someone's ask of a teammate you keep (hosted Crew), or a board task or workflow step for it. */
  | "crew"
  /** A pull request waiting on your review (from your computer's GitHub, added by the page). */
  | "review"
  /** A goal you set that is at risk (goals.ts): carry on, or re-plan. */
  | "goal"
  /** A mistake agents were corrected for came back after they were told (brain.ts): add the check Friday offers, or not. */
  | "check";

export interface NeedChoice {
  label: string;
  /** What one tap sends back as `answer`. */
  value: string;
}

export interface Suggestion {
  /** One of the choices' values, or words to send. */
  answer: string;
  /** One line: why this answer. */
  reason: string;
  /** The asker's own pick, Friday's model reading it, or Friday's rule for its kind. */
  by: "asker" | "friday" | "rule";
}

export interface Need {
  /** Stable while it waits: a new question is a new item. */
  id: string;
  kind: NeedKind;
  /** Who is asking: the agent, the teammate, or the person. */
  who: string;
  /** Where: the session (its id, to open it) or the Crew page, and the room when it is one. */
  where: { sid?: string; title: string; room?: string };
  /** What is asked, in its own words. */
  text: string;
  detail?: string;
  /** The one-tap answers. Empty for what can only be opened (a mention, a handover). */
  choices: NeedChoice[];
  /** Whether words of your own can be sent instead (Edit). */
  free: boolean;
  /** When it started waiting (ms). */
  since: number;
  /** What it holds up. */
  blocks: Blocks;
  /** The goal the work is for, when it has one. */
  goal?: string;
  /** Friday's suggestion, when it has one; `thinking` while the model is still reading it. */
  suggestion?: Suggestion;
  thinking?: boolean;
  /** Why there is no suggestion (it touches a key or password, say). */
  noSuggestion?: string;
  /** Its place in the queue, and why, in words: "Blocks 3 tasks in Refunds · waited 2h". */
  score: number;
  why: string;
  /** For the page only: an approval's command, a review's link. */
  command?: boolean;
  url?: string;
  /** A coding tool's numbered questions, each with its lettered choices: drawn as its own answer card's rows (audit CREW-17). */
  asks?: { question: string; options: { key: string; label: string; detail?: string }[] }[];
  /** Put off with "Not now": still waiting, kept under the list's "N put off · Show" (audit CREW-6). */
  putOff?: true;
}

export interface Blocks {
  /** Agents (or people) stopped by it, the asker included. */
  agents: number;
  /** Board tasks held up by it: the asker's own, and those waiting on them. */
  tasks: number;
  /** The one asking leads the room: everyone's work goes through it. */
  lead?: boolean;
  /** A room running on its own toward a goal, or a Crew room. */
  room?: boolean;
}

/** How much each kind stops by itself: an agent asking first is stopped dead; a mention is somebody's word to read. */
const BASE: Record<NeedKind, number> = { approval: 40, question: 40, ask: 40, plan: 40, held: 35, crew: 30, control: 25, review: 20, limit: 20, goal: 30, check: 10, handover: 15, stopped: 15, mention: 5 };

/** "4m", "2h", "3d". */
export function waitedText(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/**
 * Its place in the queue, and the words for it. What it blocks counts most (a lead or a whole room ahead of one task), then how
 * long it has waited (which grows slower the longer it gets: an hour more matters less after a day), then a goal it is for.
 */
export function scoreNeed(n: Pick<Need, "kind" | "blocks" | "since" | "goal" | "where">, now = Date.now()): { score: number; why: string } {
  const b = n.blocks;
  const place = n.where.room ?? n.where.title;
  const parts: string[] = [];
  let score = BASE[n.kind];
  if (b.lead) {
    score += 30;
    const held = [...(b.agents > 1 ? [`${b.agents - 1} other agent${b.agents === 2 ? "" : "s"}`] : []), ...(b.tasks ? [`${b.tasks} task${b.tasks === 1 ? "" : "s"}`] : [])];
    parts.push(`Blocks the lead${held.length === 2 ? `, ${held[0]} and ${held[1]}` : held.length ? ` and ${held[0]}` : ""} in ${place}`);
  } else if (b.tasks) parts.push(`Blocks ${b.tasks} task${b.tasks === 1 ? "" : "s"} in ${place}`);
  else if (b.room) parts.push(`Holds up ${place}`);
  if (b.tasks) score += Math.min(b.tasks, 6) * 10;
  if (b.room && !b.lead) score += 15;
  if (!parts.length && BASE[n.kind] >= 35) parts.push(`Stops ${b.agents > 1 ? `${b.agents} agents` : "an agent"} in ${place}`);
  const waited = Math.max(0, now - n.since);
  score += Math.min(25, 6 * Math.log2(1 + waited / 300_000));
  if (waited >= 60_000) parts.push(`waited ${waitedText(waited)}`);
  if (n.goal) {
    score += 10;
    parts.push(`for the goal "${n.goal.length > 40 ? `${n.goal.slice(0, 39)}…` : n.goal}"`);
  }
  const why = parts.join(" · ");
  return { score: Math.round(score * 10) / 10, why: why ? why[0]!.toUpperCase() + why.slice(1) : "" };
}

/** Scored and in order, worst first; the same score goes to what has waited longest. */
export function rankNeeds<T extends Pick<Need, "kind" | "blocks" | "since" | "goal" | "where">>(items: T[], now = Date.now()): (T & { score: number; why: string })[] {
  return items.map((n) => ({ ...n, ...scoreNeed(n, now) })).sort((a, b) => b.score - a.score || a.since - b.since);
}

/** One item waiting on a person, as much as a count needs: its id, its session, its kind, and whether it was put off. */
export interface NeedMark {
  id: string;
  sid?: string;
  kind: NeedKind;
  putOff?: true;
  /** Who asks, where, what, and since when: for a card where there is no session's to show it (Board.tsx). */
  who: string;
  title: string;
  text: string;
  since: number;
}

/** An item as a count reads it. */
export const markOf = (n: Omit<Need, "score" | "why">): NeedMark => ({ id: n.id, kind: n.kind, ...(n.where.sid ? { sid: n.where.sid } : {}), ...(n.putOff ? { putOff: true as const } : {}), who: n.who, title: n.where.title, text: n.text.length > 160 ? `${n.text.slice(0, 159)}…` : n.text, since: n.since });
