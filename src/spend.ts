import { PRICES } from "./team-budget.js";
import { whyRun, type Why } from "./run-why.js";
import { MAIN_LANE, type SessionEvent } from "./types.js";

/**
 * What a crew mate or a room spent, every token accounted for (Arun, 2026-11-15: "we track everything like input, output, cache,
 * etc to see how much their total spend is for an agent or in a crew room too we want to basically audit everything and give
 * visibility to the user for them to trust an agent working autonomously").
 *
 * From the log alone: each turn's `agent.usage` as its tool reported it (fresh input, what it wrote to its cache, what it read back
 * from it, output and the reasoning in it, and the model), and Friday's own steps' tokens. Priced at the model's list price: on a
 * plan that is what the work would have cost on the API, the only dollar figure there is. A model with no known list price is
 * counted in tokens and said to be unpriced, never given a made-up figure.
 */

export interface Tokens {
  /** Read fresh, not from a cache. */
  input: number;
  /** Written to its cache (dearer than fresh input on Anthropic's models). */
  cacheWrite: number;
  /** Read back from its cache (a tenth of fresh input). */
  cacheRead: number;
  output: number;
  /** Of `output`, what went on reasoning, when the tool says. */
  reasoning: number;
}

/** Dollars per million tokens: fresh input, output, cache read, cache write. */
export interface Price {
  in: number;
  out: number;
  read: number;
  write: number;
}

export const NO_TOKENS: Tokens = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0 };
export const tokensTotal = (t: Tokens) => t.input + t.cacheWrite + t.cacheRead + t.output;
const add = (a: Tokens, b: Tokens): Tokens => ({ input: a.input + b.input, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead, output: a.output + b.output, reasoning: a.reasoning + b.reasoning });

/**
 * OpenAI's list prices (dollars per million: fresh in, out) for the models Codex runs, as published; a cached read is a tenth of
 * fresh input and writing to the cache costs nothing extra.
 */
const OPENAI: Record<string, [number, number]> = {
  "gpt-5": [1.25, 10],
  "gpt-5-codex": [1.25, 10],
  "gpt-5.1": [1.25, 10],
  "gpt-5.1-codex": [1.25, 10],
  "gpt-5-mini": [0.25, 2],
  "gpt-5.1-codex-mini": [0.25, 2],
  "gpt-5-nano": [0.05, 0.4],
};

/** A model id as its tool reports it, plain: no date ("-20251101"), no context tag ("[1m]"), no provider ("anthropic/"). */
export const plainModel = (id: string) =>
  id
    .trim()
    .toLowerCase()
    .replace(/^[a-z-]+\//, "")
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "");

