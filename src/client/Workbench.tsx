import { iosFolders } from "./ios-folders.js";
import { Activity as Keep, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { SessionState } from "../session/projection.js";
import type { Member, SessionEvent } from "../types.js";
import type { Send } from "./useSession.js";
import { MAIN_LANE } from "../types.js";
import { driverOf } from "../session/projection.js";
import { api } from "./api.js";
import { FilesPanel } from "./Engine.js";
import { showDiffSoon } from "./focusDiff.js";
import { Icon, type IconName } from "./icons.js";
import { AgentsHub } from "./AgentsHub.js";
import { hostApi } from "./local.js";
import { PreviewPanel, useBackgroundTasks, usePreviewInfo } from "./Preview.js";
import { TasksPanel } from "./Tasks.js";
import { isLocal } from "./edition.js";
import { RulesPanel } from "./RulesPanel.js";
import { commandsIn, TerminalPanel } from "./Terminal.js";
import { TreePanel } from "./Tree.js";
import { GitPanel } from "./GitPanel.js";
import type { Identity } from "./storage.js";
import { ContextMenu, MenuButton, relTime } from "./ui.js";
import { sourcesIn } from "./WorkPanels.js";
import { isWorkSid } from "./WorkMode.js";

/**
 * The workbench: everything a coding run produced, behind one set of tabs.
 *
 * It used to be three panels that replaced each other, which meant checking a
 * diff against a failing command was a round trip through a menu each way.
 * Tabs are the same components the artifacts panel already uses, so this reads
 * as the same piece of furniture rather than a new one — and the tab you were
 * last on is where it opens next time.
 *
 * Overview comes first because the question people actually arrive with is
 * "what has this thing done to my machine?", and answering it needs a
 * sentence, not four panels to cross-reference.
 */
export type Tab = "agents" | "overview" | "tree" | "files" | "git" | "terminal" | "preview" | "usage" | "rules";

export const TAB_LABEL: Record<Tab, string> = {
  agents: "Agents", overview: "Tasks", tree: "Tree", files: "Diff", git: "Git", terminal: "Terminal", preview: "Preview", usage: "Usage", rules: "Rules",
  ...(isLocal() ? { preview: "Browser" } : {}), // the agents browse in it too (local/desktop-browser.ts)
};
/** The panels in the side panel's card, in the order people reach for them. */
// Usage is the workspace's allowance and what each run cost on it: the hosted Friday's, so not offered in the local edition.
const PANEL_ORDER: Tab[] = (["overview", "files", "git", "terminal", "preview", "tree", "agents", "usage", "rules"] as Tab[]).filter((t) => t !== "usage" || !isLocal());
/** What each panel holds, under its name in the card. */

const PANEL_SAYS: Record<Tab, string> = {
  overview: "What's running and what finished",
  files: "The changes the agents made",
  git: "Stage, commit, pull and the branch's history",
  terminal: "A shell in the agents' folder",
  preview: "The app as it runs",
  tree: "The project's files",
  agents: "Who is here and what each is doing",
  usage: "Tokens, limits and what each run cost",
  rules: "Instructions every agent follows",
  ...(isLocal() ? { preview: "Your pages and the web, where the agents browse too" } : {}),
};
const TAB_ICON: Record<Tab, IconName> = {
  agents: "agent", overview: "list", tree: "folderOpen", files: "file", git: "gitBranch", terminal: "terminalSquare", preview: "play", usage: "chart", rules: "book",
  ...(isLocal() ? { preview: "webBrowser" as IconName } : {}),
};

/**
 * A panel's room, said as a size the stylesheet can read.
 *
 * The panels are dragged from a few hundred pixels to nearly a thousand, and shared with a second panel beside or below them, so
 * the window's width says nothing about how much room a panel has: only the panel does. This measures the body the panel is drawn
 * in and writes it down as `data-size`: xs under 380px, sm under 520, md under 760, lg above. It follows a drag as it happens.
 * Set on the element directly, not in state, so dragging does not redraw the panel it is measuring.
 *
 * A container query would be the usual way, but one makes its element the containing block for anything positioned inside it,
 * and menus opened from a panel are placed against the window.
 */
export const sizeOf = (width: number): "xs" | "sm" | "md" | "lg" => (width < 380 ? "xs" : width < 520 ? "sm" : width < 760 ? "md" : "lg");

/**
 * The open panels' tab row, when it holds more than it shows: the one showing is scrolled into view (it was left at the row's
 * start cut to "ee" or "gents"), a vertical wheel moves along it, and its edges fade where tabs go on past them (2026-10-28 QA;
 * Arun: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
 */
function useTabRow(tab: string, count: number) {
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!row) return;
    const edges = () => {
      // Too many to name them all: the ones not showing keep only their icon (named on hover), rather than names cut to "D" or
      // "Br." (2026-10-28 QA). Measured from each name's whole width, so it holds steady as it switches.
      const tabs = [...row.querySelectorAll<HTMLElement>(".bench-tab")];
      const named = tabs.reduce((n, t) => {
        const name = t.querySelector<HTMLElement>(".bench-tab-name");
        return n + t.offsetWidth + (name ? name.scrollWidth - name.clientWidth : 0) + 2;
      }, row.querySelector<HTMLElement>(".bench-add")?.offsetWidth ?? 0);
      row.toggleAttribute("data-compact", named > row.clientWidth + 1);
      const over = row.scrollWidth > row.clientWidth + 1;
      row.toggleAttribute("data-more-before", over && row.scrollLeft > 1);
      row.toggleAttribute("data-more-after", over && row.scrollLeft + row.clientWidth < row.scrollWidth - 1);
    };
    const wheel = (e: WheelEvent) => {
      if (row.scrollWidth <= row.clientWidth + 1 || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      e.preventDefault();
      row.scrollLeft += e.deltaY;
    };
    const sizes = new ResizeObserver(edges);
    sizes.observe(row);
    for (const c of row.children) sizes.observe(c);
    row.addEventListener("scroll", edges, { passive: true });
    row.addEventListener("wheel", wheel, { passive: false });
    edges();
    return () => {
      sizes.disconnect();
      row.removeEventListener("scroll", edges);
      row.removeEventListener("wheel", wheel);
    };
  }, [row, count]);
  useLayoutEffect(() => {
    const on = row?.querySelector<HTMLElement>(".bench-tab.on");
    if (!row || !on) return;
    const a = on.getBoundingClientRect().left - row.getBoundingClientRect().left + row.scrollLeft;
    if (a < row.scrollLeft) row.scrollLeft = a;
    else if (a + on.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollLeft = a + on.offsetWidth - row.clientWidth;
  }, [row, tab, count]);
  return setRow;
}

