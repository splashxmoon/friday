import { useState } from "react";
import { startTeam } from "./edition.js";
import { Icon } from "./icons.js";

/**
 * The open-source edition's one word about the hosted Friday: everything here runs on this computer, and working in the same
 * session with teammates is Friday Team. A line, not a banner, and gone for good once dismissed (kept on this computer).
 */
const KEY = "friday.local.teamTip";

const dismissed = () => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};

export function TeamTip({ className = "" }: { className?: string }) {
  const [gone, setGone] = useState(dismissed);
  if (gone) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      // Not remembered: gone until the page loads again.
    }
    setGone(true);
  };
  return (
    <p className={`team-tip ${className}`}>
      {/* The whole line is the link (Arun, 2026-10-26: "make this entire thing clickable"), to Friday Team's page. */}
      <button type="button" className="team-tip-go" onClick={() => startTeam()}>
        <Icon name="users" size={13} />
        <span>
          Working with other people in the same session is <b>Friday Team</b>.
        </span>
      </button>
      <button type="button" className="icon-btn tiny team-tip-x" aria-label="Dismiss" title="Don't show this again" onClick={dismiss}>
        <Icon name="x" size={12} />
      </button>
    </p>
  );
}
