import { useEffect, useState } from "react";
import { XIcon } from "lucide-react";
import { api } from "./api.js";
import type { Identity } from "./storage.js";
import { GO_AHEAD_WORDS, type GoAhead } from "../guardrails.js";
import { refreshTeam, useTeamNow } from "./Teammates.js";
import "./spend.css";

/**
 * A crew mate's decisions (Arun, 2026-11-15: "Trust that grows. After a run of yeses on one kind of approval, offer 'Always allow
 * for Kit'. Add a decision log."): what it may do on its own now, each taken back with a press, and every go-ahead it asked,
 * everywhere it works, with what came of it.
 */

type Decision = { sid: string; place: string; ts: number; tag: GoAhead; items: string[]; why: string; answer: "allowed" | "denied" | "trusted" | "waiting" | "unanswered"; by?: string };
const ANSWER: Record<Decision["answer"], string> = { allowed: "Allowed", denied: "Denied", trusted: "On its own", waiting: "Waiting on you", unanswered: "Not answered" };
const FILTERS: [string, string][] = [
  ["all", "All"],
  ["allowed", "Allowed"],
  ["denied", "Denied"],
  ["trusted", "On its own"],
  ["waiting", "Waiting"],
];
const when = (ts: number) => new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function DecisionsPage({ identity, id, name }: { identity: Identity; id: string; name: string }) {
  const [got, setGot] = useState<{ trust: GoAhead[]; decisions: Decision[] } | null>(null);
  const [err, setErr] = useState("");
  const [only, setOnly] = useState("all");
  const t = useTeamNow();
  const trust = (t?.teammates.find((m) => m.id === id)?.trust ?? got?.trust ?? []) as GoAhead[];
  useEffect(() => {
    let live = true;
    api<{ trust: GoAhead[]; decisions: Decision[] }>(identity, `/api/teammates/decisions?mate=${encodeURIComponent(id)}&days=30`)
      .then((g) => live && setGot(g))
      .catch((e: Error) => live && setErr(e.message || "Couldn't read its decisions."));
    return () => void (live = false);
  }, [identity, id]);
  const untrust = (tag: GoAhead) =>
    void api(identity, `/api/teammates/${id}`, { method: "PATCH", body: JSON.stringify({ trust: trust.filter((x) => x !== tag) }), headers: { "Content-Type": "application/json" } })
      .then(() => refreshTeam(identity))
      .catch((e: Error) => setErr(e.message || "That didn't save."));
  const list = (got?.decisions ?? []).filter((d) => only === "all" || d.answer === only || (only === "waiting" && d.answer === "unanswered"));
  const n = (a: Decision["answer"]) => (got?.decisions ?? []).filter((d) => d.answer === a).length;
  return (
    <div className="sp dc">
      <div className="sp-head">
        <h3>Decisions</h3>
      </div>
      <section className="sp-sec" aria-label="On its own">
        <h4>On its own</h4>
        {trust.length ? (
          <ul className="dc-trust">
            {trust.map((tag) => (
              <li key={tag}>
                <span>{GO_AHEAD_WORDS[tag]}</span>
                <button type="button" aria-label={`Ask again before it: ${GO_AHEAD_WORDS[tag]}`} title="Ask me again" onClick={() => untrust(tag)}>
                  <XIcon aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="sp-quiet">Nothing yet. {name} asks you before each go-ahead; after three yeses in a row to one kind, its card offers Always allow.</p>
        )}
        <p className="sp-note">A go-ahead {name} is trusted with is said yes to for you, with a receipt in the chat. Sign-ins are always yours.</p>
      </section>
      <section className="sp-sec" aria-label="Every go-ahead">
        <div className="sp-runs-head">
          <h4>The last 30 days</h4>
          {got && got.decisions.length > 0 && (
            <div className="sp-why" role="radiogroup" aria-label="Show">
              {FILTERS.map(([k, label]) => (
                <button key={k} type="button" role="radio" aria-checked={only === k} onClick={() => setOnly(k)}>
                  {label}
                  {k !== "all" && <span className="dc-n">{k === "waiting" ? n("waiting") + n("unanswered") : n(k as Decision["answer"])}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        {err && <p className="sp-err">{err}</p>}
        {!got && !err && <p className="sp-quiet">Reading its decisions…</p>}
        {got && !got.decisions.length && <p className="sp-quiet">{name} hasn't asked for a go-ahead in the last 30 days.</p>}
        {list.length > 0 && (
          <ul className="sp-runs">
            {list.map((d, i) => (
              <li key={`${d.sid} ${d.ts} ${i}`} className="dc-row">
                <span className={`dc-answer ${d.answer}`}>{ANSWER[d.answer]}</span>
                <span className="sp-run-text">
                  <span className="sp-run-ask">
                    <span className="dc-tag">{GO_AHEAD_WORDS[d.tag]}</span> {d.items[0] ? <code>{d.items[0]}</code> : d.why}
                  </span>
                  <span className="sp-run-meta">
                    {d.place} · {when(d.ts)}
                    {d.by ? ` · ${d.by.split(/\s+/)[0]}` : ""}
                    {d.why && d.items[0] ? ` · ${d.why}` : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
