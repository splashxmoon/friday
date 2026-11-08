import { useEffect, useMemo, useState } from "react";
import type { Limits } from "../runner/limits.js";
import { shortTokens, USAGE_TOOLS, type CarriedEntry, type Tokens, type UsageDay, type UsageTool } from "../tool-usage.js";
import { EngineMark } from "./BrandMarks.js";
import { FridayMark } from "./icons.js";
import { hostApi, useMachine } from "./local.js";
import { refreshToolLimits, useToolLimits } from "./toolLimits.js";
import type { Identity } from "./storage.js";
import { ENGINE_NAMES, toolList } from "../types.js";
import { Skeleton, SkeletonCards, SkeletonRows, barHeight, relTime } from "./ui.js";
import { ArrowRightIcon, ArrowRightLeftIcon, ChartColumnIcon, CircleAlertIcon, RefreshCwIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Choice, EmptyState, PageHeader, SectionHeader, surface } from "@/components/dass";
import { LimitsHub } from "./LimitsHub.js";
import { RoutingLearned } from "./RoutingLearned.js";

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
/** The range picked, kept in this browser: leaving the page and coming back put it back to 30 days (audit e2e, Arun 2026-11-04). */
const RANGE_KEY = "friday.usage.range";
function savedRange(): Range {
  try {
    const v = localStorage.getItem(RANGE_KEY);
    return RANGES.some(([r]) => r === v) ? (v as Range) : "30";
  } catch {
    return "30";
  }
}
function keepRange(r: Range): void {
  try {
    localStorage.setItem(RANGE_KEY, r);
  } catch {
    /* a preference */
  }
}

/**
 * Tokens used: read fresh and written. What a tool reads back from its cache isn't counted here: it reads the whole conversation
 * again at every step, so on a long task it is nearly all of the figure (Arun, 2026-10-31: "2177.5M" over 30 days, 97% of it
 * cache) and says nothing about the work. It is shown on its own, with the share it makes of what was read.
 */
const sum = (t: Tokens) => t.input + t.output;

function Mark({ tool }: { tool: UsageTool }) {
  return tool === "friday" ? <FridayMark size={16} /> : <EngineMark tool={tool} size={16} />;
}

