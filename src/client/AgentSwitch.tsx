import { useEffect, useRef, useState } from "react";
import type { Plan } from "../plan-types.js";
import { AgentModelPicker, type EffortChoice } from "./AgentModelPicker.js";
import { createPortal } from "react-dom";
import { can, runOf, type SessionState } from "../session/projection.js";
import { ENGINE_NAMES, ENGINE_TOOLS, MAIN_LANE, type EngineTool, type Member, type SessionEvent, type Thinking } from "../types.js";
import { EngineMark } from "./BrandMarks.js";
import { Icon } from "./icons.js";
import { hostApi, useMachine } from "./local.js";
import { carryInto } from "./carried.js";
import { quickConnect } from "./quickConnect.js";
import type { Identity } from "./storage.js";
import { MoreTools, placeCard, useDismiss } from "./ui.js";
import { splitTools } from "./engines.js";

/**
 * Who works in this folder, changed in one press.
 *
 * Friday Code, and the Claude Code, Codex or Cursor already on the host's
 * machine, are four answers to the same question — so they are one list, not a
 * dialog behind a menu behind a settings page. Choosing one that is ready
 * restarts the host's runner on the same folder, the same lane and the same
 * permissions, so nothing is re-picked and nothing is lost: the files, the
 * terminal, the diff and the conversation stay exactly where they were.
 *
 * One that is not ready says why in the row — "log in", "not installed" — and
 * pressing it goes to the setup that fixes exactly that, rather than a failure.
 */

export { EngineMark };

type SwitchProps = {
  state: SessionState;
  me: Member;
  identity: Identity;
  sid: string;
  invite: string;
  lane: string;
  /** The session's log: bringing a tool in on a lane of its own reads what it can carry on from. */
  events?: SessionEvent[];
  notify: (m: string) => void;
  /** Opens the connect dialog, on this tool if one was chosen ("" is just a folder for Friday Code). */
  onSetup?: (lane: string, tool?: EngineTool | "") => void;
  /** What the picker needs to be the model's picker as well: the plan, and what to do when Friday's model or reasoning is chosen. */
  plan: Plan;
  onFridayModel: (id: string) => void;
  onThinking: (t: Thinking) => void;
  /** This lane's effort, as a column of the picker (effortChoice in Activity.tsx); null when its tool takes none. */
  effort?: EffortChoice | null;
};

/** Whether this person can rewire this lane from here, which is when the one picker for the agent and its model is shown. */
export function switchesAgent(p: Pick<SwitchProps, "state" | "me" | "lane" | "onSetup">): boolean {
  const engine = p.state.engines[p.lane];
  // Only the person whose machine it is can rewire it, and with no folder yet
  // the pill is the way to start one — for the session's owner, on its main lane.
  const hosts = !!engine && engine.hostId === p.me.id && engine.online;
  // A lane that carries an agent built in Friday can be moved onto the person's own coding tool too, which then runs that agent's instructions.
  const savedAgentLane = p.lane !== MAIN_LANE && !!p.state.lanes.find((l) => l.id === p.lane)?.agent;
  const starting = !engine && (p.lane === MAIN_LANE || savedAgentLane) && p.me.role === "owner" && !!p.onSetup;
  return hosts || starting;
}

export function AgentSwitch(props: SwitchProps) {
  if (switchesAgent(props)) return <Switch {...props} />;
  // Anybody else who can steer has their own agents to bring — theirs, on their
  // machine, under their account. Not shown to someone who already has one in
  // the session (their own pill is the switch above) or who is only watching.
  const hasOwn = Object.values(props.state.engines).some((e) => e.hostId === props.me.id);
  const mayBring = props.me.role !== "viewer" && can(props.state, props.me.id, "control") && !hasOwn && !!props.onSetup;
  return mayBring ? <Bring identity={props.identity} onSetup={props.onSetup!} /> : null;
}

