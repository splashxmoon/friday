import { ChevronRightIcon, FolderGit2Icon, PlusIcon, SearchIcon, SettingsIcon, LogOutIcon, XIcon } from "lucide-react";
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
import { withCode, type AttentionState } from "./Attention.js";
import type { Attention } from "../attention.js";
import { recordLine, useAgentRecords } from "./useAgentRecords.js";
import type { Crew, CrewState, Preview, Working } from "../attention.js";
import { usePrs } from "./prWatch.js";
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
import { isRawError, stoppedLine } from "../activity-line.js";
import { ENGINE_NAMES, type EngineTool } from "../types.js";
import { shortcut } from "./Shortcuts.js";
import { isWorkSid, SidebarWorkSwitch, useWorkMode, useWorkSessions, workListed } from "./WorkMode.js";
import { isTeamSid, newTeammate, SidebarTeammates, useTeam, useTeamTab } from "./Teammates.js";
import { byDay } from "./sidebar-days.js";
import { byState, PresenceRing, useFlip, type Presence } from "./presence.js";
import { api } from "./api.js";
import { useUnread } from "./unread.js";
import { sendFeedback } from "./feedback.js";
import { noticeDue, UsageNotice, useUsageSharing } from "./UsageSharing.js";

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
  view: "home" | "session" | "connections" | "agents" | "automations" | "people" | "library" | "board" | "review" | "settings" | "usage";
  /** Whether the chat list is showing beside the rail. */
  panelOpen: boolean;
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
  /** Settings is a page: the gear goes there, where it was last left. */
  onOpenSettings: () => void;
  /** Every agent's tokens, and what hand-offs saved (UsagePage). */
  onOpenUsage: () => void;
  /** A rail button the pointer or focus has reached: its page's code can be fetched ahead of the click. */
  onWarm?: (view: SidebarProps["view"]) => void;
  onOpenBoard: () => void;
  onOpenReview: () => void;
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
const PANEL_MIN = 240;
const PANEL_MAX = 480;
const PANEL_START = 300;
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
        let x = e.clientX;
        let frame = 0;
        document.body.classList.add("resizing", "resizing-x", "resizing-panel");
        const move = (ev: PointerEvent) => {
          x = ev.clientX;
          frame ||= requestAnimationFrame(() => {
            frame = 0;
            setPanelWidth(x - left, false);
          });
        };
        const up = () => {
          if (frame) cancelAnimationFrame(frame);
          setPanelWidth(x - left);
          document.body.classList.remove("resizing", "resizing-x", "resizing-panel");
          removeEventListener("pointermove", move);
          removeEventListener("pointerup", up);
          removeEventListener("pointercancel", up);
        };
        addEventListener("pointermove", move);
        addEventListener("pointerup", up);
        addEventListener("pointercancel", up);
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

/** How a group stands, said on its own line even folded: what needs you first, else how many are working. */
function GroupState({ needs, working }: { needs: number; working: number }) {
  if (needs) return <span className="sb-gstate needs">{needs > 1 ? `${needs} need you` : "Needs you"}</span>;
  if (working) return <span className="sb-gstate live" title={`${working} working`}><span className="sb-gspin" aria-hidden />{working > 1 ? working : ""}</span>;
  return null;
}

