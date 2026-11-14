import { useEffect, useId, useState, type ReactNode } from "react";
import { stepKind } from "../run-strip.js";
import { doingVerb, stepsSummary } from "../step-summary.js";
import { Shine } from "./shine.js";
import { Orb } from "@/components/aicss/Orb";
import { StepList, tookFor, type Step } from "./Response.js";

/**
 * A reply's work as one line (Arun, 2026-11-14, direction A of the working-state mockups: "instead of having so many of these",
 * the column of "Thought for 5s · Ran a command" rows). While the agent works the line says the step under way and changes in
 * place, the words shining across ("add that shimmer animation tho like how it goes across the text"), with a tick per step and
 * the clock. Done, it is one summary, "Worked 2m 40s · read 4 files, ran 5 commands", which opens to the steps grouped by kind
 * and what it said along the way. Ported to the open-source edition from Friday Teams 566e73d9.
 */

type Block = { kind: "work"; id: string; steps: Step[] } | { kind: "think"; key: string; thought: string; secs: number } | { kind: string };

/** What a step is doing, said while it runs: "Running npm test", "Reading cart.ts". */
const doingOf = (s: Step) => `${doingVerb(s.verb)}${s.target ? ` ${clip(s.target, 72)}` : ""}`;
const clip = (s: string, n: number) => ((t) => (t.length > n ? `${t.slice(0, n - 1)}…` : t))(s.replace(/\s+/g, " "));

/** The kind a step's group is: what it looked at, searched, changed, ran, or anything else by its own verb. */
function groupOf(s: Step): { key: string; label: string } {
  if (s.verb === "Searched the web") return { key: "web", label: "Searched the web" };
  if (s.verb === "Opened") return { key: "open", label: "Opened" };
  const k = stepKind(s);
  if (k === "read") return { key: "read", label: "Looked at" };
  if (k === "search") return { key: "search", label: "Searched" };
  if (k === "edit") return { key: "edit", label: "Changed" };
  if (k === "run" || k === "test") return { key: "run", label: "Ran" };
  if (k === "ask") return { key: "ask", label: "Asked" };
  return { key: `other:${s.verb}`, label: s.verb };
}

/** What kind of step is under way, for the mascot's motion beside the reply (style.css .rsp-avatar[data-doing]). */
export function doingKind(blocks: readonly Block[], live: boolean): string {
  if (!live) return "";
  const steps = blocks.flatMap((b) => (b.kind === "work" && "steps" in b ? b.steps : []));
  const now = steps.findLast((s) => s.state === "running");
  if (!now) return blocks.at(-1)?.kind === "think" || !steps.length ? "think" : "work";
  const k = stepKind(now);
  return k === "test" ? "run" : k;
}

