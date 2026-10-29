/**
 * Teammates (teammates.ts): the person's own AI teammates on this computer, listed in the sidebar like people, each opening on its
 * own chat, all of them working together in the Team room (Arun, 2026-10-27: "i think my local build should be like open bot:
 * Persistent AI teammates on your own computer"; teammates first, a folder each, they finish their queue).
 *
 * A teammate's chat is its lane of the team session, focused (agentFocus.ts); the Team room is that session's every-agent view.
 *
 */
import { leaving } from "./leave-guard.js";
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { ArrowUpIcon, CheckIcon, ChevronRightIcon, CopyIcon, EllipsisIcon, EyeIcon, HandIcon, ZapIcon, MessageSquareReplyIcon, UsersIcon, Settings2Icon, FolderGit2Icon, PlusIcon, ShuffleIcon, TriangleAlertIcon, UserPlusIcon, XIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { isRawError, stoppedLine } from "../activity-line.js";
import { EFFORT_LEVELS, ENGINE_EFFORT_INFO, ENGINE_MODEL_INFO, ENGINE_NAMES, ENGINE_TOOLS, type EngineEffort, type EngineMode, type EngineTool } from "../types.js";
import { canRoute } from "./RouteWhy.js";
import { AgentModelPicker } from "./AgentModelPicker.js";
import { useMachine } from "./local.js";
import type { MateTool, TeammateView } from "../teammates.js";
import { ownName, useOwnModels } from "./ownModelStore.js";
import { describeCheckIn, isCheckIn, quietCheckIns as quietOfLog, type CheckIn } from "../teammate-checkins.js";
import type { SessionEvent } from "../types.js";
import { clockUntil } from "../limit-reset.js";
import { api } from "./api.js";
import { focusAgent, useFocusedAgent } from "./agentFocus.js";
import { ALL } from "./agentNav.js";
import { EngineMark } from "./BrandMarks.js";
import { installedOn } from "./local.js";
import { WorkspaceCard } from "./Workspace.js";
import { ContextMenu, useConfirm, type MenuItem } from "./ui.js";
import type { Identity, RecentSession } from "./storage.js";
import type { Attention } from "../attention.js";
import { distinctLook, teamColour as mascotColour } from "./teammate-block.js";
import { BlobFace, Crown, type Eyes } from "./teammate-face.js";
import { Initials, initialsFaces } from "./teammate-initials.js";
import { byState, elapsed, PresenceRing, useBlink, useFlip, useNow, type Presence } from "./presence.js";
import { MessageResponse } from "@/components/ai-elements/message";
import { ANSWER, mediaText } from "./AnswerParts.js";
import { EVERYONE, mentionsIn, namedIn, namesEveryone } from "./teammate-mentions.js";
import { threadsOf, type ThreadState } from "./team-threads.js";
import { isFridayNote, plainLine } from "./team-room.js";
import { RailTip } from "./rail-tip.js";
import { Avatar } from "./icons.js";
import { createPortal } from "react-dom";
import { ACCESS, backupFor, sayMate, type MateSays } from "./team-status.js";
import { boardTitle, plainError, readSince, type Away } from "./team-api.js";
import { SinceYouLeft } from "./TeamBrief.js";
import { prefillComposer } from "./RunReview.js";
import { notificationsOn } from "./prefs.js";
import { TeammatePage } from "./TeammatePage.js";
import "./teammates.css";

/** A team's size (teammates.ts MAX_TEAMMATES). */
const MAX = 12;

export interface RoomView {
  id: string;
  name: string;
  sid: string;
  invite: string;
  /** Each member's lane in the room, by teammate id. */
  lanes: Record<string, string>;
  working: number;
  waiting: number;
  /** Its last words: who said them, what, and when. */
  last?: { by: string; text: string; at: number } | null;
  /** The lane leading it: who is said to when nobody is @-named. */
  lead?: string | null;
  /** The seq of its newest news: its unread mark. */
  news?: number;
  /** What it is for, in the person's words. */
  purpose?: string;
  /** What each of its teammates working now is on, by lane. */
  doing?: Record<string, string>;
}

export interface Team {
  sid: string;
  invite: string;
  /** The seq of the Team room's newest news (a result, a question, an update): its unread mark. */
  news?: number;
  /** The teammate's lane that leads the Team room. */
  lead?: string | null;
  teammates: TeammateView[];
  rooms: RoomView[];
  /** Every session that is the team's (its own, its rooms', rooms taken away): none is listed with the sessions. */
  hidden: string[];
  /** Away mode, while it is on (team-api.ts): the team decides for itself until then. */
  away?: Away | null;
  /** Every queue, check-in and wake held (Pause team). */
  paused?: boolean;
  /** The Team room's own: its teammates at work there, those waiting on the person there, and what each at work is on, by lane. */
  working?: number;
  waiting?: number;
  doing?: Record<string, string>;
}

/** The teammate on a lane, in the team or in any of its rooms. */
/** The Crew's lead by name, as the team says it now: the room's own record still named the lead just removed (QA, 2026-10-28). */
export const crewLeadName = (): string | null => (team?.lead ? (mateOn(team.lead)?.name ?? null) : null);

export function mateOn(lane: string): TeammateView | null {
  if (!team) return null;
  const own = team.teammates.find((m) => m.lane === lane);
  if (own) return own;
  for (const r of team.rooms ?? []) {
    const id = Object.entries(r.lanes).find(([, l]) => l === lane)?.[0];
    if (id) {
      lanesWere.set(lane, id);
      return team.teammates.find((m) => m.id === id) ?? null;
    }
  }
  // A lane since taken out of its room (the teammate taken out of it) is still that teammate in what was said there: by the
  // lane it had while this page saw it, else by the name the log gave the lane (2026-10-27 audit: editing a room rewrote its
  // history, "To Juno, Pip" reading "To Pip" and "You made Juno the lead" reading "Agent").
  const was = lanesWere.get(lane);
  const name = laneNamed.get(lane);
  return team.teammates.find((m) => m.id === was) ?? (name ? (team.teammates.find((m) => m.name === name) ?? null) : null);
}

/** Each room lane this page has seen, by the teammate it was: kept after the lane goes. */
const lanesWere = new Map<string, string>();
/** The names logs gave their lanes as they were added (learnLanes). */
const laneNamed = new Map<string, string>();
const lanesRead = new WeakSet<readonly SessionEvent[]>();
/** The lanes a team chat's log has had, by name, so a lane since taken away is still told by mateOn: read once per log. */
export function learnLanes(events: readonly SessionEvent[]): void {
  if (lanesRead.has(events)) return;
  lanesRead.add(events);
  for (const e of events) if (e.body.type === "lane.added" && e.body.lane.name) laneNamed.set(e.body.lane.id, e.body.lane.name);
}

/** The teammates in a session (the team, or one of its rooms), each with its lane there, in the order they joined. */
export function matesIn(sid: string): { lane: string; m: TeammateView }[] {
  if (!team) return [];
  if (sid === team.sid) return team.teammates.map((m) => ({ lane: m.lane, m }));
  const r = team.rooms?.find((x) => x.sid === sid);
  return r ? Object.entries(r.lanes).flatMap(([id, lane]) => team!.teammates.filter((m) => m.id === id).map((m) => ({ lane, m }))) : [];
}

/**
 * How each lane of a team chat stands, from that session's own runs: Activity reports them as it draws the chat (noteLaneRuns).
 * A teammate's own status is how it stands anywhere, the team or any room, and busy in Launch week isn't busy in the Team room
 * (2026-10-27 audit: "Kit and Juno are working" under the Team room while Juno worked only in Launch week).
 */
const laneRunsIn = new Map<string, Record<string, "working" | "waiting">>();

/** The runs of a team chat as it is drawn (its laneRuns), kept for how its teammates stand there; a change re-renders what reads it. */
export function noteLaneRuns(sid: string, runs: Record<string, { status: string }>): void {
  const now: Record<string, "working" | "waiting"> = {};
  for (const [lane, r] of Object.entries(runs)) {
    if (r.status === "running") now[lane] = "working";
    else if (r.status === "waiting_for_human") now[lane] = "waiting";
  }
  if (JSON.stringify(laneRunsIn.get(sid) ?? null) === JSON.stringify(now)) return;
  laneRunsIn.set(sid, now);
  tell();
}

/** A team chat closed: its runs are no longer watched, so how its teammates stand there goes back to what the server says. */
export function forgetLaneRuns(sid: string): void {
  if (laneRunsIn.delete(sid)) tell();
}

/**
 * How a teammate stands in one team chat (`sid`, its lane there): from that chat's own runs when it has been drawn, else from what
 * the room says its teammates are on (RoomView.doing), else as it stands anywhere. Offline and out of usage are the teammate's
 * own, wherever it is.
 */
export function statusIn(sid: string, lane: string, m: TeammateView): TeammateView["status"] {
  if (m.status === "offline" || m.status === "limited") return m.status;
  const runs = laneRunsIn.get(sid);
  if (runs) return runs[lane] ?? (m.status === "stopped" ? "stopped" : "idle");
  const doing = team && sid === team.sid ? team.doing : team?.rooms?.find((r) => r.sid === sid)?.doing;
  if (doing) return lane in doing ? "working" : m.status === "working" ? "idle" : m.status;
  return m.status;
}

/**
 * How many teammates are at work in the Team room itself: as the server counts its own runs (Team.working), as the header does;
 * else from its runs once it has been drawn, else those working and in none of the rooms' work (RoomView.doing). The row and the
 * rail say this, not the whole team's count (2026-10-27 audit; 2026-10-28: the row said "None working" while the lead worked).
 */
export function workingInTeamRoom(t: Team): number {
  if (t.working !== undefined) return t.working;
  return t.teammates.filter((m) => (laneRunsIn.has(t.sid) ? statusIn(t.sid, m.lane, m) === "working" : m.status === "working" && !(t.rooms ?? []).some((r) => !!r.doing && (r.lanes[m.id] ?? "") in r.doing))).length;
}

/**
 * How a teammate stands, the one status for everywhere it is drawn (team-status.ts sayMate): the sidebar, the header's faces, the
 * Team room, the Agents panel, the rail and the @ menu (Arun, 2026-10-28: "run an audit on the teams stuff…"). With `sid` and its
 * lane there, how it stands in that chat: idle there while it works in another room says where it works.
 */
export function mateStatus(m: TeammateView, at?: { sid: string; lane: string }): MateSays {
  const opts = { paused: !!team?.paused, ...(m.tool === "friday" ? { model: modelLabel(m.tool, m.model) } : {}) };
  if (!at) return sayMate(m, opts);
  const here = statusIn(at.sid, at.lane, m);
  const elsewhere = (team?.rooms ?? []).filter((r) => r.sid !== at.sid && !!r.doing && (r.lanes[m.id] ?? "") in r.doing).map((r) => r.name);
  // The Team room's work as it is drawn, else as the server last said (2026-10-28 QA: forgotten once you left it, "working elsewhere").
  if (team && team.sid !== at.sid && (laneRunsIn.get(team.sid)?.[m.lane] ?? (m.lane in (team.doing ?? {}) ? "working" : undefined)) === "working") elsewhere.unshift("the Crew room");
  return sayMate(m, { ...opts, here, elsewhere });
}

/** A teammate's line in one team chat (mateStatus). */
export const statusLineIn = (sid: string, lane: string, m: TeammateView): string => mateStatus(m, { sid, lane }).line;

/** The teammates in a session as the box sees them: each with its lane in that session. */
const here = (sid: string): TeammateView[] => matesIn(sid).map(({ lane, m }) => ({ ...m, lane }));

/** Whether a session is the team's: the sidebar leaves them all out of the sessions list. */
export const isTeamSid = (sid: string) => !!team && (team.sid === sid || (team.hidden ?? []).includes(sid));

// One copy of the team for the whole page: the sidebar, the home page and the dialogs all read it, and any change re-reads it.
let team: Team | null = null;
let on = false;
const subs = new Set<() => void>();
/** Bumped with every change to the team, for useSyncExternalStore: what reads the team re-renders when, and only when, it moves. */
let version = 0;
const tell = () => (version++, subs.forEach((f) => f()));
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));

/**
 * The team's version, for a view that reads it through mateOn, matesIn and the like (the feed, the box, the marks): calling it
 * re-renders that view as the team changes. Without it a reload drew "Agent" and a generic face until something else moved.
 */
export const useTeamVersion = () => useSyncExternalStore(subscribe, () => version);

/**
 * Whether the team has been read (or the read failed): not the version, which a team chat's runs bump before the team arrives
 * (Arun, 2026-10-28: "really iron out bugs and feature problems and gaps"; a reload while the team loaded turned the sidebar to
 * Code and listed the team's sessions there).
 */
export const teamKnown = () => on || loadFailed;
export const useTeamKnown = () => useSyncExternalStore(subscribe, teamKnown);

/** The Team room is to open as the Team tab next shows: set by turning to it, not by the tab being remembered at launch. */
let openOnShow = false;

const TAB = "friday.sidebar.team";
const readTab = () => {
  try {
    return localStorage.getItem(TAB) === "1";
  } catch {
    return false;
  }
};

/** The sidebar's Team tab, beside Code and Work: on, the sidebar is the team; remembered on this computer. */
export function useTeamTab(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(readTab);
  useEffect(() => {
    const heard = () => setOn(readTab());
    addEventListener("friday:team-tab", heard);
    return () => removeEventListener("friday:team-tab", heard);
  }, []);
  return [on, setTeamTab];
}

/** Whether the Crew is the place on screen. */
export const readTabNow = (): boolean => readTab();

export function setTeamTab(on: boolean): void {
  // Leaving the Crew with unsaved work on screen (a workflow's builder) asks first (leave-guard.ts).
  if (!on && readTab() && leaving(() => setTeamTab(on))) return;
  openOnShow = on;
  try {
    localStorage.setItem(TAB, on ? "1" : "0");
  } catch {
    // A preference: losing it costs nothing.
  }
  dispatchEvent(new Event("friday:team-tab"));
}

/** Opens the New teammate dialog from anywhere (the sidebar's New teammate button). */
export const newTeammate = () => dispatchEvent(new Event("friday:new-teammate"));

/** Asks for the team again now (after a change, or when told something moved). */
let asked = 0;
let shown = 0;
let last = "";
export async function refreshTeam(identity: Identity): Promise<Team | null> {
  // Only the newest answer counts: a poll sent before a change can land after it and would put the old team back.
  const n = ++asked;
  try {
    const got = await api<Team>(identity, "/api/teammates");
    if (n < shown) return team;
    shown = n;
    const text = JSON.stringify(got);
    on = true;
    // The same team as last time changes nothing on screen: no redraw of everything that reads it.
    if (text === last) return team;
    last = text;
    // Away mode just ended (the time came, or the person wrote from their phone): the morning brief is in the Team room.
    if (team?.away?.until && !got.away?.until) void briefReady(identity, team.away.since ?? Date.now() - 12 * 3600_000, got.sid);
    noteStates(team, got);
    team = got;
    pruneSeen([got.sid, ...(got.rooms ?? []).map((r) => r.sid)]);
  } catch {
    // Not this build, or the server not up yet: nothing shows (and the sidebar stops showing it loading).
    if (!on && !loadFailed) (loadFailed = true), tell();
    return team;
  }
  tell();
  return team;
}

/**
 * The morning brief, said outside the app while the window is hidden (Arun, 2026-10-28: "at the away-until time, or when he returns,
 * Friday posts a deterministic brief in the Team room and notifies"): what got done and what needs the person, a press from it.
 */
async function briefReady(identity: Identity, since: number, sid: string): Promise<void> {
  if (typeof Notification === "undefined" || Notification.permission !== "granted" || document.visibilityState === "visible" || !notificationsOn()) return;
  const b = await readSince(identity, since);
  const says = b ? [b.done.length && `${b.done.length} done`, b.waiting.length && `${b.waiting.length} need${b.waiting.length === 1 ? "s" : ""} you`, b.failed.length && `${b.failed.length} didn't finish`].filter(Boolean).join(" · ") : "";
  try {
    const n = new Notification("Your crew's morning brief", { body: says || "What the crew did while you were away is in the Crew room.", tag: `${sid}:brief` });
    n.onclick = () => (window.focus(), n.close(), setTeamTab(true), dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid } })));
  } catch {
    // Notifications are a courtesy; a browser that refuses them changes nothing.
  }
}

/** The first read of the team failed: the sidebar's loading rows give way to nothing. */
let loadFailed = false;

/** The team session's id, once known: the sidebar leaves it out of the sessions list. */
export const teamSid = () => team?.sid ?? null;

/**
 * The team, kept fresh every few seconds, even out of sight, so what they are doing is current the moment the window is looked
 * at again. One timer for the page however many places read it (the sidebar, the Team room, a header), started with the first
 * and stopped with the last.
 */
let users = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let polled: Identity | null = null;
export function useTeam(identity: Identity): Team | null {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    subs.add(f);
    polled = identity;
    users++;
    if (!timer) timer = setInterval(() => polled && void refreshTeam(polled), 4000);
    void refreshTeam(identity);
    const now = () => void refreshTeam(identity);
    document.addEventListener("visibilitychange", now);
    addEventListener("friday:teammates", now);
    return () => {
      subs.delete(f);
      if (--users === 0 && timer) (clearInterval(timer), (timer = null));
      document.removeEventListener("visibilitychange", now);
      removeEventListener("friday:teammates", now);
    };
  }, [identity.id]);
  return on ? team : null;
}

/** The teammates "@" offers in a team box (the team's, or a room's: those in it), each with its mascot and what it does. */
export function teammateAgents(sid: string): { id: string; name: string; mark: ReactNode; hint: string; tone?: string }[] {
  const mates = here(sid);
  // First, everyone here at once (Arun, 2026-10-27: "add an @everyone command too for all of the agents").
  const all =
    mates.length > 1
      ? [
          {
            id: EVERYONE,
            name: "everyone",
            mark: (
              <span className="tm-pick-img tm-pick-all">
                {mates.slice(0, 3).map((m) => (
                  <Face key={m.id} seed={m.look ?? m.name} size={13} />
                ))}
              </span>
            ),
            hint: `All ${mates.length}: ${mates.map((m) => m.name).join(", ")}`.slice(0, 60),
          },
        ]
      : [];
  return [...all, ...mates.map((m) => ({
    id: m.lane,
    name: m.name,
    mark: (
      <span className="tm-pick-img">
        <Face seed={m.look ?? m.name} size={20} status={m.status} />
      </span>
    ),
    // How it stands when that is anything but ready (out of usage, offline, at work), so who to ask is clear as it is picked
    // (Arun, 2026-10-28: the critique's "the @ menu shows status for teammates not ready"); its role otherwise.
    hint: ((s) => (s.state !== "idle" || s.line !== "Idle" ? s.line : m.role ? m.role.split("\n")[0]! : toolName(m.tool)))(mateStatus(m, { sid, lane: m.lane })).slice(0, 56),
    // In its state's colour, out of usage amber, as everywhere else (2026-10-28 QA: every status grey here).
    tone: mateStatus(m, { sid, lane: m.lane }).state,
  }))];
}

/** Where a message in the team's box goes: to every teammate it @-names, or else where the box points. */
export function teammatesNamed(sid: string, text: string, fallback: string): string[] {
  const mates = here(sid);
  const lanes = namedIn(text, mates);
  if (lanes.length) return lanes;
  // Never the room itself, which is nobody: where the box points, if a teammate is there, else the first in the room.
  return mates.some((m) => m.lane === fallback) ? [fallback] : mates[0] ? [mates[0].lane] : [];
}

/** The team session's own title: "Crew", or "Team" as it was made before the rename (app.ts teamSession renames it once). */
const isCrewTitle = (title: string) => title === "Crew" || title === "Team";

