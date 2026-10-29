/**
 * The app, for the agents in it (Arun, 2026-10-27: "make the app fully agentic and allow the coding tools to utiilize the features of
 * the app too like cross platform talking like teams and work, etc automations, i mean everything is full agentic and can be
 * utilized by the coding tools even context in other sessions too").
 *
 * Every coding tool in any session (Code, Work, the Team room or a room) reaches, through Friday's own MCP server (agent-mesh.ts):
 * the other sessions on this computer, to list, read, search and tell (LocalPeers: on the hosted service that is peers.ts, which
 * isn't here), new sessions it starts with a task (start_session), the automations (manage_automation) and the team
 * (manage_teammate, app.ts). What it may do is what the person at this computer may do in the app; it acts for them, and what it
 * does shows in the sessions it touches as from that agent.
 *
 */
import { randomBytes } from "node:crypto";
import { hopBehind, MAX_HOPS, MODE_RANK, type MeshResult, type MeshToolDef, type Peers } from "./agent-mesh.js";
import type { AgentSchedule } from "./agents.js";
import type { Bus } from "./bus.js";
import { heldByPerson } from "./held.js";
import { laneName } from "./session/core.js";
import { laneOf, runOf, type SessionState } from "./session/projection.js";
import type { SessionStore } from "./session/store.js";
import { MAIN_LANE, type ActorRef, type EngineMode, type PeerNote, type SessionEvent } from "./types.js";

const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });

/** How many sessions are looked at, newest first: listed, read, messaged and searched alike. */
export const LOOK_AT = 60;
/** Messages one run may send to other sessions, and messages two sessions may trade in PEER_WINDOW_MS, before the agents are told to stop. */
export const MAX_PER_RUN = 6;
export const MAX_EXCHANGES = 10;
export const PEER_WINDOW_MS = 20 * 60_000;
const MAX_TEXT = 4000;
export { MODE_RANK };

