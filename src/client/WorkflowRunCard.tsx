/**
 * A crew workflow's run in its room, as one card (Arun, 2026-11-01, picking the Crew room concept: "Crew room run card"). Where
 * the room showed each step handed out as its own message ("Kit gave Kit a task"), the workflow's own wording in brackets, a
 * check's raw report ("Status: done Result: … Evidence: … Unblock: nothing … PASS") and a brief whose markdown didn't render,
 * the run is one card where its first board was posted: its steps down a line, each with who did it and what it came to in a
 * line, a check as its answer, a step done again as its try, your OK at the end with its two answers, and, once it is through,
 * what it came to. Its chatter is left out of the room (team-room.ts workflowChatter). The data is the team's (`flowRuns`,
 * team-workflow-model.ts roomRunOf), read as the team is polled.
 */
import { useEffect, useRef, useState } from "react";
import { AlertTriangleIcon, CheckIcon, CornerUpLeftIcon, HandIcon, RotateCcwIcon, ShieldCheckIcon, ShieldXIcon, WorkflowIcon, XIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { RoomRun, RoomRunStep } from "../team-workflow-model.js";
import { ANSWER, mediaText } from "./AnswerParts.js";
import { api } from "./api.js";
import type { Identity } from "./storage.js";
import { Face, useTeamNow, type Team } from "./Teammates.js";
import { listOf } from "./team-workflow-view.js";
import { relTime } from "./ui.js";
import "./workflows.css";

/** The room's runs, from the team as it is polled. */
export function useRoomRuns(sid: string): RoomRun[] {
  const t = useTeamNow() as (Team & { flowRuns?: RoomRun[] }) | null;
  return listOf<RoomRun>(t?.flowRuns).filter((r) => r.sid === sid);
}

const STATUS: Record<RoomRun["status"], { word: string; tone: string }> = {
  running: { word: "Running", tone: "live" },
  waiting: { word: "Waiting for the room", tone: "" },
  asking: { word: "Needs your OK", tone: "ask" },
  done: { word: "Done", tone: "done" },
  stopped: { word: "Stopped", tone: "" },
  failed: { word: "Didn't finish", tone: "bad" },
  skipped: { word: "Skipped", tone: "" },
};

const took = (ms: number) => (ms < 60_000 ? "under a minute" : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 360_000) / 10} h`);

export function WorkflowRunCard({ run, identity }: { run: RoomRun; identity: Identity | null }) {
  const s = STATUS[run.status];
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState("");
  const [whole, setWhole] = useState(false);
  const ended = run.status === "done" || run.status === "stopped" || run.status === "failed" || run.status === "skipped";
  const retry = async () => {
    if (!identity) return;
    setRetrying(true);
    setError("");
    try {
      await api(identity, `/api/workflows/${run.id}/runs/${run.run}/retry`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRetrying(false);
    }
  };
  const result = run.result?.replace(/^## /gm, "### ").trim() ?? "";
  return (
    <section className="wfr" data-status={run.status} aria-label={`${run.name}: ${s.word}`}>
      <header className="wfr-head">
        <span className="wfr-icon" aria-hidden="true">
          <WorkflowIcon className="size-3.5" />
        </span>
        <span className="wfr-name">{run.name}</span>
        <span className="wfr-pill" data-tone={s.tone}>
          {s.word}
        </span>
        <span className="wfr-time" title={new Date(run.at).toLocaleString()}>
          {ended && run.ended ? took(run.ended - run.at) : relTime(run.at) === "now" ? "just now" : `${relTime(run.at)} ago`}
        </span>
      </header>
      <ol className="wfr-steps">
        {run.steps.map((st, i) => (
          <Step key={st.step} st={st} run={run} last={i === run.steps.length - 1} identity={identity} />
        ))}
      </ol>
      {(run.status === "failed" || run.status === "stopped") && (
        <div className="wfr-end">
          {run.note && <p className="wfr-note">{run.note}</p>}
          <Button variant="outline" size="sm" className="h-8 border-[var(--border)] px-3 text-[13px] shadow-none" disabled={retrying || !identity} onClick={() => void retry()}>
            <RotateCcwIcon /> {retrying ? "Starting…" : "Try again from here"}
          </Button>
          {error && <p className="wfr-error">{error}</p>}
        </div>
      )}
      {run.status === "done" && result && (
        <div className={whole ? "wfr-result" : "wfr-result clamped"}>
          <div className="tt-rich">
            <MessageResponse {...ANSWER}>{mediaText(result)}</MessageResponse>
          </div>
          <button type="button" className="tt-more" onClick={() => setWhole(!whole)}>
            {whole ? "Show less" : "Show what it came to"}
          </button>
        </div>
      )}
    </section>
  );
}

/** Who does a step, as the crew has them: their face, by name. */
function useMate(name: string) {
  const t = useTeamNow();
  return listOf<NonNullable<Team["teammates"]>[number]>(t?.teammates).find((m) => m.name === name) ?? null;
}

function Step({ st, run, last, identity }: { st: RoomRunStep; run: RoomRun; last: boolean; identity: Identity | null }) {
  const m = useMate(st.name);
  const asking = st.kind === "approve" && run.asking?.step === st.step && run.status === "asking";
  const working = st.status === "claimed" || st.status === "review";
  const passed = st.verdict?.pass;
  const mark =
    st.kind === "approve"
      ? asking
        ? "ask"
        : st.status === "done"
          ? "done"
          : st.status === "cancelled"
            ? "no"
            : "pending"
      : st.status === "done"
        ? st.kind === "check" && passed === false
          ? "fail"
          : "done"
        : working
          ? "working"
          : st.status === "blocked"
            ? "stuck"
            : st.status === "cancelled"
              ? "no"
              : "pending";
  const Icon = mark === "ask" ? HandIcon : mark === "fail" ? ShieldXIcon : mark === "stuck" ? AlertTriangleIcon : mark === "no" ? XIcon : st.kind === "check" && mark === "done" ? ShieldCheckIcon : CheckIcon;
  const line =
    st.kind === "approve"
      ? asking
        ? st.title
        : st.status === "done"
          ? "You OK'd it"
          : st.status === "cancelled"
            ? "You said no"
            : st.title
      : st.kind === "check" && st.status === "done"
        ? passed
          ? "Check passed"
          : "Check didn't pass"
        : st.status === "done"
          ? (st.said ?? st.title)
          : st.kind === "check"
            ? `Check: ${st.title}`
            : st.title;
  const sub =
    st.kind === "approve"
      ? st.verdict?.why && !asking
        ? `“${st.verdict.why}”`
        : ""
      : st.kind === "check" && st.status === "done"
        ? (st.said ?? "")
        : st.status === "done"
          ? st.said
            ? st.title
            : ""
          : working
            ? `${st.name} is on it`
            : st.status === "blocked"
              ? (st.said ?? "Stuck")
              : "";
  return (
    <li className="wfr-step" data-mark={mark} data-last={last || undefined}>
      <span className="wfr-mark" aria-hidden="true">
        {mark === "working" ? <span className="spinner" /> : mark === "pending" ? <span className="wfr-dot" /> : <Icon className="size-3" />}
      </span>
      <div className="wfr-body">
        <div className="wfr-line">
          {st.kind !== "approve" && m && <Face seed={m.look ?? m.name} size={16} {...(working ? { status: "working" as const } : {})} />}
          <span className="wfr-text">{line}</span>
          {(st.again ?? 0) > 0 && <span className="wfr-try">Try {(st.again ?? 0) + 1}</span>}
        </div>
        {sub && <div className="wfr-sub">{sub}</div>}
        {asking && run.asking && <Answer run={run} identity={identity} />}
      </div>
    </li>
  );
}

/** Your answer, at the end of the run: on with it, or back (with what to change) or stopped, as its step says. */
function Answer({ run, identity }: { run: RoomRun; identity: Identity | null }) {
  const [back, setBack] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (back) requestAnimationFrame(() => box.current?.focus());
  }, [back]);
  const a = run.asking!;
  const answer = async (ok: boolean) => {
    if (!identity) return;
    setBusy(true);
    setError("");
    try {
      await api(identity, `/api/workflows/${run.id}/runs/${run.run}/answer`, { method: "POST", body: JSON.stringify({ ok, note: ok ? "" : note }), headers: { "Content-Type": "application/json" } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="wfr-answer">
      {back && (
        <Textarea
          ref={box}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={a.ifNot === "back" ? `What should change? Step ${a.backTo ?? 1} is told.` : "Why not? (optional)"}
          className="min-h-[64px] text-[13px] md:text-[13px]"
          maxLength={2000}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && void answer(false)}
        />
      )}
      <div className="wfr-acts">
        {back ? (
          <>
            <Button size="sm" className="h-8 px-3 text-[13px]" disabled={busy || (a.ifNot === "back" && !note.trim())} onClick={() => void answer(false)}>
              {a.ifNot === "back" && <CornerUpLeftIcon />} {a.ifNot === "back" ? `Send back to step ${a.backTo ?? 1}` : "Stop the run"}
            </Button>
            <Button variant="ghost" size="sm" className="h-8 px-3 text-[13px]" disabled={busy} onClick={() => (setBack(false), setNote(""))}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" className="h-8 px-3 text-[13px]" disabled={busy || !identity} onClick={() => void answer(true)}>
              OK, go on
            </Button>
            <Button variant="outline" size="sm" className="h-8 border-[var(--border)] px-3 text-[13px] shadow-none" disabled={busy || !identity} onClick={() => setBack(true)}>
              {a.ifNot === "back" ? (
                <>
                  <CornerUpLeftIcon /> Send back
                </>
              ) : (
                "Stop it"
              )}
            </Button>
          </>
        )}
      </div>
      {error && <p className="wfr-error">{error}</p>}
    </div>
  );
}
