import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Learned } from "../route-learning.js";
import { api } from "./api.js";
import { isLocal } from "./edition.js";
import { fitModels, rankTools, taskTier, type ModelFit, type ToolRank } from "../routing.js";
import { ENGINE_MODEL_INFO, type EngineTool, type RouteTier } from "../types.js";
import { glanceOf } from "./gauge.js";
import { useToolLimits } from "./toolLimits.js";
import type { Identity } from "./storage.js";

/**
 * Why a pick is the right one, at a glance: how hard the task reads (three steps), each option with how much of its limit is
 * left, and the winner marked. One short line of words, the rest is shape: the bars say what a paragraph would.
 */

const TIER_LABEL: Record<RouteTier, string> = { light: "Light", standard: "Everyday", heavy: "Hard" };
const TIER_STEP: Record<RouteTier, number> = { light: 1, standard: 2, heavy: 3 };

export function TierMeter({ tier }: { tier: RouteTier }) {
  return (
    <span className={`rw-tier t-${tier}`} title={`${TIER_LABEL[tier]} task`}>
      <span className="rw-steps" aria-hidden>
        {[1, 2, 3].map((n) => (
          <i key={n} className={n <= TIER_STEP[tier] ? "on" : ""} />
        ))}
      </span>
      {TIER_LABEL[tier]}
    </span>
  );
}

export interface RouteOption {
  key: string;
  /** Best for its value rather than its odds: says "Best value". */
  value?: boolean;
  label: string;
  /** Whose it is, quieter beside it: the tool a model runs in. */
  sub?: string;
  mark: ReactNode;
  /** 0 to 1 of its limit still free; null when it doesn't say (drawn as a dashed bar). */
  room: number | null;
  /** Its chance of getting the task right, drawn instead of room when weighing models of one tool (they share its limits). */
  odds?: number;
  /** A task's cost on it at a glance ($, $$, $$$). */
  cost?: string;
  /** Why it can't be picked now, said instead of its bar. */
  out?: string | null;
  best?: boolean;
}

export function RouteWhy({ tier, why, options, action }: { tier: RouteTier; why: string; options: RouteOption[]; action?: ReactNode }) {
  return (
    <div className="rw" role="group" aria-label={`${TIER_LABEL[tier]} task: ${why}`}>
      <div className="rw-head">
        <TierMeter tier={tier} />
        <span className="rw-why">{why}</span>
      </div>
      <ul className="rw-opts">
        {options.map((o) => (
          <li key={o.key} className={`rw-opt${o.best ? " best" : ""}${o.out ? " out" : ""}`}>
            <span className="rw-mark">{o.mark}</span>
            <span className="rw-name">
              {o.label}
              {o.sub && <span className="rw-sub">{o.sub}</span>}
            </span>
            {o.out ? (
              <span className="rw-out">{o.out}</span>
            ) : o.odds !== undefined ? (
              <>
                <span className="rw-bar odds" title={`${Math.round(o.odds * 100)}% likely to get this right`}>
                  <i style={{ width: `${Math.round(o.odds * 100)}%` }} />
                </span>
                <span className="rw-room">
                  {Math.round(o.odds * 100)}%{o.cost && <span className="rw-cost">{o.cost}</span>}
                </span>
              </>
            ) : (
              <>
                <span className={`rw-bar${o.room === null ? " unknown" : ""}`} title={o.room === null ? "Doesn't share its limits" : `${Math.round(o.room * 100)}% of its limit left`}>
                  <i style={{ width: `${o.room === null ? 100 : Math.round(o.room * 100)}%` }} />
                </span>
                <span className="rw-room">{o.room === null ? "—" : `${Math.round(o.room * 100)}%`}</span>
              </>
            )}
            {o.best && <span className="rw-best">{o.value ? "Best value" : "Best"}</span>}
          </li>
        ))}
      </ul>
      {action && <div className="rw-foot">{action}</div>}
    </div>
  );
}

