import type { HandOffFn } from "./agent-mesh.js";
import { aheadOfLimit, estimate, pctOf, taskOf, type Burn, type RunRecord } from "./forecast.js";
import { modelOf, repoOfLane } from "./run-log.js";
import { limitedTask, limitTargets } from "./limit-handoff.js";
import { whoseWork } from "./own-plan.js";
import { laneName } from "./session/core.js";
import { pendingFor, runOf, type SessionState } from "./session/projection.js";
import type { SessionStore } from "./session/store.js";
import { FRIDAY } from "./shepherd.js";
import { engineName, MAIN_LANE, type EventBody, type SessionEvent } from "./types.js";

/**
 * Moving the next task before a coding tool runs out, not after (Arun, 2026-10-31). The hand-off out of usage (limit-handoff.ts)
 * acts once a run has stopped on the limit; by then the task queued behind it waits for the limit to lift, or starts and is cut
 * off too. Here, while the tool is mid-turn, its window's burn rate (forecast.ts) is read against how long the turn and the next
 * task should take: when it runs out first, the next task goes now to the agent best placed to take it, with one line saying why.
 *
 * Only the next queued task, and only a person's own message: the turn under way is never touched, nor a message meant for it
 * (one that interrupts), an answer, a nudge or another agent's message. Who may take it is limit-handoff's rule, with the
 * person who queued it as the owner: never the same tool (another account of it is the person's call), never someone else's
 * own-plan tool, never one offline, out of usage, or itself about to run out. With nobody to take it, it stays queued.
 */

/** The move to make: the queued message, its words, why, and who could take it, best first. */
export interface AheadPlan {
  seq: number;
  task: string;
  reason: string;
  targets: { id: string; why: string }[];
}

type Instruction = Extract<EventBody, { type: "instruction" }>;

/** The lane's next queued message, if it is a person's own task that could go elsewhere. */
export function nextTask(state: SessionState, events: SessionEvent[], lane: string): (SessionEvent & { body: Instruction }) | null {
  const seq = pendingFor(state, lane).find((q) => !state.withdrawn.includes(q));
  const ev = seq === undefined ? undefined : events.find((e) => e.seq === seq);
  if (!ev || ev.body.type !== "instruction" || ev.actor.kind !== "human") return null;
  const b = ev.body;
  if (b.interrupt || b.approval || b.keepGoing || b.handoff || b.mesh || b.peer || b.thread || b.ownTurn || b.attachments?.length || !b.text.trim()) return null;
  return ev as SessionEvent & { body: Instruction };
}

/** Whether, and where, the next task on `lane` should go before its tool runs out. Pure: what the state, the log and the burn say. */
export function planAhead(state: SessionState, events: SessionEvent[], lane: string, o: { now: number; records: RunRecord[]; perPct: number | null; burnOf: (lane: string) => Burn | null }): AheadPlan | null {
  const engine = state.engines[lane];
  if (state.options.team || !engine?.tool || runOf(state, lane).status !== "running") return null;
  const next = nextTask(state, events, lane);
  if (!next) return null;
  const b = o.burnOf(lane);
  if (!b) return null;
  const start = events.findLast((e) => (e.lane ?? MAIN_LANE) === lane && e.body.type === "run.started");
  if (!start) return null;
  const repo = repoOfLane(state, lane);
  const q = { tool: engine.tool, model: modelOf(state, events, lane), ...(repo ? { repo } : {}) };
  const cur = estimate(o.records, { ...q, ...taskOf(limitedTask(events, lane, start.seq, Number.MAX_SAFE_INTEGER)) }, o.now);
  const nxt = estimate(o.records, { ...q, ...taskOf(next.body.text) }, o.now);
  // A turn already past its forecast is taken to have a couple of minutes left, not none.
  const runEndsAt = Math.max(start.ts + cur.ms, o.now + 2 * 60_000);
  const reason = aheadOfLimit(b, { now: o.now, runEndsAt, nextMs: nxt.ms, nextPct: pctOf(nxt.tokens, o.perPct) });
  if (!reason) return null;
  const owner = whoseWork(events, next) ?? undefined;
  const targets = limitTargets(state, events, lane, o.now, owner).filter((t) => !aheadOfLimit(o.burnOf(t.id), { now: o.now, runEndsAt: o.now, nextMs: nxt.ms, nextPct: null }));
  return { seq: next.seq, task: next.body.text.trim(), reason: `${engineName(engine.tool)} ${reason}`, targets };
}

export interface AheadDeps {
  store: Pick<SessionStore, "state" | "events" | "append">;
  handOff: HandOffFn;
  records(workspaceId: string): Promise<RunRecord[]>;
  perPct(workspaceId: string, host: string, tool: string): Promise<number | null>;
  burnOf(state: SessionState, lane: string): Burn | null;
  /** True the first time it is asked for a key: one move per queued message. */
  once(key: string): Promise<boolean>;
}

/** Move the next task on `lane` ahead of its tool's limit, when it should go and someone can take it. Whether it moved. */
export async function moveAhead(d: AheadDeps, sid: string, lane: string, now = Date.now()): Promise<boolean> {
  const [state, events] = await Promise.all([d.store.state(sid), d.store.events(sid)]);
  const engine = state.engines[lane];
  if (!engine?.tool || runOf(state, lane).status !== "running" || !nextTask(state, events, lane)) return false;
  const ws = state.workspaceId ?? "";
  const [records, perPct] = await Promise.all([d.records(ws).catch(() => []), d.perPct(ws, engine.hostId, engine.tool).catch(() => null)]);
  const plan = planAhead(state, events, lane, { now, records, perPct, burnOf: (l) => d.burnOf(state, l) });
  if (!plan?.targets.length || !(await d.once(`ahead:${sid}:${plan.seq}`))) return false;
  const queued = events.find((e) => e.seq === plan.seq)!;
  await d.store.append(sid, FRIDAY, { type: "instruction.withdrawn", seq: plan.seq }, { lane });
  for (const t of plan.targets) {
    const toName = laneName(state, t.id);
    const r = await d.handOff(sid, lane, { to: toName, reason: `${plan.reason}, so Friday gave it to ${toName} ahead of time: ${t.why}.`, carried: [], task: plan.task });
    if (r.ok) return true;
  }
  // Nobody took it after all: back in the queue, as the person sent it.
  await d.store.append(sid, queued.actor, { type: "instruction", text: plan.task, interrupt: false }, { lane });
  return false;
}
