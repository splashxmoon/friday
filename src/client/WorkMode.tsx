/**
 * Code or Crew, and what is left of Work (engine/work.ts). Work is gone from the app (Arun, 2026-11-03: "remove work, this mainly
 * for coding and stuff, i think working gets in the way"): its sessions made before still open, list apart from Code's and keep
 * their permission words; the new-session page's Work mode, its starters and its second tool went with it.
 */
import { useEffect, useRef, useState } from "react";
import { pollWhileShown } from "./app-push.js";
import type { EngineMode } from "../types.js";
import { Icon } from "./icons.js";
import { api } from "./api.js";
import type { Identity } from "./storage.js";
import { isTeamSid, readTabNow, setTeamTab, useTeamKnown, useTeamTab } from "./Teammates.js";
import { tabListKeys } from "./roving.js";
import { leaving } from "./leave-guard.js";
import "./work.css";

/** Code or Crew, from anywhere (⌘K's "Switch to…"): as the window's switch picks it. */
export function choosePlace(p: "code" | "team"): void {
  if (p !== "team" && readTabNow() && leaving(() => choosePlace(p))) return;
  setTeamTab(p === "team");
}

/**
 * The Work sessions you are in, as the server says (its list marks them) and as this page makes them; remembered on this computer,
 * so one the server no longer has (gone with a restart) is still told apart and stays out of Code's list (the 2026-10-28
 * critique: Code's list showed "Open-source launch posts").
 */
const SIDS_KEY = "friday.work.sids";
const workSids = new Set<string>(
  (() => {
    try {
      return (JSON.parse(localStorage.getItem(SIDS_KEY) ?? "[]") as string[]).filter((x) => typeof x === "string");
    } catch {
      return [];
    }
  })(),
);
const keepSids = () => {
  try {
    localStorage.setItem(SIDS_KEY, JSON.stringify([...workSids].slice(-500)));
  } catch {
    // Read again from the server next time.
  }
};
/** Whether the server's list has been read once: until then nothing can be told apart, and Work's "Right now" waits for it. */
let listed = false;
export const workListed = () => listed;
/** Whether a session is a Work session, as the sidebar knows it. */
export const isWorkSid = (sid: string) => workSids.has(sid);
export function markWorkSession(sid: string): void {
  workSids.add(sid);
  keepSids();
  dispatchEvent(new Event("friday:work-sessions"));
}

export function useWorkSessions(identity: Identity): Set<string> {
  const [, bump] = useState(0);
  useEffect(() => {
    let gone = false;
    const look = () =>
      void api<{ sessions?: { sid: string; work?: boolean }[] }>(identity, "/api/sessions/mine")
        .then((r) => {
          if (gone) return;
          const had = workSids.size;
          const first = !listed;
          for (const s of r.sessions ?? []) if (s.work) workSids.add(s.sid);
          listed = true;
          bump((n) => n + 1);
          // Told to the rest of the page too, as markWorkSession tells it: the folded rail reads the same list (useWorkSids).
          if (workSids.size !== had) keepSids();
          if (workSids.size !== had || first) dispatchEvent(new Event("friday:work-sessions"));
        })
        // Unreadable, the lists show as they are rather than empty for good.
        .catch(() => void ((listed = true), bump((n) => n + 1)));
    // Asked when a session's log grows (a new one among them; app-push.ts), not every 30 seconds; as before where nothing tells it.
    const stop = pollWhileShown(look, { every: 30_000, on: ["sessions"] });
    const heard = () => bump((n) => n + 1);
    addEventListener("friday:work-sessions", heard);
    return () => {
      gone = true;
      stop();
      removeEventListener("friday:work-sessions", heard);
    };
  }, [identity.id]);
  return workSids;
}

/** The Work sessions as the sidebar knows them, re-read whenever that list grows (`friday:work-sessions`). */
/**
 * The place follows the session that is open: a Crew room opened from a notification turns to Crew, a coding one to Code (2026-10-27
 * audit: the rail and the tabs said Code while a Crew room was open). Only when the open session changes, so turning to the other
 * place while one is open is left alone.
 */
export function usePlaceFollows(activeSid: string | null): void {
  const [team, setTeam] = useTeamTab();
  const teamKnown = useTeamKnown();
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!activeSid) return void (last.current = null);
    // Not before the team is known: a Crew room read as a coding session until then, and turned the place away from Crew.
    if (!teamKnown) return;
    const crew = isTeamSid(activeSid);
    const key = `${activeSid}:${crew}`;
    if (last.current === key) return;
    last.current = key;
    if (crew !== team) setTeam(crew);
  }, [activeSid, teamKnown]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * The other way round: Code or Crew picked while a session of the other place is open goes to the new place's home, rather than
 * leaving that session on screen under a list it isn't in (Arun, 2026-10-28). `elsewhere`: a page that is no place's (Settings,
 * Usage, the Agent Board…), left the same way (2026-11-02 walk-through).
 */
