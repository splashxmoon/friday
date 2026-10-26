import type { Plan, PlanLimits } from "../plan-types.js";

/**
 * The workspace in play, as /api/workspace answers it: its plan, limits, usage and billing. The local edition has none (the
 * request 404s and it stays null), which every page reads as Solo.
 */
export interface WorkspaceUsage {
  id: string;
  name: string;
  plan: Plan;
  /** The plan it has right now, a running trial counted (the server's word). Limits and labels read this. */
  planNow?: Plan;
  /** When its trial ends, while one is running. */
  trialEndsAt?: number;
  /** A new team's trial, waiting to start at its first invite or Friday agent run. */
  trialPending?: boolean;
  personal?: boolean;
  limits?: PlanLimits;
  /** What the current window has spent, and when it ends (null while none is open). */
  usage?: { base: number; frontier: number; day: string; resetsAt?: number | null };
  /** The last seven days, oldest first, for the sparkline. */
  recent?: { base: number; frontier: number; day: string }[];
  /** What a new session opens on (Settings › Agent defaults). */
  defaults?: { model?: string; thinking?: "fast" | "balanced" | "deep"; review?: boolean; planFirst?: boolean; webSearch?: boolean; runCap?: number };
  /** Your role here. Only an owner can pay for the workspace. */
  role?: "owner" | "admin" | "member" | null;
  /** Where payment stands. `enabled` is false on a deployment with no payment provider. */
  billing?: {
    enabled: boolean;
    testMode?: boolean;
    status?: string;
    interval?: "monthly" | "yearly" | null;
    renewsAt?: number | null;
    cancelAtPeriodEnd?: boolean;
    hasCustomer?: boolean;
    /** Seat billing: how many seats, and whether this workspace is already billed by them. */
    seatBilling?: boolean;
    seats?: number;
    seatBilled?: boolean;
  };
}
