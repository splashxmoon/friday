import type { HTMLAttributes } from "react";

/**
 * Words with a light passing over them while something works: a reply's live line, a step under way, a subagent's doing, a
 * teammate's live status. A sweep, not a pulse: a pulse reads as a warning, a sweep as work in progress.
 *
 * Drawn by the compositor alone. The light is a soft-edged window over a brighter copy of the words: the window slides across
 * while the copy inside it slides back the same distance, so the copy stays on the words, and both are transforms. A light
 * swept across the words themselves (a background clipped to the text, its position animated) had the page laid out and
 * painted again every frame for as long as anything worked, a tenth of a core with three agents working and nothing new
 * arriving (Arun, 2026-10-30: "the app feel laggy when running a lot of tasks and agents").
 *
 * `on` false draws the words alone, as a plain span with the same class.
 */
export function Shine({ on = true, className, children, ...rest }: HTMLAttributes<HTMLSpanElement> & { on?: boolean }) {
  if (!on) return <span className={className} {...rest}>{children}</span>;
  return (
    <span className={className ? `shine ${className}` : "shine"} {...rest}>
      {children}
      <span className="shine-win" aria-hidden="true">
        <span className="shine-copy">{children}</span>
      </span>
    </span>
  );
}