export function Sidebar(p: SidebarProps) {
  return (
    <aside className={`sb-panel ${p.panelOpen ? "open" : ""}`} aria-label="Sidebar" aria-hidden={!p.panelOpen} inert={!p.panelOpen}>
      {p.panelOpen && <PanelResize />}
      {/* shadcn's menu pieces read their sidebar's state; held open here, since the app decides when the column shows. */}
      <SidebarProvider open onOpenChange={() => {}} className="contents" style={{}}>
        <div className="sb-panel-inner dass-panel flex flex-col gap-2">
          <Head p={p} />
          {p.view === "agents" ? <AgentsList p={p} /> : <SessionsList p={p} />}
          <Foot p={p} />
        </div>
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

/**
 * A session's mark at the head of its row: the coding tool at work in it (a glyph, not a face) wearing the same ring a teammate's
 * face does, so "blue ring = working" holds app-wide (Arun, 2026-10-29: "so clean and beautiful really with a clear direction in
 * design language"). Waiting on you, an amber ring and "?"; a turn that failed, a red ring; finished while you were elsewhere, a
 * check.
 */
function SessionMark({ state, crew, working, unread, title, stopped = false }: { state: "needs" | "working" | "idle"; crew: Crew | null; working: Working | null; unread: boolean; title?: string | undefined; /** What waits on you is a run that stopped on an error: the red ring, as everywhere a stop shows. */ stopped?: boolean }) {
  const a = crew?.agents ?? [];
  const lead = a.find((x) => x.state === "needs") ?? a.find((x) => x.state === "working") ?? a[0];
  const tool = working?.tool ?? lead?.tool;
  const pr: Presence = state === "needs" ? (stopped && !working ? "error" : "needs") : state === "working" ? "working" : a.some((x) => x.state === "failed") ? "error" : unread ? "done" : a.length && a.every((x) => x.state === "offline") ? "asleep" : "idle";
  return (
    <span className="sb-row-mark" title={title}>
      <PresenceRing state={pr} size={22} square>
        <span className="sb-mark-disc">{tool ? <EngineMark tool={tool} size={12} /> : <FridayMark size={12} />}</span>
      </PresenceRing>
    </span>
  );
}

const CREW_WORD: Record<CrewState, string> = { needs: "needs you", working: "working", failed: "stopped", offline: "offline", done: "done", short: "stopped early", stopped: "stopped", idle: "ready" };
function CrewLine({ crew }: { crew: Crew }) {
  const a = crew.agents;
  const short = (n: string, tool?: EngineTool) => agentWord(n.replace(/^[^']+'s /, ""), tool);
  const of = (st: CrewState) => a.filter((x) => x.state === st);
  const working = of("working");
  const failed = of("failed");
  // Stopped short of its plan, among several agents too: the row sits under Needs you, so its line says why, never "ready"
  // (Arun, 2026-10-29: "Yes, fix them"; "2 agents · ready" under Needs you).
  const early = of("short");
  const words =
    working.length > 1 ? `${working.length} working`
    : working.length ? `${short(working[0]!.name, working[0]!.tool)} working`
    : failed.length ? `${short(failed[0]!.name, failed[0]!.tool)} stopped`
    : a.every((x) => x.state === "offline") ? "Offline"
    : a.length === 1 ? `${short(a[0]!.name, a[0]!.tool)} · ${a[0]!.plan ? `stopped at ${a[0]!.plan}` : CREW_WORD[a[0]!.state]}`
    : early.length ? `${short(early[0]!.name, early[0]!.tool)} · stopped at ${early[0]!.plan}`
    : a.some((x) => x.state === "done") ? `${a.length} agents · done`
    : `${a.length} agents · ready`;
  return (
    <span className="sb-crew">
      {/* The first agent's mark is the row's own (SessionMark); the others sit here, each with its ring, small. */}
      {a.length > 1 && (
        <span className="sb-crew-marks">
          {a.slice(1).map((x) => (
            <PresenceRing key={x.lane} state={CREW_PRESENCE[x.state]} size={14} className="sb-crew-mark" label={`${short(x.name, x.tool)}: ${CREW_WORD[x.state]}`}>
              <span className="sb-crew-disc">{x.tool ? <EngineMark tool={x.tool} size={9} /> : x.name === "Main" ? <FridayMark size={9} /> : <Icon name="agent" size={9} />}</span>
            </PresenceRing>
          ))}
        </span>
      )}
      <span className={`truncate sb-crew-words${working.length ? " working" : failed.length ? " failed" : of("short").length ? " needs" : ""}`}>{words}</span>
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
  if (useTeamTab()[0]) [onNew, label, kbd] = [newTeammate, "New teammate", false];
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
      {isLocal() && !agents && <SidebarWorkSwitch working={p.attention.working.keys()} needs={p.attention.items.map((i) => i.sid)} />}
      <button
        type="button"
        onClick={onNew}
        className="sb-new group flex h-9 w-full items-center gap-2 rounded-lg border border-sidebar-border bg-[var(--card)] px-3 text-[13px] font-medium text-sidebar-accent-foreground shadow-xs outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        <PlusIcon className="size-4 text-[var(--text-muted)] group-hover:text-sidebar-accent-foreground" />
        {label}
        {kbd && <span className="dass-kbd">{shortcut("⌘K")}</span>}
      </button>
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
  const places: { icon: IconName; label: string; on: boolean; go: () => void; warm?: SidebarProps["view"]; count?: number; needs?: boolean }[] = [
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
        // Usage, with your coding tools' limits a short rest away: "how much have I got left?" needs no page.
        if (x.icon === "usage")
          return (
            <HoverCard key={x.label} openDelay={500} closeDelay={150}>
              <HoverCardTrigger asChild>{button}</HoverCardTrigger>
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
  const usageNoticeUp = noticeDue(useUsageSharing());
  const w = p.workspace;
  // The local edition has no plan: it is yours, on this computer.
  const plan = w?.limits?.name ?? (isLocal() ? "Local" : "Free");
  return (
    // Its line runs the sidebar's full width, edge to edge, level with the page's footer line beside it.
    <div className="dass-foot -mx-[10px] mt-auto flex shrink-0 flex-col justify-center gap-1 border-t border-sidebar-border px-[14px]">
      {/* The usage notice, once, takes the tip's place in the foot until it is answered. */}
      {isLocal() && (usageNoticeUp ? <UsageNotice /> : <TeamTip className="in-foot" />)}
      {/* One card at the foot (Arun, 2026-10-26: "integrate the profile thing, light and dark mode and settings button into the
          card where the agent board, code review and usage buttons are"): the places on top, who you are and the app's own
          controls under them. */}
      {/* One row (Arun, 2026-10-26: "in a row together, the profile thing can just be the circle"): you, as your avatar, then
          the places, then the theme and settings. Your name and plan are in the menu the avatar opens. */}
      <div className="sb-dock">
        {/* No account on your own computer, so no avatar and its menu (Arun, 2026-10-26: "get rid of the profile button"). */}
        <PlaceIcons p={p} />
        <UpdateRailButton />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="dass-rail-btn size-8"
              aria-label={`Switch to ${nextLook} mode`}
              onClick={() => {
                // Light or dark here is Friday's own, as in Settings: a colour theme on (Dracula, one of yours) comes off, or the
                // button only flipped the class under it and left a mix nobody could read (2026-10-27 audit).
                if (readTheme()) applyTheme(null);
                chooseTheme(nextLook);
                setLook(currentLook());
              }}
            >
              {/* The places' own icon set and size, so the row reads as one (Arun, 2026-10-26). */}
              <Icon name={nextLook === "light" ? "sun" : "moon"} size={19} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Switch to {nextLook}</TooltipContent>
        </Tooltip>
        {/* The open-source edition's way to say what went wrong or what's missing: a GitHub issue, started for them (feedback.ts). */}
        {isLocal() && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="dass-rail-btn size-8" aria-label="Send feedback" onClick={() => void sendFeedback()}>
                <Icon name="megaphone" size={19} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Send feedback</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="dass-rail-btn size-8" data-active={p.view === "settings"} aria-label="Settings" onClick={p.onOpenSettings}>
              <Icon name="settings" size={19} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Settings</TooltipContent>
        </Tooltip>
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
  const [workMode] = useWorkMode();
  let teamTab = false;
  teamTab = useTeamTab()[0];
  // Kept fresh on every tab, so the team's session stays out of Code's list and its robots show wherever it is open.
  useTeam(p.identityForApi);
  const work = useWorkSessions(p.identityForApi);
  // Not until the Work sessions are known: before, every Work session read as a coding one and showed under Code (the 2026-10-28
  // critique: Code's list showed "Open-source launch posts").
  if (isLocal()) listed = p.recents.filter((r) => workListed() && work.has(r.sid) === workMode && !isTeamSid(r.sid));
  const beds = buckets(
    [...listed].sort((a, b) => b.openedAt - a.openedAt),
    { needs: new Set(p.attention.items.map((i) => i.sid)), working: new Set(p.attention.working.keys()), merged },
    now,
  );
  // Held in the order it stands while the pointer or the keyboard is in the list, so the row under them doesn't move as the list
  // re-sorts; a new session still goes on top, and the rest settle once they leave (Arun, 2026-10-28: "iron everything and
  // ensure we are good… any logic errors and fixes").
  const [pointerIn, setPointerIn] = useState(false);
  const flip = useFlip<HTMLDivElement>();
  const [focusIn, setFocusIn] = useState(false);
  const heldIds = useRef<string[]>([]);
  // Needs you, then working, then the rest, within each group (owner call D); a row that moves slides there (useFlip).
  const shortIds = beds.active.filter((r) => stoppedShort(p.attention.crews.get(r.sid), p.attention.working.get(r.sid))).map((r) => r.sid);
  const needSet = new Set([...p.attention.items.map((i) => i.sid), ...shortIds]);
  const activeIds = byState(beds.active, (r) => (needSet.has(r.sid) ? "needs" : p.attention.working.has(r.sid) ? "working" : null)).map((r) => r.sid);
  const had = new Set(heldIds.current);
  const orderIds = pointerIn || focusIn ? [...activeIds.filter((id) => !had.has(id)), ...heldIds.current.filter((id) => activeIds.includes(id))] : activeIds;
  heldIds.current = orderIds;
  const byId = new Map(beds.active.map((r) => [r.sid, r]));
  const sorted = orderIds.map((id) => byId.get(id)!);
  const projectIds = new Set(p.projects.map((x) => x.id));
  const loose = sorted.filter((r) => !(r.projectId && projectIds.has(r.projectId)));

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

  const chatMenu = (r: RecentSession): MenuItem[] => [
    { label: "Open in new tab", icon: "external", onSelect: () => window.open(`/?session=${encodeURIComponent(r.sid)}&invite=${encodeURIComponent(r.invite)}`, "_blank") },
    // Said in the app's notice, not an alert that froze the page; and not offered where it can't be done (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
    canFork(p.attention.crews.get(r.sid), isLocal()) ? { label: "Fork session", icon: "gitFork", onSelect: () => void forkSession(r.sid, r.invite).then((e) => e && sayNotice(e)) } : null,
    { label: "Rename session", icon: "pencil", onSelect: () => setRenaming({ kind: "session", id: r.sid }) },
    r.alias ? { label: "Use the original title", icon: "refresh", onSelect: () => p.updateRecent(r.sid, { alias: undefined }) } : null,
    // Out of the way for a while, or for good until something happens in it (sidebar-buckets.ts).
    { heading: r.snoozedUntil && r.snoozedUntil > now ? `Snoozed ${snoozeWord(r.snoozedUntil, now)}` : "Snooze" },
    ...(r.snoozedUntil && r.snoozedUntil > now ? [{ label: "Wake it now", icon: "bell" as const, onSelect: () => p.updateRecent(r.sid, { snoozedUntil: undefined }) }] : []),
    ...snoozePresets(now).map((s) => ({ label: s.label, icon: "clock" as const, onSelect: () => p.updateRecent(r.sid, { snoozedUntil: s.until, settledAt: undefined }) })),
    // Settling is not a snooze: a group of its own, not under Snooze's heading (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
    { heading: "" },
    r.settledAt
      ? { label: "Back to the list", icon: "refresh" as const, onSelect: () => p.updateRecent(r.sid, { settledAt: undefined }) }
      : { label: "Settle it", icon: "check" as const, title: "Done with it for now: it moves to Settled at the foot of the list, and comes back if anything in it needs you", onSelect: () => p.updateRecent(r.sid, { settledAt: now, snoozedUntil: undefined }) },
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
      preview={p.attention.previews.get(r.sid) ?? null}
      summary={p.attention.summaries.get(r.sid) ?? null}
      crew={p.attention.crews.get(r.sid) ?? null}
      menu={() => chatMenu(r)}
    />
  );

  // Sessions waiting on you, pulled to the top: what needs you first (Dass: "what needs you rises"). Closed with its ×, it
  // stays closed for the ones waiting then, and comes back with any session that starts waiting after (Arun, 2026-10-20).
  const needsIds = [...new Set([...p.attention.items.map((i) => i.sid), ...shortIds])];
  const needing = needsIds.flatMap((sid) => sorted.filter((r) => r.sid === sid)).filter((r) => !dismissed.includes(r.sid));
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
      const u = r.repos?.[0];
      if (!u) continue;
      const g = by.get(u.name) ?? { name: u.name, chats: [] };
      g.chats.push(r);
      by.set(u.name, g);
    }
    return [...by.values()];
  })();
  const filed = new Set(repoGroups.flatMap((g) => g.chats.map((c) => c.sid)));
  const needsSids = new Set(p.attention.items.map((i) => i.sid));
  const unfiled = loose.filter((r) => !filed.has(r.sid));

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
          const items = sorted.filter((r) => r.projectId === proj.id);
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
            <RepoTile name={g.name} />
            <span className="truncate normal-case tracking-normal">{g.name}</span>
          </>
        }
        open={isOpen(id)}
        onToggle={() => toggle(id)}
        count={g.chats.length}
        status={<GroupState needs={g.chats.filter((c) => needsSids.has(c.sid)).length} working={g.chats.filter((c) => p.attention.working.has(c.sid)).length} />}
        drag={dragSection(id)}
      >
        {byDay(g.chats, now).map((x) => (typeof x === "string" ? <div key={`day:${x}`} className="sb-day">{x}</div> : row(x)))}
      </Group>,
    );
  }
  blocks.set(
    "recent",
    <div className={`rounded-lg ${drop === "__recent" ? "bg-sidebar-accent ring-1 ring-sidebar-ring" : ""}`} hidden={unfiled.length === 0 && repoGroups.length > 0 && !drop && !dragging} {...dropZone(null)}>
      <Group label="Recent" open={isOpen("recent")} onToggle={() => toggle("recent")} count={unfiled.length || undefined} status={<GroupState needs={unfiled.filter((c) => needsSids.has(c.sid)).length} working={unfiled.filter((c) => p.attention.working.has(c.sid)).length} />} drag={dragSection("recent")}>
        {unfiled.length === 0 && repoGroups.length === 0 ? <p className="px-2 py-1 text-xs text-[var(--text-muted)]">Sessions you start or join appear here.</p> : byDay(unfiled, now).map((x) => (typeof x === "string" ? <div key={`day:${x}`} className="sb-day">{x}</div> : row(x)))}
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
  if (teamTab) return <div className="sb-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1"><SidebarTeammates identity={p.identityForApi} onOpen={p.onOpen} activeSid={p.activeSid} needs={p.attention.items} /></div>;
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
              <span className="dass-dot size-2" data-state="needs" />
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
  menu,
  compact = false,
  needs = null,
  summary = null,
  crew = null,
  quiet,
}: {
  /** Asleep (snoozed or settled): this in place of what is going on, since nothing is. */
  quiet?: string;
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
  menu: () => MenuItem[];
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  const who = preview ? (preview.by === me ? "You" : preview.by.split(/\s+/)[0]) : "";
  const short = !needs && stoppedShort(crew, working);
  const state = needs || short ? "needs" : working ? "working" : "idle";
  // Its agents finished while you were elsewhere, and you haven't opened it since (unread.ts).
  const unread = useUnread().has(r.sid) && !active && !needs && !short && !working;
  // The branch its agents are on, where the session is about one (the 2026-10-28 critique).
  let branchChip = true;
  if (isWorkSid(r.sid)) branchChip = false;
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
      <SessionMark state={state} crew={crew} working={working} unread={unread} stopped={needs?.kind === "stopped"} title={needs ? `${needs.kind === "stopped" ? "" : "Needs you: "}${shortPaths(needs.detail ?? needs.text)}` : working ? `Working now: ${working.what}` : undefined} />
      <div className="flex min-w-0 items-center gap-2">
        {renaming ? <InlineEdit value={label} onSave={onRename} onCancel={onCancelRename} /> : <span className="dass-row-title">{label}{unread && <span className="sr-only">, new since you looked</span>}</span>}
        {working && working.lanes > 1 && <span className="shrink-0 text-[12px] tabular-nums text-[var(--text-muted)]" title={`${working.lanes} agents working`}>{working.lanes}</span>}
        {!renaming && <span className="dass-row-time shrink-0 text-[12px] text-[var(--text-muted)]">{relTime(r.openedAt)}</span>}
        {!renaming && (
          <span className="dass-row-act -my-1 shrink-0">
            <MenuButton label={`Actions for ${label}`} items={menu} onOpenChange={setMenuOpen} />
          </span>
        )}
      </div>
      {!renaming && (
        <div className="dass-row-sub">
          {quiet ? (
            <span className="truncate text-[var(--text-muted)]">{quiet}</span>
          ) : needs ? (
            <span className="truncate text-[var(--ink)]">{withCode(shortPaths(isRawError(needs.text) ? (needs.kind === "stopped" ? stoppedLine(needs.text) : "Needs you") : needs.text))}</span>
          ) : compact && !short ? null : crew ? (
            <CrewLine crew={crew} />
          ) : summary ? (
            <>
              <span className="shrink-0 opacity-80">{summary.tool ? <EngineMark tool={summary.tool} size={11} /> : <Icon name="agent" size={11} />}</span>
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
                  <span className="shrink-0 opacity-90">{working.tool ? <EngineMark tool={working.tool} size={11} /> : <Icon name="agent" size={11} />}</span>
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
          {branchChip && !compact && !quiet && r.repos?.find((u) => u.branch)?.branch && (
            <span className="dass-row-branch" title={`On branch ${r.repos.find((u) => u.branch)!.branch}`}>
              <Icon name="gitBranch" size={10} />
              <span className="truncate">{r.repos.find((u) => u.branch)!.branch!.split("/").pop()}</span>
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

