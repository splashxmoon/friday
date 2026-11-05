/**
 * What the Team room makes of the log, worked out apart from drawing it so it can be tested (2026-10-27 audit): which words are
 * the person's own and which are Friday's notes, whom each teammate's turn answers, which of the lead's turns are its answers,
 * and whether a run block is shown, folded with the agents' talk, or left out.
 *
 */
import { isCheckIn } from "../teammate-checkins.js";
import { runOf, type SessionState } from "../session/projection.js";
import { MAIN_LANE, type SessionEvent } from "../types.js";

/**
 * Friday's own note to an agent (carry on, a reminder, a board task's report): from Friday, or sent in the owner's name with
 * Friday's "[Friday] " mark, or a keep-going nudge, whoever the log says sent it. The server now appends Friday's notes as itself,
 * but logs from before say the owner sent them, and those read as the person talking (2026-10-27 audit: "Friday to Juno: Claude
 * Code ran out of usage partway through…" stood in the room beside two other rows for the same switch). The agents' talk, a
 * hand-off and a check-in are each something else, shown as what they are.
 */
export function isFridayNote(e: SessionEvent): boolean {
  const b = e.body;
  if (b.type !== "instruction" || b.mesh || b.peer || b.handoff || isCheckIn(b.text)) return false;
  return e.actor.kind !== "human" || b.text.startsWith("[Friday] ") || !!b.keepGoing;
}

/**
 * Whether an instruction is the person's own word to a teammate: a person sent it and it is none of Friday's notes, check-ins, a
 * yes or no to a command, or Friday's "[session]" carry on (those carry on what was asked before them).
 */
export function isPersonsWord(e: SessionEvent): boolean {
  const b = e.body;
  return b.type === "instruction" && e.actor.kind === "human" && !isFridayNote(e) && !isCheckIn(b.text) && !b.approval && !b.text.startsWith("[session]");
}

/** Whom a teammate's turn answers: the person, a check-in the person set (a routine), or the team (the lead's work, a teammate). */
export type TurnFor = "person" | "routine" | "team";

const RANK: Record<TurnFor, number> = { team: 0, routine: 1, person: 2 };

/**
 * Whom each agent message answers, by its seq, from what its turn was handed (2026-10-27 audit: the answer to the person folded
 * into the talk when they wrote to a teammate already busy on the lead's work, because only the message that started the turn
 * counted). Each delivery counts: a turn answers the person once any message it was handed is theirs. Friday's notes, a yes to a
 * command and a "[session]" carry on change nothing (the turn goes on with what it was on, or what the lane's last turn was for
 * when that is all it has), and a hand-off carries on whom the lane it came from was working for.
 */
export function turnsFor(events: readonly SessionEvent[]): Map<number, TurnFor> {
  const bySeq = new Map<number, SessionEvent>();
  for (const e of events) if (e.body.type === "instruction") bySeq.set(e.seq, e);
  /** Each lane's turn under way, and whom it answers so far (null: only carry ons yet). */
  const turn = new Map<string, TurnFor | null>();
  /** Whom each lane's latest turn answered. */
  const last = new Map<string, TurnFor>();
  const out = new Map<number, TurnFor>();
  const classOf = (seq: number): TurnFor | null => {
    const e = bySeq.get(seq);
    if (!e || e.body.type !== "instruction") return null;
    if (isPersonsWord(e)) return "person";
    if (isCheckIn(e.body.text)) return "routine";
    if (e.body.handoff) return last.get(e.body.handoff.fromLane) ?? "team";
    if (isFridayNote(e) || e.body.approval || e.body.text.startsWith("[session]")) return null;
    return "team";
  };
  const take = (lane: string, seqs: readonly number[]) => {
    let cur = turn.get(lane) ?? null;
    for (const s of seqs) {
      const c = classOf(s);
      if (c && (cur === null || RANK[c] > RANK[cur])) cur = c;
    }
    turn.set(lane, cur);
    if (cur) last.set(lane, cur);
  };
  for (const e of events) {
    const lane = e.lane ?? MAIN_LANE;
    const b = e.body;
    if (b.type === "run.started") {
      turn.set(lane, null);
      take(lane, [b.causedBy]);
    } else if (b.type === "instructions.delivered") take(lane, b.seqs);
    else if (b.type === "run.ended") turn.delete(lane);
    // Nothing known of its turn (a log cut short, a start never logged): the person's, so it shows, as it always did.
    else if (b.type === "agent.message") out.set(e.seq, turn.get(lane) ?? last.get(lane) ?? "person");
  }
  return out;
}

