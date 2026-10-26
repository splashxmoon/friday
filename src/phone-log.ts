import { MAIN_LANE, type SessionEvent } from "./types.js";

/**
 * What the phone is sent of a session's log on joining (`/ws?…&view=phone`), instead of all of it.
 *
 * A long session's log is tens of megabytes, and the phone read every byte of it before it drew the first message (2026-10-20:
 * "it is taking a while to load"). The phone's feed shows only what people said, the agent's answers, its tool steps as one
 * line each with a short gist and the first 400 characters of their output, how a run ended, commits, and who took the wheel:
 * the rest of the log (diffs, file trees, reviews, previews) is drawn from the state, which is sent whole, or not at all.
 * So it gets the newest `perLane` of those per lane, with the bulky fields cut to what it shows: a screenful, so the session
 * opens at once, and the rest a page at a time as the person scrolls up (`phonePage`, `GET /api/sessions/:sid/history`).
 */
export const PHONE_TYPES = new Set(["instruction", "suggestion", "agent.message", "tool.result", "run.ended", "folder.committed", "control.granted"]);
export const PHONE_PER_LANE = 40;
export const PHONE_PAGE = 60;
const OUTPUT_CHARS = 400;
const GIST_CHARS = 120;

export function phoneLog(events: SessionEvent[], perLane = PHONE_PER_LANE): SessionEvent[] {
  const counts = new Map<string, number>();
  const kept: SessionEvent[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!PHONE_TYPES.has(e.body.type)) continue;
    const lane = e.lane ?? MAIN_LANE;
    const n = counts.get(lane) ?? 0;
    if (n >= perLane) continue;
    counts.set(lane, n + 1);
    kept.push(slim(e));
  }
  return kept.reverse();
}

/**
 * One page further back for the phone: the `limit` shown events of one lane before `before`, cut down as on joining, and
 * whether there are more before those. A page can start between a tool call and its result; the phone puts the two together
 * again when the page before arrives.
 */
export function phonePage(events: SessionEvent[], lane: string, before: number, limit = PHONE_PAGE): { events: SessionEvent[]; more: boolean } {
  const kept: SessionEvent[] = [];
  let more = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.seq >= before || (e.lane ?? MAIN_LANE) !== lane || !PHONE_TYPES.has(e.body.type)) continue;
    if (kept.length === limit) {
      more = true;
      break;
    }
    kept.push(slim(e));
  }
  return { events: kept.reverse(), more };
}

function slim(e: SessionEvent): SessionEvent {
  const b = e.body;
  if (b.type === "tool.result" && b.output.length > OUTPUT_CHARS) return { ...e, body: { ...b, output: b.output.slice(0, OUTPUT_CHARS) } };
  if (b.type === "agent.message") {
    // The provider's reasoning blocks are replayed to the model, never read by a person.
    const { reasoning: _, ...rest } = b;
    return { ...e, body: { ...rest, toolCalls: b.toolCalls.map((c) => ({ ...c, arguments: gistOnly(c.arguments) })) } };
  }
  return e;
}

/** A tool call's arguments as the phone uses them: the first text in them, shortened, still JSON. */
function gistOnly(args: string): string {
  if (args.length <= GIST_CHARS * 2) return args;
  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed)) if (typeof v === "string" && v) return JSON.stringify({ [k]: v.slice(0, GIST_CHARS) });
    }
  } catch {
    // Not JSON: nothing the phone can read a gist from either.
  }
  return "{}";
}
