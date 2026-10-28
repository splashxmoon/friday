import { useEffect, useMemo, useState } from "react";
import type { Limits } from "../runner/limits.js";
import { ENGINE_NAMES, ENGINE_TOOLS, type EngineTool } from "../types.js";
import { EngineMark } from "./BrandMarks.js";
import {
  PRICES_CHECKED,
  chooseLimitAlerts,
  cyclesOf,
  forecastOf,
  idOf,
  isFiveHour,
  isWeekly,
  limitAlertsOn,
  listPrice,
  mostRoom,
  readCosts,
  readHistory,
  rightSize,
  saveCost,
  weekGrid,
  windowsOf,
  type Forecast,
  type History,
  type Win,
} from "./limitHistory.js";
import { notificationsOn } from "./prefs.js";
import type { Read } from "./toolLimits.js";
import { Skeleton } from "./ui.js";
import { PlugIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { EmptyState, SettingsGroup, SettingsRow, StatTile, StateBadge, surface } from "@/components/dass";
import { LimitRing } from "./LimitRing.js";

/**
 * The coding tools' limits as one place to plan the day from: each tool's five-hour and weekly windows as rings, the pace
 * they are being used at and where that ends, what the plans cost and whether a smaller one would do, which tool has the
 * most room right now, and a week of five-hour windows. Read from this computer's tools; the history is kept here too.
 */

const clock = (sec: number) => new Date(sec * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const day = (sec: number) => new Date(sec * 1000).toLocaleDateString([], { weekday: "short" });
function until(sec: number, now: number): string {
  const m = Math.max(0, Math.round((sec * 1000 - now) / 60_000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}
/** One meaning for every limit, whatever the tool: green with room, yellow from 70%, red from 90%. */
const level = (used: number) => (used >= 90 ? "hot" : used >= 70 ? "warm" : "ok");

/** The plan each tool says it is on. */
function planOf(tool: EngineTool, l: Limits): string | null {
  if (tool === "claude") return l.claudePlan ?? null;
  if (tool === "codex") return l.codex?.plan ?? null;
  if (tool === "cursor") return l.cursor?.plan ?? null;
  if (tool === "copilot") return l.copilot?.plan ?? null;
  return l.tools?.[tool]?.plan ?? null;
}

/** What the pace says, in a line: when it runs out, or where it ends. */
function paceLine(w: Win, f: Forecast | null, now: number): string {
  if (!f) return w.used > 0 ? "Pace shows after a few readings" : "Not used yet";
  if (f.perHour === 0) return "Not moving right now";
  if (f.fullAt) return `At this pace, full by ${new Date(f.fullAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${w.resetsAt ? `, ${until(w.resetsAt, f.fullAt)} before it resets` : ""}`;
  return f.atReset !== null ? `At this pace, ${f.atReset}% when it resets` : `${Math.round(f.perHour)}% an hour`;
}

function WindowView({ w, history, now }: { w: Win; history: History; now: number }) {
  const f = forecastOf(w, history[idOf(w)] ?? [], now);
  return (
    <div className="lh-win">
      <LimitRing used={w.used} label={`${w.label === "5h" ? "5-hour" : w.label} limit`} />
      <div className="lh-win-text">
        <span className="lh-win-label">{w.label === "5h" ? "5-hour" : w.label}</span>
        <span className="lh-win-reset">{w.resetsAt ? `Resets ${isFiveHour(w) ? `at ${clock(w.resetsAt)}` : `${day(w.resetsAt)} ${clock(w.resetsAt)}`} · in ${until(w.resetsAt, now)}` : "Reset time not reported"}</span>
        <span className={`lh-win-pace ${f?.fullAt ? "warn" : ""}`}>{paceLine(w, f, now)}</span>
      </div>
    </div>
  );
}

function CostLine({ tool, plan, cost, onCost }: { tool: EngineTool; plan: string | null; cost: number | undefined; onCost: (usd: number | null) => void }) {
  const list = listPrice(tool, plan);
  const usd = cost ?? list?.usd;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  if (editing)
    return (
      <form
        className="lh-cost"
        onSubmit={(e) => {
          e.preventDefault();
          const v = text.trim() === "" ? null : Number(text.replace(/[$,\s]/g, ""));
          onCost(v === null || Number.isFinite(v) ? v : null);
          setEditing(false);
        }}
      >
        <label className="lh-cost-edit">
          <span>$</span>
          <input autoFocus inputMode="decimal" aria-label={`What you pay for ${ENGINE_NAMES[tool]} a month`} value={text} placeholder={list ? String(list.usd) : "0"} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setEditing(false)} />
          <span>/ month</span>
        </label>
        <Button type="submit" variant="ghost" size="xs" className="ml-auto">
          Save
        </Button>
      </form>
    );
  return (
    <div className="lh-cost">
      <span className="lh-cost-n">{usd === undefined ? "Cost unknown" : `$${usd % 1 ? usd.toFixed(2) : usd} / month`}</span>
      <span className="lh-cost-src">{cost !== undefined ? "your figure" : list ? `${list.tier} list price` : ""}</span>
      <Button variant="ghost" size="xs" className="ml-auto text-[var(--text-muted)]" onClick={() => (setText(usd !== undefined ? String(usd) : ""), setEditing(true))}>
        {usd === undefined ? "Add" : "Edit"}
      </Button>
    </div>
  );
}

export function LimitsHub({ read }: { read: Read }) {
  const limits = read && read !== "none" ? read : null;
  const [now, setNow] = useState(Date.now);
  // Countdowns move on the minute; the readings themselves come every two minutes (toolLimits.ts).
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const history = useMemo(() => readHistory(), [read]); // eslint-disable-line react-hooks/exhaustive-deps
  const [costs, setCosts] = useState(readCosts);
  const [alerts, setAlerts] = useState(limitAlertsOn);
  const wins = useMemo(() => windowsOf(limits, now), [limits, now]);

  if (read === null)
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3" role="status" aria-label="Reading your coding tools' limits">
        <Skeleton h={180} r={12} />
        <Skeleton h={180} r={12} />
      </div>
    );
  if (!limits)
    return (
      <EmptyState icon={<PlugIcon />} title="No computer connected" className="py-8">
        Connect your computer, and the limits of the coding tools on it show here.
      </EmptyState>
    );

  // Every tool with a window or a plan, the ones with windows first.
  // Claude Code read without a figure (it said only whether its limits allow the next turn) still gets its card: it was left
  // out altogether while the footer's card listed it (2026-10-27 audit).
  const claudeSaid = (limits.claudeWindows ?? []).filter((w) => w.kind !== "overage");
  const tools = ENGINE_TOOLS.filter((t) => wins.some((w) => w.tool === t) || planOf(t, limits) || (t === "claude" && claudeSaid.length > 0)).sort((a, b) => Number(wins.some((w) => w.tool === b)) - Number(wins.some((w) => w.tool === a)));
  const fives = wins.filter(isFiveHour);
  const weeklies = wins.filter(isWeekly);
  const closestWeek = [...weeklies].sort((a, b) => b.used - a.used)[0];
  const room = mostRoom(wins);
  const costOf = (t: EngineTool) => costs[t] ?? listPrice(t, planOf(t, limits))?.usd;
  const spend = tools.reduce((n, t) => n + (costOf(t) ?? 0), 0);
  const hints = tools.flatMap((t) => {
    const usd = costOf(t);
    const week = weeklies.filter((w) => w.tool === t).sort((a, b) => b.used - a.used)[0];
    const h = usd ? rightSize(t, usd, week, now) : null;
    return h ? [{ tool: t, now: usd!, ...h }] : [];
  });

  return (
    <div className="flex flex-col gap-5">
      {/* The one line to read first: every five-hour window, and the week closest to its end. */}
      {fives.length > 0 && (
        <div className="lh-strip" role="status" aria-label="Five-hour limits now">
          {fives.map((w) => (
            <span key={idOf(w)} className={`lh-chip ${level(w.used)}`} title={w.resetsAt ? `${ENGINE_NAMES[w.tool]}: resets at ${clock(w.resetsAt)}` : ENGINE_NAMES[w.tool]}>
              <EngineMark tool={w.tool} size={13} />
              <b>{Math.round(w.used)}%</b>
              <span>of 5 hours{w.resetsAt ? ` · resets ${clock(w.resetsAt)}` : ""}</span>
            </span>
          ))}
          {closestWeek && (
            <span className={`lh-chip quiet ${level(closestWeek.used)}`}>
              Week: {ENGINE_NAMES[closestWeek.tool]} closest, <b>{Math.round(closestWeek.used)}%</b>
            </span>
          )}
        </div>
      )}

      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
        {tools.map((t) => {
          const mine = wins.filter((w) => w.tool === t);
          // Every window as the same ring, with when it resets and where its pace leads: the five-hour first, then the week,
          // then the rest (a model's own week, a month's allowance). The same shape on every card.
          const rings = [...mine.filter(isFiveHour), ...mine.filter((w) => isWeekly(w) && !isFiveHour(w)), ...mine.filter((w) => !isFiveHour(w) && !isWeekly(w))];
          const plan = planOf(t, limits);
          return (
            <section key={t} className={cn(surface, "flex flex-col gap-3.5 p-4")} aria-label={ENGINE_NAMES[t]}>
              <header className="flex items-center gap-2.5">
                <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-[var(--border)] bg-[var(--card)]">
                  <EngineMark tool={t} size={15} />
                </span>
                <b className="text-[14px] font-semibold text-[var(--ink)]">{ENGINE_NAMES[t]}</b>
                {plan && <StateBadge className="ml-auto">{plan}</StateBadge>}
              </header>
              {rings.length ? rings.map((w) => <WindowView key={idOf(w)} w={w} history={history} now={now} />) : <p className="m-0 text-[13px] text-[var(--text-muted)]">{mine.length ? "" : t === "claude" && claudeSaid.length ? (claudeSaid.some((w) => w.status === "rejected") ? "Out of usage for now: its limit was reached." : "Under the limit. Claude Code said so without a figure for how much is used.") : "No limits reported on this plan"}</p>}
              <CostLine tool={t} plan={plan} cost={costs[t]} onCost={(v) => setCosts(saveCost(t, v))} />
            </section>
          );
        })}
      </div>

      <div className="grid grid-cols-3 gap-3 max-md:grid-cols-1">
        <StatTile
          label="Most room right now"
          value={
            room ? (
              <span className="flex items-center gap-2 text-[18px]">
                <EngineMark tool={room.tool} size={16} /> {ENGINE_NAMES[room.tool]}
              </span>
            ) : (
              "—"
            )
          }
          sub={room ? `${room.left}% of its 5 hours left` : "Needs two tools with a 5-hour limit to compare."}
        />
        <StatTile label="Plans, a month" value={spend ? `$${spend % 1 ? spend.toFixed(2) : spend}` : "—"} sub={`List prices as of ${PRICES_CHECKED} unless you set your own`} />
        <StatTile
          label="Plan size"
          value={hints.length ? "Could be smaller" : "—"}
          sub={
            hints.length
              ? hints.map((h) => (
                  <span key={h.tool} className="block">
                    <b className="font-medium text-[var(--ink-2)]">{ENGINE_NAMES[h.tool]}</b> is on pace for {h.pace}% of its week: {h.tier} at ${h.usd} a month may be enough (now ${h.now}).
                  </span>
                ))
              : "Each plan fits how much you use it, or it's too early in the week to tell."
          }
        />
      </div>

      {fives.length > 0 && (
        <section className="lh-history" aria-label="Five-hour limits through the week">
          <div className="lh-section-head">
            <h3 className="m-0 text-[13px] font-semibold text-[var(--ink)]">The week, hour by hour</h3>
            <span className="lh-legend" aria-hidden>
              <i className="lh-hcell" /> <i className="lh-hcell ok" style={{ opacity: 0.55 }} /> <i className="lh-hcell ok" /> <i className="lh-hcell warm" /> <i className="lh-hcell hot" /> full
            </span>
          </div>
          <div className="lh-heats">
            {fives.map((w) => {
              const g = weekGrid(history[idOf(w)] ?? [], now);
              return (
                <div key={idOf(w)} className="lh-heat">
                  <div className="lh-heat-head">
                    <EngineMark tool={w.tool} size={14} />
                    <b>{ENGINE_NAMES[w.tool]}</b>
                    <span className="lh-heat-stats">
                      {g.hits > 0 && <span className={g.hits > 1 ? "hot" : "warm"}>{g.hits}× full</span>}
                      {g.busiest && g.busiest.used > 0 && <span>Peak {g.busiest.day} {g.busiest.hour % 12 || 12} {g.busiest.hour < 12 ? "AM" : "PM"}</span>}
                    </span>
                  </div>
                  <div className="lh-heat-grid" role="img" aria-label={`${ENGINE_NAMES[w.tool]}'s 5-hour limit each hour this week${g.hits ? `, full ${g.hits} times` : ""}`}>
                    <span aria-hidden />
                    {[0, 6, 12, 18].map((h) => (
                      <span key={h} className="lh-heat-hour" aria-hidden style={{ gridColumn: `${h + 2} / span 6` }}>
                        {h === 0 ? "12a" : h === 12 ? "12p" : h < 12 ? `${h}a` : `${h - 12}p`}
                      </span>
                    ))}
                    {g.days.map((d) => (
                      <div key={d.label} className="lh-heat-row">
                        <span className="lh-heat-day">{d.label}</span>
                        {d.hours.map((u, h) => (
                          <i
                            key={h}
                            className={`lh-hcell ${u === null ? "" : level(u)}`}
                            style={u !== null && u < 70 ? { opacity: 0.35 + (u / 70) * 0.65 } : undefined}
                            title={u === null ? `${d.label} ${h}:00 · not read` : `${d.label} ${h}:00 · ${Math.round(u)}%`}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <SettingsGroup>
        <SettingsRow
          label="Tell me when a 5-hour limit passes 80%"
          hint={notificationsOn() ? "One notification per window, with when it resets." : "Notifications are off in Settings › Notifications, so nothing will show."}
        >
          <Switch aria-label="Tell me when a 5-hour limit passes 80%" checked={alerts} onCheckedChange={(v) => (setAlerts(v), chooseLimitAlerts(v))} />
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}
