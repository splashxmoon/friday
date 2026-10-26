/**
 * Opening an address in the Preview browser.
 *
 * A link to the running site — "it's up at http://localhost:5174/" — belongs in
 * the Preview panel's browser, not in a separate window. The panel may not be
 * open yet when somebody presses it, so the address waits here until the panel
 * exists, and is also announced for a panel that already does.
 */
const pending = new Map<string, { url: string; at: number; tab?: "here" | "auto" | "new" }>();

/** The address of something running on this computer. */
export function isLocalUrl(href: string): boolean {
  try {
    const u = new URL(href.trim());
    return (u.protocol === "http:" || u.protocol === "https:") && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * The addresses of something running on this computer that a coding tool said, in a command's output or its answer: "Local:
 * http://localhost:3000", "ready on http://127.0.0.1:5173/", a bare "localhost:3000". The ports only, so the same server said
 * three ways is one address.
 */
export function localUrlsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(?:https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})(\/[^\s"'<>)\]]*)?/gi)) {
    const host = m[1]!.toLowerCase() === "0.0.0.0" ? "localhost" : m[1]!.toLowerCase();
    const url = `http://${host}:${m[2]}${(m[3] ?? "/").replace(/[.,;:]+$/, "")}`;
    if (!out.some((u) => new URL(u).port === m[2])) out.push(url);
  }
  return out;
}

/**
 * Ports of things that are never a page to look at: Ollama, databases, caches, queues and the like. An agent reading code
 * that calls one of them says its address, and that opened the Preview on an API.
 */
const NOT_A_PAGE_PORTS = new Set([11434, 5432, 3306, 6379, 27017, 9200, 9300, 5672, 15672, 2181, 9092, 8983, 7474, 7687, 26257, 4317, 4318, 9090, 9229]);
/** Paths that are an API, not a page: `/api/generate`, `/v1/chat`, `/graphql`, `/health`, a `.json`. */
const NOT_A_PAGE_PATH = /^\/(?:api|v\d+|graphql|health|healthz|metrics|status|rpc|ws|socket\.io)(?:\/|$)|\.(?:json|xml|txt|csv)$/i;
/** How a server says it is up: "Local: …", "ready on …", "listening at …", "running on …", "serving …", "available at …". */
const ANNOUNCED = /\b(?:local|network|ready|listening|running|serving|served|started|available|preview|dev server|server|app|site|open)\b[^\n]{0,60}?\b(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}/i;

/**
 * The address of a site somebody would want to look at, from what a coding tool printed or said: only where a server
 * announces itself ("Local: http://localhost:5173", "ready on 127.0.0.1:3000"), and never an API, a database or a model
 * server. The Preview opens by itself on this; it used to open on any local address, an Ollama endpoint in code an agent
 * was explaining included.
 */
/** "The preview is running on 4174", "dev server listening on port 5173": a server said to be up, by port alone. */
const BY_PORT = /\b(?:preview|dev server|server|site|app|page|kiosk|frontend|vite|next)\b[^\n]{0,40}?\b(?:is |now )?(?:running|serving|listening|up|live|started|available)\b[^\n]{0,12}?\b(?:on|at)\s+(?:port\s+)?:?(\d{4,5})\b/i;

export function servedUrlIn(text: string): string | undefined {
  const lines = text.split("\n").filter((l) => ANNOUNCED.test(l));
  // Said by port alone, which is how an agent often says it (Arun, 2026-10-19): the page on that port of this machine.
  const ports = text.split("\n").flatMap((l) => {
    const m = BY_PORT.exec(l);
    return m ? [`http://localhost:${m[1]}/`] : [];
  });
  return [...localUrlsIn(lines.join("\n")), ...ports]
    .filter((u) => {
      const url = new URL(u);
      return !NOT_A_PAGE_PORTS.has(Number(url.port)) && !NOT_A_PAGE_PATH.test(url.pathname);
    })
    .at(-1);
}

/**
 * What a look at an address found (Arun, 2026-10-20: the coding tools "randomly opening the preview side panel when there is
 * nothing there, like just a random server running with nothing to show"): a page to show, nothing to show (nothing listening,
 * an error, or an API's JSON rather than a page), or no way to tell (no machine to ask, an old runner).
 */
export type PageLook = "page" | "none" | "unknown";

/** What the machine's runner said a page answered (runner/preview.ts fetchPreview): a page is HTML, or a redirect to one. */
export function lookOf(answer: { status: number; type: string }): PageLook {
  if (answer.status >= 300 && answer.status < 400) return "page";
  return answer.status < 300 && /\btext\/html\b|application\/xhtml/i.test(answer.type) ? "page" : "none";
}

/** A look that failed: the runner saying nothing listens there is an answer; anything else is not knowing. */
export function lookFailed(e: unknown): PageLook {
  return /Nothing is listening/i.test(String((e as Error)?.message ?? e)) ? "none" : "unknown";
}

/**
 * Whether `url` has a page to show, looked at a few times while a server that has only just said it is up gets there. True on
 * a page, and when there is no way to tell (the Preview then opens as it always did); false once every look found nothing.
 */
export async function pageAppears(url: string, look: (port: number, path: string) => Promise<PageLook>, waits = [0, 2000, 5000, 10_000]): Promise<boolean> {
  let port = 0;
  let at = "/";
  try {
    const u = new URL(url);
    port = Number(u.port) || 80;
    at = `${u.pathname}${u.search}` || "/";
  } catch {
    return false;
  }
  for (const ms of waits) {
    if (ms) await new Promise((r) => setTimeout(r, ms));
    const got = await look(port, at).catch(lookFailed);
    if (got !== "none") return true;
  }
  return false;
}

/** An address on a machine the page can't reach itself, sent through Friday instead: the ticket's address, then the page's path. */
export function throughFriday(url: string, ticketUrl: string): string {
  const u = new URL(url);
  return `${ticketUrl.replace(/\/$/, "")}${u.pathname}${u.search}${u.hash}`;
}

let stamp = 0;
/** Which tab an address opens in: the one in view ("here"), the one already on its server or a free one ("auto"), or a new one. */
export type PreviewTarget = "here" | "auto" | "new";
/** Open `url` in session `sid`'s Preview: that session's only, so another session's panel never opens it. */
export function openInPreview(url: string, sid: string, tab?: PreviewTarget): void {
  // Strictly later each time, even twice in one millisecond, so a panel can tell a new ask from one it has had.
  stamp = Math.max(stamp + 1, Date.now());
  pending.set(sid, { url, at: stamp, ...(tab ? { tab } : {}) });
  dispatchEvent(new CustomEvent("friday:preview-open", { detail: url }));
}

/**
 * The address last asked for in session `sid` after `since` (the `at` its panel last took), or null. Reading it no longer
 * clears it: a panel that took the only copy and then went away (another session, a reload) lost it, and the Preview came
 * back on its empty start screen. The panel keeps the `at` it took with its tabs, so one ask is shown once.
 */
export function takePendingPreview(sid: string, since = 0): { url: string; at: number; tab?: PreviewTarget } | null {
  const p = pending.get(sid);
  return p && p.at > since ? p : null;
}

/**
 * An agent asked for the iOS app in session `sid`'s Preview (Activity.tsx): kept until that session's panel takes it, since the
 * panel is often only opening as the ask is made. `run`: build and run it from the panel (a coding tool's "Preview: ios");
 * Friday Code's own tool has the build going already.
 */
const iosAsks = new Map<string, { run: boolean; at: number }>();
export function askIosPreview(sid: string, run: boolean): void {
  stamp = Math.max(stamp + 1, Date.now());
  iosAsks.set(sid, { run, at: stamp });
  dispatchEvent(new CustomEvent("friday:preview-ios", { detail: { sid, run } }));
}
/** The iOS ask for `sid` not yet taken, once: the panel that takes it shows it. */
export function takeIosAsk(sid: string): { run: boolean; at: number } | null {
  const a = iosAsks.get(sid) ?? null;
  iosAsks.delete(sid);
  return a;
}
