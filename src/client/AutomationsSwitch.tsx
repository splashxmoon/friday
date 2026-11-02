import { useLayoutEffect, useRef } from "react";
import { Icon } from "./icons.js";
import { tabListKeys } from "./roving.js";
import type { AutomationsView } from "./team-workflow-view.js";

/** Set as the switch is pressed: the other page draws its own switch, and the focus goes onto it rather than to the page body. */
let handing = false;

const LINE: Record<AutomationsView, string> = {
  coding: "Your coding tools on a schedule, a webhook or another agent finishing. Each run is a session of its own.",
  workflows: "Your teammates, in steps that hand on to each other. Each run is a board in a Crew room.",
};

/**
 * Which automations the page shows, said on the page with the way across (Arun, 2026-11-02: "fix this logic and design it nicely
 * for switching"). The sidebar's Automations led to the coding tools' or the crew's depending on whether the Crew tab was the last
 * one picked, with nothing on the page saying which, and a button at the far end as the only way to the other.
 */
export function AutomationsSwitch({ view, onView }: { view: AutomationsView; onView: (v: AutomationsView) => void }) {
  const picked = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (handing) picked.current?.focus({ preventScroll: true });
    handing = false;
  }, []);
  const tab = (v: AutomationsView, icon: "code" | "users", label: string) => (
    <button type="button" role="tab" ref={view === v ? picked : undefined} aria-selected={view === v} tabIndex={view === v ? 0 : -1} className={view === v ? "on" : ""} onClick={() => view !== v && ((handing = true), onView(v))}>
      <Icon name={icon} size={14} />
      {label}
    </button>
  );
  return (
    <div className="auto-switch">
      <div className="segmented auto-seg" role="tablist" aria-label="Which automations" onKeyDown={tabListKeys}>
        {tab("coding", "code", "Coding tools")}
        {tab("workflows", "users", "Crew workflows")}
      </div>
      <p className="auto-switch-line">{LINE[view]}</p>
    </div>
  );
}
