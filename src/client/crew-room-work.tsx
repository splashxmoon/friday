import { latestPlan } from "../left-off.js";
import { runOf, type SessionState } from "../session/projection.js";
import type { SessionEvent } from "../types.js";
import { focusAgent } from "./agentFocus.js";
import { useNow } from "./presence.js";
import "./crew-room-work.css";
import { Face, mateOn, mateStatus, plainDoing } from "./Teammates.js";

/**
 * A task one crew mate hands another, as one card in the room that updates in place, the way OpenBot shows a task (Arun,
 * 2026-11-18: "Build all three", then "add back the steps thing instead of the mate panel"): each working mate's own reply keeps
 * its shimmering step line, and the card says where the handed task stands.
 */

const elapsed = (since: number, now: number) => {
  const s = Math.max(0, Math.round((now - since) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

export type TaskStatus = { word: string; how: string };

/**
 * A task one mate gave another, as OpenBot shows a task (a card in the chat, updated in place): who has it and what it is, where it
 * stands (working with its step and plan, waiting on you, done), and pressed, that mate's own chat.
 */
export function TaskCard({ state, events, lane, toName, title, status, from }: { state: SessionState; events: readonly SessionEvent[]; lane: string; toName: string; title: string; status: TaskStatus; from: { seq: number; ts: number } }) {
  const now = useNow(status.how === "work" ? 1000 : 30_000);
  const m = mateOn(lane);
  const waiting = !!state.approvals[lane] || !!state.openQuestions?.[lane] || runOf(state, lane).status === "waiting_for_human";
  const plan = status.how === "work" || waiting ? latestPlan(events as SessionEvent[], lane) : [];
  const done = plan.filter((s) => s.done).length;
  const step = m && status.how === "work" ? plainDoing(mateStatus(m, { sid: state.id, lane }).line) : "";
  const how = waiting ? "needs" : status.how;
  const pill = waiting ? "Needs you" : status.how === "work" ? `Working · ${elapsed(from.ts, now).replace(/ \d+s$/, "")}` : status.word;
  return (
    <button type="button" className="tcard" data-how={how} onClick={() => focusAgent(state.id, lane)} aria-label={`${toName}: ${title}. ${pill}. Open ${toName}'s chat`}>
      <span className="tcard-head">
        {m && <Face seed={m.look ?? m.name} size={18} />}
        <b>{toName}</b>
        <span className="tcard-title">{title}</span>
        <span className="tcard-pill">{pill}</span>
      </span>
      {plan.length > 0 && how !== "done" && (
        <span className="tcard-bar" aria-hidden>
          <b style={{ width: `${Math.round((done / plan.length) * 100)}%` }} />
        </span>
      )}
      {(how === "work" || how === "needs") && (
        <span className="tcard-foot">
          <span>{waiting ? (state.approvals[lane] ? `Asks: ${state.approvals[lane]!.items[0] ?? "a go-ahead"}` : "Asks you a question") : [plan.length ? `${done} of ${plan.length} steps` : "", step].filter(Boolean).join(" · ") || "Starting"}</span>
          <span className="tcard-open">Open ›</span>
        </span>
      )}
    </button>
  );
}
