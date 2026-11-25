import { useRef } from "react";
import type { SessionEvent } from "../types.js";

/**
 * What a session's feed works out from its whole log, carried from one event to the next (spec 13, Arun 2026-11-24: "Go all out
 * and fix these problems"). The feed read the whole log a dozen times over for every event that arrived, so a 20,000-event
 * session spent 15 ms an event on it. A log only grows at its end while it is open, so what was found in it is kept, and only
 * what was added since is looked at; anything else (opened further back, another session) starts again from the whole log.
 */
interface Seen {
  log: readonly SessionEvent[];
  /** Whatever else what was found depends on (whose view, which agent): another one starts again. */
  key: unknown;
  n: number;
  first: SessionEvent | undefined;
  last: SessionEvent | undefined;
}

const seenOf = (log: readonly SessionEvent[], key: unknown): Seen => ({ log, key, n: log.length, first: log[0], last: log[log.length - 1] });

/** The events added to the end of the log since it was `was`, or null when this isn't that log grown. */
export function addedSince(was: Seen | null | undefined, log: readonly SessionEvent[], key?: unknown): readonly SessionEvent[] | null {
  if (!was || was.key !== key) return null;
  if (was.log === log) return [];
  if (log.length < was.n || log[0] !== was.first || (was.n > 0 && log[was.n - 1] !== was.last)) return null;
  return log.slice(was.n);
}

/** The events after `seq`, looked for from the end: what's new since a point, without reading a long log from its start. */
export function eventsAfter<E extends { seq: number }>(log: readonly E[], seq: number): E[] {
  let i = log.length;
  while (i > 0 && log[i - 1]!.seq > seq) i--;
  return log.slice(i);
}

/** `make(log)`, made again only when an event that `matters` is added, or the log isn't the one it was made from, grown. */
export function logMemo<T>(keep: { current: { seen: Seen; value: T } | null }, log: readonly SessionEvent[], make: (log: readonly SessionEvent[]) => T, matters: (e: SessionEvent) => boolean, key?: unknown): T {
  const added = addedSince(keep.current?.seen, log, key);
  if (!keep.current || added === null || added.some(matters)) keep.current = { seen: seenOf(log, key), value: make(log) };
  else keep.current.seen = seenOf(log, key);
  return keep.current.value;
}

export function useLogMemo<T>(log: readonly SessionEvent[], make: (log: readonly SessionEvent[]) => T, matters: (e: SessionEvent) => boolean, key?: unknown): T {
  return logMemo(useRef<{ seen: Seen; value: T } | null>(null), log, make, matters, key);
}

/** A value folded over the log, each event once: carried on over what was added, or folded again from the start. */
export function logFold<T>(keep: { current: { seen: Seen; value: T } | null }, log: readonly SessionEvent[], start: () => T, step: (acc: T, e: SessionEvent) => T, key?: unknown): T {
  const added = addedSince(keep.current?.seen, log, key);
  let value = added === null || !keep.current ? start() : keep.current.value;
  for (const e of added ?? log) value = step(value, e);
  keep.current = { seen: seenOf(log, key), value };
  return value;
}

export function useLogFold<T>(log: readonly SessionEvent[], start: () => T, step: (acc: T, e: SessionEvent) => T, key?: unknown): T {
  return logFold(useRef<{ seen: Seen; value: T } | null>(null), log, start, step, key);
}

const kept = new Map<string, { current: { seen: Seen; value: unknown } | null }>();

/** logFold where a hook can't be (after an early return): carried under a key of the caller's own. */
export function keptFold<T>(key: string, log: readonly SessionEvent[], start: () => T, step: (acc: T, e: SessionEvent) => T): T {
  let k = kept.get(key);
  if (!k) {
    if (kept.size > 500) kept.clear();
    kept.set(key, (k = { current: null }));
  }
  return logFold(k as { current: { seen: Seen; value: T } | null }, log, start, step);
}

type Of<T extends SessionEvent["body"]["type"]> = SessionEvent & { body: Extract<SessionEvent["body"], { type: T }> };

/**
 * The log's events of a kind, kept as events are added (keptFold, under the session's id): what a card looks for on every draw,
 * in a list of its own rather than the whole log read again.
 */
export function ofType<T extends SessionEvent["body"]["type"]>(log: readonly SessionEvent[], type: T, sid: string): Of<T>[] {
  return keptFold<Of<T>[]>(`type:${sid}:${type}`, log, () => [], (acc, e) => (e.body.type === type && acc.push(e as Of<T>), acc));
}

/** ofType for several kinds at once, in the log's order. */
export function ofTypes(log: readonly SessionEvent[], types: ReadonlySet<string>, sid: string): SessionEvent[] {
  return keptFold<SessionEvent[]>(`types:${sid}:${[...types].join(",")}`, log, () => [], (acc, e) => (types.has(e.body.type) && acc.push(e), acc));
}
