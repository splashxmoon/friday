/**
 * What the Team room makes of the log, worked out apart from drawing it so it can be tested (2026-10-27 audit): which words are
 * the person's own and which are Friday's notes, whom each teammate's turn answers, which of the lead's turns are its answers,
 * and whether a run block is shown, folded with the agents' talk, or left out.
 *
 */
import { isCheckIn } from "../teammate-checkins.js";
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
