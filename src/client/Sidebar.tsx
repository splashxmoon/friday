import { ChevronRightIcon, FolderGit2Icon, MoonIcon, PlusIcon, SearchIcon, SettingsIcon, SunIcon, LogOutIcon, XIcon } from "lucide-react";
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
import { currentLook, loadFolded, loadSectionOrder, saveFolded, saveSectionOrder } from "./storage.js";
import type { Identity, Project, RecentSession } from "./storage.js";
import { buckets, snoozePresets, snoozeWord } from "./sidebar-buckets.js";
import { ContextMenu, InlineEdit, MenuButton, relTime, useConfirm, type MenuItem } from "./ui.js";
import type { WorkspaceUsage } from "./workspace-types.js";
import { isLocal, planLimits, planNow } from "./edition.js";
import { TeamTip } from "./TeamTip.js";
import type { SessionSummary } from "../board.js";
import { EngineMark } from "./BrandMarks.js";
import { ENGINE_NAMES } from "../types.js";
import { shortcut } from "./Shortcuts.js";

type Renaming = { kind: "session" | "project"; id: string } | null;
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
export function activates(e: { key: string; target: unknown; currentTarget: unknown; preventDefault(): void }): boolean {
  if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return false;
  if (e.key === " ") e.preventDefault();
  return true;
}

