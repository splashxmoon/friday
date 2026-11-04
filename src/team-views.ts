import { hubOf } from "./agents-hub.js";
import { heldByPerson } from "./held.js";
import { pendingFor, type SessionState } from "./session/projection.js";
import { roomNews, runsIn, usageOf, type LaneRun } from "./team-away.js";
import { quietCheckIns, type MateRun, type Teammate, type TeammateView } from "./teammates.js";
import { briefProof, runProof } from "./team-proof.js";
import { ENGINE_NAMES, MAIN_LANE, type SessionEvent } from "./types.js";

/**
 * How a crew stands, as the app shows it: each teammate's status, line, queue, hold and usage across everywhere it works, each
 * room's counts and last words, the Crew room's own, and a teammate's runs. One reading of the sessions for both editions: the
 * open-source edition's one crew (app.ts), and each person's view of a workspace's crew on the hosted service (hosted-crew.ts).
 */

/** What one read of a crew session gives: its state, how each agent in it stands, its last words, its news and its runs. */
export type Look = { state: SessionState; agents: ReturnType<typeof hubOf>["agents"]; said: { by: string; text: string; at: number } | null; news: number; checking: Set<string>; runs: LaneRun[]; held: Set<string>; events: SessionEvent[] };

/** Where a crew works: a session and each teammate's lane in it; `room` its room's name, or none for a Crew room. */
export interface MatePlace {
  sid: string;
  lanes: Record<string, string>;
  room?: { name: string } | null;
}

/**
 * Crew sessions as their views read them, each kept until the session has a new event (or half a minute passes, as a usage limit
 * lifting changes how one stands), so a sidebar polling every few seconds from every window, and every turn's rooms brief,
 * doesn't read whole logs again for nothing.
 */
export class TeamLooks {
  private looks = new Map<string, { seq: number; at: number; look: Look }>();
  constructor(private store: { state(sid: string): Promise<SessionState>; events(sid: string): Promise<SessionEvent[]> }) {}

  async look(sid: string): Promise<Look> {
    const state = await this.store.state(sid);
    const had = this.looks.get(sid);
    if (had && had.seq === state.lastSeq && Date.now() - had.at < 30_000) return { ...had.look, state };
    const events = await this.store.events(sid);
    // A check-in with nothing new is neither news nor the room's last words (teammate-checkins.ts quietCheckIns).
    const { quiet, checking } = quietCheckIns(events);
    const last = events.findLast((e) => e.body.type === "agent.message" && e.body.text.trim() && !quiet.has(e.seq));
    // Read once here for everything a look gives: each lane's runs (usage, activity), and who is on hold (held.ts).
    const lanes = [MAIN_LANE, ...state.lanes.map((l) => l.id)];
    const look: Look = {
      state,
      agents: hubOf(state, events).agents,
      // Said by the teammate on that lane, by its name: its actor is its keeper's tool ("Maya Chen's Claude Code").
      said: last?.body.type === "agent.message" ? { by: state.lanes.find((l) => l.id === (last.lane ?? MAIN_LANE))?.name ?? last.actor.name, text: last.body.text.trim().slice(0, 400), at: last.ts } : null,
      // What the room would show, not every run that ended (team-away.ts roomNews).
      news: roomNews(events, state.lead, quiet),
      checking,
      runs: runsIn(events, new Set(lanes)),
      held: new Set(lanes.filter((l) => heldByPerson(events, l))),
      events,
    };
    this.looks.set(sid, { seq: state.lastSeq, at: Date.now(), look });
    // Kept for the sessions looked at lately only: a removed room's look isn't kept for as long as the server runs.
    if (this.looks.size > 64) for (const [k, v] of this.looks) if (Date.now() - v.at > 10 * 60_000) this.looks.delete(k);
    return look;
  }

