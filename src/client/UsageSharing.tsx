import { useEffect, useState, useSyncExternalStore } from "react";
import { Icon } from "./icons.js";
import { openOutside } from "./openOutside.js";
import { isLocal } from "./edition.js";
import { Note, SettingsGroup, SettingsRow as Row } from "@/components/dass";
import { Switch } from "@/components/ui/switch";

/**
 * The open-source edition's anonymous usage counts, as the person sees them (../usage.ts says what is sent and what never is):
 * a notice the first time Friday opens after they arrived, in the sidebar's foot, saying so and offering the switch; and the
 * switch itself in Settings › Data & backup. Nothing is counted until the notice has been shown.
 */
type State = { on: boolean; told: boolean; offBy: string | null };

/** Where the README says exactly what is sent. */
const WHAT = "https://github.com/splashxmoon/friday#privacy";

let now: State | null = null;
const subs = new Set<() => void>();
const tell = () => subs.forEach((f) => f());
let asked = false;
function load() {
  // The hosted edition has its own analytics, by account (SettingsPrefs ShareAnalytics), and no such address.
  if (asked || !isLocal()) return;
  asked = true;
  fetch("/api/usage-sharing", { credentials: "same-origin" })
    .then((r) => (r.ok ? (r.json() as Promise<State>) : null))
    .then((s) => s && ((now = s), tell()))
    .catch(() => {});
}
async function save(p: { on?: boolean; told?: true }): Promise<boolean> {
  const was = now;
  if (now) (now = { ...now, ...p }), tell();
  const r = await fetch("/api/usage-sharing", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) }).catch(() => null);
  if (!r?.ok) return (now = was), tell(), false;
  now = (await r.json()) as State;
  tell();
  return true;
}

export function useUsageSharing(): State | null {
  useEffect(load, []);
  return useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => now,
  );
}

/** Whether the notice is up: shown once, unless sharing was already turned off from outside (DO_NOT_TRACK and the like). */
export const noticeDue = (s: State | null) => !!s && !s.told && !s.offBy;

export function UsageNotice() {
  const s = useUsageSharing();
  if (!noticeDue(s)) return null;
  return (
    <div className="usage-notice" role="status">
      <p>
        <b>Anonymous usage counts</b>
        Friday counts how often it's opened, the sessions started and which coding tools it finds, so we can see what to fix.
        Never your code, prompts, files or accounts.{" "}
        <button type="button" className="usage-notice-link" onClick={() => void openOutside(WHAT)}>
          What's sent
        </button>
      </p>
      <div className="usage-notice-actions">
        <button type="button" className="usage-notice-off" onClick={() => void save({ on: false, told: true })}>
          Turn off
        </button>
        <button type="button" className="usage-notice-ok" onClick={() => void save({ told: true })}>
          OK
        </button>
      </div>
    </div>
  );
}

/** Settings › Data & backup: the switch, and why it may be off from outside. */
export function UsageSharingSetting() {
  const s = useUsageSharing();
  const [error, setError] = useState("");
  return (
    <>
      <SettingsGroup title="Privacy">
        <Row
          label="Share anonymous usage"
          hint={
            s?.offBy
              ? `Off: ${s.offBy} is set where Friday runs.`
              : "How often Friday is opened, sessions started, and which coding tools it finds, with a random id for this install. Never your code, prompts, files, paths or accounts."
          }
        >
          <button type="button" className="usage-what" onClick={() => void openOutside(WHAT)}>
            What's sent <Icon name="external" size={12} />
          </button>
          <Switch
            aria-label="Share anonymous usage"
            checked={!!s && s.on && !s.offBy}
            disabled={!s || !!s.offBy}
            onCheckedChange={(on) => {
              setError("");
              void save({ on, told: true }).then((ok) => ok || setError("Couldn't save that. Try again."));
            }}
          />
        </Row>
      </SettingsGroup>
      <Note ok={false}>{error}</Note>
    </>
  );
}
