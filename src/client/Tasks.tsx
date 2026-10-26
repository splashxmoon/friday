import { useEffect, useState } from "react";
import { doingNow } from "../activity-line.js";
import { MAIN_LANE, type AgentTaskStatus, type Member, type SessionEvent } from "../types.js";
import { driverOf, runOf, type SessionState } from "../session/projection.js";
import type { PreviewInfo } from "../runner/preview.js";
import type { BackgroundTask } from "./Preview.js";
import { Icon, type IconName } from "./icons.js";
import { TaskMark } from "./TaskMark.js";
import { openInPreview } from "./previewBus.js";
import { commandsIn } from "./Terminal.js";
import { relTime } from "./ui.js";
import type { Send } from "./useSession.js";

/**
 * What is running here, and what has finished.
 *
 * A session runs more than one thing: the main lane somebody is steering, and
 * any standing lanes that wake on their own. The panel used to open on a
 * summary of the folder — which is a fact you check once and then never
 * again — while the question people actually come back to the workbench with
 * is "is it still going, and did the other one finish?".
 *
 * Finished tasks can be cleared. Only from this list: the run is in the log,
 * which is the record, and this is the tray — clearing it is putting away
 * something you have read, not deleting what happened.
 */

const STATE: Record<string, { label: string; icon: IconName; tone: string }> = {
  running: { label: "Running", icon: "play", tone: "go" },
  paused: { label: "Paused", icon: "pause", tone: "hold" },
  waiting: { label: "Waiting on an answer", icon: "help", tone: "hold" },
  error: { label: "Stopped with an error", icon: "x", tone: "bad" },
  done: { label: "Finished", icon: "check", tone: "ok" },
  stopped: { label: "Stopped", icon: "pause", tone: "hold" },
  ready: { label: "Stopped · ready for more", icon: "check", tone: "ok" },
  idle: { label: "Not started", icon: "pause", tone: "" },
};

const DONE = new Set(["done", "error", "stopped", "ready", "idle"]);

/** A subagent a coding tool started, where it stands now: the latest `agent.task` for it, with its first's description. */
export interface SubTask {
  key: string;
  /** The tool's own id for it (Claude Code's task id; Cursor's and Codex's call id). */
  id: string;
  lane: string;
  by: string;
  description: string;
  agentType?: string;
  background?: boolean;
  status: AgentTaskStatus;
  summary?: string;
  start: number;
  end?: number;
  /** Where in the log it started, so the feed can put it in the run that started it. */
  seq: number;
  /**
   * Seen starting: first reported running, or with what it was asked to do. A coding tool beginning a turn reports on what was left over from its last
   * session, already over ("Background shell command didn't finish before the previous session ended"): those were taken for
   * subagents this run sent off, and a card of them came with every new prompt (Arun, 2026-10-24).
   */
  opened: boolean;
}

export function subTasksIn(events: SessionEvent[]): SubTask[] {
  const all = new Map<string, SubTask>();
  for (const e of events) {
    if (e.body.type !== "agent.task") continue;
    const b = e.body;
    const lane = e.lane ?? MAIN_LANE;
    const key = `${lane}:${b.id}`;
    const had = all.get(key);
    all.set(key, {
      key,
      id: b.id,
      lane,
      by: had?.by ?? e.actor.name,
      description: had?.description || b.description || (b.agentType === "command" ? "Background command" : "Subagent"),
      ...((had?.agentType ?? b.agentType) ? { agentType: had?.agentType ?? b.agentType } : {}),
      ...((had?.background ?? b.background) !== undefined ? { background: had?.background ?? b.background } : {}),
      status: b.status,
      ...((b.summary ?? had?.summary) ? { summary: b.summary ?? had?.summary } : {}),
      start: had?.start ?? e.ts,
      seq: had?.seq ?? e.seq,
      // Or said what it was asked to do: a Codex agent that finished between two calls is first reported already over, with its
      // task; a leftover report has none.
      opened: had?.opened ?? (b.status === "running" || !!b.description),
      ...(b.status !== "running" ? { end: e.ts } : {}),
    });
  }
  return [...all.values()];
}

