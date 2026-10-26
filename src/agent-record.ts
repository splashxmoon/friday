import { commandFailed, receiptOf } from "./receipt.js";
import type { SessionState } from "./session/projection.js";
import { MAIN_LANE, type SessionEvent } from "./types.js";

/**
 * An agent's track record: what it did across every session it ran in.
 *
 * A card that says "Updated 2h ago" says nothing about whether the agent is any good. This says how often it ran this
 * week, how often it finished, whether its tests passed, and when it last worked, read from the logs of the sessions
 * the person is in. Keyed by the agent's id, which the session snapshot carries, so a renamed agent keeps its record.
 */

export interface AgentRecord {
  runs: number;
  done: number;
  failed: number;
  files: number;
  testsPassed: number;
  testsFailed: number;
  /** The newest run anywhere in the person's sessions, this week or not. */
  last?: { sid: string; at: number };
}

const blank = (): AgentRecord => ({ runs: 0, done: 0, failed: 0, files: 0, testsPassed: 0, testsFailed: 0 });

/** Which saved agent a lane runs, if any: the main lane's snapshot, or the lane's own. */
export function agentOfLane(state: SessionState, lane: string): string | undefined {
  if (lane === MAIN_LANE) return state.options.agent?.id;
  return state.lanes.find((l) => l.id === lane)?.agent?.id;
}

export function agentRecords(sessions: { state: SessionState; events: SessionEvent[] }[], now = Date.now(), days = 7): Record<string, AgentRecord> {
  const from = now - days * 86_400_000;
  const out: Record<string, AgentRecord> = {};
  for (const { state, events } of sessions) {
    const results = new Map<string, boolean | null>();
    for (const e of events) if (e.body.type === "tool.result") results.set(e.body.callId, commandFailed(e.body));
    for (const lane of [MAIN_LANE, ...state.lanes.map((l) => l.id)]) {
      const id = agentOfLane(state, lane);
      if (!id) continue;
      const mine = events.filter((e) => (e.lane ?? MAIN_LANE) === lane);
      let start = -1;
      for (let i = 0; i < mine.length; i++) {
        const e = mine[i]!;
        if (e.body.type === "run.started") start = i;
        if (e.body.type !== "run.ended" || start < 0) continue;
        const run = mine.slice(start, i + 1);
        start = -1;
        const r = (out[id] ??= blank());
        if (!r.last || e.ts > r.last.at) r.last = { sid: state.id, at: e.ts };
        if (e.ts < from) continue;
        r.runs++;
        if (e.body.outcome === "done") r.done++;
        else if (e.body.outcome === "error") r.failed++;
        const diff = run.findLast((x) => x.body.type === "agent.diff");
        const receipt = receiptOf({
          calls: run.flatMap((x) => (x.body.type === "agent.message" ? x.body.toolCalls : [])),
          failed: (callId) => (results.has(callId) ? results.get(callId)! : null),
          files: diff && diff.body.type === "agent.diff" ? diff.body.files : [],
        });
        r.files += receipt.files;
        if (receipt.tests === "pass") r.testsPassed++;
        else if (receipt.tests === "fail") r.testsFailed++;
      }
    }
  }
  return out;
}
