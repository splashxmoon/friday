import { MAIN_LANE, type SessionEvent } from "./types.js";

/**
 * Rewinding a session to before one of its messages.
 *
 * An undo puts the files back and leaves the agent remembering everything it did. A rewind goes the whole way: the files
 * go back to how they were before that message was acted on, and the agent's memory of the conversation goes with them,
 * so it carries on from the message before as if the later work had not happened. The log stays append-only, so none of
 * it is deleted. The rewind is an event naming where it went back to, and the agent's context and the feed both read it.
 */

export interface Rewind {
  /** The message the session went back to before: it, and everything after it in this lane, is set aside. */
  from: number;
  /** The restore event that did it. */
  to: number;
  lane: string;
}

export function rewindsIn(events: SessionEvent[]): Rewind[] {
  const out: Rewind[] = [];
  for (const e of events) if (e.body.type === "folder.restored" && e.body.rewoundTo !== undefined) out.push({ from: e.body.rewoundTo, to: e.seq, lane: e.lane ?? MAIN_LANE });
  return out;
}

/** Whether something in this lane was set aside by a rewind. */
export function isSetAside(rewinds: Rewind[], seq: number, lane: string): boolean {
  return rewinds.some((r) => r.lane === lane && seq >= r.from && seq < r.to);
}

/** What the agent remembers is conversation: what was said, done and answered. Notices from the session stay. */
const CONVERSATION = new Set(["instruction", "instructions.delivered", "agent.message", "tool.result", "agent.question", "run.cancel", "run.resume"]);

/** The log with the rewound stretches taken out of the agent's memory. */
export function withoutRewound(events: SessionEvent[]): SessionEvent[] {
  const rs = rewindsIn(events);
  if (!rs.length) return events;
  return events.filter((e) => !(CONVERSATION.has(e.body.type) && isSetAside(rs, e.seq, e.lane ?? MAIN_LANE)));
}

/**
 * The checkpoint a message can be rewound to: the one taken as the first run after it started.
 * A message with no run after it, or whose run was taken outside a git folder, has none.
 */
export function checkpointBefore(events: SessionEvent[], seq: number): string | null {
  const msg = events.find((e) => e.seq === seq);
  if (!msg || msg.body.type !== "instruction") return null;
  const lane = msg.lane ?? MAIN_LANE;
  const run = events.find((e) => e.seq > seq && (e.lane ?? MAIN_LANE) === lane && e.body.type === "run.started");
  return (run && startCheckpoint(events, run)) ?? null;
}

/**
 * The checkpoint a run started from: on its `run.started`, or, from a runner that takes it itself, the `run.checkpoint` said on
 * its lane after that start and before the next one.
 */
export function startCheckpoint(events: SessionEvent[], start: SessionEvent): string | undefined {
  if (start.body.type !== "run.started") return undefined;
  if (start.body.checkpoint) return start.body.checkpoint;
  const lane = start.lane ?? MAIN_LANE;
  for (let i = events.indexOf(start) + 1; i > 0 && i < events.length; i++) {
    const e = events[i]!;
    if ((e.lane ?? MAIN_LANE) !== lane) continue;
    if (e.body.type === "run.started") return undefined;
    if (e.body.type === "run.checkpoint") return e.body.checkpoint;
  }
  return undefined;
}

/** A run's start, or its checkpoint said after it, that took checkpoint `sha`. */
export function tookCheckpoint(e: SessionEvent, sha: string): boolean {
  return (e.body.type === "run.started" || e.body.type === "run.checkpoint") && e.body.checkpoint === sha;
}

/** What a rewind to before this message would set aside, for the question asked first. */
export function rewindImpact(events: SessionEvent[], seq: number): { runs: number; files: number; messages: number } {
  const msg = events.find((e) => e.seq === seq);
  const lane = msg?.lane ?? MAIN_LANE;
  const rs = rewindsIn(events);
  let runs = 0;
  let messages = 0;
  const files = new Set<string>();
  for (const e of events) {
    if (e.seq < seq || (e.lane ?? MAIN_LANE) !== lane || isSetAside(rs, e.seq, lane)) continue;
    if (e.body.type === "run.started") runs++;
    else if (e.body.type === "instruction" && !e.body.text.startsWith("[session]")) messages++;
    else if (e.body.type === "folder.edited") files.add(e.body.path);
  }
  return { runs, files: files.size, messages };
}

