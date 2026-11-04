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
    case "use_skill":
      return t ? `Using ${cut(t, 40)}` : "Using a skill";
    default: {
      if (d.name.startsWith("mcp__")) return `Using ${d.name.split("__")[1] ?? "a tool"}`;
      return "Working";
    }
  }
}

/** "4m", "1h 5m": how long something has been quiet, rounded down so it never says more than it knows. */
export function quietFor(since: number, now = Date.now()): string {
  const m = Math.floor((now - since) / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 && h < 10 ? `${h}h ${m % 60}m` : `${h}h`;
}
