import { useState, type ReactNode } from "react";
import { ArrowRightIcon, CheckIcon, ChevronDownIcon, CircleCheckIcon, CircleDashedIcon, CircleDotIcon, UsersIcon } from "lucide-react";
import { agentLook } from "./handoff-ui.js";
import { laneLabel } from "../left-off.js";
import { meshOf, pendingFor, runOf, type SessionState } from "../session/projection.js";
import { MAIN_LANE, type MeshNote, type SessionEvent } from "../types.js";
import { taskStatus } from "./AgentTalk.js";
import { Face, mateOn } from "./Teammates.js";
import { LazyAnswer } from "./lazy-answer.js";
import { boardTitle } from "./team-api.js";
import { boardReportText, plainLine, withoutFridayNotes } from "./team-room.js";
import "./crew-talk.css";

/**
 * The crew talking to each other in a room, said in the room as people talk in a group chat (Arun, 2026-11-17, of the mock: "ok i
 * like it", in place of the box of "Nova, Kit and Vera worked together · 7 messages"). Each message is a row of its own: the sender's
 * face and name, an arrow to whom it went with that one's small face, what it was (handed a task, asked, reported back, posted an
 * update), and its words whole. A question carries its answer threaded under it; a task its card with where it stands; a question
 * still open says whom it waits on and for how long; an update says who has seen it. A long back and forth folds its middle to one
 * line ("Kit and Nova traded 3 more messages") that opens in place.
 */

/** One piece of the talk: an agent's message or update by its event, or anything else drawn as it already is. */
export type TalkEntry = { key: number; ev?: SessionEvent; node?: ReactNode };

