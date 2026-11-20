import { estimate, taskOf, type Burn, type RunRecord } from "./forecast.js";
import { fullestOf, handedOnLine, limitBar, outBar, type HandTarget, type LimitBar } from "./ide-routing.js";
import { limitedTask, limitTargets } from "./limit-handoff.js";
import { limitedLanes } from "./limited.js";
import { planLimitHit } from "./limit-reset.js";
import { modelOf, repoOfLane } from "./run-log.js";
import { rankTools, nearLimit, type ToolOption, type ToolWindow } from "./routing.js";
import { laneOf, runOf, type SessionState } from "./session/projection.js";
import { ENGINE_NAMES, MAIN_LANE, type EngineTool, type SessionEvent } from "./types.js";

/**
 * What the IDE's column and status bar need to know about one Code chat for usage-aware routing (Arun, 2026-11-20, wave 5), read
 * from its session: how much of its tool's window is left, the bar when the tool is heading for its limit, and the line when it
 * ran out and the work went on (src/ide-routing.ts has the rules; this reads them off a session).
 */
export interface TaskRouting {
  /** The lane the chat's tool is on: what a hand-on moves the work from. */
  lane?: string;
  /** The chat's tool, and how much of its fullest window is left: the IDE's status bar shows it only when it is low. */
  plan?: { tool: EngineTool; name: string; left: number; window: string };
  bar?: LimitBar;
  /** The tool ran out of usage and its work went on to another: what the column says. */
  handed?: { text: string; seq: number };
}

export interface RoutingDeps {
  now: number;
  /** The tool's windows as its runner last read them (engine hub). */
  windows(lane: string): ToolWindow[];
  burnOf(state: SessionState, lane: string): Burn | null;
  records(): Promise<RunRecord[]>;
  /** The tools ready on the person's computer with each one's windows. Asked only when a bar may show. */
  options(): Promise<ToolOption[]>;
}

/** The lanes of the chat that have a coding tool. */
function toolLanes(state: SessionState): string[] {
  return [MAIN_LANE, ...state.lanes.map((l) => l.id)].filter((l) => state.engines[l]?.tool);
}

/**
 * The lane the chat's tool is on: the one at work, else the one that worked last (its run's latest change in the session), else
 * the main lane's. Read from the state alone, so the task list can ask it of every chat without reading a single log.
 */
export function toolLane(state: SessionState): string | null {
  const lanes = toolLanes(state);
  const running = lanes.find((l) => runOf(state, l).status === "running");
  if (running) return running;
  // Newest first; the main lane wins a tie (a lane added with the chat has the same seq as nothing having run).
  return [...lanes].sort((a, b) => runOf(state, b).sinceSeq - runOf(state, a).sinceSeq)[0] ?? null;
}

/** The chat's tool and what is left of its fullest window: all the IDE's status bar needs, with no event log read. */
export function planOf(state: SessionState | null, windows: (lane: string) => ToolWindow[]): Pick<TaskRouting, "lane" | "plan"> {
  const lane = state ? toolLane(state) : null;
  const tool = lane ? state!.engines[lane]?.tool : undefined;
  if (!lane || !tool) return {};
  const fullest = fullestOf(windows(lane));
  return { lane, ...(fullest ? { plan: { tool, name: ENGINE_NAMES[tool], left: 100 - fullest.used, window: fullest.words } } : {}) };
}

/** Whether the chat's log has anything to say about routing: a tool at work, or a run that ended in error (a limit may be behind it). */
function mayNeedEvents(state: SessionState): boolean {
  return toolLanes(state).some((l) => ["running", "error"].includes(runOf(state, l).status));
}

/**
 * A tool that ran out of usage and whose work went on to another: the newest, whichever lane has the work now. Looked for on every
 * lane with a tool, not on the one at work (that is the tool that took the work over: 2026-11-20 review).
 */
function handedOn(state: SessionState, events: SessionEvent[], lanes: string[]): { from: string; to: string; toName: string; auto: boolean; seq: number } | null {
  let found: ReturnType<typeof handedOn> = null;
  for (const lane of lanes) {
    const tool = state.engines[lane]?.tool;
    const end = events.findLast((e) => e.body.type === "run.ended" && (e.lane ?? MAIN_LANE) === lane);
    if (!tool || end?.body.type !== "run.ended" || end.body.outcome !== "error" || !planLimitHit(end.body.error, end.ts)) continue;
    const moved = events.findLast((e) => e.seq > end.seq && e.body.type === "instruction" && e.body.handoff?.fromLane === lane);
    if (moved?.body.type !== "instruction" || !moved.body.handoff) continue;
    if (!found || moved.seq > found.seq) found = { from: ENGINE_NAMES[tool], to: moved.lane ?? MAIN_LANE, toName: moved.body.handoff.toName, auto: moved.actor.kind !== "human", seq: moved.seq };
  }
  return found;
}

