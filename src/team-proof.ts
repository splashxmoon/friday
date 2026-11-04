import { commandFailed, receiptOf, type ReceiptFlag } from "./receipt.js";
import { MAIN_LANE, type DiffFile, type SessionEvent } from "./types.js";

/**
 * Proof of work (Arun, 2026-10-31: check a teammate's results at a glance instead of reading logs). Every piece of work a
 * teammate finishes, a board task (a workflow's step is one) or a run of its own (a lead's goal), carries what shows it worked:
 * the checks that ran and how they went, what it changed, a picture of the page it touched where there is one, and its own short
 * review of what it did, what it checked and what is still uncertain. All of it read from the log; the review and the picture
 * are the teammate's (post_proof, proof.posted and proof.shot), the rest is Friday's record (board.checked, agent.diff, the
 * commands it ran). One reading for both editions and every place people check results: the board's cards, the room's results
 * shelf, a teammate's Results, the brief, and the reviewer's ask, which leads with it.
 */

/** The teammate's own account of the work, the last thing it writes before it hands the work in. */
export interface ProofReview {
  done: string;
  checked: string;
  unsure: string;
}

/** A check that ran: Friday's, run in the teammate's folder once it finished (board.checked), or one the teammate ran itself. */
export interface ProofCheck {
  command: string;
  ok: boolean;
  /** It couldn't be run there (no shell): neither passed nor failed. */
  skipped?: boolean;
  by: "friday" | "self";
  /** What a failed one printed, cut short. */
  output?: string;
  /** Tests that failed but were already failing at the commit the copy started from (baseline.ts): passed for all that. */
  pre?: number;
}

export interface ProofFile {
  path: string;
  status: DiffFile["status"];
  add: number;
  del: number;
}

/** The page the change touched: its address, and its picture where the teammate's computer could take one. */
export interface ProofPage {
  url: string;
  /** The picture, a file of the session `sid` (FileStore), when one was taken. */
  file?: string;
  sid?: string;
  width?: number;
  height?: number;
}

