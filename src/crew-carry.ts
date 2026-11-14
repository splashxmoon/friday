import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import type { Visit } from "./crew-code.js";
import { ASK_DEFAULT, bringBrief, cleanAsk, cleanCarry, finisherFrom, handBrief, laneState, ownOutcome, planCount, prsIn, rankMates, roomLine, type AskKey } from "./crew-carry-rules.js";
import { latestPlan, leftOff } from "./left-off.js";
import { driverOf, handedOn, runOf, type SessionState } from "./session/projection.js";
import type { SessionStore } from "./session/store.js";
import type { Room, Teammate } from "./teammates.js";
import { MAIN_LANE, type SessionEvent } from "./types.js";

/**
 * "Keep this going" on this computer (Code and Crew, connected, ported to the open-source edition from Friday Teams 70643270,
 * e4d637ea, 1584f368, 773e15e7, 75d5712d, 7afa7b97, f0721afd, b3c206f2 and cd68a6b5): the rest of a coding session handed on in one
 * step, from where the person already is (the session's menu, a row's menu, the end of a run, "@Kit finish this" in the box),
 * carrying where it stands.
 *
 * - To one of your crew mates: it comes into this session as a lane (crew-code.ts), in a copy of the session's folder of its own on
 *   its own branch, the uncommitted changes carried in, and is told where it stands. The hosted edition opens a crew job of its own
 *   for this (crew-jobs.ts); on this computer the crew mate's lane is the job, the session's line keeps up with it from its runs.
 * - To a crew room: posted there as the person's own message to the room's lead; the room runs it by its own rules.
 * - The session says once who took it (crew.handed, crew.handed.room), then keeps that one line up to date (crew.handed.moved) and
 *   shows the result there; its row in the sidebar says "Kit is on it".
 * - The wheel moves: typing in the lane again asks "Take it back" or "Send Kit a note" (the client), answered here.
 * - Bring it in: a crew mate's or a room's finished work back into this session, with a look first (piecesFor): weighed against
 *   this session, the files changed here too named, only the picked files coming in, for this session's agent to merge.
 *
 * Left out, being the team's: a person or a teammate's crew mate taking it, standing hand-offs, leftovers as board tasks.
 */

type Person = { id: string; name: string };

export interface CarryDeps {
  redis: Redis;
  prefix: string;
  store: Pick<SessionStore, "state" | "events" | "append">;
  crew: { list(): Promise<Teammate[]>; get(id: string): Promise<Teammate | null>; rooms(): Promise<Room[]>; team(): Promise<string | null> };
  /** The crew mates brought into a session (crew-code.ts). */
  visitsIn: (sid: string) => Promise<Visit[]>;
  /** A crew mate into this session for the hand-off, in a copy of its folder of its own (app.ts visitInto). */
  bringInto: (by: Person, t: Teammate, sid: string, carry: boolean) => Promise<{ lane: string; started: boolean; why?: string }>;
  /** A message in a session as the person's own, to the lane named: core's instruct. Its seq. */
  post: (sid: string, by: Person, text: string, lane: string) => Promise<number>;
  /** A lane's run stopped, its queue kept (core's run.pause). */
  stop: (sid: string, by: Person, lane: string) => Promise<void>;
  /** Where a crew mate runs, for what its row on the sheet says. */
  where: (t: Teammate) => { connected: boolean; label: string };
  /** A link into a session (its invite), for the room's line to open it. */
  invite: (sid: string) => string;
  log: (line: string) => void;
}

export class CarryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The hand-off and the session, linked: what its moves are said against. */
interface Link {
  sid: string;
  lane: string;
  job: string;
  jobLane: string;
  /** The seq of the work as it was given to the crew mate: its runs from then on are this hand-off's. */
  from: number;
  by: Person;
  ask: AskKey[];
  mateName: string;
  /** The last progress said, so a plan written again with nothing new says nothing. */
  said?: string;
}

const FRIDAY = { id: "friday", name: "Friday", kind: "system" as const };
const ENDS: readonly string[] = ["done", "declined", "expired", "ended"];
const first = (n: string) => n.split(/\s+/)[0] || n;
const str = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");