function Clock({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="rl-clock">{now - since >= 1000 ? tookFor(now - since) : ""}</span>;
}

export function RunLine({ blocks, live, since, took, waiting = false, writing = false, forecast, notes }: { blocks: readonly Block[]; live: boolean; since?: number; took: number; waiting?: boolean; writing?: boolean; forecast?: string; /** What it said along the way, shown when the line is opened. */ notes?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState<string | null>(null);
  const body = useId();
  const steps = blocks.flatMap((b) => (b.kind === "work" && "steps" in b ? b.steps : []));
  const thinks = blocks.filter((b): b is Extract<Block, { kind: "think" }> => b.kind === "think" && "thought" in b);
  const thoughtSecs = thinks.reduce((n, t) => n + t.secs, 0);
  const running = steps.findLast((s) => s.state === "running");
  const failed = steps.filter((s) => s.state === "failed").length;

  // The line: while it works, the step under way; done, the whole run in a sentence.
  const word = waiting ? "Waiting for an answer" : running ? doingOf(running) : writing ? "Writing the answer" : blocks.at(-1)?.kind === "think" || !steps.length ? "Thinking" : "Working";
  const summary = stepsSummary(steps, thoughtSecs);
  const doneLine = [took >= 1000 ? `Worked ${tookFor(took)}` : "", took >= 1000 ? summary.charAt(0).toLowerCase() + summary.slice(1) : summary].filter(Boolean).join(" · ");
  // A tick per step, the newest last; a long run keeps its last 24.
  const ticks = steps.slice(-24);

  // Opened: the steps by kind, in the order each kind first came up, and the thinking first when there was some.
  const groups: { key: string; label: string; steps: Step[] }[] = [];
  for (const s of steps) {
    const g = groupOf(s);
    const at = groups.find((x) => x.key === g.key);
    if (at) at.steps.push(s);
    else groups.push({ ...g, steps: [s] });
  }
  const what = (g: { steps: Step[] }) => clip([...new Set(g.steps.map((s) => s.target).filter((t): t is string => !!t))].join(", "), 90);
  const side = (g: { key: string; steps: Step[] }) => {
    const bad = g.steps.filter((s) => s.state === "failed").length;
    const n = g.steps.length;
    if (bad) return { text: `${bad} failed`, tone: "bad" };
    if (g.steps.some((s) => s.state === "running")) return { text: "now", tone: "live" };
    return { text: g.key === "read" || g.key === "edit" ? `${new Set(g.steps.map((s) => s.target)).size} file${new Set(g.steps.map((s) => s.target)).size === 1 ? "" : "s"}` : `${n}×`, tone: "" };
  };

  return (
    <div className={`rl${live ? " live" : ""}${failed && !live ? " has-fail" : ""}`}>
      <button type="button" className="rl-head" aria-expanded={open} aria-controls={body} onClick={() => setOpen((o) => !o)}>
        {/* The same nine-cell grid as the reply's "Thinking" line, so working reads as the same thing moving on. */}
        {live && !waiting && <Orb variant="S3" size={14} label={word} />}
        <span className="rl-text">
          {live ? (
            // Keyed by the step, so each new one slides in over the last.
            <Shine key={running?.id ?? word} on={!waiting} className={`rl-now${waiting ? " needs" : ""}`}>
              {word}
            </Shine>
          ) : (
            <span className="rl-done">
              {doneLine}
              {failed > 0 && !/failed/.test(doneLine) && <span className="rl-fail"> · {failed} failed</span>}
            </span>
          )}
        </span>
        {ticks.length > 1 && (
          <span className="rl-ticks" aria-hidden="true">
            {ticks.map((s) => (
              <i key={s.id} className={s.state === "running" ? "now" : s.state === "failed" ? "bad" : s.state === "waiting" ? "skip" : "on"} />
            ))}
          </span>
        )}
        {live && since !== undefined && !waiting && <Clock since={since} />}
        {live && forecast && <span className="rl-clock">{forecast}</span>}
        <span className={`rsp-caret side ${open ? "open" : ""}`} aria-hidden />
      </button>
      {open && (
        <div id={body} className="rl-body">
          {thinks.length > 0 && (
            <div className="rl-group">
              <button type="button" className="rl-row" aria-expanded={group === "think"} onClick={() => setGroup(group === "think" ? null : "think")}>
                <span className="rl-label">Thought</span>
                <span className="rl-what">{clip(thinks.map((t) => t.thought).join(" "), 90)}</span>
                <span className="rl-side">{thoughtSecs ? tookFor(thoughtSecs * 1000) : ""}</span>
              </button>
              {group === "think" && <p className="rsp-tl-thought rl-thought">{thinks.map((t) => t.thought).join("\n\n")}</p>}
            </div>
          )}
          {groups.map((g) => {
            const s = side(g);
            return (
              <div key={g.key} className="rl-group">
                <button type="button" className="rl-row" aria-expanded={group === g.key} onClick={() => setGroup(group === g.key ? null : g.key)}>
                  <span className="rl-label">{g.label}</span>
                  <span className="rl-what">{what(g)}</span>
                  <span className={`rl-side${s.tone ? ` ${s.tone}` : ""}`}>{s.text}</span>
                </button>
                {group === g.key && <StepList steps={g.steps} />}
              </div>
            );
          })}
          {notes}
        </div>
      )}
    </div>
  );
}
