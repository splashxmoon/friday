import { useEffect, useMemo, useState } from "react";
import { shortPaths } from "./shortPaths.js";
import type { BoardCard } from "../board.js";
import { api } from "./api.js";
import { EngineMark, FridayMark } from "./BrandMarks.js";
import { Icon } from "./icons.js";
import type { Identity, RecentSession } from "./storage.js";
import { relTime } from "./ui.js";

/**
 * Under the box on the home screen: your agents right now, then your last thirteen weeks of work.
 *
 * In place of suggested prompts. Somebody opening Friday wants to know first what is running and what is waiting on them,
 * and those are one press away here; the heatmap says how the weeks have gone at a glance, the way a contribution graph does.
 */

const ORDER: Record<string, number> = { needs: 0, working: 1, review: 2, ready: 3 };
const WORDS: Record<string, string> = { needs: "Waiting", working: "Working", review: "In review", ready: "Ready" };
/** A year, as a contribution graph shows one. */
const WEEKS = 52;

function useRightNow(identity: Identity, recents: RecentSession[]) {
  const [cards, setCards] = useState<BoardCard[] | null>(null);
  const sids = recents.map((r) => r.sid).join(",");
  useEffect(() => {
    if (!sids) return setCards([]);
    let live = true;
    const ask = () =>
      !document.hidden &&
      api<{ cards: BoardCard[] }>(identity, "/api/board", { method: "POST", body: JSON.stringify({ sids: sids.split(",") }) }).then(
        (r) => live && setCards(r.cards),
        () => live && setCards((c) => c ?? []),
      );
    void ask();
    const t = setInterval(ask, 10_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [identity.id, sids]);
  return cards;
}

function useDays() {
  const [days, setDays] = useState<Day[] | null>(null);
  useEffect(() => {
    let live = true;
    // The daily counts (tool-usage.ts): kept a year, where the detail behind the Usage page is kept a hundred days.
    fetch("/api/workspace/tool-activity?days=371", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("no"))))
      .then((b: { days: Day[] }) => live && setDays(b.days), () => live && setDays([]));
    return () => void (live = false);
  }, []);
  return days;
}

/** One day: how many turns the agents took, and nothing else. */
export type Day = { day: string; turns: number };

/** Days to cells: whole weeks, Sunday at the top, today in the last column; the level is a quarter of the busiest day. */
export function heatmap(days: Day[], today = new Date()): { day: string; turns: number; level: 0 | 1 | 2 | 3 | 4 }[][] {
  const by = new Map(days.map((d) => [d.day, d.turns]));
  const peak = Math.max(1, ...by.values());
  const end = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - end.getUTCDay() - (WEEKS - 1) * 7);
  const cols: { day: string; turns: number; level: 0 | 1 | 2 | 3 | 4 }[][] = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() === 0) cols.push([]);
    const key = d.toISOString().slice(0, 10);
    const turns = by.get(key) ?? 0;
    cols.at(-1)!.push({ day: key, turns, level: turns === 0 ? 0 : (Math.min(4, Math.ceil((turns / peak) * 4)) as 1 | 2 | 3 | 4) });
  }
  return cols;
}

