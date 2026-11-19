import type { SessionState } from "../session/projection.js";
import { titleOf } from "../outside-agents.js";
import { UNTRUSTED_NOTE, untrusted } from "../untrusted.js";
import { ENGINE_NAMES } from "../types.js";
import type { ChannelBridge, ChannelLink, SideAdapter, Update } from "./bridge.js";
import type { ChannelsConfig, SlackConfig } from "./config.js";
import { SlackApi, SlackError, SlackSocket, cutForSlack, plainSlack, toMrkdwn, withoutMention, type SocketEnvelope } from "./slack.js";

/**
 * Friday in Slack (spec 08): an @mention, a DM, `/friday` or "Send to Friday" on a message becomes a thread on this computer;
 * plain replies in that Slack thread steer it; its progress is one status message, edited as it goes (the tool, its current step,
 * its plan, a Stop button); approvals and questions come as buttons; the answer, the pull request and how it ended are posted
 * in the thread. Someone else's ask waits for the person, who gets a DM to Start or Decline it. With "needs you" DMs on, an
 * approval or a question from any of the person's threads comes to their DMs too.
 */

export interface SlackAgentDeps {
  config: ChannelsConfig;
  bridge: ChannelBridge;
  projects(): Promise<{ folder: string; repo?: string }[]>;
  env?: NodeJS.ProcessEnv;
}

export interface SlackStatus {
  connected: boolean;
  state: "off" | "connecting" | "on";
  team?: string;
  me: { id: string; name: string } | null;
  dms: boolean;
  error?: string;
  channels?: { id: string; folder: string; name?: string }[];
}

type Event = { type: string; subtype?: string; user?: string; bot_id?: string; text?: string; channel?: string; channel_type?: string; ts?: string; thread_ts?: string };
type Action = { action_id: string; value?: string; selected_option?: { value: string } };

const short = (folder: string) => folder.replace(/^\/(Users|home)\/[^/]+/, "~");
const btn = (text: string, value: object, style?: "primary" | "danger", action = "fri") => ({ type: "button", text: { type: "plain_text", text: text.slice(0, 75) }, value: JSON.stringify(value).slice(0, 2000), action_id: `${action}:${text.slice(0, 40)}:${Math.random().toString(36).slice(2, 8)}`, ...(style ? { style } : {}) });
const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text: cutForSlack(text) } });
const context = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text: text.slice(0, 2000) }] });
const PLAN_MARK: Record<string, string> = { completed: "✓", inProgress: "◐", canceled: "–", pending: "○" };

export class SlackAgent implements SideAdapter {
  readonly side = "slack" as const;
  private api: SlackApi;
  private socket: SlackSocket;
  private seen = new Set<string>();
  /** Asks waiting for "which project": by thread ref. */
  private choosing = new Map<string, { text: string; by: { id: string; name: string; me: boolean }; channel: string; thread: string }>();
  private error = "";

  constructor(private d: SlackAgentDeps) {
    this.api = new SlackApi(() => this.cfg()?.bot ?? "", d.env ?? process.env);
    this.socket = new SlackSocket(
      () => this.cfg()?.app ?? "",
      (e) => this.envelope(e),
      d.env ?? process.env,
      (_s, err) => (this.error = err ?? ""),
    );
  }

  private cfg(): SlackConfig | undefined {
    return this.d.config.read().slack;
  }

  private save(patch: Partial<SlackConfig>): void {
    const cur = this.cfg();
    if (!cur) return;
    this.d.config.patch("slack", { ...cur, ...patch });
  }

  status(): SlackStatus {
    const c = this.cfg();
    return {
      connected: !!c,
      state: this.socket.state,
      ...(c?.team ? { team: c.team.name } : {}),
      me: c?.me ?? null,
      dms: !!c?.dms,
      ...(this.error || this.socket.lastError ? { error: this.error || this.socket.lastError } : {}),
      channels: Object.entries(c?.channels ?? {}).map(([id, folder]) => ({ id, folder, ...(c?.channelNames?.[id] ? { name: c.channelNames[id] } : {}) })),
    };
  }

