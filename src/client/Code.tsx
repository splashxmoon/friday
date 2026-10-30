import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { AgentView } from "../agents.js";
import type { CliSession } from "../runner/imports.js";
import type { FolderInfo } from "../runner/workspace.js";
import { EFFORT_LEVELS, ENGINE_EFFORT_INFO, ENGINE_NAMES, ENGINE_TOOLS, type Attachment, type EngineEffort, type EngineMode, type EngineTool } from "../types.js";
import { api } from "./api.js";
import { titleFrom } from "./quick-send.js";
import { AttachButton, AttachedRow, PICK_FOLDER, attach, droppedFiles, pasteAttach, uploadAll, type Attached } from "./Attach.js";
import { Icon, type IconName } from "./icons.js";
import { rememberAsk, walkAsks } from "./askHistory.js";
import { NoMachine, connectThisComputer, hostApi, useMachine } from "./local.js";
import { ComputerPill } from "./Computers.js";
import { HeroTitle } from "./HeroTitle.js";
import { HomeActivity } from "./HomeActivity.js";
import { MachineBadge } from "./MachineBadge.js";
import type { Identity, RecentSession } from "./storage.js";
import { InBand, MenuButton, Switch, useDismiss } from "./ui.js";
import { AccountPill } from "./Accounts.js";
import { EngineMark } from "./BrandMarks.js";
import { AgentModelPicker } from "./AgentModelPicker.js";
import { canRoute, saveSmartRouting, smartRoutingOn, useRouteHint } from "./RouteWhy.js";
import { keepAuto, reachForMessage } from "./smartReach.js";
import type { Plan } from "../plan-types.js";
import { isLocal, ownModel, planLimits } from "./edition.js";
import { AlsoWorksIn, FolderCard, useResumeLink, type Picked } from "./Workspace.js";
import { branchRef, FolderBranchPick, type FolderBranch } from "./Branches.js";
import type { ResumeLink } from "./resume-link.js";
import { issueBranch, parseIssueUrl, parsePrLink, withIssue, withPr, type Issue, type Pr } from "../github-issue.js";
import { isTeamSid } from "./Teammates.js";
import { leaveWorkNote, markWorkSession, startTeammate, teammateOf, useWorkMode, useWorkSessions, WORK_LINES, WORK_MODE_BLURB, WORK_PLACEHOLDER, WorkField, WorkStarters, workListed } from "./WorkMode.js";
import { CircleDotIcon, GitPullRequestIcon } from "lucide-react";
import { isTeamDemo, runTeamDemo, TeamDemoOffer, useDemoTeam } from "./TeamDemo.js";

// The message box is this page's state, so every keystroke draws the page again. These take nothing that changes as you type,
// so they are left as they were. The template shelf is not among them: it is given what is in the box.
const Badge = memo(MachineBadge);

/** What was being typed here, kept for this tab, so going to a session and back doesn't lose a half-written task. */
const DRAFT = "mpa.draft.home";

/**
 * Starting a coding run.
 *
 * The same composer as Work, because it is the same act: say what you want and
 * the room can watch, redirect and take over. Everything underneath is shared —
 * the ordered log, one driver at a time, redirects at step boundaries, lanes.
 * What differs is the deliverable: a repository and a diff, not a document.
 *
 * Two choices sit in the composer itself: who does the work (Friday Code, or
 * your own Claude Code / Codex / Cursor) and which code it works on. Everything
 * else has a sensible default, so the fast path is: type, press Enter.
 */
/**
 * Openings, and a different four each time.
 *
 * There were four, fixed, and they were the four anybody would guess: find a
 * bug, add a feature, review, write tests. Fixed means they stop being read
 * after the second session — the eye files them as furniture — and four means
 * the only jobs on offer are the ones you would have thought of unprompted.
 *
 * So there are sixteen and you get four, drawn fresh on every visit to this
 * screen. The point is not novelty; it is that some of these are jobs people
 * do not think to ask an agent for, and a rotating shelf is how they find out.
 * Every one ends mid-sentence, because the prompt is a beginning and the
 * cursor should land where you carry on.
 */
const STARTERS = [
  { icon: "search" as const, label: "Find a bug", detail: "Traces the cause and shows the fix before it touches a file.", prompt: "Find the cause of this bug, then show me the fix before changing anything: " },
  { icon: "file" as const, label: "Add a feature", detail: "Plans first: which files it would change, then builds it.", prompt: "Add this feature. Show me the plan and the files you'd touch first: " },
  { icon: "shield" as const, label: "Review a change", detail: "Reads the diff for correctness, security and missed edge cases.", prompt: "Review this change for correctness, security and edge cases: " },
  { icon: "flask" as const, label: "Write tests", detail: "Adds tests that fail the moment this behaviour regresses.", prompt: "Write tests that fail if this behaviour regresses: " },
  { icon: "refresh" as const, label: "Explain this code", detail: "A walkthrough of how it works, and what is surprising in it.", prompt: "Walk me through how this works, and say what surprised you about it: " },
  { icon: "zap" as const, label: "Make it faster", detail: "Measures before and after, in the same conditions.", prompt: "Measure this before and after, in the same conditions, and tell me the number: " },
  { icon: "trash" as const, label: "Find dead code", detail: "Lists what nothing reaches any more, with the evidence.", prompt: "Find code nothing reaches any more, and say how you know for each one: " },
  { icon: "chain" as const, label: "Upgrade a dependency", detail: "Bumps it and fixes what breaks, one thing at a time.", prompt: "Upgrade this dependency and deal with what breaks, one thing at a time: " },
  { icon: "book" as const, label: "Fix the docs", detail: "Checks the README against the code and lists where they differ.", prompt: "Read the README against the code and tell me where they disagree: " },
  { icon: "box" as const, label: "Write a migration", detail: "The migration, and the way back out of it.", prompt: "Write this migration and the way back out of it: " },
  { icon: "globe" as const, label: "Trace a request", detail: "Follows one request through every hop it makes.", prompt: "Follow one request all the way through and show me every hop it makes: " },
  { icon: "check" as const, label: "Fix a flaky test", detail: "Runs it until it fails, then explains why.", prompt: "This test fails about one run in ten. Run it enough times to see it fail, then tell me why: " },
  { icon: "eye" as const, label: "Check accessibility", detail: "Keyboard and screen reader pass, reporting what can't be reached.", prompt: "Go through this with a keyboard and a screen reader, and report what can't be reached: " },
  { icon: "agent" as const, label: "Clean up a diff", detail: "Splits behaviour changes from changes that only move things.", prompt: "Split this change into the parts that alter behaviour and the parts that only move things: " },
  { icon: "plus" as const, label: "Add logging", detail: "The logs that would have made the last outage obvious.", prompt: "Add the logging that would have made the last outage obvious in one minute: " },
  { icon: "x" as const, label: "Reproduce a report", detail: "Turns a bug report into a failing test first.", prompt: "Turn this bug report into a failing test before touching anything: " },
];

