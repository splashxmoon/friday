import { isLocal, ownModel, planLimits, type SessionPlan } from "./edition.js";
import { SessionMenu } from "./SessionMenu.js";
import { EmptyState } from "@/components/dass/EmptyState";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { shortcut } from "./Shortcuts.js";
import { createPortal } from "react-dom";
import { tabState } from "./agent-tab.js";
import type { AgentView } from "../agents.js";
import { tell } from "./api.js";
import { badgeFavicon, jumpTargets, TAB_DOT, tabStatus } from "../session-line.js";

/** The site's icon, read once, for the dot the tab carries. */
let faviconText: Promise<string | null> | null = null;
const faviconSvg = () => (faviconText ??= fetch("/favicon.svg").then((r) => (r.ok ? r.text() : null)).catch(() => null));
import { AgentState, agentNameFor, jumpTo } from "./Activity.js";
import { leftOff } from "../left-off.js";
import { project } from "../session/projection.js";
import type { Plan } from "../plan-types.js";
import type { McpPublic } from "../mcp-types.js";
import { can, questionsTo, requestsTo, runOf, type SessionState } from "../session/projection.js";
import { MAIN_LANE, SESSION_GONE, type EngineTool, type Member, type PresenceMember, type SessionEvent } from "../types.js";
import { ChevronDownIcon, FolderGit2Icon, HistoryIcon } from "lucide-react";
import { CodeBlock } from "@/components/agents/code-block";
import type { AgentCodeLanguage } from "@/components/agents/agent-code";
import { AgentThinking } from "@/components/agents/agent-thinking";
import { Activity } from "./Activity.js";
import { GitMenu } from "./github-menu.js";
import { BranchButton } from "./Branches.js";
import { ClaudeMark } from "./BrandMarks.js";
import { ConnectDialog } from "./Engine.js";
import { BenchOrHistory, TAB_LABEL, Workbench, useTab, type Tab } from "./Workbench.js";
import { Lanes } from "./Lanes.js";
import { OverlapNotice } from "./Overlap.js";
import { RaceDialog } from "./Race.js";
import type { Overlap } from "../collisions.js";
import { Avatar, Icon, type IconName } from "./icons.js";
import type { Action } from "./Palette.js";
import { md } from "./markdown.js";

/** This session's workspace, Solo or Team (Team.tsx): the hosted Friday's question. Every session in the local edition is Solo. */
const sessionWorkspace: { useSessionPlan: (sid: string, invite?: string, member?: string) => SessionPlan | null } = { useSessionPlan: () => null };
import type { Identity, RecentSession, RepoUse } from "./storage.js";
import { InlineEdit, MenuButton, Segmented, SessionSkeleton, ShownText, Switch, inBand, isTyping, useConfirm, useDismiss, type MenuItem } from "./ui.js";
import { useSession, type Send } from "./useSession.js";
import type { Focus } from "../focus.js";
import { CLASS_LABEL, COMMAND_CLASSES, type CommandClass } from "../command-class.js";
import { FocusContext, herePublisher } from "./focusStore.js";
import { ALL, AgentsContext, agentKey, focusAgent, focusedAgent, jumpToNeeds, nextKey, openedAt, setColumns, syncAddress, useAgents, useColumns, useFocusedAgent, useSeen } from "./agentFocus.js";
import { AGENT_DRAG, closeColumn, dropAgent, evenWidths, fitColumns, maxColumns, pickInColumn, resizeAt, unreadByLane } from "./agentNav.js";
import { agentLook, laneLabel } from "./handoff-ui.js";
import { hubOf } from "../agents-hub.js";
import { clearDiffRequest, readDiffRequest, showDiffSoon } from "./focusDiff.js";
import { HandoverDialog } from "./Handover.js";
import { StatusBar, useSessionLayout } from "./StatusBar.js";
import { EnvironmentButton } from "./Environment.js";

export interface DocLayout {
  open: boolean;
  width: number;
}

