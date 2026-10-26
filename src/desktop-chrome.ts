/**
 * The desktop window's own chrome, shared by the product app (desktop/main.ts) and the open-source one (src/local/desktop.ts),
 * so both draw the same header band, drag strip and spacing around the window's buttons. Plain strings: each app injects them
 * into its page after it loads.
 */
/**
 * The window's own chrome, given to whatever page the window is showing.
 *
 * It lives here rather than in the app's stylesheet because the window may be
 * showing a Friday this checkout never built — the hosted one, an older
 * deploy — and the rules have to reach that page too. One copy, injected on
 * every load.
 */
export const WIN_CSS = `
  /* Windows draws its caption buttons over the top-right corner, because the
     title bar that would hold them is hidden. The app draws the rest of that
     bar itself: a band across the top of the window, and it is the only thing
     that drags.

     Everything the page draws starts below it. That is the whole trick, and
     it is the one macOS already uses — when no control is inside a drag
     region, no control can be swallowed by one, and the list of "things that
     are secretly not handles" stops being needed. The session's header used
     to share this band to save a row of height; it cost every control in it,
     including the sidebar's own button, which read as a button that did
     nothing.

     Marked important because the page sets these with shorthands at the same
     specificity, so which one wins comes down to stylesheet order — and the
     page may be a build this app has never seen. Where the window's buttons
     go is not the page's to decide. */
  /* The band's height, for anything that floats and so cannot rely on the
     shell's padding to keep clear of it: the chat list over a narrow window
     would otherwise start underneath it, where a click is a window drag. */
  /* --band-top: how far down the header content sits, so it lines up with the first row of the rail and the chat list. */
  :root { --band: 40px; --band-right: 146px; --band-top: 4px; }
  /* The rail and the chat list run to the top of the window, beside the band; only the page below starts under it. */
  .shell { padding-top: 0 !important; }
  .main { margin-top: calc(var(--band) + 8px) !important; }
  /* A session puts its header in the band, lower down, in line with the rail's first row; its page starts below that. */
  html[data-band="session"] .main { margin-top: calc(var(--band) + var(--band-top) + 4px) !important; }
  .shell::before {
    content: ""; position: fixed; top: 0; left: 0; right: 0; height: 40px;
    -webkit-app-region: drag; z-index: 5;
  }
  /* Nothing of the sidebar needs placing against the band: the rail and the
     chat list are ordinary columns that start below it, like the page beside
     them. The button that used to float over the top corner, and the measured
     offsets that kept it level with a row it was not part of, went with it. */
  /* Nothing of ours should end up in the band, but a stray control that did
     would be dead rather than obviously wrong, which is the worst way for
     this to fail. */
  button, a, input, textarea, select, [role="button"], [role="tab"],
  .popover, .menu-pop, .model-pop, .menu, .modal, .overlay { -webkit-app-region: no-drag; }
`;

export const MAC_CSS = `
  /* macOS hides its title bar and leaves the traffic lights floating over the
     page, so the app draws the bar itself: a band across the top of the
     window, with the lights in it, and it is the only thing that drags.

     Everything the page draws starts below it. That is the whole trick —
     when no control is inside a drag region, no control can be swallowed by
     one, and the opt-out list of "things that are secretly not handles"
     stops being needed. The session's header used to share this band the way
     it does on Windows, where the window's buttons are over on the right;
     here that put every one of its controls under the lights and inside the
     handle, so it now sits below the band like every other page's header. */
  /* The band's height, for anything that floats and so cannot rely on the
     shell's padding to keep clear of it. */
  :root { --band: 34px; --band-right: 12px; --band-top: 48px; }
  .shell { padding-top: 0; }
  .main { margin-top: calc(var(--band) + 8px) !important; }
  /* A session puts its header in the band, lower down, in line with the rail's first row; its page starts below that. */
  html[data-band="session"] .main { margin-top: calc(var(--band) + var(--band-top) + 4px) !important; }
  /* The new-session page runs up to the top of the window, so its card starts under the band: the machine pill, which the band
     carries, would sit across the card's top edge. Bring it down inside the card, off the edge it was straddling. */
  #band-slot:has(.mb-anchor) { top: 46px !important; right: 24px !important; }
  /* The new-session card starts level with the chat list beside it (which starts at 40px), not up in the band. */
  html[data-band] .main:has(> .home), .main:has(> .home) { margin-top: 40px !important; }
  /* The traffic lights sit over the top of the rail and the list, so they start below them. */
  .sb-rail { padding-top: 44px !important; }
  .sb-panel-inner { top: 40px !important; }
  .shell::before {
    content: ""; position: fixed; top: 0; left: 0; right: 0; height: 34px;
    -webkit-app-region: drag; z-index: 5;
  }
  /* Nothing of the sidebar needs placing against the band: the rail and the
     chat list are ordinary columns that start below it, like the page beside
     them, so there is no corner to measure and nothing for the traffic lights
     to sit on top of. */
  /* Nothing of ours should end up in the band, but a stray control that did
     would be dead rather than obviously wrong, which is the worst way for
     this to fail. */
  button, a, input, textarea, select, [role="button"], [role="tab"],
  .popover, .menu-pop, .model-pop, .menu, .modal, .overlay { -webkit-app-region: no-drag; }
`;

/**
 * Reports the page's light/dark choice to the app, and keeps reporting it.
 *
 * The window buttons are drawn by Windows in a colour we choose, so they only
 * match the app if something tells it which theme is showing. The page sets a
 * class on <html>; this watches it.
 */
export const THEME_WATCH = `(() => {
  const send = () => window.fridayDesktop && window.fridayDesktop.setTheme &&
    window.fridayDesktop.setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
  send();
  new MutationObserver(send).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
})()`;