function SizedBody({ children, className = "" }: { children: ReactNode; className?: string }) {
  const el = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    const set = () => {
      // Put away (width 0): it keeps the size it had, and is measured again when it is shown.
      if (!node.clientWidth) return;
      const size = sizeOf(node.clientWidth);
      if (node.dataset.size !== size) node.dataset.size = size;
    };
    set();
    const ro = new ResizeObserver(set);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);
  return (
    <div className={`bench-body ${className}`} ref={el}>
      {children}
    </div>
  );
}

/** Put away with CSS alone: Activity would take down their effects, and with them the webview's page and the xterm screen. */
const CSS_ONLY = new Set<Tab>(["preview", "terminal"]);

/**
 * Every panel that has been looked at, kept for as long as the workbench is.
 *
 * Going to the Diff and back used to draw the Preview again from nothing: the page reloaded, lost its route and its scroll,
 * and flashed blank while it did. So a panel is drawn the first time it is shown, and from then on it is only placed: on
 * top, second, or put away, by class. Each is a child of this one parent for good, which is what lets swapping the two,
 * picking another second panel, or closing and opening the split leave every panel as it was.
 *
 * Put away, the light panels sit in Activity: what they hold stays, their effects (clocks, listeners, fetches) stop. The
 * Preview and the Terminal are only hidden, told so by `on`, and keep quiet themselves.
 */
export function KeptPanels({
  tab,
  second,
  shown,
  arrange,
  splitAt,
  head,
  render,
}: {
  tab: Tab;
  second: Tab | null;
  /** The workbench is open: closed, every panel is put away. */
  shown: boolean;
  arrange: "below" | "beside";
  splitAt: number;
  /** The second panel's grip and header, drawn beside the panels rather than around one. */
  head?: ReactNode;
  render: (t: Tab, on: boolean) => ReactNode;
}) {
  const seen = useRef(new Set<Tab>()).current;
  if (shown) {
    seen.add(tab);
    if (second) seen.add(second);
  }
  return (
    <div className={`bench-stack ${second ? arrange : ""}`} style={{ "--split": `${splitAt}%` } as CSSProperties}>
      {[...seen].map((t) => {
        const slot = t === tab ? "top" : t === second ? "split" : "off";
        const on = shown && slot !== "off";
        return (
          <SizedBody key={t} className={slot}>
            {CSS_ONLY.has(t) ? render(t, on) : <Keep mode={on ? "visible" : "hidden"}>{render(t, on)}</Keep>}
          </SizedBody>
        );
      })}
      {second && head}
    </div>
  );
}

/**
 * History where the workbench goes, and the workbench. Opened once, the workbench stays drawn and is only hidden (its `open`)
 * when it is closed or History takes its place, so its panels, the Preview's page above all, are as they were when it opens
 * again. A session it was never opened in never draws it. History shows only while the workbench is closed.
 */
export function BenchOrHistory({ bench, history, children }: { bench: boolean; history?: ReactNode; children: ReactNode }) {
  const drawn = useRef(false);
  if (bench) drawn.current = true;
  return (
    <>
      {!bench && history}
      {drawn.current && children}
    </>
  );
}

/**
 * The narrowest the chat is let get. Narrower than this, the message box wrapped its own controls onto a second row and the
 * conversation read a few words a line. The panel stops at what leaves the chat this much, and only when the row hasn't room
 * for both (a small window) does it lie over the chat instead.
 */
const chatRoom = (row: HTMLElement | null) => (row?.querySelector(".split-cols") ? 760 : 520);

/**
 * How wide the panel may be, dragged or saved: what its row has past the chat's narrowest, never under 320px of its own. Over
 * the chat (no room for both) it may take the row less a margin. The same limit on a saved width keeps a panel dragged wide on
 * one window from covering the chat on a smaller one.
 */
const maxWidthIn = (row: HTMLElement | null) => {
  const width = row?.clientWidth ?? innerWidth;
  const spare = width - chatRoom(row);
  return Math.max(320, spare < 320 ? width - 48 : spare);
};

/** The kinds of event that one agent owns, so another agent's panels leave them out. */
const LANE_SCOPED = new Set<string>(["agent.message", "tool.result", "folder.ran", "agent.diff"]);

