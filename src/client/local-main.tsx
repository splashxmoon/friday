// The open-source edition's page: everything runs on this computer, with your own coding tools, and no account (edition.ts).
// Nothing paid is plugged in, so none of it is in this build; scripts/oss-export.mts checks that it stays that way.
// First, so every page loads already knowing it is the local edition (local-edition.ts).
import "./local-edition.js";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { App } from "./App.js";
import { tellDesktopTheme } from "./storage.js";
import { applyPrefs } from "./prefs.js";
import { applyFonts, applyTheme, readFonts, readTheme } from "./theme.js";
import { reloadForChunk, watchChunkErrors } from "./BuildWatch.js";

// The desktop app's window buttons follow the theme the boot script settled on.
tellDesktopTheme();
applyPrefs();
// Your own colours and fonts (theme.ts), before the first draw.
applyTheme(readTheme(), false);
applyFonts(readFonts(), false);

// A new build of the page while it is open: load it instead of going white.
watchChunkErrors();

createRoot(document.getElementById("root")!, {
  onUncaughtError: (error, info) => {
    if (!reloadForChunk(error)) console.error(error, info.componentStack);
  },
}).render(
  <TooltipProvider delayDuration={300}>
    <App />
  </TooltipProvider>,
);
