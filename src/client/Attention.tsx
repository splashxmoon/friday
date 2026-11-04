import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { teamAttention, teamDoneTitle, useTeam } from "./Teammates.js";
import type { Attention, Crew, Preview, SessionPr, Working } from "../attention.js";
import type { NeedMark } from "../needs-rank.js";
import { usePrs } from "./prWatch.js";
import type { Overlap } from "../collisions.js";
import type { SessionSummary } from "../board.js";
import { api } from "./api.js";
import type { Identity, RecentSession } from "./storage.js";
import { notificationsOn, chimeOn } from "./prefs.js";
import { chime } from "./chime.js";
import { setServerUnread } from "./unread.js";
import { sayDone } from "./DoneToasts.js";

/**
 * Where you are the thing that is missing.
 *
 * Every other list in this app is about a session. This one is about you: an
 * agent blocked on a decision, somebody waiting for the wheel, a run that
 * stopped and only you can restart. Those already show inside their own
 * session, which is no help at all when you are in a different one — and
 * being in a different one is the normal case here.
 *
 * Polled rather than pushed, because a socket per session is a socket per
 * session whether or not anything is happening in it, and this asks about all
 * of them in one request. Fifteen seconds is slower than a human notices and
 * far cheaper than twenty open connections.
 */

const EVERY_MS = 15_000;
/** While something waits on you, looked at this often, so one answered elsewhere (a teammate, another device, the agent moving
 *  on) leaves the badge and the list within a few seconds rather than a quarter of a minute (Arun, 2026-10-20). */
const WAITING_MS = 4_000;

const WHY: Record<Attention["kind"], string> = { approval: "Wants your OK", question: "Waiting on your answer", ask: "Waiting on your answer", control: "Waiting for the wheel", handover: "Handed to you", stopped: "Stopped", mention: "Mentioned you" };

export interface AttentionState {
  /** What is waiting on you and you haven't cleared. The one list everything reads. */
  items: Attention[];
  /** Sessions with a run going right now, by sid. */
  working: Map<string, Working>;
  /** The last thing asked in each session, for the line under its title. */
  previews: Map<string, Preview>;
  /** Each session's agents and where each stands, for its row (attention.ts crewOf). */
  crews: Map<string, Crew>;
  /** Each session's pull request, when its last commit opened one, and whether it merged. */
  prs: Map<string, SessionPr>;
  /** Per session, the files another session is changing too. */
  overlaps: Map<string, Overlap[]>;
  /** Per session, when asked for (Solo): which agent, doing what, in one line. */
  summaries: Map<string, SessionSummary>;
  /** Since when each session has stood as it does (attention.ts sinceOf), for the time on its row. */
  since: Map<string, number>;
  /** False until the first poll answers. */
  loaded: boolean;
  /** Sessions removed from the list on another device. */
  gone: string[];
  /** What the Needs you page lists and hasn't been put off (needs-you.ts marks): what every count of what waits on you counts. */
  needs: NeedMark[];
  /** The sessions any of those are in. */
  needSids: Set<string>;
  /** What was put off with "Not now", by its id: left out of every count, kept under the page's "N put off". */
  off: Set<string>;
}

/**
 * The Needs you page's own list, as it stands on screen (answered or put off there a moment ago included), handed to the counts so
 * the badge, the sidebar and the rows change with the page rather than at their next read (2026-11-04 retest).
 */
const PAGE_NEEDS = "friday:needs-page";
/** The counts' own read found the list changed: the page reads it again, so the two never stand apart until a reload. */
export const NEEDS_CHANGED = "friday:needs-changed";
export function publishNeeds(needs: NeedMark[], off: string[]): void {
  dispatchEvent(new CustomEvent(PAGE_NEEDS, { detail: { needs, off } }));
}
const waitingKey = (needs: NeedMark[]) => needs.filter((n) => !n.putOff).map((n) => n.id).sort().join("|");

