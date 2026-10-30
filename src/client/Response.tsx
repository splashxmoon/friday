import { stepKind } from "../run-strip.js";
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Orb } from "@/components/aicss/Orb";
import { currentTheme } from "./storage.js";
import { ENGINE_NAMES, type EngineTool, type ToolCall } from "../types.js";
import { Icon, type IconName } from "./icons.js";
import type { Look } from "./handoff-ui.js";
import { shortTokens } from "../tool-usage.js";
import { Shine } from "./shine.js";
import { stepsSummary } from "../step-summary.js";

/**
 * The pieces an agent's response is drawn with.
 *
 * Text and type, not icons: a response is something people read, and forty
 * little pictograms for forty tool calls made it look like a dashboard. Each
 * step is a verb and the thing it was done to, set the way a person would
 * write it down — "Read thread.tsx", "Ran pnpm vitest" — and the only
 * ornament is a single typographic mark in a fixed column, so the list reads
 * as a list.
 */

// ── working ────────────────────────────────────────────────────────────

/** The answer's live line in its header ("Working", "Thinking", "Waiting on you"): a nine-cell matrix and a label that shines while it waits. */
export function Working({ label }: { label: string }) {
  return (
    <span className="rsp-working" role="status">
      <Orb variant="S3" size={14} label={label} />
      <Shine>{label}</Shine>
    </span>
  );
}


// ── thinking ───────────────────────────────────────────────────────────

/**
 * What the model thought, folded into one line once it is done.
 *
 * While it streams, the newest sentences show in a short window that fades at
 * the top, so the reader sees it moving without the page jumping. Once the
 * answer starts it folds to "Thought for 4s", which opens back up on a click.
 */
