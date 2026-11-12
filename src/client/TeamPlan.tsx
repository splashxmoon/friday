/**
 * The plan beside a crew room's chat (Arun, 2026-11-11, option 3B of the Crew overhaul, after Hermes' visible handoffs and Oh My
 * Hermes' plan panel): what the lead is working toward, how far it has got, and each piece as a card, its teammate's face, its
 * title and where it stands in words, "Done and checked", "Working", "Needs you". The same tasks as the Board (the board's and the
 * ones the lead handed out by assign_task), standing beside the work rather than over it.
 *
 * Each card opens to the piece in full (Arun, 2026-11-11: "add more details to this and make it open and close able too"): what it
 * asks, who has it and why, the files it owns, what it waits on, its checks, its review, its branch and what it last said, with
 * the way to its teammate's chat. The panel itself folds to a slim tab on the window's edge, and stays as it was left.
 */
import { useEffect, useState } from "react";
import type { Send } from "./useSession.js";
import { MenuButton } from "./ui.js";
import { useNow } from "./presence.js";
import { ChevronDownIcon, ChevronRightIcon, PanelRightCloseIcon, PanelRightOpenIcon } from "lucide-react";
import { MAIN_LANE, type SessionEvent } from "../types.js";
import { runOf, verifiedAt, type BoardTask, type SessionState, type TaskReview } from "../session/projection.js";
import { focusAgent } from "./agentFocus.js";
import { boardTitle } from "./team-api.js";
import { plainLine } from "./team-room.js";
import { assignedTasks, colOf } from "./TeamBoard.js";
import { Face, mateOn, matesIn } from "./Teammates.js";

type Task = BoardTask & { assigned?: boolean };

/**
 * How the plan's reviews have gone, counting every round (Arun, 2026-11-11: "if every review comes back approved, it's a second
 * agent agreeing with the first"): each teammate's approvals and send-backs, Friday's passes without a second agent, passes with
 * no verdict, and the times a task's own checks sent it back.
 */
export function reviewTally(tasks: readonly Task[]): { by: { name: string; ok: number; back: number }[]; approved: number; back: number; auto: number; unclear: number; checks: number } {
  const by = new Map<string, { name: string; ok: number; back: number }>();
  let auto = 0;
  let unclear = 0;
  let checks = 0;
  for (const t of tasks) {
    checks += t.backs?.checks ?? 0;
    for (const r of t.reviews ?? (t.review ? [t.review] : [])) {
      if (r.auto) auto++;
      else if (r.unclear) unclear++;
      else {
        const m = by.get(r.by) ?? { name: r.by, ok: 0, back: 0 };
        if (r.ok) m.ok++;
        else m.back++;
        by.set(r.by, m);
      }
    }
  }
  const list = [...by.values()].sort((a, b) => b.back + b.ok - (a.back + a.ok));
  return { by: list, approved: list.reduce((n, m) => n + m.ok, 0), back: list.reduce((n, m) => n + m.back, 0), auto, unclear, checks };
}

/** One review in words, its tone, and its note without the verdict it starts by saying again ("Approved: …"). */
function reviewLine(r: TaskReview): { said: string; tone: "ok" | "bad" | ""; note: string } {
  const note = plainLine(r.note).replace(/^\s*(approved|looks good|lgtm|changes needed|needs changes)\b[:.,!\s-]*/i, "");
  if (r.auto) return { said: "Passed without a review", tone: "", note: r.note.replace(/\.$/, "") };
  if (r.unclear) return { said: `${r.by} gave no verdict, so it passed without one`, tone: "", note: /^no verdict\.?$/i.test(r.note.trim()) ? "" : note };
  return { said: r.ok ? `${r.by} approved it` : `${r.by} asked for changes`, tone: r.ok ? "ok" : "bad", note };
}

const times = (n: number) => `${n} time${n === 1 ? "" : "s"}`;
type Tone = "done" | "reported" | "needs" | "work" | "wait";

const OPEN_KEY = "friday.plan.open";
const readOpen = () => {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
};

/** Where a piece stands, in the words its card says. */
/** A teammate on a piece and saying nothing for this long reads "quiet" (2026-11-11 audit: a stuck one looked like it was working). */
const QUIET_MS = 20 * 60_000;

