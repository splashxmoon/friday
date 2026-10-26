/**
 * The shape of a plan, apart from what each plan is (plans.ts): what the pages and the open-source edition read without knowing
 * any plan's terms. The local edition has no plans at all; everything in it is Solo.
 */

/** Which plan: `free` is Solo; the others are the hosted Friday's (plans.ts). */
export type Plan = "free" | "basic" | "pro" | "max" | "dev";

export interface PlanLimits {
  id: Plan;
  name: string;
  /** Monthly price in whole currency units; 0 is free. */
  price: number;
  /** A year up front, in whole currency units. */
  priceYearly: number;
  /** Tokens/day on the frontier model. 0 means the Pro agent isn't offered. */
  frontierTokensPerWindow: number;
  /** Tokens per window on Friday's own model. */
  baseTokensPerWindow: number;
  /** People in one session at once, the host included. */
  seatsPerSession: number;
  /** Members in the workspace. */
  members: number;
  /**
   * How long the session log is kept at least. A promise of how long it stays, not a limit after which it goes: nothing
   * deletes old sessions (Arun, 2026-10-22), so it is shown as "kept for at least" (historyLine).
   */
  retentionDays: number;
  /** Friday agents beside the main one in a session. Coding tools people bring are never counted. */
  lanes: number;
  /** People other than a session's owner may work in its sessions (not just watch): the multiplayer half. */
  team: boolean;
  /** Which of Friday's own models its agent may run: none on Solo, which brings its own coding tools. */
  fridayAgent: "none" | "base" | "frontier";
  /** Offered for sale. A plan kept only for workspaces already on it is not. */
  offered: boolean;
}
