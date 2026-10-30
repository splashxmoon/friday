import { ownPlan, refusal, whoseWork } from "../own-plan.js";
import { slowly } from "../slow.js";
import { closeSaying } from "../heartbeat.js";
import { overlaps, pathKey, platformOf } from "../folder-key.js";
import { peerHead } from "../session-notes-text.js";
import { meshHead } from "../mesh-note.js";
import { leadBrief, meshListing, newNotes, type AgentMesh } from "../agent-mesh.js";
import { backNote } from "../limit-handoff.js";
import { keepGoingNote } from "../keep-going.js";
import { runnableQueue } from "../held.js";
import { limitHit } from "../limit-reset.js";
import { fitModels, routeTool, stickyPick, taskTier, type ToolWindow } from "../routing.js";
import { missedLast, type Learned } from "../route-learning.js";
import { repoKeyOf } from "../repo-key.js";
import { randomUUID } from "node:crypto";
import { buildCatchUp, needsCatchUp } from "../session/catchup.js";
import { lastRunStart, spentBefore, tokensIn, ToolUsage } from "../tool-usage.js";
import { WebSocket } from "ws";
import type { Bus, BusMessage } from "../bus.js";
import { allowedCommand, can, canDriveLane, laneEffort, laneHeld, pendingFor, roleOf, runOf, unreadPosts, type MeshPost, type SessionState, effortResets } from "../session/projection.js";
import { accessCommand, type SessionCore } from "../session/core.js";
import { handoffBrief } from "../handoff.js";
import { startCheckpoint } from "../rewind.js";
import { shellSeconds } from "../runner/repo-read.js";
import { BROWSER_NOTE, WORK_NOTE } from "./work.js";
import { envNamesOnly } from "../runner/git.js";
import type { AppendGuard, SessionStore } from "../session/store.js";
import { hideSecretsIn, withShieldNote } from "../secrets.js";
import { localEdition } from "../local-edition.js";
import {
  CLI_ID,
  engineName,
  ENGINE_TOOLS,
  toolList,
  isEngineEffort,
  MAIN_LANE,
  mayBorrow,
  hostOnlyYes,
  type ActorRef,
  type Attachment,
  type DiffFile,
  type EngineInfo,
  type EngineMode,
  type EngineTool,
  type EventBody,
  type Member,
  type RepoCall,
  type RouteTier,
  type SessionEvent,
  type ToolCall,
} from "../types.js";

/**
 * The server side of "bring your own coding agent".
 *
 * A runner on someone's machine connects here and takes a lane. From then on
 * this hub does for that lane what the agent runtime does for Friday's own
 * agent — pick up queued instructions, mark them delivered, run a turn, end the
 * run — except the turn happens in the host's own CLI, not a model call.
 *
 * What the CLI does on the host's disk is real, so its messages and tool
 * results are logged even when a turn is interrupted: unlike a model's draft,
 * a command that already ran can't be taken back by discarding its output.
 */

export const SYSTEM_NOTE = [
  "You are working inside a Friday session: several people watch your work live, and one of them, the driver, steers you.",
  "Each message starts with the name of the person who sent it. Treat them as one team giving you one task.",
  // Plan, then work: the room reads the plan before the first file changes, and a wrong turn is caught there, not in a diff.
  "Plan before you change anything: read what the task points at, then say in a few short steps what you will change and in which files (use your todo list or plan tool if you have one), and only then start.",
  "Keep to the plan, and say so when it changes. A one-line fix or a question needs no plan.",
  // Arun, 2026-10-21: "look into the coding tools using sub agents ... for the tasks given to them, make it smart". In a week of
  // sessions Claude Code started six and the other tools none, so every task was read and checked one step at a time.
  "Use your own sub-agents (Claude Code's Task tool, Codex's spawn_agent, or your tool's own) when they save time: to search or read across many places at once, to look into several possible causes side by side, to check a finished change with fresh eyes, or to run checks that don't depend on each other. Start the independent ones together, in one step. Give each a complete brief (what to find out, where to look, what to hand back, briefly, with file:line) and keep the edits to yourself, unless the pieces are separate files. Not for a small task, or for steps that wait on each other: those you just do.",
  "You may be stopped mid-step when someone redirects you; when that happens, pick up from the newest message.",
  // Arun, 2026-10-20: "they need to keep going and working and stuff unless they are fully finished".
  "Keep working until the task is completely done: don't stop halfway to report progress or to ask whether to go on. Stop only when it is finished, or for a question only a person can answer.",
  "When a request is done, finish with a short summary of what you changed and anything the team should check.",
  "When something is clearer shown than said (numbers over time, how parts connect, a comparison, a before-and-after, a small tool to try), show it in your reply: ```mermaid for a diagram, ```svg for a drawing, or ```html for a page such as a chart, a dashboard or a small interactive tool. These render live in the session's chat. The page already has Friday's look, so build on it rather than styling from scratch: the variables --fg, --muted, --surface, --border, --accent, --good, --bad and --series-1 to --series-8, and the parts .card, .grid, .stat (with .label, .value and .delta.up or .delta.down), tables with .num cells, .badge and button.primary. Chart.js from cdn.jsdelivr.net is themed automatically: put each chart's canvas in a div with class chart, and leave its colours to the theme. Label series directly rather than relying on colour alone. Other libraries load from cdn.jsdelivr.net, unpkg.com, cdnjs.cloudflare.com or esm.sh (D3, three.js, p5.js, Leaflet with its map tiles, and the like), so it can be more than a chart: a 3D scene, a simulation, a map, an animated explainer, a small game or tool to try. It runs sandboxed with no network access beyond loading those, so put the data in the page. The people watching can copy it, download it (a page as an .html file, a drawing or diagram as an .svg) or open it full screen, so make it work at any size. Show when it helps someone understand, not as decoration.",
  "The session has a Preview panel beside the chat. When someone asks to see, preview or load up the app or a page: start its dev server in the background (never in the foreground, where it blocks you), wait until it is serving, then call the friday show_preview tool with its address (or, without that tool, write the address on a line of its own as `Preview: http://localhost:PORT`), and Friday opens it in the Preview panel, where the people watching see it. To see a page yourself (to check your work after a change), call the friday preview_screenshot tool: Friday takes the picture on this computer without opening anything. Never launch Chrome or another browser, headless or not, or install one, to look: each opens an app on the person's computer. For an iOS app on a Mac, write `Preview: ios` on a line of its own instead: Friday builds the folder's Xcode project, runs it in an iOS simulator and shows its screen there.",
  "The chat also draws Markdown tables (figures right-aligned), numbered plans, callouts (> [!NOTE], > [!WARNING], or a line starting \"Note:\" or \"Warning:\") and file paths in backticks (`src/app.ts:42`, which open the file), so prefer them to long prose when they fit. Maths is typeset from LaTeX: \\( … \\) inline, \\[ … \\] or $$ … $$ on their own lines for an equation (a single $ stays a dollar sign).",
].join(" ");

const MODES: EngineMode[] = ["plan", "edits", "full"];

/** How long a runner is given to say whether its tool took a message mid-turn before it goes with the next turn instead. */
const STEER_ANSWER_MS = 15_000;

/**
 * A message that can be read mid-turn: words to the agent, from a person, another agent or another session's. Not a Stop or
 * a cut-short (they end the turn), a yes to what it asked, Friday's carry-on, files to read, one of the tool's own `/`
 * commands, an edit of one still queued, a hand-off, whose brief starts a turn of its own, or one that asks for a turn of its own
 * (ownTurn), whose answer is read from that turn (2026-10-27 audit).
 */
function steerable(b: Extract<EventBody, { type: "instruction" }>): boolean {
  return !b.interrupt && !b.approval && !b.keepGoing && !b.ownTurn && !b.attachments?.length && !b.replaces && !b.handoff && !/^\/[\w:.-]+(\s|$)/.test(b.text.trim());
}

/**
 * How far a turn carrying anyone else's message may go on the host's computer (Security R2, R3): a teammate's, a
 * hand-off's, another agent's, or an app's posted as the host. As far as the host's own unless the host held others to Edits
 * (Auto is Auto for everyone's messages by default); Plan when the host picked Plan by hand. The runner holds the turn to the
 * lower of this and its own mode.
 */
export function othersCap(handMode: EngineMode | undefined, othersFull: boolean): EngineMode | undefined {
  if (othersFull) return handMode;
  return handMode === "plan" ? "plan" : "edits";
}
/** Speaks for the session itself when a rule somebody set answers a question. */
const FRIDAY: ActorRef = { id: "friday", name: "Friday", kind: "system" };
const MAX_TEXT = 20_000;
/** Enough of a past conversation to work from, without swamping every later prompt. */
const MAX_IMPORT_TURNS = 60;
const READ_TIMEOUT_MS = 20_000;
/**
 * How long each kind of request may take before the caller is told the machine
 * didn't answer. One flat 20 seconds was shorter than the runner allows a
 * command (two minutes), so a build or an install that was working fine was
 * reported as the machine not answering.
 */
const READ_TIMEOUTS_MS: Partial<Record<RepoCall["op"], number>> = {
  shell: 130_000,
  preview: 40_000,
  // Listing a project's schemes the first time, then 20 seconds of the build: more than a dev server's start.
  ios: 120_000,
  // A few version commands, each given five seconds.
  environment: 30_000,
  // Claude Code started for its own /context, its MCP servers connecting first.
  context: 70_000,
  publish: 90_000,
  commit: 60_000,
  restore: 60_000,
  checkpoint: 60_000,
  switch: 60_000,
  prcomments: 45_000,
  prstatus: 20_000,
  // Several gh calls: the checks, then a log per failed job.
  prchecks: 90_000,
  search: 30_000,
};
/** A command the agent gave longer to run is waited on for that long, and a little more for the answer to travel back. */
export const readTimeoutFor = (op: RepoCall["op"], timeoutSec?: number): number =>
  op === "shell" && timeoutSec ? shellSeconds(timeoutSec) * 1000 + 15_000 : (READ_TIMEOUTS_MS[op] ?? READ_TIMEOUT_MS);
const MAX_DELTA = 4_000;
/**
 * How long a turn's unlogged change set stays readable after its last burst. A turn that goes quiet for longer is only
 * shown to a joiner at its next edit, as before; a server that dies mid-turn leaves it behind no longer than this.
 */
const HELD_DIFF_S = 15 * 60;

/**
 * A teammate's note (teammates.ts teammateNote), which stays the same turn after turn, and what leads its turn's prompt when it
 * changes: its rooms, its memory since the conversation began, what it did on its backup, being away (`always`: every turn).
 */
export interface MateNote {
  note: string;
  preamble: { key: string; text: string; always?: true }[];
}

export interface RunnerParams {
  sid: string;
  me: Member;
  tool: string;
  mode: string;
  /** The mode its host picked by hand, when `mode` was chosen automatically for the host's own work. */
  handMode?: string;
  cwd: string;
  /** The folder `cwd` is a separate copy of, when it is one. */
  copyOf?: string;
  /** In the folder beside another agent that edits it, by choice (EngineInfo.shared). */
  share?: boolean;
  /** `cwd` with its links resolved on the host's machine, and the git repository it is in (or `real` again outside one). */
  real?: string;
  root?: string;
  /** The host's platform, which says whether its paths differ by case. */
  os?: string;
  /** Hostname of the machine the CLI runs on. */
  machine?: string;
  /** The shell its commands run in. */
  shell?: string;
  /** The effort levels its ACP tool said it offers, comma separated (EngineInfo.efforts). */
  efforts?: string;
  /** One of that CLI's own models. */
  model?: string;
  /** Which of its accounts on that computer it runs as, and what the person calls it (EngineInfo.account). */
  account?: string;
  accountLabel?: string;
  /** "1": its tool runs on an API key or a cloud provider, not its host's own plan (runner/api-key.ts, EngineInfo.apiKey). */
  apiKey?: string;
  branch: string;
  lane: string;
  newLane: string;
  /** A past conversation in the host's CLI that this lane continues. */
  resumeId?: string;
  resumeTitle?: string;
  resumeMessages?: number;
  /** Which tool that conversation was with. When it is not this lane's own, nothing is resumed: the conversation is carried in as history. */
  resumeTool?: string;
  /**
   * What this runner can do that older ones can't, comma-separated. `checkpoint`: it takes a run's checkpoint itself, just
   * before handing its tool the turn, and says it (see drain); without it the hub asks for one first and waits, as before.
   */
  caps?: string;
}

/**
 * The lane's running run has no checkpoint and every turn it handed out was cut by a drop (requeued) before its runner said
 * one: no turn of it reached a CLI (see Runner.turn), so a checkpoint taken now is still the folder from before the run.
 */
function neverRan(events: SessionEvent[], lane: string): boolean {
  let i = events.findLastIndex((e) => (e.lane ?? MAIN_LANE) === lane && e.body.type === "run.started");
  if (i < 0 || startCheckpoint(events, events[i]!)) return false;
  let delivered = 0;
  let cut = 0;
  for (; i < events.length; i++) {
    const e = events[i]!;
    if ((e.lane ?? MAIN_LANE) !== lane) continue;
    if (e.body.type === "instructions.delivered") delivered++;
    else if (e.body.type === "instructions.requeued") cut++;
  }
  return delivered > 0 && cut >= delivered;
}

/**
 * The instructions a lane's running run last handed its tool: delivered since the run started and not put back since
 * (instructions.requeued). A turn's end isn't logged, but the next delivery or the run's end follows it at once, so in a
 * run still marked running these are the turn that was under way.
 */
export function cutTurn(events: SessionEvent[], lane: string): number[] {
  const mine = events.filter((e) => (e.lane ?? MAIN_LANE) === lane);
  const start = mine.findLastIndex((e) => e.body.type === "run.started");
  if (start < 0) return [];
  const i = mine.findLastIndex((e, j) => j >= start && e.body.type === "instructions.delivered");
  if (i < 0) return [];
  const d = mine[i]!.body;
  if (mine.slice(i + 1).some((e) => e.body.type === "instructions.requeued")) return [];
  return d.type === "instructions.delivered" ? d.seqs : [];
}

/**
 * How big a coding tool's conversation may grow before Friday has it compacted between turns (its own /compact). Every step of
 * a turn reads the whole conversation again: on record, Claude Code's lanes ended turns at 427k tokens on average and read
 * 3M cached tokens a turn, because a lane keeps one conversation going for days and the tool only compacts itself near its
 * window's end (Arun, 2026-10-24: "look into optimizing token spends"). FRIDAY_COMPACT_AT sets it; 0 turns it off.
 */
export const compactAt = (window?: number): number => {
  const set = Number(process.env.FRIDAY_COMPACT_AT ?? 200_000);
  if (!set) return Infinity;
  // A small window: at half of it, so there is always room left for the turn itself.
  return window ? Math.min(set, Math.round(window / 2)) : set;
};

