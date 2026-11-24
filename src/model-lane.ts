import { isOwnModel, ownModelParts } from "./own-model-id.js";
import { laneNames, type SessionState } from "./session/projection.js";
import { MAIN_LANE } from "./types.js";

/**
 * An agent on one of the person's own models, added to a coding session from its Add an agent menu beside Claude Code, Codex and
 * the rest (Arun, 2026-11-20: "look into why i cannot load up my local models or api key based models into coding session as add
 * agents"). A key's model (integrate.api.nvidia.com/v1 · kimi-k3.1-pro) or one on this computer (Ollama, LM Studio).
 *
 * It is Friday Code on that model, on a lane of its own: the session's folder is lent to the lane by a runner with no coding tool
 * behind it (as a crew mate on its own model gets one), and the runner says which model with the lane (EngineInfo.model). So the
 * model is kept where the lane's folder is, comes back with it on every reconnect, and the runtime runs the lane on it
 * (agent/runtime.ts laneOwn). Only the session owner's own model, as the runtime holds every own model to.
 */

/** The own model a lane added this way runs on: its lent folder's, on a lane with no coding tool. Null for any other lane. */
export function laneOwnModel(state: Pick<SessionState, "engines" | "lanes">, lane: string): string | null {
  if (lane === MAIN_LANE || !state.lanes.some((l) => l.id === lane)) return null;
  const e = state.engines[lane];
  return e && !e.tool && isOwnModel(e.model) ? e.model : null;
}

/** What such a lane is told besides Friday's own prompt: who it is, where, with whom, and how it works beside them. */
export function ownLaneNote(name: string, place: { title: string; with: readonly string[] }): string {
  return [
    `You are ${name}, an agent the person added to the coding session "${place.title}"${place.with.length ? ` beside ${place.with.join(", ")}` : ""}, running on one of their own models through Friday.`,
    "Only they drive you here. The other agents in the session can reach you, and you them, with Friday's agent tools: list_agents, message_agent and ask_agent. When another agent asks you something, answer it plainly.",
    "Work in the session's folder and on its branch, as the other agents here do. Before you change files another agent may be in, claim them with claim_files.",
    "Don't start work nobody gave you.",
    "When you finish, lead with the outcome in a few lines: what you did, what is left, what you need. Say it once.",
  ].join("\n");
}

/** The runtime's answer for such a lane (agent/runtime.ts laneOwn): its model and its note, or null when it isn't one or isn't the owner's. */
export function ownLaneRun(state: SessionState, lane: string): { model: string; note: string } | null {
  const model = laneOwnModel(state, lane);
  if (!model || ownModelParts(model)?.owner !== state.ownerId) return null;
  const names = laneNames(state);
  const others = [MAIN_LANE, ...state.lanes.map((l) => l.id)].filter((l) => l !== lane && !!state.engines[l]).map((l) => names.get(l) ?? "").filter(Boolean);
  return { model, note: ownLaneNote(names.get(lane) ?? "an agent", { title: state.title || "Untitled", with: others }) };
}