export function crewCarry(d: CarryDeps) {
  const k = (part: string) => `${d.prefix}crew:carry:${part}`;
  const linkOf = async (job: string): Promise<Link | null> => {
    const raw = await d.redis.get(k(`job:${job}`));
    return raw ? (JSON.parse(raw) as Link) : null;
  };
  const putLink = async (l: Link) => {
    await d.redis.multi().set(k(`job:${l.job}`), JSON.stringify(l), "EX", 30 * 86_400).hset(k(`sid:${l.sid}`), l.jobLane, l.job).expire(k(`sid:${l.sid}`), 30 * 86_400).exec();
  };
  /** The hand-off a crew mate's lane in a session is working on, if any. */
  const linkOn = async (sid: string, lane: string): Promise<Link | null> => {
    const job = await d.redis.hget(k(`sid:${sid}`), lane);
    return job ? linkOf(job) : null;
  };
  const steer = (state: SessionState, me: Person, what: string) => {
    const m = state.members[me.id];
    if (!m || m.removed || m.role === "viewer") throw new CarryError(403, what);
  };

  /** The lane a hand-off is about: the one named, else the one this person drives that ran last, else the main lane; never a crew mate's. */
  const laneFor = async (state: SessionState, events: SessionEvent[], me: string, lane?: string): Promise<string> => {
    const crew = new Set((await d.visitsIn(state.id)).map((v) => v.lane));
    const lanes = [MAIN_LANE, ...state.lanes.map((l) => l.id)].filter((l) => !crew.has(l));
    if (lane && lanes.includes(lane)) return lane;
    const mine = lanes.filter((l) => driverOf(state, l)?.id === me || state.engines[l]?.hostId === me);
    const ran = (l: string) => events.findLast((e) => (e.lane ?? MAIN_LANE) === l && e.body.type === "run.started")?.seq ?? -1;
    return [...(mine.length ? mine : lanes)].sort((a, b) => ran(b) - ran(a))[0] ?? MAIN_LANE;
  };

  /** What the session holds for a hand-off of `lane`: where we left off, its branch and changes, the question it waits on. */
  const standing = (state: SessionState, events: SessionEvent[], lane: string) => {
    const note = leftOff(state, events);
    const open = note.sections.find((s) => s.label === "Still open")?.items ?? [];
    const decided = note.sections.find((s) => s.label === "Decided along the way")?.items ?? [];
    const e = state.engines[lane];
    const files = (state.diffs[lane]?.files ?? []).map((f) => f.path);
    const question = state.openQuestions[lane]?.question ?? state.asks[lane]?.questions?.[0]?.question ?? "";
    const turns = events.filter((x) => (x.lane ?? MAIN_LANE) === lane && (x.body.type === "instruction" || x.body.type === "agent.message")).length;
    return { note, open, decided, branch: e?.branch ?? "", files, question, turns, engine: e };
  };

  /** The crew rooms, each with who takes a hand-off: the room's lead, else its first crew mate. A room with nobody in it is left out. */
  const roomsFor = async (mates: readonly Teammate[]) => {
    const out: { id: string; name: string; sid: string; to: string; lane: string; mates: string[]; line: string }[] = [];
    for (const r of await d.crew.rooms()) {
      const st = await d.store.state(r.sid).catch(() => null);
      if (!st) continue;
      const lanes = Object.entries(r.lanes);
      const lead = lanes.find(([, l]) => l === st.lead) ?? lanes[0];
      if (!lead) continue;
      const names = lanes.map(([id]) => mates.find((x) => x.id === id)?.name).filter((n): n is string => !!n);
      const to = mates.find((x) => x.id === lead[0])?.name ?? "its lead";
      out.push({ id: r.id, name: st.title || r.name, sid: r.sid, to, lane: lead[1], mates: names, line: roomLine(to, names.length) });
    }
    return out.slice(0, 20);
  };

  // ── The sheet ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  const sheet = async (sid: string, me: Person, laneAsked?: string) => {
    const state = await d.store.state(sid);
    if (state.options.team) throw new CarryError(400, "Keep this going works in a coding session.");
    const events = await d.store.events(sid);
    const lane = await laneFor(state, events, me.id, laneAsked);
    const s = standing(state, events, lane);
    const mates = await d.crew.list();
    const own = rankMates(s.note.next || state.title, mates);
    const rooms = await roomsFor(mates);
    return {
      sid,
      lane,
      title: state.title || "This session",
      branch: s.branch,
      own: own.map((t) => ({ id: t.id, name: t.name, role: t.role, tool: t.tool, ...(t.look ? { look: t.look } : {}), line: ownOutcome(d.where(t)), now: d.where(t).connected })),
      rooms,
      carry: { open: s.open.length, decided: s.decided.length, branch: s.branch, files: s.files.length, question: s.question, turns: s.turns },
      note: s.note.next,
      ask: [...ASK_DEFAULT],
      handed: ((h) => (h ? { job: h.job, mateName: h.mateName } : null))(handedOn(state, lane)),
      // No crew yet: one tap makes a Finisher from this session's lane (POST /api/teammates).
      finisher: own.length ? null : finisherFrom({ ...(s.engine?.tool ? { tool: s.engine.tool } : {}), ...(s.engine?.model ? { model: s.engine.model } : {}), ...(s.engine?.copyOf || s.engine?.cwd ? { folder: s.engine.copyOf || s.engine.cwd } : {}), taken: mates.map((t) => t.name) }),
    };
  };

  /** The words the crew mate starts from, from what the person ticked. */
  const briefOf = (state: SessionState, events: SessionEvent[], lane: string, me: Person, carry: ReturnType<typeof cleanCarry>, note: string, ask: AskKey[], copied: boolean): { text: string; carried: string[] } => {
    const s = standing(state, events, lane);
    const said = events.filter((x) => (x.lane ?? MAIN_LANE) === lane && (x.body.type === "instruction" || (x.body.type === "agent.message" && x.body.text.trim())));
    const conversation = carry.conversation ? said.slice(-40).map((x) => `${x.actor.name}: ${"text" in x.body ? String(x.body.text).slice(0, 600) : ""}`).join("\n\n").slice(-14_000) : "";
    const text = handBrief({
      title: state.title || "this session",
      by: me.name,
      note,
      ...(carry.leftOff ? { leftOff: s.note.markdown.slice(0, 6000) } : {}),
      ...(carry.branch && (s.branch || s.files.length) ? { branch: { ...(s.branch ? { name: s.branch } : {}), files: s.files, copied } } : {}),
      ...(carry.question && s.question ? { question: s.question } : {}),
      ...(conversation ? { conversation } : {}),
      ask,
    });
    const carried = [carry.leftOff && s.open.length ? `${s.open.length} still open` : "", carry.branch && s.branch ? s.branch : "", carry.branch && s.files.length ? `${s.files.length} file${s.files.length === 1 ? "" : "s"}` : ""].filter(Boolean);
    return { text, carried };
  };

  /**
   * POST: handed to a crew mate. It comes into this session as a lane in a copy of the folder of its own (or the lane it already
   * has here), is given the work as the person's message, and the session says so once.
   */
  const hand = async (sid: string, me: Person, b: Record<string, unknown>) => {
    const state = await d.store.state(sid);
    if (state.options.team) throw new CarryError(400, "Keep this going works in a coding session.");
    steer(state, me, "Only people who can steer this session hand it on.");
    const events = await d.store.events(sid);
    const lane = await laneFor(state, events, me.id, str(b.lane, 40) || undefined);
    const live = handedOn(state, lane);
    if (live) throw new CarryError(409, `${live.mateName} is already on this. Take it back first, or send it a note.`);
    const t = await d.crew.get(str(b.mate, 40));
    if (!t) throw new CarryError(404, "Pick one of your crew mates.");
    const ask = cleanAsk(b.ask);
    const carry = cleanCarry(b.carry);
    const note = str(b.note, 2000);
    // Its lane here: the one it already has, else a new one in a copy of its own (crew-code.ts), what is uncommitted carried in.
    const had = (await d.visitsIn(sid)).find((v) => v.mate === t.id && state.lanes.some((l) => l.id === v.lane));
    if (had && runOf(state, had.lane).status === "running") throw new CarryError(409, `${t.name} is busy in this session. Wait for it to finish, or stop it first.`);
    const jobLane = had?.lane ?? (await d.bringInto(me, t, sid, carry.branch)).lane;
    const { text, carried } = briefOf(state, events, lane, me, carry, note, ask, !had);
    const from = await d.post(sid, me, text, jobLane);
    const job = randomBytes(5).toString("hex");
    await putLink({ sid, lane, job, jobLane, from, by: me, ask, mateName: t.name });
    await d.store.append(sid, { ...me, kind: "human" }, { type: "crew.handed", job, mate: t.id, mateName: t.name, lane, carried, ask, jobLane }, { lane });
    await sync(sid, jobLane).catch((e: Error) => d.log(`hand ${job}: ${e.message}`));
    return { job: { id: job, mate: { id: t.id, name: t.name }, lane: jobLane }, lane };
  };

  /** How a hand-off's work stands now, from its crew mate's lane since it was handed: said on the session's line when it moves. */
  const sync = async (sid: string, jobLane: string): Promise<void> => {
    const l = await linkOn(sid, jobLane);
    if (!l) return;
    const [state, events] = await Promise.all([d.store.state(sid), d.store.events(sid)]);
    const h = state.handed?.[l.job];
    if (!h || h.back || ENDS.includes(h.state)) return;
    const mine = events.filter((e) => e.seq > l.from && (e.lane ?? MAIN_LANE) === jobLane);
    const started = mine.some((e) => e.body.type === "run.started");
    const end = mine.findLast((e) => e.body.type === "run.ended");
    const run = runOf(state, jobLane).status;
    const now = laneState({
      running: run === "running",
      asks: !!state.approvals[jobLane] || !!state.openQuestions[jobLane] || run === "waiting_for_human",
      started,
      ...(end?.body.type === "run.ended" && !end.body.cut ? { ended: end.body.outcome } : {}),
      online: !!state.engines[jobLane]?.online,
    });
    const plan = planCount(latestPlan(mine, jobLane));
    let result: NonNullable<SessionState["handed"]>[string]["result"];
    if (now === "done") {
      const said = mine.findLast((e) => e.body.type === "agent.message" && e.body.text.trim());
      const text = said?.body.type === "agent.message" ? said.body.text.trim() : "";
      const files = state.diffs[jobLane]?.files ?? [];
      result = { said: text.slice(0, 1500), files: files.length, added: files.reduce((n, f) => n + (f.additions ?? 0), 0), removed: files.reduce((n, f) => n + (f.deletions ?? 0), 0), prs: prsIn(text) };
    }
    const key = JSON.stringify([now, plan?.done, plan?.of, !!result]);
    if (l.said === key) return;
    await putLink({ ...l, said: key });
    await d.store.append(sid, FRIDAY, { type: "crew.handed.moved", job: l.job, state: now, ...(plan ?? {}), ...(result ? { result } : {}) }, { lane: l.lane });
  };

  /** Events in every session: a hand-off's crew mate starting, planning, asking, finishing. */
  const hear = async (sid: string, ev: SessionEvent): Promise<void> => {
    const t = ev.body.type;
    if (!["run.started", "run.ended", "agent.message", "engine.approval", "agent.question", "engine.attached", "engine.detached", "instruction"].includes(t)) return;
    if (!(await d.redis.exists(k(`sid:${sid}`)))) return;
    await sync(sid, ev.lane ?? MAIN_LANE);
  };

  // ── The wheel ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  /** "Take it back" (its work stops, its branch stays) or Stop from the line: the lane's own again. */
  const back = async (sid: string, me: Person, jobId: string, how: "back" | "stopped") => {
    const l = await linkOf(jobId);
    if (!l || l.sid !== sid) throw new CarryError(404, "That hand-off isn't there any more.");
    const state = await d.store.state(sid);
    steer(state, me, "Only people who can steer this session take it back.");
    if (runOf(state, l.jobLane).status === "running") await d.stop(sid, me, l.jobLane);
    await d.store.append(sid, { ...me, kind: "human" }, { type: "crew.handed.back", job: jobId, how }, { lane: l.lane });
    return { ok: true };
  };

  /** "Send Kit a note": the words typed in the lane go to the crew mate instead, as the person's. */
  const note = async (sid: string, me: Person, jobId: string, text: string) => {
    const l = await linkOf(jobId);
    if (!l || l.sid !== sid) throw new CarryError(404, "That hand-off isn't there any more.");
    if (!text) throw new CarryError(400, "Write the note first.");
    steer(await d.store.state(sid), me, "Only people who can steer this session send it notes.");
    await d.post(sid, me, text, l.jobLane);
    return { ok: true };
  };

  /** Where the crew mate works on it, to open from the line: its lane in this session. */
  const open = async (sid: string, jobId: string) => {
    const l = await linkOf(jobId);
    if (!l || l.sid !== sid) throw new CarryError(404, "That hand-off isn't there any more.");
    return { sid, lane: l.jobLane, invite: d.invite(sid) };
  };

  // ── A crew room ───────────────────────────────────────────────────────────────────────────────────────────────────────
  /** POST with `room`: the work posted in a crew room as this person's message to its lead, and said once in the session. */
  const handRoom = async (sid: string, me: Person, b: Record<string, unknown>) => {
    const state = await d.store.state(sid);
    if (state.options.team) throw new CarryError(400, "Keep this going works in a coding session.");
    steer(state, me, "Only people who can steer this session hand it on.");
    const r = (await roomsFor(await d.crew.list())).find((x) => x.id === str(b.room, 40));
    if (!r) throw new CarryError(404, "Pick one of your crew rooms.");
    const events = await d.store.events(sid);
    const lane = await laneFor(state, events, me.id, str(b.lane, 40) || undefined);
    const { text, carried } = briefOf(state, events, lane, me, cleanCarry(b.carry), str(b.note, 2000), [], false);
    let seq: number;
    try {
      seq = await d.post(r.sid, me, text, r.lane);
    } catch (err) {
      throw new CarryError(400, (err as Error).message);
    }
    await d.store.append(sid, { ...me, kind: "human" }, { type: "crew.handed.room", room: r.id, roomName: r.name, roomSid: r.sid, lane, to: r.to, carried, roomLane: r.lane, seq }, { lane });
    return { room: { id: r.id, name: r.name, to: r.to }, lane };
  };

  /**
   * How work handed to a room stands, for the session's line: who in the room is working now, and whether the turn the hand-off
   * started has finished, stopped, waits on someone, or hasn't started.
   */
  const roomStatus = async (sid: string, id: string) => {
    const handed = (await d.store.events(sid)).findLast((e) => e.body.type === "crew.handed.room" && e.body.room === id);
    const h = handed?.body;
    if (!handed || h?.type !== "crew.handed.room") throw new CarryError(404, "Nothing was handed to that room here.");
    const mates = await d.crew.list();
    const room = (await d.crew.rooms()).find((x) => x.id === id);
    if (!room) throw new CarryError(404, "That room isn't in your crew any more.");
    const raw = room.lanes;
    const nameOf = (lane: string) => mates.find((m) => raw[m.id] === lane)?.name ?? "";
    const rs = await d.store.state(room.sid);
    const lane = h.roomLane ?? Object.values(raw)[0] ?? MAIN_LANE;
    const working = Object.values(raw).filter((l) => runOf(rs, l).status === "running").map(nameOf).filter(Boolean);
    const roomEvents = await d.store.events(room.sid);
    const seq = h.seq ?? roomEvents.find((e) => e.body.type === "instruction" && e.actor.id === handed.actor.id && e.ts >= handed.ts - 10_000 && e.ts <= handed.ts + 10_000)?.seq;
    const evs = seq === undefined ? [] : roomEvents.filter((e) => e.seq > seq && (e.lane ?? MAIN_LANE) === lane);
    const ended = evs.findLast((e) => e.body.type === "run.ended");
    const said = evs.findLast((e) => e.body.type === "agent.message" && e.body.text.trim());
    const head = said?.body.type === "agent.message" ? said.body.text.trim().split(/\n+/)[0]!.replace(/[*_`#>]/g, "").slice(0, 400) : "";
    const who = first(nameOf(lane) || h.to);
    const run = runOf(rs, lane).status;
    const asks = !!rs.approvals[lane] || !!rs.openQuestions[lane];
    const state =
      run === "running" ? (asks ? "waiting" : "working")
      : ended?.body.type === "run.ended" ? (ended.body.outcome === "error" ? "stopped" : ended.body.outcome === "waiting" ? "waiting" : "done")
      : seq === undefined ? "unknown"
      : "queued";
    const line =
      state === "working" ? `${who} is working on it`
      : state === "waiting" ? `${who} is waiting on an answer in the room`
      : state === "done" ? `${who} is done`
      : state === "stopped" ? `${who} stopped on an error`
      : state === "queued" ? `${who} hasn't started yet`
      : "Open the room to see how it stands";
    // The room's crew, each with its face and whether it works now, the one it went to first (for the line's mascots).
    const lead = Object.entries(raw).find(([, l]) => l === lane)?.[0];
    const crewHere = Object.entries(raw)
      .map(([mid, l]) => ((t) => (t ? { name: t.name, ...(t.look ? { look: t.look } : {}), working: runOf(rs, l).status === "running", lead: mid === lead } : null))(mates.find((x) => x.id === mid)))
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => Number(b.lead) - Number(a.lead));
    return { state, line, said: state === "done" || state === "stopped" ? head : "", working: working.map(first), at: ended?.ts ?? null, crew: crewHere };
  };

  const roomOpen = async (id: string) => {
    const r = (await d.crew.rooms()).find((x) => x.id === id);
    if (!r) throw new CarryError(404, "That room isn't in your crew any more.");
    return { sid: r.sid, name: r.name, invite: d.invite(r.sid) };
  };

  // ── Bringing work in, with a look first ──────────────────────────────────────────────────────────────────────────────────
  // Arun, 2026-11-13: "we need to make this smart and ensure other conflicting stuff isnt being brought over, like we need to be
  // smart about what was either handed off, or worked in the crew rooms or crewmates before bringing it in". Each finished piece
  // of a crew mate's or a room's work is weighed against this session: handed from here, the same repo, or another one (left out
  // unless asked); the files changed here too are named; and only the piece and the files picked come in.

  /** A folder's repository by name: the copy's original when it is a copy. */
  const repoName = (e?: { cwd?: string; root?: string; copyOf?: string } | null) => ((p) => (p ? p.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || undefined : undefined))(e?.copyOf || e?.root || e?.cwd);

  type BringPiece = { key: string; from: string; what: string; at: number; branch?: string; folder?: string; files: string[]; repo?: string; relation: "handed" | "same" | "unknown" | "other"; skip?: string; conflicts: string[]; job?: string; room?: string; /** The crew mate whose work it is, for its mascot. */ who?: { name: string; look?: string } };

  const piecesFor = async (sid: string, me: Person, src: string): Promise<{ pieces: BringPiece[]; lane: string; here: { repo?: string; title: string } }> => {
    const state = await d.store.state(sid);
    steer(state, me, "Only people who can steer this session bring work into it.");
    const events = await d.store.events(sid);
    const lane = await laneFor(state, events, me.id);
    const hereRepo = repoName(state.engines[lane]);
    const hereFiles = new Set((state.diffs[lane]?.files ?? []).map((f) => f.path));
    const mates = await d.crew.list();
    const whoOf = (t?: Teammate) => (t ? { who: { name: t.name, ...(t.look ? { look: t.look } : {}) } } : {});
    type Place = { sid: string; lane: string; from: string; handedAt?: number; job?: string; room?: string; who?: { name: string; look?: string } };
    const places: Place[] = [];
    // A room's lanes, said by the room's name as its session has it, each with its crew mate and whether it was handed from here.
    const roomPlaces = async (r: Room) => {
      const name = (await d.store.state(r.sid).catch(() => null))?.title || r.name;
      const handed = events.findLast((e) => e.body.type === "crew.handed.room" && e.body.room === r.id);
      for (const [mid, l] of Object.entries(r.lanes)) ((t) => places.push({ sid: r.sid, lane: l, from: `${t?.name ?? "A crew mate"} in ${name}`, ...whoOf(t), ...(handed ? { handedAt: handed.ts, room: r.id } : {}) }))(mates.find((x) => x.id === mid));
    };
    // What was handed from here: its crew mate's lane in this session, the most related there is.
    const handedPlaces = (t?: Teammate) => {
      for (const e of events) {
        if (e.body.type !== "crew.handed" || !e.body.jobLane || (t && e.body.mate !== t.id)) continue;
        const m = t ?? mates.find((x) => x.id === (e.body as { mate: string }).mate);
        if (m) places.push({ sid, lane: e.body.jobLane, from: `${m.name}, handed from here`, handedAt: e.ts, job: e.body.job, ...whoOf(m) });
      }
    };
    // Everything there is to bring in, from every crew mate and every room, and what was handed from here (Friday Teams ffdd8820;
    // Arun, 2026-11-13: "make it easy to bring in new work from the crew rooms and crewmates"): one look instead of one per source.
    if (src === "all") {
      const home = await d.crew.team();
      if (home) for (const t of mates) places.push({ sid: home, lane: t.lane, from: `${t.name} in your Crew`, ...whoOf(t) });
      for (const r of await d.crew.rooms()) await roomPlaces(r);
      handedPlaces();
    } else if (src.startsWith("mate:")) {
      const t = mates.find((x) => x.id === src.slice(5));
      if (!t) throw new CarryError(404, "Pick one of your crew mates.");
      const home = await d.crew.team();
      if (home) places.push({ sid: home, lane: t.lane, from: `${t.name} in your Crew`, ...whoOf(t) });
      for (const r of await d.crew.rooms()) if (r.lanes[t.id]) places.push({ sid: r.sid, lane: r.lanes[t.id]!, from: `${t.name} in ${r.name}`, ...whoOf(t) });
      handedPlaces(t);
    } else if (src.startsWith("room:")) {
      const r = (await d.crew.rooms()).find((x) => x.id === src.slice(5));
      if (!r) throw new CarryError(404, "Pick one of your crew rooms.");
      await roomPlaces(r);
    } else throw new CarryError(400, "Pick a crew mate or a crew room.");
    // What was brought in here already, by when it finished: the same piece doesn't come up again until there is newer work.
    const brought = new Map<string, number>();
    for (const e of events) if (e.body.type === "crew.brought") for (const x of e.body.pieces) brought.set(x.key, Math.max(brought.get(x.key) ?? 0, x.at));
    // A room's lanes share one session: read it once.
    const read = new Map<string, Promise<[SessionState | null, SessionEvent[]]>>();
    const readOf = (s: string) => read.get(s) ?? (read.set(s, Promise.all([d.store.state(s).catch(() => null), d.store.events(s).catch(() => [] as SessionEvent[])])), read.get(s)!);
    const pieces: BringPiece[] = [];
    for (const p of places) {
      const [st, all] = await readOf(p.sid);
      if (!st) continue;
      const evs = all.filter((e) => (e.lane ?? MAIN_LANE) === p.lane);
      const end = evs.findLast((e) => e.body.type === "run.ended" && e.body.outcome === "done");
      if (!end || (brought.get(`${p.sid}~${p.lane}`) ?? 0) >= end.ts) continue;
      const said = evs.findLast((e) => e.seq <= end.seq && e.body.type === "agent.message" && e.body.text.trim());
      const files = (st.diffs[p.lane]?.files ?? []).map((f) => f.path);
      const text = said?.body.type === "agent.message" ? said.body.text : "";
      if (!files.length && !text) continue;
      const e = st.engines[p.lane];
      const repo = repoName(e);
      const relation: BringPiece["relation"] = p.handedAt && end.ts >= p.handedAt ? "handed" : hereRepo && repo ? (repo.toLowerCase() === hereRepo.toLowerCase() ? "same" : "other") : "unknown";
      pieces.push({
        key: `${p.sid}~${p.lane}`,
        from: p.from,
        what: (text.split("\n").find((l) => l.replace(/[*_`#>-]/g, "").trim()) ?? "").replace(/[*_`#>]/g, "").trim().slice(0, 160),
        at: end.ts,
        ...(e?.branch ? { branch: e.branch } : {}),
        ...(e?.cwd ? { folder: e.cwd } : {}),
        files,
        ...(repo ? { repo } : {}),
        relation,
        ...(relation === "other" ? { skip: `It's in ${repo}, and this session works in ${hereRepo}.` } : {}),
        conflicts: files.filter((f) => hereFiles.has(f)),
        ...(p.job ? { job: p.job } : {}),
        ...(p.room ? { room: p.room } : {}),
        ...(p.who ? { who: p.who } : {}),
      });
    }
    const rank = { handed: 0, same: 1, unknown: 2, other: 3 } as const;
    // One piece per place (a lane listed twice keeps the more related).
    const seen = new Set<string>();
    const out = pieces.sort((a, b) => rank[a.relation] - rank[b.relation] || b.at - a.at).filter((x) => !seen.has(x.key) && !!seen.add(x.key)).slice(0, src === "all" ? 8 : 6);
    return { pieces: out, lane, here: { ...(hereRepo ? { repo: hereRepo } : {}), title: state.title || "this session" } };
  };

  /** The picked pieces, and the files picked of one, into this session for its agent to merge and carry on. */
  const bringPick = async (sid: string, me: Person, src: string, b: Record<string, unknown>) => {
    const { pieces, lane, here } = await piecesFor(sid, me, src);
    // One piece or several at once (Arun, 2026-11-13: "be able to check multiple too"): each its own part of one message.
    const keys = Array.isArray(b.keys) ? (b.keys as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 8) : [str(b.key, 200)];
    const picked = keys.map((key) => pieces.find((x) => x.key === key)).filter((x): x is BringPiece => !!x);
    if (!picked.length) throw new CarryError(404, "That work isn't there any more. Look again.");
    const skipped = picked.find((p) => p.skip);
    if (skipped && b.anyway !== true) throw new CarryError(409, `${skipped.skip} Bring it anyway only if you mean to.`);
    // Files picked apply to a single piece; several come in whole.
    const filesOf = (p: BringPiece) => (picked.length === 1 && Array.isArray(b.files) ? (b.files as unknown[]).filter((f): f is string => typeof f === "string" && p.files.includes(f)) : p.files);
    if (picked.length === 1 && picked[0]!.files.length && !filesOf(picked[0]!).length) throw new CarryError(400, "Pick at least one file to bring in.");
    const parts: string[] = [];
    let files = 0;
    for (const p of picked) {
      const [psid, plane] = p.key.split("~") as [string, string];
      const said = (await d.store.events(psid)).findLast((e) => (e.lane ?? MAIN_LANE) === plane && e.body.type === "agent.message" && e.body.text.trim());
      const take = filesOf(p);
      files += take.length;
      parts.push(bringBrief({ who: p.from.replace(/, handed from here$/, ""), said: said?.body.type === "agent.message" ? said.body.text : "", ...(p.branch ? { branch: p.branch } : {}), ...(p.folder ? { folder: p.folder } : {}), files: take.length, by: me.name, ...(take.length ? { take } : {}), conflicts: p.conflicts.filter((f) => take.includes(f)), about: here.title }));
    }
    const note = str(b.note, 2000);
    const text = parts.length > 1 ? `[Friday] ${me.name} brought in ${parts.length} pieces of finished work. Take each in turn, then build and test once at the end.\n\n${parts.map((t, i) => `--- ${i + 1} of ${parts.length} ---\n${t}`).join("\n\n")}` : parts[0]!;
    await d.post(sid, me, note ? `${note}\n\n${text}` : text, lane);
    await d.store.append(sid, { ...me, kind: "human" }, { type: "crew.brought", pieces: picked.map((p) => ({ key: p.key, at: p.at })) }, { lane });
    for (const p of picked) {
      if (p.job) await d.store.append(sid, { ...me, kind: "human" }, { type: "crew.handed.back", job: p.job, how: "brought" }, { lane });
      if (p.room) await d.store.append(sid, { ...me, kind: "human" }, { type: "crew.handed.room.brought", room: p.room }, { lane });
    }
    return { ok: true, files, pieces: picked.length };
  };

  /**
   * GET  /api/sessions/:sid/keep-going?lane=                     the sheet
   * POST /api/sessions/:sid/keep-going {mate | room, lane, carry, note, ask}   handed on
   * GET  /api/sessions/:sid/keep-going/:job                      where its crew mate works on it, to open
   * POST /api/sessions/:sid/keep-going/:job/back {how}            taken back, or stopped
   * POST /api/sessions/:sid/keep-going/:job/note {text}           a note to its crew mate instead
   * GET  ?roomStatus= · ?room= · ?bringFrom=; POST ?bringFrom=     a room's line, a way into it, and Bring it in
   */
  const route = async (method: string, path: string, query: URLSearchParams, me: Person, body: () => Promise<Record<string, unknown>>): Promise<{ status: number; body: unknown } | null> => {
    const sess = path.match(/^\/api\/sessions\/([\w-]+)\/keep-going(?:\/([\w-]{4,40})(?:\/(back|note))?)?$/);
    if (!sess) return null;
    try {
      const sid = sess[1]!;
      const state = await d.store.state(sid).catch(() => null);
      const m = state?.members[me.id];
      if (!state || !m || m.removed) return { status: 404, body: { error: "That session isn't there any more." } };
      if (sess[2] && !sess[3]) return method === "GET" ? { status: 200, body: await open(sid, sess[2]) } : { status: 405, body: { error: "Not allowed" } };
      if (sess[2]) {
        if (method !== "POST") return { status: 405, body: { error: "Not allowed" } };
        const b = await body();
        if (sess[3] === "note") return { status: 200, body: await note(sid, me, sess[2], str(b.text, 8000)) };
        return { status: 200, body: await back(sid, me, sess[2], b.how === "stopped" ? "stopped" : "back") };
      }
      if (method === "GET" && query.get("bringFrom")) return { status: 200, body: await piecesFor(sid, me, query.get("bringFrom")!) };
      if (method === "GET" && query.get("roomStatus")) return { status: 200, body: await roomStatus(sid, query.get("roomStatus")!) };
      if (method === "GET" && query.get("room")) return { status: 200, body: await roomOpen(query.get("room")!) };
      if (method === "GET") return { status: 200, body: await sheet(sid, me, query.get("lane") ?? undefined) };
      if (method === "POST" && query.get("bringFrom")) return { status: 200, body: await bringPick(sid, me, query.get("bringFrom")!, await body()) };
      if (method === "POST") return { status: 200, body: await ((b) => (typeof b.room === "string" && b.room ? handRoom(sid, me, b) : hand(sid, me, b)))(await body()) };
      return { status: 405, body: { error: "Not allowed" } };
    } catch (e) {
      const s = (e as { status?: number }).status;
      return { status: typeof s === "number" && s >= 400 ? s : 400, body: { error: (e as Error).message } };
    }
  };

  return { sheet, hand, handRoom, roomStatus, back, note, open, piecesFor, bringPick, hear, sync, route, linkOf };
}

export type CrewCarry = ReturnType<typeof crewCarry>;
