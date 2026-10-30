import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DEMO_TITLE, demoTeam, MOMENT_ORDER, MOMENT_WAITING, teamMoments, type DemoAgent, type Moment, type MomentId } from "../team-demo.js";
import { runOf, type SessionState } from "../session/projection.js";
import { MAIN_LANE, type EngineTool, type SessionEvent } from "../types.js";
import { api } from "./api.js";
import { EngineMark } from "./BrandMarks.js";
import { isLocal } from "./edition.js";
import { laneLabel } from "./handoff-ui.js";
import { Icon } from "./icons.js";
import { hostApi, type MachineState } from "./local.js";
import { PresenceRing } from "./presence.js";
import type { Identity } from "./storage.js";
import { choosePlace } from "./WorkMode.js";
import "./team-demo.css";

/**
 * The team demo, as the person meets it (team-demo.ts): offered once a coding tool works, at setup's last step and on an empty
 * home, and again from Settings › About; started as a real session of their own agents on a sample project; and, beside that
 * session, a light guide that points out each moment as it happens, then offers a crew (Arun, 2026-10-30: "a first run that
 * shows the team").
 */

/** The coding tools on this computer that can take a turn now: installed, not signed out, and able to run here. */
export function readyTools(machine: Pick<MachineState, "tools">): EngineTool[] {
  return machine.tools.filter((t) => t.path && t.loggedIn !== false && !t.unavailable).map((t) => t.tool);
}

// ── which sessions are the demo ───────────────────────────────────

const SIDS = "friday.teamDemo.sids";
const readSids = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(SIDS) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};
export function markTeamDemo(sid: string): void {
  try {
    localStorage.setItem(SIDS, JSON.stringify([...readSids().filter((s) => s !== sid), sid].slice(-20)));
  } catch {
    // Known by its title instead (isTeamDemo).
  }
}
/** A demo session: made here as one, or still under the demo's title. */
export const isTeamDemo = (sid: string, title?: string): boolean => title === DEMO_TITLE || readSids().includes(sid);

/** Ask for the demo from anywhere: on the Code home, which starts it (Code.tsx useTeamDemoStart). */
export function askTeamDemo(): void {
  choosePlace("code");
  // A beat later, so the Code home that the Crew's or Work's has just given way to is there to hear it.
  setTimeout(() => dispatchEvent(new Event("friday:team-demo")), 60);
}

// ── starting it ───────────────────────────────────────────────────

/**
 * The session, its agents and the lead's first message: the session under the demo's title, the first agent in a new folder
 * with the sample project (runner `demo`), the others beside it in that folder, then the server makes the first the lead and
 * asks it to split the job (app.ts team-demo). `say` hears each step, for the line under the box.
 */
export async function runTeamDemo(identity: Identity, team: DemoAgent[], say: (line: string) => void): Promise<{ sid: string; invite: string }> {
  const [lead, ...rest] = team;
  if (!lead || !rest.length) throw new Error("Sign in to a coding tool first: the demo runs your own agents.");
  say("Making the sample project…");
  const r = await api<{ sessionId: string; invites: Record<string, string> }>(identity, "/api/sessions", {
    method: "POST",
    body: JSON.stringify({ userId: identity.id, name: identity.name, title: DEMO_TITLE, kind: "code", goal: "", engine: lead.tool }),
  });
  const sid = r.sessionId;
  const invite = r.invites.owner!;
  markTeamDemo(sid);
  try {
    say(`Starting ${lead.name}…`);
    // Auto: a sample folder made for it, and a demo that stops on every command shows a person approving, not a team.
    const begun = await hostApi<{ cwd?: string }>(identity, "/api/runner/start", { method: "POST", body: JSON.stringify({ sid, invite, tool: lead.tool, demo: true, mode: "full", handMode: "full" }) });
    if (!begun.cwd) throw new Error("The Friday on that computer is too old for the demo. Update it, then try again.");
    let joined = 1;
    let missed = "";
    for (const a of rest) {
      say(`Bringing in ${a.name}…`);
      await hostApi(identity, "/api/runner/start", { method: "POST", body: JSON.stringify({ sid, invite, tool: a.tool, cwd: begun.cwd, mode: "full", handMode: "full", newLane: a.name, share: true }) }).then(
        () => joined++,
        (e: Error) => (missed ||= `${a.name} didn't join: ${e.message.replace(/\.$/, "")}.`),
      );
    }
    if (joined < 2) throw new Error(missed || "The second agent didn't join.");
    say("Handing the lead the job…");
    await api(identity, `/api/sessions/${encodeURIComponent(sid)}/team-demo?invite=${encodeURIComponent(invite)}`, { method: "POST", body: "{}" });
  } catch (e) {
    void api(identity, "/api/sessions/mine/forget", { method: "POST", body: JSON.stringify({ sid }) }).catch(() => {});
    throw e;
  }
  return { sid, invite };
}