  /**
   * Each teammate as the app shows it: its record, how it stands across everywhere it is (busy in a room is busy: Arun,
   * 2026-10-27), what it is on, what waits for it, whether it is held, and its usage today and over the week. Working beats needing
   * you beats stopped beats limited beats idle beats offline. `problems`: why one on its own model can't run, by id.
   */
  async mates<T extends Teammate>(places: MatePlace[], list: T[], problems: Map<string, string> = new Map()): Promise<(T & TeammateView)[]> {
    const read = await Promise.all(
      places.map(async (p) => {
        const { state, agents, runs, held } = await this.look(p.sid).catch(() => ({ state: null, agents: [] as Look["agents"], runs: [] as LaneRun[], held: new Set<string>() }));
        return { ...p, state, agents, runs, held };
      }),
    );
    // Its usage today (since this server's midnight) and over the week, across everywhere it works.
    const midnight = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
    const week = Date.now() - 7 * 86_400_000;
    const usageFor = (id: string, from: number) => {
      const sum = { turns: 0, minutes: 0, tokens: 0 };
      for (const p of read) {
        const lane = p.lanes[id];
        if (!lane) continue;
        const u = usageOf(p.runs.filter((r) => r.lane === lane), from);
        sum.turns += u.turns;
        sum.minutes += u.minutes;
        sum.tokens += u.tokens;
      }
      return { turns: sum.turns, minutes: sum.minutes, ...(sum.tokens ? { tokens: sum.tokens } : {}) };
    };
    const RANK: Record<TeammateView["status"], number> = { working: 5, waiting: 4, stopped: 3, limited: 2, idle: 1, offline: 0 };
    return list.map((t): T & TeammateView => {
      let best: Pick<TeammateView, "status" | "line"> = { status: "offline", line: "" };
      let queued = 0;
      // When it last did anything anywhere it works: its own last event (projection.ts heardAt), or its last run's start or end.
      let lastAt = 0;
      for (const p of read) {
        const lane = p.lanes[t.id];
        // A room whose session can't be read (gone from the store) counts for nothing.
        if (!lane || !p.state) continue;
        const a = p.agents.find((x) => x.lane === lane);
        const engine = p.state.engines[lane];
        const status: TeammateView["status"] = !engine?.online ? "offline" : a?.status === "working" ? "working" : a?.status === "waiting" ? "waiting" : a?.status === "limited" ? "limited" : a?.status === "failed" ? "stopped" : "idle";
        queued += pendingFor(p.state, lane).length;
        const run = lane === MAIN_LANE ? p.state.run : p.state.laneRuns[lane];
        lastAt = Math.max(lastAt, p.state.heardAt?.[lane] ?? 0, run?.sinceAt ?? 0);
        // Offline keeps why (its tool not running, the computer it is on), which the first place said (2026-10-28 QA: a bare "Offline").
        const line = status === "offline" ? (a?.status === "offline" ? a.line : "Offline · their coding tool isn't running") : (a?.line ?? "");
        if (RANK[status] > RANK[best.status] || (status === "offline" && !best.line)) best = { status, line };
      }
      const problem = problems.get(t.id);
      // Stopped by a person where it last ran, and idle since: its face says stopped, never done (audit CREW-40).
      const halted = best.status === "idle" && read.some((p) => !!p.lanes[t.id] && p.state?.stopped?.[p.lanes[t.id]!] !== undefined);
      const more = { ...(lastAt ? { lastAt } : {}), ...(halted ? { halted: true as const } : {}), mode: t.mode ?? ("full" as const), held: read.some((p) => !!p.lanes[t.id] && p.held.has(p.lanes[t.id]!)), usage: { today: usageFor(t.id, midnight), week: usageFor(t.id, week) } };
      // Mid-turn it is working whatever a ping says; otherwise a model that can't run leaves it offline, and says why.
      if (problem) return { ...t, ...(best.status === "working" ? best : { status: "offline" as const, line: problem }), queued, problem, ...more };
      return { ...t, ...best, queued, ...more };
    });
  }

  /** A room as the app shows it: who is in it (their lanes there), how many work or need the person, its lead and last words. */
  async room(r: { id: string; name: string; sid: string; lanes: Record<string, string>; purpose?: string }, invite: string) {
    const { state, agents: all, said, news } = await this.look(r.sid);
    // Renamed from its own page (its title, settings.update): its title is its name.
    const name = state.title || r.name;
    const lanes = Object.values(r.lanes);
    const agents = all.filter((a) => lanes.includes(a.lane) && state.engines[a.lane]?.online);
    const doing = Object.fromEntries(agents.filter((a) => a.status === "working").map((a) => [a.lane, a.line ?? ""]));
    return { id: r.id, name, sid: r.sid, invite, lanes: r.lanes, lead: state.lead ?? null, news, ...(r.purpose ? { purpose: r.purpose } : {}), working: agents.filter((a) => a.status === "working").length, waiting: agents.filter((a) => a.status === "waiting").length, last: said, doing };
  }

  /** A Crew room's own counts, as each room's are: its teammates (`lanes`) at work there and those waiting on the person there. */
  async now(sid: string, lanes: Set<string>) {
    const { agents, news, said } = await this.look(sid);
    const here = agents.filter((a) => lanes.has(a.lane));
    const doing = Object.fromEntries(here.filter((a) => a.status === "working").map((a) => [a.lane, a.line ?? ""]));
    return { news, working: Object.keys(doing).length, waiting: here.filter((a) => a.status === "waiting").length, doing, last: said };
  }

