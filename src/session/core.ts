import { refusal } from "../own-plan.js";
import { randomBytes } from "node:crypto";
import { engineName, ENGINE_TOOLS, SESSION_LANES, hostOnlyYes, isEngineEffort, effortLevelsOf, liveMachine, MAIN_LANE, type EngineEffort, type EngineTool, type ActorRef, type AgentSnapshot, type Attachment, type ControlMode, type EventBody, type Lane, type LaneControl, type LaneTrigger, type LinkRole, type PolicyPatch, type Role, type Handoff, type RepoCall, type SessionOptionsPatch, type Thinking, EFFORT_LEVELS } from "../types.js";
import { canDriveLane, driverOf, laneHeld, laneOf, meshOf, mergeOptions, pendingFor, roleOf, runOf, signoffStatus, type SessionState, effortResets } from "./projection.js";
import type { AppendGuard, AppendResult, SessionStore } from "./store.js";
type CrewDef = never;
import { prBodyFor } from "../pr-body.js";
import { mentionsIn } from "../mentions.js";
import { checkpointBefore, runEndAfter } from "../rewind.js";
import { notesPrompt, threadPrompt } from "../threads.js";
import { CLASS_LABEL, cleanClasses, headlineClass, mayApprove } from "../command-class.js";
import { feedbackText, fromWriter, unseen, type PrComment } from "../pr-feedback.js";
import { checksText, type CheckFailure } from "../pr-checks.js";

export type Command =
  | { type: "instruct"; text: string; lane?: string; /** A reply in a side thread on this earlier message (its seq). */ thread?: unknown; /** From an app on the person's behalf (app.ts postMessage): its turn is capped (Security R3). */ via?: unknown; interrupt?: boolean; attachments?: Attachment[]; handoff?: { fromLane?: string; reason?: string; carried?: unknown }; approval?: { id?: unknown; approve?: unknown }; replaces?: unknown }
  | { type: "suggest"; text: string; lane?: string; attachments?: Attachment[]; at?: { call: string; step: string } }
  /** To the people here, not an agent: an aside no agent reads. */
  | { type: "say"; text: string; lane?: string }
  | { type: "promote"; seq: number }
  /** A remark about one line, and the conversation under it. */
  | { type: "thread.open"; path: string; line: number; endLine?: number; code: string; removed?: boolean; text: string; to?: string; ask?: boolean }
  | { type: "thread.reply"; id: string; text: string }
  | { type: "thread.resolve"; id: string }
  | { type: "control.request"; lane?: string }
  /** A viewer asking an owner to make them an editor; `role.decline` is an owner's "not now". */
  | { type: "role.request" }
  | { type: "role.decline"; userId: string }
  | { type: "control.claim"; lane?: string }
  | { type: "control.yield"; to?: string; lane?: string }
  | { type: "control.deny"; to: string; lane?: string }
  | { type: "control.force"; lane?: string }
  | { type: "run.pause"; lane?: string }
  | { type: "run.resume"; lane?: string }
  | { type: "run.cancel"; lane?: string }
  | { type: "plan.approve"; lane?: string; /** The plan as the approver changed it. Absent means the agent's own. */ steps?: string[] }
  /** Say whether the plan in front of the room is fine, or what to change first. */
  | { type: "plan.review"; verdict: "approve" | "changes"; note?: string; lane?: string }
  /** Read the reviewers' comments on the session's pull request and hand the new ones to the agent. */
  | { type: "pr.feedback"; lane?: string }
  | { type: "pr.checks"; lane?: string }
  /** Hand the pull request to Friday to see through to merge, or take it back. */
  | { type: "pr.shepherd"; on: boolean; lane?: string }
  | { type: "pin.add"; path: string }
  /** Carry on by itself at `at`, when the coding tool's usage limit has reset. */
  | { type: "resume.at"; at: number; lane?: string }
  | { type: "resume.cancel"; lane?: string }
  | { type: "pin.remove"; path: string }
  | { type: "run.interrupt"; lane?: string }
  | { type: "instruction.withdraw"; seq: number; lane?: string }
  /** Let a message from another session through to this lane's agent, or turn it away (peers.ts). */
  | { type: "peer.settle"; id: string; deliver: boolean; lane?: string }
  /** Stop the agents here messaging each other, or let them again (agent-mesh.ts). */
  | { type: "mesh.pause"; on: boolean }
  /** A person's say over a task on the board, from the team's list: hand it to someone else, try it again, send it back, drop it. */
  | { type: "board.task"; id: string; action: "reassign" | "retry" | "sendback" | "cancel"; to?: string; note?: string }
  | { type: "lead.set"; lane: string | null; /** Friday's own pick, said as such (types.ts lead.set). */ auto?: boolean }
  /** A hub (hubs.ts): plan the work for several agents at once, approve the plan as changed, or call it off. */
  | { type: "hub.plan"; text: string }
  | { type: "hub.approve"; id: string; tasks?: { id: string; tool?: EngineTool }[] }
  | { type: "hub.cancel"; id: string }
  | { type: "approval.answer"; id: string; approve: boolean; lane?: string }
  | { type: "suggestion.dismiss"; seq: number }
  | { type: "thread.send"; id: string; lane?: string }
  /** Several notes to one agent as one instruction (Arun, 2026-10-25: notes gather, then go together): each is marked sent. */
  | { type: "threads.send"; ids: string[]; lane?: string }
  /** Goal mode: when this agent's work is done, in words, with a command whose success proves it when there is one. */
  | { type: "goal.set"; text: string; check?: string; lane?: string }
  | { type: "goal.clear" }
  | { type: "handover.save"; text: string }
  | { type: "react"; seq: number; up: boolean | null; reason?: string }
  | { type: "thread.reopen"; id: string }
  | {
      type: "settings.update";
      controlMode?: ControlMode;
      allow?: string[];
      webSearch?: boolean;
      planFirst?: boolean;
      signoff?: number;
      autoTest?: boolean;
      review?: boolean;
      /** Link the recording in pull requests to public repositories too (SessionOptions.prReplay). */
      prReplay?: boolean;
      thinking?: Thinking;
      mcp?: boolean;
      /** Keep the session to the people in it (SessionOptions.private). */
      private?: boolean;
      title?: string;
      policy?: PolicyPatch;
      /** Which kinds of command editors may approve. */
      approve?: { editor?: unknown };
      /** Switch the session's agent; null returns to the default agent. */
      agentId?: string | null;
      /** Which model Friday Code runs; "" is the workspace default. */
      model?: string;
    }
  | { type: "lane.add"; name: string; agentId?: string | null; control?: LaneControl; controlMode?: ControlMode; trigger?: LaneTrigger; /** A member adding a lane for their own agent: it is theirs to drive, and nobody else's but an owner's. */ own?: boolean; /** A lane for somebody's own coding tool (Claude Code, Codex, Cursor): it runs on their machine, so a plan's agent limit does not apply. */ engine?: boolean }
  | { type: "lane.remove"; laneId: string }
  /** Pin how hard this lane's coding tool thinks from its next message; null is Auto (no flag, the tool's or the router's own). */
  | { type: "lane.effort"; lane?: string; effort: EngineEffort | "auto" | null }
  /** The host lets others' messages run this lane in Full on their computer, or takes that back (Security R2). */
  | { type: "lane.othersFull"; lane?: string; on: boolean }
  | { type: "lane.rename"; laneId: string; name: string }
  /** Add a saved pipeline's lanes, wired to each other, in one go. */
  | { type: "crew.apply"; crewId: string }
  | { type: "member.role"; userId: string; role: Role }
  | { type: "member.remove"; userId: string }
  | { type: "link.update"; role: LinkRole; enabled?: boolean; rotate?: boolean }
  /** Reserve a lane for your own local CLI; instructions wait for it to connect. */
  | { type: "engine.expect"; tool: EngineTool; lane?: string }
  /** Hand a lane back from someone's local CLI to Friday's own agent. */
  | { type: "engine.release"; lane?: string }
  /** Put the session's folder back to a checkpoint: undo a run, or redo one. */
  | { type: "folder.restore"; sha: string; lane?: string; /** Also set aside the conversation from this message on. */ rewindTo?: number }
  /** Run a command in the session's folder, by hand rather than through an agent. */
  | { type: "folder.run"; command: string; lane?: string }
  /** Write a file in the session's folder, by hand rather than through an agent. */
  | { type: "folder.write"; path: string; content: string; lane?: string }
  /** Move the folder to another branch, making it if it isn't there yet. */
  | { type: "folder.switch"; branch: string; create?: boolean; lane?: string }
  /** Commit the folder's changes; optionally push, and open a pull request. */
  | { type: "folder.commit"; message: string; branch?: string; push?: boolean; pr?: boolean; only?: string[]; lane?: string; /** Open the pull request onto this branch: a stacked pull request, on top of the one that branch has. */ base?: string; /** Commit in one of the folders the agent also works in. */ dir?: string }
  /** Bring an agent's work from its separate copy into the folder the copy was made from. */
  | { type: "folder.apply"; lane?: string }
  /** The Git panel's moves: stage or unstage files or one hunk, throw changes away, pull the branch. */
  | { type: "folder.git"; action: "stage" | "unstage" | "discard" | "hunk" | "pull"; paths?: string[]; patch?: string; cached?: boolean; reverse?: boolean; untracked?: boolean; lane?: string; /** One of the folders the agent also works in, when the move is there. */ dir?: string };

export type CommandResult = { ok: true; seq: number; /** The lane a lane.add made. */ lane?: string } | { ok: false; error: string };

export interface CommandActor {
  id: string;
  name: string;
}

/** Looks up an agent the user is allowed to use and freezes its current configuration. */
/** `workspaceId` scopes the lookup: an agent belongs to a workspace, not to a deployment. */
export type AgentResolver = (userId: string, agentId: string, workspaceId: string) => Promise<AgentSnapshot | null>;
/** A crew this person is allowed to use, in this session's workspace. */
export type CrewResolver = (userId: string, crewId: string, workspaceId: string) => Promise<CrewDef | null>;

/**
 * The model this workspace may actually run, given the one asked for.
 *
 * An agent built on a frontier model and shared with a Free workspace has to
 * keep working — it just runs on Friday's own model there. Downgrading beats
 * refusing: the person who was shared the agent didn't choose its model and
 * can't do anything about it.
 */
/** A model the workspace can run, as `actorId` chose it: somebody's own model only from its owner. */
export type ModelPolicy = (workspaceId: string, model: string, actorId?: string) => Promise<string>;

/** The session's folder, wherever it is: a linked machine or an upload. */
/** The folder a request is about: the lane's own, when it has one (a worktree), else the session's. */
export type FolderAccess = (sid: string, req: RepoCall, lane?: string, /** The person asking. */ by?: string) => Promise<{ output: string }>;

const MAX_TEXT = 8000;
const MAX_ATTACHMENTS = 10;
const OWNER_ONLY = new Set<Command["type"]>(["settings.update", "member.role", "member.remove", "link.update", "hub.plan", "hub.approve", "hub.cancel", "role.decline"]);

/**
 * A coding tool's own commands that change what it may reach or run on its host's machine: more folders, its permissions,
 * its sign-in, its MCP servers, hooks, extensions and lasting memory (Claude Code's, Gemini CLI's and Codex's). Only the host runs these on their tool; a teammate driving the lane keeps the
 * rest (its prompts, skills, /review, /compact).
 */
