/**
 * A workflow waiting for your OK (team-workflows.ts asks, GET /api/teammates `asks`; Arun, 2026-11-01: "very advanced but very
 * easy to use"): what you're asked, what the work came to so far, and the answer, one press. Shown on the workflows page, and in
 * the room the run is in. Send back takes a word on what to change, handed to the step it goes back to; an OK that stops instead
 * says Stop.
 */
import { useEffect, useRef, useState } from "react";
import { CornerUpLeftIcon, HandIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ANSWER, mediaText } from "./AnswerParts.js";
import { api } from "./api.js";
import type { Identity } from "./storage.js";
import { useTeamNow, type Team } from "./Teammates.js";
import { listOf } from "./team-workflow-view.js";
import { relTime } from "./ui.js";
import "./workflows.css";

export interface WorkflowAsk {
  id: string;
  name: string;
  run: string;
  step: string;
  n: number;
  ask: string;
  since: number;
  carry: string;
  sid?: string;
  roomName: string;
  ifNot: "stop" | "back";
  backTo?: number;
}

/** The runs waiting for your OK, in `sid`'s room or everywhere. */
export function useWorkflowAsks(sid?: string, workflow?: string): WorkflowAsk[] {
  const t = useTeamNow() as (Team & { asks?: WorkflowAsk[]; flowRuns?: { run: string; sid: string }[] }) | null;
  // In a room, a run with its card there (WorkflowRunCard.tsx) is answered on the card.
  const carded = new Set(sid ? listOf<{ run: string; sid: string }>(t?.flowRuns).filter((r) => r.sid === sid).map((r) => r.run) : []);
  // The hosted service's team has an `asks` of its own, not these (Teammates.tsx HostedTeam).
  return listOf<WorkflowAsk>(t?.asks).filter((a) => (!sid || a.sid === sid) && (!workflow || a.id === workflow) && !carded.has(a.run));
}

export function WorkflowAsks({ identity, sid, workflow, onAnswered }: { identity: Identity; /** Only this room's. */ sid?: string; /** Only this workflow's. */ workflow?: string; onAnswered?: () => void }) {
  const asks = useWorkflowAsks(sid, workflow);
  // Answered here: gone at once, not when the team is next read.
  const [done, setDone] = useState<Set<string>>(() => new Set());
  const open = asks.filter((a) => !done.has(a.run));
  if (!open.length) return null;
  return (
    <div className="wfa-list" aria-label="Workflows waiting for your OK">
      {open.map((a) => (
        <AskCard key={a.run} a={a} identity={identity} onDone={() => (setDone((s) => new Set(s).add(a.run)), onAnswered?.())} />
      ))}
    </div>
  );
}

function AskCard({ a, identity, onDone }: { a: WorkflowAsk; identity: Identity; onDone: () => void }) {
  const [back, setBack] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [whole, setWhole] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  // Into the note as Send back opens it: the press that opened it is still settling, so a frame later.
  useEffect(() => {
    if (back) requestAnimationFrame(() => box.current?.focus());
  }, [back]);
  const answer = async (ok: boolean) => {
    setBusy(true);
    setError("");
    try {
      await api(identity, `/api/workflows/${a.id}/runs/${a.run}/answer`, { method: "POST", body: JSON.stringify({ ok, note: ok ? "" : note }), headers: { "Content-Type": "application/json" } });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const carry = a.carry.trim();
  const long = carry.length > 360 || carry.split("\n").length > 6;
  const no = a.ifNot === "back" ? `Send back to step ${a.backTo ?? 1}` : "Stop the run";
  return (
    <section className="wfa-card" aria-label={`${a.name} is waiting for your OK`}>
      <div className="wfa-head">
        <span className="wfa-icon" aria-hidden="true">
          <HandIcon className="size-3.5" />
        </span>
        <span className="wfa-name">{a.name}</span>
        <span className="wfa-meta">
          Step {a.n} · {relTime(a.since) === "now" ? "just now" : `${relTime(a.since)} ago`}
        </span>
      </div>
      <p className="wfa-ask">{a.ask}</p>
      {carry && (
        <div className={long && !whole ? "wfa-carry clamped" : "wfa-carry"}>
          <div className="tt-rich">
            <MessageResponse {...ANSWER}>{mediaText(carry)}</MessageResponse>
          </div>
          {long && (
            <button type="button" className="tt-more" onClick={() => setWhole(!whole)}>
              {whole ? "Show less" : "Show all"}
            </button>
          )}
        </div>
      )}
      {back && (
        <Textarea
          ref={box}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={a.ifNot === "back" ? `What should change? Step ${a.backTo ?? 1} is told.` : "Why not? (optional)"}
          className="min-h-[72px] text-[13px] md:text-[13px]"
          maxLength={2000}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && void answer(false)}
        />
      )}
      {error && (
        <p role="alert" className="wfa-error">
          {error}
        </p>
      )}
      <div className="wfa-actions">
        {back ? (
          <>
            <Button size="sm" className="h-8 px-3 text-[13px]" disabled={busy || (a.ifNot === "back" && !note.trim())} onClick={() => void answer(false)}>
              {a.ifNot === "back" && <CornerUpLeftIcon />} {no}
            </Button>
            <Button variant="ghost" size="sm" className="h-8 px-3 text-[13px]" disabled={busy} onClick={() => (setBack(false), setNote(""))}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" className="h-8 px-3 text-[13px]" disabled={busy} onClick={() => void answer(true)}>
              OK, go on
            </Button>
            <Button variant="outline" size="sm" className="h-8 border-[var(--border)] px-3 text-[13px] shadow-none" disabled={busy} onClick={() => setBack(true)}>
              {a.ifNot === "back" ? "Send back" : "Stop it"}
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