export function Workbench({
  state,
  events,
  identity,
  sid,
  invite,
  me,
  send,
  tab,
  onTab,
  width,
  onWidth,
  onClose,
  openFile,
  lane,
  headless = false,
  addAgent,
  open = true,
  badges,
  onHistory,
  picking = false,
  onPick,
  onPicker,
}: {
  /** Showing the card of panels in place of a panel (SessionView decides when): `onPick` opens one, `onPicker` goes back to it. */
  picking?: boolean;
  onPick?: (t: Tab) => void;
  onPicker?: () => void;
  /** What the panels hold, on their buttons in the card: the diff's count, and whether an agent is working. */
  badges?: { files: number; working: boolean };
  /** The session's history, which is a panel of its own beside these: opened from the card too. */
  onHistory?: () => void;
  /** Open. Closed, it stays drawn but hidden, so its panels are as they were when it opens again. */
  open?: boolean;
  /** The menu for adding an agent, for the Agents hub's header. */
  addAgent?: ReactNode;
  /** Its tabs are in the session's header (Solo): its own row is a slim one, its name and its buttons (top right, where a panel's close is). */
  headless?: boolean;
  state: SessionState;
  events: SessionEvent[];
  /** The agent the panels are about, when the chat is split: they follow whichever column is active. */
  lane?: string;
  identity: Identity;
  sid: string;
  invite: string;
  me: Member;
  send: Send;
  tab: Tab;
  onTab: (t: Tab) => void;
  width: number;
  onWidth: (w: number) => void;
  onClose: () => void;
  /** A file asked for from outside, such as a diff card: the tree opens on it. */
  openFile?: { path: string; line?: number; at: number } | null;
}) {
  // What belongs to one agent is only that agent's; the rest of the log is the session's.
  const laneEvents = useMemo(() => (lane ? events.filter((e) => !LANE_SCOPED.has(e.body.type) || (e.lane ?? MAIN_LANE) === lane) : events), [events, lane]);
  const facts = useFacts(state, laneEvents, lane);
  // Where else the agents are working, for an iOS app outside the session's folder (ios-folders.ts). The recent log is enough.
  const repoPath = facts.repo?.path ?? "";
  const iosElsewhere = useMemo(() => iosFolders(events.slice(-3000), repoPath, Object.values(state.engines).map((e) => e.cwd ?? "")), [events, repoPath, state.engines]);
  // The same people who may steer may run something themselves.
  // Which file a problem row asked for. Stamped, so pressing the same row
  // twice opens it again rather than looking like nothing happened.
  const [jump, setJump] = useState<{ path: string; line?: number; at: number } | null>(null);
  useEffect(() => {
    if (openFile) setJump(openFile);
  }, [openFile]);
  // The command the Tasks list pointed at, for the Terminal to open on.
  const [focusCmd, setFocusCmd] = useState<{ id: string; at: number } | null>(null);
  // A file asked for from the hub: asked of the Diff panel until it has drawn and taken it, and no longer once this is gone.
  const diffAsk = useRef(() => {});
  useEffect(() => () => diffAsk.current(), []);
  // The dev server for this folder, for the Tasks list. Quiet when there's no folder.
  const devCwd = facts.uploaded ? null : (facts.repo?.path ?? null);
  const stopDev = async () => {
    try {
      if (devCwd) await hostApi(identity, "/api/runner/preview.stop", { method: "POST", body: JSON.stringify({ cwd: devCwd }) });
      else await api(identity, `/api/sessions/${sid}/preview.stop`, { method: "POST", body: JSON.stringify({}) });
    } catch {
      // Still running is what the list will go on saying.
    }
    // The list asks again now, not at its next quiet look.
    window.dispatchEvent(new Event("friday:preview"));
  };
  const canDrive = me.role === "owner" || driverOf(state, MAIN_LANE)?.id === me.id || !driverOf(state, MAIN_LANE);
  // A second panel under the first. Stacked rather than side by side: this is
  // a column beside the conversation, and two of anything across it is two
  // things too narrow to read.
  const [split, setSplit] = useState<Tab | null>(null);
  // The panels open as tabs along the header, as a browser's pages do (Arun, 2026-10-24: "if i click plus sign and i choose
  // diff a tab will appear next to the tasks tab in the panel header"): + adds one beside the one showing, the name of the one
  // showing swaps it for another, and each closes on its own. Kept per session; the panel showing is always among them,
  // however it was opened (the status bar, a shortcut, a card in the chat), added at the end when it wasn't.
  const tabsKey = `friday.panel.tabs.${sid}`;
  const [openTabs, setOpenTabs] = useState<Tab[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(tabsKey) ?? "[]") as unknown;
      return Array.isArray(v) ? (v.filter((t) => typeof t === "string" && t in TAB_LABEL) as Tab[]) : [];
    } catch {
      return [];
    }
  });
  const keepTabs = (next: Tab[]) => {
    // Every panel may be open at once: there are eight or nine, and the row shrinks the others to their icons and then scrolls.
    // A cap of six closed the oldest without a word, so Git and Terminal vanished when a seventh was added (2026-10-29 verify).
    const trimmed = [...new Set(next)];
    setOpenTabs(trimmed);
    try {
      localStorage.setItem(tabsKey, JSON.stringify(trimmed));
    } catch {}
  };
  const tabs = openTabs.includes(tab) ? openTabs : [...openTabs, tab];
  useEffect(() => {
    if (!openTabs.includes(tab)) keepTabs([...openTabs, tab]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  /** The panel picked from the name of the one showing: it takes that one's place, or is gone to where it is already open. */
  const swapTab = (t: Tab) => {
    if (!tabs.includes(t)) keepTabs(tabs.map((x) => (x === tab ? t : x)));
    onPick?.(t);
  };
  /** The panel picked from +: a tab of its own beside the one showing, or gone to where it is already open. */
  const addTab = (t: Tab) => {
    if (!tabs.includes(t)) {
      const at = tabs.indexOf(tab) + 1;
      keepTabs([...tabs.slice(0, at), t, ...tabs.slice(at)]);
    }
    onPick?.(t);
  };
  const closeTab = (t: Tab) => {
    const i = tabs.indexOf(t);
    const rest = tabs.filter((x) => x !== t);
    keepTabs(rest);
    if (t !== tab) return;
    // The neighbour takes its place, the one after it first; the last one closed leaves the card of every panel.
    const next = rest[i] ?? rest[i - 1];
    if (next) onPick?.(next);
    else onPicker?.();
  };
  // The panels this session offers, and every one a second panel can be.
  let order: Tab[] = PANEL_ORDER;
  let every = Object.keys(TAB_LABEL) as Tab[];
  let closeLabel = "Close workbench";
  // A Work session keeps what it made in its rail (WorkRail.tsx), not here, and isn't offered the panels about code (there is no
  // diff of a post): the side panel is its Browser, and the agents' own.
  const work = !!state.options.work;
  if (work) closeLabel = "Close the browser";
  order = work ? ["preview"] : PANEL_ORDER;
  every = order;
  // Its one panel is the Browser (Arun, 2026-10-27: "get rid of the plus buttons and logic for the side panel stuff it should only
  // be browser"): whatever else was open goes, and anything asking for another panel gets the Browser.
  useEffect(() => {
    if (!work) return;
    if (openTabs.length !== 1 || openTabs[0] !== "preview") keepTabs(["preview"]);
    // Not as the panel Code sessions open on next: Work's Browser is its own, never everyone's default (Arun, 2026-10-28: "iron
    // everything and ensure we are good… any logic errors").
    if (tab !== "preview") {
      let was: string | null = null;
      try {
        was = localStorage.getItem("mpa.bench");
      } catch {
        // A preference.
      }
      onPick?.("preview");
      try {
        if (was === null) localStorage.removeItem("mpa.bench");
        else localStorage.setItem("mpa.bench", was);
      } catch {
        // As above.
      }
    }
    if (split) setSplit(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [work, tab, openTabs.join(), split]);
  // The second panel, unless it has been made the first (picked from the session's header).
  const second = split && split !== tab ? split : null;
  // Both are only drawn in the Tasks list, so they are only asked for while it is showing; the Preview tab asks for its own.
  const tasksShown = open && (tab === "overview" || second === "overview");
  const dev = usePreviewInfo(identity, tasksShown ? devCwd : null, tasksShown ? sid : null, 3000);
  const bgTasks = useBackgroundTasks(identity, tasksShown ? devCwd : null);
  // Below, or beside. Remembered: it is how somebody likes to read, not a choice about one session.
  const [arrange, setArrangeNow] = useState<"below" | "beside">(() => {
    try {
      return localStorage.getItem("mpa.benchArrange") === "beside" ? "beside" : "below";
    } catch {
      return "below";
    }
  });
  const setArrange = (a: "below" | "beside") => {
    setArrangeNow(a);
    try {
      localStorage.setItem("mpa.benchArrange", a);
    } catch {
      // A preference; losing it costs nothing.
    }
  };
  const [splitMenu, setSplitMenu] = useState<{ x: number; y: number } | null>(null);
  // How much of the panel the lower half takes, as a percentage: a fraction
  // survives the panel itself being resized, which a pixel height would not.
  const [splitAt, setSplitAt] = useState(45);
  const [w, setW] = useState(width);
  useEffect(() => setW(width), [width]);
  const aside = useRef<HTMLElement>(null);
  // How wide the row is that the panel shares with the chat, kept up to date as the window or the sidebar changes it.
  const [row, setRow] = useState(0);
  useEffect(() => {
    const el = aside.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setRow(el.clientWidth));
    ro.observe(el);
    setRow(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  // Taking the whole width: the expand button in the header, and back again with the same button.
  const [full, setFull] = useState(false);
  const rowEl = aside.current?.parentElement ?? null;
  // Over the chat only when the row hasn't room for both; otherwise beside it, and the chat keeps its narrowest.
  const over = full || (row > 0 && row - chatRoom(rowEl) < 320);
  /**
   * No room beside the chat (a small window, Team chat open): the panel takes the whole row, as if expanded, with a named
   * way back. It used to leave a 48px strip of chat beside it, too narrow to read and easy to take for a crushed column.
   */
  const cover = over && !full;
  const shown = Math.min(w, maxWidthIn(rowEl));
  // Docked beside the chat, the panel says where its left edge is (--bench-edge: from the window's right), so on a Mac the
  // session's header buttons can sit just before it while it runs up to the top of the window (style.css, .bench-docked).
  useLayoutEffect(() => {
    const el = aside.current;
    const root = document.documentElement;
    const off = () => {
      root.classList.remove("bench-docked");
      root.style.removeProperty("--bench-edge");
    };
    if (!el || !open || over) return off();
    // Where it rests, not where its slide-in (bench-in, 14px from the right) has it this frame: measured mid-slide, as it was
    // when a session opened with the panel already up, the header's buttons were left 14px too far right, against the panel,
    // since a transform changes no size and nothing measured again.
    const set = () => {
      const t = getComputedStyle(el).transform;
      const moved = t && t !== "none" ? new DOMMatrixReadOnly(t).m41 : 0;
      root.style.setProperty("--bench-edge", `${Math.max(0, Math.round(innerWidth - (el.getBoundingClientRect().left - moved)))}px`);
    };
    set();
    root.classList.add("bench-docked");
    const ro = new ResizeObserver(set);
    ro.observe(el);
    addEventListener("resize", set);
    el.addEventListener("animationend", set);
    return () => {
      ro.disconnect();
      removeEventListener("resize", set);
      el.removeEventListener("animationend", set);
      off();
    };
  }, [open, over]);
  const tabRow = useTabRow(tab, tabs.length);
  // Closed from over the chat (Back to chat, Escape), the focus goes back to whatever opened the panel. Noted before the
  // chat goes inert below, since the opener can be in the chat (a diff card, a file chip).
  const opener = useRef<HTMLElement | null>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (open) {
      const a = document.activeElement;
      opener.current = a instanceof HTMLElement && !aside.current?.contains(a) ? a : null;
    } else if (refocus.current) {
      refocus.current = false;
      if (opener.current?.isConnected) opener.current.focus();
    }
  }, [open]);
  // While the panel covers the chat, the chat can't be reached by Tab (focus would go somewhere unseen); it keeps its
  // scroll, since nothing is unmounted. Opened over the chat, or covering the chat that has the focus, the focus goes to
  // "Back to chat", so it is never left on something inert and Escape works at once.
  const back = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  // An opening waits for the row to be measured: the first time the panel opens it mounts with no width known, so it only
  // learns a moment later that it covers the chat. Until then the focus move is held, and dropped once it is known that the
  // panel sits beside the chat instead (so a later shrink of the window doesn't steal the focus).
  const pending = useRef(false);
  useEffect(() => {
    const me = aside.current;
    const covered = [...(me?.parentElement?.children ?? [])].filter((c) => c !== me);
    const on = open && (cover || full);
    const a = document.activeElement;
    const focusIn = on && covered.some((c) => c.contains(a));
    for (const c of covered) c.toggleAttribute("inert", on);
    if (open && !wasOpen.current) pending.current = true;
    if (!open) pending.current = false;
    if (open && cover && (pending.current || focusIn)) {
      back.current?.focus();
      pending.current = false;
    } else if (open && row > 0) pending.current = false;
    wasOpen.current = open;
    return () => covered.forEach((c) => c.removeAttribute("inert"));
  }, [open, cover, full, row]);
  const backToChat = () => {
    refocus.current = true;
    setFull(false);
    onClose();
  };
  // Two panels across need more room than one: widen the workbench to fit them, never past what the window allows.
  const widenForTwo = () => {
    const want = Math.min(maxWidthIn(rowEl), 780);
    if (w < want) {
      setW(want);
      onWidth(want);
    }
  };

  // A diff is wider than a chat column wants to be, and a terminal wider
  // still: the same drag handle the artifacts panel has, for the same reason.
  const startResize = (e: ReactPointerEvent) => {
    const panel = (e.currentTarget as HTMLElement).parentElement;
    if (!panel) return;
    const startX = e.clientX;
    const startW = shown;
    const max = maxWidthIn(panel.parentElement);
    drag(
      e,
      "x",
      startW,
      (ev) => Math.min(max, Math.max(320, startW + startX - ev.clientX)),
      (v) => void (panel.style.width = `${v}px`),
      (v) => {
        setW(v);
        onWidth(v);
        setFull(false);
      },
    );
  };

  /** Drag the seam between the two halves, whichever way they are laid out. */
  const startSplit = (e: ReactPointerEvent) => {
    const container = (e.currentTarget as HTMLElement).parentElement;
    const lower = container?.querySelector<HTMLElement>(":scope > .bench-body.split");
    if (!lower || !container) return;
    const across = arrange === "beside";
    const start = across ? e.clientX : e.clientY;
    const startSize = across ? lower.getBoundingClientRect().width : lower.getBoundingClientRect().height;
    // A track percentage resolves against the container's content box —
    // not its border box, and not the half being dragged.
    const cs = getComputedStyle(container);
    const total = across ? container.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) : container.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (total <= 0) return;
    drag(
      e,
      across ? "x" : "y",
      splitAt,
      // Anchored to the grab, not to the pointer's absolute position: taking
      // the position outright made the seam snap under the cursor on the
      // first move, by however far into the 9px grip you took hold of it.
      (ev) => Math.min(80, Math.max(20, ((startSize + start - (across ? ev.clientX : ev.clientY)) / total) * 100)),
      (v) => container.style.setProperty("--split", `${v}%`),
      setSplitAt,
    );
  };

  // Room in each header beside the panel's name for that panel's own switch (the Preview's Web / iOS), filled through a portal.
  const [headSlot, setHeadSlot] = useState<HTMLElement | null>(null);
  const [secondSlot, setSecondSlot] = useState<HTMLElement | null>(null);

  // A second panel, and closing: in this panel's header, or (Solo) beside the tabs in the session's header.
  const actions = (
        <span className="bench-tab-actions">
          {/* Which two panels, and whether they sit one above the other or side by side, is a choice, so the button is a menu. */}
          <button
            type="button"
            className={`icon-btn tiny split-btn ${split ? "on" : ""}`}
            title="Show two panels"
            aria-label="Show two panels"
            aria-haspopup="menu"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setSplitMenu(splitMenu ? null : { x: r.right - 220, y: r.bottom + 4 });
            }}
          >
            <Icon name="columns" size={15} />
            <Icon name="chevronDown" size={11} />
          </button>
          {splitMenu && (
            <ContextMenu
              at={splitMenu}
              onClose={() => setSplitMenu(null)}
              items={() => {
                const all = every;
                return [
                  { heading: split ? "Second panel" : "Add a second panel" },
                  ...(split ? [{ label: "Just one panel", icon: "x" as const, onSelect: () => setSplit(null) }] : []),
                  ...all.filter((t) => t !== tab).map((t) => ({
                    label: TAB_LABEL[t],
                    icon: TAB_ICON[t],
                    checked: split === t,
                    onSelect: () => {
                      setSplit(t);
                      if (arrange === "beside") widenForTwo();
                    },
                  })),
                  ...(split
                    ? [
                        { heading: "Layout" },
                        { label: "Stacked", icon: "panel" as const, checked: arrange === "below", onSelect: () => setArrange("below") },
                        {
                          label: "Side by side",
                          icon: "columns" as const,
                          checked: arrange === "beside",
                          onSelect: () => {
                            setArrange("beside");
                            widenForTwo();
                          },
                        },
                        { label: "Swap the two", icon: "refresh" as const, onSelect: () => (onTab(split), setSplit(tab)) },
                      ]
                    : []),
                ];
              }}
            />
          )}
          {!cover && <button
            type="button"
            className="icon-btn tiny"
            title={full ? "Back to its own width" : "Use the whole width"}
            aria-label={full ? "Back to its own width" : "Use the whole width"}
            aria-pressed={full}
            onClick={() => setFull((v) => !v)}
          >
            <Icon name={full ? "shrink" : "expand"} size={14} />
          </button>}
          {/* Over the chat, "Back to chat" leading the header is the one way back; a second control for it would be noise. */}
          {!cover && (
            <button className="icon-btn tiny" title={closeLabel === "Close workbench" ? "Close" : closeLabel} aria-label={closeLabel} onClick={onClose}>
              <Icon name="x" size={15} />
            </button>
          )}
        </span>
  );

  return (
    <aside
      ref={aside}
      hidden={!open}
      className={`doc-panel bench-panel ${headless ? "headless" : ""} ${over ? "over" : ""} ${full || cover ? "full" : ""}`}
      style={full || cover ? undefined : { width: shown }}
      aria-label="Workbench"
      // Escape hands the row back to the chat, but only once nothing nearer wants it: a terminal's own program, a field with
      // something typed in it (a search, a comment, the file editor; an empty one lets Escape through), or a menu, list or
      // dialog the key was pressed in. Those listen on the document, after this, and mostly don't mark the key as used, so
      // this steps aside. Judged by where the key was pressed (menus portalled out of the panel still bubble here through
      // React), so a popover elsewhere on the page can't take Escape away from the panel.
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        if (!cover || e.key !== "Escape" || e.defaultPrevented) return;
        if (t.closest(".xterm, [contenteditable='true'], [role='menu'], [role='listbox'], [role='dialog']:not(.bench-panel)")) return;
        // Only a field that is typed into holds the key while it has words in it (a checkbox, radio or slider never does);
        // an open select keeps it for its own list.
        const typed = t.closest("textarea, input:is(:not([type]), [type=text], [type=search], [type=url], [type=email], [type=password], [type=tel], [type=number])") as HTMLInputElement | HTMLTextAreaElement | null;
        if (t.closest("select") || (typed && typed.value !== "")) return;
        backToChat();
      }}
    >
      <div
        className="resizer"
        onPointerDown={startResize}
        onDoubleClick={() => {
          setFull(false);
          onWidth(560);
        }}
        title="Drag to resize · double-click to reset"
      />
      {(
        <div className="art-tabs bench-tabs">
          {/* The five are in the session's header, where they are the way in.
              A second copy here was the same row twice. */}
          {cover && (
            <button ref={back} type="button" className="btn ghost small bench-back" onClick={backToChat}>
              <Icon name="arrowLeft" size={13} />
              Back to chat
            </button>
          )}
          {picking ? (
            <span className="bench-here">
              <Icon name="sidePanel" size={13} />
              Panels
            </span>
          ) : onPicker ? (
            <div className="bench-tabrow" role="tablist" aria-label="Open panels" ref={tabRow}>
              {tabs.map((t) => (
                <span key={t} className={`bench-tab${t === tab ? " on" : ""}`}>
                  {t === tab ? (
                    // The name of the one showing is a menu of every panel: the one picked takes its place (Arun, 2026-10-24:
                    // "whichever one the user selects ... will replace the panel screen they are on").
                    <MenuButton
                      className="bench-here bench-here-btn"
                      label="Switch this panel"
                      width={280}
                      items={() => [
                        { heading: "Show here instead" },
                        ...order.map((p) => ({ label: TAB_LABEL[p], icon: TAB_ICON[p], sub: PANEL_SAYS[p], checked: p === tab, onSelect: () => swapTab(p) })),
                        onHistory && { label: "History", icon: "clock" as const, sub: "Wind the session back to any point", onSelect: onHistory },
                      ]}
                    >
                      <Icon name={TAB_ICON[t]} size={13} />
                      {TAB_LABEL[t]}
                      <Icon name="chevronDown" size={12} className="bench-here-caret" />
                    </MenuButton>
                  ) : (
                    <button type="button" role="tab" aria-selected={false} className="bench-tab-btn" title={`${TAB_LABEL[t]} · ${PANEL_SAYS[t]}`} onClick={() => onPick?.(t)} onAuxClick={(e) => e.button === 1 && closeTab(t)}>
                      <Icon name={TAB_ICON[t]} size={13} />
                      <span className="bench-tab-name">{TAB_LABEL[t]}</span>
                    </button>
                  )}
                  {tabs.length > 1 && (
                    <button type="button" className="bench-tab-x" aria-label={`Close ${TAB_LABEL[t]}`} title={`Close ${TAB_LABEL[t]}`} onClick={() => closeTab(t)}>
                      <Icon name="x" size={11} />
                    </button>
                  )}
                </span>
              ))}
              {/* + opens another panel as a tab beside this one. */}
              <MenuButton
                className="bench-add"
                icon="plus"
                label="Open another panel"
                width={280}
                items={() => [
                  { heading: "Open in a new tab" },
                  ...order.map((p) => ({ label: TAB_LABEL[p], icon: TAB_ICON[p], sub: PANEL_SAYS[p], checked: tabs.includes(p), onSelect: () => addTab(p) })),
                  onHistory && { label: "History", icon: "clock" as const, sub: "Wind the session back to any point", onSelect: onHistory },
                  onPicker && { label: "All panels", icon: "sidePanel" as const, sub: "The card of every panel", onSelect: onPicker },
                ]}
              />
            </div>
          ) : (
            <span className="bench-here">
              <Icon name={TAB_ICON[tab]} size={13} />
              {TAB_LABEL[tab]}
            </span>
          )}
          <span className="bench-head-slot" ref={setHeadSlot} />
          {!picking && actions}
        </div>
      )}
      {picking && (
        <div className="bench-picker">
          <nav className="bench-picker-card" aria-label="Panels">
            {order.map((t) => (
              <button key={t} type="button" className="bench-picker-item" onClick={() => onPick?.(t)}>
                <span className="bench-picker-icon">
                  <Icon name={TAB_ICON[t]} size={16} />
                </span>
                <span className="bench-picker-text">
                  <span className="bench-picker-name">{TAB_LABEL[t]}</span>
                  <span className="bench-picker-sub">{PANEL_SAYS[t]}</span>
                </span>
                {t === "files" && !!badges?.files && <i className="bench-switch-n">{badges.files > 999 ? "999+" : badges.files}</i>}
                {t === "overview" && badges?.working && <i className="bench-switch-dot" aria-label="running" />}
              </button>
            ))}
            {onHistory && (
              <button type="button" className="bench-picker-item" onClick={onHistory}>
                <span className="bench-picker-icon">
                  <Icon name="clock" size={16} />
                </span>
                <span className="bench-picker-text">
                  <span className="bench-picker-name">History</span>
                  <span className="bench-picker-sub">Wind the session back to any point</span>
                </span>
              </button>
            )}
          </nav>
        </div>
      )}
      <KeptPanels
        tab={tab}
        second={second}
        shown={open && !picking}
        arrange={arrange}
        splitAt={splitAt}
        render={panel}
        head={
          second && (
            <>
              <div
                className="split-grip"
                onPointerDown={startSplit}
                onDoubleClick={() => setSplitAt(45)}
                role="separator"
                aria-orientation={arrange === "beside" ? "vertical" : "horizontal"}
                aria-label="Resize the second panel"
                title="Drag to resize · double-click to reset"
              />
              <div className="art-tabs bench-tabs split-tabs">
                <span className="bench-here">
                  <Icon name={TAB_ICON[second]} size={13} />
                  {TAB_LABEL[second]}
                </span>
                <span className="bench-head-slot" ref={setSecondSlot} />
                <button className="icon-btn tiny split-x" title="Close this panel" aria-label="Close the second panel" onClick={() => setSplit(null)}>
                  <Icon name="x" size={13} />
                </button>
              </div>
            </>
          )
        }
      />
    </aside>
  );

  /** One tab's panel. Both halves draw through this, so they cannot drift apart. `on`: it is showing. */
  function panel(which: Tab, on: boolean) {
    if (which === "agents")
      return (
        <AgentsHub
          state={state}
          events={events}
          me={me}
          send={send}
          identity={identity}
          addAgent={addAgent}
          // A file in the hub opens in the Diff panel, brought into view there; without one, the panel itself.
          onOpenDiff={(path) => {
            onTab("files");
            if (!path) return;
            diffAsk.current();
            diffAsk.current = showDiffSoon(path, [0, 350, 900, 1700]);
          }}
        />
      );
    if (which === "overview")
      return (
        <TasksPanel
          state={state}
          events={events}
          onTab={onTab}
          me={me}
          send={send}
          preview={dev}
          onStopPreview={() => void stopDev()}
          background={bgTasks.tasks}
          onStopBackground={(id) => void bgTasks.stop(id)}
          // A command is shown where it can be read: the Terminal, on that one.
          onOpenCommand={(id) => {
            setFocusCmd({ id, at: Date.now() });
            if (second !== "terminal" && tab !== "terminal") onTab("terminal");
          }}
        />
      );
    if (which === "rules") return <RulesPanel state={state} sid={sid} invite={invite} me={me} send={send} {...(lane ? { lane } : {})} />;
    if (which === "tree") return <TreePanel state={state} events={laneEvents} {...(lane ? { lane } : {})} sid={sid} invite={invite} onClose={onClose} bare send={send} me={me} jump={jump} />;
    if (which === "git") return <GitPanel state={state} sid={sid} invite={invite} send={send} me={me} {...(lane ? { lane } : {})} />;
    if (which === "files") return <FilesPanel state={state} events={events} {...(lane ? { lane } : {})} onClose={onClose} bare ship={{ me, sid, invite, send }} />;
    // An uploaded folder has no path on anybody's machine, so the session
    // is what names it. Passing the prose "12 files uploaded to this
    // session" as a cwd is what used to happen, and it previewed nothing.
    if (which === "preview" && work) return <PreviewPanel headSlot={which === tab ? headSlot : which === second ? secondSlot : null} shown={on} identity={identity} cwd={null} sid={sid} invite={invite} send={send} onClose={onClose} bare asNote={me.role === "viewer" || !canDrive} work suggest={sourcesIn(events, state).flatMap((x) => (x.url ? [{ url: x.url, title: x.title ?? "" }] : []))} />;
    if (which === "preview") return <PreviewPanel headSlot={which === tab ? headSlot : which === second ? secondSlot : null} shown={on} identity={identity} cwd={facts.uploaded ? null : (facts.repo?.path ?? null)} iosElsewhere={iosElsewhere} sid={sid} invite={invite} send={send} onClose={onClose} bare onOutput={() => onTab("overview")} asNote={me.role === "viewer" || !canDrive} />;
    return (
      <TerminalPanel
        events={laneEvents}
        onClose={onClose}
        bare
        send={send}
        canRun={canDrive}
        cwd={facts.repo?.path}
        sid={sid}
        invite={invite}
        focus={focusCmd}
        // An error is a place in the code, so pressing it goes there rather
        // than leaving you to retype the path into the tree. With the tree
        // already open below, it lands there without taking this panel away.
        onOpenFile={(path, line) => {
          setJump({ path, ...(line ? { line } : {}), at: Date.now() });
          if (second !== "tree" && tab !== "tree") onTab("tree");
        }}
      />
    );
  }
}