export function planWord(t: Task, state: Pick<SessionState, "approvals" | "laneRuns" | "run">, titleOf: (id: string) => string, quietFor = 0): { word: string; tone: Tone } {
  const lane = t.lane ?? "";
  const waiting = !!lane && t.status !== "done" && (!!state.approvals[lane] || runOf(state as SessionState, lane).status === "waiting_for_human");
  if (colOf(t) === "needs" || waiting) return { word: "Needs you", tone: "needs" };
  // Done means proven (Arun, 2026-11-11, after Oh My Hermes): its checks passed on its commit, nothing changed since. Otherwise
  // it is only reported done, and why it isn't verified is said.
  if (t.status === "done") {
    if (verifiedAt(t)) return { word: "Verified", tone: "done" };
    const c = t.checks;
    const why = !c || c.skipped ? "no checks ran" : !c.ok ? "its checks failed" : c.stale ? "changed since its checks" : c.dirty ? "checked with uncommitted work" : !c.sha ? "checked, commit unknown" : "";
    return { word: `Reported done${why ? ` · ${why}` : ""}`, tone: "reported" };
  }
  if (t.status === "review") return { word: t.reviewer ? `${t.reviewer.name} is checking it` : "Being checked", tone: "work" };
  if (t.status === "claimed") return { word: t.checks?.running ? "Running its checks" : quietFor >= QUIET_MS ? `Working · quiet ${Math.round(quietFor / 60_000)}m` : "Working", tone: "work" };
  const first = t.after?.[0];
  if (first) return { word: `Waits on ${titleOf(first)}`, tone: "wait" };
  return { word: t.next ? `${t.next} takes it next` : "To do", tone: "wait" };
}

/** What a person asked the lead, as the plan's goal: not Friday's own notes said on their behalf ("[session] Carry on…"). */
export function goalOf(events: readonly SessionEvent[], lead: string): string {
  const asked = events.findLast((e) => e.body.type === "instruction" && e.actor.kind === "human" && !e.body.approval && !e.body.mesh && (e.lane ?? MAIN_LANE) === lead && !/^\s*\[[^\]]+\]/.test(e.body.text));
  return asked?.body.type === "instruction" ? clip(plainLine(asked.body.text.split("\n").find((l) => l.trim()) ?? ""), 80) : "";
}

