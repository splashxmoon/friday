import { useEffect, useState } from "react";
import { isLocal } from "./edition.js";
import { Switch } from "./ui.js";

/**
 * Keeping this computer awake while an agent runs on it (the desktop app, from 0.1.50). Idle sleep only: closing the lid
 * still sleeps it, which is what an always-on machine is for.
 */
export function KeepAwakeRow() {
  const desk = typeof window !== "undefined" ? window.fridayDesktop : undefined;
  const [state, setState] = useState<{ on: boolean; running: boolean } | null>(null);
  useEffect(() => {
    if (!desk?.keepAwake) return;
    let live = true;
    const read = () => void desk.keepAwake!().then((s) => live && setState(s), () => {});
    read();
    const t = setInterval(read, 5_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [desk]);
  if (!desk?.keepAwake || !state) return null;
  return (
    <div className="set-card">
      <div className="set-row">
        <div className="set-text">
          <div className="set-label">Keep this computer awake while agents run</div>
          <div className="muted small">
            {state.on && state.running ? "An agent is running, so this computer won't sleep when idle. " : "It won't go to sleep when idle while an agent is running here. "}
            {isLocal() ? "Closing the lid still sleeps it." : "Closing the lid still sleeps it: for that, add an always-on machine."}
          </div>
        </div>
        <Switch on={state.on} label="Keep this computer awake while agents run" onChange={(on) => void desk.setKeepAwake?.(on).then(() => setState((s) => (s ? { ...s, on } : s)))} />
      </div>
    </div>
  );
}
