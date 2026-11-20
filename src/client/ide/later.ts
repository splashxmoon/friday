import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import type { Identity } from "../storage.js";
import type { EngineEffort, EngineMode, EngineTool, IssueRef, PrRef } from "../../types.js";
import { feedRefresh, feedSubscribe } from "./later-feed.js";

/**
 * Run later, the page's side (src/later.ts; Arun, 2026-11-20: "Tonight from the IDE: queue a task from Code to run overnight (or at a
 * time), with the results waiting in the morning"). The box queues a task with the moment to start it; Friday starts it then, as a
 * chat on this computer, if it is running. A chat it started is taken into Code's history once, marked "Ran overnight"
 * (later-adopt.ts, which keeps to itself so the box's chunk and Code's don't share a module).
 */
export interface LaterView {
  id: string;
  title: string;
  folder: string;
  tool: EngineTool;
  mode: EngineMode;
  /** UTC milliseconds. */
  at: number;
  status: "queued" | "starting" | "running" | "missed" | "failed";
  note?: string;
  sid?: string;
  invite?: string;
  startedAt?: number;
}

/** What the box sends to queue a task. */
export interface LaterBody {
  folder: string;
  ask: string;
  tool: EngineTool;
  mode: EngineMode;
  fullAccess?: boolean;
  model?: string;
  /** The account picked in the box, effort, and the issue or pull request held there: the task runs as the box would have. */
  account?: string;
  effort?: EngineEffort;
  issue?: IssueRef;
  pr?: PrRef;
  title?: string;
  at: number;
}

/** The person's own zone: times are stored in UTC and shown on this clock. */
export const zoneName = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

export const queueLater = (identity: Identity, body: LaterBody) => api<{ task: { id: string } }>(identity, "/api/later", { method: "POST", body: JSON.stringify(body) });
export const cancelLater = (identity: Identity, id: string) => api(identity, `/api/later/${id}`, { method: "DELETE" });
export const runLaterNow = (identity: Identity, id: string) => api(identity, `/api/later/${id}/run`, { method: "POST", body: "{}" });

/** The tasks for later, from the one shared look at the list (later-feed.ts) while `on`, and again whenever `reload` is called. */
export function useLater(identity: Identity, on: boolean): { tasks: LaterView[]; reload: () => void } {
  const [tasks, setTasks] = useState<LaterView[]>([]);
  const reload = useCallback(() => void feedRefresh(identity), [identity.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!on) return;
    return feedSubscribe(identity, (l) => setTasks(l as unknown as LaterView[]));
  }, [on, identity.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return { tasks, reload };
}
