import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isLocal } from "./edition.js";
import { Icon } from "./icons.js";
import { openOutside } from "./openOutside.js";
import type { RecentSession } from "./storage.js";
import { BlobFace } from "./teammate-face.js";
import { isTeamSid, useTeamNow } from "./Teammates.js";
import { WHATS_NEW, notesUrl, whatsNewDue } from "./whats-new.js";
import "./whats-new.css";

/**
 * What's new, once after an update (Arun, 2026-11-03: "Can we add a what's new card pop up after the user updates their app as
 * well", then of three designs the centred sheet: "I like this one"). The crew's own faces across the top, the version, one
 * sentence, the release's four changes worth stopping for (whats-new.ts), and the full notes a press away. Shown once for each
 * release's notes, to someone who used Friday before it: a fresh install has the welcome (Setup.tsx), and is marked as having
 * seen these. Back from Settings · About any time. The open-source edition's, whose updates are releases; the hosted page changes
 * under people with every deploy, which no one release note covers.
 */

const SEEN = "friday.whatsNew.seen";
const seen = () => {
  try {
    return localStorage.getItem(SEEN);
  } catch {
    return WHATS_NEW.version;
  }
};
const markSeen = () => {
  try {
    localStorage.setItem(SEEN, WHATS_NEW.version);
  } catch {}
};

// Across the top, the tallest in the middle: the lead there, the rest either side of it, lower as they go out.
const SPOTS = [
  { size: 64, y: -14 },
  { size: 52, y: -6 },
  { size: 54, y: -4 },
  { size: 46, y: 10 },
  { size: 44, y: 12 },
];
// Left to right: the 4th, 2nd, 1st (the lead), 3rd, 5th.
const ORDER = [3, 1, 0, 2, 4];
// With no crew of five yet, Friday's own.
const MASCOTS = ["v2:Nova-0", "v2:Ivy-7", "v2:Mira-l", "v2:Rex-e", "v2:Sol-s"];

function useFaces(): string[] {
  const t = useTeamNow();
  const mates = (t?.teammates ?? []).slice();
  const lead = mates.findIndex((m) => m.lane === t?.lead);
  if (lead > 0) mates.unshift(...mates.splice(lead, 1));
  const own = mates.slice(0, 5).map((m) => m.look ?? m.name);
  return [...own, ...MASCOTS.filter((s) => !own.includes(s))].slice(0, 5);
}

/** The crew's faces across the top of a sheet: this one, and the welcome's (Setup.tsx). */
export function CrewFaces() {
  const faces = useFaces();
  return (
    <div className="wn-faces">
      {ORDER.map((i) => (
        <span key={i} style={{ transform: `translateY(${SPOTS[i]!.y}px)` }}>
          <BlobFace seed={faces[i]!} size={SPOTS[i]!.size} />
        </span>
      ))}
    </div>
  );
}

export function WhatsNew({ recents }: { recents: RecentSession[] }) {
  const [open, setOpen] = useState(false);
  const t = useTeamNow();
  // Which sessions are the Crew's is known once the crew is, as for the welcome (Setup.tsx): until then, nothing is decided.
  const [late, setLate] = useState(false);
  useEffect(() => void setTimeout(() => setLate(true), 4000), []);
  const known = !!t || late;
  const returning = recents.some((r) => !isTeamSid(r.sid));
  useEffect(() => {
    if (!isLocal() || !known) return;
    if (!returning) return void markSeen();
    if (!whatsNewDue(WHATS_NEW.version, seen(), returning)) return;
    // After the window has drawn, and never over the welcome.
    const id = setTimeout(() => !document.querySelector(".setup-overlay") && setOpen(true), 900);
    return () => clearTimeout(id);
  }, [known, returning]);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener("friday:whats-new", on);
    return () => window.removeEventListener("friday:whats-new", on);
  }, []);
  if (!open) return null;
  return <Sheet onClose={() => (markSeen(), setOpen(false))} />;
}

function Sheet({ onClose }: { onClose: () => void }) {
  const got = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    got.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const { version, summary, items } = WHATS_NEW;
  return createPortal(
    <div className="overlay wn-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="wn" role="dialog" aria-modal="true" aria-labelledby="wn-title">
        <div className="wn-hero" aria-hidden="true">
          <CrewFaces />
        </div>
        <span className="wn-ver">{version}</span>
        <button type="button" className="wn-x" aria-label="Close" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
        <div className="wn-body">
          <h2 id="wn-title">What's new in Friday</h2>
          <p className="wn-sub">{summary}</p>
          <ul className="wn-grid">
            {items.slice(0, 4).map((it) => (
              <li key={it.title}>
                <span className="wn-tile" aria-hidden="true">
                  <Icon name={it.icon} size={15} />
                </span>
                <span className="wn-item">
                  <b>{it.title}</b>
                  <span>{it.line}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <footer className="wn-foot">
          <button type="button" className="wn-notes" onClick={() => openOutside(notesUrl(version))}>
            Read the full notes
            <Icon name="arrowUpRight" size={13} />
          </button>
          <button ref={got} type="button" className="btn small primary wn-got" onClick={onClose}>
            Got it
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
