import { useEffect, useState } from "react";
import type { ReadyItem } from "../ready.js";
import { proofLine } from "../ready.js";
import { api } from "./api.js";
import { EngineMark } from "./BrandMarks.js";
import { focusAgent } from "./agentFocus.js";
import type { Identity } from "./storage.js";
import "./daily-brief.css";

/**
 * Ready to ship, on the home screen (ready.ts; Arun, 2026-11-01, the impress map): every agent's finished work across your
 * sessions, proven first, each with what proves it and how big it is. "Review & ship" opens that agent's chat, where its
 * changes are committed and its pull request opened; "Send back" tells it what to change without leaving home. Three at a time,
 * the rest behind "Show all" (Arun, 2026-11-01: twelve rows of loud buttons, "i dont like this"). Nothing shows when nothing
 * is waiting to ship.
 */
export function ReadyCard({ identity }: { identity: Identity }) {
  const [data, setData] = useState<{ items: ReadyItem[]; invites: Record<string, string> } | null>(null);
  const [back, setBack] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [said, setSaid] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let gone = false;
    const read = () => void api<{ items: ReadyItem[]; invites: Record<string, string> }>(identity, "/api/ready").then((r) => !gone && setData(r), () => {});
    read();
    const t = setInterval(read, 60_000);
    return () => ((gone = true), clearInterval(t));
  }, [identity.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data?.items.length) return null;
  const key = (i: ReadyItem) => `${i.sid}:${i.lane}`;
  const open = (i: ReadyItem) => {
    const invite = data.invites[i.sid];
    if (!invite) return;
    focusAgent(i.sid, i.lane);
    dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid: i.sid, invite } }));
  };
  const send = async (i: ReadyItem) => {
    const invite = data.invites[i.sid];
    const text = note.trim();
    if (!invite || !text) return;
    try {
      await api(identity, `/api/sessions/${encodeURIComponent(i.sid)}/instruct?invite=${encodeURIComponent(invite)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, lane: i.lane }) });
      setSaid(`Sent to ${i.who}.`);
      setBack(null);
      setNote("");
    } catch (e) {
      setSaid(e instanceof Error ? e.message : "That didn't go through.");
    }
  };
  const proven = data.items.filter((i) => !i.pr && (i.checks?.ok || i.review?.ok)).length;
  const shown = all ? data.items : data.items.slice(0, 3);
  return (
    <section className="db-card ready-card" aria-label="Ready to ship">
      <div className="ha-head">
        <h2>Ready to ship</h2>
        <span className="db-range">{proven ? `${proven} proven` : `${data.items.length} to look at`}</span>
      </div>
      {said && <p className="ready-said" role="status">{said}</p>}
      <ul className="db-body ready-list">
        {shown.map((i) => (
          <li key={key(i)}>
            <div className="ready-row" data-proof={i.checks?.ok || i.review?.ok ? "ok" : i.checks || (i.review && !i.review.ok) ? "bad" : "none"}>
              <span className="ready-mark" aria-hidden="true">{i.tool ? <EngineMark tool={i.tool} size={16} /> : null}</span>
              <span className="ready-main">
                <span className="ready-name">{i.task ?? `${i.who}'s changes`}</span>
                <span className="ready-meta">
                  {i.who} · {proofLine(i)}
                  {i.pr ? " · pull request open" : ""} · <b className="ready-add">+{i.additions}</b> <b className="ready-del">−{i.deletions}</b>
                </span>
              </span>
              <span className="ready-acts">
                {i.pr ? (
                  <a className="ready-btn" href={i.pr.url} target="_blank" rel="noreferrer">
                    Open PR
                  </a>
                ) : (
                  <button type="button" className="ready-btn" onClick={() => open(i)}>
                    Review
                  </button>
                )}
                <button type="button" className="ready-btn ready-quiet" onClick={() => (setBack(back === key(i) ? null : key(i)), setNote(""), setSaid(null))} aria-expanded={back === key(i)}>
                  Send back
                </button>
              </span>
            </div>
            {back === key(i) && (
              <form className="ready-back" onSubmit={(e) => (e.preventDefault(), void send(i))}>
                <label className="sr-only" htmlFor={`back-${key(i)}`}>
                  What should {i.who} change?
                </label>
                <input id={`back-${key(i)}`} autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder={`What should ${i.who} change?`} />
                <button type="submit" className="ready-btn ready-go" disabled={!note.trim()}>
                  Send
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>
      {data.items.length > 3 && (
        <button type="button" className="ready-more" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${data.items.length}`}
        </button>
      )}
    </section>
  );
}
