import { useEffect, useState } from "react";
import type { TrackedGoal } from "../goals.js";
import { api } from "./api.js";
import { Icon } from "./icons.js";
import type { Identity } from "./storage.js";

/**
 * Your goals, on the home screen (goals.ts; Arun, 2026-10-31: Friday as the intelligence layer). Every goal you set, in a
 * session, a hub or a Crew room running on its own: at risk first and why, then waiting on you, then the nearest deadline.
 * One line each, opening where the work is. Nothing shows when there are no goals.
 */

const STATUS: Record<TrackedGoal["status"], string> = { "at-risk": "At risk", waiting: "Waiting on you", "on-track": "On track", met: "Met" };
const KIND: Record<TrackedGoal["kind"], string> = { goal: "", hub: "Hub · ", room: "Room · " };

function when(g: TrackedGoal, now: number): string {
  if (!g.due) return "";
  const left = g.due - now;
  if (left < 0) return "overdue";
  const t = new Date(g.due);
  return left < 86_400_000 ? `due ${t.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : `due ${t.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}`;
}

export function GoalsCard({ identity }: { identity: Identity }) {
  const [data, setData] = useState<{ goals: TrackedGoal[]; invites: Record<string, string> } | null>(null);
  useEffect(() => {
    let gone = false;
    const read = () => void api<{ goals: TrackedGoal[]; invites: Record<string, string> }>(identity, "/api/goals").then((r) => !gone && setData(r), () => {});
    read();
    const t = setInterval(read, 60_000);
    return () => ((gone = true), clearInterval(t));
  }, [identity.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data?.goals.length) return null;
  const now = Date.now();
  const open = (g: TrackedGoal) => {
    const invite = data.invites[g.where.sid];
    if (invite) dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid: g.where.sid, invite } }));
  };
  return (
    <section className="db-card goals-card" aria-label="Your goals">
      <div className="ha-head">
        <h2>Your goals</h2>
        <span className="db-range">{data.goals.filter((g) => g.status === "at-risk").length ? `${data.goals.filter((g) => g.status === "at-risk").length} at risk` : "all on track"}</span>
      </div>
      <ul className="db-body goals-list">
        {data.goals.slice(0, 6).map((g) => (
          <li key={g.id}>
            <button type="button" className="goal-row" data-status={g.status} onClick={() => open(g)} title={`Open ${g.where.title}`}>
              <span className="goal-dot" aria-hidden>
                {g.status === "met" ? <Icon name="check" size={11} /> : null}
              </span>
              <span className="goal-main">
                <span className="goal-name">{g.text}</span>
                <span className="goal-meta">
                  {STATUS[g.status]}
                  {g.why && g.status !== "on-track" ? ` · ${g.why}` : ""}
                </span>
              </span>
              <span className="goal-side">
                <span>
                  {KIND[g.kind]}
                  {g.where.title}
                </span>
                <span>
                  {[g.progress ? `${g.progress.done} of ${g.progress.total}` : "", when(g, now)].filter(Boolean).join(" · ")}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
