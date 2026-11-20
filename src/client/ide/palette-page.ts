import type { Action } from "../Palette.js";
import { IS_MAC } from "../Shortcuts.js";
import { codeChatFor, loadCodeChats, sameFolder } from "./code-chats.js";
import { ideActionList, withoutIde, type IdeAction } from "./palette-actions.js";
import { ideIsUp, runIdeAction } from "./palette-run.js";
import type { Identity } from "../storage.js";

/**
 * The IDE's actions as rows of Friday's own palette, for when it opens over Code (⌘K, ⇧⌘P): the same list the IDE's quick pick shows
 * (Arun, 2026-11-19, wave 4: "one key for every Friday action from the IDE"), each running as that does ("friday:ide-action",
 * palette-run.ts). Only while Code is what shows: in Agents these rows would have nothing to act on. While the IDE itself is not
 * up (not downloaded yet, still starting, can't run here) only the rows that need no IDE are listed, and they run on their own.
 */
export function codeActions(folder: string | null, agents: number, identity: Identity): Action[] {
  const all = loadCodeChats();
  // This folder's chats first, newest first in each.
  const chats = [...all].sort((a, b) => Number(!!folder && sameFolder(b.folder, folder)) - Number(!!folder && sameFolder(a.folder, folder)) || b.at - a.at);
  const up = ideIsUp();
  const full = ideActionList({ folder, hasChat: !!folder && !!codeChatFor(folder), changes: true, chats, agents, where: "page" });
  const list: IdeAction[] = up ? full : withoutIde(full);
  return list.map((a) => ({
    id: `code-${a.id}`,
    label: a.label,
    ...(a.hint ? { hint: a.hint[IS_MAC ? 0 : 1] } : {}),
    icon: a.icon,
    group: a.sid ? "Code chats" : "Code",
    run: () => (up ? window.dispatchEvent(new CustomEvent("friday:ide-action", { detail: { id: a.id, sid: a.sid } })) : runIdeAction(a.id, { identity, root: folder, openChat: () => {} }, { sid: a.sid })),
  }));
}
