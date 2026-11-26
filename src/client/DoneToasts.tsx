import { useEffect, useRef, useState } from "react";
import { doneChime } from "./chime.js";
import { doneChimeOn } from "./prefs.js";
import { isLocal } from "./edition.js";
import { Icon } from "./icons.js";
import { openOutside } from "./openOutside.js";
import { REPO_URL } from "./whats-new.js";
import "./done-toasts.css";

/**
 * An agent finished somewhere you weren't looking (Herdr's "done" toast and sound, 2026-11-01): a soft sound, and while Friday's
 * window is in sight a small toast that opens the session when pressed and goes by itself. Nothing for the session on screen,
 * whose own chat already shows it; with the window hidden the system notification says it (Attention.tsx notifyDone).
 */
export type Done = { sid: string; title: string; what: string; /** Said as it is, not as "Finished · …": the summary of what was held while you typed (ide/quiet.ts). */ plain?: boolean };

/** Said by the attention poll as a run ends (Attention.tsx). */
export const sayDone = (d: Done) => void window.dispatchEvent(new CustomEvent<Done>("friday:done", { detail: d }));

/**
 * A star, asked for once (2026-11-25: "I want more users and stars and contributors"; about a thousand installs, under a hundred stars):
 * in the open-source app, under its Finished toasts, a moment after the first run that finishes while Friday is in sight, or on
 * the third day it is opened (a Code chat's finish is said in its own column, not here, so most never see a Finished toast). It
 * stays until Star or ×, and is never asked again. Settings › Help and What's new have the link for later.
 */
const STAR_ASKED = "friday.star.asked";
const starAsked = () => {
  try {
    return !!localStorage.getItem(STAR_ASKED);
  } catch {
    return true;
  }
};
const markStarAsked = () => {
  try {
    localStorage.setItem(STAR_ASKED, String(Date.now()));
  } catch {}
};
/** How long after the run finishes: its toast first. */
const STAR_AFTER_MS = 2500;
/** The days Friday was opened on, up to the third: then it asks. */
const STAR_DAYS = "friday.star.days";
const STAR_ON_DAY = 3;
/** How long after the window opens on that day: once it has settled. */
const STAR_OPEN_MS = 8000;
/** Today noted as a day Friday was opened; true once it has been opened on STAR_ON_DAY days. */
function openedOnEnoughDays(today = new Date().toDateString()): boolean {
  try {
    const days = (JSON.parse(localStorage.getItem(STAR_DAYS) ?? "[]") as unknown[]).filter((d): d is string => typeof d === "string");
    if (!days.includes(today)) days.push(today);
    localStorage.setItem(STAR_DAYS, JSON.stringify(days.slice(-STAR_ON_DAY)));
    return days.length >= STAR_ON_DAY;
  } catch {
    return false;
  }
}

/** How long a toast stays, unless the pointer is on it. */
const SHOWN_MS = 7000;
/** The most shown at once: the newest. */
const MAX = 3;

