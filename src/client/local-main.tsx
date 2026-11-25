// The open-source edition's page: everything runs on this computer, with your own coding tools, and no account (edition.ts).
// Nothing paid is plugged in, so none of it is in this build; scripts/oss-export.mts checks that it stays that way.
// First, so every page loads already knowing it is the local edition (local-edition.ts).
import "./local-edition.js";
import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { freeScrollInPopups } from "./scroll-free.js";
import { TooltipProvider } from "@/components/ui/tooltip";
import { App } from "./App.js";
import { tellDesktopTheme } from "./storage.js";
import { applyPrefs } from "./prefs.js";
import { applyFonts, applyTheme, readFonts, readTheme } from "./theme.js";
import { reloadForChunk, watchChunkErrors } from "./BuildWatch.js";
import { CrashForTests, showCrash } from "./crash.js";
import { Guard } from "./guard.js";
import { keepPage, takeKeptPage } from "./page-keep.js";

// On an address that has kept nothing yet (another app had Friday's usual port), the settings kept beside the data first (page-keep.ts).
if (await takeKeptPage()) await new Promise(() => {});
keepPage();

// The desktop app's window buttons follow the theme the boot script settled on.
tellDesktopTheme();
applyPrefs();
// Your own colours and fonts (theme.ts), before the first draw.
applyTheme(readTheme(), false);
applyFonts(readFonts(), false);

// A new build of the page while it is open: load it instead of going white.
watchChunkErrors();

// Pickers and menus over a dialog scroll (scroll-free.ts).
freeScrollInPopups();

// The menu bar's panel (desktop-tray.ts): its own small page, never the whole app a second time.
const TrayRoot = lazy(() => import("./TrayPanel.js").then((m) => ({ default: m.TrayRoot })));
const tray = new URLSearchParams(location.search).get("view") === "tray";
// The backdrop behind the app (backdrop.tsx), never the menu bar's panel: loaded on its own, so the first draw doesn't wait on it.
// A backdrop decides light or dark: the one it last had, from the first draw, not the theme's for a moment first.
try { const t = localStorage.getItem("friday.backdrop.tone"); if (!tray && localStorage.getItem("friday.mode") !== "code" && (t === "dark" || t === "light")) document.documentElement.classList.toggle("dark", t === "dark"); } catch {}
if (!tray) void import("./backdrop.js").then((m) => m.mountBackdrop());
// Saving failing, or the saved state found unreadable at the start, said on screen (SaveBanner.tsx): its own root, beside the app.
if (!tray) void import("./SaveBanner.js").then((m) => m.mountSaveBanner());

createRoot(document.getElementById("root")!, {
  onUncaughtError: (error, info) => {
    if (reloadForChunk(error)) return;
    console.error(error, info.componentStack);
    // Said on screen, not left blank (crash.ts).
    showCrash(error);
  },
  // A piece a guard caught (guard.tsx) has been said in the console by the guard, tagged; React's own line would say it twice.
  onCaughtError: (error, info) => {
    if (info.errorBoundary instanceof Guard) return;
    console.error(error, info.componentStack);
  },
}).render(
  <TooltipProvider delayDuration={300}>
    {tray ? (
      <Suspense fallback={null}>
        <TrayRoot />
      </Suspense>
    ) : (
      <App />
    )}
    <CrashForTests />
  </TooltipProvider>,
);
