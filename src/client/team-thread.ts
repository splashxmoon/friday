import { MAIN_LANE, type MeshNote, type SessionEvent } from "../types.js";

/** The pure half of the team card and the done row (TeamCard.tsx): what folds into a team, and its clock. */

export interface TeamInfo {
  key: string;
  /** The agent that handed the work out. */
  lead: string;
  /** The task messages, in the order given. */
  tasks: SessionEvent[];
  /** The message the card is drawn at: the first task. */
  anchor: number;
}

const isTask = (m: MeshNote) => m.kind === "task" && !m.team && !m.review && !m.carriedFrom;

/**
 * The teams in what is on screen, by the seq of every message they fold: its tasks and the reports on them. A round is from one
 * of the person's messages to the next, as huddles are (Huddle.tsx); one agent giving a single task stays a huddle.
 */
export function teamsIn(events: readonly SessionEvent[], shown: (e: SessionEvent) => boolean): Map<number, TeamInfo> {
  const groups = new Map<string, TeamInfo>();
  let round = 0;
  for (const e of events) {
    const b = e.body;
    if (b.type === "instruction" && !b.mesh && !b.peer && !b.approval && e.actor.kind === "human") {
      round++;
      continue;
    }
    if (b.type !== "instruction" || !b.mesh || !isTask(b.mesh) || !shown(e)) continue;
    const key = `${b.mesh.fromLane}#${round}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, lead: b.mesh.fromLane, tasks: [], anchor: e.seq }));
    g.tasks.push(e);
  }
  const out = new Map<number, TeamInfo>();
  const byTask = new Map<string, TeamInfo>();
  for (const g of groups.values()) {
    if (new Set(g.tasks.map((e) => e.lane ?? MAIN_LANE)).size < 2) continue;
    for (const e of g.tasks) {
      out.set(e.seq, g);
      byTask.set((e.body as { mesh: MeshNote }).mesh.id, g);
    }
  }
  if (!out.size) return out;
  // The reports on those tasks are in the rows, not cards of their own.
  for (const e of events) {
    const b = e.body;
    if (b.type === "instruction" && b.mesh?.kind === "reply" && b.mesh.re && byTask.has(b.mesh.re)) out.set(e.seq, byTask.get(b.mesh.re)!);
  }
  return out;
}

/** "1:40", "12:05", "1h 4m". */
export const span = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** The threads this one's agents opened (thread.started), each once: for the thread card's Agents part. */
export function openedThreads(events: readonly SessionEvent[]): { sid: string; title: string; invite: string; fromName: string }[] {
  const out = new Map<string, { sid: string; title: string; invite: string; fromName: string }>();
  for (const e of events) if (e.body.type === "thread.started") out.set(e.body.sid, { sid: e.body.sid, title: e.body.title, invite: e.body.invite, fromName: e.body.fromName });
  return [...out.values()];
}
