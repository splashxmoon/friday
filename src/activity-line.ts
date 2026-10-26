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
  if (pick) return { text: describeCall(pick), ts: last.ts, steps };
  // Everything it asked for has come back: it is deciding what next.
  return { text: "Thinking about what to do next", ts: mine.at(-1)!.ts, steps };
}
