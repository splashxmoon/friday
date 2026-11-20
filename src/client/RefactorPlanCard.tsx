import { useContext, useEffect, useRef, useState } from "react";
import { MAIN_LANE } from "../types.js";
import type { AskLane } from "./Activity.js";
import { getIdeRoot, ideHint, useMode } from "./ide/mode.js";
import { Icon } from "./icons.js";
import { prefillComposer } from "./prefill.js";
import { doneSummary, GO_AHEAD_ASK, planCounts, REVISE_LEAD, splitPath, type RefactorDone, type RefactorPlan } from "./refactor-plan.js";
import { RunFacts } from "./run-facts.js";
import "./refactor-plan.css";

/**
 * Sessions whose "Go ahead" was pressed on this page, with the number of the plan's row: only a closing line after that row opens the
 * IDE's review, once (so an earlier refactor's line, shown again as a chat is reopened mid-run, never does). Kept until the line
 * comes (or six hours), and not lost to a screen that can't open it: the IDE's review opens when the line is on screen in Code.
 */
const going = new Map<string, { seq: number; at: number }>();
const GOING_FOR_MS = 6 * 3600_000;
const SHOWN = 8;

/** A row's number in the feed (the Activity row's data-seq). */
const seqOf = (el: HTMLElement | null) => Number(el?.closest<HTMLElement>("[data-feed-sid]")?.dataset.seq) || 0;
const after = (el: Element, other: Element) => !!(el.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING);

/**
 * What a plan's own "Go ahead" says in the chat: the short line the person pressed, the instruction itself a press away, as the
 * lines Friday says for the agent are (Activity's SystemAsk). data-go-ahead is how a plan card knows it was pressed, after a reload.
 */
export function GoAheadText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span data-go-ahead="">
      Go ahead with the plan
      <button type="button" className="link-btn rfp-told" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? "Hide" : "What it was told"}
      </button>
      {open && <span className="rfp-told-text">{text}</span>}
    </span>
  );
}

/** Where a card is drawn: the session and lane that wrote it (an Activity row's data attributes). */
function whereOf(el: HTMLElement | null) {
  const row = el?.closest<HTMLElement>("[data-feed-sid]");
  return { sid: row?.dataset.feedSid ?? "", lane: row?.dataset.lane || MAIN_LANE };
}

/**
 * The agent's plan for a change across the codebase, as a card (Arun, 2026-11-19: "the agent plans every file first, you
 * approve, it does them all and shows one review"): every file with one line on what changes, the risks and the checks, then
 * Go ahead, which takes the agent out of Plan to do all of it, or Change the plan, which is the box. The same card in Agents and
 * in Code's narrow column; each file opens in the IDE.
 */