export function usePlaceLeaves(activeSid: string | null, home: () => void, elsewhere = false): void {
  const [team] = useTeamTab();
  const teamKnown = useTeamKnown();
  const was = useRef(team);
  useEffect(() => {
    if (was.current === team) return;
    was.current = team;
    if (elsewhere) return home();
    if (!activeSid || !teamKnown) return;
    if (isTeamSid(activeSid) !== team) home();
  }, [team]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function useWorkSids(): ReadonlySet<string> {
  const [, bump] = useState(0);
  useEffect(() => {
    const heard = () => bump((n) => n + 1);
    addEventListener("friday:work-sessions", heard);
    return () => removeEventListener("friday:work-sessions", heard);
  }, []);
  return workSids;
}

/** Which of Code and Crew has an agent at work, or one waiting on the person, from the sessions the sidebar watches. */
export function placesBusy(working: Iterable<string>, needs: Iterable<string>): Record<"code" | "team", "needs" | "working" | null> {
  const out: Record<"code" | "team", "needs" | "working" | null> = { code: null, team: null };
  const place = (sid: string) => (isTeamSid(sid) ? "team" : "code");
  for (const sid of working) out[place(sid)] ??= "working";
  for (const sid of needs) out[place(sid)] = "needs";
  return out;
}

/**
 * The difference between the two, said once where people choose (the "Why Crew" plan, 2026-11-13): each tab's tip and, beside its
 * name, its accessible description. The whole sentence on both, so either one says what the other is.
 */
export const PLACE_WHY = "Code: a task you drive, with your team. Crew: crew mates who keep working without you.";

/**
 * Code or Crew, as one small switch: in the desktop app it sits in the window's bar beside the sidebar's button, where back and
 * forward were, so it is in reach with the sidebar shut too; in a browser, at the top of the sidebar (Arun, 2026-11-03: "get rid
 * of the arrows, and make a simple and easier toggle to switch between Code and Crew.... it should be simple and elegant").
 * Two words on a track, the picked one raised on a thumb that slides between them. The other place shows a small amber dot
 * when something there waits on you; working shows on the faces and marks themselves (2026-10-29 direction §8).
 */
export function CodeCrewToggle({ working = [], needs = [], className = "" }: { working?: Iterable<string>; needs?: Iterable<string>; className?: string }) {
  const [team] = useTeamTab();
  const busy = placesBusy(working, needs);
  // On the hosted service, someone asking one of your crew mates something waits on you in the Crew too (CrewHosted.tsx).
  const here = team ? "team" : "code";
  const hint = (p: "code" | "team") => (p !== here && busy[p] === "needs" ? <span className="ps-hint" aria-hidden="true" /> : null);
  // A tab list's keys: the arrows move between the two and pick, only the picked one is a Tab stop (roving.ts).
  return (
    <div className={`place-switch ${className}`} data-on={here} role="tablist" aria-label="Code or Crew" onKeyDown={tabListKeys}>
      <span className="ps-thumb" aria-hidden="true" />
      <button type="button" role="tab" tabIndex={here === "code" ? 0 : -1} aria-selected={here === "code"} onClick={() => choosePlace("code")} title={PLACE_WHY} aria-label={busy.code === "needs" && here !== "code" ? "Code, waiting on you" : "Code"}>
        {/* Icons, the word in the tip and to a screen reader (Arun, 2026-11-03: "swap out the text for icons instead"); in a
            browser's sidebar, where it has the room, the word beside it too. */}
        <Icon name="code" size={15} />
        <span className="ps-word">Code</span>
        {hint("code")}
      </button>
      <button type="button" role="tab" tabIndex={here === "team" ? 0 : -1} aria-selected={here === "team"} onClick={() => choosePlace("team")} title={PLACE_WHY} aria-label={busy.team === "needs" && here !== "team" ? "Crew, waiting on you" : "Crew"}>
        <Icon name="users" size={15} />
        <span className="ps-word">Crew</span>
        {hint("team")}
      </button>
    </div>
  );
}

/** What each permission means in Work, in its words: pieces saved, not files edited and commands run (w1 P3). */
export const WORK_MODE_BLURB: Record<EngineMode, string> = {
  plan: "Reads and suggests. Saves nothing.",
  edits: "Writes and saves pieces, and asks before anything else.",
  full: "Works without asking.",
};
