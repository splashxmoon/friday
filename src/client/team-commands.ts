/**
 * The team's own "/" commands, in place of a coding tool's in a team chat (Arun, 2026-10-28: the critique's '"/" in team chats
 * lists team commands (/stop, /pause, /board, /standup, /assign @x), not Claude Code's'). Read here, apart from what they do, so
 * they can be tested (test/team-status.test.ts).
 *
 */
import type { SlashCommand } from "./Shortcuts.js";

export const STANDUP = "Stand-up: what you did, what's next, and what blocks you. A few lines.";

/** What "/" offers in a team chat. */
export const TEAM_COMMANDS: SlashCommand[] = [
  { name: "stop", hint: "Stop every teammate's turn now; their queues stay", icon: "stop", text: "/stop" },
  { name: "pause", hint: "Hold the crew: nothing new starts until /resume", icon: "pause", text: "/pause" },
  { name: "resume", hint: "Let the crew carry on after a pause", icon: "play", text: "/resume" },
  { name: "away", hint: "Away until 8:00 AM, or a time: /away 7:30", icon: "moon", text: "/away " },
  { name: "back", hint: "End away mode and get the brief", icon: "sun", text: "/back" },
  { name: "board", hint: "Open the board: every task, by teammate", icon: "kanban", text: "/board" },
  { name: "standup", hint: "Ask everyone here for a stand-up", icon: "users", text: "/standup" },
  { name: "assign", hint: "Give one teammate a task: /assign @Kit fix the FAQ", icon: "agent", text: "/assign @" },
];

export type TeamCommand =
  | { kind: "stop" | "pause" | "resume" | "back" | "board" }
  | { kind: "away"; at: string }
  /** Sent as words, to whom they name: "/standup" is everyone's stand-up, "/assign @Kit …" a task for Kit. */
  | { kind: "say"; text: string }
  | { kind: "bad"; why: string };

/** A box's words as a team command, or null when they aren't one (sent as they are). */
export function teamCommand(text: string): TeamCommand | null {
  const m = /^\/([a-z]+)\b\s*([\s\S]*)$/i.exec(text.trim());
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  const rest = m[2]!.trim();
  switch (name) {
    case "stop":
    case "pause":
    case "resume":
    case "back":
    case "board":
      return { kind: name };
    case "away": {
      const at = rest ? toHHMM(rest) : "08:00";
      if (!at) return { kind: "bad", why: "Say when you're back as a time: /away 7:30, or /away for 8:00 AM." };
      return { kind: "away", at };
    }
    case "standup":
      return { kind: "say", text: `@everyone ${rest || STANDUP}` };
    case "assign": {
      const a = /^@(\S+)\s+([\s\S]+)$/.exec(rest);
      if (!a) return { kind: "bad", why: "Name a teammate and the task: /assign @Kit fix the FAQ on Safari." };
      return { kind: "say", text: `@${a[1]} Your task: ${a[2]!.trim()}` };
    }
    default:
      return null;
  }
}

/**
 * "7", "7:30", "7pm", "19:30" as "HH:MM"; null for a time that isn't one, "7:99", "25" or "13pm" (Arun, 2026-10-28: "really iron
 * out bugs and feature problems and gaps"; "/away 7:99" read as 8:39 and "/away 25" as 1:00).
 */
export function toHHMM(t: string): string | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(t.trim());
  if (!m) return null;
  let h = +m[1]!;
  const min = +(m[2] ?? "0");
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
  } else if (h > 23) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}
