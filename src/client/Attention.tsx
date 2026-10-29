import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { teamAttention, teamDoneTitle, useTeam, useTeamTab } from "./Teammates.js";
import { isWorkSid, useWorkMode } from "./WorkMode.js";
import { shortPaths } from "./shortPaths.js";
import { createPortal } from "react-dom";
import type { Attention, Crew, Preview, SessionPr, Working } from "../attention.js";
import type { Overlap } from "../collisions.js";
import type { SessionSummary } from "../board.js";
import { api } from "./api.js";
import type { Identity, RecentSession } from "./storage.js";
import { notificationsOn, chimeOn } from "./prefs.js";
import { chime } from "./chime.js";
import { Icon, type IconName } from "./icons.js";

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
  /** False until the first poll answers. */
  loaded: boolean;
  /** Sessions removed from the list on another device. */
  gone: string[];
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
      lastText.current = "";
      return;
    }
    let live = true;

    const ask = async () => {
      const got = await api<{ items: Attention[]; working?: Working[]; previews?: Preview[]; crews?: Crew[]; prs?: SessionPr[]; overlaps?: Record<string, Overlap[]>; summaries?: SessionSummary[]; gone?: string[] }>(identity, "/api/attention", {
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

  // A session deleted or removed leaves at once, before the server is next asked.
  const here = useMemo(() => new Set(sids.split(",")), [sids]);
  const shown = useMemo(() => items.filter((i) => here.has(i.sid)), [items, here]);
  // The count on the dock icon in the desktop app: what waits on you, gone the moment it is answered.
  useEffect(() => window.fridayDesktop?.setBadge?.(shown.length), [shown.length]);
  useEffect(() => () => window.fridayDesktop?.setBadge?.(0), []);
  return { items: shown, working, previews, crews, prs, overlaps, summaries, loaded, gone };
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

/**
 * Waits dismissed from the list on this device, by session, agent and the event that started them: a new question or a new
 * permission request is a new wait, and shows again. Kept in the browser, since hiding something is about this screen.
 */
const DISMISSED = "friday.waiting.dismissed";
const readDismissed = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISSED) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
};
const saveDismissed = (keys: Set<string>) => {
  try {
    localStorage.setItem(DISMISSED, JSON.stringify([...keys]));
  } catch {
    // Blocked storage: dismissing lasts until the app is reloaded.
  }
};

/** What each kind of wait looks like in the list: its mark, and how its line opens. */
const KIND: Record<Attention["kind"], { icon: IconName; lead: (it: Attention) => string }> = {
  approval: { icon: "shield", lead: () => "" },
  question: { icon: "message", lead: (it) => `${it.agent ?? "The agent"} asks: ` },
  ask: { icon: "message", lead: (it) => `${it.agent ?? "The agent"} asks: ` },
  control: { icon: "hand", lead: () => "" },
  handover: { icon: "hand", lead: () => "" },
  // "Kit stopped: their tool failed to start", not "stopped: Stopped: …" (attention.ts says a raw error in words, as stoppedLine).
  stopped: { icon: "stop", lead: (it) => (/^Stopped on an error\b/.test(it.text) ? `${it.agent ?? "The agent"} stopped on an error` : `${it.agent ?? "The agent"} stopped: `) },
  mention: { icon: "message", lead: () => "" },
};

/** A command in backticks (`npm test`) shown as code, the way the session shows it. */
export const withCode = (text: string) => text.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));

/**
 * Waiting on you: every agent blocked on you, across your sessions, as toasts in the corner of the window.
 *
 * The rows of the session list already say "Waiting on you" one session at a time. This says each wait, an agent at a time,
 * where it can't be missed on any page, and a coding tool asking before it runs something is answered right here: the
 * session it is waiting in may be one nobody has open. Pressing a toast opens its session.
 */
