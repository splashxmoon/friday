import { useState, type ReactNode } from "react";
import { commandFailed, TEST_CMD, type Receipt } from "../receipt.js";
import type { DiffFile, ReviewFinding, SessionEvent } from "../types.js";
import { driverOf, type SessionState } from "../session/projection.js";
import { MAIN_LANE, type Member } from "../types.js";
import { argsOf } from "./args.js";
import { Icon } from "./icons.js";
import { MenuButton, useConfirm } from "./ui.js";
import { ShipDialog, type Dest } from "./Ship.js";
import type { Send } from "./useSession.js";
import { prefillComposer } from "./prefill.js";
export { prefillComposer };

/**
 * The end of a run, as one decision.
 *
 * A run used to end with a diff and a scatter of small links. What people are
 * actually deciding is three things — keep this, change this, or throw it away —
 * so those are the buttons, with the facts that decide it on the same line: how
 * much changed and whether the tests passed. Everything here is read from the
 * log, so it is right after a refresh and for anyone who joins later.
 */

export interface TestRun {
  status: "pass" | "fail";
  command: string;
  /** Its failures against the commit the copy started from (baseline.ts, tests.base), once Friday has worked that out. */
  base?: { pre: string[]; fresh: string[]; whole?: boolean };
}

/** The chip's words for a failed run, told apart from what was failing before it began (baseline.ts). */
export function failedWords(t: TestRun): { text: string; pre: boolean; title: string } {
  const b = t.base;
  if (!b || (!b.pre.length && !b.whole)) return { text: "Tests failed", pre: false, title: t.command };
  const was = b.pre.length ? `Failing before this change too:\n${b.pre.slice(0, 12).join("\n")}${b.pre.length > 12 ? "\n…" : ""}` : "It fails before this change too.";
  if (!b.fresh.length) return { text: b.pre.length ? `Tests: only the ${b.pre.length} failing before` : "Tests: failing before too", pre: true, title: `${t.command}\n\n${was}` };
  return { text: `Tests failed · ${b.fresh.length} new, ${b.pre.length} from before`, pre: false, title: `${t.command}\n\nNew:\n${b.fresh.slice(0, 12).join("\n")}\n\n${was}` };
}

type CallLike = { id: string; name: string; arguments: string };

/** The test commands among these calls, judged by their most recent attempt: a fix that passed on the second go passes. */
export function testsIn(calls: CallLike[], failed: (callId: string) => boolean | null): TestRun | null {
  const last = new Map<string, TestRun>();
  for (const c of calls) {
    if (c.name !== "run_command" && c.name !== "shell") continue;
    let command = "";
    try {
      command = String(argsOf(c).command ?? "").trim();
    } catch {
      continue;
    }
    if (!command || !TEST_CMD.test(command)) continue;
    const f = failed(c.id);
    if (f === null) continue;
    last.set(command, { status: f ? "fail" : "pass", command });
  }
  const all = [...last.values()];
  if (!all.length) return null;
  return all.find((t) => t.status === "fail") ?? all.at(-1)!;
}

/** The newest test result anywhere in the session, for the dot in the header. */
export function latestTests(events: SessionEvent[]): TestRun | null {
  const results = new Map<string, boolean | null>();
  for (const e of events) if (e.body.type === "tool.result") results.set(e.body.callId, commandFailed(e.body));
  let found: TestRun | null = null;
  for (const e of events) {
    if (e.body.type !== "agent.message") continue;
    const t = testsIn(e.body.toolCalls, (id) => results.get(id) ?? null);
    if (t) found = t;
  }
  return found;
}


const duration = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

/** "12 steps · 2m 14s": what the run cost in the two things people notice. */
export function RunSummary({ steps, from, to }: { steps: number; from?: number; to: number }) {
  if (!steps) return null;
  return (
    <div className="rsp-summary">
      {steps} step{steps === 1 ? "" : "s"}
      {from ? ` · ${duration(to - from)}` : ""}
    </div>
  );
}

/**
 * The evidence under the run's own account of itself.
 *
 * Closed, it is one line: what ran and whether anything looks off. Flags are
 * shown whether or not it is open, because the point of a receipt is that the
 * bad news cannot be skipped by not clicking.
 */
