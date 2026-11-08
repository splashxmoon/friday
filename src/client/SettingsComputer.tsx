import { Facts, SettingsGroup } from "@/components/dass";
import { GitHubConnect } from "./GitHubConnect.js";
import { MachineBadge } from "./MachineBadge.js";
import { pickedMachine, useMachine } from "./local.js";
import { KeepAwakeRow } from "./KeepAwake.js";
import { ComputerUseRow } from "./ComputerUse.js";
import { ComputersSettings } from "./Computers.js";
import { isLocal } from "./edition.js";
import type { Identity } from "./storage.js";

// ── This computer › Computer, and Coding tools ──────────────────────────
// One page until Arun asked for two (2026-11-04): the computer (where agents run, keeping it awake, your other computers, its
// GitHub login), and the coding tools on it (each one's sign-in, accounts and install, Other ACP agent).

/**
 * The coding tools on the computer Friday's agents run on: the same list the new-session page shows, here so somebody can sign
 * in to Codex or change account without starting a session to find it.
 */
export function CodingToolsSection({ identity }: { identity: Identity }) {
  const { state: machine, refresh } = useMachine(identity);
  return (
    <section className="flex flex-col gap-5">
      <div className="set-card set-computer">
        <MachineBadge identity={identity} machine={machine} refresh={refresh} inline part="tools" />
      </div>
      <Facts className="px-0.5" items={[{ term: "What runs here", detail: "Your own coding tools, under your own logins. Friday never sees their keys or meters them." }]} />
    </section>
  );
}

/**
 * The computer Friday's coding agents run on: this one (whether it is connected, keeping it awake), your other computers, and
 * GitHub, as titled groups of rows like every other Settings page (Arun, 2026-11-04: "design this better": a lone status strip,
 * three cards in three styles and a fact line on its own).
 */
export function ComputerSection({ identity, part = "this" }: { identity: Identity; /** Which tab (Arun, 2026-11-08: categories a user finds things by): this computer, your others, GitHub, or what agents may do here. */ part?: "this" | "others" | "github" | "permissions" }) {
  const { state: machine, refresh } = useMachine(identity);
  if (part === "others") return <section className="flex flex-col gap-5">{isLocal() && <ComputersSettings />}</section>;
  if (part === "github")
    return (
      <section className="flex flex-col gap-5">
        {machine.mode === "local" || machine.mode === "linked" ? (
          <SettingsGroup title="GitHub" className="set-gh">
            <GitHubConnect identity={identity} compact row />
          </SettingsGroup>
        ) : (
          <Facts className="px-0.5" items={[{ term: "GitHub", detail: "Connect this computer first: GitHub signs in through the computer your agents run on." }]} />
        )}
        <Facts className="px-0.5" items={[{ term: "What it's for", detail: "Cloning your repos, pushing branches, and opening and reading pull requests, in Code Review and from sessions." }]} />
      </section>
    );
  if (part === "permissions")
    return (
      <section className="flex flex-col gap-5">
        {machine.mode === "local" ? (
          <SettingsGroup title="On this computer">
            <ComputerUseRow identity={identity} flush />
          </SettingsGroup>
        ) : (
          <Facts className="px-0.5" items={[{ term: "On this computer", detail: "Open Friday on the computer agents run on to choose what they may do there." }]} />
        )}
        <Facts className="px-0.5" items={[{ term: "Always", detail: "Agents work in the folders you give them. What each session may do without asking is chosen in the box you start it from." }]} />
      </section>
    );
  return (
    <section className="flex flex-col gap-5">
      {/* Its name, system and how it stays connected, its state or the one thing to do; then keeping it awake (desktop app only). */}
      <SettingsGroup title="This computer">
        <MachineBadge identity={identity} machine={machine} refresh={refresh} inline part="computer" />
        <KeepAwakeRow row />
        {/* Computer use is under Agents › Permissions now: what agents may do, not what the computer is. */}
      </SettingsGroup>
      {/* Where new sessions start: this computer, or a machine of yours that stays on, so agents keep running when this one shuts. */}
      {/* No phone pairing on this computer's Friday: there is no open-source phone app yet (Arun, 2026-11-04: "WE DONT HAVE AN APP FOR
          OPEN SOURCE YET SO GET RID OF IT"). PhoneSettings.tsx stays for when there is. */}
      {/* Your other computers are their own tab (Computers › Other computers), and GitHub is under Connections. */}
      {!isLocal() && <Facts className="px-0.5" items={[{ term: "Friday's agent", detail: "Works in folders this computer lends it, with the files, terminal and preview shown in the session." }]} />}
    </section>
  );
}
