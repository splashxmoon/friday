import { MAIN_LANE, type DiffFile, type SessionEvent } from "../types.js";
import type { SessionState } from "./projection.js";

/**
 * Each change set's patches kept once (Arun, 2026-10-21: "how can we live save the events without live losing everything and
 * saving space on the server").
 *
 * A change set is logged at the end of every turn and names every file changed so far, so a session where four agents worked
 * all day logged the same fifty patches again and again: 167 change sets were 22 of its log's 33 MB, every open of it built
 * all 33 MB into one message, and the server ran out of memory every few minutes. Now:
 *
 * - Written: a file whose patch is the one the lane logged last time is written as a reference to the change set holding
 *   that text (`at`), empty (refPatches). Every version is still in the log, once.
 * - Read: the references are filled back in with the very same strings (fillPatches, internPatches), so whatever reads the
 *   log sees whole patches, and a hundred copies of one in memory cost one. A log from before this is folded the same way.
 * - Sent: a page opening a session gets the latest change set of each lane whole and the older ones by name and counts
 *   (lightLog); a file's text comes when it is opened, by the seq in `later` (GET /api/sessions/:sid/diff).
 */

type DiffEvent = SessionEvent & { body: Extract<SessionEvent["body"], { type: "agent.diff" }> };
const isDiff = (e: SessionEvent | undefined): e is DiffEvent => e?.body.type === "agent.diff";

/** Where a file's text is kept: the change set it is a reference to, or its own. */
export const originOf = (f: DiffFile, seq: number): number => f.at ?? seq;

/** As written: the files whose patch is the lane's last change set's, unchanged, as references to where that text is kept. */
export function refPatches(files: DiffFile[], last: { seq: number; files: DiffFile[] } | undefined): DiffFile[] {
  if (!last) return files;
  const was = new Map(last.files.map((f) => [f.path, f]));
  return files.map((f) => {
    const p = was.get(f.path);
    if (!f.patch || !p?.patch || p.patch !== f.patch || !!p.truncated !== !!f.truncated) return f;
    return { ...f, patch: "", at: originOf(p, last.seq) };
  });
}

/** The file of that path in a change set, when it holds the text. */
function held(e: SessionEvent | undefined, path: string): DiffFile | undefined {
  return isDiff(e) ? e.body.files.find((x) => x.path === path && !!x.patch) : undefined;
}

/**
 * A change set as read, its references filled back in with the same strings: from the lane's last change set (in the state,
 * which a cache without its events still has), or else from the change set named. One whose text isn't here is left `later`.
 */
export function fillPatches(ev: SessionEvent, state: SessionState | null | undefined, eventAt?: (seq: number) => SessionEvent | undefined): void {
  if (!isDiff(ev)) return;
  const last = state?.diffs[ev.lane ?? MAIN_LANE];
  for (const f of ev.body.files) {
    if (f.at === undefined || f.patch) continue;
    const from = last?.files.find((x) => x.path === f.path && originOf(x, last.seq) === f.at && !!x.patch) ?? held(eventAt?.(f.at), f.path);
    if (from) f.patch = from.patch;
    else f.later = f.at;
  }
}

/**
 * A whole log as read, in order: references filled in, and a patch the same as the lane's last one (a log written before
 * references) made the very same string and given its `at`, so it costs nothing more in memory and is sent as a reference.
 * `found.repeats` counts those, so the server knows the stored log can be compacted (compact.ts).
 */
export function internPatches(events: SessionEvent[], found?: { repeats: number }): SessionEvent[] {
  const last = new Map<string, { seq: number; byPath: Map<string, DiffFile> }>();
  const at = (seq: number) => events[seq - 1]?.seq === seq ? events[seq - 1] : events.find((e) => e.seq === seq);
  for (const e of events) {
    if (!isDiff(e)) continue;
    const lane = e.lane ?? MAIN_LANE;
    const prev = last.get(lane);
    for (const f of e.body.files) {
      const p = prev?.byPath.get(f.path);
      if (f.at !== undefined && !f.patch) {
        const from = p && originOf(p, prev!.seq) === f.at && p.patch ? p : held(at(f.at), f.path);
        if (from) f.patch = from.patch;
        else f.later = f.at;
      } else if (p?.patch && f.patch && f.at === undefined && p.patch === f.patch && !!p.truncated === !!f.truncated) {
        f.patch = p.patch;
        f.at = originOf(p, prev!.seq);
        // Stored in full: a log the server can compact (compact.ts), counted for whoever asked.
        if (found) found.repeats++;
      }
    }
    last.set(lane, { seq: e.seq, byPath: new Map(e.body.files.map((f) => [f.path, f])) });
  }
  return events;
}

/**
 * The log as a page opening the session is sent it: each lane's latest change set whole (it is the one the page shows open),
 * the older ones with their files' names and counts and the seq to fetch each file's text by. New objects: the cache's own
 * events are left whole.
 */
export function lightLog(events: SessionEvent[]): SessionEvent[] {
  return events.map(lightener(events));
}

/**
 * lightLog for one event at a time, judged against the whole log: for sending part of a long log (the hello's newest events,
 * the rest in pieces) without going over all of it to make what isn't sent.
 */
export function lightener(events: SessionEvent[]): (e: SessionEvent) => SessionEvent {
  const latest = new Map<string, number>();
  for (const e of events) if (isDiff(e)) latest.set(e.lane ?? MAIN_LANE, e.seq);
  const keep = new Set(latest.values());
  return (e) =>
    !isDiff(e) || keep.has(e.seq) || !e.body.files.some((f) => f.patch)
      ? e
      : { ...e, body: { ...e.body, files: e.body.files.map((f) => (f.patch ? { ...f, patch: "", later: originOf(f, e.seq) } : f)) } };
}
