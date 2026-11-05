import type { Redis } from "ioredis";
import type { LLM } from "./agent/llm.js";
import { attentionIn, type Attention } from "./attention.js";
import { askReply, parseChoices, type Ask } from "./ask-parse.js";
import { CLASS_LABEL, carefulClass, classesOf, type CommandClass } from "./command-class.js";
import { limitHit } from "./limit-reset.js";
import { stillLimited } from "./limited.js";
import { markOf, rankNeeds, type Blocks, type Need, type NeedChoice, type NeedMark, type Suggestion } from "./needs-rank.js";
import { goalChoices, goalsIn } from "./goals.js";
import { HIDDEN } from "./secrets.js";
import { laneName, type Command } from "./session/core.js";
import { driverOf, pendingFor, requestsTo, roleOf, runOf, type SessionState } from "./session/projection.js";
import type { SessionStore } from "./session/store.js";
import { MAIN_LANE, type EngineTool, type SessionEvent } from "./types.js";

/**
 * "Needs you": one ranked queue of everything waiting on a person, across their sessions, Crew rooms and teammates, each with
 * Friday's suggested answer and why, so most decisions take one tap (Arun, 2026-10-31). The shape and the API are in
 * needs-rank.ts.
 *
 * Nothing here is stored but the suggestions and what was put off: the queue is read from the sessions' own state every time,
 * so whatever is answered anywhere else (in the session, on another device, by a teammate, by Away) is gone at the next read.
 * Its sessions are attention.ts's, so the sidebar's Needs you and this queue never disagree about what waits on you.
 *
 * A suggestion is the asker's own pick when it gave one; else a rule for its kind (a command's class, a teammate's ask); else
 * one short call to a model, the person's own or Friday's metered one (app.ts says which), once per item, kept a week. Never
 * about a key or a password. And never sent by itself: the person presses it.
 */

/** A hosted Crew ask (hosted-crew.ts CrewAsk), as much of it as the queue reads: the open-source edition has none. */
export interface CrewAskLike {
  id: string;
  mateName: string;
  keeper: { id: string; name: string };
  from: { id: string; name: string };
  text: string;
  at: number;
  room?: { id: string; name: string };
  board?: { sid: string; id: string; lane: string; title: string };
  workflow?: { name: string; step: number };
  status: string;
}

export interface Me {
  id: string;
  name: string;
}

/**
 * The model a person's suggestions are written by, or null when they have none. Their work: Friday's metered model, their own
 * model, or their own coding tool (`tool`, the asking agent's when it runs on their computer), never anyone else's.
 */
export type Suggester = (me: Me, workspaceId: string, tool?: EngineTool) => Promise<{ llm: LLM; model?: string } | null>;

export interface NeedsDeps {
  store: Pick<SessionStore, "state" | "events" | "mine" | "hidden" | "buried">;
  redis: Redis;
  prefix: string;
  /** A command in a session, as the person (SessionCore.handle). */
  handle: (sid: string, me: Me, cmd: Command) => Promise<{ ok: boolean; error?: string }>;
  suggester: Suggester;
  /** Project memory (brain.ts): the answer to a check Friday offered after a mistake came back. */
  checks?: { answer(wid: string, me: Me, repo: string, entry: string, take: boolean): Promise<unknown> };
  /** Hosted Crew: the workspace's asks, and a keeper's answer to one. */
  crew?: { asks(wid: string): Promise<CrewAskLike[]>; answer(wid: string, me: Me, id: string, take: boolean, note?: string): Promise<unknown> };
  /** The open-source edition's crew workflows: runs waiting at a Your OK, and the answer to one (team-workflows.ts). */
  workflows?: { asks(): Promise<WorkflowAskLike[]>; answer(id: string, run: string, ok: boolean, said: string): Promise<unknown> };
}

/** A crew workflow's run waiting at its Your OK step. */
export interface WorkflowAskLike {
  id: string;
  name: string;
  run: string;
  n: number;
  ask: string;
  since: number;
  roomName?: string;
  /** The session the run works in. */
  sid?: string;
}

/** What an item does when answered: kept on the server, never sent to the page. */
type Act =
  | { do: "say"; sid: string; lane: string; asks?: Ask[] }
  | { do: "approve"; sid: string; lane: string; id: string }
  | { do: "plan"; sid: string; lane: string }
  | { do: "peer"; sid: string; lane: string; id: string }
  | { do: "control"; sid: string; lane: string; to: string }
  | { do: "retry"; sid: string; lane: string; text: string }
  | { do: "resume"; sid: string; lane: string; at: number }
  | { do: "crew"; ask: string }
  | { do: "workflow"; id: string; run: string }
  | { do: "check"; repo: string; entry: string }
  | { do: "open" };