const agent = (name: string): ActorRef => ({ id: "agent", name, kind: "agent" });
const lanesOf = (s: SessionState) => [MAIN_LANE, ...s.lanes.map((l) => l.id)];
const status = (s: SessionState, lane: string) => {
  const r = runOf(s, lane).status;
  return r === "running" ? "working" : r === "waiting_for_human" ? "waiting for the person" : "ready";
};
export const ago = (ts: number, now = Date.now()) => {
  const m = Math.round((now - ts) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

/** Which part of the app a session is in: Code, Work, or the team's (the Team room, or a room by its name). */
export function placeOf(s: SessionState, teamSid: string | null): string {
  if (s.options.team) return s.id === teamSid ? "Crew room" : `Crew room "${s.title}"`;
  return s.options.work ? "Work session" : "Code session";
}

/** Where a session works: its folder, repo and branch. */
function whereOf(s: SessionState): string {
  const e = Object.values(s.engines).find((x) => x.cwd);
  if (!e) return "";
  const folder = (e.copyOf ?? e.cwd).split(/[\\/]/).filter(Boolean).pop() ?? "";
  return ` · in ${e.repo ?? folder}${e.branch ? ` on ${e.branch}` : ""}`;
}

/** Messages between this session and `other`, either way, since `since`, from this session's own log. */
export function exchangesWith(events: SessionEvent[], other: string, since: number): number {
  return events.filter((e) => e.ts >= since && ((e.body.type === "peer.sent" && e.body.to.sid === other) || (e.body.type === "instruction" && e.body.peer?.fromSid === other))).length;
}

/** Pick the session meant: its id, its title, or a part of the title only one has. */
export function pickSession<T extends { s: SessionState }>(list: T[], to: string): T | string {
  const want = to.trim().replace(/^"|"$/g, "");
  const low = want.toLowerCase();
  const found =
    list.find((x) => x.s.id === want) ??
    list.find((x) => x.s.title.toLowerCase() === low) ??
    (() => {
      const part = list.filter((x) => low && x.s.title.toLowerCase().includes(low));
      return part.length === 1 ? part[0] : undefined;
    })();
  if (found) return found;
  const names = list.slice(0, 8).map((x) => `"${x.s.title}" [id ${x.s.id}]`);
  return `${want ? `No session here is called "${want}".` : "Say which session."} ${names.length ? `There are: ${names.join(", ")}.` : "There are no other sessions."}`;
}

/**
 * The other sessions on this computer, for list_sessions, read_session and message_session: every one its person has, Code, Work
 * and the team's alike. On someone's own computer there is one person, so a message goes straight to the agent named.
 */
export class LocalPeers implements Peers {
  constructor(
    private store: SessionStore,
    private bus: Bus,
    /** The Team room's session, when there is a team (app.ts). */
    private teamSid: () => Promise<string | null> = async () => null,
    /** Sessions taken away though kept in the store: rooms the person removed (teammates.ts gone). */
    private gone: () => Promise<Set<string>> = async () => new Set(),
  ) {}

  /** Sessions never to list, read or message: hidden by the person, or rooms they removed. */
  async skipped(owner: string): Promise<Set<string>> {
    const [hidden, gone] = await Promise.all([this.store.hidden(owner).catch(() => new Set<string>()), this.gone().catch(() => new Set<string>())]);
    return new Set([...hidden, ...gone]);
  }

  async around(sid: string): Promise<{ me: SessionState; near: { s: SessionState; at: number }[]; team: string | null }> {
    const me = await this.store.state(sid);
    const skip = await this.skipped(me.ownerId);
    const rows = (await this.store.mine(me.ownerId, LOOK_AT)).filter((x) => x.sid !== sid && !skip.has(x.sid));
    const states = await Promise.all(rows.map(async (x) => ({ at: x.at, s: await this.store.state(x.sid).catch(() => null) })));
    const near = states.filter((x): x is { at: number; s: SessionState } => !!x.s?.ownerId);
    near.sort((a, b) => b.at - a.at);
    return { me, near, team: await this.teamSid().catch(() => null) };
  }

  async list(sid: string): Promise<string> {
    const { near, team } = await this.around(sid);
    if (!near.length) return "There are no other sessions on this computer yet.";
    const rows = near.slice(0, 25).map(({ s, at }) => {
      const agents = lanesOf(s).filter((l) => !(s.options.team && l === MAIN_LANE)).map((l) => `${laneName(s, l)} (${status(s, l)})`).join(", ");
      return `- "${s.title}" [id ${s.id}] · ${placeOf(s, team)} · ${agents || "no agents yet"}${whereOf(s)} · active ${ago(at)}`;
    });
    return `Sessions on this computer, latest first (Code, Work and the crew's):\n${rows.join("\n")}${near.length > 25 ? `\n…and ${near.length - 25} more, less recent: search_sessions finds what was said in any of them.` : ""}`;
  }

  /** The session meant, from the list, or by its id when it is older than the list goes (one search_sessions found). */
  private async find(sid: string, me: SessionState, near: { s: SessionState; at: number }[], to: string): Promise<{ s: SessionState } | string> {
    const found = pickSession(near, to);
    if (typeof found !== "string") return found;
    const id = to.trim();
    if (!/^[\w-]{4,40}$/.test(id) || id === sid || (await this.skipped(me.ownerId)).has(id)) return found;
    const s = await this.store.state(id).catch(() => null);
    return s?.ownerId === me.ownerId ? { s } : found;
  }

  async read(sid: string, _lane: string, to: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const { me, near, team } = await this.around(sid);
    const found = await this.find(sid, me, near, to);
    if (typeof found === "string") return { ok: false, error: found };
    const s = found.s;
    const events = await this.store.events(s.id);
    const asked = events.findLast((e) => e.body.type === "instruction" && e.actor.kind === "human");
    const parts = lanesOf(s).flatMap((l) => {
      if (s.options.team && l === MAIN_LANE) return [];
      const said = events.findLast((e) => (e.lane ?? MAIN_LANE) === l && e.body.type === "agent.message" && !!e.body.text.trim());
      const text = said?.body.type === "agent.message" ? said.body.text.trim() : "";
      return [`${laneName(s, l)}, ${status(s, l)}.${text ? ` Last said (${ago(said!.ts)}):\n${text.length > 1500 ? `${text.slice(0, 1500)}…` : text}` : " Hasn't said anything yet."}`];
    });
    const open = (s.board?.tasks ?? []).filter((t) => t.status !== "done" && t.status !== "cancelled").slice(0, 10);
    const files = [...new Set(s.claims.map((c) => c.path))];
    const head = `"${s.title}" [id ${s.id}] · ${placeOf(s, team)}${whereOf(s)}`;
    return {
      ok: true,
      text: [
        head,
        s.goal ? `Goal: ${s.goal.text}` : "",
        asked?.body.type === "instruction" ? `Last asked by ${asked.actor.name} (${ago(asked.ts)}): ${asked.body.text.slice(0, 600)}` : "",
        parts.join("\n\n"),
        open.length ? `Open tasks on its board:\n${open.map((t) => `- ${t.title} (${t.status}${t.name ? `, ${t.name}` : ""})`).join("\n")}` : "",
        files.length ? `Files changed there: ${files.slice(0, 25).join(", ")}${files.length > 25 ? ` and ${files.length - 25} more` : ""}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  }

  async send(sid: string, lane: string, req: { to: string; agent?: string; text: string }): Promise<{ ok: true; sid: string; title: string; lane: string; name: string; held: boolean; text: string } | { ok: false; error: string }> {
    const text = req.text.trim().slice(0, MAX_TEXT);
    if (!text) return { ok: false, error: "The message is empty." };
    const { me, near } = await this.around(sid);
    const found = await this.find(sid, me, near, req.to);
    if (typeof found === "string") return { ok: false, error: found };
    const s = found.s;
    // Which agent there: by name, or a part of it; its main one when none is named (a team's first teammate, its room having none).
    const lanes = lanesOf(s).filter((l) => !(s.options.team && l === MAIN_LANE));
    const want = (req.agent ?? "").trim().toLowerCase();
    const at = want ? (lanes.find((l) => laneName(s, l).toLowerCase() === want) ?? lanes.find((l) => laneName(s, l).toLowerCase().includes(want))) : (s.lead && lanes.includes(s.lead) ? s.lead : lanes[0]);
    if (!at) return { ok: false, error: `"${s.title}" has ${lanes.length ? `no agent called "${req.agent}". Its agents: ${lanes.map((l) => laneName(s, l)).join(", ")}.` : "no agents yet: start one there, or start_session a new one."}` };
    if (laneOf(s, at)?.control.kind === "standing") return { ok: false, error: `${laneName(s, at)} in "${s.title}" runs on its own triggers and takes no messages. Write to another agent there.` };
    // Never further than the sender may go itself: a plan-mode agent telling a full-mode one what to do is it doing that work
    // (2026-10-27 audit: a plan-mode session made a full-mode teammate, then messaged it).
    const mine: EngineMode = me.engines[lane]?.mode ?? "edits";
    const theirs = s.engines[at]?.mode;
    if (theirs && MODE_RANK[theirs] > MODE_RANK[mine]) return { ok: false, error: `${laneName(s, at)} in "${s.title}" may do more than you may (${theirs}, you ${mine}), so it takes no messages from you. Say what you'd have it do in your reply, for the person.` };
    const events = await this.store.events(sid);
    // Counted on across sessions, from the turn that sends it (agent-mesh behindRun): two sessions' agents can't keep each other
    // going for good by messaging back and forth (2026-10-27 audit).
    const hop = hopBehind(me, events, lane) + 1;
    if (hop > MAX_HOPS) return { ok: false, error: `This would be the ${hop}th agent in a row woken by another agent's message, so Friday didn't send it. Finish what you can, and say what you needed from ${laneName(s, at)}.` };
    const lately = exchangesWith(events, s.id, Date.now() - PEER_WINDOW_MS);
    if (lately >= MAX_EXCHANGES) return { ok: false, error: `This session and "${s.title}" have sent each other ${lately} messages in the last 20 minutes. Settle it yourself, or ask the person.` };
    const since = runOf(me, lane).sinceSeq;
    const thisRun = events.filter((e) => e.seq > since && (e.lane ?? MAIN_LANE) === lane && e.body.type === "peer.sent").length;
    if (thisRun >= MAX_PER_RUN) return { ok: false, error: `This run has already sent ${thisRun} messages to other sessions. Finish your own work, or ask the person.` };
    const from: PeerNote = { fromSid: sid, fromTitle: me.title, fromLane: lane, fromName: laneName(me, lane), by: { id: me.ownerId, name: me.members[me.ownerId]?.name ?? "" }, hop };
    await this.store.append(s.id, agent(from.fromName), { type: "instruction", text, interrupt: false, peer: from }, { lane: at });
    void this.bus.wake(s.id, at);
    // On hold as its person said: it waits in its queue, and starts nothing until they say (held.ts runnableQueue).
    const onHold = heldByPerson(await this.store.events(s.id), at);
    return { ok: true, sid: s.id, title: s.title, lane: at, name: laneName(s, at), held: false, text, ...(onHold ? { onHold } : {}) };
  }
}

/** The tools for the app's own features beyond the session's (agent-mesh.ts lists them, app.ts answers them). */
export const APP_TOOLS: MeshToolDef[] = [
  {
    name: "search_sessions",
    description:
      "Search everything said in every session on this computer (Code, Work and the crew's): what the person asked, what agents answered, decisions, errors, file names. Use it to find context another session already has before you work something out again, or to find the session to read_session or message_session.",
    inputSchema: obj(
      {
        query: { type: "string", description: "Words to look for: at least three letters." },
        from: { type: "string", enum: ["any", "people", "agents"], description: "Only what people said, or only what agents said." },
        days: { type: "number", description: "Only the last this many days." },
      },
      ["query"],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "start_session",
    description:
      "Start a new Friday session on this computer with a task, run by a coding tool: a Code session for work in a repo, a Work session for writing, research, posts, images or video. Use it when the person asks for work to go on in its own session, or for a separate piece of work that needs its own agent (not for a step of your own task). It starts at once; you get its id to read_session or message_session later.",
    inputSchema: obj(
      {
        kind: { type: "string", enum: ["code", "work"], description: "Code (default) or Work." },
        title: { type: "string", description: "A short title, as the person would name it." },
        task: { type: "string", description: "What its agent should do, as a complete instruction: what, where, and what done looks like." },
        tool: { type: "string", description: "Its coding tool: claude, codex, cursor… Yours if left out." },
        folder: { type: "string", description: "The full path of the folder or repo it works in. Leave empty for a new project folder." },
      },
      ["title", "task"],
    ),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  {
    name: "manage_automation",
    description:
      "Friday's automations on this computer: a coding tool started on a schedule, by a webhook, or when a session's agent finishes, with a task. list: every one, when it runs and whether it is on. runs: one's latest runs. create: a new one when the person asks (a name, what it does, when: \"every weekday at 9:00\" as schedule {days, time}, or manual). update: change its task, schedule, tool or folder. pause / resume: turn it off or on. run: run it now.",
    inputSchema: obj(
      {
        action: { type: "string", enum: ["list", "runs", "create", "update", "pause", "resume", "run"] },
        name: { type: "string", description: "Its name (create), or which one (the others): a name or an id from list." },
        does: { type: "string", description: "What its coding tool is told each run (create, update)." },
        schedule: {
          type: "object",
          description: "When it runs (create, update). Leave out for one that only runs when asked.",
          properties: {
            days: { type: "array", items: { type: "string", enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] }, description: "Which days; every day if left out." },
            time: { type: "string", description: "24-hour HH:MM, this computer's time." },
            every: { type: "string", enum: ["day", "hour"], description: "hour runs it every hour at the minute of time." },
          },
          additionalProperties: false,
        },
        tool: { type: "string", description: "Its coding tool (create, update): claude, codex, cursor… Yours if left out." },
        folder: { type: "string", description: "The full path it works in (create, update); empty for a new project folder each run." },
        pr: { type: "boolean", description: "Open a pull request with what it changed (create, update)." },
      },
      ["action"],
    ),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
];

export const APP_INSTRUCTIONS =
  " The whole app is yours to use for the person, from any session: list_sessions, read_session and search_sessions see every session on this computer (Code, Work, the Crew room and its rooms) and what was said in them, so look there before working out again what another session already knows; message_session tells an agent in any of them something (a teammate in the Team room by its name, the agent in a Code or Work session), start_session starts a new Code or Work session with a task and a coding tool, manage_automation lists, makes, changes, pauses and runs automations, and manage_teammate lists the team, adds a teammate the person asked for and changes one's role. Use these when the person asks, or when the work needs them; say what you did in your reply.";

/** "every weekday at 9:00" as an automation's schedule (agents.ts AgentSchedule), from the tool's {days, time, every}. Null when none was given. */
export function scheduleOf(raw: unknown, tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"): AgentSchedule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { days?: unknown; time?: unknown; every?: unknown };
  const names = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const days = Array.isArray(r.days) ? [...new Set(r.days.map((d) => names.indexOf(String(d).slice(0, 3).toLowerCase())).filter((i) => i >= 0))].sort() : [];
  const time = typeof r.time === "string" && /^\d{1,2}:\d{2}$/.test(r.time.trim()) ? r.time.trim().padStart(5, "0") : "09:00";
  if (r.every === "hour") return { every: "hourly", at: time, days: [], tz };
  return days.length && days.length < 7 ? { every: "weekly", at: time, days, tz } : { every: "daily", at: time, days: [], tz };
}

/** A short random id, for things the tools make. */
export const newId = (n = 6) => randomBytes(n).toString("base64url");

export type { MeshResult };
