import { lazy, Suspense, useContext, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { focusAgent, useAgents, useFocusedAgent } from "./agentFocus.js";
import { agentNameFor } from "./agent-name.js";
import { AGENT_DRAG } from "./agentNav.js";
import { agentLook } from "./handoff-ui.js";
import { tabState } from "./agent-tab.js";
import { Icon } from "./icons.js";
import { EngineMark, LinearMark, SlackMark } from "./BrandMarks.js";
import { ContextMenu, type MenuItem } from "./ui.js";
import { TabRing, useNow, type Presence } from "./presence.js";
import { BranchButton } from "./Branches.js";
import { GitMenu } from "./github-menu.js";
import { changeTotals } from "./change-totals.js";
import { EnvironmentPanel } from "./Environment.js";
import { openIn, openInItems, openTargets, preferredEditor, type OpenTarget } from "./openIn.js";
import { useCrewAddRows } from "./crew-add-local.js";
import { installedOn } from "./local.js";
import { splitTools } from "./engines.js";
import { useStarting } from "./quickConnect.js";
import { setIntake, useIntakes } from "./issue-intake.js";
import { openedThreads } from "./team-thread.js";
import { ThreadsCtx } from "./threads-data.js";
import { ENGINE_NAMES, MAIN_LANE, type EngineTool, type Member, type SessionEvent } from "../types.js";
import type { SessionState } from "../session/projection.js";
import type { Identity } from "./storage.js";
import type { Send } from "./useSession.js";
import type { HubAgent } from "../agents-hub.js";
import { isLocal } from "./edition.js";
import { api } from "./api.js";
import { GO_AHEAD_WORDS, type GoAhead } from "../guardrails.js";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fileUrl } from "./api.js";
import { runProof, type Proof } from "../team-proof.js";
import "./thread-card.css";

/**
 * An agent's row, dragged onto the chat, opens it side by side with what is shown there, as the agent tabs do (Arun, 2026-11-16:
 * "allow to drag this so open the side by side view too"). The session's chat takes the drop (SessionView sv-main, AGENT_DRAG).
 */
const dragAgent = (lane: string) => ({
  draggable: true,
  onDragStart: (e: React.DragEvent) => {
    e.dataTransfer.setData(AGENT_DRAG, lane);
    e.dataTransfer.effectAllowed = "copy";
    dispatchEvent(new CustomEvent("friday:agent-drag", { detail: { lane } }));
  },
  onDragEnd: () => dispatchEvent(new CustomEvent("friday:agent-drag", { detail: { lane: null } })),
});

const HandedRows = lazy(() => import("./crew-carry.js").then((m) => ({ default: m.HandedRows })));

/**
 * The thread card (Arun, 2026-11-16: "i kinda what something like this, like what t3 has with and agent section"): at the top
 * right of a coding thread, where it runs (the computer and folder, its environment, your editor), its git (the branch, commit
 * and pull request, the changes) and the agents in it, each with where it stands, the step it is on and how long. It takes the
 * place of the agents' strip over the chat and of the status bar along the foot ("if we are going with this, then we can remove
 * this then"; "get rid of the environment because it will be the thread card thing"). The Agents part folds ("make the agent
 * thing collapseable"); the card itself opens and closes from the header, ⌘I.
 */

// ── open or closed, docked or over the chat ─────────────────────────────────────────────────────────────────────────────

import { cardShown, closePeek, read, toggleThreadCard, useThreadCard, write, FOLD_KEY } from "./thread-card-store.js";

// ── where each agent stands ─────────────────────────────────────────────────────────────────────────────────────────────

type Tone = "work" | "need" | "done" | "bad" | "idle" | "wait";
const toneOf = (a: HubAgent): Tone => {
  const t = tabState(a.status, a.needsYou);
  return t === "working" ? "work" : t === "needs" ? "need" : t === "done" ? "done" : t === "failed" ? "bad" : t === "waiting" || t === "limited" ? "wait" : "idle";
};
/** Each tone as the session tab's ring draws it (presence.tsx TabRing). */
const TONE_RING: Record<Tone, Presence | "done" | null> = { work: "working", need: "needs", done: "done", bad: "error", wait: "queued", idle: null };
/** "1:40", "12:05", "1h 4m". */
const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const clipText = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
const firstLine = (t: string) => (t.split("\n").find((l) => l.trim()) ?? "").trim();

/** The menu of an agent (Rename, Make it lead, Side by side, Remove, what the chat shows), the chat's own (Activity.tsx kindMenu). */
const agentMenu = (x: number, y: number, lane?: string) => dispatchEvent(new CustomEvent("friday:agent-menu", { detail: { x, y, ...(lane ? { lane } : {}) } }));

/**
 * An agent row's ⋯: the menu its right-click opens, for those who can see it there (Arun, 2026-11-17: "add the three dot thing for
 * the agent parts"). Its own click and keys stay its own, not the row's (which shows only that agent's work).
 */