interface Facts {
  repo: { name: string; branch?: string; path: string; host: string; mode?: string } | null;
  /** A folder uploaded here rather than a machine someone connected. */
  uploaded: boolean;
  /** Whether the machine holding it is connected right now. */
  online: boolean;
  /** What the tree tile can say before the tree itself has been read. */
  treeHint: string;
  changed: number;
  added: number;
  removed: number;
  commands: number;
  failed: number;
  lastFailure: { command: string; output?: string; ts: number } | null;
  lastCommand: { command: string; ts: number; ok: boolean } | null;
  /** The last few commands, newest first, for the overview's own list. */
  recent: { command: string; ts: number; ok: boolean }[];
  agents: { name: string; state: string }[];
}

/** Everything the overview says, read once from what the session already holds. */
function useFacts(state: SessionState, events: SessionEvent[], lane?: string): Facts {
  return useMemo(() => {
    const rows = commandsIn(events);
    const failures = rows.filter((r) => r.isError);
    const last = rows[rows.length - 1];
    const lastFail = failures[failures.length - 1];
    const diffs = lane ? [state.diffs[lane]].filter((d): d is NonNullable<typeof d> => !!d) : Object.values(state.diffs);
    const files = diffs.flatMap((d) => d.files);
    const e = (lane && state.engines[lane]) || state.engines[MAIN_LANE] || Object.values(state.engines)[0];
    return {
      // A connected machine, or the folder somebody uploaded — the panels
      // answer "where is this work happening" either way.
      repo: e
        ? { name: e.cwd.split("/").filter(Boolean).pop() ?? e.cwd, branch: e.branch, path: e.cwd, host: e.hostName, mode: e.mode }
        : state.upload
          ? { name: state.upload.name, path: `${state.upload.files} files uploaded to this session`, host: "Friday", mode: "edits" }
          : null,
      uploaded: !e && !!state.upload,
      online: !!e?.online,
      treeHint: state.upload ? String(state.upload.files) : "···",
      changed: files.length,
      // The diff carries the hunks, so the counts come from the same place the
      // file list does rather than from a second source that can disagree.
      added: files.reduce((n, f) => n + (f.additions ?? 0), 0),
      removed: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
      commands: rows.length,
      failed: failures.length,
      lastFailure: lastFail ? { command: lastFail.command, output: lastFail.output, ts: lastFail.ts } : null,
      lastCommand: last ? { command: last.command, ts: last.ts, ok: !last.isError } : null,
      recent: rows.slice(-4).reverse().map((r) => ({ command: r.command, ts: r.ts, ok: !r.isError })),
      agents: Object.values(state.engines).map((x) => ({ name: x.hostName, state: x.online ? "online" : "offline" })),
    };
  }, [state, events, lane]);
}