/** The newest of a reading's windows: when the limits on the page were read. */
function newestReading(l: Limits): number {
  const all = [...(l.claudeWindows ?? []), ...(l.codexWindows ?? []), ...(l.codex ? [l.codex] : []), ...(l.cursor?.windows ?? []), ...(l.copilot?.windows ?? []), ...Object.values(l.tools ?? {}).flatMap((a) => a?.windows ?? [])];
  return all.reduce((n, w) => Math.max(n, w.at ?? 0), 0);
}
/** "just now", "2 min ago", "at 3:04 PM". */
function readAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  return `at ${new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

/** "Jun 4", for a day key. */
const dayName = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/**
 * `solo`: your own coding tools, on your own plans. Friday's own agent isn't there (its row shows only if your history has it),
 * there is no allowance to point at, and everything listed is yours, so nobody's name goes in front of it.
 */
export function UsagePage({ identity, solo = false }: { identity: Identity; solo?: boolean }) {
  const [range, setRange] = useState<Range>(savedRange);
  const [data, setData] = useState<{ days: UsageDay[]; recent: CarriedEntry[] } | null>(null);
  const [failed, setFailed] = useState("");
  const [tries, setTries] = useState(0);
  // From the shared reading (toolLimits.ts): shown at once, refreshed behind.
  const read = useToolLimits(identity);
  // The page that says it all reads them fresh as it opens: a reading from minutes ago said an account was out after a run on it
  // had gone through.
  useEffect(() => refreshToolLimits(identity, true), []); // eslint-disable-line react-hooks/exhaustive-deps
  const limits = read && read !== "none" ? read : null;
  // When the newest of the readings was taken, said beside Refresh; the clock moves it on.
  const readAt = limits ? newestReading(limits) : 0;
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setClock(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  // Refresh shows it is reading until a new reading lands, or for a few seconds when nothing changes.
  const [rereading, setRereading] = useState(false);
  useEffect(() => setRereading(false), [read]);
  useEffect(() => {
    if (!rereading) return;
    const t = setTimeout(() => setRereading(false), 6000);
    return () => clearTimeout(t);
  }, [rereading]);
  const [hover, setHover] = useState<number | null>(null);
  // The coding tools on this computer: the table lists those and any that did work in the range, not all sixteen Friday knows,
  // most of them dashes (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
  const { state: machine } = useMachine(identity);
  const installed = new Set<string>(machine.tools.filter((t) => t.path).map((t) => t.tool));

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
  const cached = used.reduce((n, t) => n + totals.by[t].cached, 0);
  const fresh = used.reduce((n, t) => n + totals.by[t].input, 0);
  const saved = Math.max(0, totals.carried.spent - totals.carried.sent);
  const dayTotal = (d: UsageDay) => USAGE_TOOLS.reduce((n, t) => n + (d.tools[t] ? sum(d.tools[t]!) : 0), 0);
  const peak = Math.max(1, ...days.map(dayTotal));
  // A label a week on a month, "Oct 13" rather than a bare 13 (audit REST-29, Arun 2026-11-04).
  const every = days.length > 45 ? 14 : days.length > 20 ? 7 : days.length > 10 ? 2 : 1;
  const tick = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return (
    <div className="page conns-page usage-page px-6!">
      <div className="flex flex-col gap-10">
        <PageHeader className="mb-0" title="Usage" />
        {/* No heading over the cards (Arun, 2026-11-08: "get rid of this"): the page opens on them. When they were read and a way
            to read them again stay, small, at the top right; what the thin line on a bar means is in its hover. */}
        <section aria-label="Limits" className="flex flex-col gap-3">
          <div className="lh-top">
            {readAt > 0 && <span className="lh-read num">Read {readAgo(readAt, clock)}</span>}
            <Button variant="ghost" size="xs" className="text-[var(--text-muted)]" disabled={rereading} onClick={() => (setRereading(true), refreshToolLimits(identity, true))} aria-label="Read the limits again">
              <RefreshCwIcon className={cn("size-3.5", rereading && "animate-spin")} />
              {rereading ? "Reading…" : "Refresh"}
            </Button>
          </div>
          <LimitsHub read={read} />
        </section>

        <section aria-label="Activity" className="flex flex-col gap-6">
          <SectionHeader
            className="mb-0"
            title="Activity"
            description={solo ? `Your coding tools, in tokens: ${toolList("and")}.` : "Every agent in this workspace, in tokens: Friday's own and the coding tools people bring."}
            action={<Choice<Range> label="Range" value={range} options={RANGES} onChange={(r) => (setRange(r), keepRange(r))} />}
          />

          {failed ? (
            <EmptyState
              small
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
              {total === 0 ? (
                <EmptyState small icon={<ChartColumnIcon />} title="Nothing counted in this range" className="py-8">
                  {solo ? "" : "Friday's own agent is counted from its next step; "}
                  {toolList("and")} {solo ? "are counted " : ""}from their next turn on a computer running Friday 0.1.32 or later.
                </EmptyState>
              ) : (
                <div className={cn(surface, "us-act")}>
                  <div className="us-act-side">
                    <div className="us-act-total">
                      <span className="us-k">Used</span>
                      <span className="us-big num">{shortTokens(total)}</span>
                      <span className="us-s num">
                        {turns.toLocaleString()} turn{turns === 1 ? "" : "s"}, read fresh and written
                      </span>
                    </div>
                    <ul className="us-split" aria-label="Tokens by agent">
                      {[...used].sort((a, b) => sum(totals.by[b]) - sum(totals.by[a])).map((t) => (
                        <li key={t}>
                          <span className="us-split-row">
                            <span className="us-split-name">
                              <i className={`key tool-${t}`} />
                              {NAMES[t]}
                            </span>
                            <b className="num">{shortTokens(sum(totals.by[t]))}</b>
                          </span>
                          <span className="us-split-track">
                            <i className={`usage-part tool-${t}`} style={{ width: `${Math.max(1.5, (sum(totals.by[t]) / total) * 100)}%` }} />
                          </span>
                        </li>
                      ))}
                    </ul>
                    <dl className="us-facts">
                      <div title="When an agent joins or takes over, what the work so far cost, minus what was handed over: an estimate">
                        <dt>Saved by {totals.carried.count} hand-off{totals.carried.count === 1 ? "" : "s"}</dt>
                        <dd className="num">{saved ? `≈${shortTokens(saved)}` : "—"}</dd>
                      </div>
                      <div title={cached ? `${shortTokens(cached)} read back, cheaper and faster than reading it fresh` : "Cheaper and faster than reading it fresh"}>
                        <dt>Read from a cache</dt>
                        <dd className="num">{cached + fresh ? `${Math.round((cached / (cached + fresh)) * 100)}%` : "—"}</dd>
                      </div>
                    </dl>
                  </div>
                  <div className="us-act-chart">
                    <div className="usage-chart tools" role="img" aria-label={`Tokens used each day over ${days.length} days, by agent`} onMouseLeave={() => setHover(null)}>
                      {days.map((d, i) => {
                        const all = dayTotal(d);
                        return (
                          <div key={d.day} className={`usage-day${hover === i ? " on" : ""}`} onMouseEnter={() => setHover(i)}>
                            <div className="usage-stack tools" style={{ height: barHeight(all / peak) }}>
                              {/* Top to bottom in the column; the first tool sits on the baseline. */}
                              {[...USAGE_TOOLS].reverse().map((t) => (d.tools[t] ? <span key={t} className={`usage-part tool-${t}`} style={{ flexGrow: sum(d.tools[t]!) }} /> : null))}
                            </div>
                            <span className="usage-tick">{(days.length - 1 - i) % every === 0 ? (i === days.length - 1 ? "Today" : tick(d.day)) : " "}</span>
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
                  </div>
                </div>
              )}

              <div>
                <h3 className="mt-0 mb-2 text-[13px] font-semibold text-[var(--ink)]">By agent</h3>
                {/* scroll-x-cue: a narrow window scrolls the table sideways, and a shade at the cut edge says so (style.css). */}
                <div className={cn(surface, "scroll-x-cue overflow-x-auto")}>
                  <div className="min-w-[560px]" role="table" aria-label="Tokens by agent">
                    <div className={cn(ROW, "border-b border-[var(--border)] py-2 text-[12px] font-medium text-[var(--text-muted)]")} role="row">
                      <span role="columnheader">Agent</span>
                      <span role="columnheader" className="text-right">Turns</span>
                      <span role="columnheader" className="text-right">Read fresh</span>
                      <span role="columnheader" className="text-right">From cache</span>
                      <span role="columnheader" className="text-right">Written</span>
                      <span role="columnheader" className="text-right" title="Read fresh and written: what is read from the cache isn't counted">Used</span>
                    </div>
                    {USAGE_TOOLS.filter((t) => totals.by[t].turns > 0 || (t === "friday" ? !solo : installed.has(t) || !installed.size)).map((t) => {
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
                  <EmptyState small icon={<ArrowRightLeftIcon />} title="No hand-offs in this range yet" className="py-8">
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

              <RoutingLearned identity={identity} />

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

/** The by-agent table's columns: the agent and five figures. Its limit is on its card at the top of the page, said once. */
const ROW = "grid grid-cols-[minmax(150px,1.6fr)_repeat(5,minmax(64px,1fr))] items-center gap-3 px-4";
