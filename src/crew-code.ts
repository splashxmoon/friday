import type { Redis } from "ioredis";
import { SESSION_LANES } from "./types.js";

/**
 * A crew mate brought into a coding session (Code and Crew, connected, ported to the open-source edition from Friday Teams
 * 6e231ada, 79b27a67 and cdd44714): "Add Rex to a coding session as a lane, with its memory and role. 'Add an agent' lists your
 * crew first".
 *
 * On this computer your crew is yours alone (teammates.ts), so there is no keeper but you, nobody else's crew mate to ask, and no
 * lending. A crew mate is added from the session's Add an agent menu: a lane there, driven by you, run by its own tool, model and
 * account, in the session's folder, with its role and memory in its note each turn. It keeps a conversation of its own there
 * (visitKeep). Removed, the lane leaves and its tool there stops; the crew mate itself, its memory and its other places are
 * untouched.
 *
 * "Keep this going" (crew-carry.ts) brings one in the same way, in a copy of the session's folder of its own on its own branch
 * (`copy`), so its work comes back in by a merge.
 */

/** One crew mate's lane in a coding session. */
export interface Visit {
  mate: string;
  sid: string;
  lane: string;
  at: number;
  /** Brought in for a hand-off (Keep this going): it works in a copy of the session's folder of its own, on its own branch. */
  copy?: true;
}

/** The conversation a crew mate keeps in a coding session (Runner keepAs): its own, never its Crew chat's or a room's. */
export const visitKeep = (mate: string, sid: string): string => `${mate}.visit.${sid}`;

/** What visitRefusal reads of the session. */
export interface VisitPlace {
  options: { team?: boolean };
  members: Record<string, { role: string; removed?: boolean }>;
  lanes: readonly { id: string }[];
}

/**
 * Why `me` can't bring crew mate `t` into this session, or null when they may: only into a coding session (a crew room brings its
 * crew in from its own menu) that they may steer, not twice, and not past the session's most agents.
 */
export function visitRefusal(state: VisitPlace | null, me: string, t: { id: string; name: string }, here: readonly Visit[], mayControl: boolean): string | null {
  if (!state) return "That session isn't there any more.";
  if (state.options.team) return "Crew rooms bring crew mates in from their own menu.";
  const m = state.members[me];
  if (!m || m.removed || !mayControl) return "You can't add agents to this session.";
  if (here.some((v) => v.mate === t.id && state.lanes.some((l) => l.id === v.lane))) return `${t.name} is already in this session.`;
  if (state.lanes.length >= SESSION_LANES) return `A session runs up to ${SESSION_LANES} agents beside the main one, and this one has them all.`;
  return null;
}

/**
 * A crew mate's note in a coding session (EngineHub.teammate): who it is, where it is and with whom, its role, the session's rules
 * for it, and its memory, read into its note each turn.
 */
export function visitNote(
  t: { name: string; role?: string },
  runsOn: string,
  place: { title: string; with: readonly string[]; /** Its own copy of the session's folder, for a hand-off. */ copy?: { path: string; branch?: string } },
  memory: { file: string; text: string; how: string },
): string {
  return [
    `You are ${t.name}, one of the person's AI crew mates in Friday, running on their ${runsOn} on their own computer. They brought you into the coding session "${place.title}"${place.with.length ? ` with ${place.with.join(", ")}` : ""}, as an agent beside the others there.`,
    t.role ? `Your role, in their words: ${t.role}` : "You have no set role: help with what you are given.",
    "Only the person drives you here.",
    place.copy
      ? `You work in a copy of the session's folder of your own, ${place.copy.path}${place.copy.branch ? `, on the branch ${place.copy.branch}` : ""}: commit your work there, on that branch, and the session brings it in from there. Never change the session's own folder.`
      : "Work in the session's folder and on its branch, as the other agents here do. Before you change files another agent may be in, claim them with Friday's claim_files.",
    "Don't start work nobody gave you.",
    "When you finish, lead with the outcome in a few lines: what you did, what is left, what you need. Say it once.",
    `Your memory is ${memory.file}: what you learn that you will want next time. ${memory.how}, in short lines; keep it under a page.${memory.text.trim() ? `\nWhat it holds now:\n${memory.text.trim()}` : " It is empty so far."}`,
  ].join("\n");
}

/**
 * A role as the one short line under a crew mate's name in a menu: its first line, cut at a word to fit the narrowest of them (the
 * box's Send to, 220px wide) so it never wraps to a second.
 */
export const roleHint = (role: string, max = 22): string => {
  const line = role.split("\n")[0]!.replace(/\s+/g, " ").trim().replace(/[.:;,]$/, "");
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > 8 ? cut.slice(0, at) : cut).replace(/[\s.,:;]+$/, "")}…`;
};

/** Where each crew mate is in coding sessions, kept in the local store beside the crew (teammates.ts). */
export function visitStore(redis: Redis, prefix: string) {
  const key = `${prefix}teammates:visits`;
  const field = (sid: string, lane: string) => `${sid}|${lane}`;
  const parse = (raw: string | null | undefined): Visit | null => {
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as Visit;
      return typeof v.mate === "string" && typeof v.sid === "string" && typeof v.lane === "string" ? v : null;
    } catch {
      return null;
    }
  };
  const all = async (): Promise<Visit[]> => (await redis.hvals(key)).flatMap((r) => ((v) => (v ? [v] : []))(parse(r))).sort((a, b) => a.at - b.at);
  return {
    put: async (v: Visit) => void (await redis.hset(key, field(v.sid, v.lane), JSON.stringify(v))),
    get: async (sid: string, lane: string) => parse(await redis.hget(key, field(sid, lane))),
    drop: async (v: Pick<Visit, "sid" | "lane">) => void (await redis.hdel(key, field(v.sid, v.lane))),
    /** Every crew mate's lane in every coding session. */
    all,
    /** Every crew mate's lane in a session. */
    inSession: async (sid: string) => (await all()).filter((v) => v.sid === sid),
    /** Every coding session lane of a crew mate's. */
    ofMate: async (mate: string) => (await all()).filter((v) => v.mate === mate),
  };
}

export type VisitStore = ReturnType<typeof visitStore>;
