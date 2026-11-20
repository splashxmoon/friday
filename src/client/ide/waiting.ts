import { useMemo } from "react";
import { codeChatFor, loadCodeChats, useCodeChats, type CodeChat } from "./code-chats.js";
import { getIdeRoot, getMode, setMode } from "./mode.js";

/**
 * One "Waiting on you" across Code and Agents (Arun, 2026-11-19: "we also need to ensure like code and like agent platform can be
 * interconnected and streamlined"). Code's chats are kept out of Agents' list (code-chats.ts), so nothing asked about them: an
 * approval in a Code chat waited unseen from Agents. These helpers let the attention poll and the Needs you page ask about them
 * too, WITHOUT listing them in Agents' sidebar, say where each one lives ("Code · folder"), and open it there.
 */

/** Only this many of the newest chats are asked about: the poll reads every session it is given, and a long history is mostly done. */
const WATCHED = 40;

/** A folder's last name, from either slash style. */
export const folderName = (folder: string): string => folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder;

/** Where a Code chat's wait is said to be, wherever Agents lists it: "Code · myapp". */
export const codeWhere = (chat: Pick<CodeChat, "folder">): string => `Code · ${folderName(chat.folder)}`;

/** The sessions to ask about: Agents' own, the team's, and Code's newest chats, each once. */
export function watchedSids(agents: string[], more: string[], code: Pick<CodeChat, "sid">[]): string[] {
  return [...new Set([...agents, ...more, ...code.slice(0, WATCHED).map((c) => c.sid)])];
}

/** Code's chats the poll asks about, kept current as they change. */
export function useCodeWatched(): CodeChat[] {
  const chats = useCodeChats();
  // A linked chat is an Agents session shown in Code: Agents already asks about it, and it is said to be in Agents.
  return useMemo(() => chats.filter((c) => !c.linked).slice(0, WATCHED), [chats]);
}

/** The Code chat a session is, if it is one of Code's own (a linked one is an Agents session shown in Code, and stays Agents'). */
export const codeChatOf = (sid: string | undefined): CodeChat | undefined => (sid ? loadCodeChats().find((c) => c.sid === sid && !c.linked) : undefined);

/** How many waits are Agents' own: not in a Code chat, not a review (the IDE's own task line counts those it has). */
export function agentsWaiting(needs: { sid?: string; kind?: string; putOff?: boolean }[], isCode: (sid: string) => boolean): number {
  return needs.filter((n) => !n.putOff && n.kind !== "review" && !(n.sid && isCode(n.sid))).length;
}

/** The Code chat on screen right now: its own column already shows what it waits on, so it is not chimed over. */
export function shownInCode(sid: string): boolean {
  if (getMode() !== "code") return false;
  const root = getIdeRoot();
  return !!root && codeChatFor(root)?.sid === sid;
}

/**
 * Opens a wait where it lives. App's friday:open-session handler routes it (a Code chat in Code, in its folder; a session of
 * the list on Agents), so the routing is kept in that one place.
 */
export function openWaiting(sid: string, invite?: string): void {
  window.dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid, ...(invite ? { invite } : {}) } }));
}

/** Agents' Needs you page, from wherever (the IDE's footer). */
export function openAgentsNeeds(): void {
  setMode("agents");
  window.dispatchEvent(new Event("friday:open-needs"));
}
