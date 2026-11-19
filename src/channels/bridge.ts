import { randomBytes } from "node:crypto";
import { describeCall } from "../activity-line.js";
import type { CommandActor, CommandResult } from "../session/core.js";
import type { Command } from "../session/core.js";
import { laneName } from "../session/core.js";
import type { SessionState } from "../session/projection.js";
import type { SessionStore } from "../session/store.js";
import { ENGINE_NAMES, MAIN_LANE, type EngineMode, type EngineTool, type SessionEvent } from "../types.js";
import { planEntries } from "./linear.js";

/**
 * Where a Friday thread came from, when it came from Slack or Linear, and what it tells that side as it works (spec 08). One
 * thread per Slack thread or Linear agent session. Friday's events are read once here and turned into a few plain updates, so
 * each side only says them its own way: Linear as activities and a plan, Slack as a status line and buttons.
 *
 * Only the person at this computer starts work (personal plans run their owner's work only). A teammate's ask is put in the
 * thread as a suggestion: nothing runs until the person sends it to the agent, and the side says it is waiting for them.
 */

export type Side = "linear" | "slack";

export interface ChannelLink {
  side: Side;
  /** The side's own key: a Linear agent session's id, a Slack "team:channel:thread_ts". */
  ref: string;
  sid: string;
  /** The agent the work runs on. */
  lane: string;
  /** Who asked, as the side named them. */
  by: { id: string; name: string; me: boolean };
  /** Where it is on that side, for the thread's "From Linear, ENG-142" line. */
  label: string;
  url?: string;
  /** The PR already told, so it's said once. */
  pr?: string;
  /** Extra the side keeps (Linear: the issue and its team; Slack: the status message). */
  meta?: Record<string, unknown>;
}

export type Update =
  | { kind: "working"; text: string }
  | { kind: "step"; text: string }
  | { kind: "plan"; entries: { content: string; status: string }[] }
  | { kind: "approval"; lane: string; agent: string; id: string; items: string[]; why?: string }
  | { kind: "question"; lane: string; agent: string; question: string; options: string[] }
  | { kind: "pr"; url: string }
  | { kind: "ended"; outcome: "done" | "waiting" | "error" | "stopped"; reply: string; error?: string };

export interface SideAdapter {
  side: Side;
  update(link: ChannelLink, u: Update, s: SessionState): Promise<void>;
  /** An approval or a question in a thread that didn't come from any side (Slack's "needs you" DMs, when on). */
  elsewhere?(sid: string, u: Extract<Update, { kind: "approval" | "question" }>, s: SessionState): Promise<void>;
}

export interface BridgeDeps {
  store: SessionStore;
  handle(sid: string, actor: CommandActor, cmd: Command): Promise<CommandResult>;
  me(): Promise<{ id: string; name: string }>;
  workspaceId: string;
  startTool(sid: string, owner: { id: string; name: string }, p: { tool: EngineTool; cwd: string; mode: EngineMode; copy: boolean; project: string }): Promise<unknown>;
  pickTool(ownerId: string, task: string): Promise<EngineTool | null>;
  folder(p: string): Promise<{ dir: boolean; repo: boolean }>;
}

const KEY = (prefix: string) => ({
  bySid: (sid: string) => `${prefix}chan:sid:${sid}`,
  byRef: (side: Side, ref: string) => `${prefix}chan:ref:${side}:${ref}`,
  list: (side: Side) => `${prefix}chan:list:${side}`,
});

/** A side's name as a session actor's `via`: "Linear, for Arun". */
const SIDE_NAME: Record<Side, string> = { linear: "Linear", slack: "Slack" };

/** Steps said at most this often per thread: a coding tool takes several a second, and each side is a person's feed. */
const STEP_EVERY_MS = 4000;

export class ChannelBridge {
  private sides = new Map<Side, SideAdapter>();
  private lastStep = new Map<string, number>();
  private k: ReturnType<typeof KEY>;

  constructor(private d: BridgeDeps) {
    this.k = KEY(d.store.prefix);
  }

