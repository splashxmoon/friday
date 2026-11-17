import { useEffect, useState, type CSSProperties } from "react";
import { api } from "./api.js";
import type { Identity } from "./storage.js";
import { shortTokens } from "../tool-usage.js";
import type { Spend, SpendRun, Tokens } from "../spend.js";
import { Face, mateOn, useTeamNow } from "./Teammates.js";
import "./spend.css";

/**
 * Where a crew mate's or a room's tokens went, all of them (Arun, 2026-11-15: "we track everything like input, output, cache,
 * etc to see how much their total spend is for an agent or in a crew room too we want to basically audit everything and give
 * visibility to the user for them to trust an agent working autonomously"): the total at list price, each kind of token and what
 * it came to, what the cache saved, by day, by crew mate, by model, and every run with who started it and what it used.
 */

type Got = Spend & { days: number; names: Record<string, string>; places: Record<string, string> };
const SPANS = [
  { days: 1, label: "Today" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
] as const;
const KINDS: { key: keyof Omit<Tokens, "reasoning">; label: string; about: string }[] = [
  { key: "input", label: "Input", about: "Read fresh: your messages, files, tool results" },
  { key: "cacheWrite", label: "Cache write", about: "Saved to the cache to read back cheaply later" },
  { key: "cacheRead", label: "Cache read", about: "Read back from the cache, at a tenth of the price" },
  { key: "output", label: "Output", about: "What it wrote, its reasoning included" },
];

const WHY_KINDS: [string, string][] = [
  ["asked", "Asked"],
  ["mate", "From the crew"],
  ["routine", "Routines"],
  ["wake", "Wake-ups"],
  ["friday", "Friday"],
  ["session", "Sessions"],
  ["app", "Apps"],
];

export const dollars = (n: number) => (n === 0 ? "$0" : n < 0.01 ? "<$0.01" : n < 100 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString()}`);
const total = (t: Tokens) => t.input + t.cacheWrite + t.cacheRead + t.output;
const timeOf = (ts: number) => new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const took = (r: SpendRun) => (r.endedAt ? Math.max(1, Math.round((r.endedAt - r.startedAt) / 60_000)) : null);

export function SpendPage({ identity, query, who }: { identity: Identity; query: string; /** "Sage", "Launch": said in the empty state. */ who: string }) {
  const [days, setDays] = useState<number>(7);
  const [got, setGot] = useState<Got | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  /** Runs of one kind only: why they started (run-why.ts). */
  const [why, setWhy] = useState<string>("all");
  useTeamNow();
  useEffect(() => {
    let live = true;
    setErr("");
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    api<Got>(identity, `/api/teammates/spend?${query}&days=${days}&tz=${encodeURIComponent(tz)}`)
      .then((g) => live && setGot(g))
      .catch((e: Error) => live && setErr(e.message || "Couldn't read what it spent."));
    return () => void (live = false);
  }, [identity, query, days]);
  const all = got ? total(got.tokens) : 0;
  const peak = got ? Math.max(1, ...got.byDay.map((d) => d.tokens)) : 1;
  // Dollars only where there are some: a page of "$0" beside every row said nothing (Arun, 2026-11-17: "fix the typography and
  // cramped text, and clutter").
  const priced = !!got && got.usd > 0;
  const usdOr = (n: number | null) => (n === null ? <span className="sp-none" title="No list price for this model">—</span> : dollars(n));
  const typical = got && got.runs.length >= 3 ? [...got.runs].sort((a, b) => total(a.tokens) - total(b.tokens))[Math.floor(got.runs.length / 2)]! : null;
  return (
    <div className="sp">
      <div className="sp-head">
        <h3>Spend</h3>
        <div className="rt-seg sp-span" role="radiogroup" aria-label="Over">
          {SPANS.map((s) => (
            <button key={s.days} type="button" role="radio" aria-checked={days === s.days} className="rt-seg-opt" onClick={() => setDays(s.days)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      {err && <p className="sp-err">{err}</p>}
      {!got && !err && <p className="sp-quiet">Adding it up…</p>}
      {got && !all && <p className="sp-quiet">{who} hasn't used anything {days === 1 ? "today" : `in the last ${days} days`}.</p>}
      {got && all > 0 && (
        <>
          {/* The total, then three figures under it; tokens are the headline when nothing has a list price. */}
          <div className="sp-hero">
            <div className="sp-hero-top">
              <span className="sp-usd">{priced ? dollars(got.usd) : shortTokens(all)}</span>
              <span className="sp-hero-unit">{priced ? "at list price" : "tokens"}</span>
            </div>
            <dl className="sp-stats">
              {priced && (
                <div>
                  <dt>Tokens</dt>
                  <dd>{shortTokens(all)}</dd>
                </div>
              )}
              <div>
                <dt>Runs</dt>
                <dd>{got.runs.length}</dd>
              </div>
              <div>
                <dt>Turns</dt>
                <dd>{got.turns}</dd>
              </div>
              {/* What a run of its usually comes to, from its own runs: the estimate before handing it the next one. */}
              {typical && (
                <div>
                  <dt>Typical run</dt>
                  <dd>{typical.usd ? dollars(typical.usd) : shortTokens(total(typical.tokens))}</dd>
                </div>
              )}
            </dl>
          </div>
          {got.unpriced > 0 && (
            <p className="sp-flag">
              {got.unpriced >= all ? "None of these models has a list price" : `${shortTokens(got.unpriced)} tokens ran on models with no list price`}, so {got.unpriced >= all ? "there's no dollar figure" : "they aren't in the total"}. Counted all the same.
            </p>
          )}

          {/* Each kind of token, as a share of all of them and what it came to. */}
          <div className="sp-bar" role="img" aria-label={KINDS.map((k) => `${k.label} ${shortTokens(got.tokens[k.key])}`).join(", ")}>
            {KINDS.map((k) => (got.tokens[k.key] ? <i key={k.key} className={`sp-k-${k.key}`} style={{ flexGrow: got.tokens[k.key] } as CSSProperties} /> : null))}
          </div>
          <ul className="sp-kinds" data-priced={priced || undefined}>
            {KINDS.map((k) => (
              <li key={k.key} title={k.about}>
                <span className={`sp-dot sp-k-${k.key}`} aria-hidden="true" />
                <span className="sp-kind-label">{k.label}</span>
                <span className="sp-kind-n">{shortTokens(got.tokens[k.key])}</span>
                {priced && <span className="sp-kind-usd">{dollars(got.usdByKind[k.key])}</span>}
              </li>
            ))}
            {got.tokens.reasoning > 0 && (
              <li className="sp-sub" title="Part of its output">
                <span className="sp-dot" aria-hidden="true" />
                <span className="sp-kind-label">of which reasoning</span>
                <span className="sp-kind-n">{shortTokens(got.tokens.reasoning)}</span>
                {priced && <span className="sp-kind-usd" />}
              </li>
            )}
          </ul>
          {got.cacheSaved >= 0.01 && (
            <p className="sp-note">
              The cache saved <span className="sp-note-saved">{dollars(got.cacheSaved)}</span>: {Math.round((got.tokens.cacheRead / Math.max(1, got.tokens.cacheRead + got.tokens.input + got.tokens.cacheWrite)) * 100)}% of what it read came from it.
            </p>
          )}

          {got.byDay.length > 1 && (
            <section className="sp-sec" aria-label="By day">
              <h4>By day</h4>
              <div className="sp-days">
                {got.byDay.map((d) => (
                  <span key={d.day} className="sp-day" title={`${d.day}: ${shortTokens(d.tokens)} tokens, ${dollars(d.usd)}`}>
                    <i style={{ height: `${Math.max(4, Math.round((d.tokens / peak) * 100))}%` }} />
                    <small>{new Date(`${d.day}T12:00:00`).toLocaleDateString(undefined, got.byDay.length > 10 ? { day: "numeric" } : { weekday: "short" })}</small>
                  </span>
                ))}
              </div>
            </section>
          )}

          {got.byLane.length > 1 && (
            <section className="sp-sec" aria-label="By crew mate">
              <h4>By crew mate</h4>
              <ul className="sp-rows" data-priced={priced || undefined}>
                {got.byLane.map((l) => {
                  const m = mateOn(l.lane);
                  const name = m?.name ?? got.names[l.lane] ?? "A crew mate";
                  return (
                    <li key={`${l.sid} ${l.lane}`}>
                      <span className="sp-row-mark">{m ? <Face seed={m.look ?? m.name} size={20} /> : null}</span>
                      <span className="sp-row-label">{name}</span>
                      <span className="sp-row-n">{shortTokens(total(l.tokens))}</span>
                      {priced && <span className="sp-row-usd">{dollars(l.usd)}</span>}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <section className="sp-sec" aria-label="By model">
            <h4>By model</h4>
            <ul className="sp-rows" data-priced={priced || undefined}>
              {got.byModel.map((m) => (
                <li key={m.model}>
                  <span className="sp-row-mark" aria-hidden="true" />
                  <span className={`sp-row-label${/\s/.test(m.model) ? "" : " sp-mono"}`}>{m.model}</span>
                  <span className="sp-row-n">{shortTokens(total(m.tokens))}</span>
                  {priced && <span className="sp-row-usd">{usdOr(m.usd)}</span>}
                </li>
              ))}
            </ul>
          </section>

          {/* Every run, newest first: who started it and why, where, what it used. Open one for its tokens by kind. */}
          <section className="sp-sec" aria-label="Runs">
            <div className="sp-runs-head">
              <h4>Runs</h4>
              {/* By why they started, only the kinds there are (Arun, 2026-11-15: "You could also filter by it"). */}
              {new Set(got.runs.map((r) => r.by.kind)).size > 1 && (
                <div className="sp-why" role="radiogroup" aria-label="Started by">
                  {[["all", "All"], ...WHY_KINDS.filter(([k]) => got.runs.some((r) => r.by.kind === k))].map(([k, label]) => (
                    <button key={k} type="button" role="radio" aria-checked={why === k} onClick={() => setWhy(k!)}>
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <ul className="sp-runs">
              {got.runs.filter((r) => why === "all" || r.by.kind === why).map((r) => {
                const m = mateOn(r.lane);
                const name = m?.name ?? got.names[r.lane] ?? "A crew mate";
                const where = got.places[r.sid] ?? "A coding session";
                const on = open === r.seq;
                const mins = took(r);
                return (
                  <li key={`${r.sid} ${r.seq}`} className={on ? "on" : undefined}>
                    <button type="button" className="sp-run" aria-expanded={on} onClick={() => setOpen(on ? null : r.seq)}>
                      <span className="sp-row-mark">{m ? <Face seed={m.look ?? m.name} size={18} /> : null}</span>
                      <span className="sp-run-text">
                        <span className="sp-run-ask">{r.ask || r.by.label}</span>
                        <span className="sp-run-meta">
                          {name} · {r.by.label} · {where} · {timeOf(r.startedAt)}
                        </span>
                      </span>
                      <span className="sp-run-num">
                        {priced ? (
                          <>
                            <span className="sp-row-usd">{usdOr(r.usd)}</span>
                            <small>{shortTokens(total(r.tokens))}</small>
                          </>
                        ) : (
                          <span className="sp-row-usd">{shortTokens(total(r.tokens))}</span>
                        )}
                      </span>
                    </button>
                    {on && (
                      <dl className="sp-run-detail">
                        {KINDS.map((k) => (
                          <div key={k.key}>
                            <dt>{k.label}</dt>
                            <dd>{shortTokens(r.tokens[k.key])}</dd>
                          </div>
                        ))}
                        <div>
                          <dt>Turns</dt>
                          <dd>{r.turns}</dd>
                        </div>
                        <div>
                          <dt>Took</dt>
                          <dd>{mins === null ? "still going" : `${mins} min`}</dd>
                        </div>
                        <div className="sp-wide">
                          <dt>Model</dt>
                          <dd>{r.models.join(", ") || "not said"}</dd>
                        </div>
                      </dl>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
          <p className="sp-note sp-foot">List price is what this work would cost on each model's API. On a Claude or ChatGPT plan you pay your plan; this shows what the work is worth and where it went, from what each coding tool reported every turn.</p>
        </>
      )}
    </div>
  );
}
