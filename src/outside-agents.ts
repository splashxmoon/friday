/**
 * Agents outside Friday, driving it (Arun, 2026-10-30: Friday becomes the place agents hand work to). Claude Code, Codex, Cursor
 * or anything else that speaks MCP, running on this computer, starts Friday sessions, tells their agents things, reads how they
 * are doing, waits for them, answers what they ask, and asks the crew.
 *
 * The outside agent starts Friday's small stdio server (local/outside-mcp.ts), which forwards each call to this Friday over
 * 127.0.0.1 with the token kept in Friday's data folder; app.ts checks the token and hands the call here. What it may do is what
 * the person at this computer may do in the app, through the same commands (SessionCore.handle), and everything it writes is
 * marked as from that agent (ActorRef.via), so the person sees who started what. The in-Friday agents' own tools (app-tools.ts)
 * are the pattern: those act for the person from inside a session, these from outside any.
 */
import { randomBytes } from "node:crypto";
import { attentionIn } from "./attention.js";
import type { CommandActor, CommandResult, Command } from "./session/core.js";
import { laneName } from "./session/core.js";
import { pendingFor, runOf, type SessionState } from "./session/projection.js";
import type { SessionStore } from "./session/store.js";
import { ENGINE_NAMES, ENGINE_TOOLS, MAIN_LANE, type EngineMode, type EngineTool, type SessionEvent } from "./types.js";
import { pickSession } from "./app-tools.js";

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const session = { type: "string", description: "The session: its id from list_sessions or start_session, or its title." };
const agentArg = { type: "string", description: "Which agent in it: its id or name from read_session. Its lead, or its only one, if left out." };

