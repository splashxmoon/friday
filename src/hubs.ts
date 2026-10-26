import { randomBytes } from "node:crypto";
import type { LLM } from "./agent/llm.js";
import type { Bus } from "./bus.js";
import type { Plan } from "./workspace-types.js";
import { gradeOf, runReceipt, type Learned } from "./route-learning.js";
import { rankTools, type ToolOption } from "./routing.js";
import type { SessionCore } from "./session/core.js";
import { runOf, type SessionState } from "./session/projection.js";
import type { SessionStore } from "./session/store.js";
import { FRIDAY } from "./shepherd.js";
import { SESSION_LANES } from "./types.js";
import { ENGINE_NAMES, MAIN_LANE, type EngineTool, type HubTask, type RepoCall, type RouteTier, type SessionEvent } from "./types.js";

/**
 * A hub: one coordinator plans the work, several agents do it at once, and the results are brought together and shipped as one.
 *
 * The plan is one model call: given the goal, the folder's tree and which coding tools are on the machine, it answers tasks,
 * each a piece one agent does by itself, with the files it owns and what it waits on. Nothing runs until a person approves the
 * card. Then each ready task starts a lane on the person's machine, in its own copy of the folder (a worktree), with the tool the
 * router ranked first for it; when its run ends it is graded by the evidence under its "done" (route-learning.ts), and one that
 * missed is tried once more on the same lane, with what went wrong in front of it, one model up. Once every task is done or
 * given up on, the copies are applied to the folder in dependency order, conflicts go to the main lane's agent, and the lot is
 * committed and sent as one pull request. Every step is an event in the session's log, so a restart loses nothing and every
 * viewer sees the same card.
 *
 * Rules: the width (tasks at once) is the plan's, at most SESSION_LANES lanes in all, and one fewer while a tool is near its limit; a task
 * owns its files in writing, not by a lock, so the merge is where overlap is caught; the coordinator's tool for each task is a
 * suggestion the person can change; the hub's instructions to task lanes come from the session, not a person; and a task agent's
 * answer comes back as a result, never as an instruction to anyone.
 */

export const MAX_TASKS = 6;
export const MAX_LANES = SESSION_LANES;
/** How many tasks a hub runs at once, by plan. Cheap in tokens for nobody: each is a copy of the folder, a process and a window spent. */
const WIDTH: Partial<Record<Plan, number>> = { basic: 3, pro: 4, max: 4 };
const ATTEMPTS = 2;

const TIERS: RouteTier[] = ["light", "standard", "heavy"];
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const list = (v: unknown, max: number, each: number) => (Array.isArray(v) ? v.map((x) => str(x, each)).filter(Boolean).slice(0, max) : []);

/** Tasks at once: the plan's width, within the lanes the session has left, and one fewer while a tool is nearly spent. */
export function hubWidth(plan: Plan, lanesNow: number, tools: ToolOption[]): number {
  const base = WIDTH[plan] ?? 2;
  const tight = tools.some((t) => t.ready && (t.fullest ?? 0) >= 80) ? 1 : 0;
  return Math.max(1, Math.min(base - tight, MAX_LANES - lanesNow));
}

export const PLAN_SYSTEM = `You plan a piece of software work for several coding agents to do at once, each in its own copy of the repository. Answer with only JSON: {"tasks": [{"id": "t1", "title": "...", "instruction": "...", "files": ["path/one.ts"], "dependsOn": [], "tier": "light" | "standard" | "heavy", "check": "npm test -- cart"}]}.

Rules:
- Two to six tasks. Each is something one agent finishes in one sitting without asking anyone.
- Split by files, not by phase: the files a task owns, no other task touches. Name paths exactly as the tree shows them; a task may add new files under a folder it names.
- A task that needs another's result says so in dependsOn; the rest run at once. Prefer no dependencies.
- "instruction": what to do, in full, as if to an engineer who has not read this conversation; say what the other tasks are doing where it matters.
- "tier": how hard it is. light: a small, obvious change. standard: ordinary work. heavy: a refactor, a hard bug, something across many files.
- "check": the command that proves it done, when the repository has tests or a build to run; leave it out otherwise.
- No task for reviewing, merging or shipping: that is done after.
If the work can't be split, answer one task.`;

