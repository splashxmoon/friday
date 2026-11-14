import type { Redis } from "ioredis";

/**
 * Decisions offered to a crew mate's memory (Code and Crew, connected, 2026-11-13: "Memory grows from the work. Decisions from a
 * session handed on are offered to the crew member's memory, with a yes from you. Nothing is written in silently").
 *
 * A message marked as decided is kept in its session's memory as `decision:<seq>` (session/core.ts "decide"). When a crew mate's
 * run there ends with decisions it hasn't been offered yet, its keeper is asked once, "Remember these for Kit?", with the list:
 * a yes adds them to its memory (MEMORY.md on this computer, the crew's memory on the hosted service), a no only marks them
 * offered. Either way the same ones are never asked about again in that session.
 */

/** One decision in a session: its memory key, the message's seq, and the line as the session keeps it ("Decided (Ada): …"). */
export interface Decision {
  key: string;
  seq: number;
  text: string;
}

const KEY = /^decision:(\d+)$/;

/** The session's decisions still standing, oldest first: a decision taken back is kept as an empty memory and is left out. */
export function decisionsOf(memory: readonly { key: string; text: string }[]): Decision[] {
  const out: Decision[] = [];
  for (const m of memory) {
    const hit = KEY.exec(m.key);
    if (hit && m.text.trim()) out.push({ key: m.key, seq: Number(hit[1]), text: m.text.trim() });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/**
 * What to offer now for a crew mate's lane: the decisions not offered before, once its run is over (not running, and it has
 * finished at least one run here). Nothing while it works, so the question comes at the end of the run, not in the middle.
 */
export function offerNow(decisions: readonly Decision[], offered: readonly string[], lane: { running: boolean; ended: number }): Decision[] {
  if (lane.running || lane.ended < 1) return [];
  const seen = new Set(offered);
  return decisions.filter((d) => !seen.has(d.key));
}

/** A decision as its line in a memory: the session's words, as a list item. */
export const memoryLine = (d: Pick<Decision, "text">): string => `- ${d.text.replace(/\s+/g, " ").trim()}`;

/**
 * The memory with these decisions added at the end, each once (a line already there isn't added again), or null when that makes
 * it longer than `max`, so the keeper tidies it first rather than losing the end of it.
 */
export function withDecisions(memory: string, decisions: readonly Pick<Decision, "text">[], max: number): { next: string; added: number } | null {
  const had = memory.trimEnd();
  const lines = new Set(had.split("\n").map((l) => l.trim()));
  const add = [...new Set(decisions.map(memoryLine))].filter((l) => !lines.has(l));
  if (!add.length) return { next: memory, added: 0 };
  const next = `${had}${had ? "\n" : ""}${add.join("\n")}\n`;
  return next.length > max ? null : { next, added: add.length };
}

/** How long a session's record of what was offered is kept after its last answer. */
const KEEP_S = 60 * 86_400;

/** Which decisions each crew mate was offered in a session, by session: answered yes or no, they aren't asked about again. */
export function offeredStore(redis: Redis, prefix: string) {
  const key = (sid: string) => `${prefix}crew:remembered:${sid}`;
  const read = async (sid: string, mate: string): Promise<string[]> => {
    try {
      const raw = await redis.hget(key(sid), mate);
      const v = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  const mark = async (sid: string, mate: string, keys: readonly string[]): Promise<string[]> => {
    const all = [...new Set([...(await read(sid, mate)), ...keys])].slice(-500);
    await redis.hset(key(sid), mate, JSON.stringify(all));
    await redis.expire(key(sid), KEEP_S);
    return all;
  };
  return { read, mark };
}