/** Narrower than the chat and the plan side by side: the plan opens over the chat's edge, and starts folded. */
const NARROW = "(max-width: 1279px)";
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof matchMedia !== "undefined" && matchMedia(NARROW).matches);
  useEffect(() => {
    const mq = matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

export default function TeamPlan({ state, events, send }: { state: SessionState; events: readonly SessionEvent[]; send?: Send }) {
  const now = useNow(60_000);
  const [wideOpen, setWideOpen] = useState(readOpen);
  // In a narrow window the plan never goes (Arun, 2026-11-11: "the plan thing disappears at a certain window size"): it keeps its
  // folded tab, and opens over the chat's edge for as long as it is wanted, without changing what the wide window remembers.
  const narrow = useNarrow();
  const [peek, setPeek] = useState(false);
  const open = narrow ? peek : wideOpen;
  const [shown, setShown] = useState<Set<string> | null>(null);
  const tasks: Task[] = [...(state.board?.tasks ?? []), ...assignedTasks(state)].filter((t) => colOf(t));
  if (!tasks.length) return null;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const titleOf = (id: string) => {
    const t = byId.get(id);
    return t ? `“${clip(boardTitle(t.title), 28)}”` : "another piece";
  };
  const goal = goalOf(events, state.lead ?? state.board?.fromLane ?? "");
  const done = tasks.filter((t) => t.status === "done").length;
  // When each lane last did anything, for a piece whose teammate has gone quiet.
  const lastAt = new Map<string, number>();
  for (let i = events.length - 1; i >= 0 && lastAt.size < 40; i--) {
    const l = events[i]!.lane ?? MAIN_LANE;
    if (!lastAt.has(l)) lastAt.set(l, events[i]!.ts);
  }
  const words = new Map(tasks.map((t) => [t.id, planWord(t, state, titleOf, t.lane && lastAt.has(t.lane) ? now - lastAt.get(t.lane)! : 0)]));
  const needs = tasks.filter((t) => words.get(t.id)!.tone === "needs").length;
  // What needs you opens by itself until a card is pressed.
  const expanded = shown ?? new Set(tasks.filter((t) => words.get(t.id)!.tone === "needs").map((t) => t.id));
  const flip = (id: string) => setShown(new Set(expanded.has(id) ? [...expanded].filter((x) => x !== id) : [...expanded, id]));
  const fold = (to: boolean) => {
    if (narrow) return setPeek(to);
    setWideOpen(to);
    try {
      localStorage.setItem(OPEN_KEY, to ? "1" : "0");
    } catch {
      // A preference; losing it costs nothing.
    }
  };

  if (!open)
    return (
      <aside className="tp tp-shut" aria-label="The plan, folded">
        {/* Folded, it still says how the plan stands: how far it has got as a ring, the count, and a dot for each piece in the
            colour of where it stands (Arun, 2026-11-11: "design better please"). */}
        <button type="button" className="tp-tab" onClick={() => fold(true)} title={`Show the plan: ${done} of ${tasks.length} done${needs ? `, ${needs} need${needs === 1 ? "s" : ""} you` : ""}`} aria-label={`Show the plan: ${done} of ${tasks.length} done`} aria-expanded={false}>
          <span className="tp-tab-open" aria-hidden="true">
            <PanelRightOpenIcon />
          </span>
          <svg className="tp-ring" viewBox="0 0 28 28" aria-hidden="true">
            <circle cx="14" cy="14" r="11" className="tp-ring-bg" />
            <circle cx="14" cy="14" r="11" className="tp-ring-on" data-needs={needs || undefined} strokeDasharray={`${(done / tasks.length) * 69.1} 69.1`} />
          </svg>
          <span className="tp-tab-n">
            {done}
            <i>/{tasks.length}</i>
          </span>
          <span className="tp-dots" aria-hidden="true">
            {tasks.slice(0, 12).map((t) => (
              <i key={t.id} data-tone={words.get(t.id)!.tone} />
            ))}
          </span>
        </button>
      </aside>
    );

  return (
    <aside className={`tp${narrow ? " tp-over" : ""}`} aria-label="The plan" onKeyDown={(e) => narrow && e.key === "Escape" && fold(false)}>
      <header className="tp-head">
        <div className="tp-head-row">
          <h2>The plan</h2>
          <button type="button" className="tp-fold" onClick={() => fold(false)} title="Fold the plan away" aria-label="Fold the plan away" aria-expanded={true}>
            <PanelRightCloseIcon aria-hidden="true" />
          </button>
        </div>
        {goal && <p className="tp-goal">{goal}</p>}
        <p className="tp-count">
          <span className="tp-bar" aria-hidden="true">
            <i style={{ width: `${(done / tasks.length) * 100}%` }} />
          </span>
          {done} of {tasks.length} done{needs ? ` · ${needs} need${needs === 1 ? "s" : ""} you` : ""}
        </p>
        <Tally tasks={tasks} />
      </header>
      <ol className="tp-list">
        {tasks.map((t) => {
          const m = t.lane ? mateOn(t.lane) : null;
          const s = words.get(t.id)!;
          const on = expanded.has(t.id);
          const who = m?.name ?? t.name;
          return (
            <li key={t.id} className="tp-card" data-tone={s.tone} data-open={on || undefined}>
              <button type="button" className="tp-card-head" aria-expanded={on} onClick={() => flip(t.id)}>
                {m ? <Face seed={m.look ?? m.name} size={24} /> : <span className="tp-noface" aria-hidden="true" />}
                <span className="tp-text">
                  <b>{boardTitle(t.title)}</b>
                  <span className="tp-word">{who && s.word === "Working" ? `${who} is on it` : s.word}</span>
                </span>
                {on ? <ChevronDownIcon className="tp-chev" aria-hidden="true" /> : <ChevronRightIcon className="tp-chev" aria-hidden="true" />}
              </button>
              {on && <Details t={t} who={who} titleOf={titleOf} onChat={t.lane ? () => focusAgent(state.id, t.lane!) : undefined} acts={send ? <Acts t={t} state={state} send={send} /> : null} />}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

/**
 * The plan's reviews in one line under its progress, opening to each teammate's approvals and send-backs, Friday's passes without
 * a review and the times checks sent work back. Not drawn before anything has been reviewed or sent back.
 */
function Tally({ tasks }: { tasks: readonly Task[] }) {
  const [open, setOpen] = useState(false);
  const r = reviewTally(tasks);
  if (!r.approved && !r.back && !r.auto && !r.unclear && !r.checks) return null;
  const parts = [r.approved || r.back ? `${r.approved} approved` : "", r.back ? `${r.back} sent back` : "", r.auto ? `${r.auto} unreviewed` : ""].filter(Boolean);
  return (
    <div className="tp-tally">
      <button type="button" className="tp-tally-head" aria-expanded={open} aria-label={`Reviews: ${parts.join(", ")}`} onClick={() => setOpen(!open)}>
        <span className="tp-tally-sum" title="How this plan's reviews went">{parts.join(" · ") || `${r.checks} sent back by checks`}</span>
        {open ? <ChevronDownIcon aria-hidden="true" /> : <ChevronRightIcon aria-hidden="true" />}
      </button>
      {open && (
        <dl className="tp-tally-list">
          {r.by.map((m) => (
            <div key={m.name}>
              <dt>{m.name}</dt>
              <dd>
                {m.ok} approved{m.back ? <b className="bad"> · {m.back} sent back</b> : null}
              </dd>
            </div>
          ))}
          {r.unclear > 0 && (
            <div>
              <dt>No verdict</dt>
              <dd>{times(r.unclear)}, passed without one</dd>
            </div>
          )}
          {r.auto > 0 && (
            <div>
              <dt>No review</dt>
              <dd>{r.auto} passed by Friday: nothing changed, nobody else to check, or tests passed on a small change</dd>
            </div>
          )}
          {r.checks > 0 && (
            <div>
              <dt>Checks</dt>
              <dd>sent work back {times(r.checks)}</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}

/** A piece in full: what it asks, who has it, what it owns and waits on, how it was checked, where its work is, what it said. */
function Details({ t, who, titleOf, onChat, acts }: { t: Task; who?: string | undefined; titleOf: (id: string) => string; onChat?: (() => void) | undefined; acts?: React.ReactNode }) {
  const { ask, workflow } = taskAsk(t.detail ?? "");
  // What it said, and apart from it what Friday's record shows it did ("[Friday, from the record] 1 file changed …").
  const [said, record] = (t.report ?? "").split(/\s*\[Friday, from the record\]\s*/);
  const report = said ? plainLine(said).trim() : "";
  const rows: [string, React.ReactNode][] = [];
  if (workflow) rows.push(["Workflow", workflow]);
  if (who) rows.push(["Who", `${who}${t.why ? `, ${t.why}` : ""}`]);
  if (t.owns.length)
    rows.push([
      "Owns",
      <span className="tp-codes">
        {t.owns.map((f) => (
          <code key={f}>{f}</code>
        ))}
      </span>,
    ]);
  if (t.after.length) rows.push(["Waits on", t.after.map(titleOf).join(", ")]);
  if (t.checks)
    rows.push([
      "Checks",
      <span className={`tp-check ${t.checks.running ? "run" : t.checks.ok ? "ok" : t.checks.skipped ? "" : "bad"}`}>
        <code>{t.checks.command}</code> {t.checks.running ? "running" : t.checks.skipped ? "couldn't run" : t.checks.ok ? "passed" : "failed"}
        {/* Which commit it ran on, and what makes it not verified. */}
        {!t.checks.running && t.checks.sha ? (
          <>
            {" "}
            on <code>{t.checks.sha.slice(0, 7)}</code>
            {t.checks.dirty ? ", with uncommitted work beside it" : t.checks.stale ? ", then changed" : ""}
          </>
        ) : null}
      </span>,
    ]);
  // Every review it has had, oldest first: a send-back's note stays once the next review passes it.
  const reviews = t.reviews ?? (t.review ? [t.review] : []);
  if (reviews.length || t.reviewer)
    rows.push([
      reviews.length > 1 ? "Reviews" : "Review",
      <ol className="tp-reviews">
        {reviews.map((r, i) => {
          const l = reviewLine(r);
          return (
            <li key={i} className={`tp-check ${l.tone}`}>
              {l.said}
              {l.note && <More text={l.note} lines={2} className="tp-note" />}
            </li>
          );
        })}
        {t.status === "review" && t.reviewer && <li>{t.reviewer.name} is checking it</li>}
      </ol>,
    ]);
  if (t.rounds) {
    const r = t.backs?.review ?? 0;
    const c = t.backs?.checks ?? 0;
    rows.push(["Went back", r + c === t.rounds && r && c ? `${times(t.rounds)}: ${r} after a review, ${c} after its checks` : r + c === t.rounds && c ? `${times(c)}, after its checks failed` : r + c === t.rounds && r ? `${times(r)}, after a review` : `${times(t.rounds)}, after a review or its checks`]);
  }
  if (t.branch) rows.push(["Branch", <code>{t.branch}</code>]);
  return (
    <div className="tp-more">
      {ask && ask !== boardTitle(t.title) && <More text={ask} lines={3} className="tp-ask" />}
      {rows.length > 0 && (
        <dl className="tp-facts">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {report && (
        <div className="tp-report">
          <span>What {who ?? "it"} said</span>
          <More text={report} lines={4} />
          {record?.trim() && <small>From Friday's record: {clip(plainLine(record).trim(), 200)}</small>}
        </div>
      )}
      <div className="tp-acts">
        {onChat && (
          <button type="button" className="tp-chat" onClick={onChat}>
            Open {who ? `${who}'s` : "their"} chat
          </button>
        )}
        {acts}
      </div>
    </div>
  );
}

/**
 * What can be done with a piece from its card, as the Board's menu offers it (2026-11-11 audit: a card said "Needs you" and offered
 * only its chat): a stuck one tried again, an open one given to another teammate or dropped, a finished one sent back. Work the
 * lead handed out is the lead's to move: it is asked to.
 */
function Acts({ t, state, send }: { t: Task; state: SessionState; send: Send }) {
  const [said, setSaid] = useState("");
  const others = matesIn(state.id).filter((x) => x.lane !== t.lane && x.lane !== state.lead);
  const lead = state.lead ? matesIn(state.id).find((x) => x.lane === state.lead)?.m.name : undefined;
  const control = (action: "reassign" | "retry" | "sendback" | "cancel", to?: string) =>
    void send({ type: "board.task", id: t.id, action, ...(to ? { to } : {}) }).then((r) => setSaid(r.ok ? (action === "retry" ? "Tried again." : action === "cancel" ? "Dropped." : action === "sendback" ? "Sent back." : `Given to ${to}.`) : (r.error ?? "Couldn't change that.")));
  const askLead = (to: string) =>
    void send({ type: "instruct", lane: state.lead!, text: `Please hand "${boardTitle(t.title)}" from ${t.name ?? "its teammate"} to ${to}.` }).then((r) => setSaid(r.ok ? `Asked ${lead ?? "the lead"} to give it to ${to}.` : (r.error ?? "Couldn't ask the lead.")));
  const open = t.status !== "done" && t.status !== "cancelled";
  const give = open && others.length > 0 && (!t.assigned || !!state.lead);
  return (
    <>
      {!t.assigned && t.status === "blocked" && (
        <button type="button" className="tp-chat" onClick={() => control("retry")}>
          Try again
        </button>
      )}
      {give && (
        <MenuButton
          className="tp-chat"
          label="Give it to another teammate"
          text={t.assigned ? `Ask ${lead ?? "the lead"} to move it` : "Give it to"}
          caret="chevronDown"
          items={() => others.map((x) => ({ label: x.m.name, mark: <Face seed={x.m.look ?? x.m.name} size={16} />, onSelect: () => (t.assigned ? askLead(x.m.name) : control("reassign", x.m.name)) }))}
        />
      )}
      {!t.assigned && t.status === "done" && (
        <button type="button" className="tp-chat" onClick={() => control("sendback")}>
          Send back
        </button>
      )}
      {!t.assigned && open && (
        <button type="button" className="tp-chat tp-quiet" onClick={() => control("cancel")}>
          Drop it
        </button>
      )}
      {said && (
        <span className="tp-said" role="status">
          {said}
        </span>
      )}
    </>
  );
}

/**
 * A task's ask as the person reads it: a workflow step's own heading ("[Workflow "Bug sweep", step 1 of 5]") said as a fact of its
 * own, and Friday's instructions to the teammate (what started the run, how to end its report, not to post a board) left out:
 * they are for the teammate, and made a step's card a page long (Arun, 2026-11-11: "sometimes its too long").
 */
export function taskAsk(detail: string): { ask: string; workflow: string } {
  const head = /^\s*\[Workflow "([^"]+)", step (\d+) of (\d+)(: a check)?\]\s*/.exec(detail);
  const body = head ? detail.slice(head[0].length) : detail;
  const FRIDAYS = /^(What started this run|Handed on to this step|Running alongside this step|End with a short report|End your report with one line|Do this step yourself|Look at what the steps before handed on|\[Friday\])/;
  const ask = body
    .split(/\n\s*\n/)
    .filter((p) => !FRIDAYS.test(p.trim()))
    .join("\n\n")
    .replace(/^Check whether this holds:\s*/, "")
    .trim();
  return { ask: plainLine(ask), workflow: head ? `${head[1]}, step ${head[2]} of ${head[3]}${head[4] ? ", a check" : ""}` : "" };
}

/** A few lines of it, the rest a press away: More, then Less. Short text is just itself. */
function More({ text, lines, className = "" }: { text: string; lines: number; className?: string }) {
  const [all, setAll] = useState(false);
  const long = text.length > lines * 52;
  return (
    <span className={`tp-clamp ${className}`}>
      <span className={long && !all ? "tp-clamped" : undefined} style={long && !all ? ({ WebkitLineClamp: lines } as React.CSSProperties) : undefined}>
        {text}
      </span>
      {long && (
        <button type="button" className="tp-more-btn" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? "Less" : "More"}
        </button>
      )}
    </span>
  );
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
