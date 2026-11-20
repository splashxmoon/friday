import { useSyncExternalStore } from "react";
import { api } from "../api.js";
import { Icon } from "../icons.js";
import type { Identity } from "../storage.js";
import { sameFolder, unclaimCodeChat, type CodeChat } from "./code-chats.js";
import { buildPacket, gatherFacts, handoffText } from "./handoff-packet.js";

/**
 * "Send to Agents" (Arun, 2026-11-19: "easy passing of work between Code and Agents. A Code chat that turns into a big job moves
 * to Agents with one click. Its summary, branch, diff, open questions and rules go with it, and the Code tab becomes a small
 * 'Moved to Agents · open' link"). The chat is one session underneath, so its steps, branch, changes, questions and rules go with
 * it as they are; what moves is where it is listed (out of Code's chats, into Agents' recents) and one note to its agent so the
 * hand-off is written down where the next person in Agents reads it.
 */

/** A chat that has just moved, kept (until closed) so Code's column can say where it went. Per window (sessionStorage, so a reload keeps it): it is a notice, not data. */
export interface MovedChat {
  sid: string;
  invite: string;
  folder: string;
  title: string;
  /** Handed to a Crew teammate rather than Agents (hand-to-mate.tsx): the tab reads "With <name>" and opens that teammate's thread. */
  mate?: { id: string; name: string; look?: string; job: string };
}

const listeners = new Set<() => void>();
const KEY = "friday.code.moved";
const load = (): MovedChat[] => {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v.filter((m) => m && typeof m.sid === "string" && typeof m.invite === "string" && typeof m.folder === "string") : [];
  } catch {
    return [];
  }
};
let moved: MovedChat[] = load();
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
const change = (next: MovedChat[]) => {
  moved = next;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(next.slice(-20)));
  } catch {}
  listeners.forEach((l) => l());
};
/** A chat that has left Code for somewhere else, noted for the column's tab. */
export const noteMoved = (m: MovedChat): void => change([...moved.filter((x) => x.sid !== m.sid), m]);
export const dismissMoved = (sid: string): void => change(moved.filter((m) => m.sid !== sid));
/** The folder's "Moved to Agents" tabs, in the order they moved; the same list between changes. */
const memo = new Map<string, { from: MovedChat[]; list: MovedChat[] }>();
const EMPTY: MovedChat[] = [];
export function useMovedChats(folder: string): MovedChat[] {
  return useSyncExternalStore(
    subscribe,
    () => {
      if (!folder) return EMPTY;
      const hit = memo.get(folder);
      if (hit && hit.from === moved) return hit.list;
      const list = moved.filter((m) => sameFolder(m.folder, folder));
      const out = list.length ? list : EMPTY;
      memo.set(folder, { from: moved, list: out });
      return out;
    },
    () => EMPTY,
  );
}

/**
 * The note to the agent is the shared hand-off packet (handoff-packet.ts, also what Hand to a teammate writes): the session's
 * facts as far as they can be read, and the agent is asked to write the hand-off down in a few lines, so the person who opens it
 * in Agents reads that.
 */
export { handoffText };

/**
 * Moves a Code chat to Agents. The note goes first (if it can't be sent, nothing has moved); then the chat leaves Code's lists and
 * App takes it into Agents' recents. Opening it there (switch to Agents, go to the session) is a second event so the placeholder's
 * "Open in Agents" does the same.
 */
export async function sendToAgents(identity: Identity | null, chat: CodeChat, onMoved?: () => void): Promise<void> {
  if (identity) {
    const facts = await gatherFacts(identity, chat, { rulesFor: false }).catch(() => ({ title: chat.title, folder: chat.folder }));
    await api(identity, `/api/sessions/${encodeURIComponent(chat.sid)}/instruct?invite=${encodeURIComponent(chat.invite)}`, {
      method: "POST",
      body: JSON.stringify({ text: buildPacket(facts, { kind: "agents" }) }),
    });
  }
  onMoved?.();
  unclaimCodeChat(chat.sid);
  change([...moved.filter((m) => m.sid !== chat.sid), { sid: chat.sid, invite: chat.invite, folder: chat.folder, title: chat.title }]);
  window.dispatchEvent(new CustomEvent("friday:code-to-agents", { detail: { sid: chat.sid, invite: chat.invite, title: chat.title } }));
}

/** Switches to Agents and opens the session there. */
export const openInAgents = (m: Pick<MovedChat, "sid" | "invite" | "title">): void =>
  void window.dispatchEvent(new CustomEvent("friday:code-to-agents", { detail: { sid: m.sid, invite: m.invite, title: m.title, open: true } }));

/** What Code's column shows under a "Moved to Agents" tab. */
export function MovedPanel({ chat, onClose }: { chat: MovedChat; onClose: () => void }) {
  return (
    <div className="ia-empty ia-start ia-moved">
      <span className="ia-hero" aria-hidden="true"><Icon name="arrowUpRight" size={20} /></span>
      <p className="ia-empty-title">Moved to Agents</p>
      <p>“{chat.title || "Untitled"}” carries on there, with its changes, branch and questions.</p>
      <button type="button" className="ia-btn" onClick={() => openInAgents(chat)}>
        Open in Agents <Icon name="arrowUpRight" size={13} />
      </button>
      <button type="button" className="ia-link" onClick={onClose}>Close this tab</button>
    </div>
  );
}
