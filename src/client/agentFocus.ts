import { createContext, useContext, useSyncExternalStore } from "react";
import type { HubAgent } from "../agents-hub.js";
import { ALL, agentInSearch, searchWithAgent } from "./agentNav.js";

/**
 * Which agent a session is looking at, one choice for the whole page (Arun, 2026-10-18: "it feels like a chore to keep
 * track of everything"). The feed's tab, the box's "Send to" and the panels beside the chat each kept their own, and they
 * drifted apart: the feed on Codex, the box still writing to Claude Code, the Diff showing every agent's files. Now
 * choosing an agent anywhere (the rail, a card in the Agents panel, ⌃2, ⌘J, the palette) is choosing it everywhere.
 *
 * "all" is the overview: every agent's work in one feed. Kept per session for this tab, and in the address (?agent=), so a
 * reload or a link sent to someone opens on that agent.
 * Also kept here: how far into each agent's work this person has read, for the rail's unread counts and each agent's
 * catch-up; and the agents a split chat shows side by side, whose columns are this same choice: the one in view is the
 * column in use.
 */

export { ALL };

interface Entry {
  focused: string;
  /** Per lane, the last seq this person has seen of it. */
  seen: Record<string, number>;
  /** The newest seq when this page first opened the session: an agent never looked at here is unread from there. */
  opened: number | null;
  /** The agents side by side, left to right; null for one chat. */
  columns: string[] | null;
  subs: Set<() => void>;
}

const entries = new Map<string, Entry>();
const KEY = (sid: string) => `friday.agent.${sid}`;
const COLS = (sid: string) => `friday.cols.${sid}`;

function entry(sid: string): Entry {
  let e = entries.get(sid);
  if (!e) {
    // The address first: a link that names an agent opens on it, whatever this tab looked at last.
    let focused = (typeof location !== "undefined" && agentInSearch(location.search, sid)) || ALL;
    let columns: string[] | null = null;
    try {
      if (focused === ALL) focused = sessionStorage.getItem(KEY(sid)) || ALL;
      const c = JSON.parse(sessionStorage.getItem(COLS(sid)) || "null") as unknown;
      if (Array.isArray(c) && c.length >= 2 && c.every((x) => typeof x === "string")) columns = c as string[];
    } catch {
      // No storage (a private window, a blocked site): the overview, one chat.
    }
    // A split that doesn't show the agent the link names is not where the link meant to open.
    if (columns && !columns.includes(focused)) columns = null;
    e = { focused, seen: {}, opened: null, columns, subs: new Set() };
    entries.set(sid, e);
  }
  return e;
}

const tell = (e: Entry) => e.subs.forEach((f) => f());

/** The agent in view goes into the address in place, with no new step in Back: the session's own link, with ?agent=. */
function toAddress(sid: string, lane: string) {
  if (typeof location === "undefined") return;
  const search = searchWithAgent(location.search, sid, lane);
  if (search === null || search === location.search) return;
  history.replaceState(history.state, "", location.pathname + search + location.hash);
}

export function focusAgent(sid: string, lane: string) {
  const e = entry(sid);
  if (e.focused === lane) return;
  e.focused = lane;
  try {
    sessionStorage.setItem(KEY(sid), lane);
  } catch {
    // Remembered for this page only.
  }
  toAddress(sid, lane);
  tell(e);
}

/**
 * When the session comes up: an address that names an agent opens on it (a link followed inside the app, after this page
 * had already looked at the session); one that doesn't is given the agent in view, even when that came from this tab's memory.
 */
export function syncAddress(sid: string) {
  const named = agentInSearch(location.search, sid);
  if (named && named !== entry(sid).focused) {
    const e = entry(sid);
    if (e.columns && !e.columns.includes(named)) setColumns(sid, null);
    focusAgent(sid, named);
  } else toAddress(sid, entry(sid).focused);
}