  add(a: SideAdapter): void {
    this.sides.set(a.side, a);
  }

  async link(sid: string): Promise<ChannelLink | null> {
    const raw = await this.d.store.redis.get(this.k.bySid(sid));
    return raw ? (JSON.parse(raw) as ChannelLink) : null;
  }

  async sidOf(side: Side, ref: string): Promise<string | null> {
    return this.d.store.redis.get(this.k.byRef(side, ref));
  }

  async save(l: ChannelLink): Promise<void> {
    await this.d.store.redis.set(this.k.bySid(l.sid), JSON.stringify(l));
    await this.d.store.redis.set(this.k.byRef(l.side, l.ref), l.sid);
    await this.d.store.redis.zadd(this.k.list(l.side), Date.now(), l.sid);
  }

  /** A side's threads, newest first. */
  async links(side: Side, limit = 20): Promise<ChannelLink[]> {
    const sids = await this.d.store.redis.zrevrange(this.k.list(side), 0, limit - 1);
    return (await Promise.all(sids.map((sid) => this.link(sid)))).filter((l): l is ChannelLink => !!l);
  }

  /** Someone else's ask, sent on to the agent by the person: the newest one not yet sent. */
  async promote(sid: string): Promise<CommandResult> {
    const link = await this.link(sid);
    const s = await this.d.store.state(sid);
    const sug = s.suggestions.filter((x) => !x.promoted && !x.dismissed).at(-1);
    if (!sug) return { ok: false, error: "There's nothing waiting to send." };
    const me = await this.d.me();
    return this.d.handle(sid, { id: me.id, name: me.name, via: SIDE_NAME[link?.side ?? "slack"] }, { type: "promote", seq: sug.seq });
  }

  /** Someone else's ask, put aside by the person. */
  async decline(sid: string): Promise<CommandResult> {
    const link = await this.link(sid);
    const s = await this.d.store.state(sid);
    const sug = s.suggestions.filter((x) => !x.promoted && !x.dismissed).at(-1);
    if (!sug) return { ok: false, error: "There's nothing waiting." };
    const me = await this.d.me();
    return this.d.handle(sid, { id: me.id, name: me.name, via: SIDE_NAME[link?.side ?? "slack"] }, { type: "suggestion.dismiss", seq: sug.seq });
  }

  /**
   * A thread for an ask from a side: made, its tool started on the folder, and the ask sent to it when the person at this
   * computer asked; held as a suggestion for them to send when someone else did.
   */
  async start(o: { side: Side; ref: string; title: string; task: string; folder: string; tool?: EngineTool | null; by: { id: string; name: string; me: boolean }; label: string; url?: string; meta?: Record<string, unknown> }): Promise<{ sid: string; held: boolean; tool: EngineTool }> {
    const me = await this.d.me();
    const via = SIDE_NAME[o.side];
    const at = await this.d.folder(o.folder);
    if (!at.dir) throw new Error(`There's no folder at ${o.folder} on this computer.`);
    const tool = o.tool ?? (await this.d.pickTool(me.id, o.task));
    if (!tool) throw new Error("No coding tool is ready on this computer.");
    const sid = randomBytes(6).toString("base64url");
    const owner = { id: me.id, name: me.name, role: "owner" as const };
    await this.d.store.create(sid, o.title.slice(0, 120), owner, { controlMode: "ask", mcp: true }, this.d.workspaceId);
    await this.d.store.append(sid, { id: me.id, name: me.name, kind: "human", via }, { type: "engine.expected", tool, hostId: me.id, hostName: me.name });
    const link: ChannelLink = { side: o.side, ref: o.ref, sid, lane: MAIN_LANE, by: o.by, label: o.label, ...(o.url ? { url: o.url } : {}), ...(o.meta ? { meta: o.meta } : {}) };
    await this.save(link);
    if (o.by.me) {
      const sent = await this.d.handle(sid, { id: me.id, name: me.name, via }, { type: "instruct", text: o.task });
      if (!sent.ok) throw new Error(sent.error);
    } else {
      // Someone else's ask, as they wrote it, from them: the person reads it and sends it to the agent, or doesn't.
      await this.d.store.append(sid, { id: `${o.side}:${o.by.id}`, name: `${o.by.name} (${via})`, kind: "human" }, { type: "suggestion", text: o.task });
    }
    await this.d.startTool(sid, me, { tool, cwd: o.folder, mode: "full", copy: at.repo, project: o.title });
    return { sid, held: !o.by.me, tool };
  }

