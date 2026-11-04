import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EngineMark, FridayMark, GitHubMark } from "./BrandMarks.js";
import { WELCOME_TOOLS } from "./engines.js";
import { isLocal } from "./edition.js";
import { GitHubConnect, useGithub } from "./GitHubConnect.js";
import { Icon, type IconName } from "./icons.js";
import { RELEASES, connectThisComputer, useMachine } from "./local.js";
import { MachineBadge } from "./MachineBadge.js";
import { openOutside } from "./openOutside.js";
import type { Identity, RecentSession } from "./storage.js";
import { isTeamSid, useTeamNow } from "./Teammates.js";
import { answerUsage, noticeDue, useUsageSharing, WHAT } from "./UsageSharing.js";
import { CrewFaces } from "./WhatsNew.js";
import { Switch } from "@/components/ui/switch";

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

export function Setup({ identity, recents, onDone }: { identity: Identity; recents: RecentSession[]; /** Pressed Start: the box is theirs. */ onDone: () => void }) {
  const k = keyFor(identity.id);
  // Someone with sessions of their own is not new. The Crew room is Friday's, not theirs: the Crew room is made
  // as Friday starts, so counting it marked every fresh install as set up before the welcome could show (2026-11-01). Which
  // sessions are the Crew's is known once the crew is: until then (a moment), nothing is decided.
  const t = useTeamNow();
  const [teamLate, setTeamLate] = useState(false);
  useEffect(() => void setTimeout(() => setTeamLate(true), 4000), []);
  const known = !isLocal() || !!t || teamLate;
  const hasHistory = recents.some((r) => !isTeamSid(r.sid));
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
    if (!known) return;
    if (!identity.id || hasHistory) return void (identity.id && hasHistory && write(k));
    if (read(k) && (!unready || skipped())) return;
    const t = setTimeout(() => setOpen(true), 600);
    return () => clearTimeout(t);
  }, [identity.id, hasHistory, k, unready, known]);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener("friday:setup", on);
    return () => window.removeEventListener("friday:setup", on);
  }, []);
  const gh = useGithub(identity, open && connected);
  const [ghOpen, setGhOpen] = useState(false);
  const desktop = typeof window !== "undefined" && !!window.fridayDesktop?.link;
  // The open-source edition's usage counts, asked here rather than only in the sidebar (UsageSharing.tsx): on until changed, and
  // answered by going on from the welcome or by changing it. Leaving with "Set up later" untouched answers nothing; the sidebar
  // asks then. Kept up once asked, so the row doesn't vanish under the person's hand as it's answered.
  const usage = useUsageSharing();
  const [askUsage, setAskUsage] = useState(false);
  useEffect(() => void (open && noticeDue(usage) && setAskUsage(true)), [open, usage]);
  const [share, setShare] = useState(true);
  const [shareTouched, setShareTouched] = useState(false);
  const answer = (started: boolean) => {
    if (askUsage && noticeDue(usage) && (started || shareTouched)) void answerUsage(share);
  };
  const finish = (started: boolean) => {
    answer(started);
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
  // The open-source welcome's own three steps, from the first each time it opens.
  const [ob, setOb] = useState(0);
  const gutter = useGutter();
  useEffect(() => void (open && setOb(0)), [open]);
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

  // Escape leaves as the latest render would (the usage answer above changes after the box opens).
  const finishNow = useRef(finish);
  finishNow.current = finish;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && finishNow.current(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open) return null;

  const i = Math.min(at, steps.length - 1);
  const last = i === steps.length - 1;
  const next = () => (last ? finish(true) : setAt(i + 1));
  const howMany = steps.length === 2 ? "Two things" : "Three things";

  // On someone's own computer: a welcome in three short steps, in What's new's frame (Arun, 2026-11-03: "Use this same design
  // can redesign the onboarding", then of one sheet or three steps, "B"). What Friday is, the coding tools (the five people know
  // and any other here that's ready, each a press from signed in or installed), then GitHub and the usage counts, both optional.
  if (isLocal()) {
    // Counted as the list shows them: the five, and any other that is surely signed in (MachineBadge, welcome).
    const shownReady = signedIn.filter((t) => WELCOME_TOOLS.includes(t.tool) || t.loggedIn === true);
    const ready = shownReady[0] ?? signedIn[0];
    const toSign = tools.find((t) => t.loggedIn === false);
    const status = machine.mode === "checking" ? "Looking…" : ready ? `${shownReady.length <= 1 ? ready.name : `${shownReady.length} tools`} ready` : toSign ? "Sign in to one to start" : "Install one to start";
    const n = Math.min(ob, 2);
    const back = () => setOb(n - 1);
    return createPortal(
      <div className="overlay setup-overlay wn-overlay" role="dialog" aria-modal="true" aria-label="Welcome to Friday">
        <section className="wn ob">
          <div className={`wn-hero${n === 1 ? " ob-hero-tools" : ""}`} aria-hidden="true">
            {n === 1 ? <ToolMarks ready={shownReady.map((t) => t.tool)} /> : <CrewFaces />}
          </div>
          <span className="wn-ver ob-steps" aria-label={`Step ${n + 1} of 3`}>
            {[0, 1, 2].map((k) => (
              <i key={k} className={k === n ? "on" : k < n ? "done" : ""} />
            ))}
            <span>{n + 1} of 3</span>
          </span>
          <button type="button" className="wn-x" aria-label="Set up later" title="Set up later" onClick={() => finish(false)}>
            <Icon name="x" size={14} />
          </button>

          <div className="wn-body" key={n}>
            {n === 0 && (
              <>
                <h2>Welcome to Friday</h2>
                <p className="wn-sub">Your coding agents, working together on this computer, on the plans you already pay for.</p>
                <ul className="wn-grid">
                  {POINTS.map((p) => (
                    <li key={p.title}>
                      <span className="wn-tile" aria-hidden="true">
                        <Icon name={p.icon} size={15} />
                      </span>
                      <span className="wn-item">
                        <b>{p.title}</b>
                        <span>{p.line}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {n === 1 && (
              <>
                <h2>Pick a coding tool</h2>
                <p className="wn-sub">Friday drives the tools you already have, each on your own plan. One is enough to start; add the rest any time.</p>
                <div className="ob-label" aria-live="polite">
                  <b>On this computer</b>
                  <span data-ready={ready ? "true" : undefined}>{status}</span>
                </div>
                <div className="ob-tools ob-scroll" ref={gutter}>
                  {connected ? (
                    <MachineBadge inline welcome identity={identity} machine={machine} refresh={refresh} />
                  ) : (
                    <p className="ob-wait">
                      <span className="spinner" aria-hidden /> Looking for your coding tools…
                    </p>
                  )}
                </div>
              </>
            )}
            {n === 2 && (
              <>
                <h2>{ready ? "Your crew is ready" : "Nearly there"}</h2>
                <p className="wn-sub">All optional, and each one waits for you if you skip it now.</p>
                <ul className="ob-list ob-scroll" ref={gutter}>
                  <li className="ob-row">
                    <span className="wn-tile ob-tile" aria-hidden="true">
                      <Icon name="folder" size={15} />
                    </span>
                    <span className="wn-item">
                      <b>Your project</b>
                      <span>A folder or repo to work in, on a branch of its own.</span>
                    </span>
                    {/* The box's own folder picker, behind this sheet: the welcome closes first so it's seen. */}
                    <button type="button" className="btn small" onClick={() => (finish(true), setTimeout(() => document.querySelector<HTMLButtonElement>(".cw-drop")?.click(), 0))}>
                      Pick a folder
                    </button>
                  </li>
                  <li className="ob-row">
                    <span className="wn-tile ob-tile" aria-hidden="true">
                      <GitHubMark size={16} />
                    </span>
                    <span className="wn-item">
                      <b>GitHub</b>
                      <span>{gh.status?.connected ? `Connected as @${gh.status.login ?? "you"}` : "For pull requests and issues, as you."}</span>
                    </span>
                    {gh.status?.connected ? (
                      <span className="ob-ready">
                        <Icon name="check" size={13} /> Connected
                      </span>
                    ) : (
                      <button type="button" className="btn small" aria-expanded={ghOpen} onClick={() => setGhOpen(!ghOpen)}>
                        {ghOpen ? "Hide" : "Connect"}
                      </button>
                    )}
                    {ghOpen && !gh.status?.connected && (
                      <div className="ob-row-body">
                        <GitHubConnect bare identity={identity} />
                      </div>
                    )}
                  </li>
                  {askUsage && (
                    <li className="ob-row">
                      <span className="wn-tile ob-tile" aria-hidden="true">
                        <Icon name="usage" size={15} />
                      </span>
                      <span className="wn-item">
                        <b id="wl-usage-label">Share anonymous usage counts</b>
                        <span>
                          How often Friday opens and which tools it finds. Never your code.{" "}
                          <button type="button" className="usage-notice-link" onClick={() => void openOutside(WHAT)}>
                            What's sent
                          </button>
                        </span>
                      </span>
                      <Switch
                        aria-labelledby="wl-usage-label"
                        checked={share}
                        onCheckedChange={(on) => {
                          setShare(on);
                          setShareTouched(true);
                        }}
                      />
                    </li>
                  )}
                </ul>
              </>
            )}
          </div>

          <footer className="wn-foot">
            {n === 0 ? (
              <button type="button" className="wn-notes" onClick={() => finish(false)}>
                Set up later
              </button>
            ) : (
              <button type="button" className="wn-notes" onClick={back}>
                <Icon name="arrowLeft" size={13} />
                Back
              </button>
            )}
            {n < 2 ? (
              <button type="button" className="btn small primary wn-got" autoFocus onClick={() => setOb(n + 1)}>
                {n === 0 ? "Get started" : "Next"}
              </button>
            ) : (
              <button type="button" className="btn small primary wn-got" autoFocus onClick={() => finish(true)}>
                {ready ? `Start with ${ready.name}` : "Look around first"}
              </button>
            )}
          </footer>
        </section>
      </div>,
      document.body,
    );
  }

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

/** What Friday is, in four, on the welcome's first step. */
const POINTS: { icon: IconName; title: string; line: string }[] = [
  { icon: "users", title: "A crew that stays", line: "Teammates with names and memory, working through their queue while you're away." },
  { icon: "key", title: "On plans you pay for", line: "Claude Code, Codex, Cursor and the rest run on your own sign-ins." },
  { icon: "shield", title: "Checked before it ships", line: "Your rules and your project's checks run on what the agents change." },
  { icon: "server", title: "Stays on this computer", line: "Your code, keys and sessions stay here. No account." },
];

// The welcome's five tools where the faces stand on its other steps: one even row, the largest in the middle, each lit and ticked
// once it's ready (Arun, 2026-11-03: "fix the placement of the coding tool icons").
const MARK_SIZES = [42, 50, 60, 50, 42];
function ToolMarks({ ready }: { ready: string[] }) {
  // The ready ones nearest the middle: the middle first, then either side of it, then the ends.
  const order = [...WELCOME_TOOLS].sort((a, b) => Number(!ready.includes(a)) - Number(!ready.includes(b)));
  const slots = [3, 1, 0, 2, 4].map((i) => order[i]!);
  return (
    <div className="ob-marks">
      {slots.map((t, k) => (
        <span key={t} className={`ob-mark${ready.includes(t) ? " ready" : ""}`} style={{ width: MARK_SIZES[k], height: MARK_SIZES[k] }}>
          <EngineMark tool={t} size={Math.round(MARK_SIZES[k]! * 0.44)} />
          {ready.includes(t) && (
            <i className="ob-ok">
              <Icon name="check" size={10} />
            </i>
          )}
        </span>
      ))}
    </div>
  );
}

/**
 * A scrolling list's rows end where the sheet's other lines do whatever scrollbar the system draws: none on a Mac (it floats over
 * the content), a strip that takes room on Windows and Linux. Its width is measured and taken off the room kept for it, as it
 * comes and goes with the list's length (Arun, 2026-11-04: "we need to ensure linux and windows").
 */
function useGutter() {
  return useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const set = () => el.style.setProperty("--sb", `${Math.max(0, el.offsetWidth - el.clientWidth)}px`);
    set();
    const watch = new ResizeObserver(set);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
}
