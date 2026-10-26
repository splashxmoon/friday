import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FridayMark } from "./icons.js";
import { isLocal, startTeam } from "./edition.js";

/**
 * A short guided tour for someone who has just installed Friday and signed up.
 *
 * It points at the real parts of the real screen, one at a time, and says what
 * each is for in a sentence a new person can use. It shows once, to people with
 * no history here (somebody who already has chats is not new, and is marked as
 * having seen it without being shown anything), it can be skipped at any point,
 * and it can be replayed from Settings.
 */
interface Step {
  id: string;
  /** What to point at. Absent: a card in the middle of the screen. */
  target?: string;
  place?: "right" | "below";
  title: string;
  body: string;
  /** What it says instead when the thing it points at is already done (a computer already connected). */
  done?: { when: string; title: string; body: string };
  /** A second, quieter action on the last step. */
  link?: { label: string; run: () => void };
}

const TEAM_STEPS: Step[] = [
  {
    id: "welcome",
    title: "Welcome to Friday Work",
    body: "A shared place where you, your team and AI agents work on code together. Here is a one-minute look around.",
  },
  {
    id: "ask",
    target: ".composer-card",
    place: "below",
    title: "Start with a sentence",
    body: "Describe what you want changed. Friday's agent gets to work, and teammates can join the session to watch and steer it live.",
  },
  {
    id: "tools",
    // The machine shows as a panel on the new-session page and as a pill elsewhere.
    target: ".mb-inline, .mb-anchor",
    place: "below",
    title: "Connect your computer",
    body: "Connect this computer and agents can work in your own folders. Friday finds Claude Code, Codex and Cursor on its own.",
    done: { when: ".mb-inline.on, .mb-pill.on", title: "Your computer is connected", body: "Agents work in your own folders, with the coding tools Friday found here. Switch between them from this panel." },
  },
  {
    id: "board",
    target: '[data-tour="Agent Board"]',
    place: "right",
    title: "See every agent at once",
    body: "The Agent Board lays out every agent working for you as cards: what needs you, what is running, what is in review and what is ready to merge.",
  },
  {
    id: "review",
    target: '[data-tour="Code Review"]',
    place: "right",
    title: "Your pull requests",
    body: "What is waiting on your review, what is failing and what merged this week, read from GitHub by your own machine.",
  },
];

const step = (id: string) => TEAM_STEPS.find((s) => s.id === id)!;

/**
 * The tour on Solo: your own coding tools, driven from one place. No team to bring, no connections or skills (Friday's own
 * agent uses those), and no allowance, because nothing on Solo is metered.
 */
const SOLO_STEPS: Step[] = [
  {
    id: "welcome",
    title: "Welcome to Friday Work",
    body: "Claude Code, Codex and Cursor in one place: side by side, handing work from one to another, on your own plans. Here is a one-minute look around.",
  },
  {
    id: "ask",
    target: ".composer-card",
    place: "below",
    title: "Start with a sentence",
    body: "Describe what you want changed and pick the code it is for. Your coding tool gets to work, and the job can move to another tool without starting over.",
  },
  step("tools"),
  step("board"),
  step("review"),
  // The open-source edition's last word: everything here is yours, on your computer; working with teammates is Friday Team.
  ...(isLocal()
    ? [
        {
          id: "team",
          title: "Yours, on your computer",
          body: "Your coding tools run on your own plans and nothing leaves this computer. To work in the same session with teammates, there's Friday Team.",
          link: { label: "See Friday Team", run: () => startTeam() },
        },
      ]
    : []),
];

const keyFor = (userId: string) => `mpa.tour.${userId}`;
const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return "done"; // Where it cannot be remembered, it is not shown: a tour that returns every visit is worse than none.
  }
};
const write = (k: string) => {
  try {
    localStorage.setItem(k, "done");
  } catch {
    // The tour comes back next visit; that is all.
  }
};