export function DoneToasts({ activeSid }: { activeSid: string | null }) {
  const [shown, setShown] = useState<(Done & { id: number })[]>([]);
  const [star, setStar] = useState(false);
  const active = useRef(activeSid);
  active.current = activeSid;
  const held = useRef(false);
  useEffect(() => {
    let n = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const drop = (id: number) => {
      // Not while it is being read: it goes when the pointer leaves.
      if (held.current) {
        const t = setTimeout(() => (timers.delete(t), drop(id)), 1500);
        timers.add(t);
        return;
      }
      setShown((s) => s.filter((x) => x.id !== id));
    };
    const on = (e: Event) => {
      const d = (e as CustomEvent<Done>).detail;
      const looking = document.visibilityState === "visible" && document.hasFocus();
      if (looking && isLocal() && !starAsked()) {
        markStarAsked();
        const t = setTimeout(() => (timers.delete(t), setStar(true)), STAR_AFTER_MS);
        timers.add(t);
      }
      // The session you're looking at: its chat says so already.
      if (looking && d.sid === active.current) return;
      if (doneChimeOn()) doneChime();
      if (document.visibilityState !== "visible") return;
      const id = ++n;
      setShown((s) => [...s.filter((x) => x.sid !== d.sid), { ...d, id }].slice(-MAX));
      const t = setTimeout(() => (timers.delete(t), drop(id)), SHOWN_MS);
      timers.add(t);
    };
    // What was held while you typed (ide/quiet.ts), as one toast: pressing it opens the one session, or Needs you when several.
    const onHeld = (e: Event) => {
      const d = (e as CustomEvent<{ title: string; what: string; sid: string | null }>).detail;
      if (doneChimeOn()) doneChime();
      if (document.visibilityState !== "visible") return;
      const id = ++n;
      setShown((s) => [...s.filter((x) => x.sid !== (d.sid ?? "")), { sid: d.sid ?? "", title: d.title, what: d.what, plain: true, id }].slice(-MAX));
      const t = setTimeout(() => (timers.delete(t), drop(id)), SHOWN_MS);
      timers.add(t);
    };
    addEventListener("friday:done", on);
    addEventListener("friday:held", onHeld);
    return () => {
      removeEventListener("friday:done", on);
      removeEventListener("friday:held", onHeld);
      for (const t of timers) clearTimeout(t);
    };
  }, []);
  // The third day it is opened: asked a while after the window settles, if still not asked and Friday is in sight.
  useEffect(() => {
    if (!isLocal() || starAsked() || !openedOnEnoughDays()) return;
    const t = setTimeout(() => {
      if (starAsked() || document.visibilityState !== "visible") return;
      markStarAsked();
      setStar(true);
    }, STAR_OPEN_MS);
    return () => clearTimeout(t);
  }, []);
  // Opened from elsewhere (the sidebar): its toast has said what it had to.
  useEffect(() => setShown((s) => s.filter((x) => x.sid !== activeSid)), [activeSid]);
  // None left (the last one clicked, which took the list away under the pointer, so it never heard the pointer leave): nothing is
  // being read, or every toast after it stayed until hovered and left (2026-11-02 review).
  if (!shown.length) held.current = false;
  if (!shown.length && !star) return null;
  return (
    <section className="done-toasts" aria-label="Finished" aria-live="polite" onPointerEnter={() => (held.current = true)} onPointerLeave={() => (held.current = false)}>
      {shown.map((d) => (
        <button key={d.id} type="button" className="done-toast" onClick={() => (window.dispatchEvent(d.sid ? new CustomEvent("friday:open-session", { detail: { sid: d.sid } }) : new Event("friday:open-needs")), setShown((s) => s.filter((x) => x.id !== d.id)))}>
          <span className="done-toast-dot" aria-hidden="true" />
          <span className="done-toast-text">
            <span className="done-toast-title">{d.title}</span>
            {/* A lane by its name; the session's own agent ("Main") goes without saying. */}
            <span className="done-toast-what">{d.plain ? d.what : `Finished${d.what && d.what !== "Main" ? ` · ${d.what}` : ""}`}</span>
          </span>
        </button>
      ))}
      {star && (
        <div className="done-toast star-ask" role="group" aria-label="Star Friday on GitHub">
          <span className="star-ask-mark" aria-hidden="true">
            <Icon name="star" size={14} />
          </span>
          <span className="done-toast-text">
            <span className="done-toast-title">Like Friday?</span>
            <span className="done-toast-what">A star helps others find it.</span>
          </span>
          <button type="button" className="btn small star-ask-go" onClick={() => (openOutside(REPO_URL), setStar(false))}>
            Star
          </button>
          <button type="button" className="star-ask-x" aria-label="Not now" title="Not now" onClick={() => setStar(false)}>
            <Icon name="x" size={12} />
          </button>
        </div>
      )}
    </section>
  );
}
