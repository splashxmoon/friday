import { useEffect, useRef, useState } from "react";
import type { AgentView } from "../agents.js";
import { can, canDriveLane, driverOf, runOf, type SessionState } from "../session/projection.js";
import { engineName, ENGINE_NAMES, ENGINE_TOOLS, MAIN_LANE, type EngineTool, type LaneControl, type LaneTrigger, type Member } from "../types.js";
import { EngineMark } from "./BrandMarks.js";
import { Icon, type IconName } from "./icons.js";
import { agentLook, laneLabel, tintOfEngine } from "./handoff-ui.js";
import type { Identity } from "./storage.js";
import { hostApi, useMachine } from "./local.js";
import { MenuButton, MoreTools, useConfirm, useDismiss, type MenuItem } from "./ui.js";
import { splitTools } from "./engines.js";
import { startTeam } from "./edition.js";
import { Dialog } from "./AgentDialogs.js";
import { raceBase } from "./Race.js";
import type { Send } from "./useSession.js";

/** The most lanes one session can run, as the server enforces it. */
const MAX_LANES = 6;

const CONTROL_LABEL: Record<LaneControl["kind"], string> = {
  open: "Anyone who can steer",
  role: "Owners and editors",
  people: "Named people",
  standing: "Nobody — it runs itself",
};

const TRIGGER_LABEL: Record<LaneTrigger["kind"], string> = {
  manual: "When someone instructs it",
  "lane-finished": "When another agent finishes",
  question: "When the agent asks a human",
};

/** The same, but naming the lane it waits for — "another lane" is the one thing you wanted to know. */
function triggerLabel(state: SessionState, t: LaneTrigger): string {
  if (t.kind !== "lane-finished") return TRIGGER_LABEL[t.kind];
  const id = t.laneId ?? MAIN_LANE;
  const name = id === MAIN_LANE ? "Main" : state.lanes.find((l) => l.id === id)?.name;
  return name ? `After ${name}` : TRIGGER_LABEL["lane-finished"];
}

/** Ready-made lanes, because most people want one of these three. */
const PRESETS: { id: string; name: string; icon: IconName; blurb: string; control: LaneControl; trigger: LaneTrigger }[] = [
  {
    id: "reviewer",
    name: "Reviewer",
    icon: "search",
    blurb: "Re-checks each section as it lands. Nobody drives it.",
    control: { kind: "standing" },
    trigger: { kind: "lane-finished" },
  },
  {
    id: "next-step",
    name: "Next step",
    icon: "chain",
    blurb: "Picks up automatically when the main agent finishes.",
    control: { kind: "standing" },
    trigger: { kind: "lane-finished" },
  },
  {
    id: "second-driver",
    name: "Second driver",
    icon: "users",
    blurb: "A second agent someone else steers, at the same time as you.",
    control: { kind: "open" },
    trigger: { kind: "manual" },
  },
];

/**
 * Lane control, in the session header rather than a panel of its own: lanes are
 * something you set up once and then occasionally take the wheel of, so they
 * don't earn permanent vertical space above the feed.
 */
