/**
 * When the desktop app's page dies (desktop.ts render-process-gone): a long log that ran it out of memory, a GPU fault, the system
 * killing it. Electron leaves the window white, with nothing to press. So it is loaded again, at once, up to three times in a
 * minute; a page that dies a fourth time in that minute would only die again, so the window shows a small page of its own
 * instead, saying what happened, with Reload, Copy diagnostics and Show log file (spec 13, "What can break" 2).
 *
 * Kept apart from Electron so the counting can be tested on its own (test/crash-recovery.test.ts).
 */

/** Why Chromium says a page's process went (Electron's RenderProcessGoneDetails.reason). */
export type GoneReason = "clean-exit" | "abnormal-exit" | "killed" | "crashed" | "oom" | "launch-failed" | "integrity-failure" | "memory-eviction" | string;

/** What to do after a page's process went: load it again, show the error page, or nothing (it ended as it should). */
export type Recovery = "reload" | "error-page" | "none";

/** Counts the page's crashes in a sliding window: `max` reloads in `windowMs`, then the error page. */
export class CrashGuard {
  private times: number[] = [];
  constructor(
    readonly max = 3,
    readonly windowMs = 60_000,
    private now: () => number = Date.now,
  ) {}

  /** A page process went for `reason`: what to do now. */
  gone(reason: GoneReason): Recovery {
    // Ended as asked (a window closing, Electron swapping the process for a new page): nothing to recover.
    if (reason === "clean-exit") return "none";
    const t = this.now();
    this.times = this.times.filter((x) => t - x < this.windowMs);
    this.times.push(t);
    return this.times.length <= this.max ? "reload" : "error-page";
  }

  /** The person pressed Reload on the error page: they get the full three again. */
  reset(): void {
    this.times = [];
  }

  /** How many crashes count against the limit now. */
  get recent(): number {
    const t = this.now();
    return this.times.filter((x) => t - x < this.windowMs).length;
  }
}

/** The reason in plain words, for the log and the error page. */
export function goneWords(reason: GoneReason): string {
  switch (reason) {
    case "oom":
      return "ran out of memory";
    case "crashed":
      return "crashed";
    case "killed":
      return "was stopped by the system";
    case "memory-eviction":
      return "was closed by the system to free memory";
    case "launch-failed":
      return "couldn't start";
    case "integrity-failure":
      return "failed a code integrity check";
    case "abnormal-exit":
      return "stopped unexpectedly";
    default:
      return `stopped (${reason})`;
  }
}

/**
 * The error page: self-contained (no Friday server needed, nothing from the network), in the system's light or dark, which follows
 * the theme the person chose (desktop.ts sets nativeTheme from it). Its buttons go through the preload's `recover` (preload.ts),
 * which the main process answers only for this page in Friday's own window.
 */
export function errorPage(o: { reason: GoneReason; times: number }): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const what = goneWords(o.reason);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Friday</title>
<style>
  :root { color-scheme: light dark; --bg: #fafaf9; --panel: #ffffff; --ink: #18181b; --muted: #71717a; --line: #e4e4e7; --btn: #18181b; --btn-ink: #fafaf9; --ghost: #f4f4f5; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1c1c1c; --panel: #232323; --ink: #ededed; --muted: #a1a1aa; --line: #333335; --btn: #ededed; --btn-ink: #18181b; --ghost: #2c2c2e; } }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { background: var(--bg); color: var(--ink); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; display: grid; place-items: center; padding: 16px; -webkit-app-region: drag; }
  main { width: min(440px, 100%); background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 24px; -webkit-app-region: no-drag; }
  h1 { font-size: 16px; font-weight: 600; margin: 0 0 6px; }
  p { margin: 0 0 16px; color: var(--muted); }
  .row { display: flex; flex-wrap: wrap; gap: 8px; }
  button { font: inherit; font-size: 13px; font-weight: 500; height: 30px; padding: 0 12px; border-radius: 7px; border: 1px solid var(--line); background: var(--ghost); color: var(--ink); cursor: default; }
  button.primary { background: var(--btn); color: var(--btn-ink); border-color: var(--btn); }
  button:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
  #said { min-height: 20px; margin: 12px 0 0; font-size: 12px; }
  code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
</style></head>
<body><main role="alert">
  <h1>Friday's window ${esc(what)}</h1>
  <p>It was reloaded ${o.times === 1 ? "once" : `${o.times} times`} in the last minute and stopped again, so it's paused here. Your sessions and agents are still running. If this keeps happening, copy the diagnostics and send them with your feedback.</p>
  <div class="row">
    <button class="primary" id="reload" autofocus>Reload</button>
    <button id="copy">Copy diagnostics</button>
    <button id="log">Show log file</button>
  </div>
  <p id="said" role="status" aria-live="polite"></p>
</main>
<script>
  const said = document.getElementById("said");
  const ask = (what) => (window.fridayDesktop && window.fridayDesktop.recover ? window.fridayDesktop.recover(what) : Promise.resolve({ ok: false, error: "Restart Friday to try again." }));
  const say = (r, ok) => { said.textContent = r && r.ok ? ok : (r && r.error) || "That didn't work."; };
  document.getElementById("reload").onclick = () => ask("reload").then((r) => say(r, "Reloading…"));
  document.getElementById("copy").onclick = () => ask("copy").then((r) => say(r, "Copied. Paste it into your feedback."));
  document.getElementById("log").onclick = () => ask("log").then((r) => say(r, ""));
</script>
</body></html>`;
}

/** The error page as an address a window can load, nothing fetched. */
export const errorPageUrl = (html: string): string => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
