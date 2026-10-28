import { useEffect, useMemo, useState } from "react";
import type { Limits } from "../runner/limits.js";
import { shortTokens, USAGE_TOOLS, type CarriedEntry, type Tokens, type UsageDay, type UsageTool } from "../tool-usage.js";
import { EngineMark } from "./BrandMarks.js";
import { FridayMark } from "./icons.js";
import { hostApi } from "./local.js";
import { useToolLimits } from "./toolLimits.js";
import type { Identity } from "./storage.js";
import { ENGINE_NAMES, toolList } from "../types.js";
import { Skeleton, SkeletonCards, SkeletonRows, barHeight, relTime } from "./ui.js";
import { ArrowRightIcon, ArrowRightLeftIcon, ChartColumnIcon, CircleAlertIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Choice, EmptyState, PageHeader, SectionHeader, StatTile, surface } from "@/components/dass";
import { LimitsHub } from "./LimitsHub.js";

/**
 * Every agent a workspace runs, in tokens: Friday's own and the coding tools people bring (Claude Code, Codex, Cursor), side by
 * side, which no tool shows on its own. Tokens, not money: most people run those tools on a subscription, where what they meet
 * is a limit, so each tool's limit as it stands now is here too.
 *
 * And "tokens saved", said as what it is: when an agent joined or took over, what the agents before it had spent getting the
 * work there, less what Friday passed on. Both measured; that redoing the work would have cost as much again is the estimate.
 */

const NAMES: Record<UsageTool, string> = { friday: "Friday", ...ENGINE_NAMES };
const RANGES: ["7" | "30" | "90", string][] = [
  ["7", "7 days"],
  ["30", "30 days"],
  ["90", "90 days"],
];
type Range = (typeof RANGES)[number][0];

const sum = (t: Tokens) => t.input + t.cached + t.output;

function Mark({ tool }: { tool: UsageTool }) {
  return tool === "friday" ? <FridayMark size={16} /> : <EngineMark tool={tool} size={16} />;
}

/** "Jun 4", for a day key. */
const dayName = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/**
 * `solo`: your own coding tools, on your own plans. Friday's own agent isn't there (its row shows only if your history has it),
 * there is no allowance to point at, and everything listed is yours, so nobody's name goes in front of it.
 */