/** The tools whose own /compact Friday runs headless: Claude Code as typed, Codex over its app-server (runner.ts ownCommand). */
const COMPACTS = new Set<EngineTool>(["claude", "codex"]);

/**
 * Whether this lane's tool should compact its conversation before its next turn: its last turn ended with its context past
 * compactAt, and it hasn't been compacted since. The size its tool last reported, for the log.
 */
export function shouldCompact(events: SessionEvent[], lane: string, tool: EngineTool | undefined): { before: number; window?: number } | null {
  if (!tool || !COMPACTS.has(tool)) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if ((e.lane ?? MAIN_LANE) !== lane) continue;
    if (e.body.type === "context.compacted") return null;
    if (e.body.type === "agent.usage" && e.body.tool === tool) {
      const ctx = e.body.context ?? 0;
      return ctx >= compactAt(e.body.window) ? { before: ctx, ...(e.body.window ? { window: e.body.window } : {}) } : null;
    }
  }
  return null;
}

/** The calls that change a folder: a lane making one takes the pen on that folder (see EngineHub.writer). Reads never wait. */
/** What a Manual machine runs only on a yes (see readRepo in runner/repo-read.ts). */
const ASKED = new Set<RepoCall["op"]>(["shell", "bgstart", "publish", "preview"]);
const WRITES = new Set<RepoCall["op"]>(["write", "edit", "shell", "bgstart", "restore", "commit", "switch", "apply"]);
/** A pen whose lane never ends a run is given back after this long without a change. */
const PEN_TTL_S = 30 * 60;
/** Who is writing in a folder: machine and folder key, the lane, its person, the seq it was taken at, and the lane whose runner the folder is (its own, or a lent one). */
type Pen = { lane: string; machine: string; key: string; name: string; at: number; until: number; via?: string };
const laneLabel = (state: SessionState, lane: string) => (lane === MAIN_LANE ? "the main lane" : `the “${state.lanes.find((l) => l.id === lane)?.name ?? lane}” lane`);

/** How long a server's claim on its runners outlives its last renewal. */
const NODE_LEASE_S = 30;
/** How long a runner that dropped has to come back before its lane is shown offline and its run ended. */
const offlineGraceMs = () => Number(process.env.FRIDAY_OFFLINE_GRACE_MS ?? 20_000);
/** Ways a runner leaves that cut a turn short without anybody choosing to: its instructions are put back (LaneHost.leave). */
const DROPPED = new Set(["disconnected", "shutdown", "replaced"]);
/** How recently a Friday run cut off by a restart may have been working for it to carry on by itself when the session is opened. */
const CARRY_ON_MS = 30 * 60_000;

export class EngineHub {
  private hosts = new Map<string, LaneHost>();
  /**
   * This server process, and a lease saying it is alive.
   *
   * A runner's socket lives in one process. When that process is killed rather than shut down (a crash, a hard stop, a
   * dev server restarted on Windows) nothing records that its runners went with it, so their lanes said "online" for
   * good and every instruction waited on an agent that was not there. Each attached engine names its node; one whose
   * node's lease has run out is marked disconnected the next time anybody opens the session or attaches.
   */
  readonly node = randomUUID();
  /**
   * Lanes a runner of this server is attaching to right now (written to the log, not yet held), and when each runner of this
   * server last let go of one, by "sid|lane": what reap needs to tell a lane this server holds, or is about to, or let go of
   * moments ago (LaneHost.markOffline gives it its grace), from one no runner holds at all.
   */
  private lanesAttaching = new Map<string, number>();
  private droppedAt = new Map<string, number>();
  /** Set by the app: the project brain's briefing for a lane's first turn (brain.ts). */
  brief: ((sid: string, lane: string, task: string) => Promise<string>) | null = null;
  /** A teammate's own note for its tool (teammates.ts teammateNote), and what its turn is told first, when the lane is one; null otherwise. */
  teammate: ((sid: string, lane: string) => Promise<MateNote | null>) | null = null;
  /** Set by the app: whether a team's queues are held (the person paused the team), for a lane of a team session. */
  teamPaused: ((sid: string) => Promise<boolean>) | null = null;
  /** Set by the app: what runs in a workspace have shown about each model, for routing (route-learning.ts). */
  learned: ((workspaceId: string) => Promise<Learned>) | null = null;
  /** Set by the app: the agents' messages to each other, which a runner's `friday` MCP server calls (agent-mesh.ts). */
  mesh: AgentMesh | null = null;
  private readonly leaseTimer: NodeJS.Timeout;

  constructor(
    private store: SessionStore,
    private bus: Bus,
    private core: SessionCore,
  ) {
    const renew = () => void this.store.redis.set(this.leaseKey(this.node), "1", "EX", NODE_LEASE_S).catch(() => {});
    renew();
    this.leaseTimer = setInterval(renew, (NODE_LEASE_S / 3) * 1000);
    this.leaseTimer.unref?.();
  }

  /**
   * The only server there is (the open-source edition, on your own computer): another server's lanes are a previous run of this
   * app, gone however recently its lease was renewed, since that lease is kept in Friday's own data and outlives a restart. Read
   * as alive, they stayed "online" with no runner after a restart, so neither the boot's reattach nor the page's quiet reconnect
   * brought them back (Arun, 2026-10-30: "fix the app not connecting to computer after restart").
   */
  sole = false;

  private leaseKey(node: string): string {
    return `${this.store.prefix}node:${node}`;
  }

  /** Sessions with a look booked for when another server's lease will have run out. */
  private rechecks = new Set<string>();

  /**
   * Mark offline every lane whose runner was held by a server process that is gone.
   *
   * `reattach`: a runner of that host attaching to that lane again, which proves its old connection is gone whatever the
   * old server's lease says. Waiting for the lease there let the new runner take over a run the old one was killed in the
   * middle of, and with nothing left to deliver that run was logged as done.
   */
  async reap(sid: string, recheck = true, reattach?: { lane: string; hostId: string }): Promise<void> {
    const state = await this.store.state(sid);
    let events: SessionEvent[] | null = null;
    for (const [lane, e] of Object.entries(state.engines)) {
      if (!e.online || !e.node) continue;
      const self = !!reattach && lane === reattach.lane && e.hostId === reattach.hostId;
      if (e.node === this.node) {
        // This server's own: online only while one of its runners holds it, is attaching, or dropped it within the grace a short
        // drop is given. Otherwise the log said connected while every live look at the runner said no (2026-10-27 QA: the
        // status bar against the Tree, the branch picker and setup).
        const key = `${sid}|${lane}`;
        if (this.hosts.has(key) || Date.now() - (this.lanesAttaching.get(key) ?? 0) < 30_000 || Date.now() - (this.droppedAt.get(key) ?? 0) < offlineGraceMs() + 5_000) continue;
      } else if (!self && !this.sole && (await this.store.redis.exists(this.leaseKey(e.node)))) {
        // Browsers reconnect seconds after a restart, while a dead server's lease is still running: look again once it can't be.
        if (recheck && !this.rechecks.has(sid)) {
          this.rechecks.add(sid);
          setTimeout(() => {
            this.rechecks.delete(sid);
            void this.reap(sid, false).catch((err) => console.error("[engine] reap:", err));
          }, (NODE_LEASE_S + 2) * 1000).unref?.();
        }
        continue;
      }
      const human: ActorRef = { id: e.hostId, name: e.hostName, kind: "human" };
      const r = await this.store.append(sid, human, { type: "engine.detached", reason: "disconnected", ...(e.tool ? { tool: e.tool } : {}) }, { lane });
      if (r.ok && e.tool && runOf(state, lane).status === "running") {
        const agent: ActorRef = { id: `engine:${e.hostId}`, name: `${e.hostName}'s ${engineName(e.tool)}`, kind: "agent" };
        // A server that died without its shutdown (a deploy cut short, a crash) never put its turns back: what the tool was
        // working on was marked delivered and lost with it, so the run ended and the task with it (Arun, 2026-10-23: most
        // failed runs were this). It goes back to the front of the queue here, as a clean shutdown would have put it.
        events ??= await this.store.events(sid);
        const cut = cutTurn(events, lane);
        if (cut.length) await this.store.append(sid, agent, { type: "instructions.requeued", seqs: cut }, { lane });
        // The same machine back: the run carries on, given its turn again, rather than ending for somebody to send it on.
        if (self) continue;
        await this.store.append(sid, agent, { type: "run.ended", outcome: "error", error: `${agent.name} lost its connection when the server restarted. It carries on from where it was when it reconnects.`, cut: true }, { lane });
      }
    }
    // Friday's own agent, cut off the same way: a server going down stops its run without ending it, and a run marked running
    // with nobody holding its lease blocked switching, committing, undoing and the shepherd for good. Woken, it carries on
    // from the log; a wake that finds the lane already running somewhere is a no-op, so this can't start it twice.
    // Only one cut off lately, though: opened days later, a run carrying on by itself would be spending on work nobody is
    // watching, so that one is ended, saying how to pick it up.
    for (const lane of [MAIN_LANE, ...state.lanes.map((l) => l.id)]) {
      if (state.engines[lane]?.tool || runOf(state, lane).status !== "running") continue;
      if (await this.store.redis.exists(this.store.keys(sid).runnerFor(lane))) continue;
      events ??= await this.store.events(sid);
      const last = events.findLast((e) => (e.lane ?? MAIN_LANE) === lane)?.ts ?? 0;
      if (Date.now() - last < CARRY_ON_MS) {
        await this.bus.wake(sid, lane);
        continue;
      }
      const system: ActorRef = { id: "system", name: "System", kind: "system" };
      await this.store.append(sid, system, { type: "run.ended", outcome: "error", error: "This run stopped when the server restarted. Send an instruction to carry on from where it was." }, { lane });
    }
  }

  /**
   * The folder a session's coding agents are working in, read on behalf of
   * whoever asked — Friday's own agent, usually, which has never seen it.
   *
   * A session can have several engines; the one named is used, otherwise the
   * first connected one this lane may borrow (mayBorrow), in the session's own order: the one Friday's
   * agent describes in its prompt and asks a Manual machine's approval for.
   * The order connections happened to arrive in here is not that order (a
   * reconnect moves a machine to the end), and following it ran a command on
   * a different machine from the one whose approval was checked. They are
   * nearly always the same folder, and when they are not, saying which one
   * answered is the honest thing.
   *
   * Null when no machine is connected, rather than an apology: the caller has
   * a second place to look — a folder someone uploaded — and only it knows
   * whether that exists.
   *
   * `by` is the person asking, when a person asks: borrowing a coding tool's machine then also needs it to be theirs, so
   * an owner who isn't driving can't send a command, edit or commit to the driver's own tool.
   */
  /** The usage windows of the tool on `lane`, as its runner last read them; none when it hasn't said or isn't here. */
  usage(sid: string, lane: string): ToolWindow[] {
    return this.hosts.get(`${sid}|${lane}`)?.windows ?? [];
  }

  async readRepo(sid: string, req: RepoCall, lane?: string, by?: string): Promise<{ output: string; where?: { host: string; cwd: string; branch?: string } } | null> {
    let host = lane ? this.hosts.get(`${sid}|${lane}`) : undefined;
    // A tool's own commands are that lane's tool's: another machine's would be another tool's.
    if (!host && req.op === "commands") return null;
    if (!host && lane) {
      // A lane with a machine of its own works in that machine's folder, often a separate copy. With the machine offline,
      // another one's folder is not where its files are: an Undo there reverted somebody else's work, and a commit committed
      // their copies of the files. Said instead, so it can be done once the machine is back.
      const own = (await this.store.state(sid)).engines[lane];
      if (own) return { output: `${own.hostName}'s computer isn't connected, so this can't be done in that agent's folder right now. Reconnect it, then try again.` };
    }
    if (!host) {
      // A folder lent to the session is shared; a coding tool's machine only with its own host driving (see mayBorrow).
      // Borrowing a teammate's ran their commands and wrote their files on somebody else's say-so.
      const state = await this.store.state(sid);
      host = Object.entries(state.engines)
        .flatMap(([l, e]) => (e.online && mayBorrow(state, lane ?? MAIN_LANE, e) && (!e.tool || by === undefined || e.hostId === by) ? [this.hosts.get(`${sid}|${l}`)] : []))
        .find(Boolean);
    }
    if (!host) return null;
    // A yes counts on a machine only when its host gave it: a Manual machine is its host's to say yes for, not the
    // driver's or an owner's. Anyone else's yes is refused there with who to ask; elsewhere it is dropped.
    const { approvedBy, personId, ...call } = req;
    // A .env's values go only to the host reading their own machine's file: anyone else sees which variables it sets.
    if (call.person && personId !== host.info.hostId) delete call.person;
    if (call.approved && approvedBy !== host.info.hostId) {
      if (host.info.mode === "edits" && ASKED.has(call.op)) return { output: hostOnlyYes(host.info.hostName) };
      delete call.approved;
    }
    const busy = WRITES.has(call.op) && host.info.mode !== "plan" ? await this.takePen(sid, lane ?? MAIN_LANE, host.lane, host.info, call.op === "apply", by) : null;
    if (busy) return { output: busy };
    return { output: await host.readRepo(call), where: host.where };
  }

  private writersKey(sid: string): string {
    return `${this.store.prefix}{${sid}}:writers`;
  }

  /**
   * Another lane writing in a folder that overlaps `root` on `machine`, if one is (see "One writer per folder").
   *
   * A lane holds the pen from its first change to the folder in a run until that run ends, or the lane goes, or the lease
   * runs out: written down in the store rather than here, so a lane writing through another server is counted too. A pen
   * taken through a lent folder never refuses that folder's own runner reattaching (`reattach` is its lane), but does
   * refuse that folder's own lane writing: it is another writer in the same folder.
   */
  private async writer(sid: string, state: SessionState, machine: string, root: string, os: string, skip?: string, reattach?: string): Promise<[string, { hostName: string }] | undefined> {
    const held = Object.values(await this.store.redis.hgetall(this.writersKey(sid))).map((raw) => JSON.parse(raw) as Pen);
    for (const l of held) {
      if (l.lane === skip || (reattach && l.via === reattach) || l.machine !== machine || l.until < Date.now() || !overlaps(l.key, root, os)) continue;
      if (l.lane !== MAIN_LANE && !state.lanes.some((x) => x.id === l.lane)) continue;
      const run = runOf(state, l.lane);
      if ((run.status !== "running" && run.status !== "paused") || run.sinceSeq > l.at) continue;
      return [l.lane, { hostName: l.name }];
    }
  }

  /** Each session's pens being taken, one at a time, so two lanes changing one folder at once can't both find it free. */
  private penning = new Map<string, Promise<unknown>>();