/** The longest run of days in a row with any work, and the run that is still going. */
export function streaks(cells: { turns: number }[]): { longest: number; current: number } {
  let longest = 0;
  let run = 0;
  for (const c of cells) {
    run = c.turns > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return { longest, current: run };
}

export function HomeActivity({ identity, recents, onOpen, onBoard }: { identity: Identity; recents: RecentSession[]; onOpen: (sid: string, invite: string) => void; onBoard?: () => void }) {
  const cards = useRightNow(identity, recents);
  const days = useDays();
  const now = (cards ?? []).filter((c) => c.column !== "idle").sort((a, b) => (ORDER[a.column] ?? 9) - (ORDER[b.column] ?? 9) || Number(b.you) - Number(a.you) || b.at - a.at);
  const cols = useMemo(() => heatmap(days ?? []), [days]);
  const flat = cols.flat();
  const total = flat.reduce((n, c) => n + c.turns, 0);
  const { longest, current } = streaks(flat);
  const active = flat.filter((c) => c.turns > 0).length;
  // The weekday with the most work over the thirteen weeks.
  const byWeekday = [0, 1, 2, 3, 4, 5, 6].map((wd) => flat.filter((c) => new Date(`${c.day}T12:00:00Z`).getUTCDay() === wd).reduce((n, c) => n + c.turns, 0));
  const busiest = total ? new Date(Date.UTC(2026, 0, 4 + byWeekday.indexOf(Math.max(...byWeekday)))).toLocaleDateString([], { weekday: "long", timeZone: "UTC" }) : null;
  const invite = (sid: string) => recents.find((r) => r.sid === sid)?.invite ?? "";
  const month = (key: string) => new Date(`${key}T12:00:00Z`).toLocaleDateString([], { month: "short" });
  // A month's name where its first week starts, as long as there is room for it before the next: a month the year begins
  // part way through (October, a year ago) had a week or two, and its name ran into November's (Arun, 2026-10-19).
  const starts = cols.flatMap((col, i) => (col[0] && (i === 0 || month(col[0].day) !== month(cols[i - 1]![0]!.day)) ? [i] : []));
  const labelAt = new Map(starts.filter((i, n) => (starts[n + 1] ?? cols.length + 3) - i >= 3).map((i) => [i, month(cols[i]![0]!.day)]));
  const nice = (key: string) => new Date(`${key}T12:00:00Z`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

  return (
    <div className="ha">
      {now.length > 0 && (
        <section className="ha-now" aria-label="Your agents right now">
          <div className="ha-head">
            <h2>Right now</h2>
            {onBoard && (
              <button type="button" className="ha-link" onClick={onBoard}>
                Agent Board <Icon name="arrowRight" size={12} />
              </button>
            )}
          </div>
          <ul className="ha-list">
            {now.slice(0, 5).map((c) => (
              <li key={c.id}>
                <button type="button" className={`ha-row ${c.column}${c.you ? " you" : ""}`} onClick={() => onOpen(c.sid, invite(c.sid))}>
                  <span className="ha-mark">{c.tool ? <EngineMark tool={c.tool} size={14} /> : c.agent === "Friday Code" ? <FridayMark size={14} /> : <Icon name="agent" size={14} />}</span>
                  <span className="ha-text">
                    <span className="ha-title" title={c.title}>{c.title}</span>
                    {/* Its task under its title only when it says something the title doesn't. */}
                    {(() => {
                      const line = shortPaths(c.task && c.task !== c.title ? c.task : c.detail || c.agent);
                      return (
                        <span className="ha-task" title={line}>
                          {line}
                        </span>
                      );
                    })()}
                  </span>
                  <span className={`ha-state ${c.column}`}>
                    <i aria-hidden />
                    {c.you && c.column === "needs" ? "Needs you" : WORDS[c.column] ?? c.status}
                  </span>
                  {c.at > 0 && <span className="ha-time">{relTime(c.at)}</span>}
                </button>
              </li>
            ))}
          </ul>
          {now.length > 5 && <p className="ha-more">{now.length - 5} more on the Agent Board</p>}
        </section>
      )}

      {days !== null && (
        <section className="ha-heat" aria-label="Your agents' work over the last year">
          <div className="ha-head">
            <h2>Your year</h2>
          </div>
          <div className="ha-grid-wrap">
            <div className="ha-graph">
              <div className="ha-months" aria-hidden>
                <span />
                {cols.map((col, i) => (
                  <span key={i}>{labelAt.get(i) ?? ""}</span>
                ))}
              </div>
              <div className="ha-grid" role="img" aria-label={`${total} turns over the last year, on ${active} days; longest streak ${longest} days`}>
                <div className="ha-days" aria-hidden>
                  <span />
                  <span>Mon</span>
                  <span />
                  <span>Wed</span>
                  <span />
                  <span>Fri</span>
                  <span />
                </div>
                {cols.map((col, i) => (
                  <div key={i} className="ha-col">
                    {col.map((c) => (
                      <i key={c.day} className={`ha-cell l${c.level}`} title={`${nice(c.day)}: ${c.turns ? `${c.turns} turn${c.turns === 1 ? "" : "s"}` : "nothing"}`} />
                    ))}
                  </div>
                ))}
              </div>
            </div>
            {/* The numbers, not a sentence: what the graph adds up to, on one line under it, the key at its end. */}
            <div className="ha-foot">
              <dl className="ha-stats">
                <div><dd>{total.toLocaleString()}</dd><dt>turns</dt></div>
                <div><dd>{active}</dd><dt>active days</dt></div>
                <div><dd>{longest}</dd><dt>{current > 1 && current === longest ? "day streak, still going" : "day longest streak"}</dt></div>
                {busiest && <div><dd>{busiest}s</dd><dt>busiest</dt></div>}
              </dl>
              <div className="ha-key" aria-hidden>
                Less <i className="ha-cell l0" /> <i className="ha-cell l1" /> <i className="ha-cell l2" /> <i className="ha-cell l3" /> <i className="ha-cell l4" /> More
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