function AgentMore({ lane, name }: { lane: string; name: string }) {
  return (
    <button
      type="button"
      className="tc-end-btn tc-agent-more"
      aria-label={`More for ${name}`}
      title={`More for ${name}`}
      onClick={(e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        agentMenu(r.right - 240, r.bottom + 4, lane);
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Icon name="more" size={14} />
    </button>
  );
}

// ── the header's button ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The card's button in the header: with it closed and two or more agents here, their faces and a word on how they stand. */
export function ThreadCardToggle({ state }: { state: SessionState }) {
  const c = useThreadCard();
  const shown = cardShown(c);
  const agents = useAgents();
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "i") (e.preventDefault(), toggleThreadCard());
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);
  const working = agents.filter((a) => toneOf(a) === "work").length;
  const needs = agents.filter((a) => a.needsYou).length;
  const label = `${shown ? "Close" : "Open"} the thread card${agents.length > 1 ? `: ${agents.length} agents${working ? `, ${working} working` : ""}${needs ? `, ${needs} need you` : ""}` : ""} (${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘I" : "Ctrl+I"})`;
  if (!shown && agents.length > 1)
    return (
      <button type="button" className="tc-stack" onClick={toggleThreadCard} aria-label={label} title={label}>
        <span className="tc-faces">
          {agents.slice(0, 4).map((a) => (
            <span key={a.lane} className="tc-face" style={{ "--tint": agentLook(state, a.lane, 12).tint } as React.CSSProperties}>
              {agentLook(state, a.lane, 12).mark}
              <i className={`tc-dot is-${toneOf(a)}`} aria-hidden />
            </span>
          ))}
        </span>
        <span>{agents.length} agents</span>
        {needs > 0 ? <span className="tc-stack-need">· {needs} need{needs > 1 ? "" : "s"} you</span> : working > 0 ? <span className="tc-stack-dim">· {working} working</span> : null}
      </button>
    );
  return (
    <button type="button" className={cn("panel-tab icon tc-toggle", shown && "on")} aria-pressed={shown} aria-label={label} title={label} onClick={toggleThreadCard}>
      <Icon name="threadCard" size={17} />
      {!shown && needs > 0 && <i className="panel-tab-dot tc-need-dot" />}
    </button>
  );
}

// ── the card ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function ThreadCard({ state, events, me, sid, invite, send, identity, onOpen, onConnect, slot }: { state: SessionState; events: SessionEvent[]; me: Member; sid: string; invite: string; send: Send; identity: Identity; onOpen: (tab: "files" | "overview" | "preview") => void; onConnect: (tool?: EngineTool) => void; /** Where the chat draws its jump menu and gauge (Focus). */ slot: (el: HTMLElement | null) => void }) {
  const c = useThreadCard();
  const ref = useRef<HTMLDivElement>(null);
  // Over a narrow chat it goes at a press anywhere else, or Escape.
  useEffect(() => {
    if (c.wide || !c.peek) return;
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!ref.current?.contains(t) && !t.closest(".tc-toggle, .tc-stack, .ctx-menu, [role='menu'], [role='dialog']")) closePeek();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && closePeek();
    addEventListener("pointerdown", down, true);
    addEventListener("keydown", key);
    return () => (removeEventListener("pointerdown", down, true), removeEventListener("keydown", key));
  }, [c.wide, c.peek]);
  if (!cardShown(c)) return null;
  return (
    <aside ref={ref} className={cn("tc", !c.wide && "over")} aria-label="This thread">
      <Place state={state} me={me} sid={sid} invite={invite} identity={identity} onOpen={onOpen} />
      <Origin sid={sid} />
      <Git state={state} events={events} sid={sid} invite={invite} send={send} onOpen={onOpen} />
      <GoAheads state={state} events={events} me={me} sid={sid} identity={identity} />
      <Agents state={state} events={events} me={me} sid={sid} invite={invite} send={send} identity={identity} onConnect={onConnect} onChanges={() => onOpen("files")} />
      <div className="tc-slot" ref={slot} />
    </aside>
  );
}

function mainLane(state: SessionState) {
  return state.engines[MAIN_LANE] ? MAIN_LANE : (Object.keys(state.engines)[0] ?? MAIN_LANE);
}

/** The computer and folder (its environment a press away), and the folder in your editor. */
function Place({ state, me, sid, invite, identity, onOpen }: { state: SessionState; me: Member; sid: string; invite: string; identity: Identity; onOpen: (tab: "overview" | "preview") => void }) {
  const lane = mainLane(state);
  const engine = state.engines[lane];
  const row = useRef<HTMLButtonElement>(null);
  const [env, setEnv] = useState(false);
  const [targets, setTargets] = useState<OpenTarget[]>([]);
  const [editor, setEditor] = useState<OpenTarget | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    void openTargets().then(setTargets);
    void preferredEditor().then(setEditor);
  }, []);
  const cwd = engine?.cwd ?? "";
  const folder = cwd ? (cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd).replace(/-[0-9a-f]{8}$/, "") : "";
  const online = !!engine?.online;
  const computer = engine ? (engine.hostId === me.id ? "This computer" : `${engine.hostName.split(/\s+/)[0]}'s computer`) : state.upload ? "Uploaded folder" : "No computer";
  const files = targets.find((t) => t.id === "files");
  const go = (t: OpenTarget) => void openIn(t, cwd).then((e) => (e ? setNote(e) : t.editor && setEditor(t)));
  return (
    <div className="tc-sec">
      <div className="tc-row-wrap">
        <button ref={row} type="button" className={cn("tc-row", env && "on")} onClick={() => setEnv((v) => !v)} aria-haspopup="dialog" aria-expanded={env} title={`${online ? "Connected" : engine ? "Offline" : ""}${cwd ? ` · ${cwd}` : ""} · its environment: servers, tools, setup and secrets`}>
          <span className="tc-ic">
            <Icon name="server" size={14} />
            <i className={`tc-env-dot ${engine ? (online ? "on" : "off") : "none"}`} aria-hidden />
          </span>
          <span className="tc-text">
            {computer}
            {folder && <span className="tc-dim"> · {folder}</span>}
          </span>
        </button>
        {files && cwd && (
          <button type="button" className="tc-end-btn" aria-label={`Show ${folder} in ${files.label}`} title={`Show it in ${files.label}`} onClick={() => go(files)}>
            <Icon name="folderOpen" size={14} />
          </button>
        )}
      </div>
      {editor && cwd && (
        <div className="tc-row-wrap">
          <button type="button" className="tc-row" onClick={() => go(editor)} title={`Open ${folder} in ${editor.label}`}>
            <span className="tc-ic">
              <Icon name="external" size={14} />
            </span>
            <span className="tc-text">Open in {editor.label}</span>
          </button>
          <button type="button" className="tc-end-btn" aria-label="Open in another app" title="Open in another app" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.right - 220, y: r.bottom + 4 }); }}>
            <Icon name="chevronDown" size={14} />
          </button>
        </div>
      )}
      {note && <p className="tc-note">{note}</p>}
      {menu && <ContextMenu at={menu} onClose={() => setMenu(null)} items={() => openInItems(targets, cwd, setNote).filter((x): x is MenuItem => !!x)} />}
      {env && <EnvironmentPanel anchor={row} close={() => setEnv(false)} state={state} me={me.id} sid={sid} invite={invite} identity={identity} lane={lane} onOpen={onOpen} />}
    </div>
  );
}

