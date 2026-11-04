import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { MenuButton } from "./ui.js";
import { priceOf, type MateBudget } from "../team-budget.js";
import type { SessionEvent } from "../types.js";
import { Face, mateOn } from "./Teammates.js";

/**
 * A teammate's budget and hours, in its Settings and the New teammate dialog (team-budget.ts): a daily cap in tokens or dollars,
 * a share of its plan's window, its work hours and its quiet hours, in the keeper's own time zone. Nothing is capped unless set.
 */

const DAILY = [0, 200_000, 500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000];
const DAYS = ["S", "M", "T", "W", "T", "F", "S"];
const tokensLabel = (n: number) => (n ? `${n >= 1_000_000 ? `${n / 1_000_000}M` : `${n / 1000}k`} tokens a day` : "No cap");

/** A budget with only what is set, or null when nothing is. */
function kept(b: Partial<MateBudget>, tz: string): MateBudget | null {
  const out: MateBudget = { tz, ...(b.tokens ? { tokens: b.tokens } : {}), ...(b.usd ? { usd: b.usd } : {}), ...(b.planPct ? { planPct: b.planPct } : {}), ...(b.hours ? { hours: b.hours } : {}), ...(b.quiet ? { quiet: b.quiet } : {}) };
  return Object.keys(out).length > 1 ? out : null;
}

export function BudgetFields({ value, onChange, tool, model }: { value: MateBudget | null; onChange: (b: MateBudget | null) => void; tool: string; model?: string }) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const b: Partial<MateBudget> = value ?? {};
  const put = (more: Partial<MateBudget>) => onChange(kept({ ...b, ...more }, tz));
  const priced = !!priceOf({ tool, model });
  const tokenOpts = b.tokens && !DAILY.includes(b.tokens) ? [...DAILY, b.tokens].sort((x, y) => x - y) : DAILY;
  const hours = b.hours;
  const quiet = b.quiet;
  // Friday's own controls, not the system's (Arun, 2026-11-03: the labels wrapped in their 72px column and the selects opened the
  // Mac's own menu): one wide label column that never wraps, a menu of Friday's for the cap, a segmented choice for the plan's
  // window, switches for the hours.
  return (
    <fieldset className="tm-where tm-budget">
      <legend>Budget and hours</legend>
      <div className="tb-row">
        <span className="tb-label">Daily cap</span>
        <div className="tb-ctl">
          <MenuButton className="tb-pick" text={tokensLabel(b.tokens ?? 0)} label="Tokens a day" compact items={() => tokenOpts.map((n) => ({ label: tokensLabel(n), checked: (b.tokens ?? 0) === n, onSelect: () => put({ tokens: n || undefined }) }))} />
          <span className="tb-or">or</span>
          <label className={`tb-usd${priced ? "" : " off"}`}>
            <span aria-hidden="true">$</span>
            <input type="number" min={0} step="0.5" inputMode="decimal" placeholder="—" value={b.usd ?? ""} disabled={!priced} aria-label="Dollars a day" onChange={(e) => put({ usd: Number(e.target.value) > 0 ? Number(e.target.value) : undefined })} />
            <span>a day</span>
          </label>
        </div>
        <small className="tb-help">{priced ? "Tokens read fresh and written, wherever it works; cache reads aren't counted. Dollars at its model's API list price." : "Tokens read fresh and written, wherever it works. Its model has no known price, so only the token cap applies."}</small>
      </div>
      {tool !== "friday" && (
        <div className="tb-row">
          <span className="tb-label">Plan's window</span>
          <div className="tb-ctl">
            <span className="tb-seg" role="radiogroup" aria-label="Stop at this much of its plan's usage window">
              {[0, 50, 75, 90].map((p) => (
                <button key={p} type="button" role="radio" aria-checked={(b.planPct ?? 0) === p} className={(b.planPct ?? 0) === p ? "on" : ""} onClick={() => put({ planPct: p || undefined })}>
                  {p ? `${p}%` : "All"}
                </button>
              ))}
            </span>
          </div>
          <small className="tb-help">How much of its five-hour or weekly limit it may use, so some is left for you.</small>
        </div>
      )}
      <div className="tb-row">
        <span className="tb-label">Work hours</span>
        <div className="tb-ctl">
          <Switch checked={!!hours} aria-label="Only in work hours" onCheckedChange={(on) => put({ hours: on ? { from: "09:00", to: "18:00", days: [1, 2, 3, 4, 5] } : undefined })} />
          {hours ? (
            <>
              <Input type="time" className="tm-time" value={hours.from} aria-label="Work starts" onChange={(e) => put({ hours: { ...hours, from: e.target.value || "09:00" } })} />
              <span className="tb-or">to</span>
              <Input type="time" className="tm-time" value={hours.to} aria-label="Work ends" onChange={(e) => put({ hours: { ...hours, to: e.target.value || "18:00" } })} />
            </>
          ) : (
            <span className="tb-state">Any time</span>
          )}
        </div>
        {hours && (
          <span className="tm-days tb-days" role="group" aria-label="Days it works">
            {DAYS.map((d, n) => (
              <button key={n} type="button" aria-pressed={hours.days.includes(n)} onClick={() => put({ hours: { ...hours, days: hours.days.includes(n) ? hours.days.filter((x) => x !== n) : [...hours.days, n].sort() } })}>
                {d}
              </button>
            ))}
          </span>
        )}
      </div>
      <div className="tb-row">
        <span className="tb-label">Quiet hours</span>
        <div className="tb-ctl">
          <Switch checked={!!quiet} aria-label="Quiet hours" onCheckedChange={(on) => put({ quiet: on ? { from: "23:00", to: "07:00" } : undefined })} />
          {quiet ? (
            <>
              <Input type="time" className="tm-time" value={quiet.from} aria-label="Quiet from" onChange={(e) => put({ quiet: { ...quiet, from: e.target.value || "23:00" } })} />
              <span className="tb-or">to</span>
              <Input type="time" className="tm-time" value={quiet.to} aria-label="Quiet until" onChange={(e) => put({ quiet: { ...quiet, to: e.target.value || "07:00" } })} />
            </>
          ) : (
            <span className="tb-state">None</span>
          )}
        </div>
      </div>
      <small className="tm-checkin-note">
        At a cap or outside its hours it finishes the step it's on, keeps what's queued and carries on in its next window, or the next day. A message from you still goes through. Times are yours ({tz}).
      </small>
    </fieldset>
  );
}

/** A teammate stopped for its budget or hours (team.budget): one quiet line, its face and why. */
export function BudgetLine({ ev, stamp }: { ev: SessionEvent; stamp: ReactNode }) {
  if (ev.body.type !== "team.budget") return null;
  const m = mateOn(ev.body.lane);
  return (
    <div className="tt-event">
      <span className="tt-event-face">{m ? <Face seed={m.look ?? m.name} size={20} /> : null}</span>
      <span className="tt-event-text">{ev.body.text}</span>
      <span className="tt-stamp">{stamp}</span>
    </div>
  );
}
