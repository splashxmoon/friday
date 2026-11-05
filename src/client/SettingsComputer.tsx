import { Facts } from "@/components/dass";
import { GitHubConnect } from "./GitHubConnect.js";
import { MachineBadge } from "./MachineBadge.js";
import { pickedMachine, useMachine } from "./local.js";
import { KeepAwakeRow } from "./KeepAwake.js";
import { ComputersSettings } from "./Computers.js";
import { isLocal } from "./edition.js";
import type { Identity } from "./storage.js";

// ── This computer › Computer & coding tools ──────────────────────────

/**
 * The computer Friday's coding agents run on, and the coding tools on it: the same panel the new-session page shows, here
 * so somebody can sign in to Codex or change account without starting a session to find it.
 */
export function ComputerSection({ identity }: { identity: Identity }) {
  const { state: machine, refresh } = useMachine(identity);
  const desktop = typeof window !== "undefined" && !!window.fridayDesktop;
  return (
    <section className="flex flex-col gap-5">
      <div className="set-card set-computer">
        <MachineBadge identity={identity} machine={machine} refresh={refresh} inline />
      </div>
      {/* Where new sessions start: this computer, or a machine of yours that stays on, so agents keep running when this one shuts. */}
      <KeepAwakeRow />
      {/* No phone pairing on this computer's Friday: there is no open-source phone app yet (Arun, 2026-11-04: "WE DONT HAVE AN APP FOR
          OPEN SOURCE YET SO GET RID OF IT"). PhoneSettings.tsx stays for when there is. */}
      {/* Your other computers, linked to this one's Friday, and this one used from another's (Computers.tsx). */}
      {isLocal() && <ComputersSettings />}
      {/* GitHub belongs to the computer too: the login its clones, pushes and pull requests use. */}
      {(machine.mode === "local" || machine.mode === "linked") && (
        <div className="set-card set-github">
          <GitHubConnect identity={identity} compact />
        </div>
      )}
      <Facts
        className="px-0.5"
        items={[
          { term: "What runs here", detail: "Your own coding tools, under your own logins. Friday never sees their keys or meters them." },
          ...(isLocal() ? [] : [{ term: "Friday's agent", detail: "Works in folders this computer lends it, with the files, terminal and preview shown in the session." }]),
          {
            term: desktop ? "This app" : "In a browser",
            detail: desktop
              ? "Connects this computer by itself when it starts."
              : machine.mode === "local"
                ? "Reaches the runner on this computer directly. The desktop app does the same and keeps it connected for you."
                : "Connect this computer with one command in a terminal (Connect this computer, above), or open Friday in the desktop app, which connects it by itself.",
          },
        ]}
      />
    </section>
  );
}