/**
 * What Auto did that the go-ahead list had a say in (Arun, 2026-11-18, as OpenBot's Activity and Claude Code's "Recently blocked"
 * keep it): each go-ahead asked and how it went (you allowed it, you said no, it went through on its own by a standing allowance,
 * still waiting), each step refused outright and why, and what is allowed for every session in this project, each taken back here.
 */
function GoAheads({ state, events, me, sid, identity }: { state: SessionState; events: SessionEvent[]; me: Member; sid: string; identity: Identity }) {
  const [open, setOpen] = useState(false);
  const [project, setProject] = useState<{ folder: string; entries: string[] } | null>(null);
  const lane = mainLane(state);
  const mine = state.engines[lane]?.hostId === me.id && me.role === "owner";
  const load = () =>
    void api<{ folder: string; entries: string[] }>(identity, `/api/project-allow?sid=${encodeURIComponent(sid)}&lane=${encodeURIComponent(lane)}`)
      .then(setProject)
      .catch(() => setProject(null));
  useEffect(() => {
    if (mine) load();
  }, [mine, sid, lane, open]);
  const rows: { key: number; tag?: GoAhead; item: string; state: "allowed" | "auto" | "denied" | "refused" | "waiting"; note: string }[] = [];
  for (const e of events) {
    const b = e.body;
    if (b.type === "guard.refused") rows.push({ key: e.seq, item: b.item, state: "refused", note: b.why });
    if (b.type !== "engine.approval" || !b.guard) continue;
    const said = events.find((x): x is SessionEvent & { body: { type: "instruction" } } => x.body.type === "instruction" && x.body.approval?.id === b.id);
    const auto = said?.actor.id === "friday";
    rows.push({
      key: e.seq,
      tag: b.guard as GoAhead,
      item: b.items[0] ?? "",
      state: !said ? "waiting" : said.body.approval!.approve ? (auto ? "auto" : "allowed") : "denied",
      note: !said ? "Waiting on you" : auto ? said.body.text.replace(/:.*$/, "") : said.body.approval!.approve ? `Allowed by ${said.actor.id === me.id ? "you" : said.actor.name.split(/\s+/)[0]}` : `Denied by ${said.actor.id === me.id ? "you" : said.actor.name.split(/\s+/)[0]}`,
    });
  }
  const entries = project?.entries ?? [];
  if (!rows.length && !entries.length) return null;
  const refused = rows.filter((r) => r.state === "refused").length;
  const ICON = { allowed: "check", auto: "zap", denied: "x", refused: "x", waiting: "clock" } as const;
  const remove = (entry: string) =>
    void api<{ folder: string; entries: string[] }>(identity, "/api/project-allow", { method: "POST", body: JSON.stringify({ sid, lane, remove: entry }) })
      .then(setProject)
      .catch(() => {});
  return (
    <div className="tc-sec">
      <button type="button" className="tc-row" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="tc-ic">
          <Icon name="shield" size={14} />
        </span>
        <span className="tc-text">
          Go-aheads
          {rows.length > 0 && <span className="tc-dim"> · {rows.length - refused} asked</span>}
          {refused > 0 && <span className="tc-dim"> · {refused} refused</span>}
        </span>
        <Icon name="chevronDown" size={14} className={cn("tc-chev", open && "tc-chev-open")} />
      </button>
      {open && (
        <ul className="tc-ga" aria-label="Go-aheads in this thread">
          {rows
            .slice(-30)
            .reverse()
            .map((r) => (
              <li key={r.key} data-state={r.state}>
                <Icon name={ICON[r.state]} size={12} />
                <span className="tc-ga-what">
                  <code title={r.item}>{r.item}</code>
                  <span className="tc-ga-note">
                    {r.tag ? `${GO_AHEAD_WORDS[r.tag]} · ` : "Refused · "}
                    {r.note}
                  </span>
                </span>
              </li>
            ))}
          {entries.length > 0 && <li className="tc-ga-head">Always in this project</li>}
          {entries.map((x) => (
            <li key={x} data-state="auto">
              <Icon name="zap" size={12} />
              <span className="tc-ga-what">
                <code title={x}>{x}</code>
              </span>
              <button type="button" className="link-btn tc-ga-remove" onClick={() => remove(x)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Where this thread was asked for, when it came from Slack or Linear (channels/, spec 08): one row that opens that thread or
 * issue, and who asked when it wasn't the person here.
 */
function Origin({ sid }: { sid: string }) {
  const [link, setLink] = useState<{ side: "slack" | "linear"; label: string; url: string | null; by: { name: string; me: boolean } } | null>(null);
  useEffect(() => {
    if (!isLocal()) return;
    let live = true;
    fetch(`/api/channels/link/${encodeURIComponent(sid)}`, { headers: { "x-friday-local": "1" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { link?: typeof link } | null) => live && setLink(j?.link ?? null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [sid]);
  if (!link) return null;
  const where = link.side === "slack" ? "Slack" : "Linear";
  const go = () => link.url && (window.fridayDesktop?.openExternal ? void window.fridayDesktop.openExternal(link.url) : void window.open(link.url, "_blank", "noopener"));
  return (
    <div className="tc-sec">
      <button type="button" className="tc-row" onClick={go} disabled={!link.url} title={link.url ? `Open in ${where}` : undefined}>
        <span className="tc-ic">{link.side === "slack" ? <SlackMark size={13} /> : <LinearMark size={13} />}</span>
        <span className="tc-text">
          From {where}
          {link.side === "linear" ? <span className="tc-dim"> · {link.label}</span> : null}
          {!link.by.me ? <span className="tc-dim"> · asked by {link.by.name}</span> : null}
        </span>
      </button>
    </div>
  );
}

/** The branch (Branches: switch, new, rename), commit, push and pull request (the git menu), and the changes. */
function Git({ state, events, sid, invite, send, onOpen }: { state: SessionState; events: SessionEvent[]; sid: string; invite: string; send: Send; onOpen: (tab: "files") => void }) {
  const lane = mainLane(state);
  const engine = state.engines[lane];
  if (!engine?.cwd) return null;
  const all = changeTotals(state);
  const files = all.files.length;
  const running = state.run.status === "running" || Object.values(state.laneRuns).some((r) => r.status === "running");
  return (
    <div className="tc-sec">
      <div className="tc-row-wrap tc-branch">
        <BranchButton sid={sid} invite={invite} send={send} lane={lane} idle={!running} {...(engine.branch ? { branch: engine.branch } : {})} />
      </div>
      <GitMenu state={state} sid={sid} invite={invite} send={send} clickToo below>
        <button type="button" className="tc-row">
          <span className="tc-ic">
            <Icon name="gitPullRequest" size={14} />
          </span>
          <span className="tc-text">Commit, push &amp; PR</span>
          <Icon name="chevronDown" size={14} className="tc-chev" />
        </button>
      </GitMenu>
      <button type="button" className="tc-row" onClick={() => onOpen("files")} disabled={!files} title={files ? "Open the changes" : undefined}>
        <span className="tc-ic">
          <Icon name="file" size={14} />
        </span>
        <span className="tc-text">{files ? <>Changes <span className="tc-dim">· {files} {files === 1 ? "file" : "files"}</span></> : events.some((e) => e.body.type === "folder.committed") ? "All committed" : "No changes yet"}</span>
        {files > 0 && (
          <span className="tc-nums">
            <span className="tc-add">+{all.adds}</span>
            <span className="tc-del">−{all.dels}</span>
          </span>
        )}
      </button>
      <IntakeRow state={state} />
    </div>
  );
}

/**
 * Issues on GitHub with the project's label start threads by themselves (issue-intake.ts): turned on for the project this
 * thread is in, with this thread's coding tool. The project is the folder, not a worktree of it.
 */
function IntakeRow({ state }: { state: SessionState }) {
  const intakes = useIntakes();
  const engine = state.engines[mainLane(state)];
  const path = engine?.copyOf || engine?.cwd || "";
  if (!path || !engine?.tool) return null;
  const on = intakes[path];
  const name = (path.split(/[\\/]/).filter(Boolean).pop() ?? path).replace(/-[0-9a-f]{8}$/, "");
  const label = on?.label ?? "friday";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!on}
      className="tc-row"
      onClick={() => setIntake(path, on ? null : { label, tool: engine.tool!, name })}
      title={on ? `Open issues labelled “${label}” in ${name} start a thread each, with ${ENGINE_NAMES[on.tool]}, while Friday is open. Each issue starts once.` : `Start a thread for each open GitHub issue labelled “${label}” in ${name}`}
    >
      <span className="tc-ic">
        <Icon name="flag" size={14} />
      </span>
      <span className="tc-text">
        Issues labelled <code className="tc-code">{label}</code>
      </span>
      <span className={cn("tc-switch", on && "on")} aria-hidden />
    </button>
  );
}

/** The agents in this thread: each one's state, step and time; Answer; Add agent; Stop all. Folds to its line. */
function Agents({ state, events, me, sid, invite, send, identity, onConnect, onChanges }: { state: SessionState; events: SessionEvent[]; me: Member; sid: string; invite: string; send: Send; identity: Identity; onConnect: (tool?: EngineTool) => void; onChanges: () => void }) {
  const agents = useAgents();
  const starting = useStarting(sid).filter((s) => !s.lane || !agents.some((a) => a.lane === s.lane));
  const focused = useFocusedAgent(sid);
  const [folded, setFolded] = useState(() => read(FOLD_KEY, false));
  const [add, setAdd] = useState<{ x: number; y: number } | null>(null);
  const crewRows = useCrewAddRows(state, me, identity);
  const working = agents.filter((a) => toneOf(a) === "work").length;
  const needs = agents.filter((a) => a.needsYou).length;
  const now = useNow(working ? 1000 : 30_000);
  const fold = () => (write(FOLD_KEY, !folded), setFolded(!folded));
  const may = me.role === "owner" || me.role === "editor";
  const stopAll = () => {
    const lanes = agents.filter((a) => toneOf(a) === "work").map((a) => a.lane);
    void Promise.all(lanes.map((lane) => send({ type: "run.pause", ...(lane !== MAIN_LANE ? { lane } : {}) })));
  };
  const answer = (lane: string) => {
    focusAgent(sid, lane);
    requestAnimationFrame(() => document.querySelector(`[data-needs="${CSS.escape(lane)}"]`)?.scrollIntoView({ block: "nearest" }));
  };
  const sum = [working ? `${working} working` : "", needs ? `${needs} need${needs > 1 ? "" : "s"} you` : ""].filter(Boolean);
  // Folded, how they stand at a glance (Arun, 2026-11-17: "add like a agent status or something for when this is closed, needs to be
  // compact and not crowding"): each agent's face with its state's dot, and a word when nobody works or waits on you.
  const stopped = agents.filter((a) => toneOf(a) === "bad").length;
  const done = agents.filter((a) => toneOf(a) === "done").length;
  // One word, the most pressing: the faces' dots say the rest, and the faces how many there are.
  const word = needs ? { text: `${needs} need${needs > 1 ? "" : "s"} you`, tone: "need" } : working ? { text: `${working} working`, tone: "work" } : stopped ? { text: `${stopped} stopped`, tone: "bad" } : done ? { text: done === agents.length ? (done > 1 ? "all done" : "done") : `${done} done`, tone: "done" } : null;
  const words: Record<Tone, string> = { work: "working", need: "needs you", done: "done", bad: "stopped", wait: "waiting", idle: "free" };
  const status = agents.map((a) => `${agentNameFor(state, a.lane)} ${words[toneOf(a)]}`).join(", ");
  return (
    <div className="tc-sec tc-agents">
      <div className="tc-head">
        <button type="button" className="tc-head-btn" onClick={fold} aria-expanded={!folded} title={folded ? `Show the agents${status ? `: ${status}` : ""}` : "Fold the agents"}>
          <span className="tc-ic">
            <Icon name={folded ? "chevronRight" : "chevronDown"} size={14} />
          </span>
          <b>Agents</b>
          {!sum.length && !(folded && agents.length) && <span className="tc-dim">{agents.length + starting.length}</span>}
          {sum.length > 0 && !folded && (
            <span className="tc-head-sum">
              {working > 0 && <span>· {working} working</span>}
              {needs > 0 && <span className="tc-need-word"> · {needs} need{needs > 1 ? "" : "s"} you</span>}
            </span>
          )}
          {folded && word && <span className={cn("tc-head-sum tc-settled", `is-${word.tone}`)}>{word.text}</span>}
          {folded && agents.length > 0 && (
            <span className="tc-fold-faces" aria-hidden="true">
              {/* Up to three; past that two and how many more, leaving room for the word beside them in the card's width. */}
              {(agents.length > 3 ? agents.slice(0, 2) : agents).map((a) => (
                <span key={a.lane} className="tc-face" style={{ "--tint": agentLook(state, a.lane, 11).tint } as React.CSSProperties}>
                  {agentLook(state, a.lane, 11).mark}
                  <i className={`tc-dot is-${toneOf(a)}`} />
                </span>
              ))}
              {agents.length > 3 && <span className="tc-fold-more">+{agents.length - 2}</span>}
            </span>
          )}
        </button>
        {may && (
          <button type="button" className="tc-end-btn" aria-label="What the chat shows, and the lead" title="What the chat shows, and the lead" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); agentMenu(r.right - 240, r.bottom + 4); }}>
            <Icon name="more" size={14} />
          </button>
        )}
      </div>
      {!folded && (
        <>
          <ul className="tc-list">
            {agents.map((a) => {
              const tone = toneOf(a);
              const look = agentLook(state, a.lane, 13);
              const line = firstLine(a.line);
              // Done: what proves it (Arun, 2026-11-16, "Do 3": proof before done), else its last words.
              const proof = tone === "done" ? lastProof(events, a.lane, agentNameFor(state, a.lane), state.id) : null;
              const said = proof ? proofLine(proof) : null;
              const sub = tone === "done" ? (said ? `Done · ${said.text}` : line ? `Done · ${line.replace(/^done[:.\s—-]*/i, "")}` : "Done") : line || a.now.word;
              const time = tone === "work" && a.startedAt ? clock(now - a.startedAt) : tone === "done" && a.startedAt && a.endedAt ? clock(a.endedAt - a.startedAt) : "";
              const on = focused === a.lane;
              return (
                <li key={a.lane}>
                  {proof && said ? (
                    // Its proof opens beside the card, level with the agent's row, never over the card itself.
                    <Popover>
                      <PopoverAnchor asChild>
                  <div
                    role="button"
                    tabIndex={0}
                    className={cn("tc-agent", on && "on", `is-${tone}`)}
                    onClick={() => focusAgent(sid, on ? "all" : a.lane)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), focusAgent(sid, on ? "all" : a.lane))}
                    onContextMenu={may ? (e) => (e.preventDefault(), agentMenu(e.clientX, e.clientY, a.lane)) : undefined}
                    {...dragAgent(a.lane)}
                    title={on ? "Back to every agent's work" : `Only ${agentNameFor(state, a.lane)}'s work · drag onto the chat to see it side by side`}
                    aria-label={`${agentNameFor(state, a.lane)}${state.lead === a.lane ? ", leads the others" : ""}: ${sub}${time ? `, ${time}` : ""}`}
                    aria-pressed={on}
                  >
                    <span className="tc-ring-slot"><TabRing state={TONE_RING[tone]} /></span>
                    <span className="tc-mark" style={{ "--tint": look.tint } as React.CSSProperties}>
                      {look.mark}
                    </span>
                    <span className="tc-agent-main">
                      <span className="tc-agent-name">
                        <span className="tc-trunc">{agentNameFor(state, a.lane)}</span>
                        {state.lead === a.lane && <span className="tc-lead" role="img" aria-label="Leads the other agents" title="Leads the other agents"><Icon name="crown" size={13} /></span>}
                        {time && <span className="tc-time">{time}</span>}
                      </span>
                      {proof && said ? (
                        <PopoverTrigger asChild>
                          <button type="button" className={cn("tc-agent-sub tc-proof", said.tone && `is-${said.tone}`)} onClick={(e) => e.stopPropagation()} aria-label={`Proof: ${said.text}`} title="What proves it: the checks, the changes, the picture, its own review">
                            {sub}
                          </button>
                        </PopoverTrigger>
                      ) : (
                        <span className="tc-agent-sub" title={a.line}>
                          {sub}
                        </span>
                      )}
                    </span>
                    <span className="tc-agent-end">
                      {tone === "need" && (
                        <button type="button" className="tc-answer" onClick={(e) => (e.stopPropagation(), answer(a.lane))}>
                          Answer
                        </button>
                      )}
                      {may && <AgentMore lane={a.lane} name={agentNameFor(state, a.lane)} />}
                    </span>
                  </div>
                      </PopoverAnchor>
                      <PopoverContent side="left" align="start" sideOffset={20} collisionPadding={12} className="tc-proof-pop" onClick={(e) => e.stopPropagation()}>
                        <ThreadProof proof={proof} name={agentNameFor(state, a.lane)} look={look} picture={proof.page?.file && proof.page.sid === sid ? fileUrl(sid, invite, proof.page.file) : null} onChanges={onChanges} onWork={() => focusAgent(sid, a.lane)} />
                      </PopoverContent>
                    </Popover>
                  ) : (
                  <div
                    role="button"
                    tabIndex={0}
                    className={cn("tc-agent", on && "on", `is-${tone}`)}
                    onClick={() => focusAgent(sid, on ? "all" : a.lane)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), focusAgent(sid, on ? "all" : a.lane))}
                    onContextMenu={may ? (e) => (e.preventDefault(), agentMenu(e.clientX, e.clientY, a.lane)) : undefined}
                    {...dragAgent(a.lane)}
                    title={on ? "Back to every agent's work" : `Only ${agentNameFor(state, a.lane)}'s work · drag onto the chat to see it side by side`}
                    aria-label={`${agentNameFor(state, a.lane)}${state.lead === a.lane ? ", leads the others" : ""}: ${sub}${time ? `, ${time}` : ""}`}
                    aria-pressed={on}
                  >
                    <span className="tc-ring-slot"><TabRing state={TONE_RING[tone]} /></span>
                    <span className="tc-mark" style={{ "--tint": look.tint } as React.CSSProperties}>
                      {look.mark}
                    </span>
                    <span className="tc-agent-main">
                      <span className="tc-agent-name">
                        <span className="tc-trunc">{agentNameFor(state, a.lane)}</span>
                        {state.lead === a.lane && <span className="tc-lead" role="img" aria-label="Leads the other agents" title="Leads the other agents"><Icon name="crown" size={13} /></span>}
                        {time && <span className="tc-time">{time}</span>}
                      </span>
                      <span className="tc-agent-sub" title={a.line}>
                        {sub}
                      </span>
                    </span>
                    <span className="tc-agent-end">
                      {tone === "need" && (
                        <button type="button" className="tc-answer" onClick={(e) => (e.stopPropagation(), answer(a.lane))}>
                          Answer
                        </button>
                      )}
                      {may && <AgentMore lane={a.lane} name={agentNameFor(state, a.lane)} />}
                    </span>
                  </div>
                  )}
                </li>
              );
            })}
            {starting.map((s) => (
              <li key={`starting-${s.tool}`}>
                <div className="tc-agent is-work">
                  <span className="tc-ring is-work" aria-hidden />
                  <span className="tc-mark">
                    <EngineMark tool={s.tool} size={13} />
                  </span>
                  <span className="tc-agent-main">
                    <span className="tc-agent-name">{ENGINE_NAMES[s.tool]}</span>
                    <span className="tc-agent-sub">Starting…</span>
                  </span>
                  <span />
                </div>
              </li>
            ))}
          </ul>
          <Suspense fallback={null}>
            <HandedRows state={state} events={events} onPick={() => {}} />
          </Suspense>
          <OpenedList events={events} />
          {may && (
            <div className="tc-foot">
              <button type="button" className="tc-foot-btn" aria-label="Add an agent" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAdd(add ? null : { x: r.left, y: r.bottom + 4 }); }} aria-expanded={!!add}>
                <Icon name="plus" size={13} />
                Add agent
              </button>
              {working > 0 && (
                <button type="button" className="tc-foot-btn" onClick={stopAll} title="Stop every agent at work: each stays here for the next task">
                  <Icon name="stop" size={12} />
                  Stop all
                </button>
              )}
            </div>
          )}
        </>
      )}
      {add && (
        <ContextMenu
          at={add}
          onClose={() => setAdd(null)}
          items={() => [
            ...crewRows(),
            { heading: "Add an agent" },
            ...splitTools(installedOn(identity)).here.map((t) => ({ label: ENGINE_NAMES[t], mark: <EngineMark tool={t} size={14} />, onSelect: () => onConnect(t) })),
            { label: "Other agents…", icon: "plus" as const, onSelect: () => onConnect() },
          ]}
        />
      )}
    </div>
  );
}

/** An agent's last finished run, as proof (team-proof.ts runProof): its checks, changes, picture and own review. */
const proofs = new Map<string, { at: number; proof: RunProof | null }>();
function lastProof(events: readonly SessionEvent[], lane: string, name: string, sid: string): RunProof | null {
  // Worked out again only when the log has grown: the card redraws every second while an agent works.
  const key = `${sid}|${lane}`;
  const at = events.at(-1)?.seq ?? 0;
  const kept = proofs.get(key);
  if (kept && kept.at === at) return kept.proof;
  const proof = findProof(events, lane, name, sid);
  proofs.set(key, { at, proof });
  return proof;
}
/** A run's proof with the run itself: how long it took, when it finished, and its closing words. */
type RunProof = Proof & { run: { ms: number; at: number; said: string } };
function findProof(events: readonly SessionEvent[], lane: string, name: string, sid: string): RunProof | null {
  let end: SessionEvent | null = null;
  let said = "";
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if ((e.lane ?? MAIN_LANE) !== lane) continue;
    if (!end) {
      if (e.body.type === "run.ended") end = e;
      continue;
    }
    if (!said && e.body.type === "agent.message" && e.body.text.trim()) said = e.body.text;
    if (e.body.type === "run.started") return { ...runProof(events, { lane, startSeq: e.seq, endSeq: end.seq }, name, name, sid), run: { ms: end.ts - e.ts, at: end.ts, said } };
  }
  return null;
}