/** An item as collected: the page's part, what answering it does, and what a model would read to suggest an answer. */
export interface Found {
  need: Omit<Need, "score" | "why">;
  act: Act;
  /** The agent's last words before it asked, for the model. */
  context?: string;
  /** Whether a model may be asked for a suggestion (no rule settled it, nothing secret in it). */
  ask?: boolean;
  /** The asking agent's coding tool, when it runs on this person's computer: theirs to ask. */
  tool?: EngineTool;
}

const SUGGESTION_TTL = 7 * 86_400;
const FAILED_TTL = 600;
const MODEL_AT_ONCE = 3;
const SESSIONS = 100;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const SECRETS = /\b(password|passphrase|passwd|secret|api[ _-]?key|access[ _-]?key|private[ _-]?key|token|credential|\.env)\b/i;
/** Whether a model must not read it: it names or holds a key, a token or a password. */
export const touchesSecret = (...texts: (string | undefined)[]) => texts.some((t) => !!t && (t.includes(HIDDEN) || SECRETS.test(t)));

/** "Friday Code" for an unnamed main lane, as attention.ts says it. */
const agentOf = (state: SessionState, lane: string) => {
  const n = laneName(state, lane);
  return lane === MAIN_LANE && n === "Main" ? "Friday Code" : n;
};

/** May this person answer for the agent on this lane: its driver, or the owner when nobody drives it (attention.ts's rule). */
const steers = (state: SessionState, me: string, lane: string) => {
  const d = driverOf(state, lane);
  return d ? d.id === me : roleOf(state, me) === "owner";
};

/**
 * What the agent on `lane` holds up: itself; when it leads, the room; its board tasks and those waiting on them.
 */
export function blocksOf(state: SessionState, lane?: string): Blocks {
  const lead = !!lane && state.lead === lane && state.lanes.length > 0;
  const open = state.board?.tasks.filter((t) => t.status !== "done" && t.status !== "cancelled") ?? [];
  const tasks = lead ? open.length : heldUp(state, open.filter((t) => lane && t.lane === lane).map((t) => t.id));
  return { agents: lead ? 1 + state.lanes.length : 1, tasks, ...(lead ? { lead } : {}), ...(state.options.team ? { room: true } : {}) };
}

/** These board tasks and every open one waiting on them, however far down: how many. */
function heldUp(state: SessionState, ids: string[]): number {
  const open = state.board?.tasks.filter((t) => t.status !== "done" && t.status !== "cancelled") ?? [];
  const held = new Set(ids);
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of open) if (!held.has(t.id) && t.after.some((d) => held.has(d))) (held.add(t.id), (grew = true));
  }
  return held.size;
}

/** A command's approval, by its riskiest part: safe kinds run by rule, careful ones are a "Don't" with the risk named. */
export function approvalRule(items: string[]): Suggestion {
  const classes = new Set<CommandClass>(items.flatMap((c) => classesOf(c)));
  const careful = carefulClass(items);
  if (careful) return { answer: "no", reason: `${CLASS_LABEL[careful].label}: ${CLASS_LABEL[careful].hint}. Look at it in the session first.`, by: "rule" };
  const said: Partial<Record<CommandClass, string>> = { read: "It only reads: nothing changes.", checks: "It runs the checks: nothing changes.", build: "It builds the project.", git: "Git on this computer only: nothing leaves it." };
  const top = (["git", "build", "checks", "read"] as const).find((c) => classes.has(c)) ?? "read";
  return { answer: "yes", reason: said[top]!, by: "rule" };
}

/** The steps of the agent's latest plan, from its update_plan call. */
function planSteps(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const list = Object.values(v).find(Array.isArray) as unknown[] | undefined;
    return (list ?? []).map((s) => (typeof s === "string" ? s : String((s as Record<string, unknown>)?.step ?? (s as Record<string, unknown>)?.text ?? (s as Record<string, unknown>)?.title ?? ""))).filter(Boolean);
  } catch {
    return [];
  }
}

/** The agent's words on this lane before `seq`: what it was doing when it asked. */
function contextBefore(events: SessionEvent[], lane: string, seq: number): string {
  const said = events.filter((e) => e.seq <= seq && (e.lane ?? MAIN_LANE) === lane && (e.body.type === "agent.message" || e.body.type === "instruction")).slice(-4);
  return clip(said.map((e) => `${e.body.type === "instruction" ? "Asked" : "Agent"}: ${clip((e.body as { text: string }).text.trim(), 600)}`).join("\n"), 1800);
}