  /**
   * Take the pen on the folder this change lands in for `lane`, or say who has it. A change made by hand while the lane
   * has no run going is checked but takes no pen: nothing would end it, and it held the folder for the whole lease.
   */
  private takePen(sid: string, lane: string, via: string, e: EngineInfo, apply: boolean, by?: string): Promise<string | null> {
    // Sharing the folder by choice: it neither waits for another agent's pen nor holds one.
    if (e.shared) return Promise.resolve(null);
    // ponytail: one at a time per server process, as attach is; a lock in the store if two servers ever race here.
    const turn = (this.penning.get(sid) ?? Promise.resolve()).then(async () => {
      const state = await this.store.state(sid);
      const machine = e.machine || e.hostId;
      const os = e.os || platformOf(e.cwd);
      // Apply writes into the folder the copy was made from.
      const root = apply && e.copyOf ? e.copyOf : (e.root ?? e.cwd);
      const other = await this.writer(sid, state, machine, root, os, lane);
      if (other) return `${other[1].hostName}'s agent is already editing that folder on ${laneLabel(state, other[0])}.`;
      const run = runOf(state, lane);
      if (run.status !== "running" && run.status !== "paused") return null;
      const name = (by && state.members[by]?.name) || (lane === MAIN_LANE ? state.driver : state.laneDrivers[lane])?.name || "Friday";
      const key = pathKey(root, os);
      const pen: Pen = { lane, machine, key, name, at: state.lastSeq, until: Date.now() + PEN_TTL_S * 1000, via };
      await this.store.redis.multi().hset(this.writersKey(sid), `${machine}|${key}`, JSON.stringify(pen)).expire(this.writersKey(sid), PEN_TTL_S).exec();
      return null;
    });
    const settled = turn.catch(() => {});
    this.penning.set(sid, settled);
    void settled.then(() => this.penning.get(sid) === settled && this.penning.delete(sid));
    return turn;
  }

  /**
   * The change sets of turns running and not logged yet, for someone joining mid-turn to see what the others see. Read from
   * Redis, not from the runners held here: the runner may be attached to another server than the one the joiner reached.
   */
  async heldDiffs(sid: string, state: SessionState): Promise<BusMessage[]> {
    const lanes = [MAIN_LANE, ...state.lanes.map((l) => l.id)];
    const held = await this.store.redis.mget(lanes.map((l) => this.store.keys(sid).heldDiff(l)));
    return held.flatMap((raw) => (raw ? [JSON.parse(raw) as BusMessage] : []));
  }

  /** Each session's attach in progress, which the next one waits for. */
  private attaching = new Map<string, Promise<void>>();

  /**
   * Admit a runner. `me` must already be a member (the gateway checked the
   * invite). Rejections close the socket with a code the runner can explain.
   *
   * One session's runners are admitted one at a time. The one-writer check reads
   * who is editing a folder and the attach that passes it writes itself in, with
   * waits in between, so two agents pressed in at once both read "nobody" and both
   * went in.
   */
  attach(ws: WebSocket, p: RunnerParams): Promise<void> {
    // ponytail: one at a time per server process; two servers admitting at the same moment can still both pass. A lock in
    // the store, if that is ever seen.
    const made = { lane: "" };
    const turn = (this.attaching.get(p.sid) ?? Promise.resolve()).then(() =>
      this.admit(ws, p, made).catch(async (err) => {
        await this.unmake(p, made);
        throw err;
      }),
    );
    const settled = turn.catch(() => {});
    this.attaching.set(p.sid, settled);
    void settled.then(() => this.attaching.get(p.sid) === settled && this.attaching.delete(p.sid));
    return turn;
  }

  /**
   * Take away the lane an attach made for itself, when that attach went no further: a refused agent leaves no empty lane
   * with its name on it for the next one, and for hand-offs, to find. Straight into the log rather than as a command:
   * removing a lane is an owner's, and a teammate's own lane is theirs to have made.
   */
  private async unmake(p: RunnerParams, made: { lane: string }): Promise<void> {
    const lane = made.lane;
    made.lane = "";
    if (lane) await this.store.append(p.sid, { id: p.me.id, name: p.me.name, kind: "human" }, { type: "lane.removed", laneId: lane }).catch(() => {});
  }

  private async admit(ws: WebSocket, p: RunnerParams, made: { lane: string }): Promise<void> {
    const reject = async (code: number, why: string) => {
      await this.unmake(p, made);
      // Said as well as closed with: the hosted server's proxy drops a close's code and reason (see closeSaying).
      closeSaying(ws, code, why);
    };
    // No tool at all is a folder lent to the session: Friday's own agent works
    // in it through this same bridge. A tool we don't run is still a mistake.
    if (p.tool && !ENGINE_TOOLS.includes(p.tool as EngineTool)) return reject(4000, `Friday doesn't run ${p.tool}. Connect ${toolList()} instead.`);
    const tool = (p.tool as EngineTool) || undefined;
    // A conversation from another tool (a Claude Code session continued in Codex, say) cannot be resumed by this one: its transcript is
    // not in this tool's store. It comes in as history instead, which every agent in the room can read.
    const from = ENGINE_TOOLS.includes(p.resumeTool as EngineTool) ? (p.resumeTool as EngineTool) : tool;
    const sameTool = !!tool && from === tool;
    // Only an id a CLI could have given: the session hands this one on, and a teammate's machine puts it on a command line.
    const resumeId = p.resumeId && CLI_ID.test(p.resumeId) ? p.resumeId.slice(0, 100) : undefined;
    // Auto when none is said, as every agent starts (Arun, 2026-10-18).
    const mode = (MODES.includes(p.mode as EngineMode) ? p.mode : "full") as EngineMode;
    // Chosen automatically for the host's own work: what the host picked by hand holds for everyone else's turns (see drain).
    const handMode = MODES.includes(p.handMode as EngineMode) && p.handMode !== mode ? (p.handMode as EngineMode) : undefined;

    // A lane still marked as somebody's from a server that died would otherwise refuse this attach as taken.
    await this.reap(p.sid, true, p.newLane ? undefined : { lane: p.lane || MAIN_LANE, hostId: p.me.id });
    let state = await this.store.state(p.sid);
    let lane = p.lane || MAIN_LANE;
    // On Solo only a session's owner brings an agent into it: a teammate's agent working beside them is Team.
    if (roleOf(state, p.me.id) !== "owner" && !(await this.core.collaborates(state))) return reject(4003, "This workspace is on Solo: only the session's owner can bring an agent. Working together needs Team.");
    // Who is already editing this folder, on any lane but `skip`: see "One writer per folder" below.
    // Compared by machine and the repository the folder is in, links resolved on that machine (two subfolders of one
    // checkout share its files and its git index), and counting a Friday lane writing through a lent folder there too.
    const os = p.os || platformOf(p.cwd);
    const machine = p.machine || p.me.id;
    const root = p.root || p.real || p.cwd;
    // Sharing the folder, by choice, or joining one shared: nobody is held back (EngineInfo.shared). A lane that shared it keeps
    // sharing it when it comes back, whatever brought it back: a restart that didn't say so made it the folder's one writer, and
    // the lanes beside it were turned away as they came back (Arun, 2026-10-26: "the coding tools not reconnecting").
    let share = !!p.share || (!p.newLane && !!state.engines[lane]?.shared);
    // A Work session's agents make its pieces together in one folder: every lane shares it (engine/work.ts). Only where Arun's
    // own build runs: a Work flag on a session anywhere else is nothing (Arun, 2026-10-28: "iron everything and ensure we are good").
    if (state.options.work && localEdition()) share = true;
    const editing = async (skip?: string): Promise<[string, { hostName: string }] | undefined> =>
      mode === "plan" || share
        ? undefined
        : (Object.entries(state.engines).find(([id, e]) => id !== skip && e.online && e.mode !== "plan" && !e.shared && (e.machine || e.hostId) === machine && overlaps(e.root ?? e.cwd, root, os)) ??
          (await this.writer(p.sid, state, machine, root, os, skip, skip)));
    const clashWith = ([clashLane, e]: [string, { hostName: string }]) =>
      // A WebSocket close reason is capped at 123 bytes, so this has to say
      // it in one line or be cut off mid-sentence.
      reject(4010, `${e.hostName}'s agent is already editing that folder on ${laneLabel(state, clashLane)}. Pick another folder, or plan-only to watch.`);
    if (p.newLane) {
      const owner = roleOf(state, p.me.id) === "owner";
      // An owner adds a lane to the room. A teammate adds one for their own agent,
      // named for them so the room can tell whose is whose, and driven by them.
      if (!owner && !can(state, p.me.id, "control")) return reject(4003, "You can't steer in this session, so you can't add an agent to it.");
      // Asked before the lane is made, so a refusal leaves nothing behind. Asked again just before attaching, below.
      const first = await editing();
      if (first) return clashWith(first);
      const laneName = owner ? p.newLane.slice(0, 40) : `${p.me.name.split(" ")[0]}'s ${p.newLane}`.slice(0, 40);
      // A coding tool's lane is the person's own, any number of them; a folder lent with no tool is a lane for Friday's agent,
      // which the plan limits like any other (it used to be counted as a tool, and went past the plan's limit).
      const r = await this.core.handle(p.sid, p.me, { type: "lane.add", name: laneName, control: { kind: "open" }, engine: !!tool, ...(owner ? {} : { own: true }) });
      if (!r.ok) return reject(4000, r.error);
      state = await this.store.state(p.sid);
      lane = state.lanes.at(-1)!.id;
      made.lane = lane;
      // The host starts out steering their own machine.
      await this.core.handle(p.sid, p.me, { type: "control.claim", lane });
      state = await this.store.state(p.sid);
    }
    if (lane !== MAIN_LANE && !state.lanes.some((l) => l.id === lane)) return reject(4004, "That lane isn't in this session.");
    // Someone else's coding tool on their own plan is on it: it is theirs alone (own-plan.ts). Yours goes beside it, as an agent of its own.
    const sitting = state.engines[lane];
    if (ownPlan(sitting) && sitting.online && sitting.hostId !== p.me.id) return reject(4009, `${sitting.hostName}'s ${engineName(sitting.tool!)} is on that lane, on ${sitting.hostName}'s own plan. Add yours as a new agent beside it.`);
    if (!canDriveLane(state, p.me.id, lane)) return reject(4003, "You can't steer that lane, so you can't attach an agent to it.");
    // Someone else's lane stays theirs while it is online, and for a while after it drops: a network blip is not a handover.
    const held = laneHeld(state.engines[lane], p.me.id);
    if (held) return reject(4009, held);

    /**
     * One writer per folder.
     *
     * Lanes exist so several agents can work at once, and the log keeps their
     * turns in order — but two agents editing the same checkout is not a
     * question of ordering. They overwrite each other's files, and each one's
     * diff includes the other's changes, so nobody can tell who did what. The
     * lane guard above only stops two people on the same lane; this stops two
     * lanes on the same folder.
     *
     * Reading is not writing: any number of agents may look at a folder
     * somebody else is working in, which is how a reviewer watches a change
     * being made. Only the ones that can change it have to take turns.
     */
    const clash = await editing(lane);
    if (clash) return clashWith(clash);

    const key = `${p.sid}|${lane}`;
    // Attaching from here until its runner is held, or it gives up: a while at most, whichever way it leaves.
    this.lanesAttaching.set(key, Date.now());
    // Gone while all that was being decided: nothing is attached, nothing is announced, and whatever has the lane keeps it.
    if (ws.readyState !== WebSocket.OPEN) return;
    // The same host reconnecting (or attaching again) replaces its old runner, with the code that tells it not to come
    // back: a runner that reconnects by itself would otherwise take the lane straight back from the one that replaced it.
    this.hosts.get(key)?.close("replaced", 4009);
    const info: EngineInfo = {
      ...(tool ? { tool } : {}),
      hostId: p.me.id,
      hostName: p.me.name,
      cwd: p.cwd.slice(0, 400),
      ...(p.copyOf ? { copyOf: p.copyOf.slice(0, 400) } : {}),
      ...(share ? { shared: true as const } : {}),
      ...(p.root || p.real ? { root: (p.root || p.real)!.slice(0, 400) } : {}),
      ...(p.os ? { os: p.os.slice(0, 10) } : {}),
      ...(p.machine ? { machine: p.machine.slice(0, 60) } : {}),
      ...(p.shell ? { shell: p.shell.slice(0, 20) } : {}),
      ...(p.efforts && p.efforts.split(",").some(isEngineEffort) ? { efforts: [...new Set(p.efforts.split(",").filter(isEngineEffort))] } : {}),
      ...(p.model ? { model: p.model.slice(0, 60) } : {}),
      ...(p.account ? { account: { id: p.account.slice(0, 40), label: (p.accountLabel || p.account).slice(0, 40) } } : {}),
      ...(p.apiKey === "1" ? { apiKey: true as const } : {}),
      mode,
      ...(handMode ? { handMode } : {}),
      ...(p.branch ? { branch: p.branch.slice(0, 100) } : {}),
      ...(resumeId && sameTool ? { resumedFrom: { id: resumeId, title: (p.resumeTitle || "an earlier session").slice(0, 120), messages: Math.max(0, Math.min(100_000, Number(p.resumeMessages) || 0)) } } : {}),
      node: this.node,
    };
    const human: ActorRef = { id: p.me.id, name: p.me.name, kind: "human" };
    // Gone while it waited its turn: attached, it would have shown online with nobody there to take what it was given.
    if (ws.readyState !== WebSocket.OPEN) return reject(4000, "The agent left before it attached.");
    // A different tool or computer taking the lane drops its pinned effort (the projection does that); this only tells the room.
    const effortReset = effortResets(state, lane, info);
    const r = await this.store.append(p.sid, human, { type: "engine.attached", engine: info, ...(effortReset ? { effortReset: true as const } : {}) }, { lane });
    if (!r.ok) return reject(4000, "Could not attach.");
    // The lane has its agent now: from here it comes and goes the way any lane's does.
    made.lane = "";

    // Worked out before the host listens, not after: an instruction heard in between could send the runner a checkpoint
    // ahead of "attached", before it has switched branch or loaded its conversation.
    // The conversation it continues is in the log already (a hand-off of one, a runner reconnecting): it needn't read it from
    // disk and send it again, and the lane's first turn doesn't wait to hear it (see LaneHost's import gate).
    const events = await this.store.events(p.sid);
    const imported = !!resumeId && events.some((e) => e.body.type === "session.imported" && e.body.sourceId === resumeId);
    const host = new LaneHost(p.sid, lane, r.seq, info, ws, this.store, this.bus, () => {
      if (this.hosts.get(key) === host) (this.hosts.delete(key), this.droppedAt.set(key, Date.now()));
    }, resumeId && from && !imported ? { id: resumeId, title: (p.resumeTitle || "an earlier session").slice(0, 120), tool: from } : null, this.brief ? (l, task) => this.brief!(p.sid, l, task) : null, this.learned);
    host.selfCheckpoint = (p.caps ?? "").split(",").includes("checkpoint");
    host.steers = (p.caps ?? "").split(",").includes("steer");
    host.mesh = this.mesh;
    host.teammate = this.teammate ? () => this.teammate!(p.sid, lane) : null;
    host.teamPaused = this.teamPaused ? () => this.teamPaused!(p.sid) : null;
    // What its first turn will be told besides the instruction, so its CLI can be started before that turn comes.
    const system = tool ? await host.systemNote(events) : undefined;
    this.hosts.set(key, host);
    this.lanesAttaching.delete(key);
    this.open.add(host);
    void host.gone.then(() => this.open.delete(host));
    await host.start();
    const laneName = lane === MAIN_LANE ? "Main" : (state.lanes.find((l) => l.id === lane)?.name ?? lane);
    // And how hard it thinks, so the CLI kept warm for the first turn is started with the flag that turn will carry.
    const effort = effortReset ? undefined : laneEffort(state, lane, tool);
    const attached: Record<string, unknown> = { kind: "attached", lane, laneName, ...(imported ? { imported: true } : {}), ...(system ? { system } : {}), ...(effort ? { effort } : {}) };
    if (host.work) attached.work = true;
    host.sendRaw(attached);
    void host.pump();
  }