/**
 * What this run has done, in the order people ask about it: where it is
 * working, what it changed, what it ran, and what broke. Every line is a way
 * into the tab that has the detail, so the overview is a map rather than a
 * dead end.
 */
function Overview({ facts, onTab }: { facts: Facts; onTab: (t: Tab) => void }) {
  const f = facts;
  return (
    <div className="doc-scroll bench-overview">
      {!f.repo ? (
        <p className="muted small">
          No folder here yet. Attach one with the folder button in the composer and it becomes a working copy the agent can read and edit — or connect a machine from the session header, which also allows running commands.
        </p>
      ) : (
        <>
          <div className="bench-where">
            <div className="bench-repo">
              <Icon name={f.uploaded ? "folderOpen" : "folder"} size={15} />
              <span className="bench-repo-name">{f.repo.name}</span>
              {f.repo.branch && <span className="chip-mini">{f.repo.branch}</span>}
              <span className="bench-where-actions">
                {/* The path is the thing people paste into a terminal, so it
                    is one click rather than a careful drag-select. */}
                <button type="button" className="icon-btn tiny" title="Copy the path" aria-label="Copy the path" onClick={() => void navigator.clipboard?.writeText(f.repo!.path)}>
                  <Icon name="copy" size={13} />
                </button>
                <button type="button" className="icon-btn tiny" title="Browse the files" aria-label="Browse the files" onClick={() => onTab("tree")}>
                  <Icon name="list" size={13} />
                </button>
              </span>
            </div>
            <div className="muted small mono bench-path" title={f.repo.path}>
              {f.repo.path}
            </div>
            <div className="bench-facts">
              <span className={`bench-mode m-${f.repo.mode ?? "plan"}`}>
                {f.uploaded ? "Uploaded to this session · no shell" : f.repo.mode === "full" ? "Auto · edits and runs commands" : f.repo.mode === "edits" ? "Manual · asks before running commands" : "Plan · reads nothing else"}
              </span>
              {!f.uploaded && (
                <span className={`bench-host ${f.online ? "on" : ""}`}>
                  <span className="bench-host-dot" />
                  {f.repo.host}
                  {f.online ? "" : " · offline"}
                </span>
              )}
            </div>
          </div>

          <div className="bench-stats">
            <button type="button" className="bench-stat" onClick={() => onTab("tree")}>
              <span className="bench-stat-n">{f.treeHint}</span>
              <span className="bench-stat-l">the folder</span>
              <span className="bench-stat-sub">browse it</span>
            </button>
            {/* A tile is a fact about this run. Before anything has been
                changed or run there is no fact, and a greyed-out "0 files
                changed" is a slot reserved for one — so the tile waits until
                there is something to say. */}
            {f.changed > 0 && (
              <button type="button" className="bench-stat" onClick={() => onTab("files")}>
                <span className="bench-stat-n">{f.changed}</span>
                <span className="bench-stat-l">files changed</span>
                <span className="bench-stat-sub">
                  <span className="add">+{f.added}</span> <span className="del">−{f.removed}</span>
                </span>
              </button>
            )}
            {f.commands > 0 && (
              <button type="button" className="bench-stat" onClick={() => onTab("terminal")}>
                <span className="bench-stat-n">{f.commands}</span>
                <span className="bench-stat-l">commands run</span>
                <span className={`bench-stat-sub ${f.failed ? "del" : ""}`}>{f.failed ? `${f.failed} failed` : "all fine"}</span>
              </button>
            )}
            <button type="button" className="bench-stat go" onClick={() => onTab("preview")}>
              <span className="bench-stat-n">
                <Icon name="play" size={18} />
              </span>
              <span className="bench-stat-l">Run it</span>
              <span className="bench-stat-sub">see the project</span>
            </button>
          </div>

          {f.lastFailure && (
            <div className="bench-fail">
              <div className="bench-fail-head">
                <Icon name="x" size={13} />
                Last failure · {relTime(f.lastFailure.ts)} ago
                {/* The two things anybody does with a failure: paste the
                    command somewhere, or paste the error to someone. */}
                <span className="bench-fail-actions">
                  <button type="button" className="icon-btn tiny" title="Copy the command" aria-label="Copy the command" onClick={() => void navigator.clipboard?.writeText(f.lastFailure!.command)}>
                    <Icon name="copy" size={12} />
                  </button>
                  {f.lastFailure.output && (
                    <button type="button" className="icon-btn tiny" title="Copy the output" aria-label="Copy the output" onClick={() => void navigator.clipboard?.writeText(f.lastFailure!.output!)}>
                      <Icon name="download" size={12} />
                    </button>
                  )}
                </span>
              </div>
              <code className="term-cmd">$ {f.lastFailure.command}</code>
              {f.lastFailure.output && <pre className="bench-fail-out">{f.lastFailure.output.slice(-600)}</pre>}
              <button type="button" className="link-btn" onClick={() => onTab("terminal")}>
                Open the terminal
              </button>
            </div>
          )}

          {/* The last few commands, so "what has it been doing" is answered
              here rather than by opening another tab to find out. */}
          {f.recent.length > 0 && (
            <div className="bench-recent">
              <div className="bench-recent-head">Recently run</div>
              {f.recent.map((r) => (
                <button key={`${r.ts}-${r.command}`} type="button" className={`bench-recent-row ${r.ok ? "" : "bad"}`} onClick={() => onTab("terminal")} title={r.command}>
                  <Icon name={r.ok ? "check" : "x"} size={12} />
                  <code>{r.command}</code>
                  <span className="muted">{relTime(r.ts)}</span>
                </button>
              ))}
            </div>
          )}

          {f.agents.length > 1 && (
            <p className="muted small">
              {f.agents.length} machines are attached: {f.agents.map((a) => `${a.name} (${a.state})`).join(", ")}.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** The tab a session opens on: the one you left it on, else the last one you used anywhere. */
export function useTab(sid = ""): [Tab, (t: Tab) => void] {
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const v = localStorage.getItem(`mpa.bench.${sid}`) ?? localStorage.getItem("mpa.bench");
      return v && v in TAB_LABEL ? (v as Tab) : "overview";
    } catch {
      return "overview";
    }
  });
  return [
    tab,
    (t: Tab) => {
      setTab(t);
      try {
        let everyone = true;
        everyone = !isWorkSid(sid); // a Work session's Browser is its own, not the panel Code sessions open on
        if (everyone) localStorage.setItem("mpa.bench", t);
        if (sid) localStorage.setItem(`mpa.bench.${sid}`, t);
      } catch {
        // A preference, not state: losing it costs nothing.
      }
    },
  ];
}

/**
 * One drag of one seam, in one direction.
 *
 * Three things keep a seam under the pointer instead of trailing behind it.
 * The grip captures the pointer, so the terminal or the preview iframe it is
 * dragged across cannot swallow the moves and strand the seam halfway. The new
 * size is written straight to the node, at most once a frame, so a fast drag is
 * not a backlog of renders arriving late. And React is told once, at the end:
 * re-rendering a terminal on every mouse move is most of what made this heavy.
 */
function drag(
  e: ReactPointerEvent,
  axis: "x" | "y",
  from: number,
  at: (ev: PointerEvent) => number,
  paint: (v: number) => void,
  commit: (v: number) => void,
): void {
  e.preventDefault();
  const grip = e.currentTarget as HTMLElement;
  grip.setPointerCapture(e.pointerId);
  document.body.classList.add("resizing", `resizing-${axis}`);
  let cur = from;
  let frame = 0;
  const move = (ev: PointerEvent) => {
    cur = at(ev);
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      paint(cur);
    });
  };
  const up = () => {
    grip.removeEventListener("pointermove", move);
    grip.removeEventListener("pointerup", up);
    grip.removeEventListener("pointercancel", up);
    if (frame) cancelAnimationFrame(frame);
    document.body.classList.remove("resizing", `resizing-${axis}`);
    commit(cur);
  };
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", up);
  grip.addEventListener("pointercancel", up);
}