/**
 * Everything in one session waiting on this person, as queue items: attention.ts's list for it, each with what it takes to answer,
 * and what that list leaves to the session's own cards: a plan waiting on approval, and an agent out of usage nobody could take
 * the work from.
 */
export function needsIn(state: SessionState, events: SessionEvent[], me: string, now = Date.now()): Found[] {
  const tsOf = (seq: number) => events.find((e) => e.seq === seq)?.ts ?? now;
  const goal = state.goal?.text;
  const base = (a: { seq: number; lane?: string }, kind: Need["kind"], who: string, text: string) => ({
    id: `${state.id}~${a.lane ?? MAIN_LANE}~${kind}~${a.seq}`,
    kind,
    who,
    where: { sid: state.id, title: state.title, ...(state.options.team ? { room: state.title } : {}) },
    text,
    since: tsOf(a.seq),
    blocks: blocksOf(state, a.lane ?? MAIN_LANE),
    ...(goal ? { goal } : {}),
  });
  const out: Found[] = [];
  for (const a of attentionIn(state, me)) {
    const lane = a.lane ?? MAIN_LANE;
    // Answered already, the answer waiting for the agent to read it (it stays asked until then): nothing more to decide.
    if ((a.kind === "question" || a.kind === "ask" || a.kind === "stopped") && pendingFor(state, lane).some((q) => q > a.seq)) continue;
    const who = a.agent ?? agentOf(state, lane);
    const context = contextBefore(events, lane, a.seq);
    const engine = state.engines[lane];
    const tool = engine?.tool && engine.hostId === me ? { tool: engine.tool } : {};
    if (a.kind === "question") {
      const q = state.openQuestions[lane]!;
      const parsed = q.options?.length ? { prompt: q.question, options: q.options.map((o) => ({ label: o, value: o })) } : parseChoices(q.question);
      const choices = parsed.options.map((o) => ({ label: o.label, value: o.label }));
      const picked = q.recommended && choices.find((c) => c.value.toLowerCase() === q.recommended!.toLowerCase());
      const secret = touchesSecret(q.question, q.detail);
      out.push({
        need: { ...base(a, "question", who, parsed.prompt), ...(q.detail ? { detail: q.detail } : {}), choices, free: true, ...(picked ? { suggestion: { answer: picked.value, reason: `${who}'s own recommendation.`, by: "asker" as const } } : q.recommended && !choices.length ? { suggestion: { answer: q.recommended, reason: `${who}'s own recommendation.`, by: "asker" as const } } : {}), ...(secret ? { noSuggestion: "Friday doesn't suggest answers about keys or passwords." } : {}) },
        act: { do: "say", sid: state.id, lane },
        context,
        ...tool,
        ask: !q.recommended && !secret,
      });
    } else if (a.kind === "ask" && state.asks[lane]) {
      // A coding tool's numbered questions: one row for the agent, the first question's choices one tap each.
      const asks = state.asks[lane]!.questions;
      const first = asks[0]!;
      const choices = first.options.map((o) => ({ label: o.label, value: askReply(asks, [{ key: o.key, label: o.label }]) }));
      const secret = touchesSecret(...asks.map((x) => x.question), ...first.options.map((o) => o.label));
      out.push({
        // Every question with its choices, as the agent's own card draws them, rather than the first's choices once as text and
        // again as buttons with the rest left out (audit CREW-17, 2026-11-04).
        need: { ...base(a, "ask", who, first.question || a.text), asks: asks.map((q) => ({ question: q.question, options: q.options.map((o) => ({ key: o.key, label: o.label, ...(o.detail ? { detail: o.detail } : {}) })) })), choices, free: true, ...(secret ? { noSuggestion: "Friday doesn't suggest answers about keys or passwords." } : {}) },
        act: { do: "say", sid: state.id, lane, asks },
        context,
        ...tool,
        ask: !secret,
      });
    } else if (a.kind === "ask") {
      // A message from another session, held for someone who steers this agent.
      const h = (state.peersHeld ?? []).find((x) => x.seq === a.seq && x.lane === lane);
      if (!h) continue;
      out.push({
        need: { ...base(a, "held", h.fromName, `${h.fromName} in "${h.fromTitle}" sent ${who} a message`), choices: [{ label: "Let it through", value: "yes" }, { label: "Turn it down", value: "no" }], free: false, suggestion: { answer: "yes", reason: `From a session you're in: ${who} reads it as a message, not an order.`, by: "rule" } },
        act: { do: "peer", sid: state.id, lane, id: h.id },
      });
    } else if (a.kind === "approval") {
      const ap = state.approvals[lane]!;
      const command = ap.scope === "commands";
      const rule = command ? approvalRule(ap.items) : undefined;
      const choices: NeedChoice[] = [{ label: command ? "Run it" : "Let it", value: "yes" }, { label: "Don't", value: "no" }];
      const secret = touchesSecret(...ap.items);
      out.push({
        need: { ...base(a, "approval", who, a.text), ...(ap.items.length > 1 ? { detail: ap.items.join("\n") } : {}), choices, free: true, command, ...(rule ? { suggestion: rule } : {}) },
        act: { do: "approve", sid: state.id, lane, id: ap.id },
        context,
        ...tool,
        ask: !rule && !secret,
      });
    } else if (a.kind === "control") {
      const r = requestsTo(state, me)[0];
      if (!r) continue;
      const busy = runOf(state, r.lane).status === "running";
      out.push({
        need: { ...base({ seq: r.seq, lane: r.lane }, "control", r.name, a.text), choices: [{ label: `Give it to ${r.name}`, value: "yes" }, { label: "Keep it", value: "no" }], free: false, suggestion: busy ? { answer: "no", reason: `${agentOf(state, r.lane)} is in the middle of a turn for you.`, by: "rule" } : { answer: "yes", reason: `Nothing is running for you there now.`, by: "rule" } },
        act: { do: "control", sid: state.id, lane: r.lane, to: r.id },
      });
    } else if (a.kind === "stopped") {
      const ended = events.findLast((e) => e.body.type === "run.ended" && (e.lane ?? MAIN_LANE) === lane)?.seq ?? Infinity;
      const asked = events.findLast((e) => e.seq < ended && e.body.type === "instruction" && (e.lane ?? MAIN_LANE) === lane);
      const again = asked?.body.type === "instruction" ? asked.body.text.trim() : "";
      out.push({
        need: { ...base(a, "stopped", who, a.text), ...(a.detail ? { detail: a.detail } : {}), choices: again ? [{ label: "Try again", value: "yes" }] : [], free: true, ...(again ? { suggestion: { answer: "yes", reason: "Sends its last message again, as it was.", by: "rule" as const } } : {}) },
        act: again ? { do: "retry", sid: state.id, lane, text: again } : { do: "say", sid: state.id, lane },
      });
    } else {
      // A handover or a mention: somebody's word to read, in its session.
      out.push({ need: { ...base(a, a.kind, a.kind === "handover" ? state.handover!.from.name : state.mentions?.[me]?.byName ?? who, a.text), choices: [], free: false }, act: { do: "open" } });
    }
  }
  for (const lane of [MAIN_LANE, ...state.lanes.map((l) => l.id)]) {
    if (!steers(state, me, lane) || state.approvals[lane] || state.openQuestions[lane]) continue;
    const run = runOf(state, lane);
    const who = agentOf(state, lane);
    // A plan waiting on its OK (Plan first): its latest plan, not approved, with nothing said to it since.
    if (state.options.planFirst && run.status !== "running") {
      const plan = events.findLast((e) => (e.lane ?? MAIN_LANE) === lane && e.body.type === "agent.message" && e.body.toolCalls.some((c) => c.name === "update_plan"));
      const since = plan && events.some((e) => e.seq > plan.seq && (e.lane ?? MAIN_LANE) === lane && e.body.type === "instruction");
      if (plan?.body.type === "agent.message" && plan.seq > (state.planApproved[lane] ?? 0) && !since) {
        const steps = planSteps(plan.body.toolCalls.findLast((c) => c.name === "update_plan")!.arguments);
        out.push({
          need: { ...base({ seq: plan.seq, lane }, "plan", who, `${who} has a plan${steps.length ? ` in ${steps.length} step${steps.length === 1 ? "" : "s"}` : ""} for your OK`), ...(steps.length ? { detail: steps.map((s, i) => `${i + 1}. ${s}`).join("\n") } : {}), choices: [{ label: "Approve", value: "yes" }], free: true },
          act: { do: "plan", sid: state.id, lane },
          context: clip(`${plan.body.text}\n${steps.join("\n")}`, 1800),
          ask: true,
        });
      }
    }
    // Finished its turn with its plan short ("stopped at 3 of 5"): Carry on is yours, as the Board has always said it, so this
    // list and the Board count the same things (audit REST-2, Arun 2026-11-04).
    const plan = state.planDone?.[lane];
    const ended = state.finished?.[lane];
    if (plan && plan.done < plan.of && ended !== undefined && state.stopped?.[lane] === undefined && run.status !== "running" && run.status !== "error" && run.status !== "paused") {
      out.push({
        need: { ...base({ seq: ended, lane }, "stopped", who, `Stopped at ${plan.done} of ${plan.of} of its plan`), choices: [{ label: "Carry on", value: "Carry on with the plan." }], free: true, suggestion: { answer: "Carry on with the plan.", reason: "Picks up at the next step of its own plan.", by: "rule" } },
        act: { do: "say", sid: state.id, lane },
      });
    }
    // Out of usage, nothing carried it on and nothing will pick it up: carry on when it resets, or leave it.
    if (run.status === "error" && !state.resumes[lane] && stillLimited(events, lane, now)) {
      const end = events.findLast((e) => e.body.type === "run.ended" && (e.lane ?? MAIN_LANE) === lane);
      if (!end || events.some((e) => e.seq > end.seq && e.body.type === "instruction" && (e.body.handoff?.fromLane === lane || e.body.mesh?.carriedFrom === lane))) continue;
      const resets = limitHit(run.error, end.ts)?.resetsAt;
      const at = resets && resets > now ? resets + 60_000 : now + 3_600_000;
      const when = new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      out.push({
        need: { ...base({ seq: end.seq, lane }, "limit", who, `${who} ran out of usage partway through, and no other agent could take it`), choices: [{ label: `Carry on at ${when}`, value: String(at) }], free: false, suggestion: { answer: String(at), reason: resets ? "Its limit lifts then; it picks up where it stopped." : "It didn't say when its limit lifts; this tries in an hour.", by: "rule" } },
        act: { do: "resume", sid: state.id, lane, at },
      });
    }
  }
  // A goal this person set that is at risk (goals.ts): one item per goal and reason, its answers carry on or re-plan. A goal
  // waiting on their answer is not a second item: the question or approval it waits on is already here.
  for (const g of goalsIn(state, events, now)) {
    if (g.status !== "at-risk" || (g.by && g.by !== me)) continue;
    out.push({
      need: {
        id: `${g.id}~${g.risk}`,
        kind: "goal",
        who: "Friday",
        where: { sid: state.id, title: state.title, ...(g.where.room ? { room: state.title } : {}) },
        text: `“${g.text}” is at risk: ${g.why ?? ""}`,
        since: g.moved,
        blocks: blocksOf(state, g.where.lane),
        goal: g.text,
        choices: goalChoices(g),
        free: true,
      },
      act: { do: "say", sid: state.id, lane: g.where.lane },
    });
  }
  // A check Friday offered here after a mistake came back (brain.ts), for the session's owner, until it is answered.
  if (state.ownerId === me) {
    const answered = new Set(events.flatMap((e) => (e.body.type === "brain.check.answered" ? [e.body.entry] : [])));
    for (const e of events) {
      if (e.body.type !== "brain.check.proposed" || answered.has(e.body.entry)) continue;
      const b = e.body;
      out.push({
        need: {
          ...base({ seq: e.seq, lane: e.lane }, "check", "Friday", `Agents were corrected ${b.times === 2 ? "twice" : `${b.times} times`} on ${b.repoName} for the same mistake, and it came back after they were told: ${b.why} Add a check Friday runs after every change there: ${b.command}`),
          choices: [{ label: "Add the check", value: "yes" }, { label: "No", value: "no" }],
          free: false,
          suggestion: { answer: "yes", reason: "A rule agents read didn't stop it; a command Friday runs will catch it.", by: "rule" },
        },
        act: { do: "check", repo: b.repo, entry: b.entry },
      });
    }
  }
  return out;
}

