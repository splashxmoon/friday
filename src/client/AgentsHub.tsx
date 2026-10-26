import { shortTokens } from "../tool-usage.js";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { LimitRing } from "./LimitRing.js";
import { hubOf, type AgentStatus, type HubAgent, type HubCheck } from "../agents-hub.js";
import { canDriveLane, type SessionState } from "../session/projection.js";
import { ENGINE_MODEL_INFO, MAIN_LANE, type EngineMode, type Member, type SessionEvent } from "../types.js";
import { fixFailuresText } from "./Activity.js";
import { glanceOf } from "./gauge.js";
import { agentLook } from "./handoff-ui.js";
import { Avatar, Icon, type IconName } from "./icons.js";
import { splitPath } from "./diff-lines.js";
import type { Identity } from "./storage.js";
import { useToolLimits } from "./toolLimits.js";
import { MenuButton, relTime, useConfirm, type MenuItem } from "./ui.js";
import type { Send } from "./useSession.js";

/**
 * The Agents hub: everything the session's agents are doing, and the one place to run them.
 *
 * In the order a person asks: what is each agent doing (a card each: what now, how far through its plan, how long, on which
 * model and mode, how much of its usage is left, a command it wants to run with Run it / Don't, and a menu to pause, stop,
 * reconnect or remove it), then what changed, how the checks went (a failing one with Ask to fix), and the last few things
 * any of them did. A card is a way to that agent: pressing it points the message box at it.
 */
const STATUS: Record<AgentStatus, { icon: IconName | null; word: string }> = {
  working: { icon: null, word: "Working" },
  waiting: { icon: "clock", word: "Needs you" },
  paused: { icon: "pause", word: "Paused" },
  offline: { icon: "plug", word: "Offline" },
  limited: { icon: "clock", word: "Out of usage" },
  failed: { icon: "x", word: "Stopped" },
  done: { icon: "check", word: "Done" },
  ready: { icon: null, word: "Ready" },
};
const MODE: Record<EngineMode, string> = { plan: "Plan", edits: "Manual", full: "Auto" };
const CHECK_LABEL = { tests: "Tests", typecheck: "Typecheck", lint: "Lint", build: "Build" } as const;

/** "0:42", "12:05", "1:02:10": a run's time on a clock, which a ticking number reads best as. */
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
const ago = (ts: number) => (relTime(ts) === "now" ? "now" : `${relTime(ts)} ago`);
const laneArg = (lane: string) => (lane !== MAIN_LANE ? { lane } : {});