/** What the proof shows in a few words: tests pass or failing (or none run), how many files, and a picture when there is one. */
export function proofLine(p: Proof): { text: string; tone?: "bad" | "warn" } {
  const ran = p.checks.filter((c) => !c.skipped);
  const failed = ran.filter((c) => !c.ok);
  const files = p.changed.files.length + p.changed.more;
  const parts = [failed.length ? `${failed.length === 1 ? "a check" : `${failed.length} checks`} failing` : ran.length ? "tests pass" : "no tests run", files ? `${files} file${files === 1 ? "" : "s"}` : "", p.page?.file ? "screenshot" : ""].filter(Boolean);
  return { text: parts.join(" · "), ...(failed.length ? { tone: "bad" as const } : !ran.length && files ? { tone: "warn" as const } : {}) };
}

/** The threads this one's agents opened (app-tools start_session), each with its ring: pressed, it opens. */
function OpenedList({ events }: { events: readonly SessionEvent[] }) {
  const threads = useContext(ThreadsCtx);
  const list = openedThreads(events);
  if (!list.length) return null;
  const open = (sid: string, invite: string) => dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid, invite } }));
  return (
    <div className="tc-opened">
      <div className="tc-opened-head">Threads they opened</div>
      {list.map((t) => (
        <button key={t.sid} type="button" className="tc-row" onClick={() => open(t.sid, t.invite)} title={`Opened by ${t.fromName}`}>
          <span className="tc-ic">{threads?.ring(t.sid, false) ?? <Icon name="message" size={14} />}</span>
          <span className="tc-text">{t.title}</span>
          <Icon name="arrowUpRight" size={14} className="tc-chev" />
        </button>
      ))}
    </div>
  );
}

