import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isLocal } from "./edition.js";
import { Icon } from "./icons.js";
import { openOutside } from "./openOutside.js";
import { BlobFace } from "./teammate-face.js";
import { useTeamNow } from "./Teammates.js";
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

// "shown", not the first key ("seen"): that one was also set, unseen, for anyone Friday took for new, which counted only Code
// sessions and so took someone in the Crew for new (Arun, 2026-11-04: "release notes didnt appear immesditaley after restarting",
// "it should appear in code and crew btw regardless").
const SEEN = "friday.whatsNew.shown";
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
/** Someone new, as the welcome opens for them (Setup.tsx): what's new is everything to them, so these notes aren't. */
export const markWhatsNewSeen = markSeen;

// The version that ran here last, read once as the page loads (before this start writes its own over it).
const LAST = "friday.lastVersion";
let lastAtStart: string | null | undefined;
const lastVersion = () => {
  if (lastAtStart !== undefined) return lastAtStart;
  try {
    lastAtStart = localStorage.getItem(LAST);
  } catch {
    lastAtStart = null;
  }
  return lastAtStart;
};
const noteVersion = (v: string) => {
  try {
    localStorage.setItem(LAST, v);
  } catch {}
};
// Past the welcome before: it keeps that per person (Setup.tsx).
const knew = (userId: string) => {
  try {
    return !!localStorage.getItem(`mpa.setup.${userId}`);
  } catch {
    return false;
  }
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

export function WhatsNew({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  // Looked at once the welcome has decided (it waits for the crew, or four seconds): it opens 600ms after, this a while later.
  const t = useTeamNow();
  const [late, setLate] = useState(false);
  useEffect(() => void setTimeout(() => setLate(true), 4000), []);
  const known = !!t || late;
  const [running, setRunning] = useState("");
  useEffect(() => {
    if (!isLocal()) return;
    const last = lastVersion();
    void fetch("/api/version", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { version?: string } | null) => {
        const v = b?.version ?? "";
        if (!v) return;
        // Asked of this start's own: the last version is read before this one is written.
        setRunning(whatsNewDue({ notes: WHATS_NEW.version, running: v, last, shown: seen(), knew: knew(userId) }) ? v : "");
        noteVersion(v);
      })
      .catch(() => {});
  }, [userId]);
  useEffect(() => {
    if (!known || !running) return;
    // A moment after the window has drawn, in Code or the Crew alike. Someone new is shown the welcome instead, which marks these
    // notes as seen as it opens; one who already knows Friday and finds the welcome up (no coding tool ready yet) is shown them
    // once it's gone.
    let left = 120;
    const look = () => {
      if (seen() === WHATS_NEW.version) return;
      if (!document.querySelector(".setup-overlay")) return setOpen(true);
      if (--left > 0) id = setTimeout(look, 1000);
    };
    let id = setTimeout(look, 1400);
    return () => clearTimeout(id);
  }, [known, running]);
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
