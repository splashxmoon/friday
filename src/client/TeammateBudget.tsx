import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
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
  return (
    <fieldset className="tm-where tm-budget">
      <legend>Budget and hours</legend>
      <label className="tm-row-field">
        <span className="tm-row-label">Daily cap</span>
        <span className="tm-row-input">
          <select className="tm-select" value={b.tokens ?? 0} aria-label="Tokens a day" onChange={(e) => put({ tokens: Number(e.target.value) || undefined })}>
            {tokenOpts.map((n) => (
              <option key={n} value={n}>
                {tokensLabel(n)}
              </option>
            ))}
          </select>
          <small>Read fresh and written, everywhere it works. Cache reads aren't counted.</small>
        </span>
      </label>
      <label className="tm-row-field">
        <span className="tm-row-label">Or in dollars</span>
        <span className="tm-row-input">
          <Input type="number" min={0} step="0.5" inputMode="decimal" className="tm-budget-usd" placeholder="No cap" value={b.usd ?? ""} aria-label="Dollars a day" onChange={(e) => put({ usd: Number(e.target.value) > 0 ? Number(e.target.value) : undefined })} />
          <small>{priced ? "A day, at its model's API list price." : "Its model has no known price (smart routing, or not a Claude model), so only the token cap applies."}</small>
        </span>
      </label>
      {tool !== "friday" && (
        <label className="tm-row-field">
          <span className="tm-row-label">Plan's window</span>
          <span className="tm-row-input">
            <select className="tm-select" value={b.planPct ?? 0} aria-label="Stop at this much of its plan's usage window" onChange={(e) => put({ planPct: Number(e.target.value) || undefined })}>
              <option value={0}>Use all of it</option>
              {[50, 75, 90].map((p) => (
                <option key={p} value={p}>
                  Stop at {p}%
                </option>
              ))}
            </select>
            <small>Of its five-hour or weekly limit, for a tool that reports it, so some is left for you.</small>
          </span>
        </label>
      )}
      <div className="tm-row-field">
        <span className="tm-row-label">Work hours</span>
        <span className="tm-row-input">
          <span className="tm-checkin-when">
            <input type="checkbox" aria-label="Only in work hours" checked={!!b.hours} onChange={(e) => put({ hours: e.target.checked ? { from: "09:00", to: "18:00", days: [1, 2, 3, 4, 5] } : undefined })} />
            {b.hours ? (
              <>
                <Input type="time" className="tm-time" value={b.hours.from} aria-label="Work starts" onChange={(e) => put({ hours: { ...b.hours!, from: e.target.value || "09:00" } })} />
                <span aria-hidden="true">to</span>
                <Input type="time" className="tm-time" value={b.hours.to} aria-label="Work ends" onChange={(e) => put({ hours: { ...b.hours!, to: e.target.value || "18:00" } })} />
                <span className="tm-days" role="group" aria-label="Days it works">
                  {DAYS.map((d, n) => (
                    <button key={n} type="button" aria-pressed={b.hours!.days.includes(n)} onClick={() => put({ hours: { ...b.hours!, days: b.hours!.days.includes(n) ? b.hours!.days.filter((x) => x !== n) : [...b.hours!.days, n].sort() } })}>
                      {d}
                    </button>
                  ))}
                </span>
              </>
            ) : (
              <small>Any time</small>
            )}
          </span>
        </span>
      </div>
      <div className="tm-row-field">
        <span className="tm-row-label">Quiet hours</span>
        <span className="tm-row-input">
          <span className="tm-checkin-when">
            <input type="checkbox" aria-label="Quiet hours" checked={!!b.quiet} onChange={(e) => put({ quiet: e.target.checked ? { from: "23:00", to: "07:00" } : undefined })} />
            {b.quiet ? (
              <>
                <Input type="time" className="tm-time" value={b.quiet.from} aria-label="Quiet from" onChange={(e) => put({ quiet: { ...b.quiet!, from: e.target.value || "23:00" } })} />
                <span aria-hidden="true">to</span>
                <Input type="time" className="tm-time" value={b.quiet.to} aria-label="Quiet until" onChange={(e) => put({ quiet: { ...b.quiet!, to: e.target.value || "07:00" } })} />
              </>
            ) : (
              <small>None</small>
            )}
          </span>
        </span>
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
