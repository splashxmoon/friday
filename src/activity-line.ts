import { MAIN_LANE, type SessionEvent, type ToolCall } from "./types.js";

/**
 * What an agent is doing right now, in a few words.
 *
 * "Working" is true of an agent that is reading a file and of one that is stuck, and a team of agents deserves better: the
 * person watching three of them wants to know which one is running the tests and which one has been editing for ten minutes.
 * Read from the log: the newest step of the run in progress, and the tool it called.
 */

const MAX = 70;

const clip = (s: string, n = MAX) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const parse = (raw: string): Record<string, unknown> => {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
};

/** The last path segments, which are the part somebody recognises: `src/server/routes/billing.ts` → `routes/billing.ts`. */
const short = (p: string) => p.split("/").filter(Boolean).slice(-2).join("/");

/** A tool call, in the present tense. */
/** The names coding tools give the call that sends a subagent off (client/Subagents.tsx SUBAGENT_CALL). */
const SUBAGENT = /^(task|agent|spawn_agent|subagent)$/i;

export function describeCall(call: Pick<ToolCall, "name" | "arguments">): string {
  const a = parse(call.arguments);
  const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  switch (call.name) {
    case "read_file":
    case "read":
      return `Reading ${short(s("path")) || "a file"}`;
    case "list_files":
      return `Looking through ${short(s("path")) || "the folder"}`;
    case "search_code":
    case "search":
      return s("query") || s("pattern") ? `Searching the code for “${clip(s("query") || s("pattern"), 40)}”` : "Searching the code";
    case "edit_file":
    case "edit":
      return `Editing ${short(s("path")) || "a file"}`;
    case "write_file":
    case "write":
      return `Writing ${short(s("path")) || "a file"}`;
    case "run_command":
    case "shell":
      return s("command") ? `Running ${clip(s("command"), 48)}` : "Running a command";
    case "run_background":
      return s("command") ? `Starting ${clip(s("command"), 46)} in the background` : "Starting a background command";
    case "read_background":
      return "Checking on a background command";
    case "stop_background":
      return "Stopping a background command";
    case "web_search":
      return s("query") ? `Searching the web for “${clip(s("query"), 40)}”` : "Searching the web";
    case "fetch_url":
    case "web_fetch":
      return "Reading a web page";
    case "update_plan":
    case "todo":
      return "Updating its plan";
    case "ask_human":
      return "Asking a question";
    case "hand_off":
      return "Handing work to another agent";
    case "deploy_agent":
      return "Deploying a specialist";
    case "show_preview":
      return "Starting a preview";
    case "remember":
      return "Making a note";
    case "add_skills_from_github":
      return "Adding skills";
    default:
      // A connection's tools are named mcp__service__tool.
      if (call.name.startsWith("mcp__")) {
        const [, service, tool] = call.name.split("__");
        return `Using ${service ?? "a connection"}${tool ? `: ${tool.replace(/[_-]+/g, " ")}` : ""}`;
      }
      if (SUBAGENT.test(call.name)) return s("description") ? `Sending off a subagent: ${clip(s("description"), 40)}` : "Sending off a subagent";
      return `Using ${call.name.replace(/[_-]+/g, " ")}`;
  }
}

export interface Doing {
  /** "Editing routes/billing.ts". */
  text: string;
  /** When that step was taken. */
  ts: number;
  /** Steps taken in this run, which is a rough sense of how far along it is. */
  steps: number;
}

/**
 * What a lane is doing now, or null when it is not in the middle of a run.
 *
 * A step that made tool calls is the agent doing the last of them; a step with only words is it writing its answer; a run
 * with no step yet is it starting. Tool results come after the call, so a call without a result is the one in flight, and
 * one with a result means the agent is thinking about what to do next.
 */
