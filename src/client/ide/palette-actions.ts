import type { IconName } from "../icons.js";

/**
 * Friday's palette for Code (Arun, 2026-11-19, wave 4: "Friday command palette: one key for every Friday action from the IDE: new chat,
 * hand off, review, race, switch tool, open a session, search"). The IDE's own quick pick lists these (src/vscode-ext/friday/
 * palette.js, which keeps its copy of the list: test/vscode-palette.test.ts holds the two together); this is the same list for the
 * page's palette (Palette.tsx), which opens over Code on ⌘K and ⇧⌘' so nobody has to learn a second one.
 *
 * What shows depends on where the window is: no folder, no chat in the column, nothing to review. A row that cannot do anything is
 * left out, not greyed.
 */
export interface IdeActionState {
  /** The folder Code has open, or null. */
  folder: string | null;
  /** A chat is in the column (not its empty new-chat box). */
  hasChat: boolean;
  /** False only when there is surely nothing to review; unknown is true (Review changes says so itself when it finds none). */
  changes: boolean;
  /** Code's chats, newest first, as many as to list. */
  chats: { sid: string; title: string; folder: string }[];
  /** How many Agents sessions there are to open. */
  agents: number;
  /** Where the list is shown: the IDE's own quick pick lists the chats and sessions on a second pick; the page's palette lists chats as rows (it has the sessions already). */
  where: "ide" | "page";
}

export type IdeActionId =
  | "new-chat"
  | "ask-codebase"
  | "race"
  | "review"
  | "self-review"
  | "send-to-agents"
  | "hand-to-mate"
  | "find-break"
  | "refactor"
  | "switch-tool"
  | "open-chat"
  | "open-session"
  | "open-folder"
  | "search"
  | "agents"
  | "toggle-chat"
  | "settings";

export interface IdeAction {
  id: IdeActionId | `chat:${string}`;
  label: string;
  /** The chord as [Mac, elsewhere], where the IDE has one (written out, as the IDE's own list says them: off the Mac a chord is not always Ctrl for ⌘). */
  hint?: Chord;
  icon: IconName;
  /** One chat to open: a row of its own in the page's palette. */
  sid?: string;
}

export type Chord = [mac: string, pc: string];

interface Def {
  id: IdeActionId;
  label: string;
  icon: IconName;
  hint?: Chord;
  show: (s: IdeActionState) => boolean;
}

const has = (s: IdeActionState) => !!s.folder;
const DEFS: Def[] = [
  { id: "new-chat", label: "New chat", icon: "plus", show: has },
  { id: "ask-codebase", label: "Ask the codebase", icon: "search", hint: ["⌘⌥A", "Ctrl+K Ctrl+A"], show: has },
  { id: "race", label: "Race this ask", icon: "zap", show: has },
  { id: "review", label: "Review changes", icon: "columns", show: (s) => has(s) && s.changes },
  { id: "self-review", label: "Self-review", icon: "shield", show: (s) => has(s) && s.hasChat && s.changes },
  { id: "send-to-agents", label: "Send this chat to Agents", icon: "arrowUpRight", show: (s) => has(s) && s.hasChat },
  { id: "hand-to-mate", label: "Hand to a teammate", icon: "users", show: (s) => has(s) && s.hasChat },
  { id: "find-break", label: "Find what broke", icon: "clock", show: has },
  { id: "refactor", label: "Refactor across the codebase…", icon: "code", show: has },
  { id: "switch-tool", label: "Switch coding tool", icon: "refresh", show: has },
  { id: "open-chat", label: "Open a Code chat…", icon: "chat", show: (s) => s.where === "ide" && s.chats.length > 0 },
  { id: "open-session", label: "Open an Agents session…", icon: "arrowUpRight", show: (s) => s.where === "ide" && s.agents > 0 },
  { id: "open-folder", label: "Open a folder", icon: "folder", show: (s) => !s.folder },
  // The page's palette has its own search and Settings rows already (Palette.tsx baseActions).
  { id: "search", label: "Search chats and sessions", icon: "search", hint: ["⌘⇧F", "Ctrl+Shift+F"], show: (s) => s.where === "ide" },
  { id: "agents", label: "Go to Agents", icon: "message", hint: ["⌘E", "Ctrl+E"], show: () => true },
  { id: "toggle-chat", label: "Show or hide the chat column", icon: "panel", hint: ["⌘⌥B", "Ctrl+Alt+B"], show: () => true },
  { id: "settings", label: "Friday settings", icon: "settings", show: (s) => s.where === "ide" },
];

/** The actions to list for where the window is, in the order they are listed. */
export function ideActionList(s: IdeActionState): IdeAction[] {
  const out: IdeAction[] = DEFS.filter((d) => d.show(s)).map(({ id, label, icon, hint }) => ({ id, label, icon, ...(hint ? { hint } : {}) }));
  // In the page's palette each chat of the folder is a row of its own, after the actions, as the sessions are in the same palette.
  if (s.where === "page") {
    for (const c of s.chats.slice(0, 8)) out.push({ id: `chat:${c.sid}`, label: c.title || "Untitled chat", icon: "chat", sid: c.sid });
  }
  return out;
}

/** What still makes sense while the IDE itself is not up: going to Agents and opening a chat (which brings its folder, and waits for the IDE). */
export function withoutIde(list: IdeAction[]): IdeAction[] {
  return list.filter((a) => a.id === "agents" || a.id.startsWith("chat:"));
}
