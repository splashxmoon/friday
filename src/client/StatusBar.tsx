import { focusAgent, useAgents } from "./agentFocus.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { handedCount } from "./crew-at.js";
// What went to the crew from here, in the list: loaded when the list first opens (crew-carry.tsx, its own chunk).
const HandedRows = lazy(() => import("./crew-carry.js").then((m) => ({ default: m.HandedRows })));
import { changeTotals } from "./change-totals.js";
import type { HubAgent } from "../agents-hub.js";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import type { SessionState } from "../session/projection.js";
import { agentState, lanesOf, PHASE_WORD } from "../agent-state.js";
import { backAt } from "../activity-line.js";
import { agentNameFor } from "./agent-name.js";
import { carriedOn } from "../limit-reset.js";
import { ENGINE_NAMES, MAIN_LANE, type SessionEvent } from "../types.js";
import { Icon } from "./icons.js";
import { EngineMark, FridayMark } from "./BrandMarks.js";
import { PresenceRing, type Presence, tickEvery } from "./presence.js";
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

/** The bar's line: its tone (the ring and colour), its words and what the tip adds. */
export type RunTone = "idle" | "busy" | "wait" | "held" | "err" | "limited";
export type BarLine = { tone: RunTone; text: string; detail?: string };

/**
 * What the main agent is doing, in the words and colour the bar shows, from the one selector every view uses (agent-state.ts):
 * any agent held up on you is "Needs you", in amber; held up on somebody else, "Waiting on Ada", quiet (audit B-14); a failed run
 * reads "Friday Code hit an error" with what it means beside it, as its tab, the feed and the sidebar say it (audit B-19).
 */
export function runLine(state: SessionState, events: SessionEvent[], now: number, me = ""): BarLine {
  const lanes = lanesOf(state);
  const views = lanes.map((lane) => ({ lane, now: agentState(state, lane, me, { now: now || Date.now() }) }));
  // No one looking (a watch link): every wait is the reader's to see as "waiting on you", as before there were names.
  if (views.some((v) => v.now.needsYou || (!me && v.now.held))) return { tone: "wait", text: PHASE_WORD.needs };
  const held = views.find((v) => v.now.held);
  if (held) return { tone: "held", text: held.now.word };
  const main = views[0]!.now;
  if (main.phase === "failed") return { tone: "err", text: `${agentNameFor(state, MAIN_LANE)} hit an error`, detail: main.error?.plain ?? "something went wrong" };
  if (main.phase === "limited") return { tone: "limited", text: `${PHASE_WORD.limited}${main.until ? ` until ${backAt(main.until)}` : ""}` };
  if (main.phase === "paused") return { tone: "held", text: PHASE_WORD.paused };
  // A coding tool on your computer that has gone away: "Ready" would promise a run that can't start.
  const engine = state.engines[MAIN_LANE];
  if (main.phase === "offline" && engine?.tool) return { tone: "held", text: PHASE_WORD.offline, detail: `${ENGINE_NAMES[engine.tool] ?? "The coding tool"} went offline. Instructions wait until it reconnects.` };
  const run = state.run;
  if (main.phase !== "working") return { tone: "idle", text: PHASE_WORD.ready };
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
  return { tone: "busy", text: PHASE_WORD.working, ...(parts.length ? { detail: parts.join(" · ") } : {}) };
}

/**
 * The bar's line with every agent counted. With several agents the main one's state was the bar's whole story: Codex failing, or
 * three agents at work while the main one sat idle, said "Ready". The waits were already everyone's; working and stopping now are too.
 */
export function barLine(own: BarLine, agents: HubAgent[], carried: (lane: string) => boolean = () => false): BarLine {
  if (agents.length < 2 || own.tone === "wait" || own.tone === "held" || own.tone === "err") return own;
  const working = agents.filter((a) => a.status === "working");
  if (working.length > 1) return { tone: "busy", text: `${working.length} agents working`, ...(own.tone === "busy" && own.detail ? { detail: own.detail } : {}) };
  if (working.length === 1 && own.tone !== "busy") return { tone: "busy", text: `${working[0]!.name} working` };
  // Out of usage counts only while nobody has its work: once another agent took it on, that one's state is the news.
  const others = (a: HubAgent) => agents.some((b) => b !== a && (b.status === "working" || b.status === "done"));
  const failed = agents.find((a) => a.status === "failed" && !carried(a.lane));
  if (own.tone === "idle" && failed) return { tone: "err", text: `${failed.name} hit an error`, detail: failed.now?.error?.plain ?? failed.line };
  const out = agents.find((a) => a.status === "limited" && !carried(a.lane) && !others(a));
  if (own.tone === "idle" && out) return { tone: "limited", text: `${out.name} is out of usage`, detail: out.line };
  return own;
}