export function Thinking({ text, live, seconds }: { text: string; live: boolean; seconds?: number }) {
  const [open, setOpen] = useState(false);
  const view = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (live && view.current) view.current.scrollTop = view.current.scrollHeight;
  }, [text, live]);
  const expanded = live || open;
  return (
    <div className={`rsp-think ${live ? "live" : ""}`}>
      <button type="button" className="rsp-think-head" aria-expanded={expanded} onClick={live ? undefined : () => setOpen(!open)} disabled={live}>
        {live ? (
          <Shine>Thinking…</Shine>
        ) : (
          <span className="rsp-think-label">
            <span className="rsp-think-verb">Thought</span>
            {seconds && seconds > 0 ? ` for ${seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`}` : ""}
          </span>
        )}
        {!live && <span className="rsp-caret" aria-hidden />}
      </button>
      <div className={`rsp-fold ${expanded ? "open" : ""}`}>
        <div className="rsp-fold-inner">
          <div ref={view} className={`rsp-think-body ${live ? "tail" : ""}`}>
            {text}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── the timeline ───────────────────────────────────────────────────────

export type StepState = "done" | "running" | "failed" | "waiting";

export interface Step {
  id: string;
  /** A single typographic mark for the kind of step. */
  mark: string;
  verb: string;
  /** What it was done to: a file, a command, a query. Shown as code. */
  target?: string;
  state: StepState;
  /** Opened by clicking the step: the command's output, the search results. */
  detail?: ReactNode;
  /** What the team raised at this step, and the way to raise something: drawn under the row. */
  raise?: ReactNode;
  /** Tests this step's command reported as failing, by name. */
  fails?: string[];
  /** The first lines an edit took out and put in, so the change is visible without opening anything. */
  preview?: { old: string[]; new: string[] };
  /** What the agent was thinking when it took this step, and a way to ask it to explain. */
  thought?: string;
  onAsk?: () => void;
}

const base = (p: string) => p.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? p;
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};

/** A tool call as a sentence: the verb, and what it touched. */
export function stepFor(call: ToolCall, args: Record<string, unknown>, askedName?: string): Pick<Step, "mark" | "verb" | "target"> {
  const s = (...keys: string[]) => {
    for (const k of keys) if (typeof args[k] === "string" && (args[k] as string).trim()) return (args[k] as string).trim();
    return "";
  };
  switch (call.name) {
    case "read":
    case "read_file":
      return { mark: "≡", verb: "Read", target: base(s("path", "file_path")) };
    case "list_files":
    case "tree":
      return { mark: "≡", verb: "Listed", target: s("path") || "the folder" };
    case "search":
    case "search_code":
      return { mark: "⌕", verb: "Searched", target: s("query", "pattern") };
    case "shell":
    case "run_command":
      return { mark: "›_", verb: "Ran", target: s("command") };
    case "edit":
    case "edit_file":
      return { mark: "±", verb: "Edited", target: base(s("path", "file_path")) };
    case "write":
    case "write_file":
      return { mark: "+", verb: "Wrote", target: base(s("path", "file_path")) };
    case "web_search":
      return { mark: "⌕", verb: "Searched the web", target: s("query") };
    case "fetch_url":
    case "web_fetch":
      return { mark: "↗", verb: "Opened", target: hostOf(s("url")) };
    case "remember":
      return { mark: "✎", verb: "Noted", target: s("note", "text") };
    case "update_plan":
    case "todo":
      return { mark: "☐", verb: "Planned" };
    case "ask_human":
      return { mark: "?", verb: `Asked ${askedName ?? "the driver"}`, target: s("question") };
    case "hand_off":
      return { mark: "→", verb: "Handed off to", target: s("to") };
    case "use_skill":
      return { mark: "◇", verb: "Used", target: s("name", "skill") };
    default: {
      if (call.name.startsWith("mcp__")) {
        const [, server, tool] = call.name.split("__");
        return { mark: "⇄", verb: `${server}`, target: tool };
      }
      const first = Object.values(args).find((v) => typeof v === "string") as string | undefined;
      return { mark: "·", verb: call.name.replace(/_/g, " "), target: first };
    }
  }
}

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
}

/** A verb and its target per line; a step with output opens on a click. */
/**
 * The shape of the run in one strip: a mark per step, coloured by kind, red where it failed. Hover says what it was;
 * a click opens the log at that step. Long runs read at a glance where forty rows would not.
 */
function RunStrip({ steps, onPick }: { steps: Step[]; onPick: (id: string) => void }) {
  if (steps.length < 3) return null;
  return (
    // Its marks are small and close together, which is accepted: every step is also a full-size row in the run log below
    // (WCAG 2.5.8's "equivalent control" exception), so the UI check is told not to count them.
    <div className="rsp-strip" role="list" aria-label="The run, step by step" data-uicheck-ok="small-target">
      {steps.map((s) => (
        <button
          key={s.id}
          type="button"
          role="listitem"
          className={`rsp-strip-mark k-${stepKind(s)} ${s.state}`}
          title={`${s.verb}${s.target ? ` ${s.target}` : ""}${s.state === "failed" ? " · failed" : ""}`}
          aria-label={`${s.verb}${s.target ? ` ${s.target}` : ""}`}
          onClick={() => onPick(s.id)}
        />
      ))}
    </div>
  );
}

/** A step's mark, drawn: the text glyphs it is named by came out in four sizes from as many fallback fonts, the search one a
 * speck beside the edit one (Arun, 2026-10-28: "a look for like the little details and designs… for the whole app too"). */
const MARK_ICONS: Record<string, IconName> = { "≡": "file", "⌕": "search", "›_": "terminal", "±": "pencil", "+": "plus", "↗": "globe", "✎": "memory", "☐": "list", "?": "help", "→": "handoff", "◇": "skills", "⇄": "plug" };
function StepMark({ mark }: { mark: string }) {
  const icon = MARK_ICONS[mark];
  return (
    <span className="rsp-mark" aria-hidden>
      {icon ? <Icon name={icon} size={13} /> : mark}
    </span>
  );
}

function StepList({ steps, shown: picked, onShown }: { steps: Step[]; shown?: string | null; onShown?: (id: string | null) => void }) {
  const [own, setOwn] = useState<string | null>(null);
  const shown = picked !== undefined ? picked : own;
  const setShown = (id: string | null) => (onShown ? onShown(id) : setOwn(id));
  /** The step whose reasoning is open. */
  const [why, setWhy] = useState<string | null>(null);
  return (
    <ol className="rsp-steps">
      {steps.map((s) => (
        <li key={s.id} id={`step-${s.id}`} className={`rsp-step ${s.state}`}>
          <div className="rsp-step-line">
            <button type="button" className="rsp-step-row" disabled={!s.detail} aria-expanded={shown === s.id} onClick={() => setShown(shown === s.id ? null : s.id)}>
              <StepMark mark={s.mark} />
              <Shine on={s.state === "running"} className="rsp-verb">{s.state === "waiting" ? askedVerb(s.verb) : s.verb}</Shine>
              {s.target && <code className="rsp-chip">{clip(s.target, 72)}</code>}
              {s.state === "failed" && <span className="rsp-step-flag">failed</span>}
              {s.state === "waiting" && <span className="rsp-step-flag quiet" title="Asked for, but the turn ended before it ran: stopped, out of usage, or still waiting for a yes">didn't run</span>}
            </button>
            {(s.thought || s.onAsk) && (
              <button type="button" className="rsp-why" aria-expanded={why === s.id} title="Why did it do that?" onClick={() => setWhy(why === s.id ? null : s.id)}>
                Why?
              </button>
            )}
          </div>
          {/* The tests that failed, by name: the one thing worth reading about a failed test run. */}
          {s.fails && s.fails.length > 0 && (
            <ul className="rsp-step-fails">
              {s.fails.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
          {/* What an edit took out and put in, the first few lines, before the review card. */}
          {s.preview && (
            <pre className="rsp-step-diff">
              {s.preview.old.map((l, i) => (
                <span key={`o${i}`} className="del">{`- ${l}\n`}</span>
              ))}
              {s.preview.new.map((l, i) => (
                <span key={`n${i}`} className="add">{`+ ${l}\n`}</span>
              ))}
            </pre>
          )}
          {why === s.id && (
            <div className="rsp-step-why">
              {s.thought ? <p>{clip(s.thought, 600)}</p> : <p className="muted">No reasoning was recorded for this step.</p>}
              {s.onAsk && (
                <button type="button" className="rsp-text-btn" onClick={s.onAsk}>
                  Ask the agent to explain this step
                </button>
              )}
            </div>
          )}
          {s.detail && shown === s.id && <div className="rsp-step-detail">{s.detail}</div>}
          {s.raise}
        </li>
      ))}
    </ol>
  );
}

const span = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};

export interface WorkGroup {
  id: string;
  /** What the model reasoned before these steps. */
  thought: string;
  steps: Step[];
}

/**
 * All of a run's working-out, as one line.
 *
 * A long run is forty tool calls, and a row for every round of them turned the
 * response into a page of "Thought for 2s · 2 steps". What people want from it
 * is the same thing every chat app gives them: the answer in front, and one
 * quiet line that says how much work stood behind it and opens to show it.
 *
 * While it runs, that line says so and names what is happening now, so a long
 * run is never a blank spinner. Finished, it says how long it took and how much
 * it did. Opened, it is the whole run in order: what was thought, then what was
 * done about it, round after round.
 */
export function RunLog({
  groups,
  files,
  live,
  onFile,
  startedAt,
  endedAt,
  tokens,
}: {
  groups: WorkGroup[];
  files: FileChange[];
  live: boolean;
  onFile?: (path: string) => void;
  startedAt?: number;
  endedAt?: number;
  /** What the run used, as the agents reported it (run-budget.ts). */
  tokens?: number;
}) {
  const [open, setOpen] = useState(false);
  // The steps are drawn from the first time the log is opened, and kept for the fold to animate closed. A closed log was
  // drawing every step (and, while live, again every second for the clock) behind a fold nobody had opened.
  const opened = useRef(false);
  if (open) opened.current = true;
  // The step the strip asked for: opened in the log and scrolled into view.
  const [shown, setShown] = useState<string | null>(null);
  const pick = (id: string) => {
    setOpen(true);
    setShown(id);
    setTimeout(() => document.getElementById(`step-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 60);
  };
  // The clock only runs while there is something to time.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);

  const steps = groups.flatMap((g) => g.steps);
  const failed = steps.filter((s) => s.state === "failed").length;
  // A finished run under a second says no time at all: "Worked for 0s" read as nothing done (2026-10-27 design review).
  const took = startedAt ? (live ? now : (endedAt ?? now)) - startedAt : 0;
  const elapsed = startedAt && (live || took >= 1000) ? span(took) : "";
  const current = live ? steps.findLast((s) => s.state === "running") : undefined;
  const summary = live
    ? [`Working${elapsed ? ` · ${elapsed}` : ""}`, steps.length ? `${steps.length} step${steps.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")
    : [
        elapsed ? `Worked for ${elapsed}` : steps.length ? "Worked" : "Thought",
        steps.length ? `${steps.length} step${steps.length === 1 ? "" : "s"}` : "",
        files.length ? `${files.length} file${files.length === 1 ? "" : "s"} changed` : "",
        failed ? `${failed} failed` : "",
      ]
        .filter(Boolean)
        .join(" · ");

  return (
    <div className={`rsp-timeline rsp-runlog ${live ? "live" : ""}`}>
      <button type="button" className="rsp-tl-head" aria-expanded={open} data-tip={open ? "Hide the steps" : "Show every step"} onClick={() => setOpen(!open)}>
        <span className={`rsp-caret side ${open ? "open" : ""}`} aria-hidden />
        {/* What it cost, in a span of its own, so a session that doesn't count it can leave it out. */}
        <Shine on={live && !failed} className={failed ? "rsp-tl-summary has-fail" : "rsp-tl-summary"}>
          {summary}
          {tokens ? <span className="rsp-tokens"> · {shortTokens(tokens)} tokens</span> : null}
        </Shine>
        {live && current && (
          <span className="rsp-tl-now">
            <span>{current.verb}</span>
            {current.target && <code className="rsp-chip">{clip(current.target, 48)}</code>}
          </span>
        )}
      </button>
      <RunStrip steps={steps} onPick={pick} />
      <div className={`rsp-fold ${open ? "open" : ""}`}>
        <div className="rsp-fold-inner">
          {opened.current && groups.map((g) => (
            <div key={g.id} className="rsp-rl-group">
              {g.thought && <p className="rsp-tl-thought">{g.thought}</p>}
              {g.steps.length > 0 && <StepList steps={g.steps} shown={shown} onShown={setShown} />}
            </div>
          ))}
          {files.length > 0 && (
            <div className="rsp-files">
              {files.map((x) => (
                <button key={x.path} type="button" className="rsp-file" title={x.path} onClick={onFile ? () => onFile(x.path) : undefined}>
                  <span className="rsp-file-name">{base(x.path)}</span>
                  {x.additions > 0 && <span className="rsp-add">+{x.additions}</span>}
                  {x.deletions > 0 && <span className="rsp-del">−{x.deletions}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The run in one quiet line under the reply: how long, what it left changed, what it used. Not a fold: the steps are in
 * their places above (StepGroup). "N files changed" opens the changes; the files aren't listed here as well, where a run
 * of sixty filled the screen with chips that said less than the Diff panel does (Arun, 2026-10-18).
 */
export function RunMeta({ files, live, onFile, startedAt, endedAt, tokens, compacted, waiting = false }: { files: FileChange[]; live: boolean; onFile?: () => void; startedAt?: number; endedAt?: number; tokens?: number; /** The conversation's size before Friday had it compacted for this run. */ compacted?: number; /** Its turn waits on a person (a question, a permission): not working. */ waiting?: boolean }) {
  // The clock only runs while there is something to time.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  // A finished run under a second says no time at all: "Worked for 0s" read as nothing done (2026-10-27 design review).
  const took = startedAt ? (live ? now : (endedAt ?? now)) - startedAt : 0;
  const elapsed = startedAt && (live || took >= 1000) ? span(took) : "";
  // Waiting on a person says so: "Working · 32m" under a turn stopped on a question contradicted the bar's "Waiting for you"
  // (2026-10-27 audit).
  const time = live ? `${waiting ? "Waiting for an answer" : "Working"}${elapsed ? ` · ${elapsed}` : ""}` : elapsed ? `Worked for ${elapsed}` : "";
  const changed = files.length ? `${files.length} file${files.length === 1 ? "" : "s"} changed` : "";
  const used = tokens ? `${shortTokens(tokens)} tokens` : "";
  const trimmed = compacted ? `conversation compacted from ${shortTokens(compacted)}` : "";
  // A failure is said by its group and by the verdict under the reply; a third time here was one too many.
  if (!time && !changed && !used && !trimmed) return null;
  return (
    <div className="rsp-meta">
      <p className="rsp-meta-line">
        {[
          // The one live line: words with a faint shimmer, in the feed only (DIRECTION.md §7); waiting on a person, still.
          time && (live ? <Shine key="t" on={!waiting} className={`rsp-meta-live${waiting ? " needs" : ""}`}>{time}</Shine> : <span key="t">{time}</span>),
          changed && (onFile ? <button key="f" type="button" className="rsp-meta-link" onClick={onFile}>{changed}</button> : <span key="f">{changed}</span>),
          used && <span key="u" className="rsp-meta-tokens">{used}</span>,
          trimmed && <span key="c" title="Every step re-reads the conversation, so Friday had the tool summarise it first">{trimmed}</span>,
        ]
          .filter(Boolean)
          .flatMap((el, i) => (i ? [<span key={`s${i}`} aria-hidden> · </span>, el] : [el]))}
      </p>
    </div>
  );
}

/**
 * One stretch of the agent's work, in its place in the reply, the way Claude shows it: a line that says what was done
 * ("Ran 2 commands, read 3 files") with a chevron after it, opening to the reasoning and every step. A reply is its words
 * in order with these between them, rather than all the words first and one line for the whole run at the end
 * (Arun, 2026-10-17). While the agent is still in this stretch, the line shimmers and names the step under way.
 */
export function StepGroup({ steps, thought, thoughtSecs = 0, live }: { steps: Step[]; thought?: string; thoughtSecs?: number; live: boolean }) {
  const [open, setOpen] = useState(false);
  const foldId = useId();
  // Drawn from the first time it opens, and kept so the fold can animate closed; a closed group draws none of its steps.
  const opened = useRef(false);
  if (open) opened.current = true;
  const sentence = stepsSummary(steps, thoughtSecs);
  const current = live ? steps.findLast((s) => s.state === "running") : undefined;
  // With nothing done yet the running step is the summary itself, so it isn't said twice.
  const alone = steps.every((s) => s.state === "running" || s.state === "waiting");
  const failed = steps.some((s) => s.state === "failed");
  // A long stretch of work is counted, as Conductor does: "17 tool calls ›" (DIRECTION.md §9.6), with the sentence in its tip.
  // A short one keeps its sentence ("Read README.md, ran a command"), which says more than "2 tool calls".
  const done = steps.filter((s) => s.state !== "running" && s.state !== "waiting").length;
  const summary = !live && done >= 4 ? [`${done} tool calls`, ...sentence.split(" · ").slice(1)].join(" · ") : sentence;
  return (
    <div className={`rsp-group ${live ? "live" : ""}`}>
      <button type="button" className="rsp-group-head" aria-expanded={open} aria-controls={foldId} data-tip={open ? "Hide these steps" : summary === sentence ? "Show these steps" : sentence} onClick={() => setOpen(!open)}>
        {/* Only the failure in the state colour: the whole line in red read as the whole stretch having failed. */}
        <Shine on={live} className={failed && !live ? "rsp-group-text has-fail" : "rsp-group-text"}>
          {live ? summary : summary.split(" · ").map((part, i) => (
            <Fragment key={i}>
              {i ? " · " : ""}
              <span className={/^\d+ failed$/.test(part) ? "rsp-group-fail" : undefined}>{part}</span>
            </Fragment>
          ))}
        </Shine>
        {current && !alone && (
          <span className="rsp-tl-now">
            <span aria-hidden> · </span>
            <span>{current.verb}</span>
            {current.target && <code className="rsp-chip">{clip(current.target, 48)}</code>}
          </span>
        )}
        <span className={`rsp-caret side ${open ? "open" : ""}`} aria-hidden />
      </button>
      {/* Closed, the steps stay drawn for the fold to animate shut, but inert: nothing in them can be tabbed to or read out. */}
      <div id={foldId} className={`rsp-fold ${open ? "open" : ""}`} inert={!open}>
        <div className="rsp-fold-inner">
          {opened.current && (
            <>
              {thought && <p className="rsp-tl-thought">{thought}</p>}
              {steps.length > 0 && <StepList steps={steps} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The run's work as a list you can fold: "4 steps · 2 files changed", then a
 * verb and its target per line, then the files it left changed.
 */
export function Timeline({
  steps,
  files,
  live,
  onFile,
  thought,
  thoughtSecs,
}: {
  steps: Step[];
  files: FileChange[];
  live: boolean;
  onFile?: (path: string) => void;
  /** What the model reasoned before and between these steps, folded in with them: it explains the steps rather than standing beside them. */
  thought?: string;
  thoughtSecs?: number;
}) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const failed = steps.filter((s) => s.state === "failed").length;
  const summary = [
    thought ? (thoughtSecs && thoughtSecs > 0 ? `Thought for ${thoughtSecs < 60 ? `${thoughtSecs}s` : `${Math.round(thoughtSecs / 60)}m`}` : "Thought") : "",
    steps.length ? `${steps.length} step${steps.length === 1 ? "" : "s"}` : "",
    files.length ? `${files.length} file${files.length === 1 ? "" : "s"} changed` : "",
    failed ? `${failed} failed` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const current = live ? steps.findLast((s) => s.state === "running") : undefined;

  return (
    <div className="rsp-timeline">
      <button type="button" className="rsp-tl-head" aria-expanded={open} data-tip={open ? "Hide the steps" : "Show every step"} onClick={() => setOpen(!open)}>
        <span className={`rsp-caret side ${open ? "open" : ""}`} aria-hidden />
        <span className={failed ? "rsp-tl-summary has-fail" : "rsp-tl-summary"}>{summary}</span>
        {!open && current && (
          <span className="rsp-tl-now">
            <Shine>{current.verb}</Shine>
            {current.target && <code className="rsp-chip">{clip(current.target, 48)}</code>}
          </span>
        )}
      </button>
      <div className={`rsp-fold ${open ? "open" : ""}`}>
        <div className="rsp-fold-inner">
          {thought && <p className="rsp-tl-thought">{thought}</p>}
          <ol className="rsp-steps">
            {steps.map((s) => (
              <li key={s.id} className={`rsp-step ${s.state}`}>
                <button
                  type="button"
                  className="rsp-step-row"
                  disabled={!s.detail}
                  aria-expanded={shown === s.id}
                  onClick={() => setShown(shown === s.id ? null : s.id)}
                >
                  <StepMark mark={s.mark} />
                  <Shine on={s.state === "running"} className="rsp-verb">{s.state === "waiting" ? askedVerb(s.verb) : s.verb}</Shine>
                  {s.target && <code className="rsp-chip">{clip(s.target, 72)}</code>}
                  {s.state === "failed" && <span className="rsp-step-flag">failed</span>}
                  {s.state === "waiting" && <span className="rsp-step-flag quiet" title="Asked for, but the turn ended before it ran: stopped, out of usage, or still waiting for a yes">didn't run</span>}
                </button>
                {s.detail && shown === s.id && <div className="rsp-step-detail">{s.detail}</div>}
              </li>
            ))}
          </ol>
          {files.length > 0 && (
            <div className="rsp-files">
              {files.map((f) => (
                <button key={f.path} type="button" className="rsp-file" title={f.path} onClick={onFile ? () => onFile(f.path) : undefined}>
                  <span className="rsp-file-name">{base(f.path)}</span>
                  {f.additions > 0 && <span className="rsp-add">+{f.additions}</span>}
                  {f.deletions > 0 && <span className="rsp-del">−{f.deletions}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** "Ran" for a step that never ran would be a lie: "Asked to run git status · not run" says what happened. */
const BASE: Record<string, string> = { Ran: "run", Read: "read", Listed: "list", Searched: "search", "Searched the web": "search the web", Edited: "edit", Wrote: "write", Opened: "open", Noted: "note", Planned: "plan", Used: "use", "Handed off to": "hand off to" };
// A verb it has no plain form of is said as it is: the "didn't run" flag beside it says the rest, which "Not run: Bash … didn't
// run" said twice (2026-10-27 audit).
const askedVerb = (verb: string) => (BASE[verb] ? `Asked to ${BASE[verb]}` : verb);

const clip = (t: string, n: number) => {
  const one = t.replace(/\s+/g, " ");
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

// ── handoff ────────────────────────────────────────────────────────────

/** Control passing between agents, with the reason and what came along. */
/** One end of a handoff: the agent's name, in the face it wears everywhere else. */
export function AgentPill({ name, look, role }: { name: string; look?: Look; role: "from" | "to" }) {
  return (
    <span className={`rsp-ho-agent ${role}${look ? ` k-${look.kind}` : ""}`} style={look ? ({ "--tint": look.tint } as React.CSSProperties) : undefined} title={look?.label}>
      {look && <span className="rsp-ho-mark">{look.mark}</span>}
      {name}
    </span>
  );
}

export function HandoffCard({ from, to, reason, carried, by, task, fromLook, toLook }: { from: string; to: string; reason: string; carried: string[]; by?: string; task?: string; fromLook?: Look; toLook?: Look }) {
  return (
    <div className="rsp-handoff">
      <div className="rsp-ho-route">
        <AgentPill name={from} {...(fromLook ? { look: fromLook } : {})} role="from" />
        <span className="rsp-ho-arrow" aria-label="to">
          →
        </span>
        <AgentPill name={to} {...(toLook ? { look: toLook } : {})} role="to" />
        {by && <span className="rsp-ho-by">sent by {by}</span>}
      </div>
      <p className="rsp-ho-reason">{reason}</p>
      {carried.length > 0 && (
        <div className="rsp-ho-carried">
          <div className="rsp-ho-label">carried over</div>
          <ul>
            {carried.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {task && (
        <div className="rsp-ho-task">
          <div className="rsp-ho-label">the task</div>
          <p>{task}</p>
        </div>
      )}
    </div>
  );
}

/** Somewhere work can be handed to: another agent in this session. */
export interface HandoffTarget {
  id: string;
  name: string;
  /** Its mark: an engine's logo, or the agent's own icon. */
  mark?: ReactNode;
  /** One short line of state, "working" or whoever is driving it. */
  meta?: string;
  busy?: boolean;
  /** Its colour, so a kind of agent is recognised before its name is read. */
  tint?: string;
  /** The one the run's own results point to, with the reason in a few words. */
  suggested?: boolean;
  why?: string;
  /** It wakes by itself when this lane finishes, so handing to it is already happening. */
  auto?: boolean;
}

/** Agents and tools that are not in the session yet, and can be brought in to take the work. */
export interface HandoffMore {
  agents: { id: string; name: string; icon: IconName; blurb: string; tint: string }[];
  /** `suggested`: the one routing would take the work to (routing.ts), with why, when this tool is out of usage or nearly. */
  tools: { tool: EngineTool; here: boolean; hint: string; mark: ReactNode; tint: string; suggested?: boolean; why?: string; /** Out of usage: listed last, and not pressable. */ out?: boolean }[];
  onAgent: (id: string) => void;
  onTool: (tool: EngineTool) => void;
}

/**
 * The way to pass work on, always in view under a finished run.
 *
 * A row of the agents you can give it to, the best fit for what the run left first and marked as such, pressing one
 * is the whole decision. Beyond the ones already here, "More" brings in a saved agent or a coding agent of your
 * own (Claude Code, Codex, Cursor) and hands the work to it as soon as it is in.
 */
export function HandoffBar({ targets, active, onPick, more, label = "Pass on" }: { targets: HandoffTarget[]; active: string | null; onPick: (id: string | null) => void; more?: HandoffMore; /** Its words, where a session says it its own way. */ label?: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  // Fixed to the window, placed from the button: the feed clips anything that hangs out of it.
  const [pos, setPos] = useState<React.CSSProperties>({});
  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const below = window.innerHeight - r.bottom, above = r.top;
    const down = below >= 260 || below >= above;
    setPos({ position: "fixed", left: Math.max(8, Math.min(r.left, window.innerWidth - 328)), maxHeight: Math.max(160, Math.min(360, (down ? below : above) - 16)), ...(down ? { top: r.bottom + 6, bottom: "auto" } : { bottom: window.innerHeight - r.top + 6, top: "auto" }) });
    setOpen((v) => !v);
  };
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    // The arrows move through its rows, as a menu's do, from the button into the list and round (2026-10-27 audit: ArrowDown
    // did nothing); Escape gives the focus back to the button.
    const esc = (e: KeyboardEvent) => {
      // Tab closes it and gives the focus back to its button, as the app's other menus do: it walked on past the open menu.
      if (e.key === "Escape" || (e.key === "Tab" && wrap.current?.querySelector(".ho-menu")?.contains(document.activeElement))) {
        if (e.key === "Tab") e.preventDefault();
        setOpen(false);
        wrap.current?.querySelector<HTMLElement>(".ho-btn")?.focus();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
      if (!wrap.current?.contains(document.activeElement)) return;
      const rows = [...(wrap.current.querySelectorAll<HTMLButtonElement>(".ho-menu-row:not([disabled])") ?? [])];
      if (!rows.length) return;
      e.preventDefault();
      const at = rows.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : at === -1 ? (e.key === "ArrowDown" ? 0 : rows.length - 1) : (at + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
      rows[next]!.focus();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    // Opened, the focus goes into it, on the agent already chosen or else the first: from the keyboard the arrows then work
    // at once, and a screen reader is in the menu that just opened (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION").
    const t = setTimeout(() => {
      const menu = wrap.current?.querySelector(".ho-menu");
      (menu?.querySelector<HTMLElement>(".ho-menu-row.on:not([disabled])") ?? menu?.querySelector<HTMLElement>(".ho-menu-row:not([disabled])"))?.focus();
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const sel = targets.find((t) => t.id === active);
  const suggested = targets.find((t) => t.suggested) ?? more?.tools.find((t) => t.suggested);
  const row = (key: string, tint: string | undefined, mark: React.ReactNode, name: string, sub: string | undefined, right: React.ReactNode, on: boolean, pick: () => void, off = false) => (
    <button key={key} type="button" role="menuitem" disabled={off} aria-disabled={off || undefined} className={`ho-menu-row${on ? " on" : ""}`} style={tint ? ({ "--tint": tint } as React.CSSProperties) : undefined} onClick={() => { setOpen(false); pick(); }}>
      <span className="ho-chip-mark">{mark}</span>
      <span className="ho-menu-text">
        <b>{name}</b>
        {sub && <small>{sub}</small>}
      </span>
      {right}
    </button>
  );
  return (
    <div className="ho-bar" role="group" aria-label="Hand this work to another agent" ref={wrap}>
      <button type="button" className={`ho-btn${open || sel ? " on" : ""}`} aria-haspopup="menu" aria-expanded={open} data-tip="Give this work to another agent" onClick={toggle}>
        <Icon name="handoff" size={14} />
        {sel ? <>{label === "Pass on" ? "Pass on to" : "Hand to"} <b>{sel.name}</b></> : label}
        {!sel && suggested && <span className="ho-dot" title={`Suggested: ${"name" in suggested ? suggested.name : ENGINE_NAMES[suggested.tool]}`} />}
        <Icon name="chevronDown" size={12} />
      </button>
      {sel && (
        <button type="button" className="ho-clear" onClick={() => onPick(null)} aria-label="Cancel the handoff" data-tip="Keep it with this agent">
          Cancel
        </button>
      )}
      {open && (
        <div className="ho-menu" role="menu" style={pos}>
          {targets.length > 0 && <div className="ho-menu-h">In this session</div>}
          {targets.map((t) =>
            row(t.id, t.tint, t.mark, t.name, t.suggested && t.why ? t.why : t.auto ? "Wakes by itself when this finishes" : undefined,
              <>
                {t.suggested && <span className="ho-chip-tag">Suggested</span>}
                {t.meta && <span className={`ho-chip-meta${t.busy ? " busy" : ""}`}>{t.meta}</span>}
              </>,
              active === t.id, () => onPick(active === t.id ? null : t.id)),
          )}
          {more && more.tools.length > 0 && <div className="ho-menu-h">Start another agent</div>}
          {[...(more?.tools ?? [])]
            .sort((a, b) => Number(!!a.out) - Number(!!b.out) || Number(!!b.suggested) - Number(!!a.suggested))
            .map((t) =>
              row(t.tool, t.tint, t.mark, ENGINE_NAMES[t.tool], t.suggested && t.why ? t.why : t.hint,
                t.suggested ? <span className="ho-chip-tag">Suggested</span> : t.here ? <span className="ho-chip-meta">here</span> : null,
                false, () => more!.onTool(t.tool), !!t.out),
            )}
          {more && more.agents.length > 0 && <div className="ho-menu-h">Saved agents</div>}
          {more?.agents.map((a) => row(a.id, a.tint, <Icon name={a.icon} size={14} />, a.name, a.blurb, null, false, () => more.onAgent(a.id)))}
        </div>
      )}
    </div>
  );
}

/**
 * What happens once an agent is picked: a short sheet, already filled in.
 *
 * Nothing here has to be typed. Why it moved is written for you, and what goes along is the run's own answer
 * and the files it changed, each one a line you can untick. The one optional thing is a note to the agent
 * taking over, which becomes its task. Enter in the note sends it.
 */
export function HandoffComposer({
  from,
  to,
  carried,
  reason,
  onSend,
  onCancel,
  fromLook,
  toLook,
}: {
  from: string;
  to: { id: string; name: string };
  fromLook?: Look;
  toLook?: Look;
  carried: string[];
  /** Written for the person, from what the run did. Shown, not asked for. */
  reason: string;
  onSend: (to: string, reason: string, carried: string[], task: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [note, setNote] = useState("");
  const [off, setOff] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await onSend(
      to.id,
      reason,
      carried.filter((_, i) => !off.has(i)),
      note.trim() || `Pick up from ${from}'s work and carry on.`,
    );
    setBusy(false);
    if (ok) onCancel();
  };
  return (
    <form
      className="ho-sheet"
      onSubmit={(e) => {
        e.preventDefault();
        void go();
      }}
    >
      <div className="ho-sheet-route">
        <AgentPill name={from} {...(fromLook ? { look: fromLook } : {})} role="from" />
        <span className="rsp-ho-arrow" aria-label="hands off to">
          →
        </span>
        <AgentPill name={to.name} {...(toLook ? { look: toLook } : {})} role="to" />
      </div>
      <p className="ho-sheet-why">{reason}</p>
      <textarea
        className="rsp-ho-input"
        rows={2}
        autoFocus
        placeholder={`A note for ${to.name} (optional)`}
        aria-label={`A note for ${to.name}`}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
            e.preventDefault();
            void go();
          }
        }}
      />
      {carried.length > 0 && (
        <fieldset className="ho-carry">
          <legend className="rsp-ho-label">goes with it</legend>
          {carried.map((c, i) => (
            <label key={i} className="ho-carry-row">
              <input
                type="checkbox"
                checked={!off.has(i)}
                onChange={() =>
                  setOff((cur) => {
                    const next = new Set(cur);
                    if (next.has(i)) next.delete(i);
                    else next.add(i);
                    return next;
                  })
                }
              />
              <span>{c}</span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="rsp-ho-actions">
        <button type="button" className="rsp-text-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="ho-send" disabled={busy}>
          {busy ? "Handing off…" : `Hand off to ${to.name}`}
          {!busy && <Icon name="chevronRight" size={13} />}
        </button>
      </div>
    </form>
  );
}