const ACCESS_COMMANDS = new Set(["add-dir", "permissions", "allowed-tools", "config", "settings", "login", "logout", "mcp", "hooks", "agents", "plugin", "plugins", "sandbox", "terminal-setup", "install-github-app", "ide", "bashes", "extensions", "extension", "directory", "dir", "auth", "memory", "approvals"]);

/** The access command a message is ("/Add-Dir ~/x" → "add-dir"), or null. */
export function accessCommand(text: string): string | null {
  const name = /^\/(\S+)/.exec(text.trim())?.[1]?.toLowerCase();
  return name && ACCESS_COMMANDS.has(name) ? name : null;
}

/** Why `who` may not send `text` to the coding tool on `lane`, or null when they may. */
function hostOnlyCommand(state: SessionState, lane: string, who: string, text: string): string | null {
  const engine = state.engines[lane];
  const name = engine?.tool && engine.hostId !== who ? accessCommand(text) : null;
  return name ? `/${name} changes what ${engine!.hostName}'s ${engineName(engine!.tool)} can reach, so only ${engine!.hostName} can run it.` : null;
}

/**
 * Why `who` may not say yes to what `lane` runs, or null when they may: on a Manual machine somebody attached, that yes is
 * its host's alone, whoever drives or owns the session. A no runs nothing, so anyone who may answer may still say no.
 */
function hostsYes(state: SessionState, lane: string, who: string): string | null {
  const e = liveMachine(state, lane) ?? state.engines[lane];
  return e && e.mode === "edits" && e.hostId !== who ? hostOnlyYes(e.hostName) : null;
}

/**
 * The session core: validates a command against the member's role, the
 * session's permission policy and the control token, then appends the
 * resulting event.
 *
 * The member's role is read from the session log, never from the link they
 * connected with, so an owner's change (promote, demote, remove) takes effect
 * on the very next command. Steering (instruct, promote, resume, yield) is
 * driver-only. Stopping (pause, cancel) is allowed for the driver *or an
 * owner*: whoever is accountable for the session always has a kill switch.
 */
export class SessionCore {
  constructor(
    private store: SessionStore,
    private wake: (sid: string, lane?: string) => void,
    private resolveAgent: AgentResolver = async () => null,
    private resolveCrew: CrewResolver = async () => null,
    private allowModel: ModelPolicy = async (_w, m) => m,
    private folder: FolderAccess | null = null,
    /** Where this Friday lives, so a pull request can link back to its session. */
    private appUrl = "",
    /** How many agents beyond the main one this workspace's plan runs side by side; the plan's, not the session's. */
    private laneCap: (workspaceId: string) => Promise<number> = async () => 6,
    /** A read-only recording link for a session, when its viewer link is on; the app signs it. */
    private replayLink: (sid: string, state: SessionState) => string | undefined = () => undefined,
    /** Whether a workspace is on Team, where people other than a session's owner work in it; on Solo they watch. */
    private team: (workspaceId: string) => Promise<boolean> = async () => true,
  ) {}

  /**
   * Whether a GitHub repository is public, private, or can't be told (null), set by the app (Security APP-3). Unset, every
   * repository counts as one that can't be told.
   */
  repoVisibility: ((slug: string) => Promise<"public" | "private" | null>) | null = null;

  /**
   * The recording link for a pull request's body (Security APP-3). The link reads the whole session, so it goes only where
   * the readers are the repository's own people: a private repository, or any repository once the owner turned it on for
   * this session (prReplay). A public one, or one whose visibility can't be told, gets none.
   */
  private async replayForPr(sid: string, state: SessionState, folderAt: (req: RepoCall) => Promise<{ output: string }>): Promise<string | undefined> {
    const link = this.replayLink(sid, state);
    if (!link || state.options.prReplay) return link;
    const remote = parseJson<{ github?: string | null }>((await folderAt({ op: "remote" }).catch(() => ({ output: "" }))).output);
    const seen = remote?.github && this.repoVisibility ? await this.repoVisibility(remote.github).catch(() => null) : null;
    return seen === "private" ? link : undefined;
  }

