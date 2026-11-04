import { useState } from "react";
import { Icon } from "./icons.js";
import type { RecentSession } from "./storage.js";
import { isTeamSid, newTeammate, setTeamTab, useTeamNow } from "./Teammates.js";
import "./getting-started.css";

/**
 * Getting started, on the open-source home (Arun, 2026-11-01: "enhance the UX for first users loading up and running the app…
 * so they can retain and be continuously using this product"): the four things that show what Friday is for, each ticked when it
 * has happened, each one press from doing. A first task; one in their own project, not a folder Friday made; their agents working
 * as a team; a teammate who stays. Gone once all four are done, or when hidden.
 */

const HIDDEN = "friday.gs.hidden";
/** A session was started in a folder the person picked (Code.tsx marks it), not one Friday made. */
export const OWN_FOLDER = "friday.gs.ownFolder";

const read = (k: string) => {
  try {
    return localStorage.getItem(k) === "1";
  } catch {
    return false;
  }
};
const mark = (k: string) => {
  try {
    localStorage.setItem(k, "1");
  } catch {
    // A tick: losing it shows the step again, nothing more.
  }
};
/** Noted when a session starts in a folder the person chose. */
export const markOwnFolder = () => mark(OWN_FOLDER);

const focusBox = () => document.querySelector<HTMLTextAreaElement>(".composer-card textarea")?.focus();

export function GettingStarted({ recents, onPickFolder }: { recents: RecentSession[]; /** Opens the box's folder picker. */ onPickFolder: () => void }) {
  const t = useTeamNow();
  const [hidden, setHidden] = useState(() => read(HIDDEN));
  const own = recents.filter((r) => !isTeamSid(r.sid));
  const steps = [
    { id: "task", title: "Give an agent its first task", body: "Describe a change in the box above. It works in a folder of its own until you pick one.", done: own.length > 0, act: "Write it", run: focusBox },
    { id: "folder", title: "Point it at your own project", body: "Pick a folder or repo, and the agent works on your real code, on a branch of its own.", done: read(OWN_FOLDER), act: "Pick a folder", run: onPickFolder },
    { id: "mate", title: "Add a teammate who stays", body: "A name, a role and a coding tool: it keeps its memory and works through its queue while you're away.", done: !!t?.teammates.length, act: "Add", run: () => (setTeamTab(true), setTimeout(newTeammate, 50)) },
  ];
  const done = steps.filter((s) => s.done).length;
  if (hidden || done === steps.length) return null;
  const next = steps.find((s) => !s.done)!;
  return (
    <section className="gs-card" aria-label="Get started">
      <div className="gs-head">
        <h2>Get started</h2>
        <span className="gs-count">
          {done} of {steps.length}
        </span>
        <span className="gs-bar" aria-hidden="true">
          <i style={{ width: `${(done / steps.length) * 100}%` }} />
        </span>
        <button type="button" className="gs-hide" onClick={() => (mark(HIDDEN), setHidden(true))}>
          Hide
        </button>
      </div>
      <ol className="gs-list">
        {steps.map((s, i) => (
          <li key={s.id} className="gs-step" data-done={s.done ? "true" : undefined} data-next={s === next ? "true" : undefined}>
            <span className="gs-tick" aria-hidden="true">
              {s.done ? <Icon name="check" size={12} /> : i + 1}
            </span>
            <span className="gs-text">
              <span className="gs-title">{s.title}</span>
              {!s.done && <span className="gs-body">{s.body}</span>}
            </span>
            {!s.done && (
              <button type="button" className={s === next ? "gs-go primary" : "gs-go"} onClick={s.run}>
                {s.act}
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