/** The tools, as MCP lists them. Baked into the stdio server too (local/outside-mcp.ts), so they list while Friday is closed. */
export const OUTSIDE_TOOLS = [
  {
    name: "list_sessions",
    description: "Friday's sessions on this computer, latest first: Code, Work and the Crew's, each with its agents, what each is doing, and anything waiting on the person.",
    inputSchema: obj({ limit: { type: "number", description: "How many, 1 to 50 (default 20)." } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "start_session",
    description:
      "Hand work to Friday: start a new session on this computer whose coding agent does the task. Code for work in a folder or repo, Work for writing, research and the like. It starts at once and shows in Friday's sidebar as started by you; follow it with wait_for_idle or read_session.",
    inputSchema: obj(
      {
        prompt: { type: "string", description: "The task, as a complete instruction: what, where, and what done looks like." },
        folder: { type: "string", description: "The full path of the folder or repo it works in. A repo gets its own copy (a git worktree) unless in_place is true. Left out: a new project folder." },
        tool: { type: "string", description: `Its coding tool: auto (default: Friday picks the best one ready for the task) or one of ${ENGINE_TOOLS.join(", ")}.` },
        kind: { type: "string", enum: ["code", "work"], description: "Code (default) or Work." },
        title: { type: "string", description: "A short title. From the prompt if left out." },
        mode: { type: "string", enum: ["plan", "edits", "full"], description: "How far its agent may go without asking: plan (look, don't change), edits (change files, ask before commands) or full (default, as Friday's own new sessions)." },
        in_place: { type: "boolean", description: "Work in the folder itself rather than a copy of the repo. Off by default, so it never edits under you." },
      },
      ["prompt"],
    ),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  {
    name: "send_message",
    description: "Tell an agent in a session something: its next task, a correction, an answer. It acts on it (a message to a busy agent waits its turn). to people: a note for the person in the session's chat, which no agent reads.",
    inputSchema: obj(
      {
        session,
        text: { type: "string", description: "What to say." },
        agent: agentArg,
        to: { type: "string", enum: ["agent", "people"], description: "agent (default) or people." },
      },
      ["session", "text"],
    ),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  {
    name: "read_session",
    description: "A session as it stands: each agent and its status, what is waiting on the person (a permission request, a question), and its latest messages. Page with after.",
    inputSchema: obj(
      {
        session,
        after: { type: "number", description: "Only messages after this seq (next_after from the last read)." },
        limit: { type: "number", description: "How many messages, 1 to 100 (default 20)." },
      },
      ["session"],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "wait_for_idle",
    description:
      "Wait until a session's agents are done, or one needs the person (a permission request or a question), or the time runs out; then the session as read_session gives it. Call it again on timeout to keep waiting.",
    inputSchema: obj(
      {
        session,
        agent: { type: "string", description: "Wait for this agent only. All of them if left out." },
        timeout_seconds: { type: "number", description: "How long to wait, 1 to 600 (default 50: under the one minute some clients give a call)." },
      },
      ["session"],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "answer",
    description: "Answer what an agent is waiting on: approve true or false for its permission request, or text for its question. read_session says what is waiting.",
    inputSchema: obj(
      {
        session,
        agent: agentArg,
        approve: { type: "boolean", description: "Yes or no to its permission request." },
        text: { type: "string", description: "The answer to its question." },
      },
      ["session"],
    ),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  {
    name: "list_teammates",
    description: "The person's Crew in Friday: persistent AI teammates, each with its role, coding tool and what it is doing.",
    inputSchema: obj({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "ask_teammate",
    description: "Ask a Crew teammate something, or give it work, in the Crew room; waits for its reply up to wait_seconds.",
    inputSchema: obj(
      {
        name: { type: "string", description: "The teammate's name, from list_teammates." },
        text: { type: "string", description: "What to ask or tell it." },
        wait_seconds: { type: "number", description: "How long to wait for its reply, 0 to 600 (default 50). 0 sends it and returns." },
      },
      ["name", "text"],
    ),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
] as const;

export const OUTSIDE_INSTRUCTIONS =
  "Friday runs coding agents on this computer (the person's own Claude Code, Codex, Cursor and more) in sessions the person watches. Hand work to it with start_session, follow it with wait_for_idle and read_session, steer it with send_message, and answer what its agents wait on with answer. Everything you do shows in Friday as from you.";

/** What a client calls itself in MCP's initialize (clientInfo.name), as the person knows it. */
export function outsideName(raw: unknown): string {
  const s = typeof raw === "string" ? raw.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 40) : "";
  const low = s.toLowerCase();
  if (/^claude[- ]?code|^claude-ai|^claude$/.test(low)) return "Claude Code";
  if (/^codex/.test(low)) return "Codex";
  if (/^cursor/.test(low)) return "Cursor";
  if (/^(vscode|visual studio code|github copilot)/.test(low)) return "VS Code";
  if (/^gemini/.test(low)) return "Gemini CLI";
  if (/^opencode/.test(low)) return "OpenCode";
  if (/^windsurf/.test(low)) return "Windsurf";
  if (/^zed/.test(low)) return "Zed";
  return s || "An outside agent";
}

export interface OutsideResult {
  output: string;
  isError?: boolean;
}

export interface OutsideDeps {
  store: SessionStore;
  handle(sid: string, actor: CommandActor, cmd: Command): Promise<CommandResult>;
  /** The person at this computer. */
  me(): Promise<{ id: string; name: string }>;
  workspaceId: string;
  /** Sessions never listed: hidden by the person, or Crew rooms they removed (LocalPeers.skipped). */
  skipped(ownerId: string): Promise<Set<string>>;
  /** The Crew room, when there is a crew. */
  teamSid(): Promise<string | null>;
  /** A session's coding tool started on this computer (app.ts startTool), resolved once it is. */
  startTool(sid: string, owner: { id: string; name: string }, p: { tool: EngineTool; cwd: string; mode: EngineMode; copy: boolean; project: string }): Promise<unknown>;
  /** The tool Friday would pick for a task (routing.ts rankTools), or null when none is ready. */
  pickTool(ownerId: string, task: string): Promise<EngineTool | null>;
  /** Whether `folder` is a folder on this computer, and whether it is a git repo. */
  folder(p: string): Promise<{ dir: boolean; repo: boolean }>;
  /** Work sessions, where this Friday has them (local-edition.ts). */
  work: boolean;
  /** The Crew, where this Friday has one: its room, and its teammates as the app shows them. Null when there is none yet. */
  crew?: () => Promise<{ sid: string; mates: { name: string; role: string; tool: string; status: string; line: string; lane: string }[] } | null>;
  /** How long wait_for_idle looks between reads; tests make it short. */
  pollMs?: number;
}

/** Sessions looked at, newest first, as the in-Friday tools look (app-tools.ts LOOK_AT). */
const LOOK_AT = 60;
const MAX_TEXT = 8000;
const STARTS_PER_HOUR = 20;
const MESSAGES_PER_MINUTE = 60;

const lanesOf = (s: SessionState) => [MAIN_LANE, ...s.lanes.map((l) => l.id)].filter((l) => !(s.options.team && l === MAIN_LANE));
const kindOf = (s: SessionState) => (s.options.team ? "crew" : s.options.work ? "work" : "code");
const out = (v: unknown): OutsideResult => ({ output: JSON.stringify(v, null, 2) });
const fail = (output: string): OutsideResult => ({ output, isError: true });

/** A session's name from its task: the first line, cut at a word. */
export function titleOf(text: string, max = 60): string {
  const line = text.split("\n").find((l) => l.trim())?.replace(/\s+/g, " ").trim() ?? "";
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const word = cut.lastIndexOf(" ");
  return `${(word > max / 2 ? cut.slice(0, word) : cut).replace(/[\s,;:.\-–—]+$/, "")}…`;
}

/** What an agent is doing, in a word the caller can branch on. */
export function laneStatus(s: SessionState, lane: string): "working" | "queued" | "needs_you" | "offline" | "error" | "idle" {
  const run = runOf(s, lane).status;
  if (s.approvals[lane] || run === "waiting_for_human" || (s.asks[lane] && run !== "running") || s.openQuestions?.[lane]) return "needs_you";
  if (run === "running") return "working";
  const engine = s.engines[lane];
  const queued = pendingFor(s, lane).length > 0;
  if (engine && !engine.online) return queued ? "queued" : "offline";
  if (queued) return "queued";
  return run === "error" ? "error" : "idle";
}

const busy = (st: string) => st === "working" || st === "queued";

/** A person's or an agent's message, as the caller reads it. */
function messageOf(s: SessionState, e: SessionEvent): Record<string, unknown> | null {
  const b = e.body;
  const kind = b.type === "instruction" ? "to_agent" : b.type === "agent.message" && b.text.trim() ? "agent_reply" : b.type === "chat" ? "to_people" : b.type === "suggestion" ? "suggestion" : null;
  if (!kind) return null;
  const text = "text" in b ? String(b.text) : "";
  const lane = e.lane ?? MAIN_LANE;
  return {
    seq: e.seq,
    kind,
    agent: laneName(s, lane),
    agent_id: lane,
    from: kind === "agent_reply" ? laneName(s, lane) : e.actor.via ? `${e.actor.via}, for ${e.actor.name}` : e.actor.name,
    text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text,
    at: new Date(e.ts).toISOString(),
  };
}

export class OutsideAgents {
  constructor(private d: OutsideDeps) {}

  private async limited(key: string, n: number, windowS: number): Promise<boolean> {
    const k = `${this.d.store.prefix}outside:${key}`;
    const used = await this.d.store.redis.incr(k);
    if (used === 1) await this.d.store.redis.expire(k, windowS);
    return used > n;
  }

  /** The person's sessions, newest first, with their states. */
  private async recent(ownerId: string, limit = LOOK_AT): Promise<{ s: SessionState; at: number }[]> {
    const skip = await this.d.skipped(ownerId).catch(() => new Set<string>());
    const rows = (await this.d.store.mine(ownerId, limit)).filter((r) => !skip.has(r.sid));
    const states = await Promise.all(rows.map(async (r) => ({ at: r.at, s: await this.d.store.state(r.sid).catch(() => null) })));
    return states.filter((x): x is { at: number; s: SessionState } => !!x.s?.ownerId).sort((a, b) => b.at - a.at);
  }

  /** The session meant: by id (any of the person's), or by its title among the recent ones. */
  private async find(ownerId: string, to: unknown): Promise<SessionState | string> {
    const want = typeof to === "string" ? to.trim() : "";
    if (!want) return "Say which session: its id from list_sessions, or its title.";
    if (/^[\w-]{4,40}$/.test(want) && !(await this.d.skipped(ownerId).catch(() => new Set<string>())).has(want)) {
      const s = await this.d.store.state(want).catch(() => null);
      if (s?.ownerId === ownerId && s.members[ownerId] && !s.members[ownerId]!.removed) return s;
    }
    const found = pickSession(await this.recent(ownerId), want);
    return typeof found === "string" ? found : found.s;
  }

  /** The agent meant in a session: by id or name, else its lead, else its first. */
  private lane(s: SessionState, raw: unknown): string | { error: string } {
    const lanes = lanesOf(s);
    const want = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!lanes.length) return { error: `"${s.title}" has no agents yet.` };
    if (!want) return s.lead && lanes.includes(s.lead) ? s.lead : lanes[0]!;
    const at = lanes.find((l) => l.toLowerCase() === want) ?? lanes.find((l) => laneName(s, l).toLowerCase() === want) ?? lanes.find((l) => laneName(s, l).toLowerCase().includes(want));
    return at ?? { error: `"${s.title}" has no agent "${String(raw)}". Its agents: ${lanes.map((l) => `${laneName(s, l)} [${l}]`).join(", ")}.` };
  }

  private agents(s: SessionState) {
    return lanesOf(s).map((l) => {
      const e = s.engines[l];
      return { id: l, name: laneName(s, l), ...(e?.tool ? { tool: e.tool } : {}), status: laneStatus(s, l), ...(s.lead === l ? { lead: true } : {}), ...(e?.cwd ? { folder: e.copyOf ?? e.cwd } : {}), ...(e?.branch ? { branch: e.branch } : {}) };
    });
  }

  /** What is waiting on the person, with what it takes to answer it. */
  private waiting(s: SessionState, meId: string) {
    return attentionIn(s, meId)
      .filter((a) => a.kind === "approval" || a.kind === "question" || a.kind === "ask" || a.kind === "stopped")
      .map((a) => {
        const lane = a.lane ?? MAIN_LANE;
        const asked = a.kind === "ask" ? s.asks[lane]?.questions : undefined;
        const items = a.kind === "approval" ? s.approvals[lane]?.items : undefined;
        return {
          kind: a.kind === "ask" ? "question" : a.kind,
          agent: a.agent ?? laneName(s, lane),
          agent_id: lane,
          text: a.text,
          ...(items?.length ? { asks_to: items.slice(0, 10) } : {}),
          ...(asked?.length ? { questions: asked.map((q) => ({ question: q.question, ...(q.options.length ? { options: q.options.map((o) => o.label) } : {}) })) } : {}),
          how: a.kind === "approval" ? "answer with approve true or false" : a.kind === "stopped" ? "send_message to have it try again" : "answer with text",
        };
      });
  }

  private async view(s: SessionState, meId: string, after: number, limit: number) {
    const from = after > 0 ? after + 1 : Math.max(1, s.lastSeq - 2000);
    const found = (await this.d.store.events(s.id, from)).map((e) => messageOf(s, e)).filter((m): m is Record<string, unknown> => !!m);
    const page = after > 0 ? found.slice(0, limit) : found.slice(-limit);
    const last = page.length ? (page[page.length - 1]!.seq as number) : after;
    return {
      id: s.id,
      title: s.title,
      kind: kindOf(s),
      agents: this.agents(s),
      waiting: this.waiting(s, meId),
      messages: page,
      next_after: last,
      ...(after > 0 && found.length > limit ? { more: true } : {}),
    };
  }

  async call(name: string, args: Record<string, unknown>, agent: string, signal?: AbortSignal): Promise<OutsideResult> {
    const me = await this.d.me();
    const as: CommandActor = { id: me.id, name: me.name, via: outsideName(agent) };
    const arg = (k: string) => (typeof args[k] === "string" ? (args[k] as string).trim() : "");
    const num = (k: string, lo: number, hi: number, dflt: number) => {
      const n = Number(args[k]);
      return Number.isFinite(n) && args[k] !== undefined && args[k] !== null ? Math.min(hi, Math.max(lo, Math.floor(n))) : dflt;
    };

    if (name === "list_sessions") {
      const list = (await this.recent(me.id)).slice(0, num("limit", 1, 50, 20));
      const team = await this.d.teamSid().catch(() => null);
      return out({
        sessions: list.map(({ s, at }) => ({
          id: s.id,
          title: s.title,
          kind: s.id === team ? "crew room" : kindOf(s),
          agents: this.agents(s),
          waiting: this.waiting(s, me.id).map((w) => `${w.agent}: ${w.text}`),
          active: new Date(at).toISOString(),
        })),
      });
    }

    if (name === "start_session") {
      const prompt = arg("prompt").slice(0, MAX_TEXT);
      if (!prompt) return fail("Give the task in prompt.");
      const work = arg("kind") === "work";
      if (work && !this.d.work) return fail("This Friday has no Work sessions. Start a Code session instead.");
      const asked = arg("tool").toLowerCase();
      if (asked && asked !== "auto" && !(ENGINE_TOOLS as string[]).includes(asked)) return fail(`There's no coding tool "${asked}". Use auto, or one of ${ENGINE_TOOLS.join(", ")}.`);
      const folder = arg("folder").replace(/^~(?=$|[\\/])/, process.env.HOME || process.env.USERPROFILE || "~");
      const at = folder ? await this.d.folder(folder) : { dir: false, repo: false };
      if (folder && !at.dir) return fail(`There's no folder at ${folder} on this computer. Give its full path.`);
      const mode: EngineMode = arg("mode") === "plan" || arg("mode") === "edits" ? (arg("mode") as EngineMode) : "full";
      const tool = asked && asked !== "auto" ? (asked as EngineTool) : await this.d.pickTool(me.id, prompt);
      if (!tool) return fail("No coding tool is ready on this computer. Set one up in Friday (Settings, Computer & coding tools), or name one with tool.");
      if (await this.limited(`starts:${me.id}`, STARTS_PER_HOUR, 3600)) return fail(`Outside agents have started ${STARTS_PER_HOUR} sessions in the last hour. Wait, or send_message to one already going.`);
      const title = (arg("title") || titleOf(prompt) || "From an outside agent").slice(0, 120);
      const sid = randomBytes(6).toString("base64url");
      const owner = { id: me.id, name: me.name, role: "owner" as const };
      // As an automation's run starts (app.ts runAutomation): the tool's lane reserved first, so the task waits for it rather than
      // going to Friday's own agent, then the task, then the tool.
      await this.d.store.create(sid, title, owner, { controlMode: "ask", mcp: true, ...(work ? { work: true, webSearch: true } : {}) }, this.d.workspaceId);
      await this.d.store.append(sid, { id: me.id, name: me.name, kind: "human", via: as.via! }, { type: "engine.expected", tool, hostId: me.id, hostName: me.name });
      const sent = await this.d.handle(sid, as, { type: "instruct", text: prompt });
      if (!sent.ok) return fail(`Made "${title}" [id ${sid}], but its task wasn't sent: ${sent.error}`);
      const copy = at.repo && args.in_place !== true;
      try {
        await this.d.startTool(sid, me, { tool, cwd: folder, mode, copy, project: title });
      } catch (e) {
        return fail(`Made "${title}" [id ${sid}] with its task, but ${ENGINE_NAMES[tool]} didn't start there: ${(e as Error).message}`);
      }
      return out({
        id: sid,
        title,
        kind: work ? "work" : "code",
        tool,
        tool_name: ENGINE_NAMES[tool],
        mode,
        folder: folder ? (copy ? `a copy of ${folder}` : folder) : "a new project folder",
        next: "wait_for_idle or read_session with this id",
      });
    }

    if (name === "send_message" || name === "answer") {
      const s = await this.find(me.id, args.session);
      if (typeof s === "string") return fail(s);
      const lane = this.lane(s, args.agent);
      if (typeof lane !== "string") return fail(lane.error);
      if (await this.limited(`msgs:${me.id}`, MESSAGES_PER_MINUTE, 60)) return fail(`That's ${MESSAGES_PER_MINUTE} messages in a minute. Wait for the agents, then go on.`);
      if (name === "send_message") {
        const text = arg("text").slice(0, MAX_TEXT);
        if (!text) return fail("Say something in text.");
        const people = arg("to") === "people";
        const r = await this.d.handle(s.id, as, people ? { type: "say", text } : { type: "instruct", text, lane });
        if (!r.ok) return fail(r.error);
        const now = await this.d.store.state(s.id);
        return out({ seq: r.seq, session: s.id, ...(people ? { to: "people" } : { agent: laneName(now, lane), agent_id: lane, status: laneStatus(now, lane) }) });
      }
      // answer: the lane asked for, or the one agent waiting when none was named.
      const waits = lanesOf(s).filter((l) => laneStatus(s, l) === "needs_you");
      const on = typeof args.agent === "string" && args.agent.trim() ? lane : waits.length === 1 ? waits[0]! : lane;
      if (typeof args.approve === "boolean") {
        const ask = s.approvals[on];
        if (!ask) return fail(`${laneName(s, on)} isn't asking permission for anything.${waits.length ? ` Waiting: ${waits.map((l) => laneName(s, l)).join(", ")}.` : ""}`);
        const r = await this.d.handle(s.id, as, { type: "approval.answer", lane: on, id: ask.id, approve: args.approve });
        return r.ok ? out({ seq: r.seq, agent: laneName(s, on), approved: args.approve }) : fail(r.error);
      }
      const text = arg("text").slice(0, MAX_TEXT);
      if (!text) return fail("Give approve (true or false) for a permission request, or text for a question.");
      const r = await this.d.handle(s.id, as, { type: "instruct", text, lane: on });
      return r.ok ? out({ seq: r.seq, agent: laneName(s, on), answered: true }) : fail(r.error);
    }

    if (name === "read_session") {
      const s = await this.find(me.id, args.session);
      if (typeof s === "string") return fail(s);
      return out(await this.view(s, me.id, num("after", 0, Number.MAX_SAFE_INTEGER, 0), num("limit", 1, 100, 20)));
    }

    if (name === "wait_for_idle") {
      const first = await this.find(me.id, args.session);
      if (typeof first === "string") return fail(first);
      let lane: string | null = null;
      if (arg("agent")) {
        const l = this.lane(first, args.agent);
        if (typeof l !== "string") return fail(l.error);
        lane = l;
      }
      const r = await this.waitFor(first.id, lane ? [lane] : null, num("timeout_seconds", 1, 600, 50) * 1000, signal);
      const s = await this.d.store.state(first.id);
      // What was said since the wait began, or the latest few when nothing new was.
      const v = await this.view(s, me.id, r.since && s.lastSeq > r.since ? r.since : 0, r.since && s.lastSeq > r.since ? 40 : 5);
      return out({ status: r.status, ...v });
    }

    if (name === "list_teammates" || name === "ask_teammate") {
      const crew = this.d.crew ? await this.d.crew() : null;
      if (!crew || !crew.mates.length) return name === "list_teammates" ? out({ teammates: [], note: "No Crew yet: the person adds teammates in Friday's Crew page." }) : fail("There's no Crew yet: the person adds teammates in Friday's Crew page.");
      if (name === "list_teammates") return out({ room: crew.sid, teammates: crew.mates.map(({ lane: _l, ...m }) => m) });
      const want = arg("name").toLowerCase();
      const mate = crew.mates.find((m) => m.name.toLowerCase() === want) ?? (crew.mates.filter((m) => m.name.toLowerCase().includes(want)).length === 1 ? crew.mates.find((m) => m.name.toLowerCase().includes(want)) : undefined);
      if (!want || !mate) return fail(`No teammate called "${arg("name")}". The Crew: ${crew.mates.map((m) => m.name).join(", ")}.`);
      const text = arg("text").slice(0, MAX_TEXT);
      if (!text) return fail("Say something in text.");
      if (await this.limited(`msgs:${me.id}`, MESSAGES_PER_MINUTE, 60)) return fail(`That's ${MESSAGES_PER_MINUTE} messages in a minute. Wait for the agents, then go on.`);
      const r = await this.d.handle(crew.sid, as, { type: "instruct", text, lane: mate.lane });
      if (!r.ok) return fail(r.error);
      const wait = num("wait_seconds", 0, 600, 50);
      if (!wait) return out({ seq: r.seq, teammate: mate.name, room: crew.sid, status: laneStatus(await this.d.store.state(crew.sid), mate.lane) });
      const w = await this.waitFor(crew.sid, [mate.lane], wait * 1000, signal);
      const said = (await this.d.store.events(crew.sid, r.seq + 1)).filter((e) => (e.lane ?? MAIN_LANE) === mate.lane && e.body.type === "agent.message" && e.body.text.trim());
      const reply = said.length ? String((said[said.length - 1]!.body as { text: string }).text) : null;
      return out({ seq: r.seq, teammate: mate.name, room: crew.sid, status: w.status, reply: reply && reply.length > MAX_TEXT ? `${reply.slice(0, MAX_TEXT)}…` : reply });
    }

    return fail(`Friday has no tool called ${name}.`);
  }

  /** Until the agents (all, or `lanes`) are neither working nor queued, or one needs the person, or `ms` is up. */
  async waitFor(sid: string, lanes: string[] | null, ms: number, signal?: AbortSignal): Promise<{ status: "idle" | "needs_you" | "timeout"; since: number }> {
    const until = Date.now() + ms;
    const since = (await this.d.store.state(sid)).lastSeq;
    const poll = this.d.pollMs ?? 750;
    for (;;) {
      const s = await this.d.store.state(sid);
      const st = (lanes ?? lanesOf(s)).map((l) => laneStatus(s, l));
      if (st.includes("needs_you")) return { status: "needs_you", since };
      if (!st.some(busy)) return { status: "idle", since };
      if (Date.now() >= until || signal?.aborted) return { status: "timeout", since };
      await new Promise((r) => setTimeout(r, Math.min(poll, Math.max(0, until - Date.now()))));
    }
  }
}