/** The part of a run block (Activity's RunItem) the room reads. */
export interface RunLike {
  lane: string;
  key: number;
  messages: { seq: number; body: { text: string } }[];
  diffs: { body: { files: unknown[] } }[];
  ended: { seq: number; body: { outcome: string; error?: string } } | null;
}

/** Whom a run block answers: the person if any of its messages does, else a routine's, else the team's. */
export function blockFor(it: RunLike, turns: ReadonlyMap<number, TurnFor>): TurnFor {
  if (!it.messages.length) return "person";
  let best: TurnFor = "team";
  for (const m of it.messages) {
    const t = turns.get(m.seq) ?? "person";
    if (RANK[t] > RANK[best]) best = t;
  }
  return best;
}

/** The lane's last run block, and how its agent stands now. */
export interface LaneNow {
  lastKey: number | undefined;
  status: string;
}

/**
 * Whether the block is the lane's turn still under way: its newest block, not ended, its agent running. Only that one is the
 * working line over the box (2026-10-27 audit: every block a turn was cut into was hidden while the lane worked, so a teammate's
 * answers from long-finished turns left the room whenever it was busy again). A teammate waiting on the person isn't working.
 */
export const isLive = (it: RunLike, now: LaneNow) => !it.ended && it.key === now.lastKey && now.status === "running";

/** Whether the block is the lane's newest, not ended, and its agent waits on the person: it "needs you", in the room too. */
export const isWaiting = (it: RunLike, now: LaneNow) => !it.ended && it.key === now.lastKey && now.status === "waiting_for_human";

/**
 * What the room does with a run block: "show" (a result for the person, the lead's answer, a teammate that needs them), "talk"
 * (a teammate's turn on the team's work, folded with the agents' talk) or "hide" (the turn under way, which is the working line
 * over the box; a turn that ended well having said and changed nothing). A teammate's own chat shows every block.
 */
export function roomRunKind(it: RunLike, o: { room: boolean; now: LaneNow; turns: ReadonlyMap<number, TurnFor>; lead: string | null | undefined; leadAnswers: ReadonlySet<number>; switched?: boolean }): "show" | "talk" | "hide" {
  if (isLive(it, o.now)) return o.room ? "hide" : "show";
  if (!o.room) return "show";
  const said = it.messages.some((m) => m.body.text.trim());
  const changed = it.diffs.some((d) => d.body.files.length);
  if (it.ended?.body.outcome === "done" && !said && !changed) return "hide";
  // Out of usage and on to its backup, having said and changed nothing: the switch's own line says it all.
  if (o.switched && !said && !changed) return "hide";
  if (isWaiting(it, o.now)) return "show";
  if (blockFor(it, o.turns) !== "team") return "show";
  return it.lane === o.lead && o.leadAnswers.has(it.key) ? "show" : "talk";
}

/** A lead turn this long or longer, ending a stretch of its work, is an answer in its own right. */
export const SUBSTANTIAL = 120;

/** What `leadAnswers` needs of each item in the room, in order. */
export type LeadInfo = { kind: "person" } | { kind: "lead"; key: number; text: string } | { kind: "other" } | { kind: "skip" };

/**
 * The lead's turns the room shows as answers, by key. The last lead turn before the person next speaks (or before now) is its
 * answer to them; and each lead turn that ends a stretch of its work, the teammates' talk coming after it, with something
 * substantial to say, stays shown too (2026-10-27 audit: a lead's summary, shown as the answer, folded away when a late report woke
 * the lead for one more short turn). Activity also keeps every one it has shown, so nothing shown folds away while it is read.
 */
export function leadAnswers<T>(items: readonly T[], info: (it: T) => LeadInfo): Set<number> {
  const out = new Set<number>();
  const infos = items.map(info).filter((x) => x.kind !== "skip");
  let answered = false;
  for (let i = infos.length - 1; i >= 0; i--) {
    const x = infos[i]!;
    if (x.kind === "person") answered = false;
    else if (x.kind === "lead") {
      if (!answered) (out.add(x.key), (answered = true));
      if (infos[i + 1]?.kind === "other" && x.text.trim().length >= SUBSTANTIAL) out.add(x.key);
    }
  }
  return out;
}