/** The same, for a part of the page the app's attention isn't handed to (Home's "Right now"): the latest the app has. */
let shared: { needs: NeedMark[]; off: Set<string> } = { needs: [], off: new Set() };
const sharedListeners = new Set<() => void>();
export const useNeedMarks = () => useSyncExternalStore((l) => (sharedListeners.add(l), () => void sharedListeners.delete(l)), () => shared);

/**
 * How many things wait on you: what the Needs you page lists and hasn't been put off, its pull requests to review included. The one
 * number the badge, the Board and Home say.
 */
export function useNeedsCount(a: Pick<AttentionState, "needs" | "off">): number {
  const { prs } = usePrs();
  return a.needs.length + (prs?.review ?? []).filter((p) => !a.off.has(`review~${p.url}`)).length;
}

export function useAttention(identity: Identity, recents: RecentSession[], withSummaries = false): AttentionState {
  const [summaries, setSummaries] = useState<Map<string, SessionSummary>>(new Map());
  const [items, setItems] = useState<Attention[]>([]);
  const [working, setWorking] = useState<Map<string, Working>>(new Map());
  const [previews, setPreviews] = useState<Map<string, Preview>>(new Map());
  const [crews, setCrews] = useState<Map<string, Crew>>(new Map());
  const [prs, setPrs] = useState<Map<string, SessionPr>>(new Map());
  const [overlaps, setOverlaps] = useState<Map<string, Overlap[]>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [gone, setGone] = useState<string[]>([]);
  const [since, setSince] = useState<Map<string, number>>(new Map());
  const [marks, setMarks] = useState<{ needs: NeedMark[]; off: string[] } | null>(null);
  const lastNeeds = useRef<string | null>(null);
  /**
   * What we have already raised a notification for.
   *
   * Keyed by session and the event that started it waiting, so re-polling the
   * same unanswered question stays quiet while a new one speaks up. Without
   * the seq, answering and being asked again would never notify twice; with
   * only the sid, the same question would notify every fifteen seconds.
   */
  const told = useRef(new Set<string>());
  const first = useRef(true);
  const lastText = useRef("");
  /** What was working at the last poll, so a session that stops working — and isn't waiting on anyone — is said to have finished. */
  const wasWorking = useRef(new Map<string, Working>());

  let more: string[] = [];
  // Every crew session too (Teammates.tsx), opened here or not: a room's teammate asking is said.
  more = useTeam(identity)?.hidden ?? [];
  const sids = [...new Set([...recents.map((r) => r.sid), ...more])].join(",");

  const waitingNow = useRef(0);
  waitingNow.current = items.length;

  useEffect(() => {
    // No sessions left (the last one deleted or removed): nothing can be waiting, so say so now, not never.
    if (!identity.id || !sids) {
      setItems([]);
      setWorking(new Map());
      setMarks(null);
      lastText.current = "";
      return;
    }
    let live = true;

    const ask = async () => {
      const got = await api<{ items: Attention[]; needs?: NeedMark[]; off?: string[]; working?: Working[]; previews?: Preview[]; crews?: Crew[]; prs?: SessionPr[]; overlaps?: Record<string, Overlap[]>; summaries?: SessionSummary[]; gone?: string[]; unread?: string[]; since?: Record<string, number> }>(identity, "/api/attention", {
        method: "POST",
        body: JSON.stringify({ sids: sids.split(","), ...(withSummaries ? { summaries: true } : {}) }),
      }).catch(() => null);
      if (!live || !got) return;
      // The same answer as last time changes nothing on screen, and redrawing for it redrew the whole app every 15 seconds.
      const text = JSON.stringify(got);
      if (text === lastText.current) return;
      lastText.current = text;
      setItems(got.items);
      setWorking(new Map((got.working ?? []).map((w) => [w.sid, w])));
      setPreviews(new Map((got.previews ?? []).map((p) => [p.sid, p])));
      setCrews(new Map((got.crews ?? []).map((c) => [c.sid, c])));
      setPrs(new Map((got.prs ?? []).map((x) => [x.sid, x])));
      setOverlaps(new Map(Object.entries(got.overlaps ?? {})));
      setSummaries(new Map((got.summaries ?? []).map((s) => [s.sid, s])));
      setSince(new Map(Object.entries(got.since ?? {})));
      if (got.needs) {
        setMarks({ needs: got.needs, off: got.off ?? [] });
        // Changed since the last read: the Needs you page, if open, reads its list again now.
        const key = waitingKey(got.needs);
        if (lastNeeds.current !== null && key !== lastNeeds.current) dispatchEvent(new Event(NEEDS_CHANGED));
        lastNeeds.current = key;
      }
      // What finished since you last looked, on any device: the unread marks (unread.ts).
      if (got.unread) setServerUnread(got.unread);
      if (got.gone?.length) setGone(got.gone);
      setLoaded(true);

      // Nothing on the first answer: everything waiting when the app opens has
      // been waiting a while, and a handful of notifications at launch is how
      // people learn to dismiss them without reading.
      if (first.current) {
        first.current = false;
        for (const it of got.items) told.current.add(`${it.sid}:${it.seq}`);
        wasWorking.current = new Map((got.working ?? []).map((w) => [w.sid, w]));
        return;
      }
      for (const it of got.items) {
        const key = `${it.sid}:${it.seq}`;
        if (told.current.has(key)) continue;
        told.current.add(key);
        let said = it;
        // A teammate asking: titled by who and where, not the team session's own title.
        said = teamAttention(it);
        notify(said);
        if (chimeOn()) chime();
      }
      const nowWorking = new Set((got.working ?? []).map((w) => w.sid));
      for (const [sid, w] of wasWorking.current) {
        if (nowWorking.has(sid) || got.items.some((it) => it.sid === sid)) continue;
        let title = recents.find((r) => r.sid === sid)?.title ?? "A session";
        title = teamDoneTitle(sid, title);
        notifyDone(title, w.what, sid);
        // In the window too: a soft sound and a toast, unless it is the session on screen (DoneToasts.tsx).
        sayDone({ sid, title, what: w.what });
      }
      wasWorking.current = new Map((got.working ?? []).map((w) => [w.sid, w]));
    };

    // Looked at every 15 seconds, every 4 while something waits on you and the window is in sight.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        await ask();
        if (live) next();
      }, waitingNow.current && document.visibilityState === "visible" ? WAITING_MS : EVERY_MS);
    };
    void ask().then(() => live && next());
    // A wait answered or asked here (an open session, a toast), or the window coming back into sight: look now.
    const now = () => void ask().then(() => live && next());
    const back = () => document.visibilityState === "visible" && now();
    addEventListener("friday:attention", now);
    addEventListener("focus", now);
    document.addEventListener("visibilitychange", back);
    return () => {
      live = false;
      clearTimeout(timer);
      removeEventListener("friday:attention", now);
      removeEventListener("focus", now);
      document.removeEventListener("visibilitychange", back);
    };
  }, [identity, sids, withSummaries]);

  // The page's list as it stands on screen, the moment it changes there.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ needs: NeedMark[]; off: string[] }>).detail;
      setMarks((m) => ({ needs: d.needs, off: [...new Set([...(m?.off ?? []), ...d.off])] }));
      lastNeeds.current = waitingKey(d.needs);
    };
    addEventListener(PAGE_NEEDS, on);
    return () => removeEventListener(PAGE_NEEDS, on);
  }, []);
  // A session deleted or removed leaves at once, before the server is next asked.
  const here = useMemo(() => new Set(sids.split(",")), [sids]);
  const needs = useMemo(() => (marks ? marks.needs.filter((n) => !n.putOff && (!n.sid || !gone.includes(n.sid))) : []), [marks, gone]);
  const needSids = useMemo(() => new Set(needs.flatMap((n) => (n.sid ? [n.sid] : []))), [needs]);
  const off = useMemo(() => new Set(marks?.off ?? []), [marks]);
  useEffect(() => {
    shared = { needs, off };
    for (const l of sharedListeners) l();
  }, [needs, off]);
  // A session waits on you while the page lists something of it that isn't put off: its row, its ring and its toast follow that.
  const shown = useMemo(() => items.filter((i) => here.has(i.sid) && (!marks || needSids.has(i.sid))), [items, here, marks, needSids]);
  // No count on the dock icon: Needs you says it once (audit CODE-1 B). Cleared, in case an earlier build left one.
  useEffect(() => window.fridayDesktop?.setBadge?.(0), []);
  return { items: shown, working, previews, crews, prs, overlaps, summaries, since, loaded, gone, needs, needSids, off };
}