/** The agents side by side, and which of them is in use; null closes the split. */
export function setColumns(sid: string, columns: string[] | null, active?: string) {
  const e = entry(sid);
  const next = columns && columns.length >= 2 ? columns : null;
  const same = (e.columns?.join(",") ?? "") === (next?.join(",") ?? "");
  if (!same) {
    e.columns = next;
    try {
      if (next) sessionStorage.setItem(COLS(sid), JSON.stringify(next));
      else sessionStorage.removeItem(COLS(sid));
    } catch {
      // Remembered for this page only.
    }
  }
  // The one in view must be a column, or the split would close again at once.
  const lane = active ?? (next && !next.includes(e.focused) ? next[0]! : undefined);
  if (lane !== undefined && lane !== e.focused) focusAgent(sid, lane);
  else if (!same) tell(e);
}

export const columnsOf = (sid: string) => entry(sid).columns;

export function useColumns(sid: string): string[] | null {
  return useSyncExternalStore(
    (f) => {
      const e = entry(sid);
      e.subs.add(f);
      return () => e.subs.delete(f);
    },
    () => entry(sid).columns,
    () => null,
  );
}

/** Where this page came in, once per session: the first view to open it says. */
export function openedAt(sid: string, seq: number): number {
  const e = entry(sid);
  if (e.opened === null) e.opened = seq;
  return e.opened;
}

export const focusedAgent = (sid: string) => entry(sid).focused;

export function useFocusedAgent(sid: string): string {
  return useSyncExternalStore(
    (f) => {
      const e = entry(sid);
      e.subs.add(f);
      return () => e.subs.delete(f);
    },
    () => entry(sid).focused,
    () => ALL,
  );
}

/** This person has seen `lane` up to `seq`. Only ever forward. */
export function markSeen(sid: string, lane: string, seq: number) {
  const e = entry(sid);
  if ((e.seen[lane] ?? 0) >= seq) return;
  // A new object, so a view reading it sees that it changed.
  e.seen = { ...e.seen, [lane]: seq };
  tell(e);
}

const seenOf = (sid: string) => entry(sid).seen;

export function useSeen(sid: string): Record<string, number> {
  return useSyncExternalStore(
    (f) => {
      const e = entry(sid);
      e.subs.add(f);
      return () => e.subs.delete(f);
    },
    () => seenOf(sid),
    () => ({}),
  );
}

/** Every agent in the session as the hub sees it, worked out once by the session view: one status everywhere. */
export const AgentsContext = createContext<HubAgent[]>([]);
export const useAgents = () => useContext(AgentsContext);

/**
 * The next thing waiting on this person, after the agent in view: that agent becomes the one in view, and its card is
 * brought up with its first choice ready for the keyboard. Says whether there was anything.
 */
export function jumpToNeeds(sid: string, agents: HubAgent[]): boolean {
  const waiting = agents.filter((a) => a.needsYou);
  if (!waiting.length) return false;
  const at = waiting.findIndex((a) => a.lane === focusedAgent(sid));
  const next = waiting[(at + 1) % waiting.length]!;
  focusAgent(sid, next.lane);
  // Two frames: one for the feed to draw that agent's work, one for its card to be laid out.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      let card = document.querySelector<HTMLElement>(`[data-needs="${CSS.escape(next.lane)}"]`);
      // A wrapper laid out as its child (display: contents) has no box of its own to scroll to.
      if (card && !card.getClientRects().length) card = (card.firstElementChild as HTMLElement | null) ?? card;
      if (!card) return;
      card.scrollIntoView({ block: "center", behavior: "smooth" });
      card.querySelector<HTMLElement>('[role="radio"], button:not([disabled])')?.focus({ preventScroll: true });
    }),
  );
  return true;
}

const mac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** The key that brings up the nth agent (0: all of them): ⌃ on a Mac, where ⌘ and a digit change browser tabs; Alt elsewhere, where Ctrl does. */
export const agentKey = (n: number) => (mac() ? `⌃${n}` : `Alt+${n}`);
export const nextKey = () => (mac() ? "⌘J" : "Ctrl+J");
