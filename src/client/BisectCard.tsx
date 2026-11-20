import { useRef, useState } from "react";
import { MAIN_LANE } from "../types.js";
import type { AskLane } from "./Activity.js";
import { ideHint, useMode } from "./ide/mode.js";
import { Icon } from "./icons.js";
import { byLine, fixForwardText, revertText, shortSha, type Culprit } from "./bisect.js";
import "./bisect-card.css";

/**
 * Find what broke as a card (Arun, 2026-11-19, wave 2: "an agent runs git bisect… and hands back the commit that broke it"): the
 * commit, who wrote it and why it broke things, then the next steps: see the change in the IDE, fix it forward, or revert it.
 * The same card in Agents and in the narrow Code column.
 */
export function BisectCard({ culprit: c }: { culprit: Culprit }) {
  const [asked, setAsked] = useState("");
  const [mode] = useMode();
  const card = useRef<HTMLDivElement>(null);
  const send = (text: string, said: string) => {
    setAsked("…");
    const done = (r: { ok: boolean; error?: string }) => setAsked(r.ok ? said : r.error || "That didn't send");
    // To this card's own session and lane only: every other chat on the page lets it go by (Activity's friday:ask-lane).
    const row = card.current?.closest<HTMLElement>("[data-feed-sid]");
    const sid = row?.dataset.feedSid ?? "";
    const ask: AskLane = { lane: row?.dataset.lane || MAIN_LANE, text, reply: done, ...(sid ? { sid } : {}) };
    window.dispatchEvent(new CustomEvent("friday:ask-lane", { detail: ask }));
    if (!ask.handled) setAsked("Open the chat to send that");
  };
  const copy = () => {
    void navigator.clipboard?.writeText(c.commit).then(() => setAsked("Copied the hash"), () => setAsked("Couldn't copy"));
  };
  // Only where the IDE is the screen: in Agents its view is hidden and would drop the press.
  const inIde = mode === "code";
  const by = byLine(c);
  return (
    <div ref={card} className="bsc-card" role="group" aria-label="The commit that broke it">
      <div className="bsc-head">
        <span className="bsc-mark" aria-hidden="true"><Icon name="gitBranch" size={14} /></span>
        <b>Found the commit</b>
        <button type="button" className="bsc-sha" title="Copy the hash" onClick={copy}>{shortSha(c.commit)}</button>
      </div>
      <div className="bsc-title">{c.title}</div>
      {by && <div className="bsc-by">{by}</div>}
      {c.why && <div className="bsc-why">{c.why}</div>}
      {/* Divs and buttons, no p or ul: the chat's prose rules (margins, list indent) don't reach them. */}
      {c.files.length > 0 && (
        <div className="bsc-files" role="group" aria-label="Files it changed">
          {c.files.map((f) => (
            <button key={f} type="button" className="bsc-file" title={`Open ${f}${ideHint()}`} onClick={() => window.dispatchEvent(new CustomEvent("friday:open-file", { detail: { path: f }, cancelable: true }))}>
              {f}
            </button>
          ))}
        </div>
      )}
      {c.check && <div className="bsc-check">Found with <code>{c.check}</code></div>}
      <div className="bsc-acts">
        {inIde && (
          <button type="button" className="bsc-btn on" onClick={() => window.dispatchEvent(new CustomEvent("friday:vsc-command", { detail: { name: "openCommit", arg: c.commit } }))}>
            Open the change
          </button>
        )}
        <button type="button" className={`bsc-btn${inIde ? "" : " on"}`} onClick={() => send(fixForwardText(c), "Asked for a fix")}>Fix it</button>
        <button type="button" className="bsc-btn" onClick={() => send(revertText(c), "Asked for a revert")} title="Prepares a revert commit. Nothing is pushed.">Revert it</button>
        {asked && <span className="bsc-said" role="status">{asked}</span>}
      </div>
    </div>
  );
}
