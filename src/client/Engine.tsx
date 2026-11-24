import { agentLook, laneLabel } from "./handoff-ui.js";
import { StateRing } from "./presence.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { attributionOf } from "../attribution.js";
import { parseRepo } from "../runner/repo.js";
import type { FolderInfo } from "../runner/workspace.js";
import { can, canDriveLane, driverOf, runOf, type SessionState } from "../session/projection.js";
import { ENGINE_MODELS, ENGINE_NAMES, ENGINE_TOOLS, MAIN_LANE, type DiffFile, type EngineMode, type EngineTool, type Member, type SessionEvent } from "../types.js";
import { DiffCard, reviewVia } from "./Activity.js";
import { ChangeBar } from "./DiffView.js";
import { EngineMark } from "./BrandMarks.js";
import { AccountPicker, preferredAccount } from "./Accounts.js";
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
import { isLocal } from "./edition.js";
import { isOwnModel } from "../own-model-id.js";
import { mayAddModelLane, modelLaneName, OwnHostMark } from "./model-lane-add.js";
import { useOwnModels } from "./ownModelStore.js";

/**
 * Bring your own coding agent: the session's view of lanes that run on
 * someone's own Claude Code, Codex or Cursor instead of Friday Code.
 *
 * Friday holds no key for any of them. The CLI runs on the host's machine
 * under their login; a small runner relays the session to it.
 */

const laneName = (s: SessionState, id: string) => (id === MAIN_LANE ? "Main" : (s.lanes.find((l) => l.id === id)?.name ?? id));