function ReceiptView({ receipt }: { receipt: Receipt }) {
  const [open, setOpen] = useState(false);
  const ran = receipt.commands.length;
  const bad = receipt.flags.some((f) => f.level === "bad");
  return (
    <div className={`receipt ${bad ? "bad" : receipt.flags.length ? "warn" : "ok"}`}>
      {receipt.flags.map((f) => (
        <div key={f.text} className={`receipt-flag ${f.level}`}>
          <Icon name={f.level === "bad" ? "x" : "help"} size={13} /> {f.text}
        </div>
      ))}
      {ran > 0 && (
        <button type="button" className="receipt-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <Icon name={open ? "chevronDown" : "chevronRight"} size={12} /> Receipt · {ran} command{ran === 1 ? "" : "s"} ran
          {receipt.tests !== "none" ? ` · tests ${receipt.tests === "pass" ? "passed" : "failed"}` : ""}
        </button>
      )}
      {open && (
        <ul className="receipt-list">
          {receipt.commands.map((c, i) => (
            <li key={i} className={c.ok ? "ok" : "fail"}>
              <Icon name={c.ok ? "check" : "x"} size={12} /> <code>{c.command}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What the second agent made of a run's change: still reading, nothing found, sent back to fix, or left for the person. */
export type SecondReview = { state: "reviewing" | "clean" | "sent" | "open" | "skipped"; findings: ReviewFinding[]; round: number; note?: string };

export function secondReviewOf(events: SessionEvent[], endSeq: number): SecondReview | null {
  const done = events.findLast((e) => e.body.type === "review.done" && e.body.runSeq === endSeq);
  if (done?.body.type === "review.done") {
    const { findings, round, sent, error } = done.body;
    if (error) return { state: "skipped", findings: [], round, note: error };
    if (sent) return { state: "sent", findings: findings.filter((f) => f.severity !== "low"), round };
    if (findings.some((f) => f.severity !== "low")) return { state: "open", findings, round };
    return { state: "clean", findings, round };
  }
  const started = events.find((e) => e.body.type === "review.started" && e.body.runSeq === endSeq);
  return started?.body.type === "review.started" ? { state: "reviewing", findings: [], round: started.body.round } : null;
}

/** What can be done about one finding, from the card: hand it to the agent, ask it, or set it aside. */
type FindingAct = "fix" | "ask" | "dismiss";
/** Who a finding goes to: the agent itself when you may drive it, its driver as a suggestion when you may suggest. */
type Via = "instruct" | "suggest" | null;

export function findingText(f: ReviewFinding, act: "fix" | "ask"): string {
  const where = f.path ? ` (${f.path}${f.line ? `:${f.line}` : ""})` : "";
  const what = `${f.title}${where}${f.detail ? `: ${f.detail}` : ""}`;
  return act === "fix"
    ? `The second review found a problem. Fix it, and say what you changed.\n\n${what}`
    : `The second review raised this. Is it a real problem here? Explain why or why not, and don't change anything yet.\n\n${what}`;
}

/** Findings set aside on this computer, by run and title: a dismissal is yours, not the room's. */
const DISMISSED = "mpa.dismissedFindings";
const dismissedKeys = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISSED) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
const keyOf = (sid: string, endSeq: number, f: ReviewFinding) => `${sid}:${endSeq}:${f.title}`;

function Findings({ findings, acts }: { findings: ReviewFinding[]; acts?: { via: Via; done: Record<string, FindingAct>; act: (f: ReviewFinding, a: FindingAct) => void; keyOf: (f: ReviewFinding) => string; lone: boolean } }) {
  return (
    <ul className="sr-findings">
      {findings.map((f, i) => {
        const done = acts?.done[acts.keyOf(f)];
        return (
          <li key={i} className={`sev-${f.severity}`}>
            <span className="sr-sev">{f.severity}</span>
            <span className="sr-body">
              <b>{f.title}</b>
              {f.path && (
                <code>
                  {f.path}
                  {f.line ? `:${f.line}` : ""}
                </code>
              )}
              {f.detail && <span className="sr-detail">{f.detail}</span>}
            </span>
            {acts?.via &&
              (done === "fix" || done === "ask" ? (
                <span className="sr-done">
                  <Icon name="check" size={12} /> {acts.via === "instruct" ? (done === "fix" ? "Sent to fix" : "Asked") : "Suggested"}
                </span>
              ) : (
                <span className="sr-acts">
                  <button type="button" className="sr-act" title="Hide this finding" aria-label={`Dismiss: ${f.title}`} onClick={() => acts.act(f, "dismiss")}>
                    <Icon name="x" size={13} />
                  </button>
                  <button type="button" className="btn ghost small" onClick={() => acts.act(f, "ask")}>
                    Ask why
                  </button>
                  <button type="button" className={`btn small ${acts.lone ? "primary" : "ghost sr-fix"}`} onClick={() => acts.act(f, "fix")}>
                    {acts.via === "instruct" ? "Fix this" : "Suggest a fix"}
                  </button>
                </span>
              ))}
          </li>
        );
      })}
    </ul>
  );
}

/** The second agent's verdict, on the change it read. */
function SecondReviewView({ r, via, lane, sid, endSeq, send, notify }: { r: SecondReview; via: Via; lane: string; sid: string; endSeq: number; send: Send; notify?: (m: string) => void }) {
  const [open, setOpen] = useState(r.state === "open");
  const [done, setDone] = useState<Record<string, FindingAct>>(() => Object.fromEntries(dismissedKeys().filter((k) => k.startsWith(`${sid}:${endSeq}:`)).map((k) => [k, "dismiss" as const])));
  const [showDismissed, setShowDismissed] = useState(false);
  const key = (f: ReviewFinding) => keyOf(sid, endSeq, f);
  const act = async (f: ReviewFinding, a: FindingAct) => {
    if (a === "dismiss") {
      try {
        localStorage.setItem(DISMISSED, JSON.stringify([...dismissedKeys().filter((k) => k !== key(f)), key(f)].slice(-500)));
      } catch {
        /* this page only */
      }
      return setDone((d) => ({ ...d, [key(f)]: "dismiss" }));
    }
    if (!via) return;
    const res = await send({ type: via, text: findingText(f, a), ...(lane !== MAIN_LANE ? { lane } : {}) });
    if (res.ok) setDone((d) => ({ ...d, [key(f)]: a }));
    else notify?.(res.error ?? "That didn't send. Try again.");
  };
  const shown = (fs: ReviewFinding[]) => (showDismissed ? fs : fs.filter((f) => done[key(f)] !== "dismiss"));
  const hidden = r.findings.filter((f) => done[key(f)] === "dismiss").length;
  // One white button per box: "Fix all" when there are several to fix, the finding's own "Fix this" when it is the only one.
  const undecided = r.findings.filter((f) => !done[key(f)]).length;
  const acts = { via, done, act: (f: ReviewFinding, a: FindingAct) => void act(f, a), keyOf: key, lone: undecided <= 1 || r.state !== "open" };
  const restore = hidden > 0 && (
    <button type="button" className="link-btn sr-hidden" aria-expanded={showDismissed} onClick={() => setShowDismissed((v) => !v)}>
      {showDismissed ? "Hide dismissed" : `${hidden} dismissed`}
    </button>
  );
  const n = r.findings.length;
  const notes = r.findings.filter((f) => f.severity === "low");
  if (r.state === "reviewing")
    return (
      <p className="sr-line sr-reviewing" role="status">
        <span className="sr-spin" aria-hidden /> A second agent is reading this change{r.round === 2 ? " again, after the fix" : ""}…
      </p>
    );
  if (r.state === "skipped") return <p className="sr-line muted">{r.note}</p>;
  if (r.state === "clean")
    return (
      <div className="sr-block sr-ok">
        <p className="sr-line">
          <Icon name="shield" size={13} /> {r.round === 2 ? "Read again after the fix: no problems left." : "A second agent read this change and found no problems."}
          {notes.length > 0 && (
            <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              {notes.length} small note{notes.length === 1 ? "" : "s"}
            </button>
          )}
        </p>
        {open && notes.length > 0 && <Findings findings={shown(notes)} acts={acts} />}
        {open && restore}
      </div>
    );
  if (r.state === "sent")
    return (
      <div className="sr-block sr-sent">
        <p className="sr-line">
          <Icon name="shield" size={13} /> A second agent found {n} problem{n === 1 ? "" : "s"} and sent {n === 1 ? "it" : "them"} back to the agent to fix.
          <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? "Hide" : "What it found"}
          </button>
        </p>
        {open && <Findings findings={r.findings} />}
      </div>
    );
  const serious = r.findings.filter((f) => f.severity !== "low").length;
  // Everything still open, not yet handed over or set aside: one press sends them together.
  const left = r.findings.filter((f) => f.severity !== "low" && !done[key(f)]);
  const fixAll = async () => {
    if (!via || !left.length) return;
    const text = `The second review found ${left.length} problems. Fix each, and say what you changed.\n\n${left.map((f, i) => `${i + 1}. ${findingText(f, "fix").split("\n\n")[1]}`).join("\n")}`;
    const res = await send({ type: via, text, ...(lane !== MAIN_LANE ? { lane } : {}) });
    if (res.ok) setDone((d) => ({ ...d, ...Object.fromEntries(left.map((f) => [key(f), "fix" as const])) }));
    else notify?.(res.error ?? "That didn't send. Try again.");
  };
  return (
    <div className="sr-block sr-open">
      <div className="sr-head">
        <p className="sr-line">
          <Icon name="shield" size={13} /> {r.round === 2 ? `The second review still found ${serious} problem${serious === 1 ? "" : "s"} after the fix.` : `A second agent found ${serious} problem${serious === 1 ? "" : "s"}.`} Worth a look before you accept.
        </p>
        {via && left.length > 1 && (
          <button type="button" className="btn primary small" onClick={() => void fixAll()}>
            {via === "instruct" ? `Fix all ${left.length}` : `Suggest fixing all ${left.length}`}
          </button>
        )}
      </div>
      <Findings findings={shown(r.findings)} acts={acts} />
      {restore}
    </div>
  );
}

/** Rows of a file's mini diff opened, by session, agent, run and file, so one opened stays open while the chat redraws. */
const openRows = new Set<string>();
/** Cards opened by hand, by session, agent and run: every card starts folded, and one opened stays open while the chat redraws. */
const opened = new Set<string>();
/** How many of a file's changed lines a mini diff shows before "Open in Changes". */
const MINI_LINES = 8;
/** How many files a card lists before "N more". */
const PEEK = 5;

/** The first lines of a file's patch that changed, numbered as the new file has them, for a card's mini diff. */
export function miniDiff(patch: string, max = MINI_LINES): { lines: { kind: "add" | "del" | "ctx" | "hunk"; n: number | null; text: string }[]; changed: number } {
  const lines: { kind: "add" | "del" | "ctx" | "hunk"; n: number | null; text: string }[] = [];
  let next = 0;
  let changed = 0;
  let shown = 0;
  for (const raw of patch.split(/\r?\n/)) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (h) {
      next = Number(h[1]);
      if (shown < max) lines.push({ kind: "hunk", n: null, text: h[2]!.trim() ? `@@ ${h[2]!.trim()} @@` : "@@" });
      continue;
    }
    if (!next || raw.startsWith("\\") || raw.startsWith("+++") || raw.startsWith("---")) continue;
    const c = raw[0];
    if (c === "+" || c === "-") changed++;
    if (shown >= max) {
      if (c !== "-") next++;
      continue;
    }
    if (c === "+") (lines.push({ kind: "add", n: next++, text: raw.slice(1) }), shown++);
    else if (c === "-") (lines.push({ kind: "del", n: next, text: raw.slice(1) }), shown++);
    else if (shown > 0 && lines.at(-1)?.kind !== "ctx") lines.push({ kind: "ctx", n: next++, text: raw.slice(1) });
    else next++;
  }
  while (lines.length && (lines.at(-1)!.kind === "ctx" || lines.at(-1)!.kind === "hunk")) lines.pop();
  return { lines, changed };
}

const LETTER: Record<DiffFile["status"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };

/**
 * What a reply changed, under it (Arun, 2026-11-03: "how herdr, devin, etc show their files changed in the chat … make this more
 * refined and nicer", then "Build it"): one card per reply with this turn's own files, not the folder's running total (Codex's card
 * kept showing the newest diff under an old turn). Its head says how many and by how much, with Undo (the files back to before this
 * turn, from its checkpoint) and Review (the Changes panel, where they are read and committed). Each file is a row, its folder
 * quiet and its name in ink; pressed, it opens a few changed lines in place (Zed's and Cursor's capped diffs), and the whole file is
 * one press on in Changes. What wants looking at, a check's flags or a second agent's findings, is said on the card, never behind
 * a press. A separate copy's work is brought over with Apply.
 */
export function ReviewCard({
  files,
  tests,
  receipt,
  explain = [],
  state,
  me,
  lane,
  sid,
  send,
  endSeq,
  lastCommitSeq,
  lastApplySeq = 0,
  lastRestoreSeq,
  undone: undoneRun,
  undo,
  invite,
  second,
  via,
  notify,
  onReview,
  contended = {},
}: {
  /** Files here another agent changed too, by path, and who (Activity contendedPaths). */
  contended?: Record<string, string>;
  /** What a second agent made of this change, when the session has it read. */
  second?: SecondReview | null;
  /** How its findings reach the agent from here: as an instruction, as a suggestion to the driver, or not at all. */
  via?: Via;
  notify?: (m: string) => void;
  /** This turn's files. */
  files: DiffFile[];
  tests: TestRun | null;
  receipt?: Receipt;
  /** The diff in three sentences: what changed, why, and what to look at first. */
  explain?: string[];
  state: SessionState;
  me: Member;
  lane: string;
  sid: string;
  invite?: string;
  send: Send;
  /** Where this run ended in the log; what happened after decides what is left to do. */
  endSeq: number;
  lastCommitSeq: number;
  /** When a separate copy's work was last brought into its folder. */
  lastApplySeq?: number;
  lastRestoreSeq: number;
  /** Whether this card's own run stands undone (rewind.ts undoneRuns), when its checkpoint is known; otherwise any undo since it. */
  undone?: boolean;
  undo?: () => void;
  /** The Changes panel, at this file when one is said. */
  onReview?: (path?: string) => void;
}) {
  const [applying, setApplying] = useState(false);
  const [applyErr, setApplyErr] = useState("");
  const [more, setMore] = useState(false);
  /** The commit dialog, open at where the commit goes. */
  const [ship, setShip] = useState<Dest | null>(null);
  const [, redraw] = useState(0);
  const [ask, confirmUI] = useConfirm();
  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);
  const committed = lastCommitSeq > endSeq;
  const undone = undoneRun ?? lastRestoreSeq > endSeq;
  const may = me.role === "owner" || driverOf(state, lane)?.id === me.id;
  const eng = state.engines[lane];
  const canPush = !!eng?.online && eng.mode !== "plan";
  const confirmUndo = () =>
    ask({
      title: "Undo this turn's changes?",
      body: "The files it changed go back to how they were before it started. You can redo it from the activity feed.",
      action: "Undo",
      danger: false,
      onConfirm: undo!,
    });
  // Working in a separate copy: the work is brought into the person's folder with Apply, and that is what this card offers first.
  const copyOf = state.engines[lane]?.copyOf;
  const into = copyOf?.split(/[\\/]/).filter(Boolean).pop() ?? "your folder";
  const applied = !!copyOf && lastApplySeq > endSeq;
  const apply = async () => {
    setApplying(true);
    setApplyErr("");
    const r = await send({ type: "folder.apply", lane, quiet: true });
    setApplying(false);
    if (!r.ok) setApplyErr(r.error ?? "Couldn't bring the changes over.");
  };
  // The explanation, less what the card already says: the sizes are in its head, and your own words are in the chat above.
  const mine = `Because ${me.name} asked: “`;
  const said = explain.filter((line, i) => !(i === 0 && line.startsWith("Changed ")) && !line.startsWith(mine) && !line.startsWith("Look here first:"));
  const rowKey = (path: string) => `${sid}:${lane}:${endSeq}:${path}`;
  const toggle = (path: string) => {
    const k = rowKey(path);
    if (openRows.has(k)) openRows.delete(k);
    else openRows.add(k);
    redraw((n) => n + 1);
  };
  const shown = more ? files : files.slice(0, PEEK);
  // A run that stands undone had its changes taken back, so a commit made after the undo isn't its: "Undone" before "Committed"
  // (2026-11-04 QA: a commit after an undo marked the undone run Committed).
  const outcome = applied ? `Brought into ${into}` : undone ? "Undone" : committed ? "Committed" : "";
  // The whole card folds to its head (Arun, 2026-11-03: "make the whole thing is fully collapsable too", "make sure this is closed
  // on default"): folded to begin with, its line of facts and its two buttons, and opened with a press on that line.
  const cardKey = `${sid}:${lane}:${endSeq}`;
  const folded = !opened.has(cardKey);
  const fold = () => {
    if (opened.has(cardKey)) opened.delete(cardKey);
    else opened.add(cardKey);
    redraw((n) => n + 1);
  };

  return (
    <div className={`change-card${outcome ? " settled" : ""}${folded ? " folded" : ""}`}>
      {confirmUI}
      <div className="cc-head">
        <button type="button" className="cc-toggle" aria-expanded={!folded} title={folded ? "Show the files" : "Fold it away"} onClick={fold}>
          <Icon name="chevronRight" size={13} className="cc-fold" />
          <b>
            {files.length} file{files.length === 1 ? "" : "s"} changed
          </b>
          {adds > 0 && <span className="diff-add">+{adds}</span>}
          {dels > 0 && <span className="diff-del">−{dels}</span>}
          {tests &&
            (tests.status === "pass" ? (
              <span className="cc-tests pass" title={tests.command}>
                Tests passed
              </span>
            ) : (
              // Told apart from failures that were there before the run began (baseline.ts): only new ones count against it.
              (() => {
                const w = failedWords(tests);
                return (
                  <span className={`cc-tests ${w.pre ? "pre" : "fail"}`} title={w.title}>
                    {w.text}
                  </span>
                );
              })()
            ))}
          {/* Folded, what wants looking at is still said on its line, so folding never hides a warning. */}
          {folded && (receipt?.flags.length || second?.findings?.length) ? <span className="cc-warn">{(receipt?.flags.length ?? 0) + (second?.findings?.length ?? 0)} to look at</span> : null}
        </button>
        <span className="cc-sp" />
        {outcome ? (
          <>
            <span className="cc-outcome">
              {!undone && <Icon name="check" size={13} />} {outcome}
            </span>
            {onReview && (
              <button type="button" className="cc-btn line" title="Read them in the Changes panel" onClick={() => onReview()}>
                Review
              </button>
            )}
          </>
        ) : copyOf ? (
          <>
            {undo && (
              <button type="button" className="cc-btn quiet" title="Put these files back as they were before this turn" onClick={confirmUndo}>
                <Icon name="rewind" size={13} /> Undo
              </button>
            )}
            <button type="button" className="cc-btn pri" disabled={!may || applying} title={may ? `Bring these changes into ${into}` : "Only the driver or an owner can bring changes over"} onClick={() => void apply()}>
              {applying ? "Applying…" : `Apply to ${into}`}
            </button>
            {onReview && (
              <button type="button" className="cc-btn line" title="Read them in the Changes panel" onClick={() => onReview()}>
                Review
              </button>
            )}
          </>
        ) : (
          <>
            {/* Review B (Arun, 2026-11-05: "commit menu B"): Ask for changes, then Commit with the other ways to commit and Undo under its arrow. */}
            <button type="button" className="cc-btn line" title="Tell the agent what to change" onClick={() => prefillComposer("")}>
              Ask for changes
            </button>
            {may ? (
              <span className="cc-split">
                <button type="button" className="cc-btn pri" title="Commit these changes" onClick={() => setShip("here")}>
                  <Icon name="commit" size={13} /> Commit
                </button>
                <MenuButton
                  end
                  label="More ways to commit"
                  className="cc-btn pri cc-split-more"
                  items={() => [
                    { label: "Commit", icon: "commit", onSelect: () => setShip("here") },
                    canPush && { label: "Commit and push", icon: "arrowUp", onSelect: () => setShip("push") },
                    canPush && { label: "Commit and open a pull request", icon: "gitPullRequest", onSelect: () => setShip("pr") },
                    !!onReview && { label: "Open in Changes", icon: "file", onSelect: () => onReview!() },
                    !!undo && { label: "Undo this turn's changes", icon: "rewind", danger: true, onSelect: confirmUndo },
                  ]}
                >
                  <Icon name="chevronDown" size={13} />
                </MenuButton>
              </span>
            ) : (
              onReview && (
                <button type="button" className="cc-btn" title="Read them in the Changes panel" onClick={() => onReview()}>
                  Review
                </button>
              )
            )}
          </>
        )}
      </div>
      {!folded && (
        <>
      {said.length > 0 && <p className="cc-explain">{said.join(" ")}</p>}
      {second && <SecondReviewView r={second} via={via ?? null} lane={lane} sid={sid} endSeq={endSeq} send={send} {...(notify ? { notify } : {})} />}
      {receipt && receipt.flags.length > 0 && <ReceiptView receipt={receipt} />}
      <ul className="cc-files">
        {shown.map((f) => {
          const open = openRows.has(rowKey(f.path));
          const cut = f.path.lastIndexOf("/");
          const mini = open && f.patch ? miniDiff(f.patch) : null;
          return (
            <li key={f.path} className={open ? "open" : ""}>
              <button type="button" className="cc-row" aria-expanded={open} title={f.path} onClick={() => toggle(f.path)}>
                <span className={`cc-st ${LETTER[f.status]}`}>{LETTER[f.status]}</span>
                <span className="cc-path">
                  {cut > 0 && <span>{f.path.slice(0, cut + 1)}</span>}
                  <b>{f.path.slice(cut + 1)}</b>
                </span>
                {contended[f.path] && <span className="cc-also">{contended[f.path]}</span>}
                <span className="cc-n">
                  {f.additions > 0 && <span className="diff-add">+{f.additions}</span>}
                  {f.deletions > 0 && <span className="diff-del">−{f.deletions}</span>}
                </span>
                <Icon name="chevronRight" size={12} className="cc-car" />
              </button>
              {open && (
                <div className="cc-mini">
                  {mini?.lines.map((l, i) => (
                    <div key={i} className={`cc-ln ${l.kind}`}>
                      <span>{l.n ?? ""}</span>
                      <span>{l.text}</span>
                    </div>
                  ))}
                  <div className="cc-mini-foot">
                    <span>{!mini ? "Its lines are in the Changes panel." : mini.changed > MINI_LINES ? `${Math.min(MINI_LINES, mini.changed)} of ${mini.changed} changed lines` : `${mini.changed} changed line${mini.changed === 1 ? "" : "s"}`}</span>
                    {onReview && (
                      <button type="button" className="link-btn" onClick={() => onReview(f.path)}>
                        Open in Changes <Icon name="arrowRight" size={12} />
                      </button>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
        {files.length > PEEK && (
          <li>
            <button type="button" className="cc-more" onClick={() => setMore((v) => !v)}>
              {more ? "Show fewer" : `${files.length - PEEK} more file${files.length - PEEK === 1 ? "" : "s"}`}
            </button>
          </li>
        )}
      </ul>
      {!outcome && (!tests || (!second && state.lanes.length > 0)) && (
        <div className="cc-foot">
          {!tests && (
            <span>
              <Icon name="clock" size={13} /> Tests haven't run on these changes
            </span>
          )}
          {!second && state.lanes.length > 0 && (
            <span>
              <Icon name="eye" size={13} /> Not checked by another agent
            </span>
          )}
          {!tests && (
            <button type="button" className="cc-btn line" title="Put a request to run the tests in the message box" onClick={() => prefillComposer(followUps(files.length, null, false)[0]?.text ?? "Run the project's tests.")}>
              Ask it to run them
            </button>
          )}
        </div>
      )}
        </>
      )}
      {ship && <ShipDialog state={state} sid={sid} invite={invite ?? ""} send={send} lane={lane} start={ship} {...(receipt ? { receipt } : {})} onClose={() => setShip(null)} />}
      {applyErr && (
        <p role="alert" className="error cc-err">
          {applyErr}
        </p>
      )}
    </div>
  );
}

/** Three things worth saying next, as buttons: what usually comes after a run like this. */
export function followUps(changed: number, tests: TestRun | null, hasAnswer: boolean): { label: string; text: string }[] {
  const out: { label: string; text: string }[] = [];
  if (changed > 0) {
    if (!tests) out.push({ label: "Run the tests", text: "Run the project's tests and fix anything that fails. Don't skip or disable a test to get there." });
    out.push({ label: "Explain what changed", text: "Walk me through what you changed and why, file by file, in plain words." });
    out.push({ label: "Check for edge cases", text: "Review your own change once more for edge cases, callers you may have missed and anything that could break. Report only real problems." });
  } else if (hasAnswer) {
    out.push({ label: "Go deeper", text: "Go deeper on the part that matters most, and show me the evidence for it." });
    out.push({ label: "Plan the fix", text: "Propose a plan to fix this, then wait for my go-ahead before changing anything." });
    out.push({ label: "Summarize for the team", text: "Write a three-sentence summary of what you found that I can paste to the team." });
  }
  return out.slice(0, 3);
}