  // ── Setup ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The two tokens, checked with Slack before they're kept: the bot's (who it is, which workspace) and the app's (Socket Mode). */
  async connect(o: { bot: string; app: string }): Promise<SlackStatus> {
    const bot = o.bot.trim();
    const app = o.app.trim();
    if (!/^xoxb-/.test(bot)) throw new Error("The bot token starts with xoxb-. It's under OAuth & Permissions on the app's page.");
    if (!/^xapp-/.test(app)) throw new Error("The app-level token starts with xapp-. Make one under Basic Information › App-Level Tokens, with connections:write.");
    const who = await this.api.call<{ team: string; team_id: string; url?: string; user_id: string }>("auth.test", {}, bot);
    await this.api.call("apps.connections.open", {}, app);
    this.socket.close();
    this.d.config.patch("slack", { bot, app, team: { id: who.team_id, name: who.team, ...(who.url ? { url: who.url } : {}) }, botUser: who.user_id, ...(this.cfg()?.me ? { me: this.cfg()!.me } : {}) });
    this.error = "";
    void this.socket.open();
    return this.status();
  }

  start(): void {
    if (this.cfg()) void this.socket.open();
  }

  stop(): void {
    this.socket.close();
  }

  async disconnect(): Promise<void> {
    this.socket.close();
    this.d.config.patch("slack", null);
    this.error = "";
  }

  people() {
    return this.api.people();
  }

  setMe(me: { id: string; name: string } | null): void {
    this.save(me ? { me } : { me: undefined });
  }

  setDms(on: boolean): void {
    this.save({ dms: on });
  }

  setChannel(id: string, folder: string | null, name?: string): void {
    const channels = { ...(this.cfg()?.channels ?? {}) };
    const channelNames = { ...(this.cfg()?.channelNames ?? {}) };
    if (folder) channels[id] = folder;
    else delete channels[id];
    if (folder && name) channelNames[id] = name;
    if (!folder) delete channelNames[id];
    this.save({ channels, channelNames });
  }

  // ── What Slack sends ────────────────────────────────────────────────────────────────────────────────────────────────

