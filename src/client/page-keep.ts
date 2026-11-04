/**
 * The page's own settings, kept through a change of address (2026-11-04 end-to-end check: everything set on this computer was gone
 * after a restart whenever another app had Friday's usual port, 4321, Astro's default too). A page keeps its theme, sidebar, pins,
 * layout and the like in browser storage, and browser storage belongs to an address: on a new port the page started blank.
 *
 * So the open-source edition keeps a copy beside its data (app.ts /api/local/page), refreshed as they change, and a page on an
 * address that has never kept anything takes that copy and starts again with it. Nothing secret is in it: who you are comes from
 * a cookie, which a new port keeps.
 */
const OURS = /^(mpa|friday)\./;
/** Kept only for the page that set them: a reload's own bookkeeping. */
const PASSING = new Set(["mpa.chunkReloadAt", "mpa.reloadedFor"]);
/** Set on an address once it has kept or taken the settings: one without it is new. */
const MARK = "friday.pageKept";

function ours(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !OURS.test(k) || PASSING.has(k) || k === MARK) continue;
      const v = localStorage.getItem(k);
      if (v !== null && v.length <= 200_000) out[k] = v;
    }
  } catch {
    // Storage blocked: nothing to keep.
  }
  return out;
}

/**
 * Before the page draws: on an address that has never kept anything, the copy kept beside the data, then the page again with it.
 * True when it is loading again.
 */
export async function takeKeptPage(): Promise<boolean> {
  try {
    if (localStorage.getItem(MARK)) return false;
    const r = await fetch("/api/local/page", { headers: { "x-friday-local": "1" }, signal: AbortSignal.timeout(2500) });
    const page = r.ok ? ((await r.json()) as { page: { origin: string; keys: Record<string, string> } | null }).page : null;
    localStorage.setItem(MARK, location.origin);
    if (!page || page.origin === location.origin || !Object.keys(page.keys).length) return false;
    // A page that has set things of its own here already (it ran before this was kept) keeps them; the rest come from the copy.
    for (const [k, v] of Object.entries(page.keys)) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
    location.reload();
    return true;
  } catch {
    return false;
  }
}

/** How long after a setting changes it is kept: a burst of them (a slider dragged) is one send. */
const SOON_MS = 300;

/**
 * Calls `changed` whenever one of the page's own keys is set or removed in `storage`, by wrapping its setItem, removeItem and clear.
 * Returns a function that puts them back.
 */
export function onOwnChange(storage: Storage, changed: () => void): () => void {
  const { setItem, removeItem, clear } = storage;
  const mine = (k: unknown) => typeof k === "string" && OURS.test(k) && !PASSING.has(k) && k !== MARK;
  storage.setItem = function (k: string, v: string) {
    setItem.call(this, k, v);
    if (mine(k)) changed();
  };
  storage.removeItem = function (k: string) {
    removeItem.call(this, k);
    if (mine(k)) changed();
  };
  storage.clear = function () {
    clear.call(this);
    changed();
  };
  return () => Object.assign(storage, { setItem, removeItem, clear });
}

/**
 * From now on, the page's settings kept beside the data a moment after any of them changes, and on leaving. Looked at only every
 * fifteen seconds before, so what was set in the last few seconds before a quit was lost: the desktop app stops Friday as it quits,
 * before the page's last word on leaving can reach it (2026-11-04 retest: size and fonts changed 3 to 6 seconds before quitting
 * were gone after the restart; 12 seconds and more survived).
 */
export function keepPage(): void {
  let last = "";
  let soon: ReturnType<typeof setTimeout> | undefined;
  const send = (leaving = false) => {
    clearTimeout(soon);
    soon = undefined;
    const keys = ours();
    const body = JSON.stringify({ origin: location.origin, keys });
    if (body === last) return;
    last = body;
    try {
      localStorage.setItem(MARK, location.origin);
    } catch {
      // Storage blocked.
    }
    void fetch("/api/local/page", { method: "PUT", headers: { "Content-Type": "application/json", "x-friday-local": "1" }, body, keepalive: leaving && body.length < 60_000 }).catch(() => {});
  };
  try {
    onOwnChange(localStorage, () => (soon ??= setTimeout(() => send(), SOON_MS)));
  } catch {
    // Storage blocked: the look every few seconds still keeps what can be kept.
  }
  setTimeout(() => send(), 3_000);
  setInterval(() => send(), 15_000);
  addEventListener("pagehide", () => send(true));
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && send(true));
}
