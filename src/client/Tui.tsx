import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MAIN_LANE, ENGINE_NAMES, TOOL_INFO, type EngineTool, type SessionEvent } from "../types.js";
import { questionsTo, runOf, type SessionState } from "../session/projection.js";
import type { Send } from "./useSession.js";
import { useLaneStream } from "./useSession.js";
import { stepFor } from "./Response.js";
import { answerRights } from "./Activity.js";

/**
 * Friday's own terminal view of one agent, for every coding tool and Friday's own (Arun, 2026-10-30: "lets add a custom TUI
 * for like all of the coding tools i want this to be cool and fun"). Drawn from the session, so nothing is held and the agent
 * carries on as it would: what it said, each step as a line with what came back, edits as red and green, a spinner with a
 * word of its own while it works, its questions and permission asks as menus to arrow through, and a prompt at the foot.
 * Keyboard first: ⏎ sends, esc stops it, ↑ brings back your last message, / for the few commands it has.
 */

type Line = { lane: string } & (
  | { k: "you"; key: string; who: string; mine: boolean; text: string }
  | { k: "say"; key: string; text: string }
  | { k: "step"; key: string; verb: string; target: string; call: string; minus: string[]; plus: string[] }
  | { k: "end"; key: string; text: string; bad: boolean }
  | { k: "sys"; key: string; text: string }
);

/** The words the spinner says while it works: one per turn, the same each time that turn is drawn. */
const MOODS = ["Thinking", "Noodling", "Tinkering", "Percolating", "Scheming", "Wrangling", "Brewing", "Conjuring", "Pondering", "Hatching", "Untangling", "Whittling", "Simmering", "Plotting"];
const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
/** FRIDAY in quarter blocks: three rows, drawn once at the top of the view. */
const BANNER = ["▄▀▀ █▀▄ █ █▀▄ ▄▀▄ ▀▄▀", "█▀  █▀▄ █ █ █ █▀█  █ ", "▀   ▀ ▀ ▀ ▀▀  ▀ ▀  ▀ "];

const parse = (raw: string): Record<string, unknown> => {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
};
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const lines = (s: unknown, n: number) => (typeof s === "string" && s ? s.split("\n").slice(0, n) : []);
const dur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

/** The lane's story as terminal lines, from its last few hundred events. */
export function tuiLines(events: SessionEvent[], lanes: string[], me: string, from = 0): Line[] {
  const shown = new Set(lanes);
  const mine = events.filter((e) => shown.has(e.lane ?? MAIN_LANE) && e.seq >= from).slice(-600);
  const out: Line[] = [];
  const startedAt = new Map<string, number>();
  for (const e of mine) {
    const b = e.body;
    const lane = e.lane ?? MAIN_LANE;
    const started = startedAt.get(lane) ?? 0;
    if (b.type === "instruction") {
      // A yes or no to a permission ask is said by the menu that asked it; Friday's own carry-on is a quiet line.
      if (b.approval) continue;
      if (b.keepGoing) {
        out.push({ lane, k: "sys", key: `s${e.seq}`, text: "↻ carrying on with the task" });
        continue;
      }
      out.push({ lane, k: "you", key: `y${e.seq}`, who: e.actor.name, mine: e.actor.id === me, text: b.text });
    } else if (b.type === "run.started") startedAt.set(lane, e.ts);
    else if (b.type === "agent.message") {
      if (b.text.trim()) out.push({ lane, k: "say", key: `a${e.seq}`, text: b.text.trim() });
      for (const c of b.toolCalls) {
        const args = parse(c.arguments);
        const s = stepFor(c, args);
        const minus = lines(args.old_string ?? args.oldText, 8);
        const plus = lines(args.new_string ?? args.newText ?? (c.name.toLowerCase().includes("write") ? args.content : undefined), 8);
        out.push({ lane, k: "step", key: `c${c.id}`, verb: s.verb, target: s.target ?? "", call: c.id, minus, plus });
      }
    } else if (b.type === "run.ended") {
      const took = started ? ` for ${dur(e.ts - started)}` : "";
      startedAt.delete(lane);
      if (b.outcome === "error") out.push({ lane, k: "end", key: `e${e.seq}`, text: `✗ Stopped${took}: ${clip((b.error ?? "").split("\n")[0] ?? "", 140)}`, bad: true });
      else if (b.outcome === "waiting") out.push({ lane, k: "end", key: `e${e.seq}`, text: `✻ Waiting on you, after ${took.replace(" for ", "") || "a moment"}`, bad: false });
      else out.push({ lane, k: "end", key: `e${e.seq}`, text: `✻ Worked${took}`, bad: false });
    } else if (b.type === "run.pause") out.push({ lane, k: "sys", key: `p${e.seq}`, text: `⏹ ${e.actor.id === me ? "You" : e.actor.name} stopped it` });
  }
  return out;
}