export function doingNow(events: SessionEvent[], lane: string): Doing | null {
  let started = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if ((e.lane ?? MAIN_LANE) !== lane) continue;
    if (e.body.type === "run.ended" || e.body.type === "run.cancel") return null;
    if (e.body.type === "run.started") {
      started = i;
      break;
    }
  }
  if (started < 0) return null;
  const mine = events.slice(started).filter((e) => (e.lane ?? MAIN_LANE) === lane);
  const steps = mine.filter((e) => e.body.type === "agent.message").length;
  const last = [...mine].reverse().find((e) => e.body.type === "agent.message");
  if (!last || last.body.type !== "agent.message") return { text: "Getting started", ts: mine[0]!.ts, steps: 0 };
  const calls = last.body.toolCalls;
  if (!calls.length) return { text: last.body.text.trim() ? "Writing its answer" : "Thinking", ts: last.ts, steps };
  const answered = new Set(mine.filter((e) => e.body.type === "tool.result").map((e) => (e.body as { callId: string }).callId));
  const inFlight = calls.filter((c) => !answered.has(c.id));
  const pick = inFlight.at(-1);
  // Subagents still out, sent off in this step or an earlier one: said as that, rather than "Using Task" or, once its own reads came
  // back, "Thinking about what to do next" (Arun, 2026-10-28: "iron everything and ensure we are good… any logic errors and fixes").
  const out = mine.flatMap((e) => (e.body.type === "agent.message" ? e.body.toolCalls.filter((c) => SUBAGENT.test(c.name) && !answered.has(c.id)) : []));
  if (out.length && (!pick || SUBAGENT.test(pick.name))) {
    const what = (parse(out[0]!.arguments).description as string | undefined) ?? "";
    return { text: out.length > 1 ? `Waiting on ${out.length} subagents` : what ? `Waiting on a subagent: ${clip(what, 40)}` : "Waiting on a subagent", ts: last.ts, steps };
  }
  if (pick) return { text: describeCall(pick), ts: last.ts, steps };
  // Everything it asked for has come back: it is deciding what next.
  return { text: "Thinking about what to do next", ts: mine.at(-1)!.ts, steps };
}

/**
 * Whether text is raw tool output rather than words: a stack frame, a Node internal, a file:line:col, an exception's name, an
 * error code, escape codes, JSON or markup, or more than a couple of lines. A live line in the sidebar, a header or a board card is a
 * status in plain words, never this (Arun, 2026-10-29: a teammate's needs-you line in the sidebar read
 * "node:internal/modules/cjs/loader:1…").
 */
export function isRawError(text: string): boolean {
  const t = text.trim();
  if (t.split("\n").filter((l) => l.trim()).length > 2) return true;
  return /node:internal|\x1b\[|^\s*at\s|\bat\s+\S+\s+\(|\(\S+:\d+:\d+\)|\S+\.(?:[cm]?[jt]sx?|py|rb|go|rs|java):\d+|\b[A-Z][A-Za-z]*(?:Error|Exception)\b|\bTraceback\b|\b(?:E[A-Z]{3,}|MODULE_NOT_FOUND|ERR_[A-Z_]+)\b|^\s*(?:[{<]|\[(?!Friday\]))|npm ERR!|^panic:|\berrno\b/m.test(t);
}

/**
 * What a stopped run says where a status goes: its error when that is already a short line of words ("The folder disconnected."),
 * else what it means ("Stopped: their tool failed to start"). The error itself stays one click away, in the session's feed.
 */
export function stoppedLine(error: string | undefined | null): string {
  const e = (error ?? "").trim();
  if (!e) return "Stopped on an error";
  if (!isRawError(e) && e.length <= 100) return e;
  if (/cannot find module|MODULE_NOT_FOUND|modules\/cjs|ENOENT|EACCES|\bspawn\b|command not found|didn't start|failed to start|exited (?:with )?code|exit code/i.test(e)) return "Stopped: their tool failed to start";
  if (/\btests? (?:failed|failing)\b|\b\d+ failing\b|\bfailed tests?\b/i.test(e)) return "Stopped: tests failed";
  return "Stopped on an error";
}
