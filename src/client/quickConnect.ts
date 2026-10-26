import { useSyncExternalStore } from "react";
import { parseRepo } from "../runner/repo.js";
import type { FolderInfo } from "../runner/workspace.js";
import { roleOf, type SessionState } from "../session/projection.js";
import { ENGINE_NAMES, MAIN_LANE, type EngineTool, type SessionEvent } from "../types.js";
import { TOOLS_MS, deadline, hostApi, installedOn, type LocalTool } from "./local.js";
import { saveRecentFolder, type Identity } from "./storage.js";
import type { Send } from "./useSession.js";

/** The same repository, however its address was written: https or ssh, with or without .git. */
export const sameRepo = (a: string, b: string) => {
  const key = (u: string) => (parseRepo(u)?.slug ?? u.replace(/\.git$/, "").replace(/\/+$/, "")).toLowerCase();
  return key(a) === key(b);
};

/** A "no folder" agent's scratch space (~/Friday/sessions/<sid>/<lane>), which is not the session's code. */
export const isScratch = (p: string) => /[\\/]Friday[\\/]sessions[\\/]/.test(p);

/**
 * The folder an agent here already works in, when this computer has it.
 *
 * The lane handing the work over first: when it works in a worktree of its own, that is where its work is (its branch, its
 * changes not committed yet), and a copy made from the main folder has none of it. Then the main lane's, then any online
 * one's. Every candidate is asked at once: a path from somebody else's machine is a miss that costs one round trip, and
 * waiting on each in turn made a hand-off pay for all of them. The first found, in that order, wins.
 *
 * Somebody else's path is only what their runner said, and `~`, `/` or `C:\` is a folder on every computer: theirs counts
 * only when it is a repository here, and the one their lane was set up for if that is known. Mine is mine.
 */
export async function localSessionFolder(identity: Identity, state: SessionState, from?: string): Promise<FolderInfo | null> {
  const engines = Object.entries(state.engines)
    .filter(([, e]) => e.cwd && !isScratch(e.cwd))
    .sort(([a, x], [b, y]) => Number(b === from) - Number(a === from) || Number(b === MAIN_LANE) - Number(a === MAIN_LANE) || Number(y.online) - Number(x.online));
  const looks = new Map<string, Promise<FolderInfo | null>>();
  const look = (p: string) => {
    if (!looks.has(p)) looks.set(p, hostApi<{ folder: FolderInfo }>(identity, `/api/runner/describe?path=${encodeURIComponent(p)}`).then((r) => r.folder, () => null));
    return looks.get(p)!;
  };
  const found = await Promise.all(
    engines.map(([, e]) => look(e.cwd).then((f) => (f && (e.hostId === identity.id || (f.isRepo && (!e.repo || (!!f.remote && sameRepo(f.remote, e.repo))))) ? f : null))),
  );
  return found.find((f) => !!f) ?? null;
}

/**
 * The code this session works on, as a folder on this computer.
 *
 * The folder an agent here already works in (see localSessionFolder). Failing that, the repository it came from: a
 * checkout this computer already has, or a fresh clone of it, which is `elsewhere`: the code as it was pushed, not as it is
 * on the other machine. Null when there is nothing to go on, and the person is asked. Nothing is cloned until `ready` says
 * the agent can run here, and a clone that fails says why (it throws).
 */
async function sessionFolder(
  o: { identity: Identity; state: SessionState; sid: string; invite: string; from?: string; onProgress?: (line: string) => void },
  ready: Promise<boolean>,
): Promise<{ folder: FolderInfo; elsewhere: boolean } | null> {
  const here = await localSessionFolder(o.identity, o.state, o.from);
  if (here) return { folder: here, elsewhere: false };
  const url =
    Object.values(o.state.engines).find((e) => e.repo)?.repo ??
    (await fetch(`/api/sessions/${encodeURIComponent(o.sid)}/remote?invite=${encodeURIComponent(o.invite)}`)
      .then((r) => r.json() as Promise<{ remote?: { url?: string } }>)
      .then((d) => d.remote?.url, () => undefined));
  if (!url) return null;
  const recent = await hostApi<{ recent: FolderInfo[] }>(o.identity, "/api/runner/folders").then((r) => r.recent, () => [] as FolderInfo[]);
  const mine = recent.find((f) => f.remote && sameRepo(f.remote, url));
  if (mine) return { folder: mine, elsewhere: true };
  if (!(await ready)) return null;
  o.onProgress?.(`Cloning ${parseRepo(url)?.slug ?? url} onto this computer…`);
  const r = await hostApi<{ folder: FolderInfo }>(o.identity, "/api/runner/clone", { method: "POST", body: JSON.stringify({ repo: url }) });
  return { folder: r.folder, elsewhere: true };
}

