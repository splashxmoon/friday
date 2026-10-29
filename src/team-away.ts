import { isCheckIn, saysNoUpdate } from "./teammate-checkins.js";
import { MAIN_LANE, type SessionEvent, type TeamBrief } from "./types.js";

/**
 * The team while the person is away (Arun, 2026-10-28: "we need to ensure teams can work basically while you are away"): what
 * each teammate is told while they are, the brief they come back to, and the counts the app shows for each teammate (its usage,
 * its runs). Read from the logs alone, no model call, so the brief is instant, free and says nothing the logs don't.
 *
 */

/** "08:00": a time as this computer's clock says it, which is the person's (Friday runs on their computer). */
export const clockOf = (at: number, tz?: string): string => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(tz ? { timeZone: tz } : {}) }).format(at);

/**
 * What every teammate turn is told while the person is away: don't ask, decide, note what was assumed, carry on. Said as Friday
 * with the turn's prompt (EngineHub's preamble), short, so a night of turns doesn't spend much on it.
 */
export function awayNote(until: number, tz?: string): string {
  return `[Friday] The person is away until ${clockOf(until, tz)} and can't answer. Don't ask them anything and don't wait for them: when a choice is theirs, take the safest reasonable option (one that is easy to undo, keeps to what they asked, and touches nothing outside it), record it with write_note under a key starting "assumption" (what you chose, and why), and carry on. Never push to a shared branch's default, deploy, delete data or spend money while they are away: leave that for them, say so, and do the rest.`;
}

/** Friday's one answer to a teammate whose turn ended on a question while the person is away. */
export function awayAnswer(until: number, tz?: string): string {
  return `[Friday] The person is away until ${clockOf(until, tz)}, so nobody will answer that tonight. Decide it yourself: take the safest reasonable option, record it with write_note under a key starting "assumption" (what you chose and why, so they can change it in the morning), and carry on with the work. If it really can't be decided without them, say what is blocked in one line and do everything else that can be done.`;
}

/** Whether a note a teammate saved is an assumption it made (the brief collects them). */
export const isAssumption = (key: string, text: string) => /^assum/i.test(key.trim()) || /^\s*assum(?:ed|ption|ing)\b/i.test(text);

/** A turn's last words that end on a question to the person. */
export const endsOnQuestion = (text: string) => /\?\s*(?:\*\*)?\s*$/.test(text.trim());

/** Tokens a turn counted: a coding tool's usage reports, or Friday Code's own steps. */
function tokensOf(e: SessionEvent): number {
  const b = e.body;
  if (b.type === "agent.usage") return (b.input ?? 0) + (b.output ?? 0);
  if (b.type === "agent.message") return b.tokens ?? 0;
  return 0;
}

/** A lane's runs in a log: when each started and ended (null while running), how, and what it said and changed. */
export interface LaneRun {
  lane: string;
  startSeq: number;
  startedAt: number;
  endSeq: number | null;
  endedAt: number | null;
  outcome: "done" | "waiting" | "error" | "running" | "stopped";
  error?: string;
  said: string;
  /** The seq of its last words. */
  saidSeq: number;
  files: string[];
  tokens: number;
  /** What started it: the instruction's text. */
  cause: string;
  prs: string[];
  /**
   * When each of its turns began: its start, and each batch of messages handed to it mid-run after it had said or done something
   * (a coding tool that stays up takes several turns in one run; the 2026-10-28 away run counted a lead's three as 0 turns).
   */
  turnsAt: number[];
}

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

