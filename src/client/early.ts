/**
 * What the page asked for before the app loaded (see the script in index.html): who you are, your workspace and your
 * sessions, fetched while the bundle was still downloading. Each is taken once; after that, and on a page without them,
 * the caller asks the usual way. Null means it didn't come back usable (signed out, offline), which the caller treats
 * like any failed first read.
 */
type Early = { me?: Promise<unknown>; workspace?: Promise<unknown>; mine?: Promise<unknown>; replay?: EarlyReplay; socket?: EarlySocket };

/** A session link's socket, opened as the app starts (openEarlySocket), with what it has said so far. */
export type EarlySocket = { ws: WebSocket; said: MessageEvent[] };

/**
 * A recording or watch link's first read, asked by the page beside the script (index.html): `src` is the address it asked, `w`
 * the watcher id it made for it, `res` the answer, read whole.
 */
export type EarlyReplay = { src: string; w: string; res: Promise<{ ok: boolean; status: number; text: string }> };

export function early<T>(key: keyof Early): Promise<T | null> | null {
  const w = window as unknown as { __early?: Early };
  const p = w.__early?.[key];
  if (!p) return null;
  delete w.__early![key];
  return p as Promise<T | null>;
}

/** The watcher id the page made for its early replay read, if it made one: the page goes on asking under the same id. */
export function earlyWatcher(): string | null {
  return (window as unknown as { __early?: Early }).__early?.replay?.w ?? null;
}

/**
 * The page's early replay read, if it asked exactly `src`, taken once: a Response-like answer the caller reads as it would a fetch.
 * Null otherwise (the app was opened elsewhere and navigated here), and the caller asks itself.
 */
export function earlyReplay(src: string): Promise<Pick<Response, "ok" | "status" | "json">> | null {
  const w = window as unknown as { __early?: Early };
  const r = w.__early?.replay;
  if (!r || r.src !== src) return null;
  delete w.__early!.replay;
  return r.res.then((a) => ({ ok: a.ok, status: a.status, json: async () => JSON.parse(a.text) as unknown }));
}

/**
 * Open a session link's socket as the app starts, rather than once the session screen's code is in: what it says is kept until
 * the screen takes it (earlySocket), and one nobody takes within 30 s is closed. As the app starts, not from the page: opened by
 * the page, a long session's hello shared the line with the first paint (engineering/perf/load.md).
 */
export function openEarlySocket(url: string): void {
  const w = window as unknown as { __early?: Early };
  try {
    const ws = new WebSocket(url);
    const said: MessageEvent[] = [];
    ws.onmessage = (e) => void said.push(e);
    (w.__early ??= {}).socket = { ws, said };
    setTimeout(() => {
      if (w.__early?.socket?.ws !== ws) return;
      delete w.__early.socket;
      ws.close();
    }, 30_000);
  } catch {
    /* the screen opens its own */
  }
}

/**
 * The session socket the page opened, if it is for exactly `url` and still open or opening, taken once, with what it said before
 * now: the caller sets its own handlers and then hands it those. Otherwise null, and one for another address is closed.
 */
export function earlySocket(url: string): EarlySocket | null {
  const w = window as unknown as { __early?: Early };
  const s = w.__early?.socket;
  if (!s) return null;
  delete w.__early!.socket;
  s.ws.onmessage = null;
  if (s.ws.url !== url || s.ws.readyState > 1) {
    s.ws.close();
    return null;
  }
  return s;
}
