import "./awake.js";
import { leaving, leavingByHistory } from "./leave-guard.js";
import { AgentImport } from "./AgentImport.js";
import { askPage } from "./intent.js";
import { Tooltips } from "./Tooltips.js";
import { TextMenu } from "./TextMenu.js";
import { BuildWatch } from "./BuildWatch.js";
import type { Role } from "../types.js";
import { lazy, Suspense, type ComponentProps, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isNarrow } from "./narrow.js";
import { readTabNow, setTeamTab, TeamHome, TeammateForm, useTeamNow, useTeamTab } from "./Teammates.js";
import { choosePlace, usePlaceFollows, usePlaceLeaves, useWorkSessions } from "./WorkMode.js";
import { useWorkflowNotices } from "./team-workflow-view.js";
import type { AgentView, PersonListing } from "../agents.js";
import type { CollectionView, SkillView } from "../skills.js";
import type { McpPublic } from "../mcp-types.js";
import { early, openEarlySocket } from "./early.js";
import { socketUrl } from "./useSession.js";
import { refreshToolLimits } from "./toolLimits.js";
import { api } from "./api.js";
import { Code } from "./Code.js";
/** A prompt link that arrived signed out, kept for this tab until sign-in brings them back (App). */
const PROMPT_LINK_KEY = "friday.prompt-link";
import type { EngineTool } from "../types.js";
import { parseResumeLink, type ResumeLink } from "./resume-link.js";
// The pages that aren't the first screen are loaded when opened, not before the app can start: a third of the startup
// script was pages nobody had asked for yet. They're fetched quietly once the app is idle (see `warm` below), so opening
// one is still instant.
const pages = {
  // The session screen too, with the feed, the markdown renderer and the animations only it draws: over half the startup
  // script on Home and Settings. It is warmed first, and a link straight to a session asks for it as the app starts.
  session: () => import("./SessionView.js").then((m) => (sessionCode = m)),
  automations: () => import("./Automations.js"),
  board: () => import("./Board.js"),
  deepdive: () => import("./DeepDive.js"),
  mcp: () => import("./McpServers.js"),
  skills: () => import("./Skills.js"),
  review: () => import("./CodeReview.js"),
  needs: () => import("./NeedsYou.js"),
  usage: () => import("./UsagePage.js"),
  settings: () => import("./Settings.js"),
};
/** A page's code by its rail name (Agents is the studio), asked for ahead of opening it: by the warm-up below, and as the pointer or focus reaches its button in the rail. */
const warmPage = (view: string) => void pages[(view === "agents" ? "studio" : view) as keyof typeof pages]?.().catch(() => {});
let sessionCode: typeof import("./SessionView.js") | undefined;
const LazySessionView = lazy(() => pages.session().then((m) => ({ default: m.SessionView })));
// React.lazy suspends on its first render even when the code has long arrived, which put the skeleton up for a few hundred
// milliseconds on the first session opened after the warm-up. Once the code is here, the screen is drawn straight from it.
function SessionView(p: ComponentProps<typeof LazySessionView>) {
  const Screen = sessionCode?.SessionView ?? LazySessionView;
  return <Screen {...p} />;
}
// Only for someone opening a recording link, who has no account and needs nothing else here.
const Board = lazy(() => pages.board().then((m) => ({ default: m.Board })));
const DeepDivePage = lazy(() => pages.deepdive().then((m) => ({ default: m.DeepDivePage })));
const McpServersPage = lazy(() => pages.mcp().then((m) => ({ default: m.McpServersPage })));
const SkillsPage = lazy(() => pages.skills().then((m) => ({ default: m.SkillsPage })));
// Search opens on a press, so its code comes then: the room it left in the first load is what Deep Dive's page took (2026-11-12).
// Code: real VS Code beside the agent (ide/VsCodeView.tsx), in its own chunk, so the first load doesn't carry it.
const CodeSurface = lazy(() => import("./ide/VsCodeView.js").then((m) => ({ default: m.CodeSurface })));
const IdeRootPicker = lazy(() => import("./ide/RootPicker.js").then((m) => ({ default: m.RootPicker })));
const SearchModal = lazy(() => import("./SearchModal.js").then((m) => ({ default: m.SearchModal })));
const AutomationsPage = lazy(() => pages.automations().then((m) => ({ default: m.AutomationsPage })));
const TeamWorkflowsPage = lazy(() => import("./TeamWorkflows.js").then((m) => ({ default: m.TeamWorkflowsPage })));
const CodeReview = lazy(() => pages.review().then((m) => ({ default: m.CodeReview })));
const NeedsYouPage = lazy(() => pages.needs().then((m) => ({ default: m.NeedsYou })));
import { WindowNav } from "./WindowNav.js";
import { folderOf, foldersOf, getMode, ideKey, IdeChatContext, restoredIdeRoot, setIdeRoot, setMode as setViewMode, swapMode, toggleMode, useIdeRoot, useMode, wantReview, type IdeChat } from "./ide/mode.js";
import { addCodeChat, codeChatFor, dropLinkedChat, isCodeChat, linkCodeChat, loadCodeChats, showCodeChat, updateCodeChat } from "./ide/code-chats.js";
import { toolName } from "../ready.js";
import { askToShowDiff } from "./focusDiff.js";
import { AgentForm } from "./AgentDialogs.js";
// Settings' sections by name are all the app's start needs of Settings; the page loads when opened (or warmed, as the others).
import { settingsSection } from "./settings-sections.js";
const SettingsPage = lazy(() => pages.settings().then((m) => ({ default: m.SettingsPage })));
import { chooseTheme } from "./prefs.js";
import { applyTheme, readTheme } from "./theme.js";
const UsagePage = lazy(() => pages.usage().then((m) => ({ default: m.UsagePage })));
import { ALL, useFocusedAgent } from "./agentFocus.js";
import { isLocal, ownModel, planLimits, planNow } from "./edition.js";
import { listYield } from "./list-yield.js";
import type { SkillTemplate } from "../skill-catalog.js";
import type { WorkspaceUsage } from "./workspace-types.js";
import { Icon } from "./icons.js";
import { Setup } from "./Setup.js";
import { WhatsNew } from "./WhatsNew.js";
import { KeepGoingHost } from "./crew-carry-open.js";
import { QuickPrompt } from "./QuickPrompt.js";
import { quickText, sendQuickTo, startQuick } from "./quick-send.js";
import { ShortcutList } from "./Shortcuts.js";
import { Palette, baseActions, paletteOrder, type Action } from "./Palette.js";
import type { codeActions as CodeActions } from "./ide/palette-page.js";
import { ideIsUp } from "./ide/ide-up.js";
import type { Plan } from "../plan-types.js";
import { Sidebar, ThreadRing } from "./Sidebar.js";
import { PrWatch, usePrs } from "./prWatch.js";
import {
  loadLayout,
  loadProjects,
  loadRecents,
  saveLayout,
  saveProjects,
  saveRecents,
  type Identity,
  type Layout,
  type Project,
  type RecentSession,
} from "./storage.js";
import { inBand, isTyping, onBand, PageSkeleton, SessionSkeleton, useConfirm, useDismiss, type MenuItem } from "./ui.js";
import { WaitingOnYou, askToNotify, useAttention } from "./Attention.js";
import { DailyBriefHost } from "./DailyBrief.js";
import { clearUnread, markUnread, useUnread, workingChanges } from "./unread.js";
import { DoneToasts } from "./DoneToasts.js";
import { NEW_THREAD, ThreadsCtx } from "./threads-data.js";

/**
 * The desktop app linking this computer to the hosted Friday, and why signing out of it didn't work (desktop-link.ts). The local
 * edition's runner is part of the app: nothing to link, nothing to sign out of.
 */
const desktopLink: { use: (identity: Identity) => void; useSignOutError: () => string } = { use: () => {}, useSignOutError: () => "" };

type Route =
  /** `resume`: a `?resume=<tool>:<id>&cwd=<path>` link (resume-link.ts), whose session the new-session page picks. */
  | { kind: "home"; projectId?: string; agentId?: string; resume?: ResumeLink; prompt?: { prompt: string; repo?: string; tool?: EngineTool } }
  | { kind: "session"; sid: string; invite: string }
  /** The quick prompt's floating window (desktop/quick.ts): the box alone. */
  | { kind: "quick" }
  | { kind: "connections" }
  | { kind: "agents" }
  | { kind: "automations" }
  | { kind: "people" }
  | { kind: "library" }
  | { kind: "board" }
  /** Deep Dive: the repos explained, and questions about their code (DeepDive.tsx). */
  | { kind: "deepdive" }
  /** MCP servers set up once for every coding tool on this computer (McpServers.tsx, runner/connections.ts). */
  | { kind: "mcp" }
  /** Skills every coding tool and crew mate can use: the person's own, each tool's, and GitHub's (Skills.tsx, runner/skill-library.ts). */
  | { kind: "skills" }
  | { kind: "review" }
  /** Everything waiting on you, ranked, with Friday's suggested answers (NeedsYou.tsx). */
  | { kind: "needs" }
  | { kind: "settings"; section: string }
  | { kind: "usage" }
  /** A new teammate for the Crew, on a page of its own rather than a dialog (Teammates.tsx TeammateDialog, `page`). */
  | { kind: "new-teammate" };

function readRoute(): Route {
  return parseRoute(location.search);
}

/** The page an app address (its query) names. */
function parseRoute(search: string): Route {
  const p = new URLSearchParams(search);
  // No Connections page any more (Arun, 2026-10-22: "the coding tools already have the mcps connected on their own coding
  // tools"): an old link to it opens the start page.
  if (p.get("view") === "connections") return { kind: "home" };
  // Saved agents, People and the Library are the paid edition's pages: in the open-source edition an old link to one opens what
  // stands in for it there, not a blank page (2026-10-27 audit).
  if (p.get("view") === "agents") return isLocal() ? { kind: "automations" } : { kind: "agents" };
  if (p.get("view") === "automations") return { kind: "automations" };
  if (p.get("view") === "people") return isLocal() ? { kind: "home" } : { kind: "people" };
  if (p.get("view") === "library") return isLocal() ? { kind: "home" } : { kind: "library" };
  if (p.get("view") === "board") return { kind: "board" };
  if (p.get("view") === "deepdive") return { kind: "deepdive" };
  if (p.get("view") === "mcp") return { kind: "mcp" };
  if (p.get("view") === "skills") return { kind: "skills" };
  if (p.get("view") === "review") return { kind: "review" };
  if (p.get("view") === "needs") return { kind: "needs" };
  if (p.get("view") === "settings") return { kind: "settings", section: settingsSection(p.get("section")) };
  if (p.get("view") === "usage") return { kind: "usage" };
  if (p.get("view") === "new-teammate") return { kind: "new-teammate" };
  if (p.get("view") === "quick") return { kind: "quick" };
  const sid = p.get("session");
  const invite = p.get("invite");
  if (sid && invite) return { kind: "session", sid, invite };
  const resume = parseResumeLink(p);
  let prompt: { prompt: string; repo?: string; tool?: EngineTool } | null = null;
  return { kind: "home", projectId: p.get("project") ?? undefined, agentId: p.get("agent") ?? undefined, ...(resume ? { resume } : {}), ...(prompt ? { prompt } : {}) };
}

// A link straight to a session asks for that screen's code now, alongside the sign-in check rather than after it.
const firstRoute = readRoute();
if (firstRoute.kind === "session") {
  // Its socket too, kept until the screen takes it (early.ts).
  openEarlySocket(socketUrl(firstRoute.sid, firstRoute.invite));
  warmPage("session");
  // And the chunks it imports, named by the page (app.ts shellHtml), asked for beside it rather than after it has arrived.
  for (const href of (window as { __sessionCode?: string[] }).__sessionCode ?? []) {
    const l = document.createElement("link");
    l.rel = "modulepreload";
    l.href = href;
    document.head.appendChild(l);
  }
}

function routeUrl(r: Route): string {
  if (r.kind === "connections") return "/?view=connections";
  if (r.kind === "agents") return "/?view=agents";
  if (r.kind === "automations") return "/?view=automations";
  if (r.kind === "people") return "/?view=people";
  if (r.kind === "library") return "/?view=library";
  if (r.kind === "board") return "/?view=board";
  // The repo open in it is the page's own to keep in the address (DeepDive.tsx), so a reload lands on it.
  if (r.kind === "deepdive") return "/?view=deepdive";
  if (r.kind === "mcp") return "/?view=mcp";
  if (r.kind === "skills") return "/?view=skills";
  if (r.kind === "review") return "/?view=review";
  if (r.kind === "needs") return "/?view=needs";
  if (r.kind === "settings") return `/?view=settings&section=${encodeURIComponent(r.section)}`;
  if (r.kind === "usage") return "/?view=usage";
  if (r.kind === "new-teammate") return "/?view=new-teammate";
  if (r.kind === "quick") return "/?view=quick";
  if (r.kind === "session") return `/?session=${encodeURIComponent(r.sid)}&invite=${encodeURIComponent(r.invite)}`;
  const q = new URLSearchParams();
  if (r.projectId) q.set("project", r.projectId);
  if (r.agentId) q.set("agent", r.agentId);
  return q.size ? `/?${q}` : "/";
}