/** An ask of a teammate you keep, from someone else: one tap takes it on, as your work. */
export function crewNeed(a: CrewAskLike, board?: SessionState): Found {
  const what = a.board ? `Board task: ${a.board.title}` : a.workflow ? `${a.workflow.name}, step ${a.workflow.step + 1}: ${a.text}` : a.text;
  const blocks: Blocks = { agents: 1, tasks: a.board ? (board ? heldUp(board, [a.board.id]) : 1) : 0, ...(a.room ? { room: true } : {}) };
  return {
    need: {
      id: `crew~${a.id}`,
      kind: "crew",
      who: a.from.name,
      where: { title: a.room?.name ?? "Crew", ...(a.room ? { room: a.room.name } : {}), ...(a.board ? { sid: a.board.sid } : {}) },
      text: `${a.from.name} asked ${a.mateName}: ${what}`,
      since: a.at,
      blocks,
      choices: [{ label: "Take it on", value: "yes" }, { label: "Decline", value: "no" }],
      free: true,
      suggestion: { answer: "yes", reason: `${a.mateName} runs it on your plan, as your work.`, by: "rule" },
    },
    act: { do: "crew", ask: a.id },
  };
}

/**
 * A workflow waiting at its Your OK: on this list as everywhere else that waits on you. It showed only on the canvas and in the
 * Crew room, with Needs you saying "Nothing is waiting on you" and its badge at 0 (2026-11-04 end-to-end check).
 */
