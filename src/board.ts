import { roleOf, type SessionState } from "./session/projection.js";
import type { PrStatus } from "./github-status.js";
import { doingNow } from "./activity-line.js";
import { ENGINE_NAMES, MAIN_LANE, type EngineTool, type SessionEvent } from "./types.js";
import { commandFailed, receiptOf } from "./receipt.js";
import { riskOf, type Risk, type RiskFacts } from "./review-risk.js";

/**
 * Every agent that is working for you, as cards on a board.
 *
 * One card per agent (the main one and each lane), read from the session's own log: whether it is running, whether it is
 * waiting on a person, what it last shipped. Nothing here is stored. It is the same events the session shows, arranged
 * by what a person would do next, which is the point of a board: not "what is happening" but "where do I look".
 */

export type BoardColumn = "working" | "needs" | "review" | "ready" | "idle";

/** One line about a whole session, for its row in the sessions list: its most pressing agent, and how many are running. */
export type SessionSummary = BoardCard & { running: number };

const URGENCY: Record<BoardColumn, number> = { needs: 0, working: 1, review: 2, ready: 3, idle: 4 };

/** What a session's row says: the agent most in need of a look (waiting on you, then working, then in review, then ready), the latest first. */
export function summaryOf(cards: BoardCard[]): SessionSummary | null {
  if (!cards.length) return null;
  const top = [...cards].sort((a, b) => URGENCY[a.column] - URGENCY[b.column] || b.at - a.at)[0]!;
  return { ...top, running: cards.filter((c) => c.column === "working").length };
}

export interface BoardCard {
  /** `${sid}|${lane}`, stable between polls so a card keeps its place. */
  id: string;
  sid: string;
  lane: string;
  /** The session's title. */
  title: string;
  /** What this agent was last asked, when it was asked anything. */
  task: string;
  /** Who is doing it: an agent's name, or somebody's Claude Code, Codex or Cursor. */
  agent: string;
  tool: EngineTool | null;
  column: BoardColumn;
  /** The state, in two or three words: "Working", "Asked you", "Review pending". */
  status: string;
  /** What that means, in a line, when there is more to say. */
  detail: string;
  branch: string;
  /** Files changed and not yet committed. */
  files: number;
  pr: { url: string; number: number | null } | null;
  /** The pull request the session was started from, when it was: Code Review links it back to the session working on it. */
  prFrom?: string;
  /** Friday is seeing that pull request through to merge: the last thing it did, or that it is watching. */
  shepherd?: string;
  /** When this agent last did or was asked something. */
  at: number;
  /** Whether it is waiting on this person in particular. */
  you: boolean;
  /** Whether this person is the one driving this agent, for what only a driver can act on. */
  mine: boolean;
  /** What GitHub says about the pull request, when it could be asked. */
  gh?: PrStatus;
  /** Who is in this session right now, and whether an agent is waiting on them. */
  people?: { id: string; name: string; waiting: boolean }[];
  /** What is known about the work it is handing over, read from the log: the files, the tests, the receipt, the second review. */
  review?: RiskFacts;
  /** How risky that work is to wave through (review-risk.ts), with the pull request's checks once GitHub has said. */
  risk?: Risk;
}

/** The most files a card carries for its score: enough to find the sensitive one, not a whole tree on every poll. */
const MAX_FACT_FILES = 80;

/**
 * The work an agent is handing over, as facts a risk score can be read from.
 *
 * Which work: with changes not yet committed, everything since the last commit; otherwise the commits that make its latest
 * pull request (or its latest commit, without one), back to the commit before them. In that stretch: the files its runs
 * changed (each file's newest diff), the commands it ran and whether its tests passed (receipt.ts), and what the second
 * reviewer last said. Null when it changed nothing anyone can see.
 */
