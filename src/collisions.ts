import { MAIN_LANE } from "./types.js";
import type { FileClaim, SessionState } from "./session/projection.js";

/**
 * Two lanes, one file.
 *
 * Lanes are the whole point of this product and they all write into the same
 * folder, so two agents changing the same file is not an edge case — it is
 * Tuesday. Until now nothing noticed: the second write landed on top of the
 * first, both diffs looked fine on their own, and the only way to find out
 * was to read the result.
 *
 * This is deliberately a warning and not a lock. A lock would need a lane to
 * declare every file before it starts, which no coding agent can honestly do,
 * and it would stop the common harmless case — one lane adding an import to a
 * file another lane is rewriting — in order to catch the rare bad one. Saying
 * plainly who else has touched this file, and when, is the thing a person can
 * act on.
 */

export interface Collision {
  path: string;
  /** Every lane that has touched this file since the last commit, newest first. */
  claims: FileClaim[];
}

/** The lane that got there first, which is the one whose work is at risk. */
export function firstClaim(c: Collision): FileClaim {
  return c.claims[c.claims.length - 1]!;
}

/**
 * Files more than one lane has touched since the last commit.
 *
 * Sorted by how recently the collision was made, so the one somebody is
 * standing in front of is first.
 */
export function collisionsOf(state: SessionState): Collision[] {
  const byPath = new Map<string, FileClaim[]>();
  for (const c of state.claims) {
    const list = byPath.get(c.path) ?? [];
    list.push(c);
    byPath.set(c.path, list);
  }
  return [...byPath.entries()]
    .filter(([, cs]) => new Set(cs.map((c) => c.lane)).size > 1)
    .map(([path, cs]) => ({ path, claims: [...cs].sort((a, b) => b.seq - a.seq) }))
    .sort((a, b) => b.claims[0]!.seq - a.claims[0]!.seq);
}

/**
 * Just the ones a given lane is part of, for a warning shown inside that lane: with the lanes working in the same project. Two
 * agents in two different repositories both changing src/index.ts were told they collided. A lane with no folder of its own
 * works in the main one's, and one whose folder isn't known is counted in, as before.
 */
export function collisionsFor(state: SessionState, lane: string): Collision[] {
  const keys = (id: string) => projectsOf({ engines: { x: state.engines[id] ?? state.engines[MAIN_LANE]! } });
  const mine = keys(lane);
  const shares = (id: string) => {
    const theirs = keys(id);
    return !mine.size || !theirs.size || [...theirs].some((k) => mine.has(k));
  };
  return collisionsOf(state)
    .filter((c) => c.claims.some((x) => x.lane === lane))
    .map((c) => ({ ...c, claims: c.claims.filter((x) => x.lane === lane || shares(x.lane)) }))
    .filter((c) => new Set(c.claims.map((x) => x.lane)).size > 1);
}

/**
 * The warning, written out, from one lane's side.
 *
 * Names the other lane rather than counting them, because "Reviewer also
 * changed this" is something you can go and look at and "1 other lane" is not.
 */