/** What the agent picker shows about the task being typed: how hard it reads, and each ready tool's fit with the model it would take. */
export interface RouteHint {
  tier: RouteTier;
  why: string;
  best: EngineTool;
  /** The best tool was put first for its value: another reads as likelier, for clearly more (see routing's `better`). */
  bestForValue: boolean;
  tools: Partial<Record<EngineTool, ToolRank>>;
  /** Each routable model of each tool, weighed for the task (fitModels): its chance of getting it right and its cost. */
  fits: Partial<Record<EngineTool, ModelFit[]>>;
}

/** Whether a coding tool can be put on Auto: one with models of more than one size that routing has figures for. */
export const canRoute = (tool: EngineTool) => ENGINE_MODEL_INFO[tool].some((m) => m.id === "auto");

/** Smart routing, as this person last left it on this computer: new sessions start with it the same. */
const ROUTING_KEY = "mpa.smartRouting";
export function smartRoutingOn(): boolean {
  try {
    return localStorage.getItem(ROUTING_KEY) === "1";
  } catch {
    return false;
  }
}
export function saveSmartRouting(on: boolean): void {
  try {
    localStorage.setItem(ROUTING_KEY, on ? "1" : "0");
  } catch {
    /* this visit only */
  }
}

/** A task's cost on a model at a glance: a dollar sign for cents, two for tens of cents, three for a dollar or more. */
export const costMark = (usd: number) => (usd < 0.1 ? "$" : usd < 0.9 ? "$$" : "$$$");

/**
 * The coding model that fits a task best, as the person types it: for each tool set up on this computer, the size of model it
 * would take the task on, ranked by room left in that tool's limits and, for harder work, by how well it takes it on
 * (routing.ts). Null until there is a task to read. Only a suggestion, shown in the agent picker (AgentModelPicker).
 */
export function useRouteHint(identity: Identity, task: string, ready: EngineTool[]): RouteHint | null {
  const limits = useToolLimits(identity);
  const learned = useLearned(identity);
  const key = ready.join(",");
  return useMemo(() => {
    if (task.trim().split(/\s+/).length < 6 || !ready.length) return null;
    const { tier, why } = taskTier(task);
    const glance = glanceOf(limits);
    const options = ready.map((tool) => {
      const rows = glance[tool].rows;
      const used = rows.map((r) => r.used).filter((u): u is number => u !== null);
      return { tool, ready: true, fullest: used.length ? Math.max(...used) : null, windows: rows.map((r) => ({ kind: r.label, label: r.label, usedPercent: r.used })) };
    });
    const ranked = rankTools(tier, options, why, learned);
    const best = ranked[0];
    if (!best || best.out) return null;
    return {
      tier,
      why,
      best: best.tool,
      bestForValue: !!best.value,
      tools: Object.fromEntries(ranked.map((r) => [r.tool, r])),
      fits: Object.fromEntries(options.map((o) => [o.tool, fitModels(o.tool, tier, o.windows, learned)])),
    };
  }, [limits, learned, task, key]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** What runs in this workspace have shown about each model (route-learning.ts), asked once a visit. */
let learnedRead: Promise<Learned> | null = null;
// Another workspace, another record of how its runs went (App.tsx switches in place): forgotten once, before the pickers ask again.
if (typeof window !== "undefined") window.addEventListener("friday:workspace-switched", () => (learnedRead = null));
export function useLearned(identity: Identity, off = false): Learned {
  const [learned, setLearned] = useState<Learned>({});
  useEffect(() => {
    // `off`: no workspace to ask (a recording's page), which reads as nothing learnt yet.
    if (off) return;
    let live = true;
    const read = () => {
      // What routing learnt about Friday's own models is the hosted service's; on someone's own computer there is none.
      learnedRead ??= isLocal() ? Promise.resolve({}) : api<{ learned: Learned }>(identity, "/api/workspace/route-stats").then((r) => r.learned ?? {}, () => ({}));
      void learnedRead.then((l) => live && setLearned(l));
    };
    read();
    addEventListener("friday:workspace-switched", read);
    return () => {
      live = false;
      removeEventListener("friday:workspace-switched", read);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return learned;
}
