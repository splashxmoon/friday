import { useEffect, useMemo, useRef, useState } from "react";
import { attributionOf } from "../attribution.js";
import { parseRepo } from "../runner/repo.js";
import type { FolderInfo } from "../runner/workspace.js";
import { can, canDriveLane, driverOf, runOf, type SessionState } from "../session/projection.js";
import { ENGINE_MODELS, ENGINE_NAMES, ENGINE_TOOLS, MAIN_LANE, type EngineMode, type EngineTool, type Member, type SessionEvent } from "../types.js";
import { DiffCard, reviewVia } from "./Activity.js";
import { ChangeBar } from "./DiffView.js";
import { EngineMark } from "./BrandMarks.js";
import { AccountPicker } from "./Accounts.js";
import { Icon } from "./icons.js";
import { LoginNotice, MachineLine, NoMachine, hostApi, toolLabel, useMachine } from "./local.js";
import { isScratch, localSessionFolder } from "./quickConnect.js";
import { loadRecentFolders, saveRecentFolder, type Identity } from "./storage.js";
import { MoreTools, relTime, useDismiss } from "./ui.js";
import { splitTools } from "./engines.js";
import type { Send } from "./useSession.js";
import { AlsoWorksIn, WorkspacePill, type Picked } from "./Workspace.js";
import { BranchButton } from "./Branches.js";
import { ShipFlow } from "./ShipFlow.js";

/**
 * Bring your own coding agent: the session's view of lanes that run on
 * someone's own Claude Code, Codex or Cursor instead of Friday Code.
 *
 * Friday holds no key for any of them. The CLI runs on the host's machine
 * under their login; a small runner relays the session to it.
 */

const laneName = (s: SessionState, id: string) => (id === MAIN_LANE ? "Main" : (s.lanes.find((l) => l.id === id)?.name ?? id));

const MODES: { id: EngineMode; label: string; blurb: string }[] = [
  { id: "plan", label: "Plan", blurb: "Reads and proposes, and asks before it runs a command. Changes nothing." },
  { id: "edits", label: "Manual", blurb: "Edits files, and asks you before it runs a command." },
  { id: "full", label: "Auto", blurb: "Edits and runs commands without asking. Anyone driving this agent can." },
];
/** Codex and Cursor cannot ask about one command at a time, so Manual asks once for the whole turn. */
const blurbFor = (m: { id: EngineMode; blurb: string }, tool: string) => (m.id === "edits" && (tool === "codex" || tool === "cursor") ? "Asks you before any turn that changes something." : m.blurb);