type Result = { ok: true; note?: string } | { ok: false; step: 0 | 1; error?: string };
type Options = {
  identity: Identity;
  state: SessionState;
  events: SessionEvent[];
  sid: string;
  invite: string;
  tool: EngineTool;
  /** The lane handing the work over, whose access the new agent starts with, and whose folder it starts from. */
  from?: string;
  /** What it is doing, when that takes long enough to say: a clone. */
  onProgress?: (line: string) => void;
  /** The model it starts on, when routing picked one for the work (routing.ts); else its own default. */
  model?: string;
  /**
   * Given, the agent's lane is added first, from here, and its runner started on it: the lane is there at once and takes
   * messages while the runner starts. A start that fails takes the lane away again.
   */
  send?: Send;
};

/** A coding agent on its way in from this page: its tool, and its lane once that is made. */
export type Starting = { tool: EngineTool; lane?: string };
let starting: Record<string, Starting[]> = {};
const watchers = new Set<() => void>();
const NONE: Starting[] = [];
function putStarting(sid: string, tool: EngineTool, v: Starting | null): void {
  const rest = (starting[sid] ?? NONE).filter((s) => s.tool !== tool);
  starting = { ...starting, [sid]: v ? [...rest, v] : rest };
  for (const w of watchers) w();
}
/** The agents being brought into this session from this page right now, drawn before any server has answered. */
export const startingIn = (sid: string): Starting[] => starting[sid] ?? NONE;
/** The agent starting on this lane, until its runner attaches: the moment it is online the lane is an ordinary one. */
export const startingOn = (now: Starting[], state: SessionState, lane: string): Starting | undefined => now.find((s) => s.lane === lane && !state.engines[lane]?.online);
export function useStarting(sid: string): Starting[] {
  return useSyncExternalStore(
    (w) => {
      watchers.add(w);
      return () => watchers.delete(w);
    },
    () => startingIn(sid),
  );
}

/** Bring-ins still under way, by session and tool: pressing again joins the one already on its way. */
const pending = new Map<string, Promise<Result>>();

/**
 * Bring a coding agent into the session with nothing to fill in.
 *
 * Everything the setup would ask is already known: the session's own code (see sessionFolder), the access the lane handing
 * the work over had, and, when this session carries on from one of this agent's own conversations, that conversation. When
 * another agent is editing the folder, this one works in a copy of its own that brings the changes made so far along. If
 * something has to be asked (no computer, the agent not installed or signed in, no code to go on), it says which step of the
 * setup to open at instead: 0 the agent, 1 the code.
 *
 * Once per session and tool at a time: every finished run has its own "Hand off" menu, and a second press while the first was
 * still starting made a second agent, or was refused for the folder the first one had just taken.
 */
export function quickConnect(o: Options): Promise<Result> {
  const key = `${o.sid}|${o.tool}`;
  let p = pending.get(key);
  if (!p) {
    // Shown from this moment, before anything has been asked of the server or the machine.
    putStarting(o.sid, o.tool, { tool: o.tool });
    p = connect(o).finally(() => {
      pending.delete(key);
      putStarting(o.sid, o.tool, null);
    });
    pending.set(key, p);
  }
  return p;
}

