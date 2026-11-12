import { ChevronRightIcon, FolderGit2Icon, PlusIcon, SearchIcon, SettingsIcon, LogOutIcon, MoonIcon, SunIcon, XIcon } from "lucide-react";
import { dragEnds } from "./drag-end.js";
import { SessionPrBadge } from "./SessionPrs.js";
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { SidebarGroup, SidebarGroupAction, SidebarGroupContent, SidebarGroupLabel, SidebarProvider } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { shortPaths } from "./shortPaths.js";
import { UpdateRailButton } from "./AppUpdate.js";
import { forkSession } from "./github-menu.js";
import { CodingToolLimits } from "./gauge.js";
import type { McpPublic } from "../mcp-types.js";
import { Avatar, Icon, type IconName } from "./icons.js";
import type { AgentView, PersonListing } from "../agents.js";
import { useNeedsCount, withCode, type AttentionState } from "./Attention.js";
import type { Attention } from "../attention.js";
import { recordLine, useAgentRecords } from "./useAgentRecords.js";
import type { Crew, CrewState, Preview, Working } from "../attention.js";
import { usePrs } from "./prWatch.js";
import { hostApi } from "./local.js";
import { openOutside } from "./openOutside.js";
import { chooseTheme } from "./prefs.js";
import { applyTheme, readTheme } from "./theme.js";
import { currentLook, loadFolded, loadSectionOrder, saveFolded, saveSectionOrder } from "./storage.js";
import type { Identity, Project, RecentSession } from "./storage.js";
import { buckets, snoozePresets, snoozeWord } from "./sidebar-buckets.js";
import { teamColour } from "../teammate-look.js";
import { ContextMenu, InlineEdit, MenuButton, relTime, useConfirm, type MenuItem } from "./ui.js";
import type { WorkspaceUsage } from "./workspace-types.js";
import { isLocal, planLimits, planNow } from "./edition.js";
import { TeamTip } from "./TeamTip.js";
import type { SessionSummary } from "../board.js";
import { EngineMark, FridayMark } from "./BrandMarks.js";
import { isRawError, stoppedLine, stoppedRow } from "../activity-line.js";
import { limitHit } from "../limit-reset.js";
import { namedBranch } from "./branch-names.js";
import { ENGINE_NAMES, type EngineTool } from "../types.js";
import { doingWords, QUIET_AFTER_MS, quietFor } from "../step-words.js";
import { useSettledOrder } from "./sidebar-order.js";
import { shortcut } from "./Shortcuts.js";
import { choosePlace, CodeCrewToggle, isWorkSid, useWorkSessions } from "./WorkMode.js";
import { Face, isTeamSid, mateStatus, newTeammate, openRoom, openTeammate, ownOf, RoomDialog, RoomFaces, SidebarTeammates, useTeam, useTeamTab, type RoomView } from "./Teammates.js";
import { freeLine, roleWord } from "./team-status.js";
import { byDay } from "./sidebar-days.js";
import { ALL as ALL_AGENTS, useFocusedAgent } from "./agentFocus.js";
import { byState, StateRing, useFlip, useNow, type Presence } from "./presence.js";
import { api } from "./api.js";
import { markUnread, useUnread } from "./unread.js";
import { noticeDue, UsageNotice, useUsageSharing } from "./UsageSharing.js";
import { folderName } from "./Workspace.js";

/** `fresh`: a project just made, whose name box was never confirmed: Escape takes it away again. */
type Renaming = { kind: "session" | "project"; id: string; fresh?: boolean } | null;
const DRAG_TYPE = "application/x-mpa-session";
/** What is carried when a whole section of the list is dragged, as opposed to one chat. */
const SECTION_TYPE = "application/x-mpa-section";

export interface SidebarProps {
  identity: Identity;
  /** Which workspace and plan this is, for the account menu. */
  workspace: WorkspaceUsage | null;
  /** The account's email, shown under the name in the account menu. */
  email?: string;
  recents: RecentSession[];
  projects: Project[];
  connections: McpPublic[];
  /** Everyone who has joined a session on this server, most recently seen first. */
  people: PersonListing[];
  /** Requests in both directions, and who is left to ask. */
  /** Invite links for the session currently open, when this person may see them. */
  sessionInvites: Record<string, string> | null;
  /** Invites addressed to this person, waiting to be accepted or declined. */
  /** Sessions waiting on this person, across all of them. */
  attention: AttentionState;
  identityForApi: Identity;
  reloadPeople: () => Promise<void>;
  reloadInbox: () => Promise<void>;
  activeSid: string | null;
  /** On the new-session page opened from a project's "New session here": the project it will go in, shown in the list. */
  draftProject?: string | undefined;
  view: "home" | "session" | "connections" | "agents" | "automations" | "people" | "library" | "crew" | "board" | "deepdive" | "review" | "needs" | "settings" | "usage";
  /** Whether the chat list is showing beside the rail. */
  panelOpen: boolean;
  /** Whether the session list shows beside the rail: false when the sidebar's button folded it and the rail stayed. */
  listOpen?: boolean;
  /** The Chat button: opens Chat, or folds its list away when already there. */
  onChat: () => void;
  /** Whether the Chat button also folds the chat list while you are in chats. Off in the Mac app, where the window's toolbar does that. */
  chatToggles?: boolean;
  agentsCount: number;
  agents: AgentView[];
  agentSel: string | null;
  onSelectAgent: (id: string) => void;
  onNewAgent: () => void;
  /** Bring agents in from the person's own Claude Code, Cursor and Codex. */
  onImportAgents?: () => void;
  agentMenu: (a: AgentView) => MenuItem[];
  onOpenAgents: () => void;
  onOpenAutomations: () => void;
  onOpenPeople: () => void;
  /** The team's library of past sessions (TeamLibrary.tsx). */
  onOpenLibrary: () => void;
  /** The hosted service's Crew (Teammates.tsx): given, the sidebar has its Code and Crew switch. */
  /** Settings is a page: the gear goes there, where it was last left. */
  onOpenSettings: () => void;
  /** Every agent's tokens, and what hand-offs saved (UsagePage). */
  onOpenUsage: () => void;
  /** A rail button the pointer or focus has reached: its page's code can be fetched ahead of the click. */
  onWarm?: (view: SidebarProps["view"]) => void;
  onOpenBoard: () => void;
  /** Deep Dive: the repos explained (DeepDive.tsx). */
  onOpenDeepDive?: () => void;
  onOpenReview: () => void;
  /** The Needs you queue (NeedsYou.tsx). */
  onOpenNeeds?: () => void;
  /** Pull requests waiting on this person's review, for a mark on Code Review's button. */
  reviewsWaiting?: number;
  peopleCount: number;
  /** People asking to connect with you, waiting for your answer: the People row says so, and More does while it is folded. */
  peopleRequests?: number;
  onNew: (projectId?: string) => void;
  onOpen: (r: RecentSession) => void;
  onRename: (name: string) => void;
  updateRecent: (sid: string, patch: Partial<RecentSession>) => void;
  removeRecent: (sid: string) => void;
  /** Delete a session you own, for everyone in it, freeing everything it kept. Resolves to why it couldn't, or nothing. */
  deleteSession: (sid: string) => Promise<string | void>;
  createProject: (name: string) => string;
  updateProject: (id: string, patch: Partial<Project>) => void;
  deleteProject: (id: string) => void;
}

/**
 * The sidebar, in the Dass design language (docs/dass-design-language.md): one column, no rail (Arun, 2026-10-19: "get rid of
 * this"). Where you are at the top, with New session; then the places, the few used most in sight and the rest under More;
 * then what you work in, with what waits on you pulled to the top; and you, the theme and Settings at the foot. Built from
 * shadcn's sidebar pieces, inside the app's own frame (the grid and the Mac window's bar hold it where it was).
 */
/**
 * A row acting as a button opens on Enter and on Space, as a button does (Testing F-21, A11Y-2: Space did nothing). Only
 * for the row itself: a key typed into its rename box or pressed on its actions button is theirs.
 */
/**
 * Whether a session can be forked, as far as the list knows: in the open-source edition a fork carries its coding tools on, so a
 * session with none (Friday's own agent alone) can't be (app.ts forkTools). Unknown sessions keep the item; the server says why.
 */
export function canFork(crew: Crew | null | undefined, local: boolean): boolean {
  return !local || !crew || crew.agents.some((a) => !!a.tool);
}

/**
 * An agent's name as the lists say it: the main lane's "Main" is its coding tool, or Friday Code when it has none, as the Agent
 * Board names it (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL"; the sidebar said "Main", the board
 * "Friday Code" and the rail "Main" for "Claude Code working").
 */
export function agentWord(name: string, tool?: EngineTool | null): string {
  return name === "Main" ? (tool ? ENGINE_NAMES[tool] : "Friday Code") : name;
}

/** A line said in the app's own notice, not the browser's alert (App.tsx "friday:notice"). */
export const sayNotice = (text: string) => void window.dispatchEvent(new CustomEvent("friday:notice", { detail: text }));

export function activates(e: { key: string; target: unknown; currentTarget: unknown; preventDefault(): void }): boolean {
  if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return false;
  if (e.key === " ") e.preventDefault();
  return true;
}

/**
 * The sidebar's width, the person's own: dragged at its edge, between enough for a session's name and half a laptop's screen,
 * double-clicked back to where it starts (Arun, 2026-10-30: "redesign this so we can have a lot space for the side bar").
 * Everything laid out beside it follows --panel-w.
 */
const PANEL_KEY = "friday.panelWidth";
/** The open-source build's rail (OssRail), part of the sidebar's width: its list keeps the room it had before the rail came. */
const RAIL_W = isLocal() ? 52 : 0;
const PANEL_MIN = 240 + RAIL_W;
const PANEL_MAX = 480 + RAIL_W;
const PANEL_START = 300 + RAIL_W;
const clampPanel = (w: number) => Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, w)));
function setPanelWidth(w: number, keep = true): void {
  document.documentElement.style.setProperty("--panel-w", `${clampPanel(w)}px`);
  if (!keep) return;
  try {
    localStorage.setItem(PANEL_KEY, String(clampPanel(w)));
  } catch {
    // Private browsing: this window keeps it.
  }
}
if (typeof document !== "undefined") {
  let kept = PANEL_START;
  try {
    kept = Number(localStorage.getItem(PANEL_KEY)) || PANEL_START;
    // A width kept before the rail came (the list's alone): the rail's is added once, so the list is as wide as it was.
    if (RAIL_W && localStorage.getItem(PANEL_KEY) && localStorage.getItem(`${PANEL_KEY}.rail`) !== "1") {
      kept += RAIL_W;
      localStorage.setItem(PANEL_KEY, String(clampPanel(kept)));
    }
    if (RAIL_W) localStorage.setItem(`${PANEL_KEY}.rail`, "1");
  } catch {
    // As it starts.
  }
  setPanelWidth(kept, false);
}