/** "Claude Code and Codex", "Claude Code, Codex and Gemini". */
export const namesOf = (team: { name: string }[]): string => (team.length < 2 ? (team[0]?.name ?? "") : `${team.slice(0, -1).map((a) => a.name).join(", ")} and ${team[team.length - 1]!.name}`);

/** What it is, in a sentence, wherever it is offered. */
export const demoBlurb = (team: DemoAgent[]): string =>
  `${team.every((a) => a.tool === team[0]?.tool) ? `Two ${team[0]?.name ?? ""} agents` : namesOf(team)} split a small job on a shared board, tell each other what changed, and check each other's work. In a sample folder Friday makes, on your own plans; a few minutes.`;

/** The tools' marks, side by side, each in the dashed circle a tool wears at rest. */
export function DemoMarks({ team, size = 22 }: { team: DemoAgent[]; size?: number }) {
  return (
    <span className="tdm-marks" aria-hidden="true">
      {team.map((a, i) => (
        <PresenceRing key={`${a.tool}${i}`} state="idle" size={size} square className="tdm-mark">
          <span className="tdm-mark-in">
            <EngineMark tool={a.tool} size={Math.round(size * 0.58)} />
          </span>
        </PresenceRing>
      ))}
    </span>
  );
}

/** The home's offer: one row under the box, for someone with no sessions of their own yet. */
export function TeamDemoOffer({ team, busy, onGo }: { team: DemoAgent[]; busy: boolean; onGo: () => void }) {
  if (team.length < 2) return null;
  return (
    <section className="tdo" aria-label="See your agents work as a team">
      <DemoMarks team={team} />
      <span className="tdo-text">
        <span className="tdo-title">See your agents work as a team</span>
        <span className="tdo-blurb">{demoBlurb(team)}</span>
      </span>
      <button type="button" className="btn small tdo-go" disabled={busy} onClick={onGo}>
        Start
      </button>
    </section>
  );
}

/** The team the demo would bring, from the computer as it stands. */
export const useDemoTeam = (machine: Pick<MachineState, "tools">): DemoAgent[] => {
  const key = readyTools(machine).join(",");
  return useMemo(() => demoTeam(key ? (key.split(",") as EngineTool[]) : []), [key]);
};

// ── the guide beside the session ──────────────────────────────────

const GONE = (sid: string) => `friday.teamDemo.gone.${sid}`;
const SEEN = (sid: string) => `friday.teamDemo.seen.${sid}`;
const readKey = (k: string) => {
  try {
    return localStorage.getItem(k) ?? "";
  } catch {
    return "";
  }
};
const writeKey = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    // Not kept: shown again when the page loads.
  }
};

/** Where a moment points: a task's row on the board while it is on screen, else the team's task tray, else the event's own row. */
function targetOf(m: Moment, onScreen = true): HTMLElement | null {
  const rows = [...document.querySelectorAll<HTMLElement>(`.sv-main [data-seq="${m.target.seq}"]`)];
  const row = rows.find((r) => r.getClientRects().length) ?? rows[0] ?? null;
  const visible = (el: Element | null) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.height > 0 && r.bottom > 0 && r.top < innerHeight;
  };
  if (m.target.task) {
    const task = row?.querySelector<HTMLElement>(`[data-task="${CSS.escape(m.target.task)}"]`) ?? null;
    if (task && (!onScreen || visible(task))) return task;
    const tray = document.querySelector<HTMLElement>(".sv-main .dock-plan");
    if (tray && visible(tray)) return tray;
    return task ?? row;
  }
  return row?.querySelector<HTMLElement>(".tk-card, .board-card, .peer-card") ?? row;
}