/**
 * `events` may be a function: the log is read only when this chat has a tool at work or a run that ended in error, so a chat
 * sitting idle costs no read (the task list is polled every few seconds; reading every Code chat's whole log kept them all in
 * memory, store.ts HOT_MS).
 */
export async function taskRouting(state: SessionState | null, events: SessionEvent[] | (() => Promise<SessionEvent[]>), d: RoutingDeps): Promise<TaskRouting> {
  const out: TaskRouting = {};
  if (!state) return out;
  const lanes = toolLanes(state);
  if (!lanes.length) return out;
  Object.assign(out, planOf(state, d.windows));
  if (!mayNeedEvents(state)) return out;
  const log = typeof events === "function" ? await events().catch(() => []) : events;
  const handed = handedOn(state, log, lanes);
  let lane = out.lane;
  if (handed) {
    out.handed = { text: handedOnLine({ from: handed.from, to: handed.toName, auto: handed.auto }), seq: handed.seq };
    // The work is with the tool that took it now, whether or not it has started: its window is the one to watch.
    const t = state.engines[handed.to]?.tool;
    if (lane && runOf(state, lane).status !== "running" && t) {
      lane = out.lane = handed.to;
      const f = fullestOf(d.windows(handed.to));
      if (f) out.plan = { tool: t, name: ENGINE_NAMES[t], left: 100 - f.used, window: f.words };
      else delete out.plan;
    }
  }
  const engine = lane ? state.engines[lane] : undefined;
  if (!lane || !engine?.tool) return out;
  const tool = engine.tool;
  const wasHanded = !!handed && handed.to === lane;
  if (state.options.team) return out;

  // Who could take the work: another tool on the person's own computer, with room, and the lane it already has here.
  const targetsFor = async (): Promise<HandTarget[]> => {
    const options = (await d.options().catch(() => [])).filter((o) => o.ready && o.tool !== tool);
    const here = new Map(
      limitTargets(state, log, lane!, d.now)
        .map((t) => [state.engines[t.id]?.tool, t.id] as const)
        .filter((x): x is readonly [EngineTool, string] => !!x[0] && laneOf(state, x[1]) !== undefined),
    );
    const ranked = rankTools("standard", options, "", {}, { now: d.now }).filter((r) => !r.out && !nearLimit(options.find((o) => o.tool === r.tool)?.windows ?? [], d.now));
    return ranked.map((r) => ({ tool: r.tool, name: ENGINE_NAMES[r.tool], ...(here.has(r.tool) ? { lane: here.get(r.tool)! } : {}) }));
  };
  const running = runOf(state, lane).status === "running";
  const limited = limitedLanes(state, log, d.now).has(lane);

  // The limit was hit and nothing took the work on (a chat with one tool: limit-handoff.ts reaches only tools in the session): the
  // bar stays, offering the hand-on on the press (2026-11-20 review of wave 5).
  if (!running && limited && !wasHanded) {
    const ended = log.findLast((e) => e.body.type === "run.ended" && (e.lane ?? MAIN_LANE) === lane);
    const moved = !!ended && log.some((e) => e.seq > ended.seq && e.body.type === "instruction" && e.body.handoff?.fromLane === lane);
    const bar = moved ? null : outBar({ tool, targets: await targetsFor(), window: fullestOf(d.windows(lane))?.words });
    if (bar) out.bar = bar;
    return out;
  }

  // The bar: mid-task, heading for its limit, with another tool on the person's own plan to take it.
  const b = running ? d.burnOf(state, lane) : null;
  if (!b) return out;
  const start = log.findLast((e) => (e.lane ?? MAIN_LANE) === lane && e.body.type === "run.started");
  if (!start) return out;
  const gone = log.some((e) => e.seq > start.seq && e.body.type === "instruction" && e.body.handoff?.fromLane === lane);
  const repo = repoOfLane(state, lane);
  const q = { tool, model: modelOf(state, log, lane), ...(repo ? { repo } : {}) };
  const cur = estimate(await d.records().catch(() => []), { ...q, ...taskOf(limitedTask(log, lane, start.seq, Number.MAX_SAFE_INTEGER)) }, d.now);
  // A turn already past its forecast is taken to have a couple of minutes left, not none (limit-ahead.ts).
  const runEndsAt = Math.max(start.ts + cur.ms, d.now + 2 * 60_000);
  // Cheap to say no first: only a tool heading for its limit asks the computer who else has room.
  const probe = limitBar({ tool, running, now: d.now, burn: b, runEndsAt, handedOn: gone, limited, targets: [{ tool, name: "" }] });
  if (!probe) return out;
  const bar = limitBar({ tool, running, now: d.now, burn: b, runEndsAt, handedOn: gone, limited, targets: await targetsFor() });
  if (bar) out.bar = bar;
  return out;
}