function PanelResize() {
  return (
    <div
      className="sb-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sidebar"
      aria-valuemin={PANEL_MIN}
      aria-valuemax={PANEL_MAX}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onDoubleClick={() => setPanelWidth(PANEL_START)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const now = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--panel-w")) || PANEL_START;
        setPanelWidth(now + (e.key === "ArrowRight" ? 16 : -16));
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        const left = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect().left;
        const from = e.clientX;
        let x = from;
        let frame = 0;
        // A drag once it has moved 3px: a click, or each half of a double-click, leaves the width as it is, so the double-click lands
        // on the handle and resets it (audit REST-4, Arun 2026-11-04: each click took 4px off and the double-click missed).
        let dragging = false;
        // Ends however the pointer goes, released over the preview's page or outside the window too (drag-end.ts).
        const held = dragEnds(e, () => up());
        const move = (ev: PointerEvent) => {
          if (!held.live(ev)) return;
          x = ev.clientX;
          if (!dragging && Math.abs(x - from) < 3) return;
          if (!dragging) document.body.classList.add("resizing", "resizing-x", "resizing-panel");
          dragging = true;
          frame ||= requestAnimationFrame(() => {
            frame = 0;
            setPanelWidth(x - left, false);
          });
        };
        const up = () => {
          if (frame) cancelAnimationFrame(frame);
          if (dragging) setPanelWidth(x - left);
          document.body.classList.remove("resizing", "resizing-x", "resizing-panel");
          removeEventListener("pointermove", move);
          removeEventListener("pointerup", held.stop);
          removeEventListener("pointercancel", held.stop);
        };
        addEventListener("pointermove", move);
        addEventListener("pointerup", held.stop);
        addEventListener("pointercancel", held.stop);
      }}
    />
  );
}

/** A folder's mark, as herdr's: its first letter on a tile in one of the muted hues, the same one each time. */
function RepoTile({ name }: { name: string }) {
  return (
    <span className="sb-tile" style={{ background: teamColour(name) }} aria-hidden>
      {(name.replace(/^[^A-Za-z0-9]+/, "")[0] ?? "?").toUpperCase()}
    </span>
  );
}

/**
 * How a group stands, said on its own line even folded: how many are working. What waits on you is said once, in Needs you at
 * the top, never again as an amber badge on the group it left (audit CODE-1 B, Arun 2026-11-04).
 */
function GroupState({ working }: { working: number }) {
  if (working) return <span className="sb-gstate live" title={`${working} working`}><span className="sb-gspin" aria-hidden />{working > 1 ? working : ""}</span>;
  return null;
}

export function Sidebar(p: SidebarProps) {
  // On a place's own page (Needs you, the Board, Automations, Code review, Usage, Settings) the open-source build shows the rail
  // alone, and the page takes the list's room (Arun, 2026-11-11: "make sure the side bar isnt there when you click on like the
  // other pages"). style.css html.rail-only narrows the panel to the rail.
  // The list folded with the sidebar's button leaves the rail too, the same way (App.tsx keepRail).
  const railOnly = isLocal() && (RAIL_PAGES.includes(p.view ?? "") || p.listOpen === false);
  useEffect(() => {
    document.documentElement.classList.toggle("rail-only", railOnly);
    return () => document.documentElement.classList.remove("rail-only");
  }, [railOnly]);
  return (
    <aside className={`sb-panel ${p.panelOpen ? "open" : ""}`} aria-label="Sidebar" aria-hidden={!p.panelOpen} inert={!p.panelOpen}>
      {p.panelOpen && !railOnly && <PanelResize />}
      {/* shadcn's menu pieces read their sidebar's state; held open here, since the app decides when the column shows. */}
      <SidebarProvider open onOpenChange={() => {}} className="contents" style={{}}>
        {isLocal() ? (
          // The open-source build: the places as a rail down the left, then the list (Arun, 2026-11-11: the production build's
          // sidebar), with your agents above your sessions.
          <div className="sb-panel-inner dass-panel sb-rail-on flex">
            <OssRail p={p} />
            {!railOnly && <OssList p={p} />}
          </div>
        ) : (
          <div className="sb-panel-inner dass-panel flex flex-col gap-2">
            <Head p={p} />
            {p.view === "agents" ? <AgentsList p={p} /> : <SessionsList p={p} />}
            <Foot p={p} />
          </div>
        )}
      </SidebarProvider>
    </aside>
  );
}

/**
 * A session's agents in its row, in place of the last thing said (Arun, 2026-10-24: "instead of the secondary text like the most
 * recent message maybe we add the agent status and stuff with their icons"): each agent's mark in a small disc ringed in its
 * state's colour (working blue, waiting amber, done green, stopped red, offline dashed), a little overlapped, then the one that
 * matters most in words. Each mark names its agent and state on hover.
 */
// "stopped" is a turn somebody stopped (it read "done" after Stop: 2026-10-28 QA); "failed" is one that ended on an error.
/** A crew state as the shared presence ring draws it (presence.tsx). */
// Stopped part way through its plan ("stopped at 3 of 5", Carry on waiting on you) reads as needs you, as the Work rail and bar
// say it: the amber ring and "?", and the row rises with Needs you (coordinator, 2026-10-29).
const CREW_PRESENCE: Record<CrewState, Presence> = { needs: "needs", working: "working", failed: "error", offline: "asleep", done: "idle", short: "needs", stopped: "idle", idle: "idle" };
/** A session whose agent stopped short of its plan, waiting on the person to carry it on, with nothing of it still running. */
const stoppedShort = (crew: Crew | null | undefined, working: unknown): boolean => !working && !!crew?.agents.some((x) => x.state === "short");

