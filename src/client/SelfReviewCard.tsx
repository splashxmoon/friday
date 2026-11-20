import { useEffect, useRef, useState } from "react";
import { MAIN_LANE } from "../types.js";
import type { AskLane } from "./Activity.js";
import { ideHint, useMode } from "./ide/mode.js";
import { Icon } from "./icons.js";
import { OPEN_PR_ASK, reviewCounts, SELF_REVIEW_ASK, SEVERITY_TAG, type Finding } from "./self-review.js";
import "./self-review.css";

/**
 * The agent's self-review as a card (Arun, 2026-11-19: "The agent reviews its own diff the way a senior engineer would… and fixes
 * what it finds before you see it"): what it found, what it fixed (a check) and what is left for you (a hand), then the next
 * steps. The same card in Agents and in the narrow Code column. It also tells the IDE about its findings, which show there as
 * comments on the lines.
 */
export function SelfReviewCard({ findings, files = 0 }: { findings: Finding[]; files?: number }) {
  const [asked, setAsked] = useState("");
  const [mode] = useMode();
  const card = useRef<HTMLDivElement>(null);
  // Where the card is drawn: the session and lane that wrote it, and its message's number (an Activity row's data attributes).
  const where = () => {
    const row = card.current?.closest<HTMLElement>("[data-feed-sid]");
    return { sid: row?.dataset.feedSid ?? "", lane: row?.dataset.lane || MAIN_LANE, seq: Number(row?.dataset.seq) || 0 };
  };
  // Told to the IDE when this is the newest review of a chat showing in Code (it shows that review's threads, never an older
  // card's): when drawn, and when the IDE's view asks on opening. Not on a timer, and not from a chat that isn't showing.
  const key = JSON.stringify(findings);
  useEffect(() => {
    const tell = () => {
      const el = card.current;
      if (!el || el.offsetParent === null) return;
      const feed = el.closest("[data-slot='session.feed']");
      const all = feed ? feed.querySelectorAll(".sfr-card") : [];
      if (all.length && all[all.length - 1] !== el) return;
      const w = where();
      window.dispatchEvent(new CustomEvent("friday:self-review", { detail: { findings, sid: w.sid, seq: w.seq } }));
    };
    tell();
    window.addEventListener("friday:self-review-ask", tell);
    return () => window.removeEventListener("friday:self-review-ask", tell);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const send = (text: string, said: string) => {
    setAsked("…");
    const done = (r: { ok: boolean; error?: string }) => setAsked(r.ok ? said : r.error || "That didn't send");
    // To this card's own session and lane only: every other chat on the page lets it go by (Activity's friday:ask-lane).
    const w = where();
    const ask: AskLane = { lane: w.lane, text, reply: done, ...(w.sid ? { sid: w.sid } : {}) };
    window.dispatchEvent(new CustomEvent("friday:ask-lane", { detail: ask }));
    if (!ask.handled) setAsked("Open the chat to send that");
  };
  const forYou = findings.filter((f) => f.status === "open");
  const fixed = findings.filter((f) => f.status !== "open");
  const open = forYou.length;
  // A long review shows the first few fixes and folds the rest (Arun, 2026-11-20: "this seems so cramped and information dense").
  const [allFixed, setAllFixed] = useState(false);
  const FOLD = 4;
  const fixedShown = allFixed || fixed.length <= FOLD + 1 ? fixed : fixed.slice(0, FOLD);
  // What it found, by kind, in the summary: "12 bugs · 3 security · 8 tests".
  const kinds = (["bug", "security", "test", "style"] as const)
    .map((k) => [k, findings.filter((f) => f.severity === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => (k === "security" ? `${n} security` : `${n} ${SEVERITY_TAG[k].toLowerCase()}${n === 1 ? "" : "s"}`));
  // Only where the IDE is the screen: in Agents its view is hidden and would drop the press.
  const inIde = mode === "code";
  const row = (f: Finding, i: number) => (
    <li key={i} className="sfr-row" data-status={f.status}>
      <span className="sfr-ico" aria-label={f.status === "fixed" ? "Fixed" : "Open, for you"}>
        <Icon name={f.status === "fixed" ? "check" : "hand"} size={13} />
      </span>
      <div className="sfr-body">
        <div className="sfr-title">{f.title}</div>
        {f.detail && <p className="sfr-detail">{f.detail}</p>}
        {(f.file || f.severity !== "for-you") && <div className="sfr-meta">
          {/* "For you" is its section's name already. */}
          {f.severity !== "for-you" && <span className="sfr-tag" data-sev={f.severity}>{SEVERITY_TAG[f.severity]}</span>}
          {f.file && (
            <button type="button" className="sfr-file" title={`Open ${f.file}${f.line ? ` at line ${f.line}` : ""}${ideHint()}`} onClick={() => window.dispatchEvent(new CustomEvent("friday:open-file", { detail: { path: f.file, ...(f.line ? { line: f.line } : {}) }, cancelable: true }))}>
              <Icon name="file" size={11} />
              <span>{f.file.split(/[\\/]/).pop()}{f.line ? `:${f.line}` : ""}</span>
            </button>
          )}
        </div>}
      </div>
    </li>
  );
  return (
    <div ref={card} className="sfr-card" role="group" aria-label="Self-review">
      <div className="sfr-head">
        <span className="sfr-head-mark" aria-hidden="true"><Icon name="shield" size={14} /></span>
        <b>Self-review</b>
        <span className="sfr-counts"><i aria-hidden="true">·</i>{reviewCounts(findings, files)}</span>
      </div>
      {findings.length === 0 ? (
        <p className="sfr-none">Nothing found. The diff reads clean.</p>
      ) : (
        <>
          <div className="sfr-sum">
            <span className="sfr-sum-n" data-kind="fixed"><Icon name="check" size={12} />{fixed.length} fixed</span>
            {open > 0 && <span className="sfr-sum-n" data-kind="open"><Icon name="hand" size={12} />{open} for you</span>}
            {kinds.length > 0 && <span className="sfr-sum-kinds">{kinds.join(" · ")}</span>}
          </div>
          {forYou.length > 0 && (
            <section className="sfr-sec" data-kind="open">
              <h4 className="sfr-sec-h">For you<span>{forYou.length}</span></h4>
              <ul className="sfr-list">{forYou.map(row)}</ul>
            </section>
          )}
          {fixed.length > 0 && (
            <section className="sfr-sec" data-kind="fixed">
              <h4 className="sfr-sec-h">Fixed<span>{fixed.length}</span></h4>
              <ul className="sfr-list">{fixedShown.map(row)}</ul>
              {fixedShown.length < fixed.length && (
                <button type="button" className="sfr-more" onClick={() => setAllFixed(true)}>
                  Show all {fixed.length} fixed
                </button>
              )}
              {allFixed && fixed.length > FOLD + 1 && (
                <button type="button" className="sfr-more" onClick={() => setAllFixed(false)}>
                  Show fewer
                </button>
              )}
            </section>
          )}
        </>
      )}
      <div className="sfr-acts">
        <button type="button" className="sfr-btn on" onClick={() => send(OPEN_PR_ASK, "Asked for the pull request")} title={open ? `${open} still open: said in the pull request` : undefined}>
          Open the pull request
        </button>
        {inIde && (
          <button type="button" className="sfr-btn" onClick={() => window.dispatchEvent(new CustomEvent("friday:vsc-command", { detail: "reviewChanges" }))}>
            See each fix
          </button>
        )}
        <button type="button" className="sfr-btn plain" onClick={() => send(SELF_REVIEW_ASK, "Reviewing again")}>
          Review again
        </button>
        {asked && <span className="sfr-said" role="status">{asked}</span>}
      </div>
    </div>
  );
}
