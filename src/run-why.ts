import type { SessionEvent } from "./types.js";

/**
 * Why a run started (Arun, 2026-11-15, after "too many agents, no way to tell why each one is active"): a person asked, a crew mate
 * handed it over or asked, a routine came round, a wake it set went off, Friday checked or nudged it, another session or an app
 * wrote. Read from what caused its run.started; the same words on the run in its chat and in its Spend.
 */
export type WhyKind = "asked" | "mate" | "routine" | "wake" | "friday" | "session" | "app";
export interface Why {
  kind: WhyKind;
  /** "Ada asked", "From Sage", "Routine · Stand-up", "Woke: PR #12 merged". */
  label: string;
}

const first = (name: string) => name.split(/\s+/)[0] || name;

/** Why the run that `started` (its run.started) began, from the log; `me` is the person reading, said as "You". */
export function whyRun(events: readonly SessionEvent[], started: SessionEvent, me?: string): Why {
  if (started.body.type !== "run.started") return { kind: "friday", label: "Friday started it" };
  const causedBy = started.body.causedBy;
  // The log is in seq order: the cause is found by halving rather than walked to.
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid]!.seq < causedBy) lo = mid + 1;
    else hi = mid;
  }
  const cause = events[lo]?.seq === causedBy ? events[lo]! : undefined;
  if (!cause || cause.body.type !== "instruction") return { kind: "friday", label: "Friday started it" };
  const b = cause.body;
  if (b.peer) return { kind: "session", label: "From another session" };
  if (b.via === "api") return { kind: "app", label: "From an app" };
  if (b.mesh) return { kind: "mate", label: b.mesh.kind === "ask" ? `${b.mesh.fromName} asked` : `From ${b.mesh.fromName}` };
  if (b.handoff) return { kind: "mate", label: "Handed on to it" };
  if (cause.actor.kind === "human") return { kind: "asked", label: me && cause.actor.id === me ? "You asked" : `${first(cause.actor.name)} asked` };
  const text = b.text.trimStart();
  if (text.startsWith("[Check-in]")) {
    const name = /routine, "([^"]+)"/.exec(text)?.[1];
    return { kind: "routine", label: name ? `Routine · ${name}` : "Routine" };
  }
  // A wake it set, gone off just before (wake.fired), said as what happened.
  for (let i = lo - 1; i >= 0 && i >= lo - 6; i--) {
    const e = events[i]!;
    // Only the wake that led straight to this word: past an earlier message or run, it was another's.
    if (e.body.type === "instruction" || e.body.type === "run.started" || e.body.type === "run.ended") break;
    if (e.body.type === "wake.fired" && (e.lane ?? "main") === (cause.lane ?? "main")) return { kind: "wake", label: `Woke: ${e.body.why.slice(0, 60)}` };
  }
  if (/^\[Workflow/i.test(text)) return { kind: "routine", label: "Workflow step" };
  if (b.check) return { kind: "friday", label: "A check failed" };
  if (b.keepGoing) return { kind: "friday", label: "Carrying on" };
  if (/^\[Friday\] You said /.test(text)) return { kind: "friday", label: "Friday checked a claim" };
  if (/^\[Friday\] Nothing has happened/.test(text)) return { kind: "friday", label: "Friday nudged it" };
  if (/^\[Friday\] .*(ran out of usage|usage)/.test(text)) return { kind: "friday", label: "On its fallback" };
  return { kind: "friday", label: "Friday asked" };
}

/** The run.started of the run on `lane` that a block from `seq` on belongs to: the last one at or before it. */
export function startOf(events: readonly SessionEvent[], lane: string, seq: number): SessionEvent | undefined {
  if (seq < 0) return undefined;
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid]!.seq <= seq) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo - 1; i >= 0; i--) {
    const e = events[i]!;
    if ((e.lane ?? "main") !== lane) continue;
    if (e.body.type === "run.started") return e;
    if (e.body.type === "run.ended") return undefined;
  }
  return undefined;
}