/** Which agent a stopped run was, by the name its row uses ("Claude Code", not the lane's "Main"). */
const stopper = (crew: Crew | null | undefined, needs: Attention): string => {
  const x = crew?.agents.find((c) => c.lane === needs.lane) ?? crew?.agents.find((c) => c.state === "failed");
  return x ? agentWord(x.name.replace(/^[^']+'s /, ""), x.tool) : (needs.agent ?? "The agent");
};

/** Every agent that stopped did so on its usage limit: waiting on the clock, amber, never the red of an error. */
const onlyLimited = (a: Crew["agents"]) => a.some((x) => x.state === "failed") && a.filter((x) => x.state === "failed").every((x) => !!x.why && !!limitHit(x.why));

/**
 * A session's state as a small ring just after its name (Arun, 2026-11-03: "get rid of the agent icon to the left … add the
 * spinning circle ring thing to the right of the tab session title name"): the turning ring while its agents work, amber while
 * it waits on you, red when a run failed. A quiet session has none, so the ones at work stand out.
 */
function SessionRing({ state, crew, working, title, unread = false, stopped = false, quiet }: { state: "needs" | "working" | "idle"; crew: Crew | null; working: Working | null; title?: string | undefined; /** Its agents finished while you were elsewhere (unread.ts). */ unread?: boolean; /** What waits on you is a run that stopped on an error: the red ring, as everywhere a stop shows. */ stopped?: boolean; /** Its agents are working but haven't been heard from in a while: how long, for the dashed ring's tip. */ quiet?: string | undefined }) {
  const a = crew?.agents ?? [];
  // Working, but nothing heard for a while: a still, dashed ring in place of the turning one, so it doesn't pass for busy (Orca's
  // "unconfirmed", Arun 2026-11-03). Never a check: silence isn't done.
  if (state === "working" && quiet)
    return (
      <span className="state-ring sb-quiet" role="img" aria-label={`No update in ${quiet}`} title={`Working, but no update in ${quiet}`}>
        <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <circle cx="6" cy="6" r="4.6" strokeDasharray="2.2 1.9" />
        </svg>
      </span>
    );
  const pr: Presence | null = state === "needs" ? (stopped && !working ? "error" : "needs") : state === "working" ? "working" : onlyLimited(a) ? "needs" : a.some((x) => x.state === "failed") ? "error" : null;
  // Finished: a green ring where the ring turned (Arun, 2026-11-03: "add something to show that it was finished"; 2026-11-04:
  // "also can they make this just a green ring instead"), the size and place of the other rings, lit while you haven't opened it
  // since, quieter once you have.
  if (!pr && (unread || a.some((x) => x.state === "done")))
    return (
      <span className={`state-ring sb-done${unread ? " new" : ""}`} role="img" aria-label="Finished" title={unread ? "Finished while you were away" : "Finished"}>
        {/* The presence ring's own size: 10.5px across, a 1.75px line, in the 12px slot (presence.tsx .pr-ring). */}
        <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
          <circle cx="6" cy="6" r="4.375" />
        </svg>
      </span>
    );
  return <StateRing state={pr} title={title} />;
}

const CREW_WORD: Record<CrewState, string> = { needs: "needs you", working: "working", failed: "stopped", offline: "offline", done: "done", short: "stopped early", stopped: "stopped", idle: "ready" };
/** A working agent unheard for QUIET_AFTER_MS: said as quiet, never as working or done (step-words.ts). */
const isQuiet = (x: { state: CrewState; heardAt?: number }, now: number) => x.state === "working" && !!x.heardAt && now - x.heardAt > QUIET_AFTER_MS;
/** A session whose every working agent has gone quiet: its ring is the dashed one, and it sorts after those at work. */
export const crewQuiet = (crew: Crew | null | undefined, now: number): boolean => {
  const w = crew?.agents.filter((x) => x.state === "working") ?? [];
  return w.length > 0 && w.every((x) => isQuiet(x, now));
};

/**
 * The line under a session's name, the most telling thing first (Arun, 2026-11-03, after Orca's row line): who stopped and why,
 * who has gone quiet and for how long, what the one at work is doing this minute ("Codex · Editing Sidebar.tsx"), then how the
 * agents stand. Said agent first, so a line cut short keeps who and loses the detail. What needs you is the row's own line (ChatRow).
 */
function CrewLine({ crew, now }: { crew: Crew; now: number }) {
  const a = crew.agents;
  const short = (n: string, tool?: EngineTool) => agentWord(n.replace(/^[^']+'s /, ""), tool);
  const of = (st: CrewState) => a.filter((x) => x.state === st);
  const working = of("working").filter((x) => !isQuiet(x, now));
  const quiet = of("working").filter((x) => isQuiet(x, now));
  const failed = of("failed");
  // Stopped short of its plan, among several agents too: the row sits under Needs you, so its line says why, never "ready"
  // (Arun, 2026-10-29: "Yes, fix them"; "2 agents · ready" under Needs you).
  const early = of("short");
  const words =
    failed.length && failed[0]!.why ? stoppedRow(short(failed[0]!.name, failed[0]!.tool), failed[0]!.why)
    : working.length > 1 ? "working"
    : working.length ? `${short(working[0]!.name, working[0]!.tool)} · ${working[0]!.doing ? doingWords(working[0]!.doing) : "working"}`
    : quiet.length ? `${short(quiet[0]!.name, quiet[0]!.tool)} · no update in ${quietFor(quiet[0]!.heardAt!, now)}`
    : failed.length ? `${short(failed[0]!.name, failed[0]!.tool)} stopped`
    : a.every((x) => x.state === "offline") ? "Offline"
    : a.length === 1 ? `${short(a[0]!.name, a[0]!.tool)} · ${a[0]!.plan ? `stopped at ${a[0]!.plan}` : CREW_WORD[a[0]!.state]}`
    : early.length ? `${short(early[0]!.name, early[0]!.tool)} · stopped at ${early[0]!.plan}`
    : a.some((x) => x.state === "done") ? `${a.length} agents · done`
    : `${a.length} agents · ready`;
  return (
    <span className="sb-crew">
      {/* Several at work: each one's coding tool, small, in place of a count (Arun, 2026-11-03: "add the icons off the agents
          working instead of 3 working, make the icons small but visible"). */}
      {working.length > 1 && (
        <span className="sb-crew-tools" role="img" aria-label={`${working.length} working: ${working.map((x) => short(x.name, x.tool)).join(", ")}`}>
          {working.slice(0, 5).map((x) => (
            <span key={x.lane} title={short(x.name, x.tool)}>{x.tool ? <EngineMark tool={x.tool} size={12} /> : x.name === "Main" ? <FridayMark size={12} /> : <Icon name="agent" size={12} />}</span>
          ))}
          {working.length > 5 && <span className="sb-crew-more">+{working.length - 5}</span>}
        </span>
      )}
      <span className={`truncate sb-crew-words${failed.length && failed[0]!.why ? " failed" : working.length ? " working" : quiet.length ? " quiet" : failed.length ? " failed" : of("short").length ? " needs" : ""}`}>{words}</span>
    </span>
  );
}

// ── head: where you are, search, and the one thing to start ─────────────────────────────────

function Head({ p }: { p: SidebarProps }) {
  const agents = p.view === "agents";
  let onNew: () => void = agents ? p.onNewAgent : () => p.onNew();
  let label = agents ? "New agent" : "New session";
  let kbd = !agents;
  // On the Team tab (Teammates.tsx) the button adds a teammate.
  // With the rail (the open-source build), New session stays itself in the Crew too: New agent is the Agents section's +.
  const crewTab = useTeamTab()[0] && !isLocal();
  if (crewTab) [onNew, label, kbd] = [newTeammate, "New teammate", false];
  return (
    <div className="flex shrink-0 flex-col gap-2 px-1">
      {/* In the local edition this row is only the search button, which the desktop app moves into its header: there it goes. */}
      <div className={`flex items-center gap-1${isLocal() ? " sb-head-local" : ""}`}>
        {/* The workspace's name where the logo was (Arun, 2026-10-24: "get rid of logo and make the workspace/team name replace
            its place"): which team you're in is what this corner should say. */}
        <div className="panel-title brand flex min-w-0 flex-1 items-center gap-2">
        </div>
        {/* No Search button (Arun, 2026-10-30: "get rid of the search icon in the side bar too"): ⌘⇧F and ⌘K find everything. */}
        {/* In a browser there is no window bar with the sidebar's button: one here folds it, as ⌘B does (2026-10-27 audit: the
            keyboard was the only way). The desktop app's window bar has its own. */}
        {!window.fridayDesktop && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="dass-rail-btn sidebar-fold size-8" aria-label="Hide the sidebar" onClick={() => window.dispatchEvent(new Event("friday:fold-sidebar"))}>
                <Icon name="sidebar" size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Hide the sidebar <span className="dass-kbd ml-2">{shortcut("⌘B")}</span>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {/* Code or Crew, in both editions the same switch (Arun, 2026-11-04: "add this for production btw"): in the desktop app it
          is in the window's bar (WindowNav), in a browser here. */}
      {!agents && !window.fridayDesktop && !isLocal() && <CodeCrewToggle className="in-sidebar" working={p.attention.working.keys()} needs={p.attention.needSids} />}
      {/* Not in the Crew: its faces end with their own Add (Teammates.tsx, Sidebar B). */}
      {!crewTab && <button
        type="button"
        onClick={onNew}
        className="sb-new group flex h-9 w-full items-center gap-2 rounded-lg border border-sidebar-border bg-[var(--card)] px-3 text-[13px] font-medium text-sidebar-accent-foreground shadow-xs outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        <PlusIcon className="size-4 text-[var(--text-muted)] group-hover:text-sidebar-accent-foreground" />
        {label}
        {kbd && <span className="dass-kbd">{shortcut("⌘K")}</span>}
      </button>}
    </div>
  );
}


const NEEDS_CLOSED_KEY = "friday.sidebar.needsClosed";

// ── the foot: you, the theme, Settings ──────────────────────────────────────────────────────

/**
 * The places as a row of icons at the sidebar's foot, in place of their list under New session (Arun, 2026-10-24: "remove these
 * tab buttons and just a group of SVG icon buttons ... placed at the bottom of the side bar"): the sessions get the room. Each
 * says its name as a tip, the one you are on is raised, and what waits on you stays on it as a count.
 */
function PlaceIcons({ p }: { p: SidebarProps }) {
  const team = !!p.workspace && planLimits(planNow(p.workspace)).team;
  const requests = team ? (p.peopleRequests ?? 0) : 0;
  const [usageCard, setUsageCard] = useState(false);
  // What the Needs you page lists, put off ones left out, as it counts them (Attention.tsx useNeedsCount).
  const waiting = useNeedsCount(p.attention);
  const places: { icon: IconName; label: string; on: boolean; go: () => void; warm?: SidebarProps["view"]; count?: number; needs?: boolean }[] = [
    ...(p.onOpenNeeds ? [{ icon: "hand" as const, label: "Needs you", on: p.view === "needs", go: p.onOpenNeeds, warm: "needs" as const, count: waiting || undefined, needs: true }] : []),
    { icon: "board", label: "Agent Board", on: p.view === "board", go: p.onOpenBoard, warm: "board" },
    { icon: "gitPullRequest", label: "Code Review", on: p.view === "review", go: p.onOpenReview, warm: "review", count: p.reviewsWaiting, needs: true },
    ...(team ? [{ icon: "book" as const, label: "Team library", on: p.view === "library", go: p.onOpenLibrary, warm: "library" as const }] : []),
    { icon: "zap", label: "Automations", on: p.view === "automations" || p.view === "agents", go: p.onOpenAutomations, warm: "automations" },
    { icon: "usage", label: "Usage", on: p.view === "usage", go: p.onOpenUsage, warm: "usage" },
    ...(team ? [{ icon: "users" as const, label: "People", on: p.view === "people", go: p.onOpenPeople, warm: "people" as const, count: requests || undefined, needs: requests > 0 }] : []),
  ];
  return (
    <nav className="sb-places" aria-label="Places">
      {places.map((x) => {
        const button = (
          <button type="button" className="sb-place" data-active={x.on || undefined} aria-current={x.on ? "page" : undefined} aria-label={x.count ? `${x.label}, ${x.count} waiting` : x.label} data-tour={x.label} onClick={x.go} onPointerEnter={() => x.warm && p.onWarm?.(x.warm)} onFocus={() => x.warm && p.onWarm?.(x.warm)}>
            <Icon name={x.icon} size={19} />
            {!!x.count && <span className={`sb-place-n${x.needs ? " needs" : ""}`}>{x.count > 99 ? "99+" : x.count}</span>}
          </button>
        );
        // Usage, with your coding tools' limits a short rest away: "how much have I got left?" needs no page. Not over the Usage page
        // itself, which says it all, and gone when the pointer leaves or the button is pressed (audit REST-10, Arun 2026-11-04).
        if (x.icon === "usage" && !x.on)
          return (
            <HoverCard key={x.label} openDelay={500} closeDelay={150} open={usageCard} onOpenChange={setUsageCard}>
              <HoverCardTrigger asChild onClick={() => setUsageCard(false)}>
                {button}
              </HoverCardTrigger>
              {/* Five tools of two bars each ran past the top of the window: the card stays short and scrolls (Arun, 2026-10-25). */}
              <HoverCardContent side="top" align="center" className="usage-card w-80 p-3">
                <div className="mb-2 text-xs font-medium text-[var(--text-muted)]">Usage · your coding tools' limits</div>
                <CodingToolLimits identity={p.identityForApi} />
              </HoverCardContent>
            </HoverCard>
          );
        return (
          <Tooltip key={x.label}>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent side="top">{x.label}</TooltipContent>
          </Tooltip>
        );
      })}
    </nav>
  );
}

/**
 * The open-source build's places as a rail down the sidebar's left edge, as the production build has them (Arun, 2026-11-11: "use
 * the side bar design i have in the production build for the open source build"): Sessions and Agents, the two lists you work in,
 * then Needs you, the Board, Automations and Code review, with Usage and Settings at its foot. One icon each, named on its tip
 * and to a screen reader, what waits on you as a count, the place you're on lit. It takes the Code and Crew switch's place and
 * the dock's at the foot.
 */
function OssRail({ p }: { p: SidebarProps }) {
  const [crew] = useTeamTab();
  const waiting = useNeedsCount(p.attention);
  const [usageCard, setUsageCard] = useState(false);
  const t = useTeam(p.identityForApi);
  const mates = t ? ownOf(t) : [];
  const mateNeeds = mates.filter((m) => m.status === "waiting").length;
  const onPage = ["needs", "board", "deepdive", "review", "automations", "agents", "usage", "settings"].includes(p.view ?? "");
  // A place's page is lit; else the list you are in, Sessions or Agents.
  // Agents always opens the Agents page; Sessions leaves a page, or a crew chat, for a new session.
  const go = (place: "code" | "team") => {
    if (place === "team" || onPage || crew || (p.activeSid && isTeamSid(p.activeSid))) p.onNew();
    choosePlace(place);
  };
  const item = (o: { id: string; icon: IconName; label: string; on: boolean; go: () => void; n?: number | undefined; needs?: boolean; warm?: SidebarProps["view"]; tour?: string }) => {
    const button = (
      <button
        type="button"
        className="oss-rail-btn"
        data-active={o.on || undefined}
        aria-current={o.on ? "page" : undefined}
        aria-label={o.n ? `${o.label}, ${o.n} ${o.needs ? "waiting on you" : "new"}` : o.label}
        data-tour={o.tour ?? o.label}
        onClick={o.go}
        onPointerEnter={() => o.warm && p.onWarm?.(o.warm)}
        onFocus={() => o.warm && p.onWarm?.(o.warm)}
      >
        <Icon name={o.icon} size={19} />
        {!!o.n && <span className={`oss-rail-n${o.needs ? " needs" : ""}`} aria-hidden="true">{o.n > 9 ? "9+" : o.n}</span>}
      </button>
    );
    // Usage, with your coding tools' limits a short rest away (audit REST-10): not over the Usage page itself.
    if (o.id === "usage" && !o.on)
      return (
        <HoverCard key={o.id} openDelay={500} closeDelay={150} open={usageCard} onOpenChange={setUsageCard}>
          <HoverCardTrigger asChild onClick={() => setUsageCard(false)}>
            {button}
          </HoverCardTrigger>
          <HoverCardContent side="right" align="end" className="usage-card w-80 p-3">
            <div className="mb-2 text-xs font-medium text-[var(--text-muted)]">Usage · your coding tools' limits</div>
            <CodingToolLimits identity={p.identityForApi} />
          </HoverCardContent>
        </HoverCard>
      );
    return (
      <Tooltip key={o.id}>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="right">
          {o.label}
          {o.n ? <span className="ml-1 opacity-70">· {o.n}</span> : null}
        </TooltipContent>
      </Tooltip>
    );
  };
  // Up and down move along the rail, as along any toolbar.
  const onKey = (e: React.KeyboardEvent<HTMLElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const all = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    const to = e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length;
    all[to]?.focus();
  };
  return (
    <nav className="oss-rail" aria-label="Places" onKeyDown={onKey}>
      <div className="oss-rail-group">
        {item({ id: "sessions", icon: "chat", label: "Sessions", on: !crew && !onPage, go: () => go("code"), n: [...p.attention.needSids].filter((sid) => !isTeamSid(sid)).length || undefined, needs: true })}
        {item({ id: "agents", icon: "agent", label: "Agents", tour: "Crew", on: crew && !onPage, go: () => go("team"), n: mateNeeds || undefined, needs: true })}
      </div>
      <span className="oss-rail-sep" aria-hidden="true" />
      <div className="oss-rail-group">
        {p.onOpenNeeds && item({ id: "needs", icon: "hand", label: "Needs you", on: p.view === "needs", go: p.onOpenNeeds, warm: "needs", n: waiting || undefined, needs: true })}
        {item({ id: "board", icon: "board", label: "Agent Board", on: p.view === "board", go: p.onOpenBoard, warm: "board" })}
        {p.onOpenDeepDive && item({ id: "deepdive", icon: "puzzle", label: "Deep Dive", on: p.view === "deepdive", go: p.onOpenDeepDive, warm: "deepdive" })}
        {item({ id: "automations", icon: "zap", label: "Automations", on: p.view === "automations" || p.view === "agents", go: p.onOpenAutomations, warm: "automations" })}
        {item({ id: "review", icon: "gitPullRequest", label: "Code Review", on: p.view === "review", go: p.onOpenReview, warm: "review", n: p.reviewsWaiting || undefined, needs: true })}
      </div>
      <div className="oss-rail-foot">
        <UpdateRailButton />
        {item({ id: "usage", icon: "usage", label: "Usage", on: p.view === "usage", go: p.onOpenUsage, warm: "usage" })}
        {item({ id: "settings", icon: "settings", label: "Settings", on: p.view === "settings", go: p.onOpenSettings })}
      </div>
    </nav>
  );
}

/** Pages of their own, on the rail: none of them is the Sessions or the Agents list. */
const RAIL_PAGES = ["needs", "board", "deepdive", "review", "automations", "agents", "usage", "settings"];

/**
 * The list beside the rail: the crew's own on the Agents side (CrewList), New session and your sessions on the other, with no
 * agents in it (Arun, 2026-11-11: "also no agents in the coding session side bar too").
 */
function OssList({ p }: { p: SidebarProps }) {
  const [crew] = useTeamTab();
  if (crew && !RAIL_PAGES.includes(p.view ?? "")) return <CrewList p={p} />;
  return (
    <div className="sb-list flex min-w-0 flex-1 flex-col gap-2">
      <Head p={p} />
      {p.view === "agents" ? <AgentsList p={p} /> : <SessionsList p={p} />}
      <ListNotices p={p} />
    </div>
  );
}

/**
 * The Agents side's list, as OpenBot and Oh My Hermes keep theirs (Arun, 2026-11-11: "for the crew side bar.... there should be no
 * new session button", "follow like the same similar design as like OMH and openbot"): Agents and a + for a new one, a search,
 * the rooms with their faces and last words, then every agent with its role in a word, when it last spoke and its latest line,
 * who needs you first. No sessions: they are the Sessions side's.
 */
function CrewList({ p }: { p: SidebarProps }) {
  const t = useTeam(p.identityForApi);
  const focused = useFocusedAgent(t?.sid ?? "");
  const [q, setQ] = useState("");
  const [rooming, setRooming] = useState(false);
  if (!t) return <div className="sb-list oss-crew flex min-w-0 flex-1 flex-col" />;
  const has = (...words: (string | null | undefined)[]) => !q.trim() || words.some((w) => w?.toLowerCase().includes(q.trim().toLowerCase()));
  const rank = (s: string) => (s === "waiting" ? 0 : s === "stopped" ? 1 : s === "working" ? 2 : 3);
  const mates = [...ownOf(t)].sort((a, b) => rank(a.status) - rank(b.status) || (b.lastAt ?? 0) - (a.lastAt ?? 0)).filter((m) => has(m.name, m.role));
  const lead = ownOf(t).find((m) => m.lane === t.lead);
  const rooms: { key: string; name: string; seeds: string[]; line: string; at?: number; here: boolean; open: () => void }[] = [
    { key: "crew", name: "Crew room", seeds: ownOf(t).slice(0, 4).map((m) => m.look ?? m.name), line: t.last ? `${t.last.by}: ${t.last.text}` : lead ? `${lead.name} leads` : "Where your crew works together", ...(t.last?.at ? { at: t.last.at } : {}), here: p.activeSid === t.sid && focused === ALL_AGENTS, open: () => openTeammate(t, null, p.onOpen) },
    ...(t.rooms ?? []).map((r: RoomView) => ({ key: r.id, name: r.name, seeds: ownOf(t).filter((m) => r.lanes[m.id]).slice(0, 4).map((m) => m.look ?? m.name), line: r.last ? `${r.last.by}: ${r.last.text}` : `${Object.keys(r.lanes).length} in it`, ...(r.last?.at ? { at: r.last.at } : {}), here: p.activeSid === r.sid, open: () => openRoom(r, p.onOpen) })),
  ].filter((r) => has(r.name));
  const onPage = !p.activeSid;
  return (
    <div className="sb-list oss-crew flex min-w-0 flex-1 flex-col" role="group" aria-label="Your crew">
      <div className="oss-crew-head">
        <button type="button" className="oss-crew-title mr-auto" data-active={onPage || undefined} onClick={() => (p.onNew(), choosePlace("team"))} title="All your agents, what needs you and what finished today">
          Agents
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="oss-agents-add" aria-label="New agent" onClick={newTeammate}>
              <PlusIcon aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">New agent</TooltipContent>
        </Tooltip>
        {/* In a browser, the sidebar's own fold, as the Sessions side has it; the desktop app's window bar has its own. */}
        {!window.fridayDesktop && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="dass-rail-btn sidebar-fold size-8" aria-label="Hide the sidebar" onClick={() => window.dispatchEvent(new Event("friday:fold-sidebar"))}>
                <Icon name="sidebar" size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Hide the sidebar <span className="dass-kbd ml-2">{shortcut("⌘B")}</span>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      <label className="oss-crew-search">
        <SearchIcon aria-hidden="true" />
        <input type="search" placeholder="Search" aria-label="Search agents and rooms" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQ("")} />
      </label>
      <div className="oss-crew-scroll">
        {(rooms.length > 0 || !q.trim()) && (
        <div className="oss-crew-label">
          <span>Rooms</span>
          <button type="button" className="oss-agents-add" aria-label="New room for a project" title="New room for a project" onClick={() => setRooming(true)}>
            <PlusIcon aria-hidden="true" />
          </button>
        </div>
        )}
        {rooms.map((r) => (
          <button key={r.key} type="button" className="oss-crew-row" data-active={r.here || undefined} onClick={r.open}>
            <RoomFaces seeds={r.seeds} size={30} />
            <span className="oss-crew-text">
              <span className="oss-crew-top">
                <b>{r.name}</b>
                {r.at ? <span className="oss-crew-when">{shortAgo(r.at)}</span> : null}
              </span>
              <span className="oss-crew-line">{r.line}</span>
            </span>
          </button>
        ))}
        <div className="oss-crew-label">
          <span>Your crew</span>
          <span className="oss-crew-count">{ownOf(t).length}</span>
        </div>
        {mates.map((m) => {
          const s = mateStatus(m);
          const chip = t.lead === m.lane ? "Lead" : roleWord(m.role ?? "");
          return (
            <button key={m.id} type="button" className="oss-crew-row" data-active={(p.activeSid === t.sid && focused === m.lane) || undefined} onClick={() => openTeammate(t, m.lane, p.onOpen)}>
              <Face seed={m.look ?? m.name} size={30} status={m.status} lead={t.lead === m.lane} />
              <span className="oss-crew-text">
                <span className="oss-crew-top">
                  <b>{m.name}</b>
                  {chip && <span className="oss-crew-chip">{chip}</span>}
                  {m.lastAt ? <span className="oss-crew-when">{shortAgo(m.lastAt)}</span> : null}
                </span>
                <span className={`oss-crew-line s-${s.state}`}>{freeLine(m, s)}</span>
              </span>
            </button>
          );
        })}
        {q.trim() && !mates.length && !rooms.length && <p className="oss-crew-none">Nothing called “{q.trim()}”.</p>}
        {!q.trim() && !mates.length && (
          <button type="button" className="oss-agent oss-agent-first" onClick={() => (choosePlace("team"), p.onNew())}>
            <span className="oss-agent-plus" aria-hidden="true">
              <PlusIcon />
            </span>
            <span className="oss-agent-text">
              <span className="oss-agent-name">Make your first agent</span>
              <span className="oss-agent-line">A coworker with its own memory</span>
            </span>
          </button>
        )}
      </div>
      {rooming && p.identityForApi && <RoomDialog identity={p.identityForApi} team={t} editing={null} onClose={() => setRooming(false)} onMade={(r) => openRoom(r, p.onOpen)} />}
    </div>
  );
}

/** "now", "4m", "2h", "Tue": when, as a list row says it. */
function shortAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(ts).toLocaleDateString([], { weekday: "short" });
}

/** With the rail, the foot's notices sit at the list's foot: the usage question once, then the word about Friday Team. */
function ListNotices({ p }: { p: SidebarProps }) {
  const usageNoticeUp = noticeDue(useUsageSharing());
  if (usageNoticeUp) return <div className="sb-list-foot"><UsageNotice /></div>;
  return p.recents.filter((r) => !isTeamSid(r.sid)).length >= 3 ? <div className="sb-list-foot"><TeamTip className="in-foot" /></div> : null;
}

function Foot({ p }: { p: SidebarProps }) {
  const [look, setLook] = useState(currentLook);
  // Whatever changes the look (Settings, the system going dark at night, another window) changes this button too: it read the
  // look once, and offered "Switch to dark" over a dark page after Settings changed it (2026-10-27 audit).
  useEffect(() => {
    const mo = new MutationObserver(() => setLook(currentLook()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  const nextLook = look === "light" ? "dark" : "light";
  // Light or dark here is Friday's own, as in Settings: a colour theme on (Dracula, one of yours) comes off, or the button only
  // flipped the class under it and left a mix nobody could read (2026-10-27 audit).
  const switchLook = () => {
    if (readTheme()) applyTheme(null);
    chooseTheme(nextLook);
    setLook(currentLook());
  };
  const usageNoticeUp = noticeDue(useUsageSharing());
  const w = p.workspace;
  // The local edition has no plan: it is yours, on this computer.
  const plan = w?.limits?.name ?? (isLocal() ? "Local" : "Free");
  return (
    // Its line runs the sidebar's full width, edge to edge, level with the page's footer line beside it.
    <div className="dass-foot -mx-[10px] mt-auto flex shrink-0 flex-col justify-center gap-1 border-t border-sidebar-border px-[14px]">
      {/* The usage notice, once, takes the tip's place in the foot until it is answered. */}
      {/* The word about Friday Team once someone has used Friday a while, not in their first minutes (2026-11-01, the first run). */}
      {isLocal() && (usageNoticeUp ? <UsageNotice /> : p.recents.filter((r) => !isTeamSid(r.sid)).length >= 3 ? <TeamTip className="in-foot" /> : null)}
      {/* One card at the foot (Arun, 2026-10-26: "integrate the profile thing, light and dark mode and settings button into the
          card where the agent board, code review and usage buttons are"): the places on top, who you are and the app's own
          controls under them. */}
      {/* One row (Arun, 2026-10-26: "in a row together, the profile thing can just be the circle"): you, as your avatar, then
          the places, then the theme and settings. Your name and plan are in the menu the avatar opens. */}
      <div className="sb-dock sb-tray">
        {/* No account on your own computer, so no avatar and its menu (Arun, 2026-10-26: "get rid of the profile button"). */}
        <PlaceIcons p={p} />
        <UpdateRailButton />
        {/* In the open-source edition, with no profile menu, Settings stays in the dock, alone at its right end, apart from the
            places. No light and dark button beside it (Arun, 2026-11-03: "rework the bottom of the side bar with all of the
            buttons... we need to work with space too"): Settings and ⌘K have it. The hosted service has both in the menu. */}
        {isLocal() && <span className="sb-tray-sep" aria-hidden="true" />}
        {/* Send feedback lives in Settings › About, not here (Arun, 2026-11-01: "add the send feed back button out of the side bar
            and into the settings page... for open source"). */}
        {isLocal() && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="dass-rail-btn sb-dock-settings size-8" data-active={p.view === "settings"} aria-label="Settings" onClick={p.onOpenSettings}>
                <Icon name="settings" size={19} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Settings</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

/** What deleting a session does, truly, in the session's own terms (w3 P2-6). */
let deleteBody = (_r: RecentSession): string => "It's deleted for everyone in it, with its history and files. This can't be undone.";
deleteBody = (r) =>
  isWorkSid(r.sid)
    ? `Its chat and history go, for everyone in it. ${r.repos?.[0]?.name ? `Its folder, ${r.repos[0].name},` : "Its folder"} stays on your computer with everything the agents saved in it. This can't be undone.`
    : "It's deleted for everyone in it, with its history and files. This can't be undone.";

// ── a group of the list: a label that folds it, an action, and its rows ─────────────────────

function Group({ label, open, onToggle, count, status, action, drag, children, className = "" }: { label: ReactNode; open: boolean; onToggle: () => void; count?: number; /** How it stands, at the row's end, folded or not. */ status?: ReactNode; action?: ReactNode; drag?: Partial<React.HTMLAttributes<HTMLDivElement>>; children: ReactNode; className?: string }) {
  return (
    <SidebarGroup className={`sb-tray p-0 ${className}`}>
      <Collapsible open={open} onOpenChange={onToggle}>
        <div className="group/label relative flex items-center" {...drag}>
          <SidebarGroupLabel asChild className="h-7 flex-1 cursor-pointer gap-1 px-2 text-[12px] font-medium normal-case tracking-normal text-[var(--text-muted)] hover:text-sidebar-accent-foreground">
            <CollapsibleTrigger>
              <ChevronRightIcon className={`size-3 transition-transform duration-200 ${open ? "rotate-90" : ""}`} />
              <span className="flex min-w-0 items-center gap-1.5 truncate">{label}</span>
              {!!count && <span className="ml-1 font-normal normal-case tracking-normal">{count}</span>}
              {status && <span className="ml-auto flex items-center pl-2">{status}</span>}
            </CollapsibleTrigger>
          </SidebarGroupLabel>
          {action}
        </div>
        <CollapsibleContent>
          <SidebarGroupContent className="flex flex-col gap-px pt-0.5">{children}</SidebarGroupContent>
        </CollapsibleContent>
      </Collapsible>
    </SidebarGroup>
  );
}

// ── the agents (on the Agents page) ─────────────────────────────────────────────────────────

function AgentsList({ p }: { p: SidebarProps }) {
  const agentRecords = useAgentRecords(p.identityForApi, p.agents.map((a) => `${a.id}:${a.updatedAt}`).join(","));
  const [open, setOpen] = useState(true);
  const [ctx, setCtx] = useState<{ id: string; x: number; y: number } | null>(null);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1">
      <Group
        label="Your agents"
        open={open}
        onToggle={() => setOpen((v) => !v)}
        count={p.agents.length || undefined}
        action={
          p.onImportAgents && (
            <SidebarGroupAction title="Import agents from Claude Code, Cursor or Codex" onClick={p.onImportAgents} className="top-1">
              <Icon name="download" size={14} />
            </SidebarGroupAction>
          )
        }
      >
        {p.agentSel === null && (
          <div className="dass-row" data-active="true">
            <div className="flex items-center gap-2">
              <span className="dass-dot" data-state="idle" />
              <span className="dass-row-title">Untitled agent</span>
              <span className="chip-mini">Draft</span>
            </div>
          </div>
        )}
        {p.agents.map((a) => {
          const rec = recordLine(agentRecords[a.id]);
          return (
            <div
              key={a.id}
              role="button"
              tabIndex={0}
              className="dass-row"
              data-active={p.agentSel === a.id}
              onClick={() => p.onSelectAgent(a.id)}
              onKeyDown={(e) => activates(e) && p.onSelectAgent(a.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setCtx({ id: a.id, x: e.clientX, y: e.clientY });
              }}
            >
              <div className="flex items-center gap-2">
                <Icon name="agent" size={14} />
                <span className="dass-row-title" title={a.name}>
                  {a.name || "Untitled agent"}
                </span>
                {a.access === "shared" && <span className="text-[12px] text-[var(--text-muted)]">shared</span>}
                <span className="dass-row-act">
                  <MenuButton label={`${a.name} actions`} items={() => p.agentMenu(a)} />
                </span>
              </div>
              {rec && <div className="dass-row-sub">This week: {rec}</div>}
            </div>
          );
        })}
        {p.agents.length === 0 && <p className="px-2 py-1 text-xs text-[var(--text-muted)]">No agents yet. New agent starts one.</p>}
      </Group>
      {ctx && p.agents.find((a) => a.id === ctx.id) && <ContextMenu at={ctx} items={() => p.agentMenu(p.agents.find((a) => a.id === ctx.id)!)} onClose={() => setCtx(null)} />}
    </div>
  );
}

// ── the sessions ────────────────────────────────────────────────────────────────────────────

function SessionsList({ p }: { p: SidebarProps }) {
  const [renaming, setRenaming] = useState<Renaming>(null);
  // Deleting a project is the one thing in this list that is not undoable, so it asks first.
  const [ask, confirmUI] = useConfirm();
  const [drop, setDrop] = useState<string | null>(null);
  // A session being dragged, from anywhere in the list: Recent stays out while that drag lasts, so a session can be dragged out
  // of a project onto it. It showed only while the pointer was over the project, and left again on the way to it (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const start = (e: globalThis.DragEvent) => e.dataTransfer?.types.includes(DRAG_TYPE) && setDragging(true);
    const end = () => setDragging(false);
    addEventListener("dragstart", start);
    addEventListener("dragend", end);
    addEventListener("drop", end);
    return () => (removeEventListener("dragstart", start), removeEventListener("dragend", end), removeEventListener("drop", end));
  }, []);
  const [folded, setFolded] = useState<string[]>(loadFolded);
  /** The order the sections were dragged into, the one being dragged, and where it would land. */
  const [order, setOrder] = useState<string[]>(loadSectionOrder);
  const [dragSec, setDragSec] = useState<string | null>(null);
  const [secOver, setSecOver] = useState<{ id: string; after: boolean } | null>(null);
  const [projectCtx, setProjectCtx] = useState<{ id: string; x: number; y: number } | null>(null);
  const [panelCtx, setPanelCtx] = useState<{ x: number; y: number } | null>(null);
  /** The sessions "Needs you" was closed for: hidden from it until they stop waiting and wait again. */
  const [dismissed, setDismissed] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(NEEDS_CLOSED_KEY) ?? "[]") as string[];
    } catch {
      return [];
    }
  });

  const isOpen = (id: string) => !folded.includes(id);
  const toggle = (id: string) => {
    const next = folded.includes(id) ? folded.filter((x) => x !== id) : [...folded, id];
    setFolded(next);
    saveFolded(next);
  };
  /** A section's label can be dragged to move the whole section. */
  const dragSection = (id: string) => ({
    draggable: true,
    title: "Drag to move this section",
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData(SECTION_TYPE, id);
      e.dataTransfer.effectAllowed = "move";
      setDragSec(id);
    },
    onDragEnd: () => (setDragSec(null), setSecOver(null)),
  });

  const label = (r: RecentSession) => r.alias || r.title;
  // The clock the snoozes and settling read, moved on once a minute so a snooze ends while the sidebar is up.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  // Snoozed and settled sessions sit in folded groups at the foot (sidebar-buckets.ts); only one that needs you or has an
  // agent working comes back by itself.
  // A session whose pull request has merged has landed its work: it settles by itself. The merge is known from the session's own
  // log (a shepherded pull request) or from GitHub, through the pull requests your computer reads for Code Review.
  const { prs: github } = usePrs();
  const mergedUrls = new Set((github?.merged ?? []).map((x) => x.url));
  const merged = new Set([...p.attention.prs].filter(([, pr]) => pr.merged || mergedUrls.has(pr.url)).map(([sid]) => sid));
  // The sessions this list shows.
  let listed = p.recents;
  let teamTab = false;
  teamTab = useTeamTab()[0];
  // Kept fresh on every tab, so the team's session stays out of Code's list and its robots show wherever it is open.
  useTeam(p.identityForApi);
  // Which sessions are Work ones, still told apart for what deleting one does (deleteBody).
  useWorkSessions(p.identityForApi);
  // The hosted service's Crew: its sessions (your own Crew room and the rooms) kept out of Code's list.
  // Every session but a Crew room, Work ones made before Work was taken out included (Arun, 2026-11-03).
  if (isLocal()) listed = p.recents.filter((r) => !isTeamSid(r.sid));
  const beds = buckets(
    [...listed].sort((a, b) => b.openedAt - a.openedAt),
    { needs: p.attention.needSids, working: new Set(p.attention.working.keys()), merged },
    now,
  );
  // Held in the order it stands while the pointer or the keyboard is in the list, so the row under them doesn't move as the list
  // re-sorts; a new session still goes on top, and the rest settle once they leave (Arun, 2026-10-28: "iron everything and
  // ensure we are good… any logic errors and fixes").
  const [pointerIn, setPointerIn] = useState(false);
  const flip = useFlip<HTMLDivElement>();
  const [focusIn, setFocusIn] = useState(false);
  // Needs you, then working, then the rest, within each group (owner call D); a row that moves slides there (useFlip).
  // What waits on you is what the Needs you page lists, a plan stopped short included, and not what was put off there: the group
  // left out STORM and QUESTIONS while the page listed them, and kept one put off (2026-11-04 retest).
  const needSet = p.attention.needSids;
  const unreadNow = useUnread();
  // A finished one you open keeps its place until you leave it, so it doesn't drop away under you as it stops being new (Herdr,
  // 2026-11-01). Read as it was the moment it was opened: App lets go of its unread mark just after.
  const doneHeld = useRef<{ sid: string | null; done: boolean }>({ sid: null, done: false });
  if (doneHeld.current.sid !== p.activeSid) doneHeld.current = { sid: p.activeSid, done: !!p.activeSid && unreadNow.has(p.activeSid) };
  const isDone = (sid: string) => unreadNow.has(sid) || (doneHeld.current.done && sid === doneHeld.current.sid);
  // Needs you, finished and unread, working, gone quiet (working, nothing heard in a while: crewQuiet), then the rest. Within each,
  // the one that came to stand so most recently first (Orca's smart sort, Arun 2026-11-03): a turn that just started over one
  // that has run an hour, the latest to finish over the earlier. The rest, by when you last opened them.
  const stateOf = (r: RecentSession) => (needSet.has(r.sid) ? "needs" : p.attention.working.has(r.sid) ? (crewQuiet(p.attention.crews.get(r.sid), now) ? "quiet" : "working") : isDone(r.sid) ? "done" : null);
  const keyOf = (r: RecentSession) => (stateOf(r) ? (p.attention.since.get(r.sid) ?? r.openedAt) : r.openedAt);
  const activeIds = byState([...beds.active].sort((a, b) => keyOf(b) - keyOf(a)), stateOf).map((r) => r.sid);
  // Held while the pointer or keyboard is in the list, so the row under them doesn't move; a burst of changes moves the rows once,
  // a moment after (sidebar-order.ts). New and gone rows come and go at once.
  const orderIds = useSettledOrder(activeIds, pointerIn || focusIn);
  const byId = new Map(beds.active.map((r) => [r.sid, r]));
  const sorted = orderIds.map((id) => byId.get(id)!);
  const projectIds = new Set(p.projects.map((x) => x.id));
  // Pinned ones sit in Pinned, in the order pinned, and only there (Herdr's pins, 2026-11-01).
  const pinned = sorted.filter((r) => r.pinnedAt).sort((a, b) => a.pinnedAt! - b.pinnedAt!);
  const loose = sorted.filter((r) => !r.pinnedAt && !(r.projectId && projectIds.has(r.projectId)));
  const pin = (r: RecentSession) => p.updateRecent(r.sid, r.pinnedAt ? { pinnedAt: undefined } : { pinnedAt: Date.now(), snoozedUntil: undefined, settledAt: undefined });

  const newProject = () => {
    const id = p.createProject("New project");
    setRenaming({ kind: "project", id, fresh: true });
  };

  // Drag a session onto a project (or onto Recent to unfile it).
  const dropZone = (target: string | null) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDrop(target ?? "__recent");
    },
    onDragLeave: (e: DragEvent) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDrop(null);
    },
    onDrop: (e: DragEvent) => {
      const sid = e.dataTransfer.getData(DRAG_TYPE);
      setDrop(null);
      if (!sid) return;
      e.preventDefault();
      p.updateRecent(sid, { projectId: target ?? undefined });
      if (target) p.updateProject(target, { collapsed: false });
    },
  });

  /**
   * Renamed here: its owner renames the session itself, for everyone and everywhere it shows (the header, the tab, ⌘K, Search,
   * the server), as the header's rename does; anyone else, who may not, gives it a name of their own in this list (2026-10-27
   * QA: the sidebar's rename was only ever that name of one's own). Refused, the name stays as one's own.
   */
  const renameSession = async (r: RecentSession, name: string) => {
    const title = name.trim();
    if (!title || title === (r.alias || r.title)) return;
    if (r.role !== "owner") return p.updateRecent(r.sid, { alias: title });
    p.updateRecent(r.sid, { title, alias: undefined });
    try {
      const done = await api<{ title: string }>(p.identity, `/api/sessions/${encodeURIComponent(r.sid)}/title?invite=${encodeURIComponent(r.invite)}`, { method: "POST", body: JSON.stringify({ title }) });
      if (done.title && done.title !== title) p.updateRecent(r.sid, { title: done.title });
    } catch {
      p.updateRecent(r.sid, { title: r.title, alias: title });
    }
  };

  /**
   * The pull requests a session opened, in its menu and on right-click (Arun, 2026-11-02: "be able to open the PR or merge etc
   * too with right click or the dropdown"): each opens on GitHub, and one ready to merge has Merge at its end, asked first, done
   * as Code Review does it (squash, through this computer's GitHub login). Newest first, four at most; the badge has them all.
   */
  const prItems = (sid: string): MenuItem[] => {
    const urls = [...(p.attention.prs.get(sid)?.urls ?? [])].reverse();
    if (!urls.length) return [];
    const known = new Map([...(github?.merged ?? []), ...(github?.review ?? []), ...(github?.mine ?? [])].map((x) => [x.url, x]));
    const merge = (pr: NonNullable<ReturnType<typeof known.get>>) =>
      ask({
        title: `Squash and merge #${pr.number}?`,
        body: `${pr.title} goes into ${pr.base || "its base branch"} in ${pr.repo}. This can't be undone from here.`,
        action: "Squash and merge",
        danger: false,
        onConfirm: () =>
          void hostApi<{ note?: string }>(p.identityForApi, "/api/runner/pr.act", { method: "POST", body: JSON.stringify({ url: pr.url, action: "merge", method: "squash", head: pr.head, id: pr.id }) }).then(
            (r) => sayNotice(r.note ?? `Merged #${pr.number}.`),
            (e: Error) => sayNotice(`Couldn't merge #${pr.number}: ${e.message}`),
          ),
      });
    return [
      { heading: urls.length === 1 ? "Pull request" : "Pull requests" },
      ...urls.slice(0, 4).map((url): MenuItem => {
        const pr = known.get(url);
        const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
        const where = m ? `${m[1]} #${m[2]}` : url;
        const isMerged = !!pr && (!!pr.mergedAt || (github?.merged ?? []).some((x) => x.url === url));
        const ready = !!pr && !isMerged && !pr.draft && pr.mergeable !== false;
        return {
          label: pr?.title ?? where,
          icon: isMerged ? "gitFork" : "gitPullRequest",
          sub: `${isMerged ? "Merged" : pr?.draft ? "Draft" : "Open"}${pr ? ` · ${where}` : ""}`,
          onSelect: () => openOutside(url),
          ...(ready ? { action: { icon: "check" as const, label: `Squash and merge #${pr!.number}`, onSelect: () => merge(pr!) } } : {}),
        };
      }),
      { heading: "Session" },
    ];
  };
  const chatMenu = (r: RecentSession): MenuItem[] => [
    ...prItems(r.sid),
    { label: "Open in new tab", icon: "external", onSelect: () => window.open(`/?session=${encodeURIComponent(r.sid)}&invite=${encodeURIComponent(r.invite)}`, "_blank") },
    // Said in the app's notice, not an alert that froze the page; and not offered where it can't be done (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
    canFork(p.attention.crews.get(r.sid), isLocal()) ? { label: "Fork session", icon: "gitFork", onSelect: () => void forkSession(r.sid, r.invite).then((e) => e && sayNotice(e)) } : null,
    { label: "Rename session", icon: "pencil", onSelect: () => setRenaming({ kind: "session", id: r.sid }) },
    // New again on every device, as a mail list's "Mark as unread" (Herdr's most-asked-for, 2026-11-01): its last finished turn unread.
    r.sid !== p.activeSid && !unreadNow.has(r.sid) ? { label: "Mark as unread", icon: "mail", onSelect: () => (markUnread([r.sid]), void api(p.identityForApi, `/api/sessions/${encodeURIComponent(r.sid)}/unread`, { method: "POST" }).catch(() => {})) } : null,
    { label: r.pinnedAt ? "Unpin" : "Pin to top", icon: "pin", onSelect: () => pin(r) },
    r.alias ? { label: "Use the original title", icon: "refresh", onSelect: () => p.updateRecent(r.sid, { alias: undefined }) } : null,
    // Up with the session's own actions, in sight without scrolling (Arun, 2026-11-11: "make it easy to delete the session like it
    // needs to be visible and not have to scroll"); it still asks before it deletes.
    { heading: "" },
    // Yours to delete: gone for everyone in it, with its history and files. Anyone else's only leaves your list.
    r.role === "owner"
      ? {
          label: "Delete session",
          icon: "trash",
          danger: true,
          onSelect: () =>
            ask({
              title: `Delete ${r.alias || r.title || "this session"}?`,
              body: deleteBody(r),
              action: "Delete session",
              onConfirm: () => void p.deleteSession(r.sid).then((e) => e && sayNotice(e)),
            }),
        }
      : { label: "Remove from recents", icon: "x", onSelect: () => p.removeRecent(r.sid) },
    // Out of the way for a while, or for good until something happens in it (sidebar-buckets.ts).
    { heading: r.snoozedUntil && r.snoozedUntil > now ? `Snoozed ${snoozeWord(r.snoozedUntil, now)}` : "Snooze" },
    ...(r.snoozedUntil && r.snoozedUntil > now ? [{ label: "Wake it now", icon: "bell" as const, onSelect: () => p.updateRecent(r.sid, { snoozedUntil: undefined }) }] : []),
    ...snoozePresets(now).map((s) => ({ label: s.label, icon: "clock" as const, onSelect: () => p.updateRecent(r.sid, { snoozedUntil: s.until, settledAt: undefined, pinnedAt: undefined }) })),
    // Settling is not a snooze: a group of its own, not under Snooze's heading (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
    { heading: "" },
    r.settledAt
      ? { label: "Back to the list", icon: "refresh" as const, onSelect: () => p.updateRecent(r.sid, { settledAt: undefined }) }
      : { label: "Settle it", icon: "check" as const, title: "Done with it for now: it moves to Settled at the foot of the list, and comes back if anything in it needs you", onSelect: () => p.updateRecent(r.sid, { settledAt: now, snoozedUntil: undefined, pinnedAt: undefined }) },
    { heading: "Move to project" },
    ...p.projects.map((proj) => ({ label: proj.name, icon: "folder" as const, checked: r.projectId === proj.id, onSelect: () => p.updateRecent(r.sid, { projectId: proj.id }) })),
    {
      label: "New project…",
      icon: "plus",
      onSelect: () => {
        const id = p.createProject("New project");
        p.updateRecent(r.sid, { projectId: id });
        setRenaming({ kind: "project", id, fresh: true });
      },
    },
    r.projectId ? { label: "Remove from project", icon: "x", onSelect: () => p.updateRecent(r.sid, { projectId: undefined }) } : null,
  ];

  const projectMenu = (proj: Project, count: number): MenuItem[] => [
    { label: "New session here", icon: "plus", onSelect: () => p.onNew(proj.id) },
    { label: "Rename", icon: "pencil", onSelect: () => setRenaming({ kind: "project", id: proj.id }) },
    { heading: "" },
    {
      label: "Delete project",
      icon: "trash",
      danger: true,
      hint: count ? "keeps sessions" : undefined,
      onSelect: () => ask({ title: `Delete ${proj.name}?`, body: count ? "Its sessions go back to Recent." : undefined, action: "Delete project", onConfirm: () => p.deleteProject(proj.id) }),
    },
  ];

  const row = (r: RecentSession, compact = false, quiet?: string) => (
    <ChatRow
      key={r.sid}
      r={r}
      {...(quiet ? { quiet } : {})}
      me={p.identity.name}
      active={r.sid === p.activeSid}
      renaming={renaming?.kind === "session" && renaming.id === r.sid}
      label={label(r)}
      compact={compact}
      onOpen={() => p.onOpen(r)}
      onRename={(name) => {
        setRenaming(null);
        void renameSession(r, name);
      }}
      onCancelRename={() => setRenaming(null)}
      working={p.attention.working.get(r.sid) ?? null}
      needs={p.attention.items.find((i) => i.sid === r.sid) ?? null}
      waiting={p.attention.needSids.has(r.sid)}
      preview={p.attention.previews.get(r.sid) ?? null}
      summary={p.attention.summaries.get(r.sid) ?? null}
      crew={p.attention.crews.get(r.sid) ?? null}
      since={p.attention.since.get(r.sid)}
      prs={p.attention.prs.get(r.sid)?.urls ?? []}
      onPin={() => pin(r)}
      menu={() => chatMenu(r)}
    />
  );

  // Sessions waiting on you, pulled to the top: what needs you first (Dass: "what needs you rises"). Closed with its ×, it
  // stays closed for the ones waiting then, and comes back with any session that starts waiting after (Arun, 2026-10-20).
  const needsIds = [...needSet];
  const needing = needsIds.flatMap((sid) => sorted.filter((r) => r.sid === sid)).filter((r) => !dismissed.includes(r.sid));
  // Said once: a session in Needs you leaves its own group (pinned, project, folder or Recent) while it waits, and goes back
  // when it stops waiting or Needs you is closed (audit CODE-1 B, Arun 2026-11-04).
  const inNeeds = new Set(needing.map((r) => r.sid));
  const pinnedShown = pinned.filter((r) => !inNeeds.has(r.sid));
  // A closed session that has stopped waiting is forgotten, so the next time it waits it shows again.
  const waitingKey = needsIds.join(",");
  // Not before the first look has answered: until then nothing reads as waiting, and every closed one was forgotten on a reload (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
  useEffect(() => {
    if (!p.attention.loaded || !dismissed.some((sid) => !needsIds.includes(sid))) return;
    const kept = dismissed.filter((sid) => needsIds.includes(sid));
    setDismissed(kept);
    try {
      localStorage.setItem(NEEDS_CLOSED_KEY, JSON.stringify(kept));
    } catch {
      /* a preference */
    }
  }, [waitingKey, p.attention.loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  const dismissNeeds = () => {
    const next = [...new Set([...dismissed.filter((sid) => needsIds.includes(sid)), ...needsIds])];
    setDismissed(next);
    try {
      localStorage.setItem(NEEDS_CLOSED_KEY, JSON.stringify(next));
    } catch {
      /* a preference */
    }
  };

  // Sessions that work in a repo are filed under its name, not under Recent. Projects win.
  const repoGroups = (() => {
    const by = new Map<string, { name: string; chats: RecentSession[] }>();
    for (const r of loose) {
      if (inNeeds.has(r.sid)) continue;
      const u = r.repos?.[0];
      if (!u) continue;
      const g = by.get(u.name) ?? { name: u.name, chats: [] };
      g.chats.push(r);
      by.set(u.name, g);
    }
    // A folder Friday made for one session ("ask-clean-out-folder-2") is no group of its own: its session stays in Recent until a
    // second one works there (audit CODE-20 A, Arun 2026-11-04: one-session groups with letter tiles fragmented the list).
    return [...by.values()].filter((g) => g.chats.length > 1 || !g.chats[0]!.repos?.[0]?.made);
  })();
  const filed = new Set(repoGroups.flatMap((g) => g.chats.map((c) => c.sid)));
  const unfiled = loose.filter((r) => !filed.has(r.sid) && !inNeeds.has(r.sid));

  const blocks = new Map<string, ReactNode>();
  if (p.projects.length > 0)
    blocks.set(
      "projects",
      <Group
        label="Projects"
        open={isOpen("projects")}
        onToggle={() => toggle("projects")}
        drag={dragSection("projects")}
        action={
          <SidebarGroupAction title="New project" onClick={newProject} className="top-1">
            <PlusIcon />
          </SidebarGroupAction>
        }
      >
        {p.projects.map((proj) => {
          const items = sorted.filter((r) => r.projectId === proj.id && !r.pinnedAt && !inNeeds.has(r.sid));
          // The new session about to go in it (its "New session here"): drawn in it, so it's plain where it will go (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
          const draft = p.draftProject === proj.id;
          const open = !proj.collapsed || draft;
          const isRenaming = renaming?.kind === "project" && renaming.id === proj.id;
          return (
            <div key={proj.id} className={`rounded-lg ${drop === proj.id ? "bg-sidebar-accent ring-1 ring-sidebar-ring" : ""}`} {...dropZone(proj.id)}>
              <div
                className="dass-row flex-row items-center gap-2 py-1"
                role="button"
                tabIndex={0}
                aria-expanded={open}
                onClick={() => !isRenaming && p.updateProject(proj.id, { collapsed: !proj.collapsed })}
                onKeyDown={(e) => activates(e) && !isRenaming && p.updateProject(proj.id, { collapsed: !proj.collapsed })}
                onDoubleClick={() => setRenaming({ kind: "project", id: proj.id })}
                onContextMenu={(e) => {
                  if (isRenaming) return;
                  e.preventDefault();
                  setProjectCtx({ id: proj.id, x: e.clientX, y: e.clientY });
                }}
              >
                <ChevronRightIcon className={`size-3 shrink-0 text-[var(--text-muted)] transition-transform duration-200 ${open ? "rotate-90" : ""}`} />
                <Icon name={open ? "folderOpen" : "folder"} size={14} />
                {isRenaming ? (
                  <InlineEdit
                    value={proj.name}
                    maxLength={40}
                    onSave={(name) => {
                      p.updateProject(proj.id, { name });
                      setRenaming(null);
                    }}
                    onCancel={() => {
                      // Escape on a project just made takes it away again: it had stayed as "New project" (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
                      if (renaming?.fresh && !items.length) p.deleteProject(proj.id);
                      setRenaming(null);
                    }}
                  />
                ) : (
                  <span className="dass-row-title flex-none! max-w-[70%]" title={proj.name}>
                    {proj.name}
                  </span>
                )}
                {/* Its count beside its name, as every group's is (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL"). */}
                {!isRenaming && <span className="shrink-0 text-[12px] tabular-nums text-[var(--text-muted)]">{items.length || ""}</span>}
                <span className="flex-1" />
                <span className="dass-row-act flex items-center">
                  <button
                    type="button"
                    className="dass-rail-btn size-6"
                    aria-label={`New session in ${proj.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onNew(proj.id);
                    }}
                  >
                    <PlusIcon className="size-3.5" />
                  </button>
                  <MenuButton label={`${proj.name} actions`} items={() => projectMenu(proj, items.length)} />
                </span>
              </div>
              {open && (
                <div className="ml-3 flex flex-col gap-px border-l border-sidebar-border pl-1">
                  {draft && (
                    <div className="dass-row" data-active="true" aria-current="page">
                      <div className="flex items-center gap-2">
                        <span className="dass-dot" data-state="idle" />
                        <span className="dass-row-title">New session</span>
                        <span className="chip-mini">Draft</span>
                      </div>
                    </div>
                  )}
                  {items.map((r) => row(r))}
                  {items.length === 0 && !draft && <p className="px-2 py-1 text-[12px] text-[var(--text-muted)] [text-wrap:pretty]">Drag sessions here, or press + to start one.</p>}
                </div>
              )}
            </div>
          );
        })}
      </Group>,
    );
  for (const g of repoGroups) {
    const id = `repo:${g.name}`;
    blocks.set(
      id,
      <Group
        label={
          <>
            {/* A coding app's scratch folder by a person's name for it, not "scratch-2026-11-03-c0317b" (Arun's e2e pass, 2026-11-04). */}
            <RepoTile name={folderName({ name: g.name, path: "" })} />
            <span className="truncate normal-case tracking-normal">{folderName({ name: g.name, path: "" })}</span>
          </>
        }
        open={isOpen(id)}
        onToggle={() => toggle(id)}
        count={g.chats.length}
        status={<GroupState working={g.chats.filter((c) => p.attention.working.has(c.sid)).length} />}
        drag={dragSection(id)}
      >
        {byDay(g.chats, now).map((x) => (typeof x === "string" ? <div key={`day:${x}`} className="sb-day">{x}</div> : row(x)))}
      </Group>,
    );
  }
  // Sessions there are, in a folder's group or waiting in Needs you: an empty Recent is then left out, never "Sessions you start or
  // join appear here" under three of them (audit e2e, Arun 2026-11-04).
  const elsewhere = repoGroups.length > 0 || inNeeds.size > 0;
  blocks.set(
    "recent",
    <div className={`rounded-lg ${drop === "__recent" ? "bg-sidebar-accent ring-1 ring-sidebar-ring" : ""}`} hidden={unfiled.length === 0 && elsewhere && !drop && !dragging} {...dropZone(null)}>
      <Group label="Recent" open={isOpen("recent")} onToggle={() => toggle("recent")} count={unfiled.length || undefined} status={<GroupState working={unfiled.filter((c) => p.attention.working.has(c.sid)).length} />} drag={dragSection("recent")}>
        {unfiled.length === 0 && !elsewhere ? <p className="px-2 py-1 text-xs text-[var(--text-muted)]">Sessions you start or join appear here.</p> : byDay(unfiled, now).map((x) => (typeof x === "string" ? <div key={`day:${x}`} className="sb-day">{x}</div> : row(x)))}
      </Group>
    </div>,
  );
  const defaults = [...(p.projects.length ? ["projects"] : []), ...repoGroups.map((g) => `repo:${g.name}`), "recent"];
  const ids = order.filter((id) => defaults.includes(id));
  for (const id of defaults) if (!ids.includes(id)) ids.splice(id !== "recent" && ids.includes("recent") ? ids.indexOf("recent") : ids.length, 0, id);
  const move = (id: string, onto: string, after: boolean) => {
    if (id === onto) return;
    const rest = ids.filter((x) => x !== id);
    rest.splice(rest.indexOf(onto) + (after ? 1 : 0), 0, id);
    setOrder(rest);
    saveSectionOrder(rest);
  };

  // The Team tab (Teammates.tsx): the sidebar is the team, not the sessions.
  if (teamTab && !isLocal()) return <div className="sb-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1"><SidebarTeammates identity={p.identityForApi} onOpen={p.onOpen} activeSid={p.activeSid} needs={p.attention.items} marks={p.attention.needs} /></div>;
  return (
    <div
      ref={flip}
      className="sb-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1"
      onPointerEnter={() => setPointerIn(true)}
      onPointerLeave={() => setPointerIn(false)}
      onFocus={() => setFocusIn(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setFocusIn(false)}
      onContextMenu={(e) => {
        if (e.isDefaultPrevented()) return;
        e.preventDefault();
        setPanelCtx({ x: e.clientX, y: e.clientY });
      }}
    >
      {confirmUI}
      {projectCtx &&
        (() => {
          const proj = p.projects.find((x) => x.id === projectCtx.id);
          if (!proj) return null;
          return <ContextMenu at={projectCtx} items={() => projectMenu(proj, sorted.filter((r) => r.projectId === proj.id).length)} onClose={() => setProjectCtx(null)} />;
        })()}
      {panelCtx && (
        <ContextMenu
          at={panelCtx}
          items={() => [
            { label: "New project", icon: "folder", onSelect: newProject },
            { label: "New session", icon: "compose", onSelect: () => p.onNew() },
          ]}
          onClose={() => setPanelCtx(null)}
        />
      )}
      {needing.length > 0 && (
        <Group
          label={
            <>
              <span className="sb-needs-icon" aria-hidden>
                <Icon name="clock" size={13} />
              </span>
              Needs you
            </>
          }
          open={isOpen("needs")}
          onToggle={() => toggle("needs")}
          count={needing.length}
          action={
            <SidebarGroupAction title="Close until something new waits on you" aria-label="Close Needs you" onClick={dismissNeeds} className="top-1">
              <XIcon />
            </SidebarGroupAction>
          }
          className="sb-group-needs"
        >
          {needing.map((r) => row(r, true))}
        </Group>
      )}
      {pinnedShown.length > 0 && (
        <Group
          label={
            <>
              <Icon name="pin" size={12} />
              Pinned
            </>
          }
          open={isOpen("pinned")}
          onToggle={() => toggle("pinned")}
          count={pinnedShown.length}
          status={<GroupState working={pinnedShown.filter((c) => p.attention.working.has(c.sid)).length} />}
        >
          {pinnedShown.map((r) => row(r))}
        </Group>
      )}
      {ids.map((id) => (
        <div
          key={id}
          className={`${dragSec === id ? "opacity-50" : ""} ${secOver?.id === id && dragSec !== id ? (secOver.after ? "border-b-2 border-sidebar-ring" : "border-t-2 border-sidebar-ring") : ""}`}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(SECTION_TYPE)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            const r = e.currentTarget.getBoundingClientRect();
            const after = e.clientY > r.top + r.height / 2;
            if (secOver?.id !== id || secOver.after !== after) setSecOver({ id, after });
          }}
          onDrop={(e) => {
            const from = e.dataTransfer.getData(SECTION_TYPE);
            if (!from) return;
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            move(from, id, e.clientY > r.top + r.height / 2);
            setDragSec(null);
            setSecOver(null);
          }}
        >
          {blocks.get(id)}
        </div>
      ))}
      {/* Put to bed (sidebar-buckets.ts): snoozed for a while, or settled; folded, counted, and back by themselves when something in
          one needs you. Folded by default, so the list is the live sessions. */}
      {beds.snoozed.length > 0 && (
        <Group label="Snoozed" open={folded.includes("open:snoozed")} onToggle={() => toggle("open:snoozed")} count={beds.snoozed.length} className="dass-bed">
          {beds.snoozed.map((r) => row(r, false, `Snoozed ${snoozeWord(r.snoozedUntil!, now)}`))}
        </Group>
      )}
      {beds.settled.length > 0 && (
        <Group label="Settled" open={folded.includes("open:settled")} onToggle={() => toggle("open:settled")} count={beds.settled.length} className="dass-bed">
          {beds.settled.map((r) => row(r, false, merged.has(r.sid) ? "Pull request merged" : r.settledAt ? "Settled" : /[a-z]/i.test(relTime(r.openedAt)) && !/^\d+[mhd]$/.test(relTime(r.openedAt)) ? `Quiet since ${relTime(r.openedAt)}` : `Quiet for ${relTime(r.openedAt)}`))}
        </Group>
      )}
    </div>
  );
}

/**
 * One session: its state, its name and when you were last in it, and under them in one quiet line what it is doing. Compact
 * (in Needs you) it is the name and what waits on you.
 */
/** A row's time in words, for its tooltip: "Working for 4m", "Waiting on you since just now", "Finished 12m ago". */
const stateFor = (st: "needs" | "working" | "done", t: string) =>
  st === "done" ? `Finished ${t === "now" ? "just now" : `${t} ago`}` : `${st === "needs" ? "Waiting on you" : "Working"} ${t === "now" ? "since just now" : `for ${t}`}`;

function ChatRow({
  r,
  me,
  active,
  renaming,
  label,
  preview,
  working,
  onOpen,
  onRename,
  onCancelRename,
  onPin,
  menu,
  compact = false,
  needs = null,
  summary = null,
  crew = null,
  quiet,
  since,
  prs = [],
  waiting = false,
}: {
  /** The Needs you page lists something of it that isn't put off (Attention.tsx needSids): its ring says so, and only then. */
  waiting?: boolean;
  /** The pull requests it opened (projection.ts prs): a mark on its row, each on hover (SessionPrs.tsx). */
  prs?: string[];
  /** Asleep (snoozed or settled): this in place of what is going on, since nothing is. */
  quiet?: string;
  /** Since when it has stood as it does (attention.ts sinceOf): its time is that, not when you last opened it. */
  since?: number | undefined;
  summary?: SessionSummary | null;
  /** Its agents and where each stands (attention.ts crewOf). */
  crew?: Crew | null;
  r: RecentSession;
  me: string;
  active: boolean;
  renaming: boolean;
  label: string;
  preview: Preview | null;
  working: Working | null;
  needs?: Attention | null;
  compact?: boolean;
  onOpen: () => void;
  onRename: (alias: string) => void;
  onCancelRename: () => void;
  /** Pin it to the top, or let it go back: the row's time turns into this on hover (Herdr, 2026-11-01). */
  onPin: () => void;
  menu: () => MenuItem[];
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  // Ticks a minute at a time, for "no update in 14m" and when a quiet agent's ring turns dashed.
  const now = useNow(30_000);
  const quietRing = working && !needs && crewQuiet(crew, now) && working.heardAt ? quietFor(working.heardAt, now) : undefined;
  const who = preview ? (preview.by === me ? "You" : preview.by.split(/\s+/)[0]) : "";
  const short = !needs && waiting && stoppedShort(crew, working);
  const state = needs || short || (waiting && !working) ? "needs" : working ? "working" : "idle";
  // Its agents finished while you were elsewhere, and you haven't opened it since (unread.ts).
  const unread = useUnread().has(r.sid) && !active && state === "idle";
  // The branch chip stays on the row (Arun, 2026-11-03: "keep the branch thing too"), with the room the agents' marks had, so
  // it is no longer cut to "2026-1…".
  const branchChip = true as boolean;
  const ref = useRef<HTMLDivElement>(null);
  // The open session is scrolled into view when it changes, so the list always shows where you are.
  useEffect(() => {
    if (active && !compact) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active, compact]);
  return (
    <div
      ref={ref}
      className="dass-row sb-row"
      data-sid={r.sid}
      data-flip={`${compact ? "n" : "l"}:${r.sid}`}
      data-active={active}
      data-unread={unread || undefined}
      data-menu={menuOpen || !!ctx}
      role="button"
      tabIndex={0}
      aria-current={active ? "page" : undefined}
      draggable={!renaming}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, r.sid);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => !renaming && onOpen()}
      onKeyDown={(e) => {
        if (renaming || e.target !== e.currentTarget) return;
        // Up and down move through the sessions, Home and End to either end, as a list does (2026-10-27 audit: Tab was the
        // only way through a hundred of them).
        const move = { ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity }[e.key];
        if (move !== undefined) {
          const rows = [...document.querySelectorAll<HTMLElement>(".dass-row")].filter((x) => x.getClientRects().length > 0);
          const at = rows.indexOf(e.currentTarget);
          const next = rows[Math.max(0, Math.min(rows.length - 1, Number.isFinite(move) ? at + move : move < 0 ? 0 : rows.length - 1))];
          if (next) (e.preventDefault(), next.focus());
          return;
        }
        if (activates(e)) onOpen();
      }}
      onContextMenu={(e) => {
        if (renaming) return;
        e.preventDefault();
        setCtx({ x: e.clientX, y: e.clientY });
      }}
      title={r.alias ? `${label} (${r.title})` : label}
    >
      {ctx && <ContextMenu at={ctx} items={menu} onClose={() => setCtx(null)} />}
      <div className="flex min-w-0 items-center gap-2">
        {/* New since you looked, or marked unread: an accent dot in the row's margin and its name in semibold, as a mail list does
            (audit CODE-8, Arun 2026-11-04: "Mark as unread" had changed nothing to see). */}
        {unread && !renaming && <span className="sb-unread-dot" aria-hidden="true" />}
        {/* The whole title line up to the time, opened at the name's start with the caret at its end (audit CODE-25, Arun 2026-11-04:
            a 135px field in a 260px row, scrolled to "tor the pricing table"). */}
        {renaming ? <InlineEdit className="sb-rename" value={label} onSave={onRename} onCancel={onCancelRename} caretAtEnd /> : <span className="dass-row-title">{label}{unread && <span className="sr-only">, new since you looked</span>}</span>}
        {!renaming && <SessionRing state={state} crew={crew} working={working} unread={unread} stopped={needs?.kind === "stopped"} quiet={quietRing} title={needs ? `${needs.kind === "stopped" ? "" : "Needs you: "}${shortPaths(needs.detail ?? needs.text)}` : working ? `Working now: ${working.what}` : undefined} />}
        {/* No count beside the ring (Arun, 2026-11-03: "get rid of the 3 next to the ring"): the line under the name says "3 working". */}
        {!renaming && <span className="sb-row-gap" aria-hidden="true" />}
        {!compact && <SessionPrBadge urls={prs} />}
        {/* How long it has stood as it does (Herdr's per-row timer, 2026-11-01): waiting on you, working, or finished; else when
            you last opened it. Said in full on hover. */}
        {/* The time and, on hover, the row's actions share one slot of a fixed width, so the name never changes length as the
            pointer passes (Arun, 2026-11-04: "the tab shouldnt change in size"). */}
        {(
        <span className="sb-row-end">
          <span className="dass-row-time shrink-0 text-[12px] tabular-nums text-[var(--text-muted)]" title={since && !quiet ? stateFor(needs || short ? "needs" : working ? "working" : "done", relTime(since)) : `Opened ${relTime(r.openedAt) === "now" ? "just now" : `${relTime(r.openedAt)} ago`}`}>
            {relTime(since && !quiet ? since : r.openedAt)}
          </span>
          {!renaming && <span className="dass-row-act shrink-0">
            <button
              type="button"
              className="icon-btn tiny sb-row-pin"
              data-pinned={!!r.pinnedAt || undefined}
              aria-label={r.pinnedAt ? `Unpin ${label}` : `Pin ${label} to the top`}
              aria-pressed={!!r.pinnedAt}
              title={r.pinnedAt ? "Unpin" : "Pin to top"}
              onClick={(e) => (e.stopPropagation(), onPin())}
            >
              <Icon name="pin" size={13} />
            </button>
            <MenuButton label={`Actions for ${label}`} items={menu} onOpenChange={setMenuOpen} />
          </span>}
        </span>
        )}
      </div>
      {(
        <div className="dass-row-sub">
          {quiet ? (
            <span className="truncate text-[var(--text-muted)]">{quiet}</span>
          ) : needs ? (
            // A stopped run says who stopped and how, from what happened (audit CODE-4: "Claude Code stopped with an error").
            <span className="truncate text-[var(--ink)]">{withCode(shortPaths(needs.kind === "stopped" ? stoppedRow(stopper(crew, needs), needs.detail ?? needs.text) : isRawError(needs.text) ? "Needs you" : needs.text))}</span>
          ) : compact && !short ? null : crew ? (
            <CrewLine crew={crew} now={now} />
          ) : summary ? (
            <>
              <span className={`truncate ${summary.column === "working" ? "text-[var(--ink-2)]" : ""}`}>
                {[summary.agent.replace(/^[^']+'s /, ""), summary.running > 1 ? `${summary.running} working` : summary.status, (summary.detail ? shortPaths(summary.detail) : "") || (summary.pr ? `PR ${summary.pr.number ? `#${summary.pr.number}` : "open"}` : "")].filter(Boolean).join(" · ")}
              </span>
            </>
          ) : working ? (
            // The agent at work by name, with its coding tool's mark beside it (Arun, 2026-10-20: "China" is a renamed agent, and
            // the mark says what it runs on). Friday Code's own lane gets Friday's mark when it has a name to put it beside.
            <span className="flex min-w-0 items-center gap-1 text-[var(--ink-2)]">
              <span className="shrink-0">Working</span>
              {working.lanes > 1 ? (
                <span className="truncate">· {working.lanes} agents</span>
              ) : working.what && (working.what !== "Main" || working.tool) ? (
                <>
                  <span className="shrink-0">·</span>
                  <span className="truncate">{working.what === "Main" && working.tool ? ENGINE_NAMES[working.tool] : working.what}</span>
                </>
              ) : null}
            </span>
          ) : preview ? (
            <span className="truncate">
              <span className="text-sidebar-foreground">{who}:</span> {preview.text}
            </span>
          ) : // An idle session says nothing more than its dashed ring does: one line, as T3 Code's and Synara's rows are, so the ones
          // at work stand out (Arun, 2026-10-27: "take some inspo from like t3, synara, orca"). Its branch or your role, if any, stay.
          null}
          {/* The branch its agents are on, as the other tools' rows carry it (Arun, 2026-10-25): where the work lands. */}
          {/* Only a branch somebody named, as plain words after the status ("· dev"): Friday's own generated ones say nothing a
              person chose, and as a boxed mono tag they were the loudest thing in the row (audit CODE-15 A, Arun 2026-11-04). */}
          {branchChip && !compact && !quiet && namedBranch(r.repos?.find((u) => u.branch)?.branch) && (
            <span className="sb-row-branch" title={`On branch ${r.repos!.find((u) => u.branch)!.branch}`}>
              · {r.repos!.find((u) => u.branch)!.branch}
            </span>
          )}
          {r.role !== "owner" && (
            <span className="ml-auto shrink-0 rounded-full border border-sidebar-border px-1.5 text-[12px]" title={`You are ${r.role === "editor" ? "an editor" : "a viewer"} in this session`}>
              {r.role}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