  /** The session's hubs (hubs.ts), set by the app: one plan, several agents at once. */
  /** The task board's controls (AgentMesh.control), for board.task. */
  board: { control(sid: string, actor: ActorRef, req: { id: string; action: "reassign" | "retry" | "sendback" | "cancel"; to?: string; note?: string }): Promise<{ ok: true } | { ok: false; error: string }> } | null = null;
  hubs: { plan(sid: string, goal: string, by: { id: string; name: string }): Promise<{ ok: true; id: string } | { ok: false; error: string }>; approve(sid: string, id: string, edits: { id: string; tool?: EngineTool }[] | undefined): Promise<{ ok: true; id: string } | { ok: false; error: string }>; cancel(sid: string, id: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> } | null = null;

  /** Whether people other than this session's owner may work in it (Team), rather than only watch (Solo). */
  async collaborates(state: SessionState): Promise<boolean> {
    return !state.workspaceId || (await this.team(state.workspaceId));
  }

  /**
   * Takes the wheel of every agent a person holds, and detaches the coding tool they connected, when `lost` says they may no longer have it.
   *
   * It used to look only at the main agent, so somebody removed from a session (or made a viewer) who was driving a second agent kept
   * it: their lane then waited on a person who could no longer answer, and nobody else could claim it short of an owner's takeover.
   */
  async releaseWheels(sid: string, state: SessionState, userId: string, reason: "removed" | "revoked", lost: (lane: string) => boolean) {
    for (const l of [MAIN_LANE, ...state.lanes.map((x) => x.id)]) {
      if (!lost(l)) continue;
      if (driverOf(state, l)?.id === userId) {
        await this.store.append(sid, SYSTEM, { type: "control.released", from: userId, reason }, { expectDriver: userId, setDriver: { id: "", name: "" }, lane: l });
      }
      // Their own coding tool, attached from their machine, goes with it. Left connected it kept receiving what the room said and
      // carrying out what teammates asked, on a machine whose owner was no longer part of the session.
      const engine = state.engines[l];
      if (engine?.hostId === userId) {
        await this.store.append(sid, SYSTEM, { type: "engine.detached", reason: "released", ...(engine.tool ? { tool: engine.tool } : {}) }, { lane: l });
      }
    }
  }

  async handle(sid: string, m: CommandActor, cmd: Command): Promise<CommandResult> {
    if (!cmd || typeof cmd.type !== "string") return fail("Malformed command.");
    const state = await this.store.state(sid);
    const role = roleOf(state, m.id);
    // A deleted session has nobody in it: said as what it is, only when the check fails, so a command costs nothing more.
    if (!role) return fail(state.members[m.id]?.removed ? "You were removed from this session." : (await this.store.buried(sid)) ? "This session was deleted." : "You're not a member of this session.");

    const owner = role === "owner";
    // On Solo only a session's owner works in it; anyone else watches, whatever role they joined with (they keep it for when the
    // workspace is on Team again). A reaction is watching.
    if (!owner && cmd.type !== "react" && !(await this.collaborates(state))) {
      return fail("This workspace is on Solo, so only this session's owner works in it; you can watch. Working together needs a Team plan (7 days free).");
    }
    const allowed = (p: "suggest" | "control" | "upload" | "invite") => owner || state.options.policy[role][p];
    const deny = (what: string) =>
      fail(role === "viewer" ? `Viewers can watch this session but can't ${what}.` : `${cap(role)}s can't ${what}.`);
    // Settings are the owner's, with one exception: which model Friday Code uses
    // and how hard it thinks. That is the day-to-day tuning of whoever is
    // steering, the plan already limits what can be chosen, and a model pill that
    // answered "owner only" was a control for nobody but the owner.
    const SHARED_SETTINGS = new Set(["type", "model", "thinking", "lane"]);
    const tuningOnly = cmd.type === "settings.update" && Object.keys(cmd).every((k) => SHARED_SETTINGS.has(k) || (cmd as Record<string, unknown>)[k] === undefined);
    if (OWNER_ONLY.has(cmd.type) && !owner && !(tuningOnly && allowed("control"))) return deny(OWNER_VERBS[cmd.type] ?? "do that (owner only)");

    const actor: ActorRef = { id: m.id, name: m.name, kind: "human" };
    // Every append in a command lands on the lane the command targets, so the
    // Lua guard reads that lane's driver and epoch rather than the main one's.
    const lane = "lane" in cmd && typeof cmd.lane === "string" && cmd.lane ? cmd.lane : MAIN_LANE;
    // The people a message names with "@" (mentions.ts): carried on the event, so they're told and it waits on them.
    const withMentions = (text: string) => {
      const ids = mentionsIn(text, state, m.id);
      return ids.length ? { mentions: ids } : {};
    };
    // Commands about the folder go to this lane's own, so an agent in a worktree commits and runs there.
    const folderAt = (req: RepoCall) => this.folder!(sid, req, lane, m.id);
    if (lane !== MAIN_LANE && !state.lanes.some((l) => l.id === lane)) return fail("That agent isn't in this session.");
    const laneDriver = driverOf(state, lane);
    const laneRun = runOf(state, lane);
    const driverName = laneDriver?.name ?? "nobody";
    const append = (body: EventBody, guard: AppendGuard = {}) => this.store.append(sid, actor, body, { ...guard, lane });
    // Acting on something once: two presses of the same card (two people, or one double click) both read the same snapshot, so the
    // first to claim the key wins and the other is told it was already done. Released when the append itself is refused, so a retry works.
    const claimOnce = async (key: string) => !!(await this.store.redis.set(`${this.store.prefix}${key}`, "1", "EX", 86_400, "NX"));
    const release = (key: string) => this.store.redis.del(`${this.store.prefix}${key}`);
    const asDriver = (r: AppendResult) =>
      r.ok ? ok(r.seq) : r.reason === "gone" ? fail("This session was deleted.") : fail(`Only the current driver can do that (driving now: ${nameOf(r.driver, state, driverName)}).`);

    switch (cmd.type) {
      case "instruct": {
        const text = clean(cmd.text);
        const attachments = cleanAttachments(cmd.attachments);
        if (!text && !attachments.length) return fail("Instruction is empty.");
        const hostOnly = hostOnlyCommand(state, lane, m.id, text);
        if (hostOnly) return fail(hostOnly);
        if (attachments.length && !allowed("upload")) return deny("attach files");
        // An edit of a queued message: one write that takes the old one back and puts this in its place, so the queue keeps its
        // order and nothing is lost between the two (taking back and sending again moved it to the back, and lost it whenever
        // the send was refused). The same people may edit it as may take it back.
        let replaces: number | undefined;
        if (cmd.replaces !== undefined) {
          const seq = Number(cmd.replaces);
          if (!Number.isInteger(seq) || !pendingFor(state, lane).includes(seq)) return fail("That message has already been delivered, or was taken back.");
          const target = (await this.store.events(sid)).find((e) => e.seq === seq);
          if (!target || target.body.type !== "instruction" || target.body.mesh || target.body.peer) return fail("That isn't a message you can edit.");
          if (target.actor.id !== m.id && !owner && laneDriver?.id !== m.id) return deny("change someone else's message");
          replaces = seq;
        }
        // A coding tool on its host's own plan takes its host's work alone (own-plan.ts): anyone else is told so, and what they can
        // do instead, whatever their role or whether they hold the wheel. Saying no to what it asks runs nothing, so that stays open.
        if (!(cmd.approval && cmd.approval.approve !== true)) {
          const notTheirs = refusal(state.engines[lane], m.id, m.name);
          if (notTheirs) return fail(notTheirs);
        }
        // Somebody who may not steer this agent is told that, and pointed at the thing they may do. The driver check further down would
        // otherwise say "nobody is driving" to a viewer, as if it were something they could fix.
        if (laneDriver?.id !== m.id && !canDriveLane(state, m.id, lane)) {
          return fail(`${role === "viewer" ? "Viewers can watch this session but can't steer it" : "You can't steer this agent"}${allowed("suggest") ? ". Send a suggestion instead" : ""}.`);
        }
        // Nobody is driving and you're allowed to: take the wheel by writing,
        // rather than making people click "take control" first. With several
        // agents in a session that click was most of the work.
        if (!laneDriver && canDriveLane(state, m.id, lane)) {
          const claim = await append({ type: "control.granted", to: m.id, toName: m.name, reason: "claim" }, { expectDriver: "", setDriver: { id: m.id, name: m.name } });
          if (!claim.ok) return fail(`${nameOf(claim.driver, state, driverName)} just took control. Your message wasn't sent.`);
        }
        const interrupt = !!cmd.interrupt;
        const handoff = cmd.handoff ? cleanHandoff(state, cmd.handoff, lane) : undefined;
        if (cmd.handoff && !handoff) return fail("A handoff has to come from another agent in this session, with a reason.");
        // Answering a request for permission: only to what is actually waiting, and only by whoever is driving this lane.
        const ask = cmd.approval ? state.approvals[lane] : undefined;
        if (cmd.approval && (!ask || ask.id !== cmd.approval.id)) return fail("That request was already answered, or isn't waiting any more.");
        const approval = ask ? { id: ask.id, approve: cmd.approval?.approve === true } : undefined;
        const notYours = approval?.approve ? hostsYes(state, lane, m.id) : null;
        if (notYours) return fail(notYours);
        const answered = approval ? `answered:${sid}:${approval.id}` : "";
        // A side thread's root: an earlier message in this session, by its seq.
        const root = Number(cmd.thread);
        const thread = Number.isInteger(root) && root > 0 ? { root } : undefined;
        if (answered && !(await claimOnce(answered))) return fail("That request was already answered.");
        const r = await append(
          { type: "instruction", text, interrupt, ...withMentions(text), ...(cmd.via === "api" ? { via: "api" as const } : {}), ...(attachments.length ? { attachments } : {}), ...(handoff ? { handoff } : {}), ...(approval ? { approval } : {}), ...(replaces !== undefined ? { replaces } : {}), ...(thread ? { thread } : {}) },
          { expectDriver: m.id, bumpEpoch: interrupt && laneRun.status === "running" },
        );
        if (!r.ok && answered) await release(answered);
        // A stopped agent is idle, not paused: a message to it is simply its next task, with nothing to resume first.
        if (r.ok) this.wake(sid, lane);
        return asDriver(r);
      }

      case "suggest": {
        if (!allowed("suggest")) return deny("make suggestions");
        const text = clean(cmd.text);
        const attachments = cleanAttachments(cmd.attachments);
        if (!text && !attachments.length) return fail("Suggestion is empty.");
        if (attachments.length && !allowed("upload")) return deny("attach files");
        if (laneDriver?.id === m.id) return fail("You're driving, so send an instruction instead.");
        // Raised at a step of the run, so the driver sees it there and not only in the pile.
        const at = cmd.at && typeof cmd.at === "object" ? (cmd.at as { call?: unknown; step?: unknown }) : null;
        const atStep = at && typeof at.call === "string" && at.call ? { at: { call: at.call.slice(0, 80), step: String(at.step ?? "").slice(0, 160) } } : {};
        const r = await append({ type: "suggestion", text, ...withMentions(text), ...(attachments.length ? { attachments } : {}), ...atStep });
        return r.ok ? ok(r.seq) : fail("Could not record suggestion.");
      }

      // An aside: said to the people here, never to an agent. Anyone in the session may talk, watchers included.
      case "say": {
        const text = clean(cmd.text);
        if (!text) return fail("Say something first.");
        const r = await append({ type: "chat", text, ...withMentions(text) });
        return r.ok ? ok(r.seq) : fail("Could not send that.");
      }

      case "thread.open": {
        // Commenting is suggesting: it is the same act — telling the agent
        // something without taking the wheel — aimed at a line instead of at
        // the run, so it is allowed on the same permission.
        if (!allowed("suggest")) return deny("comment on changes");
        const text = clean(cmd.text);
        if (!text) return fail("The comment is empty.");
        const path = String(cmd.path ?? "").slice(0, 400);
        if (!path) return fail("Which file?");
        const id = randomBytes(6).toString("base64url");
        const r = await append({
          type: "thread.opened",
          id,
          path,
          line: Math.max(0, Math.floor(Number(cmd.line) || 0)),
          ...(Number(cmd.endLine) > Number(cmd.line) ? { endLine: Math.floor(Number(cmd.endLine)) } : {}),
          code: String(cmd.code ?? "").slice(0, Number(cmd.endLine) > Number(cmd.line) ? 1600 : 400),
          ...(cmd.removed ? { removed: true } : {}),
          text,
          ...(cmd.to ? { to: String(cmd.to).slice(0, 80) } : {}),
          ...(cmd.ask ? { ask: true } : {}),
        });
        return r.ok ? ok(r.seq) : fail("Could not record the comment.");
      }

      case "thread.reply": {
        if (!allowed("suggest")) return deny("comment on changes");
        const text = clean(cmd.text);
        if (!text) return fail("The reply is empty.");
        if (!state.threads.some((t) => t.id === cmd.id)) return fail("That comment is gone.");
        const r = await append({ type: "thread.replied", id: cmd.id, text });
        return r.ok ? ok(r.seq) : fail("Could not record the reply.");
      }

      case "thread.resolve": {
        const t = state.threads.find((x) => x.id === cmd.id);
        if (!t) return fail("That comment is gone.");
        if (t.resolved) return ok(state.lastSeq);
        // Whoever raised it, and whoever can steer. A reviewer should be able
        // to close their own remark, and a driver should be able to close one
        // the code has already answered.
        if (t.by.id !== m.id && !allowed("control")) return deny("resolve other people's comments");
        const r = await append({ type: "thread.resolved", id: cmd.id });
        return r.ok ? ok(r.seq) : fail("Could not resolve the comment.");
      }

      /**
       * Hand a review comment to an agent as work.
       *
       * It is an instruction like any other, so it takes the same standing: the person driving that agent, or somebody who may drive it
       * when nobody is. Which agent: the one the comment was addressed to, else the one named, else the main one.
       */
      case "thread.send": {
        const t = state.threads.find((x) => x.id === cmd.id);
        if (!t) return fail("That comment is gone.");
        if (t.resolved) return fail("That comment is already resolved. Reopen it first.");
        const to = state.lanes.some((l) => l.id === t.to) ? t.to! : String(cmd.lane ?? "") && (cmd.lane === MAIN_LANE || state.lanes.some((l) => l.id === cmd.lane)) ? String(cmd.lane) : MAIN_LANE;
        const toDriver = driverOf(state, to);
        if (!toDriver && canDriveLane(state, m.id, to)) {
          const claim = await this.store.append(sid, actor, { type: "control.granted", to: m.id, toName: m.name, reason: "claim" }, { expectDriver: "", setDriver: { id: m.id, name: m.name }, lane: to });
          if (!claim.ok) return fail("Somebody just took control of that agent. The comment wasn't sent.");
        } else if (toDriver?.id !== m.id) return deny("send comments to an agent you're not driving");
        const onLane = (body: EventBody, guard: AppendGuard = {}) => this.store.append(sid, actor, body, { ...guard, lane: to });
        const said = await onLane({ type: "instruction", text: threadPrompt(t), interrupt: false }, { expectDriver: m.id });
        if (!said.ok) return asDriver(said);
        await onLane({ type: "thread.sent", id: t.id, lane: to });
        this.wake(sid, to);
        return ok(said.seq);
      }

      case "goal.set": {
        const text = clean(cmd.text).slice(0, 2000);
        if (!text) return fail("Say when the work is done.");
        const lane = cmd.lane === MAIN_LANE || state.lanes.some((l) => l.id === cmd.lane) ? String(cmd.lane) : MAIN_LANE;
        // Whoever may steer that agent sets the bar for its work.
        if (!canDriveLane(state, m.id, lane) && driverOf(state, lane)?.id !== m.id) return deny("set a goal for an agent you can't steer");
        const check = String(cmd.check ?? "").trim().slice(0, 400);
        const r = await this.store.append(sid, actor, { type: "goal.set", text, ...(check ? { check } : {}) }, { lane });
        return r.ok ? ok(r.seq) : fail("Could not record the goal.");
      }

      case "goal.clear": {
        if (!state.goal) return ok(state.lastSeq);
        if (!canDriveLane(state, m.id, state.goal.lane) && driverOf(state, state.goal.lane)?.id !== m.id && state.goal.by.id !== m.id) return deny("stop a goal you didn't set");
        const r = await this.store.append(sid, actor, { type: "goal.cleared" }, { lane: state.goal.lane });
        return r.ok ? ok(r.seq) : fail("Could not stop the goal.");
      }

      case "threads.send": {
        const ids = Array.isArray(cmd.ids) ? cmd.ids.filter((x): x is string => typeof x === "string").slice(0, 60) : [];
        const ts = state.threads.filter((t) => ids.includes(t.id) && !t.resolved && !t.sent);
        if (!ts.length) return fail("Nothing to send: those notes are gone, resolved or already with an agent.");
        const to = cmd.lane === MAIN_LANE || state.lanes.some((l) => l.id === cmd.lane) ? String(cmd.lane) : MAIN_LANE;
        const toDriver = driverOf(state, to);
        if (!toDriver && canDriveLane(state, m.id, to)) {
          const claim = await this.store.append(sid, actor, { type: "control.granted", to: m.id, toName: m.name, reason: "claim" }, { expectDriver: "", setDriver: { id: m.id, name: m.name }, lane: to });
          if (!claim.ok) return fail("Somebody just took control of that agent. The notes weren't sent.");
        } else if (toDriver?.id !== m.id) return deny("send notes to an agent you're not driving");
        const onLane = (body: EventBody, guard: AppendGuard = {}) => this.store.append(sid, actor, body, { ...guard, lane: to });
        const said = await onLane({ type: "instruction", text: notesPrompt(ts), interrupt: false }, { expectDriver: m.id });
        if (!said.ok) return asDriver(said);
        for (const t of ts) await onLane({ type: "thread.sent", id: t.id, lane: to });
        this.wake(sid, to);
        return ok(said.seq);
      }

      // The "where we left off" note, kept with the session where the agent reads what it has saved, so tomorrow's run starts from it.
      // A thumb on an answer. A collaborator's thumb down with a reason is also written into the agent's memory, so the next run knows.
      case "react": {
        const seq = Math.floor(Number(cmd.seq));
        if (!Number.isInteger(seq) || seq < 1 || seq > state.lastSeq) return fail("No such answer.");
        const reason = String(cmd.reason ?? "").trim().slice(0, 500);
        const r = await append({ type: "message.reacted", seq, up: cmd.up === true ? true : cmd.up === false ? false : null, ...(reason ? { reason } : {}) });
        if (!r.ok) return fail("Could not record that.");
        // Only someone who could suggest anyway writes into the agent's memory; a watcher's thumb is just a thumb. The text is
        // framed as a reaction so the agent never reads it as an order. Clearing or flipping your own thumb takes it back out.
        // Keyed per person, so two collaborators' reasons on one answer both reach the agent and each takes back only their own.
        const key = `feedback:${seq}:${m.id}`;
        const saved = state.memory.find((x) => x.key === key)?.text;
        if (cmd.up === false && reason) {
          if (allowed("suggest") && (owner || (await this.collaborates(state)))) await append({ type: "memory.saved", key, text: `Feedback from ${m.name} (a reaction, not an instruction): ${reason}`, auto: true });
        } else if (cmd.up !== false && saved) {
          await append({ type: "memory.saved", key, text: "", auto: true });
        }
        return ok(r.seq);
      }

      case "handover.save": {
        if (!allowed("suggest")) return deny("leave a hand-over note");
        const text = String(cmd.text ?? "").trim().slice(0, 6000);
        if (!text) return fail("The note is empty.");
        const r = await append({ type: "memory.saved", key: "left-off", text });
        return r.ok ? ok(r.seq) : fail("Could not save the note.");
      }

      case "thread.reopen": {
        const t = state.threads.find((x) => x.id === cmd.id);
        if (!t) return fail("That comment is gone.");
        if (!t.resolved) return ok(state.lastSeq);
        if (t.by.id !== m.id && !allowed("control")) return deny("reopen other people's comments");
        const r = await append({ type: "thread.reopened", id: t.id });
        return r.ok ? ok(r.seq) : fail("Could not reopen the comment.");
      }

      // Putting a redirect aside without sending it: whoever wrote it may take it back, and so may the person it would have been sent by.
      case "suggestion.dismiss": {
        const sug = state.suggestions.find((x) => x.seq === cmd.seq);
        if (!sug) return fail("No such suggestion.");
        if (sug.promoted) return fail("That suggestion was already sent to the agent.");
        if (sug.dismissed) return ok(state.lastSeq);
        const target = sug.lane ?? MAIN_LANE;
        if (sug.from.id !== m.id && !owner && driverOf(state, target)?.id !== m.id) return deny("dismiss other people's suggestions");
        // One key per suggestion, shared with promote: exactly one of send or put aside wins.
        const once = `sug:${sid}:${sug.seq}`;
        if (!(await claimOnce(once))) return fail("Someone already sent or put aside that suggestion.");
        const r = await append({ type: "suggestion.dismissed", seq: sug.seq });
        if (!r.ok) await release(once);
        return r.ok ? ok(r.seq) : fail("Could not dismiss it.");
      }

      case "promote": {
        const sug = state.suggestions.find((s) => s.seq === cmd.seq);
        if (!sug) return fail("No such suggestion.");
        if (sug.promoted) return fail("That suggestion was already sent to the agent.");
        if (sug.dismissed) return fail("That suggestion was put aside.");
        // It goes to the agent it was written for, whichever lane the command happens to name. Promoting a
        // suggestion for one agent used to land it on the main lane, so the wrong agent did the work.
        const target = sug.lane ?? MAIN_LANE;
        if (target !== MAIN_LANE && !state.lanes.some((l) => l.id === target)) return fail("That agent isn't in this session any more.");
        const hostOnly = hostOnlyCommand(state, target, m.id, sug.text);
        if (hostOnly) return fail(hostOnly);
        const once = `sug:${sid}:${sug.seq}`;
        if (!(await claimOnce(once))) return fail("Someone already sent or put aside that suggestion.");
        const r = await this.store.append(
          sid,
          actor,
          {
            type: "instruction",
            text: sug.text,
            interrupt: false,
            fromSuggestion: sug.seq,
            ...(sug.attachments?.length ? { attachments: sug.attachments } : {}),
          },
          { expectDriver: m.id, lane: target },
        );
        if (!r.ok) await release(once);
        if (r.ok) this.wake(sid, target);
        return r.ok ? ok(r.seq) : fail(`Only the current driver can do that (driving now: ${nameOf(r.driver, state, driverOf(state, target)?.name ?? "nobody")}).`);
      }

      case "engine.expect": {
        if (!ENGINE_TOOLS.includes(cmd.tool)) return fail("Unknown coding agent.");
        if (!canDriveLane(state, m.id, lane)) return deny("run a coding agent there");
        const cur = state.engines[lane];
        if (cur?.online) return fail(`${cur.hostName}'s ${engineName(cur.tool)} is already running that agent.`);
        // A held engine is still its host's: reserving over it would let anyone who can steer attach as its host.
        const held = laneHeld(cur, m.id);
        if (held) return fail(held);
        const reset = effortResets(state, lane, { tool: cmd.tool, hostId: m.id });
        const r = await append({ type: "engine.expected", tool: cmd.tool, hostId: m.id, hostName: m.name, ...(reset ? { effortReset: true as const } : {}) });
        return r.ok ? ok(r.seq) : fail("Could not reserve that agent's place.");
      }

      case "folder.restore": {
        if (!this.folder) return fail("This session has no folder to undo in.");
        if (!/^[0-9a-f]{40}$/.test(String(cmd.sha))) return fail("That isn't a checkpoint.");
        // Same people who can stop a run: undo is how you stop one after the fact.
        if (!owner && laneDriver?.id !== m.id) return fail(`Only the driver or an owner can undo changes (driving now: ${driverName}).`);
        // Undoing under a run that is still writing would put back files the
        // agent then overwrites, and leave the room with no idea which won.
        if (state.run.status === "running" || Object.values(state.laneRuns).some((r) => r.status === "running")) return fail("Stop the run first, then undo.");
        // A rewind names a message, and the checkpoint has to be the one taken for it: nobody rewinds to a stray id.
        let rewoundTo: number | undefined;
        /** Every file back to the checkpoint, not only what its run changed: a rewind to a message, of everything after it. */
        let whole = false;
        if (cmd.rewindTo !== undefined) {
          const at = Number(cmd.rewindTo);
          if (!Number.isInteger(at) || checkpointBefore(await this.store.events(sid), at) !== cmd.sha) return fail("That message has no checkpoint to go back to.");
          // A coding tool keeps its own conversation, which a rewind here cannot reach: its files go back to before the message,
          // and the conversation stays as it is, in the log and in the tool (Arun, 2026-10-26: rewind for the coding tools too).
          if (state.engines[lane]?.tool) whole = true;
          else rewoundTo = at;
        }
        // Only what that run changed, when its end was saved: what the person did since, in other files, is left alone.
        const until = runEndAfter(await this.store.events(sid), lane, cmd.sha);
        const r = await folderAt({ op: "restore", ref: cmd.sha, ...(until && rewoundTo === undefined && !whole ? { until } : {}) });
        const done = parseJson<{ undo?: string; after?: string | null; restored?: number; removed?: number; error?: string }>(r.output);
        if (!done?.undo) return fail(done?.error ?? (r.output || "Couldn't undo that."));
        const after = typeof done.after === "string" && /^[0-9a-f]{40}$/.test(done.after) ? done.after : undefined;
        const a = await append({ type: "folder.restored", sha: cmd.sha, undo: done.undo, restored: done.restored ?? 0, removed: done.removed ?? 0, ...(rewoundTo !== undefined ? { rewoundTo } : {}), ...(after ? { after } : {}) });
        return a.ok ? ok(a.seq) : fail("Undone, but it couldn't be recorded.");
      }

      case "folder.run": {
        if (!this.folder) return fail("This session has no folder to run anything in.");
        if (!owner && laneDriver?.id !== m.id) return fail(`Only the driver or an owner can run commands (driving now: ${driverName}).`);
        const command = String(cmd.command ?? "").trim();
        if (!command) return fail("Give a command to run.");
        // A person's own command (the checks step, the Terminal tab): their press is the yes a Manual machine waits for.
        const r = await folderAt({ op: "shell", command: command.slice(0, 2000), approved: true, approvedBy: m.id });
        // The machine answers with the command, its status and its output; a
        // refusal (plan-only mode, no machine) has no status line at all.
        const ran = /^\$ /.test(r.output);
        const isError = ran && !/^\(exited 0\)$/m.test(r.output);
        if (!ran) return fail(r.output || "Couldn't run that.");
        // The end of a long output is where the summary and the error are, so that is what is kept, with a little of the start.
        const output = r.output.length > 20_000 ? `${r.output.slice(0, 3_000)}\n\n[…${r.output.length - 20_000} characters left out of the middle]\n\n${r.output.slice(-17_000)}` : r.output;
        const a = await append({ type: "folder.ran", command, output, ...(isError ? { isError: true } : {}) });
        return a.ok ? ok(a.seq) : fail("It ran, but it couldn't be recorded.");
      }

      case "folder.write": {
        if (!this.folder) return fail("This session has no folder to edit.");
        if (!owner && laneDriver?.id !== m.id) return fail(`Only the driver or an owner can edit files (driving now: ${driverName}).`);
        const filePath = String(cmd.path ?? "").trim();
        if (!filePath) return fail("Which file?");
        const content = typeof cmd.content === "string" ? cmd.content : "";
        if (content.length > 400_000) return fail("That file is too big to save from here.");
        const r = await folderAt({ op: "write", path: filePath, content });
        // The folder answers in a sentence; anything that isn't a write is the reason it refused.
        const wrote = /^(Created|Rewrote) /.exec(r.output);
        if (!wrote) return fail(r.output || "Couldn't save that file.");
        const a = await append({ type: "folder.edited", path: filePath, bytes: content.length, ...(wrote[1] === "Created" ? { created: true } : {}) });
        return a.ok ? ok(a.seq) : fail("Saved, but it couldn't be recorded.");
      }

      case "folder.switch": {
        if (!this.folder) return fail("This session has no folder to switch.");
        if (!owner && laneDriver?.id !== m.id) return fail(`Only the driver or an owner can switch branches (driving now: ${driverName}).`);
        if (state.run.status === "running" || Object.values(state.laneRuns).some((r) => r.status === "running")) return fail("Wait for the run to finish, then switch.");
        const branch = String(cmd.branch ?? "").trim().slice(0, 100);
        if (!branch) return fail("Which branch?");
        const before = parseJson<{ current?: string }>((await folderAt({ op: "branches" })).output)?.current ?? "";
        const said = (await folderAt({ op: "switch", branch, create: !!cmd.create })).output;
        const r = parseJson<{ branch?: string; error?: string }>(said);
        if (!r?.branch) return fail(r?.error ?? unparsed(said, "Couldn't switch branch."));
        const a = await append({ type: "folder.switched", branch: r.branch, from: before });
        return a.ok ? ok(a.seq) : fail("Switched, but it couldn't be recorded.");
      }

      case "folder.apply": {
        if (!this.folder) return fail("This session has no folder to bring changes into.");
        if (!state.engines[lane]?.copyOf) return fail("That agent isn't working in a separate copy.");
        if (!owner && laneDriver?.id !== m.id) return fail(`Only the driver or an owner can bring changes over (driving now: ${driverName}).`);
        if (runOf(state, lane).status === "running") return fail("Wait for the run to finish, then apply.");
        const said = (await folderAt({ op: "apply" })).output;
        const r = parseJson<{ files?: string[]; conflicts?: string[]; into?: string; error?: string }>(said);
        if (!r?.files) return fail(r?.error ?? unparsed(said, "Couldn't bring the changes over."));
        if (!r.files.length) return fail("There's nothing new to bring over.");
        const a = await append({ type: "folder.applied", files: r.files.length, into: r.into ?? state.engines[lane]!.copyOf!, ...(r.conflicts?.length ? { conflicts: r.conflicts.slice(0, 50) } : {}) });
        return a.ok ? ok(a.seq) : fail("Brought over, but it couldn't be recorded.");
      }

      case "folder.git": {
        if (!this.folder) return fail("This session has no folder.");
        if (!owner && laneDriver?.id !== m.id) return fail(`Only the driver or an owner can work the folder's git (driving now: ${driverName}).`);
        const busy = state.run.status === "running" || Object.values(state.laneRuns).some((r) => r.status === "running");
        // Staging changes no file, so it is fine mid-run; throwing changes away or pulling under a working agent is not.
        if (busy && (cmd.action === "discard" || cmd.action === "pull")) return fail("Wait for the run to finish first.");
        const paths = Array.isArray(cmd.paths) ? cmd.paths.map((f) => String(f)).filter((f) => f && !f.startsWith("-") && !f.includes("..")).slice(0, 500) : undefined;
        const call: RepoCall =
          cmd.action === "hunk" ? { op: "hunk", patch: String(cmd.patch ?? "").slice(0, 200_000), cached: !!cmd.cached, reverse: !!cmd.reverse }
          : cmd.action === "pull" ? { op: "pull" }
          : cmd.action === "discard" ? { op: "discard", paths: paths ?? [], untracked: !!cmd.untracked }
          : { op: cmd.action, paths: paths ?? [] };
        const gitDir = typeof cmd.dir === "string" && cmd.dir.trim() && !cmd.dir.includes("..") ? cmd.dir.trim().slice(0, 1000) : undefined;
        const said = (await folderAt(gitDir ? { ...call, dir: gitDir } : call)).output;
        const r = parseJson<Record<string, unknown> & { error?: string }>(said);
        if (!r || r.error) return fail(r?.error ?? unparsed(said, "That didn't work."));
        // Thrown away or pulled: said in the room, since the files everyone reads changed by a hand, not an agent.
        if (cmd.action === "discard" || cmd.action === "pull") {
          const a = await append({ type: "folder.git", action: cmd.action, ...(paths?.length ? { paths: paths.slice(0, 50) } : {}), ...(typeof r.output === "string" && r.output ? { note: String(r.output).slice(0, 500) } : {}) });
          return a.ok ? ok(a.seq) : fail("Done, but it couldn't be recorded.");
        }
        return ok(0);
      }

      case "folder.commit": {
        if (!this.folder) return fail("This session has no folder to commit.");
        if (!owner && laneDriver?.id !== m.id) return fail(`Only the driver or an owner can commit (driving now: ${driverName}).`);
        if (state.run.status === "running" || Object.values(state.laneRuns).some((r) => r.status === "running")) return fail("Wait for the run to finish, then commit.");
        const message = String(cmd.message ?? "").trim().slice(0, 5000);
        if (!message) return fail("Write a commit message first.");
        const branch = typeof cmd.branch === "string" && cmd.branch.trim() ? cmd.branch.trim().slice(0, 100) : undefined;
        // Naming files is the difference between a commit and a snapshot: a run
        // usually touches more than the one thing worth recording.
        const only = Array.isArray(cmd.only) ? cmd.only.map((f) => String(f)).filter((f) => f && !f.startsWith("-") && !f.includes("..")).slice(0, 500) : undefined;
        const dir = typeof cmd.dir === "string" && cmd.dir.trim() && !cmd.dir.includes("..") ? cmd.dir.trim().slice(0, 1000) : undefined;
        const said = (await folderAt({ op: "commit", message, ...(branch ? { branch } : {}), ...(only?.length ? { only } : {}), ...(dir ? { dir } : {}) })).output;
        const c = parseJson<{ sha?: string; branch?: string; files?: number; error?: string }>(said);
        if (!c?.sha) return fail(c?.error ?? unparsed(said, "Couldn't commit."));

        const body: Extract<EventBody, { type: "folder.committed" }> = { type: "folder.committed", sha: c.sha, branch: c.branch ?? "", message, files: c.files ?? 0 };
        // The commit stands even if the push doesn't: it is recorded either
        // way, with the reason, so nobody has to guess what state it is in.
        if (cmd.push || cmd.pr) {
          // A pull request carries the session's own account of why it exists:
          // the goal, what was decided, who steered, and whether it was checked.
          const why = cmd.pr ? prBodyFor(state, await this.store.events(sid), this.appUrl ? `${this.appUrl.replace(/\/$/, "")}/?session=${sid}` : undefined, await this.replayForPr(sid, state, folderAt)) : "";
          // Pressed for by a person, so a Manual machine pushes too.
          const base = cmd.pr && typeof cmd.base === "string" && cmd.base.trim() && !cmd.base.startsWith("-") ? cmd.base.trim().slice(0, 100) : undefined;
          const said = (await folderAt({ op: "publish", message: why ? `${message}\n\n${why}` : message, pr: !!cmd.pr, approved: true, approvedBy: m.id, ...(base ? { base } : {}), ...(dir ? { dir } : {}) })).output;
          const p = parseJson<{ pushed?: boolean; prUrl?: string; prCreated?: boolean; prError?: string; error?: string; base?: string }>(said);
          if (p?.pushed) {
            Object.assign(body, { pushed: true, ...(p.prUrl ? { prUrl: p.prUrl, prCreated: !!p.prCreated, ...(p.base ? { base: p.base } : {}) } : {}) });
            // Pushed, but no pull request: said with gh's reason, beside GitHub's own page for opening one.
            if (cmd.pr && !p.prCreated) body.error = `Pushed, but the pull request couldn't be opened from here${p.prError ? `: ${p.prError}` : ""}.${p.prUrl ? " The link opens GitHub's page to do it." : ""}`;
          } else body.error = p?.error ?? (!p && said ? said.slice(0, 500) : "Committed, but it couldn't be pushed.");
        }
        const a = await append(body);
        return a.ok ? ok(a.seq) : fail("Committed, but it couldn't be recorded.");
      }

      case "engine.release": {
        const cur = state.engines[lane];
        if (!cur) return fail("No coding tool is attached to that agent.");
        // Whoever's machine it is, whoever is steering it, or an owner.
        if (!owner && cur.hostId !== m.id && laneDriver?.id !== m.id) return fail("Only the host, the driver or an owner can hand that agent back.");
        const r = await append({ type: "engine.detached", reason: "released", tool: cur.tool });
        if (r.ok) this.wake(sid, lane);
        return r.ok ? ok(r.seq) : fail("Could not hand that agent back.");
      }

      case "control.request": {
        if (!canDriveLane(state, m.id, lane)) return deny("take control of that agent");
        if (laneDriver?.id === m.id) return fail("You're already driving.");
        if (!laneDriver) return this.handle(sid, m, { type: "control.claim", lane });
        // A lane can set its own handoff mode; the main lane uses the session's.
        const mode = laneOf(state, lane)?.controlMode ?? state.options.controlMode;
        if (mode === "takeover") {
          // Hard takeover: no approval step, but still a compare-and-set on the
          // current driver, so two simultaneous grabs resolve to one winner.
          const r = await append(
            { type: "control.granted", to: m.id, toName: m.name, reason: "takeover" },
            { expectDriver: laneDriver.id, setDriver: { id: m.id, name: m.name } },
          );
          return r.ok ? ok(r.seq) : fail(`${nameOf(r.driver, state, "Someone")} took control first.`);
        }
        if (state.pendingRequests.some((p) => p.id === m.id && p.lane === lane)) return fail("You've already asked for control.");
        const r = await append({ type: "control.requested" });
        return r.ok ? ok(r.seq) : fail("Could not request control.");
      }

      case "role.request": {
        // Only someone watching asks: anyone else can already edit, or is an owner.
        if (role !== "viewer") return fail("You can already edit this session.");
        if ((state.roleRequests ?? []).some((r) => r.id === m.id)) return fail("You've already asked. An owner sees it when they're here.");
        const r = await append({ type: "role.requested" });
        return r.ok ? ok(r.seq) : fail("Could not ask.");
      }

      case "role.decline": {
        if (!(state.roleRequests ?? []).some((r) => r.id === cmd.userId)) return fail("No request from that person.");
        const r = await append({ type: "role.declined", userId: cmd.userId });
        return r.ok ? ok(r.seq) : fail("Could not answer that.");
      }

      case "control.claim": {
        if (!canDriveLane(state, m.id, lane)) return deny("take control of that agent");
        const r = await append(
          { type: "control.granted", to: m.id, toName: m.name, reason: "claim" },
          { expectDriver: "", setDriver: { id: m.id, name: m.name } },
        );
        return r.ok ? ok(r.seq) : fail(`${nameOf(r.driver, state, "Someone")} took control first.`);
      }

      case "control.yield": {
        if (cmd.to) {
          const target = state.members[cmd.to];
          if (!target || target.removed) return fail("That person isn't in this session.");
          if (!canDriveLane(state, cmd.to, lane)) return fail(`${target.name} can't take control of that agent.`);
          return asDriver(
            await append(
              { type: "control.granted", to: cmd.to, toName: target.name, reason: "yield" },
              { expectDriver: m.id, setDriver: { id: cmd.to, name: target.name } },
            ),
          );
        }
        return asDriver(
          await append({ type: "control.released", from: m.id, reason: "yield" }, { expectDriver: m.id, setDriver: { id: "", name: "" } }),
        );
      }

      case "control.deny": {
        // Their ask for this lane, answered by this lane's driver: driving one agent is no say over who drives another.
        if (!state.pendingRequests.some((p) => p.id === cmd.to && p.lane === lane)) return fail("No pending request from that person.");
        return asDriver(await append({ type: "control.denied", to: cmd.to }, { expectDriver: m.id }));
      }

      // The wheel taken without asking: the session's owner, or whoever's own computer this coding tool runs on, since it is
      // their machine and their agent (Arun, 2026-10-23: "add a force take over option for the coding tools in multiplayer").
      case "control.force": {
        if (!owner && state.engines[lane]?.hostId !== m.id) return deny(OWNER_VERBS[cmd.type] ?? "force a takeover");
        if (!canDriveLane(state, m.id, lane)) return deny("take control of that agent");
        if (laneDriver?.id === m.id) return fail("You're already driving.");
        const r = await append({ type: "control.granted", to: m.id, toName: m.name, reason: "force" }, { setDriver: { id: m.id, name: m.name } });
        return r.ok ? ok(r.seq) : fail("Could not take control.");
      }

      // Stop: the task under way ends and the agent stays free for the next one (projection.ts), its queue kept.
      case "run.pause": {
        if (laneRun.status !== "running") return fail("The agent isn't running.");
        return asDriver(await append({ type: "run.pause" }, { expectDriver: owner ? undefined : m.id, bumpEpoch: true }));
      }

      // Only a log from before Stop replaced Pause could hold a paused run, and it reads as idle now: kept for an old page's button.
      case "run.resume": {
        if (laneRun.status !== "paused") return fail("The agent isn't paused.");
        // Resumed with its coding tool offline, it showed as thinking with nothing there to think, and stayed that way.
        const tool = state.engines[lane];
        if (tool?.tool && !tool.online) return fail(`${engineName(tool.tool)} is offline. Reconnect it, then resume.`);
        const r = await append({ type: "run.resume" }, { expectDriver: m.id });
        // A coding tool has no turn to pick up again: the pause stopped it. It is given one, to carry on where it left off;
        // without it the run was marked done with nothing run, and whatever the pause cut short was left undone.
        if (r.ok && state.engines[lane]?.tool && !pendingFor(state, lane).length) {
          await append({ type: "instruction", text: "[session] Carry on where you left off.", interrupt: false }, { expectDriver: m.id });
        }
        // The agent that was paused, not whichever one is the main lane: waking the wrong lane left a resumed
        // agent marked as running with nobody running it.
        if (r.ok) this.wake(sid, lane);
        return asDriver(r);
      }

      // Approving a plan gives the agent its hands back, and says so in words it will read.
      case "plan.approve": {
        if (!state.options.planFirst) return fail("This session isn't in plan-first mode.");
        const so = signoffStatus(state, lane, m.id);
        if (!so.ready) {
          if (so.changes.length) return fail(`${so.changes.map((c) => c.name).join(" and ")} asked for changes to the plan first.`);
          const more = so.need - so.have;
          return fail(`This plan needs ${more} more teammate${more === 1 ? "" : "s"} to sign off before it goes ahead.`);
        }
        // The approver may change the plan before letting it go: what is approved is then their version, in their order.
        let edited: string[] | undefined;
        if (cmd.steps !== undefined) {
          if (!Array.isArray(cmd.steps)) return fail("The plan is a list of steps.");
          edited = cmd.steps.map((x) => clean(x).slice(0, 300)).filter(Boolean).slice(0, 20);
          if (!edited.length) return fail("A plan needs at least one step.");
        }
        const r = await append({ type: "plan.approved", ...(edited ? { steps: edited } : {}) }, { expectDriver: owner ? undefined : m.id });
        if (!r.ok) return asDriver(r);
        const text = edited
          ? `[session] ${m.name} approved the plan with changes. Carry out this version, in this order, and do not go back to your earlier one:\n${edited.map((x, i) => `${i + 1}. ${x}`).join("\n")}`
          : "[session] The plan is approved. Go ahead and carry it out.";
        const said = await append({ type: "instruction", text, interrupt: false }, { expectDriver: owner ? undefined : m.id });
        if (said.ok) this.wake(sid, lane);
        return said.ok ? ok(r.seq) : asDriver(said);
      }

      case "plan.review": {
        if (!state.options.planFirst) return fail("This session isn't in plan-first mode.");
        if (role === "viewer") return deny("review the plan");
        if (cmd.verdict !== "approve" && cmd.verdict !== "changes") return fail("A review says the plan is fine or needs changes.");
        if ((state.planApproved[lane] ?? 0) > laneRun.sinceSeq) return fail("That plan is already approved.");
        const note = clean(cmd.note).slice(0, 500);
        const r = await append({ type: "plan.reviewed", verdict: cmd.verdict, ...(note ? { note } : {}) });
        return r.ok ? ok(r.seq) : fail("Could not record that.");
      }

      case "pr.feedback": {
        const events = await this.store.events(sid);
        const prUrl = [...events].reverse().find((e) => e.body.type === "folder.committed" && e.body.prUrl && e.body.prCreated !== false && !e.body.error)?.body;
        const url = (prUrl && prUrl.type === "folder.committed" ? prUrl.prUrl : undefined) ?? state.options.pr?.url;
        if (!url) return fail("There's no pull request from this session yet.");
        if (!this.folder) return fail("There's no folder attached to read the pull request from.");
        if (!laneDriver && canDriveLane(state, m.id, lane)) {
          const claim = await append({ type: "control.granted", to: m.id, toName: m.name, reason: "claim" }, { expectDriver: "", setDriver: { id: m.id, name: m.name } });
          if (!claim.ok) return fail(`${nameOf(claim.driver, state, driverName)} just took control.`);
        } else if (laneDriver?.id !== m.id) return deny("pass review comments to the agent");
        const seen = events.flatMap((e) => (e.body.type === "pr.feedback" ? e.body.ids : []));
        const got = parseJson<{ comments?: PrComment[]; error?: string }>((await folderAt({ op: "prcomments", query: url })).output);
        if (!got?.comments) return fail(got?.error ?? "Couldn't read the pull request.");
        const fresh = unseen(got.comments, seen);
        if (!fresh.length) return fail("No new comments on the pull request.");
        // Every new one is marked seen, so a held-back comment isn't reported again on the next press; only writers' go on.
        const send = fresh.filter(fromWriter);
        const held = fresh.length - send.length;
        const logged = await append({ type: "pr.feedback", prUrl: url, ids: fresh.map((c) => c.id), count: send.length, ...(held ? { held } : {}) });
        if (!logged.ok) return fail("Could not record the comments.");
        if (!send.length) return ok(logged.seq);
        const said = await append({ type: "instruction", text: feedbackText(send, url), interrupt: false }, { expectDriver: m.id });
        if (said.ok) this.wake(sid, lane);
        return said.ok ? ok(said.seq) : asDriver(said);
      }

      // The pull request's failing checks, logs and all, handed to the agent as one instruction. Nothing is deduplicated:
      // a person presses this after a push, and the failures then are the ones they mean.
      case "pr.checks": {
        const events = await this.store.events(sid);
        const prUrl = [...events].reverse().find((e) => e.body.type === "folder.committed" && e.body.prUrl && e.body.prCreated !== false && !e.body.error)?.body;
        const url = (prUrl && prUrl.type === "folder.committed" ? prUrl.prUrl : undefined) ?? state.options.pr?.url;
        if (!url) return fail("There's no pull request from this session yet.");
        if (!this.folder) return fail("There's no folder attached to read the pull request from.");
        if (!laneDriver && canDriveLane(state, m.id, lane)) {
          const claim = await append({ type: "control.granted", to: m.id, toName: m.name, reason: "claim" }, { expectDriver: "", setDriver: { id: m.id, name: m.name } });
          if (!claim.ok) return fail(`${nameOf(claim.driver, state, driverName)} just took control.`);
        } else if (laneDriver?.id !== m.id) return deny("hand the failing checks to the agent");
        const got = parseJson<{ failures?: CheckFailure[]; pending?: number; error?: string }>((await folderAt({ op: "prchecks", query: url })).output);
        if (!got?.failures) return fail(got?.error ?? "Couldn't read the pull request's checks.");
        if (!got.failures.length) return fail(got.pending ? `Nothing has failed; ${got.pending} check${got.pending === 1 ? " is" : "s are"} still running.` : "All the checks are passing.");
        const said = await append({ type: "instruction", text: checksText(got.failures, url), interrupt: false }, { expectDriver: m.id });
        if (said.ok) this.wake(sid, lane);
        return said.ok ? ok(said.seq) : asDriver(said);
      }

      // Seeing it through to merge: Friday watches the pull request, hands red checks and new comments to the agent, and pushes
      // what it fixes. The loop runs in the app; this is the person saying go, or stop. Pushing is theirs to allow, as committing is.
      case "pr.shepherd": {
        if (!owner && laneDriver?.id !== m.id) return fail("Only the driver or an owner can hand the pull request to Friday.");
        if (!cmd.on) {
          if (!state.shepherd) return ok(state.lastSeq);
          const off = await append({ type: "pr.shepherd", on: false, prUrl: state.shepherd.prUrl });
          return off.ok ? ok(off.seq) : fail("Could not record that.");
        }
        const events = await this.store.events(sid);
        const last = [...events].reverse().find((e) => e.body.type === "folder.committed" && e.body.prUrl && e.body.prCreated !== false && !e.body.error)?.body;
        const url = (last && last.type === "folder.committed" ? last.prUrl : undefined) ?? state.options.pr?.url;
        if (!url) return fail("There's no pull request from this session yet.");
        if (!this.folder) return fail("There's no folder attached to push fixes from.");
        if (state.shepherd?.prUrl === url) return ok(state.lastSeq);
        const on = await append({ type: "pr.shepherd", on: true, prUrl: url });
        return on.ok ? ok(on.seq) : fail("Could not record that.");
      }

      // Out of usage until a time: whoever may steer the agent can have it carry on then, and call that off again.
      case "resume.at":
      case "resume.cancel": {
        if (laneDriver?.id !== m.id && !canDriveLane(state, m.id, lane)) return fail("You can't steer this agent.");
        if (cmd.type === "resume.cancel") {
          if (!state.resumes[lane]) return ok(state.lastSeq);
          const r = await append({ type: "resume.cancelled" });
          return r.ok ? ok(r.seq) : fail("Could not record that.");
        }
        const at = Math.floor(Number(cmd.at));
        if (!Number.isFinite(at) || at < Date.now() - 60_000 || at > Date.now() + 8 * 86_400_000) return fail("Pick a time in the next week.");
        const r = await append({ type: "resume.scheduled", at });
        return r.ok ? ok(r.seq) : fail("Could not record that.");
      }

      case "pin.add":
      case "pin.remove": {
        if (!owner && laneDriver?.id !== m.id) return fail("Only the driver or an owner can pin files.");
        // A path inside the folder: no climbing out, no drive letters, nothing long.
        const path = String(cmd.path ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "").slice(0, 300);
        if (!path || path.split("/").includes("..") || /^[a-zA-Z]:/.test(path)) return fail("That isn't a path inside the folder.");
        if (cmd.type === "pin.add") {
          if (state.pins.includes(path)) return ok(state.lastSeq);
          if (state.pins.length >= 8) return fail("Eight pins is the most. Unpin one first.");
        } else if (!state.pins.includes(path)) return ok(state.lastSeq);
        const r = await append(cmd.type === "pin.add" ? { type: "pin.added", path } : { type: "pin.removed", path });
        return r.ok ? ok(r.seq) : fail("Could not change the pins.");
      }

      case "run.cancel": {
        if (laneRun.status === "idle") return fail("Nothing is running.");
        return asDriver(await append({ type: "run.cancel" }, { expectDriver: owner ? undefined : m.id, bumpEpoch: true }));
      }

      /**
       * A teammate's yes or no to a command an agent is waiting on.
       *
       * The driver of a lane has always been able to answer, by writing to it. This is for everyone else: an owner can say which
       * kinds of command editors may approve ("tests and checks, not deploys"), and an editor may then answer exactly those. Each
       * command is classified on the server, so what the page says it is does not matter, and a line is approvable only if every
       * part of it is.
       */
      case "approval.answer": {
        const ask = state.approvals[lane];
        if (!ask || ask.id !== cmd.id) return fail("That request was already answered, or isn't waiting any more.");
        // Nobody driving and you could: you answer without taking the wheel (answering a card is not steering).
        const iDrive = laneDriver?.id === m.id || (!laneDriver && canDriveLane(state, m.id, lane));
        // The host of the Manual machine it would run on answers for it, driving or not: nobody else can say yes there.
        const machine = liveMachine(state, lane) ?? state.engines[lane];
        const myMachine = machine?.mode === "edits" && machine.hostId === m.id;
        if (!iDrive && !owner && !myMachine) {
          const allowedKinds = role === "editor" ? state.options.approve.editor : [];
          if (!allowedKinds.length) return deny("answer for an agent you're not driving");
          if (ask.scope !== "commands" || !ask.items.length) return fail(`Only ${laneDriver?.name ?? "the driver"} can answer this one: it isn't about a single command.`);
          const blocked = ask.items.find((i) => !mayApprove(allowedKinds, i));
          if (blocked) return fail(`You can approve ${allowedKinds.length === 1 ? "that kind" : "those kinds"} of command, but this one is ${CLASS_LABEL[headlineClass(blocked)].label.toLowerCase()}. ${laneDriver?.name ?? "The driver"} or an owner needs to answer it.`);
        }
        const approve = cmd.approve === true;
        const notYours = approve ? hostsYes(state, lane, m.id) : null;
        if (notYours) return fail(notYours);
        const answered = `answered:${sid}:${ask.id}`;
        if (!(await claimOnce(answered))) return fail("That request was already answered.");
        const r = await append({ type: "instruction", text: approve ? "Yes, run it." : "No, don't.", interrupt: false, approval: { id: ask.id, approve } });
        if (!r.ok) await release(answered);
        if (r.ok) this.wake(sid, lane);
        return r.ok ? ok(r.seq) : fail("Could not record that.");
      }

      // Taking a message back before the agent has read it: its author, the person driving that agent, or an owner.
      case "hub.plan": {
        if (!this.hubs) return fail("Hubs aren't available here.");
        const r = await this.hubs.plan(sid, clean(cmd.text), m);
        return r.ok ? ok(state.lastSeq) : fail(r.error);
      }
      case "hub.approve": {
        if (!this.hubs) return fail("Hubs aren't available here.");
        const edits = Array.isArray(cmd.tasks) ? cmd.tasks.filter((t) => t && typeof t.id === "string").map((t) => ({ id: t.id, ...(t.tool && ENGINE_TOOLS.includes(t.tool) ? { tool: t.tool } : {}) })) : undefined;
        const r = await this.hubs.approve(sid, String(cmd.id), edits);
        return r.ok ? ok(state.lastSeq) : fail(r.error);
      }
      case "hub.cancel": {
        if (!this.hubs) return fail("Hubs aren't available here.");
        const r = await this.hubs.cancel(sid, String(cmd.id));
        return r.ok ? ok(state.lastSeq) : fail(r.error);
      }

      case "board.task": {
        // Anyone who works in the session steers the team's work, as they can pause its talk.
        if (role === "viewer") return deny("change the team's tasks");
        if (!this.board) return fail("The task board isn't available here.");
        if (!["reassign", "retry", "sendback", "cancel"].includes(String(cmd.action))) return fail("Unknown action.");
        const r = await this.board.control(sid, actor, { id: String(cmd.id ?? "").slice(0, 40), action: cmd.action, ...(typeof cmd.to === "string" && cmd.to ? { to: cmd.to.slice(0, 80) } : {}), ...(typeof cmd.note === "string" && cmd.note ? { note: cmd.note.slice(0, 2000) } : {}) });
        return r.ok ? ok((await this.store.state(sid)).lastSeq) : fail(r.error);
      }

      case "mesh.pause": {
        // Agent talk is never paused (Arun, 2026-10-20: "do not pause agent to agent talking too ever"): every agent stays
        // reachable by the others. Stop one agent's task instead. An old page's Resume still wakes whatever a pause had held.
        if (role === "viewer") return deny("change the agents talking to each other");
        if (cmd.on) return fail("Agent talk can't be paused: the agents always stay reachable. Stop an agent's task instead.");
        if (!state.mesh?.paused) return ok(state.lastSeq);
        // Said in the log too, which a coding tool's lane hears and goes through its queue on.
        const r = await this.store.append(sid, actor, { type: "mesh.paused", on: false }, { lane: MAIN_LANE });
        if (!r.ok) return fail("Couldn't do that.");
        const msgs = state.mesh.msgs;
        for (const l of [MAIN_LANE, ...state.lanes.map((x) => x.id)]) if ((l === MAIN_LANE ? state.pendingInstructions : (state.lanePending[l] ?? [])).some((q) => msgs.includes(q))) this.wake(sid, l);
        return ok(r.seq);
      }

      case "peer.settle": {
        // Only someone who could have written to this agent themselves decides whether another session's message reaches it.
        if (laneDriver?.id !== m.id && !canDriveLane(state, m.id, lane)) return fail("Only someone who can steer this agent can let a message through.");
        const events = await this.store.events(sid);
        const held = events.find((e) => e.body.type === "peer.held" && e.body.id === String(cmd.id) && (e.lane ?? MAIN_LANE) === lane);
        if (!held || held.body.type !== "peer.held") return fail("That message isn't waiting here.");
        const id = held.body.id;
        if (events.some((e) => e.body.type === "peer.settled" && e.body.id === id)) return fail("Someone already dealt with that message.");
        if (cmd.deliver) {
          const r = await append({ type: "instruction", text: held.body.text, interrupt: false, peer: { ...held.body.from, approvedBy: m.name } });
          if (!r.ok) return fail("Couldn't deliver it.");
          this.wake(sid, lane);
        }
        const r = await append({ type: "peer.settled", id, delivered: !!cmd.deliver });
        return r.ok ? ok(r.seq) : fail("Couldn't do that.");
      }

      case "instruction.withdraw": {
        const seq = Number(cmd.seq);
        if (!Number.isInteger(seq) || !pendingFor(state, lane).includes(seq)) return fail("That message has already been delivered, or was taken back.");
        const target = (await this.store.events(sid)).find((e) => e.seq === seq);
        if (!target || target.body.type !== "instruction") return fail("That isn't a message.");
        if (target.actor.id !== m.id && !owner && laneDriver?.id !== m.id) return deny("take back someone else's message");
        const r = await append({ type: "instruction.withdrawn", seq });
        return r.ok ? ok(r.seq) : fail("Could not take it back.");
      }

      case "run.interrupt": {
        if (laneRun.status !== "running") return fail("The agent isn't running.");
        // This lane's queue: the main one's said "Nothing is queued" to every other agent with messages waiting.
        if (!pendingFor(state, lane).length) return fail("Nothing is queued.");
        return asDriver(await append({ type: "run.interrupt" }, { expectDriver: m.id, bumpEpoch: true }));
      }

      case "settings.update": {
        const options: SessionOptionsPatch = {};
        if (cmd.controlMode === "ask" || cmd.controlMode === "takeover") options.controlMode = cmd.controlMode;
        if (typeof cmd.webSearch === "boolean") options.webSearch = cmd.webSearch;
        if (typeof cmd.planFirst === "boolean") options.planFirst = cmd.planFirst;
        if (typeof cmd.signoff === "number" && Number.isFinite(cmd.signoff)) options.signoff = Math.min(3, Math.max(0, Math.round(cmd.signoff)));
        if (typeof cmd.autoTest === "boolean") options.autoTest = cmd.autoTest;
        if (typeof cmd.review === "boolean") options.review = cmd.review;
        // It publishes the whole session to whoever can read the repository: the owner's call.
        if (typeof cmd.prReplay === "boolean") {
          if (!owner) return deny("decide whether pull requests link the recording");
          options.prReplay = cmd.prReplay;
        }
        if (Array.isArray(cmd.allow)) {
          // What runs without asking is the driver's or an owner's to say: it is the same yes, given in advance.
          if (!owner && state.driver?.id !== m.id) return deny("decide what runs without asking");
          // As long as a command a person can be asked about (runtime.ts MAX_ASKED): an exact entry cut short would match nothing.
          options.allow = [...new Set(cmd.allow.filter((c): c is string => typeof c === "string").map((c) => c.trim().slice(0, 4_000)).filter(Boolean))].slice(0, 50);
        }
        if (cmd.thinking === "fast" || cmd.thinking === "balanced" || cmd.thinking === "deep") options.thinking = cmd.thinking;
        if (typeof cmd.mcp === "boolean") options.mcp = cmd.mcp;
        if (typeof cmd.private === "boolean") options.private = cmd.private;
        if (cmd.policy) {
          const policy = cleanPolicy(cmd.policy);
          if (policy) options.policy = policy;
        }
        if (cmd.approve && typeof cmd.approve === "object") {
          // Who may approve what is the owner's to say: handing out the yes for commands is handing out the machine.
          if (!owner) return deny("change who can approve commands");
          options.approve = { editor: cleanClasses(cmd.approve.editor) };
        }
        if (cmd.agentId === null) {
          options.agent = null;
          options.model = "";
        } else if (typeof cmd.agentId === "string") {
          const snap = await this.resolveAgent(m.id, cmd.agentId, state.workspaceId);
          if (!snap) return fail("You don't have access to that agent.");
          options.agent = snap;
          // An agent's model is a default, not a lock. Adopt it only when the
          // session is still running whatever the last agent defaulted to; if
          // somebody chose a model for this session, switching agent doesn't
          // quietly take it away from them.
          const inherited = await this.allowModel(state.workspaceId, state.options.agent?.model ?? "", m.id);
          if ((state.options.model ?? "") === inherited) options.model = await this.allowModel(state.workspaceId, snap.model ?? "", m.id);
        }
        if (typeof cmd.model === "string") options.model = await this.allowModel(state.workspaceId, cmd.model, m.id);
        const title = clean(cmd.title).slice(0, 120) || undefined;
        if (Object.keys(options).length === 0 && !title) return fail("Nothing to change.");
        const r = await append({ type: "session.updated", options, ...(title ? { title } : {}) });
        if (!r.ok) return fail("Could not update settings.");
        // A policy that takes the wheel away from a role takes it from whoever of that role holds one, as a role change does.
        if (options.policy) {
          const after: SessionState = { ...state, options: mergeOptions(state.options, options) };
          for (const [id, who] of Object.entries(state.members)) {
            if (who.removed || who.role === "owner") continue;
            await this.releaseWheels(sid, state, id, "revoked", (l) => !canDriveLane(after, id, l));
          }
        }
        return ok(r.seq);
      }

      // Lanes are a session-shape change, so only an owner adds or removes one.
      case "lane.add": {
        // An owner adds any lane. Anybody else who may steer here can add one for
        // their own agent — a Claude Code, Codex or Cursor signed in on their own
        // machine, under their own account — and only that: it is theirs to drive,
        // so it takes nothing from anybody else's lane.
        const mayOwn = cmd.own === true && allowed("control");
        if (roleOf(state, m.id) !== "owner" && !mayOwn) return fail("Only an owner can add an agent.");
        const name = clean(cmd.name).slice(0, 40);
        if (!name) return fail("Give the agent a name.");
        if (state.lanes.length >= SESSION_LANES) return fail(`A session runs up to ${SESSION_LANES} agents beside the main one, and this one has them all.`);
        // The plan limits Friday's own agents, which cost us something, whoever adds them. Someone's own coding tools run on their machine, any number.
        if (!cmd.engine) {
          const cap = await this.laneCap(state.workspaceId);
          const friday = state.lanes.filter((l) => !l.engine && !state.engines[l.id]?.tool).length;
          if (friday >= cap) {
            return fail("Friday's own agents aren't part of this edition: add your own Claude Code, Codex, Cursor or another coding tool instead.");
          }
        }
        const agent = cmd.agentId ? await this.resolveAgent(m.id, cmd.agentId, state.workspaceId) : null;
        if (cmd.agentId && !agent) return fail("You don't have access to that agent.");
        const control: LaneControl = roleOf(state, m.id) === "owner" ? (cmd.control ?? { kind: "open" }) : { kind: "people", people: [m.id] };
        const lane: Lane = {
          id: `l${randomBytes(4).toString("base64url")}`,
          name,
          agent,
          control,
          controlMode: cmd.controlMode === "takeover" ? "takeover" : "ask",
          // A lane nobody drives needs a trigger or it can never run at all.
          trigger: cmd.trigger ?? (control.kind === "standing" ? { kind: "lane-finished" } : { kind: "manual" }),
          ...(cmd.engine ? { engine: true } : {}),
        };
        // Deliberately unclaimed: an owner often adds an agent *for* someone
        // else, and whoever writes to it first takes the wheel anyway.
        const r = await append({ type: "lane.added", lane });
        return r.ok ? { ok: true, seq: r.seq, lane: lane.id } : fail("Could not add the agent.");
      }


      case "lane.remove": {
        const gone = state.lanes.find((l) => l.id === cmd.laneId);
        // Or a teammate's own coding-tool lane that no agent ever attached to: the one they just added, taken back when its
        // start was refused.
        const mine = !!gone?.engine && !state.engines[gone.id] && gone.control.kind === "people" && gone.control.people.length === 1 && gone.control.people[0] === m.id;
        if (roleOf(state, m.id) !== "owner" && !mine) return fail("Only an owner can remove an agent.");
        if (!gone) return fail("That agent isn't in this session.");
        const r = await append({ type: "lane.removed", laneId: cmd.laneId });
        return r.ok ? ok(r.seq) : fail("Could not remove the agent.");
      }

      case "lane.othersFull": {
        // The host's computer, the host's say: nobody else may open it up to everyone's messages, owners included.
        const host = state.engines[lane]?.hostId;
        if (!host || host !== m.id) return fail("Only the person whose computer this agent runs on can change this.");
        const r = await append({ type: "lane.othersFull", on: cmd.on === true });
        return r.ok ? ok(r.seq) : fail("Could not change it.");
      }
      // Whoever may steer this lane, and nobody else: a viewer, and everybody on a standing lane, is turned away here.
      case "lane.effort": {
        if (!canDriveLane(state, m.id, lane)) return deny("change how hard this agent thinks");
        const tool = state.engines[lane]?.tool;
        // Only a tool whose effort control was checked takes one, at its own levels, or an ACP tool at the levels it said it has
        // (not Cursor or Friday Code).
        const levels = effortLevelsOf(state.engines[lane]);
        if (!levels.length) return fail("This agent doesn't take an effort level.");
        const effort = cmd.effort === "auto" || cmd.effort === null ? null : cmd.effort;
        // Checked as a string: it came off the wire, and "ultracode", "ultra", "none" or "minimal" are not offered.
        if (effort !== null && !(levels as readonly string[]).includes(effort)) return fail("That isn't an effort level.");
        // Extra and Max spend the host's subscription: only the lane's host or an owner picks them (Arun, 2026-10-17).
        if ((effort === "xhigh" || effort === "max") && state.engines[lane]?.hostId !== m.id && roleOf(state, m.id) !== "owner")
          return fail(`Extra and Max use ${state.engines[lane]?.hostName ?? "the host"}'s plan, so only they or an owner can pick them. Up to High is yours to set.`);
        const running = laneRun.status === "running";
        const r = await append({ type: "lane.effort", effort, ...(tool ? { tool } : {}), ...(running ? { running } : {}) });
        return r.ok ? ok(r.seq) : fail("Could not change the effort.");
      }

      case "lead.set": {
        // One agent leads the others (agent-mesh.ts assign_task): set by whoever may rename an agent, on any agent here.
        const role = roleOf(state, m.id);
        if (role !== "owner" && role !== "editor") return fail("Only an owner or an editor can choose which agent leads.");
        const lane = cmd.lane === null || cmd.lane === undefined ? null : String(cmd.lane);
        if (lane !== null && lane !== MAIN_LANE && !state.lanes.some((l) => l.id === lane)) return fail("That agent isn't in this session.");
        if ((state.lead ?? null) === lane) return ok(state.lastSeq);
        const r = await append({ type: "lead.set", lane, ...(cmd.auto === true ? { auto: true as const } : {}) });
        return r.ok ? ok(r.seq) : fail("Couldn't change which agent leads.");
      }

      case "lane.rename": {
        const role = roleOf(state, m.id);
        if (role !== "owner" && role !== "editor") return fail("Only an owner or an editor can rename an agent.");
        if (cmd.laneId !== MAIN_LANE && !state.lanes.some((l) => l.id === cmd.laneId)) return fail("That agent isn't in this session.");
        // Runs of whitespace to one space (it was /s+/, which turned every "s" into a space: "Boss" became "Bo").
        let name = String(cmd.name ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
        if (!name) return fail("Give the agent a name.");
        // A racing agent is known by its name's "Race · " (Race.tsx RACE_PREFIX): renamed without it, the race would come apart.
        const was = state.lanes.find((l) => l.id === cmd.laneId)?.name ?? "";
        if (was.startsWith("Race · ") && !name.startsWith("Race · ")) name = `Race · ${name}`.slice(0, 48);
        const r = await append({ type: "lane.renamed", laneId: cmd.laneId, name });
        return r.ok ? ok(r.seq) : fail("Could not rename the agent.");
      }

      case "member.role": {
        const target = state.members[cmd.userId];
        if (!target || target.removed) return fail("That person isn't in this session.");
        if (!["owner", "editor", "viewer"].includes(cmd.role)) return fail("Unknown role.");
        if (target.role === cmd.role) return fail(`${target.name} is already ${article(cmd.role)} ${cmd.role}.`);
        if (target.role === "owner" && cmd.role !== "owner" && owners(state) <= 1) return fail("A session needs at least one owner.");
        const r = await append({ type: "member.role_changed", userId: cmd.userId, name: target.name, role: cmd.role });
        if (!r.ok) return fail("Could not change role.");
        // Someone who can no longer drive an agent shouldn't keep its wheel: every agent they hold, not only the main one.
        const after: SessionState = { ...state, members: { ...state.members, [cmd.userId]: { ...target, role: cmd.role } } };
        await this.releaseWheels(sid, state, cmd.userId, "revoked", (l) => !canDriveLane(after, cmd.userId, l));
        return ok(r.seq);
      }

      case "member.remove": {
        if (cmd.userId === m.id) return fail("You can't remove yourself.");
        const target = state.members[cmd.userId];
        if (!target || target.removed) return fail("That person isn't in this session.");
        if (target.role === "owner" && owners(state) <= 1) return fail("A session needs at least one owner.");
        const r = await append({ type: "member.removed", userId: cmd.userId, name: target.name });
        if (!r.ok) return fail("Could not remove member.");
        await this.releaseWheels(sid, state, cmd.userId, "removed", () => true);
        // Running on the removed person's own model, it would go on spending their key from their computer: back to Friday's.
        return ok(r.seq);
      }

      case "link.update": {
        if (cmd.role !== "editor" && cmd.role !== "viewer") return fail("Unknown link.");
        const cur = state.links[cmd.role];
        const enabled = typeof cmd.enabled === "boolean" ? cmd.enabled : cur.enabled;
        const version = cmd.rotate ? cur.version + 1 : cur.version;
        if (enabled === cur.enabled && version === cur.version) return fail("Nothing to change.");
        const r = await append({ type: "link.updated", role: cmd.role, enabled, version });
        return r.ok ? ok(r.seq) : fail("Could not update the link.");
      }
    }
    return fail(`Unknown command "${(cmd as { type: string }).type}"`);
  }
}

const SYSTEM: ActorRef = { id: "system", name: "System", kind: "system" };
const OWNER_VERBS: Partial<Record<Command["type"], string>> = {
  "role.decline": "answer a request to edit (owner only)",
  "hub.plan": "start a hub (owner only)",
  "hub.approve": "approve a hub's plan (owner only)",
  "hub.cancel": "cancel a hub (owner only)",
  "control.force": "force a takeover (the session's owner, or the person whose computer the agent runs on)",
  "settings.update": "change session settings (owner only)",
  "member.role": "change roles (owner only)",
  "member.remove": "remove people (owner only)",
  "link.update": "manage invite links (owner only)",
};

const ok = (seq: number): CommandResult => ({ ok: true, seq });
const fail = (error: string): CommandResult => ({ ok: false, error });
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const article = (r: string) => (r === "owner" || r === "editor" ? "an" : "a");
const clean = (t: unknown) => (typeof t === "string" ? t.trim().slice(0, MAX_TEXT) : "");
const owners = (s: SessionState) => Object.values(s.members).filter((x) => !x.removed && x.role === "owner").length;

function nameOf(id: string, state: SessionState, fallback: string) {
  if (!id) return "nobody";
  return state.members[id]?.name ?? fallback;
}

function cleanAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a): a is Attachment => !!a && typeof a.id === "string" && /^[\w-]{6,40}$/.test(a.id) && typeof a.name === "string")
    .slice(0, MAX_ATTACHMENTS)
    .map((a) => ({ id: a.id, name: String(a.name).slice(0, 120), type: String(a.type ?? "application/octet-stream").slice(0, 100), size: Number(a.size) || 0 }));
}