const MODES: { id: EngineMode; label: string; blurb: string }[] = [
  { id: "plan", label: "Read only", blurb: "Reads and proposes, and asks before it runs a command. Changes nothing." },
  { id: "edits", label: "Edits", blurb: "Edits files, and asks you before it runs a command." },
  // One person in the open-source edition: nobody else drives (2026-11-04 QA).
  { id: "full", label: "Full access", blurb: "Edits and runs commands without asking." },
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
  /**
   * One of your own models (Settings › Models), picked as the agent: Friday's agent on that model, working in the folder, as Add an
   * agent's "Your models" rows have it (model-lane-add.tsx). The message box offered these, this dialog didn't (splashxmoon/friday#32).
   * Only the session owner's, as the runtime runs no one else's; "" when a coding tool (or Friday Code) is the agent.
   */
  const ownModels = useOwnModels(identity);
  const mayOwn = mayAddModelLane(state, me, me.role === "owner" || can(state, me.id, "control")) && ownModels.length > 0;
  const ownWas = existing && !existing.tool ? (isOwnModel(existing.model) ? existing.model : lane === MAIN_LANE && isOwnModel(state.options.model) ? state.options.model : "") : "";
  const [ownModel, setOwnModel] = useState<string>(initialTool === undefined || initialTool === "" ? (ownWas ?? "") : "");
  const ownPicked = mayOwn && ownModel ? (ownModels.find((m) => m.choice === ownModel) ?? null) : null;
  const pickTool = (t: EngineTool | "") => (setTool(t), setOwnModel(""));
  const pickOwn = (choice: string) => (setTool(""), setOwnModel(choice));
  // Which of the tool's accounts on the computer: the one it was on, else "" for the one new sessions use (Accounts.tsx
  // preferredAccount, the tool's own sign-in until another is picked).
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
  // One screen, each answer picked in place (Arun, 2026-11-10, the connect mockups' A refined): which row's choices are open,
  // and the row that opened them, so a second press on it closes them.
  const [open, setOpen] = useState<"" | "agent" | "code" | "where">("");
  const [opener, setOpener] = useState<HTMLElement | null>(null);

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

  const target = where === "new" ? { newLane: tool ? ENGINE_NAMES[tool] : ownPicked ? modelLaneName(ownPicked) : "Your folder" } : { lane: where };
  const found = hasMachine && tool ? (machine.tools.find((t) => t.tool === tool) ?? null) : null;
  // Nothing to install, nothing to log into: a folder is ready the moment a
  // machine is connected.
  const ready = tool ? !!found?.path && found.loggedIn !== false : hasMachine;

  const start = async () => {
    if (!hasCode) return;
    setBusy(true);
    setErr("");
    try {
      await hostApi<{ lane?: string }>(identity, "/api/runner/start", {
        method: "POST",
        body: JSON.stringify({
          sid,
          invite,
          ...(tool ? { tool } : {}),
          // A folder somebody else is editing is joined as a reader, rather than refused: one writer per folder.
          mode: clash ? "plan" : mode,
          // An own model is the lane's model; a coding tool's is that tool's.
          ...(ownPicked ? { model: ownPicked.choice } : tool && model.trim() ? { model: model.trim() } : {}),
          ...((ac) => (tool && ac !== "default" && found?.accounts?.some((a) => a.id === ac) ? { account: ac } : {}))(account || (tool && found ? preferredAccount(tool, found.accounts) : "default")),
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
      // The main agent runs on the session's model (state.options.model), not on what its runner was started with: set it too, as the
      // message box's picker does, or the lane would go on with whatever model the session had (#32).
      if (ownPicked && where === MAIN_LANE && state.options.model !== ownPicked.choice) send({ type: "settings.update", model: ownPicked.choice });
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
  const whyNot = busy ? "" : !hasCode ? "Choose the code it works on, or work without a folder" : clash ? "Pick Read only to connect" : tool && found && !found.path ? `${ENGINE_NAMES[tool]} isn't installed on this computer` : tool && found?.loggedIn === false ? `Sign in to ${ENGINE_NAMES[tool]} first` : "";

  const agentOk = !tool || (!!found?.path && found.loggedIn !== false);
  // Choosing the code answers its row: the choices close.
  const chose = (p: Picked | null) => {
    setNoFolder(false);
    setPicked(p);
    if (p) setOpen("");
  };
  const toggle = (id: "agent" | "code" | "where") => (e: React.MouseEvent<HTMLButtonElement>) => {
    setOpener(e.currentTarget);
    setOpen((o) => (o === id ? "" : id));
  };
  const accountLabel = account ? found?.accounts?.find((a) => a.id === account)?.label : undefined;
  const codeName = folder ? folderName(folder.path) : noFolder ? "No folder" : "";
  /** One row of the group: what it is, the answer, and its choices under it while open. */
  const row = (id: "agent" | "code" | "where", k: string, value: React.ReactNode, pop: React.ReactNode, tone = "") => (
    <div className="cd-rw" data-open={open === id || undefined}>
      <button type="button" className="cd-row" aria-haspopup="true" aria-expanded={open === id} data-faded={(open && open !== id) || undefined} onClick={toggle(id)}>
        <span className="cd-k">{k}</span>
        <span className="cd-v" data-tone={tone || undefined}>{value}</span>
        <Icon name={open === id ? "chevronUp" : "chevronDown"} size={12} className="cd-chev" />
      </button>
      {open === id && (
        <CdPop label={k} opener={opener} onClose={() => setOpen("")}>
          {pop}
        </CdPop>
      )}
    </div>
  );
  const tick = <Icon name="check" size={13} className="cd-opt-tick" />;
  const tags: string[] = [];
  if (folder && canSplit && own) tags.push("New branch");
  else if (folder?.branch) tags.push(folder.branch);
  if (folder && !folder.isRepo && own) tags.push("Made a git repo first");
  if (picked?.resume) tags.push(picked.resume.tool === tool ? `Continues “${picked.resume.title}”` : `History from “${picked.resume.title}”`);
  if (dirs?.length) tags.push(`${dirs.length} more folder${dirs.length === 1 ? "" : "s"}`);

  return (
    <div className="overlay">
      <form
        className="modal engine-modal cd cd-a"
        ref={ref as unknown as React.RefObject<HTMLFormElement>}
        role="dialog" aria-modal="true"
        aria-label="Connect your coding agent"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && hasCode && ready) void start();
        }}
      >
        <header className="cd-head">
          <h2>{existing ? "Reconnect this agent" : "Work on code on your computer"}</h2>
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

            <div className="cd-grp" aria-label="What it will be" role="group">
              {row(
                "agent",
                "Agent",
                ownPicked ? (
                  <>
                    <Icon name="key" size={14} />
                    <span className="cd-v-text" title={`${ownPicked.model} · ${ownPicked.local ? "on this computer" : "your key"}`}>{modelLaneName(ownPicked)}</span>
                  </>
                ) : (
                  <>
                    <EngineMark tool={tool} size={15} />
                    {tool ? ENGINE_NAMES[tool] : "Friday Code"}
                    {accountLabel && <span className="cd-dim">{accountLabel}</span>}
                  </>
                ),
                <>
                  <div className="cd-opts" role="radiogroup" aria-label="Coding agent">
                    {/* Not in the open-source edition, which has no agent of its own (2026-11-04 QA). */}
                    {!isLocal() && (
                      <button type="button" role="radio" aria-checked={tool === "" && !ownPicked} className="cd-opt" onClick={() => (pickTool(""), setOpen(""))}>
                        <EngineMark tool="" size={16} />
                        <span className="cd-opt-name">Friday Code</span>
                        {tool === "" && !ownPicked && tick}
                      </button>
                    )}
                    {[...tools.here, ...(moreTools ? tools.away : [])].map((t) => {
                      const st = stateOf(t);
                      const ok = st.tone === "ok";
                      return (
                        <button key={t} type="button" role="radio" aria-checked={tool === t} className="cd-opt" data-off={!ok || undefined} onClick={() => (pickTool(t), ok && setOpen(""))}>
                          <EngineMark tool={t} size={16} />
                          <span className="cd-opt-name">{ENGINE_NAMES[t]}</span>
                          {ok ? <span className="sr-only">Ready</span> : <span className={`cd-opt-r ${st.tone}`}>{st.text}</span>}
                          {tool === t && tick}
                        </button>
                      );
                    })}
                    {/* Your own models: one entry saying which it runs on, and, once it is picked, each of them under it (#32). */}
                    {mayOwn && (
                      <>
                        <button type="button" role="radio" aria-checked={!!ownPicked} className="cd-opt" onClick={() => (pickOwn(ownPicked?.choice ?? ownModels[0]!.choice), ownModels.length === 1 && setOpen(""))}>
                          <Icon name="key" size={15} />
                          <span className="cd-opt-name">Your keys and local models</span>
                          <span className="cd-opt-r">{ownPicked ? modelLaneName(ownPicked) : ownModels.length === 1 ? modelLaneName(ownModels[0]!) : `${ownModels.length} set up`}</span>
                          {/* With its models listed under it, the tick is the model's. */}
                          {ownPicked && ownModels.length === 1 && tick}
                        </button>
                        {ownPicked && ownModels.length > 1 && (
                          <div className="cd-opts cd-opts-sub" role="radiogroup" aria-label="Your keys and local models">
                            {ownModels.map((m) => (
                              <button key={m.choice} type="button" role="radio" aria-checked={m.choice === ownPicked.choice} className="cd-opt" title={`${m.model} · ${m.local ? "on this computer" : "your key"}`} onClick={() => (pickOwn(m.choice), setOpen(""))}>
                                <OwnHostMark provider={m.provider} size={14} />
                                <span className="cd-opt-name">{modelLaneName(m)}</span>
                                <span className="cd-opt-r">{m.local ? "on this computer" : "your key"}</span>
                                {m.choice === ownPicked.choice && tick}
                              </button>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                    <MoreTools open={moreTools} count={tools.away.length} onToggle={() => setMoreTools((v) => !v)} className="cd-opt cd-opt-more" />
                  </div>
                  {found?.path && found.loggedIn !== false && <AccountPicker identity={identity} tool={found} value={account} onChange={setAccount} onChanged={refresh} />}
                  {found?.path && found.loggedIn !== false && <LoginNotice identity={identity} tool={found} onRecheck={refresh} />}
                </>,
              )}
              {row(
                "code",
                "Code",
                codeName ? (
                  <>
                    <Icon name="folder" size={14} />
                    <span className="cd-v-text" title={folder?.path}>{codeName}</span>
                  </>
                ) : (
                  <span className="cd-dim">{prefilled ? "Choose" : "Looking…"}</span>
                ),
                <>
                  <div className="cd-opts" role="radiogroup" aria-label="Code it works on">
                    {[...recents, ...(folder && !recents.includes(folder.path) ? [folder.path] : [])].map((p) => {
                      const on = folder?.path === p;
                      return (
                        <button key={p} type="button" role="radio" aria-checked={on} className="cd-opt" title={p} onClick={() => (on ? setOpen("") : pickRecent(p))}>
                          <Icon name="folder" size={14} />
                          <span className="cd-opt-name">{folderName(p)}</span>
                          <span className="cd-opt-r mono">{p === mainCwd ? "This session's" : tidyPath(p, machine.home)}</span>
                          {on && tick}
                        </button>
                      );
                    })}
                  </div>
                  <div className="cd-opts cd-opts-more">
                    {/* Resuming belongs to a CLI's own history; lending a folder has none. */}
                    <WorkspacePill className="cd-opt cd-opt-more" text="Choose a folder…" identity={identity} tool={tool || "claude"} value={folder} resume={tool ? picked?.resume : undefined} onPick={chose} onTool={pickTool} />
                    {/* The way in from a second computer: the session's code is on the first one. */}
                    {!folder && repo && (
                      <button type="button" className="cd-opt cd-opt-more" disabled={cloning} onClick={() => void cloneHere()} title={`Clone ${repo.name} onto this computer`}>
                        {cloning ? <span className="spinner" /> : <Icon name="download" size={14} />}
                        <span className="cd-opt-name">Clone {repo.name}</span>
                      </button>
                    )}
                    {/* A blank space, not the session's code: for an agent that reads, plans and answers. */}
                    {(tool || ownPicked) && (
                      <button type="button" role="radio" aria-checked={noFolder} className="cd-opt cd-opt-more" onClick={() => (setNoFolder(true), setPicked(null), setOpen(""))}>
                        <Icon name="agent" size={14} />
                        <span className="cd-opt-name">No folder</span>
                        {noFolder && tick}
                      </button>
                    )}
                  </div>
                  {folder && tool && <AlsoWorksIn identity={identity} folder={folder.path} value={dirs} onChange={setDirs} />}
                </>,
              )}
              {canSplit &&
                row(
                  "where",
                  "Where",
                  own ? "Own worktree" : "This folder",
                  <div className="cd-opts" role="radiogroup" aria-label="Where it works">
                    <button type="button" role="radio" aria-checked={own} className="cd-opt" onClick={() => (setOwnPick(true), setOpen(""))}>
                      <Icon name="gitBranch" size={14} />
                      <span className="cd-opt-name">Own worktree</span>
                      <span className="cd-opt-r">{folder?.isRepo ? "new branch" : "git repo first"}</span>
                      {own && tick}
                    </button>
                    <button type="button" role="radio" aria-checked={!own} className="cd-opt" onClick={() => (setOwnPick(false), setOpen(""))}>
                      <Icon name="folder" size={14} />
                      <span className="cd-opt-name">This folder</span>
                      <span className="cd-opt-r">{taken ? `with ${holderName}` : folder?.branch ?? ""}</span>
                      {!own && tick}
                    </button>
                  </div>,
                  shares ? "warn" : "",
                )}
              <div className="cd-row cd-row-seg">
                <span className="cd-k" id="cd-access">Access</span>
                <span className="cd-seg" role="radiogroup" aria-labelledby="cd-access">
                  {MODES.map((m) => (
                    <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} aria-label={m.label} title={blurbFor(m, tool ?? "")} data-risky={(m.id === "full" && shares) || undefined} className={mode === m.id ? "on" : ""} onClick={() => setMode(m.id)}>
                      {m.id === "full" && <Icon name="zap" size={11} />}
                      {m.id === "plan" ? "Read" : m.id === "full" ? "Full" : m.label}
                    </button>
                  ))}
                </span>
              </div>
            </div>

            {tags.length > 0 && (
              <div className="cd-tags">
                {tags.map((t) => (
                  <span key={t} className="cd-tag">{t}</span>
                ))}
              </div>
            )}

            {/* Warnings, one line each with the fix beside it. */}
            {tool && found && !found.path && (
              <p className="cd-warn">
                {ENGINE_NAMES[tool]} isn't installed on this computer
                <button type="button" onClick={refresh}>Check again</button>
              </p>
            )}
            {found?.path && found.loggedIn === false && <LoginNotice identity={identity} tool={found} onRecheck={refresh} />}
            {shares && (
              <p className="cd-warn" id="cd-held">
                <Icon name="users" size={13} />
                {holderName} is in {folder!.name} too
                {canSplit && <button type="button" onClick={() => setOwnPick(true)}>Own worktree</button>}
              </p>
            )}
            {shares && mode === "full" && (
              <p className="cd-warn">
                <Icon name="zap" size={13} />
                Runs commands without asking
                <button type="button" onClick={() => setMode("edits")}>Edits</button>
              </p>
            )}
          </>
        )}
        {err && <p className="cd-callout bad">{err}</p>}

        {hasMachine && (
          <footer className="cd-foot">
            <span className="cd-why" role="status">{whyNot}</span>
            <button type="button" className="btn ghost small" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={busy || !hasCode || !ready || clash || !agentOk}>
              {busy && <span className="spinner" />} {busy ? "Connecting" : "Connect"}
            </button>
          </footer>
        )}
      </form>
    </div>
  );
}

/** A row's choices, under it in the dialog: closes on a pick, Escape or a press outside, and keeps the dialog open. */
function CdPop({ label, opener, onClose, children }: { label: string; opener: HTMLElement | null; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose, opener, { trap: false });
  return (
    <div ref={ref} className="cd-pop" role="group" aria-label={`${label} choices`}>
      {children}
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

/** Where an agent with changes stands, as the small ring after its name draws it: working, waiting on you, or stopped. */
function laneRing(state: SessionState, lane: string): "working" | "needs" | "error" | null {
  const run = runOf(state, lane).status;
  if (state.openQuestions[lane] || state.approvals?.[lane] || run === "waiting_for_human") return "needs";
  return run === "running" ? "working" : run === "error" ? "error" : null;
}

/** The Changes panel's chip for every agent's changes together. */
const EVERYONE = "*";

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
  // Only the agents with something changed: a room of seven had seven chips, five of them saying 0 (Arun, 2026-11-03: "rework on
  // how all of the teammates stuff changes and updates can be seen properly").
  const ids = Object.keys(state.diffs).filter((id) => state.diffs[id]!.files.length > 0);
  // With more than one, everyone's changes together, by the folder they are in, each file once with whoever changed it: two
  // teammates in one repository listed its files twice, each under the other's chip too.
  const many = ids.length > 1;
  const everyone = useMemo(() => {
    if (!many) return null;
    const seen = new Map<string, DiffFile>();
    const who = new Map<string, string[]>();
    for (const id of ids) {
      const en = state.engines[id];
      for (const f of state.diffs[id]!.files) {
        const folder = f.repo ?? en?.root ?? en?.cwd ?? "";
        const k = `${folder}\0${f.path}`;
        if (!seen.has(k)) seen.set(k, { ...f, repo: folder });
        const w = who.get(folder) ?? [];
        if (!w.includes(id)) who.set(folder, [...w, id]);
      }
    }
    return { files: [...seen.values()], who };
  }, [state.diffs, state.engines, many]); // eslint-disable-line react-hooks/exhaustive-deps
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
  // Everyone's, unless one was picked or this is an agent's own column.
  const all = many && (pick === EVERYONE || (!(pick && ids.includes(pick)) && !(lane && ids.includes(lane))));
  const current = all ? null : pick && ids.includes(pick) ? pick : lane && ids.includes(lane) ? lane : (ids[0] ?? null);
  const d = all && everyone ? { files: everyone.files } : current ? state.diffs[current]! : null;
  const e = current ? state.engines[current] : null;
  const adds = d?.files.reduce((n, f) => n + f.additions, 0) ?? 0;
  const dels = d?.files.reduce((n, f) => n + f.deletions, 0) ?? 0;

  const body = (
    <>
      {/* Whose changes, and where each of them stands, as herdr's sidebar says it: the small ring after the name while it works,
          waits on you or stopped, and how many files (Arun, 2026-11-03: the Changes panel "like this"). */}
      {ids.length > 0 && (
        <div className="ch-agents" role="tablist" aria-label="Agents with changes">
          {many && everyone && (
            <button role="tab" aria-selected={all} className={`ch-agent${all ? " on" : ""}`} onClick={() => setPick(EVERYONE)}>
              <span className="ch-agent-name">Everyone</span>
              <span className="ch-agent-n">{everyone.files.length}</span>
            </button>
          )}
          {ids.map((id) => (
            <button key={id} role="tab" aria-selected={id === current} className={`ch-agent${id === current ? " on" : ""}`} onClick={() => setPick(id)}>
              <span className="ch-agent-mark" aria-hidden="true">{agentLook(state, id, 12).mark}</span>
              <span className="ch-agent-name">{laneLabel(state, id)}</span>
              <StateRing state={laneRing(state, id)} />
              <span className="ch-agent-n">{state.diffs[id]!.files.length}</span>
            </button>
          ))}
        </div>
      )}
      <div className="doc-scroll files-scroll">
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
            {all && everyone ? (
              // Each folder named, with whose changes are in it: a name opens that agent's own, to review, comment and commit.
              <DiffCard
                key="everyone"
                files={d.files}
                compact
                panel
                hideTitle
                repoNote={(repo) => (
                  <span className="ch-who">
                    {(everyone.who.get(repo) ?? []).map((id) => (
                      <button key={id} type="button" className="ch-who-name" title={`Only ${laneLabel(state, id)}'s changes, to review and commit`} onClick={() => setPick(id)}>
                        <span className="ch-agent-mark" aria-hidden="true">{agentLook(state, id, 10).mark}</span>
                        {laneLabel(state, id)}
                      </button>
                    ))}
                  </span>
                )}
              />
            ) : (
              <DiffCard files={d.files} compact panel hideTitle attribution={attribution} {...(ship && current ? { review: { send: ship.send, via: reviewVia(state, ship.me, current), lane: current } } : {})} />
            )}
          </>
        ) : (
          <div className="dp-empty">
            <span className="dp-empty-icon">
              <Icon name="file" size={18} />
            </span>
            {/* After a commit, "No changes yet" read as if nothing had been done: the commits are listed just below. */}
            {events.some((ev) => ev.body.type === "folder.committed") ? (
              <>
                <b>All committed</b>
                <span>Everything the agents changed is in the commits below. New changes show up here.</span>
              </>
            ) : (
              <>
                <b>No changes yet</b>
                <span>When an agent changes files, each one shows up here to read, comment on and tick off, with the way to commit them below.</span>
              </>
            )}
          </div>
        )}
        <Commits events={events} />
      </div>
      {/* The way from these changes to a pull request, docked at the panel's foot under the files as they scroll: the checks, the
          message, one button (ShipFlow). */}
      {ship && !all && d && d.files.length > 0 && <ShipFlow key={current ?? "none"} state={state} lane={current ?? lane ?? MAIN_LANE} events={events} {...ship} />}
    </>
  );

  if (bare) return body;
  return (
    <aside className="doc-panel files-panel" aria-label="Changes">
      <div className="doc-head">
        <Icon name="file" size={15} />
        <span className="doc-title">Changes</span>
        <span className="doc-count">{d ? `${d.files.length} changed` : "no changes yet"}</span>
        <span className="doc-actions">
          <button className="icon-btn tiny" title="Close" aria-label="Close changes" onClick={onClose}>
            <Icon name="x" size={15} />
          </button>
        </span>
      </div>
      {body}
    </aside>
  );
}
