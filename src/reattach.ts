import type { LaneEngine, SessionState } from "./session/projection.js";
import type { Role } from "./types.js";
import { MAIN_LANE } from "./types.js";

/**
 * The coding tools a computer brings back as it links (Arun, 2026-10-25: "the coding tools should auto connect to the
 * sessions in the background and be instant when you load into a coding session").
 *
 * A runner that drops comes back to its lane by itself (stayAttached), but one that quit with the app (an update, a restart,
 * a laptop shut) had nothing to come back from: every lane it held showed "went offline" until its owner opened the session,
 * and the page brought it back then, a few seconds after the person was already reading. So the server, as the computer
 * links, starts each lane that computer held and lost, quietly, in the background: recent sessions only, a few at most, one
 * at a time, so a launch doesn't start a dozen tools at once.
 */

/** Sessions touched this long ago are still brought back; older ones wait to be opened. */
export const REATTACH_WINDOW_MS = 7 * 86_400_000;
/** The most lanes one link brings back. */
export const REATTACH_MAX = 8;

/** This computer's lanes in a session that are offline and have somewhere to come back to, main lane first. */
export function lanesToReattach(state: SessionState, hostId: string): { lane: string; engine: LaneEngine }[] {
  const out: { lane: string; engine: LaneEngine }[] = [];
  for (const lane of [MAIN_LANE, ...state.lanes.map((l) => l.id)]) {
    const e = state.engines[lane];
    if (!e?.tool || e.online || e.hostId !== hostId || !e.cwd) continue;
    out.push({ lane, engine: e });
  }
  return out;
}

/** The start the page's own quiet reconnect sends (Activity reconnectLane), with the server's actor token in place of the page's. */
export function reattachParams(sid: string, invite: string, lane: string, e: LaneEngine, actorToken: string): Record<string, unknown> {
  return {
    sid,
    invite,
    actorToken,
    tool: e.tool,
    cwd: e.cwd,
    mode: e.mode,
    ...(e.handMode ? { handMode: e.handMode } : {}),
    lane,
    ...(e.model ? { model: e.model } : {}),
    ...(e.account ? { account: e.account.id } : {}),
    ...(e.copyOf ? { copyOf: e.copyOf } : {}),
    // A lane that shares its folder with another by choice comes back sharing it: without, the first lane back held the folder
    // and turned the others away as "already editing that folder" (Arun, 2026-10-26: "the coding tools not reconnecting").
    ...(e.shared ? { share: true } : {}),
    ifOffline: true,
  };
}

/** Which of an owner's recent sessions, newest first, are looked at: within the window, up to the most lanes wanted. */
export function recentEnough(at: number, now: number): boolean {
  return now - at <= REATTACH_WINDOW_MS;
}

/**
 * Bring back the lanes an owner's coding tools held and lost: their recent sessions, newest first, each offline lane of theirs
 * started again the way the page's own quiet reconnect would (ifOffline: left alone if it is already back). One at a time, a
 * few at most, and a lane whose folder or tool isn't there is simply not brought back: nobody pressed anything, so nothing is
 * said beyond the log. `start` is how a lane starts: through the computer's link on the hosted service, or this computer's own
 * runner in the open-source edition. `alive` stops it early (the link went).
 */
export async function reattachAll(
  owner: { id: string; name: string },
  deps: {
    mine: (userId: string, limit: number) => Promise<{ sid: string; at: number }[]>;
    state: (sid: string) => Promise<SessionState | null>;
    invite: (sid: string, state: SessionState, role: Role) => string;
    actorToken: (sid: string, userId: string) => string;
    start: (params: Record<string, unknown>) => Promise<unknown>;
    alive?: () => boolean;
    log: (line: string) => void;
  },
  now = Date.now(),
): Promise<void> {
  const want: { sid: string; lane: string; params: Record<string, unknown> }[] = [];
  for (const { sid, at } of await deps.mine(owner.id, 40)) {
    if (want.length >= REATTACH_MAX) break;
    if (!recentEnough(at, now)) continue;
    const state = await deps.state(sid);
    const m = state?.members[owner.id];
    if (!state || !m || m.removed) continue;
    const invite = deps.invite(sid, state, m.role);
    for (const { lane, engine } of lanesToReattach(state, owner.id)) {
      if (want.length >= REATTACH_MAX) break;
      want.push({ sid, lane, params: reattachParams(sid, invite, lane, engine, deps.actorToken(sid, owner.id)) });
    }
  }
  for (const w of want) {
    if (deps.alive && !deps.alive()) return;
    const r = await deps.start(w.params).catch((e: Error) => ({ error: e.message }));
    const said = r && typeof r === "object" && "error" in r ? `not brought back: ${(r as { error: string }).error}` : "brought back";
    deps.log(`${owner.name}'s ${w.lane === MAIN_LANE ? "agent" : w.lane} in ${w.sid} ${said}`);
  }
}
