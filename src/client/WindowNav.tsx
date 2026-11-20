import { Icon } from "./icons.js";
import { CodeCrewToggle } from "./WorkMode.js";
import { isLocal } from "./edition.js";
import { MenuButton, uiZoom, type MenuItem } from "./ui.js";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ideKey, ideParts, setIdeRoot, useMode } from "./ide/mode.js";
import "./ide/agent-panel.css";

/**
 * The chat list's button, Search, and Code or Crew, beside the Mac window's own buttons.
 *
 * The window has no title bar, so what would sit there lives on the page. No back and forward (Arun, 2026-11-03: "get rid of the
 * arrows"): the sidebar and ⌘K reach every page. In their place the open-source edition's switch between Code and Crew, shown
 * while the sidebar is open. Shown in the desktop app, on Mac and Windows alike (the styles key off its classes);
 * elsewhere the page has the browser's own.
 */
export function WindowNav({ open, onToggle, what = "sessions", working, needs, code }: { open: boolean; onToggle: () => void; what?: "sessions" | "agents"; working?: Iterable<string>; needs?: Iterable<string>; /** In Code: the folder it has open, for the bar's quick-open pill. Absent in Agents. */ code?: { folder: string | null; recent?: string[] } }) {
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const key = mac ? "⌘B" : "Ctrl+B";
  const find = mac ? "⌘⇧F" : "Ctrl+Shift+F";
  const [mode, setMode] = useMode();
  const swap = mac ? "⌘E" : "Ctrl+E";
  const parts = useIdeParts(!!code);
  // With real VS Code showing, the sidebar, quick-open and panel buttons would drive Friday's own editor, which is not there: left off.
  // Code is VS Code now (Friday's own editor is gone): its sidebar, quick-open and panel buttons would drive nothing.
  const vsc = !!code;
  const folder = code?.folder?.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  const navRef = useRef<HTMLDivElement>(null);
  useClearBand(navRef);
  const k = mac ? { p: "⌘P", j: "⌘J", chat: "⌘⌥B" } : { p: "Ctrl+P", j: "Ctrl+J", chat: "Ctrl+Alt+B" };
  return (
    <>
    <div ref={navRef} className="win-nav" role="toolbar" aria-label="Window">
      {/* The side bar's button, left of Search, in Code as in Agents (Arun, 2026-11-19: "move the side bar close and open button
          where it is for example on the agent platform"). In Code it is VS Code's side bar. */}
      {vsc ? (
        <button type="button" className="win-nav-panel" aria-label="Toggle the side bar" title={`Toggle the side bar (${key})`} onClick={() => vscCommand("sidebar")}>
          <Icon name="sidebar" size={16} />
        </button>
      ) : (
        <button type="button" className={`win-nav-panel ${(code ? parts.side : open) ? "on" : ""}`} aria-label={(code ? parts.side : open) ? `Hide ${code ? "the side bar" : what}` : `Show ${code ? "the side bar" : what}`} title={(code ? parts.side : open) ? `Hide ${code ? "the side bar" : what} (${key})` : `Show ${code ? "the side bar" : what} (${key})`} aria-pressed={code ? parts.side : open} onClick={onToggle}>
          <Icon name="sidebar" size={16} />
        </button>
      )}
      {/* Search beside the sidebar's button (Arun, 2026-10-24: "place this next to the side bar close and open button"), where
          it is in reach with the sidebar shut too; the sidebar's own is hidden in the app (style.css .sidebar-search). */}
      <button type="button" aria-label="Search" title={`Search (${find})`} onClick={() => window.dispatchEvent(new Event("friday:search"))}>
        <Icon name="search" size={16} />
      </button>
      {/* Agents or Code, after Search, whether or not the sidebar is open (Arun, 2026-11-19: "a toggle for switching back and forth
          with our current ADE to the IDE"). The open-source edition only: the IDE runs on this computer. */}
      {isLocal() && (
        // Pointing at it starts Code loading out of sight (App's friday:code-warm), so the switch finds VS Code on its way.
        <span className="win-nav-mode-wrap" onPointerOver={mode === "agents" ? warmCode : undefined} onFocus={mode === "agents" ? warmCode : undefined}>
        <MenuButton
          className="win-nav-mode"
          label={`View: ${mode === "code" ? "Code" : "Agents"}`}
          // Two words and the shortcut, a narrow menu (Arun, 2026-11-19: "get rid of the secondary text and stuff and make this
          // dropdown smaller please in width").
          width={132}
          items={() => [
            { label: "Agents", icon: "chat", checked: mode === "agents", onSelect: () => setMode("agents") },
            { label: "Code", icon: "code", hint: swap, checked: mode === "code", onSelect: () => setMode("code") },
          ]}
        >
          <Icon name={mode === "code" ? "code" : "chat"} size={14} />
          <span>{mode === "code" ? "Code" : "Agents"}</span>
          <Icon name="chevronDown" size={12} className="win-nav-caret" />
        </MenuButton>
        </span>
      )}
      {/* VS Code's File menu, in Friday's bar (Arun, 2026-11-19: "make it very easy to use these commands", with VS Code's own
          File menu as the list): new, open, the folders opened lately, save, close. Its commands run in VS Code (vscCommand). */}
      {/* Not in the Mac app, whose menu bar has VS Code's own menus in Code (desktop.ts setMenus). */}
      {vsc && !(window.fridayDesktop?.setCodeMenu && window.fridayDesktop.platform === "darwin") && (
        <MenuButton
          className="win-nav-mode win-nav-file"
          label="File"
          width={236}
          items={() => fileMenu(code!.folder, code!.recent ?? [], mac)}
        >
          <span>File</span>
        </MenuButton>
      )}
      {/* Both editions (Arun, 2026-11-04: "add this for production btw"); only while the sidebar is open, since it switches what
          the sidebar lists (Arun, 2026-11-08: "only appear when the side bar is open"). */}
      {/* Not in the open-source build, whose sidebar has Sessions and Agents in its rail (Sidebar.tsx OssRail). */}
      {window.fridayDesktop && open && !isLocal() && <CodeCrewToggle className="in-bar" working={working} needs={needs} />}
    </div>
    {/* Code's half of the bar: the folder's quick-open pill in the middle and the two layout buttons at the right (the mock's
        command centre). Only in the desktop app, where there is a band for them; a browser has ⌘P and the activity bar. */}
    {code && (
      <>
        {/* The folder's search: VS Code's own Go to File, opened in the frame (Arun, 2026-11-19: "the search bar at the top of the
            page needs to be designed and fixed and works properly"). VsCodeView runs it (vscCommand). */}
        <button type="button" className="win-code-find" aria-label={`Search ${folder || "the folder"}, chats and sessions`} title={vsc ? "Search files, chats and sessions" : `Search (${k.p})`} onClick={() => (vsc ? window.dispatchEvent(new Event("friday:code-search")) : ideKey("KeyP"))}>
          <Icon name="search" size={13} />
          <span className="wcf-name">{folder ? <>Search <b>{folder}</b></> : "Search files"}</span>
          {!vsc && <kbd>{k.p}</kbd>}
        </button>
        {/* VS Code's bottom panel and the agent column, at the bar's right (Arun,
            2026-11-19: "we need a button for the bottom panel also fix the sizing and placement of the buttons"). */}
        <div className="win-code-views" role="toolbar" aria-label="Layout">
          <button type="button" aria-label="Toggle the bottom panel" title={`Toggle the panel (${k.j})`} aria-pressed={vsc ? undefined : parts.panel} className={!vsc && parts.panel ? "on" : ""} onClick={() => (vsc ? vscCommand("panel") : ideKey("KeyJ"))}>
            {/* No bottom-panel icon in icons.tsx (its "panel" is the left one): drawn here, in the same 24-grid stroke. */}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2.5" />
              <path d="M3 14.5h18" />
            </svg>
          </button>
          <button type="button" aria-label="Toggle the agent chat" title={`Toggle the agent chat (${k.chat})`} aria-pressed={parts.chat} className={parts.chat ? "on" : ""} onClick={() => ideKey("KeyB", { alt: true })}>
            <Icon name="panelRight" size={16} />
          </button>
        </div>
      </>
    )}
    </>
  );
}