/** `viewing`: the session on screen, whose waits its own chat already shows, so they get no toast. */
export function WaitingOnYou({ identity, items, recents, onOpen, viewing }: { identity: Identity; items: Attention[]; recents: RecentSession[]; onOpen: (r: RecentSession) => void; viewing?: string }) {
  // Answered here: hidden at once, and the next poll drops it for good (or brings it back, if the answer didn't land).
  const [done, setDone] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(readDismissed);
  // Only what is still waiting is remembered, so the list of dismissed waits doesn't grow for ever.
  const dismiss = (its: Attention[]) =>
    setDismissed((d) => {
      const live = new Set(items.map(keyOf));
      const next = new Set([...d, ...its.map(keyOf)].filter((k) => live.has(k)));
      saveDismissed(next);
      return next;
    });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [errorFor, setErrorFor] = useState("");
  // In a session: a button in its header that opens the list, since anywhere a toast floats it covers the composer, a card
  // or an open panel. Looked up again whenever the page changes, as the header is drawn again when it moves into the window's band.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(false);
    if (!viewing) return setSlot(null);
    const find = () => setSlot(document.getElementById("wy-slot"));
    find();
    const mo = new MutationObserver(find);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [viewing]);
  // On a phone's home, the toasts take their place in the page, above "Right now" (Code.tsx #wy-home), rather than float over the
  // list a person opened the home to read (Arun, 2026-10-28: "iron everything and ensure we are good").
  const [homeSlot, setHomeSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (viewing) return setHomeSlot(null);
    const narrow = matchMedia("(max-width: 640px)");
    const find = () => setHomeSlot(narrow.matches ? document.getElementById("wy-home") : null);
    find();
    const mo = new MutationObserver(find);
    mo.observe(document.body, { childList: true, subtree: true });
    narrow.addEventListener("change", find);
    return () => {
      mo.disconnect();
      narrow.removeEventListener("change", find);
    };
  }, [viewing]);
  // What the last answer did, for a screen reader; the cards themselves come and go.
  const [said, setSaid] = useState("");
  const box = useRef<HTMLElement | null>(null);
  // How tall the stack is, for the page to keep that much room at its foot on a phone (style.css --wy-h), so a button the
  // toasts sit over can still be scrolled clear of them. One observer for as long as the stack is on the page, through a
  // callback ref: an effect that redid it on every render dropped the height for a layout pass each time, and a page
  // scrolled to its foot was pulled back under the toasts. Gone only when the stack is.
  const sizer = useRef<ResizeObserver | null>(null);
  const setBox = useCallback((el: HTMLElement | null) => {
    box.current = el;
    sizer.current?.disconnect();
    sizer.current = null;
    const root = document.documentElement;
    // In the page's own flow (homeSlot) it covers nothing, and the page needs no room kept for it.
    if (!el || el.classList.contains("in-home")) {
      root.style.removeProperty("--wy-h");
      return;
    }
    const ro = new ResizeObserver(() => root.style.setProperty("--wy-h", `${Math.round(el.getBoundingClientRect().height)}px`));
    ro.observe(el);
    sizer.current = ro;
  }, []);
  const live = (
    <span className="sr-only" role="status">
      {said}
    </span>
  );
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);
  // Everything still waiting elsewhere, which the header's pill counts as the sidebar does; dismissing a toast hides that toast,
  // not the wait (2026-10-27 audit: the pill went for good once its item was dismissed, while the sidebar still said "Needs you 1").
  let here = (_sid: string) => true;
  // In Work, Work's waits; in Code, Code's: the other place's are its dot on the sidebar's switch. "1 waiting on you" in Work was a
  // Code session's question (QA, 2026-10-28; Arun: "TEST EVERYTHING… EVERY INTERACTION"). Crew keeps them all.
  const [workOn] = useWorkMode();
  const [crewOn] = useTeamTab();
  const inWork = viewing ? isWorkSid(viewing) : workOn;
  if (!crewOn) here = (sid) => isWorkSid(sid) === inWork;
  const counted = items.filter((it) => it.sid !== viewing && here(it.sid) && !done.has(keyOf(it)) && recents.some((r) => r.sid === it.sid));
  const inHeader = !!viewing && !!slot;
  // The toasts in the corner leave out what was dismissed; the list the pill opens, asked for, has them all.
  const shown = inHeader ? counted : counted.filter((it) => !dismissed.has(keyOf(it)));
  // One line for what arrived, rather than the cards read out whole.
  const seen = useRef(new Set<string>());
  const shownKeys = shown.map(keyOf).join("|");
  useEffect(() => {
    const fresh = shown.filter((it) => !seen.current.has(keyOf(it)));
    if (fresh.length === 1) setSaid(`${WHY[fresh[0]!.kind]}: ${fresh[0]!.title}`);
    else if (fresh.length > 1) setSaid(`${fresh.length} more waiting on you`);
    seen.current = new Set(shown.map(keyOf));
    if (fresh.length) (setRest(false), (since.current = Date.now()));
  }, [shownKeys]); // eslint-disable-line react-hooks/exhaustive-deps
  // Out of the way once seen. The toasts in the corner sat over whatever was under them for as long as the wait lasted (forty
  // minutes over Settings' Interface size, a workflow's "Remove step"), and a press meant for that opened the session instead
  // (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL"). Now they show in full when something arrives, and
  // after a few seconds untouched, or at a press anywhere else, fold away: into the sidebar's Needs you when it is on screen,
  // else into a small pill in the corner that opens them again.
  const [rest, setRest] = useState(false);
  const since = useRef(Date.now());
  const held = useRef(false);
  const floats = !inHeader && !homeSlot && shown.length > 0;
  useEffect(() => {
    if (!floats || rest) return;
    since.current = Date.now();
    const t = setInterval(() => !held.current && Date.now() - since.current > 8000 && setRest(true), 1000);
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setRest(true);
    document.addEventListener("pointerdown", away, true);
    return () => {
      clearInterval(t);
      document.removeEventListener("pointerdown", away, true);
    };
  }, [floats, rest]);
  const hold = (on: boolean) => {
    held.current = on;
    since.current = Date.now();
  };
  if (!shown.length) return live;
  if (floats && rest) {
    // The sidebar already lists every wait under Needs you: when that is on screen, nothing more floats.
    const needs = document.querySelector('[data-sidebar="group-label"] .dass-dot[data-state="needs"]')?.getBoundingClientRect();
    if (needs && needs.width > 0 && needs.right > 0 && needs.left < innerWidth && needs.top >= 0 && needs.bottom <= innerHeight) return live;
    return (
      <>
        {live}
        <section className="wy-toasts at-rest" aria-label="Needs you">
          <button type="button" className="wy-pill" aria-label={`${shown.length} waiting on you: show`} title="Show what is waiting on you" onClick={() => setRest(false)}>
            <Icon name="hand" size={13} />
            {shown.length} waiting on you
          </button>
        </section>
      </>
    );
  }
  const answer = async (it: Attention, approve: boolean) => {
    const r = recents.find((x) => x.sid === it.sid);
    if (!r || !it.approval || busy) return;
    setBusy(keyOf(it));
    setError("");
    try {
      await api(identity, `/api/sessions/${encodeURIComponent(it.sid)}/answer?invite=${encodeURIComponent(r.invite)}`, { method: "POST", body: JSON.stringify({ lane: it.lane, id: it.approval, approve }) });
      setDone((d) => new Set(d).add(keyOf(it)));
      // The sidebar's count and its Needs you list follow at once.
      window.dispatchEvent(new Event("friday:attention"));
      setSaid(`${approve ? (it.command ? "Running it" : "Let it go ahead") : "Said no"}: ${it.title}`);
      // The card goes, and focus goes with it: to the next card, else to the page's heading, never to nowhere.
      requestAnimationFrame(() => {
        const next = box.current?.querySelector<HTMLElement>(".wy-toast .wy-open");
        (next ?? document.querySelector<HTMLElement>("main h1, .home h1, main, .main"))?.focus();
      });
    } catch (e) {
      setError((e as Error).message);
      setErrorFor(keyOf(it));
    } finally {
      setBusy("");
    }
  };
  // A toast each, in the corner of the window, newest at the bottom. None goes by itself: each stays until it is closed
  // or answered, because an agent asking first is stopped until somebody does.
  const SHOWN = 3;
  const pill = inHeader
    ? createPortal(
        <button type="button" className={`wy-pill${open ? " on" : ""}`} aria-expanded={open} aria-label={`${shown.length} waiting on you`} onClick={() => setOpen((o) => !o)} title="Other sessions waiting on you">
          <Icon name="hand" size={13} />
          {shown.length}
          {/* A narrow header (a Mac window with Team chat open) keeps the hand and the count, and drops the words. */}
          <span className="wy-pill-words"> waiting on you</span>
        </button>,
        slot,
      )
    : null;
  if (inHeader && !open)
    return (
      <>
        {live}
        {pill}
      </>
    );
  const list = (
    <section
      ref={setBox}
      className={`wy-toasts${inHeader ? " in-session" : homeSlot ? " in-home" : ""}`}
      aria-label="Needs you"
      onPointerEnter={() => hold(true)}
      onPointerLeave={() => hold(false)}
      onFocus={() => hold(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && hold(false)}
    >
      {shown.length > SHOWN && (
        <div className="wy-more">
          {shown.length - SHOWN} more waiting on you
          <button type="button" className="wy-x" aria-label="Dismiss all" title="Dismiss all" onClick={() => dismiss(shown)}>
            <Icon name="x" size={12} />
          </button>
        </div>
      )}
      {shown.slice(0, SHOWN).map((it) => {
        const r = recents.find((x) => x.sid === it.sid)!;
        const kind = KIND[it.kind];
        return (
          <div key={keyOf(it)} className={`wy-toast ${it.kind}`} role="group" aria-label={`${WHY[it.kind]}: ${it.title}`}>
            <div className="wy-toast-top">
              {/* The session first, as the list names it; then what is waiting, in the words it was said. Pressing it opens the session. */}
              <button
                type="button"
                className="wy-open"
                onClick={() => {
                  // At its card, not wherever the session happens to open: the answer is given there.
                  if (it.kind === "ask")
                    try {
                      sessionStorage.setItem(ASK_FOCUS, `${it.sid}:${it.seq}`);
                    } catch {
                      // Blocked storage: the session still opens, at its newest.
                    }
                  onOpen(r);
                }}
                title={`${WHY[it.kind]} · open ${it.title}`}
              >
                <span className="wy-icon" aria-hidden>
                  <Icon name={kind.icon} size={16} />
                </span>
                <span className="wy-body">
                  <span className="wy-title">{it.title}</span>
                  <span className="wy-what">
                    {kind.lead(it)}
                    {it.kind === "stopped" ? (/^Stopped on an error\b/.test(it.text) ? "" : it.text.replace(/^Stopped: /, "")) : withCode(shortPaths(it.text))}
                  </span>
                </span>
              </button>
              {/* Off the screen, not out of the session: its row in the list still says it needs you. */}
              <button type="button" className="wy-x" aria-label={`Dismiss ${it.title}`} title="Dismiss" onClick={() => dismiss([it])}>
                <Icon name="x" size={13} />
              </button>
            </div>
            {it.approval && (
              <div className="wy-actions">
                <button type="button" className="btn small ghost" aria-disabled={busy ? true : undefined} onClick={() => void answer(it, false)}>
                  Don't
                </button>
                <button type="button" className="btn small primary" aria-disabled={busy ? true : undefined} onClick={() => void answer(it, true)}>
                  {busy === keyOf(it) ? "Sending…" : it.command ? "Run it" : "Let it"}
                </button>
              </div>
            )}
            {error && keyOf(it) === errorFor && (
              <p className="wy-error" role="alert">
                {error}
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
  return (
    <>
      {live}
      {pill}
      {homeSlot ? createPortal(list, homeSlot) : list}
    </>
  );
}
