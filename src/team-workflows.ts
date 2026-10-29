import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import { dueSlot, validateSchedule, type AgentSchedule } from "./agents.js";
import { laneName } from "./session/core.js";
import { boardBusy, type BoardTask, type SessionState } from "./session/projection.js";
import type { SessionStore } from "./session/store.js";
import {
  cleanWorkflow,
  columnsOf,
  describeTrigger,
  LEAD,
  MAX_CHAIN,
  TEAM_ROOM,
  workflowChecks,
  workflowTasks,
  type Workflow,
  type WorkflowRun,
  type WorkflowRunStep,
  type WorkflowView,
} from "./team-workflow-model.js";
import type { TeammateStore } from "./teammates.js";
import { MAIN_LANE, type ActorRef, type SessionEvent, type TeamBrief } from "./types.js";

/**
 * Team workflows, run (team-workflow-model.ts has the shapes; Arun, 2026-10-28: "make the automation for the teams platform
 * different it can be like a workflow automation design like we did with the agent tab page a while ago").
 *
 * A run posts one board in its room, as Friday, from the room's lead (agent-mesh.ts post_tasks semantics): a task per step, for
 * that step's teammate (`next`, so it reaches them even busy, the lead included), waiting on the column before it. Nothing here
 * hands work out: the board claims, checks, reviews and wakes the lead with the reports, as it does for any board. This only
 * watches the board's events, keeps the run's record, and when the board is through runs the outcomes: a brief in the room, a
 * word to the person, the lead asked to open one pull request (told with the reports, mesh.teamDone), the result handed to
 * another workflow.
 *
 * Everything is in the local store beside the teammates: the workflows, each one's last fifty runs, the run each room's board
 * belongs to, the runs waiting for a board, and the day's counts.
 *
 */

export interface WorkflowDeps {
  redis: Redis;
  prefix: string;
  teammates: TeammateStore;
  store: Pick<SessionStore, "state" | "events" | "append">;
  /** The Team room's session, made if there is none yet. */
  teamSid: () => Promise<string>;
  /** Hands out what is ready on a session's board (AgentMesh.dispatch). */
  dispatch: (sid: string) => Promise<unknown>;
  log?: (what: string, e: unknown) => void;
}

/** How long a run waits for its room's board to be free before it is skipped. */
export const WAIT_FOR_BOARD_MS = 12 * 60 * 60_000;
const FRIDAY: ActorRef = { id: "friday", name: "Friday", kind: "system" };
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** When a schedule next fires after `now`, or null within eight days: every minute that could be it, checked (dueSlot). */
export function nextRunAt(s: AgentSchedule, now = Date.now()): number | null {
  // Every zone is a whole number of quarter hours off UTC, so the minute it fires is the same one past a quarter in both.
  const want = s.every === "hourly" ? 0 : Number(s.at.slice(3, 5)) % 15;
  let t = Math.floor(now / 60_000) * 60_000 + 60_000;
  while (new Date(t).getUTCMinutes() % 15 !== want) t += 60_000;
  for (let end = now + 8 * 86_400_000; t <= end; t += 15 * 60_000) if (dueSlot(s, new Date(t))) return t;
  return null;
}

/** One room as a run needs it: its session, its name, each member's lane there, and its lead. */
interface Place {
  room: string;
  sid: string;
  name: string;
  lanes: Record<string, string>;
}

/** A finished run the person asked to be told about, for the page to say (GET /api/teammates `ran`). */
export interface WorkflowEnded {
  id: string;
  name: string;
  run: string;
  status: WorkflowRun["status"];
  ended: number;
  sid?: string;
  roomName: string;
  note?: string;
}

export class TeamWorkflows {
  constructor(private d: WorkflowDeps) {}