  /** A teammate's runs everywhere it works over the last `days`, newest first, for its Activity and Results. */
  async activity(places: MatePlace[], id: string, days: number): Promise<MateRun[]> {
    const from = Date.now() - days * 86_400_000;
    const out: MateRun[] = [];
    for (const p of places) {
      const lane = p.lanes[id];
      if (!lane) continue;
      const look = await this.look(p.sid).catch(() => null);
      for (const r of look?.runs ?? []) {
        if (r.lane !== lane || (r.endedAt ?? Date.now()) < from) continue;
        // Its proof, for work: a finished run that changed files or handed proof in (team-proof.ts).
        const proof = r.endedAt !== null ? runProof(look!.events, r, r.cause.split("\n").find((l) => l.trim())?.slice(0, 120) ?? "", look!.state.lanes.find((l) => l.id === lane)?.name ?? "", p.sid) : null;
        out.push({ sid: p.sid, room: p.room ? look!.state.title || p.room.name : null, lane, startedAt: r.startedAt, endedAt: r.endedAt, outcome: r.outcome, said: r.said.slice(0, 2000), files: r.files.slice(0, 50), ...(proof && (proof.review || proof.changed.files.length) ? { proof: briefProof(proof) } : {}) });
      }
    }
    return out.sort((a, b) => b.startedAt - a.startedAt).slice(0, 500);
  }

  /**
   * The rooms as a Crew room's teammates are told them: each one's name, session and members. Told again only when that changes
   * (EngineHub's preamble), so it carries nothing that changes every turn: who is working and a room's last words did, and put
   * the rooms in front of every Crew room turn again, each staying in the conversation for good (Arun, 2026-10-31: "i am burning
   * through my claude code usage pretty fast"). read_session reads where one stands. `name`: a teammate's name by id.
   */
  async roomsBrief(rooms: readonly { sid: string; name: string; lanes: Record<string, string> }[], name: (id: string) => string | undefined): Promise<string> {
    if (!rooms.length) return "";
    const lines = await Promise.all(
      rooms.map(async (r) => {
        const { state } = await this.look(r.sid);
        const who = Object.keys(r.lanes).map((id) => name(id) ?? "someone");
        return `- "${state.title || r.name}" (session ${r.sid}): ${who.join(", ") || "nobody in it"}.`;
      }),
    );
    return ["The crew's rooms right now, where some of you work apart on one thing. To read one in full use read_session with its session id; to tell or ask its teammates something, message_session.", ...lines].join("\n");
  }

  /**
   * A teammate's work everywhere else, for its turn in one place: how it stands in each other place it works and its last words
   * there, so it neither redoes nor contradicts what it does elsewhere. `places`: each other place, named as it is told it.
   */
  async elsewhere(places: readonly { sid: string; name: string; lane: string }[]): Promise<string> {
    const lines = (
      await Promise.all(
        places.map(async (p) => {
          const look = await this.look(p.sid).catch(() => null);
          const run = look?.runs.findLast((r) => r.lane === p.lane);
          if (!look || !run) return "";
          const a = look.agents.find((x) => x.lane === p.lane);
          const how = a?.status === "working" ? `working${a.line ? ` (${a.line})` : ""}` : a?.status === "waiting" ? "waiting on the person" : "not working";
          return `- In ${p.name} (session ${p.sid}) you are ${how}.${run.said ? ` Your last words there: "${run.said.replace(/\s+/g, " ").slice(0, 200)}"` : ""}`;
        }),
      )
    ).filter(Boolean);
    return lines.length ? ["[Friday] Your work elsewhere right now (each place keeps its own conversation; read_session reads one):", ...lines].join("\n") : "";
  }
}

/**
 * Back on its own tool, what a teammate did on its backup meanwhile, with the first turn there since: its own tool's conversation
 * never saw it. Nothing once a turn has started there.
 */
export function backBrief(events: readonly SessionEvent[], lane: string): string {
  const back = events.findLast((e) => e.body.type === "teammate.switched" && e.body.lane === lane);
  if (back?.body.type !== "teammate.switched" || !back.body.back || !back.body.brief) return "";
  if (events.some((e) => e.seq > back.seq && e.body.type === "run.started" && (e.lane ?? MAIN_LANE) === lane)) return "";
  return `\nWhile ${ENGINE_NAMES[back.body.from]} stood in for ${ENGINE_NAMES[back.body.to]}, which had run out of usage, this is what you did on it (you are back on ${ENGINE_NAMES[back.body.to]}, whose conversation didn't see it):\n${back.body.brief}`;
}