/**
 * A done agent's proof, as the thread card shows it (Arun, 2026-11-16: "have proper typography and better refinement in design";
 * "a more refined and better typography design and more details"): who, when it finished and how long it took, and the verdict;
 * its closing words; what it did, checked and is unsure of, each with its mark; the checks with who ran them and, failing, what
 * they printed; the files by name, folder quieter, with what happened to each and a bar of what was added and taken out; the
 * page's picture; and the two places to go from it.
 */
function ThreadProof({ proof, name, look, picture, onChanges, onWork }: { proof: RunProof; name: string; look: { mark: React.ReactNode; tint: string }; picture: string | null; onChanges: () => void; onWork: () => void }) {
  const verdict = proofLine(proof);
  const ran = proof.checks.filter((c) => !c.skipped);
  const passed = ran.filter((c) => c.ok).length;
  const word = verdict.tone === "bad" ? "Failing" : ran.length ? "Tests pass" : "No tests run";
  const files = proof.changed.files;
  const count = files.length + proof.changed.more;
  const more = proof.changed.more + Math.max(0, files.length - 8);
  const took = proof.run.ms >= 60_000 ? `${Math.round(proof.run.ms / 60_000)} min` : `${Math.max(1, Math.round(proof.run.ms / 1000))} s`;
  const when = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(proof.run.at);
  const said = firstLine(proof.run.said).replace(/^#+\s*/, "").replace(/\*\*/g, "");
  const split = (p: string) => {
    const i = p.lastIndexOf("/");
    return i < 0 ? { dir: "", base: p } : { dir: p.slice(0, i + 1), base: p.slice(i + 1) };
  };
  /** Five cells for a file's change, green for what was added, red for what was taken out, as a diffstat draws it. */
  const bar = (add: number, del: number) => {
    const total = add + del;
    const g = total ? Math.round((add / total) * 5) : 0;
    return Array.from({ length: 5 }, (_, i) => (i < g ? "add" : i < (total ? 5 : 0) ? "del" : "none"));
  };
  const review = proof.review
    ? [
        { key: "did", label: "What it did", text: proof.review.done, icon: "check" as const },
        { key: "checked", label: "How it checked", text: proof.review.checked, icon: "search" as const },
        { key: "unsure", label: "Still unsure", text: proof.review.unsure, icon: "help" as const },
      ].filter((r) => r.text.trim() && !/^nothing\.?$/i.test(r.text.trim()))
    : [];
  return (
    <div className="tpf">
      <header className="tpf-head">
        <span className="tc-mark" style={{ "--tint": look.tint } as React.CSSProperties}>
          {look.mark}
        </span>
        <span className="tpf-who">
          <b>{name}</b>
          <span>
            Finished {when} · took {took}
          </span>
        </span>
        <span className={cn("tpf-verdict", verdict.tone ? `is-${verdict.tone}` : "is-ok")}>
          <span className="tpf-verdict-dot" aria-hidden />
          {word}
        </span>
      </header>
      {said && <p className="tpf-said">“{clipText(said, 220)}”</p>}
      {review.length ? (
        <dl className="tpf-review">
          {review.map((r) => (
            <div key={r.key} className={`is-${r.key}`}>
              <dt>
                <span className="tpf-ic" aria-hidden>
                  <Icon name={r.icon} size={12} />
                </span>
                {r.label}
              </dt>
              <dd>{r.text}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="tpf-note tpf-pad">It finished without saying how it checked its work or what is still uncertain.</p>
      )}
      <section className="tpf-sec">
        <h4>
          Checks
          <span>{ran.length ? `${passed} of ${ran.length} passed` : "none ran"}</span>
        </h4>
        {proof.checks.length ? (
          <ul className="tpf-list">
            {proof.checks.map((c) => (
              <li key={`${c.by}:${c.command}`} className={cn("tpf-check", c.skipped ? "is-none" : c.ok ? "is-ok" : "is-bad")}>
                <span className="tpf-state" aria-hidden>
                  <Icon name={c.skipped ? "minus" : c.ok ? "check" : "x"} size={11} />
                </span>
                <code title={c.command}>{c.command}</code>
                <span className="tpf-meta">{c.skipped ? "couldn't run" : c.by === "friday" ? "by Friday" : `by ${name}`}</span>
                {c.output && !c.ok && <pre className="tpf-out">{c.output}</pre>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="tpf-note">Nothing was run to show it works.</p>
        )}
      </section>
      <section className="tpf-sec">
        <h4>
          {count ? `${count} file${count === 1 ? "" : "s"} changed` : "Changed"}
          {count > 0 && (
            <span className="tpf-nums">
              <span className="tc-add">+{proof.changed.add}</span>
              <span className="tc-del">−{proof.changed.del}</span>
            </span>
          )}
        </h4>
        {files.length ? (
          <ul className="tpf-list">
            {files.slice(0, 8).map((f) => {
              const { dir, base } = split(f.path);
              const st = f.status === "added" ? "A" : f.status === "deleted" ? "D" : f.status === "renamed" ? "R" : "M";
              return (
                <li key={f.path} className="tpf-file" title={f.path}>
                  <span className={`tpf-st is-${st}`} aria-label={f.status}>
                    {st}
                  </span>
                  <span className="tpf-path">
                    <span className="tpf-base">{base}</span>
                    {dir && <span className="tpf-dir">{dir}</span>}
                  </span>
                  <span className="tpf-nums">
                    {f.add > 0 && <span className="tc-add">+{f.add}</span>}
                    {f.del > 0 && <span className="tc-del">−{f.del}</span>}
                  </span>
                  <span className="tpf-bar" aria-hidden>
                    {bar(f.add, f.del).map((k, i) => (
                      <i key={i} className={`is-${k}`} />
                    ))}
                  </span>
                </li>
              );
            })}
            {more > 0 && <li className="tpf-note">and {more} more</li>}
          </ul>
        ) : (
          <p className="tpf-note">No files changed.</p>
        )}
      </section>
      {picture && (
        <section className="tpf-sec">
          <h4>The page</h4>
          <a className="tpf-shot" href={picture} target="_blank" rel="noreferrer">
            <img src={picture} alt={`The page as ${name} left it`} loading="lazy" />
          </a>
        </section>
      )}
      {proof.flags.length > 0 && (
        <ul className="tpf-flags">
          {proof.flags.map((f) => (
            <li key={f.text}>
              <Icon name="flag" size={12} />
              {f.text}
            </li>
          ))}
        </ul>
      )}
      <footer className="tpf-foot">
        {count > 0 && (
          <button type="button" className="tpf-btn" onClick={onChanges}>
            <Icon name="file" size={13} />
            Open changes
          </button>
        )}
        <button type="button" className="tpf-btn" onClick={onWork}>
          <Icon name="list" size={13} />
          Show its work
        </button>
      </footer>
    </div>
  );
}
