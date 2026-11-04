/**
 * The new-session page's Work mode (engine/work.ts): Code or Work above the box, and in Work, the second tool brought in beside the
 * first on the same folder, so Claude Code and Codex make it together (Arun, 2026-10-26: "link up codex and claude co work to help
 * me with my content stuff").
 *
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ENGINE_NAMES, type EngineMode, type EngineTool } from "../types.js";
import { Icon } from "./icons.js";
import { api } from "./api.js";
import { hostApi } from "./local.js";
import type { Identity } from "./storage.js";
import { isTeamSid, readTabNow, setTeamTab, useTeamKnown, useTeamTab } from "./Teammates.js";
import { tabListKeys } from "./roving.js";
import { leaving } from "./leave-guard.js";
import "./work.css";

/**
 * Work is gone from the app (Arun, 2026-11-03: "remove work, this mainly for coding and stuff, i think working gets in the way"):
 * the mode is always off, so the new-session page is Code's and every session, Work ones made before included, lists under Code.
 */
export function useWorkMode(): [boolean, (on: boolean) => void] {
  return [false, () => {}];
}

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
    look();
    const t = setInterval(look, 30_000);
    const heard = () => bump((n) => n + 1);
    addEventListener("friday:work-sessions", heard);
    return () => {
      gone = true;
      clearInterval(t);
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
 * Code or Crew, as one small switch: in the desktop app it sits in the window's bar beside the sidebar's button, where back and
 * forward were, so it is in reach with the sidebar shut too; in a browser, at the top of the sidebar (Arun, 2026-11-03: "get rid
 * of the arrows, and make a simple and easier toggle to switch between Code and Crew.... it should be simple and elegant").
 * Two words on a track, the picked one raised on a thumb that slides between them. The other place shows a small amber dot
 * when something there waits on you; working shows on the faces and marks themselves (2026-10-29 direction §8).
 */
export function CodeCrewToggle({ working = [], needs = [], className = "" }: { working?: Iterable<string>; needs?: Iterable<string>; className?: string }) {
  const [team] = useTeamTab();
  const busy = placesBusy(working, needs);
  // On the hosted service, someone asking one of your teammates something waits on you in the Crew too (CrewHosted.tsx).
  const here = team ? "team" : "code";
  const hint = (p: "code" | "team") => (p !== here && busy[p] === "needs" ? <span className="ps-hint" aria-hidden="true" /> : null);
  // A tab list's keys: the arrows move between the two and pick, only the picked one is a Tab stop (roving.ts).
  return (
    <div className={`place-switch ${className}`} data-on={here} role="tablist" aria-label="Code or Crew" onKeyDown={tabListKeys}>
      <span className="ps-thumb" aria-hidden="true" />
      <button type="button" role="tab" tabIndex={here === "code" ? 0 : -1} aria-selected={here === "code"} onClick={() => choosePlace("code")} title="Code: you and your coding tools, on one change" aria-label={busy.code === "needs" && here !== "code" ? "Code, waiting on you" : "Code"}>
        {/* Icons, the word in the tip and to a screen reader (Arun, 2026-11-03: "swap out the text for icons instead"); in a
            browser's sidebar, where it has the room, the word beside it too. */}
        <Icon name="code" size={15} />
        <span className="ps-word">Code</span>
        {hint("code")}
      </button>
      <button type="button" role="tab" tabIndex={here === "team" ? 0 : -1} aria-selected={here === "team"} onClick={() => choosePlace("team")} title="Crew: teammates who keep their role and memory, and work on your goals while you're away" aria-label={busy.team === "needs" && here !== "team" ? "Crew, waiting on you" : "Crew"}>
        <Icon name="users" size={15} />
        <span className="ps-word">Crew</span>
        {hint("team")}
      </button>
    </div>
  );
}

/** Claude Code and Codex make the pair; the other of the two is the teammate of whichever leads. */
export function teammateOf(lead: EngineTool | "", ready: EngineTool[]): EngineTool | null {
  const other: EngineTool | undefined = lead === "codex" ? "claude" : lead === "claude" ? "codex" : undefined;
  return other && ready.includes(other) ? other : null;
}

/** The question over the box in Work, asked a different way each time, about making things rather than code (Arun, 2026-10-27: "add different phrases for the work session dialogue too"). */
export const WORK_LINES = [
  "What are we making today?",
  "What's the story?",
  "What should we write?",
  "What are we posting this week?",
  "What should we look into?",
  "What's worth a thread?",
  "What should become a video?",
  "What's the big idea?",
  "What needs a first draft?",
  "What are we launching?",
  "What deserves a better headline?",
  "What's on the calendar?",
  "What should we research?",
  "What needs a script?",
  "What should we make next?",
];

// Examples, not a second question: the headline over the box already asks one (2026-10-27 design review).
export const WORK_PLACEHOLDER = "A thread from this video, a week of posts, a script, a research brief…";

/** What each permission means in Work, in its words: pieces saved, not files edited and commands run (w1 P3). */
export const WORK_MODE_BLURB: Record<EngineMode, string> = {
  plan: "Reads and suggests. Saves nothing.",
  edits: "Writes and saves pieces, and asks before anything else.",
  full: "Works without asking. Anyone driving this session can.",
};

/**
 * A first press for an empty box: each fills it with the start of a task, to finish in your own words (the 2026-10-28 critique).
 * Text pills under the box, no icons, as Code's home has none (DIRECTION.md §9.7; Arun, 2026-10-29: "so clean and beautiful really
 * with a clear direction in design language"): picking one fills the box the way Grok Bot previews a role.
 */
export const WORK_STARTERS: { label: string; text: string }[] = [
  { label: "Thread from a link", text: "Write a thread from this link: " },
  { label: "A week of posts", text: "Plan and draft a week of posts about " },
  { label: "Research brief", text: "Research and write a short brief, with sources, on " },
  { label: "Cover image", text: "Make a cover image for " },
];
export function WorkStarters({ onPick, off = false }: { onPick: (text: string) => void; /** Something is typed: kept in its place, out of sight, so what is under it doesn't jump up (QA, 2026-10-28). */ off?: boolean }) {
  return (
    <div className={`work-starters${off ? " off" : ""}`} role="group" aria-label="Start from" aria-hidden={off || undefined} inert={off || undefined}>
      {WORK_STARTERS.map((s) => (
        <button key={s.label} type="button" className="work-starter" onClick={() => onPick(s.text)}>
          {s.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The teammate, started on a lane of its own in the folder the first tool was given (a new project folder when none was picked),
 * beside it rather than in a copy: the pieces are files they share.
 */
export async function startTeammate(identity: Identity, o: { sid: string; invite: string; tool: EngineTool; cwd: string; mode: EngineMode }): Promise<void> {
  await hostApi(identity, "/api/runner/start", {
    method: "POST",
    body: JSON.stringify({ sid: o.sid, invite: o.invite, tool: o.tool, cwd: o.cwd, mode: o.mode, handMode: o.mode, newLane: ENGINE_NAMES[o.tool], share: true }),
  });
}

/**
 * Something the new-session page had to say about a session it then opened (the second tool that didn't join), carried into the
 * session to be read there: said on the page, it was replaced by "Sending the task…" at once and gone with the page (Arun,
 * 2026-10-28: "iron everything and ensure we are good… focusing on UI and UX and any logic errors").
 */
const NOTE_KEY = (sid: string) => `friday.work.note.${sid}`;
export function leaveWorkNote(sid: string, text: string): void {
  try {
    sessionStorage.setItem(NOTE_KEY(sid), text);
  } catch {
    // Said on the page instead, for as long as it shows.
  }
  dispatchEvent(new Event("friday:work-note"));
}

/** The note left for this session, as a banner over its chat until it is read. */
export function WorkNote({ sid }: { sid: string }) {
  const read = () => {
    try {
      return sessionStorage.getItem(NOTE_KEY(sid)) ?? "";
    } catch {
      return "";
    }
  };
  const [note, setNote] = useState(read);
  useEffect(() => {
    const heard = () => setNote(read());
    addEventListener("friday:work-note", heard);
    return () => removeEventListener("friday:work-note", heard);
  }, [sid]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!note) return null;
  const done = () => {
    try {
      sessionStorage.removeItem(NOTE_KEY(sid));
    } catch {
      // Gone from here anyway.
    }
    setNote("");
  };
  return (
    <div className="banners">
      <div className="banner work-note" role="status">
        <Icon name="users" size={16} />
        <div className="banner-main">
          <strong>{note}</strong>
          <p className="muted small">The task went to the agent that did start. Bring the other in with + beside the agents at the top when it's ready.</p>
        </div>
        <button type="button" className="btn small" onClick={done}>
          Got it
        </button>
      </div>
    </div>
  );
}

/**
 * Work's new-session page, marked on the page (html.work-home, work.css) so it leaves out "Your year": Work isn't counted in coding
 * turns. It drew a bundle of drifting threads behind the page (2026-10-27); the page is now one flat ground, as Code's home is
 * (DIRECTION.md §9.5, §9.7; Arun, 2026-10-29: "so clean and beautiful really with a clear direction in design language").
 */
export function WorkField(): null {
  useLayoutEffect(() => {
    document.documentElement.classList.add("work-home");
    return () => document.documentElement.classList.remove("work-home");
  }, []);
  return null;
}
