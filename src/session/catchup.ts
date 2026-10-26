import { answered } from "../session-notes-text.js";
import { ENGINE_NAMES, MAIN_LANE, type SessionEvent } from "../types.js";
import type { SessionState } from "./projection.js";

/**
 * Where a session stands, for an agent that has just joined it.
 *
 * Friday's own agent replays the whole log on every turn, so it always knows
 * what happened. A coding CLI does not: each turn it is handed only the new
 * instruction, so a Claude connected from a second laptop — or one taking over
 * a lane after its first owner left — starts from a blank page in the middle
 * of somebody else's work. It cannot know what was asked, what the other agents
 * changed, or what the team already decided, and so it asks again or redoes it.
 *
 * What it cannot be given is another machine's private memory: that is on
 * another disk. What it can be given is what the session itself recorded, which
 * is most of what matters, and is built here from the log alone — no model
 * call, so it is instant and cannot invent anything.
 */

/** Characters of catch-up, all in. A CLI has its own context window to protect. */
const BUDGET = 6000;
const cut = (t: string, n: number) => {
  const flat = t.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

/**
 * Whether this host's agent has already been through this lane.
 *
 * Not "has the lane had turns": a different host taking the lane over has not
 * heard any of them. And not "is this a new connection": the same host
 * reconnecting after a dropped link has its CLI's own memory, so repeating the
 * session back to it is noise. The thing that matters is whether *this host*
 * has been handed an instruction on *this lane* before.
 */
export function needsCatchUp(events: SessionEvent[], lane: string, hostId: string): boolean {
  let holder = "";
  for (const ev of events) {
    if ((ev.lane ?? MAIN_LANE) !== lane) continue;
    const b = ev.body;
    if (b.type === "engine.attached") holder = b.engine.hostId;
    else if (b.type === "instructions.delivered" && holder === hostId) return false;
  }
  return true;
}

/**
 * The catch-up, or "" when there is nothing before this turn to catch up on.
 *
 * Empty matters as much as full: the first instruction of a brand-new session
 * has no past, and a header announcing "you are joining partway through" over
 * nothing would be a lie told to the agent on every session's first turn.
 */
export function buildCatchUp(state: SessionState, events: SessionEvent[], pending: number[], lane: string): string {
  const now = new Set(pending);
  const first = Math.min(...pending);
  const laneName = (id: string) => (id === MAIN_LANE ? "Main" : (state.lanes.find((l) => l.id === id)?.name ?? "another lane"));
  // Who was working there, so a newcomer can tell another agent's work from its own: told only "Main … Last said: three
  // audits are running", Codex took Claude Code's audits for its own and said it would gather their results.
  const agent = (id: string) => {
    const e = state.engines[id];
    if (e?.tool) return `${e.hostName}'s ${ENGINE_NAMES[e.tool]}`;
    return (id === MAIN_LANE ? state.options.agent?.name : state.lanes.find((l) => l.id === id)?.agent?.name) ?? "Friday Code";
  };

  // What people asked, in order, by whom — before this turn, not including it.
  const asked = events
    .filter((e) => e.body.type === "instruction" && e.seq < first && !now.has(e.seq))
    .map((e) => {
      const b = e.body as Extract<SessionEvent["body"], { type: "instruction" }>;
      const where = (e.lane ?? MAIN_LANE) === lane ? "" : ` (to ${laneName(e.lane ?? MAIN_LANE)})`;
      return `${e.actor.name}${where}: ${cut(b.text, 280)}`;
    });

  // What each agent actually changed, and the last thing it said about it.
  const work: string[] = [];
  const lanes = [...new Set([MAIN_LANE, ...state.lanes.map((l) => l.id), ...Object.keys(state.diffs)])];
  for (const id of lanes) {
    const files = state.diffs[id]?.files ?? [];
    const said = events.findLast((e) => (e.lane ?? MAIN_LANE) === id && e.seq < first && e.body.type === "agent.message" && e.body.text.trim() && !e.body.toolCalls.length);
    if (!files.length && !said) continue;
    const list = files.length ? ` changed ${files.slice(0, 8).map((f) => f.path).join(", ")}${files.length > 8 ? ` and ${files.length - 8} more` : ""}.` : "";
    const last = said && said.body.type === "agent.message" ? ` Last said: “${cut(said.body.text, 240)}”` : "";
    work.push(`${laneName(id)}${list}${last} (${agent(id)})`.trim());
  }

  const committed = events
    .filter((e) => e.seq < first && e.body.type === "folder.committed" && !e.body.error)
    .slice(-3)
    .map((e) => (e.body.type === "folder.committed" ? `“${cut(e.body.message, 80)}” on ${e.body.branch || "the current branch"}` : ""));

  const decided = answered(events.filter((e) => e.seq < first)).map((d) => `${d.question} → ${d.answer}`);

  if (!asked.length && !work.length && !committed.length && !decided.length) return "";

  const section = (title: string, rows: string[]) => (rows.length ? [`${title}:`, ...rows.map((r) => `- ${r}`), ""] : []);
  // Newest asks survive when there is not room for all of them.
  const fit = (rows: string[], room: number) => {
    const kept: string[] = [];
    let used = 0;
    for (const r of [...rows].reverse()) {
      if (used + r.length + 4 > room) break;
      kept.unshift(r);
      used += r.length + 4;
    }
    return kept;
  };
  const header = [
    `[Friday] You are joining "${cut(state.title || "this session", 80)}" partway through. This is where it stands, so you do not start from nothing.`,
    "It is background, not a list of things to do: treat it as work already done unless the new message below says otherwise.",
    "The agents named in it are others, not you: anything they said they still have running is theirs, and you cannot see it or collect its results.",
    "",
  ];
  const fixed = [...section("Already decided", decided), ...section("What the agents have done", work), ...section("Committed", committed)];
  const room = Math.max(600, BUDGET - header.join("\n").length - fixed.join("\n").length);

  return [...header, ...fixed, ...section("What people have asked, oldest first", fit(asked, room)), "Now, the new message:", ""].join("\n");
}