/**
 * Say it outside the app.
 *
 * Only while the window is hidden: a banner over the thing it is telling you
 * about is noise, and the row in the sidebar has already said it.
 */
function notify(it: Attention): void {
  if (typeof Notification === "undefined" || document.visibilityState === "visible" || !notificationsOn()) return;
  if (Notification.permission !== "granted") return;
  try {
    const n = new Notification(it.title, { body: `${WHY[it.kind]} · ${it.text}`, tag: it.sid });
    n.onclick = () => {
      window.focus();
      n.close();
      // At what it is about: the session, and a question's own card.
      if (it.kind === "ask")
        try {
          sessionStorage.setItem(ASK_FOCUS, `${it.sid}:${it.seq}`);
        } catch {
          // Blocked storage: the session still opens, at its newest.
        }
      window.dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid: it.sid } }));
    };
  } catch {
    // Notifications are a courtesy; a browser that refuses them changes nothing.
  }
}

/** A run that finished while the window was hidden: nothing is waiting, but it is worth coming back for. */
function notifyDone(title: string, what: string, sid: string): void {
  if (typeof Notification === "undefined" || document.visibilityState === "visible" || !notificationsOn()) return;
  if (Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body: `Finished · ${what}`, tag: `${sid}:done` });
    n.onclick = () => {
      window.focus();
      n.close();
      window.dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid } }));
    };
  } catch {
    // Notifications are a courtesy; a browser that refuses them changes nothing.
  }
}