/** The team session's title for who is in view: the Team room, or the teammate whose chat it is. Any other session keeps its own. */
export function teamTitle(state: { id: string; title: string; options: { team?: boolean }; lanes: { id: string; name: string }[] }, focused: string): string {
  if (!state.options.team) return state.title;
  // A room keeps its own name; the team's own session is the Team room.
  // Its session was titled "Team" before the Team workflow became Crew (Arun, 2026-10-28: "rename team to something else").
  const room = team ? team.sid !== state.id : !isCrewTitle(state.title);
  const name = state.lanes.find((l) => l.id === focused)?.name;
  // A teammate's chat in a room says which room it is ("Launch week · Kit"): the room's menu beside it is the room's, and Kit
  // has a chat of its own in each room it is in (2026-10-27 audit).
  return focused === ALL ? (room ? state.title : "Crew room") : name ? (room ? `${state.title} · ${name}` : name) : state.title;
}

/** The teammate a message in the Team room went to, to say so over it; nothing in a teammate's own chat or anywhere else. */
export function useSentTo(sid: string, inTeam: boolean, lane: string, seq = -1): string {
  const focused = useFocusedAgent(sid);
  if (!inTeam || focused !== ALL) return "";
  const lanes = [lane, ...(alsoTo.get(`${sid}:${seq}`) ?? [])];
  return lanes.map((l) => mateOn(l)?.name ?? "").filter(Boolean).join(", ");
}

/** One message to several teammates (@Kit and @Juno, @everyone) is a copy on each lane: the others' lanes, by the one shown. */
const alsoTo = new Map<string, string[]>();
/** And the others' copies themselves, lane and seq, so the one shown can say which teammates have yet to pick it up. */
const copies = new Map<string, { lane: string; seq: number }[]>();

/**
 * In the Team room, the teammates a message there still waits for (team-room.ts queuedFor): null anywhere else, where a message
 * waiting its turn is in the queue over the box instead. The room shows no queues, so a message held there for a busy teammate
 * stays in the room, saying whom it waits for (2026-10-27 audit: it left the room until it was picked up).
 */
export function useSendCopies(sid: string, inTeam: boolean, lane: string, seq: number): { lane: string; seq: number }[] | null {
  const focused = useFocusedAgent(sid);
  if (!inTeam || focused !== ALL) return null;
  return [{ lane, seq }, ...(copies.get(`${sid}:${seq}`) ?? [])];
}

/**
 * The room's feed with one message sent to several teammates shown once ("To Kit, Juno"), not once for each: the copies are
 * the person's same words, a moment apart, on other lanes.
 */
export function mergeSends<T>(sid: string, items: T[], evOf: (it: T) => SessionEvent | null): T[] {
  const first = new Map<string, SessionEvent>();
  return items.filter((it) => {
    const ev = evOf(it);
    // A check-in or Friday's own note is the teammate's alone, though the same words go to another at the same moment.
    if (!ev || ev.body.type !== "instruction" || ev.actor.kind !== "human" || ev.body.mesh || isCheckIn(ev.body.text) || isFridayNote(ev)) return true;
    const key = `${ev.actor.id}|${ev.body.text}`;
    const was = first.get(key);
    if (was && Math.abs(ev.ts - was.ts) < 5000 && (ev.lane ?? "main") !== (was.lane ?? "main")) {
      const k = `${sid}:${was.seq}`;
      const lanes = alsoTo.get(k) ?? [];
      if (!lanes.includes(ev.lane ?? "main")) alsoTo.set(k, [...lanes, ev.lane ?? "main"]);
      const had = copies.get(k) ?? [];
      if (!had.some((c) => c.seq === ev.seq)) copies.set(k, [...had, { lane: ev.lane ?? "main", seq: ev.seq }]);
      return false;
    }
    first.set(key, ev);
    return true;
  });
}

/**
 * The face of whoever did what an event line says: the teammate that did it, by its name, or the person; the line is theirs
 * (2026-10-27 audit: "Nova added Pip" showed Pip's face, the one added). Null for Friday's own, which the caller marks.
 */
function actorFace(ev: SessionEvent): ReactNode {
  if (ev.actor.kind === "human") return <Avatar name={ev.actor.name} id={ev.actor.id} size={20} />;
  const m = team?.teammates.find((x) => x.name === ev.actor.name) ?? mateOn(ev.lane ?? "");
  return ev.actor.kind === "agent" && m ? <Face seed={m.look ?? m.name} size={20} /> : null;
}

/** Friday's own note to a teammate in a team's chat ("[Friday] …": carry on, a reminder), as a line, not a message from the person. */
export function FridayLine({ text, lane, stamp }: { text: string; lane: string; stamp: ReactNode }) {
  const m = mateOn(lane);
  return (
    <div className="tt-event">
      {/* Friday's mark: it is Friday speaking, not the teammate it speaks to (2026-10-27 audit). */}
      <span className="tt-event-face">
        <EngineMark tool="" size={16} />
      </span>
      <span className="tt-event-text">
        <b>Friday</b> to <b>{m?.name ?? "a teammate"}:</b> <span className="tt-event-ask">{text.slice(9).split(/\n|(?<=\.)\s/)[0]}</span>
      </span>
      <span className="tt-stamp">{stamp}</span>
    </div>
  );
}

/** Session housekeeping the team leaves out of its chat: tools connecting and leaving, lanes made and renamed. */
export const plumbing = (type: string) => /^(engine\.(attached|detached|expected)|lane\.(added|renamed|updated)|member\.|session\.(created|updated)|link\.)/.test(type);

/** The folders and repos a teammate works in besides its own, from a record of either age (teammates.ts projectsOf). */
export const foldersOf = (m: Pick<TeammateView, "projects" | "project">): string[] => m.projects ?? (m.project ? [m.project] : []);

/** Gives a teammate a folder or repo to work in, or takes one away; it starts again with them, its conversation kept. */
async function setFolders(identity: Identity, m: TeammateView, projects: string[]): Promise<void> {
  await api(identity, `/api/teammates/${m.id}`, { method: "PATCH", body: JSON.stringify({ projects }), headers: { "Content-Type": "application/json" } });
  await refreshTeam(identity);
}

/**
 * Where code lives, for the teammate on `lane`: the new-session page's card (Workspace.tsx: your repos, your GitHub repos, a
 * path or a repo URL to clone), and what is picked is added to the folders it works in (Arun, 2026-10-27: "be able to attach
 * folder, repos, etc").
 */
export function TeammateFolderCard({ identity, lane, trigger, onClose, notify }: { identity: Identity; lane: string; trigger: HTMLElement | null; onClose: () => void; notify: (m: string) => void }) {
  const m = mateOn(lane);
  if (!m) return null;
  return (
    <WorkspaceCard
      identity={identity}
      // Its tool's past conversations are a coding tool's to list; only repos are offered here, so one on its own model asks Claude Code's.
      tool={m.tool === "friday" ? "claude" : m.tool}
      trigger={trigger}
      only="repos"
      onClose={onClose}
      onPick={(p) => {
        if (!p) return;
        const dir = p.folder.path;
        if (foldersOf(m).includes(dir)) return notify(`${m.name} already works in ${short(dir)}.`);
        setFolders(identity, m, [...foldersOf(m), dir])
          .then(() => notify(`${m.name} can work in ${short(dir)} now.`))
          .catch((e: Error) => notify(e.message));
      }}
    />
  );
}


const COPIED = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "wordSpacing", "textIndent", "tabSize", "whiteSpace", "overflowWrap", "wordBreak", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "boxSizing", "textTransform"] as const;

/**
 * Each @Name in the team's box drawn as that teammate's pill, in its own colour, as it is typed (Arun, 2026-10-27: "add like
 * some visual UI thing in the input chat if you @ a teammate"). A textarea can't colour part of its text, so a copy of the text
 * sits exactly under it, in the same type and wrapping, and the textarea's own letters go clear while there is a name to draw;
 * its caret and selection stay its own.
 */
export function MentionBackdrop({ sid, text, textarea }: { sid: string; text: string; textarea: RefObject<HTMLTextAreaElement | null> }) {
  const mates = here(sid);
  const marks = mentionsIn(text, mates);
  const back = useRef<HTMLDivElement>(null);
  const on = marks.length > 0;
  useLayoutEffect(() => {
    const el = textarea.current;
    const b = back.current;
    if (!el) return;
    el.classList.toggle("tm-ghost", on);
    if (!b || !on) return;
    // Laid over the textarea exactly: its type, padding and box, and its content width (a scrollbar narrows it), again as it
    // resizes (the window, the sidebar, a panel opening) so the lines wrap where the textarea's do.
    const fit = () => {
      const cs = getComputedStyle(el);
      for (const k of COPIED) b.style[k] = cs[k];
      const bar = el.offsetWidth - el.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
      Object.assign(b.style, { top: `${el.offsetTop}px`, left: `${el.offsetLeft}px`, width: `${el.offsetWidth}px`, height: `${el.offsetHeight}px`, paddingRight: `${parseFloat(cs.paddingRight) + Math.max(0, bar)}px` });
      b.scrollTop = el.scrollTop;
    };
    const parent = el.parentElement;
    const placed = parent && getComputedStyle(parent).position === "static";
    if (placed) parent.style.position = "relative";
    fit();
    const follow = () => (b.scrollTop = el.scrollTop);
    el.addEventListener("scroll", follow);
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => {
      el.removeEventListener("scroll", follow);
      watch.disconnect();
      if (placed) parent.style.position = "";
    };
  });
  useEffect(() => () => textarea.current?.classList.remove("tm-ghost"), [textarea]);
  if (!on) return null;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [i, m] of marks.entries()) {
    if (m.at > at) parts.push(text.slice(at, m.at));
    const mate = mates.find((x) => x.lane === m.lane);
    parts.push(
      <span key={i} className="tm-mention" style={{ "--c": m.lane === EVERYONE ? "var(--ink-2)" : mascotColour(mate?.look ?? mate?.name ?? "") } as CSSProperties}>
        {text.slice(m.at, m.end)}
      </span>,
    );
    at = m.end;
  }
  parts.push(text.slice(at));
  // A last newline is drawn as a line by a textarea and dropped by a div: a space after it keeps the two the same height.
  return (
    <div ref={back} className="tm-backdrop" aria-hidden="true">
      {parts}
      {text.endsWith("\n") ? " " : ""}
    </div>
  );
}

/** A sent message's words with each @Name in it as its teammate's pill, as it looked in the box (MentionBackdrop). */
export function MentionText({ sid, text }: { sid: string; text: string }) {
  useTeamNow();
  // Who is in the chat now, then the rest of the team: a teammate since taken out of the room keeps its pill in what was said
  // to it there (2026-10-27 audit).
  const now = here(sid);
  const mates = [...now, ...(team?.teammates ?? []).filter((m) => !now.some((x) => x.id === m.id))];
  const marks = mentionsIn(text, mates);
  if (!marks.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [i, m] of marks.entries()) {
    if (m.at > at) parts.push(text.slice(at, m.at));
    const mate = mates.find((x) => x.lane === m.lane);
    parts.push(
      // Snug against punctuation after it: its padding read as a space before a colon, "@Pip : …" (2026-10-27 audit).
      <span key={i} className="tm-mention sent" data-tight={/^[,.:;!?)]/.test(text.slice(m.end)) ? "" : undefined} style={{ "--c": m.lane === EVERYONE ? "var(--ink-2)" : mascotColour(mate?.look ?? mate?.name ?? "") } as CSSProperties}>
        {text.slice(m.at, m.end)}
      </span>,
    );
    at = m.end;
  }
  parts.push(text.slice(at));
  // One piece of text: the bubble lays out its children as blocks, which stacked each pill on a line of its own.
  return <span className="tm-sent-text">{parts}</span>;
}

/** Over the team's box, while it @-names teammates: who it goes to, robots and names, in place of the one the box points at. */
export function TeamRecipients({ sid, text }: { sid: string; text: string }) {
  const mates = here(sid);
  const lanes = namedIn(text, mates);
  if (!lanes.length) return null;
  const named = lanes.map((l) => mates.find((m) => m.lane === l)!).filter(Boolean);
  if (namesEveryone(text, mates))
    return (
      <span className="tm-recipients">
        <span className="tm-recipients-to">To</span>
        <span className="tm-working-faces">
          {named.slice(0, 5).map((m) => (
            <Face key={m.id} seed={m.look ?? m.name} size={18} />
          ))}
        </span>
        <span className="tm-recipient">everyone ({named.length})</span>
      </span>
    );
  return (
    <span className="tm-recipients">
      <span className="tm-recipients-to">To</span>
      {named.map((m) => (
        <span key={m.id} className="tm-recipient" style={{ "--c": mascotColour(m.look ?? m.name) } as CSSProperties}>
          <Face seed={m.look ?? m.name} size={18} />
          {m.name}
        </span>
      ))}
    </span>
  );
}

/** Whether the team's box @-names anyone: the pill for where it points steps aside for TeamRecipients. */
export const namesSomeone = (sid: string, text: string) => namedIn(text, here(sid)).length > 0;

/**
 * What a teammate runs on, by name: its coding tool, or "Your model" for one of the person's own models through Friday Code
 * (Settings › Your models; Arun, 2026-10-27: "be able to run your own models and stuff for teammates as well").
 */
export const toolName = (tool: MateTool): string => (tool === "friday" ? "Your model" : ENGINE_NAMES[tool]);

/** Its mark: its coding tool's, or Friday's own for one on the person's own model. */
export const markOf = (tool: MateTool): EngineTool | "" => (tool === "friday" ? "" : tool);

/** What a teammate runs on, in a few words: Smart routing, a model's name, or its tool's default; an own model by its name in Settings. */
export function modelLabel(tool: MateTool, model?: string): string {
  if (tool === "friday") return model ? ownName(model) : "No model picked";
  if (model === "auto") return "Smart routing";
  if (!model) return "Default model";
  return ENGINE_MODEL_INFO[tool].find((m) => m.id === model)?.label ?? model;
}

/**
 * Which coding tool a teammate runs on and on which model, as the one pill Code and Work have (AgentModelPicker), smart routing
 * among its models (Arun, 2026-10-27: "be able to switch the model and coding tool in the teammate individual sessions … like
 * the model selector we have for coding and work").
 */
export function TeammatePicker({ identity, tool, model, effort, onChange, onEffort }: { identity: Identity; tool: MateTool; model: string; effort?: EngineEffort | null; onChange: (tool: MateTool, model: string) => void; onEffort?: (e: EngineEffort | null) => void }) {
  const levels = tool === "friday" ? [] : (EFFORT_LEVELS[tool] ?? []);
  const own = useOwnModels(identity);
  const { state: machine } = useMachine(identity);
  const here = machine.mode === "local" || machine.mode === "linked";
  // What each tool's row says about this computer, as on the new-session page.
  const toolState = (t: EngineTool) => {
    const f = here ? machine.tools.find((x) => x.tool === t) : null;
    return {
      disabled: !!f && (!f.path || !!f.unavailable),
      absent: !!f && !f.path,
      ready: !!f?.path && !f.unavailable && f.loggedIn !== false,
      hint: f ? (f.path ? (f.unavailable ? "not here yet" : f.loggedIn === false ? "sign in" : "ready") : "not installed") : machine.mode === "checking" ? "…" : "connect",
    };
  };
  return (
    <AgentModelPicker
      engine={tool === "friday" ? "" : tool}
      // Its own coding tools, and Friday Code on one of the person's own models (Settings › Your models), never Friday's: the
      // models are listed beside it, and with none set up yet it says how to add one (Arun, 2026-10-27: "be able to run your own
      // models and stuff for teammates as well").
      onEngine={(t) => (t ? onChange(t, ENGINE_MODEL_INFO[t].some((m) => m.id === model) ? model : canRoute(t) ? "auto" : "") : onChange("friday", own.some((m) => m.choice === model) ? model : (own[0]?.choice ?? "")))}
      model={tool === "friday" ? "" : model}
      onModel={(id) => onChange(tool, id)}
      fridayModelId={tool === "friday" ? model : ""}
      onFridayModel={(id) => onChange("friday", id)}
      fridayName="Your model"
      ownOnly
      plan="free"
      identity={identity}
      toolState={toolState}
      {...(machine.machine?.name ? { machineName: machine.machine.name } : {})}
      // How hard it thinks, for a tool that takes a level: the picker's own Effort column, as on the new-session page.
      effort={onEffort && levels.length ? { now: effort ?? null, options: levels.map((e) => ({ value: e, label: ENGINE_EFFORT_INFO[e].label, title: ENGINE_EFFORT_INFO[e].blurb })), set: onEffort } : null}
    />
  );
}

/** The pill in a teammate's box: what it runs on, changed for it everywhere it is (its chat, the Team room, its rooms). */
export function TeammateBoxPicker({ identity, lane, notify }: { identity: Identity; lane: string; notify: (m: string) => void }) {
  const m = mateOn(lane);
  if (!m) return null;
  return (
    <TeammatePicker
      identity={identity}
      tool={m.tool}
      model={m.model ?? ""}
      effort={m.effort ?? null}
      onEffort={(effort) =>
        void api(identity, `/api/teammates/${m.id}`, { method: "PATCH", body: JSON.stringify({ effort: effort ?? "" }), headers: { "Content-Type": "application/json" } })
          .then(() => refreshTeam(identity))
          .then(() => notify(`${m.name} thinks at ${effort ? ENGINE_EFFORT_INFO[effort].label : "Auto"} effort now.`))
          .catch((e: Error) => notify(e.message))
      }
      onChange={(tool, model) =>
        // Your models picked with none set up: nothing to put it on yet, so it stays where it is.
        tool === "friday" && !model
          ? notify("Set up a model of your own first, in Settings › Your models.")
          : void api(identity, `/api/teammates/${m.id}`, { method: "PATCH", body: JSON.stringify({ tool, model }), headers: { "Content-Type": "application/json" } })
              .then(() => refreshTeam(identity))
              .then(() => notify(tool !== m.tool ? `${m.name} runs on ${tool === "friday" ? modelLabel(tool, model) : ENGINE_NAMES[tool]} now: a new ${tool === "friday" || m.tool === "friday" ? "model" : "tool"} starts a new conversation.` : `${m.name} runs on ${modelLabel(tool, model)} now.`))
              .catch((e: Error) => notify(e.message))
      }
    />
  );
}

/**
 * A teammate's reply in a team, as a group chat reads it (Arun, 2026-10-27: "fix the Agent response design in the chat too"):
 * its face in the avatar's place; its name in its colour; what it says in bubbles (CSS tm-rsp).
 */
export function teamReply(lane: string, _active: boolean, fallback: ReactNode): [ReactNode, { className: string; style: CSSProperties } | null] {
  const m = mateOn(lane);
  if (!m) return [fallback, null];
  const seed = m.look ?? m.name;
  // Identity only beside a reply: no ring, the header and the reply's own line say how it stands (Arun, 2026-10-29: "i dont like
  // the ring/circle thing around the claude icon in the chat... since it is already shown in the header"; "fix it for the
  // teammates too").
  return [<Face key="face" seed={seed} size={32} />, { className: "tm-rsp", style: { "--who": mascotColour(seed) } as CSSProperties }];
}

/** A teammate given folders or repos, or one taken away, as a line in the chat (Arun, 2026-10-27: "add a visual cue … that a folder or repo was added"). */
export function FoldersGiven({ ev, stamp }: { ev: SessionEvent; stamp: ReactNode }) {
  if (ev.body.type !== "teammate.folders") return null;
  const b = ev.body;
  const m = mateOn(b.lane);
  const chips = (dirs: string[], gone: boolean) =>
    dirs.map((d) => (
      <span key={d} className={`tm-chip${gone ? " gone" : ""}`} title={d}>
        <FolderGit2Icon className="size-3" />
        {short(d)}
      </span>
    ));
  return (
    <div className="tt-event">
      <span className="tt-event-face">{actorFace(ev) ?? <FolderGit2Icon className="size-4" />}</span>
      <span className="tt-event-text">
        {b.added.length > 0 && (
          <>
            <b>{ev.actor.name}</b> gave <b>{b.name}</b> {b.added.length === 1 ? "a folder" : `${b.added.length} folders`} to work in {chips(b.added, false)}
          </>
        )}
        {b.added.length > 0 && b.removed.length > 0 && <span className="tt-event-sep">·</span>}
        {b.removed.length > 0 && (
          <>
            {b.added.length ? "and took away" : (
              <>
                <b>{ev.actor.name}</b> took <b>{b.name}</b> off
              </>
            )}{" "}
            {chips(b.removed, true)}
          </>
        )}
      </span>
      <span className="tt-stamp">{stamp}</span>
    </div>
  );
}