/** An agent's name and colour, as the TUI tags it. */
function who(state: SessionState, lane: string): { name: string; tint: string; tool?: EngineTool } {
  const tool = state.engines[lane]?.tool;
  const named = lane === MAIN_LANE ? null : state.lanes.find((l) => l.id === lane)?.name;
  return { name: named ?? (tool ? ENGINE_NAMES[tool] : "Friday"), tint: tool ? TOOL_INFO[tool].tint : "var(--live)", ...(tool ? { tool } : {}) };
}

/** One working agent's live line: what it is writing as it writes it, or its spinner and its word for the turn. */
function Live({ sid, lane, state, events, tag, tick, still }: { sid: string; lane: string; state: SessionState; events: SessionEvent[]; tag: React.ReactNode; tick: number; still: boolean }) {
  const stream = useLaneStream(sid, lane);
  const run = runOf(state, lane);
  const text = stream?.text?.trim();
  const since = events.find((e) => e.seq === run.sinceSeq)?.ts ?? Date.now();
  if (text)
    return (
      <div className="ftui-say">
        {tag}
        <span className="ftui-dot say">●</span> {text}
        <span className="ftui-caret" aria-hidden>
          █
        </span>
      </div>
    );
  return (
    <div className="ftui-spin" role="status">
      {tag}
      <span className="ftui-spinner">{still ? "✻" : SPIN[tick % SPIN.length]}</span> {MOODS[(run.sinceSeq ?? 0) % MOODS.length]}… <span className="ftui-dim">({dur(Date.now() - since)} · esc to stop)</span>
    </div>
  );
}

/**
 * `lanes`: the agents shown, one or (All agents) every one, each line tagged with whose it is when there are several. `to`: who
 * the prompt writes to; with several, Tab moves it to the next (`onTo`).
 */