export function RefactorPlanCard({ plan }: { plan: RefactorPlan }) {
  const [all, setAll] = useState(false);
  // "…" while it goes, "On it" once it has; a failure puts the buttons back, with what went wrong.
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");
  const sending = useRef(false);
  // Read from the feed, not remembered, so it holds after a reload and when the chat is reopened: a closing line after this card
  // (carried out), a newer plan after it (this one is replaced), or the Go ahead pressed after it (it is under way).
  const [phase, setPhase] = useState<"" | "going" | "replaced" | "done">("");
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = card.current;
    if (!el) return;
    const feed = el.closest("[data-slot='session.feed']");
    if (!feed) return;
    const read = () => {
      const some = (sel: string) => [...feed.querySelectorAll(sel)].some((x) => x !== el && after(el, x));
      setPhase(some(".rfp-done") ? "done" : some(".rfp-card") ? "replaced" : some("[data-go-ahead]") ? "going" : "");
    };
    read();
    const watch = new MutationObserver(read);
    watch.observe(feed, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, []);
  const send = (text: string, said: boolean) => {
    // One press is one instruction: a second would be queued behind the first and the plan done twice.
    if (sending.current || sent) return;
    const w = whereOf(card.current);
    const at = seqOf(card.current);
    sending.current = true;
    setErr("");
    setSent(true);
    const back = (why: string) => {
      sending.current = false;
      setSent(false);
      setErr(why);
      if (said && w.sid) going.delete(w.sid);
    };
    const ask: AskLane = { lane: w.lane, text, whenIdle: true, reply: (r) => (r.ok ? void 0 : back(r.error || "That didn't send")), ...(w.sid ? { sid: w.sid } : {}) };
    window.dispatchEvent(new CustomEvent("friday:ask-lane", { detail: ask }));
    if (ask.handled) {
      if (w.sid) going.set(w.sid, { seq: at, at: Date.now() });
    } else back("Open the chat to send that");
  };
  // The box, started with words that keep the agent reading (REVISE_LEAD): what is typed after them is the change, and nothing
  // is touched until the plan is approved. Where the box is out of reach, the box of this chat is only focused.
  const changeIt = () => {
    prefillComposer(REVISE_LEAD);
  };
  const open = (path: string) => window.dispatchEvent(new CustomEvent("friday:open-file", { detail: { path }, cancelable: true }));
  const shown = all ? plan.files : plan.files.slice(0, SHOWN);
  const root = getIdeRoot() ?? "";
  return (
    <div ref={card} className="rfp-card" role="group" aria-label="Refactor plan">
      <div className="rfp-head">
        <span className="rfp-mark" aria-hidden="true"><Icon name="list" size={14} /></span>
        <b>Refactor plan</b>
        <span className="rfp-counts"><i aria-hidden="true">·</i>{planCounts(plan)}</span>
      </div>
      {plan.summary && <p className="rfp-summary">{plan.summary}</p>}
      <ul className="rfp-files">
        {shown.map((f) => {
          const { name, dir } = splitPath(f.path, root);
          return (
            <li key={f.path} className="rfp-file">
              <button type="button" className="rfp-path" title={`Open ${f.path}${ideHint()}`} onClick={() => open(f.path)}>
                <span className="rfp-name">{name}</span>
                {dir && <span className="rfp-dir">{dir}</span>}
              </button>
              {f.change && <span className="rfp-change">{f.change}</span>}
            </li>
          );
        })}
      </ul>
      {plan.files.length > SHOWN && (
        <button type="button" className="rfp-more" onClick={() => setAll((a) => !a)}>
          {all ? "Show fewer" : `Show all ${plan.files.length} files`}
        </button>
      )}
      {plan.risks.length > 0 && (
        <div className="rfp-sec">
          <div className="rfp-label">Risks</div>
          <ul className="rfp-risks">
            {plan.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {plan.checks.length > 0 && (
        <div className="rfp-sec">
          <div className="rfp-label">Checks</div>
          <div className="rfp-checks">
            {plan.checks.map((c, i) => (
              <code key={i}>{c}</code>
            ))}
          </div>
        </div>
      )}
      <div className="rfp-acts">
        {phase === "done" ? (
          <span className="rfp-said" role="status">Carried out</span>
        ) : phase === "replaced" ? (
          <span className="rfp-said" role="status">Replaced by a newer plan</span>
        ) : sent || phase === "going" ? (
          <span className="rfp-said" role="status">{sent && !phase ? "On it" : "Going ahead"}</span>
        ) : (
          <>
            <button type="button" className="rfp-btn on" onClick={() => send(GO_AHEAD_ASK, true)} title="Make every change, run the checks, leave the commit to you. It works in Auto, then goes back to the mode you picked.">
              Go ahead
            </button>
            <button type="button" className="rfp-btn" onClick={changeIt}>
              Change the plan
            </button>
            {err && <span className="rfp-said" role="status">{err}</span>}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The agent's closing line once the plan is carried out: "Done: 6 files, checks passed", with Review changes. In Code, the
 * IDE's review opens by itself, once, when this follows a Go ahead pressed here.
 */
export function RefactorDoneLine({ done }: { done: RefactorDone }) {
  const [mode] = useMode();
  const el = useRef<HTMLDivElement>(null);
  const seen = useContext(RunFacts);
  // After a Go ahead pressed here, for a line after that plan's row: once the IDE is the screen (a line that arrives while Agents
  // shows waits for Code), and never for an older refactor's line shown again.
  useEffect(() => {
    const { sid } = whereOf(el.current);
    const g = sid ? going.get(sid) : undefined;
    if (!g) return;
    if (Date.now() - g.at > GOING_FOR_MS) return void going.delete(sid);
    if (seqOf(el.current) <= g.seq || mode !== "code") return;
    going.delete(sid);
    window.dispatchEvent(new CustomEvent("friday:vsc-command", { detail: "reviewChanges" }));
  }, [mode]);
  const { title, claim } = doneSummary(done, seen);
  const bad = /failed$/.test(title) || (!claim && done.checks === "failed" && !seen);
  return (
    <div ref={el} className="rfp-done" data-checks={bad ? "failed" : claim ? "unseen" : done.checks} role="status">
      <span className="rfp-done-ico" aria-hidden="true"><Icon name={bad ? "flag" : "check"} size={13} /></span>
      <div className="rfp-done-body">
        <div className="rfp-done-top">
          <b>{title}</b>
          {mode === "code" && (
            <button type="button" className="rfp-link" onClick={() => window.dispatchEvent(new CustomEvent("friday:vsc-command", { detail: "reviewChanges" }))}>
              Review changes
            </button>
          )}
        </div>
        {claim && <span className="rfp-done-note">{claim}</span>}
        {done.note && <span className="rfp-done-note">{done.note}</span>}
      </div>
    </div>
  );
}