/** A teammate added to the team, or its role changed, by a teammate in the Team room (manage_teammate), as a line in the chat. */
export function TeammateChanged({ ev, stamp }: { ev: SessionEvent; stamp: ReactNode }) {
  if (ev.body.type !== "teammate.changed") return null;
  const b = ev.body;
  // One an agent made is said by its own card, with Keep and Remove (TeamBrief.tsx ProposedMate), not twice.
  if (b.added && mateOn(b.lane)?.madeBy) return null;
  return (
    <div className="tt-event">
      <span className="tt-event-face">{actorFace(ev) ?? <UserPlusIcon className="size-4" />}</span>
      <span className="tt-event-text">
        <b>{ev.actor.name}</b> {b.added ? "added" : "changed the role of"} <b>{b.name}</b>
        {b.added ? " to the crew" : ""}
        {b.role && <span className="tt-event-role" title={b.role}>{b.role}</span>}
      </span>
      <span className="tt-stamp">{stamp}</span>
    </div>
  );
}

/**
 * At the top of the Team room, every room and how it stands: who is in it, who is working on what, and its last words, a press
 * from opening it (Arun, 2026-10-27: "allow the team room be able to get info from all of the other rooms that are currently
 * running too"). The Team room's teammates are told the same with each message (app.ts roomsBrief).
 */
/**
 * At the top of a room of the crew's: what it is for and who works in it, as it is now. A new room opened onto nothing but a lead
 * line, its purpose only on hover over the faces, and a change of members said nowhere (QA, 2026-10-28; Arun: "TEST EVERYTHING…
 * EVERY VISUAL").
 */