export function workflowNeed(a: WorkflowAskLike): Found {
  return {
    need: {
      // Its run and when this ask began: sent back with a note, the same run asks again later, and that new ask is a new item. Keyed
      // by the run alone, the page still held the answered one as gone and the new ask never showed until a reload (2026-11-04 retest).
      id: `wf~${a.id}~${a.run}~${a.since}`,
      kind: "crew",
      who: a.name,
      // In its room's session when it has one, so the room's row counts it as everything else waiting there.
      where: { title: a.roomName ?? "Crew", ...(a.roomName ? { room: a.roomName } : {}), ...(a.sid ? { sid: a.sid } : {}) },
      text: `${a.name}, step ${a.n}: ${a.ask}`,
      since: a.since,
      blocks: { agents: 1, tasks: 0 },
      choices: [{ label: "OK", value: "yes" }, { label: "Say no", value: "no" }],
      free: true,
    },
    act: { do: "workflow", id: a.id, run: a.run },
  };
}

/** What the model is asked: pick one of the answers, or write a short one, and say why in a line; "none" when nothing is right. */
export function suggestPrompt(f: Found): { system: string; prompt: string } {
  const n = f.need;
  const system = [
    "You help one person get through the decisions their AI agents are waiting on. For the item below, suggest the answer they most likely want, so they can accept it with one tap.",
    'Reply with JSON only: {"answer": "...", "reason": "..."}. "reason" is one short line (under 15 words) saying why.',
    n.choices.length ? `"answer" must be exactly one of these values: ${n.choices.map((c) => JSON.stringify(c.value)).join(", ")}.` : `"answer" is the reply to send, at most two sentences.`,
    n.kind === "approval" ? 'Be careful: suggest "no" for anything that deletes, overwrites, deploys, publishes or reaches outside the project unless the context shows the person asked for exactly that.' : "",
    'If there is no answer you would stand behind, reply {"answer": "none", "reason": "..."} instead of guessing.',
  ].filter(Boolean).join("\n");
  const prompt = [`${n.who} asks (in "${n.where.title}"):`, n.text, n.detail ? `\nDetails:\n${clip(n.detail, 1200)}` : "", n.choices.length ? `\nAnswers: ${n.choices.map((c) => `${JSON.stringify(c.value)} (${c.label})`).join("; ")}` : "", f.context ? `\nWhat led up to it:\n${f.context}` : "", n.goal ? `\nThe goal: ${n.goal}` : ""].filter(Boolean).join("\n");
  return { system, prompt };
}

