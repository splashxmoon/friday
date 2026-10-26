/**
 * Somebody's own model, as a model id: `own:<user>:<id>`, a key or a local model server set up on that person's computer
 * (runner/own-models.ts). Here rather than in plans.ts so the open-source edition, which has no plans, names them the same way.
 */
export const isOwnModel = (id: string | undefined | null): id is string => !!id && id.startsWith("own:");
export const ownModelId = (userId: string, entryId: string) => `own:${userId}:${entryId}`;
/** Whose computer an own model runs on, and its id there. */
export function ownModelParts(id: string): { owner: string; entry: string } | null {
  const m = /^own:([^:]+):([\w-]+)$/.exec(id);
  return m ? { owner: m[1]!, entry: m[2]! } : null;
}