/** Every run on `lanes` in one pass over a log, oldest first. */
export function runsIn(events: readonly SessionEvent[], lanes: ReadonlySet<string>): LaneRun[] {
  const out: LaneRun[] = [];
  const open = new Map<string, LaneRun>();
  /** Lanes whose run has said or done something since its last batch of messages. */
  const busy = new Set<string>();
  const bySeq = new Map<number, SessionEvent>();
  for (const e of events) {
    const lane = e.lane ?? MAIN_LANE;
    const b = e.body;
    if (b.type === "instruction") bySeq.set(e.seq, e);
    if (!lanes.has(lane)) continue;
    if (b.type === "run.started") {
      const cause = bySeq.get(b.causedBy);
      const r: LaneRun = { lane, startSeq: e.seq, startedAt: e.ts, endSeq: null, endedAt: null, outcome: "running", said: "", saidSeq: 0, files: [], tokens: 0, cause: cause?.body.type === "instruction" ? cause.body.text : "", prs: [], turnsAt: [e.ts] };
      open.set(lane, r);
      busy.delete(lane);
      out.push(r);
      continue;
    }
    const r = open.get(lane);
    if (!r) continue;
    // A batch handed to it after it had got going is a turn of its own; the one that opens the run is the run's.
    if (b.type === "instructions.delivered") {
      if (busy.has(lane)) r.turnsAt.push(e.ts);
      busy.delete(lane);
    } else if (b.type === "agent.message" || b.type === "agent.diff") busy.add(lane);
    if (b.type === "agent.message" && b.text.trim()) {
      r.said = b.text.trim();
      r.saidSeq = e.seq;
      for (const m of b.text.matchAll(PR_URL)) if (!r.prs.includes(m[0])) r.prs.push(m[0]);
    }
    if (b.type === "agent.diff") r.files = [...new Set([...r.files, ...b.files.map((f) => f.path)])];
    if (b.type === "folder.committed" && b.prUrl && !r.prs.includes(b.prUrl)) r.prs.push(b.prUrl);
    r.tokens += tokensOf(e);
    if (b.type === "run.ended") {
      r.endSeq = e.seq;
      r.endedAt = e.ts;
      r.outcome = b.outcome;
      if (b.error) r.error = b.error;
      open.delete(lane);
    } else if ((b.type === "run.pause" || b.type === "run.cancel") && r.outcome === "running") {
      r.endSeq = e.seq;
      r.endedAt = e.ts;
      r.outcome = "stopped";
      open.delete(lane);
    }
  }
  return out;
}

/** Turns, minutes working and tokens of the runs on a lane that overlap [from, to). */
export function usageOf(runs: readonly LaneRun[], from: number, to = Date.now()): { turns: number; minutes: number; tokens: number } {
  let turns = 0;
  let ms = 0;
  let tokens = 0;
  for (const r of runs) {
    const end = r.endedAt ?? to;
    if (end < from || r.startedAt >= to) continue;
    turns += (r.turnsAt ?? [r.startedAt]).filter((t) => t >= from && t < to).length;
    ms += Math.max(0, Math.min(end, to) - Math.max(r.startedAt, from));
    tokens += r.tokens;
  }
  return { turns, minutes: Math.round(ms / 60_000), tokens };
}

/** A place a teammate works: the Team room (room null) or one of its rooms, its log, and each teammate's lane there. */
export interface Place {
  sid: string;
  room: string | null;
  events: readonly SessionEvent[];
  /** Lane by teammate id. */
  lanes: Record<string, string>;
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
/**
 * Text as a line to read, its markdown gone: emphasis, code ticks, links and a heading or list mark (2026-10-28 away run: a
 * lead's "**Status: partly done…**" kept its stray `**` as the brief's title).
 */
export const plainText = (s: string) =>
  s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/(\*\*|__|\*|`)/g, "")
    .replace(/^[#>\-+\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
/** Its first line with words, as a line to read; one that only leads into a list ("Built it with:") takes the next line too. */
function firstLine(s: string): string {
  const lines = s.trim().split("\n").filter((l) => l.replace(/[#>*_`\-\s|]/g, ""));
  const first = plainText(lines[0] ?? "");
  return first.endsWith(":") && lines[1] ? `${first} ${plainText(lines[1])}` : first;
}

/** A branch named in a lead's wrap-up ("on friday/team-qa", "the shipping-fee branch", "branch `x`"), if one is. */
const NOT_BRANCH = new Set(["a", "an", "the", "local", "new", "own", "default", "feature", "separate", "same", "this", "that", "their", "your", "my", "one", "its", "his", "her", "our", "remote", "git", "each"]);
export function branchIn(text: string): string | null {
  const t = text.replace(/[*_]/g, "");
  for (const re of [/`((?:friday|feat|fix|feature)\/[\w./-]*\w)`/i, /\b((?:friday|feat|fix|feature)\/[\w./-]*\w)/i, /\bbranch\s+`?([\w][\w./-]*\w)`?/i, /`?([\w][\w./-]*\w)`?\s+branch\b/i]) {
    const m = re.exec(t);
    if (m && !NOT_BRANCH.has(m[1]!.toLowerCase())) return m[1]!;
  }
  return null;
}

/** The lead in a log as it stands: the lane a person last made it. */
function leadIn(events: readonly SessionEvent[]): string | null {
  const e = events.findLast((x) => x.body.type === "lead.set");
  return e?.body.type === "lead.set" ? e.body.lane : null;
}

