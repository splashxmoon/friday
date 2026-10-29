import { useEffect, useState } from "react";
import { reduceMotion } from "./prefs.js";

/**
 * The question at the top of a new session, asked a different way each time.
 *
 * One fixed line stops being read after the third session — it becomes part of
 * the furniture. A line that changes gets read, and each of these frames the
 * same box differently: some invite a feature, some a bug, some a question
 * about code nobody has touched in a year. Between them they say, without a
 * paragraph of onboarding, that this is not only for writing new things.
 *
 * It flips rather than fades because a flip reads as the same sign turning
 * over — one thing saying something else — where a crossfade reads as two
 * things swapping, which is a busier idea than this deserves.
 */
const LINES = [
  "What should we build?",
  "What's the agenda?",
  "What are we shipping?",
  "What needs fixing?",
  "Where should we start?",
  "What's broken?",
  "What are we changing?",
  "What should we look at?",
  "What's the plan?",
  "What's next?",
  "What have we been putting off?",
  "What should we clean up?",
  "What would you like to understand?",
  "What's slowing you down?",
  "What needs a second pair of eyes?",
  "What should we try?",
];

/** Long enough to read it and forget it is changing; short enough to notice. */
const HOLD_MS = 5200;

export function HeroTitle({ lines = LINES }: { /** Lines of its own, for a page that asks something else. */ lines?: string[] }) {
  // Start somewhere different each visit, so the first line is not always the
  // same one — the whole point is that it does not become furniture.
  const [at, setAt] = useState(() => Math.floor(Math.random() * lines.length));

  useEffect(() => {
    // Nobody needs a headline moving while they are trying to type under it: not with less motion asked for, here in Settings
    // as well as by the OS (prefs reduceMotion), read at each turn so a change there counts at once; not while writing in the box
    // under it; and not with the pointer on that box or one of its menus open, where a turn that rewrapped the headline moved
    // the box under the pointer (Arun, 2026-10-28: "iron everything and ensure we are good… any logic errors and fixes").
    const busy = () => reduceMotion() || !!document.activeElement?.matches("textarea, input") || !!document.querySelector(".hero-title ~ :is(form, .composer-above):hover, [role=menu], [role=listbox], [role=dialog]");
    const t = setInterval(() => !busy() && setAt((i) => (i + 1) % lines.length), HOLD_MS);
    return () => clearInterval(t);
  }, [lines.length]);

  return (
    <h1 className="hero-title">
      {/* aria-live would read every line out to a screen reader as it turned,
          which is noise. The heading announces once, as headings do. */}
      <span className="hero-flip">
        <span key={`${lines[0]}:${at}`}>{lines[at % lines.length]}</span>
      </span>
    </h1>
  );
}
