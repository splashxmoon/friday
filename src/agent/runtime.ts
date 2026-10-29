import { announcesAction } from "./announced.js";
import { unfinishedPlan } from "../keep-going.js";
import { randomBytes } from "node:crypto";
import { randomUUID } from "node:crypto";
import { collisionLine, collisionsFor, plannedOverlapLine, plannedOverlapsFor } from "../collisions.js";
import { uploadsMayRun } from "../uploaded.js";
import { SAMPLE_TITLE } from "../sample.js";
import type { Bus } from "../bus.js";
import type { ResolvedFile } from "../files.js";
import { allowedCommand, canDriveLane, driverOf, laneOf, pendingFor, project, roleOf, runOf, upstreamOf, type SessionState } from "../session/projection.js";
import type { AppendGuard, AppendResult, SessionStore } from "../session/store.js";
import { liveMachine, MAIN_LANE, mayBorrow, SESSION_LANES, type ActorRef, type AgentSnapshot, type SkillBrief, type Lane, type LaneTrigger, type Attachment, type DiffFile, type EngineMode, type EventBody, type RepoCall, type SessionEvent, type ToolCall } from "../types.js";
import { startCheckpoint } from "../rewind.js";
import { buildContext } from "./context.js";
import { ProviderError, type Completion, type LLM } from "./llm.js";
import { systemPrompt } from "./prompt.js";
import { CURSOR_RULES_DIR, CURSOR_RULES_FILE, cursorRuleFiles, cursorRuleText, isMissing, RULE_FILES, rulesBlock } from "../project-rules.js";
import { cleanHandoff, laneName } from "../session/core.js";
import { catalogBriefs } from "../skill-catalog.js";
import { extractDecisions, MIN_TOOL_CALLS, transcriptOf } from "../decision-log.js";
import { BOUNCE_WINDOW_MS, bouncesBetween, carriedFor, MAX_BOUNCES, resolveTarget } from "../handoff.js";
import { handOff } from "../hand-off-run.js";
import { isOwnModel } from "../own-model-id.js";
import { ownModelParts } from "../own-model-id.js";
import { isAuto, routeFriday, taskTier } from "../routing.js";
import type { Learned } from "../route-learning.js";
import type { AgentMesh } from "../agent-mesh.js";
import { toolSchemas, useSkillTool, type AgentTool } from "./tools.js";

const AGENT: ActorRef = { id: "agent", name: "Agent", kind: "agent" };
const LEASE_MS = 15_000;

/**
 * The briefs this run can reach.
 *
 * A custom agent gets exactly the skills its owner picked — narrowing it is the
 * whole point of building one. Friday's own agent gets the built-in catalog for
 * the surface, because it is the general-purpose default and the room brings it
 * whatever it has.
 */
function skillsFor(state: SessionState, agent?: AgentSnapshot | null): SkillBrief[] {
  const a = agent ?? state.options.agent;
  return a ? (a.skills ?? []) : catalogBriefs();
}
/** The lowest engine mode each repo tool needs before it is worth offering. */
/** Whether the driver has approved this lane's plan since its current run began. */
function planApproved(state: SessionState, lane: string): boolean {
  return (state.planApproved[lane] ?? 0) > runOf(state, lane).sinceSeq;
}

const REPO_TOOLS: Record<string, EngineMode> = {
  list_files: "plan",
  read_file: "plan",
  search_code: "plan",
  write_file: "edits",
  edit_file: "edits",
  run_command: "full",
  run_background: "full",
  read_background: "full",
  stop_background: "full",
  show_preview: "full",
};
const MODE_RANK: Record<EngineMode, number> = { plan: 0, edits: 1, full: 2 };
/**
 * Tools whose answer is an act, not a fact.
 *
 * Running a command twice does two things; asking a person twice asks twice.
 * Only the tools that look something up are worth remembering the answer to.
 */
/** The connected services that answer about code kept somewhere else. */
const CODE_HOST = /^mcp__(github|gitlab|bitbucket)/i;

const REPEATABLE = new Set(["show_preview", "run_command", "run_background", "read_background", "stop_background", "shell", "write_file", "edit_file", "ask_human", "hand_off", "deploy_agent", "remember", "update_plan"]);

const CHANGES_THINGS = new Set(["run_command", "shell", "write_file", "edit_file"]);
/** The longest command put to a person on a Manual machine: the card shows all of it, and this much is still readable. */
const MAX_ASKED = 4_000;

/** Looking at the code rather than changing it. A step that calls only these is pure reading. */
const EXPLORE_ONLY = new Set(["list_files", "read_file", "search_code", "web_search", "fetch_url"]);
// Turns in a row of nothing but reading before the reading stops. Found on a
// large repo with a broad instruction ("look over code and improve it"): the
// model read fifty files across as many turns and never wrote a plan or
// changed a line, because nothing ever made it stop looking and start.
//
// The order is plan, then act. So when reading has gone on long enough, the
// reading tools are taken away until a plan exists — it cannot keep looking, it
// can only say what it will do, or ask. Writing the plan hands them back.
const EXPLORE_STREAK_LIMIT = 8;
/** While the reading tools are away, this many more turns of asking for them ends the run. */
const EXPLORE_GATED_LIMIT = 3;
/** How many times one run may be stopped and made to plan. */
const MAX_PLAN_GATES = 3;
/** What is still offered while a plan is owed. */
const PLAN_TOOLS = new Set(["update_plan", "ask_human", "remember"]);

/** Times a run with its own plan still open is told to carry on (keep-going.ts: until the task is done). */
const MAX_NUDGES = 5;
/** Times a run is told that saying what it will do next is not the same as doing it. */
const MAX_ANNOUNCED = 3;

// Moved beside the coding tools' own carry-on, which reads the plan the same way; exported from here as before.
export { unfinishedPlan };

const RENEW_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

export interface RuntimeOptions {
  /** The agents in a session talking to each other (agent-mesh.ts). Without it those tools aren't offered. */
  mesh?: AgentMesh;
  /** The other sessions an agent's person is in, to list, read and message (peers.ts). Without it those tools aren't offered. */
  /** Plan a hub for the session (hubs.ts), as the person the agent works for. Without it the tool isn't offered. */
  startHub?: (sid: string, lane: string, goal: string) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  /** Tools from outside the process (MCP connections), fetched fresh each step. */
  extraTools?: (workspaceId: string) => Promise<AgentTool[]>;
  /** What is remembered across sessions for this person, written as lines; empty if memory is off. */
  recall?: (workspaceId: string, userId: string) => Promise<string>;
  /** What the team learned on this lane's repo in earlier sessions (the project brain), for an agent starting on `task`. */
  brief?: (workspaceId: string, sid: string, lane: string, task: string) => Promise<string>;
  /** Keep something across sessions, for the person driving. */
  saveMemory?: (workspaceId: string, user: { id: string; name: string }, text: string, scope: "personal" | "workspace") => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** The skills this person has added themselves, for the built-in agent to use alongside its own. */
  userSkills?: (workspaceId: string, userId: string) => Promise<SkillBrief[]>;
  /** The brief of one skill that is fetched on use, as the person who owns it. */
  skillBrief?: (workspaceId: string, id: string, owner: string, collection?: string) => Promise<string | null>;
  /** Bring skills in from a GitHub repository for the person driving. */
  importSkills?: (workspaceId: string, user: { id: string; name: string }, req: { url: string; only?: string[] }) => Promise<string>;
  /** Loads attachment contents for the model. */
  resolveFiles?: (sid: string, atts: Attachment[]) => Promise<Map<string, ResolvedFile>>;
  /**
   * Read the folder a connected coding agent has open. Absent on a deployment
   * with no engine hub, which is what makes the repo tools disappear rather
   * than fail.
   */
  /** `lane` picks that lane's own folder when it has one, as a racing lane does. */
  readRepo?: (sid: string, req: RepoCall, lane?: string) => Promise<{ output: string; where?: { host: string; cwd: string; branch?: string } }>;
  /**
   * The workspace's allowance. Asked before each model call and told what the
   * call cost afterwards. Absent means no metering, which is what tests and a
   * single-tenant deployment want.
   */
  budget?: {
    check(workspaceId: string, model: string, sid?: string): Promise<{ ok: boolean; reason?: string }>;
    record(workspaceId: string, model: string, tokens: number): Promise<void>;
    /** Friday Pro's allowance in this window: whether the plan has it, how much is spent, and when it starts over (for Auto). */
    frontier?(workspaceId: string): Promise<{ allowed: boolean; used: number; limit: number; resetsAt?: number | null }>;
    /** What runs in this workspace have shown about each model (route-learning.ts). */
    learned?(workspaceId: string): Promise<Learned>;
    /** The step's tokens as the provider counted them, beside the coding tools' on the Usage page (see tool-usage.ts). */
    tokens?(workspaceId: string, usage: { prompt: number; completion: number; cached?: number }): void;
  };
  /**
   * Read each substantial finished run for its decisions, and file them. Off
   * unless asked for: it is one more model call per run.
   */
  decisionLog?: boolean;
  /**
   * Whether Friday's own agent works in this session at all; absent, it does. The open-source edition has no model of its
   * own, so there it is only a session on somebody's own model: anything else waits for a coding tool, as it did before.
   */
  works?: (state: SessionState) => boolean;
  maxSteps?: number;
}

