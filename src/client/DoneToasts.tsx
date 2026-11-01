import { useEffect, useRef, useState } from "react";
import { doneChime } from "./chime.js";
import { doneChimeOn } from "./prefs.js";
import "./done-toasts.css";

/**
 * An agent finished somewhere you weren't looking (Herdr's "done" toast and sound, 2026-11-01): a soft sound, and while Friday's
 * window is in sight a small toast that opens the session when pressed and goes by itself. Nothing for the session on screen,
 * whose own chat already shows it; with the window hidden the system notification says it (Attention.tsx notifyDone).
 */
export type Done = { sid: string; title: string; what: string };

/** Said by the attention poll as a run ends (Attention.tsx). */
export const sayDone = (d: Done) => void window.dispatchEvent(new CustomEvent<Done>("friday:done", { detail: d }));

/** How long a toast stays, unless the pointer is on it. */
const SHOWN_MS = 7000;
/** The most shown at once: the newest. */
const MAX = 3;

export function DoneToasts({ activeSid }: { activeSid: string | null }) {
  const [shown, setShown] = useState<(Done & { id: number })[]>([]);
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
      // The session you're looking at: its chat says so already.
      if (looking && d.sid === active.current) return;
      if (doneChimeOn()) doneChime();
      if (document.visibilityState !== "visible") return;
      const id = ++n;
      setShown((s) => [...s.filter((x) => x.sid !== d.sid), { ...d, id }].slice(-MAX));
      const t = setTimeout(() => (timers.delete(t), drop(id)), SHOWN_MS);
      timers.add(t);
    };
    addEventListener("friday:done", on);
    return () => {
      removeEventListener("friday:done", on);
      for (const t of timers) clearTimeout(t);
    };
  }, []);
  // Opened from elsewhere (the sidebar): its toast has said what it had to.
  useEffect(() => setShown((s) => s.filter((x) => x.sid !== activeSid)), [activeSid]);
  if (!shown.length) return null;
  return (
    <section className="done-toasts" aria-label="Finished" aria-live="polite" onPointerEnter={() => (held.current = true)} onPointerLeave={() => (held.current = false)}>
      {shown.map((d) => (
        <button key={d.id} type="button" className="done-toast" onClick={() => (window.dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid: d.sid } })), setShown((s) => s.filter((x) => x.id !== d.id)))}>
          <span className="done-toast-dot" aria-hidden="true" />
          <span className="done-toast-text">
            <span className="done-toast-title">{d.title}</span>
            {/* A lane by its name; the session's own agent ("Main") goes without saying. */}
            <span className="done-toast-what">Finished{d.what && d.what !== "Main" ? ` · ${d.what}` : ""}</span>
          </span>
        </button>
      ))}
    </section>
  );
}