/** The File menu's rows. With no folder open there is no VS Code yet: only opening one. */
function fileMenu(folder: string | null, recent: string[], mac: boolean): MenuItem[] {
  const k = (m: string, w: string) => (mac ? m : w);
  const open = !!folder;
  const name = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
  const others = recent.filter((p) => p !== folder).slice(0, 5);
  return [
    { label: "New Text File", icon: "file", hint: k("⌘N", "Ctrl+N"), disabled: !open, onSelect: () => vscCommand("newTextFile") },
    { label: "New File…", icon: "plus", disabled: !open, onSelect: () => vscCommand("newFile") },
    { label: "Open File…", icon: "file", disabled: !open, onSelect: () => vscCommand("openFile") },
    { label: "Open Folder…", icon: "folder", hint: k("⌘O", "Ctrl+O"), onSelect: () => window.dispatchEvent(new Event("friday:ide-open-folder")) },
    others.length > 0 && { heading: "Open Recent" },
    ...others.map((p): MenuItem => ({ label: name(p), title: p, icon: "folder", onSelect: () => setIdeRoot(p) })),
    open && { heading: "Save" },
    open && { label: "Save", hint: k("⌘S", "Ctrl+S"), onSelect: () => vscCommand("save") },
    open && { label: "Save As…", hint: k("⇧⌘S", "Ctrl+Shift+S"), onSelect: () => vscCommand("saveAs") },
    open && { label: "Save All", hint: k("⌥⌘S", "Ctrl+K S"), onSelect: () => vscCommand("saveAll") },
    open && { label: "Auto Save", onSelect: () => vscCommand("autoSave") },
    open && { label: "Revert File", onSelect: () => vscCommand("revert") },
    open && { heading: "Close" },
    open && { label: "Close Editor", hint: k("⌘W", "Ctrl+W"), onSelect: () => vscCommand("closeEditor") },
    open && { label: "Close Folder", onSelect: () => setIdeRoot(null) },
  ];
}