const FOLD_OVER = 8;
const KEEP = 3;
const clock = (ts?: number) => (ts ? new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");
const since = (ts: number) => ((m) => (m < 1 ? "just now" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`))(Math.floor((Date.now() - ts) / 60_000));
const later = (from: number, to: number) => ((m) => (m < 1 ? "just after" : m < 60 ? `${m}m later` : `${Math.floor(m / 60)}h later`))(Math.floor((to - from) / 60_000));
const names = (n: string[]) => (n.length <= 1 ? n.join("") : n.length === 2 ? `${n[0]} and ${n[1]}` : `${n.slice(0, -1).join(", ")} and ${n.at(-1)}`);

/** An agent's face by its lane: a crew mate's own, or the agent's mark. */
function FaceOf({ state, lane, size }: { state: SessionState; lane: string; size: number }) {
  const m = mateOn(lane);
  if (m) return <Face seed={m.look ?? m.name} size={size} />;
  return <span className="ctk-mark" style={{ width: size, height: size }}>{agentLook(state, lane, Math.round(size * 0.62)).mark}</span>;
}
const nameOf = (state: SessionState, lane: string, fallback: string) => mateOn(lane)?.name ?? (fallback || laneLabel(state, lane));

type Status = { word: string; how: string };
type Facts = {
  from: string;
  fromName: string;
  to: string | null;
  toName: string;
  verb: string;
  /** Who to whom in a few words, for a folded row: "asked Nova", "to Kit". */
  brief: string;
  text: string;
  ts: number;
  task?: { title: string; status: Status };
  answer?: { lane: string; name: string; text: string; ts?: number; auto?: boolean; short?: boolean };
  status?: Status | null;
  seen?: { lanes: string[]; all: boolean } | null;
};

/** What a row says, read off the message and where it stands now. */
function factsOf(ev: SessionEvent, state: SessionState, delivered: Set<number>, events: readonly SessionEvent[]): Facts | null {
  const b = ev.body;
  if (b.type === "mesh.posted") {
    const read = meshOf(state).readUpTo ?? {};
    const others = [MAIN_LANE, ...state.lanes.map((l) => l.id)].filter((l) => l !== b.fromLane && (l !== MAIN_LANE || !!mateOn(l)));
    const seen = others.filter((l) => (read[l] ?? 0) >= ev.seq);
    return { from: b.fromLane, fromName: b.fromName, to: null, toName: "everyone", verb: "posted an update", brief: "to everyone", text: b.text, ts: ev.ts, seen: others.length ? { lanes: seen, all: seen.length === others.length } : null };
  }
  if (b.type !== "instruction" || !b.mesh) return null;
  const m: MeshNote = b.mesh;
  const lane = ev.lane ?? MAIN_LANE;
  const mesh = meshOf(state);
  const ask = m.kind === "ask" ? mesh.asks[m.id] : undefined;
  const text = m.kind === "reply" && m.ofTask ? boardReportText(b.text, events, ev.seq, (l) => mateOn(l)?.name) : b.text;
  const toName = nameOf(state, lane, m.toName);
  const verb = m.carriedFrom ? "took over a task" : m.team ? "told the crew" : m.kind === "task" ? (m.review ? "asked for a check" : "handed a task") : m.kind === "ask" ? "asked" : m.kind === "reply" ? (m.ofTask ? "reported back" : "replied") : "";
  const queued = pendingFor(state, lane).includes(ev.seq);
  const who = m.team ? "the crew" : toName;
  const brief = m.carriedFrom ? `took over for ${who}` : m.kind === "task" ? `gave ${who} a task` : m.kind === "ask" ? `asked ${who}` : m.kind === "reply" ? `${m.ofTask ? "reported back to" : "replied to"} ${who}` : `to ${who}`;
  const base: Facts = { from: m.fromLane, fromName: nameOf(state, m.fromLane, m.fromName), to: m.team ? null : lane, toName: who, verb, brief, text: boardTitle(withoutFridayNotes(text)), ts: ev.ts };
  if (m.kind === "task") {
    const title = plainLine(m.title ?? boardTitle(withoutFridayNotes(b.text)).split("\n").find((l) => l.trim()) ?? "");
    return { ...base, task: { title, status: queued ? { word: `Queued for ${toName}`, how: "wait" } : taskStatus(state, m, lane) } };
  }
  if (ask?.reply) {
    const at = events.find((e) => e.seq === ask.reply!.seq)?.ts;
    return { ...base, answer: { lane, name: toName, text: ask.reply.text, ...(at ? { ts: at } : {}), ...(ask.reply.auto ? { auto: true } : {}), ...(ask.reply.short ? { short: true } : {}) } };
  }
  if (ask) {
    if (ask.unwaitedSeq !== undefined) return { ...base, status: { word: `${base.fromName} stopped waiting; the answer comes as a message`, how: "quiet" } };
    return { ...base, status: runOf(state, lane).status === "running" ? { word: `${toName} is answering`, how: "work" } : { word: `Waiting on ${toName} · ${since(ev.ts)}`, how: "wait" } };
  }
  if (queued) return { ...base, status: { word: `Queued for ${toName}`, how: "wait" } };
  return { ...base, status: delivered.has(ev.seq) && !m.team ? { word: `Read by ${toName}`, how: "read" } : null };
}

function StatusLine({ s }: { s: Status }) {
  return (
    <span className="ctk-st" data-how={s.how}>
      {s.how === "read" || s.how === "done" ? <CheckIcon aria-hidden="true" /> : s.how === "work" ? <span className="ring-spin" aria-hidden="true" /> : <i aria-hidden="true" />}
      {s.word}
    </span>
  );
}

/** Whom it went to: an arrow and a small chip with their face, or the whole crew. */
function ToChip({ state, f }: { state: SessionState; f: Facts }) {
  return (
    <>
      <ArrowRightIcon className="ctk-arrow" aria-label="to" />
      <span className="ctk-to">
        {f.to ? <FaceOf state={state} lane={f.to} size={14} /> : <UsersIcon className="ctk-to-crew" aria-hidden="true" />}
        {f.toName}
      </span>
    </>
  );
}

/**
 * The message in a line (Arun, 2026-11-17: "make this into a one row card or something because it is too much stuff and clogging
 * the chat, maybe a summary or something rather than the full message, same for agent to agent"): who to whom, what it was, its
 * first sentence, and where it stands at its end. Pressed, it opens under the line to the message whole, its task, its answer.
 */
function summaryOf(f: Facts): string {
  if (f.task) return f.task.title;
  // An agent signing its own message ("Juno: Sage has…") says its name once, in the line's head.
  const line = plainLine(f.text).replace(new RegExp(`^${f.fromName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*`, "i"), "").trim();
  const first = /^(.{20,200}?[.!?])(?:\s|$)/.exec(line)?.[1];
  return first ?? line;
}

/** Where it stands, at the line's end: the task's state, the answer, who has seen it, or that it was read. */
function LineEnd({ state, f }: { state: SessionState; f: Facts }) {
  if (f.task) return <StatusLine s={f.task.status} />;
  if (f.answer)
    return (
      <span className="ctk-st" data-how={f.answer.short ? "quiet" : "done"}>
        <FaceOf state={state} lane={f.answer.lane} size={14} />
        {f.answer.short ? "Stopped short" : "Answered"}
      </span>
    );
  if (f.status) return <StatusLine s={{ ...f.status, word: f.status.how === "read" ? "Read" : f.status.word }} />;
  if (f.seen)
    return f.seen.lanes.length ? (
      <span className="ctk-st" data-how={f.seen.all ? "read" : "quiet"} title={`Seen by ${names(f.seen.lanes.map((l) => nameOf(state, l, "")))}`}>
        <span className="ctk-seen-faces" aria-hidden="true">
          {f.seen.lanes.slice(0, 3).map((l) => (
            <FaceOf key={l} state={state} lane={l} size={14} />
          ))}
        </span>
        {f.seen.all ? "Seen" : `Seen by ${f.seen.lanes.length}`}
      </span>
    ) : (
      <span className="ctk-st" data-how="quiet">Not seen</span>
    );
  return null;
}

function Row({ state, f }: { state: SessionState; f: Facts }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ctk-card" data-open={open || undefined}>
      <button type="button" className="ctk-line" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <FaceOf state={state} lane={f.from} size={22} />
        <b className="ctk-from">{f.fromName}</b>
        <ToChip state={state} f={f} />
        {f.verb && <span className="ctk-verb">{f.verb}</span>}
        <span className="ctk-sum">{summaryOf(f)}</span>
        <span className="ctk-end">
          <LineEnd state={state} f={f} />
        </span>
        <time className="ctk-time">{clock(f.ts)}</time>
        <ChevronDownIcon className="ctk-chev" aria-hidden="true" />
      </button>
      {open && (
        <div className="ctk-body">
        {f.task ? (
          <>
            {f.text.trim() !== f.task.title && (
              <div className="ctk-text">
                <LazyAnswer text={f.text.trim()} />
              </div>
            )}
            <div className="ctk-task" data-how={f.task.status.how}>
              {f.task.status.how === "done" ? <CircleCheckIcon aria-hidden="true" /> : f.task.status.how === "work" ? <CircleDotIcon aria-hidden="true" /> : <CircleDashedIcon aria-hidden="true" />}
              <span className="ctk-task-title">{f.task.title}</span>
              <span className="ctk-task-st">{f.task.status.word}</span>
            </div>
          </>
        ) : (
          <div className="ctk-text">
            <LazyAnswer text={f.text.trim()} />
          </div>
        )}
        {f.answer && (
          <div className="ctk-thread">
            <span className="ctk-av small">
              <FaceOf state={state} lane={f.answer.lane} size={20} />
            </span>
            <div className="ctk-main">
              <div className="ctk-head">
                <b className="ctk-from">{f.answer.name}</b>
                <span className="ctk-verb">{f.answer.short ? "stopped short" : f.answer.auto ? "answered at the end of its turn" : "replied"}</span>
                {f.answer.ts && <time className="ctk-time">{later(f.ts, f.answer.ts)}</time>}
                {!f.answer.short && <StatusLine s={{ word: "Answered", how: "done" }} />}
              </div>
              <div className="ctk-text small">
                <LazyAnswer text={f.answer.text.trim()} />
              </div>
            </div>
          </div>
        )}
        {f.seen && (
          <div className="ctk-foot">
            <span className="ctk-st" data-how={f.seen.all ? "read" : "quiet"}>
              {f.seen.lanes.length > 0 && (
                <span className="ctk-seen-faces" aria-hidden="true">
                  {f.seen.lanes.slice(0, 4).map((l) => (
                    <FaceOf key={l} state={state} lane={l} size={14} />
                  ))}
                </span>
              )}
              {f.seen.lanes.length ? `Seen by ${names(f.seen.lanes.map((l) => nameOf(state, l, "")))}` : "Not seen yet"}
            </span>
          </div>
        )}
        </div>
      )}
    </div>
  );
}

/** A message folded into the side talk: its face, who to whom, and its words in a line. */
function Mini({ state, f }: { state: SessionState; f: Facts }) {
  return (
    <li className="ctk-mini">
      <FaceOf state={state} lane={f.from} size={18} />
      <span className="ctk-mini-text">
        <b>{f.fromName}</b> <span className="ctk-verb">{f.brief}</span> {plainLine(f.text)}
      </span>
      <time className="ctk-time">{clock(f.ts)}</time>
    </li>
  );
}

export function CrewTalk({ entries, state, delivered, events }: { entries: TalkEntry[]; state: SessionState; delivered: Set<number>; events: readonly SessionEvent[] }) {
  const [open, setOpen] = useState(false);
  const rows = entries.map((e) => ({ key: e.key, facts: e.ev ? factsOf(e.ev, state, delivered, events) : null, node: e.node }));
  const draw = (r: (typeof rows)[number]) => (r.facts ? <Row key={r.key} state={state} f={r.facts} /> : r.node ? <div key={r.key} className="ctk-other">{r.node}</div> : null);
  if (rows.length <= FOLD_OVER) return <section className="ctk" aria-label="The crew talking">{rows.map(draw)}</section>;
  const middle = rows.slice(KEEP, -KEEP);
  const who = [...new Set(middle.map((r) => r.facts?.fromName).filter((n): n is string => !!n))];
  const label = open ? `Hide ${middle.length} messages` : who.length === 1 ? `${who[0]} sent ${middle.length} more messages` : `${names(who.slice(0, 3))}${who.length > 3 ? " and others" : ""} traded ${middle.length} more messages`;
  return (
    <section className="ctk" aria-label="The crew talking">
      {rows.slice(0, KEEP).map(draw)}
      <div className="ctk-fold">
        <button type="button" className="ctk-side" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="ctk-side-faces" aria-hidden="true">
            {[...new Set(middle.map((r) => r.facts?.from).filter((l): l is string => !!l))].slice(0, 3).map((l) => (
              <FaceOf key={l} state={state} lane={l} size={14} />
            ))}
          </span>
          <span>{label}</span>
          <ChevronDownIcon className="ctk-side-chev" aria-hidden="true" />
        </button>
        {open && (
          <ul className="ctk-minis">
            {middle.map((r) => (r.facts ? <Mini key={r.key} state={state} f={r.facts} /> : <li key={r.key} className="ctk-other">{r.node}</li>))}
          </ul>
        )}
      </div>
      {rows.slice(-KEEP).map(draw)}
    </section>
  );
}