/**
 * Whether a run that ended on a usage limit was followed by its teammate's switch to its backup tool (teammate.switched), before
 * the lane's next turn: the switch's line says it ("Claude Code ran out of usage, so Juno carries on with Codex until 10:58 PM"),
 * so the run's own header doesn't say it again (2026-10-27 audit: one switch read as three rows).
 */
export function switchedAfter(events: readonly SessionEvent[], lane: string, endSeq: number): boolean {
  for (const e of events) {
    if (e.seq <= endSeq) continue;
    if (e.body.type === "teammate.switched" && e.body.lane === lane && !e.body.back) return true;
    if (e.body.type === "run.started" && (e.lane ?? MAIN_LANE) === lane) return false;
  }
  return false;
}

/**
 * In the Team room, the teammates a message there still waits for, by name: a message sent to several is one copy on each
 * lane, shown once, and each copy is queued or picked up on its own lane (2026-10-27 audit: a message to a busy teammate left
 * the room, which shows no queues, until it was picked up).
 */
export function queuedFor(copies: readonly { lane: string; seq: number }[], pending: (lane: string) => readonly number[], nameOf: (lane: string) => string): string[] {
  return copies.filter((c) => pending(c.lane).includes(c.seq)).map((c) => nameOf(c.lane)).filter(Boolean);
}

/**
 * Markdown as one line of plain text, for a room's last words on its card: marks taken off, what they mark kept. Underscores
 * and stars inside words and code stay (2026-10-27 audit: stripping every "_" turned `run_check_ins` into "runcheckins").
 */
export function plainLine(md: string): string {
  return (
    md
      // Fenced code: the code, without its fences and language.
      .replace(/```[^\n]*\n?/g, "")
      // Pictures and links: their words.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      // Inline code: its text, as it is.
      .replace(/`([^`]*)`/g, "$1")
      // Headings, quotes and list bullets at the start of a line.
      .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(?=\S))/gm, "")
      // A table's rule rows, then each row as its cells, a comma between, and a semicolon after it: run together with spaces, a
      // table read as one line of words (QA, 2026-10-28: "Day Post Mon Thread").
      .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, "")
      .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, row: string) => `${row.split("|").map((c) => c.trim()).filter(Boolean).join(", ")};`)
      .replace(/\s*\|\s*/g, " ")
      // Bold and italic marks around words, never inside one.
      .replace(/(^|[^\w*])(\*\*|__)(?=\S)([\s\S]*?\S)\2(?![\w*])/g, "$1$3")
      .replace(/(^|[^\w*])([*_])(?=\S)([\s\S]*?\S)\2(?![\w*])/g, "$1$3")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Friday's own notes to an agent, put after what a teammate wrote ("[Friday] It is big enough to split: …"): for the agent only. */
export const withoutFridayNotes = (text: string) => text.split(/\n\s*\n/).filter((p) => !p.trimStart().startsWith("[Friday]")).join("\n\n").trim();

/**
 * What a teammate's long message to another comes to, in a line: its first sentence, plain, at most `max` characters, and whether
 * there is more to read (Arun, 2026-11-01, a task brief of a dozen lines in the room: "there is a lot of reading"). A short one is
 * itself, with nothing more.
 */
