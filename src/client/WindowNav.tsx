import { Icon } from "./icons.js";
import { CodeCrewToggle } from "./WorkMode.js";

/**
 * The chat list's button, Search, and Code or Crew, beside the Mac window's own buttons.
 *
 * The window has no title bar, so what would sit there lives on the page. No back and forward (Arun, 2026-11-03: "get rid of the
 * arrows"): the sidebar and ⌘K reach every page. In their place the open-source edition's switch between Code and Crew, shown
 * while the sidebar is open. Shown in the desktop app, on Mac and Windows alike (the styles key off its classes);
 * elsewhere the page has the browser's own.
 */
export function WindowNav({ open, onToggle, what = "sessions", working, needs }: { open: boolean; onToggle: () => void; what?: "sessions" | "agents"; working?: Iterable<string>; needs?: Iterable<string> }) {
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const key = mac ? "⌘B" : "Ctrl+B";
  const find = mac ? "⌘⇧F" : "Ctrl+Shift+F";
  return (
    <div className="win-nav" role="toolbar" aria-label="Window">
      <button type="button" className={`win-nav-panel ${open ? "on" : ""}`} aria-label={open ? `Hide ${what}` : `Show ${what}`} title={open ? `Hide ${what} (${key})` : `Show ${what} (${key})`} aria-pressed={open} onClick={onToggle}>
        <Icon name="sidebar" size={16} />
      </button>
      {/* Search beside the sidebar's button (Arun, 2026-10-24: "place this next to the side bar close and open button"), where
          it is in reach with the sidebar shut too; the sidebar's own is hidden in the app (style.css .sidebar-search). */}
      <button type="button" aria-label="Search" title={`Search (${find})`} onClick={() => window.dispatchEvent(new Event("friday:search"))}>
        <Icon name="search" size={16} />
      </button>
      {/* Both editions (Arun, 2026-11-04: "add this for production btw"); only while the sidebar is open, since it switches what
          the sidebar lists (Arun, 2026-11-08: "only appear when the side bar is open"). */}
      {window.fridayDesktop && open && <CodeCrewToggle className="in-bar" working={working} needs={needs} />}
    </div>
  );
}
