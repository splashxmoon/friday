import { useEffect, useMemo, useState } from "react";
import { decisionsOf, offerNow, type Decision } from "../decision-memory.js";
import { runOf, type SessionState } from "../session/projection.js";
import { MAIN_LANE, type SessionEvent } from "../types.js";
import type { TeammateView } from "../teammates.js";
import { Icon } from "./icons.js";
import { matesIn, useTeamNow, type Team } from "./Teammates.js";
import { visitsOf } from "./crew-add-local.js";

/**
 * "Remember these for Kit?" (Code and Crew, connected, 2026-11-13: "Decisions from a session handed on are offered to the crew
 * member's memory, with a yes from you. Nothing is written in silently"). Once a crew mate of yours has finished a run in a session
 * with messages marked as decided, its keeper is asked once, with the list: Remember adds them to its memory, Not now only marks
 * them asked. Shown only then, to its keeper only, and gone once answered; the same decisions are never asked about again there
 * (decision-memory.ts).
 */

/**
 * Your crew mates' lanes in a session: in the open-source edition, the Crew's and its rooms', and those brought into a coding
 * session (crew-code.ts), every one yours.
 */
const crewLanes = (t: Team | null, sid: string): { lane: string; mate: TeammateView }[] => [
  ...matesIn(sid).map((x) => ({ lane: x.lane, mate: x.m })),
  ...visitsOf(t)
    .filter((v) => v.sid === sid)
    .flatMap((v) => ((m) => (m ? [{ lane: v.lane, mate: m }] : []))(t?.teammates.find((x) => x.id === v.mate))),
];

export default function RememberOffer({ state, events }: { state: SessionState; events: readonly SessionEvent[] }) {
  const team = useTeamNow();
  const decisions = useMemo(() => decisionsOf(state.memory), [state.memory]);
  const lanes = decisions.length ? crewLanes(team, state.id).filter((x) => state.lanes.some((l) => l.id === x.lane) || x.lane === MAIN_LANE) : [];
  // Who to ask about first: the first of your crew mates here whose run is over. One at a time, never a stack of them.
  const who = lanes.find((x) => runOf(state, x.lane).status !== "running" && events.some((e) => e.body.type === "run.ended" && (e.lane ?? MAIN_LANE) === x.lane));
  const [offered, setOffered] = useState<{ key: string; keys: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const at = who ? `${state.id} ${who.mate.id}` : "";
  useEffect(() => {
    if (!at || offered?.key === at) return;
    let live = true;
    void fetch(`/api/teammates/${who!.mate.id}/remember?sid=${encodeURIComponent(state.id)}`, { credentials: "same-origin" })
      .then((r) => (r.ok ? (r.json() as Promise<{ offered: string[] }>) : null))
      .then((r) => live && r && setOffered({ key: at, keys: r.offered }), () => {});
    return () => void (live = false);
  }, [at]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!who || offered?.key !== at) return null;
  const now: Decision[] = offerNow(decisions, offered.keys, { running: runOf(state, who.lane).status === "running", ended: 1 });
  if (!now.length) return null;
  const answer = async (keep: boolean) => {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/teammates/${who.mate.id}/remember`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sid: state.id, keys: now.map((d) => d.key), keep }) });
      const b = (await r.json().catch(() => ({}))) as { offered?: string[]; error?: string };
      if (!r.ok) throw new Error(b.error ?? "Couldn't save that. Try again in a moment.");
      setOffered({ key: at, keys: b.offered ?? [...offered.keys, ...now.map((d) => d.key)] });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const name = who.mate.name;
  return (
    <div className="banners">
      <div className="banner rmo-offer" role="group" aria-label={`Remember these for ${name}?`}>
        <Icon name="book" size={16} />
        <div className="banner-main">
          <strong>Remember these for {name}?</strong>
          <ul className="rmo-list">
            {now.map((d) => (
              <li key={d.key}>{d.text.replace(/^Decided \([^)]*\):\s*/, "")}</li>
            ))}
          </ul>
          {err && (
            <p role="alert" className="error small">
              {err}
            </p>
          )}
        </div>
        <button type="button" className="btn ghost small" disabled={busy} onClick={() => void answer(false)}>
          Not now
        </button>
        <button type="button" className="btn primary small" disabled={busy} onClick={() => void answer(true)}>
          Remember
        </button>
      </div>
    </div>
  );
}
