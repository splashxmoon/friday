import { createContext, type ReactNode } from "react";
import type { AttentionState } from "./Attention.js";
import type { RecentSession } from "./storage.js";

/**
 * What a coding session's thread tabs read from the app (threads.tsx): every session's state, the sessions you have, and the way to
 * add one to them. Handed down by App rather than passed through SessionView's props, which only the header uses.
 */
export interface ThreadsData {
  attention: AttentionState;
  recents: RecentSession[];
  /** A session started from the tabs, onto the list at once (App.tsx remember), so it is a tab before it is opened. */
  remember: (r: RecentSession) => void;
  /** A thread's ring, as its sidebar row draws it (Sidebar.tsx ThreadRing). */
  ring: (sid: string, active: boolean) => ReactNode;
}

export const ThreadsCtx = createContext<ThreadsData | null>(null);

/** ⌘N in a coding session: its New thread popover. App sends it, the header's tabs answer by setting `handled`. */
export const NEW_THREAD = "friday:new-thread";

/** A folder's + in the sidebar: its newest thread opens with New thread up (threads.tsx reads the mark as it mounts). */
export const NEW_THREAD_ON_OPEN = "mpa.newThreadOnOpen";