/** The model's reply as a suggestion, or null when it isn't one of the answers or it had none. */
export function parseSuggestion(text: string, f: Found): Suggestion | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]) as { answer?: unknown; reason?: unknown };
    const answer = typeof v.answer === "string" ? v.answer.trim() : "";
    const reason = typeof v.reason === "string" ? clip(v.reason.trim(), 160) : "";
    if (!answer || !reason || answer.toLowerCase() === "none") return null;
    if (f.need.choices.length) {
      const c = f.need.choices.find((x) => x.value === answer) ?? f.need.choices.find((x) => x.value.toLowerCase() === answer.toLowerCase() || x.label.toLowerCase() === answer.toLowerCase());
      return c ? { answer: c.value, reason, by: "friday" } : null;
    }
    return { answer: clip(answer, 600), reason, by: "friday" };
  } catch {
    return null;
  }
}

export class NeedsYou {
  constructor(private d: NeedsDeps) {}

  private key = (kind: string, me: string, id = "") => `${this.d.prefix}needs:${kind}:${me}${id ? `:${id}` : ""}`;

  /**
   * Everything waiting on this person in this workspace, collected fresh: the sessions the server knows they're in (and any the
   * browser adds), checked for membership one by one, and their Crew asks.
   */
  async collect(me: Me, wid: string, more: string[] = []): Promise<Found[]> {
    const [listed, hidden] = await Promise.all([this.d.store.mine(me.id, SESSIONS), this.d.store.hidden(me.id)]);
    const sids = [...new Set([...listed.map((r) => r.sid), ...more])].filter((s) => /^[\w-]{1,200}$/.test(s) && !hidden.has(s)).slice(0, SESSIONS * 2);
    const states = new Map<string, SessionState>();
    const found: Found[] = [];
    await Promise.all(
      sids.map(async (sid) => {
        if (await this.d.store.buried(sid).catch(() => true)) return;
        const state = await this.d.store.state(sid).catch(() => null);
        const m = state?.members[me.id];
        if (!state || !m || m.removed || (wid && state.workspaceId && state.workspaceId !== wid)) return;
        states.set(sid, state);
        // The log is read only where something could be waiting: an item, a plan, a stopped run.
        const lanes = [MAIN_LANE, ...state.lanes.map((l) => l.id)];
        // A plan stopped short counts too: it was left out here, so this list never had it while the Board, the sidebar and Home did
        // (2026-11-04 end-to-end check: "stopped at 4 of 5" counted 2 or 3 there, 1 here, and ⌘⇧U never reached it).
        const short = (l: string) => ((p) => !!p && p.done < p.of && state.finished?.[l] !== undefined && state.stopped?.[l] === undefined)(state.planDone?.[l]);
        const maybe = attentionIn(state, me.id).length > 0 || lanes.some((l) => state.options.planFirst || runOf(state, l).status === "error" || short(l)) || (state.ownerId === me.id && !!state.checkOffers?.length);
        if (!maybe) return;
        const events = await this.d.store.events(sid).catch(() => [] as SessionEvent[]);
        found.push(...needsIn(state, events, me.id));
      }),
    );
    if (this.d.workflows) for (const a of await this.d.workflows.asks().catch(() => [] as WorkflowAskLike[])) found.push(workflowNeed(a));
    if (this.d.crew && wid) {
      const asks = (await this.d.crew.asks(wid).catch(() => [])).filter((a) => a.keeper.id === me.id && a.status === "open");
      for (const a of asks) found.push(crewNeed(a, a.board ? states.get(a.board.sid) : undefined));
    }
    // Put off: kept under the page's "N put off · Show", and left out of every count of what waits on the person, the page's own
    // heading and the badge alike (2026-11-04 retest: after Not now the page said "Nothing new is waiting on you" and the badge
    // "1 waiting").
    const off = await this.offOf(me);
    for (const f of found) if (off.has(f.need.id)) f.need.putOff = true;
    return found;
  }

