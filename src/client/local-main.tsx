// The open-source edition's page: everything runs on this computer, with your own coding tools, and no account (edition.ts).
// Nothing paid is plugged in, so none of it is in this build; scripts/oss-export.mts checks that it stays that way.
// First, so every page loads already knowing it is the local edition (local-edition.ts).
import "./local-edition.js";
import { createRoot } from "react-dom/client";
import { freeScrollInPopups } from "./scroll-free.js";
import { TooltipProvider } from "@/components/ui/tooltip";
import { App } from "./App.js";
import { tellDesktopTheme } from "./storage.js";
import { applyPrefs } from "./prefs.js";
import { applyFonts, applyTheme, readFonts, readTheme } from "./theme.js";
import { reloadForChunk, watchChunkErrors } from "./BuildWatch.js";
import { showCrash } from "./crash.js";
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

createRoot(document.getElementById("root")!, {
  onUncaughtError: (error, info) => {
    if (reloadForChunk(error)) return;
    console.error(error, info.componentStack);
    // Said on screen, not left blank (crash.ts).
    showCrash(error);
  },
}).render(
  <TooltipProvider delayDuration={300}>
    <App />
  </TooltipProvider>,
);