let warmed = false;
function warmCode() {
  if (warmed) return;
  warmed = true;
  window.dispatchEvent(new Event("friday:code-warm"));
  // Once a while: App lets a warm Code go after a quarter of an hour unused, and a later point should warm it again.
  window.setTimeout(() => (warmed = false), 60_000);
}

/** A layout button or the search pill, for VS Code: VsCodeView, which has the frame and the runner, runs it (vscode.command). */
export type VsCodeCommand = "quickOpen" | "commandCenter" | "reviewChanges" | "openCommit" | "showTasks" | "showStack" | "chatOpen" | "chatClose" | "sidebar" | "panel" | "newTextFile" | "newFile" | "openFile" | "save" | "saveAs" | "saveAll" | "revert" | "autoSave" | "closeEditor" | "askCodebase" | "findBreak" | "refactorAcross" | "searchSymbols" | "searchText";
function vscCommand(name: VsCodeCommand) {
  window.dispatchEvent(new CustomEvent<VsCodeCommand>("friday:vsc-command", { detail: name }));
}

/** Which parts of Code are showing, for the bar's buttons: Code keeps its layout to itself, so this reads the page, a few times a second. */
function useIdeParts(on: boolean) {
  const [parts, setParts] = useState(ideParts);
  useEffect(() => {
    if (!on) return;
    const read = () => setParts((p) => {
      const n = ideParts();
      return n.side === p.side && n.panel === p.panel && n.chat === p.chat ? p : n;
    });
    read();
    const t = window.setInterval(read, 300);
    return () => window.clearInterval(t);
  }, [on]);
  return parts;
}

/**
 * The band beside these buttons (#band-left: a session's tabs, a page's title) starts where they end, measured, never under them
 * (Arun, 2026-11-19: "fix this overlapp", the Agents / Code button over a session's first tab). Its own place is set for each state
 * of the window in style.css; this only pushes its contents along by what the buttons reach past it, and puts it back when they don't.
 */
function useClearBand(navRef: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const nav = navRef.current;
    const band = document.getElementById("band-left");
    if (!nav || !band) return;
    const fit = () => {
      const n = nav.getBoundingClientRect();
      const b = band.getBoundingClientRect();
      // Hidden (the web app), or not on the band's row: nothing to clear.
      const over = n.width && n.bottom > b.top && n.top < b.bottom ? n.right + 10 - b.left : 0;
      const pad = over > 0 ? `${Math.ceil(over / uiZoom())}px` : "";
      if (band.style.paddingLeft !== pad) band.style.paddingLeft = pad;
    };
    fit();
    // The buttons change width with the mode's word; the band changes width whenever its left moves (its right edge is fixed),
    // and padding leaves its border box alone, so this never sets itself off.
    const ro = new ResizeObserver(fit);
    ro.observe(nav, { box: "border-box" });
    ro.observe(band, { box: "border-box" });
    addEventListener("resize", fit);
    return () => {
      ro.disconnect();
      removeEventListener("resize", fit);
      band.style.removeProperty("padding-left");
    };
  }, [navRef]);
}