  /** The queue: ranked, each with its suggestion (cached, or asked for now in the background), none of the server's own parts. */
  async list(me: Me, wid: string, more: string[] = []): Promise<Need[]> {
    const found = await this.collect(me, wid, more);
    const want = found.filter((f) => f.ask && !f.need.suggestion && !f.need.putOff);
    const cached = want.length ? await this.d.redis.mget(...want.map((f) => this.key("s", me.id, f.need.id))) : [];
    let started = 0;
    want.forEach((f, i) => {
      const got = cached[i];
      if (got) {
        const s = JSON.parse(got) as Suggestion | { none: string };
        if ("answer" in s) f.need.suggestion = s;
        else f.need.noSuggestion = s.none;
      } else if (started < MODEL_AT_ONCE) {
        started++;
        f.need.thinking = true;
        void this.suggest(me, wid, f);
      } else f.need.thinking = true;
    });
    return rankNeeds(found.map((f) => f.need));
  }

  /**
   * The queue as counts read it: every item the page lists, put off or not, without suggestions, and the ids put off (a pull
   * request's review is put off by its id too, though it is read on the person's computer). The sidebar, its badge, the Board,
   * Home and the Crew rows count from this, so they count what the page lists, and leave out what it keeps under "put off"
   * (2026-11-04 retest: the page said 3, the badge 1, the sidebar 1, the Board 3 and 5).
   */
  async marks(me: Me, wid: string, more: string[] = []): Promise<{ needs: NeedMark[]; off: string[] }> {
    const [found, off] = await Promise.all([this.collect(me, wid, more), this.offOf(me)]);
    return { needs: found.map((f) => markOf(f.need)), off: [...off].slice(0, 500) };
  }

  /** The ids this person put off with "Not now". */
  async offOf(me: Me): Promise<Set<string>> {
    return new Set(await this.d.redis.smembers(this.key("off", me.id)));
  }

