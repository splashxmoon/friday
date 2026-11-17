import path from "node:path";
import type { SessionState } from "./session/projection.js";
import { MAIN_LANE, type SessionEvent } from "./types.js";

/**
 * A crew room's work, whole, to carry on somewhere else (Arun, 2026-11-15: "allow for like crew work in a room to be send too..
 * with proper context and stuff as well.... not just individual agent work"): what the room is for and its goal, who is in it,
 * its board, what each crew mate found and the files it made, who is still at it, and the crew's last words to each other. Sent as
 * a message to another room's lead (RoomSend), or read before Bring it in takes its work into a coding session.
 */

export interface RoomBriefIn {
  name: string;
  purpose?: string;
  /** Its self-run goal, when it runs on its own. */
  goal?: string;
  /** Each member: name, its lane in the room, whether it leads. */
  members: { name: string; lane: string; lead: boolean }[];
  state: SessionState;
  events: readonly SessionEvent[];
}

const clip = (s: string, n: number) => ((t) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t))(s.trim());
const WRITES = /^(write|write_file|create_file|edit|edit_file)$/i;

/** The files a lane made or changed: its folder's diff, and what it wrote by name elsewhere, whole paths, newest work first. */
function filesOf(state: SessionState, events: readonly SessionEvent[], lane: string): string[] {
  const cwd = state.engines[lane]?.cwd;
  const out = new Set<string>();
  for (const f of state.diffs[lane]?.files ?? []) if (!/(^|\/)MEMORY\.md$/i.test(f.path)) out.add(cwd && !path.isAbsolute(f.path) ? path.join(cwd, f.path) : f.path);
  for (const e of events) {
    if ((e.lane ?? MAIN_LANE) !== lane || e.body.type !== "agent.message") continue;
    for (const c of e.body.toolCalls ?? []) {
      if (!WRITES.test(c.name)) continue;
      try {
        const a = JSON.parse(c.arguments || "{}") as { path?: unknown; file_path?: unknown };
        const p = String(a.file_path ?? a.path ?? "").trim();
        if (p && !/(^|\/)MEMORY\.md$/i.test(p)) out.add(cwd && !path.isAbsolute(p) ? path.join(cwd, p) : p);
      } catch {
        /* not readable */
      }
    }
  }
  return [...out].slice(0, 12);
}

export function roomBrief(r: RoomBriefIn): string {
  const lines: string[] = [`[From the room "${r.name}"] What this room did, for you to carry on with here. The files are on this computer: read them where they are.`];
  if (r.goal) lines.push(`Its goal: ${clip(r.goal, 400)}`);
  if (r.purpose) lines.push(`It is for: ${clip(r.purpose, 400)}`);
  lines.push(`Who worked there: ${r.members.map((m) => `${m.name}${m.lead ? " (lead)" : ""}`).join(", ") || "nobody"}.`);
  const tasks = (r.state.board?.tasks ?? []).filter((t) => t.status !== "cancelled");
  if (tasks.length) {
    const done = tasks.filter((t) => t.status === "done").length;
    lines.push("", `Its board, ${done} of ${tasks.length} done:`);
    for (const t of tasks.slice(0, 12)) lines.push(`- [${t.status}] ${clip(t.title, 120)}${t.name ? ` (${t.name})` : ""}`);
  }
  lines.push("", "What each found:");
  let any = false;
  for (const m of r.members) {
    const evs = r.events.filter((e) => (e.lane ?? MAIN_LANE) === m.lane);
    const end = evs.findLast((e) => e.body.type === "run.ended" && e.body.outcome === "done");
    const said = end ? evs.findLast((e) => e.seq <= end.seq && e.body.type === "agent.message" && e.body.text.trim()) : undefined;
    const files = filesOf(r.state, r.events, m.lane);
    const working = r.state.laneRuns[m.lane]?.status === "running";
    if (!said && !files.length && !working) continue;
    any = true;
    lines.push("", `${m.name}${end ? ` (finished ${new Date(end.ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })})` : ""}:`);
    if (said?.body.type === "agent.message") lines.push(clip(said.body.text, 1200));
    if (files.length) lines.push(`Files: ${files.map((f) => `\`${f}\``).join(", ")}`);
    if (working) lines.push("Still at work there now.");
  }
  if (!any) lines.push("Nothing finished yet.");
  // The crew's last words to each other there: what they agreed and handed on.
  const talk = r.events.filter((e) => e.body.type === "instruction" && !!e.body.mesh).slice(-4);
  if (talk.length) {
    lines.push("", "The crew's last words to each other:");
    for (const e of talk) if (e.body.type === "instruction" && e.body.mesh) lines.push(`- ${e.body.mesh.fromName} to ${e.body.mesh.toName}: ${clip(e.body.text.replace(/\s+/g, " "), 220)}`);
  }
  lines.push("", "Take what it found as given unless something here says otherwise, and say in a line what you will do with it.");
  return lines.join("\n").slice(0, 7800);
}
