import type { Identity } from "../storage.js";
import { isNightAt } from "../../later.js";
import { addCodeChat, isCodeChat } from "./code-chats.js";
import { feedSubscribe } from "./later-feed.js";

/**
 * The chats Run later started (src/later.ts), taken into Code's history once each, marked "Ran overnight" (Arun, 2026-11-20: "Tonight
 * from the IDE: ... with the results waiting in the morning"). A chat is added in the
 * background, so it doesn't take over what a folder shows, and one that reached Agents' list first leaves it again (App hears
 * "friday:code-moved"). One removed from the history, or sent to Agents, is not taken in again. App starts it on load (watchLater), in
 * either mode, so a night with Friday sitting in Agents is taken in just as well.
 *
 * On its own, with nothing shared with the box's Run later (ide/later.ts), so the two lazy chunks stay apart.
 */
interface Started {
  id: string;
  title: string;
  folder: string;
  tool: string;
  at: number;
  status: string;
  sid?: string;
  invite?: string;
  startedAt?: number;
}

const ADOPTED = "friday.later.adopted";
const adopted = (): Set<string> => {
  try {
    return new Set((JSON.parse(localStorage.getItem(ADOPTED) || "[]") as unknown[]).filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
};

/** Each started task not yet taken in, taken in (or skipped when its chat is Code's already). */
export function adoptStarted(tasks: Started[]): void {
  const done = adopted();
  let any = false;
  for (const t of tasks) {
    if (t.status !== "running" || !t.sid || !t.invite || done.has(t.id)) continue;
    done.add(t.id);
    any = true;
    if (isCodeChat(t.sid)) continue;
    const at = t.startedAt ?? t.at;
    // "Ran overnight" only when it began in the night on this clock; a task for an hour on reads "Ran later".
    addCodeChat({ sid: t.sid, invite: t.invite, folder: t.folder, title: t.title, at, tool: t.tool, overnight: at, ran: isNightAt(at, zone()) ? "Ran overnight" : "Ran later" }, { background: true });
    // Already in Agents' list (a reload came first): it is Code's now.
    window.dispatchEvent(new CustomEvent("friday:code-moved", { detail: { sid: t.sid } }));
  }
  if (!any) return;
  try {
    localStorage.setItem(ADOPTED, JSON.stringify([...done].slice(-300)));
  } catch {
    // Storage blocked: they are taken in again at the next load, once per page.
  }
}

const zone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

/** Takes in what starts, as the shared look at the list brings it (every 20 seconds); gives back the way to stop. */
export const watchLater = (identity: Identity): (() => void) => feedSubscribe(identity, (rows) => adoptStarted(rows as unknown as Started[]));
