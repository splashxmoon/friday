import { useEffect, useState } from "react";
import { aboutTime, estimate, taskOf } from "../forecast.js";
import type { SessionState } from "../session/projection.js";
import { MAIN_LANE, type SessionEvent } from "../types.js";
import { forecastOf, idOf, readHistory, windowsOf } from "./limitHistory.js";
import { repoOfEngine, useRouting } from "./RouteWhy.js";
import type { Identity } from "./storage.js";
import { useToolLimits } from "./toolLimits.js";

/**
 * The small line on a running turn (Arun, 2026-10-31): about how long is left, from the runs here like it (forecast.ts), and,
 * for the person's own coding tool, when its window fills at the pace this computer's readings show (limitHistory.ts), if
 * that comes before it would start over. Empty when there is nothing to say.
 */
export function useRunForecast(identity: Identity, state: SessionState, events: SessionEvent[], lane: string, active: boolean, me: string, /** A recording's page: nothing of anyone's to ask. */ off = false): string {
  const routing = useRouting(identity, off);
  const limits = useToolLimits(identity, off);
  // A minute's resolution is plenty for "~20 min left".
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [active]);
  const engine = state.engines[lane];
  if (!active || !engine?.tool) return "";
  // Timed from the run's start, whichever piece of the reply this is (a hand-off card can split one run's reply in two).
  const start = events.findLast((e) => (e.lane ?? MAIN_LANE) === lane && e.body.type === "run.started");
  if (!start) return "";
  const startedAt = start.ts;
  const cause = start?.body.type === "run.started" ? events.find((e) => e.seq === (start.body as { causedBy: number }).causedBy) : undefined;
  const text = cause?.body.type === "instruction" ? cause.body.text : "";
  const bits: string[] = [];
  if (text) {
    const repo = repoOfEngine(engine);
    const e = estimate(routing.records, { tool: engine.tool, ...taskOf(text), ...(repo ? { repo } : {}) }, now);
    const left = startedAt + e.ms - now;
    // Past its forecast: said once, plainly, rather than a countdown below zero.
    bits.push(left >= 90_000 ? `${aboutTime(left)} left` : "longer than runs like it");
  }
  if (engine.hostId === me) {
    const history = readHistory();
    const full = windowsOf(limits, now)
      .filter((w) => w.tool === engine.tool)
      .map((w) => ({ w, f: forecastOf(w, history[idOf(w)] ?? [], now) }))
      .filter((x) => x.f?.fullAt && x.f.fullAt - now < 3 * 3_600_000)
      .sort((a, b) => a.f!.fullAt! - b.f!.fullAt!)[0];
    if (full) bits.push(`${full.w.label} limit around ${new Date(full.f!.fullAt!).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} at this pace`);
  }
  return bits.join(" · ");
}
