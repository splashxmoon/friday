/**
 * Side threads in the Team room (Arun, 2026-10-27: the OpenBot gap "side threads"): a reply to a teammate's message, and that
 * teammate's answer to it, kept under the message they are about rather than in the room's main flow. A reply is an instruction
 * with `thread: { root }`; what the teammate says once it has been handed only replies to that thread belongs to the thread.
 *
 */
import { MAIN_LANE, type SessionEvent } from "../types.js";

/**
 * How a thread stands: its teammate still to answer its last reply, answered, or its turn ended on an error or was stopped
 * before it did (2026-10-27 audit: "Kit is answering…" stayed under a thread whose run had failed without a word).
 */
export type ThreadState = "answering" | "answered" | "failed" | "stopped";

export interface Threads {
  /** Each thread's messages, oldest first: the person's replies and the teammate's answers. */
  byRoot: Map<number, SessionEvent[]>;
  /** Seqs the room's main flow leaves out: the replies, and the answers' messages. */
  hidden: Set<number>;
  /** How each thread with replies stands. */
  state: Map<number, ThreadState>;
}

let cached: { events: SessionEvent[]; out: Threads } | null = null;

/**
 * The threads of a session's log, worked out once per log. Which thread a turn's words belong to is read from what the turn was
 * handed, each time it is handed more (2026-10-27 audit: decided only at the turn's start, a reply handed to a teammate mid-turn
 * left its answer in the main flow, and a reply queued with a message to the room took that message's answer into the thread):
 * from a delivery of replies to one thread only, its words go to that thread, until the next delivery or the turn's end.
 */
export function threadsOf(events: SessionEvent[]): Threads {
  if (cached?.events === events) return cached.out;
  const byRoot = new Map<number, SessionEvent[]>();
  const hidden = new Set<number>();
  const state = new Map<number, ThreadState>();
  const rootOf = new Map<number, number>();
  const add = (root: number, e: SessionEvent) => {
    const list = byRoot.get(root) ?? [];
    list.push(e);
    byRoot.set(root, list);
    hidden.add(e.seq);
  };
  /** The thread each lane's turn is answering now, if its words go to one. */
  const runRoot = new Map<string, number>();
  /** The threads whose replies each lane's turn has been handed: it ending settles how they stand. */
  const handed = new Map<string, Set<number>>();
  /** The threads with a reply on each lane still to settle, handed or still queued: a Stop drops the queued ones too. */
  const asked = new Map<string, Set<number>>();
  const hand = (lane: string, seqs: readonly number[]) => {
    const roots = seqs.map((s) => rootOf.get(s));
    const set = handed.get(lane) ?? new Set<number>();
    for (const r of roots) if (r !== undefined) set.add(r);
    handed.set(lane, set);
    const first = roots[0];
    if (roots.length && first !== undefined && roots.every((r) => r === first)) runRoot.set(lane, first);
    else runRoot.delete(lane);
  };
  for (const e of events) {
    const lane = e.lane ?? MAIN_LANE;
    const b = e.body;
    if (b.type === "instruction" && b.thread) {
      rootOf.set(e.seq, b.thread.root);
      add(b.thread.root, e);
      state.set(b.thread.root, "answering");
      (asked.get(lane) ?? asked.set(lane, new Set()).get(lane)!).add(b.thread.root);
    } else if (b.type === "run.started") {
      handed.delete(lane);
      // What started it, until the delivery that follows says all it was handed (older logs have no delivery).
      hand(lane, [b.causedBy]);
    } else if (b.type === "instructions.delivered") {
      hand(lane, b.seqs);
    } else if (b.type === "run.ended") {
      const root = runRoot.get(lane);
      // A thread's turn that ended without a word (an error, a stop) is the thread's too, not a row in the room.
      if (root !== undefined) hidden.add(e.seq);
      for (const r of handed.get(lane) ?? []) {
        if (state.get(r) === "answering") state.set(r, b.outcome === "error" ? "failed" : "answered");
        asked.get(lane)?.delete(r);
      }
      runRoot.delete(lane);
      handed.delete(lane);
    } else if (b.type === "run.cancel") {
      // Stopped: its turn is over and what was queued for it is dropped, so nothing it was asked in a thread is coming.
      for (const r of [...(handed.get(lane) ?? []), ...(asked.get(lane) ?? [])]) if (state.get(r) === "answering") state.set(r, "stopped");
      if (runRoot.has(lane)) hidden.add(e.seq);
      runRoot.delete(lane);
      handed.delete(lane);
      asked.delete(lane);
    } else if (b.type === "run.pause") {
      // Stopped with its queue kept (the chat's Stop, the sidebar's, Stop all): the turn under way is over, so a thread it was
      // answering is "stopped", but a reply still queued is still coming (Arun, 2026-10-28: "run an audit on the teams stuff…";
      // it said "Kit is answering…" for good after a Stop).
      for (const r of handed.get(lane) ?? []) if (state.get(r) === "answering") (state.set(r, "stopped"), asked.get(lane)?.delete(r));
      if (runRoot.has(lane)) hidden.add(e.seq);
      runRoot.delete(lane);
      handed.delete(lane);
    } else if (b.type === "lane.removed") {
      // Its teammate taken out of the room or off the team: nothing it was asked in a thread is coming.
      for (const r of [...(handed.get(b.laneId) ?? []), ...(asked.get(b.laneId) ?? [])]) if (state.get(r) === "answering") state.set(r, "stopped");
      runRoot.delete(b.laneId);
      handed.delete(b.laneId);
      asked.delete(b.laneId);
    } else if (b.type === "instruction.withdrawn") {
      // A reply taken back before it was picked up: its thread waits for nothing more unless another reply is still out.
      const root = rootOf.get(b.seq);
      if (root !== undefined && state.get(root) === "answering") {
        const out = [...asked.values()].some((set) => set.has(root)) && events.some((x) => x.seq !== b.seq && x.body.type === "instruction" && x.body.thread?.root === root && x.seq > b.seq);
        if (!out) state.set(root, (byRoot.get(root) ?? []).some((x) => x.body.type === "agent.message") ? "answered" : "stopped");
        for (const set of asked.values()) if (!out) set.delete(root);
      }
    } else if (b.type === "agent.message" && runRoot.has(lane)) {
      if (b.text.trim()) add(runRoot.get(lane)!, e);
      else hidden.add(e.seq);
    }
  }
  const out = { byRoot, hidden, state };
  cached = { events, out };
  return out;
}