/**
 * A teammate's own agents: the Claude Code, Codex or Cursor on *their* machine,
 * signed in as *them*. What is listed, and whether each is ready, comes from
 * their computer and their accounts — not from the host's. Choosing one opens
 * the dialog that connects it as a lane of their own.
 */
function Bring({ identity, onSetup }: { identity: Identity; onSetup: (lane: string, tool?: EngineTool | "") => void }) {
  const { state: machine } = useMachine(identity);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const status = (tool: EngineTool): { ready: boolean; word: string } => {
    if (machine.mode === "checking") return { ready: false, word: "checking…" };
    if (machine.mode === "none") return { ready: false, word: "connect this computer" };
    const found = machine.tools.find((t) => t.tool === tool);
    if (!found?.path) return { ready: false, word: "not installed" };
    if (found.loggedIn === false) return { ready: false, word: "log in" };
    return { ready: true, word: "ready" };
  };

  function Panel() {
    useDismiss(pop, () => setOpen(false), btn.current);
    const [more, setMore] = useState(false);
    const r = btn.current?.getBoundingClientRect();
    if (!r) return null;
    const place = placeCard(r, 320, { want: 260, min: 160, prefer: "above" });
    const known = machine.mode !== "checking" && machine.mode !== "none";
    const { here, away } = splitTools(known ? (t) => !!machine.tools.find((x) => x.tool === t)?.path : null);
    return createPortal(
      <div ref={pop} className="model-pop one-col agent-switch-pop" style={place} role="dialog" aria-label="Bring your own agent">
        <div className="model-pop-col models">
          <div className="model-pop-head">Bring your own agent</div>
          <div className="model-pop-group">
            {[...here, ...(more ? away : [])].map((t) => {
              const s = status(t);
              return (
                <button
                  key={t}
                  type="button"
                  className={`model-pop-row ${s.ready ? "" : "needs-setup"}`}
                  onClick={() => {
                    setOpen(false);
                    // Ready or not, the dialog is where it is connected, signed in or installed.
                    onSetup("", t);
                  }}
                >
                  <span className="model-pop-mark" aria-hidden>
                    <EngineMark tool={t} size={15} />
                  </span>
                  <span className="model-pop-name">{ENGINE_NAMES[t]}</span>
                  <span className="model-pop-meta">{s.word}</span>
                </button>
              );
            })}
            <MoreTools open={more} count={away.length} onToggle={() => setMore((v) => !v)} className="model-pop-row" />
          </div>
          <p className="model-pop-note">It runs on your computer under your own account, as an agent of its own that only you drive. Everyone here can watch it work.</p>
        </div>
      </div>,
      document.body,
    );
  }

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`menu-pill agent-pill agent-switch ${open ? "on" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Bring your own agent"
        title="Use your own coding tool, from your own account"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="agent-switch-mark">
          <Icon name="plug" size={14} />
        </span>
        Your agent
        <Icon name="chevronDown" size={13} className="menu-pill-caret" />
      </button>
      {open && <Panel />}
    </>
  );
}

function Switch({ state, me, identity, sid, invite, lane, events = [], notify, onSetup, plan, onFridayModel, onThinking, effort }: SwitchProps) {
  const engine = state.engines[lane];
  const current: EngineTool | "" = engine?.tool ?? "";
  const { state: machine } = useMachine(identity);
  const [busy, setBusy] = useState(false);
  // Swapping replaces the running agent, which would cut a turn off mid-step.
  const running = runOf(state, lane).status === "running";

  const status = (tool: EngineTool): { ready: boolean; word: string } => {
    if (machine.mode === "checking") return { ready: false, word: "checking…" };
    const found = machine.tools.find((t) => t.tool === tool);
    if (!found?.path) return { ready: false, word: "not installed" };
    if (found.loggedIn === false) return { ready: false, word: "log in" };
    return { ready: true, word: found.source === "claude-app" ? "Claude app" : "ready" };
  };

  const swap = async (tool: EngineTool | "", model = "") => {
    if (!engine || busy) return;
    setBusy(true);
    try {
      // The same call a restart to change permissions makes, with a different
      // agent or model: the host's runner replaces itself on the same folder and lane.
      await hostApi(identity, "/api/runner/start", {
        method: "POST",
        body: JSON.stringify({ sid, invite, ...(tool ? { tool } : {}), cwd: engine.cwd, mode: engine.mode, lane, ...(model ? { model } : {}) }),
      });
      notify(`Now working with ${tool ? ENGINE_NAMES[tool] : "Friday Code"}${model ? ` · ${model}` : ""}`);
    } catch (e) {
      notify(`Couldn't switch: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Another coding tool, once this one has done some work: brought in on a lane of its own, on the same code, rather than put
   * in this one's place. Swapping in place threw away which tool did what, and the new one started blind on a lane whose
   * history it hadn't seen. The box moves to the new lane, and the first message there goes as a handoff (carried.ts).
   */
  const [joining, setJoining] = useState<{ tool: EngineTool; before: Set<string> } | null>(null);
  const worked = runOf(state, lane).sinceSeq > 0;
  const bringIn = (tool: EngineTool) => {
    setJoining({ tool, before: new Set(state.lanes.map((l) => l.id)) });
    notify(`Bringing in ${ENGINE_NAMES[tool]} as an agent of its own, on the same code…`);
    void quickConnect({ identity, state, events, sid, invite, tool, from: lane }).then((r) => {
      if (r.ok) return void (r.note && notify(r.note));
      setJoining(null);
      // Something has to be asked first (signed out, no code to go on): the setup, at that step, for the new lane.
      if (r.error) notify(r.error);
      else onSetup?.(lane, tool);
    });
  };
  useEffect(() => {
    if (!joining) return;
    const fresh = state.lanes.find((l) => !joining.before.has(l.id) && state.engines[l.id]?.tool === joining.tool);
    if (!fresh) return;
    setJoining(null);
    const fromName = current ? ENGINE_NAMES[current] : "Friday Code";
    carryInto(sid, fresh.id, lane, fromName);
    window.dispatchEvent(new CustomEvent("friday:focus-lane", { detail: { lane: fresh.id } }));
    notify(`Writing to ${ENGINE_NAMES[joining.tool]} now. Your next message goes to it with everything ${fromName} did.`);
  });

  const wait = () => notify("Let the current run finish, or pause it, before changing this.");
  const choose = (tool: EngineTool | "") => {
    if (tool === current && engine) return;
    if (!engine) return onSetup?.(lane, tool);
    if (running) return wait();
    if (tool && !status(tool).ready) return onSetup?.(lane, tool);
    if (tool && worked) return joining ? undefined : bringIn(tool);
    void swap(tool);
  };

  // The agent a lane carries keeps its name; a bare Friday lane is Friday Code.
  const fridayName = (lane === MAIN_LANE ? state.options.agent?.name : state.lanes.find((l) => l.id === lane)?.agent?.name) ?? "Friday Code";

  return (
    <AgentModelPicker
      engine={current}
      onEngine={choose}
      model={engine?.model ?? ""}
      onModel={(m) => (running ? wait() : m !== (engine?.model ?? "") && void swap(current, m))}
      fridayModelId={state.options.model ?? ""}
      onFridayModel={onFridayModel}
      fridayName={fridayName}
      plan={plan}
      identity={identity}
      toolState={(t) => ({ disabled: !!engine && ((running && t !== current) || busy), hint: engine ? status(t).word : "on your computer", ...(engine ? { ready: status(t).ready, absent: status(t).word === "not installed" } : {}) })}
      machineName={engine?.hostName}
      thinking={state.options.thinking}
      onThinking={onThinking}
      effort={effort ?? null}
    />
  );
}