export function ConnectDialog({
  state,
  me,
  sid,
  invite,
  identity,
  send,
  lane,
  tool: initialTool,
  from,
  onClose,
}: {
  state: SessionState;
  me: Member;
  sid: string;
  invite: string;
  identity: Identity;
  send: Send;
  /** "" = let the person pick; otherwise reconnect this lane. */
  lane: string;
  /** Open already on this agent ("" is just a folder for Friday Code), for when it was picked from the switcher. */
  tool?: EngineTool | "";
  /** The lane handing work over, when a hand-off couldn't bring the agent in by itself: its folder is offered first. */
  from?: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  const { state: machine, refresh } = useMachine(identity);
  const hasMachine = machine.mode === "local" || machine.mode === "linked";
  const existing = lane ? state.engines[lane] : null;
  // "" is Friday's own agent working in the folder: the computer lends it, and
  // nothing has to be installed or logged in for files, the terminal and the
  // preview to work.
  const [tool, setTool] = useState<EngineTool | "">(initialTool !== undefined ? initialTool : existing ? (existing.tool ?? "") : "claude");
  // The mode picked by hand: reconnecting a lane that had switched to Plan for a question made that Plan its own for good.
  const [mode, setMode] = useState<EngineMode>(existing?.handMode ?? existing?.mode ?? "full");
  const [moreTools, setMoreTools] = useState(false);
  const [model, setModel] = useState(existing?.model ?? "");
  // Which of the tool's accounts on the computer: the one it was on, else "" for whichever has most room (runner/accounts.ts).
  const [account, setAccount] = useState(existing?.account?.id ?? "");
  // Where it runs: the main lane (instead of Friday Code) or a new lane beside it.
  const drivable = [MAIN_LANE, ...state.lanes.filter((l) => l.control.kind !== "standing").map((l) => l.id)].filter((id) => canDriveLane(state, me.id, id));
  // An owner can add a lane to the room; anybody else who can steer can add one
  // for their own agent, which is what they want here — theirs, under their own
  // login, rather than a seat on a lane that is somebody else's.
  const mayAdd = me.role === "owner" || (me.role !== "viewer" && can(state, me.id, "control"));
  const [where, setWhere] = useState<string>(lane || (mayAdd ? "new" : (drivable[0] ?? MAIN_LANE)));
  const [picked, setPicked] = useState<Picked | null>(
    existing?.cwd ? { folder: { path: existing.cwd, name: existing.cwd.split(/[\\/]/).pop() || existing.cwd, isRepo: !!existing.branch, branch: existing.branch } } : null,
  );
  const folder = picked?.folder ?? null;
  // The folders beside it the tool may work in too, once changed here (see AlsoWorksIn); null keeps those kept for the folder.
  const [dirs, setDirs] = useState<string[] | null>(null);
  useEffect(() => setDirs(null), [folder?.path]);
  /**
   * Working without a folder, said out loud.
   *
   * Somebody joining a session from another computer does not have the folder
   * it is working in, and that is not a reason they cannot bring their own
   * agent into it. The dialog used to refuse to go any further without one,
   * which meant a teammate on their own laptop could watch the session but
   * never take part with their own Claude.
   */
  const [noFolder, setNoFolder] = useState(false);
  const hasCode = !!folder || noFolder;
  // Another agent already editing this folder: a second writer would overwrite
  // it, so the default is a worktree of its own, on its own branch.
  const norm = (p: string) => p.replace(/[\\/]+$/, "");
  const taken = !!folder && Object.entries(state.engines).some(([id, e]) => id !== lane && e.online && e.mode !== "plan" && norm(e.cwd) === norm(folder.path));
  const [ownPick, setOwnPick] = useState<boolean | null>(null);
  // Only for a new lane, and only if it may write: reading needs no copy. A folder not in git yet is made a repository first,
  // on this computer only (the runner's startRepo), so it can have copies too.
  const canSplit = where === "new" && !!folder && mode !== "plan";
  // A copy only when picked: Friday made one by itself whenever the folder was taken (Arun, 2026-10-24). Otherwise it shares the
  // folder with the agent editing it (EngineInfo.shared).
  const own = canSplit && (ownPick ?? false);
  /**
   * What the server would refuse: a second agent that may edit, in a folder another agent is editing (one writer per folder,
   * EngineHub). Said here, before Connect, with who it is and the ways out, rather than left to a refusal whose reason the
   * hosted server's proxy used to swallow ("connection closed (1005)").
   */
  const holder = folder ? Object.entries(state.engines).find(([id, e]) => id !== lane && e.online && e.mode !== "plan" && norm(e.cwd) === norm(folder.path))?.[1] : undefined;
  const shares = !!holder && mode !== "plan" && !own;
  // Shared by choice, so nothing is refused: one writer per folder no longer stands in the way.
  const clash = false;
  const holderName = holder ? `${holder.hostName.split(" ")[0]}'s ${holder.tool ? ENGINE_NAMES[holder.tool] : "Friday Code"}` : "";
  // A held folder takes this one in Plan, so the choice shows Plan rather than an option Connect would refuse. Once per
  // folder: somebody who then picks Manual is told why Connect waits, instead of being moved back. Never for an agent being
  // changed: its mode is what its owner set, and the note says why Connect waits.
  const planFor = useRef("");
  useEffect(() => {
    if (existing || !clash || !folder || planFor.current === folder.path) return;
    planFor.current = folder.path;
    setMode("plan");
  }, [clash, folder?.path]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Where it works and which model are choices most people leave alone, so they sit behind one line.
  const [advanced, setAdvanced] = useState(false);
  // One question at a time: agent, then code, then what it may do.
  const [step, setStep] = useState(0);

  // Someone joining a session almost always has the same repo. If that folder
  // is on their machine too, start from it rather than making them find it.
  // Done looking: the session's folder was found here, or there is none to find.
  const [prefilled, setPrefilled] = useState(!!picked);
  useEffect(() => {
    if (picked || !hasMachine) return;
    let live = true;
    // The same folders a hand-off would use, in the same order, and none of them an agent's scratch space or a path that
    // only exists on somebody else's machine. Nothing found here: they keep it somewhere else, and the picker is right there.
    void localSessionFolder(identity, state, from).then((f) => {
      if (!live) return;
      if (f) setPicked({ folder: f });
      setPrefilled(true);
    });
    return () => {
      live = false;
    };
  }, [hasMachine]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The repository this session's folder came from, if it came from one.
   *
   * The folder is on the other computer; the repository is not. Cloning it here
   * is the way to get the same code on this computer, and it is the answer most
   * people want when they join from a second laptop.
   */
  const [repo, setRepo] = useState<{ url: string; name: string } | null>(null);
  const [cloning, setCloning] = useState(false);
  /** The folder cloned here to join, which starts on the session's branch rather than the repository's default. */
  const [cloned, setCloned] = useState("");
  const sessionBranch = state.engines[MAIN_LANE]?.branch ?? Object.values(state.engines).find((e) => e.branch)?.branch;
  const sessionHasFolder = Object.values(state.engines).some((e) => !!e.cwd);
  useEffect(() => {
    if (!sessionHasFolder || !hasMachine) return;
    let live = true;
    void fetch(`/api/sessions/${encodeURIComponent(sid)}/remote?invite=${encodeURIComponent(invite)}`)
      .then((r) => r.json() as Promise<{ remote?: { url?: string } }>)
      .then((d) => {
        const url = d.remote?.url;
        if (live && url) setRepo({ url, name: url.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).slice(-2).join("/") });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [sid, invite, sessionHasFolder, hasMachine]);

  const cloneHere = async () => {
    if (!repo) return;
    setCloning(true);
    setErr("");
    try {
      const r = await hostApi<{ folder: FolderInfo }>(identity, "/api/runner/clone", { method: "POST", body: JSON.stringify({ repo: repo.url }) });
      setCloned(r.folder.path);
      chose({ folder: r.folder });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setCloning(false);
    }
  };

  const target = where === "new" ? { newLane: tool ? ENGINE_NAMES[tool] : "Your folder" } : { lane: where };
  const found = hasMachine && tool ? (machine.tools.find((t) => t.tool === tool) ?? null) : null;
  // Nothing to install, nothing to log into: a folder is ready the moment a
  // machine is connected.
  const ready = tool ? !!found?.path && found.loggedIn !== false : hasMachine;

  const start = async () => {
    if (!hasCode) return;
    setBusy(true);
    setErr("");
    try {
      await hostApi(identity, "/api/runner/start", {
        method: "POST",
        body: JSON.stringify({
          sid,
          invite,
          ...(tool ? { tool } : {}),
          // A folder somebody else is editing is joined as a reader, rather than refused: one writer per folder.
          mode: clash ? "plan" : mode,
          ...(model.trim() ? { model: model.trim() } : {}),
          ...(tool && account && found?.accounts?.some((a) => a.id === account) ? { account } : {}),
          ...(folder ? { cwd: folder.path } : { noFolder: true }),
          ...(folder && tool && dirs ? { dirs } : {}),
          ...(own ? { worktree: "lane" } : shares ? { share: true } : {}),
          // Carrying on from a conversation: on the branch it was working on, when the folder is on another.
          ...(!own && folder?.isRepo && picked?.resume?.branch && picked.resume.branch !== folder.branch ? { branch: picked.resume.branch } : {}),
          // No count for a transcript too long to read whole: the part that was read says nothing about the rest.
          ...(picked?.resume ? { resumeId: picked.resume.id, resumeTitle: picked.resume.title, resumeMessages: picked.resume.approx ? 0 : picked.resume.messages, resumeTool: picked.resume.tool } : {}),
          // Cloned here to join: on the session's branch as it was pushed. The runner fetches it, and leaves it if it never was.
          ...(!own && !picked?.resume && folder && folder.path === cloned && sessionBranch && sessionBranch !== folder.branch ? { followBranch: sessionBranch } : {}),
          ...target,
        }),
      });
      if (folder) saveRecentFolder(folder.path);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };


  const tools = splitTools(hasMachine ? (t) => !!machine.tools.find((x) => x.tool === t)?.path : null, tool);
  const stateOf = (t: EngineTool) => {
    const f = hasMachine ? machine.tools.find((x) => x.tool === t) : null;
    if (!hasMachine) return { text: "on your computer", tone: "" };
    if (!f?.path) return { text: "Not installed", tone: "off" };
    if (f.loggedIn === false) return { text: "Sign in needed", tone: "warn" };
    return { text: "Ready", tone: "ok" };
  };
  // Saved ones too: the old pre-fill saved agents' scratch folders among them.
  // Not an agent's own copy of a folder (`<folder>-<8 hex>`, beside the folder it copies): offered as code of its own, four
  // copies of one repo read as four repos (Arun, 2026-10-24: "streamline this process too make it smarter and easy to use").
  // The session's own folder first, said to be it.
  const mainCwd = state.engines[MAIN_LANE]?.cwd ?? "";
  const known = hasMachine ? [...new Set([mainCwd, ...Object.values(state.engines).map((e) => e.cwd), ...loadRecentFolders()])].filter((p) => p && !isScratch(p)) : [];
  // The session's own folder is never hidden, even when it is itself a copy (a worktree of a repo also in the list).
  const recents = known.filter((p) => p === mainCwd || !isCopyOf(p, known)).slice(0, 4);
  const pickRecent = (path: string) =>
    void hostApi<{ folder: FolderInfo }>(identity, `/api/runner/describe?path=${encodeURIComponent(path)}`).then(
      (r) => chose({ folder: r.folder }),
      () => setErr("That folder isn't on this computer any more."),
    );
  const whereLabel = where === "new" ? (me.role === "owner" ? "A new agent, beside Friday Code" : "As my own agent") : where === MAIN_LANE ? "In place of the main agent" : `In place of “${laneName(state, where)}”`;
  const whyNot = busy ? "" : !hasCode ? "Choose the code it works on, or work without a folder" : clash ? "Pick Plan to connect" : tool && found && !found.path ? `${ENGINE_NAMES[tool]} isn't installed on this computer` : tool && found?.loggedIn === false ? `Sign in to ${ENGINE_NAMES[tool]} first` : "";

  const agentOk = !tool || (!!found?.path && found.loggedIn !== false);
  const canNext = step === 0 ? agentOk : step === 1 ? hasCode : true;
  // Opened on an agent (a handoff, the agent menu), it skips what is already answered: an agent that is ready, and the code
  // when the session's folder is here. Once, so it never moves somebody who has started choosing.
  // Opened from + too, with the agent it starts on (Claude Code) ready and the session's folder found here: both answered, so
  // it opens on one screen, the two answers on a line each with Change beside them, and what it may do (`quick`).
  const skipped = useRef(false);
  const [quick, setQuick] = useState(false);
  useEffect(() => {
    if (skipped.current || !hasMachine) return;
    if (!agentOk) return void (skipped.current = true);
    if (!prefilled) return;
    skipped.current = true;
    if (folder) {
      setQuick(true);
      setStep(2);
    } else if (initialTool !== undefined) setStep(1);
  }, [hasMachine, agentOk, prefilled, folder]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Back to one of the answers from the one-screen view: the steps show again from there. */
  const change = (to: number) => {
    setQuick(false);
    setStep(to);
  };
  // Choosing the code is the answer to its step: go on to the last one rather than waiting for Next.
  const chose = (p: Picked | null) => {
    setNoFolder(false);
    setPicked(p);
    if (p) setStep(2);
  };
  const last = step === 2;
  const STEPS = ["Agent", "Code", "Access"];

  return (
    <div className="overlay">
      <form
        className="modal engine-modal cd"
        ref={ref as unknown as React.RefObject<HTMLFormElement>}
        role="dialog" aria-modal="true"
        aria-label="Connect your coding agent"
        onSubmit={(e) => {
          e.preventDefault();
          if (!last) {
            if (canNext) setStep(step + 1);
            return;
          }
          if (!busy && hasCode && ready) void start();
        }}
      >
        <header className="cd-head">
          <div className="cd-head-text">
            <h2>{existing ? "Reconnect this agent" : "Work on code on your computer"}</h2>
            <p>
              {tool
                ? "It runs on your computer, under your own login. Friday never sees a key, and everyone here can watch and steer it."
                : "Your computer lends the folder and Friday Code works in it, with the files, terminal and preview shown here. Nothing to install."}
            </p>
          </div>
          <button type="button" className="icon-btn tiny" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </header>

        {machine.mode === "checking" ? (
          <p className="cd-note">Looking for your computer…</p>
        ) : !hasMachine ? (
          // No machine yet: the desktop app is what connects one.
          <NoMachine className="cd-note" />
        ) : (
          <>
            <div className="cd-machine">
              <MachineLine identity={identity} state={machine} refresh={refresh} />
            </div>

            {!(quick && last) && (
            <ol className="cd-steps" aria-label="Progress">
              {STEPS.map((label, i) => (
                <li key={label} className={i === step ? "now" : i < step ? "done" : ""}>
                  <button type="button" disabled={i > step && !canNext} onClick={() => setStep(i)}>
                    <span>{i < step ? <Icon name="check" size={11} /> : i + 1}</span>
                    {label}
                  </button>
                </li>
              ))}
            </ol>
            )}

            {quick && last && (
              <div className="cd-sum" aria-label="What it will be">
                <button type="button" className="cd-sum-row" onClick={() => change(0)}>
                  <span className="cd-sum-k">Agent</span>
                  <span className="cd-sum-v">
                    <EngineMark tool={tool} size={15} />
                    {tool ? ENGINE_NAMES[tool] : "Friday Code"}
                    {account && found?.accounts?.find((a) => a.id === account) && <span className="cd-sum-sub">{found.accounts.find((a) => a.id === account)!.label}</span>}
                  </span>
                  <span className="cd-sum-change">Change</span>
                </button>
                <button type="button" className="cd-sum-row" onClick={() => change(1)}>
                  <span className="cd-sum-k">Code</span>
                  <span className="cd-sum-v" title={folder?.path}>
                    <Icon name="folder" size={14} />
                    {folder ? folderName(folder.path) : "No folder"}
                    {folder && (own ? <span className="cd-sum-sub">its own copy, on a new branch</span> : folder.branch ? <span className="cd-sum-sub">on {folder.branch}</span> : null)}
                  </span>
                  <span className="cd-sum-change">Change</span>
                </button>
              </div>
            )}

            {step === 0 && (
            <section className="cd-step">
              <h3>Which agent should do the work?</h3>
              <div className="cd-tools" role="radiogroup" aria-label="Coding agent">
                {/* First, because it needs nothing: a folder and Friday's own agent
                    is the path for someone who has no CLI installed at all. */}
                <button type="button" role="radio" aria-checked={tool === ""} className={`cd-tool ${tool === "" ? "on" : ""}`} onClick={() => setTool("")}>
                  <span className="cd-tool-icon">
                    <EngineMark tool="" size={18} />
                  </span>
                  <span className="cd-tool-name">Friday Code</span>
                  <span className="cd-pill ok">Always ready</span>
                </button>
                {[...tools.here, ...(moreTools ? tools.away : [])].map((t) => {
                  const st = stateOf(t);
                  return (
                    <button key={t} type="button" role="radio" aria-checked={tool === t} className={`cd-tool ${tool === t ? "on" : ""}`} onClick={() => setTool(t)}>
                      <span className="cd-tool-icon">
                        <EngineMark tool={t} size={18} />
                      </span>
                      <span className="cd-tool-name">{ENGINE_NAMES[t]}</span>
                      <span className={`cd-pill ${st.tone}`}>{st.text}</span>
                    </button>
                  );
                })}
                <MoreTools open={moreTools} count={tools.away.length} onToggle={() => setMoreTools((v) => !v)} className="cd-more" />
              </div>
              {tool && found && !found.path && (
                <p className="cd-callout warn">
                  {ENGINE_NAMES[tool]} isn't installed on {machine.machine?.name ?? "this computer"}. Install it there, then come back: this list updates by itself.
                </p>
              )}
              {found?.path && <LoginNotice identity={identity} tool={found} onRecheck={refresh} />}
              {found?.path && found.loggedIn !== false && <AccountPicker identity={identity} tool={found} value={account} onChange={setAccount} onChanged={refresh} />}
            </section>
            )}

            {step === 1 && (
            <section className="cd-step">
              <h3>Which code should it work on?</h3>
              {/* A list, one row a folder: its name, where it is and its branch, the session's own marked and first, the one
                  picked ticked (Arun, 2026-10-24: "design this better too"). Then the ways to other code: any folder or repo
                  on this computer, the session's repo cloned here, or none. */}
              <div className="cd-folders" role="radiogroup" aria-label="Code it works on">
                {[...recents, ...(folder && !recents.includes(folder.path) ? [folder.path] : [])].map((p) => {
                  const on = folder?.path === p;
                  return (
                    <button key={p} type="button" role="radio" aria-checked={on} className={`cd-folder ${on ? "on" : ""}`} title={p} onClick={() => (on ? setStep(2) : pickRecent(p))}>
                      <span className="cd-folder-icon">
                        <Icon name="folder" size={15} />
                      </span>
                      <span className="cd-folder-text">
                        <span className="cd-folder-name">
                          {folderName(p)}
                          {p === mainCwd && <span className="cd-chip-tag">This session's</span>}
                        </span>
                        <span className="cd-folder-path">
                          {tidyPath(p, machine.home)}
                          {on && folder?.branch ? ` · ${folder.branch}` : ""}
                        </span>
                      </span>
                      {on && <Icon name="check" size={15} className="cd-folder-check" />}
                    </button>
                  );
                })}
                {/* Resuming belongs to a CLI's own history; lending a folder has none. */}
                <WorkspacePill className="cd-folder cd-folder-more" text="Another folder or repo…" identity={identity} tool={tool || "claude"} value={folder} resume={tool ? picked?.resume : undefined} onPick={chose} onTool={setTool} />
                {/* The way in for somebody on a second computer: the session's code is on the first one, so there is nothing
                    here to pick. */}
                {!folder && repo && (
                  <button type="button" className="cd-folder cd-folder-more" disabled={cloning} onClick={() => void cloneHere()} title={`Clone ${repo.name} onto this computer`}>
                    {cloning ? <span className="spinner" /> : <Icon name="download" size={14} />}
                    <span className="ws-pill-text">Clone {repo.name} here</span>
                  </button>
                )}
                {/* A scratch space, not the session's code: for an agent that reads, plans and answers without touching any files. */}
                {!folder && tool && (
                  <button type="button" role="radio" aria-checked={noFolder} className={`cd-folder cd-folder-more ${noFolder ? "on" : ""}`} onClick={() => (setNoFolder(!noFolder), setPicked(null))}>
                    <Icon name="agent" size={14} />
                    <span className="ws-pill-text">No folder: a blank space, not the session's code</span>
                  </button>
                )}
              </div>
              {folder && tool && <AlsoWorksIn identity={identity} folder={folder.path} value={dirs} onChange={setDirs} />}
              {/* What happens to it, by who carries it on: the tool that had it resumes it whole, from its own memory; any other
                  agent is only told its latest messages (up to sixty), which is also all the rest of the session gets. */}
              {picked?.resume && (
                <p className="cd-note">
                  {picked.resume.tool === tool ? (
                    <>
                      Continues “{picked.resume.title}” in {ENGINE_NAMES[tool]}'s own memory. Its latest messages are also shared with this session, so every agent in it can work from them.
                    </>
                  ) : (
                    <>
                      Carries on from “{picked.resume.title}”. {tool ? ENGINE_NAMES[tool] : "Friday Code"} can't resume a {ENGINE_NAMES[picked.resume.tool]} conversation, so its latest messages are shared with this session as history instead.
                    </>
                  )}
                </p>
              )}
            </section>
            )}

            {last && (
            <>
            {quick ? (
              // On the one screen, each choice is a row of three or two, and a line on the one picked: the cards below say the
              // same at three times the height.
              <>
                <section className="cd-step">
                  <h3>What may it do without asking?</h3>
                  <div className="cd-seg" role="radiogroup" aria-label="What it may do without asking">
                    {MODES.map((m) => (
                      <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className={mode === m.id ? "on" : ""} onClick={() => setMode(m.id)}>
                        <Icon name={m.id === "plan" ? "eye" : m.id === "edits" ? "pencil" : "zap"} size={13} />
                        {m.label}
                      </button>
                    ))}
                  </div>
                  <p className="cd-seg-note">{blurbFor(MODES.find((m) => m.id === mode) ?? MODES[0]!, tool ?? "")}</p>
                </section>
                {canSplit && (
                  <section className="cd-step">
                    <h3>Where does it work?</h3>
                    <div className="cd-seg" role="radiogroup" aria-label="Where it works">
                      <button type="button" role="radio" aria-checked={own} className={own ? "on" : ""} onClick={() => setOwnPick(true)}>
                        <Icon name="gitBranch" size={13} />
                        Its own copy
                      </button>
                      <button type="button" role="radio" aria-checked={!own} className={!own ? "on" : ""} onClick={() => setOwnPick(false)}>
                        <Icon name="folder" size={13} />
                        This folder
                      </button>
                    </div>
                    <p className="cd-seg-note">
                      {own
                        ? holder
                          ? `On its own branch, so it can't touch ${holderName}'s files. Merge it when it's done.`
                          : "On its own branch, so it can't overwrite anyone else's work. Merge it when it's done."
                        : taken
                          ? `Shared with ${holderName}: both edit it. Pick its own copy to keep their changes apart.`
                          : "The folder as it is, on its current branch."}
                    </p>
                  </section>
                )}
              </>
            ) : (
            <>
            <section className="cd-step">
              <h3>What may it do without asking?</h3>
              <div className="cd-modes" role="radiogroup" aria-label="What it may do without asking" aria-describedby={holder && folder ? "cd-held" : undefined}>
                {MODES.map((m) => (
                  <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className={`cd-mode ${mode === m.id ? "on" : ""}`} onClick={() => setMode(m.id)}>
                    <span className="cd-mode-top">
                      <Icon name={m.id === "plan" ? "eye" : m.id === "edits" ? "pencil" : "zap"} size={14} />
                      {m.label}
                    </span>
                    <span className="cd-mode-blurb">{blurbFor(m, tool ?? "")}</span>
                  </button>
                ))}
              </div>
            </section>

            {canSplit && (
              <section className="cd-step">
                <h3>Where does it work?</h3>
                <div className="cd-modes" role="radiogroup" aria-label="Where it works">
                  <button type="button" role="radio" aria-checked={own} className={`cd-mode ${own ? "on" : ""}`} onClick={() => setOwnPick(true)}>
                    <span className="cd-mode-top">
                      <Icon name="gitBranch" size={14} />
                      Its own worktree
                    </span>
                    <span className="cd-mode-blurb">
                      {folder?.isRepo
                        ? "A separate copy on its own branch. It can't overwrite what others are doing, and you merge it when it's done."
                        : "This folder isn't in git yet, so Friday makes it a repository first: one commit of what's here, on this computer, never pushed. Then this agent gets its own copy on its own branch."}
                    </span>
                  </button>
                  <button type="button" role="radio" aria-checked={!own} className={`cd-mode ${!own ? "on" : ""}`} onClick={() => setOwnPick(false)}>
                    <span className="cd-mode-top">
                      <Icon name="folder" size={14} />
                      This folder
                    </span>
                    <span className="cd-mode-blurb">{taken ? `Shared with ${holderName}, who is editing it too: both can change it.` : "The folder as it is, on its current branch."}</span>
                  </button>
                </div>
              </section>
            )}

            </>
            )}

            {/* Stays while the folder is held, whatever is picked, so choosing Plan doesn't make the dialog jump. On the one
                screen the line under "Where does it work?" says it. */}
            {holder && folder && !quick && (
              <p className="cd-callout" id="cd-held">
                {own
                  ? `Its own worktree: it can edit without touching ${holderName}'s files.`
                  : mode === "plan"
                    ? `${holderName} is editing ${folder.name}; this one joins in Plan: it reads and advises without changing files.`
                    : `${holderName} is editing ${folder.name} too: both work in it, and each one's changes show in the other's diff.${canSplit ? " Pick “Its own worktree” above to keep them apart." : ""}`}
              </p>
            )}
            </>
            )}
          </>
        )}
        {err && <p className="cd-callout bad">{err}</p>}

        {hasMachine && (
          <footer className="cd-foot">
            <span className="cd-why" role="status">{last ? whyNot : step === 0 && !agentOk ? (tool && found && !found.path ? `${ENGINE_NAMES[tool]} isn't installed here` : tool ? `Sign in to ${ENGINE_NAMES[tool]} first` : "") : ""}</span>
            {step === 0 || (quick && last) ? (
              <button type="button" className="btn ghost small" onClick={onClose}>
                Cancel
              </button>
            ) : (
              <button type="button" className="btn ghost small" onClick={() => setStep(step - 1)}>
                Back
              </button>
            )}
            {last ? (
              <button type="submit" className="btn primary" disabled={busy || !hasCode || !ready || clash}>
                {busy ? <span className="spinner" /> : <Icon name={tool ? "plug" : "folder"} size={13} />} {tool ? `Connect ${ENGINE_NAMES[tool]}` : "Lend this folder"}
              </button>
            ) : (
              <button type="submit" className="btn primary" disabled={!canNext}>
                Next
              </button>
            )}
          </footer>
        )}
      </form>
    </div>
  );
}

/** Where a folder is, short: the home folder as ~. */
const tidyPath = (p: string, home: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);

/** A folder's own name: the last part of its path. */
const folderName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** An agent's own copy of a folder that is in the list too: `<folder>-<8 hex>` beside it (the runner's addWorktree). */
export function isCopyOf(p: string, all: readonly string[]): boolean {
  const m = /^(.*)-[0-9a-f]{8}$/.exec(p.replace(/[\\/]+$/, ""));
  return !!m && all.some((q) => q.replace(/[\\/]+$/, "") === m[1]);
}

/** The Diff tab: what each coding agent changed in its folder, as diffs. */
/** What has been committed from this session, newest first: the message, the branch, and the pull request if one was opened. */
function Commits({ events }: { events: SessionEvent[] }) {
  // A commit that couldn't be pushed is still a commit: listed, with what went wrong, rather than dropped where nobody sees it.
  const commits = events.flatMap((ev) => (ev.body.type === "folder.committed" ? [{ ev, b: ev.body }] : [])).reverse();
  if (!commits.length) return null;
  return (
    <section className="commits" aria-label="Commits">
      <h3 className="commits-h">Commits <span>{commits.length}</span></h3>
      <ol className="commits-list">
        {commits.map(({ ev, b }) => (
          <li key={ev.seq} className="commit-row">
            <span className="commit-dot"><Icon name="gitCommit" size={14} /></span>
            <div className="commit-main">
              <div className="commit-msg">{b.message.split(/\r?\n/)[0]}</div>
              <div className="commit-meta">
                <code>{b.sha.slice(0, 7)}</code>
                <span className="commit-branch"><Icon name="gitBranch" size={11} /> {b.branch}</span>
                <span>{b.files} file{b.files === 1 ? "" : "s"}</span>
                <span>{ev.actor.name} · {relTime(ev.ts)}</span>
              </div>
              {b.error && (
                <p className="error small commit-err" title={b.error}>
                  {b.error}
                </p>
              )}
            </div>
            {b.prUrl ? (
              <a className="commit-pr" href={b.prUrl} target="_blank" rel="noreferrer"><Icon name="gitPullRequest" size={12} /> {b.prCreated ? "PR opened" : "Open PR"}</a>
            ) : (
              b.pushed && <span className="commit-pushed">Pushed</span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

export function FilesPanel({
  state,
  onClose,
  bare = false,
  ship,
  events = [],
  lane,
}: {
  state: SessionState;
  onClose: () => void;
  bare?: boolean;
  /** The session's log, for the commits made from it. */
  events?: SessionEvent[];
  /** Who is looking and how to send, so the panel can offer to commit what it shows. */
  ship?: { me: Member; sid: string; invite: string; send: Send };
  /** Open on this agent's changes, when it has any (the active column of a split chat). */
  lane?: string;
}) {
  // Who wrote each added line by hand, from the lane's log (attribution.ts): a pencil on those lines, a word in the file's header.
  const attribution = useMemo(() => attributionOf(events, lane ?? MAIN_LANE), [events.length, lane]); // eslint-disable-line react-hooks/exhaustive-deps
  const ids = Object.keys(state.diffs);
  // Which agent's changes were picked, per session and in this browser only, so coming back to the session finds the same diff.
  const diffKey = `friday.diff.${state.id}`;
  const [pick, setPickNow] = useState<string | null>(() => {
    try {
      return lane ? null : localStorage.getItem(diffKey);
    } catch {
      return null;
    }
  });
  const setPick = (id: string | null) => {
    setPickNow(id);
    try {
      if (id) localStorage.setItem(diffKey, id);
      else localStorage.removeItem(diffKey);
    } catch {
      // Not kept: it opens on the first agent's changes next time.
    }
  };
  // Another agent's column starts on its own changes. Said while drawing: an effect would also run each time a kept panel is shown.
  const [pickOf, setPickOf] = useState(lane);
  if (pickOf !== lane) {
    setPickOf(lane);
    setPickNow(null);
  }
  const current = pick && state.diffs[pick] ? pick : lane && state.diffs[lane] ? lane : (ids[0] ?? null);
  const d = current ? state.diffs[current]! : null;
  const e = current ? state.engines[current] : null;
  const adds = d?.files.reduce((n, f) => n + f.additions, 0) ?? 0;
  const dels = d?.files.reduce((n, f) => n + f.deletions, 0) ?? 0;

  const body = (
    <>
      {ids.length > 1 && (
        <div className="art-tabs" role="tablist" aria-label="Agents with changes">
          {ids.map((id) => (
            <button key={id} role="tab" aria-selected={id === current} className={`art-tab ${id === current ? "on" : ""}`} onClick={() => setPick(id)}>
              <span className="art-tab-name">{laneName(state, id)}</span>
              <span className="art-tab-count">{state.diffs[id]!.files.length}</span>
            </button>
          ))}
        </div>
      )}
      <div className="doc-scroll">
        {d && d.files.length ? (
          <>
            <div className="files-bar dp-sum">
              {/* Whose machine, which folder and which commit this is against
                  were all written out above the files. The session header
                  already says where the work is happening, and the base
                  commit is a fact nobody was acting on — it was a line of
                  small grey text over every diff, paid for on every screen. */}
              {/* The branch was written here as text, which made changing it a
                  trip to a terminal. Same fact, made pressable. */}
              <span className="files-sum">
                <b>
                  {d.files.length} file{d.files.length === 1 ? "" : "s"} changed
                </b>
                <span className="diff-add">+{adds}</span>
                <span className="diff-del">−{dels}</span>
                <ChangeBar adds={adds} dels={dels} />
              </span>
              {ship && current && <BranchButton sid={ship.sid} invite={ship.invite} send={ship.send} lane={current} branch={e?.branch} />}
            </div>
            <DiffCard files={d.files} compact panel hideTitle attribution={attribution} {...(ship && current ? { review: { send: ship.send, via: reviewVia(state, ship.me, current), lane: current } } : {})} />
          </>
        ) : (
          <div className="dp-empty">
            <span className="dp-empty-icon">
              <Icon name="file" size={18} />
            </span>
            <b>No changes yet</b>
            <span>When an agent changes files, each one shows up here to read, comment on and tick off, with the way to commit them below.</span>
          </div>
        )}
        <Commits events={events} />
        {/* The way from this diff to a pull request: review, checks, commit, push. After the files and the commits already made, so it
            is the next thing to do once they have been read, and under the changed files when there are no commits yet. */}
        {ship && d && d.files.length > 0 && <ShipFlow key={current ?? "none"} state={state} lane={current ?? lane ?? MAIN_LANE} events={events} {...ship} />}
      </div>
    </>
  );

  if (bare) return body;
  return (
    <aside className="doc-panel files-panel" aria-label="Diff">
      <div className="doc-head">
        <Icon name="file" size={15} />
        <span className="doc-title">Diff</span>
        <span className="doc-count">{d ? `${d.files.length} changed` : "no changes yet"}</span>
        <span className="doc-actions">
          <button className="icon-btn tiny" title="Close" aria-label="Close files" onClick={onClose}>
            <Icon name="x" size={15} />
          </button>
        </span>
      </div>
      {body}
    </aside>
  );
}
