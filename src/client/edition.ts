import type { Plan, PlanLimits } from "../plan-types.js";
import type { WorkspaceUsage } from "./workspace-types.js";
import { openOutside } from "./openOutside.js";

/**
 * Which Friday this page is.
 *
 * "hosted": tryfridaywork.com and its desktop app, with accounts, teams, billing and Friday's own agent.
 * "local": the open-source edition, on your own computer with your own coding tools, no account and nothing hosted.
 *
 * The pages are the same; what only the hosted one has is plugged in by its entry (paid/register.ts) and asked for here, and
 * each question has the answer Solo gives when nothing is plugged in. So the local entry (local-main.tsx) plugs in nothing,
 * and the paid code is never part of its build.
 */
export type Edition = "hosted" | "local";
let current: Edition = "hosted";
export const edition = (): Edition => current;
export const isLocal = (): boolean => current === "local";
export const setEdition = (e: Edition): void => void (current = e);

/** Solo or Team for one session's workspace, which may not be the one the app has open. Null until the server says. */
export type SessionPlan = {
  team: boolean;
  workspace: { personal: boolean } | null;
};

/** Where the open-source edition points someone who wants to work with teammates. */
export const TEAM_URL = "https://www.tryfridaywork.com/team";

/** What the hosted entry plugs in. */
export interface PaidHooks {
  limitsFor(plan: Plan): PlanLimits;
  startTeam(from?: { sid: string; invite: string } | null, another?: boolean): void;
  isOwnModel(id: string | undefined | null): boolean;
}
const hooks: Partial<PaidHooks> = {};
export const registerPaid = (h: Partial<PaidHooks>): void => void Object.assign(hooks, h);

/** The plan a workspace has right now (the server's `planNow`, which counts a running trial), else the one it is on. */
export const planNow = (w: Pick<WorkspaceUsage, "plan" | "planNow"> | null | undefined): Plan => w?.planNow ?? w?.plan ?? "free";

/** What a plan allows, as far as the pages ask: Solo's, with nothing plugged in. */
const SOLO = { team: false, fridayAgent: "none" } as const;
export const planLimits = (plan: Plan): Pick<PlanLimits, "team" | "fridayAgent"> => hooks.limitsFor?.(plan) ?? SOLO;
/** No Friday agent of its own: your own coding tools only (Solo, and everything in the local edition). */
export const soloPlan = (w: Pick<WorkspaceUsage, "plan" | "planNow"> | null | undefined): boolean => planLimits(planNow(w)).fridayAgent === "none";
/** People other than a session's owner may work in it. */
export const teamPlan = (w: Pick<WorkspaceUsage, "plan" | "planNow"> | null | undefined): boolean => planLimits(planNow(w)).team;

/** One of the person's own models (their key, or one on their computer) running Friday's agent: never, in the local edition. */
export const ownModel = (id: string | undefined | null): id is string => hooks.isOwnModel?.(id) ?? false;

/**
 * "Start a team", from anywhere: the hosted page's dialog; in the local edition, Friday Team's own page, since a team needs
 * the hosted Friday.
 */
export function startTeam(from?: { sid: string; invite: string } | null, another = false): void {
  if (hooks.startTeam) return hooks.startTeam(from, another);
  void openOutside(TEAM_URL);
}
