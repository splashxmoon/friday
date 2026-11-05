import { useEffect, useState } from "react";
import { SettingsRow } from "@/components/dass";
import { Switch as Toggle } from "@/components/ui/switch";
import { isLocal } from "./edition.js";
import { Switch } from "./ui.js";

/**
 * Keeping this computer awake while an agent runs on it (the desktop app, from 0.1.50). Idle sleep only: closing the lid
 * still sleeps it, which is what an always-on machine is for. `row`: one row of Settings › Computer's "This computer" group,
 * not a card of its own (Arun, 2026-11-04: "design this better").
 */
export function KeepAwakeRow({ row = false }: { row?: boolean }) {
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
  const set = (on: boolean) => void desk.setKeepAwake?.(on).then(() => setState((s) => (s ? { ...s, on } : s)));
  if (row)
    return (
      // Its words under the computer's name in the row above, past that row's mark.
      <SettingsRow
        className="pl-11"
        label="Keep awake while agents run"
        hint={`${state.on && state.running ? "An agent is running, so it won't sleep when idle." : "It won't sleep when idle while an agent runs here."} ${isLocal() ? "Closing the lid still sleeps it." : "Closing the lid still does: for that, add an always-on machine."}`}
      >
        <Toggle aria-label="Keep this computer awake while agents run" checked={state.on} onCheckedChange={set} />
      </SettingsRow>
    );
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
        <Switch on={state.on} label="Keep this computer awake while agents run" onChange={set} />
      </div>
    </div>
  );
}
