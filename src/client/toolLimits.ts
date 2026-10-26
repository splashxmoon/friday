import { useEffect, useState } from "react";
import type { Limits } from "../runner/limits.js";
import { hostApi } from "./local.js";
import type { Identity } from "./storage.js";
import { crossedEighty, limitAlertsOn, readHistory, recordReading, windowsOf } from "./limitHistory.js";
import { notificationsOn } from "./prefs.js";
import { ENGINE_NAMES } from "../types.js";

/** The coding tools' limits as this computer last read them; "none" when no computer answered. */
export type Read = Limits | null | "none";

/**
 * One reading of this computer's coding-tool limits, shared by everything that shows them (the rail's glance, a session's
 * ring, the Usage page), and kept between launches. Anything that opens shows the last reading at once, and a fresh one
 * replaces it when it arrives: asking the computer means asking Codex, Cursor and Claude Code, which takes a second or two,
 * and nothing should sit empty for that. A window whose reset has passed since is shown as reset (see the glance).
 */
const KEY = "mpa.limits";
const FRESH_MS = 30_000;
/** How often limits are read again while something is showing them, so a card left open keeps up with the work. */
const EVERY_MS = 120_000;

let current: { at: number; limits: Read } | null = (() => {
  try {
    const kept = JSON.parse(localStorage.getItem(KEY) ?? "null") as { at: number; limits: Limits } | null;
    return kept?.limits ? kept : null;
  } catch {
    return null;
  }
})();
let asking: Promise<void> | null = null;
let tick: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<(r: Read) => void>();

/** A five-hour window past 80%: one quiet notification, when they are on and allowed. */
function warn(wins: ReturnType<typeof windowsOf>): void {
  if (!wins.length || !limitAlertsOn() || !notificationsOn() || typeof Notification === "undefined" || Notification.permission !== "granted") return;
  for (const w of wins) {
    try {
      new Notification(`${ENGINE_NAMES[w.tool]} is at ${Math.round(w.used)}% of its 5-hour limit`, {
        body: w.resetsAt ? `It resets at ${new Date(w.resetsAt * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` : "",
        tag: `limit:${w.tool}:${w.resetsAt ?? ""}`,
      });
    } catch {
      // A courtesy: a browser that refuses changes nothing.
    }
  }
}

/** Ask the computer again, unless a reading is fresh or already on its way. */
export function refreshToolLimits(identity: Identity, force = false): void {
  if (asking || (!force && current && current.limits !== null && Date.now() - current.at < FRESH_MS)) return;
  asking = hostApi<Limits>(identity, "/api/runner/usage")
    .then(
      (l) => {
        current = { at: Date.now(), limits: l };
        // Kept for the Usage hub's pace and forecast, and checked for a five-hour window that just passed 80%.
        const before = readHistory();
        recordReading(l);
        warn(crossedEighty(before, windowsOf(l)));
        try {
          localStorage.setItem(KEY, JSON.stringify(current));
        } catch {
          /* kept for this visit only */
        }
      },
      // No computer: say so, but keep a reading that came from one before for anything already showing it.
      () => void (current = current?.limits && current.limits !== "none" ? { ...current, at: Date.now() } : { at: Date.now(), limits: "none" }),
    )
    .finally(() => {
      asking = null;
      for (const l of listeners) l(current?.limits ?? null);
    });
}

/** The limits now (the last reading, at once), asking again behind it when that reading is old. */
export function useToolLimits(identity: Identity, off = false): Read {
  const [limits, setLimits] = useState<Read>(current?.limits ?? null);
  useEffect(() => {
    // `off`: somewhere nobody's computer can be asked (a recording's page), which reads as no reading at all.
    if (off) return;
    listeners.add(setLimits);
    refreshToolLimits(identity);
    // Again every two minutes while anything shows them and the window is in front: a turn that spent some of a limit shows on
    // it. One timer for everything showing them, however many that is.
    tick ??= setInterval(() => document.visibilityState === "visible" && refreshToolLimits(identity), EVERY_MS);
    return () => {
      listeners.delete(setLimits);
      if (!listeners.size && tick) {
        clearInterval(tick);
        tick = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Off, it reads as an ask that found no computer would (refreshToolLimits): an earlier reading kept, else none.
  return off ? (current?.limits && current.limits !== "none" ? current.limits : "none") : limits;
}
