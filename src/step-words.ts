/**
 * What a working agent is doing, in the few words a sidebar row has room for (Arun, 2026-11-03, after Orca's row line: the most
 * telling thing first, so a cut line loses the detail and keeps the state). Shared by the server, which keeps each agent's latest
 * step (projection.ts doing), and the page, which says it.
 */

/** How long a working agent may go unheard before its row says so: a slow build or test run says nothing for minutes, but ten
 * minutes of silence is worth a look, and is said as "no update in 12m", never as done (Orca's honest decay). */
export const QUIET_AFTER_MS = 10 * 60_000;

const base = (p: string) => p.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? p;
const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A tool call as what it touches, for "Editing Sidebar.tsx" on a row: the file, command, pattern or address it names, short. */
export function callDoing(call: { name: string; arguments: string }): { name: string; target?: string } {
  let args: Record<string, unknown> = {};
  try {
    const v = JSON.parse(call.arguments) as unknown;
    if (v && typeof v === "object") args = v as Record<string, unknown>;
  } catch {
    // Arguments still being written, or not JSON: the verb alone.
  }
  const pick = ["path", "file_path", "command", "pattern", "query", "url", "name", "description"].map((k) => args[k]).find((v): v is string => typeof v === "string" && !!v.trim());
  const target = pick?.trim().split(/\r?\n/)[0]!.slice(0, 120);
  return { name: call.name.slice(0, 60), ...(target ? { target } : {}) };
}

/** "Editing Sidebar.tsx", "Running npm test", "Searching the web": a step as it happens, from its tool's common name. */
export function doingWords(d: { name: string; target?: string }): string {
  const t = d.target?.trim() ?? "";
  switch (d.name) {
    case "edit":
    case "edit_file":
      return t ? `Editing ${base(t)}` : "Editing";
    case "write":
    case "write_file":
      return t ? `Writing ${base(t)}` : "Writing";
    case "read":
    case "read_file":
      return t ? `Reading ${base(t)}` : "Reading";
    case "shell":
    case "run_command":
      return t ? `Running ${cut(t, 48)}` : "Running a command";
    case "run_background":
      return t ? `Starting ${cut(t, 40)} in the background` : "Starting a background command";
    case "read_background":
      return "Checking on a background command";
    case "stop_background":
      return "Stopping a background command";
    case "search":
    case "search_code":
      return t ? `Searching ${cut(t, 40)}` : "Searching";
    case "list_files":
    case "tree":
      return "Looking through the files";
    case "web_search":
      return "Searching the web";
    case "web_fetch":
    case "fetch_url":
      return t ? `Reading ${host(t)}` : "Reading a page";
    case "todo":
    case "update_plan":
    case "TodoWrite":
      return "Planning";
    case "ask_human":
      return "Asking you";
    case "hand_off":
      return "Handing off";
    case "deploy_agent":
      return "Deploying a specialist";
    case "show_preview":
      return "Starting a preview";
    case "remember":
      return "Making a note";
    case "use_skill":
      return t ? `Using ${cut(t, 40)}` : "Using a skill";
    default: {
      if (d.name.startsWith("mcp__")) return `Using ${d.name.split("__")[1] ?? "a tool"}`;
      if (SUBAGENT.test(d.name)) return t ? `Sending off a subagent: ${cut(t, 40)}` : "Sending off a subagent";
      return "Working";
    }
  }
}

/** The names coding tools give the call that sends a subagent off (client/Subagents.tsx SUBAGENT_CALL). */
export const SUBAGENT = /^(task|agent|spawn_agent|subagent)$/i;

/**
 * Where a working agent is between steps, said the same in every place that says it (spec 13 polish; Arun, 2026-11-24: "Go all out
 * and fix these problems"): the sidebar's row, the side panel's agent, the thread card, the Agent Board and the reply's own live
 * line. Started and nothing heard yet; its step back and it deciding what next; or only writing its answer, with no step under way.
 */
export type LivePhase = "starting" | "thinking" | "writing";
export const LIVE_WORDS: Record<LivePhase, string> = { starting: "Getting started", thinking: "Thinking about what to do next", writing: "Writing its answer" };

/** What a lane's agent is streaming of its current message now: its words, its thinking, or nothing (bus.ts streamingNow). */
export type Streaming = "text" | "reasoning" | null;

/** Where a working agent with no step under way is: writing words, thinking (aloud, or with its step back), or not heard from yet. */
export function livePhase(spoke: boolean, streaming: Streaming): LivePhase {
  return streaming === "text" ? "writing" : streaming === "reasoning" || spoke ? "thinking" : "starting";
}

/** A working agent's words: its step under way, else where it is between steps (LIVE_WORDS). The one wording every place reads. */
export function liveWords(a: { doing?: { name: string; target?: string } | undefined; phase?: LivePhase | undefined }): string {
  return a.doing ? doingWords(a.doing) : LIVE_WORDS[a.phase ?? "starting"];
}

/** "4m", "1h 5m": how long something has been quiet, rounded down so it never says more than it knows. */
export function quietFor(since: number, now = Date.now()): string {
  const m = Math.floor((now - since) / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 && h < 10 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** How long a run has been going, counted up in place: "14s", "2m 14s", "1h 5m" (the board's cards, the sidebar's working rows). */
export function runClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * What a session's agent at work is doing, in the words a row says it ("Editing Sidebar.tsx", "Writing its answer"), from its crew
 * (attention.ts crewOf): the first working agent with a step under way, else the first working one where it is between steps. Null
 * when none is working.
 */
export function workingStep(agents: readonly { state: string; doing?: { name: string; target?: string }; phase?: LivePhase }[] | undefined): string | null {
  const a = agents?.find((x) => x.state === "working" && x.doing) ?? agents?.find((x) => x.state === "working");
  return a ? liveWords(a) : null;
}
