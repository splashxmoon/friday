import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FridayMark } from "./BrandMarks.js";
import { isLocal } from "./edition.js";
import { GitHubConnect, useGithub } from "./GitHubConnect.js";
import { Icon, type IconName } from "./icons.js";
import { RELEASES, connectThisComputer, useMachine } from "./local.js";
import { MachineBadge } from "./MachineBadge.js";
import { openOutside } from "./openOutside.js";
import type { Identity } from "./storage.js";

/**
 * Getting set up, for someone new (Arun, 2026-10-25: "instead of the tour on load we should have a modal or something where it
 * can help the user get setup... like adding/auto linking up coding tools"), one step at a time (2026-10-26: "make the let's get
 * you setup thing like a step form kinda thing instead of one big vertical modal"). This computer connected (the desktop app does
 * it by itself; a browser is shown the one command), the coding tools on it found and signed in (the same card the corner badge
 * opens, so installing or signing one in is a press here), and GitHub, for pull requests. The rail along the top says where each
 * stands and goes to any of them; it opens on the first that still needs something, and moves on by itself when the one showing
 * comes true. Skippable at every point; back from Settings · About any time. The tour waits behind it.
 */

const keyFor = (userId: string) => `mpa.setup.${userId}`;
const TOUR_KEY = (userId: string) => `mpa.tour.${userId}`;
const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return "done";
  }
};
const write = (k: string) => {
  try {
    localStorage.setItem(k, "done");
  } catch {}
};
/** Put off, with no coding tool ready, until Friday next opens. */
const SKIPPED = "friday.setup.skipped";
const skipped = () => {
  try {
    return sessionStorage.getItem(SKIPPED) === "1";
  } catch {
    return true;
  }
};
const skip = () => {
  try {
    sessionStorage.setItem(SKIPPED, "1");
  } catch {}
};

type StepId = "computer" | "tools" | "github";
interface Step {
  id: StepId;
  /** On the rail. */
  label: string;
  icon: IconName;
  done: boolean;
  title: string;
  body: string;
}

/** Which step to show first: the first that still needs something, else the last. */
export function firstOpen(steps: { done: boolean }[]): number {
  const i = steps.findIndex((s) => !s.done);
  return i === -1 ? steps.length - 1 : i;
}

/** The step showing has just come true: the same step, not done before and done now. A different step (Back, a chip) never is. */
export function becameDone(was: { id: string; done: boolean }, now: { id: string; done: boolean }): boolean {
  return was.id === now.id && !was.done && now.done;
}

