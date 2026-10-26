import type { WebSocket, WebSocketServer } from "ws";

/**
 * Keeping a socket open, and noticing when it is not.
 *
 * Two different problems, one mechanism.
 *
 * The first is that nothing between here and the other end tolerates silence.
 * Load balancers, proxies and home routers close a connection that has
 * carried no bytes for a minute or two, and a linked machine that nobody is
 * currently instructing carries no bytes at all. That is what "it
 * disconnects randomly" is: it disconnects exactly when it is idle, which is
 * most of the time.
 *
 * The second is worse, because it is silent. When a laptop sleeps or a
 * network changes, the connection does not close — it stops. No `close`
 * event fires on either side, so the server keeps a machine in its list that
 * is not there and the runner sits happily linked to nothing. There is no
 * timeout on a TCP connection that nobody writes to; the only way to find
 * out is to ask and see whether anything comes back.
 *
 * A ping every 25 seconds answers both: it is well inside the shortest idle
 * timeout anybody deploys behind, and a client that misses two in a row is a
 * client that is gone, so the socket is torn down and whatever reconnect logic
 * exists gets to run instead of waiting forever on something already dead.
 */

/**
 * Close a socket with a code and a reason the other end will actually get.
 *
 * The proxy in front of the hosted server forwards a close with neither: whatever was said arrives as 1005 and nothing. A
 * runner refused because another agent is editing the folder, a person removed from a session, a runner told not to come back
 * because a newer one replaced it: all of them read as "connection closed (1005)", and the ones that decide what happens next
 * by the code (reconnect or not) decided wrongly. So it is said first as an ordinary message, which every proxy passes, and
 * then closed as before for anything that reads the close itself. Receivers prefer the message (see `closingSaid`).
 */
export function closeSaying(ws: WebSocket, code: number, reason: string): void {
  // OPEN, by number: this file is shared with the runner, and stays free of the library's runtime.
  if (ws.readyState === 1) {
    try {
      ws.send(JSON.stringify({ kind: "closing", code, reason }));
    } catch {
      // Already going: the close below says what it can.
    }
  }
  // A close reason is capped at 123 bytes, not characters.
  let short = reason.slice(0, 123);
  while (Buffer.byteLength(short) > 123) short = short.slice(0, -1);
  ws.close(code, short);
}

/**
 * The code and reason a socket closed with: what the close itself carried, or, when a proxy dropped them (1005, nothing),
 * what the other end said just before it with `closeSaying`.
 */
export function closingSaid(said: { code: number; reason: string } | null, code: number, reason: string): { code: number; reason: string } {
  return said && (code === 1005 || !reason) ? said : { code, reason };
}

/** When, for a log line about a drop: the runner's log has no times of its own, and a drop is only explained beside the server's. */
export const clock = (): string => new Date().toISOString();

/**
 * Say when this process was held up for more than `overMs`: everything it holds open goes unanswered meanwhile, and a drop
 * that follows one is explained by it. A sleeping computer reads the same way, which is said too.
 */
export function watchStalls(say: (line: string) => void, overMs = 5000): () => void {
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const late = now - last - 1000;
    last = now;
    if (late > overMs) say(`held up for ${(late / 1000).toFixed(1)}s at ${clock()} (busy, or the computer was asleep)`);
  }, 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Well under the ~60s that proxies and load balancers give an idle socket. */
export const HEARTBEAT_MS = 25_000;

/**
 * Ping everything on this server, and drop whatever stops answering.
 *
 * Returns a stop function, so shutting the server down doesn't leave a timer
 * holding the process open.
 */
