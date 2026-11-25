/**
 * "Done · unverified" as the way to check the work (spec 13, "Where it sits still" 3; working-clock audit 3): the badge under a
 * finished run that changed files and ran no test is also its one action. Check it asks Friday to test the lane's finished work
 * (proof-clips.ts testWork: the tests the run ran, else the project's own, and a clip when it changed a page), the same as Test it
 * under a reply, which this replaces for such a run. While that runs the badge turns and reads "Checking…"; once the tests are in
 * it reads "Checked · 12 tests pass" in green, or "Check failed" in red with Fix it, which asks the same agent to fix the first
 * failure. Everything it says after a reload is read from the session's own events, so it stands as it did.
 */
import { useMemo, useState } from "react";
import type { SessionEvent } from "../types.js";
import { testPart } from "../test-proof.js";
import { Icon } from "./icons.js";
import { StateRing } from "./presence.js";
import { testWork } from "./proof-clips.js";

export { checkStateOf, fixFirstText, type CheckState } from "../check-state.js";
import { checkStateOf, checkWords, fixFirstText } from "../check-state.js";

export function CheckBadge({ verdict, title, sid, invite, lane, endSeq, events, canCheck, onFix, notify }: {
  verdict: { text: string; tone: "pass" | "fail" | "none" };
  /** The test command the run ran, for the badge's tip. */
  title?: string | undefined;
  sid: string;
  invite: string;
  lane: string;
  /** The run's run.ended: what happened after it, before the lane's next run, is its check. */
  endSeq: number;
  events: readonly SessionEvent[];
  /** Whether Check it is offered: the lane's latest run, someone who can ask, in the edition that runs it. */
  canCheck: boolean;
  /** Ask the same agent to fix the first failure; none when this person can't, or a later run has moved on. */
  onFix?: ((text: string) => void) | undefined;
  notify: (text: string) => void;
}) {
  const [asked, setAsked] = useState(false);
  const st = useMemo(() => checkStateOf(events, lane, endSeq), [events.length, lane, endSeq]); // eslint-disable-line react-hooks/exhaustive-deps
  // Its own tests ran in the run: the badge says how, as it always has.
  if (verdict.tone !== "none")
    return (
      <span className={`rsp-verdict ${verdict.tone}`} title={title ?? "No test command ran in this run"}>
        <Icon name={verdict.tone === "pass" ? "check" : "x"} size={12} /> {verdict.text}
      </span>
    );
  const phase = st.phase === "none" && asked ? "checking" : st.phase;
  if (phase === "checking") {
    const cmd = st.phase === "checking" ? st.command : undefined;
    return (
      <span className="rsp-check" role="status">
        <span className="rsp-verdict none checking" title={cmd ? `Running ${cmd}` : "Friday is checking the work"}>
          <StateRing state="working" title="Checking" /> Checking…
        </span>
        {cmd && <span className="rsp-check-note">{testPart(cmd)}</span>}
      </span>
    );
  }
  if (st.phase === "passed")
    return (
      <span className="rsp-check" role="status">
        <span className="rsp-verdict pass" title={st.command}>
          <Icon name="check" size={12} /> {checkWords(st)!.text}
        </span>
      </span>
    );
  if (st.phase === "failed")
    return (
      <span className="rsp-check" role="status">
        <span className="rsp-verdict fail" title={st.command}>
          <Icon name="x" size={12} /> {checkWords(st)!.text}
        </span>
        {onFix && (
          <button type="button" className="test-it danger" title="Ask the agent to fix the first failure and run the check again" onClick={() => onFix(fixFirstText(st))}>
            <Icon name="wrench" size={13} />
            Fix it
          </button>
        )}
        {st.first && <span className="rsp-check-note" title={st.first}>{st.first.length > 48 ? `${st.first.slice(0, 47)}…` : st.first}</span>}
      </span>
    );
  if (st.phase === "couldnt")
    return (
      <span className="rsp-check">
        <span className="rsp-verdict none" title={st.why}>
          <Icon name="help" size={12} /> Done · couldn't check
        </span>
        <span className="rsp-check-note" title={st.why}>{st.why.length > 90 ? `${st.why.slice(0, 89)}…` : st.why}</span>
      </span>
    );
  if (st.phase === "clip")
    return (
      <span className="rsp-check">
        <span className="rsp-verdict none" title="No tests: the page it changed is recorded below">
          <Icon name="help" size={12} /> Done · shown in a clip
        </span>
      </span>
    );
  return (
    <span className="rsp-check">
      <span className="rsp-verdict none" title={title ?? "No test command ran in this run"}>
        <Icon name="help" size={12} /> {verdict.text}
      </span>
      {canCheck && (
        <button
          type="button"
          className="test-it"
          title="Friday runs the tests this needs (the project's own when the run ran none), and records the page when it changed one"
          onClick={() => {
            setAsked(true);
            void testWork(sid, invite, lane).catch((e: Error) => (setAsked(false), notify(e.message || "Couldn't start the check. Try again.")));
          }}
        >
          <Icon name="check" size={13} />
          Check it
        </button>
      )}
      <span className="rsp-check-note">No test ran in this run</span>
    </span>
  );
}
