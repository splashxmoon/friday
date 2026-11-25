// One name per agent, everywhere it is named: the header's tabs, the feed, the sidebar, the terminal view and the Tasks label
// (audit C-14: one agent read "Rio", "Friday Code · done", "Friday", "to agent" and "Test session" in five places).
import { ENGINE_NAMES, MAIN_LANE, type SessionEvent } from "../types.js";
import { givenName, type SessionState } from "../session/projection.js";
import { logFold } from "./log-memo.js";

/** The name an agent goes by in this session, for people: the one every view of it uses (Activity's agentNameFor). */
export function agentDisplayName(state: SessionState, lane: string): string {
  return agentNameFor(state, lane);
}

export function agentNameFor(state: SessionState, lane: string): string {
  const e = state.engines[lane];
  // A folder with no CLI is still Friday Code doing the work, in that folder.
  if (e?.tool) {
    const tool = ENGINE_NAMES[e.tool];
    const tools = Object.entries(state.engines).filter(([, x]) => !!x.tool);
    // Whose it is, only when there is more than one person's to tell apart: on your own, "Arun's" on every line is noise. Never
    // a teammate's: it goes by its own name, and its keeper is said where it matters (the sidebar, its page).
    const owner = !state.options.team && new Set(tools.map(([, x]) => x.hostId)).size > 1 ? `${e.hostName}'s ` : "";
    // The name somebody gave it, over its tool's: renamed, it is called that everywhere.
    const given = givenName(state, lane);
    // A name that already says whose it is ("Arokia's Claude Code", as a teammate's lane is named when it joins) isn't given
    // the owner again: it read "Arokia Joseph's Arokia's Claude Code" (Arun, 2026-10-21).
    const first = e.hostName.trim().split(/\s+/)[0] ?? "";
    const theirs = !!first && !!given && given.toLowerCase().startsWith(`${first.toLowerCase()}'s `);
    if (given) return theirs ? given : `${owner}${given}`;
    // Two of the same tool (two Claude Code tasks side by side) are told apart by their own names, not "Claude Code" twice:
    // the lane's name when it has one of its own, else a number. Its mark already says which tool it is.
    const twins = [MAIN_LANE, ...state.lanes.map((l) => l.id)].filter((id) => state.engines[id]?.tool === e.tool && state.engines[id]?.hostId === e.hostId);
    if (twins.length > 1) {
      const own = lane === MAIN_LANE ? "" : (state.lanes.find((l) => l.id === lane)?.name ?? "").trim();
      const named = own && own.toLowerCase() !== tool.toLowerCase() ? own : twins.indexOf(lane) === 0 ? tool : `${tool} ${twins.indexOf(lane) + 1}`;
      return `${owner}${named}`;
    }
    return `${owner}${tool}`;
  }
  if (lane === MAIN_LANE) return state.mainName?.trim() || (state.options.agent?.name ?? "Friday Code");
  const l = state.lanes.find((x) => x.id === lane);
  // A lane since taken away (a teammate taken out of a room) keeps the name it had, from the log: "You made Agent the lead"
  // rewrote what was said once it went (2026-10-27 audit).
  return l?.agent?.name ?? l?.name ?? laneNamesSeen.get(lane) ?? "Agent";
}

/** Every lane's name as the logs drawn here last gave it (laneNamesFrom), lane ids being unique: kept after the lane goes. */
const laneNamesSeen = new Map<string, string>();
/** The names the log gives its lanes, as they were added and renamed: read once per log. */
const namesRead = new WeakSet<readonly SessionEvent[]>();
const namesFolded: Parameters<typeof logFold<number>>[0] = { current: null };
export function laneNamesFrom(events: readonly SessionEvent[]): ReadonlyMap<string, string> {
  if (namesRead.has(events)) return laneNamesSeen;
  namesRead.add(events);
  // The same log grown: only what was added is read (log-memo.ts; spec 13, a long session read its whole log on every event).
  logFold(namesFolded, events, () => 0, (n, e) => {
    const b = e.body;
    if (b.type === "lane.added" && b.lane.name) laneNamesSeen.set(b.lane.id, b.lane.agent?.name ?? b.lane.name);
    else if (b.type === "lane.renamed" && b.name) laneNamesSeen.set(b.laneId, b.name);
    else if (b.type === "crew.applied") for (const l of b.lanes) if (l.name) laneNamesSeen.set(l.id, l.agent?.name ?? l.name);
    return n;
  });
  return laneNamesSeen;
}

