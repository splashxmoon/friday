/**
 * Proof in Code Review (Arun, 2026-11-22: "btw how do i see the proof for the merge???", "Yes, add it"): a pull request a session of yours
 * opened shows that session's proof clip, the same card as in the chat; while one is being made, how it's going; with none yet and a
 * change that draws a page, Record a proof clip. Read again every few seconds while one is being made, so it arrives without a reload.
 * Nothing at all for a pull request no session of yours opened, or one with nothing to show.
 */
import { useCallback, useEffect, useState } from "react";
import type { SessionEvent } from "../types.js";
import { Icon } from "./icons.js";
import { ProofClipCard, ProofStatusCard } from "./ProofClipCard.js";
import { recordProofClip } from "./proof-clips.js";
import { TestProofCard } from "./TestProofCard.js";

type Got = {
  clip: (Extract<SessionEvent["body"], { type: "proof.clip" }> & { lane: string; seq: number; at: number }) | null;
  status: (Extract<SessionEvent["body"], { type: "proof.status" }> & { lane: string; at: number }) | null;
  recordable: { lane: string } | null;
  /** The session's latest test proof (proof.tests): for a change that draws nothing, the tests are its proof. */
  tests: (Extract<SessionEvent["body"], { type: "proof.tests" }> & { lane: string; seq: number; at: number }) | null;
};

export function PrProof({ sid, invite, merged }: { sid: string; invite: string; merged: boolean }) {
  const [got, setGot] = useState<Got | null>(null);
  const [err, setErr] = useState("");
  const read = useCallback(
    () =>
      fetch(`/api/sessions/${encodeURIComponent(sid)}/proof-clip?${new URLSearchParams({ invite })}`, { credentials: "same-origin" })
        .then((r) => (r.ok ? (r.json() as Promise<Got>) : null))
        .then((g) => g && setGot(g))
        .catch(() => {}),
    [sid, invite],
  );
  useEffect(() => void read(), [read]);
  // Being made: asked again until the clip (or why not) is in.
  const making = !!got?.status && got.status.stage !== "failed";
  useEffect(() => {
    if (!making) return;
    const t = setInterval(() => void read(), 3000);
    return () => clearInterval(t);
  }, [making, read]);
  if (!got || (!got.clip && !got.status && !got.tests && (!got.recordable || merged))) return null;
  const record = (lane: string) => {
    setErr("");
    void recordProofClip(sid, invite, lane).then(
      () => setTimeout(() => void read(), 800),
      (e: Error) => setErr(e.message),
    );
  };
  // The status and the clip as the chat has them, drawn by the same cards.
  const asEvent = (seq: number, ts: number, lane: string, body: SessionEvent["body"]): SessionEvent => ({ seq, ts, lane, actor: { id: "friday", name: "Friday", kind: "system" }, body }) as SessionEvent;
  const statusEv = got.status ? asEvent(1e12, got.status.at, got.status.lane, { type: "proof.status", stage: got.status.stage, ...(got.status.why ? { why: got.status.why } : {}) }) : null;
  return (
    <section className="flex flex-col gap-2" aria-label="Proof">
      <h3 className="m-0 text-[13px] font-semibold text-[var(--ink)]">Proof</h3>
      {statusEv && <ProofStatusCard ev={statusEv} events={[statusEv]} sid={sid} invite={invite} onRetry={record} />}
      {got.clip && <ProofClipCard ev={asEvent(got.clip.seq, got.clip.at, got.clip.lane, { ...got.clip, by: "queued" })} sid={sid} invite={invite} />}
      {got.tests && <TestProofCard ev={asEvent(got.tests.seq, got.tests.at, got.tests.lane, { type: "proof.tests", run: got.tests.run, by: got.tests.by, runs: got.tests.runs })} sid={sid} />}
      {!got.clip && !got.status && got.recordable && (
        <div className="pcs">
          <span className="pcs-mark" aria-hidden="true">
            <Icon name="play" size={12} />
          </span>
          <span className="pcs-text">
            <span className="pcs-title">No proof clip yet</span>
            <span className="pcs-sub">Friday walks the page this changed, clicks what it added, and says what was changed.</span>
          </span>
          <button type="button" className="pcc-btn primary" onClick={() => record(got.recordable!.lane)}>
            <Icon name="play" size={11} /> Record a proof clip
          </button>
        </div>
      )}
      {err && (
        <p role="alert" className="m-0 text-[12.5px] text-[var(--red)]">
          {err}
        </p>
      )}
    </section>
  );
}