/** For each message, the checkpoint a rewind to before it would use. One pass over the log. */
export function checkpointsByMessage(events: SessionEvent[]): Map<number, string> {
  const out = new Map<number, string>();
  const waiting = new Map<string, number[]>();
  /** The messages the lane's last run started on, for its checkpoint said after the start (`run.checkpoint`). */
  const started = new Map<string, number[]>();
  for (const e of events) {
    const lane = e.lane ?? MAIN_LANE;
    if (e.body.type === "instruction") waiting.set(lane, [...(waiting.get(lane) ?? []), e.seq]);
    else if (e.body.type === "run.started") {
      const sha = e.body.checkpoint;
      const msgs = waiting.get(lane) ?? [];
      if (sha) for (const q of msgs) out.set(q, sha);
      started.set(lane, sha ? [] : msgs);
      waiting.delete(lane);
    } else if (e.body.type === "run.checkpoint") {
      for (const q of started.get(lane) ?? []) out.set(q, e.body.checkpoint);
      started.delete(lane);
    }
  }
  return out;
}

/**
 * Where the run that started at checkpoint `sha` left the folder, when its end was saved: an undo of it puts back only that.
 *
 * A redo goes back to the checkpoint an undo took (its `undo`), and is bounded the same way by where the undo left the
 * folder (its `after`): it puts back only what the undo changed, not every file edited since.
 */
export function runEndAfter(events: SessionEvent[], lane: string, sha: string): string | undefined {
  const start = events.find((e) => (e.lane ?? MAIN_LANE) === lane && tookCheckpoint(e, sha));
  if (!start) {
    const undone = events.findLast((e) => (e.lane ?? MAIN_LANE) === lane && e.body.type === "folder.restored" && e.body.undo === sha);
    return undone?.body.type === "folder.restored" ? undone.body.after : undefined;
  }
  const end = events.find((e) => e.seq > start.seq && (e.lane ?? MAIN_LANE) === lane && e.body.type === "run.ended");
  return end?.body.type === "run.ended" ? end.body.after : undefined;
}

/**
 * Whether another agent working in the same folder (`sharers`, its lanes) worked while the run that took checkpoint `sha` on
 * `lane` did, or at any time since when the undo isn't bounded by where the run left the folder (`bounded` false). An undo
 * compares the folder with the checkpoint and puts back every difference, so what the other agent made or changed in that
 * time would go with it: a picture it finished while this run went on would be deleted as this run's (Arun, 2026-10-28:
 * "iron everything and ensure we are good… any logic errors"). True too when it can't be told when the run was.
 */
export function sharedWorkDuring(events: SessionEvent[], lane: string, sha: string, sharers: Set<string>, bounded: boolean): boolean {
  if (!sharers.size) return false;
  const on = (e: SessionEvent) => e.lane ?? MAIN_LANE;
  let from: number;
  let to = Infinity;
  const start = events.find((e) => on(e) === lane && tookCheckpoint(e, sha));
  if (start) {
    from = start.seq;
    const end = events.find((e) => e.seq > start.seq && on(e) === lane && e.body.type === "run.ended");
    if (bounded && end) to = end.seq;
  } else {
    // A redo: the undo it reverses is the moment, and bounded by where that undo left the folder, it touches only what it did.
    const undone = events.findLast((e) => on(e) === lane && e.body.type === "folder.restored" && e.body.undo === sha);
    if (!undone) return true;
    from = undone.seq;
    if (bounded) to = undone.seq;
  }
  const open = new Map<string, number>();
  for (const e of events) {
    const l = on(e);
    if (!sharers.has(l)) continue;
    if (e.body.type === "run.started") open.set(l, e.seq);
    else if (e.body.type === "run.ended" && open.has(l)) {
      if (open.get(l)! <= to && e.seq >= from) return true;
      open.delete(l);
    }
  }
  // A run of theirs still going (or never said to end) that began before the window closed.
  return [...open.values()].some((s) => s <= to);
}
