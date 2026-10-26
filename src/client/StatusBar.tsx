import { useAgents } from "./agentFocus.js";
import { useEffect, useState, type ReactNode } from "react";
import type { SessionState } from "../session/projection.js";
import { ENGINE_NAMES, MAIN_LANE, type SessionEvent } from "../types.js";
import { Icon } from "./icons.js";
import { sessionLayout, type SessionLayout } from "./prefs.js";

/**
 * The Focus layout's bar along the foot of a Solo session, the way an editor has one: what the agent is doing and for how
 * long, where it is working, what it has changed, and the way to every command. The things you glance at sit where the eye
 * already goes after reading the last message, and the header above keeps only the session's name and its panels.
 */

/** The chosen session layout, redrawn when it is switched in Settings. */
export function useSessionLayout(): SessionLayout {
  const [layout, setLayout] = useState(sessionLayout);
  useEffect(() => {
    const on = () => setLayout(sessionLayout());
    addEventListener("friday:layout", on);
    return () => removeEventListener("friday:layout", on);
  }, []);
  return layout;
}

/** "0:42", "12:05", "1:02:09": a run's length the way a stopwatch shows it. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** What the main agent is doing, in the words and colour the bar shows. */
/** Who an agent is held up on: you, or in a team session somebody you can name. */
function waitingOn(state: SessionState, me?: string): string | null {
  const people = new Set<string>();
  for (const q of Object.values(state.openQuestions)) people.add(!me || q.to === me ? "you" : q.toName);
  // An approval is answered by whoever drives that agent.
  for (const lane of Object.keys(state.approvals)) {
    const d = lane === MAIN_LANE ? state.driver : state.laneDrivers[lane];
    people.add(!me || !d || d.id === me ? "you" : d.name);
  }
  if (!people.size && state.run.status === "waiting_for_human") people.add("you");
  if (!people.size) return null;
  const names = [...people].sort((a, b) => Number(b === "you") - Number(a === "you"));
  return names.length > 2 ? `${names[0]} and ${names.length - 1} others` : names.join(" and ");
}

export function runLine(state: SessionState, events: SessionEvent[], now: number, me?: string): { tone: "idle" | "busy" | "wait" | "err"; text: string; detail?: string } {
  const run = state.run;
  const held = waitingOn(state, me);
  if (held) return { tone: "wait", text: `Waiting for ${held}` };
  if (run.status === "error") return { tone: "err", text: "Stopped", ...(run.error ? { detail: run.error } : {}) };
  if (run.status === "paused") return { tone: "wait", text: "Paused" };
  // A coding tool on your computer that has gone away: "Ready" would promise a run that can't start.
  const engine = state.engines[MAIN_LANE];
  if (engine?.tool && !engine.online) return { tone: "wait", text: "Offline", detail: `${ENGINE_NAMES[engine.tool] ?? "The coding tool"} went offline. Instructions wait until it reconnects.` };
  if (run.status !== "running") return { tone: "idle", text: "Ready" };
  // From the event that started this run; the steps are the tools it has used since.
  let started = 0;
  let steps = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.seq < run.sinceSeq) break;
    if (e.seq === run.sinceSeq) started = e.ts;
    if (e.body.type === "tool.result" && (e.lane ?? MAIN_LANE) === MAIN_LANE) steps++;
  }
  const parts = [started ? clock(now - started) : "", steps ? `${steps} ${steps === 1 ? "step" : "steps"}` : ""].filter(Boolean);
  return { tone: "busy", text: "Working", ...(parts.length ? { detail: parts.join(" · ") } : {}) };
}

export function StatusBar({ state, events, me, where, environment, slot, onChanges }: { state: SessionState; events: SessionEvent[]; /** Who is looking, so "waiting for you" is said only to the person it waits for. */ me: string; where: ReactNode; /** The Environment button (Environment.tsx), where Commands was: the palette is still ⌘⇧P. */ environment?: ReactNode; slot: (el: HTMLElement | null) => void; onChanges: () => void }) {
  const running = state.run.status === "running" || Object.values(state.laneRuns).some((r) => r.status === "running");
  const [now, setNow] = useState(Date.now);
  // Ticks only while a run is going, so an idle session costs nothing.
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  // With several agents the main one's state was the bar's whole story: Codex failing, or three agents at work while the
  // main one sat idle, said "Ready". The waits were already everyone's; working and stopping now are too.
  const agents = useAgents();
  const own = runLine(state, events, now, me);
  const line = ((): typeof own => {
    if (agents.length < 2 || own.tone === "wait" || own.tone === "err") return own;
    const working = agents.filter((a) => a.status === "working");
    if (working.length > 1) return { tone: "busy", text: `${working.length} agents working`, ...(own.tone === "busy" && own.detail ? { detail: own.detail } : {}) };
    if (working.length === 1 && own.tone !== "busy") return { tone: "busy", text: `${working[0]!.name} working` };
    const stopped = agents.find((a) => a.status === "failed" || a.status === "limited");
    if (own.tone === "idle" && stopped) return { tone: "err", text: `${stopped.name} stopped`, detail: stopped.line };
    return own;
  })();
  let files = 0;
  let add = 0;
  let del = 0;
  for (const d of Object.values(state.diffs))
    for (const f of d.files) {
      files++;
      add += f.additions;
      del += f.deletions;
    }

  return (
    <footer className="status-bar session-bar" aria-label="Session status">
      <div className="stb-start">
        {/* The detail in the title too: a narrow bar cuts it short, and hovering still shows it whole. */}
        <span className={`stb-run ${line.tone}`} title={line.detail || undefined}>
          <i className="stb-dot" aria-hidden="true" />
          {/* Only the state is announced: the clock beside it changes every second. */}
          <span className="stb-run-text" role="status">
            {line.text}
          </span>
        </span>
        {/* Beside the state rather than inside it, so a narrow bar shortens the clock first and never the state. */}
        {line.detail && line.tone === "busy" && <span className="stb-run-detail">{line.detail}</span>}
        {where}
      </div>
      <div className="stb-end">
        {files > 0 ? (
          <button type="button" className="stb-item stb-changes" onClick={onChanges} title="Open the changes" aria-label={`${files} ${files === 1 ? "file" : "files"} changed, ${add} lines added, ${del} removed. Open the changes`}>
            <Icon name="file" size={13} />
            <span>
              {files} {files === 1 ? "file" : "files"}
            </span>
            <span className="stb-add">+{add}</span>
            <span className="stb-del">−{del}</span>
          </button>
        ) : (
          <span className="stb-item stb-quiet">No changes yet</span>
        )}
        {/* The Jump menu and the context gauge, drawn here by the chat (see `under` in Activity). */}
        <span className="stb-slot" ref={slot} />
        <span className="stb-sep" aria-hidden="true" />
        {/* Where the agents work, and what that computer is (Environment.tsx). It took Commands' place: every command is still a
            ⌘⇧P away, and said in the palette's own button and in the shortcuts list. */}
        {environment}
      </div>
    </footer>
  );
}

