import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons.js";
import { TeamTip } from "./TeamTip.js";
import { useDismiss } from "./ui.js";

/**
 * The open-source edition's button in the session's header, where the hosted Friday has People: this session's settings, and
 * the line about Friday Team for working on it with others (TeamTip).
 */
/**
 * `button: false`: no gear of its own, its place in the header taken by the terminal switch (Arun, 2026-10-30: "replace the
 * settings button in the header of the coding sessions with the terminal button"); opened from ⌘K's "Session settings".
 */
export function SessionMenu({ settings, button = true, children }: { settings?: ReactNode; button?: boolean; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    addEventListener("friday:session-settings", show);
    return () => removeEventListener("friday:session-settings", show);
  }, []);
  return (
    <div className="pop-anchor">
      {children}
      {button && (
        <button type="button" className={`icon-btn ${open ? "is-active" : ""}`} title="Session settings" aria-label="Session settings" onMouseDown={(e) => e.stopPropagation()} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <Icon name="settings" size={18} />
        </button>
      )}
      {open && <Panel settings={settings} onClose={() => setOpen(false)} />}
    </div>
  );
}

function Panel({ settings, onClose }: { settings?: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  // Held to the window: hung from the gear by its right edge, a narrow window cut off the start of every row ("ession
  // settings", 2026-10-28 QA at 420 wide; Arun: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
  useLayoutEffect(() => {
    const el = ref.current;
    const left = el?.getBoundingClientRect().left ?? 8;
    if (el && left < 8) el.style.right = `${left - 8}px`;
  }, []);
  return (
    <div className="popover people-pop" role="dialog" aria-label="Session settings" ref={ref}>
      <div className="pop-head">
        <span>Session settings</span>
        <button type="button" className="icon-btn tiny" onClick={onClose} aria-label="Close">
          <Icon name="x" size={14} />
        </button>
      </div>
      {settings ? <div className="pp-settings">{settings}</div> : <p className="muted small">Only this session's owner can change how it runs.</p>}
      <TeamTip className="in-pop" />
    </div>
  );
}
