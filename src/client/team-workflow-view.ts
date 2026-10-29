/**
 * Which automations the Automations page shows while the sidebar's Team tab is on: the team's workflows (TeamWorkflows.tsx), or
 * the coding tools' own (Automations.tsx), remembered on this computer (Arun, 2026-10-28: "make the automation for the teams
 * platform different…"). Kept apart from the page so the app, the rail and the Team room's header can say it without loading it.
 *
 */
import { useEffect, useRef, useState } from "react";
import { notificationsOn } from "./prefs.js";
import { setTeamTab, useTeamNow, type Team } from "./Teammates.js";

export type AutomationsView = "workflows" | "coding";
const KEY = "friday.automationsView";
const EVENT = "friday:automations-view";

const read = (): AutomationsView => {
  try {
    return localStorage.getItem(KEY) === "coding" ? "coding" : "workflows";
  } catch {
    return "workflows";
  }
};

export function setAutomationsView(v: AutomationsView): void {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    // A preference: losing it costs nothing.
  }
  dispatchEvent(new Event(EVENT));
}

export function useAutomationsView(): [AutomationsView, (v: AutomationsView) => void] {
  const [v, setV] = useState(read);
  useEffect(() => {
    const heard = () => setV(read());
    addEventListener(EVENT, heard);
    return () => removeEventListener(EVENT, heard);
  }, []);
  return [v, setAutomationsView];
}

/** The team's workflows, from anywhere (the Team room's header, ⌘K): the Team tab on, and the Automations page showing them. */
export function openWorkflows(): void {
  setAutomationsView("workflows");
  setTeamTab(true);
  if (new URLSearchParams(location.search).get("view") === "automations") return void dispatchEvent(new CustomEvent("friday:same-page", { detail: "automations" }));
  history.pushState(null, "", "/?view=automations");
  dispatchEvent(new PopStateEvent("popstate"));
}

/** A finished run the person asked to be told about (team-workflows.ts WorkflowEnded), as GET /api/teammates sends it (`ran`). */
type Ended = { id: string; name: string; run: string; status: string; ended: number; sid?: string; roomName: string; note?: string };

/**
 * A workflow's run ending, said outside the app (its "Tell me when it ends"): each run once, those that end while the app is
 * open, from the team as it is polled. Pressing it opens the room it ran in.
 */
export function useWorkflowNotices(): void {
  const t = useTeamNow() as (Team & { ran?: Ended[] }) | null;
  const since = useRef(Date.now());
  const told = useRef(new Set<string>());
  useEffect(() => {
    for (const e of t?.ran ?? []) {
      if (e.ended < since.current || told.current.has(e.run)) continue;
      told.current.add(e.run);
      if (typeof Notification === "undefined" || Notification.permission !== "granted" || !notificationsOn()) continue;
      const invite = e.sid === t?.sid ? t?.invite : t?.rooms.find((r) => r.sid === e.sid)?.invite;
      try {
        const n = new Notification(e.status === "done" ? `${e.name} finished` : `${e.name} didn't finish`, { body: e.status === "done" ? `Its brief is in ${e.roomName}.` : (e.note ?? `See ${e.roomName}.`), tag: `workflow:${e.run}` });
        n.onclick = () => (window.focus(), n.close(), e.sid && invite && dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid: e.sid, invite } })));
      } catch {
        // Notifications are a courtesy; a browser that refuses them changes nothing.
      }
    }
  }, [t]);
}
