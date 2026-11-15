import { useState } from "react";
import type { SessionState } from "../session/projection.js";
import { MAIN_LANE, type SessionEvent } from "../types.js";
import { Face, mateOn } from "./Teammates.js";

/**
 * Who a crew mate is waiting on (after OpenBot's "Waiting for replies 2/3"; Arun, 2026-11-15: "we need ours to be the same"): each
 * teammate it asked or handed work to since the person last wrote to it, and how that stands, from the log: asked, working on it,
 * needing the person, replied, or stopped short. Nothing once every one has answered.
 */
export type Waiting = { id: string; lane: string; name: string; state: "asked" | "working" | "needs" | "replied" | "stopped" };

export function waitingOn(events: readonly SessionEvent[], state: Pick<SessionState, "laneRuns" | "approvals" | "openQuestions">, lane: string): Waiting[] {
  // Since the person's last word to it: older asks belong to work that's over.
  const from = events.findLast((e) => (e.lane ?? MAIN_LANE) === lane && e.body.type === "instruction" && e.actor.kind === "human")?.seq ?? 0;
  const out = new Map<string, Waiting>();
  const delivered = new Set<number>();
  for (const e of events) if (e.body.type === "instructions.delivered") for (const q of e.body.seqs) delivered.add(q);
  for (const e of events) {
    if (e.seq <= from) continue;
    const b = e.body;
    if (b.type === "instruction" && b.mesh && b.mesh.fromLane === lane && (b.mesh.kind === "ask" || b.mesh.kind === "task")) {
      const to = e.lane ?? MAIN_LANE;
      const run = state.laneRuns[to];
      out.set(b.mesh.id, { id: b.mesh.id, lane: to, name: b.mesh.toName, state: state.approvals[to] || state.openQuestions[to] ? "needs" : delivered.has(e.seq) && run?.status === "running" ? "working" : "asked" });
    }
    if (b.type === "mesh.replied") {
      const w = out.get(b.id);
      if (w) w.state = b.short ? "stopped" : "replied";
    }
    if (b.type === "instruction" && b.mesh?.kind === "reply" && b.mesh.re) {
      const w = out.get(b.mesh.re);
      if (w) w.state = "replied";
    }
  }
  const list = [...out.values()];
  return list.some((w) => w.state !== "replied" && w.state !== "stopped") ? list : [];
}

const WORD: Record<Waiting["state"], string> = { asked: "Asked", working: "Working", needs: "Needs you", replied: "Replied", stopped: "Stopped" };

export function CrewWaiting({ events, state, lane }: { events: readonly SessionEvent[]; state: SessionState; lane: string }) {
  const list = waitingOn(events, state, lane);
  if (!list.length) return null;
  const done = list.filter((w) => w.state === "replied").length;
  return (
    <section className="cwait" aria-label="Waiting for replies">
      <span className="cwait-head">
        Waiting for replies <b>{done} of {list.length}</b>
      </span>
      <ul className="cwait-list">
        {list.map((w) => {
          const m = mateOn(w.lane);
          return (
            <li key={w.id} className="cwait-who" data-state={w.state}>
              <Face seed={m ? (m.look ?? m.name) : w.name} size={18} />
              <span className="cwait-name">{m?.name ?? w.name}</span>
              <span className="cwait-state">{WORD[w.state]}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A draft a crew mate asked to send (agent-mesh.ts propose_send), not answered yet: the person's next word to it answers it. */
export type Draft = { id: string; via: string; to: string; subject: string; body: string };

export function pendingDraft(events: readonly SessionEvent[], lane: string): Draft | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if ((e.lane ?? MAIN_LANE) !== lane) continue;
    // The person has written to it since: that answered it, or put it aside.
    if (e.body.type === "instruction" && e.actor.kind === "human") return null;
    if (e.body.type !== "agent.message") continue;
    const c = e.body.toolCalls.findLast((t) => /(^|__)propose_send$/.test(t.name));
    if (!c) continue;
    try {
      const a = JSON.parse(c.arguments || "{}") as Record<string, unknown>;
      const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
      return s("body").trim() ? { id: c.id, via: s("via") || "Message", to: s("to"), subject: s("subject"), body: s("body") } : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * What a crew mate would send, before it goes (after OpenBot's send preview; Arun, 2026-11-15): where and to whom, its subject and
 * its words, with Send, Edit (change it, then send yours) and Keep draft. The answer is the crew mate's next message.
 */
export function DraftCard({ events, lane, send }: { events: readonly SessionEvent[]; lane: string; send: (text: string) => void }) {
  const d = pendingDraft(events, lane);
  const [editing, setEditing] = useState<string | null>(null);
  if (!d) return null;
  const m = mateOn(lane);
  const name = m?.name ?? "It";
  const answer = (text: string) => (setEditing(null), send(text));
  return (
    <section className="dc" aria-label={`${name} wants to send`}>
      <header className="dc-head">
        {m && <Face seed={m.look ?? m.name} size={18} />}
        <b>{name} wants to send</b>
        <span>
          {d.via}
          {d.to ? ` to ${d.to}` : ""}
        </span>
      </header>
      <div className="dc-draft">
        {d.subject && <p className="dc-subject">{d.subject}</p>}
        {editing === null ? <p className="dc-body">{d.body}</p> : <textarea className="dc-edit" value={editing} rows={Math.min(14, Math.max(4, editing.split("\n").length + 1))} aria-label="The draft" onChange={(e) => setEditing(e.target.value)} />}
      </div>
      <div className="dc-acts">
        {editing === null ? (
          <>
            <button type="button" className="dc-btn primary" onClick={() => answer(`Send it to ${d.to || "them"}, exactly as you showed it.`)}>
              Send
            </button>
            <button type="button" className="dc-btn" onClick={() => setEditing(d.body)}>
              Edit
            </button>
            <button type="button" className="dc-btn quiet" onClick={() => answer("Don't send it. Keep it as a draft where I can find it, and tell me where.")}>
              Keep draft
            </button>
          </>
        ) : (
          <>
            <button type="button" className="dc-btn primary" disabled={!editing.trim()} onClick={() => answer(`Send it to ${d.to || "them"} with my changes, word for word:\n\n${editing}`)}>
              Send my version
            </button>
            <button type="button" className="dc-btn quiet" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </>
        )}
      </div>
    </section>
  );
}
