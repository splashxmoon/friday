import { MAIN_LANE, type SessionEvent } from "./types.js";

/**
 * What this session has used, and who and what it went on.
 *
 * Read from the log and nothing else: every step an agent takes records the tokens the provider counted for it, every run
 * records the instruction that started it, and every instruction has an author. So the totals can be split by agent and by
 * person without the server keeping a second set of books.
 *
 * Tokens, not dollars. The provider's count is the true number; a price per token depends on the model and on the plan,
 * and a figure we made up from it would be a number nobody could check.
 */

export interface UsageRow {
  /** A lane id or a person's id. */
  key: string;
  label: string;
  tokens: number;
  runs: number;
  /** Seconds the runs took, summed. */
  seconds: number;
  /** When the latest of its runs last did anything (a run's end, or now while it is going). */
  lastAt: number;
  /** Whether one of its runs is going right now. */
  running: boolean;
  /** Whether anything here reported a token count. A coding tool on somebody's own machine does not: its use is on their plan, not ours. */
  counted: boolean;
}

export interface RunUsage {
  /** The seq of the run.started event, stable between polls. */
  seq: number;
  lane: string;
  agent: string;
  /** Who asked, or "" for a run nobody asked for (a trigger, a schedule). */
  by: string;
  ts: number;
  seconds: number;
  tokens: number;
  /** Whether the provider said what this run cost. */
  counted: boolean;
  outcome: "done" | "waiting" | "error" | "running";
  /** What was asked, clipped. */
  task: string;
}

export interface UsageReport {
  tokens: number;
  runs: number;
  seconds: number;
  byAgent: UsageRow[];
  byPerson: UsageRow[];
  /** Newest first. */
  recent: RunUsage[];
  /** The biggest single run, for "what was expensive". */
  biggest: RunUsage | null;
}

const AUTO = "automatic";

/**
 * `live` is the lanes whose run is going right now, from the session's own state. A run in the log with no end that is not
 * in it was cut off (a crash, a machine that went away), and is counted up to its last step, not to this moment: an agent
 * that stopped yesterday did not work for a day.
 */
export function usageReport(events: SessionEvent[], nameOf: (lane: string) => string, live: ReadonlySet<string> | null = null, now = Date.now()): UsageReport {
  const bySeq = new Map<number, SessionEvent>();
  for (const e of events) bySeq.set(e.seq, e);
  const lastTs = new Map<string, number>();

  const open = new Map<string, RunUsage>();
  const runs: RunUsage[] = [];
  const agents = new Map<string, UsageRow>();
  const people = new Map<string, UsageRow>();
  const row = (m: Map<string, UsageRow>, key: string, label: string) => {
    let r = m.get(key);
    if (!r) m.set(key, (r = { key, label, tokens: 0, runs: 0, seconds: 0, counted: false, lastAt: 0, running: false }));
    return r;
  };

  const close = (r: RunUsage, end: number, outcome: RunUsage["outcome"]) => {
    r.seconds = Math.max(0, Math.round((end - r.ts) / 1000));
    r.outcome = outcome;
    runs.push(r);
    for (const x of [row(agents, r.lane, r.agent), row(people, r.by || AUTO, r.by || "Automatic runs")]) {
      x.runs++;
      x.seconds += r.seconds;
      x.tokens += r.tokens;
      x.counted ||= r.counted;
      x.lastAt = Math.max(x.lastAt, r.ts + r.seconds * 1000);
      x.running ||= r.outcome === "running";
    }
  };

  for (const e of events) {
    const lane = e.lane ?? MAIN_LANE;
    lastTs.set(lane, e.ts);
    const b = e.body;
    if (b.type === "run.started") {
      const stale = open.get(lane);
      if (stale) close(stale, e.ts, "done");
      const cause = bySeq.get(b.causedBy);
      const by = cause && cause.body.type === "instruction" ? cause.actor.name : "";
      const task = cause && cause.body.type === "instruction" ? cause.body.text.replace(/\s+/g, " ").trim().slice(0, 140) : "";
      open.set(lane, { seq: e.seq, lane, agent: nameOf(lane), by, ts: e.ts, seconds: 0, tokens: 0, counted: false, outcome: "running", task });
    } else if (b.type === "agent.message" || b.type === "agent.usage") {
      // Friday's steps carry their tokens; a coding tool reports a turn's at its end.
      const t = b.type === "agent.usage" ? b.input + b.cached + b.output : b.tokens;
      const r = open.get(lane);
      if (r && t !== undefined) {
        r.tokens += t;
        r.counted = true;
      }
    } else if (b.type === "run.ended") {
      const r = open.get(lane);
      if (r) {
        close(r, e.ts, b.outcome);
        open.delete(lane);
      }
    }
  }
  for (const r of open.values()) {
    if (live === null || live.has(r.lane)) close(r, now, "running");
    else close(r, lastTs.get(r.lane) ?? r.ts, "done");
  }

  const byTokens = (a: UsageRow, b: UsageRow) => b.tokens - a.tokens || b.runs - a.runs;
  const recent = [...runs].sort((a, b) => b.ts - a.ts);
  const biggest = runs.reduce<RunUsage | null>((m, r) => (r.tokens > (m?.tokens ?? 0) ? r : m), null);
  return {
    tokens: runs.reduce((n, r) => n + r.tokens, 0),
    runs: runs.length,
    seconds: runs.reduce((n, r) => n + r.seconds, 0),
    byAgent: [...agents.values()].sort(byTokens),
    byPerson: [...people.values()].sort(byTokens),
    recent,
    biggest,
  };
}

/** 1,240 → "1.2k", 48,000 → "48k", 2,100,000 → "2.1M". */
export function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** 75 → "1m 15s", 3700 → "1h 1m". */
export function shortDuration(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
