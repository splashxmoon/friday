import { useSyncExternalStore } from "react";

/** Which tab of a teammate's page is open (TeammatePage.tsx): kept apart from the page so the app's start can read it without it. */
export type MateTab = "chat" | "activity" | "results" | "skills" | "memory" | "settings";

/** Which tab each teammate's page is on, for this visit: back on Chat when the page is next opened fresh. */
const tabs = new Map<string, MateTab>();
const watchers = new Set<() => void>();
let tabsVersion = 0;
export const setMateTab = (lane: string, tab: MateTab) => (tabs.set(lane, tab), tabsVersion++, watchers.forEach((f) => f()));
export const useMateTab = (lane: string): MateTab => {
  useSyncExternalStore(
    (f) => (watchers.add(f), () => void watchers.delete(f)),
    () => tabsVersion,
  );
  return tabs.get(lane) ?? "chat";
};