/**
 * The brief (types.ts TeamBrief) over [since, until] across every place the team works: board tasks done and stuck, each
 * teammate's results otherwise, its errors, the questions left for the person, the assumptions noted, and the usage. One pass
 * over each log. Each teammate is named by its Team room lane (`teamLane`), wherever the line came from.
 */
export function teamBrief(places: readonly Place[], mates: readonly { id: string; name: string; lane: string }[], since: number, until: number): TeamBrief {
  const brief: TeamBrief = { since, until, done: [], failed: [], waiting: [], assumptions: [], usage: [] };
  const used = new Map<string, { turns: number; minutes: number; tokens: number }>();
  for (const p of places) {
    const where = (sid: string) => (p.room === null ? {} : { sid });
    const mateOn = new Map(Object.entries(p.lanes).flatMap(([id, lane]) => {
      const m = mates.find((x) => x.id === id);
      return m ? [[lane, m] as const] : [];
    }));
    const lanes = new Set(mateOn.keys());
    const runs = runsIn(p.events, lanes);
    // Board tasks, by id, as last posted: their titles.
    const titles = new Map<string, string>();
    /**
     * Each board task's latest finish in the stretch, by id: a task done twice (redone after a revert) is one line, and one
     * blocked and then done is done alone (2026-10-28 away run: the same task in done twice, and in failed and done at once).
     */
    const finished = new Map<string, { lane: string; done: boolean; line: TeamBrief["done"][number] | TeamBrief["failed"][number] }>();
    /** Lanes that finished a board task in the stretch: their board work is their result. */
    const boardDone = new Set<string>();
    for (const e of p.events) {
      const b = e.body;
      if (b.type === "board.posted") for (const t of b.tasks) titles.set(t.id, t.title);
      if (e.ts < since || e.ts > until) continue;
      const lane = e.lane ?? MAIN_LANE;
      if (b.type === "board.finished") {
        const m = mateOn.get(b.lane);
        if (!m) continue;
        const run = runs.findLast((r) => r.lane === b.lane && r.startSeq < e.seq);
        const title = plainText(titles.get(b.id) ?? b.id);
        finished.delete(b.id);
        if (b.status === "done") finished.set(b.id, { lane: b.lane, done: true, line: { lane: m.lane, name: m.name, title, ...(run?.files.length ? { files: run.files.slice(0, 20) } : {}), ...(run?.prs[0] ? { pr: run.prs[0] } : {}), ...where(p.sid), seq: e.seq } });
        else finished.set(b.id, { lane: b.lane, done: false, line: { lane: m.lane, name: m.name, title, why: clip(b.report, 300), ...where(p.sid), seq: e.seq } });
      }
      if (b.type === "memory.saved" && e.actor.kind === "agent" && isAssumption(b.key, b.text)) {
        const m = mateOn.get(lane);
        if (m) brief.assumptions.push({ lane: m.lane, name: m.name, text: clip(`${b.text}`, 400), seq: e.seq, ...where(p.sid) });
      }
    }
    // In the order they last finished.
    for (const f of [...finished.values()].sort((x, y) => (x.line.seq ?? 0) - (y.line.seq ?? 0))) {
      if (f.done) {
        brief.done.push(f.line as TeamBrief["done"][number]);
        boardDone.add(f.lane);
      } else brief.failed.push(f.line as TeamBrief["failed"][number]);
    }
    const lead = leadIn(p.events);
    for (const m of new Set(mateOn.values())) {
      const lane = p.lanes[m.id]!;
      const mine = runs.filter((r) => r.lane === lane);
      const u = usageOf(mine, since, until);
      const had = used.get(m.id) ?? { turns: 0, minutes: 0, tokens: 0 };
      used.set(m.id, { turns: had.turns + u.turns, minutes: had.minutes + u.minutes, tokens: had.tokens + u.tokens });
      const inStretch = mine.filter((r) => r.endedAt !== null && r.endedAt >= since && r.endedAt <= until);
      // A result it gave outside the board: its last turn that ended done with words, a check-in with nothing new aside.
      const result = inStretch.findLast((r) => r.outcome === "done" && r.said && !saysNoUpdate(r.said) && !isCheckIn(r.cause));
      if (result && !boardDone.has(lane)) {
        const files = [...new Set(inStretch.flatMap((r) => r.files))];
        const prs = [...new Set(inStretch.flatMap((r) => r.prs))];
        brief.done.push({ lane: m.lane, name: m.name, title: lane === lead ? leadLine(p.events, lane, result) : clip(firstLine(result.said), 140), ...(files.length ? { files: files.slice(0, 20) } : {}), ...(prs[0] ? { pr: prs[0] } : {}), ...where(p.sid), seq: result.saidSeq });
      }
      // Its last turn stopped on an error, and nothing ran since.
      const last = mine.at(-1);
      if (last && last.outcome === "error" && last.endedAt !== null && last.endedAt >= since && last.endedAt <= until)
        brief.failed.push({ lane: m.lane, name: m.name, title: clip(firstLine(last.cause) || "Its last turn", 140), why: clip(last.error ?? "It stopped with an error.", 300), ...where(p.sid), ...(last.endSeq ? { seq: last.endSeq } : {}) });
      // A question for the person nobody answered: its last turn ended on one, with no word from a person since.
      const answered = (after: number) => p.events.some((e) => e.seq > after && (e.lane ?? MAIN_LANE) === lane && e.body.type === "instruction" && e.actor.kind === "human");
      const asked = p.events.findLast((e) => (e.lane ?? MAIN_LANE) === lane && e.body.type === "agent.question" && e.ts >= since && e.ts <= until);
      if (asked?.body.type === "agent.question" && !answered(asked.seq)) brief.waiting.push({ lane: m.lane, name: m.name, text: clip(asked.body.question, 400), seq: asked.seq, ...where(p.sid) });
      else if (last && last.outcome === "done" && last.endedAt !== null && last.endedAt >= since && endsOnQuestion(last.said) && !answered(last.saidSeq))
        brief.waiting.push({ lane: m.lane, name: m.name, text: clip(last.said.split(/(?<=[.!?])\s+/).filter((s) => s.includes("?")).slice(-2).join(" ") || last.said, 400), seq: last.saidSeq, ...where(p.sid) });
    }
  }
  for (const m of mates) {
    const u = used.get(m.id);
    if (u && (u.turns || u.minutes)) brief.usage.push({ lane: m.lane, name: m.name, turns: u.turns, minutes: u.minutes, ...(u.tokens ? { tokens: u.tokens } : {}) });
  }
  return brief;
}

