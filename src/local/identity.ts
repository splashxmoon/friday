import type { Account } from "../identity-types.js";
import type { Workspace } from "../workspace-types.js";

/**
 * Who is using the open-source edition: the one person at this computer. No sign-in and no account anywhere; every request is
 * them (the server answers only this computer's own pages, app.ts localOnly), in the one workspace there is, on Solo.
 */
export function localAccount(user: { id: string; name: string }): Account {
  return { id: user.id, provider: "dev", providerId: user.id, email: "", name: user.name, createdAt: 0, lastSeenAt: Date.now() };
}

export const LOCAL_WORKSPACE: Workspace = { id: "local", name: "This computer", plan: "free", personal: true, createdAt: 0 };