interface Slot {
  rerun: boolean;
  stopped: boolean;
  controller: AbortController;
  preemptedBy: string;
}

/**
 * Runs the agent loop for a session, decoupled from any client connection:
 * closing a browser tab never stops the agent. It reads work from the log,
 * writes every step back to the log, and uses a Redis lease so only one node
 * runs a given session at a time.
 *
 * Preemption: pause, cancel, interrupting instructions and "deliver now" bump
 * the control epoch and abort the current step's controller. Every append the
 * runtime makes for a step is conditional on the epoch it started with, so
 * output from a preempted step can't land as if nothing happened.
 */
/** Session thinking mode → the provider's reasoning effort. */
const EFFORT: Record<string, string> = { fast: "low", balanced: "medium", deep: "high" };


/** Smallest gap between two trigger-driven runs of the same lane. */
const TRIGGER_COOLDOWN_MS = 5_000;

export class AgentRuntime {
  readonly nodeId = randomUUID();
  private active = new Map<string, Slot>();
  private idleWaiters: (() => void)[] = [];
  private closed = false;
  private maxSteps: number;
  /** Last time each lane was woken by a trigger, keyed `sid|lane`. */
  private lastFired = new Map<string, number>();
  /**
   * A lane that runs on a model of its own rather than the session's: a teammate on one of the person's own
   * models (teammates.ts, Arun, 2026-10-27: "be able to run your own models and stuff for teammates as well"). Its model, what it
   * is told with each run besides Friday's own prompt (who it is, its role, its memory), and tools of its own; null for any other
   * lane. Asked once a run, so a changed role or model applies from its next. Set by the app.
   */
  laneOwn: ((sid: string, lane: string) => Promise<{ model: string; note: string; tools?: AgentTool[] } | null>) | null = null;

  constructor(
    private store: SessionStore,
    private bus: Bus,
    private llm: LLM,
    private tools: AgentTool[],
    private opts: RuntimeOptions = {},
  ) {
    /**
     * How many steps one run may take.
     *
     * Forty was set when a step meant a search and a paragraph. A coding run
     * reads six files, edits three, runs the tests, reads the failure and
     * fixes it — that is twenty before anything interesting happens — and the
     * plan tool encourages finishing rather than stopping early, which costs
     * steps by design. The ceiling exists to stop a loop, not to stop work, so
     * it sits well above what real tasks use.
     */
    this.maxSteps = opts.maxSteps ?? (Number(process.env.AGENT_MAX_STEPS) || 200);
    bus.onWake((sid, lane) => void this.wake(sid, lane).catch((e) => console.error(`[runtime] wake ${sid}/${lane}:`, e)));
  }

  /** How many lanes have an agent working right now, for the admin console. */
  activeRuns(): number {
    return this.active.size;
  }

  async wake(sid: string, lane: string = MAIN_LANE): Promise<void> {
    if (this.closed) return;
    // One slot and one lease per lane, so lanes in the same session run at once
    // and an interrupt in one cannot abort another.
    const key = `${sid}|${lane}`;
    const running = this.active.get(key);
    if (running) {
      running.rerun = true;
      return;
    }
    const lease = this.store.keys(sid).runnerFor(lane);
    const got = await this.store.redis.set(lease, this.nodeId, "PX", LEASE_MS, "NX");
    // Shut down while the lease was being taken: shutdown has already waited for every run, so one started now would be
    // waited for by nobody, and its lease timer would keep the process from ever exiting. The lease runs out by itself.
    if (!got || this.active.has(key) || this.closed) return;

    const slot: Slot = { rerun: true, stopped: false, controller: new AbortController(), preemptedBy: "" };
    this.active.set(key, slot);

    const renew = setInterval(async () => {
      const ok = await this.store.redis.eval(RENEW_LUA, 1, lease, this.nodeId, LEASE_MS).catch(() => 0);
      if (!ok) {
        slot.stopped = true;
        slot.controller.abort(new Error("runner lease lost"));
      }
    }, LEASE_MS / 3);

    const unsub = await this.bus.subscribe(sid, (msg) => {
      if (msg.kind !== "event") return;
      // Taking an agent out of the session stops it where it stands. The step it is in must not finish
      // and post into a session it is no longer part of.
      if (msg.event.body.type === "lane.removed" && msg.event.body.laneId === lane) {
        slot.stopped = true;
        slot.controller.abort(new Error("that agent was removed from the session"));
        return;
      }
      // Every lane's events arrive here. Pausing, cancelling or interrupting one agent stops that agent:
      // it does not reach into the others' steps.
      if ((msg.event.lane ?? MAIN_LANE) !== lane) return;
      const b = msg.event.body;
      const who = msg.event.actor.name;
      let why = "";
      if (b.type === "run.pause") why = `${who} stopped this task`;
      else if (b.type === "run.cancel") why = `${who} cancelled the run`;
      else if (b.type === "run.interrupt") why = `${who} delivered queued instructions now`;
      else if (b.type === "instruction" && b.interrupt) why = `${who} interrupted with a new instruction`;
      if (why) {
        slot.preemptedBy = why;
        slot.controller.abort(new Error(why));
      }
    });

    let crashed = false;
    try {
      while (slot.rerun && !slot.stopped) {
        slot.rerun = false;
        await this.loop(sid, lane, slot);
      }
    } catch (err) {
      crashed = true;
      console.error(`[runtime] ${sid} crashed:`, err);
      await this.append(sid, lane, { type: "run.ended", outcome: "error", error: describe(err) }).catch(() => {});
    } finally {
      clearInterval(renew);
      await unsub();
      await this.store.redis.eval(RELEASE_LUA, 1, lease, this.nodeId).catch(() => {});
      this.active.delete(key);
      if (this.active.size === 0) this.idleWaiters.splice(0).forEach((f) => f());
      // A wake that arrived while this slot was winding down found it still registered, set `rerun` and went away, and the loop
      // above had already finished: that instruction would sit until something else woke the lane. Pick it up now.
      if (slot.rerun && !slot.stopped && !crashed && !this.closed) void this.wake(sid, lane).catch((e) => console.error(`[runtime] wake ${sid}/${lane}:`, e));
    }
  }

  /**
   * Every agent of one session running on this node stopped where it stands, resolving once each has wound down (or after
   * `ms`): for a session being deleted, so nothing it writes lands after it is gone. Those on other nodes stop on the
   * run.cancel and lane.removed they read, and anything they write after the session is buried is refused.
   */
  async stopSession(sid: string, why: string, ms = 10_000): Promise<void> {
    const here = () => [...this.active].filter(([k]) => k.startsWith(`${sid}|`));
    for (const [, s] of here()) {
      s.stopped = true;
      s.rerun = false;
      s.controller.abort(new Error(why));
    }
    for (const until = Date.now() + ms; here().length && Date.now() < until; ) await new Promise((r) => setTimeout(r, 50));
  }