/** A ring round the real element, with the moment's line on a tag at its corner: there for a few seconds, never in the way. */
function Spot({ moment, scroll }: { moment: Moment; scroll: boolean }) {
  const [box, setBox] = useState<DOMRect | null>(null);
  useEffect(() => {
    let el = targetOf(moment, !scroll);
    if (scroll) el?.scrollIntoView({ block: "center", behavior: "smooth" });
    let frame = 0;
    const tick = () => {
      if (!el?.isConnected) el = targetOf(moment, !scroll);
      const r = el?.getBoundingClientRect() ?? null;
      setBox((b) => (r && r.height > 0 ? (b && b.top === r.top && b.left === r.left && b.width === r.width && b.height === r.height ? b : r) : null));
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [moment.id, moment.seq, scroll]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!box || box.bottom < 0 || box.top > innerHeight) return null;
  const pad = 4;
  return createPortal(
    <div className="tg-spot" aria-hidden="true" style={{ top: box.top - pad, left: box.left - pad, width: box.width + pad * 2, height: box.height + pad * 2 }}>
      <span className={`tg-spot-tag${box.top < 64 ? " below" : ""}`}>{moment.line}</span>
    </div>,
    document.body,
  );
}

/** How long a moment's ring stays on its element when it first happens. */
const SPOT_MS = 6500;

/**
 * Beside the demo session: the moments to watch for, each said as it happens and pointed at once, on the board card, the task's
 * row or the message itself. A press on one points at it again. No modal, no steps to click through: it can be closed, and the
 * session goes on the same without it. Once the board is done, a line about keeping a crew.
 */
export function TeamGuide({ sid, state, events }: { sid: string; state: SessionState; events: SessionEvent[] }) {
  const moments = useMemo(() => teamMoments(events), [events.length, state.lastSeq]); // eslint-disable-line react-hooks/exhaustive-deps
  const [gone, setGone] = useState(() => readKey(GONE(sid)) === "1");
  const [spot, setSpot] = useState<{ m: Moment; scroll: boolean } | null>(null);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = (m: Moment, scroll: boolean, ms = SPOT_MS) => {
    if (hold.current) clearTimeout(hold.current);
    setSpot({ m, scroll });
    hold.current = setTimeout(() => setSpot(null), ms);
  };
  useEffect(() => () => void (hold.current && clearTimeout(hold.current)), []);
  // Pointed at once each, as it first happens: those already seen (an earlier visit) stay quiet, and of several new at once
  // (coming back to it) only the latest is pointed at.
  const seen = useRef(new Set(readKey(SEEN(sid)).split(",").filter(Boolean)));
  useEffect(() => {
    const fresh = moments.filter((m) => !seen.current.has(m.id));
    if (!fresh.length) return;
    for (const m of fresh) seen.current.add(m.id);
    writeKey(SEEN(sid), [...seen.current].join(","));
    if (!gone) show(fresh[fresh.length - 1]!, false);
  }, [moments]); // eslint-disable-line react-hooks/exhaustive-deps

  // Beside the chat when there's room for both, else one line over the top of it.
  const [narrow, setNarrow] = useState(false);
  const self = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const body = self.current?.closest(".sv-body");
    if (!body) return;
    const ro = new ResizeObserver(() => setNarrow(body.getBoundingClientRect().width < 980));
    ro.observe(body);
    return () => ro.disconnect();
  }, [gone]);

  if (gone) return null;
  const close = () => (writeKey(GONE(sid), "1"), setSpot(null), setGone(true));
  const by = new Map(moments.map((m) => [m.id, m]));
  const done = by.has("done");
  const names = [MAIN_LANE, ...state.lanes.map((l) => l.id)].filter((l) => state.engines[l]?.tool).map((l) => laneLabel(state, l));
  const lead = state.lead ? laneLabel(state, state.lead) : names[0];
  const team = names.filter((n) => n !== lead);
  const latest = [...moments].sort((a, b) => MOMENT_ORDER.indexOf(b.id) - MOMENT_ORDER.indexOf(a.id))[0];
  const markFor = (m: Moment | undefined) => {
    const lane = m && m.id !== "done" ? laneOf(events, m) : null;
    const tool = lane !== null ? state.engines[lane]?.tool : undefined;
    if (!m) return <span className="tg-dot" aria-hidden="true" />;
    if (!tool || m.id === "done")
      return (
        <span className="tg-tick" aria-hidden="true">
          <Icon name="check" size={11} />
        </span>
      );
    return (
      <PresenceRing state={runOf(state, lane!).status === "running" ? "working" : "idle"} size={18} square className="tg-mark">
        <span className="tdm-mark-in">
          <EngineMark tool={tool} size={11} />
        </span>
      </PresenceRing>
    );
  };

  const crew = done && isLocal() && (
    <div className="tg-crew">
      <p>
        <b>Keep a crew.</b> Teammates like these, each with a role and what it has learned, who pick up your goals while you're away.
      </p>
      <button type="button" className="btn small" onClick={() => choosePlace("team")}>
        Keep a crew
      </button>
    </div>
  );

  return (
    <aside ref={self} className={`tg${narrow ? " narrow" : ""}`} aria-label="What your team is doing">
      {spot && <Spot moment={spot.m} scroll={spot.scroll} />}
      {narrow ? (
        <div className="tg-bar">
          {markFor(latest)}
          <button type="button" className="tg-bar-line" disabled={!latest} onClick={() => latest && show(latest, true)}>
            {latest ? latest.line : MOMENT_WAITING.board}
          </button>
          <span className="tg-count">
            {moments.length} of {MOMENT_ORDER.length}
          </span>
          {done && isLocal() && (
            <button type="button" className="tg-bar-crew" onClick={() => choosePlace("team")}>
              Keep a crew
            </button>
          )}
          <button type="button" className="icon-btn tiny" aria-label="Close the guide" title="Close the guide" onClick={close}>
            <Icon name="x" size={13} />
          </button>
        </div>
      ) : (
        <>
          <header className="tg-head">
            <div>
              <h2>Your agents, as a team</h2>
              <p>{team.length ? `${lead} leads, with ${team.join(" and ")}. Each moment is pointed out as it happens.` : "Each moment is pointed out as it happens."}</p>
            </div>
            <button type="button" className="icon-btn tiny" aria-label="Close the guide" title="Close the guide" onClick={close}>
              <Icon name="x" size={13} />
            </button>
          </header>
          <ol className="tg-list">
            {MOMENT_ORDER.map((id: MomentId) => {
              const m = by.get(id);
              return (
                <li key={id} data-moment={id} className={`tg-row${m ? " on" : ""}${spot?.m.id === id ? " lit" : ""}`}>
                  {m ? (
                    <button type="button" className="tg-moment" title="Show me" onClick={() => show(m, true)} onMouseEnter={() => show(m, false, 1800)} onFocus={() => show(m, false, 1800)}>
                      {markFor(m)}
                      <span className="tg-words">
                        <span className="tg-line">{m.line}</span>
                        {m.detail && <span className="tg-detail">{m.detail}</span>}
                      </span>
                    </button>
                  ) : (
                    <span className="tg-moment waiting">
                      {markFor(undefined)}
                      <span className="tg-words">
                        <span className="tg-line">{MOMENT_WAITING[id]}</span>
                      </span>
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
          {crew}
        </>
      )}
    </aside>
  );
}

/** The lane a moment is about: who posted, took, sent or is checking. */
function laneOf(events: SessionEvent[], m: Moment): string | null {
  const ev = events.find((e) => e.seq === m.seq);
  if (!ev) return null;
  const b = ev.body;
  if (b.type === "board.posted") return b.fromLane;
  if (b.type === "board.claimed" || b.type === "board.review") return b.lane;
  if (b.type === "instruction" && b.mesh) return b.mesh.fromLane;
  if (b.type === "mesh.posted") return b.fromLane;
  return ev.lane ?? MAIN_LANE;
}
