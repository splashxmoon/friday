import { useEffect, useState } from "react";
import { Icon } from "./icons.js";

/**
 * Back, forward and the chat list, beside the Mac window's own buttons.
 *
 * The window has no title bar, so what a browser would put there lives on the page: the arrows walk the pages somebody has
 * been on, in the order they were opened, and the last button shows or hides the chat list. Shown in the desktop app, on Mac and
 * Windows alike (the styles key off its classes); elsewhere the page has the browser's own.
 */
export function WindowNav({ open, onToggle, what = "sessions" }: { open: boolean; onToggle: () => void; what?: "sessions" | "agents" }) {
  const [can, setCan] = useState({ back: true, forward: false });
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const key = mac ? "⌘B" : "Ctrl+B";
  const find = mac ? "⌘⇧F" : "Ctrl+Shift+F";

  // Chromium says whether there is anywhere to go. Where it does not, both stay pressable: going nowhere is harmless.
  useEffect(() => {
    const nav = (window as unknown as { navigation?: { canGoBack: boolean; canGoForward: boolean; addEventListener: (t: string, f: () => void) => void; removeEventListener: (t: string, f: () => void) => void } }).navigation;
    if (!nav) return setCan({ back: true, forward: true });
    const read = () => setCan({ back: nav.canGoBack, forward: nav.canGoForward });
    read();
    nav.addEventListener("currententrychange", read);
    return () => nav.removeEventListener("currententrychange", read);
  }, []);

  return (
    <div className="win-nav" role="toolbar" aria-label="Window">
      <button type="button" aria-label="Back" title="Back" disabled={!can.back} onClick={() => history.back()}>
        <Icon name="arrowLeft" size={16} />
      </button>
      <button type="button" aria-label="Forward" title="Forward" disabled={!can.forward} onClick={() => history.forward()}>
        <Icon name="arrowRight" size={16} />
      </button>
      <button type="button" className={`win-nav-panel ${open ? "on" : ""}`} aria-label={open ? `Hide ${what}` : `Show ${what}`} title={open ? `Hide ${what} (${key})` : `Show ${what} (${key})`} aria-pressed={open} onClick={onToggle}>
        <Icon name="sidebar" size={16} />
      </button>
      {/* Search beside the sidebar's button (Arun, 2026-10-24: "place this next to the side bar close and open button"), where
          it is in reach with the sidebar shut too; the sidebar's own is hidden in the app (style.css .sidebar-search). */}
      <button type="button" aria-label="Search" title={`Search (${find})`} onClick={() => window.dispatchEvent(new Event("friday:search"))}>
        <Icon name="search" size={16} />
      </button>
    </div>
  );
}