  /**
   * Every runner here until its leaving is written down. One that disconnected just before a shutdown (its host stopped it a
   * moment earlier) is no longer in `hosts` but still writing that it went: the shutdown waits for it too, or its writes
   * landed after Redis was closed.
   */
  private open = new Set<LaneHost>();

  /** Close every runner connection this node holds; each lane shows offline until its runner reconnects. */
  /** Every machine attached to one session let go (its team deleted): each tool told to stop, and its connection closed. */
  async release(sid: string, why: string): Promise<void> {
    const mine = [...this.hosts].filter(([k]) => k.startsWith(`${sid}|`)).map(([, h]) => h);
    for (const h of mine) h.sendRaw({ kind: "stop", reason: why });
    await Promise.all(mine.map((h) => h.close(why, 4004)));
  }

  /**
   * Every session in `sids` reaped once the leases of servers before this one have run out: at start, so lanes no runner holds
   * read offline everywhere (the sidebar, the Board), not only in a session someone opens (2026-10-27 QA). The timer, to clear.
   */
  reapAfterLeases(sids: () => Promise<string[]>, afterMs = (NODE_LEASE_S + 2) * 1000): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      void (async () => {
        for (const sid of await sids()) await this.reap(sid, false).catch((e) => console.error("[engine] reap:", e));
      })().catch((e) => console.error("[engine] reap:", e));
    }, afterMs);
    t.unref?.();
    return t;
  }

  async shutdown(): Promise<void> {
    clearInterval(this.leaseTimer);
    await Promise.all([...this.open].map((h) => h.close("shutdown")));
  }
}

type TurnEnd = { outcome: "done" | "stopped" | "error"; error?: string };

class LaneHost {
  private busy = false;
  private rerun = false;
  private closed = false;
  private turn: { id: string; resolve: (r: TurnEnd) => void } | null = null;
  /**
   * The answer the tool has written so far in this turn and not yet said as a message of its own (its streamed text): kept when
   * the turn is stopped, as an interrupted message, so a Stop doesn't take away what was already on screen. Stopping a run left
   * only its first line, and a draft cut short is often the very thing that was asked for (Arun, 2026-10-28: "iron everything
   * and ensure we are good… any logic errors and fixes").
   */
  private draft = "";
  /**
   * The turn under way was told to stop (a Stop, a redirect that couldn't wait): what the tool says after that is not the
   * finished form of its draft, so a message then doesn't take the draft's place (Arun, 2026-10-28: "iron everything and ensure
   * we are good"). A redirect then Stop lost every line the stopped turn had streamed to the words of the turn after it.
   */
  private stopSent = false;
  /** The instructions the turn under way was given: put back in the queue if the machine drops before it ends. */
  private inFlight: number[] | null = null;
  /** Its turn's instructions were put back: the run is left going for the runner that comes back, not ended with an error. */
  private requeued = false;
  /** Its tool's /compact failed on this connection (an older version, say): not tried again before every turn. */
  private compactFailed = false;
  /** Approvals the tool is waiting on in the turn now running (see `engine.approval`'s `live`): their answers go straight to it. */
  private readonly live = new Set<string>();
  /** Live asks already answered: a second answer to one (two people pressing at once) is not a new turn with permission. */
  private readonly answered = new Set<string>();
  /** Each tool's tokens and what hand-offs carried, for the Usage page (see tool-usage.ts). */
  private get usage(): ToolUsage {
    return new ToolUsage(this.store.redis, this.store.prefix);
  }
  /** Outstanding repo reads, by request id. */
  private reads = new Map<string, (output: string) => void>();
  /** The runner takes a run's checkpoint itself, just before its tool hears the turn (RunnerParams.caps): drain doesn't ask for one. */
  selfCheckpoint = false;
  /** The runner can hand its tool a message mid-turn (Parser.steer): one for a busy agent is read at its next step. */
  steers = false;
  /** Messages handed to the turn running now, by the id they went with, until the runner says whether its tool took them. */
  private steering = new Map<string, number>();
  /** The most the turn running now may do (othersCap), so a message given to it mid-turn never takes it further. */
  private turnCap: EngineMode | undefined = undefined;
  /** Where its tool's `friday` MCP calls go (agent-mesh.ts), and those still being answered, to stop when the runner says so or goes. */
  mesh: AgentMesh | null = null;
  private meshCalls = new Map<string, AbortController>();
  /** The run now going has had no turn reach the runner yet, so the next one asks it for the run's checkpoint (see drain). */
  private owesCheckpoint = false;
  /** The turn whose checkpoint the runner was asked to take and hasn't said yet (see onRunner's "checkpoint"). */
  private checkpointFor: string | null = null;
  private unsub: (() => Promise<void>) | null = null;
  private readonly actor: ActorRef;
  /** This lane's teammate note, when it is a teammate (EngineHub.teammate). */
  teammate: (() => Promise<MateNote | null>) | null = null;
  /** Whether the person paused the team this lane is in (EngineHub.teamPaused). */
  teamPaused: (() => Promise<boolean>) | null = null;
  /**
   * What this lane's tool was last told before a turn's prompt (MateNote.preamble), by part: a part goes again only when it has
   * changed, so a teammate's system note stays the same turn after turn (its tool keeps its cache) and what changes reaches it
   * once (Arun, 2026-10-28: "run an audit on the teams stuff, really iron out bugs"). Forgotten at a compaction, whose summary
   * may have dropped it.
   */
  private toldBefore = new Map<string, string>();
  private matePreamble: MateNote["preamble"] = [];
  /** The preamble parts that changed since this lane's tool was last told them, as text to lead its turn's prompt with. */
  private preambleNow(): string {
    const out: string[] = [];
    for (const p of this.matePreamble) {
      if (!p.always && this.toldBefore.get(p.key) === p.text) continue;
      this.toldBefore.set(p.key, p.text);
      if (p.text) out.push(p.text);
    }
    return out.length ? `${out.join("\n\n")}\n\n` : "";
  }
  /**
   * Whether this team lane's queue waits rather than starting a turn, when what is queued is all the agents' and Friday's: the
   * person paused the team, or its tool is out of usage until its limit lifts (a message then woke it only to fail at once). The
   * app's re-pump starts it once that is over (Arun, 2026-10-28: "we need to ensure teams can work basically while you are away").
   */
  private async teamWaits(events: SessionEvent[], pending: number[]): Promise<boolean> {
    if (pending.some((q) => events.find((e) => e.seq === q)?.actor.kind === "human")) return false;
    if (await this.teamPaused?.().catch(() => false)) return true;
    // Out of usage until a time it said: waits for it. One that said no time is tried (its resume comes in an hour), and a tool
    // started on the lane since (its backup, or its own once the limit lifted) isn't the one that ran out.
    const end = events.findLast((e) => (e.lane ?? MAIN_LANE) === this.lane && e.body.type === "run.ended");
    if (end?.body.type !== "run.ended" || end.body.outcome !== "error") return false;
    const until = limitHit(end.body.error, end.ts)?.resetsAt;
    if (!until || until <= Date.now()) return false;
    return !events.some((e) => e.seq > end.seq && (e.lane ?? MAIN_LANE) === this.lane && e.body.type === "engine.attached");
  }
  /** Open once the conversation this lane continues is in the log, or isn't coming (see the constructor). */
  private importGate: Promise<void> = Promise.resolve();
  private openGate = () => {};

  constructor(
    private sid: string,
    readonly lane: string,
    /** Seq of our engine.attached: anything attached after it means we were replaced. */
    private attachedSeq: number,
    public info: EngineInfo,
    private ws: WebSocket,
    private store: SessionStore,
    private bus: Bus,
    private onGone: () => void,
    /** The past conversation this runner was started from, of whichever tool: the one thing it may bring into the log. */
    private importFrom: { id: string; title: string; tool: EngineTool } | null = null,
    /** What the team learned on this repo before (the project brain), for this lane's first turn. */
    private briefer: ((lane: string, task: string) => Promise<string>) | null = null,
    /** What runs in the session's workspace have shown about each model (route-learning.ts). */
    private learner: ((workspaceId: string) => Promise<Learned>) | null = null,
  ) {
    this.actor = { id: `engine:${info.hostId}`, name: `${info.hostName}'s ${engineName(info.tool)}`, kind: "agent" };
    /**
     * Another tool's conversation reaches this one as history (importedNote), and the runner only sends it once it has
     * attached and read it, by which time work already queued on the lane had started without it. So the first turn waits
     * to hear: the runner answers even when it has nothing to send. Not past 15 seconds, for a runner too old to answer.
     */
    if (importFrom && info.tool && importFrom.tool !== info.tool) {
      this.importGate = new Promise((open) => {
        this.openGate = open;
        setTimeout(open, 15_000).unref?.();
      });
    }
  }

  async start(): Promise<void> {
    this.unsub = await this.bus.subscribe(this.sid, (m) => this.onBus(m));
    this.ws.on("message", (raw) => this.onRunner(raw));
    this.ws.on("close", () => void this.close("disconnected"));
    // Closed while the subscription was being made, which is before anything was listening for it.
    if (this.ws.readyState !== WebSocket.OPEN) await this.close("disconnected");
  }

