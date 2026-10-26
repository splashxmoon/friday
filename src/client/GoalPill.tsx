import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MAX_GOAL_NUDGES } from "../goal.js";
import { canDriveLane, driverOf, runOf, type SessionState } from "../session/projection.js";
import type { Member } from "../types.js";
import { Icon } from "./icons.js";
import type { Send } from "./useSession.js";

/**
 * Goal mode, from the composer's pill row (goal.ts): say when this agent's work is done, and Friday reads every finished turn
 * against it and keeps the agent going until it is. The pill says where the goal stands; pressing it shows the goal, the latest
 * reading, and the way to change or stop it.
 */

export function GoalPill({ ctx, lane }: { ctx: { state: SessionState; me: Member; send: Send; notify: (m: string) => void }; lane: string }) {
  const { state, me, send, notify } = ctx;
  const goal = state.goal && state.goal.lane === lane ? state.goal : null;
  const may = canDriveLane(state, me.id, lane) || driverOf(state, lane)?.id === me.id;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [check, setCheck] = useState("");
  const [busy, setBusy] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  // Drawn over the page, not inside the composer (which clips what overflows it), above the pill it belongs to.
  const [at, setAt] = useState<{ left: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = wrap.current?.getBoundingClientRect();
      if (r) setAt({ left: Math.max(8, Math.min(r.left, window.innerWidth - 456)), bottom: window.innerHeight - r.top + 8 });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!wrap.current?.contains(t) && !pop.current?.contains(t)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  // A goal set elsewhere on another lane: this pill says nothing, so the row doesn't say "Goal" twice.
  if (state.goal && state.goal.lane !== lane) return null;
  if (!goal && !may) return null;

  const run = async (cmd: Record<string, unknown>, done: string) => {
    setBusy(true);
    const r = await send(cmd);
    setBusy(false);
    if (!r.ok) return notify(r.error ?? "That didn't go through.");
    notify(done);
    setOpen(false);
  };
  const set = () => {
    const t = text.trim();
    if (!t) return;
    void run({ type: "goal.set", text: t, ...(check.trim() ? { check: check.trim() } : {}), lane }, "Goal set: every finished turn is read against it.");
  };
  const running = runOf(state, lane).status === "running";
  const word = !goal ? "Goal" : goal.met ? "Goal met" : goal.last ? (goal.nudges >= MAX_GOAL_NUDGES ? "Goal · needs you" : `Goal · not yet${goal.nudges ? ` · ${goal.nudges}` : ""}`) : running ? "Goal · working" : "Goal · set";
  const title = !goal ? "Say when this agent's work is done; Friday keeps it going until it is" : goal.text;

  return (
    <span ref={wrap} className="goal-wrap">
      <button type="button" className={`menu-pill agent-pill goal-pill${goal?.met ? " is-met" : goal ? " is-open" : ""}`} aria-expanded={open} aria-haspopup="dialog" title={title} onClick={() => setOpen((o) => !o)}>
        <Icon name="flag" size={12} /> {word}
      </button>
      {open &&
        at &&
        createPortal(
        <div ref={pop} className="goal-pop" role="dialog" aria-label="Goal for this agent's work" style={{ left: at.left, bottom: at.bottom }}>
          {goal ? (
            <div className="goal-status">
              <h4>Done when</h4>
              <p className="goal-text">{goal.text}</p>
              {goal.check && (
                <p className="muted small">
                  Proof: <code>{goal.check}</code>
                </p>
              )}
              {goal.met ? (
                <p className="goal-last is-met">
                  <Icon name="check" size={12} /> Met. {goal.met.why}
                </p>
              ) : goal.last ? (
                <p className="goal-last">
                  Not yet, after {goal.checks} turn{goal.checks === 1 ? "" : "s"}: {goal.last.why}
                  {goal.nudges >= MAX_GOAL_NUDGES ? ` The agent was asked ${MAX_GOAL_NUDGES} times; it's with you now.` : ""}
                </p>
              ) : (
                <p className="goal-last">Read after each finished turn; the agent is told to carry on until it is met.</p>
              )}
              <div className="goal-pop-acts">
                <span className="muted small">Set by {goal.by.name}</span>
                {may && (
                  <button
                    type="button"
                    className="btn ghost small"
                    disabled={busy}
                    onClick={() => {
                      setText(goal.text);
                      setCheck(goal.check ?? "");
                      void send({ type: "goal.clear" }).then((r) => (r.ok ? undefined : notify(r.error ?? "That didn't go through.")));
                    }}
                  >
                    Change
                  </button>
                )}
                {may && (
                  <button type="button" className="btn small" disabled={busy} onClick={() => void run({ type: "goal.clear" }, goal.met ? "Goal cleared." : "Goal stopped.")}>
                    {goal.met ? "Clear" : "Stop"}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              <h4>Done when</h4>
              <textarea
                autoFocus
                value={text}
                placeholder="the tests pass and a pull request is open"
                aria-label="When the work is done"
                maxLength={2000}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) set();
                }}
              />
              <input value={check} placeholder="Proof command, optional: npm test" aria-label="A command whose success proves it" maxLength={400} onChange={(e) => setCheck(e.target.value)} />
              <p className="muted small">After each finished turn Friday reads the turn against this and, until it is met, tells the agent to carry on; up to {MAX_GOAL_NUDGES} times, then it's yours.</p>
              <div className="goal-pop-acts">
                <button type="button" className="btn ghost small" onClick={() => setOpen(false)}>
                  Cancel
                </button>
                <button type="button" className="btn primary small" disabled={busy || !text.trim()} onClick={set}>
                  Set the goal
                </button>
              </div>
            </>
          )}
        </div>,
          document.body,
        )}
    </span>
  );
}
