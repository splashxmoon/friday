/** What a workspace is, as the rest of Friday sees it (workspaces.ts keeps them; on someone's own computer there is one). */

export type { Plan } from "./plan-types.js";
import type { Plan } from "./plan-types.js";
export type WorkspaceRole = "owner" | "admin" | "member";

export interface WorkspaceDefaults {
  model?: string;
  thinking?: "fast" | "balanced" | "deep";
  /** A second agent reads every change before a person does (SessionOptions.review). */
  review?: boolean;
  /** The agent shows its plan and waits for a yes before it edits anything. */
  planFirst?: boolean;
  /** The agent may search the web. */
  webSearch?: boolean;
  /** Pause any agent's run once it has used this many tokens (run-budget.ts). 0 or absent: no cap. */
  runCap?: number;
}

export interface Workspace {
  id: string;
  name: string;
  plan: Plan;
  /**
   * What a new session starts with. A preference, not a rule: the composer still decides the model and depth, every
   * session can change the rest for itself, and this is only what it opens on. The model is kept to what the plan allows.
   */
  defaults?: WorkspaceDefaults;
  /** A personal workspace is made automatically and can't be left or deleted. */
  personal: boolean;
  createdAt: number;
  /** The hosted service's; never set on this computer. */
  trialEndsAt?: number;
}

export interface Membership {
  workspaceId: string;
  accountId: string;
  role: WorkspaceRole;
  joinedAt: number;
}