export function reviewFacts(mine: SessionEvent[], uncommitted: boolean): RiskFacts | null {
  const commits = mine.map((e, i) => ({ e, i })).filter(({ e }) => e.body.type === "folder.committed" && !e.body.error);
  let from = 0;
  let to = mine.length;
  if (uncommitted) from = (commits.at(-1)?.i ?? -1) + 1;
  else if (commits.length) {
    const last = commits.at(-1)!;
    const pr = last.e.body.type === "folder.committed" ? last.e.body.prUrl : undefined;
    let k = commits.length - 1;
    while (pr && k > 0 && commits[k - 1]!.e.body.type === "folder.committed" && (commits[k - 1]!.e.body as { prUrl?: string }).prUrl === pr) k--;
    from = k > 0 ? commits[k - 1]!.i + 1 : 0;
    to = last.i + 1;
  }
  const span = mine.slice(from, to);

  const files = new Map<string, { path: string; status: "added" | "modified" | "deleted" | "renamed"; additions: number; deletions: number; patch: string }>();
  for (const e of span) {
    if (e.body.type === "agent.diff") for (const f of e.body.files) files.set(f.path, { path: f.path, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch });
    else if (e.body.type === "folder.edited" && !files.has(e.body.path)) files.set(e.body.path, { path: e.body.path, status: "modified", additions: 0, deletions: 0, patch: "" });
  }
  if (!files.size) return null;

  const calls = span.flatMap((e) => (e.body.type === "agent.message" ? e.body.toolCalls : []));
  const results = new Map<string, boolean | null>();
  for (const e of span) if (e.body.type === "tool.result") results.set(e.body.callId, commandFailed(e.body));
  const answer = span.findLast((e) => e.body.type === "agent.message" && !!e.body.text.trim());
  const receipt = receiptOf({ calls, failed: (id) => results.get(id) ?? null, files: [...files.values()], ...(answer?.body.type === "agent.message" ? { answer: answer.body.text } : {}) });
  const review = span.findLast((e) => e.body.type === "review.done");

  return {
    files: [...files.values()].slice(0, MAX_FACT_FILES).map(({ path, additions, deletions }) => ({ path, additions, deletions })),
    // Lines and files in all, so a change past the cap still weighs what it weighs.
    lines: [...files.values()].reduce((n, f) => n + f.additions + f.deletions, 0),
    fileCount: files.size,
    // No commands in the log at all says nothing about tests either way (a tool whose calls aren't mirrored here).
    ...(calls.length ? { tests: receipt.tests } : {}),
    ...(receipt.flags.length ? { flags: receipt.flags } : {}),
    ...(review?.body.type === "review.done" && review.body.findings.length ? { findings: review.body.findings } : {}),
  };
}

/** The members an agent in this session is waiting on: a question to them, a command for them to allow, a request for them to answer. */
export function waitingOn(state: SessionState): Set<string> {
  const ids = new Set<string>();
  for (const q of Object.values(state.openQuestions)) ids.add(q.to);
  for (const lane of Object.keys(state.approvals)) {
    const d = lane === MAIN_LANE ? state.driver : state.laneDrivers[lane];
    if (d) ids.add(d.id);
  }
  for (const r of state.pendingRequests) {
    const d = r.lane === MAIN_LANE ? state.driver : state.laneDrivers[r.lane];
    if (d) ids.add(d.id);
  }
  return ids;
}

const COLUMN_RANK: Record<BoardColumn, number> = { needs: 0, working: 1, review: 2, ready: 3, idle: 4 };