export function UsagePage({ identity, solo = false }: { identity: Identity; solo?: boolean }) {
  const [range, setRange] = useState<Range>("30");
  const [data, setData] = useState<{ days: UsageDay[]; recent: CarriedEntry[] } | null>(null);
  const [failed, setFailed] = useState("");
  const [tries, setTries] = useState(0);
  // From the shared reading (toolLimits.ts): shown at once, refreshed behind.
  const read = useToolLimits(identity);
  const limits = read && read !== "none" ? read : null;
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    setFailed("");
    fetch(`/api/workspace/tool-usage?days=${range}`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Friday didn't answer."))))
      .then((b) => live && setData(b))
      .catch((e) => live && setFailed(e instanceof TypeError ? "Friday can't be reached. Check your connection." : (e as Error).message));
    return () => {
      live = false;
    };
  }, [range, tries]);

  // "Arun's Claude Code" is "Claude Code" when everything here is yours.
  const own = (name: string) => (solo ? name.replace(/^[^']+'s /, "") : name);
  const days = data?.days ?? [];
  const totals = useMemo(() => {
    const by: Record<UsageTool, Tokens & { turns: number }> = Object.fromEntries(USAGE_TOOLS.map((t) => [t, { input: 0, cached: 0, output: 0, turns: 0 }])) as never;
    const carried = { spent: 0, sent: 0, count: 0 };
    for (const d of days) {
      for (const t of USAGE_TOOLS) {
        const x = d.tools[t];
        if (!x) continue;
        by[t].input += x.input;
        by[t].cached += x.cached;
        by[t].output += x.output;
        by[t].turns += x.turns;
      }
      carried.spent += d.carried.spent;
      carried.sent += d.carried.sent;
      carried.count += d.carried.count;
    }
    return { by, carried };
  }, [days]);
  const used = USAGE_TOOLS.filter((t) => totals.by[t].turns > 0);
  const total = used.reduce((n, t) => n + sum(totals.by[t]), 0);
  const turns = used.reduce((n, t) => n + totals.by[t].turns, 0);
  const saved = Math.max(0, totals.carried.spent - totals.carried.sent);
  const dayTotal = (d: UsageDay) => USAGE_TOOLS.reduce((n, t) => n + (d.tools[t] ? sum(d.tools[t]!) : 0), 0);
  const peak = Math.max(1, ...days.map(dayTotal));
  const every = days.length > 45 ? 14 : days.length > 20 ? 5 : days.length > 10 ? 2 : 1;

  return (
    <div className="page conns-page usage-page px-6!">
      <div className="flex flex-col gap-10">
        <PageHeader
          className="mb-0"
          title="Usage"
          subtitle={solo ? "Your coding tools' limits right now, and the tokens they have used." : "Your coding tools' limits right now, and the tokens every agent in this workspace has used."}
        />

        <section aria-label="Limits">
          <SectionHeader title="Limits" description="Read from the coding tools on this computer, every two minutes." />
          <LimitsHub read={read} />
        </section>

        <section aria-label="Activity" className="flex flex-col gap-6">
          <SectionHeader
            className="mb-0"
            title="Activity"
            description={solo ? `Your coding tools, in tokens: ${toolList("and")}.` : "Every agent in this workspace, in tokens: Friday's own and the coding tools people bring."}
            action={<Choice<Range> label="Range" value={range} options={RANGES} onChange={setRange} />}
          />

          {failed ? (
            <EmptyState
              icon={<CircleAlertIcon />}
              tone="bad"
              title="Couldn't read the usage"
              action={
                <Button variant="outline" size="sm" onClick={() => setTries((t) => t + 1)}>
                  Try again
                </Button>
              }
            >
              <span role="alert">{failed}</span>
            </EmptyState>
          ) : !data ? (
            // The tiles, the chart and the table, in their places, until the figures arrive.
            <div className="flex flex-col gap-4" role="status" aria-label="Reading the usage">
              <SkeletonCards count={3} h={92} min={220} />
              <Skeleton h={200} r={12} />
              <SkeletonRows rows={3} />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3 max-md:grid-cols-1">
                <StatTile label="Tokens used" value={shortTokens(total)} sub={`${turns} turn${turns === 1 ? "" : "s"} across ${used.length} agent${used.length === 1 ? "" : "s"}`} />
                <StatTile
                  label="Tokens saved · estimate"
                  value={saved ? `≈${shortTokens(saved)}` : "—"}
                  sub={totals.carried.count ? `Across ${totals.carried.count} hand-off${totals.carried.count === 1 ? "" : "s"} between agents` : "None yet: it starts at the first hand-off"}
                />
                <StatTile
                  label="Read from a cache"
                  value={total ? `${Math.round((used.reduce((n, t) => n + totals.by[t].cached, 0) / total) * 100)}%` : "—"}
                  sub="Cheaper and faster than reading it fresh"
                />
              </div>

              <div>
                <h3 className="mt-0 mb-2 text-[13px] font-semibold text-[var(--ink)]">Each day, by agent</h3>
                {total === 0 ? (
                  <EmptyState icon={<ChartColumnIcon />} title="Nothing counted in this range" className="py-8">
                    {solo ? "" : "Friday's own agent is counted from its next step; "}
                    {toolList("and")} {solo ? "are counted " : ""}from their next turn on a computer running Friday 0.1.32 or later.
                  </EmptyState>
                ) : (
                  <div className={cn(surface, "px-4 py-4")}>
                    <div className="usage-chart tools" role="img" aria-label={`Tokens used each day over ${days.length} days, by agent`} onMouseLeave={() => setHover(null)}>
                      {days.map((d, i) => {
                        const all = dayTotal(d);
                        return (
                          <div key={d.day} className={`usage-day${hover === i ? " on" : ""}`} onMouseEnter={() => setHover(i)}>
                            <div className="usage-stack tools" style={{ height: barHeight(all / peak) }}>
                              {/* Top to bottom in the column; the first tool sits on the baseline. */}
                              {[...USAGE_TOOLS].reverse().map((t) => (d.tools[t] ? <span key={t} className={`usage-part tool-${t}`} style={{ flexGrow: sum(d.tools[t]!) }} /> : null))}
                            </div>
                            <span className="usage-tick">{(days.length - 1 - i) % every === 0 ? d.day.slice(8) : " "}</span>
                          </div>
                        );
                      })}
                      {hover !== null && days[hover] && (
                        // Slid by as much as it is along, so the first day's card starts at its bar, the last day's ends at it, and none hangs off the chart.
                        <div className="usage-tip" style={{ left: `${((hover + 0.5) / days.length) * 100}%`, transform: `translateX(-${((hover + 0.5) / days.length) * 100}%)` }}>
                          <strong>{dayName(days[hover]!.day)}</strong>
                          {USAGE_TOOLS.filter((t) => days[hover]!.tools[t]).map((t) => (
                            <span key={t}>
                              <i className={`key tool-${t}`} /> {NAMES[t]} <b>{shortTokens(sum(days[hover]!.tools[t]!))}</b>
                            </span>
                          ))}
                          {!dayTotal(days[hover]!) && <span className="muted">Nothing that day</span>}
                        </div>
                      )}
                    </div>
                    <div className="usage-legend">
                      {used.map((t) => (
                        <span key={t}>
                          <i className={`key tool-${t}`} /> {NAMES[t]} · {shortTokens(sum(totals.by[t]))}
                        </span>
                      ))}
                      <span className="usage-legend-total">Hover a day for its numbers</span>
                    </div>
                  </div>
                )}
              </div>

              <div>
                <h3 className="mt-0 mb-2 text-[13px] font-semibold text-[var(--ink)]">By agent</h3>
                <div className={cn(surface, "overflow-x-auto")}>
                  <div className="min-w-[640px]" role="table" aria-label="Tokens by agent">
                    <div className={cn(ROW, "border-b border-[var(--border)] py-2 text-[12px] font-medium text-[var(--text-muted)]")} role="row">
                      <span role="columnheader">Agent</span>
                      <span role="columnheader" className="text-right">Turns</span>
                      <span role="columnheader" className="text-right">Read fresh</span>
                      <span role="columnheader" className="text-right">From cache</span>
                      <span role="columnheader" className="text-right">Written</span>
                      <span role="columnheader" className="text-right">Total</span>
                      <span role="columnheader">Its limit now</span>
                    </div>
                    {USAGE_TOOLS.filter((t) => !solo || t !== "friday" || totals.by.friday.turns > 0).map((t) => {
                      const x = totals.by[t];
                      return (
                        <div key={t} className={cn(ROW, "border-b border-[var(--border)] py-2.5 text-[13px] tabular-nums text-[var(--ink-2)] last:border-b-0", !x.turns && "text-[var(--text-muted)]")} role="row">
                          <span role="cell" className={cn("flex min-w-0 items-center gap-2 font-medium text-[var(--ink)]", !x.turns && "font-normal text-[var(--text-muted)]")}>
                            <Mark tool={t} /> <span className="truncate">{NAMES[t]}</span>
                          </span>
                          <span role="cell" className="text-right">{x.turns || "—"}</span>
                          <span role="cell" className="text-right">{x.turns ? shortTokens(x.input) : "—"}</span>
                          <span role="cell" className="text-right">{x.turns ? shortTokens(x.cached) : "—"}</span>
                          <span role="cell" className="text-right">{x.turns ? shortTokens(x.output) : "—"}</span>
                          <span role="cell" className={cn("text-right", x.turns && "font-semibold text-[var(--ink)]")}>{x.turns ? shortTokens(sum(x)) : "—"}</span>
                          <span role="cell" className="truncate text-[13px] text-[var(--text-muted)]">
                            {solo && t === "friday" ? "—" : limitNow(t, limits)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div>
                <h3 className="mt-0 mb-1 flex items-baseline gap-2 text-[13px] font-semibold text-[var(--ink)]">
                  Tokens saved
                  {data.recent.length > 0 && <span className="font-normal tabular-nums text-[var(--text-muted)]">{data.recent.length}</span>}
                </h3>
                <p className="mt-0 mb-3 max-w-[70ch] text-[13px] leading-relaxed text-[var(--text-muted)]">
                  When an agent joins or takes over, Friday hands it the work so far instead of starting from scratch. Saved is what that work cost, minus what was handed over. Cache re-reads don't count.
                </p>
                {data.recent.length === 0 ? (
                  <EmptyState icon={<ArrowRightLeftIcon />} title="No hand-offs in this range yet" className="py-8">
                    The first time one agent picks up from another, what it saved shows here.
                  </EmptyState>
                ) : (
                  <ul className={cn(surface, "m-0 list-none divide-y divide-[var(--border)] px-4 py-0")}>
                    {data.recent.map((r) => (
                      <li key={`${r.sid}-${r.at}`} className="flex items-center gap-3 py-2.5 text-[13px]">
                        <ArrowRightIcon className="size-3.5 shrink-0 text-[var(--text-muted)]" />
                        <span className="min-w-0 flex-1 truncate text-[var(--ink-2)]" title={`${own(r.to)} ${r.kind === "handoff" ? "took over from" : "caught up on"} ${r.from.map(own).join(", ")} · ${r.title}`}>
                          <b className="font-medium text-[var(--ink)]">{own(r.to)}</b> {r.kind === "handoff" ? "took over from" : "caught up on"} {r.from.map(own).join(", ")}
                          <span className="text-[var(--text-muted)]"> · {r.title}</span>
                        </span>
                        <span className="shrink-0 font-medium tabular-nums text-[var(--ink)]" title={`${r.spent.toLocaleString()} tokens spent before, ${r.sent.toLocaleString()} passed on`}>
                          ≈{shortTokens(Math.max(0, r.spent - r.sent))} saved
                        </span>
                        <span className="w-16 shrink-0 text-right text-[12px] text-[var(--text-muted)]">{relTime(r.at)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <p className="m-0 max-w-[80ch] text-[12px] leading-relaxed text-[var(--text-muted)]">
                Counted from what each tool reports at the end of every turn: its tokens, not what they cost.{" "}
                {solo
                  ? `${toolList("and")} run on your own plans, so Friday never meters them.`
                  : `${toolList("and")} run on their own plans, so they never count against Friday's; Friday's own allowance is under Settings › Usage.`}
              </p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/** The by-agent table's columns: the agent, five figures, and its limit now. */
const ROW = "grid grid-cols-[minmax(150px,1.5fr)_repeat(5,minmax(64px,1fr))_minmax(130px,1.4fr)] items-center gap-3 px-4";

/** A tool's own limit as it stands, from the computer it runs on: the fullest of its windows. */
function limitNow(tool: UsageTool, limits: Limits | null): string {
  if (tool === "friday") return "Settings › Usage";
  if (!limits) return "No computer connected";
  if (tool === "copilot") {
    const used = (limits.copilot?.windows ?? []).map((w) => (w.resetsAt && w.resetsAt * 1000 <= Date.now() ? 0 : w.usedPercent)).filter((u): u is number => u !== null);
    return used.length ? `${Math.round(Math.max(...used))}% used` : limits.copilot ? "Not known yet" : "Not reported";
  }
  if (tool === "codex" || tool === "cursor") {
    const ws = tool === "codex" ? (limits.codexWindows?.length ? limits.codexWindows : limits.codex ? [{ usedPercent: limits.codex.usedPercent, resetsAt: limits.codex.resetsAt }] : []) : (limits.cursor?.windows ?? []);
    // A window whose reset has passed has started over.
    const used = ws.map((w) => (w.resetsAt && w.resetsAt * 1000 <= Date.now() ? 0 : w.usedPercent)).filter((u): u is number => u !== null);
    return used.length ? `${Math.round(Math.max(...used))}% used` : tool === "cursor" && !limits.cursor ? "Not reported" : "Not known yet";
  }
  if (tool !== "claude") {
    // The other tools (tool-limits.ts): the fullest of their windows, else the credits left, else that nothing is reported.
    const a = limits.tools?.[tool];
    if (!a) return "Not reported";
    const used = a.windows.map((w) => (w.resetsAt && w.resetsAt * 1000 <= Date.now() ? 0 : w.usedPercent)).filter((u): u is number => u !== null);
    return used.length ? `${Math.round(Math.max(...used))}% used` : a.balanceUsd !== undefined ? `$${a.balanceUsd.toFixed(2)} left` : "Not reported";
  }
  const w = limits.claudeWindows.filter((x) => x.utilization !== null).sort((a, b) => b.utilization! - a.utilization!)[0];
  // Said in words: the internal kind ("five_hour") showed through when a window came without a label.
  const WORDS: Record<string, string> = { five_hour: "5 hours", seven_day: "the week", seven_day_opus: "the week (Opus)", seven_day_sonnet: "the week (Sonnet)" };
  return w ? `${Math.round(w.utilization! * 100)}% of ${w.label ?? WORDS[w.kind ?? ""] ?? "its window"}` : "Not known yet";
}
