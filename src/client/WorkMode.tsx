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

const KEY = "friday.newSession.work";

const readMode = () => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};

/**
 * Code or Work, remembered on this computer: whichever was used last is where the page opens. One setting for the sidebar's
 * switch and the new-session page's, so flipping either flips both.
 */
export function useWorkMode(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(readMode);
  useEffect(() => {
    const heard = () => setOn(readMode());
    // Another window of Friday flipping it too: its own event never reaches this one, and the sidebar here and a new session's
    // page disagreed on Code or Work (Arun, 2026-10-28: "iron everything and ensure we are good… any logic errors and fixes").
    const stored = (e: StorageEvent) => e.key === KEY && heard();
    addEventListener("friday:work-mode", heard);
    addEventListener("storage", stored);
    return () => (removeEventListener("friday:work-mode", heard), removeEventListener("storage", stored));
  }, []);
  return [
    on,
    (v: boolean) => {
      setOn(v);
      try {
        localStorage.setItem(KEY, v ? "1" : "0");
      } catch {
        // A preference: losing it costs nothing.
      }
      dispatchEvent(new Event("friday:work-mode"));
    },
  ];
}

/** Code, Work or Crew, from anywhere (⌘K's "Switch to…"): as the sidebar's switch picks it. */
export function choosePlace(p: "code" | "work" | "team"): void {
  if (p !== "team" && readTabNow() && leaving(() => choosePlace(p))) return;
  if (p === "team") return setTeamTab(true);
  setTeamTab(false);
  try {
    localStorage.setItem(KEY, p === "work" ? "1" : "0");
  } catch {
    // A preference: losing it costs nothing.
  }
  dispatchEvent(new Event("friday:work-mode"));
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
 * The sidebar's place follows the session that is open: a Team room opened from a notification turns the sidebar to Team, a Work
 * session to Work, a coding one to Code (2026-10-27 audit: the rail and the tabs said Code while a Team room was open). Only when
 * the open session changes, so turning to another tab while one is open is left alone.
 */
export function usePlaceFollows(activeSid: string | null): void {
  const [team, setTeam] = useTeamTab();
  const [work, setWork] = useWorkMode();
  const sids = useWorkSids();
  const teamKnown = useTeamKnown();
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!activeSid) return void (last.current = null);
    // Not before the team is known: a Team room read as a coding session until then, and turned the sidebar away from Team. Nor
    // before the Work sessions are: a Work session opened from a link read as a coding one, turned the sidebar to Code, and
    // usePlaceLeaves then took the page home from the session just opened (2026-10-28).
    if (!teamKnown || !listed) return;
    const place = isTeamSid(activeSid) ? "team" : sids.has(activeSid) ? "work" : "code";
    const key = `${activeSid}:${place}`;
    if (last.current === key) return;
    last.current = key;
    if (place === "team") return void (team || setTeam(true));
    if (team) setTeam(false);
    if (work !== (place === "work")) setWork(place === "work");
  }, [activeSid, sids.size, teamKnown, listed]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * The other way round: Code, Work or Crew picked in the sidebar while a session of another place is open goes to the new
 * place's home, rather than leaving that session (the Crew room, a Code chat) on screen under a list it isn't in (Arun,
 * 2026-10-28: "iron everything and ensure we are good… any logic errors and fixes"). Only once the places are known.
 */
export function usePlaceLeaves(activeSid: string | null, home: () => void): void {
  const [team] = useTeamTab();
  const [work] = useWorkMode();
  const sids = useWorkSids();
  const teamKnown = useTeamKnown();
  const place = team ? "team" : work ? "work" : "code";
  const was = useRef(place);
  useEffect(() => {
    if (was.current === place) return;
    was.current = place;
    if (!activeSid || !teamKnown || !listed) return;
    const its = isTeamSid(activeSid) ? "team" : sids.has(activeSid) ? "work" : "code";
    if (its !== place) home();
  }, [place]); // eslint-disable-line react-hooks/exhaustive-deps
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

/** Which of Code, Work and Team has an agent at work, or one waiting on the person, from the sessions the sidebar watches. */
export function placesBusy(working: Iterable<string>, needs: Iterable<string>): Record<"code" | "work" | "team", "needs" | "working" | null> {
  const out: Record<"code" | "work" | "team", "needs" | "working" | null> = { code: null, work: null, team: null };
  const place = (sid: string) => (isTeamSid(sid) ? "team" : workSids.has(sid) ? "work" : "code");
  for (const sid of working) out[place(sid)] ??= "working";
  for (const sid of needs) out[place(sid)] = "needs";
  return out;
}

/**
 * In the sidebar, under search: which kind of sessions it lists and a new one is, or the Team: his AI teammates (Teammates.tsx).
 * A place you're not looking at shows a small dot when an agent there is at work, amber when one waits on you (Arun, 2026-10-27:
 * "add like a subtle hint if there is working going on in these platforms").
 */
export function SidebarWorkSwitch({ working = [], needs = [] }: { working?: Iterable<string>; needs?: Iterable<string> }) {
  const [on, setOn] = useWorkMode();
  const [team, setTeam] = useTeamTab();
  // Leaving the Crew with unsaved work on screen (a workflow's builder) asks first (leave-guard.ts).
  const pick = (work: boolean) => void (!(team && leaving(() => pick(work))) && (setTeam(false), setOn(work)));
  const busy = placesBusy(working, needs);
  const here = team ? "team" : on ? "work" : "code";
  const hint = (p: "code" | "work" | "team") =>
    // Only what waits on you marks a place, in amber; working shows on the faces and marks themselves (2026-10-29 direction §8).
    p !== here && busy[p] === "needs" ? <span className="sb-work-hint" data-state="needs" aria-label="Waiting on you" /> : null;
  // A tab list's keys: the arrows move between the three and pick, Home and End go to either end, only the picked one is a Tab
  // stop, and focus stays on the list while the place picked opens, rather than going to its message box (roving.ts).
  return (
    <div className="work-seg sb-work sb-work-3" role="tablist" aria-label="Code, Work or Crew" onKeyDown={tabListKeys}>
      <button type="button" role="tab" tabIndex={here === "code" ? 0 : -1} aria-selected={!team && !on} className={!team && !on ? "on" : ""} onClick={() => pick(false)} title="Code: you and a coding tool, on one change. You see every step and every diff.">
        <Icon name="code" size={14} />
        Code
        {hint("code")}
      </button>
      <button type="button" role="tab" tabIndex={here === "work" ? 0 : -1} aria-selected={!team && on} className={!team && on ? "on" : ""} onClick={() => pick(true)} title="Work: you and a coding tool, on posts, scripts, research, images and video.">
        <Icon name="pencil" size={14} />
        Work
        {hint("work")}
      </button>
      <button type="button" role="tab" tabIndex={here === "team" ? 0 : -1} aria-selected={team} className={team ? "on" : ""} onClick={() => setTeam(true)} title="Crew: teammates who keep their role and memory, and work on your goals while you're away.">
        <Icon name="users" size={14} />
        Crew
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