/** "Good morning, Arun · Wednesday, 8 October": the page knows who you are and what day it is. */
function Greeting({ name }: { name: string }) {
  const h = new Date().getHours();
  const word = h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  const first = name.trim().split(/\s+/)[0] ?? "";
  return (
    <p className="hero-kicker">
      <span>
        {word}
        {first ? `, ${first}` : ""}
      </span>
      <span className="dot" aria-hidden />
      <span className="day">{new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</span>
    </p>
  );
}

/** Four of them, drawn once per mount so they do not shuffle under the cursor. */
function useStarters(): typeof STARTERS {
  return useMemo(() => {
    const pool = [...STARTERS];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    // All of them, shuffled once: the shelf shows four and turns through the rest.
    return pool;
  }, []);
}

/** The new-session box's last permission choice, on this computer. */
const MODE_KEY = "friday.newSession.mode";
const MODE_LABEL: Record<EngineMode, string> = { plan: "plan", edits: "manual", full: "auto" };
/** How the choice is named on the button and in the list. */
const MODE_NAME: Record<EngineMode, string> = { plan: "Plan", edits: "Manual", full: "Auto" };
const MODE_BLURB: Record<EngineMode, string> = {
  plan: "Reads and proposes, and asks before it runs a command. Changes nothing.",
  edits: "Edits files, and asks before it runs a command.",
  full: "Runs commands without asking. Anyone driving this session can.",
};

/**
 * The branch a new piece of work lands on.
 *
 * Dated, not derived from what you typed. It used to be a slug of the whole
 * prompt, so "help me fix bugs" became `friday/help-me-fix-bugs` and the
 * field rewrote itself on every keystroke — which is distracting to type
 * next to, and leaves real branches named after a sentence. A date and a
 * time is short, sorts, never collides with this morning's, and is the same
 * two seconds after you start typing as it was before.
 *
 * Anybody who wants the branch to say something types it; that is what the
 * field is for.
 */
export function branchFor(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `friday/${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

export function Code({
  identity,
  agents,
  plan = "free",
  defaults,
  preset,
  onPresetUsed,
  initialAgentId,
  onStart,
  recents = [],
  onOpenBoard,
  resumeLink,
}: {
  /** A `?resume=<tool>:<id>&cwd=<path>` link (resume-link.ts): its folder is picked, with that conversation to continue. */
  resumeLink?: ResumeLink;
  /** The sessions this browser knows, for "Right now" under the box. */
  recents?: RecentSession[];
  onOpenBoard?: () => void;
  identity: Identity;
  agents: AgentView[];
  plan?: Plan;
  defaults?: { model?: string };
  /** A brief carried over from the Skills page, Code Review or a prompt link, dropped into the box. `shepherd`: Friday sees its pull
   *  request through once it starts. `repo` and `tool` come with a prompt link (prompt-link.ts). */
  preset?: { brief?: string; shepherd?: boolean; repo?: string; tool?: EngineTool } | null;
  onPresetUsed?: () => void;
  /** An agent picked on the Agents page runs this session. */
  initialAgentId?: string;
  onStart: (sid: string, invite: string) => void;
}) {
  const [goal, setGoal] = useState(() => {
    if (preset?.brief) return preset.brief;
    try {
      return sessionStorage.getItem(DRAFT) ?? "";
    } catch {
      return "";
    }
  });
  // A brief that arrives after the page is up (a prompt link read once sign-in is through): into the box, unless words are there already.
  useEffect(() => {
    if (preset?.brief && !goal.trim()) setGoal(preset.brief);
  }, [preset?.brief]); // eslint-disable-line react-hooks/exhaustive-deps
  // Kept once typing pauses, not on every key: a synchronous storage write per keystroke was work the key waited on. What is
  // still waiting is written when the page is left or the box goes away.
  const saveDraft = useRef<(() => void) | null>(null);
  useEffect(() => {
    saveDraft.current = () => {
      saveDraft.current = null;
      try {
        if (goal) sessionStorage.setItem(DRAFT, goal);
        else sessionStorage.removeItem(DRAFT);
      } catch {
        /* nothing kept: the box still works */
      }
    };
    const t = setTimeout(() => saveDraft.current?.(), 300);
    return () => clearTimeout(t);
  }, [goal]);
  useEffect(() => {
    const flush = () => saveDraft.current?.();
    addEventListener("pagehide", flush);
    return () => {
      removeEventListener("pagehide", flush);
      flush();
    };
  }, []);
  // Code Review's "See it through": kept past the preset being cleared, for as long as the box still names a pull request.
  const shepherd = useRef(!!preset?.shepherd);
  // The brief is used once: it belongs to the visit that carried it here.
  useEffect(() => {
    if (preset?.brief) onPresetUsed?.();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Which model Friday Code runs, when it is Friday Code doing the work.
  // Smart routing left on is kept on, whatever model the workspace starts sessions on (a default of "" used to win over it).
  const [fridayModelId, setFridayModelId] = useState(smartRoutingOn() && planLimits(plan).fridayAgent !== "none" ? "auto" : (defaults?.model ?? ""));
  // The workspace's default can arrive after the page is drawn, or change while it is open: taken as it comes, unless somebody
  // has picked a model here for themselves. The page used to be rebuilt for it instead, which lost the folder already picked.
  const choseModel = useRef(false);
  useEffect(() => {
    if (!choseModel.current && defaults?.model && !smartRoutingOn()) setFridayModelId(defaults.model);
  }, [defaults?.model]);
  const [agentId, setAgentId] = useState(initialAgentId ?? "");
  /** Commands allowed in advance, carried from a template saved out of an earlier session. */
  const [allow, setAllow] = useState<string[]>([]);
  /**
   * Who does the work. Friday Code by default.
   *
   * It used to be Claude Code, on the reasoning that the best coding agent is
   * the one already installed on the person's machine with their repo and
   * their login. That is still true of the agent, and it was the wrong thing
   * to optimise: opening on a CLI means opening on a setup task. Somebody who
   * has not linked a machine — which is everybody, the first time — meets a
   * wall about connecting one before they have seen the product do anything.
   *
   * Friday Code needs nothing, so the composer opens on something that can
   * run. Claude Code is one click away in the same menu and still the better
   * answer once a machine is linked; it is just no longer the price of entry.
   */
  // An agent picked elsewhere is Friday's to run, not a CLI's.
  const [engine, setEngine] = useState<EngineTool | "">("");
  // Set once somebody chooses for themselves, so the fallback below stops
  // second-guessing them.
  const chose = useRef(false);
  // Solo has no Friday agent of its own, so it opens on your coding tools: the first this computer has ready, else Claude Code.
  const solo = planLimits(plan).fridayAgent === "none";
  const [picked, setPicked] = useState<Picked | null>(null);
  /**
   * What the agent may do in that folder: Manual to begin with.
   *
   * It edits files and asks before it runs a command, so a session never starts
   * with more reach than somebody chose. Auto is a switch inside the session,
   * by the person whose machine it is, once the task is in front of them.
   */
  // Auto unless picked otherwise, for every coding tool and Friday Code alike (Arun, 2026-10-18); then whatever was picked last,
  // on this computer: it went back to Auto at every visit to this page, without a word (2026-10-27 audit).
  const [mode, setMode] = useState<EngineMode>(() => {
    try {
      const kept = localStorage.getItem(MODE_KEY);
      return kept === "plan" || kept === "edits" || kept === "full" ? kept : "full";
    } catch {
      return "full";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      // A preference: losing it costs nothing.
    }
  }, [mode]);
  // Which of that CLI's own models it runs on; empty means its default.
  const [model, setModel] = useState("");
  // The model picked by hand before smart routing was turned on, put back when it is turned off: it went back to the tool's
  // default and the pick was lost (Arun, 2026-10-28: "iron everything and ensure we are good… any logic errors and fixes").
  const pickedModel = useRef("");
  // A model belongs to its CLI: another CLI starts on its own default, or on Auto when smart routing is on and it can route.
  useEffect(() => setModel(engine && smartRoutingOn() && canRoute(engine) ? "auto" : ""), [engine]);
  // How hard it thinks, for a tool that takes a level; Auto (null) is the tool's own default. Another tool starts on Auto.
  const [effort, setEffort] = useState<EngineEffort | null>(null);
  useEffect(() => setEffort(null), [engine]);
  // Which of the tool's accounts on the computer (runner/accounts.ts): "" for whichever has most room. Another tool starts on that.
  const [account, setAccount] = useState("");
  useEffect(() => setAccount(""), [engine]);
  const effortLevels = (engine && EFFORT_LEVELS[engine]) || [];
  const [newBranch, setNewBranch] = useState(true);
  // Carrying on from a conversation means carrying on where it was: the same folder, on the branch it was working on, not a new one. Whoever
  // wants a fresh branch turns that on again.
  useEffect(() => {
    if (picked?.resume) setNewBranch(false);
  }, [picked?.resume?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Empty means "name it after the task", which the placeholder shows. The
  // field never fills itself in as you type: watching a branch name mirror
  // every keystroke in the message box reads as a bug, and the two are
  // different things that happen to start from the same words.
  const [branch, setBranch] = useState("");
  /**
   * A GitHub issue link in the box is the task: the issue's title and text go to the agent with whatever else was
   * typed, and the branch and pull request are named after it. Read once per link, a moment after it stops changing.
   */
  const [issue, setIssue] = useState<Issue | null>(null);
  useEffect(() => {
    const ref = parseIssueUrl(goal);
    if (!ref) return void setIssue(null);
    if (issue?.url === ref.url) return;
    const t = setTimeout(() => {
      // The server reads it with the workspace's GitHub connection; a private repo it can't see, this computer's own login can.
      api<{ issue: Issue }>(identity, `/api/github/issue?url=${encodeURIComponent(ref.url)}`)
        .catch(() => hostApi<{ issue: Issue }>(identity, `/api/runner/github.item?url=${encodeURIComponent(ref.url)}`))
        .then((r) => setIssue(r.issue))
        .catch(() => setIssue(null));
    }, 300);
    return () => clearTimeout(t);
  }, [goal]); // eslint-disable-line react-hooks/exhaustive-deps
  const [cloning, setCloning] = useState(false);
  /**
   * A pull-request link is the change to look at: the agent is told what it is, and the folder is put on its branch rather
   * than a new one, so reviewing or carrying on happens where the change lives.
   */
  const [pr, setPr] = useState<Pr | null>(null);
  useEffect(() => {
    const ref = parsePrLink(goal);
    if (!ref) return void setPr(null);
    if (pr?.url === ref.url) return;
    const t = setTimeout(() => {
      api<{ pr: Pr }>(identity, `/api/github/pr?url=${encodeURIComponent(ref.url)}`)
        .catch(() => hostApi<{ pr: Pr }>(identity, `/api/runner/github.item?url=${encodeURIComponent(ref.url)}`))
        .then((r) => (setPr(r.pr), setNewBranch(false)))
        .catch(() => setPr(null));
    }, 300);
    return () => clearTimeout(t);
  }, [goal]); // eslint-disable-line react-hooks/exhaustive-deps
  /**
   * Worked out once, when the page loads (or when an issue arrives, which names it).
   *
   * Recomputing it on every render would tick the minute over while somebody
   * is mid-sentence, so the name they were shown is not the name they get.
   */
  const branchSuggestion = useMemo(() => (issue ? issueBranch(issue) : branchFor()), [issue?.url]); // eslint-disable-line react-hooks/exhaustive-deps
  const { state: machine, refresh } = useMachine(identity);
  useEffect(() => {
    if (chose.current) return;
    // A tool known to be signed in first; one whose check hasn't answered yet only if none is (sign-ins now arrive one by one).
    const has = (ok: (x: (typeof machine.tools)[number]) => boolean) => ENGINE_TOOLS.find((t) => machine.tools.some((x) => x.tool === t && x.path && ok(x)));
    // None ready: one that is installed, signed in or not, so a first message ends on that tool's way to sign in; Claude Code
    // when nothing is installed at all.
    const ready = has((x) => x.loggedIn === true) ?? has((x) => x.loggedIn !== false) ?? has(() => true);
    setEngine(solo ? (ready ?? "claude") : "");
  }, [solo, machine.tools]);
  const [files, setFiles] = useState<Attached[]>([]);
  // What the picker left out. Worth saying, but not a failure.
  const [attachNote, setAttachNote] = useState("");
  // A file dropped beside the box is attached as one dropped on it would be (the box's onDrop), not opened by the browser in
  // place of Friday. A drop on something that takes drops itself (the folder card) is left to it.
  const filesNow = useRef(files);
  filesNow.current = files;
  useEffect(() => {
    const over = (e: DragEvent) => e.dataTransfer?.types.includes("Files") && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files") || e.defaultPrevented) return;
      e.preventDefault();
      void droppedFiles(e.dataTransfer).then((got) => got.length && attach(filesNow.current, got, setFiles, setAttachNote));
    };
    addEventListener("dragover", over);
    addEventListener("drop", drop);
    return () => {
      removeEventListener("dragover", over);
      removeEventListener("drop", drop);
    };
  }, []);
  const [busy, setBusy] = useState(false);
  // Opened when someone reaches for their code before any machine is linked:
  // there is nothing to choose from until then, so ask for that instead.
  const [linking, setLinking] = useState(false);
  const [err, setErr] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const starters = useStarters();
  // Your computer: the one Friday runs on, or the one you linked.
  const hasMachine = machine.mode === "local" || machine.mode === "linked";
  // A shared link's conversation, picked once the computer has listed it. It is still open in the terminal that shared it, so
  // the agent carries on from a copy (resumeFork) rather than writing into the same transcript.
  const resumeNote = useResumeLink(identity, resumeLink, machine.mode, machine.mode === "linked" ? (machine.machine?.name ?? "your computer") : "this computer", (p) => {
    setPicked(p);
    if (p.resume) {
      chose.current = true;
      setEngine(p.resume.tool);
    }
  });
  const forkResume = !!resumeLink && picked?.resume?.id === resumeLink.id && picked.resume.tool === resumeLink.tool;
  // The note about connecting goes once there is a computer.
  useEffect(() => void (hasMachine && setLinking(false)), [hasMachine]);
  // Friday Code is the default now, so there is nothing to fall back from:
  // the composer already opens on the agent that can always run.
  const tool = engine ? (machine.tools.find((t) => t.tool === engine) ?? null) : null;
  // Which coding model suits what is being typed, and why, shown in the agent picker (useRouteHint): a suggestion only.
  const route = useRouteHint(
    identity,
    hasMachine ? goal : "",
    ENGINE_TOOLS.filter((t) => machine.tools.some((x) => x.tool === t && x.path && x.loggedIn !== false && !x.unavailable)),
  );
  const folder = picked?.folder ?? null;
  // Work (WorkMode.tsx): content and knowledge work, with the other of Claude Code and Codex always brought in beside the first.
  // Picked in the sidebar only, with no switch or "With Codex" above the box (Arun, 2026-10-26: "get rid of the tab to switch
  // between code and work and with codex too").
  const [workPick] = useWorkMode();
  const work = isLocal() && workPick;
  const team = true;
  // No new branch for a Work session's folder; back to one when Code is picked again.
  const wasWork = useRef(work);
  useEffect(() => {
    if (work) setNewBranch(false);
    else if (wasWork.current) setNewBranch(true);
    wasWork.current = work;
  }, [work]);
  const ready = ENGINE_TOOLS.filter((t) => machine.tools.some((x) => x.tool === t && x.path && x.loggedIn !== false && !x.unavailable));
  const mate = work ? teammateOf(engine, ready) : null;
  // "Right now" under the box lists the sessions of the kind being started, as the sidebar does.
  const workSids = useWorkSessions(identity);
  // The folders beside it the coding tool may work in too, once changed here (see AlsoWorksIn); null keeps those kept for the folder.
  const [dirs, setDirs] = useState<string[] | null>(null);
  useEffect(() => setDirs(null), [folder?.path]);
  // A pull request, an issue or a prompt link names its repo: a copy already on this computer is picked for it, so nobody has to
  // go and find it. When there is none, the link's repo is offered to clone (below the box).
  const linkRepo = preset?.repo ?? "";
  const wantRepo = pr?.repo ?? issue?.repo ?? linkRepo;
  const [repoMissing, setRepoMissing] = useState("");
  useEffect(() => {
    if (!wantRepo || !hasMachine || picked) return;
    let live = true;
    void hostApi<{ folder: FolderInfo | null }>(identity, `/api/runner/repo.local?repo=${encodeURIComponent(wantRepo)}`).then(
      (r) => live && (r.folder ? setPicked((p) => p ?? { folder: r.folder! }) : setRepoMissing(wantRepo)),
      () => live && setRepoMissing(wantRepo),
    );
    return () => void (live = false);
  }, [wantRepo, hasMachine]); // eslint-disable-line react-hooks/exhaustive-deps
  // The link's tool, once this computer has said what it has: chosen when it is here, left alone otherwise.
  useEffect(() => {
    const t = preset?.tool;
    if (!t || chose.current || !hasMachine || !machine.tools.some((x) => x.tool === t && x.path)) return;
    chose.current = true;
    setEngine(t);
  }, [preset?.tool, hasMachine, machine.tools]); // eslint-disable-line react-hooks/exhaustive-deps
  // The branch the conversation being continued was on, when that is not the one the folder is on now.
  const resumeBranch = folder?.isRepo && picked?.resume?.branch && picked.resume.branch !== folder.branch ? picked.resume.branch : undefined;
  /**
   * Which of the folder's branches the work is on, or a new branch starts from (Arun, 2026-10-25: "make sure they can change the
   * branch they want to work on"). "" is the one the folder is on. Asked of the folder as it is picked; a runner too old to list
   * them lists nothing, and then there is nothing to pick, as before. A pull request and a conversation being continued pick
   * their own branch, so they don't offer it.
   */
  const [branches, setBranches] = useState<FolderBranch[] | null>(null);
  const [pickBranch, setPickBranch] = useState("");
  useEffect(() => {
    setPickBranch("");
    setBranches(null);
    if (!hasMachine || !folder?.isRepo) return;
    let live = true;
    void hostApi<{ folder: FolderInfo }>(identity, `/api/runner/describe?path=${encodeURIComponent(folder.path)}&branches=1`).then(
      (r) => live && setBranches(r.folder.branches?.length ? r.folder.branches : null),
      () => live && setBranches(null),
    );
    return () => {
      live = false;
    };
  }, [folder?.path, hasMachine]); // eslint-disable-line react-hooks/exhaustive-deps
  const canPickBranch = !!folder?.isRepo && !!branches && !picked?.resume && !(pr && !pr.fork);
  // The branch picked, when it isn't the one the folder is on.
  const pickedBranch = canPickBranch && pickBranch && pickBranch !== folder?.branch ? pickBranch : undefined;
  // Where the work lands without a new branch.
  const lands = (pr && !pr.fork ? pr.head : "") || resumeBranch || pickedBranch || folder?.branch;
  // A coding agent needs a machine, code to work on, and a login.
  // Only a CLI run is blocked by a missing machine: Friday Code works in
  // whatever was attached here, and with nothing attached it can still answer
  // about code in the message.
  // No folder is fine: the runner makes a project folder for the session, named from what was asked (~/Friday/Projects/…),
  // where the tool builds, clones what the message names, or just answers. Nothing has to be picked, opened or uploaded first.
  const blocked = !!engine && (!hasMachine || !tool?.path || tool.loggedIn === false);
  // Said on hover, and under the box when Enter is pressed anyway: Enter used to do nothing at all.
  // Which of the three it is, said as such: "isn't ready" didn't say what to do (Arun, 2026-10-24: UX gaps).
  const toolName = engine ? ENGINE_NAMES[engine as EngineTool] : "";
  const blockedWhy = !blocked
    ? ""
    : !hasMachine
      ? solo
        ? "Connect your computer first: the run happens on it."
        : "Connect your computer, or pick Friday Code."
      : !tool?.path
        ? `${toolName} isn't installed on this computer.`
        : `${toolName} is signed out on this computer. Sign in to it, then send.`;
  // Signing the tool in from here, as the computer badge does: the page the tool opens, or the command to run.
  const [signing, setSigning] = useState<{ busy?: boolean; url?: string; command?: string; error?: string } | null>(null);
  const signIn = async () => {
    if (!engine) return;
    setSigning({ busy: true });
    try {
      const r = await hostApi<{ opened?: boolean; command: string; url?: string }>(identity, "/api/runner/login", { method: "POST", body: JSON.stringify({ tool: engine }) });
      setSigning(r.url ? { url: r.url } : r.opened ? {} : { command: r.command });
      // The machine is looked at again until it says signed in (useMachine), which takes the notice away by itself.
      setTimeout(refresh, 4000);
    } catch (e) {
      setSigning({ error: (e as Error).message });
    }
  };
  // Shown once Enter was pressed, and gone by itself once the reason is (blockedWhy is "" then).
  const [nudged, setNudged] = useState(false);

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  };
  // A task brought back from the draft, or carried in from the Skills page, gets the height it needs.
  useEffect(() => {
    if (input.current && goal) grow(input.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Started: the draft has become a session, so it isn't offered here again.
  const started = (sid: string, invite: string) => {
    // A save still waiting would put it back as the box goes away.
    saveDraft.current = null;
    try {
      sessionStorage.removeItem(DRAFT);
    } catch {
      /* nothing was kept */
    }
    onStart(sid, invite);
  };

  // The team demo (TeamDemo.tsx): asked for from setup's last step, the offer under the box, or Settings › About. Started here,
  // where the computer's tools are known, each step said under the box as it goes, and opened once the lead has its job.
  const demoTeam = useDemoTeam(machine);
  // Asked for while the computer is still being looked at (just opened from Settings): started once it has said what it has.
  const demoWaits = useRef(false);
  useEffect(() => {
    if (machine.mode !== "checking" && demoWaits.current) (demoWaits.current = false), startDemo();
  }, [machine.mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const startDemo = () => {
    if (busy) return;
    if (machine.mode === "checking") return void (demoWaits.current = true);
    if (demoTeam.length < 2) return void (setErr("Sign in to a coding tool first: the demo runs your own agents."), window.dispatchEvent(new Event("friday:setup")));
    setBusy(true);
    setErr("");
    runTeamDemo(identity, demoTeam, setAttachNote).then(
      (r) => started(r.sid, r.invite),
      (e: Error) => (setErr(e.message), setAttachNote(""), setBusy(false)),
    );
  };
  // The listener is added once; it calls the start of the render it is heard in.
  const startDemoNow = useRef(startDemo);
  startDemoNow.current = startDemo;
  useEffect(() => {
    const go = () => startDemoNow.current();
    addEventListener("friday:team-demo", go);
    return () => removeEventListener("friday:team-demo", go);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Offered under the box while nobody has a session of their own yet: the demo's own don't count, so it is there again after.
  const firstRun = !recents.some((r) => !isTeamDemo(r.sid, r.title) && !isTeamSid(r.sid));

  // What each coding agent's row says about the computer it would run on. Nothing is ruled out before a machine has told us what it has.
  const toolState = (t: EngineTool) => {
    const f = hasMachine ? machine.tools.find((x) => x.tool === t) : null;
    return {
      disabled: !!f && (!f.path || !!f.unavailable),
      absent: !!f && !f.path,
      ready: !!f?.path && !f.unavailable && f.loggedIn !== false,
      hint: f ? (f.path ? (f.unavailable ? "not here yet" : f.loggedIn === false ? "sign in" : f.source === "claude-app" ? "Claude app" : "ready") : "not installed") : machine.mode === "checking" ? "…" : "connect",
    };
  };

  /** Where ↑ has got to in your past asks (askHistory.ts); -1 while the box holds your own text. */
  const askAt = useRef(-1);
  const submit = async () => {
    if (blocked && goal.trim()) return setNudged(true);
    if (!goal.trim() || busy || blocked) return;
    rememberAsk(goal);
    askAt.current = -1;
    // With an issue, the agent reads the issue itself after what was typed, and the session is called what the issue is.
    const text = issue ? withIssue(goal, issue) : pr ? withPr(goal, pr) : goal.trim();
    // Whether a machine will join this session before the first instruction.
    // A coding tool always joins (in the folder picked, or a fresh one of its own); Friday Code joins when there is a folder.
    // In the desktop app Friday Code always has this computer, folder or not: with none picked it works in a folder of its
    // own (~/Friday/Projects/…), with the same shell and tools as any coding tool, held to the mode picked like they are.
    const willAttach = hasMachine && (!!folder || !!engine || !!window.fridayDesktop);
    const newBranchName = newBranch && folder?.isRepo ? branch.trim() || branchSuggestion : "";
    // The branch the folder is put on: a pull request's own, a new one, the one picked, or the one the conversation being
    // continued ended on.
    const target = pr?.head && !pr.fork && folder?.isRepo ? pr.head : newBranchName || pickedBranch || resumeBranch;
    // A new branch starts from the one picked, rather than whatever the folder is on.
    const branchFrom = newBranchName && pickedBranch && target === newBranchName ? branchRef(branches?.find((b) => b.name === pickedBranch), pickedBranch) : undefined;
    // Set when the folder's uncommitted work keeps it where it is: the agent works in a copy on this branch instead.
    let aside: { branch: string; base?: string } | undefined;
    setBusy(true);
    setErr("");
    // Said under the box as it goes: starting takes a few seconds, and a spinner alone said nothing about which of them was slow.
    try {
      if (willAttach && folder?.isRepo) {
        setAttachNote("Checking the folder…");
        const now = await hostApi<{ folder: FolderInfo }>(identity, `/api/runner/describe?path=${encodeURIComponent(folder.path)}&dirty=1`).catch(() => null);
        // Uncommitted work in it no longer makes a copy by itself (Arun, 2026-10-24: copies only when asked): the agent works in
        // the folder as it is, as it would in a terminal. It still isn't switched to another branch from under that work: with
        // another branch picked, it works in a copy on that branch instead and the work stays where it is (Arun, 2026-10-26:
        // "fix this problem", a new branch from friday/claude-b37001cc refused over changes on fix/round2-stability).
        const dirty = !!now?.folder.dirty;
        const canAside = !!now?.folder.canAside;
        // A pull request's branch, or the one a conversation ended on, is somebody else's work to stand on.
        if (dirty && canAside && target && target !== newBranchName && now!.folder.branch !== target && target !== resumeBranch) aside = { branch: target };
        else if (dirty && target && target !== newBranchName && now!.folder.branch !== target) {
          setErr(`${folder.name} has uncommitted changes on ${now!.folder.branch ?? "its current branch"}, so it won't be switched to ${target}${pr ? ", where the pull request is" : target === pickedBranch ? "" : ", where that conversation is"}. Commit or stash them, then send again.`);
          setAttachNote("");
          setBusy(false);
          return;
        }
        // Nor moved to another branch to start a new one from it: the changes would go with it, onto a branch they weren't made on.
        if (dirty && canAside && branchFrom && now!.folder.branch !== pickedBranch) aside = { branch: newBranchName, base: branchFrom };
        else if (dirty && branchFrom && now!.folder.branch !== pickedBranch) {
          setErr(`${folder.name} has uncommitted changes on ${now!.folder.branch ?? "its current branch"}, so the new branch won't be started from ${pickedBranch}. Commit or stash them, or start it from ${now!.folder.branch ?? "the current branch"}, then send again.`);
          setAttachNote("");
          setBusy(false);
          return;
        }
      }
      setAttachNote(aside ? `${folder!.name} has uncommitted changes, so this works in a separate copy on ${aside.branch}. Your changes stay where they are.` : "Creating the session…");
      const r = await api<{ sessionId: string; invites: Record<string, string> }>(identity, "/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          userId: identity.id,
          name: identity.name,
          title: titleFrom(issue ? `#${issue.number} ${issue.title}` : pr ? `PR #${pr.number} ${pr.title}` : goal),
          ...(issue ? { issue: { url: issue.url, repo: issue.repo, number: issue.number, title: issue.title } } : {}),
          ...(pr ? { pr: { url: pr.url, repo: pr.repo, number: pr.number, title: pr.title, head: pr.head } } : {}),
          kind: "code",
          ...(work ? { work: true, ...(mate && team ? { team: true } : {}) } : {}),
          // The invite links start on, so there is something to copy from People the moment the session exists.
          // Everything the first step needs has to be in place before the
          // agent takes it. Sending the goal at creation woke the agent
          // immediately — before the computer holding the code had attached —
          // so its first act was to ask which repository to look at, about a
          // folder the person had just chosen. The goal now waits.
          goal: willAttach || files.length ? "" : text,
          // On Solo a saved agent runs on your coding tool (its instructions go to the tool); elsewhere a CLI runs as itself.
          agentId: engine && !solo ? undefined : agentId || undefined,
          ...(allow.length ? { allow } : {}),
          ...(engine ? {} : { model: fridayModelId }),
          engine: engine || undefined,
          // Set on the lane as the session opens, so the first turn already runs at it.
          ...(engine && effort && effortLevels.includes(effort) ? { effort } : {}),
        }),
      });
      const invite = r.invites.owner!;
      if (work) markWorkSession(r.sessionId);
      // The machine joins first. With a CLI selected the CLI does the work;
      // with Friday Code the computer lends the folder and Friday works in
      // it — same bridge either way, so files, terminal, preview and diffs
      // are the same.
      // The machine joining and the files uploading don't depend on each other,
      // so they go together; the first instruction waits for both.
      let attached = true;
      const attach = async () => {
        if (!willAttach) return;
        try {
          const begun = await hostApi<{ cwd?: string }>(identity, "/api/runner/start", {
            method: "POST",
            body: JSON.stringify({
              sid: r.sessionId,
              invite,
              ...(work ? { work: true } : {}),
              ...(engine ? { tool: engine } : {}),
              // No folder: a new project folder for it, named from what was asked, which is the session's code from then on.
              ...(folder ? { cwd: folder.path } : { noFolder: true, project: goal.trim().slice(0, 400) }),
              ...(folder && engine && dirs ? { dirs } : {}),
              // What the first message calls for, when it says clearly (smartReach.ts); otherwise what was picked.
              mode: keepAuto(reachForMessage(goal), mode)?.mode ?? mode,
              // and the one picked, which everyone else's turns are held to and which it goes back to after that first run.
              handMode: mode,
              ...(model ? { model } : {}),
              ...(engine && account && tool?.accounts?.some((a) => a.id === account) ? { account } : {}),
              // A pull request's own branch, when that is what the session is about; never a copy of the folder unasked.
              // Or, with uncommitted work in the folder, a copy of it on that branch (local-api start's `aside`).
              ...(folder ? (aside ? { worktree: "lane", copyName: engine || "friday", aside } : { branch: target }) : {}),
              ...(branchFrom && !aside ? { branchFrom } : {}),
              // Continuing a past conversation belongs to the CLI that had it.
              // Switching to Friday Code keeps the folder — that is a place,
              // and places don't belong to an agent — but drops the resume,
              // which would otherwise claim this lane continues a Claude Code
              // session that nothing here is running.
              // Any agent may carry on from any tool's conversation: its own resumes it, another's is read in as history.
              // No count for a transcript too long to read whole: the part that was read says nothing about the rest.
              ...(picked?.resume ? { resumeId: picked.resume.id, resumeTitle: picked.resume.title, resumeMessages: picked.resume.approx ? 0 : picked.resume.messages, resumeTool: picked.resume.tool } : {}),
              ...(picked?.resume && forkResume ? { resumeFork: true } : {}),
            }),
          });
          // In Work, the other tool joins the same folder; a failure leaves the session to the first, and says so in the session,
          // where it is read: said here, "Sending the task…" replaced it at once and the page went.
          const at = begun.cwd ?? folder?.path;
          if (mate && team && at) {
            setAttachNote(`Bringing in ${ENGINE_NAMES[mate]}…`);
            await startTeammate(identity, { sid: r.sessionId, invite, tool: mate, cwd: at, mode }).catch((e: Error) => {
              const said = `${ENGINE_NAMES[mate]} didn't join: ${e.message.replace(/\.$/, "")}.`;
              setAttachNote(said);
              leaveWorkNote(r.sessionId, said);
            });
          }
          void begun;
        } catch (e) {
          attached = false;
          setErr(`${engine ? ENGINE_NAMES[engine] : "Your folder"} didn't connect: ${(e as Error).message}`);
        }
      };
      let attachments: Attachment[] = [];
      const upload = async () => {
        if (!files.length) return;
        const up = await uploadAll(files, r.sessionId, invite, identity.id, (done, total) =>
          setAttachNote(done < total ? `Uploading ${done} of ${total}…` : "Uploaded."),
        );
        attachments = up.attachments;
        if (up.failed) setAttachNote(`Attached ${attachments.length + up.folders.reduce((n, f) => n + f.files, 0)}; ${up.failed} didn't upload.`);
      };
      if (willAttach) setAttachNote(`Starting ${engine ? ENGINE_NAMES[engine] : "Friday Code"}…`);
      await Promise.all([attach(), upload()]);
      // Not into a session whose agent never arrived, with the task waiting on it and the reason left behind on this page:
      // the reason stays here, beside the message, so it can be fixed and sent again.
      if (!attached) {
        setAttachNote("");
        setBusy(false);
        // Nor left on the list as an empty session, one more each time it is tried again.
        void api(identity, "/api/sessions/mine/forget", { method: "POST", body: JSON.stringify({ sid: r.sessionId }) }).catch(() => {});
        return;
      }
      // Now the agent can start: the folder is attached and the files are up.
      if (willAttach || files.length) {
        setAttachNote("Sending the task…");
        await api(identity, `/api/sessions/${encodeURIComponent(r.sessionId)}/instruct?invite=${encodeURIComponent(invite)}`, {
          method: "POST",
          body: JSON.stringify({ text, attachments, ...(shepherd.current && pr ? { shepherd: true } : {}) }),
        });
      }
      started(r.sessionId, invite);
    } catch (e) {
      setErr((e as Error).message);
      setAttachNote("");
      setBusy(false);
    }
  };

  let placeholder = solo ? "Describe the change…" : "Describe the change. Teammates can join, watch the run and steer it live…";
  if (work) placeholder = WORK_PLACEHOLDER;
  // The branch controls, for a folder that is a repository.
  let branchy = !!folder?.isRepo;
  if (work) branchy = false;
  // The line under the box when no folder is picked, in the words of the kind of session being started.
  let noFolderLine = "code";
  if (work) noFolderLine = "work";
  // What each permission means, said for the kind of session being started.
  let modeBlurb = MODE_BLURB;
  if (work) modeBlurb = WORK_MODE_BLURB;
  // The branch to work on, for a folder that is a repository: a line in the box (with the folder's own card only when a conversation
  // is picked up again).
  const branchLine = (
    <>
                {/* Uncommitted changes no longer send the agent to a copy (Arun, 2026-10-24: copies only when asked): it works in the
                    folder with them, and the branch is chosen as for any folder. */}
                {branchy && (
                  <span className="ws-branch-set">
                    {/* Off, a base picked for the new branch becomes the branch worked on: not one git has checked out in another folder. */}
                    <Switch on={newBranch} onChange={(v) => (setNewBranch(v), setErr(""), !v && branches?.find((b) => b.name === pickBranch)?.elsewhere && setPickBranch(""))} label="New branch" />
                    <span className={`ws-branch-toggle ${newBranch ? "on" : ""}`}>New branch</span>
                    {newBranch ? (
                      <>
                        <input
                          className="ws-branch-input"
                          value={branch}
                          placeholder={branchSuggestion}
                          spellCheck={false}
                          aria-label="Branch name"
                          title="Leave it empty to use the suggested name"
                          onChange={(e) => setBranch(e.target.value)}
                        />
                        {canPickBranch && (
                          <>
                            <span className="ws-branch-from">from</span>
                            <FolderBranchPick branches={branches!} current={folder?.branch} value={pickBranch} onChange={(v) => (setPickBranch(v), setErr(""))} asBase />
                          </>
                        )}
                      </>
                    ) : canPickBranch ? (
                      <span className="ws-branch-label" title="The branch the work happens on">
                        Works on <FolderBranchPick branches={branches!} current={folder?.branch} value={pickBranch} onChange={(v) => (setPickBranch(v), setErr(""))} />
                      </span>
                    ) : (
                      // Off means the work lands where the folder already
                      // is, which is the thing worth saying rather than an
                      // empty box nobody can type in.
                      // And when the pull request or the conversation is on another branch, that the folder will be moved to it.
                      <span className="ws-branch-label" title={lands && lands !== folder?.branch ? `The folder is switched to ${lands} before the agent starts` : "The work lands on the branch the folder is on"}>
                        <Icon name="gitBranch" size={12} />
                        {lands && lands !== folder?.branch ? (pr && !pr.fork ? "Works on the pull request's branch" : "Switches to") : "Works on"} <code>{lands || folder?.branch || "the current branch"}</code>
                      </span>
                    )}
                  </span>
                )}
    </>
  );
  return (
    <div className="home">
      {/* Code's home is one flat ground (Arun, 2026-10-29: "so clean and beautiful really with a clear direction in design
          language"; DIRECTION.md §9.5: the dot field goes). Work keeps its own field. */}
      {
        work ? <WorkField /> :
        null
      }
      {/* Which coding tools are here, as one pill in the corner opposite "tokens saved": their marks and how many are ready,
          with the card that signs in, switches account or installs one behind it. */}
      <div className="home-tools">
        <Badge identity={identity} machine={machine} refresh={refresh} />
      </div>
      <Greeting name={identity.name} />
      {
        work ? <HeroTitle lines={WORK_LINES} /> :
        <HeroTitle />
      }
      {/* No coding tool ready on this computer: said here, with the way to set one up, before a message is written that can only
          stop on "isn't signed in" (Arun, 2026-10-30: the first few minutes after install are where people quit). */}
      {(machine.mode === "local" || machine.mode === "linked") && !machine.tools.some((t) => t.path && t.loggedIn !== false && !t.unavailable) && (
        <div className="home-setup" role="status">
          <span>
            <b>No coding tool is ready yet.</b> Friday runs Claude Code, Codex and the others on their own plans: install or sign in to
            one to start.
          </span>
          <button type="button" className="btn small" onClick={() => window.dispatchEvent(new Event("friday:setup"))}>
            Set up
          </button>
        </div>
      )}

      <div className="composer-above">
        {/* Smart routing (routing.ts): Auto for whichever agent is chosen, when it can route. Above the box, on its own, so it is
            seen before writing rather than found among the controls under it. Off until someone turns it on; then it stays on,
            on this computer, until they turn it off here or pick a model of their own. */}
        {(engine ? canRoute(engine) : planLimits(plan).fridayAgent !== "none") &&
          (() => {
            const on = engine ? model === "auto" : fridayModelId === "auto";
            return (
              <button
                type="button"
                className={`menu-pill agent-pill route-pill${on ? " on" : ""}`}
                aria-pressed={on}
                title={
                  on
                    ? "Smart routing is on: each message runs on the model most likely to get it right for the least, from benchmarks, your limits and how your runs have gone. Press to pick the model yourself."
                    : "Smart routing: let Friday pick the model for each message, from how hard it reads, your limits and how your runs have gone."
                }
                onClick={() => {
                  const next = !on;
                  saveSmartRouting(next);
                  if (engine && next && model !== "auto") pickedModel.current = model;
                  if (engine) setModel(next ? "auto" : pickedModel.current);
                  else ((choseModel.current = true), setFridayModelId(next ? "auto" : ""));
                }}
              >
                <Icon name="zap" size={13} />
                <span>Smart routing</span>
                <span className="route-pill-state">{on ? "On" : "Off"}</span>
              </button>
            );
          })()}
      </div>
      <form
        className="composer-card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        // A link or a block of text dropped on the box becomes the task: a failing CI log, a ticket, a thread. Files and folders
        // dropped are attached, as + › Files or Folder would (the drop was ignored, and a browser then opened the file in place
        // of Friday: 2026-10-28 QA; Arun: "TEST EVERYTHING… EVERY INTERACTION").
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files") || e.dataTransfer.types.includes("text/uri-list") || e.dataTransfer.types.includes("text/plain")) e.preventDefault();
        }}
        onDrop={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            void droppedFiles(e.dataTransfer).then((got) => got.length && attach(filesNow.current, got, setFiles, setAttachNote));
            input.current?.focus();
            return;
          }
          const dropped = (e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain")).trim();
          if (!dropped) return;
          e.preventDefault();
          setGoal((g) => (g.trim() ? `${g.replace(/\s+$/, "")}\n\n${dropped}` : dropped));
          input.current?.focus();
        }}
      >
        <div className="composer-inner">
          <AttachedRow files={files} onChange={setFiles} />
          {/* The folder is part of the request, so it sits in the box with it: a card with where it is, that it stays on the computer, and the branch. */}
          {/* The folder is said by the footer's dropdown (DIRECTION.md §9.5); its branch, when it is a repository, is one quiet line
              here, and a conversation picked up again keeps its card, which says so. */}
          {hasMachine && folder && picked?.resume && (
            <FolderCard folder={folder} resume={picked.resume} where={machine.mode === "linked" ? (machine.machine?.name ?? "your computer") : "this computer"} onClear={() => (setPicked(null), setBranch(""), setNewBranch(true), setPickBranch(""))}>
              {branchLine}
            </FolderCard>
          )}
          {hasMachine && folder && !picked?.resume && branchy && <div className="cw-branch">{branchLine}</div>}
          {hasMachine && folder && engine && <AlsoWorksIn identity={identity} folder={folder.path} value={dirs} onChange={setDirs} />}
          {/* A prompt link's repo that isn't on this computer yet: one press clones it, and the box is ready. */}
          {linkRepo && !pr && !issue && hasMachine && !picked && repoMissing === linkRepo && (
            <div className="composer-link-repo">
              <Icon name="gitFork" size={13} />
              <span>
                This task is for <b>{linkRepo}</b>, which isn't on this computer yet.
              </span>
              <button
                type="button"
                className="link-btn"
                style={{ whiteSpace: "nowrap" }}
                disabled={cloning}
                onClick={() => {
                  setCloning(true);
                  hostApi<{ folder: Picked["folder"] }>(identity, "/api/runner/clone", { method: "POST", body: JSON.stringify({ repo: linkRepo }) })
                    .then((r) => setPicked({ folder: r.folder }))
                    .catch((e) => setErr((e as Error).message))
                    .finally(() => setCloning(false));
                }}
              >
                {cloning ? "Cloning…" : `Clone ${linkRepo} here`}
              </button>
            </div>
          )}
          {pr && (
            <div className="fcard">
              <div className="fcard-top">
                <span className={`fcard-icon pr ${pr.state}`} aria-hidden>
                  <GitPullRequestIcon className="size-4" />
                </span>
                <div className="fcard-body">
                  <div className="fcard-head">
                    <span className="fcard-name" title={pr.title}>
                      <span className="fcard-num">#{pr.number}</span> {pr.title}
                    </span>
                    {pr.state !== "open" && <span className="fcard-kind">{pr.state === "merged" ? "Merged" : "Closed"}</span>}
                  </div>
                  <div className="fcard-path" title={`The agent reads the change.${pr.fork ? " It comes from a fork, so the folder stays on its own branch." : ` The folder switches to ${pr.head}.`}`}>
                    <span className="fcard-where">{pr.repo}</span>
                    <span className="fcard-dot">·</span>
                    {pr.fork ? <span className="fcard-where">from a fork</span> : <span className="fcard-p">{pr.head}</span>}
                    {hasMachine && !folder && (
                      <button
                        type="button"
                        className="link-btn"
                        style={{ whiteSpace: "nowrap" }}
                        disabled={cloning}
                        onClick={() => {
                          setCloning(true);
                          hostApi<{ folder: Picked["folder"] }>(identity, "/api/runner/clone", { method: "POST", body: JSON.stringify({ repo: pr.repo }) })
                            .then((r) => setPicked({ folder: r.folder }))
                            .catch((e) => setErr((e as Error).message))
                            .finally(() => setCloning(false));
                        }}
                      >
                        {cloning ? "Cloning…" : `Clone ${pr.repo} here`}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
          {issue && (
            <div className="fcard">
              <div className="fcard-top">
              <span className="fcard-icon" aria-hidden>
                <CircleDotIcon className="size-4" />
              </span>
              <div className="fcard-body">
                <div className="fcard-head">
                  <span className="fcard-name" title={issue.title}>
                    <span className="fcard-num">#{issue.number}</span> {issue.title}
                  </span>
                  {issue.state === "closed" && <span className="fcard-kind">Closed</span>}
                </div>
                <div className="fcard-path" title="The agent reads it; the branch and pull request are named after it.">
                  <span className="fcard-where">{issue.repo}</span>
                  <span className="fcard-dot">·</span>
                  <span className="fcard-where">issue</span>
                  {/* Nothing picked yet and a machine to clone onto: the issue says which repo, so one press gets it. */}
                  {hasMachine && !folder && (
                    <button
                      type="button"
                      className="link-btn"
                      style={{ whiteSpace: "nowrap" }}
                      disabled={cloning}
                      onClick={() => {
                        setCloning(true);
                        hostApi<{ folder: Picked["folder"] }>(identity, "/api/runner/clone", { method: "POST", body: JSON.stringify({ repo: issue.repo }) })
                          .then((r) => setPicked({ folder: r.folder }))
                          .catch((e) => setErr((e as Error).message))
                          .finally(() => setCloning(false));
                      }}
                    >
                      {cloning ? "Cloning…" : `Clone ${issue.repo} here`}
                    </button>
                  )}
                </div>
              </div>
              </div>
            </div>
          )}
          <textarea
            ref={input}
            id="code-input"
            aria-label="Describe the change"
            {...(work ? { "aria-label": "Describe what to make" } : {})} // Work's own words (Arun, 2026-10-28: "iron everything… focusing on UI and UX").
            autoFocus
            // Kept as it was sent while the session is being made: an edit now would not be what the agent is given.
            readOnly={busy}
            onPaste={pasteAttach(files, setFiles, setAttachNote)}
            rows={3}
            placeholder={placeholder}
            value={goal}
            onChange={(e) => {
              setGoal(e.target.value);
              grow(e.target);
            }}
            onKeyDown={(e) => {
              // ↑ in an empty box: what you asked before, in any session.
              if (!busy && walkAsks(e, e.currentTarget, askAt, (t) => setGoal(t))) return;
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <div className="composer-bar">
            {/* One control for everything a run starts from: files, a folder
                you hand over, and the code already on your computer. A folder
                is a folder whoever works in it — a CLI opens it, and Friday's
                own agent borrows it from the computer, which is what makes the
                files, the terminal and the preview work. */}
            <AttachButton
              files={files}
              onChange={setFiles}
              onNote={setAttachNote}
              workspace={{
                identity,
                tool: engine || "claude",
                resume: picked?.resume,
                onPick: setPicked,
                onTool: (t) => ((chose.current = true), setEngine(t)),
                // In the app, it connects itself (the box says so); in a browser, straight to connecting this computer.
                ...(hasMachine ? {} : { onNeedsMachine: () => (window.fridayDesktop?.link ? setLinking(true) : connectThisComputer()) }),
                ...(work ? { plain: true } : {}), // In Work, folders: no repos, GitHub or clone (w1 #3).
              }}
            />
            {/* Where it works, as a plain text dropdown in the box's footer beside who works and how (DIRECTION.md §9.5, as Synara
                does): the picker of folders behind it, and the line that said "No folder picked: … Choose a folder" under the box
                is its title now. Picked, the cross beside it takes it off again. */}
            {/* Which computer it runs on, once you have another linked (Computers.tsx): its folders and tools are the ones offered. */}
            {isLocal() && <ComputerPill onPick={() => (setPicked(null), setBranch(""), setNewBranch(true), setPickBranch(""))} />}
            {hasMachine && (
              <span className="cw-where">
                <button
                  type="button"
                  className="cw-drop"
                  aria-label={folder ? `Folder: ${folder.name}. Choose another` : "Choose a folder"}
                  title={
                    folder
                      ? `${folder.path}\nThe folder stays on ${machine.mode === "linked" ? (machine.machine?.name ?? "your computer") : "this computer"}.`
                      : noFolderLine === "work"
                        ? "Your pieces are saved in a new folder. Choose one."
                        : files.some((f) => f.folder)
                          ? // A folder's copy attached is not a folder picked (2026-10-28 QA).
                            `${toolName || "The agent"} starts in a new project folder, with your copy of “${files.find((f) => f.folder)!.folder}” attached to the message. Choose a folder to work in it instead.`
                          : `No folder picked: ${toolName || "the agent"} starts in a new project folder. Choose one.`
                  }
                  onClick={(e) => window.dispatchEvent(new CustomEvent(PICK_FOLDER, { detail: { from: e.currentTarget } }))}
                >
                  <Icon name="folder" size={13} />
                  <span className="cw-drop-text">{folder ? folder.name : noFolderLine === "work" ? "New folder" : "No folder"}</span>
                  <Icon name="chevronDown" size={12} className="menu-pill-caret" />
                </button>
                {folder && (
                  <button type="button" className="cw-clear" aria-label={picked?.resume ? "Remove this session and folder" : "Remove this folder"} title="Remove this folder" onClick={() => (setPicked(null), setBranch(""), setNewBranch(true), setPickBranch(""))}>
                    <Icon name="x" size={12} />
                  </button>
                )}
              </span>
            )}
            {/* On Solo a saved agent rides on the coding tool: said here, and taken off with the cross. */}
            {solo && agentId && agents.some((a) => a.id === agentId) && (
              <button type="button" className="menu-pill agent-pill solo-agent" title="Its instructions go to your coding tool. Click to run without it." onClick={() => setAgentId("")}>
                <Icon name="agent" size={13} />
                <span>{agents.find((a) => a.id === agentId)!.name}</span>
                <Icon name="x" size={12} className="menu-pill-caret" />
              </button>
            )}
            {/* Who does the work and on which model are one decision, so one control: the agent, and the models that agent runs. */}
            <AgentModelPicker
              route={route}
              engine={engine}
              // Friday Code is a choice too: not marking it let the next check of the computer switch back to a coding tool.
              onEngine={(t) => ((chose.current = true), t ? setEngine(t) : (setEngine(""), setAgentId("")))}
              model={model}
              // Choosing a model in the picker decides routing too, and is remembered: Auto turns it on, any other model off.
              onModel={(id) => (engine && canRoute(engine) && saveSmartRouting(id === "auto"), id !== "auto" && (pickedModel.current = id), setModel(id))}
              fridayModelId={fridayModelId}
              onFridayModel={(id) => (saveSmartRouting(id === "auto"), (choseModel.current = true), setFridayModelId(id))}
              fridayName={agents.find((a) => a.id === agentId)?.name ?? "Friday Code"}
              plan={plan}
              identity={identity}
              toolState={toolState}
              machineName={machine.machine?.name}
              // It's your tool on your plan, so every level is yours to pick here.
              effort={effortLevels.length ? { now: effort, options: effortLevels.map((e) => ({ value: e, label: ENGINE_EFFORT_INFO[e].label, title: ENGINE_EFFORT_INFO[e].blurb })), set: setEffort } : null}
            />
            {/* Which of its accounts, for a tool with more than one on the computer: each with how much of it is used. */}
            {engine && tool?.accounts && tool.accounts.length > 1 && <AccountPill identity={identity} tool={tool} value={account} onChange={setAccount} />}
            {/* What the agent may do without asking: read and propose, ask before it runs a command, or run freely. Applies to whichever agent is chosen. */}
            <MenuButton
              className="agent-pill mode-pill"
              label="What it may do without asking"
              text={MODE_NAME[mode]}
              width={300}
              above
              items={() => [
                { heading: "What it may do" },
                ...(["plan", "edits", "full"] as EngineMode[]).map((m) => ({
                  label: MODE_NAME[m],
                  // Codex and Cursor cannot ask about one command at a time, so for them Manual asks once for the whole turn.
                  sub: m === "edits" && (engine === "codex" || engine === "cursor") ? "Asks you before any turn that changes something." : modeBlurb[m],
                  checked: mode === m,
                  onSelect: () => setMode(m),
                })),
              ]}
            />
            <button
              className="send"
              type="submit"
              disabled={!goal.trim() || busy || blocked}
              aria-label="Start the run"
              // A new session starts from what it is asked to do, so files alone don't start one: said, rather than a grey arrow.
              title={blockedWhy || (!goal.trim() && files.length ? "Say what to do with the files you attached" : undefined)}
            >
              {busy ? <span className="spinner" /> : <Icon name="arrowUp" size={17} />}
            </button>
          </div>
        </div>
      </form>
      {work && <WorkStarters off={!!goal.trim() || busy} onPick={(t) => (setGoal(t), requestAnimationFrame(() => input.current?.focus()))} />}

      {(engine || folder || picked) && !(hasMachine && folder && !(engine && tool && (!tool.path || tool.loggedIn === false))) && (
        <div className="code-ws">
          {machine.mode === "checking" ? (
            <p className="muted small">Looking for your computer…</p>
          ) : hasMachine ? (
            <>
              {engine && tool?.path && tool.loggedIn === false && (
                <p role="alert" className="error small">
                  {toolName} is signed out on this computer.{" "}
                  <button type="button" className="link-btn" disabled={signing?.busy} onClick={() => void signIn()}>
                    {signing?.busy ? "Opening…" : `Sign in to ${toolName}`}
                  </button>
                  {signing?.url && (
                    <>
                      {" · "}
                      <a className="link-btn" href={signing.url} target="_blank" rel="noreferrer">
                        Finish signing in
                      </a>
                    </>
                  )}
                  {signing?.command && <> Run this in a terminal there: <code>{signing.command}</code></>}
                  {signing?.error && <> {signing.error}</>}
                </p>
              )}
              {engine && tool && !tool.path && (
                <p role="alert" className="error small">
                  {ENGINE_NAMES[engine]} isn't installed on {machine.mode === "linked" ? machine.machine?.name : "this computer"}.{" "}
                  {/* Never a dead end: the other agent in the menu can do this
                      job in the same folder, it just can't run anything. */}
                  {!solo && (
                    <button type="button" className="link-btn" onClick={() => setEngine("")}>
                      Use Friday Code instead
                    </button>
                  )}
                </p>
              )}
              {/* No folder: said by the folder in the box's footer, whose title has what this line said (DIRECTION.md §9.5). */}
              {/* The grant is on the summary now, as a pill beside the
                  folder: a whole line of amber prose under every session is
                  a line nobody reads by the third time. */}
            </>
          ) : (
            <>
              {/* The desktop app connects its own computer. Somebody without
                  one still has a way to work: a folder attached in the
                  composer is a working copy Friday's agent can read and edit. */}
              <NoMachine />
              {engine && !solo && (
                <p className="muted small">
                  No machine?{" "}
                  <button type="button" className="link-btn" onClick={() => setEngine("")}>
                    Friday Code
                  </button>{" "}
                  can work on a folder you attach here — reading, searching and editing it. It can't run anything, which is what a machine is for.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {linking && <LinkDialog onClose={() => setLinking(false)} />}

      {resumeNote && <p className="muted small attach-note" role="status">{resumeNote}</p>}
      {attachNote && (busy || !(hasMachine && folder)) && <p className="muted small attach-note">{attachNote}</p>}
      {(err || (nudged && blockedWhy)) && <p role="alert" className="error">{err || blockedWhy}</p>}

      {/* The first thing to try once a coding tool works: the person's own agents working as a team on a sample (TeamDemo.tsx). */}
      {!work && hasMachine && firstRun && !busy && !goal.trim() && <TeamDemoOffer team={demoTeam} busy={busy} onGo={startDemo} />}

      {/* The sample runs Friday's own agent: Team's, or on Solo the person's own model. */}

      {/* What happened while you were away, before what you might do next. */}

      {/* Where the toasts of what waits on you sit on a phone, in the page rather than over "Right now" (Attention.tsx). */}
      <div id="wy-home" className="wy-home" />

      {/* Your agents right now, and how the last weeks went: in place of suggested prompts, what someone opening Friday wants first. */}
      <HomeActivity
        identity={identity}
        recents={
          isLocal() ? (work && !workListed() ? [] : recents.filter((r) => workSids.has(r.sid) === work && !isTeamSid(r.sid))) : // never a Crew room, as the sidebar (Sidebar.tsx); in Work, nothing until the Work sessions are known (a Code task listed under Work's "Right now", the 2026-10-28 critique)
          recents
        }
        onOpen={onStart}
        {...(onOpenBoard ? { onBoard: onOpenBoard } : {})}
      />
    </div>
  );
}

export type { Picked, CliSession, FolderInfo };


/** "No computer connected": a dialog like the rest, with Escape and the focus kept in it (it had neither). */
function LinkDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose, null, { trap: true });
  return (
    <div className="overlay">
      <div className="modal link-modal" ref={ref} role="dialog" aria-modal="true" aria-labelledby="link-modal-title">
        <div className="pop-head">
          <h2 id="link-modal-title">No computer connected</h2>
          <button type="button" className="icon-btn tiny" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <p className="muted small">Your repositories are on your computer, not on Friday. They show up here once it’s connected.</p>
        <NoMachine />
      </div>
    </div>
  );
}
