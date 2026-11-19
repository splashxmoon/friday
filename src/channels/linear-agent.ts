import { randomBytes } from "node:crypto";
import http from "node:http";
import type { SessionState } from "../session/projection.js";
import { ENGINE_NAMES } from "../types.js";
import type { ChannelBridge, ChannelLink, SideAdapter, Update } from "./bridge.js";
import type { ChannelsConfig, LinearConfig } from "./config.js";
import { builtInLinear } from "../runner/builtin-apps.js";
import { LINEAR_CALLBACK_PORT, LinearApi, LinearError, authorizeUrl, exchangeCode, firstAsk, lastAt, linearCallback, pkce, refreshTokens, sessionTask, type LinearSession } from "./linear.js";

/**
 * Friday working Linear issues as an agent (spec 08): signs in as an app of the person's own, then, while Friday is open, reads
 * Linear's agent sessions every few seconds. A new one (an issue delegated to Friday, an @Friday in a comment) becomes a thread
 * on this computer; what is said in it after goes to that thread; and the thread's work comes back as the session's activities,
 * plan, and PR link. The issue moves to its team's first "started" state when work starts.
 */

export interface LinearAgentDeps {
  config: ChannelsConfig;
  bridge: ChannelBridge;
  /** Folders worked in lately, newest first (with their GitHub repo when known), for picking where an issue's work goes. */
  projects(): Promise<{ folder: string; repo?: string }[]>;
  /** How often Linear is read while connected. Linear marks a session unresponsive after 10 seconds without a word. */
  pollMs?: number;
  env?: NodeJS.ProcessEnv;
  /** The sign-in's callback port (tests use a free one). */
  callbackPort?: number;
}

export interface LinearStatus {
  connected: boolean;
  /** Set up but not signed in, or signed out since. */
  clientId?: string;
  org?: string;
  urlKey?: string;
  app?: string;
  me?: { id: string; name: string } | null;
  error?: string;
  teams?: { id: string; folder: string; name?: string }[];
  /** Friday's own Linear app is in this build: Connect is one button. */
  builtIn: boolean;
  /** Signed in with it, rather than an app of the person's own. */
  usingBuiltIn?: boolean;
  /** When Linear was last read without a problem (ms), and how many of its sessions are linked to threads here. */
  checkedAt?: number;
  threads?: number;
}

const short = (folder: string) => folder.replace(/^\/(Users|home)\/[^/]+/, "~");

export class LinearAgent implements SideAdapter {
  readonly side = "linear" as const;
  private api: LinearApi;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private error = "";
  /** Reads that failed in a row: the next waits longer, up to a minute, so a Linear outage or a rate limit isn't hammered. */
  private fails = 0;
  private checkedAt = 0;
  /** Each session's last change as last read: one that hasn't changed isn't read again (Linear's rate limit). */
  private seen = new Map<string, string>();
  /** When each session was last read up to (an activity's time), so each prompt is acted on once; kept on its link too. */
  private cursor = new Map<string, string>();
  /** Sessions being started now, so a slow start isn't started twice by the next read. */
  private starting = new Set<string>();
  private signIn: { verifier: string; state: string; server: http.Server; done: Promise<void> } | null = null;

  constructor(private d: LinearAgentDeps) {
    this.api = new LinearApi(() => this.token(), d.env ?? process.env);
  }

  private cfg(): LinearConfig | undefined {
    return this.d.config.read().linear;
  }

  private save(patch: Partial<LinearConfig>): void {
    const cur = this.cfg();
    if (!cur && !patch.clientId) return;
    this.d.config.patch("linear", { ...(cur ?? { clientId: patch.clientId! }), ...patch });
  }

  /** A token that works: refreshed a minute before it would stop. */
  private async token(): Promise<string> {
    const c = this.cfg();
    if (!c?.access) throw new LinearError("Not signed in to Linear.", true);
    if (c.expires && c.refresh && c.expires - Date.now() < 60_000) {
      const t = await refreshTokens({ clientId: c.clientId, ...(c.clientSecret ? { clientSecret: c.clientSecret } : {}), refresh: c.refresh }, this.d.env ?? process.env);
      this.save({ access: t.access, ...(t.refresh ? { refresh: t.refresh } : {}), ...(t.expires ? { expires: t.expires } : {}) });
      return t.access;
    }
    return c.access;
  }