  /** Resolves when no session is running on this node. */
  idle(): Promise<void> {
    return this.active.size === 0 ? Promise.resolve() : new Promise((r) => this.idleWaiters.push(r));
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const s of this.active.values()) {
      s.stopped = true;
      s.controller.abort(new Error("server shutting down"));
    }
    await this.idle();
  }

  private append(sid: string, lane: string, body: EventBody, guard?: AppendGuard): Promise<AppendResult> {
    return this.store.append(sid, AGENT, body, { ...guard, lane });
  }

  /**
   * The folder as it is before this run, so the run can be undone.
   *
   * Only when there is a folder, and never a reason not to run: a machine in
   * plan mode, a folder outside git or a slow link all just mean no undo for
   * this one. Bounded, because the run is what the person is waiting for.
   */
  /**
   * Whether this lane may run this command right now.
   *
   * Only a machine in Manual mode asks, and it is the machine the command will run on that decides: this lane's own
   * when it has one, otherwise the first connected one, which is also where the command is sent (see repoWhere and
   * hub.readRepo). The answer to an earlier question about this exact command is the answer: a yes lets it through, a
   * no says so, and a question nobody has answered yet is not asked a second time.
   *
   * Only a real yes is `approved`. A plain go means "this machine doesn't ask", and a Manual machine that receives a
   * command without the flag refuses it, so a mix-up about which machine this is fails closed.
   */
  private async commandGate(sid: string, lane: string, command: string): Promise<{ go: true; approved?: true; approvedBy?: string } | { go: false; output: string; endTurn?: boolean }> {
    const state = await this.store.state(sid);
    const where = repoWhere(state, lane);
    if (!where || where.uploaded || where.mode !== "edits") return { go: true };
    // A yes given in advance: the driver allowed this command earlier in the session. That list is the owners' say-so,
    // which stands for the host's only when the host is an owner; any other host is asked (see hub.readRepo).
    if (allowedCommand(state, command) && where.hostId && roleOf(state, where.hostId) === "owner") return { go: true, approved: true, approvedBy: where.hostId };
    // A person approves what they are shown, so the question carries the whole command and the yes is matched against
    // the whole of it. (It used to carry the first 600 characters and look for the whole, so a longer command was
    // asked about again after every yes, for ever.) Past what anybody would read on a card, it isn't put to them.
    if (command.length > MAX_ASKED) return { go: false, output: `That command is ${command.length} characters, too long to put to a person to read. Write it to a script file with write_file, then run the script (node script.mjs, python script.py, sh script.sh).` };
    const events = await this.store.events(sid);
    const asked = events.findLast((e) => e.body.type === "engine.approval" && (e.lane ?? MAIN_LANE) === lane && e.body.scope === "commands" && e.body.items.length === 1 && e.body.items[0] === command);
    if (asked && asked.body.type === "engine.approval") {
      const id = asked.body.id;
      const answer = events.find((e) => e.seq > asked.seq && e.body.type === "instruction" && e.body.approval?.id === id);
      if (answer && answer.body.type === "instruction") {
        return answer.body.approval!.approve ? { go: true, approved: true, approvedBy: answer.actor.id } : { go: false, output: "They said not to run that command. Do it another way, or ask them what they would rather." };
      }
      if (state.approvals[lane]?.id === id) return { go: false, output: "Still waiting for their answer about that command.", endTurn: true };
    }
    await this.append(sid, lane, { type: "engine.approval", id: randomBytes(4).toString("hex"), scope: "commands", items: [command] });
    return { go: false, output: "That command needs a person's approval first, and I've asked. Stop here: if they say yes it is run for you as soon as their answer arrives, and its output is the next thing you see. Don't run it again yourself.", endTurn: true };
  }

  /**
   * The folder and the command gate for one tool call. A yes the gate found goes with the command as who gave it, so a
   * Manual machine runs it only when that was its host (hub.readRepo). runApproved's re-run passes the answerer this way.
   */
  private repoTools(sid: string, lane: string) {
    let by: string | undefined;
    return {
      readRepo: (req: RepoCall) => this.opts.readRepo!(sid, req.approved ? { ...req, approvedBy: by } : req, lane),
      commandGate: async (command: string) => {
        const gate = await this.commandGate(sid, lane, command);
        by = gate.go ? gate.approvedBy : undefined;
        return gate;
      },
    };
  }

  /**
   * After a yes, run the call that asked, as it was made, before the model is called again.
   *
   * Without this, a yes started a new run whose first model call existed only to type the same command again, matched
   * on the exact string, and a second call read what it printed. Now the run picks up with the command already run:
   * the call is put back on the record under its own id with its result after it, the way any call is, so the model
   * sees "you asked to run this, here is what it printed" and goes on from there. The gate finds the yes and lets it
   * through, and anything that changed since (a machine now in Plan, a tool withheld) makes this do nothing, and the
   * model is left to read the answer itself.
   */
  private async runApproved(sid: string, lane: string, pending: number[], tools: Map<string, AgentTool>, guard: AppendGuard, run: (call: ToolCall, tool: AgentTool) => Promise<{ output: string; isError: boolean; interrupted?: boolean }>): Promise<void> {
    const events = await this.store.events(sid);
    const onLane = (e: SessionEvent) => (e.lane ?? MAIN_LANE) === lane;
    // Each yes runs its call once: a second yes to the same request, in this batch or after the call already ran, does nothing.
    const ran = new Set(events.flatMap((e) => (onLane(e) && e.body.type === "agent.message" ? e.body.toolCalls : [])).map((c) => c.id));
    for (const seq of pending) {
      const yes = events.find((e) => e.seq === seq);
      if (yes?.body.type !== "instruction" || !yes.body.approval?.approve) continue;
      const approvalId = yes.body.approval.id;
      if (ran.has(`approved-${approvalId}`)) continue;
      ran.add(`approved-${approvalId}`);
      const ask = events.find((e) => onLane(e) && e.body.type === "engine.approval" && e.body.id === approvalId && e.body.scope === "commands");
      if (!ask) continue;
      // The gate appends its question inside the tool call, just before that call's result: the first result after the question is the call's.
      const asked = events.find((e) => e.seq > ask.seq && onLane(e) && e.body.type === "tool.result");
      if (asked?.body.type !== "tool.result") continue;
      const callId = asked.body.callId;
      const call = events.flatMap((e) => (onLane(e) && e.body.type === "agent.message" ? e.body.toolCalls : [])).find((c) => c.id === callId);
      const tool = call && tools.get(call.name);
      if (!call || !tool) continue;
      const again: ToolCall = { id: `approved-${approvalId}`, name: call.name, arguments: call.arguments };
      if (!(await this.append(sid, lane, { type: "agent.message", text: "", toolCalls: [again] }, guard)).ok) return;
      const r = await run(again, tool);
      await this.append(sid, lane, { type: "tool.result", callId: again.id, name: again.name, output: r.output, isError: r.isError, ...(r.interrupted ? { interrupted: true } : {}) });
    }
  }

  /** What is not yet committed in this lane's folder: against HEAD, or the run's own checkpoint in a folder with no commits yet. */
  private async runDiff(sid: string, state: SessionState, lane: string): Promise<{ base: string; files: DiffFile[]; more?: string[] } | null> {
    const read = this.opts.readRepo;
    // As for a checkpoint: only where there is a folder to read, a machine that is online or an upload.
    if (!read || !(liveMachine(state, lane) || state.upload)) return null;
    // A folder borrowed from another lane's machine is that lane's: its runner reports what changed there, this lane's
    // work included. Measured from here too, a coding tool's edits made meanwhile would be listed as this agent's.
    if (!state.engines[lane] && !state.upload) return null;
    const ask = async (ref?: string) => {
      const r = await read(sid, { op: "diff", ...(ref ? { ref } : {}) }, lane);
      const j = JSON.parse(r.output) as { base?: string; files?: DiffFile[]; more?: string[]; error?: string };
      return Array.isArray(j.files) ? { base: j.base ?? ref ?? "HEAD", files: j.files, ...(Array.isArray(j.more) && j.more.length ? { more: j.more } : {}) } : null;
    };
    const head = await ask().catch(() => null);
    if (head) return head;
    const events = await this.store.events(sid);
    const started = events.findLast((e) => (e.lane ?? MAIN_LANE) === lane && e.body.type === "run.started");
    const cp = started && startCheckpoint(events, started);
    return cp ? ask(cp).catch(() => null) : null;
  }

  /**
   * Friday Pro's allowance for the session's workspace in this window. Unmetered (no meter, no workspace: tests, a deployment of
   * one's own) is unlimited, as everything else is there.
   */
  private async frontierFor(state: SessionState): Promise<{ allowed: boolean; used: number; limit: number }> {
    if (!state.workspaceId || !this.opts.budget?.frontier) return { allowed: true, used: 0, limit: Number.MAX_SAFE_INTEGER };
    return this.opts.budget.frontier(state.workspaceId).catch(() => ({ allowed: false, used: 0, limit: 0 }));
  }

  private async checkpoint(sid: string, state: SessionState, lane?: string): Promise<string | null> {
    if (!this.opts.readRepo || !(liveMachine(state, lane) || state.upload)) return null;
    const took = this.opts.readRepo(sid, { op: "checkpoint", query: "run" }, lane).then((r) => r.output.trim(), () => "");
    const sha = await Promise.race([took, new Promise<string>((r) => setTimeout(() => r(""), 8000).unref?.())]);
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }

  /** The session's tool list: shaped by session settings and, if set, the custom agent's choices. */
  /**
   * Friday's own agent also gets what the person has added themselves; a
   * custom agent gets exactly what its owner picked, and nothing else.
   */
  private async skillsForRun(state: SessionState, agent?: AgentSnapshot | null): Promise<SkillBrief[]> {
    const base = skillsFor(state, agent);
    if (agent ?? state.options.agent) return base;
    if (!this.opts.userSkills || !state.workspaceId) return base;
    const mine = await this.opts.userSkills(state.workspaceId, state.driver?.id ?? state.ownerId).catch(() => []);
    const have = new Set(base.map((b) => b.name.toLowerCase()));
    return [...base, ...mine.filter((m) => !have.has(m.name.toLowerCase()))];
  }

  private async toolsFor(state: SessionState, agent?: AgentSnapshot | null, lane: string = MAIN_LANE): Promise<AgentTool[]> {
    const at = (agent ?? state.options.agent)?.tools;
    // Auto searches where it may reach for Friday Pro, which is a plan that has it.
    const searchable = false; // Searching runs on Friday's key, which this edition hasn't got.
    // A session with somebody's CLI attached has a repo the hosted agent can
    // read; one without doesn't, and a tool that only ever answers "nobody is
    // connected" is worse than no tool.
    // A folder to work in is a machine someone connected, or a folder someone
    // uploaded — which is a working copy on our side, so the same tools reach
    // it. Without either there is nothing to point them at.
    // Connected, not merely reserved: an offline machine answers every repo
    // call with "that machine isn't connected", and an agent given six tools
    // that all say that concludes it has no code and asks the team to paste
    // the repo — which is exactly the thing these tools exist to avoid.
    const hasRepo = !!this.opts.readRepo && (!!liveMachine(state, lane) || !!state.upload);
    // And only as far as the mode its host chose: a tool that always answers
    // "this machine is in plan only mode" is a promise the agent can't keep.
    //
    // An upload has no host to choose a mode. It reaches everything up to
    // editing; the shell only when this deployment allows it, which is off
    // unless each session's folder is somewhere of its own. An agent is
    // never handed a tool that would refuse — being offered run_command and
    // told no is how a run turns into an argument with itself.
    // The machine this lane's commands go to, which is the one whose mode counts.
    const reach = !!liveMachine(state, lane)
      ? MODE_RANK[repoWhere(state, lane)?.mode ?? "plan"]
      : uploadsMayRun()
        ? MODE_RANK.full
        : MODE_RANK.edits;
    // Plan-first: reading is always fine; changing waits for the driver's approval of this run's plan.
    const hold = state.options.planFirst && !planApproved(state, lane);
    const tools = this.tools.filter((t) => {
      const needs = REPO_TOOLS[t.name];
      if (needs && hold && MODE_RANK[needs] > 0) return false;
      // On a Manual machine commands are offered too: each one asks first (see commandGate).
      // Left running on somebody's machine, never on Friday's server: only where a machine is connected, and where a command could be run at all.
      if (t.name === "run_background" || t.name === "read_background" || t.name === "stop_background") return hasRepo && !!liveMachine(state, lane) && reach >= MODE_RANK.edits;
      // The dev server is a command too, and on a Manual machine it is asked about the same way.
      if (t.name === "run_command" || t.name === "show_preview") return hasRepo && (reach >= MODE_RANK.full || (reach >= MODE_RANK.edits && !!liveMachine(state, lane)));
      if (needs) return hasRepo && reach >= MODE_RANK[needs];
      // The codebase in front of the agent is the source of truth, so search is
      // only there when the session asks for it.
      // Searching the web is for frontier models (and for coding tools, which are not run from here): Friday's everyday model does without.
      if (t.name === "web_search") return searchable && state.options.webSearch && (at?.webSearch ?? true);
      // Reading a page you were given the URL of is the same permission as
      // searching, minus the reason a coding session doesn't search: a linked
      // changelog or API reference is exactly what it needs.
      if (t.name === "fetch_url") return searchable && state.options.webSearch && (at?.webSearch ?? true);
      if (t.name === "ask_human") return at?.askHuman ?? true;
      // Handing off needs somebody to hand to.
      if (t.name === "hand_off") return state.lanes.length > 0;
      // So does talking to another agent here.
      if (t.name === "list_agents" || t.name === "message_agent" || t.name === "ask_agent" || t.name === "reply_to_agent") return !!this.opts.mesh && state.lanes.length > 0;
      // Only an agent with a team has anyone to deploy, and a specialist never does.
      if (t.name === "deploy_agent") return !!(agent ?? state.options.agent)?.subagents?.length;
      // Other sessions are only there to reach when the server says how to reach them.
      if (t.name === "list_sessions" || t.name === "read_session" || t.name === "message_session") return false;
      // A hub is the main agent's to start, in a session with a folder on a machine to work in.
      if (t.name === "start_hub") return !!this.opts.startHub && lane === MAIN_LANE && hasRepo && Object.values(state.engines).some((e) => e.cwd);
      return true;
    });
    const briefs = await this.skillsForRun(state, agent);
    if (briefs.length) tools.push(useSkillTool(briefs));
    const allow = at?.connections ?? "all";
    if (!state.options.mcp || allow === "none") return tools;
    const extra = await (this.opts.extraTools?.(state.workspaceId) ?? Promise.resolve([])).catch(() => []);
    const offered = extra.filter((t) => allow === "all" || allow.some((id) => t.name.startsWith(`mcp__${id}__`)));

    /**
     * A code host is only a tool when the code is on one.
     *
     * Working in a plain folder — an upload, a directory somebody lent — an
     * agent handed GitHub tools goes looking for the files there: it searches
     * repositories for names it saw locally, reads them back from a default
     * branch, and answers about code that isn't the code in front of it. The
     * folder is the source of truth, and a tool that offers a second, wrong
     * one is worse than not having it.
     *
     * A lane set up for a repo, or a checkout on a branch, is the case where
     * the host genuinely is part of the work. So is an agent whose connections
     * were named one by one, because that was somebody saying so.
     */
    const onCodeHost = Object.values(state.engines).some((e) => !!e.repo || !!e.branch);
    const namedByHand = Array.isArray(allow);
    return [...tools, ...(onCodeHost || namedByHand ? offered : offered.filter((t) => !CODE_HOST.test(t.name)))];
  }

  /** Attachments on instructions the agent has seen, loaded for the context window. */
  private async filesFor(sid: string, events: SessionEvent[]): Promise<Map<string, ResolvedFile>> {
    if (!this.opts.resolveFiles) return new Map();
    const delivered = new Set<number>();
    for (const e of events) if (e.body.type === "instructions.delivered") e.body.seqs.forEach((s) => delivered.add(s));
    const atts = events.flatMap((e) => (e.body.type === "instruction" && delivered.has(e.seq) ? (e.body.attachments ?? []) : []));
    // Files from a folder are not pasted into the context: six hundred of them
    // would cost more than the task and bury the message they arrived with.
    // They are on disk as a working copy, and the agent opens the ones it
    // needs the way anybody does. A file attached on its own still comes
    // inline — that one was handed over to be read.
    const loose = atts.filter((a) => !a.name.includes("/"));
    return loose.length ? this.opts.resolveFiles(sid, loose) : new Map();
  }

  private async loop(sid: string, lane: string, slot: Slot): Promise<void> {
    // Tools that have failed for an account reason, for the length of this run.
    const broken = new Map<string, string>();
    /**
     * What this run has already asked for, and what came back.
     *
     * Models loop. Not usually because anything is broken — they read the
     * folder, think, and decide to start by reading the folder — and every
     * turn of it costs a model call, an event in everyone's feed, and a step
     * out of the run's budget. The answer it already has is handed back
     * instead of being fetched again, which breaks the loop by making it free
     * and obvious rather than by guessing at intent.
     */
    const seen = new Map<string, { output: string; isError: boolean; times: number }>();
    // How many times this run has been told to finish what it started. Bounded:
    // an agent that won't continue after three reminders has a reason we can't
    // see from here, and looping on it spends someone's allowance to no end.
    let nudges = 0;
    let announced = 0;
    // Turns in a row spent only reading, and whether it has already been told
    // once to stop and act. Reset by writing a plan or changing anything.
    let exploreStreak = 0;
    // Reading is switched off until a plan is written, and how often that has happened.
    let planGate = false;
    let gates = 0;
    // Where this run began, so a plan left over from an earlier one is not
    // mistaken for work this run agreed to do.
    let startedAt = 0;
    // Read once per run: it changes between sessions, not between steps.
    let recalled: string | undefined;
    let pinned: string | undefined;
    let rules: string | undefined;
    // The last step's prompt size: the next step opens with the same text, plus what was just added.
    let lastPrompt = 0;
    // What the run's task reads as (routing.ts), read again when new instructions come; steps in a row whose tools failed; and
    // the last pick said in the log, so a pick is said when it changes rather than every step.
    let tier: ReturnType<typeof taskTier> | null = null;
    let learned: Learned = {};
    let failing = 0;
    let routed = "";
    // A lane on a model of its own rather than the session's, read once a run: undefined until it is asked, and never in an
    // edition with nothing to ask.
    let laneRun: { model: string; note: string; tools?: AgentTool[] } | null | undefined;
    for (let step = 0; step < this.maxSteps; step++) {
      if (slot.stopped) return;
      // New controller *before* reading the epoch: a preemption after this
      // point aborts this step; one before it shows up in the epoch.
      const controller = (slot.controller = new AbortController());
      slot.preemptedBy = "";
      const { epoch } = await this.store.control(sid, lane);
      // A copy of the cached state, not a fold of the whole log: this step holds it across awaits, and the cache's own moves on.
      const state = structuredClone(await this.store.state(sid));

      // A lane's run state is its own; only the main lane consumes the queue of
      // human instructions. A standing lane is woken by a trigger and just runs.
      const laneDef = laneOf(state, lane);
      // A lane that is no longer in the session has nothing left to do.
      if (lane !== MAIN_LANE && !laneDef) return;
      const run = runOf(state, lane);
      if (run.status === "paused") return;
      // Someone's local CLI owns this lane; its runner does the work, even while
      // offline, so instructions wait for it rather than going to a different agent.
      // A folder lent with no CLI is the opposite: the machine is there to be
      // worked in, and Friday's own agent is the one doing the working.
      if (state.engines[lane]?.tool) return;
      // A coding tool's lane whose runner is still starting: what is typed meanwhile waits for it, as it would while offline.
      if (laneDef?.engine && !state.engines[lane]) return;
      // Its own model, only ever its owner's (as allowedModel has it for a session's): another person's is never run here.
      if (laneRun === undefined) laneRun = lane !== MAIN_LANE && this.laneOwn ? await this.laneOwn(sid, lane).catch(() => null) : null;
      if (laneRun && !(isOwnModel(laneRun.model) && ownModelParts(laneRun.model)?.owner === state.ownerId)) laneRun = null;
      // In its own folder only: with its runner gone, another lane's lent folder would otherwise be borrowed (liveMachine), and its
      // work land in a teammate's folder. What it is given waits for it to be back, as a coding tool's does.
      if (laneRun && !state.engines[lane]?.online) return;
      // A lane on its own model works whatever the session's model is.
      if (this.opts.works && !laneRun && !this.opts.works(state)) return;
      // A lane with a trigger runs when woken; only a manual lane needs a queue.
      const automated = !!laneDef && laneDef.trigger.kind !== "manual";
      const pending = pendingFor(state, lane);
      // An automated lane has no queue: being woken is what starts it, and it
      // finishes when its turn produces no tool calls.
      if (pending.length === 0 && run.status !== "running" && !automated) return;

      const guard: AppendGuard = { expectEpoch: epoch, lane };
      if (!startedAt) startedAt = runOf(state, lane).sinceSeq;
      if (run.status !== "running") {
        const checkpoint = await this.checkpoint(sid, state, lane);
        // The start and what it delivers in one write, as the hub's: a run's start takes its cause out of the queue (projection),
        // so a delivery refused after it on its own would have lost that message.
        const start: EventBody[] = [{ type: "run.started", causedBy: pending[0] ?? state.lastSeq, ...(checkpoint ? { checkpoint } : {}) }, ...(pending.length ? [{ type: "instructions.delivered" as const, seqs: pending }] : [])];
        if (!(await this.store.appendAll(sid, AGENT, start, { ...guard, lane })).ok) continue;
      } else if (pending.length && !(await this.append(sid, lane, { type: "instructions.delivered", seqs: pending }, guard)).ok) continue;

      const agent = laneDef ? laneDef.agent : state.options.agent;
      // A lane on its own model may bring tools of its own besides, unless Friday's own has one by that name.
      const base = await this.toolsFor(state, agent, lane);
      const offered = laneRun?.tools?.length ? [...base, ...laneRun.tools.filter((t) => !base.some((b) => b.name === t.name))] : base;
      const tools = planGate ? offered.filter((t) => PLAN_TOOLS.has(t.name)) : offered;
      // Same rule as the tool list: a connected machine, or a folder somebody
      // uploaded. The two had drifted apart, which offered the repo tools and
      // then told the agent in the same breath that it had no folder.
      const hasRepo = !!this.opts.readRepo && (!!liveMachine(state, lane) || !!state.upload);
      const toolMap = new Map(tools.map((t) => [t.name, t]));
      if (pending.length) await this.runApproved(sid, lane, pending, toolMap, guard, (call, tool) => this.runTool(sid, lane, call, tool, controller.signal, slot, [...toolMap.keys()], broken, seen));
      const events = await this.store.events(sid);
      const files = await this.filesFor(sid, events);
      // The lane's own model, when it has one (laneRun), else the session's: the one asked whether it sees pictures, and run.
      const chosen = laneRun?.model ?? state.options.model;
      const images = files.size ? await (this.llm.supportsImages?.(laneRun?.model) ?? Promise.resolve(false)).catch(() => false) : false;

      // ── which model (routing.ts) ──────────────────────────────────
      // On Auto, the step runs what the router picks; otherwise the session's model, and the pick is only logged (`shadow`). Not for
      // somebody's own model, which is theirs to run.
      const own = isOwnModel(chosen);
      if (!own && (pending.length || !tier)) {
        const said = events.filter((e) => e.body.type === "instruction" && pending.includes(e.seq)).map((e) => e.body as Extract<EventBody, { type: "instruction" }>);
        const text = said.map((b) => b.text).join("\n\n") || state.title;
        tier = taskTier(text, { planFirst: state.options.planFirst, attachments: said.reduce((n, b) => n + (b.attachments?.length ?? 0), 0), linked: !!(state.options.issue || state.options.pr) });
        learned = state.workspaceId && this.opts.budget?.learned ? await this.opts.budget.learned(state.workspaceId).catch(() => ({})) : {};
      }
      const auto = isAuto(chosen);
      const pick = !own && tier ? routeFriday({ tier: tier.tier, tierWhy: tier.why, exploring: exploreStreak, failing, frontier: await this.frontierFor(state), learned }) : null;
      const model = auto && pick ? pick.model : chosen;
      const effort = auto && pick ? pick.effort : (EFFORT[state.options.thinking] ?? EFFORT.balanced);

      // ── model call ────────────────────────────────────────────────
      let partial = "";
      // Tagged with the lane, so two agents typing at once are two streams and not one jumbled one.
      const deltas = batcher((t) => void this.bus.publish(sid, { kind: "delta", text: t, ...(lane !== MAIN_LANE ? { lane } : {}) }));
      const thoughts = batcher((t) => void this.bus.publish(sid, { kind: "delta", text: t, channel: "reasoning", ...(lane !== MAIN_LANE ? { lane } : {}) }));
      // Out of allowance is a normal end to a run, not a crash: the room is
      // told why, and the log says it, so nobody is left watching a spinner.
      if (this.opts.budget && state.workspaceId) {
        // Ask about the model the session is set to, which is the one about to
        // run. What the provider reports back is what actually gets charged.
        const allowed = await this.opts.budget.check(state.workspaceId, model, sid).catch(() => ({ ok: true, reason: undefined }));
        if (!allowed.ok) {
          await this.append(sid, lane, { type: "run.ended", outcome: "error", error: allowed.reason ?? "This workspace has used its allowance for today." }, guard);
          return;
        }
      }
      if (pick && tier && `${pick.model}|${pick.effort}` !== routed) {
        routed = `${pick.model}|${pick.effort}`;
        // Said without the step waiting on it: the model call starts at once, as it did before there was a pick to say.
        void this.append(sid, lane, { type: "model.routed", model: pick.model, effort: pick.effort, tier: tier.tier, why: pick.why, room: pick.frontierLeft, ...(auto ? {} : { shadow: true, current: chosen }) }).catch(() => {});
      }

      let completion: Completion;
      try {
        // Told about the repo only when one is genuinely reachable, so it
        // never offers to read code that isn't there.
        const system = systemPrompt(
          state.title,
          agent,
          repoWhere(state, lane),
          await this.skillsForRun(state, agent),
          tools.map((t) => t.name),
          (recalled ??= await this.recallFor(sid, state, lane)),
          { planFirst: state.options.planFirst, approved: planApproved(state, lane), autoTest: state.options.autoTest },
          (pinned ??= await this.pinsText(sid, state, lane)),
          (rules ??= await this.rulesText(sid, state, lane)),
        ) + (laneRun?.note ? `\n\n${laneRun.note}` : "");
        // Paused, cancelled or interrupted while the step was being put together: no call at all. A call on a signal that
        // is already aborted fails at once with most providers, but an own model reached through someone's computer, or a
        // coding tool started as a process, could still go ahead. The next turn of the loop sees why it stopped. Asked of the log
        // as well as the controller: the bus that aborts it can arrive a moment after the pause is written.
        if (controller.signal.aborted || runOf(await this.store.state(sid), lane).status !== "running") continue;
        completion = await this.llm.complete({
          // The workspace is who is asking, so a shared key can be paced fairly between workspaces.
          caller: state.workspaceId || sid,
          system,
          messages: buildContext(events, {
            files,
            images,
            lane,
            inherits: upstreamOf(state, lane),
            memory: state.memory,
            contended: [...collisionsFor(state, lane).map((c) => collisionLine(state, c, lane)), ...plannedOverlapsFor(state, lane).map(plannedOverlapLine)],
          }),
          tools: toolSchemas(tools),
          // "" means the workspace default, which is what the provider fills in.
          ...(model ? { model } : {}),
          reasoningEffort: effort,
          signal: controller.signal,
          onDelta: (t) => {
            partial += t;
            deltas.push(t);
          },
          onReasoning: (t) => thoughts.push(t),
        });
      } catch (err) {
        deltas.flush();
        thoughts.flush();
        if (controller.signal.aborted) {
          if (partial.trim()) await this.append(sid, lane, { type: "agent.message", text: partial, toolCalls: [], interrupted: true });
          continue;
        }
        const r = await this.append(sid, lane, { type: "run.ended", outcome: "error", error: describe(err) }, guard);
        if (r.ok) return;
        continue;
      }
      deltas.flush();
      thoughts.flush();

      const committed = await this.append(
        sid,
        lane,
        { type: "agent.message", text: completion.text, toolCalls: completion.toolCalls, reasoning: completion.reasoning, ...(completion.usage ? { tokens: completion.usage.total } : {}) },
        guard,
      );
      if (!committed.ok) {
        // Preempted between generation and commit. Keep the text for the record;
        // drop the tool calls, which never ran.
        if (completion.text.trim()) {
          await this.append(sid, lane, { type: "agent.message", text: completion.text, toolCalls: [], interrupted: true });
        }
        continue;
      }

      if (completion.toolCalls.length === 0) {
        const events = await this.store.events(sid);
        if (pendingFor(await this.store.state(sid), lane).length) continue;
        // A model that stops mid-plan usually stops for no reason it could
        // defend — it wrote the steps itself and three of them are still
        // pending. Say so once and let it carry on, rather than leaving the
        // person to type "continue" at something that already knows.
        const left = unfinishedPlan(events, lane, startedAt);
        if (left && nudges < MAX_NUDGES) {
          nudges++;
          await this.append(sid, lane, {
            type: "tool.result",
            callId: `continue-${nudges}`,
            name: "update_plan",
            isError: false,
            output: `Your plan still has ${left} step${left === 1 ? "" : "s"} to do, and nobody has asked you to stop. Carry on with the next one now, and keep going until the task is fully done.${state.lanes.length ? " When you finish a piece the other agents build on, post_update a line so they know where you are." : ""} If a step can't be done, mark it cancelled with update_plan and say why — don't leave it open. If the work really is finished, call update_plan once more with every step completed, and then answer.`,
          });
          continue;
        }
        // The reply ends on "Let me look at…" and nothing follows. Plan-first
        // is the exception: stopping there, after the plan, is the instruction.
        const holding = state.options.planFirst && !planApproved(state, lane);
        if (!holding && announced < MAX_ANNOUNCED && announcesAction(completion.text)) {
          announced++;
          await this.append(sid, lane, {
            type: "tool.result",
            callId: `announced-${announced}`,
            name: "continue",
            isError: false,
            output: "You said what you would do next, but the turn ended before you did it. Do it now with the right tool, and keep going until the task you were given is finished. If it already is, say so plainly and give the result.",
          });
          continue;
        }
        // What the run changed, recorded before it ends, as a coding tool's runner does: the change shows on its card and in the
        // Diff panel, and can be read by the second review.
        const changed = await this.runDiff(sid, state, lane).catch(() => null);
        if (changed && (changed.files.length || state.diffs[lane]?.files.length)) await this.append(sid, lane, { type: "agent.diff", base: changed.base, files: changed.files, ...(changed.more ? { more: changed.more } : {}) }, guard);
        const finished = await this.append(sid, lane, { type: "run.ended", outcome: "done" }, guard);
        if (finished.ok) {
          // After the run is over and in the background: nobody waits on this.
          if (this.opts.decisionLog) void this.learn(sid, lane, startedAt, finished.seq).catch(() => {});
          this.fire(sid, state.lanes, lane, "lane-finished");
          return;
        }
        continue;
      }

      // ── tools ─────────────────────────────────────────────────────
      let endTurn = false;
      let failed = false;
      for (const call of completion.toolCalls) {
        const result = controller.signal.aborted
          ? { output: `Not run: ${slot.preemptedBy || "the step was interrupted"}.`, isError: true, interrupted: true }
          : await this.runTool(sid, lane, call, toolMap.get(call.name), controller.signal, slot, [...toolMap.keys()], broken, seen);
        if (result.isError && !result.interrupted) failed = true;
        await this.append(sid, lane, {
          type: "tool.result",
          callId: call.id,
          name: call.name,
          output: result.output,
          isError: result.isError,
          ...(result.interrupted ? { interrupted: true } : {}),
        });
        if (result.endTurn) endTurn = true;
      }

      // A run that has asked the same thing ten times — after being told at the
      // third — is not going to get a different answer on the eleventh.
      const stuck = [...seen.values()].find((x) => x.times >= 10);
      if (stuck && !controller.signal.aborted) {
        if (
          (
            await this.append(
              sid,
              lane,
              { type: "run.ended", outcome: "error", error: "The agent kept asking for the same thing and stopped making progress, so the run was stopped. Say what to do next and it will pick up from here." },
              guard,
            )
          ).ok
        ) {
          return;
        }
      }

      failing = failed ? failing + 1 : 0;
      exploreStreak = completion.toolCalls.length && completion.toolCalls.every((c) => EXPLORE_ONLY.has(c.name)) ? exploreStreak + 1 : 0;
      // A plan is what was owed: reading is allowed again, and the count starts over.
      if (planGate && completion.toolCalls.some((c) => c.name === "update_plan")) {
        planGate = false;
        exploreStreak = 0;
      }
      if (exploreStreak >= (planGate ? EXPLORE_GATED_LIMIT : EXPLORE_STREAK_LIMIT) && !controller.signal.aborted && !endTurn) {
        if (planGate || gates >= MAX_PLAN_GATES) {
          if (
            (
              await this.append(
                sid,
                lane,
                {
                  type: "run.ended",
                  outcome: "error",
                  error: "This kept reading the code instead of making a plan, even with nothing else to do. The task is probably too broad to act on as given — say specifically what to change, or ask it to propose a plan first.",
                },
                guard,
              )
            ).ok
          ) {
            return;
          }
        } else {
          gates++;
          planGate = true;
          exploreStreak = 0;
          await this.append(sid, lane, {
            type: "tool.result",
            callId: "explore-nudge",
            name: "update_plan",
            isError: false,
            output:
              "You've read a lot and haven't planned yet, so reading is switched off until you do. Call update_plan now with the concrete steps you'll take from what you already know — three to seven, in order. Then the tools come back and you work the plan. If the task is genuinely too broad to plan, say so and use ask_human for what to start on.",
          });
        }
      }
      if (endTurn && !controller.signal.aborted) {
        if ((await this.append(sid, lane, { type: "run.ended", outcome: "waiting" }, guard)).ok) {
          this.fire(sid, state.lanes, lane, "question");
          return;
        }
      }
    }

    // Not a crash, and saying "stopped after 40 steps" as if it were one told
    // people a number they can do nothing with. What is useful is that the
    // work so far is real, and that saying "carry on" picks it up.
    await this.append(sid, lane, {
      type: "run.ended",
      outcome: "error",
      error: `This run reached its ${this.maxSteps}-step limit before finishing. Everything it did up to here stands — the files and the commands. Send "carry on" to continue from where it stopped, or a narrower instruction if it was going in circles.`,
    });
  }

  /**
   * Wakes every lane whose trigger matches something that just happened.
   *
   * Two rules keep automation from running away: a lane is never woken by its
   * own activity, and a lane can only be trigger-woken once per cooldown. Both
   * matter because triggers can chain — a lane finishing can start another.
   */
  private fire(sid: string, lanes: Lane[], from: string, kind: LaneTrigger["kind"]): void {
    for (const l of lanes) {
      if (l.id === from || l.trigger.kind !== kind) continue;
      if (kind === "lane-finished" && l.trigger.kind === "lane-finished" && l.trigger.laneId && l.trigger.laneId !== from) continue;
      const key = `${sid}|${l.id}`;
      const last = this.lastFired.get(key) ?? 0;
      // ponytail: a flat cooldown, not a per-trigger budget. If a lane needs to
      // react faster than this, give triggers their own rate config.
      if (Date.now() - last < TRIGGER_COOLDOWN_MS) continue;
      this.lastFired.set(key, Date.now());
      void this.bus.wake(sid, l.id);
    }
  }

  /**
   * Queue work on another lane as a handoff from this one.
   *
   * Written as the agent, under the same lane rules as a person's handoff: a
   * lane someone else steers is theirs, and an agent can't go around that by
   * handing work to it. What stops a loop is the same as any instruction — the receiving agent
   * has to decide to hand it back, and every hop is in the log with its reason.
   */
  async handOff(sid: string, from: string, req: { to: string; reason: string; carried: string[]; task: string }) {
    return handOff(this.store, this.bus, sid, from, req);
  }

  /**
   * Put one of this agent's specialists to work.
   *
   * The specialist gets a lane of its own — added as the agent, since the owner
   * gave it this team when they built it — and then the task as a handoff, so
   * the log shows who asked for what and why. A specialist already in the
   * session is reused rather than added twice.
   */
  private async deploy(sid: string, from: string, req: { agent: string; reason: string; carried: string[]; task: string }) {
    const state = await this.store.state(sid);
    const lead = from === MAIN_LANE ? state.options.agent : laneOf(state, from)?.agent;
    const want = req.agent.trim().toLowerCase();
    const sub = lead?.subagents?.find((s) => s.name.toLowerCase() === want || s.id === req.agent.trim());
    if (!sub) {
      const names = (lead?.subagents ?? []).map((s) => s.name);
      return { ok: false as const, error: `${req.agent ? `"${req.agent}" isn't on your team.` : "Say which specialist."} Your team: ${names.join(", ") || "nobody"}.` };
    }
    let lane = state.lanes.find((l) => l.agent?.id === sub.id);
    const reused = !!lane;
    if (!lane) {
      if (state.lanes.length >= SESSION_LANES) return { ok: false as const, error: `The session already runs as many agents as it can (${SESSION_LANES}). Do this piece yourself, or hand it to one that is already here.` };
      lane = { id: `l${randomBytes(4).toString("base64url")}`, name: sub.name.slice(0, 40), agent: sub, control: { kind: "open" }, controlMode: "ask", trigger: { kind: "manual" } };
      const added = await this.append(sid, from, { type: "lane.added", lane });
      if (!added.ok) return { ok: false as const, error: "Could not add that specialist." };
    }
    const r = await this.handOff(sid, from, { to: lane.id, reason: req.reason, carried: req.carried, task: req.task });
    return r.ok ? { ok: true as const, name: lane.name, reused } : r;
  }

  /**
   * File what a finished run settled: its decisions, constraints and dead ends.
   *
   * Written into the session as notes marked as filed automatically, and kept
   * for the whole workspace, so the next session — and anyone who asks why
   * something is the way it is — finds them without anybody having maintained a
   * document. Never throws into the run: the work is done either way.
   */
  private async learn(sid: string, lane: string, sinceSeq: number, endSeq: number): Promise<void> {
    const events = await this.store.events(sid);
    const { text, tools } = transcriptOf(events, lane, sinceSeq);
    if (tools < MIN_TOOL_CALLS || !text.trim()) return;
    const state = project(sid, events);
    // Read by the model that did the work when it is somebody's own: their key, not Friday's, for their run.
    const found = await extractDecisions(this.llm, text, new AbortController().signal, isOwnModel(state.options.model) ? state.options.model : undefined);
    const have = new Set(events.flatMap((e) => (e.body.type === "memory.saved" ? [e.body.text] : [])));
    const owner = { id: state.ownerId, name: state.members[state.ownerId]?.name ?? "" };
    for (const d of found) {
      if (have.has(d.text)) continue;
      await this.append(sid, lane, { type: "memory.saved", key: d.key, text: d.text, auto: true, at: endSeq });
      // The sample project's lessons are about the sample: kept in its session, not filed for the workspace's real work.
      if (state.workspaceId && state.title !== SAMPLE_TITLE) await this.opts.saveMemory?.(state.workspaceId, owner, `${d.text} (from “${state.title}”)`, "workspace").catch(() => {});
    }
  }

  /** What is remembered about the person and the workspace, and what the team learned on this repo: background, read once a run. */
  private async recallFor(sid: string, state: SessionState, lane: string): Promise<string> {
    const ws = state.workspaceId;
    if (!ws) return "";
    const [memory, brain] = await Promise.all([
      this.opts.recall?.(ws, state.driver?.id ?? state.ownerId).catch(() => "") ?? "",
      this.opts.brief?.(ws, sid, lane, state.lastInstruction?.text ?? "").catch(() => "") ?? "",
    ]);
    return [memory, brain.trim()].filter(Boolean).join("\n\n");
  }

  /** The project's AGENTS.md and CLAUDE.md, read now, when there is a folder to read them from. */
  private async rulesText(sid: string, state: SessionState, lane?: string): Promise<string> {
    if (!this.opts.readRepo || !(liveMachine(state, lane) || state.upload)) return "";
    // From the folder the prompt describes, which is the one this lane's commands run in.
    const read = (path: string) => this.opts.readRepo!(sid, { op: "read", path, raw: true }, lane).catch(() => null);
    // All at once: each is a question put to somebody's machine, and the run waits on the slowest rather than on the sum.
    const [named, legacy, listing] = await Promise.all([
      Promise.all(RULE_FILES.map(async (path) => ({ path, r: await read(path) }))),
      read(CURSOR_RULES_FILE),
      this.opts.readRepo(sid, { op: "tree", path: CURSOR_RULES_DIR }, lane).catch(() => null),
    ]);
    const files: { path: string; text: string }[] = [];
    for (const { path, r } of named) if (r?.output && !isMissing(r.output)) files.push({ path, text: r.output });
    // Cursor's rules too: a team on Cursor keeps its conventions there, and they should hold whichever agent is doing the work.
    if (legacy?.output && !isMissing(legacy.output)) files.push({ path: CURSOR_RULES_FILE, text: cursorRuleText(legacy.output) });
    const rules = await Promise.all((listing ? cursorRuleFiles(listing.output) : []).map(async (path) => ({ path, r: await read(path) })));
    for (const { path, r } of rules) if (r?.output && !isMissing(r.output)) files.push({ path, text: cursorRuleText(r.output) });
    return rulesBlock(files);
  }

  /** The pinned files, read now: capped so a pin cannot cost more than the task. */
  private async pinsText(sid: string, state: SessionState, lane?: string): Promise<string> {
    if (!state.pins.length || !this.opts.readRepo) return "";
    const out: string[] = [];
    let budget = 60_000;
    for (const path of state.pins) {
      if (budget <= 0) break;
      const dir = path.endsWith("/");
      const r = await this.opts.readRepo(sid, { op: dir ? "tree" : "read", path }, lane).catch(() => null);
      const text = r?.output?.trim();
      if (!text) continue;
      const cut = text.slice(0, Math.min(20_000, budget));
      budget -= cut.length;
      out.push(`--- ${path}${dir ? " (folder)" : ""} ---\n${cut}${cut.length < text.length ? "\n[…cut]" : ""}`);
    }
    return out.join("\n\n");
  }

  private async runTool(
    sid: string,
    lane: string,
    call: ToolCall,
    tool: AgentTool | undefined,
    runSignal: AbortSignal,
    slot: Slot,
    available: string[] = [],
    /** Tools that failed for a reason no retry can fix, this run. */
    broken?: Map<string, string>,
    /** What this run has already asked for, so it isn't asked twice. */
    seen?: Map<string, { output: string; isError: boolean; times: number }>,
  ): Promise<{ output: string; isError: boolean; interrupted?: boolean; endTurn?: boolean }> {
    // A tool whose account is out of credits fails the same way every time, so
    // the second call is waste and the eighth is farce. Once one fails for a
    // reason no retry can fix, say so and keep saying so — cheaply.
    const dead = broken?.get(call.name);
    if (dead) return { output: `${dead} It will not work for the rest of this run, so don't call it again — do what you can without it, and say plainly what you could not check.`, isError: true };
    // Say what there is. A bare "unknown tool" leaves a model guessing at
    // names, and a model guessing at names guesses fifteen times.
    if (!tool)
      return {
        output: `There is no tool called "${call.name}" in this session.${available.length ? ` The tools you have are: ${available.join(", ")}. Nothing else exists here, so don't try another name — do the work with these or say what you can't do without it.` : ""}`,
        isError: true,
      };
    let args: Record<string, unknown>;
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {};
    } catch {
      return { output: `Arguments were not valid JSON: ${call.arguments.slice(0, 200)}`, isError: true };
    }
    // Asked and answered. Only for tools that just look at something: a
    // command, an edit or a question to a person is a different act each time
    // it is made, however identical the arguments.
    const key = `${call.name}\u0000${JSON.stringify(args)}`;
    const before = REPEATABLE.has(tool.name) ? undefined : seen?.get(key);
    const firm = (times: number) => (times >= 3 ? " You have now asked this several times. Stop looking and act on it: make the change, run the check, or tell the person what is blocking you." : "");
    // A read of the folder is cheap to make again, and the folder can change under it without a tool of this run's
    // touching it: a watcher or a build started in the background, an install, another lane, the person's own editor.
    // So it is made again, and only an answer that came back the same counts as a repeat.
    const local = REPO_TOOLS[tool.name] === "plan";
    if (before && !local) {
      before.times++;
      return {
        output: `You already ran this exact call in this run, and this is what it returned. Use it — running it again will not tell you anything new.${firm(before.times)}\n\n${before.output}`,
        isError: before.isError,
      };
    }

    const signal = tool.cancellable ? runSignal : new AbortController().signal;
    try {
      const r = await tool.run(
        args,
        {
          sid,
          lane,
          signal,
          llm: this.llm,
          state: (): Promise<SessionState> => this.store.state(sid),
          append: (body) => this.append(sid, lane, body),
          handOff: (req) => this.handOff(sid, lane, req),
          ...(this.opts.mesh ? { mesh: { call: (name: string, args: Record<string, unknown>, sig?: AbortSignal) => this.opts.mesh!.call(sid, lane, name, args, sig) } } : {}),
          deployAgent: (req) => this.deploy(sid, lane, req),
          ...(this.opts.startHub ? { startHub: (goal: string) => this.opts.startHub!(sid, lane, goal) } : {}),
          ...(this.opts.saveMemory
            ? {
                saveMemory: async (text: string, scope: "personal" | "workspace") => {
                  const st = await this.store.state(sid);
                  const who = st.driver ?? { id: st.ownerId, name: st.members[st.ownerId]?.name ?? "" };
                  return this.opts.saveMemory!(st.workspaceId, { id: who.id, name: who.name }, text, scope);
                },
              }
            : {}),
          ...(this.opts.skillBrief
            ? {
                skillBrief: async (id: string, owner: string, collection?: string) => {
                  const st = await this.store.state(sid);
                  return this.opts.skillBrief!(st.workspaceId, id, owner, collection);
                },
              }
            : {}),
          ...(this.opts.importSkills
            ? {
                importSkills: async (req: { url: string; only?: string[] }) => {
                  const st = await this.store.state(sid);
                  const who = st.driver ?? { id: st.ownerId, name: st.members[st.ownerId]?.name ?? "" };
                  return this.opts.importSkills!(st.workspaceId, { id: who.id, name: who.name }, req);
                },
              }
            : {}),
          ...(this.opts.readRepo ? this.repoTools(sid, lane) : {}),
        },
        call.id,
      );
      // Anything that can change the workspace makes every earlier answer stale:
      // reading a file again after editing it is not a repeat, it is a check.
      if (CHANGES_THINGS.has(tool.name)) seen?.clear();
      else if (!REPEATABLE.has(tool.name)) {
        if (before && before.output === r.output && before.isError === !!r.isError) {
          before.times++;
          return { output: `You already ran this exact call in this run, and nothing has changed since. Use what it returned.${firm(before.times)}\n\n${r.output}`, isError: !!r.isError };
        }
        seen?.set(key, { output: r.output, isError: !!r.isError, times: 1 });
      }
      return { output: r.output, isError: !!r.isError, endTurn: r.endTurn };
    } catch (err) {
      if (signal.aborted) return { output: `Interrupted: ${slot.preemptedBy || "the step was interrupted"}.`, isError: true, interrupted: true };
      const message = `Tool failed: ${describe(err)}`;
      // Account-level failures — no credits, a refused key — are settled for
      // the whole run. Anything else might be the arguments, and deserves a
      // second try.
      if (err instanceof ProviderError && [401, 402, 403].includes(err.status)) broken?.set(call.name, message);
      return { output: message, isError: true };
    }
  }
}