export function Lanes({
  state,
  me,
  agents,
  identity,
  send,
  onConnect,
  onRace,
  solo,
}: {
  state: SessionState;
  me: Member;
  agents: AgentView[];
  identity: Identity;
  send: Send;
  onConnect: (tool?: EngineTool) => void;
  onRace?: () => void;
  /** Solo: Friday's own agents are Team's, so what is added here is your coding tools, and your agents on them. */
  solo?: boolean;
}) {
  const [managing, setManaging] = useState(false);
  const [onTool, setOnTool] = useState(false);
  const owner = me.role === "owner";
  const lanes = state.lanes;
  // Anybody who can steer can bring an agent of their own: their Claude Code,
  // Codex or Cursor, on their machine, under their account.
  const bringOwn = !owner && me.role !== "viewer" && can(state, me.id, "control");
  if (lanes.length === 0 && !owner && !bringOwn && !state.engines[MAIN_LANE]) return null;


  const items = (): MenuItem[] => {
    // Who is driving which agent is read off the tabs and the composer; this menu is for adding agents.
    const rows: MenuItem[] = [];
    if (owner) {
      // What the workspace has already built comes first: a saved agent is the likeliest thing someone
      // wants to add, and it used to be reachable only through "Custom agent…" and a three-step form.
      // Each one becomes a lane of its own, so it works at the same time as whatever else is running.
      const here = new Set(lanes.map((l) => l.agent?.id).filter((id): id is string => !!id));
      // On Solo a saved agent runs on your coding tool, which the next row does; as a Friday lane of its own it would be refused.
      if (agents.length && !solo) {
        rows.push({ heading: "Your agents" });
        for (const a of agents) {
          rows.push({
            label: a.name,
            icon: (a.icon as IconName | undefined) ?? "agent",
            hint: here.has(a.id) ? "in this session" : lanes.length >= MAX_LANES ? `${MAX_LANES} is the most` : a.access === "shared" ? "shared with you" : undefined,
            disabled: here.has(a.id) || lanes.length >= MAX_LANES,
            onSelect: () => {
              // Tell the composer to point at the new lane once it exists, so the next message goes to it.
              window.dispatchEvent(new CustomEvent("friday:use-agent", { detail: { agentId: a.id } }));
              send({ type: "lane.add", name: a.name, agentId: a.id, control: { kind: "open" }, trigger: { kind: "manual" } });
            },
          });
        }
      }
      rows.push({ heading: "Add" });
      // The two things people actually add, without a form in between: Friday's
      // own agent beside a coding CLI, or someone's CLI beside Friday.
      const friday: MenuItem = solo
        ? { label: "Friday Code · Team", icon: "agent", dim: true, onSelect: () => startTeam() }
        : { label: "Friday Code", icon: "agent", onSelect: () => send({ type: "lane.add", name: "Friday", control: { kind: "open" }, trigger: { kind: "manual" } }) };
      // On Solo your coding tools come first, and Friday Code sits under them, greyed: it is Team's.
      if (!solo) rows.push(friday);
      for (const t of ENGINE_TOOLS) rows.push({ label: ENGINE_NAMES[t], mark: <EngineMark tool={t} size={14} />, onSelect: () => onConnect(t) });
      // The tools first, a line each; the rest after them, a line each too, with no second lines to read through.
      const more: MenuItem[] = [
        // Two agents on one task, each in a copy of its own; needs a connected git folder.
        onRace && raceBase(state, me) ? { label: "Race agents", icon: "zap" as const, onSelect: onRace } : null,
        agents.length ? { label: "Run a saved agent…", icon: "agent" as const, onSelect: () => setOnTool(true) } : null,
        solo ? friday : null,
        // A custom agent is a Friday lane; on Solo there is only managing the ones already here.
        lanes.length || !solo ? { label: lanes.length ? "Manage agents" : "Custom agent", icon: "settings" as const, onSelect: () => setManaging(true) } : null,
      ].filter(Boolean);
      if (more.length) rows.push({ heading: "More" }, ...more);
    }
    if (bringOwn) {
      // A teammate who can steer uses the agents they have access to as a lane of their own, which only they drive.
      const hereAgents = new Set(lanes.map((l) => l.agent?.id).filter((id): id is string => !!id));
      if (agents.length) {
        rows.push({ heading: "Your agents" });
        for (const a of agents) {
          rows.push({
            label: a.name,
            icon: (a.icon as IconName | undefined) ?? "agent",
            hint: hereAgents.has(a.id) ? "in this session" : lanes.length >= MAX_LANES ? `${MAX_LANES} is the most` : a.access === "shared" ? "shared with you" : undefined,
            disabled: hereAgents.has(a.id) || lanes.length >= MAX_LANES,
            onSelect: () => {
              window.dispatchEvent(new CustomEvent("friday:use-agent", { detail: { agentId: a.id } }));
              send({ type: "lane.add", name: a.name, agentId: a.id, own: true, control: { kind: "open" }, trigger: { kind: "manual" } });
            },
          });
        }
        rows.push({ label: "Run a saved agent…", icon: "agent", onSelect: () => setOnTool(true) });
      }
      rows.push({ heading: "Bring your own" });
      for (const t of ENGINE_TOOLS) rows.push({ label: `My ${ENGINE_NAMES[t]}`, mark: <EngineMark tool={t} size={14} />, hint: "your account", onSelect: () => onConnect(t) });
    }
    return rows;
  };

  const here = [MAIN_LANE, ...lanes.map((l) => l.id)].filter((id) => id !== MAIN_LANE || !!state.engines[MAIN_LANE]?.tool || !!state.options.agent || lanes.length === 0);
  const stateOf = (id: string): string => {
    const e = state.engines[id];
    if (e?.tool && !e.online) return "Offline";
    if (state.approvals[id]) return "Needs you";
    const run = runOf(state, id).status;
    return run === "running" ? "Working" : run === "paused" ? "Paused" : "Ready";
  };
  return (
    <>
      {/* Just a plus: adding an agent is what it is for. Who is here and what each is doing is said in its tooltip. */}
      <MenuButton end className="icon-btn agent-plus" label={`Add an agent · here: ${here.map((id) => `${laneLabel(state, id)} (${stateOf(id).toLowerCase()})`).join(", ")}`} items={items} width={252}>
        <Icon name="plus" size={18} />
      </MenuButton>
      {onTool && <AgentOnTool state={state} agents={agents} send={send} own={!owner} onClose={() => setOnTool(false)} />}
      {managing && (
        <ManageLanes
          state={state}
          agents={agents}
          identity={identity}
          send={send}
          onConnect={onConnect}
          onClose={() => setManaging(false)}
          solo={!!solo}
        />
      )}
    </>
  );
}

