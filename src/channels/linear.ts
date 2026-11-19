import { createHash, randomBytes } from "node:crypto";
import { UNTRUSTED_NOTE, untrusted } from "../untrusted.js";

/**
 * Friday as a Linear agent (Arun, 2026-11-18: "allowing friday to be within slack and linear too... make it very advanced";
 * spec: Friday Work HQ/product/specs/08-slack-and-linear.md). The person makes a Linear app of their own and installs it as
 * itself (`actor=app`), so Friday shows in Linear as a teammate issues are delegated to and @mentioned. Nothing calls this
 * computer: Friday reads its agent sessions and their activities from Linear's API while it is open, and writes back what it
 * does as activities (thoughts, steps, questions, the answer), the session's plan, and the PR as a link.
 *
 * This file is Linear's side only: its API, sign-in, and the pure helpers that turn sessions and activities into Friday's words
 * and Friday's into Linear's. The bridge (bridge.ts) ties them to Friday's threads.
 */

/** Linear's API and sign-in, or a stand-in's (tests): FRIDAY_LINEAR_URL is the base the three paths hang from. */
export function linearUrls(env: NodeJS.ProcessEnv = process.env) {
  const base = env.FRIDAY_LINEAR_URL?.replace(/\/+$/, "");
  return {
    api: base ? `${base}/graphql` : "https://api.linear.app/graphql",
    token: base ? `${base}/oauth/token` : "https://api.linear.app/oauth/token",
    authorize: base ? `${base}/oauth/authorize` : "https://linear.app/oauth/authorize",
  };
}

/** What Friday asks Linear for: read and write, to be delegated issues, and to be @mentioned. */
export const LINEAR_SCOPES = ["read", "write", "app:assignable", "app:mentionable"];

/** Where Linear sends the person back after Install: a port of Friday's own, open only while signing in. */
export const LINEAR_CALLBACK_PORT = 47841;
export const linearCallback = (port = LINEAR_CALLBACK_PORT) => `http://localhost:${port}/linear/callback`;

export interface LinearTokens {
  access: string;
  refresh?: string;
  /** When the access token stops working (ms). */
  expires?: number;
}

/** PKCE: a verifier kept here, its hash sent with the sign-in. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function authorizeUrl(o: { clientId: string; redirect: string; challenge: string; state: string }, env: NodeJS.ProcessEnv = process.env): string {
  const q = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirect,
    response_type: "code",
    scope: LINEAR_SCOPES.join(","),
    actor: "app",
    state: o.state,
    code_challenge: o.challenge,
    code_challenge_method: "S256",
    prompt: "consent",
  });
  return `${linearUrls(env).authorize}?${q}`;
}

async function tokenCall(body: Record<string, string>, env: NodeJS.ProcessEnv): Promise<LinearTokens> {
  const r = await fetch(linearUrls(env).token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body), signal: AbortSignal.timeout(15_000) });
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!r.ok || !j.access_token) throw new Error(j.error_description || j.error || `Linear said ${r.status}`);
  return { access: j.access_token, ...(j.refresh_token ? { refresh: j.refresh_token } : {}), ...(j.expires_in ? { expires: Date.now() + j.expires_in * 1000 } : {}) };
}

/** The code Linear sent back, for tokens. The secret is optional with PKCE; given when the app has one. */
export function exchangeCode(o: { clientId: string; clientSecret?: string; code: string; verifier: string; redirect: string }, env: NodeJS.ProcessEnv = process.env) {
  return tokenCall({ grant_type: "authorization_code", client_id: o.clientId, code: o.code, code_verifier: o.verifier, redirect_uri: o.redirect, ...(o.clientSecret ? { client_secret: o.clientSecret } : {}) }, env);
}

export function refreshTokens(o: { clientId: string; clientSecret?: string; refresh: string }, env: NodeJS.ProcessEnv = process.env) {
  return tokenCall({ grant_type: "refresh_token", client_id: o.clientId, refresh_token: o.refresh, ...(o.clientSecret ? { client_secret: o.clientSecret } : {}) }, env);
}

// ── Linear's shapes, as much of them as Friday reads ──────────────────────────────────────────────────────────────────

export interface LinearUser {
  id: string;
  name: string;
  email?: string | null;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url: string;
  team: { id: string; key: string; name: string };
  state?: { id: string; name: string; type: string } | null;
  delegate?: { id: string } | null;
}

export interface LinearSession {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  url?: string | null;
  creator?: LinearUser | null;
  issue?: LinearIssue | null;
  comment?: { id: string; body: string } | null;
}

export interface LinearActivity {
  id: string;
  createdAt: string;
  signal?: string | null;
  content: { type: string; body?: string | null };
  user?: LinearUser | null;
}

const ISSUE = "id identifier title description url team { id key name } state { id name type } delegate { id }";
const SESSION = `id status createdAt updatedAt url creator { id name email } issue { ${ISSUE} } comment { id body }`;