  sendRaw(m: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private append(body: EventBody, guard: AppendGuard = {}) {
    return this.store.append(this.sid, this.actor, body, { ...guard, lane: this.lane });
  }

  /** The newest change set of the turn now running, shown live but not in the log yet (see onRunner). */
  private heldDiff: Extract<EventBody, { type: "agent.diff" }> | null = null;
  /** The files named by the last change set this lane logged. Empty at first, so a new runner's first one is always logged. */
  private loggedPaths = new Set<string>();

  /**
   * Keep (or let go of) the turn's newest change set, here and in Redis, where a joiner on any server reads it (heldDiffs).
   * One write per burst, which the runner already spaces out; it outlives a server that died mid-turn by minutes, not for good.
   */
  private hold(d: Extract<EventBody, { type: "agent.diff" }> | null): void {
    if (!d && !this.heldDiff) return;
    this.heldDiff = d;
    const key = this.store.keys(this.sid).heldDiff(this.lane);
    // Hidden before it is kept too: a joiner reads it from Redis straight to their socket (secrets.ts).
    const msg: BusMessage | null = d && hideSecretsIn({ kind: "diff", base: d.base, files: d.files, ...(this.lane !== MAIN_LANE ? { lane: this.lane } : {}) });
    // Same connection, so a clear always lands after the set it clears.
    void (msg ? this.store.redis.set(key, JSON.stringify(msg), "EX", HELD_DIFF_S) : this.store.redis.del(key)).catch(() => {});
    if (msg) void this.bus.publish(this.sid, msg).catch(() => {});
  }

  private logHeldDiff(): void {
    const d = this.heldDiff;
    if (!d) return;
    this.hold(null);
    this.loggedPaths = new Set(d.files.map((f) => f.path));
    void this.record(d).catch((e) => console.error("[engine] append:", e));
  }

  /** Write what the runner said; a request for a command the driver already allowed is answered in the same breath. */
  private async record(body: EventBody): Promise<void> {
    // The log keeps a lean copy of a change set; the room saw it whole, live (hold).
    if (body.type === "agent.diff") body = leanDiff(body);
    const r = await this.append(body);
    if (r.ok && body.type === "agent.usage" && this.info.tool) {
      const ws = (await this.store.state(this.sid).catch(() => null))?.workspaceId ?? "";
      void this.usage.record(ws, this.info.tool, body);
    }
    if (!r.ok || body.type !== "engine.approval" || body.scope !== "commands") return;
    const state = await this.store.state(this.sid);
    // An item cut in cleanBody ends in a line saying so, and the yes would go to the whole command, which the runner
    // keeps. That line makes it two statements, which no "anything starting with" entry matches, and an exact entry
    // (at most 4,000 characters, see core.ts) is never as long as a cut item, so what follows the cut always asks.
    if (!body.items.length || !body.items.every((i) => allowedCommand(state, i))) return;
    // The list is the owners' say-so, which isn't the host's on a machine whose host isn't an owner: that host is asked.
    if (roleOf(state, this.info.hostId) !== "owner") return;
    await this.store.append(this.sid, FRIDAY, { type: "instruction", text: "Allowed in advance: go ahead.", interrupt: false, approval: { id: body.id, approve: true } }, { lane: this.lane });
  }

  // ── session → runner ─────────────────────────────────────────────

  private onBus(m: BusMessage): void {
    if (m.kind !== "event" || this.closed) return;
    const ev = m.event;
    const b = ev.body;
    if (b.type === "lane.removed" && b.laneId === this.lane) return void this.close("lane removed", 4004);
    // Agent talk resumed (agent-mesh.ts): a message held while it was paused can go now. Said on the main lane, for every lane.
    if (b.type === "mesh.paused" && !b.on) return void this.pump();
    if ((ev.lane ?? MAIN_LANE) !== this.lane) return;
    if (b.type === "engine.detached" && b.reason === "released") return void this.close("released", 4000);
    if (b.type === "engine.attached" && ev.seq > this.attachedSeq) return void this.close("replaced", 4009);
    // Same preemption rules as Friday Code. A CLI can't take new input
    // mid-turn, so an interrupt stops the turn and the next one carries it.
    let why = "";
    if (b.type === "run.pause") why = `${ev.actor.name} stopped this task`;
    else if (b.type === "lane.terminal" && b.open) why = `${ev.actor.name} opened this agent in their terminal`;
    else if (b.type === "run.cancel") why = `${ev.actor.name} cancelled the run`;
    else if (b.type === "run.interrupt") why = `${ev.actor.name} delivered queued instructions now`;
    else if (b.type === "instruction" && b.interrupt) why = `${ev.actor.name} interrupted with a new instruction`;
    if (why && this.turn) (this.stopSent = true), this.sendRaw({ kind: "stop", reason: why });
    // An answer to something the tool is waiting on right now goes to it there and then, and is not a new turn.
    if (b.type === "instruction" && b.approval && this.live.delete(b.approval.id)) return void this.answerLive(ev.seq, b.approval);
    if (b.type === "instruction" && b.approval && this.answered.has(b.approval.id)) {
      void this.append({ type: "instructions.delivered", seqs: [ev.seq] }).catch((e) => console.error("[engine] delivered:", e));
      return;
    }
    // A message for this agent while its turn runs, given to it at its next step rather than after the turn: another agent's
    // question waited minutes for the asker's answer otherwise, and askers gave up waiting on nearly half of them.
    if (b.type === "instruction" && this.turn && this.steers && steerable(b)) return void this.steer(ev).catch((e) => console.error("[engine] steer:", e));
    if (b.type === "instruction" || b.type === "run.resume" || b.type === "instructions.requeued" || (b.type === "lane.terminal" && !b.open)) void this.pump();
  }

  /**
   * Hand a message to the turn running now (the runner's Parser.steer). Marked delivered first, so the turn after this one
   * doesn't take it too; put back at the front of the queue when the tool couldn't take it (a tool that has no way, its turn
   * just ended), so it goes with the next turn as before. Never further than the turn may go: a message from somebody whose
   * messages the host holds to Edits waits for a turn of its own when this one isn't held to that already.
   */
  private async steer(ev: SessionEvent): Promise<void> {
    const state = await this.store.state(this.sid);
    if (!this.turn || !pendingFor(state, this.lane).includes(ev.seq)) return void this.pump();
    // Somebody else's work never reaches a tool on its host's own plan mid-turn either: the queue says no to it (drain).
    if (ownPlan(state.engines[this.lane]) && refusal(state.engines[this.lane], whoseWork(await this.store.events(this.sid), ev))) return void this.pump();
    const capped = this.turnCap !== undefined;
    if (!capped && this.othersMessage(ev) && othersCap(this.info.handMode, state.othersFull?.[this.lane] !== false) !== undefined) return void this.pump();
    const events = await this.store.events(this.sid);
    // On hold, finishing the turn it was told to stop: another agent's message waits for the person, as in drain (held.ts).
    if (!runnableQueue(events, this.lane, [ev.seq]).length) return void this.pump();
    const { prompt } = promptFor(events, [ev.seq], [], "");
    if (!(await this.append({ type: "instructions.delivered", seqs: [ev.seq] })).ok) return void this.pump();
    const id = randomUUID().slice(0, 8);
    this.steering.set(id, ev.seq);
    this.sendRaw({ kind: "steer", id, text: withShieldNote(prompt) });
    // A runner that never says: as if it couldn't, once it has had time to.
    setTimeout(() => void this.steered(id, false), STEER_ANSWER_MS).unref?.();
  }

  /** The runner's word on a message handed to its turn: taken, or back in the queue for the next turn. */
  private async steered(id: string, ok: boolean): Promise<void> {
    const seq = this.steering.get(id);
    if (seq === undefined) return;
    this.steering.delete(id);
    if (ok) return;
    await this.append({ type: "instructions.requeued", seqs: [seq] }).catch((e) => console.error("[engine] requeue:", e));
    void this.pump();
  }

  /** Whether a message is anyone's but the host's own (othersIn in drain, for one message). */
  private othersMessage(e: SessionEvent): boolean {
    if (e.body.type !== "instruction") return true;
    if (e.body.handoff || e.body.peer || e.body.via) return true;
    if (e.body.mesh) return e.body.mesh.by?.id !== this.info.hostId;
    return e.actor.id !== this.info.hostId;
  }

  private async answerLive(seq: number, a: { id: string; approve: boolean }): Promise<void> {
    this.answered.add(a.id);
    // Delivered before the tool hears it: the turn can end the moment it does, and the queue would then take the answer for
    // an instruction and start another turn with it.
    await this.append({ type: "instructions.delivered", seqs: [seq] }).catch((e) => console.error("[engine] delivered:", e));
    this.sendRaw({ kind: "approval", id: a.id, approve: a.approve });
  }

  /** Work through the lane's queue, one CLI turn at a time. */
  async pump(): Promise<void> {
    if (this.busy) {
      this.rerun = true;
      return;
    }
    this.busy = true;
    try {
      do {
        this.rerun = false;
        await this.drain();
      } while (this.rerun && !this.closed);
    } catch (err) {
      console.error(`[engine] ${this.sid}/${this.lane}:`, err);
    } finally {
      this.busy = false;
    }
  }

  private async drain(): Promise<void> {
    for (let i = 0; i < 100 && !this.closed; i++) {
      await this.importGate;
      if (this.closed) return;
      // Asked together, in this order on the one connection: the state's length check reaches Redis before the events', so
      // the events hold every instruction the state says is pending (and they are the cache's own array, which only grows).
      const [{ epoch }, cached, events] = await Promise.all([this.store.control(this.sid, this.lane), this.store.state(this.sid), this.store.events(this.sid)]);
      // A copy of the cached state, not a fold of the whole log: the turn holds it across awaits, and the cache's own moves on.
      const state = structuredClone(cached);
      const mine = state.engines[this.lane];
      if (!mine || mine.hostId !== this.info.hostId) return;
      // A folder lent with no CLI has nothing to hand a turn to: this link is
      // a bridge for reads, edits and commands, and Friday's own agent is the
      // one taking instructions on the lane.
      if (!this.info.tool) return;
      const run = runOf(state, this.lane);
      if (run.status === "paused") return;
      // Open in its host's terminal (lane.terminal): the conversation is theirs there, and two writers would split it. What is
      // queued waits, and runs once it is back.
      if (state.terminals?.[this.lane]) return;
      // On hold as a person said (held.ts): the other agents' messages and Friday's wait in the queue for the next turn a person
      // starts, and never start one themselves.
      const pending = runnableQueue(events, this.lane, pendingFor(state, this.lane));
      const guard: AppendGuard = { expectEpoch: epoch };
      // A team's queue held by the person's pause, or for a tool out of usage: it waits, and the app's re-pump starts it after.
      // No hourly budget: agents bouncing the same thing back and forth are stopped where they message (agent-mesh loopBetween).
      if (pending.length && run.status !== "running" && state.options.team && (await this.teamWaits(events, pending))) return;
      // On its host's own plan, it takes its host's work alone (own-plan.ts), whoever or whatever queued it: a teammate, another
      // agent working for one, a hand-off, the board. Anything else leaves the queue unrun, with why, before a turn starts.
      if (ownPlan(mine) && pending.length) {
        const theirs = pending.flatMap((seq) => {
          const e = events.find((x) => x.seq === seq);
          const who = e ? whoseWork(events, e) : null;
          const why = refusal(mine, who, who ? state.members[who]?.name : undefined);
          return why ? [{ type: "instruction.refused" as const, seq, why }] : [];
        });
        if (theirs.length) {
          await this.store.appendAll(this.sid, FRIDAY, theirs, { ...guard, lane: this.lane });
          continue;
        }
      }
      if (!pending.length) {
        if (run.status !== "running") return;
        // Its turn ended short of its task (its plan still open, a "next I'll…" left hanging, a board task unfinished): told to
        // carry on, as Friday Code is, and the run goes on with that as its next turn (keep-going.ts).
        const more = keepGoingNote(state, events, this.lane);
        if (more && (await this.store.append(this.sid, FRIDAY, { type: "instruction", text: more, interrupt: false, keepGoing: true }, { ...guard, lane: this.lane })).ok) continue;
        await this.append({ type: "run.ended", outcome: "done", ...(await this.endCheckpoint()) }, guard);
        return;
      }
      // A run starting takes a checkpoint before the CLI touches anything, so it can be undone. A runner that takes it itself
      // does so as it hands its tool the turn, beside its own setup, and says it then (onRunner): nothing is waited on here.
      if (run.status !== "running") {
        // Anyone else's is asked for now. A machine in plan mode or a folder outside git answers with a sentence, not an
        // id, and that run simply has no undo.
        const sha = this.selfCheckpoint ? "" : (await this.readRepo({ op: "checkpoint", query: "run" })).trim();
        // The machine may have gone while it was asked (a lid shut): nothing is started or marked delivered on a link that is
        // gone, so the message waits for it to come back, as the room was told it would. And what is queued is read again:
        // a message taken back or edited meanwhile is not the one to run.
        if (this.closed) return;
        if (!this.selfCheckpoint && pendingFor(await this.store.state(this.sid), this.lane).join() !== pending.join()) continue;
        const checkpoint = /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
        // The start and what it delivers in one write, in that order: both under the epoch guard, or neither.
        const start: EventBody[] = [{ type: "run.started", causedBy: pending[0]!, ...(checkpoint ? { checkpoint } : {}) }, { type: "instructions.delivered", seqs: pending }];
        if (!(await this.store.appendAll(this.sid, this.actor, start, { ...guard, lane: this.lane })).ok) continue;
        // Owed until a turn of this run reaches the runner.
        this.owesCheckpoint = this.selfCheckpoint;
      } else {
        // A runner that takes its own checkpoint may have dropped while taking it: the turn was requeued and the run left going
        // with no checkpoint, and the runner never hands its tool a turn on a link that is gone. Asked again then, so the run
        // keeps its undo; never once a turn of this run went through, since a checkpoint after its edits would undo nothing.
        if (this.selfCheckpoint) this.owesCheckpoint = neverRan(events, this.lane);
        if (!(await this.append({ type: "instructions.delivered", seqs: pending }, guard)).ok) continue;
      }

      const updates = unreadPosts(state, this.lane);
      const turn = promptFor(events, pending, updates, leadBrief(state, this.lane), [backNote(state, events, this.lane), newNotes(events, this.lane)].filter(Boolean).join("\n\n"));
      if (updates.length) void this.append({ type: "mesh.read", upTo: updates.at(-1)!.seq }).catch((e) => console.error("[engine] read:", e));
      const { attachments } = turn;
      // One of the tool's own commands ("/compact", "/prompts:review"), sent alone: offered to the runner as typed too, since
      // anything in front of it (whose message it is, what the session missed) makes it plain text. The runner uses it only
      // when its tool has that command; anything else goes as the message it reads as.
      const only = pending.length === 1 ? events.find((e) => e.seq === pending[0]) : undefined;
      // One that changes what the tool can reach goes as a command only from the host (core refuses it from anyone else first).
      const command =
        only?.body.type === "instruction" && !only.body.handoff && !only.body.peer && !only.body.mesh && /^\/[\w:.-]+(\s|$)/.test(only.body.text.trim()) && (only.actor.id === this.info.hostId || !accessCommand(only.body.text))
          ? only.body.text.trim()
          : undefined;
      /**
       * A coding CLI is handed only the new instruction, so one that has just
       * joined — a teammate's Claude from another laptop, or one taking over a
       * lane — would start blind in the middle of the team's work. It is told
       * where the session stands once, on its first turn, and never again:
       * after that its own memory has it, and repeating the session to it every
       * turn would be noise in a window it needs for the work.
       */
      const first = needsCatchUp(events, this.lane, this.info.hostId);
      const catchUp = first ? buildCatchUp(state, events, pending, this.lane) : "";
      // Its first turn here also carries what the team learned on this repo before, from any agent: it starts briefed, not cold.
      // Asked now and waited on with the model and the note below: none of the three needs another's answer.
      const briefing = first && this.briefer ? this.briefer(this.lane, turn.prompt).catch(() => "") : "";
      void this.noteCarried(state, events, pending, catchUp, turn.prompt).catch((e) => console.error("[engine] carried:", e));
      // The driver's answer to a request for permission goes to the runner as a fact, not only as words in the prompt.
      const answered = pending.map((q) => events.find((e) => e.seq === q)?.body).findLast((b) => b?.type === "instruction" && b.approval);
      const approval = answered && answered.type === "instruction" ? answered.approval : undefined;
      // With what was asked, from the log: the runner that asked may have reconnected since, and a new one has no memory
      // of it. Only this engine's own ask, on this lane and with this tool: a yes to Friday Code or to another tool stays words.
      const ask = approval
        ? events.findLast((e) => e.body.type === "engine.approval" && e.body.id === approval.id && (e.lane ?? MAIN_LANE) === this.lane && e.actor.id === this.actor.id && e.body.tool === this.info.tool)
        : undefined;
      const asked = ask?.body.type === "engine.approval" ? { scope: ask.body.scope, items: ask.body.items } : {};
      // An Auto lane runs each message on the model picked for it; any other only logs what Auto would have picked.
      const routing = this.info.model === "auto" ? this.autoRoute(turn.prompt, attachments?.length ?? 0, state, events) : (this.shadowRoute(turn.prompt, attachments?.length ?? 0, state, events), undefined);
      const building = performance.now();
      const [brief, routed, note] = await Promise.all([briefing, routing, this.systemNote(events)]);
      slowly(`a turn's brief for ${this.sid}`, building, { events: events.length });
      // The shield hides typed keys from the agent too: told once, wherever in what it gets (a catch-up included) one is.
      let prompt = withShieldNote(`${brief}${catchUp}${turn.prompt}`);
      const model = routed?.model;
      // The lane's pinned effort, as the log stood when this turn was built: a change made while it runs waits for the next.
      const effort = laneEffort(state, this.lane, this.info.tool, routed?.effort);
      /**
       * A mode chosen automatically from the host's message is for the host's own turn. A turn carrying anyone else's
       * instruction (a teammate driving, a hand-off, another agent, Friday) runs no further than the mode the host picked by
       * hand: the runner holds it to the lower of the two. A runner older than this ignores it and runs in its own mode.
       * The host's yes to an ask carries on the turn that asked: one yes to one command in a
       * teammate's capped turn must not let the rest of their work run in the automatic mode.
       */
      const othersIn = (seqs: number[], depth = 0): boolean =>
        seqs.some((q) => {
          const e = events.find((x) => x.seq === q);
          if (e?.body.type !== "instruction") return false;
          // Friday's carry-on is the run's own work going on: whose it is is whoever gave the run its task.
          if (e.body.keepGoing) {
            if (depth > 8) return false;
            const before = events.filter((x) => x.seq > run.sinceSeq && x.seq < q && x.body.type === "instructions.delivered" && (x.lane ?? MAIN_LANE) === this.lane);
            return othersIn(before.flatMap((x) => (x.body.type === "instructions.delivered" ? x.body.seqs : [])), depth + 1);
          }
          if (e.body.handoff || e.body.peer || e.body.via) return true;
          // Another agent here, on a run the host themself started (the lead handing out the host's job, an agent answering
          // the host's agent): the host's own request, passed along, so it runs in the mode the host picked. Auto asked for
          // every command a lead's task brought, on the host's own agents (Arun, 2026-10-23: "why auto mode is asking me for
          // approval"). A run a teammate started, or nobody, is still somebody else's (mesh.by is the person behind it).
          if (e.body.mesh) return e.body.mesh.by?.id !== this.info.hostId;
          if (e.actor.id !== this.info.hostId) return true;
          if (!e.body.approval || depth > 8) return false;
          const id = e.body.approval.id;
          const ask = events.findLast((x) => x.body.type === "engine.approval" && x.body.id === id && (x.lane ?? MAIN_LANE) === this.lane);
          const asked = ask && events.findLast((x) => x.seq < ask.seq && x.body.type === "instructions.delivered" && (x.lane ?? MAIN_LANE) === this.lane);
          return asked?.body.type === "instructions.delivered" && othersIn(asked.body.seqs, depth + 1);
        });
      const others = othersIn(pending);
      // Paused or stopped while the turn was being put together (its brief, its model, the note): the tool isn't started on it.
      // A Stop pressed then used to be lost, and the tool did the whole task while the room read "cancelled".
      const now = runOf(await this.store.state(this.sid), this.lane).status;
      // A Stop (the agent left idle) drops the turn with its task; whatever was queued meanwhile is the next turn.
      if (this.closed || now !== "running") continue;
      const cap = others ? othersCap(this.info.handMode, state.othersFull?.[this.lane] !== false) : undefined;
      // A conversation grown long is compacted first, by the tool's own /compact, as a turn of its own: the turn that follows,
      // and every one after, re-reads a summary instead of everything so far. Not before one of the tool's own commands, which
      // may be /compact itself. One that fails is not tried again on this connection; the turn goes ahead either way.
      const long = !command && !this.compactFailed ? shouldCompact(events, this.lane, this.info.tool) : null;
      if (long) {
        this.inFlight = pending;
        await this.append({ type: "context.compacted", tool: this.info.tool!, ...long }).catch((e) => console.error("[engine] compact:", e));
        this.toldBefore.clear();
        const c = await this.runTurn("/compact", [], note, undefined, "/compact", model, undefined, cap, false);
        this.inFlight = null;
        if (this.closed || (c.outcome === "error" && this.requeued)) return;
        if (c.outcome === "error") {
          this.compactFailed = true;
          console.log(`[engine] ${this.actor.name} couldn't compact (${c.error ?? "no reason"}); going on without`);
        }
        // Stopped meanwhile: the log says what's next, as after any turn.
        if (c.outcome === "stopped" || runOf(await this.store.state(this.sid), this.lane).status !== "running") continue;
      }
      // A teammate's preamble, after any compaction (which forgets what it was told): what changed since its last turn.
      if (state.options.team && !command) prompt = withShieldNote(`${brief}${catchUp}${this.preambleNow()}${turn.prompt}`);
      this.inFlight = pending;
      this.turnCap = cap;
      // Every instruction of it handed back after a dropped connection: the turn its runner may still have running, to take on
      // where it got to rather than start again (runner adopt).
      const again = pending.every((q) => events.some((e) => e.body.type === "instructions.requeued" && e.body.seqs.includes(q)));
      let end = await this.runTurn(prompt, [...(attachments ?? [])], note, approval && { ...approval, ...asked }, command, model, effort, cap, this.owesCheckpoint, again);
      // A coding tool that lost its earlier conversation (a resume that failed) starts a fresh one at once and does the same turn
      // there, told where the session stands, rather than stopping until a person writes again: the runner has already dropped
      // the dead id (Arun, 2026-10-29: "Agent stopped: Codex couldn't find its earlier conversation, so the next instruction
      // starts a fresh one."; "Yes, everywhere"). Once: a second failure stops as any other error does. Its note is made again: a
      // conversation brought in from elsewhere is now told in it (resume.lost), since the tool no longer has it.
      if (end.outcome === "error" && !this.requeued && !this.closed && /couldn't find its earlier conversation/.test(end.error ?? "") && runOf(await this.store.state(this.sid), this.lane).status === "running") {
        console.log(`[engine] ${this.actor.name} lost its conversation; carrying the turn on in a fresh one`);
        const fresh = buildCatchUp(state, events, pending, this.lane);
        const told = await this.systemNote(await this.store.events(this.sid));
        end = await this.runTurn(withShieldNote(`${fresh}${prompt}`), [...(attachments ?? [])], told, approval && { ...approval, ...asked }, command, model, effort, cap, this.owesCheckpoint, false);
      }
      this.inFlight = null;
      if (end.outcome === "error" && this.requeued) return;
      if (end.outcome === "error") {
        // No checkpoint here: a run that failed has often lost its machine, and its undo can put back everything as before.
        await this.append({ type: "run.ended", outcome: "error", error: (end.error ?? "The coding agent failed.").slice(0, 2000) });
        return;
      }
      // "stopped" and "done" both go round again: the log says what's next —
      // paused, cancelled, or a newer instruction to deliver.
    }
  }

  /** Where the run left the folder, so its undo puts back only the files it changed (and not what the person did since). */
  private async endCheckpoint(): Promise<{ after?: string }> {
    // Not waited on for long: a machine that went away mid-run shouldn't hold the run's end, which only loses a narrower undo.
    const took = this.readRepo({ op: "checkpoint", query: "run end" }).then((s) => s.trim(), () => "");
    const sha = await Promise.race([took, new Promise<string>((r) => setTimeout(() => r(""), 8000).unref?.())]);
    return /^[0-9a-f]{40}$/.test(sha) ? { after: sha } : {};
  }

  /**
   * This agent was handed what others already did instead of starting from nothing: say how much, for "tokens saved". A
   * hand-off carries the work of the run it came from; a catch-up, everything the other agents did before this one joined.
   * Only work that was counted (Friday's steps, a tool's turns since it reported usage), and only when there was some.
   */
  private async noteCarried(state: SessionState, events: SessionEvent[], pending: number[], catchUp: string, prompt: string): Promise<void> {
    const first = Math.min(...pending);
    const handoff = pending.map((q) => events.find((e) => e.seq === q)).find((e) => e?.body.type === "instruction" && e.body.handoff);
    const h = handoff?.body.type === "instruction" ? handoff.body.handoff : undefined;
    let kind: "handoff" | "catchup";
    let work: { tokens: number; by: string[] };
    if (h) {
      kind = "handoff";
      const from = lastRunStart(events, h.fromLane, handoff!.seq);
      work = spentBefore(events, handoff!.seq, (e) => e.seq > from && (e.lane ?? MAIN_LANE) === h.fromLane);
    } else if (catchUp) {
      kind = "catchup";
      // Everything counted before it: a catch-up goes only to an agent that hasn't been in this lane (needsCatchUp), so none of
      // it is its own. (By actor it can't be told: one person's agents share an id across lanes.)
      work = spentBefore(events, first, () => true);
    } else return;
    if (!work.tokens) return;
    const sent = tokensIn(kind === "handoff" ? prompt : catchUp);
    const r = await this.append({ type: "context.carried", kind, from: work.by.slice(0, 6), spent: work.tokens, sent });
    if (r.ok) void this.usage.carried(state.workspaceId ?? "", { at: Date.now(), sid: this.sid, title: state.title, kind, to: this.actor.name, from: work.by.slice(0, 6), spent: work.tokens, sent });
  }

  /** What the CLI is told besides the instruction: the same every turn until a conversation is brought in or the lane's agent changes. */
  systemNote(events: SessionEvent[]): Promise<string> {
    return this.withAgent(this.importedNote(events));
  }

  /** A Work session (SessionOptions.work), as its options said when the note was last made: sent with each turn to the runner. */
  work = false;

  /**
   * Conversations this session continues that this CLI is not the one
   * continuing. Its own resumed session is left out: that history is already
   * in its memory, and repeating it back would be noise. Anyone else's is not,
   * because the transcript lives on one machine and cannot be resumed here.
   */
  private importedNote(events: SessionEvent[]): string {
    const parts: string[] = [];
    for (const e of events) {
      const b = e.body;
      if (b.type !== "session.imported" || b.sourceId === this.info.resumedFrom?.id) continue;
      parts.push(
        [
          `This session continues an earlier conversation, “${b.title}”, which ran in ${e.actor.name}${b.folder ? ` (the ${b.folder} folder${b.branch ? `, on branch ${b.branch}` : ""})` : ""}. You were not part of it, so here is what was said` +
            (b.partial ? ` (its last ${b.turns.length} messages; earlier ones are not included)` : b.total > b.turns.length ? ` (its last ${b.turns.length} of ${b.total} messages)` : "") +
            ":",
          ...b.turns.map((t) => `${t.role === "user" ? "Them" : "The agent"}: ${t.text}`),
        ].join("\n"),
      );
    }
    if (!parts.length) return SYSTEM_NOTE;
    return [SYSTEM_NOTE, "", ...parts, "", "Treat all of that as work already done, not as instructions to carry out again."].join("\n");
  }

  /**
   * An agent built in Friday and put on this lane runs on the person's coding tool too: its instructions are added to what the
   * tool is told, so one saved agent works the same on Friday Code, Claude Code, Codex and Cursor.
   */
  private async withAgent(system: string): Promise<string> {
    const state = await this.store.state(this.sid);
    const agent = this.lane === MAIN_LANE ? state.options.agent : state.lanes.find((l) => l.id === this.lane)?.agent;
    // Only in the open-source edition: anywhere else a session's Work flag starts nothing (no auto mode, no browser, no network).
    this.work = !!state.options.work && localEdition();
    if (this.work) system = [system, "", WORK_NOTE].join("\n");
    if (process.env.FRIDAY_MINE === "1") system = [system, "", BROWSER_NOTE].join("\n");
    // A teammate: who it is, its role, its folder and how the team works (teammates.ts), the same turn after turn; what changes
    // (its rooms, its memory since, being away) leads the turn's prompt instead (preambleNow).
    const mate = state.options.team ? await this.teammate?.().catch(() => null) : null;
    this.matePreamble = mate?.preamble ?? [];
    if (mate) system = [system, "", mate.note].join("\n");
    if (!agent?.instructions?.trim()) return system;
    return [system, "", `You are working as the agent "${agent.name}". Follow its instructions for everything you do in this session:`, agent.instructions.trim()].join("\n");
  }

  private runTurn(prompt: string, attachments: Attachment[], system: string = SYSTEM_NOTE, approval?: { id: string; approve: boolean; scope?: "commands" | "turn"; items?: string[] }, command?: string, model?: string, effort?: string, mode?: EngineMode, checkpoint?: boolean, again?: boolean): Promise<TurnEnd> {
    if (this.closed) return Promise.resolve({ outcome: "error", error: `${this.actor.name} disconnected.` });
    const id = randomUUID().slice(0, 8);
    if (checkpoint) {
      this.owesCheckpoint = false;
      this.checkpointFor = id;
    }
    return new Promise((resolve) => {
      this.turn = { id, resolve };
      this.draft = "";
      this.stopSent = false;
      const msg: Record<string, unknown> = { kind: "turn", id, prompt, system, attachments, ...(approval ? { approval } : {}), ...(command ? { command } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(mode ? { mode } : {}), ...(checkpoint ? { checkpoint: true } : {}), ...(again ? { again: true } : {}) };
      if (this.work) msg.work = true;
      this.sendRaw(msg);
    });
  }

  // ── runner → session ─────────────────────────────────────────────

  /** The tool's limits as its runner last read them (see onRunner), and the last shadow pick said in the log. */
  private toolWindows: ToolWindow[] = [];
  private shadowed = "";
  /** Its tool's usage windows as last read, for who gets work next (agent-mesh: one nearly out comes last). */
  get windows(): ToolWindow[] {
    return this.toolWindows;
  }

  /**
   * The model Auto would run this turn on (routing.ts), logged beside the one that runs, when that changes. Nothing changes for
   * the turn: a coding tool's lane keeps the model it was started with, and these are how the rules get checked first.
   */
  /**
   * How hard this lane's work last read, for a reply that only carries it on ("yes, do it", "continue"): it is as hard as that
   * work, not as short as its words. A small model was put on a refactor's "go ahead" (Arun, 2026-10-30: "improve smart routing").
   */
  private previousTier(events: SessionEvent[]): { tier: RouteTier; why: string } | null {
    const last = events.findLast((e) => (e.lane ?? MAIN_LANE) === this.lane && e.body.type === "model.routed")?.body;
    if (last?.type !== "model.routed" || !last.tier) return null;
    return { tier: last.tier, why: (last.why.split(" · ")[0] ?? "").replace(/^(carrying on: )+/, "") || "the work under way" };
  }

  private shadowRoute(text: string, attachments: number, state: SessionState, events: SessionEvent[]): void {
    const tool = this.info.tool;
    if (!tool) return;
    const t = taskTier(text, { planFirst: state.options.planFirst, attachments, linked: !!(state.options.issue || state.options.pr), previous: this.previousTier(events) });
    const pick = routeTool(tool, t.tier, t.why, this.toolWindows);
    if (!pick || `${pick.model}|${t.tier}` === this.shadowed) return;
    this.shadowed = `${pick.model}|${t.tier}`;
    void this.append({ type: "model.routed", model: pick.model, tier: t.tier, why: pick.why, shadow: true, tool, current: this.info.model ?? "" }).catch((e) => console.error("[engine] routed:", e));
  }

  /** The model this Auto lane last ran on, which a switch is weighed against (stickyPick). */
  private autoOn: string | null = null;

  /**
   * The model an Auto lane runs this message on (Phase 3): from how hard the task reads, the tool's limits as its runner last read
   * them, what runs in this workspace have shown, and whether moving from the model it is on pays for re-reading the conversation.
   * Said in the log when it changes, with the tool's models as they were weighed. Undefined leaves the tool on its own default.
   */
  private async autoRoute(text: string, attachments: number, state: SessionState, events: SessionEvent[]): Promise<{ model: string; effort?: string } | undefined> {
    const tool = this.info.tool;
    if (!tool) return undefined;
    const t = taskTier(text, { planFirst: state.options.planFirst, attachments, linked: !!(state.options.issue || state.options.pr), previous: this.previousTier(events) });
    const learned = state.workspaceId && this.learner ? await this.learner(state.workspaceId).catch(() => ({})) : {};
    // How much the conversation holds now: what the lane's last turn read, fresh and from its cache.
    const usage = events.findLast((e) => (e.lane ?? MAIN_LANE) === this.lane && e.body.type === "agent.usage")?.body;
    // Its last call's input when the tool said it (the whole turn's adds up every call in it, which is far more).
    const contextTokens = usage?.type === "agent.usage" ? (usage.context ?? usage.input + usage.cached) : 0;
    const current = this.autoOn ?? (events.findLast((e) => (e.lane ?? MAIN_LANE) === this.lane && e.body.type === "model.routed" && !e.body.shadow)?.body as { model?: string } | undefined)?.model ?? null;
    // The repo this lane is on, for what runs on it have shown; and whether the last run here missed, which sends the next one up.
    const repo = repoKeyOf({ url: this.info.repo ?? null, github: this.info.repo && /^[\w.-]+\/[\w.-]+$/.test(this.info.repo) ? this.info.repo : null }, this.info.cwd)?.key;
    const missed = missedLast(events, this.lane, text);
    const pick = stickyPick(tool, t.tier, t.why, { windows: this.toolWindows, learned, current, contextTokens, ...(repo ? { repo } : {}), missed });
    if (!pick) return undefined;
    const said = `${pick.model}|${pick.effort ?? ""}|${t.tier}|${missed ? "missed" : ""}`;
    if (pick.model !== this.autoOn || said !== this.shadowed) {
      this.shadowed = said;
      const options = fitModels(tool, t.tier, this.toolWindows, learned, repo ? { repo } : {}).map((f) => ({ model: f.model, success: Math.round(f.success * 1000) / 1000, cost: f.cost }));
      void this.append({ type: "model.routed", model: pick.model, ...(pick.effort ? { effort: pick.effort } : {}), tier: t.tier, why: pick.why, tool, options }).catch((e) => console.error("[engine] routed:", e));
    }
    this.autoOn = pick.model;
    return { model: pick.model, ...(pick.effort ? { effort: pick.effort } : {}) };
  }

  private onRunner(raw: WebSocket.RawData): void {
    let m: {
      kind?: string;
      tool?: unknown;
      args?: unknown;
      body?: unknown;
      text?: unknown;
      channel?: unknown;
      id?: unknown;
      outcome?: unknown;
      error?: unknown;
      sourceId?: unknown;
      title?: unknown;
      turns?: unknown;
      total?: unknown;
      partial?: unknown;
      output?: unknown;
      branch?: unknown;
      from?: unknown;
      windows?: unknown;
      sha?: unknown;
    };
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    // The tool's limits as its runner just read them, for routing (routing.ts). Kept here only: they are the machine's, not the log's.
    if (m.kind === "limits" && Array.isArray(m.windows)) {
      this.toolWindows = (m.windows as Record<string, unknown>[]).slice(0, 12).flatMap((w): ToolWindow[] =>
        w && typeof w.kind === "string" ? [{ kind: w.kind.slice(0, 40), ...(typeof w.label === "string" ? { label: w.label.slice(0, 60) } : {}), usedPercent: typeof w.usedPercent === "number" && Number.isFinite(w.usedPercent) ? w.usedPercent : null, resetsAt: typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt) ? w.resetsAt : null }] : [],
      );
      return;
    }
    // Arrives once, just after attaching, and so has no turn in flight.
    if (m.kind === "imported") return void this.onImported(m).catch((e) => console.error("[engine] imported:", e)).finally(() => this.openGate());
    // The CLI couldn't find the conversation it was continuing and starts a fresh one: from here on it has to be told that
    // conversation the way any other lane is, or it carries on with no history at all.
    if (m.kind === "resume.lost") return void (this.info = { ...this.info, resumedFrom: undefined });
    // The runner moved its folder onto the session's branch after attaching (it attached on the branch it was on). Recorded as
    // any switch is, so the lane, the header and the review card name the branch the work is really on.
    if (m.kind === "switched" && typeof m.branch === "string" && /^[^\x00-\x1f]{1,100}$/.test(m.branch)) {
      this.info = { ...this.info, branch: m.branch };
      return void this.append({ type: "folder.switched", branch: m.branch, from: typeof m.from === "string" ? m.from.slice(0, 100) : "" }).catch((e) => console.error("[engine] switched:", e));
    }
    // The run's checkpoint, which the runner took just before its tool heard the turn and says before anything that tool did.
    // Logged on the same connection's order, so it lands after the run's start and ahead of the turn's first event and its end.
    if (m.kind === "checkpoint") {
      if (typeof m.id !== "string" || m.id !== this.checkpointFor) return;
      this.checkpointFor = null;
      if (typeof m.sha === "string" && /^[0-9a-f]{40}$/.test(m.sha)) void this.record({ type: "run.checkpoint", checkpoint: m.sha }).catch((e) => console.error("[engine] checkpoint:", e));
      return;
    }
    // Its tool calling the `friday` MCP server (runner/friday-mcp.ts): answered here, as this lane, whenever it comes.
    if (m.kind === "mesh.call" && typeof m.id === "string") return void this.meshCall(m.id, m.tool, m.args);
    if (m.kind === "mesh.cancel" && typeof m.id === "string") return void this.meshCalls.get(m.id)?.abort();
    if (m.kind === "repo.result" && typeof m.id === "string") {
      const waiting = this.reads.get(m.id);
      this.reads.delete(m.id);
      waiting?.(typeof m.output === "string" ? m.output : "");
      return;
    }
    if (m.kind === "delta" && this.turn && typeof m.text === "string") {
      if (m.channel !== "reasoning") this.draft = (this.draft + m.text).slice(-MAX_TEXT);
      void this.bus.publish(this.sid, { kind: "delta", text: m.text.slice(0, MAX_DELTA), channel: m.channel === "reasoning" ? "reasoning" : "text", ...(this.lane !== MAIN_LANE ? { lane: this.lane } : {}) }).catch(() => {});
    } else if (m.kind === "event" && (this.turn || !this.info.tool || (m.body as { type?: unknown } | undefined)?.type === "agent.diff")) {
      const body = cleanBody(m.body);
      if (body?.type === "agent.message") {
        // Its draft said whole, as a tool says each block once it is written; after a stop, words that aren't that draft come
        // after it, and the draft stays, said as cut short, ahead of them.
        const cut = this.stopSent && this.turn ? this.draft.trim() : "";
        this.draft = "";
        if (cut && !body.text.includes(cut)) void this.record({ type: "agent.message", text: cut, toolCalls: [], interrupted: true }).catch((e) => console.error("[engine] draft:", e));
      }
      if ((body?.type === "engine.approval" || body?.type === "agent.usage" || body?.type === "effort.skipped" || body?.type === "account.switched") && this.info.tool) body.tool = this.info.tool;
      // The lane runs as that account from here: a reconnect says so again, and until then this is what attaches say.
      if (body?.type === "account.switched") this.info = { ...this.info, account: body.to };
      if (body?.type === "engine.approval" && body.live && this.turn) this.live.add(body.id);
      // A runner sends the whole change set every second or so while its tool edits, and only the last one of a turn is
      // ever read again. Mid-turn it goes to the room live and is kept here, then logged once as the turn ends. One that
      // names a file the log doesn't have for this lane yet is logged at once, so other lanes hear of the file now.
      if (body?.type === "agent.diff" && this.turn && body.files.every((f) => this.loggedPaths.has(f.path))) return this.hold(body);
      if (body?.type === "agent.diff") {
        this.hold(null);
        this.loggedPaths = new Set(body.files.map((f) => f.path));
      }
      // Outside a turn only a diff is accepted: a lent folder has no turns of
      // its own, and an undo happens between turns, but either way the files
      // panel has to show what is in the folder now.
      if (body && (this.turn || body.type === "agent.diff")) void this.record(body).catch((e) => console.error("[engine] append:", e));
    } else if (m.kind === "steer.result" && typeof m.id === "string") {
      void this.steered(m.id, (m as { ok?: unknown }).ok === true);
    } else if (m.kind === "turn.end" && this.turn && m.id === this.turn.id) {
      const t = this.turn;
      this.turn = null;
      // Before the run's end, which follows from this: the run's last change set is in the log ahead of it.
      this.logHeldDiff();
      // Nothing waits on them now: a yes that comes later starts a turn with permission, as for any other ask.
      this.live.clear();
      const outcome = m.outcome === "stopped" || m.outcome === "error" ? m.outcome : "done";
      const end = { outcome, ...(typeof m.error === "string" ? { error: m.error } : {}) } as TurnEnd;
      // Stopped partway through its answer: what it had written stays, said as cut short, ahead of anything the next turn says.
      // Or ended by an error partway through it (an API that gave up mid-answer, a limit hit while writing): a tool says a block
      // whole only once it is written, so what was streamed of it would otherwise go (Arun, 2026-10-28: "iron everything").
      const draft = outcome === "stopped" || outcome === "error" ? this.draft.trim() : "";
      this.draft = "";
      if (!draft) return t.resolve(end);
      void this.record({ type: "agent.message", text: draft, toolCalls: [], interrupted: true })
        .catch((e) => console.error("[engine] draft:", e))
        .finally(() => t.resolve(end));
    }
  }

  /**
   * One call from this lane's tool to its `friday` MCP server: list the tools, or run one as this lane. Its answer goes back on
   * the same socket; an ask can take minutes, and is stopped when the runner says the tool gave up or the runner goes.
   */
  private async meshCall(id: string, tool: unknown, args: unknown): Promise<void> {
    const mesh = this.mesh;
    if (!mesh) return this.sendRaw({ kind: "mesh.result", id, output: "Agents can't reach each other from here.", isError: true });
    // A runner that can take preview_screenshot's picture says so as it lists them (runner/screenshot.ts).
    // A crew's room's tools have the roster tool too (agent-mesh.ts listingFor).
    if (tool === "__list") return this.sendRaw({ kind: "mesh.result", id, ...(await mesh.listingFor(this.sid, !!args && typeof args === "object" && (args as { screenshot?: unknown }).screenshot === true)) });
    if (tool === "__list") return this.sendRaw({ kind: "mesh.result", id, ...meshListing(!!args && typeof args === "object" && (args as { screenshot?: unknown }).screenshot === true) });
    const stop = new AbortController();
    this.meshCalls.set(id, stop);
    try {
      const a = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
      const r = await mesh.call(this.sid, this.lane, typeof tool === "string" ? tool.slice(0, 80) : "", a, stop.signal);
      const result: Record<string, unknown> = { kind: "mesh.result", id, output: r.output, ...(r.isError ? { isError: true } : {}), ...(r.capture ? { capture: r.capture } : {}) };
      if (r.content) result.content = r.content;
      this.sendRaw(result);
    } finally {
      this.meshCalls.delete(id);
    }
  }

  /**
   * The conversation an imported session already had.
   *
   * Only from the host who resumed it, only for the id they actually resumed,
   * and only once: a runner that reconnects would otherwise append the same
   * history again on every attach.
   */
  private async onImported(m: { sourceId?: unknown; title?: unknown; turns?: unknown; total?: unknown; partial?: unknown; cwd?: unknown; branch?: unknown }): Promise<void> {
    const sourceId = String(m.sourceId ?? "").slice(0, 100);
    // Only the conversation this runner was started from, and only once. It may be from another tool than this lane's own, and a folder
    // lent to Friday Code can bring one too: what matters is that the host chose it, not which agent reads it.
    const origin = this.importFrom;
    if (!sourceId || !origin || sourceId !== origin.id) return;
    const turns = (Array.isArray(m.turns) ? m.turns : [])
      .map((t) => t as { role?: unknown; text?: unknown })
      .filter((t) => (t.role === "user" || t.role === "assistant") && typeof t.text === "string" && t.text.trim())
      .slice(-MAX_IMPORT_TURNS)
      .map((t) => ({ role: t.role as "user" | "assistant", text: String(t.text).slice(0, MAX_TEXT) }));
    if (!turns.length) return;

    const events = await this.store.events(this.sid);
    if (events.some((e) => e.body.type === "session.imported" && e.body.sourceId === sourceId)) return;
    await this.append({
      type: "session.imported",
      tool: origin.tool,
      sourceId,
      title: String(m.title ?? origin.title).slice(0, 120),
      // Only the folder's name, never its path on somebody's machine, and the branch it was on.
      ...(typeof m.cwd === "string" && m.cwd ? { folder: (m.cwd.split(/[\\/]/).filter(Boolean).pop() ?? "").slice(0, 80) } : {}),
      ...(typeof m.branch === "string" && m.branch ? { branch: m.branch.slice(0, 100) } : {}),
      turns,
      total: Math.max(turns.length, Math.min(100_000, Number(m.total) || 0)),
      ...(m.partial === true ? { partial: true } : {}),
    });
  }

  /**
   * Ask this runner to read something in its folder.
   *
   * Bounded by a timeout rather than left hanging: the caller is a tool call
   * inside somebody's turn, and a runner that went away mid-question would
   * otherwise stall the whole run.
   */
  readRepo(req: RepoCall): Promise<string> {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return Promise.resolve(`${this.info.hostName}'s machine isn't connected right now.`);
    const id = randomUUID().slice(0, 8);
    return new Promise((resolve) => {
      const done = (out: string) => {
        clearTimeout(timer);
        resolve(out);
      };
      const timer = setTimeout(() => {
        this.reads.delete(id);
        done(`${this.info.hostName}'s machine didn't answer in time.`);
      }, readTimeoutFor(req.op, req.timeoutSec));
      this.reads.set(id, done);
      this.sendRaw({ kind: "repo", id, ...req });
    });
  }

  /** What this lane is working on, for a tool to say where it looked. */
  get where() {
    return { host: this.info.hostName, cwd: this.info.cwd, branch: this.info.branch, tool: this.info.tool };
  }

  private left!: () => void;
  /** Settles once this runner's leaving is written down, whoever closed it first. */
  readonly gone = new Promise<void>((r) => (this.left = r));

  async close(reason: string, code = 1000): Promise<void> {
    // Closing already: wait for that one, so a shutdown doesn't take a close still writing for one that is done.
    if (this.closed) return this.gone;
    this.closed = true;
    // Its tool is gone with it: an ask it was waiting on stops waiting, and the answer reaches the lane as a message instead.
    for (const c of this.meshCalls.values()) c.abort();
    try {
      await this.leave(reason, code);
    } finally {
      this.left();
    }
  }

  private async leave(reason: string, code: number): Promise<void> {
    this.onGone();
    // Reads waiting on this machine are answered now, not after their timeout: a turn waiting on one (its checkpoint) stops
    // here instead of a minute later, when it would have started a run on a machine that is gone.
    for (const done of this.reads.values()) done(`${this.info.hostName}'s machine isn't connected right now.`);
    this.reads.clear();
    // What the turn changed before the machine went is still in its folder.
    this.logHeldDiff();
    console.log(`[engine] ${this.info.hostName}'s ${this.info.tool ?? "folder"} left ${this.sid}/${this.lane}: ${reason}${this.turn ? ", mid-turn" : ""}`);
    /**
     * A turn the machine dropped (its connection, a server restart, the same machine reconnecting over it) didn't finish, and
     * what it was working on was already marked delivered, so it used to be lost with the turn. It goes back to the front of
     * the queue instead, and the tool picks it up again when it is back. Its run is left going rather than ended with an
     * error: back within the grace below, the same run carries on; not back by then, it is ended there, saying why.
     */
    const cut = this.turn && DROPPED.has(reason) ? this.inFlight : null;
    if (cut?.length) {
      await this.append({ type: "instructions.requeued", seqs: cut }).catch((e) => console.error("[engine] requeue:", e));
      this.requeued = reason !== "shutdown";
    }
    this.turn?.resolve({ outcome: "error", error: reason === "shutdown" ? `The server restarted in the middle of ${this.actor.name}'s turn. It picks this up again when it reconnects.` : `${this.actor.name} disconnected in the middle of a turn.` });
    this.turn = null;
    await this.unsub?.().catch(() => {});
    if (reason === "released") this.sendRaw({ kind: "released" });
    if (this.ws.readyState === WebSocket.OPEN) closeSaying(this.ws, code, reason);
    // A server shutting down (a deploy) is not shown as the lane going offline: its runner is back on the new server in seconds,
    // and one that isn't is marked offline once this server's lease has run out (reap). Showing every lane offline on every
    // deploy, and ending its run, is what made the tools look as if they dropped at random.
    if (reason !== "disconnected") return;
    // A short drop (Wi-Fi changing, a laptop waking, a proxy cycling) is usually back within seconds: the lane is shown offline,
    // and its run ended, only if it hasn't come back by then. Back meanwhile, it attached again, which the sinceSeq check sees.
    const grace = offlineGraceMs();
    if (grace > 0) setTimeout(() => void this.markOffline(), grace).unref?.();
    else await this.markOffline();
  }

  /** Still reserved for this host and not back: mark it offline so work waits, visibly. */
  private async markOffline(): Promise<void> {
    try {
      const state = await this.store.state(this.sid);
      const cur = state.engines[this.lane];
      if (cur?.online && cur.hostId === this.info.hostId && cur.sinceSeq === this.attachedSeq) {
        const human: ActorRef = { id: this.info.hostId, name: this.info.hostName, kind: "human" };
        await this.store.append(this.sid, human, { type: "engine.detached", reason: "disconnected", ...(this.info.tool ? { tool: this.info.tool } : {}) }, { lane: this.lane });
        /**
         * A CLI going away ends the run it was in the middle of — it was
         * doing the work, and nothing here can finish its turn.
         *
         * A lent folder going away is not that. Friday's own agent is doing
         * the work and is still running; it has just lost the files. Ending
         * its run would be this connection killing somebody else's turn, and
         * the agent can say "the machine went offline" perfectly well itself
         * — which it now does, because its repo tools are only offered while
         * a machine is actually connected.
         */
        if (this.info.tool && runOf(state, this.lane).status === "running") {
          await this.append({ type: "run.ended", outcome: "error", error: `${this.actor.name} disconnected. It carries on from where it was when it reconnects.`, cut: true });
        }
      }
    } catch (err) {
      console.error("[engine] detach:", err);
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────

/** The instructions being delivered, as one message in the team's own words. */
/** What a side thread hangs off, in a few words for the agent: whose message, and how it began. */
function threadOn(root: SessionEvent | undefined): string {
  if (!root || (root.body.type !== "agent.message" && root.body.type !== "instruction")) return "an earlier message";
  const text = root.body.text.trim().replace(/\s+/g, " ");
  return `${root.body.type === "agent.message" ? "your" : `${root.actor.name}'s`} message "${text.length > 240 ? `${text.slice(0, 240)}…` : text}"`;
}

export function promptFor(events: SessionEvent[], seqs: number[], updates: MeshPost[] = [], lead = "", back = ""): { prompt: string; attachments: Attachment[] } {
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const attachments: Attachment[] = [];
  const parts: string[] = [];
  // Back from a usage limit, what went to other agents while it was out (limit-handoff backNote), and the team's notes saved
  // since its last turn (agent-mesh newNotes).
  if (back) parts.push(back);
  // Leading the others (lead.set): said with a person's instruction, which is what it splits up and hands out.
  if (lead && seqs.some((q) => bySeq.get(q)?.actor.kind === "human")) parts.push(lead);
  // The team's updates since this agent last read them (post_update): the open line between agents, carried with its next turn.
  if (updates.length) parts.push(`[Friday] Updates from the other agents here since you last looked:\n${updates.map((u) => `- ${u.fromName}: ${u.text}`).join("\n")}`);
  for (const seq of seqs) {
    const ev = bySeq.get(seq);
    if (!ev || ev.body.type !== "instruction") continue;
    const b = ev.body;
    const via = b.fromSuggestion !== undefined ? ` (passing on ${bySeq.get(b.fromSuggestion)?.actor.name ?? "a teammate"}'s suggestion)` : "";
    const atts = b.attachments ?? [];
    attachments.push(...atts);
    const files = atts.length ? `\n[Attached: ${atts.map((a) => a.name).join(", ")}]` : "";
    const h = b.handoff;
    // A handoff carries the first agent's whole record (handoffBrief): what it read, ran, found and changed, so the one taking
    // over builds on it instead of reading every file again to find out.
    const brief = h ? handoffBrief(events, h.fromLane, seq) : "";
    parts.push(
      h
        ? `${h.fromName} handed this to you. Why: ${h.reason}${h.carried.length ? `\nAlready established:\n${h.carried.map((c) => `- ${c}`).join("\n")}` : ""}${brief ? `\n\n[Friday] What ${h.fromName} already did, from the session's record. Treat it as done and known: don't re-read files or re-run commands to rediscover it; check something only where you are about to rely on it or change it.\n\n${brief}` : ""}\n\nThe task: ${b.text}${files}`
        : b.peer
          ? `[Friday] ${peerHead(b.peer)}\n\n${b.text}`
          : b.mesh
            ? `${meshHead(b.mesh)}\n\n${b.text}`
          : b.thread
            ? `${ev.actor.name}, in a side thread on ${threadOn(bySeq.get(b.thread.root))}: ${b.text}${files}\n\n(Answer here briefly, about this alone: it stays in the thread, beside the room's main work.)`
            : `${ev.actor.name}${via}: ${b.text}${files}`,
    );
  }
  // An undo since this CLI last heard from the room. Its own memory still has
  // the edits it made, so without this it builds on files that are gone.
  const lastDelivered = events.findLast((e) => e.body.type === "instructions.delivered")?.seq ?? 0;
  const undone = events.filter((e) => e.seq > lastDelivered && e.body.type === "folder.restored");
  if (undone.length) parts.unshift(`[Friday] ${undone.at(-1)!.actor.name} put the folder back to how it was before an earlier run, so changes you made then may no longer be there. Check the files before building on them.`);
  // Handed back after a drop cut it off (a deploy, a network drop): carried on, not done again from the start.
  const again = seqs.some((q) => events.some((e) => e.body.type === "instructions.requeued" && e.body.seqs.includes(q)));
  if (again) parts.unshift("[Friday] Your connection to Friday dropped while you were on this, so it comes to you again. Carry on from where you got to: look at what you already changed before doing any of it again.");
  return { prompt: parts.join("\n\n"), attachments };
}

/**
 * The longest command a runner's approval question carries whole: the same bound as Friday's own (runtime MAX_ASKED).
 * The runner grants the whole command on a yes, so a longer one says on the card that the rest isn't shown, and a
 * delegated editor can't approve it (the line saying so is a command of no kind they may approve).
 */
const MAX_ITEM = 4_000;

/** Only what a runner may write, capped. Anything else is dropped. */
/** What a logged change set keeps of each file's patch, and of all of them together (leanDiff). */
export const LOGGED_FILE_PATCH = 20_000;
export const LOGGED_DIFF_TOTAL = 200_000;

/**
 * A change set as the session's log keeps it (Arun, 2026-10-19: "server stability"). It is logged at the end of every turn and
 * names every file changed so far, so a session with fifty changed files logged them all again each turn: change sets were
 * 7 of the archive's 12 MB, up to 330 KB each, binary files' bytes included, and they filled production's Redis until it
 * restarted. Kept: every file's name and counts; a patch up to LOGGED_FILE_PATCH, LOGGED_DIFF_TOTAL in all; no binary
 * file's bytes. What is cut is marked `truncated`, which the diff view says ("cut short"); the room saw it whole, live.
 */
export function leanDiff(d: Extract<EventBody, { type: "agent.diff" }>): Extract<EventBody, { type: "agent.diff" }> {
  let budget = LOGGED_DIFF_TOTAL;
  const files = d.files.map((f) => {
    const binary = f.patch.includes("\u0000") || /^(?:GIT binary patch|Binary files .* differ)$/m.test(f.patch);
    const room = binary ? 0 : Math.max(0, Math.min(LOGGED_FILE_PATCH, budget));
    if (f.patch.length <= room) {
      budget -= f.patch.length;
      return f;
    }
    // Cut at a line, so a hunk isn't left with half a line.
    const cut = f.patch.slice(0, room);
    const patch = binary ? "" : cut.slice(0, Math.max(0, cut.lastIndexOf("\n")));
    budget -= patch.length;
    return { ...f, patch, truncated: true };
  });
  return { ...d, files };
}

function cleanBody(raw: unknown): EventBody | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const s = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
  if (b.type === "agent.message") {
    const toolCalls: ToolCall[] = (Array.isArray(b.toolCalls) ? b.toolCalls : []).slice(0, 50).flatMap((c: any) =>
      c && typeof c.id === "string" && typeof c.name === "string" ? [{ id: s(c.id, 120), name: s(c.name, 120), arguments: s(c.arguments, 8000) }] : [],
    );
    const reasoning = Array.isArray(b.reasoning) ? b.reasoning.slice(0, 10).map((r: any) => ({ type: "reasoning.text", text: s(r?.text, MAX_TEXT) })) : undefined;
    const text = s(b.text, MAX_TEXT);
    if (!text && !toolCalls.length && !reasoning?.length) return null;
    return { type: "agent.message", text, toolCalls, ...(reasoning?.length ? { reasoning } : {}) };
  }
  if (b.type === "tool.result") {
    if (typeof b.callId !== "string") return null;
    return { type: "tool.result", callId: s(b.callId, 120), name: s(b.name, 120) || "tool", output: s(b.output, MAX_TEXT), isError: !!b.isError };
  }
  if (b.type === "engine.approval") {
    const items = (Array.isArray(b.items) ? b.items : [])
      .slice(0, 8)
      .map((i) => (typeof i === "string" && i.length > MAX_ITEM ? `${i.slice(0, MAX_ITEM)}\n[… ${i.length - MAX_ITEM} more characters not shown]` : s(i, MAX_ITEM)))
      .filter(Boolean);
    if (!items.length || typeof b.id !== "string") return null;
    const why = s(b.why, 300);
    return { type: "engine.approval", id: s(b.id, 40), scope: b.scope === "commands" ? "commands" : "turn", items, ...(b.live === true ? { live: true } : {}), ...(why ? { why } : {}) };
  }
  if (b.type === "agent.usage") {
    // A turn's tokens; anything past a few million in one turn is not a count worth keeping.
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), 50_000_000) : 0);
    const u = { input: num(b.input), cached: num(b.cached), output: num(b.output) };
    // How full its context is, and its model's window (at most ten million tokens, any model today).
    const context = Math.min(num(b.context), 10_000_000);
    const window = Math.min(num(b.window), 10_000_000);
    return u.input + u.cached + u.output ? { type: "agent.usage", ...u, ...(context ? { context, ...(window ? { window } : {}) } : {}) } : null;
  }
  if (b.type === "effort.skipped") return isEngineEffort(b.effort) ? { type: "effort.skipped", effort: b.effort } : null;
  if (b.type === "account.switched") {
    const acct = (v: any) => (v && typeof v.id === "string" && v.id ? { id: s(v.id, 40), label: s(v.label, 40) || s(v.id, 40) } : null);
    const from = acct(b.from);
    const to = acct(b.to);
    const until = typeof b.until === "number" && Number.isFinite(b.until) && b.until > 0 ? Math.round(b.until) : 0;
    return from && to ? { type: "account.switched", from, to, ...(until ? { until } : {}) } : null;
  }
  if (b.type === "agent.task") {
    const status = (["running", "done", "error", "stopped"] as const).find((x) => x === b.status);
    if (!status || typeof b.id !== "string" || !b.id) return null;
    const description = s(b.description, 200);
    const agentType = s(b.agentType, 60);
    const summary = s(b.summary, 4000);
    const doing = s(b.doing, 120);
    const steps = typeof b.steps === "number" && Number.isFinite(b.steps) && b.steps > 0 ? Math.min(100_000, Math.round(b.steps)) : 0;
    return { type: "agent.task", id: s(b.id, 80), status, ...(description ? { description } : {}), ...(agentType ? { agentType } : {}), ...(typeof b.background === "boolean" ? { background: b.background } : {}), ...(summary ? { summary } : {}), ...(doing ? { doing } : {}), ...(steps ? { steps } : {}) };
  }
  if (b.type === "agent.diff") {
    let budget = 700_000;
    const files: DiffFile[] = (Array.isArray(b.files) ? b.files : []).slice(0, 80).flatMap((f: any) => {
      if (!f || typeof f.path !== "string") return [];
      const status = ["added", "modified", "deleted", "renamed"].includes(f.status) ? f.status : "modified";
      const patch = s(f.patch, Math.max(0, Math.min(80_000, budget)));
      budget -= patch.length;
      const from = status === "renamed" ? s(f.from, 400) : "";
      // An older runner sends a .env's patch as it is: its values are taken out here, before anyone in the room sees it.
      return [envNamesOnly({ path: s(f.path, 400), status, ...(from ? { from } : {}), additions: Number(f.additions) || 0, deletions: Number(f.deletions) || 0, patch, ...(f.truncated || patch.length < String(f.patch ?? "").length ? { truncated: true } : {}) })];
    });
    // Names only, as many as a commit takes (see folder.commit).
    const more = (Array.isArray(b.more) ? b.more : []).slice(0, 500).flatMap((p: unknown) => (typeof p === "string" && p ? [s(p, 400)] : []));
    return { type: "agent.diff", base: s(b.base, 64), files, ...(more.length ? { more } : {}) };
  }
  return null;
}