export function gist(text: string, max = 160): { line: string; more: boolean } {
  const own = withoutFridayNotes(text);
  const plain = plainLine(own).replace(/\s+/g, " ").trim();
  if (plain.length <= max && !own.includes("\n")) return { line: plain, more: false };
  // The first sentence: up to a full stop, question or exclamation mark followed by a space, not one inside a name ("v5.mp4").
  const first = /^(.+?[.!?])(?=\s+[A-Z(“"'])/.exec(plain)?.[1] ?? plain;
  const line = first.length > max ? `${first.slice(0, max).replace(/\s+\S*$/, "")}…` : first;
  return { line, more: line.length < plain.length };
}


/**
 * The questions a crew's room docks over its box (audit CREW-1, 2026-11-04): each teammate that ended its answer asking something
 * and isn't at work again, for those the person may answer. The same ask its own chat shows under the answer, so an answer given
 * in either place, or in Needs you, is the lane's next instruction and the projection drops it from both.
 */
export function roomAsks(state: SessionState, mayAnswer: (lane: string) => boolean): { lane: string; seq: number; questions: SessionState["asks"][string]["questions"] }[] {
  return state.lanes.flatMap((l) => {
    const a = state.asks[l.id];
    return a && runOf(state, l.id).status !== "running" && mayAnswer(l.id) ? [{ lane: l.id, ...a }] : [];
  });
}

/**
 * A teammate's words that only repeat what it said before Friday told it to keep going (keep-going.ts), by seq: the room posts
 * one, not one per nudge (audit CREW-4, 2026-11-04: four or five identical "Done: …" posts). The message must come straight after
 * a nudge (the latest thing its lane was handed is Friday's carry on) and say what the lane last said, marks and case aside.
 */
export function nudgedRepeats(events: readonly SessionEvent[]): Set<number> {
  const out = new Set<number>();
  const nudges = new Set<number>();
  const lastSaid = new Map<string, string>();
  const handed = new Map<string, boolean>();
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (const e of events) {
    const lane = e.lane ?? MAIN_LANE;
    const b = e.body;
    if (b.type === "instruction" && b.keepGoing) nudges.add(e.seq);
    else if (b.type === "instructions.delivered") handed.set(lane, b.seqs.length > 0 && b.seqs.every((s) => nudges.has(s)));
    else if (b.type === "run.started") handed.set(lane, false);
    else if (b.type === "agent.message" && b.text.trim()) {
      const t = norm(b.text);
      if (handed.get(lane) && lastSaid.get(lane) === t) out.add(e.seq);
      lastSaid.set(lane, t);
    }
  }
  return out;
}

/**
 * The board's report to its poster ("## s1: Run the tests (done by Rex, approved by Mira)" and each task's report), told from the
 * board's own record up to `seq` (audit CREW-12, 2026-11-04): each task by its title, never its id, done by whoever's lane finished
 * it and checked by whoever's lane reviewed it, by their names now (`nameOf`), as the room names them everywhere else.
 */
export function boardReportText(text: string, events: readonly SessionEvent[], seq: number, nameOf: (lane: string) => string | undefined): string {
  type Rec = { title: string; lane?: string; name?: string; blocked?: boolean; review?: { lane: string; name: string; ok: boolean } };
  const tasks = new Map<string, Rec>();
  for (const e of events) {
    if (e.seq >= seq) continue;
    const b = e.body;
    if (b.type === "board.posted") {
      tasks.clear();
      for (const t of b.tasks) tasks.set(t.id, { title: t.title });
    } else if (b.type === "board.finished") {
      const t = tasks.get(b.id);
      if (t) Object.assign(t, { lane: b.lane, name: b.name, blocked: b.status === "blocked", review: undefined });
    } else if (b.type === "board.reviewed") {
      const t = tasks.get(b.id);
      if (t) t.review = { lane: b.lane, name: b.name, ok: b.ok };
    }
  }
  const who = (lane: string | undefined, name: string | undefined) => (lane ? nameOf(lane) : undefined) ?? name ?? "";
  return text.replace(/^## ([^:\n]+): ([^\n]*)$/gm, (line, id: string, rest: string) => {
    const t = tasks.get(id.trim());
    if (!t) return `## ${rest}`;
    const title = t.title.replace(/^Board task\s+"[^"]*"\s*:\s*/i, "");
    const did = t.blocked ? `blocked${t.name || t.lane ? ` (${who(t.lane, t.name)})` : ""}` : `done by ${who(t.lane, t.name)}`;
    const checked = t.review ? `, ${t.review.ok ? "approved" : "not approved"} by ${who(t.review.lane, t.review.name)}` : "";
    return `## ${title} (${did}${checked})`;
  });
}

/** Words quoted into a message, as Markdown: each line marked, blank lines inside kept as quote lines, one blank line after. */
export const quoteBlock = (text: string): string =>
  text
    .trim()
    .split(/\r?\n/)
    .map((l) => (l.trim() ? `> ${l.trimEnd()}` : ">"))
    .join("\n");

/**
 * A sent message's quote and the words after it (audit CREW-21, 2026-11-04): the "> " lines it starts with, unmarked, and the rest
 * without the blank lines between. Null when it starts with no quote.
 */
export function splitQuote(text: string): { quote: string; rest: string } | null {
  const m = /^((?:[ \t]*>[^\n]*(?:\n|$))+)/.exec(text);
  if (!m) return null;
  const quote = m[1]!.split("\n").map((l) => l.replace(/^[ \t]*>[ \t]?/, "")).join("\n").trim();
  return quote ? { quote, rest: text.slice(m[0].length).replace(/^\s+/, "") } : null;
}

/** Every quote a sent message starts with, in order, each its own "> " block, and the words after them (quoted twice, 2026-11-04). */
export function splitQuotes(text: string): { quotes: string[]; rest: string } {
  const quotes: string[] = [];
  let rest = text;
  for (let q = splitQuote(rest); q; q = splitQuote(rest)) quotes.push(q.quote), (rest = q.rest);
  return { quotes, rest };
}

/** The quotes held over the box, then the words typed under them: each quote its own block, one blank line between each. */
export const withQuotes = (quotes: readonly string[], text: string): string => [...quotes.map(quoteBlock), text.trim()].filter(Boolean).join("\n\n");

/**
 * Words selected in a message, as they read (QuoteSelection, Activity.tsx): each piece of text the selection covers, in order, with
 * the block it sits in and whether that keeps its spaces (code). A new block is a new line and the spaces Markdown's source put
 * between inline pieces are one space; the browser's own Selection.toString() broke a line at every file chip and inline mark,
 * so "Update README.md with the new numbers" was quoted as three lines (Arun, 2026-11-04: "fixing the thing … when you click quote").
 */
export function selectedText(pieces: readonly { text: string; block: unknown; pre?: boolean }[]): string {
  let out = "";
  let last: unknown = undefined;
  for (const p of pieces) {
    let t = p.pre ? p.text : p.text.replace(/\s+/g, " ");
    if (!t) continue;
    if (last !== undefined && p.block !== last && !out.endsWith("\n")) out += "\n";
    if (!p.pre && (out === "" || out.endsWith("\n"))) t = t.replace(/^ +/, "");
    else if (!p.pre && t.startsWith(" ") && out.endsWith(" ")) t = t.slice(1);
    out += t;
    last = p.block;
  }
  return out
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/^\n+|\s+$/g, "");
}

/** A board a crew workflow posted (team-workflow-model.ts workflowTasks): Friday's, its tasks marked as the workflow's steps. */
export const isWorkflowBoard = (e: SessionEvent): boolean => e.body.type === "board.posted" && (e.body.tasks ?? []).some((t) => typeof t?.detail === "string" && t.detail.includes('[Workflow "'));

/**
 * A workflow's chatter in a room, which its run card (WorkflowRunCard.tsx) stands in for (Arun, 2026-11-01, the Crew room
 * concept): each step handed out and reviewed, Friday's word to the lead when a stage before the last is through, and the turns that only did
 * those. `events`: those to leave out, by seq; `messages`: the agent messages of those turns; `live`: lanes whose turn under way
 * is one. Anything a turn was also handed by a person, or by a teammate outside the workflow, keeps it in the room.
 */
export function workflowChatter(events: readonly SessionEvent[]): { events: Set<number>; messages: Set<number>; live: Set<string> } {
  const hide = new Set<number>();
  const messages = new Set<number>();
  const flowSeqs = new Set<number>();
  /** Each lane's turn under way: whether everything it was handed is the workflow's (null before anything is). */
  const turn = new Map<string, boolean | null>();
  let onFlow = false;
  // A stage's end is the card's to say; the last one's hand-off stays, as the lead's answer to it carries what landed (its PR).
  const flowWord = (e: SessionEvent) => e.body.type === "instruction" && typeof e.body.text === "string" && /That board was part of the workflow “/.test(e.body.text);
  const take = (lane: string, seqs: readonly number[]) => {
    let cur = turn.get(lane) ?? null;
    for (const s of seqs ?? []) cur = (cur ?? true) && flowSeqs.has(s);
    turn.set(lane, cur);
  };
  for (const e of events) {
    const b = e.body;
    const lane = e.lane ?? MAIN_LANE;
    if (b.type === "board.posted") onFlow = isWorkflowBoard(e);
    else if (b.type === "instruction" && ((onFlow && !!b.mesh?.board) || flowWord(e))) {
      flowSeqs.add(e.seq);
      hide.add(e.seq);
    } else if (b.type === "run.started") {
      turn.set(lane, null);
      take(lane, [b.causedBy]);
    } else if (b.type === "instructions.delivered") take(lane, b.seqs);
    else if (b.type === "run.ended") turn.delete(lane);
    else if (b.type === "agent.message" && turn.get(lane) === true) messages.add(e.seq);
  }
  const live = new Set([...turn].filter(([, v]) => v === true).map(([l]) => l));
  return { events: hide, messages, live };
}