/** The model's answer as tasks; anything not in the shape asked for is left out, never guessed. */
export function parseHubPlan(raw: string): HubTask[] {
  const from = raw.indexOf("{");
  const to = raw.lastIndexOf("}");
  if (from < 0 || to <= from) return [];
  let j: unknown;
  try {
    j = JSON.parse(raw.slice(from, to + 1));
  } catch {
    return [];
  }
  const items = j && typeof j === "object" && Array.isArray((j as { tasks?: unknown }).tasks) ? ((j as { tasks: unknown[] }).tasks as Record<string, unknown>[]) : [];
  const out: HubTask[] = [];
  const ids = new Set<string>();
  for (const it of items.slice(0, MAX_TASKS)) {
    if (!it || typeof it !== "object") continue;
    const title = str(it.title, 60);
    const instruction = str(it.instruction, 4000);
    if (!title || instruction.length < 12) continue;
    let id = str(it.id, 12).replace(/[^\w-]/g, "") || `t${out.length + 1}`;
    while (ids.has(id)) id = `${id}x`;
    ids.add(id);
    const tier = TIERS.includes(it.tier as RouteTier) ? (it.tier as RouteTier) : "standard";
    const check = str(it.check, 300);
    out.push({ id, title, instruction, files: list(it.files, 40, 300), dependsOn: list(it.dependsOn, 6, 12), tier, ...(check ? { check } : {}) });
  }
  // Only tasks that are there can be waited on; a task that waits on itself waits on nothing.
  for (const t of out) t.dependsOn = t.dependsOn.filter((d) => d !== t.id && ids.has(d));
  return out;
}

/**
 * Tasks in an order they can run in: what a task waits on comes first, and two tasks that name the same file run one after the
 * other (the later waits on the earlier), since both changing it would be the merge's problem. Null for a cycle.
 */
export function orderTasks(tasks: HubTask[]): HubTask[] | null {
  const own = new Map<string, string>();
  const out = tasks.map((t) => ({ ...t, dependsOn: [...t.dependsOn] }));
  for (const t of out) {
    for (const f of t.files) {
      const other = own.get(f);
      if (other && other !== t.id && !t.dependsOn.includes(other)) t.dependsOn.push(other);
      if (!other) own.set(f, t.id);
    }
  }
  const done = new Set<string>();
  const ordered: HubTask[] = [];
  const left = [...out];
  while (left.length) {
    const i = left.findIndex((t) => t.dependsOn.every((d) => done.has(d)));
    if (i < 0) return null;
    const [t] = left.splice(i, 1);
    done.add(t!.id);
    ordered.push(t!);
  }
  return ordered;
}

/** What a task's agent is told: the whole, its own part, what it owns, and how it will be judged. */
export function taskPrompt(goal: string, task: HubTask, all: HubTask[]): string {
  const others = all.filter((t) => t.id !== task.id);
  const owned = task.files.length ? `Files you own: ${task.files.join(", ")}. Leave every other file alone: other agents are changing them in their own copies, and the copies are brought together afterwards.` : "Keep to the files this task needs; other agents are changing others in their own copies.";
  const theirs = others.length ? `\n\nThe other agents are doing, at the same time: ${others.map((t) => `${t.title}${t.files.length ? ` (${t.files.slice(0, 4).join(", ")}${t.files.length > 4 ? ", …" : ""})` : ""}`).join("; ")}.` : "";
  const check = task.check ? `\n\nWhen you think it is done, run \`${task.check}\` and make it pass; say what it printed.` : "\n\nWhen you think it is done, run the repository's own checks that bear on it, and say what they printed.";
  return `[Friday] You are one of ${all.length} agents working at once on: ${goal}\n\nYour task: ${task.title}\n${task.instruction}\n\n${owned}${theirs}${check}\n\nFinish by saying, in two or three lines, what you changed and how you checked it.`;
}

