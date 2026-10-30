/**
 * The sidebar, folded: a slim rail down the window's left edge in its place (Arun, 2026-10-27: the OpenBot gap "a narrow-window
 * sidebar"). Code, Work and Team, each with its dot when an agent there works or waits on you; a new session; and what is going
 * on in the one shown: the sessions working or waiting on you, or in Team the rooms and each teammate as it stands. Each opens
 * it, and the top button brings the sidebar back.
 *
 */
import type { AttentionState } from "./Attention.js";
import type { Working } from "../attention.js";
import { agentWord } from "./Sidebar.js";
import { Icon } from "./icons.js";
import { EngineMark, FridayMark } from "./BrandMarks.js";
import { PresenceRing } from "./presence.js";
import { RailTip } from "./rail-tip.js";
import { tabListKeys } from "./roving.js";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { currentLook, type RecentSession } from "./storage.js";
import { chooseTheme } from "./prefs.js";
import { applyTheme, readTheme } from "./theme.js";
import { isTeamSid, TeamRailItems, useTeamTab } from "./Teammates.js";
import { isWorkSid, placesBusy, useWorkMode, useWorkSids } from "./WorkMode.js";

const ago = (ts: number) => {
  const m = Math.round((Date.now() - ts) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

/** Who is working, named as the sidebar's row names them: "Claude Code working", never the lane's "Main" (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL"). */
const workingLine = (w: Working | undefined) => (!w ? "Working" : w.lanes > 1 ? `${w.lanes} agents working` : w.what ? `${agentWord(w.what, w.tool)} working` : "Working");

/** The pages the sidebar's foot reaches, reached from the rail's too. */
export type RailPage = "board" | "review" | "automations" | "usage" | "settings";

export function SideRail({ attention, recents, activeSid, view, onOpen, onNew, onShow, onPage, shown = false }: { attention: AttentionState; recents: RecentSession[]; activeSid: string | null; view: string; onOpen: (r: RecentSession) => void; onNew: () => void; onShow: () => void; onPage: (p: RailPage) => void; /** The list is floating open beside it (a narrow window): its button hides it again. */ shown?: boolean }) {
  const [work, setWork] = useWorkMode();
  const [teamOn, setTeam] = useTeamTab();
  // Which sessions are Work sessions, heard as the list says so: read once at first draw, every Work session was Code's until
  // something else drew the rail again (2026-10-27 audit).
  useWorkSids();
  // The top of the page itself, wherever the window's header ends: measured, not guessed from --band, which the desktop window
  // sets only for some pages (Arun, 2026-10-27: the rail stood apart from the header, a strip with a gap above it).
  const [top, setTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const main = document.getElementById("main");
    if (!main) return;
    // Never above the desktop window's header (its traffic lights and buttons, 40px): the home page's top sits higher than a
    // session's, and the rail ran up under the traffic lights there.
    const measure = () => setTop(Math.max(document.documentElement.classList.contains("desktop") ? 40 : 0, Math.round(main.getBoundingClientRect().top)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(main);
    const mo = new MutationObserver(measure);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-band", "class", "style"] });
    addEventListener("resize", measure);
    return () => (ro.disconnect(), mo.disconnect(), removeEventListener("resize", measure));
  }, []);
  // Stopped short of its plan ("stopped at 3 of 5") waits on you to carry it on, as the sidebar and the Work rail say it.
  const shortOf = (sid: string) => (attention.working.has(sid) ? undefined : attention.crews.get(sid)?.agents.find((x) => x.state === "short"));
  const needs = new Set([...attention.items.map((i) => i.sid), ...recents.filter((r) => shortOf(r.sid)).map((r) => r.sid)]);
  const now = Date.now();
  // Snoozed sessions are left out of the rail's list unless they wait on you, so the dots leave out their work too: a dot with
  // nothing to find behind it was the list and the dots disagreeing (2026-10-27 audit).
  const snoozed = new Set(recents.filter((r) => (r.snoozedUntil ?? 0) > now).map((r) => r.sid));
  const busy = placesBusy([...attention.working.keys()].filter((sid) => !snoozed.has(sid)), needs);
  const here = teamOn ? "team" : work ? "work" : "code";
  const places: [typeof here, string, "code" | "pencil" | "users", () => void][] = [
    ["code", "Code", "code", () => (setTeam(false), setWork(false))],
    ["work", "Work", "pencil", () => (setTeam(false), setWork(true))],
    ["team", "Crew", "users", () => setTeam(true)],
  ];
  // In Code or Work: its sessions, those waiting on you first, then those working, then the latest, each a letter in a ring of how
  // it stands (Arun, 2026-10-27: the rail stood empty in Work with a session in the list). Snoozed ones stay out, as in the list.
  const rank = (sid: string) => (needs.has(sid) ? 2 : attention.working.has(sid) ? 1 : 0);
  const live = recents.filter((r) => !isTeamSid(r.sid) && isWorkSid(r.sid) === work && !(snoozed.has(r.sid) && !needs.has(r.sid)));
  live.sort((a, b) => rank(b.sid) - rank(a.sid) || b.openedAt - a.openedAt);
  const stateOf = (sid: string) => (needs.has(sid) ? "needs" : attention.working.has(sid) ? "working" : "idle");
  const lineOf = (r: RecentSession) =>
    needs.has(r.sid) ? (attention.items.find((i) => i.sid === r.sid)?.text ?? (shortOf(r.sid)?.plan ? `Stopped at ${shortOf(r.sid)!.plan}` : "Waiting on you")) : attention.working.has(r.sid) ? workingLine(attention.working.get(r.sid)) : `Opened ${ago(r.openedAt)}`;
  return (
    <nav className="side-rail" aria-label="Sidebar, folded" style={top === null ? undefined : { top }}>
      {/* The desktop app's window band has its own sidebar button: only a browser, with none, needs this one. */}
      {!window.fridayDesktop && (
        <RailTip label={shown ? "Hide the sidebar" : "Show the sidebar"} sub={/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘B" : "Ctrl+B"}>
          <button type="button" className="rail-item rail-show" data-active={shown ? "true" : undefined} aria-expanded={shown} onClick={onShow} aria-label={shown ? "Hide the sidebar" : "Show the sidebar"}>
            <Icon name="sidebar" size={18} />
          </button>
        </RailTip>
      )}
      {/* The tab list's keys (roving.ts): ↑ and ↓ move between the three and pick, and only the picked one is a Tab stop. */}
      <div className="rail-places" role="tablist" aria-label="Code, Work or Crew" aria-orientation="vertical" onKeyDown={tabListKeys}>
        {places.map(([p, label, icon, pick]) => (
          <RailTip key={p} label={label} sub={busy[p] === "needs" ? "An agent is waiting on you" : busy[p] === "working" ? "Agents are working" : p === "team" ? "Teammates who keep their role and memory, and work on your goals" : p === "work" ? "You and a coding tool, on posts, research, video" : "You and a coding tool, on one change"}>
            <button type="button" role="tab" aria-selected={here === p} tabIndex={here === p ? 0 : -1} className="rail-item" data-active={here === p ? "true" : undefined} onClick={pick} aria-label={label}>
              <Icon name={icon} size={18} />
              {p !== here && busy[p] === "needs" && <span className="sb-work-hint rail-hint" data-state="needs" />}
            </button>
          </RailTip>
        ))}
      </div>
      {!teamOn && (
        <RailTip label="New session" sub="⌘K">
          <button type="button" className="rail-item rail-new" onClick={onNew} aria-label="New session">
            <Icon name="plus" size={18} />
          </button>
        </RailTip>
      )}
      <span className="rail-sep" aria-hidden="true" />
      <div className="rail-list">
        {teamOn ? (
          <TeamRailItems onOpen={onOpen} activeSid={activeSid} />
        ) : (
          // One button, not a tile per session (Arun, 2026-10-27: a column of letters was "hard to keep track off"): it opens the
          // sessions by name, grouped as the sidebar has them, beside the rail; its badge counts those waiting on you.
          <SessionsFly live={live} needs={needs} work={work} activeSid={activeSid} onOpen={onOpen} lineOf={lineOf} stateOf={stateOf} toolOf={(sid) => attention.working.get(sid)?.tool ?? attention.crews.get(sid)?.agents.find((x) => x.tool)?.tool} />
        )}
      </div>
      {/* What the sidebar's foot has, so folding it loses nothing (2026-10-27 audit: folded, there was no way to Search,
          Settings or the pages but to unfold it first). */}
      {/* No Search here (Arun, 2026-10-30: "get rid of the search icon in the side bar too"): ⌘⇧F and ⌘K find everything. */}
      <div className="rail-foot">
        {FOOT.map(([p, label, icon, sub]) => (
          // With the Team tab on, Automations is the team's workflows (TeamWorkflows.tsx; Arun, 2026-10-28).
          <Fragment key={p}>
            {p === "settings" && <LookButton />}
            <RailTip label={label} sub={teamOn && p === "automations" ? "Your crew's workflows, and your coding tools'" : sub}>
              <button type="button" className="rail-item" data-active={view === p || (p === "automations" && view === "agents") ? "true" : undefined} aria-current={view === p ? "page" : undefined} onClick={() => onPage(p)} aria-label={label}>
                <Icon name={icon} size={18} />
              </button>
            </RailTip>
          </Fragment>
        ))}
      </div>
    </nav>
  );
}

/** Light or dark, as the sidebar's foot has it beside Settings: folded, the rail had every button of that foot but this one
 * (Arun, 2026-10-28: "a look for like the little details and designs… for the whole app too"). */
function LookButton() {
  const [look, setLook] = useState(currentLook);
  useEffect(() => {
    const mo = new MutationObserver(() => setLook(currentLook()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  const next = look === "light" ? "dark" : "light";
  return (
    <RailTip label={`Switch to ${next}`}>
      <button
        type="button"
        className="rail-item"
        aria-label={`Switch to ${next} mode`}
        onClick={() => {
          // Friday's own light or dark, as the sidebar's button does: a colour theme on comes off first.
          if (readTheme()) applyTheme(null);
          chooseTheme(next);
          setLook(currentLook());
        }}
      >
        <Icon name={next === "light" ? "sun" : "moon"} size={18} />
      </button>
    </RailTip>
  );
}

const FOOT: [RailPage, string, "board" | "gitPullRequest" | "zap" | "usage" | "gear", string][] = [
  ["board", "Agent Board", "board", "Every agent, by what it's doing"],
  ["review", "Code Review", "gitPullRequest", "Pull requests to look at"],
  ["automations", "Automations", "zap", "Your coding tools on a schedule"],
  ["usage", "Usage", "usage", "How much of each plan you've used"],
  ["settings", "Settings", "gear", "Appearance, tools, your models"],
];

/** The rail's sessions button and the panel it opens: Waiting on you, Working, Recent, by name, each opening its session. */
function SessionsFly({ live, needs, work, activeSid, onOpen, lineOf, stateOf, toolOf }: { live: RecentSession[]; needs: Set<string>; work: boolean; activeSid: string | null; onOpen: (r: RecentSession) => void; lineOf: (r: RecentSession) => string; stateOf: (sid: string) => string; toolOf: (sid: string) => Working["tool"] }) {
  const [open, setOpen] = useState(false);
  // Beside the button, level with it (Arun, 2026-10-27: "have it appear next to the button on hover and not above"); moved up
  // only as far as it must to stay in the window.
  const [at, setAt] = useState<{ top: number; left: number }>({ top: 0, left: 60 });
  const btn = useRef<HTMLButtonElement | null>(null);
  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (r) setAt({ top: Math.max(8, Math.min(r.top - 8, innerHeight - 420)), left: r.right + 10 });
  };
  const shut = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether the pointer is over it now: the hover has opened it already, and a click then keeps it open rather than toggling it
  // shut (2026-10-27 audit: moving onto the button and clicking it closed the panel the hover had just opened). With no hover (a
  // touch, the keyboard) a click opens and closes it.
  const over = useRef(false);
  const hold = () => ((over.current = true), shut.current && clearTimeout(shut.current), place(), setOpen(true));
  const leave = () => ((over.current = false), (shut.current = setTimeout(() => setOpen(false), 220)));
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [open]);
  const waiting = live.filter((r) => needs.has(r.sid));
  const groups: [string, RecentSession[]][] = [
    ["Waiting on you", waiting],
    ["Working", live.filter((r) => stateOf(r.sid) === "working")],
    ["Recent", live.filter((r) => stateOf(r.sid) === "idle").slice(0, 12)],
  ];
  const working = live.filter((r) => stateOf(r.sid) === "working").length;
  return (
    <div className="rail-fly-wrap" onMouseEnter={hold} onMouseLeave={leave}>
      <button
        ref={btn}
        type="button"
        className="rail-item"
        data-active={open ? "true" : undefined}
        aria-expanded={open}
        // ↓ opens it onto its first session (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown") return;
          e.preventDefault();
          place();
          setOpen(true);
          requestAnimationFrame(() => btn.current?.parentElement?.querySelector<HTMLElement>(".rail-fly-row")?.focus());
        }} aria-label={`${work ? "Work" : "Code"} sessions${waiting.length ? `, ${waiting.length} waiting on you` : working ? `, ${working} working` : ""}`} onClick={() => (place(), over.current ? setOpen(true) : setOpen((o) => !o))}>
        <Icon name="list" size={18} />
        {waiting.length > 0 && <span className="rail-count">{waiting.length}</span>}
        {/* Something working and nothing waiting: a blue dot, so the folded sidebar still says so (Arun, 2026-10-30). */}
        {!waiting.length && working > 0 && <span className="rail-dot live" aria-hidden />}
      </button>
      {open && (
        <div
          className="rail-fly"
          style={{ top: at.top, left: at.left }}
          role="dialog"
          aria-label={`${work ? "Work" : "Code"} sessions`}
          // Up and down through the sessions, Home and End to either end, as the sidebar's list goes (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
          onKeyDown={(e) => {
            const move = ({ ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity } as Record<string, number>)[e.key];
            if (move === undefined) return;
            const rows = [...e.currentTarget.querySelectorAll<HTMLElement>(".rail-fly-row")];
            if (!rows.length) return;
            e.preventDefault();
            const i = rows.indexOf(document.activeElement as HTMLElement);
            rows[Number.isFinite(move) ? (i + move + rows.length) % rows.length : move < 0 ? 0 : rows.length - 1]!.focus();
          }}
        >
          <div className="rail-fly-head">{work ? "Work" : "Code"} sessions</div>
          {live.length === 0 && <p className="rail-fly-none">No sessions yet.</p>}
          {groups.map(([title, list]) =>
            list.length ? (
              <section key={title} className="rail-fly-group">
                <h4>{title}</h4>
                {list.map((r) => (
                  <button key={r.sid} type="button" className="rail-fly-row" data-active={activeSid === r.sid ? "true" : undefined} onClick={() => (setOpen(false), onOpen(r))}>
                    {/* The session's mark wearing its state, as the sidebar's row does: a turning blue ring while it works, amber
                        with "?" when it waits on you; the line under the name is plain ink, never blue (2026-10-29 direction §8). */}
                    <span className="rail-fly-mark" aria-hidden="true">
                      <PresenceRing state={stateOf(r.sid) === "needs" ? "needs" : stateOf(r.sid) === "working" ? "working" : "idle"} size={20} square>
                        <span className="sb-mark-disc">{toolOf(r.sid) ? <EngineMark tool={toolOf(r.sid)!} size={11} /> : <FridayMark size={11} />}</span>
                      </PresenceRing>
                    </span>
                    <span className="rail-fly-text">
                      <b>{r.alias || r.title || "Untitled session"}</b>
                      <span data-state={stateOf(r.sid)}>{lineOf(r)}</span>
                    </span>
                  </button>
                ))}
              </section>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}