/** Asked once, the first time there is something worth saying. */
export function askToNotify(): void {
  if (typeof Notification === "undefined" || Notification.permission !== "default") return;
  void Notification.requestPermission().catch(() => {});
}

const keyOf = (it: Attention) => `${it.sid}:${it.lane ?? ""}:${it.seq}`;

/** A coding tool's question opened from its toast, as `sid:seq`: the session scrolls to that card (Activity's AskCard). */
export const ASK_FOCUS = "friday.ask.focus";

/** A command in backticks (`npm test`) shown as code, the way the session shows it. */
export const withCode = (text: string) => text.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));

/**
 * Waiting on you, said to a screen reader as it arrives. Seen, it is said once: in the sidebar's Needs you, at its top. The
 * corner toasts, their resting pill, the header's "N waiting on you" pill and the dock's count said it four times more, and
 * are gone (audit CODE-1 B, Arun 2026-11-04).
 */
/** `viewing`: the session on screen, whose waits its own chat already shows. */
export function WaitingOnYou({ items, recents, viewing }: { identity?: Identity; items: Attention[]; recents: RecentSession[]; onOpen?: (r: RecentSession) => void; viewing?: string }) {
  const shown = items.filter((it) => it.sid !== viewing && recents.some((r) => r.sid === it.sid));
  // One line for what arrived, rather than the waits read out whole.
  const [said, setSaid] = useState("");
  const seen = useRef(new Set<string>());
  const shownKeys = shown.map(keyOf).join("|");
  useEffect(() => {
    const fresh = shown.filter((it) => !seen.current.has(keyOf(it)));
    if (fresh.length === 1) setSaid(`${WHY[fresh[0]!.kind]}: ${fresh[0]!.title}`);
    else if (fresh.length > 1) setSaid(`${fresh.length} more waiting on you`);
    seen.current = new Set(shown.map(keyOf));
  }, [shownKeys]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span className="sr-only" role="status">
      {said}
    </span>
  );
}