  private k = (s: string) => `${this.d.prefix}teammates:${s}`;
  private key = () => this.k("workflows");
  private runsKey = (id: string) => this.k(`workflow-runs:${id}`);
  /** The run a room's board is now, while it goes: {id, run, seq}. */
  private activeKey = (sid: string) => this.k(`workflow-active:${sid}`);
  private activesKey = () => this.k("workflow-actives");
  /** The run a board was, by its seq, kept a month: for the lead's hand-off when it is through (landing). */
  private boardKey = (sid: string, seq: number) => this.k(`workflow-board:${sid}:${seq}`);
  private waitingKey = () => this.k("workflow-waiting");
  private endedKey = () => this.k("workflow-ended");

  // ── the store ────────────────────────────────────────────────────────

  async list(): Promise<Workflow[]> {
    return (await this.d.redis.hvals(this.key()))
      .flatMap((r) => {
        try {
          return [JSON.parse(r) as Workflow];
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.created - b.created);
  }

  async get(id: string): Promise<Workflow | null> {
    const raw = await this.d.redis.hget(this.key(), id);
    return raw ? (JSON.parse(raw) as Workflow) : null;
  }

  async put(w: Workflow): Promise<void> {
    await this.d.redis.hset(this.key(), w.id, JSON.stringify(w));
  }

  /** A workflow as the page sent it, made, or changed from `prev`. */
  async save(input: Record<string, unknown>, prev: Workflow | null): Promise<Workflow> {
    const c = cleanWorkflow(input, prev, { secret: () => randomBytes(18).toString("base64url"), schedule: (s) => validateSchedule(s as Parameters<typeof validateSchedule>[0]) });
    const w: Workflow = { ...c, id: prev?.id ?? randomBytes(6).toString("base64url"), created: prev?.created ?? Date.now(), updated: Date.now() };
    await this.put(w);
    return w;
  }

  async remove(id: string): Promise<void> {
    await this.d.redis.multi().hdel(this.key(), id).del(this.runsKey(id)).exec();
    for (const e of await this.d.redis.zrangebyscore(this.waitingKey(), "-inf", "+inf")) if (e.startsWith(`${id} `)) await this.d.redis.zrem(this.waitingKey(), e);
  }

  async runs(id: string, n = 30): Promise<WorkflowRun[]> {
    return (await this.d.redis.lrange(this.runsKey(id), 0, n - 1)).flatMap((r) => {
      try {
        return [JSON.parse(r) as WorkflowRun];
      } catch {
        return [];
      }
    });
  }

  private async addRun(id: string, run: WorkflowRun): Promise<void> {
    await this.d.redis.multi().lpush(this.runsKey(id), JSON.stringify(run)).ltrim(this.runsKey(id), 0, 49).exec();
  }

  /** A run changed where it stands, by its id: under the workflow's lock, so two changes at once don't undo each other. */
  private updateRun(id: string, runId: string, change: Partial<WorkflowRun>): Promise<WorkflowRun | null> {
    return this.d.teammates.locked(`workflow-runs:${id}`, async () => {
      const list = await this.d.redis.lrange(this.runsKey(id), 0, 49);
      for (let i = 0; i < list.length; i++) {
        const r = JSON.parse(list[i]!) as WorkflowRun;
        if (r.id !== runId) continue;
        const next = { ...r, ...change };
        await this.d.redis.lset(this.runsKey(id), i, JSON.stringify(next));
        return next;
      }
      return null;
    });
  }

  /** Counted against its runs a day (UTC). Over the limit: false, and not counted. */
  private async countRun(w: Workflow, now = new Date()): Promise<boolean> {
    const key = this.k(`workflow-count:${w.id}:${now.toISOString().slice(0, 10)}`);
    const n = await this.d.redis.incr(key);
    if (n === 1) await this.d.redis.expire(key, 2 * 86_400);
    if (n > w.limits.perDay) {
      await this.d.redis.decr(key);
      return false;
    }
    return true;
  }

  async runsToday(id: string, now = new Date()): Promise<number> {
    return Number(await this.d.redis.get(this.k(`workflow-count:${id}:${now.toISOString().slice(0, 10)}`))) || 0;
  }

  /** The finished runs the person asked to be told about, newest first: the page says each once. */
  async ended(): Promise<WorkflowEnded[]> {
    return (await this.d.redis.lrange(this.endedKey(), 0, 9)).flatMap((r) => {
      try {
        return [JSON.parse(r) as WorkflowEnded];
      } catch {
        return [];
      }
    });
  }

  // ── where it runs ────────────────────────────────────────────────────

  private async place(room: string): Promise<Place | null> {
    if (room === TEAM_ROOM) {
      const sid = await this.d.teamSid();
      return { room, sid, name: "the Crew room", lanes: Object.fromEntries((await this.d.teammates.list()).map((t) => [t.id, t.lane])) };
    }
    const r = await this.d.teammates.room(room);
    return r ? { room, sid: r.sid, name: r.name, lanes: r.lanes } : null;
  }

  /** The names a trigger is said with: teammates and rooms by id. */
  async names(): Promise<{ mate: (id: string) => string; room: (id: string) => string }> {
    const [mates, rooms] = await Promise.all([this.d.teammates.list(), this.d.teammates.rooms()]);
    return { mate: (id) => (id === LEAD ? "the lead" : (mates.find((m) => m.id === id)?.name ?? "")), room: (id) => (id === TEAM_ROOM ? "the Crew room" : (rooms.find((r) => r.id === id)?.name ?? "")) };
  }

  /** A workflow for the page: its webhook's address rather than its key, what starts it in words, its last runs and next time. */
  async view(w: Workflow, hookBase: string): Promise<WorkflowView> {
    const names = await this.names();
    return {
      ...w,
      trigger: w.trigger.kind === "webhook" ? { kind: "webhook", secret: "", url: `${hookBase}/api/hooks/workflow/${w.id}?key=${w.trigger.secret}` } : w.trigger,
      says: { trigger: describeTrigger(w.trigger, names) },
      runs: await this.runs(w.id, 6),
      today: await this.runsToday(w.id),
      next: w.on && w.trigger.kind === "schedule" ? nextRunAt(w.trigger.schedule) : null,
    };
  }

  // ── a run ────────────────────────────────────────────────────────────

  /**
   * A run of `w`, started by `trigger` (in words) with `input` (what started it): counted against its day, then posted as its
   * room's board, or waiting for that board to be free, or skipped. Returns the run as it stands.
   */
  async start(w: Workflow, trigger: string, input = "", depth = 0): Promise<WorkflowRun> {
    let run: WorkflowRun = { id: randomBytes(5).toString("hex"), at: Date.now(), trigger, status: "running", room: w.room, roomName: "", steps: [], ...(input.trim() ? { input: clip(input.trim(), 8000) } : {}), ...(depth ? { depth } : {}) };
    if (!(await this.countRun(w))) {
      run = { ...run, status: "skipped", note: `It has already run ${w.limits.perDay} time${w.limits.perDay === 1 ? "" : "s"} today, its limit.`, ended: Date.now() };
      await this.addRun(w.id, run);
      return run;
    }
    await this.addRun(w.id, run);
    return this.post(w, run);
  }

  /** The run's board posted in its room, once that room's board is free; one post at a time per room. */
  private async post(w: Workflow, run: WorkflowRun): Promise<WorkflowRun> {
    const set = async (change: Partial<WorkflowRun>) => (run = (await this.updateRun(w.id, run.id, change)) ?? { ...run, ...change });
    try {
      const place = await this.place(w.room);
      if (!place) throw new Error("Its room isn't there any more. Pick where it runs.");
      return await this.d.teammates.locked(`workflow-post:${place.sid}`, async () => {
        const [mates, rooms, all] = await Promise.all([this.d.teammates.list(), this.d.teammates.rooms(), this.list()]);
        const fix = workflowChecks(w, { mates, rooms: rooms.map((r) => ({ id: r.id, name: r.name, members: Object.keys(r.lanes) })), workflows: all }).find((c) => c.level === "fix");
        if (fix) throw new Error(`${fix.text}.`);
        const state = await this.d.store.state(place.sid);
        const active = await this.active(place.sid);
        if ((state.board && boardBusy(state)) || active) {
          const why = active?.id === w.id ? `Its last run is still going in ${place.name}.` : `${cap(place.name)}'s board is still being worked on.`;
          if (w.limits.skipIfRunning) return await set({ status: "skipped", roomName: place.name, note: why, ended: Date.now() });
          await this.d.redis.zadd(this.waitingKey(), run.at, `${w.id} ${run.id}`);
          return await set({ status: "waiting", roomName: place.name, note: `${why} It starts when that's done.` });
        }
        const members = Object.values(place.lanes).filter((l) => state.lanes.some((x) => x.id === l));
        const lead = state.lead && members.includes(state.lead) ? state.lead : (members[0] ?? "");
        if (!lead) throw new Error(`Nobody is in ${place.name} to run it.`);
        const laneOfMate = (mate: string) => (mate === LEAD ? lead : (place.lanes[mate] ?? ""));
        const missing = w.steps.find((s) => !members.includes(laneOfMate(s.mate)));
        if (missing) throw new Error(`One of its teammates isn't in ${place.name}.`);
        const tasks = workflowTasks(w, (mate) => laneName(state, laneOfMate(mate)), run.input ?? "");
        const fromName = laneName(state, lead);
        // As Friday, from the lead: the lead hears how it went when it is through, and its report is the run's last word.
        const posted = await this.d.store.append(place.sid, FRIDAY, { type: "board.posted", fromLane: lead, fromName, tasks }, { lane: lead });
        if (!posted.ok) throw new Error(`Couldn't post its board in ${place.name}.`);
        const ref = JSON.stringify({ id: w.id, run: run.id, seq: posted.seq });
        await this.d.redis.multi().set(this.activeKey(place.sid), ref).sadd(this.activesKey(), place.sid).set(this.boardKey(place.sid, posted.seq), ref, "EX", 30 * 86_400).exec();
        const order = columnsOf(w.steps).flat();
        const steps: WorkflowRunStep[] = tasks.map((t, i) => ({ step: order[i]!.id, task: t.id, title: t.title, name: t.next, lane: laneOfMate(order[i]!.mate), status: "open" }));
        await set({ status: "running", sid: place.sid, seq: posted.seq, roomName: place.name, steps, note: "" });
        await this.d.dispatch(place.sid);
        return run;
      });
    } catch (e) {
      return await set({ status: "failed", note: clip((e as Error).message, 300), ended: Date.now() });
    }
  }

  private async active(sid: string): Promise<{ id: string; run: string; seq: number } | null> {
    const raw = await this.d.redis.get(this.activeKey(sid));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as { id: string; run: string; seq: number };
    } catch {
      return null;
    }
  }

  /** The run on a room's board brought up to date: its steps as the board has them, and its end once the board is through. */
  sync(sid: string): Promise<void> {
    return this.d.teammates.locked(`workflow:${sid}`, async () => {
      const a = await this.active(sid);
      if (!a) return void (await this.d.redis.srem(this.activesKey(), sid));
      const [w, run] = await Promise.all([this.get(a.id), this.runs(a.id).then((r) => r.find((x) => x.id === a.run))]);
      const state = await this.d.store.state(sid);
      if (!run || run.status !== "running") return void (await this.clearActive(sid));
      if (!state.board || state.board.seq !== a.seq) return void (await this.finish(a.id, w, run, sid, state, [], "Its board was replaced by another before it was through."));
      const tasks = state.board.tasks;
      const steps = run.steps.map((s) => ((t) => (t ? { ...s, status: t.status, name: t.name ?? s.name, ...(t.report ? { report: clip(t.report, 4000) } : {}) } : s))(tasks.find((x) => x.id === s.task)));
      if (!boardBusy(state)) return void (await this.finish(a.id, w, run, sid, state, tasks));
      if (JSON.stringify(steps) !== JSON.stringify(run.steps)) await this.updateRun(a.id, run.id, { steps });
    });
  }

  private async clearActive(sid: string): Promise<void> {
    await this.d.redis.multi().del(this.activeKey(sid)).srem(this.activesKey(), sid).exec();
  }

  /** The board is through (or gone): the run's end, and its outcomes, once. */
  private async finish(id: string, w: Workflow | null, run: WorkflowRun, sid: string, state: SessionState, tasks: BoardTask[], gone?: string): Promise<void> {
    await this.clearActive(sid);
    if (!(await this.d.redis.set(this.k(`workflow-finished:${run.id}`), "1", "EX", 7 * 86_400, "NX"))) return;
    const steps = run.steps.map((s) => ((t) => (t ? { ...s, status: t.status, name: t.name ?? s.name, ...(t.report ? { report: clip(t.report, 4000) } : {}) } : s))(tasks.find((x) => x.id === s.task)));
    const stuck = steps.filter((s) => s.status === "blocked");
    // What it came to: the last column's reports (the steps nothing waited on), what the brief leads with and what is handed on.
    const waitedOn = new Set(tasks.flatMap((t) => t.after));
    const last = steps.filter((s) => !waitedOn.has(s.task) && s.status === "done" && s.report);
    const result = last.map((s) => `## ${s.title} (${s.name})\n${s.report}`).join("\n\n");
    const status = gone || stuck.length || !steps.some((s) => s.status === "done") ? "failed" : "done";
    const note = gone ?? (stuck.length ? `Step ${stuck.map((s) => s.task.slice(1)).join(", ")} got stuck: ${clip(stuck[0]!.report ?? "no report", 240)}` : status === "failed" ? "Every step was dropped." : "");
    const ended = Date.now();
    const done = (await this.updateRun(id, run.id, { status, steps, ended, note, ...(result ? { result: clip(result, 8000) } : {}) })) ?? run;
    if (!w) return;
    if (w.outcomes.brief && !gone) await this.brief(w, done, sid, state).catch((e) => this.d.log?.("[workflows] brief", e));
    if (w.outcomes.notify) {
      const e: WorkflowEnded = { id: w.id, name: w.name, run: run.id, status, ended, sid, roomName: run.roomName, ...(note ? { note } : {}) };
      await this.d.redis.multi().lpush(this.endedKey(), JSON.stringify(e)).ltrim(this.endedKey(), 0, 19).exec();
    }
    // Handed on: another workflow started with this one's result, so long as the chain stays short.
    if (status === "done" && w.outcomes.then && w.outcomes.then !== w.id) {
      const next = await this.get(w.outcomes.then);
      const depth = (run.depth ?? 0) + 1;
      if (!next) await this.updateRun(w.id, run.id, { note: "The workflow it hands on to is gone." });
      else if (!next.on) await this.updateRun(w.id, run.id, { note: `${next.name} is off, so it wasn't handed the result.` });
      else if (depth > MAX_CHAIN) await this.updateRun(w.id, run.id, { note: `Not handed to ${next.name}: ${MAX_CHAIN} workflows in a row is the most.` });
      else void this.start(next, `after “${w.name}”`, result || `“${w.name}” finished.`, depth).catch((e) => this.d.log?.("[workflows] hand-on", e));
    }
  }

  /** The run's brief in its room: each step done or stuck, by who did it, and what it came to (team.brief). */
  private async brief(w: Workflow, run: WorkflowRun, sid: string, state: SessionState): Promise<void> {
    const events = await this.d.store.events(sid);
    const seqOf = (task: string) => events.findLast((e) => e.seq > (run.seq ?? 0) && (e.body.type === "board.finished" || e.body.type === "board.reviewed") && e.body.id === task)?.seq;
    const b: TeamBrief = {
      since: run.at,
      until: run.ended ?? Date.now(),
      done: run.steps.filter((s) => s.status === "done").map((s) => ({ lane: s.lane, name: s.name || laneName(state, s.lane), title: s.title, ...(seqOf(s.task) ? { seq: seqOf(s.task)! } : {}) })),
      failed: run.steps.filter((s) => s.status === "blocked" || s.status === "cancelled").map((s) => ({ lane: s.lane, name: s.name || laneName(state, s.lane), title: s.title, why: s.status === "cancelled" ? "Dropped." : clip(s.report ?? "Stuck.", 300), ...(seqOf(s.task) ? { seq: seqOf(s.task)! } : {}) })),
      waiting: [],
      assumptions: [],
      usage: [],
      workflow: { id: w.id, name: w.name, run: run.id, status: run.status === "done" ? "done" : "failed", ...(run.result ? { result: clip(run.result, 3000) } : {}) },
    };
    await this.d.store.append(sid, FRIDAY, { type: "team.brief", ...b }, { lane: MAIN_LANE });
  }

  /**
   * What the lead is told besides the reports when a workflow's board is through (mesh.teamDone): which workflow it was, and
   * how to land it. `prSaid`: the team's own hand-off already asks for the pull request.
   */
  async landing(sid: string, prSaid = false): Promise<string | null> {
    const seq = (await this.d.store.state(sid).catch(() => null))?.board?.seq;
    const raw = seq ? await this.d.redis.get(this.boardKey(sid, seq)) : null;
    if (!raw) return null;
    const w = await this.get((JSON.parse(raw) as { id: string }).id);
    if (!w) return null;
    return [
      `[Friday] That board was the workflow “${w.name}”.`,
      w.outcomes.pr && !prSaid ? "Land it: merge your teammates' branches into one branch, run the full tests and fix what fails, then open one pull request with gh pr create for the person to review. Don't merge it, push to the default branch or deploy." : "",
      "Then end with its report in a few lines: what each step came to, and anything that needs the person.",
    ]
      .filter(Boolean)
      .join(" ");
  }

  // ── what starts one ──────────────────────────────────────────────────

  /** A team session's event: its run brought up to date, and the workflows a teammate's work or a board's end starts. */
  hear(sid: string, ev: SessionEvent): void {
    const b = ev.body;
    const board = b.type.startsWith("board.");
    if (!board && b.type !== "run.ended") return;
    void (async () => {
      if (!(await this.d.teammates.sessions()).includes(sid)) return;
      if (board) await this.sync(sid);
      const list = (await this.list()).filter((w) => w.on);
      if (!list.length) return;
      const state = await this.d.store.state(sid);
      const mate = await this.mateOn(sid, b.type === "board.reviewed" ? (state.board?.tasks.find((t) => t.id === b.id)?.lane ?? "") : (ev.lane ?? MAIN_LANE));
      if (b.type === "run.ended" && b.outcome === "done" && mate) {
        const events = await this.d.store.events(sid);
        const start = events.findLast((e) => e.seq < ev.seq && (e.lane ?? MAIN_LANE) === (ev.lane ?? MAIN_LANE) && e.body.type === "run.started");
        const said = events.findLast((e) => e.seq > (start?.seq ?? 0) && e.seq < ev.seq && (e.lane ?? MAIN_LANE) === (ev.lane ?? MAIN_LANE) && e.body.type === "agent.message" && !!e.body.text.trim());
        const text = said?.body.type === "agent.message" ? said.body.text.trim() : "";
        for (const w of list.filter((x) => x.trigger.kind === "teammate" && x.trigger.on === "turn" && x.trigger.mate === mate.id)) await this.fire(w, sid, `${mate.name} finished a turn`, text ? `${mate.name} finished a turn and said:\n${text}` : `${mate.name} finished a turn.`);
      }
      if (b.type === "board.reviewed" && b.ok && mate) {
        const t = state.board?.tasks.find((x) => x.id === b.id);
        for (const w of list.filter((x) => x.trigger.kind === "teammate" && x.trigger.on === "task" && x.trigger.mate === mate.id)) await this.fire(w, sid, `${mate.name} finished a task`, `${mate.name} finished the board task "${t?.title ?? b.id}"${t?.report ? `:\n${t.report}` : "."}`);
      }
      // A board through in this room, once: the workflows watching the room start, its own excepted.
      if (board && state.board && !boardBusy(state) && state.board.tasks.some((t) => t.status === "done")) {
        if (!(await this.d.redis.set(this.k(`workflow-boarddone:${sid}:${state.board.seq}`), "1", "EX", 7 * 86_400, "NX"))) return;
        const room = await this.roomOf(sid);
        if (!room) return;
        const roomName = room === TEAM_ROOM ? "the Crew room" : ((await this.d.teammates.room(room))?.name ?? "a room");
        const own = await this.d.redis.get(this.boardKey(sid, state.board.seq));
        const ownId = own ? (JSON.parse(own) as { id: string }).id : null;
        const what = state.board.tasks.filter((t) => t.status === "done").map((t) => `## ${t.title} (${t.name ?? ""})\n${clip(t.report ?? "", 1500)}`).join("\n\n");
        for (const w of list.filter((x) => x.trigger.kind === "board" && x.trigger.room === room && x.id !== ownId)) await this.fire(w, sid, `a board finished in ${roomName}`, `${state.board.fromName}'s board finished:\n\n${what}`);
      }
    })().catch((e) => this.d.log?.("[workflows] hearing", e));
  }

  /** A workflow started by something that happened in `sid`, unless its own run there is what happened. */
  private async fire(w: Workflow, sid: string, trigger: string, input: string): Promise<void> {
    const a = await this.active(sid);
    if (a?.id === w.id) return;
    await this.start(w, trigger, input);
  }

  private async roomOf(sid: string): Promise<string | null> {
    if ((await this.d.teammates.team()) === sid) return TEAM_ROOM;
    return (await this.d.teammates.rooms()).find((r) => r.sid === sid)?.id ?? null;
  }

  private async mateOn(sid: string, lane: string): Promise<{ id: string; name: string } | null> {
    if (!lane) return null;
    const list = await this.d.teammates.list();
    if ((await this.d.teammates.team()) === sid) return list.find((t) => t.lane === lane) ?? null;
    const r = (await this.d.teammates.rooms()).find((x) => x.sid === sid);
    const id = r && Object.entries(r.lanes).find(([, l]) => l === lane)?.[0];
    return (id && list.find((t) => t.id === id)) || null;
  }

  /**
   * Every 30 seconds, with the automations: schedules whose minute has come (each slot once), runs waiting for a board that is
   * free now (or skipped after twelve hours), and each room's run checked against its board, in case an event was missed.
   */
  async tick(now = new Date()): Promise<WorkflowRun[]> {
    const started: WorkflowRun[] = [];
    const names = await this.names();
    for (const w of await this.list()) {
      if (!w.on || w.trigger.kind !== "schedule") continue;
      const slot = dueSlot(w.trigger.schedule, now);
      if (!slot || (await this.d.redis.set(this.k(`workflow-fired:${w.id}:${slot}`), "1", "EX", 2 * 86_400, "NX")) !== "OK") continue;
      started.push(await this.start(w, describeTrigger(w.trigger, names), `It's ${now.toISOString().slice(0, 16).replace("T", " ")} UTC.`));
    }
    for (const entry of await this.d.redis.zrangebyscore(this.waitingKey(), "-inf", "+inf")) {
      const [id, runId] = entry.split(" ");
      const w = id ? await this.get(id) : null;
      const run = w && runId ? (await this.runs(w.id)).find((r) => r.id === runId) : undefined;
      if (!w || !run || run.status !== "waiting") {
        await this.d.redis.zrem(this.waitingKey(), entry);
        continue;
      }
      if (now.getTime() - run.at > WAIT_FOR_BOARD_MS) {
        await this.d.redis.zrem(this.waitingKey(), entry);
        await this.updateRun(w.id, run.id, { status: "skipped", note: "Its room's board wasn't free within 12 hours.", ended: now.getTime() });
        continue;
      }
      const place = await this.place(w.room);
      const state = place ? await this.d.store.state(place.sid).catch(() => null) : null;
      if (place && ((state?.board && boardBusy(state)) || (await this.active(place.sid)))) continue;
      if (!(await this.d.redis.zrem(this.waitingKey(), entry))) continue;
      started.push(await this.post(w, run));
    }
    for (const sid of await this.d.redis.smembers(this.activesKey())) await this.sync(sid).catch((e) => this.d.log?.("[workflows] sync", e));
    return started;
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
