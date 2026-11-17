import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Shine } from "./shine.js";
import "./work-line.css";

/**
 * A crew mate at work, said as one line after its name: no bubble, no dots (Arun, 2026-11-17, of the mock beside the three-dots
 * bubble: "OK I LIKE PROPOSED!"). Its face beside it does the waiting: for the first two seconds there are no words at all, so a
 * short turn never flashes one; then what it is doing now, the light passing over it. Each step's words stay up a moment at least
 * and rise in as they change, so a run of quick steps reads as a sequence, not a flicker. A long think trades between a few ways
 * of saying it. With `onOpen`, the words are a button that unfolds its steps under the reply.
 */

const QUIET_MS = 2000;
const HOLD_MS = 900;
const TURN_MS = 2600;
/** A long step said a few ways, taken in turn. */
const SAID: Record<string, readonly string[]> = {
  Thinking: ["Thinking", "Working it out", "Weighing it up"],
  "Running the tests": ["Running the tests", "Checking the results"],
};

/** What a step is, for the face's eyes and motion beside it (work-line.css, style.css .rsp-avatar[data-doing]). */
export function doingOfWords(words: string): string {
  const w = words.toLowerCase();
  if (/^thinking|^planning|^working it out/.test(w)) return "think";
  if (/^search|^looking up|^browsing/.test(w)) return "search";
  if (/^read|^looking at|^opening/.test(w)) return "read";
  if (/^edit|^chang|^writing (to )?[\w./-]+\.\w+|^creat|^updat/.test(w)) return "edit";
  if (/^run|^build|^testing|^installing/.test(w)) return "run";
  if (/^writing/.test(w)) return "type";
  if (/^waiting/.test(w)) return "";
  return "work";
}

/**
 * The words for the step under way, as a working line says them: a new step waits until the last has been up its moment, and a long
 * one is said its other ways in turn (while `on`). Shared by the crew's line and the coding session's (run-line.tsx RunLine).
 */
export function useHeldWords(step: string, on = true): string {
  const [shown, setShown] = useState(step);
  const at = useRef(Date.now());
  useEffect(() => {
    if (step === shown) return;
    const t = setTimeout(() => ((at.current = Date.now()), setShown(step)), Math.max(0, HOLD_MS - (Date.now() - at.current)));
    return () => clearTimeout(t);
  }, [step, shown]);
  const [turn, setTurn] = useState(0);
  const ways = SAID[shown];
  useEffect(() => {
    setTurn(0);
    if (!ways || !on) return;
    const t = setInterval(() => setTurn((n) => n + 1), TURN_MS);
    return () => clearInterval(t);
  }, [ways, on]);
  return ways ? ways[turn % ways.length]! : shown;
}

export function WorkLine({ step, title, since, open, onOpen }: { step: string; /** The whole step, raw command and all, for the hover. */ title?: string; /** When the turn began; the quiet is counted from it. */ since?: number; open?: boolean; onOpen?: () => void }) {
  const [start] = useState(() => since ?? Date.now());
  const [awake, setAwake] = useState(() => Date.now() - start >= QUIET_MS);
  useEffect(() => {
    if (awake) return;
    const t = setTimeout(() => setAwake(true), Math.max(0, start + QUIET_MS - Date.now()));
    return () => clearTimeout(t);
  }, [awake, start]);

  const words = useHeldWords(step, awake);

  if (!awake) return <span className="wl" role="status" aria-label={step} />;
  const phrase = (
    <span className="wl-slot" {...(title && title !== words ? { title } : {})}>
      <Shine key={words} className="wl-phrase">
        {words}
      </Shine>
    </span>
  );
  return (
    <span className="wl" role="status">
      <span className="wl-sep" aria-hidden="true">
        ·
      </span>
      {onOpen ? (
        <button type="button" className="wl-now" aria-expanded={!!open} title={open ? "Hide its steps" : "Show its steps"} onClick={onOpen}>
          {phrase}
          <ChevronDownIcon className="wl-chev" aria-hidden="true" />
        </button>
      ) : (
        phrase
      )}
    </span>
  );
}
