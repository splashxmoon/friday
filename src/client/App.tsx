import "./awake.js";
import { AgentImport } from "./AgentImport.js";
import { askPage } from "./intent.js";
import { Tooltips } from "./Tooltips.js";
import { TextMenu } from "./TextMenu.js";
import { BuildWatch } from "./BuildWatch.js";
import type { Role } from "../types.js";
import { lazy, Suspense, type ComponentProps, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isNarrow } from "./narrow.js";
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
  review: () => import("./CodeReview.js"),
  usage: () => import("./UsagePage.js"),
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
const AutomationsPage = lazy(() => pages.automations().then((m) => ({ default: m.AutomationsPage })));
const CodeReview = lazy(() => pages.review().then((m) => ({ default: m.CodeReview })));
import { WindowNav } from "./WindowNav.js";
import { askToShowDiff } from "./focusDiff.js";
import { AgentForm } from "./AgentDialogs.js";
import { SettingsPage, settingsSection } from "./Settings.js";
import { chooseTheme } from "./prefs.js";
const UsagePage = lazy(() => pages.usage().then((m) => ({ default: m.UsagePage })));
import { isLocal, ownModel, planLimits, planNow } from "./edition.js";
import type { SkillTemplate } from "../skill-catalog.js";
import type { WorkspaceUsage } from "./workspace-types.js";
import { Icon } from "./icons.js";
import { Setup } from "./Setup.js";
import { QuickPrompt } from "./QuickPrompt.js";
import { quickText, sendQuickTo, startQuick } from "./quick-send.js";
import { ShortcutList } from "./Shortcuts.js";
import { Palette, baseActions, paletteOrder, type Action } from "./Palette.js";
import { SearchModal } from "./SearchModal.js";
import type { Plan } from "../plan-types.js";
import { Sidebar } from "./Sidebar.js";
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
import { inBand, isTyping, PageSkeleton, SessionSkeleton, useConfirm, useDismiss, type MenuItem } from "./ui.js";
import { WaitingOnYou, askToNotify, useAttention } from "./Attention.js";

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
  | { kind: "review" }
  | { kind: "settings"; section: string }
  | { kind: "usage" };

function readRoute(): Route {
  return parseRoute(location.search);
}

/** The page an app address (its query) names. */
function parseRoute(search: string): Route {
  const p = new URLSearchParams(search);
  // No Connections page any more (Arun, 2026-10-22: "the coding tools already have the mcps connected on their own coding
  // tools"): an old link to it opens the start page.
  if (p.get("view") === "connections") return { kind: "home" };
  if (p.get("view") === "agents") return { kind: "agents" };
  if (p.get("view") === "automations") return { kind: "automations" };
  if (p.get("view") === "people") return { kind: "people" };
  if (p.get("view") === "library") return { kind: "library" };
  if (p.get("view") === "board") return { kind: "board" };
  if (p.get("view") === "review") return { kind: "review" };
  if (p.get("view") === "settings") return { kind: "settings", section: settingsSection(p.get("section")) };
  if (p.get("view") === "usage") return { kind: "usage" };
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
  if (r.kind === "review") return "/?view=review";
  if (r.kind === "settings") return `/?view=settings&section=${encodeURIComponent(r.section)}`;
  if (r.kind === "usage") return "/?view=usage";
  if (r.kind === "quick") return "/?view=quick";
  if (r.kind === "session") return `/?session=${encodeURIComponent(r.sid)}&invite=${encodeURIComponent(r.invite)}`;
  const q = new URLSearchParams();
  if (r.projectId) q.set("project", r.projectId);
  if (r.agentId) q.set("agent", r.agentId);
  return q.size ? `/?${q}` : "/";
}