export function AgentsHub({
  state,
  events,
  me,
  send,
  identity,
  addAgent,
  onOpenDiff,
}: {
  state: SessionState;
  events: SessionEvent[];
  me: Member;
  send: Send;
  identity: Identity;
  /** The menu for adding an agent, from the session header. */
  addAgent?: ReactNode;
  /** Opens the Diff panel, at this file when there is one. */
  onOpenDiff: (path?: string) => void;
}) {
  const hub = useMemo(() => hubOf(state, events, me.id), [state, events, me.id]);
  const limits = useToolLimits(identity);
  const glance = useMemo(() => glanceOf(limits), [limits]);
  const working = hub.agents.some((a) => a.status === "working");
  // A clock that ticks while something is working, and holds still otherwise.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [working]);
  const mayDrive = (lane: string) => canDriveLane(state, me.id, lane) || me.role === "owner";
  const nameOf = (lane: string) => hub.agents.find((a) => a.lane === lane)?.name ?? "the agent";

  const askToFix = (c: HubCheck) => void send({ type: "instruct", ...laneArg(c.lane), text: fixFailuresText([{ command: c.command, output: c.output }]) });

  return (
    <div className="doc-scroll hub">
      {/* Narrow, one column in the order above. Wide (the panel extended or full screen), the cards sit in a grid and the
          rest in columns beside each other (style.css, @container hub), rather than every row stretching edge to edge. */}
      <div className="hub-wrap">
      <section className="hub-zone hub-zone-agents">
      <h3 className="hub-sec first">
        Agents <b>{hub.agents.length}</b>
      </h3>
      <div className="hub-agents">
        {hub.agents.map((a) => {
          const g = a.tool ? glance[a.tool] : undefined;
          // The limit nearest to running out is the one to show.
          const limit = g?.rows.filter((r) => r.used !== null).sort((x, y) => (y.used ?? 0) - (x.used ?? 0))[0];
          return <AgentCard key={a.lane} a={a} state={state} me={me} send={send} now={now} limit={limit ? { label: limit.label, used: limit.used!, resets: limit.resets } : null} mayDrive={mayDrive(a.lane)} />;
        })}
        {addAgent && (
          // The whole slot opens the add menu; the plus stays the one button, for the keyboard and screen readers.
          <div
            className="hub-add"
            onClick={(e) => {
              if ((e.target as Element).closest("button, [role=menu]")) return;
              e.currentTarget.querySelector<HTMLButtonElement>(".agent-plus")?.click();
            }}
          >
            <span className="hub-add-text">
              <b>Add another agent</b>
              <span>Run Codex, Cursor or another tool beside it, each as an agent of its own.</span>
            </span>
            {addAgent}
          </div>
        )}
      </div>
      </section>

      <div className="hub-cols">
      <section className="hub-zone hub-zone-changes">
      <h3 className="hub-sec">
        Changes {hub.files.length > 0 && <b>{hub.files.length}</b>}
        {hub.files.length > 0 && (
          <button type="button" className="hub-sec-act" onClick={() => onOpenDiff()}>
            Review all
          </button>
        )}
      </h3>
      {hub.files.length ? (
        <ul className="hub-files">
          {hub.files.map((f) => {
            const { dir, name } = splitPath(f.path);
            return (
              <li key={f.path}>
                <button type="button" className="hub-file" title={`${f.path}${f.lanes.length > 1 ? " · changed by more than one agent" : ""}`} onClick={() => onOpenDiff(f.path)}>
                  <Icon name="file" size={13} />
                  <span className="hub-file-name">{name}</span>
                  {dir && <span className="hub-file-dir">{dir.replace(/\/$/, "")}</span>}
                  {f.lanes.length > 1 && <span className="hub-file-both" aria-label="Changed by more than one agent">{f.lanes.length}</span>}
                  <span className="hub-num add">+{f.adds}</span>
                  <span className="hub-num del">−{f.dels}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="hub-none">Nothing changed yet. What the agents change shows up here, a line a file.</p>
      )}
      </section>

      <section className="hub-zone hub-zone-checks">
      <h3 className="hub-sec">Checks</h3>
      {hub.checks.length ? (
        <ul className="hub-checks">
          {hub.checks.map((c) => (
            <li key={c.kind} className={c.ok ? "ok" : "bad"} title={c.command}>
              <Icon name={c.ok ? "check" : "x"} size={13} />
              <span className="hub-check-name">{CHECK_LABEL[c.kind]}</span>
              <span className="hub-check-cmd">{c.command}</span>
              <span className="hub-check-sum">{c.summary}</span>
              {mayDrive(c.lane) &&
                (c.ok ? (
                  <button type="button" className="hub-row-act" title={`Ask ${nameOf(c.lane)} to run ${c.command} again`} onClick={() => void send({ type: "instruct", ...laneArg(c.lane), text: `Run \`${c.command}\` again and tell me how it went.` })}>
                    Re-run
                  </button>
                ) : (
                  <button type="button" className="hub-row-act" title={`Hand ${nameOf(c.lane)} what failed`} onClick={() => askToFix(c)}>
                    Ask to fix
                  </button>
                ))}
            </li>
          ))}
        </ul>
      ) : (
        <p className="hub-none">No tests or checks have run yet. When an agent runs them, how they came out shows here.</p>
      )}
      </section>

      {hub.recent.length > 0 && (
        <section className="hub-zone hub-zone-recent">
          <h3 className="hub-sec">Recent activity</h3>
          <ul className="hub-recent">
            {hub.recent.map((s, i) => (
              <li key={i} className={s.failed ? "bad" : ""}>
                <span className="hub-recent-mark">{agentLook(state, s.lane, 12).mark}</span>
                <span className="hub-recent-text">{s.text}</span>
                <span className="hub-recent-time">{ago(s.ts)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      </div>
      </div>
    </div>
  );
}

function AgentCard({ a, state, me, send, now, limit, mayDrive }: { a: HubAgent; state: SessionState; me: Member; send: Send; now: number; limit: { label: string; used: number; resets: string } | null; mayDrive: boolean }) {
  const look = agentLook(state, a.lane, 15);
  const s = STATUS[a.status];
  const [ask, confirmUI] = useConfirm();
  const focus = () => window.dispatchEvent(new CustomEvent("friday:focus-lane", { detail: { lane: a.lane } }));
  const answer = (approve: boolean) =>
    void send({ type: "instruct", ...laneArg(a.lane), text: approve ? (a.ask!.scope === "commands" ? "Yes, run it." : "Yes, go ahead.") : "No, don't.", approval: { id: a.ask!.id, approve }, quiet: true });
  // Plan progress when it has a plan; otherwise full when it finished, empty when it hasn't started, moving while it works.
  const pct = a.plan ? (a.plan.done / Math.max(1, a.plan.total)) * 100 : a.status === "done" ? 100 : 0;
  // Running time while it works; how long the run took once it is done or stopped; nothing otherwise, where a number would read as live.
  const time = !a.startedAt ? "" : a.status === "working" ? clock(now - a.startedAt) : (a.status === "done" || a.status === "failed") && a.endedAt ? clock(a.endedAt - a.startedAt) : "";
  const model = a.model ? (a.tool ? (ENGINE_MODEL_INFO[a.tool]?.find((m) => m.id === a.model)?.label ?? a.model) : a.model) : "Default model";
  const meta = [a.tool ? model : null, a.mode ? MODE[a.mode] : null, a.branch, a.tokens ? `${shortTokens(a.tokens)} tokens` : null].filter(Boolean).join(" · ");
  const items = (): MenuItem[] => [
    { label: "Write to it", icon: "message", onSelect: focus },
    ...(mayDrive && a.status === "working" ? [{ label: "Stop this task", icon: "pause" as const, onSelect: () => void send({ type: "run.pause", ...laneArg(a.lane) }) }] : []),
    ...(mayDrive && a.status === "paused" ? [{ label: "Resume", icon: "play" as const, onSelect: () => void send({ type: "run.resume", ...laneArg(a.lane) }) }] : []),
    ...(mayDrive && (a.status === "working" || a.status === "paused" || a.status === "waiting") ? [{ label: "Stop this run", icon: "stop" as const, onSelect: () => void send({ type: "run.cancel", ...laneArg(a.lane) }) }] : []),
    ...(a.status === "offline" && state.engines[a.lane]?.hostId === me.id ? [{ label: "Reconnect", icon: "refresh" as const, onSelect: () => window.dispatchEvent(new CustomEvent("friday:reconnect-lane", { detail: { lane: a.lane } })) }] : []),
    ...(me.role === "owner" || me.role === "editor"
      ? [
          {
            label: "Rename",
            icon: "pencil" as const,
            onSelect: () =>
              ask({
                title: `Rename ${a.name}`,
                body: "Everyone in the session sees the new name, in the chat and here.",
                action: "Rename",
                danger: false,
                input: { label: "Agent name", value: a.name, maxLength: 40 },
                onConfirm: async (name) => {
                  const r = await send({ type: "lane.rename", laneId: a.lane, name });
                  if (!r.ok) throw new Error(r.error ?? "Couldn't rename the agent.");
                },
              }),
          },
        ]
      : []),
    ...(a.lane !== MAIN_LANE && me.role === "owner"
      ? [
          {
            label: "Remove from the session",
            icon: "trash" as const,
            danger: true,
            onSelect: () => ask({ title: `Remove ${a.name}?`, body: "It stops and leaves this session. Its changes stay in the folder.", action: "Remove agent", onConfirm: () => void send({ type: "lane.remove", laneId: a.lane }) }),
          },
        ]
      : []),
  ];
  return (
    <article
      className={`hub-card ${a.status}`}
      style={{ "--tint": look.tint } as React.CSSProperties}
      tabIndex={0}
      aria-label={`${a.name}: ${s.word}. ${a.line}`}
      onClick={focus}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) focus();
      }}
    >
      {confirmUI}
      <div className="hub-card-top">
        <span className="hub-mark">{look.mark}</span>
        <span className="hub-card-id">
          <span className="hub-name">{a.name}</span>
          {meta && <span className="hub-meta">{meta}</span>}
        </span>
        {/* Resume says itself and stays in view: a paused agent waits for exactly this. Pause is a quiet icon beside it. */}
        {mayDrive && a.status === "paused" && (
          <button type="button" className="btn small hub-resume" onClick={(e) => (e.stopPropagation(), void send({ type: "run.resume", ...laneArg(a.lane) }))}>
            <Icon name="play" size={11} /> Resume
          </button>
        )}
        {mayDrive && a.status === "working" && (
          <button type="button" className="icon-btn tiny hub-act" aria-label={`Stop ${a.name}'s task`} title="Stop this task (it stays free for the next one)" onClick={(e) => (e.stopPropagation(), void send({ type: "run.pause", ...laneArg(a.lane) }))}>
            <Icon name="pause" size={12} />
          </button>
        )}
        <span onClick={(e) => e.stopPropagation()}>
          <MenuButton label={`Manage ${a.name}`} items={items} width={220} end />
        </span>
        {a.driver && (
          <span className="hub-driver" title={`${a.driver.name} is driving`}>
            <Avatar name={a.driver.name} id={a.driver.id} size={20} />
          </span>
        )}
      </div>
      <div className="hub-line">
        {a.status === "working" ? <span className="hub-spin" aria-hidden /> : s.icon ? <Icon name={s.icon} size={13} /> : <span className="hub-dot" aria-hidden />}
        <span className="hub-line-text" title={a.line}>
          {a.line}
        </span>
        {a.plan && a.status !== "done" && <span className="hub-steps">{a.plan.done}/{a.plan.total}</span>}
        {time && <span className="hub-time">{time}</span>}
      </div>
      <div className={`hub-bar ${a.status === "working" && !a.plan ? "busy" : ""}`} role="progressbar" aria-label={`${a.name}: ${s.word}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        <i style={{ width: `${pct}%` }} />
      </div>
      {mayDrive && a.ask && (
        <div className="hub-ask" onClick={(e) => e.stopPropagation()}>
          <code title={a.ask.items.join("\n")}>{a.ask.items[0] ?? "a command"}</code>
          <button type="button" className="btn small" onClick={() => answer(false)}>
            Don't
          </button>
          <button type="button" className="btn primary small" onClick={() => answer(true)}>
            {a.ask.scope === "commands" ? "Run it" : "Allow"}
          </button>
        </div>
      )}
      {limit && (
        <div className={`hub-limit ${limit.used >= 90 ? "low" : limit.used >= 70 ? "mid" : ""}`} title={limit.resets}>
          <LimitRing used={limit.used} size={22} showValue={false} label={`${limit.label} limit`} />
          <span>{limit.label} limit</span>
          <span className="hub-limit-n">{Math.round(limit.used)}% used</span>
        </div>
      )}
    </article>
  );
}
