import { WebSocket } from "ws";

/**
 * Friday in Slack, from this computer (spec 08): Slack's side only. The person makes a Slack app of their own from the manifest
 * below (one link that fills in Slack's new-app form), installs it, and pastes its two tokens. Friday then holds a Socket Mode
 * connection: Slack sends mentions, thread replies, DMs, button presses, `/friday` and the "Send to Friday" shortcut down it, and
 * nothing has to reach this computer from outside. Replies go out with Slack's Web API.
 *
 * The hosted Team edition's Slack app (src/slack.ts) is a different thing: one app for many workspaces, over HTTP events.
 */

/** Slack's Web API, or a stand-in's (tests). */
export const slackApiBase = (env: NodeJS.ProcessEnv = process.env) => env.FRIDAY_SLACK_URL?.replace(/\/+$/, "") || "https://slack.com/api";

/** What the app asks for: mentions and DMs, posting and editing its own messages, reading the threads it's in, and who people are. */
export const SLACK_BOT_SCOPES = ["app_mentions:read", "chat:write", "channels:history", "groups:history", "im:history", "mpim:history", "im:write", "users:read", "users:read.email", "commands", "reactions:write"];

/** The app, as Slack's "From a manifest" form takes it. */
export function slackManifest(name = "Friday") {
  return {
    display_information: { name, description: "Your coding agents, from Slack. Runs on your own computer.", background_color: "#141414" },
    features: {
      bot_user: { display_name: name, always_online: false },
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      slash_commands: [{ command: "/friday", description: "Start work, or see what's running", usage_hint: "[what to do]", should_escape: false }],
      shortcuts: [{ name: "Send to Friday", type: "message", callback_id: "send_to_friday", description: "Turn this message into work for Friday" }],
    },
    oauth_config: { scopes: { bot: SLACK_BOT_SCOPES } },
    settings: {
      event_subscriptions: { bot_events: ["app_mention", "message.im", "message.channels", "message.groups"] },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

/** Slack's new-app page with Friday's manifest filled in. */
export const slackNewAppUrl = () => `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackManifest()))}`;

export class SlackError extends Error {
  constructor(
    readonly code: string,
    /** The token was refused: connecting again won't help until a new one is pasted. */
    readonly auth = false,
  ) {
    super(SLACK_WORDS[code] ?? `Slack said ${code}.`);
  }
}

const SLACK_WORDS: Record<string, string> = {
  invalid_auth: "Slack didn't accept that token. Copy it again from the app's page.",
  not_authed: "Slack didn't get a token.",
  account_inactive: "That Slack app was removed or its tokens revoked.",
  token_revoked: "That token was revoked in Slack.",
  missing_scope: "The app is missing a permission. Create it again from Friday's link, which asks for all of them.",
  not_in_channel: "Friday isn't in that channel. Invite it with /invite @Friday.",
  channel_not_found: "Friday can't see that channel. Invite it with /invite @Friday.",
};

const AUTH_CODES = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked"]);

/** Slack's Web API with one token. Slack answers 200 with `ok: false` for most failures, so each call reads that. */
export class SlackApi {
  constructor(
    private token: () => string,
    private env: NodeJS.ProcessEnv = process.env,
  ) {}

  async call<T = Record<string, unknown>>(method: string, args: Record<string, unknown> = {}, token = this.token()): Promise<T> {
    const r = await fetch(`${slackApiBase(this.env)}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status === 429) throw new SlackError("ratelimited");
    const j = (await r.json().catch(() => ({ ok: false, error: `http_${r.status}` }))) as { ok: boolean; error?: string } & T;
    if (!j.ok) throw new SlackError(j.error ?? "unknown", AUTH_CODES.has(j.error ?? ""));
    return j;
  }

  post(channel: string, text: string, o: { thread?: string; blocks?: unknown[] } = {}) {
    return this.call<{ ts: string; channel: string }>("chat.postMessage", { channel, text, ...(o.thread ? { thread_ts: o.thread } : {}), ...(o.blocks ? { blocks: o.blocks } : {}), unfurl_links: false, unfurl_media: false });
  }

  update(channel: string, ts: string, text: string, blocks?: unknown[]) {
    return this.call("chat.update", { channel, ts, text, ...(blocks ? { blocks } : {}) });
  }

  ephemeral(channel: string, user: string, text: string, thread?: string) {
    return this.call("chat.postEphemeral", { channel, user, text, ...(thread ? { thread_ts: thread } : {}) });
  }

  async user(id: string): Promise<{ id: string; name: string; email?: string }> {
    const r = await this.call<{ user: { id: string; real_name?: string; name: string; profile?: { display_name?: string; real_name?: string; email?: string } } }>("users.info", { user: id });
    const u = r.user;
    return { id: u.id, name: u.profile?.display_name || u.profile?.real_name || u.real_name || u.name, ...(u.profile?.email ? { email: u.profile.email } : {}) };
  }

  async people(): Promise<{ id: string; name: string; email?: string }[]> {
    const r = await this.call<{ members: { id: string; name: string; real_name?: string; deleted?: boolean; is_bot?: boolean; profile?: { display_name?: string; real_name?: string; email?: string } }[] }>("users.list", { limit: 500 });
    return r.members.filter((m) => !m.deleted && !m.is_bot && m.id !== "USLACKBOT").map((m) => ({ id: m.id, name: m.profile?.display_name || m.profile?.real_name || m.real_name || m.name, ...(m.profile?.email ? { email: m.profile.email } : {}) }));
  }

  /** A thread's messages, oldest first. */
  async replies(channel: string, ts: string, limit = 40): Promise<{ user?: string; bot_id?: string; text: string; ts: string }[]> {
    const r = await this.call<{ messages: { user?: string; bot_id?: string; text: string; ts: string }[] }>("conversations.replies", { channel, ts, limit });
    return r.messages;
  }

  async dm(user: string): Promise<string> {
    const r = await this.call<{ channel: { id: string } }>("conversations.open", { users: user });
    return r.channel.id;
  }
}

// ── Socket Mode ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SocketEnvelope {
  envelope_id?: string;
  type: string;
  payload?: Record<string, unknown>;
  reason?: string;
}

/**
 * One Socket Mode connection, kept up: opened with the app-level token, each envelope acknowledged at once (Slack retries one
 * that isn't, within three seconds), and opened again when Slack says it's about to drop it or the line goes quiet.
 */
export class SlackSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private retry = 0;
  private timer: NodeJS.Timeout | null = null;
  state: "off" | "connecting" | "on" = "off";
  lastError = "";

  constructor(
    private appToken: () => string,
    private onEnvelope: (e: SocketEnvelope) => void | Promise<void>,
    private env: NodeJS.ProcessEnv = process.env,
    private onState: (s: "off" | "connecting" | "on", error?: string) => void = () => {},
  ) {}

  async open(): Promise<void> {
    this.closed = false;
    if (this.ws) return;
    this.set("connecting");
    let url: string;
    try {
      const r = await new SlackApi(() => this.appToken(), this.env).call<{ url: string }>("apps.connections.open", {}, this.appToken());
      url = r.url;
    } catch (e) {
      this.lastError = (e as Error).message;
      this.set("off", this.lastError);
      if (!(e instanceof SlackError && e.auth)) this.later();
      return;
    }
    const ws = new WebSocket(url);
    this.ws = ws;
    let alive = Date.now();
    const quiet = setInterval(() => {
      // Slack pings every so often; nothing for two minutes is a line that died without closing.
      if (Date.now() - alive > 120_000) ws.terminate();
    }, 30_000);
    ws.on("ping", () => (alive = Date.now()));
    ws.on("message", (raw) => {
      alive = Date.now();
      let e: SocketEnvelope;
      try {
        e = JSON.parse(String(raw)) as SocketEnvelope;
      } catch {
        return;
      }
      if (e.envelope_id) ws.send(JSON.stringify({ envelope_id: e.envelope_id }));
      if (e.type === "hello") {
        this.retry = 0;
        this.lastError = "";
        this.set("on");
        return;
      }
      if (e.type === "disconnect") return void ws.close();
      void Promise.resolve(this.onEnvelope(e)).catch((err) => console.error("[slack]", err));
    });
    ws.on("error", (err) => (this.lastError = err.message));
    ws.on("close", () => {
      clearInterval(quiet);
      if (this.ws === ws) this.ws = null;
      this.set(this.closed ? "off" : "connecting", this.lastError || undefined);
      if (!this.closed) this.later();
    });
  }

  private later(): void {
    if (this.closed || this.timer) return;
    const wait = Math.min(60_000, 1000 * 2 ** this.retry++);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.open();
    }, wait);
    this.timer.unref?.();
  }

  private set(s: "off" | "connecting" | "on", error?: string) {
    this.state = s;
    this.onState(s, error);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ws?.close();
    this.ws = null;
    this.set("off");
  }
}

// ── Words ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** "<@U123> fix the test" → "fix the test": the mention is how it was asked, not what. */
export function withoutMention(text: string, botUser?: string): string {
  const re = botUser ? new RegExp(`<@${botUser}(\\|[^>]*)?>`, "g") : /<@[A-Z0-9]+(\|[^>]*)?>/g;
  return text.replace(re, "").replace(/[ \t]+/g, " ").trim();
}

/** Slack's markup as plain words: links, channels and people. */
export function plainSlack(text: string): string {
  return text
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<@[A-Z0-9]+\|([^>]+)>/g, "@$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * An agent's Markdown as Slack's mrkdwn: **bold** to *bold*, links to <url|text>, headings to bold lines, and code kept as code.
 * Code blocks are left as they are; everything else is escaped as Slack asks (&, <, >).
 */
export function toMrkdwn(md: string): string {
  const parts = md.split(/(```[\s\S]*?```)/g);
  return parts
    .map((p, i) => {
      if (i % 2 === 1) return p.replace(/^```[\w-]*\n/, "```\n");
      return p
        .split(/(`[^`\n]+`)/g)
        .map((q, j) =>
          j % 2 === 1
            ? q
            : q
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
                .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
                .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
                .replace(/__([^_\n]+)__/g, "*$1*")
                .replace(/~~([^~\n]+)~~/g, "~$1~")
                .replace(/^(\s*)[-*]\s+/gm, "$1• "),
        )
        .join("");
    })
    .join("");
}

/** Text cut to Slack's limit for a section block (3000) with room to spare, at a line where it can. */
export function cutForSlack(text: string, max = 2800): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const nl = cut.lastIndexOf("\n");
  return `${(nl > max * 0.6 ? cut.slice(0, nl) : cut).trimEnd()}\n…`;
}
