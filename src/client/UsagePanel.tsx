import { useEffect, useMemo, useState } from "react";
import { doingNow } from "../activity-line.js";
import type { SessionState } from "../session/projection.js";
import { MAIN_LANE, type SessionEvent } from "../types.js";
import { shortDuration, shortTokens, usageReport, type RunUsage, type UsageRow } from "../usage-report.js";
import { agentNameFor } from "./Activity.js";
import { Icon } from "./icons.js";
import type { Identity } from "./storage.js";
import { relTime } from "./ui.js";

/**
 * What this session has used, in the order a person asks it:
 *
 *   1. Am I going to run out?  The workspace's allowance, which every session draws on.
 *   2. What has this session cost?  Tokens, when anything here reports them.
 *   3. Who is working, and on what?  One line per agent: what it is doing now, or when it last ran.
 *   4. Whose asks used it?  Only when there is more than one person and a number to split.
 *   5. What were the runs?  What was asked, who by, how it came out.
 *
 * Read from the log. Coding tools (Claude Code, Codex, OpenCode…) say what each turn used (agent.usage), so every agent has its
 * tokens here, on whatever plan it runs; one that says nothing is named as being on its own plan instead of "not counted" down a
 * whole column. In the open-source edition this is each agent's share of the session (Arun, 2026-11-03: "Per-agent cost"),
 * with no Friday allowance above it.
 */

const ago = (ts: number) => {
  const r = relTime(ts);
  return r === "now" ? "just now" : `${r} ago`;
};

/** A run that has been "going" for days was cut off, not working: show no length for it rather than a number nobody believes. */
const believable = (run: RunUsage) => run.outcome !== "running" && run.seconds > 0 && run.seconds < 6 * 3600;

/** `solo`: everything here is yours and runs on your own plans, so there is no Friday allowance to show and no "Arun's" on names. */
export function UsagePanel({ state, events, identity, solo = false }: { state: SessionState; events: SessionEvent[]; identity: Identity; solo?: boolean }) {
  const live = useMemo(() => new Set<string>([...(state.run.status === "running" ? [MAIN_LANE] : []), ...Object.entries(state.laneRuns).filter(([, x]) => x.status === "running").map(([id]) => id)]), [state.run.status, state.laneRuns]);
  const r = useMemo(() => usageReport(events, (lane) => (solo ? agentNameFor(state, lane).replace(/^[^']+'s /, "") : agentNameFor(state, lane)), live), [events, state, live, solo]);
  const [all, setAll] = useState(false);

  if (!r.runs) {
    return (
      <div className="usage">
        <div className="usage-empty">
          <p className="usage-empty-title">Nothing has run yet</p>
          <p className="usage-empty-sub">Once an agent starts working, you'll see who is doing what here, and what it used.</p>
        </div>
      </div>
    );
  }

  const counted = r.byAgent.some((x) => x.counted);
  const tools = (lane: string) => !!state.engines[lane]?.tool;
  const agents = [...r.byAgent].sort((a, b) => Number(b.running) - Number(a.running) || b.lastAt - a.lastAt);
  const runningNow = r.byAgent.filter((x) => x.running).length;
  const people = r.byPerson.filter((p) => p.counted && p.tokens > 0);
  const top = Math.max(1, ...agents.map((x) => x.tokens));
  const onOwnPlan = agents.filter((x) => tools(x.key));
  const shownRuns = all ? r.recent.slice(0, 40) : r.recent.slice(0, 6);

  return (
    <div className="usage">

      <section className="uz-block" aria-label="Agents">
        <h3 className="uz-h">
          Agents
          <span className="uz-h-hint">
            {agents.length} total{runningNow ? ` · ${runningNow} running` : ""}
            {counted ? ` · ${shortTokens(r.tokens)} tokens` : ""}
          </span>
        </h3>
        <ul className="uz-agents">
          {agents.map((x) => {
            const doing = x.running ? doingNow(events, x.key)?.text : "";
            return (
              <li key={x.key} className="uz-agent">
                <span className={`uz-dot ${x.running ? "on" : ""}`} aria-hidden="true" />
                <div className="uz-agent-main">
                  <div className="uz-agent-name">{x.label}</div>
                  <div className="uz-agent-sub">{x.running ? (doing ?? "Working") : `Last ran ${ago(x.lastAt)}`}</div>
                  {x.counted && (
                    <div className="uz-bar">
                      <i style={{ width: `${Math.max(3, (x.tokens / top) * 100)}%` }} />
                    </div>
                  )}
                </div>
                <div className="uz-agent-val">
                  {x.counted ? (
                    <>
                      <b>{shortTokens(x.tokens)}</b>
                      <span>{r.tokens > 0 ? `${Math.round((x.tokens / r.tokens) * 100)}%` : ""}</span>
                    </>
                  ) : tools(x.key) ? (
                    <span className="uz-own" title="Runs on its owner's own plan, so Friday doesn't count it">
                      Own plan
                    </span>
                  ) : (
                    <span className="uz-none">no count</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {counted && onOwnPlan.length > 0 && (
          <p className="uz-foot">
            {solo
              ? "Your coding tools run on your own plans, so Friday never meters them."
              : `${onOwnPlan.map((x) => x.label).join(", ")} ${onOwnPlan.length === 1 ? "runs" : "run"} on ${onOwnPlan.length === 1 ? "its owner's" : "their owners'"} own plan${onOwnPlan.length === 1 ? "" : "s"}.`}
          </p>
        )}
      </section>

      {counted && people.length > 1 && (
        <section className="uz-block" aria-label="Who asked">
          <h3 className="uz-h">Who asked</h3>
          <ul className="uz-people">
            {people.map((p) => (
              <li key={p.key}>
                <span className="uz-person">{p.label}</span>
                <span className="uz-person-bar">
                  <i style={{ width: `${Math.max(4, (p.tokens / (people[0]?.tokens || 1)) * 100)}%` }} />
                </span>
                <b>{shortTokens(p.tokens)}</b>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="uz-block" aria-label="Runs">
        <h3 className="uz-h">Recent runs</h3>
        <ul className="uz-runs">
          {shownRuns.map((run) => (
            <li key={run.seq} className="uz-run">
              <span className={`uz-state ${run.outcome}`} title={run.outcome === "running" ? "Running" : run.outcome === "error" ? "Stopped with an error" : run.outcome === "waiting" ? "Waiting on a person" : "Finished"} />
              <div className="uz-run-main">
                <div className="uz-run-task">{run.task || "Started by a trigger"}</div>
                <div className="uz-run-meta">
                  {run.agent}
                  {run.by ? ` · asked by ${run.by.split(/\s+/)[0]}` : ""} · {run.outcome === "running" ? "now" : ago(run.ts)}
                </div>
              </div>
              <span className="uz-run-val">{run.counted ? shortTokens(run.tokens) : believable(run) ? shortDuration(run.seconds) : ""}</span>
            </li>
          ))}
        </ul>
        {!all && r.recent.length > 6 && (
          <button type="button" className="uz-more" onClick={() => setAll(true)}>
            Show all {r.recent.length} runs <Icon name="chevronDown" size={12} />
          </button>
        )}
      </section>
    </div>
  );
}
