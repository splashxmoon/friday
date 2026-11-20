import { useSyncExternalStore } from "react";

/**
 * The rail's places: their order, and which are behind its ⋯ instead (Arun, 2026-11-19: "add the option to customize what tabs
 * can be on the rail too... like the user can play around with different options and orders too"; then "very simple and clean
 * please not extra BS"). One list, each place shown or not; kept in this browser, read live by the rail and the Customize panel.
 * Sessions is always shown: it is the way back to your work. Settings, Usage and the update button keep the rail's foot.
 */
export type RailPlace = "sessions" | "agents" | "needs" | "automations" | "review" | "board" | "deepdive" | "mcp" | "skills";
export interface RailLayout {
  order: RailPlace[];
  /** Behind the ⋯, in their order. */
  hidden: RailPlace[];
}

const PLACES: RailPlace[] = ["sessions", "agents", "needs", "automations", "review", "board", "deepdive", "mcp", "skills"];
export const RAIL_DEFAULT: RailLayout = { order: [...PLACES], hidden: ["board", "deepdive", "mcp", "skills"] };
const KEY = "friday.rail.layout";

const isPlace = (s: unknown): s is RailPlace => PLACES.includes(s as RailPlace);

/** Whatever was kept, made whole: unknown names out, each place once, one added later where it goes by default, Sessions shown. */
export function normalizeRail(raw: unknown): RailLayout {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!r) return { order: [...RAIL_DEFAULT.order], hidden: [...RAIL_DEFAULT.hidden] };
  // The first version kept the rail's and the ⋯'s lists, lines between places among them.
  const old = Array.isArray(r.rail) || Array.isArray(r.more);
  const listed = old ? [...(Array.isArray(r.rail) ? r.rail : []), ...(Array.isArray(r.more) ? r.more : [])] : Array.isArray(r.order) ? r.order : [];
  const hiddenIn = old ? (Array.isArray(r.more) ? r.more : []) : Array.isArray(r.hidden) ? r.hidden : [];
  if (!listed.length && !hiddenIn.length) return { order: [...RAIL_DEFAULT.order], hidden: [...RAIL_DEFAULT.hidden] };
  const order: RailPlace[] = [];
  for (const s of listed) if (isPlace(s) && !order.includes(s)) order.push(s);
  const hidden = new Set(hiddenIn.filter(isPlace));
  for (const p of PLACES) {
    if (order.includes(p)) continue;
    // After the place before it by default, where that one is.
    const before = PLACES.slice(0, PLACES.indexOf(p)).reverse().find((x) => order.includes(x));
    order.splice(before ? order.indexOf(before) + 1 : 0, 0, p);
    if (RAIL_DEFAULT.hidden.includes(p)) hidden.add(p);
  }
  hidden.delete("sessions");
  return { order, hidden: order.filter((p) => hidden.has(p)) };
}

/** The places on the rail, and behind the ⋯, of those this window offers. */
export const shownOf = (l: RailLayout, has: (p: RailPlace) => boolean = () => true) => l.order.filter((p) => has(p) && !l.hidden.includes(p));
export const hiddenOf = (l: RailLayout, has: (p: RailPlace) => boolean = () => true) => l.order.filter((p) => has(p) && l.hidden.includes(p));

/** One step up or down among the places beside it (the rail's, or the ⋯'s). */
export function moveInRail(l: RailLayout, id: RailPlace, by: -1 | 1, has?: (p: RailPlace) => boolean): RailLayout {
  const group = l.hidden.includes(id) ? hiddenOf(l, has) : shownOf(l, has);
  const other = group[group.indexOf(id) + by];
  if (!other) return l;
  const order = [...l.order];
  const a = order.indexOf(id);
  const b = order.indexOf(other);
  [order[a], order[b]] = [order[b]!, order[a]!];
  return { order, hidden: order.filter((p) => l.hidden.includes(p)) };
}

/** Put where another place is (a drag): the others close up around it. */
export function placeAt(l: RailLayout, id: RailPlace, at: RailPlace): RailLayout {
  if (id === at) return l;
  const order = l.order.filter((p) => p !== id);
  const to = order.indexOf(at) + (l.order.indexOf(id) < l.order.indexOf(at) ? 1 : 0);
  order.splice(to, 0, id);
  return { order, hidden: order.filter((p) => l.hidden.includes(p)) };
}

/** On the rail, or behind the ⋯. Sessions stays. */
export function setShown(l: RailLayout, id: RailPlace, shown: boolean): RailLayout {
  if (id === "sessions" && !shown) return l;
  const hidden = new Set(l.hidden);
  if (shown) hidden.delete(id);
  else hidden.add(id);
  return { order: l.order, hidden: l.order.filter((p) => hidden.has(p)) };
}

export const isDefaultRail = (l: RailLayout) => JSON.stringify(l) === JSON.stringify(RAIL_DEFAULT);

let cached: RailLayout | null = null;
const listeners = new Set<() => void>();

export function readRail(): RailLayout {
  if (cached) return cached;
  let raw: unknown = null;
  try {
    raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    raw = null;
  }
  cached = normalizeRail(raw);
  return cached;
}

/** Kept, or put back to how it comes (null). */
export function saveRail(next: RailLayout | null): void {
  cached = normalizeRail(next);
  try {
    if (next && !isDefaultRail(cached)) localStorage.setItem(KEY, JSON.stringify(cached));
    else localStorage.removeItem(KEY);
  } catch {
    /* Kept for this window only. */
  }
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));
/** Another window of the app changing it is picked up too. */
if (typeof window !== "undefined")
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    cached = null;
    listeners.forEach((l) => l());
  });

export function useRailLayout(): RailLayout {
  return useSyncExternalStore(subscribe, readRail, readRail);
}
