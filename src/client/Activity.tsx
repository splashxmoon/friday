import { shortTokens } from "../tool-usage.js";
import { collisionsFor } from "../collisions.js";
import { runawayText } from "../runaway.js";
import { limitHit, signedOut } from "../limit-reset.js";
import { cappedText, tokensUsed } from "../run-budget.js";
import { reviewOrder } from "../code-review.js";
import { hideSecrets } from "../secrets.js";
import { GitMergeIcon,
  ArrowUpIcon,
  BrainIcon,
  GitPullRequestIcon,
  ShieldCheckIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleHelpIcon,
  ClockIcon,
  EyeIcon,
  FileTextIcon,
  FileDiffIcon,
  FilePenIcon,
  GlobeIcon,
  HandIcon,
  HistoryIcon,
  LaptopIcon,
  LinkIcon,
  ListChecksIcon,
  SearchIcon,
  SendIcon,
  TerminalIcon,
  Undo2Icon,
  FlagIcon,
  UnplugIcon,
  MessageSquareIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlugIcon,
  Redo2Icon,
  SettingsIcon,
  SparklesIcon,
  SquareIcon,
  Trash2Icon,
  UserMinusIcon,
  UserPlusIcon,
  WrenchIcon,
  XIcon,
  ZapIcon,
  CrownIcon,
  type LucideIcon,
} from "lucide-react";
import { createPortal } from "react-dom";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { attributionFor, byHand, handWord, type Attribution } from "../attribution.js";
import { useNear } from "./feed-near.js";
import { GoalPill } from "./GoalPill.js";
import { useFocus } from "./focusStore.js";
import { AgentTalkCard, AgentUpdateCard, BoardCard, MeshPauseCard, MeshPauseText, teamTasks, type TaskAction } from "./AgentTalk.js";
import { showDiff } from "./focusDiff.js";
import { argsOf } from "./args.js";
import { ChainOfThought, ChainOfThoughtContent, ChainOfThoughtHeader, ChainOfThoughtSearchResult, ChainOfThoughtSearchResults, ChainOfThoughtStep } from "@/components/ai-elements/chain-of-thought";
import { Checkpoint, CheckpointIcon } from "@/components/ai-elements/checkpoint";
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageAction, MessageActions, MessageAttachments, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { ANSWER, streamSplitter } from "./AnswerParts.js";

/** An agent's words, with what it shows drawn live: pages, drawings, diagrams and pictures. A person's own messages stay as written. */
const LIVE = ANSWER;
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenuItem,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputAttachment,
  PromptInputAttachments,
  usePromptInputAttachments,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { useContextDrops } from "./contextDrop.js";
import {
  Queue,
  QueueItem,
  QueueItemAction,
  QueueItemActions,
  QueueItemContent,
  QueueItemDescription,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from "@/components/ai-elements/queue";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { AgentThinking } from "@/components/agents/agent-thinking";
import { StreamingResponse } from "@/components/agents/streaming-response";
import { Source, Sources, SourcesContent, SourcesTrigger } from "@/components/ai-elements/sources";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { FileDiff, type FileDiffLine } from "@/components/agents/file-diff";
import { patchLines } from "./patchLines.js";
export { patchLines };
import type { ProgressStatus, ProgressStep } from "@/components/agents/agent-progress";
import type { TodoStep } from "@/components/aicss/TodoList";
import { TodoList, type TodoItem } from "@/components/agents/todo-list";
import { PatchSource, useFullFiles } from "./patchSource.js";
import { originOf } from "../session/patches.js";
import { quickConnect, startingOn, useStarting } from "./quickConnect.js";
import { StartingLaneTab } from "./Lanes.js";
import { tabListKeys, useRovingTabs } from "./roving.js";
import { ToolResult, ToolResultOutput } from "@/components/agents/tool-result";
import { cn } from "@/lib/utils";
import { ownPlan } from "../own-plan.js";
import { alwaysAllowEntry, can, canDriveLane, driverOf, laneOf, pendingFor, questionsTo, runOf, signoffStatus, type OpenQuestion, type SessionState, type Thread, givenName } from "../session/projection.js";
import { isRawError, stoppedLine } from "../activity-line.js";
import { ENGINE_MODEL_INFO, ENGINE_NAMES, ENGINE_TOOLS, liveMachine, MAIN_LANE, type Attachment, type DiffFile, type EngineMode, type EngineTool, type EventBody, type EventType, type Member, type PresenceMember, type SessionEvent, type Thinking, type ToolCall, effortNote, ENGINE_EFFORT_INFO, EFFORT_RESET_NOTE, effortLevelsOf, type EngineEffort } from "../types.js";
import { fileUrl, uploadFile } from "./api.js";
import { pickable, uploadAll } from "./Attach.js";
import { AgentMark, Avatar, FridayMark, Icon, type IconName } from "./icons.js";
import { RouteWhy, costMark, useLearned } from "./RouteWhy.js";
import { forValue, rankTools, taskTier } from "../routing.js";
import { glanceOf } from "./gauge.js";
import { useToolLimits } from "./toolLimits.js";
import { ApprovalCard } from "@/components/aicss/ApprovalCard";
import { askReply, parseChoices, type Ask } from "./ask-choices.js";
import { ASK_FOCUS } from "./Attention.js";
import { rememberAsk, walkAsks } from "./askHistory.js";
import { hiddenNotes } from "../session-notes.js";
import type { AgentStatus } from "../agents-hub.js";
import { ALL, agentKey, focusAgent, jumpToNeeds, markSeen, nextKey, openedAt, useAgents, useFocusedAgent, useSeen } from "./agentFocus.js";
import { QueuedActions, runTeamCommand, TeamBanner } from "./TeamControls.js";
import { TEAM_COMMANDS } from "./team-commands.js";
import { dayBreaks } from "./team-status.js";
import { teamSid as teamSidNow } from "./Teammates.js";
/** A phone-wide window: the team's box says less (Arun, 2026-10-28: the critique's "at 420px the placeholder is short"). */
const narrowBox = () => typeof matchMedia === "function" && matchMedia("(max-width: 600px)").matches;
import { BriefCard, HoldsLifted, ProposedMate } from "./TeamBrief.js";
import { CheckInLine, HandoffLine, FoldersGiven, TeammateChanged, FridayLine, teamEmpty, mateOn, mergeSends, reconnectTeammate, useTeamVersion, isCheckIn, quietCheckIns, ToolSwitched, MentionBackdrop, MentionText, RoomsNow, namesSomeone, plumbing, teamReply, TeamRun, TeamWorking, TeammateBoxPicker, TeammateFolderCard, TeammateHeader, teammateAgents, teammateMark, teammatesNamed, TeamRecipients, ThreadChip, ThreadHost, foldTeamTalk, pieceOf, TalkGroup, teamEventKind, type TalkPiece, useSentTo, noteLaneRuns, forgetLaneRuns, useSendCopies, learnLanes, queueWhy, queueWhyAll, crewLeadName, RoomIntro, isAgentTalk , matesIn, teamKnown, teamSid} from "./Teammates.js";
import { threadsOf } from "./team-threads.js";
import { isLive, isPersonsWord, isWaiting, leadAnswers, queuedFor, roomRunKind, switchedAfter, turnsFor, type LeadInfo } from "./team-room.js";
import { AGENT_DRAG, catchUpIndex, firstUnread, maxColumns, unreadByLane } from "./agentNav.js";
import { followTarget, openingTarget } from "./follow-target.js";
import { carried, carriedFrom } from "./carried.js";
import { reviewText, type LineComment } from "./review.js";
import { savedCommands, useSavedCommands, useShortcuts } from "./Shortcuts.js";
import { CommandsDialog } from "./CommandsDialog.js";
import { HandoffBar, HandoffCard, HandoffComposer, type HandoffMore, type HandoffTarget, RunMeta, StepGroup, Thinking as ThinkingView, Working, stepFor, type FileChange, type Step } from "./Response.js";
import { DiffView, type DiffLine, type DiffMode } from "./DiffView.js";
import { PinBar } from "./PinBar.js";
import { commandFailed, receiptOf } from "../receipt.js";
import { doneVerdict, explainRun } from "../explain.js";
import { jumpPlaces, recapStats, type JumpPlace } from "../session-line.js";
import { leftOff } from "../left-off.js";
import { editPreview, failingTests, foldLine } from "../step-extras.js";
import { stepKind } from "../run-strip.js";
import { webSourcesIn, webUrl } from "../web-sources.js";
import { Mascot, runMood } from "./Mascot.js";
import { AgentSwitch, EngineMark, switchesAgent } from "./AgentSwitch.js";
import type { EffortChoice } from "./AgentModelPicker.js";
import { friday, handBackWhenDone, handingBack, hasShells, InTerminalNote, LaneTui, openLaneTerminal, preferFriday, TERMINAL_TOOLS, useTuiView, warmLaneTerminal } from "./Terminal.js";
import { runnableQueue } from "../held.js";
import { FridayTui } from "./Tui.js";
import { isLocal, startTeam } from "./edition.js";
import { isOwnModel } from "../own-model-id.js";
import { agentLook, handoffTaskText, laneIdByName, laneLabel, reasonFor, suggestTarget, tintOfColor, tintOfEngine, wakesOnItsOwn, type Signals } from "./handoff-ui.js";
import type { AgentView } from "../agents.js";
import { RaceCard } from "./Race.js";
import { askIosPreview, isLocalUrl, lookOf, openInPreview, pageAppears, servedUrlIn } from "./previewBus.js";
import { latestTests, prefillComposer, ReviewCard, secondReviewOf, testsIn } from "./RunReview.js";
import { CLASS_LABEL, headlineClass, mayApprove } from "../command-class.js";
import { checkpointsByMessage, isSetAside, rewindImpact, rewindsIn, type Rewind } from "../rewind.js";
import { ContextMenu, MenuButton, useConfirm, type MenuItem, relTime } from "./ui.js";
import { hostApi, installedOn } from "./local.js";
import { WORK_MODE_BLURB } from "./WorkMode.js";
import { openOutside } from "./openOutside.js";
import { modeOf, reachFor, reachForHandoff, reachForMessage, REACH_NAME, revertTo, settle, type Reach } from "./smartReach.js";
import { splitTools } from "./engines.js";
import { Lightbox } from "./Lightbox.js";
import { loadRecents, type Identity } from "./storage.js";
import { useLaneStream, type Send } from "./useSession.js";
import { EngineModelPill } from "./EngineModelPill.js";
import { ContextGauge } from "./gauge.js";
import { forkSession } from "./github-menu.js";
import { finishingOrder, heldOrder, type OrderInfo } from "./agent-order.js";
import { initials, tabOwner, tabState, tabsThatFit, tabWords } from "./agent-tab.js";
import { SUBAGENT_CALL, Subagents, subagentRowOf, subagentState, type SubagentRow } from "./Subagents.js";
import { subTasksIn } from "./Tasks.js";
import type { Plan } from "../plan-types.js";
import type { McpPublic } from "../mcp-types.js";

// The activity section, built from AI Elements: the team's messages are chat
// bubbles, each agent run is a chain of thought whose steps hold the tool
// calls, and control changes are checkpoints between them.

export type FeedFilter = "all" | "team" | "agent";
type Ev<T extends EventType> = SessionEvent & { body: Extract<EventBody, { type: T }> };
type Stream = { text: string; reasoning: string };
/** How far a working run's agent has got with its words: nothing yet, thinking aloud, or writing the answer. */
type Typing = "waiting" | "thinking" | "answering";
/**
 * The chosen agent's tab brought into view, once, as it is chosen: one function for good, so React calls it only when the tab
 * it is on changes. A new one each render was called on every live event, each a scroll that laid the whole page out again
 * (Arun, 2026-10-30: "the app feel laggy when running a lot of tasks and agents").
 */
const tabIntoView = (el: HTMLElement | null) => el?.scrollIntoView({ block: "nearest", inline: "nearest" });
const typingOf = (s: Stream | undefined): Typing => (s?.text ? "answering" : s?.reasoning ? "thinking" : "waiting");

/**
 * How wide a line of text is in the app's font: what an agent tab's card is measured by before it is drawn. Every tab asks on
 * every live event, so the font is read from the page once and each width kept: reading the body's style each time made the
 * browser work out the whole page's styles again first (Arun, 2026-10-30: "the app feel laggy when running a lot of tasks and agents").
 */
let measurer: CanvasRenderingContext2D | null | undefined;
let family = "";
const widths = new Map<string, number>();
function textWidth(text: string, font: string): number {
  if (measurer === undefined) {
    measurer = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
    // Measured before the app's font arrived is measured in another: measured again once it has.
    if (measurer) document.fonts?.addEventListener?.("loadingdone", () => widths.clear());
  }
  if (!measurer) return text.length * 7;
  family ||= getComputedStyle(document.body).fontFamily;
  const key = `${font}|${text}`;
  let w = widths.get(key);
  if (w === undefined) {
    measurer.font = `${font} ${family}`;
    w = measurer.measureText(text).width;
    if (widths.size > 2000) widths.clear();
    widths.set(key, w);
  }
  return w;
}

/** An item's key in the feed, the same across renders, so a turn that moves keeps its element. */
const feedKey = (it: FeedItem) => (it.kind === "run" ? `run-${it.key}` : it.kind === "notes" ? `notes-${it.evs[0]!.seq}` : String(it.ev.seq));

interface RunItem {
  kind: "run";
  /** The agent that did this work. A feed with two agents has two kinds of block and must not mix them. */
  lane: string;
  key: number;
  messages: Ev<"agent.message">[];
  /** What a coding agent changed during this run, shown under its steps. */
  diffs: Ev<"agent.diff">[];
  ended: Ev<"run.ended"> | null;
  streaming: boolean;
  /** The folder before this run touched it, when there was one under git. */
  checkpoint?: { sha: string; lane: string; /** The first step of the run it was taken for, when that is an earlier block. */ at?: number };
  /** When the run started, so the first thought can say how long it took. */
  startedTs?: number;
  /** When something else in the lane (a request for permission, a message, a handover) closed this block before the run ended, and what. */
  closedTs?: number;
  closedBy?: string;
  /** Where in the log it was closed, so what came after (a subagent of a later turn) isn't counted as its own. */
  closedSeq?: number;
  /** The instruction that set this run going, for saying why the diff exists. */
  ask?: { who: string; text: string };
  /** What the agent wrote down as decided during this run. */
  decided: string[];
  /** Commands that stopped to ask a person, and the answer: what Auto would have run without asking. */
  asked: { id: string; command: string; answer: "yes" | "no" | "pending" }[];
  /**
   * Its change set is the one the run before it on this lane already showed: a coding tool reports everything uncommitted
   * after every turn. The card still shows here, on the newest run where it can be acted on, but credited to the request
   * that made the changes: it said this run's request was why, for changes this run never made.
   */
  unchanged?: boolean;
  /** Files in its change set exactly as the card before it showed them: still waiting from earlier, not this run's doing. */
  earlier?: string[];
  /** Drawn just above the note at this seq, which came before it in the log: the Stop of the turn whose cut-short draft it is. */
  placeBefore?: number;
}
type Item = { kind: "event"; ev: SessionEvent } | RunItem;
/** Housekeeping that arrived together, folded into one line until somebody wants it. */
type NotesItem = { kind: "notes"; evs: SessionEvent[] };
type FeedItem = Item | NotesItem;

/** Who joined, who has the wheel, which machine attached: true, but not the conversation. */
const QUIET = new Set<string>(["session.created", "session.updated", "member.joined", "member.role_changed", "member.removed", "link.updated", "control.requested", "role.requested", "role.declined", "control.granted", "control.denied", "control.released", "engine.expected", "engine.attached", "engine.detached"]);

/**
 * Two or more of them in a row become one line; a lone one is already small.
 *
 * One agent's to a line: the line is shown under its first note's agent, so Claude Code connecting straight after Codex
 * was listed under Codex.
 */
export function foldNotes(items: Item[]): FeedItem[] {
  const out: FeedItem[] = [];
  let pending: SessionEvent[] = [];
  const flush = () => {
    if (pending.length > 1) out.push({ kind: "notes", evs: pending });
    else for (const ev of pending) out.push({ kind: "event", ev });
    pending = [];
  };
  for (const it of items) {
    // An attach that dropped a lane's effort pin says so on its own line: folded away, nobody would see their pick undone.
    if (it.kind === "event" && QUIET.has(it.ev.body.type) && !("effortReset" in it.ev.body && it.ev.body.effortReset)) {
      if (pending.length && (pending[0]!.lane ?? MAIN_LANE) !== (it.ev.lane ?? MAIN_LANE)) flush();
      pending.push(it.ev);
    } else {
      flush();
      out.push(it);
    }
  }
  flush();
  return out;
}

interface Ctx {
  me: Member;
  /** Which models this workspace may run. */
  plan: Plan;
  /** This session's workspace is Solo: only its owner steers, and Friday's own agent isn't there. */
  solo?: boolean;
  /** Solo as the session's own workspace said it, not guessed from the one the app has open: what acts on it waits for this. */
  soloSure?: boolean;
  /** Connected MCPs, for the composer's slash commands. */
  connections: McpPublic[];
  state: SessionState;
  results: Map<string, Ev<"tool.result">>;
  questions: Map<string, Ev<"agent.question">>;
  delivered: Set<number>;
  send: Send;
  sid: string;
  invite: string;
  notify: (m: string) => void;
  /** Who you are to your own machine, for asking it to change what it allows. */
  identity: Identity;
  /** Show a message of your own before the server has echoed it back. Returns how to take it back, if it never arrives. */
  echo: (text: string, lane: string) => () => void;
  /** Open the panel that holds what a run produced. */
  onOpen?: (what: "files" | "tree" | "preview") => void;
  /** Where the newest commit and undo sit in the log, so a review card knows if it was answered. */
  lastCommitSeq: number;
  /** The last time a separate copy's work was brought into its folder. */
  lastApplySeq: number;
  lastRestoreSeq: number;
  /** Rewinds so far, so what they set aside can be drawn as set aside. */
  rewinds: Rewind[];
  /** For each message, the checkpoint a rewind to before it would use, when there is one. */
  checkpoints: Map<number, string>;
  /** Every event, for working out what a rewind would undo. */
  events: SessionEvent[];
  /** Open the connect dialog, on an agent if one was chosen, and starting from the folder of the lane handing work over. */
  onConnect?: (lane: string, tool?: EngineTool | "", from?: string) => void;
  /** The workspace's saved agents, for bringing one in to take work. */
  agents?: AgentView[];
  /** Who is in the room right now, from the session's presence. */
  presence?: PresenceMember[];
  /** The recording's link, while the viewer link is on: offered under any finished run that changed something. */
  replayLink?: string;
  /** A recording or watch page: nobody is signed in, so nothing here asks the server about anyone's tools or workspace. */
  replaying?: boolean;
}


/**
 * Whether a settings change is worth a line in the feed.
 *
 * Kept beside the renderer that writes those lines: the two have to agree, or
 * the feed shows a row the renderer draws nothing into.
 */
function describesAChange(b: Extract<EventBody, { type: "session.updated" }>): boolean {
  const o = b.options;
  return Boolean(
    b.title ||
      o.agent !== undefined ||
      o.controlMode ||
      o.webSearch !== undefined ||
      o.thinking !== undefined ||
      o.mcp !== undefined ||
      o.policy,
  );
}

/**
 * Events the feed does not draw.
 *
 * The first six are folded into something else — a run block, a tool result, a
 * question card. The rest have no line in the feed at all and belong to a
 * panel instead: commands and edits to the Terminal and Files, lanes to the
 * Lanes card, a saved memory to its own list. They were not listed here, so
 * each one still produced an empty row: no text, no icon, and a gap where the
 * eye expects something.
 */
const HIDDEN = new Set<string>([
  // The terminal view switched on and off: how an agent is looked at, not something that happened (Arun, 2026-10-30).
  "lane.terminal",
  // A second opinion on a turn is drawn under that turn (Asides), question and answer together.
  "aside.asked",
  "aside.answered",
  // A coding tool's subagents are listed in the Tasks panel; the step that started one is already in its run.
  "agent.task",
  // Files an agent holds while it changes them (claim_files): said in the agents' talk and list_agents, not as a row each.
  "files.held",
  "files.released",
  // A wake set or gone off (wake_me_when): the wake's own message to the agent says it, as Friday's line.
  "wake.set",
  "wake.fired",
  "wake.cancelled",
  // Counts, for the Usage panel and page: what a turn used, and what a hand-off carried.
  "agent.usage",
  "context.carried",
  // Said on the run it came before, under its reply (RunMeta): a row of its own would cut the run's block in two.
  "context.compacted",
  // What the router would have picked in a session not on Auto: for checking its rules, not for the room.
  "model.routed",
  "run.started",
  "run.checkpoint",
  "instructions.delivered",
  "tool.result",
  "agent.question",
  "doc.updated",
  "run.interrupt",
  "instruction.withdrawn",
  // A held message's card says itself whether it was let through.
  "peer.settled",
  // An agent's answer to another's question is drawn under the question; the asker stopping waiting is in that card's note.
  "mesh.replied",
  "mesh.unwaited",
  // Who has read an update is said on the update's card.
  "mesh.read",
  // A board task moving is shown on the board's card, live.
  "board.claimed",
  "board.finished",
  "board.review",
  "board.reviewed",
  "suggestion.dismissed",
  "lane.added",
  "lane.removed",
  "lane.renamed",
  "folder.switched",
  "folder.ran",
  "folder.edited",
  "folder.uploaded",
  "plan.approved",
  "memory.saved",
  // Drawn nowhere in the feed (2026-10-27 audit): a row of nothing all the same, and each one cut the run it fell in into two
  // blocks, folding the answer above it away (a thumb on an answer split its run). A reaction is drawn on its message; a pin,
  // a review thread and a handover on their own cards; a board task's moves on the board; a requeue and a crew on the lanes.
  "message.reacted",
  "pin.added",
  "pin.removed",
  "thread.sent",
  "thread.replied",
  "thread.resolved",
  "thread.reopened",
  "handover.offered",
  "handover.cancelled",
  "board.released",
  "board.cancelled",
  "board.checking",
  "board.checked",
  "instructions.requeued",
  "crew.applied",
]);

/**
 * What a change set says, for telling whether a run changed anything since the last one: each diff's files array is the
 * logged event's own and never changes, so its text is made once rather than again for every run on every event.
 */
/**
 * Whether two logged files are the same patch: kept in the same change set (patches.ts), which holds whether either came whole
 * (a lane's latest) or by name only (an older one, its text on the server), or else the same text.
 */
function samePatch(a: DiffFile, aSeq: number, b: DiffFile, bSeq: number): boolean {
  if ((a.later ?? originOf(a, aSeq)) === (b.later ?? originOf(b, bSeq))) return true;
  return !!a.patch && a.patch === b.patch;
}
/** Two change sets with the same files, each the same patch. */
function sameSet(a: Ev<"agent.diff">, b: Ev<"agent.diff">): boolean {
  if (a.body.files.length !== b.body.files.length) return false;
  const was = new Map(a.body.files.map((f) => [f.path, f]));
  return b.body.files.every((f) => {
    const p = was.get(f.path);
    return !!p && samePatch(p, a.seq, f, b.seq);
  });
}

/**
 * One agent's consecutive steps form one run block; anything the team does in that agent's lane starts a new one.
 *
 * Per lane, because two agents work at once and their steps arrive interleaved. Grouped as one column, the
 * second agent's steps were folded into the first agent's block and read as the first agent doing both jobs.
 * `streaming` is the lanes whose agent is working right now (a bare true means the main lane).
 */
export { group as groupForTest };
export function group(events: SessionEvent[], streaming: boolean | ReadonlySet<string>): Item[] {
  const live = typeof streaming === "boolean" ? (streaming ? new Set([MAIN_LANE]) : new Set<string>()) : streaming;
  const items: Item[] = [];
  /** Each lane's open run, and the one that just finished (for anything still arriving from it). */
  const runs = new Map<string, RunItem>();
  const lasts = new Map<string, RunItem>();
  /** Taken as a lane's run started; belongs to the block its first step opens. */
  const checkpoints = new Map<string, RunItem["checkpoint"]>();
  const startedAt = new Map<string, number>();
  /** Every instruction by seq, so a run can say who asked for it and what they said. */
  const instructions = new Map<number, { who: string; text: string } | undefined>();
  /** The instruction a lane's next run was started by. */
  const asks = new Map<string, { who: string; text: string } | undefined>();
  /** The last real ask in each lane, which an approval answer stands in for. */
  const lastAsk = new Map<string, { who: string; text: string }>();
  /** A block the team closed mid-run (a message queued, a pause): the turn carries on in the next block, still about its ask. */
  const cutShort = new Map<string, RunItem>();
  /** The asks of a run that stopped for an answer, handed to the run the answer starts. */
  const carryAsked = new Map<string, RunItem["asked"]>();
  /** Commands that stopped to ask, by approval id, so the answer can find them. */
  const askedById = new Map<string, { id: string; command: string; answer: "yes" | "no" | "pending" }>();
  /** Each lane's last change set, attached to a run or not: one said again is left out. */
  const lastDiff = new Map<string, Ev<"agent.diff">>();
  /** The last event the feed shows, so a diff can tell what it follows. */
  let prevType = "";
  /** Where each lane's loose change set stands in the feed, while nothing of that lane's has come after it. */
  const looseAt = new Map<string, number>();
  /**
   * A lane's block the team closed while its turn was under way, until that agent's next turn is handed to it: what that turn
   * had written when it was stopped (an interrupted message, which the hub logs just after the stop) is its own, in its block.
   */
  const stoppedTurn = new Map<string, RunItem>();
  /** A lane's Stop note, until its agent next says anything: a turn stopped before its first message is drawn above it. */
  const stopNote = new Map<string, Item>();
  /** Blocks drawn just above a note that came before them in the log (stopNote). */
  const above = new Map<RunItem, Item>();
  // A queued message changed is one message: the one it replaced, or the one taken back to be changed, isn't drawn beside it as
  // "Taken back before the agent read it" (2026-10-28 QA; Arun: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
  const edited = new Set<number>();
  for (const ev of events) {
    const b = ev.body;
    if (b.type === "instruction" && b.replaces !== undefined) edited.add(b.replaces);
    else if (b.type === "instruction.withdrawn" && b.toEdit) edited.add(b.seq);
  }
  for (const ev of events) {
    const t = ev.body.type;
    if (t === "instruction" && edited.has(ev.seq)) continue;
    const lane = ev.lane ?? MAIN_LANE;
    // Auto's own picks are lines in the feed; what it would have picked elsewhere (`shadow`) is not (see HIDDEN).
    const shown = t === "model.routed" ? !(ev.body as Extract<EventBody, { type: "model.routed" }>).shadow : !HIDDEN.has(t);
    if (t !== "agent.diff" && shown) prevType = t;
    if (t === "run.started") {
      const sha = (ev.body as Extract<EventBody, { type: "run.started" }>).checkpoint;
      if (sha) checkpoints.set(lane, { sha, lane });
      else checkpoints.delete(lane);
      cutShort.delete(lane);
      stoppedTurn.delete(lane);
      stopNote.delete(lane);
      startedAt.set(lane, ev.ts);
      asks.set(lane, instructions.get((ev.body as Extract<EventBody, { type: "run.started" }>).causedBy));
    }
    // Taken by the runner itself, just before its tool heard the turn: said after the start, ahead of anything the tool did.
    // The agent's next turn is handed to it: nothing after this is the stopped turn's.
    if (t === "instructions.delivered") stoppedTurn.delete(lane);
    if (t === "run.checkpoint") checkpoints.set(lane, { sha: (ev.body as Extract<EventBody, { type: "run.checkpoint" }>).checkpoint, lane });
    if (t === "instruction") {
      const b = ev.body as Extract<EventBody, { type: "instruction" }>;
      // A yes to a command is not what the run is for: the run that follows it is still about the ask before it, and
      // the commands that stopped to ask belong to it too, since that is the run that does what was asked about. Friday's
      // own "[session] Carry on" isn't either: what it carries on is the ask before it.
      const standIn = !!b.approval || b.text.startsWith("[session]");
      if (!standIn) lastAsk.set(lane, { who: ev.actor.name, text: b.text });
      // Only what this answer is about: carrying the whole list from the lane's last run listed every earlier turn's answers
      // again under each new one (Arun, 2026-10-28: "iron everything and ensure we are good… any logic errors and fixes"). An
      // answer given while its block is still open carries nothing: the run goes on in that block, with its asks.
      if (b.approval) {
        if (runs.get(lane)) carryAsked.delete(lane);
        else carryAsked.set(lane, (lasts.get(lane) ?? cutShort.get(lane))?.asked.filter((a) => a.id === b.approval!.id) ?? []);
      }
      instructions.set(ev.seq, standIn ? lastAsk.get(lane) : { who: ev.actor.name, text: b.text });
      // The driver's answer to a command that stopped to ask.
      const a = b.approval && askedById.get(b.approval.id);
      if (a) a.answer = b.approval!.approve ? "yes" : "no";
    }
    if (t === "memory.saved" && runs.get(lane) && (ev.body as Extract<EventBody, { type: "memory.saved" }>).text) runs.get(lane)!.decided.push((ev.body as Extract<EventBody, { type: "memory.saved" }>).text);
    if (!shown) continue;
    // A settings change with nothing to say is not a row. Switching model is
    // the case: it changes what the next step costs, not what the room is
    // looking at, and it left a line reading "You" with nothing after it.
    if (t === "session.updated" && !describesAChange(ev.body as Extract<EventBody, { type: "session.updated" }>)) continue;
    if (t === "agent.message") {
      let run = runs.get(lane);
      // What a stopped turn had written, logged just after the stop: in that turn's block, above the stop's note.
      const kept = !run && (ev.body as Extract<EventBody, { type: "agent.message" }>).interrupted ? stoppedTurn.get(lane) : undefined;
      if (kept) {
        kept.messages.push(ev as Ev<"agent.message">);
        stopNote.delete(lane);
        continue;
      }
      if (!run) {
        // No start of its own: the same turn carrying on after the team cut its block short (a message queued mid-run, a
        // permission answer, a pause and Resume). It keeps that run's ask and the folder from before it, so its card still says
        // why and can still undo; without a block to carry on from, the lane's last ask.
        const from = asks.has(lane) ? undefined : cutShort.get(lane);
        const ask = asks.has(lane) ? asks.get(lane) : from ? from.ask : lastAsk.get(lane);
        const checkpoint = checkpoints.get(lane) ?? (from?.checkpoint ? { ...from.checkpoint, at: from.checkpoint.at ?? from.key } : undefined);
        cutShort.delete(lane);
        run = { kind: "run", lane, key: ev.seq, messages: [], diffs: [], ended: null, streaming: false, startedTs: startedAt.get(lane), decided: [], asked: [...(carryAsked.get(lane) ?? [])], ...(ask ? { ask } : {}), ...(checkpoint ? { checkpoint } : {}) };
        checkpoints.delete(lane);
        startedAt.delete(lane);
        asks.delete(lane);
        carryAsked.delete(lane);
        items.push(run);
        runs.set(lane, run);
        lasts.delete(lane);
        looseAt.delete(lane);
        const note = (ev.body as Extract<EventBody, { type: "agent.message" }>).interrupted ? stopNote.get(lane) : undefined;
        if (note) {
          above.set(run, note);
          // The stopped turn's draft, and the stop closed it: shut here, so the next message to the agent doesn't close it again
          // as merely cut short, which took its "stopped" away (Arun, 2026-10-28: "iron everything and ensure we are good"). What
          // else that turn still logs (its last change set, more of its draft) is still its own.
          if (note.kind === "event") (run.closedBy = note.ev.body.type), (run.closedSeq = note.ev.seq), (run.closedTs = note.ev.ts);
          run.messages.push(ev as Ev<"agent.message">);
          stopNote.delete(lane);
          runs.delete(lane);
          lasts.set(lane, run);
          stoppedTurn.set(lane, run);
          continue;
        }
      }
      stopNote.delete(lane);
      run.messages.push(ev as Ev<"agent.message">);
      continue;
    }
    // A diff belongs to the run that made it; it doesn't interrupt the run
    // block. It can also arrive a moment after the run ended — the machine
    // reports changes on a short debounce — and that is still that run's
    // diff, not a loose card floating under it.
    // The folder's state after an undo is news for the Diff tab, not a
    // second card in the feed: the undo notice already says what happened.
    if (t === "agent.diff" && !runs.get(lane) && (prevType === "folder.restored" || prevType === "folder.committed" || prevType === "folder.applied")) continue;
    // The same change set said again is not news: a coding tool reports its folder each time it reconnects (a deploy, a drop),
    // and each report stood as one more "Changed 34 files" card in a row (Arun, 2026-10-24).
    if (t === "agent.diff") {
      const d = ev as Ev<"agent.diff">;
      const before = lastDiff.get(lane);
      lastDiff.set(lane, d);
      if (before && !runs.get(lane) && !lasts.get(lane) && sameSet(before, d)) continue;
    }
    if (t === "agent.diff" && (runs.get(lane) || lasts.get(lane))) {
      (runs.get(lane) ?? lasts.get(lane))!.diffs.push(ev as Ev<"agent.diff">);
      continue;
    }
    if (t === "run.ended") {
      const run = runs.get(lane);
      if (run) {
        run.ended = ev as Ev<"run.ended">;
        lasts.set(lane, run);
        runs.delete(lane);
        continue;
      }
      if ((ev as Ev<"run.ended">).body.outcome !== "error") continue;
    }
    // A request for permission is the run's own last word, not something the team did: it is shown under the block and the
    // block stays open for the run's end. Closing it there dropped that end, and with it the run's review card, so a Manual
    // run that asked to run a command left no way to accept or undo what it had changed.
    if (t === "engine.approval" && runs.get(lane)) {
      const b = ev.body as Extract<EventBody, { type: "engine.approval" }>;
      if (b.scope === "commands") {
        for (const command of b.items) {
          const a = { id: b.id, command, answer: "pending" as const };
          runs.get(lane)!.asked.push(a);
          askedById.set(b.id, a);
        }
      }
      items.push({ kind: "event", ev });
      continue;
    }
    // A yes or no to what the run is waiting on, answered while it runs (Claude Code asks mid-turn): the run carries on, in
    // the same block. It is drawn as nothing, and the card it answers leaves the feed.
    if (t === "instruction" && (ev.body as Extract<EventBody, { type: "instruction" }>).approval && runs.get(lane)) continue;
    // Something the team did in this lane closes its block. Another lane's work carries on around it.
    const open = runs.get(lane);
    if (open) (open.closedTs = ev.ts), (open.closedSeq = ev.seq), (open.closedBy = t), cutShort.set(lane, open), stoppedTurn.set(lane, open);
    // A stop after something else closed the turn's block (the runaway guard's note, a message sent mid-run): that block was the
    // turn stopped, and says so, rather than reading as still at work (Arun, 2026-10-28: "iron everything and ensure we are good").
    const stopped = t === "run.pause" || t === "run.cancel";
    const was = !open && stopped ? stoppedTurn.get(lane) : undefined;
    if (was && !was.ended) (was.closedBy = t), (was.closedTs = ev.ts);
    runs.delete(lane);
    lasts.delete(lane);
    // A loose change set with nothing of its lane's since the one before: the folder as it stands now, in that card's place.
    // A coding tool reports its folder each time it comes back, and each runner measures it from where it stands, so two
    // reports could differ and never dedupe; a session that had been through a few deploys read as a column of "Changed 80
    // files" cards with nothing between them (Arun, 2026-10-25).
    if (t === "agent.diff") {
      const i = looseAt.get(lane);
      const was = i === undefined ? undefined : items[i];
      if (was?.kind === "event" && was.ev.body.type === "agent.diff") {
        items[i!] = { kind: "event", ev };
        continue;
      }
      looseAt.set(lane, items.length);
    } else looseAt.delete(lane);
    const item: Item = { kind: "event", ev };
    if (stopped) stopNote.set(lane, item);
    items.push(item);
  }
  // A turn stopped before its first message said anything: what it had written goes above the stop's note, where it was cut.
  for (const [run, note] of above) {
    const from = items.indexOf(run);
    const to = items.indexOf(note);
    if (from <= to || to === -1) continue;
    items.splice(to, 0, ...items.splice(from, 1));
    if (note.kind === "event") run.placeBefore = note.ev.seq;
  }
  let n = 0;
  for (const lane of live) {
    const run = runs.get(lane);
    if (run) run.streaming = true;
    else items.push({ kind: "run", lane, key: -1 - n++, messages: [], diffs: [], ended: null, streaming: true, decided: [], asked: [] });
  }
  // A run whose change set is the same as the last one shown on its lane changed nothing itself: credited to the run that did.
  const shownSet = new Map<string, { by: RunItem; ev: Ev<"agent.diff"> }>();
  for (const it of items) {
    if (it.kind !== "run" || !it.diffs.length) continue;
    const last = it.diffs.at(-1)!;
    const files = last.body.files;
    const before = shownSet.get(it.lane);
    if (before && sameSet(before.ev, last)) {
      it.unchanged = true;
      // Never its own ask: it didn't make these changes.
      if (before.by.ask) it.ask = before.by.ask;
      else delete it.ask;
    } else {
      // Some of it changed: what is untouched since the last card isn't this run's (a patch to compare, or it can't be told).
      const was = new Map(before?.ev.body.files.map((f) => [f.path, f]));
      const earlier = files
        .filter((f) => {
          const p = was.get(f.path);
          return !!p && !!(f.patch || f.later || f.at) && samePatch(p, before!.ev.seq, f, last.seq);
        })
        .map((f) => f.path);
      if (earlier.length) it.earlier = earlier;
      shownSet.set(it.lane, { by: it, ev: last });
    }
  }
  return items;
}

/** Scroll the feed to the item that holds this point in the log, and let it flash once. */
export function jumpTo(seq: number): void {
  let best: { el: HTMLElement; seq: number } | null = null;
  for (const el of document.querySelectorAll<HTMLElement>("[data-seq]")) {
    const n = Number(el.dataset.seq);
    if (n <= seq && (!best || n > best.seq)) best = { el, seq: n };
  }
  if (!best) return;
  best.el.scrollIntoView({ block: "center", behavior: "smooth" });
  best.el.classList.add("jump-flash");
  setTimeout(() => best!.el.classList.remove("jump-flash"), 1400);
}

export function Activity({
  /** How far this person had read when they opened the room: the "new since you looked" line sits after it. */
  seenSeq,
  readers,
  merged,
  onPlayBack,
  replayLink,
  plan,
  solo,
  soloSure,
  connections,
  state,
  me,
  events,
  streams,
  send,
  sid,
  invite,
  notify,
  identity,
  onOpen,
  onConnect,
  agents,
  presence,
  replaying = false,
  pin,
  secondary = false,
  headSlot = null,
  onFocusLane,
  onCloseColumn,
  onPickLane,
  otherLanes,
  under,
  split,
}: {
  /** The session's status bar: the Jump menu and the context gauge go there instead of under the box. */
  under?: HTMLElement | null;
  /** Two agents' chats side by side (SessionView): offered in an agent tab's menu. `toggle(lane)` opens that agent beside the one in view. */
  split?: { on: boolean; can: boolean; toggle: (lane?: string) => void };
  /** Which agent this column shows is chosen from its header; picking the other column's agent swaps the two. */
  onPickLane?: (lane: string) => void;
  /** The agents the other columns show, so the list can say so. */
  otherLanes?: string[];
  /** Show only this agent, and write only to it: one column of a split chat. */
  pin?: string;
  /**
   * Where the session's header has room for the agents' tabs (SessionView, a wide window with one chat): the bar is drawn
   * there, a line each, instead of across the top of the chat (Arun, 2026-10-24: "move the coding tool tabs to the header
   * since we have space").
   */
  headSlot?: HTMLElement | null;
  /** The second column: leaves out what the first already does for the whole session. */
  secondary?: boolean;
  /** This column was used, so the panels beside it should follow its agent. */
  onFocusLane?: (lane: string) => void;
  /** Close this column and go back to one view. */
  onCloseColumn?: () => void;
  plan: Plan;
  solo?: boolean;
  soloSure?: boolean;
  connections: McpPublic[];
  state: SessionState;
  me: Member;
  events: SessionEvent[];
  /** What each agent is typing right now, by lane. */
  streams: Record<string, Stream>;
  /** Wound back: the feed is history, so there is nothing to write into. */
  replaying?: boolean;
  seenSeq?: number;
  readers?: { id: string; name: string; path: string; line: number }[];
  /** The pull request this session opened has merged: the last card. */
  merged?: { url: string; at: number } | null;
  /** Open the History panel and play the session from the start. */
  onPlayBack?: () => void;
  /** The recording's link, for the card at the end. */
  replayLink?: string;
  send: Send;
  sid: string;
  invite: string;
  notify: (m: string) => void;
  identity: Identity;
  onOpen?: (what: "files" | "tree" | "preview") => void;
  onConnect?: (lane: string, tool?: EngineTool | "", from?: string) => void;
  agents?: AgentView[];
  presence?: PresenceMember[];
}) {
  const [filter, setFilter] = useState<FeedFilter>("all");
  // Redrawn as the crew changes: the feed names and draws teammates from it (Teammates.tsx).
  useTeamVersion();
  // With more than one lane running, the feed is unreadable as one column. Which agent is in view is the page's one
  // choice (agentFocus.ts): the rail, the box, the panels and the keys all read and set the same one. A column of a split
  // keeps to its own agent.
  const focusedHere = useFocusedAgent(sid);
  const laneFilter = pin ?? focusedHere;
  // Whether the feed is at its end, following new work, or someone has moved up to read (the All agents order waits for them).
  const [following, setFollowing] = useState(true);
  const setLaneFilter = useCallback((lane: string) => (pin ? undefined : focusAgent(sid, lane)), [pin, sid]);
  // The header shows All and as many agents as fit (at most SHOWN); the rest wait behind the "+N" button.
  const SHOWN = 6;
  let everyone = [MAIN_LANE, ...state.lanes.map((l) => l.id)];
  // The team (teammates.ts): its main lane is the room itself, nobody's agent, so only the teammates have tabs.
  if (state.options.team) everyone = state.lanes.map((l) => l.id);
  // A coding agent pressed in from this page: a tab from that moment, which starts until its runner attaches.
  const startingNow = useStarting(sid);
  const startingAhead = startingNow.filter((s) => !s.lane || !everyone.includes(s.lane));
  // Each agent's state from the one place that works it out (agents-hub.ts, via the session view), and how much of its
  // work this person hasn't seen: what the rail shows on every tab, so nobody has to open a panel to know who wants them.
  const hubAgents = useAgents();
  const statusOf = (id: string) => hubAgents.find((a) => a.lane === id);
  const needs = pin ? [] : hubAgents.filter((a) => a.needsYou);
  const seen = useSeen(sid);
  // Where this page came in, shared by every column of a split, so an agent dropped into a new column still has its unread work.
  const openSeq = openedAt(sid, events.at(-1)?.seq ?? 0);
  const lastSeqNow = events.at(-1)?.seq ?? 0;
  const unread = useMemo(() => unreadByLane(events, seen, openSeq, me.id), [events, seen, openSeq, me.id]);
  // Coming to an agent with work you haven't seen: its feed opens at the first of it, under a "New since you looked" line
  // of its own (Arun, 2026-10-18), rather than at the bottom with the count gone and no telling where the new part began.
  // Taken as the agent comes into view, before its work is marked seen, and kept until another agent is chosen.
  const catchUp = useRef<{ lane: string; seq: number } | null>(null);
  const cameTo = useRef<string | null>(null);
  if (cameTo.current !== laneFilter) {
    cameTo.current = laneFilter;
    const at = laneFilter !== ALL && (unread[laneFilter] ?? 0) > 0 ? firstUnread(events, laneFilter, seen[laneFilter] ?? openSeq, me.id) : null;
    catchUp.current = at === null ? null : { lane: laneFilter, seq: at };
  }
  const inView = laneFilter === ALL ? everyone.join(",") : laneFilter;
  useEffect(() => {
    if (replaying) return;
    const mark = () => {
      if (document.hidden) return;
      for (const l of inView.split(",")) markSeen(sid, l, lastSeqNow);
    };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [inView, lastSeqNow, sid, replaying]);
  // As many agents as the bar's width takes (at most SHOWN), the rest behind +N: each tab is a card now, its width its name's
  // or its state's, so the count is worked out from those rather than fixed. Which ones stay in sight goes by what matters
  // now: the one you are looking at, then any that need you, then the ones at work; they keep their places in the row, so a
  // tab never jumps along it as its agent changes state.
  const [fit, setFit] = useState(SHOWN);
  const shownN = Math.min(SHOWN, fit);
  const urgency = (id: string) => (id === laneFilter ? 0 : statusOf(id)?.needsYou ? 1 : statusOf(id)?.status === "working" ? 2 : 3);
  const ranked = everyone.map((id, i) => ({ id, i })).sort((a, b) => urgency(a.id) - urgency(b.id) || a.i - b.i).map((x) => x.id);
  const inSight = new Set(ranked.slice(0, shownN));
  const shownIds = everyone.filter((id) => inSight.has(id));
  let bar = true;
  // The team has the sidebar's Team tab to move between teammates, and the header names who is in view: no tabs here.
  if (state.options.team) bar = false;
  let allLabel = "All agents";
  if (state.options.team) allLabel = "Crew room";
  const hiddenIds = everyone.filter((id) => !inSight.has(id));
  const pickLane = (id: string) => setLaneFilter(id);
  const ownerOf = (id: string) => {
    const engine = state.engines[id];
    return tabOwner(laneLabel(state, id), engine?.hostId ? { id: engine.hostId, name: engine.hostName } : null, me.id);
  };
  /** The line under an agent's name: whose it is when it isn't yours, and where it stands. */
  const tabSub = (id: string, steady = false) => {
    if (id === "all") {
      const working = hubAgents.filter((a) => a.status === "working").length;
      return working ? `${working} working` : "Everyone";
    }
    const st = statusOf(id);
    const owner = ownerOf(id).owner;
    const at = tabState(st?.status, st?.needsYou);
    // Measured with its widest time, so the count of tabs doesn't change as the seconds tick.
    const words = steady && at === "working" ? "Working · 59m" : tabWords(at, st?.startedAt, Date.now());
    return `${owner ? `${owner.split(/\s+/)[0]} · ` : ""}${words}`;
  };
  const cardWidths = ranked.map((id) => {
    const { name, owner } = ownerOf(id);
    // In the header a tab is one line, its name beside its mark: where it stands is in its ring and its tip.
    // 15 of padding, the 20px mark and its 4 of margin, 8 between it and the name, a border each side: 49, and the chevron
    // on the one in view (14, less 2, and its 8 of gap) 20.
    // Someone else's has their initials beside the name: a 16px chip and its 6 of margin.
    if (headSlot) return Math.ceil(49 + Math.min(128, textWidth(name, "500 12.5px")) + (owner ? 22 : 0) + (state.lead === id ? 17 : 0) + (laneFilter === id ? 20 : 0));
    return Math.ceil(61 + Math.max(Math.min(150, textWidth(name, "500 13px")), textWidth(tabSub(id, true), "400 11px")) + (state.lead === id ? 24 : 0) + (laneFilter === id ? 26 : 0));
  });
  const widthsKey = cardWidths.join(",");
  const tabsEl = useRef<HTMLDivElement>(null);
  // Filter by agent is a tab list: only the picked tab is a Tab stop, the arrows move between them (roving.ts).
  useRovingTabs(tabsEl);
  /** The bar, in the header's slot when it has one, or where it always was. */
  const inHead = (bar: ReactNode) => (headSlot ? createPortal(bar, headSlot) : bar);
  const [tabsOver, setTabsOver] = useState(false);
  useEffect(() => {
    const el = tabsEl.current;
    if (!el) return;
    const measure = () => setTabsOver(el.scrollWidth > el.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [state.lanes.length, headSlot]);
  useEffect(() => {
    const bar = tabsEl.current?.closest<HTMLElement>(".feed-toolbar");
    if (!bar) return;
    const measure = () => {
      const cs = getComputedStyle(bar);
      const pill = bar.querySelector<HTMLElement>(".needs-pill");
      const all = tabsEl.current?.firstElementChild as HTMLElement | null;
      // The bar, less its padding, the needs-you pill, All agents and the + card.
      const head = bar.classList.contains("in-head");
      // In the header, the room the header has for the bar (SessionView.tsx useCentredTabs), not the bar's own width: that is
      // only as wide as the tabs already shown.
      const free = head ? Number(headSlot?.dataset.room) : NaN;
      const room = (free > 0 ? free : bar.clientWidth) - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - (pill ? pill.offsetWidth + 12 : 0) - (all?.offsetWidth ?? 130) - (head ? 4 + 30 + 4 : 6 + 52 + 10);
      const n = tabsThatFit(widthsKey.split(",").map(Number), room, head ? 4 : 6, head ? 54 : 72, SHOWN);
      setFit((was) => (was === n ? was : n));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    const roomChanged = new MutationObserver(measure);
    if (headSlot) roomChanged.observe(headSlot, { attributes: true, attributeFilter: ["data-room"] });
    return () => (ro.disconnect(), roomChanged.disconnect());
  }, [widthsKey, needs.some((a) => hiddenIds.includes(a.lane)), headSlot]);
  const [agentMenu, setAgentMenu] = useState<{ x: number; y: number } | null>(null);
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  /** The agent tab menu, and which agent it is for: the one in view, or the tab right-clicked. */
  const [kindMenu, setKindMenu] = useState<{ x: number; y: number; lane?: string } | null>(null);
  const [askRemove, removeUI] = useConfirm();
  // Which agent the composer is writing to. Filtering the feed to one follows
  // through to the box, since that is almost always what you meant.
  const [target, setTarget] = useState<string>(() => pin ?? openingTarget(state, state.lead && laneFilter === ALL ? state.lead : MAIN_LANE));
  // With an agent leading, what a person writes on the overview goes to it: handing out the work is its job.
  const leadNow = state.lead ?? null;
  useEffect(() => {
    if (!pin && leadNow && laneFilter === ALL) setTarget(openingTarget(state, leadNow));
  }, [leadNow]); // eslint-disable-line react-hooks/exhaustive-deps
  const [pinning, setPinning] = useState(false);
  // A person choosing an agent themselves outranks the box following the work (follow-target.ts), for a while.
  const pickedAt = useRef(0);
  const pick = useCallback((lane: string) => {
    pickedAt.current = Date.now();
    setTarget(lane);
  }, []);
  useEffect(() => {
    if (laneFilter !== "all") pick(laneFilter);
    // Back in a team's room, the box writes to its lead again, not to the teammate whose chat was open (teammates.ts).
    else if (state.options.team && state.lead) setTarget(state.lead);
  }, [laneFilter, pick]);
  // The box follows the work as it moves: to the agent a handoff went to, the one that asked a question, the one waiting on
  // a yes. Only from what arrives after the room opened, never while words are in the box, and it says when it moves.
  const seenFollow = useRef(events.at(-1)?.seq ?? 0);
  useEffect(() => {
    const fresh = events.filter((e) => e.seq > seenFollow.current);
    seenFollow.current = events.at(-1)?.seq ?? seenFollow.current;
    if (pin || !fresh.length) return;
    const typing = !!(document.getElementById("composer-input") as HTMLTextAreaElement | null)?.value.trim();
    const next = followTarget({ target, me: me.id, state, fresh, typing, pickedAt: pickedAt.current, now: Date.now(), mayWrite: (l) => reviewVia(state, me, l) === "instruct", name: (l) => agentNameFor(state, l) });
    if (!next) return;
    setTarget(next.lane);
    // Looking at one agent, the view goes with the box: the box writing to one agent while the feed shows another was the
    // drift people lost track in. On the overview, the feed already shows it.
    if (laneFilter !== ALL) setLaneFilter(next.lane);
    notify(next.why);
  }, [events]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // A lane that has gone away can't be written to.
    if (target !== MAIN_LANE && !state.lanes.some((l) => l.id === target)) setTarget(MAIN_LANE);
  }, [state.lanes, target]);
  // Pressing an agent's card in the Agents hub points the box at it, ready to write to.
  useEffect(() => {
    if (pin) return;
    const on = (e: Event) => {
      const lane = (e as CustomEvent<{ lane?: string }>).detail?.lane;
      if (!lane) return;
      pick(lane);
      setLaneFilter(lane);
      requestAnimationFrame(() => document.getElementById("composer-input")?.focus());
    };
    window.addEventListener("friday:focus-lane", on);
    return () => window.removeEventListener("friday:focus-lane", on);
  }, [pin]);
  const lanes = state.lanes;
  const index = useMemo(() => {
    const results = new Map<string, Ev<"tool.result">>();
    const questions = new Map<string, Ev<"agent.question">>();
    for (const e of events) {
      const b = e.body;
      if (b.type === "tool.result") results.set(b.callId, e as Ev<"tool.result">);
      else if (b.type === "agent.question") questions.set(b.callId, e as Ev<"agent.question">);
    }
    return { results, questions, delivered: deliveredIn(events) };
  }, [events]);
  /**
   * Something is happening, said before the model has said anything.
   *
   * This used to mean "text has started arriving", which left a gap between
   * sending an instruction and seeing any sign of life — the model's first
   * token can be seconds away, and the screen in the meantime was the screen
   * from before you pressed anything. A lane that is running is working, and
   * that is knowable the instant the run starts.
   */
  /**
   * Messages sent from this browser that the log hasn't echoed back yet.
   *
   * The feed is built from the session log, which is the right way round —
   * but it means your own message doesn't exist until the server says so.
   * These stand in for the gap, and each disappears the moment the real event
   * arrives, because the real one is the one that counts.
   */
  const [pending, setPending] = useState<{ id: number; text: string; lane: string; after: number }[]>([]);
  // Matched only against what arrived after it was sent: the same words sent twice took the second's "Sending…" away the
  // moment it appeared, on the first one's echo.
  const lastSeq = useRef(0);
  lastSeq.current = events.at(-1)?.seq ?? 0;
  const echo = useCallback((text: string, lane: string) => {
    const id = Date.now() + Math.random();
    setPending((p) => [...p, { id, text, lane, after: lastSeq.current }]);
    return () => setPending((p) => p.filter((x) => x.id !== id));
  }, []);
  useEffect(() => {
    if (!pending.length) return;
    // A suggestion is echoed back as one too, and the log keeps the first 8000 characters of a long message (a pasted log).
    const since = Math.min(...pending.map((x) => x.after));
    const mine = events.filter((e) => e.seq > since && (e.body.type === "instruction" || e.body.type === "suggestion") && e.actor.id === me.id);
    setPending((p) => p.filter((x) => !mine.some((e) => e.seq > x.after && (e.body as { text: string }).text.slice(0, 8000) === x.text.slice(0, 8000))));
  }, [events]); // eslint-disable-line react-hooks/exhaustive-deps

  // The lanes whose agent is working this instant: running, or with words arriving. Each gets its own live block.
  const workingLanes = [MAIN_LANE, ...state.lanes.map((l) => l.id)].filter((id) => runOf(state, id).status === "running" || !!(streams[id]?.text || streams[id]?.reasoning));
  const streamKey = workingLanes.join(",");
  // The notes nobody needs (session-notes.ts): an agent dropping off and straight back, the same connection again, the
  // wheel on Solo. Still in the log and in History; just not in the conversation.
  const quiet = useMemo(() => hiddenNotes(events, me.id, !!solo), [events, me.id, solo]);
  // The names of lanes this log has had, for any since taken away (agentNameFor).
  laneNamesFrom(events);
  learnLanes(events);
  const items = useMemo(() => foldNotes(group(quiet.size ? events.filter((e) => !quiet.has(e.seq)) : events, new Set(streamKey ? streamKey.split(",") : []))), [events, streamKey, quiet]);
  // A run block belongs to the lane that produced it.
  const laneOfItem = (it: FeedItem) => (it.kind === "event" ? it.ev.lane : it.kind === "notes" ? it.evs[0]?.lane : it.lane) ?? MAIN_LANE;
  const logOrder = items.filter(
    (it) =>
      // A permission card goes once it is answered: the run's review card keeps what was asked and what was said.
      !(it.kind === "event" && it.ev.body.type === "engine.approval" && state.approvals[it.ev.lane ?? MAIN_LANE]?.id !== it.ev.body.id) &&
      (filter === "all" ? true : filter === "agent" ? it.kind === "run" || (it.kind === "event" && it.ev.body.type === "run.ended") : it.kind !== "run" && !(it.kind === "event" && it.ev.body.type === "run.ended")) &&
      // An aside is to the people in the room, not to one agent: it shows whichever agent's feed you are looking at.
      (laneFilter === "all" || laneOfItem(it) === laneFilter || (it.kind === "event" && it.ev.body.type === "chat")),
  );
  // The newest block of each agent: that is the one that is live, and the one that offers review.
  // The point of the session, for the pinned line; and where the new part starts, fixed at the read mark this person opened with.
  const seenAtOpen = useRef<number | null>(null);
  // Only what was already there when the room opened is "new since you looked": what arrives while you watch, you saw arrive.
  const lastAtOpen = useRef(0);
  if (seenAtOpen.current === null && seenSeq !== undefined) (seenAtOpen.current = seenSeq), (lastAtOpen.current = events.at(-1)?.seq ?? 0);
  // Only what is news counts: something an agent said or another person wrote. Friday's notes and settings changes made as you
  // (a new teammate's effort set as it was made) put "New since you looked" over a chat with nothing new in it (2026-10-27 audit).
  const news = (e: SessionEvent) => e.actor.id !== me.id && ((e.body.type === "agent.message" && !!e.body.text.trim()) || ((e.body.type === "instruction" || e.body.type === "suggestion" || e.body.type === "chat") && e.actor.kind === "human"));
  const firstUnseen = seenAtOpen.current ? events.find((e) => e.seq > seenAtOpen.current! && e.seq <= lastAtOpen.current && news(e))?.seq : undefined;
  const seqOfItem = (it: FeedItem) => (it.kind === "run" ? it.key : it.kind === "notes" ? it.evs[0]!.seq : it.ev.seq);
  // A turn that was stopped sits where it was stopped, above the Stop's note, though what it had written was logged just after it.
  const lastOfItem = (it: FeedItem) =>
    it.kind === "run" && it.placeBefore !== undefined
      ? it.placeBefore - 0.5
      : it.kind === "run" && !it.ended && (it.closedBy === "run.pause" || it.closedBy === "run.cancel") && it.closedSeq !== undefined
        ? it.closedSeq - 0.5
        : it.kind === "run" ? Math.max(it.key, ...it.messages.map((m) => m.seq), ...it.diffs.map((d) => d.seq), it.ended?.seq ?? 0) : it.kind === "notes" ? it.evs.at(-1)!.seq : it.ev.seq;
  /** Each agent's latest run, which is drawn at work until it ends or is stopped (a stop that no run end followed kept a
   * "Working · 27m" spinner over the stop's own line; 2026-10-28 QA). */
  const lastRunKeys = new Map<string, number>();
  /** The last two runs of each agent, which stay open; a finished run older than that folds to one line. */
  const recentRunKeys = new Map<string, number[]>();
  for (const it of items) if (it.kind === "run") recentRunKeys.set(it.lane, [...(recentRunKeys.get(it.lane) ?? []), it.key].slice(-2));
  for (const i of items) if (i.kind === "run") lastRunKeys.set(i.lane, i.key);
  // All agents at once: each turn where it finished, so the agent that just finished settles above the ones still working and
  // the one at work stays at the bottom, in view (agent-order.ts). Held as it was while someone reads further up, and put in
  // order once they are back at the bottom, so nothing moves under the words being read.
  const ordering = laneFilter === "all" && !pin && state.lanes.length > 0;
  /** Whether a message to an agent goes with the run that takes it up, rather than keeping its own place in the log. */
  let goesWithRun = (_e: SessionEvent) => true;
  // In a team, what the agents send each other keeps its place: it folds into a line of their talk, and gone with a teammate's
  // run still under way (which the room doesn't show) it sat under newer messages until that ended (2026-10-27 audit).
  if (state.options.team) goesWithRun = (e) => !isAgentTalk(e);
  const finishing = ordering
    ? finishingOrder(
        logOrder,
        (it): OrderInfo =>
          it.kind === "run"
            ? { kind: "run", lane: it.lane, ...(it.ended ? { ended: it.ended.seq } : {}), live: it.key === lastRunKeys.get(it.lane) && workingLanes.includes(it.lane) }
            : it.kind === "event" && (it.ev.body.type === "instruction" || it.ev.body.type === "suggestion") && goesWithRun(it.ev)
              ? { kind: "ask", lane: it.ev.lane ?? MAIN_LANE, seq: it.ev.seq }
              : it.kind === "event" && it.ev.body.type === "engine.approval"
                ? { kind: "after", lane: it.ev.lane ?? MAIN_LANE, seq: it.ev.seq }
                : { kind: "other", seq: seqOfItem(it) },
        lastOfItem,
        new Set(workingLanes),
      )
    : logOrder;
  const shownOrder = useRef<string[]>([]);
  // The lead's turns the Team room has shown as its answers, which stay shown (team-room.ts leadAnswers).
  const leadShown = useRef(new Set<string>());
  // How each teammate stands in this chat, for its faces and working line, rather than across every room (Teammates.tsx statusIn).
  // Keyed on how each lane stands, not on laneRuns itself: the live state is changed in place, so a stop never reached the team's
  // view and the room said "Kit is working" after Stop all (Arun, 2026-10-28: "really iron out bugs and feature problems and gaps").
  const laneRunsKey = state.options.team ? Object.entries(state.laneRuns).map(([l, r]) => `${l}:${r.status}`).join(",") : "";
  useEffect(() => void (state.options.team && noteLaneRuns(sid, state.laneRuns)), [sid, laneRunsKey, state.options.team]);
  useEffect(() => () => forgetLaneRuns(sid), [sid]);
  const feedOrder = following || !ordering ? finishing.map(feedKey) : heldOrder(shownOrder.current, finishing.map(feedKey));
  shownOrder.current = feedOrder;
  const byKey = new Map(finishing.map((it) => [feedKey(it), it] as const));
  let visible = feedOrder.map((k) => byKey.get(k)!);
  // Who is speaking over an agent's items: in a team its mascot and name already head every message.
  let tags = true;
  if (state.options.team) tags = false;
  let emptyTitle = filter === "all" ? (replaying ? "Nothing in this recording" : "Nothing here yet") : "Nothing to show";
  let emptyText = filter === "all" ? (replaying ? "Nobody wrote to the agent before this was shared." : "Messages to the agent, its steps and handoffs appear here.") : "Try the All tab.";
  // A team's room or a teammate's chat, before anything is said in it (Teammates.tsx teamEmpty).
  if (state.options.team) [emptyTitle, emptyText] = teamEmpty(state.lanes.length, laneFilter === ALL ? null : laneFilter);
  // The queues docked over the box: every agent's, or in a team only the teammate's whose chat is open (the room shows none:
  // one teammate's waiting messages over every chat was the loudest thing on screen).
  let queuesShown = [MAIN_LANE, ...state.lanes.map((l) => l.id)];
  /** Whether the board's tasks show over the box here. */
  let boardHere = true;
  // In a teammate's own chat only while one of the board's tasks is its own (2026-10-27 audit: the Team tasks pill showed in
  // every teammate's chat).
  if (state.options.team && laneFilter !== ALL) boardHere = (state.board?.tasks ?? []).some((t) => t.lane === laneFilter && t.status !== "done" && t.status !== "cancelled");
  if (state.options.team) queuesShown = laneFilter === ALL ? [] : [laneFilter];
  // The Team room and a room show each teammate's run as one message, what it is on or what it said last; the work itself is
  // in its own chat (Arun, 2026-10-27: "the actual stuff runs in the individual agent chats").
  // Cast, not annotated: where nothing sets it (the public edition) an annotated null narrows to never.
  let teamRun = null as ((it: RunItem) => ReactNode) | null;
  let teamGroup = null as ((it: FeedItem) => ReactNode) | null;
  // A finished turn's last words take a side thread (team-threads.ts), shown beside the room.
  // Under a turn still going too, on its latest words, or on the one of its messages a thread already hangs off (Arun, 2026-10-28:
  // "really iron out bugs and feature problems and gaps"; a teammate at work had no "Reply in thread").
  const threadOn = (it: RunItem) => { const said = it.messages.filter((m) => m.body.text.trim()); const root = (said.findLast((m) => threadsOf(events).byRoot.has(m.seq)) ?? said.at(-1))?.seq; return root ? <ThreadChip sid={sid} root={root} lane={it.lane} events={events} /> : undefined; };
  // Its turn under way is the newest block of a lane whose agent is running; one waiting on the person "needs you", and a block cut
  // short in a turn long since ended is neither (2026-10-27 audit). A usage limit its teammate switched tools on is the switch's line.
  if (state.options.team && laneFilter === ALL) teamRun = (it) => <TeamRun thread={threadOn(it)} sid={sid} lane={it.lane} active={isLive(it, { lastKey: lastRunKeys.get(it.lane), status: runOf(state, it.lane).status })} doing={statusOf(it.lane)?.line ?? ""} said={it.messages.findLast((m) => m.body.text.trim())?.body.text ?? ""} outcome={it.ended?.body.outcome === "error" && limitHit(it.ended.body.error) ? (switchedAfter(events, it.lane, it.ended.seq) ? "switched" : "limited") : (it.ended?.body.outcome ?? (isWaiting(it, { lastKey: lastRunKeys.get(it.lane), status: runOf(state, it.lane).status }) ? "waiting" : null))} changed={new Set(it.diffs.flatMap((d) => d.body.files.map((f) => f.path))).size} stamp={it.messages[0] ? <Stamp ev={it.messages[0]} /> : null} />;
  // The team reads as a group chat: tools connecting and lanes being made are left out (Teammates.tsx plumbing).
  if (state.options.team) visible = visible.filter((it) => !(it.kind === "notes" ? it.evs.every((e) => plumbing(e.body.type)) : it.kind === "event" && plumbing(it.ev.body.type)));
  // Check-ins with nothing new leave nothing in the chat: neither the ask nor the answer (Teammates.tsx quietCheckIns).
  if (state.options.team) visible = ((q) => visible.filter((it) => !q.has(it.kind === "run" ? it.key : it.kind === "event" ? it.ev.seq : -1)))(quietCheckIns(events));
  // One message to several teammates shown once, in the room (Teammates.tsx mergeSends).
  if (state.options.team && laneFilter === ALL) visible = mergeSends(sid, visible, (it) => (it.kind === "event" ? it.ev : null));
  // A side thread's replies and answers live in the thread, not the room's main flow (team-threads.ts).
  if (state.options.team && laneFilter === ALL) visible = ((h) => visible.filter((it) => (it.kind === "run" ? !(it.messages.length > 0 && it.messages.every((m) => h.has(m.seq))) : it.kind === "event" ? !h.has(it.ev.seq) : true)))(threadsOf(events).hidden);
  // The room shows results, the person's words and what needs them; the agents' talk folds to a line (Teammates.tsx foldTeamTalk).
  // In the room a turn shows when it answers the person or is the lead's answer; a teammate's turn on work the lead gave it folds
  // with the talk, its result going back to the lead (OpenBot: "a summary comes back to the lead, the full answer stays in its
  // chat"). A turn under way is the working line over the box (team-room.ts roomRunKind).
  if (state.options.team) {
    const room = laneFilter === ALL;
    // Whom each teammate's turn answers, from everything it was handed (team-room.ts turnsFor): a turn on the lead's work that is
    // handed the person's message answers them too.
    const turns = turnsFor(events);
    const now = (lane: string) => ({ lastKey: lastRunKeys.get(lane), status: runOf(state, lane).status });
    const switched = (it: RunItem) => !!it.ended && it.ended.body.outcome === "error" && !!limitHit(it.ended.body.error) && switchedAfter(events, it.lane, it.ended.seq);
    // The lead's answers (team-room.ts leadAnswers): its last turn before the person next speaks, and each turn that ends a stretch
    // of its work with something to say. Read over what the room shows: the hidden and the turn under way don't count.
    const answers = leadAnswers(visible, (it): LeadInfo => {
      if (it.kind === "event") return isPersonsWord(it.ev) ? { kind: "person" } : teamEventKind(it.ev, room) === "hide" ? { kind: "skip" } : { kind: "other" };
      if (it.kind !== "run") return { kind: "skip" };
      if (it.lane === state.lead && it.ended) return { kind: "lead", key: it.key, text: it.messages.findLast((m) => m.body.text.trim())?.body.text ?? "" };
      return roomRunKind(it, { room, now: now(it.lane), turns, lead: state.lead, leadAnswers: new Set(), switched: switched(it) }) === "hide" ? { kind: "skip" } : { kind: "other" };
    });
    // One shown as the lead's answer stays shown while the room is open, whatever comes after it.
    for (const k of answers) leadShown.current.add(`${sid}:${k}`);
    for (const k of leadShown.current) if (k.startsWith(`${sid}:`)) answers.add(Number(k.slice(sid.length + 1)));
    const runKind = (it: RunItem) => roomRunKind(it, { room, now: now(it.lane), turns, lead: state.lead, leadAnswers: answers, switched: switched(it) });
    const keyOf = (it: FeedItem) => (it.kind === "run" ? it.key : it.kind === "event" ? it.ev.seq : it.evs[0]!.seq);
    const folded = foldTeamTalk(visible, (it) => (it.kind === "run" ? runKind(it) : it.kind === "event" ? teamEventKind(it.ev, room) : "show"), keyOf);
    visible = folded.items;
    // The task board under way stays in view at the room's foot, the work coming in above it, as a session keeps its running
    // turn last (Arun, 2026-10-27: "have the task board be like the thing that is in view and the other messages go above it").
    // Once its tasks are all done it goes back to where it was posted.
    if (room && (state.board?.tasks ?? []).some((t) => t.status !== "done" && t.status !== "cancelled")) {
      const at = visible.findLastIndex((it) => it.kind === "event" && it.ev.body.type === "board.posted");
      if (at >= 0 && at < visible.length - 1) visible = [...visible.slice(0, at), ...visible.slice(at + 1), visible[at]!];
    }
    const pieceOfItem = (it: FeedItem): TalkPiece => (it.kind === "run" ? { who: [{ lane: it.lane, name: agentNameFor(state, it.lane) }], text: it.messages.findLast((m) => m.body.text.trim())?.body.text ?? "", turn: true } : it.kind === "event" ? pieceOf(it.ev) : { who: [], text: "" });
    teamGroup = (it) => {
      const g = folded.groups.get(keyOf(it));
      if (!g) return null;
      return (
        <TalkGroup pieces={g.map(pieceOfItem)}>
          {g.map((x) => (
            <div key={keyOf(x)}>{x.kind === "run" ? (teamRun?.(x) ?? <RunBlock item={x} ctx={ctx} folded active={false} latest={false} typing={null} />) : x.kind === "event" ? <EventItem ev={x.ev} ctx={ctx} /> : null}</div>
          ))}
        </TalkGroup>
      );
    };
  }
  // A message to an agent with that agent's reply right under it: the reply names the agent, so a tag over the message too
  // said it twice.
  const answeredBelow = (i: number) => {
    const it = visible[i]!;
    const next = visible[i + 1];
    return it.kind === "event" && (it.ev.body.type === "instruction" || it.ev.body.type === "suggestion") && next?.kind === "run" && next.lane === laneOfItem(it);
  };
  // One agent's catch-up takes the place of the session's line: two "new since" lines in one feed would disagree.
  const agentUnreadAt = catchUp.current && catchUp.current.lane === laneFilter ? catchUpIndex(visible.map((it) => ({ lane: laneOfItem(it), last: lastOfItem(it) })), catchUp.current.lane, catchUp.current.seq) : -1;
  let breaks: (string | null)[] = [];
  // A long team chat's days, each with a divider (team-status.ts dayBreaks; Arun, 2026-10-28).
  if (state.options.team) breaks = ((at) => dayBreaks(visible.map((it) => at.get(seqOfItem(it)))))(new Map(events.map((e) => [e.seq, e.ts] as const)));
  const unreadAt = agentUnreadAt !== -1 ? agentUnreadAt : firstUnseen === undefined ? -1 : visible.findIndex((it) => seqOfItem(it) >= firstUnseen);
  const lastCommitSeq = events.findLast((e) => e.body.type === "folder.committed" && !e.body.error)?.seq ?? 0;
  const lastApplySeq = events.findLast((e) => e.body.type === "folder.applied")?.seq ?? 0;
  // While the driver has the session open, reviewers' comments on its pull
  // request reach the agent on their own, a few minutes at most after they are
  // written. Quiet when there is nothing new; it stops at the first real error
  // (no gh on the machine, no network) rather than asking every minute.
  // The agent started the site for the person: open the Preview panel on it,
  // and tell the panel to look rather than wait for its next poll. Only for
  // what just happened, so loading an old session doesn't throw panels open.
  const shown = useRef(0);
  // Whether an address on the machine doing the work has a page to show, asked of its runner (preview.fetch): the Preview opens
  // by itself only on a page, never on a server with nothing to look at (Arun, 2026-10-20).
  const lookAt = (port: number, path: string) => hostApi<{ status: number; type: string }>(identity, "/api/runner/preview.fetch", { method: "POST", body: JSON.stringify({ port, path }) }).then(lookOf);
  const openIfPage = (url: string, tab?: "auto" | "new") =>
    void pageAppears(url, lookAt).then((page) => {
      if (!page) return;
      onOpen?.("preview");
      openInPreview(url, sid, tab);
    });
  useEffect(() => {
    // On the call, not the result: installing dependencies can take minutes,
    // and the panel shows that as it happens.
    if (secondary) return;
    const ev = events.findLast((e) => e.body.type === "agent.message" && e.body.toolCalls.some((c) => c.name === "show_preview"));
    if (!ev || ev.seq <= shown.current) return;
    shown.current = ev.seq;
    if (Date.now() - ev.ts > 60_000) return;
    // An address it started itself, once it serves a page; or the iOS app: shown as asked. The iOS build runs on the folder's machine.
    const call = ev.body.type === "agent.message" ? ev.body.toolCalls.findLast((c) => c.name === "show_preview") : undefined;
    let args: { url?: unknown; ios?: unknown } = {};
    try {
      args = JSON.parse(call?.arguments || "{}") as typeof args;
    } catch {
      /* no arguments: the project's own dev server */
    }
    if (typeof args.url === "string" && /^https?:\/\//i.test(args.url)) return openIfPage(args.url);
    onOpen?.("preview");
    if (args.ios === true) return askIosPreview(sid, false);
    // Once the server has registered it, and again when it should be up.
    for (const ms of [1500, 6000, 20000]) setTimeout(() => dispatchEvent(new Event("friday:preview-started")), ms);
  }, [events]); // eslint-disable-line react-hooks/exhaustive-deps
  // A coding tool's own show_preview (the friday MCP tool, agent-mesh.ts): the page it asked for, opened in its tab, once,
  // when it was just asked. The iOS app likewise.
  const asked = useRef(0);
  useEffect(() => {
    if (secondary) return;
    const fresh = events.filter((e) => e.seq > asked.current && e.body.type === "preview.asked");
    if (!fresh.length) return;
    asked.current = fresh.at(-1)!.seq;
    for (const e of fresh) {
      if (e.body.type !== "preview.asked" || Date.now() - e.ts > 60_000) continue;
      if (e.body.ios) {
        onOpen?.("preview");
        askIosPreview(sid, true);
      } else if (e.body.url) openIfPage(e.body.url, e.body.newTab ? "new" : "auto");
    }
  }, [events]); // eslint-disable-line react-hooks/exhaustive-deps
  // A coding tool that doesn't use show_preview runs the dev server itself and tells the people where ("it's up at
  // http://localhost:3000"). That address, in its answer, opens the Preview panel on it, once, when it was just said, and only
  // once a page answers there. Not from a command's output: a tool starting a server to test its own work (an API, a server it
  // curls and stops) is not something to show, and opened the panel on nothing (Arun, 2026-10-20).
  const said = useRef(0);
  const shownUrl = useRef("");
  useEffect(() => {
    if (secondary) return;
    const fresh = events.filter((e) => e.seq > said.current && e.body.type === "agent.message" && !!state.engines[e.lane ?? MAIN_LANE]?.tool);
    if (!fresh.length) return;
    said.current = fresh[fresh.length - 1]!.seq;
    const recent = fresh.filter((e) => Date.now() - e.ts < 60_000);
    // A site a server says it is serving, not any local address: an API, a database or a model server mentioned in code is not
    // something to look at (servedUrlIn).
    // "Preview: ios" (the line Friday asks every coding tool to print, engine/hub.ts SYSTEM_NOTE): the iOS app, built and run
    // in a simulator on this Mac, in the Preview panel's iOS side.
    const ios = recent.some((e) => e.body.type === "agent.message" && /^\s*preview:\s*ios\s*$/im.test(e.body.text));
    if (ios) {
      onOpen?.("preview");
      askIosPreview(sid, true);
    }
    const url = recent.map((e) => servedUrlIn(e.body.type === "agent.message" ? e.body.text : "")).filter(Boolean).at(-1);
    if (!url || url === shownUrl.current) return;
    shownUrl.current = url;
    openIfPage(url);
  }, [events]); // eslint-disable-line react-hooks/exhaustive-deps
  const watchedPr = lastCommitSeq ? (events.find((e) => e.seq === lastCommitSeq)?.body as { prUrl?: string; prCreated?: boolean } | undefined) : undefined;
  const watching = !secondary && !!watchedPr?.prUrl && !!watchedPr.prCreated && state.driver?.id === me.id && state.run.status !== "running";
  useEffect(() => {
    if (!watching) return;
    let live = true;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      const r = await send({ type: "pr.feedback" });
      if (live && !r.ok && !/No new comments/.test(r.error ?? "")) clearInterval(timer);
    };
    const timer = setInterval(() => void tick(), 120_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [watching, lastCommitSeq]); // eslint-disable-line react-hooks/exhaustive-deps
  const lastRestoreSeq = events.findLast((e) => e.body.type === "folder.restored")?.seq ?? 0;
  const rewinds = useMemo(() => rewindsIn(events), [events]);
  const checkpoints = useMemo(() => checkpointsByMessage(events), [events]);
  // The same object until something it holds changes. Made fresh on every draw, it was new on every frame of streamed
  // text, so every run block and notice in the feed redrew (and re-read every tool call) sixty times a second.
  // `state` is changed in place by each event, which changes `events` too, so `events` stands for both.
  const ctx: Ctx = useMemo(
    () => ({ me, plan, ...(solo ? { solo } : {}), ...(soloSure ? { soloSure } : {}), connections, state, ...index, send, sid, invite, notify, identity, echo, lastCommitSeq, lastApplySeq, lastRestoreSeq, rewinds, checkpoints, events, ...(onOpen ? { onOpen } : {}), ...(onConnect ? { onConnect } : {}), ...(agents ? { agents } : {}), ...(presence ? { presence } : {}), ...(replayLink ? { replayLink } : {}), ...(replaying ? { replaying } : {}) }),
    [me, plan, solo, soloSure, connections, state, index, send, sid, invite, notify, identity, echo, lastCommitSeq, lastApplySeq, lastRestoreSeq, rewinds, checkpoints, events, onOpen, onConnect, agents, presence, replayLink, replaying],
  );
  // "Reconnect" from an agent's card in the Agents hub: the same start this view's own Reconnect makes.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  useEffect(() => {
    if (pin) return;
    const on = (e: Event) => {
      const lane = (e as CustomEvent<{ lane?: string }>).detail?.lane;
      if (lane) void reconnectLane(ctxRef.current, lane);
    };
    window.addEventListener("friday:reconnect-lane", on);
    return () => window.removeEventListener("friday:reconnect-lane", on);
  }, [pin]);
  // Asked from outside the box (the Work rail's "Carry on"): sent the way the box sends it, my agent started first if it isn't
  // running here, then switched to what the message calls for. Sent bare, it sat "Queued" behind an agent nobody started while
  // everything said Ready (QA, 2026-10-28; Arun: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
  useEffect(() => {
    if (pin) return;
    const on = (e: Event) => {
      const d = (e as CustomEvent<AskLane>).detail;
      if (!d?.text) return;
      d.handled = true;
      void askLane(ctxRef.current, d.lane, d.text).then(d.reply);
    };
    window.addEventListener("friday:ask-lane", on);
    return () => window.removeEventListener("friday:ask-lane", on);
  }, [pin]);

  // Opening a session brings its coding tools back: an agent of mine that is offline is started again on its folder, if that
  // folder is on this computer, without waiting for a message to be sent first. Once per offline spell (its sinceSeq), quietly:
  // a tool that can't start here is left to its Reconnect button, with no error for something nobody pressed.
  const offlineMine = [MAIN_LANE, ...state.lanes.map((l) => l.id)]
    .filter((id) => {
      const e = state.engines[id];
      return !!e?.tool && !e.online && e.hostId === me.id && !!e.cwd && !replaying;
    })
    .map((id) => `${id}:${state.engines[id]!.sinceSeq}`)
    .join(",");
  useEffect(() => {
    if (pin || !offlineMine) return;
    for (const entry of offlineMine.split(",")) {
      const lane = entry.slice(0, entry.lastIndexOf(":"));
      const key = `${sid}|${entry}`;
      if (autoReconnected.has(key)) continue;
      autoReconnected.add(key);
      const c = ctxRef.current;
      const cwd = c.state.engines[lane]?.cwd;
      if (!cwd) continue;
      void hostApi(c.identity, `/api/runner/describe?path=${encodeURIComponent(cwd)}`).then(
        () => reconnectLane(ctxRef.current, lane, true),
        () => {},
      );
    }
  }, [offlineMine, pin, sid]);

  // A mode switched to automatically was for my own run: once that run is over, my agent goes back to the one I picked by hand.
  const revert = [MAIN_LANE, ...state.lanes.map((l) => l.id)]
    .filter((id) => state.engines[id]?.hostId === me.id && !replaying && revertTo(state, id))
    .join(",");
  useEffect(() => {
    if (!revert) return;
    // A column of a split chat goes back for its own agent: a lane switched in split view never went back before.
    for (const lane of revert.split(",").filter((l) => !pin || l === pin)) {
      const c = ctxRef.current;
      const hand = revertTo(c.state, lane);
      if (hand) void smartSwitch(c, lane, { mode: hand, why: "the run it was switched for is over" });
    }
  }, [revert, pin]);

  // Where an older change set's patches are fetched from, as its card is opened (patchSource.ts). The same value while the
  // session is: a new one on every render had React look through the whole feed for its readers on every live event.
  const patchSource = useMemo(() => ({ sid: ctx.sid, invite: ctx.invite }), [ctx.sid, ctx.invite]);
  // One agent as a terminal (Arun, 2026-10-30: "LIKE HERDR DOES IT… A TOGGLE… SWTICHING FROM GUI TO TUI", "a custom TUI for like
  // all of the coding tools"): Friday's own TUI for any agent in view (Tui.tsx), and from there, for Claude Code and Codex on
  // this person's computer, the tool's own screen on the same conversation (Terminal.tsx LaneTui), its turns held meanwhile.
  // Code sessions only: a Crew room or a Work session reads as it is.
  const tuiHere = !replaying && !state.options.team && !state.options.work;
  const tuiLane = laneFilter !== ALL && tuiHere ? laneFilter : null;
  const tuiTool = tuiLane ? state.engines[tuiLane]?.tool : undefined;
  const nativeCan = !!tuiLane && !!tuiTool && state.engines[tuiLane]?.hostId === me.id && TERMINAL_TOOLS.has(tuiTool) && hasShells();
  const [tuiView, setTuiView] = useTuiView();
  // Sent back to Friday's view (← friday) while its tool finishes in its screen: Friday's view at once, the screen handed back after.
  // Back to chat while its tool works there: chat at once, the screen handed back once the tool is done.
  const nativeOn = nativeCan && !!state.terminals?.[tuiLane!] && !friday(sid, tuiLane!) && (tuiView || !handingBack(sid, tuiLane!));
  const [, redraw] = useState(0);
  const toFriday = (l: string) => (preferFriday(sid, l, true), handBackWhenDone(sid, invite, l), redraw((n) => n + 1));
  // All agents too: every agent's own screen side by side (Arun, 2026-10-30: "also do it for the all agents tab too").
  const ftuiAll = tuiView && laneFilter === ALL && tuiHere && everyone.length > 0;
  // A coding tool's own screen is the terminal view, always; Friday's TUI only for an agent sent to it (← friday), a tool with no
  // screen to resume in, and All agents (Arun, 2026-10-30: "always load on native coding tool terminal the friday TUI will be
  // only visible if selected"). While its screen opens, or if it can't, the view says so rather than showing Friday's.
  const wantsNative = !!tuiLane && tuiView && nativeCan && !friday(sid, tuiLane);
  // Why its screen didn't open, as of which attach of its runner: once it attaches again (a restart, a reconnect), it is tried
  // again by itself rather than waiting on Try again.
  const [nativeErrs, setNativeErr] = useState<Record<string, { msg: string; seq: number }>>({});
  const nativeErr: Record<string, string> = {};
  for (const [l, e] of Object.entries(nativeErrs)) if (e.seq === (state.engines[l]?.sinceSeq ?? -1)) nativeErr[l] = e.msg;
  const laneOnline = !!tuiLane && !!state.engines[tuiLane]?.online;
  // At work, or with work about to start: switching views never stops it (Arun, 2026-10-30: "dont make the thing stop when
  // witching from GUI to TUI or TUI to GUI"). Its turn goes on in Friday's view, and its own screen opens once it is done.
  const atWork = (l: string) => {
    const st = runOf(state, l).status;
    return st === "running" || st === "waiting_for_human" || (st !== "paused" && runnableQueue(events, l, pendingFor(state, l)).length > 0);
  };
  const tuiBusy = !!tuiLane && !nativeOn && atWork(tuiLane);
  const nativeWaiting = wantsNative && !nativeOn && !tuiBusy;
  const ftuiOn = (!!tuiLane && tuiView && !nativeOn && (!wantsNative || tuiBusy)) || ftuiAll;
  const tuiOn = nativeOn || ftuiOn || nativeWaiting;
  const toNative = async () => {
    preferFriday(sid, tuiLane!, false);
    const r = await openLaneTerminal(sid, invite, tuiLane!);
    if ("error" in r && !r.busy) ctx.notify(r.error);
  };
  // Something for an agent open in its own screen (another agent's message, a nudge): the screen goes back to Friday as soon as
  // its tool is waiting and its person isn't typing, the turn runs, and the screen opens again after it. The terminal view never
  // holds the team's work up.
  const takeBack = !secondary && hasShells() ? Object.keys(state.terminals ?? {}).filter((l) => state.engines[l]?.hostId === me.id && runOf(state, l).status !== "paused" && runnableQueue(events, l, pendingFor(state, l)).length > 0) : [];
  const takeBackKey = takeBack.join(",");
  useEffect(() => {
    for (const l of takeBackKey ? takeBackKey.split(",") : []) handBackWhenDone(sid, invite, l, { typedFor: 15_000 });
  }, [takeBackKey, sid]); // eslint-disable-line react-hooks/exhaustive-deps
  // The terminal view is the tool's own wherever it can be (Arun, 2026-10-30: "make sure the terminal view is using native
  // view"): Claude Code or Codex on this computer opens on its conversation, its turns held, as the view comes to it. Friday's
  // TUI is for the rest, for one that couldn't open (said once), and for an agent its person sent back to it ("← friday").
  // Every other agent here that opens in its own screen, started ahead in the background, so its tab is instant (warmLaneTerminal):
  // only the main chat does it, one at a time, and never one sent back to Friday's view.
  // An agent at work is left to it, and started ahead once it is done.
  const warmable = !secondary && tuiView && tuiHere && hasShells() ? everyone.filter((l) => l !== tuiLane && state.engines[l]?.hostId === me.id && state.engines[l]?.online && TERMINAL_TOOLS.has(state.engines[l]?.tool ?? "") && !state.terminals?.[l] && !friday(sid, l) && !atWork(l)) : [];
  const warmKey = warmable.join(",");
  const [rewarm, setRewarm] = useState(0);
  useEffect(() => {
    if (!warmKey) return;
    let gone = false;
    void (async () => {
      for (const lane of warmKey.split(",")) {
        if (gone) return;
        const r = await warmLaneTerminal(sid, invite, lane);
        // Still finishing (its runner letting the turn go): asked again in a moment.
        if (r?.busy) setTimeout(() => !gone && setRewarm((n) => n + 1), 2_000);
        else if (r) (preferFriday(sid, lane, "briefly"), redraw((n) => n + 1));
      }
    })();
    return () => void (gone = true);
  }, [warmKey, sid, rewarm]); // eslint-disable-line react-hooks/exhaustive-deps
  const autoNative = nativeWaiting && laneOnline && !nativeErr[tuiLane!];
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!autoNative) return;
    const lane = tuiLane!;
    let gone = false;
    // Its shell started with the request, not after the view has heard back: the tool is already starting as its screen draws.
    const seq = state.engines[lane]?.sinceSeq ?? -1;
    void warmLaneTerminal(sid, invite, lane).then((r) => {
      if (gone || !r) return;
      if (r.busy) setTimeout(() => !gone && setRetry((n) => n + 1), 2_000);
      else setNativeErr((e) => ({ ...e, [lane]: { msg: r.error, seq } }));
    });
    return () => void (gone = true);
  }, [autoNative, sid, tuiLane, retry]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <PatchSource.Provider value={patchSource}>
    <section
      className={`activity-main${pin ? " is-column" : ""}${tuiOn ? " is-tui" : ""}`}
      aria-label={pin ? `${laneLabel(state, pin)} chat` : "Activity"}
      {...(pin && onFocusLane ? { onPointerDownCapture: () => onFocusLane(pin), onFocusCapture: () => onFocusLane(pin) } : {})}
      // "It's up at http://localhost:5174/" opens in the Preview browser beside
      // the conversation, not in a window of its own. Anything else is left alone.
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest?.("a[href]");
        const href = a?.getAttribute("href") ?? "";
        if (!a || !isLocalUrl(href) || !onOpen) return;
        e.preventDefault();
        openInPreview(href, sid);
        onOpen("preview");
      }}
    >
      {removeUI}
      {pin && (
        <div className="col-head">
          {onPickLane ? (
            <MenuButton
              className="col-pick"
              label="Which agent this column shows"
              text={laneLabel(state, pin)}
              mark={agentLook(state, pin, 15).mark}
              width={260}
              items={() => [
                { heading: "Show in this column" },
                ...everyone.map((id) => ({
                  label: laneLabel(state, id),
                  mark: agentLook(state, id, 14).mark,
                  checked: id === pin,
                  hint: otherLanes?.includes(id) ? "other column" : undefined,
                  live: runOf(state, id).status === "running",
                  onSelect: () => onPickLane(id),
                })),
              ]}
            />
          ) : (
            <>
              <span className="col-mark">{agentLook(state, pin, 15).mark}</span>
              <span className="col-name">{laneLabel(state, pin)}</span>
            </>
          )}
          {state.engines[pin]?.branch && <span className="col-branch">{state.engines[pin]!.branch}</span>}
          {runOf(state, pin).status === "running" && <span className="lane-tab-live" title="Working" />}
          {onCloseColumn && (
            <button type="button" className="icon-btn tiny col-x" aria-label="Close this column" title="Close this column" onClick={onCloseColumn}>
              <Icon name="x" size={14} />
            </button>
          )}
        </div>
      )}
      {/* One agent on Solo has nothing to switch between and no one else's messages to filter out: no bar for it. Except in the
          local edition, where the bar's + is how a second agent joins, and a team of agents is the point. */}
      {!pin && bar && (filter !== "all" || lanes.length > 0 || startingNow.length > 0 || needs.length > 0 || (!solo && events.length > 15) || (isLocal() && Object.keys(state.engines).length > 0)) && inHead(
      <div className={`feed-toolbar${headSlot ? " in-head" : ""}`}>
        {(
          <div className="lane-tabs-wrap">
          <div className={`lane-tabs${tabsOver ? " over" : ""}`} ref={tabsEl} role="tablist" aria-label="Filter by agent" onKeyDown={tabListKeys}>
            {[...([["all", allLabel], ...shownIds.map((id) => [id, laneLabel(state, id)])] as [string, string][]).map(([id, name]) => {
              const look = id === "all" ? null : agentLook(state, id, 13);
              const st = id === "all" ? undefined : statusOf(id);
              const behind = id === "all" || laneFilter === id ? 0 : (unread[id] ?? 0);
              const key = everyone.indexOf(id) + 1;
              // In the header a tab shows only its name, so its tip leads with the name and then where it stands.
              let tokens = st?.tokens ? ` · ${shortTokens(st.tokens)} tokens used` : "";
              if (state.options.work) tokens = ""; // no token counts in Work, the tab's tip included (Arun, 2026-10-28: "iron everything and ensure we are good")
              const said = `${headSlot && id !== "all" ? `${ownerOf(id).name}${st?.line ? ` · ${st.line}` : ""}` : (st?.line ?? name)}${tokens}`;
              const tip = id === "all" ? `Every agent's work · ${agentKey(0)}` : `${said}${key && key < 10 ? ` · ${agentKey(key)}` : ""}`;
              const coming = id === "all" ? undefined : startingOn(startingNow, state, id);
              const who = id === "all" ? null : ownerOf(id);
              // Keyed by its tool while it starts, so the tab drawn before its lane existed is the same one, and its mark eases in once.
              if (coming) return <StartingLaneTab key={`starting-${coming.tool}`} tool={coming.tool} name={name} on={laneFilter === id} onClick={() => pickLane(id)} />;
              return (
                <button key={id} type="button" role="tab" aria-selected={laneFilter === id} ref={laneFilter === id ? tabIntoView : undefined} className={`lane-tab${laneFilter === id ? " on" : ""}${st?.needsYou ? " needs" : ""}`} data-state={id === "all" ? undefined : tabState(st?.status, st?.needsYou)} data-owned={who?.owner ? "" : undefined} data-tip={id === "all" || maxColumns(innerWidth) < 2 ? tip : `${tip} · drag onto the chat to open beside`} draggable={id !== "all"} onDragStart={id === "all" ? undefined : (e) => {
                    // Dragged onto the chat, it opens in a column beside the agent in view (SessionView).
                    e.dataTransfer.setData(AGENT_DRAG, id);
                    e.dataTransfer.effectAllowed = "copy";
                    dispatchEvent(new CustomEvent("friday:agent-drag", { detail: { lane: id } }));
                  }} onDragEnd={id === "all" ? undefined : () => dispatchEvent(new CustomEvent("friday:agent-drag", { detail: { lane: null } }))} aria-label={st ? `${name}: ${st.line}` : name} style={look ? ({ "--tint": look.tint } as React.CSSProperties) : undefined} onClick={(e) => {
                    if (laneFilter !== id) return pickLane(id);
                    const r = e.currentTarget.getBoundingClientRect();
                    setKindMenu(kindMenu ? null : { x: r.left, y: r.bottom + 4 });
                  }} onContextMenu={id === "all" ? undefined : (e) => {
                    // Right-click on any agent's tab: its menu where the pointer is, without switching the view to it.
                    e.preventDefault();
                    setKindMenu({ x: e.clientX, y: e.clientY, lane: id });
                  }}>
                  {look && (
                    <span className="lane-tab-mark">
                      {look.mark}
                      {/* Whose agent it is, when it isn't yours: their initials on the mark, the name without them. */}
                      {/* Whose it is is said in words (the line under the name, or the chip beside it in the header): a badge here cut the ring. */}
                    </span>
                  )}
                  <span className="lane-tab-text">
                    <span className="lane-tab-name">
                      {who?.name ?? name}
                      {/* Whose it is, beside the name in the header, which has no line under it to say so; never on the ring. */}
                      {headSlot && who?.owner && <span className="lane-tab-who" aria-hidden="true">{initials(who.owner)}</span>}
                    </span>
                    {/* Where it stands in a word ("Working · 2m", "Needs you"), and for All agents how many are at work. */}
                    <span className="lane-tab-sub">{tabSub(id)}</span>
                  </span>
                  {id !== "all" && state.lead === id && <CrownIcon className="lane-tab-lead size-3.5" aria-label="Leads the other agents" />}
                  {st && <AgentState status={st.status} needsYou={st.needsYou} />}
                  {behind > 0 && <span className="lane-tab-unread" aria-label={`${behind} new`}>{behind > 9 ? "9+" : behind}</span>}
                  {laneFilter === id && filter !== "all" && <span className="lane-tab-kind">{filter === "team" ? "Team" : "Agent"}</span>}
                  {laneFilter === id && <Icon name="chevronDown" size={12} />}
                </button>
              );
            }),
            // One list with the tabs above, so this tab and its lane's are one element.
            ...startingAhead.map((s) => <StartingLaneTab key={`starting-${s.tool}`} tool={s.tool} name={ENGINE_NAMES[s.tool]} />)]}
          </div>
          {/* Another agent, one press from the agents already here. Beside the tabs rather than the last of them: in the list it
              was the part a narrow window cut off and faded under "More agents", and a button is no tab of a tab list (Arun,
              2026-10-28: "iron everything and ensure we are good… any logic errors and fixes"). */}
          {onConnect && me.role !== "viewer" && (
            <button
              type="button"
              className="lane-add"
              aria-label="Add an agent"
              title="Add an agent"
              aria-expanded={!!addMenu}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setAddMenu(addMenu ? null : { x: r.left, y: r.bottom + 4 });
              }}
            >
              <Icon name="plus" size={14} />
            </button>
          )}
          {hiddenIds.length > 0 && (
            <button type="button" className="lane-all" title={`${hiddenIds.length} more agent${hiddenIds.length === 1 ? "" : "s"}`} aria-label="More agents" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAgentMenu(agentMenu ? null : { x: r.right - 240, y: r.bottom + 4 }); }}>
              <Icon name="list" size={14} />
              <span>+{hiddenIds.length}</span>
              {hiddenIds.some((id) => statusOf(id)?.needsYou) ? <AgentState status="waiting" needsYou /> : hiddenIds.some((id) => runOf(state, id).status === "running") && <span className="lane-tab-live" title="One is working" />}
            </button>
          )}
          </div>
        )}
        {/* Everything any agent here is held up on you for, one press (or ⌘J) from each in turn. */}
        {/* Each agent in sight says it needs you on its own card: the pill is for those behind +N, and for ⌘J. */}
        {needs.some((a) => hiddenIds.includes(a.lane)) && (
          <button type="button" className="needs-pill" data-tip={`${needs.map((a) => a.name).join(", ")} · ${nextKey()} goes to the next`} onClick={() => jumpToNeeds(sid, hubAgents)}>
            <AgentState status="waiting" needsYou />
            <span>{needs.length === 1 ? `${needs[0]!.name} needs you` : `${needs.length} need you`}</span>
            <kbd>{nextKey()}</kbd>
          </button>
        )}
        {addMenu && onConnect && (
          <ContextMenu
            at={addMenu}
            onClose={() => setAddMenu(null)}
            items={() => [
              { heading: "Add an agent" },
              // The ones on this computer first: a tool that isn't installed has nothing to join with.
              ...splitTools(installedOn(identity)).here.map((t) => ({ label: ENGINE_NAMES[t], mark: <EngineMark tool={t} size={14} />, onSelect: () => onConnect("", t) })),
              { label: "Other agents…", icon: "plus" as const, onSelect: () => onConnect("") },
            ]}
          />
        )}
        {agentMenu && (
          <ContextMenu
            at={agentMenu}
            onClose={() => setAgentMenu(null)}
            items={() => [
              { heading: "More agents" },
              // Each as its tab would show it: the mark in its state's ring, whose it is, and where it stands under the name.
              ...hiddenIds.map((id) => {
                const st = statusOf(id);
                const who = ownerOf(id);
                return {
                  label: who.name,
                  title: laneLabel(state, id),
                  mark: (
                    <span className="menu-agent-mark" data-state={tabState(st?.status, st?.needsYou)}>
                      {agentLook(state, id, 13).mark}
                      {who.owner && <span className="lane-tab-owner" aria-hidden="true">{initials(who.owner)}</span>}
                    </span>
                  ),
                  sub: `${state.lead === id ? "Leads · " : ""}${tabSub(id)}`,
                  onSelect: () => pickLane(id),
                };
              }),
            ]}
          />
        )}
        {kindMenu && (
          <ContextMenu
            at={kindMenu}
            onClose={() => setKindMenu(null)}
            items={() => {
              const target = kindMenu.lane ?? laneFilter;
              return [
              { heading: "Show" },
              // On Solo there is no team to read messages from, so it is everything or the agents' work.
              ...(([["all", "Everything", "list"], ["team", "Team messages", "users"], ["agent", "Agent work", "agent"]] as [FeedFilter, string, IconName][]).filter(([v]) => !(solo && v === "team"))).map(([v, label, icon]) => ({ label, icon, checked: filter === v, onSelect: () => setFilter(v) })),
              // Two agents' chats side by side, from the agent's own menu (Arun, 2026-10-24: "get rid of this button and move this
              // function as an option for the coding tools dropdown"): this one beside the one in view, or the two closed back to one.
              ...(split && target !== "all" && (split.on || split.can)
                ? [
                    { heading: "View" },
                    split.on
                      ? { label: "Back to one chat", icon: "sidePanel" as const, onSelect: () => split.toggle() }
                      : { label: target === laneFilter ? "Side by side with another agent" : "Open beside this chat", icon: "sidePanel" as const, onSelect: () => split.toggle(target === laneFilter ? undefined : target) },
                  ]
                : []),
              // An agent added beside the main one can leave from its own tab, as it can from the Agents hub.
              ...(target !== "all" && (me.role === "owner" || me.role === "editor")
                ? [
                    { heading: "Agent" },
                    // The boss: one agent hands the others work and puts it together (agent-mesh.ts assign_task).
                    ...(everyone.length > 1
                      ? [
                          state.lead === target
                            ? { label: "Stop leading the others", icon: "x" as const, onSelect: () => void send({ type: "lead.set", lane: null }).then((r) => !r.ok && notify(r.error ?? "Couldn't do that.")) }
                            : {
                                label: "Make it lead the others",
                                icon: "crown" as const,
                                onSelect: () => void send({ type: "lead.set", lane: target }).then((r) => !r.ok && notify(r.error ?? "Couldn't do that.")),
                              },
                        ]
                      : []),
                    {
                      label: "Rename",
                      icon: "pencil" as const,
                      onSelect: () => {
                        const id = target;
                        askRemove({
                          title: `Rename ${laneLabel(state, id)}`,
                          body: "Everyone in the session sees the new name, in the chat and in the Agents panel.",
                          action: "Rename",
                          danger: false,
                          input: { label: "Agent name", value: laneLabel(state, id), maxLength: 40 },
                          onConfirm: async (name) => {
                            const r = await send({ type: "lane.rename", laneId: id, name });
                            if (!r.ok) throw new Error(r.error ?? "Couldn't rename the agent.");
                          },
                        });
                      },
                    },
                  ]
                : []),
              ...(target !== "all" && target !== MAIN_LANE && me.role === "owner"
                ? [
                    {
                      label: "Remove agent",
                      icon: "trash" as const,
                      danger: true,
                      onSelect: () => {
                        const id = target;
                        askRemove({
                          title: `Remove ${laneLabel(state, id)}?`,
                          body: "It stops and leaves this session. Its changes stay in the folder.",
                          action: "Remove agent",
                          onConfirm: async () => {
                            const r = await send({ type: "lane.remove", laneId: id });
                            if (r.ok) setLaneFilter("all");
                            else throw new Error(r.error ?? "Couldn't remove the agent.");
                          },
                        });
                      },
                    },
                  ]
                : []),
            ];
            }}
          />
        )}
      </div>,
      )}
      {/* Opens at the bottom at once: scrolling smoothly down through the whole history, every time a session opened, was a
          wait dressed up as an animation. New words still glide in (resize). */}
      {/* A fresh view for each agent and each filter: it opens on the latest message, rather than gliding down to it. */}
      {nativeOn ? (
        // One per agent: kept across a switch, it ran the last agent's line in the next one's screen (Arun, 2026-10-30: "it properly
        // switches the native terminals based on the coding tool lane").
        <LaneTui key={`${sid}|${tuiLane}`} sid={sid} invite={invite} lane={tuiLane!} tool={tuiTool!} title={laneLabel(state, tuiLane!)} onBack={() => toFriday(tuiLane!)} />
      ) : nativeWaiting ? (
        <div className="lane-tui lane-tui-wait" role="status">
          {nativeErr[tuiLane!] ? (
            <>
              <p className="small">
                {laneLabel(state, tuiLane!)}'s screen couldn't open: {nativeErr[tuiLane!]}
              </p>
              <span className="lane-tui-wait-acts">
                <button type="button" className="btn small" onClick={() => (setNativeErr(({ [tuiLane!]: _gone, ...rest }) => rest), setRetry((n) => n + 1))}>
                  Try again
                </button>
                <button type="button" className="link-btn small" onClick={() => (preferFriday(sid, tuiLane!, true), setRetry((n) => n + 1))}>
                  Use Friday's view
                </button>
              </span>
            </>
          ) : (
            <p className="muted small">{laneOnline ? `Opening ${laneLabel(state, tuiLane!)}…` : `Waiting for ${laneLabel(state, tuiLane!)} to reconnect…`}</p>
          )}
        </div>
      ) : ftuiAll ? (
        // All agents: each one's own screen side by side, its tool's where it has one and Friday's for the rest (Arun, 2026-10-30:
        // "make sure terminal view works for the all agents tab"). One terminal for everyone had every agent held and nothing
        // sent there ran.
        <div className="tui-grid" style={{ "--tui-cols": everyone.length > 4 ? 3 : everyone.length > 1 ? 2 : 1 } as React.CSSProperties}>
          {everyone.map((l) => {
            const tool = state.engines[l]?.tool;
            const native = !!tool && TERMINAL_TOOLS.has(tool) && state.engines[l]?.hostId === me.id && hasShells() && !friday(sid, l);
            if (native && state.terminals?.[l]) return <LaneTui key={`${sid}|${l}`} sid={sid} invite={invite} lane={l} tool={tool} title={laneLabel(state, l)} onBack={() => toFriday(l)} />;
            if (native && !atWork(l) && state.engines[l]?.online)
              return (
                <div key={`${sid}|${l}`} className="lane-tui lane-tui-wait" role="status">
                  <p className="muted small">Opening {laneLabel(state, l)}…</p>
                </div>
              );
            return (
              <FridayTui
                key={`${sid}|${l}`}
                sid={sid}
                lanes={[l]}
                to={l}
                state={state}
                events={events}
                me={me}
                send={send}
                notify={ctx.notify}
                onChat={() => setTuiView(false)}
                {...(native ? { onNative: () => (preferFriday(sid, l, false), redraw((n) => n + 1)) } : {})}
              />
            );
          })}
        </div>
      ) : ftuiOn ? (
        <FridayTui
          key={`${sid}|${tuiLane}`}
          sid={sid}
          lanes={[tuiLane!]}
          to={tuiLane!}
          state={state}
          events={events}
          me={me}
          send={send}
          notify={ctx.notify}
          onChat={() => setTuiView(false)}
          {...(nativeCan ? { onNative: () => void toNative() } : {})}
        />
      ) : (
      <Conversation key={`${laneFilter}|${filter}`} className="min-h-0 flex-1" initial="instant" onFollow={setFollowing} {...(agentUnreadAt !== -1 ? { openAt: "[data-catchup]" } : {})}>
        <ConversationContent className="mx-auto w-full max-w-[var(--read-w,860px)] gap-5 px-6 py-5">
          {state.options.team && laneFilter !== ALL && <TeammateHeader lane={laneFilter} identity={ctx.identity} notify={ctx.notify} {...(state.engines[laneFilter]?.branch ? { branch: state.engines[laneFilter]!.branch! } : {})} />}
          {state.options.team && <ThreadHost sid={sid} events={events} send={(c) => send(c as never)} />}
          {state.options.team && laneFilter === ALL && <RoomIntro sid={sid} />}
          {state.options.team && laneFilter === ALL && <RoomsNow sid={sid} identity={ctx.identity} empty={visible.length === 0} onOpen={(r) => dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid: r.sid, invite: r.invite } }))} />}
          {visible.length === 0 ? (
            <ConversationEmptyState
              icon={<SparklesIcon className="size-6" />}
              title={emptyTitle}
              description={emptyText}
            />
          ) : (
            visible.map((it, i) => {
              const laneId = laneOfItem(it);
              const idx = lanes.findIndex((l) => l.id === laneId);
              // Only work from an extra lane is marked; the main lane is the
              // default and a tag on every card would just be noise.
              const lane = idx === -1 ? null : lanes[idx]!;
              const seq = it.kind === "run" ? it.key : it.kind === "notes" ? it.evs[0]!.seq : it.ev.seq;
              return (
                // data-seq anchors the catch-up panel's "jump to where you left off".
                <FeedRow key={feedKey(it)} settled={it.kind !== "run" || !!it.ended} data-seq={seq} data-lane={laneId} className={`${lane ? "feed-item agent-lane" : "feed-item"}${isSetAside(rewinds, seq, laneId) ? " set-aside" : ""}`} style={lane ? ({ "--tint": agentLook(state, lane.id).tint } as React.CSSProperties) : undefined}>
                  {breaks[i] && <div className="tm-daybreak" role="separator">{breaks[i]}</div>}
                  {/* Where the new part starts: what arrived after this person last looked, as a line that stays where it was when they opened the room. */}
                  {i === unreadAt && <div className="feed-unread" role="separator" aria-label="New since you looked" {...(i === agentUnreadAt ? { "data-catchup": "" } : {})}><span>New since you looked</span></div>}
                  {/* Who is speaking, once per stretch: the name over the first of an agent's items, not over every one. */}
                  {tags && lane && it.kind !== "run" && (i === 0 || laneOfItem(visible[i - 1]!) !== laneId) && !answeredBelow(i) && (
                    <span className="lane-tag">
                      <span className="lane-tag-mark">{agentLook(state, lane.id, 12).mark}</span>
                      {laneLabel(state, lane.id)}
                      {/* The tool's name only where its mark isn't already saying it: "Second · Claude Code" beside Claude's mark said it twice. */}
                      {!state.engines[lane.id]?.tool && <small>{agentLook(state, lane.id).label}</small>}
                    </span>
                  )}
                  {it.kind === "run" ? (
                    teamGroup?.(it) ?? teamRun?.(it) ?? <RunBlock item={it} ctx={ctx} folded={!!it.ended && !(recentRunKeys.get(it.lane) ?? []).includes(it.key)} latest={it.key === lastRunKeys.get(it.lane)} active={!it.ended && it.key === lastRunKeys.get(it.lane) && it.closedBy !== "run.pause" && it.closedBy !== "run.cancel" && runOf(state, it.lane).status !== "idle"} typing={it.streaming ? typingOf(streams[it.lane]) : null} />
                  ) : it.kind === "notes" ? (
                    <NotesLine evs={it.evs} ctx={ctx} />
                  ) : (
                    teamGroup?.(it) ?? <EventItem ev={it.ev} ctx={ctx} />
                  )}
                </FeedRow>
              );
            })
          )}
          {/* Your own message, standing in for itself until the log has it. */}
          {pending.map((p) => (
            <div key={p.id} className="feed-item">
              <Message from="user" className="max-w-none pending-echo">
                <MessageContent>
                  <MessageResponse>{p.text}</MessageResponse>
                </MessageContent>
              </Message>
              <div className="delivery justify-end">
                <span className="pulse-dot" /> Sending…
              </div>
            </div>
          ))}
          {/* The end: what it came to, in a line and in numbers, with the recording a press away. */}
          {merged && !pin && (
            <div className="feed-merged" role="status">
              <div className="feed-merged-head">
                <span className="feed-merged-mark">
                  <Icon name="gitPullRequest" size={15} />
                </span>
                <div className="feed-merged-body">
                  <b>Merged. This session's work is in.</b>
                  <span className="feed-merged-line">{leftOff(state, events).status.line}</span>
                </div>
              </div>
              <div className="feed-merged-stats">
                {recapStats(events, merged.at).map((t) => (
                  <span key={t}>{t}</span>
                ))}
              </div>
              <div className="feed-merged-actions">
                <a className="btn small" href={merged.url} onClick={(e) => (e.preventDefault(), window.open(merged.url, "_blank", "noopener"))}>
                  Open the pull request
                </a>
                {onPlayBack && (
                  <button type="button" className="btn ghost small" onClick={onPlayBack}>
                    <Icon name="play" size={12} /> Play it back
                  </button>
                )}
              </div>
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      )}
      {/* Nothing to write into while you are looking at the past: a composer
          under a session wound back to Tuesday would send to today, which is
          not what anybody reading it would expect. */}
      {!replaying && !tuiOn && (
        <div className="composer-dock">
          <RaceCard state={state} me={me} events={events} identity={identity} sid={sid} invite={invite} send={send} />
          {/* Away or paused, said over every team chat's box with the one press that ends it (TeamControls.tsx). */}
          {state.options.team && <TeamBanner identity={identity} notify={ctx.notify} />}
          {/* One panel per agent that has something waiting: each has its own queue and its own driver. A column of a split
              shows its own agent's only: three columns each repeating every agent's queue and questions buried the chats. */}
          {queuesShown.filter((id) => !pin || id === pin).map((id) => (
            <QueuedInstructions key={id} ctx={ctx} events={events} lane={id} />
          ))}
          <Redirects ctx={ctx} />
          <PinBar state={state} me={me} sid={sid} invite={invite} send={send} lane={target} open={pinning} onClose={() => setPinning(false)} />
          <PlanApproval ctx={ctx} events={events} lane={target} />
          {/* One card per agent that asked you: each answer goes to the agent that asked it. */}
          {questionsTo(state, me.id).filter((q) => !pin || q.lane === pin).map((q) => (
            <div key={q.lane} data-needs={q.lane} className="needs-anchor">
              <AgentQuestion ctx={ctx} q={q} />
            </div>
          ))}
          <Composer ctx={ctx} lane={target} locked={!!pin} onLane={(l) => (pick(l), laneFilter !== ALL && setLaneFilter(l))} onPin={() => setPinning(true)} events={events} plan={<LivePlan events={events} state={state} {...(pin ? { lane: pin } : {})} team={!secondary && boardHere} {...(me.role !== "viewer" ? { control: (id: string, action: TaskAction, to?: string) => void send({ type: "board.task", id, action, ...(to ? { to } : {}) }).then((r) => !r.ok && ctx.notify(r.error ?? "Couldn't change that task.")) } : {})} />} />
          {/* Under the box: the way back through the session on the left, and what the agent's context has cost on the right, under send.
              In the Focus layout both live in the status bar along the window's foot instead. */}
          {(() => {
            const jumpMenu =
              !pin && events.length > 3 ? (
              <MenuButton
                text="Jump"
                {...(state.options.work ? { text: "Go to…" } : {})} // Work's words for it (Arun, 2026-10-28: "iron everything… focusing on UI and UX").
                caret="chevronsUpDown"
                label="Jump to a place in this session"
                above
                width={340}
                items={() => {
                  // Each place says what is waiting there and how long ago, not just its name: the files, the command that
                  // failed, the words of your message. Only the ones this session has; then its start and its latest.
                  let places = jumpPlaces(events, me.id);
                  if (state.options.work) places = jumpPlaces(events, me.id, true); // Work's words for them
                  const ago = (ts: number) => (relTime(ts) === "now" ? "just now" : `${relTime(ts)} ago`);
                  const start = events.find((e) => e.body.type === "instruction")?.seq;
                  const end = events.at(-1)?.seq;
                  return [
                    { heading: places.length ? "Jump to" : "Nothing to jump to yet" },
                    ...places.map((p) => ({ label: p.label, icon: JUMP_ICON[p.key], sub: `${p.detail} · ${ago(p.ts)}`, hint: `g ${p.key}`, onSelect: () => jumpTo(p.seq) })),
                    ...(start ? [{ heading: "This session" }, { label: "The beginning", icon: "arrowUp" as const, sub: "The first message", onSelect: () => jumpTo(start) }] : []),
                    ...(end ? [{ label: "The latest", icon: "arrowDown" as const, sub: "Back to now", onSelect: () => jumpTo(end) }] : []),
                  ];
                }}
              />
              ) : null;
            // The agent the box is aimed at, with its own model: pick Codex and the ring is Codex's.
            const eng = state.engines[target];
            let gauge: ReactNode = <ContextGauge key={`${target}:${eng?.tool ?? ""}`} solo={!!solo} events={events} lane={target} friday={!eng?.tool} model={eng?.tool ? (eng.model ?? "") : (state.options.model ?? "")} identity={identity} {...(eng?.tool ? { tool: eng.tool } : {})} {...(eng?.account ? { account: eng.account.id } : {})} />;
            // A team's chats have no coding gauge or jump menu under the box: they are a conversation (teammates.ts).
            if (state.options.team) return null;
            // Nor Work's: a context ring is coding chrome, and hidden it still carried its "Context: not reported yet" (Arun,
            // 2026-10-28: "iron everything and ensure we are good").
            if (state.options.work) gauge = null;
            if (under) return createPortal(<>{jumpMenu}{gauge}</>, under);
            return (
              <div className="composer-under">
                {jumpMenu ?? <span />}
                {gauge}
              </div>
            );
          })()}
        </div>
      )}
    </section>
    </PatchSource.Provider>
  );
}

// ── small pieces ──────────────────────────────────────────────────────

/**
 * One row of the feed: drawn again with the rest while it is near the view, and, once its turn is over, left as it last was
 * while it is far from it (feed-near.ts). A turn still going always draws, wherever it is.
 */
function FeedRow({ settled, children, ...div }: React.HTMLAttributes<HTMLDivElement> & { settled: boolean; "data-seq": number; "data-lane": string }) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNear(ref);
  return (
    <div ref={ref} {...div}>
      <Held keep={settled && !near}>{children}</Held>
    </div>
  );
}
/** Its children as they were while `keep` stays true; drawn afresh the moment it is false. */
const Held = memo(
  function Held({ children }: { keep: boolean; children: React.ReactNode }) {
    return <>{children}</>;
  },
  (was, now) => was.keep && now.keep,
);

/**
 * "3 session notes ›": the housekeeping between messages, as one quiet line that opens to them (DIRECTION.md §5 and §9.6: system
 * events are one collapsible line). Folded to begin with: the line says how many, and a press shows each.
 */
const NotesLine = memo(function NotesLine({ evs, ctx }: { evs: SessionEvent[]; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="notes-line">
      <button type="button" className="notes-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {evs.length} session notes
        <ChevronRightIcon className={`size-3.5 ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="notes-list">
          {evs.map((ev) => (
            <EventItem key={ev.seq} ev={ev} ctx={ctx} />
          ))}
        </div>
      )}
    </div>
  );
});

// Made once: toLocaleTimeString and toLocaleString build a formatter on every call, and every event's stamp asked for two
// on every render of the conversation.
const clock = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });
const clockOnDay = new Intl.DateTimeFormat([], { weekday: "short", hour: "numeric", minute: "2-digit" });
// What toLocaleString() with no options shows: the date and the time to the second.
const dateAndTime = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
const time = (ts: number) => clock.format(ts);

function Stamp({ ev }: { ev: SessionEvent }) {
  return (
    <span className="stamp" title={`#${ev.seq} · ${dateAndTime.format(ev.ts)}`}>
      {time(ev.ts)}
    </span>
  );
}

/**
 * Bring an agent that went offline back, from the notice that says so.
 *
 * Nothing else did: the agent picker only rewires an agent that is online, and "bring your own" is hidden from someone who
 * already has one here, so a runner that died with its server left its owner reading "instructions wait until it
 * reconnects" with no way to make it. The same start the picker sends, on the same folder, lane, mode and model.
 */
function Reconnect({ ev, ctx }: { ev: SessionEvent; ctx: Ctx }) {
  const lane = ev.lane ?? MAIN_LANE;
  const e = ctx.state.engines[lane];
  const [busy, setBusy] = useState(false);
  // Only the person whose machine it is, only while it is still offline, and only on the newest notice.
  if (!e || e.online || e.hostId !== ctx.me.id || e.sinceSeq !== ev.seq) return null;
  const start = async () => {
    setBusy(true);
    await reconnectLane(ctx, lane);
    setBusy(false);
  };
  return (
    <button type="button" className="btn ghost small" disabled={busy} onClick={() => void start()}>
      {busy ? "Reconnecting…" : "Reconnect"}
    </button>
  );
}

/** Lanes being started again from this page, so a second press doesn't start a second runner on top of the first. */
const reconnecting = new Set<string>();

/** Offline spells already started again on opening the session (`sid|lane:sinceSeq`), so a failed start isn't retried in a loop. */
const autoReconnected = new Set<string>();

/** Start my own agent on its lane again: the start the picker sends, on the same folder, mode and model. `quiet`: nobody pressed anything, so a failure says nothing. */
async function reconnectLane(ctx: Ctx, lane: string, quiet = false): Promise<void> {
  const e = ctx.state.engines[lane];
  const key = `${ctx.sid}|${lane}`;
  if (!e || reconnecting.has(key)) return;
  reconnecting.add(key);
  try {
    // A teammate (teammates.ts) is brought back by its own record: its kept conversation, its folders, its account.
    if (ctx.state.options.team) return void (await reconnectTeammate(ctx.identity, ctx.sid, lane, quiet));
    await hostApi(ctx.identity, "/api/runner/start", {
      method: "POST",
      // Brought back by itself (quiet): only if this computer doesn't already have it on the way back. Every window showing the
      // session asked, and each start took the lane from the one before mid-turn (Edge Defense, 2026-10-25: Codex attached
      // three times in six seconds, its turn stopped each time).
      body: JSON.stringify({ sid: ctx.sid, invite: ctx.invite, ...(e.tool ? { tool: e.tool } : {}), cwd: e.cwd, mode: modeOf(e), ...(e.handMode ? { handMode: e.handMode } : {}), lane, ...(e.model ? { model: e.model } : {}), ...(e.account ? { account: e.account.id } : {}), ...(e.copyOf ? { copyOf: e.copyOf } : {}), ...(e.shared ? { share: true } : {}), ...(quiet ? { ifOffline: true } : {}) }),
    });
  } catch (err) {
    if (!quiet) ctx.notify(`Couldn't reconnect: ${(err as Error).message}`);
  } finally {
    reconnecting.delete(key);
  }
}

/** A message for an agent from outside the composer, answered when it has gone (or hasn't): see "friday:ask-lane". */
export interface AskLane {
  lane: string;
  text: string;
  reply: (r: { ok: boolean; error?: string }) => void;
  /** Set by the session that took it; nobody did, and the caller sends it itself. */
  handled?: boolean;
}

/**
 * Send to an agent as the composer does: my own agent that isn't running here is started first (offline, or, on this computer,
 * said to be attached with no runner behind it: `ifOffline` leaves one that is really there alone), then switched to what the
 * words call for, then given them.
 */
async function askLane(ctx: Ctx, lane: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const e = ctx.state.engines[lane];
  if (e?.tool && e.hostId === ctx.me.id && e.cwd && !ctx.replaying && runOf(ctx.state, lane).status !== "running" && (!e.online || isLocal())) {
    await reconnectLane(ctx, lane, e.online);
  }
  await smartSwitch(ctx, lane, reachFor(ctx.state, lane, text), true);
  return ctx.send({ type: "instruct", text, ...(lane !== MAIN_LANE ? { lane } : {}) });
}

/**
 * Plan, Manual or Auto, picked for the work before the agent gets it (smartReach.ts). A restart on the same folder and lane,
 * as choosing a mode by hand is; the pill shows where it is. Nothing when it isn't on this computer, is mid-run (a restart
 * would cut the step short) or already fits; a switch that fails leaves it as it was and says so.
 */
async function smartSwitch(ctx: Ctx, lane: string, want: Reach | null, settled = false): Promise<void> {
  // A teammate always runs in full, and a restart in another mode would lose its kept conversation (teammates.ts).
  if (ctx.state.options.team) return;
  const e = ctx.state.engines[lane];
  const key = `${ctx.sid}|${lane}`;
  if (!e?.online || e.hostId !== ctx.me.id || reconnecting.has(key)) return;
  if (runOf(ctx.state, lane).status === "running") return;
  const to = settled ? want : settle(ctx.state, lane, want);
  if (!to || to.mode === modeOf(e)) return;
  // Said to be automatic, with the mode picked by hand: only my own turn runs in it, and it goes back when that run ends.
  const hand = e.handMode ?? modeOf(e);
  reconnecting.add(key);
  try {
    await hostApi(ctx.identity, "/api/runner/start", {
      method: "POST",
      body: JSON.stringify({ sid: ctx.sid, invite: ctx.invite, ...(e.tool ? { tool: e.tool } : {}), cwd: e.cwd, mode: to.mode, ...(to.mode !== hand ? { handMode: hand } : {}), lane, ...(e.model ? { model: e.model } : {}), ...(e.account ? { account: e.account.id } : {}), ...(e.copyOf ? { copyOf: e.copyOf } : {}), ...(e.shared ? { share: true } : {}) }),
    });
    // Said, in a line: a mode that changed by itself, unannounced, was how a lane came to sit in Plan with nobody knowing why.
    ctx.notify(`${agentNameFor(ctx.state, lane)}: ${REACH_NAME[to.mode]}, ${to.why}`);
  } catch (err) {
    ctx.notify(`Couldn't switch to ${REACH_NAME[to.mode]}, so it stays on ${REACH_NAME[e.mode]}: ${(err as Error).message}`);
  } finally {
    reconnecting.delete(key);
  }
}

/** An instruction Friday or the reviewer gave the agent: one line saying what it was, and the text itself on request. */
function SystemAsk({ ev }: { ev: Ev<"instruction"> }) {
  const [open, setOpen] = useState(false);
  const t = ev.body.text;
  const what =
    ev.actor.id === "reviewer"
      ? "The second review's findings went back to the agent"
      : t.startsWith("[ci]")
        ? "Friday handed the failing checks to the agent"
        : t.startsWith("[review]")
          ? "Friday passed the new review comments to the agent"
          : "Friday asked the agent to carry on";
  return (
    <div className="sys-ask">
      <Notice ev={ev} icon={ev.actor.id === "reviewer" ? ShieldCheckIcon : ev.body.keepGoing ? PlayIcon : GitPullRequestIcon} tone="control">
        {what}
        <button type="button" className="link-btn cp-action" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "What it was told"}
        </button>
      </Notice>
      {open && <pre className="sys-ask-text">{t}</pre>}
    </div>
  );
}

function Notice({ ev, icon: I, tone = "", children }: { ev: SessionEvent; icon: LucideIcon; tone?: string; children: ReactNode }) {
  return (
    <Checkpoint className={cn("cp-notice", tone)}>
      <CheckpointIcon>
        <I className="size-3.5 shrink-0" />
      </CheckpointIcon>
      <span className="cp-text">{children}</span>
      <span className="cp-stamp">
        <Stamp ev={ev} />
      </span>
    </Checkpoint>
  );
}

/**
 * A conversation brought in from somebody's coding tool, or carried over by a fork.
 *
 * Its messages are in the log for every agent here, so they are readable here too: the notice used to tell people they could
 * work from a conversation nothing on the page ever showed them. How many came along is said the way it is known: all of them,
 * the last few of a known count, or only the latest of one too long to read to its start.
 */
function ImportedNotice({ ev }: { ev: Ev<"session.imported"> }) {
  const b = ev.body;
  // Open or shut as it was left, on this device: it shut again at every reload (2026-10-27 audit).
  const key = `friday.imported.open:${ev.seq}:${ev.ts}`;
  const [open, setOpenState] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  const setOpen = (v: boolean) => {
    setOpenState(v);
    try {
      if (v) localStorage.setItem(key, "1");
      else localStorage.removeItem(key);
    } catch {
      // A preference: losing it shuts the list again, nothing more.
    }
  };
  const n = b.turns.length;
  const title = b.title.length > 48 ? `${b.title.slice(0, 47)}…` : b.title;
  const which = b.partial ? `its latest ${n}` : b.total > n ? `the last ${n} of ${b.total}` : `all ${b.total}`;
  return (
    <>
      <Notice ev={ev} icon={HistoryIcon} tone="control">
        {b.fork ? `Forked from “${title}” with its last ${n} messages; from here it goes its own way. ` : `Brought in “${title}”: ${which} messages of an earlier ${ENGINE_NAMES[b.tool]} conversation, for every agent here. `}
        {/* A button that looks like one, with the way it opens (2026-10-27 audit: it read as plain text). */}
        <button type="button" className="btn ghost small imported-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide them" : "Show them"}
          <Icon name="chevronDown" size={12} className={open ? "rotate-180" : undefined} />
        </button>
      </Notice>
      {open && <div className="thinking-body">{b.turns.map((t) => `${t.role === "user" ? "They said" : b.fork ? "The agent" : ENGINE_NAMES[b.tool]}: ${t.text}`).join("\n\n")}</div>}
    </>
  );
}


/**
 * A folder in a message is one thing, the way it was one thing in the
 * composer: two hundred thumbnails of source files is not a message anybody
 * reads. The files are all there — in the tree, where a folder belongs — so
 * this says which folder and how much of it, and points at the tree.
 */
function FolderChip({ name, files, onOpen }: { name: string; files: number; onOpen?: () => void }) {
  return (
    <button type="button" className="att-card att-folder" onClick={onOpen} title={`${files} files in ${name}`}>
      <span className="att-tile">
        <Icon name="folder" size={16} />
      </span>
      <span className="att-text">
        <span className="att-card-name">{name}</span>
        <span className="att-card-kind">
          {files} file{files === 1 ? "" : "s"}
          {onOpen && <span className="att-folder-open"> · Open the tree</span>}
        </span>
      </span>
    </button>
  );
}

/** "PDF · 240 KB": what a file is, and how big, in the words people use for it. */
function kindOf(a: Attachment): string {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(a.name)?.[1]?.toUpperCase();
  const size = a.size >= 1_048_576 ? `${(a.size / 1_048_576).toFixed(1)} MB` : a.size >= 1024 ? `${Math.round(a.size / 1024)} KB` : `${a.size} B`;
  return `${ext ?? "File"} · ${size}`;
}

function AttachmentList({ atts, ctx, align }: { atts: Attachment[]; ctx: Ctx; align: "start" | "end" }) {
  // A picture opens in front of the page, not in a window of its own (Lightbox).
  const [big, setBig] = useState<Attachment | null>(null);
  if (!atts.length) return null;
  // Anything with a path came from a folder pick; the rest are files somebody
  // chose one at a time, and those still show as themselves.
  const folders = new Map<string, number>();
  const loose: Attachment[] = [];
  for (const a of atts) {
    if (a.name.includes("/")) folders.set(a.name.split("/")[0]!, (folders.get(a.name.split("/")[0]!) ?? 0) + 1);
    else loose.push(a);
  }
  return (
    <MessageAttachments className={align === "start" ? "ml-0" : ""}>
      {[...folders].map(([name, n]) => (
        <FolderChip key={name} name={name} files={n} onOpen={() => ctx.onOpen?.("tree")} />
      ))}
      {loose.map((a) =>
        a.type.startsWith("image/") ? (
          <a
            key={a.id}
            className="att-pic"
            href={fileUrl(ctx.sid, ctx.invite, a.id)}
            target="_blank"
            rel="noopener"
            title={`Open ${a.name}`}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey) return;
              e.preventDefault();
              setBig(a);
            }}
          >
            <img src={fileUrl(ctx.sid, ctx.invite, a.id)} alt={a.name} loading="lazy" />
            <span className="att-pic-name">{a.name}</span>
          </a>
        ) : (
          <a key={a.id} className="att-card" href={fileUrl(ctx.sid, ctx.invite, a.id)} target="_blank" rel="noopener" title={`Open ${a.name}`}>
            <span className="att-tile">
              <Icon name="file" size={16} />
            </span>
            <span className="att-text">
              <span className="att-card-name">{a.name}</span>
              <span className="att-card-kind">{kindOf(a)}</span>
            </span>
          </a>
        ),
      )}
      {big && <Lightbox src={fileUrl(ctx.sid, ctx.invite, big.id)} alt={big.name} onClose={() => setBig(null)} />}
    </MessageAttachments>
  );
}

// ── messages between sessions (peers.ts) ─────────────────────────────

/** Opens another session from its card, when this browser knows the way in (it's in the person's list). */
function OpenSession({ sid }: { sid: string }) {
  if (!loadRecents().some((r) => r.sid === sid)) return null;
  return (
    <button type="button" className="link-btn" onClick={() => window.dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid } }))}>
      Open
    </button>
  );
}

/**
 * A message between sessions: one that arrived for an agent here, one this session's agent sent, or one waiting here for
 * someone who can steer the agent to let it through.
 */
function PeerCard({ ev, ctx }: { ev: Ev<"instruction"> | Ev<"peer.sent"> | Ev<"peer.held">; ctx: Ctx }) {
  const { me, state, delivered, send, notify } = ctx;
  const b = ev.body;
  const lane = ev.lane ?? MAIN_LANE;
  const [busy, setBusy] = useState(false);
  let head: ReactNode;
  let note = "";
  let actions: ReactNode = null;
  let icon: LucideIcon = MessageSquareIcon;
  if (b.type === "peer.sent") {
    icon = SendIcon;
    head = (
      <>
        Sent to {b.to.name} in “{b.to.title}”
      </>
    );
    note = b.held ? "Waits there until someone who can steer that agent lets it through" : "";
    actions = <OpenSession sid={b.to.sid} />;
  } else {
    const p = b.type === "peer.held" ? b.from : b.peer!;
    head = (
      <>
        From {p.fromName} in “{p.fromTitle}”{lane !== MAIN_LANE || state.lanes.length ? <> to {laneLabel(state, lane)}</> : null}
      </>
    );
    actions = <OpenSession sid={p.fromSid} />;
    if (b.type === "instruction") {
      note = [`${p.by.name}'s agent`, p.approvedBy ? `let through by ${p.approvedBy}` : "", stillPending(state, lane, delivered).includes(ev.seq) ? "queued" : delivered.has(ev.seq) ? "read" : ""].filter(Boolean).join(" · ");
    } else {
      const settled = ctx.events.find((e) => e.body.type === "peer.settled" && e.body.id === b.id);
      if (settled?.body.type === "peer.settled") {
        note = settled.body.delivered ? `Let through by ${settled.actor.id === me.id ? "you" : settled.actor.name}` : `Turned away by ${settled.actor.id === me.id ? "you" : settled.actor.name}`;
      } else {
        note = `Waiting: ${p.by.name} can't steer this agent, so someone who can decides`;
        const settle = async (deliver: boolean) => {
          setBusy(true);
          const r = await send({ type: "peer.settle", id: b.id, deliver, lane });
          setBusy(false);
          if (!r.ok) notify(r.error ?? "Couldn't do that.");
        };
        if (canDriveLane(state, me.id, lane) || driverOf(state, lane)?.id === me.id) {
          actions = (
            <>
              {actions}
              <button type="button" className="btn ghost small" disabled={busy} onClick={() => void settle(false)}>
                Turn away
              </button>
              <button type="button" className="btn primary small" disabled={busy} onClick={() => void settle(true)}>
                Let it through
              </button>
            </>
          );
        }
      }
    }
  }
  const I = icon;
  return (
    <div className={cn("peer-card", b.type === "peer.held" && !note.startsWith("Let") && !note.startsWith("Turned") && "waiting")}>
      <div className="peer-head">
        <I className="size-3.5 shrink-0" />
        <span className="peer-title">{head}</span>
        <Stamp ev={ev} />
      </div>
      <p className="peer-text">{b.text}</p>
      {(note || actions) && (
        <div className="peer-foot">
          {note && <span className="peer-note">{note}</span>}
          {actions && <span className="peer-actions">{actions}</span>}
        </div>
      )}
    </div>
  );
}

// ── hubs (hubs.ts): one plan, several agents at once ─────────────────

const HUB_STATUS: Record<string, string> = { waiting: "waiting", running: "working", done: "done", failed: "failed", skipped: "skipped" };

/** The hub's card: the plan to approve, then where each task stands, then how it went. One card, read from the session's state. */
function HubCard({ ev, ctx }: { ev: Ev<"hub.planned">; ctx: Ctx }) {
  const { me, state, send, notify } = ctx;
  const b = ev.body;
  const hub = state.hub?.id === b.id ? state.hub : null;
  const [dropped, setDropped] = useState<ReadonlySet<string>>(new Set());
  const [tools, setTools] = useState<Record<string, EngineTool>>({});
  const [busy, setBusy] = useState(false);
  const owner = me.role === "owner";
  const planned = !hub || hub.status === "planned";
  const tasks = hub?.tasks ?? b.tasks;
  const kept = tasks.filter((t) => !dropped.has(t.id));
  const act = async (cmd: Parameters<typeof send>[0]) => {
    setBusy(true);
    const r = await send(cmd);
    setBusy(false);
    if (!r.ok) notify(r.error ?? "That didn't work.");
  };
  const approve = () => act({ type: "hub.approve", id: b.id, tasks: kept.map((t) => ({ id: t.id, ...(tools[t.id] ? { tool: tools[t.id]! } : {}) })) });
  const cancel = () => act({ type: "hub.cancel", id: b.id });
  const counts = hub ? Object.values(hub.runs).reduce((n, r) => ((n[r.status] = (n[r.status] ?? 0) + 1), n), {} as Record<string, number>) : {};
  const line = !hub || hub.status === "planned"
    ? `${tasks.length} task${tasks.length === 1 ? "" : "s"}, ${b.width} at once`
    : hub.status === "running"
      ? `${counts.running ?? 0} working · ${counts.done ?? 0} done${counts.failed ? ` · ${counts.failed} failed` : ""}`
      : hub.status === "merging"
        ? "bringing the copies together"
        : hub.status === "done"
          ? `${counts.done ?? 0} of ${tasks.length} done${hub.prUrl ? " · pull request opened" : hub.sha ? " · committed" : ""}`
          : hub.status;
  const testsWord = (t: "pass" | "fail" | "none" | undefined) => (t === "pass" ? "tests passed" : t === "fail" ? "tests failed" : "");
  return (
    <div className={cn("hub-card", hub?.status ?? "planned")}>
      <div className="hub-head">
        <SparklesIcon className="size-3.5 shrink-0" />
        <b>Parallel work</b>
        <span className="hub-line">{line}</span>
        <Stamp ev={ev} />
      </div>
      <p className="hub-goal">{b.goal}</p>
      <ol className="hub-tasks">
        {tasks.map((t, i) => {
          const r = hub?.runs[t.id];
          const off = dropped.has(t.id);
          const after = t.dependsOn.map((d) => tasks.findIndex((x) => x.id === d) + 1).filter((n) => n > 0);
          const tool = tools[t.id] ?? t.tool;
          return (
            <li key={t.id} className={cn("hub-task", off && "off", r?.status)}>
              <span className="hub-task-n">{i + 1}</span>
              <div className="hub-task-main">
                <div className="hub-task-title">
                  {t.title} <span className={`hub-tier ${t.tier}`}>{t.tier === "heavy" ? "hard" : t.tier === "light" ? "small" : "everyday"}</span>
                </div>
                <div className="rv-meta">
                  <span title={t.files.join("\n")}>{t.files.length ? `${t.files.slice(0, 3).join(", ")}${t.files.length > 3 ? ` +${t.files.length - 3}` : ""}` : "files as needed"}</span>
                  {after.length > 0 && <span>after {after.join(", ")}</span>}
                  {t.check && (
                    <span>
                      <code>{t.check}</code>
                    </span>
                  )}
                  {r && r.status !== "waiting" && (
                    <span className={`hub-status ${r.status}`}>
                      {HUB_STATUS[r.status]}
                      {r.attempt > 1 ? `, second try` : ""}
                      {r.status !== "running" && r.tests && testsWord(r.tests) ? ` · ${testsWord(r.tests)}` : ""}
                    </span>
                  )}
                </div>
                {r?.summary && r.status !== "running" && <p className="hub-task-summary">{r.summary}</p>}
              </div>
              <span className="hub-task-tool">
                {planned && owner ? (
                  <select className="own-select" value={tool ?? ""} aria-label={`Tool for ${t.title}`} onChange={(e) => setTools({ ...tools, [t.id]: e.target.value as EngineTool })}>
                    {b.tools.map((x) => (
                      <option key={x} value={x}>
                        {ENGINE_NAMES[x]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="hub-tool-name">
                    <EngineMark tool={tool ?? ""} size={13} /> {tool ? ENGINE_NAMES[tool] : ""}
                  </span>
                )}
                {planned && owner && (
                  <button type="button" className="icon-btn tiny" title={off ? "Put it back" : "Leave this task out"} aria-pressed={off} onClick={() => setDropped((d) => { const n = new Set(d); if (n.has(t.id)) n.delete(t.id); else n.add(t.id); return n; })}>
                    {off ? <Redo2Icon className="size-3" /> : <XIcon className="size-3" />}
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      {planned && (
        <div className="hub-actions">
          <span className="muted small">{owner ? "Each task runs in its own copy of the folder; the copies are brought together and sent as one pull request." : "Waiting for the owner to approve the plan."}</span>
          {owner && (
            <>
              <button type="button" className="btn ghost small" disabled={busy} onClick={cancel}>
                Cancel
              </button>
              <button type="button" className="btn primary small" disabled={busy || !kept.length} onClick={approve}>
                Run {kept.length} task{kept.length === 1 ? "" : "s"}
              </button>
            </>
          )}
        </div>
      )}
      {hub && (hub.status === "running" || hub.status === "merging") && (
        <div className="hub-actions">
          <span className="muted small">{hub.status === "merging" ? "Each copy's work is brought into the folder, in order; conflicts go to the main agent." : "Tasks that miss get one more try, one model up."}</span>
          {owner && (
            <button type="button" className="btn ghost small" disabled={busy} onClick={cancel}>
              Cancel the hub
            </button>
          )}
        </div>
      )}
      {hub && (hub.status === "done" || hub.status === "failed" || hub.status === "cancelled") && (
        <div className="hub-actions">
          <span className="muted small">{hub.status === "cancelled" ? "Cancelled." : hub.why ? hub.why : hub.status === "failed" ? "No task got through." : hub.prUrl ? "Shipped as one pull request." : hub.sha ? `Committed as ${hub.sha.slice(0, 7)}.` : "Done."}</span>
          {hub.prUrl && (
            <a className="btn primary small" href={hub.prUrl} target="_blank" rel="noreferrer">
              Open pull request
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/** A task's title, from the session's hub, for the one-line notices. */
const hubTaskTitle = (state: SessionState, id: string, task: string) => (state.hub?.id === id ? state.hub.tasks.find((t) => t.id === task)?.title : undefined) ?? task;

// ── team messages ─────────────────────────────────────────────────────

/**
 * The messages agents have read: each delivery logged, and the message each run started from, whether or not a delivery was
 * logged for it (2026-10-27 audit: an answered message still said "Queued for the agent's next step" over the reply to it).
 */
export function deliveredIn(events: readonly SessionEvent[]): Set<number> {
  const out = new Set<number>();
  for (const e of events) {
    if (e.body.type === "instructions.delivered") e.body.seqs.forEach((s) => out.add(s));
    else if (e.body.type === "run.started") out.add(e.body.causedBy);
  }
  return out;
}

/**
 * What still waits for an agent: its queue as the session has it, less any message already read (`delivered`: an instructions
 * delivery, or the start of a run it started). A label never says "queued" over the agent's reply to it (2026-10-27 audit).
 */
export const stillPending = (state: SessionState, lane: string, delivered: ReadonlySet<number>): number[] => pendingFor(state, lane).filter((s) => !delivered.has(s));

/**
 * Whether an agent's turn waits on a person: stopped for their answer, a question it asked mid-turn, or a permission to answer.
 * Everything that speaks of the turn says so then, the feed, the queue and the box alike (2026-10-27 audit: the bar said
 * "Waiting for you" while the feed said "Working · 40m", the queue "Delivered when this step finishes" and the box "Redirect").
 */
export const waitsOnPerson = (state: SessionState, lane: string): boolean => runOf(state, lane).status === "waiting_for_human" || !!state.openQuestions?.[lane] || !!state.approvals?.[lane];

/** Whether what is queued for an agent is waiting (a step under way, a request to answer, its tool away), not being picked up now. */
const queueHolds = (state: SessionState, lane: string): boolean =>
  runOf(state, lane).status !== "idle" || (!!state.engines[lane]?.tool && !state.engines[lane]!.online) || !!state.approvals?.[lane];

function HumanMessage({ ev, ctx }: { ev: Ev<"instruction"> | Ev<"suggestion">; ctx: Ctx }) {
  const { me, state, delivered, send } = ctx;
  const [ask, confirmUI] = useConfirm();
  const b = ev.body;
  // Before any early return, as a hook must be; what it offers is what this message allows when it opens (can, below).
  const can = useRef<() => MessageActions>(() => ({}));
  const menu = useMessageMenu(b.text, () => can.current());
  // A long message (a pasted log, a spec) shows its first lines, the rest a press away, as a teammate's bubble does (2026-10-27
  // audit: a 2,000-character wall stood in the chat whole).
  const [whole, setWhole] = useState(false);
  const long = isLongMessage(b.text);
  let receipt = true;
  if (state.options.team) receipt = false;
  let sentTo = "";
  sentTo = useSentTo(ctx.sid, !!state.options.team, ev.lane ?? MAIN_LANE, ev.seq);
  // Whom a message still waiting for its turn waits for, where it is shown in the conversation rather than the queue: null, it is
  // in the queue over the box instead. Cast, not annotated: where nothing sets it (the public edition) an annotated null narrows
  // to never.
  let queuedNames = null as string[] | null;
  /** Whether another copy of it (a message sent to several, each a copy on its lane) has been picked up. */
  let copySeen = false;
  /** Why it waits, when the agent isn't only busy (its tool offline, out of usage). */
  let waitWhy = null as string | null;
  // In the Team room, which shows no queues, a message waiting for a busy teammate stays where it was said, saying whom it waits
  // for: each copy of a message to several is queued or picked up on its own lane, and a lane since taken out of the room
  // counts for nothing (Teammates.tsx useSendCopies; 2026-10-27 audit).
  const copies = useSendCopies(ctx.sid, !!state.options.team, ev.lane ?? MAIN_LANE, ev.seq);
  if (copies) (queuedNames = queuedFor(copies, (l) => stillPending(state, l, delivered), (l) => agentNameFor(state, l))), (copySeen = copies.some((c) => delivered.has(c.seq)));
  waitWhy = queuedNames?.length ? queueWhyAll((copies ?? []).filter((c) => stillPending(state, c.lane, delivered).includes(c.seq)).map((c) => c.lane)) : state.options.team ? queueWhy(ev.lane ?? MAIN_LANE) : null;
  // A check-in asked of a teammate (teammates.ts) is a line, not a message from the person.
  if (state.options.team && b.type === "instruction" && isCheckIn(b.text)) return <CheckInLine text={b.text} lane={ev.lane ?? MAIN_LANE} stamp={<Stamp ev={ev} />} />;
  if (state.options.team && b.type === "instruction" && b.text.startsWith("[Friday] ")) return <FridayLine text={b.text} lane={ev.lane ?? MAIN_LANE} stamp={<Stamp ev={ev} />} />;
  let shown: ReactNode = b.text;
  // In a team, each @Name in what was sent stays its teammate's pill (Arun, 2026-10-27: "make sure the tag is still there").
  if (state.options.team) shown = <MentionText sid={ctx.sid} text={b.text} />;
  if (b.type === "instruction" && b.handoff) {
    const h = b.handoff;
    const status = pendingFor(state, ev.lane ?? MAIN_LANE).includes(ev.seq) ? "queued" : delivered.has(ev.seq) ? `${h.toName} picked this up` : "";
    // Between teammates, one centred line that opens (Arun, 2026-10-29: "so clean and beautiful…"; DIRECTION.md §9.1).
    if (state.options.team) return <HandoffLine from={h.fromName} to={h.toName} fromLane={laneIdByName(state, h.fromName)} toLane={laneIdByName(state, h.toName)} task={handoffTaskText(b.text)} reason={h.reason} carried={h.carried} status={status === "queued" ? "Waiting for its turn" : status} stamp={<Stamp ev={ev} />} />;
    return (
      <div className="rsp-ho-wrap">
        <HandoffCard from={h.fromName} to={h.toName} fromLook={agentLook(state, laneIdByName(state, h.fromName))} toLook={agentLook(state, laneIdByName(state, h.toName))} reason={h.reason} carried={h.carried} task={handoffTaskText(b.text)} by={ev.actor.kind === "human" ? (ev.actor.id === me.id ? "you" : ev.actor.name) : undefined} />
        <div className="rsp-ho-meta">
          <span>handoff</span>
          {status && <span>{status}</span>}
          <Stamp ev={ev} />
        </div>
      </div>
    );
  }
  const mine = ev.actor.id === me.id;
  const isSuggestion = b.type === "suggestion";
  /** Whom it was said to, over it. */
  let toWhom = "to agent";
  // In a team, by name: "You to agent" over a message to Kit (2026-10-27 audit).
  if (state.options.team) toWhom = `to ${sentTo || agentNameFor(state, ev.lane ?? MAIN_LANE)}`;
  const atts = b.attachments ?? [];
  // Whose lane this was said to: its driver, its queue. The main lane's are only the main lane's.
  const said = ev.lane ?? MAIN_LANE;
  // A message waiting its turn lives in the queue under the feed, where it can be edited or sent now; it joins the conversation
  // when the agent reads it. Shown in both, it read as said twice.
  if (b.type === "instruction" && queuedNames === null && queueHolds(state, said) && stillPending(state, said, delivered).includes(ev.seq)) return null;
  const laneDriver = driverOf(state, said);
  const driving = laneDriver?.id === me.id;
  let footer: ReactNode = null;
  // Asked first, and the fork opened once made: one press beside Copy started a session with every agent in it, said nothing and
  // stayed here (Arun, 2026-10-28: "iron everything and ensure we are good… any logic errors and fixes").
  const tools = [...new Set(Object.values(state.engines).flatMap((e) => (e.tool ? [ENGINE_NAMES[e.tool]] : [])))];
  const fork = () =>
    ask({
      title: "Fork a new session from here?",
      body: `A new session of your own starts with this conversation up to this message${tools.length ? `, and ${tools.join(" and ")} ${tools.length === 1 ? "joins" : "join"} it in the same folder` : ""}. This one stays as it is.`,
      action: "Fork",
      // Nothing is lost by a fork: a fork's mark and an ordinary button, not a trash can and a red one (Arun, 2026-10-28: "iron
      // everything and ensure we are good").
      danger: false,
      icon: "gitFork",
      onConfirm: () => void forkSession(ctx.sid, ctx.invite, ev.seq).then((e) => e && ctx.notify(e)),
    });
  let forks = true;
  // A team's message is never the start of a new coding session: no Fork on it (Arun, 2026-10-28: the critique's "no 'Fork a new
  // session' on team messages").
  if (state.options.team) forks = false;
  can.current = () => ({ ...(forks ? { fork } : {}), again: () => prefillComposer(b.text), ...(mayRewind ? { rewind } : {}) });

  // Going back to before this message: its files, and the agent's memory of what followed. Only where there is a checkpoint to go to,
  // only while nothing is running, and only for who can undo. A coding tool keeps its own conversation, which Friday can't wind back:
  // there it is the files only, said so, and the log keeps everything after (Claude Code, Zed and Factory restore code alone too).
  const checkpoint = b.type === "instruction" && !b.text.startsWith("[session]") ? ctx.checkpoints.get(ev.seq) : undefined;
  const anyRunning = state.run.status === "running" || Object.values(state.laneRuns).some((r) => r.status === "running");
  const mayRewind = !!checkpoint && (me.role === "owner" || driving) && !anyRunning && !isSetAside(ctx.rewinds, ev.seq, said);
  const tool = state.engines[said]?.tool;
  const rewind = () => {
    if (tool)
      return ask({
        title: "Put the files back to before this message?",
        body: `The files go back to how they were before this was acted on. ${ENGINE_NAMES[tool]} keeps its own conversation, so it still remembers what came after; the message goes back into the box so you can tell it what changed.`,
        action: "Restore the files",
        danger: true,
        onConfirm: async () => {
          const r = await send({ type: "folder.restore", sha: checkpoint!, lane: said, rewindTo: ev.seq });
          if (!r.ok) return ctx.notify(r.error ?? "Couldn't restore. The folder may have moved on since; check the Diff tab, then try again.");
          if (b.type === "instruction") prefillComposer(b.text);
        },
      });
    const n = rewindImpact(ctx.events, ev.seq);
    const parts = [n.runs ? `${n.runs} run${n.runs === 1 ? "" : "s"}` : "", n.messages > 1 ? `${n.messages} messages` : "", n.files ? `${n.files} file${n.files === 1 ? "" : "s"} the agent changed` : ""].filter(Boolean);
    ask({
      title: "Rewind to before this message?",
      body: `The files go back to how they were before this was acted on, and the agent forgets everything after it${parts.length ? ` (${parts.join(", ")})` : ""}. The log keeps all of it, and you can fork a new chat from any message first to keep a copy. The message goes back into the box so you can change it and send it again.`,
      action: "Rewind to here",
      danger: true,
      onConfirm: async () => {
        const r = await send({ type: "folder.restore", sha: checkpoint!, lane: said, rewindTo: ev.seq });
        if (!r.ok) return ctx.notify(r.error ?? "Couldn't rewind. The folder may have moved on since; check the Diff tab, then try again.");
        if (b.type === "instruction") prefillComposer(b.text);
      },
    });
  };

  if (b.type === "instruction") {
    const status = queuedNames?.length || stillPending(state, said, delivered).includes(ev.seq) ? "queued" : delivered.has(ev.seq) || copySeen ? "seen" : state.withdrawn.includes(ev.seq) ? "withdrawn" : "dropped";
    const queuedText = waitWhy ? `Queued ${waitWhy}` : queuedNames?.length ? `Queued for ${queuedNames.length > 1 ? `${queuedNames.slice(0, -1).join(", ")} and ${queuedNames.at(-1)}` : queuedNames[0]}` : null;
    const fromName = b.fromSuggestion !== undefined ? state.suggestions.find((s) => s.seq === b.fromSuggestion)?.from.name : undefined;
    footer = (
      <div className={cn("delivery", status, mine && "justify-end")}>
        {status === "queued" && (
          <>
            <span className="pulse-dot" /> {queuedText ?? (state.engines[said]?.tool && !state.engines[said]!.online ? `Queued until ${ENGINE_NAMES[state.engines[said]!.tool!]} reconnects` : "Queued for the agent's next step")}
            {/* Still waiting, in a team chat: change it or take it back before it is read (Arun, 2026-10-28: the critique's "queued messages get Edit and Cancel"). */}
            {state.options.team && mine && <QueuedActions seqs={(copies ?? [{ lane: said, seq: ev.seq }]).filter((c) => stillPending(state, c.lane, delivered).includes(c.seq))} send={send} onEdit={() => prefillComposer(b.text)} />}
          </>
        )}
        {status === "seen" && receipt && (
          <>
            <CheckIcon className="size-3" /> Agent picked this up
          </>
        )}
        {status === "withdrawn" && "Taken back before the agent read it"}
        {status === "dropped" && "Not delivered: the run was cancelled first"}
        {fromName && <span className="muted"> · adopted from {fromName}'s suggestion</span>}
      </div>
    );
  } else {
    const sug = state.suggestions.find((s) => s.seq === ev.seq);
    footer = (
      <div className={cn("delivery", mine && "justify-end")}>
        {sug?.promoted ? (
          <>
            <CheckIcon className="size-3" /> Sent to the agent by the driver
          </>
        ) : driving ? (
          <button className="link-btn" onClick={() => send({ type: "promote", seq: ev.seq })}>
            Send to agent
          </button>
        ) : (
          `Waiting for ${laneDriver ? (laneDriver.id === me.id ? "you" : laneDriver.name) : "someone to take control"}`
        )}
      </div>
    );
  }

  return (
    <Message from="user" className={cn(!mine && "human-other ml-0 mr-auto items-start")} onContextMenu={menu.onContextMenu}>
      {confirmUI}
      {menu.menu}
      <div className={cn("msg-meta", mine && "justify-end mine")}>
        {!mine && <Avatar name={ev.actor.name} id={ev.actor.id} size={22} />}
        <Who actor={ev.actor} mine={mine} />
        <span>{isSuggestion ? "suggested a redirect" : toWhom}</span>
        {b.type === "instruction" && b.interrupt && (
          <span className="tag warn">
            <ZapIcon className="size-3" /> interrupt
          </span>
        )}
        <Stamp ev={ev} />
      </div>
      {sentTo && <div className={cn("tm-sent-to", mine && "mine")}>To {sentTo}</div>}
      <AttachmentList atts={atts} ctx={ctx} align={mine ? "end" : "start"} />
      {b.text && (
        <MessageContent
          className={cn(
            "msg-bubble whitespace-pre-wrap",
            !mine && "group-[.is-user]:ml-0",
            isSuggestion && "group-[.is-user]:border group-[.is-user]:border-dashed group-[.is-user]:border-input group-[.is-user]:bg-transparent",
          )}
        >
          {long && !whole ? <div className="msg-clamp">{shown}</div> : shown}
          {long && (
            <button type="button" className="msg-more" aria-expanded={whole} onClick={() => setWhole(!whole)}>
              {whole ? "Show less" : "Show more"}
            </button>
          )}
        </MessageContent>
      )}
      {b.text && <CopyMessage text={b.text} mine={mine} {...(forks ? { fork } : {})} {...(mayRewind ? { rewind } : {})} />}
      {footer}
    </Message>
  );
}

/**
 * Who said it: you, or them by name; or the agent outside Friday that sent it for someone (outside-agents.ts), by its name, so a
 * session Claude Code started says Claude Code started it (Arun, 2026-10-30).
 */
function Who({ actor, mine }: { actor: SessionEvent["actor"]; mine: boolean }) {
  if (!actor.via) return <span className="who">{mine ? "You" : actor.name}</span>;
  return (
    <>
      <span className="who">{mine ? actor.via : `${actor.via} for ${actor.name}`}</span>
      <span className="tag" title={`Sent by ${actor.via} through Friday's MCP server, on ${mine ? "your" : `${actor.name}'s`} behalf`}>
        outside agent
      </span>
    </>
  );
}

/** A message long enough to fold to its first lines: over 600 characters, or more than 10 lines. */
export const isLongMessage = (text: string): boolean => text.length > 600 || text.split("\n").length > 10;

/**
 * An aside: something said to the people here, which no agent reads. Drawn as people talking, a thread apart from the work, with
 * "to the people here" where a message to an agent says "to agent"; a line that names you stands out.
 */
function ChatMessage({ ev, ctx }: { ev: Ev<"chat">; ctx: Ctx }) {
  const { me } = ctx;
  const mine = ev.actor.id === me.id;
  const forMe = !mine && (ev.body.mentions ?? []).includes(me.id);
  const menu = useMessageMenu(ev.body.text);
  return (
    <Message from="user" className={cn("chat-aside", !mine && "human-other ml-0 mr-auto items-start")} onContextMenu={menu.onContextMenu}>
      {menu.menu}
      <div className={cn("msg-meta", mine && "justify-end mine")}>
        {!mine && <Avatar name={ev.actor.name} id={ev.actor.id} size={22} />}
        <Who actor={ev.actor} mine={mine} />
        <span>to the people here</span>
        {forMe && <span className="tag chat-you">mentioned you</span>}
        <Stamp ev={ev} />
      </div>
      <MessageContent className={cn("msg-bubble whitespace-pre-wrap chat-bubble", !mine && "group-[.is-user]:ml-0", forMe && "chat-for-me")}>{ev.body.text}</MessageContent>
      <CopyMessage text={ev.body.text} mine={mine} />
    </Message>
  );
}

/**
 * A right-click on something a person said: the same things its buttons under it do, and a couple more (Arun, 2026-10-24:
 * "also be able to right click on the input chats too"). Words selected in it can be copied on their own.
 */
type MessageActions = { fork?: () => void; rewind?: () => void; /** Put the words back in the message box, to change and send again. */ again?: () => void };
function useMessageMenu(text: string, actions: () => MessageActions = () => ({})) {
  const [at, setAt] = useState<{ x: number; y: number; picked: string; can: MessageActions } | null>(null);
  const copy = (t: string) => void navigator.clipboard.writeText(t).catch(() => {});
  const onContextMenu = (e: React.MouseEvent) => {
    if (!text) return;
    e.preventDefault();
    const sel = window.getSelection();
    const picked = sel && !sel.isCollapsed && e.currentTarget.contains(sel.anchorNode) ? sel.toString().trim() : "";
    setAt({ x: e.clientX, y: e.clientY, picked, can: actions() });
  };
  const menu = at && (
    <ContextMenu
      at={at}
      compact
      onClose={() => setAt(null)}
      items={() => [
        !!at.picked && { label: "Copy selection", icon: "copy" as const, onSelect: () => copy(at.picked) },
        { label: "Copy message", icon: "copy" as const, onSelect: () => copy(text) },
        at.can.again && { label: "Edit and send again", icon: "pencil" as const, sub: "Puts it back in the message box", onSelect: at.can.again },
        at.can.fork && { label: "Fork a new session from here", icon: "gitFork" as const, onSelect: at.can.fork },
        at.can.rewind && { label: "Rewind to before this message", icon: "rewind" as const, danger: true, onSelect: at.can.rewind },
      ]}
    />
  );
  return { onContextMenu, menu };
}

/** Copy what was said, from under the message it belongs to. */
function CopyMessage({ text, mine, fork, rewind }: { text: string; mine: boolean; fork?: () => void; rewind?: () => void }) {
  const [done, setDone] = useState(false);
  return (
    <div className={cn("msg-actions", mine && "mine")}>
      <button
        type="button"
        className="icon-btn tiny msg-copy"
        title={done ? "Copied" : "Copy message"}
        aria-label={done ? "Message copied" : "Copy message"}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          } catch {
            // Clipboard refused; nothing else to do.
          }
        }}
      >
        <Icon name={done ? "check" : "copy"} size={14} />
      </button>
      {fork && (
        <button type="button" className="icon-btn tiny msg-copy" title="Fork a new session from here" aria-label="Fork a new session from this message" onClick={fork}>
          <Icon name="gitFork" size={14} />
        </button>
      )}
      {rewind && (
        <button type="button" className="icon-btn tiny msg-copy" title="Rewind to before this message" aria-label="Rewind to before this message" onClick={rewind}>
          <Icon name="rewind" size={14} />
        </button>
      )}
    </div>
  );
}

// ── agent runs ────────────────────────────────────────────────────────

function reasoningText(details: unknown[] | undefined): string {
  return (details ?? [])
    .map((d) => {
      const r = d as { text?: string; summary?: string };
      return r.text ?? r.summary ?? "";
    })
    .join("")
    .trim();
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function describeTool(call: ToolCall, args: Record<string, unknown>, question?: Ev<"agent.question">): { icon: LucideIcon; title: string; detail?: string } {
  const s = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
  switch (call.name) {
    case "write_section":
      return { icon: PencilIcon, title: "Updated section", detail: s("title") || s("section_id") };
    case "delete_section":
      return { icon: Trash2Icon, title: "Deleted section", detail: s("section_id") };
    case "remember":
      return { icon: PencilIcon, title: "Noted for later", detail: s("note") };
    case "web_search":
      return { icon: GlobeIcon, title: "Searched the web", detail: s("query") };
    // Coding agents' tools, as the runner names them for every CLI.
    case "shell":
      return { icon: TerminalIcon, title: "Ran a command", detail: s("command") };
    case "edit":
      return { icon: FilePenIcon, title: "Edited", detail: s("path") };
    case "write":
      return { icon: FilePenIcon, title: "Wrote", detail: s("path") };
    case "read":
      return { icon: FileTextIcon, title: "Read", detail: s("path") };
    case "search":
      return { icon: SearchIcon, title: "Searched the code", detail: s("pattern") };
    case "web_fetch":
      return { icon: GlobeIcon, title: "Opened a page", detail: s("url") };
    case "todo":
      return { icon: ListChecksIcon, title: "Updated its plan" };
    case "ask_human":
      return { icon: CircleHelpIcon, title: `Asked ${question?.body.toName ?? "the driver"} for a decision`, detail: s("question") };
    case "run_background":
      return { icon: TerminalIcon, title: "Started in the background", detail: s("command") };
    case "read_background":
      return { icon: TerminalIcon, title: "Checked a background command", detail: s("id") };
    case "stop_background":
      return { icon: TerminalIcon, title: "Stopped a background command", detail: s("id") };
    default: {
      const first = Object.values(args).find((v) => typeof v === "string") as string | undefined;
      if (call.name.startsWith("mcp__")) {
        const [, server, tool] = call.name.split("__");
        return { icon: PlugIcon, title: `${server} · ${tool}`, detail: first };
      }
      return { icon: WrenchIcon, title: call.name, detail: first };
    }
  }
}

/**
 * A plan, from whichever agent wrote it.
 *
 * A CLI writes `todo` with `todos`; Friday Code writes `update_plan` with
 * `steps`. Same idea, same block — the room shouldn't have to know which agent
 * it is watching to read how much is left.
 */
export function planSteps(args: Record<string, unknown>, live: boolean): ProgressStep[] {
  const raw = Array.isArray(args.steps) ? args.steps : Array.isArray(args.todos) ? args.todos : Array.isArray(args.items) ? args.items : [];
  return raw.slice(0, 20).flatMap((t: unknown, i: number) => {
    const o = (t ?? {}) as { content?: unknown; title?: unknown; status?: unknown };
    const title = typeof o.content === "string" ? o.content : typeof o.title === "string" ? o.title : "";
    if (!title) return [];
    const s = String(o.status ?? "pending");
    const done = s === "completed" || s === "done";
    const running = s === "in_progress" || s === "in-progress";
    // A finished run has nothing in progress. Leaving a spinner on the step it
    // died on would be the UI insisting work is happening when it stopped.
    const status: ProgressStatus = done ? "completed" : s === "cancelled" ? "cancelled" : running && live ? "active" : "pending";
    return [{ id: `${i}-${title.slice(0, 24)}`, title, status }];
  });
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};

/**
 * Whether a run's diff says anything. A diff with no files, or files with nothing added or taken out, is a run that
 * changed nothing, and a card asking you to review "0 files +0 −0" is a card with nothing to decide.
 */
function didChange(files: DiffFile[] | undefined): files is DiffFile[] {
  return !!files?.some((f) => f.additions > 0 || f.deletions > 0 || f.status !== "modified");
}

/** A command that checks the work: what "still failing" means to whoever takes it over. */
const CHECK = /\b(test|tests|pytest|jest|vitest|mocha|tsc|lint|eslint|ruff|mypy|build|cargo|go (test|vet|build)|make|gradle|mvn|dotnet|npm run|pnpm|yarn|bun run|check)\b/i;

/**
 * What one lane's agent is writing right now. The only part of the feed that redraws for each word: it listens to its own
 * lane's stream, so neither the run block around it, nor any other row or lane, redraws while the words arrive.
 */
export function LiveStream({ sid, lane }: { sid: string; lane: string }) {
  const s = useLaneStream(sid, lane);
  if (s?.reasoning && !s.text) return <ThinkingView text={s.reasoning} live />;
  return s?.text ? <LiveAnswer text={s.text} /> : null;
}

/** Finished pieces of a streaming answer: drawn once each, and not looked at again while the rest arrives. */
const Finished = memo(function Finished({ done }: { done: string[] }) {
  return done.map((piece, i) => (
    // The gap Streamdown puts between its blocks, between one piece and the next.
    <MessageResponse key={i} {...LIVE} className={i ? "mt-4" : undefined}>
      {piece}
    </MessageResponse>
  ));
});

/**
 * A streaming answer, drawn as its finished pieces and the part still being written: each frame reads only that last part.
 * The pieces are cut where Streamdown's own blocks end, so it draws as the whole text would, and the logged message that
 * replaces it draws the same.
 */
function LiveAnswer({ text }: { text: string }) {
  const [split] = useState(streamSplitter);
  const { done, tail } = split(text);
  return (
    <StreamingResponse status="streaming" contentClassName="rsp-answer">
      <Finished done={done} />
      {tail && (
        <MessageResponse {...LIVE} className={done.length ? "mt-4" : undefined}>
          {tail}
        </MessageResponse>
      )}
    </StreamingResponse>
  );
}

const RunBlock = memo(function RunBlock({ item, ctx, active, latest, typing, folded = false }: { item: RunItem; ctx: Ctx; active: boolean; latest: boolean; /** Null when the run isn't streaming. The words themselves are drawn by LiveStream, so this block doesn't redraw for each one. */ typing: Typing | null; /** An older finished run: one line until it is opened. */ folded?: boolean }) {
  const [unfolded, setUnfolded] = useState(false);
  /** The reason box under the answer, open after a thumb down. */
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  /** Who this run's work is being handed to, once one of the agents in the bar is picked. */
  const [handTo, setHandTo] = useState<string | null>(null);
  /** Somebody being brought in to take the work: it is offered the work the moment its lane appears. */
  const [adding, setAdding] = useState<{ agentId: string } | { tool: EngineTool } | null>(null);
  // A coding agent being brought in with nothing to fill in, until its lane shows up.
  const [bringing, setBringing] = useState<EngineTool | null>(null);
  /** What the bring-in is doing, when it is something slow enough to say (a clone). */
  const [bringLine, setBringLine] = useState<string | null>(null);
  // The coding tools' limits and what runs here have shown: who to suggest when this tool is out of usage (see `onward`).
  // Not on a recording: the viewer has no computer and no workspace, and both asks were 401s (Testing PERFORMANCE.md finding 6).
  const toolLimits = useToolLimits(ctx.identity, ctx.replaying);
  const learned = useLearned(ctx.identity, ctx.replaying);
  const [ask, confirmUI] = useConfirm();
  // The run just ended in front of this person: its verdict, answer and review arrive in order rather than all at once.
  // Only on the transition, so history and reloads draw instantly.
  const wasActive = useRef(active);
  const [landed, setLanded] = useState(false);
  useEffect(() => {
    const was = wasActive.current;
    wasActive.current = active;
    if (!was || active || !item.ended) return;
    setLanded(true);
    const t = setTimeout(() => setLanded(false), 2200);
    return () => clearTimeout(t);
  }, [active, item.ended]);
  const before = useRef<Set<string>>(new Set());
  // Coding agents on their way in from this page, whose lanes are there before their runners are.
  const startingNow = useStarting(ctx.sid);
  // Once the agent that was being brought in has a lane, the work is offered to it: a coding agent's from the moment its lane
  // is made, since what it is given waits there for its runner.
  useEffect(() => {
    if (!adding) return;
    const fresh = ctx.state.lanes.find(
      (l) => !before.current.has(l.id) && ("agentId" in adding ? l.agent?.id === adding.agentId : ctx.state.engines[l.id]?.tool === adding.tool || startingNow.some((s) => s.tool === adding.tool && s.lane === l.id)),
    );
    if (fresh) {
      setHandTo(fresh.id);
      setAdding(null);
      setBringing(null);
    }
    // On every event: the state is changed in place, so an engine attaching after its lane changes nothing a dependency would see.
  }, [adding, ctx.events, startingNow]);
  const msgs = item.messages;
  // The block's own lane, not its first message's: a run that has said nothing yet (Codex thinking) has none, and fell back
  // to the main lane, so Codex's column said "Claude Code · Thinking" and offered Claude Code's review and hand-off.
  const lane = item.lane;
  const last = msgs.at(-1);
  const finalMsg = last && !last.body.toolCalls.length && last.body.text && !typing ? last : null;
  // The tool's own "Not logged in · Please run /login" on a run that ended signed out: SignedOutNote says it once, plainly.
  const loginLine = item.ended?.body.outcome === "error" && signedOut(item.ended.body.error) && finalMsg && /not logged in|please run \/login/i.test(finalMsg.body.text) ? finalMsg : null;
  // Second opinion (Asides): another model asked about this turn, from the answer's strip; the form opens under the answer.
  const [opinion, setOpinion] = useState(false);
  // Who wrote each line of the change by hand, read from the lane's log once the run has ended (attribution.ts).
  const attribution = useMemo(() => (item.ended ? attributionFor(ctx.events, lane) : undefined), [ctx.events.length, item.ended, lane]); // eslint-disable-line react-hooks/exhaustive-deps
  // Asked of one of Friday's own models: the hosted Friday's, so none in the open-source edition.
  let opinionBtn: React.ReactNode = null;
  // What the run left that has a home of its own.
  // The file chips are the same fact as the diff card, so they wait for the same moment.
  const changed: FileChange[] = item.ended ? (item.diffs.at(-1)?.body.files ?? []).map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })) : [];
  // Commands still failing when the run stopped; one that failed and then passed is not one.
  const stillFailing = item.ended ? failingCommands(msgs, ctx.results) : [];
  const via = reviewVia(ctx.state, ctx.me, lane);
  const tests = item.ended ? testsIn(msgs.flatMap((m) => m.body.toolCalls), (id) => (ctx.results.has(id) ? commandFailed(ctx.results.get(id)!.body) : null)) : null;

  // A teammate speaks as its face (Teammates.tsx), not its tool's mark.
  let mate: React.ReactNode = null;
  let look = null as { className: string; style: React.CSSProperties } | null;
  if (ctx.state.options.team) mate = teammateMark(lane, 18)?.mark ?? null;
  // In a team a reply reads as a group chat (Teammates.tsx): its mascot, moving while it works, its name in its colour, bubbles.
  if (ctx.state.options.team) [mate, look] = teamReply(lane, active, mate);
  // An older run: the facts that decide whether to open it, on one line. Before the steps, the receipt and the hand-off are
  // worked out, since none of them are shown: a long session is mostly folded runs.
  if (folded && !unfolded) {
    const line = foldLine({ changed: changed.length, tests: tests?.status ?? null, failed: stillFailing.length, ms: item.ended && item.startedTs ? item.ended.ts - item.startedTs : 0, answer: finalMsg?.body.text });
    return (
      <div className="rsp">
        {confirmUI}
        <button type="button" className="rsp-folded" title="Show this run" onClick={() => setUnfolded(true)}>
          <span className="rsp-avatar" aria-hidden>
            {mate ?? (ctx.state.engines[lane]?.tool ? <EngineMark tool={ctx.state.engines[lane]!.tool!} size={15} /> : <Mascot mood={runMood({ active, outcome: item.ended?.body.outcome, failing: stillFailing.length })} size={26} still />)}
          </span>
          <span className="rsp-who">{agentNameFor(ctx.state, lane)}</span>
          <span className="rsp-folded-line">{line}</span>
          <Icon name="chevronRight" size={12} />
        </button>
      </div>
    );
  }
  // The evidence under the run: the receipt, the diff explained in three sentences, and one word on "done".
  const lastFiles = item.ended ? item.diffs.at(-1)?.body.files : undefined;
  const receipt =
    lastFiles && didChange(lastFiles)
      ? receiptOf({ calls: msgs.flatMap((m) => m.body.toolCalls), failed: (id) => (ctx.results.has(id) ? commandFailed(ctx.results.get(id)!.body) : null), files: lastFiles, answer: finalMsg?.body.text })
      : null;
  const explained = receipt && lastFiles ? explainRun({ files: lastFiles, ...(item.ask ? { ask: item.ask } : {}), ...(item.earlier ? { earlier: item.earlier } : {}), decided: item.decided, flags: receipt.flags, tests: receipt.tests }) : [];
  // A run that changed nothing shows the change set still waiting from before, and says so first.
  const explain = item.unchanged && explained.length ? ["This run changed nothing; these are the changes still waiting from earlier.", ...explained] : explained;
  const verdict =
    item.ended &&
    !ctx.state.options.work && // A Work session has no tests to have run: "Done · unverified" said nothing (Arun, 2026-10-26).
    !active
      ? doneVerdict(changed.length, tests?.status ?? null)
      : null;
  // The pages the run looked at, with their titles where the search gave them: the reply's Sources (citations).
  const sources = new Map<string, string | undefined>();

  /**
   * The run in reading order.
   *
   * What the agent thought and said stays in the open, because that is what
   * people are reading. The tool calls are evidence, so they fold into one
   * timeline — a line per step, a verb and what it touched.
   */
  const steps: Step[] = [];
  type Work = { kind: "work"; id: string; thought: string; secs: number; steps: Step[] };
  type Say = { kind: "say"; key: string; note: string };
  /** Subagents it sent off, as one card where it sent them (Subagents.tsx), not as steps among its reads and commands. */
  type Subs = { kind: "subs"; key: string; rows: SubagentRow[] };
  const blocks: (Work | Say | Subs)[] = [];
  // The tool's own record of each subagent this run started: where it stands, what kind it is, what it came back with.
  // Up to its end, or to what closed it: a block cut short without an end (a restart) claimed every later subagent as its own.
  const runEnd = item.ended?.seq ?? item.closedSeq ?? Infinity;
  // Only what this run was seen sending off: a report on something already over when it first appears is left over from the
  // tool's last session (SubTask.opened), not this run's.
  // A block still waiting for its first message ("Thinking") has a stand-in key below zero, which every subagent in the session
  // is past: it showed the session's one old subagent under every new prompt (Arun, 2026-10-24: "still appearing from before").
  // A subagent is sent off by a message, so before one there is none.
  // Background ones too: a subagent sent off to run in the background answers its call at once ("started"), and without its
  // own record to go by its row read that as done while it was still working (Arun, 2026-10-24: "make sure their status
  // updates real time based on the task status").
  const tasks = item.key < 0 ? [] : subTasksIn(ctx.events).filter((t) => t.opened && t.lane === lane && t.agentType !== "command" && t.seq >= item.key && t.seq <= runEnd);
  const claimed = new Set<string>();
  const rowFor = (id: string, args: Record<string, unknown>): SubagentRow => {
    const said = typeof args.description === "string" ? args.description : typeof args.prompt === "string" ? args.prompt.split("\n")[0]! : "";
    // Cursor's subagent has the call's id; Claude Code's has a task id of its own, so it is the one sent off with the same words.
    const t = tasks.find((x) => !claimed.has(x.key) && x.id === id) ?? tasks.find((x) => !claimed.has(x.key) && x.description === said);
    if (t) claimed.add(t.key);
    const result = ctx.results.get(id);
    let type = t?.agentType ?? (typeof args.subagent_type === "string" ? args.subagent_type : undefined);
    // Work says what a subagent was sent to do, not its tool's name for its kind ("Explore", "code-reviewer").
    if (ctx.state.options.work) type = undefined;
    return {
      key: t?.key ?? id,
      description: t?.description || said || "Subagent",
      ...(type && type !== "general-purpose" ? { agentType: type } : {}),
      // Sent to the background, its call's answer only says it started: working until its own record says otherwise.
      state: t ? subagentState(t) : result && args.run_in_background !== true ? (result.body.isError ? "blocked" : "done") : active ? "working" : "open",
      ...(t ? { start: t.start, ...(t.end ? { end: t.end } : {}) } : {}),
      ...(t?.summary ? { summary: t.summary } : {}),
      ...(t?.doing ? { doing: t.doing } : {}),
      ...(t?.steps ? { steps: t.steps } : {}),
    };
  };
  // The reasoning and the tool calls it led to fold together behind one
  // chevron — they are the working-out, not the answer. What the model
  // actually says stays outside and plain, because that is what people came
  // to read. A "say" closes whatever work was open, so the next reasoning or
  // tool call starts a fresh fold rather than joining one that already ended.
  let work: Work | null = null;
  msgs.forEach((m, i) => {
    const b = m.body;
    const thought = reasoningText(b.reasoning);
    const note = b.text && m !== finalMsg && m !== loginLine ? b.text : "";
    if (thought) {
      if (!work) {
        work = { kind: "work", id: `${m.seq}-work`, thought: "", secs: 0, steps: [] };
        blocks.push(work);
      }
      const since = i > 0 ? msgs[i - 1]!.ts : item.startedTs;
      work.thought = work.thought ? `${work.thought}\n\n${thought}` : thought;
      work.secs += since ? Math.round((m.ts - since) / 1000) : 0;
    }
    for (const call of b.toolCalls) {
      const args = argsOf(call);
      if (SUBAGENT_CALL.test(call.name)) {
        const prev = blocks.at(-1);
        const row = rowFor(call.id, args);
        if (prev?.kind === "subs") prev.rows.push(row);
        else blocks.push({ kind: "subs", key: `${call.id}-subs`, rows: [row] });
        work = null;
        continue;
      }
      const result = ctx.results.get(call.id);
      const verdict = result ? commandFailed(result.body) : undefined;
      const failed = !!result && (verdict === true || !!result.body.interrupted);
      if (call.name === "web_search" && result && !failed) for (const w of webSourcesIn(result.body.output)) if (!sources.get(w.url)) sources.set(w.url, w.title);
      // A page it opened and read is a source as well.
      const read = (call.name === "web_fetch" || call.name === "fetch_url") && result && !failed && typeof args.url === "string" ? webUrl(args.url) : null;
      if (read && !sources.has(read)) sources.set(read, undefined);
      const d = stepFor(call, args, ctx.questions.get(call.id)?.body.toName);
      const output = result?.body.output ?? "";
      const step: Step = {
        id: call.id,
        ...d,
        state: !result ? (active ? "running" : "waiting") : verdict === null ? "waiting" : failed ? "failed" : "done",
        detail: result ? <pre className="rsp-output">{output.length > 6000 ? `${output.slice(0, 6000)}\n…` : output || "(no output)"}</pre> : undefined,
        raise: <StepRaise ctx={ctx} lane={lane} call={call.id} step={`${d.verb}${d.target ? ` ${d.target}` : ""}`} via={via} />,
      };
      if (result && stepKind(d) === "test") step.fails = failingTests(output);
      if (/^(edit|edit_file|write|write_file)$/.test(call.name)) step.preview = editPreview(args) ?? undefined;
      step.onAsk = () => prefillComposer(`Explain why you ${d.verb.toLowerCase()}${d.target ? ` ${d.target}` : ""} in your last run, in two or three sentences. Don't change anything.`);
      steps.push(step);
      if (!work) {
        work = { kind: "work", id: `${m.seq}-work`, thought: "", secs: 0, steps: [] };
        blocks.push(work);
      }
      work.steps.push(step);
      if (work.thought) step.thought = work.thought;
    }
    if (note) {
      work = null;
      blocks.push({ kind: "say", key: `${m.seq}-say`, note });
    }
  });

  // Subagents with no call in the feed (Codex's, which come only as their own records): a card of their own after the work.
  // Not a background one of Claude Code's whose call isn't in this block: that is the Tasks panel's, as before.
  const unclaimed = tasks.filter((t) => !claimed.has(t.key) && !t.background);
  if (unclaimed.length)
    blocks.push({
      kind: "subs",
      key: `${item.key}-subs-rest`,
      rows: unclaimed.map((t) => subagentRowOf(t)).map((r) => {
        if (ctx.state.options.work) return { ...r, agentType: undefined };
        return r;
      }),
    });

  const ended = item.ended?.body;
  const name = agentNameFor(ctx.state, lane);
  // Closed by something other than a pause (control handed over, a message queued, a permission card), the run went on in the
  // next block: calling this one "paused" said the agent had stopped while it was still working.
  // A turn that ended on a usage limit ran out of usage, said as the sidebar says it, not "stopped" (2026-10-27 audit).
  // Nor one that wasn't signed in: that is the computer's to fix, not the work stopping on an error (Arun, 2026-10-28: "iron
  // everything and ensure we are good"); both are amber, as out of usage is everywhere else, never red.
  const status = active ? "" : ended?.outcome === "error" ? (limitHit(ended.error) ? "ran out of usage" : signedOut(ended.error) ? "not signed in" : "stopped") : ended?.outcome === "waiting" ? "waiting on a person" : item.ended ? "" : last?.body.interrupted && item.closedBy !== "run.pause" && item.closedBy !== "run.cancel" && item.placeBefore === undefined ? "interrupted" : item.closedBy && item.closedBy !== "run.pause" ? "" : "stopped";
  // Anyone who could write to another agent can hand this one's work to it.
  const others = [MAIN_LANE, ...ctx.state.lanes.map((l) => l.id)].filter((id) => id !== lane && reviewVia(ctx.state, ctx.me, id) === "instruct");
  const carried = [
    ...(finalMsg ? [truncate(finalMsg.body.text.split("\n").find((l) => l.trim()) ?? "", 200)] : []),
    ...(changed.length ? [`Changed ${changed.map((f) => f.path).join(", ")}`] : []),
    // Only checks: a test, a build, a linter. A look around that didn't work ("rg" missing on this shell) read as a failing
    // test to the agent taking over; every command and how it went is in its brief anyway (handoffBrief).
    ...stillFailing.filter((f) => CHECK.test(f.command)).map((f) => `Still failing: ${f.command}`),
  ].filter(Boolean);

  // Out of usage: when it can carry on here, and who else could take it meanwhile (limit-reset.ts). Only the latest run's: an
  // older one's limit has long since been dealt with.
  const hit = ended?.outcome === "error" ? limitHit(ended.error) : null;
  // Not signed in on its computer: one plain line and a way to sign in (SignedOutNote), not the tool's own words and then the runner's.
  const out = ended?.outcome === "error" && !hit && signedOut(ended.error);
  // On another tool already, carried on (a teammate on its backup): no choice of what to do about the limit is left to make.
  let onBackup = false;
  onBackup = !!ctx.state.options.team && !!mateOn(lane)?.switched;
  const limit = latest ? hit : null;
  // What the run left, and so who the work is for.
  const signals: Signals = { changed: changed.map((f) => f.path), tests: tests ? tests.status : null, failing: stillFailing.length, ...(limit ? { limited: true } : {}) };
  const pick = others.length ? suggestTarget(ctx.state, lane, others, signals) : null;
  // A coding agent whose runner is gone (a restart, a dropped connection) takes nothing until it is back.
  const offline = (id: string) => !!ctx.state.engines[id]?.tool && !ctx.state.engines[id]!.online;
  // Mine, and one that has run somewhere: started again on the folder it had, as it is picked, if that folder is on this
  // computer (see onPick below).
  const mayRestart = (id: string) => offline(id) && ctx.state.engines[id]!.hostId === ctx.me.id && !!ctx.state.engines[id]!.cwd;
  const targets: HandoffTarget[] = others
    .map((id) => {
      const run = runOf(ctx.state, id);
      const driver = driverOf(ctx.state, id);
      const working = run.status === "running";
      const auto = wakesOnItsOwn(ctx.state, id, lane);
      const look = agentLook(ctx.state, id);
      return {
        id,
        name: agentNameFor(ctx.state, id),
        mark: look.mark,
        tint: look.tint,
        // Not promised to come back: "mine" is the account, and mine from my other computer can't be started from this one.
        meta: offline(id) ? "offline" : auto ? "wakes on its own" : working ? "working" : driver ? driver.name.split(/\s+/)[0] : "free",
        busy: working,
        auto,
        ...(pick?.id === id ? { suggested: true, why: pick.why } : {}),
      } satisfies HandoffTarget;
    })
    // the suggested one first, the busy and the self-starting after, and the offline last
    .sort((x, y) => Number(!!y.suggested) - Number(!!x.suggested) || Number(offline(x.id)) - Number(offline(y.id)) || Number(!!x.auto) - Number(!!y.auto) || Number(!!x.busy) - Number(!!y.busy));
  // Bringing somebody in: a saved agent (the owner adds lanes), or a coding agent of your own that is not here yet.
  const taken = new Set(ctx.state.lanes.map((l) => l.agent?.id));
  // A saved agent joins as a Friday agent of its own, which Solo doesn't run: offered there, it was refused once pressed.
  const savedAgents = ctx.me.role === "owner" && !ctx.solo ? (ctx.agents ?? []).filter((a) => !taken.has(a.id) && ctx.state.options.agent?.id !== a.id).slice(0, 12) : [];
  // A teammate's agent that went offline doesn't stand in for mine; my own offline one is reconnected from its own row instead.
  const hereTools = new Set(Object.values(ctx.state.engines).filter((e) => e.online || e.hostId === ctx.me.id).map((e) => e.tool));
  // None offered while one is on its way: one comes at a time from here (onTool), and a row that did nothing when pressed
  // was worse than no row.
  // The ones on this computer: a tool that isn't installed has nothing to join with.
  const newTools = ctx.onConnect && ctx.me.role !== "viewer" && !bringing ? splitTools(installedOn(ctx.identity)).here.filter((t) => !hereTools.has(t) && !startingNow.some((s) => s.tool === t)) : [];
  // Out of usage, or nearly (Phase 4): which of those would take the work best, on which model, from how hard it reads, their
  // limits and how runs here have gone (routing.ts). A suggestion: pressing it is still the person's choice.
  const glance = glanceOf(toolLimits);
  const fullest = (t: EngineTool) => {
    const used = glance[t].rows.map((r) => r.used).filter((u): u is number => u !== null);
    return used.length ? Math.max(...used) : null;
  };
  // What tells one tool from the next in the hand-off menu: how much of its limits it has left (2026-10-27 design review: every
  // row said "Joins on this code and takes it from here").
  const roomOf = (t: EngineTool) => {
    const f = fullest(t);
    // Not known: nothing, rather than "Limits not reported" under every row alike (QA, 2026-10-28).
    return f === null ? "" : f >= 100 ? "Out of usage for now" : `${Math.round(100 - f)}% of its limits left`;
  };
  const laneTool = ctx.state.engines[lane]?.tool;
  const nearly = !!laneTool && latest && (fullest(laneTool) ?? 0) >= 90;
  const onward =
    (limit || nearly) && newTools.length
      ? (() => {
          const { tier, why } = taskTier(item.ask?.text ?? "");
          const top = rankTools(tier, newTools.map((t) => ({ tool: t, ready: true, fullest: fullest(t), windows: glance[t].rows.map((r) => ({ kind: r.label, label: r.label, usedPercent: r.used })) })), why, learned)[0];
          if (!top || top.out) return null;
          const model = top.model ? (ENGINE_MODEL_INFO[top.tool].find((m) => m.id === top.model)?.label ?? top.model) : null;
          const odds = top.success !== null ? `${Math.round(top.success * 100)}% likely` : "";
          const left = top.room !== null ? `${Math.round(top.room * 100)}% of its limits left` : "";
          const out = laneTool ? `${ENGINE_NAMES[laneTool]} is ${limit ? "out of usage" : "nearly out"}` : "Out of usage";
          return { tool: top.tool, model: top.model, why: [out, [model, odds].filter(Boolean).join(" · "), left].filter(Boolean).join(" · ") };
        })()
      : null;
  const more: HandoffMore | undefined =
    savedAgents.length || newTools.length
      ? {
          agents: savedAgents.map((a) => ({ id: a.id, name: a.name, icon: ((a.icon as IconName | undefined) ?? "agent"), blurb: a.description.slice(0, 80) || "A saved agent", tint: tintOfColor(a.color) })),
          tools: newTools.map((tool) => ({ tool, here: false, hint: roomOf(tool), out: (fullest(tool) ?? 0) >= 100, mark: <EngineMark tool={tool} size={14} />, tint: tintOfEngine(tool), ...(onward?.tool === tool ? { suggested: true, why: onward.why } : {}) })),
          onAgent: async (agentId) => {
            const def = savedAgents.find((a) => a.id === agentId);
            if (!def) return;
            before.current = new Set(ctx.state.lanes.map((l) => l.id));
            setAdding({ agentId });
            const r = await ctx.send({ type: "lane.add", name: def.name.slice(0, 40), agentId, control: { kind: "open" }, trigger: { kind: "manual" } });
            if (!r.ok) {
              ctx.notify(r.error ?? "Couldn't add that agent. Try again, or pick a different one.");
              setAdding(null);
            }
          },
          // Straight in, from what the session already knows; the setup opens only for what it has to ask.
          onTool: (tool) => {
            // One at a time from here; a press in another run's menu joins the same one (quickConnect).
            if (bringing) return;
            before.current = new Set(ctx.state.lanes.map((l) => l.id));
            setAdding({ tool });
            setBringing(tool);
            setBringLine(null);
            void quickConnect({ identity: ctx.identity, state: ctx.state, events: ctx.events, sid: ctx.sid, invite: ctx.invite, tool, from: lane, onProgress: setBringLine, send: ctx.send, ...(onward?.tool === tool && onward.model ? { model: onward.model } : {}) }).then((r) => {
              if (r.ok) {
                if (r.note) ctx.notify(r.note);
                // Started: the lane is on its way and the effect below hands it the work. One that never shows isn't waited on for ever.
                setTimeout(() => setBringing((b) => (b === tool ? null : b)), 45_000);
                return;
              }
              setBringing(null);
              setAdding(null);
              // Told it failed though it joined after all: offer it the work, and set nothing up a second time. Only one that is
              // still there: a start that failed after attaching leaves its lane behind with nobody in it, and the reason matters more.
              const joined = ctx.state.lanes.find((l) => {
                const e = ctx.state.engines[l.id];
                return !before.current.has(l.id) && e?.online && e.tool === tool && e.hostId === ctx.me.id;
              });
              if (joined) return setHandTo(joined.id);
              // Its lane was taken away again (quickConnect): the work isn't offered to an agent that isn't coming.
              setHandTo((h) => (h && before.current.has(h) ? h : null));
              if (r.error) ctx.notify(`${ENGINE_NAMES[tool]} didn't start: ${r.error}`);
              // Set up from the handing lane's folder first, as quickConnect would have been.
              ctx.onConnect?.("", tool, lane);
            });
          },
        }
      : undefined;
  let onChanged = ctx.onOpen ? () => ctx.onOpen!("files") : undefined;
  // In Work, what changed is a piece, read in the reader: the one it changed opens there; several are only said. "1 file changed"
  // opened the Browser on nothing (Arun, 2026-10-28: "iron everything and ensure we are good").
  if (ctx.state.options.work) onChanged = changed.length === 1 ? () => void dispatchEvent(new CustomEvent("friday:open-file", { detail: { path: changed[0]!.path }, cancelable: true })) : undefined;
  const runLog = blocks.some((x) => x.kind === "work") ? (
    <RunMeta
      files={changed}
      live={active}
      onFile={onChanged}
      {...(item.startedTs ?? msgs[0]?.ts ? { startedAt: item.startedTs ?? msgs[0]!.ts } : {})}
      {...(item.ended ? { endedAt: item.ended.ts } : item.closedTs ? { endedAt: item.closedTs } : {})}
      tokens={tokensUsed(ctx.events, lane, item.key, item.ended?.seq ?? (active ? Infinity : (msgs.at(-1)?.seq ?? item.key)))}
      {...compactedBefore(ctx.events, lane, item)}
      waiting={waitsOnPerson(ctx.state, lane)}
    />
  ) : null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(finalMsg?.body.text ?? "");
      ctx.notify("Copied");
    } catch {
      ctx.notify("Couldn't access the clipboard");
    }
  };

  // What to do next, as words: the last line of the response, not decoration on it.
  // The run can be taken back from its own answer: the files go back to before it started, and the agent forgets it.
  const rewindable = !!item.checkpoint && !!item.ended && !active && canUndo(ctx, item.checkpoint.lane);
  const runTool = item.checkpoint ? ctx.state.engines[item.checkpoint.lane]?.tool : undefined;
  const rewindHere = () =>
    ask({
      title: runTool ? "Put the files back to before this run?" : "Rewind to before this run?",
      body: runTool
        ? `The files go back to how they were before this run started. ${ENGINE_NAMES[runTool]} keeps its own conversation, so it still remembers the run; the log keeps all of it too.`
        : "The files go back to how they were before this run started, and the agent forgets what it did in it. The log keeps all of it, and you can redo it from the feed.",
      action: "Rewind to here",
      danger: true,
      onConfirm: async () => {
        const r = await ctx.send({ type: "folder.restore", sha: item.checkpoint!.sha, lane: item.checkpoint!.lane, rewindTo: item.checkpoint!.at ?? msgs[0]?.seq ?? item.key });
        if (!r.ok) ctx.notify(r.error ?? "Couldn't rewind. The folder may have moved on since; check the Diff tab, then try again.");
      },
    });
  // A finished run that changed something is worth showing someone: its recording, a press away, while the viewer link is on.
  const replayable = !!ctx.replayLink && !!item.ended && !active && changed.length > 0;
  const nextActions =
    changed.length > 0 || stillFailing.length > 0 || rewindable ? (
      <>
        {rewindable && (
          <button
            type="button"
            className="-ml-0.5 grid size-7 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Rewind to here"
            title="Rewind to before this run"
            onClick={rewindHere}
          >
            <Icon name="rewindTo" size={14} />
          </button>
        )}
        {/* Not when the review card below already lists them: the same count three times in one answer is noise. */}
        {changed.length > 0 && ctx.onOpen && !(item.ended && didChange(item.diffs.at(-1)?.body.files)) && (
          <button type="button" className="rsp-text-btn" data-tip="Open the changes" onClick={() => ctx.onOpen!("files")}>
            {changed.length} file{changed.length === 1 ? "" : "s"} changed
          </button>
        )}
        {stillFailing.length > 0 && via && (
          <button
            type="button"
            className="rsp-text-btn danger"
            title={stillFailing.map((f) => f.command).join(String.fromCharCode(10))}
            onClick={() => void ctx.send({ type: via, text: fixFailuresText(stillFailing), ...(lane !== MAIN_LANE ? { lane } : {}) })}
          >
            {stillFailing.length === 1 ? `${truncate(stillFailing[0]!.command, 32)} failed` : `${stillFailing.length} commands failed`} · {via === "instruct" ? "Fix it" : "Suggest a fix"}
          </button>
        )}
      </>
    ) : null;

  return (
    <div className={`rsp ${landed ? "landed" : ""}${look ? ` ${look.className}` : ""}`} style={look?.style}>
      {confirmUI}
      {/* The tool's mark beside a reply is identity only, with no ring: the header's agent tab, the status bar and the reply's own
          live line already say how it stands, and a reply waiting on you says "Needs you" in its head (Arun, 2026-10-29: "i dont
          like the ring/circle thing around the claude icon in the chat... since it is already shown in the header"). */}
      <span className="rsp-avatar" aria-hidden>
        {mate ?? (ctx.state.engines[lane]?.tool ? (
          <EngineMark tool={ctx.state.engines[lane]!.tool!} size={15} />
        ) : <Mascot mood={runMood({ active, outcome: item.ended?.body.outcome, failing: stillFailing.length })} size={26} still={!active} />)}
      </span>
      <div className="rsp-main">
      <div className="rsp-head">
        <span className="rsp-who">{name}</span>
        {/* Stopped to ask: it is waiting on a person, not thinking, and saying "Thinking" sent people looking for nothing. While it
            works the ring on its mark and the one live line under the reply say so; the head says only what needs you. A teammate's
            reply keeps its own words (its face is not a tool's mark). */}
        {active && (!typing || typing === "waiting") && (waitsOnPerson(ctx.state, lane) ? <span className="rsp-needs" role="status">Needs you</span> : mate ? <Working label={steps.some((s) => s.state === "running") ? "Working" : "Thinking"} /> : null)}
        {status && <span className={cn("rsp-status", ended?.outcome === "error" && (limitHit(ended.error) || signedOut(ended.error) ? "limit" : "err"))}>{status}</span>}
        {msgs[0] && (
          <span className="rsp-time">
            <Stamp ev={msgs[0]} />
          </span>
        )}
      </div>

      {/* The reply in reading order, the way Claude shows it (Arun, 2026-10-17): what the agent said, and between it a line per
          stretch of work ("Ran 2 commands, read 3 files ›") that opens to its steps. The live answer still streams in its own
          leaf below (LiveStream), so a delta never redraws these. */}
      {blocks.map((x, i) =>
        x.kind === "say" ? (
          <div key={x.key} className="rsp-say">
            <MessageResponse {...LIVE}>{x.note.trim()}</MessageResponse>
          </div>
        ) : x.kind === "subs" ? (
          <Subagents key={x.key} rows={x.rows} />
        ) : (
          <StepGroup key={x.id} steps={x.steps} thought={x.thought} thoughtSecs={x.secs} live={active && i === blocks.length - 1} />
        ),
      )}

      {/* While it works with no step yet to show (thinking), one live line under the reply says so: with no ring on its mark, the
          reply was its name over nothing until its first step (Arun, 2026-10-30: "there needs to be a visual thing in the chat to
          show that the claude is working"). Once it has steps, their own live line ("Working · 9s") says it. A teammate says it in
          its head instead. */}
      {active && !mate && !runLog && (!typing || typing === "waiting") && !waitsOnPerson(ctx.state, lane) && (
        <div className="rsp-live">
          <Working label={blocks.length ? "Working" : "Thinking"} />
        </div>
      )}
      {typing && typing !== "waiting" && <LiveStream sid={ctx.sid} lane={lane} />}
      {verdict && finalMsg && (
        <span className={`rsp-verdict ${verdict.tone}`} title={tests?.command ?? "No test command ran in this run"}>
          <Icon name={verdict.tone === "pass" ? "check" : verdict.tone === "fail" ? "x" : "help"} size={12} /> {verdict.text}
        </span>
      )}
      {finalMsg && finalMsg !== loginLine && (
        <StreamingResponse
          status="complete"
          contentClassName="rsp-answer"
          actionsClassName="rsp-actions !gap-0.5"
          showActions={!active}
          copyText={finalMsg.body.text}
          onCopy={copy}
          feedback={(() => {
            const r = ctx.state.reactions[finalMsg.seq]?.[ctx.me.id];
            return r ? (r.up ? "up" : "down") : null;
          })()}
          onFeedbackChange={(v) => {
            if (v === "down") setReasonOpen(true);
            else setReasonOpen(false);
            void ctx.send({ type: "react", seq: finalMsg.seq, up: v === "up" ? true : v === "down" ? false : null, quiet: true });
          }}
          sources={[...sources]
            // Only the web reaches an href, checked again here where the links are made.
            .filter(([u]) => webUrl(u))
            .slice(0, 10)
            .map(([u, title]) => ({ id: u, title: title || hostOf(u), domain: hostOf(u), url: u }))}
          extraActions={nextActions || opinionBtn ? <>{nextActions}{opinionBtn}</> : undefined}
        >
          <MessageResponse {...LIVE}>{finalMsg.body.text}</MessageResponse>
        </StreamingResponse>
      )}
      {finalMsg && reasonOpen && (
        <form
          className="react-reason"
          onSubmit={(e) => {
            e.preventDefault();
            if (!reason.trim()) return;
            void ctx.send({ type: "react", seq: finalMsg.seq, up: false, reason: reason.trim(), quiet: true });
            setReason("");
            setReasonOpen(false);
          }}
        >
          <input autoFocus value={reason} maxLength={300} placeholder="What was wrong? The agent remembers it for next time." aria-label="Why the answer fell short" onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setReasonOpen(false)} />
          <button type="submit" className="btn small" disabled={!reason.trim()}>
            Send
          </button>
        </form>
      )}
      {/* The coding tool ended this answer asking something: its choices, answered here, for whoever can steer it. Gone once
          the lane has its next instruction or starts again, which is when the projection drops the ask. */}
      {finalMsg && !active && via === "instruct" && ctx.state.asks[lane]?.seq === finalMsg.seq && runOf(ctx.state, lane).status !== "running" && (
        <AskCard ctx={ctx} lane={lane} seq={finalMsg.seq} asks={ctx.state.asks[lane]!.questions} />
      )}
      {/* Other people's thumbs on this answer, with their reasons: a room reads its agents together. */}
      {finalMsg && Object.entries(ctx.state.reactions[finalMsg.seq] ?? {}).some(([id]) => id !== ctx.me.id) && (
        <div className="rsp-reactions">
          {Object.entries(ctx.state.reactions[finalMsg.seq] ?? {})
            .filter(([id]) => id !== ctx.me.id)
            .map(([id, r]) => (
              <span key={id} className={`rsp-reaction ${r.up ? "up" : "down"}`} title={r.reason ?? ""}>
                <Avatar name={r.name} id={id} size={16} /> {r.name.split(/\s+/)[0]} {r.up ? "👍" : "👎"}
                {r.reason && <span className="rsp-reaction-why">{r.reason}</span>}
              </span>
            ))}
        </div>
      )}
      {runLog}

      {/* No reply to hang the actions on: they stand alone under the log. */}
      {!active && !finalMsg && item.ended && (nextActions || opinionBtn) && <div className="rsp-actions">{nextActions}{opinionBtn}</div>}

      {/* Why it stopped, before what to do about it: under the hand-off bar and the diff, it read as an afterthought. A usage
          limit is said by its note instead, with what to do; an older run's limit is history, said in a line, not in red. */}
      {ended?.outcome === "error" && !hit && !out && <div className="rsp-error">{withCode(ended.error ?? "")}</div>}
      {out && <SignedOutNote ctx={ctx} lane={lane} latest={latest} />}
      {!active && limit && !onBackup && <LimitNote ctx={ctx} lane={lane} resetsAt={limit.resetsAt} canSteer={via === "instruct"} />}
      {!active && hit && !limit && (
        <div className="limit-note">
          <ClockIcon className="size-4" />
          <span>{name} stopped here at its usage limit.</span>
        </div>
      )}
      {/* Cut short by the connection dropping (a lid shut, the network): nothing picks the turn up again by itself once it's back,
          so it is offered here, as for a usage limit. */}
      {!active && latest && !limit && ended?.outcome === "error" && /disconnected/i.test(ended.error ?? "") && via === "instruct" && (
        <div className="limit-note">
          <UnplugIcon className="size-4" />
          <span>The connection dropped in the middle of this run. Once it's back, it can carry on from where it stopped.</span>
          <button type="button" className="btn small" onClick={() => void ctx.send({ type: "instruct", lane, text: "[session] Carry on where you left off." }).then((r) => !r.ok && ctx.notify(r.error ?? "Couldn't send that."))}>
            Carry on
          </button>
        </div>
      )}

      {/* Passing the work on is in view, not behind a word: who can take it, one press each. */}
      {!active && item.ended && !mate && (others.length > 0 || more) && (
        <>
          <HandoffBar
            {...(ctx.state.options.work ? { label: "Hand to another agent" } : {})} // In Work, plain words (Arun, 2026-10-28: "iron everything… focusing on UI and UX").
            active={handTo}
            // Mine, offline: started again as it is picked, when its folder is on this computer; mine from another computer is left
            // to it, without an error for something nobody asked for. What is handed to it waits in its queue until it is back.
            onPick={(id) => {
              if (id && id !== handTo && mayRestart(id)) {
                const cwd = ctx.state.engines[id]!.cwd;
                void hostApi(ctx.identity, `/api/runner/describe?path=${encodeURIComponent(cwd)}`).then(() => reconnectLane(ctx, id), () => {});
              }
              setHandTo(id);
            }}
            targets={targets}
            {...(more ? { more } : {})}
          />
          {handTo && others.includes(handTo) && (
            <HandoffComposer
              from={name}
              to={{ id: handTo, name: agentNameFor(ctx.state, handTo) }}
              fromLook={agentLook(ctx.state, lane)}
              toLook={agentLook(ctx.state, handTo)}
              carried={carried}
              reason={reasonFor(name, agentNameFor(ctx.state, handTo), signals, pick?.id === handTo ? pick.why : undefined)}
              onCancel={() => setHandTo(null)}
              onSend={async (to, reason, carriedLines, task) => {
                // The agent taking it over is switched to what the work it is given calls for.
                const def = ctx.state.lanes.find((l) => l.id === to);
                const profile = `${agentNameFor(ctx.state, to)} ${(to === MAIN_LANE ? ctx.state.options.agent : def?.agent)?.instructions ?? ""}`;
                await smartSwitch(ctx, to, reachForHandoff(signals, profile, ctx.state.engines[lane]?.mode) ?? reachForMessage(task));
                const r = await ctx.send({ type: "instruct", lane: to, text: task, handoff: { fromLane: lane, reason, carried: carriedLines }, quiet: true });
                if (!r.ok) ctx.notify(r.error ?? "Couldn't hand that off. Make sure the other agent is connected, then try again.");
                return r.ok;
              }}
            />
          )}
        </>
      )}
      {/* For as long as the bring-in runs, however long a clone takes; outside the bar, which may have nothing left to offer meanwhile. */}
      {bringing && (
        <p className="ho-bringing" role="status">
          {bringLine ?? `Starting ${ENGINE_NAMES[bringing]}…`}
        </p>
      )}
      {/* Keep it, change it or throw it away, and the files that decide it: one card, the decision on top and the changes under it. */}
      {/* What it stopped to ask, and what was said, when no review card keeps it (nothing changed): the card it was asked on
          leaves the feed once answered, and the record of who let a command run went with it. */}
      {item.ended && !didChange(item.diffs.at(-1)?.body.files) && item.asked.length > 0 && (
        <ul className="rsp-asked" aria-label="What it asked before running">
          {item.asked.map((a, i) => (
            <li key={i} className={a.answer}>
              <Icon name={a.answer === "no" ? "x" : a.answer === "yes" ? "check" : "clock"} size={12} />
              <span>Asked before running</span> <code>{a.command}</code>
              <span className="rsp-asked-answer">{a.answer === "yes" ? "allowed" : a.answer === "no" ? "refused" : "not answered"}</span>
            </li>
          ))}
        </ul>
      )}
      {item.ended &&
        didChange(item.diffs.at(-1)?.body.files) &&
        !ctx.state.options.work && // A Work session's changes are its outputs, in the rail: no diff to review (Arun, 2026-10-26: "get rid of this for work").
        (
        <div className="change-set">
          <ReviewCard
            files={item.diffs.at(-1)!.body.files}
            tests={tests}
            receipt={receipt ?? undefined}
            explain={explain}
            state={ctx.state}
            me={ctx.me}
            lane={lane}
            sid={ctx.sid}
            invite={ctx.invite}
            send={ctx.send}
            endSeq={item.ended.seq}
            second={secondReviewOf(ctx.events, item.ended.seq)}
            via={via}
            notify={ctx.notify}
            lastCommitSeq={ctx.lastCommitSeq}
            lastApplySeq={ctx.lastApplySeq}
            lastRestoreSeq={ctx.lastRestoreSeq}
            undo={item.checkpoint && canUndo(ctx, item.checkpoint.lane) ? () => ctx.send({ type: "folder.restore", sha: item.checkpoint!.sha, lane: item.checkpoint!.lane }) : undefined}
          >
          <DiffCard
            hideTitle
            attribution={attribution}
            files={item.diffs.at(-1)!.body.files}
            review={{ send: ctx.send, via, lane, notify: ctx.notify, agent: agentNameFor(ctx.state, lane) }}
            threads={ctx.state.threads}
            me={ctx.me.id}
            contendedPaths={contendedPaths(ctx.state, lane)}
          />
          </ReviewCard>
        </div>
      )}
      </div>
    </div>
  );
});

/**
 * A coding tool out of usage, under the run it cut short: carry on here when the allowance comes back, set with one press
 * and called off as easily (resume.at, sent by the server at that time). Handing the work to another agent meanwhile is
 * the hand-off bar under it, which suggests one on another account.
 */
/**
 * A coding tool that stopped because it isn't signed in on its computer: one plain instruction, with Sign in where this is that
 * computer, and where the work went if Friday handed it on (agent-mesh.ts onLimit). The run read the tool's "Please run /login"
 * and then the runner's "Run `claude auth login` in a terminal there", two commands and no button (Arun, 2026-10-28: "iron
 * everything and ensure we are good… any logic errors and fixes").
 */
function SignedOutNote({ ctx, lane, latest }: { ctx: Ctx; lane: string; latest: boolean }) {
  const engine = ctx.state.engines[lane];
  const tool = engine?.tool;
  const who = tool ? ENGINE_NAMES[tool] : agentNameFor(ctx.state, lane);
  const [busy, setBusy] = useState(false);
  // What the press did, said in the note beside the button: a toast was gone before anyone read it, and a Terminal window opening
  // with no word first surprised somebody who never uses one (QA, 2026-10-28; Arun: "TEST EVERYTHING… EVERY INTERACTION").
  const [said, setSaid] = useState<{ url?: string; terminal?: boolean; command?: string } | null>(null);
  const ended = ctx.events.findLast((e) => e.body.type === "run.ended" && (e.lane ?? MAIN_LANE) === lane)?.seq ?? 0;
  const handed = ctx.events.findLast((e) => e.seq > ended && e.body.type === "instruction" && e.body.handoff?.fromLane === lane);
  const mine = !!tool && engine!.hostId === ctx.me.id && !!ctx.onConnect;
  // The message it stopped on, sent again once signed in: "send your message again" was a thing to work out how to do.
  const asked = ctx.events.findLast((e) => e.seq < ended && e.body.type === "instruction" && (e.lane ?? MAIN_LANE) === lane);
  const again = asked?.body.type === "instruction" && asked.body.text.trim() ? asked.body.text : "";
  const [sent, setSent] = useState(false);
  const tryAgain = async () => {
    setSent(true);
    const r = await ctx.send({ type: "instruct", text: again, ...(lane !== MAIN_LANE ? { lane } : {}) });
    if (!r.ok) (setSent(false), ctx.notify(r.error ?? "Couldn't send that again. Try once more."));
  };
  const signIn = async () => {
    if (!tool) return;
    setBusy(true);
    try {
      const r = await hostApi<{ opened?: boolean; command: string; url?: string }>(ctx.identity, "/api/runner/login", { method: "POST", body: JSON.stringify({ tool }) });
      // A page from the tool beats a terminal: the runner opens Terminal only when the tool prints no page (runner/local-api.ts).
      setSaid(r.url ? { url: r.url } : r.opened ? { terminal: true } : { command: r.command });
    } catch (e) {
      ctx.notify((e as Error).message || `Couldn't start ${who}'s sign-in.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="limit-note" role="status">
      <UnplugIcon className="size-4" />
      <span>
        {handed?.body.type === "instruction" && handed.body.handoff ? (
          <>
            {who} isn't signed in, so <b>{handed.body.handoff.toName}</b> carries the work on.{mine && latest ? ` Sign in to use ${who} again.` : ""}
          </>
        ) : mine ? (
          `${who} isn't signed in on this computer. Sign in, then send your message again.`
        ) : (
          `${who} isn't signed in on ${engine ? `${engine.hostName.split(/\s+/)[0]}'s` : "its"} computer. Once it's signed in there, send the message again.`
        )}
        {mine && latest && (
          <small className="limit-note-sub">
            {said?.url ? (
              <>
                The sign-in page is open in your browser.{" "}
                <button type="button" className="link-btn" onClick={() => openOutside(said.url!)}>
                  Open it again
                </button>
              </>
            ) : said?.terminal ? (
              `A Terminal window opened with ${who}'s sign-in. Follow its steps there.`
            ) : said?.command ? (
              <>
                Run <code>{said.command}</code> in Terminal on this computer to sign in.
              </>
            ) : (
              `Sign in opens ${who}'s sign-in page in your browser, or a Terminal window if it has no page.`
            )}
          </small>
        )}
      </span>
      {/* Still there once the work went on elsewhere: otherwise nothing in the session led back to signing it in (Arun, 2026-10-28:
          "iron everything and ensure we are good"). */}
      {mine && latest && (
        <button type="button" className="btn small" disabled={busy} onClick={() => void signIn()}>
          {busy ? "Opening…" : said ? "Sign in again" : "Sign in"}
        </button>
      )}
      {mine && latest && said && again && !handed && (
        <button type="button" className="btn small primary" disabled={sent} onClick={() => void tryAgain()}>
          {sent ? "Sent" : "Try again"}
        </button>
      )}
    </div>
  );
}

function LimitNote({ ctx, lane, resetsAt, canSteer }: { ctx: Ctx; lane: string; resetsAt: number | null; canSteer: boolean }) {
  const due = ctx.state.resumes?.[lane];
  const tool = ctx.state.engines[lane]?.tool;
  const who = tool ? ENGINE_NAMES[tool] : agentNameFor(ctx.state, lane);
  const send = async (cmd: Record<string, unknown>) => {
    const r = await ctx.send(cmd);
    if (!r.ok) ctx.notify(r.error ?? "Couldn't do that. Try again.");
  };
  // Already handed on since it ran out (by Friday on its own, limit-handoff.ts, or by somebody): where the work went, not a choice.
  const ended = ctx.events.findLast((e) => e.body.type === "run.ended" && (e.lane ?? MAIN_LANE) === lane)?.seq ?? 0;
  const handed = ctx.events.findLast((e) => e.seq > ended && e.body.type === "instruction" && e.body.handoff?.fromLane === lane);
  if (handed?.body.type === "instruction" && handed.body.handoff)
    return (
      <div className="limit-note" role="status">
        <ClockIcon className="size-4" />
        <span>
          {who} ran out of usage, so <b>{handed.body.handoff.toName}</b> carries the work on from where it stopped.
        </span>
      </div>
    );
  if (due)
    return (
      <div className="limit-note" role="status">
        <ClockIcon className="size-4" />
        <span>
          Carries on by itself at <b>{clockTime(due.at)}</b>
          {due.by !== ctx.me.id ? `, set by ${due.byName.split(/\s+/)[0]}` : ""}.
        </span>
        {canSteer && (
          <button type="button" className="rsp-text-btn" onClick={() => void send({ type: "resume.cancel", lane })}>
            Don't
          </button>
        )}
      </div>
    );
  const back = resetsAt !== null && resetsAt <= Date.now();
  return (
    <div className="limit-note">
      <ClockIcon className="size-4" />
      <span>
        {back ? (
          <>
            {who} was out of usage until <b>{clockTime(resetsAt)}</b>, so it should be back.
          </>
        ) : resetsAt ? (
          <>
            {who} is out of usage on its account until <b>{clockTime(resetsAt)}</b>. Hand the work to another agent, have it carry on here then, or sign it in as another account.
          </>
        ) : (
          <>{who} is out of usage on its account. Hand the work to another agent, have it try again in an hour, or sign it in as another account.</>
        )}
      </span>
      {canSteer && (
        <button
          type="button"
          className="btn small"
          onClick={() =>
            void send(back ? { type: "instruct", lane, text: "Carry on with the task where you left off; don't start over." } : { type: "resume.at", lane, at: resetsAt ?? Date.now() + 3_600_000 })
          }
        >
          {back ? "Carry on now" : resetsAt ? `Carry on at ${clockTime(resetsAt)}` : "Try again in an hour"}
        </button>
      )}
    </div>
  );
}

/** An error's `commands` as code, the way the tools write them, rather than with their backticks showing. */
function withCode(text: string) {
  return text.split(/`([^`\n]+)`/).map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));
}

/** "3:00 PM" today, "Tue 3:00 PM" on another day. */
function clockTime(t: number): string {
  const today = new Date(t).toDateString() === new Date().toDateString();
  return (today ? clock : clockOnDay).format(t);
}

/**
 * Files in this lane's diff that another lane has also changed.
 *
 * Keyed by path so the diff header can say it beside the file it is about.
 * Said as "Review also changed this" rather than repeating the path, which
 * is already the thing it sits next to.
 */
function contendedPaths(state: SessionState, lane: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of collisionsFor(state, lane)) {
    const others = [...new Set(c.claims.filter((x) => x.lane !== lane).map((x) => (x.lane === MAIN_LANE ? "Main" : (state.lanes.find((l) => l.id === x.lane)?.name ?? "another lane"))))];
    out[c.path] = `${others.join(", ")} also changed this`;
  }
  return out;
}

const truncate = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** Shell commands in these steps whose most recent attempt failed. */
export function failingCommands(messages: Ev<"agent.message">[], results: Map<string, Ev<"tool.result">>): { command: string; output: string }[] {
  const last = new Map<string, { command: string; output: string; failed: boolean }>();
  for (const m of messages)
    for (const c of m.body.toolCalls) {
      if (c.name !== "run_command" && c.name !== "shell") continue;
      const r = results.get(c.id);
      if (!r || r.body.interrupted) continue;
      // Friday's own command that never ran (waiting on a person's yes, told no, a machine that didn't answer) has nothing to fix.
      const failed = commandFailed(r.body);
      if (failed === null) continue;
      let command = "";
      try {
        command = String((JSON.parse(c.arguments || "{}") as { command?: unknown }).command ?? "").trim();
      } catch {
        continue;
      }
      if (command) last.set(command, { command, output: r.body.output, failed });
    }
  return [...last.values()].filter((c) => c.failed).map(({ command, output }) => ({ command, output }));
}

/** The instruction behind "Fix it": what failed, the end of what it printed, and what done looks like. */
export function fixFailuresText(failing: { command: string; output: string }[]): string {
  const parts = failing.slice(0, 4).map((f) => {
    // The shell's answer starts with the command line itself; it is already said above the block.
    const lines = f.output.split("\n");
    if (lines[0]?.trim() === `$ ${f.command}`) lines.shift();
    const tail = lines.slice(-40).join("\n").trim();
    return `$ ${f.command}\n\`\`\`\n${tail.slice(-3000)}\n\`\`\``;
  });
  return `${failing.length === 1 ? "This command is still failing" : "These commands are still failing"}:\n\n${parts.join("\n\n")}\n\nFind the cause, fix it, and run ${failing.length === 1 ? "it" : "them"} again until ${failing.length === 1 ? "it passes" : "they pass"}. Don't skip or disable anything to get there.`;
}

// ── diffs ─────────────────────────────────────────────────────────────

/** The Jump menu's places, by the key after g that goes there. */
const JUMP_ICON: Record<JumpPlace["key"], IconName> = { q: "help", f: "x", d: "file", r: "check", m: "message" };

/** Undo belongs to the same people who can stop a run: whoever is driving it, or an owner. */
function canUndo(ctx: Ctx, lane: string): boolean {
  return ctx.me.role === "owner" || driverOf(ctx.state, lane)?.id === ctx.me.id;
}

/** How a review is sent: straight to the agent, as a suggestion to whoever drives, or not at all. */
export type ReviewVia = "instruct" | "suggest" | null;

export function reviewVia(state: SessionState, me: Member, lane = MAIN_LANE): ReviewVia {
  // Someone else's own plan takes their work alone (own-plan.ts): a review of it goes to them as a suggestion.
  const e = state.engines[lane];
  if (ownPlan(e) && e.hostId !== me.id) return can(state, me.id, "suggest") ? "suggest" : null;
  const driver = driverOf(state, lane);
  if (driver?.id === me.id || (!driver && canDriveLane(state, me.id, lane))) return "instruct";
  return can(state, me.id, "suggest") ? "suggest" : null;
}

type Note = { comment: LineComment; editing: boolean };

/**
 * Which files of a diff have been read, remembered.
 *
 * Keyed by path and by the size of the change, so a file the agent touches
 * again comes back unticked: what was reviewed is a particular version of it.
 * Kept in this browser only — it is a reader's bookmark, not a fact about the
 * session — and trimmed, so it cannot grow for ever.
 */
const VIEWED_KEY = "mpa.viewed";
const viewedSig = (f: DiffFile) => `${f.path}#${f.additions}/${f.deletions}/${f.patch.length}`;
function readViewed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(VIEWED_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function useViewed() {
  const [seen, setSeen] = useState<Set<string>>(() => new Set(readViewed()));
  // The same files are listed in the chat and in the Diff panel: a tick in one is a tick in the other.
  useEffect(() => {
    const on = () => setSeen(new Set(readViewed()));
    window.addEventListener("friday:viewed", on);
    return () => window.removeEventListener("friday:viewed", on);
  }, []);
  const set = (sig: string, on: boolean) => {
    const next = new Set(seen);
    if (on) next.add(sig);
    else next.delete(sig);
    setSeen(next);
    try {
      localStorage.setItem(VIEWED_KEY, JSON.stringify([...next].slice(-400)));
      window.dispatchEvent(new Event("friday:viewed"));
    } catch {
      // Private mode: the ticks last until the panel closes, which is still useful.
    }
  };
  return { seen, set };
}

/** Unified or split, as this reader last left it. */
const DIFF_MODE_KEY = "friday.diff.mode";
function readMode(): DiffMode {
  try {
    return localStorage.getItem(DIFF_MODE_KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}

/**
 * Change lists in the chat opened by hand, by what they hold: one starts closed (Arun, 2026-10-18: fifty-nine files pushed the
 * messages around it out of sight) and stays open while the chat redraws once opened.
 */
const openDiffs = new Set<string>();

export function DiffCard({
  files: given,
  compact = false,
  panel = false,
  hideTitle = false,
  onUndo,
  review,
  attribution,
  threads = [],
  me = "",
  contendedPaths = {},
}: {
  files: DiffFile[];
  compact?: boolean;
  /**
   * The Diff panel's own: a toolbar to filter the files, hide the reviewed ones, read old and new side by side and open or fold
   * them all; review progress with a jump to the next unread file; and j/k to move between files, v to tick one off.
   */
  panel?: boolean;
  /** The "Changed N files" line is drawn elsewhere, beside the buttons that act on them. */
  hideTitle?: boolean;
  onUndo?: () => void;
  /** Let people comment on lines and send the comments to the agent. */
  review?: { send: Send; via: ReviewVia; lane?: string; notify?: (m: string) => void; /** Whose work a comment sent from here becomes. */ agent?: string };
  /** Files another lane has also changed, path → the sentence to show. */
  contendedPaths?: Record<string, string>;
  /**
   * Threads already in the session, so a comment is something the room has
   * rather than something one browser is holding.
   */
  threads?: Thread[];
  /** Who wrote each added line (attribution.ts): a pencil on the lines a person wrote by hand, and a word in the file's header. */
  attribution?: Attribution;
  me?: string;
}) {
  const [ask, confirmUI] = useConfirm();
  // On its own in the chat, the list is one line until opened; in the Diff panel, or under a review card (which folds itself), it
  // is always open.
  const folds = !panel && !hideTitle;
  const diffKey = given.map((f) => `${f.path}:${f.additions}:${f.deletions}`).join("|");
  const [shut, setShut] = useState(() => folds && !openDiffs.has(diffKey));
  // An older change set's patches are fetched as it is opened (session/patches.ts): the page was sent its files by name.
  const { files, loading } = useFullFiles(given, !shut);
  const toggleShut = () =>
    setShut((s) => {
      if (s) openDiffs.add(diffKey);
      else openDiffs.delete(diffKey);
      return !s;
    });
  // Who is reading which line, for a mark on that line: focus is already shared, and the diff draws it.
  const { others } = useFocus();
  const readers = useMemo(() => Object.entries(others).flatMap(([id, o]) => (o.at.path && o.at.line ? [{ id, name: o.name, path: o.at.path, line: o.at.line }] : [])), [others]);
  // Keyed by file and line. Drafts and saved comments share the map; `editing` tells them apart.
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const viewed = useViewed();
  const [filter, setFilter] = useState("");
  const [hideViewed, setHideViewed] = useState(false);
  const [mode, setModeState] = useState<DiffMode>(readMode);
  const setMode = (m: DiffMode) => {
    setModeState(m);
    try {
      localStorage.setItem(DIFF_MODE_KEY, m);
    } catch {
      // Private mode: it holds until the panel closes.
    }
  };
  const [expand, setExpand] = useState({ open: false, n: 0 });
  const list = useRef<HTMLDivElement>(null);
  // Worked out once per change set, not on every draw: an 80-file diff took ~12ms a card, and the feed draws on every event.
  const { ordered, linesOf } = useMemo(() => ({ ordered: reviewOrder(files), linesOf: new Map(files.map((f) => [f, patchLines(f.patch)])) }), [files]);
  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);
  if (!files.length) return <div className="diff-card empty">No changes in the folder.</div>;
  const reviewedCount = files.filter((f) => viewed.seen.has(viewedSig(f))).length;
  const nextUnread = ordered.find((r) => !viewed.seen.has(viewedSig(r.file)))?.file;
  const q = filter.trim().toLowerCase();
  const shows = (f: DiffFile) => (!q || f.path.toLowerCase().includes(q)) && !(hideViewed && viewed.seen.has(viewedSig(f)));
  const hidden = files.filter((f) => !shows(f)).length;
  // j and k between files, v to tick the one in focus: forty files is a lot of reaching for a mouse.
  const onKeys = (e: React.KeyboardEvent) => {
    if (!panel || e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
    const heads = [...(list.current?.querySelectorAll<HTMLButtonElement>(".rsp-diff-head") ?? [])];
    const at = heads.findIndex((h) => h === document.activeElement);
    if (e.key === "j" || e.key === "k") {
      e.preventDefault();
      const next = heads[Math.min(heads.length - 1, Math.max(0, at + (e.key === "j" ? 1 : -1)))];
      next?.focus();
      next?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "v" && at >= 0) {
      e.preventDefault();
      heads[at]!.closest(".rsp-diff-top")?.querySelector<HTMLElement>(".rsp-viewed")?.click();
    }
  };

  const via = review?.via ?? null;
  const saved = Object.values(notes).filter((n) => !n.editing && n.comment.text.trim());
  const keyOf = (path: string, lineId: string) => JSON.stringify([path, lineId]);
  const put = (key: string, v: Note | null) =>
    setNotes((cur) => {
      const next = { ...cur };
      if (v) next[key] = v;
      else delete next[key];
      return next;
    });
  /**
   * Post the comment the moment it is written.
   *
   * It used to sit in this browser until the whole review was sent, so the
   * room could not see it, a refresh lost it, and nobody could answer one
   * remark without answering all of them.
   */
  const postComment = async (c: LineComment, text: string, ask = false) => {
    if (!review) return;
    const r = await review.send({
      type: "thread.open",
      path: c.path,
      line: c.line,
      ...(c.endLine ? { endLine: c.endLine } : {}),
      code: c.code,
      ...(c.removed ? { removed: true } : {}),
      ...(ask ? { ask: true } : {}),
      text,
    });
    if (!r.ok) review.notify?.("Could not post that note");
  };
  /** The rows a note's lines are, for marking them: by number on the side the note is about. */
  const rowsOf = (lines: DiffLine[], c: { line: number; endLine?: number | undefined; removed: boolean }) =>
    c.endLine ? lines.filter((l) => (c.removed ? l.type === "removed" && l.oldLine !== undefined && l.oldLine >= c.line && l.oldLine <= c.endLine! : l.type !== "removed" && l.newLine !== undefined && l.newLine >= c.line && l.newLine <= c.endLine!)).map((l) => l.id) : [];

  /** Threads on these files that are still open, oldest first; and among them, your own notes not yet with an agent. */
  const paths = new Set(files.map((f) => f.path));
  const live = threads.filter((t) => !t.resolved && paths.has(t.path));
  const pending = live.filter((t) => !t.sent && t.by.id === me && !t.ask);
  const [sending, setSending] = useState(false);

  // Your notes, together, as one instruction (threads.send marks each as with the agent); a suggester's go to the driver as words.
  const sendReview = async () => {
    if (!review || !via || !pending.length) return;
    setSending(true);
    const r =
      via === "instruct"
        ? await review.send({ type: "threads.send", ids: pending.map((t) => t.id), ...(review.lane ? { lane: review.lane } : {}) })
        : await review.send({ type: "suggest", text: reviewText(pending.map((t) => ({ path: t.path, line: t.line, ...(t.endLine ? { endLine: t.endLine } : {}), removed: t.removed, code: t.code, text: t.text }))), ...(review.lane && review.lane !== MAIN_LANE ? { lane: review.lane } : {}) });
    setSending(false);
    if (r.ok) review.notify?.(via === "instruct" ? `${pending.length === 1 ? "Note" : `${pending.length} notes`} sent to ${review.agent ?? "the agent"}` : "Notes suggested to the driver");
    else review.notify?.(r.error ?? "The notes didn't go through.");
  };

  return (
    <div className={cn("diff-card", compact && "compact", panel && "dp-card")} ref={list} onKeyDown={onKeys}>
      {confirmUI}
      {panel && (
        <div className="dp-tools" role="toolbar" aria-label="Diff tools">
          <label className="dp-filter">
            <Icon name="search" size={13} />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setFilter("")} placeholder={`Filter ${files.length} file${files.length === 1 ? "" : "s"}`} aria-label="Filter files by path" spellCheck={false} />
            {filter && (
              <button type="button" className="dp-filter-x" aria-label="Clear the filter" onClick={() => setFilter("")}>
                <Icon name="x" size={12} />
              </button>
            )}
          </label>
          <button type="button" className={cn("dp-tool", hideViewed && "on")} aria-pressed={hideViewed} title={hideViewed ? "Show reviewed files" : "Hide reviewed files"} onClick={() => setHideViewed((v) => !v)}>
            <Icon name="eye" size={14} />
          </button>
          <span className="dp-seg" role="radiogroup" aria-label="Diff layout">
            <button type="button" role="radio" aria-checked={mode === "unified"} className={cn("dp-tool", mode === "unified" && "on")} title="Unified: one column" onClick={() => setMode("unified")}>
              <Icon name="list" size={14} />
            </button>
            <button type="button" role="radio" aria-checked={mode === "split"} className={cn("dp-tool", mode === "split" && "on")} title="Split: old and new side by side" onClick={() => setMode("split")}>
              <Icon name="columns" size={14} />
            </button>
          </span>
          <button type="button" className="dp-tool" title={expand.open ? "Collapse every file" : "Expand every file"} aria-label={expand.open ? "Collapse every file" : "Expand every file"} onClick={() => setExpand((x) => ({ open: !x.open, n: x.n + 1 }))}>
            <Icon name={expand.open ? "collapseAll" : "chevronDown"} size={14} />
          </button>
        </div>
      )}
      {panel && files.length > 1 && (
        <div className="dp-progress">
          <div className="dp-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={files.length} aria-valuenow={reviewedCount} aria-label="Files reviewed">
            <div className="dp-progress-fill" style={{ width: `${(reviewedCount / files.length) * 100}%` }} />
          </div>
          <span className="dp-progress-text" title="j and k move between files; v marks one reviewed">
            {reviewedCount === files.length ? "All reviewed" : `${reviewedCount} of ${files.length} reviewed`}
            {hidden > 0 && <span className="dp-hidden"> · {hidden} hidden</span>}
          </span>
          {nextUnread && reviewedCount < files.length && (
            <button
              type="button"
              className="dp-next"
              title={`Open ${nextUnread.path}, the next file to read`}
              onClick={() => {
                if (!shows(nextUnread)) (setFilter(""), setHideViewed(false));
                requestAnimationFrame(() => showDiff(nextUnread.path));
              }}
            >
              Next unreviewed <Icon name="arrowDown" size={11} />
            </button>
          )}
        </div>
      )}
      {!panel && <div className="diff-head">
        {/* Under a review card the title is the card's, so the hint shares this row with the count instead of a row of its own. */}
        {hideTitle && via && !compact && <span className="diff-review-hint">Hover a line and press + to leave a note for the agent; shift-click another line for a block.</span>}
        {!hideTitle && (
          <button type="button" className={cn("diff-toggle", !shut && "open")} aria-expanded={!shut} title={shut ? "Show the files" : "Hide the files"} onClick={toggleShut}>
            <Icon name="chevronDown" size={14} className="diff-caret" />
            <span>
              Changed {files.length} file{files.length === 1 ? "" : "s"}
            </span>
            <span className="diff-add">+{adds}</span>
            <span className="diff-del">−{dels}</span>
          </button>
        )}
        {files.length > 1 && (
          <span className="diff-progress" title="Files you have marked as reviewed">
            {files.filter((f) => viewed.seen.has(viewedSig(f))).length} of {files.length} reviewed
          </span>
        )}
        {onUndo && (
          <button
            type="button"
            className="diff-undo"
            title="Put every file back the way it was before this run"
            onClick={() =>
              ask({
                title: "Undo this run?",
                body: "Every file goes back to how it was before this run started, including anything changed after it. Files git ignores are left alone, and you can redo it from the activity feed.",
                action: "Undo run",
                danger: false,
                onConfirm: onUndo,
              })
            }
          >
            Undo run
          </button>
        )}
      </div>}
      {!shut && loading && <p className="diff-review-hint">Fetching the changes…</p>}
      {!shut && via && !compact && !(hideTitle && !panel) && <p className="diff-review-hint">Hover a line and press + to leave a note for the agent; shift-click another line for a block.</p>}
      {!shut && (() => {
        // Riskiest first, formatting-only folded at the end (reviewOrder): where a careful reader would start.
        const risky = ordered.filter((r) => r.risks.length).length;
        const fold = files.length > 2 ? ordered.filter((r) => r.mechanical && shows(r.file)) : [];
        const shown = ordered.filter((r) => !fold.includes(r) && shows(r.file));
        const fileView = ({ file: f, risks }: (typeof ordered)[number]) => {
        const annotations: Record<string, ReactNode> = {};
        // The lines notes are about (drafts and open threads on a block), marked along their edge.
        const marked = new Set<string>();
        const lines = linesOf.get(f) ?? patchLines(f.patch);

        // A thread knows its file and line, not the row id the diff gave that
        // line — ids are positions in the patch text and change whenever the
        // patch is regenerated. Matching on the number survives that.
        for (const t of threads.filter((x) => x.path === f.path)) {
          // A note on a block sits under the block's last line.
          const want = t.endLine ?? t.line;
          const row = lines.find((l) => (t.removed ? l.type === "removed" && l.oldLine === want : l.newLine === want));
          if (!row) continue;
          if (!t.resolved) for (const id of rowsOf(lines, t)) marked.add(id);
          annotations[row.id] = (
            <ThreadView
              key={t.id}
              thread={t}
              me={me}
              {...(review ? { send: review.send, agent: review.agent ?? "the agent", canSend: review.via === "instruct", ...(review.lane ? { lane: review.lane } : {}) } : {})}
            />
          );
        }

        // Where other people are reading, as a mark on that line, like cursors in a shared document.
        for (const r of readers.filter((x) => x.path === f.path || x.path.endsWith(`/${f.path}`) || f.path.endsWith(`/${x.path}`))) {
          const row = lines.find((l) => l.newLine === r.line) ?? lines.find((l) => l.oldLine === r.line);
          if (!row) continue;
          const had = annotations[row.id];
          annotations[row.id] = (
            <>
              <span className="diff-here">
                <Avatar name={r.name} id={r.id} size={16} /> {r.name.split(/\s+/)[0]} is reading here
              </span>
              {had}
            </>
          );
        }

        // Drafts stay here, because you are still typing them.
        for (const [key, n] of Object.entries(notes)) {
          const [path, lineId] = JSON.parse(key) as [string, string];
          if (path !== f.path || !n.editing) continue;
          for (const id of rowsOf(lines, n.comment)) marked.add(id);
          annotations[lineId] = (
            <CommentBox
              initial={n.comment.text}
              {...(n.comment.endLine ? { label: `Lines ${n.comment.line}–${n.comment.endLine}` } : {})}
              placeholder={n.comment.endLine ? "Note for the agent about these lines" : "Note for the agent: what should change here?"}
              save="Add note"
              onCancel={() => put(key, null)}
              onSave={(text) => {
                put(key, null);
                if (text.trim()) void postComment(n.comment, text.trim());
              }}
              onAsk={(text) => {
                put(key, null);
                if (text.trim()) void postComment(n.comment, text.trim(), true);
              }}
            />
          );
        }

        return (
          <DiffView
            key={f.path}
            path={f.path}
            change={f.status}
            {...(f.truncated ? { status: "cut short" } : {})}
            {...(contendedPaths[f.path] ? { contended: contendedPaths[f.path] } : {})}
            risks={risks}
            lines={lines}
            total={f}
            // The panel opens a short change set whole; the chat card keeps every file folded, a line each, until it is opened.
            defaultOpen={panel ? files.length <= 3 : false}
            maxHeight={panel ? 640 : 420}
            mode={panel ? mode : "unified"}
            {...(panel ? { expand } : {})}
            copyText={f.patch}
            viewed={viewed.seen.has(viewedSig(f))}
            {...(files.length > 1 ? { onViewed: (on: boolean) => viewed.set(viewedSig(f), on) } : {})}
            marked={marked}
            {...(attribution && attribution.has(f.path)
              ? { by: (l: DiffLine) => (l.type === "added" && byHand(attribution, f.path, l.content) ? (attribution.get(f.path)?.by ?? "hand") : null), note: handWord(attribution, f.path) }
              : {})}
            {...(via
              ? {
                  onComment: (line: DiffLine, range?: DiffLine[]) => {
                    const key = keyOf(f.path, line.id);
                    const had = notes[key];
                    if (range && range.length > 1) {
                      // The note started on one line and was stretched to another: what was typed at the first comes along.
                      const first = range[0]!;
                      const removed = range.every((r) => r.type === "removed");
                      const ids = new Set(range.map((r) => r.id));
                      const typed = Object.entries(notes).find(([k, x]) => x.editing && (JSON.parse(k) as [string, string])[0] === f.path && ids.has((JSON.parse(k) as [string, string])[1]));
                      if (typed) put(typed[0], null);
                      const num = (r: DiffLine) => (removed ? r.oldLine : (r.newLine ?? r.oldLine)) ?? 0;
                      put(key, { comment: { path: f.path, line: num(first), endLine: num(line), removed, code: range.map((r) => r.content).join("\n").slice(0, 1600), text: typed?.[1].comment.text ?? "" }, editing: true });
                      return;
                    }
                    put(key, had ? { ...had, editing: true } : { comment: { path: f.path, line: line.newLine ?? line.oldLine ?? 0, removed: line.type === "removed", code: line.content, text: "" }, editing: true });
                  },
                  annotations,
                }
              : {})}
          />
        );
        };
        // Files from the folders the agent also works in, under that folder's name, after this folder's own.
        const byRepo = new Map<string, typeof shown>();
        for (const r of shown) {
          const k = r.file.repo ?? "";
          byRepo.set(k, [...(byRepo.get(k) ?? []), r]);
        }
        const repos = [...byRepo.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
        return (
          <>
            {repos.length <= 1
              ? shown.map(fileView)
              : repos.map((repo) => (
                  <div key={repo || "own"} className="diff-repo">
                    <h4 className="diff-repo-head" title={repo || "The agent's own folder"}>
                      <Icon name="folder" size={12} /> {repo ? repo.split(/[\\/]/).filter(Boolean).pop() : "This folder"} <span className="muted">{byRepo.get(repo)!.length}</span>
                    </h4>
                    {byRepo.get(repo)!.map(fileView)}
                  </div>
                ))}
            {panel && !shown.length && !fold.length && (
              <p className="dp-none">
                {q ? `No changed file matches “${filter.trim()}”.` : "Every file is reviewed."}{" "}
                <button type="button" className="link-btn" onClick={() => (setFilter(""), setHideViewed(false))}>
                  Show all
                </button>
              </p>
            )}
            {fold.length > 0 && (
              <details className="diff-mechanical">
                <summary>
                  {fold.length} file{fold.length === 1 ? "" : "s"} with only formatting, moved lines or imports
                </summary>
                {fold.map(fileView)}
              </details>
            )}
          </>
        );
      })()}
      {via && pending.length > 0 && (
        <div className="diff-review-bar">
          <span>
            {pending.length} note{pending.length === 1 ? "" : "s"} for {review?.agent ?? "the agent"}
          </span>
          <button type="button" className="btn primary small" disabled={sending} onClick={() => void sendReview()}>
            {sending ? "Sending…" : via === "instruct" ? `Send ${pending.length === 1 ? "the note" : "the notes"}` : "Suggest to driver"}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * One remark and the conversation under it.
 *
 * The thread belongs to the session, so everybody sees the same one: what was
 * said, who said it, what came back, and whether the code has answered it.
 * Resolving is the only state it has — a comment is either still true of the
 * code or it is not.
 */
function ThreadView({ thread, me, send, agent = "the agent", canSend = false, lane }: { thread: Thread; me: string; send?: Send; agent?: string; canSend?: boolean; lane?: string }) {
  const [replying, setReplying] = useState(false);
  /**
   * A refusal from the server, shown here.
   *
   * These commands used to be fired with `void`, so a reply the server turned
   * down vanished without a word: the box closed, nothing appeared, and the
   * only way to know was to read the log by hand.
   */
  const [failed, setFailed] = useState("");
  const mine = thread.by.id === me;

  const run = async (cmd: Record<string, unknown>) => {
    if (!send) return;
    const r = await send(cmd);
    setFailed(r.ok ? "" : r.error || "That did not go through.");
  };

  const who = (id: string, name: string) => (id === me ? "You" : name);

  return (
    <div className={`diff-thread ${thread.resolved ? "is-resolved" : ""}`}>
      <div className="diff-thread-msg">
        <Avatar name={thread.by.name} id={thread.by.id} size={20} />
        <div className="diff-thread-body">
          <div className="diff-thread-meta">
            <span className="diff-thread-who">{who(thread.by.id, thread.by.name)}</span>
            {thread.resolved && (
              <span className="diff-thread-done">
                <Icon name="check" size={11} />
                {thread.auto ? "Closed by the change" : "Resolved"}
              </span>
            )}
            {thread.endLine && thread.endLine > thread.line && (
              <span className="diff-thread-range" title="The note is about this block of lines">
                lines {thread.line}–{thread.endLine}
              </span>
            )}
            {!thread.resolved && thread.sent && (
              <span className="diff-thread-with">
                <span className="pulse-dot" /> With {agent}
              </span>
            )}
            {/* A question for the agent that nobody has passed on yet: the driver passes it with one press. */}
            {!thread.resolved && !thread.sent && thread.ask && (
              <span className="diff-thread-ask" title={canSend ? "Pass it to the agent and it answers here" : "Waiting for the driver to pass it on"}>
                <Icon name="help" size={11} /> Question for {agent}
              </span>
            )}
          </div>
          <p className="diff-thread-text">{thread.text}</p>
        </div>
      </div>

      {thread.replies.map((r) => (
        <div key={r.seq} className="diff-thread-msg is-reply">
          <Avatar name={r.by.name} id={r.by.id} size={20} />
          <div className="diff-thread-body">
            <div className="diff-thread-meta">
              <span className="diff-thread-who">{who(r.by.id, r.by.name)}</span>
            </div>
            <p className="diff-thread-text">{r.text}</p>
          </div>
        </div>
      ))}

      {failed && <p className="diff-thread-failed">{failed}</p>}

      {send &&
        !thread.resolved &&
        (replying ? (
          <div className="diff-thread-reply-box">
            <CommentBox
              initial=""
              placeholder="Reply"
              save="Reply"
              onCancel={() => setReplying(false)}
              onSave={(text) => {
                setReplying(false);
                if (text.trim()) void run({ type: "thread.reply", id: thread.id, text: text.trim() });
              }}
            />
          </div>
        ) : (
          <div className="diff-thread-actions">
            <button type="button" className="thread-btn" onClick={() => setReplying(true)}>
              <Icon name="message" size={12} />
              Reply
            </button>
            {canSend && !thread.sent && (
              <button type="button" className="thread-btn is-send" title={`Give this to ${agent} as a task. It closes when the change lands.`} onClick={() => void run({ type: "thread.send", id: thread.id, ...(lane && lane !== MAIN_LANE ? { lane } : {}) })}>
                <Icon name="send" size={12} />
                {thread.ask ? `Pass to ${agent}` : `Send to ${agent}`}
              </button>
            )}
            <button type="button" className="thread-btn is-resolve" onClick={() => void run({ type: "thread.resolve", id: thread.id })}>
              <Icon name="check" size={12} />
              Resolve
            </button>
          </div>
        ))}
      {send && thread.resolved && (thread.auto || mine) && (
        <div className="diff-thread-actions">
          <button type="button" className="thread-btn" title={thread.auto ? "The change didn't answer it? Open it again." : "Open it again"} onClick={() => void run({ type: "thread.reopen", id: thread.id })}>
            <Icon name="refresh" size={12} />
            Reopen
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * "I'd do this differently", raised at one step of a run.
 *
 * A viewer watching a run can say so at the step itself, and it lands as a suggestion the driver sees right there,
 * under that step, with one press to send it on or put it aside. The same suggestion is in the driver's pile too; this
 * is the place it is about.
 */
function StepRaise({ ctx, lane, call, step, via }: { ctx: Ctx; lane: string; call: string; step: string; via: ReviewVia }) {
  const [open, setOpen] = useState(false);
  const { state, me, send } = ctx;
  const raised = state.suggestions.filter((s) => s.at?.call === call && !s.dismissed);
  const driving = driverOf(state, lane)?.id === me.id;
  if (!raised.length && via !== "suggest") return null;
  const run = async (cmd: Record<string, unknown>) => {
    const r = await send({ ...cmd, quiet: true });
    if (!r.ok) ctx.notify(r.error ?? "That didn't go through.");
    return r.ok;
  };
  return (
    <div className="rsp-raise">
      {raised.map((s) => (
        <div key={s.seq} className={`rsp-raised ${s.promoted ? "sent" : ""}`}>
          <Avatar name={s.from.name} id={s.from.id} size={18} />
          <span className="rsp-raised-text">
            <b>{s.from.id === me.id ? "You" : s.from.name.split(/\s+/)[0]}</b> {s.text}
          </span>
          {s.promoted ? (
            <span className="rsp-raised-state">sent</span>
          ) : driving ? (
            <span className="rsp-raised-actions">
              <button type="button" className="btn small primary" onClick={() => void run({ type: "promote", seq: s.seq })}>
                Send
              </button>
              <button type="button" className="icon-btn tiny" aria-label="Put aside" title="Put aside" onClick={() => void run({ type: "suggestion.dismiss", seq: s.seq })}>
                <Icon name="x" size={12} />
              </button>
            </span>
          ) : (
            <span className="rsp-raised-state">for the driver</span>
          )}
        </div>
      ))}
      {via === "suggest" &&
        (open ? (
          <CommentBox
            initial=""
            placeholder="What would you do here instead?"
            save="Raise it"
            onCancel={() => setOpen(false)}
            onSave={(text) => {
              setOpen(false);
              if (text.trim()) void run({ type: "suggest", text: text.trim(), at: { call, step }, ...(lane !== MAIN_LANE ? { lane } : {}) });
            }}
          />
        ) : (
          <button type="button" className="rsp-raise-btn" onClick={() => setOpen(true)}>
            <Icon name="hand" size={12} /> I'd do this differently
          </button>
        ))}
    </div>
  );
}

function CommentBox({
  initial,
  onSave,
  onCancel,
  onAsk,
  placeholder = "What should change here?",
  save = "Comment",
  label,
}: {
  initial: string;
  onSave: (text: string) => void;
  onCancel: () => void;
  /** A second way out: the words are a question for the agent, not a change to make. */
  onAsk?: (text: string) => void;
  placeholder?: string;
  save?: string;
  /** What the note is about, when it is more than the line it sits under ("Lines 12–20"). */
  label?: string;
}) {
  const [text, setText] = useState(initial);
  return (
    <div className="diff-comment-box">
      {label && <div className="diff-comment-label">{label}</div>}
      <textarea
        aria-label="Reply"
        autoFocus
        rows={2}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSave(text);
          if (e.key === "Escape") onCancel();
        }}
      />
      <div className="diff-comment-actions">
        <span className="muted small">Ctrl+Enter</span>
        <button type="button" className="btn ghost small" onClick={onCancel}>
          Cancel
        </button>
        {onAsk && (
          <button type="button" className="btn ghost small" disabled={!text.trim()} title="Ask the agent to explain this code; it changes nothing" onClick={() => onAsk(text)}>
            Ask the agent
          </button>
        )}
        <button type="button" className="btn small" disabled={!text.trim()} onClick={() => onSave(text)}>
          {save}
        </button>
      </div>
    </div>
  );
}

const MODE_LABEL: Record<EngineMode, string> = { plan: "plan", edits: "manual", full: "auto" };

// ── notices ───────────────────────────────────────────────────────────

/**
 * An agent on a Manual machine asking before it acts: the commands it wants to run, or what it was stopped from doing.
 * The driver of that lane answers; everyone else can see what was asked.
 */
/**
 * Who may answer a permission card, and how. The driver answers by writing to the lane; an editor the owner allowed, an owner,
 * and the host of the Manual machine it would run on answer with approval.answer. On a Manual machine somebody attached, a yes
 * is its host's alone (the server refuses anyone else's), so everyone else is offered only No and told to wait for the host.
 */
export function answerRights(state: SessionState, me: { id: string; role: Member["role"] }, lane: string, b: { id: string; scope: string; items: string[] }) {
  const waiting = state.approvals[lane]?.id === b.id;
  const machine = liveMachine(state, lane) ?? state.engines[lane];
  const manual = machine?.mode === "edits" ? machine : undefined;
  const host = waiting && !!manual && manual.hostId === me.id;
  const mayDrive = waiting && canDriveLane(state, me.id, lane);
  // An editor the owner allowed to approve this kind of command: decided here for the buttons, and again on the server for the answer.
  const allowedKinds = me.role === "editor" ? (state.options.approve?.editor ?? []) : [];
  const delegated = waiting && !mayDrive && b.scope === "commands" && b.items.length > 0 && allowedKinds.length > 0 && b.items.every((i) => mayApprove(allowedKinds, i));
  const driver = driverOf(state, lane);
  // The driver answers by writing to the lane; everyone else, including anyone who could drive when nobody does, answers directly,
  // so pressing a card never takes the wheel.
  const viaInstruct = mayDrive && driver?.id === me.id;
  return {
    waiting,
    mayDrive,
    allowedKinds,
    may: mayDrive || delegated || host,
    viaInstruct,
    /** Null when this viewer's yes counts; otherwise the host whose yes it is. */
    hostWait: manual && !host ? manual.hostName : null,
  };
}

function PermissionCard({ ev, ctx }: { ev: Ev<"engine.approval">; ctx: Ctx }) {
  const { state, me, send } = ctx;
  const b = ev.body;
  const lane = ev.lane ?? MAIN_LANE;
  const { waiting, mayDrive, allowedKinds, may, viaInstruct, hostWait } = answerRights(state, me, lane, b);
  const who = agentNameFor(state, lane);
  const [busy, setBusy] = useState(false);
  const answer = async (approve: boolean) => {
    if (approve && hostWait) return;
    setBusy(true);
    const text = approve ? (b.scope === "commands" ? "Yes, run it." : "Yes, go ahead.") : "No, don't.";
    const r = await send(viaInstruct ? { type: "instruct", lane, text, approval: { id: b.id, approve }, quiet: true } : { type: "approval.answer", lane, id: b.id, approve, quiet: true });
    setBusy(false);
    if (!r.ok) ctx.notify(r.error ?? "Couldn't send that. Check your connection and try again.");
  };
  return (
    <div
      className={cn("apv", !waiting && "done")}
      data-needs={waiting && may ? lane : undefined}
      role="group"
      aria-label="Permission needed"
      tabIndex={waiting && may ? 0 : -1}
      // While the card has focus, one key answers it: a for yes, d for no.
      onKeyDown={(e) => {
        if (!waiting || !may || busy || e.target !== e.currentTarget) return;
        if (e.key === "a" || e.key === "A") (e.preventDefault(), void answer(true));
        else if (e.key === "d" || e.key === "D") (e.preventDefault(), void answer(false));
      }}
    >
      <div className="apv-head">
        <Icon name="shield" size={14} />
        <span>
          {who} {b.scope === "commands" ? (b.items.length === 1 ? "wants to run a command" : `wants to run ${b.items.length} commands`) : b.live ? "is asking before it goes on" : "was stopped from changing things"}
        </span>
        <span className="apv-stamp">
          <Stamp ev={ev} />
        </span>
      </div>
      <ul className="apv-items">
        {b.items.map((i) => (
          <li key={i}>
            <code>{i}</code>
            {b.scope === "commands" && <span className="apv-kind">{CLASS_LABEL[headlineClass(i)].label}</span>}
          </li>
        ))}
      </ul>
      {b.why && <p className="apv-note">{b.why}</p>}
      {b.scope === "turn" && !b.live && <p className="apv-note">{b.tool ? ENGINE_NAMES[b.tool] : "This tool"} can't ask about one thing at a time, so a yes lets it try the whole turn again with permission to change files and run commands.</p>}
      {waiting &&
        (may ? (
          <div className="apv-actions">
            <button type="button" className="btn small" disabled={busy} title="Don't run it (D while the card has focus)" aria-keyshortcuts="D" onClick={() => void answer(false)}>
              Don't
            </button>
            {/* The allow list is the session's settings, which only an owner changes: offered to them alone, and the command is let
                through only once the list has taken it (it used to be let through on a refusal too). */}
            {/* One press, not a menu to choose from: what it allows follows from what the command is (alwaysAllowEntry), and the
                tooltip and the note after say exactly that, with where to take it back. */}
            {b.scope === "commands" && mayDrive && me.role === "owner" && !hostWait && (() => {
              const entries = b.items.map(alwaysAllowEntry);
              const said = entries.map((a) => (a.endsWith("*") ? `“${a.slice(0, -1).trim()} …”` : `“${a}”`)).join(", ");
              return (
                <button
                  type="button"
                  className="btn small"
                  disabled={busy}
                  title={`Run it, and from now on run ${said} without asking`}
                  onClick={() =>
                    void send({ type: "settings.update", allow: [...new Set([...(state.options.allow ?? []), ...entries])] }).then((r) => {
                      if (!r.ok) return ctx.notify(r.error ?? "Couldn't add that to the allow list.");
                      ctx.notify(`${said} runs without asking now. Take it back under Session settings.`);
                      return answer(true);
                    })
                  }
                >
                  Always allow
                </button>
              );
            })()}
            {hostWait ? (
              <span className="apv-note" title={`${hostWait}'s computer is in Manual, so only ${hostWait} can say yes to commands on it. Ask ${hostWait}, or ${hostWait} can switch it to Auto.`}>
                Waiting for {hostWait} to say yes: it's {hostWait}'s computer, in Manual.
              </span>
            ) : (
              <button type="button" className="btn primary small" disabled={busy} title={`${b.scope === "commands" ? "Run it once" : "Let it go ahead"} (A while the card has focus)`} aria-keyshortcuts="A" onClick={() => void answer(true)}>
                {b.scope === "commands" ? "Run it" : "Let it"}
              </button>
            )}
          </div>
        ) : (
          <p className="apv-note">
            Waiting for {hostWait ?? state.laneDrivers[lane]?.name ?? state.driver?.name ?? "whoever is driving"} to answer.
            {me.role === "editor" && allowedKinds.length > 0 && b.scope === "commands" && " You can answer commands of the kinds the owner allowed, but not this one."}
          </p>
        ))}
    </div>
  );
}

const EventItem = memo(function EventItem({ ev, ctx }: { ev: SessionEvent; ctx: Ctx }) {
  const { me, state } = ctx;
  const b = ev.body;
  const who = ev.actor.id === me.id ? "You" : ev.actor.name;
  const nameOf = (id: string) => (id === me.id ? "you" : (state.members[id]?.name ?? "someone"));

  switch (b.type) {
    case "instruction":
    case "suggestion":
      // Clicking Run it / Don't answers the agent; it is not something the person typed, so it is not shown as a message.
      if (b.type === "instruction" && b.approval) return null;
      // What Friday or the reviewer told the agent is one line, with the full text a press away: it is not a person speaking.
      if (b.type === "instruction" && ev.actor.kind === "system" && (ev.actor.id === "friday" || ev.actor.id === "reviewer")) return <SystemAsk ev={ev as Ev<"instruction">} />;
      // A message from another session's agent: where it came from, not a person here speaking.
      if (b.type === "instruction" && b.peer) return <PeerCard ev={ev as Ev<"instruction">} ctx={ctx} />;
      // One agent here writing to another (agent-mesh.ts): a thread, with the answer under a question.
      if (b.type === "instruction" && b.mesh) {
        // A message to the team (message_team) is one card with everyone it went to, under the first of its copies.
        const copies = b.mesh.team ? ctx.events.filter((e) => e.body.type === "instruction" && e.body.mesh?.team === b.mesh!.team) : [];
        if (copies.length > 1 && copies[0]!.seq !== ev.seq) return null;
        const team = copies.length > 1 ? copies.map((e) => (e.body.type === "instruction" ? (e.body.mesh?.toName ?? "") : "")) : undefined;
        return <AgentTalkCard ev={ev} state={state} me={me} send={ctx.send} notify={ctx.notify} delivered={ctx.delivered} stamp={<Stamp ev={ev} />} {...(team ? { team } : {})} />;
      }
      // Said on a person's behalf by the session (a plan approved, Resume, the usage limit reset): one quiet line, not a message
      // they typed with "[session]" in front of it.
      if (b.type === "instruction" && b.text.startsWith("[session] "))
        return (
          <Notice ev={ev} icon={PlayIcon} tone="control">
            {b.text.slice("[session] ".length).split(/\r?\n/)[0]}
          </Notice>
        );
      return <HumanMessage ev={ev as Ev<"instruction">} ctx={ctx} />;
    case "chat":
      return <ChatMessage ev={ev as Ev<"chat">} ctx={ctx} />;
    case "peer.sent":
    case "peer.held":
      return <PeerCard ev={ev as Ev<"peer.sent"> | Ev<"peer.held">} ctx={ctx} />;
    case "lead.set": {
      let them = "agent";
      let does = "it hands the other agents their part of the work and puts it together";
      if (state.options.team) them = "teammate";
      // Teammates are "they" (Arun, 2026-10-28: the critique's copy notes).
      if (state.options.team) does = "they hand the other teammates their part of the work and put it together";
      // A lead Friday picked as the agents changed (a room made or its members changed) rather than one somebody chose: said as
      // who leads, not as "You made Juno the lead" when nobody did (2026-10-27 audit). The log says which (lead.set auto), where
      // the timing of the event before it was a guess.
      const picked = !!b.auto;
      return (
        <Notice ev={ev} icon={CrownIcon} tone="control">
          {b.lane && picked ? `${agentNameFor(state, b.lane)} leads: ${does}` : <>{who} {b.lane ? `made ${agentNameFor(state, b.lane)} the lead: ${does}` : `stopped any ${them} leading the others`}</>}
        </Notice>
      );
    }
    case "preview.asked":
      return (
        <Notice ev={ev} icon={PlayIcon} tone="control">
          {ev.actor.name} opened {b.ios ? "the iOS app" : <span className="mono">{(b.url ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "")}</span>} in the Preview{b.newTab ? ", in a new tab" : ""}
        </Notice>
      );
    case "board.posted":
      return <BoardCard ev={ev} state={state} stamp={<Stamp ev={ev} />} />;
    case "mesh.posted":
      return <AgentUpdateCard ev={ev} state={state} stamp={<Stamp ev={ev} />} />;
    case "teammate.folders":
      return <FoldersGiven ev={ev} stamp={<Stamp ev={ev} />} />;
    case "teammate.changed":
      return <TeammateChanged ev={ev} stamp={<Stamp ev={ev} />} />;
    case "teammate.switched":
      return <ToolSwitched ev={ev} stamp={<Stamp ev={ev} />} />;
    case "team.brief":
      // A brief of the same stretch posted later takes its place: the one so far, then the one as the person is back.
      if (ctx.events.some((e) => e.seq > ev.seq && e.body.type === "team.brief" && e.body.since === b.since)) return null;
      return <BriefCard ev={ev} sid={ctx.sid} stamp={<Stamp ev={ev} />} />;
    case "teammate.proposed":
      return <ProposedMate ev={ev} identity={ctx.identity} stamp={<Stamp ev={ev} />} />;
    case "holds.lifted":
      return <HoldsLifted ev={ev} stamp={<Stamp ev={ev} />} />;
    case "mesh.paused":
      if (b.on) return <MeshPauseCard ev={ev} state={state} me={me} send={ctx.send} notify={ctx.notify} stamp={<Stamp ev={ev} />} />;
      return (
        <Notice ev={ev} icon={b.on ? PauseIcon : PlayIcon} tone="control">
          <MeshPauseText ev={ev} state={state} me={me} send={ctx.send} notify={ctx.notify} />
        </Notice>
      );
    case "hub.planned":
      return <HubCard ev={ev as Ev<"hub.planned">} ctx={ctx} />;
    case "hub.approved":
      return null;
    case "hub.task.started":
      return (
        <Notice ev={ev} icon={PlayIcon} tone="control">
          “{hubTaskTitle(state, b.id, b.task)}” {b.attempt > 1 ? "goes again" : "started"} on {ENGINE_NAMES[b.tool]}
        </Notice>
      );
    case "hub.task.ended":
      return (
        <Notice ev={ev} icon={b.outcome === "done" ? CheckIcon : XIcon} tone={b.outcome === "done" ? "control" : "danger"}>
          “{hubTaskTitle(state, b.id, b.task)}” {b.outcome === "done" ? "done" : b.outcome === "failed" ? "didn't get through" : "wasn't started"}
          {b.outcome === "done" && b.tests !== "none" ? ` · tests ${b.tests === "pass" ? "passed" : "failed"}` : ""}
          {b.outcome === "done" && b.files ? ` · ${b.files} file${b.files === 1 ? "" : "s"}` : ""}
        </Notice>
      );
    case "hub.merged":
      return (
        <Notice ev={ev} icon={b.conflicts.length ? XIcon : CheckIcon} tone={b.conflicts.length ? "danger" : "control"}>
          {b.files ? `${b.files} file${b.files === 1 ? "" : "s"} from “${hubTaskTitle(state, b.id, b.task)}” brought into the folder` : `Nothing new from “${hubTaskTitle(state, b.id, b.task)}”`}
          {b.conflicts.length ? ` · conflicts in ${b.conflicts.slice(0, 3).join(", ")}${b.conflicts.length > 3 ? ` and ${b.conflicts.length - 3} more` : ""}` : ""}
        </Notice>
      );
    case "hub.ended":
      return (
        <Notice ev={ev} icon={b.outcome === "done" ? CheckIcon : XIcon} tone={b.outcome === "done" ? "control" : "danger"}>
          The hub {b.outcome === "done" ? `finished: ${b.done} of ${b.tasks} task${b.tasks === 1 ? "" : "s"} done` : b.outcome === "cancelled" ? "was cancelled" : `failed: ${b.why ?? "no task got through"}`}
          {b.prUrl && (
            <a className="link-btn cp-action" href={b.prUrl} target="_blank" rel="noreferrer">
              Open pull request
            </a>
          )}
        </Notice>
      );
    case "folder.committed":
      return (
        <Notice ev={ev} icon={CheckIcon} tone={b.error ? "danger" : "control"}>
          {who} committed {b.files} file{b.files === 1 ? "" : "s"}
          {b.branch ? ` to ${b.branch}` : ""}: “{b.message.split("\n")[0]}”
          {b.prUrl && b.base && !/^(main|master|trunk|develop)$/.test(b.base) ? ` · stacked on ${b.base}` : ""}
          {b.pushed && !b.prUrl && " · pushed"}
          {b.prUrl && (
            <a className="link-btn cp-action" href={b.prUrl} target="_blank" rel="noreferrer">
              {b.prCreated ? "Open pull request" : "Create pull request"}
            </a>
          )}
          {b.prUrl && b.prCreated && canDriveLane(state, me.id, ev.lane ?? MAIN_LANE) && (
            <button
              type="button"
              className="link-btn cp-action"
              title="Read what reviewers wrote on the pull request and give it to the agent"
              onClick={async () => {
                const r = await ctx.send({ type: "pr.feedback", lane: ev.lane ?? MAIN_LANE });
                ctx.notify(r.ok ? "Review comments sent to the agent." : (r.error ?? "Couldn't read the pull request."));
              }}
            >
              Pull in review comments
            </button>
          )}
          {b.prUrl && b.prCreated && (me.role === "owner" || driverOf(state, ev.lane ?? MAIN_LANE)?.id === me.id) && (
            <button
              type="button"
              className="link-btn cp-action"
              title={state.shepherd?.prUrl === b.prUrl ? "Stop watching the pull request; nothing more is pushed" : "Friday watches the pull request, hands red checks and new review comments to the agent, and pushes the fixes until it merges"}
              onClick={async () => {
                const on = state.shepherd?.prUrl !== b.prUrl;
                const r = await ctx.send({ type: "pr.shepherd", on, lane: ev.lane ?? MAIN_LANE });
                if (!r.ok) ctx.notify(r.error ?? "Couldn't hand the pull request over.");
              }}
            >
              {state.shepherd?.prUrl === b.prUrl ? "Stop seeing it through" : "See it through to merge"}
            </button>
          )}
          {b.prUrl && b.prCreated && canDriveLane(state, me.id, ev.lane ?? MAIN_LANE) && (
            <button
              type="button"
              className="link-btn cp-action"
              title="Read the logs of the checks that failed on the pull request and give them to the agent"
              onClick={async () => {
                const r = await ctx.send({ type: "pr.checks", lane: ev.lane ?? MAIN_LANE });
                ctx.notify(r.ok ? "The failing checks are with the agent." : (r.error ?? "Couldn't read the checks. Make sure gh is signed in on the connected machine, then try again."));
              }}
            >
              Fix the failing checks
            </button>
          )}
          {b.error && ` · not pushed: ${b.error}`}
        </Notice>
      );
    case "review.started":
    case "review.done":
      // Said on the change it is about, on the review card, not as a line of its own.
      return null;
    case "pr.shepherd":
      return (
        <Notice ev={ev} icon={GitPullRequestIcon} tone="control">
          {b.on ? `${who} asked Friday to see the pull request through to merge. It hands red checks and new review comments to the agent and pushes the fixes.` : `${who} took the pull request back from Friday.`}
        </Notice>
      );
    case "pr.shepherd.step":
      return (
        <Notice ev={ev} icon={GitPullRequestIcon} tone="control">
          {b.text}
        </Notice>
      );
    case "pr.shepherd.ended":
      return (
        <Notice ev={ev} icon={b.outcome === "stopped" ? CircleHelpIcon : GitPullRequestIcon} tone={b.outcome === "stopped" ? "danger" : "control"}>
          {b.text}
        </Notice>
      );
    case "resume.scheduled":
      return (
        <Notice ev={ev} icon={ClockIcon} tone="control">
          {b.auto
            ? `${agentNameFor(ctx.state, ev.lane ?? MAIN_LANE)} carries on by itself at ${clockTime(b.at)}, when its usage resets: no other agent here could take it meanwhile.`
            : `${ev.actor.name.split(/\s+/)[0]} set ${agentNameFor(ctx.state, ev.lane ?? MAIN_LANE)} to carry on at ${clockTime(b.at)}, when its usage resets.`}
        </Notice>
      );
    case "resume.cancelled":
      return (
        <Notice ev={ev} icon={ClockIcon} tone={b.why ? "warn" : "control"}>
          {b.why ? `${agentNameFor(ctx.state, ev.lane ?? MAIN_LANE)} didn't carry on by itself: ${b.why}` : `${ev.actor.name.split(/\s+/)[0]} called off ${agentNameFor(ctx.state, ev.lane ?? MAIN_LANE)} carrying on by itself.`}
        </Notice>
      );
    case "run.capped":
      return (
        <Notice ev={ev} icon={CircleHelpIcon} tone="danger">
          {cappedText(b.spent, b.cap)}
        </Notice>
      );
    case "files.overlap":
      return (
        // Two agents heading for one file, said before either writes it: whoever reads this can settle who does it.
        <Notice ev={ev} icon={GitMergeIcon} tone="warn">
          {agentNameFor(state, b.lane)}'s plan changes <code>{b.path}</code>, which {b.with.length === 1 ? b.with[0] : `${b.with.slice(0, -1).join(", ")} and ${b.with.at(-1)}`} {b.with.length === 1 ? "is" : "are"} also working on. Settle who does it before either writes, or they'll meet in a merge conflict.
        </Notice>
      );
    case "run.guarded":
      return (
        // A pause that protects the run, not a failure: said like the pause it is, with the command as code.
        <Notice ev={ev} icon={PauseIcon} tone="warn">
          {withCode(runawayText(b))}
        </Notice>
      );
    case "lane.othersFull":
      return (
        <Notice ev={ev} icon={SettingsIcon} tone="control">
          {b.on ? `${who} let everyone's messages run this agent as far as their own on their computer` : `${who} set others' messages to run this agent no further than Edits on their computer`}
        </Notice>
      );
    case "lane.effort":
      return (
        <Notice ev={ev} icon={SettingsIcon} tone="control">
          {effortNote(who, b.tool, b.effort, b.running)}
        </Notice>
      );
    // Not said in the chat: switching the terminal view on and off is how it is looked at, not something that happened (Arun,
    // 2026-10-30: "get rid of these logs in chat too"). The note over the box says while it is out.
    case "lane.terminal":
      return null;
    case "effort.skipped":
      return (
        <Notice ev={ev} icon={CircleHelpIcon} tone="warn">
          {b.tool ? ENGINE_NAMES[b.tool] : "This agent"} on {state.engines[ev.lane ?? MAIN_LANE]?.hostName ?? "this computer"} doesn't support effort levels; using its default instead of {ENGINE_EFFORT_INFO[b.effort].label}.
        </Notice>
      );
    case "account.switched":
      return (
        <Notice ev={ev} icon={UserPlusIcon} tone="warn">
          {b.tool ? ENGINE_NAMES[b.tool] : "This agent"}'s {b.from.label} account ran out of usage{b.until ? ` until ${clockTime(b.until)}` : ""}, so it carried on as {b.to.label}
        </Notice>
      );
    case "brain.briefed": {
      const tools = b.tools.length ? ` by ${b.tools.length} agent${b.tools.length === 1 ? "" : "s"}` : "";
      return (
        <Notice ev={ev} icon={BrainIcon} tone="control">
          Briefed on {b.repo}: {b.count} thing{b.count === 1 ? "" : "s"} learned{tools} in {b.sessions} earlier session{b.sessions === 1 ? "" : "s"}
        </Notice>
      );
    }
    case "folder.applied": {
      const where = b.into.split(/[\\/]/).filter(Boolean).pop() ?? "the folder";
      return (
        <Notice ev={ev} icon={b.conflicts?.length ? CircleHelpIcon : CheckIcon} tone={b.conflicts?.length ? "danger" : "control"}>
          {who} brought {b.files} file{b.files === 1 ? "" : "s"} into {where}
          {b.conflicts?.length ? ` · changed there meanwhile too, so check ${b.conflicts.length === 1 ? "it" : "them"}: ${b.conflicts.slice(0, 4).join(", ")}${b.conflicts.length > 4 ? "…" : ""}` : ""}
        </Notice>
      );
    }
    case "goal.set":
      return (
        <Notice ev={ev} icon={FlagIcon} tone="control">
          {who} set the goal: “{b.text}”{b.check ? <> · proof: <code>{b.check}</code></> : ""}. Every finished turn is read against it.
        </Notice>
      );
    case "goal.checked":
      return (
        <Notice ev={ev} icon={b.met ? CheckIcon : FlagIcon} tone={b.met ? "control" : ""}>
          {b.met ? <b>Goal met.</b> : b.nudge ? "Goal not met yet; the agent was told to carry on." : "Goal not met yet."} {b.why}
        </Notice>
      );
    case "goal.cleared":
      return (
        <Notice ev={ev} icon={FlagIcon}>
          {who} stopped the goal.
        </Notice>
      );
    case "folder.git":
      return (
        <Notice ev={ev} icon={b.action === "pull" ? CheckIcon : Undo2Icon} tone="control">
          {b.action === "pull"
            ? `${who} pulled the upstream's new commits${b.note ? `: ${b.note.split("\n").find((l) => /files? changed|Already up to date|Fast-forward/.test(l)) ?? ""}` : ""}`
            : `${who} threw away the changes to ${b.paths?.length === 1 ? b.paths[0] : `${b.paths?.length ?? 0} files`} in the Git panel`}
        </Notice>
      );
    case "folder.restored": {
      const mayRedo = ctx.me.role === "owner" || driverOf(state, ev.lane ?? MAIN_LANE)?.id === me.id;
      return (
        <Notice ev={ev} icon={Undo2Icon} tone="control">
          {b.rewoundTo !== undefined ? `${who} rewound to before an earlier message` : `${who} undid a run`}: {b.restored} file{b.restored === 1 ? "" : "s"} put back{b.removed ? `, ${b.removed} removed` : ""}
          {b.rewoundTo !== undefined && " · what followed is set aside"}
          {mayRedo && b.rewoundTo === undefined && (
            <button type="button" className="link-btn cp-action" onClick={() => ctx.send({ type: "folder.restore", sha: b.undo, lane: ev.lane ?? MAIN_LANE })}>
              <Redo2Icon className="size-3" /> Redo
            </button>
          )}
        </Notice>
      );
    }
    case "session.created":
      return (
        <Notice ev={ev} icon={SparklesIcon}>
          Session started by {b.ownerName}
          {b.options?.agent ? ` with ${b.options.agent.name}` : ""}
        </Notice>
      );
    case "session.updated": {
      const o = b.options;
      const changes = [
        b.title && `renamed the session to “${b.title}”`,
        o.agent !== undefined && (o.agent ? `switched the agent to ${o.agent.name}` : "switched back to the default agent"),
        o.controlMode && `set handoff to ${o.controlMode === "takeover" ? "instant takeover" : "ask the driver"}`,
        o.webSearch !== undefined && `turned web search ${o.webSearch ? "on" : "off"}`,
        o.thinking !== undefined && `set thinking to ${o.thinking}`,
        o.mcp !== undefined && `turned connections ${o.mcp ? "on" : "off"}`,
        o.policy && "changed what people can do",
      ].filter(Boolean);
      // Switching model says nothing here on purpose: it changes what the
      // next step costs, not what the room is looking at, and a row reading
      // "You" with nothing after it is worse than no row. The event is still
      // in the log for anyone auditing the session.
      if (!changes.length) return null;
      return (
        <Notice ev={ev} icon={b.title ? PencilIcon : SettingsIcon} tone="control">
          {who} {changes.join(", ")}
        </Notice>
      );
    }
    case "plan.reviewed":
      return (
        <Notice ev={ev} icon={b.verdict === "approve" ? CheckIcon : PencilIcon} tone={b.verdict === "approve" ? "control" : "warn"}>
          {who} {b.verdict === "approve" ? "signed off on the plan" : "asked for changes to the plan"}
          {b.note ? `: “${b.note}”` : ""}
        </Notice>
      );
    case "pr.feedback":
      return (
        <Notice ev={ev} icon={ListChecksIcon} tone="control">
          {b.count ? `${b.count} review comment${b.count === 1 ? "" : "s"} passed to the agent` : ""}
          {b.held ? (b.count ? `, ${b.held} held back (no write access)` : `${b.held} new comment${b.held === 1 ? "" : "s"} held back: no write access to the repo`) : ""}
          <a className="link-btn cp-action" href={b.prUrl} target="_blank" rel="noreferrer">
            {b.held ? "Read them on GitHub" : "Open pull request"}
          </a>
        </Notice>
      );
    case "member.joined":
      return (
        <Notice ev={ev} icon={UserPlusIcon}>
          {who} joined as {b.role}
        </Notice>
      );
    case "session.moved":
      return (
        <Notice ev={ev} icon={UserPlusIcon} tone="control">
          {who} brought this session into {b.workspaceName}, so the people invited can work in it
        </Notice>
      );
    case "member.role_changed":
      return (
        <Notice ev={ev} icon={UserPlusIcon} tone="control">
          {who} made {nameOf(b.userId)} {b.role === "viewer" ? "a" : "an"} {b.role}
        </Notice>
      );
    case "member.removed":
      return (
        <Notice ev={ev} icon={UserMinusIcon} tone="danger">
          {who} removed {b.name} from the session
        </Notice>
      );
    case "link.updated":
      return (
        <Notice ev={ev} icon={LinkIcon} tone="control">
          {who} {b.enabled ? `updated the ${b.role} invite link` : `turned off the ${b.role} invite link`}
        </Notice>
      );
    case "control.requested":
      return (
        <Notice ev={ev} icon={HandIcon} tone="control">
          {who} asked for control
        </Notice>
      );
    case "role.requested":
      return (
        <Notice ev={ev} icon={HandIcon} tone="control">
          {who} asked to edit
        </Notice>
      );
    case "role.declined":
      return null;
    case "control.granted": {
      const text =
        b.reason === "claim"
          ? `${b.toName} took control`
          : b.reason === "yield"
            ? `${who} handed control to ${b.toName}`
            : b.reason === "force"
              ? `${b.toName} forced a takeover`
              : b.reason === "takeover"
                ? `${b.toName} took over control`
                : `${b.toName} took over automatically (the driver disconnected)`;
      return (
        <Notice ev={ev} icon={HandIcon} tone="control">
          {text}
        </Notice>
      );
    }
    case "control.denied":
      return (
        <Notice ev={ev} icon={HandIcon} tone="control">
          {who} declined {nameOf(b.to)}'s request
        </Notice>
      );
    case "control.released":
      return (
        <Notice ev={ev} icon={HandIcon} tone="control">
          {b.reason === "yield"
            ? `${who} released control`
            : b.reason === "disconnect"
              ? `${nameOf(b.from)} disconnected, so nobody has control`
              : `${nameOf(b.from)} lost control (${b.reason === "removed" ? "removed" : "role changed"})`}
        </Notice>
      );
    case "run.pause":
      // A person stopping a task is a stop marker, said quietly: amber is for what waits on you (DIRECTION.md §1.4).
      return (
        <Notice ev={ev} icon={SquareIcon}>
          {who} stopped {ev.lane && ev.lane !== MAIN_LANE ? `${agentNameFor(ctx.state, ev.lane)}'s` : "the agent's"} task
        </Notice>
      );
    case "run.resume":
      return (
        <Notice ev={ev} icon={PlayIcon}>
          {who} resumed the agent
        </Notice>
      );
    case "run.cancel":
      return (
        <Notice ev={ev} icon={SquareIcon} tone="danger">
          {who} cancelled the run
        </Notice>
      );
    case "run.ended": {
      // Stopped before it ran because its tool isn't signed in (a first message on a fresh install, most often): the way to sign
      // in, where it stopped, as a finished turn has it, rather than red words saying to run a command in a terminal (Arun,
      // 2026-10-30: the first few minutes after install are where people quit).
      const lane = ev.lane ?? MAIN_LANE;
      if (b.outcome === "error" && signedOut(b.error)) {
        const latest = ctx.events.findLast((e) => e.body.type === "run.ended" && (e.lane ?? MAIN_LANE) === lane)?.seq === ev.seq;
        return <SignedOutNote ctx={ctx} lane={lane} latest={latest} />;
      }
      return (
        <Notice ev={ev} icon={XIcon} tone="danger">
          {/* A tool's raw error (a stack trace) is said as what it means, the trace itself one click away (Arun, 2026-10-29:
              "node:internal/modules/cjs/loader:1…"; activity-line.ts stoppedLine). */}
          {b.error && isRawError(b.error) ? (
            <details className="stop-detail">
              <summary>{((said) => (said.startsWith("Stopped: ") ? `Agent stopped: ${said.slice(9)}` : "Agent stopped on an error"))(stoppedLine(b.error))}</summary>
              <pre>{b.error}</pre>
            </details>
          ) : (
            <>Agent stopped: {b.error}</>
          )}
        </Notice>
      );
    }
    case "model.routed": {
      // An Auto lane's coding tool: the model picked for this message, against the tool's other models as they were weighed.
      if (b.tool) {
        const name = (id: string) => ENGINE_MODEL_INFO[b.tool!].find((m) => m.id === id)?.label ?? id;
        return (
          <Notice ev={ev} icon={SparklesIcon}>
            <details className="routed">
              <summary>
                Auto picked <b>{name(b.model)}</b> · {b.why}
              </summary>
              <RouteWhy
                tier={b.tier}
                why={b.why}
                options={(b.options ?? []).map((o) => ({ key: o.model, label: name(o.model), mark: <EngineMark tool={b.tool!} size={14} />, room: null, odds: o.success, cost: costMark(o.cost), best: o.model === b.model, value: o.model === b.model && forValue(o, b.options ?? []) }))}
              />
            </details>
          </Notice>
        );
      }
      const pro = !!b.model;
      return (
        <Notice ev={ev} icon={SparklesIcon}>
          <details className="routed">
            <summary>
              Auto picked <b>{pro ? "Friday Pro" : "Friday"}</b> · {b.why}
            </summary>
            <RouteWhy
              tier={b.tier}
              why={b.why}
              options={[
                { key: "base", label: "Friday", mark: <FridayMark size={14} />, room: 1, best: !pro },
              ]}
            />
          </details>
        </Notice>
      );
    }
    // Somebody else's work a coding tool on its host's own plan won't take (own-plan.ts): said where it would have run.
    case "instruction.refused":
      return (
        <Notice ev={ev} icon={LaptopIcon} tone="control">
          Not sent to the agent: {b.why}
        </Notice>
      );
    case "engine.expected":
      return (
        <Notice ev={ev} icon={LaptopIcon} tone="control">
          {who} set this lane to run on {b.hostId === me.id ? "your" : b.hostId === ev.actor.id ? "their" : `${b.hostName}'s`} {ENGINE_NAMES[b.tool]}. Instructions wait until it connects.
          {b.effortReset ? ` ${EFFORT_RESET_NOTE}.` : ""}
        </Notice>
      );
    case "engine.attached": {
      const e = b.engine;
      // In Work, one quiet line: who is working and in which folder, by its name; no computer, account, branch or mode (the
      // 2026-10-28 critique: "You connected your Claude Code on ArunsMacStudio · Main account · …/x on main · auto").
      if (ctx.state.options.work && e.tool) return <Notice ev={ev} icon={LaptopIcon} tone="control">{ENGINE_NAMES[e.tool]} is working in <b>{e.cwd.split(/[\\/]/).filter(Boolean).pop() ?? "its folder"}</b>{e.resumedFrom ? `, carrying on “${e.resumedFrom.title}”` : ""}</Notice>;
      return (
        <Notice ev={ev} icon={LaptopIcon} tone="control">
          {who} {e.tool ? "connected" : "lent"} {ev.actor.id === me.id ? "your" : "their"} {e.tool ? ENGINE_NAMES[e.tool] : "folder to Friday Code"}
          {e.machine ? ` on ${e.machine}` : ""}
          {/* "auto" as a model is Smart routing's pick ("Smart" on the pill): beside the mode, "auto · … · manual" read as two
              contradicting modes (2026-10-28 QA). The mode says it is one. */}
          {e.model ? ` · ${e.model === "auto" ? "Smart model" : e.model}` : ""}
          {e.account ? ` · ${e.account.label} account` : ""} · <span className="mono">{shortPath(e.cwd)}</span>
          {e.branch ? ` on ${e.branch}` : ""}
          {MODE_LABEL[e.mode] ? ` · ${MODE_LABEL[e.mode]} mode` : ""}
          {e.resumedFrom && ` · continuing “${e.resumedFrom.title}”${e.resumedFrom.messages ? ` (${e.resumedFrom.messages} messages)` : ""}`}
          {b.effortReset ? ` · ${EFFORT_RESET_NOTE}` : ""}
        </Notice>
      );
    }
    case "engine.approval":
      return <PermissionCard ev={ev as Ev<"engine.approval">} ctx={ctx} />;
    case "session.imported":
      return <ImportedNotice ev={ev as Ev<"session.imported">} />;
    case "engine.detached": {
      const tool = b.tool ? ENGINE_NAMES[b.tool] : "coding agent";
      if (b.reason === "released")
        return (
          <Notice ev={ev} icon={SparklesIcon} tone="control">
            {who} handed the lane back to Friday Code
          </Notice>
        );
      // Said only while it is still away. A tool comes back by itself after a drop, is brought back as its computer links
      // (app.ts reattach) or as the session opens, and "went offline" kept in the feed after that read as the tool being gone
      // (Arun, 2026-10-25: "the coding tool disconnected text").
      const e = ctx.state.engines[ev.lane ?? MAIN_LANE];
      if (!e || e.online || e.sinceSeq !== ev.seq) return null;
      return (
        <Notice ev={ev} icon={UnplugIcon} tone="warn">
          {ev.actor.id === me.id ? "Your" : `${ev.actor.name}'s`} {tool} went offline. Instructions wait until it reconnects.{" "}
          <Reconnect ev={ev} ctx={ctx} />
        </Notice>
      );
    }
    case "agent.diff":
      // Inside a run block this is rendered once at the end, from the newest
      // diff. Loose in the feed — a diff from a run whose messages have been
      // trimmed away — it stands on its own.
      return <DiffCard files={b.files} />;
  }
  return null;
});

/** "/Users/ada/code/app" → "~/code/app"-ish: the last two folders are what people recognise. */
const shortPath = (p: string) => {
  const parts = p.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p;
};

// ── above the composer ────────────────────────────────────────────────

/**
 * The plan, docked above the composer.
 *
 * It belongs next to the box you type in rather than buried in the run that
 * wrote it: a plan is a statement about now, and "how far along is this" is a
 * question you ask while deciding whether to send the next thing. It sits to
 * the right so the eye finds it without it taking a column of its own, opens
 * by default, and folds to its header when somebody would rather have the
 * room back.
 */
function LivePlan({ events, state, lane: only, team: withTeam = true, control }: { events: SessionEvent[]; state: SessionState; /** A column of one agent: its plan only. */ lane?: string; /** The team's tasks too: in one place only, not in every column of a split. */ team?: boolean; /** A person's say over a board task, from its row's menu. */ control?: (id: string, action: TaskAction, to?: string) => void }) {
  // One plan per lane, newest first: a session can have several agents working
  // at once, and two plans stacked with no names on them is worse than none.
  // Each says whose it is, and each is folded on its own.
  const plans = useMemo(() => {
    const byLane = new Map<string, ProgressStep[]>();
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      const b = e.body;
      if (b.type !== "agent.message") continue;
      const lane = e.lane ?? MAIN_LANE;
      if (byLane.has(lane) || (only && lane !== only)) continue;
      for (const c of [...b.toolCalls].reverse()) {
        if (c.name !== "todo" && c.name !== "update_plan") continue;
        const parsed = planSteps(parseArgs(c.arguments), runOf(state, lane).status === "running");
        if (parsed.length) {
          byLane.set(lane, parsed);
          break;
        }
      }
    }
    return [...byLane].filter(([, steps]) => steps.length);
  }, [events, state, only]);
  // What the agents handed each other, with who has each and where it stands: nearest the box (the stack runs upward), since
  // it is the one place the whole team's work is in a list.
  // Once every task is done or dropped, the list goes: a finished board has nothing left to watch (Arun, 2026-10-20). The
  // chat keeps the record of who did what.
  // Worked out again as the log moves on: the page folds each event into the same state object, so keyed on it alone the list
  // was the one from when the page opened, and a board posted while somebody watched never showed (2026-10-21).
  const all = useMemo(() => (withTeam ? teamTasks(state, jumpTo, control) : []), [state, state.lastSeq, withTeam]); // eslint-disable-line react-hooks/exhaustive-deps
  const team = all.some((t) => t.status !== "completed" && t.status !== "cancelled") ? all : [];
  let tasksTitle = "Team tasks";
  if (state.options.team) tasksTitle = "Crew tasks"; // The crew's board (Arun, 2026-10-28: "rename team to something else").
  // Stuck tasks, cleared in one go (Arun, 2026-10-21): handed out again to whoever is free (never to one that turned it down),
  // or dropped, so what waited on them goes ahead.
  const stuck = withTeam && control ? (state.board?.tasks ?? []).filter((t) => t.status === "blocked") : [];
  const stuckBar =
    stuck.length > 0 ? (
      <div className="tt-stuck">
        <span>
          {stuck.length} stuck
        </span>
        <button type="button" className="tt-stuck-btn" onClick={() => stuck.forEach((t) => control!(t.id, "retry"))}>
          Hand {stuck.length === 1 ? "it" : "them"} out again
        </button>
        <button type="button" className="tt-stuck-btn quiet" onClick={() => stuck.forEach((t) => control!(t.id, "cancel"))}>
          Drop {stuck.length === 1 ? "it" : "them"}
        </button>
      </div>
    ) : null;
  if (!plans.length && !team.length) return null;
  const many = plans.length > 1;
  return (
    <div className="dock-plan">
      <div className="dock-plan-stack">
        {team.length > 0 && (
          <DockTodo
            key="team"
            steps={team}
            title={tasksTitle}
            footer={stuckBar}
          />
        )}
        {plans.map(([lane, steps]) => {
          // A plan whose agent stopped with steps still open: no spinner on it anywhere, and said as it is, "Stopped at 3 of 5", with
          // the amber ring the Work rail gives it (2026-10-29: a stopped plan's tray still turned as if it were working).
          const live = runOf(state, lane).status === "running";
          const done = steps.filter((t) => t.status === "completed" || t.status === "cancelled").length;
          const stopped = !live && done < steps.length;
          let title = many ? agentNameFor(state, lane) : "To-dos";
          if (state.options.work && !many) title = "Progress"; // The rail's word for it, in Work (the 2026-10-28 critique).
          return (
            <DockTodo
              key={lane}
              steps={steps.map((t) => ({ id: t.id, title: t.title, status: t.status === "completed" ? "completed" : t.status === "active" && live ? "active" : t.status === "cancelled" ? "cancelled" : "pending" }))}
              // With several agents, the first thing to know is whose plan it is.
              title={stopped ? `${title} · stopped at ${done} of ${steps.length}` : title}
              {...(stopped ? { icon: <span className="dock-plan-stopped" aria-hidden="true" /> } : {})}
            />
          );
        })}
      </div>
    </div>
  );
}

/** A row of the team's tasks or an agent's plan, as the beui to-do list shows it (Arun, 2026-10-21: "use this component"):
 *  the title, with who has it and where it stands on a line under it, and its menu at the end. */
const todoItem = (t: TodoStep): TodoItem => ({
  id: t.id,
  title: t.title,
  status: t.status === "active" ? "in-progress" : t.status,
  ...(t.who || t.note
    ? {
        meta: (
          <>
            {t.who && <span className="dock-todo-who">{t.who}</span>}
            {t.who && t.note && <span aria-hidden="true">·</span>}
            {t.note && <span className={`dock-todo-note${t.tone ? ` ${t.tone}` : ""}`}>{t.note}</span>}
          </>
        ),
      }
    : {}),
  ...(t.detail ? { tooltip: t.detail } : {}),
  ...(t.onSelect ? { onSelect: t.onSelect } : {}),
  ...(t.actions ? { actions: t.actions } : {}),
});

/** One list above the input: a chip that never moves, its list floating above it while open (style.css .dock-todo). Opens and
 *  folds again when what it should be changes (the team's list opens when new work arrives); a press in between is kept. */
function DockTodo({ steps, title, icon, footer }: { steps: TodoStep[]; title: string; icon?: ReactNode; footer?: ReactNode }) {
  // Shut until somebody opens it (Arun, 2026-10-22: "keep it closed by default"): the chip says how far along it is, and the
  // list opened by itself over the conversation every time a session was opened or new work arrived.
  const [open, setOpen] = useState(false);
  const items = useMemo(() => steps.map(todoItem), [steps]);
  return (
    <div className="dock-todo" onKeyDown={(e) => e.key === "Escape" && open && (e.stopPropagation(), setOpen(false))}>
      <TodoList items={items} title={title} open={open} onOpenChange={setOpen} collapseOnComplete={false} maxHeight={300} {...(icon ? { icon } : {})} {...(footer ? { footer } : {})} />
    </div>
  );
}

/**
 * "Here is what I'll do": the plan-first gate.
 *
 * The agent has read and planned and its editing tools are held back; this is
 * where the driver lets them go. Shown once there is a plan to approve and the
 * agent has stopped, so it never asks about a plan that is still being written.
 */
function PlanApproval({ ctx, events, lane }: { ctx: Ctx; events: SessionEvent[]; lane: string }) {
  const { state, me, send } = ctx;
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const [sent, setSent] = useState("");
  // The plan while its approver is changing it; null when they are not.
  const [edit, setEdit] = useState<string[] | null>(null);
  /** Steps left unticked before approving: the agent proceeds through the rest only. Null means all of them. */
  const [unticked, setUnticked] = useState<Set<number>>(new Set());
  if (!state.options.planFirst) return null;
  const run = runOf(state, lane);
  if (run.status === "running" || (state.planApproved[lane] ?? 0) > run.sinceSeq) return null;
  const planned = events.some((e) => (e.lane ?? MAIN_LANE) === lane && e.seq > run.sinceSeq && e.body.type === "agent.message" && e.body.toolCalls.some((c) => c.name === "update_plan"));
  if (!planned) return null;
  const may = driverOf(state, lane)?.id === me.id || me.role === "owner";
  // Whoever can't approve can still say what they think of it; that is what a sign-off is.
  const reviewer = !may && me.role !== "viewer";
  const so = signoffStatus(state, lane, me.id);
  const reviews = Object.entries(state.planReviews[lane] ?? {}).filter(([id]) => id !== me.id || reviewer);
  const mine = state.planReviews[lane]?.[me.id];
  const lane_ = lane !== MAIN_LANE ? { lane } : {};
  const tick = (i: number) => setUnticked((cur) => {
    const next = new Set(cur);
    next.has(i) ? next.delete(i) : next.add(i);
    return next;
  });
  const why = !may ? "Only the driver or an owner can approve" : so.changes.length ? `${so.changes.map((c) => c.name).join(" and ")} asked for changes` : so.have < so.need ? `Needs ${so.need - so.have} more sign-off${so.need - so.have === 1 ? "" : "s"}` : undefined;
  const review = async (verdict: "approve" | "changes", text = "") => {
    const r = await send({ type: "plan.review", verdict, ...(text ? { note: text } : {}), ...lane_ });
    if (r.ok) {
      setNoting(false);
      setNote("");
      setSent(verdict);
    } else ctx.notify(r.error ?? "Couldn't record that. Try again.");
  };
  const asked = so.changes.filter((c) => c.note).map((c) => `${c.name}: ${c.note}`);
  // The newest plan this agent wrote this run, as words: what is being approved, in front of whoever is approving it.
  const lastPlan = [...events].reverse().find((e) => (e.lane ?? MAIN_LANE) === lane && e.seq > run.sinceSeq && e.body.type === "agent.message" && e.body.toolCalls.some((c) => c.name === "update_plan"));
  const planCall = lastPlan && lastPlan.body.type === "agent.message" ? lastPlan.body.toolCalls.filter((c) => c.name === "update_plan").at(-1) : undefined;
  const steps = planCall ? planSteps(parseArgs(planCall.arguments), false).map((x) => x.title) : [];
  const canComment = me.role !== "viewer";
  const move = (i: number, d: number) => setEdit((cur) => {
    if (!cur || i + d < 0 || i + d >= cur.length) return cur;
    const next = [...cur];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    return next;
  });
  const approveEdited = async () => {
    const r = await send({ type: "plan.approve", steps: (edit ?? []).map((x) => x.trim()).filter(Boolean), ...lane_ });
    if (r.ok) setEdit(null);
    else ctx.notify(r.error ?? "Couldn't approve that. Try again, or ask the driver to.");
  };
  return (
    <div className="plan-approval">
      <div>
        <div className="plan-approval-title">Plan ready{so.need > 0 && ` · ${so.have} of ${so.need} sign-off${so.need === 1 ? "" : "s"}`}</div>
        <div className="plan-approval-sub">
          {agentNameFor(state, lane)} can read but not change anything until {so.need > 0 ? "the team signs off and " : ""}you approve.
        </div>
        {reviews.length > 0 && (
          <div className="plan-reviews">
            {reviews.map(([id, r]) => (
              <span key={id} className={`plan-review ${r.verdict}`} title={r.note || (r.verdict === "approve" ? "Looks good" : "Wants changes")}>
                <Icon name={r.verdict === "approve" ? "check" : "pencil"} size={11} /> {id === me.id ? "You" : r.name}
                {r.note && <span className="plan-review-note"> — {r.note}</span>}
              </span>
            ))}
          </div>
        )}
        {steps.length > 0 && !edit && (
          <ol className="plan-steps">
            {steps.map((t, i) => (
              <li key={`${i}-${t}`} className={unticked.has(i) ? "unticked" : ""}>
                {may ? (
                  <input type="checkbox" className="plan-step-tick" checked={!unticked.has(i)} aria-label={`Step ${i + 1}: ${unticked.has(i) ? "left out" : "approved"}`} title={unticked.has(i) ? "Left out of what it may do" : "Untick to leave this step out"} onChange={() => tick(i)} />
                ) : (
                  <span className="plan-step-n">{i + 1}</span>
                )}
                <span className="plan-step-t">{t}</span>
                {canComment && !noting && (
                  <button type="button" className="icon-btn tiny plan-step-c" title="Comment on this step" aria-label={`Comment on step ${i + 1}`} onClick={() => (setNote(`Step ${i + 1}: `), setNoting(true))}>
                    <Icon name="chat" size={13} />
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
        {edit && (
          <div className="plan-edit">
            <div className="plan-edit-hint">Change the steps, then approve your version. The agent carries out what you leave here, in this order.</div>
            {edit.map((t, i) => (
              <div key={i} className="plan-edit-row">
                <span className="plan-step-n">{i + 1}</span>
                <input value={t} maxLength={300} aria-label={`Step ${i + 1}`} onChange={(e) => setEdit((cur) => cur && cur.map((x, j) => (j === i ? e.target.value : x)))} />
                <button type="button" className="icon-btn tiny" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                  <Icon name="arrowUp" size={13} />
                </button>
                <button type="button" className="icon-btn tiny" aria-label="Move down" disabled={i === edit.length - 1} onClick={() => move(i, 1)}>
                  <Icon name="arrowDown" size={13} />
                </button>
                <button type="button" className="icon-btn tiny" aria-label="Remove this step" onClick={() => setEdit((cur) => cur && cur.filter((_, j) => j !== i))}>
                  <Icon name="x" size={13} />
                </button>
              </div>
            ))}
            {edit.length < 20 && (
              <button type="button" className="rules-add" onClick={() => setEdit((cur) => [...(cur ?? []), ""])}>
                <Icon name="plus" size={13} /> Add a step
              </button>
            )}
          </div>
        )}
        {noting && (
          <form
            className="plan-note"
            onSubmit={(e) => {
              e.preventDefault();
              void review("changes", note.trim());
            }}
          >
            <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should change?" aria-label="What should change in the plan" maxLength={500} />
            <button type="button" className="btn ghost small" onClick={() => setNoting(false)}>
              Cancel
            </button>
            <button type="submit" className="btn primary small" disabled={!note.trim()}>
              Send
            </button>
          </form>
        )}
      </div>
      <div className="plan-approval-actions">
        {reviewer && !noting && (
          <>
            <button type="button" className={`btn ghost small ${mine?.verdict === "changes" ? "on" : ""}`} onClick={() => setNoting(true)}>
              Request changes
            </button>
            <button type="button" className={`btn small ${mine?.verdict === "approve" ? "primary" : "ghost"}`} onClick={() => void review("approve")}>
              <Icon name="check" size={13} /> {mine?.verdict === "approve" || sent === "approve" ? "Signed off" : "Looks good"}
            </button>
          </>
        )}
        {(may || !reviewer) && edit && (
          <>
            <button type="button" className="btn ghost small" onClick={() => setEdit(null)}>
              Cancel
            </button>
            <button type="button" className="btn primary small" disabled={!!why || !edit.some((x) => x.trim())} title={why} onClick={() => void approveEdited()}>
              <Icon name="check" size={13} /> Approve my version
            </button>
          </>
        )}
        {(may || !reviewer) && !edit && (
          <>
            {may && steps.length > 0 && (
              <button type="button" className="btn ghost small" title="Change the steps yourself, then approve" onClick={() => setEdit(steps)}>
                Edit steps
              </button>
            )}
            <button type="button" className="btn ghost small" title="Tell the agent what to change and let it rewrite the plan" onClick={() => prefillComposer(`Change the plan: ${asked.join("; ")}`.trimEnd() + (asked.length ? "" : " "))}>
              Ask for a new plan
            </button>
            <button
              type="button"
              className="btn primary small"
              disabled={!!why || unticked.size >= steps.length}
              title={why || (unticked.size ? "Only the ticked steps are approved" : undefined)}
              onClick={() => void send(unticked.size ? { type: "plan.approve", steps: steps.filter((_, i) => !unticked.has(i)), ...lane_ } : { type: "plan.approve", ...lane_ })}
            >
              <Icon name="check" size={13} /> {unticked.size ? `Approve ${steps.length - unticked.size} of ${steps.length} steps` : "Approve plan"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * What was said while the agent was busy, and is waiting its turn.
 *
 * Each one shows who said it and when, what is in it, and what will happen to it:
 * it is delivered when the current step finishes, or the person driving can send
 * it now, which cuts that step short. The button says what it does, in words, and
 * the whole of it is the button.
 */
/** Whether the queue of waiting instructions is folded to its header, kept across sessions and reloads. */
const QUEUE_FOLDED = "friday.queue.folded";

/** A queued message as it is shown: Friday's own notes to an agent ("[Friday] …") in a line, not their whole text. */
let queuedText = (text: string) => text;
/** Who a queued message is from, as it is shown: Friday's own notes are Friday's, not the person whose turn queued them. */
let queuedBy = (_text: string, name: string) => name;
queuedText = (text) => (text.startsWith("[Friday] ") ? text.slice(9).split(/\n|(?<=\.)\s/)[0]! : text);
queuedBy = (text, name) => (text.startsWith("[Friday] ") ? "Friday" : name);

function QueuedInstructions({ ctx, events, lane = MAIN_LANE }: { ctx: Ctx; events: SessionEvent[]; lane?: string }) {
  const { state, me, send } = ctx;
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  // Folds to its header line, and stays folded until it is opened again (Arun, 2026-10-24: "make the instructions/queued panel
  // collapsable"): the count, what it waits for and Send now stay in sight.
  const [folded, setFolded] = useState(() => {
    try {
      return localStorage.getItem(QUEUE_FOLDED) === "1";
    } catch {
      return false;
    }
  });
  const fold = (v: boolean) => {
    setFolded(v);
    try {
      localStorage.setItem(QUEUE_FOLDED, v ? "1" : "0");
    } catch {}
  };
  // Each agent has its own queue, driver and run: what waits for one is not waiting for another.
  // People's messages only. What one agent sent another (a message, an answer, a handoff, another session's agent) is theirs
  // to sort out: it shows in the chat as the agents' own thread, and a "Send now" for it on a person's screen asked them to
  // manage the agents' mail (Arun, 2026-10-19: "the coding tools and agents need to handle this between themselves").
  const pending = stillPending(state, lane, ctx.delivered)
    .map((seq) => events.find((e) => e.seq === seq))
    .filter((e): e is Ev<"instruction"> => !!e && e.body.type === "instruction" && e.actor.kind === "human" && !e.body.mesh && !e.body.peer);
  // To an idle agent a message is being picked up, not waiting: it shows in the feed, and a queue flashing up for a moment would be noise.
  if (!pending.length || !queueHolds(state, lane)) return null;
  const laneDriver = driverOf(state, lane);
  const driving = laneDriver?.id === me.id;
  const running = runOf(state, lane).status === "running";
  // A coding agent that went offline: nothing is delivered until its runner is back, and saying "when this step finishes" was a promise nobody kept.
  const away = state.engines[lane]?.tool && !state.engines[lane]!.online ? state.engines[lane]! : null;
  const many = pending.length > 1;
  // Why the queue waits, when its agent isn't only busy: offline, or out of usage until a time (a teammate's, in a crew).
  let why = null as string | null;
  why = state.options.team ? queueWhy(lane) : null;
  const who = lane === MAIN_LANE ? "the agent" : agentNameFor(state, lane);
  const status = runOf(state, lane).status;
  // An edit replaces the queued message in one write (core.ts `replaces`): it keeps its place in the queue, the log keeps both,
  // and the agent only ever reads the new one. Refused (already read, taken back, the wheel gone), the old one is untouched.
  const saveEdit = async (ev: Ev<"instruction">) => {
    const text = draft.trim();
    if (!text) return;
    const laneArg = lane !== MAIN_LANE ? { lane } : {};
    const sent = await send({ type: "instruct", text, replaces: ev.seq, ...(ev.body.attachments?.length ? { attachments: ev.body.attachments } : {}), ...laneArg });
    if (!sent.ok) return ctx.notify(sent.error ?? "The edit didn't save. Your message is still queued as it was.");
    setEditing(null);
  };
  const asked = (ts: number) => {
    const r = relTime(ts);
    return r === "now" ? "just now" : `${r} ago`;
  };
  return (
    <section className={`qi dock-queue ${folded ? "folded" : ""}`} aria-label="Instructions waiting">
      <header className="qi-head">
        <button type="button" className="qi-fold" aria-expanded={!folded} title={folded ? "Show what's waiting" : "Fold to this line"} onClick={() => fold(!folded)}>
          <ClockIcon className="size-4" />
          <span className="qi-title">
            {/* Offline, there is no next step to wait for: the hint beside it says what it waits for instead. */}
            {pending.length} instruction{many ? "s" : ""} waiting{away || why || !running ? "" : lane === MAIN_LANE ? " for the next step" : ` for ${agentNameFor(state, lane)}'s next step`}
          </span>
          <Icon name="chevronDown" size={14} className="qi-caret" />
        </button>
        <span className="qi-hint">
          {away
            ? // One still being brought in (no folder yet) has never connected, so it doesn't "re"connect.
              `Waits until ${away.hostId === me.id ? "your" : `${away.hostName.split(/\s+/)[0]}'s`} ${ENGINE_NAMES[away.tool!]} ${away.cwd ? "reconnects" : "connects"}`
            : state.approvals?.[lane]
              ? // The step is waiting on a person, not working: "when this step finishes" left out who finishes it.
                `Delivered once ${driving ? "you answer" : `${laneDriver?.name.split(/\s+/)[0] ?? "the driver"} answers`} the request above`
              : why
                ? `Waits ${why}`
              : state.openQuestions?.[lane] && pending.some((e) => e.seq > state.openQuestions[lane]!.seq)
                ? // What waits is the answer to its question: it said "Delivered once the agent's question is answered", the
                  // answer queued behind itself (2026-10-29 verify).
                  `Your answer goes to ${who} once it can read it`
              : status === "waiting_for_human" || state.openQuestions?.[lane]
                ? // Waiting on a person's answer, not working: it goes once they answer (2026-10-27 audit).
                  `Delivered once ${who}'s question is answered`
              : !running
                ? // Nothing under way: there is no step to finish (2026-10-27 audit: "Delivered when this step finishes" under a
                  // teammate whose last turn had stopped, with nothing running).
                  `Delivered when ${who} next starts${status === "error" ? ": its last turn stopped" : ""}`
              : driving
                ? "Delivered when this step finishes"
              : laneDriver && !driving
                ? `${laneDriver.name.split(/\s+/)[0]} decides when`
                : "Delivered when this step finishes"}
        </span>
        {/* Cutting the step short delivers the whole queue, so it is one button for the queue, not one on each message that
            each sent all of them. */}
        {/* Not while it waits on an answer: cutting a turn short that is waiting for you only drops its question. */}
        {driving && running && !away && !waitsOnPerson(state, lane) && (
          <button type="button" className="qi-send" title="Cut the current step short and send what's queued now" onClick={() => send({ type: "run.interrupt", ...(lane !== MAIN_LANE ? { lane } : {}) })}>
            Send {many ? "all " : ""}now
          </button>
        )}
        {/* What it waits for, a press away: the Reconnect in the feed had scrolled out of view behind this card. */}
        {away && away.hostId === me.id && away.cwd && (
          <button type="button" className="btn small qi-reconnect" onClick={() => window.dispatchEvent(new CustomEvent("friday:reconnect-lane", { detail: { lane } }))}>
            Reconnect
          </button>
        )}
      </header>
      {!folded && <ol className="qi-list">
        {pending.map((ev, i) => {
          const files = ev.body.attachments?.length ?? 0;
          // Its author may change their mind, and so may whoever is driving the agent it is for, and an owner.
          const mayChange = ev.actor.id === me.id || driving || me.role === "owner";
          const laneArg = lane !== MAIN_LANE ? { lane } : {};
          if (editing === ev.seq)
            return (
              <li key={ev.seq} className="qi-item editing">
                <div className="qi-body">
                  <textarea
                    className="qi-edit"
                    autoFocus
                    // The caret at the end of the words, where an edit carries on (2026-10-28 QA: it opened at the start).
                    onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
                    rows={Math.min(6, Math.max(2, draft.split("\n").length))}
                    value={draft}
                    maxLength={8000}
                    aria-label="Edit the queued message"
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setEditing(null);
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void saveEdit(ev);
                    }}
                  />
                  <div className="qi-edit-actions">
                    <span className="qi-meta">Keeps its place in the queue · ⌘↵ to save</span>
                    <button type="button" className="btn ghost small" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                    <button type="button" className="btn primary small" disabled={!draft.trim() || draft.trim() === ev.body.text.trim()} onClick={() => void saveEdit(ev)}>
                      Save
                    </button>
                  </div>
                </div>
              </li>
            );
          return (
            <li key={ev.seq} className="qi-item">
              {many && <span className="qi-pos">{i + 1}</span>}
              <div className="qi-body">
                <div className="qi-text">{queuedText(ev.body.text) || "(attachments)"}</div>
                <div className="qi-meta">
                  {queuedBy(ev.body.text, ev.actor.name)} · queued {asked(ev.ts)}
                  {files ? ` · ${files} file${files === 1 ? "" : "s"}` : ""}
                </div>
              </div>
              {mayChange && (
                <span className="qi-tools">
                  {ev.body.text && (
                    <button type="button" className="icon-btn tiny" title="Edit" aria-label="Edit this message" onClick={() => (setDraft(ev.body.text), setEditing(ev.seq))}>
                      <Icon name="pencil" size={14} />
                    </button>
                  )}
                  <button type="button" className="icon-btn tiny" title="Take it back" aria-label="Take this message back" onClick={() => void send({ type: "instruction.withdraw", seq: ev.seq, ...laneArg })}>
                    <Icon name="x" size={14} />
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ol>}
    </section>
  );
}

/** How many redirects show before the rest fold away behind "Show N more". */
const REDIRECTS_SHOWN = 3;

/**
 * What teammates have suggested, waiting for the person driving to decide.
 *
 * One redirect is a line. Several are a queue somebody has to get through, so each is a row with who said it, how long ago and
 * which agent it is for, and each has its own two answers: send it, or put it aside. The first few show; the rest fold away. With
 * more than one there is also a way to send all of them or clear them all, because "yes, all of that" and "none of it" are the two
 * commonest answers to a handful of suggestions and neither should take five clicks.
 */
function Redirects({ ctx }: { ctx: Ctx }) {
  const { state, me, send } = ctx;
  const [all, setAll] = useState(false);
  // Folded away to just the heading, and remembered: a queue you are not ready to deal with should be able to get out of the way.
  const [folded, setFolded] = useState(() => {
    try {
      return localStorage.getItem("mpa.redirectsFolded") === "1";
    } catch {
      return false;
    }
  });
  const fold = (v: boolean) => {
    setFolded(v);
    try {
      localStorage.setItem("mpa.redirectsFolded", v ? "1" : "0");
    } catch {
      // A preference; losing it costs a click.
    }
  };
  const [wide, setWide] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  // Only the ones for an agent you are driving: a redirect is sent by that agent's driver, and goes to that agent.
  const open = state.suggestions.filter((s) => !s.promoted && !s.dismissed && driverOf(state, s.lane ?? MAIN_LANE)?.id === me.id);
  if (!open.length) return null;
  const shown = all ? open : open.slice(0, REDIRECTS_SHOWN);
  const when = (seq: number) => {
    const ts = ctx.events.find((e) => e.seq === seq)?.ts;
    if (!ts) return "";
    const r = relTime(ts);
    return r === "now" ? "just now" : `${r} ago`;
  };
  const many = open.length > 1;
  const run = async (cmd: Record<string, unknown>) => {
    const r = await send({ ...cmd, quiet: true });
    if (!r.ok) ctx.notify(r.error ?? "That didn't go through.");
    return r.ok;
  };
  /** In the order they were written, one at a time: each is its own instruction, and the agent reads them together at its next step. */
  const everyone = async (kind: "promote" | "suggestion.dismiss") => {
    setBusy(true);
    try {
      for (const sug of open) if (!(await run({ type: kind, seq: sug.seq }))) break;
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={`redirects ${folded ? "folded" : ""}`} aria-label="Redirects from the team">
      {/* The whole heading folds and unfolds, not only the chevron: a bar that says "2 redirects" should open when you press the bar. The buttons in it keep their own jobs. */}
      <header className="redirects-head" onClick={(e) => !(e.target as HTMLElement).closest("button") && fold(!folded)}>
        <span className="redirects-title">
          <Icon name="chat" size={13} />
          {many ? `${open.length} redirects from the team` : "A redirect from the team"}
        </span>
        {!folded && <span className="redirects-hint">{many ? "Send what is right, put the rest aside" : "Send it to the agent, or put it aside"}</span>}
        <span className="redirects-all">
          {many && !folded && (
            <>
              <button type="button" className="rsp-text-btn" disabled={busy} onClick={() => void everyone("suggestion.dismiss")}>
                Dismiss all
              </button>
              <button type="button" className="btn small primary redirect-send" disabled={busy} onClick={() => void everyone("promote")}>
                Send all
              </button>
            </>
          )}
          {/* Over the ✕ column below, so the buttons in the heading and the buttons under it stand in the same two columns. */}
          <button type="button" className="icon-btn tiny redirect-fold-btn" aria-expanded={!folded} title={folded ? "Show the redirects" : "Fold them away"} aria-label={folded ? "Show the redirects" : "Fold the redirects away"} onClick={() => fold(!folded)}>
            <Icon name={folded ? "chevronDown" : "chevronUp"} size={14} />
          </button>
        </span>
      </header>
      {folded ? null : (
        <>
      <ul className={`redirects-list ${all ? "scrolls" : ""}`}>
        {shown.map((sug) => {
          const long = sug.text.length > 130 || sug.text.includes("\n");
          const expanded = wide.has(sug.seq);
          const lane = sug.lane ?? MAIN_LANE;
          return (
            <li key={sug.seq} className="redirect">
              <Avatar name={sug.from.name} id={sug.from.id} size={24} />
              <div className="redirect-main">
                <div className="redirect-meta">
                  <b>{sug.from.name.split(/\s+/)[0]}</b>
                  {when(sug.seq) && (
                    <>
                      <span className="redirect-dot" aria-hidden="true">·</span>
                      <span className="redirect-when">{when(sug.seq)}</span>
                    </>
                  )}
                  {lane !== MAIN_LANE && (
                    <>
                      <span className="redirect-dot" aria-hidden="true">·</span>
                      <span className="redirect-to">for {agentNameFor(state, lane)}</span>
                    </>
                  )}
                </div>
                <p className={`redirect-text ${expanded ? "open" : ""}`}>{sug.text}</p>
                {long && (
                  <button type="button" className="redirect-more" onClick={() => setWide((w) => new Set(expanded ? [...w].filter((x) => x !== sug.seq) : [...w, sug.seq]))}>
                    {expanded ? "Show less" : "Read all of it"}
                  </button>
                )}
              </div>
              <div className="redirect-actions">
                <button type="button" className="btn small primary redirect-send" disabled={busy} title="Send this to the agent" onClick={() => void run({ type: "promote", seq: sug.seq })}>
                  Send
                </button>
                <button type="button" className="icon-btn tiny" disabled={busy} title="Put it aside" aria-label={`Put aside ${sug.from.name.split(/\s+/)[0]}'s redirect`} onClick={() => void run({ type: "suggestion.dismiss", seq: sug.seq })}>
                  <Icon name="x" size={14} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {open.length > REDIRECTS_SHOWN && (
        <button type="button" className="redirects-fold" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show ${open.length - REDIRECTS_SHOWN} more`} <Icon name={all ? "chevronUp" : "chevronDown"} size={12} />
        </button>
      )}
        </>
      )}
    </section>
  );
}

// ── composer ──────────────────────────────────────────────────────────

/**
 * Same input, different verb by role: the driver messages the agent;
 * people allowed to suggest post a redirect that waits for the driver;
 * everyone else just watches.
 */
/**
 * One agent's open question, docked directly above the composer. Inline
 * choices in the question text become real options; the free-text field stays
 * open so an answer that isn't on the list is always possible. Either way the
 * answer goes out as the next instruction, which is what ask_human awaits.
 */
function AgentQuestion({ ctx, q }: { ctx: Ctx; q: OpenQuestion }) {
  const { state, send } = ctx;
  // "sending" while it goes, "sent" once it is in the queue: "Sending…" stayed on the button for as long as the agent took to
  // read the answer, which for an agent mid-step or offline was indefinitely (2026-10-29 verify).
  const [busy, setBusy] = useState<false | "sending" | "sent">(false);
  // Options the agent gave are the options. Only a question that arrived as
  // one lump of prose gets cut up by the parser, and that is now the fallback
  // rather than the normal path.
  const parsed = useMemo(() => {
    if (q.options?.length) return { prompt: q.question, options: q.options.map((o) => ({ value: o, label: o })) };
    return parseChoices(q.question);
  }, [q.question, q.options]);
  useEffect(() => setBusy(false), [q.seq]);

  const recommended = (o: string) => (o === q.recommended ? `${o} · recommended` : o);
  return (
    <ApprovalCard
      className={cn("agent-question", busy && "is-busy")}
      variant="questions"
      title={`${agentNameFor(state, q.lane)} needs a decision`}
      questions={[{ id: "answer", prompt: [parsed.prompt, q.detail].filter(Boolean).join("\n\n"), options: parsed.options.map((o) => recommended(o.label)) }]}
      approveLabel={busy === "sending" ? "Sending…" : busy === "sent" ? "Sent" : "Answer"}
      onApprove={(payload) => {
        const text = (payload?.answers?.answer ?? "").replace(/ · recommended$/, "").trim();
        if (!text || busy) return;
        setBusy("sending");
        // Free again if it didn't go (offline, say): left busy, the question could never be answered after reconnecting.
        // To the agent that asked: sent without its lane, a second agent's answer went to the main one.
        void send({ type: "instruct", text, lane: q.lane }).then((r) => setBusy(r.ok ? "sent" : false));
      }}
    />
  );
}

/**
 * A coding tool's questions, from the end of its answer, as the card Friday's own questions get.
 *
 * Claude Code and Codex ask in prose ("[1] … a. … b. …") and wait for "1=b". The choices are read off the answer
 * (ask-parse.ts) and the answer goes back as that lane's next instruction, in the agent's own shorthand with the words
 * beside it, so the agent and the room read it the same.
 */
function AskCard({ ctx, lane, seq, asks }: { ctx: Ctx; lane: string; seq: number; asks: Ask[] }) {
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Arrived from its toast: brought into view, its first choice ready for the keyboard.
  useEffect(() => {
    try {
      if (sessionStorage.getItem(ASK_FOCUS) !== `${ctx.sid}:${seq}`) return;
      sessionStorage.removeItem(ASK_FOCUS);
    } catch {
      return;
    }
    ref.current?.scrollIntoView({ block: "center" });
    ref.current?.querySelector<HTMLElement>('[role="radio"]')?.focus({ preventScroll: true });
  }, [ctx.sid, seq]);
  return (
    <div ref={ref} data-needs={lane}>
      <ApprovalCard
        className={cn("agent-question", busy && "is-busy")}
        variant="questions"
        // Answer what matters and send: a coding tool's questions are often "1=a is enough to go on", and the rest can wait.
        partial
        title={`${agentNameFor(ctx.state, lane)} needs a decision`}
        questions={asks.map((a, i) => ({
          id: String(i),
          prompt: a.question,
          options: a.options.map((o) => o.label),
          details: a.options.map((o) => o.detail),
          keys: a.options.map((o) => o.key),
        }))}
        approveLabel={busy ? "Sending…" : asks.length > 1 ? "Send answers" : "Send answer"}
        onApprove={(payload) => {
          if (busy) return;
          const text = askReply(
            asks,
            asks.map((a, i) => {
              const said = payload?.answers?.[String(i)];
              const o = a.options.find((x) => x.label === said);
              return o ? { key: o.key, label: o.label } : said ? { text: said } : undefined;
            }),
          );
          if (!text) return;
          setBusy(true);
          // To this agent's lane, as the composer sends; free again if it didn't go, or the card could never be answered.
          void ctx.send({ type: "instruct", text, lane }).then((r) => !r.ok && setBusy(false));
        }}
      />
    </div>
  );
}

/**
 * What the run did, in one line.
 *
 * The tool calls used to be the response: forty cards for six files read and
 * three commands run, with the actual answer somewhere underneath. Folded away,
 * they need a line that is worth reading on its own — so this counts the kinds
 * of work rather than the calls, which is how a person would describe it.
 */
function workSummary(msgs: Ev<"agent.message">[], ctx: Ctx, active: boolean): string {
  const calls = msgs.flatMap((m) => m.body.toolCalls);
  if (!calls.length) return active ? "Working" : "No tools used";
  const n = (names: string[]) => calls.filter((c) => names.includes(c.name)).length;
  const bits: string[] = [];
  const read = n(["read", "read_file", "list_files", "search", "search_code", "tree"]);
  const wrote = n(["write", "edit", "write_file", "edit_file"]);
  const ran = n(["shell", "run_command"]);
  const looked = n(["web_search", "web_fetch", "fetch_url"]);
  const doc = n(["write_section", "delete_section"]);
  const other = calls.length - read - wrote - ran - looked - doc;
  if (read) bits.push(`read ${read}`);
  if (wrote) bits.push(`edited ${wrote}`);
  if (ran) bits.push(`ran ${ran}`);
  if (looked) bits.push(`looked up ${looked}`);
  if (doc) bits.push(`wrote ${doc} section${doc === 1 ? "" : "s"}`);
  if (other > 0) bits.push(`${other} other`);
  const failed = calls.filter((c) => {
    const r = ctx.results.get(c.id);
    return !!r && commandFailed(r.body) === true;
  }).length;
  return `${active ? "Working" : "Its work"} · ${bits.join(", ")}${failed ? ` · ${failed} failed` : ""}`;
}

/**
 * What the agent may do in the folder, said as three choices people recognise.
 *
 * The underlying modes are the machine's, and they are about reach: read, or
 * write, or write and run. These are the same three said as intentions —
 * think about it, do it, or do it and let me look before anything runs —
 * because that is the decision somebody is actually making mid-task.
 *
 * Only the person whose machine it is can change this. It is their laptop,
 * and the change is a restart of the runner they are hosting.
 */
const REACH: { id: EngineMode; label: string; hint: string }[] = [
  { id: "plan", label: "Plan", hint: "Reads and proposes, and asks before it runs a command. Changes nothing." },
  { id: "edits", label: "Manual", hint: "Edits files, and asks you before it runs a command." },
  { id: "full", label: "Auto", hint: "Edits and runs commands without asking." },
];

/**
 * Changing what this lane's machine allows, from where the work is.
 *
 * A restart of the host's own runner, on the same folder: the server can't
 * widen a machine's reach on its own, and shouldn't be able to.
 */
/**
 * Who has the wheel of the agent you are writing to, and the one place to take it, ask for it or let it go.
 *
 * It was a button in the page header, far from the box you type in and about a different agent whenever there were several.
 * Here it belongs to the lane the composer is aimed at: driving shows "You're driving" with the way to release it or hand
 * it to somebody; with somebody else at the wheel it names them and asks; with nobody, it takes it.
 */
export function DrivePill({ ctx, lane }: { ctx: Pick<Ctx, "state" | "me" | "send" | "solo" | "soloSure" | "events" | "presence">; lane: string }) {
  const { state, me, send } = ctx;
  const driver = driverOf(state, lane);
  const driving = driver?.id === me.id;
  const may = canDriveLane(state, me.id, lane);
  // On Solo the agents are all yours: picking one to write to takes its wheel, with no button to press first. A wheel left
  // with an old sign-in of yours, or after a drop, is taken back the same way.
  // Only once the session's own workspace has said it is Solo: a teammate arriving from their own Solo home was guessed Solo,
  // pressed into a takeover they may not force, and lost Request control (Marketing, 2026-10-22).
  useEffect(() => {
    if (!ctx.soloSure || driving || !may) return;
    void send(driver ? { type: "control.force", lane } : { type: "control.claim", lane });
  }, [ctx.soloSure, lane, driver?.id, driving, may]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!may || ctx.solo) return null;
  // A lane can set its own handoff mode; the main lane uses the session's (as the server decides it, core.ts control.request).
  const takeover = (laneOf(state, lane)?.controlMode ?? state.options.controlMode) === "takeover";
  const requested = state.pendingRequests.some((r) => r.id === me.id && r.lane === lane);
  const mayForce = me.role === "owner" || state.engines[lane]?.hostId === me.id;
  const first = (n: string) => n.split(/\s+/)[0] ?? n;

  if (!driver) {
    return (
      <button type="button" className="menu-pill drive-pill take" title="Take the wheel of this agent" onClick={() => void send({ type: "control.claim", lane })}>
        Take control
      </button>
    );
  }

  if (!driving) {
    return (
      <span className={`drive-group ${requested ? "waiting" : ""}`}>
        <span className="drive-who">
          <b>{first(driver.name)}</b> is driving
        </span>
        <button type="button" className="drive-ask" disabled={requested} title={takeover ? `Takes the wheel from ${first(driver.name)} now` : `${first(driver.name)} is asked, and can hand it over`} onClick={() => void send({ type: "control.request", lane })}>
          {requested ? `Asked ${first(driver.name)}` : takeover ? "Take control" : "Request control"}
        </button>
        {/* Without asking: the session's owner, or the person whose computer this coding tool runs on (core.ts control.force). */}
        {!takeover && mayForce && (
          <button type="button" className="drive-ask drive-force" title={`Takes the wheel from ${first(driver.name)} now, without asking`} onClick={() => void send({ type: "control.force", lane })}>
            Force take over
          </button>
        )}
      </span>
    );
  }

  // Only people here now: a wheel handed to somebody who is away only comes back after the grace, with the agent waiting on them.
  const here = (id: string) => ctx.presence?.some((p) => p.id === id && p.online) ?? true;
  const others = Object.entries(state.members).filter(([id, m]) => id !== me.id && !m.removed && here(id) && canDriveLane(state, id, lane));
  const items = (): MenuItem[] => [
    { label: "Release control", icon: "hand", sub: "Nobody is driving until someone takes it", onSelect: () => void send({ type: "control.yield", lane }) },
    ...(others.length ? [{ heading: "Hand it to" } as MenuItem, ...others.map(([id, m]) => ({ label: m.name, icon: "user" as IconName, onSelect: () => void send({ type: "control.yield", to: id, lane }) }))] : []),
  ];

  // How long you have had the wheel: a quiet nudge to pass it on, once it has been a while.
  const took = ctx.events.findLast((e) => e.body.type === "control.granted" && e.body.to === me.id && (e.lane ?? MAIN_LANE) === lane);
  const mins = took ? Math.floor((Date.now() - took.ts) / 60_000) : 0;
  const text = mins >= 10 ? `You're driving · ${mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`}` : "You're driving";
  return <MenuButton className="drive-pill mine" label="You are driving this agent" text={text} items={items} above />;
}

function ReachPill({ ctx, lane }: { ctx: Ctx; lane: string }) {
  const { state, me, identity, notify } = ctx;
  const engine = state.engines[lane];
  const [busy, setBusy] = useState(false);
  if (!engine || !engine.online) return null;
  const now = REACH.find((r) => r.id === engine.mode) ?? REACH[2]!;
  // Everybody in the room can see what this agent may do; only the person whose machine it runs on can change it.
  if (engine.hostId !== me.id) {
    return (
      <span className="menu-pill agent-pill reach-pill model-pill-static" title={`${now.label}: ${now.hint} Only ${engine.hostName} can change this: it runs on their machine.`}>
        {now.label} · {engine.hostName.split(/\s+/)[0]}'s
      </span>
    );
  }
  const running = runOf(ctx.state, lane).status === "running";
  const othersFull = state.othersFull?.[lane] !== false;
  const setOthers = async (on: boolean) => {
    if (on === othersFull) return;
    const r = await ctx.send({ type: "lane.othersFull", lane, on });
    if (!r.ok) notify(r.error ?? "Couldn't change that.");
  };

  let othersSub = "Teammates, hand-offs and apps can change files, but not run anything you haven't allowed.";
  if (state.options.work) othersSub = "Teammates, hand-offs and apps can save pieces, but nothing more you haven't allowed.";
  const set = async (m: EngineMode) => {
    if (m === modeOf(engine) || busy) return;
    // Changing it restarts the agent on the same folder, which would cut a turn off in the middle.
    if (running) return notify("Let the run finish, or pause it, before changing what it may do.");
    setBusy(true);
    try {
      await hostApi(identity, "/api/runner/start", {
        method: "POST",
        // The rest as it was: its model (or Smart routing) and the folder its copy was cut from.
        body: JSON.stringify({ sid: ctx.sid, invite: ctx.invite, ...(engine.tool ? { tool: engine.tool } : {}), cwd: engine.cwd, mode: m, lane, ...(engine.model ? { model: engine.model } : {}), ...(engine.account ? { account: engine.account.id } : {}), ...(engine.copyOf ? { copyOf: engine.copyOf } : {}), ...(engine.shared ? { share: true } : {}) }),
      });
    } catch (e) {
      notify(`Couldn't change what it may do: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <MenuButton
      className="reach-pill"
      label="What it may do in your folder"
      text={busy ? "…" : now.label}
      items={() => [
        { heading: "In your folder, it may" },
        ...REACH.map((r) => {
          let sub = r.id === "edits" && (engine.tool === "codex" || engine.tool === "cursor") ? "Asks before any turn that changes something." : r.hint;
          // In Work, what each means for pieces, not files and commands (QA, 2026-10-28; the home page already said it so).
          if (state.options.work) sub = WORK_MODE_BLURB[r.id];
          return { label: r.label, sub, checked: r.id === now.id, onSelect: () => void set(r.id) };
        }),
        // Whose messages may run it how far on this computer (Security R2, R3): anyone else's, an app's included, stops at Edits
        // unless the host opens it up.
        { heading: "Others' messages on your computer" },
        // By the mode's own name, Manual, not "Edits" (QA, 2026-10-28); in Work, in its words.
        { label: "Up to Manual", sub: othersSub, checked: !othersFull, onSelect: () => void setOthers(false) },
        { label: "As far as yours", sub: "Their messages run in the mode you picked, Auto included.", checked: othersFull, onSelect: () => void setOthers(true) },
      ]}
      above
    />
  );
}

/**
 * Which of the CLI's own models this lane runs on, changed from where the work is.
 *
 * A restart of the host's runner on the same folder and lane with the new
 * model, as changing what it may do is: the server cannot choose a model for
 * somebody's own CLI, and only the person whose machine it is can restart it.
 */
function LaneModelPill({ ctx, lane }: { ctx: Ctx; lane: string }) {
  const { state, me, identity, notify } = ctx;
  const engine = state.engines[lane];
  const [busy, setBusy] = useState(false);
  if (!engine?.tool) return null;
  const mine = engine.hostId === me.id && engine.online;
  const running = runOf(state, lane).status === "running";
  const set = async (model: string) => {
    if (model === (engine.model ?? "") || busy) return;
    setBusy(true);
    try {
      await hostApi(identity, "/api/runner/start", {
        method: "POST",
        body: JSON.stringify({ sid: ctx.sid, invite: ctx.invite, tool: engine.tool, cwd: engine.cwd, mode: engine.mode, ...(engine.handMode ? { handMode: engine.handMode } : {}), lane, ...(model ? { model } : {}), ...(engine.account ? { account: engine.account.id } : {}), ...(engine.copyOf ? { copyOf: engine.copyOf } : {}), ...(engine.shared ? { share: true } : {}) }),
      });
      notify(`${ENGINE_NAMES[engine.tool!]} now runs ${model || "its default model"}`);
    } catch (e) {
      notify(`Couldn't change the model: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <EngineModelPill
      tool={engine.tool}
      model={engine.model ?? ""}
      onChange={(m) => void set(m)}
      identity={identity}
      disabled={!mine || running || busy}
      title={!mine ? `Only ${engine.hostName} can change the model: it runs on their machine` : running ? "Let the run finish, or pause it, before changing the model" : undefined}
    />
  );
}

type EffortProps = { state: SessionState; me: Member; lane: string; send: Send; notify: (m: string) => void };

/** The effort menu's rows: Auto, then the levels this lane's tool takes. Null when it takes none (Cursor, Friday Code). */
export function effortItems({ state, me, lane, send, notify }: EffortProps): MenuItem[] | null {
  const engine = state.engines[lane];
  const levels = effortLevelsOf(engine);
  if (!engine || !levels.length) return null;
  const now = state.efforts?.[lane] ?? null;
  const running = runOf(state, lane).status === "running";
  // Extra and Max are paid for by whoever's subscription runs the tool.
  const plan = engine.hostId === me.id ? "your" : `${engine.hostName.split(/\s+/)[0]}'s`;
  const set = async (effort: EngineEffort | null) => {
    if (effort === now) return;
    const r = await send({ type: "lane.effort", lane, effort });
    if (!r.ok) notify(r.error ?? "Couldn't change the effort.");
    else if (running) notify("Effort applies after the current turn");
  };
  return [
    { heading: "Effort, for everyone here" },
    // Names only, no second lines (Arun, 2026-10-17); what each level means, and why a locked one is locked, is in its tooltip.
    { label: "Auto", title: "The tool's own default.", checked: now === null, onSelect: () => void set(null) },
    ...levels.map((e) => {
      const paid = e === "xhigh" || e === "max";
      // Extra and Max are the host's or an owner's to pick (core.ts lane.effort says the same).
      const locked = paid && engine.hostId !== me.id && state.members[me.id]?.role !== "owner";
      const title = !paid ? ENGINE_EFFORT_INFO[e].blurb : locked ? `Only ${engine.hostName.split(/\s+/)[0]} or an owner can pick this: it uses ${plan} plan.` : `${ENGINE_EFFORT_INFO[e].blurb} More tokens on ${plan} plan.`;
      // Locked levels are greyed but still pressable, so the reason is reachable: it shows on hover and focus, a screen
      // reader reads it, and pressing says it instead of changing anything (a disabled row can't be hovered or focused).
      return { label: ENGINE_EFFORT_INFO[e].label, title, checked: now === e, dim: locked, onSelect: () => (locked ? notify(title) : void set(e)) };
    }),
  ];
}

/** The same choice for the agent picker's Effort column (AgentModelPicker): null when the tool takes none or this person can't steer the lane. */
export function effortChoice(props: EffortProps): EffortChoice | null {
  const { state, me, lane, send, notify } = props;
  const engine = state.engines[lane];
  const levels = effortLevelsOf(engine);
  if (!engine || !levels.length || !canDriveLane(state, me.id, lane)) return null;
  const now = state.efforts?.[lane] ?? null;
  const items = effortItems(props) ?? [];
  const running = runOf(state, lane).status === "running";
  return {
    now,
    // Built from the menu's own rows, so the two never disagree on what is locked and why.
    options: levels.map((e) => {
      const row = items.find((it) => it && "label" in it && it.label === ENGINE_EFFORT_INFO[e].label) as { title?: string; dim?: boolean } | undefined;
      return { value: e, label: ENGINE_EFFORT_INFO[e].label, title: row?.title ?? ENGINE_EFFORT_INFO[e].blurb, locked: !!row?.dim };
    }),
    set: async (effort) => {
      if (effort === now) return;
      const r = await send({ type: "lane.effort", lane, effort });
      if (!r.ok) notify(r.error ?? "Couldn't change the effort.");
      else if (running) notify("Effort applies after the current turn");
    },
    onLocked: notify,
  };
}

/**
 * How hard this lane's coding tool thinks, one level for the whole room. Not the host's alone and no restart: whoever may
 * steer the lane sets it, mid-run too, and the next turn carries it. Everybody else sees it, read-only.
 */
export function EffortPill(props: EffortProps) {
  const { state, me, lane } = props;
  if (!effortItems(props)) return null;
  const now = state.efforts?.[lane];
  const text = `Effort · ${now ? ENGINE_EFFORT_INFO[now].label : "Auto"}`;
  if (!canDriveLane(state, me.id, lane)) {
    const who = Object.entries(state.members).filter(([id, m]) => !m.removed && canDriveLane(state, id, lane)).map(([, m]) => m.name);
    return (
      <span className="menu-pill agent-pill effort-pill model-pill-static" title={`Only ${who.length ? who.join(", ") : "whoever drives this agent"} can change the effort`}>
        {text}
      </span>
    );
  }
  const running = runOf(state, lane).status === "running";
  // The accessible name starts with the visible text (WCAG 2.5.3), so the room's level is announced and "click Effort" works.
  return <MenuButton className="effort-pill" label={running ? `${text}, applies after the current turn` : text} text={text} items={() => effortItems(props) ?? []} above />;
}

/** Thinking modes, in menu order. Effort is applied server-side in the agent runtime. */
const THINKING_ORDER: Thinking[] = ["balanced", "fast", "deep"];
const THINKING: Record<Thinking, { label: string }> = {
  balanced: { label: "Balanced" },
  fast: { label: "Fast" },
  deep: { label: "Deep reasoning" },
};

/** What to call the thing driving a lane: the person's CLI, a custom agent, or Friday's own. */
export function agentNameFor(state: SessionState, lane: string): string {
  const e = state.engines[lane];
  // A folder with no CLI is still Friday Code doing the work, in that folder.
  if (e?.tool) {
    const tool = ENGINE_NAMES[e.tool];
    const tools = Object.entries(state.engines).filter(([, x]) => !!x.tool);
    // Whose it is, only when there is more than one person's to tell apart: on your own, "Arun's" on every line is noise.
    const owner = new Set(tools.map(([, x]) => x.hostId)).size > 1 ? `${e.hostName}'s ` : "";
    // The name somebody gave it, over its tool's: renamed, it is called that everywhere.
    const given = givenName(state, lane);
    // A name that already says whose it is ("Arokia's Claude Code", as a teammate's lane is named when it joins) isn't given
    // the owner again: it read "Arokia Joseph's Arokia's Claude Code" (Arun, 2026-10-21).
    const first = e.hostName.trim().split(/\s+/)[0] ?? "";
    const theirs = !!first && !!given && given.toLowerCase().startsWith(`${first.toLowerCase()}'s `);
    if (given) return theirs ? given : `${owner}${given}`;
    // Two of the same tool (two Claude Code tasks side by side) are told apart by their own names, not "Claude Code" twice:
    // the lane's name when it has one of its own, else a number. Its mark already says which tool it is.
    const twins = [MAIN_LANE, ...state.lanes.map((l) => l.id)].filter((id) => state.engines[id]?.tool === e.tool && state.engines[id]?.hostId === e.hostId);
    if (twins.length > 1) {
      const own = lane === MAIN_LANE ? "" : (state.lanes.find((l) => l.id === lane)?.name ?? "").trim();
      const named = own && own.toLowerCase() !== tool.toLowerCase() ? own : twins.indexOf(lane) === 0 ? tool : `${tool} ${twins.indexOf(lane) + 1}`;
      return `${owner}${named}`;
    }
    return `${owner}${tool}`;
  }
  if (lane === MAIN_LANE) return state.mainName?.trim() || (state.options.agent?.name ?? "Friday Code");
  const l = state.lanes.find((x) => x.id === lane);
  // A lane since taken away (a teammate taken out of a room) keeps the name it had, from the log: "You made Agent the lead"
  // rewrote what was said once it went (2026-10-27 audit).
  return l?.agent?.name ?? l?.name ?? laneNamesSeen.get(lane) ?? "Agent";
}

/** Every lane's name as the logs drawn here last gave it (laneNamesFrom), lane ids being unique: kept after the lane goes. */
const laneNamesSeen = new Map<string, string>();
/** The names the log gives its lanes, as they were added and renamed: read once per log. */
const namesRead = new WeakSet<readonly SessionEvent[]>();
export function laneNamesFrom(events: readonly SessionEvent[]): ReadonlyMap<string, string> {
  if (namesRead.has(events)) return laneNamesSeen;
  namesRead.add(events);
  for (const e of events) {
    const b = e.body;
    if (b.type === "lane.added" && b.lane.name) laneNamesSeen.set(b.lane.id, b.lane.agent?.name ?? b.lane.name);
    else if (b.type === "lane.renamed" && b.name) laneNamesSeen.set(b.laneId, b.name);
    else if (b.type === "crew.applied") for (const l of b.lanes) if (l.name) laneNamesSeen.set(l.id, l.agent?.name ?? l.name);
  }
  return laneNamesSeen;
}

/** How many files the message box holds, for what sits inside it (its Send button). */
function WithAttachments({ children }: { children: (n: number) => ReactNode }) {
  return <>{children(usePromptInputAttachments().files.length)}</>;
}

/** Inside the message box: a brief sent here with "Use as context" lands in it as a file (contextDrop.ts). */
function ContextDrops({ sid, notify }: { sid: string; notify: (m: string) => void }) {
  const files = usePromptInputAttachments();
  useContextDrops(sid, (f) => files.add(f), (b) => notify(b.length === 1 ? `Added a brief of “${b[0]!.title}”. It goes with your next message.` : `Added ${b.length} briefs. They go with your next message.`));
  return null;
}

function Composer({ ctx, lane = MAIN_LANE, locked = false, onLane, onPin, plan, events }: { ctx: Ctx; lane?: string; /** Fixed to this agent: no picker for another. */ locked?: boolean; onLane?: (lane: string) => void; onPin?: () => void; plan?: ReactNode; events: SessionEvent[] }) {
  const { state, me, send, sid, invite, notify } = ctx;
  useTeamVersion(); // The box's @ list, pills and routing read the team (Teammates.tsx).
  // A session opened with the keyboard nowhere (sent from the new-session page, whose box is gone) puts it in this box, so the next
  // message can be typed at once: it fell to the page's body (2026-10-29 verify). Not on a touch screen, where it opens the keyboard.
  useEffect(() => {
    if (matchMedia("(pointer: coarse)").matches) return;
    const t = setTimeout(() => {
      const at = document.activeElement;
      if (!at || at === document.body) document.getElementById("composer-input")?.focus();
    }, 120);
    return () => clearTimeout(t);
  }, [sid]);
  const [interrupt, setInterrupt] = useState(false);
  // Writing to the people here instead of an agent: an aside, which no agent reads (chat events). Offered once anyone else is in.
  const [toPeople, setToPeople] = useState(false);
  const others = Object.entries(state.members).filter(([id, m]) => id !== me.id && !m.removed).length;
  // Read by the submit that ⌘↵ starts. State set in the same keypress reached it only on the next render, so the submit
  // read the old false and every ⌘↵ queued instead of cutting the step short.
  const interruptNext = useRef(false);
  // What is in the box, so an empty message can't be sent — by the button or
  // by Enter, which checks the button's disabled state before submitting.
  const [typed, setTyped] = useState("");
  // What was being typed, kept per session for this tab, so switching away and back doesn't lose it. Not saved until it has
  // been read back: the empty box on mount used to delete it before the effect below could restore it.
  const draftKey = `mpa.draft.${sid}`;
  const draftRead = useRef(false);
  // Kept once typing pauses rather than on every key (a synchronous storage write the key waited on), and whatever is still
  // waiting is written when the page is left or the session closes.
  const saveDraft = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!draftRead.current) return;
    saveDraft.current = () => {
      saveDraft.current = null;
      try {
        if (typed) sessionStorage.setItem(draftKey, typed);
        else sessionStorage.removeItem(draftKey);
      } catch {
        /* nothing kept: the box still works */
      }
    };
    const t = setTimeout(() => saveDraft.current?.(), 300);
    return () => clearTimeout(t);
  }, [typed, draftKey]);
  useEffect(() => {
    const flush = () => saveDraft.current?.();
    addEventListener("pagehide", flush);
    return () => {
      removeEventListener("pagehide", flush);
      flush();
    };
  }, []);
  const [busy, setBusy] = useState(false);
  // A key in the draft: held back, and said so under the box, until it's edited or sent without the key.
  const [keyNotice, setKeyNotice] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  // "Start with" on the morning page opens the session with the next step already in the box, once.
  useEffect(() => {
    let left = "";
    try {
      const k = `mpa.startWith.${sid}`;
      left = sessionStorage.getItem(k) ?? "";
      if (left) sessionStorage.removeItem(k);
      // Otherwise what was left half-typed here.
      else left = sessionStorage.getItem(`mpa.draft.${sid}`) ?? "";
    } catch {
      /* nothing kept, nothing to pick up */
    }
    draftRead.current = true;
    if (!left || !textarea.current) return;
    textarea.current.value = left;
    setTyped(left);
    textarea.current.focus();
    textarea.current.setSelectionRange(left.length, left.length);
  }, [sid]);
  const hasFolder = !!state.upload || !!liveMachine(state, lane);
  const saved = useSavedCommands();
  const [managing, setManaging] = useState(false);
  // Picking a session from the team's library to hand this agent as context (TeamLibrary.tsx).
  const [picking, setPicking] = useState(false);
  // A coding tool on this lane answers to its own `/` commands; Friday's built-in ones are for Friday's agents.
  const laneTool = state.engines[lane]?.tool;
  const people = Object.entries(state.members).filter(([id, m]) => id !== me.id && !m.removed).map(([id, m]) => ({ id, name: m.name, online: ctx.presence?.some((p) => p.id === id && p.online) }));
  // The teammate the box writes to is being given a folder or repo (Teammates.tsx TeammateFolderCard).
  const [giving, setGiving] = useState(false);
  let naming = false;
  if (state.options.team) naming = namesSomeone(sid, typed);
  const inView = useFocusedAgent(sid);
  // In a team the box has no To pill at all (Arun, 2026-10-27: "get rid of this button too"): an @name says who, and without
  // one it goes to the lead, as the box's words say; in a teammate's own chat, to that teammate.
  if (state.options.team) naming = true;
  // Picking a name from the @ list points the box at it, except where an @name in the words says who (a team).
  let pickPoints = true;
  if (state.options.team) pickPoints = false;
  let toolPick = true;
  // A teammate's tool is set in its own dialog, so the team's box has no picker for it.
  if (state.options.team) toolPick = false;
  let agents: { id: string; name: string; mark: ReactNode; hint: string; tone?: string }[] = [];
  // In a crew "@" names a teammate, and picking one points the box at it (Teammates.tsx).
  if (state.options.team) agents = teammateAgents(sid);
  let teamSlash = {};
  // "/" in a team chat offers the team's own commands (team-commands.ts), not its teammate's coding tool's (Arun, 2026-10-28).
  if (state.options.team) teamSlash = { only: TEAM_COMMANDS, tool: undefined, onManage: undefined };
  const shortcuts = useShortcuts({ textarea, sid, invite, people, agents, ...(onLane && pickPoints ? { onAgent: (id: string) => id !== "*" && onLane(id) } : {}), commands: !toPeople, files: hasFolder && !toPeople, connections: state.options.mcp ? ctx.connections : [], saved: savedCommands(saved.commands), onManage: () => setManaging(true), lane, ...(laneTool ? { tool: ENGINE_NAMES[laneTool] } : {}), ...teamSlash });
  // Set while a Friday lane asked for from this menu is still being created.
  const wantFriday = useRef(false);
  // A saved agent was just added from the Agents menu: point at its lane when it arrives, so the next
  // message goes to it and it runs beside whatever else is working. Expires, so a failed add can't hijack later.
  const wantAgent = useRef<{ id: string; until: number } | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<{ agentId?: string }>).detail?.agentId;
      if (id) wantAgent.current = { id, until: Date.now() + 10_000 };
    };
    window.addEventListener("friday:use-agent", on);
    return () => window.removeEventListener("friday:use-agent", on);
  }, []);
  useEffect(() => {
    const want = wantAgent.current;
    if (!want) return;
    if (Date.now() > want.until) return void (wantAgent.current = null);
    const added = state.lanes.find((l) => l.agent?.id === want.id);
    if (!added) return;
    wantAgent.current = null;
    onLane?.(added.id);
  }, [state.lanes]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!wantFriday.current) return;
    const mine = state.lanes.find((l) => !state.engines[l.id]?.tool);
    if (!mine) return;
    wantFriday.current = false;
    onLane?.(mine.id);
  }, [state.lanes]); // eslint-disable-line react-hooks/exhaustive-deps
  // Everything here is scoped to the agent being written to: who drives it,
  // whether it is running, and where an instruction goes.
  const driver = driverOf(state, lane);
  const driving = driver?.id === me.id;
  const running = runOf(state, lane).status === "running";
  const mayDrive = canDriveLane(state, me.id, lane);
  // "claim": nobody is driving and you may, so writing takes the wheel. That
  // used to be a button you had to find first.
  // A coding tool on someone else's own plan takes their work alone (own-plan.ts): yours goes to them as a suggestion.
  const theirPlan = ownPlan(state.engines[lane]) && state.engines[lane]!.hostId !== me.id ? state.engines[lane]! : null;
  const mode: "drive" | "claim" | "suggest" | "view" = theirPlan ? (can(state, me.id, "suggest") ? "suggest" : "view") : driving ? "drive" : !driver && mayDrive ? "claim" : can(state, me.id, "suggest") ? "suggest" : "view";
  const canUpload = mode !== "view" && !toPeople && can(state, me.id, "upload");
  // A folder from this computer, sent up as a working copy the agents can read and edit. For a session with no
  // machine of its own: where one is attached, the code is already on it.
  const folderInput = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const noMachine = !liveMachine(state, lane);
  const uploadFolder = async (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (!files.length || sending) return;
    const { keep, skipped, reason, over } = pickable(files);
    if (!keep.length) return notify(skipped ? `Nothing to upload: skipped ${reason}.` : "That folder was empty.");
    setSending(true);
    notify(`Uploading ${keep.length} file${keep.length === 1 ? "" : "s"}…`);
    try {
      const r = await uploadAll(keep, sid, invite, me.id);
      const f = r.folders[0];
      const left = [skipped ? `skipped ${reason}` : "", over ? `${over} didn't fit` : ""].filter(Boolean).join(", ");
      notify(f ? `Uploaded ${f.name}: ${f.files} files${left ? ` (${left})` : ""}. It is the working copy now.` : "The folder didn't upload. Try again, or a smaller one.");
    } finally {
      setSending(false);
    }
  };
  // The send button is the pause button while the agent works and there is nothing to send.
  const mayStop = driving || me.role === "owner";
  // Another agent at work while the box is set to one that isn't: its Stop is still here, rather than only after setting "To"
  // back to it (Arun, 2026-10-28: "iron everything and ensure we are good… any logic errors and fixes"). Not in a box fixed to
  // one agent, and only an agent this person may stop.
  const stopLanes = running
    ? mayStop
      ? [lane]
      : []
    : locked
      ? []
      : [MAIN_LANE, ...state.lanes.map((l) => l.id)].filter((id) => id !== lane && runOf(state, id).status === "running" && (driverOf(state, id)?.id === me.id || me.role === "owner"));
  const stopMode = stopLanes.length > 0 && !typed.trim();
  const stopName = stopLanes.length === 1 ? agentNameFor(state, stopLanes[0]!) : "the agents";
  // Paused: Resume is offered where Pause was. There was no way back but writing something or knowing the command menu.
  const paused = runOf(state, lane).status === "paused" && mayStop;
  const name = agentNameFor(state, lane);
  const driverName = driver?.name.split(/\s+/)[0];

  const targets = [MAIN_LANE, ...state.lanes.map((l) => l.id)];
  /**
   * Friday Code, when every lane is somebody's CLI.
   *
   * A coding session starts on the person's own Claude Code, which is the
   * right default — but their account has a limit, their machine sleeps, and
   * some of the work (a summary, a PR description, a question about a library)
   * never needed a checkout. So Friday is always one pick away, and picking it
   * opens the lane it needs. Nothing appears until somebody wants it.
   */
  const fridayIsHere = targets.some((id) => !state.engines[id]?.tool);
  const addFriday = () => {
    send({ type: "lane.add", name: "Friday", control: { kind: "open" }, trigger: { kind: "manual" } });
    // The lane id is minted on the server; the effect below targets it as soon
    // as it arrives, so this reads as one action rather than two.
    wantFriday.current = true;
  };
  /**
   * An agent as the menu names it: with its lane's name too when another target reads the same, which two lanes running one
   * person's Claude Code do ("Arun's Claude Code" twice, with nothing to tell which is which).
   */
  const targetName = (id: string) => {
    const n = agentNameFor(state, id);
    return targets.some((x) => x !== id && agentNameFor(state, x) === n) ? `${n} · ${id === MAIN_LANE ? "Main" : laneLabel(state, id)}` : n;
  };
  // As wide as the longest agent's name: two-line rows otherwise get the menus' broad default, and these are short.
  const targetWidth = Math.min(312, Math.max(220, Math.max(11, ...targets.map((id) => targetName(id).length)) * 7 + 84));
  /** On Solo, Friday's own agent is Team's: the entry says so and offers a team for this session instead. None in the local edition. */
  let soloFriday: MenuItem[] = [];
  const targetItems = (): MenuItem[] => [
    { heading: "Send to" },
    ...targets.map((id) => {
      const d = driverOf(state, id);
      // One that can't work now says so first: the list read "Yours" beside an agent out of usage or signed out (QA, 2026-10-28).
      const run = runOf(state, id);
      const stuck = run.status === "error" ? (limitHit(run.error) ? "Out of usage" : signedOut(run.error) ? "Not signed in" : "") : "";
      return {
        label: targetName(id),
        mark: <EngineMark tool={state.engines[id]?.tool ?? ""} size={15} />,
        checked: !toPeople && id === lane,
        sub: stuck || (d?.id === me.id ? "Yours" : d ? `${d.name.split(/\s+/)[0]} is driving` : "Free to take"),
        onSelect: () => (setToPeople(false), onLane?.(id)),
      };
    }),
    // Adding a lane is an owner's call, so only an owner is offered one.
    // On Solo, Friday's own agent is Team's: the entry says so and offers a team for this session instead.
    ...(fridayIsHere || me.role !== "owner"
      ? []
      : ctx.solo
        ? soloFriday
        : [{ label: "Friday Code", mark: <EngineMark tool="" size={15} />, sub: "Opens beside it", onSelect: addFriday }]),
    // Talking to the people here without steering anything: @name tells someone.
    ...(others ? [{ heading: "Or" }, { label: "The people here", mark: <Icon name="users" size={15} />, checked: toPeople, sub: "No agent reads it", onSelect: () => setToPeople(true) }] : []),
  ];

  // Sending mid-run either waits for the step to end or cuts it short, and
  // which one it will be is the thing to say while a run is live.
  const canInterrupt = mode === "drive" && running;
  // Who it is and which model are one decision, so for whoever may rewire this lane they are one picker; everyone else keeps the model pill beside theirs.
  const agentAndModelAreOne = switchesAgent({ state, me, lane, ...(ctx.onConnect ? { onSetup: ctx.onConnect } : {}) });
  const caption = toPeople
    ? "To the people here · no agent reads this"
    : mode === "drive"
      ? state.openQuestions[lane]?.to === me.id
        ? "Answer the agent"
        : ""
      : mode === "claim"
        ? ""
        : mode === "suggest"
          ? // Said by the pill beside it ("Arokia is driving"): the line under it was one more thing to read (Arun, 2026-10-24).
            ""
          : "View only · you can watch but not steer";
  // What sending does while a run is live, said inside the box beside the button that does it, and quietly: it is a thing to
  // know once, not a heading over every message. The modifier is the platform's own.
  const sendNow = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘↵" : "Ctrl ↵";
  // Only while sending would cut the step short: the standing "Waits for the current step" line was noise (Arun); the send
  // button's tooltip still says how to send now.
  const liveHint = mode === "drive" && running && state.openQuestions[lane]?.to !== me.id && interrupt ? "Cuts the current step short" : "";
  // Friday Code on Solo is only Team's when it isn't running on somebody's own model.
  const fridayHere = !state.engines[lane]?.tool && !isOwnModel(state.options.model);
  // A team's chats have no agent menu below the box: a teammate's tool is set in its details (2026-10-27 audit).
  let noPicker = false;
  noPicker = !!state.options.team;
  // Friday Code with nothing to run on (no coding tool on the lane, no model of the person's own, and on Solo none of Friday's):
  // a message there would wait for ever, "Queued" with the bar on "Ready" (2026-10-27 audit, a fork landing on it). Send is
  // held, and says to pick a tool.
  const cantRun = !toPeople && ctx.solo && fridayHere && !noPicker && (mode === "drive" || mode === "claim");
  // How the box speaks of the agent it steers.
  let they = { picks: "It picks", its: "its", it: "it" };
  // A team's agents are "they" (Arun, 2026-10-28: "really iron out bugs and feature problems and gaps").
  if (state.options.team) they = { picks: "They pick", its: "their", it: "them" };
  const placeholder = toPeople
    ? "Say something to the people here. @name tells them…"
    : ctx.solo && fridayHere && !noPicker && (mode === "drive" || mode === "claim")
      ? "Pick one of your coding tools in the agent menu below…"
      : mode === "drive" || mode === "claim"
      ? paused
        ? `Paused. Resume ${name}, or tell ${they.it} what to do instead…`
        : running && waitsOnPerson(state, lane)
        ? // Waiting on an answer: the box answers it, not a redirect of work that has stopped to ask (2026-10-27 audit).
          `Answer ${name}, or tell ${they.it} something else…`
        : running
        ? interrupt
          ? `Redirect ${name} now, cutting ${they.its} current step short…`
          : `Redirect ${name}. ${they.picks} this up at ${they.its} next step…`
        : state.options.team
        ? (inView !== ALL ? `Give ${name} a task…` : !matesIn(sid).length ? (!teamKnown() ? "Give the crew a goal…" : sid === teamSid() ? "No teammates yet. Add one with New teammate in the sidebar." : "No teammates here now. Add some from the room's settings.") : narrowBox() ? "Give the crew a goal…" : `Give the crew a goal (${(sid === teamSid() && crewLeadName()) || name} leads), or @ a teammate…`)
        : state.options.work
        ? `Ask ${name} to research, write or make something… @ for people`
        : // Only what works here (2026-10-27 audit: "# for files" with no computer connected, "@ for people" with nobody else).
          `Tell ${name} what to do… / for commands${hasFolder ? ", # for files" : ""}${people.length ? ", @ for people" : ""}`
      : mode === "suggest"
        ? theirPlan
          ? `${name} runs on ${theirPlan.hostName}'s own plan, so it takes ${theirPlan.hostName}'s work only. Suggest something to ${theirPlan.hostName}…`
          : "Suggest a redirect…"
        : "You're watching this session";

  let boxLabel = "Message the agent";
  // Who the box writes to, for a screen reader: the teammate whose chat it is, or the team (Arun, 2026-10-28: the critique).
  if (state.options.team) boxLabel = inView !== ALL ? `Message ${name}` : `Message the crew${sid === teamSidNow() ? "" : ` in ${state.title}`}`;
  /** Where ↑ has got to in your past asks; -1 while the box holds your own text. */
  const askAt = useRef(-1);
  const onSubmit = async (msg: PromptInputMessage) => {
    // The box empties as it sends: what draws its @names under it goes with it (put back with the words if it fails).
    if (state.options.team) setTyped("");
    let text = msg.text.trim();
    // A team's own "/" command does what it says here, or becomes the words it stands for (team-commands.ts).
    if (state.options.team && text.startsWith("/")) { const said = await runTeamCommand(text, { identity: ctx.identity, notify, sid }); if (said === null) return; text = said; }
    const now = interruptNext.current;
    interruptNext.current = false;
    // An aside goes to the people, whoever may steer: watchers can talk too.
    if (toPeople) {
      if (!text) return;
      if (msg.files.length) {
        notify("An aside can't carry files. Send them to an agent, or share a link.");
        throw new Error("files in an aside");
      }
      const r = await send({ type: "say", text, quiet: true });
      if (!r.ok) {
        if (textarea.current) textarea.current.value = msg.text;
        notify(r.error ?? "That didn't send. It's back in the box: try again.");
        throw new Error("aside not sent");
      }
      setTyped(textarea.current?.value ?? "");
      return;
    }
    if (mode === "view" || (!text && !msg.files.length)) return;
    // Enter in the box too: nothing goes to an agent that has nothing to run on (cantRun).
    if (cantRun) {
      notify("Pick one of your coding tools in the agent menu first: there is nothing to run this on yet.");
      throw new Error("no agent to run it");
    }
    rememberAsk(text);
    askAt.current = -1;
    // The shield would hide a typed key from the agent too, so it doesn't go: it stays in the box and the notice says why.
    // Thrown, so the box keeps its attachments.
    if (hideSecrets(text).hidden > 0) {
      if (textarea.current) textarea.current.value = msg.text;
      setKeyNotice(true);
      throw new Error("key in the draft");
    }
    // Yours, on screen, now. Uploading two hundred files takes a while and the
    // round trip is never instant; a message box that empties into nothing is
    // the moment people press send again.
    const unecho = text ? ctx.echo(text, lane) : () => {};
    // A message that didn't go goes back in the box, rather than leaving "Sending…" on screen and the words nowhere. Ahead of
    // anything typed since, never over it. Thrown after, so the box keeps its attachments for the retry.
    const putBack = (why: string): never => {
      unecho();
      const el = textarea.current;
      if (el && text) {
        el.value = el.value.trim() ? `${text}\n${el.value}` : text;
        setTyped(el.value);
        el.focus();
      }
      notify(why);
      throw new Error(why);
    };
    setBusy(true);
    try {
      let attachments;
      try {
        attachments = await Promise.all(msg.files.map((f) => uploadFile(sid, invite, me.id, f)));
      } catch (e) {
        return putBack((e as Error).message);
      }
      // The first message to a tool brought in by switching goes as a handoff from the one it replaced: it starts with that
      // one's whole record instead of from nothing (carried.ts, handoffBrief).
      const carry = mode === "drive" || mode === "claim" ? carriedFrom(sid, lane) : undefined;
      const toName = agentNameFor(state, lane);
      // Switched to what this message calls for before it gets it: Plan for a question, Auto to run the tests (smartReach.ts).
      if ((mode === "drive" || mode === "claim") && !running) await smartSwitch(ctx, lane, reachFor(state, lane, text), true);
      const handoff = carry ? { handoff: { fromLane: carry.fromLane, fromName: carry.fromName, toName, reason: `You switched from ${carry.fromName} to ${toName} here.`, carried: [] } } : {};
      let toLanes = [lane];
      // In a crew "@Kit …" goes to Kit, and "@Kit and @Nova …" to both, wherever the box points (Teammates.tsx).
      if (state.options.team) toLanes = teammatesNamed(sid, text, lane);
      if (!toLanes.length) return putBack("Nobody is in this room yet. Add a teammate to it from its menu at the top.");
      for (const to of toLanes) {
        const r = await send({ ...(mode === "drive" || mode === "claim" ? { type: "instruct", text, interrupt: now && running && to === lane, attachments, lane: to, ...(to === lane ? handoff : {}) } : { type: "suggest", text, attachments, lane: to }), quiet: true });
        if (!r.ok) return putBack(r.error ?? "That didn't send. It's back in the box: try again.");
      }
      if (toLanes.length > 1 || toLanes[0] !== lane) notify(`Sent to ${new Intl.ListFormat("en", { type: "conjunction" }).format(toLanes.map((l) => agentNameFor(state, l)))}.`);
      if (carry) carried(sid, lane);
      // What has been typed since it went, if anything, is what the box holds now.
      setTyped(textarea.current?.value ?? "");
    } finally {
      setInterrupt(false);
      setBusy(false);
    }
  };

  return (
    <div className={cn("composer", `mode-${mode === "claim" ? "drive" : mode}`, toPeople && "to-people")}>
      {/* Out in a terminal (Terminal.tsx laneTerminal): what is sent waits, and this says so before it is typed, not after. */}
      {state.terminals?.[lane] && <InTerminalNote sid={sid} invite={invite} lane={lane} tool={state.engines[lane]?.tool} mine={state.engines[lane]?.hostId === me.id} />}
      {/* The one-row box is the rooms' (Arun: "ONLY REDESIGN FOR THE ROOM INPUT CHAT"); a teammate's own chat keeps the session's box (Arun, 2026-10-28). */}
      {state.options.team && inView === ALL && <span className="team-box-mark" hidden />}
      <div className="composer-caption">
        {/* Which agent this goes to, chosen here rather than by taking control
            somewhere else first. */}
        {/* Only when there is a choice to make: one agent and nobody to add is
            a pill that opens onto a list of one. */}
        {/* On Solo with one agent the picker in the box is the only one: this pill was the same agent again, plus an upsell. */}
        {state.options.team && <TeamRecipients sid={sid} text={typed} />}
        {state.options.team && inView === ALL && !namesSomeone(sid, typed) && <TeamWorking sid={sid} />}
        {!locked && !naming && (targets.length > 1 || others > 0 || (!fridayIsHere && me.role === "owner" && !ctx.solo)) && <MenuButton className="target-pill" label="Who it goes to" text={toPeople ? "The people here" : targetName(lane)} items={targetItems} width={targetWidth} above />}
        {/* Who has the wheel of that agent is the other half of the same question, so it sits beside it: pick who to write to, and
            here is whether you may, and the one press to take or ask for it. */}
        <DrivePill ctx={ctx} lane={lane} />
        {caption && (toPeople ? <Icon name="users" size={13} /> : mode === "drive" ? <MessageSquareIcon className="size-3.5" /> : mode === "claim" ? <HandIcon className="size-3.5" /> : mode === "suggest" ? <HandIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />)}
        {/* One line, shortened with "…" when the row is narrow: "Answer the agent" wrapped to three lines beside the To pill at 420. */}
        {caption && <span className="composer-caption-text" title={caption}>{caption}</span>}
        {/* On the same line as who you are writing to, at the other end of
            it: both are about this next message, and the plan stops being a
            thing that hovers over the conversation. */}
        {plan}
      </div>
      {managing && <CommandsDialog commands={saved.commands} me={me} onClose={() => setManaging(false)} onChanged={saved.reload} />}
      {/* The box and the list that opens above it, so the list sits on the box's own edge and never over what is typed. */}
      <div className="composer-box">
      {shortcuts.popover}
      <PromptInput
        onSubmit={onSubmit}
        multiple
        maxFiles={10}
        maxFileSize={10 * 1024 * 1024}
        globalDrop={canUpload}
        onError={(e) => notify(e.message)}
        className={cn("prompt", mode === "suggest" && "prompt-suggest")}
      >
        <PromptInputHeader>
          <PromptInputAttachments>{(f) => <PromptInputAttachment data={f} />}</PromptInputAttachments>
        </PromptInputHeader>
        {canUpload && <ContextDrops sid={sid} notify={notify} />}
        {/* The field is a card of its own, its controls on the tray under it, so what you type keeps one clean line. */}
        <PromptInputBody className="prompt-field relative block">
          {state.options.team && <MentionBackdrop sid={sid} text={typed} textarea={textarea} />}
          <PromptInputTextarea
            id="composer-input"
            aria-label={toPeople ? "Message the people here" : boxLabel}
            ref={textarea}
            disabled={mode === "view" && !toPeople}
            placeholder={placeholder}
            aria-describedby={keyNotice ? "composer-key-notice" : undefined}
            onChange={(e) => {
              setKeyNotice(false);
              setTyped(e.currentTarget.value);
              shortcuts.sync();
            }}
            onClick={shortcuts.sync}
            onBlur={shortcuts.close}
            onKeyDown={(e) => {
              // A list of commands or files that is open takes the arrows, Enter and Escape.
              if (shortcuts.onKeyDown(e)) return;
              // ↑ in an empty box: what you asked before (askHistory.ts).
              if (walkAsks(e, e.currentTarget, askAt, prefillComposer)) return;
              // ⌘↵ sends past a running step instead of queueing behind it.
              // The modifier is the whole interrupt control for anyone who
              // finds it, and the caption says so while a run is live.
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canInterrupt && typed.trim()) {
                e.preventDefault();
                interruptNext.current = true;
                setInterrupt(true);
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            {canUpload && (
              <PromptInputActionMenu>
                <PromptInputActionMenuTrigger aria-label="Add files" title="Add files or photos">
                  <Icon name="plus" size={16} />
                </PromptInputActionMenuTrigger>
                {/* Opens upward: the box sits at the bottom of the window, and a menu below it runs off the screen. */}
                <PromptInputActionMenuContent side="top" sideOffset={8}>
                  <PromptInputActionAddAttachments label="Attach files or photos" />
                  {noMachine && (
                    <PromptInputActionMenuItem disabled={sending} onSelect={() => folderInput.current?.click()}>
                      <Icon name="folder" size={14} /> <span className="ml-2">{sending ? "Uploading a folder…" : "Upload a folder"}</span>
                    </PromptInputActionMenuItem>
                  )}
                  {state.options.team && (
                    <PromptInputActionMenuItem onSelect={() => setGiving(true)}>
                      <Icon name="folder" size={14} /> <span className="ml-2">Give {agentNameFor(state, lane)} a folder or repo</span>
                    </PromptInputActionMenuItem>
                  )}
                  {onPin && (
                    <PromptInputActionMenuItem onSelect={onPin}>
                      <Icon name="link" size={14} /> <span className="ml-2">Pin a file or folder</span>
                    </PromptInputActionMenuItem>
                  )}
                </PromptInputActionMenuContent>
              </PromptInputActionMenu>
            )}
            {giving && <TeammateFolderCard identity={ctx.identity} lane={lane} trigger={textarea.current} onClose={() => setGiving(false)} notify={notify} />}
            {canUpload && (
              <input
                ref={folderInput}
                type="file"
                hidden
                multiple
                // @ts-expect-error -- not in the DOM types, understood by every browser.
                webkitdirectory=""
                directory=""
                onChange={(e) => {
                  void uploadFolder(e.target.files);
                  e.target.value = "";
                }}
              />
            )}
            {/* Who it goes to and on which model, inside the box under a rule, as on the new-session screen: one box, not a box and a row. */}
            {!toolPick && inView !== ALL && <TeammateBoxPicker identity={ctx.identity} lane={lane} notify={notify} />}
            {mode !== "view" && !toPeople && toolPick && (
              <AgentSwitch
                state={state}
                me={me}
                identity={ctx.identity}
                sid={sid}
                invite={invite}
                lane={lane}
                events={events}
                notify={notify}
                plan={ctx.plan}
                onFridayModel={(id) => send({ type: "settings.update", model: id })}
                onThinking={(t) => send({ type: "settings.update", thinking: t })}
                effort={effortChoice({ state, me, lane, send, notify })}
                {...(ctx.onConnect ? { onSetup: ctx.onConnect } : {})}
              />
            )}
            {/* Effort is a column of the agent picker for whoever steers the lane. Everybody else still sees the room's level
                here, read-only, so it isn't behind the view check. */}
            {(mode === "view" || !agentAndModelAreOne || !effortChoice({ state, me, lane, send, notify })) && <EffortPill state={state} me={me} lane={lane} send={send} notify={notify} />}
            {mode !== "view" && !toPeople && toolPick && <ReachPill ctx={ctx} lane={lane} />}
            {mode !== "view" && !toPeople && !agentAndModelAreOne && <LaneModelPill ctx={ctx} lane={lane} />}
            {/* Model and reasoning in one control, the same one the new session screen uses. Friday's models are for Friday Code: driving
                somebody's own Claude Code, Codex or Cursor, the model is theirs, and this pill would show a choice that changed nothing. */}
          </PromptInputTools>
          <div className="flex items-center gap-1 composer-send">
            {liveHint && <span className="composer-live-hint">{liveHint}</span>}
            {/* The same send button everywhere — a message, a suggestion, the
                home composer. What it does mid-run is the quiet line beside it. */}
            {paused && !typed.trim() && mode !== "view" && (
              <button type="button" className="btn small composer-resume" onClick={() => void send({ type: "run.resume", ...(lane !== MAIN_LANE ? { lane } : {}) }).then((r) => !r.ok && notify(r.error ?? "Couldn't resume."))}>
                <PlayIcon className="size-3.5" />
                Resume
              </button>
            )}
            {stopMode ? (
              <PromptInputSubmit
                type="button"
                status="streaming"
                aria-label={stopLanes.length > 1 ? "Stop the agents' tasks" : stopLanes[0] === lane ? "Stop the agent's task" : `Stop ${stopName}'s task`}
                title={stopLanes.length > 1 ? "Stop every agent's task: each stays free for your next message" : `Stop ${stopName}'s task: it stays free for your next message, and anything queued goes next`}
                // The box keeps the keyboard: the Stop button turns into Send under the pointer, and the focus fell to the page's
                // body with it (2026-10-29 verify).
                onClick={() => (stopLanes.forEach((l) => void send({ type: "run.pause", ...(l !== MAIN_LANE ? { lane: l } : {}) })), requestAnimationFrame(() => document.getElementById("composer-input")?.focus()))}
              />
            ) : (
              // Files alone are a message (onSubmit sends them, and the server takes them): Send was off until something was typed
              // beside them (2026-10-28 QA; Arun: "TEST EVERYTHING… EVERY INTERACTION"). Not for an aside, which can't carry files.
              <WithAttachments>
                {(n) => {
                  const empty = !typed.trim() && (toPeople || !n);
                  return (
                    <PromptInputSubmit
                      status={busy ? "submitted" : undefined}
                      disabled={(mode === "view" && !toPeople) || busy || empty || cantRun}
                      aria-label={mode === "suggest" ? "Suggest" : interrupt ? "Send now" : "Send"}
                      title={cantRun ? "Nothing to run this on yet: pick one of your coding tools in the agent menu" : empty ? "Write something first" : mode === "suggest" ? "Suggest a redirect" : interrupt ? "Send now, cutting the current step short" : canInterrupt ? `Queue for the next step · ${sendNow} to send now` : "Send"}
                    >
                      {busy ? undefined : <ArrowUpIcon className="size-4" />}
                    </PromptInputSubmit>
                  );
                }}
              </WithAttachments>
            )}
          </div>
        </PromptInputFooter>
      </PromptInput>
      {/* Never echoes the key. There is no way to send it: the agent would only get the placeholder. */}
      <div id="composer-key-notice" role="status" className="composer-key-notice">
        {keyNotice && (
          <>
            <p>
              This looks like a key. Friday hides keys from everyone in this session, the agent included, so it would get [secret hidden] instead. Put the key in .env on the computer running this agent and tell the agent the variable name, e.g. "use STRIPE_SECRET_KEY from .env".
            </p>
            <div className="composer-key-actions">
              <button
                type="button"
                className="btn small primary"
                autoFocus
                onClick={() => {
                  setKeyNotice(false);
                  textarea.current?.focus();
                }}
              >
                Edit
              </button>
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  const el = textarea.current;
                  if (!el) return;
                  el.value = hideSecrets(el.value).text;
                  setTyped(el.value);
                  setKeyNotice(false);
                  el.form?.requestSubmit();
                }}
              >
                Send without it
              </button>
            </div>
          </>
        )}
      </div>
      </div>
    </div>
  );
}

/**
 * An agent's state as a mark on its tab: a pulse while it works, amber when it waits (filled when on you), red when it
 * stopped on an error, orange out of usage, grey offline or paused. Ready and done need no mark: the tab says enough.
 */
export function AgentState({ status, needsYou = false }: { status: AgentStatus; needsYou?: boolean }) {
  if (status === "ready" || status === "done") return null;
  const word = needsYou ? "Needs you" : { working: "Working", waiting: "Waiting", paused: "Paused", offline: "Offline", limited: "Out of usage", failed: "Stopped on an error" }[status];
  return <span className={cn("agent-state", `is-${status}`, needsYou && "is-needs")} role="img" aria-label={word} />;
}

/** The tool's conversation compacted just before this run's first message (engine/hub.ts shouldCompact), and how big it was. */
function compactedBefore(events: SessionEvent[], lane: string, item: { key: number; startedTs?: number }): { compacted?: number } {
  if (item.key < 0) return {};
  const e = events.findLast((x) => x.seq < item.key && (x.lane ?? MAIN_LANE) === lane && (x.body.type === "context.compacted" || x.body.type === "run.started"));
  return e?.body.type === "context.compacted" ? { compacted: e.body.before } : {};
}