export function Sidebar(p: SidebarProps) {
  return (
    <aside className={`sb-panel ${p.panelOpen ? "open" : ""}`} aria-label="Sidebar" aria-hidden={!p.panelOpen} inert={!p.panelOpen}>
      {/* shadcn's menu pieces read their sidebar's state; held open here, since the app decides when the column shows. */}
      <SidebarProvider open onOpenChange={() => {}} className="contents" style={{}}>
        <div className="sb-panel-inner dass-panel flex flex-col gap-2">
          <Head p={p} />
          {p.view === "agents" ? <AgentsList p={p} /> : <SessionsList p={p} />}
          <Foot p={p} />
          <SidebarWave />
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
const CREW_WORD: Record<CrewState, string> = { needs: "needs you", working: "working", failed: "stopped", offline: "offline", done: "done", idle: "ready" };
function CrewLine({ crew }: { crew: Crew }) {
  const a = crew.agents;
  const short = (n: string) => n.replace(/^[^']+'s /, "");
  const of = (st: CrewState) => a.filter((x) => x.state === st);
  const working = of("working");
  const failed = of("failed");
  const words =
    working.length > 1 ? `${working.length} working`
    : working.length ? `${short(working[0]!.name)} working`
    : failed.length ? `${short(failed[0]!.name)} stopped`
    : a.every((x) => x.state === "offline") ? "Offline"
    : a.length === 1 ? `${short(a[0]!.name)} · ${CREW_WORD[a[0]!.state]}`
    : a.some((x) => x.state === "done") ? `${a.length} agents · done`
    : `${a.length} agents · ready`;
  return (
    <span className="sb-crew">
      <span className="sb-crew-marks">
        {a.map((x) => (
          <span key={x.lane} className="sb-crew-mark" data-state={x.state} title={`${short(x.name)}: ${CREW_WORD[x.state]}`}>
            {x.tool ? <EngineMark tool={x.tool} size={9} /> : <Icon name="agent" size={9} />}
          </span>
        ))}
      </span>
      <span className={`truncate sb-crew-words${working.length ? " working" : failed.length ? " failed" : ""}`}>{words}</span>
    </span>
  );
}

/**
 * A quiet band of Hokusai's Great Wave in dithered dots along the sidebar's foot, behind everything in it (Arun, 2026-10-24:
 * "integrate this into the side bar maybe at the top or bottom like a subtle design thing"). Its pale ground drops out against
 * the sidebar (style.css .sb-wave), so only the ink shows, faint, fading in from nothing. It plays only while the window is in
 * front, and is a still frame for anyone who asks for less motion. Nothing to press, and nothing for a screen reader.
 */
function SidebarWave() {
  const video = useRef<HTMLVideoElement>(null);
  const [still] = useState(() => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const sync = () => void (document.visibilityState === "visible" ? v.play().catch(() => {}) : v.pause());
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  return (
    <div className="sb-wave" aria-hidden="true">
      {still ? <img src="/art/wave-still.jpg" alt="" /> : <video ref={video} src="/art/wave.mp4" poster="/art/wave-still.jpg" autoPlay muted loop playsInline preload="auto" />}
    </div>
  );
}

// ── head: where you are, search, and the one thing to start ─────────────────────────────────

function Head({ p }: { p: SidebarProps }) {
  const agents = p.view === "agents";
  return (
    <div className="flex shrink-0 flex-col gap-2 px-1">
      <div className="flex items-center gap-1">
        {/* The workspace's name where the logo was (Arun, 2026-10-24: "get rid of logo and make the workspace/team name replace
            its place"): which team you're in is what this corner should say. */}
        <div className="panel-title brand flex min-w-0 flex-1 items-center gap-2">
          {/* The local edition has no workspaces: the corner is the app's name. */}
          {isLocal() && <span className="truncate text-[14px] font-semibold text-sidebar-accent-foreground">Friday</span>}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="dass-rail-btn sidebar-search size-8" aria-label="Search" onClick={() => window.dispatchEvent(new Event("friday:search"))}>
              <SearchIcon className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Search <span className="dass-kbd ml-2">{shortcut("⌘⇧F")}</span>
          </TooltipContent>
        </Tooltip>
      </div>
      <button
        type="button"
        onClick={agents ? p.onNewAgent : () => p.onNew()}
        className="group flex h-9 w-full items-center gap-2 rounded-lg border border-sidebar-border bg-[var(--card)] px-3 text-[13px] font-medium text-sidebar-accent-foreground shadow-xs outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        <PlusIcon className="size-4 text-[var(--text-muted)] group-hover:text-sidebar-accent-foreground" />
        {agents ? "New agent" : "New session"}
        {!agents && <span className="dass-kbd">{shortcut("⌘K")}</span>}
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
  const nextLook = look === "light" ? "dark" : "light";
  const w = p.workspace;
  // The local edition has no plan: it is yours, on this computer.
  const plan = w?.limits?.name ?? (isLocal() ? "Local" : "Free");
  return (
    // Its line runs the sidebar's full width, edge to edge, level with the page's footer line beside it.
    <div className="dass-foot -mx-[10px] mt-auto flex shrink-0 flex-col justify-center gap-1 border-t border-sidebar-border px-[14px]">
      {isLocal() && <TeamTip className="in-foot" />}
      <PlaceIcons p={p} />
      <div className="flex items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1.5 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[state=open]:bg-sidebar-accent" aria-label="Account" data-tour="Account">
              <Avatar name={p.identity.name || "?"} id={p.identity.id} size={28} />
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="truncate text-[13px] font-medium text-sidebar-accent-foreground">{p.identity.name || "Set your name"}</span>
                <span className="truncate text-[11px] text-[var(--text-muted)]">{w ? `${w.personal ? "Personal" : w.name} · ${plan}` : plan}</span>
              </span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-64">
            <div className="px-2 py-1.5">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{p.identity.name || "Set your name"}</span>
                <span className="ml-auto rounded-full border px-1.5 text-[10.5px] text-muted-foreground">{plan}</span>
              </div>
              {p.email && <div className="truncate text-xs text-muted-foreground">{p.email}</div>}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={p.onOpenSettings}>
              <SettingsIcon /> Settings
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <UpdateRailButton />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="dass-rail-btn size-8"
              aria-label={`Switch to ${nextLook} mode`}
              onClick={() => {
                chooseTheme(nextLook);
                setLook(currentLook());
              }}
            >
              {nextLook === "light" ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Switch to {nextLook}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="dass-rail-btn size-8" data-active={p.view === "settings"} aria-label="Settings" onClick={p.onOpenSettings}>
              <SettingsIcon className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Settings</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

// ── a group of the list: a label that folds it, an action, and its rows ─────────────────────

function Group({ label, open, onToggle, count, action, drag, children, className = "" }: { label: ReactNode; open: boolean; onToggle: () => void; count?: number; action?: ReactNode; drag?: Partial<React.HTMLAttributes<HTMLDivElement>>; children: ReactNode; className?: string }) {
  return (
    <SidebarGroup className={`p-0 ${className}`}>
      <Collapsible open={open} onOpenChange={onToggle}>
        <div className="group/label relative flex items-center" {...drag}>
          <SidebarGroupLabel asChild className="h-7 flex-1 cursor-pointer gap-1 px-2 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)] hover:text-sidebar-accent-foreground">
            <CollapsibleTrigger>
              <ChevronRightIcon className={`size-3 transition-transform duration-200 ${open ? "rotate-90" : ""}`} />
              <span className="flex min-w-0 items-center gap-1.5 truncate">{label}</span>
              {!!count && <span className="ml-1 font-normal normal-case tracking-normal opacity-70">{count}</span>}
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
                {a.access === "shared" && <span className="text-[11px] text-[var(--text-muted)]">shared</span>}
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
  const beds = buckets(
    [...p.recents].sort((a, b) => b.openedAt - a.openedAt),
    { needs: new Set(p.attention.items.map((i) => i.sid)), working: new Set(p.attention.working.keys()), merged },
    now,
  );
  const sorted = beds.active;
  const projectIds = new Set(p.projects.map((x) => x.id));
  const loose = sorted.filter((r) => !(r.projectId && projectIds.has(r.projectId)));

  const newProject = () => {
    const id = p.createProject("New project");
    setRenaming({ kind: "project", id });
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

  const chatMenu = (r: RecentSession): MenuItem[] => [
    { label: "Open in new tab", icon: "external", onSelect: () => window.open(`/?session=${encodeURIComponent(r.sid)}&invite=${encodeURIComponent(r.invite)}`, "_blank") },
    { label: "Fork session", icon: "gitFork", onSelect: () => void forkSession(r.sid, r.invite).then((e) => e && alert(e)) },
    { label: "Rename session", icon: "pencil", onSelect: () => setRenaming({ kind: "session", id: r.sid }) },
    r.alias ? { label: "Use the original title", icon: "refresh", onSelect: () => p.updateRecent(r.sid, { alias: undefined }) } : null,
    // Out of the way for a while, or for good until something happens in it (sidebar-buckets.ts).
    { heading: r.snoozedUntil && r.snoozedUntil > now ? `Snoozed ${snoozeWord(r.snoozedUntil, now)}` : "Snooze" },
    ...(r.snoozedUntil && r.snoozedUntil > now ? [{ label: "Wake it now", icon: "bell" as const, onSelect: () => p.updateRecent(r.sid, { snoozedUntil: undefined }) }] : []),
    ...snoozePresets(now).map((s) => ({ label: s.label, icon: "clock" as const, onSelect: () => p.updateRecent(r.sid, { snoozedUntil: s.until, settledAt: undefined }) })),
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
        setRenaming({ kind: "project", id });
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
              body: "It's deleted for everyone in it, with its history and files. This can't be undone.",
              action: "Delete session",
              onConfirm: () => void p.deleteSession(r.sid).then((e) => e && alert(e)),
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
      onRename={(alias) => {
        p.updateRecent(r.sid, { alias });
        setRenaming(null);
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
  const needsIds = [...new Set(p.attention.items.map((i) => i.sid))];
  const needing = needsIds.flatMap((sid) => sorted.filter((r) => r.sid === sid)).filter((r) => !dismissed.includes(r.sid));
  // A closed session that has stopped waiting is forgotten, so the next time it waits it shows again.
  const waitingKey = needsIds.join(",");
  useEffect(() => {
    if (!dismissed.some((sid) => !needsIds.includes(sid))) return;
    const kept = dismissed.filter((sid) => needsIds.includes(sid));
    setDismissed(kept);
    try {
      localStorage.setItem(NEEDS_CLOSED_KEY, JSON.stringify(kept));
    } catch {
      /* a preference */
    }
  }, [waitingKey]); // eslint-disable-line react-hooks/exhaustive-deps
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
          const open = !proj.collapsed;
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
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <span className="dass-row-title" title={proj.name}>
                    {proj.name}
                  </span>
                )}
                <span className="dass-row-time text-[11px] text-[var(--text-muted)]">{items.length || ""}</span>
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
                  {items.map((r) => row(r))}
                  {items.length === 0 && <p className="px-2 py-1 text-[11.5px] text-[var(--text-muted)]">Drag sessions here, or press + to start one.</p>}
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
            <FolderGit2Icon className="size-3" />
            <span className="truncate normal-case tracking-normal">{g.name}</span>
          </>
        }
        open={isOpen(id)}
        onToggle={() => toggle(id)}
        count={g.chats.length}
        drag={dragSection(id)}
      >
        {g.chats.map((r) => row(r))}
      </Group>,
    );
  }
  blocks.set(
    "recent",
    <div className={`rounded-lg ${drop === "__recent" ? "bg-sidebar-accent ring-1 ring-sidebar-ring" : ""}`} hidden={unfiled.length === 0 && repoGroups.length > 0 && !drop} {...dropZone(null)}>
      <Group label="Recent" open={isOpen("recent")} onToggle={() => toggle("recent")} count={unfiled.length || undefined} drag={dragSection("recent")}>
        {unfiled.length === 0 && repoGroups.length === 0 ? <p className="px-2 py-1 text-xs text-[var(--text-muted)]">Sessions you start or join appear here.</p> : unfiled.map((r) => row(r))}
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

  return (
    <div
      className="sb-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1"
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
          className="rounded-lg bg-[color-mix(in_srgb,var(--dass-needs)_7%,transparent)] pb-1"
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
  const state = needs ? "needs" : working ? "working" : "idle";
  const ref = useRef<HTMLDivElement>(null);
  // The open session is scrolled into view when it changes, so the list always shows where you are.
  useEffect(() => {
    if (active && !compact) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active, compact]);
  return (
    <div
      ref={ref}
      className="dass-row"
      data-active={active}
      data-menu={menuOpen || !!ctx}
      role="button"
      tabIndex={0}
      draggable={!renaming}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, r.sid);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => !renaming && onOpen()}
      onKeyDown={(e) => activates(e) && !renaming && onOpen()}
      onContextMenu={(e) => {
        if (renaming) return;
        e.preventDefault();
        setCtx({ x: e.clientX, y: e.clientY });
      }}
      title={r.alias ? `${label} (${r.title})` : label}
    >
      {ctx && <ContextMenu at={ctx} items={menu} onClose={() => setCtx(null)} />}
      <div className="flex items-center gap-2">
        <span className="dass-dot" data-state={state} title={needs ? `Needs you: ${shortPaths(needs.text)}` : working ? `Working now: ${working.what}` : undefined} />
        {renaming ? <InlineEdit value={label} onSave={onRename} onCancel={onCancelRename} /> : <span className="dass-row-title">{label}</span>}
        {working && working.lanes > 1 && <span className="rounded-full bg-[color-mix(in_srgb,var(--dass-live)_18%,transparent)] px-1.5 text-[10.5px] font-medium text-[var(--dass-live)]">{working.lanes}</span>}
        {!renaming && <span className="dass-row-time shrink-0 text-[11px] text-[var(--text-muted)]">{relTime(r.openedAt)}</span>}
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
            <span className="truncate text-[var(--dass-needs)]">{withCode(shortPaths(needs.text))}</span>
          ) : compact ? null : crew ? (
            <CrewLine crew={crew} />
          ) : summary ? (
            <>
              <span className="shrink-0 opacity-80">{summary.tool ? <EngineMark tool={summary.tool} size={11} /> : <Icon name="agent" size={11} />}</span>
              <span className={`truncate ${summary.column === "working" ? "text-[var(--dass-live)]" : ""}`}>
                {[summary.agent.replace(/^[^']+'s /, ""), summary.running > 1 ? `${summary.running} working` : summary.status, (summary.detail ? shortPaths(summary.detail) : "") || (summary.pr ? `PR ${summary.pr.number ? `#${summary.pr.number}` : "open"}` : "")].filter(Boolean).join(" · ")}
              </span>
            </>
          ) : working ? (
            // The agent at work by name, with its coding tool's mark beside it (Arun, 2026-10-20: "China" is a renamed agent, and
            // the mark says what it runs on). Friday Code's own lane gets Friday's mark when it has a name to put it beside.
            <span className="flex min-w-0 items-center gap-1 text-[var(--dass-live)]">
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
          ) : (
            <span>Idle</span>
          )}
          {/* The branch its agents are on, as the other tools' rows carry it (Arun, 2026-10-25): where the work lands. */}
          {!compact && !quiet && r.repos?.find((u) => u.branch)?.branch && (
            <span className="dass-row-branch" title={`On branch ${r.repos.find((u) => u.branch)!.branch}`}>
              <Icon name="gitBranch" size={10} />
              <span className="truncate">{r.repos.find((u) => u.branch)!.branch!.split("/").pop()}</span>
            </span>
          )}
          {r.role !== "owner" && (
            <span className="ml-auto shrink-0 rounded-full border border-sidebar-border px-1.5 text-[10px]" title={`You are ${r.role === "editor" ? "an editor" : "a viewer"} in this session`}>
              {r.role}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
