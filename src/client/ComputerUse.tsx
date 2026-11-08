import { useEffect, useState } from "react";
import { SettingsRow } from "@/components/dass";
import { Switch as Toggle } from "@/components/ui/switch";
import type { ComputerStatus } from "../runner/computer.js";
import { hostApi } from "./local.js";
import type { Identity } from "./storage.js";

/**
 * Computer use on this computer (src/runner/computer.ts; Arun, 2026-11-05: "allowing computer use for the agents and crew too …
 * mac, windows and linux"): one row of Settings › Computer's "This computer" group, off until turned on. Under it, while on, what
 * the system still needs (macOS's Screen Recording and Accessibility, Linux's xdotool), with the one press that asks for it.
 */
export function ComputerUseRow({ identity, flush = false }: { identity: Identity; /** Its own group (Settings › Permissions), not under This computer's row: no indent. */ flush?: boolean }) {
  const [s, setS] = useState<ComputerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ask = (method: string, body?: Record<string, unknown>) =>
    hostApi<ComputerStatus>(identity, `/api/runner/${method}`, body ? { method: "POST", body: JSON.stringify(body) } : {}).then(setS, (e: Error) => setErr(e.message));
  useEffect(() => {
    void ask("computerUse");
    // Looked at again while something is still to allow: a permission given in System Settings shows here by itself.
    const t = setInterval(() => void hostApi<ComputerStatus>(identity, "/api/runner/computerUse").then(setS, () => {}), 4000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return null;
  const set = async (on: boolean) => {
    setBusy(true);
    setErr("");
    await ask("computerUse.set", { on });
    // Turned on: the system's own prompts straight away, rather than at an agent's first try.
    if (on) await ask("computerUse.allow", {});
    setBusy(false);
  };
  return (
    <SettingsRow
      className={flush ? undefined : "pl-11"}
      label="Let agents use this computer"
      hint={
        <>
          {s.on
            ? "They can see the screen and use the mouse and keyboard, for apps nothing else reaches. Each session asks you first, and a bar shows while one does, with Stop."
            : `Agents and your crew see the screen and use the mouse and keyboard on ${s.os}, when you allow it in the session. Only your own agents, never a teammate's.`}
          {s.on && s.needs.length > 0 && (
            <span className="cu-needs">
              {s.needs.map((n) => (
                <span key={n} className="cu-need">
                  {n}
                </span>
              ))}
              {s.canAllow && (
                <button type="button" className="link-btn" disabled={busy} onClick={() => void ask("computerUse.allow", {})}>
                  Allow…
                </button>
              )}
            </span>
          )}
          {err && <span className="cu-need error">{err}</span>}
        </>
      }
    >
      <Toggle aria-label="Let agents use this computer" checked={s.on} disabled={busy} onCheckedChange={(on) => void set(on)} />
    </SettingsRow>
  );
}