export class LinearError extends Error {
  constructor(
    message: string,
    /** Signed out: the token was refused, so polling waits for a new sign-in rather than trying again. */
    readonly auth = false,
  ) {
    super(message);
  }
}

/** Linear's API with one token. GraphQL errors come back with a 200, so each call reads them too. */
export class LinearApi {
  constructor(
    private token: () => Promise<string>,
    private env: NodeJS.ProcessEnv = process.env,
  ) {}

  async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const r = await fetch(linearUrls(this.env).api, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await this.token()}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await r.json().catch(() => ({}))) as { data?: T; errors?: { message?: string; extensions?: { code?: string } }[] };
    const authErr = r.status === 401 || !!j.errors?.some((e) => /AUTHENTICATION|UNAUTHENTICATED|FORBIDDEN/i.test(e.extensions?.code ?? ""));
    if (!r.ok || j.errors?.length || !j.data) throw new LinearError(j.errors?.map((e) => e.message).filter(Boolean).join("; ") || `Linear said ${r.status}`, authErr);
    return j.data;
  }

  /** The app's own user in this Linear workspace, and the workspace's name. */
  async viewer(): Promise<{ id: string; name: string; org: string; urlKey: string }> {
    const d = await this.gql<{ viewer: { id: string; name: string }; organization: { name: string; urlKey: string } }>(`query { viewer { id name } organization { name urlKey } }`);
    return { id: d.viewer.id, name: d.viewer.name, org: d.organization.name, urlKey: d.organization.urlKey };
  }

  /** Sessions newest first by their last change. */
  async sessions(first = 25): Promise<LinearSession[]> {
    const d = await this.gql<{ agentSessions: { nodes: LinearSession[] } }>(`query($first: Int) { agentSessions(first: $first, orderBy: updatedAt) { nodes { ${SESSION} } } }`, { first });
    return d.agentSessions.nodes;
  }

  async session(id: string): Promise<LinearSession> {
    const d = await this.gql<{ agentSession: LinearSession }>(`query($id: String!) { agentSession(id: $id) { ${SESSION} } }`, { id });
    return d.agentSession;
  }

  /** A session's activities, oldest first. */
  async activities(sessionId: string, first = 50): Promise<LinearActivity[]> {
    const d = await this.gql<{ agentSession: { activities: { nodes: (LinearActivity & { content: Record<string, unknown> })[] } } }>(
      `query($id: String!, $first: Int) { agentSession(id: $id) { activities(first: $first, orderBy: createdAt) { nodes { id createdAt signal user { id name email } content { ... on AgentActivityPromptContent { type body } ... on AgentActivityThoughtContent { type body } ... on AgentActivityResponseContent { type body } ... on AgentActivityElicitationContent { type body } ... on AgentActivityErrorContent { type body } ... on AgentActivityActionContent { type } } } } } }`,
      { id: sessionId, first },
    );
    return d.agentSession.activities.nodes.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** What people said in a session after a time, oldest first: only prompts, so a busy session's own activities don't crowd them out. */
  async prompts(sessionId: string, after: string): Promise<LinearActivity[]> {
    const d = await this.gql<{ agentSession: { activities: { nodes: LinearActivity[] } } }>(
      `query($id: String!, $after: DateTimeOrDuration!) { agentSession(id: $id) { activities(first: 50, filter: { type: { eq: "prompt" }, createdAt: { gt: $after } }) { nodes { id createdAt signal user { id name email } content { ... on AgentActivityPromptContent { type body } } } } } }`,
      { id: sessionId, after },
    );
    return d.agentSession.activities.nodes.filter((a) => a.createdAt > after).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async activity(sessionId: string, content: Record<string, unknown>, extra: { ephemeral?: boolean; signal?: string; signalMetadata?: Record<string, unknown> } = {}): Promise<void> {
    await this.gql(`mutation($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }`, { input: { agentSessionId: sessionId, content, ...extra } });
  }

  async updateSession(id: string, input: { plan?: { content: string; status: string }[]; addedExternalUrls?: { label: string; url: string }[] }): Promise<void> {
    await this.gql(`mutation($id: String!, $input: AgentSessionUpdateInput!) { agentSessionUpdate(id: $id, input: $input) { success } }`, { id, input: { ...(input.plan ? { plan: { entries: input.plan } } : {}), ...(input.addedExternalUrls ? { addedExternalUrls: input.addedExternalUrls } : {}) } });
  }

  /** A session of Friday's own on an issue: "Start work" in Friday shows on the issue too. */
  async sessionOnIssue(issueId: string): Promise<string | null> {
    const d = await this.gql<{ agentSessionCreateOnIssue: { agentSession?: { id: string } | null } }>(`mutation($issueId: String!) { agentSessionCreateOnIssue(input: { issueId: $issueId }) { agentSession { id } } }`, { issueId });
    return d.agentSessionCreateOnIssue.agentSession?.id ?? null;
  }

  /** The team's first "started" state, by position (Linear's own advice for an agent picking up work). */
  async startedState(teamId: string, type = "started"): Promise<string | null> {
    const d = await this.gql<{ team: { states: { nodes: { id: string; position: number }[] } } }>(`query($id: String!, $type: String!) { team(id: $id) { states(filter: { type: { eq: $type } }) { nodes { id position } } } }`, { id: teamId, type });
    return d.team.states.nodes.slice().sort((a, b) => a.position - b.position)[0]?.id ?? null;
  }

  async moveIssue(issueId: string, stateId: string): Promise<void> {
    await this.gql(`mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`, { id: issueId, stateId });
  }

  async setDelegate(issueId: string, appUserId: string): Promise<void> {
    await this.gql(`mutation($id: String!, $d: String!) { issueUpdate(id: $id, input: { delegateId: $d }) { success } }`, { id: issueId, d: appUserId });
  }

  /** The person's open issues, for the Issues tab. */
  async assigned(first = 50): Promise<LinearIssue[]> {
    const d = await this.gql<{ viewer: { assignedIssues: { nodes: LinearIssue[] } } }>(`query($first: Int) { viewer { assignedIssues(first: $first, filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { ${ISSUE} } } } }`, { first });
    return d.viewer.assignedIssues.nodes;
  }
}

// ── Linear's words into Friday's, and back ─────────────────────────────────────────────────────────────────────────────

/**
 * The task a new session gives Friday: the issue, what was asked of the agent, and how to report back. The issue's words are
 * fenced as someone else's (untrusted.ts), and so is the ask when it isn't the person at this computer's.
 */
export function sessionTask(s: LinearSession, asked: string, mine = true): string {
  const parts: string[] = [];
  const i = s.issue;
  if (i) parts.push(`Linear issue ${i.identifier}: ${i.title} (${i.url})`);
  if (asked.trim()) parts.push(mine ? asked.trim() : untrusted(`Linear, asked by ${s.creator?.name ?? "someone"}`, asked));
  if (i?.description?.trim()) parts.push(untrusted(`Linear issue ${i.identifier}`, i.description.slice(0, 6000)), UNTRUSTED_NOTE);
  parts.push("Work it through to a pull request when it changes code. Keep your plan updated as you go; it shows on the issue. When you need a decision, ask it as a question.");
  return parts.join("\n\n");
}

/** The ask that started a session: its first prompt activity, else the comment it was made from. */
export function firstAsk(s: LinearSession, acts: readonly LinearActivity[]): string {
  const p = acts.find((a) => a.content.type === "prompt" && a.content.body?.trim());
  return withoutAgentMention(p?.content.body ?? s.comment?.body ?? "");
}

/** "@friday please look" → "please look": the mention is how it was asked, not what. */
export function withoutAgentMention(text: string): string {
  return text.replace(/(^|\s)@[\w.-]+/g, (m, sp: string, off: number) => (off === 0 ? "" : sp)).replace(/\s+/g, " ").trim();
}

/**
 * What people said to the agent after `after` (an activity's createdAt, ISO), oldest first: each acted on once. A time rather
 * than an activity's id, so a long session whose last-read activity has left the window Linear returns still reads right.
 */
export function newPrompts(acts: readonly LinearActivity[], after: string | undefined): LinearActivity[] {
  return acts.filter((a) => a.content.type === "prompt" && (!after || a.createdAt > after));
}

/** The newest activity's time, for the next read's `after`. */
export const lastAt = (acts: readonly LinearActivity[], or = "") => acts.reduce((m, a) => (a.createdAt > m ? a.createdAt : m), or);

/** A plan tool's arguments as Linear's plan entries. */
export function planEntries(args: string): { content: string; status: string }[] | null {
  try {
    const a = JSON.parse(args) as Record<string, unknown>;
    const raw = [a.todos, a.plan, a.steps, a.items].find(Array.isArray) as unknown[] | undefined;
    if (!raw?.length) return null;
    return raw.slice(0, 40).flatMap((t) => {
      const o = (t && typeof t === "object" ? t : { content: t }) as Record<string, unknown>;
      const content = String(o.content ?? o.step ?? o.text ?? o.title ?? "").trim().slice(0, 200);
      if (!content) return [];
      const st = String(o.status ?? "").toLowerCase().replace(/[\s_-]/g, "");
      const status = st === "completed" || st === "done" ? "completed" : st === "inprogress" || st === "active" || st === "running" ? "inProgress" : st === "cancelled" || st === "canceled" || st === "skipped" ? "canceled" : "pending";
      return [{ content, status }];
    });
  } catch {
    return null;
  }
}
