import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons.js";
import { TeamTip } from "./TeamTip.js";
import { useDismiss } from "./ui.js";

/**
 * The open-source edition's button in the session's header, where the hosted Friday has People: this session's settings, and
 * the line about Friday Team for working on it with others (TeamTip).
 */
export function SessionMenu({ settings }: { settings?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pop-anchor">
      <button type="button" className={`icon-btn ${open ? "is-active" : ""}`} title="Session settings" aria-label="Session settings" onMouseDown={(e) => e.stopPropagation()} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Icon name="settings" size={18} />
      </button>
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