/** The time, ticking only while a run is going, so an idle session costs nothing. */
export function useRunClock(state: SessionState): number {
  const running = state.run.status === "running" || Object.values(state.laneRuns).some((r) => r.status === "running");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    // The page's one 1-second ticker, shared with every other clock and still while the window is hidden (presence.tsx).
    return tickEvery(1000, setNow);
  }, [running]);
  return now;
}

/** How the bar's line stands, on the mark: waiting on someone is amber, as "needs you" is everywhere; paused or away is dashed. */
const BAR_PRESENCE: Record<RunTone, Presence> = { idle: "idle", busy: "working", wait: "needs", held: "queued", err: "error", limited: "limited" };

export function StatusBar({ state, events, me, where, environment, slot, onChanges }: { state: SessionState; events: SessionEvent[]; /** Who is looking, so "waiting for you" is said only to the person it waits for. */ me: string; where: ReactNode; /** The Environment button (Environment.tsx), where Commands was: the palette is still ⌘⇧P. */ environment?: ReactNode; slot: (el: HTMLElement | null) => void; onChanges: () => void }) {
  const now = useRunClock(state);
  const agents = useAgents();
  const line = barLine(runLine(state, events, now, me), agents, (lane) => carriedOn(state, lane));
  const [open, setOpen] = useState(false);
  // What it says on the bar (Arun, 2026-11-13: "get rid of this, and instead make it a clickable like agent status"): what needs you,
  // how many are working, and what is out with the crew; who waits on whom is in the list it opens.
  const out = handedCount(state, events);
  const working = agents.filter((a) => a.status === "working").length;
  const summary = line.tone === "wait" ? line.text : line.tone === "err" || line.tone === "limited" ? line.text : working ? `${working} working` : "";
  const said = [summary, out ? `${out} with the crew` : ""].filter(Boolean).join(" · ");
  // The same count the Changes panel's Everyone says: a file two agents changed is one file (change-totals.ts).
  const all = changeTotals(state);
  const files = all.files.length;
  const add = all.adds;
  const del = all.dels;

  return (
    <footer className="status-bar session-bar" aria-label="Session status" data-slot="session.foot">
      <div className="stb-start">
        {/* The detail in the title too: a narrow bar cuts it short, and hovering still shows it whole. */}
        {/* The state on the agent's own mark, as everywhere (presence.tsx; DIRECTION.md §9.6): the turning ring while it works, amber
            while it waits on someone, red when it stopped. Ready is the plain mark alone, its word kept for a screen reader and the
            tip; the other states keep their words beside it. */}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button type="button" className={`stb-run stb-run-btn ${line.tone}`} title={line.detail ? `${line.text} · ${line.detail}` : line.text} aria-label={`Agents: ${said || line.text}. Show every agent and what's with the crew`}>
              <PresenceRing state={BAR_PRESENCE[line.tone]} size={14} square>
                <span className="stb-mark">{state.engines[MAIN_LANE]?.tool ? <EngineMark tool={state.engines[MAIN_LANE]!.tool!} size={12} /> : <FridayMark size={12} />}</span>
              </PresenceRing>
              <span className="stb-run-text" role="status">
                {said || "Agents"}
              </span>
              <Icon name="chevronUp" size={11} />
            </button>
          </PopoverTrigger>
          <PopoverContent side="top" align="start" sideOffset={8} className="stb-pop">
            <p className="stb-pop-head">In this session</p>
            <ul className="stb-pop-list">
              {lanesOf(state).map((lane) => {
                const st = agentState(state, lane, me, { now: now || Date.now() });
                const tool = state.engines[lane]?.tool;
                const a = agents.find((x) => x.lane === lane);
                return (
                  <li key={lane}>
                    <button type="button" className="stb-pop-row" onClick={() => (focusAgent(state.id, lane), setOpen(false))}>
                      <span className="stb-pop-mark">{tool ? <EngineMark tool={tool} size={13} /> : <FridayMark size={13} />}</span>
                      <span className="stb-pop-main">
                        <span className="stb-pop-name">{agentNameFor(state, lane)}</span>
                        {a?.line && st.phase === "working" && <span className="stb-pop-sub">{a.line}</span>}
                      </span>
                      <span className="stb-pop-word" data-needs={st.needsYou || undefined}>
                        {st.word}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <Suspense fallback={null}>
              <HandedRows state={state} events={events} onPick={() => setOpen(false)} />
            </Suspense>
          </PopoverContent>
        </Popover>
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
          <span className="stb-item stb-quiet">{events.some((ev) => ev.body.type === "folder.committed") ? "All committed" : "No changes yet"}</span>
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

