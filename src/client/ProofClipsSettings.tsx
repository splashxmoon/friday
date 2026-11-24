/**
 * Proof clips in Settings › Coding tools (proof-clips.ts; Arun, 2026-11-21: "i want this proof clips to be very advanced.... and can be
 * toggled on or off"): the switch, and when it is on, the two things that make a clip take longer, each said plainly.
 */
import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Choice, SettingsGroup, SettingsRow as Row } from "@/components/dass";
import { PROOF_CLIPS_DEFAULT, setProofClips, useProofClips, type ProofClips } from "./proof-clips.js";
import type { Identity } from "./storage.js";

export function ProofClipsSettings({ identity }: { identity: Identity }) {
  const p = useProofClips(identity) ?? PROOF_CLIPS_DEFAULT;
  const [err, setErr] = useState("");
  const put = (change: Partial<ProofClips>) => {
    setErr("");
    void setProofClips(identity, change).catch((e: Error) => setErr(e.message || "That didn't save."));
  };
  return (
    <SettingsGroup title="Proof clips">
      <Row
        label="Record proof clips"
        hint={
          p.on
            ? "After a change to a page, a few seconds of the app: Friday goes to what changed, points it out and clicks it, and says what was changed, so you see it work before you read the code. Each session can have its own setting, in its menu."
            : "Off. The preview check still takes its pictures; nothing is recorded."
        }
      >
        <Switch aria-label="Record proof clips" checked={p.on} onCheckedChange={(on) => put({ on })} />
      </Row>
      {p.on && (
        <>
          {/* When (Arun, 2026-11-22: "an option where the user can either click to see the proof after the task was done… lets be
              customizable"). Recording uses no coding tool's usage, only this computer: a dev server and a few seconds of a browser. */}
          <Row
            label="When"
            hint={
              p.auto
                ? "Pre-approved: after work nobody was watching, the tests it ran show in the chat and a clip is recorded, at most once every ten minutes in a session; a team's once its whole board is done, sent by its lead. Recording uses this computer, not your coding tools' usage."
                : "Finished work offers Test it, as Devin does: press it to see the tests it ran (or the project's own) and a clip of the page it changed. Work queued for later still comes with its clip."
            }
          >
            <Choice<"auto" | "ask">
              label="When to test"
              value={p.auto ? "auto" : "ask"}
              onChange={(v) => put({ auto: v === "auto" })}
              options={[
                ["ask", "When I ask"],
                ["auto", "Pre-approved"],
              ]}
            />
          </Row>
          <Row label="Before and after" hint="Also records the page as it was before the change, from a copy of the code, side by side with the new one. Starts a second dev server, so it takes a minute longer.">
            <Switch aria-label="Before and after" checked={p.before} onCheckedChange={(before) => put({ before })} />
          </Row>
          <Row label="In pull requests" hint="The clip goes in the pull request's description as a GIF, with its steps. GitHub plays only videos uploaded on its website, so Friday keeps the GIFs on a branch of the repository named friday-proof.">
            <Switch aria-label="In pull requests" checked={p.pr} onCheckedChange={(pr) => put({ pr })} />
          </Row>
          <Row label="At a phone's width too" hint="A second clip at 390 pixels wide, for pages people use on their phones.">
            <Switch aria-label="At a phone's width too" checked={p.phone} onCheckedChange={(phone) => put({ phone })} />
          </Row>
        </>
      )}
      {err && (
        <p role="alert" className="text-sm text-[var(--red)]">
          {err}
        </p>
      )}
    </SettingsGroup>
  );
}