/** What a task's agent is told after a miss: what went wrong, and to go again. */
export function retryPrompt(task: HubTask, why: string): string {
  return `[Friday] That didn't pass: ${why}\n\nFix it and go again on the same task: ${task.title}.${task.check ? ` Run \`${task.check}\` until it passes, and say what it printed.` : ""}`;
}

export interface HubDeps {
  store: SessionStore;
  bus: Bus;
  core: Pick<SessionCore, "handle">;
  /** The model that plans, as the session's learner (app.ts learnerFor): the session's own, Friday's, or the owner's own. */
  llm: (sid: string, lane: string) => Promise<{ llm: LLM; model?: string } | null>;
  /** A look at, or a command in, the session's folder on its machine (app.ts openFolder). */
  folder: (sid: string, req: RepoCall, lane: string) => Promise<{ output: string }>;
  /** Starts a coding tool on the owner's machine, in its own copy of `cwd`, as a new lane of the session. */
  starter: (sid: string, owner: { id: string; name: string }, p: { tool: EngineTool; cwd: string; newLane: string; model?: string }) => Promise<{ lane: string }>;
  stopper?: (sid: string, owner: { id: string; name: string }, lane: string) => Promise<void>;
  /** The coding tools on the owner's machine, with how much of each is left. */
  tools: (ownerId: string) => Promise<ToolOption[]>;
  plan: (workspaceId: string) => Promise<Plan>;
  learned?: (workspaceId: string) => Promise<Learned>;
}

export type HubResult = { ok: true; id: string } | { ok: false; error: string };

/** Which of a tool's models the router may pick per turn: the lane runs on Auto, so each task's turn is routed, and a miss goes up. */
const ROUTED = new Set<EngineTool>(["claude", "codex"]);

export class Hubs {
  /** One thing at a time per session: two runs ending together would both try to start the next task. */
  private readonly busy = new Map<string, Promise<void>>();

  constructor(readonly deps: HubDeps) {}

  private serial<T>(sid: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.busy.get(sid) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.busy.set(
      sid,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private ownerOf(state: SessionState) {
    return { id: state.ownerId, name: state.members[state.ownerId]?.name ?? "" };
  }

  /** Plan the work: a card for the session's owner to approve. */
  async plan(sid: string, goal: string, by: { id: string; name: string }): Promise<HubResult> {
    const text = goal.trim().slice(0, 4000);
    if (text.length < 8) return { ok: false, error: "Say what the hub should do." };
    const state = await this.deps.store.state(sid);
    if (state.hub && (state.hub.status === "planned" || state.hub.status === "running" || state.hub.status === "merging")) return { ok: false, error: "This session has a hub going already. Let it finish or cancel it first." };
    const main = state.engines[MAIN_LANE];
    if (!main?.cwd) return { ok: false, error: "A hub works in a folder on your computer: connect one to the session first." };
    const owner = this.ownerOf(state);
    const tools = (await this.deps.tools(owner.id).catch(() => [])).filter((t) => t.ready);
    if (!tools.length) return { ok: false, error: `No coding tool is signed in on that computer: a hub needs ${Object.values(ENGINE_NAMES).slice(0, 3).join(", ")} or another to run its tasks.` };
    const who = await this.deps.llm(sid, MAIN_LANE);
    if (!who) return { ok: false, error: "There is no model here to plan with." };
    const tree = (await this.deps.folder(sid, { op: "tree" }, MAIN_LANE).catch(() => ({ output: "" }))).output.slice(0, 8000);
    const prompt = `The work: ${text}\n\nThe repository's tree:\n${tree || "(not available)"}\n\nCoding tools on the machine: ${tools.map((t) => ENGINE_NAMES[t.tool]).join(", ")}.`;
    let answer: string;
    try {
      answer = (await who.llm.complete({ system: PLAN_SYSTEM, messages: [{ role: "user", content: prompt }], tools: [], signal: AbortSignal.timeout(180_000), reasoningEffort: "medium", ...(who.model ? { model: who.model } : {}) })).text;
    } catch (e) {
      return { ok: false, error: `The plan couldn't be made: ${(e as Error).message}` };
    }
    const parsed = parseHubPlan(answer);
    if (!parsed.length) return { ok: false, error: "The planner didn't answer with tasks. Say the work in more detail and try again." };
    const ordered = orderTasks(parsed);
    if (!ordered) return { ok: false, error: "The planner's tasks wait on each other in a circle. Try again." };
    // Each task's tool: the router's first pick for work of its kind on this machine, with what runs here have shown.
    const learned = state.workspaceId && this.deps.learned ? await this.deps.learned(state.workspaceId).catch(() => ({})) : {};
    const tasks = ordered.map((t) => {
      const top = rankTools(t.tier, tools, "", learned, { attended: false }).find((r) => !r.out);
      return { ...t, tool: top?.tool ?? tools[0]!.tool };
    });
    const plan = state.workspaceId ? await this.deps.plan(state.workspaceId).catch(() => "free" as Plan) : ("free" as Plan);
    const width = hubWidth(plan, state.lanes.length, tools);
    const id = randomBytes(5).toString("hex");
    await this.deps.store.append(sid, FRIDAY, { type: "hub.planned", id, goal: text, tasks, width, tools: tools.map((t) => t.tool), by: by.name });
    return { ok: true, id };
  }

  /** A person approved the plan, with their changes: which tasks stay, and on which tool. The ready ones start now. */
  async approve(sid: string, id: string, edits: { id: string; tool?: EngineTool }[] | undefined): Promise<HubResult> {
    return this.serial(sid, async () => {
      const state = await this.deps.store.state(sid);
      const hub = state.hub;
      if (!hub || hub.id !== id) return { ok: false, error: "That plan isn't the session's current one." };
      if (hub.status !== "planned") return { ok: false, error: "That plan was already approved." };
      let tasks = hub.tasks;
      if (edits) {
        const keep = new Map(edits.map((e) => [e.id, e]));
        // A task dropped takes with it what waited on it: that work can't be done without it.
        let kept = tasks.filter((t) => keep.has(t.id));
        for (;;) {
          const ids = new Set(kept.map((t) => t.id));
          const next = kept.filter((t) => t.dependsOn.every((d) => ids.has(d)));
          if (next.length === kept.length) break;
          kept = next;
        }
        tasks = kept.map((t) => {
          const tool = keep.get(t.id)?.tool;
          return tool && hub.tools.includes(tool) ? { ...t, tool } : t;
        });
      }
      if (!tasks.length) return { ok: false, error: "Nothing is left to run." };
      await this.deps.store.append(sid, FRIDAY, { type: "hub.approved", id, tasks });
      await this.schedule(sid);
      return { ok: true, id };
    });
  }

  async cancel(sid: string, id: string): Promise<HubResult> {
    return this.serial(sid, async () => {
      const state = await this.deps.store.state(sid);
      const hub = state.hub;
      if (!hub || hub.id !== id) return { ok: false, error: "That hub isn't the session's current one." };
      if (hub.status === "done" || hub.status === "failed" || hub.status === "cancelled") return { ok: false, error: "That hub is over." };
      const owner = this.ownerOf(state);
      for (const [, r] of Object.entries(hub.runs)) if (r.status === "running" && r.lane) await this.deps.stopper?.(sid, owner, r.lane).catch(() => {});
      const done = Object.values(hub.runs).filter((r) => r.status === "done").length;
      await this.deps.store.append(sid, FRIDAY, { type: "hub.ended", id, outcome: "cancelled", tasks: hub.tasks.length, done });
      return { ok: true, id };
    });
  }

  /** A run ended on some lane of a session: a task's, or the main lane's conflict work. */
  onRunEnded(sid: string, lane: string): Promise<void> {
    return this.serial(sid, async () => {
      const state = await this.deps.store.state(sid);
      const hub = state.hub;
      if (!hub) return;
      if (hub.status === "merging" && lane === MAIN_LANE) return this.finish(sid);
      if (hub.status !== "running") return;
      const task = hub.tasks.find((t) => hub.runs[t.id]?.lane === lane && hub.runs[t.id]?.status === "running");
      if (!task) return;
      const run = hub.runs[task.id]!;
      const events = await this.deps.store.events(sid);
      const end = events.findLast((e) => (e.lane ?? MAIN_LANE) === lane && e.body.type === "run.ended");
      if (!end || end.body.type !== "run.ended") return;
      // Stopped to ask a person: the task is still theirs; it goes on when they answer.
      if (end.body.outcome === "waiting") return;
      const grade = end.body.outcome === "error" ? 0 : gradeOf(events, lane, end.seq);
      const receipt = runReceipt(events, lane, end.seq);
      const said = events.findLast((e) => e.seq > (events.findLast((x) => x.seq < end.seq && (x.lane ?? MAIN_LANE) === lane && x.body.type === "run.started")?.seq ?? 0) && (e.lane ?? MAIN_LANE) === lane && e.body.type === "agent.message" && !!e.body.text.trim());
      const summary = (said?.body.type === "agent.message" ? said.body.text : "").trim().slice(0, 600);
      const files = state.diffs[lane]?.files.length ?? 0;
      if (grade >= 0.5) {
        await this.deps.store.append(sid, FRIDAY, { type: "hub.task.ended", id: hub.id, task: task.id, outcome: "done", grade, tests: receipt.tests, summary, files, attempt: run.attempt });
      } else if (run.attempt < ATTEMPTS) {
        // Once more, with what went wrong in front of it. The router sees the miss and sends the turn one model up.
        const why = end.body.outcome === "error" ? (end.body.error ?? "the run failed") : receipt.tests === "fail" ? "its tests failed" : "it didn't pass";
        await this.deps.store.append(sid, FRIDAY, { type: "instruction", text: retryPrompt(task, why), interrupt: false }, { lane });
        void this.deps.bus.wake(sid, lane);
        await this.deps.store.append(sid, FRIDAY, { type: "hub.task.started", id: hub.id, task: task.id, lane, tool: task.tool ?? state.engines[lane]?.tool ?? "claude", attempt: run.attempt + 1 });
        return;
      } else {
        await this.deps.store.append(sid, FRIDAY, { type: "hub.task.ended", id: hub.id, task: task.id, outcome: "failed", grade, tests: receipt.tests, summary, files, attempt: run.attempt });
        await this.skipDependents(sid, task.id);
      }
      await this.schedule(sid);
    });
  }

  /** What waited on a task that failed can't be done: said so, rather than started. */
  private async skipDependents(sid: string, failed: string): Promise<void> {
    for (;;) {
      const state = await this.deps.store.state(sid);
      const hub = state.hub!;
      const next = hub.tasks.find((t) => hub.runs[t.id]?.status === "waiting" && t.dependsOn.some((d) => ["failed", "skipped"].includes(hub.runs[d]?.status ?? "")));
      if (!next) return;
      const on = next.dependsOn.find((d) => ["failed", "skipped"].includes(hub.runs[d]?.status ?? ""))!;
      await this.deps.store.append(sid, FRIDAY, { type: "hub.task.ended", id: hub.id, task: next.id, outcome: "skipped", grade: 0, tests: "none", summary: `Not started: it waits on “${hub.tasks.find((t) => t.id === on)?.title ?? on}”, which ${hub.runs[on]?.status === "failed" ? "failed" : "couldn't run"}${failed ? "" : ""}.`, files: 0, attempt: 0 });
    }
  }

  /** Start what is ready, up to the width; when nothing is left to start or finish, bring the copies together. */
  private async schedule(sid: string): Promise<void> {
    const state = await this.deps.store.state(sid);
    const hub = state.hub;
    if (!hub || hub.status !== "running") return;
    const running = hub.tasks.filter((t) => hub.runs[t.id]?.status === "running");
    const ready = hub.tasks.filter((t) => hub.runs[t.id]?.status === "waiting" && t.dependsOn.every((d) => hub.runs[d]?.status === "done"));
    const slots = Math.max(0, hub.width - running.length);
    for (const task of ready.slice(0, slots)) await this.startTask(sid, task);
    const after = (await this.deps.store.state(sid)).hub!;
    const left = after.tasks.filter((t) => ["waiting", "running"].includes(after.runs[t.id]?.status ?? ""));
    if (left.length) return;
    if (!after.tasks.some((t) => after.runs[t.id]?.status === "done")) {
      await this.deps.store.append(sid, FRIDAY, { type: "hub.ended", id: after.id, outcome: "failed", why: "No task got through.", tasks: after.tasks.length, done: 0 });
      return;
    }
    await this.merge(sid);
  }

  private async startTask(sid: string, task: HubTask): Promise<void> {
    const state = await this.deps.store.state(sid);
    const hub = state.hub!;
    const owner = this.ownerOf(state);
    const cwd = state.engines[MAIN_LANE]?.cwd;
    const tool = task.tool ?? "claude";
    if (!cwd) return void (await this.giveUp(sid, task, "The session's folder isn't connected any more."));
    let lane: string;
    try {
      ({ lane } = await this.deps.starter(sid, owner, { tool, cwd, newLane: task.title.slice(0, 40), ...(ROUTED.has(tool) ? { model: "auto" } : {}) }));
    } catch (e) {
      return void (await this.giveUp(sid, task, `${ENGINE_NAMES[tool]} couldn't be started on that computer: ${(e as Error).message}`));
    }
    await this.deps.store.append(sid, FRIDAY, { type: "instruction", text: taskPrompt(hub.goal, task, hub.tasks), interrupt: false }, { lane });
    void this.deps.bus.wake(sid, lane);
    await this.deps.store.append(sid, FRIDAY, { type: "hub.task.started", id: hub.id, task: task.id, lane, tool, attempt: 1 });
  }

  private async giveUp(sid: string, task: HubTask, why: string): Promise<void> {
    const hub = (await this.deps.store.state(sid)).hub!;
    await this.deps.store.append(sid, FRIDAY, { type: "hub.task.ended", id: hub.id, task: task.id, outcome: "failed", grade: 0, tests: "none", summary: why, files: 0, attempt: 0 });
    await this.skipDependents(sid, task.id);
  }

  /** Each copy's work into the folder, in the order the tasks ran; conflicts go to the main lane's agent, then it is finished. */
  private async merge(sid: string): Promise<void> {
    const state = await this.deps.store.state(sid);
    const hub = state.hub!;
    const owner = this.ownerOf(state);
    const done = orderTasks(hub.tasks.filter((t) => hub.runs[t.id]?.status === "done")) ?? hub.tasks.filter((t) => hub.runs[t.id]?.status === "done");
    const conflicts: string[] = [];
    for (const task of done) {
      const lane = hub.runs[task.id]!.lane!;
      const before = (await this.deps.store.events(sid)).length;
      const r = await this.deps.core.handle(sid, owner, { type: "folder.apply", lane });
      const applied = (await this.deps.store.events(sid)).slice(before).findLast((e) => e.body.type === "folder.applied");
      const files = applied?.body.type === "folder.applied" ? applied.body.files : 0;
      const found = applied?.body.type === "folder.applied" ? (applied.body.conflicts ?? []) : [];
      conflicts.push(...found);
      // Nothing new to bring over is fine (a task that found nothing to change); anything else is said on the card.
      await this.deps.store.append(sid, FRIDAY, { type: "hub.merged", id: hub.id, task: task.id, files, conflicts: r.ok ? found : [r.error ?? "couldn't be brought over"] });
    }
    if (conflicts.length) {
      await this.deps.store.append(sid, FRIDAY, { type: "instruction", text: `[Friday] Bringing the hub's copies together left conflict markers in: ${[...new Set(conflicts)].slice(0, 20).join(", ")}. Resolve each one, keeping what both sides meant, then run the repository's checks and say what they printed.`, interrupt: false });
      void this.deps.bus.wake(sid, MAIN_LANE);
      return;
    }
    await this.finish(sid);
  }

  /** Commit the folder as it now is, as one pull request where it can be, and say how the hub went. */
  private async finish(sid: string): Promise<void> {
    const state = await this.deps.store.state(sid);
    const hub = state.hub!;
    if (hub.status !== "merging" && hub.status !== "running") return;
    const owner = this.ownerOf(state);
    const done = hub.tasks.filter((t) => hub.runs[t.id]?.status === "done");
    const missed = hub.tasks.filter((t) => hub.runs[t.id]?.status !== "done");
    const message = `${hub.goal.split("\n")[0]!.slice(0, 72)}\n\nDone by a hub of ${done.length} agent${done.length === 1 ? "" : "s"} at once:\n${done.map((t) => `- ${t.title} (${ENGINE_NAMES[t.tool ?? "claude"]})`).join("\n")}${missed.length ? `\n\nLeft out, not done: ${missed.map((t) => t.title).join("; ")}.` : ""}`;
    let prUrl: string | undefined;
    let sha: string | undefined;
    let why: string | undefined;
    const read = async () => {
      const last = (await this.deps.store.events(sid)).findLast((e) => e.body.type === "folder.committed");
      if (last?.body.type === "folder.committed") ({ sha, prUrl } = { sha: last.body.sha, prUrl: last.body.prUrl });
    };
    const shipped = await this.deps.core.handle(sid, owner, { type: "folder.commit", message, push: true, pr: true });
    if (shipped.ok) await read();
    else {
      // Committed at least, where it couldn't be pushed (no remote, a machine that can't): the work is kept either way.
      const kept = await this.deps.core.handle(sid, owner, { type: "folder.commit", message });
      if (kept.ok) await read();
      why = shipped.error ?? "It couldn't be committed.";
    }
    await this.deps.store.append(sid, FRIDAY, { type: "hub.ended", id: hub.id, outcome: "done", ...(why ? { why } : {}), ...(prUrl ? { prUrl } : {}), ...(sha ? { sha } : {}), tasks: hub.tasks.length, done: done.length });
  }
}

/** The main lane's run was for the hub's conflicts: used by the app to tell the hub's own runs from the person's. */
export const isHubLane = (s: SessionState, lane: string): boolean => !!s.hub && Object.values(s.hub.runs).some((r) => r.lane === lane);

/** Who is in the session right now, for a message that needs a name. */
export const laneOfTask = (events: SessionEvent[], hubId: string, task: string): string | undefined => {
  const e = events.findLast((x) => x.body.type === "hub.task.started" && x.body.id === hubId && x.body.task === task);
  return e?.body.type === "hub.task.started" ? e.body.lane : undefined;
};

export { runOf };