  status(): LinearStatus {
    const c = this.cfg();
    return {
      connected: !!c?.access && !!c.app,
      ...(c?.clientId ? { clientId: c.clientId } : {}),
      ...(c?.app ? { org: c.app.org, urlKey: c.app.urlKey, app: c.app.name } : {}),
      me: c?.me ?? null,
      ...(this.error ? { error: this.error } : {}),
      teams: Object.entries(c?.teams ?? {}).map(([id, folder]) => ({ id, folder, ...(c?.teamNames?.[id] ? { name: c.teamNames[id] } : {}) })),
      builtIn: !!builtInLinear(),
      ...(c?.builtIn ? { usingBuiltIn: true } : {}),
      ...(this.checkedAt ? { checkedAt: this.checkedAt } : {}),
    };
  }

  // ── Sign-in ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * The link to Linear's Install page, with a listener on this computer for where Linear sends the person back. Resolves the
   * link at once; the connection is made when they press Install there.
   */
  async connect(o: { clientId?: string; clientSecret?: string } = {}): Promise<{ url: string }> {
    // No app of their own given: Friday's own, when this build has it (one button).
    const own = builtInLinear();
    const mine = !!o.clientId?.trim();
    const clientId = mine ? o.clientId!.trim() : (own?.id ?? "");
    if (!clientId) throw new Error("Paste the client ID of your Linear app.");
    if (!/^[\w-]{8,80}$/.test(clientId)) throw new Error("That doesn't look like a Linear client ID. Copy it from the app's page in Linear.");
    const secret = mine ? o.clientSecret?.trim() : own?.secret;
    this.d.config.patch("linear", { ...(this.cfg() ?? {}), clientId, ...(secret ? { clientSecret: secret } : { clientSecret: undefined }), builtIn: !mine });
    await this.closeSignIn();
    const port = this.d.callbackPort ?? LINEAR_CALLBACK_PORT;
    const redirect = linearCallback(port);
    const { verifier, challenge } = pkce();
    const state = randomBytes(16).toString("base64url");
    let finish!: () => void;
    const done = new Promise<void>((r) => (finish = r));
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", redirect);
      if (u.pathname !== "/linear/callback") return void res.writeHead(404).end();
      const page = (title: string, body: string) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px system-ui;margin:15vh auto;max-width:28rem;text-align:center"><h2 style="font-weight:500">${title}</h2><p>${body}</p></body>`);
      };
      if (u.searchParams.get("state") !== state) return page("That link is old", "Start again from Friday's Settings.");
      const err = u.searchParams.get("error_description") || u.searchParams.get("error");
      const code = u.searchParams.get("code");
      if (err || !code) {
        this.error = err || "Linear didn't say yes.";
        page("Not connected", this.error);
        return void this.closeSignIn().then(finish);
      }
      void (async () => {
        try {
          const c = this.cfg()!;
          const t = await exchangeCode({ clientId: c.clientId, ...(c.clientSecret ? { clientSecret: c.clientSecret } : {}), code, verifier, redirect }, this.d.env ?? process.env);
          this.save({ access: t.access, ...(t.refresh ? { refresh: t.refresh } : {}), ...(t.expires ? { expires: t.expires } : {}), since: Date.now() });
          const app = await this.api.viewer();
          this.save({ app });
          this.error = "";
          page("Friday is in Linear", `Delegate an issue to ${app.name} in ${app.org}, or mention it in a comment. You can close this tab.`);
          this.start();
        } catch (e) {
          this.error = (e as Error).message;
          page("Not connected", this.error);
        } finally {
          await this.closeSignIn();
          finish();
        }
      })();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", (e: NodeJS.ErrnoException) => reject(new Error(e.code === "EADDRINUSE" ? `Port ${port} on this computer is in use, so Linear can't send you back. Close what's using it and try again.` : e.message)));
      server.listen(port, "127.0.0.1", () => resolve());
    });
    this.signIn = { verifier, state, server, done };
    // Not finished in ten minutes: the listener goes.
    setTimeout(() => void this.closeSignIn(), 10 * 60_000).unref();
    return { url: authorizeUrl({ clientId, redirect, challenge, state }, this.d.env ?? process.env) };
  }

  /** Resolves once the sign-in in progress has ended, either way (tests). */
  signedIn(): Promise<void> {
    return this.signIn?.done ?? Promise.resolve();
  }

  private async closeSignIn(): Promise<void> {
    const s = this.signIn;
    this.signIn = null;
    if (s) await new Promise<void>((r) => s.server.close(() => r()));
  }

  /** The people in the Linear workspace, for "which one is you". */
  async people(): Promise<{ id: string; name: string; email?: string }[]> {
    const d = await this.api.gql<{ users: { nodes: { id: string; name: string; email?: string; active?: boolean; app?: boolean }[] } }>(`query { users(first: 250) { nodes { id name email active app } } }`);
    return d.users.nodes.filter((u) => u.active !== false && !u.app).map(({ id, name, email }) => ({ id, name, ...(email ? { email } : {}) }));
  }

  setMe(me: { id: string; name: string } | null): void {
    this.save(me ? { me } : { me: undefined });
  }

  setTeam(teamId: string, folder: string | null, name?: string): void {
    const teams = { ...(this.cfg()?.teams ?? {}) };
    const teamNames = { ...(this.cfg()?.teamNames ?? {}) };
    if (folder) teams[teamId] = folder;
    else delete teams[teamId];
    if (folder && name) teamNames[teamId] = name;
    if (!folder) delete teamNames[teamId];
    this.save({ teams, teamNames });
  }

  async disconnect(): Promise<void> {
    this.stop();
    await this.closeSignIn();
    this.d.config.patch("linear", null);
    this.error = "";
  }

  // ── Reading Linear ──────────────────────────────────────────────────────────────────────────────────────────────────

  start(): void {
    if (this.timer || !this.cfg()?.access) return;
    const base = this.d.pollMs ?? 3000;
    const tick = () => void this.poll().finally(() => this.timer && (this.timer = setTimeout(tick, Math.min(60_000, base * 2 ** Math.min(this.fails, 5)))));
    this.timer = setTimeout(tick, 0);
  }

  /** The teams in the Linear workspace, each with the folder its issues go to when one is picked. */
  async teams(): Promise<{ id: string; key: string; name: string; folder: string | null }[]> {
    const d = await this.api.gql<{ teams: { nodes: { id: string; key: string; name: string }[] } }>(`query { teams(first: 100) { nodes { id key name } } }`);
    const kept = this.cfg()?.teams ?? {};
    return d.teams.nodes.map((t) => ({ ...t, folder: kept[t.id] ?? null }));
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One read of Linear: new sessions started, new words in linked ones passed on. */
  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const c = this.cfg();
      if (!c?.access) return;
      const since = (c.since ?? 0) - 24 * 3600_000;
      for (const s of await this.api.sessions(25)) {
        if (Date.parse(s.createdAt) < since) continue;
        // Unchanged since the last read: nothing new in it.
        const changed = this.seen.get(s.id) !== s.updatedAt;
        const sid = await this.d.bridge.sidOf("linear", s.id);
        if (sid) {
          if (changed) await this.follow(s, sid);
        } else if (this.cfg()?.choosing?.[s.id]) {
          if (changed) await this.chose(s);
        } else if (!this.starting.has(s.id) && (s.status === "pending" || s.status === "active" || s.status === "awaitingInput")) await this.begin(s);
        this.seen.set(s.id, s.updatedAt);
      }
      this.error = "";
      this.fails = 0;
      this.checkedAt = Date.now();
    } catch (e) {
      this.fails++;
      this.error = /rate ?limit/i.test((e as Error).message) ? "Linear asked Friday to slow down. It's reading less often for a while." : (e as Error).message;
      if (e instanceof LinearError && e.auth) {
        this.error = "Linear signed Friday out. Connect it again.";
        this.stop();
      }
    } finally {
      this.busy = false;
    }
  }

  /** A session Friday hasn't seen: said hello to within Linear's 10 seconds, then started where its team works. */
  private async begin(s: LinearSession): Promise<void> {
    this.starting.add(s.id);
    try {
      const acts = await this.api.activities(s.id);
      // One Friday already answered (a restart lost the link): left alone.
      if (acts.some((a) => a.content.type !== "prompt")) return;
      await this.api.activity(s.id, { type: "thought", body: s.issue ? `Picking up ${s.issue.identifier} on ${this.cfg()?.me?.name ?? "this"}'s computer.` : "On it." });
      this.cursor.set(s.id, lastAt(acts, s.createdAt));
      const ask = firstAsk(s, acts);
      const folder = await this.folderFor(s);
      if (typeof folder !== "string") {
        // Not sure where: asked, with the folders worked in lately to pick from. Kept, so a restart doesn't strand it.
        this.save({ choosing: { ...(this.cfg()?.choosing ?? {}), [s.id]: { folders: folder.choices, ask, after: this.cursor.get(s.id) ?? s.createdAt } } });
        await this.api.activity(s.id, { type: "elicitation", body: folder.choices.length ? "Which project on this computer is this in?" : "Which folder on this computer is this in? Reply with its full path." }, folder.choices.length ? { signal: "select", signalMetadata: { options: folder.choices.map((f) => ({ label: short(f), value: f })) } } : {});
        return;
      }
      await this.launch(s, ask, folder);
    } finally {
      this.starting.delete(s.id);
    }
  }

  /** The answer to "which project": the folder, kept for the team, and the work started there. */
  private async chose(s: LinearSession): Promise<void> {
    const waiting = this.cfg()?.choosing?.[s.id];
    if (!waiting) return;
    const after = this.cursor.get(s.id) ?? waiting.after;
    const fresh = await this.api.prompts(s.id, after);
    const said = fresh.at(-1);
    if (!said) return;
    this.cursor.set(s.id, said.createdAt);
    const keep = (choosing: NonNullable<LinearConfig["choosing"]>) => this.save({ choosing });
    keep({ ...(this.cfg()?.choosing ?? {}), [s.id]: { ...waiting, after: said.createdAt } });
    const text = (said.content.body ?? "").trim();
    const picked = waiting.folders.find((f) => f === text || short(f) === text || f.endsWith(`/${text}`)) ?? (text.startsWith("/") || text.startsWith("~") ? text.replace(/^~(?=\/)/, process.env.HOME ?? "~") : "");
    if (!picked) return void (await this.api.activity(s.id, { type: "elicitation", body: "I didn't find that folder. Pick one of the projects, or reply with a full path." }));
    const { [s.id]: _done, ...rest } = this.cfg()?.choosing ?? {};
    this.save({ choosing: rest });
    if (s.issue) this.setTeam(s.issue.team.id, picked, s.issue.team.name);
    await this.launch(s, waiting.ask, picked);
  }

  private async launch(s: LinearSession, ask: string, folder: string): Promise<void> {
    const me = this.cfg()?.me;
    const creator = s.creator;
    const mine = !!me && !!creator && creator.id === me.id;
    const issue = s.issue;
    try {
      const r = await this.d.bridge.start({
        side: "linear",
        ref: s.id,
        title: issue ? `${issue.identifier}: ${issue.title}` : ask.slice(0, 80) || "From Linear",
        task: sessionTask(s, ask, mine),
        folder,
        by: { id: creator?.id ?? "unknown", name: creator?.name ?? "Someone", me: mine },
        label: issue ? issue.identifier : "Linear",
        ...(s.url || issue?.url ? { url: (s.url || issue?.url)! } : {}),
        meta: { ...(issue ? { issue: issue.id, team: issue.team.id } : {}), cursor: this.cursor.get(s.id) ?? s.createdAt },
      });
      if (r.held) {
        await this.api.activity(s.id, { type: "elicitation", body: `Waiting for ${me?.name ?? "the person whose computer this is"} to start this in Friday. ${ENGINE_NAMES[r.tool]} will work in ${short(folder)} once they do.` });
      } else {
        await this.api.activity(s.id, { type: "thought", body: `${ENGINE_NAMES[r.tool]} is starting in ${short(folder)}.` });
        await this.started(s);
      }
    } catch (e) {
      await this.api.activity(s.id, { type: "error", body: `Couldn't start: ${(e as Error).message}` }).catch(() => {});
    }
  }

  /** The issue in its team's first "started" state, and Friday its delegate, as Linear asks of an agent that takes work on. */
  private async started(s: LinearSession): Promise<void> {
    const issue = s.issue;
    if (!issue) return;
    const app = this.cfg()?.app;
    try {
      if (!issue.state || !["started", "completed", "canceled"].includes(issue.state.type)) {
        const st = await this.api.startedState(issue.team.id);
        if (st) await this.api.moveIssue(issue.id, st);
      }
      if (!issue.delegate && app) await this.api.setDelegate(issue.id, app.id);
    } catch (e) {
      console.error("[linear] status", (e as Error).message);
    }
  }

  /**
   * A linked session: what people said in it since it was last read, to its thread; Linear's stop, as a stop. Read from where its
   * link says, so what was said while Friday was closed is passed on when it opens.
   */
  private async follow(s: LinearSession, sid: string): Promise<void> {
    const link = await this.d.bridge.link(sid);
    const last = this.cursor.get(s.id) ?? (link?.meta?.cursor as string | undefined) ?? s.createdAt;
    const fresh = await this.api.prompts(s.id, last);
    if (!fresh.length) return void this.cursor.set(s.id, last);
    const at = fresh.at(-1)!.createdAt;
    this.cursor.set(s.id, at);
    if (link) await this.d.bridge.save({ ...link, meta: { ...link.meta, cursor: at } });
    const me = this.cfg()?.me;
    for (const p of fresh) {
      if (p.signal === "stop") {
        await this.d.bridge.stop(sid);
        continue;
      }
      const text = (p.content.body ?? "").trim();
      if (!text) continue;
      const who = p.user ?? s.creator;
      await this.d.bridge.say(sid, text, { id: who?.id ?? "unknown", name: who?.name ?? "Someone", me: !!me && who?.id === me.id });
    }
  }

  /** Where an issue's work goes: its team's folder, else a project the issue names, else the only one; or the choices to ask. */
  private async folderFor(s: LinearSession): Promise<string | { choices: string[] }> {
    const team = s.issue?.team.id;
    const kept = team ? this.cfg()?.teams?.[team] : undefined;
    if (kept) return kept;
    const projects = (await this.d.projects()).slice(0, 8);
    const text = `${s.issue?.title ?? ""} ${s.issue?.description ?? ""} ${s.comment?.body ?? ""}`.toLowerCase();
    const named = projects.filter((p) => {
      const base = p.folder.split(/[\\/]/).filter(Boolean).at(-1)?.toLowerCase() ?? "";
      return (base.length > 2 && new RegExp(`\\b${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)) || (!!p.repo && text.includes(p.repo.toLowerCase()));
    });
    if (named.length === 1) return named[0]!.folder;
    if (projects.length === 1) return projects[0]!.folder;
    return { choices: projects.map((p) => p.folder) };
  }

  // ── Friday's work, as Linear shows it ───────────────────────────────────────────────────────────────────────────────

  async update(link: ChannelLink, u: Update, _s: SessionState): Promise<void> {
    const id = link.ref;
    try {
      if (u.kind === "working") {
        await this.api.activity(id, { type: "thought", body: `${u.text}.` }, { ephemeral: true });
        // A teammate's ask the person just sent on: the issue moves now.
        if (!link.by.me) await this.started(await this.api.session(id));
      }
      if (u.kind === "step") await this.api.activity(id, { type: "action", action: u.text, parameter: "" }, { ephemeral: true });
      if (u.kind === "plan") await this.api.updateSession(id, { plan: u.entries });
      if (u.kind === "pr") {
        await this.api.updateSession(id, { addedExternalUrls: [{ label: "Pull request", url: u.url }] });
        await this.api.activity(id, { type: "thought", body: `Opened a pull request: ${u.url}` });
      }
      if (u.kind === "approval") {
        const what = u.items.length === 1 ? `\`${u.items[0]}\`` : u.items.map((i) => `- \`${i}\``).join("\n");
        await this.api.activity(id, { type: "elicitation", body: `${u.agent} asks to run${u.items.length === 1 ? " " : ":\n"}${what}${u.why ? `\n\n${u.why}` : ""}` }, { signal: "select", signalMetadata: { options: [{ label: "Approve", value: "approve" }, { label: "Deny", value: "deny" }] } });
      }
      if (u.kind === "question") {
        await this.api.activity(id, { type: "elicitation", body: `${u.agent} asks: ${u.question}` }, u.options.length ? { signal: "select", signalMetadata: { options: u.options.map((o) => ({ label: o.slice(0, 80), value: o })) } } : {});
      }
      if (u.kind === "ended") {
        const body = u.reply.trim() || (u.outcome === "done" ? "Done." : "");
        if (u.outcome === "stopped") await this.api.activity(id, { type: "response", body: `Stopped.${body ? `\n\n${body}` : ""}` });
        else if (u.outcome === "error") await this.api.activity(id, { type: "error", body: u.error ? `It stopped with an error: ${u.error}` : "It stopped with an error." });
        else if (u.outcome === "waiting") await this.api.activity(id, { type: "elicitation", body: body || "Waiting on you." });
        else await this.api.activity(id, { type: "response", body: body.slice(0, 5000) });
      }
    } catch (e) {
      console.error("[linear] update", (e as Error).message);
    }
  }
}

