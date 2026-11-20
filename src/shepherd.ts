import type { PrStatus } from "./github-status.js";
import { commandFailed, receiptOf } from "./receipt.js";
import { runOf, type SessionState } from "./session/projection.js";
import { MAIN_LANE, type DiffFile, type SessionEvent } from "./types.js";

/**
 * Seeing a pull request through to merge.
 *
 * After a person hands Friday the pull request, the slow part of shipping is the loop around it: a check goes red, a
 * reviewer leaves comments, somebody has to read the log or the comment, get the agent to fix it, commit, push, and wait
 * again. Friday runs that loop. This is the decision at each look: given the session and where the pull request stands,
 * what to do next. The app carries it out; nothing here touches GitHub or the folder.
 */

/** Who the loop acts as, in the log. */
export const FRIDAY = { id: "friday", name: "Friday", kind: "system" as const };

/** Rounds of failing checks Friday will hand to the agent before saying a person is needed. */
export const MAX_CHECK_ROUNDS = 3;
/** Tries at a conflict with the base branch before saying a person is needed. */
export const MAX_CONFLICT_ROUNDS = 2;
/** How long a finished run is given for its second review to start. */
export const REVIEW_GRACE_MS = 30_000;
/** How long after a push GitHub is given to start checking the new commit, so the old commit's red is not read as new. */
export const PUSH_SETTLE_MS = 90_000;
/** How long a pull request is watched before Friday stops on its own: a week is a review nobody is coming back to. */
export const MAX_WATCH_MS = 7 * 24 * 3_600_000;

export type ShepherdAction =
  | { kind: "wait"; why: string }
  | { kind: "end"; outcome: "merged" | "closed" | "stopped"; text: string }
  /** Commit and push what the agent changed since the hand-off at `since`. */
  | { kind: "push"; reason: "checks" | "comments" | "conflicts"; since: number }
  /** The pull request conflicts with its base: hand the agent the merge (Arun, 2026-11-19, pull request autopilot). */
  | { kind: "conflicts"; round: number }
  /** Read the failing checks and hand them to the agent. */
  | { kind: "checks"; round: number }
  /** Read the review comments and hand any new ones to the agent. */
  | { kind: "comments" };

const laneOf = (e: SessionEvent) => e.lane ?? MAIN_LANE;

