import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Bus } from "./bus.js";
import { resolveTarget, type Resolved } from "./handoff.js";
import { limitHit } from "./limit-reset.js";
/** Other sessions an agent can reach (peers.ts on the hosted service; none on someone's own computer). */
export interface Peers {
  list(sid: string, lane: string): Promise<string>;
  read(sid: string, lane: string, to: string): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  send(sid: string, lane: string, req: { to: string; agent?: string; text: string }): Promise<{ ok: true; sid: string; title: string; lane: string; name: string; held: boolean; text: string } | { ok: false; error: string }>;
}
import { limitedLanes, limitedTask, limitTargets, personBehind, type Limited } from "./limit-handoff.js";
import { commandFailed, TEST_CMD } from "./receipt.js";
import { nearLimit, type ToolWindow } from "./routing.js";
import { KIND_WORDS, skillOf, strongAt, taskKind, type Skills, type TaskKind } from "./strengths.js";
import { laneName } from "./session/core.js";
import { boardBusy, canDriveLane, driverOf, laneOf, meshOf, pendingFor, readyTasks, runOf, unreadPosts, type BoardTask, type MeshAsk, type MeshPost, type SessionState } from "./session/projection.js";
import type { SessionStore } from "./session/store.js";
import { engineName, MAIN_LANE, type ActorRef, type BoardTaskDef, type EventBody, type MeshNote, type RepoCall, type SessionEvent } from "./types.js";
export { meshHead } from "./mesh-note.js";

/**
 * The agents in one session talking to each other (docs/agent-to-agent.md).
 *
 * Claude Code, Codex, Cursor, the ACP tools, a local model and Friday Code each work in their own lane. Every coding tool a
 * runner starts is given an MCP server named `friday` (runner/friday-mcp.ts) whose tools come here over the runner's own
 * connection, so the server knows which session and lane is calling; Friday Code calls the same methods directly. Each call
 * becomes events in the session's log: a message is an instruction on the other agent's lane, carrying a MeshNote, so it
 * queues, wakes an idle agent and waits for a busy one like any other instruction, and the people watching see every exchange
 * in the feed. An ask waits for its answer, which is the asked agent's last words in the turn that handled it, or what it sent
 * with reply_to_agent (Arun, 2026-10-19: "research ways for coding tools in the workspace sessions to talk to each other too").
 *
 * What stops it running away: a hop limit along a chain of agents waking agents, a cap on the back-and-forth between two of
 * them and on what one run sends, a refusal to ask an agent that is itself waiting on the asker, and a pause any person can
 * press. Hitting a limit pauses it too, for a person to look. What a message may do is what the person behind the sender could
 * do, as for a handoff.
 */

/** Past this many agent-to-agent steps in a chain (A woke B woke C…), that one message is refused. Talk itself never pauses. */
export const MAX_HOPS = 4;
/** The most of a task's diff written into a review brief for a reviewer on another computer. */
const REVIEW_DIFF = 14_000;
/** Messages and handoffs either way between two agents within PAIR_WINDOW_MS before the next one is refused. */
export const MAX_PAIR = 8;
export const PAIR_WINDOW_MS = 20 * 60_000;
/** Messages one run may send. */
export const MAX_PER_RUN = 6;
/** The lead's: it is there to hand out work and follow it, so it sends more, and more to each agent. */
export const LEAD_PER_RUN = 20;
export const LEAD_PAIR = 24;
/** The most tasks one board holds, and how many times a review may send one back before the lead or a person decides. */
export const MAX_BOARD_TASKS = 24;
export const MAX_REWORK = 2;
/** Lines changed (added and removed) up to which a task whose own tests passed goes through without a second agent's check. */
export const SMALL_CHANGE = 200;
/** How long a finished task's checks may run in its agent's folder. */
export const CHECK_SECONDS = 600;
/** A task whose agent isn't working, waiting or queued, and has been quiet this long, is handed to someone else (sweep). */
export const STALL_MS = 15 * 60_000;
/** An agent whose computer has been gone this long with a board task: the task goes to someone who is here. */
export const OFFLINE_STALL_MS = 5 * 60_000;
/** An agent still "working" that has done nothing for this long: its lead is told, once. Past the runner's own hung restart. */
export const QUIET_RUN_MS = 25 * 60_000;

/** "4 min", "1 h 20 min", for how long ago or how long something has been going. */
export const span = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 1 ? "under a minute" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
};
/** Team updates one run may post. */
export const MAX_POSTS_PER_RUN = 20;
/** How long wait_for_agent waits by default. */
export const WATCH_WAIT_MS = 5 * 60_000;
/** How long ask_agent waits by default, and at most. */
export const ASK_WAIT_MS = 4 * 60_000;
/**
 * The most an ask waits on an agent busy with other work. Its answer comes after that work unless the agent reads messages
 * mid-turn, and the asker sat idle the whole four minutes: 106 waits of 119 asks and tasks ran out in a week (Arun, 2026-10-25).
 */
export const BUSY_ASK_WAIT_MS = 90_000;
export const ASK_WAIT_MAX_MS = 15 * 60_000;
const MAX_TEXT = 8000;

const FRIDAY: ActorRef = { id: "friday", name: "Friday", kind: "system" };
const agentActor = (name: string): ActorRef => ({ id: "agent", name, kind: "agent" });
const str = (v: unknown) => (typeof v === "string" ? v : "");
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const lanesOf = (s: SessionState) => [MAIN_LANE, ...s.lanes.map((l) => l.id)];

/** An MCP tool as the `friday` server lists it (tools/list). */
export interface MeshToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface MeshResult {
  output: string;
  isError?: boolean;
  /** The tool's turn should end here (a handoff). */
  endTurn?: boolean;
  /**
   * preview_screenshot: the page for the runner to capture on its machine (in the desktop app, see desktop/capture.ts), which
   * then answers the tool with the picture. `output` is what a runner that can't is left saying.
   */
  capture?: PreviewCapture;
}

/** What preview_screenshot asks the runner to capture: a page on its own machine, at this size. */
export interface PreviewCapture {
  url: string;
  width: number;
  height: number;
  fullPage: boolean;
}

export type HandOffFn = (sid: string, from: string, req: { to: string; reason: string; carried: string[]; task: string }) => Promise<{ ok: true; toName: string; note?: string } | { ok: false; error: string }>;

const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
const TO = { type: "string", description: "The other agent's name as the session shows it (from list_agents). A recognisable part works too: \"codex\", \"review\"." };

