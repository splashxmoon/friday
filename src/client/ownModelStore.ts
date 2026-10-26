import { useEffect, useSyncExternalStore } from "react";
import { ownModelId, ownModelParts } from "../own-model-id.js";
import type { OwnModelView } from "../runner/own-models.js";
import { hostApi } from "./local.js";
import type { Identity } from "./storage.js";

/**
 * The models this person set up on their computer (runner/own-models.ts), as the pickers offer them: each with the id a
 * session stores (`own:<their id>:<its id>`). Read from the computer once and shared, so every picker agrees, and asked
 * again when Settings changes them.
 */

export type OwnChoice = OwnModelView & { choice: string };

let state: { models: OwnChoice[]; loaded: boolean } = { models: [], loaded: false };
let at = 0;
let user = "";
let inflight: Promise<void> | null = null;
const subs = new Set<() => void>();
const set = (next: typeof state) => {
  state = next;
  for (const s of subs) s();
};

export function loadOwnModels(identity: Identity, force = false): Promise<void> {
  if (!identity.id) return Promise.resolve();
  if (!force && user === identity.id && Date.now() - at < 60_000) return inflight ?? Promise.resolve();
  inflight ??= hostApi<{ models: OwnModelView[] }>(identity, "/api/runner/models.own.list")
    .then(
      (r) => set({ models: r.models.map((m) => ({ ...m, choice: ownModelId(identity.id, m.id) })), loaded: true }),
      // No computer, or one on an older Friday: no own models to offer, which is an answer.
      () => set({ models: user === identity.id ? state.models : [], loaded: true }),
    )
    .finally(() => {
      at = Date.now();
      user = identity.id;
      inflight = null;
    });
  return inflight;
}

/** The list, kept current; given who is asking, it is also read from their computer. */
export function useOwnModels(identity?: Identity): OwnChoice[] {
  const s = useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => state);
  useEffect(() => {
    if (identity?.id) void loadOwnModels(identity);
  }, [identity?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return s.models;
}

/** What an own model is called: its name when it is one of yours, and plainly an own model when it is somebody else's. */
export function ownName(id: string): string {
  return state.models.find((m) => m.choice === id)?.name ?? (ownModelParts(id) ? "Their own model" : "Own model");
}