export function shepherdNext(state: SessionState, events: SessionEvent[], status: PrStatus | null, now: number, opts: { reviewer: boolean }): ShepherdAction {
  const watch = state.shepherd;
  if (!watch) return { kind: "wait", why: "nothing to watch" };
  // A watch has an end: without one, a pull request nobody came back to was asked about every minute for ever.
  const started = events.find((e) => e.seq === watch.since)?.ts ?? now;
  if (now - started > MAX_WATCH_MS) return { kind: "end", outcome: "stopped", text: "Friday watched this pull request for a week and stopped. Press “See it through to merge” again to carry on." };
  if (!status) return { kind: "wait", why: "the pull request couldn't be read" };
  if (status.state === "merged") return { kind: "end", outcome: "merged", text: "Merged. Friday saw the pull request through." };
  if (status.state === "closed") return { kind: "end", outcome: "closed", text: "The pull request was closed, so Friday stopped watching it." };

  const lane = watch.lane;
  const run = runOf(state, lane).status;
  if (run === "running" || run === "paused" || run === "waiting_for_human" || state.approvals[lane]) return { kind: "wait", why: "the agent is busy" };
  const queued = lane === MAIN_LANE ? state.pendingInstructions.length : (state.lanePending[lane]?.length ?? 0);
  if (queued) return { kind: "wait", why: "the agent has work queued" };
  // A second review under way comes first: nothing is pushed past it.
  const reviewing = events.some((e) => e.body.type === "review.started" && !events.some((d) => d.body.type === "review.done" && d.body.runSeq === (e.body as { runSeq: number }).runSeq));
  if (reviewing) return { kind: "wait", why: "the change is being reviewed" };

  const mine = events.filter((e) => laneOf(e) === lane && e.seq > watch.since);
  const handOffs = mine.filter((e) => e.body.type === "pr.shepherd.step" && (e.body.step === "checks" || e.body.step === "comments" || e.body.step === "conflicts"));
  const lastHand = handOffs.at(-1);
  const lastCommit = events.findLast((e) => e.body.type === "folder.committed" && !e.body.error);
  // A push with no commit of Friday's: the agent's own merge of the base, pushed (app.ts, a resolved conflict).
  const lastPushed = mine.findLast((e) => e.body.type === "pr.shepherd.step" && e.body.step === "pushed");
  const doneAt = Math.max(lastCommit?.seq ?? 0, lastPushed?.seq ?? 0);

  // Work handed over and not yet pushed: see how it went.
  if (lastHand && lastHand.seq > doneAt) {
    const after = mine.filter((e) => e.seq > lastHand.seq);
    const ended = after.findLast((e) => e.body.type === "run.ended");
    if (!ended) return { kind: "wait", why: "the agent hasn't started on it" };
    if (ended.body.type === "run.ended" && ended.body.outcome === "error") {
      return { kind: "end", outcome: "stopped", text: `The agent stopped with an error while fixing the pull request${ended.body.error ? `: ${ended.body.error}` : ""}. A person needs to look.` };
    }
    const reason = lastHand.body.type === "pr.shepherd.step" && (lastHand.body.step === "comments" || lastHand.body.step === "conflicts") ? lastHand.body.step : "checks";
    const diff = after.findLast((e) => e.body.type === "agent.diff");
    const changed = diff?.body.type === "agent.diff" && diff.body.files.length > 0;
    if (changed) return pushOrStop(events, after, ended, diff, reason, lastHand.seq, now, opts);
    // Comments answered in words leave nothing to push, and the loop carries on watching. A red check can't be answered that way.
    if (reason === "checks") return { kind: "end", outcome: "stopped", text: "The agent didn't change anything for the failing checks. It may think they aren't caused by this change. A person needs to look." };
  }

  if (lastCommit && lastCommit.actor.id === FRIDAY.id && now - lastCommit.ts < PUSH_SETTLE_MS) return { kind: "wait", why: "GitHub is picking up the push" };
  if (lastPushed && now - lastPushed.ts < PUSH_SETTLE_MS) return { kind: "wait", why: "GitHub is picking up the push" };
  // A conflict with the base: the agent merges the base in, resolves it, runs the tests and pushes the merge itself (a merge commit
  // isn't a diff Friday can commit for it). Twice at most; a conflict it couldn't settle is a person's.
  if (status.mergeable === false) {
    const rounds = handOffs.filter((e) => e.body.type === "pr.shepherd.step" && e.body.step === "conflicts").length;
    if (rounds >= MAX_CONFLICT_ROUNDS) return { kind: "end", outcome: "stopped", text: `The pull request still conflicts with its base branch after ${MAX_CONFLICT_ROUNDS} tries. A person needs to resolve it.` };
    return { kind: "conflicts", round: rounds + 1 };
  }
  if (status.checks === "failing") {
    const rounds = handOffs.filter((e) => e.body.type === "pr.shepherd.step" && e.body.step === "checks").length;
    if (rounds >= MAX_CHECK_ROUNDS) return { kind: "end", outcome: "stopped", text: `The checks are still failing after ${MAX_CHECK_ROUNDS} fixes. A person needs to look.` };
    return { kind: "checks", round: rounds + 1 };
  }
  return { kind: "comments" };
}