export function SessionView({
  sid,
  invite,
  identity,
  agents,
  onSeen,
  onInvites,
  doc,
  onDocChange,
  onExpandSidebar,
  onRemove,
  onActions,
  plan,
  connections,
  overlaps,
  onOpenSession,
}: {
  /** Files another session of yours is changing too. */
  overlaps?: Overlap[];
  /** Go and look at that session. */
  onOpenSession?: (sid: string, path?: string) => void;
  sid: string;
  invite: string;
  identity: Identity;
  agents: AgentView[];
  /** Saved pipelines this person can apply to the session. */
  onSeen: (r: RecentSession) => void;
  /** Lifts this session's invite links so the sidebar can invite people into it. */
  onInvites: (invites: Record<string, string> | null) => void;
  /** Present only while the sidebar is collapsed: the header offers it back. */
  onExpandSidebar?: () => void;
  /** Take a session off this person's list (App's removeRecent). */
  onRemove?: (sid: string) => void;
  /** Hands the palette what this session can do right now, and takes it back when it closes. */
  onActions?: (a: Action[]) => void;
  doc: DocLayout;
  onDocChange: (d: Partial<DocLayout>) => void;
  /** The workspace's plan, which decides which models the composer may offer. */
  plan: Plan;
  /** Connected MCPs, so the composer can offer one per slash command. */
  connections: McpPublic[];
}) {
  const s = useSession(sid, invite, identity);
  // Solo or Team, for this session's own workspace: on Solo nobody else steers and Friday's own agent isn't there.
  // Asked again once this person is in: the plan answers members only, and someone arriving by a link isn't one yet.
  const sessionPlan = sessionWorkspace.useSessionPlan(sid, invite, s.me?.id);
  // Until the session's own workspace answers, the one the app has open: almost always the same, and no Team header flashing first.
  const solo = sessionPlan ? !sessionPlan.team : planLimits(plan).fridayAgent === "none";
  /** Where the scrubber is, or null for now. */
  const [replayAt, setReplayAt] = useState<number | null>(null);
  /** The history panel, beside the conversation. It and the workbench share the right-hand side, so only one is open. */
  const [history, setHistory] = useState(false);
  /** Bumped by "Play it back": the History panel starts playing from the beginning. */
  const [playback, setPlayback] = useState(0);
  // The invite is the onboarding. Somebody here for the first time, with a history to catch up on, lands on the first
  // change or question with the timeline open, not at the bottom of a wall of events. Not when the session is live or
  // waiting on them: then the present is the point.
  const landed = useRef(false);
  // Two side panels: the artifacts, and the workbench — which is itself
  // tabbed, so everything a coding run produced is one click from the last
  // thing you looked at rather than a trip through a menu.
  // Open or closed per session, and remembered: leaving a session and coming
  // back used to close the workbench, which read as the tree, the terminal
  // and the overview having vanished.
  const [bench, setBenchState] = useState(() => {
    try {
      return localStorage.getItem(`mpa.benchOpen.${sid}`) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    // From the whole log: a first visit's landing looks for the session's first change, which the newest events alone may not hold.
    if (landed.current || !s.state || !s.me || s.partial) return;
    landed.current = true;
    if (s.seenSeq !== 0 || s.me.role === "owner" || s.events.length < 8) return;
    const st = s.state;
    const busy = st.run.status === "running" || st.run.status === "waiting_for_human" || Object.values(st.laneRuns).some((r) => r.status === "running");
    if (busy || questionsTo(st, s.me.id).length) return;
  }, [s.state, s.me, s.partial]); // eslint-disable-line react-hooks/exhaustive-deps
  const setBench = (open: boolean) => {
    setBenchState(open);
    try {
      if (open) localStorage.setItem(`mpa.benchOpen.${sid}`, "1");
      else localStorage.removeItem(`mpa.benchOpen.${sid}`);
    } catch {
      // A preference: losing it costs a click.
    }
  };
  const [tab, setTab] = useTab(sid);
  // The side panel opens on a card of every panel until one has been picked in this session (on this computer); after that it
  // opens on the one used last (Arun, 2026-10-24: "make the side panel when you click the side panel button page blank with a
  // vertical card with all of the options", "it will be like that unless the user already clicked an option prior to it").
  const pickedKey = `friday.panel.picked.${sid}`;
  const [picking, setPicking] = useState(false);
  const pickPanel = (t: Tab) => {
    setTab(t);
    setPicking(false);
    try {
      localStorage.setItem(pickedKey, "1");
    } catch {}
  };
  // Arriving from "another session is changing this file": the Diff panel, on that file, once the session is up and it has drawn.
  useEffect(() => {
    const path = readDiffRequest(sid);
    if (!path) return;
    setTab("files");
    setBench(true);
    setHistory(false);
    const stop = showDiffSoon(path);
    const done = window.setTimeout(clearDiffRequest, 2200);
    return () => {
      stop();
      clearTimeout(done);
    };
  }, [sid]); // eslint-disable-line react-hooks/exhaustive-deps
  // "Open in the tree" on a diff: the tree shows the file whole, around the lines that changed.
  // A file named in an answer opens here too, at its line; taking the event tells the chip it was opened, not copied.
  const [openFile, setOpenFile] = useState<{ path: string; line?: number; at: number } | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      const { path, line } = (e as CustomEvent<{ path: string; line?: number }>).detail;
      e.preventDefault();
      setOpenFile({ path, ...(line ? { line } : {}), at: Date.now() });
      setTab("tree");
      setBench(true);
      setHistory(false);
    };
    window.addEventListener("friday:open-file", on);
    return () => window.removeEventListener("friday:open-file", on);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [benchWidth, setBenchWidth] = useState(() => {
    const v = Number(localStorage.getItem("mpa.benchWidth"));
    return v >= 320 && v <= 980 ? v : 560;
  });
  // Opened from the agents menu as well as from the engine bar, so it lives here.
  const [connect, setConnect] = useState<{ lane: string; tool?: EngineTool | ""; from?: string } | null>(null);
  // "Run a saved agent" makes the lane, then asks for the connect step on it.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ lane?: string; tool?: EngineTool }>).detail;
      if (d?.lane && d.tool) setConnect({ lane: d.lane, tool: d.tool });
    };
    window.addEventListener("friday:connect-lane", on);
    return () => window.removeEventListener("friday:connect-lane", on);
  }, []);
  const [racing, setRacing] = useState(false);
  // Once a pull request exists, ask GitHub about it now and then; when it merges, the session gets its last card.
  const prUrl = useMemo(() => [...s.events].reverse().find((e) => e.body.type === "folder.committed" && !e.body.error && !!e.body.prUrl)?.body, [s.events.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const [merged, setMerged] = useState<{ url: string; at: number } | null>(null);
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    if (!prUrl || merged || closed) return;
    let live = true;
    const ask = () =>
      fetch(`/api/sessions/${encodeURIComponent(sid)}/pr?invite=${encodeURIComponent(invite)}`, { credentials: "same-origin" })
        .then((r) => r.json() as Promise<{ pr: { url: string; at: number; status: { state: string } | null } | null }>)
        .then((d) => {
          if (!live) return;
          const st = d.pr?.status?.state;
          if (st === "merged") setMerged({ url: d.pr!.url, at: Date.now() });
          else if (st === "closed") setClosed(true);
        })
        .catch(() => {});
    void ask();
    const t = setInterval(ask, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [sid, invite, !!prUrl, merged, closed]); // eslint-disable-line react-hooks/exhaustive-deps
  // Agents' chats side by side: two on a laptop, three on a wide screen (Arun, 2026-10-18). Which ones is part of the page's
  // one agent choice (agentFocus.ts): the column in use is the agent in view, and the panels beside them follow it.
  const cols = useColumns(sid);
  const [activeLane, setActiveLane] = useState<string>(MAIN_LANE);
  const [widths, setWidths] = useState<number[]>(() => evenWidths(2));
  const [room, setRoom] = useState(() => (typeof innerWidth === "number" ? maxColumns(innerWidth) : 1));
  useEffect(() => {
    const ms = [matchMedia("(min-width: 1100px)"), matchMedia("(min-width: 1500px)")];
    const on = () => setRoom(maxColumns(innerWidth));
    for (const m of ms) m.addEventListener("change", on);
    return () => ms.forEach((m) => m.removeEventListener("change", on));
  }, []);
  const wide = room >= 2;
  const laneIds = (s.state?.lanes ?? []).map((l) => l.id).join(",");
  const everyoneHere = useMemo(() => [MAIN_LANE, ...laneIds.split(",").filter(Boolean)], [laneIds]);
  // A column whose agent has gone is not a column any more.
  useEffect(() => {
    if (!cols || !s.state) return;
    const kept = fitColumns(cols, cols.length, activeLane, everyoneHere);
    if ((kept?.join(",") ?? "") !== cols.join(",")) setColumns(sid, kept);
  }, [laneIds, !!s.state]); // eslint-disable-line react-hooks/exhaustive-deps
  const title = s.state?.title;
  const role = s.me?.role;

  // ── looking together ─────────────────────────────────────────────────
  // Where this person is looking goes to the room as it moves, and a teammate's can be followed: their panel, their agent, their file.
  // The file and line under the pointer go straight to the room, not through this page's state: as state, every row the
  // pointer crossed in a diff (scrolling past one counts) redrew the whole session, twice.
  const hereFile = useRef<{ path?: string; line?: number }>({});
  const focusBase: Focus = { ...(history ? { panel: "history" } : bench ? { panel: tab } : {}), lane: activeLane };
  const withFile = (base: Focus, f: { path?: string; line?: number }): Focus => ({ ...base, ...(f.path ? { path: f.path, ...(f.line !== undefined ? { line: f.line } : {}) } : {}) });
  const baseRef = useRef(focusBase);
  baseRef.current = focusBase;
  const look = s.look;
  const lookRef = useRef(look);
  lookRef.current = look;
  const focusBaseKey = JSON.stringify(focusBase);
  useEffect(() => {
    look(withFile(focusBase, hereFile.current));
  }, [focusBaseKey, look]); // eslint-disable-line react-hooks/exhaustive-deps
  // The tree and the diff each keep their own slot, so one going quiet leaves the other's file showing, not "nowhere".
  const here = useMemo(
    () =>
      herePublisher((p) => {
        hereFile.current = p;
        lookRef.current(withFile(baseRef.current, p));
      }),
    [],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  const others = useMemo(() => {
    const out: Record<string, { name: string; at: Focus }> = {};
    for (const p of s.presence) if (p.online && s.focus[p.id] && p.id !== s.me?.id) out[p.id] = { name: p.name, at: s.focus[p.id]! };
    return out;
  }, [s.presence, s.focus, s.me?.id]);
  const [following, setFollowing] = useState<string | null>(null);
  /** What following last put on screen, so a change that is not that is known to be this person's own. */
  const applied = useRef<{ panel: string; lane: string } | null>(null);
  const theirs = following ? others[following]?.at : undefined;
  useEffect(() => {
    if (!following || !theirs) return;
    const panel = theirs.panel ?? "";
    const lane = theirs.lane && (theirs.lane === MAIN_LANE || laneIds.split(",").includes(theirs.lane)) ? theirs.lane : activeLane;
    applied.current = { panel, lane };
    if (panel === "history") {
      setHistory(true);
      setBench(false);
    } else if (panel) {
      setTab(panel as Tab);
      setBench(true);
      setHistory(false);
    } else {
      setBench(false);
      setHistory(false);
    }
    if (lane !== activeLane) (setActiveLane(lane), focusAgent(sid, lane));
    // Their file, only while they are in the tree: a pointer passing over a diff in the feed is not a request to open anything.
    if (panel === "tree" && theirs.path) setOpenFile({ path: theirs.path, at: Date.now() });
  }, [following, theirs?.panel, theirs?.lane, theirs?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  // Moving yourself, away from where following put you, is choosing to look elsewhere.
  useEffect(() => {
    if (!following || !applied.current) return;
    const panel = history ? "history" : bench ? tab : "";
    if (panel !== applied.current.panel || activeLane !== applied.current.lane) setFollowing(null);
  }, [bench, tab, history, activeLane]); // eslint-disable-line react-hooks/exhaustive-deps
  // They went away: nothing left to follow.
  useEffect(() => {
    if (following && !others[following]) setFollowing(null);
  }, [following, others]);
  const focusValue = useMemo(() => ({ others, here }), [others, here]);

  // The repos this chat works in, as a string so the effect only runs when they change.
  const repos = JSON.stringify(reposOf(s.state));
  useEffect(() => {
    if (title && role) onSeen({ sid, invite, title, role, openedAt: Date.now(), repos: JSON.parse(repos) as RepoUse[] });
  }, [title, role, repos]); // eslint-disable-line react-hooks/exhaustive-deps

  const invites = s.invites;
  useEffect(() => {
    onInvites(invites ?? null);
    return () => onInvites(null);
  }, [invites]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tab-title badge when this person is needed: the agent asked them, or someone wants control.
  const attention =
    s.state && s.me
      ? questionsTo(s.state, s.me.id).length +
        requestsTo(s.state, s.me.id).length +
        // An agent on a Manual machine waiting for this person's yes.
        Object.keys(s.state.approvals).filter((lane) => (lane === MAIN_LANE ? s.state!.driver : s.state!.laneDrivers[lane])?.id === s.me!.id).length
      : 0;
  useEffect(() => {
    if (title) document.title = `${attention ? `(${attention}) ` : ""}${title} · Friday`;
  }, [title, attention]);
  // A wait here answered or asked (in this chat, from a toast, on another device): the Waiting on you toasts are read
  // again now, rather than at their next look a quarter of a minute later, so one answered in the chat goes at once.
  const waits = s.state ? `${Object.values(s.state.approvals).map((a) => a.id).join()}|${Object.values(s.state.openQuestions).map((q) => q.seq).join()}|${Object.values(s.state.asks).map((a) => a.seq).join()}|${s.state.pendingRequests.length}` : "";
  const lastWaits = useRef(waits);
  useEffect(() => {
    if (waits === lastWaits.current) return;
    lastWaits.current = waits;
    window.dispatchEvent(new Event("friday:attention"));
  }, [waits]);
  // The tab's icon carries a dot too: amber when this person is needed, violet while an agent works, green when the last run finished well.
  const tabDot = s.state ? tabStatus(s.state, s.events, attention) : null;
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;
    const base = link.dataset.base ?? (link.dataset.base = link.href);
    if (!tabDot) {
      link.href = base;
      return;
    }
    let live = true;
    void faviconSvg().then((svg) => {
      if (live && svg) link.href = `data:image/svg+xml;utf8,${encodeURIComponent(badgeFavicon(svg, TAB_DOT[tabDot]))}`;
    });
    return () => {
      live = false;
    };
  }, [tabDot]);
  useEffect(
    () => () => {
      const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (link?.dataset.base) link.href = link.dataset.base;
    },
    [],
  );

  const shownEvents = useMemo(() => (replayAt !== null ? s.events.filter((e) => e.seq <= replayAt) : s.events), [replayAt, s.events]);
  // Folded once per step of the replay, not on every draw.
  const replayState = useMemo(() => (replayAt !== null ? project(sid, shownEvents) : null), [replayAt, shownEvents, sid]);
  // Every agent's state, worked out once here for the rail, the status bar, the needs-you count and ⌘J alike, so no two
  // places can say different things about the same agent.
  const shownState = replayState ?? s.state;
  const hubAgents = useMemo(() => (shownState ? hubOf(shownState, shownEvents, s.me?.id ?? "").agents : []), [shownState, shownEvents, s.me?.id]);
  // The agent in view, one choice for the page (agentFocus.ts): the agent the panels follow, and in a split the column in
  // use. Choosing one that no column shows (⌃4, the palette, ⌘J to another agent) goes back to one chat, on it.
  const focused = useFocusedAgent(sid);
  useEffect(() => {
    if (focused !== ALL && focused !== activeLane) setActiveLane(focused);
    if (cols && !cols.includes(focused)) setColumns(sid, null);
  }, [focused, cols]); // eslint-disable-line react-hooks/exhaustive-deps
  // The address names the agent in view (?agent=), so a reload or a link sent on opens on it.
  useEffect(() => syncAddress(sid), [sid]);
  // As many columns as the window has room for, keeping the one in use; narrowing for a moment doesn't forget the rest.
  const split = wide && replayAt === null ? fitColumns(cols, room, focused, everyoneHere) : null;
  // The agents' tabs go up into the header where it has the room: a wide window showing one chat. Side by side, each column
  // has its own agent picker, and a narrow window keeps the bar across the chat.
  const [agentsSlot, setAgentsSlot] = useState<HTMLElement | null>(null);
  const headTabs = wide && !split;
  // Side by side, the rail of agents goes up into the header too, where the single chat's tabs are (Arun, 2026-10-25: "design
  // the coding tool tab better for split view"): it took a row of its own under the header, which sat empty in the middle.
  const headRail = wide && !!split;
  // An agent's tab dragged from the rail onto the chat opens it in a column beside the one in view; dropped on a column of a
  // split, beside that column, or in its place once there is no room for another.
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<{ at: number | null; box: DOMRect } | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      const lane = (e as CustomEvent<{ lane: string | null }>).detail.lane;
      setDragging(lane);
      if (!lane) setDropOn(null);
    };
    addEventListener("friday:agent-drag", on);
    return () => removeEventListener("friday:agent-drag", on);
  }, []);
  const dropAt = (e: ReactDragEvent) => {
    const col = (e.target as HTMLElement).closest?.<HTMLElement>("[data-col]");
    return col ? Number(col.dataset.col) : null;
  };
  const dropping = (lane: string, at: number | null) =>
    dropAgent(split, { lane, current: split ? activeLane : focused, everyone: everyoneHere, max: room, ...(at !== null ? { at } : {}) });
  const dropHint = (() => {
    if (!dropOn || !dragging) return "";
    const name = (l: string) => (shownState ? laneLabel(shownState, l) : l);
    const next = dropping(dragging, dropOn.at);
    if (!next) return "";
    if (split?.includes(dragging)) return `${name(dragging)} is open already`;
    if (!split) return `Open ${name(dragging)} beside ${name(next.find((l) => l !== dragging)!)}`;
    if (next.length > split.length) return `Add ${name(dragging)} as a column`;
    const gone = split.find((l) => !next.includes(l));
    return gone ? `Show ${name(dragging)} in place of ${name(gone)}` : "";
  })();
  // An agent that has left can't stay in view.
  const loaded = !!s.state;
  useEffect(() => {
    if (loaded && focused !== ALL && focused !== MAIN_LANE && !laneIds.split(",").includes(focused)) focusAgent(sid, ALL);
  }, [focused, laneIds, sid, loaded]);
  // "/" jumps to the message box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !isTyping(e.target)) {
        const el = document.getElementById("composer-input") as HTMLTextAreaElement | null;
        if (el && !el.disabled) {
          e.preventDefault();
          el.focus();
        }
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  // g then a letter jumps: d the last diff, q the last question, f the last failure, m my last message, r the last finished run.
  const jumpKeys = useRef<(e: KeyboardEvent) => void>(() => {});
  const armed = useRef(0);
  jumpKeys.current = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
    if (e.key === "g") return void (armed.current = Date.now());
    if (Date.now() - armed.current > 1500) return;
    // Not before the session has loaded: `me` is declared below the loading screens, and reading it there threw.
    const myId = s.me?.id;
    if (!myId) return;
    const t = jumpTargets(s.events, myId);
    const seq = { d: t.diff, q: t.question, f: t.failure, m: t.mine, r: t.review }[e.key];
    armed.current = 0;
    if (seq) (e.preventDefault(), jumpTo(seq));
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => jumpKeys.current(e);
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, []);

  // ⌘1 ⌘2 ⌘3 for Tasks, Files and Terminal, and ⌘⇧H for History: the same
  // presses the header buttons make, so a keyboard gets there without aiming.
  // Held in a ref so the listener is added once and always sees the latest state.
  const panelKeys = useRef<(e: KeyboardEvent) => void>(() => {});
  panelKeys.current = (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const t = (PANEL_KEYS as Record<string, Tab | undefined>)[e.key];
    if (t && !e.shiftKey) {
      e.preventDefault();
      const same = bench && t === tab;
      setBench(!same);
      setTab(t);
      if (!same) setHistory(false);
      if (!same && doc.open) onDocChange({ open: false });
    } else if (e.shiftKey && e.key.toLowerCase() === "h" && !isLocal()) {
      e.preventDefault();
      setHistory(!history);
      if (!history) setBench(false);
    }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => panelKeys.current(e);
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, []);

  // ⌃1…⌃9 bring up an agent (Alt off a Mac), ⌃0 all of them, and ⌘J the next thing any agent is waiting on you for. In the
  // box too: switching agents mid-sentence is when it is wanted most. By the key's place, not its character, since ⌥ and a
  // digit type a symbol on a Mac.
  const agentKeys = useRef<(e: KeyboardEvent) => void>(() => {});
  agentKeys.current = (e) => {
    const st = s.state;
    if (!st || replayAt !== null || e.shiftKey) return;
    const digit = /^Digit(\d)$/.exec(e.code)?.[1];
    if (digit !== undefined && (e.ctrlKey || e.altKey) && !e.metaKey && !(e.ctrlKey && e.altKey)) {
      const ids = [MAIN_LANE, ...st.lanes.map((l) => l.id)];
      const n = Number(digit);
      const lane = n === 0 ? ALL : ids[n - 1];
      if (!lane) return;
      e.preventDefault();
      focusAgent(sid, lane);
      return;
    }
    if (e.key.toLowerCase() === "j" && (e.metaKey || e.ctrlKey) && !e.altKey) {
      e.preventDefault();
      if (!jumpToNeeds(sid, hubAgents)) s.notify("Nothing is waiting on you.");
    }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => agentKeys.current(e);
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, []);

  // What ⌘K offers here: the wheel, the agent and the panels, by the names people use for them.
  useEffect(() => {
    const st = s.state;
    const who = s.me;
    const send = s.send;
    if (!onActions || !st || !who) return;
    const driving = st.driver?.id === who.id;
    const mayStop = driving || who.role === "owner";
    const list: Action[] = [];
    const act = (id: string, label: string, icon: IconName, run: () => void, hint?: string) => list.push({ id: `s-${id}`, label, icon, group: "This session", run, ...(hint ? { hint } : {}) });
    if (driving) act("release", "Release control", "hand", () => send({ type: "control.yield" }));
    else if (can(st, who.id, "control")) act("take", st.driver ? "Request control" : "Take control", "hand", () => send({ type: st.driver ? "control.request" : "control.claim" }));
    if (st.run.status === "running" && mayStop) act("pause", "Stop the agent's task", "pause", () => send({ type: "run.pause" }));
    if (st.run.status === "paused" && mayStop) act("resume", "Resume the agent", "play", () => send({ type: "run.resume" }));
    for (const v of VIEWS) act(`open-${v.tab}`, `Open ${v.label}`, v.icon, () => (setTab(v.tab), setBench(true)));
    act("history", "Open history", "clock", () => (setHistory(true), setBench(false)));
    act("ask", "Write to the agent", "message", () => document.getElementById("composer-input")?.focus(), "/");
    act("file", "Open a file…", "file", () => (setTab("files"), setBench(true), setTimeout(() => dispatchEvent(new CustomEvent("friday:quick-open")), 60)), shortcut("⌘P"));
    // Every agent by name, and what is waiting: the palette is where a keyboard goes when it doesn't know the number.
    if (hubAgents.length > 1) {
      act("agent-all", "Show all agents", "list", () => focusAgent(sid, ALL), agentKey(0));
      hubAgents.forEach((a, i) => act(`agent-${a.lane}`, `Go to ${a.name}`, "agent", () => focusAgent(sid, a.lane), i < 9 ? agentKey(i + 1) : undefined));
    }
    if (hubAgents.some((a) => a.needsYou)) act("needs", "Next thing waiting on you", "bell", () => void jumpToNeeds(sid, hubAgents), nextKey());
    onActions(list);
    return () => onActions([]);
  }, [s.state?.driver?.id, s.state?.run.status, s.me?.id, s.me?.role, invites, sid, hubAgents.map((a) => `${a.lane}:${a.name}:${a.needsYou}`).join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!s.toast) return;
    const t = setTimeout(s.clearToast, 3500);
    return () => clearTimeout(t);
  }, [s.toast]); // eslint-disable-line react-hooks/exhaustive-deps

  // Above the early returns below, like every hook here: a hook that runs on some draws and not others is a crash.
  // Focus, the layout with the status bar along the foot, on Solo and Team alike; Classic is one switch away in Settings.
  const focus = useSessionLayout() === "focus";
  const [statusSlot, setStatusSlot] = useState<HTMLElement | null>(null);
  // Stable, so the feed can skip redrawing what didn't change.
  const onConnect = useCallback((lane: string, tool?: EngineTool | "", from?: string) => setConnect({ lane, ...(tool !== undefined ? { tool } : {}), ...(from ? { from } : {}) }), []);
  const onOpen = useCallback((what: "files" | "tree" | "preview") => {
    setTab(what === "tree" ? "tree" : what === "preview" ? "preview" : "files");
    setBench(true);
    setHistory(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Opening a session that never says hello (the server down, a proxy in the way) showed the skeleton for good: after a while it
  // says so, with the way to try again (Arun, 2026-10-24: UX gaps).
  const loading = !s.state || !s.me;
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (!loading) return setStalled(false);
    const t = setTimeout(() => setStalled(true), 10_000);
    return () => clearTimeout(t);
  }, [loading]);
  // A page you can't use says where to go instead: home, or off your list.
  const away = (
    <>
      <a className="btn" href="/">
        Back to home
      </a>
      {onRemove && (
        <button type="button" className="btn ghost" onClick={() => onRemove(sid)}>
          Remove it from your list
        </button>
      )}
    </>
  );

  // Its history went before it was kept anywhere that lasts (Redis evicted it, 2026-10-19): said plainly, with the way to tidy up.
  if (s.conn === "rejected" && s.rejectReason === SESSION_GONE)
    return (
      <div className="grid h-full place-items-center">
        <EmptyState
          icon={<HistoryIcon />}
          title="This session's history is gone"
          action={
            onRemove && (
              <button type="button" className="btn" onClick={() => onRemove(sid)}>
                Remove it from your list
              </button>
            )
          }
        >
          The server lost it before Friday kept a lasting copy of every session. Your code changes are still in your folder and on their branches, and a Claude Code or Codex conversation can be carried on in a new session.
        </EmptyState>
      </div>
    );
  if (s.conn === "rejected") return <Centered title="Can't open this session" body={s.rejectReason || "This invite link isn't valid for this session."} actions={away} />;
  if (s.conn === "removed") return <Centered title="You were removed from this session" body="Ask one of its owners to add you back." actions={away} />;
  // Opening a session lands here for a moment. A bare "Connecting…" reads as
  // a stall, particularly straight after pressing send on the home screen —
  // where the last thing that happened was your own instruction and the next
  // thing is a blank page. The indicator says the same word and looks alive.
  if (!s.state || !s.me)
    return stalled ? (
      <Centered
        title="Can't reach this session yet"
        body="Friday is still trying. Check your connection, or try again."
        actions={
          <button type="button" className="btn primary" onClick={() => location.reload()}>
            Try again
          </button>
        }
      />
    ) : (
      <SessionSkeleton />
    );
  const { me, send } = s;
  /**
   * Replay is the live session, folded over a shorter prefix.
   *
   * No stored snapshots and no second code path: the feed, the diffs and the
   * control strip all read the same two values they always read, and winding
   * back is a shorter list and the state that falls out of it. That is the
   * whole reason an event log is worth the trouble.
   */
  const replaying = replayAt !== null;
  const state = replayState ?? s.state;

  // Two agents' chats side by side: from an agent tab's menu now (Activity), the header's button gone (Arun, 2026-10-24). With a
  // lane, that agent opens beside the one in view; without, the next agent here does.
  const splitView = {
    on: !!split,
    can: wide && !replaying && state.lanes.length > 0,
    toggle: (lane?: string) => {
      if (split) return setColumns(sid, null, activeLane);
      const left = focused !== ALL && everyoneHere.includes(focused) ? focused : MAIN_LANE;
      const other = lane && lane !== left && everyoneHere.includes(lane) ? lane : everyoneHere.find((id) => id !== left)!;
      setColumns(sid, dropAgent(null, { lane: other, current: left, everyone: everyoneHere, max: room }), left);
    },
  };
  const activityProps = {
    split: splitView,
    merged,
    // The session as a story, from the start: the History panel opens and plays.
    onPlayBack: () => {
      setReplayAt(null);
      setBenchState(false);
      setHistory(true);
      setPlayback((n) => n + 1);
    },
    seenSeq: s.seenSeq,
    presence: s.presence,
    plan,
    solo,
    soloSure: !!sessionPlan && !sessionPlan.team,
    agents,
    connections,
    state,
    me,
    events: shownEvents,
    replaying,
    streams: replaying ? {} : s.streams,
    send,
    sid,
    invite,
    notify: s.notify,
    identity,
    onConnect,
    onOpen,
    under: focus && !split ? statusSlot : null,
  };

  return (
    <AgentsContext.Provider value={hubAgents}>
    <FocusContext.Provider value={focusValue}>
    <div className={`session-view${focus ? " focus" : ""}`}>
      <TopBar
        {...(headTabs || headRail ? { agentsSlot: setAgentsSlot } : {})}
        sessionPlan={sessionPlan}
        solo={solo}
        focus={focus}
        follow={{ id: following, set: setFollowing, at: others }}
        notify={s.notify}
        onConnect={(tool) => setConnect({ lane: "", ...(tool ? { tool } : {}) })}
        onRace={() => setRacing(true)}
        {...(onExpandSidebar ? { onExpandSidebar } : {})}
        strip={
            <ControlStrip
              state={s.state}
              me={me}
              agents={agents}
              identity={identity}
              presence={s.presence}
              send={send}
              onConnect={(tool) => setConnect({ lane: "", ...(tool ? { tool } : {}) })}
              onRace={() => setRacing(true)}
              events={s.events}
              replayAt={replayAt}
              onReplay={setReplayAt}
              onExitReplay={() => setReplayAt(null)}
            />
        }
        state={state}
        me={me}
        presence={s.presence}
        anonymous={s.anonymous}
        events={s.events}
        conn={s.conn}
        invites={s.invites}
        agents={agents}
        sid={sid}
        invite={invite}
        send={send}
        identity={identity}
        view={{
          bench,
          tab,
          files: Object.values(state.diffs).reduce((n, d) => n + d.files.length, 0),
          working: state.run.status === "running" || Object.values(state.laneRuns).some((r) => r.status === "running"),
          // The side panel as a whole, from its one button in the header: open on the panel it last showed, or closed.
          onPanel: () => {
            if (history) return setHistory(false);
            if (bench) return (setBench(false), setPicking(false));
            let picked = false;
            try {
              picked = localStorage.getItem(pickedKey) === "1";
            } catch {}
            setPicking(!picked);
            setBench(true);
            if (doc.open) onDocChange({ open: false });
          },
          onTab: (t) => {
            setPicking(false);
            // Same tab again closes it; a different one switches without a
            // second click to reopen.
            const same = bench && t === tab;
            setBench(!same);
            setTab(t);
            if (!same) setHistory(false);
            if (!same && doc.open) onDocChange({ open: false });
          },
          history: {
            open: history,
            onToggle: () => {
              setHistory(!history);
              if (!history) setBench(false);
            },
          },
          split: { on: splitView.on, can: splitView.can, onToggle: () => splitView.toggle() },
        }}
      />
      {racing && <RaceDialog state={state} me={me} identity={identity} sid={sid} invite={invite} send={send} onClose={() => setRacing(false)} solo={solo} />}
      {connect !== null && <ConnectDialog state={state} me={me} sid={sid} invite={invite} identity={identity} send={send} lane={connect.lane} tool={connect.tool} {...(connect.from ? { from: connect.from } : {})} onClose={() => setConnect(null)} />}
      {/* The controls and the banners belong to the conversation, not to the
          window: keeping them inside this column is what lets the workbench
          start at the header's line instead of below everything the session
          had to say first. */}
      <div className="sv-body">
        <div
          className="sv-main"
          onDragOver={(e) => {
            if (!wide || replaying || !e.dataTransfer.types.includes(AGENT_DRAG)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            const at = dropAt(e);
            if (!dropOn || dropOn.at !== at) setDropOn({ at, box: e.currentTarget.getBoundingClientRect() });
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOn(null);
          }}
          onDrop={(e) => {
            const lane = e.dataTransfer.getData(AGENT_DRAG);
            setDropOn(null);
            setDragging(null);
            if (!lane || !wide || replaying) return;
            // Not into the box as text: the drop is the agent, not its name.
            e.preventDefault();
            const next = dropping(lane, dropAt(e));
            if (next) setColumns(sid, next, lane);
          }}
        >
          {dropOn && dropHint && (
            <div className={`drop-zone${dropOn.at === null && !split ? " beside" : ""}`} style={{ top: dropOn.box.top, left: dropOn.box.left, width: dropOn.box.width, height: dropOn.box.height }} aria-hidden>
              <span>{dropHint}</span>
            </div>
          )}
          {/* Live state, always. This row is about now — who is driving, what
              is running — and winding the feed back must not offer a button
              based on who was driving an hour ago. */}
          {me.role === "viewer" && !replaying && <ViewerCard state={s.state} events={s.events} me={me} send={send} solo={solo} notify={s.notify} />}
          {/* Banners are about now, so they go when the feed does. */}
          {/* No "While you were away" card (Arun, 2026-10-21: "get rid of this too"): the feed's "New since you looked" line marks where you left off. */}
          {!replaying && <Banners state={state} me={me} send={send} />}
          {!replaying && <HandoverBanner state={state} me={me} />}
          {(() => {
            const column = (lane: string, at: number) => (
              <div key={lane} className={`split-col${activeLane === lane ? " on" : ""}${dropOn?.at === at ? " drop-on" : ""}`} data-col={at}>
                <Activity
                  {...activityProps}
                  key={lane}
                  pin={lane}
                  secondary={at > 0}
                  onFocusLane={(l) => (setActiveLane(l), focusAgent(sid, l))}
                  onCloseColumn={() => {
                    const rest = split!.filter((_, i) => i !== at);
                    setColumns(sid, closeColumn(split!, at), activeLane === lane ? rest[0] : activeLane);
                  }}
                  otherLanes={split!.filter((l) => l !== lane)}
                  // The other column's agent: swap, so no two show the same one.
                  onPickLane={(next) => setColumns(sid, pickInColumn(split!, at, next), next)}
                />
              </div>
            );
            if (split) {
              const ws = widths.length === split.length ? widths : evenWidths(split.length);
              return (
                <>
                  {headRail && agentsSlot ? createPortal(<SplitRail sid={sid} state={state} events={s.events} me={me.id} shown={split} active={activeLane} room={room} head />, agentsSlot) : <SplitRail sid={sid} state={state} events={s.events} me={me.id} shown={split} active={activeLane} room={room} />}
                  <div className="split-cols" style={{ gridTemplateColumns: ws.map((w) => `minmax(0, ${w}fr)`).join(" 8px ") }}>
                    {split.flatMap((lane, at) => [
                      ...(at > 0
                        ? [
                            <div
                              key={`grip-${at}`}
                              className="col-grip"
                              role="separator"
                              aria-orientation="vertical"
                              aria-label="Resize the chats"
                              onPointerDown={(e) => {
                                const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                                // At most once a frame, however fast the pointer: every move re-laid both chats out, a backlog of
                                // renders the grip trailed behind (Arun, 2026-10-24: "make the side panels more smoother when
                                // dragging"). The resizing class lets the messages out of view skip layout while it moves.
                                let x = e.clientX;
                                let frame = 0;
                                let moved = false;
                                document.body.classList.add("resizing", "resizing-x");
                                const move = (ev: PointerEvent) => {
                                  x = ev.clientX;
                                  moved = true;
                                  frame ||= requestAnimationFrame(() => {
                                    frame = 0;
                                    setWidths(resizeAt(ws, at - 1, ((x - box.left) / box.width) * 100, split.length > 2 ? 18 : 25));
                                  });
                                };
                                // A drag the system takes away (a touch turned scroll, a window switch) ends it too, or the grip follows the pointer on.
                                const up = () => {
                                  if (frame) cancelAnimationFrame(frame);
                                  // Where it was let go, so the last move isn't lost to the frame it was waiting for; a click moves nothing.
                                  if (moved) setWidths(resizeAt(ws, at - 1, ((x - box.left) / box.width) * 100, split.length > 2 ? 18 : 25));
                                  document.body.classList.remove("resizing", "resizing-x");
                                  removeEventListener("pointermove", move);
                                  removeEventListener("pointerup", up);
                                  removeEventListener("pointercancel", up);
                                };
                                addEventListener("pointermove", move);
                                addEventListener("pointerup", up);
                                addEventListener("pointercancel", up);
                              }}
                            />,
                          ]
                        : []),
                      column(lane, at),
                    ])}
                  </div>
                </>
              );
            }
            return <Activity {...activityProps} headSlot={headTabs ? agentsSlot : null} />;
          })()}
        </div>
        <BenchOrHistory
          bench={bench}
        >
          <Workbench
            open={bench}
            {...(split ? { lane: activeLane } : focused !== ALL ? { lane: focused } : {})}
            state={state}
            events={s.events}
            identity={identity}
            sid={sid}
            invite={invite}
            me={me}
            send={send}
            tab={tab}
            onTab={setTab}
            openFile={openFile}
            width={benchWidth}
            onWidth={(w) => {
              setBenchWidth(w);
              try {
                localStorage.setItem("mpa.benchWidth", String(w));
              } catch {
                // A preference; losing it costs nothing.
              }
            }}
            onClose={() => (setBench(false), setPicking(false))}
            picking={picking}
            onPick={pickPanel}
            onPicker={() => setPicking(true)}
            badges={{ files: Object.values(state.diffs).reduce((n, d) => n + d.files.length, 0), working: state.run.status === "running" || Object.values(state.laneRuns).some((r) => r.status === "running") }}
            headless={solo}
            addAgent={<Lanes state={state} me={me} agents={agents} identity={identity} send={send} onConnect={(tool) => setConnect({ lane: "", ...(tool ? { tool } : {}) })} onRace={() => setRacing(true)} solo={solo} />}
          />
        </BenchOrHistory>
      </div>
      {/* Notices about now that you read and wave away float as toasts at the top right, stacked, rather than
          pushing the conversation down: what happened while you were away, and a file somebody else is changing too.
          Outside the session's row, so a panel lying over the chat (which makes the chat inert) leaves them usable. */}
      {/* No "While you were away" card any more (Arun, 2026-10-19: "get rid of this"): the agent rail, the needs-you pill and
          the "New since you looked" line in the chat already say what changed, and the card stood over the work. */}
      {!replaying && overlaps && overlaps.length > 0 && (
        <div className="toast-stack">
          {overlaps && overlaps.length > 0 && <OverlapNotice overlaps={overlaps} {...(onOpenSession ? { onOpen: onOpenSession } : {})} />}
        </div>
      )}
      {focus && (
        <StatusBar
          state={s.state}
          events={s.events}
          me={s.me.id}
          slot={setStatusSlot}
          onChanges={() => onOpen("files")}
          where={<Where state={s.state} sid={sid} invite={invite} send={send} />}
          environment={<EnvironmentButton state={s.state} me={s.me.id} sid={sid} invite={invite} identity={identity} onOpen={(tab) => (setTab(tab), setBench(true), setHistory(false))} />}
        />
      )}
      {/* No toast across the foot of the session any more (Arun, 2026-10-23: "get rid of the toast thing that appears in the
          middle of the coding session at the bottom"): it stood over the conversation and the message box. Still said to a
          screen reader, which shows nothing. */}
      <div className="sr-only" role="status" aria-live="polite">
        {s.toast}
      </div>
    </div>
    </FocusContext.Provider>
    </AgentsContext.Provider>
  );
}

function Centered({ title, body, actions }: { title: string; body?: string; actions?: ReactNode }) {
  return (
    <div className="centered">
      <h2>{title}</h2>
      {body && <p className="muted">{body}</p>}
      {actions && <div className="centered-actions">{actions}</div>}
    </div>
  );
}

// ── presence ────────────────────────────────────────────────────────

/**
 * Who's here and who holds control. The one-glance answer to "can I touch
 * this right now?": the controller sorts first with a ring in their colour.
 */
export interface FollowState {
  /** Whose view this person is following, if anyone's. */
  id: string | null;
  set: (id: string | null) => void;
  /** Where everyone else is, by person. */
  at: Record<string, { name: string; at: Focus }>;
}

/** "Looking at Files", "in Reviewer's chat": where somebody is, in a few words, for the list. */
function whereWords(f: Focus | undefined, state: SessionState): string {
  if (!f) return "";
  const parts: string[] = [];
  if (f.panel) parts.push(f.panel === "history" ? "History" : (TAB_LABEL[f.panel as Tab] ?? f.panel));
  if (f.path) parts.push(f.path.split("/").slice(-1)[0] ?? f.path);
  if (f.lane && f.lane !== MAIN_LANE) parts.push(`${state.lanes.find((l) => l.id === f.lane)?.name ?? "another agent"}'s chat`);
  return parts.join(" · ");
}

function PresenceBar({ presence, state, me, events, send, follow }: { presence: PresenceMember[]; state: SessionState; me: Member; events: SessionEvent[]; send: Send; follow: FollowState }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const driverId = state.driver?.id;
  const people = [...presence].sort((a, b) => Number(b.id === driverId) - Number(a.id === driverId) || Number(b.online) - Number(a.online));
  const shown = people.slice(0, 3);
  const online = people.filter((x) => x.online).length;
  const [roster, setRoster] = useState(false);
  const [ask, confirmUI] = useConfirm();
  const [handover, setHandover] = useState(false);
  const following = follow.id ? (presence.find((p) => p.id === follow.id) ?? null) : null;
  const rosterRef = useRef<HTMLDivElement>(null);
  useDismiss(rosterRef, () => setRoster(false));
  const first = (n: string) => n.split(/\s+/)[0];
  const label = !state.driver ? "Nobody has control" : driverId === me.id ? "You have control" : `${first(state.driver.name)} has control`;
  const joinedAt = (id: string) =>
    events.find((e) => (e.body.type === "member.joined" && e.actor.id === id) || (e.body.type === "session.created" && e.body.ownerId === id))?.ts;

  return (
    <div className="presence-bar" aria-label={`${online} online. ${label}.`}>
      {/* Who is here, in two words; the list behind it says who is not. */}
      <span className="pb-roster-wrap" ref={rosterRef}>
        <button type="button" className={`pb-roster ${roster ? "on" : ""}`} aria-expanded={roster} onMouseDown={(e) => e.stopPropagation()} onClick={() => setRoster((v) => !v)}>
          <i className={`pb-dot inline ${online ? "on" : ""}`} aria-hidden="true" />
          {following ? (
            <>Following {following.name.split(/\s+/)[0]}</>
          ) : (
            <>
              {online} online{people.length > online ? <span className="pb-off"> · {people.length - online} away</span> : null}
            </>
          )}
        </button>
        {following && (
          <button type="button" className="pb-unfollow" aria-label={`Stop following ${following.name}`} title="Stop following" onClick={() => follow.set(null)}>
            <Icon name="x" size={12} />
          </button>
        )}
        {roster && (
          <div className="popover pb-pop" role="dialog" aria-label="Who is in this session">
            <button type="button" className="pb-handover" onClick={() => (setRoster(false), setHandover(true))}>
              <Icon name="book" size={13} /> Where we left off
            </button>
            {[true, false].map((on) => {
              const group = people.filter((x) => x.online === on);
              if (!group.length) return null;
              return (
                <div key={String(on)} className="pb-group">
                  <div className="pb-group-title">{on ? "Online" : "Offline"} · {group.length}</div>
                  {group.map((x) => (
                    <div key={x.id} className={`pb-row ${on ? "" : "off"}`}>
                      <span className="pb-row-av">
                        <Avatar name={x.name} id={x.id} size={24} />
                        <i className={`pb-dot ${on ? "on" : ""}`} aria-hidden="true" />
                      </span>
                      {/* Somebody who can be followed has a second line under the name, with their role and where they are, so the name is
                          never squeezed to make room; everybody else has their role at the right, as before. */}
                      {on && x.id !== me.id && follow.at[x.id] ? (
                        <span className="pb-row-name two">
                          <span className="pb-row-title">{x.name}</span>
                          <span className="pb-row-sub">
                            <span className="pb-row-role">{x.id === driverId ? "Driving" : x.role}</span>
                            {" · "}
                            {whereWords(follow.at[x.id]!.at, state) || "Nothing open"}
                          </span>
                        </span>
                      ) : (
                        <>
                          <span className="pb-row-name">
                            {x.name}
                            {x.id === me.id && <span className="muted"> (you)</span>}
                          </span>
                          <span className="pb-row-text">
                            <span className="pb-row-meta">{x.id === driverId ? "Driving" : x.role}</span>
                          </span>
                        </>
                      )}
                      {me.role === "owner" && x.id !== me.id && (
                        <button
                          type="button"
                          className="pb-kick"
                          title={`Remove ${x.name} from this session`}
                          aria-label={`Remove ${x.name} from this session`}
                          onClick={() =>
                            ask({
                              title: `Remove ${x.name}?`,
                              body: "They are disconnected straight away, their invite link stops working for them, and they lose control of any agent they were driving. What they already contributed stays in the session log.",
                              action: `Remove ${x.name}`,
                              danger: true,
                              onConfirm: async () => {
                                setRoster(false);
                                await send({ type: "member.remove", userId: x.id });
                              },
                            })
                          }
                        >
                          <Icon name="x" size={13} />
                        </button>
                      )}
                      {on && x.id !== me.id && follow.at[x.id] && (
                        <button type="button" className={`pb-follow ${follow.id === x.id ? "on" : ""}`} onClick={() => (follow.set(follow.id === x.id ? null : x.id), setRoster(false))}>
                          {follow.id === x.id ? "Following" : "Follow"}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </span>
      {confirmUI}
      {handover && <HandoverDialog state={state} events={events} send={send} canSave={me.role !== "viewer"} onClose={() => setHandover(false)} />}
    </div>
  );
}

/** Who someone is and what they can do here; the driver can hand them control from it. */
function PersonCard({
  events,
  person,
  state,
  me,
  joinedAt,
  send,
  onClose,
}: {
  events: SessionEvent[];
  person: PresenceMember;
  state: SessionState;
  me: Member;
  joinedAt?: number;
  send: Send;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  const driving = state.driver?.id === person.id;
  const iDrive = state.driver?.id === me.id;
  const canDrive = person.role === "owner" || state.options.policy[person.role].control;
  const asked = state.pendingRequests.some((r) => r.id === person.id && r.lane === MAIN_LANE);
  const first = person.name.split(/\s+/)[0];
  const [briefed, setBriefed] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [shownBrief, setShownBrief] = useState("");
  /** Three lines for this person: where it stands, what to do first, and the way in. Copied, to be pasted wherever they are. */
  const brief = () => {
    const note = leftOff(state, events);
    const text = [`${first}, here is where “${state.title}” stands: ${note.status.line}`, note.next ? `Start with: ${note.next}` : "", `${location.origin}/?session=${encodeURIComponent(state.id)}`].filter(Boolean).join("\n");
    void navigator.clipboard?.writeText(text).then(
      () => (setBriefed(true), setTimeout(() => setBriefed(false), 1500)),
      // Not prompt(): the desktop app doesn't have one. The button says it didn't work, for a moment.
      () => (setCopyFailed(true), setShownBrief(text), setTimeout(() => setCopyFailed(false), 2000)),
    );
  };
  return (
    <div className="popover person-card" role="dialog" aria-label={person.name} ref={ref}>
      <div className="pc-head">
        <Avatar name={person.name} id={person.id} size={40} />
        <div className="pc-id">
          <div className="pc-name">
            {person.name}
            {person.id === me.id && <span className="muted"> (you)</span>}
          </div>
          <div className={`pc-status ${person.online ? "on" : ""}`}>{person.online ? "Online now" : "Offline"}</div>
        </div>
      </div>
      <dl className="pc-facts">
        <dt>Role</dt>
        <dd>
          <span className={`role role-${person.role}`}>{person.role}</span>
        </dd>
        <dt>Control</dt>
        <dd>{driving ? "Has control" : asked ? "Asked for control" : canDrive ? "Can take control" : "Watching only"}</dd>
        {joinedAt && (
          <>
            <dt>Joined</dt>
            <dd>{new Date(joinedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</dd>
          </>
        )}
      </dl>
      {person.id !== me.id && (
        <button className="btn small pc-action" title="Copy a three-line brief for them: where it stands, what to do first, and the link" onClick={brief}>
          <Icon name={briefed ? "check" : "copy"} size={13} /> {briefed ? "Copied" : copyFailed ? "Copy failed" : `Catch ${first} up`}
        </button>
      )}
      {shownBrief && person.id !== me.id && <ShownText text={shownBrief} />}
      {iDrive && person.id !== me.id && canDrive && person.online && (
        <button
          className="btn primary small pc-action"
          onClick={() => {
            send({ type: "control.yield", to: person.id });
            onClose();
          }}
        >
          <Icon name="hand" size={13} /> Hand control to {first}
        </button>
      )}
    </div>
  );
}

// ── top bar ─────────────────────────────────────────────────────────

function TopBar({
  follow,
  strip,
  state,
  me,
  presence,
  anonymous,
  events,
  conn,
  invites,
  agents,
  sid,
  invite,
  send,
  notify,
  identity,
  view,
  onExpandSidebar,
  onConnect,
  onRace,
  sessionPlan,
  solo,
  focus = false,
  agentsSlot,
}: {
  /** Where the agents' tabs go in the header, when the window is wide enough for them there (Activity headSlot). */
  agentsSlot?: (el: HTMLElement | null) => void;
  /** Solo or Team for this session (null until known). */
  sessionPlan: SessionPlan | null;
  /** This session is Solo: worked out once, by the page. */
  solo: boolean;
  /** The Focus layout: where it is working moves to the status bar, so the header is the name alone. */
  focus?: boolean;
  /** Following a teammate's view: who, how to stop, and where everyone is. */
  follow: FollowState;
  /** Connecting a coding agent, and racing two: what the agents button opens. */
  onConnect: (tool?: EngineTool) => void;
  onRace: () => void;
  /** The agents, history and control buttons live in the header: it had the room. */
  strip?: ReactNode;
  state: SessionState;
  me: Member;
  presence: PresenceMember[];
  /** People watching live without an account (live-watch.ts): shown as a count, so nobody is watched without the owner knowing. */
  anonymous: number;
  events: SessionEvent[];
  conn: string;
  invites?: Record<string, string> | null;
  agents: AgentView[];
  sid: string;
  invite: string;
  send: Send;
  /** A short message in the corner. */
  notify: (m: string) => void;
  identity: Identity;
  onExpandSidebar?: () => void;
  view: {
    /** The workbench is open, and which of its tabs is showing. */
    bench: boolean;
    tab: Tab;
    files: number;
    /** Opens or closes the side panel, on the panel it last showed. */
    onPanel: () => void;
    /** Something is running, so the Tasks button can say so without a number. */
    working: boolean;
    onTab: (t: Tab) => void;
    /** The history panel, which is not one of the workbench's tabs: it winds the whole session back. */
    history: { open: boolean; onToggle: () => void };
    /** Two agents' chats side by side: whether it is on, whether there are two agents to show, and the switch. */
    split: { on: boolean; can: boolean; onToggle: () => void };
  };
}) {
  const [settings, setSettings] = useState(false);
  const [editing, setEditing] = useState(false);
  const [meterOn, setMeterOn] = useState(() => localStorage.getItem("mpa.meter") === "1");
  const owner = me.role === "owner";
  const agent = state.options.agent;
  const repo = repoOf(state);
  // Any agent's question holds it up, not only the main one's: with two asking, both people are named.
  const asked = [...new Set(Object.values(state.openQuestions).map((q) => q.toName))];
  const waiting = state.run.status === "waiting_for_human" || asked.length > 0;
  const label = `Waiting for ${asked.join(" and ") || "a human"}`;

  const left = (
      <div className={`tb-left${focus ? " focus" : ""}`}>
        <div className="tb-title">
        {editing ? (
          <InlineEdit
            className="title-edit"
            value={state.title}
            maxLength={120}
            onSave={(t) => {
              send({ type: "settings.update", title: t });
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <h1 className={owner ? "editable" : ""} title={owner ? `${state.title} (click to rename)` : state.title} onClick={() => owner && setEditing(true)}>
            {state.title}
          </h1>
        )}
        {/* Only when something needs a person. "Working" and "Idle" were a permanent
            tag saying the ordinary thing was happening, and "Stopped" was a red
            mark by the title for a run that had said so in the conversation. */}
        {waiting && !focus && (
          <span className="status st-waiting_for_human">
            <span className="dot" />
            {label}
          </span>
        )}
        {meterOn && <Meter events={events} running={state.run.status === "running"} />}
        </div>
        {/* Where it is working, under the name rather than beside it: two short lines take less width than one long one. */}
        {(agent || repo) && !focus && (
        <div className="tb-meta">
        {agent && (
          <span className="agent-chip" title={`Custom agent “${agent.name}” (v${agent.version}) by ${agent.ownerName}`}>
            <Icon name={agent.icon as IconName} size={14} /> {agent.name}
          </span>
        )}
        {repo && (
          <>
            <GitMenu state={state} sid={sid} invite={invite} send={send} clickToo below>
              <button type="button" className="repo-chip repo-chip-btn" title={`Commit, pull request, fork · ${repo.path} · on ${repo.host}'s machine`}>
                <FolderGit2Icon className="size-3.5 shrink-0" />
                <span className="repo-name">{repo.name}</span>
                <ChevronDownIcon className="size-3 shrink-0 repo-caret" />
              </button>
            </GitMenu>
            {/* The branch is its own control: pressed, it lists the folder's branches to work in, or names a new one. */}
            <span className="repo-branch-wrap">
              <BranchButton sid={sid} invite={invite} send={send} lane={repo.lane} idle={!anyRunning(state)} {...(repo.branch ? { branch: repo.branch } : {})} />
            </span>
          </>
        )}
        </div>
        )}
        {agentsSlot && <div className="tb-agents" ref={agentsSlot} />}
      </div>
  );
  const right = (
    <>
      {strip}
      <div className="tb-right">
        {/* Other sessions waiting on you, as a button here rather than toasts over the chat and its panels (see WaitingOnYou). */}
        <span id="wy-slot" />
        {/* Who is here, and the people panel, are Team's: on Solo you work alone (sharing to viewers is to be worked out). */}
        {/* On Solo nobody else works here, but a watch link can bring viewers: a quiet eye and a count, only while somebody is watching. */}
        {/* People watching through the viewer link without an account are counted here too, on every plan, as "someone watching". */}
        {(solo || anonymous > 0) && (() => {
          const watching = solo ? presence.filter((p) => p.online && p.id !== me.id) : [];
          const n = watching.length + anonymous;
          if (!n) return null;
          const names = [...watching.map((p) => p.name), ...(anonymous ? [anonymous === 1 ? "someone with the watch link" : `${anonymous} people with the watch link`] : [])];
          const who = names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
          return (
            <span className="watchers" role="status" aria-label={`${n} watching: ${who}`} title={`Watching now: ${who}`}>
              <Icon name="eye" size={14} />
              <span className="watchers-n">{n}</span>
            </span>
          );
        })()}
        {!solo && (
          <>
            <PresenceBar presence={presence} state={state} me={me} events={events} send={send} follow={follow} />
            <span className="tb-divider" />
          </>
        )}
        {/* No Agents button here: Agents is in the side panel, and the agents themselves are tabs in this header (Arun,
            2026-10-24: "get rid of this since it is already in the side panel part too"). */}
        {/* Share on every plan: the watch link and the recording, for whoever may hand them out. */}
        {/* One button for the room, on every plan: who is in it, its invite and watch links, and its settings. Share had the same
            links in a second button beside it (Arun, 2026-10-24: "get rid of the share button in the header and add the dropdown
            content in the people's dropdown"); on Solo it was the only way to them, so the People panel is there on Solo too. */}
        {/* The local edition's in its place: this session's settings, and the line about Friday Team (SessionMenu). */}
        {isLocal() && <SessionMenu settings={owner ? <SettingsBody solo state={state} send={send} meter={{ on: meterOn, set: (v) => (setMeterOn(v), localStorage.setItem("mpa.meter", v ? "1" : "0")) }} /> : undefined} />}
        {/* One button for the side panel, where the panels are a card to pick from (Workbench), in place of a row of four and a
            "⋯" here (Arun, 2026-10-24: "using this svg icon make it be the side panel button and on the side panel open it will
            have a card with the options for tasks, diff, terminal, etc"). What they hold still shows: the diff's count, a dot while
            the agent works. */}
        {(() => {
          const on = view.bench || view.history.open;
          return (
            <button
              type="button"
              className={`panel-tab icon side-panel-btn ${on ? "on" : ""}`}
              aria-pressed={on}
              aria-label={`${on ? "Close the side panel" : "Open the side panel"}${view.files ? `, ${view.files} changed` : ""}${view.working ? ", running" : ""}`}
              title={on ? "Close the side panel" : "Side panel: tasks, diff, terminal, preview and more"}
              onClick={view.onPanel}
            >
              <Icon name="sidePanel" size={18} />
              {/* No count of changed files on it (Arun, 2026-10-24: "get rid of the numbers too"): the status bar says how many,
                  and Diff in the panel's card does. The dot stays: something is running. */}
              {view.working && <i className="panel-tab-dot" />}
            </button>
          );
        })()}
        {/* Only when it isn't. "Live" was a permanent badge saying the normal
            thing was happening, which is the state nobody needs telling about. */}
        {conn !== "live" && (
          <span className={`conn ${conn}`} title="Reconnecting">
            Reconnecting…
          </span>
        )}
      </div>
    </>
  );

  // In the desktop app there is a band across the top of the window with room in it
  // and the window's own buttons at its end; the header's controls live there, and the
  // page starts at the conversation. In a browser there is no band, and this is the
  // header it always was.
  const [band, setBand] = useState<{ left: HTMLElement; right: HTMLElement } | null>(null);
  useLayoutEffect(() => {
    const left = document.getElementById("band-left");
    const right = document.getElementById("band-slot");
    const banded = inBand();
    setBand(banded && left && right ? { left, right } : null);
    // Tells the window's stylesheet where the page should start while this header is up there.
    if (banded) document.documentElement.dataset.band = "session";
    return () => {
      delete document.documentElement.dataset.band;
    };
  }, []);
  if (band) {
    return (
      <>
        {createPortal(left, band.left)}
        {createPortal(right, band.right)}
      </>
    );
  }
  return (
    <header className="topbar">
      {left}
      {right}
    </header>
  );
}

/** How long the newest run has taken and what it has cost so far. Opt-in, and only the run: a session total is a number nobody can act on. */
function Meter({ events, running }: { events: SessionEvent[]; running: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.body.type === "run.started") { start = i; break; }
  if (start < 0) return null;
  const from = events[start]!.ts;
  const end = running ? now : (events.slice(start).find((e) => e.body.type === "run.ended")?.ts ?? events.at(-1)!.ts);
  const tokens = events.slice(start).reduce((n, e) => n + (e.body.type === "agent.message" ? (e.body.tokens ?? 0) : 0), 0);
  const secs = Math.max(0, Math.round((end - from) / 1000));
  const time = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
  return (
    <span className="meter" title="This run: time so far and tokens used">
      {time}
      {tokens > 0 ? ` · ${tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k` : tokens} tokens` : ""}
    </span>
  );
}

/**
 * The code this session is working in, if any: the folder a connected coding
 * agent runs in, with the branch it is on. The main lane wins when several
 * agents are connected, since that is the one the session is named after.
 */

/**
 * Every repo this session has an agent in, one entry per repo.
 *
 * A lane in its own worktree sits in `<repo>-<id>`, so the id is taken off to
 * name the repo it belongs to; several lanes in one repo show as one repo.
 * Racing copies are left out: they are throwaways, not the project.
 */
export function reposOf(state: SessionState | null | undefined): RepoUse[] {
  if (!state) return [];
  const by = new Map<string, RepoUse>();
  for (const [lane, e] of Object.entries(state.engines)) {
    if (!e.cwd || /friday-race-[0-9a-f]{8}/.test(e.cwd)) continue;
    const base = e.cwd.split(/[\\/]/).filter(Boolean).pop() ?? e.cwd;
    // A worktree's folder is `<repo>-<id>`: it belongs to the repo, whatever lane is in it.
    const name = base.replace(/-[0-9a-f]{8}$/, "");
    const had = by.get(name);
    // The main lane's branch is the one to show; a lane's own worktree branch is a detail of that lane.
    if (!had || lane === MAIN_LANE) by.set(name, { name, branch: lane === MAIN_LANE || !had ? e.branch : had.branch, live: !!had?.live || e.online });
    else had.live = had.live || e.online;
  }
  return [...by.values()];
}

/** Where the session works, for the status bar: the custom agent, the folder (its git menu) and the branch. */
function Where({ state, sid, invite, send }: { state: SessionState; sid: string; invite: string; send: Send }) {
  const agent = state.options.agent;
  const repo = repoOf(state);
  return (
    <>
      {agent && (
        <span className="stb-item stb-quiet" title={`Custom agent “${agent.name}” (v${agent.version}) by ${agent.ownerName}`}>
          <Icon name={agent.icon as IconName} size={13} /> {agent.name}
        </span>
      )}
      {repo && (
        <>
          <GitMenu state={state} sid={sid} invite={invite} send={send} clickToo>
            <button type="button" className="stb-item stb-repo" title={`${repo.name}: commit, pull request, fork · ${repo.path} · on ${repo.host}'s machine`} aria-label={`${repo.name}: commit, pull request, fork`}>
              <FolderGit2Icon className="size-3.5 shrink-0" />
              <span className="stb-trunc">{repo.name}</span>
            </button>
          </GitMenu>
          <span className="stb-branch">
            <BranchButton sid={sid} invite={invite} send={send} lane={repo.lane} idle={!anyRunning(state)} {...(repo.branch ? { branch: repo.branch } : {})} />
          </span>
        </>
      )}
    </>
  );
}

/** Whether any agent in the session has a run going. */
const anyRunning = (state: SessionState) => state.run.status === "running" || Object.values(state.laneRuns).some((r) => r.status === "running");

function repoOf(state: SessionState): { name: string; branch?: string; path: string; host: string; lane: string } | null {
  const lane = state.engines[MAIN_LANE] ? MAIN_LANE : (Object.keys(state.engines)[0] ?? MAIN_LANE);
  const e = state.engines[lane];
  if (!e?.cwd) return null;
  return { name: (e.cwd.split(/[\\/]/).filter(Boolean).pop() ?? e.cwd).replace(/-[0-9a-f]{8}$/, ""), branch: e.branch, path: e.cwd, host: e.hostName, lane };
}

/** The session's settings, as the second tab of the People panel: one button for the room and how it runs. */
function SettingsBody({ state, send, meter, solo = false }: { state: SessionState; send: Send; meter: { on: boolean; set: (v: boolean) => void }; /** Solo: without what is about other people or Friday's own agent. */ solo?: boolean }) {
  const o = state.options;
  return (
    <div className="settings-body-pop">
      {/* The agent is chosen in the composer, beside the model it runs — the
          place the choice is actually made. A second copy here was a setting
          that duplicated a control rather than adding one. */}
      {/* Who may take the wheel, web search and connections are about other people and Friday's own agent: not Solo's. */}
      {!solo && (
      <>
      <div className="set-block">
        <div className="set-label">Control handoff</div>
        <Segmented
          className="full"
          value={o.controlMode}
          onChange={(v) => send({ type: "settings.update", controlMode: v })}
          options={[
            ["ask", "Ask driver"],
            ["takeover", "Instant takeover"],
          ]}
        />
        <p className="muted small">{o.controlMode === "ask" ? "Requests wait for the driver." : "Drivers take control without asking."}</p>
      </div>
      {/* Friday's own agent searching the web: the hosted Friday's; the coding tools search with their own. */}
      <div className="set-row">
        <div>
          <div className="set-label">Connections</div>
          <div className="muted small">Tools from your connections.</div>
        </div>
        <Switch on={o.mcp} label="Connections" onChange={(v) => send({ type: "settings.update", mcp: v })} />
      </div>
      </>
      )}
      <div className="set-row">
        <div>
          <div className="set-label">Plan first</div>
          <div className="muted small">The agent reads and plans, and waits for your approval before it changes anything.</div>
        </div>
        <Switch on={o.planFirst} label="Plan first" onChange={(v) => send({ type: "settings.update", planFirst: v })} />
      </div>
      {o.planFirst && !solo && (
        <div className="set-row">
          <div>
            <div className="set-label">Team sign-off</div>
            <div className="muted small">Teammates have to say a plan looks good before it can be approved.</div>
          </div>
          <div className="hist-filters" role="radiogroup" aria-label="Sign-offs needed">
            {[0, 1, 2].map((n) => (
              <button key={n} type="button" role="radio" aria-checked={(o.signoff ?? 0) === n} className={`hist-chip ${(o.signoff ?? 0) === n ? "on" : ""}`} onClick={() => send({ type: "settings.update", signoff: n })}>
                {n === 0 ? "Off" : n}
              </button>
            ))}
          </div>
        </div>
      )}
      {!solo && (
        <div className="set-row">
          <div>
            <div className="set-label">Private</div>
            <div className="muted small">Only the people in this session know it exists. It stays off the team's overlap warnings and session list.</div>
          </div>
          <Switch on={o.private ?? (!state.links.editor.enabled && !state.links.viewer.enabled)} label="Private" onChange={(v) => send({ type: "settings.update", private: v })} />
        </div>
      )}
      {/* Which commands editors may approve: Solo has no editors. */}
      {!solo && <ApproveRules state={state} send={send} />}
      <div className="set-row">
        <div>
          <div className="set-label">Run tests after changes</div>
          <div className="muted small">The agent finds the project's tests and runs them before it finishes.</div>
        </div>
        <Switch on={o.autoTest} label="Run tests after changes" onChange={(v) => send({ type: "settings.update", autoTest: v })} />
      </div>
      {/* Security APP-3: a public repository's readers are everyone, and the recording reads the whole session. */}
      <div className="set-row">
        <div>
          <div className="set-label">Recording link in public pull requests</div>
          <div className="muted small">Pull requests to private repositories link the recording. For a public one, anyone could read this whole session. The owner's choice.</div>
        </div>
        <Switch on={!!o.prReplay} label="Recording link in public pull requests" onChange={(v) => send({ type: "settings.update", prReplay: v })} />
      </div>
      {/* It shared the row above, an unlabeled second switch. Friday's own agent does the reading, so on Solo only an own model does. */}
      {(!solo || ownModel(o.model)) && (
        <div className="set-row">
          <div>
            <div className="set-label">Second review</div>
            <div className="muted small">Another agent reads each change for real problems before you do, and the agent fixes what it finds.</div>
          </div>
          <Switch on={o.review} label="A second agent reviews each change" onChange={(v) => send({ type: "settings.update", review: v })} />
        </div>
      )}
      <div className="set-row">
        <div>
          <div className="set-label">Show time and usage</div>
          <div className="muted small">Time and tokens for the current run, in the header.</div>
        </div>
        <Switch on={meter.on} label="Show time and usage" onChange={meter.set} />
      </div>
    </div>
  );
}

/**
 * Which kinds of command editors may approve when an agent asks first.
 *
 * Off for everything to begin with: the driver and an owner answer, as they always have. Turning a kind on lets any editor
 * say yes or no to commands of that kind only; what a command is gets decided on the server, and a line that chains several is
 * only approvable if every part is. The risky kinds are there to choose and marked, because "editors can approve anything" is
 * a thing an owner may genuinely want and should have to do on purpose.
 */
function ApproveRules({ state, send }: { state: SessionState; send: Send }) {
  const on = new Set(state.options.approve?.editor ?? []);
  const [open, setOpen] = useState(on.size > 0);
  const toggle = (c: CommandClass) => {
    const next = new Set(on);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    void send({ type: "settings.update", approve: { editor: [...next] } });
  };
  return (
    <div className="set-row set-col">
      <button type="button" className="set-fold" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <div>
          <div className="set-label">What editors can approve</div>
          <div className="muted small">{on.size ? `${on.size} kind${on.size === 1 ? "" : "s"} of command` : "Only the driver and owners answer when an agent asks first."}</div>
        </div>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
      </button>
      {open && (
        <ul className="approve-list">
          {COMMAND_CLASSES.map((c) => (
            <li key={c}>
              <label className={CLASS_LABEL[c].careful ? "careful" : ""}>
                <input type="checkbox" checked={on.has(c)} onChange={() => toggle(c)} />
                <span className="approve-text">
                  <span className="approve-name">{CLASS_LABEL[c].label}</span>
                  <span className="approve-hint">{CLASS_LABEL[c].hint}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A session that is only yours, and the way out of that.
 *
 * Private means the invite links are off and nobody else has joined. One press
 * turns both on, and the People button then has a link to copy: the tokens
 * only reach this page once the server has switched them on.
 */

/** The key that opens each of the three, after ⌘ or Ctrl. */
const PANEL_KEYS: Record<string, Tab> = { "1": "overview", "2": "files", "3": "terminal", "4": "preview" };
const MOD = typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent) ? "⌘" : "Ctrl+";

/** The panels, in the order they answer the questions people ask of a run. */
/** On Solo, the panels that get a tab of their own in the header; the rest are under More. */
const MAIN_PANELS: Tab[] = ["overview", "files", "terminal", "preview"];

const VIEWS: { tab: Tab; icon: IconName; label: string }[] = [
  { tab: "agents", icon: "agent", label: "Agents" },
  { tab: "overview", icon: "list", label: "Tasks" },
  { tab: "tree", icon: "folderOpen", label: "Tree" },
  { tab: "files", icon: "file", label: "Diff" },
  { tab: "git", icon: "gitBranch", label: "Git" },
  { tab: "terminal", icon: "terminalSquare", label: "Terminal" },
  { tab: "preview", icon: "play", label: "Preview" },
  { tab: "usage", icon: "usage", label: "Usage" },
  { tab: "rules", icon: "book", label: "Rules" },
];

// ── control strip ───────────────────────────────────────────────────

function ControlStrip({
  state,
  me,
  agents,
  identity,
  presence,
  send,
  onConnect,
  onRace,
  events,
  replayAt,
  onReplay,
  onExitReplay,
}: {
  state: SessionState;
  me: Member;
  agents: AgentView[];
  identity: Identity;
  presence: PresenceMember[];
  send: Send;
  onConnect: (tool?: EngineTool) => void;
  onRace: () => void;
  /** The whole log, which is what the history menu is a list of. */
  events: SessionEvent[];
  /** Where the session is wound back to, or null for now. */
  replayAt: number | null;
  onReplay: (seq: number) => void;
  onExitReplay: () => void;
}) {
  const driving = state.driver?.id === me.id;
  const canDrive = can(state, me.id, "control");
  const takeover = state.options.controlMode === "takeover";
  const requested = state.pendingRequests.some((r) => r.id === me.id && r.lane === MAIN_LANE);
  const mayStop = driving || me.role === "owner";
  const policy = state.options.policy;
  const others = presence.filter((p) => p.online && p.id !== me.id && (p.role === "owner" || policy[p.role].control));

  return (
    <div className="control-strip in-header">
      {/* Your own role was a badge here, shouting OWNER at the one person who
          already knows. It is still on your card, where it is an answer to a
          question somebody asked. */}

      <div className="cs-group">
        {/* Connecting a coding agent lives in the Agents card, which is where
            the agents are. It was here as well, which is one action in two
            places and a row wider than it needs to be. */}
        {/* History is a panel now, opened from the three dots. While you are in
            the past this is the way out, wherever the panel is. */}
        {replayAt !== null && (
          <button type="button" className="lanes-pill is-replaying" onClick={onExitReplay}>
            <Icon name="clock" size={13} /> Back to now
          </button>
        )}
      </div>

      <div className="cs-group right">
        {/* Taking the wheel, asking for it and letting it go live in the message box, beside the agent they are about:
            there is one wheel per agent, and the header cannot say which. What is left here is only the note for
            somebody who cannot steer at all. */}
        {!canDrive && (
          <span
            className="watch-chip"
            title={can(state, me.id, "suggest") ? "You can't steer the agent, but you can suggest a redirect to whoever does." : "Your role can't steer the agent. An owner can make you an editor."}
          >
            <Icon name="eye" size={13} />
            {can(state, me.id, "suggest") ? "Watching · you can suggest" : "Watching"}
          </span>
        )}
      </div>
    </div>
  );
}

// ── read-only summary ───────────────────────────────────────────────

/**
 * What someone opening a read-only link needs first: where this stands, in a line.
 *
 * Built from the log, so it is right for a stakeholder who arrives cold and
 * never has to scroll a run to learn whether it finished.
 */
function ViewerCard({ state, events, me, send, solo, notify }: { state: SessionState; events: SessionEvent[]; me: Member; send: Send; solo: boolean; notify: (m: string) => void }) {
  // Asking to edit, rather than only being told on hover that an owner could make you one (Arun, 2026-10-24: UX gaps). Not on
  // Solo, where only the owner works whatever anyone's role.
  const asked = (state.roleRequests ?? []).some((r) => r.id === me.id);
  const ask = async () => {
    const r = await send({ type: "role.request" });
    notify(r.ok ? "Asked. An owner sees it when they're here." : (r.error ?? "Couldn't ask."));
  };
  const files = Object.values(state.diffs).reduce((n, d) => n + d.files.length, 0);
  const last = [...events].reverse().find((e) => e.body.type === "agent.message" && !e.body.toolCalls.length && e.body.text.trim());
  const said = last && last.body.type === "agent.message" ? (last.body.text.replace(/[#*_`>]/g, " ").split(/(?<=[.!?])\s|\n/).find((l) => l.trim()) ?? "").trim().slice(0, 220) : "";
  const status = state.run.status === "running" ? "Working now" : state.run.status === "paused" ? "Paused" : state.run.status === "waiting_for_human" ? "Waiting on a person" : state.run.status === "error" ? "Stopped" : "Idle";
  const [closed, setClosed] = useState(false);
  if (closed) return null;
  return (
    <div className="viewer-card">
      <span className="viewer-badge">
        <Icon name="eye" size={13} /> Read-only
      </span>
      <div className="viewer-line">
        <b>{status}</b>
        {files > 0 ? ` · ${files} file${files === 1 ? "" : "s"} changed` : ""}
        {said ? <span className="viewer-said">{` · “${said}”`}</span> : null}
      </div>
      {!solo && (
        <button type="button" className="btn small viewer-ask" disabled={asked} onClick={() => void ask()}>
          {asked ? "Asked to edit" : "Ask to edit"}
        </button>
      )}
      <button type="button" className="icon-btn tiny viewer-close" aria-label="Close the summary" title="Close" onClick={() => setClosed(true)}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

// ── banners ─────────────────────────────────────────────────────────

function Banners({ state, me, send }: { state: SessionState; me: Member; send: Send }) {
  // Asks for the agents you drive, each answered on its own agent.
  const asks = requestsTo(state, me.id);
  // Viewers asking to edit, for the owners to answer.
  const edits = me.role === "owner" ? (state.roleRequests ?? []) : [];
  // Questions to somebody else, so everyone can see who the agents are waiting on.
  const theirs = Object.values(state.openQuestions).filter((q) => q.to !== me.id);
  if (!theirs.length && !asks.length && !edits.length) return null;

  return (
    <div className="banners">
      {theirs.map((q) => (
        <div key={q.lane} className="banner question">
          <div className="banner-main">
            <strong>{`${agentNameFor(state, q.lane)} asked ${q.toName}`}</strong>
            <p>{q.question}</p>
          </div>
        </div>
      ))}
      {asks.map((r) => (
        <div key={`${r.id}|${r.lane}`} className="banner request">
          <Avatar name={r.name} id={r.id} size={26} />
          <div className="banner-main">
            <strong>{r.name}</strong> is asking for control{r.lane === MAIN_LANE ? "" : ` of ${agentNameFor(state, r.lane)}`}.
          </div>
          <button className="btn ghost small" onClick={() => send({ type: "control.deny", to: r.id, lane: r.lane })}>
            Deny
          </button>
          <button className="btn primary small" onClick={() => send({ type: "control.yield", to: r.id, lane: r.lane })}>
            Hand over
          </button>
        </div>
      ))}
      {edits.map((r) => (
        <div key={`edit|${r.id}`} className="banner request">
          <Avatar name={r.name} id={r.id} size={26} />
          <div className="banner-main">
            <strong>{r.name}</strong> is watching and asks to edit.
          </div>
          <button className="btn ghost small" onClick={() => send({ type: "role.decline", userId: r.id })}>
            Not now
          </button>
          <button className="btn primary small" onClick={() => send({ type: "member.role", userId: r.id, role: "editor" })}>
            Make editor
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * What a teammate left when they handed the session over (People.tsx, HandOver): their note first, and where the session
 * stood, written as they handed it. Shown to whoever it was handed to until they say they have read it.
 */
function HandoverBanner({ state, me }: { state: SessionState; me: Member }) {
  const h = state.handover;
  const key = h ? `friday:handover-read:${state.id}:${h.seq}` : "";
  const [read, setRead] = useState(() => {
    try {
      return !!key && !!localStorage.getItem(key);
    } catch {
      return false;
    }
  });
  if (!h || h.to !== me.id || read) return null;
  const done = () => {
    try {
      localStorage.setItem(key, "1");
    } catch {
      /* read for now, anyway */
    }
    setRead(true);
  };
  return (
    <div className="banners">
      <div className="banner handover" role="status">
        <Icon name="hand" size={16} />
        <div className="banner-main">
          <strong>{h.from.name} handed this to you</strong>
          {h.note && <p>{h.note}</p>}
          {!h.taken && <p className="muted small">The wheel is yours as soon as {state.driver && state.driver.id !== h.from.id ? `${state.driver.name.split(/\s+/)[0]} lets go of it` : "you're here"}.</p>}
          {h.brief && (
            <details className="handover-brief">
              <summary>Where it stood when it was handed over</summary>
              <pre>{h.brief}</pre>
            </details>
          )}
        </div>
        <button type="button" className="btn small primary" onClick={done}>
          Got it
        </button>
      </div>
    </div>
  );
}


// ── document panel ──────────────────────────────────────────────────

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);


/**
 * The agent rail over a split chat: every agent's state, its unread count and what waits on you, as the single chat's rail
 * shows them (Activity.tsx), with the columns' agents marked. Choosing one that isn't showing puts it in a column (beside
 * the one in use while there is room, in its place after that); dragging one onto a column does the same there.
 */
function SplitRail({ sid, state, events, me, shown, active, room, head = false }: { sid: string; state: SessionState; events: SessionEvent[]; me: string; shown: string[]; active: string; room: number; /** In the header, as the single chat's tabs are. */ head?: boolean }) {
  const agents = useAgents();
  const seen = useSeen(sid);
  const opened = openedAt(sid, events.at(-1)?.seq ?? 0);
  const unread = useMemo(() => unreadByLane(events, seen, opened, me), [events, seen, opened, me]);
  const needs = agents.filter((a) => a.needsYou);
  const everyone = agents.map((a) => a.lane);
  return (
    <div className={`feed-toolbar split-rail${head ? " in-head" : ""}`}>
      <div className="lane-tabs" role="tablist" aria-label="Agents">
        {agents.map((a, i) => {
          const look = agentLook(state, a.lane, 13);
          const on = shown.includes(a.lane);
          const behind = on ? 0 : (unread[a.lane] ?? 0);
          return (
            <button
              key={a.lane}
              type="button"
              role="tab"
              aria-selected={a.lane === active}
              className={`lane-tab${a.lane === active ? " on" : ""}${on ? " shown" : ""}${a.needsYou ? " needs" : ""}`}
              // Its state's ring, as the single chat's tabs have it (style.css .feed-toolbar .lane-tab[data-state]).
              data-state={tabState(a.status, a.needsYou)}
              style={{ "--tint": look.tint } as React.CSSProperties}
              data-tip={`${a.line}${i < 9 ? ` · ${agentKey(i + 1)}` : ""}${on ? "" : " · drag onto a column"}`}
              aria-label={`${laneLabel(state, a.lane)}: ${a.line}`}
              draggable={!on}
              onDragStart={(e) => {
                e.dataTransfer.setData(AGENT_DRAG, a.lane);
                e.dataTransfer.effectAllowed = "copy";
                dispatchEvent(new CustomEvent("friday:agent-drag", { detail: { lane: a.lane } }));
              }}
              onDragEnd={() => dispatchEvent(new CustomEvent("friday:agent-drag", { detail: { lane: null } }))}
              onClick={() => (on ? focusAgent(sid, a.lane) : setColumns(sid, dropAgent(shown, { lane: a.lane, current: active, everyone, max: room, at: shown.indexOf(active) }), a.lane))}
            >
              <span className="lane-tab-mark">{look.mark}</span>
              <span className="lane-tab-name">{laneLabel(state, a.lane)}</span>
              {!head && <AgentState status={a.status} needsYou={a.needsYou} />}
              {behind > 0 && <span className="lane-tab-unread" aria-label={`${behind} new`}>{behind > 9 ? "9+" : behind}</span>}
            </button>
          );
        })}
      </div>
      {needs.length > 0 && (
        <button type="button" className="needs-pill" data-tip={`${needs.map((a) => a.name).join(", ")} · ${nextKey()} goes to the next`} onClick={() => jumpToNeeds(sid, agents)}>
          <AgentState status="waiting" needsYou />
          <span>{needs.length === 1 ? `${needs[0]!.name} needs you` : `${needs.length} need you`}</span>
          <kbd>{nextKey()}</kbd>
        </button>
      )}
    </div>
  );
}
