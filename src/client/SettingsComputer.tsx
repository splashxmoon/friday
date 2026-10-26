import { Facts } from "@/components/dass";
import { GitHubConnect } from "./GitHubConnect.js";
import { MachineBadge } from "./MachineBadge.js";
import { pickedMachine, useMachine } from "./local.js";
import { KeepAwakeRow } from "./KeepAwake.js";
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
      {/* GitHub belongs to the computer too: the login its clones, pushes and pull requests use. */}
      {(machine.mode === "local" || machine.mode === "linked") && (
        <div className="set-card set-github">
          <GitHubConnect identity={identity} compact />
        </div>
      )}
      <Facts
        className="px-0.5"
        items={[
          { term: "What runs here", detail: "Your own Claude Code, Codex and Cursor, under your own logins. Friday never sees their keys or meters them." },
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