/** A fix is waiting: push it, unless the second review or the run's receipt says a person should see it first. */
function pushOrStop(events: SessionEvent[], after: SessionEvent[], ended: SessionEvent, diff: SessionEvent | undefined, reason: "checks" | "comments" | "conflicts", since: number, now: number, opts: { reviewer: boolean }): ShepherdAction {
  if (opts.reviewer) {
    const review = events.findLast((e) => e.body.type === "review.done" && e.body.runSeq === ended.seq);
    if (!review && now - ended.ts < REVIEW_GRACE_MS) return { kind: "wait", why: "the fix is about to be reviewed" };
    // No review, or one that couldn't be read, is never a yes (Arun, 2026-11-13: "air tight"): a fix it never read isn't pushed.
    if (!review) return { kind: "end", outcome: "stopped", text: "The second review of the fix never came back, so Friday didn't push it. Have a look at the change." };
    if (review.body.type === "review.done" && review.body.error) return { kind: "end", outcome: "stopped", text: `Friday didn't push the fix: ${review.body.error.replace(/\.$/, "")}. Have a look at the change.` };
    if (review?.body.type === "review.done" && review.body.sent) return { kind: "wait", why: "the agent is fixing what the review found" };
    if (review?.body.type === "review.done" && review.body.findings.some((f) => f.severity !== "low")) {
      return { kind: "end", outcome: "stopped", text: "The second review still found problems in the fix, so Friday didn't push it. Have a look at the review on the change." };
    }
  }
  const results = new Map<string, boolean | null>();
  for (const e of after) if (e.body.type === "tool.result") results.set(e.body.callId, commandFailed(e.body));
  const receipt = receiptOf({
    calls: after.flatMap((e) => (e.body.type === "agent.message" ? e.body.toolCalls : [])),
    failed: (id) => (results.has(id) ? results.get(id)! : null),
    files: diff?.body.type === "agent.diff" ? diff.body.files : [],
  });
  // Its own tests failing after the fix: not pushed, whatever else the receipt says.
  if (receipt.tests === "fail") return { kind: "end", outcome: "stopped", text: "The fix's own tests failed, so Friday didn't push it. A person needs to look." };
  const bad = receipt.flags.find((f) => f.level === "bad");
  if (bad) return { kind: "end", outcome: "stopped", text: `Friday didn't push the fix: ${bad.text.replace(/\.$/, "")}. A person needs to look.` };
  return { kind: "push", reason, since };
}

export { commitPaths } from "./commit-paths.js";

/**
 * The branch a pull request is on, as this session knows it: the branch the commit that opened it went to, or the one
 * the session was started from. A fix is pushed only from there; the folder may have moved to another branch since.
 */
export function prBranch(state: SessionState, events: SessionEvent[], prUrl: string): string | null {
  const opened = events.findLast((e) => e.body.type === "folder.committed" && e.body.prUrl === prUrl && !e.body.error && !!e.body.branch);
  if (opened?.body.type === "folder.committed") return opened.body.branch;
  return state.options.pr?.url === prUrl && state.options.pr.head ? state.options.pr.head : null;
}

/** What a fix is committed as. */
export const fixMessage = (reason: "checks" | "comments" | "conflicts") => (reason === "checks" ? "Fix the failing checks" : reason === "conflicts" ? "Resolve conflicts with the base branch" : "Address review comments");

/** What the agent is told when the pull request conflicts with its base. */
export const conflictsText = (prUrl: string, base: string) =>
  [
    `The pull request ${prUrl} conflicts with its base branch, ${base || "the base branch"}. Resolve it on this branch:`,
    `1. git fetch origin, then git merge origin/${base || "<base>"} into this branch${base ? "" : ` (the base is gh pr view ${prUrl} --json baseRefName)`}. Merge, don't rebase: the branch is already pushed and may be shared.`,
    "2. Resolve every conflict keeping what both sides meant, not just one side. Read the other side's change before choosing.",
    "3. Run the project's tests and type checks; fix what the merge broke.",
    "4. Commit the merge and push this branch (never the base branch).",
    "Say in a sentence or two what conflicted and how you resolved it.",
  ].join("\n");

/** Comments from bots are not review: a deploy preview or a coverage report is not something to act on. */
export const fromPerson = (author: string) => !/\[bot\]$|^github-actions$/i.test(author);
