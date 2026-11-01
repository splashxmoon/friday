import type { Redis } from "ioredis";
import type { RunRecord, Moved } from "./forecast.js";
import { taskOf } from "./forecast.js";
import { limitedTask } from "./limit-handoff.js";
import { BENCH_ASOF, benchFor } from "./model-bench.js";
import { repoKeyOf } from "./repo-key.js";
import { gradeOf, NOT_THE_MODEL, ranOn, TOOL_DEFAULT } from "./route-learning.js";
import type { SessionState } from "./session/projection.js";
import { MAIN_LANE, type SessionEvent } from "./types.js";

/**
 * Where forecasts and routing's learning keep what they stand on (forecast.ts): a record of every finished run, built from the
 * session's log as the run ends, and the store they are kept in.
 */

/** The repo a lane is on, as the brain names it (repo-key.ts). */
export function repoOfLane(state: SessionState, lane: string): string | undefined {
  const engine = state.engines[lane] ?? state.engines[MAIN_LANE];
  if (engine) return repoKeyOf({ url: engine.repo ?? null, github: engine.repo && /^[\w.-]+\/[\w.-]+$/.test(engine.repo) ? engine.repo : null }, engine.cwd)?.key;
  return state.upload ? repoKeyOf(null, state.upload.name)?.key : undefined;
}

/** The model a lane runs, as routing names it: the last pick Auto made, else the one it was started with, else the tool's default. */
export function modelOf(state: SessionState, events: SessionEvent[], lane: string, before = Number.MAX_SAFE_INTEGER): string {
  const routed = events.findLast((e) => e.seq < before && (e.lane ?? MAIN_LANE) === lane && e.body.type === "model.routed");
  if (routed?.body.type === "model.routed") {
    const r = ranOn(routed.body);
    if (r) return r.model;
  }
  const e = state.engines[lane];
  if (!e?.tool) return "";
  const id = e.model && e.model !== "auto" ? e.model : (TOOL_DEFAULT[e.tool] ?? "");
  return benchFor(e.tool, id) ? id : "";
}


/** The record of the run that ended at `end`, or null when it teaches nothing (stopped to ask, cut off, an account's error). */
export function recordOf(state: SessionState, events: SessionEvent[], end: SessionEvent): RunRecord | null {
  const b = end.body;
  if (b.type !== "run.ended" || b.outcome === "waiting" || b.cut || (b.outcome !== "done" && b.outcome !== "error")) return null;
  if (b.outcome === "error" && NOT_THE_MODEL.test(b.error ?? "")) return null;
  const lane = end.lane ?? MAIN_LANE;
  const start = events.findLast((e) => e.seq < end.seq && (e.lane ?? MAIN_LANE) === lane && e.body.type === "run.started");
  if (!start) return null;
  const text = limitedTask(events, lane, start.seq, end.seq);
  if (!text) return null;
  const engine = state.engines[lane];
  const tool = engine?.tool ?? "friday";
  let input = 0;
  let output = 0;
  for (const e of events) {
    if (e.seq <= start.seq || e.seq > end.seq || (e.lane ?? MAIN_LANE) !== lane || e.body.type !== "agent.usage") continue;
    input += e.body.input;
    output += e.body.output;
  }
  const model = modelOf(state, events, lane, end.seq);
  const price = benchFor(tool, model)?.inPrice ?? 0;
  const repo = repoOfLane(state, lane);
  return {
    at: end.ts,
    tool,
    model,
    ...taskOf(text),
    ...(repo ? { repo } : {}),
    ...(engine?.tool ? { host: engine.hostId } : {}),
    ms: Math.max(0, end.ts - start.ts),
    tokens: input + output,
    cost: Math.round(((input + 5 * output) / 1e6) * price * 10_000) / 10_000,
    grade: b.outcome === "error" ? 0 : gradeOf(events, lane, end.seq),
    asof: BENCH_ASOF,
  };
}