export function heartbeat(wss: WebSocketServer, everyMs = HEARTBEAT_MS, name = "ws"): () => void {
  /**
   * Rounds gone by with nothing heard. Two in a row and the socket is not there any more. It was one: a server busy for a
   * moment (a big session loading, on half a CPU) reads its pongs late, and every runner and page on it was cut off at once.
   */
  const missed = new WeakMap<WebSocket, number>();
  let last = Date.now();

  wss.on("connection", (ws: WebSocket) => {
    // A malformed frame (bad UTF-8, an unmasked client frame, one over the size cap) is an 'error' on the socket, and an
    // 'error' nobody listens for throws: one bad frame from anyone would take every session on this server down with it.
    ws.on("error", (e) => console.warn("[ws]", e.message));
    missed.set(ws, 0);
    // `ws` answers pings by itself; this is the other half, the reply coming back. Anything else it sends says as much.
    ws.on("pong", () => missed.set(ws, 0));
    ws.on("message", () => missed.set(ws, 0));
  });

  const timer = setInterval(() => {
    // This round came late, so this server was the one not listening (a stall on half a CPU): the answers are waiting unread
    // behind this timer, and counting the round against every socket would drop them all for this server's pause.
    const now = Date.now();
    const late = now - last > everyMs * 2;
    last = now;
    for (const ws of wss.clients) {
      const n = missed.get(ws) ?? 0;
      if (n >= 2 && !late) {
        console.warn(`[${name}] dropped a connection that stopped answering for ${Math.round((n * everyMs) / 1000)}s`);
        // terminate, not close: a half-open socket will never complete a
        // closing handshake, which is the state this exists to end.
        ws.terminate();
        continue;
      }
      if (!late) missed.set(ws, n + 1);
      try {
        ws.ping();
      } catch {
        // A socket that throws on ping is already gone; the next round ends it.
      }
    }
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * The same, for one socket this process opened rather than accepted.
 *
 * The runner's link to Friday needs it in both directions: its own pings keep
 * the path warm, and a missed answer is what turns a dead link into a
 * reconnect instead of a process that thinks it is still connected.
 */
export function keepAlive(ws: WebSocket, everyMs = HEARTBEAT_MS, onGiveUp?: (why: string) => void): () => void {
  /**
   * Rounds gone by with nothing heard, the server's rule (heartbeat above): two, not one. On one, a server that stalled for
   * half a minute (a big session loading, on half a CPU) answered every runner's ping late, and every runner on this
   * computer cut its link and each of its agents' connections at the same moment, stopping the coding tools mid-turn.
   */
  let missed = 0;
  let last = Date.now();
  /** A check after a pause (below): an answer to it ends it. */
  let probe: ReturnType<typeof setTimeout> | null = null;
  const heard = () => {
    missed = 0;
    if (probe) clearTimeout(probe);
    probe = null;
  };
  ws.on("pong", heard);
  // Anything the server sends says it is there, as on the server's side.
  ws.on("message", heard);
  const end = (why: string) => {
    onGiveUp?.(why);
    ws.terminate();
  };
  const ping = () => {
    try {
      ws.ping();
    } catch {
      end("the connection couldn't be written to");
    }
  };
  const timer = setInterval(() => {
    const now = Date.now();
    const paused = now - last;
    last = now;
    // A round that came twice as late as it should have: this computer slept, or this process was held up. After a sleep the
    // socket is all but certainly dead, and waiting two rounds to find out left a laptop opened again "disconnected" for a
    // minute. It used to be ended at once, which also cut a link that was fine after a pause of this process alone. Asked
    // now instead: an answer within a few seconds keeps it, and none ends it, so the reconnect starts at once all the same.
    if (paused > everyMs * 2) {
      missed = 0;
      probe ??= setTimeout(() => {
        probe = null;
        end(`no answer after this computer paused for ${Math.round(paused / 1000)}s`);
      }, Math.min(8000, everyMs));
      return ping();
    }
    if (missed >= 2) return end(`Friday didn't answer for ${Math.round((missed * everyMs) / 1000)}s`);
    missed++;
    ping();
  }, everyMs);
  timer.unref?.();
  const stop = () => {
    clearInterval(timer);
    if (probe) clearTimeout(probe);
    ws.off("pong", heard);
    ws.off("message", heard);
  };
  ws.on("close", stop);
  return stop;
}