async function connect(o: Options): Promise<Result> {
  // Whether the agent is here, from what this page last saw of the machine rather than a look at every tool on it first:
  // Runner.start checks this one again, and its refusal opens the setup. Asked of the machine (that tool alone, from its
  // memory) only when this page has seen nothing of it yet.
  const seen = installedOn(o.identity);
  if (seen && !seen(o.tool)) return { ok: false, step: 0 };
  const machine = seen
    ? Promise.resolve(true)
    : hostApi<{ tools: LocalTool[] }>(o.identity, `/api/runner/tools?tool=${o.tool}`, { signal: deadline(TOOLS_MS) }).then(
        (m) => {
          const found = m.tools.find((t) => t.tool === o.tool);
          return !!found?.path && found.loggedIn !== false;
        },
        // Known to have no machine is "not ready", not "didn't answer in time".
        (e: Error) => (e.name === "NoMachine" ? false : null),
      );
  const ready = machine.then((m) => m === true);
  // The lane first, beside the folder lookup: it is in the session at once, and what is typed to it waits for the runner.
  const owner = !!o.send && roleOf(o.state, o.identity.id) === "owner";
  const who = ENGINE_NAMES[o.tool];
  const made = o.send?.({ type: "lane.add", name: (owner ? who : `${o.identity.name.split(" ")[0]}'s ${who}`).slice(0, 40), engine: true, ...(owner ? {} : { own: true }), control: { kind: "open" }, trigger: { kind: "manual" }, quiet: true });
  // Whoever brings their tool in steers it from the moment its lane exists, as when the server made the lane: an open lane
  // with no driver went to the first teammate who typed to it, and they would steer a CLI on this computer.
  const adding = made?.then(async (r) => {
    if (r.ok && r.lane) await o.send!({ type: "control.claim", lane: r.lane, quiet: true });
    return r;
  });
  // Drawn as the starting agent from the moment it exists, whatever is still being looked up.
  void made?.then((r) => {
    if (r.lane && startingIn(o.sid).some((s) => s.tool === o.tool)) putStarting(o.sid, o.tool, { tool: o.tool, lane: r.lane });
  });
  let lane: string | undefined;
  // Taken away again when the start goes no further, so nobody is left looking at an agent that never came.
  const fail = async (r: Extract<Result, { ok: false }>): Promise<Result> => {
    const made = lane ?? (await adding)?.lane;
    if (made) await o.send!({ type: "lane.remove", laneId: made, quiet: true });
    return r;
  };
  let where: Awaited<ReturnType<typeof sessionFolder>>;
  try {
    where = await sessionFolder(o, ready);
  } catch (e) {
    return fail({ ok: false, step: 1, error: (e as Error).message });
  }
  // A computer that didn't answer says so, rather than opening the setup at a step with no reason given.
  if ((await machine) === null) return fail({ ok: false, step: 0, error: "This computer didn't answer in time." });
  if (!(await ready)) return fail({ ok: false, step: 0 });
  if (!where) return fail({ ok: false, step: 1 });
  if (adding) {
    const r = await adding;
    if (!r.ok || !r.lane) return { ok: false, step: 1, error: r.error ?? `Couldn't add ${who} to this session.` };
    lane = r.lane;
  }
  const { folder, elsewhere } = where;
  const norm = (p: string) => p.replace(/[\\/]+$/, "");
  const taken = Object.values(o.state.engines).some((e) => e.online && e.mode !== "plan" && norm(e.cwd) === norm(folder.path));
  // Another agent editing it already: this one shares the folder with it rather than Friday making a copy nobody asked for
  // (Arun, 2026-10-24: copies only when asked). A copy of its own is a choice in the add dialog.
  const imp = o.events.findLast((e) => e.body.type === "session.imported")?.body;
  const resume = imp?.type === "session.imported" && !imp.fork && imp.tool === o.tool ? imp : null;
  // Code from the repository rather than the other machine's folder: on the session's branch, which the runner fetches, and
  // leaves alone if it was never pushed.
  const branch = elsewhere && !taken ? (o.from && o.state.engines[o.from]?.branch) || o.state.engines[MAIN_LANE]?.branch : undefined;
  let followed: boolean | undefined;
  try {
    ({ followed } = await hostApi<{ followed?: boolean }>(o.identity, "/api/runner/start", {
      method: "POST",
      body: JSON.stringify({
        sid: o.sid,
        invite: o.invite,
        tool: o.tool,
        ...(o.model ? { model: o.model } : {}),
        mode: (o.from && o.state.engines[o.from]?.mode) || "full",
        cwd: folder.path,
        ...(taken ? { share: true } : {}),
        ...(branch ? { followBranch: branch } : {}),
        // Only resumed on a machine that has it; anywhere else the runner says so and it comes in as history (Runner.start).
        ...(resume ? { resumeId: resume.sourceId, resumeIfHere: true, resumeTitle: resume.title, resumeMessages: resume.partial ? 0 : resume.total, resumeTool: resume.tool } : {}),
        // On the lane made above (the server still decides whether it may: Solo, who steers it, one writer per folder), or
        // one the server makes for it.
        ...(lane ? { lane, copyName: who } : { newLane: who }),
      }),
    }));
  } catch (e) {
    return fail({ ok: false, step: 1, error: (e as Error).message });
  }
  saveRecentFolder(folder.path);
  if (!elsewhere) return { ok: true };
  // What came along, as the runner found it: "as pushed" only when it is on the session's branch as origin has it.
  const note =
    branch && followed
      ? `${who} is working in your copy of ${folder.name} on ${branch}, as pushed. Work that wasn't pushed from the other computer isn't in it.`
      : branch && followed === false
        ? `${who} is working in your copy of ${folder.name} as it is, not ${branch} as pushed: that branch isn't on origin, or your copy has changes of its own in the way. Work from the other computer isn't in it.`
        : `${who} is working in your copy of ${folder.name}. Work that is only on the other computer isn't in it.`;
  return { ok: true, note };
}