/**
 * The lead's wrap-up as one short line: the goal it landed (the person's last word to it before it said so), and the branch it
 * is on when it names one; its own last words only when no goal is to be found.
 */
function leadLine(events: readonly SessionEvent[], lane: string, r: LaneRun): string {
  const goal = events.findLast((e) => e.seq < r.saidSeq && (e.lane ?? MAIN_LANE) === lane && e.body.type === "instruction" && e.actor.kind === "human" && !e.body.approval && !e.body.text.startsWith("["));
  const said = [r.said, ...events.filter((e) => e.seq >= r.startSeq && e.seq <= r.saidSeq && (e.lane ?? MAIN_LANE) === lane && e.body.type === "mesh.posted").map((e) => (e.body.type === "mesh.posted" ? e.body.text : ""))].join("\n");
  const branch = branchIn(said);
  const what = goal?.body.type === "instruction" ? clip(firstLine(goal.body.text), 110) : clip(firstLine(r.said), 140);
  return branch ? `${what} · on ${branch}` : what;
}

/**
 * Whether a brief is worth posting (2026-10-28 away run: a brief for a 0-minute absence, and "Nothing to report" ones): something
 * to read in it, or the team at work through an absence of ten minutes or more.
 */
export const BRIEF_MIN_MS = 10 * 60_000;
export function briefWorthPosting(b: TeamBrief): boolean {
  if (b.done.length || b.failed.length || b.waiting.length || b.assumptions.length) return true;
  return b.until - b.since >= BRIEF_MIN_MS && b.usage.some((u) => u.turns > 0 || u.minutes > 0);
}

/** The brief in words, for the notification and for anyone reading the log as text. */
export function briefLine(b: TeamBrief): string {
  const parts = [
    b.done.length ? `${b.done.length} done` : "",
    b.failed.length ? `${b.failed.length} stopped short` : "",
    b.waiting.length ? `${b.waiting.length} waiting on you` : "",
    b.assumptions.length ? `${b.assumptions.length} assumption${b.assumptions.length === 1 ? "" : "s"} to check` : "",
  ].filter(Boolean);
  return parts.length ? `While you were away: ${parts.join(", ")}.` : "While you were away: nothing new.";
}