/** How many runs a workspace keeps: plenty for medians per repo and kind, and small enough to read whole. */
const CAP = 600;

/**
 * The run records, and what was learnt from them, in Redis per workspace (the local edition's file-backed store is the same
 * shape): records by run, so a later grade revises the one it is about; each plan's tokens per window percent, per person and
 * tool; and when each learned preference was last reset.
 */
export class RunLog {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  private key = (ws: string) => `${this.prefix}runlog:${ws}`;

  async add(ws: string, run: string, rec: RunRecord): Promise<void> {
    await this.redis.hset(this.key(ws), run, JSON.stringify(rec));
    if ((await this.redis.hlen(this.key(ws))) <= CAP + 50) return;
    const all = await this.all(ws);
    const old = all.sort((a, b) => a.rec.at - b.rec.at).slice(0, all.length - CAP);
    if (old.length) await this.redis.hdel(this.key(ws), ...old.map((x) => x.run));
  }

  /** A later word on a run (an undo, a review, a correction, a reaction, the board's check): its grade set, lowered, raised or scaled. */
  async revise(ws: string, run: string, grade: number, how: "set" | "min" | "max" | "mul"): Promise<void> {
    const raw = await this.redis.hget(this.key(ws), run);
    if (!raw) return;
    const rec = JSON.parse(raw) as RunRecord;
    const next = how === "set" ? grade : how === "min" ? Math.min(rec.grade, grade) : how === "max" ? Math.max(rec.grade, grade) : rec.grade * grade;
    if (next !== rec.grade) await this.redis.hset(this.key(ws), run, JSON.stringify({ ...rec, grade: next }));
  }

  private async all(ws: string): Promise<{ run: string; rec: RunRecord }[]> {
    const h = await this.redis.hgetall(this.key(ws)).catch(() => ({}) as Record<string, string>);
    return Object.entries(h).flatMap(([run, raw]) => {
      try {
        return [{ run, rec: JSON.parse(raw) as RunRecord }];
      } catch {
        return [];
      }
    });
  }

  async records(ws: string): Promise<RunRecord[]> {
    return (await this.all(ws)).map((x) => x.rec).sort((a, b) => a.at - b.at);
  }

  /** A person's plan for a tool: tokens per percent of its fastest window, learnt from readings (BurnTracker.read). */
  async perPct(ws: string, host: string, tool: string): Promise<number | null> {
    const v = Number(await this.redis.hget(`${this.key(ws)}:perpct`, `${host}|${tool}`));
    return v > 0 ? v : null;
  }

  async perPctOf(ws: string, host: string): Promise<Record<string, number>> {
    const h = await this.redis.hgetall(`${this.key(ws)}:perpct`).catch(() => ({}) as Record<string, string>);
    return Object.fromEntries(Object.entries(h).flatMap(([k, v]) => (k.startsWith(`${host}|`) && Number(v) > 0 ? [[k.slice(host.length + 1), Number(v)]] : [])));
  }

  /** What two readings showed, folded in: most of the old figure, some of the new, so one odd reading doesn't swing it. */
  async learnPerPct(ws: string, host: string, tool: string, m: Moved): Promise<void> {
    if (m.pct < 1 || m.tokens <= 0) return;
    const seen = m.tokens / m.pct;
    const was = await this.perPct(ws, host, tool);
    await this.redis.hset(`${this.key(ws)}:perpct`, `${host}|${tool}`, String(Math.round(was ? 0.7 * was + 0.3 * seen : seen)));
  }

  /** When each preference was last reset, by scope (`${repo}|${kind}`, or "*" for everything). */
  async resets(ws: string): Promise<Record<string, number>> {
    const h = await this.redis.hgetall(`${this.key(ws)}:resets`).catch(() => ({}) as Record<string, string>);
    return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, Number(v) || 0]));
  }

  async reset(ws: string, scope: string, now = Date.now()): Promise<void> {
    await this.redis.hset(`${this.key(ws)}:resets`, scope, String(now));
  }
}
