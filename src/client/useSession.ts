import { sameFocus, type Focus } from "../focus.js";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { apply, roleOf, type SessionState } from "../session/projection.js";
import { fillPatches } from "../session/patches.js";
import { MAIN_LANE, type DiffFile, type Member, type PresenceMember, type SessionEvent } from "../types.js";
import { buildDigest, type Digest } from "../session/digest.js";
import type { Identity } from "./storage.js";
import { earlySocket } from "./early.js";

export type { Digest } from "../session/digest.js";

/** How long away counts as "away" for the catch-up panel. */
const AWAY_MS = 60_000;

export type ConnState = "connecting" | "live" | "reconnecting" | "rejected" | "removed";
/**
 * Send a command. The promise settles with the server's answer, for the few
 * places that wait on one (a commit, which can take a push's worth of time);
 * everywhere else ignores it and a refusal still shows up as a toast. Pass
 * `quiet: true` when the caller shows the error itself.
 */
export type Send = (cmd: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; /** The lane a lane.add made. */ lane?: string }>;

type ServerMsg =
  /** `since`: the events are only those after it, for a page that asked with what it already holds. */
  | { kind: "hello"; you: Member; state: SessionState; events: SessionEvent[]; digest: Digest | null; seenSeq?: number; invites?: Record<string, string>; since?: number; earlier?: number }
  /** The rest of the log after a hello that carried only its newest events (`tail`), sent when the page asks for it. */
  | { kind: "earlier"; events: SessionEvent[]; more?: boolean }
  | { kind: "event"; event: SessionEvent }
  | { kind: "delta"; text: string; channel?: "text" | "reasoning"; lane?: string }
  /** A coding tool's change set while its turn runs, logged only as the turn ends. */
  | { kind: "diff"; base: string; files: DiffFile[]; lane?: string }
  | { kind: "pong" }
  | { kind: "presence"; members: PresenceMember[]; anonymous?: number }
  | { kind: "focus"; id: string; at: Focus | null }
  | { kind: "invites"; invites: Record<string, string> | null }
  | { kind: "result"; id?: string; ok: boolean; error?: string; lane?: string }
  /** Said just before the server closes the socket, because the hosted server's proxy drops a close's own code and reason. */
  | { kind: "closing"; code: number; reason: string };

export type Streams = Record<string, { text: string; reasoning: string }>;

/**
 * What each agent is typing, after one more message from the server.
 *
 * Kept per lane: two agents typing at once are two streams. A delta joins the stream of the lane that sent it,
 * and an agent finishing (a message, the run ending, a pause or cancel) closes only its own stream, so the
 * other agent's half-written answer stays on screen.
 */
export function streamsAfter(streams: Streams, m: { kind: "delta"; text: string; channel?: "text" | "reasoning"; lane?: string } | { kind: "event"; event: { lane?: string; body: { type: string } } }): Streams {
  if (m.kind === "delta") {
    const lane = m.lane ?? MAIN_LANE;
    const cur = streams[lane] ?? { text: "", reasoning: "" };
    return { ...streams, [lane]: m.channel === "reasoning" ? { ...cur, reasoning: cur.reasoning + m.text } : { ...cur, text: cur.text + m.text } };
  }
  const t = m.event.body.type;
  if (t === "agent.message" || t === "run.ended" || t === "run.pause" || t === "run.cancel") {
    const { [m.event.lane ?? MAIN_LANE]: _done, ...rest } = streams;
    return rest;
  }
  return streams;
}

/**
 * What each open session's agents are typing, for the one small component per lane that draws it. A word arriving redraws
 * that component and nothing else: it used to redraw the whole session, every row of the feed with it, every frame.
 * The session itself redraws only when a lane starts or stops typing, or goes from thinking to answering.
 */
const typing = new Map<string, { streams: Streams; subs: Map<string, Set<() => void>> }>();
const typingOf = (sid: string) => {
  let t = typing.get(sid);
  if (!t) typing.set(sid, (t = { streams: {}, subs: new Map() }));
  return t;
};
/** What the session around the streams shows of them: which lanes are typing, and whether thinking or answering. */
const shapeOf = (s: Streams) =>
  Object.entries(s)
    .map(([lane, x]) => `${lane}:${x.text ? "t" : ""}${x.reasoning ? "r" : ""}`)
    .join();