const CARD_W = 330;
const PAD = 6;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function Tour({ userId, hasHistory, onHome, solo = false, auto = true }: { userId: string; hasHistory: boolean; onHome: () => void; solo?: boolean; /** Start by itself for someone new. Off since the set-up card took that place (Setup.tsx): the tour is a press away from it and from Settings. */ auto?: boolean }) {
  const STEPS = solo ? SOLO_STEPS : TEAM_STEPS;
  const [at, setAt] = useState<number | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [cardH, setCardH] = useState(200);
  const card = useRef<HTMLDivElement>(null);
  const k = keyFor(userId);

  const finish = useCallback(() => {
    write(k);
    setAt(null);
  }, [k]);

  // Starts itself, once, for someone new (when asked to: the set-up card comes first now).
  useEffect(() => {
    if (!auto || !userId || read(k)) return;
    if (hasHistory) return write(k);
    const t = setTimeout(() => setAt(0), 700);
    return () => clearTimeout(t);
  }, [userId, hasHistory, k]);

  // Starts on request: from Settings, for anyone, any time.
  useEffect(() => {
    const on = () => {
      onHome();
      setTimeout(() => setAt(0), 250);
    };
    window.addEventListener("friday:tour", on);
    return () => window.removeEventListener("friday:tour", on);
  }, [onHome]);

  const step = at === null ? null : STEPS[at]!;

  // Where the thing being pointed at is, kept current as the window changes.
  useLayoutEffect(() => {
    if (!step?.target) return setRect(null);
    const measure = () => {
      const el = document.querySelector(step.target!);
      setRect(el ? el.getBoundingClientRect() : null);
      return !!el;
    };
    // A step whose target is not on screen (a narrow window, a folded sidebar) is skipped, not left pointing at nothing. Skipping
    // past the last finishes the tour, remembered: it ended unmarked and came back on every load.
    if (!measure()) {
      if (at !== null && at < STEPS.length - 1) setAt(at + 1);
      else finish();
      return;
    }
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    if (card.current) setCardH(card.current.offsetHeight);
  }, [step, rect]);

  const next = useCallback(() => (at !== null && at < STEPS.length - 1 ? setAt(at + 1) : finish()), [at, finish]);
  const back = useCallback(() => setAt((i) => (i !== null && i > 0 ? i - 1 : i)), []);

  useEffect(() => {
    if (at === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      // Enter on one of the card's own buttons (Skip, Back) is that button's: it used to go to the next step instead.
      else if (e.key === "Enter" && (e.target as HTMLElement | null)?.closest?.("button, a")) return;
      else if (e.key === "ArrowRight" || e.key === "Enter") next();
      else if (e.key === "ArrowLeft") back();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [at, next, back, finish]);

  if (!step || at === null) return null;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pos: { left: number; top: number } = !rect
    ? { left: (vw - CARD_W) / 2, top: Math.max(24, vh / 2 - cardH / 2 - 30) }
    : step.place === "right"
      ? { left: clamp(rect.right + PAD + 14, 12, vw - CARD_W - 12), top: clamp(rect.top + rect.height / 2 - cardH / 2, 12, vh - cardH - 12) }
      : { left: clamp(rect.left + rect.width / 2 - CARD_W / 2, 12, vw - CARD_W - 12), top: clamp(rect.bottom + PAD + 14, 12, vh - cardH - 12) };
  const last = at === STEPS.length - 1;
  const said = step.done && document.querySelector(step.done.when) ? step.done : step;

  return createPortal(
    <div className="tour" role="dialog" aria-modal="true" aria-label="Guided tour">
      {/* Takes the clicks: while the tour is up, the screen behind it waits. */}
      <div className="tour-block" onClick={(e) => e.stopPropagation()} />
      {rect ? <div className="tour-spot" style={{ left: rect.left - PAD, top: rect.top - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }} /> : <div className="tour-dim" />}
      <div className="tour-card" ref={card} style={{ left: pos.left, top: pos.top, width: CARD_W }}>
        {at === 0 && (
          <span className="tour-mark">
            <FridayMark size={28} />
          </span>
        )}
        <div className="tour-count">
          {at === 0 ? "Welcome" : `${at} of ${STEPS.length - 1}`}
          <span className="tour-dots" aria-hidden="true">
            {STEPS.slice(1).map((s, i) => (
              <i key={s.id} className={i + 1 <= at ? "on" : ""} />
            ))}
          </span>
        </div>
        <h2 className="tour-title">{said.title}</h2>
        <p className="tour-body">{said.body}</p>
        {last && step.link && (
          <button type="button" className="tour-link" onClick={() => (finish(), step.link!.run())}>
            {step.link.label}
          </button>
        )}
        <div className="tour-actions">
          {!last && (
            <button type="button" className="tour-skip" onClick={finish}>
              Skip tour
            </button>
          )}
          <span className="tour-nav">
            {at > 0 && (
              <button type="button" className="tour-back" onClick={back}>
                Back
              </button>
            )}
            <button type="button" className="tour-next" onClick={next} autoFocus>
              {at === 0 ? "Take the tour" : last ? "Done" : "Next"}
            </button>
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
