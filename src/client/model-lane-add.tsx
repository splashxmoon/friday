import { useEffect, useState } from "react";
import { can, type SessionState } from "../session/projection.js";
import { MAIN_LANE, SESSION_LANES, type Member } from "../types.js";
import { EngineMark, ModelHostMark, VendorMark } from "./BrandMarks.js";
import { Icon } from "./icons.js";
import { hostApi } from "./local.js";
import { useOwnModels, type OwnChoice } from "./ownModelStore.js";
import type { Identity } from "./storage.js";
import type { MenuItem } from "./ui.js";

/**
 * "Your models" in a coding session's Add an agent menus (model-lane.ts; Arun, 2026-11-20: "look into why i cannot load up my
 * local models or api key based models into coding session as add agents"): after the coding tools, one row per model in Settings ›
 * Your models, its name and its host's mark. Picked, Friday Code runs on it on a lane of its own, in the session's folder.
 */

const LOGO: Record<string, string> = { openai: "OpenAI", anthropic: "Anthropic", google: "Google", gemini: "Google", deepseek: "DeepSeek" };
/** Their own marks, not letters (audit REST-25). */
const HOST_MARKS = new Set(["groq", "mistral", "together", "ollama", "lmstudio"]);

/** Whether a provider has a mark of its own here, rather than a globe. */
export const ownHostMarked = (provider?: string): boolean => !!provider && (!!LOGO[provider.toLowerCase()] || HOST_MARKS.has(provider.toLowerCase()) || provider.toLowerCase() === "xai");

/** Where one of your own models runs, as a mark: its provider's logo or its server's, xAI's Grok, else a globe (Settings › Your models' too). */
export function OwnHostMark({ provider, size = 14 }: { provider?: string | undefined; size?: number }) {
  const id = provider?.toLowerCase();
  if (id && LOGO[id]) return <VendorMark vendor={LOGO[id]} size={size} />;
  if (id && HOST_MARKS.has(id)) return <ModelHostMark id={id} size={size} />;
  if (id === "xai") return <EngineMark tool="grok" size={size} />;
  return <Icon name="globe" size={size} />;
}

/** The name its lane goes by: the person's own name for it, or the model's without its maker ("moonshotai/kimi-k3.1-pro" is "kimi-k3.1-pro"). */
export function modelLaneName(m: Pick<OwnChoice, "name" | "model">): string {
  const named = m.name.trim();
  return ((named && named !== m.model ? named : m.model.split("/").pop()) || m.model).slice(0, 40);
}

/**
 * The session's folder, when it is on this computer and this person's: where an agent added here works (its main agent's, else the
 * first of its agents with one). Null when it has none here: the agent gets a place of its own to stand in.
 */
export function sessionFolderHere(state: Pick<SessionState, "engines" | "lanes">, me: string): string | null {
  const e = [MAIN_LANE, ...state.lanes.map((l) => l.id)].map((l) => state.engines[l]).find((x) => !!x?.cwd && x.hostId === me && !x.computer);
  return e?.cwd ?? null;
}

/** Who may add one: the session's owner (their own model, as the runtime runs no other), who may steer it, in a coding session. */
export function mayAddModelLane(state: Pick<SessionState, "ownerId" | "options">, me: Pick<Member, "id" | "role">, mayControl: boolean): boolean {
  return state.ownerId === me.id && me.role !== "viewer" && mayControl && !state.options.team;
}

/** The menu's rows: a heading and a row per model, none without models or when it isn't theirs to add. */
export function modelLaneRows(models: readonly OwnChoice[], p: { may: boolean; full: boolean }, pick: (m: OwnChoice) => void): MenuItem[] {
  if (!p.may || !models.length) return [];
  return [
    { heading: "Your models" },
    ...models.map(
      (m): MenuItem => ({
        label: modelLaneName(m),
        mark: <OwnHostMark provider={m.provider} size={14} />,
        // The exact model and where it runs on hover; a hint only when it can't be picked (as the crew's rows).
        title: `${m.model} · ${m.local ? "on this computer" : "your key"}`,
        ...(p.full ? { hint: `${SESSION_LANES} is the most`, disabled: true } : {}),
        onSelect: () => pick(m),
      }),
    ),
  ];
}

const notice = (text: string) => dispatchEvent(new CustomEvent("friday:notice", { detail: text }));

/** Adds the agent: a runner lends the session's folder (shared with the agents already in it) to a new lane named after the model. */
export async function addModelLane(identity: Identity, state: SessionState, invite: string, m: OwnChoice): Promise<string | null> {
  const cwd = sessionFolderHere(state, identity.id);
  try {
    const r = await hostApi<{ lane?: string }>(identity, "/api/runner/start", {
      method: "POST",
      body: JSON.stringify({ sid: state.id, invite, ...(cwd ? { cwd, share: true } : { noFolder: true }), mode: "full", newLane: modelLaneName(m), model: m.choice }),
    });
    return r.lane ?? null;
  } catch (e) {
    notice(`Couldn't add ${modelLaneName(m)}: ${(e as Error).message}`);
    return null;
  }
}

/** The rows for each of the session's add menus: the thread card's Add agent, the agent switch's +, the box's Send to, the tabs' +. */
export function useModelLaneRows(state: SessionState, me: Pick<Member, "id" | "role">, identity: Identity, invite: string): () => MenuItem[] {
  const models = useOwnModels(identity);
  // The box points at the new agent once this page has its lane, so the next message goes to it: pointed at sooner, the box
  // found no such lane and went back to the main one.
  const [joining, setJoining] = useState<string | null>(null);
  useEffect(() => {
    if (!joining || !state.lanes.some((l) => l.id === joining)) return;
    setJoining(null);
    window.dispatchEvent(new CustomEvent("friday:focus-lane", { detail: { lane: joining } }));
  }, [joining, state.lanes]);
  return () => modelLaneRows(models, { may: mayAddModelLane(state, me, can(state, me.id, "control")), full: state.lanes.length >= SESSION_LANES }, (m) => void addModelLane(identity, state, invite, m).then((lane) => lane && setJoining(lane)));
}