function ManageLanes({
  state,
  agents,
  identity,
  send,
  onClose,
  onConnect,
  solo,
}: {
  state: SessionState;
  agents: AgentView[];
  identity: Identity;
  send: Send;
  onClose: () => void;
  onConnect: (tool?: EngineTool) => void;
  solo: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  const [ask, confirmUI] = useConfirm();
  // Which of the coding agents are ready on this computer, so each tile can say so before it is pressed.
  const { state: machine } = useMachine(identity);
  const addTools = splitTools(machine.mode === "local" || machine.mode === "linked" ? (t) => !!machine.tools.find((x) => x.tool === t)?.path : null);
  const [moreAdd, setMoreAdd] = useState(false);
  // null: the overview. 0, 1, 2: adding an agent, one question at a time.
  const [step, setStep] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [control, setControl] = useState<LaneControl["kind"]>("open");
  const [trigger, setTrigger] = useState<LaneTrigger["kind"]>("manual");

  const usePreset = (p: (typeof PRESETS)[number]) => {
    setName(p.name.toLowerCase());
    setControl(p.control.kind);
    setTrigger(p.trigger.kind);
    setStep(1);
  };

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    if (step === 1) return setStep(2);
    // "Named people" needs a person picker that doesn't exist yet, so the form
    // offers the three control modes that are complete.
    const c: LaneControl = control === "role" ? { kind: "role", role: "editor" } : control === "standing" ? { kind: "standing" } : { kind: "open" };
    send({ type: "lane.add", name: n, agentId: agentId || undefined, control: c, trigger: { kind: trigger } as LaneTrigger });
    setName("");
    setStep(null);
  };

  return (
    <div className="overlay">
      {confirmUI}
      <div className="modal lanes-modal" ref={ref} role="dialog" aria-modal="true" aria-label="Agents in this session">
        <div className="pop-head">
          <div>
            <h2>Agents</h2>
            <p className="muted small lanes-sub">Everyone here shares one folder and one log. Add agents to work side by side.</p>
          </div>
          <div className="lanes-head-actions">
            <button className="icon-btn tiny" aria-label="Close" onClick={onClose}>
              <Icon name="x" size={14} />
            </button>
          </div>
        </div>

        {step === null && (
          <>
        <section className="lanes-section">
          <h3 className="lanes-h">
            In this session <span className="lanes-count">{state.lanes.length + 1}</span>
          </h3>
          <div className="lane-grid">
            {[{ id: MAIN_LANE, name: laneLabel(state, MAIN_LANE), main: true as const }, ...state.lanes.map((l) => ({ id: l.id, name: l.name, main: false as const, lane: l }))].map((c) => {
              const look = agentLook(state, c.id, 18);
              const run = runOf(state, c.id);
              const driver = driverOf(state, c.id);
              const lane = "lane" in c ? c.lane : null;
              const auto = lane?.control.kind === "standing";
              const engine = state.engines[c.id];
              const running = run.status === "running";
              const sub = auto ? "Nobody drives it" : driver ? `${driver.name} driving` : lane ? CONTROL_LABEL[lane.control.kind] : "Anyone who can steer";
              // A lane in a copy of its own: another folder than the main lane's, on a branch Friday cut for it.
              const own = engine?.branch?.startsWith("friday/") && engine.cwd !== state.engines[MAIN_LANE]?.cwd ? engine : null;
              const what = engine ? `${engineName(engine.tool)}${engine.account ? ` (${engine.account.label})` : ""}${engine.machine ? ` on ${engine.machine}` : ""}` : (lane?.agent?.name ?? look.label);
              return (
                <article key={c.id} className="lane-card lane-card-v2" style={{ "--tint": look.tint } as React.CSSProperties}>
                  <header className="lcv-head">
                    <span className="lc-icon">{look.mark}</span>
                    <div className="lcv-title">
                      <span className="lane-card-name">{c.name}</span>
                      <span className="lcv-sub">{sub}</span>
                    </div>
                    <span className={`lcv-state${running ? " on" : ""}`}>{running ? "Running" : run.status === "idle" ? "Ready" : run.status}</span>
                  </header>
                  <p className="lcv-desc">{lane ? triggerLabel(state, lane.trigger) : "The session's own agent. It answers whoever has the wheel."}</p>
                  <div className="lcv-tags">
                    {c.main && <span className="lcv-tag">Main</span>}
                    <span className="lcv-tag">{look.label}</span>
                    {auto && <span className="lcv-tag warm">Runs itself</span>}
                    {own && (
                      <span className="lcv-tag" title={`Its own worktree: ${own.cwd}`}>
                        <Icon name="gitBranch" size={11} /> {own.branch}
                      </span>
                    )}
                  </div>
                  <footer className="lcv-foot">
                    <span>{what}</span>
                    {lane && (
                      <button
                        type="button"
                        className="lcv-remove"
                        onClick={() =>
                          ask({
                            title: `Remove the ${lane.name} agent?`,
                            body:
                              (running
                                ? "This agent is running right now. It stops immediately, and whoever is driving it loses the wheel. The session log keeps everything it already did."
                                : "Its agent stops being available in this session. The session log keeps everything it already did.") +
                              (own ? ` Its worktree goes too if everything in it is committed and merged; if not, it stays on ${own.branch} so nothing is lost.` : ""),
                            action: "Remove agent",
                            onConfirm: async () => {
                              // Only the computer that holds the copy can clear it, and never past work that exists nowhere else.
                              if (own && own.hostId === identity.id) {
                                const call = (m: string, body: object) => hostApi(identity, `/api/runner/${m}`, { method: "POST", body: JSON.stringify(body) }).catch(() => {});
                                await call("stop", { sid: state.id, lane: lane.id });
                                await call("worktree.drop", { path: own.cwd, force: false });
                              }
                              // Thrown, so the dialog stays open and says why: the agent staying put with no word was the worst answer.
                              const r = await send({ type: "lane.remove", laneId: lane.id });
                              if (!r.ok) throw new Error(r.error ?? `Couldn't remove the ${lane.name} agent. Try again in a moment.`);
                            },
                          })
                        }
                      >
                        Remove
                      </button>
                    )}
                  </footer>
                </article>
              );
            })}
          </div>
          {state.lanes.length === 0 && <p className="lanes-empty">Just Friday Code so far. Add one below and it works beside it.</p>}
        </section>
            <button type="button" className="btn primary lanes-add" onClick={() => setStep(0)}>
              <Icon name="plus" size={14} /> Add an agent
            </button>

          </>
        )}

        {step !== null && (
          <ol className="cd-steps" aria-label="Progress">
            {["Choose", "Basics", "Behavior"].map((label, i) => (
              <li key={label} className={i === step ? "now" : i < step ? "done" : ""}>
                <button type="button" disabled={i > step} onClick={() => setStep(i)}>
                  <span>{i < step ? <Icon name="check" size={11} /> : i + 1}</span>
                  {label}
                </button>
              </li>
            ))}
          </ol>
        )}

        {step === 0 && (
          <>
            <section className="lanes-section">
              <h3 className="lanes-h">Add a coding agent</h3>
              <div className="add-grid">
                <button type="button" className={`add-tile ${solo ? "team-only" : ""}`}
                  onClick={() => {
                    if (solo) return startTeam();
                    send({ type: "lane.add", name: "Friday", control: { kind: "open" }, trigger: { kind: "manual" } });
                    setStep(null);
                  }}
                >
                  <span className="add-icon">
                    <EngineMark tool="" size={18} />
                  </span>
                  <span className="add-text">
                    <span className="add-name">Friday Code</span>
                    <span className="add-blurb">Reads the session and works beside whoever else is here.</span>
                  </span>
                  <span className={`add-pill ${solo ? "" : "ok"}`}>{solo ? "Team" : "Always ready"}</span>
                </button>
                {[...addTools.here, ...(moreAdd ? addTools.away : [])].map((t) => {
                  const f = machine.mode === "local" || machine.mode === "linked" ? machine.tools.find((x) => x.tool === t) : null;
                  const pill = !f ? { text: "Needs a computer", tone: "" } : !f.path ? { text: "Not installed", tone: "off" } : f.loggedIn === false ? { text: "Sign in needed", tone: "warn" } : { text: "Ready", tone: "ok" };
                  return (
                    <button
                      key={t}
                      type="button"
                      className="add-tile"
                      onClick={() => {
                        onConnect(t);
                        onClose();
                      }}
                    >
                      <span className="add-icon">
                        <EngineMark tool={t} size={18} />
                      </span>
                      <span className="add-text">
                        <span className="add-name">{ENGINE_NAMES[t]}</span>
                        <span className="add-blurb">Runs on your computer, signed in as you. Friday never sees a key.</span>
                      </span>
                      <span className={`add-pill ${pill.tone}`}>{pill.text}</span>
                    </button>
                  );
                })}
                <MoreTools open={moreAdd} count={addTools.away.length} onToggle={() => setMoreAdd((v) => !v)} className="cd-more" />
              </div>
            </section>
            {!solo && (
            <section className="lanes-section">
              <h3 className="lanes-h">Add a role</h3>
              <div className="add-grid">
                {PRESETS.map((p) => (
                  <button key={p.id} type="button" className="add-tile" onClick={() => usePreset(p)}>
                    <span className="add-icon">
                      <Icon name={p.icon} size={17} />
                    </span>
                    <span className="add-text">
                      <span className="add-name">{p.name}</span>
                      <span className="add-blurb">{p.blurb}</span>
                    </span>
                  </button>
                ))}
                <button type="button" className="add-tile subtle" onClick={() => setStep(1)}>
                  <span className="add-icon">
                    <Icon name="plus" size={17} />
                  </span>
                  <span className="add-text">
                    <span className="add-name">Custom agent</span>
                    <span className="add-blurb">Pick the agent, who may steer it, and what wakes it up.</span>
                  </span>
                </button>
              </div>
            </section>
            )}
            <div className="lane-form-actions">
              <button className="btn ghost small" type="button" onClick={() => setStep(null)}>
                Back
              </button>
            </div>
          </>
        )}

        {(step === 1 || step === 2) && (
          <form className="lane-form lanes-section" onSubmit={add}>
            {step === 1 ? (
              <>
                <h3 className="lanes-h">Name it and pick what it runs</h3>
                <label className="lane-field">
                  <span>Name</span>
                  <input autoFocus value={name} maxLength={40} placeholder="e.g. review" onChange={(e) => setName(e.target.value)} />
                </label>
                <label className="lane-field">
                  <span>Agent</span>
                  <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                    <option value="">Default agent</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                  <small>What it knows and which tools it can use.</small>
                </label>
              </>
            ) : (
              <>
                <h3 className="lanes-h">Who drives it, and when does it run?</h3>
                <label className="lane-field">
                  <span>Who drives it</span>
                  <select value={control} onChange={(e) => setControl(e.target.value as LaneControl["kind"])}>
                    <option value="open">{CONTROL_LABEL.open}</option>
                    <option value="role">{CONTROL_LABEL.role}</option>
                    <option value="standing">{CONTROL_LABEL.standing}</option>
                  </select>
                  <small>An agent nobody drives can still run, if it has a trigger.</small>
                </label>
                <label className="lane-field">
                  <span>When it runs</span>
                  <select value={trigger} onChange={(e) => setTrigger(e.target.value as LaneTrigger["kind"])}>
                    <option value="manual">{TRIGGER_LABEL.manual}</option>
                    <option value="lane-finished">{TRIGGER_LABEL["lane-finished"]}</option>
                    <option value="question">{TRIGGER_LABEL.question}</option>
                  </select>
                  <small>Agents that start on a trigger wait at least 5s between runs.</small>
                </label>
              </>
            )}
            <div className="lane-form-actions">
              <button className="btn ghost small" type="button" onClick={() => setStep(step - 1)}>
                Back
              </button>
              <button className="btn primary small" type="submit" disabled={!name.trim()}>
                {step === 1 ? "Next" : "Add agent"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/** Whether this person asked for less motion. Read as each tab is drawn: a starting tab is on screen for seconds, not minutes. */
const stillMotion = () => {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

/**
 * A coding agent's tab while it starts: drawn the moment it is pressed, before any server answers, and once its lane exists,
 * until its runner attaches. Its tool's mark eases in and a soft light crosses the tab; asked for less motion, it is the
 * same tab, still, with "Starting…" on it.
 */
export function StartingLaneTab({ tool, name, on = false, onClick }: { tool: EngineTool; name: string; on?: boolean; onClick?: () => void }) {
  const still = stillMotion();
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      aria-busy="true"
      title={`Starting ${ENGINE_NAMES[tool]}. Messages sent to it wait until it's ready.`}
      className={`lane-tab lane-tab-starting${on ? " on" : ""}${still ? "" : " lane-tab-shimmer"}`}
      style={{ "--tint": tintOfEngine(tool) } as React.CSSProperties}
      disabled={!onClick}
      onClick={onClick}
    >
      <span className={`lane-tab-mark${still ? "" : " lane-tab-mark-in"}`}>
        <EngineMark tool={tool} size={13} />
      </span>
      <span className="lane-tab-name">{name}</span>
      <span className="lane-tab-kind">Starting…</span>
    </button>
  );
}

/**
 * One of your agents, on your own Claude Code, Codex or Cursor.
 *
 * The lane is made for the agent first (marked as a coding-tool lane, so it is not counted against a plan's Friday agents), then
 * the connect step opens for that lane and tool. The tool runs the agent's instructions.
 */
function AgentOnTool({ state, agents, send, own, onClose }: { state: SessionState; agents: AgentView[]; send: Send; /** A teammate rather than an owner: the lane is theirs alone to drive. */ own: boolean; onClose: () => void }) {
  const free = agents.filter((a) => !state.lanes.some((l) => l.agent?.id === a.id));
  const [agentId, setAgentId] = useState(free[0]?.id ?? "");
  const [tool, setTool] = useState<EngineTool>(ENGINE_TOOLS[0]!);
  const [error, setError] = useState("");
  const [wait, setWait] = useState<{ agentId: string; tool: EngineTool; before: Set<string> } | null>(null);

  // Once the lane exists, the connect step opens on it.
  useEffect(() => {
    if (!wait) return;
    const fresh = state.lanes.find((l) => !wait.before.has(l.id) && l.agent?.id === wait.agentId);
    if (fresh) {
      window.dispatchEvent(new CustomEvent("friday:connect-lane", { detail: { lane: fresh.id, tool: wait.tool } }));
      onClose();
    }
  }, [state.lanes, wait]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = async () => {
    const a = agents.find((x) => x.id === agentId);
    if (!a) return;
    setError("");
    setWait({ agentId, tool, before: new Set(state.lanes.map((l) => l.id)) });
    const r = await send({ type: "lane.add", name: a.name.slice(0, 40), agentId, engine: true, ...(own ? { own: true } : {}), control: { kind: "open" }, trigger: { kind: "manual" } });
    if (!r.ok) {
      setError(r.error ?? "Couldn't add that agent. Try again, or pick a different one.");
      setWait(null);
    }
  };

  return (
    <Dialog
      title="Run a saved agent"
      sub="Your agent's instructions, running on one of your own coding tools."
      onClose={onClose}
      onSubmit={() => void go()}
      actions={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!agentId || !!wait}>
            {wait ? "Adding…" : "Add and connect"}
          </button>
        </>
      }
    >
      {free.length === 0 ? (
        <p className="muted small">Every one of your agents is already in this session.</p>
      ) : (
        <>
          <label className="field">
            <span>Agent</span>
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              {free.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name || "Untitled agent"}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Run it on</span>
            <select value={tool} onChange={(e) => setTool(e.target.value as EngineTool)}>
              {ENGINE_TOOLS.map((t) => (
                <option key={t} value={t}>
                  {ENGINE_NAMES[t]}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {error && <p role="alert" className="error small">{error}</p>}
    </Dialog>
  );
}