export function collisionLine(state: SessionState, c: Collision, lane: string): string {
  const others = c.claims.filter((x) => x.lane !== lane);
  const name = (id: string) => (id === MAIN_LANE ? "Main" : (state.lanes.find((l) => l.id === id)?.name ?? "another lane"));
  const names = [...new Set(others.map((o) => name(o.lane)))];
  const who = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${who} ${names.length === 1 ? "has" : "have"} also changed ${c.path}`;
}

/** A file another session is changing too, and who is doing it. */
export interface Overlap {
  path: string;
  /** `outside`: a teammate's session the asker isn't in, said by who and which file only (see radar.ts). */
  others: { sid: string; title: string; by: string; outside?: boolean }[];
}

/**
 * The projects a session's agents work in, as keys two sessions can share: the repo when it is known, otherwise the folder
 * on its machine (the original folder for an agent in a separate copy of it, which is the same project). A session with no
 * folder of its own has none, and so overlaps nobody.
 */
export function projectsOf(s: Partial<Pick<SessionState, "engines">>): Set<string> {
  const keys = new Set<string>();
  for (const e of Object.values(s.engines ?? {})) {
    if (!e) continue;
    if (e.repo) keys.add(`repo:${e.repo.toLowerCase().replace(/\.git$/, "")}`);
    const dir = e.copyOf || e.cwd;
    if (dir) keys.add(`dir:${e.hostId}:${dir.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()}`);
  }
  return keys;
}

/**
 * Two sessions, one file: the same collision, one level up.
 *
 * Sessions are where people work on their own, so two of them changing the
 * same file is invisible from inside either — the conflict shows up at merge,
 * after both are finished. This says so while it is still cheap to do something
 * about it.
 *
 * Only sessions in the same workspace are compared (a file path in two
 * different teams' repositories is not a collision), and only what is still
 * uncommitted: a commit clears a session's claims, because a file somebody has
 * already landed is no longer in anyone's way.
 *
 * The caller hands over only sessions the asker belongs to, which is what keeps
 * this from being a way to learn what somebody else's private session is doing.
 */
export function overlapsAcross(
  states: (Pick<SessionState, "id" | "title" | "workspaceId" | "claims"> & Partial<Pick<SessionState, "upload" | "engines">> & { projects?: Set<string>; outside?: boolean })[],
): Map<string, Overlap[]> {
  const out = new Map<string, Overlap[]>();
  const byWorkspace = new Map<string, typeof states>();
  for (const s of states) {
    // Older than workspaces: there is no telling whose they are to each other.
    if (!s.workspaceId) continue;
    // A session on its own uploaded copy shares its folder with nobody: the same path in two copies is not one file.
    if (s.upload && !Object.values(s.engines ?? {}).some((e) => e.cwd)) continue;
    byWorkspace.set(s.workspaceId, [...(byWorkspace.get(s.workspaceId) ?? []), s]);
  }
  for (const group of byWorkspace.values()) {
    // Which project each session works in: the same path in two different projects is two files, and every README.md and
    // package.json in a workspace was being called "someone else is changing this file too".
    const where = new Map(group.map((s) => [s.id, s.projects ?? projectsOf(s)]));
    const outside = new Set(group.filter((s) => s.outside).map((s) => s.id));
    const shared = (a: string, b: string) => {
      const x = where.get(a)!;
      const y = where.get(b)!;
      return [...x].some((k) => y.has(k));
    };
    // path -> for each session that has touched it, the newest claimant.
    const paths = new Map<string, Map<string, { title: string; by: string; seq: number; outside?: boolean }>>();
    for (const s of group) {
      for (const c of s.claims) {
        const sessions = paths.get(c.path) ?? new Map();
        const had = sessions.get(s.id);
        if (!had || c.seq > had.seq) sessions.set(s.id, { title: s.title, by: c.by.name, seq: c.seq, ...(s.outside ? { outside: true } : {}) });
        paths.set(c.path, sessions);
      }
    }
    for (const [path, sessions] of paths) {
      if (sessions.size < 2) continue;
      for (const [sid] of sessions) {
        // A teammate's session nobody here is in is only compared against, never answered for.
        if (outside.has(sid)) continue;
        const others = [...sessions].filter(([o]) => o !== sid && shared(sid, o)).map(([o, v]) => ({ sid: o, title: v.title, by: v.by, ...(v.outside ? { outside: true } : {}) }));
        if (others.length) out.set(sid, [...(out.get(sid) ?? []), { path, others }]);
      }
    }
  }
  for (const list of out.values()) list.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/**
 * Overlaps before anyone writes: files this lane's plan names (state.intents, read from its plan) that another lane, in the
 * same project, has already changed or plans to. The answer to the most common complaint about agents in parallel, merge
 * conflicts at the same few files, made when it is still cheap: before the second agent starts.
 */
export function plannedOverlapsFor(state: SessionState, lane: string): { path: string; with: string[] }[] {
  const mine = state.intents?.[lane]?.paths ?? [];
  if (!mine.length) return [];
  const keys = (id: string) => projectsOf({ engines: { x: state.engines[id] ?? state.engines[MAIN_LANE]! } });
  const here = keys(lane);
  const shares = (id: string) => {
    const theirs = keys(id);
    return !here.size || !theirs.size || [...theirs].some((k) => here.has(k));
  };
  const name = (id: string) => (id === MAIN_LANE ? state.mainName?.trim() || "Main" : (state.lanes.find((l) => l.id === id)?.name ?? "another agent"));
  const out: { path: string; with: string[] }[] = [];
  for (const path of mine) {
    const others = new Set<string>();
    for (const c of state.claims) if (c.path === path && c.lane !== lane && shares(c.lane)) others.add(c.lane);
    for (const [other, i] of Object.entries(state.intents ?? {})) if (other !== lane && i.paths.includes(path) && shares(other)) others.add(other);
    if (others.size) out.push({ path, with: [...others].map(name) });
  }
  return out;
}

/** The same, as a line for an agent's context: who else is on it, so it can coordinate rather than collide. */
export function plannedOverlapLine(o: { path: string; with: string[] }): string {
  const who = o.with.length === 1 ? o.with[0]! : `${o.with.slice(0, -1).join(", ")} and ${o.with.at(-1)}`;
  return `${who} ${o.with.length === 1 ? "is" : "are"} also working on ${o.path}: coordinate with ${o.with.length === 1 ? "it" : "them"} (message_agent) before changing it`;
}
