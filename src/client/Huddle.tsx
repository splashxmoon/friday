import { useState } from "react";
import { CheckCheckIcon, CheckIcon, ChevronRightIcon, Clock3Icon, MinusIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { laneLabel } from "../left-off.js";
import { agentLook } from "./handoff-ui.js";
import { Clamped, taskStatus } from "./AgentTalk.js";
import { meshOf, pendingFor, runOf, type SessionState } from "../session/projection.js";
import { MAIN_LANE, type MeshNote, type SessionEvent } from "../types.js";

/**
 * Agents talking in a coding session as huddles (Arun, 2026-11-05: "build K2 into the app", the design canvas's K2): what two
 * agents said to each other since the person last wrote, folded into one card that sits at their latest message. Its first line
 * is where the talk stands (the open question, or what was settled), and a pill says in a word whose move it is: answering,
 * waiting on an agent, needs you, not read yet, working, checking, settled. Opened, it shows who is doing what now, and every
 * message with whether it was read, a sender's run of messages under one name.
 *
 * Only what the session knows is said: nothing here guesses at an agreement or a change the log doesn't record.
 */

export interface HuddleInfo {
  /** The two agents and the stretch since the person last wrote: what folds together. */
  key: string;
  evs: SessionEvent[];
  /** The message the card is drawn at: the latest. */
  anchor: number;
}

/**
 * The huddles in what is on screen: every message between the same two agents, from one message of a person's to the next.
 * A message to the whole team keeps its own card (it is to everyone, not a conversation between two).
 */
export function huddlesIn(events: readonly SessionEvent[], shown: (e: SessionEvent) => boolean): Map<number, HuddleInfo> {
  const out = new Map<number, HuddleInfo>();
  const open = new Map<string, HuddleInfo>();
  let round = 0;
  for (const e of events) {
    const b = e.body;
    if (b.type === "instruction" && !b.mesh && !b.peer && !b.approval && e.actor.kind === "human") {
      round++;
      continue;
    }
    if (b.type !== "instruction" || !b.mesh || b.mesh.team || !shown(e)) continue;
    const to = e.lane ?? MAIN_LANE;
    const key = `${[b.mesh.fromLane, to].sort().join("|")}#${round}`;
    let h = open.get(key);
    if (!h) open.set(key, (h = { key, evs: [], anchor: e.seq }));
    h.evs.push(e);
    h.anchor = e.seq;
    out.set(e.seq, h);
  }
  return out;
}

/** An agent held up on a person: a question to them, a permission to answer, or its run waiting (as the Agents hub says it). */
const onPerson = (state: SessionState, lane: string) => runOf(state, lane).status === "waiting_for_human" || !!state.openQuestions[lane] || !!state.approvals[lane];

const clock = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });
const firstLine = (t: string) => (t.split("\n").find((l) => l.trim()) ?? t).trim().replace(/^[#>*\-\s]+/, "");

type Tone = "work" | "wait" | "unread" | "need" | "read" | "done" | "review" | "bad" | "quiet";
interface Pill {
  tone: Tone;
  word: string;
  /** The agent whose move it is, by its mark. */
  lane?: string;
}

interface Row {
  seq: number;
  lane: string;
  who: string;
  kind: string;
  ts: number;
  text: string;
  why?: string;
  receipt?: { tone: Tone; word: string };
}

/** Folded or open, per huddle, kept while the person moves around the session (the card is drawn anew at each new message). */
const opened = new Map<string, boolean>();

export function HuddleCard({ h, state, delivered, events }: { h: HuddleInfo; state: SessionState; delivered: Set<number>; events: readonly SessionEvent[] }) {
  const mesh = meshOf(state);
  const tsOf = (seq: number) => events.find((e) => e.seq === seq)?.ts ?? 0;
  const queued = (e: SessionEvent) => pendingFor(state, e.lane ?? MAIN_LANE).includes(e.seq) && !delivered.has(e.seq);
  const notes = h.evs.map((e) => ({ e, m: (e.body as { mesh: MeshNote }).mesh, to: e.lane ?? MAIN_LANE }));

  const rows: Row[] = [];
  for (const { e, m, to } of notes) {
    const ask = mesh.asks[m.id];
    const kind = m.carriedFrom ? "Carried on" : m.kind === "reply" && m.ofTask ? "Report" : m.board && m.review ? "Check" : m.kind === "tell" ? "Told" : m.kind === "ask" ? "Asked" : m.kind === "task" ? "Task" : "Answered";
    const receipt = queued(e) ? { tone: "unread" as const, word: runOf(state, to).status === "running" ? `Not read yet: ${m.toName} reads it when its turn ends` : "Not read yet" } : delivered.has(e.seq) && m.kind !== "ask" && !(ask && !ask.reply) ? { tone: "read" as const, word: `Read by ${m.toName}` } : undefined;
    rows.push({
      seq: e.seq,
      lane: m.fromLane,
      who: m.fromName,
      kind,
      ts: e.ts,
      text: m.board && m.title ? m.title : (e.body as { text: string }).text,
      ...(m.carriedFrom ? { why: `${laneLabel(state, m.carriedFrom)} ran out of usage partway through, so Friday gave it to ${m.toName}, with what it had done.` } : {}),
      ...(receipt ? { receipt } : {}),
    });
    if (ask?.reply && ask.reply.seq) rows.push({ seq: ask.reply.seq, lane: to, who: m.toName, kind: ask.task ? "Report" : "Answered", ts: tsOf(ask.reply.seq), text: ask.reply.text });
  }
  rows.sort((a, b) => a.seq - b.seq);

  // Where it stands: the newest thing still open says whose move it is; with nothing open it is settled, or read.
  let pill: Pill | null = null;
  let headline = "";
  for (const { e, m, to } of [...notes].reverse()) {
    const ask = mesh.asks[m.id];
    const run = runOf(state, to).status;
    const text = m.board && m.title ? m.title : (e.body as { text: string }).text;
    if (queued(e)) pill = { tone: "unread", word: "Not read yet", lane: to };
    else if (m.kind === "ask" && ask && !ask.reply)
      pill = onPerson(state, to) ? { tone: "need", word: "Needs you", lane: to } : run === "running" ? { tone: "work", word: "Answering", lane: to } : run === "error" ? { tone: "bad", word: "Stopped", lane: to } : { tone: "wait", word: "Waiting on", lane: to };
    else if (m.kind === "task" || m.board) {
      const t = taskStatus(state, m, to);
      if (t.how !== "done" && t.word !== "Reported back") {
        pill =
          onPerson(state, to) ? { tone: "need", word: "Needs you", lane: to }
          : t.how === "work" ? { tone: "work", word: "Working", lane: to }
          : t.how === "review" ? { tone: "review", word: "Checking" }
          : t.how === "bad" ? { tone: "bad", word: t.word.startsWith("Stuck") ? "Stuck" : "Stopped", lane: to }
          : onPerson(state, to) ? { tone: "need", word: "Needs you", lane: to }
          : t.how === "quiet" ? { tone: "quiet", word: t.word }
          : { tone: "wait", word: "Not finished", lane: to };
      }
    }
    if (pill) {
      headline = firstLine(text);
      break;
    }
  }
  const last = rows.at(-1)!;
  if (!pill) {
    const answered = rows.some((r) => r.kind === "Answered" || r.kind === "Report");
    const unread = notes.some(({ e }) => !delivered.has(e.seq));
    pill = answered ? { tone: "done", word: `Settled ${clock.format(last.ts)}` } : unread ? { tone: "unread", word: "Not read yet" } : { tone: "read", word: "Read" };
    headline = firstLine(last.text);
  }

  const lanes = [...new Set(notes.flatMap(({ m, to }) => [m.fromLane, to]))];
  const names = lanes.map((l) => laneLabel(state, l));
  const who = names.length > 2 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join(" and ");
  const count = rows.length;
  const first = rows[0]!;
  const when = first.ts && last.ts && clock.format(first.ts) !== clock.format(last.ts) ? `${clock.format(first.ts)} to ${clock.format(last.ts)}` : clock.format(last.ts);
  const live = pill.tone !== "done" && pill.tone !== "read" && pill.tone !== "quiet";
  const [, redraw] = useState(0);
  const isOpen = opened.get(h.key) ?? live;
  const toggle = () => {
    opened.set(h.key, !isOpen);
    redraw((n) => n + 1);
  };

  // Who is doing what now, for a talk still going: the one answering, the one waiting for it, the one gone back to its own work.
  const owes = new Set(notes.filter(({ m }) => m.kind === "ask" && !mesh.asks[m.id]?.reply).map(({ to }) => to));
  const waits = new Set(notes.filter(({ m }) => m.kind === "ask" && !mesh.asks[m.id]?.reply).map(({ m }) => m.fromLane));
  const doing = (l: string): { word: string; tone: "work" | "wait" | "need" | "bad" | "quiet" } => {
    const run = runOf(state, l).status;
    if (onPerson(state, l)) return { word: "Needs you", tone: "need" };
    if (run === "error") return { word: "Stopped", tone: "bad" };
    if (run === "running") return { word: owes.has(l) ? "Answering" : "Working", tone: "work" };
    if (waits.has(l)) return { word: "Waiting for this", tone: "wait" };
    return { word: "Not working now", tone: "quiet" };
  };

  return (
    <div className={cn("hd", pill.tone === "need" && "need")} data-huddle={h.key}>
      <button type="button" className="hd-bar" aria-expanded={isOpen} onClick={toggle}>
        <span className="hd-stack" aria-hidden="true">
          {lanes.slice(0, 3).map((l) => (
            <span key={l} className="hd-face" style={{ "--tint": agentLook(state, l, 12).tint } as React.CSSProperties}>
              {agentLook(state, l, 12).mark}
            </span>
          ))}
        </span>
        <span className="hd-txt">
          <span className="hd-head">{headline}</span>
          <span className="hd-sub">
            {who} · {count} message{count === 1 ? "" : "s"} · {when}
          </span>
        </span>
        <span className={cn("hd-pill", `is-${pill.tone}`)}>
          <PillIcon tone={pill.tone} />
          {pill.word}
          {pill.lane && (pill.tone === "work" || pill.tone === "wait" || pill.tone === "need") && (
            <span className="hd-pill-face" title={laneLabel(state, pill.lane)}>
              {agentLook(state, pill.lane, 10).mark}
            </span>
          )}
        </span>
        <ChevronRightIcon className={cn("hd-chev", isOpen && "open")} aria-hidden="true" />
      </button>
      {isOpen && (
        <div className="hd-body">
          {live && lanes.length > 1 && (
            <div className="hd-now" style={{ gridTemplateColumns: `repeat(${Math.min(lanes.length, 3)}, minmax(0, 1fr))` }}>
              {lanes.slice(0, 3).map((l) => {
                const d = doing(l);
                return (
                  <div key={l} className="hd-who">
                    <span className="hd-logo">
                      {agentLook(state, l, 14).mark}
                      {d.tone === "work" && <span className="hd-spin" aria-hidden="true" />}
                      {d.tone !== "work" && d.tone !== "quiet" && <span className={cn("hd-badge", `is-${d.tone}`)} aria-hidden="true" />}
                    </span>
                    <span className="hd-who-t">
                      <b>{laneLabel(state, l)}</b>
                      <span className={cn(d.tone === "work" && "on")}>{d.word}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <div className="hd-thread">
            {rows.map((r, i) => {
              const same = i > 0 && rows[i - 1]!.lane === r.lane;
              const lastOfRun = i === rows.length - 1 || rows[i + 1]!.lane !== r.lane;
              return (
                <div key={r.seq} className={cn("hd-msg", same && "cont", lastOfRun && "end", i === rows.length - 1 && "last")}>
                  {!same ? <span className="hd-face sm">{agentLook(state, r.lane, 11).mark}</span> : <span />}
                  <div className="hd-msg-main">
                    {!same && (
                      <div className="hd-name">
                        {r.who}
                        <span className="hd-kind">{r.kind}</span>
                        <span className="hd-time">{clock.format(r.ts)}</span>
                      </div>
                    )}
                    {r.why && <p className="hd-why">{r.why}</p>}
                    <Clamped text={r.text} />
                    {r.receipt && (
                      <span className={cn("hd-receipt", `is-${r.receipt.tone}`)}>
                        {r.receipt.tone === "read" ? <CheckCheckIcon className="size-3 shrink-0" /> : <i className="tk-dot" aria-hidden="true" />}
                        {r.receipt.word}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function PillIcon({ tone }: { tone: Tone }) {
  if (tone === "work") return <span className="ring-spin" aria-hidden="true" />;
  if (tone === "done") return <CheckIcon className="size-3 shrink-0" aria-hidden="true" />;
  if (tone === "read") return <CheckCheckIcon className="size-3 shrink-0" aria-hidden="true" />;
  if (tone === "bad") return <XIcon className="size-3 shrink-0" aria-hidden="true" />;
  if (tone === "quiet") return <MinusIcon className="size-3 shrink-0" aria-hidden="true" />;
  if (tone === "wait") return <Clock3Icon className="size-3 shrink-0" aria-hidden="true" />;
  return <i className="tk-dot" aria-hidden="true" />;
}