  private once(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value!);
    return true;
  }

  private async envelope(e: SocketEnvelope): Promise<void> {
    const p = e.payload ?? {};
    if (e.type === "events_api") {
      const ev = (p.event ?? {}) as Event;
      if (!this.once(`${ev.channel}:${ev.ts}:${ev.type}`)) return;
      if (ev.type === "app_mention") return this.mention(ev);
      if (ev.type === "message") return this.message(ev);
      return;
    }
    if (e.type === "interactive") return this.interactive(p);
    if (e.type === "slash_commands") return this.command(p as { text?: string; user_id: string; channel_id: string; response_url?: string });
  }

  private async who(user: string): Promise<{ id: string; name: string; me: boolean }> {
    const me = this.cfg()?.me;
    const name = me?.id === user ? me.name : await this.api.user(user).then((u) => u.name).catch(() => "Someone");
    return { id: user, name, me: !!me && me.id === user };
  }

  /** @Friday in a channel or a thread: work on what was asked, or say it to the thread's work if there is some. */
  private async mention(ev: Event): Promise<void> {
    if (!ev.user || !ev.channel || !ev.ts || ev.bot_id) return;
    const thread = ev.thread_ts ?? ev.ts;
    const text = plainSlack(withoutMention(ev.text ?? "", this.cfg()?.botUser));
    const by = await this.who(ev.user);
    const sid = await this.d.bridge.sidOf("slack", `${ev.channel}:${thread}`);
    if (sid) return void (await this.d.bridge.say(sid, text, by));
    if (!text) return void (await this.api.post(ev.channel, "What should I work on? Mention me with the task.", { thread }));
    // Asked partway through a conversation: what was said before it goes with the ask, as others' words.
    let earlier = "";
    if (ev.thread_ts) {
      const msgs = await this.api.replies(ev.channel, ev.thread_ts, 30).catch(() => []);
      const lines = await Promise.all(msgs.filter((m) => m.ts !== ev.ts && !m.bot_id && m.text?.trim()).slice(-20).map(async (m) => `${m.user ? (await this.who(m.user)).name : "Someone"}: ${plainSlack(m.text).slice(0, 1200)}`));
      earlier = lines.join("\n");
    }
    await this.begin({ channel: ev.channel, thread, text, by, earlier });
  }

  /** A message: a reply in a thread Friday works in, or a DM. Mentions come as app_mention too, so they're left to it. */
  private async message(ev: Event): Promise<void> {
    if (!ev.user || !ev.channel || !ev.ts || ev.bot_id || (ev.subtype && ev.subtype !== "thread_broadcast")) return;
    const bot = this.cfg()?.botUser;
    if (bot && ev.text?.includes(`<@${bot}`)) return;
    const text = plainSlack(ev.text ?? "").trim();
    if (!text) return;
    const by = await this.who(ev.user);
    if (ev.thread_ts) {
      const sid = await this.d.bridge.sidOf("slack", `${ev.channel}:${ev.thread_ts}`);
      if (sid) return void (await this.d.bridge.say(sid, text, by));
      // A reply naming a folder, to "which project?".
      const waiting = this.choosing.get(`${ev.channel}:${ev.thread_ts}`);
      if (waiting && by.me && /^[~/]/.test(text)) return this.chose(`${ev.channel}:${ev.thread_ts}`, text.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
      return;
    }
    // A new DM to Friday: work, in a thread on it.
    if (ev.channel_type === "im") await this.begin({ channel: ev.channel, thread: ev.ts, text, by, earlier: "" });
  }

  /** `/friday` on its own: what's running. `/friday <ask>`: work on it, in a thread on a message saying who asked. */
  private async command(p: { text?: string; user_id: string; channel_id: string; response_url?: string }): Promise<void> {
    const reply = (text: string) => (p.response_url ? fetch(p.response_url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response_type: "ephemeral", text }) }).catch(() => {}) : this.api.ephemeral(p.channel_id, p.user_id, text).catch(() => {}));
    const text = (p.text ?? "").trim();
    const by = await this.who(p.user_id);
    if (!text) {
      const links = await this.d.bridge.links("slack", 10);
      return void (await reply(links.length ? `What Friday has from Slack, newest first:\n${links.map((l) => `• ${l.label}${l.url ? ` <${l.url}|open>` : ""}`).join("\n")}` : "Nothing from Slack yet. Mention @Friday with a task, or `/friday <task>`."));
    }
    const root = await this.api.post(p.channel_id, `${by.name} asked Friday: ${text}`).catch((e: Error) => (void reply(e.message), null));
    if (root) await this.begin({ channel: p.channel_id, thread: root.ts, text, by, earlier: "" });
  }

  private async interactive(p: Record<string, unknown>): Promise<void> {
    const user = (p.user as { id: string } | undefined)?.id ?? "";
    const by = await this.who(user);
    const channel = (p.channel as { id: string } | undefined)?.id ?? (p.container as { channel_id?: string } | undefined)?.channel_id ?? "";
    // "Send to Friday" on a message.
    if (p.type === "message_action" && p.callback_id === "send_to_friday") {
      const m = (p.message ?? {}) as { text?: string; ts: string; thread_ts?: string; user?: string };
      const text = plainSlack(m.text ?? "").trim();
      if (!text || !channel) return;
      const author = m.user && m.user !== user ? (await this.who(m.user)).name : "";
      return this.begin({ channel, thread: m.thread_ts ?? m.ts, text: author ? untrusted(`Slack, written by ${author}`, text) : text, by, earlier: "", title: text });
    }
    if (p.type !== "block_actions") return;
    const message = (p.message ?? {}) as { ts: string; thread_ts?: string };
    for (const a of (p.actions ?? []) as Action[]) {
      let v: Record<string, string>;
      try {
        v = JSON.parse(a.selected_option?.value ?? a.value ?? "{}") as Record<string, string>;
      } catch {
        continue;
      }
      // Only the person whose computer this is answers for it.
      if (!by.me) {
        await this.api.ephemeral(channel, user, `Only ${this.cfg()?.me?.name ?? "the person whose Friday this is"} can answer this.`, message.thread_ts).catch(() => {});
        continue;
      }
      const done = (text: string) => this.api.update(channel, message.ts, text, [section(text)]).catch(() => {});
      if (v.k === "ap") {
        const r = await this.d.bridge.approve(v.sid!, v.id!, v.a !== "0", { task: v.a === "task", lane: v.lane, side: "slack" });
        await done(r.ok ? (v.a === "0" ? `Denied by ${by.name}.` : v.a === "task" ? `Allowed for this task by ${by.name}.` : `Approved by ${by.name}.`) : r.error);
      } else if (v.k === "q") {
        const r = await this.d.bridge.answer(v.sid!, v.t!, { lane: v.lane, side: "slack" });
        await done(r.ok ? `${by.name} answered: ${v.t}` : r.error);
      } else if (v.k === "stop") {
        const r = await this.d.bridge.stop(v.sid!);
        if (!r.ok) await this.api.ephemeral(channel, user, r.error, message.thread_ts).catch(() => {});
      } else if (v.k === "start") {
        const r = await this.d.bridge.promote(v.sid!);
        await done(r.ok ? `Started by ${by.name}.` : r.error);
      } else if (v.k === "decline") {
        const r = await this.d.bridge.decline(v.sid!);
        await done(r.ok ? `${by.name} passed on this.` : r.error);
        const l = r.ok ? await this.d.bridge.link(v.sid!) : null;
        if (l) await this.api.post(String(l.meta?.channel), `${by.name} passed on this one.`, { thread: String(l.meta?.thread) }).catch(() => {});
      } else if (v.k === "proj") {
        await done(`Working in ${short(v.folder!)}.`);
        await this.chose(v.ref!, v.folder!);
      }
    }
  }

  // ── Starting ────────────────────────────────────────────────────────────────────────────────────────────────────────

  private async begin(o: { channel: string; thread: string; text: string; by: { id: string; name: string; me: boolean }; earlier: string; title?: string }): Promise<void> {
    const ref = `${o.channel}:${o.thread}`;
    const task = [o.by.me ? o.text : untrusted(`Slack, asked by ${o.by.name}`, o.text), o.earlier ? `${untrusted("Slack, the thread so far", o.earlier)}\n\n${UNTRUSTED_NOTE}` : "", "Asked in Slack. When you need a decision, ask it as a question; it goes to the thread as buttons."].filter(Boolean).join("\n\n");
    const folder = await this.folderFor(o.channel, o.text);
    if (typeof folder !== "string") {
      this.choosing.set(ref, { text: task, by: o.by, channel: o.channel, thread: o.thread });
      if (!folder.choices.length) return void (await this.api.post(o.channel, "Which folder on this computer is this in? Reply here with its full path.", { thread: o.thread }));
      await this.api.post(o.channel, "Which project is this in?", { thread: o.thread, blocks: [section("Which project is this in?"), { type: "actions", elements: folder.choices.slice(0, 5).map((f) => btn(short(f).split("/").at(-1) || f, { k: "proj", ref, folder: f })) }, context("Or reply with a folder's full path. Friday keeps the answer for this channel.")] });
      return;
    }
    await this.launch(ref, task, folder, o.by, o.channel, o.thread, o.title ?? o.text);
  }

  private async chose(ref: string, folder: string): Promise<void> {
    const w = this.choosing.get(ref);
    if (!w) return;
    this.choosing.delete(ref);
    this.setChannel(w.channel, folder);
    await this.launch(ref, w.text, folder, w.by, w.channel, w.thread, w.text);
  }

  private async launch(ref: string, task: string, folder: string, by: { id: string; name: string; me: boolean }, channel: string, thread: string, title: string): Promise<void> {
    const permalink = await this.api.call<{ permalink: string }>("chat.getPermalink", { channel, message_ts: thread }).then((r) => r.permalink).catch(() => undefined);
    let started: { sid: string; held: boolean; tool: keyof typeof ENGINE_NAMES };
    try {
      started = await this.d.bridge.start({ side: "slack", ref, title: titleOf(plainSlack(title)) || "From Slack", task, folder, by, label: "Slack thread", ...(permalink ? { url: permalink } : {}), meta: { channel, thread } });
    } catch (e) {
      return void (await this.api.post(channel, `Couldn't start: ${(e as Error).message}`, { thread }).catch(() => {}));
    }
    const link = await this.d.bridge.link(started.sid);
    if (!link) return;
    const tool = ENGINE_NAMES[started.tool];
    const me = this.cfg()?.me;
    const head = started.held ? `Waiting for ${me?.name ?? "the person whose Friday this is"} to start this. ${tool} will work in ${short(folder)}.` : `${tool} is starting in ${short(folder)}.`;
    const status = await this.api.post(channel, head, { thread, blocks: this.statusBlocks(link, head, !started.held) }).catch(() => null);
    link.meta = { ...link.meta, status: status?.ts ?? "", tool, folder: short(folder) };
    await this.d.bridge.save(link);
    // Someone else's ask: the person decides, from their DMs.
    if (started.held && me) {
      const dm = await this.api.dm(me.id).catch(() => null);
      if (dm) {
        const text = `${by.name} asked Friday in Slack: ${plainSlack(title).slice(0, 400)}`;
        await this.api.post(dm, text, { blocks: [section(`${text}${permalink ? `\n<${permalink}|See the thread>` : ""}`), { type: "actions", elements: [btn("Start", { k: "start", sid: started.sid }, "primary"), btn("Decline", { k: "decline", sid: started.sid })] }, context(`It runs on your computer, with ${tool}, in ${short(folder)}.`)] }).catch(() => {});
      }
    }
  }

  /** Where a channel's work goes: its folder, else a project the ask names, else the only one; or the choices to ask. */
  private async folderFor(channel: string, text: string): Promise<string | { choices: string[] }> {
    const kept = this.cfg()?.channels?.[channel];
    if (kept) return kept;
    const projects = (await this.d.projects()).slice(0, 8);
    const low = text.toLowerCase();
    const named = projects.filter((p) => {
      const base = p.folder.split(/[\\/]/).filter(Boolean).at(-1)?.toLowerCase() ?? "";
      return (base.length > 2 && new RegExp(`\\b${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(low)) || (!!p.repo && low.includes(p.repo.toLowerCase()));
    });
    if (named.length === 1) return named[0]!.folder;
    if (projects.length === 1) return projects[0]!.folder;
    return { choices: projects.map((p) => p.folder) };
  }

  // ── Friday's work, as Slack shows it ────────────────────────────────────────────────────────────────────────────────

  /** The status message: what's happening now, the plan, and Stop while it works. */
  private statusBlocks(link: ChannelLink, line: string, working: boolean): unknown[] {
    const plan = (link.meta?.plan as { content: string; status: string }[] | undefined) ?? [];
    return [
      section(line),
      ...(plan.length ? [section(plan.map((p) => `${PLAN_MARK[p.status] ?? "○"} ${p.content}`).join("\n"))] : []),
      ...(working ? [{ type: "actions", elements: [btn("Stop", { k: "stop", sid: link.sid }, "danger")] }] : []),
    ];
  }

  private async setStatus(link: ChannelLink, line: string, working: boolean): Promise<void> {
    const ts = String(link.meta?.status ?? "");
    const channel = String(link.meta?.channel ?? "");
    if (!ts || !channel) return;
    await this.api.update(channel, ts, line, this.statusBlocks(link, line, working)).catch((e: SlackError) => console.error("[slack] status", e.message));
  }

  async update(link: ChannelLink, u: Update, _s: SessionState): Promise<void> {
    const channel = String(link.meta?.channel ?? "");
    const thread = String(link.meta?.thread ?? "");
    if (!channel) return;
    const tool = String(link.meta?.tool ?? "The agent");
    try {
      if (u.kind === "working") {
        link.meta = { ...link.meta, line: `${tool} is working in ${link.meta?.folder ?? "its folder"}.` };
        await this.d.bridge.save(link);
        await this.setStatus(link, String(link.meta.line), true);
      }
      if (u.kind === "step") await this.setStatus(link, `${tool} · ${u.text}`, true);
      if (u.kind === "plan") {
        link.meta = { ...link.meta, plan: u.entries };
        await this.d.bridge.save(link);
        await this.setStatus(link, String(link.meta?.line ?? `${tool} is working.`), true);
      }
      if (u.kind === "pr") await this.api.post(channel, `Pull request: ${u.url}`, { thread, blocks: [section(`*Pull request:* <${u.url}|${u.url.replace(/^https?:\/\/(www\.)?github\.com\//, "")}>`)] });
      if (u.kind === "approval") await this.askApproval(channel, thread, link.sid, u);
      if (u.kind === "question") await this.askQuestion(channel, thread, link.sid, u);
      if (u.kind === "ended") {
        const end = u.outcome === "stopped" ? "Stopped." : u.outcome === "error" ? `Stopped with an error${u.error ? `: ${u.error.slice(0, 300)}` : "."}` : u.outcome === "waiting" ? "Waiting on you." : "Done.";
        await this.setStatus(link, `${tool} · ${end}`, false);
        if (u.reply.trim()) await this.api.post(channel, u.reply.slice(0, 300), { thread, blocks: [section(toMrkdwn(u.reply))] });
      }
    } catch (e) {
      console.error("[slack] update", (e as Error).message);
    }
  }

  private async askApproval(channel: string, thread: string, sid: string, u: Extract<Update, { kind: "approval" }>): Promise<void> {
    const what = u.items.map((i) => `\`${i.slice(0, 300)}\``).join("\n");
    const text = `${u.agent} asks to run:\n${what}${u.why ? `\n_${u.why}_` : ""}`;
    await this.api.post(channel, `${u.agent} asks to run ${u.items[0] ?? "a command"}`, {
      ...(thread ? { thread } : {}),
      blocks: [section(text), { type: "actions", elements: [btn("Approve", { k: "ap", sid, id: u.id, a: "1", lane: u.lane }, "primary"), btn("Allow for this task", { k: "ap", sid, id: u.id, a: "task", lane: u.lane }), btn("Deny", { k: "ap", sid, id: u.id, a: "0", lane: u.lane }, "danger")] }],
    });
  }

  private async askQuestion(channel: string, thread: string, sid: string, u: Extract<Update, { kind: "question" }>): Promise<void> {
    await this.api.post(channel, `${u.agent} asks: ${u.question}`, {
      ...(thread ? { thread } : {}),
      blocks: [section(`*${u.agent} asks:* ${toMrkdwn(u.question)}`), ...(u.options.length ? [{ type: "actions", elements: u.options.slice(0, 5).map((o) => btn(o, { k: "q", sid, t: o.slice(0, 1500), lane: u.lane })) }] : []), context(thread ? "Or reply in this thread." : "Or answer in Friday.")],
    });
  }

  /** "Needs you" DMs, when on: an approval or a question from any of the person's threads. */
  async elsewhere(sid: string, u: Extract<Update, { kind: "approval" | "question" }>, s: SessionState): Promise<void> {
    const c = this.cfg();
    if (!c?.dms || !c.me || this.socket.state !== "on") return;
    const dm = await this.api.dm(c.me.id).catch(() => null);
    if (!dm) return;
    await this.api.post(dm, `In “${s.title}”`, { blocks: [context(`In “${s.title}”`)] }).catch(() => {});
    if (u.kind === "approval") await this.askApproval(dm, "", sid, u).catch(() => {});
    else await this.askQuestion(dm, "", sid, u).catch(() => {});
  }
}