const clip = (t: string, n: number) => {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** The cards for one session, as seen by one person. */
export function boardCards(state: SessionState, events: SessionEvent[], meId: string): BoardCard[] {
  const lanes = [MAIN_LANE, ...state.lanes.map((l) => l.id)];
  const out: BoardCard[] = [];

  for (const lane of lanes) {
    const mine = events.filter((e) => (e.lane ?? MAIN_LANE) === lane);
    const engine = state.engines[lane];
    const tool = engine?.tool ?? null;
    const laneDef = state.lanes.find((l) => l.id === lane);

    const agent = tool
      ? // A tool a newer desktop app knows and this server doesn't yet is still named, by its id, rather than "undefined".
        `${engine!.hostName}'s ${ENGINE_NAMES[tool] ?? tool}`
      : lane === MAIN_LANE
        ? (state.options.agent?.name ?? "Friday Code")
        : (laneDef?.agent?.name ?? laneDef?.name ?? "Agent");

    // The last thing it was asked, then the last thing it did: either is "recently".
    const lastAsk = mine.findLast((e) => e.body.type === "instruction" && !e.body.approval && !e.body.text.startsWith("[session]"));
    const task = lastAsk && lastAsk.body.type === "instruction" ? clip(lastAsk.body.text, 140) : lane === MAIN_LANE && state.lastInstruction ? clip(state.lastInstruction.text, 140) : "";
    const at = mine.length ? mine[mine.length - 1]!.ts : 0;

    const commit = mine.findLast((e) => e.body.type === "folder.committed" && !e.body.error);
    const commitBody = commit && commit.body.type === "folder.committed" ? commit.body : null;
    const switched = mine.findLast((e) => e.body.type === "folder.switched");
    const branch = commitBody?.branch || (switched && switched.body.type === "folder.switched" ? switched.body.branch : "");

    // Uncommitted work: a CLI lane's reported change set, or the files Friday's agent has written since the last commit.
    const sinceCommit = commit ? mine.filter((e) => e.seq > commit.seq) : mine;
    const edited = new Set<string>();
    for (const e of sinceCommit) if (e.body.type === "folder.edited") edited.add(e.body.path);
    const files = state.diffs[lane]?.files.length ?? edited.size;

    const prUrl = commitBody?.prUrl ?? "";
    const pr = prUrl ? { url: prUrl, number: Number(/\/pull\/(\d+)/.exec(prUrl)?.[1]) || null } : null;
    const feedback = commit ? sinceCommit.findLast((e) => e.body.type === "pr.feedback") : undefined;

    const run = lane === MAIN_LANE ? state.run : (state.laneRuns[lane] ?? { status: "idle" as const, sinceSeq: 0 });
    const approval = state.approvals[lane];
    const driver = lane === MAIN_LANE ? state.driver : state.laneDrivers[lane];
    const driverIsMe = driver?.id === meId;
    const asks = state.pendingRequests.filter((r) => r.lane === lane);

    let column: BoardColumn = "idle";
    let status = "Idle";
    let detail = "";
    let you = false;

    if (run.status === "error") {
      column = "needs";
      status = "Stopped";
      detail = clip(run.error || "The run stopped.", 120);
      you = driverIsMe;
    } else if (approval) {
      column = "needs";
      status = "Wants to run a command";
      detail = clip(approval.items[0] ?? "A command needs a yes or a no.", 120);
      // Whose yes it is follows the toasts' rule (attention.ts): the lane's driver, or the owner when nobody drives it.
      you = driver ? driverIsMe : roleOf(state, meId) === "owner";
    } else if (state.openQuestions[lane]) {
      const q = state.openQuestions[lane];
      column = "needs";
      you = q.to === meId;
      status = you ? "Asked you" : `Asked ${q.toName}`;
      detail = clip(q.question, 120);
    } else if (run.status === "waiting_for_human") {
      column = "needs";
      status = "Waiting on a person";
    } else if (asks.length && driverIsMe) {
      column = "needs";
      status = "Control requested";
      detail = `${asks[0]!.name} wants the wheel`;
      you = true;
    } else if (feedback) {
      column = "needs";
      status = "Changes requested";
      detail = "Review comments are waiting for this agent";
      you = driverIsMe;
    } else if (run.status === "paused") {
      column = "needs";
      status = "Paused";
      detail = "Resume it to carry on";
      you = driverIsMe;
    } else if (run.status === "running") {
      column = "working";
      status = "Working";
      // Which kind of working: reading, editing, running the tests. A column of "Working" cards says nothing about which is stuck.
      detail = doingNow(events, lane)?.text ?? "";
    } else if (pr) {
      column = "review";
      status = "Review pending";
    } else if (files > 0) {
      column = "ready";
      status = "Changes ready";
      detail = `${files} file${files === 1 ? "" : "s"} to commit`;
    } else if (commitBody) {
      column = "ready";
      status = commitBody.pushed ? "Pushed" : "Committed";
      detail = commitBody.pushed ? "Open a pull request to ship it" : "Push it to share it";
    }

    const prFrom = lane === MAIN_LANE ? state.options.pr?.url : undefined;
    const watching = state.shepherd && state.shepherd.lane === lane ? state.shepherd : null;
    const step = watching ? mine.findLast((e) => e.seq > watching.since && e.body.type === "pr.shepherd.step") : undefined;
    const shepherd = watching ? (step && step.body.type === "pr.shepherd.step" ? clip(step.body.text, 120) : "Watching it") : undefined;
    // Only for work that is handed over or about to be: a running agent's half-done change has nothing to score yet.
    // The last diff outlives the commit that took it, so "files to commit" can be the committed work: then that is what is up.
    const review = pr || files > 0 || commitBody ? ((files > 0 && reviewFacts(mine, true)) || (commitBody ? reviewFacts(mine, false) : null)) : null;
    out.push({
      id: `${state.id}|${lane}`, sid: state.id, lane, title: state.title || "Untitled session", task, agent, tool, column, status, detail, branch, files, pr,
      ...(prFrom ? { prFrom } : {}), ...(shepherd ? { shepherd } : {}), at, you, mine: driverIsMe,
      ...(review ? { review, risk: riskOf(review) } : {}),
    });
  }
  return out;
}

/** Cards in the order a person would deal with them: what is waiting on them, then what is running, newest first. */
/** What this session did in the last week: whether it began, whether anything left it, how many runs it had. */
export function weekOf(events: SessionEvent[], now = Date.now(), days = 7): { created: boolean; shipped: boolean; runs: number } {
  const since = now - days * 86_400_000;
  const recent = events.filter((e) => e.ts >= since);
  return {
    created: (events[0]?.ts ?? 0) >= since,
    shipped: recent.some((e) => e.body.type === "folder.committed" && !e.body.error && !!(e.body.pushed || e.body.prUrl)),
    runs: recent.filter((e) => e.body.type === "run.ended").length,
  };
}

export function sortCards(cards: BoardCard[]): BoardCard[] {
  // Up for review or ready to ship, the riskiest change first: it is the one worth a person's fresh attention.
  const risky = (c: BoardCard) => (c.column === "review" || c.column === "ready" ? (c.risk?.score ?? -1) : 0);
  return [...cards].sort((a, b) => COLUMN_RANK[a.column] - COLUMN_RANK[b.column] || Number(b.you) - Number(a.you) || risky(b) - risky(a) || b.at - a.at);
}

/**
 * Put what GitHub says about a pull request onto its card.
 *
 * Merged and closed work is done, so it goes to Idle. After that the worst news wins: a conflict, failing checks or a change
 * request need a person; an approved, passing, mergeable pull request is ready to merge; the rest is waiting on review or on checks.
 */
export function applyPrStatus(card: BoardCard, gh: PrStatus): BoardCard {
  // The checks are part of the risk: a red check is the loudest reason there is.
  const next: BoardCard = { ...card, gh, ...(card.review ? { risk: riskOf({ ...card.review, checks: gh.checks }) } : {}) };
  const set = (column: BoardColumn, status: string, detail: string, you = card.mine) => Object.assign(next, { column, status, detail, you });
  if (gh.state === "merged") set("idle", "Merged", "", false);
  else if (gh.state === "closed") set("idle", "Closed", "", false);
  else if (gh.mergeable === false) set("needs", "Merge conflicts", "Resolve them to merge");
  else if (gh.checks === "failing") set("needs", "CI failed", "Checks are failing on the pull request");
  else if (gh.review === "changes_requested") set("needs", "Changes requested", "A reviewer asked for changes");
  else if (gh.draft) set("review", "Draft", "Not open for review yet", false);
  else if (gh.review === "approved" && gh.checks !== "pending") set("ready", "Ready to merge", gh.checks === "passing" ? "Approved, and checks pass" : "Approved", false);
  else if (gh.checks === "pending") set("review", "Checks running", gh.review === "approved" ? "Approved" : "Waiting on checks and review", false);
  else set("review", "Review pending", gh.checks === "passing" ? "Checks pass" : "", false);
  return next;
}
