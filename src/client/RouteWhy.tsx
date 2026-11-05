import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Learned, LearnedItem } from "../route-learning.js";
import { estimate, forecastLine, pctOf, taskOf, type RunRecord } from "../forecast.js";
import { repoKeyOf } from "../repo-key.js";
import { api } from "./api.js";
import { fitModels, rankTools, taskTier, type ModelFit, type ToolRank } from "../routing.js";
import { ENGINE_MODEL_INFO, ENGINE_NAMES, type EngineTool, type RouteTier } from "../types.js";
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

export function RouteWhy({ tier, why, options, action, forecast }: { tier: RouteTier; why: string; options: RouteOption[]; action?: ReactNode; /** How long it should take and how much of a window (forecast.ts): a line under the head. */ forecast?: ReactNode }) {
  return (
    <div className="rw" role="group" aria-label={`${TIER_LABEL[tier]} task: ${why}`}>
      <div className="rw-head">
        <TierMeter tier={tier} />
        <span className="rw-why">{why}</span>
      </div>
      {forecast && <p className="rw-forecast">{forecast}</p>}
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
  /** Each tool's forecast for the task, on the model it would take it on: "~40 min · about 12% of your Claude window". */
  forecasts: Partial<Record<EngineTool, string>>;
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
  const routing = useRouting(identity);
  const learned = routing.learned;
  const key = ready.join(",");
  return useMemo(() => {
    if (task.trim().split(/\s+/).length < 6 || !ready.length) return null;
    const { tier, why } = taskTier(task);
    const kind = taskOf(task).kind;
    const glance = glanceOf(limits);
    const options = ready.map((tool) => {
      const rows = glance[tool].rows;
      const used = rows.map((r) => r.used).filter((u): u is number => u !== null);
      return { tool, ready: true, fullest: used.length ? Math.max(...used) : null, windows: rows.map((r) => ({ kind: r.label, label: r.label, usedPercent: r.used })) };
    });
    const ranked = rankTools(tier, options, why, learned, { kind });
    const best = ranked[0];
    if (!best || best.out) return null;
    return {
      tier,
      why,
      best: best.tool,
      bestForValue: !!best.value,
      tools: Object.fromEntries(ranked.map((r) => [r.tool, r])),
      fits: Object.fromEntries(options.map((o) => [o.tool, fitModels(o.tool, tier, o.windows, learned, { kind })])),
      forecasts: Object.fromEntries(ranked.filter((r) => !r.out).map((r) => [r.tool, forecastFor(routing, { tool: r.tool, model: r.model, text: task })])),
    };
  }, [limits, routing, task, key]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** A plan's window as people name it: Claude's, Codex's. */
const windowName = (tool: EngineTool) => (tool === "claude" ? "Claude" : ENGINE_NAMES[tool]);

/**
 * A task's forecast on a tool (forecast.ts), from the runs here the page was sent: time, and the share of the plan's window when
 * that plan's tokens per percent is known. Another person's plan is never known here (`whose` names it, time only).
 */
export function forecastFor(r: Routing, o: { tool: EngineTool; model?: string | null; text: string; repo?: string; whose?: string }): string {
  const { tier, kind } = taskOf(o.text);
  const e = estimate(r.records, { tool: o.tool, tier, kind, ...(o.model ? { model: o.model } : {}), ...(o.repo ? { repo: o.repo } : {}) });
  return forecastLine(e, { tier, pct: o.whose ? null : pctOf(e.tokens, r.perPct[o.tool]), tool: windowName(o.tool), ...(o.whose ? { whose: o.whose } : {}) });
}

/** The repo a lane's engine works on, as run records name it (run-log.ts repoOfLane). */
export const repoOfEngine = (e: { repo?: string | null; cwd: string } | undefined) => (e ? repoKeyOf({ url: e.repo ?? null, github: e.repo && /^[\w.-]+\/[\w.-]+$/.test(e.repo) ? e.repo : null }, e.cwd)?.key : undefined);

/** The forecast on Auto's routing card for the task it picked for (Activity's model.routed). */
export function RoutedForecast({ identity, tool, model, text, engine, me }: { identity: Identity; tool: EngineTool; model: string; text: string; engine?: { repo?: string | null; cwd: string; hostId: string; hostName: string }; me: string }) {
  const routing = useRouting(identity);
  if (!text.trim()) return null;
  const repo = repoOfEngine(engine);
  return <>{forecastFor(routing, { tool, model, text, ...(repo ? { repo } : {}), ...(engine && engine.hostId !== me ? { whose: `${engine.hostName}'s` } : {}) })}</>;
}

/** What the page reads for forecasts and "What routing learned" (/api/routing): recent runs, this person's plans, the view. */
export interface Routing {
  records: RunRecord[];
  /** This person's plans: tokens per percent of each tool's window. */
  perPct: Record<string, number>;
  /** What routing has learnt, as the pickers weigh it (route-learning.ts). */
  learned: Learned;
  view: LearnedItem[];
}
const NOTHING: Routing = { records: [], perPct: {}, learned: {}, view: [] };

/** Asked when something first shows it, again when what was read is a minute old (runs keep ending), after a reset or a workspace switch. */
let routingRead: Promise<Routing> | null = null;
let routingAt = 0;
const ROUTING_FRESH_MS = 60_000;
const routingListeners = new Set<() => void>();
/** Read again (after a reset, or a run worth counting), and everything showing it updates. */
export function rereadRouting(next?: Routing): void {
  routingRead = next ? Promise.resolve(next) : null;
  routingAt = next ? Date.now() : 0;
  for (const fn of routingListeners) fn();
}
// Another workspace, another record of how its runs went (App.tsx switches in place): forgotten once, before the pickers ask again.
if (typeof window !== "undefined") window.addEventListener("friday:workspace-switched", () => rereadRouting());

/**
 * The routing read, shared by everything showing it. Signed out (a recording or watch link's page) there is no workspace to
 * ask, and the ask was a 401 in the console: nothing learnt yet, without asking.
 */
export function readRouting(identity: Identity): Promise<Routing> {
  if (!identity.id) return Promise.resolve(NOTHING);
  if (Date.now() - routingAt > ROUTING_FRESH_MS) routingRead = null;
  if (!routingRead) {
    routingAt = Date.now();
    routingRead = api<Routing>(identity, "/api/routing").then((r) => ({ ...NOTHING, ...r }), () => NOTHING);
  }
  return routingRead;
}

export function useRouting(identity: Identity, off = false): Routing {
  const [routing, setRouting] = useState<Routing>(NOTHING);
  useEffect(() => {
    // `off`: no workspace to ask (a recording's page), which reads as nothing learnt yet.
    if (off) return;
    let live = true;
    const read = () => void readRouting(identity).then((r) => live && setRouting(r));
    read();
    routingListeners.add(read);
    return () => {
      live = false;
      routingListeners.delete(read);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return routing;
}

/** What runs in this workspace have shown about each model (route-learning.ts). */
export function useLearned(identity: Identity, off = false): Learned {
  return useRouting(identity, off).learned;
}