export function RoomIntro({ sid }: { sid: string }) {
  const t = useTeamNow();
  const r = t?.rooms?.find((x) => x.sid === sid);
  if (!t || !r) return null;
  const who = Object.keys(r.lanes).flatMap((id) => t.teammates.filter((m) => m.id === id));
  return (
    <section className="tm-room-intro" aria-label={`About ${r.name}`}>
      <RoomFaces seeds={who.slice(0, 3).map((m) => m.look ?? m.name)} size={30} off={who.length > 0 && who.every((m) => m.status === "offline")} />
      <div className="tm-text">
        <span className="tm-room-intro-who">{who.length ? `${listNames(who.map((m) => m.name))} ${who.length === 1 ? "works" : "work"} here` : "Nobody works here yet"}</span>
        {r.purpose ? <p className="tm-room-intro-for">{r.purpose}</p> : <p className="tm-room-intro-for muted">No purpose set. Add one from the room's settings, and its teammates hear it with every message.</p>}
      </div>
    </section>
  );
}

export function RoomsNow({ sid, onOpen, identity, empty }: { sid: string; onOpen: (r: RecentSession) => void; identity?: Identity; /** Nothing said in the room yet: a first goal is suggested. */ empty?: boolean }) {
  const t = useTeamNow();
  if (!t || t.sid !== sid || !t.teammates.length) return null;
  const rooms = t.rooms ?? [];
  const busy = [...rooms].sort((a, b) => b.waiting - a.waiting || b.working - a.working || (b.last?.at ?? 0) - (a.last?.at ?? 0));
  // Who needs you first, then who is working, then the rest: the team at a glance (OpenBot's home list).
  const rank = { waiting: 0, stopped: 1, working: 2, limited: 3, idle: 4, offline: 5 } as const;
  const mates = [...t.teammates].sort((a, b) => rank[a.status] - rank[b.status] || a.created - b.created);
  // Since the person last had the room open, what each teammate did, failed and asks (TeamBrief.tsx), in place of the grid; the
  // grid when nothing happened, or the server can't say (Arun, 2026-10-28: the critique's "Since you left").
  const grid = (
    <section className="tm-rooms-now" aria-label="Teammates now">
      <div className="tm-rooms-head">
        <span>Teammates</span>
        {/* The team at a glance: counted across every room, and said so (2026-10-27 audit). */}
        <span className="tm-count">{t.teammates.filter((m) => m.status === "working").length ? `${t.teammates.filter((m) => m.status === "working").length} working across the crew` : "all quiet"}</span>
      </div>
      <div className="tm-rooms-grid tm-mates-grid">
        {mates.map((m) => {
          const inRooms = rooms.filter((r) => r.lanes[m.id]);
          // Where it is at work, when that is a room: its card says so rather than seeming busy here (2026-10-27 audit).
          const workingIn = rooms.filter((r) => !!r.doing && (r.lanes[m.id] ?? "") in r.doing);
          return (
            <div key={m.id} className="tm-room-card tm-mate-card" data-state={mateStatus(m).state}>
              <button type="button" className="tm-mate-open" onClick={() => focusAgent(t.sid, m.lane)} aria-label={`Open ${m.name}'s chat`}>
                <Face seed={m.look ?? m.name} size={30} status={m.status} />
                <span className="tm-text">
                  <span className="tm-name">{m.name}</span>
                  <span className={`tm-sub s-${mateStatus(m).state}`}>{statusLine(m)}</span>
                </span>
                {m.queued > 0 && <span className="tm-queued" title={queuedTitle(m)} aria-label={queuedTitle(m)}>{m.queued}</span>}
              </button>
              <span className="tm-mate-foot">
                {/* Where the status above it is: the room it works in, else the Team room itself when it is busy, so the two agree
                    (2026-10-27 audit: "Using Bash" over "In Launch week", the Bash being the Team room's). */}
                <span className="tm-mate-where">{workingIn.length ? `Working in ${workingIn.map((r) => r.name).join(", ")}` : m.status === "working" || m.status === "waiting" ? "Here, in the Crew room" : inRooms.length ? `Also in ${inRooms.map((r) => r.name).join(", ")}` : `${toolName(m.tool)} · ${modelLabel(m.tool, m.model)}`}</span>
                {identity && (m.status === "working" || m.status === "waiting") && (
                  <button type="button" className="tt-open" onClick={() => void api(identity, `/api/teammates/${m.id}/stop`, { method: "POST" }).then(() => refreshTeam(identity))}>
                    Stop
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
  return (
    <>
    <SinceYouLeft sid={sid} {...(identity ? { identity } : {})} fallback={grid} />
    {empty && <FirstGoal t={t} />}
    {rooms.length > 0 && (
    <section className="tm-rooms-now" aria-label="Rooms now">
      <div className="tm-rooms-head">
        <span>Rooms</span>
        <span className="tm-count">{rooms.filter((r) => r.working).length ? `${rooms.filter((r) => r.working).length} working` : "all quiet"}</span>
      </div>
      <div className="tm-rooms-grid">
        {busy.map((r) => {
          const who = Object.entries(r.lanes).flatMap(([id, lane]) => t.teammates.filter((m) => m.id === id).map((m) => ({ m, lane })));
          const on = who.filter(({ lane }) => r.doing && lane in r.doing);
          return (
            <button key={r.id} type="button" className="tm-room-card" onClick={() => openRoom(r, onOpen)} data-state={r.waiting ? "waiting" : r.working ? "working" : "idle"}>
              <span className="tm-room-card-top">
                <span className="tm-working-faces">
                  {who.slice(0, 4).map(({ m, lane }) => (
                    <Face key={m.id} seed={m.look ?? m.name} size={18} {...(r.doing && lane in r.doing ? { status: "working" as const } : {})} />
                  ))}
                </span>
                <b>{r.name}</b>
                <span className="tm-room-card-state">{r.waiting ? `${r.waiting} need${r.waiting === 1 ? "s" : ""} you` : r.working ? `${r.working} working` : "Idle"}</span>
              </span>
              {on.length > 0 && (
                <span className="tm-room-card-line">
                  {on
                    .slice(0, 2)
                    .map(({ m, lane }) => `${m.name}: ${r.doing![lane] || "working"}`)
                    .join(" · ")}
                </span>
              )}
              {r.last && (
                <span className="tm-room-card-said">
                  <b>{r.last.by}</b> {plainLine(r.last.text)}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
    )}
    </>
  );
}

/**
 * Before anything is said in the Team room: who leads, in one line, and a first goal or two to start from, put in the box to change
 * (Arun, 2026-10-28: the critique's "after the first teammate, suggest a first goal in the box and explain the lead in one line").
 */
function FirstGoal({ t }: { t: Team }) {
  const lead = t.teammates.find((m) => m.lane === t.lead) ?? t.teammates[0];
  if (!lead) return null;
  const others = t.teammates.filter((m) => m.id !== lead.id).map((m) => m.name);
  const goals = [
    "Read the README and the code, and tell me the three things you'd fix first.",
    others.length ? `Plan this week's work and hand ${others.length === 1 ? others[0] : "everyone"} a part: ` : "Look at the open issues and pick one to fix today.",
    "Every weekday at 9, tell me what changed and what needs me.",
  ];
  return (
    <section className="tm-first" aria-label="A first goal">
      <p className="tm-first-lead">
        <Face seed={lead.look ?? lead.name} size={22} lead />
        <span>
          <b>{lead.name} leads.</b> What you write here without an @name goes to {lead.name}, who plans it{others.length ? ` and hands ${listNames(others)} their parts` : ""}.
        </span>
      </p>
      <div className="tm-first-goals">
        <span className="tm-templates-label">Try</span>
        {goals.map((g) => (
          <button key={g} type="button" className="tm-template tm-goal" onClick={() => prefillComposer(g)}>
            {g.replace(/:\s*$/, "…")}
          </button>
        ))}
      </div>
    </section>
  );
}

/** A teammate's tool ran out of usage and it carries on with another, or is back on its own: a line in its team's chats. */
export function ToolSwitched({ ev, stamp }: { ev: SessionEvent; stamp: ReactNode }) {
  if (ev.body.type !== "teammate.switched") return null;
  const b = ev.body;
  const m = mateOn(b.lane);
  return (
    <div className="tt-event">
      <span className="tt-event-face">{m ? <Face seed={m.look ?? m.name} size={20} /> : null}</span>
      <span className="tt-event-text">
        {b.back ? (
          <>
            <b>{b.name}</b> is back on <EngineMark tool={b.to} size={13} /> <b>{ENGINE_NAMES[b.to]}</b>: its usage limit lifted
          </>
        ) : (
          <>
            <EngineMark tool={b.from} size={13} /> <b>{ENGINE_NAMES[b.from]}</b> ran out of usage, so <b>{b.name}</b> carries on with <EngineMark tool={b.to} size={13} /> <b>{ENGINE_NAMES[b.to]}</b>
            {b.until ? ` until ${clockUntil(b.until)}` : ""}
          </>
        )}
      </span>
      <span className="tt-stamp">{stamp}</span>
    </div>
  );
}

export { isCheckIn };

/**
 * The events of check-ins with nothing new, which the room leaves out (teammate-checkins.ts quietCheckIns): worked out once
 * for each log the feed is drawn from, not on every redraw of it.
 */
let quietOf: { events: readonly SessionEvent[]; quiet: Set<number> } | null = null;
export function quietCheckIns(events: readonly SessionEvent[]): Set<number> {
  if (quietOf?.events !== events) quietOf = { events, quiet: quietOfLog(events).quiet };
  return quietOf.quiet;
}

/** A check-in asked of a teammate, as a line in the chat: what it was asked, and when it is asked. */
export function CheckInLine({ text, lane, stamp }: { text: string; lane: string; stamp: ReactNode }) {
  const m = mateOn(lane);
  const ask = text.slice("[Check-in] ".length).split("\n\n(Your ")[0]!;
  const when = /\(Your (.+?) check-in, set by/.exec(text)?.[1] ?? "";
  return (
    <div className="tt-event">
      <span className="tt-event-face">{m ? <Face seed={m.look ?? m.name} size={20} /> : null}</span>
      <span className="tt-event-text">
        <b>{m?.name ?? "A teammate"}</b>'s check-in{when ? ` (${when})` : ""}: <span className="tt-event-ask">{ask}</span>
      </span>
      <span className="tt-stamp">{stamp}</span>
    </div>
  );
}

/**
 * Over the room's box, "Waiting for replies": each teammate at work here as one live line, its 16px face with the turning ring,
 * its name, what it is doing now and for how long, a press opening its chat (Arun, 2026-10-29: "so clean and beautiful really
 * with a clear direction in design language"; DIRECTION.md §8 and §9.1, after OpenBot's working subagents). It replaces the one
 * "Nova, Kit and Juno are working" line; the Crew tasks pill shares its tray (teammates.css .tm-wait).
 */
export function TeamWorking({ sid }: { sid: string }) {
  useTeamNow();
  const now = useNow(10_000);
  // Working here, in this chat's own runs: not busy in another room (statusIn).
  const busy = matesIn(sid).filter(({ lane, m }) => statusIn(sid, lane, m) === "working");
  if (!busy.length) return null;
  return (
    <div className="tm-wait" role="group" aria-label="Waiting for replies">
      <span className="tm-wait-head">Waiting for replies</span>
      <ul className="tm-wait-list" aria-live="polite">
        {busy.map(({ lane, m }) => {
          const since = workingSinceOf(m);
          const line = mateStatus(m, { sid, lane }).line;
          return (
            <li key={m.id}>
              <button type="button" className="tm-wait-row" onClick={() => focusAgent(sid, lane)} title={`Open ${m.name}'s chat`}>
                <Face seed={m.look ?? m.name} size={16} status="working" />
                <b className="tm-wait-name">{m.name}</b>
                <span className="tm-wait-line">{line}</span>
                {since !== null && <span className="tm-wait-time">{elapsed(since, now)}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * A hand-off between teammates in a crew chat, as one centred line between hairlines: "Nova gave Write the launch thread to
 * Juno", each with its 16px face (Arun, 2026-10-29: "so clean and beautiful really with a clear direction in design language";
 * DIRECTION.md §9.1, after OpenBot's team channel). Pressed, it opens under itself: why, what came with it, and whether it was
 * picked up. It was a card of its own with "carried over" and "the task" in a mono face.
 */
export function HandoffLine({ from, to, fromLane, toLane, task, reason, carried, status, stamp }: { from: string; to: string; fromLane?: string | null; toLane?: string | null; task: string; reason: string; carried: string[]; status: string; stamp: ReactNode }) {
  const [open, setOpen] = useState(false);
  const fm = fromLane ? mateOn(fromLane) : null;
  const tm = toLane ? mateOn(toLane) : null;
  const title = plainLine(boardTitle(task.split("\n").find((l) => l.trim()) ?? task));
  return (
    <div className="tm-handoff" data-open={open ? "true" : undefined}>
      <button type="button" className="tm-handoff-line" aria-expanded={open} onClick={() => setOpen(!open)} title={title}>
        {fm && <Face seed={fm.look ?? fm.name} size={16} />}
        <b>{from}</b>
        <span>gave</span>
        <span className="tm-handoff-task">{title}</span>
        <span>to</span>
        {tm && <Face seed={tm.look ?? tm.name} size={16} />}
        <b>{to}</b>
        <ChevronRightIcon className="tm-handoff-chev size-3" aria-hidden="true" />
      </button>
      {open && (
        <div className="tm-handoff-more">
          {reason && <p>{reason}</p>}
          {carried.length > 0 && (
            <ul>
              {carried.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}
          <span className="tm-handoff-meta">
            {status ? `${status} · ` : ""}
            {stamp}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * A teammate's run in the Team room or a room, as one message (Arun, 2026-10-27: "the actual stuff runs in the individual agent
 * chats and basically the summaries and important stuff that is short … can be displayed in the team room kinda like a group
 * chat"): while it works, what it is on in a line; when it is done, what it said last, short, and its chat a press away for
 * the steps, the changes and the rest.
 */
export function TeamRun({ sid, lane, active, doing, said, outcome, changed, stamp, thread }: { sid: string; lane: string; active: boolean; doing: string; said: string; outcome: string | null; changed: number; stamp: ReactNode; /** Its side thread's line (ThreadChip), under its own links. */ thread?: ReactNode }) {
  const m = mateOn(lane);
  const name = m?.name ?? "Agent";
  const seed = m ? (m.look ?? m.name) : name;
  const tone = mascotColour(seed);
  // How the run stands, in the words the sidebar and its header use too. `active` is its turn under way, running: one that needs
  // the person says so ("waiting"), never "is working" (2026-10-27 audit). A usage limit its teammate switched tools on is said by
  // the switch's own line ("switched", ToolSwitched), once: said here too, one switch read as two rows; and a backup that ran out
  // in turn has nothing left to carry on with, which the teammate's switched record still said (2026-10-27 audit).
  const verb = active
    ? "is working"
    : outcome === "switched"
      ? ""
      : outcome === "limited"
        ? "ran out of usage"
        : outcome === "error"
          ? "stopped on an error"
          : outcome === "cancelled"
            ? "was stopped"
            : outcome === "waiting"
              ? "needs you"
              : said
                ? ""
                : "finished";
  return (
    <div className="tt-msg tt-run">
      <span className="tt-av">
        {/* Identity only: the run's own line says it is working (Arun, 2026-10-29: "fix it for the teammates too"). */}
        <Face seed={seed} size={32} />
      </span>
      <div className="tt-body">
        <div className="tt-meta">
          <span className="tt-from">
            {name}
          </span>
          {verb && <span className="tt-verb">{verb}</span>}
          <span className="tt-stamp">{stamp}</span>
        </div>
        {/* While it works: what it said so far, short, and what it is doing now. */}
        {said && <Bubble text={said} tone={tone} />}
        {active && (
          // One live line, in --ink-2 with the feed's shimmer: the ring on the face above says it works (DIRECTION.md §8).
          <div className="tt-status is-work">
            <span className="tm-live-text">{doing || "Working"}</span>
          </div>
        )}
        <div className="tt-foot">
          {changed > 0 && !active && (
            <span className="tt-chip">
              Changed {changed} file{changed === 1 ? "" : "s"}
            </span>
          )}
          {/* One set of actions on a teammate's message, always in view: reply in its thread, copy it, open their chat (Arun,
              2026-10-28: the critique's "one set: Reply in thread (visible, not hover-only), Copy, Open chat"). */}
          {thread}
          {said && !active && <CopyText text={said} />}
          <button type="button" className="tt-open" onClick={() => focusAgent(sid, lane)}>
            {active ? `Watch ${name} work` : `Open ${name}'s chat`} →
          </button>
        </div>
      </div>
    </div>
  );
}

/** Copy a teammate's words, said as done for a moment. */
function CopyText({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="tt-open tt-copy"
      onClick={() =>
        void navigator.clipboard
          .writeText(text)
          .then(() => (setDone(true), setTimeout(() => setDone(false), 1500)))
          .catch(() => {})
      }
    >
      {done ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      {done ? "Copied" : "Copy"}
    </button>
  );
}

/**
 * A message's words in a chat bubble, drawn as an answer is (AnswerParts.ts): its pictures and videos, tables, links and code
 * show in the room too (Arun, 2026-10-27: "allow for the team room chat to be dynamic too for like visuals"). A long one is cut
 * to a few lines with the rest a press away; one that shows a picture or a video is never cut.
 */
function Bubble({ text, tone }: { text: string; tone?: string }) {
  const [open, setOpen] = useState(false);
  // A picture, a video or a table is shown whole: cut, it said nothing.
  const media = /\.(png|jpe?g|gif|webp|avif|svg|mp4|mov|webm|m4v)\b/i.test(text) || /^\s*\|.*\|\s*$/m.test(text);
  const long = !media && (text.length > 420 || text.split("\n").length > 6);
  return (
    <div className={long && !open ? "tt-bubble clamped" : "tt-bubble"} style={tone ? ({ "--c": tone } as CSSProperties) : undefined}>
      <div className="tt-rich">
        <MessageResponse {...ANSWER}>{mediaText(text.trim())}</MessageResponse>
      </div>
      {long && (
        <button type="button" className="tt-more" onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

/** Who wrote, as a face: a teammate's mascot, or the agent's own mark for one that isn't (AgentTalk passes it). */
function Who({ lane, size, fallback, status }: { lane: string; size: number; fallback?: ReactNode; status?: TeammateView["status"] }) {
  const m = mateOn(lane);
  return m ? <Face seed={m.look ?? m.name} size={size} {...(status ? { status } : {})} /> : <span className="tt-mark">{fallback}</span>;
}

/**
 * One agent's message to another in a team (Team room, a room), as a group chat reads (Arun, 2026-10-27: "redesign the task
 * message thing, it should be like a group chat"): the sender's mascot and name, what it did in a few words ("gave Kit a
 * task", "asked Nova"), the words in its bubble, an answer threaded under it, and where it stands in a line with the one doing it.
 */
export function TeamTalk(p: {
  fromLane: string;
  toLane: string;
  fromName: string;
  toName: string;
  kind: "tell" | "ask" | "reply" | "task";
  report?: boolean;
  review?: boolean;
  carried?: boolean;
  team?: string[];
  text: string;
  why?: string;
  answer?: { text: string; auto?: boolean };
  status?: { word: string; how: string } | null;
  stamp: ReactNode;
  fromMark?: ReactNode;
  toMark?: ReactNode;
}) {
  const sender = mateOn(p.fromLane);
  const tone = sender ? mascotColour(sender.look ?? sender.name) : undefined;
  const many = !!p.team && p.team.length > 1;
  const to = (
    <span className="tt-to">
      {!many && <Who lane={p.toLane} size={16} fallback={p.toMark} />}
      <b>{many ? "the crew" : p.toName}</b>
    </span>
  );
  const verb = p.carried ? <>handed on to {to}</> : many ? <>to {to}</> : p.kind === "task" ? (p.review ? <>asked {to} to check</> : <>gave {to} a task</>) : p.kind === "ask" ? <>asked {to}</> : p.kind === "reply" ? (p.report ? <>reported back to {to}</> : <>answered {to}</>) : <>to {to}</>;
  const busy = p.status?.how === "work";
  return (
    <div className="tt-msg">
      <span className="tt-av">
        <Who lane={p.fromLane} size={32} fallback={p.fromMark} />
      </span>
      <div className="tt-body">
        <div className="tt-meta">
          <span className="tt-from">
            {p.fromName}
          </span>
          <span className="tt-verb">{verb}</span>
          <span className="tt-stamp">{p.stamp}</span>
        </div>
        {p.why && <p className="tt-why">{p.why}</p>}
        <Bubble text={boardTitle(p.text)} {...(tone ? { tone } : {})} />
        {p.answer && (
          <div className="tt-reply">
            <span className="tt-av small">
              <Who lane={p.toLane} size={22} fallback={p.toMark} />
            </span>
            <div className="tt-body">
              <div className="tt-meta">
                <span className="tt-from">{p.toName}</span>
                <span className="tt-verb">{p.answer.auto ? "answered at the end of its turn" : "answered"}</span>
              </div>
              <Bubble text={p.answer.text} />
            </div>
          </div>
        )}
        {p.status && (
          <div className={`tt-status is-${p.status.how}`}>
            {busy ? <span className="ring-spin" aria-hidden="true" /> : p.status.how === "done" || p.status.how === "read" ? <CheckIcon className="size-3 shrink-0" /> : <i className="tt-dot" aria-hidden="true" />}
            {p.status.word}
          </div>
        )}
      </div>
    </div>
  );
}

/** A teammate's lane brought back by its record (its conversation, folders and account kept), through the server. */
export async function reconnectTeammate(identity: Identity, sid: string, lane: string, quiet = false): Promise<void> {
  const m = mateOn(lane);
  if (!m) return;
  await api(identity, `/api/teammates/${m.id}/reconnect`, { method: "POST", body: JSON.stringify({ sid, lane, quiet }), headers: { "Content-Type": "application/json" } });
}

/** What an empty team chat says: the room, waiting for its first teammate or message, or a teammate's own chat. */
export function teamEmpty(mates: number, lane: string | null): [string, string] {
  if (lane) {
    const m = mateOn(lane);
    // Not "ready" while its coding tool isn't running (2026-10-27 audit: the sidebar said Offline, the chat "Pip is ready").
    if (m?.status === "offline" && m.tool === "friday") return [`${m.name} is offline`, `${m.problem ?? "Its folder isn't attached."} What you write here waits, and ${m.name} picks it up once its model can run (right-click it in the sidebar, or its "…", and Restart it).`];
    if (m?.status === "offline") return [`${m.name} is offline`, `Its coding tool isn't running. What you write here waits, and ${m.name} picks it up once its tool is back (right-click it in the sidebar, or its "…", and Restart its tool).`];
    return [`${m?.name ?? "Your teammate"} is ready`, `Tell ${m?.name ?? "them"} what to work on. Their steps, changes and answers show here; the Crew room hears what they finish.`];
  }
  if (!mates) return ["No teammates here yet", "Add a teammate from the sidebar: a name, a role and one of your coding tools. Then give the crew goals here, and @ one to send it straight to them."];
  return ["Your crew's room", "Their results and questions show up here as they work. @ a teammate, or @everyone, to send something straight to them."];
}

/** A teammate's attention item, said as who and where: "Nova · Launch week", not the team session's own title. */
export function teamAttention<T extends { sid: string; title: string; lane?: string; agent?: string }>(it: T): T {
  if (!isTeamSid(it.sid)) return it;
  const m = it.lane ? mateOn(it.lane) : null;
  const where = team?.rooms?.find((r) => r.sid === it.sid)?.name ?? "Crew room";
  return { ...it, title: `${m?.name ?? it.agent ?? "A teammate"} · ${where}` };
}

/**
 * The Agent Board's cards, a team's as its teammates (Arun, 2026-10-28: the critique's "the global Agent Board groups team sessions
 * by teammate and never shows raw error text"): titled by the teammate and where ("Nova · Team room"), the board's prefix and
 * Friday's mark off what it was asked, and an error said in words ("Out of usage until 1:26 PM", not "…limit reached|1793…").
 */
export function teamCards<C extends { sid: string; lane: string; title: string; task: string; detail: string; agent: string }>(cards: C[] | null): C[] | null {
  if (!cards || !team) return cards;
  const out = cards.map((c) => {
    if (!isTeamSid(c.sid)) return c;
    const m = mateOn(c.lane);
    const where = team?.rooms?.find((r) => r.sid === c.sid)?.name ?? "Crew room";
    return { ...c, title: `${m?.name ?? c.agent} · ${where}`, agent: m?.name ?? c.agent, task: boardTitle(c.task.replace(/^\[Friday\]\s*/, "")), detail: plainError(c.detail) };
  });
  // A teammate's cards together, the way the sidebar lists them.
  const rank = (c: C) => (isTeamSid(c.sid) ? (team?.teammates.findIndex((m) => m.id === mateOn(c.lane)?.id) ?? 99) : -1);
  return out.sort((a, b) => (isTeamSid(a.sid) && isTeamSid(b.sid) ? rank(a) - rank(b) : 0));
}

/** A team card's mark: its teammate's face. */
export function teamFace(c: { sid: string; lane: string }): ReactNode {
  const m = isTeamSid(c.sid) ? mateOn(c.lane) : null;
  return m ? <Face seed={m.look ?? m.name} size={24} status={m.status} /> : null;
}

/** A team session's run that finished, titled by where: the Team room or the room's name. */
export const teamDoneTitle = (sid: string, title: string) => (!isTeamSid(sid) ? title : (team?.rooms?.find((r) => r.sid === sid)?.name ?? "Crew room"));

/** The team as last read, for a view that shows it without asking again (the sidebar keeps it fresh). */
export function useTeamNow(): Team | null {
  useTeamVersion();
  return on ? team : null;
}

/** The top of a teammate's own chat: their page, with its tabs (TeammatePage.tsx). */
// A function, not the import itself: the two files import each other, and a const taken from one still loading is not there yet.
export function TeammateHeader(p: { lane: string; identity?: Identity; notify?: (m: string) => void; branch?: string }) {
  return <TeammatePage {...p} />;
}

/** The team session as a recent session, to open it the way the sidebar opens any other. */
export const teamRecent = (t: Team): RecentSession => ({ sid: t.sid, title: "Crew", invite: t.invite, role: "owner", openedAt: Date.now() });

/** Opens one teammate's own chat, or the Team room when `lane` is null. */
export function openTeammate(t: Team, lane: string | null, onOpen: (r: RecentSession) => void): void {
  focusAgent(t.sid, lane ?? ALL);
  onOpen(teamRecent(t));
}

/**
 * Home, with the Team tab on (2026-10-27 audit: it showed Code's "What should we build?" box, so a first message there started a
 * coding session rather than work for the team): the Team room, or, before there is a team, how to start one.
 */
export function TeamHome({ identity, onOpen }: { identity: Identity; onOpen: (r: RecentSession) => void }) {
  const t = useTeam(identity);
  // A team with nobody on it is a first run still (2026-10-28 QA: removing every teammate left an empty Team room).
  const ready = !!t?.sid && t.teammates.length > 0;
  useEffect(() => {
    if (ready) openTeammate(t!, null, onOpen);
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps
  if (ready) return null;
  return (
    <div className="tm-home">
      <div className="tm-home-mark" aria-hidden="true">
        <RoomFaces seeds={["Nova", "Kit", "Juno"]} size={56} />
      </div>
      <h1>Your AI teammates</h1>
      {/* About teammates, not about Code (Arun, 2026-10-28: the critique's "TeamHome talks about teammates, not Code"). */}
      <p>Teammates are AI coworkers with a name, a role and a memory of their own, running on your coding tools on this computer. Give the crew a goal and the lead plans it, hands out the parts and tells you what got done, even while you're away.</p>
      <div className="tm-home-acts">
        <Button onClick={newTeammate}>
          <UserPlusIcon className="size-4" /> Add your first teammate
        </Button>
        <StarterTeam identity={identity} onDone={() => {}} />
      </div>
      <p className="tm-home-note">A starter crew is a lead, an engineer and a writer. Change any of them later.</p>
    </div>
  );
}

/** What a teammate is up to, in a few words for under its name. */
/** When a switched teammate is back on its own tool, in words: "back at 4:00 PM", or "back later" when its limit didn't say. */
const backWhen = (sw: NonNullable<TeammateView["switched"]>) =>
  sw.until ? `back ${new Date(sw.until).toDateString() === new Date().toDateString() ? "at " : "on "}${new Date(sw.until).toLocaleString([], new Date(sw.until).toDateString() === new Date().toDateString() ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "back later";

/** What a teammate's queue count means: how many wait for it, across the Team room and the rooms it is in. */
const queuedTitle = (m: TeammateView): string => `${m.queued} ${m.queued === 1 ? "message waits" : "messages wait"} for ${m.name}${(team?.rooms ?? []).some((r) => r.lanes[m.id]) ? ", across the Crew room and its rooms" : ""}`;

/** When a teammate out of usage is back, from its line ("Out of usage until 10:42 PM"), if it says. */
const limitedUntil = (m: TeammateView): string => /\buntil ([^·]+?)\s*(?:·|$)/.exec(m.line)?.[1] ?? "";

/**
 * Why what waits for a teammate isn't picked up, said after "Queued" or "is answering" (2026-10-27 audit: an offline teammate's
 * message said "Queued for the agent's next step", and a side thread "Nova is answering…" while Nova was out of usage): its
 * tool offline, or out of usage until a time with its backup to take it. Null when it is only busy, or not a teammate.
 */
/**
 * The same for a message waiting on several: said for them all when all are offline ("until Kit and Juno are back online"), else
 * nothing, and the note names who it waits for. It said "until Kit is back online" of a message to Kit and Juno (QA, 2026-10-28).
 */
export function queueWhyAll(lanes: string[]): string | null {
  if (lanes.length < 2) return lanes[0] ? queueWhy(lanes[0]) : null;
  const ms = lanes.map(mateOn);
  if (!ms.every((m) => m?.status === "offline")) return null;
  const names = ms.map((m) => m!.name);
  return `until ${names.slice(0, -1).join(", ")} and ${names.at(-1)} are back online`;
}

export function queueWhy(lane: string): string | null {
  const m = mateOn(lane);
  if (!m) return null;
  if (m.status === "offline") return `until ${m.name} is back online`;
  if (m.status === "limited" && m.tool === "friday") return `until ${modelLabel(m.tool, m.model)} answers again${limitedUntil(m) ? ` at ${limitedUntil(m)}` : ""}`;
  if (m.status === "limited") {
    // On its backup already and that out too: nothing else takes it (team-status.ts backupFor).
    const b = backupFor(m);
    return `until ${toolName(m.tool)} is back${limitedUntil(m) ? ` at ${limitedUntil(m)}` : ""}${b ? `, or ${ENGINE_NAMES[b]} takes it` : ""}`;
  }
  return null;
}

/**
 * A team session's agents for its Agents panel (AgentsHub.tsx): its teammates, each as the sidebar has it where that differs from
 * its lane's own record (offline; on its backup tool since its own ran out), and not the session's own Friday Code, which no
 * teammate is.
 */
export function teamHubAgents<A extends { lane: string; status: string; line: string; tool: EngineTool | null; model?: string | null; mode?: EngineMode | null }>(state: { id?: string; engines: Record<string, { tool?: EngineTool | null } | undefined> }, agents: A[]): A[] {
  return agents
    .filter((a) => a.lane !== "main" || !!state.engines[a.lane]?.tool)
    .map((a) => {
      const m = mateOn(a.lane);
      if (!m) return a;
      // Said as the sidebar says it (mateStatus), with its own model's name and its access, not the lane's "Default model · Auto"
      // (Arun, 2026-10-28: the critique's "the Agents panel in team sessions is team-aware").
      const s = mateStatus(m, state.id ? { sid: state.id, lane: a.lane } : undefined);
      const own = { ...a, model: modelLabel(m.tool, m.model), mode: m.mode ?? "full", line: s.line };
      if (s.state === "offline") return { ...own, status: "offline" };
      if (s.state === "limited") return { ...own, status: "limited" };
      if (m.switched && a.status === "limited" && m.tool !== "friday") return { ...own, status: "ready", tool: m.tool };
      return a.status === "working" || a.status === "waiting" ? { ...own, line: a.line || s.line } : own;
    });
}

/** A teammate's line wherever it is (mateStatus). */
export const statusLine = (m: TeammateView): string => mateStatus(m).line;


/**
 * A teammate's face (teammate-face.tsx): its own round blob from its seed, in its own muted colour, with two eyes (Arun,
 * 2026-10-29: "those avatars should be purely circle based with different morphed shapes"), and how it stands drawn on it
 * (presence.tsx): a blue ring turning while it works, an amber ring and "?" when it needs you, a check for 8s when it has just
 * finished, closed eyes at 60% asleep, a red ring out of usage (owner call C, the turning ring with blinks). A working face blinks
 * now and then and its outline breathes very slowly, in place (never moving around: "dont make the icons move around when
 * working"); with reduced motion it holds still. The lead wears a small crown. Without `status` (beside a message in the feed) it
 * is identity only: no ring.
 */
const PRESENCE: Record<TeammateView["status"], Presence> = { working: "working", waiting: "needs", idle: "idle", offline: "asleep", limited: "error", stopped: "error" };
/** When each face (by its seed) last finished a run, seen as the team moved from working to idle (refreshTeam): its check shows 8s. */
const doneAt = new Map<string, number>();
/** When each face started working, as first seen: its elapsed time counts from here. */
const workingSince = new Map<string, number>();
const DONE_FOR = 8_000;
function noteStates(was: Team | null, now: Team): void {
  const t = Date.now();
  const before = new Map((was?.teammates ?? []).map((m) => [m.id, m.status]));
  for (const m of now.teammates) {
    const seed = m.look ?? m.name;
    const prev = before.get(m.id);
    if (m.status === "working") {
      if (!workingSince.has(seed)) workingSince.set(seed, t);
    } else workingSince.delete(seed);
    if (prev === "working" && m.status === "idle") doneAt.set(seed, t);
    if (m.status === "working") doneAt.delete(seed);
  }
}
/** Since when a teammate has been working, as this window has seen it, or null. */
export const workingSinceOf = (m: Pick<TeammateView, "look" | "name" | "status">): number | null => (m.status === "working" ? (workingSince.get(m.look ?? m.name) ?? null) : null);
export const presenceOf = (status: TeammateView["status"] | undefined): Presence => PRESENCE[status ?? "idle"];
export const Face = memo(function Face({ seed, size, status, label, lead }: { seed: string; size: number; status?: TeammateView["status"]; /** Said to a screen reader; none when the name is beside it. */ label?: string; /** Leads where it is shown: a crown. */ lead?: boolean }) {
  const finished = status === "idle" ? doneAt.get(seed) : undefined;
  const done = finished !== undefined && Date.now() - finished < DONE_FOR;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => tick((n) => n + 1), DONE_FOR - (Date.now() - finished!));
    return () => clearTimeout(t);
  }, [done, finished]);
  const blink = useBlink(status === "working" && !initialsFaces());
  const eyes: Eyes = status === "offline" ? "closed" : blink ? "blink" : "open";
  return (
    <PresenceRing state={done ? "done" : presenceOf(status)} size={size} className="tm-face-wrap" {...(label ? { label } : {})}>
      <span className="tm-face-in" data-lead={lead ? "true" : undefined} aria-hidden="true">
        {initialsFaces() ? <Initials seed={seed} size={size} /> : <BlobFace seed={seed} size={size} eyes={eyes} breathing={status === "working"} />}
        {lead && <Crown />}
      </span>
    </PresenceRing>
  );
});

/** A room's mark: the faces of up to three of its teammates, overlapping, in a tile of `size`, each with its own ring. */
export const RoomFaces = memo(function RoomFaces({ seeds, size, off = false, states }: { seeds: string[]; size: number; /** Nobody in it is online: asleep, as their own faces are (QA, 2026-10-28). */ off?: boolean; states?: (TeammateView["status"] | undefined)[] }) {
  const shown = seeds.slice(0, 3);
  // Initials side by side, not overlapping: letters over letters were cut and unreadable (QA, 2026-10-28).
  const ini = initialsFaces();
  const each = Math.round(size * (shown.length > 1 ? (ini ? 0.48 : 0.62) : 0.9));
  return (
    <span className={`tm-room-faces${ini ? " ini" : ""}${off ? " off" : ""}`} data-n={shown.length} style={{ width: size, height: size }} aria-hidden="true">
      {shown.map((seed, i) => (
        <span key={`${i}-${seed}`} className="tm-room-face" data-i={i}>
          <Face seed={seed} size={each} {...(off ? { status: "offline" as const } : states?.[i] ? { status: states[i] } : {})} />
        </span>
      ))}
    </span>
  );
});

/** A folder by its own name, "site" for ~/code/site: what a repo is called (the whole path is on hover). */
export const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

/** ~ for the home folder, and only the last two folders of a long path: the whole one is on hover. */
export const short = (p: string) => {
  const at = p.replace(/^\/(Users|home)\/[^/]+/, "~").split("/");
  return at.length > 5 ? `…/${at.slice(-2).join("/")}` : at.join("/");
};

/**
 * A teammate's face as a row or a card shows it. The coding tool it runs on is no longer badged on its face (DIRECTION.md §6:
 * teammates look like people, tools like tools): it is said once, on the teammate's page under "Runs on". `tool` is kept for the
 * callers that still pass it.
 */
export function Robot({ seed, size, status, lead }: { seed: string; tool?: EngineTool | ""; size: number; status?: TeammateView["status"]; lead?: boolean }) {
  return <Face seed={seed} size={size} lead={!!lead} {...(status ? { status } : {})} />;
}

/** A teammate lane's mascot for the session's own marks (handoff-ui.ts agentLook): its tabs, speaker lines and the box's "To". */
export function teammateMark(lane: string, size: number): { tool: MateTool; mark: ReactNode } | null {
  const m = mateOn(lane);
  return m ? { tool: m.tool, mark: <Face seed={m.look ?? m.name} size={Math.round(size * 1.6)} /> } : null;
}

/** The sidebar's Teammates: the Team room, then each teammate like a person, with what it is on under its name. */
const TRAYS_FOLDED = "friday.crew.foldedTrays";

export function SidebarTeammates({ identity, onOpen, activeSid, needs = [] }: { identity: Identity; onOpen: (r: RecentSession) => void; activeSid: string | null; /** What waits on the person (Attention.tsx): the team's own are listed first here. */ needs?: Attention[] }) {
  // The sidebar already keeps the team fresh (Sidebar.tsx useTeam): read it here, without a second timer.
  const t = useTeamNow();
  // Elapsed times count up; rows that change state slide to their place (presence.tsx).
  const now = useNow();
  const flip = useFlip<HTMLDivElement>();
  const flipRooms = useFlip<HTMLDivElement>();
  const focused = useFocusedAgent(t?.sid ?? "");
  // The person's own models, read once for the page, so a teammate on one is named by it (modelLabel) wherever it shows.
  useOwnModels(identity);
  const [adding, setAdding] = useState(false);
  const [menu, setMenu] = useState<{ m: TeammateView; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<TeammateView | null>(null);
  // Each tray folds by its name, with a chevron and a count, as Code's and Work's groups do, and stays as left (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
  const [shut, setShut] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(TRAYS_FOLDED) ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  const fold = (id: string) =>
    setShut((was) => {
      const next = was.includes(id) ? was.filter((x) => x !== id) : [...was, id];
      try {
        localStorage.setItem(TRAYS_FOLDED, JSON.stringify(next));
      } catch {
        /* a preference */
      }
      return next;
    });
  const trayHead = (id: string, name: string, count: number, title?: string) => (
    <button type="button" className="tm-side-fold" aria-expanded={!shut.includes(id)} onClick={() => fold(id)}>
      <ChevronRightIcon className="tm-chev size-3" data-open={!shut.includes(id) || undefined} aria-hidden />
      {name}
      {count > 0 && <span className="tm-count" {...(title ? { title } : {})}>{count}</span>}
    </button>
  );
  const [roomMenu, setRoomMenu] = useState<{ r: RoomView; x: number; y: number } | null>(null);
  // Right-click anywhere else in the Team tab: the Team room's row or the space around the rows.
  const [panelMenu, setPanelMenu] = useState<{ x: number; y: number; room?: boolean } | null>(null);
  // A room being made (true) or changed.
  const [rooming, setRooming] = useState<RoomView | true | null>(null);
  const [ask, confirmUI] = useConfirm();
  // What went wrong with something done from here, said under the header for a few seconds.
  const [failed, setFailed] = useState("");
  const [fine, setFine] = useState(false);
  const say = (m: string, ok = false) => {
    setFailed(m);
    setFine(ok);
    setTimeout(() => setFailed(""), 6000);
  };
  const fail = (e: unknown) => say((e as Error)?.message || "That didn't work. Try again.");
  /** After a restart, how it went: back, or still offline and why (2026-10-28 QA: no word at all). */
  const restarted = (m: TeammateView, now: Team | null) => {
    const n = now?.teammates.find((x) => x.id === m.id);
    if (!n) return;
    const why = n.problem ?? n.line.replace(/^Offline(?: · )?/, "");
    say(n.status === "offline" ? `${m.name} is still offline${why ? `: ${why}` : ""}.` : `${m.name} is back${n.tool === "friday" ? "" : ` on ${toolName(n.tool)}`}.`, n.status !== "offline");
  };
  useEffect(() => {
    const add = () => setAdding(true);
    addEventListener("friday:new-teammate", add);
    return () => removeEventListener("friday:new-teammate", add);
  }, []);
  // A room taken away from its own header: back to the Team room.
  useEffect(() => {
    const back = () => team && openTeammate(team, null, onOpen);
    addEventListener("friday:open-team", back);
    return () => removeEventListener("friday:open-team", back);
  }, [onOpen]);
  // Turning to the Team tab opens the Team room, unless the team (or one of its rooms) is already what is open. Not the tab
  // being remembered at launch: a link or a notification opening a Code session then kept its session.
  useEffect(() => {
    if (!t || !openOnShow) return;
    openOnShow = false;
    // Nobody on the crew yet: its first run (TeamHome, the Starter crew), not the room's "No teammates here yet" (Arun, 2026-10-29:
    // the verification's "Crew's first screen on a fresh server shows the room's No teammates here yet").
    if (!t.teammates.length) return void ((!activeSid || isTeamSid(activeSid)) && dispatchEvent(new Event("friday:team-home")));
    if (!activeSid || !isTeamSid(activeSid)) openTeammate(t, null, onOpen);
  }, [t?.sid]); // eslint-disable-line react-hooks/exhaustive-deps
  // Still being read: the trays' shape, quietly, rather than an empty sidebar that fills in a moment later (Arun, 2026-10-28: the
  // critique's "a loading skeleton for the team sidebar").
  if (!t)
    return loadFailed ? null : (
      <section className="tm-side" aria-busy="true" aria-label="Teammates, loading">
        {[2, 3].map((n, i) => (
          <div key={i} className="tm-tray tm-tray-skel" aria-hidden="true">
            <span className="tm-skel-head" />
            {Array.from({ length: n }, (_, j) => (
              <span key={j} className="tm-skel-row">
                <i />
                <b style={{ width: `${68 - j * 12}%` }} />
              </span>
            ))}
          </div>
        ))}
      </section>
    );
  const here = activeSid === t.sid;
  // Seen only while the Team room itself is in view: a teammate's own chat is the same session, and reading it cleared the room's
  // mark (Arun, 2026-10-28: the logic audit's "viewing a teammate's own chat must not clear the Team room's mark").
  const roomInView = here && focused === ALL;
  if (roomInView && t.news) markSeen(t.sid, t.news);
  const teamFresh = unseen(t.sid, t.news, roomInView);
  const teamBusy = workingInTeamRoom(t);
  const rooms = t.rooms ?? [];
  const roomItems = (r: RoomView): MenuItem[] => [
    { label: "Open", icon: "users", onSelect: () => openRoom(r, onOpen) },
    { label: "Edit…", icon: "pencil", onSelect: () => setRooming(r) },
    {
      // Said as the room's own header says it, "Remove room" (2026-10-27 audit: one said "Remove", the other "Remove room").
      label: "Remove room…",
      icon: "x",
      danger: true,
      onSelect: () =>
        ask({
          title: `Remove ${r.name}?`,
          body: "Its teammates stop working in it. They stay in your crew, with their folders and everything they made; the room's conversation is kept, out of sight.",
          action: "Remove room",
          danger: true,
          onConfirm: () =>
            void api(identity, `/api/teammates/rooms/${r.id}`, { method: "DELETE" })
              .then(() => refreshTeam(identity))
              // The room open was the one taken away: back to the Team room, as the room's own header does (RoomMenu), rather than
              // left inside a room that is gone (2026-10-27 audit).
              .then(() => activeSid === r.sid && (setTeamTab(true), dispatchEvent(new Event("friday:open-team"))))
              .catch(fail),
        }),
    },
  ];
  // In view: the Team room, or the one teammate whose chat is open.
  const inView = (lane: string | null) => here && (lane === null ? focused === ALL : focused === lane);
  const lead = t.lead ?? null;
  const items = (m: TeammateView): MenuItem[] => [
    { label: `Open ${m.name}'s chat`, icon: "chat", onSelect: () => openTeammate(t, m.lane, onOpen) },
    { label: "Edit…", icon: "pencil", onSelect: () => setEditing(m) },
    ...(t.rooms ?? [])
      .filter((r) => !r.lanes[m.id])
      .slice(0, 6)
      .map((r) => ({ label: `Add to ${r.name}`, icon: "users" as const, onSelect: () => void api(identity, `/api/teammates/rooms/${r.id}`, { method: "PATCH", body: JSON.stringify({ members: [...Object.keys(r.lanes), m.id] }), headers: { "Content-Type": "application/json" } }).then(() => refreshTeam(identity)).catch(fail) })),
    // Asked first, as Stop all asks: a turn cut short isn't got back (QA, 2026-10-28).
    ...(m.status === "working" || m.status === "waiting"
      ? [
          {
            label: "Stop what they're doing…",
            icon: "stop" as const,
            onSelect: () =>
              ask({
                title: `Stop ${m.name}?`,
                body: `Cut short now${m.line ? `: ${m.line.slice(0, 60)}` : ""}. What is queued for them stays queued, and they pick it up when you send something.`,
                action: "Stop",
                icon: "stop",
                onConfirm: () => void api(identity, `/api/teammates/${m.id}/stop`, { method: "POST" }).then(() => refreshTeam(identity)).catch(fail),
              }),
          },
        ]
      : []),
    ...(m.held ? [{ label: "Lift the hold", icon: "play" as const, onSelect: () => void api(identity, "/api/teammates/lift", { method: "POST", body: JSON.stringify({ id: m.id }), headers: { "Content-Type": "application/json" } }).then(() => refreshTeam(identity)).catch(fail) }] : []),
    ...(lead !== m.lane ? [{ label: "Make them the lead", icon: "crown" as const, onSelect: () => void api(identity, `/api/teammates/${m.id}/lead`, { method: "POST" }).then(() => refreshTeam(identity)).catch(fail) }] : []),
    { label: m.tool === "friday" ? "Restart them" : "Restart their tool", icon: "refresh", onSelect: () => void api(identity, `/api/teammates/${m.id}/reconnect`, { method: "POST" }).then(() => refreshTeam(identity)).then((now) => restarted(m, now)).catch(fail) },
    {
      label: "Remove…",
      icon: "trash",
      danger: true,
      onSelect: () =>
        ask({
          title: `Remove ${m.name}?`,
          body: `${m.name} leaves your crew and its coding tool stops. Its folder stays where it is, with everything it made: ${short(m.folder)}`,
          action: "Remove",
          danger: true,
          onConfirm: () =>
            void api(identity, `/api/teammates/${m.id}`, { method: "DELETE" })
              // Its chat was open: back to the Team room, not a lane that is gone; the last one gone, the Team tab's first run.
              .then(() => (focused === m.lane && focusAgent(t.sid, ALL), refreshTeam(identity)))
              .then((now) => void (now && !now.teammates.length && here && dispatchEvent(new Event("friday:team-home"))))
              .catch(fail),
        }),
    },
  ];
  return (
    <section
      className="tm-side"
      aria-label="Teammates"
      onContextMenu={(e) => {
        if (e.isDefaultPrevented()) return;
        e.preventDefault();
        setPanelMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {confirmUI}
      {failed && (
        <p className="tm-side-err" role={fine ? "status" : "alert"} data-ok={fine ? "true" : undefined}>
          {failed}
        </p>
      )}
      {/* What waits on the person, across the Team room and every room, a press from the chat it is in (OpenBot's home list). */}
      {needs.filter((it) => isTeamSid(it.sid)).length > 0 && (
        <div className="tm-tray tm-tray-needs">
          <div className="tm-side-head">{trayHead("needs", "Needs you", needs.filter((it) => isTeamSid(it.sid)).length)}</div>
          {!shut.includes("needs") && needs
            .filter((it) => isTeamSid(it.sid))
            .slice(0, 6)
            .map((it) => {
              const m = it.lane ? mateOn(it.lane) : null;
              const where = t.rooms?.find((r) => r.sid === it.sid);
              return (
                <button
                  key={`${it.sid}:${it.seq}`}
                  type="button"
                  className="tm-row tm-need"
                  onClick={() => (where ? openRoom(where, onOpen) : openTeammate(t, null, onOpen), it.lane && focusAgent(it.sid, it.lane))}
                >
                  {m ? <Face seed={m.look ?? m.name} size={24} status={it.kind === "stopped" ? "stopped" : "waiting"} /> : <PresenceRing state={it.kind === "stopped" ? "error" : "needs"} size={24}><span className="tm-face-none" /></PresenceRing>}
                  <span className="tm-text">
                    <span className="tm-name">
                      {m?.name ?? it.agent ?? "A teammate"}
                      {where ? <span className="tm-where-tag"> · {where.name}</span> : null}
                    </span>
                    {/* A short status in words, never a tool's raw error (Arun, 2026-10-29: "node:internal/modules/cjs/loader:1…" read
                        as a needs-you line); the error is on hover here and in full in the chat. */}
                    <span className={`tm-sub ${it.kind === "stopped" ? "s-stopped" : "s-waiting"}`} title={it.detail}>{isRawError(it.text) ? (it.kind === "stopped" ? stoppedLine(it.text) : "Needs you") : it.text}</span>
                  </span>
                  <span className="sr-only">Needs you</span>
                </button>
              );
            })}
        </div>
      )}
      {/* Trays: each group its own raised panel, its name and action inside it, its rows inset (Arun, 2026-10-27: "use this as a
          design inspo for like how our components should look like"). The Team room heads the rooms. */}
      <div className="tm-tray" ref={flipRooms}>
      <div className="tm-side-head">
        {trayHead("rooms", "Rooms", rooms.length + 1)}
        <button type="button" className="tm-add" onClick={() => setRooming(true)} aria-label="New room" title="New room: some of your teammates, on one thing">
          <PlusIcon className="size-3.5" />
        </button>
      </div>
      {!shut.includes("rooms") && <>
      <button
        type="button"
        className="tm-row tm-room"
        data-active={inView(null) ? "true" : undefined}
        onClick={() => openTeammate(t, null, onOpen)}
        onContextMenu={(e) => {
          e.preventDefault();
          setPanelMenu({ x: e.clientX, y: e.clientY, room: true });
        }}
      >
        <span className={`tm-room-mark${t.teammates.length ? "" : " empty"}`} aria-hidden="true">
          {/* No one in it yet: the room's own mark, not an empty slot (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL"). */}
          {t.teammates.length ? <RoomFaces seeds={byState(t.teammates, (m) => (m.status === "waiting" ? "needs" : m.status)).slice(0, 3).map((m) => m.look ?? m.name)} states={byState(t.teammates, (m) => (m.status === "waiting" ? "needs" : m.status)).slice(0, 3).map((m) => m.status)} size={28} off={t.teammates.every((m) => m.status === "offline")} /> : <UsersIcon className="size-4" />}
        </span>
        <span className="tm-text">
          <span className={teamFresh ? "tm-name tm-unread" : "tm-name"}>Crew room</span>
          {/* Its own: who works in the Team room itself, not in another room (workingInTeamRoom; 2026-10-27 audit). */}
          <span className="tm-sub">{!t.teammates.length ? "Where your teammates work together" : t.waiting ? `${t.waiting} need${t.waiting === 1 ? "s" : ""} you · ${t.teammates.length} in the crew` : `${teamBusy ? `${teamBusy} working · ` : ""}${t.teammates.length} in the crew`}</span>
        </span>
        {/* Its faces carry who works and who needs you; only "new since you looked" is a dot (2026-10-29 direction: the blue dot goes). */}
        {!t.waiting && !teamBusy && teamFresh ? <span className="tm-dot" data-state="new" aria-label="New since you looked" /> : null}
      </button>
      {byState(rooms, (r) => (r.waiting ? "needs" : r.working ? "working" : null)).map((r) => (
        <RoomRow key={r.id} r={r} t={t} here={activeSid === r.sid} onOpen={onOpen} onMenu={(x, y) => setRoomMenu({ r, x, y })} />
      ))}
      {/* A room to make: one quiet "+" row that shows on hover or focus (2026-10-29 direction §9.2), not a dashed card. */}
      {t.teammates.length > 1 && (
        <button type="button" className="tm-row tm-add-row" onClick={() => setRooming(true)} title="A few teammates on one thing, apart from the rest">
          <PlusIcon className="size-3.5" aria-hidden="true" />
          <span className="tm-name">New room</span>
        </button>
      )}
      </>}
      </div>
      <div className="tm-tray" ref={flip}>
      <div className="tm-side-head">
        {trayHead("mates", "Teammates", t.teammates.length, `Up to ${MAX} teammates`)}
        {t.teammates.length < MAX && (
          <button type="button" className="tm-add" onClick={() => setAdding(true)} aria-label="New teammate" title="New teammate">
            <PlusIcon className="size-3.5" />
          </button>
        )}
      </div>
      {!shut.includes("mates") && byState(t.teammates, (m) => (m.status === "waiting" ? "needs" : m.status)).map((m) => (
        <div key={m.id} className="tm-row-wrap" data-flip={m.id}>
        <button
          type="button"
          className="tm-row"
          data-active={inView(m.lane) ? "true" : undefined}
          onClick={() => openTeammate(t, m.lane, onOpen)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ m, x: e.clientX, y: e.clientY });
          }}
          // How it stands, in full: the line under its name is cut short once its queue's count is beside it (2026-10-27 audit).
          title={`${m.name} · ${statusLine(m)}${m.role ? ` · ${m.role.split("\n")[0]}` : ""}`}
        >
          <Face seed={m.look ?? m.name} size={24} status={m.status} lead={m.lane === t.lead} />
          <span className="tm-text">
            <span className="tm-name">{m.name}</span>
            {/* The live line (--ink-2), or its role in --ink-3 while it is idle (DIRECTION.md §8). */}
            <span className={`tm-sub s-${mateStatus(m).state}`}>{m.status === "idle" && m.role ? m.role.split("\n")[0] : statusLine(m)}</span>
          </span>
          {workingSinceOf(m) !== null && <span className="tm-elapsed">{elapsed(workingSinceOf(m)!, now)}</span>}
          {/* Counted across every chat it has, the Team room's and each room's, and said so: a chat shows its own lane's only
              (2026-10-27 audit: "4" beside Juno, 2 in her chat). */}
          {m.queued > 0 && m.status !== "idle" && <span className="tm-queued" title={queuedTitle(m)} aria-label={queuedTitle(m)}>{m.queued}</span>}
        </button>
        <RowMore label={`More for ${m.name}`} open={menu?.m.id === m.id} onOpen={(x, y) => setMenu({ m, x, y })} />
        </div>
      ))}
      {!t.teammates.length && !shut.includes("mates") && (
        <button type="button" className="tm-empty" onClick={() => setAdding(true)}>
          Add your first teammate: a name, a role and one of your coding tools.
        </button>
      )}
      </div>
      {menu && <ContextMenu at={menu} items={() => items(menu.m)} onClose={() => setMenu(null)} />}
      {roomMenu && <ContextMenu at={roomMenu} items={() => roomItems(roomMenu.r)} onClose={() => setRoomMenu(null)} />}
      {panelMenu && (
        <ContextMenu
          at={panelMenu}
          items={() => [
            ...(panelMenu.room ? [{ label: "Open the Crew room", icon: "users" as const, onSelect: () => openTeammate(t, null, onOpen) }] : []),
            { label: "New teammate…", icon: "plus", onSelect: () => setAdding(true) },
            ...(t.teammates.length ? [{ label: "New room…", icon: "users" as const, onSelect: () => setRooming(true) }] : []),
            // Asked first: it cuts short whatever each of them is doing (2026-10-27 audit: it ran at once).
            ...(panelMenu.room
              ? [
                  {
                    label: "Restart everyone's tools…",
                    icon: "refresh" as const,
                    onSelect: () =>
                      ask({
                        title: "Restart every teammate's tool?",
                        body: `Each of the ${t.teammates.length} teammates' coding tools starts again. Any turn under way is cut short; what is queued for them stays queued.`,
                        action: "Restart them",
                        onConfirm: () => void Promise.all(t.teammates.map((m) => api(identity, `/api/teammates/${m.id}/reconnect`, { method: "POST" }))).then(() => refreshTeam(identity)).catch(fail),
                      }),
                  },
                ]
              : []),
          ]}
          onClose={() => setPanelMenu(null)}
        />
      )}
      {rooming && <RoomDialog identity={identity} team={t} editing={rooming === true ? null : rooming} onClose={() => setRooming(null)} onMade={(r) => openRoom(r, onOpen)} />}
      {(adding || editing) && <TeammateDialog identity={identity} editing={editing} onClose={() => (setAdding(false), setEditing(null))} />}
    </section>
  );
}

/**
 * At the top of a room, beside its name: change it or take it away (Arun, 2026-10-27: "be able to delete the team room at the
 * top too"). The Team room, with the whole team, is where they all are and stays.
 */
export function RoomMenu({ identity, sid, notify }: { identity: Identity; sid: string; notify: (m: string) => void }) {
  const t = useTeamNow();
  const btn = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [ask, confirmUI] = useConfirm();
  const r = t?.rooms?.find((x) => x.sid === sid);
  if (!t || !r) return null;
  const remove = () =>
    ask({
      title: `Remove ${r.name}?`,
      body: "Its teammates stop working in it. They stay in your crew, with their folders and everything they made; the room's conversation is kept, out of sight.",
      action: "Remove room",
      danger: true,
      onConfirm: () =>
        void api(identity, `/api/teammates/rooms/${r.id}`, { method: "DELETE" })
          .then(() => refreshTeam(identity))
          // Back to the Team room, from whichever tab: turning to the Team tab opens it there (openOnShow).
          .then(() => (notify(`${r.name} is gone. Its teammates are back to the Crew room.`), setTeamTab(true), dispatchEvent(new Event("friday:open-team"))))
          .catch((e: Error) => notify(e.message)),
    });
  return (
    <>
      {confirmUI}
      <button
        ref={btn}
        type="button"
        className="panel-tab icon tm-room-menu"
        aria-label={`${r.name} settings`}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        title={`${r.name}: edit or remove the room`}
        onClick={() => {
          const b = btn.current!.getBoundingClientRect();
          setMenu({ x: b.right - 200, y: b.bottom + 6 });
        }}
      >
        <Settings2Icon className="size-[17px]" />
      </button>
      {menu && (
        <ContextMenu
          at={menu}
          items={() => [
            { label: "Edit room…", icon: "pencil", onSelect: () => setEditing(true) },
            { label: "Remove room…", icon: "trash", danger: true, onSelect: remove },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
      {editing && <RoomDialog identity={identity} team={t} editing={r} onClose={() => setEditing(false)} onMade={() => {}} />}
    </>
  );
}

/** A room in the sidebar: its members' faces, its name, who is working or needs you; marked while it, or a chat in it, is in view. */
function RoomRow({ r, t, here, onOpen, onMenu }: { r: RoomView; t: Team; here: boolean; onOpen: (r: RecentSession) => void; onMenu: (x: number, y: number) => void }) {
  if (here && r.news) markSeen(r.sid, r.news);
  const fresh = unseen(r.sid, r.news, here);
  const who = Object.keys(r.lanes).flatMap((id) => t.teammates.filter((m) => m.id === id));
  return (
    <div className="tm-row-wrap" data-flip={r.id}>
    <button
      type="button"
      className="tm-row tm-room"
      // Open in any of its chats, the room's own or one of its teammates': the sidebar shows where you are (2026-10-27 audit).
      data-active={here ? "true" : undefined}
      onClick={() => openRoom(r, onOpen)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <span className="tm-room-mark" aria-hidden="true">
        <RoomFaces seeds={who.slice(0, 3).map((m) => m.look ?? m.name)} states={who.slice(0, 3).map((m) => (r.doing && (r.lanes[m.id] ?? "") in r.doing ? "working" : m.status === "working" ? "idle" : m.status))} size={28} off={who.length > 0 && who.every((m) => m.status === "offline")} />
      </span>
      <span className="tm-text">
        <span className={fresh ? "tm-name tm-unread" : "tm-name"}>{r.name}</span>
        <span className="tm-sub">{r.waiting ? `${r.waiting} need${r.waiting === 1 ? "s" : ""} you` : r.working ? `${r.working} working · ${who.map((m) => m.name).join(", ")}` : who.map((m) => m.name).join(", ") || "Nobody in it yet"}</span>
      </span>
      {!(r.waiting > 0 || r.working > 0) && fresh ? <span className="tm-dot" data-state="new" aria-label="New since you looked" /> : null}
    </button>
    <RowMore label={`More for ${r.name}`} open={false} onOpen={onMenu} />
    </div>
  );
}

/**
 * A row's "…", on hover or focus, and always on a touch screen: what its right-click menu offers (edit, make the lead, stop,
 * remove), where people can find it (2026-10-27 audit: a teammate could only be edited from a right-click nobody knew about).
 */
function RowMore({ label, open, onOpen }: { label: string; open: boolean; onOpen: (x: number, y: number) => void }) {
  return (
    <button
      type="button"
      className="tm-row-more"
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={(e) => {
        const b = e.currentTarget.getBoundingClientRect();
        onOpen(b.left, b.bottom + 4);
      }}
    >
      <EllipsisIcon className="size-4" />
    </button>
  );
}

/**
 * Beside a team chat's name, who is in it: each teammate's face, the lead's with its core solid, and how it stands; a press opens its
 * chat there. A room's purpose is on hover.
 */
export function TeamFaces({ sid, lead }: { sid: string; lead: string | null }) {
  useTeamVersion();
  const focused = useFocusedAgent(sid);
  const mates = matesIn(sid);
  const purpose = team?.rooms?.find((r) => r.sid === sid)?.purpose;
  if (!mates.length) return null;
  // Each face carries its own ring; how many are at it is said once after them, in words (DIRECTION.md §8).
  const working = mates.filter(({ lane, m }) => statusIn(sid, lane, m) === "working").length;
  return (
    <span className="tm-faces" role="group" aria-label="Who is in it" title={purpose || undefined}>
      {mates.map(({ lane, m }) => {
        // How it stands in this chat, not across every room it is in (statusIn).
        const status = statusIn(sid, lane, m);
        const line = statusLineIn(sid, lane, m);
        return (
          <button key={lane} type="button" className="tm-faces-one" data-on={focused === lane ? "true" : undefined} title={`${m.name}${lane === lead ? " · leads" : ""} · ${line}`} aria-label={`${m.name}${lane === lead ? ", leads" : ""}: ${line}`} onClick={() => focusAgent(sid, focused === lane ? ALL : lane)}>
            <Face seed={m.look ?? m.name} size={24} status={status} lead={lane === lead} />
          </button>
        );
      })}
      {working > 0 && <span className="tm-faces-n">{working} working</span>}
    </span>
  );
}

/** What of each team chat the person has seen: its news seq when they last had it open (on this computer). */
const SEEN = "friday.team.seen";
const seenAll = (): Record<string, number> => {
  try {
    return JSON.parse(localStorage.getItem(SEEN) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
};
const markSeen = (sid: string, seq: number) => {
  const all = seenAll();
  if ((all[sid] ?? 0) >= seq) return;
  try {
    localStorage.setItem(SEEN, JSON.stringify({ ...all, [sid]: seq }));
  } catch {
    // A mark: losing it shows a dot again, nothing more.
  }
};
/**
 * The marks of team chats that are gone (a room taken away) taken out, so the record holds only chats there are (2026-10-27
 * audit: it kept every removed room's).
 */
export function pruneSeen(live: readonly string[]): void {
  const all = seenAll();
  const keep = Object.fromEntries(Object.entries(all).filter(([sid]) => live.includes(sid)));
  if (Object.keys(keep).length === Object.keys(all).length) return;
  try {
    localStorage.setItem(SEEN, JSON.stringify(keep));
  } catch {
    // A mark: losing it shows a dot again, nothing more.
  }
}

/** Whether a team chat has news the person hasn't seen; never the one open now, which is being seen. */
const unseen = (sid: string, news: number | undefined, open: boolean) => !open && !!news && news > (seenAll()[sid] ?? 0);

/** Opens a room: its every-teammate view. */
export function openRoom(r: RoomView, onOpen: (r: RecentSession) => void): void {
  focusAgent(r.sid, ALL);
  onOpen({ sid: r.sid, title: r.name, invite: r.invite, role: "owner", openedAt: Date.now() });
}


/** Under the room dialog's teammates: who will lead it, or what is missing once a save was tried. */
function leadLine(who: string[], t: Team, editing: RoomView | null, tried: boolean): string {
  if (!who.length) return tried ? "Pick at least one teammate for the room." : "Pick who works in it.";
  // A room keeps its lead while the lead stays in it (app.ts leadRoom); otherwise the first picked leads.
  const keeps = editing?.lead && Object.entries(editing.lanes).find(([id, lane]) => lane === editing.lead && who.includes(id))?.[0];
  const lead = t.teammates.find((m) => m.id === (keeps || who[0]))?.name;
  return `${who.length} picked. ${lead} leads: what you say there without an @name goes to ${lead}.`;
}

/** A new room, or one changed: its name and who is in it, picked from the team (Arun, 2026-10-27: "multiple Team rooms"). */
export function RoomDialog({ identity, team: t, editing, onClose, onMade }: { identity: Identity; team: Team; editing: RoomView | null; onClose: () => void; onMade: (r: RoomView) => void }) {
  const [name, setName] = useState(editing?.name ?? "");
  const [who, setWho] = useState<string[]>(editing ? Object.keys(editing.lanes) : []);
  const [purpose, setPurpose] = useState(editing?.purpose ?? "");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // What is wrong, on its own field, with the focus taken there (2026-10-27 audit: errors sat at the foot, the focus stayed on
  // the button, and "Pick at least one teammate" read as a hint).
  const [nameErr, setNameErr] = useState("");
  const nameField = useRef<HTMLInputElement | null>(null);
  const pickBox = useRef<HTMLDivElement | null>(null);
  const flip = (id: string) => setWho((w) => (w.includes(id) ? w.filter((x) => x !== id) : [...w, id]));
  const save = async (e: FormEvent) => {
    e.preventDefault();
    // Said once it is tried, not before anything is picked: a greyed button gave no reason.
    setTried(true);
    if (!name.trim()) return setNameErr("Give the room a name."), nameField.current?.focus();
    // Two rooms of one name read as one in the sidebar and the @ lists (Arun, 2026-10-28: the critique's "room dialog validation").
    const same = (t.rooms ?? []).find((r) => r.id !== editing?.id && r.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (same || name.trim().toLowerCase() === "crew room") return setNameErr(`There's already a room called ${same?.name ?? "Crew room"}. Give this one another name.`), nameField.current?.focus();
    if (!who.length) return setErr(""), pickBox.current?.querySelector<HTMLElement>("button")?.focus();
    setBusy(true);
    setErr("");
    try {
      const r = await api<Team & { room?: string }>(identity, editing ? `/api/teammates/rooms/${editing.id}` : "/api/teammates/rooms", { method: editing ? "PATCH" : "POST", body: JSON.stringify({ name, members: who, purpose }), headers: { "Content-Type": "application/json" } });
      await refreshTeam(identity);
      onClose();
      const made = r.rooms?.find((x) => x.id === r.room);
      if (made) onMade(made);
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="tm-dialog max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain sm:max-w-[500px]">
        <form onSubmit={(e) => void save(e)} className="tm-form">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.name}` : "New room"}</DialogTitle>
            <DialogDescription>{editing ? "Someone taken out stops working here; someone brought in starts with a conversation of its own for this room." : "Some of your teammates, working together on one thing. Each has a conversation of its own here, with its folder and notes the same as everywhere."}</DialogDescription>
          </DialogHeader>
          <label className="tm-field">
            <span>Name</span>
            <Input ref={nameField} autoFocus value={name} maxLength={60} placeholder="A name for it" aria-invalid={!!nameErr} aria-describedby={nameErr ? "tm-room-name-err" : undefined} onChange={(e) => (setName(e.target.value), setNameErr(""))} />
            {nameErr && (
              <span id="tm-room-name-err" role="alert" className="tm-err">
                {nameErr}
              </span>
            )}
          </label>
          <label className="tm-field">
            <span>What it's for</span>
            <Textarea value={purpose} maxLength={2000} rows={2} placeholder="Optional. Told to its teammates with every message here." onChange={(e) => setPurpose(e.target.value)} />
          </label>
          <div className="tm-field">
            <span>Who's in it</span>
            <div ref={pickBox} className="tm-pick" role="group" aria-label="Teammates in the room" aria-invalid={tried && !who.length} aria-describedby="tm-room-who">
              {t.teammates.map((m) => {
                const on = who.includes(m.id);
                return (
                  <button key={m.id} type="button" className="tm-pick-row" aria-pressed={on} onClick={() => flip(m.id)}>
                    <Face seed={m.look ?? m.name} size={28} />
                    <span className="tm-text">
                      <span className="tm-name">{m.name}</span>
                      <span className="tm-sub">{m.role ? m.role.split("\n")[0] : `${toolName(m.tool)} · ${modelLabel(m.tool, m.model)}`}</span>
                    </span>
                    <span className="tm-pick-check" aria-hidden="true">
                      {on && <CheckIcon className="size-3.5" />}
                    </span>
                  </button>
                );
              })}
              {!t.teammates.length && <p className="tm-sub">Add a teammate first.</p>}
            </div>
            {tried && !who.length ? (
              <span id="tm-room-who" role="alert" className="tm-err">
                {leadLine(who, t, editing, tried)}
              </span>
            ) : (
              <small id="tm-room-who">{leadLine(who, t, editing, tried)}</small>
            )}
          </div>
          {err && (
            <p role="alert" className="tm-err">
              {err}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy} onClick={() => setTried(true)}>
              {busy ? "Saving…" : editing ? "Save" : "Make room"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The tool and model picker (AgentModelPicker) opens in a layer of its own, outside the dialog: a press or a focus there is
 * the picker's, not one that closes the dialog (Arun, 2026-10-27: "cannot select").
 */
const keepForPicker = (e: Event) => {
  if ((e.target as Element | null)?.closest?.(".amp")) e.preventDefault();
};

/** New teammate, or one changed: its robot and name, its role, the coding tool it runs on, and where it works. */
export function TeammateDialog({ identity, editing, onClose, inline }: { identity: Identity; editing: TeammateView | null; onClose: () => void; /** Drawn in place, as a teammate's Settings tab (TeammatePage.tsx), not as a dialog. */ inline?: boolean }) {
  const installed = installedOn(identity);
  const tools = useMemo(() => {
    const all = ENGINE_TOOLS.filter((x) => !installed || installed(x));
    return all.length ? all : [...ENGINE_TOOLS];
  }, [installed]);
  const [name, setName] = useState(editing?.name ?? "");
  /** The name a role template last filled in: the next template may change it, a typed one it leaves. */
  const templateName = useRef<string | null>(null);
  const [role, setRole] = useState(editing?.role ?? "");
  const [tool, setTool] = useState<MateTool>(editing?.tool ?? (tools.includes("claude") ? "claude" : tools[0]!));
  // Smart routing unless picked otherwise (routing.ts): each message on the model most likely to get it right for the least.
  const [model, setModel] = useState(editing ? (editing.model ?? "") : tool !== "friday" && canRoute(tool) ? "auto" : "");
  const [effort, setEffort] = useState<EngineEffort | null>(editing?.effort ?? null);
  // What it carries on with when its own tool runs out of usage: picked, or the other of Claude Code and Codex.
  const [backup, setBackup] = useState<EngineTool | "">(editing?.backup ?? "");
  // What it does by itself, on a schedule (teammates.ts CheckIn), in this computer's time zone.
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [checkins, setCheckins] = useState<CheckIn[]>(editing?.checkins ?? []);
  // How far its tool may go (Arun, 2026-10-28: the critique's "Access, visible"): absent on an older record is full.
  const [mode, setMode] = useState<EngineMode>(editing?.mode ?? "full");
  const [saved, setSaved] = useState(false);
  const [later, setLater] = useState("");
  const putCheckIn = (i: number, c: Partial<CheckIn>) => (setCheckErr(""), setCheckins((all) => all.map((x, j) => (j === i ? { ...x, ...c } : x))));
  const pickTool = (x: MateTool) => {
    setTool(x);
    // On its own model there is no level, backup or tool's model to keep: the picker gives the model (TeammatePicker).
    if (x === "friday") return setEffort(null);
    // Its backup can't be the tool it now runs on: back to automatic.
    if (backup === x) setBackup("");
    // A level is its tool's: another tool that doesn't take it starts on Auto.
    if (effort && !(EFFORT_LEVELS[x] ?? []).includes(effort)) setEffort(null);
    // A model is its tool's own: another tool starts on routing, or its own default.
    if (!ENGINE_MODEL_INFO[x].some((m) => m.id === model)) setModel(canRoute(x) ? "auto" : "");
  };
  const [folder, setFolder] = useState(editing?.folder ?? "");
  const [projects, setProjects] = useState<string[]>(editing ? foldersOf(editing) : []);
  const [project, setProject] = useState("");
  const addProject = (raw = project) => {
    const add = raw.split(",").map((d) => d.trim()).filter((d) => d && !projects.includes(d));
    if (add.length) setProjects([...projects, ...new Set(add)]);
    setProject("");
  };
  // Its robot follows its name as it is typed, until one is shuffled to; a teammate being edited keeps the one it has.
  const [shuffled, setShuffled] = useState<string | null>(editing ? (editing.look ?? editing.name) : null);
  // In a colour of its own: none of the rest of the team's, while one is free (teammate-block.tsx distinctLook).
  const others = (team?.teammates ?? []).filter((m) => m.id !== editing?.id).map((m) => m.look ?? m.name);
  const look = shuffled ?? distinctLook(name.trim() || "Friday", others);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // What is wrong with the name, said on its field and the field focused, not at the dialog's foot below the fold (2026-10-27
  // audit: a name already taken was said at the bottom, far from Name). The same for a check-in left with nothing to ask.
  const [nameErr, setNameErr] = useState("");
  const [checkErr, setCheckErr] = useState("");
  // Its own ids: the Edit dialog over a teammate's Settings tab made a second form, and both had #tm-id-name, so the dialog's Name
  // label focused the field behind it (QA, 2026-10-28).
  const uid = useId();
  // What the form holds, to tell a change from none: Settings' "Save changes" was pressable with nothing changed (QA, 2026-10-28).
  const snap = JSON.stringify([name, role, tool, model, effort, backup, checkins, look, mode, projects, project.trim(), folder]);
  const firstSnap = useRef(snap);
  const changed = snap !== firstSnap.current;
  const keptName = name.replace(/[^\p{L}\p{N} ._'-]+/gu, "").replace(/\s+/g, " ").trim();
  // Which check-in it is about: the error sits under that one, and it is focused and brought clear of the dialog's foot (QA,
  // 2026-10-28: the error was under the list, off screen, the field half under the footer, the focus left on "Add teammate").
  const [checkAt, setCheckAt] = useState(-1);
  const checkList = useRef<HTMLFieldSetElement | null>(null);
  const [checkFocus, setCheckFocus] = useState(0);
  const showCheckErr = (at: number, said: string) => {
    setCheckErr(said);
    setCheckAt(at);
    setCheckFocus((n) => n + 1);
  };
  // After the press that found it has finished with the focus (a click leaves it on the button it pressed).
  useEffect(() => {
    if (!checkFocus) return;
    const t = setTimeout(() => {
      const field = checkList.current?.querySelectorAll<HTMLInputElement>('.tm-checkin input[aria-label="What it is asked"]')[checkAt];
      field?.scrollIntoView({ block: "center" });
      field?.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(t);
  }, [checkFocus]); // eslint-disable-line react-hooks/exhaustive-deps
  const nameField = useRef<HTMLInputElement | null>(null);
  // A project taken off, for a moment, to put back (2026-10-27 audit: its × took it away at once with no way back).
  const [tookOff, setTookOff] = useState<{ dir: string; at: number } | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    const clash = (team?.teammates ?? []).find((m) => m.id !== editing?.id && m.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (clash) {
      setNameErr(`${clash.name} is already in your crew. Give this one another name.`);
      nameField.current?.focus();
      return;
    }
    const empty = checkins.findIndex((c) => !c.text.trim());
    if (empty >= 0) return showCheckErr(empty, "Say what this check-in asks, or take it away.");
    // The same ask at the same time twice is one ask said twice (QA, 2026-10-28: six identical ones were kept).
    const key = (c: CheckIn) => `${c.text.trim().toLowerCase()}|${c.every}|${c.every === "hourly" ? "" : c.at}|${c.every === "weekly" ? c.days.join(",") : ""}`;
    const twice = checkins.findIndex((c, i) => checkins.findIndex((x) => key(x) === key(c)) < i);
    if (twice >= 0) return showCheckErr(twice, "This check-in is the same as one above it. Change it, or take it away.");
    const noDay = checkins.findIndex((c) => c.every === "weekly" && !c.days.length);
    if (noDay >= 0) return showCheckErr(noDay, "Pick at least one day for this weekly check-in.");
    if (tool === "friday" && !model) {
      setErr("Set up a model of your own first, in Settings › Your models, then pick it under Runs on.");
      return;
    }
    setBusy(true);
    try {
      // What is still in the field counts too: typed, and saved without pressing Enter.
      const all = project.trim() && !projects.includes(project.trim()) ? [...projects, project.trim()] : projects;
      const body = { name, role, tool, model, effort: effort ?? "", backup, checkins, look, mode, projects: all, ...(editing ? {} : folder.trim() ? { folder } : {}) };
      const r = await api<{ restartLater?: string[] }>(identity, editing ? `/api/teammates/${editing.id}` : "/api/teammates", { method: editing ? "PATCH" : "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
      await refreshTeam(identity);
      // Busy somewhere: the change waits for that run's end there, and says so rather than cutting it short.
      const when = r.restartLater?.length ? `It applies in ${listNames(r.restartLater)} once their turn there ends.` : "";
      setLater(when);
      firstSnap.current = snap;
      if (inline) setSaved(true);
      else {
        // The dialog goes as it saves, so what waits for a turn to end is said after it, as the Settings tab says it (QA, 2026-10-28).
        if (editing && when) dispatchEvent(new CustomEvent("friday:notice", { detail: `${name.trim() || editing.name} is saved. ${when}` }));
        onClose();
      }
    } catch (x) {
      const message = (x as Error).message;
      // The server's word on the name (taken, too long) belongs on the name.
      if (/\bname\b/i.test(message)) {
        setNameErr(message);
        nameField.current?.focus();
      } else setErr(message);
    } finally {
      setBusy(false);
    }
  };
  const toolChanged = !!editing && editing.tool !== tool;
  // A role to start from, for a first teammate or a fifth: its standing instructions, a check-in and how far it may go (Arun,
  // 2026-10-28: the critique's "role templates in the New teammate dialog").
  const useTemplate = (k: keyof typeof ROLES) => {
    const r = ROLES[k];
    setRole(r.role);
    setMode(r.mode);
    setCheckins(r.checkin ? [{ id: `c${Date.now().toString(36)}`, text: r.checkin, every: r.every ?? "weekdays", at: "09:00", days: r.days ?? [], tz: zone }] : []);
    // A name a template gave follows the next template too; one the person typed stays (2026-10-28 QA: QA then Lead kept "Vera").
    if (!name.trim() || name === templateName.current) setName((templateName.current = freeName(r.names)));
  };
  /** Access as one Tab stop, its choices moved between with the arrow keys, as radios are (2026-10-28 QA). */
  const MODES = ["plan", "edits", "full"] as const;
  const accessKey = (e: ReactKeyboardEvent<HTMLButtonElement>, k: (typeof MODES)[number]) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = MODES[(MODES.indexOf(k) + step + MODES.length) % MODES.length]!;
    setMode(next);
    setSaved(false);
    (e.currentTarget.parentElement?.querySelector(`[data-mode="${next}"]`) as HTMLElement | null)?.focus();
  };
  const form = (
        <form onSubmit={(e) => void save(e)} className={inline ? "tm-form tm-form-inline" : "tm-form"} onChange={() => setSaved(false)}>
          {!inline && (
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.name}` : "New teammate"}</DialogTitle>
            <DialogDescription>{editing ? "Changes apply from their next turn." : "They work on your computer with your own coding tool or model, keep a folder of their own, and remember their conversation."}</DialogDescription>
          </DialogHeader>
          )}
          {!editing && (
            <div className="tm-templates" role="group" aria-label="Start from a role">
              <span className="tm-templates-label">Start from</span>
              {(Object.keys(ROLES) as (keyof typeof ROLES)[]).map((k) => (
                <button key={k} type="button" className="tm-template" aria-pressed={role === ROLES[k].role} onClick={() => useTemplate(k)}>
                  {k}
                </button>
              ))}
            </div>
          )}
          {/* Who it is, as a tray: its block on a tile of its own, its tool in the tile's corner, and its name beside it with the
              shuffle on the name's line, so nothing sits over the block (Arun, 2026-10-27: "design this better and better space"). */}
          <div className="tm-id">
            <div className="tm-id-face">
              <Robot seed={look} tool={markOf(tool)} size={58} status="idle" />
            </div>
            <div className="tm-field tm-id-name">
              <div className="tm-id-label">
                <label htmlFor={`${uid}-name`}>Name</label>
                <button type="button" className="tm-shuffle" onClick={() => setShuffled(distinctLook(`${name.trim() || "Friday"}-${Math.random().toString(36).slice(2, 7)}`, [...others, look]))} title="Another look for it">
                  <ShuffleIcon className="size-3.5" />
                  Shuffle look
                </button>
              </div>
              {/* Not focused on a teammate's Settings tab, where it scrolled their header away (QA, 2026-10-28). */}
              <Input ref={nameField} id={`${uid}-name`} autoFocus={!inline} value={name} maxLength={40} placeholder="A name, like Rio" aria-invalid={!!nameErr} aria-describedby={nameErr ? `${uid}-name-err` : keptName !== name.trim() ? `${uid}-name-kept` : undefined} onChange={(e) => (setName(e.target.value), setNameErr(""))} />
              {nameErr ? (
                <p id={`${uid}-name-err`} role="alert" className="tm-err">
                  {nameErr}
                </p>
              ) : (
                // What the server keeps of a name, said as it is typed: an emoji went without a word ("Zoë 🚀 测试" saved as "Zoë
                // 测试"; QA, 2026-10-28).
                keptName !== name.trim() && (
                  <p id={`${uid}-name-kept`} className="tm-name-kept" role="status">
                    A name keeps letters, numbers, spaces and . _ ' - only: it's saved as “{keptName || "Teammate"}”.
                  </p>
                )
              )}
            </div>
          </div>
          <label className="tm-field">
            <span>Role</span>
            {/* An example, plainly one, naming nobody on the team (2026-10-27 audit: it read as filled in, and named Kit). */}
            <Textarea value={role} maxLength={4000} rows={3} placeholder="e.g. Writes our release notes and keeps the changelog" onChange={(e) => setRole(e.target.value)} />
            <small>Their standing instructions, read with every turn.</small>
          </label>
          <div className="tm-field">
            <span>Runs on</span>
            {/* Its own class: "tm-runs" is the activity list's tray, and drew a box around the picker (Arun, 2026-10-28: "look for
                like the little details and designs too like that agent box thing"). */}
            <div className="tm-runs-on">
              <TeammatePicker identity={identity} tool={tool} model={model} effort={effort} onEffort={setEffort} onChange={(t, m) => (pickTool(t), setModel(m))} />
            </div>
            {/* On one of the person's own models: Friday Code runs it, with no tool's model, effort or backup to set. */}
            {tool === "friday" ? (
              <small>
                {model ? (
                  `Friday Code runs it on ${modelLabel(tool, model)}, on your key or your computer. No usage limits of a coding tool's, so no backup: if the model's server stops answering, it says so.`
                ) : (
                  // A press away, not a path to find (2026-10-28 QA).
                  <>
                    Pick one of your models above, or{" "}
                    <button type="button" className="link-btn" onClick={() => dispatchEvent(new CustomEvent("friday:settings", { detail: { tab: "own-models" } }))}>
                      add one in Settings
                    </button>
                    .
                  </>
                )}
              </small>
            ) : (
            /* Advanced (Arun, 2026-10-27: the OpenBot gap "an Advanced model/effort section in the dialog"): what it runs on, said
                plainly beside the picker, folded until wanted; its line says what is set. */
            <details className="tm-advanced">
              <summary>
                <span>If {ENGINE_NAMES[tool]} runs out of usage</span>
                <span className="tm-advanced-now">{ENGINE_NAMES[backup || (tool === "claude" ? "codex" : "claude")]} takes over</span>
              </summary>
              {/* The model and effort are set in the picker above, once (Arun, 2026-10-28: the critique's "remove the duplicate model
                  picker from Advanced"). */}
              <div className="tm-advanced-body">
                <label className="tm-row-field">
                  <span className="tm-row-label">Backup</span>
                  <span className="tm-row-input">
                    <select className="tm-select" value={backup === (tool === "claude" ? "codex" : "claude") ? "" : backup} onChange={(e) => setBackup(e.target.value as EngineTool | "")}>
                      <option value="">{ENGINE_NAMES[tool === "claude" ? "codex" : "claude"]} (automatic)</option>
                      {/* Not again under its own name: "Codex (automatic)" and "Codex" were two choices of one thing (QA, 2026-10-28). */}
                      {tools
                        .filter((x) => x !== tool && x !== (tool === "claude" ? "codex" : "claude"))
                        .map((x) => (
                          <option key={x} value={x}>
                            {ENGINE_NAMES[x]}
                          </option>
                        ))}
                    </select>
                    <small>Out of usage, they carry on with this, and go back to {ENGINE_NAMES[tool]} when its limit lifts.</small>
                  </span>
                </label>
              </div>
            </details>
            )}
            {toolChanged && (
              <p className="tm-note" role="status">
                <TriangleAlertIcon className="size-3.5" />A new {tool === "friday" || editing!.tool === "friday" ? "model" : "tool"} starts a new conversation: it won't remember what it said on {toolName(editing!.tool)}.
              </p>
            )}
          </div>
          <fieldset className="tm-where tm-access">
            <legend>Access</legend>
            <div className="tm-access-opts" role="radiogroup" aria-label="Access">
              {MODES.map((k) => (
                <button key={k} type="button" role="radio" aria-checked={mode === k} tabIndex={mode === k ? 0 : -1} className="tm-access-opt" data-mode={k} onClick={() => (setMode(k), setSaved(false))} onKeyDown={(e) => accessKey(e, k)}>
                  <span className="tm-access-icon" aria-hidden="true">{k === "plan" ? <EyeIcon /> : k === "edits" ? <HandIcon /> : <ZapIcon />}</span>
                  <span className="tm-access-text">
                    <span className="tm-access-name">{ACCESS[k].label}</span>
                    <span className="tm-access-blurb">{ACCESS[k].blurb}</span>
                  </span>
                  <span className="tm-access-radio" aria-hidden="true" />
                </button>
              ))}
            </div>
            <small className="tm-checkin-note">Applies in {[editing?.folder ? short(editing.folder) : "their own folder", ...projects.map(short)].join(", ")}.</small>
          </fieldset>
          <fieldset className="tm-where tm-checkins" ref={checkList}>
            <legend>Check-ins</legend>
            {checkins.map((c, i) => (
              <div key={c.id} className="tm-checkin">
                <Input value={c.text} maxLength={2000} placeholder="What to ask it" aria-invalid={!!checkErr && checkAt === i} aria-describedby={checkErr && checkAt === i ? `${uid}-checkin-err` : undefined} onChange={(e) => (putCheckIn(i, { text: e.target.value }), setCheckErr(""))} aria-label="What it is asked" />
                <div className="tm-checkin-when">
                  <select className="tm-select" value={c.every} aria-label="How often" onChange={(e) => putCheckIn(i, { every: e.target.value as CheckIn["every"] })}>
                    <option value="hourly">Every hour</option>
                    <option value="daily">Every day</option>
                    <option value="weekdays">Every weekday</option>
                    <option value="weekly">Every week</option>
                  </select>
                  {c.every === "weekly" && (
                    <span className="tm-days" role="group" aria-label="Days">
                      {["S", "M", "T", "W", "T", "F", "S"].map((d, n) => (
                        <button key={n} type="button" aria-pressed={c.days.includes(n)} onClick={() => putCheckIn(i, { days: c.days.includes(n) ? c.days.filter((x) => x !== n) : [...c.days, n].sort() })}>
                          {d}
                        </button>
                      ))}
                    </span>
                  )}
                  {c.every !== "hourly" && <Input type="time" className="tm-time" value={c.at} aria-label="At" onChange={(e) => putCheckIn(i, { at: e.target.value || "09:00" })} />}
                  <button type="button" className="tm-checkin-x" aria-label="Remove this check-in" title="Remove" onClick={() => (setCheckins((all) => all.filter((_, j) => j !== i)), setCheckErr(""))}>
                    <XIcon className="size-3.5" />
                  </button>
                </div>
                {checkErr && checkAt === i && (
                  <p role="alert" id={`${uid}-checkin-err`} className="tm-err">
                    {checkErr}
                  </p>
                )}
              </div>
            ))}
            {checkins.length < 6 && (
              // A real first ask, there to keep or change: the example used to be a placeholder, which looked filled in and was
              // dropped on save as empty (2026-10-27 audit).
              <button type="button" className="tm-chip add tm-checkin-add" onClick={() => setCheckins((all) => [...all, { id: `c${Date.now().toString(36)}`, text: "Stand-up: what you did, what's next, what blocks you", every: "weekdays", at: "09:00", days: [], tz: zone }])}>
                <PlusIcon className="size-3" />
                Add a check-in
              </button>
            )}
            <small className="tm-checkin-note">Asked in the Crew room on schedule. With nothing new, they stay quiet.</small>
          </fieldset>
          <fieldset className="tm-where">
            <legend>Where they work</legend>
            <label className="tm-row-field">
              <span className="tm-row-label">Folder</span>
              <span className="tm-row-input">
                {editing ? (
                  <span className="tm-path" title={editing.folder}>
                    {short(editing.folder)}
                  </span>
                ) : (
                  <Input value={folder} placeholder={`~/Friday/teammates/${name.trim() || "Name"}`} onChange={(e) => setFolder(e.target.value)} />
                )}
                <small>{editing ? "Where they keep their notes and what they make." : "Their own, made for them. Leave it for the default."}</small>
              </span>
            </label>
            <label className="tm-row-field">
              <span className="tm-row-label">Projects</span>
              <span className="tm-row-input">
                {projects.length > 0 && (
                  <span className="tm-chips">
                    {projects.map((d) => (
                      <span key={d} className="tm-chip" title={d}>
                        <FolderGit2Icon className="size-3" />
                        {short(d)}
                        <button type="button" aria-label={`Take ${short(d)} away`} onClick={() => (setProjects(projects.filter((x) => x !== d)), setTookOff({ dir: d, at: projects.indexOf(d) }))}>
                          <XIcon className="size-3" />
                        </button>
                      </span>
                    ))}
                  </span>
                )}
                <Input
                  value={project}
                  placeholder="~/code/site, then Enter"
                  aria-label="Add a folder or repo"
                  onChange={(e) => (e.target.value.includes(",") ? addProject(e.target.value) : setProject(e.target.value))}
                  onBlur={() => project.trim() && addProject()}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    addProject();
                  }}
                />
                {tookOff && !projects.includes(tookOff.dir) && (
                  <span className="tm-undo" role="status">
                    Took {short(tookOff.dir)} away.{" "}
                    <button type="button" className="tm-undo-btn" onClick={() => (setProjects((p) => [...p.slice(0, tookOff.at), tookOff.dir, ...p.slice(tookOff.at)]), setTookOff(null))}>
                      Undo
                    </button>
                  </span>
                )}
                <small>Optional. Folders and repos they work in beside their own. Enter, a comma or leaving the field adds one.</small>
              </span>
            </label>
          </fieldset>
          {err && (
            <p role="alert" className="tm-err">
              {err}
            </p>
          )}
          {/* Stays in sight at the dialog's foot however tall it is (2026-10-27 audit: Cancel and Add were cut off at 950px). */}
          {inline ? (
            <div className="tm-inline-foot">
              {saved && (
                <span className="tm-saved" role="status">
                  <CheckIcon className="size-3.5" /> Saved. {later || "It applies from their next turn."}
                </span>
              )}
              <Button type="submit" disabled={busy || !name.trim() || !changed}>
                {busy ? "Saving…" : "Save changes"}
              </Button>
            </div>
          ) : (
          <DialogFooter className="tm-dialog-foot">
            {!editing && !(team?.teammates.length) && <StarterTeam identity={identity} onDone={onClose} />}
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? "Saving…" : editing ? "Save" : "Add teammate"}
            </Button>
          </DialogFooter>
          )}
        </form>
  );
  if (inline) return form;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="tm-dialog max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain sm:max-w-[540px]" onInteractOutside={keepForPicker} onFocusOutside={keepForPicker}>
        {form}
      </DialogContent>
    </Dialog>
  );
}

/** Roles to start a teammate from: standing instructions, a check-in, how far it may go, and names it might take. */
export const ROLES: Record<"Lead" | "Engineer" | "Writer" | "Researcher" | "QA", { role: string; checkin: string; every?: "daily" | "weekdays" | "weekly"; days?: number[]; mode: EngineMode; names: string[] }> = {
  Lead: { role: "Leads the crew. Turns my goals into a plan, hands each teammate their part, checks the work and tells me where it stands.", checkin: "Stand-up for me: what the crew did, what's next, what's blocked.", mode: "full" as EngineMode, names: ["Nova", "Ada", "Iris"] },
  Engineer: { role: "Builds features and fixes bugs in our code. Keeps the tests green and opens a pull request for each change.", checkin: "", mode: "full" as EngineMode, names: ["Kit", "Rio", "Max"] },
  Writer: { role: "Writes our docs, release notes and posts in our voice: clear, short, no hype.", checkin: "", mode: "edits" as EngineMode, names: ["Juno", "Wren", "Sol"] },
  // Weekly on Mondays, as its words say: it was set to every weekday (QA, 2026-10-28).
  Researcher: { role: "Researches what others ship and what our users ask for, and writes it up with links.", checkin: "What changed in our space last week, in five bullets.", every: "weekly", days: [1], mode: "plan", names: ["Sage", "Lux", "Pip"] },
  QA: { role: "Tests every change before it ships: runs the app, tries the edge cases and files what breaks with steps to repeat it.", checkin: "", mode: "edits" as EngineMode, names: ["Vera", "Tess", "Ola"] },
};

/** A name from the list that nobody on the team has yet. */
const freeName = (names: string[]): string => names.find((n) => !(team?.teammates ?? []).some((m) => m.name.toLowerCase() === n.toLowerCase())) ?? names[0]!;

/**
 * Three teammates at once, for a first team (Arun, 2026-10-28: the critique's '"Starter team" button makes three at once'): a lead,
 * an engineer and a writer, on the coding tool picked here, the lead made the lead.
 */
function StarterTeam({ identity, onDone }: { identity: Identity; onDone: () => void }) {
  const installed = installedOn(identity);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const make = async () => {
    setBusy(true);
    setErr("");
    const tool: EngineTool = !installed || installed("claude") ? "claude" : "codex";
    try {
      let lead: string | null = null;
      for (const k of ["Lead", "Engineer", "Writer"] as const) {
        const r = ROLES[k];
        const got = await api<Team>(identity, "/api/teammates", { method: "POST", body: JSON.stringify({ name: freeName(r.names), role: r.role, tool, model: canRoute(tool) ? "auto" : "", mode: r.mode, checkins: r.checkin ? [{ id: `c${Date.now().toString(36)}${k}`, text: r.checkin, every: "weekdays", at: "09:00", days: [], tz: Intl.DateTimeFormat().resolvedOptions().timeZone }] : [] }), headers: { "Content-Type": "application/json" } });
        team = got;
        if (k === "Lead") lead = got.teammates.at(-1)?.id ?? null;
      }
      if (lead) await api(identity, `/api/teammates/${lead}/lead`, { method: "POST" }).catch(() => {});
      await refreshTeam(identity);
      onDone();
    } catch (x) {
      setErr((x as Error).message);
      await refreshTeam(identity);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="tm-starter">
      <Button type="button" variant="outline" disabled={busy} onClick={() => void make()} title="A lead, an engineer and a writer, ready to go">
        <UsersIcon className="size-4" /> {busy ? "Making three…" : "Starter crew"}
      </Button>
      {err && (
        <span className="tm-err" role="alert">
          {err}
        </span>
      )}
    </span>
  );
}

/**
 * The team on the narrow rail (SideRail.tsx), when the sidebar is folded: the Team room and each room as Friday's mark in its
 * members' colours, then each teammate's face as it stands (Arun, 2026-10-27: the OpenBot gap "a narrow-window sidebar").
 */
export function TeamRailItems({ onOpen, activeSid }: { onOpen: (r: RecentSession) => void; activeSid: string | null }) {
  useTeamVersion();
  const t = team;
  if (!t) return null;
  const inIt = (ids: string[]) => ids.flatMap((id) => t.teammates.filter((m) => m.id === id));
  const working = workingInTeamRoom(t);
  // A room's line: who is in it, and how many of them are at work.
  const roomSub = (who: TeammateView[], busy: number) => `${busy ? `${busy} working · ` : ""}${who.map((m) => m.name).join(", ") || "Nobody yet"}`;
  return (
    <>
      {/* Who works in the Team room itself (workingInTeamRoom; 2026-10-27 audit). */}
      <RailTip label="Crew room" sub={t.teammates.length ? `${working ? `${working} working · ` : ""}${t.teammates.length} in the crew` : "Where your teammates work together"}>
        <button type="button" className="rail-item" data-active={activeSid === t.sid ? "true" : undefined} aria-label="Crew room" onClick={() => openTeammate(t, null, onOpen)}>
          {t.teammates.length ? <RoomFaces seeds={t.teammates.slice(0, 3).map((m) => m.look ?? m.name)} size={26} off={t.teammates.every((m) => m.status === "offline")} /> : <UsersIcon className="size-4" />}
        </button>
      </RailTip>
      {(t.rooms ?? []).map((r) => {
        const who = inIt(Object.keys(r.lanes));
        return (
          <RailTip key={r.id} label={r.name} sub={roomSub(who, r.working)}>
            <button type="button" className="rail-item" data-active={activeSid === r.sid ? "true" : undefined} aria-label={`Room: ${r.name}`} onClick={() => openRoom(r, onOpen)}>
              <RoomFaces seeds={who.slice(0, 3).map((m) => m.look ?? m.name)} size={26} off={who.length > 0 && who.every((m) => m.status === "offline")} />
            </button>
          </RailTip>
        );
      })}
      {t.teammates.length > 0 && <span className="rail-sep" aria-hidden="true" />}
      {t.teammates.map((m) => (
        // Its tool once: a line that names it already ("On Codex · …", "Claude Code out of usage") isn't given it again in front
        // (2026-10-27 audit).
        <RailTip key={m.id} label={`${m.name}${m.lane === t.lead ? " · leads" : ""}`} sub={statusLine(m).includes(toolName(m.tool)) ? statusLine(m) : `${toolName(m.tool)} · ${statusLine(m)}`}>
          <button type="button" className="rail-item" aria-label={`${m.name}: ${statusLine(m)}`} onClick={() => openTeammate(t, m.lane, onOpen)}>
            <Face seed={m.look ?? m.name} size={24} status={m.status} lead={m.lane === t.lead} />
          </button>
        </RailTip>
      ))}
    </>
  );
}

/** Sends a command to the session (Activity's send). */
type SendCmd = (cmd: { type: "instruct"; text: string; lane: string; thread: number }) => Promise<{ ok: boolean; error?: string }>;

/**
 * Under a teammate's message in the Team room: "Reply in thread", or how many replies its thread has and when the last came; a
 * press opens the thread beside the room (Arun, 2026-10-27: the OpenBot gap "side threads"). The thread's own messages are left
 * out of the room's main flow (team-threads.ts).
 */
export function ThreadChip({ sid, root, lane, events }: { sid: string; root: number; lane: string; events: SessionEvent[] }) {
  const t = threadsOf(events);
  const list = t.byRoot.get(root) ?? [];
  const last = list.at(-1);
  const mate = mateOn(lane);
  const said = threadSaid(t.state.get(root), mate?.name ?? "It", lane, sid);
  return (
    <>
      <button type="button" className={`tt-thread${list.length ? " has" : ""}`} onClick={() => openThread({ sid, root, lane })} aria-label={list.length ? `Open the thread, ${list.length} ${list.length === 1 ? "reply" : "replies"}` : "Reply in thread"}>
        {list.length ? (
          <>
            <span className="tt-thread-faces" aria-hidden="true">
              {mate && <Face seed={mate.look ?? mate.name} size={14} />}
            </span>
            {list.length} {list.length === 1 ? "reply" : "replies"}
            <span className="tt-thread-when">{said ?? (last ? `last ${agoShort(last.ts)}` : "")}</span>
          </>
        ) : (
          <>
            <MessageSquareReplyIcon className="size-3.5" />
            Reply in thread
          </>
        )}
      </button>
    </>
  );
}

/**
 * How a thread stands, said under it and in it: from how its teammate's turn on the last reply went (team-threads.ts), not from
 * whether a reply is the last thing in it (2026-10-27 audit: "Kit is answering…" stayed for good after a turn that failed or was
 * stopped without a word). Nothing to say once it is answered.
 */
export const threadSaid = (state: ThreadState | undefined, name: string, lane: string, sid: string): string | null => {
  if (state === "answering") {
    // "Nova answers until Claude Code is back" said the opposite of what it meant (2026-10-28 QA): the reply waits.
    const why = queueWhy(lane);
    if (why) return `${name}'s reply waits ${why}`;
    // Busy in another room, idle here: the reply waits its turn, and the thread says so rather than "is answering…" while
    // nothing here answers (2026-10-27 audit).
    const m = mateOn(lane);
    if (m && m.status === "working" && statusIn(sid, lane, m) !== "working") return `Queued: ${name} answers after its work ${statusLineIn(sid, lane, m).replace(/^Idle here · (?:working|needs you) /, "")}`;
    return `${name} is answering…`;
  }
  return state === "failed" ? `${name} stopped on an error` : state === "stopped" ? `${name} was stopped` : null;
};

/** The thread open beside the room, if any: kept apart from the message it hangs off, which redraws as the room moves on. */
let openNow: { sid: string; root: number; lane: string } | null = null;
const threadWatchers = new Set<() => void>();
export const openThread = (t: { sid: string; root: number; lane: string } | null) => {
  openNow = t;
  for (const f of threadWatchers) f();
};

/** Where the open thread is drawn, once per room (Activity): it stays open while the room's messages come and go. */
export function ThreadHost({ sid, events, send }: { sid: string; events: SessionEvent[]; send: SendCmd }) {
  const t = useSyncExternalStore(
    (f) => (threadWatchers.add(f), () => void threadWatchers.delete(f)),
    () => openNow,
  );
  const open = !!t && t.sid === sid;
  // Open, it takes its own column beside the chat when the window has room for both (teammates.css: the page's main column gives
  // it the space), and over the chat with a dimmed backdrop when it hasn't (2026-10-27 audit: at 1500 wide it lay over the chat,
  // cutting its messages mid-word and hiding the Team tasks pill and the header's panel button).
  useEffect(() => {
    if (!open) return;
    document.documentElement.dataset.threadOpen = "true";
    return () => void delete document.documentElement.dataset.threadOpen;
  }, [open]);
  // A side panel opened after it (a file from Results, the header's panel button) is what the person wants now: the thread makes
  // way, rather than staying on top with the panel under it and the header's controls gone (QA, 2026-10-28).
  useEffect(() => {
    if (!open) return;
    const main = document.getElementById("main");
    let had = !!main?.querySelector(".bench-stack");
    const mo = new MutationObserver(() => {
      const has = !!main?.querySelector(".bench-stack");
      if (has && !had) openThread(null);
      had = has;
    });
    if (main) mo.observe(main, { childList: true, subtree: true });
    const file = () => openThread(null);
    addEventListener("friday:open-file", file);
    return () => (mo.disconnect(), removeEventListener("friday:open-file", file));
  }, [open]);
  if (!t || !open) return null;
  // Keyed by its message: another thread opened in its place starts with its own box, not the last one's half-typed reply.
  return createPortal(
    <>
      <div className="tt-thread-scrim" aria-hidden="true" onClick={() => openThread(null)} />
      <ThreadPanel key={t.root} sid={sid} root={t.root} lane={t.lane} events={events} send={send} onClose={() => openThread(null)} />
    </>,
    document.body,
  );
}

export const agoShort = (ts: number) => {
  const m = Math.round((Date.now() - ts) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

/** A thread, beside the room: the message it hangs off, every reply and answer in order, and a box to reply in. */
function ThreadPanel({ sid, root, lane, events, send, onClose }: { sid: string; root: number; lane: string; events: SessionEvent[]; send: SendCmd; onClose: () => void }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const mate = mateOn(lane);
  const first = events.find((e) => e.seq === root);
  const threads = threadsOf(events);
  const list = threads.byRoot.get(root) ?? [];
  const standing = threadSaid(threads.state.get(root), mate?.name ?? "It", lane, sid);
  const end = useRef<HTMLDivElement | null>(null);
  // In braces: scrollIntoView answers a promise in newer browsers, which React would take for the effect's cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [list.length]);
  // Held in a ref: onClose is made anew on every draw, and as the effect's dependency it took Escape off and put it back each time.
  const close = useRef(onClose);
  close.current = onClose;
  // Escape closes the top layer only: not the thread under an open popover, menu or dialog, nor one Escape something else took
  // (Arun, 2026-10-28: "really iron out bugs and feature problems and gaps"; one Escape closed the Threads list and the thread).
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const over = document.querySelectorAll<HTMLElement>('[role="dialog"]:not(.tt-thread-panel), [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]');
      // One on its way out (closed, its exit animation still running) is no longer on top.
      const closed = (el: HTMLElement) => el.dataset.state === "closed" || (el.firstElementChild as HTMLElement | null)?.dataset.state === "closed";
      if ([...over].some((el) => el.getClientRects().length > 0 && !closed(el))) return;
      close.current();
    };
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, []);
  const reply = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    const r = await send({ type: "instruct", text: t, lane, thread: root }).catch((e: Error) => ({ ok: false, error: e.message }));
    setBusy(false);
    if (!r.ok) return setErr(r.error ?? "Couldn't send that.");
    setErr("");
    setText("");
  };
  const said = (e: SessionEvent) => (e.body.type === "agent.message" || e.body.type === "instruction" ? e.body.text : "");
  const row = (e: SessionEvent, isRoot = false) => {
    const agent = e.body.type === "agent.message";
    return (
      <div key={e.seq} className={`tt-thread-msg${agent ? "" : " mine"}${isRoot ? " root" : ""}`}>
        <span className="tt-thread-who">
          {agent && mate ? <Face seed={mate.look ?? mate.name} size={18} /> : null}
          <b>{agent ? (mate?.name ?? e.actor.name) : e.actor.name}</b>
          <span>{agoShort(e.ts)}</span>
        </span>
        <div className="tt-thread-text">{agent ? <MessageResponse {...ANSWER}>{mediaText(said(e).trim())}</MessageResponse> : said(e)}</div>
      </div>
    );
  };
  return (
    <aside className="tt-thread-panel" role="dialog" aria-label={`Thread with ${mate?.name ?? "the teammate"}`}>
      <header>
        <b>Thread</b>
        <span>with {mate?.name ?? "the teammate"}</span>
        <button type="button" onClick={onClose} aria-label="Close the thread">
          <XIcon className="size-4" />
        </button>
      </header>
      <div className="tt-thread-body">
        {first && row(first, true)}
        <div className="tt-thread-count">{list.length ? `${list.length} ${list.length === 1 ? "reply" : "replies"}` : "No replies yet"}</div>
        {list.map((e) => row(e))}
        {standing && <div className="tt-thread-typing">{standing}</div>}
        <div ref={end} />
      </div>
      <form
        className="tt-thread-box"
        onSubmit={(e) => {
          e.preventDefault();
          void reply();
        }}
      >
        <Textarea
          value={text}
          rows={2}
          autoFocus
          placeholder={`Reply to ${mate?.name ?? "it"} in this thread…`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void reply();
            }
          }}
        />
        {/* Send, as the room's own box has it (Arun, 2026-10-27: "make the reply the send button instead"). */}
        <button type="submit" className="tt-thread-send" disabled={!text.trim() || busy} aria-label="Send reply" title="Send (Enter)">
          <ArrowUpIcon className="size-4" />
        </button>
        {err && <p className="tm-err">{err}</p>}
      </form>
    </aside>
  );
}

/**
 * What a team's chat is for, after OpenBot's channels (Arun, 2026-10-27: "rework what gets sent in the room chats… keep the room
 * chat clean and clear", "what goes in the teammate chat sessions too"): each teammate's result, the person's own words, and what
 * needs them. The agents' talk among themselves folds to one line per stretch (TalkGroup), opened when wanted; Friday's own notes
 * to an agent (a board task's report, carry on, a wake) and coordination (files held, wakes set, memory saved) stay out of the
 * room, and fold into that line in a teammate's own chat; and a turn still under way is the one "working" line over the box
 * (TeamWorking), not a card each.
 */
// Friday's notes are told by their "[Friday] " mark and keep-going flag as well as by who sent them, and a hand-off is never one: it
// shows (team-room.ts isFridayNote; 2026-10-27 audit: hand-offs, posted by an agent, were left out of the room as Friday's notes).
export { isFridayNote };
export const isAgentTalk = (e: SessionEvent) =>
  (e.body.type === "instruction" && e.actor.kind !== "human" && (!!e.body.mesh || !!e.body.peer)) || e.body.type === "mesh.posted" || e.body.type === "peer.sent" || e.body.type === "peer.held";
// Which model a turn ran on, too (Arun, 2026-10-27: "Auto picked GPT-6.1 Sol…" lines in the room).
const COORDINATION = /^(files\.(held|released)|wake\.(set|fired)|memory\.saved|model\.routed|lane\.effort|effort\.skipped)$/;

/**
 * The room's items, folded: `kindOf` says what each is ("show": a result for the person, the person's own words; "talk": the
 * agents among themselves, a teammate's turn on work the lead gave it, Friday's notes in a teammate's own chat; "hide"). Each
 * stretch of talk is kept under its first item's key, as `groups`.
 */
export function foldTeamTalk<T>(items: T[], kindOf: (it: T) => "show" | "talk" | "hide", keyOf: (it: T) => number): { items: T[]; groups: Map<number, T[]> } {
  const groups = new Map<number, T[]>();
  const out: T[] = [];
  let open: T[] | null = null;
  for (const it of items) {
    const k = kindOf(it);
    if (k === "hide") continue;
    if (k === "talk") {
      if (open) {
        open.push(it);
        continue;
      }
      open = [it];
      groups.set(keyOf(it), open);
      out.push(it);
      continue;
    }
    open = null;
    out.push(it);
  }
  return { items: out, groups };
}

/** What kind a session event is in a team's chat: the agents' talk, Friday's or coordination's, or the person's (show). */
export function teamEventKind(e: SessionEvent, room: boolean): "show" | "talk" | "hide" {
  if (isAgentTalk(e)) return "talk";
  // A turn the app's restart cut short picks itself up again: nothing for the room to act on.
  if (room && e.body.type === "run.ended" && /^The server restarted in the middle of /.test(e.body.error ?? "")) return "hide";
  if (isFridayNote(e) || COORDINATION.test(e.body.type)) return room ? "hide" : "talk";
  return "show";
}

/** Who a piece of the agents' talk is between, by lane and name. */
function talkers(e: SessionEvent): { lane: string; name: string }[] {
  const b = e.body;
  if (b.type === "instruction" && b.mesh) return [{ lane: b.mesh.fromLane, name: b.mesh.fromName }, { lane: e.lane ?? "", name: b.mesh.toName }];
  if (b.type === "instruction" && b.peer) return [{ lane: "", name: b.peer.fromName }];
  if (b.type === "mesh.posted") return [{ lane: b.fromLane, name: b.fromName }];
  if (b.type === "peer.sent" || b.type === "peer.held") return [{ lane: e.lane ?? "", name: e.actor.name }];
  return [];
}

const listNames = (n: string[]) => (n.length <= 1 ? n.join("") : n.length === 2 ? `${n[0]} and ${n[1]}` : `${n.slice(0, -1).join(", ")} and ${n.at(-1)}`);

/** One piece of a stretch of talk, for its line: who it is between, its words, and whether it is Friday's note. */
export interface TalkPiece {
  who: { lane: string; name: string }[];
  text: string;
  note?: boolean;
  /** A teammate's turn on work it was given (its result, back to the lead). */
  turn?: boolean;
}

/** A piece of talk from a session event (agent messages, updates, Friday's notes). */
export function pieceOf(e: SessionEvent): TalkPiece {
  const b = e.body;
  const text = b.type === "instruction" || b.type === "mesh.posted" ? b.text : b.type === "peer.sent" || b.type === "peer.held" ? b.text : "";
  return { who: talkers(e), text: boardTitle(text.replace(/^\[Friday\]\s*/, "")), ...(isFridayNote(e) || COORDINATION.test(b.type) ? { note: true } : {}) };
}

/** A stretch of the agents' talk (and Friday's notes, in a teammate's own chat), as one line: who, how many, the last of it; opened, each as it was. */
export function TalkGroup({ pieces, children }: { pieces: TalkPiece[]; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const who = new Map<string, string>();
  // Each by the name they have now: a teammate renamed kept its old name here (QA, 2026-10-28: "Nova, Kit and Juno" after a rename).
  for (const p of pieces) for (const t of p.who) if (t.name && t.name !== "everyone" && t.name !== "The board") who.set((t.lane && mateOn(t.lane)?.name) || t.name, t.lane);
  const notes = pieces.filter((p) => p.note).length;
  const turns = pieces.filter((p) => p.turn).length;
  const talk = pieces.length - notes - turns;
  const names = [...who.keys()];
  // Its words, not its markdown: "**Notes**" and backticks showed as typed (QA, 2026-10-28).
  const preview = plainLine([...pieces].reverse().find((p) => p.text.trim())?.text ?? "");
  const many = (n: number, one: string, more = `${one}s`) => `${n} ${n === 1 ? one : more}`;
  const what = [
    names.length ? `${listNames(names.slice(0, 3))}${names.length > 3 ? ` and ${names.length - 3} more` : ""}` : "",
    [talk ? many(talk, "message") : "", turns ? many(turns, "result") : "", notes ? many(notes, "note from Friday", "notes from Friday") : ""].filter(Boolean).join(", "),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="talk-group" data-open={open ? "true" : undefined}>
      <button type="button" className="talk-group-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="talk-group-faces" aria-hidden="true">
          {/* By place: two names can share a lane (a hand-off's from and to), and the key said it twice. */}
          {[...who.values()].filter(Boolean).slice(0, 4).map((l, i) => (
            <span key={`${i}:${l}`}>{teammateMark(l, 10)?.mark}</span>
          ))}
        </span>
        <span className="talk-group-what">{what}</span>
        {!open && preview && <span className="talk-group-last">{preview}</span>}
        <ChevronIcon open={open} />
      </button>
      {open && <div className="talk-group-body">{children}</div>}
    </div>
  );
}

const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg className="talk-group-chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ transform: open ? "rotate(90deg)" : undefined }}>
    <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
