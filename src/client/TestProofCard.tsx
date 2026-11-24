/**
 * Test proof in the chat (types.ts proof.tests, test-proof.ts; Arun, 2026-11-22: "how do we show proofs for tests ran and stuff?", then
 * "make this slimmer and better designed as well"): for a change that draws nothing, the tests that ran on it, in one line: passed or
 * failing, the test command (only its test part: "cd app && npm test" reads "npm test"), its counts and how long it took, the output on
 * request. Several commands are a line each under it; the tests that failed are named under theirs. Who ran it is on the mark; Friday
 * checking a reply that only said so says it in the line. Can be put away, as a clip can.
 */
import { useState } from "react";
import type { SessionEvent } from "../types.js";
import { countsLine, testPart } from "../test-proof.js";
import { Icon } from "./icons.js";
import "./proof-clip-card.css";

const KEY = (sid: string) => `friday.testProofHidden.${sid}`;
const hiddenOf = (sid: string): Set<number> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY(sid)) ?? "[]") as number[]);
  } catch {
    return new Set();
  }
};
const keep = (sid: string, seq: number, on: boolean) => {
  try {
    const s = hiddenOf(sid);
    if (on) s.add(seq);
    else s.delete(seq);
    localStorage.setItem(KEY(sid), JSON.stringify([...s].slice(-50)));
  } catch {}
};

type Run = Extract<SessionEvent["body"], { type: "proof.tests" }>["runs"][number];

export function TestProofCard({ ev, sid, by }: { ev: SessionEvent; sid: string; /** Whose agent ran them, for the mark's title. */ by?: string }) {
  const b = ev.body;
  const [hidden, setHidden] = useState(() => hiddenOf(sid).has(ev.seq));
  const [open, setOpen] = useState(false);
  if (b.type !== "proof.tests" || !b.runs?.length) return null;
  const runs = b.runs;
  const ok = runs.every((r) => r.ok);
  const failed = runs.reduce((n, r) => n + (r.failed ?? (r.ok ? 0 : r.failing?.length || 1)), 0);
  const title = ok ? "Tests passed" : failed === 1 ? "1 test failing" : `${failed} tests failing`;
  const who = b.by === "friday" ? "Friday ran them: the reply said the tests pass, and nothing in its turn ran them" : `Run by ${by || "the agent"} in this turn`;
  const hide = (on: boolean) => (setHidden(on), keep(sid, ev.seq, on));
  const one = runs.length === 1 ? runs[0]! : null;
  const tails = runs.filter((r) => r.tail);
  const counts = (r: Run) => countsLine(r) || (r.ok ? "passed" : "failed");
  if (hidden)
    return (
      <div className="pcc-folded">
        <Icon name={ok ? "check" : "x"} size={11} />
        <span>
          {title} · {runs.map((r) => testPart(r.command)).join(", ")}
        </span>
        <button type="button" className="link-btn" onClick={() => hide(false)}>
          Show
        </button>
      </div>
    );
  return (
    <section className={`tpc${ok ? " is-ok" : " is-bad"}`} aria-label={`Test proof: ${title}`}>
      <div className="tpc-head">
        <span className="tpc-badge" title={who} aria-label={who}>
          <Icon name={ok ? "check" : "x"} size={10} />
        </span>
        <span className="tpc-title">{title}</span>
        {one ? (
          <>
            <code className="tpc-cmd" title={one.command}>
              {testPart(one.command)}
            </code>
            <span className="tpc-counts">{counts(one)}</span>
          </>
        ) : (
          <span className="tpc-counts">{runs.length} commands</span>
        )}
        {b.by === "friday" && <span className="tpc-tag" title={who}>checked by Friday</span>}
        <span className="tpc-sp" />
        {tails.length > 0 && (
          <button type="button" className="tpc-tog" aria-expanded={open} onClick={() => setOpen(!open)}>
            Output
            <Icon name="chevronDown" size={12} className={open ? "tpc-chev open" : "tpc-chev"} />
          </button>
        )}
        <button type="button" className="pcc-x tpc-x" aria-label="Hide this test proof" title="Hide" onClick={() => hide(true)}>
          <Icon name="x" size={12} />
        </button>
      </div>
      {(!one || !!one.failing?.length) && (
        <ul className="tpc-runs">
          {runs.map((r, i) => (
            <li key={i} className={r.ok ? "ok" : "bad"}>
              {!one && (
                <div className="tpc-run">
                  <span className="tpc-dot" aria-hidden="true" />
                  <code className="tpc-cmd" title={r.command}>
                    {testPart(r.command)}
                  </code>
                  <span className="tpc-counts">{counts(r)}</span>
                </div>
              )}
              {!!r.failing?.length && (
                <ul className="tpc-failing">
                  {r.failing.map((f) => (
                    <li key={f} title={f}>
                      {f}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {open && <pre className="tpc-out">{tails.map((r) => (tails.length > 1 ? `$ ${testPart(r.command)}\n${r.tail}` : r.tail)).join("\n\n")}</pre>}
    </section>
  );
}