/**
 * Two agents going round in circles (Arun, 2026-10-28: the hourly turn budget replaced by loop detection): their last
 * LOOP_EXCHANGES messages to each other, within LOOP_WINDOW_MS, with no work done by either in between (a file changed, a
 * command or tool other than Friday's messaging), or the same message sent again. Null when they are working.
 */
export const LOOP_EXCHANGES = 6;
export const LOOP_WINDOW_MS = 30 * 60_000;
/** Friday's own messaging tools: calling them is talking, not working. */
const TALK = /^(?:mcp__friday__)?(?:message_agent|message_team|ask_agent|reply_to_agent|check_messages|post_update|wait_for_agent|list_agents|read_notes|list_tasks|wake_me_when|assign_task|steer_agent)$/;
const same = (a: string) => a.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 400);
export function loopBetween(events: readonly SessionEvent[], a: string, b: string, text: string, now = Date.now()): string | null {
  let exchanged = 0;
  const said: string[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.ts < now - LOOP_WINDOW_MS) break;
    const lane = e.lane ?? MAIN_LANE;
    if (lane !== a && lane !== b) continue;
    const body = e.body;
    // Work done by either since: they aren't only talking.
    if (body.type === "agent.diff" || body.type === "folder.committed") break;
    if (body.type === "agent.message" && body.toolCalls.some((c) => !TALK.test(c.name))) break;
    // A person's word to either is a new start.
    if (body.type === "instruction" && e.actor.kind === "human") break;
    if (body.type !== "instruction") continue;
    const from = body.mesh?.fromLane ?? body.handoff?.fromLane;
    if (!((from === a && lane === b) || (from === b && lane === a))) continue;
    exchanged++;
    said.push(same(body.text));
  }
  if (exchanged >= LOOP_EXCHANGES) return `${exchanged} messages back and forth with no work done in between`;
  const now2 = same(text);
  if (now2.length > 20 && said.slice(0, 3).filter((s) => s === now2).length >= 1 && exchanged >= 2) return "the same message again, with no work done since it was last sent";
  return null;
}

/** What is news in a team chat besides a run's end (its unread mark): a question, an update, a switch, a change, the brief. */
const NEWS = new Set(["agent.question", "mesh.posted", "teammate.switched", "teammate.folders", "teammate.changed", "teammate.proposed", "team.brief"]);

/**
 * The seq of a team chat's latest news, for its unread mark: what the room shows the person, not every run that ended (2026-10-28
 * audit: a teammate's turn on the team's own work, folded away in the room, marked it unread). A run's end is news when the run
 * said something or changed files and it answered the person (one of its messages was theirs), or a check-in with something
 * new, or it is the lead's, or it stopped on an error or waits on them. `quiet` are check-ins with nothing new (quietCheckIns).
 */
export function roomNews(events: readonly SessionEvent[], lead: string | null | undefined, quiet: ReadonlySet<number>): number {
  const persons = new Set<number>();
  /** Each lane's run under way: whether it answers the person, and whether it said or changed anything. */
  const run = new Map<string, { person: boolean; said: boolean }>();
  let news = 0;
  for (const e of events) {
    const lane = e.lane ?? MAIN_LANE;
    const b = e.body;
    if (b.type === "instruction" && e.actor.kind === "human" && !b.approval && !b.text.startsWith("[session]") && !b.text.startsWith("[Friday] ")) persons.add(e.seq);
    if (b.type === "instruction" && isCheckIn(b.text) && !quiet.has(e.seq)) persons.add(e.seq);
    if (b.type === "run.started") run.set(lane, { person: persons.has(b.causedBy), said: false });
    else if (b.type === "instructions.delivered") {
      const r = run.get(lane);
      if (r && b.seqs.some((q) => persons.has(q))) r.person = true;
    } else if ((b.type === "agent.message" && b.text.trim()) || (b.type === "agent.diff" && b.files.length)) {
      const r = run.get(lane);
      if (r) r.said = true;
    } else if (b.type === "run.ended") {
      const r = run.get(lane);
      run.delete(lane);
      if (quiet.has(e.seq) || b.cut) continue;
      if (b.outcome !== "done" || (r?.said && (r.person || lane === lead))) news = e.seq;
    }
    if (NEWS.has(b.type) && !quiet.has(e.seq)) news = e.seq;
  }
  return news;
}
