/**
 * The crew's workflows from anywhere (the Crew room's More, ⌘K, a run's notice) and the notices of their runs. Kept apart from the
 * page so the app, the rail and the Crew room's header can reach them without loading it.
 */
import { useEffect, useRef } from "react";
import { notificationsOn } from "./prefs.js";
import { useTeamNow, type Team } from "./Teammates.js";

/**
 * The crew's workflows, from anywhere: the Automations page, where they are listed with the coding tools' own (the "Why Crew" plan,
 * 2026-11-13: one list). In both editions; the hosted Crew's old link (?view=crew&tab=workflows) shows the same list.
 */
export function openWorkflows(): void {
  if (new URLSearchParams(location.search).get("view") === "automations") return void dispatchEvent(new CustomEvent("friday:same-page", { detail: "automations" }));
  history.pushState(null, "", "/?view=automations");
  dispatchEvent(new PopStateEvent("popstate"));
}

/** A field of the team that is a list here and may be something else on the hosted service: the list, or none. */
export const listOf = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** A run waiting for your OK, as GET /api/teammates sends it (`asks`): what the notice needs of it. */
type Asking = { name: string; run: string; ask: string; since: number };

/** A finished run the person asked to be told about (team-workflows.ts WorkflowEnded), as GET /api/teammates sends it (`ran`). */
type Ended = { id: string; name: string; run: string; status: string; ended: number; sid?: string; roomName: string; note?: string };

/**
 * A workflow's run ending, said outside the app (its "Tell me when it ends"): each run once, those that end while the app is
 * open, from the team as it is polled. Pressing it opens the room it ran in.
 */
export function useWorkflowNotices(): void {
  const t = useTeamNow() as (Team & { ran?: Ended[]; asks?: Asking[] }) | null;
  const since = useRef(Date.now());
  const told = useRef(new Set<string>());
  useEffect(() => {
    // A run waiting for your OK: said once, as it starts waiting; pressing it opens the workflows, where the card is.
    // The hosted service's team has an `asks` of its own, not a list (Teammates.tsx HostedTeam): read as one only when it is.
    for (const a of listOf<Asking>(t?.asks)) {
      const key = `ask:${a.run}:${a.since}`;
      if (a.since < since.current || told.current.has(key)) continue;
      told.current.add(key);
      if (typeof Notification === "undefined" || Notification.permission !== "granted" || !notificationsOn()) continue;
      try {
        const n = new Notification(`${a.name} needs your OK`, { body: a.ask, tag: `workflow-ask:${a.run}` });
        n.onclick = () => (window.focus(), n.close(), openWorkflows());
      } catch {
        // A courtesy, as below.
      }
    }
    for (const e of listOf<Ended>(t?.ran)) {
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