/** What one lane's agent is typing right now, redrawn a frame at a time on its own. */
export function useLaneStream(sid: string, lane: string): Streams[string] | undefined {
  const subscribe = useCallback(
    (cb: () => void) => {
      const subs = typingOf(sid).subs;
      const set = subs.get(lane) ?? new Set();
      subs.set(lane, set.add(cb));
      return () => void set.delete(cb);
    },
    [sid, lane],
  );
  return useSyncExternalStore(subscribe, () => typingOf(sid).streams[lane]);
}

/**
 * What to ask the server for on (re)connecting: only the events after the ones this page already holds, when it holds the
 * log whole from the start. Undefined asks for all of it.
 */
/** How many of the newest events a first hello carries (see socketUrl). */
export const TAIL = 200;

/**
 * A session's socket. It is authenticated by the same cookie as every other call. A page that already holds the log asks only
 * for what came after it (`since`); a server that doesn't know `since` sends it all, which the hello handles too. Otherwise the
 * whole log comes newest first (`tail`): the hello carries the last TAIL events, enough to draw the feed, and the page asks for
 * the rest once they are drawn. A server from before sends it all in the hello, which is handled the same.
 */
export function socketUrl(sid: string, invite: string, since?: number): string {
  const qs = new URLSearchParams({ session: sid, invite, ...(since ? { since: String(since) } : { tail: String(TAIL) }) });
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?${qs}`;
}

export function sinceFor(events: { seq: number }[]): number | undefined {
  const last = events.at(-1)?.seq ?? 0;
  return last > 0 && events.length === last ? last : undefined;
}

/**
 * The log after a hello. A server that sent only what came after `since` is added to what is held; one that didn't say
 * (an older server, or a log it couldn't match) sent all of it.
 */
export function eventsAfterHello(held: SessionEvent[], m: { events: SessionEvent[]; since?: number }): SessionEvent[] {
  if (!m.since || held.length < m.since) return m.events;
  return [...held.slice(0, m.since), ...m.events];
}

interface Live {
  me: Member | null;
  state: SessionState | null;
  events: SessionEvent[];
  digest: Digest | null;
  /** How far this person had read before this visit: 0 on their first. */
  /** This person's read mark, from the server's hello: undefined until it has said, so a cached view never fixes a stale one. */
  seenSeq?: number;
  invites?: Record<string, string> | null;
  presence: PresenceMember[];
  /** How many watch live without an account: a number, never names (live-watch.ts). */
  anonymous: number;
  /** Only the newest events are here, the older part still to come: what decides from the whole log waits for it. */
  partial?: boolean;
  /** Where each other person is looking, while they are here. */
  focus: Record<string, Focus>;
  /** What each agent is typing right now, by lane. Two agents at once are two streams. */
  streams: Streams;
}

const empty = (): Live => ({ me: null, state: null, events: [], digest: null, seenSeq: undefined, presence: [], anonymous: 0, focus: {}, streams: {} });

/**
 * The last few sessions as they were left, so going back to one draws it at once while it reconnects, instead of a
 * blank page until the whole log has come down again. The server's hello replaces it as soon as it arrives.
 * ponytail: five sessions' logs in memory; fewer, or only their tails, if memory ever matters.
 */
const recent = new Map<string, Live>();
const RECENT_MAX = 5;
const fromRecent = (sid: string): Live => {
  const kept = recent.get(sid);
  // What someone was typing, and who was here, belonged to that moment; the log and the state still hold.
  return kept ? { ...kept, streams: {}, presence: [], anonymous: 0, focus: {}, seenSeq: undefined } : empty();
};

/**
 * One live session over WebSocket. Session state is folded from events with
 * the same reducer the server uses; it lives in a ref (the reducer mutates)
 * and a counter triggers re-renders. Your role comes from the session state,
 * so a promotion or demotion shows up the moment the owner makes it.
 */
export function useSession(sid: string, invite: string, who: Identity) {
  const live = useRef<Live>(fromRecent(sid));
  const [, setVersion] = useState(0);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [rejectReason, setRejectReason] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  /** Last seq acknowledged as read, and when the tab was last hidden. */
  const acked = useRef(0);
  const replies = useRef(new Map<string, { resolve: (r: { ok: boolean; error?: string }) => void; quiet: boolean }>());
  const seq = useRef(0);
  const awaySince = useRef(0);

  useEffect(() => {
    let disposed = false;
    let retry: number | undefined;
    let ackTimer: number | undefined;
    let backoff = 1500;
    let frame: number | undefined;
    /** Whether the next frame redraws the session, or only the lanes whose words changed. */
    let full = false;
    const t = typingOf(sid);
    t.streams = {};
    let dirty = new Set<string>();
    const flushStreams = () => {
      const lanes = dirty;
      dirty = new Set();
      for (const lane of lanes) t.subs.get(lane)?.forEach((cb) => cb());
    };
    /** The streams after a message; true when the session around them has to redraw too. */
    const setStreams = (next: Streams): boolean => {
      const prev = t.streams;
      if (next === prev) return false;
      for (const lane of new Set([...Object.keys(prev), ...Object.keys(next)])) if (prev[lane] !== next[lane]) dirty.add(lane);
      t.streams = live.current.streams = next;
      return shapeOf(prev) !== shapeOf(next);
    };
    const rerender = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      full = false;
      flushStreams();
      setVersion((v) => v + 1);
    };
    /**
     * An agent's words arrive a few characters at a time, often faster than the screen redraws, and each piece used to
     * redraw the whole session: in a long one the drawing fell behind the words, and they came out slower than they were
     * written. Every piece is kept the moment it arrives, and drawn with whatever else came in, once a frame.
     */
    const soon = () => {
      // One frame for both, so the session and the words in it redraw together: a stream closed by its logged message (the
      // secret shield's copy) never shows a frame of neither.
      frame ??= requestAnimationFrame(() => {
        frame = undefined;
        flushStreams();
        if (full) (full = false), setVersion((v) => v + 1);
      });
    };
    const rerenderSoon = () => {
      full = true;
      soon();
    };
    live.current = fromRecent(sid);

    // "Seen" advances only while the tab is visible, so the catch-up digest
    // reflects what the person actually looked at.
    const scheduleAck = () => {
      clearTimeout(ackTimer);
      ackTimer = window.setTimeout(() => {
        const ws = wsRef.current;
        const seq = live.current.state?.lastSeq;
        if (document.visibilityState === "visible" && seq && ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ack", seq }));
          acked.current = seq;
        }
      }, 800);
    };

    // Coming back to a tab that stayed open gets the same catch-up as a cold
    // join. buildDigest is pure, so the client runs the server's own function
    // over its own events rather than asking for a second summary.
    const onVisible = () => {
      if (document.visibilityState !== "visible") {
        awaySince.current = Date.now();
        return;
      }
      const away = Date.now() - awaySince.current;
      // A laptop that slept or changed networks has a socket that looks open and leads nowhere: asked now, not at the next ping.
      if (away >= AWAY_MS) checkAlive();
      const l = live.current;
      const from = acked.current;
      if (away >= AWAY_MS && l.state && l.me && from > 0 && l.state.lastSeq > from) {
        const d = buildDigest(
          l.events.filter((e) => e.seq > from),
          l.state,
          l.me,
          from,
        );
        if (d) {
          l.digest = d;
          rerender();
        }
      }
      scheduleAck();
    };
    document.addEventListener("visibilitychange", onVisible);

    const handle = (m: ServerMsg) => {
      const l = live.current;
      switch (m.kind) {
        case "closing":
          said = { code: m.code, reason: m.reason };
          return;
        case "hello":
          // In: the next drop starts its wait from the shortest again. Not on open, which a server refusing every join also is.
          backoff = 1500;
          helloAfter = HELLO_WAIT;
          // Live once the server has let them in, not on open: a join that failed opens too and then says nothing.
          setConn("live");
          l.me = m.you;
          l.state = m.state;
          l.events = eventsAfterHello(l.events, m);
          l.digest = m.digest;
          l.seenSeq = m.seenSeq ?? 0;
          l.invites = m.invites;
          setStreams({});
          scheduleAck();
          // Only the newest events came: the rest is asked for once these are drawn (the frame after this one).
          l.partial = !!m.earlier;
          if (m.earlier) {
            const ws = wsRef.current;
            requestAnimationFrame(() => setTimeout(() => ws === wsRef.current && ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "earlier" }))));
          }
          break;
        case "earlier":
          // All older than anything held: in pieces, newest first, and whole again once the last of them (no `more`) is in.
          l.events = [...m.events, ...l.events];
          l.partial = !!m.more;
          break;
        case "event": {
          if (!l.state || m.event.seq <= l.state.lastSeq) return;
          // One went missing: nothing past the gap is applied or acked. A new socket asks for what came after the last one
          // held (sinceFor), so the server sends exactly what is missing.
          if (m.event.seq !== l.state.lastSeq + 1) return resyncNow();
          // A change set's patches that are the lane's last ones come as references to them: filled in before it is the last.
          fillPatches(m.event, l.state, (q) => (l.events[q - 1]?.seq === q ? l.events[q - 1] : l.events.find((e) => e.seq === q)));
          apply(l.state, m.event);
          l.events = [...l.events, m.event];
          setStreams(streamsAfter(l.streams, m));
          scheduleAck();
          // Drawn with whatever else arrives this frame: a run's end often comes as a handful of events at once.
          return rerenderSoon();
        }
        case "delta":
          return setStreams(streamsAfter(l.streams, m)) ? rerenderSoon() : soon();
        case "diff":
          // Shown where the log's own would be, until the turn's end puts the last one in the log. A new object, so what is
          // worked out from the diffs is worked out again.
          if (!l.state) return;
          l.state.diffs = { ...l.state.diffs, [m.lane ?? MAIN_LANE]: { seq: l.state.lastSeq, base: m.base, files: m.files } };
          return rerenderSoon();
        case "pong":
          return;
        case "presence":
          l.presence = m.members;
          l.anonymous = m.anonymous ?? 0;
          // Somebody who is no longer here is not looking at anything.
          for (const id of Object.keys(l.focus)) if (!m.members.some((p) => p.id === id && p.online)) delete l.focus[id];
          return rerenderSoon();
        case "focus":
          if (m.id === l.me?.id) return;
          if (m.at) l.focus = { ...l.focus, [m.id]: m.at };
          else {
            const { [m.id]: _gone, ...rest } = l.focus;
            l.focus = rest;
          }
          // A teammate's pointer moves several times a second; once a frame is plenty.
          return rerenderSoon();
        case "invites":
          l.invites = m.invites;
          break;
        case "result": {
          // A server from before pings answers one as an unknown command: that is an answer, and nothing to show.
          if (m.id === "ping") return;
          const waiting = m.id ? replies.current.get(m.id) : undefined;
          if (m.id) replies.current.delete(m.id);
          waiting?.resolve({ ok: m.ok, ...(m.error ? { error: m.error } : {}), ...(typeof m.lane === "string" ? { lane: m.lane } : {}) });
          // A dialog that shows its own error asks for quiet; everything else toasts.
          if (!m.ok && m.error && !waiting?.quiet) setToast(m.error);
          return;
        }
      }
      rerender();
    };

    // What the server said as it closed the current socket (see the "closing" message).
    let said: { code: number; reason: string } | null = null;
    // Back off while the server is down instead of hammering it, each wait spread so a room that lost it doesn't all return at once.
    const reconnect = () => {
      setConn("reconnecting");
      retry = window.setTimeout(connect, backoff * (0.5 + Math.random()));
      backoff = Math.min(backoff * 2, 15_000);
    };
    /** When anything last came from the server, whether the current socket has had its hello, and the wait on a ping's answer. */
    let heard = 0;
    let greeted = false;
    let dead: number | undefined;
    /**
     * The wait on a new socket's hello, and how long it is. A first visit's hello carries the whole log, tens of megabytes in a
     * long session, so the wait starts past the server's heartbeat window and doubles each time one runs out: a slow link that
     * missed it once gets longer next time instead of starting the download over forever. Back to the start once in.
     */
    let helloWait: number | undefined;
    const HELLO_WAIT = 60_000;
    let helloAfter = HELLO_WAIT;
    /** Not waited on to close: a socket to nowhere can take minutes to say it has. */
    const giveUp = (ws: WebSocket) => {
      ws.onclose = null;
      ws.onmessage = null;
      ws.close();
      settle();
      reconnect();
    };
    /**
     * After a laptop sleeps or the network changes, a socket can stay open to nothing, and the page said "live" over a room
     * that had moved on. Asked now and then; with nothing at all back within ten seconds the socket is given up and a new one
     * made. A server from before pings answers with an unknown-command result, which counts: anything heard does.
     */
    const checkAlive = () => {
      const ws = wsRef.current;
      if (!greeted || ws?.readyState !== WebSocket.OPEN || dead !== undefined) return;
      const asked = Date.now();
      ws.send(JSON.stringify({ type: "ping", rid: "ping" }));
      dead = window.setTimeout(() => {
        dead = undefined;
        if (heard >= asked || wsRef.current !== ws || disposed) return;
        giveUp(ws);
      }, 10_000);
    };
    const pinger = window.setInterval(checkAlive, 25_000);
    /** Straight onto a new socket, without the wait or the "reconnecting" a drop gets: this one is fine, it just lost an event. */
    const resyncNow = () => {
      const ws = wsRef.current;
      if (!ws) return;
      ws.onclose = null;
      ws.onmessage = null;
      ws.close();
      settle();
      connect();
    };
    const onOnline = () => {
      // Waiting out a long backoff from while the network was gone is waiting for nothing.
      if (retry !== undefined && wsRef.current?.readyState === WebSocket.CLOSED) {
        clearTimeout(retry);
        retry = undefined;
        backoff = 1500;
        return connect();
      }
      checkAlive();
    };
    window.addEventListener("online", onOnline);
    const connect = () => {
      retry = undefined;
      greeted = false;
      clearTimeout(dead);
      dead = undefined;
      clearTimeout(helloWait);
      const url = socketUrl(sid, invite, sinceFor(live.current.events));
      // The page may have opened this very socket while the app loaded (index.html): taken, with what it has said so far.
      const opened = earlySocket(url);
      const ws = opened?.ws ?? new WebSocket(url);
      wsRef.current = ws;
      // Open is not in (see the hello): a server whose join failed partway can open and then say nothing. Tried again.
      ws.onopen = () => {
        helloWait = window.setTimeout(() => {
          if (greeted || wsRef.current !== ws || disposed) return;
          helloAfter = Math.min(helloAfter * 2, 8 * HELLO_WAIT);
          giveUp(ws);
        }, helloAfter);
      };
      ws.onmessage = (e) => {
        heard = Date.now();
        const m = JSON.parse(e.data) as ServerMsg;
        if (m.kind === "hello") {
          greeted = true;
          clearTimeout(helloWait);
        }
        handle(m);
      };
      ws.onclose = (e) => {
        clearTimeout(helloWait);
        settle();
        if (disposed) return;
        // The code and reason the server closed with: the close's own, or what it said just before when a proxy dropped them.
        const code = said && (e.code === 1005 || !e.reason) ? said.code : e.code;
        const reason = said && (e.code === 1005 || !e.reason) ? said.reason : e.reason;
        said = null;
        // Refused for good (not signed in, or the session is full): trying again every second and a half changes nothing.
        if (code === 4001 || code === 4008) {
          setRejectReason(reason);
          return setConn("rejected");
        }
        if (code === 4003) return setConn("removed");
        reconnect();
      };
      if (opened) {
        if (ws.readyState === WebSocket.OPEN) ws.onopen!.call(ws, new Event("open"));
        for (const e of opened.said) ws.onmessage!.call(ws, e);
      }
    };

    // Every command still waiting for its answer is told the connection went, at once: left to the two-minute timeout, a send
    // button, an approval's buttons and a queued edit all stayed busy for that long. It may have landed, so it says so.
    const settle = () => {
      for (const r of replies.current.values()) r.resolve({ ok: false, error: "The connection dropped before the answer came. Check whether it went through." });
      replies.current.clear();
    };
    connect();
    document.addEventListener("visibilitychange", scheduleAck);
    return () => {
      disposed = true;
      // Kept for going back to it (see `recent`), most recent last.
      if (live.current.state) {
        recent.delete(sid);
        recent.set(sid, live.current);
        if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value!);
      }
      if (frame !== undefined) cancelAnimationFrame(frame);
      t.streams = {};
      clearTimeout(retry);
      clearTimeout(ackTimer);
      clearTimeout(dead);
      clearTimeout(helloWait);
      clearInterval(pinger);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", scheduleAck);
      document.removeEventListener("visibilitychange", onVisible);
      wsRef.current?.close();
      settle();
    };
  }, [sid, invite, who.id, who.name]);

  const send = useCallback<Send>((cmd) => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) {
      setToast("Not connected. Retrying…");
      return Promise.resolve({ ok: false, error: "Not connected." });
    }
    const id = `${Date.now()}-${++seq.current}`;
    return new Promise((resolve) => {
      const { quiet, ...rest } = cmd;
      replies.current.set(id, { resolve, quiet: quiet === true });
      // `rid`, not `id`: the correlation id rides alongside the command rather
      // than inside it, so a command with an `id` field of its own survives.
      ws.send(JSON.stringify({ ...rest, rid: id }));
      // Never left hanging by a socket that drops before the answer.
      setTimeout(() => {
        if (replies.current.delete(id)) resolve({ ok: false, error: "No answer from the server." });
      }, 120_000);
    });
  }, []);

  /**
   * Tell the room where this person is looking. Paced and de-duplicated here (a pointer moves faster than anyone can follow),
   * and repeated now and then so someone who joins later learns where everyone is without anybody having to move.
   */
  const lookRef = useRef<{ at: Focus; sent: Focus | null; timer: number | undefined; last: number }>({ at: {}, sent: null, timer: undefined, last: 0 });
  const look = useCallback((at: Focus) => {
    const r = lookRef.current;
    r.at = at;
    const flush = () => {
      r.timer = undefined;
      const ws = wsRef.current;
      if (ws?.readyState !== WebSocket.OPEN || sameFocus(r.sent, r.at)) return;
      r.sent = r.at;
      r.last = Date.now();
      ws.send(JSON.stringify({ type: "focus", at: r.at }));
    };
    if (r.timer !== undefined) return;
    r.timer = window.setTimeout(flush, Math.max(0, 120 - (Date.now() - r.last)));
  }, []);
  useEffect(() => {
    const t = setInterval(() => {
      const r = lookRef.current;
      const ws = wsRef.current;
      if (document.visibilityState === "visible" && ws?.readyState === WebSocket.OPEN && r.sent) ws.send(JSON.stringify({ type: "focus", at: r.sent }));
    }, 25_000);
    return () => clearInterval(t);
  }, []);
  // A new connection has told nobody anything yet.
  useEffect(() => {
    if (conn === "live") lookRef.current.sent = null;
  }, [conn]);

  const l = live.current;
  // The same object until the role changes: a new one each render rebuilt the feed's context and redrew every memoised row
  // on every streaming frame.
  const role = l.me && l.state ? (roleOf(l.state, l.me.id) ?? l.me.role) : undefined;
  const me = useMemo(() => (l.me && role ? { ...l.me, role } : l.me), [l.me, role]);
  return { ...l, me, conn, rejectReason, toast, clearToast: () => setToast(null), notify: setToast as (m: string) => void, send, look };
}