export function FridayTui({
  sid,
  lanes,
  to,
  onTo,
  state,
  events,
  me,
  send,
  notify,
  cwd,
  onChat,
  onNative,
}: {
  sid: string;
  lanes: string[];
  to: string;
  onTo?: (lane: string) => void;
  state: SessionState;
  events: SessionEvent[];
  me: { id: string; name: string; role: "owner" | "editor" | "viewer" };
  send: Send;
  notify: (text: string) => void;
  cwd?: string;
  onChat: () => void;
  /** The tool's own screen on this conversation, where it has one (Claude Code, Codex). */
  onNative?: () => void;
}) {
  const many = lanes.length > 1;
  const target = who(state, to);
  const engine = state.engines[to];
  // "/clear": the view starts from here; nothing is taken out of the session.
  const [from, setFrom] = useState(0);
  const [local, setLocal] = useState<string[]>([]);
  const lanesKey = lanes.join(",");
  const view = useMemo(() => tuiLines(events, lanes, me.id, from), [events, lanesKey, me.id, from]); // eslint-disable-line react-hooks/exhaustive-deps
  const results = useMemo(() => {
    const shown = new Set(lanes);
    const m = new Map<string, { text: string; bad: boolean; n: number }>();
    for (const e of events) if (e.body.type === "tool.result" && shown.has(e.lane ?? MAIN_LANE)) m.set(e.body.callId, { text: (e.body.output.split("\n").find((l) => l.trim()) ?? "").trim(), bad: e.body.isError, n: e.body.output.split("\n").length });
    return m;
  }, [events, lanesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const running = lanes.filter((l) => runOf(state, l).status === "running");
  const [tick, setTick] = useState(0);
  const still = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  useEffect(() => {
    if (!running.length) return;
    const t = setInterval(() => setTick((n) => n + 1), 90);
    return () => clearInterval(t);
  }, [running.length]);
  const tag = (lane: string) => {
    if (!many) return null;
    const w = who(state, lane);
    return (
      <span className="ftui-tag" style={{ color: w.tint }}>
        {w.name}
      </span>
    );
  };

  // What waits on you here: a permission ask, then a question, from whichever agent asked first.
  const askLane = lanes.find((l) => state.approvals[l] && answerRights(state, me, l, state.approvals[l]!).waiting);
  const ask = askLane ? state.approvals[askLane]! : undefined;
  const askEv = ask ? (events.find((e) => e.body.type === "engine.approval" && e.body.id === ask.id) as SessionEvent | undefined) : undefined;
  const rights = ask && askLane ? answerRights(state, me, askLane, ask) : null;
  const question = questionsTo(state, me.id).find((q) => lanes.includes(q.lane));
  const say = async (t: string, lane = to) => {
    const r = await send({ type: "instruct", text: t, lane, interrupt: false });
    if (!r.ok) notify(r.error ?? "That didn't send. Try again.");
  };
  const menu: { title: string; detail?: string; options: { label: string; act: () => void }[] } | null =
    ask && askLane && rights
      ? {
          title: ask.scope === "commands" ? `${who(state, askLane).name} wants to run` : `${who(state, askLane).name} wants to make changes`,
          detail: [ask.items.slice(0, 3).join("\n"), askEv?.body.type === "engine.approval" ? askEv.body.why : ""].filter(Boolean).join("\n"),
          options: rights.hostWait
            ? []
            : [true, false].map((yes) => ({
                label: yes ? (ask.scope === "commands" ? "Yes, run it" : "Yes, go ahead") : "No, and tell it what to do instead",
                act: () =>
                  void send(rights.viaInstruct ? { type: "instruct", lane: askLane, text: yes ? "Yes, go ahead." : "No, don't.", approval: { id: ask.id, approve: yes }, quiet: true } : { type: "approval.answer", lane: askLane, id: ask.id, approve: yes, quiet: true }).then((r) => !r.ok && notify(r.error ?? "Couldn't send that.")),
              })),
        }
      : question
        ? {
            title: many ? `${who(state, question.lane).name} asks: ${question.question}` : question.question,
            ...(question.detail ? { detail: question.detail } : {}),
            options: (question.options ?? []).map((o) => ({ label: o === question.recommended ? `${o}  (recommended)` : o, act: () => void say(o, question.lane) })),
          }
        : null;
  const [pick, setPick] = useState(0);
  useEffect(() => setPick(0), [menu?.title]);

  // The prompt.
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const stop = (lane = to) => void send({ type: "run.pause", ...(lane !== MAIN_LANE ? { lane } : {}) });
  const lastMine = () => [...events].reverse().find((e) => e.body.type === "instruction" && (e.lane ?? MAIN_LANE) === to && e.actor.id === me.id && !e.body.approval);
  const HELP = ["/help      this list", "/stop      stop what it's doing (or esc)", "/clear     start the view from here", "/chat      back to the chat view", ...(many ? ["tab        write to the next agent"] : []), ...(onNative ? [`/native    ${target.name}'s own screen, on this conversation`] : [])];
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    if (t.startsWith("/")) {
      const cmd = t.split(/\s+/)[0]!.toLowerCase();
      if (cmd === "/help") return setLocal((l) => [...l, ...HELP]);
      if (cmd === "/stop") return stop();
      if (cmd === "/clear") return (setFrom((events.at(-1)?.seq ?? 0) + 1), setLocal([]));
      if (cmd === "/chat") return onChat();
      if (cmd === "/native" && onNative) return onNative();
    }
    void say(t);
  };
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu && menu.options.length && !text) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        return setPick((p) => (p + (e.key === "ArrowDown" ? 1 : -1) + menu.options.length) % menu.options.length);
      }
      const n = Number(e.key);
      if (n >= 1 && n <= menu.options.length) return (e.preventDefault(), menu.options[n - 1]!.act());
      if (e.key === "Enter" && !e.shiftKey) return (e.preventDefault(), menu.options[pick]!.act());
    }
    if (e.key === "Tab" && many && onTo && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const i = lanes.indexOf(to);
      return onTo(lanes[(i + (e.shiftKey ? -1 : 1) + lanes.length) % lanes.length]!);
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) return (e.preventDefault(), submit());
    if (e.key === "Escape" && running.length) return (e.preventDefault(), stop(running.includes(to) ? to : running[0]));
    if (e.key === "ArrowUp" && !text) {
      const last = lastMine();
      if (last?.body.type === "instruction") (e.preventDefault(), setText(last.body.text));
    }
  };

  // Kept at the foot as it grows, unless you scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => box.current?.focus(), [lanesKey]);
  // The box grows with what is typed, up to a few lines.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [text]);

  // The folder by its last two parts: the whole path ran the status line onto a second row.
  const full = (cwd ?? engine?.cwd ?? "").replace(/^\/(Users|home)\/[^/]+/, "~");
  const parts = full.split(/[\\/]/).filter(Boolean);
  const where = many ? "" : parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : full;
  const workingNow = running.length;
  const firstSince = running.length ? (events.find((e) => e.seq === runOf(state, running[0]!).sinceSeq)?.ts ?? Date.now()) : 0;
  return (
    <div className="ftui" style={{ "--ftui-tint": target.tint } as React.CSSProperties} onClick={(e) => (e.target as HTMLElement).closest("button, a, textarea") || window.getSelection()?.toString() || box.current?.focus()}>
      <div className="ftui-bar">
        <span className="ftui-chip">{many ? "All agents" : target.name}</span>
        {where && (
          <span className="ftui-dim ftui-where" title={full}>
            {where}
          </span>
        )}
        {!many && engine?.branch && <span className="ftui-dim">⎇ {engine.branch}</span>}
        {many && <span className="ftui-dim">{lanes.length} agents</span>}
        <span className={`ftui-state ${workingNow ? "on" : ""}`}>{workingNow ? (many ? `● ${workingNow} working` : `● working ${dur(Date.now() - firstSince)}`) : menu ? "● needs you" : "○ idle"}</span>
        <span className="ftui-grow" />
        {onNative && (
          <button type="button" className="ftui-link" onClick={onNative} title={`${target.name}'s own screen, on this conversation. Friday holds its turns while it's open.`}>
            {target.tool === "codex" ? "codex" : "claude"} ↗
          </button>
        )}
      </div>
      <div
        className={`ftui-screen${many ? " many" : ""}`}
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        role="log"
        aria-live="polite"
        aria-label={many ? "Every agent, as a terminal" : `${target.name}, as a terminal`}
      >
        <pre className="ftui-banner" aria-hidden>
          {BANNER.join("\n")}
        </pre>
        <div className="ftui-dim ftui-hello">
          Friday TUI · {many ? `${lanes.length} agents · tab to pick who you write to` : target.name}
          {where ? ` · ${where}` : ""} · /help
        </div>
        {view.map((l) =>
          l.k === "you" ? (
            <div key={l.key} className="ftui-you">
              {tag(l.lane)}
              <span className="ftui-prompt">{l.mine ? "❯" : `${l.who.split(/\s+/)[0]} ❯`}</span> {l.text}
            </div>
          ) : l.k === "say" ? (
            <div key={l.key} className="ftui-say">
              {tag(l.lane)}
              <span className="ftui-dot say">●</span> {l.text}
            </div>
          ) : l.k === "step" ? (
            <div key={l.key} className="ftui-step">
              <div>
                {tag(l.lane)}
                <span className={`ftui-dot ${results.get(l.call)?.bad ? "bad" : results.has(l.call) ? "ok" : "run"}`}>●</span> <b>{l.verb}</b>
                {l.target && <span className="ftui-target">({clip(l.target, 120)})</span>}
              </div>
              {(l.minus.length > 0 || l.plus.length > 0) && (
                <div className="ftui-diff">
                  {l.minus.map((m, i) => (
                    <div key={`m${i}`} className="minus">
                      - {m}
                    </div>
                  ))}
                  {l.plus.map((p, i) => (
                    <div key={`p${i}`} className="plus">
                      + {p}
                    </div>
                  ))}
                </div>
              )}
              {results.has(l.call) && (
                <div className={`ftui-out ${results.get(l.call)!.bad ? "bad" : ""}`}>
                  ⎿ {clip(results.get(l.call)!.text || "(no output)", 140)}
                  {results.get(l.call)!.n > 1 && <span className="ftui-dim"> … {results.get(l.call)!.n} lines</span>}
                </div>
              )}
            </div>
          ) : (
            <div key={l.key} className={l.k === "end" ? `ftui-end ${l.bad ? "bad" : ""}` : "ftui-dim ftui-sys"}>
              {tag(l.lane)}
              {l.text}
            </div>
          ),
        )}
        {local.map((t, i) => (
          <div key={`l${i}`} className="ftui-dim ftui-sys">
            {t}
          </div>
        ))}
        {running.map((l) => (
          <Live key={l} sid={sid} lane={l} state={state} events={events} tag={tag(l)} tick={tick} still={still} />
        ))}
        {menu && (
          <div className="ftui-menu" role="listbox" aria-label={menu.title}>
            <div className="ftui-menu-title">{menu.title}</div>
            {menu.detail && <pre className="ftui-menu-detail">{menu.detail}</pre>}
            {rights?.hostWait && <div className="ftui-dim">Only {rights.hostWait} can say yes to this, on their computer.</div>}
            {menu.options.map((o, i) => (
              <button key={o.label} type="button" role="option" aria-selected={i === pick} className={`ftui-opt ${i === pick ? "on" : ""}`} onClick={o.act} onMouseEnter={() => setPick(i)}>
                {i === pick ? "❯" : " "} {i + 1}. {o.label}
              </button>
            ))}
            {question && <div className="ftui-dim">or type your own answer below</div>}
          </div>
        )}
      </div>
      <div className="ftui-input">
        {many && (
          <span className="ftui-to" style={{ color: target.tint }} title="Tab to write to the next agent">
            {target.name}
          </span>
        )}
        <span className="ftui-prompt">❯</span>
        <textarea
          ref={box}
          rows={1}
          value={text}
          spellCheck={false}
          placeholder={me.role === "viewer" ? "You're watching this session" : menu && menu.options.length ? "↑↓ to pick, ⏎ to answer, or type" : runOf(state, to).status === "running" ? `Tell ${target.name} something; it reads it at its next step` : `Tell ${target.name} what to do`}
          disabled={me.role === "viewer"}
          aria-label={`Message ${target.name}`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
      </div>
      <div className="ftui-keys ftui-dim">⏎ send · ⇧⏎ new line · esc stop{many ? " · tab next agent" : ""} · ↑ last message · /help</div>
    </div>
  );
}
