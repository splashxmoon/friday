import { useState, type ReactNode } from "react";
import { commandFailed, TEST_CMD, type Receipt } from "../receipt.js";
import type { DiffFile, ReviewFinding, SessionEvent } from "../types.js";
import { driverOf, type SessionState } from "../session/projection.js";
import { MAIN_LANE, type Member } from "../types.js";
import { argsOf } from "./args.js";
import { FileIcon } from "./fileIcons.js";
import { Icon } from "./icons.js";
import { commitWaits, ShipDialog } from "./Ship.js";
import { useConfirm } from "./ui.js";
import type { Send } from "./useSession.js";

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

/** Put words in the message box and leave the cursor at the end, for "Ask for changes". */
export function prefillComposer(text: string) {
  const el = document.getElementById("composer-input") as HTMLTextAreaElement | null;
  if (!el) return;
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  // Emptied first as React sees it, so the words read as a change even when they are the ones the box last held before it was
  // cleared: otherwise React heard nothing, the box showed them and Send stayed off (2026-10-28 QA: Edit on a queued message).
  el.value = "";
  set?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
  el.setSelectionRange(text.length, text.length);
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

/**
 * Review cards opened, by session, agent and run: closed is how a card starts (Arun, 2026-10-18: one with two dozen files
 * filled the chat and pushed the messages around it out of sight), and one opened stays open while the chat redraws.
 */
const openCards = new Set<string>();

export function ReviewCard({
  files,
  tests,
  receipt,
  explain = [],
  state,
  me,
  lane,
  sid,
  invite,
  send,
  endSeq,
  lastCommitSeq,
  lastApplySeq = 0,
  lastRestoreSeq,
  undo,
  second,
  via,
  notify,
  children,
}: {
  /** The files themselves, between the facts and the decision: you read, then decide. */
  children?: ReactNode;
  /** What a second agent made of this change, when the session has it read. */
  second?: SecondReview | null;
  /** How its findings reach the agent from here: as an instruction, as a suggestion to the driver, or not at all. */
  via?: Via;
  notify?: (m: string) => void;
  files: DiffFile[];
  tests: TestRun | null;
  receipt?: Receipt;
  /** The diff in three sentences, before it is shown: what changed, why, and what to look at first. */
  explain?: string[];
  state: SessionState;
  me: Member;
  lane: string;
  sid: string;
  invite: string;
  send: Send;
  /** Where this run ended in the log; what happened after decides what is left to do. */
  endSeq: number;
  lastCommitSeq: number;
  /** When a separate copy's work was last brought into its folder. */
  lastApplySeq?: number;
  lastRestoreSeq: number;
  undo?: () => void;
}) {
  const [ship, setShip] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyErr, setApplyErr] = useState("");
  const [ask, confirmUI] = useConfirm();
  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);
  const committed = lastCommitSeq > endSeq;
  const undone = lastRestoreSeq > endSeq;
  const may = me.role === "owner" || driverOf(state, lane)?.id === me.id;
  // A commit waits for every run in the session to finish (core.ts): said on the button while one goes, not only as an error
  // after the dialog (2026-10-27 audit).
  const busy = commitWaits(state);
  const why = busy ? "Wait for the run to finish, then commit" : "";
  const branch = (state.engines[lane] ?? Object.values(state.engines)[0])?.branch;
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

  // The explanation, less what the card already says: the sizes are in its header, your own words are in the chat above,
  // and a flag it would point at is shown as a flag.
  const flagged = !!receipt?.flags.length;
  const mine = `Because ${me.name} asked: “`;
  const said = explain
    .map((line, i) => {
      if (i === 0 && line.startsWith("Changed ")) return "";
      if (!line.startsWith(mine)) return line;
      // Your own words: keep only what the agent decided on the way, if it said.
      const rest = line.indexOf("On the way it decided:");
      return rest < 0 ? "" : line.slice(rest);
    })
    .filter((line) => line && !(flagged && line.startsWith("Look here first:")));

  // Closed, the card is its one line of facts and its decision: what it says, its files and its receipt open with the line.
  // What wants looking at is still said on that line, so a closed card never hides a warning.
  const cardKey = `${sid}:${lane}:${endSeq}`;
  const [open, setOpen] = useState(() => openCards.has(cardKey));
  const toggle = () =>
    setOpen((o) => {
      if (o) openCards.delete(cardKey);
      else openCards.add(cardKey);
      return !o;
    });
  const issues = (receipt?.flags.length ?? 0) + (second?.findings?.length ?? 0);
  const bad = !!receipt?.flags.some((f) => f.level === "bad");

  return (
    <div className={`review-card ${committed ? "done" : ""} ${open ? "open" : "shut"}`}>
      {confirmUI}
      <button type="button" className="review-facts review-toggle" aria-expanded={open} title={`${open ? "Hide the files and details" : "Show the files and details"}${branch ? ` · on ${branch}` : ""}`} onClick={toggle}>
        <Icon name="chevronDown" size={14} className="review-caret" />
        <span className="review-title">Review changes</span>
        <span className="review-stats">
          {files.length} file{files.length === 1 ? "" : "s"} <b className="diff-add">+{adds}</b> <b className="diff-del">−{dels}</b>
        </span>
        {branch && (
          <span className="review-branch" title="The branch this session is working on">
            on {branch}
          </span>
        )}
        <span className={`review-tests ${tests?.status ?? "none"}`} title={tests?.command ?? "The agent didn't run any tests in this run"}>
          {tests?.status === "pass" ? "Tests passed" : tests?.status === "fail" ? "Tests failed" : "Tests not run"}
        </span>
        {!open && issues > 0 && (
          <span className={`review-issues ${bad ? "bad" : ""}`}>
            {issues} to look at
          </span>
        )}
      </button>
      {/* Shut, the files themselves under the line, as Synara and T3 Code show a run's edits: up to three, each with its counts,
          the rest one press away (Arun, 2026-10-27: "take some inspo from like t3, synara, orca"). A file opens the card on it. */}
      {!open && files.length > 0 && (
        <ul className="review-peek">
          {files.slice(0, 3).map((f) => (
            <li key={f.path}>
              <button type="button" onClick={toggle} title={`${f.path}: show the diff`}>
                <FileIcon path={f.path} size={14} />
                <span className="review-peek-path">{f.path}</span>
                {f.status === "added" && <span className="review-peek-new">new</span>}
                <span className="review-peek-n">
                  <b className="diff-add">+{f.additions}</b> <b className="diff-del">−{f.deletions}</b>
                </span>
              </button>
            </li>
          ))}
          {files.length > 3 && (
            <li>
              <button type="button" className="review-peek-more" onClick={toggle}>
                <Icon name="chevronRight" size={12} /> Show {files.length - 3} more {files.length - 3 === 1 ? "file" : "files"}
              </button>
            </li>
          )}
        </ul>
      )}
      {open && (
        <>
          {said.length > 0 && <p className="review-explain">{said.join(" ")}</p>}
          {second && <SecondReviewView r={second} via={via ?? null} lane={lane} sid={sid} endSeq={endSeq} send={send} {...(notify ? { notify } : {})} />}
          {receipt && (receipt.flags.length > 0 || receipt.commands.length > 0) && <ReceiptView receipt={receipt} />}
          {children}
        </>
      )}
      <div className="review-foot">
      {applied ? (
        <span className="review-outcome">
          <Icon name="check" size={13} /> Brought into {into}
        </span>
      ) : committed ? (
        <span className="review-outcome">
          <Icon name="check" size={13} /> Committed
        </span>
      ) : undone ? (
        <span className="review-outcome muted">Undone</span>
      ) : (
        <div className="review-actions">
          {undo && (
            <button
              type="button"
              className="btn ghost small danger"
              onClick={() =>
                ask({
                  title: "Undo this run?",
                  body: "The files this run changed go back to how they were before it started. You can redo it from the activity feed.",
                  action: "Undo run",
                  danger: false,
                  onConfirm: undo,
                })
              }
            >
              Undo
            </button>
          )}
          <button type="button" className="btn ghost small" onClick={() => prefillComposer("Please change: ")}>
            Ask for changes
          </button>
          {copyOf ? (
            <>
              <button type="button" className="btn ghost small" disabled={!may || busy} title={why || (may ? `Commit on ${branch ?? "the copy's branch"}, without touching ${into}` : "Only the driver or an owner can commit")} onClick={() => setShip(true)}>
                Commit on branch
              </button>
              <button type="button" className="btn primary small" disabled={!may || applying} title={may ? `Bring these changes into ${into}` : "Only the driver or an owner can bring changes over"} onClick={() => void apply()}>
                <Icon name="check" size={13} /> {applying ? "Applying…" : `Apply to ${into}`}
              </button>
            </>
          ) : (
            // Says what it does, as its title does: it opens the commit (2026-10-27 audit: "Accept" whose title said "Commit").
            <button type="button" className="btn primary small" disabled={!may || busy} title={why || (may ? "Commit these changes" : "Only the driver or an owner can commit")} onClick={() => setShip(true)}>
              <Icon name="check" size={13} /> {receipt?.flags.some((f) => f.level === "bad") ? "Commit anyway…" : "Commit…"}
            </button>
          )}
        </div>
      )}
      </div>
      {applyErr && (
        <p role="alert" className="error">
          {applyErr}
        </p>
      )}
      {ship && <ShipDialog state={state} sid={sid} invite={invite} send={send} lane={lane} receipt={receipt} onClose={() => setShip(false)} />}
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