/** The tools, as every coding tool's `friday` MCP server offers them. Friday Code has the same ones as its own tools. */
export const MESH_TOOLS: MeshToolDef[] = [
  {
    name: "list_agents",
    description: "List the other agents working in this Friday session (Claude Code, Codex, Cursor, Friday Code…): each one's name, whose it is, whether it is working, and what it last said. Also any question another agent is waiting for you to answer.",
    inputSchema: obj({}, []),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "message_agent",
    description: "Tell another agent in this session something it should know: a change of yours that affects its work, something you found, a request. It reaches it as a message from you at its next turn (now, if it is idle). Don't wait for an answer; use ask_agent when you need one. Be short and specific, and name files and functions exactly.",
    inputSchema: obj({ to: TO, text: { type: "string", description: "The message." } }, ["to", "text"]),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  {
    name: "message_team",
    description: "Tell several agents in this session the same thing at once: everyone (\"everyone\"), every agent of one tool (\"codex\", \"claude\"), or a list of names. Each gets it as a message from you at its next step (now, if idle). For things they must act on now: main changed under them, stop touching a file, a new decision. Agents out of usage or offline are skipped and named. For news that needn't wake anyone, use post_update.",
    inputSchema: obj(
      {
        to: { type: "string", description: "\"everyone\", a tool (\"codex\", \"claude\", \"cursor\"), or agent names separated by commas." },
        text: { type: "string", description: "The message." },
      },
      ["to", "text"],
    ),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  {
    name: "ask_agent",
    description: "Ask another agent in this session a question and wait for its answer: what it changed, how something it owns works, whether it is done with a file. Returns its answer. If it is busy or takes longer than the wait, you are told so, and its answer reaches you later as a message. Ask one clear question with what you need back.",
    inputSchema: obj(
      {
        to: TO,
        question: { type: "string", description: "The question, with enough context that it can answer without asking back." },
        wait_seconds: { type: "number", description: "How long to wait for the answer: 240 if left out, 900 at most." },
      },
      ["to", "question"],
    ),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  {
    name: "reply_to_agent",
    description: "Answer a question another agent asked you (ask_agent), now, without waiting for your turn to end. Without it, your last message of the turn is sent as your answer.",
    inputSchema: obj({ text: { type: "string", description: "Your answer." }, id: { type: "string", description: "The question's id, when more than one is waiting; the latest one otherwise." } }, ["text"]),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  {
    name: "wake_me_when",
    description: "Have Friday wake you when what you are waiting on happens, instead of ending your turn on \"waiting\" for a person to check back: another agent finishing its turn (its last words come with the wake), a board task landing, or after some minutes (a build, an evaluation or a test run you left going). Whichever comes first wakes you, with what you said you would do then. Set it, then end your turn.",
    inputSchema: obj(
      {
        agent: { type: "string", description: "The agent you're waiting on: wakes you when its current turn ends." },
        task: { type: "string", description: "A board task's id: wakes you when it is done or stuck." },
        minutes: { type: "number", description: "Wake you after this many minutes (1 to 240) whatever else: to check on something running." },
        then: { type: "string", description: "What you'll do when woken, in a sentence: it comes back to you with the wake." },
      },
      ["then"],
    ),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  {
    name: "claim_files",
    description: "Before you change files another agent might also change, hold them: the others see you hold them, are told if they change one anyway, and are asked to wait or ask you. A folder ending in / holds everything in it. Your hold lasts until you release_files or your turn ends. Files another agent holds are named with who and why, and not held for you: ask_agent that agent, or wait_for_agent, before changing those.",
    inputSchema: obj(
      {
        paths: { type: "array", items: { type: "string" }, description: "Paths from the project's root, e.g. src/api/orders.ts, or a folder: src/api/." },
        why: { type: "string", description: "What you're changing them for, in a few words." },
      },
      ["paths"],
    ),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  {
    name: "release_files",
    description: "Let go of files you held with claim_files, once you're done with them, so others can change them. Leave paths out to let go of all of them.",
    inputSchema: obj({ paths: { type: "array", items: { type: "string" }, description: "The ones to let go of. Leave out for all." } }, []),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  {
    name: "read_notes",
    description: "Read the session's shared notes: decisions, constraints and facts any agent or person here saved for the rest of the session.",
    inputSchema: obj({}, []),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "write_note",
    description: "Save a note every agent in this session can read: a decision, a constraint, an interface you agreed with another agent, a fact you found. Reuse a key to update it.",
    inputSchema: obj({ key: { type: "string", description: "Short slug, e.g. 'api-shape'." }, note: { type: "string", description: "One or two sentences." } }, ["key", "note"]),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  {
    name: "assign_task",
    description: "Only for the session's lead: give another agent a piece of the work to do. It starts on it now (or when its current work is done), and its report comes back to you as a message when it finishes. Assign self-contained pieces with what done looks like, name the files each one owns so two agents don't edit the same file, then follow with check_messages or wait_for_agent and put the pieces together.",
    inputSchema: obj({ to: TO, task: { type: "string", description: "The task as an instruction: what to do, which files it owns, what done looks like." } }, ["to", "task"]),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  {
    name: "show_preview",
    description: "Open a page you started in the Preview panel beside the chat, where the people in this session see it, instead of only saying where it runs. Start the dev server in the background first and call this once it is serving, with its address (http://localhost:5173/, or a path on it). For an iOS app on a Mac, pass ios: true and Friday builds and runs it in a simulator there.",
    inputSchema: obj(
      {
        url: { type: "string", description: "The page: http://localhost:PORT/path. A port alone works too." },
        new_tab: { type: "boolean", description: "Open it in a tab of its own (to show two pages side by side, or several views). Otherwise it reuses the tab already on that server, or a free one; it never replaces a page someone is reading." },
        ios: { type: "boolean", description: "The folder's iOS app instead of a web page." },
        folder: { type: "string", description: "With ios: the folder the app's .xcodeproj or .xcworkspace is in, as an absolute path, when it isn't the folder you were started in (a copy, another repo)." },
      },
      [],
    ),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  {
    name: "preview_screenshot",
    description: "See a page you are building: a screenshot of it, taken on this machine by Friday without opening any window, returned to you as an image. Use it to check your work after a change. Never launch Chrome or another browser, or install one, to look: each opens an app on the person's computer. To show the page to the people in this session, use show_preview.",
    inputSchema: obj(
      {
        url: { type: "string", description: "The page: http://localhost:PORT/path. A port alone works too." },
        width: { type: "number", description: "The window's width in pixels. Default 1280; 390 for a phone." },
        height: { type: "number", description: "The window's height in pixels. Default 900." },
        full_page: { type: "boolean", description: "The whole page, scrolled to the end, rather than only what fits in the window." },
      },
      ["url"],
    ),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "post_tasks",
    description: "Post a plan to the session's shared task board: the pieces of a job, the files each owns and which wait on which. Idle agents are handed ready tasks at once, busy ones claim the next when they finish, a finished task unlocks what waits on it, and Friday runs its checks when a task is done (the board's check, or the project's typecheck) and sends a failure straight back, then another agent reviews it before it counts; a task that waits on others is given what they reported. You hear how it went once the board is done. The lead posts it when there is one. Make tasks that run in parallel, each owning its own files.",
    inputSchema: obj(
      {
        tasks: {
          type: "array",
          description: "The tasks, in order.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Short id, e.g. 'api'." },
              title: { type: "string", description: "One line." },
              detail: { type: "string", description: "What to do and what done looks like." },
              owns: { type: "array", items: { type: "string" }, description: "Files or folders only this task edits." },
              after: { type: "array", items: { type: "string" }, description: "Ids of tasks it waits on." },
              agent: { type: "string", description: "An agent it suits, by name, if any." },
              check: { type: "string", description: "A command that proves this task works, if it differs from the board's: 'npm test -- api'." },
            },
            required: ["title", "detail"],
          },
        },
        check: { type: "string", description: "A command that proves a task works, run by Friday in its agent's folder when each task is done, before anyone reviews it; a failure goes straight back to that agent with the output. Fast and focused: 'npm run typecheck', 'pytest tests/api'. Left out, Friday runs the project's typecheck." },
      },
      ["tasks"],
    ),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  {
    name: "list_tasks",
    description: "The session's shared task board: every task, who has it, what it waits on, and where it stands (open, being done, in review, done, blocked).",
    inputSchema: obj({}, []),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "claim_task",
    description: "Take a ready task from the shared board (one whose dependencies are done and nobody has): the one named, or the best next one for you. A stuck (blocked) task can be taken back by naming it, once what blocked it is sorted. One at a time: finish the one you have first. Do it, then finish_task.",
    inputSchema: obj({ id: { type: "string", description: "The task's id; leave out for the next ready one." } }, []),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  {
    name: "finish_task",
    description: "Mark a board task you have as finished, with a short report (done or blocked, what you did, what's left). A task marked blocked is still yours to finish once it is unblocked; the agent that posted the board can finish a stuck task too. Friday adds the files you changed and the checks you ran, runs the board's check in your folder (a failure comes straight back to you with its output), and then another agent reviews it. Ending your turn with the report does the same.",
    inputSchema: obj({ id: { type: "string" }, report: { type: "string" }, blocked: { type: "boolean", description: "True when you can't go on without someone." }, decline: { type: "boolean", description: "True when this task isn't yours to do (outside your part of the work, or you were told to stay off it). It goes back on the board for another agent and is never offered to you again. Say why in the report." } }, ["id", "report"]),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  {
    name: "check_messages",
    description: "Read what has come in for you while you work: messages and questions other agents sent you, the team's updates, and files another agent is changing that you changed too. Without this they reach you only when your current turn ends. Check between steps of a long task, and whenever a friday tool says something is waiting.",
    inputSchema: obj({}, []),
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  {
    name: "post_update",
    description: "Post a short update to every other agent in the session without interrupting any of them: what you finished, an interface or a file you changed that others build on, what you are about to touch. Each reads it at its next check or turn. Use message_agent instead for something one agent must act on.",
    inputSchema: obj({ text: { type: "string", description: "The update, one to three sentences, naming files and functions exactly." } }, ["text"]),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  {
    name: "wait_for_agent",
    description: "Wait until another agent finishes what it is working on, then get what it said at the end: for work that depends on its (an API it is writing, a migration it is running). Returns at once if it is idle. Also returns early if it posts an update or messages you.",
    inputSchema: obj({ to: TO, wait_seconds: { type: "number", description: "How long to wait: 300 if left out, 900 at most." } }, ["to"]),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "hand_off",
    description: "Pass this work to another agent in the session when it is better placed to do it. Say why, list what you already established so it doesn't start over, and state the task. It gets your whole record (what you read, ran and changed). Stop after this and say in a sentence that you handed it over.",
    inputSchema: obj(
      {
        to: TO,
        reason: { type: "string", description: "One or two sentences: why this agent, why now." },
        task: { type: "string", description: "What it should do, as an instruction." },
        carried: { type: "array", items: { type: "string" }, description: "Short lines it should start from: findings, files, the failing test." },
      },
      ["to", "reason", "task"],
    ),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  // Other sessions, as Friday Code has them (agent/tools.ts, peers.ts): a coding tool had no way to reach another session at all,
  // and every agent in a team is one, so sessions never talked (Arun, 2026-10-24: "look into sessions being able to talk to each
  // other too fix any bugs").
  {
    name: "list_sessions",
    description: "List the other Friday sessions in this workspace you can reach: the ones the person you work for is in, and teammates' sessions from the team's library (read only). Ones on the same repo, or that changed the same files as you, come first. Use it before read_session or message_session, and to check whether another session already worked something out.",
    inputSchema: obj({}, []),
  },
  {
    name: "read_session",
    description: "Read where another session is: its agents, what each last said, and the files it has changed. Use it before you build on what another session decided or tell it something.",
    inputSchema: obj({ to: { type: "string", description: "The session's id or title, from list_sessions." } }, ["to"]),
  },
  {
    name: "message_session",
    description: "Tell an agent in another session something it needs to know: a change of yours that affects its work, something you found, a question. It reaches that agent as a message from you, not as an instruction from its people. One to an agent the person you work for can't steer waits there until someone who can lets it through. Be short and specific; don't wait for a reply.",
    inputSchema: obj(
      {
        to: { type: "string", description: "The session's id or title, from list_sessions." },
        agent: { type: "string", description: "Which agent there, by name. Leave empty for its main agent." },
        text: { type: "string", description: "The message." },
      },
      ["to", "text"],
    ),
  },
];

/**
 * What the `friday` MCP server tells a tool about itself as it connects (the MCP `instructions` field). The agents stay in touch as
 * they work (Arun, 2026-10-20: "constantly updating and stuff like checking up on each other").
 */
export const MESH_INSTRUCTIONS =
  "You are one of several agents in a Friday session; people watch all of you live. These tools keep an open line to the other agents: list_agents to see who is here and what each is doing, check_messages to read what came in for you while you work (do it between the steps of a long task), post_update to tell everyone what you finished or changed without interrupting them, message_agent to tell one agent something it must act on, message_team to tell several or everyone at once, ask_agent to ask one and wait for its answer, reply_to_agent to answer a question asked of you, wait_for_agent to wait until another finishes work yours depends on, show_preview to open a page you started (a dev server on localhost) in the session's Preview panel for the people here, preview_screenshot to see it yourself (never launch Chrome or install a browser to look), list_tasks, claim_task and finish_task for the session's shared task board (take the next ready task when you finish one), read_notes and write_note for the session's shared notes, claim_files before you change files others may be changing (and release_files when done), wake_me_when to be woken when what you wait on happens (another agent's turn, a board task, a job you left running) instead of ending on 'waiting' for a person to check back, hand_off to pass work on, and list_sessions, read_session and message_session for the other Friday sessions your person is in (tell one when you change something it builds on). Stay in touch while you work: check_messages between steps, post_update a one-line status each time you finish a piece (what is done, what is next) and whenever you change something others build on (an interface, a shared file, a schema), and when your work depends on another agent, read what it posted, ask it or wait_for_agent rather than guessing or stopping. Check before you edit a file another agent may be changing. Your own sub-agents are helpers inside your task, in your folder; the agents here are teammates with folders of their own, for work that runs alongside yours. These friday tools are yours, not your sub-agents': they report to you, and you speak for them. Keep going until your task is fully done. Don't chat: every message shows in the session's feed.";

/**
 * A page on this machine from what an agent gave (http://localhost:5173/x, localhost:5173, 5173), as the Preview opens it.
 * `{what}` in the error is where it couldn't go.
 */
export function localPage(raw: unknown): { ok: true; url: string } | { ok: false; error: string } {
  const s = String(raw ?? "").trim();
  const port = /^\d{2,5}$/.test(s) ? s : "";
  try {
    const u = new URL(port ? `http://localhost:${port}/` : s.replace(/^(?!https?:\/\/)/i, "http://"));
    if (!/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i.test(u.hostname)) return { ok: false, error: "Only a page served on this machine (localhost) {what}." };
    if (u.hostname === "0.0.0.0") u.hostname = "localhost";
    return { ok: true, url: u.toString() };
  } catch {
    return { ok: false, error: "Give the page's address, e.g. http://localhost:5173/." };
  }
}

/** A size an agent asked for, within what a screenshot it can read takes. */
const px = (v: unknown, fallback: number, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(max, Math.max(min, v))) : fallback);

/**
 * preview_screenshot: what the runner on the agent's machine is to capture, and the picture is its answer (Arun, 2026-10-19:
 * Claude Code had launched headless Google Chrome fourteen times in one session to look at its page, a Chrome in the Dock each
 * time). Only the runner can reach the agent's localhost, so this only checks the ask; a runner too old to capture, or one
 * outside the desktop app, is left with `output`. Those aren't offered the tool (see meshListing), so it is rarely heard.
 */
export function previewShot(args: Record<string, unknown>): MeshResult {
  const url = localPage(args.url);
  if (!url.ok) return { output: url.error.replace("{what}", "can be captured"), isError: true };
  return {
    output: "Screenshots are taken by the Friday desktop app on the computer the agent runs on, and this one can't: update Friday there. Meanwhile show_preview shows the page to the people here.",
    isError: true,
    capture: { url: url.url, width: px(args.width, 1280, 320, 2560), height: px(args.height, 900, 240, 2000), fullPage: args.full_page === true },
  };
}

/**
 * The friday server's tool list and instructions for one runner. preview_screenshot only for a runner that can take one (in the
 * desktop app, and new enough to say so), so the others aren't offered a tool that only ever fails.
 */
export function meshListing(screenshot: boolean): { tools: MeshToolDef[]; instructions: string } {
  if (screenshot) return { tools: MESH_TOOLS, instructions: MESH_INSTRUCTIONS };
  return { tools: MESH_TOOLS.filter((t) => t.name !== "preview_screenshot"), instructions: MESH_INSTRUCTIONS.replace(/ preview_screenshot to see it yourself \([^)]*\),/, "") };
}

/** The person behind a lane's current run, and how many agent-to-agent steps led to it. */
function behind(state: SessionState, events: SessionEvent[], lane: string): { person: { id: string; name: string } | null; hop: number } {
  const started = events.findLast((e) => e.body.type === "run.started" && (e.lane ?? MAIN_LANE) === lane);
  const causedBy = started?.body.type === "run.started" ? started.body.causedBy : -1;
  const cause = events.find((e) => e.seq === causedBy);
  if (cause?.body.type === "instruction") {
    const b = cause.body;
    if (cause.actor.kind === "human") return { person: { id: cause.actor.id, name: cause.actor.name }, hop: 0 };
    if (b.mesh) return { person: b.mesh.by, hop: b.mesh.hop };
    if (b.peer) return { person: b.peer.by, hop: 1 };
    if (cause.actor.kind === "agent") return { person: driverOf(state, lane), hop: 1 };
  }
  return { person: driverOf(state, lane), hop: 0 };
}

/** Messages and handoffs between two lanes, either way, since `since`. */
export function exchangesBetween(events: SessionEvent[], a: string, b: string, since: number): number {
  let n = 0;
  for (const e of events) {
    if (e.ts < since || e.body.type !== "instruction") continue;
    const from = e.body.mesh?.fromLane ?? e.body.handoff?.fromLane;
    if (from === undefined) continue;
    const to = e.lane ?? MAIN_LANE;
    if ((from === a && to === b) || (from === b && to === a)) n++;
  }
  return n;
}

/** Whether `from` is waiting, directly or along a chain of open asks, on an answer from `on`. */
export function waitsOn(state: SessionState, from: string, on: string): boolean {
  const open = Object.values(meshOf(state).asks).filter((a) => !a.reply && a.unwaitedSeq === undefined);
  const seen = new Set<string>();
  const walk = (lane: string): boolean => {
    if (lane === on) return true;
    if (seen.has(lane)) return false;
    seen.add(lane);
    return open.some((a) => a.fromLane === lane && walk(a.toLane));
  };
  return open.some((a) => a.fromLane === from && walk(a.toLane));
}

/** What an asked agent's turn came to, as its answer: its last words without a tool call, else its last words at all. */
export function answerFrom(events: SessionEvent[], lane: string, after: number, before: number): string {
  const said = events.filter((e) => e.seq > after && e.seq < before && (e.lane ?? MAIN_LANE) === lane && e.body.type === "agent.message" && !!e.body.text.trim());
  const last = said.findLast((e) => e.body.type === "agent.message" && !e.body.toolCalls.length) ?? said.at(-1);
  return last?.body.type === "agent.message" ? last.body.text.trim() : "";
}

type Sent = { ok: true; id: string; to: string; toName: string; busy: boolean; offline: boolean } | { ok: false; error: string };
type Waited = { reply: string } | { gone: true } | { timeout: true };

export class AgentMesh {
  /** Other sessions (peers.ts), for list_sessions, read_session and message_session: set by the app. */
  peers: Peers | null = null;
  constructor(
    private store: SessionStore,
    private bus: Bus,
    /** Friday Code's own hand-off (AgentRuntime.handOff), which a coding tool's hand_off goes through too. */
    private handOff: HandOffFn | null = null,
    /** A call into an agent's folder on its machine (EngineHub.readRepo): how a finished task's checks are run there. */
    public repo: ((sid: string, lane: string, req: RepoCall) => Promise<string | null>) | null = null,
  ) {}

  /** The usage windows of the tool on a lane, as its runner last read them (EngineHub.usage): set by the app. */
  usage: ((sid: string, lane: string) => ToolWindow[]) | null = null;

  /** What each tool has shown it is good at in the workspace (strengths.ts): set by the app. */
  skills: { get(workspaceId: string): Promise<Skills>; learn(workspaceId: string, tool: string, kind: TaskKind, grade: number, once: string): Promise<void> } | null = null;

  private async skillsFor(state: SessionState): Promise<Skills> {
    return state.workspaceId && this.skills ? await this.skills.get(state.workspaceId).catch(() => ({})) : {};
  }

  /**
   * A board task settled (board.reviewed, or finished as stuck): its tool's record for that kind of work gets a grade, through
   * review the first time 1, after being sent back 0.6, stuck 0 (strengths.ts). A verdict asking for changes waits for the end.
   */
  async learnSkill(sid: string, body: EventBody): Promise<void> {
    if (body.type !== "board.reviewed" && !(body.type === "board.finished" && body.status === "blocked")) return;
    if (body.type === "board.reviewed" && !body.ok) return;
    if (!(await this.store.exists(sid))) return;
    const state = await this.store.state(sid);
    const t = state.board?.tasks.find((x) => x.id === body.id);
    const kind = t ? taskKind(`${t.title} ${t.detail}`) : null;
    if (!t?.lane || !kind || !state.workspaceId || !this.skills) return;
    const tool = state.engines[t.lane]?.tool ?? "friday";
    const grade = body.type === "board.finished" ? 0 : t.rounds === 0 ? 1 : 0.6;
    await this.skills.learn(state.workspaceId, tool, kind, grade, `${sid}:${state.board!.seq}:${t.id}`);
  }

  /** How close the agent on `lane` is to the end of its usage, when it is close (nearLimit): it is handed work last. */
  private near(sid: string, lane: string): { pct: number; label: string } | null {
    return nearLimit(this.usage?.(sid, lane) ?? []);
  }

  /** `lanes` with those nearly out of usage moved to the end, the rest in the order given. */
  private roomFirst(sid: string, lanes: string[]): string[] {
    const near = new Set(lanes.filter((l) => this.near(sid, l)));
    return [...lanes.filter((l) => !near.has(l)), ...lanes.filter((l) => near.has(l))];
  }

  /** Sessions with a board being worked on, looked at now and then for a task nobody is doing (sweep). */
  readonly live = new Set<string>();

  /** One of MESH_TOOLS, called by the agent on `lane`. Never throws: a failure is the tool's answer. */
  async call(sid: string, lane: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<MeshResult> {
    const r = await this.callOne(sid, lane, name, args, signal);
    // The open line: whatever an agent asks Friday, it hears that something is waiting for it, so a message to a busy agent
    // reaches it mid-work instead of only when its turn ends.
    if (name === "check_messages" || name === "list_agents" || r.endTurn) return r;
    const waiting = await this.waitingCount(sid, lane).catch(() => 0);
    return waiting ? { ...r, output: `${r.output}\n\n(${waiting} new for you from the other agents: call check_messages.)` } : r;
  }

  private async callOne(sid: string, lane: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<MeshResult> {
    try {
      switch (name) {
        case "check_messages":
          return { output: await this.checkMessages(sid, lane) };
        case "show_preview":
          return await this.showPreview(sid, lane, args);
        case "preview_screenshot":
          return previewShot(args);
        case "assign_task":
          return await this.assign(sid, lane, str(args.to), str(args.task));
        case "post_tasks":
          return await this.postTasks(sid, lane, Array.isArray(args.tasks) ? args.tasks : [], typeof args.check === "string" ? args.check : "");
        case "list_tasks":
          return { output: boardText(await this.store.state(sid), lane) };
        case "claim_task":
          return await this.claim(sid, lane, str(args.id));
        case "finish_task":
          return await this.finish(sid, lane, str(args.id), str(args.report), args.blocked === true, args.decline === true);
        case "post_update":
          return await this.post(sid, lane, str(args.text));
        case "wait_for_agent": {
          const secs = Number(args.wait_seconds);
          const wait = Number.isFinite(secs) && secs > 0 ? Math.min(secs * 1000, ASK_WAIT_MAX_MS) : WATCH_WAIT_MS;
          return await this.watch(sid, lane, str(args.to), wait, signal);
        }
        case "list_agents":
          return { output: await this.list(sid, lane) };
        case "list_sessions":
          return this.peers ? { output: await this.peers.list(sid, lane) } : { output: "Other sessions can't be reached from here.", isError: true };
        case "read_session": {
          if (!this.peers) return { output: "Other sessions can't be reached from here.", isError: true };
          const r = await this.peers.read(sid, lane, str(args.to));
          return r.ok ? { output: r.text } : { output: r.error, isError: true };
        }
        case "message_session": {
          if (!this.peers) return { output: "Other sessions can't be reached from here.", isError: true };
          const r = await this.peers.send(sid, lane, { to: str(args.to), agent: str(args.agent), text: str(args.text) });
          if (!r.ok) return { output: r.error, isError: true };
          // Its record lands here too, as Friday Code's does: what was said, and to which agent where.
          const name = laneName(await this.store.state(sid), lane);
          await this.store.append(sid, agentActor(name), { type: "peer.sent", to: { sid: r.sid, title: r.title, lane: r.lane, name: r.name }, text: r.text, held: r.held }, { lane });
          return {
            output: r.held
              ? `Sent to ${r.name} in "${r.title}". The person you work for can't steer that agent, so it waits there until someone who can lets it through. Carry on with your own work.`
              : `Sent to ${r.name} in "${r.title}". It reads it at its next step, or starts on it now if it was idle. Carry on with your own work; don't wait for an answer.`,
          };
        }
        case "message_agent": {
          const r = await this.send(sid, lane, { to: str(args.to), text: str(args.text), kind: "tell" });
          if (!r.ok) return { output: r.error, isError: true };
          return { output: `Sent to ${r.toName}. ${r.offline ? "It is offline, so it reads it when it is back." : r.busy ? "It is busy, so it reads it when its current work is done." : "It reads it now."} Carry on with your own work; don't wait for an answer.` };
        }
        case "message_team":
          return await this.messageTeam(sid, lane, str(args.to), str(args.text));
        case "ask_agent": {
          const secs = Number(args.wait_seconds);
          const wait = Number.isFinite(secs) && secs > 0 ? Math.min(secs * 1000, ASK_WAIT_MAX_MS) : ASK_WAIT_MS;
          return await this.ask(sid, lane, { to: str(args.to), question: str(args.question) }, wait, signal);
        }
        case "reply_to_agent":
          return await this.reply(sid, lane, { id: str(args.id), text: str(args.text) });
        case "read_notes":
          return { output: await this.notes(sid) };
        case "wake_me_when":
          return await this.wakeMeWhen(sid, lane, { agent: str(args.agent), task: str(args.task), minutes: Number(args.minutes) || 0, then: str(args.then) });
        case "claim_files":
          return await this.holdFiles(sid, lane, Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string") : [], str(args.why));
        case "release_files":
          return await this.releaseFiles(sid, lane, Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string") : []);
        case "write_note":
          return await this.writeNote(sid, lane, str(args.key), str(args.note));
        case "hand_off": {
          if (!this.handOff) return { output: "Handing off isn't available here.", isError: true };
          const carried = Array.isArray(args.carried) ? args.carried.filter((c): c is string => typeof c === "string") : [];
          const r = await this.handOff(sid, lane, { to: str(args.to), reason: str(args.reason), carried, task: str(args.task) });
          if (!r.ok) return { output: r.error, isError: true };
          return { output: `Handed off to ${r.toName}.${r.note ? ` ${r.note}` : ""} It has your reason, what you carried over, your whole record and the task. Stop here and say in a sentence that you handed it over.`, endTurn: true };
        }
        default:
          return { output: `Friday has no tool called ${name}.`, isError: true };
      }
    } catch (e) {
      return { output: `That didn't work: ${(e as Error).message}`, isError: true };
    }
  }

  /**
   * wake_me_when: wake this agent when what it waits on happens, so a person doesn't have to come back and ask "update?" (Arun,
   * 2026-10-25: "i dont need to keep messaging the agents to ask for stuff at the end of runs and things from other agents").
   */
  async wakeMeWhen(sid: string, lane: string, req: { agent: string; task: string; minutes: number; then: string }): Promise<MeshResult> {
    const state = await this.store.state(sid);
    const on: { lane?: string; task?: string; at?: number } = {};
    if (req.agent) {
      const r = resolveTarget(state, lane, req.agent);
      if (!r.ok || r.how === "suggested") return { output: `There's no agent called "${req.agent}" here.`, isError: true };
      on.lane = r.to;
    }
    if (req.task) {
      const t = state.board?.tasks.find((x) => x.id === req.task || x.title.toLowerCase() === req.task.toLowerCase());
      if (!t) return { output: `There's no board task "${req.task}". list_tasks has their ids.`, isError: true };
      on.task = t.id;
    }
    if (req.minutes) on.at = Date.now() + Math.round(Math.min(240, Math.max(1, req.minutes)) * 60_000);
    if (!on.lane && !on.task && !on.at) return { output: "Say what to wake you on: agent, task or minutes.", isError: true };
    const then = clip(req.then.trim() || "Carry on with the task.", 600);
    await this.store.append(sid, agentActor(laneName(state, lane)), { type: "wake.set", id: randomBytes(5).toString("hex"), on, then }, { lane });
    const what = [on.lane ? `${laneName(state, on.lane)} finishes its turn` : "", on.task ? `the board task "${on.task}" lands` : "", on.at ? `${Math.round((on.at - Date.now()) / 60_000)} minutes pass` : ""].filter(Boolean).join(", or ");
    return { output: `Friday wakes you when ${what}, with what you said you'd do then. End your turn now; don't wait here.` };
  }

  /**
   * A wake goes off: the agent is told what happened and what it said it would do, and woken. Once: it is gone from the session
   * once fired, so a second cause (the time after the agent) finds nothing.
   */
  async fireWake(sid: string, id: string, why: string): Promise<void> {
    if (!(await this.store.exists(sid))) return;
    const state = await this.store.state(sid);
    const w = state.wakes?.[id];
    if (!w || !lanesOf(state).includes(w.lane)) return;
    const done = await this.store.append(sid, FRIDAY, { type: "wake.fired", id, why: clip(why.split("\n")[0]!, 300) }, { lane: w.lane });
    if (!done.ok) return;
    const text = `[Friday] ${why}\n\n${w.auto ? `Your last turn ended waiting: "${w.then}"` : `You asked to be woken for this. What you said you'd do then: ${w.then}`}\n\nCarry on now: see where things stand and do the next step yourself. If you still have to wait, call wake_me_when and end your turn, rather than ending on "waiting" for a person to check back.`;
    const sent = await this.store.append(sid, FRIDAY, { type: "instruction", text, interrupt: false }, { lane: w.lane });
    if (sent.ok) void this.bus.wake(sid, w.lane);
  }

  /** The agent on `lane` finished its turn: whoever waits on it is woken, with its last words. */
  private async wakeOnTurn(sid: string, lane: string): Promise<void> {
    const [state, events] = await Promise.all([this.store.state(sid), this.store.events(sid)]);
    const waiting = Object.values(state.wakes ?? {}).filter((w) => w.on.lane === lane && w.lane !== lane);
    if (!waiting.length) return;
    const end = events.findLast((e) => e.body.type === "run.ended" && (e.lane ?? MAIN_LANE) === lane);
    if (end?.body.type !== "run.ended" || end.body.outcome === "waiting" || end.body.cut) return;
    const start = events.findLast((e) => e.seq < end.seq && e.body.type === "run.started" && (e.lane ?? MAIN_LANE) === lane);
    const said = start ? answerFrom(events, lane, start.seq, end.seq) : "";
    const name = laneName(state, lane);
    const how = end.body.outcome === "error" ? `stopped with an error: ${clip(end.body.error ?? "", 300)}` : "finished its turn";
    for (const w of waiting) await this.fireWake(sid, w.id, `${name} ${how}.${said ? `\n\nWhat ${name} said at the end:\n${clip(said, 1500)}` : ""}`);
  }

  /** A board task landed (done, or stuck): whoever waits on it is woken. */
  async wakeOnTask(sid: string, id: string): Promise<void> {
    if (!(await this.store.exists(sid))) return;
    const state = await this.store.state(sid);
    const t = state.board?.tasks.find((x) => x.id === id);
    if (!t || (t.status !== "done" && t.status !== "blocked")) return;
    for (const w of Object.values(state.wakes ?? {}).filter((x) => x.on.task === id)) {
      await this.fireWake(sid, w.id, `The board task "${t.title}" is ${t.status === "done" ? `done${t.name ? ` (${t.name})` : ""}` : "stuck"}.${t.report ? `\n\nIts report:\n${clip(t.report, 1200)}` : ""}`);
    }
  }

  /**
   * A turn that ended waiting ("waiting on Codex", "I'll act when it finishes", "once their hashes arrive") without asking to be
   * woken: Friday sets the wake itself, on the agent it names, or a board task, or a time, so nobody has to come back and ask.
   * Not for one waiting on a person, ending on a question, or whose reports wake it anyway (the lead with tasks out, the board's
   * poster), and backing off: ten minutes, then twenty, forty…, five times at most before a person writes to it again.
   */
  private async autoWake(sid: string, lane: string, now = Date.now()): Promise<void> {
    const [state, events] = await Promise.all([this.store.state(sid), this.store.events(sid)]);
    if (laneOf(state, lane)?.control.kind === "standing" || Object.values(state.wakes ?? {}).some((w) => w.lane === lane)) return;
    const end = events.findLast((e) => e.body.type === "run.ended" && (e.lane ?? MAIN_LANE) === lane);
    if (end?.body.type !== "run.ended" || end.body.outcome !== "done") return;
    const start = events.findLast((e) => e.seq < end.seq && e.body.type === "run.started" && (e.lane ?? MAIN_LANE) === lane);
    const said = start ? answerFrom(events, lane, start.seq, end.seq) : "";
    const waitLine = waitingOn(said);
    if (!waitLine || said.trim().endsWith("?")) return;
    // Waiting on a person is theirs to answer.
    const people = Object.values(state.members ?? {}).map((m) => (m as { name?: string }).name ?? "").filter(Boolean);
    if (/\b(?:you|your)\b/i.test(waitLine) || people.some((p) => new RegExp(`\\b${escapeRe(p.split(/\s+/)[0]!)}\\b`, "i").test(waitLine))) return;
    // Reports wake it anyway: tasks it handed out, or the board it posted.
    if (Object.values(meshOf(state).asks).some((a) => a.task && a.fromLane === lane && !a.reply) || (state.board?.fromLane === lane && boardBusy(state))) return;
    const lastHuman = events.findLast((e) => (e.lane ?? MAIN_LANE) === lane && e.body.type === "instruction" && e.actor.kind === "human")?.seq ?? 0;
    const tries = events.filter((e) => e.seq > lastHuman && e.body.type === "wake.set" && e.body.auto && (e.lane ?? MAIN_LANE) === lane).length;
    if (tries >= 5) return;
    const named = lanesOf(state).filter((l) => l !== lane && new RegExp(`\\b${escapeRe(laneName(state, l))}\\b`, "i").test(waitLine));
    const busy = named.filter((l) => runOf(state, l).status === "running" || pendingFor(state, l).length);
    const task = state.board?.tasks.find((t) => t.status !== "done" && t.status !== "cancelled" && (waitLine.includes(`"${t.id}"`) || waitLine.toLowerCase().includes(t.title.toLowerCase())));
    const on: { lane?: string; task?: string; at?: number } = { at: now + Math.min(120, 10 * 2 ** tries) * 60_000 };
    if (busy[0]) on.lane = busy[0];
    if (task) on.task = task.id;
    await this.store.append(sid, FRIDAY, { type: "wake.set", id: randomBytes(5).toString("hex"), on, then: clip(waitLine, 400), auto: true }, { lane });
  }

  /**
   * claim_files: hold files ahead of changing them (Arun, 2026-10-25: file claims). Those another agent holds, or that its board
   * task owns, are named and not held; the rest are this agent's until it lets go or its run ends.
   */
  async holdFiles(sid: string, lane: string, raw: string[], why: string): Promise<MeshResult> {
    const paths = [...new Set(raw.map(cleanPath).filter(Boolean))].slice(0, 40);
    if (!paths.length) return { output: "Name the files, from the project's root (src/api/orders.ts), or a folder ending in /.", isError: true };
    const state = await this.store.state(sid);
    const taken = paths.flatMap((p) => heldBy(state, lane, p).map((h) => ({ p, h })));
    const free = paths.filter((p) => !taken.some((t) => t.p === p));
    if (free.length) await this.store.append(sid, agentActor(laneName(state, lane)), { type: "files.held", paths: free, ...(why.trim() ? { why: clip(why.trim(), 120) } : {}) }, { lane });
    const others = taken.map((t) => `- ${t.p}: ${t.h.name}${t.h.why ? `, for ${t.h.why}` : ""}`);
    return {
      output: [
        free.length ? `Holding ${free.join(", ")} until you release_files or your turn ends. Another agent that changes one is told to stop and ask you.` : "",
        others.length ? `Held by others, so not yours to change yet. Ask the agent holding it (ask_agent) or wait for it (wait_for_agent):\n${others.join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      ...(free.length ? {} : { isError: true }),
    };
  }

  async releaseFiles(sid: string, lane: string, raw: string[]): Promise<MeshResult> {
    const state = await this.store.state(sid);
    const had = state.holds?.[lane]?.paths ?? [];
    if (!had.length) return { output: "You hold no files." };
    const paths = raw.map(cleanPath).filter((p) => had.includes(p));
    await this.store.append(sid, agentActor(laneName(state, lane)), { type: "files.released", ...(paths.length ? { paths } : {}) }, { lane });
    return { output: `Let go of ${(paths.length ? paths : had).join(", ")}.` };
  }

  /** Who was told they changed a held file, by session, lane, path and hold: once each. */
  private heldTold = new Set<string>();

  /**
   * An agent's changes (agent.diff) touched a file another agent holds, or its board task owns: it is told at once to stop and ask
   * that agent, where the collision warnings only said so to the people after both had written it.
   */
  async onDiff(sid: string, lane: string): Promise<void> {
    // A run's last diff can land as its session is being deleted: reading it then would bring keys of it back.
    if (!(await this.store.exists(sid))) return;
    const state = await this.store.state(sid);
    if (!Object.keys(state.holds ?? {}).length && !state.board?.tasks.some((t) => t.status === "claimed" && t.owns.length)) return;
    const files = state.diffs[lane]?.files ?? [];
    const hits = files.flatMap((f) => heldBy(state, lane, f.path).map((h) => ({ path: f.path, h })));
    const fresh = hits.filter(({ path, h }) => !this.heldTold.has(`${sid}|${lane}|${path}|${h.lane}|${h.seq}`));
    if (!fresh.length) return;
    for (const { path, h } of fresh) this.heldTold.add(`${sid}|${lane}|${path}|${h.lane}|${h.seq}`);
    const rows = fresh.map(({ path, h }) => `- ${path}: ${h.name} holds it${h.why ? `, for ${h.why}` : ""}`);
    const text = `[Friday] You changed files another agent is holding while it changes them:\n${rows.join("\n")}\n\nStop changing them. Ask that agent (ask_agent) what you need, or wait until it lets go (wait_for_agent), and don't undo what it changed.`;
    const sent = await this.store.append(sid, FRIDAY, { type: "instruction", text, interrupt: false }, { lane });
    if (sent.ok) void this.bus.wake(sid, lane);
  }

  /**
   * message_team: one message to several agents (Arun, 2026-10-25: team messages). "everyone", one tool's agents, or names; each
   * gets it as message_agent would send it, every one under the same rules, and the run is charged one message, not one each.
   */
  async messageTeam(sid: string, lane: string, rawTo: string, text: string): Promise<MeshResult> {
    const state = await this.store.state(sid);
    const others = lanesOf(state).filter((l) => l !== lane && laneOf(state, l)?.control.kind !== "standing");
    const q = rawTo.trim().toLowerCase();
    if (!q) return { output: 'Say who: "everyone", a tool such as "codex", or names separated by commas.', isError: true };
    const ofTool = others.filter((l) => {
      const t = state.engines[l]?.tool;
      return !!t && (t === q || engineName(t).toLowerCase() === q || q === `${t}s` || q === `all ${t}`);
    });
    const names = q.split(/\s*(?:,|\band\b)\s*/).filter(Boolean);
    const targets = /^(everyone|everybody|all|team|the team|all agents|\*)$/.test(q)
      ? others
      : ofTool.length
        ? ofTool
        : names.flatMap((n) => {
            const r = resolveTarget(state, lane, n);
            return r.ok && r.how !== "suggested" ? [r.to] : [];
          });
    if (!targets.length) return { output: `Nobody here goes by "${rawTo}". The others: ${others.map((l) => `"${laneName(state, l)}"`).join(", ") || "none"}.`, isError: true };
    const team = randomBytes(5).toString("hex");
    const sent: string[] = [];
    const not: string[] = [];
    for (const to of [...new Set(targets)]) {
      const r = await this.send(sid, lane, { to, text, kind: "tell", team });
      if (r.ok) sent.push(`${r.toName}${r.offline ? " (offline: when it is back)" : r.busy ? " (busy: at its next step)" : ""}`);
      else not.push(`${laneName(state, to)}: ${r.error}`);
    }
    if (!sent.length) return { output: `Sent to nobody.\n${not.map((n) => `- ${n}`).join("\n")}`, isError: true };
    return { output: `Sent to ${sent.join(", ")}.${not.length ? `\nNot sent:\n${not.map((n) => `- ${n}`).join("\n")}` : ""} Carry on with your own work; don't wait for answers.` };
  }

  /** The other agents, as a list an agent can pick from, and any question waiting on this one. */
  async list(sid: string, lane: string, now = Date.now()): Promise<string> {
    const [state, events] = await Promise.all([this.store.state(sid), this.store.events(sid)]);
    const others = lanesOf(state).filter((l) => l !== lane);
    const limited = limitedLanes(state, events, now);
    const skills = await this.skillsFor(state);
    const rows = others.map((l) => {
      const e = state.engines[l];
      const what = e?.tool ? `${engineName(e.tool)} on ${e.hostName}'s computer` : laneOf(state, l)?.agent?.name ? `Friday agent "${laneOf(state, l)!.agent!.name}"` : "Friday Code";
      const run = runOf(state, l).status;
      // How long, and when it last did anything: a quiet "working" agent and a busy one read the same without it.
      const lastHere = events.findLast((x) => (x.lane ?? MAIN_LANE) === l);
      const quiet = lastHere ? now - lastHere.ts : 0;
      const began = events[runOf(state, l).sinceSeq - 1]?.ts;
      const gone = e?.tool && !e.online ? events.findLast((x) => (x.lane ?? MAIN_LANE) === l && x.body.type === "engine.detached") : undefined;
      const queued = pendingFor(state, l).length;
      const out = limited.get(l);
      const status =
        e?.tool && !e.online
          ? `offline${gone ? ` for ${span(now - gone.ts)}` : ""}`
          : out && run !== "running"
            ? `${outOfUsage(state, out, now)}: can't take messages or tasks until then`
            : run === "running"
            ? `working${began ? ` for ${span(now - began)}` : ""}, last step ${span(quiet)} ago${quiet >= 10 * 60_000 ? " (quiet a long while: message it to check, or tell a person if it seems stuck)" : ""}`
            : run === "waiting_for_human"
              ? "waiting for a person"
              : "ready for a message or a task";
      const waitingFor = queued ? ` · ${queued} message${queued === 1 ? "" : "s"} waiting for it` : "";
      const near = out ? null : this.near(sid, l);
      const room = near ? ` · ${near.pct}% of its ${near.label} usage used, so give it small things: a long task may stop partway` : "";
      const good = strongAt(skills, e?.tool ?? "friday").slice(0, 2);
      const strong = good.length ? ` · good at ${good.map((g) => `${KIND_WORDS[g.kind]} (${g.firstTime} of ${g.n} through review first time)`).join(", ")}` : "";
      const holding = state.holds?.[l]?.paths ?? [];
      const holds = holding.length ? ` · holding ${holding.slice(0, 4).join(", ")}${holding.length > 4 ? ` and ${holding.length - 4} more` : ""} (keep off them)` : "";
      const driver = driverOf(state, l);
      const said = events.findLast((x) => (x.lane ?? MAIN_LANE) === l && x.body.type === "agent.message" && !!x.body.text.trim());
      const last = said?.body.type === "agent.message" ? clip(said.body.text.trim().replace(/\s+/g, " "), 240) : "";
      const onTask = Object.values(meshOf(state).asks).find((a) => a.task && a.toLane === l && !a.reply);
      return `- "${laneName(state, l)}": ${what}${state.lead === l ? " · leads this session" : ""} · ${status}${strong}${room}${holds}${waitingFor}${onTask ? ` · on a task from ${onTask.fromName}: ${clip(onTask.text.split("\n")[0]!.trim(), 120)}` : ""}${driver ? ` · steered by ${driver.name}` : ""}${laneOf(state, l)?.control.kind === "standing" ? " · runs on its own triggers, takes no messages" : ""}${last ? `\n  Last said: ${last}` : ""}`;
    });
    const open = Object.values(meshOf(state).asks).filter((a) => a.toLane === lane && !a.reply);
    const asked = open.map((a) => `- [id ${a.id}] ${a.fromName} asks: ${clip(a.text.replace(/\s+/g, " "), 300)}`);
    const waiting = this.inbox(state, lane);
    const news = waiting.msgs.length + waiting.posts.length + waiting.reports.length;
    return [
      state.lead === lane ? "You lead the agents in this session: assign_task gives one of them work." : "",
      rows.length ? `The other agents in this session:\n${rows.join("\n")}` : "You are the only agent in this session.",
      asked.length ? `Waiting for your answer (reply_to_agent):\n${asked.join("\n")}` : "",
      news ? `${news} new for you (check_messages).` : "",
      overlapText(waiting.overlaps),
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /** A message from the agent on `from` to another, as an instruction on that agent's lane. */
  async send(sid: string, from: string, req: { to: string; text: string; kind: "tell" | "ask" | "task"; board?: string; review?: boolean; system?: boolean; /** The board's own messages name their lane exactly. */ toLane?: string; carriedFrom?: string; team?: string }): Promise<Sent> {
    const text = req.text.trim().slice(0, MAX_TEXT);
    if (!text) return { ok: false, error: "The message is empty." };
    const [state, events] = await Promise.all([this.store.state(sid), this.store.events(sid)]);
    const { person, hop } = behind(state, events, from);
    // Whom it may reach: what the person behind it could steer, as for a handoff. With nobody behind it, only an agent nobody
    // steers and nobody's own coding tool.
    const refusal = (id: string): string | null => {
      const name = laneName(state, id);
      const driver = driverOf(state, id);
      const engine = state.engines[id];
      if (laneOf(state, id)?.control.kind === "standing") return `${name} runs on its own triggers and takes no messages.`;
      if (driver && driver.id !== person?.id) return `${name} is ${driver.name}'s to steer, so I can't message it. Ask ${driver.name} in chat.`;
      if (person ? canDriveLane(state, person.id, id) || driver?.id === person.id : !engine) return null;
      if (person) return `${person.name} can't steer ${name}, so I can't message it.`;
      return `${name} is ${engine!.hostName}'s own coding tool, and no person started this run, so I can't message it.`;
    };
    // The board itself may send to the lane that posted it: with nobody else free, the poster reviews the work, and its brief
    // comes "from" that same lane. An agent can't message itself, so only the board's own messages get this.
    const self = req.system && req.toLane === from;
    const found: Resolved = self ? { ok: true, to: from, how: "named" } : resolveTarget(state, from, req.to, text, (id) => !refusal(id));
    if (!found.ok) return { ok: false, error: found.error.replace(/hand (this|work) (off )?to/g, "message").replace(/hand off to/g, "message") };
    // A message goes to the agent named, never to a best guess at who fits: a guessed handoff is still the work moving, a guessed
    // message is words in the wrong agent's turn.
    if (found.how === "suggested") return { ok: false, error: `There's no agent called "${req.to}" here. The others: ${lanesOf(state).filter((l) => l !== from).map((l) => `"${laneName(state, l)}"`).join(", ")}.` };
    const to = found.to;
    const refused = refusal(to);
    if (refused) return { ok: false, error: refused };
    const toName = laneName(state, to);
    // Out of usage: a message would wake it only to fail at once, and an ask would come back as that error. Said with who can
    // take it now, so the sender sends it there instead (Edge Defense, 2026-10-24: one agent out of usage was handed the same
    // board task twice and a review in four minutes, each ending in seconds on its limit).
    const out = req.system ? undefined : limitedLanes(state, events).get(to);
    if (out && runOf(state, to).status !== "running") {
      const free = freeAgents(state, events, [from, to]);
      return { ok: false, error: `${toName} is ${outOfUsage(state, out, Date.now())}, so it can't take this until then.${free.length ? ` Free now: ${free.map((n) => `"${n}"`).join(", ")}.` : " No other agent is free right now; carry on yourself, or say what you need from the people here."}` };
    }

    // A loop guard turns away this one message and nothing more: agent talk itself is never paused, so every agent stays
    // reachable (Arun, 2026-10-20: "do not pause agent to agent talking too ever").
    if (!req.system && hop + 1 > MAX_HOPS) {
      return { ok: false, error: `This would be the ${hop + 1}th agent in a row woken by another agent's message, so Friday didn't send it. Finish what you can, and say what you needed from ${toName}.` };
    }
    const leads = state.lead === from || state.lead === to;
    // The board handing out its own tasks isn't an agent chatting: no cap on how many it hands out.
    const pair = req.system ? 0 : exchangesBetween(events, from, to, Date.now() - PAIR_WINDOW_MS);
    if (pair >= (leads ? LEAD_PAIR : MAX_PAIR)) {
      return { ok: false, error: `You and ${toName} have sent each other ${pair} messages in the last 20 minutes, so Friday didn't send this one. Settle it yourself, or say what you need from the people here.` };
    }
    const since = runOf(state, from).sinceSeq;
    // A message to the team counts once, however many agents it went to.
    const sentThisRun = new Set(events.flatMap((e) => (e.seq > since && e.body.type === "instruction" && e.body.mesh?.fromLane === from && e.body.mesh.kind !== "reply" ? [e.body.mesh.team ?? e.body.mesh.id] : [])));
    const thisRun = sentThisRun.size;
    if (!req.system && !(req.team && sentThisRun.has(req.team)) && thisRun >= (state.lead === from ? LEAD_PER_RUN : MAX_PER_RUN)) return { ok: false, error: `This run has already sent ${thisRun} messages to other agents. Finish your own work, or ask a person.` };
    // Two agents each waiting on the other would both hang until their waits ran out.
    if (req.kind !== "tell" && waitsOn(state, to, from)) {
      const theirs = Object.values(meshOf(state).asks).find((a) => a.fromLane === to && a.toLane === from && !a.reply);
      return { ok: false, error: `${toName} is waiting on ${theirs ? `your answer to its question (id ${theirs.id})` : "an answer that comes back to you"}, so it can't answer you until you finish. Answer it first with reply_to_agent, or tell it with message_agent.` };
    }

    const id = randomBytes(5).toString("hex");
    // The board handing out work, a review or a rework is Friday acting on the board a person set going, not an agent woken by an
    // agent: it starts a chain rather than lengthening one. Counted on, a long session's board reached the cap by its own hand-offs
    // and an agent answering its reviewer was turned away as "the 5th agent in a row" (Arun, 2026-10-24: C2 couldn't reply to
    // Codex's review of t1, nor tell Chat with me what t2 needed).
    const mesh: MeshNote = { id, kind: req.kind, fromLane: from, fromName: laneName(state, from), toName, hop: req.system ? 1 : hop + 1, by: person, ...(req.board ? { board: req.board } : {}), ...(req.review ? { review: true } : {}), ...(req.carriedFrom ? { carriedFrom: req.carriedFrom } : {}), ...(req.team ? { team: req.team } : {}) };
    const sent = await this.store.append(sid, agentActor(mesh.fromName), { type: "instruction", text, interrupt: false, mesh }, { lane: to, expectDriver: driverOf(state, to)?.id ?? "" });
    if (!sent.ok) return { ok: false, error: `${toName} changed hands just now, so the message wasn't sent. Try again.` };
    void this.bus.wake(sid, to);
    const engine = state.engines[to];
    return { ok: true, id, to, toName, busy: runOf(state, to).status === "running", offline: !!engine?.tool && !engine.online };
  }

  /** Ask and wait for the answer, for as long as `wait` or the asker being stopped allow. */
  async ask(sid: string, from: string, req: { to: string; question: string }, wait: number, signal?: AbortSignal): Promise<MeshResult> {
    const r = await this.send(sid, from, { to: req.to, text: req.question, kind: "ask" });
    if (!r.ok) return { output: r.error, isError: true };
    if (r.offline) {
      await this.unwait(sid, from, r.id);
      return { output: `${r.toName} is offline, so it answers when it is back; the answer reaches you then as a message. Carry on with what you can do without it.` };
    }
    const got = await this.waitFor(sid, from, r.id, r.busy ? Math.min(wait, BUSY_ASK_WAIT_MS) : wait, signal);
    if ("reply" in got) return { output: `${r.toName} answered:\n\n${got.reply}` };
    const late = await this.unwait(sid, from, r.id);
    if (late !== null) return { output: `${r.toName} answered:\n\n${late}` };
    if ("gone" in got) return { output: `Stopped waiting for ${r.toName}. Its answer reaches you as a message when it comes.`, isError: true };
    return { output: `${r.toName} hasn't answered yet${r.busy ? " (it was busy with other work when you asked)" : ""}. Its answer reaches you as a message when it comes. Carry on with what you can do without it.` };
  }

  /** Wait on the bus for the answer to `id`, or the asker's run being stopped. */
  private waitFor(sid: string, from: string, id: string, wait: number, signal?: AbortSignal): Promise<Waited> {
    return new Promise((resolve) => {
      let done = false;
      let unsub: (() => Promise<void>) | null = null;
      const finish = (w: Waited) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        void unsub?.().catch(() => {});
        resolve(w);
      };
      const timer = setTimeout(() => finish({ timeout: true }), wait);
      timer.unref?.();
      const onAbort = () => finish({ gone: true });
      if (signal?.aborted) return finish({ gone: true });
      signal?.addEventListener("abort", onAbort);
      void this.bus
        .subscribe(sid, (m) => {
          if (m.kind !== "event") return;
          const b = m.event.body;
          if (b.type === "mesh.replied" && b.id === id) finish({ reply: b.text });
          else if ((b.type === "run.cancel" || b.type === "run.pause") && (m.event.lane ?? MAIN_LANE) === from) finish({ gone: true });
        })
        .then(async (u) => {
          unsub = u;
          if (done) return void u().catch(() => {});
          // Answered while the subscription was being made.
          const a = meshOf(await this.store.state(sid)).asks[id];
          if (a?.reply) finish({ reply: a.reply.text });
        })
        .catch(() => finish({ gone: true }));
    });
  }

  /**
   * The asker stops waiting. Exactly one side delivers an answer that crosses this: if it was logged before the stop, the asker
   * is handed it here (returned); if after, deliver() sees the stop and sends it as a message.
   */
  private async unwait(sid: string, from: string, id: string): Promise<string | null> {
    const r = await this.store.append(sid, FRIDAY, { type: "mesh.unwaited", id }, { lane: from });
    const a = meshOf(await this.store.state(sid)).asks[id];
    return r.ok && a?.reply && a.reply.seq < r.seq ? a.reply.text : null;
  }

  /** Log the answer to an ask, and, when the asker stopped waiting before it, send it as a message. */
  async deliver(sid: string, ask: MeshAsk, text: string, auto: boolean, urgent = false): Promise<void> {
    const body: EventBody = { type: "mesh.replied", id: ask.id, fromLane: ask.toLane, fromName: ask.toName, toLane: ask.fromLane, toName: ask.fromName, text: text.slice(0, MAX_TEXT), ...(auto ? { auto: true } : {}) };
    const r = await this.store.append(sid, agentActor(ask.toName), body, { lane: ask.fromLane });
    if (!r.ok) return;
    if (ask.task) return this.reportToLead(sid, ask, urgent);
    const a = meshOf(await this.store.state(sid)).asks[ask.id];
    if (a?.unwaitedSeq === undefined || a.unwaitedSeq > r.seq) return;
    const mesh: MeshNote = { id: randomBytes(5).toString("hex"), kind: "reply", re: ask.id, ...(ask.task ? { ofTask: true } : {}), fromLane: ask.toLane, fromName: ask.toName, toName: ask.fromName, hop: ask.hop, by: ask.by };
    await this.store.append(sid, agentActor(ask.toName), { type: "instruction", text: text.slice(0, MAX_TEXT), interrupt: false, mesh }, { lane: ask.fromLane });
    void this.bus.wake(sid, ask.fromLane);
  }

  /**
   * A task's report, to the lead that assigned it, in batches (Arun, 2026-10-19: "so everything isn't delegated to the boss").
   * Each report waking the lead made it a router, re-reading one report at a time while the rest of the team waited on it.
   * Now a report waits in the lead's inbox (check_messages shows it at once), and the lead is woken once, with every report
   * of the batch together, when its last open task is done, or straight away when one is blocked or failed.
   */
  private async reportToLead(sid: string, ask: MeshAsk, urgent: boolean): Promise<void> {
    const [state, events] = await Promise.all([this.store.state(sid), this.store.events(sid)]);
    const lead = ask.fromLane;
    const mine = Object.values(meshOf(state).asks).filter((a) => a.task && a.fromLane === lead);
    const open = mine.filter((a) => !a.reply);
    if (open.length && !urgent) return;
    // Since the lead last got a batch: every report it hasn't been handed.
    const lastBatch = events.findLast((e) => (e.lane ?? MAIN_LANE) === lead && e.body.type === "instruction" && e.body.mesh?.batch)?.seq ?? 0;
    const reports = mine.filter((a) => a.reply && a.reply.seq > lastBatch).sort((a, b) => a.reply!.seq - b.reply!.seq);
    if (!reports.length) return;
    const text = [
      ...reports.map((a) => `## ${a.toName}: ${clip(a.text.split("\n")[0]!.trim(), 120)}\n${a.reply!.text}`),
      open.length ? `Still working: ${open.map((a) => `${a.toName} (${clip(a.text.split("\n")[0]!.trim(), 80)})`).join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, MAX_TEXT * 2);
    const mesh: MeshNote = { id: randomBytes(5).toString("hex"), kind: "reply", re: ask.id, ofTask: true, batch: open.length ? "early" : "done", fromLane: ask.toLane, fromName: ask.toName, toName: ask.fromName, hop: ask.hop, by: ask.by };
    const sent = await this.store.append(sid, agentActor(open.length ? ask.toName : "The team"), { type: "instruction", text, interrupt: false, mesh }, { lane: lead });
    if (!sent.ok) return;
    // Handed together: the reports are read, and check_messages doesn't offer them again.
    await this.store.append(sid, FRIDAY, { type: "mesh.read", upTo: sent.seq }, { lane: lead });
    void this.bus.wake(sid, lead);
  }

  /** reply_to_agent: answer a question asked of this agent, now. */
  async reply(sid: string, lane: string, req: { id: string; text: string }): Promise<MeshResult> {
    const text = req.text.trim();
    if (!text) return { output: "The answer is empty.", isError: true };
    const open = Object.values(meshOf(await this.store.state(sid)).asks).filter((a) => a.toLane === lane && !a.reply);
    const ask = req.id ? open.find((a) => a.id === req.id.trim()) : open.sort((a, b) => b.seq - a.seq)[0];
    if (!ask) return { output: req.id ? `No question with id ${req.id} is waiting for your answer.` : "No agent is waiting for an answer from you.", isError: true };
    await this.deliver(sid, ask, text, false);
    return { output: `Sent your answer to ${ask.fromName}.` };
  }

  async notes(sid: string): Promise<string> {
    const m = (await this.store.state(sid)).memory.filter((x) => x.text.trim());
    return m.length ? `The session's notes:\n${m.map((x) => `- ${x.key}: ${x.text}`).join("\n")}` : "The session has no notes yet.";
  }

  async writeNote(sid: string, lane: string, rawKey: string, note: string): Promise<MeshResult> {
    const key = rawKey.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 48);
    const text = note.trim().slice(0, 600);
    if (!key || !text) return { output: "Both key and note are needed.", isError: true };
    const state = await this.store.state(sid);
    await this.store.append(sid, agentActor(laneName(state, lane)), { type: "memory.saved", key, text }, { lane });
    return { output: `Noted under "${key}". Every agent here can read it.` };
  }

  /**
   * assign_task: the lead gives another agent a piece of the work. Sent like a question nobody waits on, so the agent's report
   * at the end of it comes back to the lead as a message, and wakes it to carry on.
   */
  async assign(sid: string, lane: string, to: string, task: string): Promise<MeshResult> {
    const state = await this.store.state(sid);
    if (state.lead !== lane) return { output: `Only the agent leading this session assigns work${state.lead ? ` (${laneName(state, state.lead)} leads it)` : ", and none does: a person makes one the lead"}. Use message_agent or ask_agent instead.`, isError: true };
    // Who else is on this job and what each has: the agents settle what they share between themselves, not through the lead.
    const others = Object.values(meshOf(state).asks).filter((a) => a.task && a.fromLane === lane && !a.reply);
    const team = others.length
      ? `\n\n[Friday] Also on this job, from ${laneName(state, lane)}:\n${others.map((a) => `- ${a.toName}: ${clip(a.text.split("\n")[0]!.trim(), 140)}`).join("\n")}\nAgree anything you share with them (an interface, a file, a schema) with them directly: ask_agent, post_update. Not through ${laneName(state, lane)}.`
      : "";
    // A big piece says it may be split with the agent's own sub-agents, as a big board task does (taskBrief).
    const big = splits({ owns: [], detail: task }) ? `\n\n[Friday] ${SPLIT_HINT}` : "";
    const r = await this.send(sid, lane, { to, text: `${task.trim()}${big}${team}`, kind: "task" });
    if (!r.ok) return { output: r.error, isError: true };
    await this.unwait(sid, lane, r.id);
    const near = this.near(sid, r.to);
    const room = near ? ` Its ${near.label} usage is ${near.pct}% used: if it runs out partway, Friday hands the task to an agent with room, with what it did.` : "";
    return { output: `${room ? `${room.trim()}\n\n` : ""}Assigned to ${r.toName}${r.offline ? ", which is offline: it starts when it is back" : r.busy ? ", which finishes what it is doing first and then starts this as a turn of its own" : ", which is starting on it now"}. Assign the other pieces now so they run at the same time. You are woken once, with every report together, when all your tasks are done (sooner if one is blocked); check_messages shows reports as they come.` };
  }

  /**
   * show_preview from a coding tool: the page it started, opened in the session's Preview panel for everyone watching (Arun,
   * 2026-10-19: "make sure the coding tools are using the preview side panel"). An agent that only said "it's running on
   * 4174" left the panel empty and went off to install its own browser to look; this is the one call that shows it.
   */
  async showPreview(sid: string, lane: string, args: Record<string, unknown>): Promise<MeshResult> {
    const state = await this.store.state(sid);
    const name = laneName(state, lane);
    if (args.ios === true) {
      const folder = typeof args.folder === "string" && path.isAbsolute(args.folder.trim()) ? args.folder.trim().replace(/\/+$/, "").replace(/\/[^/]+\.(?:xcodeproj|xcworkspace)$/, "").slice(0, 500) : "";
      await this.store.append(sid, agentActor(name), { type: "preview.asked", ios: true, ...(folder ? { folder } : {}) }, { lane });
      return { output: "Asked Friday to build the folder's iOS app and show it in the Preview panel's iOS side. It appears there when it is running." };
    }
    const url = localPage(args.url);
    if (!url.ok) return { output: url.error.replace("{what}", "opens in the Preview panel"), isError: true };
    const newTab = args.new_tab === true;
    await this.store.append(sid, agentActor(name), { type: "preview.asked", url: url.url, ...(newTab ? { newTab: true } : {}) }, { lane });
    return { output: `Opened ${url.url} in the Preview panel beside the chat${newTab ? ", in a tab of its own" : ""}; the people here can see it now. If it isn't serving yet it shows as soon as it is. Each page you open this way gets its own tab when it is on another server, so you can show several at once.` };
  }

  // ── the shared task board ─────────────────────────────────────────────

  /** post_tasks: a plan on the board, the lead's when there is one. Ready tasks go to idle agents at once. */
  async postTasks(sid: string, lane: string, raw: unknown[], check = ""): Promise<MeshResult> {
    const state = await this.store.state(sid);
    if (state.lead && state.lead !== lane) return { output: `${laneName(state, state.lead)} leads this session, so it posts the board. Tell it what you'd add (message_agent).`, isError: true };
    if (state.board && boardBusy(state) && state.board.fromLane !== lane) return { output: `${state.board.fromName}'s board is still being worked on. Add to it through ${state.board.fromName}.`, isError: true };
    const used = new Set<string>();
    const tasks: BoardTaskDef[] = raw.slice(0, MAX_BOARD_TASKS).flatMap((x, i) => {
      if (!x || typeof x !== "object") return [];
      const t = x as Record<string, unknown>;
      const title = str(t.title).trim().slice(0, 140);
      const detail = str(t.detail).trim().slice(0, 4000);
      if (!title) return [];
      let id = (str(t.id).trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 24) || `t${i + 1}`).replace(/^-|-$/g, "") || `t${i + 1}`;
      while (used.has(id)) id = `${id}-${i + 1}`;
      used.add(id);
      const list = (v: unknown) => (Array.isArray(v) ? v.filter((y): y is string => typeof y === "string").map((y) => y.trim()).filter(Boolean).slice(0, 20) : []);
      return [{ id, title, detail: detail || title, owns: list(t.owns), after: list(t.after).map((a) => a.toLowerCase()), ...(str(t.agent).trim() ? { agent: str(t.agent).trim().slice(0, 40) } : {}), ...(str(t.check).trim() ? { check: str(t.check).trim().slice(0, 400) } : {}) }];
    });
    if (!tasks.length) return { output: "Give at least one task, each with a title and what to do.", isError: true };
    // Waiting on a task that isn't there would never start.
    for (const t of tasks) t.after = t.after.filter((a) => used.has(a) && a !== t.id);
    const fromName = laneName(state, lane);
    await this.store.append(sid, agentActor(fromName), { type: "board.posted", fromLane: lane, fromName, tasks, ...(check.trim() ? { check: check.trim().slice(0, 400) } : {}) }, { lane });
    this.live.add(sid);
    const handed = await this.dispatch(sid);
    return { output: `Posted ${tasks.length} task${tasks.length === 1 ? "" : "s"} to the board. ${handed.length ? `Handed out now: ${handed.join(", ")}.` : "No agent is free right now; each takes the next ready task when it finishes."} The rest go as agents free up and as what they wait on is done. You hear how it went once the board is done (sooner if one is blocked); do your own piece meanwhile, or claim_task one.` };
  }

  /** claim_task: an agent takes a ready task itself, inside the turn it is in. */
  async claim(sid: string, lane: string, id: string): Promise<MeshResult> {
    const state = await this.store.state(sid);
    if (!state.board) return { output: "There's no task board in this session.", isError: true };
    const name = laneName(state, lane);
    // One at a time: a second task taken mid-turn would share this turn and its report with the first.
    const holding = state.board.tasks.find((x) => (x.status === "claimed" && x.lane === lane) || (x.status === "review" && x.reviewer?.lane === lane));
    if (holding) return { output: `You already have "${holding.id}" ${holding.title}${holding.status === "review" ? " to check" : ""}. Finish it first (finish_task, or end your turn with a report); then take the next.`, isError: true };
    const ready = readyTasks(state);
    // A stuck task, named, can be taken back (Arun, 2026-10-21: C2 had done the work and three agents had approved it, but the
    // task stayed "blocked" for good, as nothing an agent could call moved a blocked task on). Never by one that turned it down.
    const key = id.trim().toLowerCase();
    const stuck = key ? state.board.tasks.find((x) => x.id === key && x.status === "blocked" && !(x.declined ?? []).includes(name)) : undefined;
    const t = stuck ?? (key ? ready.find((x) => x.id === key) : (ready.find((x) => suits(x, name)) ?? ready[0]));
    if (!t) return { output: id ? `Task "${id}" isn't ready to take: ${boardLine(state.board.tasks.find((x) => x.id === id.trim().toLowerCase()))}` : "No task is ready right now: the rest wait on others or are taken.", isError: true };
    await this.store.append(sid, agentActor(name), { type: "board.claimed", id: t.id, lane, name }, { lane });
    return { output: `${taskBrief(state, t)}\n\nIt's yours. When you're done, call finish_task with id "${t.id}" and a short report.` };
  }

  /** finish_task, or a board task's run ending: the report goes on the board, and a review or what waits on it goes next. */
  async finish(sid: string, lane: string, id: string, report: string, blocked: boolean, decline = false): Promise<MeshResult> {
    const [state, events] = await Promise.all([this.store.state(sid), this.store.events(sid)]);
    const t = state.board?.tasks.find((x) => x.id === id.trim().toLowerCase());
    // Yours, in progress or stuck: a task marked blocked stays its agent's to finish once whatever blocked it is sorted. Before,
    // finish_task refused it ("you don't have it in progress") and claim_task refused it (not ready), so finished, approved work
    // sat as "Stuck" until a person pressed Try again (Arun, 2026-10-21). The agent that posted the board can finish a stuck task
    // too, for its agent: the lead that unblocked it shouldn't have to wait on another turn of that agent.
    const own = !!t && t.lane === lane && (t.status === "claimed" || t.status === "blocked");
    const forLead = !!t && !own && t.status === "blocked" && lane === state.board!.fromLane;
    if (!t || !(own || forLead)) return { output: t ? `Task "${t.id}" isn't yours to finish: ${boardLine(t)}.` : `There's no task "${id}" on the board.`, isError: true };
    const doer = forLead && t.lane ? t.lane : lane;
    const since = events.findLast((e) => e.body.type === "board.claimed" && e.body.id === t.id) ?? events.at(-1)!;
    const facts = factsOf(state, events, doer, since, events.at(-1)!);
    const name = forLead ? (t.name ?? laneName(state, doer)) : laneName(state, lane);
    // Turned down, not stuck (Arun, 2026-10-21: most of a board's "Stuck" was one agent saying "not mine, releasing" over and
    // over, as the board kept handing it work its lead had told it to stay off). It goes back on the board for someone else,
    // and is never offered to this agent again. Said in the report without the flag, and nothing changed, counts the same.
    const changed = state.claims.some((c) => c.lane === doer && c.seq > since.seq);
    // Judged on its opening, whatever it marked: "Skipping t4, as Boss asked. Chat with me owns it" with nothing changed was taken
    // as done, passed as "Nothing changed to check", and t4 was "Checked" while nobody had done it (Arun, 2026-10-24).
    if (own && (decline || (!changed && DECLINED.test(opening(report))))) {
      const why = clip(report.trim().split("\n")[0] ?? "", 200);
      await this.store.append(sid, FRIDAY, { type: "board.released", id: t.id, why: `${name} turned it down${why ? `: ${why}` : ""}`, declined: name }, { lane: state.board!.fromLane });
      const handed = await this.dispatch(sid);
      return { output: `Given back; it won't be offered to you again.${handed.length ? ` Handed out: ${handed.join(", ")}.` : ""}` };
    }
    const text = `${report.trim() || "Finished without a report."}\n\n${facts}`.slice(0, MAX_TEXT);
    const by = forLead ? laneName(state, lane) : name;
    await this.store.append(sid, agentActor(by), { type: "board.finished", id: t.id, lane: doer, name, status: blocked ? "blocked" : "done", report: forLead ? `${by}, for ${name}: ${text}` : text }, { lane: doer });
    if (blocked) await this.reportBoard(sid, true);
    // Its checks first, in its own folder: a failure goes straight back, without spending a review on it.
    else if (await this.runChecks(sid, t.id)) await this.reviewOrPass(sid, t.id);
    const handed = await this.dispatch(sid);
    const next = readyTasks(await this.store.state(sid)).find((x) => suits(x, name)) ?? readyTasks(await this.store.state(sid))[0];
    return { output: `${blocked ? "Marked blocked; the lead (or whoever posted the board) hears it now. It stays yours: once it is unblocked, call finish_task on it again." : "Finished; another agent checks it."}${handed.length ? ` Handed out: ${handed.join(", ")}.` : ""}${next ? ` Next ready: "${next.id}" ${next.title}. claim_task to take it.` : ""}` };
  }

  /** A finished task is checked by another agent before it counts; one that changed nothing has nothing to check. */
  /**
   * A finished task's checks, run by Friday in its agent's folder (Arun, 2026-10-19: "find gaps"): the task's own command, the
   * board's, or the project's typecheck. True when it may go on to review (passed, or nothing could be run); false when it
   * went back to its agent with what failed, or, after MAX_REWORK, to the lead as blocked.
   */
  async runChecks(sid: string, id: string): Promise<boolean> {
    if (!this.repo) return true;
    const state = await this.store.state(sid);
    const t = state.board?.tasks.find((x) => x.id === id);
    if (!t?.lane || t.status !== "review") return true;
    const lane = t.lane;
    const pkg = () => this.repo!(sid, lane, { op: "read", path: "package.json", raw: true }).catch(() => null);
    let command = t.check ?? state.board?.check ?? inferCheck(await pkg());
    // The board's whole suite, for a task with no check of its own, also runs the tests of pieces other agents haven't finished:
    // it failed for every helper while the rest were still stubs. Only this task's own tests, when they can be told apart.
    if (!t.check && state.board?.check && TEST_CMD.test(state.board.check)) {
      const listed = await this.repo(sid, lane, { op: "shell", command: "git ls-files --cached --others --exclude-standard", timeoutSec: 30 } as RepoCall).catch(() => null);
      const files = [...t.owns, ...(state.diffs[lane]?.files ?? []).map((f) => f.path)];
      command = ownTestCommand(state.board.check, await pkg(), testsFor(files, shellLines(listed))) || command;
    }
    if (!command) return true;
    await this.store.append(sid, FRIDAY, { type: "board.checking", id, lane, command }, { lane });
    const out = await this.repo(sid, lane, { op: "shell", command, timeoutSec: CHECK_SECONDS } as RepoCall).catch((e: Error) => `Couldn't run it: ${e.message}`);
    const verdict = checkVerdict(out);
    const output = clip(out ?? "", 4000);
    await this.store.append(sid, FRIDAY, { type: "board.checked", id, lane, command, ok: verdict !== "failed", output, ...(verdict === "skipped" ? { skipped: true } : {}) }, { lane });
    if (verdict !== "failed") return true;
    const after = (await this.store.state(sid)).board?.tasks.find((x) => x.id === id);
    if (!after) return false;
    if (after.rounds > MAX_REWORK) {
      await this.store.append(sid, FRIDAY, { type: "board.finished", id, lane, name: after.name ?? "", status: "blocked", report: `Its checks failed ${after.rounds} times; the last run of \`${command}\`:\n${clip(out ?? "", 1500)}` }, { lane });
      await this.reportBoard(sid, true);
      return false;
    }
    await this.send(sid, state.board!.fromLane, { to: after.name ?? laneName(state, lane), text: `Friday ran \`${command}\` in your folder after you finished "${after.title}", and it failed:\n\n${clip(out ?? "", 3000)}\n\nFix it, then end your turn with a short report as before. It runs again when you do.`, kind: "task", board: id, system: true });
    return false;
  }

  /**
   * A person's say over a board task, from the team's list (Arun, 2026-10-19): `reassign` takes it back to hand to another agent
   * (or to `to`), `retry` opens a stuck or dropped one again, `sendback` returns a finished one to its agent with a note, and
   * `cancel` drops it, so what waited on it goes ahead without it. The agent that had it is told to stop.
   */
  async control(sid: string, actor: ActorRef, req: { id: string; action: "reassign" | "retry" | "sendback" | "cancel"; to?: string; note?: string }): Promise<{ ok: true } | { ok: false; error: string }> {
    const state = await this.store.state(sid);
    const b = state.board;
    const t = b?.tasks.find((x) => x.id === req.id);
    if (!b || !t) return { ok: false, error: "That task isn't on the board any more." };
    const holder = t.status === "claimed" ? t.lane : t.status === "review" ? (t.reviewer?.lane ?? t.lane) : undefined;
    const stop = async (why: string) => {
      if (!holder) return;
      await this.send(sid, b.fromLane, { to: laneName(state, holder), text: `${actor.name} ${why} the board task "${t.title}". Stop working on it and leave its files as they are; don't call finish_task for it.`, kind: "tell", system: true }).catch(() => undefined);
    };
    if (req.action === "cancel") {
      if (t.status === "done" || t.status === "cancelled") return { ok: false, error: "It's already finished." };
      await stop("dropped");
      await this.store.append(sid, actor, { type: "board.cancelled", id: t.id }, { lane: b.fromLane });
    } else if (req.action === "reassign" || req.action === "retry") {
      if (t.status === "done" || (req.action === "retry" && t.status !== "blocked" && t.status !== "cancelled")) return { ok: false, error: req.action === "retry" ? "Only a stuck or dropped task can be tried again." : "It's already done." };
      const to = req.to ? lanesOf(state).find((l) => l === req.to || laneName(state, l).toLowerCase() === req.to!.toLowerCase()) : undefined;
      if (req.to && !to) return { ok: false, error: `There's no agent called ${req.to} here.` };
      if (to && to === holder) return { ok: false, error: `${laneName(state, to)} already has it.` };
      await stop("took back");
      // A stuck task its agent had turned down ("not mine, releasing") goes anywhere but back to that agent.
      const turnedDown = t.status === "blocked" && t.name && DECLINED.test(t.report ?? "") ? { declined: t.name } : {};
      await this.store.append(sid, actor, { type: "board.released", id: t.id, why: req.action === "retry" ? "tried again" : "reassigned", ...(to ? { to: laneName(state, to) } : {}), ...turnedDown }, { lane: b.fromLane });
    } else {
      if (t.status !== "done" && t.status !== "review") return { ok: false, error: "Only a finished task can be sent back." };
      if (!t.lane) return { ok: false, error: "Nobody did it to send it back to." };
      await this.store.append(sid, actor, { type: "board.reviewed", id: t.id, lane: "", name: actor.name, ok: false, note: req.note?.trim().slice(0, 2000) || "Have another look." }, { lane: t.lane });
      await this.send(sid, b.fromLane, { to: t.name ?? laneName(state, t.lane), text: `${actor.name} sent "${t.title}" back to you:\n${req.note?.trim() || "Have another look."}\n\nFix it, then end your turn with a short report as before.`, kind: "task", board: t.id, system: true });
    }
    this.live.add(sid);
    await this.dispatch(sid);
    // Picked an agent the task couldn't reach (somebody else's to steer, one that takes no messages): said to the person, and
    // the task is left for whoever is free rather than "Waiting for" an agent it will never reach.
    const why = req.action === "reassign" && req.to ? this.refused.get(`${sid}|${t.id}`) : undefined;
    if (why) {
      this.refused.delete(`${sid}|${t.id}`);
      const now = (await this.store.state(sid)).board?.tasks.find((x) => x.id === t.id);
      if (now?.status === "open" && now.next) await this.store.append(sid, actor, { type: "board.released", id: t.id, why: "reassigned" }, { lane: b.fromLane });
      await this.dispatch(sid);
      await this.afterBoardMove(sid);
      return { ok: false, error: why };
    }
    await this.afterBoardMove(sid);
    return { ok: true };
  }

  /**
   * An agent's computer went away (engine.detached). Its board work stays its own for now: most drops are a deploy or a Wi-Fi
   * change, back in seconds with the turn carrying on, and handing the task to another agent at once had two agents on it
   * (Arun, 2026-10-24: most "computer disconnected" releases were that). The sweep gives it to someone else once the machine
   * has stayed away for OFFLINE_STALL_MS. What else is ready goes out meanwhile.
   */
  async onEngineGone(sid: string, _lane: string): Promise<void> {
    if ((await this.store.state(sid)).board) await this.dispatch(sid);
  }

  /**
   * Somebody stopped (or cancelled) the agent on `lane`: its task ends, the agent doesn't (Arun, 2026-10-20: "all of the agents
   * should be on standby and ready"). A stop logs no run end, so what onRunEnded settles was left hanging: an agent that asked
   * this one waited for an answer that never came, a lead never heard back on the task it assigned, and a board task kept the
   * agent counted as busy, so the board handed it nothing. Each is settled here as the turn's end would be: what it had said
   * so far, or that it was stopped; its board task goes to the lead as blocked rather than straight back to it. Then the agent
   * is free like any idle one, and what is ready is handed out.
   */
  async onRunStopped(sid: string, lane: string, by: string, cancelled = false): Promise<void> {
    const [state, events] = await Promise.all([this.store.state(sid), this.store.events(sid)]);
    const stop = events.findLast((e) => (e.lane ?? MAIN_LANE) === lane && (e.body.type === "run.pause" || e.body.type === "run.cancel"));
    if (!stop) return;
    const name = laneName(state, lane);
    const start = events.findLast((e) => e.seq < stop.seq && e.body.type === "run.started" && (e.lane ?? MAIN_LANE) === lane);
    const queued = new Set(pendingFor(state, lane));
    for (const ask of Object.values(meshOf(state).asks).filter((a) => a.toLane === lane && !a.reply)) {
      // Still queued (a Stop keeps the queue): it is the agent's next turn, and answered at that turn's end.
      if (queued.has(ask.seq) || state.withdrawn.includes(ask.seq)) continue;
      const got = events.find((e) => e.body.type === "instructions.delivered" && (e.lane ?? MAIN_LANE) === lane && e.body.seqs.includes(ask.seq));
      if (got && got.seq > stop.seq) continue;
      const said = got ? answerFrom(events, lane, got.seq, stop.seq) : "";
      const what = `${by} ${cancelled ? "cancelled" : "stopped"} ${name}'s task before it ${got ? "finished" : "got to this"}. It is ready again: ask once more if you still need it.`;
      await this.deliver(sid, ask, said ? `${said}\n\n(${what})` : what, true, true);
    }
    const b = state.board;
    if (b && start)
      for (const t of b.tasks) {
        if (t.status !== "claimed" || t.lane !== lane || !ranTask(events, lane, start.seq, stop.seq, t.id)) continue;
        await this.store.append(sid, FRIDAY, { type: "board.finished", id: t.id, lane, name, status: "blocked", report: `${by} stopped ${name} on it. ${name} is free again; reassign or retry it.` }, { lane });
        await this.reportBoard(sid, true);
      }
    await this.dispatch(sid);
  }

  /**
   * Now and then, for each board being worked on: a task whose agent is neither working nor waiting on anyone, with nothing
   * queued for it, quiet for STALL_MS, goes back on the board, once; after that it is marked stuck for the lead. And whatever
   * is ready is handed to whoever is free, in case a wake was lost.
   */
  async sweep(sid: string, now = Date.now()): Promise<void> {
    const [state, events] = await Promise.all([this.store.state(sid), this.store.events(sid)]);
    const b = state.board;
    if (!b || !boardBusy(state)) return void this.live.delete(sid);
    for (const t of b.tasks) {
      const lane = t.status === "claimed" ? t.lane : t.status === "review" ? t.reviewer?.lane : undefined;
      if (!lane || t.checks?.running) continue;
      const run = runOf(state, lane).status;
      const name = laneName(state, lane);
      // Its turn on the task ended and the board never heard: the run-end hook was lost, as it is when a run ends while the
      // server is being replaced. Settled now from that turn, its report or its verdict, before anything else: t2's finished work
      // was left "Not finished", then handed back as its computer went offline, and done again by someone else (Arun,
      // 2026-10-24: "look into why things get stuck"). The task's own turn, not merely the lane's last: the lead had since
      // messaged it about something else.
      if (run !== "running" && run !== "waiting_for_human") {
        const end = unheardEnd(events, t.id, lane, t.status === "review");
        if (end) {
          await this.boardRunEnded(sid, lane, end.seq);
          const after = (await this.store.state(sid)).board?.tasks.find((x) => x.id === t.id);
          if (after && (after.status !== t.status || after.lane !== t.lane || after.reviewer?.lane !== t.reviewer?.lane)) continue;
        }
      }
      // Its computer gone with the task: given to someone who is here, and it is told to leave it when it comes back. A task
      // stayed with an agent whose laptop had shut for as long as the laptop stayed shut (hours, in Edge Defense's session).
      const engine = state.engines[lane];
      if (engine?.tool && !engine.online) {
        const gone = events.findLast((e) => (e.lane ?? MAIN_LANE) === lane && e.body.type === "engine.detached");
        if (!gone || now - gone.ts < OFFLINE_STALL_MS) continue;
        await this.store.append(sid, FRIDAY, { type: "board.released", id: t.id, why: `${name}'s computer went offline` }, { lane: b.fromLane });
        await this.send(sid, b.fromLane, { to: name, toLane: lane, text: `While your computer was offline, the board task "${t.title}" went to another agent. Leave it and its files as they are; don't call finish_task for it.`, kind: "tell", system: true }).catch(() => undefined);
        continue;
      }
      // Still working, but nothing done for a long while: its lead is told once, to check on it or move the task. The runner
      // restarts a tool that has hung (hung.ts); this is the agent going round in circles, or waiting on something nobody sees.
      if (run === "running") {
        const last = events.findLast((e) => (e.lane ?? MAIN_LANE) === lane);
        const key = `${sid}|${t.id}|${last?.seq ?? 0}`;
        if (last && now - last.ts >= QUIET_RUN_MS && !this.quietTold.has(key)) {
          this.quietTold.add(key);
          await this.tellLead(sid, `${name} took "${t.title}" ${span(now - (events.find((e) => e.body.type === "board.claimed" && e.body.id === t.id)?.ts ?? last.ts))} ago and hasn't done anything for ${span(now - last.ts)}. Check on it with message_agent, or if it's stuck, tell the person here so they can stop it and the task can go to someone else.`);
        }
        continue;
      }
      if (run === "waiting_for_human" || pendingFor(state, lane).length) continue;
      const last = events.findLast((e) => (e.lane ?? MAIN_LANE) === lane);
      if (!last || now - last.ts < STALL_MS) continue;
      // A person told this agent something since it took the task: they're steering it, so it stays theirs to move.
      const took = events.findLast((e) => e.body.type === "board.claimed" && e.body.id === t.id)?.seq ?? 0;
      if (events.some((e) => e.seq > took && (e.lane ?? MAIN_LANE) === lane && e.body.type === "instruction" && !e.body.mesh && e.actor.kind === "human")) continue;
      const before = events.filter((e) => e.body.type === "board.released" && e.body.id === t.id).length;
      if (before >= 1) await this.store.append(sid, FRIDAY, { type: "board.finished", id: t.id, lane, name: laneName(state, lane), status: "blocked", report: `${laneName(state, lane)} went quiet on it twice; nobody is working on it.` }, { lane });
      // Not straight back to the agent that went quiet on it while another could take it: it was handed back to it at once.
      else {
        const others = lanesOf(state).some((l) => l !== lane && l !== b.fromLane && laneOf(state, l)?.control.kind !== "standing");
        await this.store.append(sid, FRIDAY, { type: "board.released", id: t.id, why: `${laneName(state, lane)} went quiet on it`, ...(others ? { declined: laneName(state, lane) } : {}) }, { lane: b.fromLane });
      }
    }
    await this.dispatch(sid);
    await this.afterBoardMove(sid);
  }

  private async reviewOrPass(sid: string, id: string): Promise<void> {
    const state = await this.store.state(sid);
    const t = state.board?.tasks.find((x) => x.id === id);
    if (!t || t.status !== "review" || t.reviewer) return;
    const checkers = lanesOf(state).filter((l) => l !== t.lane && laneOf(state, l)?.control.kind !== "standing");
    // Its own tests ran in its folder and passed, on a small change: a second agent reading it again cost the team about 7s and
    // 250k tokens a task in the benchmark (scripts/bench/REPORT-team.md) and found nothing tests hadn't (Arun, 2026-10-24: "skip
    // the cross-review when a task's own tests passed and its change is small"). A typecheck alone isn't its tests.
    const lines = t.lane ? (state.diffs[t.lane]?.files ?? []).reduce((n, f) => n + f.additions + f.deletions, 0) : 0;
    const tested = !!t.checks?.ok && !t.checks.skipped && !t.checks.running && TEST_CMD.test(t.checks.command);
    const small = tested && lines > 0 && lines <= SMALL_CHANGE ? `Its tests passed (${t.checks!.command}) on a small change (${lines} lines), so it goes through without a second agent's check.` : "";
    const nothing = /\bno files changed\b/.test(t.report ?? "") ? "Nothing changed to check." : !checkers.length ? "No other agent here to check it." : small;
    if (nothing) {
      await this.store.append(sid, FRIDAY, { type: "board.reviewed", id, lane: "", name: "Friday", ok: true, note: nothing }, { lane: t.lane ?? MAIN_LANE });
      await this.afterBoardMove(sid);
      return;
    }
    await this.dispatch(sid);
  }

  /** Who could take work now: not working, nothing queued, online, taking messages, and not the one who posted the board. */
  private idle(state: SessionState, poster = false): string[] {
    return lanesOf(state).filter((l) => {
      if ((!poster && l === state.board?.fromLane) || laneOf(state, l)?.control.kind === "standing") return false;
      const e = state.engines[l];
      if (e?.tool && !e.online) return false;
      if (runOf(state, l).status !== "idle" && runOf(state, l).status !== "error") return false;
      if (pendingFor(state, l).length) return false;
      return !state.board?.tasks.some((t) => (t.status === "claimed" && t.lane === l) || (t.status === "review" && t.reviewer?.lane === l));
    });
  }

  /**
   * Hand what is ready to who is free: reviews first (they unlock the rest), then ready tasks, each to an agent that suits it
   * when the poster named one. Returns what it handed out, for whoever asked.
   */
  /** Why a person's pick of agent for a task (`next`) couldn't reach it, by session and task: said to them by control. */
  private refused = new Map<string, string>();

  async dispatch(sid: string): Promise<string[]> {
    let state = await this.store.state(sid);
    const b = state.board;
    if (!b) return [];
    this.live.add(sid);
    const handed: string[] = [];
    // Agents not to hand work to this time round: one a message can't reach (a teammate's own coding tool the board's person
    // can't steer), and one a person is using right now, whose next message is theirs to send, not the board's.
    const evs = await this.store.events(sid);
    const skip = new Set(inUse(evs, Date.now(), b.fromLane));
    // Out of usage until its limit lifts: nothing goes to it, a review included.
    const limited = new Set(limitedLanes(state, evs).keys());
    for (const l of limited) skip.add(l);
    /** Tasks a person handed to one agent, tried once this round (see `chosen` below). */
    const tried = new Set<string>();
    const skills = await this.skillsFor(state);
    /**
     * The free agent best at this task's kind (strengths.ts), keeping the order given where none stands out, and why it, when
     * there was more to it than being free: said on the task (board.claimed), for "why did this go to X?".
     */
    const bestFor = (t: BoardTask, lanes: string[]): { to: string; why?: string } | undefined => {
      if (!lanes.length) return undefined;
      const near = new Set(lanes.filter((l) => this.near(sid, l)));
      const roomy = near.size && near.size < lanes.length ? "the others free are nearly out of usage" : undefined;
      const kind = taskKind(`${t.title} ${t.detail}`);
      if (!kind || lanes.length < 2) return { to: lanes[0]!, ...(roomy ? { why: roomy } : {}) };
      const toolOf = (l: string) => state.engines[l]?.tool ?? "friday";
      const score = (l: string) => (near.has(l) ? -1 : 0) + skillOf(skills, toolOf(l), kind);
      const to = lanes.reduce((best, l) => (score(l) > score(best) + 0.05 ? l : best), lanes[0]!);
      const s = skills[`${toolOf(to)}|${kind}`];
      const why = to !== lanes[0] && s?.n ? `best at ${KIND_WORDS[kind]} here: ${Math.round(s.ok)} of ${s.n} through review first time` : roomy;
      return { to, ...(why ? { why } : {}) };
    };
    for (let guard = 0; guard < MAX_BOARD_TASKS * 2; guard++) {
      state = await this.store.state(sid);
      // One nearly out of usage last: a task started there may stop partway on its limit.
      const free = this.roomFirst(sid, this.idle(state).filter((l) => !skip.has(l)));
      // A review may go to the poster too when nobody else is free: checked by someone is what matters.
      const reviewers = [...free, ...this.idle(state, true).filter((l) => !free.includes(l) && !skip.has(l))];
      const review = state.board!.tasks.find((t) => t.status === "review" && !t.reviewer && reviewers.some((l) => l !== t.lane));
      if (review) {
        // One that can open the work, on the same computer, before one that can't: a reviewer on another computer answered "I
        // couldn't review this one" with no diff to read, and the task went round again for nothing (Arun, 2026-10-24, t3).
        const to = pickReviewer(state, review.lane!, reviewers);
        const name = laneName(state, to);
        const brief = [
          `Check ${review.name}'s work on the board task "${review.title}".`,
          `The task: ${review.detail}${review.owns.length ? `\nFiles it owns: ${review.owns.join(", ")}` : ""}`,
          whereWork(state, review.lane!, to, review.name ?? laneName(state, review.lane!)),
          // Where it can't open the folder, the change itself, as Friday has it from the run.
          awayDiff(state, review.lane!, to),
          review.review && !review.review.ok && review.rounds > 0 ? `Last time ${review.review.by} asked for:\n${clip(review.review.note, 1500)}\n\nCheck those first. Ask for more only if something would make the task wrong or unfinished; anything smaller goes after "Approved", as a note.` : "",
          `${review.name}'s report:\n${review.report ?? ""}`,
        ]
          .filter(Boolean)
          .join("\n\n");
        const r = await this.send(sid, state.board!.fromLane, { to: name, toLane: to, text: brief, kind: "task", board: review.id, review: true, system: true });
        if (!r.ok) {
          skip.add(to);
          continue;
        }
        await this.store.append(sid, FRIDAY, { type: "board.review", id: review.id, lane: to, name }, { lane: to });
        handed.push(`review of "${review.id}" to ${name}`);
        continue;
      }
      // A person's pick goes to that agent whatever it is doing: queued behind its current turn if it's busy, the lead itself if
      // that's who was picked, and an agent the person is using too, since they chose it (Arun, 2026-10-24: "make sure this works
      // properly"). It waited for the agent to be free, which the lead and the agent being talked to never are, and said
      // "Waiting for …" for good. One the message can't reach keeps its reason for the person who picked (control).
      const chosen = readyTasks(state).find((t) => t.next && !tried.has(t.id));
      if (chosen) {
        tried.add(chosen.id);
        const lane = lanesOf(state).find((l) => laneName(state, l).toLowerCase() === chosen.next!.toLowerCase());
        if (!lane || laneOf(state, lane)?.control.kind === "standing") {
          this.refused.set(`${sid}|${chosen.id}`, `${chosen.next} can't take board work.`);
          continue;
        }
        const name = laneName(state, lane);
        if (limited.has(lane)) {
          this.refused.set(`${sid}|${chosen.id}`, `${name} is out of usage until its limit lifts. Pick another agent.`);
          continue;
        }
        const r = await this.send(sid, state.board!.fromLane, { to: name, toLane: lane, text: taskBrief(state, chosen), kind: "task", board: chosen.id, system: true });
        if (!r.ok) {
          this.refused.set(`${sid}|${chosen.id}`, r.error);
          continue;
        }
        this.refused.delete(`${sid}|${chosen.id}`);
        await this.store.append(sid, agentActor(name), { type: "board.claimed", id: chosen.id, lane, name }, { lane });
        handed.push(`"${chosen.id}" to ${name}${r.busy ? " (after what it's doing)" : r.offline ? " (when its computer is back)" : ""}`);
        continue;
      }
      const ready = readyTasks(state).filter((t) => !tried.has(t.id));
      if (!ready.length || !free.length) break;
      // The best match of task and agent: one named for it first, else the first ready to the first free.
      // A person's pick first, and only to them: a task they handed to someone waits for that agent rather than going to
      // whoever is free.
      let pick: { t: BoardTask; to: string } | null = null;
      // Never to an agent that turned the task down.
      const may = (t: BoardTask, l: string) => !(t.declined ?? []).some((n) => n.toLowerCase() === laneName(state, l).toLowerCase());
      for (const t of ready) {
        const to = free.find((l) => may(t, l) && (t.next ? laneName(state, l).toLowerCase() === t.next.toLowerCase() : suits(t, laneName(state, l))));
        if (to) {
          pick = { t, to };
          break;
        }
      }
      const open = ready.filter((t) => !t.next && free.some((l) => may(t, l)));
      if (!pick && !open.length) break;
      let why: string | undefined = pick ? (pick.t.next ? undefined : "the plan named it for this") : undefined;
      if (!pick) {
        const t = open.find((x) => !x.agent) ?? open[0]!;
        const best = bestFor(t, free.filter((l) => may(t, l)))!;
        pick = { t, to: best.to };
        why = best.why;
      }
      const name = laneName(state, pick.to);
      // Sent first, claimed once it went: a task that couldn't reach that agent stays on the board for someone else.
      const r = await this.send(sid, state.board!.fromLane, { to: name, text: taskBrief(state, pick.t), kind: "task", board: pick.t.id, system: true });
      if (!r.ok) {
        skip.add(pick.to);
        continue;
      }
      await this.store.append(sid, agentActor(name), { type: "board.claimed", id: pick.t.id, lane: pick.to, name, ...(why ? { why } : {}) }, { lane: pick.to });
      handed.push(`"${pick.t.id}" to ${name}${why ? ` (${why})` : ""}`);
    }
    return handed;
  }

  /** A board task's agent, or its reviewer, finished its turn: what it said is its report, or its verdict. */
  private async boardRunEnded(sid: string, lane: string, endSeq?: number): Promise<void> {
    const [state, events] = await Promise.all([this.store.state(sid), this.store.events(sid)]);
    const b = state.board;
    if (!b) return;
    // The turn to settle: the lane's last, or, from the sweep, an earlier one the board never heard about.
    const end = endSeq ? events.find((e) => e.seq === endSeq) : events.findLast((e) => e.body.type === "run.ended" && (e.lane ?? MAIN_LANE) === lane);
    if (end?.body.type !== "run.ended" || end.body.outcome === "waiting") return;
    const start = events.findLast((e) => e.seq < end.seq && e.body.type === "run.started" && (e.lane ?? MAIN_LANE) === lane) ?? end;
    const said = answerFrom(events, lane, start.seq, end.seq);
    for (const t of b.tasks) {
      if (t.status === "claimed" && t.lane === lane) {
        // Only a turn that was this task's finishes it: one it was handed or claimed in. A turn a person started for something
        // else on the same agent says nothing about the task, which stays the agent's.
        if (!ranTask(events, lane, start.seq, end.seq, t.id)) continue;
        // Out of usage is the agent unable to work, not the task going wrong: it goes to another agent however often it has moved
        // before, and this one isn't handed work until its limit lifts (dispatch). It was marked stuck after one move, and sat
        // with an agent out of usage until a person pressed Try again (Arun, 2026-10-24).
        const limit = end.body.outcome === "error" ? limitHit(end.body.error, end.ts) : null;
        if (limit) {
          await this.store.append(sid, FRIDAY, { type: "board.released", id: t.id, why: `${laneName(state, lane)} ran out of usage${limit.resetsAt ? ` until ${new Date(limit.resetsAt).toISOString().slice(11, 16)} UTC` : ""}` }, { lane: b.fromLane });
          continue;
        }
        // Stopped on an error the first time: another agent tries it, rather than the board waiting on the lead.
        if (end.body.outcome === "error" && !events.some((e) => e.body.type === "board.released" && e.body.id === t.id) && lanesOf(state).some((l) => l !== lane && l !== b.fromLane)) {
          await this.store.append(sid, FRIDAY, { type: "board.released", id: t.id, why: `${laneName(state, lane)} stopped on an error` }, { lane: b.fromLane });
          continue;
        }
        const blocked = end.body.outcome === "error" || BLOCKED.test(said);
        await this.finish(sid, lane, t.id, said || (end.body.outcome === "error" ? `Stopped with an error: ${clip(end.body.error ?? "", 300)}` : ""), blocked);
      } else if (t.status === "review" && t.reviewer?.lane === lane) {
        // Only a turn that was the review's: handed it before the turn began. Finishing its own task can make an agent the
        // reviewer of another at the end of the same turn, and that turn's own report ("Done: …") was then read as its verdict on
        // the other's work, sending it back to be redone (Arun, 2026-10-24: the real-codebase team benchmark).
        const asked = events.findLast((e) => e.body.type === "board.review" && e.body.id === t.id && e.body.lane === lane);
        if (!asked || asked.seq > start.seq) continue;
        // Out of usage is no verdict: its words were the limit's, read as "something to fix", and the work went back to be redone.
        // The review goes to another agent instead (an empty reviewer), and this one gets none until its limit lifts (dispatch).
        if (end.body.outcome === "error" && limitHit(end.body.error, end.ts)) {
          await this.store.append(sid, FRIDAY, { type: "board.review", id: t.id, lane: "", name: "" }, { lane });
          continue;
        }
        const ok = reviewPasses(said);
        const name = laneName(state, lane);
        await this.store.append(sid, agentActor(name), { type: "board.reviewed", id: t.id, lane, name, ok, note: clip(said || "No verdict.", 2000) }, { lane });
        if (!ok) await this.rework(sid, t.id);
        await this.afterBoardMove(sid);
      }
    }
  }

  /** A review found something: back to the agent that did it, twice at most, then to the lead or a person. */
  private async rework(sid: string, id: string): Promise<void> {
    const state = await this.store.state(sid);
    const t = state.board?.tasks.find((x) => x.id === id);
    if (!t?.lane) return;
    if (t.rounds > MAX_REWORK) {
      await this.store.append(sid, FRIDAY, { type: "board.finished", id, lane: t.lane, name: t.name ?? "", status: "blocked", report: `Reviews found problems ${t.rounds} times; the last: ${t.review?.note ?? ""}` }, { lane: t.lane });
      await this.reportBoard(sid, true);
      return;
    }
    await this.send(sid, state.board!.fromLane, { to: t.name ?? laneName(state, t.lane), text: `${t.review?.by ?? "The reviewer"} checked your work on "${t.title}" and found:\n${t.review?.note ?? ""}\n\nFix it, then end your turn with a short report as before.`, kind: "task", board: id, system: true });
  }

  /** After a task moved: tell the poster if the board is through, and hand out what that freed up. */
  private async afterBoardMove(sid: string): Promise<void> {
    if (!boardBusy(await this.store.state(sid))) await this.reportBoard(sid, false);
  }

  /** How the board went, to the agent that posted it, once: every report since the last, together. */
  private async reportBoard(sid: string, urgent: boolean): Promise<void> {
    const [state, events] = await Promise.all([this.store.state(sid), this.store.events(sid)]);
    const b = state.board;
    if (!b) return;
    const busy = boardBusy(state);
    if (busy && !urgent) return;
    const last = events.findLast((e) => (e.lane ?? MAIN_LANE) === b.fromLane && e.body.type === "instruction" && e.body.mesh?.batch && e.seq > b.seq)?.seq ?? b.seq;
    const moved = new Set(events.filter((e) => e.seq > last && (e.body.type === "board.finished" || e.body.type === "board.reviewed")).map((e) => (e.body as { id: string }).id));
    const tasks = b.tasks.filter((t) => moved.has(t.id) && (t.status === "done" || t.status === "blocked"));
    if (!tasks.length) return;
    const text = [
      ...tasks.map((t) => `## ${t.id}: ${t.title} (${t.status === "blocked" ? "blocked" : `done by ${t.name}`}${t.review ? `, ${t.review.ok ? "approved" : "not approved"} by ${t.review.by}` : ""})\n${t.report ?? ""}${t.review && !t.review.ok ? `\nReview: ${t.review.note}` : ""}`),
      busy ? `Still on the board: ${b.tasks.filter((t) => t.status !== "done" && t.status !== "blocked").map((t) => `"${t.id}" (${t.status}${t.name ? `, ${t.name}` : ""})`).join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, MAX_TEXT * 2);
    const mesh: MeshNote = { id: randomBytes(5).toString("hex"), kind: "reply", ofTask: true, batch: busy ? "early" : "done", fromLane: b.fromLane, fromName: "The board", toName: b.fromName, hop: 1, by: null };
    const sent = await this.store.append(sid, agentActor("The board"), { type: "instruction", text, interrupt: false, mesh }, { lane: b.fromLane });
    if (sent.ok) void this.bus.wake(sid, b.fromLane);
  }

  /** Board tasks whose quiet agent the lead was told about, at the agent's last event, so it is told once for each quiet spell. */
  private quietTold = new Set<string>();

  /** A word from Friday to the agent that posted the board, about how its work is going. */
  private async tellLead(sid: string, text: string): Promise<void> {
    const b = (await this.store.state(sid)).board;
    if (!b) return;
    const mesh: MeshNote = { id: randomBytes(5).toString("hex"), kind: "tell", fromLane: b.fromLane, fromName: "Friday", toName: b.fromName, hop: 1, by: null };
    const sent = await this.store.append(sid, agentActor("Friday"), { type: "instruction", text, interrupt: false, mesh }, { lane: b.fromLane });
    if (sent.ok) void this.bus.wake(sid, b.fromLane);
  }

  /** What is waiting for the agent on `lane`: messages queued for it, team updates it hasn't read, files it shares with another agent. */
  inbox(state: SessionState, lane: string): { msgs: number[]; waiting: number[]; posts: MeshPost[]; overlaps: { path: string; with: string[] }[]; reports: MeshAsk[] } {
    const m = meshOf(state);
    // Work handed to an agent (a task, a board task) is never slipped into the turn it is in: it waits in the queue and starts as
    // a turn of its own once this one ends, so two jobs never share one turn and one report (Arun, 2026-10-19: "what would
    // happen if a teammate's coding tool picks it up while working on a different task"). Questions and messages come at once.
    const queued = pendingFor(state, lane).filter((q) => m.msgs.includes(q));
    const work = new Set(m.work ?? []);
    const msgs = queued.filter((q) => !work.has(q));
    const mine = new Set((state.diffs[lane]?.files ?? []).map((f) => f.path));
    const overlaps = [...mine].flatMap((p) => {
      const others = lanesOf(state).filter((l) => l !== lane && state.diffs[l]?.files.some((f) => f.path === p));
      return others.length ? [{ path: p, with: others.map((l) => laneName(state, l)) }] : [];
    });
    const read = m.readUpTo?.[lane] ?? 0;
    const reports = Object.values(m.asks).filter((a) => a.task && a.fromLane === lane && a.reply && a.reply.seq > read);
    return { msgs, waiting: queued.filter((q) => work.has(q)), posts: unreadPosts(state, lane), overlaps, reports };
  }

  private async waitingCount(sid: string, lane: string): Promise<number> {
    const w = this.inbox(await this.store.state(sid), lane);
    return w.msgs.length + w.posts.length + w.reports.length;
  }

  /**
   * check_messages: everything waiting, as one answer. Messages read here are delivered now (they don't start another turn when
   * this one ends), and the updates are marked read; a question among them is answered with reply_to_agent, or by the end of
   * the turn, as if it had come at its start.
   */
  async checkMessages(sid: string, lane: string): Promise<string> {
    const [state, events] = await Promise.all([this.store.state(sid), this.store.events(sid)]);
    const w = this.inbox(state, lane);
    const bySeq = new Map(events.map((e) => [e.seq, e]));
    const msgs = w.msgs.flatMap((q) => {
      const e = bySeq.get(q);
      return e?.body.type === "instruction" && e.body.mesh ? [{ seq: q, m: e.body.mesh, text: e.body.text }] : [];
    });
    const name = laneName(state, lane);
    if (msgs.length) await this.store.append(sid, agentActor(name), { type: "instructions.delivered", seqs: msgs.map((x) => x.seq) }, { lane });
    const upTo = Math.max(w.posts.at(-1)?.seq ?? 0, ...w.reports.map((a) => a.reply!.seq));
    if (upTo) await this.store.append(sid, agentActor(name), { type: "mesh.read", upTo }, { lane });
    const parts = [
      ...msgs.map((x) =>
        x.m.kind === "ask"
          ? `${x.m.fromName} asks (id ${x.m.id}, waiting for your answer: reply_to_agent):\n${x.text}`
          : x.m.kind === "task"
            ? `${x.m.fromName}, the lead, assigned you this task (your report at the end of it goes back to it):\n${x.text}`
            : x.m.kind === "reply"
              ? `${x.m.fromName} ${x.m.ofTask ? "finished the task you assigned and reports" : "answered your earlier question"}:\n${x.text}`
              : `${x.m.fromName} says:\n${x.text}`,
      ),
      ...w.reports.map((a) => `${a.toName} finished the task you assigned (${clip(a.text.split("\n")[0]!.trim(), 80)}) and reports:\n${a.reply!.text}`),
      w.posts.length ? `Team updates:\n${w.posts.map((p) => `- ${p.fromName}: ${p.text}`).join("\n")}` : "",
      overlapText(w.overlaps),
      ...w.waiting.flatMap((q) => {
        const e = bySeq.get(q);
        if (e?.body.type !== "instruction" || !e.body.mesh) return [];
        return [`Waiting for you after this turn, from ${e.body.mesh.fromName}: ${clip(e.body.text.split("\n")[0]!.trim(), 140).replace(/[.!]+$/, "")}. Don't start it now: finish what you're on and end your turn, and it starts as a turn of its own.`];
      }),
    ].filter(Boolean);
    return parts.length ? parts.join("\n\n") : "Nothing new from the other agents.";
  }

  /** post_update: a team update every other agent reads at its next check or turn. Wakes nobody. */
  async post(sid: string, lane: string, raw: string): Promise<MeshResult> {
    const text = raw.trim().slice(0, 1200);
    if (!text) return { output: "The update is empty.", isError: true };
    const [state, events] = await Promise.all([this.store.state(sid), this.store.events(sid)]);
    const since = runOf(state, lane).sinceSeq;
    const posted = events.filter((e) => e.seq > since && e.body.type === "mesh.posted" && e.body.fromLane === lane).length;
    if (posted >= MAX_POSTS_PER_RUN) return { output: `This run has posted ${posted} updates already. Finish your work and say the rest at the end.`, isError: true };
    const others = lanesOf(state).filter((l) => l !== lane);
    if (!others.length) return { output: "You are the only agent in this session, so there's nobody to update." };
    const fromName = laneName(state, lane);
    await this.store.append(sid, agentActor(fromName), { type: "mesh.posted", id: randomBytes(5).toString("hex"), fromLane: lane, fromName, text }, { lane });
    return { output: `Posted. The ${others.length === 1 ? "other agent reads" : `${others.length} other agents read`} it at their next check or turn; nobody was interrupted.` };
  }

  /** wait_for_agent: until that agent's current work ends (its last words), it posts, or it messages the one waiting. */
  async watch(sid: string, lane: string, to: string, wait: number, signal?: AbortSignal): Promise<MeshResult> {
    const state = await this.store.state(sid);
    const found = resolveTarget(state, lane, to, "", () => true);
    if (!found.ok || found.how === "suggested") return { output: `There's no agent called "${to}" here. The others: ${lanesOf(state).filter((l) => l !== lane).map((l) => `"${laneName(state, l)}"`).join(", ")}.`, isError: true };
    const target = found.to;
    const name = laneName(state, target);
    const lastWords = async () => {
      const events = await this.store.events(sid);
      const said = events.findLast((e) => (e.lane ?? MAIN_LANE) === target && e.body.type === "agent.message" && !!e.body.text.trim());
      return said?.body.type === "agent.message" ? clip(said.body.text.trim(), 4000) : "";
    };
    if (runOf(state, target).status !== "running") {
      const last = await lastWords();
      return { output: `${name} isn't working on anything right now.${last ? ` What it said last:\n\n${last}` : ""}` };
    }
    const got = await new Promise<"ended" | "posted" | "message" | "timeout" | "gone">((resolve) => {
      let done = false;
      let unsub: (() => Promise<void>) | null = null;
      const finish = (w: "ended" | "posted" | "message" | "timeout" | "gone") => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        void unsub?.().catch(() => {});
        resolve(w);
      };
      const timer = setTimeout(() => finish("timeout"), wait);
      timer.unref?.();
      const onAbort = () => finish("gone");
      if (signal?.aborted) return finish("gone");
      signal?.addEventListener("abort", onAbort);
      void this.bus
        .subscribe(sid, (msg) => {
          if (msg.kind !== "event") return;
          const e = msg.event;
          const at = e.lane ?? MAIN_LANE;
          if (e.body.type === "run.ended" && at === target && e.body.outcome !== "waiting") finish("ended");
          else if (e.body.type === "mesh.posted" && e.body.fromLane === target) finish("posted");
          else if (e.body.type === "instruction" && e.body.mesh?.fromLane === target && at === lane) finish("message");
          else if ((e.body.type === "run.cancel" || e.body.type === "run.pause") && at === lane) finish("gone");
        })
        .then(async (u) => {
          unsub = u;
          if (done) return void u().catch(() => {});
          if (runOf(await this.store.state(sid), target).status !== "running") finish("ended");
        })
        .catch(() => finish("gone"));
    });
    if (got === "gone") return { output: `Stopped waiting for ${name}.`, isError: true };
    if (got === "timeout") return { output: `${name} is still working. Carry on with what you can do without it, or wait again.` };
    if (got === "posted" || got === "message") return { output: `${name} ${got === "posted" ? "posted an update" : "sent you a message"} while you waited: call check_messages.` };
    const last = await lastWords();
    return { output: `${name} finished.${last ? ` What it said at the end:\n\n${last}` : ""}` };
  }

  /**
   * A run ended: each question it was handling that nobody answered yet is answered with what the agent said last, or with why
   * it couldn't. Called once per run end by whichever process logged it (SessionStore.onRunEnded).
   */
  async onRunEnded(sid: string, lane: string): Promise<void> {
    // A store closing under it (the server stopping) is not a board failure worth a line.
    const said = (what: string) => (e: unknown) => void (/closed|closing/i.test(String((e as Error)?.message)) || console.error(what, e));
    // Cut off by a lost connection, it carries on when the machine is back (hub reap): its task, the questions it was answering
    // and its usage are all still in hand, so none of what follows a run's end is done for it yet.
    const end = (await this.store.events(sid)).findLast((e) => e.body.type === "run.ended" && (e.lane ?? MAIN_LANE) === lane);
    if (end?.body.type === "run.ended" && end.body.cut) return;
    await this.boardRunEnded(sid, lane).catch(said("[board]"));
    await this.answerAsks(sid, lane);
    // Whoever waited on this agent's turn is woken; and a turn that itself ended waiting gets its wake (wake_me_when).
    await this.wakeOnTurn(sid, lane).catch(said("[wake]"));
    await this.autoWake(sid, lane).catch(said("[wake]"));
    // Out of usage mid-task: someone else carries it on, or it carries on itself when the limit lifts (limit-handoff.ts).
    await this.onLimit(sid, lane).catch(said("[limit]"));
    // An agent just became free: hand it what is ready.
    await this.dispatch(sid).catch(said("[board] dispatch:"));
  }

  /**
   * The coding tool on `lane` ran out of usage partway through its task: hand the task to the best agent that can take it now,
   * with the whole record, or, with nobody to take it, set it to carry on by itself when the limit lifts (limit-handoff.ts).
   * Not for work another agent gave it (the agent that asked, or the lead, hears it stopped and decides), a board task (the
   * board hands it on itself) or a hub's (the hub retries it), and once per run end.
   */
  async onLimit(sid: string, lane: string, now = Date.now()): Promise<void> {
    const [state, events] = await Promise.all([this.store.state(sid), this.store.events(sid)]);
    const end = events.findLast((e) => e.body.type === "run.ended" && (e.lane ?? MAIN_LANE) === lane);
    if (end?.body.type !== "run.ended" || end.body.outcome !== "error" || !state.engines[lane]?.tool) return;
    const hit = limitHit(end.body.error, end.ts);
    if (!hit) return;
    const after = events.filter((e) => e.seq > end.seq);
    if (after.some((e) => (e.body.type === "instruction" && e.body.handoff?.fromLane === lane) || (e.body.type === "resume.scheduled" && (e.lane ?? MAIN_LANE) === lane))) return;
    const start = events.findLast((e) => e.seq < end.seq && e.body.type === "run.started" && (e.lane ?? MAIN_LANE) === lane);
    if (!start || start.body.type !== "run.started") return;
    const cause = events.find((e) => e.seq === (start.body as { causedBy: number }).causedBy);
    if (cause?.body.type === "instruction" && cause.body.mesh) return;
    const inRun = events.filter((e) => e.seq > start.seq && e.seq < end.seq && (e.lane ?? MAIN_LANE) === lane);
    if (inRun.some((e) => e.body.type === "board.claimed")) return;
    if (state.hub && Object.values(state.hub.runs).some((r) => r.lane === lane)) return;
    const task = limitedTask(events, lane, start.seq, end.seq);
    if (!task) return;
    const fromName = laneName(state, lane);
    const back = hit.resetsAt ? ` (its limit lifts ${untilText(hit.resetsAt - now)})` : "";
    if (this.handOff) {
      const targets = limitTargets(state, events, lane, now);
      for (const t of this.roomFirst(sid, targets.map((x) => x.id)).map((id) => targets.find((x) => x.id === id)!)) {
        const toName = laneName(state, t.id);
        const r = await this.handOff(sid, lane, {
          to: toName,
          reason: `${fromName} ran out of usage partway through${back}, so Friday handed it to ${toName}: ${t.why}.`,
          carried: [],
          task: `Carry on with this task, which ${fromName} was partway through when it ran out of usage. Don't start over: what it already did is in the record with this, so build on it, then finish the task.

The task:
${task}`,
        });
        if (r.ok) return;
      }
    }
    // Nobody to take it: carry on here when the limit lifts, as the person who asked for it.
    const person = personBehind(state, events, lane, start.seq);
    if (!person || !hit.resetsAt || hit.resetsAt <= now || hit.resetsAt > now + 8 * 86_400_000) return;
    await this.store.append(sid, { id: person.id, name: person.name, kind: "human" }, { type: "resume.scheduled", at: hit.resetsAt, auto: true }, { lane });
  }

  /**
   * The task `ask` gave the agent on `lane`, which ran out of usage partway through: sent on to the best agent free to carry it
   * (limitTargets), as the asker's own task, with what was done. What to tell the asker, or null when nobody could take it.
   */
  private async carryOn(sid: string, ask: MeshAsk, lane: string, said: string, facts: string, out: Limited): Promise<string | null> {
    const [state, events] = await Promise.all([this.store.state(sid), this.store.events(sid)]);
    const targets = limitTargets(state, events, lane).filter((x) => x.id !== ask.fromLane);
    const order = this.roomFirst(sid, targets.map((x) => x.id));
    for (const t of order.map((id) => targets.find((x) => x.id === id)!)) {
      const brief = [
        `${ask.fromName} gave this task to ${ask.toName}, which ran out of usage partway through. Carry it on: don't start over, build on what it already did (the files are as it left them), then finish it and end your turn with a short report.`,
        `The task:\n${ask.text}`,
        said ? `What ${ask.toName} said last:\n${clip(said, 2500)}` : "",
        facts,
      ]
        .filter(Boolean)
        .join("\n\n");
      const r = await this.send(sid, ask.fromLane, { to: laneName(state, t.id), text: brief, kind: "task", system: true, carriedFrom: lane });
      if (!r.ok) continue;
      return `${ask.toName} ran out of usage partway through (it is ${outOfUsage(state, out, Date.now())}), so Friday gave the task to ${r.toName}: ${t.why}. It carries on from what ${ask.toName} did, and its report comes to you as any task's does.`;
    }
    return null;
  }

  private async answerAsks(sid: string, lane: string): Promise<void> {
    const [state, events] = await Promise.all([this.store.state(sid), this.store.events(sid)]);
    const open = Object.values(meshOf(state).asks).filter((a) => a.toLane === lane && !a.reply);
    if (!open.length) return;
    const end = events.findLast((e) => e.body.type === "run.ended" && (e.lane ?? MAIN_LANE) === lane);
    if (end?.body.type !== "run.ended" || end.body.outcome === "waiting") return;
    const queued = new Set(pendingFor(state, lane));
    for (const ask of open) {
      if (queued.has(ask.seq) || state.withdrawn.includes(ask.seq)) continue;
      const got = events.find((e) => e.body.type === "instructions.delivered" && (e.lane ?? MAIN_LANE) === lane && e.body.seqs.includes(ask.seq));
      if (!got || got.seq > end.seq) continue;
      const said = answerFrom(events, lane, got.seq, end.seq);
      // Out of usage, said as that, with who can take the work now, rather than the tool's own message about upgrading its plan.
      const out = end.body.outcome === "error" ? limitedLanes(state, events).get(lane) : undefined;
      const free = out ? freeAgents(state, events, [ask.fromLane, lane]) : [];
      const stopped = out
        ? `${ask.toName} ran out of usage before it finished: it is ${outOfUsage(state, out, Date.now())}.${free.length ? ` Free now: ${free.map((n) => `"${n}"`).join(", ")}. Hand it to one of them, saying what ${ask.toName} already did.` : " No other agent is free now; carry on with it yourself, or wait."}`
        : `${ask.toName} stopped with an error before answering: ${clip(end.body.error ?? "", 400)}`;
      // Out of usage, what it said before stopping comes first; otherwise its words are the answer as before.
      const text = out ? `${said ? `${said}\n\n` : ""}${stopped}` : said || (end.body.outcome === "error" ? stopped : `${ask.toName} finished without saying anything.`);
      // A task another agent gave it, cut off by its limit, goes on to an agent that can carry it now, as the lead's own task with
      // the record of what was done, so its report comes back to the lead as any task's does. It went back to the lead to decide,
      // which handed it on by hand, or not at all while it was busy (Arun, 2026-10-25).
      if (ask.task && out) {
        const handed = await this.carryOn(sid, ask, lane, said, factsOf(state, events, lane, got, end), out);
        if (handed) {
          await this.deliver(sid, ask, handed, true);
          continue;
        }
      }
      if (!ask.task) {
        await this.deliver(sid, ask, text, true);
        continue;
      }
      // A task's report carries what the record shows it did, so the lead doesn't re-read files or re-run tests to find out;
      // one that failed or says it is blocked reaches the lead at once, rather than waiting for the rest of the batch.
      const facts = factsOf(state, events, lane, got, end);
      const urgent = end.body.outcome === "error" || BLOCKED.test(said);
      await this.deliver(sid, ask, `${text}${facts ? `\n\n${facts}` : ""}`, true, urgent);
    }
  }
}

/**
 * The notes the team saved (write_note, or a person) since this agent's last turn began, with its next turn: decisions,
 * constraints and agreed interfaces reached every agent only if it thought to call read_notes (Arun, 2026-10-25: a shared
 * decisions log every agent sees). Its first turn here gets them all. Its own notes, and Friday's own notes from what it read,
 * aren't repeated.
 */
export function newNotes(events: readonly SessionEvent[], lane: string): string {
  const lastStart = events.findLast((e) => e.body.type === "run.started" && (e.lane ?? MAIN_LANE) === lane)?.seq ?? 0;
  const latest = new Map<string, { text: string; by: string }>();
  for (const e of events) {
    if (e.body.type !== "memory.saved" || e.seq <= lastStart || e.actor.kind === "system" || (e.actor.kind === "agent" && (e.lane ?? MAIN_LANE) === lane) || !e.body.text.trim()) continue;
    latest.set(e.body.key, { text: e.body.text.trim(), by: e.actor.name });
  }
  if (!latest.size) return "";
  const rows = [...latest].slice(-10).map(([key, n]) => `- ${key} (${n.by}): ${clip(n.text.replace(/\s+/g, " "), 300)}`);
  return `[Friday] Decisions and notes the team saved ${lastStart ? "since your last turn" : "in this session"} (read_notes has them all). Work within them, and write_note when you settle something others should keep to:\n${rows.join("\n")}`;
}

/** Files the agent changed that another agent changed too, as a heads-up: two of them editing one file is how work is lost. */
function overlapText(overlaps: { path: string; with: string[] }[]): string {
  if (!overlaps.length) return "";
  const rows = overlaps.slice(0, 12).map((o) => `- ${o.path} (also changed by ${o.with.join(", ")})`);
  return `Heads-up: files you changed that another agent is changing too. Agree who edits them (message_agent) before you change them again:\n${rows.join("\n")}${overlaps.length > 12 ? `\n- and ${overlaps.length - 12} more` : ""}`;
}

/**
 * What the lead is told with each instruction a person gives it: that it leads, who it leads, and how. Short, since it comes
 * with every one; the agents' states are in list_agents.
 */
export function leadBrief(state: SessionState, lane: string): string {
  const others = lanesOf(state).filter((l) => l !== lane && laneOf(state, l)?.control.kind !== "standing");
  if (state.lead !== lane || !others.length) return "";
  return `[Friday] You lead the agents in this session: ${others.map((l) => laneName(state, l)).join(", ")}. For work bigger than one step, split it into self-contained pieces, post them all at once to the shared board with the friday post_tasks tool (the files each owns, which wait on which, an agent each suits): free agents start at once, the rest take the next ready task as they finish, and each is checked by another agent. Use assign_task for a single piece meant for one agent. Do your own piece meanwhile. The agents settle what they share between themselves; you are woken once with every report together, each with what Friday saw it do, so trust those facts rather than re-checking. Then run the tests once across all of it, fix or reassign what doesn't fit, and report to the person. Give each task its check, the command that proves it works (the test that covers it), so Friday runs it as the task finishes. When the request already names the pieces (the files, modules or features), post the board straight away, before reading any code, so the others start at once, then start on your own piece. Only when it doesn't, first send your own sub-agents to look around the code (where each part lives, what it touches), briefly, so the pieces are drawn along the code's real seams; a piece that is only looking things up stays with your sub-agents rather than an agent of the session. For a small job, just do it.`;
}

/** A report that says the work stopped short: it reaches the lead at once instead of with the batch. */
/** A report that turns the task down as not this agent's: "releasing", "outside my scope", "told to stay off". */
const DECLINED = /\b(releasing|releas(?:e|ed) it|not (?:my|mine)\b|isn'?t (?:my|mine)\b|outside (?:of )?my (?:scope|area|part)|not in my (?:scope|area)|(?:told|instructed|asked) (?:me )?(?:not to|to stay off)|stay(?:ing)? off|should (?:stay|go) with|not involved|skipp(?:ing|ed) (?:it|this|the task|task|`[^`]+`|"[^"]+"|t\d+\b)|(?:\w+ ){0,3}owns (?:it|this)\b|belongs to (?:\w+ ){0,3}(?:else|another|them|it|\w+'s)|leav(?:e|ing) (?:it|this) (?:to|for)\b|not (?:doing|taking|touching) (?:it|this)\b|already (?:taken|owned|claimed|being done) by)/i;

/** Whether a report says its agent turned the task down (judged on its opening). */
export const declines = (report: string): boolean => DECLINED.test(opening(report));
/** Whether what an agent said is it saying it is held up. */
export const saysBlocked = (said: string): boolean => BLOCKED.test(said);

/** The opening of a report, where an agent says what it did with the task: its first paragraph, at most a few lines. */
function opening(report: string): string {
  return (report.trim().split(/\n\s*\n/)[0] ?? "").slice(0, 400);
}

/**
 * An agent saying it is held up: about itself ("I'm blocked on the keys", "can't proceed", "Blocked: needs a decision"), not the
 * word anywhere in its report. "Friday blocked both" (a message it couldn't send) marked a finished, corrected task as stuck
 * (Arun, 2026-10-24: t1, after its rework).
 */
const BLOCKED = /\b(?:i'?m|i am|i was|i've been|i have been|i remain|it'?s|it is|this is|the task is|task is|still|remains?|got|am|was) (?:still )?(?:blocked|stuck)\b|\bblocked (?:on|by|until|waiting)\b|\b(?:can'?t|cannot|unable to|couldn'?t) (?:proceed|continue|finish|complete|go (?:any )?further|get (?:any )?further)\b|\bneed(?:s)? (?:a decision|your input|access|approval|someone to)\b|^\s*(?:\*\*)?(?:blocked|stuck)\b/im;

/**
 * What the session's record shows an agent did in the run that handled a task: the files it left changed, the checks it ran and
 * how they came out, any commit, and how long it took. Written by Friday, not the agent: the lead can trust it without checking.
 */
export function factsOf(state: SessionState, events: SessionEvent[], lane: string, got: SessionEvent, end: SessionEvent): string {
  const inRun = events.filter((e) => e.seq > got.seq && e.seq <= end.seq && (e.lane ?? MAIN_LANE) === lane);
  const lastDiff = inRun.findLast((e) => e.body.type === "agent.diff");
  const files = lastDiff?.body.type === "agent.diff" ? lastDiff.body.files : (state.diffs[lane]?.files ?? []);
  const calls = new Map<string, string>();
  const checks: string[] = [];
  for (const e of inRun) {
    if (e.body.type === "agent.message")
      for (const c of e.body.toolCalls) {
        if (c.name !== "run_command" && c.name !== "shell") continue;
        try {
          calls.set(c.id, String((JSON.parse(c.arguments || "{}") as { command?: unknown }).command ?? "").trim());
        } catch {
          // Arguments that aren't JSON name no command.
        }
      }
    else if (e.body.type === "tool.result") {
      const command = calls.get(e.body.callId);
      if (!command || !/\b(tsc|typecheck|lint|build)\b/i.test(command) && !TEST_CMD.test(command)) continue;
      const failed = commandFailed(e.body);
      if (failed !== null) checks.push(`${clip(command, 50)} ${failed ? "failed" : "passed"}`);
    }
  }
  const commit = inRun.findLast((e) => e.body.type === "folder.committed");
  const took = Math.round((end.ts - got.ts) / 60_000);
  const parts = [
    files.length ? `${files.length} file${files.length === 1 ? "" : "s"} changed: ${files.slice(0, 8).map((f) => `${f.path} +${f.additions} −${f.deletions}`).join(", ")}${files.length > 8 ? `, and ${files.length - 8} more` : ""}` : "no files changed",
    checks.length ? `checks: ${[...new Set(checks)].slice(-4).join("; ")}` : "no tests or checks run",
    commit?.body.type === "folder.committed" ? `committed ${commit.body.sha.slice(0, 7)}` : "",
    end.body.type === "run.ended" && end.body.outcome === "error" ? `stopped on an error: ${clip(end.body.error ?? "", 160)}` : "",
    `took ${took < 1 ? "under a minute" : `${took} min`}`,
  ].filter(Boolean);
  return `[Friday, from the record] ${parts.join(" · ")}.`;
}

/** Whether a task was meant for this agent: the poster named it, by a recognisable part of its name. */
function suits(t: BoardTask, name: string): boolean {
  const a = t.agent?.toLowerCase();
  const n = name.toLowerCase();
  return !!a && (n.includes(a) || a.includes(n));
}

function boardLine(t: BoardTask | undefined): string {
  if (!t) return "there is no such task.";
  if (t.checks?.running) return `checks running (${t.checks.command})`;
  return { open: "open, waiting on what it depends on", claimed: `being done by ${t.name}`, review: `in review${t.reviewer ? ` by ${t.reviewer.name}` : ""}`, done: `done by ${t.name}`, blocked: `blocked (${t.name})`, cancelled: "dropped" }[t.status];
}

/** A task as the agent doing it is given it: what, which files, what it waits on, and who else is on the board. */
/**
 * A task big enough to be worth the agent's own sub-agents: several files of its own, or a long description of the work. A
 * small one is quicker done in one go than briefed out.
 */
export const splits = (t: Pick<BoardTask, "owns" | "detail">): boolean => t.owns.length >= 3 || (t.detail?.length ?? 0) >= 600;
const SPLIT_HINT =
  "It is big enough to split: start your own sub-agents on its parts at once (reading what each part touches, or checking each when it is done), each told exactly what to look at and to report back briefly, and make the edits yourself unless the parts are separate files.";

/**
 * Where a reviewer finds the work it is checking (Arun, 2026-10-24): half the reviews failed with "the deliverable doesn't
 * exist", read in the reviewer's own folder while the work sat uncommitted in the other agent's copy. Its folder and branch
 * when both are on one computer; how to get at it when they aren't.
 */
/**
 * The end of `lane`'s latest turn on task `id` since it was given the task (claimed it, was sent it back, or, `review`, was
 * asked to check it), when the board has heard nothing about the task since: a run end whose board step never ran. A turn on
 * something else (a person's, or the lead's message about another matter) isn't the task's; one cut off by a lost connection
 * carries on later, and one waiting on a person hasn't ended, so none of those count.
 */
export function unheardEnd(events: readonly SessionEvent[], id: string, lane: string, review = false): SessionEvent | null {
  const given = events.findLast((e) => {
    const b = e.body;
    return (b.type === "board.claimed" || b.type === "board.review" || (b.type === "board.reviewed" && !b.ok)) && b.id === id;
  });
  if (!given) return null;
  const mine = (e: SessionEvent) => (e.lane ?? MAIN_LANE) === lane;
  const ends = events.filter((e) => e.seq > given.seq && mine(e) && e.body.type === "run.ended" && !e.body.cut && e.body.outcome !== "waiting");
  for (const end of ends.reverse()) {
    if (events.some((e) => e.seq > end.seq && e.body.type.startsWith("board.") && (e.body as { id?: string }).id === id)) return null;
    // The turn this end closes, from its start: the task's when it was started by the task's brief, or took it within.
    const start = events.findLast((e) => e.seq < end.seq && mine(e) && e.body.type === "run.started");
    if (review || ranTask(events as SessionEvent[], lane, start?.seq ?? given.seq, end.seq, id)) return end;
  }
  return null;
}

/** The reviewer for a task: a free agent on the computer the work is on if there is one, else the first free one. */
export function pickReviewer(state: SessionState, doer: string, free: readonly string[]): string {
  const others = free.filter((l) => l !== doer);
  const host = state.engines[doer]?.hostId;
  return others.find((l) => !!host && state.engines[l]?.hostId === host) ?? others[0]!;
}

/**
 * The change a task's run made, for a reviewer on another computer, which can't open the folder it is in: each file's diff as
 * Friday logged it, up to REVIEW_DIFF characters. Nothing when the reviewer can open it, or there is no change on record.
 */
export function awayDiff(state: SessionState, doer: string, reviewer: string): string {
  const e = state.engines[doer];
  const r = state.engines[reviewer];
  if (!e?.cwd || !r || r.hostId === e.hostId) return "";
  const files = state.diffs[doer]?.files ?? [];
  if (!files.length) return "";
  let out = "";
  let shown = 0;
  for (const f of files) {
    const part = `--- ${f.path} (${f.status}, +${f.additions} -${f.deletions})\n${f.patch}${f.truncated ? "\n[cut short]" : ""}\n`;
    if (out.length + part.length > REVIEW_DIFF) break;
    out += part;
    shown++;
  }
  const more = files.length - shown;
  return `The change, as Friday logged it from the run (${files.length} file${files.length === 1 ? "" : "s"}${more ? `; ${more} more not shown, ask for them` : ""}):\n\n${out.trimEnd()}`;
}

export function whereWork(state: SessionState, doer: string, reviewer: string, name: string): string {
  const e = state.engines[doer];
  if (!e?.cwd) return "";
  const r = state.engines[reviewer];
  const at = `${e.cwd}${e.branch ? ` (branch ${e.branch})` : ""}`;
  if (!r || r.hostId === e.hostId) return `${name}'s work is in its own folder, ${at}. Read it there, not in yours: it may not be committed yet.`;
  return `${name} works on ${e.hostName}'s computer, in ${at}, which you can't open. Ask it for the diff (ask_agent), or check what it has pushed on that branch.`;
}

function taskBrief(state: SessionState, t: BoardTask): string {
  const others = (state.board?.tasks ?? []).filter((x) => x.id !== t.id && (x.status === "claimed" || x.status === "review") && x.name);
  return [
    `Board task "${t.id}": ${t.title}`,
    t.detail,
    t.owns.length ? `Files it owns (only this task edits them): ${t.owns.join(", ")}` : "",
    // What the tasks it waited on came to, so it starts from their results rather than finding them again.
    ...t.after.flatMap((d) => {
      const dep = state.board?.tasks.find((x) => x.id === d);
      if (!dep || dep.status !== "done" || !dep.report) return [];
      return [`What "${dep.id}" (${dep.title}) came to, from ${dep.name ?? "its agent"}:\n${clip(dep.report, 1500)}${dep.review?.note ? `\nIts review: ${clip(dep.review.note, 300)}` : ""}`];
    }),
    t.check || (state.board?.check && !TEST_CMD.test(state.board.check))
      ? `When you finish, Friday runs \`${t.check ?? state.board?.check}\` in your folder; make it pass.`
      : state.board?.check
        ? `When you finish, Friday runs this task's own tests in your folder (those for the files it owns or changes; \`${state.board.check}\` when it can't tell which), not the other tasks'; make them pass.`
        : "",
    // Another agent checks it from its own folder, and the lead merges it: work left uncommitted in a copy was work nobody found.
    state.engines[t.lane ?? ""]?.cwd ? "Commit your work in your folder before you report (on the branch you're on), so whoever checks it and the lead merging it can see it." : "",
    splits(t)
      ? SPLIT_HINT
      : "",
    others.length ? `Also on the board now:\n${others.map((x) => `- ${x.name}: "${x.id}" ${x.title}${x.owns.length ? ` (owns ${x.owns.join(", ")})` : ""}`).join("\n")}\nAgree anything you share with them directly (ask_agent, post_update).` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The board, for list_tasks. */
export function boardText(state: SessionState, lane: string): string {
  const b = state.board;
  if (!b) return "There's no task board in this session. The lead (or any agent, when there is no lead) posts one with post_tasks.";
  const ready = new Set(readyTasks(state).map((t) => t.id));
  const rows = b.tasks.map((t) => `- "${t.id}" ${t.title} · ${ready.has(t.id) ? "ready to take" : boardLine(t)}${t.after.length ? ` · after ${t.after.join(", ")}` : ""}${t.owns.length ? ` · owns ${t.owns.join(", ")}` : ""}${t.lane === lane && t.status === "claimed" ? " · yours" : ""}`);
  return `${b.fromName}'s board:\n${rows.join("\n")}${ready.size ? `\n\nclaim_task takes a ready one.` : ""}`;
}

/**
 * What proves a task works when the board doesn't say: the project's typecheck, which is fast and catches most breakage. A
 * whole test suite can take many minutes on every task, so it runs only when the board names it. Nothing for a project
 * without a package.json script for it, or without TypeScript.
 */
export function inferCheck(pkg: string | null): string {
  if (!pkg) return "";
  let j: { scripts?: Record<string, string>; devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
  try {
    j = JSON.parse(pkg) as typeof j;
  } catch {
    return "";
  }
  const scripts = j.scripts ?? {};
  for (const name of ["typecheck", "type-check", "check-types", "tsc"]) if (scripts[name]) return `npm run ${name}`;
  if (j.devDependencies?.typescript || j.dependencies?.typescript) return "npx tsc --noEmit";
  return "";
}

/** A shell answer's output lines, without its "$ command" and "(exited …)" head; none when it didn't run or failed. */
export function shellLines(out: string | null): string[] {
  const head = out?.match(/^\$ [^\n]*\n\(exited 0\)\n/);
  return head ? out!.slice(head[0].length).split("\n").map((l) => l.trim()).filter(Boolean) : [];
}

const TEST_FILE = /(^|\/)(__tests__\/.+|test_[^/]+\.py|[^/]+_test\.(go|py)|[^/]+[.-](test|spec)\.[cm]?[jt]sx?)$/;
/** What a test file tests: markdown.test.js, test_markdown.py and markdown_test.go are all "markdown". */
const testedName = (file: string) => path.basename(file).replace(/^test_/, "").replace(/(_test|[.-](test|spec))?\.[^.]+$/, "").toLowerCase();

/**
 * A task's own tests among the folder's files: tests it touched itself, tests named after a file it owns or changed
 * (src/markdown.js → test/markdown.test.js), and tests inside a folder it owns.
 */
export function testsFor(files: string[], listing: string[]): string[] {
  const tests = listing.filter((f) => TEST_FILE.test(f));
  const out = new Set<string>();
  for (const raw of files) {
    const f = raw.replace(/^\.\//, "");
    if (TEST_FILE.test(f)) {
      if (tests.includes(f)) out.add(f);
      continue;
    }
    const folder = f.endsWith("/") ? f : path.extname(f) ? "" : `${f}/`;
    const name = path.basename(f).replace(/\.[^.]+$/, "").toLowerCase();
    for (const t of tests) if ((folder && t.startsWith(folder)) || (!folder && testedName(t) === name)) out.add(t);
  }
  return [...out].sort();
}

/**
 * The command that runs only `tests`, in the runner the board's suite uses (from the command itself, or the package's test
 * script); "" when there are none or the runner isn't one this knows, so the whole suite runs as before.
 */
export function ownTestCommand(suite: string, pkg: string | null, tests: string[]): string {
  if (!tests.length) return "";
  const q = (f: string) => (/^[\w./@+-]+$/.test(f) ? f : `'${f.replace(/'/g, "'\\''")}'`);
  const files = tests.map(q).join(" ");
  if (tests.every((t) => t.endsWith(".py"))) return `python -m pytest ${files}`;
  if (tests.every((t) => t.endsWith(".go"))) return `go test ${[...new Set(tests.map((t) => `./${path.dirname(t)}`))].join(" ")}`;
  if (!tests.every((t) => /\.[cm]?[jt]sx?$/.test(t))) return "";
  let script = "";
  try {
    script = (JSON.parse(pkg ?? "") as { scripts?: Record<string, string> }).scripts?.test ?? "";
  } catch {
    // no package.json: the board's command alone says which runner
  }
  const how = `${suite} ${script}`;
  if (/\bvitest\b/.test(how)) return `npx vitest run ${files}`;
  if (/\bjest\b/.test(how)) return `npx jest ${files}`;
  if (/\bmocha\b/.test(how)) return `npx mocha ${files}`;
  if (/node\s+(--\S+\s+)*--test\b/.test(how)) return `node --test ${files}`;
  return "";
}

/** How a check's run went, from the shell's answer: passed, failed, or not run at all (a Manual machine, offline, timed out). */
export function checkVerdict(out: string | null): "passed" | "failed" | "skipped" {
  if (!out) return "skipped";
  const status = out.match(/^\$ [^\n]*\n\((exited \S+|timed out[^)]*)\)/);
  if (!status) return "skipped";
  if (/^timed out/.test(status[1]!)) return "skipped";
  return status[1] === "exited 0" ? "passed" : "failed";
}

/** How long after a person last told an agent something it counts as in their hands, and the board leaves it be. */
export const IN_USE_MS = 5 * 60_000;

/**
 * The agents a person is using: told something by a person in the last IN_USE_MS, after that person last told the board's
 * lead anything. Someone who has since turned to the lead ("plan this for the team") has handed their agents to the team.
 */
export function inUse(events: SessionEvent[], now: number, lead: string): string[] {
  const out = new Set<string>();
  const turned = new Set<string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (now - e.ts > IN_USE_MS) break;
    if (e.body.type !== "instruction" || e.body.mesh || e.actor.kind !== "human") continue;
    const lane = e.lane ?? MAIN_LANE;
    if (lane === lead) turned.add(e.actor.id);
    else if (!turned.has(e.actor.id)) out.add(lane);
  }
  return [...out];
}

/** Whether the turn from `start` to `end` on `lane` was a board task's: it was handed the task (or its rework) or claimed it. */
export function ranTask(events: SessionEvent[], lane: string, start: number, end: number, id: string): boolean {
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  for (const e of events) {
    if (e.seq < start || e.seq > end || (e.lane ?? MAIN_LANE) !== lane) continue;
    if (e.body.type === "board.claimed" && e.body.id === id) return true;
    const seqs = e.body.type === "instructions.delivered" ? e.body.seqs : e.body.type === "run.started" ? [e.body.causedBy] : [];
    for (const q of seqs) {
      const i = bySeq.get(q);
      if (i?.body.type === "instruction" && i.body.mesh?.board === id) return true;
    }
  }
  return false;
}

/** "in 2 hours", "in 40 minutes": how long until the limit lifts, as said to the agent taking over. */
/** Text for a RegExp that matches `s` as written. */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A turn's last words saying it is waiting on something (another agent, a job it left running): that sentence, or "". */
const WAITING = /\b(?:waiting (?:on|for)|until .{0,80}?\b(?:finish(?:es)?|commits?|lands?|is done|are done|arrives?|comes? (?:in|back)|reports?|is ready|are ready)|once .{0,80}?\b(?:finish(?:es)?|lands?|arrives?|is done|are done|commits?|come in|is in|are in|is ready|are ready)|when .{0,60}?\b(?:finish(?:es)?|is done|are done|lands?|completes?)\b.{0,40}?\bI(?:'| wi)ll|still (?:running|going|being (?:checked|reviewed))|(?:running|going) in the background|haven't come in|hasn't come in)/i;
export function waitingOn(said: string): string {
  const text = said.replace(/\s+/g, " ").trim();
  if (!text) return "";
  const sentences = text.split(/(?<=[.!])\s+(?=[A-Z*`"(])/);
  return sentences.find((s) => WAITING.test(s))?.trim() ?? "";
}

/** A path as agents give it, from the project's root: no "./" or leading "/", forward slashes. */
const cleanPath = (p: string) => p.trim().replace(/\\/g, "/").replace(/^\.?\/+/, "").slice(0, 300);

/** Another lane holding `path`: by claim_files, or as a file its board task owns. A folder (ending in /) holds what is in it. */
export function heldBy(state: SessionState, lane: string, path: string): { lane: string; name: string; why?: string; seq: number }[] {
  const covers = (h: string, p: string) => h === p || (h.endsWith("/") && p.startsWith(h)) || (p.endsWith("/") && h.startsWith(p));
  const out: { lane: string; name: string; why?: string; seq: number }[] = [];
  for (const [l, h] of Object.entries(state.holds ?? {})) {
    if (l !== lane && h.paths.some((x) => covers(x, path))) out.push({ lane: l, name: laneName(state, l), ...(h.why ? { why: h.why } : {}), seq: h.seq });
  }
  for (const t of state.board?.tasks ?? []) {
    if (t.status !== "claimed" || !t.lane || t.lane === lane || out.some((o) => o.lane === t.lane)) continue;
    if (t.owns.some((x) => covers(cleanPath(x), path))) out.push({ lane: t.lane, name: laneName(state, t.lane), why: `the board task "${t.title}"`, seq: -1 });
  }
  return out;
}

/** "out of usage until its limit lifts in about 3 hours (the same Claude account as Boss Man, which hit it)". */
function outOfUsage(state: SessionState, out: Limited, now: number): string {
  const when = out.until ? `until its limit lifts ${untilText(out.until - now)}` : "for now (its tool didn't say when its limit lifts)";
  const tool = state.engines[out.via ?? ""]?.tool;
  return `out of usage ${when}${out.via && tool ? `, as the same ${engineName(tool)} account as ${laneName(state, out.via)}, which hit it` : ""}`;
}

/** Agents that could take work now, by name: online, taking messages, not out of usage, and not those in `except`. Free ones first. */
function freeAgents(state: SessionState, events: SessionEvent[], except: string[]): string[] {
  const limited = limitedLanes(state, events);
  const ok = lanesOf(state).filter((l) => {
    if (except.includes(l) || limited.has(l) || laneOf(state, l)?.control.kind === "standing") return false;
    const e = state.engines[l];
    return !e?.tool || e.online;
  });
  const idle = (l: string) => runOf(state, l).status === "idle" && !pendingFor(state, l).length;
  return [...ok.filter(idle), ...ok.filter((l) => !idle(l))].slice(0, 4).map((l) => `${laneName(state, l)}${idle(l) ? "" : " (busy, takes it after)"}`);
}

function untilText(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 90) return `in ${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  return h < 36 ? `in about ${h} hours` : `in about ${Math.round(h / 24)} days`;
}

/**
 * Whether a review lets the work through. Approved passes; a review that names something to change sends it back. One that
 * says neither, and names no problem, passes too: sent back, its agent was told to "fix what was found" with nothing found,
 * and marked the task blocked (Arun, 2026-10-21, two tasks stuck that way).
 */
export function reviewPasses(said: string): boolean {
  if (/^\s*(\*\*)?(approved|lgtm|looks good)\b/i.test(said)) return true;
  // Saying it won't pass it, however it goes on: "I couldn't review this one, so I'm giving no approval. … Changes needed:" had
  // passed, on a later "Codex says it found no blockers there" (Arun, 2026-10-24, t3).
  if (/(?<!\bno )\bchanges (?:needed|requested)\b|\bnot approved\b|\b(?:giving|give|gave) no approval\b|\bno approval\b|\bwithhold(?:ing)? (?:my )?approval\b|\b(?:can'?t|cannot|couldn'?t|unable to) (?:approve|review|check|verify) (?:it|this|the|that|them|any)/i.test(said)) return false;
  // Saying it found nothing wrong is a pass however it is put: "no problems found", "nothing to fix", "no issues".
  const clean = /\bno (?:real |obvious |major )?(?:problems?|issues?|bugs?|concerns?|blockers?)\b|\bnothing (?:to fix|to change|wrong|blocking)\b|\bfound nothing\b/i;
  // A problem it names sends the work back (2026-10-21: "Found a problem: ... a double tap creates two charges" had passed,
  // as only "bug", "missing" or "fails" counted).
  if (!clean.test(said) && /\b(?:found|spotted|noticed|there(?:'s| is| are)|one|a|two|several|some)\s+(?:\w+\s+)?(?:problems?|issues?|concerns?|blockers?)\b|\bproblem:|\bissue:|\bdouble[- ]charg|\bcharges? twice\b/i.test(said)) return false;
  if (clean.test(said)) return true;
  if (/(?<!\bno )changes needed|(?<!\bno )changes requested|needs? (?:a |to be )?fix|\bfail(?:s|ed|ing)?\b|\bbug\b|\bbroken\b|\bmissing\b|\bwrong\b|\bregression\b|must (?:be )?(?:fix|change|add|remove)|should (?:be )?(?:fix|change|add|remove)|not approved|\breject/i.test(said)) return false;
  return true;
}