/** One line in the tray, whoever or whatever is doing it. */
interface Item {
  id: string;
  name: string;
  /** What it is doing and when, under the name. */
  sub: string;
  status: string;
  /** Commands are typed, so they are shown as typed. */
  mono?: boolean;
  standing?: boolean;
  /** Where to go to see it, when there is somewhere. */
  open?: () => void;
  /** Stop it, when it is running and this person may. */
  stop?: () => void;
  /** The text a copy button puts on the clipboard. */
  copy?: string;
  /** Why it failed, in its own last words: the line under a failed command, so it can be read without opening it. */
  why?: string;
  /** What it has printed, shown under it for a process that keeps printing. */
  log?: string[];
  /** What a finished command printed: opens under its card when pressed. */
  output?: string;
  /** An address it is serving, as something to press. */
  link?: { label: string; open: () => void };
  /** Whether it is up, for a process that has a before and an after. */
  up?: boolean;
  /** What an agent is doing this second, when it is mid-run. */
  doing?: string;
  /** Steps it has taken in this run. */
  steps?: number;
}

/** An address as a person says it: localhost, not the loopback form a machine answered on. */
export function plainAddress(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname === "[::1]" || u.hostname === "::1" || u.hostname === "127.0.0.1" ? "localhost" : u.hostname;
    return `${host}${u.port ? `:${u.port}` : ""}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

/** "4s", "2m 14s", "1h 05m": how long something took, in the two units that matter at its size. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** What a lane is doing this second, as the card's extra line. */
function doingOf(events: SessionEvent[], lane: string): { doing?: string; steps?: number } {
  const d = doingNow(events, lane);
  return d ? { doing: d.text, steps: d.steps } : {};
}

/** When a lane's latest run began, and when it ended if it has. */
function spanOf(events: SessionEvent[], lane: string): { start: number; end?: number; stopped?: boolean } | null {
  let i = events.length - 1;
  while (i >= 0 && !(events[i]!.body.type === "run.started" && (events[i]!.lane ?? MAIN_LANE) === lane)) i--;
  if (i < 0) return null;
  // A Stop ends the run as much as its end does: the agent is ready again, not "Not started".
  const end = events.slice(i + 1).find((e) => (e.body.type === "run.ended" || e.body.type === "run.pause" || e.body.type === "run.cancel") && (e.lane ?? MAIN_LANE) === lane);
  return { start: events[i]!.ts, ...(end ? { end: end.ts, ...(end.body.type !== "run.ended" ? { stopped: true } : {}) } : {}) };
}

/**
 * A command as read in the project: the folder's own path taken out of it. `cat "C:/Users/Ada/edge enterprise/ml/tune.py"`
 * filled the row with a path everyone in the session already knows; it reads `cat ml/tune.py`. The copy keeps it whole.
 */
export function inFolder(command: string, folders: string[]): string {
  let out = command;
  for (const f of folders) {
    for (const root of new Set([f, f.replace(/\\/g, "/"), f.replace(/\//g, "\\")])) {
      if (root.length < 4) continue;
      out = out.split(`"${root}/`).join(`"`).split(`"${root}\\`).join(`"`).split(`'${root}/`).join(`'`).split(`${root}/`).join("").split(`${root}\\`).join("");
    }
  }
  // A path left in quotes with nothing that needs them, unquoted: "ml/tune.py" reads ml/tune.py.
  return out.replace(/"([\w./\\-]+)"/g, "$1");
}

/** The last meaningful line a failed command printed: usually the error itself, said where the row is read. */
export function lastWords(output: string): string {
  const lines = output
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^[-=~^_*\s]+$/.test(l) && !/^at\s/.test(l) && !/^(\+\s*)?(CategoryInfo|FullyQualifiedErrorId)\b/.test(l));
  const line = lines.at(-1) ?? "";
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

export function TasksPanel({
  state,
  events,
  onTab,
  me,
  send,
  onOpenCommand,
  preview,
  onStopPreview,
  background = [],
  onStopBackground,
}: {
  state: SessionState;
  events: SessionEvent[];
  onTab: (t: "tree" | "files" | "terminal" | "preview") => void;
  me?: Member;
  send?: Send;
  /** Show one command, and what it printed, in the Terminal. */
  onOpenCommand?: (id: string) => void;
  /** The dev server running for this session's folder, if there is one. */
  preview?: PreviewInfo | null;
  /** Stop it. */
  onStopPreview?: () => void;
  /** What the agent left running on the machine, and the way to stop one. */
  background?: BackgroundTask[];
  onStopBackground?: (id: string) => void;
}) {
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState("");
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const flip = (id: string) => setOpened((o) => (o.has(id) ? new Set([...o].filter((x) => x !== id)) : new Set([...o, id])));
  // The clock only runs while something is being timed: a panel that re-renders
  // every second with nothing going on is a battery cost for no reason.
  const [now, setNow] = useState(() => Date.now());
  const anyRunning = Object.values(state.laneRuns).some((r) => r.status === "running") || state.run.status === "running" || background.some((b) => b.running);
  useEffect(() => {
    if (!anyRunning) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyRunning]);
  const mayStop = (lane: string) => !!me && !!send && (me.role === "owner" || driverOf(state, lane)?.id === me.id);

  // When each run last changed, taken from the event it started at — the same
  // clock the feed uses, so the two never disagree by a few seconds.
  const tsOf = (seq: number) => events.find((e) => e.seq === seq)?.ts ?? 0;
  /**
   * "2m ago", but "now" rather than "now ago".
   *
   * relTime says "now" for anything under a minute, which is a word that
   * already means the same as the suffix — and a tray is mostly full of
   * things that happened seconds ago, so it was on screen most of the time.
   */
  const ago = (ts: number) => {
    if (!ts) return "";
    const rel = relTime(ts);
    return ` · ${rel === "now" ? "just now" : `${rel} ago`}`;
  };

  /**
   * Lanes and commands, as one kind of thing.
   *
   * They were two lists with two shapes, which made them look like two
   * subjects — but "is the build still going?" and "is the agent still
   * going?" are the same question, and a tray that answers it twice in two
   * voices is a tray you read twice.
   */
  const lanes: Item[] = [
    { id: MAIN_LANE, name: state.title || "This session", run: runOf(state, MAIN_LANE), standing: false },
    ...state.lanes.filter((l) => l.id !== MAIN_LANE).map((l) => ({ id: l.id, name: l.name, run: runOf(state, l.id), standing: l.trigger.kind !== "manual" })),
  ].map((t) => {
    const span = spanOf(events, t.id);
    // The projection has no "finished": a run that ended goes back to idle. A lane
    // with an ended run is Finished, and only one that never ran is Not started.
    const status = t.run.status === "waiting_for_human" ? "waiting" : t.run.status === "idle" && span?.end ? (span.stopped ? "ready" : "done") : t.run.status;
    const look = STATE[status] ?? STATE.idle!;
    // Running: how long so far. Done: how long it took. Both from the log.
    const took = span ? (status === "running" ? ` · ${duration(now - span.start)}` : span.end ? ` · took ${duration(span.end - span.start)}` : "") : "";
    return {
      id: t.id,
      name: t.name,
      status,
      standing: t.standing,
      // Running, its time alone: the spinner and the group it sits in already say it is running.
      sub: status === "running" ? (took ? took.slice(3) : look.label) : `${look.label}${ago(tsOf(t.run.sinceSeq))}${took}`,
      // Its error on a line of its own, its first sentence: the whole paragraph filled the row.
      ...(t.run.error ? { why: t.run.error.split(/(?<=[.!?])\s/)[0]! } : {}),
      ...(status === "running" ? doingOf(events, t.id) : {}),
      ...(t.run.status === "running" && mayStop(t.id) ? { stop: () => void send!({ type: "run.cancel", ...(t.id !== MAIN_LANE ? { lane: t.id } : {}) }) } : {}),
    };
  });

  // Newest first, and only a handful: this is a tray, and the terminal itself
  // holds the whole history.
  // The folders the agents here work in, to read commands relative to (inFolder).
  const folders = Object.values(state.engines).map((e) => e.cwd).filter(Boolean);
  // A command as the row shows it: without the `cd <folder> &&` an agent puts in front, which filled the line with a path.
  // Copying it still gives the whole thing.
  const asTyped = (command: string) => inFolder(command.replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/, ""), folders);
  const commands: Item[] = commandsIn(events)
    .slice(-6)
    .reverse()
    .map((c) => ({
      id: c.id,
      name: asTyped(c.command),
      mono: true,
      ...(c.isError && c.output ? { why: lastWords(c.output) } : {}),
      // No output yet is a command still running: the result lands as its own
      // event when it ends.
      status: c.output === undefined ? "running" : c.isError ? "error" : "done",
      sub: `${c.by}${ago(c.ts)}${c.output === undefined ? ` · ${duration(now - c.ts)}` : c.endTs && c.endTs - c.ts >= 1000 ? ` · took ${duration(c.endTs - c.ts)}` : ""}`,
      copy: c.command,
      // What it printed opens under the card; there is nowhere else to go to read it.
      ...(c.output !== undefined ? { output: c.output.trim() ? c.output.slice(-20_000) : "(no output)" } : {}),
    }));

  // The site the agent is serving, with the output of its server. It was a
  // block of text in the Preview panel, over the page it was about to show.
  const dev: Item[] = preview
    ? [
        {
          id: "dev-server",
          name: preview.command,
          mono: true,
          status: "running",
          sub: preview.ready ? "Dev server · serving" : preview.stage === "installing" ? "Dev server · installing dependencies…" : "Dev server · starting…",
          up: preview.ready,
          ...(preview.ready ? { link: { label: plainAddress(preview.url), open: () => (openInPreview(preview.url, state.id), onTab("preview")) } } : {}),
          copy: preview.command,
          open: () => onTab("preview"),
          log: preview.log,
          ...(onStopPreview ? { stop: onStopPreview } : {}),
        },
      ]
    : [];

  // Left running by the agent: a watcher, a worker. Each says how long it has been going, and keeps what it last printed under it.
  const bg: Item[] = background.map((b) => ({
    id: `bg-${b.id}`,
    name: b.command,
    mono: true,
    status: b.running ? "running" : b.stopped || b.exitCode === 0 ? "done" : "error",
    sub: b.running ? `In the background · ${duration(now - b.startedAt)}` : b.stopped ? `Stopped${b.endedAt ? ` · ran ${duration(b.endedAt - b.startedAt)}` : ""}` : `Exited ${b.exitCode ?? "early"}${b.endedAt ? ` · ran ${duration(b.endedAt - b.startedAt)}` : ""}`,
    copy: b.command,
    log: b.log,
    ...(b.running && onStopBackground ? { stop: () => onStopBackground(b.id) } : {}),
  }));
  // What the coding tools started: Claude Code's subagents and background commands, Codex's agents, Cursor's subagents. One
  // still "running" whose lane's run has ended was ended with it (the tool stopped, its machine went away).
  const subs: Item[] = subTasksIn(events)
    .filter((t) => t.opened)
    .slice(-12)
    .reverse()
    .map((t) => {
      const status = t.status === "running" && runOf(state, t.lane).status !== "running" ? "stopped" : t.status;
      const look = STATE[status] ?? STATE.idle!;
      const kind = t.agentType === "command" ? "Background command" : t.background ? "Background subagent" : "Subagent";
      const type = t.agentType && t.agentType !== "command" ? ` · ${t.agentType}` : "";
      const took = status === "running" ? ` · ${duration(now - t.start)}` : t.end ? ` · took ${duration(t.end - t.start)}` : "";
      const command = t.agentType === "command";
      return {
        id: `sub-${t.key}`,
        // A command reads as typed, in one line, without the folder it runs in.
        name: command ? asTyped(t.description) : t.description,
        ...(command ? { mono: true, copy: t.description } : {}),
        status,
        sub: `${kind} of ${t.by}${type}${status === "running" ? "" : ` · ${look.label}`}${took}`,
        ...(t.summary ? { output: t.summary } : {}),
      };
    });
  const items = [...dev, ...bg, ...lanes, ...subs, ...commands].filter((i) => !cleared.has(i.id));
  const failed = items.filter((i) => i.status === "error").length;
  const running = items.filter((i) => !DONE.has(i.status));
  const finished = items.filter((i) => DONE.has(i.status));

  const card = (i: Item) => {
    const look = STATE[i.status] ?? STATE.idle!;
    const body = (
      <>
        {/* Marked as the task board marks a task (TaskMark); a failure is its red stop, not an ×, which read as a second clear button. */}
        <span className="task-mark">
          <TaskMark state={i.status === "running" ? "working" : i.status === "error" ? "blocked" : i.status === "done" || i.status === "ready" ? "done" : "open"} />
        </span>
        <div className="task-body">
          <div className={`task-name ${i.mono ? "mono" : ""}`}>
            <span className="task-title" title={i.name}>{i.name}</span>
            {i.standing && <span className="chip-mini">standing</span>}
          </div>
          {i.doing && (
            <div className="task-doing" title={i.doing}>
              {i.doing}
              {i.steps ? <span className="task-steps"> · step {i.steps}</span> : null}
            </div>
          )}
          {i.why && <div className="task-why" title={i.why}>{i.why}</div>}
          <div className="muted small">{i.sub}</div>
        </div>
      </>
    );
    // Output sits under the card's own row, not inside the button that opens it.
    const output = i.log && i.log.length > 0 && (
      <details className="task-log">
        <summary>Output</summary>
        <pre>{i.log.slice(-40).join(String.fromCharCode(10))}</pre>
      </details>
    );
    const shown = i.output !== undefined && opened.has(i.id);
    return (
      <div key={i.id} className={`task ${look.tone} ${i.up ? "up" : ""}`}>
        <div className="task-row">
        {i.open || i.output !== undefined ? (
          <button type="button" className="task-open" aria-expanded={i.output !== undefined ? shown : undefined} onClick={i.output !== undefined ? () => flip(i.id) : i.open} title={i.name}>
            {body}
          </button>
        ) : (
          body
        )}
        {i.copy && (
          <button
            type="button"
            className="icon-btn tiny task-act"
            title={copied === i.id ? "Copied" : "Copy the command"}
            aria-label={copied === i.id ? "Copied" : `Copy ${i.name}`}
            onClick={() =>
              void navigator.clipboard.writeText(i.copy!).then(
                () => {
                  setCopied(i.id);
                  setTimeout(() => setCopied((c) => (c === i.id ? "" : c)), 1500);
                },
                () => {},
              )
            }
          >
            <Icon name={copied === i.id ? "check" : "copy"} size={12} />
          </button>
        )}
        {i.stop && (
          // A square, as a stop button is everywhere (Arun, 2026-10-21: "make the stop text into the stop button svg icon").
          <button type="button" className="task-stop" title="Stop" aria-label={`Stop ${i.name}`} onClick={i.stop}>
            <svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">
              <rect width="10" height="10" rx="2" fill="currentColor" />
            </svg>
          </button>
        )}
        {DONE.has(i.status) && (
          <button type="button" className="icon-btn tiny task-clear" title="Clear this one" aria-label={`Clear ${i.name}`} onClick={() => setCleared((c) => new Set([...c, i.id]))}>
            <Icon name="x" size={12} />
          </button>
        )}
        </div>
        {/* The address it is serving: a thing to press, which opens the page in
            the Preview browser beside this. */}
        {i.link && (
          <button type="button" className="task-link" onClick={i.link.open} title="Open in the Preview browser">
            <Icon name="globe" size={12} />
            {i.link.label}
            <Icon name="external" size={11} />
          </button>
        )}
        {output}
        {shown && <pre className="cmd-out task-out">{i.output}</pre>}
      </div>
    );
  };

  return (
    <div className="doc-scroll tasks">
      {/* Wide (the panel extended or full screen), what is running and what finished sit side by side (style.css,
          @container tasks) instead of stretching edge to edge; narrow, one under the other as before. */}
      <div className="tasks-wrap">
        <div className="tasks-head">
          <span className="muted small">
            {running.length || "No"} running · {finished.length} finished{failed ? ` · ${failed} failed` : ""}
          </span>
          {finished.length > 0 && (
            <button type="button" className="rsp-text-btn" onClick={() => setCleared((c) => new Set([...c, ...finished.map((i) => i.id)]))}>
              Clear finished
            </button>
          )}
        </div>

        {items.length === 0 ? (
          <p className="muted small">Nothing here. Ask for something in the message box and it appears as a task.</p>
        ) : (
          <div className="tasks-cols">
            {/* Split, because the two halves are read for different reasons: one
                is what to wait for, the other is what to check. */}
            {running.length > 0 && (
              <section className="tasks-col">
                {/* Only when the halves stand side by side: one under the other, the running ones are plainly first. */}
                {finished.length > 0 && <div className="tasks-group-head tasks-wide-only">Running</div>}
                <div className="tasks-group">{running.map(card)}</div>
              </section>
            )}
            {finished.length > 0 && (
              <section className="tasks-col">
                {running.length > 0 && <div className="tasks-group-head">Finished</div>}
                {/* One quiet list, not a stack of cards: what finished is read down, a failure by its mark and its last words. */}
                <div className="tasks-group done">{finished.map(card)}</div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
