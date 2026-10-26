/**
 * What an agent's tab says about it, in a few characters (Arun, 2026-10-24: the session's agent tabs read "as a flat list of
 * grey text"): whose agent it is as initials rather than a long "Arokia's Claude Code", where it stands in a word, and that
 * state as a key the tab is coloured by.
 */

import type { AgentStatus } from "../agents-hub.js";

/** The state a tab is coloured by: the colours of the agents' task board (--st-working, --st-queued, --st-done, --st-blocked). */
export type TabState = "working" | "needs" | "waiting" | "done" | "offline" | "failed" | "limited" | "idle";

export function tabState(status: AgentStatus | undefined, needsYou = false): TabState {
  if (!status) return "idle";
  if (needsYou) return "needs";
  if (status === "working") return "working";
  if (status === "limited") return "limited";
  if (status === "waiting" || status === "paused") return "waiting";
  if (status === "failed") return "failed";
  if (status === "offline") return "offline";
  if (status === "done") return "done";
  return "idle";
}

const WORDS: Record<TabState, string> = { working: "Working", needs: "Needs you", waiting: "Waiting", done: "Done", offline: "Offline", failed: "Stopped", limited: "Out of usage", idle: "Ready" };

/** Where it stands, in a word or two, with how long it has been at it while it works. */
export function tabWords(state: TabState, startedAt: number | null | undefined, now: number): string {
  if (state !== "working" || !startedAt) return WORDS[state];
  const s = Math.max(0, Math.round((now - startedAt) / 1000));
  return `${WORDS.working} · ${s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`}`;
}

/**
 * Whose agent it is, when it isn't yours, and its name without the owner in it: an agent on someone else's computer
 * (`host`, from the session's engines), or one named for its owner ("Arokia's Claude Code"). Yours has no owner shown.
 */
export function tabOwner(label: string, host: { id: string; name: string } | null, meId: string): { owner: string | null; name: string } {
  const named = /^(.+?)['’]s (.+)$/.exec(label);
  const owner = host && host.id !== meId ? host.name : named ? named[1]! : null;
  if (!owner) return { owner: null, name: label };
  const first = owner.split(/\s+/)[0]!;
  const short = named && (named[1] === owner || named[1] === first) ? named[2]! : label;
  return { owner, name: short };
}

/** "Arokia Raj" → "AR", "maya" → "M". */
export const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

/**
 * How many agent cards fit beside All agents and +, in the order they are ranked: as many as the bar's width takes, the rest
 * behind +N (whose own width is kept for once any is left out). Always at least one, and never more than `max`.
 */
export function tabsThatFit(widths: readonly number[], room: number, gap: number, more: number, max: number): number {
  let used = 0;
  let n = 0;
  for (const w of widths.slice(0, max)) {
    const next = used + w + gap;
    // The last of them needs no room kept for +N; any before it does.
    const reserve = n + 1 < widths.length ? more + gap : 0;
    if (next + reserve > room) break;
    used = next;
    n++;
  }
  return Math.max(1, n);
}