/** A desktop-width window (wider than the narrow layout, where the sidebar is a sheet), kept current as the window is resized. */
const WIDE = "(min-width: 1001px)";
const wideSub = (on: () => void) => {
  const m = matchMedia(WIDE);
  m.addEventListener("change", on);
  return () => m.removeEventListener("change", on);
};
const wideNow = () => matchMedia(WIDE).matches;

export function App() {
  // Who you are is whatever /api/me says. Until it answers, nothing is loaded:
  // every call needs the cookie, and a signed-out browser has none.
  const [identity, setIdentity] = useState<Identity>({ id: "", name: "" });
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [email, setEmail] = useState<string | undefined>(undefined);
  /** The workspace in play: its plan decides which models and limits apply. */
  const [workspace, setWorkspace] = useState<WorkspaceUsage | null>(null);
  const [route, setRoute] = useState<Route>(readRoute);
  // Agents' list never holds Code's chats (ide/code-chats.ts): they are Code's own, kept apart.
  const [recents, setRecents] = useState<RecentSession[]>(() => loadRecents().filter((r) => !isCodeChat(r.sid)));
  // Setting this computer up again (Settings › About) happens on the start page, where the setup lives: from anywhere else it
  // goes there first, and asks again once it has (2026-10-27 audit: the button did nothing from Settings).
  useEffect(() => {
    const setup = (e: Event) => {
      if ((e as CustomEvent).detail === "again" || parseRoute(location.search).kind === "home") return;
      history.pushState(null, "", routeUrl({ kind: "home" }));
      setRoute({ kind: "home" });
      setTimeout(() => dispatchEvent(new CustomEvent("friday:setup", { detail: "again" })), 300);
    };
    addEventListener("friday:setup", setup);
    return () => removeEventListener("friday:setup", setup);
  }, []);
  // A file named anywhere in Agents opens in the IDE on Shift-click (ide/file-links.ts).
  // Loaded after the first paint: nobody has pressed a file yet.
  useEffect(() => {
    let undo = () => {};
    let live = true;
    void import("./ide/file-links.js").then((m) => live && (undo = m.installFileLinks()));
    return () => ((live = false), undo());
  }, []);
  // Another window or tab of Friday saved the list (a rename, a snooze, a session settled): take its copy, rather than writing this
  // window's older one over it at the next change (2026-10-27 audit: renames and snoozes were lost between two windows).
  useEffect(() => {
    const heard = (e: StorageEvent) => e.key === "mpa.sessions" && setRecents(loadRecents().filter((r) => !isCodeChat(r.sid)));
    addEventListener("storage", heard);
    return () => removeEventListener("storage", heard);
  }, []);
  // Sessions you are in on the server that this browser has never opened: another machine's, or one a schedule started.
  type Mine = { sessions: { sid: string; title: string; role: Role; invite: string; at: number; later?: boolean }[] };
  const reloadMine = useCallback(
    (first = false) =>
      // The page asked already, while the app loaded; if that came back empty-handed (it asked before knowing who you were), ask again.
      ((first && early<Mine>("mine")) || Promise.resolve(null))
        .then((r) => r ?? api<Mine>(identity, "/api/sessions/mine"))
        .then((r) =>
          setRecents((prev) => {
            const known = new Set(prev.map((x) => x.sid));
            const add = r.sessions.filter((s) => !known.has(s.sid) && !isCodeChat(s.sid) && !s.later).map((s) => ({ sid: s.sid, title: s.title, invite: s.invite, role: s.role, openedAt: s.at }));
            // A session renamed somewhere else (a teammate, another computer) takes its new title here too, over a sidebar name.
            const title = new Map(r.sessions.map((s) => [s.sid, s.title]));
            let renamed = false;
            const kept = prev.map((x) => {
              const t = title.get(x.sid);
              if (!t || t === x.title) return x;
              renamed = true;
              return { ...x, title: t, alias: undefined };
            });
            if (!add.length && !renamed) return prev;
            const next = add.length ? [...kept, ...add].sort((a, b) => b.openedAt - a.openedAt) : kept;
            saveRecents(next);
            return next;
          }),
        )
        .catch(() => {}),
    [identity.id], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => {
    if (!authed || !identity.id) return;
    void reloadMine(true);
  }, [authed, identity.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // In the Mac app the window's toolbar has the button that folds the chat list, so the Chat button only goes to chats.
  const [mac, setMac] = useState(false);
  const [projects, setProjects] = useState<Project[]>(loadProjects);
  const [layout, setLayoutState] = useState<Layout>(loadLayout);
  /** A window narrow enough that the list floats over the page (narrow.ts), kept as the window is resized. */
  const [narrowNow, setNarrowNow] = useState(() => isNarrow(innerWidth));
  useEffect(() => {
    const on = () => setNarrowNow(isNarrow(innerWidth));
    addEventListener("resize", on);
    return () => removeEventListener("resize", on);
  }, []);
  const [connections, setConnections] = useState<McpPublic[]>([]);
  // Where you are the thing that is missing, across every session you know of.
  // On Solo the sessions list says what each one is doing (which tool, and what it is at), not the last thing you typed.
  const attention = useAttention(identity, recents, planLimits(planNow(workspace)).fridayAgent === "none", true);
  const unreadAll = useUnread();
  // Asked the first time there is something worth being told about, rather
  // than on launch: a permission prompt before the product has done anything
  // is a prompt people refuse on principle.
  useEffect(() => {
    if (attention.items.length) askToNotify();
  }, [attention.items.length]);
  // A session's place in the list is when something last happened in it (its agents starting or finishing), not when it was last
  // looked at; and one that finished while you were elsewhere is marked until you open it (unread.ts). Opening a session moved it
  // to the top, so the list followed what you read (Arun, 2026-10-28: "iron everything and ensure we are good… any logic errors").
  const wasWorking = useRef<Set<string> | null>(null);
  const workingKey = [...attention.working.keys()].sort().join(",");
  useEffect(() => {
    const is = new Set(attention.working.keys());
    const was = wasWorking.current;
    wasWorking.current = is;
    if (!was) return;
    const { finished, started } = workingChanges(was, is);
    const here = route.kind === "session" ? route.sid : "";
    markUnread(finished.filter((sid) => sid !== here && !isCodeChat(sid)));
    const moved = new Set([...finished, ...started]);
    if (!moved.size) return;
    const at = Date.now();
    setRecents((prev) => {
      if (!prev.some((r) => moved.has(r.sid))) return prev;
      const next = prev.map((r) => (moved.has(r.sid) ? { ...r, openedAt: at } : r));
      saveRecents(next);
      return next;
    });
  }, [workingKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [collections, setCollections] = useState<CollectionView[]>([]);
  /** What a skill picked on the Skills page hands to the next new session. */
  const [preset, setPreset] = useState<{ brief?: string; grants?: SkillTemplate["grants"]; shepherd?: boolean; repo?: string; tool?: EngineTool; folder?: string } | null>(null);
  // A prompt link (prompt-link.ts): its task goes in the box, its repo and tool with it, and the address is tidied so a reload
  // doesn't fill the box again over what was typed since.
  // Signed out, the link waits: kept for this tab through the sign-in round trip (which comes back to a bare address), and the
  // address is left as it is so the sign-in page can send them back to it.
  useEffect(() => {
    if (authed !== true) {
      if (authed === false && route.kind === "home" && route.prompt) {
        try {
          sessionStorage.setItem(PROMPT_LINK_KEY, location.search);
        } catch {}
      }
      return;
    }
    let link = route.kind === "home" ? route.prompt : undefined;
    if (!link) {
      try {
        const kept = sessionStorage.getItem(PROMPT_LINK_KEY);
        if (kept) {
          sessionStorage.removeItem(PROMPT_LINK_KEY);
        }
      } catch {}
    }
    if (!link || route.kind !== "home") return;
    const { prompt, repo, tool } = link;
    setPreset({ brief: prompt, ...(repo ? { repo } : {}), ...(tool ? { tool } : {}) });
    const tidy: Route = { kind: "home", ...(route.projectId ? { projectId: route.projectId } : {}), ...(route.agentId ? { agentId: route.agentId } : {}) };
    history.replaceState(null, "", routeUrl(tidy));
    setRoute(tidy);
  }, [route, authed]);
  // Pull requests waiting on this person's review, kept current by the watch below, for the mark on Code Review's button.
  const { prs: reviewPrs } = usePrs();
  const [shortcuts, setShortcuts] = useState(false);
  const [palette, setPalette] = useState(false);
  const [search, setSearch] = useState(false);
  /**
   * The People list is your contacts, not the workspace directory: both people
   * agreed to be in it. `addable` is who is left to ask.
   */
  const [people, setPeople] = useState<PersonListing[]>([]);
  const [sessionInvites, setSessionInvites] = useState<Record<string, string> | null>(null);
  // In the desktop app, this computer links itself to the Friday it shows.
  desktopLink.use(identity);
  // Signing out of the desktop app lets this computer go first; when it can't, you stay signed in and this says why.
  const signOutError = desktopLink.useSignOutError();
  // What was just done before a reload (a team deleted), said once where it landed.
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(t);
  }, [notice]);
  // A line any part of the app can say here, in place of the browser's own alert, which froze the page until answered (Arun,
  // 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL"; a fork that couldn't be made raised one).
  useEffect(() => {
    const on = (e: Event) => {
      const text = String((e as CustomEvent<string>).detail ?? "");
      if (!text) return;
      setNotice("");
      setTimeout(() => setNotice(text), 0);
    };
    addEventListener("friday:notice", on);
    return () => removeEventListener("friday:notice", on);
  }, []);

  /** The list as it was saved, while a narrow window has it folded for now (below); null once the person chooses. */
  const keptOpen = useRef<boolean | null>(null);
  const setLayout = useCallback((patch: Partial<Layout>) => {
    setLayoutState((l) => {
      // Opening or closing the floating list in a narrow window is for now: the wide window keeps the list as it was left there
      // (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL"; closing it at 1000px folded it at 1500 too).
      if ("sidebarCollapsed" in patch) {
        if (!isNarrow(innerWidth)) keptOpen.current = null;
        else if (keptOpen.current === null) keptOpen.current = l.sidebarCollapsed;
      }
      const next = { ...l, ...patch };
      saveLayout(keptOpen.current === null ? next : { ...next, sidebarCollapsed: keptOpen.current });
      return next;
    });
  }, []);
  // A narrow or zoomed window opens on the page, with the chat list folded: open, it floats over everything and the
  // page behind it can't be used until it is closed (Testing F-20). The list button and ⌘B bring it back. Not saved, so
  // the same person in a wide window gets the list as they left it.
  // The same when the window is made narrow with the list open (QA round 2, verify-report: resizing from 1500 to 1000 left the
  // whole list floating over the page with nothing behind it).
  useEffect(() => {
    if (!narrowNow) return;
    setLayoutState((l) => {
      if (l.sidebarCollapsed) return l;
      keptOpen.current = l.sidebarCollapsed;
      return { ...l, sidebarCollapsed: true };
    });
  }, [narrowNow]);
  // Wide again, the list is as it was left in a wide window: folded for the narrow one, it stayed folded at 1500 (QA, 2026-10-28;
  // Arun: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
  useEffect(() => {
    if (narrowNow || keptOpen.current === null) return;
    const was = keptOpen.current;
    keptOpen.current = null;
    setLayoutState((l) => (l.sidebarCollapsed === was ? l : { ...l, sidebarCollapsed: was }));
  }, [narrowNow]);

  // What each loader last brought back, so an answer that changed nothing doesn't redraw the whole app (these run every
  // thirty seconds and on every return to the window, and each new array redrew every page and the open session).
  const lastSeen = useRef(new Map<string, string>());
  // Which workspace the lists below are for, and how many times it has changed under them. A read that set out before a switch
  // (the 30-second poll, a return to the window) answers for the workspace it was asked in: its answer is dropped, not shown in
  // the new one. Bumped as a switch starts and again once its cookie is set, since reads between the two still carry the old one.
  const wsGen = useRef(0);
  const wsId = useRef("");
  // Two quick switches: in order, and only the last one counts (workspaceSwitch.ts switchLine).
  /** Run `read` for the workspace in play now, and keep what it brings back only if that is still the one in play. */
  const forWorkspace = useCallback(async <T,>(read: () => Promise<T>): Promise<{ v: T; ws: string } | null> => {
    const g = wsGen.current;
    const ws = wsId.current;
    const v = await read();
    return g === wsGen.current ? { v, ws } : null;
  }, []);
  const changed = useCallback((key: string, value: unknown) => {
    const text = JSON.stringify(value);
    if (lastSeen.current.get(key) === text) return false;
    lastSeen.current.set(key, text);
    return true;
  }, []);
  // Each library list's first load: loading, loaded, or what went wrong. Once a list has loaded, a later failure keeps
  // what is on screen rather than replacing it with an error.
  const [lib, setLib] = useState<Record<LibraryList, string>>({ agents: "loading", skills: "loading", people: "loading", connections: "loading" });
  const libDone = useCallback((k: LibraryList, err?: unknown) => {
    setLib((s) => {
      if (s[k] === "ok") return s;
      if (err === undefined) return { ...s, [k]: "ok" };
      return { ...s, [k]: err instanceof TypeError ? "Friday can't be reached. Check your connection." : (err as Error)?.message || "Something went wrong." };
    });
  }, []);

  const reloadConnections = useCallback(async () => {
    // The open-source edition connects no MCP servers of its own: each coding tool keeps its own.
    if (isLocal()) return;
    try {
      const got = await forWorkspace(async () => {
        const r = await fetch("/api/mcp");
        if (!r.ok) throw new Error("Friday didn't answer.");
        return ((await r.json()) as { connections?: McpPublic[] }).connections ?? [];
      });
      if (!got) return;
      const list = got.v;
      if (changed("mcp", list)) setConnections(list);
      libDone("connections");
    } catch (e) {
      libDone("connections", e);
    }
  }, [libDone]);

  /**
   * ⌘A / Ctrl+A outside a text box selects the chat being read, not the whole window (Arun, 2026-11-18: "make sure nothing can be
   * highlighted like this too"): the window's select-all lit up the thread card, the tabs and the message box's prompt. In a box,
   * an editor or the terminal it is theirs as before; with no chat in view it selects nothing.
   */
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "a") return;
      if (!document.documentElement.classList.contains("desktop")) return;
      const at = (document.activeElement ?? e.target) as HTMLElement | null;
      if (at?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .cm-editor, .xterm')) return;
      e.preventDefault();
      const sel = window.getSelection();
      if (!sel) return;
      // The chat the selection is already in, else the one on screen.
      const from = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
      const item = from?.closest(".feed-item") ?? document.querySelector(".feed-item");
      const feed = item?.parentElement;
      sel.removeAllRanges();
      if (!feed) return;
      const range = document.createRange();
      range.selectNodeContents(feed);
      sel.addRange(range);
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);

  /**
   * Tell the page it is in the desktop app, and on which desktop.
   *
   * macOS draws the window's close/minimise/zoom buttons over the top-left of
   * the page itself — the title bar that would otherwise hold them is hidden —
   * so the sidebar has to leave that corner alone, and the strip it leaves has
   * to be draggable or the window loses its handle.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const root = document.documentElement;
    // The app says so through its preload; an app whose preload did not reach the page still shows itself by the band its
    // stylesheet sets, a little after the page loads. Either way the page is in the desktop window and lays out for it.
    let armed = false;
    let timer: number | undefined;
    let frame = 0;
    let watch: MutationObserver | undefined;
    let layout: MutationObserver | undefined;
    let unlisten: (() => void) | undefined;
    let offFull: (() => void) | undefined;
    const later: number[] = [];
    const arm = () => {
      if (armed) return;
      armed = true;
      const d = window.fridayDesktop;
      root.classList.add("desktop");
      // The app tells us its platform, but an app built before it did says nothing. Fall back to what the window itself reveals.
      const mac = (d?.platform ?? "") === "darwin" || /mac/i.test(navigator.userAgent);
      if (mac) {
        root.classList.add("desktop-mac");
        // An app that moved its window buttons lower says so, and the toolbar and header move down with them.
        // Where their centre is (`--lights-cy`, 6px below the top it gives), so the header lines up with however low they sit.
        if (d?.trafficLightY) root.classList.add("lights-low"), root.style.setProperty("--lights-cy", `${d.trafficLightY + 6}px`);
        setMac(true);
        // In full screen macOS hides the traffic lights, so the back and forward buttons and the header beside them move into
        // the room kept for them (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL"). The window says when
        // (preload onFullScreen): guessed from its size, a window that filled the screen, or had just left full screen, kept the
        // guess and its back and forward buttons sat under the traffic lights (Arun, 2026-10-29). An app built before it said
        // so still guesses: a full-screen window fills the whole screen, menu bar included.
        if (d?.onFullScreen) offFull = d.onFullScreen((on) => root.classList.toggle("win-full", on));
        else {
          const full = () => root.classList.toggle("win-full", window.outerWidth >= screen.width - 1 && window.outerHeight >= screen.height - 1);
          full();
          window.addEventListener("resize", full);
          offFull = () => window.removeEventListener("resize", full);
        }
      }
      // The window's drag rectangles go stale: Chromium recomputes them when a region's own style changes, not reliably when a
      // box that opted out goes away. Every dialog and menu opts out, and a full-screen overlay covers the band while it is open;
      // once it closes, the band would stay dead. So after the page changes, the band's own strip flips for one frame and back,
      // which makes Chromium walk the page again. Throttled: the feed changes many times a second while an agent types.
      // The flip is made on a 1px region of its own, not on <html>: a class on the root restyles the whole page, which it did up
      // to four times a second while anything outside the chat changed. Any drag region changing style makes Chromium walk them
      // all again, so this one is enough.
      const nub = document.getElementById("drag-nub") ?? Object.assign(document.createElement("i"), { id: "drag-nub" });
      nub.setAttribute("aria-hidden", "true");
      if (!nub.isConnected) document.body.appendChild(nub);
      const nudge = () => {
        if (timer !== undefined) return;
        timer = window.setTimeout(() => {
          timer = undefined;
          nub.classList.add("flip");
          frame = requestAnimationFrame(() => {
            frame = requestAnimationFrame(() => nub.classList.remove("flip"));
          });
        }, 250);
      };
      // Not for changes inside the conversation: that is where an agent's words arrive, several times a second, and dialogs
      // and menus (what goes stale) are drawn over the page, never inside it. Each flip makes Chromium walk the whole page.
      const inFeed = (n: Node) => !!(n instanceof Element ? n : n.parentElement)?.closest('[role="log"]');
      watch = new MutationObserver((ms) => {
        if (ms.every((m) => inFeed(m.target))) return;
        nudge();
      });
      watch.observe(document.body, { childList: true, subtree: true });
      // And when things move without the page changing (2026-10-19): pages now start under the window's drag strip, so a
      // button's no-drag box has to follow it. Left stale, it stayed where the button was before the page moved up, the
      // sidebar slid or the page scrolled, and the button only took a click beside itself ("not working when I have it
      // directly on the button"). Which page is showing (the band), the sidebar opening or closing once its slide has ended,
      // the window resizing, and scrolling all flip it again, under the same throttle.
      layout = new MutationObserver(nudge);
      layout.observe(root, { attributes: true, attributeFilter: ["data-band"] });
      const shell = document.querySelector(".shell");
      if (shell) layout.observe(shell, { attributes: true, attributeFilter: ["class"] });
      document.addEventListener("transitionend", onSettle, true);
      window.addEventListener("resize", nudge);
      document.addEventListener("scroll", nudge, { capture: true, passive: true });
      unlisten = () => {
        document.removeEventListener("transitionend", onSettle, true);
        window.removeEventListener("resize", nudge);
        document.removeEventListener("scroll", nudge, true);
      };
      function onSettle(e: TransitionEvent) {
        if ((e.target as Element | null)?.classList?.contains("shell")) nudge();
      }
    };
    if (window.fridayDesktop || inBand()) arm();
    else for (const ms of [300, 1000, 2500]) later.push(window.setTimeout(() => inBand() && arm(), ms));
    // Ctrl+Alt+D: outline what drags and what does not, and say what the page knows, for a look at a window that will not drag.
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && e.altKey && e.key.toLowerCase() === "d")) return;
      const on = root.classList.toggle("drag-debug");
      document.getElementById("drag-debug")?.remove();
      if (!on) return;
      const v = (name: string) => getComputedStyle(root).getPropertyValue(name).trim() || "(none)";
      const rect = (id: string) => JSON.stringify(document.getElementById(id)?.getBoundingClientRect().toJSON() ?? null);
      const region = (el: Element | null) => (el ? getComputedStyle(el).getPropertyValue("-webkit-app-region") || "?" : "(no element)");
      const shell = document.querySelector(".shell");
      const pre = document.createElement("pre");
      pre.id = "drag-debug";
      pre.textContent = [
        `html: ${root.className}`,
        `--band: ${v("--band")} · --band-top: ${v("--band-top")} · --band-right: ${v("--band-right")} · --slot-w: ${v("--slot-w")}`,
        `preload: ${window.fridayDesktop ? "yes" : "no"} · platform: ${window.fridayDesktop?.platform ?? "?"} · ${innerWidth}×${innerHeight} · ${navigator.userAgent.slice(0, 70)}`,
        `band-left ${rect("band-left")} · ${region(document.getElementById("band-left"))}`,
        `band-slot ${rect("band-slot")} · ${region(document.getElementById("band-slot"))}`,
        `strip (html::before): ${getComputedStyle(root, "::before").getPropertyValue("-webkit-app-region") || "?"} · shell strip (.shell::before): ${shell ? getComputedStyle(shell, "::before").getPropertyValue("-webkit-app-region") || "?" : "(no .shell)"}`,
      ].join("\n");
      document.body.appendChild(pre);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      later.forEach(clearTimeout);
      watch?.disconnect();
      layout?.disconnect();
      unlisten?.();
      offFull?.();
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      root.classList.remove("desktop", "desktop-mac", "lights-low", "win-full", "drag-nudge", "drag-debug");
      root.style.removeProperty("--lights-cy");
      document.getElementById("drag-debug")?.remove();
    };
  }, []);

  useEffect(() => {
    let live = true;
    (early<{ user?: { id: string; name: string; email?: unknown } }>("me") ?? fetch("/api/me", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)))
      .then((body) => {
        if (!live) return;
        if (body?.user) {
          setIdentity({ id: body.user.id, name: body.user.name });
          setEmail(typeof body.user.email === "string" ? body.user.email : undefined);
          setAuthed(true);
          // The provider round-trip leaves markers behind; the URL is the
          // session's again once we're in.
          if (/[?&](signin|error)=/.test(location.search)) {
            const u = new URL(location.href);
            u.searchParams.delete("signin");
            u.searchParams.delete("error");
            history.replaceState(null, "", u.pathname + u.search);
          }
        } else setAuthed(false);
      })
      .catch(() => live && setAuthed(false));
    return () => {
      live = false;
    };
  }, []);

  // The workspace carries the plan, its limits and what today has cost, which
  // is what the usage meter shows. Re-read it on a slow timer and whenever the
  // tab comes back: a run that happened in another tab spent from the same
  // allowance, and a stale bar is worse than no bar.
  useEffect(() => {
    // No workspace on someone's own computer: everything is Solo (edition.ts).
    if (!identity.id || isLocal()) return;
    let live = true;
    const read = (first = false, g = wsGen.current) =>
      ((first && early<{ workspace?: WorkspaceUsage }>("workspace")) || fetch("/api/workspace", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)))
        .then((b: { workspace?: WorkspaceUsage } | null) => {
          // An answer asked before a switch is the old workspace's: dropped. Otherwise it says which workspace the cookie is in.
          if (!live || !b?.workspace || g !== wsGen.current) return;
          wsId.current = b.workspace.id;
          setWorkspace(b.workspace);
        })
        .catch(() => {});
    void read(true);
    const timer = setInterval(() => document.visibilityState === "visible" && void read(), 60_000);
    const onShow = () => document.visibilityState === "visible" && void read();
    document.addEventListener("visibilitychange", onShow);
    // Settings saves the workspace's defaults; this is how the composer hears
    // about it without waiting out the polling interval.
    const onChanged = () => void read();
    addEventListener("friday:workspace", onChanged);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onShow);
      removeEventListener("friday:workspace", onChanged);
    };
  }, [identity.id]);

  const [agentSel, setAgentSel] = useState<string | null>(null);
  const [importingAgents, setImportingAgents] = useState(false);
  const [editing, setEditing] = useState(false);
  /** What the open session offers ⌘K: its own controls, next to the app's. */
  const [sessionActions, setSessionActions] = useState<Action[]>([]);
  const [askConfirm, confirmUI] = useConfirm();
  // These follow who you are, not the identity object: renaming yourself makes a new one, and each new one sent every list
  // below again. A request carries the cookie, never the name.
  const reloadAgents = useCallback(async () => {
    // Saved Friday agents are the hosted service's; the open-source edition drives your own coding tools.
    if (!identity.id || isLocal()) return;
    try {
      const got = await forWorkspace(() => api<{ agents: AgentView[] }>(identity, "/api/agents"));
      if (!got) return;
      const list = got.v.agents;
      if (changed("agents", list)) setAgents(list);
      libDone("agents");
    } catch (e) {
      libDone("agents", e);
    }
  }, [identity.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const reloadPeople = useCallback(async () => {
  }, [identity.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const reloadInbox = useCallback(async () => {
  }, [identity.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const reloadSkills = useCallback(async () => {
    try {
      const got = await forWorkspace(() => api<{ skills: SkillView[]; collections?: CollectionView[] }>(identity, "/api/skills"));
      if (!got) return;
      const r = got.v;
      if (!changed("skills", r)) return libDone("skills");
      setSkills(r.skills);
      setCollections(r.collections ?? []);
      libDone("skills");
    } catch (e) {
      libDone("skills", e);
    }
  }, [identity.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Not before /api/me has said who you are: run once without anyone and once with, every one of these went twice.
    if (!identity.id) return;
    void reloadConnections();
    void reloadPeople();
    void reloadInbox();
    // At most every thirty seconds: switching between windows used to send five requests each time.
    let focusedAt = 0;
    const onFocus = () => {
      if (Date.now() - focusedAt < 30_000) return;
      focusedAt = Date.now();
      void reloadConnections();
      void reloadAgents();
      void reloadSkills();
      void reloadPeople();
      void reloadInbox();
    };
    const poll = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void reloadConnections();
      // Invites arrive from other people, so this is the only way to see one land.
      void reloadInbox();
      void reloadPeople();
    }, 30_000);
    addEventListener("focus", onFocus);
    return () => {
      removeEventListener("focus", onFocus);
      clearInterval(poll);
    };
  }, [identity.id, reloadConnections, reloadAgents, reloadSkills, reloadPeople, reloadInbox]);

  useEffect(() => {
    void reloadAgents();
  }, [reloadAgents]);
  // The coding tools' limits, asked for as the app opens: by the time anyone looks at them they are there (toolLimits.ts).
  useEffect(() => {
    if (identity.id) refreshToolLimits(identity);
  }, [identity.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // The other pages' code, fetched once the app has settled, so opening one later is instant (see `pages`). The session
  // screen's at the first idle moment, since a session is what most people open next. Each waits at most a couple of
  // seconds for that moment: a page kept busy (Home's animation, in a headless check) never offered one.
  useEffect(() => {
    if (!identity.id) return;
    const idle = (fn: () => void) => (typeof requestIdleCallback === "function" ? requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 0));
    idle(() => warmPage("session"));
    const t = window.setTimeout(() => idle(() => Object.keys(pages).forEach(warmPage)), 3000);
    return () => clearTimeout(t);
  }, [identity.id]);

  useEffect(() => {
    if (route.kind === "connections") void reloadConnections();
    if (route.kind === "agents" || route.kind === "automations") void reloadAgents();
    if (route.kind === "agents") void reloadSkills();
  }, [route.kind, reloadConnections, reloadAgents, reloadSkills]);

  useEffect(() => {
    // Unsaved work on screen asks first, Back included (leave-guard.ts).
    const onPop = () => void (!leavingByHistory() && setRoute(readRoute()));
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback(
    (r: Route) => {
      // Unsaved work on screen (a workflow's builder) asks before it is left, then comes back here (leave-guard.ts).
      if (leaving(() => navigateRef.current(r))) return;
      // The page you are on, asked for again (its sidebar button pressed while inside one of its own screens, say an
      // automation's editor): it goes back to its own top (2026-10-27 audit: the button did nothing there).
      if (r.kind !== "session" && parseRoute(location.search).kind === r.kind) dispatchEvent(new CustomEvent("friday:same-page", { detail: r.kind }));
      history.pushState(null, "", routeUrl(r));
      setRoute(r);
      if (r.kind !== "session") document.title = r.kind === "connections" ? "Connections · Friday" : r.kind === "agents" ? "Saved agents · Friday" : r.kind === "automations" ? "Automations · Friday" : r.kind === "settings" ? "Settings · Friday" : r.kind === "usage" ? "Usage · Friday" : r.kind === "new-teammate" ? "New agent · Friday" : r.kind === "review" ? "Code Review · Friday" : r.kind === "needs" ? "Needs you · Friday" : r.kind === "board" ? "Agent Board · Friday" : r.kind === "deepdive" ? "Deep Dive · Friday" : r.kind === "mcp" ? "MCP servers · Friday" : r.kind === "skills" ? "Skills · Friday" : r.kind === "library" ? "Library · Friday" : r.kind === "people" ? "People · Friday" : (r.kind as string) === "crew" ? "Crew · Friday" : "Friday";
      if (isNarrow(innerWidth)) setLayout({ sidebarCollapsed: true });
    },
    [setLayout],
  );
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  // A crew mate or a room removed while its page is open: the page goes, back to the Agents page (Arun, 2026-11-15: "make sure if
  // i delete a crew or crew room make sure its page disappears off of my screen"). Only what was seen here and then went: a room or
  // crew mate the team hasn't loaded yet isn't gone. A crew mate's thread removed is its own menu's to leave.
  const teamNow = useTeamNow();
  const hereSid = route.kind === "session" ? route.sid : "";
  const focusedHere = useFocusedAgent(hereSid);
  const crewSeen = useRef<{ rooms: Map<string, boolean>; lanes: Set<string> }>({ rooms: new Map(), lanes: new Set() });
  // The crew mate whose chat was open: its removal unfocuses it before the team says it is gone.
  const lastMate = useRef({ sid: "", lane: "" });
  if (lastMate.current.sid !== hereSid) lastMate.current = { sid: hereSid, lane: "" };
  if (focusedHere !== ALL) lastMate.current.lane = focusedHere;
  useEffect(() => {
    if (!isLocal() || !teamNow) return;
    const seen = crewSeen.current;
    for (const r of teamNow.rooms ?? []) seen.rooms.set(r.sid, !!r.thread);
    for (const m of teamNow.teammates) seen.lanes.add(m.lane);
    if (!hereSid) return;
    const roomGone = hereSid !== teamNow.sid && seen.rooms.get(hereSid) === false && !(teamNow.rooms ?? []).some((r) => r.sid === hereSid);
    const lane = focusedHere !== ALL ? focusedHere : lastMate.current.lane;
    const mateGone = hereSid === teamNow.sid && !!lane && seen.lanes.has(lane) && !teamNow.teammates.some((m) => m.lane === lane);
    if (!roomGone && !mateGone) return;
    lastMate.current.lane = "";
    navigateRef.current({ kind: "home" });
    choosePlace("team");
  }, [teamNow, hereSid, focusedHere]);
  // No Crew room page in the open-source edition (Arun, 2026-11-15: "why is there a crew room appearing when i have nothing there"):
  // its session holds every crew mate's own chat, and with none of them picked it showed all their old turns at once. Landing on it
  // with no crew mate in view, after a moment for a crew mate's chat opening to say which, is the Agents page instead.
  const focusNow = useRef(focusedHere);
  focusNow.current = focusedHere;
  useEffect(() => {
    if (!isLocal() || !teamNow || !hereSid || hereSid !== teamNow.sid || focusedHere !== ALL) return;
    const t = setTimeout(() => {
      if (focusNow.current !== ALL) return;
      navigateRef.current({ kind: "home" });
      choosePlace("team");
    }, 350);
    return () => clearTimeout(t);
  }, [teamNow?.sid, hereSid, focusedHere]); // eslint-disable-line react-hooks/exhaustive-deps
  /**
   * The new-session page, from wherever a session is asked for: out of the Crew first, whose home is its room rather than the box,
   * so "New session" from ⌘K, Code Review or the Board landed in the Crew room and what was typed went nowhere (2026-11-02 review).
   * `code`: a coding brief, which goes to Code rather than back to Work.
   */
  const toNewSession = (r: Route = { kind: "home" }, code = false) => {
    if (leaving(() => toNewSessionRef.current(r, code))) return;
    if (code) choosePlace("code");
    else if (readTabNow()) setTeamTab(false);
    navigate(r);
  };
  const toNewSessionRef = useRef(toNewSession);
  toNewSessionRef.current = toNewSession;

  // ── Solo ⇄ Team, in place (workspaceSwitch.ts) ──
  // The pages are drawn afresh after a switch (keyed on this), so whatever each read for itself is read again in the new
  // workspace, as the reload did; the shell, the sidebar and the code already loaded stay.
  const [switches, setSwitches] = useState(0);

  // Settings opens where it was last left, from the rail; anything else that asks for it names a section.
  const lastSettings = useRef("appearance");
  useEffect(() => {
    if (route.kind === "settings") lastSettings.current = route.section;
  }, [route]);
  // Anything in the app can ask for Settings, on a section.
  useEffect(() => {
    const on = (e: Event) => {
      const tab = (e as CustomEvent<{ tab?: string }>).detail?.tab;
      // Usage & limits is the Usage page's row in Settings (audit REST-21).
      if (tab === "usage-limits") return navigate({ kind: "usage" });
      // Asked for a section by name: land on its heading. Asked for Settings: land in its search.
      askPage(tab ? "settings-section" : "settings-search");
      navigate({ kind: "settings", section: settingsSection(tab ?? lastSettings.current) });
    };
    addEventListener("friday:settings", on);
    // The Usage page, from anywhere (the home page's "tokens saved" line).
    const usage = () => navigate({ kind: "usage" });
    addEventListener("friday:usage", usage);
    // The New teammate page, from anywhere (the Crew's New teammate, Getting started's Add): with the Crew in the sidebar.
    const mate = () => (setTeamTab(true, { stay: true }), navigate({ kind: "new-teammate" }));
    addEventListener("friday:new-teammate", mate);
    return () => {
      removeEventListener("friday:settings", on);
      removeEventListener("friday:usage", usage);
      removeEventListener("friday:new-teammate", mate);
    };
  }, [navigate]);
  // A quick prompt from the floating window (desktop/quick.ts): into the session that is open, or a new one, as an ordinary
  // message with its snapshot attached (quick-send.ts). If that fails, the words land in the box on the start page instead.
  const quickRoute = useRef(route);
  quickRoute.current = route;
  useEffect(() => {
    const q = window.fridayDesktop?.quick;
    if (!q || !identity.id) return;
    return q.onPrompt((m) => {
      void (async () => {
        const r = quickRoute.current;
        try {
          if (r.kind === "session") await sendQuickTo(r.sid, r.invite, m);
          else {
            const made = await startQuick(identity, m);
            setRecents((prev) => [made, ...prev.filter((x) => x.sid !== made.sid)]);
            navigate({ kind: "session", sid: made.sid, invite: made.invite });
          }
        } catch (e) {
          console.warn("[quick]", e);
          setPreset({ brief: quickText(m) });
          toNewSessionRef.current();
        }
      })();
    });
  }, [identity.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // A workspace invite link: asked about once, then the address is tidied whatever the answer.
  const [joining, setJoining] = useState(() => new URLSearchParams(location.search).get("join") ?? "");
  // No Team chat any more (Arun, 2026-10-24: "get rid of this and the team side panel too"): one left open from before is
  // forgotten, and the band's controls go back where they were with it closed.
  useEffect(() => {
    try {
      localStorage.removeItem("friday.chat.open");
    } catch {}
    document.documentElement.classList.remove("chat-open");
  }, []);
  useEffect(() => {
    if (!joining) return;
    const q = new URLSearchParams(location.search);
    q.delete("join");
    const rest = q.toString();
    history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : "") + location.hash);
  }, [joining]);

  // Global keyboard shortcuts.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  // For the keys that move between sessions: the list, what waits on you, and the sessions in the order you were last in them.
  const moveRef = useRef({ recents, items: attention.items, here: route.kind === "session" ? route.sid : "", identity });
  moveRef.current = { recents, items: attention.items, here: route.kind === "session" ? route.sid : "", identity };
  const visited = useRef<string[]>([]);
  useEffect(() => {
    if (route.kind === "session") visited.current = [route.sid, ...visited.current.filter((x) => x !== route.sid)].slice(0, 20);
  }, [route]);
  useEffect(() => {
    /** Into a session of this person's list, by its id. */
    const go = (sid: string | undefined) => {
      const r = sid ? moveRef.current.recents.find((x) => x.sid === sid) : undefined;
      if (r) navigate({ kind: "session", sid: r.sid, invite: r.invite });
      return !!r;
    };
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      const { items, here } = moveRef.current;
      // ⌘⌥1–9: the sidebar's sessions, in the order it shows them (⌘1–4 are a session's panels). By the key, not the character:
      // ⌥ turns 1 into ¡ on a Mac.
      // Not AltGr, which the browser reports as Ctrl+Alt: on a German or French keyboard it and a digit type { [ ] # | \ (2026-11-02 review).
      if (mod && e.altKey && !e.shiftKey && !e.getModifierState("AltGraph") && /^Digit[1-9]$/.test(e.code)) {
        // Each session once: one waiting on you shows in Needs you and again in its group, and ⌘⌥1 and ⌘⌥2 both opened it (Arun,
        // 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
        const sids = [...new Set([...document.querySelectorAll<HTMLElement>(".dass-row[data-sid]")].filter((el) => el.offsetParent !== null).map((el) => el.dataset.sid!))];
        if (go(sids[Number(e.code.slice(5)) - 1])) e.preventDefault();
        return;
      }
      // Ctrl+Tab: back to the session you were in before this one, as an editor flips between its last two files; ⇧ goes on
      // down the list of the ones you've been in.
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab") {
        const seen = visited.current.filter((x) => x !== here && moveRef.current.recents.some((r) => r.sid === x));
        const fallback = moveRef.current.recents.filter((r) => r.sid !== here).sort((a, b) => b.openedAt - a.openedAt).map((r) => r.sid);
        const order = [...seen, ...fallback.filter((x) => !seen.includes(x))];
        if (go(e.shiftKey ? order[order.length - 1] : order[0])) e.preventDefault();
        return;
      }
      // ⌘E: Agents or Code (open-source edition). Not while typing in a box (the chat's, a search field), but the editor is
      // typing too and is where it is most wanted, so it counts as the IDE; and off the Mac Ctrl+E is the shell's "end of line",
      // so it is left to the terminal.
      if (mod && !e.shiftKey && !e.altKey && k === "e" && isLocal()) {
        const t = e.target instanceof Element ? e.target : null;
        const inEditor = !!t?.closest(".cm-editor");
        const inTerminal = !!t?.closest(".xterm") && !e.metaKey;
        const onMac = /Mac|iPhone|iPad/.test(navigator.platform);
        // ⌘E (Meta) means nothing to a text box, so it works from the chat's message box too, where the keyboard usually is in Agents;
        // Ctrl+E is "end of line" in one on a Mac (the editor's too), so there that one keeps the rules above. Off the Mac Ctrl+E is
        // the only chord, and the editor counts as the IDE.
        if ((e.metaKey || (!onMac && inEditor) || !isTyping(e.target)) && !inTerminal) {
          e.preventDefault();
          swapMode();
        }
        return;
      }
      // ⌘O in Code: Open Folder.
      if (mod && !e.shiftKey && !e.altKey && k === "o" && isLocal() && getMode() === "code") {
        e.preventDefault();
        dispatchEvent(new Event("friday:ide-open-folder"));
        return;
      }
      // ⌘N: a new thread in the open coding session's project (threads.tsx), else a new session (Arun, 2026-11-15, threads).
      if (mod && !e.shiftKey && !e.altKey && k === "n") {
        e.preventDefault();
        const ask = new CustomEvent(NEW_THREAD, { detail: { handled: false } });
        if (here) dispatchEvent(ask);
        if (!ask.detail.handled) navigate({ kind: "home" });
        return;
      }
      // ⌘⇧Y: everything waiting on you, in one queue (NeedsYou.tsx).
      if (mod && e.shiftKey && !e.altKey && k === "y") {
        e.preventDefault();
        navigate({ kind: "needs" });
        return;
      }
      // ⌘⇧U: the next session that waits on you, after this one, round to the first (as cmux binds it). What waits is the Needs you
      // page's list, the one the Board and Home count too; nothing waiting is said, not a key that does nothing (audit REST-2).
      if (mod && e.shiftKey && !e.altKey && k === "u") {
        e.preventDefault();
        const { recents: listed, identity: who } = moveRef.current;
        void api<{ items: { where: { sid?: string }; putOff?: true }[] }>(who, "/api/needs-you", { method: "POST", body: JSON.stringify({ sids: listed.map((r) => r.sid) }) })
          .catch(() => null)
          .then((got) => {
            // Not what was put off: it's out of every count of what waits on you.
            const needs = (got?.items ?? []).filter((n) => !n.putOff);
            const sids = [...new Set([...needs.flatMap((n) => (n.where.sid ? [n.where.sid] : [])), ...items.map((i) => i.sid)])].filter((sid) => listed.some((r) => r.sid === sid));
            if (sids.length) return void go(sids[(sids.indexOf(here) + 1) % sids.length]);
            // Waiting, but not in a session of the list (a teammate's ask, a review): the page that has it.
            if (needs.length) return navigate({ kind: "needs" });
            dispatchEvent(new CustomEvent("friday:notice", { detail: "Nothing is waiting on you" }));
          });
        return;
      }
      // ⌘K opens the palette, as every tool of this kind binds it (Arun, 2026-10-25, after T3 Code, Orca and MonoCode). It used
      // to mean "new session" alone; that is the palette's first row, so ⌘K then Enter still starts one, and typing a task into it
      // offers to start a session with those words. ⌘⇧P too, the way every editor binds it.
      if (mod && ((e.shiftKey && k === "p") || (!e.shiftKey && k === "k"))) {
        e.preventDefault();
        setPalette((v) => !v);
      } else if (mod && e.shiftKey && k === "f") {
        e.preventDefault();
        setSearch((v) => !v);
      } else if (mod && k === "b") {
        e.preventDefault();
        setLayout({ sidebarCollapsed: !layoutRef.current.sidebarCollapsed });
      } else if (mod && e.key === ".") {
        e.preventDefault();
        setLayout({ docOpen: !layoutRef.current.docOpen });
      } else if (!mod && e.key === "?" && !isTyping(e.target)) {
        setShortcuts(true);
      }
    };
    // The same two, pressed in a session's status bar.
    const onPalette = () => setPalette(true);
    const onSearch = () => setSearch(true);
    addEventListener("friday:search", onSearch);
    const onShortcuts = () => setShortcuts(true);
    // The sidebar's own fold button, in a browser (Sidebar.tsx).
    const onFold = () => setLayout({ sidebarCollapsed: true });
    addEventListener("friday:fold-sidebar", onFold);
    addEventListener("keydown", onKey);
    addEventListener("friday:palette", onPalette);
    addEventListener("friday:shortcuts", onShortcuts);
    return () => {
      removeEventListener("keydown", onKey);
      removeEventListener("friday:palette", onPalette);
      removeEventListener("friday:search", onSearch);
      removeEventListener("friday:shortcuts", onShortcuts);
      removeEventListener("friday:fold-sidebar", onFold);
    };
  }, [navigate, setLayout]);

  // ── sidebar data ──
  /** A session started from a project's "New session here", for the project it goes in once it is first seen. */
  const fileInto = useRef<{ sid: string; projectId: string } | null>(null);
  const remember = useCallback(
    (entry: RecentSession) => {
      // One of Code's chats, opened anywhere: its title goes to Code's list, never into Agents'.
      if (isCodeChat(entry.sid)) return void updateCodeChat(entry.sid, { title: entry.title });
      setRecents((prev) => {
        const old = prev.find((x) => x.sid === entry.sid);
        const next = [
          {
            ...old,
            ...entry,
            // Looking at a session doesn't move it in the list: what happens in it does (above). A new one is placed as it opens.
            openedAt: old?.openedAt ?? entry.openedAt,
            projectId: entry.projectId ?? old?.projectId ?? (fileInto.current?.sid === entry.sid ? fileInto.current.projectId : undefined),
            // A name given in the sidebar is kept until the session's own title changes: renamed in the session, that is the
            // newest name and the list shows it (Arun, 2026-10-24: "if i update the session title in the coding session it
            // auto updates for the side bar too"). It had gone on showing the sidebar's name over it.
            alias: old?.title && entry.title && entry.title !== old.title ? undefined : old?.alias,
            // A chat with no coding agent attached reports no repos, which must not wipe the ones it was filed under (a fork has none until one connects).
            repos: entry.repos?.length ? entry.repos : old?.repos,
          },
          ...prev.filter((x) => x.sid !== entry.sid),
        ];
        saveRecents(next);
        return next;
      });
    },
    [],
  );
  // Issues with a project's label start threads by themselves, in the open-source edition (issue-intake.ts).
  const rememberRef = useRef(remember);
  rememberRef.current = remember;
  useEffect(() => {
    if (!isLocal() || !identity.id) return;
    let stop: (() => void) | null = null;
    let gone = false;
    void import("./issue-intake.js").then((m) => !gone && (stop = m.startIntake(identity, () => rememberRef.current)));
    return () => ((gone = true), stop?.());
  }, [identity.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // What a coding session's thread tabs read (threads.tsx): how each session stands, the list, and adding to it.
  const threadsData = useMemo(() => ({ attention, recents, remember, ring: (sid: string, active: boolean) => <ThreadRing attention={attention} sid={sid} active={active} /> }), [attention, recents, remember]);
  // A fork is filed straight under the chat it came from (the list is newest first, so one tick older); forkSession opens it.
  useEffect(() => {
    const on = (e: Event) => {
      const f = (e as CustomEvent<{ from: string; sid: string; invite: string; title: string }>).detail;
      // A fork of one of Code's chats is Code's too: next to it in Code's history, and shown in its column.
      const codeSrc = loadCodeChats().find((c) => c.sid === f.from && !c.linked);
      if (codeSrc) return void addCodeChat({ sid: f.sid, invite: f.invite, folder: codeSrc.folder, title: f.title, at: Date.now(), ...(codeSrc.tool ? { tool: codeSrc.tool } : {}) });
      setRecents((prev) => {
        const src = prev.find((x) => x.sid === f.from);
        // Filed where the chat it came from is: in its project, and under its repo (not live, since nothing is connected to the copy).
        const repos = src?.repos?.map((r) => ({ ...r, live: false }));
        const next = [{ sid: f.sid, title: f.title, invite: f.invite, role: "owner" as const, openedAt: (src?.openedAt ?? Date.now()) - 1, ...(src?.projectId ? { projectId: src.projectId } : {}), ...(repos?.length ? { repos } : {}) }, ...prev];
        saveRecents(next);
        return next;
      });
    };
    window.addEventListener("friday:forked", on);
    return () => window.removeEventListener("friday:forked", on);
  }, []);
  // Another session, opened from a card that names it (a message between sessions): only one in this person's list, which holds the way in.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ sid: string; invite?: string }>).detail;
      // Or one the card carries the way into itself (a teammates' room not opened here yet).
      // One of Code's chats (a fork just made there, a card naming one): it shows in Code's column, not as a page of Agents.
      // A linked one (an Agents session shown in Code) too, when Code is what is open: a card in its column names it.
      const code = loadCodeChats().find((c) => c.sid === d.sid && (!c.linked || getMode() === "code"));
      if (code) return void (showCodeChat(code.folder, code.sid), setIdeRoot(code.folder), setViewMode("code"));
      const r = loadRecents().find((x) => x.sid === d.sid) ?? (d.invite ? { sid: d.sid, invite: d.invite } : null);
      if (r) navigate({ kind: "session", sid: r.sid, invite: r.invite });
    };
    window.addEventListener("friday:open-session", on);
    // Something waiting on you that isn't a session of the list (Home's row for a workflow at its Your OK): where it is answered.
    const needs = () => navigate({ kind: "needs" });
    window.addEventListener("friday:open-needs", needs);
    return () => (window.removeEventListener("friday:open-session", on), window.removeEventListener("friday:open-needs", needs));
  }, [navigate]);
  // A Code chat sent to Agents (ide/send-to-agents.tsx): filed in Agents' recents now it isn't Code's, and opened there when asked.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ sid: string; invite: string; title: string; open?: boolean }>).detail;
      if (!d.open) remember({ sid: d.sid, title: d.title, invite: d.invite, role: "owner", openedAt: Date.now() });
      else {
        setViewMode("agents");
        navigate({ kind: "session", sid: d.sid, invite: d.invite });
      }
    };
    window.addEventListener("friday:code-to-agents", on);
    return () => window.removeEventListener("friday:code-to-agents", on);
  }, [navigate, remember]);
  // The last teammate removed from the Team room: the Team tab's first run, not an empty room (Arun, 2026-10-28: "really iron
  // out bugs and feature problems and gaps").
  useEffect(() => {
    const home = () => navigate({ kind: "home" });
    addEventListener("friday:team-home", home);
    return () => removeEventListener("friday:team-home", home);
  }, [navigate]);
  const updateRecent = (sid: string, patch: Partial<RecentSession>) =>
    setRecents((prev) => {
      const next = prev.map((x) => (x.sid === sid ? { ...x, ...patch } : x));
      saveRecents(next);
      return next;
    });
  const dropRecents = (sids: string[]) => {
    // A session that leaves Agents' list takes its link in Code with it (a "From Agents" tab, a row in Code's history).
    sids.forEach(dropLinkedChat);
    setRecents((prev) => {
      const next = prev.filter((x) => !sids.includes(x.sid));
      if (next.length === prev.length) return prev;
      saveRecents(next);
      return next;
    });
  };
  // Removed on another device.
  useEffect(() => {
    if (attention.gone.length) dropRecents(attention.gone);
  }, [attention.gone]);
  const removeRecent = (sid: string) => {
    dropRecents([sid]);
    // The server's list too, or it comes back the next time the app opens.
    void api(identity, "/api/sessions/mine/forget", { method: "POST", body: JSON.stringify({ sid }) }).catch(() => {});
    // A chat that is gone can't stay on screen: back to the page for starting a new one.
    if (route.kind === "session" && route.sid === sid) navigate({ kind: "home" });
  };
  // Deleted for everyone: the server frees what it kept, and it leaves every list, here and on everyone else's devices.
  const deleteSession = async (sid: string): Promise<string | void> => {
    try {
      await api(identity, `/api/sessions/${encodeURIComponent(sid)}/delete`, { method: "POST", body: "{}" });
    } catch (e) {
      return (e as Error).message || "Couldn't delete that session.";
    }
    dropRecents([sid]);
    if (route.kind === "session" && route.sid === sid) navigate({ kind: "home" });
  };
  const writeProjects = (fn: (p: Project[]) => Project[]) =>
    setProjects((prev) => {
      const next = fn(prev);
      saveProjects(next);
      return next;
    });
  const createProject = (name: string) => {
    const id = crypto.randomUUID().slice(0, 8);
    writeProjects((p) => [...p, { id, name, collapsed: false, createdAt: Date.now() }]);
    return id;
  };
  const deleteProject = (id: string) => {
    writeProjects((p) => p.filter((x) => x.id !== id));
    setRecents((prev) => {
      const next = prev.map((x) => (x.projectId === id ? { ...x, projectId: undefined } : x));
      saveRecents(next);
      return next;
    });
  };

  const rename = async (name: string) => {
    const before = identity.name;
    setIdentity((i) => ({ ...i, name }));
    try {
      await api(identity, "/api/me", { method: "PATCH", body: JSON.stringify({ name }) });
    } catch (e) {
      setIdentity((i) => ({ ...i, name: before }));
      throw e;
    }
  };

  const activeSid = route.kind === "session" ? route.sid : null;
  useEffect(() => void (activeSid && clearUnread(activeSid)), [activeSid]);
  // The session somebody was last working in: where the Team library's "Use as context" puts a brief.
  const lastSession = useRef<{ sid: string; invite: string } | null>(null);
  if (route.kind === "session") lastSession.current = { sid: route.sid, invite: route.invite };
  // The chat list belongs to Chat. It sits beside the rail for a chat or the
  // new-chat page and is gone everywhere else, where there is nothing to list;
  // folding it away is a preference of its own, kept for when you come back.
  const [teamTabOn] = useTeamTab();
  // A crew workflow open in its builder from the one Automations list: its id, "new", or null for the list (the "Why Crew" plan,
  // 2026-11-13: coding automations and crew workflows are one list). Back to the list on any other page.
  const [workflowOpen, setWorkflowOpen] = useState<string | null>(null);
  useEffect(() => {
    let keep = route.kind === "automations";
    if (!keep) setWorkflowOpen(null);
  }, [route.kind]); // eslint-disable-line react-hooks/exhaustive-deps
  useWorkflowNotices();
  // Which sessions are which, read from the server here whatever shows: with the sidebar folded nothing else asked (2026-10-28).
  useWorkSessions(identity);
  usePlaceFollows(activeSid);
  // Automations is each place's own (the Crew's are its workflows) and the hosted Crew page turns the place itself, so both stay;
  // so does the New teammate page, which turns to the Crew as it opens.
  usePlaceLeaves(activeSid, () => navigate({ kind: "home" }), !["home", "session", "automations", "crew", "new-teammate"].includes(route.kind));
  const inChat = route.kind === "home" || route.kind === "session";
  const inAgents = route.kind === "agents";
  // Agents or Code. Code takes the window's main area (and the rail and list stay away), with the session last open in it.
  const [viewMode] = useMode();
  const inCode = isLocal() && viewMode === "code" && !!identity.id;
  // Code's own palette actions (ide/palette-page.ts), loaded the first time Code shows: Agents' first screen doesn't carry them.
  const [codeActions, setCodeActions] = useState<typeof CodeActions | null>(null);
  useEffect(() => {
    if (inCode && !codeActions) void import("./ide/palette-page.js").then((m) => setCodeActions(() => m.codeActions), () => {});
  }, [inCode, codeActions]);
  // Code stays loaded, hidden, after Agents is chosen, so switching back is instant (Arun, 2026-11-19: "smoother and faster loading
  // of the IDE when switching between agents and code"): VS Code is a whole editor to boot each time. It is also started hidden when
  // the pointer reaches the Agents / Code button (WindowNav, friday:code-warm), so even the first switch finds it on its way. Let go
  // after a quarter of an hour in Agents, which frees what it holds.
  const [codeKept, setCodeKept] = useState(false);
  useEffect(() => {
    if (inCode) return setCodeKept(true);
    if (!codeKept) return;
    const t = window.setTimeout(() => setCodeKept(false), 15 * 60_000);
    return () => window.clearTimeout(t);
  }, [inCode, codeKept]);
  useEffect(() => {
    if (!isLocal() || !identity.id) return;
    const warm = () => setCodeKept(true);
    window.addEventListener("friday:code-warm", warm);
    // Someone who has used Code finds it ready (Arun, 2026-11-19: "the loading of VScode is fast and almost instant"): a few seconds
    // after Friday opens, once its own first work is done, VS Code is started out of sight, so the switch shows it at once.
    let used = false;
    try {
      used = localStorage.getItem("friday.code.used") === "1";
    } catch {
      // Not known: it warms when the pointer reaches the Agents / Code button instead.
    }
    const t = used ? window.setTimeout(warm, 4000) : undefined;
    return () => (window.removeEventListener("friday:code-warm", warm), window.clearTimeout(t));
  }, [identity.id]);
  useEffect(() => {
    if (!inCode) return;
    try {
      localStorage.setItem("friday.code.used", "1");
    } catch {
      // A preference: without it Code warms on the pointer instead.
    }
  }, [inCode]);
  const codeMounted = isLocal() && !!identity.id && (inCode || codeKept);
  const lastSid = useRef<string | null>(null);
  if (activeSid) lastSid.current = activeSid;
  // The folder Code shows: only one the person chose (mode.ts setIdeRoot). None at first: Code opens on its start screen.
  const pickedRoot = useIdeRoot();
  // The folder the last launch left Code on is checked to still be there (ide/restore.ts).
  // Lazy: only a launch that has a folder to check loads it, and the first load stays small.
  useEffect(() => {
    if (!isLocal() || !identity.id || !restoredIdeRoot()) return;
    let undo = () => {};
    let live = true;
    void import("./ide/restore.js").then((m) => live && (undo = m.checkRestoredRoot(identity)));
    return () => ((live = false), undo());
  }, [identity.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const ideRoot = pickedRoot;
  // The session that works in that folder, if any: a folder nobody has used yet has none ("Start one here" in the chat column).
  const ideFolders = useMemo(() => [...new Set(recents.flatMap((r) => foldersOf(r)))], [recents]);
  const seenSid = useRef<string | null>(null);
  useEffect(() => {
    if (activeSid) seenSid.current = activeSid;
  }, [activeSid]);
  // "Open in Code" on a session's changes: that session's folder.
  const sessionFolder = useRef<string | null>(null);
  sessionFolder.current = folderOf(recents.find((r) => r.sid === (activeSid ?? lastSid.current)));
  // From Agents, the session itself comes along as a linked tab "from Agents" in Code's column (ide/code-chats.ts linkCodeChat; Arun,
  // 2026-11-19: "ensure code and agent platform can be interconnected and streamlined for easy passing of work"). It stays in
  // Agents' list until "Move to Code".
  const placeRef = useRef({ sid: "" as string | undefined, recents, root: null as string | null, route });
  placeRef.current = { sid: route.kind === "session" ? route.sid : undefined, recents, root: ideRoot, route };
  // `at`: the folder the caller knows the work is in (a lane's own, a pull request's), which the link and Code's root follow.
  const linkSession = (review: boolean, at?: string): boolean => {
    const { sid, recents: list } = placeRef.current;
    const r = sid ? list.find((x) => x.sid === sid) : undefined;
    const folder = at || folderOf(r);
    if (getMode() !== "agents" || !r || !folder) return false;
    setIdeRoot(folder);
    linkCodeChat({ sid: r.sid, invite: r.invite, folder, title: r.alias || r.title || "Untitled", ...(toolsSeen.current.get(r.sid) ? { tool: toolsSeen.current.get(r.sid)! } : {}) });
    if (review) wantReview(folder);
    return true;
  };
  useEffect(() => {
    const on = (e: Event) => {
      const review = !!(e as CustomEvent<{ review?: boolean; folder?: string }>).detail?.review;
      if (linkSession(review, (e as CustomEvent<{ folder?: string }>).detail?.folder)) return;
      // Pressed in Code, on the card of the chat it shows: that chat is already in its folder, so the root stays (it used to go to
      // the folder of whichever session Agents was last on).
      if (getMode() === "code") return void (review && placeRef.current.root && wantReview(placeRef.current.root));
      sessionFolder.current && setIdeRoot(sessionFolder.current);
    };
    addEventListener("friday:code-session-root", on);
    return () => removeEventListener("friday:code-session-root", on);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // ⌘E keeps your place (mode.ts swapMode): from a session in Agents, Code on its folder with its linked tab; from Code, back to
  // Agents where you were, or to the session itself when Code shows a linked chat.
  useEffect(() => {
    const on = (e: Event) => {
      if (!isLocal()) return;
      if (getMode() === "agents") {
        if (!linkSession(false)) return;
        e.preventDefault();
        return void setViewMode("code");
      }
      const { root } = placeRef.current;
      const shown = root ? codeChatFor(root) : null;
      e.preventDefault();
      setViewMode("agents");
      // The linked session, when Agents still has it; one removed or deleted since is dropped, and Agents is where it was.
      if (shown?.linked) {
        if (placeRef.current.recents.some((x) => x.sid === shown.sid)) navigate({ kind: "session", sid: shown.sid, invite: shown.invite });
        else dropLinkedChat(shown.sid);
      }
    };
    addEventListener("friday:swap-mode", on);
    return () => removeEventListener("friday:swap-mode", on);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // "Move to Code" on a linked tab: the session is Code's now and leaves Agents' list.
  useEffect(() => {
    const on = (e: Event) => {
      const sid = (e as CustomEvent<{ sid: string }>).detail?.sid;
      if (!sid) return;
      setRecents((prev) => {
        const next = prev.filter((x) => x.sid !== sid);
        saveRecents(next);
        return next;
      });
    };
    addEventListener("friday:code-moved", on);
    // Undo of Move to Code: the session is Agents' again, at the top of its list.
    const back = (e: Event) => {
      const c = (e as CustomEvent<{ chat?: { sid: string; invite: string; title: string } }>).detail?.chat;
      if (!c) return;
      rememberRef.current({ sid: c.sid, invite: c.invite, title: c.title, role: "owner", openedAt: Date.now() });
    };
    addEventListener("friday:code-handed-back", back);
    return () => (removeEventListener("friday:code-moved", on), removeEventListener("friday:code-handed-back", back));
  }, []);
  // Agents shows a session that has since moved to Code (the route was left on it, or a reload): it has left Agents' list, so Agents
  // goes home. Done where the mode changes, so every way back to Agents (⌘E, the window bar, the Mac menu) is covered.
  useEffect(() => {
    if (viewMode === "agents" && route.kind === "session" && isCodeChat(route.sid)) navigate({ kind: "home" });
  }, [viewMode, route]); // eslint-disable-line react-hooks/exhaustive-deps
  // Anything of Agents' that isn't a session (new session, Crew, Automations, Board…) opened while in Code has nothing to show
  // there: go to Agents so it is seen. Session to session stays in Code, where the root follows.
  const lastKind = useRef(route.kind);
  useEffect(() => {
    const was = lastKind.current;
    lastKind.current = route.kind;
    if (was !== route.kind && route.kind !== "session" && getMode() === "code" && isLocal()) setViewMode("agents");
  }, [route.kind]);
  // Open Folder (⌘O, the palette): the picker over Code.
  const [pickRoot, setPickRoot] = useState(false);
  // Open Folder: the computer's own folder picker in the app, VS Code's own in a browser, never a screen of Friday's (Arun,
  // 2026-11-19: "like i dont want this screen").
  const openFolder = () => {
    const pick = window.fridayDesktop?.pickFolder;
    if (pick) void pick().then((p) => p && setIdeRoot(p), () => {});
    else window.dispatchEvent(new CustomEvent("friday:vsc-run", { detail: "workbench.action.files.openFolder" }));
  };
  // Any folder opens, with or without a session in it: a session's own folder goes back to following the session.
  const openIdeRoot = (folder: string) => {
    setPickRoot(false);
    setIdeRoot(folder);
  };
  useEffect(() => {
    const on = () => openFolder();
    addEventListener("friday:ide-open-folder", on);
    return () => removeEventListener("friday:ide-open-folder", on);
  }, []);
  // VS Code's menus in the Mac menu bar while Code shows (desktop.ts setMenus, src/vscode-menu.ts): Friday's own items here, VS Code
  // commands to VsCodeView (friday:vsc-run), which has the runner run them in VS Code.
  useEffect(() => {
    const desk = window.fridayDesktop;
    if (!desk?.setCodeMenu) return;
    desk.setCodeMenu(inCode, inCode ? ideFolders.slice(0, 10) : []);
    if (!inCode) return;
    const off = desk.onVscMenu?.((item) => {
      if (item.command) window.dispatchEvent(new CustomEvent("friday:vsc-run", { detail: item.command }));
      else if (item.friday === "open-folder") openFolder();
      else if (item.friday === "close-folder" || item.friday === "new-window") setIdeRoot(null);
      else if (item.friday === "open-recent" && item.path) setIdeRoot(item.path);
      else if (item.friday === "new-agent-window") (setViewMode("agents"), navigate({ kind: "home" }));
      else if (item.friday === "agent") window.dispatchEvent(new Event("friday:vsc-agent"));
    });
    return () => off?.();
  }, [inCode, ideFolders]); // eslint-disable-line react-hooks/exhaustive-deps
  // Which coding tool works each session, remembered from when it was seen at work: the chat column names it (and wears its
  // mark) even while it is idle.
  const toolsSeen = useRef<Map<string, string>>(new Map());
  if (inCode || attention.working.size) {
    for (const [sid, w] of attention.working) if (w.tool && toolName(w.tool)) toolsSeen.current.set(sid, w.tool);
  }
  // Code's "New chat": the empty box in its own column, never Agents' new-session page.
  useEffect(() => {
    if (!isLocal()) return;
    const on = (e: Event) => {
      const folder = (e as CustomEvent<{ folder?: string }>).detail?.folder;
      if (folder) showCodeChat(folder, "new");
    };
    addEventListener("friday:ide-new-session", on);
    return () => removeEventListener("friday:ide-new-session", on);
  }, []);
  // What Code's agent column needs of this page (ide/AgentPanel.tsx): a chat's session screen, and the box that starts one. Both
  // are the same as in Agents, but what they start and open is listed in Code (ide/code-chats.ts), not in Agents' sidebar.
  const ideChat = useMemo<IdeChat | null>(() => {
    if (!identity.id) return null;
    return {
      identity,
      chat: (sid, invite) => (
        <SessionView
          key={sid}
          sid={sid}
          invite={invite}
          identity={identity}
          agents={agents}
          onSeen={(e) => updateCodeChat(e.sid, { title: e.title })}
          // Code's chat doesn't share its invites with Agents' header and People (they are another page's).
          onInvites={() => {}}
          plan={planNow(workspace)}
          connections={connections}
          // The IDE has no document column: the chat is all of this column.
          doc={{ open: false, width: 0 }}
          onDocChange={() => {}}
        />
      ),
      start: (folder, quiet) => (
        <Code
          key={quiet ? `quiet:${quiet.id}` : folder}
          identity={identity}
          agents={agents}
          plan={planNow(workspace)}
          defaults={workspace?.defaults}
          preset={{ folder }}
          inColumn
          {...(quiet ? { quiet } : {})}
          onStart={(sid, invite, meta) => addCodeChat({ sid, invite, folder, title: "New chat", at: Date.now(), ...(meta?.tool ? { tool: meta.tool } : {}) }, quiet ? { background: true } : undefined)}
          recents={[]}
        />
      ),
      agentOf: (sid) => toolsSeen.current.get(sid) ?? "",
    };
  }, [identity, agents, workspace, connections]);
  // "new" is the builder with nothing yet; with no agents at all it is the only page there is.
  const selAgent = agentSel === "new" ? null : (agents.find((a) => a.id === agentSel) ?? agents[0] ?? null);
  const agentMenu = (a: AgentView): MenuItem[] => {
    const done = async (f: () => Promise<unknown>) => {
      try {
        await f();
      } finally {
        await reloadAgents();
      }
    };
    return [
      { label: "Duplicate", icon: "copy", onSelect: () => void done(async () => setAgentSel(((await api<{ agent: AgentView }>(identity, `/api/agents/${a.id}/duplicate`, { method: "POST" })).agent.id))) },
      // Its maker left the workspace: an admin may make it theirs (app.ts stewardOf).
      ...(a.mayManage ? [{ label: "Take over", icon: "user" as const, onSelect: () => void done(() => api(identity, `/api/agents/${a.id}/takeover`, { method: "POST" })) }] : []),
      { heading: "" },
      a.access === "owner" || a.mayManage
        ? {
            label: "Delete",
            icon: "trash",
            danger: true,
            onSelect: () =>
              askConfirm({
                title: `Delete ${a.name}?`,
                body: "Sessions already running it keep their own copy, so their work is unaffected. New sessions won't be able to pick it.",
                action: "Delete agent",
                onConfirm: () => done(async () => (await api(identity, `/api/agents/${a.id}`, { method: "DELETE" }), setAgentSel(null))),
              }),
          }
        : {
            label: "Remove from my agents",
            icon: "trash",
            danger: true,
            onSelect: () =>
              askConfirm({
                title: `Remove ${a.name}?`,
                body: `It stays ${a.ownerName}'s agent and nobody else is affected — it just leaves your list.`,
                action: `Remove ${a.name}`,
                onConfirm: () => void done(async () => (await api(identity, `/api/agents/${a.id}/leave`, { method: "POST" }), setAgentSel(null))),
              }),
          },
    ];
  };
  // The sidebar is how you get anywhere now that there is no rail (Dass, 2026-10-19), so it shows on every page until it is folded away.
  // The sidebar's button folds the session list, never the rail of places beside it (Arun, 2026-11-12: "make sure the side bar
  // close thing doesnt close the button rail at all"): in the open-source build at a desktop width the rail stays, as on a place's
  // own page, and only a narrow window, where the sidebar is a sheet over the page, puts the whole of it away.
  // Folded for the side panel while a small window has no room for both (list-yield.ts); never saved.
  const yielded = useSyncExternalStore(listYield.sub, listYield.folded, () => false);
  const listOpen = !layout.sidebarCollapsed && !yielded;
  const keepRail = useSyncExternalStore(wideSub, wideNow, () => false) && isLocal();
  const panelOpen = listOpen || keepRail;
  // The Chat button's own rule, shared with the Mac window's toolbar: on a chat page it folds the list, anywhere else it goes to the chats.
  const toggleChats = () => {
    if (inChat) {
      if (yielded) return listYield.keep();
      setLayout({ sidebarCollapsed: !layout.sidebarCollapsed });
      return;
    }
    navigate({ kind: "home" });
    setLayout({ sidebarCollapsed: false });
  };
  // The sidebar button folds the sidebar, on whatever page (Arun, 2026-10-22: on the Agent Board its first press went to a new
  // session and only the second folded it). The sidebar is the same on every page now there is no rail, so there is no list
  // of chats to go to first.
  const togglePanel = () => (yielded ? listYield.keep() : setLayout({ sidebarCollapsed: !layout.sidebarCollapsed }));
  // A narrow window's sidebar floats over the page, as a drawer: the focus goes into it as it opens and back to its button as it
  // closes, and Escape closes it (2026-10-27 audit: Escape did nothing, and Tab went on into the page behind the scrim).
  useEffect(() => {
    if (!panelOpen || !matchMedia("(max-width: 1000px)").matches) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = () => document.querySelector<HTMLElement>(".sb-panel");
    // Onto the session open, else New session: the first button was Search, whose tip then sat over the Code, Work and Crew tabs
    // and took the first Escape (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
    const t = setTimeout(() => {
      const p = panel();
      if (p && !p.contains(document.activeElement)) (p.querySelector<HTMLElement>(".dass-row[data-sid][aria-current='page']") ?? p.querySelector<HTMLElement>(".sb-new") ?? p.querySelector<HTMLElement>("button, a[href], [tabindex='0']"))?.focus();
    }, 0);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector("[role='menu'], [role='dialog']")) return;
      setLayout({ sidebarCollapsed: true });
    };
    addEventListener("keydown", esc);
    return () => {
      clearTimeout(t);
      removeEventListener("keydown", esc);
      if (opener?.isConnected && (document.activeElement === document.body || panel()?.contains(document.activeElement))) opener.focus();
    };
  }, [panelOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  // These pages fill the window up to the top, like the new-session page; their own content starts below the band.
  // How wide the controls in the band are right now (people, agents, buttons). The title's half of the band stops short of
  // them, so a long title or a repo chip is clipped instead of drawn underneath them; the width changes with who is here.
  useEffect(() => {
    const slot = document.getElementById("band-slot");
    if (!slot || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const ro = new ResizeObserver(() => root.style.setProperty("--slot-w", `${Math.ceil(slot.getBoundingClientRect().width)}px`));
    ro.observe(slot);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--slot-w");
    };
  }, []);

  // Every full page sits under the window's band the same way, so they are all the same height: Usage and Settings were
  // left out, and stood 40px taller than the pages beside them.
  let crewWorkflows = false;
  // Automations: the coding tools' and the crew's workflows as one list, each saying who runs it, made from one New automation; a
  // crew workflow opens in its builder over it (the "Why Crew" plan, 2026-11-13). It was a switch between two pages, Coding tools
  // and Crew workflows (Arun, 2026-11-02: "fix this logic and design it nicely for switching"); the back ends stay apart.
  const automations = () =>
    workflowOpen ? (
      <TeamWorkflowsPage identity={identity} open={workflowOpen} onList={() => setWorkflowOpen(null)} />
    ) : (
      <AutomationsPage
        onWorkflow={(id) => setWorkflowOpen(id ?? "new")}
        identity={identity}
        agents={agents}
        recents={recents}
        onOpen={(sid, invite) => navigate({ kind: "session", sid, invite })}
        onSavedAgents={() => navigate({ kind: "agents" })}
      />
    );
  const fullBleed = crewWorkflows || route.kind === "agents" || route.kind === "automations" || route.kind === "connections" || route.kind === "people" || route.kind === "library" || route.kind === "board" || route.kind === "deepdive" || route.kind === "mcp" || route.kind === "skills" || route.kind === "review" || route.kind === "needs" || route.kind === "usage" || route.kind === "new-teammate" || route.kind === "settings";
  useLayoutEffect(() => {
    if (!fullBleed) return;
    // When the band comes, not only if it is there as this opens: after a reload it came later, and the page stood 12px lower.
    return onBand(() => {
      document.documentElement.dataset.band = "page";
      return () => {
        if (document.documentElement.dataset.band === "page") delete document.documentElement.dataset.band;
      };
    });
  }, [fullBleed]);

  // The quick prompt's window: the box, nothing else (QuickPrompt.tsx).
  if (route.kind === "quick") return <QuickPrompt />;
  // A recording needs no account and no shell: the page is the whole window.
  // The local edition has no sign-in: /api/me not answering means the app on this computer isn't running.
  if (authed === false && isLocal())
    return (
      <div className="page-state" role="alert">
        <p>Friday on this computer isn't answering. Start it again, then reload this page.</p>
      </div>
    );
  return (
    <div className={`shell ${panelOpen && !inCode ? "with-panel" : ""}${inCode ? " in-code" : ""}`}>
      {/* The first thing the keyboard reaches: straight to the page, past the rail and the list. */}
      <a className="skip-link" href="#main">Skip to the page</a>
      {/* Where a session puts its header in the desktop app: the band along the top of the window, which has the room. Fixed, so it takes no place in the grid. */}
      <WindowNav open={inCode ? true : listOpen} onToggle={inCode ? () => ideKey("KeyB") : togglePanel} what={inAgents ? "agents" : "sessions"} working={attention.working.keys()} needs={attention.needSids} code={inCode ? { folder: ideRoot, recent: ideFolders } : undefined} />
      {/* In a browser the sidebar folds by itself on a narrow window, and the window bar's button (WindowNav) is the app's: with
          the sidebar folded there was no way back to it but ⌘B (Arun, 2026-10-24: UX gaps). */}
      {!panelOpen && !window.fridayDesktop && (
        <button type="button" className="nav-open" aria-label="Show the sidebar" title={`Show the sidebar (${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘B" : "Ctrl+B"})`} onClick={togglePanel}>
          <Icon name="sidebar" size={16} />
        </button>
      )}
      <div id="band-left" style={{ position: "fixed" }} />
      <div id="band-slot" style={{ position: "fixed" }} />
      {/* Always drawn: putting the sidebar away only puts the chat list away.
          The rail is how you get anywhere, so it is not the part that leaves,
          and nothing has to float over the page to bring the rest back. */}
      <>
        {identity.id && <PrWatch identity={identity} onOpen={() => navigate({ kind: "review" })} />}
        {/* An agent finished somewhere you weren't looking: a soft sound and a toast that opens it (Herdr's, 2026-11-01). */}
        {identity.id && <DoneToasts activeSid={activeSid} />}
        {/* Every agent blocked on you, across sessions, as toasts that stay until answered or closed. */}
        {/* Connecting the computer a browser is on: one dialog, opened from any "Connect this computer". */}
        {!inCode && <Sidebar
          identity={identity}
          email={email}
          workspace={workspace}
          recents={recents}
          attention={attention}
          projects={projects}
          connections={connections}
          people={people}
          sessionInvites={sessionInvites}
          identityForApi={identity}
          reloadPeople={reloadPeople}
          reloadInbox={reloadInbox}
          agentsCount={agents.length}
          agents={agents}
          agentSel={selAgent?.id ?? null}
          onSelectAgent={setAgentSel}
          onNewAgent={() => setAgentSel("new")}
          onImportAgents={() => setImportingAgents(true)}
          agentMenu={agentMenu}
          activeSid={activeSid}
          // The New teammate page is the Crew's: the sidebar stays as it is on the Crew's home.
          view={route.kind === "new-teammate" ? "home" : route.kind}
          draftProject={route.kind === "home" ? route.projectId : undefined}
          onNew={(projectId) => navigate({ kind: "home", projectId })}
          onOpen={(r) => navigate({ kind: "session", sid: r.sid, invite: r.invite })}
          onOpenAutomations={() => navigate({ kind: "automations" })}
          onOpenAgents={() => {
            if (inAgents) return mac ? undefined : setLayout({ sidebarCollapsed: !layout.sidebarCollapsed });
            navigate({ kind: "agents" });
            setLayout({ sidebarCollapsed: false });
          }}
          onOpenPeople={() => navigate({ kind: "people" })}
          onOpenLibrary={() => navigate({ kind: "library" })}
          onOpenBoard={() => navigate({ kind: "board" })}
          onOpenDeepDive={() => navigate({ kind: "deepdive" })}
          onOpenMcp={isLocal() ? () => navigate({ kind: "mcp" }) : undefined}
          onOpenSkills={isLocal() ? () => navigate({ kind: "skills" }) : undefined}
          onOpenReview={() => navigate({ kind: "review" })}
          onOpenNeeds={() => navigate({ kind: "needs" })}
          reviewsWaiting={reviewPrs?.available ? reviewPrs.review.length : 0}
          onOpenSettings={() => (askPage("settings-search"), navigate({ kind: "settings", section: route.kind === "settings" ? route.section : lastSettings.current }))}
          onOpenUsage={() => navigate({ kind: "usage" })}
          onWarm={warmPage}
          peopleCount={people.length}
          onRename={rename}
          updateRecent={updateRecent}
          removeRecent={removeRecent}
          deleteSession={deleteSession}
          createProject={createProject}
          updateProject={(id, patch) => writeProjects((p) => p.map((x) => (x.id === id ? { ...x, ...patch } : x)))}
          deleteProject={deleteProject}
          panelOpen={panelOpen}
          listOpen={listOpen}
          // From Chat this is the fold button for the list beside it. From
          // anywhere else it is a way back to Chat, with the list showing: a
          // person who clicks Chat wants their chats, whatever they put away
          // the last time they were here.
          onChat={() => (mac && inChat ? undefined : toggleChats())}
          chatToggles={!mac}
        />}
        {/* Only where the list floats over the page, so clicking off it puts it away. */}
        {panelOpen && !inCode && <div className="sb-backdrop" onClick={() => setLayout({ sidebarCollapsed: true })} />}
        {/* Closed, the sidebar is gone, with no rail left in its place: the window's own sidebar button and ⌘B bring it back
            (Arun, 2026-11-03: "have the side bar fully close on close instead of being still there slightly"). */}
      </>
      <main id="main" className="main" tabIndex={-1}>
        {/* Someone new is set up first (this computer, its coding tools, GitHub), not toured: the tour waits behind it. */}
        {identity.id && route.kind === "home" && <Setup identity={identity} recents={recents} onDone={() => requestAnimationFrame(() => document.querySelector<HTMLElement>(".composer textarea, textarea")?.focus())} />}
        {identity.id && <WhatsNew userId={identity.id} />}
        {/* "Keep this going" (crew-carry-open.tsx): the hand-off sheet, the wheel's question and Bring it in, from anywhere. */}
        {identity.id && isLocal() && <KeepGoingHost />}
        {/* A new account's workspace on no paid plan: the plans, in front of everything but a shared session, which stays free to watch. */}

        {/* A page opened before its code has arrived shows its shape, not a blank. */}
        {/* Keyed on the workspace switches: every page is drawn again in the new workspace, and reads its own lists again. */}
        {codeMounted && (
          <div className="code-keep" hidden={!inCode}>
          <Suspense fallback={null}>
            <IdeChatContext.Provider value={ideChat}>
              <CodeSurface identity={identity} sid={null} root={ideRoot} recent={ideFolders} onOpenRoot={openIdeRoot} />
            </IdeChatContext.Provider>
          </Suspense>
          </div>
        )}
        {inCode && pickRoot && (
          <div className="ide-pick" role="dialog" aria-modal="true" aria-label="Open a folder" onMouseDown={(e) => e.target === e.currentTarget && setPickRoot(false)} onKeyDown={(e) => e.key === "Escape" && setPickRoot(false)}>
            <Suspense fallback={null}>
              <IdeRootPicker
                identity={identity}
                recent={ideFolders.map((f) => ({ path: f, name: f.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || f }))}
                onOpen={openIdeRoot}
              />
            </Suspense>
          </div>
        )}
        {!inCode && <Suspense key={switches} fallback={route.kind === "session" ? <SessionSkeleton /> : <PageSkeleton />}>
        {!identity.id ? null : route.kind === "home" ? (
          teamTabOn ? <TeamHome identity={identity} needs={attention.items} onOpen={(r) => navigate({ kind: "session", sid: r.sid, invite: r.invite })} /> :
          <Code
            // Not keyed on the preset: the composer clears it once read, and a key that changed then remounted it empty.
            // Nor on the workspace's defaults: rebuilt when they arrived, it lost the picked folder. Code takes them as they come.
            key={route.agentId ?? ""}
            identity={identity}
            agents={agents}
            plan={planNow(workspace)}
            defaults={workspace?.defaults}
            preset={preset}
            onPresetUsed={() => setPreset(null)}
            initialAgentId={route.agentId}
            {...(route.resume ? { resumeLink: route.resume } : {})}
            onStart={(sid, invite) => {
              // Started from a project's "New session here": filed in it as it opens (Arun, 2026-10-28: "TEST EVERYTHING… EVERY
              // INTERACTION, EVERY VISUAL"; it went to Recent).
              if (route.projectId && projects.some((x) => x.id === route.projectId)) fileInto.current = { sid, projectId: route.projectId };
              navigate({ kind: "session", sid, invite });
            }}
            recents={recents}
            onOpenBoard={() => navigate({ kind: "board" })}
          />
        ) : route.kind === "session" ? (
          <ThreadsCtx.Provider value={threadsData}>
          <SessionView
            key={route.sid}
            onRemove={removeRecent}
            onActions={setSessionActions}
            sid={route.sid}
            invite={route.invite}
            identity={identity}
            agents={agents}
            onSeen={remember}
            overlaps={attention.overlaps.get(route.sid)}
            onOpenSession={(sid, path) => {
              const r = recents.find((x) => x.sid === sid);
              if (!r) return;
              // To the file, not just the session: the Diff panel opens on it once that session has drawn.
              if (path) askToShowDiff(sid, path);
              navigate({ kind: "session", sid, invite: r.invite });
            }}
            onInvites={setSessionInvites}
            plan={planNow(workspace)}
            connections={connections}
            doc={{ open: layout.docOpen, width: layout.docWidth }}
            onDocChange={(d) => setLayout({ ...(d.open !== undefined ? { docOpen: d.open } : {}), ...(d.width !== undefined ? { docWidth: d.width } : {}) })}
          />
          </ThreadsCtx.Provider>
        ) : route.kind === "automations" ? (
          automations()
        ) : route.kind === "board" ? (
          <Board
            solo={planLimits(planNow(workspace)).fridayAgent === "none"}
            identity={identity}
            recents={recents}
            projects={projects}
            needs={attention.needs}
            off={attention.off}
            onOpen={(sid) => {
              const r = recents.find((x) => x.sid === sid);
              // Not a session of the list (a workflow waiting on your OK, a review): the Needs you page, where it is answered.
              if (r) navigate({ kind: "session", sid, invite: r.invite });
              else navigate({ kind: "needs" });
            }}
            onNew={() => toNewSession()}
            onReview={() => navigate({ kind: "review" })}
          />
        ) : route.kind === "deepdive" ? (
          <DeepDivePage identity={identity} />
        ) : route.kind === "mcp" ? (
          <McpServersPage identity={identity} />
        ) : route.kind === "skills" ? (
          <SkillsPage identity={identity} onUse={(brief) => (setPreset({ brief }), toNewSession({ kind: "home" }, true))} />
        ) : route.kind === "review" ? (
          <CodeReview
            identity={identity}
            recents={recents}
            onWork={(brief, opts) => (setPreset({ brief, ...opts }), toNewSession({ kind: "home" }, true))}
            onOpen={(sid, invite) => {
              const r = recents.find((x) => x.sid === sid);
              const link = r?.invite ?? invite;
              if (link) navigate({ kind: "session", sid, invite: link });
            }}
          />
        ) : route.kind === "needs" ? (
          <NeedsYouPage identity={identity} recents={recents} onReview={() => navigate({ kind: "review" })} onBoard={() => navigate({ kind: "board" })} />
        ) : route.kind === "settings" ? (
          <SettingsPage
            identity={identity}
            workspace={workspace}
            section={route.section}
            onSection={(section) => navigate(section === "usage-limits" ? { kind: "usage" } : { kind: "settings", section })}
            onRename={rename}
          />
        ) : route.kind === "usage" ? (
          <UsagePage identity={identity} solo={planLimits(planNow(workspace)).fridayAgent === "none"} />
        ) : route.kind === "new-teammate" ? (
          // Cancel goes back to the Crew room, where a new teammate is asked for.
          <TeammateForm identity={identity} editing={null} onClose={() => (setTeamTab(true), navigate({ kind: "home" }))} />
        ) : null}
        </Suspense>}
      </main>
        {/* After the page in the source, so Tab reaches the page first; they still sit fixed in the bottom-right corner. */}
        {/* Not over the queue itself, which lists the same waits with their answers. */}
        {identity.id && route.kind !== "needs" && <WaitingOnYou identity={identity} items={attention.items} recents={recents} viewing={route.kind === "session" ? route.sid : undefined} onOpen={(r) => navigate({ kind: "session", sid: r.sid, invite: r.invite })} />}
        {/* The daily brief: its notification, /brief's panel, and the brief after a long gap (DailyBrief.tsx). */}
        {identity.id && <DailyBriefHost identity={identity} />}
      {editing && selAgent && (
        <AgentForm
          identity={identity}
          agent={selAgent}
          solo={planLimits(planNow(workspace)).fridayAgent === "none"}
          connections={connections}
          onClose={() => setEditing(false)}
          onSaved={(a) => (void reloadAgents(), setAgentSel(a.id), setEditing(false))}
        />
      )}
      {confirmUI}
      {importingAgents && (
        <AgentImport
          identity={identity}
          existing={agents}
          onClose={() => setImportingAgents(false)}
          onDone={(imported) => {
            setImportingAgents(false);
            void reloadAgents().then(() => imported[0] && setAgentSel(imported[0].id));
          }}
        />
      )}
      {palette && (
        <Palette
          onNew={(q) => {
            // Over Code, the typed words start a Code chat (Agents' thread would start one nobody is looking at).
            if (inCode && ideRoot && ideIsUp()) return void window.dispatchEvent(new CustomEvent("friday:ide-action", { detail: { id: "new-chat", words: q } }));
            toNewSession();
            setTimeout(() => {
              const el = document.getElementById("code-input") as HTMLTextAreaElement | null;
              if (!el) return;
              Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, q);
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.focus();
            }, 0);
          }}
          actions={(inCode && codeActions ? (rest: Action[]) => [...codeActions(ideRoot, recents.length, identity), ...rest] : (rest: Action[]) => rest)(paletteOrder(sessionActions, baseActions({
            recents,
            stateOf: (sid) => (attention.needSids.has(sid) ? "needs" : attention.working.has(sid) ? "working" : unreadAll.has(sid) ? "done" : null),
            open: (r) => (inCode && setViewMode("agents"), navigate({ kind: "session", sid: r.sid, invite: r.invite })),
            newSession: () => {
              toNewSession();
              setTimeout(() => document.getElementById("code-input")?.focus(), 0);
            },
            goto: (where) => (inCode && setViewMode("agents"), where === "settings" && askPage("settings-search"), navigate(where === "settings" ? { kind: "settings", section: settingsSection(null) } : { kind: where })),
            toggleSidebar: () => setLayout({ sidebarCollapsed: !layoutRef.current.sidebarCollapsed }),
            showShortcuts: () => setShortcuts(true),
            search: () => setSearch(true),
            // Friday's own light or dark, as Settings' and the sidebar's do: a colour theme on comes off, or Nord stayed (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
            look: (l) => (readTheme() && applyTheme(null), chooseTheme(l)),
            team: planLimits(planNow(workspace)).team,
            ...(isLocal() ? {} : { newAgent: () => (navigate({ kind: "agents" }), setAgentSel("new")), invite: () => (askPage("invite"), navigate({ kind: "people" })) }),
            local: isLocal(),
            // Over Code, "New chat" (Code's own) is the one that starts something; Agents' would start one nobody is looking at.
          }).filter((a) => !(inCode && ideRoot && ideIsUp() && a.id === "new"))))}
          onClose={() => setPalette(false)}
        />
      )}
      {search && (
        <Suspense fallback={null}>
          <SearchModal recents={recents} onOpen={(r) => navigate({ kind: "session", sid: r.sid, invite: r.invite })} onClose={() => setSearch(false)} />
        </Suspense>
      )}
      {shortcuts && <ShortcutsModal onClose={() => setShortcuts(false)} />}
      <Tooltips />
      {/* Cut, copy and paste on a right-click, in the desktop app, whose window draws no menu of its own (TextMenu.tsx). */}
      <TextMenu />
      <BuildWatch />
      {signOutError && (
        <div className="toast" role="alert">
          {signOutError}
        </div>
      )}
      {/* Always there, so the line is announced as it arrives rather than mounted with its words already in it. Out of the
          shell's grid (.live-notice): as a grid item it opened a second row, and the page, rail and chat list stopped short of
          the window's foot by whatever that row took. */}
      <div className="live-notice" role="status">{notice && !signOutError && <div className="toast">{notice}</div>}</div>
    </div>
  );
}


function ShortcutsModal({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  return (
    <div className="overlay">
      <div className="modal shortcuts" ref={ref} role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div className="pop-head">
          <h2>Keyboard shortcuts</h2>
          <button className="icon-btn tiny" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <ShortcutList />
      </div>
    </div>
  );
}

type LibraryList = "agents" | "skills" | "people" | "connections";

/** A library page before its list has loaded: a loading line, or what went wrong with Try again, never an empty page that
 *  looks like there is nothing. */
function LibraryGate({ state, what, retry, children }: { state: string; what: string; retry: () => void; children: ReactNode }) {
  if (state === "ok") return <>{children}</>;
  return (
    <div className="page">
      {state === "loading" ? (
        <div className="page-state" role="status">
          <span className="spinner" /> Loading {what}…
        </div>
      ) : (
        <div className="page-state" role="alert">
          <p>
            Couldn't load {what}. {state}
          </p>
          <button type="button" className="btn small" onClick={retry}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