/**
 * A provider failure in words the room can act on.
 *
 * The raw ones are written for whoever holds the API key, and the person
 * reading them here is usually not that person — "402 Insufficient credits"
 * against a frontier model means Friday Pro is unavailable, not that anything
 * they did was wrong, and the useful next move is a different model or a
 * different conversation with whoever pays the bill.
 */
function describe(err: unknown): string {
  if (!(err instanceof ProviderError)) return err instanceof Error ? err.message : String(err);
  const m = err.message.toLowerCase();
  if (err.status === 402 || m.includes("insufficient credits"))
    return "Friday Pro can't run: this workspace's model account is out of credits. Switch the model back to Friday, which is included on every plan, or top the account up.";
  if (err.status === 401 || m.includes("user not found")) return "The model account isn't set up: its key was refused. Nothing you did — someone with access to the deployment needs to fix the key.";
  // By the time this is seen, the call has already been retried and waited
  // out several times, so "try again in a moment" is advice that has been
  // taken. What is left to say is what would actually change the outcome.
  if (err.status === 429) return "The model's server is still limiting requests after several retries. Wait a minute, or switch this session to another model.";
  if (err.status === 404 && m.includes("model")) return "That model isn't available from the provider any more. Pick another in the composer.";
  // "JSON error injected into SSE stream" is the provider failing in the middle
  // of an answer. By now it has been retried, on other models where there were
  // others, so this is an outage on their side and the useful move is another model.
  if ([500, 502, 503, 504].includes(err.status))
    return `The model's provider failed partway through its answer (${err.status}) and kept failing after several tries. That is a problem on their side, not something you did. Try again in a minute, or pick another model in the composer.`;
  return `Model provider error (${err.status}): ${err.message}`;
}