  /** One short model call for one item, once: a lock so two polls don't both ask, and the answer (or that there was none) kept. */
  async suggest(me: Me, wid: string, f: Found): Promise<Suggestion | null> {
    const key = this.key("s", me.id, f.need.id);
    if (!(await this.d.redis.set(`${key}:lock`, "1", "EX", 120, "NX"))) return null;
    const keep = (v: Suggestion | { none: string }, ttl: number) => this.d.redis.set(key, JSON.stringify(v), "EX", ttl);
    try {
      const m = await this.d.suggester(me, wid, f.tool);
      if (!m) return (await keep({ none: "No model to suggest with: set one up in Settings › Your models." }, FAILED_TTL), null);
      const { system, prompt } = suggestPrompt(f);
      const r = await m.llm.complete({ system, messages: [{ role: "user", content: prompt }], tools: [], signal: AbortSignal.timeout(30_000), ...(m.model ? { model: m.model } : {}) });
      const s = parseSuggestion(r.text, f);
      await keep(s ?? { none: "Friday has no answer it would stand behind: yours to say." }, SUGGESTION_TTL);
      return s;
    } catch (e) {
      console.warn("[needs-you]", (e as Error).message);
      await keep({ none: "Friday couldn't read this one just now." }, FAILED_TTL);
      return null;
    }
  }

  /** "Not now": off this person's queue; a new wait is a new item, so it comes back when the agent asks again. */
  async dismiss(me: Me, id: string): Promise<void> {
    const k = this.key("off", me.id);
    await this.d.redis.sadd(k, id.slice(0, 300));
    await this.d.redis.expire(k, 14 * 86_400);
  }

  /**
   * The person's answer to one item: found again first, so an answer to something already answered, gone or not theirs says so
   * rather than landing somewhere it no longer fits. `answer` is a choice's value, or their own words where the item takes them.
   */
  async answer(me: Me, wid: string, id: string, answer: string, edited = false): Promise<{ ok: true; said: string } | { ok: false; status: number; error: string }> {
    const sid = id.startsWith("crew~") || id.startsWith("wf~") ? "" : id.split("~")[0]!;
    const found = (await this.collect(me, wid, sid ? [sid] : [])).find((f) => f.need.id === id);
    if (!found) return { ok: false, status: 404, error: "That's no longer waiting on you: it was answered or went away." };
    const n = found.need;
    const choice = n.choices.find((c) => c.value === answer);
    const text = answer.trim().slice(0, 8000);
    if (!choice && (!n.free || !text)) return { ok: false, status: 400, error: n.free ? "Say something to send." : "Pick one of its answers." };
    const a = found.act;
    const run = async (sid: string, cmd: Command) => {
      const r = await this.d.handle(sid, me, cmd);
      if (!r.ok) throw new Error(r.error ?? "Couldn't send that.");
    };
    try {
      switch (a.do) {
        case "say":
          await run(a.sid, { type: "instruct", text, lane: a.lane });
          break;
        case "approve":
          await run(a.sid, { type: "approval.answer", lane: a.lane, id: a.id, approve: choice?.value === "yes" });
          // Your own words instead: a no, and what to do instead.
          if (!choice) await run(a.sid, { type: "instruct", text, lane: a.lane });
          break;
        case "plan":
          await run(a.sid, choice ? { type: "plan.approve", lane: a.lane } : { type: "plan.review", verdict: "changes", note: text, lane: a.lane });
          break;
        case "peer":
          await run(a.sid, { type: "peer.settle", id: a.id, deliver: answer === "yes", lane: a.lane });
          break;
        case "control":
          await run(a.sid, answer === "yes" ? { type: "control.yield", to: a.to, lane: a.lane } : { type: "control.deny", to: a.to, lane: a.lane });
          break;
        case "retry":
          await run(a.sid, { type: "instruct", text: choice ? a.text : text, lane: a.lane });
          break;
        case "resume":
          await run(a.sid, { type: "resume.at", at: a.at, lane: a.lane });
          break;
        case "crew":
          await this.d.crew!.answer(wid, me, a.ask, choice ? answer === "yes" : true, choice ? undefined : text);
          break;
        case "workflow":
          // Your own words: a no, with what to change, as the canvas's Say no takes it.
          await this.d.workflows!.answer(a.id, a.run, !!choice && answer === "yes", choice ? "" : text);
          break;
        case "check":
          if (!this.d.checks) return { ok: false, status: 400, error: "Open it to answer." };
          await this.d.checks.answer(wid, me, a.repo, a.entry, answer === "yes");
          break;
        case "open":
          return { ok: false, status: 400, error: "Open it to answer." };
      }
    } catch (e) {
      return { ok: false, status: (e as { status?: number }).status ?? 409, error: (e as Error).message };
    }
    // How often the suggestion was what was sent: what a later routing session can tune by.
    const took = n.suggestion && !edited && n.suggestion.answer === answer ? "took" : "changed";
    void this.d.redis.hincrby(`${this.d.prefix}needs:said:${me.id}`, `${n.kind}:${n.suggestion?.by ?? "none"}:${took}`, 1).catch(() => {});
    return { ok: true, said: choice?.label ?? clip(text, 80) };
  }
}
