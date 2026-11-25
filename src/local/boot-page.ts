/**
 * What the desktop app's window shows while Friday starts (desktop.ts): the app's own ground and its mark, in the theme the page
 * last had, nothing else for the first moments. The window waited for the whole server before it opened, half a second with a long
 * history, and the Dock icon bounced over nothing meanwhile (spec 13, Arun 2026-11-24: "Go all out and fix these problems"). The
 * app's page replaces it the moment the server answers. A start that is slow for once (a first start after an update reading every
 * log, a slow disk) says "Starting Friday…" under the mark after two seconds, so a still window isn't taken for a stuck one.
 *
 * Its own page, as the crash page is (crash-recovery.ts): no script, nothing loaded from anywhere, the whole of it draggable, so the
 * window can be moved while it shows (on Windows and Linux the window's own buttons are drawn over its top right).
 */

/** Friday's mark (public/favicon.svg), in the ink of the theme. */
const MARK = [
  "M44.40 7.23L11.46 26.25A2.6 2.6 0 0 0 10.16 28.50L10.16 66.53A2.6 2.6 0 0 0 14.06 68.79L33.98 57.29A2.6 2.6 0 0 0 35.28 55.04L35.28 43.00A2.6 2.6 0 0 1 36.58 40.75L47.00 34.73A2.6 2.6 0 0 0 48.30 32.48L48.30 9.48A2.6 2.6 0 0 0 44.40 7.23Z",
  "M51.70 9.48L51.70 32.48A2.6 2.6 0 0 0 53.00 34.73L63.42 40.75A2.6 2.6 0 0 1 64.72 43.00L64.72 55.04A2.6 2.6 0 0 0 66.02 57.29L85.94 68.79A2.6 2.6 0 0 0 89.84 66.53L89.84 28.50A2.6 2.6 0 0 0 88.54 26.25L55.60 7.23A2.6 2.6 0 0 0 51.70 9.48Z",
  "M15.76 76.23L48.70 95.25A2.6 2.6 0 0 0 51.30 95.25L84.24 76.23A2.6 2.6 0 0 0 84.24 71.73L64.32 60.23A2.6 2.6 0 0 0 61.72 60.23L51.30 66.25A2.6 2.6 0 0 1 48.70 66.25L38.28 60.23A2.6 2.6 0 0 0 35.68 60.23L15.76 71.73A2.6 2.6 0 0 0 15.76 76.23Z",
];

/** The page's own ground and ink (style.css --bg, the window's WINDOW_BG, and the mark's colours in favicon.svg). */
const LOOK = {
  light: { bg: "#fafaf9", ink: "#17171a", muted: "#71717a" },
  dark: { bg: "#1c1c1c", ink: "#f1f1f3", muted: "#a1a1aa" },
} as const;

/**
 * `theme`: the page's last (desktop.ts lastTheme, the system's until one was chosen). `glass`: the window shows the desktop through
 * the system's own blur (Frosted, on macOS and Windows), so the page lets it through rather than painting over it.
 */
export function bootPage(o: { theme: "dark" | "light"; glass?: boolean }): string {
  const c = LOOK[o.theme];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Friday</title>
<style>
  :root { color-scheme: ${o.theme}; }
  html, body { height: 100%; margin: 0; }
  body { background: ${o.glass ? "transparent" : c.bg}; color: ${c.muted}; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; display: grid; place-items: center; -webkit-app-region: drag; user-select: none; cursor: default; }
  main { display: grid; justify-items: center; gap: 14px; }
  svg { width: 44px; height: 44px; opacity: 0.9; animation: breathe 2.4s ease-in-out infinite; }
  path { fill: ${c.ink}; }
  p { margin: 0; opacity: 0; animation: show 0.4s ease-out 2s forwards; }
  @keyframes breathe { 0%, 100% { opacity: 0.9; } 50% { opacity: 0.55; } }
  @keyframes show { to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { svg { animation: none; } p { animation-duration: 0s; } }
</style></head>
<body><main aria-busy="true">
  <svg viewBox="4 5 92 92" role="img" aria-label="Friday">${MARK.map((d) => `<path d="${d}"/>`).join("")}</svg>
  <p role="status">Starting Friday…</p>
</main></body></html>`;
}

/** The page as the window's address. */
export const bootPageUrl = (html: string): string => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