export function Setup({ identity, hasHistory, onDone }: { identity: Identity; hasHistory: boolean; /** Pressed Start: the box is theirs. */ onDone: () => void }) {
  const k = keyFor(identity.id);
  const [open, setOpen] = useState(false);
  const { state: machine, refresh } = useMachine(identity);
  const connected = machine.mode === "local" || machine.mode === "linked";
  const tools = machine.tools.filter((t) => t.path);
  const signedIn = tools.filter((t) => t.loggedIn !== false);
  // Someone new; and, until a coding tool is ready, someone who hasn't started a session yet, each time Friday opens ("Skip for
  // now" puts it off until the next): once and never again left a fresh install that skipped it with nothing that works and
  // nothing saying so (Arun, 2026-10-30: the first few minutes after install are where people quit). Anyone who asks, from Settings.
  const unready = connected && signedIn.length === 0;
  useEffect(() => {
    if (!identity.id || hasHistory) return void (identity.id && hasHistory && write(k));
    if (read(k) && (!unready || skipped())) return;
    const t = setTimeout(() => setOpen(true), 600);
    return () => clearTimeout(t);
  }, [identity.id, hasHistory, k, unready]);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener("friday:setup", on);
    return () => window.removeEventListener("friday:setup", on);
  }, []);
  const gh = useGithub(identity, open && connected);
  const desktop = typeof window !== "undefined" && !!window.fridayDesktop?.link;
  const finish = (started: boolean) => {
    write(k);
    if (!signedIn.length) skip();
    // The tour doesn't come for someone who has just been through this; it stays a press away in Settings · About.
    write(TOUR_KEY(identity.id));
    setOpen(false);
    if (started) onDone();
  };

  const all: Step[] = [
    {
      id: "computer",
      label: "Computer",
      icon: "server",
      done: connected,
      title: connected ? `${machine.machine?.name ?? "This computer"} is connected` : "Connect this computer",
      body: connected ? "Your coding tools run here; Friday drives them." : desktop ? "The app connects it by itself; this moves on in a moment." : "Your coding tools run on your own computer. One command in a terminal connects it, or the desktop app does it for you.",
    },
    {
      id: "tools",
      label: "Coding tools",
      icon: "terminal",
      done: connected && tools.length > 0 && signedIn.length === tools.length,
      title: !connected ? "Your coding tools" : tools.length === 0 ? "No coding tool found yet" : signedIn.length === tools.length ? `${tools.length === 1 ? tools[0]!.name : `${tools.length} coding tools`} ready` : `${tools.length - signedIn.length} of ${tools.length} to sign in`,
      body: !connected ? "Found on your computer once it is connected: Claude Code, Codex, Cursor and the rest, each on your own plan." : tools.length === 0 ? "Install one and it shows here; Friday runs whichever you have." : "Signed-in ones run from here; the others take one press.",
    },
    {
      id: "github",
      label: "GitHub",
      icon: "commit",
      done: !!gh.status?.connected,
      title: gh.status?.connected ? `GitHub: @${gh.status.login ?? "connected"}` : "Connect GitHub",
      body: gh.status?.connected ? "Pull requests, issues and Code Review read as you." : "For pull requests, issues and Code Review. Optional; this computer's own login is used.",
    },
  ];
  // On someone's own computer (the open-source edition) Friday is the computer: there is nothing to connect.
  const steps = isLocal() ? all.filter((s) => s.id !== "computer") : all;
  const doneCount = steps.filter((s) => s.done).length;

  const [at, setAt] = useState(0);
  // Opened: on the first step that still needs something.
  const placed = useRef(false);
  useEffect(() => {
    if (!open) return void (placed.current = false);
    if (placed.current || machine.mode === "checking") return;
    placed.current = true;
    setAt(firstOpen(steps));
  }, [open, machine.mode]); // eslint-disable-line react-hooks/exhaustive-deps
  // The step showing comes true (the app connecting, a sign-in finishing): on to the next, a beat later so the tick is seen.
  // Only that step coming true counts: going Back (or pressing a chip) to a step already done is not it becoming done, so it
  // stays put (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL"; Back bounced forward again after 0.9 s).
  const showing = steps[Math.min(at, steps.length - 1)]!;
  const wasDone = useRef({ id: showing.id, done: showing.done });
  useEffect(() => {
    const was = wasDone.current;
    wasDone.current = { id: showing.id, done: showing.done };
    if (!open || !becameDone(was, showing) || at >= steps.length - 1) return;
    const t = setTimeout(() => setAt((a) => (a === at ? a + 1 : a)), 900);
    return () => clearTimeout(t);
  }, [showing.id, showing.done, at, open, steps.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && finish(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open) return null;

  const i = Math.min(at, steps.length - 1);
  const last = i === steps.length - 1;
  const next = () => (last ? finish(true) : setAt(i + 1));
  const howMany = steps.length === 2 ? "Two things" : "Three things";

  return createPortal(
    <div className="overlay setup-overlay" role="dialog" aria-modal="true" aria-label="Get set up">
      <div className="setup-card">
        <header className="setup-head">
          <span className="tour-mark">
            <FridayMark size={24} />
          </span>
          <div>
            <h2>Let's get you set up</h2>
            <p>
              {howMany}, and your first session is a sentence away. {doneCount === steps.length ? "All done." : `${doneCount} of ${steps.length} done.`}
            </p>
          </div>
          <button type="button" className="icon-btn tiny setup-x" aria-label="Skip for now" title="Skip for now" onClick={() => finish(false)}>
            <Icon name="x" size={14} />
          </button>
        </header>

        <ol className="setup-rail" aria-label="Steps">
          {steps.map((s, n) => (
            <li key={s.id} className={`setup-rail-step${n === i ? " on" : ""}${s.done ? " done" : ""}`}>
              <button type="button" aria-current={n === i ? "step" : undefined} onClick={() => setAt(n)}>
                <span className="setup-tick" aria-hidden>
                  {s.done ? <Icon name="check" size={12} /> : n + 1}
                </span>
                <span className="setup-rail-label">{s.label}</span>
              </button>
            </li>
          ))}
        </ol>

        <section className={`setup-panel${showing.done ? " done" : ""}`} aria-live="polite" key={showing.id}>
          <div className="setup-panel-head">
            <span className="setup-panel-icon" aria-hidden>
              <Icon name={showing.done ? "check" : showing.icon} size={16} />
            </span>
            <div>
              <h3>{showing.title}</h3>
              <p>{showing.body}</p>
            </div>
          </div>
          <div className="setup-panel-body">
            {showing.id === "computer" && !connected && (
              <div className="setup-acts">
                {desktop ? (
                  <span className="muted small">
                    <span className="sr-spin" aria-hidden /> Connecting…
                  </span>
                ) : (
                  <>
                    <button type="button" className="btn primary small" onClick={connectThisComputer}>
                      Connect this computer
                    </button>
                    <button type="button" className="btn ghost small" onClick={() => openOutside(RELEASES)}>
                      Get the desktop app
                    </button>
                  </>
                )}
              </div>
            )}
            {showing.id === "tools" && connected && <MachineBadge inline identity={identity} machine={machine} refresh={refresh} />}
            {showing.id === "tools" && !connected && <p className="muted small setup-wait">Connect this computer first, and its coding tools show here.</p>}
            {showing.id === "github" && connected && !gh.status?.connected && <GitHubConnect bare identity={identity} />}
          </div>
        </section>

        <footer className="setup-foot">
          {/* No tour in the open-source edition (Arun, 2026-10-26: "get rid of the tour on the open source version"). */}
          {i === 0 && isLocal() ? (
            <span />
          ) : i === 0 ? (
            <button type="button" className="tour-skip" onClick={() => (finish(false), window.dispatchEvent(new Event("friday:tour")))}>
              Take the one-minute tour instead
            </button>
          ) : (
            <button type="button" className="tour-back" onClick={() => setAt(i - 1)}>
              Back
            </button>
          )}
          <span className="tour-nav">
            {!showing.done && !last && (
              <button type="button" className="tour-skip" onClick={next}>
                Skip for now
              </button>
            )}
            <button type="button" className={`tour-next${showing.done ? "" : " quiet"}`} autoFocus onClick={next}>
              {last ? (doneCount === steps.length ? "Start" : "Start anyway") : "Next"}
            </button>
          </span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