export function App() {
  // Who you are is whatever /api/me says. Until it answers, nothing is loaded:
  // every call needs the cookie, and a signed-out browser has none.
  const [identity, setIdentity] = useState<Identity>({ id: "", name: "" });
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [email, setEmail] = useState<string | undefined>(undefined);
  /** The workspace in play: its plan decides which models and limits apply. */
  const [workspace, setWorkspace] = useState<WorkspaceUsage | null>(null);
  const [route, setRoute] = useState<Route>(readRoute);
  const [recents, setRecents] = useState<RecentSession[]>(loadRecents);
  // Sessions you are in on the server that this browser has never opened: another machine's, or one a schedule started.
  type Mine = { sessions: { sid: string; title: string; role: Role; invite: string; at: number }[] };
  const reloadMine = useCallback(
    (first = false) =>
      // The page asked already, while the app loaded; if that came back empty-handed (it asked before knowing who you were), ask again.
      ((first && early<Mine>("mine")) || Promise.resolve(null))
        .then((r) => r ?? api<Mine>(identity, "/api/sessions/mine"))
        .then((r) =>
          setRecents((prev) => {
            const known = new Set(prev.map((x) => x.sid));
            const add = r.sessions.filter((s) => !known.has(s.sid)).map((s) => ({ sid: s.sid, title: s.title, invite: s.invite, role: s.role, openedAt: s.at }));
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
  const [connections, setConnections] = useState<McpPublic[]>([]);
  // Where you are the thing that is missing, across every session you know of.
  // On Solo the sessions list says what each one is doing (which tool, and what it is at), not the last thing you typed.
  const attention = useAttention(identity, recents, planLimits(planNow(workspace)).fridayAgent === "none");
  // Asked the first time there is something worth being told about, rather
  // than on launch: a permission prompt before the product has done anything
  // is a prompt people refuse on principle.
  useEffect(() => {
    if (attention.items.length) askToNotify();
  }, [attention.items.length]);
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [collections, setCollections] = useState<CollectionView[]>([]);
  /** What a skill picked on the Skills page hands to the next new session. */
  const [preset, setPreset] = useState<{ brief?: string; grants?: SkillTemplate["grants"]; shepherd?: boolean; repo?: string; tool?: EngineTool } | null>(null);
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

  /** The list as it was saved, while a narrow window has it folded for now (below); null once the person chooses. */
  const keptOpen = useRef<boolean | null>(null);
  const setLayout = useCallback((patch: Partial<Layout>) => {
    if ("sidebarCollapsed" in patch) keptOpen.current = null;
    setLayoutState((l) => {
      const next = { ...l, ...patch };
      saveLayout(keptOpen.current === null ? next : { ...next, sidebarCollapsed: keptOpen.current });
      return next;
    });
  }, []);
  // A narrow or zoomed window opens on the page, with the chat list folded: open, it floats over everything and the
  // page behind it can't be used until it is closed (Testing F-20). The list button and ⌘B bring it back. Not saved, so
  // the same person in a wide window gets the list as they left it.
  useEffect(() => {
    if (!isNarrow(innerWidth)) return;
    setLayoutState((l) => {
      if (l.sidebarCollapsed) return l;
      keptOpen.current = l.sidebarCollapsed;
      return { ...l, sidebarCollapsed: true };
    });
  }, []);

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
        if (d?.trafficLightY) root.classList.add("lights-low");
        setMac(true);
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
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      root.classList.remove("desktop", "desktop-mac", "lights-low", "drag-nudge", "drag-debug");
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
    const onPop = () => setRoute(readRoute());
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback(
    (r: Route) => {
      history.pushState(null, "", routeUrl(r));
      setRoute(r);
      if (r.kind !== "session") document.title = r.kind === "connections" ? "Connections · Friday" : r.kind === "agents" ? "Saved agents · Friday" : r.kind === "automations" ? "Automations · Friday" : r.kind === "settings" ? "Settings · Friday" : r.kind === "usage" ? "Usage · Friday" : r.kind === "review" ? "Code Review · Friday" : "Friday";
      if (isNarrow(innerWidth)) setLayout({ sidebarCollapsed: true });
    },
    [setLayout],
  );

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
      // Asked for a section by name: land on its heading. Asked for Settings: land in its search.
      askPage(tab ? "settings-section" : "settings-search");
      navigate({ kind: "settings", section: settingsSection(tab ?? lastSettings.current) });
    };
    addEventListener("friday:settings", on);
    // The Usage page, from anywhere (the home page's "tokens saved" line).
    const usage = () => navigate({ kind: "usage" });
    addEventListener("friday:usage", usage);
    return () => {
      removeEventListener("friday:settings", on);
      removeEventListener("friday:usage", usage);
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
          navigate({ kind: "home" });
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
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
    addEventListener("keydown", onKey);
    addEventListener("friday:palette", onPalette);
    addEventListener("friday:shortcuts", onShortcuts);
    return () => {
      removeEventListener("keydown", onKey);
      removeEventListener("friday:palette", onPalette);
      removeEventListener("friday:search", onSearch);
      removeEventListener("friday:shortcuts", onShortcuts);
    };
  }, [navigate, setLayout]);

  // ── sidebar data ──
  const remember = useCallback(
    (entry: RecentSession) => {
      setRecents((prev) => {
        const old = prev.find((x) => x.sid === entry.sid);
        const next = [
          {
            ...old,
            ...entry,
            projectId: entry.projectId ?? old?.projectId,
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
  // A fork is filed straight under the chat it came from (the list is newest first, so one tick older), and not opened.
  useEffect(() => {
    const on = (e: Event) => {
      const f = (e as CustomEvent<{ from: string; sid: string; invite: string; title: string }>).detail;
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
      const r = loadRecents().find((x) => x.sid === (e as CustomEvent<{ sid: string }>).detail.sid);
      if (r) navigate({ kind: "session", sid: r.sid, invite: r.invite });
    };
    window.addEventListener("friday:open-session", on);
    return () => window.removeEventListener("friday:open-session", on);
  }, [navigate]);
  const updateRecent = (sid: string, patch: Partial<RecentSession>) =>
    setRecents((prev) => {
      const next = prev.map((x) => (x.sid === sid ? { ...x, ...patch } : x));
      saveRecents(next);
      return next;
    });
  const dropRecents = (sids: string[]) =>
    setRecents((prev) => {
      const next = prev.filter((x) => !sids.includes(x.sid));
      if (next.length === prev.length) return prev;
      saveRecents(next);
      return next;
    });
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
  // The session somebody was last working in: where the Team library's "Use as context" puts a brief.
  const lastSession = useRef<{ sid: string; invite: string } | null>(null);
  if (route.kind === "session") lastSession.current = { sid: route.sid, invite: route.invite };
  // The chat list belongs to Chat. It sits beside the rail for a chat or the
  // new-chat page and is gone everywhere else, where there is nothing to list;
  // folding it away is a preference of its own, kept for when you come back.
  const inChat = route.kind === "home" || route.kind === "session";
  const inAgents = route.kind === "agents";
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
      { heading: "" },
      a.access === "owner"
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
  const panelOpen = !layout.sidebarCollapsed;
  // The Chat button's own rule, shared with the Mac window's toolbar: on a chat page it folds the list, anywhere else it goes to the chats.
  const toggleChats = () => {
    if (inChat) {
      setLayout({ sidebarCollapsed: !layout.sidebarCollapsed });
      return;
    }
    navigate({ kind: "home" });
    setLayout({ sidebarCollapsed: false });
  };
  // The sidebar button folds the sidebar, on whatever page (Arun, 2026-10-22: on the Agent Board its first press went to a new
  // session and only the second folded it). The sidebar is the same on every page now there is no rail, so there is no list
  // of chats to go to first.
  const togglePanel = () => setLayout({ sidebarCollapsed: !layout.sidebarCollapsed });
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
  const fullBleed = route.kind === "agents" || route.kind === "automations" || route.kind === "connections" || route.kind === "people" || route.kind === "library" || route.kind === "board" || route.kind === "review" || route.kind === "usage" || route.kind === "settings";
  useLayoutEffect(() => {
    if (!fullBleed || !inBand()) return;
    document.documentElement.dataset.band = "page";
    return () => {
      if (document.documentElement.dataset.band === "page") delete document.documentElement.dataset.band;
    };
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
    <div className={`shell ${panelOpen ? "with-panel" : ""}`}>
      {/* The first thing the keyboard reaches: straight to the page, past the rail and the list. */}
      <a className="skip-link" href="#main">Skip to the page</a>
      {/* Where a session puts its header in the desktop app: the band along the top of the window, which has the room. Fixed, so it takes no place in the grid. */}
      <WindowNav open={panelOpen} onToggle={togglePanel} what={inAgents ? "agents" : "sessions"} />
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
        {/* Every agent blocked on you, across sessions, as toasts that stay until answered or closed. */}
        {/* Connecting the computer a browser is on: one dialog, opened from any "Connect this computer". */}
        <Sidebar
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
          view={route.kind}
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
          onOpenReview={() => navigate({ kind: "review" })}
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
          // From Chat this is the fold button for the list beside it. From
          // anywhere else it is a way back to Chat, with the list showing: a
          // person who clicks Chat wants their chats, whatever they put away
          // the last time they were here.
          onChat={() => (mac && inChat ? undefined : toggleChats())}
          chatToggles={!mac}
        />
        {/* Only where the list floats over the page, so clicking off it puts it away. */}
        {panelOpen && <div className="sb-backdrop" onClick={() => setLayout({ sidebarCollapsed: true })} />}
      </>
      <main id="main" className="main" tabIndex={-1}>
        {/* Someone new is set up first (this computer, its coding tools, GitHub), not toured: the tour waits behind it. */}
        {identity.id && route.kind === "home" && <Setup identity={identity} hasHistory={recents.length > 0} onDone={() => requestAnimationFrame(() => document.querySelector<HTMLElement>(".composer textarea, textarea")?.focus())} />}

        {/* A page opened before its code has arrived shows its shape, not a blank. */}
        {/* Keyed on the workspace switches: every page is drawn again in the new workspace, and reads its own lists again. */}
        <Suspense key={switches} fallback={route.kind === "session" ? <SessionSkeleton /> : <PageSkeleton />}>
        {!identity.id ? null : route.kind === "home" ? (
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
            onStart={(sid, invite) => navigate({ kind: "session", sid, invite })}
            recents={recents}
            onOpenBoard={() => navigate({ kind: "board" })}
          />
        ) : route.kind === "session" ? (
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
        ) : route.kind === "automations" ? (
          <AutomationsPage
            identity={identity}
            agents={agents}
            recents={recents}
            onOpen={(sid, invite) => navigate({ kind: "session", sid, invite })}
            onSavedAgents={() => navigate({ kind: "agents" })}
          />
        ) : route.kind === "board" ? (
          <Board
            solo={planLimits(planNow(workspace)).fridayAgent === "none"}
            identity={identity}
            recents={recents}
            projects={projects}
            onOpen={(sid) => {
              const r = recents.find((x) => x.sid === sid);
              if (r) navigate({ kind: "session", sid, invite: r.invite });
            }}
            onNew={() => navigate({ kind: "home" })}
          />
        ) : route.kind === "review" ? (
          <CodeReview
            identity={identity}
            recents={recents}
            onWork={(brief, opts) => (setPreset({ brief, ...opts }), navigate({ kind: "home" }))}
            onOpen={(sid) => {
              const r = recents.find((x) => x.sid === sid);
              if (r) navigate({ kind: "session", sid, invite: r.invite });
            }}
          />
        ) : route.kind === "settings" ? (
          <SettingsPage
            identity={identity}
            workspace={workspace}
            section={route.section}
            onSection={(section) => navigate({ kind: "settings", section })}
            onRename={rename}
          />
        ) : route.kind === "usage" ? (
          <UsagePage identity={identity} solo={planLimits(planNow(workspace)).fridayAgent === "none"} />
        ) : null}
        </Suspense>
      </main>
        {/* After the page in the source, so Tab reaches the page first; they still sit fixed in the bottom-right corner. */}
        {identity.id && <WaitingOnYou identity={identity} items={attention.items} recents={recents} viewing={route.kind === "session" ? route.sid : undefined} onOpen={(r) => navigate({ kind: "session", sid: r.sid, invite: r.invite })} />}
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
            navigate({ kind: "home" });
            setTimeout(() => {
              const el = document.getElementById("code-input") as HTMLTextAreaElement | null;
              if (!el) return;
              Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, q);
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.focus();
            }, 0);
          }}
          actions={paletteOrder(sessionActions, baseActions({
            recents,
            open: (r) => navigate({ kind: "session", sid: r.sid, invite: r.invite }),
            newSession: () => {
              navigate({ kind: "home" });
              setTimeout(() => document.getElementById("code-input")?.focus(), 0);
            },
            goto: (where) => (where === "settings" && askPage("settings-search"), navigate(where === "settings" ? { kind: "settings", section: settingsSection(null) } : { kind: where })),
            toggleSidebar: () => setLayout({ sidebarCollapsed: !layoutRef.current.sidebarCollapsed }),
            showShortcuts: () => setShortcuts(true),
            search: () => setSearch(true),
            look: (l) => chooseTheme(l),
            team: planLimits(planNow(workspace)).team,
            newAgent: () => (navigate({ kind: "agents" }), setAgentSel("new")),
            invite: () => (askPage("invite"), navigate({ kind: "people" })),
          }))}
          onClose={() => setPalette(false)}
        />
      )}
      {search && <SearchModal recents={recents} onOpen={(r) => navigate({ kind: "session", sid: r.sid, invite: r.invite })} onClose={() => setSearch(false)} />}
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
