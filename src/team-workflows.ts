import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import { dueSlot, dueSlotSince, validateSchedule, type AgentSchedule } from "./agents.js";
import { laneName } from "./session/core.js";
import { boardBusy, type BoardTask, type SessionState } from "./session/projection.js";
import type { SessionStore } from "./session/store.js";
import {
  cleanWorkflow,
  DEFAULT_TRIES,
  describeTrigger,
  LEAD,
  MAX_CHAIN,
  MAX_CONNECTIONS_PER_RUN,
  packSteps,
  roomRunOf,
  sendBackNote,
  stageCols,
  stageOfStep,
  stagesOf,
  TEAM_ROOM,
  verdictOf,
  workflowChecks,
  workflowTasks,
  type RoomRun,
  type Workflow,
  type WorkflowRun,
  type WorkflowRunStep,
  type WorkflowStep,
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
 * A workflow with checks or OKs runs in stages (team-workflow-model.ts stagesOf), one board each: when a stage's board is through,
 * its check's PASS moves the run on to the next stage's board, handed what this one came to; a FAIL stops it or posts an earlier
 * stage's board again, with why. An OK waits for you (answer), with no board; meanwhile the room is free.
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
export interface Place {
  room: string;
  sid: string;
  name: string;
  lanes: Record<string, string>;
}

/** A run waiting for your OK, for the page to show with its answer (GET /api/teammates `asks`). */
export interface WorkflowAsk {
  id: string;
  name: string;
  run: string;
  step: string;
  /** Its number in the workflow. */
  n: number;
  ask: string;
  since: number;
  /** What the work came to so far, for you to judge. */
  carry: string;
  sid?: string;
  roomName: string;
  /** Not passed: what happens. */
  ifNot: "stop" | "back";
  backTo?: number;
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

  protected k = (s: string) => `${this.d.prefix}teammates:${s}`;
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

  /** Where `w` runs: its room, or the Crew room. */
  protected async place(room: string, _w?: Workflow): Promise<Place | null> {
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
      trigger: w.trigger.kind === "webhook" ? { kind: "webhook", secret: "", url: `${this.hookUrl(w, hookBase)}?key=${w.trigger.secret}` } : w.trigger,
      says: { trigger: describeTrigger(w.trigger, names) },
      runs: await this.runs(w.id, 6),
      today: await this.runsToday(w.id),
      next: w.on && w.trigger.kind === "schedule" ? nextRunAt(w.trigger.schedule) : null,
    };
  }

  /** Whose work a run of `w` is, said on its board: nobody's here, the crew being one person's. */
  protected byOf(_w: Workflow): { id: string; name: string } | undefined {
    return undefined;
  }

  /** Where its webhook is called, without its key. */
  protected hookUrl(w: Workflow, hookBase: string): string {
    return `${hookBase}/api/hooks/workflow/${w.id}`;
  }

  /**
   * The lanes in `place` a run of `w` may hand work to, and why any other one may not: null, every member (one person's crew, as
   * here). The hosted service's keeps a run to its owner's teammates (hosted-workflows.ts).
   */
  protected async runnable(_w: Workflow, _place: Place, _state: SessionState): Promise<{ lanes: string[]; why: (lane: string) => string; none: string; /** A step for any other lane is asked of its keeper (onBoard), rather than refused. */ asks?: boolean } | null> {
    return null;
  }

  /**
   * While a run's board is being worked on, after each look at it: any change to the run besides its steps as the board has them
   * (the hosted service's asks of other keepers). Nothing here.
   */
  protected async onBoard(_w: Workflow, _run: WorkflowRun, _sid: string, _state: SessionState): Promise<Partial<WorkflowRun> | null> {
    return null;
  }

  // ── a run ────────────────────────────────────────────────────────────

  /**
   * A run of `w`, started by `trigger` (in words) with `input` (what started it): counted against its day, then posted as its
   * room's board, or waiting for that board to be free, or skipped. Returns the run as it stands.
   */
  async start(w: Workflow, trigger: string, input = "", depth = 0): Promise<WorkflowRun> {
    let run: WorkflowRun = { id: randomBytes(5).toString("hex"), at: Date.now(), trigger, status: "running", room: w.room, roomName: "", steps: [], stage: 0, ...(input.trim() ? { input: clip(input.trim(), 8000), carry: clip(input.trim(), 8000) } : {}), ...(depth ? { depth } : {}) };
    if (!(await this.countRun(w))) {
      run = { ...run, status: "skipped", note: `It has already run ${w.limits.perDay} time${w.limits.perDay === 1 ? "" : "s"} today, its limit.`, ended: Date.now() };
      await this.addRun(w.id, run);
      return run;
    }
    await this.addRun(w.id, run);
    return this.post(w, run);
  }

  /**
   * The run's stage posted in its room, once that room's board is free; one post at a time per room. `cont`: a run already under
   * way moving on to its next stage, or back to an earlier one, which waits for a busy board rather than being skipped. Your OK's
   * stage posts nothing: the run waits for you.
   */
  private async post(w: Workflow, run: WorkflowRun, cont = false): Promise<WorkflowRun> {
    const set = async (change: Partial<WorkflowRun>) => (run = (await this.updateRun(w.id, run.id, change)) ?? { ...run, ...change });
    try {
      const place = await this.place(w.room, w);
      if (!place) throw new Error("Its room isn't there any more. Pick where it runs.");
      // Sent back to be fixed by someone else (WorkflowStep.fixBy): that step is theirs, this once.
      const order = packSteps(w.steps).map((s) => (run.from && run.fixBy && s.id === run.from ? { ...s, mate: run.fixBy } : s));
      const stages = stagesOf(order);
      const at = run.stage ?? 0;
      const stage = stages[at];
      if (!stage) throw new Error("Its steps changed while it ran, so it can't go on.");
      if (stage.gate?.kind === "approve") return await this.waitForOk(w, run, stage.gate, order, place.name, set);
      return await this.d.teammates.locked(`workflow-post:${place.sid}`, async () => {
        const [mates, rooms, all] = await Promise.all([this.d.teammates.list(), this.d.teammates.rooms(), this.list()]);
        const fix = workflowChecks(w, { mates, rooms: rooms.map((r) => ({ id: r.id, name: r.name, members: Object.keys(r.lanes) })), workflows: all }).find((c) => c.level === "fix");
        if (fix) throw new Error(`${fix.text}.`);
        const state = await this.d.store.state(place.sid);
        const active = await this.active(place.sid);
        if ((state.board && boardBusy(state)) || active) {
          const why = active?.id === w.id ? `Its last run is still going in ${place.name}.` : `${cap(place.name)}'s board is still being worked on.`;
          if (w.limits.skipIfRunning && !cont) return await set({ status: "skipped", roomName: place.name, note: why, ended: Date.now() });
          const since = Date.now();
          await this.d.redis.zadd(this.waitingKey(), since, `${w.id} ${run.id}`);
          return await set({ status: "waiting", roomName: place.name, note: `${why} It starts when that's done.`, waitingSince: since, waitingCont: cont });
        }
        const members = Object.values(place.lanes).filter((l) => state.lanes.some((x) => x.id === l));
        // Led by the room's lead, or, where only some may take the run's work, by the room's lead if it is one of them, else the
        // first of them online.
        const can = await this.runnable(w, place, state);
        const pool = can ? members.filter((l) => can.lanes.includes(l)) : members;
        const lead = state.lead && pool.includes(state.lead) ? state.lead : ((can ? pool.find((l) => state.engines[l]?.online) : undefined) ?? pool[0] ?? "");
        if (!lead) throw new Error(can && members.length ? can.none : `Nobody is in ${place.name} to run it.`);
        const laneOfMate = (mate: string) => (mate === LEAD ? lead : (place.lanes[mate] ?? ""));
        const here = stageCols(order, at, run.from).flat();
        const missing = here.find((s) => !members.includes(laneOfMate(s.mate)));
        if (missing) throw new Error(`One of its teammates isn't in ${place.name}.`);
        const held = can && here.map((s) => laneOfMate(s.mate)).find((l) => !can.lanes.includes(l));
        if (held && !can.asks) throw new Error(can.why(held));
        const tasks = workflowTasks({ ...w, steps: order }, (mate) => laneName(state, laneOfMate(mate)), run.carry ?? run.input ?? "", at, run.from);
        const fromName = laneName(state, lead);
        // As Friday, from the lead: the lead hears how it went when it is through, and its report is the run's last word.
        const by = this.byOf(w);
        const posted = await this.d.store.append(place.sid, FRIDAY, { type: "board.posted", fromLane: lead, fromName, tasks, ...(by ? { by } : {}) }, { lane: lead });
        if (!posted.ok) throw new Error(`Couldn't post its board in ${place.name}.`);
        const exit = stage.gate ?? stage.exit;
        const last = exit?.next ? exit.next === "$finish" : at === stages.length - 1;
        const ref = JSON.stringify({ id: w.id, run: run.id, seq: posted.seq, last });
        await this.d.redis.multi().set(this.activeKey(place.sid), ref).sadd(this.activesKey(), place.sid).set(this.boardKey(place.sid, posted.seq), ref, "EX", 30 * 86_400).exec();
        // This stage's steps as the run has them, fresh; any it did before (sent back) counted again; the rest as they were.
        const fresh = tasks.map((t, i): WorkflowRunStep => {
          const s = here[i]!;
          const was = run.steps.find((x) => x.step === s.id);
          return { step: s.id, task: t.id, title: t.title, name: t.next, lane: laneOfMate(s.mate), status: "open", ...(s.kind ? { kind: s.kind } : {}), ...(was ? { again: (was.again ?? 0) + 1 } : {}) };
        });
        const steps = mergeSteps(order, run.steps, fresh);
        await set({ status: "running", sid: place.sid, seq: posted.seq, seq0: run.seq0 ?? posted.seq, roomName: place.name, steps, note: "" });
        await this.d.dispatch(place.sid);
        return run;
      });
    } catch (e) {
      return await set({ status: "failed", note: clip((e as Error).message, 300), ended: Date.now() });
    }
  }

  protected async active(sid: string): Promise<{ id: string; run: string; seq: number } | null> {
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
      const steps = onBoard(run, tasks);
      if (!boardBusy(state)) return void (await this.finish(a.id, w, run, sid, state, tasks));
      const more = w ? await this.onBoard(w, { ...run, steps }, sid, state) : null;
      const next = { steps, ...more };
      if (JSON.stringify(next.steps) !== JSON.stringify(run.steps) || (more?.note !== undefined && more.note !== run.note)) await this.updateRun(a.id, run.id, next);
    });
  }

  private async clearActive(sid: string): Promise<void> {
    await this.d.redis.multi().del(this.activeKey(sid)).srem(this.activesKey(), sid).exec();
  }

  /**
   * A stage's board is through (or gone), once: a stuck step or a gone board ends the run; a check's answer moves it on, stops it
   * or sends the work back; past its last stage it ends, with its outcomes.
   */
  private async finish(id: string, w: Workflow | null, run: WorkflowRun, sid: string, state: SessionState, tasks: BoardTask[], gone?: string): Promise<void> {
    await this.clearActive(sid);
    if (!(await this.d.redis.set(this.k(`workflow-finished:${run.id}:${run.seq ?? 0}`), "1", "EX", 7 * 86_400, "NX"))) return;
    let steps = onBoard(run, tasks);
    const mine = steps.filter((s) => tasks.some((t) => t.id === s.task));
    const stuck = mine.filter((s) => s.status === "blocked");
    // What this stage came to: the reports of its steps nothing waited on, its check aside.
    const checks = new Set(mine.filter((s) => s.kind === "check").map((s) => s.task));
    const waitedOn = new Set(tasks.filter((t) => !checks.has(t.id)).flatMap((t) => t.after));
    const last = mine.filter((s) => !waitedOn.has(s.task) && s.status === "done" && s.report && s.kind !== "check");
    const came = last.map((s) => `## ${s.title} (${s.name})\n${s.report}`).join("\n\n");
    // A step asked of another keeper who didn't take it on (the hosted service's) was dropped for that: said as theirs.
    const declined = mine.filter((s) => s.asked?.status === "declined").map((s) => `${s.asked!.keeper} didn't take on step ${s.task.slice(1)}.`);
    if (gone || stuck.length || !mine.some((s) => s.status === "done")) {
      const note = gone ?? (stuck.length ? `Step ${stuck.map((s) => s.task.slice(1)).join(", ")} got stuck: ${clip(stuck[0]!.report ?? "no report", 240)}` : [...declined, "Every step was dropped."].filter(Boolean).join(" "));
      return this.end(w, { ...run, steps }, { status: "failed", note, result: came || run.carry || "" }, state);
    }
    const order = w ? packSteps(w.steps) : [];
    const stages = stagesOf(order);
    const at = run.stage ?? 0;
    const gate = stages[at]?.gate;
    const carry = came || run.carry || "";
    if (w && gate?.kind === "check") {
      const said = steps.find((s) => s.step === gate.id);
      const v = said?.status === "done" ? (verdictOf(said.report ?? "") ?? { pass: false, why: "Its check didn't end with PASS or FAIL." }) : { pass: false, why: "Its check was dropped." };
      steps = steps.map((s) => (s.step === gate.id ? { ...s, verdict: { pass: v.pass, why: clip(v.why, 400) } } : s));
      if (!v.pass) return this.notPassed(w, { ...run, steps }, gate, order, v.why, carry, state);
    }
    return this.onward(w, { ...run, steps, ...(declined.length ? { note: declined.join(" ") } : {}) }, carry, state);
  }

  /** On to the stage after this one, handed `carry`; past the last, the run is done, with it as its result. */
  private async onward(w: Workflow | null, run: WorkflowRun, carry: string, state: SessionState | null): Promise<void> {
    const stage = w && stagesOf(packSteps(w.steps))[run.stage ?? 0];
    const target = stage && (stage.gate ?? stage.exit)?.next;
    if (w && target) return this.follow(w, run, target, carry, state);
    const next = (run.stage ?? 0) + 1;
    if (!w || next >= stagesOf(packSteps(w.steps)).length) return this.end(w, run, { status: "done", note: run.note ?? "", result: carry }, state);
    const moved = (await this.updateRun(w.id, run.id, { steps: run.steps, stage: next, carry: clip(carry, 8000), status: "running", note: "", from: undefined, fixBy: undefined })) ?? run;
    await this.post(w, moved, true);
  }

  /** Enter the destination's column; other paths aren't posted. Never switch the step's teammate or account. */
  private async follow(w: Workflow, run: WorkflowRun, target: string, carry: string, state: SessionState | null): Promise<void> {
    if (target === "$finish") return this.end(w, run, { status: "done", note: "", result: carry }, state);
    const stage = stageOfStep(stagesOf(packSteps(w.steps)), target);
    if (stage < 0) return this.end(w, run, { status: "failed", note: "A connection's destination is gone. Reconnect it before running again.", result: carry }, state);
    const connections = (run.connections ?? 0) + 1;
    if (connections > MAX_CONNECTIONS_PER_RUN) return this.end(w, run, { status: "failed", note: `Stopped after ${MAX_CONNECTIONS_PER_RUN} connections: check the workflow for a loop without an exit.`, result: carry }, state);
    const moved = (await this.updateRun(w.id, run.id, { steps: run.steps, stage, from: target, connections, fixBy: undefined, asking: undefined, carry: clip(carry, 8000), status: "running", note: "", tries: run.tries })) ?? run;
    await this.post(w, moved, true);
  }

  /** A check or your OK not passed: the run stopped there, or the work sent back to its earlier step, up to its tries. */
  private async notPassed(w: Workflow, run: WorkflowRun, gate: WorkflowStep, order: WorkflowStep[], why: string, carry: string, state: SessionState | null): Promise<void> {
    const n = order.findIndex((s) => s.id === gate.id) + 1;
    const what = gate.kind === "approve" ? "You" : `Step ${n}'s check`;
    if (gate.otherwise === "$finish" || (!gate.otherwise && gate.ifNot !== "back")) return this.end(w, run, { status: "stopped", note: clip(`${what} stopped it${why ? `: ${why}` : "."}`, 300), result: carry }, state);
    const max = gate.tries ?? DEFAULT_TRIES;
    const tried = run.tries?.[gate.id] ?? 0;
    if (tried >= max) return this.end(w, run, { status: "failed", note: clip(`${gate.kind === "approve" ? "Your OK" : `Step ${n}'s check`} still didn't pass after ${max} ${max === 1 ? "try" : "tries"}${why ? `: ${why}` : "."}`, 300), result: carry }, state);
    if (gate.otherwise) {
      const note = [why ? `Step ${n} didn't pass: ${why}` : `Step ${n} didn't pass.`, carry].filter(Boolean).join("\n\n");
      return this.follow(w, { ...run, tries: { ...run.tries, [gate.id]: tried + 1 } }, gate.otherwise, note, state);
    }
    const stages = stagesOf(order);
    const to = stageOfStep(stages, gate.back ?? "");
    if (to < 0) return this.end(w, run, { status: "failed", note: "The step it sends the work back to is gone.", result: carry }, state);
    // The steps before it in its stage stand as they were, so what they handed on goes with it again.
    const first = stageCols(order, to)[0]?.map((x) => x.id) ?? [];
    const until = order.findIndex((x) => x.id === gate.back);
    const handed = run.steps
      .filter((x) => stageOfStep(stages, x.step) === to && order.findIndex((o) => o.id === x.step) < until && x.kind !== "check" && x.status === "done" && x.report)
      .map((x) => `## ${x.title} (${x.name})\n${x.report}`)
      .join("\n\n");
    const opening = first.includes(gate.back ?? "") ? run.input ?? "" : "";
    const note = [sendBackNote({ gate, why, attempt: tried + 1, max, before: carry }), handed ? `What the steps before it handed on:\n${handed}` : "", opening.trim() ? `What started this run:\n${opening.trim()}` : ""].filter(Boolean).join("\n\n");
    const back = (await this.updateRun(w.id, run.id, { steps: run.steps, stage: to, from: gate.back, fixBy: gate.fixBy || undefined, carry: clip(note, 8000), tries: { ...run.tries, [gate.id]: tried + 1 }, status: "running", note: clip(`Sent back to step ${order.findIndex((s) => s.id === gate.back) + 1}${why ? `: ${why}` : "."}`, 300) })) ?? run;
    await this.post(w, back, true);
  }

  /** The run waiting for your OK on `gate`: nothing posted, the room left free, and you told. */
  private async waitForOk(w: Workflow, run: WorkflowRun, gate: WorkflowStep, order: WorkflowStep[], roomName: string, set: (c: Partial<WorkflowRun>) => Promise<WorkflowRun>): Promise<WorkflowRun> {
    const n = order.findIndex((s) => s.id === gate.id) + 1;
    const step: WorkflowRunStep = { step: gate.id, task: `s${n}`, title: gate.does.trim().split("\n")[0]!.slice(0, 90) || "Your OK", name: "You", lane: "", status: "claimed", kind: "approve" };
    const asking = { step: gate.id, ask: gate.does.trim() || "OK to go on?", since: Date.now() };
    const got = await set({ status: "asking", roomName, asking, steps: mergeSteps(order, run.steps, [step]), note: "" });
    await this.d.redis.multi().lpush(this.askedKey(), JSON.stringify({ id: w.id, run: run.id, at: asking.since })).ltrim(this.askedKey(), 0, 19).exec();
    return got;
  }
  private askedKey = () => this.k("workflow-asked");

  /** Your answer to a run waiting for your OK: on with it (what you said handed to the next steps), or not, as its step says. */
  async answer(w: Workflow, runId: string, ok: boolean, said = ""): Promise<WorkflowRun> {
    return this.d.teammates.locked(`workflow-answer:${runId}`, async () => {
      const run = (await this.runs(w.id, 50)).find((r) => r.id === runId);
      if (!run || run.status !== "asking" || !run.asking) throw new Error("That run isn't waiting for you any more.");
      const order = packSteps(w.steps);
      const gate = order.find((s) => s.id === run.asking!.step);
      if (!gate) throw new Error("Its steps changed while it waited, so it can't go on. Run it again.");
      const note = said.trim().slice(0, 2000);
      const steps = run.steps.map((s) => (s.step === gate.id ? { ...s, status: ok ? ("done" as const) : ("cancelled" as const), verdict: { pass: ok, why: note } } : s));
      const state = run.sid ? await this.d.store.state(run.sid).catch(() => null) : null;
      const base = { ...run, steps, asking: undefined };
      await this.updateRun(w.id, run.id, { steps, asking: undefined });
      if (ok) await this.onward(w, base, [run.carry ?? "", note ? `The person OK'd it and said: ${note}` : "The person OK'd it."].filter(Boolean).join("\n\n"), state);
      else await this.notPassed(w, base, gate, order, note, run.carry ?? "", state);
      return (await this.runs(w.id, 50)).find((r) => r.id === runId) ?? run;
    });
  }

  /** A run that didn't finish, tried again from the stage it stopped at, handed what that stage was handed. */
  async retry(w: Workflow, runId: string): Promise<WorkflowRun> {
    const run = (await this.runs(w.id, 50)).find((r) => r.id === runId);
    if (!run || (run.status !== "failed" && run.status !== "stopped")) throw new Error("Only a run that didn't finish can be tried again.");
    if (stagesOf(packSteps(w.steps)).length <= (run.stage ?? 0)) throw new Error("Its steps changed since, so it can't pick up where it was. Run it again.");
    await this.d.redis.del(this.k(`workflow-ended:${run.id}`));
    const again = (await this.updateRun(w.id, run.id, { status: "running", note: "", ended: undefined, asking: undefined, tries: {} })) ?? run;
    return this.post(w, again, true);
  }

  /** Each room's runs of the last two days, for their cards in the room (roomRunOf). */
  async roomRuns(now = Date.now()): Promise<RoomRun[]> {
    const names = await this.names();
    const out: RoomRun[] = [];
    for (const w of await this.list())
      for (const r of await this.runs(w.id, 8)) {
        if (now - r.at > 2 * 86_400_000) continue;
        const v = roomRunOf(w, r, names.mate);
        if (v) out.push(v);
      }
    return out;
  }

  /** The runs waiting for your OK now, oldest first. */
  async asks(): Promise<WorkflowAsk[]> {
    const out: WorkflowAsk[] = [];
    for (const w of await this.list()) {
      const order = packSteps(w.steps);
      for (const r of await this.runs(w.id, 10)) {
        if (r.status !== "asking" || !r.asking) continue;
        const g = order.find((s) => s.id === r.asking!.step);
        out.push({ id: w.id, name: w.name, run: r.id, step: r.asking.step, n: order.findIndex((s) => s.id === r.asking!.step) + 1, ask: r.asking.ask, since: r.asking.since, carry: clip(r.carry ?? "", 4000), ...(r.sid ? { sid: r.sid } : {}), roomName: r.roomName, ifNot: g?.ifNot === "back" ? "back" : "stop", ...(g?.ifNot === "back" && g.back ? { backTo: order.findIndex((s) => s.id === g.back) + 1 } : {}) });
      }
    }
    return out.sort((a, b) => a.since - b.since);
  }

  /** The run's end, once: its record, its brief, you told, its result handed on. */
  private async end(w: Workflow | null, run: WorkflowRun, e: { status: "done" | "failed" | "stopped"; note: string; result: string }, state: SessionState | null): Promise<void> {
    if (!(await this.d.redis.set(this.k(`workflow-ended:${run.id}`), "1", "EX", 7 * 86_400, "NX"))) return;
    const { status, note } = e;
    const result = e.result.trim();
    const sid = run.sid;
    const ended = Date.now();
    if (!w) return;
    const done = (await this.updateRun(w.id, run.id, { status, steps: run.steps, ended, note, asking: undefined, fixBy: undefined, ...(result ? { result: clip(result, 8000) } : {}) })) ?? run;
    const gone = /replaced by another/.test(note);
    if (w.outcomes.brief && !gone && sid && state) await this.brief(w, done, sid, state).catch((e) => this.d.log?.("[workflows] brief", e));
    if (w.outcomes.notify) {
      const e: WorkflowEnded = { id: w.id, name: w.name, run: run.id, status, ended, ...(sid ? { sid } : {}), roomName: run.roomName, ...(note ? { note } : {}) };
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
    const seqOf = (task: string) => events.findLast((e) => e.seq > (run.seq0 ?? run.seq ?? 0) && (e.body.type === "board.finished" || e.body.type === "board.reviewed") && e.body.id === task)?.seq;
    const b: TeamBrief = {
      since: run.at,
      until: run.ended ?? Date.now(),
      done: run.steps.filter((s) => s.status === "done" && s.kind !== "approve").map((s) => ({ lane: s.lane, name: s.name || laneName(state, s.lane), title: s.title, ...(seqOf(s.task) ? { seq: seqOf(s.task)! } : {}) })),
      failed: run.steps.filter((s) => s.status === "blocked" || s.status === "cancelled").map((s) => ({ lane: s.lane, name: s.name || laneName(state, s.lane), title: s.title, why: s.status === "cancelled" ? "Dropped." : clip(s.report ?? "Stuck.", 300), ...(seqOf(s.task) ? { seq: seqOf(s.task)! } : {}) })),
      waiting: [],
      assumptions: [],
      usage: [],
      workflow: { id: w.id, name: w.name, run: run.id, status: run.status === "done" || run.status === "stopped" ? "done" : "failed", ...(run.result ? { result: clip(run.result, 3000) } : {}) },
    };
    await this.d.store.append(sid, FRIDAY, { type: "team.brief", ...b }, { lane: MAIN_LANE });
  }

  /**
   * What the lead is told besides the reports when a workflow's board is through (mesh.teamDone): which workflow it was, and
   * how to land it. `prSaid`: the team's own hand-off already asks for the pull request.
   */
  async landing(sid: string, prSaid = false): Promise<string | null> {
    const state = await this.d.store.state(sid).catch(() => null);
    const seq = state?.board?.seq;
    const raw = seq ? await this.d.redis.get(this.boardKey(sid, seq)) : null;
    if (!raw) return null;
    const ref = JSON.parse(raw) as { id: string; run?: string; last?: boolean };
    const w = await this.get(ref.id);
    if (!w) return null;
    // A stage that isn't the last, or the next stage's board already up: Friday hands it on, so there is nothing to land yet.
    const wired = w.steps.some(s => s.next || s.otherwise);
    const run = wired ? (await this.runs(w.id, 50)).find(r => r.id === ref.run) : undefined;
    if ((wired ? run?.status !== "done" : ref.last === false) || (state?.board && boardBusy(state))) return `[Friday] That board was part of the workflow “${w.name}”: Friday hands what it came to on to its next part. Don't post a board or open a pull request; end with a short report.`;
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
      if (!(await this.ours(sid))) return;
      if (board) await this.sync(sid);
      const list: Workflow[] = [];
      for (const w of await this.list()) if (w.on && (await this.watches(w, sid))) list.push(w);
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

  /** Whether `sid` is one of the crew's sessions, whose events workflows follow. */
  protected async ours(sid: string): Promise<boolean> {
    return (await this.d.teammates.sessions()).includes(sid);
  }

  /** Whether what happens in `sid` may start `w`: anywhere in the crew, here. */
  protected async watches(_w: Workflow, _sid: string): Promise<boolean> {
    return true;
  }

  protected async roomOf(sid: string): Promise<string | null> {
    if ((await this.d.teammates.team()) === sid) return TEAM_ROOM;
    return (await this.d.teammates.rooms()).find((r) => r.sid === sid)?.id ?? null;
  }

  protected async mateOn(sid: string, lane: string): Promise<{ id: string; name: string } | null> {
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
      const slot = dueSlotSince(w.trigger.schedule, now, w.updated ?? w.created);
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
      if (now.getTime() - (run.waitingSince ?? run.at) > WAIT_FOR_BOARD_MS) {
        await this.d.redis.zrem(this.waitingKey(), entry);
        await this.updateRun(w.id, run.id, { status: "skipped", note: "Its room's board wasn't free within 12 hours.", ended: now.getTime() });
        continue;
      }
      const place = await this.place(w.room, w);
      const state = place ? await this.d.store.state(place.sid).catch(() => null) : null;
      if (place && ((state?.board && boardBusy(state)) || (await this.active(place.sid)))) continue;
      if (!(await this.d.redis.zrem(this.waitingKey(), entry))) continue;
      started.push(await this.post(w, run, !!run.waitingCont));
    }
    for (const sid of await this.d.redis.smembers(this.activesKey())) await this.sync(sid).catch((e) => this.d.log?.("[workflows] sync", e));
    return started;
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The run's steps as a board has them: each on it with its status, name and report; the rest as they were. */
function onBoard(run: WorkflowRun, tasks: BoardTask[]): WorkflowRunStep[] {
  return run.steps.map((s) => ((t) => (t ? { ...s, status: t.status, name: t.name ?? s.name, ...(t.report ? { report: clip(t.report, 4000) } : {}) } : s))(tasks.find((x) => x.id === s.task)));
}

/** A run's steps with `fresh` in place of what it had for the same steps, in the workflow's order. */
function mergeSteps(order: readonly WorkflowStep[], had: readonly WorkflowRunStep[], fresh: readonly WorkflowRunStep[]): WorkflowRunStep[] {
  const by = new Map(had.map((s) => [s.step, s]));
  for (const s of fresh) by.set(s.step, s);
  const at = (id: string) => ((i) => (i < 0 ? order.length : i))(order.findIndex((s) => s.id === id));
  return [...by.values()].sort((a, b) => at(a.step) - at(b.step));
}