/** Coalesce token deltas into ~20 pub/sub messages a second. */
function batcher(send: (t: string) => void) {
  let buf = "";
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (buf) send(buf);
    buf = "";
  };
  return {
    push(t: string) {
      buf += t;
      timer ??= setTimeout(flush, 50);
    },
    flush,
  };
}

/**
 * Where a session's work happens, for the prompt.
 *
 * A connected machine when there is one, because that is somebody's real
 * checkout. Otherwise the folder that was uploaded, which is a working copy
 * here: readable and editable, with no shell, and the prompt has to say which
 * of the two it is or the agent will offer to run the tests.
 *
 * With several machines, the lane's own when it has one connected, otherwise
 * the first connected one it may borrow (mayBorrow) in the session's order. That is the same rule
 * hub.readRepo follows to pick where a command goes, so the machine whose
 * mode decides the tools and the approvals is the machine that runs them.
 */
export function repoWhere(state: SessionState, lane?: string): { cwd: string; branch?: string; host: string; hostId?: string; mode: EngineMode; uploaded?: boolean; offline?: boolean; shell?: string } | undefined {
  const own = lane ? state.engines[lane] : undefined;
  // Like hub.readRepo: another lane's machine only when it may be borrowed, never a teammate's own coding tool.
  const online = liveMachine(state, lane);
  const e = online ?? own ?? Object.values(state.engines).find((x) => mayBorrow(state, lane ?? MAIN_LANE, x));
  if (e) return { cwd: e.cwd, ...(e.branch ? { branch: e.branch } : {}), host: e.hostName, hostId: e.hostId, mode: e.mode, ...(e.shell ? { shell: e.shell } : {}), ...(online ? {} : { offline: true }) };
  // An upload's shell is the deployment's to switch on, not a host's.
  return state.upload ? { cwd: state.upload.name, host: "this session", mode: uploadsMayRun() ? "full" : "edits", uploaded: true } : undefined;
}