export interface Proof {
  /** The board task's id, or none for a run of its own. */
  task?: string;
  /** What the work was: the task's title, or what the run was asked. */
  title: string;
  lane: string;
  name: string;
  /** When it was handed in. */
  at: number;
  /** Its seq, to open it in the room. */
  seq: number;
  checks: ProofCheck[];
  /** What looks wrong in how it was checked (receipt.ts): a test switched off, a claim of passing with no test run. */
  flags: ReceiptFlag[];
  changed: { files: ProofFile[]; more: number; add: number; del: number };
  page?: ProofPage;
  review?: ProofReview;
  /** What a whole proof has and this lacks, for the person: "a self-review", "checks". */
  missing: string[];
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const laneOfEvent = (e: SessionEvent) => e.lane ?? MAIN_LANE;

/** The events with seq in [from, to], found by halving: logs are in seq order, and a teammate's Results reads hundreds of runs. */
export function between(events: readonly SessionEvent[], from: number, to: number): readonly SessionEvent[] {
  const first = (seq: number) => {
    let lo = 0;
    let hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (events[mid]!.seq < seq) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return events.slice(first(from), first(to + 1));
}

/** A command worth calling a check: tests, a typecheck, a lint or a build (agent-mesh factsOf reads the same). */
const CHECK_CMD = /\b(tsc|typecheck|lint|build|test|tests|jest|vitest|pytest|mocha|rspec|phpunit|playwright|cypress|go test|cargo test|cargo check|gradle|mvn)\b/i;

interface Stretch {
  lane: string;
  /** Where the work began and where it was handed in (inclusive). */
  from: number;
  to: number;
  /** How far on its review, its picture and Friday's checks may land: a proof posted just after finish_task still counts. */
  until: number;
  task?: string;
  title: string;
  name: string;
  sid?: string;
}

/** The proof over one stretch of a lane's work. */
function proofIn(events: readonly SessionEvent[], s: Stretch): Proof {
  const work = between(events, s.from, s.to).filter((e) => laneOfEvent(e) === s.lane);
  const after = between(events, s.from, s.until);
  const end = work.at(-1) ?? after.at(-1);
  // What it changed in the stretch: its last diff then, less the files exactly as they already stood before it began (a tool's
  // diff is everything since it attached, so an earlier task's files are in it too).
  const lastDiff = work.findLast((e) => e.body.type === "agent.diff");
  const before = events.findLast((e) => e.seq < s.from && laneOfEvent(e) === s.lane && e.body.type === "agent.diff");
  const had = new Map(before?.body.type === "agent.diff" ? before.body.files.map((f) => [f.path, `${f.status}:${f.additions}:${f.deletions}`]) : []);
  const diffFiles = lastDiff?.body.type === "agent.diff" ? lastDiff.body.files.filter((f) => had.get(f.path) !== `${f.status}:${f.additions}:${f.deletions}`) : [];
  const more = lastDiff?.body.type === "agent.diff" ? (lastDiff.body.more?.length ?? 0) : 0;
  // The commands it ran itself, as the receipt reads them, and what looks wrong in how it checked.
  const calls = work.flatMap((e) => (e.body.type === "agent.message" ? e.body.toolCalls : []));
  const results = new Map(work.flatMap((e) => (e.body.type === "tool.result" ? [[e.body.callId, e.body] as const] : [])));
  const said = work.findLast((e) => e.body.type === "agent.message" && e.body.text.trim());
  const receipt = receiptOf({
    calls,
    failed: (id) => {
      const r = results.get(id);
      return r ? commandFailed(r) : null;
    },
    files: diffFiles.map((f) => ({ ...f, patch: f.patch ?? "" })),
    answer: said?.body.type === "agent.message" ? said.body.text : "",
  });
  const self = new Map<string, ProofCheck>();
  for (const c of receipt.commands) if (CHECK_CMD.test(c.command)) self.set(c.command, { command: c.command, ok: c.ok, by: "self" });
  // Friday's own check of a board task, run in its folder once it was handed in: the one that counts, so first.
  const checked = s.task ? after.findLast((e) => e.body.type === "board.checked" && e.body.id === s.task) : undefined;
  const friday: ProofCheck[] = checked?.body.type === "board.checked" ? [{ command: checked.body.command, ok: checked.body.ok, by: "friday", ...(checked.body.skipped ? { skipped: true } : {}), ...(checked.body.pre?.length ? { pre: checked.body.pre.length } : {}), ...(!checked.body.ok && !checked.body.skipped ? { output: checked.body.output.slice(-600) } : {}) }] : [];
  const checks = [...friday, ...[...self.values()].filter((c) => c.command !== friday[0]?.command).slice(-4)];
  // Its review: the last it posted for this task, or, for a run of its own, the last it posted in the run with no task named.
  const posted = after.findLast((e) => e.body.type === "proof.posted" && laneOfEvent(e) === s.lane && (s.task ? e.body.id === s.task : !e.body.id));
  const review = posted?.body.type === "proof.posted" ? { done: posted.body.done, checked: posted.body.checked, unsure: posted.body.unsure } : undefined;
  const shot = posted ? after.findLast((e) => e.body.type === "proof.shot" && e.body.proof === posted.seq) : undefined;
  const page: ProofPage | undefined =
    posted?.body.type === "proof.posted" && posted.body.page
      ? { url: posted.body.page, ...(shot?.body.type === "proof.shot" ? { file: shot.body.file, ...(s.sid ? { sid: s.sid } : {}), ...(shot.body.width ? { width: shot.body.width, height: shot.body.height } : {}) } : {}) }
      : undefined;
  const missing = [!review ? "a self-review" : "", !checks.some((c) => !c.skipped) ? "checks" : ""].filter(Boolean);
  return {
    ...(s.task ? { task: s.task } : {}),
    title: s.title,
    lane: s.lane,
    name: s.name,
    at: end?.ts ?? 0,
    seq: s.to,
    checks,
    flags: receipt.flags,
    changed: { files: diffFiles.slice(0, 40).map((f) => ({ path: f.path, status: f.status, add: f.additions, del: f.deletions })), more: Math.max(0, diffFiles.length - 40) + more, add: diffFiles.reduce((n, f) => n + f.additions, 0), del: diffFiles.reduce((n, f) => n + f.deletions, 0) },
    ...(page ? { page } : {}),
    ...(review ? { review } : {}),
    missing,
  };
}

/**
 * A board task's proof as of one hand-in (its board.finished): from when it was taken to when it was handed in, with its review,
 * picture and Friday's checks up to whenever it was taken again. `sid`: the session, for its picture.
 */
function finishProof(events: readonly SessionEvent[], done: SessionEvent, sid?: string): Proof | null {
  if (done.body.type !== "board.finished") return null;
  const id = done.body.id;
  const posted = events.findLast((e) => e.seq < done.seq && e.body.type === "board.posted" && e.body.tasks.some((t) => t.id === id));
  const took = events.findLast((e) => e.seq < done.seq && e.seq > (posted?.seq ?? 0) && e.body.type === "board.claimed" && e.body.id === id);
  const again = events.find((e) => e.seq > done.seq && (e.body.type === "board.claimed" || e.body.type === "board.posted") && (e.body.type === "board.posted" || e.body.id === id));
  return proofIn(events, { lane: done.body.lane, from: took?.seq ?? done.seq, to: done.seq, until: again ? again.seq - 1 : Number.MAX_SAFE_INTEGER, task: id, title: (posted?.body.type === "board.posted" ? posted.body.tasks.find((t) => t.id === id)?.title : undefined) ?? id, name: done.body.name, ...(sid ? { sid } : {}) });
}

/** A board task's proof as of one hand-in (its board.finished event). */
export const handInProof = (events: readonly SessionEvent[], finished: SessionEvent, sid?: string): Proof | null => finishProof(events, finished, sid);

/** A board task's proof, as of its latest hand-in; null for a task never handed in. */
export function taskProof(events: readonly SessionEvent[], id: string, sid?: string): Proof | null {
  const done = events.findLast((e) => e.body.type === "board.finished" && e.body.id === id);
  return done ? finishProof(events, done, sid) : null;
}

/**
 * A run's proof: the board task it handed in, when it did one; otherwise its own (a lead's goal, work asked of it in the room),
 * over the run, with what it posted without naming a task. `title`: what the run was asked.
 */
export function runProof(events: readonly SessionEvent[], run: { lane: string; startSeq: number; endSeq: number | null }, title: string, name: string, sid?: string): Proof {
  const to = run.endSeq ?? events.at(-1)?.seq ?? run.startSeq;
  const inRun = between(events, run.startSeq, to);
  const handed = inRun.findLast((e) => e.body.type === "board.finished" && e.body.lane === run.lane && e.body.status === "done");
  const task = handed?.body.type === "board.finished" ? taskProof(events, handed.body.id, sid) : null;
  if (task) return task;
  const next = events.find((e) => e.seq > to && laneOfEvent(e) === run.lane && e.body.type === "run.started");
  return proofIn(events, { lane: run.lane, from: run.startSeq, to, until: next ? next.seq - 1 : Number.MAX_SAFE_INTEGER, title, name, ...(sid ? { sid } : {}) });
}

/**
 * Everything handed in with proof in one log, newest first, for the room's results shelf: each board task handed in as done
 * (once, as of its latest), and each run a teammate posted proof for without a task. `names`: a lane's teammate, by lane.
 */
export function proofsIn(events: readonly SessionEvent[], sid?: string, name: (lane: string) => string | undefined = () => undefined): Proof[] {
  /** Each board's tasks handed in as done, by the board (its post's seq) and id: the latest hand-in of each. */
  const tasks = new Map<string, SessionEvent>();
  let board = 0;
  const runs: { lane: string; startSeq: number; endSeq: number | null; cause: string; proof: boolean }[] = [];
  const open = new Map<string, (typeof runs)[number]>();
  const asked = new Map<number, string>();
  for (const e of events) {
    const b = e.body;
    const lane = laneOfEvent(e);
    if (b.type === "instruction") asked.set(e.seq, b.text);
    else if (b.type === "board.posted") board = e.seq;
    else if (b.type === "board.finished") {
      if (b.status === "done") tasks.set(`${board}:${b.id}`, e);
      else tasks.delete(`${board}:${b.id}`);
    } else if (b.type === "run.started") {
      const r = { lane, startSeq: e.seq, endSeq: null, cause: asked.get(b.causedBy) ?? "", proof: false };
      open.set(lane, r);
      runs.push(r);
    } else if (b.type === "run.ended") {
      const r = open.get(lane);
      if (r) r.endSeq = e.seq;
      open.delete(lane);
    } else if (b.type === "proof.posted" && !b.id) {
      // Posted between turns, it is the last run's.
      const r = open.get(lane) ?? runs.findLast((x) => x.lane === lane);
      if (r) r.proof = true;
    }
  }
  const out = [
    ...[...tasks.values()].flatMap((e) => finishProof(events, e, sid) ?? []),
    ...runs.filter((r) => r.proof).map((r) => runProof(events, r, firstWords(r.cause) || "Its work", name(r.lane) ?? r.lane, sid)),
  ];
  // A run that handed in a board task is that task's proof once.
  const seen = new Set<string>();
  return out.filter((p) => !seen.has(`${p.task ?? ""}:${p.seq}`) && !!seen.add(`${p.task ?? ""}:${p.seq}`)).sort((a, b) => b.seq - a.seq);
}

/** An instruction's opening, as a title: its first line with words, Friday's own bracketed lead-ins gone. */
const firstWords = (text: string) => clip((text.split("\n").find((l) => l.replace(/^\[[^\]]*\]\s*/, "").trim()) ?? "").replace(/^\[[^\]]*\]\s*/, "").replace(/[*_`#>]/g, ""), 120);

/** "Checks pass · 3 files +40 −2 · picture · self-reviewed": a proof in one line. */
export function proofSummary(p: Proof): string {
  const failed = p.checks.find((c) => !c.ok && !c.skipped);
  const ran = p.checks.filter((c) => !c.skipped);
  const parts = [
    failed ? "Checks failed" : ran.length ? "Checks pass" : "No checks run",
    p.changed.files.length ? `${p.changed.files.length + p.changed.more} file${p.changed.files.length + p.changed.more === 1 ? "" : "s"} +${p.changed.add} −${p.changed.del}` : "No files changed",
    p.page?.file ? "picture" : "",
    p.review ? "self-reviewed" : "no self-review",
  ];
  return parts.filter(Boolean).join(" · ");
}

/** What a task handed in without proof is said to lack, or "" for one with it. */
export function missingLine(p: Proof): string {
  return p.missing.length ? `Handed in without ${p.missing.join(" or ")}.` : "";
}

/** The proof as text: what the reviewer reads first, and the brief as words. */
export function proofText(p: Proof): string {
  const lines = [
    `Proof, from ${p.name}${p.review ? "" : " (no self-review: it didn't post_proof)"}:`,
    p.review ? `- Done: ${clip(p.review.done, 600)}\n- Checked: ${clip(p.review.checked, 600)}\n- Still uncertain: ${clip(p.review.unsure, 600)}` : "",
    p.checks.length ? `- Checks: ${p.checks.map((c) => `\`${clip(c.command, 80)}\` ${c.skipped ? "couldn't run" : c.ok ? "passed" : "failed"}${c.by === "friday" ? " (run by Friday in its folder)" : ""}`).join("; ")}` : "- Checks: none ran",
    p.changed.files.length ? `- Changed: ${p.changed.files.slice(0, 10).map((f) => `${f.path} +${f.add} −${f.del}`).join(", ")}${p.changed.files.length + p.changed.more > 10 ? `, and ${p.changed.files.length + p.changed.more - 10} more` : ""}` : "- Changed: no files",
    p.page ? `- Page: ${p.page.url}${p.page.file ? " (a picture is with the proof)" : ""}` : "",
    p.flags.length ? `- Look out: ${p.flags.map((f) => f.text).join("; ")}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/** A proof small enough to keep in a brief (team.brief is kept in the log): failed checks' output and long lists cut. */
export function briefProof(p: Proof): Proof {
  return { ...p, checks: p.checks.map(({ output, ...c }) => (output ? { ...c, output: output.slice(-300) } : c)), changed: { ...p.changed, files: p.changed.files.slice(0, 12), more: p.changed.more + Math.max(0, p.changed.files.length - 12) } };
}