function cleanPolicy(p: PolicyPatch): PolicyPatch | null {
  const out: PolicyPatch = {};
  for (const role of ["editor", "viewer"] as const) {
    const src = p[role];
    if (!src) continue;
    const perms: Record<string, boolean> = {};
    for (const k of ["suggest", "control", "upload", "invite"] as const) if (typeof src[k] === "boolean") perms[k] = src[k]!;
    if (Object.keys(perms).length) out[role] = perms;
  }
  return Object.keys(out).length ? out : null;
}

/** A lane's display name, the way the room sees it. */
export function laneName(state: SessionState, laneId: string): string {
  // "Main", as the lane tabs call it: a second lane is often also Friday, and "Friday → Friday" says nothing.
  if (laneId === MAIN_LANE) return state.mainName?.trim() || (state.options.agent?.name ?? (state.engines[MAIN_LANE]?.tool ? engineName(state.engines[MAIN_LANE]!.tool!) : "Main"));
  const l = state.lanes.find((x) => x.id === laneId);
  const e = state.engines[laneId];
  return l?.name ?? (e?.tool ? engineName(e.tool) : laneId);
}

/** Only a real other lane, a stated reason, and a handful of short carried lines. */
export function cleanHandoff(state: SessionState, raw: { fromLane?: string; reason?: string; carried?: unknown }, to: string): Handoff | undefined {
  const fromLane = typeof raw.fromLane === "string" ? raw.fromLane : "";
  const exists = fromLane === MAIN_LANE || state.lanes.some((l) => l.id === fromLane);
  const reason = typeof raw.reason === "string" ? raw.reason.trim().slice(0, 600) : "";
  if (!exists || fromLane === to || !reason) return undefined;
  const carried = (Array.isArray(raw.carried) ? raw.carried : [])
    .filter((c): c is string => typeof c === "string" && !!c.trim())
    .slice(0, 8)
    .map((c) => c.trim().slice(0, 300));
  return { fromLane, fromName: laneName(state, fromLane), toName: laneName(state, to), reason, carried };
}

/**
 * What the folder said, when it wasn't the JSON asked for.
 *
 * With no machine connected the bridge answers in a sentence ("Arun's machine isn't connected right now"), which is the
 * reason a commit or a switch failed; parsing it as JSON and saying "Couldn't commit" threw the reason away.
 */
function unparsed(text: string, fallback: string): string {
  const t = text.trim();
  return t && !t.startsWith("{") ? t.slice(0, 300) : fallback;
}

function parseJson<T>(text: string): T | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as T) : null;
  } catch {
    return null;
  }
}