  /** What was said on the side, to the thread: the person's word to its agent, or a teammate's suggestion. */
  async say(sid: string, text: string, by: { id: string; name: string; me: boolean }): Promise<CommandResult> {
    const link = await this.link(sid);
    if (!link) return { ok: false, error: "That thread isn't linked." };
    const me = await this.d.me();
    const via = SIDE_NAME[link.side];
    if (!by.me) {
      const r = await this.d.store.append(sid, { id: `${link.side}:${by.id}`, name: `${by.name} (${via})`, kind: "human" }, { type: "suggestion", text }, { lane: link.lane });
      return r.ok ? ({ ok: true, seq: r.seq } as CommandResult) : { ok: false, error: "The thread is gone." };
    }
    const s = await this.d.store.state(sid);
    // A yes or no to what the agent is asking permission for.
    const ask = s.approvals[link.lane];
    if (ask) {
      const yes = /^\s*(y|yes|yep|approve[d]?|allow|ok(ay)?|go( ahead)?|do it|sure)\b/i.test(text);
      const no = /^\s*(n|no|nope|deny|denied|don'?t|stop)\b/i.test(text);
      if (yes || no) return this.d.handle(sid, { id: me.id, name: me.name, via }, { type: "approval.answer", id: ask.id, approve: yes, lane: link.lane });
    }
    return this.d.handle(sid, { id: me.id, name: me.name, via }, { type: "instruct", text, lane: link.lane });
  }

  /** A yes or no to a permission an agent asked for: in a linked thread, or (a "needs you" DM) any thread of the person's. */
  async approve(sid: string, id: string, approve: boolean, o: { task?: boolean; lane?: string; side?: Side } = {}): Promise<CommandResult> {
    const link = await this.link(sid);
    const s = await this.d.store.state(sid).catch(() => null);
    const me = await this.d.me();
    if (!s || s.ownerId !== me.id) return { ok: false, error: "That thread isn't yours." };
    const lane = o.lane ?? link?.lane ?? MAIN_LANE;
    return this.d.handle(sid, { id: me.id, name: me.name, via: SIDE_NAME[link?.side ?? o.side ?? "slack"] }, { type: "approval.answer", id, approve, lane, ...(o.task ? { task: true } : {}) });
  }

  /** An answer to an agent's question, in any thread of the person's. */
  async answer(sid: string, text: string, o: { lane?: string; side?: Side } = {}): Promise<CommandResult> {
    const link = await this.link(sid);
    const s = await this.d.store.state(sid).catch(() => null);
    const me = await this.d.me();
    if (!s || s.ownerId !== me.id) return { ok: false, error: "That thread isn't yours." };
    return this.d.handle(sid, { id: me.id, name: me.name, via: SIDE_NAME[link?.side ?? o.side ?? "slack"] }, { type: "instruct", text, lane: o.lane ?? link?.lane ?? MAIN_LANE });
  }

  async stop(sid: string): Promise<CommandResult> {
    const link = await this.link(sid);
    if (!link) return { ok: false, error: "That thread isn't linked." };
    const me = await this.d.me();
    return this.d.handle(sid, { id: me.id, name: me.name, via: SIDE_NAME[link.side] }, { type: "run.cancel", lane: link.lane });
  }

  /** Every event of every session: those of a linked thread become updates for its side. */
  hear(sid: string, ev: SessionEvent): void {
    if (!WATCHED.has(ev.body.type)) return;
    void this.heard(sid, ev).catch((e) => console.error("[channels]", e));
  }

  private async heard(sid: string, ev: SessionEvent): Promise<void> {
    const link = await this.link(sid);
    if (!link) {
      if (ev.body.type !== "engine.approval" && ev.body.type !== "agent.question") return;
      const others = [...this.sides.values()].filter((x) => x.elsewhere);
      if (!others.length) return;
      const s = await this.d.store.state(sid);
      const lane = ev.lane ?? MAIN_LANE;
      const b = ev.body;
      const u = b.type === "engine.approval" ? ({ kind: "approval", lane, agent: laneName(s, lane), id: b.id, items: b.items.slice(0, 10), ...(b.why ? { why: b.why } : {}) } as const) : ({ kind: "question", lane, agent: laneName(s, lane), question: b.question, options: (b.options ?? []).slice(0, 8) } as const);
      for (const x of others) await x.elsewhere!(sid, u, s);
      return;
    }
    const side = this.sides.get(link.side);
    if (!side) return;
    const s = await this.d.store.state(sid);
    const lane = ev.lane ?? MAIN_LANE;
    const mine = lane === link.lane;
    const out: Update[] = [];
    const b = ev.body;
    if (b.type === "run.started" && mine) out.push({ kind: "working", text: `${ENGINE_NAMES[s.engines[lane]?.tool as EngineTool] ?? "The agent"} is on it` });
    if (b.type === "agent.message" && mine) {
      const plan = b.toolCalls.filter((c) => /^(update_plan|todo|todowrite|todo_write)$/i.test(c.name)).at(-1);
      const entries = plan ? planEntries(plan.arguments) : null;
      if (entries?.length) out.push({ kind: "plan", entries });
      const step = b.toolCalls.filter((c) => c !== plan).at(-1);
      const now = Date.now();
      if (step && now - (this.lastStep.get(sid) ?? 0) >= STEP_EVERY_MS) {
        this.lastStep.set(sid, now);
        out.push({ kind: "step", text: describeCall(step) });
      }
    }
    if (b.type === "engine.approval") out.push({ kind: "approval", lane, agent: laneName(s, lane), id: b.id, items: b.items.slice(0, 10), ...(b.why ? { why: b.why } : {}) });
    if (b.type === "agent.question") out.push({ kind: "question", lane, agent: laneName(s, lane), question: b.question, options: (b.options ?? []).slice(0, 8) });
    // Stopped (from the side, or in Friday): said now, since a stopped run may not write an end of its own.
    if (b.type === "run.cancel" && mine) out.push({ kind: "ended", outcome: "stopped", reply: "" });
    if (b.type === "run.ended" && mine) {
      // This run's own events: from its start to its end.
      const recent = (await this.d.store.events(sid, Math.max(1, ev.seq - 600))).filter((e) => e.seq <= ev.seq && (e.lane ?? MAIN_LANE) === lane);
      const from = recent.findLastIndex((e) => e.body.type === "run.started");
      const run = from >= 0 ? recent.slice(from) : recent;
      const said = run.filter((e) => e.body.type === "agent.message" && e.body.text.trim());
      const reply = said.length ? String((said.at(-1)!.body as { text: string }).text) : "";
      const cancelled = run.some((e) => e.body.type === "run.cancel");
      // A stopped run was said when it was stopped.
      if (!cancelled) out.push({ kind: "ended", outcome: b.outcome, reply: reply.slice(0, 6000), ...(b.error ? { error: b.error } : {}) });
    }
    // A pull request, the first time the thread has one (or a new one).
    const pr = s.pr?.url;
    if (pr && pr !== link.pr) {
      link.pr = pr;
      await this.save(link);
      out.unshift({ kind: "pr", url: pr });
    }
    for (const u of out) await side.update(link, u, s);
  }
}

/** The events anything is said about: the rest are read past without a lookup. */
const WATCHED = new Set(["run.started", "agent.message", "engine.approval", "agent.question", "run.ended", "run.cancel", "folder.committed", "pr.shepherd"]);
