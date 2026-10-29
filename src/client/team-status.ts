/**
 * How a teammate stands, said once for everywhere it is drawn: the sidebar, the header's faces, the Team room, the Agents panel,
 * the folded rail and the @ menu (Arun, 2026-10-28: "run an audit on the teams stuff…"; the critique found the same teammate
 * "Out of usage" in red in one place, "On Codex" in blue in another and "Ready" in a third). One state, one line and one colour
 * token per state (teammates.css --mate-*): out of usage is amber everywhere, offline grey.
 *
 * The line puts the time first ("Out until 12:38 PM · Codex covers"), so it still says the useful part when it is cut short.
 *
 * Kept apart from drawing it so it can be tested (test/team-status.test.ts).
 *
 */
import { isRawError } from "../activity-line.js";
import { ENGINE_NAMES, type EngineMode, type EngineTool } from "../types.js";

export type MateState = "working" | "waiting" | "stopped" | "limited" | "offline" | "idle";

/** What a teammate's status is read from: its record as the server sends it (TeammateView), only what this needs. */
export interface MateLike {
  name: string;
  tool: EngineTool | "friday";
  model?: string;
  backup?: EngineTool;
  status: MateState;
  line: string;
  queued: number;
  problem?: string;
  switched?: { from: EngineTool; until: number | null };
  /** On hold as the person said (held.ts): it waits until the hold is lifted. */
  held?: boolean;
}

export interface MateSays {
  /** Its state, for its colour (data-mate / s-<state>). */
  state: MateState;
  /** One line, time first. */
  line: string;
}

/** A time of day the way the app says it: "12:38 PM", or "Tue 9:00 AM" when it isn't today. */
export function timeOf(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const today = d.toDateString() === new Date(now).toDateString();
  return d.toLocaleString([], today ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/** When a teammate out of usage is back, from the server's line ("Out of usage until 10:42 PM"), if it says. */
export const untilIn = (line: string): string => /\buntil ([^·]+?)\s*(?:·|$)/.exec(line)?.[1]?.trim() ?? "";

/**
 * The tool a teammate's work goes to while its own is out: its backup, else the other of Claude Code and Codex. Null when it is on
 * its backup already and that is out too: the tool it came from is the one that ran out first (Arun, 2026-10-28: "really iron out
 * bugs and feature problems and gaps"; Juno on Codex since Claude Code ran out read "Claude Code covers").
 */
export const backupFor = (m: Pick<MateLike, "tool" | "backup" | "switched">): EngineTool | null => {
  const b = m.backup ?? (m.tool === "claude" ? "codex" : "claude");
  return m.switched && (b === m.switched.from || b === m.tool) ? null : b;
};

/**
 * A teammate's state and line. `opts.here`: how it stands in the chat drawn (its runs there), when that differs from how it stands
 * anywhere; `opts.elsewhere`: the rooms it works in instead; `opts.paused`: the team is paused, so what waits for it waits.
 */
export function sayMate(m: MateLike, opts: { here?: MateState; elsewhere?: string[]; paused?: boolean; model?: string; now?: number } = {}): MateSays {
  // Its line in words only: a tool's raw error (a stack trace, "node:internal/modules/cjs/loader:1…") is never a live line
  // (Arun, 2026-10-29); the error itself is in the chat.
  if (isRawError(m.line)) m = { ...m, line: "" };
  // Offline and out of usage are its own, wherever it is.
  // With why when it is known (2026-10-28 QA: a bare "Offline" everywhere but the Agents panel).
  if (m.status === "offline") return { state: "offline", line: m.problem ? `Offline · ${m.problem}` : /^Offline · /.test(m.line) ? m.line.replace("reconnect it from the chat", "restart their tool") : "Offline" };
  if (m.status === "limited") {
    const until = untilIn(m.line);
    const out = until ? `Out until ${until}` : "Out of usage";
    if (m.tool === "friday") return { state: "limited", line: `${out} · waits for ${opts.model ?? "its model"}` };
    const b = backupFor(m);
    return { state: "limited", line: b ? `${out} · ${ENGINE_NAMES[b]} covers` : `${out} · ${ENGINE_NAMES[m.switched!.from]} out too` };
  }
  // Its last run ended on an error: said as stopped, in red, until it runs again, never as idle or just done (Arun, 2026-10-29:
  // "Yes, fix them": a teammate's page said "Idle" after a failed run). The server's line is already in words (stoppedLine).
  if (m.status === "stopped" && (opts.here ?? "stopped") === "stopped") return { state: "stopped", line: /^Stopped\b/.test(m.line) ? m.line : m.line ? `Stopped · ${m.line}` : "Stopped" };
  // In the chat drawn it may be idle while it works in another room: said as where it works, not as busy here.
  const here = opts.here ?? m.status;
  if (here !== m.status && here === "idle") {
    const where = opts.elsewhere?.length ? `in ${opts.elsewhere.join(", ")}` : "elsewhere";
    return { state: "idle", line: `Idle here · ${m.status === "waiting" ? "needs you" : "working"} ${where}` };
  }
  // On its backup, its own tool out: the time it is back first, then what it is doing on the backup.
  const on = m.switched && m.tool !== "friday" ? ENGINE_NAMES[m.tool] : "";
  const back = m.switched?.until ? ` until ${timeOf(m.switched.until, opts.now)}` : "";
  if (here === "waiting") {
    const ask = m.line && here === m.status ? `: ${m.line}` : "";
    return { state: "waiting", line: `Needs you${ask}${on ? ` · on ${on}` : ""}` };
  }
  if (here === "working") return { state: "working", line: `${(here === m.status && m.line) || "Working"}${on ? ` · on ${on}` : ""}` };
  if (on) return { state: "idle", line: `On ${on}${back}${m.switched ? ` · ${ENGINE_NAMES[m.switched.from]} out` : ""}` };
  if (m.held) return { state: "idle", line: m.queued ? `On hold · ${m.queued} queued` : "On hold" };
  if (opts.paused) return { state: "idle", line: m.queued ? `Paused · ${m.queued} queued` : "Paused" };
  return { state: "idle", line: m.queued ? `${m.queued} queued` : "Idle" };
}

/** How far a teammate's tool may go, in the person's words (Arun, 2026-10-28: the critique's "Access, visible"). */
export const ACCESS: Record<EngineMode, { label: string; short: string; blurb: string }> = {
  plan: { label: "Read only", short: "Read only", blurb: "Reads, plans and answers. Never changes a file." },
  edits: { label: "Ask before changes", short: "Asks first", blurb: "Asks you before changing a file or running a command. Decides alone while you're away." },
  full: { label: "Full access", short: "Full access", blurb: "Changes files and runs commands in their folders without asking." },
};

/** "Today", "Yesterday", "Monday, Oct 26": a day as a team chat's divider says it. */
export function dayName(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const today = new Date(now);
  const y = new Date(now);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}

/**
 * Where a long team chat's day dividers go (Arun, 2026-10-28: the critique's "day dividers in long team chats"): before each item
 * on a new day, and before the first when the chat spans more than one; null elsewhere. `ts` is each item's time, if known.
 */
export function dayBreaks(ts: (number | undefined)[], now = Date.now()): (string | null)[] {
  const day = (t: number | undefined) => (t === undefined ? null : new Date(t).toDateString());
  const days = new Set(ts.map(day).filter(Boolean));
  let last: string | null = null;
  return ts.map((t, i) => {
    const d = day(t);
    if (!d) return null;
    const show = i === 0 || last === null ? days.size > 1 : d !== last;
    last = d;
    return show ? dayName(t!, now) : null;
  });
}