/** The longest key of `table` the id is or starts with ("claude-opus-4-8-thinking" is claude-opus-4-8's). */
function lookup(table: Record<string, [number, number]>, id: string): [number, number] | null {
  if (table[id]) return table[id]!;
  const key = Object.keys(table)
    .filter((k) => id.startsWith(`${k}-`) || id.startsWith(`${k}.`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? table[key]! : null;
}

/** The list price of the model a turn ran on, or null when Friday doesn't know one. */
export function priceFor(tool: string | undefined, model: string | undefined): Price | null {
  if (!model) return null;
  const id = plainModel(model);
  const claude = lookup(PRICES, id);
  if (claude && (tool === "claude" || id.startsWith("claude") || ["opus", "sonnet", "haiku", "fable"].includes(id))) return { in: claude[0], out: claude[1], read: claude[0] / 10, write: claude[0] * 1.25 };
  const openai = lookup(OPENAI, id);
  if (openai) return { in: openai[0], out: openai[1], read: openai[0] / 10, write: openai[0] };
  return null;
}

/** What tokens cost at a price, each kind at its own rate. */
export const usdOf = (t: Tokens, p: Price) => (t.input * p.in + t.cacheWrite * p.write + t.cacheRead * p.read + t.output * p.out) / 1e6;

/** One turn's tokens from its `agent.usage`: `input` counts what it wrote to its cache, which is taken out here and kept apart. */
export function turnTokens(b: { input: number; cached: number; output: number; cacheWrite?: number; reasoning?: number }): Tokens {
  const write = Math.min(b.cacheWrite ?? 0, b.input);
  return { input: b.input - write, cacheWrite: write, cacheRead: b.cached ?? 0, output: b.output ?? 0, reasoning: Math.min(b.reasoning ?? 0, b.output ?? 0) };
}

/** A run in the audit: who did it, what started it, what it used and what that comes to. */
export interface SpendRun {
  sid: string;
  lane: string;
  /** The seq of its run.started, to find it in its chat. */
  seq: number;
  startedAt: number;
  endedAt: number | null;
  /** What it was asked, in a line. */
  ask: string;
  /** Why it started (run-why.ts): a person asked, a crew mate, a routine, a wake, Friday. */
  by: Why;
  tokens: Tokens;
  turns: number;
  /** The models it ran on. */
  models: string[];
  /** At list price; null when none of its models has one. */
  usd: number | null;
  /** Tokens it used on models with no known list price. */
  unpriced: number;
}

export interface Spend {
  tokens: Tokens;
  turns: number;
  usd: number;
  /** Tokens on models with no known list price, counted but not in `usd`. */
  unpriced: number;
  /** Of `usd`, what each kind of token came to. */
  usdByKind: { input: number; cacheWrite: number; cacheRead: number; output: number };
  /** What reading from the cache saved, against reading the same fresh, at list price. */
  cacheSaved: number;
  byModel: { model: string; tokens: Tokens; usd: number | null }[];
  /** By day (YYYY-MM-DD in the given zone), oldest first. */
  byDay: { day: string; tokens: number; usd: number }[];
  /** By crew mate (lane), for a room. */
  byLane: { sid: string; lane: string; tokens: Tokens; usd: number }[];
  runs: SpendRun[];
}

export interface Place {
  sid: string;
  lanes: string[];
  events: readonly SessionEvent[];
  /** The tool and model each lane runs on now, for turns that didn't say their model. */
  engines: Record<string, { tool?: string; model?: string } | undefined>;
}

const dayIn = (ts: number, tz?: string) => new Date(ts).toLocaleDateString("en-CA", { ...(tz ? { timeZone: tz } : {}), year: "numeric", month: "2-digit", day: "2-digit" });
const line = (s: string) => (s.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 160);

/** What the given lanes of these sessions spent from `from` (ms) on, split every way the audit shows it. */
export function spendOf(places: readonly Place[], from: number, tz?: string): Spend {
  let tokens = NO_TOKENS;
  let turns = 0;
  let usd = 0;
  let unpriced = 0;
  const usdByKind = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  let cacheSaved = 0;
  const byModel = new Map<string, { tokens: Tokens; usd: number | null }>();
  const byDay = new Map<string, { tokens: number; usd: number }>();
  const byLane = new Map<string, { sid: string; lane: string; tokens: Tokens; usd: number }>();
  const runs: SpendRun[] = [];
  for (const p of places) {
    const lanes = new Set(p.lanes);
    const open = new Map<string, SpendRun>();
    for (const e of p.events) {
      const lane = e.lane ?? MAIN_LANE;
      if (!lanes.has(lane)) continue;
      const b = e.body;
      if (b.type === "run.started") {
        const asked = b.causedBy !== undefined ? p.events.find((x) => x.seq === b.causedBy) : undefined;
        const ask = asked?.body.type === "instruction" ? line(asked.body.text.replace(/^\[(Check-in|Friday)\]\s*/, "")) : "";
        const by = whyRun(p.events, e);
        const r: SpendRun = { sid: p.sid, lane, seq: e.seq, startedAt: e.ts, endedAt: null, ask, by, tokens: NO_TOKENS, turns: 0, models: [], usd: null, unpriced: 0 };
        open.set(lane, r);
        if (e.ts >= from) runs.push(r);
        continue;
      }
      if (b.type === "run.ended") {
        const r = open.get(lane);
        if (r) r.endedAt = e.ts;
        continue;
      }
      let t: Tokens | null = null;
      let model: string | undefined;
      let tool: string | undefined;
      if (b.type === "agent.usage") {
        t = turnTokens(b);
        tool = b.tool ?? p.engines[lane]?.tool;
        model = b.model ?? p.engines[lane]?.model;
      } else if (b.type === "agent.message" && b.tokens) {
        t = { ...NO_TOKENS, input: b.tokens };
        tool = "friday";
      }
      if (!t || e.ts < from) continue;
      const price = priceFor(tool, model);
      const cost = price ? usdOf(t, price) : null;
      const name = model ? plainModel(model) : tool === "friday" ? "Friday's own model" : `${tool ?? "unknown"} (model not said)`;
      tokens = add(tokens, t);
      turns += b.type === "agent.usage" ? 1 : 0;
      if (cost === null || !price) unpriced += tokensTotal(t);
      else {
        usd += cost;
        usdByKind.input += (t.input * price.in) / 1e6;
        usdByKind.cacheWrite += (t.cacheWrite * price.write) / 1e6;
        usdByKind.cacheRead += (t.cacheRead * price.read) / 1e6;
        usdByKind.output += (t.output * price.out) / 1e6;
        cacheSaved += (t.cacheRead * (price.in - price.read)) / 1e6;
      }
      const m = byModel.get(name) ?? { tokens: NO_TOKENS, usd: null };
      byModel.set(name, { tokens: add(m.tokens, t), usd: cost === null ? m.usd : (m.usd ?? 0) + cost });
      const d = dayIn(e.ts, tz);
      const dd = byDay.get(d) ?? { tokens: 0, usd: 0 };
      byDay.set(d, { tokens: dd.tokens + tokensTotal(t), usd: dd.usd + (cost ?? 0) });
      const lk = `${p.sid} ${lane}`;
      const l = byLane.get(lk) ?? { sid: p.sid, lane, tokens: NO_TOKENS, usd: 0 };
      byLane.set(lk, { ...l, tokens: add(l.tokens, t), usd: l.usd + (cost ?? 0) });
      const r = open.get(lane);
      if (r && r.startedAt >= from) {
        r.tokens = add(r.tokens, t);
        r.turns += b.type === "agent.usage" ? 1 : 0;
        if (!r.models.includes(name)) r.models.push(name);
        if (cost === null) r.unpriced += tokensTotal(t);
        else r.usd = (r.usd ?? 0) + cost;
      }
    }
  }
  return {
    tokens,
    turns,
    usd,
    unpriced,
    usdByKind,
    cacheSaved,
    byModel: [...byModel].map(([model, v]) => ({ model, ...v })).sort((a, b) => tokensTotal(b.tokens) - tokensTotal(a.tokens)),
    byDay: [...byDay].map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day)),
    byLane: [...byLane.values()].sort((a, b) => b.usd - a.usd || tokensTotal(b.tokens) - tokensTotal(a.tokens)),
    runs: runs.filter((r) => tokensTotal(r.tokens) > 0).sort((a, b) => b.startedAt - a.startedAt),
  };
}
