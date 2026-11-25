import { MAIN_LANE } from "./types.js";
import type { SessionState } from "./session/projection.js";
import type { RepoUse } from "./client/storage.js";

/**
 * The folders a session's agents work in, as the sidebar files it under a project: each repo once, the main lane's folder, branch and
 * worktree first. Shared by the session view and the server's list of your sessions (/api/sessions/mine), so a thread a Captain or
 * another device started is filed under its project as soon as it is listed, not only once it is opened (Arun, 2026-11-25: "look into
 * why it appears in recent when it is supposed to appear in edge").
 */
export function reposOf(state: SessionState | null | undefined): RepoUse[] {
  if (!state) return [];
  const by = new Map<string, RepoUse>();
  for (const [lane, e] of Object.entries(state.engines)) {
    if (!e.cwd || /friday-race-[0-9a-f]{8}/.test(e.cwd)) continue;
    const base = e.cwd.split(/[\\/]/).filter(Boolean).pop() ?? e.cwd;
    // A worktree's folder is `<repo>-<id>`: it belongs to the repo, whatever lane is in it.
    const name = base.replace(/-[0-9a-f]{8}$/, "");
    const had = by.get(name);
    // The main lane's branch is the one to show; a lane's own worktree branch is a detail of that lane.
    // Made by Friday for the session, when nobody picked a folder: ~/Friday/Projects/<what was asked> (audit CODE-20).
    const made = /[\\/]Friday[\\/]Projects[\\/][^\\/]+[\\/]?$/.test(e.cwd);
    // The folder itself, so a new thread in the project can start there; the main lane's when it has one.
    const path = lane === MAIN_LANE || !had?.path ? (e.copyOf ?? e.cwd) : had.path;
    const worktree = lane === MAIN_LANE || !had ? !!e.copyOf : !!had.worktree;
    // Where that lane really edits (the worktree), for Code, whose folder must be the one the agent's changes land in.
    const cwd = lane === MAIN_LANE || !had?.cwd ? e.cwd : had.cwd;
    if (!had || lane === MAIN_LANE) by.set(name, { name, branch: lane === MAIN_LANE || !had ? e.branch : had.branch, live: !!had?.live || e.online, ...(made || had?.made ? { made: true } : {}), path, ...(worktree ? { worktree: true, cwd } : {}) });
    else had.live = had.live || e.online;
  }
  return [...by.values()];
}
