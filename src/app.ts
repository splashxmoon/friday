import { CommandError, CommandRegistry } from "./commands.js";
import { TemplateError, TemplateRegistry } from "./templates-store.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import { fetchPreview, PREVIEW_FETCH_MS, previewHeadersFrom, previewLocation, previewOptions, previewStatus, previewTrouble, previewStatusLive, startPreview, stopPreview } from "./runner/preview.js";
import { closeSaying, heartbeat } from "./heartbeat.js";
import { PHONE_PAGE, phoneLog, phonePage } from "./phone-log.js";
import { lightener } from "./session/patches.js";
import { EARLIER_PIECE, slowly } from "./slow.js";
import { packJson, shellFor, shellRoute, withVary, type ShellRoute } from "./fast-load.js";
import { readdirSync, statSync, watch } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { EngineHub } from "./engine/hub.js";
import { callHost } from "./runner/local-api.js";
import { readRepo as readFolder } from "./runner/repo-read.js";
import { readFailed } from "./project-rules.js";
import { parseRepo } from "./runner/repo.js";
import { Runner } from "./runner/runner.js";
import { recentReposCached } from "./runner/workspace.js";
import { overlapsAcross, plannedOverlapsFor } from "./collisions.js";
import { EFFORT_LEVELS, ENGINE_NAMES, ENGINE_TOOLS, isEngineEffort, MAIN_LANE, toolList, type EngineMode, type EngineTool, type IssueRef, type Role, SESSION_GONE } from "./types.js";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import { ops } from "./ops.js";
import { WebSocket, WebSocketServer } from "ws";
import { fetchIssue, fetchPr, issueRef, parseIssueUrl, parsePrLink, prRef } from "./github-issue.js";
import { AutomationStore, cleanAutomation, describeWhen, describeWho, dueAutomation, promptFor as automationPrompt, WAIT_FOR_COMPUTER_MS, type Automation, type AutomationRun } from "./automations.js";
import { ProviderError, type LLM } from "./agent/llm.js";
import { OwnModelLLM } from "./agent/own-model.js";
import { isOwnModel, ownModelParts } from "./own-model-id.js";
import { AgentRuntime } from "./agent/runtime.js";
import { defaultTools, type AgentTool } from "./agent/tools.js";
import { SESSION_COOKIE, SESSION_MAX_AGE_S, clearSessionCookie, readCookie, sessionCookie, signActor, signInvite, signSession, verifyActor, verifyInvite, verifySession, signReplay, verifyReplay } from "./auth.js";
import { hideSecrets, hideSecretsIn } from "./secrets.js";
import { applyPrStatus, boardCards, sortCards, summaryOf, waitingOn, weekOf, type BoardCard, type SessionSummary } from "./board.js";
import { AgentMesh } from "./agent-mesh.js";
import { Hubs } from "./hubs.js";
import type { Limits } from "./runner/limits.js";
import type { MachineTool } from "./types.js";
import type { ToolOption, ToolWindow } from "./routing.js";
import { runawayIn } from "./runaway.js";
import { fromGh, fromGithubApi, rerequestReview, statusOf, type PrStatus } from "./github-status.js";
import { commitPaths, FRIDAY, fixMessage, fromPerson, MAX_CHECK_ROUNDS, prBranch, shepherdNext } from "./shepherd.js";
import { plainCommitMessage } from "./pr-body.js";
import { checksText, type CheckFailure } from "./pr-checks.js";
import { feedbackText, fromWriter, unseen, type PrComment } from "./pr-feedback.js";
import type { EventBody, ReviewFinding } from "./types.js";
import { attentionIn, crewOf, prOf, previewOf, sortAttention, workingIn, type Attention, type Crew, type Preview, type SessionPr, type Working } from "./attention.js";
import { Bus, DELTA_ORIGIN, type BusMessage } from "./bus.js";
import { cleanFocus } from "./focus.js";
import { startMockFocus } from "./mock-focus.js";
import { threadsToSettle } from "./threads.js";
import { clientBuildOptions } from "./client-build.js";
import { SkillRegistry } from "./skills.js";
import type { SkillBrief } from "./types.js";
import { discoverSkills, importChosen, importWholeRepo } from "./skill-import.js";
import { FileStore, MAX_FILE_BYTES, isUsableFile, resolveAttachments } from "./files.js";
import { publicAccount, type Account, type Provider } from "./identity-types.js";
import { LOCAL_WORKSPACE, localAccount } from "./local/identity.js";

/** What the rest of the app asks of the accounts store: the Redis one and the SQL one both answer it. */
import type { Plan, Workspace, WorkspaceRole } from "./workspace-types.js";
import { ToolUsage } from "./tool-usage.js";
import { rankOf, searchEvents, titleMatches, wordsOf } from "./session-search.js";
import { pointBridge } from "./client/point.js";
import type { Attachment, Thinking } from "./types.js";
import { laneName, SessionCore, type Command } from "./session/core.js";
import { buildDigest } from "./session/digest.js";
import { can, canDriveLane, driverOf, pendingFor, project, roleOf, runOf, type SessionState } from "./session/projection.js";
import { SessionStore, WorkspaceClosing } from "./session/store.js";
import type { ImportedTurn, Member, PresenceMember, RepoCall, SessionEvent } from "./types.js";
import { NoLinks } from "./local/no-links.js";
import { handOff } from "./hand-off-run.js";
import { reattachAll } from "./reattach.js";
import { Strengths } from "./strengths.js";
import { attachmentsIn, MAX_FOLDER_ARCHIVE, uploadsMayRun, UploadedFolders } from "./uploaded.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// Resolved once: the traversal guard in serveStatic compares against this with
// path.sep, so a relative or forward-slashed PUBLIC_DIR would never match.
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR ?? path.join(here, "..", "public"));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".png": "image/png",
};

// ── sending the app's own files ──────────────────────────────────────
// The client bundle is a megabyte and a half and the stylesheet half a megabyte more; sent as they are, every first load was
// two megabytes over the wire and every reload sent them again. So they are compressed (once, then remembered), given a
// validator so a reload costs a "not modified", and cached for good when the name carries a hash.
const compressors = { br: promisify(brotliCompress), gzip: promisify(gzip) };
const COMPRESSIBLE = /^(text\/|application\/(javascript|json)|image\/svg)/;
const packed = new Map<string, Promise<{ out: Buffer; etag: string }>>();
/**
 * Which build a bundled file came from, for its key in `packed`: a hot rebuild makes new files under the same names (app.js),
 * and keyed by path alone the first build's app.js was served beside the new build's chunks, which 404'd (2026-10-19).
 */
const bodyIds = new WeakMap<Uint8Array, number>();
let nextBodyId = 0;
const bodyId = (b: Uint8Array): number => {
  let id = bodyIds.get(b);
  if (id === undefined) bodyIds.set(b, (id = ++nextBodyId));
  return id;
};

/** `br`: the file already packed at the build (scripts/build-desktop.ts), smaller than packing it here would make it. */
export async function sendAsset(req: http.IncomingMessage, res: http.ServerResponse, key: string, body: Uint8Array, type: string, cache: string, br?: Uint8Array) {
  const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const accept = String(req.headers["accept-encoding"] ?? "");
  const enc = COMPRESSIBLE.test(type) && buf.length > 1024 ? (/\bbr\b/.test(accept) ? "br" : /\bgzip\b/.test(accept) ? "gzip" : "") : "";
  const id = `${key}|${enc}`;
  let entry = packed.get(id);
  if (!entry) {
    entry = (async () => {
      const out = enc === "br" && br ? Buffer.from(br.buffer, br.byteOffset, br.byteLength) : enc === "br" ? await compressors.br(buf, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.length } }) : enc === "gzip" ? await compressors.gzip(buf, { level: 9 }) : buf;
      return { out, etag: `"${createHash("sha1").update(out).digest("base64url").slice(0, 22)}"` };
    })();
    packed.set(id, entry);
  }
  const { out, etag } = await entry;
  const head = { "Content-Type": type, "Cache-Control": cache, ETag: etag, Vary: "Accept-Encoding", ...(enc ? { "Content-Encoding": enc } : {}) };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, head);
    return res.end();
  }
  res.writeHead(200, { ...head, "Content-Length": out.length });
  res.end(req.method === "HEAD" ? undefined : out);
}

// ── client bundle ────────────────────────────────────────────────────
// Built once per process, in memory, code-split so heavy pieces (syntax
// highlighting, math) load only when used. A packaged desktop build points
// CLIENT_DIR at a prebuilt copy instead.
type Bundle = Map<string, { body: Uint8Array; type: string; br?: Uint8Array }>;
let clientBundle: Promise<Bundle> | null = null;

/** A real listing from a folder, as opposed to a sentence about why there isn't one. */
const TREE_LISTING = /^\d+ files under /;
/** What the browser may ask a folder directly: questions, never changes. */
/** A preview link lasts six hours unused, and twelve at most however much it is used. */
const PREVIEW_TICKET_IDLE_MS = 6 * 60 * 60_000;
const PREVIEW_TICKET_MAX_MS = 12 * 60 * 60_000;
const READ_OPS = new Set(["tree", "read", "branches", "remote", "commands", "environment", "context", "status", "log", "show", "gitdiff", "compare"]);

/**
 * Developing (hot), every hashed chunk any build in this process made: a page that loaded app.js just before a rebuild asks
 * for that build's chunks afterwards, and with several people saving at once they were gone, so the page came up blank
 * (2026-10-19). A hashed chunk never changes, so keeping it is always right.
 */
const hotChunks = new Map<string, { body: Uint8Array; type: string; br?: Uint8Array }>();

export function bundleClient(): Promise<Bundle> {
  if (!clientBundle) build = null;
  if (!clientBundle) {
    clientBundle = process.env.CLIENT_DIR ? loadPrebuilt(process.env.CLIENT_DIR) : buildClient();
    if (process.env.FRIDAY_HOT === "1")
      void clientBundle.then((b) => {
        for (const [k, v] of b) if (k.startsWith("/chunks/")) hotChunks.set(k, v);
      }, () => {});
  }
  return clientBundle;
}

/**
 * Which client this server hands out: a fingerprint of the script and the stylesheet, so it changes exactly when a deploy
 * changes what people see, and not when the server merely restarts. An open window (the desktop app stays open for days)
 * asks for it now and then, and reloads onto a new one (buildWatch.ts) instead of running yesterday's interface until it
 * is quit: interface changes reach the desktop app with a deploy, with no new desktop version.
 */
let build: Promise<string> | null = null;
export function buildId(): Promise<string> {
  build ??= (async () => {
    const b = await bundleClient();
    const h = createHash("sha1");
    // Every file whose name stays the same between builds (app.js, app.css): a hashed chunk only changes when one of these does.
    for (const [name, a] of [...b].sort(([x], [y]) => x.localeCompare(y))) if (!name.startsWith("/chunks/") && !name.startsWith("/assets/")) h.update(name).update(a.body);
    for (const css of ["style.css", "tailwind.css"]) h.update(await readFile(path.join(PUBLIC_DIR, css)).catch(() => Buffer.alloc(0)));
    return h.digest("base64url").slice(0, 12);
  })();
  return build;
}

async function buildClient(): Promise<Bundle> {
  // Imported lazily: a packaged desktop build serves a prebuilt client and ships without esbuild.
  const { build } = await import("esbuild");
  const r = await build(clientBuildOptions("/bundle", false));
  const out: Bundle = new Map();
  for (const f of r.outputFiles ?? []) {
    const posix = f.path.split(path.sep).join("/");
    const rel = posix.slice(posix.indexOf("/bundle/") + "/bundle".length);
    out.set(rel, { body: f.contents, type: TYPES[path.extname(rel)] ?? "application/octet-stream" });
  }
  if (!out.has("/app.css")) out.set("/app.css", { body: new Uint8Array(), type: TYPES[".css"]! });
  return out;
}

/** A built client on disk: each file, with its Brotli copy (`<file>.br`, made by the build) beside it when there is one. */
export async function loadPrebuilt(dir: string): Promise<Bundle> {
  const out: Bundle = new Map();
  const packedCopies = new Map<string, Uint8Array>();
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = "/" + path.relative(dir, p).split(path.sep).join("/");
      if (e.isDirectory()) await walk(p);
      else if (rel.endsWith(".br")) packedCopies.set(rel.slice(0, -3), await readFile(p));
      else out.set(rel, { body: await readFile(p), type: TYPES[path.extname(p)] ?? "application/octet-stream" });
    }
  };
  await walk(dir);
  for (const [rel, br] of packedCopies) {
    const f = out.get(rel);
    if (f) f.br = br;
  }
  if (!out.has("/app.css")) out.set("/app.css", { body: new Uint8Array(), type: TYPES[".css"]! });
  return out;
}

export interface AppOptions {
  port: number;
  redisUrl: string;
  prefix: string;
  secret: string;
  llm: LLM;
  tools?: AgentTool[];
  driverGraceMs: number;
  /** Where attachments are stored. */
  dataDir?: string;
  /**
   * Public base URL, used as the OAuth redirect target when connecting an MCP
   * server. Set it to the deployed origin, or a provider will send people back
   * to a localhost that isn't theirs.
   */
  appUrl?: string;
  /**
   * Where previews are served: another site than appUrl (server.ts: PREVIEW_ORIGIN, else Render's own address), so a
   * previewed page never runs on Friday's origin and never gets the watching person's cookie. Unset: on this address, as before.
   */
  previewOrigin?: string;
  /**
   * The open-source edition (src/local/main.ts): one person on their own computer, nothing hosted. Its Redis is in this process
   * (local/kv.ts); everyone is `user`, with no sign-in; the server listens on this computer only and answers only its own pages
   * (localOnly); and the client is the local one (client-build.ts).
   */
  local?: { redis: Redis; sub: Redis; user: { id: string; name: string } };
}

export type App = Awaited<ReturnType<typeof createApp>>;


export async function createApp(o: AppOptions) {
  // Patient while starting, quick once up. Starting, a command waits through ioredis's usual twenty reconnect attempts, as the
  // start's own steps need Redis and a server that gave up on them exited (08fedc5 did, deployed while Redis was down). Once
  // Redis has answered, a command fails within about a second when it goes away (restarting, out of memory), so a request says
  // "try again" at once instead of hanging for 10 to 40 seconds (2026-10-20: the phone's sign-in sat on "Preparing a code…"
  // while the free Redis restarted). ioredis reads the limit at each reconnect, so it can change once the first one is in.
  const rawRedis = o.local?.redis ?? new Redis(o.redisUrl, { connectTimeout: 5_000 });
  const sub = o.local?.sub ?? new Redis(o.redisUrl, { connectTimeout: 5_000 });
  for (const client of [rawRedis, sub]) client.once("ready", () => void (client.options.maxRetriesPerRequest = 6));
  const redis = rawRedis;
  let redisDown = false;
  for (const conn of [redis, sub]) {
    conn.on("error", (err: Error) => {
      if (!redisDown) console.error(`[redis] ${err.message}. Is Redis running at ${o.redisUrl}?`);
      redisDown = true;
    });
    conn.on("ready", () => (redisDown = false));
  }
  const archive = null;
  const store = new SessionStore(redis, o.prefix, undefined, archive);
  /** A write that landed after Redis was closed (the app shutting down) is nothing to report; anything else is. */
  const closingOr = (where: string, e: unknown) => {
    if (!/Connection is closed/i.test(String(e))) console.error(where, e);
  };
  // A review comment sent to an agent is answered when that agent's run ends having changed the file it was about.
  store.onRunEnded = (sid, lane) => {
    void (async () => {
      const [events, state] = await Promise.all([store.events(sid), store.state(sid)]);
      for (const id of threadsToSettle(events, state.threads, lane)) await store.append(sid, { id: "system", name: "System", kind: "system" }, { type: "thread.resolved", id, auto: { lane } });
    })().catch((e) => closingOr("[threads]", e));
    // A hub's task, or the main lane's conflict work for one (hubs.ts): the hub moves on.
    void hubs.onRunEnded(sid, lane).catch((e) => closingOr("[hub]", e));
    // A question another agent asked this one, answered with what it said last (agent-mesh.ts).
    void mesh.onRunEnded(sid, lane).catch((e) => closingOr("[mesh]", e));
  };
  const bus = new Bus(redis, sub, o.prefix);
  // Pub/sub messages published while the subscriber connection was down are gone: once it is back (ioredis has sent its
  // SUBSCRIBEs; the PING is answered after them), every open socket is sent the log after the last event it has.
  const resyncs = new Set<() => void>();
  let subLost = false;
  sub.on("close", () => (subLost = true));
  sub.on("ready", () => {
    if (!subLost) return;
    subLost = false;
    void sub
      .ping()
      .catch(() => {})
      .then(() => resyncs.forEach((r) => r()));
  });
  // Signed at the version its link has now, so "Replace link" also stops an owner link someone copied (admit). An owner's is the editor link's.
  const linkToken = (sid: string, state: SessionState, role: Role) => signInvite(o.secret, sid, role, state.links[role === "owner" ? "editor" : role].version);

  const guardRunaway = async (sid: string, lane: string) => {
    const [state, events] = await Promise.all([store.state(sid), store.events(sid)]);
    const run = lane === MAIN_LANE ? state.run : state.laneRuns[lane];
    if (run?.status !== "running") return;
    const loop = runawayIn(events, lane);
    if (!loop) return;
    const start = events.findLast((e) => (e.lane ?? MAIN_LANE) === lane && (e.body.type === "run.started" || e.body.type === "run.resume"))?.seq ?? 0;
    if (!(await redis.set(`${o.prefix}runaway:${sid}:${lane}:${start}`, "1", "EX", 86_400, "NX"))) return;
    await store.append(sid, FRIDAY, { type: "run.guarded", command: loop.command, times: loop.times, kind: loop.kind }, { lane });
    await store.append(sid, FRIDAY, { type: "run.pause" }, { lane });
  };


  /** Automations hearing a session's events (set below, once the automations are). */
  let automationsHear: ((sid: string, ev: Pick<SessionEvent, "lane" | "body">) => void) | null = null;
  store.onAppended = (sid, ev) => {
    // A plan naming a file another agent is on: said in the feed now, before either writes it (collisions.ts plannedOverlapsFor).
    if (ev.body.type === "agent.message" && ev.body.toolCalls.some((c) => c.name === "update_plan" || c.name === "todo" || c.name === "TodoWrite")) {
      void (async () => {
        const lane = ev.lane ?? MAIN_LANE;
        const state = await store.state(sid);
        for (const ov of plannedOverlapsFor(state, lane).slice(0, 3)) {
          // Once per agent and file, however often the plan is revised.
          if (!(await redis.set(`${o.prefix}overlap:${sid}:${lane}:${ov.path}`, "1", "EX", 6 * 3600, "NX"))) continue;
          await store.append(sid, FRIDAY, { type: "files.overlap", lane, path: ov.path, with: ov.with }, { lane });
        }
      })().catch((e) => console.error("[overlap]", e));
    }
    if (ev.body.type === "tool.result" && ev.body.isError && (ev.body.name === "shell" || ev.body.name === "run_command")) void guardRunaway(sid, ev.lane ?? MAIN_LANE).catch((e) => console.error("[runaway]", e));
    // A board task settled: what its tool is good at learns from it (strengths.ts).
    if (ev.body.type === "board.reviewed" || ev.body.type === "board.finished") void mesh.learnSkill(sid, ev.body).catch((e) => closingOr("[strengths]", e));
    // An agent's change to a file another agent holds (claim_files): it is told at once (agent-mesh onDiff).
    if (ev.body.type === "agent.diff") void mesh.onDiff(sid, ev.lane ?? MAIN_LANE).catch((e) => closingOr("[holds]", e));
    // Which sessions have a pull request to see through: kept as a set, so the loop looks only at those.
    if (ev.body.type === "resume.scheduled") void redis.zadd(RESUMES, ev.body.at, `${sid} ${ev.lane ?? MAIN_LANE} ${ev.seq}`).catch(() => {});
    // An agent to wake at a time (wake_me_when, or Friday's own from a turn that ended waiting): kept by time, as resumes are.
    if (ev.body.type === "wake.set" && ev.body.on.at) void redis.zadd(WAKES, ev.body.on.at, `${sid} ${ev.body.id}`).catch(() => {});
    // A board task landing wakes whoever waits on it.
    if (ev.body.type === "board.reviewed" || ev.body.type === "board.finished") void mesh.wakeOnTask(sid, ev.body.id).catch((e) => closingOr("[wake]", e));
    if (ev.body.type === "pr.shepherd") void (ev.body.on ? redis.sadd(SHEPHERDS, sid) : redis.srem(SHEPHERDS, sid)).catch(() => {});
    // A task board being worked on, looked over now and then for a task nobody is doing (boardLoop); and an agent's computer
    // going away hands its board work to someone else at once.
    if (ev.body.type === "board.posted") void redis.sadd(BOARDS, sid).catch(() => {});
    if (ev.body.type === "engine.detached") void mesh.onEngineGone(sid, ev.lane ?? MAIN_LANE).catch((e) => closingOr("[board]", e));
    // A Stop ends the agent's task, not the agent: what other agents were waiting on from it is answered, and it is free again.
    else if (ev.body.type === "run.pause" || ev.body.type === "run.cancel") void mesh.onRunStopped(sid, ev.lane ?? MAIN_LANE, ev.actor.name, ev.body.type === "run.cancel").catch((e) => closingOr("[mesh]", e));
    else if (ev.body.type === "pr.shepherd.ended") void redis.srem(SHEPHERDS, sid).catch(() => {});
    const b = ev.body;
    // A wheel handed to somebody with no page open (a yield to an offline teammate, a resume or schedule sent as its setter):
    // it comes back after the grace like any driver's who left, instead of the agent waiting on a person who isn't there.
    if (b.type === "control.granted") {
      const to = b.to;
      void store.presence(sid).then((on) => { if (!((on[to] ?? 0) > 0)) scheduleHandoff(sid, to, ev.lane ?? MAIN_LANE); }).catch(() => {});
    }
    // A driver with no page open kept the wheel only because their own coding tool was connected; once it goes, so does the wheel.
    if (b.type === "engine.detached") {
      const lane = ev.lane ?? MAIN_LANE;
      void Promise.all([store.state(sid), store.presence(sid)]).then(([state, on]) => {
        const d = driverOf(state, lane);
        if (d?.id && !((on[d.id] ?? 0) > 0)) scheduleHandoff(sid, d.id, lane);
      }).catch(() => {});
    }
  };
  await bus.start();
  const files = new FileStore(o.dataDir ?? process.env.DATA_DIR ?? path.join(process.cwd(), "data", "uploads"));
  // Uploaded folders are unpacked beside the blobs they came from: same
  // lifetime, same place to look when a deployment wants to clear either.
  const uploaded = new UploadedFolders(files, path.join(o.dataDir ?? process.env.DATA_DIR ?? path.join(process.cwd(), "data", "uploads"), "folders"));
  const toolUsage = new ToolUsage(redis, o.prefix);
  // Detail written while it was kept 400 days, brought down to the hundred it is kept now. In the background: never holds up a start.
  void toolUsage.capDetail().catch(() => {});


  /**
   * A workspace's own registries.
   *
   * Kept rather than rebuilt because the MCP one holds live connections: a new
   * instance per request would reconnect to every server on every page load.
   */
  interface Tenant {
    skills: SkillRegistry;
  commands: CommandRegistry;
    templates: TemplateRegistry;
  }
  const tenants = new Map<string, Tenant>();
  function tenant(workspaceId: string): Tenant {
    let t = tenants.get(workspaceId);
    if (!t) {
      const p = `${o.prefix}ws:${workspaceId}:`;
      // Agents resolve their skills through this registry, so it exists first.
      const skills = new SkillRegistry(redis, p);
      t = {
        skills,
        commands: new CommandRegistry(redis, p),
        templates: new TemplateRegistry(redis, p),
      };
      tenants.set(workspaceId, t);
    }
    return t;
  }
  const boardCache = new Map<string, { cards: BoardCard[]; week: ReturnType<typeof weekOf> }>();
  /** A session's board cards for this person, remembered until its log moves on. */
  const cardsFor = async (state: SessionState, meId: string) => {
    const key = `${state.id}|${meId}|${state.lastSeq}`;
    let made = boardCache.get(key);
    if (!made) {
      const events = await store.events(state.id);
      made = { cards: boardCards(state, events, meId), week: weekOf(events) };
      boardCache.set(key, made);
      if (boardCache.size > 600) boardCache.delete(boardCache.keys().next().value!);
    }
    return made;
  };
  const prCache = new Map<string, { at: number; status: PrStatus | null }>();
  /**
   * Where a card's pull request stands on GitHub. Two ways to ask, each the other's backup: GitHub's API with the workspace's
   * GitHub connection, then `gh` on the machine linked to the session. Remembered for a minute (half that when nobody could
   * answer), so a board polled every few seconds does not become a request to GitHub every few seconds.
   */
  const prStatusFor = async (sid: string, lane: string, workspaceId: string, url: string): Promise<PrStatus | null> => {
    const key = `${workspaceId}|${url}`;
    const hit = prCache.get(key);
    if (hit && Date.now() - hit.at < (hit.status ? 60_000 : 30_000)) return hit.status;
    const status = await statusOf([
      async () => {
        const r = await Promise.race([openFolder(sid, { op: "prstatus", query: url }, lane), new Promise<null>((done) => setTimeout(() => done(null), 8000).unref?.())]);
        try {
          return r ? fromGh(JSON.parse(r.output)) : null;
        } catch {
          return null;
        }
      },
    ]);
    prCache.set(key, { at: Date.now(), status });
    if (prCache.size > 400) prCache.delete(prCache.keys().next().value!);
    return status;
  };
  /** The same, for a response somebody is waiting on: a slow GitHub or `gh` costs the answer its PR status, never its speed. */
  const prStatusSoon = (sid: string, lane: string, workspaceId: string, url: string): Promise<PrStatus | null> =>
    Promise.race([prStatusFor(sid, lane, workspaceId, url).catch(() => null), new Promise<null>((done) => setTimeout(() => done(null), 1200).unref?.())]);
  const sessionsAfter = async (_uid: string) => 0;
  const runnersOnline = new Map<WebSocket, string>();
  /** The open-source edition's one person (local/identity.ts), by the name they gave themselves in Settings, if they did. */
  const localNamed = async () => localAccount({ id: o.local!.user.id, name: (await redis.get(`${o.prefix}local:name`).catch(() => null)) || o.local!.user.name });
  const identity: (req: http.IncomingMessage) => Promise<Account | null> =
    // The open-source edition: the person at this computer, always.
    localNamed;
  /**
   * Who is asking, and whose workspace they are in. Everything scoped hangs
   * off this: a person with no membership of a workspace never gets its
   * registries, because they never get its id.
   */
  async function context(req: http.IncomingMessage): Promise<{ me: Account; workspace: Workspace; t: Tenant } | null> {
    const me = await identity(req);
    if (!me) return null;
    // The open-source edition has the one workspace, on Solo (local/identity.ts).
    return { me, workspace: LOCAL_WORKSPACE, t: tenant(LOCAL_WORKSPACE.id) };
  }
  // Scan for the person's repos now, so the first time someone opens the
  // workspace picker the list is already there.
  void recentReposCached().catch(() => {});
  /**
   * The folder this session works in, wherever it is.
   *
   * A machine someone linked, first: the work lands in their own checkout and
   * commands can actually run. Failing that, a folder somebody uploaded, which
   * is a real working copy on our side — read, searched and edited by the same
   * tools. Only if there is neither is there nothing to look at, and then the
   * answer says what to do about it.
   */
  /**
   * The tree for people looking at the session, as opposed to the agent.
   * An agent must never be told a folder is there when it isn't; a person
   * looking at the panel is better served by the last listing, labelled.
   */
  /**
   * The branch the folder is really on, from a listing of its branches.
   *
   * The session learns a folder's branch when an agent attaches and when somebody switches or commits through it; an agent's
   * own `git switch`, or one in a terminal, moved the folder without a word and every pill went on naming the old branch. A
   * listing that finds it elsewhere records the move, so the whole room sees the branch the files are actually on.
   */
  const noteBranch = async (sid: string, lane: string | undefined, output: string) => {
    const current = (() => { try { return (JSON.parse(output) as { current?: string }).current ?? ""; } catch { return ""; } })();
    if (!current) return;
    const state = await store.state(sid);
    const at = lane && state.engines[lane] ? lane : state.engines[MAIN_LANE] ? MAIN_LANE : Object.keys(state.engines)[0];
    const e = at ? state.engines[at] : undefined;
    if (!at || !e || e.branch === current) return;
    await store.append(sid, FRIDAY, { type: "folder.switched", branch: current, from: e.branch ?? "", noticed: true }, { lane: at });
  };
  const folderForPeople = async (sid: string, req: RepoCall, lane?: string): Promise<{ output: string; where?: { host: string; cwd: string; branch?: string } }> => {
    const r = await openFolder(sid, req, lane);
    // The last listing a folder gave, kept so the tree survives its machine
    // going to sleep, disconnecting, or the server restarting. Without it,
    // coming back to a session showed an empty tree, because the answer to
    // "what's in the folder" had become "nobody is connected".
    if (req.op !== "tree" || req.path) return r;
    const key = `${o.prefix}tree:${sid}${lane && lane !== "main" ? `:${lane}` : ""}`;
    if (TREE_LISTING.test(r.output)) {
      void redis.set(key, JSON.stringify({ output: r.output, where: r.where, at: Date.now() }), "EX", 60 * 60 * 24 * 30).catch(() => {});
      return r;
    }
    const kept = await redis.get(key).catch(() => null);
    if (!kept) return r;
    const k = JSON.parse(kept) as { output: string; where?: { host: string; cwd: string; branch?: string }; at: number };
    // A mock dataset (prefix "mock…", seeded for design work) has no machine to be connected, so it would carry this notice forever.
    if (o.prefix.startsWith("mock")) return { output: k.output, ...(k.where ? { where: k.where } : {}) };
    return { output: k.output, ...(k.where ? { where: k.where } : {}), stale: { at: k.at, reason: "the machine it lives on isn't connected right now" } } as { output: string; where?: { host: string; cwd: string; branch?: string } };
  };
  /**
   * Whether a link token lets this request drive the machine behind it. The link belongs to the account that made it: a
   * token on its own (copied out of a browser, or left in a shared one) drives nobody's machine, so the caller has to be
   * signed in as the link's owner. "anon" is a token with nobody signed in, "other" a token that is somebody else's.
   */
  const linkedFor = async (req: http.IncomingMessage, token: string): Promise<"yes" | "no" | "anon" | "other"> => {
    if (!token || !links.connected(token)) return "no";
    const [owner, who] = await Promise.all([links.owner(token), identity(req)]);
    if (!owner) return "no";
    return !who ? "anon" : who.id === owner.id ? "yes" : "other";
  };
  /**
   * One of this person's always-on machines, when the page names one (x-friday-machine): its link, looked up here and
   * never sent by the page. Nothing named, nothing to say (the page's own link is used).
   */
  const pickedMachine = async (req: http.IncomingMessage): Promise<{ token?: string } | { error: string; status: number }> => {
    const id = str(req.headers["x-friday-machine"], 20);
    if (!id) return {};
    const who = await identity(req);
    const m = who ? await links.machineToken(who.id, id) : null;
    if (!m) return { error: "That machine isn't one of yours any more. Pick another in Settings › Computer.", status: 403 };
    if (!links.connected(m.token)) return { error: `${m.label} isn't connected. Start Friday's runner on it again, or pick another machine in Settings › Computer.`, status: 503 };
    return { token: m.token };
  };
  const linkRefusal = (link: "yes" | "no" | "anon" | "other"): string | null =>
    link === "anon" ? "Sign in to use the linked machine." : link === "other" ? "This machine is linked to another account. Sign in as that account, or link it again from this one." : null;

  const openFolder = async (sid: string, req: RepoCall, lane?: string, by?: string): Promise<{ output: string; where?: { host: string; cwd: string; branch?: string } }> => {
    const live = await hub.readRepo(sid, req, lane, by);
    if (live) return live;
    // An uploaded folder is on Friday's server, nobody's own machine: its .env shows names only, to everyone.
    const { person: _person, personId: _personId, ...shared } = req;
    req = shared;
    const up = await uploaded.read(sid, attachmentsIn(await store.events(sid)), req).catch(() => null);
    if (up) return up;
    // A mock dataset has no machine to ask, but its folders are on this disk: read them directly, for looking only.
    if (o.prefix.startsWith("mock")) {
      const st = await store.state(sid);
      const e = (lane ? st.engines[lane] : undefined) ?? Object.values(st.engines).find((x) => x.cwd);
      if (e?.cwd) {
        const out = await readFolder(e.cwd, { ...req, mode: "plan" }).catch(() => null);
        if (out !== null) return { output: out, where: { host: e.hostName, cwd: e.cwd, ...(e.branch ? { branch: e.branch } : {}) } };
      }
    }
    return {
      output:
        "This session has no folder yet. Attach one with the folder button in the composer and it becomes a working copy you can read, search and edit — or connect a machine from the session header to work in a checkout there, which also allows running commands.",
    };
  };
  // No model of Friday's own (o.llm says so), only yours, set up in Settings › Your models and called from this computer.
  const llm: LLM = new OwnModelLLM(o.llm, (userId, method, params, onProgress) => callHost(method, params, { serverUrl: selfUrl, user: { id: userId, name: "" }, runners: localRunners, progress: onProgress }));
  // The agents in a session talking to each other (agent-mesh.ts): coding tools through their runner, Friday Code directly. A
  // coding tool's hand_off is Friday Code's own, so the same lane rules and bounce limit hold for both.
  const mesh = new AgentMesh(store, bus, (sid, from, req) => handOff(store, bus, sid, from, req));
  // Friday Code, only ever on one of your own models: nothing metered, and no skills, memory, hubs or other sessions to reach.
  const runtime = new AgentRuntime(store, bus, llm, o.tools ?? defaultTools, { mesh, readRepo: openFolder, resolveFiles: (sid, atts) => resolveAttachments(files, sid, atts), works: (s) => isOwnModel(s.options.model) });
  /** Only a model of your own, and only chosen by you: there is nothing else for Friday Code to run on here. */
  const allowedModel = async (_workspaceId: string, model: string, actorId?: string): Promise<string> => (isOwnModel(model) && ownModelParts(model)?.owner === actorId ? model : "");


  /**
   * Seeing pull requests through to merge. About once a minute, for each session whose pull request a person handed over:
   * where does it stand, and what is the next thing to do. One node acts on a session at a time.
   */
  const SHEPHERDS = `${o.prefix}shepherds`;
  const BOARDS = `${o.prefix}boards`;
  const RESUMES = `${o.prefix}resumes`;
  const WAKES = `${o.prefix}wakes`;
  const asJson = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  async function shepherdOnce(sid: string, now: number): Promise<string> {
    const [state, events] = await Promise.all([store.state(sid), store.events(sid)]);
    const watch = state.shepherd;
    if (!watch) {
      await redis.srem(SHEPHERDS, sid);
      return "off";
    }
    const lane = watch.lane;
    // A fresh look every time: the cache is for pages, and this loop is the one thing that must see a push land.
    prCache.delete(`${state.workspaceId}|${watch.prUrl}`);
    const status = await prStatusFor(sid, lane, state.workspaceId, watch.prUrl).catch(() => null);
    const act = shepherdNext(state, events, status, now, { reviewer: false });
    const say = (body: EventBody) => store.append(sid, FRIDAY, body, { lane });
    switch (act.kind) {
      case "wait":
        return `wait: ${act.why}`;
      case "end":
        await say({ type: "pr.shepherd.ended", outcome: act.outcome, text: act.text });
        return act.outcome;
      case "push": {
        const message = fixMessage(act.reason);
        // Only the files the agent's last diff named: the person's own unfinished work in the same folder, and anything
        // else lying there, is not Friday's to push to a pull request.
        const only = commitPaths(state.diffs[lane]?.files ?? [], state.diffs[lane]?.more);
        if (!only.length) {
          await say({ type: "pr.shepherd.ended", outcome: "stopped", text: "Friday found nothing of the agent's to commit. A person needs to look." });
          return "stopped";
        }
        // The commit and the push go to whatever branch the folder is on, which somebody may have changed since the pull
        // request was opened: a fix for it is pushed from its own branch or not at all.
        const want = prBranch(state, events, watch.prUrl);
        const on = (asJson((await openFolder(sid, { op: "remote" }, lane)).output) as { branch?: string } | null)?.branch ?? "";
        if (!want || on !== want) {
          const text = !want
            ? "Friday can't tell which branch the pull request is on, so it didn't commit the fix. A person needs to look."
            : `The folder is on ${on || "no branch"} now, not ${want}, the pull request's branch, so Friday didn't commit the fix there. Switch back to ${want}, then hand the pull request over again.`;
          await say({ type: "pr.shepherd.ended", outcome: "stopped", text });
          return "stopped";
        }
        const c = asJson((await openFolder(sid, { op: "commit", message, only }, lane)).output) as { sha?: string; branch?: string; files?: number; error?: string } | null;
        if (!c?.sha) {
          await say({ type: "pr.shepherd.ended", outcome: "stopped", text: `Friday couldn't commit the fix${c?.error ? `: ${c.error}` : ""}. A person needs to look.` });
          return "stopped";
        }
        // Pushed to the branch the pull request is on; the pull request itself is already there. The person who turned the
        // shepherd on allowed its pushes, so a Manual machine pushes too, when it was its host who did (see hub.readRepo).
        const by = events.find((e) => e.seq === watch.since)?.actor.id;
        const said = (await openFolder(sid, { op: "publish", message, pr: false, approved: true, ...(by ? { approvedBy: by } : {}) }, lane)).output;
        const p = asJson(said) as { pushed?: boolean; error?: string } | null;
        await say({ type: "folder.committed", sha: c.sha, branch: c.branch ?? "", message, files: c.files ?? 0, ...(p?.pushed ? { pushed: true } : { error: p?.error ?? (!p && said ? said.slice(0, 500) : "Committed, but it couldn't be pushed.") }) });
        if (!p?.pushed) {
          await say({ type: "pr.shepherd.ended", outcome: "stopped", text: `Friday committed the fix but couldn't push it${p?.error ? `: ${p.error}` : ""}. A person needs to look.` });
          return "stopped";
        }
        await say({ type: "pr.shepherd.step", step: "pushed", sha: c.sha, text: `Pushed the fix (${c.sha.slice(0, 7)}). Waiting for the checks.` });
        return "pushed";
      }
      case "checks": {
        const got = asJson((await openFolder(sid, { op: "prchecks", query: watch.prUrl }, lane)).output) as { failures?: CheckFailure[]; error?: string } | null;
        if (!got?.failures?.length) return "wait: no failure could be read";
        const n = got.failures.length;
        const names = got.failures.map((f) => f.name).slice(0, 3).join(", ");
        // The step first, then the work: everything the agent does after it is the answer to it.
        await say({ type: "pr.shepherd.step", step: "checks", count: n, text: `${n} check${n === 1 ? "" : "s"} failed (${names}). Handed to the agent, round ${act.round} of ${MAX_CHECK_ROUNDS}.` });
        const said = await say({ type: "instruction", text: checksText(got.failures, watch.prUrl), interrupt: false });
        if (said.ok) void bus.wake(sid, lane);
        return "checks";
      }
      case "comments": {
        const got = asJson((await openFolder(sid, { op: "prcomments", query: watch.prUrl }, lane)).output) as { comments?: PrComment[] } | null;
        if (!got?.comments) return "wait: comments couldn't be read";
        const seen = events.flatMap((e) => (e.body.type === "pr.feedback" ? e.body.ids : []));
        // A bot's report or a bare approval is not something to work on.
        const fresh = unseen(got.comments, seen).filter((c) => fromPerson(c.author) && !(c.kind === "review" && c.state === "APPROVED" && !c.body));
        if (!fresh.length) return "wait: nothing new";
        // Only people who can write to the repo are passed on; the rest are marked seen and said, so they aren't raised again.
        const send = fresh.filter(fromWriter);
        const held = fresh.length - send.length;
        if (!send.length) {
          await say({ type: "pr.feedback", prUrl: watch.prUrl, ids: fresh.map((c) => c.id), count: 0, held });
          return "wait: nothing from people who can write to the repo";
        }
        const who = [...new Set(send.map((c) => c.author))];
        const n = send.length;
        await say({ type: "pr.shepherd.step", step: "comments", count: n, who, text: `${n} new review comment${n === 1 ? "" : "s"} from ${who.join(", ")}. Handed to the agent.` });
        await say({ type: "pr.feedback", prUrl: watch.prUrl, ids: fresh.map((c) => c.id), count: n, ...(held ? { held } : {}) });
        const said = await say({ type: "instruction", text: feedbackText(send, watch.prUrl), interrupt: false });
        if (said.ok) void bus.wake(sid, lane);
        return "comments";
      }
    }
  }
  // One pass at a time per pull request, in this process and across servers. A pass can run for minutes (gh reading
  // logs, a commit, a push), longer than a tick: when the lock was shorter than that, a second pass started on the same
  // pull request and handed the agent the same failure twice.
  const shepherding = new Set<string>();
  // When the pull request can't be read (GitHub's rate limit, the machine offline), the next look waits longer each
  // time, up to a quarter of an hour: a watch that gets no answer doesn't ask GitHub eighty times an hour.
  const nextLook = new Map<string, { at: number; wait: number }>();
  const tickShepherds = async (now = Date.now()): Promise<Record<string, string>> => {
    const done: Record<string, string> = {};
    for (const sid of await redis.smembers(SHEPHERDS).catch(() => [] as string[])) {
      if (shepherding.has(sid)) continue;
      const held = nextLook.get(sid);
      if (held && held.at > now) continue;
      const lock = `${o.prefix}shepherd-lock:${sid}`;
      if (!(await redis.set(lock, "1", "PX", 10 * 60_000, "NX"))) continue;
      shepherding.add(sid);
      try {
        const r = await shepherdOnce(sid, now);
        done[sid] = r;
        if (r === "wait: the pull request couldn't be read") {
          const wait = Math.min(15 * 60_000, (held?.wait ?? 45_000) * 2);
          nextLook.set(sid, { at: now + wait, wait });
        } else nextLook.delete(sid);
      } catch (err) {
        console.error("[shepherd]", sid, err);
      } finally {
        shepherding.delete(sid);
        await redis.del(lock).catch(() => {});
      }
    }
    return done;
  };
  // ponytail: one pass over every watched pull request each 45s; shard by session if there are ever thousands.
  const shepherdLoop = setInterval(() => void tickShepherds(), 45_000);
  shepherdLoop.unref();

  /**
   * Agents set to carry on when their usage limit resets (resume.at), once their time comes.
   *
   * Kept in a sorted set by time; taking an entry out of it is the claim, so two nodes don't both send it. One that was
   * called off, or overtaken by somebody writing to the agent first, no longer matches the session and is dropped. It is
   * sent as the person who set it, as if they had typed it then; if they can't steer the agent any more, it says so.
   */
  const tickResumes = async (now = Date.now()): Promise<string[]> => {
    const sent: string[] = [];
    for (const entry of await redis.zrangebyscore(RESUMES, "-inf", now).catch(() => [] as string[])) {
      if (!(await redis.zrem(RESUMES, entry))) continue;
      const [sid = "", lane = MAIN_LANE, seq = ""] = entry.split(" ");
      try {
        const due = (await store.state(sid)).resumes[lane];
        if (!due || String(due.seq) !== seq) continue;
        const r = await core.handle(sid, { id: due.by, name: due.byName }, { type: "instruct", lane, text: "[session] The usage limit has reset. Carry on with the task where you left off; don't start over." });
        if (r.ok) sent.push(sid);
        else await store.append(sid, FRIDAY, { type: "resume.cancelled", why: r.error ?? "It couldn't be sent." }, { lane });
      } catch (err) {
        console.error(`[resume] ${entry}:`, err);
      }
    }
    return sent;
  };
  const resumeLoop = setInterval(() => void tickResumes(), 30_000);
  resumeLoop.unref();
  /** Agents whose wake's time has come (AgentMesh.fireWake): taking the entry out is the claim, so one server sends it. */
  const tickWakes = async (now = Date.now()): Promise<void> => {
    for (const entry of await redis.zrangebyscore(WAKES, "-inf", now).catch(() => [] as string[])) {
      if (!(await redis.zrem(WAKES, entry))) continue;
      const [sid = "", id = ""] = entry.split(" ");
      try {
        const w = (await store.exists(sid)) ? (await store.state(sid)).wakes?.[id] : undefined;
        if (!w) continue;
        const mins = Math.max(1, Math.round((now - ((await store.events(sid)).find((e) => e.seq === w.seq)?.ts ?? now)) / 60_000));
        await mesh.fireWake(sid, id, `It's been ${mins} minute${mins === 1 ? "" : "s"}${w.on.lane || w.on.task ? ", and what you were waiting on hasn't happened yet" : ""}: time to check where it stands.`);
      } catch (err) {
        closingOr(`[wake] ${entry}:`, err);
      }
    }
  };
  const wakeLoop = setInterval(() => void tickWakes(), 30_000);
  wakeLoop.unref();
  // Each task board still being worked on, once a minute, by one server at a time: a task nobody is doing goes to someone
  // who is free, and what is ready is handed out in case a wake was lost (AgentMesh.sweep). A board that is through leaves.
  const tickBoards = async (now = Date.now()): Promise<void> => {
    for (const sid of await redis.smembers(BOARDS).catch(() => [] as string[])) {
      if (!(await redis.set(`${o.prefix}board-lock:${sid}`, "1", "PX", 55_000, "NX").catch(() => null))) continue;
      try {
        if (!(await store.exists(sid))) {
          await redis.srem(BOARDS, sid);
          continue;
        }
        await mesh.sweep(sid, now);
        if (!mesh.live.has(sid)) await redis.srem(BOARDS, sid);
      } catch (e) {
        closingOr("[board] sweep:", e);
      }
    }
  };
  const boardLoop = setInterval(() => void tickBoards(), 60_000);
  boardLoop.unref();
  const core = new SessionCore(
    store,
    (sid, lane) => void bus.wake(sid, lane),
    async () => null,
    async () => null,
    allowedModel,
    openFolder,
    o.appUrl ?? `http://localhost:${o.port}`,
    async () => 0,
    // The recording goes with the viewer link: on when it is on, and ended when it is turned off or replaced.
    () => undefined,
    // Whether people besides a session's owner work in its sessions (Team) or watch them (Solo).
    async () => false,
  );
  const hub = new EngineHub(store, bus, core);
  hub.mesh = mesh;
  /** Machines people have linked to this Friday, so a hosted one can reach their CLIs. */
  const links = new NoLinks();
  /** Runners this server started for its own machine's user (desktop app, local dev). */
  const localRunners = new Map<string, Runner>();
  /** Whether this server may run things on the machine it is on: the desktop app, or local development. */
  const localHost = () => process.env.FRIDAY_LOCAL_RUNNER === "1" || (process.env.FRIDAY_LOCAL_RUNNER !== "0" && /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(selfUrl));
  const hostCtx = (user: { id: string; name: string }) => ({ serverUrl: selfUrl, user, runners: localRunners, log: (l: string) => console.log(`[runner] ${l}`) });
  /**
   * The coding tools on a person's machine, with how much of each is left, as the router weighs them (routing.ts): from the
   * machine linked to this Friday, or this machine when Friday runs on it.
   */
  const toolOptionsFor = async (ownerId: string): Promise<ToolOption[]> => {
    const token = links.tokenFor(ownerId);
    const ctx = hostCtx({ id: ownerId, name: "" });
    const listed: MachineTool[] = token ? (links.status(token).tools ?? []) : localHost() ? (((await callHost("tools", {}, ctx)) as { tools?: MachineTool[] }).tools ?? []) : [];
    const limits = await (token ? links.call<Limits>(token, "usage", {}, 30_000) : localHost() ? (callHost("usage", {}, ctx) as Promise<Limits>) : Promise.resolve(null)).catch(() => null);
    const windowsOf = (t: EngineTool): ToolWindow[] => {
      if (!limits) return [];
      if (t === "claude") return (limits.claudeWindows ?? []).map((w) => ({ kind: w.kind ?? "", ...(w.label ? { label: w.label } : {}), usedPercent: w.utilization === null ? null : w.utilization * 100, resetsAt: w.resetsAt }));
      const ws = t === "codex" ? (limits.codexWindows ?? []) : (limits.tools?.[t]?.windows ?? []);
      return ws.map((w) => ({ kind: w.kind, ...(w.label ? { label: w.label } : {}), usedPercent: w.usedPercent, resetsAt: w.resetsAt }));
    };
    return listed
      .filter((t) => !!t.path)
      .map((t) => {
        const windows = windowsOf(t.tool);
        const used = windows.map((w) => w.usedPercent).filter((u): u is number => u !== null);
        return { tool: t.tool, ready: t.loggedIn !== false, fullest: used.length ? Math.max(...used) : null, windows };
      });
  };
  /** A coding tool started on the person's machine as a new lane of the session, in its own copy of the folder (hubs.ts). */
  const startOnMachine = async (sid: string, owner: { id: string; name: string }, p: { tool: EngineTool; cwd: string; newLane: string; model?: string }): Promise<{ lane: string }> => {
    const params = { sid, invite: signInvite(o.secret, sid, "owner"), actorToken: signActor(o.secret, sid, owner.id), tool: p.tool, cwd: p.cwd, mode: "full", worktree: "lane", newLane: p.newLane, ...(p.model ? { model: p.model } : {}) };
    const token = links.tokenFor(owner.id);
    if (token) return links.call<{ lane: string }>(token, "start", params, 10 * 60_000);
    if (localHost()) return (await callHost("start", params, hostCtx(owner))) as { lane: string };
    throw new Error("the computer with the folder isn't connected");
  };
  const stopOnMachine = async (sid: string, owner: { id: string; name: string }, lane: string): Promise<void> => {
    const token = links.tokenFor(owner.id);
    if (token) await links.call(token, "stop", { sid, lane }, 30_000);
    else if (localHost()) await callHost("stop", { sid, lane }, hostCtx(owner));
  };
  // ── Automations (automations.ts): the coding tools working on their own ──────────────────────────
  const automations = new AutomationStore(redis, o.prefix);
  /** A coding tool started for an automation's run: on the main lane, or a lane of its own beside it; in its own copy of the folder, or a new project folder when there is none. */
  const startTool = async (sid: string, owner: { id: string; name: string }, p: { tool: EngineTool; cwd: string; mode: EngineMode; copy: boolean; newLane?: string; project: string }) => {
    const params = {
      sid,
      invite: signInvite(o.secret, sid, "owner"),
      actorToken: signActor(o.secret, sid, owner.id),
      tool: p.tool,
      mode: p.mode,
      ...(p.cwd ? { cwd: p.cwd } : { noFolder: true, project: p.project }),
      ...(p.cwd && p.copy ? { worktree: "lane", carry: true, copyName: p.newLane || ENGINE_NAMES[p.tool] } : {}),
      ...(p.newLane ? { newLane: p.newLane } : {}),
    };
    const token = links.tokenFor(owner.id);
    if (token) return links.call<{ lane: string }>(token, "start", params, 10 * 60_000);
    if (localHost()) return (await callHost("start", params, hostCtx(owner))) as { lane: string };
    throw new Error("Your computer isn't connected.");
  };
  const computerHere = (ownerId: string) => !!links.tokenFor(ownerId) || !!localHost();
  /**
   * One run of an automation: a session of its own, owned by the automation's owner, told what to do, with its coding tool
   * (and any team beside it) started on the owner's computer. A run its owner's computer isn't there for waits for it, or is
   * skipped, as the automation says. Returns the run as it stands.
   */
  const runAutomation = async (ws: string, a: Automation, trigger: string, event: string, waiting?: AutomationRun): Promise<AutomationRun> => {
    let run: AutomationRun = waiting ?? { id: randomBytes(5).toString("hex"), at: Date.now(), trigger, status: "starting" };
    if (!waiting) {
      if (!(await automations.countRun(ws, a.id, a.limits.perDay))) {
        run = { ...run, status: "skipped", note: `It has already run ${a.limits.perDay} time${a.limits.perDay === 1 ? "" : "s"} today, its limit.`, ended: Date.now() };
        await automations.addRun(ws, a.id, run);
        return run;
      }
      await automations.addRun(ws, a.id, run);
    }
    const set = async (change: Partial<AutomationRun>) => (run = (await automations.updateRun(ws, a.id, run.id, change)) ?? { ...run, ...change });
    try {
      // On someone's own computer (the open-source edition, or run from here), there are no accounts and no Friday agent to run.
      const tool = a.who.tool;
      if ((tool as string) === "friday") throw new Error("Automations here run your coding tools. Pick one of them instead."); // as string: kept wide for the lines below
      if (tool !== "friday" && !computerHere(a.ownerId)) {
        if (a.limits.offline === "skip") return await set({ status: "skipped", note: "Your computer wasn't connected.", ended: Date.now() });
        if (!waiting) await redis.zadd(automations.waitingKey(), Date.now(), `${ws} ${a.id} ${run.id} ${Buffer.from(event).toString("base64url")}`);
        return await set({ status: "waiting", note: "Waiting for your computer to connect." });
      }
      const owner: Member = { id: a.ownerId, name: a.ownerName, role: "owner" };
      const agent = ((): NonNullable<Parameters<typeof store.create>[3]>["agent"] => null)(); // No saved agents here (typed, not narrowed to null).
      const sid = randomBytes(6).toString("base64url");
      const model = tool === "friday" ? await allowedModel(ws, a.who.model || agent?.model || "", a.ownerId) : "";
      await store.create(sid, a.name.slice(0, 120), owner, { webSearch: false, controlMode: "ask", mcp: true, model, agent }, ws);
      await redis.set(automations.runOfKey(sid), JSON.stringify({ ws, id: a.id, run: run.id }), "EX", 14 * 24 * 3600);
      if (tool !== "friday") await store.append(sid, { id: owner.id, name: owner.name, kind: "human" }, { type: "engine.expected", tool, hostId: owner.id, hostName: owner.name });
      const team = tool === "friday" ? [] : a.who.team;
      if (team.length) await core.handle(sid, owner, { type: "lead.set", lane: MAIN_LANE });
      await core.handle(sid, owner, { type: "instruct", text: automationPrompt(a, event) });
      const invite = signInvite(o.secret, sid, "owner");
      await set({ status: "running", sid, invite, note: "" });
      if (tool !== "friday") {
        await startTool(sid, owner, { tool, cwd: a.folder, mode: a.who.mode, copy: a.copy, project: a.name });
        // A team needs a folder to share: with a new project folder for each run, the lead works alone.
        if (a.folder) for (const t of team) await startTool(sid, owner, { tool: t, cwd: a.folder, mode: a.who.mode, copy: true, newLane: ENGINE_NAMES[t], project: a.name });
      }
      return run;
    } catch (e) {
      return await set({ status: "failed", note: (e as Error).message.slice(0, 300), ended: Date.now() });
    }
  };
  /** Every 30 seconds: automations whose time has come, and runs waiting for a computer that has connected since. */
  const tickAutomations = async (now = new Date()): Promise<AutomationRun[]> => {
    const started: AutomationRun[] = [];
    const go = (ws: string, a: Automation, trigger: string, event: string, waiting?: AutomationRun) =>
      runAutomation(ws, a, trigger, event, waiting).then((r) => void started.push(r), (e) => console.error("[automations]", e));
    for (const ws of await redis.smembers(automations.workspacesKey()).catch(() => [] as string[])) {
      for (const a of await automations.list(ws).catch(() => [] as Automation[])) {
        const slot = dueAutomation(a, now);
        if (!slot) continue;
        // Friday's own agent runs on Team: on Solo its schedule waits, kept, rather than leaving a failed run each time.
        if ((a.who.tool as string) === "friday") continue;
        if (!(await automations.claimSlot(ws, a.id, slot))) continue;
        await go(ws, a, describeWhen(a.when), `It's ${now.toISOString().slice(0, 16).replace("T", " ")} UTC.`);
      }
    }
    for (const entry of await redis.zrangebyscore(automations.waitingKey(), "-inf", "+inf").catch(() => [] as string[])) {
      const [ws, id, runId, ev] = entry.split(" ");
      const a = ws && id ? await automations.get(ws, id) : null;
      const run = a && runId ? (await automations.runs(ws!, a.id)).find((r) => r.id === runId) : undefined;
      if (!a || !run || run.status !== "waiting") {
        await redis.zrem(automations.waitingKey(), entry);
        continue;
      }
      if (now.getTime() - run.at > WAIT_FOR_COMPUTER_MS) {
        await redis.zrem(automations.waitingKey(), entry);
        await automations.updateRun(ws!, a.id, run.id, { status: "skipped", note: "Your computer didn't connect within 12 hours.", ended: now.getTime() });
        continue;
      }
      if (!computerHere(a.ownerId)) continue;
      // Taken off the list before it starts, so a second node seeing it at the same moment doesn't start it again.
      if (!(await redis.zrem(automations.waitingKey(), entry))) continue;
      await go(ws!, a, run.trigger, Buffer.from(ev ?? "", "base64url").toString("utf8"), run);
    }
    return started;
  };
  const automationLoop = setInterval(() => void tickAutomations().catch((e) => console.error("[automations]", e)), 30_000);
  automationLoop.unref();
  /** A run's end: the automation's own run marked done or failed (and its owner told, if asked), and any automation watching the session started. */
  automationsHear = (sid, ev) => {
    // A run cut off by a lost connection carries on when the machine is back: neither the run's end nor a failure.
    if (ev.body.type !== "run.ended" || ev.body.cut || (ev.lane ?? MAIN_LANE) !== MAIN_LANE) return;
    const outcome = ev.body.outcome;
    const error = ev.body.error;
    void (async () => {
      const mine = await redis.get(automations.runOfKey(sid));
      if (mine && outcome !== "waiting") {
        const { ws, id, run } = JSON.parse(mine) as { ws: string; id: string; run: string };
        const a = await automations.get(ws, id);
        const done = await automations.updateRun(ws, id, run, { status: outcome === "done" ? "done" : "failed", ended: Date.now(), ...(error ? { note: error.slice(0, 300) } : {}) });
        void a; void done; // Nobody to message here: the run shows on the Automations page.
      }
      for (const entry of await redis.smembers(automations.watchKey(sid))) {
        const [ws, id] = entry.split(" ");
        const a = ws && id ? await automations.get(ws, id) : null;
        if (!a || !a.on || a.when.kind !== "session") continue;
        if ((a.when.on === "finished" && outcome !== "done") || (a.when.on === "failed" && outcome !== "error")) continue;
        const state = await store.state(sid);
        const m = state.members[a.ownerId];
        if (!m || m.removed) continue;
        const said = (await store.events(sid)).findLast((e) => (e.lane ?? MAIN_LANE) === MAIN_LANE && e.body.type === "agent.message" && !!e.body.text.trim());
        const last = said?.body.type === "agent.message" ? said.body.text.trim().slice(0, 2000) : "";
        const what = `The agent in “${state.title}” ${outcome === "done" ? "finished" : `stopped on an error${error ? `: ${error}` : ""}`}.${last ? `\n\nIts last words:\n${last}` : ""}`;
        await runAutomation(ws!, a, `${outcome === "done" ? "finished" : "failed"} in “${state.title}”`, what);
      }
    })().catch((e) => console.error("[automations]", e));
  };

  const hubs = new Hubs({
    store,
    bus,
    core,
    llm: async () => null,
    folder: (sid, req, lane) => openFolder(sid, req, lane),
    starter: startOnMachine,
    stopper: stopOnMachine,
    tools: toolOptionsFor,
    plan: async () => "free" as const,
  });
  core.hubs = hubs;
  core.board = mesh;
  // A finished board task's checks run in its agent's own folder, on its machine (AgentMesh.runChecks).
  mesh.repo = async (sid, lane, req) => (await hub.readRepo(sid, req, lane))?.output ?? null;
  mesh.usage = (sid, lane) => hub.usage(sid, lane);
  mesh.skills = new Strengths(redis, o.prefix);
  /** Short-lived ids standing in for "which machine, which port" in preview URLs. */
  /** `iat` is when it was made: "Sign out everywhere" after that ends it, and so does PREVIEW_TICKET_MAX_MS, however busy it is. */
  const previewTickets = new Map<string, { uid: string; token: string; local: boolean; port: number; at: number; iat: number; here?: string }>();
  let selfUrl = "";
  const timers = new Set<NodeJS.Timeout>();
  /** Each driver-left grace timer, by session, person and lane (scheduleHandoff). */
  const handoffs = new Map<string, NodeJS.Timeout>();

  // Graceful shutdown: stop taking work, let in-flight handlers finish, and
  // only then close Redis, so no handler writes to a connection that's gone.
  let closing = false;
  const inflight = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>) => {
    inflight.add(p);
    p.catch((err) => console.error("[app]", err)).finally(() => inflight.delete(p));
  };
  const drain = async () => {
    while (inflight.size) await Promise.allSettled([...inflight]);
  };

  /**
   * The preview address, when previews have their own site (AppOptions.previewOrigin). That host answers previews and
   * nothing else: no page, no API, no socket, no cookie; and the app host answers no preview.
   * ponytail: every preview shares this one origin, so two previews open in one browser can reach each other's storage;
   * a per-ticket subdomain (PREVIEW_ORIGIN on a wildcard domain) is the upgrade.
   */
  const appOrigin = (() => {
    try {
      return o.appUrl ? new URL(o.appUrl).origin : "";
    } catch {
      return "";
    }
  })();
  const previewBase = (() => {
    try {
      const p = o.previewOrigin ? new URL(o.previewOrigin) : null;
      return p && appOrigin && p.host !== new URL(appOrigin).host ? p.origin : "";
    } catch {
      return "";
    }
  })();
  const previewHost = previewBase ? new URL(previewBase).host.toLowerCase() : "";
  // Host, or the proxy's X-Forwarded-Host: either naming the preview host makes it one. Spoofing that only takes things away.
  const onPreviewHost = (req: http.IncomingMessage): boolean =>
    !!previewHost && [req.headers.host, req.headers["x-forwarded-host"]].some((h) => String(h ?? "").split(",")[0]!.trim().toLowerCase() === previewHost);
  /** Headers on every preview response: only Friday may frame it. */
  const previewHeaders = (): Record<string, string> => (previewBase ? { "Content-Security-Policy": `frame-ancestors ${appOrigin}` } : {});

  /** The preview ticket a request came from, when its referrer is a page being previewed on this same address. */
  const previewReferrer = (req: http.IncomingMessage): string | null => {
    try {
      const ref = new URL(String(req.headers.referer ?? ""));
      if (ref.host !== req.headers.host) return null;
      const t = ref.pathname.match(/^\/api\/preview\/([\w-]{6,40})\//)?.[1];
      return t && previewTickets.has(t) ? t : null;
    } catch {
      return null;
    }
  };

  const bundle = await bundleClient();

  // ── HTTP ─────────────────────────────────────────────────────────
  const server = http.createServer((req, res) => {
    if (closing) return json(res, 503, { error: "Server is shutting down" });
    // The open-source edition has no sign-in, so only this computer's own pages may talk to it (localOnly).
    if (o.local && !localOnly(req, appOrigin)) return json(res, 403, { error: "Friday only answers its own pages on this computer." });
    // A JSON body bigger than readJson reads (256 KB) is refused before it is read, with a 413 rather than a dropped
    // connection (Testing API-12). Uploads aren't JSON, and the routes that read larger JSON themselves keep their limits.
    if (/application\/json/i.test(String(req.headers["content-type"] ?? "")) && Number(req.headers["content-length"]) > JSON_MAX && !BIG_JSON.test((req.url ?? "").split("?")[0]!)) {
      res.setHeader("Connection", "close");
      return json(res, 413, { error: "That request is too large." });
    }
    const t0 = Date.now();
    res.on("finish", () => {
      ops.count("http.requests");
      if (res.statusCode >= 500) {
        ops.count("http.5xx");
        ops.error("http", `${res.statusCode} ${req.method} ${(req.url ?? "").split("?")[0]}`);
      } else if (res.statusCode >= 400) ops.count("http.4xx");
      if (Date.now() - t0 > 3000) ops.count("http.slow");
    });
    track(
      handleHttp(req, res).catch((err) => {
        if (err instanceof WorkspaceClosing) return void (!res.headersSent && json(res, 409, { error: err.message }));
        console.error("[http]", err);
        ops.error("http", `${req.method} ${(req.url ?? "").split("?")[0]}: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) json(res, 500, { error: "Internal error" });
      }),
    );
  });

  // Who is connected right now, for the admin console: sockets by account, and what is running.
  const online = new Map<WebSocket, string>();
  // And the session each of those sockets is in, so a team deleted lets go of everyone in its sessions at once.
  const watching = new Map<WebSocket, string>();
  ops.gauge("people.sockets", () => online.size);
  ops.gauge("people.online", () => new Set(online.values()).size);

  // ── deleting an account (DELETE /api/me, account-delete.ts) ─────────

  /** Every Redis key matching a pattern, deleted in batches. */
  const delMatching = async (pattern: string) => {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 500);
      cursor = next;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== "0");
  };

  /** A session gone with its log, its members and presence, its tree, its files and its uploaded folder. */
  const removeSession = async (sid: string) => {
    // Off its team's conflict radar too (radar.ts), read before its log goes.
    const ws = await store.state(sid).then((s) => s.workspaceId, () => "");
    // From here a late write (a run's last step, a machine's last word) is refused instead of starting a new log under its id.
    await store.bury(sid);
    // Off the lists of sessions the server comes back to by itself: a pull request it watches, an agent to carry on later.
    await redis.srem(SHEPHERDS, sid).catch(() => {});
    const resumes = await redis.zrangebyscore(RESUMES, "-inf", "+inf").catch(() => [] as string[]);
    const mine = resumes.filter((e) => e.startsWith(`${sid} `));
    if (mine.length) await redis.zrem(RESUMES, ...mine).catch(() => {});
    await delMatching(`${o.prefix}{${sid}}*`);
    await delMatching(`${o.prefix}tree:${sid}*`);
    await files.removeSession(sid).catch(() => {});
    await rm(uploaded.rootFor(sid), { recursive: true, force: true }).catch(() => {});
  };

  /**
   * A session deleted for everyone in it: its runs stopped and its agents let go, everyone in it shown out, off every member's
   * list, then gone with everything it kept (removeSession). The space it took is freed: Redis, the Postgres copy, its files.
   */
  const endSession = async (sid: string, why: string) => {
    const friday = { id: "system", name: "Friday", kind: "system" as const };
    const state = await store.state(sid);
    for (const lane of [MAIN_LANE, ...state.lanes.map((l) => l.id)]) {
      if (runOf(state, lane).status !== "idle") await store.append(sid, friday, { type: "run.cancel" }, { lane, bumpEpoch: true });
      if (lane !== MAIN_LANE) await store.append(sid, friday, { type: "lane.removed", laneId: lane });
    }
    await hub.release(sid, why);
    await runtime.stopSession(sid, why);
    for (const [ws, watched] of watching) if (watched === sid) closeSaying(ws, 4003, why);
    for (const id of Object.keys(state.members)) await Promise.all([redis.zrem(`${o.prefix}mine:${id}`, sid), redis.srem(`${o.prefix}hidden:${id}`, sid)]);
    await removeSession(sid);
  };

  /** Whether `userId` is the only one in a session: nobody else could still reach it once they put it away. */
  const aloneIn = (state: SessionState, userId: string) => {
    const left = Object.entries(state.members).filter(([, m]) => !m.removed);
    return left.length === 1 && left[0]![0] === userId;
  };




  async function sendInfo(res: http.ServerResponse) {
    const info = (await o.llm.info?.().catch(() => undefined)) ?? { model: "test", free: true, configured: true, creditsRemaining: null };
    // The callback URL is public by nature — it's where providers send people
    // back — and having it here is how a deployment's OAuth setup is checked
    // without signing in: it must match what's registered with the provider.
    return json(res, 200, {
      ...info,
      // Names only, no credentials: enough to see whether a deployment's
      // connector apps are actually configured without signing in to check.
    });
  }


  async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Friday's own responses: no type sniffing, only the origin as referrer off-site, HTTPS pinned for a year when the request
    // came over HTTPS (never plain-http localhost), and only Friday may frame them. A previewed page (somebody's dev server's,
    // proxied) gets none of it: it keeps the types its server gave and previewHeaders()' frame-ancestors for the app.
    if (!(req.method === "GET" && /^\/api\/preview\/[\w-]{6,40}(\/|$)/.test(url.pathname))) {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
      if (String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]!.trim() === "https") res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
      if (!onPreviewHost(req)) {
        res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
        res.setHeader("X-Frame-Options", "SAMEORIGIN");
      }
    }
    if (previewHost) {
      const preview = req.method === "GET" && /^\/api\/preview\/[\w-]{6,40}(\/|$)/.test(url.pathname);
      if (onPreviewHost(req)) {
        if (!preview) {
          // A previewed page's "/_next/…" or "/src/main.tsx" goes back inside its ticket (the rescue below, on this host).
          const inside = req.method === "GET" ? previewReferrer(req) : null;
          if (inside) {
            res.writeHead(307, { ...previewHeaders(), Location: `/api/preview/${inside}${url.pathname}${url.search}`, "Cache-Control": "no-store" });
            return void res.end();
          }
          // Render's health check (render.yaml) or a monitor may come in on this host: /api/info answers here as anywhere.
          if (req.method === "GET" && url.pathname === "/api/info") return sendInfo(res);
          // A sign-in or MCP callback a provider sent here goes on to the app, query and all, like a page. No other API here.
          const read = req.method === "GET" || req.method === "HEAD";
          const callback = read && (url.pathname === "/api/mcp/callback" || url.pathname.startsWith("/auth/"));
          if (!callback && (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/"))) return json(res, 404, { error: "Not found" });
          res.writeHead(308, { Location: `${appOrigin}${url.pathname}${url.search}` });
          return void res.end();
        }
      } else if (preview) {
        res.writeHead(308, { Location: `${previewBase}${url.pathname}${url.search}`, "Cache-Control": "no-store" });
        return void res.end();
      }
    }
    // OAuth 2.0, its metadata, and the token API with its description: before everything else that might take these paths.

    // A previewed page asking for "/_next/static/…" or "/src/main.tsx" from the root of the address it thinks it is on lands
    // here, outside its ticket's prefix, and used to get Friday's own files or nothing: a blank page. Its referrer says which
    // preview asked, so it is sent back inside; a module loaded that way then asks for its own imports from inside too.
    if (req.method === "GET" && !url.pathname.startsWith("/api/preview/")) {
      const inside = previewReferrer(req);
      if (inside) {
        res.writeHead(307, { Location: `/api/preview/${inside}${url.pathname}${url.search}`, "Cache-Control": "no-store" });
        return void res.end();
      }
    }



    /**
     * A way in from outside: a URL an agent's owner pastes into GitHub, a
     * pager or a script. It starts a session running that agent, owned by the
     * agent's owner, with whatever was posted as the first thing it is told.
     * The key in the URL is the only credential, so a wrong one is
     * indistinguishable from an agent that isn't there.
     */
    // An automation's webhook (automations.ts): whatever is posted is what started the run. The key is the only credential.
    const autoHook = url.pathname.match(/^\/api\/hooks\/automation\/([\w-]{1,60})\/([\w-]{4,40})$/);
    if (autoHook && req.method === "POST") {
      const a = await automations.get(autoHook[1]!, autoHook[2]!);
      const given = Buffer.from(url.searchParams.get("key") ?? "");
      const want = Buffer.from(a?.when.kind === "webhook" ? a.when.secret : "");
      if (!a || !want.length || given.length !== want.length || !timingSafeEqual(given, want)) return json(res, 404, { error: "Not found" });
      if (!a.on) return json(res, 409, { error: "This automation is paused." });
      let payload = "";
      try {
        payload = (await readBody(req, 200_000)).toString("utf8").slice(0, 8000).trim();
      } catch {
        return json(res, 413, { error: "That payload is too large." });
      }
      const run = await runAutomation(autoHook[1]!, a, "webhook", payload || "(The webhook was called with nothing in it.)");
      return json(res, 202, { run: { id: run.id, status: run.status, ...(run.note ? { note: run.note } : {}) } });
    }



    if (req.method === "POST" && url.pathname === "/api/sessions") {
      const body = await readJson(req);
      const goal = str(body.goal, 8000);
      const title = str(body.title, 120) || deriveTitle(goal) || "Untitled session";
      // The owner is whoever is signed in. It used to be whatever the body
      // said, which meant anyone could open a session in someone else's name.
      const me = await identity(req);
      if (!me) return json(res, 401, { error: "Sign in to start a session." });
      const owner: Member = { id: me.id, name: me.name, role: "owner" };
      const ctx = (await context(req))!;
      // Before anything is written for the session (touchUser writes under the workspace); store.create says so too.
      if (await redis.exists(store.closingKey(ctx.workspace.id))) return json(res, 409, { error: "This team is being deleted." });
      let agent = null;

      const sid = randomBytes(6).toString("base64url");
      // The code in front of the agent is the source of truth, so the web is
      // off unless somebody asks for it.
      // What the workspace starts every session with, where the request doesn't say (Settings › Agent defaults).
      const starts = ctx.workspace.defaults ?? {};
      await store.create(sid, title, owner, {
        webSearch: typeof body.webSearch === "boolean" ? body.webSearch : starts.webSearch === true,
        ...(typeof starts.review === "boolean" ? { review: starts.review } : {}),
        ...(typeof starts.planFirst === "boolean" ? { planFirst: starts.planFirst } : {}),
        controlMode: body.controlMode === "takeover" ? "takeover" : "ask",
        mcp: body.mcp !== false,
        // The composer's choice if it made one, else the agent's own default.
        // "" is a choice — it means Friday's model — so absent and empty are
        // not the same thing here: treating them alike ran an agent's frontier
        // model while the composer said Friday.
        model: await allowedModel(ctx.workspace.id, typeof body.model === "string" ? str(body.model, 80) : "", owner.id),
        ...(["fast", "balanced", "deep"].includes(String(body.thinking)) ? { thinking: body.thinking as Thinking } : {}),
        agent,
        ...(issueRef(body.issue) ? { issue: issueRef(body.issue)! } : {}),
        ...(prRef(body.pr) ? { pr: prRef(body.pr)! } : {}),
        // Commands allowed in advance, from a template saved out of an earlier session.
        ...(Array.isArray(body.allow) ? { allow: (body.allow as unknown[]).filter((a): a is string => typeof a === "string" && !!a.trim()).map((a) => a.trim().slice(0, 200)).slice(0, 40) } : {}),
      }, ctx.workspace.id);
      // Starting a session on your own CLI: reserve the main lane first, so the
      // opening goal waits for the CLI instead of going to Friday Code.
      if (ENGINE_TOOLS.includes(body.engine as EngineTool)) {
        // A repo to clone, for people connecting from their own terminal.
        const repo = typeof body.repo === "string" && parseRepo(body.repo) ? body.repo.trim().slice(0, 400) : undefined;
        await store.append(
          sid,
          { id: owner.id, name: owner.name, kind: "human" },
          { type: "engine.expected", tool: body.engine as EngineTool, hostId: owner.id, hostName: owner.name, ...(repo ? { repo } : {}) },
        );
        // The effort picked with it on the new-session screen, through the same check as any change of effort.
        if (isEngineEffort(body.effort) && EFFORT_LEVELS[body.engine as EngineTool]?.includes(body.effort)) await core.handle(sid, owner, { type: "lane.effort", effort: body.effort });
      }
      // Private first: people start on their own and show somebody when there is
      // something to show, so a session is for its owner until they bring the
      // team in. The links stay on the session, switched off; nothing is lost
      // and turning them on is one press.
      if (goal) await core.handle(sid, owner, { type: "instruct", text: goal });
      return json(res, 201, { sessionId: sid, invites: { owner: signInvite(o.secret, sid, "owner"), editor: signInvite(o.secret, sid, "editor"), viewer: signInvite(o.secret, sid, "viewer") } });
    }

    /**
     * Watching what the project actually renders.
     *
     * The dev server runs on the machine doing the work, which a hosted Friday
     * can't reach, so its bytes come back over the link. An iframe can't send
     * the headers that say which machine, so the browser trades them for a
     * ticket first and the ticket is what travels in the URL.
     */
    const ticketed = url.pathname.match(/^\/api\/preview\/([\w-]{6,40})(\/.*)?$/);
    if (ticketed && req.method === "GET") {
      const t = previewTickets.get(ticketed[1]!);
      if (!t) return json(res, 404, { error: "This preview link expired. Reopen the preview." }, previewHeaders());
      // A bearer link, so it ends with its maker's sessions, after a while unused, and after a while however much it is used.
      const now = Date.now();
      if (now - t.iat > PREVIEW_TICKET_MAX_MS || now - t.at > PREVIEW_TICKET_IDLE_MS || t.iat < (await sessionsAfter(t.uid))) {
        previewTickets.delete(ticketed[1]!);
        return json(res, 403, { error: "This preview link has ended. Sign in and reopen the preview." }, previewHeaders());
      }
      // Still that session's preview: once it stops, whatever binds the port next is not what the ticket was for.
      if (t.here && previewStatus(uploaded.rootFor(t.here))?.port !== t.port) {
        previewTickets.delete(ticketed[1]!);
        return json(res, 404, { error: "This preview link expired. Reopen the preview." }, previewHeaders());
      }
      t.at = Date.now();
      const rest = (ticketed[2] || "/") + (url.search || "");
      const prefix = `/api/preview/${ticketed[1]}`;
      try {
        // Two minutes: the first page of a big project (Next with webpack, say) is built when it is asked for, and that can
        // take most of a minute. Told "didn't answer in time" at thirty seconds, it looked broken while it was compiling.
        // Next's router headers ride along, so a client-side navigation gets the RSC payload it asked for, not a whole page.
        const asked = previewHeadersFrom(req.headers);
        const r = (await (t.here
          ? fetchPreview(t.port, rest, asked)
          : t.local
            ? callHost("preview.fetch", { port: t.port, path: rest, headers: asked }, { serverUrl: selfUrl, user: { id: "local", name: "You" }, runners: localRunners })
            : links.call(t.token, "preview.fetch", { port: t.port, path: rest, headers: asked }, PREVIEW_FETCH_MS))) as { status: number; type: string; body: string; location?: string };
        let body = Buffer.from(r.body, "base64");
        // Root-absolute links inside the page would escape the prefix, so they
        // are pointed back at it. Relative ones already resolve correctly.
        if (/text\/html/i.test(r.type)) {
          let html = body
            .toString("utf8")
            .replace(/(src|href|action)=("|')\/(?!\/)/gi, `$1=$2${prefix}/`)
            .replace(/url\(\s*\/(?!\/)/gi, `url(${prefix}/`);
          // On a site of its own Friday can't reach into the page to point at something, so the page carries the way to ask.
          if (previewBase) {
            const bridge = `<script>${pointBridge(appOrigin)}</script>`;
            const head = /<head\b[^>]*>/i.exec(html);
            html = head ? html.slice(0, head.index + head[0].length) + bridge + html.slice(head.index + head[0].length) : html + bridge;
          }
          body = Buffer.from(html);
        }
        // A redirect keeps its destination, inside the prefix: without it a site that sends "/" on to "/en" was a blank page.
        const headers: Record<string, string | number> = { ...previewHeaders(), "Content-Type": r.type, "Cache-Control": "no-store", "Content-Length": body.length };
        if (r.location) headers.Location = previewLocation(r.location, t.port, prefix);
        res.writeHead(r.status, headers);
        return res.end(body);
      } catch (e) {
        // Read by the Preview panel's frame, so a sentence a person can read there, not JSON for a browser to pretty-print.
        // The panel reads the title to offer starting the server itself, so it stays "Nothing answered"; on a preview host of
        // its own the panel can't read it, so once loaded it tells Friday, and only Friday, its parent.
        const why = previewTrouble((e as Error).message).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
        const page = `<!doctype html><meta charset="utf-8"><title>Nothing answered</title><body style="margin:0;display:grid;place-items:center;min-height:100vh;font:14px/1.5 system-ui,sans-serif;color:#9a9a9a;background:#1c1c1c"><div style="max-width:420px;padding:24px;text-align:center"><p style="color:#ededed;font-weight:600;margin:0 0 6px">Nothing is answering on port ${t.port}</p><p style="margin:0">${why}</p></div>${previewBase ? `<script>addEventListener("load",()=>parent.postMessage({type:"friday-preview",state:"nothing-answered"},${JSON.stringify(appOrigin)}))</script>` : ""}</body>`;
        res.writeHead(502, { ...previewHeaders(), "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(page);
      }
    }
    /**
     * Previewing a folder somebody uploaded.
     *
     * The dev server runs here rather than on anybody's machine, which is the
     * only way a session with no machine linked gets a preview at all — and
     * that is the common case for somebody who attached a folder. Same
     * module as the machine path, same built environment as the shell.
     */
    const sessionPreview = url.pathname.match(/^\/api\/sessions\/([\w-]{4,40})\/preview\.(status|options|start|stop)$/);
    if (sessionPreview) {
      const ctx = await context(req);
      if (!ctx) return json(res, 401, { error: "Sign in first." });
      const sid = sessionPreview[1]!;
      const state = await store.state(sid).catch(() => null);
      if (!state || !roleOf(state, ctx.me.id)) return json(res, 404, { error: "No such session." });
      // Anybody in the room may look at a preview; starting or stopping the server that makes it is running something on this machine.
      if ((sessionPreview[2] === "start" || sessionPreview[2] === "stop") && !can(state, ctx.me.id, "control")) {
        return json(res, 403, { error: "Viewers can watch this session but can't start or stop its preview." });
      }
      const root = uploaded.rootFor(sid);
      if (!(await stat(root).then(() => true, () => false))) return json(res, 400, { error: "This session has no uploaded folder to preview." });
      try {
        const what = sessionPreview[2];
        if (what === "status") return json(res, 200, { preview: await previewStatusLive(root) });
        if (what === "options") return json(res, 200, await previewOptions(root));
        if (what === "stop") return json(res, 200, { stopped: stopPreview(root) });
        const script = str((await readJson(req)).script, 60) || undefined;
        // Serving files is not running code, so a static site previews
        // either way. `npm run dev` is running code, and it is the same
        // risk as a shell — the same switch decides it.
        const opts = await previewOptions(root);
        const wouldRun = !!script || opts.scripts.length > 0;
        if (wouldRun && !uploadsMayRun()) {
          if (!opts.static) {
            return json(res, 400, {
              error: "Previewing this needs its dev server run, and uploaded folders don't run commands here. Connect a machine from the session header to run it there.",
            });
          }
          // It has scripts and static files both. Asked for explicitly:
          // leaving the script out would pick the first one in package.json.
          return json(res, 200, { preview: await startPreview(root, undefined, uploaded.envFor(sid), true) });
        }
        return json(res, 200, { preview: await startPreview(root, script, uploaded.envFor(sid)) });
      } catch (e) {
        return json(res, 400, { error: (e as Error).message });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/preview/ticket") {
      if (crossSite(req)) return json(res, 403, { error: "Cross-site requests can't open a preview." });
      const me = await identity(req);
      if (!me) return json(res, 401, { error: "Sign in to open a preview." });
      const picked = await pickedMachine(req);
      if ("error" in picked) return json(res, picked.status, { error: picked.error });
      const token = picked.token ?? str(req.headers["x-friday-link"], 200);
      const onThisMachine = !picked.token && isOwnMachine(req) && req.headers["x-friday-local"] === "1";
      const useLink = !!token && links.connected(token) && (!onThisMachine || req.headers["x-friday-prefer"] === "link");
      // A preview running here needs no machine at all, which is the whole
      // point of it: the folder was uploaded precisely because there isn't one.
      const here = req.headers["x-friday-here"] === "1";
      if (!here && !onThisMachine && !useLink) return json(res, 403, { error: "No machine is connected." });
      const body = await readJson(req);
      const port = Number(body.port) || 0;
      if (!port) return json(res, 400, { error: "Which port?" });
      // Only the preview Friday started for a session the caller is in; any other port on this server's loopback is not theirs to read.
      const sid = here ? str(body.sid, 40) : "";
      if (here) {
        const state = sid ? await store.state(sid).catch(() => null) : null;
        if (!state || !roleOf(state, me.id) || previewStatus(uploaded.rootFor(sid))?.port !== port) {
          return json(res, 403, { error: "No preview of yours is running on that port." });
        }
      }
      const ticket = randomBytes(9).toString("base64url");
      const now = Date.now();
      previewTickets.set(ticket, { uid: me.id, token, local: !useLink, port, at: now, iat: now, ...(here ? { here: sid } : {}) });
      // Tickets are cheap and short-lived; drop stale ones as we go.
      for (const [k, v] of previewTickets) if (now - v.at > PREVIEW_TICKET_IDLE_MS || now - v.iat > PREVIEW_TICKET_MAX_MS) previewTickets.delete(k);
      return json(res, 201, { ticket, url: `${previewBase}/api/preview/${ticket}/` });
    }





    /**
     * Anything that happens on someone's own machine: what CLIs are installed,
     * their repos, cloning, signing in, starting a runner.
     *
     * Two ways a machine can be theirs. Friday is *running* on it (the desktop
     * app, or localhost in a browser), or they linked it and it is connected —
     * in which case this forwards the same call over the link and their machine
     * runs the identical code. A hosted Friday has neither by default, which is
     * why a public deployment answers 403 until someone links a machine.
     */
    if (url.pathname.startsWith("/api/runner/")) {
      if (crossSite(req)) return json(res, 403, { error: "Cross-site requests can't reach a machine." });
      const method = url.pathname.slice("/api/runner/".length);
      const picked = await pickedMachine(req);
      if ("error" in picked) return json(res, picked.status, { error: picked.error });
      const token = picked.token ?? str(req.headers["x-friday-link"], 200);
      const onThisMachine = !picked.token && isOwnMachine(req) && req.headers["x-friday-local"] === "1";
      const link = await linkedFor(req, token);
      const linked = link === "yes";
      if (!onThisMachine && !linked) {
        // "Is a machine linked?" is a question with an answer, not a refusal: a signed-in person with none gets "no", so the
        // page's look at the machine stops counting as a permission failure. Everything else stays refused: anyone signed
        // out, a link that is another account's, and every call that would actually run something.
        if (method === "tools" && link === "no" && !picked.token && (await identity(req))) return json(res, 200, { linked: false, tools: [], home: "" });
        return json(res, 403, { error: linkRefusal(link) ?? `No machine is connected. Link yours to run ${toolList()}.` });
      }
      // With both available, the person chooses; otherwise there's one answer.
      const useLink = linked && (!onThisMachine || req.headers["x-friday-prefer"] === "link");
      const params: Record<string, unknown> = req.method === "POST" ? ((await readJson(req)) as Record<string, unknown>) : Object.fromEntries(url.searchParams);
      // Starting a runner means acting as someone in a session. Mint that
      // permission here, where the signing secret is, rather than letting the
      // runner assert a user id when it connects back.
      if (method === "start") {
        const who = await identity(req);
        const sid = String(params.sid ?? "");
        if (!who) return json(res, 401, { error: "Sign in to start a coding agent." });
        if (!sid) return json(res, 400, { error: "Which session?" });
        params.actorToken = signActor(o.secret, sid, who.id);
      }
      // Connecting GitHub is GitHub's device flow under Friday's own OAuth app: its client id is public, and is this server's to say.
      if (method === "github.connect") params.clientId = (process.env.GITHUB_DEVICE_CLIENT_ID || process.env.GITHUB_CLIENT_ID || process.env.GITHUB_MCP_CLIENT_ID || "").trim();
      const ok = method === "start" ? 201 : 200;
      try {
        if (!useLink) {
          const user = await identity(req);
          if (!user && (method === "start" || method === "stop")) return json(res, 401, { error: "Missing user identity" });
          const ctx = { serverUrl: selfUrl, user: user ?? { id: "local", name: "You" }, runners: localRunners, log: (l: string) => console.log(`[runner] ${l}`) };
          const value = (await callHost(method, params, ctx)) as object;
          // Say which machine answered, so the UI can never claim the wrong one.
          return json(res, ok, method === "tools" ? { ...value, where: "local" } : value);
        }
        // Cloning can take minutes on a big repo, and so can starting: a worktree of a big repo is a minute of git before the
        // agent attaches. Told "didn't answer in time" at 30 seconds, the person set it up again while the first one joined.
        // Everything else is quick.
        // An agent review is one of the person's own CLIs reading a whole pull request: minutes, not seconds.
        const value = (await links.call(token, method, params, method === "clone" || method === "start" ? 10 * 60_000 : method === "pr.review" ? 6 * 60_000 : 30_000)) as object;
        return json(res, ok, method === "tools" ? { ...value, where: "linked" } : value);
      } catch (e) {
        return json(res, 400, { error: (e as Error).message });
      }
    }

    // Attachments: upload (needs the upload permission) and download (any member link).
    // The first instruction, when it carries attachments. Files belong to a
    // session, so they can only be uploaded after it exists — which means the
    // opening message can't be sent at creation time like a plain goal can.
    /**
     * A fork: a new session of the caller's own that starts from where this one is.
     * What came along is the conversation's tail, carried the way an imported CLI
     * conversation is, so every agent in the fork reads it as work already done.
     */
    const forkRoute = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/fork$/);
    if (forkRoute && req.method === "POST") {
      const sid = forkRoute[1]!;
      const inv = verifyInvite(o.secret, url.searchParams.get("invite"));
      if (!inv || inv.sid !== sid) return json(res, 403, { error: "Invalid invite for this session" });
      // A fork copies the conversation out, so only somebody who is in the session may make one.
      const me = await memberOnly(req, res, sid);
      if (!me) return;
      const ctx = (await context(req))!;
      const upTo = Number(url.searchParams.get("upTo")) || Infinity;
      const events = (await store.events(sid)).filter((e) => e.seq <= upTo);
      const title = project(sid, events).title;
      const turns: ImportedTurn[] = [];
      for (const e of events) {
        const b = e.body;
        if (b.type === "instruction" && !b.handoff && b.text.trim()) turns.push({ role: "user", text: b.text.slice(0, 2000) });
        else if (b.type === "agent.message" && b.text.trim()) turns.push({ role: "assistant", text: b.text.slice(0, 2000) });
      }
      const owner: Member = { id: me.id, name: me.name, role: "owner" };
      const fork = randomBytes(6).toString("base64url");
      await store.create(fork, `Fork of ${title}`.slice(0, 120), owner, { webSearch: false, controlMode: "ask", mcp: true, model: "", agent: null }, ctx.workspace.id);
      await store.append(fork, { id: owner.id, name: owner.name, kind: "human" }, { type: "session.imported", tool: "claude", sourceId: sid, title, turns: turns.slice(-40), total: turns.length, fork: true });
      return json(res, 201, { sessionId: fork, title: `Fork of ${title}`.slice(0, 120), invites: { owner: signInvite(o.secret, fork, "owner") } });
    }

    /**
     * Allow or Deny a coding tool's permission request from the "Waiting on you" list, without opening the session: the
     * same answer the request's card in the session sends, as the person pressing it. Same invite check as instruct.
     */
    const answerRoute = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/answer$/);
    if (answerRoute && req.method === "POST") {
      const sid = answerRoute[1]!;
      const inv = verifyInvite(o.secret, url.searchParams.get("invite"));
      if (!inv || inv.sid !== sid) return json(res, 403, { error: "Invalid invite for this session" });
      const user = await identity(req);
      if (!user) return json(res, 401, { error: "Missing user identity" });
      const body = (await readJson(req)) as { lane?: unknown; id?: unknown; approve?: unknown };
      const approve = body.approve === true;
      const lane = str(body.lane, 80) || MAIN_LANE;
      // An answer, not an instruction: writing to the lane would hand the wheel to whoever answered when nobody was driving.
      const r = await core.handle(sid, { id: user.id, name: user.name }, { type: "approval.answer", lane, id: str(body.id, 80), approve });
      return r.ok ? json(res, 201, { seq: r.seq }) : json(res, 400, { error: r.error ?? "Could not send that." });
    }

    // Earlier in a session, a page at a time, for the phone: it opens a session with a screenful (phone-log.ts) and asks for
    // the rest as the person scrolls up. Only to someone in the session, as joining is.
    const historyRoute = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/history$/);
    if (historyRoute && req.method === "GET") {
      const sid = historyRoute[1]!;
      const inv = verifyInvite(o.secret, url.searchParams.get("invite"));
      if (!inv || inv.sid !== sid) return json(res, 403, { error: "Invalid invite for this session" });
      const user = await identity(req);
      if (!user) return json(res, 401, { error: "Not signed in." });
      const state = await store.state(sid);
      const member = state.members[user.id];
      if (!member || member.removed) return json(res, 403, { error: "You aren't in this session." });
      const before = Number(url.searchParams.get("before"));
      const limit = Math.min(Math.max(Math.floor(Number(url.searchParams.get("limit"))) || PHONE_PAGE, 1), 200);
      const events = (await store.events(sid)).slice(0, state.lastSeq);
      const lane = str(url.searchParams.get("lane"), 80) || MAIN_LANE;
      return json(res, 200, phonePage(events, lane, Number.isFinite(before) && before > 0 ? before : Infinity, limit));
    }

    // One logged change set whole, patches and all: what a page opening the session was sent by name only (lightLog), as it is opened.
    const diffRoute = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/diff$/);
    if (diffRoute && req.method === "GET") {
      const sid = diffRoute[1]!;
      const inv = verifyInvite(o.secret, url.searchParams.get("invite"));
      if (!inv || inv.sid !== sid) return json(res, 403, { error: "Invalid invite for this session" });
      const user = await identity(req);
      if (!user) return json(res, 401, { error: "Not signed in." });
      const state = await store.state(sid);
      const member = state.members[user.id];
      if (!member || member.removed) return json(res, 403, { error: "You aren't in this session." });
      const seq = Math.floor(Number(url.searchParams.get("seq")));
      const ev = seq > 0 && seq <= state.lastSeq ? (await store.events(sid))[seq - 1] : undefined;
      if (ev?.seq !== seq || ev.body.type !== "agent.diff") return json(res, 404, { error: "There's no change set there." });
      res.setHeader("Cache-Control", "private, max-age=86400, immutable");
      return json(res, 200, { files: ev.body.files });
    }

    const instructRoute = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/instruct$/);
    if (instructRoute && req.method === "POST") {
      const sid = instructRoute[1]!;
      const inv = verifyInvite(o.secret, url.searchParams.get("invite"));
      if (!inv || inv.sid !== sid) return json(res, 403, { error: "Invalid invite for this session" });
      const user = await identity(req);
      if (!user) return json(res, 401, { error: "Missing user identity" });
      const body = (await readJson(req)) as { text?: unknown; attachments?: unknown; shepherd?: unknown };
      const text = str(body.text, 8000);
      // cleanAttachments revalidates every field, so unverified input is safe here.
      const r = await core.handle(sid, { id: user.id, name: user.name }, { type: "instruct", text, attachments: body.attachments as Attachment[] | undefined });
      // Started from Code Review's "See it through": the pull request goes to Friday's loop as the agent starts on it. Refused
      // quietly (no pull request, no folder) leaves the session as an ordinary one.
      if (r.ok && body.shepherd === true) await core.handle(sid, { id: user.id, name: user.name }, { type: "pr.shepherd", on: true }).catch(() => null);
      return r.ok ? json(res, 201, { seq: r.seq }) : json(res, 400, { error: r.error ?? "Could not send that." });
    }

    /**
     * A whole folder, sent as one archive and unpacked as the session's working
     * copy, so all of it arrives rather than however many files a request per
     * file managed to carry.
     */
    const folderRoute = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/folder$/);
    if (folderRoute && req.method === "POST") {
      const sid = folderRoute[1]!;
      const inv = verifyInvite(o.secret, url.searchParams.get("invite"));
      if (!inv || inv.sid !== sid) return json(res, 403, { error: "Invalid invite for this session" });
      const who = await identity(req);
      if (!who) return json(res, 401, { error: "Sign in to attach a folder." });
      if (!can(await store.state(sid), who.id, "upload")) return json(res, 403, { error: "You don't have permission to attach files in this session." });
      let archive: Buffer;
      try {
        archive = await readBody(req, MAX_FOLDER_ARCHIVE);
      } catch {
        return json(res, 413, { error: `That folder is larger than ${MAX_FOLDER_ARCHIVE / 1024 / 1024} MB even compressed.` });
      }
      let label = "";
      try {
        label = decodeURIComponent(String(req.headers["x-folder-name"] ?? "")).slice(0, 120);
      } catch {
        // keep empty
      }
      try {
        const done = await uploaded.unpack(sid, archive, label);
        await store.append(sid, { id: who.id, name: who.name, kind: "human" }, { type: "folder.uploaded", name: done.name, files: done.files });
        return json(res, 201, { name: done.name, files: done.files });
      } catch (e) {
        return json(res, 400, { error: e instanceof Error ? e.message : "That folder could not be unpacked." });
      }
    }

    const fileRoute = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/files(?:\/([\w-]+))?$/);
    if (fileRoute) {
      const sid = fileRoute[1]!;
      const inv = verifyInvite(o.secret, url.searchParams.get("invite"));
      if (!inv || inv.sid !== sid) return json(res, 403, { error: "Invalid invite for this session" });
      if (req.method === "POST" && !fileRoute[2]) {
        const who = await identity(req);
        if (!who) return json(res, 401, { error: "Sign in to attach files." });
        if (!can(await store.state(sid), who.id, "upload")) return json(res, 403, { error: "You don't have permission to attach files in this session." });
        let data: Buffer;
        try {
          data = await readBody(req, MAX_FILE_BYTES);
        } catch {
          return json(res, 413, { error: `Files can be up to ${MAX_FILE_BYTES / 1024 / 1024} MB.` });
        }
        let name = "file";
        try {
          name = decodeURIComponent(String(req.headers["x-file-name"] ?? "file"));
        } catch {
          // keep default
        }
        const type = String(req.headers["content-type"] ?? "");
        // The picker filters, but the picker is the browser's: a file the agent
        // can only read as "binary content not shown" is refused here, where it
        // can be said out loud rather than discovered in the prompt.
        if (!isUsableFile(name, type)) {
          return json(res, 415, { error: `Friday can read text, code, images and PDFs. “${name}” isn't one of those.` });
        }
        const f = await files.save(sid, { name, type, data, uploadedBy: who.id });
        return json(res, 201, { file: { id: f.id, name: f.name, type: f.type, size: f.size } });
      }
      if (req.method === "GET" && fileRoute[2]) {
        if (!(await memberOnly(req, res, sid))) return;
        const f = await files.get(sid, fileRoute[2]);
        if (!f) return json(res, 404, { error: "File not found" });
        // Never render uploaded markup on our own origin.
        const risky = /html|svg|xml|javascript/i.test(f.meta.type);
        res.writeHead(200, {
          "Content-Type": risky ? "application/octet-stream" : f.meta.type,
          "Content-Length": f.data.length,
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": `${risky ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(f.meta.name)}`,
          "Cache-Control": "private, max-age=3600",
        });
        return res.end(f.data);
      }
      return json(res, 405, { error: "Method not allowed" });
    }

    const planRoute = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/plan$/);
    if (req.method === "GET" && planRoute) {
      const sid = planRoute[1]!;
      if (!(await memberOnly(req, res, sid))) return;
      return json(res, 200, { team: false, plan: "free", name: "Solo", workspace: { id: "local", name: "This computer", personal: true } });
    }

    const remoteRoute = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/remote$/);
    if (req.method === "GET" && remoteRoute) {
      const sid = remoteRoute[1]!;
      const inv = verifyInvite(o.secret, url.searchParams.get("invite"));
      if (!inv || inv.sid !== sid) return json(res, 403, { error: "Invalid invite for this session" });
      if (!(await memberOnly(req, res, sid))) return;
      const state = await store.state(sid);
      // The lane that has a folder, preferring one that is online to answer.
      const lane = url.searchParams.get("lane") || Object.entries(state.engines).sort((a, b) => Number(b[1].online) - Number(a[1].online))[0]?.[0] || "";
      if (!lane) return json(res, 200, { remote: {} });
      const remote = await openFolder(sid, { op: "remote" }, lane)
        .then((r) => JSON.parse(r.output) as { url?: string; github?: string | null })
        .catch(() => ({}) as { url?: string; github?: string | null });
      return json(res, 200, { remote });
    }

    const commitMsgRoute = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/commit-message$/);
    if (req.method === "GET" && commitMsgRoute) {
      const sid = commitMsgRoute[1]!;
      const inv = verifyInvite(o.secret, url.searchParams.get("invite"));
      if (!inv || inv.sid !== sid) return json(res, 403, { error: "Invalid invite for this session" });
      const asker = await memberOnly(req, res, sid);
      if (!asker) return;
      const state = await store.state(sid);
      const lane = url.searchParams.get("lane") || Object.keys(state.diffs)[0] || "";
      const files = state.diffs[lane]?.files ?? [];
      // Where a push would go, so the dialog only offers one that can work.
      const remote = await openFolder(sid, { op: "remote" }, lane)
        .then((r) => JSON.parse(r.output) as { url?: string; github?: string | null })
        .catch(() => ({}) as { url?: string; github?: string | null });
      if (!files.length) return json(res, 200, { message: "", branch: "", remote });
      // The ask behind this change: the latest since the last commit, so a second commit isn't named for the first task.
      const log = await store.events(sid);
      const since = log.findLastIndex((e) => e.body.type === "folder.committed");
      const human = (e: SessionEvent) => e.body.type === "instruction" && e.actor.kind === "human";
      const asked = (log.slice(since + 1).find(human) ?? log.find(human))?.body;
      const plain = plainCommitMessage(files, asked?.type === "instruction" ? asked.text : "");
      let message = plain;
      const subject = message.split("\n")[0]!;
      const branch = `friday/${subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "changes"}`;
      return json(res, 200, { message, branch, remote });
    }




    // Saved commands: a prompt the team keeps and runs with /name.
    if (url.pathname === "/api/commands" || url.pathname.startsWith("/api/commands/")) {
      const ctx = await context(req);
      if (!ctx) return json(res, 401, { error: "Sign in first." });
      const { me: user, t } = ctx;
      try {
        if (req.method === "GET" && url.pathname === "/api/commands") return json(res, 200, { commands: await t.commands.list(user.id) });
        if (req.method === "POST" && url.pathname === "/api/commands") {
          const b = await readJson(req);
          return json(res, 201, { command: await t.commands.save(user, { name: b.name, text: b.text, hint: b.hint, scope: b.scope, ...(typeof b.id === "string" ? { id: b.id } : {}) }) });
        }
        const one = url.pathname.match(/^\/api\/commands\/([\w-]{4,40})$/);
        if (one && req.method === "DELETE") {
          await t.commands.remove(user.id, one[1]!);
          return json(res, 200, { ok: true });
        }
        return json(res, 404, { error: "Not found" });
      } catch (err) {
        if (err instanceof CommandError) return json(res, err.status, { error: err.message });
        throw err;
      }
    }

    // Skills: reusable instructions, shared the same way agents are.
    if (url.pathname === "/api/skills" || url.pathname.startsWith("/api/skills/")) {
      const ctx = await context(req);
      if (!ctx) return json(res, 401, { error: "Sign in first." });
      const { me: user, t } = ctx;
      try {
        if (req.method === "GET" && url.pathname === "/api/skills") return json(res, 200, { skills: await t.skills.listFor(user.id), collections: await t.skills.collectionsFor(user.id) });
        // Skills in a GitHub repository: first a look at what is there, then the ones chosen.
        if (req.method === "POST" && url.pathname === "/api/skills/github/discover") {
          const b = await readJson(req);
          const found = await discoverSkills(fetch as never, String(b.url ?? ""));
          const mine = await t.skills.listFor(user.id);
          const have = new Set(mine.filter((x) => x.source && x.source.repo === `${found.repo.owner}/${found.repo.repo}`).map((x) => x.source!.path));
          return json(res, 200, {
            repo: `${found.repo.owner}/${found.repo.repo}`,
            skills: found.skills.map((x) => ({ ...x, added: have.has(x.path) })),
            truncated: found.truncated,
            more: found.more,
            hidden: found.hidden,
          });
        }
        if (req.method === "POST" && url.pathname === "/api/skills/github/import") {
          const b = await readJson(req);
          const r = await importChosen(fetch as never, t.skills, user, String(b.url ?? ""), Array.isArray(b.paths) ? b.paths.map(String) : []);
          return json(res, 200, { created: r.created, updated: r.updated, skipped: r.skipped, leftBehind: r.leftBehind });
        }
        // The whole repository, as one collection.
        if (req.method === "POST" && url.pathname === "/api/skills/github/collection") {
          const b = await readJson(req);
          const r = await importWholeRepo(fetch as never, t.skills, user, String(b.url ?? ""));
          return json(res, 200, r);
        }
        const col = url.pathname.match(/^\/api\/skills\/collections\/([\w-]+)$/);
        if (col && req.method === "GET") return json(res, 200, await t.skills.collectionSkills(user, col[1]!));
        if (col && req.method === "DELETE") {
          const removed = await t.skills.removeCollection(user, col[1]!);
          return json(res, 200, { ok: true, removed });
        }
        if (req.method === "POST" && url.pathname === "/api/skills") return json(res, 201, { skill: await t.skills.create(user, await readJson(req)) });

        const m = url.pathname.match(/^\/api\/skills\/([\w-]+)(\/leave)?$/);
        if (m && req.method === "POST" && m[2]) {
          await t.skills.leaveShared(user, m[1]!);
          return json(res, 200, { ok: true });
        }
        if (m && req.method === "PATCH" && !m[2]) return json(res, 200, { skill: await t.skills.update(user, m[1]!, await readJson(req)) });
        if (m && req.method === "DELETE" && !m[2]) {
          await t.skills.remove(user, m[1]!);
          return json(res, 200, { ok: true });
        }
        return json(res, 404, { error: "Not found" });
      } catch (err) {
        throw err;
      }
    }




    // A pull-request link pasted into the composer: the change to review or carry on, and the branch it is on.
    if (req.method === "GET" && url.pathname === "/api/github/pr") {
      const ctx = await context(req);
      if (!ctx) return json(res, 401, { error: "Not signed in." });
      const ref = parsePrLink(url.searchParams.get("url") ?? "");
      if (!ref) return json(res, 400, { error: "That isn't a GitHub pull request link." });
      try {
        return json(res, 200, { pr: await fetchPr(ref.url, null) });
      } catch (e) {
        return json(res, 502, { error: (e as Error).message });
      }
    }

    // The sessions this person is in, newest first, from the server's own index: the sidebar's list is per browser, this
    // one follows them to any machine.
    // What GitHub says about this session's pull request, for the card that closes the session when it merges.
    const prRoute = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/pr$/);
    if (prRoute && req.method === "GET") {
      const sid = prRoute[1]!;
      if (!(await memberOnly(req, res, sid))) return;
      const events = await store.events(sid);
      const commit = events.findLast((e) => e.body.type === "folder.committed" && !e.body.error && !!e.body.prUrl);
      if (!commit || commit.body.type !== "folder.committed" || !commit.body.prUrl) return json(res, 200, { pr: null });
      const status = await prStatusSoon(sid, commit.lane ?? MAIN_LANE, (await store.state(sid)).workspaceId ?? "", commit.body.prUrl);
      return json(res, 200, { pr: { url: commit.body.prUrl, at: commit.ts, status } });
    }


    if (req.method === "GET" && url.pathname === "/api/sessions/mine") {
      const me = await identity(req);
      if (!me) return json(res, 401, { error: "Not signed in." });
      const rows = await store.mine(me.id);
      const sessions = (
        await Promise.all(
          rows.map(async ({ sid, at }) => {
            const state = await store.state(sid).catch(() => null);
            const m = state?.members[me.id];
            if (!state || !m || m.removed) return null;
            return { sid, title: state.title, role: m.role, invite: linkToken(sid, state, m.role), at };
          }),
        )
      ).filter((s): s is NonNullable<typeof s> => !!s);
      return json(res, 200, { sessions });
    }

    /**
     * What was said in your sessions, searched (session-search.ts).
     *
     * Only sessions you are a member of now, by the same check the session's own log answers to (roleOf on the live state, not
     * the list of sessions you've been in): someone removed, or never let in, finds nothing, and nobody searches a teammate's
     * sessions they aren't in. It reads the stored log, which is what everyone in the session sees, secrets already hidden;
     * never the files or a machine. Bounded: your newest sixty sessions, the last few thousand events of each, twenty results,
     * and thirty searches a minute.
     */
    if (req.method === "GET" && url.pathname === "/api/sessions/search") {
      const me = await identity(req);
      if (!me) return json(res, 401, { error: "Not signed in." });
      const q = (url.searchParams.get("q") ?? "").slice(0, 120);
      if (q.trim().length < 3 || !wordsOf(q).length) return json(res, 200, { results: [] });
      const limit = `${o.prefix}search-rate:${me.id}`;
      const tries = await redis.incr(limit);
      if (tries === 1) await redis.expire(limit, 60);
      if (tries > 30) return json(res, 429, { error: "That's a lot of searching. Try again in a minute." });
      // Narrowed by who said it, what kind of message, and how many days back; ranked by match, or by time.
      const pick = <T extends string>(v: string | null, ok: readonly T[], or: T): T => (ok.includes(v as T) ? (v as T) : or);
      const from = pick(url.searchParams.get("from"), ["any", "me", "people", "agents"] as const, "any");
      const kind = pick(url.searchParams.get("kind"), ["any", "asked", "answer", "comment"] as const, "any");
      const sort = pick(url.searchParams.get("sort"), ["best", "recent"] as const, "best");
      const days = Math.min(366, Math.max(0, Math.floor(Number(url.searchParams.get("days")) || 0)));
      const since = days ? Date.now() - days * 86_400_000 : 0;
      // A title can match on its own only when nothing narrows the messages: a filter is about what was said.
      const titlesToo = from === "any" && kind === "any" && !since;
      const rows = await store.mine(me.id, 60);
      const results = (
        await Promise.all(
          rows.map(async ({ sid, at }) => {
            const state = await store.state(sid).catch(() => null);
            const role = state ? roleOf(state, me.id) : null;
            if (!state || !role) return null;
            const agentName = (lane: string) => {
              const n = laneName(state, lane);
              return n === "Main" ? "Friday" : n;
            };
            const hits = searchEvents(await store.events(sid).catch(() => []), q, 3, 4000, { from, kind, since, me: me.id, agentName });
            const titleMatch = titleMatches(state.title, q);
            if (!hits.length && !(titleMatch && titlesToo)) return null;
            const last = Math.max(at, ...hits.map((h) => h.at));
            return { sid, title: state.title, role, invite: linkToken(sid, state, role), hits, titleMatch, at: last };
          }),
        )
      )
        .filter((r): r is NonNullable<typeof r> => !!r)
        .sort((a, b) => (sort === "recent" ? b.at - a.at : rankOf(b) - rankOf(a) || b.at - a.at))
        .slice(0, 20);
      return json(res, 200, { results });
    }



    // A chat taken off the list stays off it, here and on their other devices, until they open it again.
    if (req.method === "POST" && url.pathname === "/api/sessions/mine/forget") {
      const me = await identity(req);
      if (!me) return json(res, 401, { error: "Not signed in." });
      const { sid } = (await readJson(req)) as { sid?: unknown };
      if (typeof sid !== "string" || !sid || sid.length > 200) return json(res, 400, { error: "Which session?" });
      // Put away by the only one in it: nobody else could reach it again, so it is deleted and its space freed (Arun,
      // 2026-10-19: "make sure the sessions that are deleted free up space"). Shared, it only leaves this person's list.
      const state = await store.state(sid).catch(() => null);
      if (state && state.members[me.id] && aloneIn(state, me.id)) {
        await endSession(sid, "This session was deleted");
        return json(res, 200, { ok: true, deleted: true });
      }
      await store.forget(me.id, sid);
      return json(res, 200, { ok: true });
    }

    // Deleting a session for everyone in it: its owner only, from Friday itself. Everything it kept goes, and its space is freed.
    const deleteSessionRoute = url.pathname.match(/^\/api\/sessions\/([\w-]{4,40})\/delete$/);
    if (req.method === "POST" && deleteSessionRoute) {
      const me = await identity(req);
      if (!me) return json(res, 401, { error: "Not signed in." });
      if (!req.headers.origin || crossSite(req)) return json(res, 403, { error: "Not from Friday." });
      const sid = deleteSessionRoute[1]!;
      // A session whose history is gone (lost from Redis before the archive kept it): nothing is left to delete but its place
      // on this person's list, so that goes, and the delete is done. It said "No such session" and stayed on the list.
      if (!(await store.exists(sid))) {
        await store.forget(me.id, sid);
        return json(res, 200, { ok: true, deleted: true });
      }
      const state = await store.state(sid).catch(() => null);
      if (!state || !roleOf(state, me.id)) return json(res, 404, { error: "No such session." });
      if (roleOf(state, me.id) !== "owner") return json(res, 403, { error: "Only an owner of this session can delete it for everyone. Remove it from your list instead." });
      await endSession(sid, "This session was deleted");
      return json(res, 200, { ok: true, deleted: true });
    }

    // An issue link pasted into the composer, read so the card can show it and the session can start from it.
    if (req.method === "GET" && url.pathname === "/api/github/issue") {
      const ctx = await context(req);
      if (!ctx) return json(res, 401, { error: "Not signed in." });
      const ref = parseIssueUrl(url.searchParams.get("url") ?? "");
      if (!ref) return json(res, 400, { error: "That isn't a GitHub issue link." });
      try {
        return json(res, 200, { issue: await fetchIssue(ref.url, null) });
      } catch (e) {
        return json(res, 502, { error: (e as Error).message });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/attention") {
      const me = await identity(req);
      if (!me) return json(res, 401, { error: "Not signed in." });
      const body = (await readJson(req)) as { sids?: unknown; summaries?: unknown };
      const sids = Array.isArray(body.sids) ? body.sids.filter((v): v is string => typeof v === "string").slice(0, 60) : [];
      // Removed on another device: this one drops them too.
      const hidden = await store.hidden(me.id);
      // And deleted, by its owner or with its team: a session that no longer exists leaves every list it was on.
      const buried = await Promise.all(sids.map((s) => (hidden.has(s) ? true : store.buried(str(s, 200)).catch(() => false))));
      const gone = sids.filter((_, i) => buried[i]);
      const found: Attention[] = [];
      const summaries: SessionSummary[] = [];
      // The same pass answers "which of these is running", which the sidebar
      // had no way to know. Reading the state is the expensive part and it
      // has already happened.
      const working: Working[] = [];
      const previews: Preview[] = [];
      const crews: Crew[] = [];
      const prs: SessionPr[] = [];
      // Only sessions this person is in, so what two of them share can be said
      // without telling anyone about a session they cannot see.
      const mine: SessionState[] = [];
      // Read side by side: one after another was the sum of them, and with a line for each session that adds up.
      const read = await Promise.all(
        sids.map(async (sid) => {
          const state = await store.state(str(sid, 200)).catch(() => null);
          if (!state) return null;
          const m = state.members[me.id];
          if (!m || m.removed) return null;
          const line = body.summaries === true ? summaryOf((await cardsFor(state, me.id).catch(() => null))?.cards ?? []) : null;
          return { state, line };
        }),
      );
      for (const r of read) {
        if (!r) continue;
        const { state, line } = r;
        mine.push(state);
        // The browser knows this session and the log says they are in it: the server-side list learns it too.
        void store.remember(me.id, state.id).catch(() => {});
        found.push(...attentionIn(state, me.id));
        const busy = workingIn(state);
        if (busy) working.push(busy);
        const said = previewOf(state);
        if (said) previews.push(said);
        const crew = crewOf(state);
        if (crew) crews.push(crew);
        const pr = prOf(state);
        if (pr) prs.push(pr);
        if (line) summaries.push(line);
      }
      const theirs: never[] = [];
      return json(res, 200, { items: sortAttention(found), working, previews, crews, prs, overlaps: Object.fromEntries(overlapsAcross([...mine, ...theirs])), ...(body.summaries === true ? { summaries } : {}), ...(gone.length ? { gone } : {}) });
    }

    /**
     * The Agent Board: every agent in the sessions the browser lists, as cards. Same rule as the attention poll: the ids
     * come from the client, and each is checked against the person's membership before anything about it is read.
     * What a session's cards say only changes when its log does, so they are remembered by the last event.
     */
    if (req.method === "POST" && url.pathname === "/api/board") {
      const me = await identity(req);
      if (!me) return json(res, 401, { error: "Not signed in." });
      const body = (await readJson(req)) as { sids?: unknown };
      const sids = Array.isArray(body.sids) ? body.sids.filter((v): v is string => typeof v === "string").slice(0, 60) : [];
      // Sessions are read side by side: the first look at a long list is the slow one, and it is the sum of them otherwise.
      const workspaceOf = new Map<string, string>();
      const weeks: ReturnType<typeof weekOf>[] = [];
      const perSession = await Promise.all(
        sids.map(async (sid): Promise<BoardCard[]> => {
          const state = await store.state(str(sid, 200)).catch(() => null);
          if (!state) return [];
          const m = state.members[me.id];
          if (!m || m.removed) return [];
          const made = await cardsFor(state, me.id);
          if (state.workspaceId) workspaceOf.set(state.id, state.workspaceId);
          weeks.push(made.week);
          // Who is in the room now is not in the log, so it is read fresh each time and never cached with the cards.
          const here = await store.presence(state.id).catch(() => ({}) as Record<string, number>);
          const waiting = waitingOn(state);
          const people = Object.keys(here)
            .filter((id) => state.members[id] && !state.members[id]!.removed)
            .map((id) => ({ id, name: state.members[id]!.name, waiting: waiting.has(id) }));
          return people.length ? made.cards.map((c) => ({ ...c, people })) : made.cards;
        }),
      );
      // The week in three numbers: sessions that began, sessions that shipped something, runs.
      const week = { sessions: weeks.filter((w) => w.created).length, shipped: weeks.filter((w) => w.shipped).length, runs: weeks.reduce((n, w) => n + w.runs, 0) };
      // What GitHub says about each pull request, at the same time; a card whose pull request nobody could ask about stays as the log left it.
      const cards = await Promise.all(
        perSession.flat().map(async (c) => {
          const gh = c.pr ? await prStatusSoon(c.sid, c.lane, workspaceOf.get(c.sid) ?? "", c.pr.url) : null;
          return gh ? applyPrStatus(c, gh) : c;
        }),
      );
      return json(res, 200, { cards: sortCards(cards), week });
    }


    // Automations (automations.ts): everyone in the workspace sees them; only an automation's owner changes it, runs it, or
    // sees its webhook's address, which is its only credential.
    if (url.pathname === "/api/automations" || url.pathname.startsWith("/api/automations/")) {
      const ctx = await context(req);
      if (!ctx) return json(res, 401, { error: "Sign in first." });
      const ws = ctx.workspace.id;
      const me = ctx.me;
      const base = (o.appUrl || selfUrl).replace(/\/+$/, "");
      const view = async (a: Automation) => ({
        ...a,
        when: a.when.kind === "webhook" ? { kind: "webhook", ...(a.ownerId === me.id ? { url: `${base}/api/hooks/automation/${ws}/${a.id}?key=${a.when.secret}` } : {}) } : a.when,
        says: { when: describeWhen(a.when), who: describeWho(a.who) },
        mine: a.ownerId === me.id,
        runs: await automations.runs(ws, a.id, 6),
        today: await automations.runsToday(ws, a.id),
      });
      // A session's events are only for someone in it: watching one hands its agent's last words to the new run.
      const inSession = async (c: ReturnType<typeof cleanAutomation>) => {
        if (c.when.kind !== "session") return c;
        const st = await store.state(c.when.sessionId).catch(() => null);
        const m = st?.members[me.id];
        if (!st || !m || m.removed) throw new Error("Pick a session you're in.");
        return { ...c, when: { ...c.when, sessionTitle: st.title } };
      };
      try {
        if (req.method === "GET" && url.pathname === "/api/automations") {
          return json(res, 200, { automations: await Promise.all((await automations.list(ws)).map(view)) });
        }
        if (req.method === "POST" && url.pathname === "/api/automations") {
          const made: Automation = { id: randomBytes(6).toString("base64url"), ownerId: me.id, ownerName: me.name, created: Date.now(), ...(await inSession(cleanAutomation(await readJson(req)))) };
          await automations.put(ws, made);
          return json(res, 201, { automation: await view(made) });
        }
        const one = url.pathname.match(/^\/api\/automations\/([\w-]{4,40})(\/run|\/runs)?$/);
        if (!one) return json(res, 404, { error: "Not found" });
        const a = await automations.get(ws, one[1]!);
        if (!a) return json(res, 404, { error: "That automation isn't there any more." });
        if (req.method === "GET" && one[2] === "/runs") return json(res, 200, { runs: await automations.runs(ws, a.id, 30) });
        if (a.ownerId !== me.id) return json(res, 403, { error: `This is ${a.ownerName}'s automation: only they can change or run it.` });
        if (req.method === "POST" && one[2] === "/run") {
          const body = (await readJson(req)) as { event?: unknown };
          const run = await runAutomation(ws, a, "Run now", typeof body.event === "string" ? body.event.slice(0, 8000) : "");
          return json(res, 202, { run });
        }
        if (req.method === "PATCH" && !one[2]) {
          const next: Automation = { ...a, ...(await inSession(cleanAutomation(await readJson(req), a))) };
          await automations.put(ws, next, a);
          return json(res, 200, { automation: await view(next) });
        }
        if (req.method === "DELETE" && !one[2]) {
          await automations.remove(ws, a.id);
          return json(res, 200, { ok: true });
        }
        return json(res, 404, { error: "Not found" });
      } catch (e) {
        return json(res, 400, { error: (e as Error).message });
      }
    }





    const audit = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/audit$/);
    if (req.method === "GET" && audit) {
      const sid = audit[1]!;
      const inv = verifyInvite(o.secret, url.searchParams.get("invite"));
      if (!inv || inv.sid !== sid) return json(res, 403, { error: "Invalid invite for this session" });
      if (!(await memberOnly(req, res, sid))) return;
      const events = await store.events(sid);
      if (url.searchParams.get("format") === "text") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end(events.map(auditLine).join("\n") + "\n");
      }
      return json(res, 200, { sessionId: sid, exportedAt: new Date().toISOString(), events });
    }

    /**
     * The folder this session is working in, for the people watching.
     *
     * The agents read it through the same bridge; this is the same read, for
     * the browser, so the tree view shows what is actually on the machine
     * rather than a guess assembled from whatever happens to be in the log.
     * Reading only — anything that changes the folder goes through an agent,
     * where the room can see it happen.
     */
    const repoRoute = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/repo$/);
    if (req.method === "GET" && repoRoute) {
      const sid = repoRoute[1]!;
      const inv = verifyInvite(o.secret, url.searchParams.get("invite"));
      if (!inv || inv.sid !== sid) return json(res, 403, { error: "Invalid invite for this session" });
      const me = await memberOnly(req, res, sid);
      if (!me) return;
      // A viewer sees files as the log shows them, secrets hidden; exact bytes are for the editor's save path.
      const viewer = (await store.state(sid)).members[me.id]?.role === "viewer";
      /**
       * Reading only, and by name.
       *
       * Anything not called "read" used to be answered with a file listing,
       * which is how asking for branches got back "412 files under the
       * repository root" and the picker showed a JSON parse error at position
       * three. A request this route doesn't serve is now refused as one,
       * rather than quietly served something else.
       */
      const op = str(url.searchParams.get("op") ?? "tree", 20) || "tree";
      if (!READ_OPS.has(op)) return json(res, 400, { error: `This route only reads: ${[...READ_OPS].join(", ")}. Anything that changes the folder goes through an agent, where the room can see it.` });
      const path = str(url.searchParams.get("path") ?? "", 400);
      const raw = url.searchParams.get("raw") === "1";
      if (viewer && raw) return json(res, 403, { error: "Viewers can read files, not their raw bytes" });
      // The `/` commands of the lane's own coding tool: from that lane's machine only, never another lane's tool, and never
      // remembered from one that has gone (folderForPeople).
      if (op === "commands") {
        const live = await hub.readRepo(sid, { op: "commands" }, str(url.searchParams.get("lane") ?? "", 40) || "main");
        return json(res, 200, { output: live?.output ?? JSON.stringify({ commands: [] }) });
      }
      // The session's environment (the status bar's Environment button), from the machine its agents work on, live: what a
      // machine that has gone said last is not what it is now. Names of variables, never their values.
      // A coding tool's context by category (the usage card), from that lane's own tool: Claude Code's /context.
      if (op === "context") {
        const live = await hub.readRepo(sid, { op: "context" }, str(url.searchParams.get("lane") ?? "", 40) || "main").catch(() => null);
        return json(res, 200, { output: live?.output ?? JSON.stringify({ context: null }) });
      }
      if (op === "environment") {
        const live = await hub.readRepo(sid, { op: "environment" }, str(url.searchParams.get("lane") ?? "", 40) || "main").catch(() => null);
        return json(res, 200, { output: live?.output ?? JSON.stringify({ error: "No computer is working in this session right now." }) });
      }
      // The Git panel's reads: git's own status, history, one commit, the staged or unstaged diff, and a comparison to a branch.
      const ref = str(url.searchParams.get("ref") ?? "", 120);
      const call: RepoCall =
        op === "read" ? { op: "read", path, person: true, personId: me.id, ...(raw ? { raw: true } : {}) }
        : op === "branches" ? { op: "branches" }
        : op === "remote" ? { op: "remote" }
        : op === "status" ? { op: "status" }
        : op === "log" ? { op: "log", limit: Number(url.searchParams.get("limit")) || 30, ...(path ? { path } : {}) }
        : op === "show" ? { op: "show", ref }
        : op === "gitdiff" ? { op: "gitdiff", staged: url.searchParams.get("staged") === "1", ...(path ? { path } : {}) }
        : op === "compare" ? { op: "compare", ref }
        : { op: "tree", path };
      const dir = str(url.searchParams.get("dir") ?? "", 1000);
      const r = (await folderForPeople(sid, dir && !dir.includes("..") ? { ...call, dir } : call, str(url.searchParams.get("lane") ?? "", 40) || undefined)) as { output: string; where?: unknown; stale?: { at: number; reason: string } };
      if (op === "branches") await noteBranch(sid, str(url.searchParams.get("lane") ?? "", 40) || undefined, r.output).catch(() => {});
      // A file that couldn't be read is an error, not a file whose text is the reason: an editor would offer to save it.
      if (op === "read" && raw && readFailed(r.output)) return json(res, 200, { error: r.output });
      return json(res, 200, { output: viewer && op === "read" ? hideSecrets(r.output).text : r.output, ...(r.where ? { where: r.where } : {}), ...(r.stale ? { stale: r.stale } : {}) });
    }


    /**
     * Repositories from a connected GitHub, for people with no machine linked.
     *
     * The machine answers this too, through the gh CLI it has installed. This
     * is the same question asked of the workspace's own connection, so the
     * GitHub section isn't empty for somebody who connected GitHub but never
     * linked a laptop.
     */
    if (req.method === "GET" && url.pathname === "/api/github/repos") {
      const ctx = await context(req);
      if (!ctx) return json(res, 401, { error: "Sign in first." });
      return json(res, 200, { connection: "", repos: [] });
    }




    // The open-source edition: each coding tool's usage on this computer, for the Usage page and the home screen's year. The
    // hosted service answers these for a workspace, below.
    // The page asks for its workspace as it loads (index.html): there is none here, which is an answer, not a missing page.
    if (o.local && req.method === "GET" && url.pathname === "/api/workspace") return json(res, 200, {});
    if (o.local && req.method === "GET" && (url.pathname === "/api/workspace/tool-usage" || url.pathname === "/api/workspace/tool-activity")) {
      if (url.pathname === "/api/workspace/tool-activity") {
        const days = Math.min(371, Math.max(1, Number(url.searchParams.get("days")) || 371));
        return json(res, 200, { days: await toolUsage.daily(LOCAL_WORKSPACE.id, days) });
      }
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 30));
      const [history, recent] = await Promise.all([toolUsage.history(LOCAL_WORKSPACE.id, days), toolUsage.recent(LOCAL_WORKSPACE.id)]);
      const since = Date.now() - days * 86_400_000;
      return json(res, 200, { days: history, recent: recent.filter((r) => r.at >= since) });
    }


    // ── signing in ───────────────────────────────────────────────────
    // The only routes that work without an account, and the only ones that
    // can hand one out.
    const secure = () => (req.headers["x-forwarded-proto"] ?? "").toString().split(",")[0]?.trim() === "https" || (o.appUrl ?? "").startsWith("https:");
    const origin = () => o.appUrl?.replace(/\/$/, "") || `${secure() ? "https" : "http"}://${req.headers.host ?? `localhost:${o.port}`}`;
    const callbackUrl = (id: string) => `${origin()}/auth/${id}/callback`;
    const signInPage = (msg?: string) => {
      const to = new URL("/", origin());
      to.searchParams.set("signin", "1");
      if (msg) to.searchParams.set("error", msg.slice(0, 200));
      return to.pathname + to.search;
    };








    if (req.method === "GET" && url.pathname === "/api/build") {
      res.setHeader("Cache-Control", "no-store");
      return json(res, 200, { build: await buildId() });
    }

    if (req.method === "GET" && url.pathname === "/api/me") {
      const me = await identity(req);
      // The desktop app asks this as it opens, signed in or not: its launch, its first one, and who the install is (analytics.ts).
      const install = String(req.headers["x-friday-install"] ?? "");
      const launch = String(req.headers["x-friday-launch"] ?? "");
      if (!me) return json(res, 401, { error: "Not signed in." });
      return json(res, 200, { user: publicAccount(me) });
    }



    // The open-source edition's name for the person at this computer, kept with everything else here.
    if (o.local && req.method === "PATCH" && url.pathname === "/api/me") {
      const name = String((await readJson(req)).name ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
      if (!name) return json(res, 400, { error: "Give a name." });
      await redis.set(`${o.prefix}local:name`, name);
      return json(res, 200, { user: publicAccount((await identity(req))!) });
    }




    // ── signing the desktop app in, in the person's own browser ─────────
    //
    // The app opens these in the browser rather than in its own window, so
    // the session lands somewhere this app cannot read. These four routes are
    // how it gets back: start one, let the person approve it next door, and
    // spend it once. DesktopPairings carries the reasoning.

















    if (req.method === "GET" && url.pathname === "/api/info") return sendInfo(res);

    const shared = null;





    // Developing (hot), the bundle as it is now, rebuilt after a change; otherwise the one built at start.
    const asset = req.method === "GET" ? (hot.on ? ((await bundleClient()).get(url.pathname) ?? hotChunks.get(url.pathname)) : bundle.get(url.pathname)) : undefined;
    if (asset) {
      const hashed = url.pathname.startsWith("/chunks/") || url.pathname.startsWith("/assets/");
      // The entry files keep their names between builds, so they revalidate (a "not modified" when nothing changed); the hashed ones never change.
      return sendAsset(req, res, `${url.pathname}#${bodyId(asset.body)}`, asset.body, asset.type, hashed ? "public, max-age=31536000, immutable" : "no-cache", asset.br);
    }

    if (req.method === "GET" && hotStream(req, res)) return;
    // An address under /api that no route answered is a missing API, not a page of the app (Testing API-4).
    if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "Not found" });
    if (req.method === "GET") return serveStatic(req, url.pathname, res);
    json(res, 404, { error: "Not found" });
  }

  /** Links for the roles whose link is currently enabled, at the current version. */
  function invitesFor(sid: string, state: SessionState) {
    return {
      ...(state.links.editor.enabled ? { editor: signInvite(o.secret, sid, "editor", state.links.editor.version) } : {}),
      ...(state.links.viewer.enabled ? { viewer: signInvite(o.secret, sid, "viewer", state.links.viewer.version) } : {}),
      // The recording goes with the viewer link: same reach, no seat.
      ...(state.links.viewer.enabled ? { replay: signReplay(o.secret, sid, state.links.viewer.version) } : {}),
    };
  }
  const mayInvite = (state: SessionState, userId: string) => can(state, userId, "invite");

  /**
   * Who may read a session over plain HTTP: somebody signed in, holding one of its invites, who is still in it.
   *
   * An invite alone used to be enough, and an invite is only a signature: it keeps verifying after the owner turns that link off or
   * replaces it, and after the person holding it has been removed. The room's own socket checks all of that when somebody joins; these
   * routes did not, so a link the owner had revoked still read the session's log, files and the folder on the host's machine. They
   * answer the same question the socket does: are you, right now, a member of this session?
   */
  async function memberOnly(req: http.IncomingMessage, res: http.ServerResponse, sid: string): Promise<{ id: string; name: string } | null> {
    const inv = verifyInvite(o.secret, new URL(req.url ?? "/", "http://localhost").searchParams.get("invite"));
    if (!inv || inv.sid !== sid) return (json(res, 403, { error: "Invalid invite for this session" }), null);
    const me = await identity(req);
    if (!me) return (json(res, 401, { error: "Sign in to see this session." }), null);
    const m = (await store.state(sid)).members[me.id];
    if (!m || m.removed) return (json(res, 403, { error: m?.removed ? "You were removed from this session." : "Join this session first." }), null);
    return me;
  }

  // ── WebSocket gateway ────────────────────────────────────────────
  // Two socket endpoints on one server: people on /ws, coding-agent runners on
  // /runner. With several servers on one port, ws needs routing done by hand.
  // People's sockets are compressed: joining a session sends its whole log in one message, and JSON shrinks five to ten
  // times. Small messages skip it, and no context is kept between messages, to spare the memory. Each server has a size
  // cap well under ws's 100 MB default, so no one message can take the server's memory with it.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 << 20, perMessageDeflate: { threshold: 16 * 1024, serverNoContextTakeover: true, clientNoContextTakeover: true } });
  const runnerWss = new WebSocketServer({ noServer: true, maxPayload: 64 << 20 });
  const linkWss = new WebSocketServer({ noServer: true, maxPayload: 64 << 20 });
  // Every one of these carries long silences — a linked machine nobody is
  // instructing, a session nobody is typing in — and silence is what gets a
  // connection closed by something in the middle, or quietly abandoned by a
  // laptop that went to sleep.
  // A browser's terminals on one of its owner's machines (registry termOpen, src/runner/terminals.ts).
  const termWss = new WebSocketServer({ noServer: true, maxPayload: 4 << 20 });
  const stopBeats = ([[wss, "page"], [runnerWss, "runner"], [linkWss, "link"], [termWss, "term"]] as const).map(([w, name]) => heartbeat(w, undefined, name));
  server.on("upgrade", (req, socket, head) => {
    if (o.local && !localOnly(req, appOrigin)) return void socket.destroy();
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    const target = p === "/ws" ? wss : p === "/runner" ? runnerWss : p === "/link" ? linkWss : p === "/term" ? termWss : null;
    if (!target || closing || onPreviewHost(req)) return void socket.destroy();
    target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
  });

  /**
   * Checks an invite and records the member, resolving their role: the stored
   * one if they've joined before, the link's otherwise. Returns why they can't
   * join, or null.
   */
  async function admit(sid: string, inv: ReturnType<typeof verifyInvite>, me: Member): Promise<{ code: number; reason: string } | null> {
    if (!inv || inv.sid !== sid || !me.id || !me.name) return { code: 4001, reason: "Invalid invite link" };
    // A good link to a session whose log is in neither Redis nor the archive: said as what it is, not as a bad link.
    if (!(await store.exists(sid))) return { code: 4001, reason: SESSION_GONE };
    const state = await store.state(sid);
    const existing = state.members[me.id];
    if (existing?.removed) return { code: 4003, reason: "You were removed from this session" };
    if (existing) {
      // The session decides your role once you've joined, not the link.
      me.role = existing.role;
    } else {
      if (inv.role !== "owner") {
        const link = state.links[inv.role];
        if (!link.enabled || link.version !== inv.v) return { code: 4001, reason: "This invite link was turned off or replaced. Ask the owner for a new one." };
        me.role = inv.role;
      } else if (me.id === state.ownerId) {
        me.role = "owner";
      } else {
        // The owner's own link is in the address bar of every session they open, and that is where people copy a link from.
        // Anyone else arriving with it comes in as the editor link would let them (and only watches, on Solo, below), never
        // as an owner: it used to hand whoever was sent the address the whole session.
        const as = state.links.editor.enabled ? "editor" : state.links.viewer.enabled ? "viewer" : null;
        if (!as) return { code: 4001, reason: "This session's invite links are turned off. Ask the owner for a new one." };
        // Signed at the editor link's version (linkToken), whichever link it lets them in as: replacing the editor link also stops
        // an owner address that was copied. An address bar not reloaded since comes in only for the owner.
        if (inv.v !== state.links.editor.version) return { code: 4001, reason: "This invite link was turned off or replaced. Ask the owner for a new one." };
        me.role = as;
      }
    }
    const recorded: Member = { ...me };
    await store.ensureMember(sid, recorded, state);
    return null;
  }




  ops.gauge("runners", () => runnerWss.clients.size);
  ops.gauge("links", () => linkWss.clients.size);
  runnerWss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const q = (k: string, n: number) => (url.searchParams.get(k) ?? "").trim().slice(0, n);
    const sid = q("session", 64);
    const me: Member = { id: "", name: "", role: "viewer" };
    track(
      (async () => {
        const actor = verifyActor(o.secret, url.searchParams.get("token"), sid);
        // A token minted before the account ended its sessions is no permission at all.
        const account = actor ? await localNamed() : null;
        if (!account) return closeSaying(ws, 4001, "This runner has no permission to act in that session. Start it from Friday again.");
        me.id = account.id;
        me.name = account.name;
        runnersOnline.set(ws, account.id);
        ws.on("close", () => runnersOnline.delete(ws));
        const why = await admit(sid, verifyInvite(o.secret, url.searchParams.get("invite")), me);
        if (why) return closeSaying(ws, why.code, why.reason);
        const attaching = performance.now();
        await hub.attach(ws, {
          sid,
          me,
          tool: q("tool", 20),
          mode: q("mode", 10),
          handMode: q("handMode", 10) || undefined,
          cwd: q("cwd", 400),
          copyOf: q("copyOf", 400),
          ...(q("share", 2) === "1" ? { share: true } : {}),
          real: q("real", 400),
          root: q("root", 400),
          os: q("os", 10),
          machine: q("machine", 60),
          shell: q("shell", 20),
          efforts: q("efforts", 60),
          model: q("model", 60),
          account: q("account", 40) || undefined,
          accountLabel: q("accountLabel", 40) || undefined,
          branch: q("branch", 100),
          lane: q("lane", 40),
          newLane: q("newLane", 40),
          resumeId: q("resumeId", 100) || undefined,
          resumeTitle: q("resumeTitle", 120),
          resumeMessages: Number(q("resumeMessages", 10)) || 0,
          resumeTool: q("resumeTool", 20) || undefined,
          caps: q("caps", 100),
        });
        slowly(`a runner attaching to ${sid}`, attaching);
      })().catch((err) => {
        console.error("[runner]", err);
        closeSaying(ws, 1011, "Server error");
      }),
    );
  });

  async function broadcastPresence(sid: string) {
    const [state, online] = await Promise.all([store.state(sid), store.presence(sid)]);
    const list: PresenceMember[] = Object.entries(state.members)
      .filter(([, m]) => !m.removed)
      .map(([id, m]) => ({ id, name: m.name, role: m.role, online: (online[id] ?? 0) > 0 }));
    await bus.publish(sid, { kind: "presence", members: list });
    const here = list.filter((m) => m.online).length;
  }

  /**
   * If a lane's driver stays disconnected past the grace period, hand that wheel to the oldest online requester for it, or
   * release it. One timer per person and lane. The append is conditional on that person still driving, so a reconnect or a
   * manual yield in the meantime wins, and duplicate timers on other nodes are harmless.
   */
  function scheduleHandoff(sid: string, userId: string, lane: string) {
    if (closing) return;
    const key = `${sid}|${userId}|${lane}`;
    const old = handoffs.get(key);
    if (old) {
      clearTimeout(old);
      timers.delete(old);
    }
    const t = setTimeout(async () => {
      timers.delete(t);
      if (handoffs.get(key) === t) handoffs.delete(key);
      if (closing) return;
      try {
        const online = await store.presence(sid);
        if ((online[userId] ?? 0) > 0) return;
        const state = await store.state(sid);
        if (driverOf(state, lane)?.id !== userId) return;
        // Their own coding tool, connected from their machine, is them being there: a CLI run with no page open keeps its wheel.
        const engine = state.engines[lane];
        if (engine?.online && engine.hostId === userId) return;
        // An ask for this wheel, from somebody still allowed it: an ask for another agent's, or one the policy has since
        // taken away, handed the wheel to a person who could not have taken it themselves.
        const next = state.pendingRequests.find((r) => r.lane === lane && (online[r.id] ?? 0) > 0 && canDriveLane(state, r.id, lane));
        const system = { id: "system", name: "System", kind: "system" as const };
        if (next) {
          await store.append(
            sid,
            system,
            { type: "control.granted", to: next.id, toName: next.name, reason: "handoff" },
            { expectDriver: userId, setDriver: { id: next.id, name: next.name }, lane },
          );
        } else {
          await store.append(sid, system, { type: "control.released", from: userId, reason: "disconnect" }, { expectDriver: userId, setDriver: { id: "", name: "" }, lane });
        }
      } catch (err) {
        console.error("[handoff]", err);
      }
    }, o.driverGraceMs);
    handoffs.set(key, t);
    timers.add(t);
  }

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const sid = url.searchParams.get("session") ?? "";
    const inv = verifyInvite(o.secret, url.searchParams.get("invite"));
    // Who is connecting comes from the cookie, never from the query string: a
    // socket used to be able to name itself anyone.
    const tok = verifySession(o.secret, readCookie(req.headers.cookie, SESSION_COOKIE));
    const me: Member = { id: "", name: "", role: "viewer" };

    const send = (m: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
    let unsub: (() => Promise<void>) | null = null;
    let joined = false;
    let live = false;
    let lastSent = 0;
    /**
     * After a hello that carried only its newest events (`tail`), where the older part ends: read again from the store when the
     * page asks for it, rather than a copy held per socket (a link left in a background tab might never ask).
     */
    let earlierBefore: number | null = null;
    // The last of this process's streamed deltas already in the text sent with the hello (Bus.liveText).
    let deltaUpTo = 0;
    const buffered: [BusMessage, string][] = [];
    // A bus message goes on as it was published, already the shape the page reads, not stringified again for every socket.
    const pass = (raw: string) => ws.readyState === WebSocket.OPEN && ws.send(raw);

    const pushInvites = async () => {
      const st = await store.state(sid);
      send({ kind: "invites", invites: mayInvite(st, me.id) ? invitesFor(sid, st) : null });
    };

    const sendEvent = (event: SessionEvent, raw: string) => {
      if (event.seq <= lastSent) return;
      lastSent = event.seq;
      pass(raw);
      const b = event.body;
      if (b.type === "member.removed" && b.userId === me.id) {
        closeSaying(ws, 4003, "You were removed from this session");
      } else if (b.type === "link.updated" || (b.type === "member.role_changed" && b.userId === me.id) || (b.type === "session.updated" && b.options.policy)) {
        track(pushInvites());
      }
    };
    /** The logged events after the last one sent, up to (not including) `before`: what a lost bus message left out. */
    const catchUp = async (before = Infinity) => {
      const events = await store.events(sid);
      for (const event of events.slice(lastSent, Math.min(before - 1, events.length))) sendEvent(event, JSON.stringify({ kind: "event", event: hideSecretsIn(event) }));
    };
    // One at a time, in the order they came: a gap is filled from the log (async) before the event after it goes.
    let chain: Promise<unknown> = Promise.resolve();
    const inOrder = (f: () => unknown) => {
      chain = chain.then(f).catch((e) => closingOr("[ws] forward", e));
    };
    const resync = () => inOrder(() => catchUp());

    // Subscribe first, then snapshot, then flush anything that arrived in
    // between (deduped by seq), so a joiner never misses or repeats an event.
    const forward = (m: BusMessage, raw: string) => {
      if (!live) return void buffered.push([m, raw]);
      inOrder(async () => {
        if (m.kind === "delta" && m.origin === DELTA_ORIGIN && m.n !== undefined && m.n <= deltaUpTo) return;
        if (m.kind !== "event") return void pass(raw);
        if (m.event.seq > lastSent + 1) await catchUp(m.event.seq);
        sendEvent(m.event, raw);
      });
    };

    const reject = (code: number, why: string) => {
      closeSaying(ws, code, why);
      throw new Error("rejected");
    };

    const ready = (async () => {
      // Fill in who this is before anything asks: no account, no session.
      // In a session, too, by the name they gave themselves, not this computer's account name.
      const account = await localNamed();
      if (!account) reject(4001, "Sign in to join this session.");
      me.id = account!.id;
      me.name = account!.name;
      online.set(ws, me.id);
      watching.set(ws, sid);
      const why = await admit(sid, inv, me);
      if (why) reject(why.code, why.reason);
      // Before the snapshot, so it doesn't show an agent as attached whose server died with it.
      await hub.reap(sid).catch((e) => console.error("[engine] reap:", e));
      unsub = await bus.subscribe(sid, forward);
      const seen = await store.getSeen(sid, me.id);
      // The cached state, copied, rather than a fold of the whole log on every join. The cache's own events array grows
      // while this awaits, so it is cut at the state's last seq: one more event in it than the state knows of would reach
      // the page twice, once here and once from the bus buffer.
      const opened = performance.now();
      const state = structuredClone(await store.state(sid));
      const events = (await store.events(sid)).slice(0, state.lastSeq);
      const digest = seen > 0 ? buildDigest(events.filter((e) => e.seq > seen), state, me, seen) : null;
      lastSent = state.lastSeq;
      // A page coming back with the log up to `since` already gets only what came after it: a long session's whole log was
      // tens of megabytes on every reconnect, and a slow link could miss the heartbeat while it came and never get in.
      const since = Number(url.searchParams.get("since"));
      const partial = Number.isInteger(since) && since > 0 && since <= state.lastSeq;
      const phone = url.searchParams.get("view") === "phone";
      // A coding turn running on any server whose changes aren't logged until it ends: shown now, not at the tool's next
      // edit. Read after subscribing, so a newer one published since is in the buffer and is sent after it.
      const held = await hub.heldDiffs(sid, state);
      // What each agent has typed of its current answer: read after the state and in the tick the hello goes, so a message
      // already in the state is no longer held (SessionStore.appendAll clears it first) and none is shown twice.
      const typed = bus.liveText(sid);
      deltaUpTo = typed.upTo;
      // The phone asks for only what its feed draws (phone-log.ts), not a long session's whole log.
      // The desktop app gets each lane's latest change set whole and the older ones without their patches, fetched as they are
      // opened (patches.ts): a long session's change sets were most of a message that ran the server out of memory.
      const from = partial ? events.slice(since) : events;
      // A page that asks for the whole log with `tail=N` gets its newest N events in the hello, and the rest ("earlier") when it
      // asks, once it has drawn them: it draws the feed before a long session's whole log is in, and the rest doesn't share the
      // line with its first paint. The state is the whole session's either way.
      const tail = Number(url.searchParams.get("tail"));
      const cut = !partial && !phone && Number.isInteger(tail) && tail > 0 && from.length > tail ? from.length - tail : 0;
      // Only what is sent is made: a long session's whole log went through lightLog on every open, to send its last few hundred.
      // As logged: what reaches back past the newest events the cache holds whole (a page away a long while, or one asking for
      // the whole log) has its tool output read back whole (store.ts asLogged).
      const log = phone ? phoneLog(from) : (await store.asLogged(sid, cut ? from.slice(cut) : from)).map(lightener(events));
      const built = performance.now();
      send({
        kind: "hello",
        you: { ...me, role: roleOf(state, me.id) ?? me.role },
        state,
        events: log,
        ...(partial ? { since } : {}),
        ...(cut ? { earlier: cut } : {}),
        digest,
        // How far this person had read, so a first visit can be told from a return.
        seenSeq: seen,
        invites: mayInvite(state, me.id) ? invitesFor(sid, state) : undefined,
      });
      slowly(`hello for ${sid}`, opened, { built: built - opened, sent: performance.now() - built, events: log.length });
      if (cut) earlierBefore = from[cut]!.seq;
      live = true;
      if (ws.readyState === WebSocket.OPEN) resyncs.add(resync);
      for (const m of typed.deltas) send(m);
      for (const m of held) send(m);
      for (const [m, raw] of buffered.splice(0)) forward(m, raw);
      await store.presenceChange(sid, me.id, 1);
      joined = true;
      await broadcastPresence(sid);
      // Handed to them for when they were next here: the wheel is theirs now. Not taken from somebody who is driving it right
      // now (who took it since): that waits, still offered, until it is free.
      const st = await store.state(sid);
      if (st.handover?.to === me.id && !st.handover.taken && roleOf(st, me.id) && roleOf(st, me.id) !== "viewer") {
        const d = st.driver;
        const online = await store.presence(sid);
        if (!d || d.id === st.handover.from.id || !((online[d.id] ?? 0) > 0)) {
          await store
            .append(sid, { id: "system", name: "System", kind: "system" }, { type: "control.granted", to: me.id, toName: me.name, reason: "handoff" }, { ...(d ? { expectDriver: d.id } : {}), setDriver: { id: me.id, name: me.name } })
            .catch((e) => console.error("[handover]", e));
        }
      }
    })();
    // A refusal (reject) has closed the socket already. Anything else failed partway in, say Redis went for a moment: a socket
    // left open with no hello is a page that says nothing and never retries, so it is closed as a hiccup the page comes back from.
    track(
      ready.catch((err) => {
        if (err instanceof Error && err.message === "rejected") return;
        console.error("[ws] join:", err);
        closeSaying(ws, 1011, "Server hiccup, reconnecting");
      }),
    );

    let lastFocusAt = 0;
    const onMessage = async (raw: WebSocket.RawData) => {
      try {
        await ready;
      } catch {
        return;
      }
      if (closing) return;
      let msg: { type?: string; rid?: string; id?: string; seq?: number };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return send({ kind: "result", ok: false, error: "Malformed message" });
      }
      try {
        // The page asking whether its socket still leads anywhere (see useSession).
        if (msg.type === "ping") return send({ kind: "pong" });
        // The rest of the log after a tail hello, once.
        if (msg.type === "earlier") {
          const before = earlierBefore;
          earlierBefore = null;
          if (before === null) return;
          // Through lightLog over the log as it is now, as the hello's events were: the same events, patches kept or left out the same way.
          // In pieces, newest first, with the server free between them: a long session's older log was one message of many
          // megabytes, made and written in one go, and every socket on the server waited seconds for it (the [stall]s).
          // Each piece goes in front of what the page holds, so it is whole once the last (`more` false) is in.
          const all = await store.events(sid);
          const light = lightener(all);
          const older = all.slice(0, Math.max(0, before - 1));
          const t0 = performance.now();
          for (let end = older.length; end > 0; end -= EARLIER_PIECE) {
            if (ws.readyState !== WebSocket.OPEN) return;
            // As logged: the cache holds old tool output trimmed (store.ts KEEP_WHOLE), and a page scrolling back shows it whole.
            const piece = await store.asLogged(sid, older.slice(Math.max(0, end - EARLIER_PIECE), end));
            if (ws.readyState !== WebSocket.OPEN) return;
            send({ kind: "earlier", events: piece.map(light), more: end > EARLIER_PIECE });
            await new Promise((r) => setImmediate(r));
          }
          return slowly(`earlier for ${sid}`, t0, { events: older.length });
        }
        if (msg.type === "ack") {
          if (Number.isInteger(msg.seq)) await store.setSeen(sid, me.id, msg.seq!);
          return;
        }
        // Where this person is looking, passed on to the room as it moves. Not a command and not logged. Paced here as well as
        // in the page: a client that sends faster than people can look is not one worth listening to.
        if (msg.type === "focus") {
          const now = Date.now();
          if (now - lastFocusAt < 60) return;
          lastFocusAt = now;
          const at = cleanFocus((msg as { at?: unknown }).at);
          if (at) await bus.publish(sid, { kind: "focus", id: me.id, at });
          return;
        }
        /**
         * The reply's correlation id, which is the client's `rid`.
         *
         * It used to be `id`, in the same flat object as the command — so a
         * command with an `id` of its own had it silently overwritten by the
         * request id on the way out. `thread.reply` was the first command to
         * carry one, and it arrived addressed to a thread that never existed.
         */
        const rid = msg.rid ?? msg.id;
        const { rid: _rid, ...cmd } = msg;
        const r = await core.handle(sid, { id: me.id, name: me.name }, cmd as Command);
        send({ kind: "result", id: rid, ...r });
        if (r.ok && (msg.type === "member.role" || msg.type === "member.remove")) await broadcastPresence(sid);
      } catch (err) {
        console.error("[ws]", err);
        send({ kind: "result", id: msg.rid ?? msg.id, ok: false, error: "Server error" });
      }
    };

    const onClose = async () => {
      // A join that failed after it subscribed or counted them present is undone as fully as one that went in.
      await ready.catch(() => {});
      // Each step on its own: one Redis error must not leave them counted present, a ghost cursor, or the wheel never handed on.
      const step = async (what: string, f: () => Promise<unknown>) => {
        try {
          await f();
        } catch (err) {
          console.error(`[ws] leave ${what}:`, err);
        }
      };
      await step("unsubscribe", async () => unsub?.());
      // On shutdown, leave presence alone: this node's connections are going
      // away together, and another node (or the restart) owns the session next.
      if (!joined || closing) return;
      // Unknown if the count failed: taken as their last, since the handoff checks presence again before it moves anything.
      let n = 0;
      await step("presence", async () => (n = await store.presenceChange(sid, me.id, -1)));
      // Gone from the room's view too, once their last connection is: a ghost cursor is worse than none.
      if (n === 0) await step("focus", () => bus.publish(sid, { kind: "focus", id: me.id, at: null }));
      await step("broadcast", () => broadcastPresence(sid));
      if (n === 0)
        await step("handoff", async () => {
          const state = await store.state(sid);
          for (const l of [MAIN_LANE, ...state.lanes.map((x) => x.id)]) if (driverOf(state, l)?.id === me.id) scheduleHandoff(sid, me.id, l);
        });
    };

    ws.on("message", (raw) => track(onMessage(raw)));
    ws.on("close", () => {
      online.delete(ws);
      watching.delete(ws);
      resyncs.delete(resync);
      track(onClose());
    });
  });

  // On someone's own computer, nobody else's: this computer's own address only, never the network it is on.
  await new Promise<void>((resolve) => (o.local ? server.listen(o.port, "127.0.0.1", resolve) : server.listen(o.port, resolve)));
  const port = (server.address() as { port: number }).port;
  selfUrl = `http://127.0.0.1:${port}`;
  // The open-source edition: the coding tools this computer had in its sessions come back as Friday starts, in the background,
  // so a session opens with its tool already there (reattach.ts; the hosted service does the same as a computer links).
  if (o.local) {
    const me = o.local.user;
    void reattachAll(me, {
      mine: (uid, n) => store.mine(uid, n),
      state: (sid) => store.state(sid).catch(() => null),
      invite: linkToken,
      actorToken: (sid, uid) => signActor(o.secret, sid, uid),
      start: (params) => callHost("start", params, hostCtx(me)),
      log: (l) => console.log(`[friday] ${l}`),
    }).catch((e) => console.error("[friday] bringing coding tools back:", e));
  }
  // A mock dataset has people but nobody at a keyboard: let the ones shown as online walk around, so following and reading marks can be seen.
  const stopMockFocus = o.prefix.startsWith("mock") ? startMockFocus({ redis, prefix: o.prefix, store, bus }) : () => {};

  return {
    url: `http://localhost:${port}`,
    store,
    bus,
    hubs,
    core,
    hub,
    tenant,
    files,
    shepherds: { tick: tickShepherds },
    resumes: { tick: tickResumes },
    boards: { tick: tickBoards },
    mesh,
    async close() {
      closing = true;
      clearInterval(shepherdLoop);
      clearInterval(resumeLoop);
      clearInterval(wakeLoop);
      clearInterval(boardLoop);
      stopMockFocus();
      for (const stop of stopBeats) stop();
      for (const r of localRunners.values()) r.stop();
      await hub.shutdown();
      for (const c of [...wss.clients, ...runnerWss.clients, ...linkWss.clients, ...termWss.clients]) c.terminate();
      await new Promise<void>((r) => linkWss.close(() => r()));
      await new Promise<void>((r) => runnerWss.close(() => r()));
      await new Promise<void>((r) => wss.close(() => r()));
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await drain();
      for (const t of timers) clearTimeout(t);
      await runtime.shutdown();
      await drain();
    },
  };
}

// ── helpers ─────────────────────────────────────────────────────────

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** A request from another site: its own page can't be trusted to speak for this one. */
/**
 * Whether a request to the open-source edition is this computer's own page asking. It has no sign-in: anything that reaches
 * it can run commands through the coding tools, so it listens on 127.0.0.1 only, and also refuses a request naming any other
 * host (another site resolving its name to 127.0.0.1, DNS rebinding) or sent from any page but Friday's own (`appOrigin`): a
 * site the person happens to have open, or a page being previewed, which is served from localhost while Friday is at 127.0.0.1,
 * so that it is another origin (src/local/main.ts). A request with no Origin (a page load, the runner it starts) is this computer asking.
 */
export function localOnly(req: Pick<http.IncomingMessage, "headers">, appOrigin: string): boolean {
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(String(req.headers.host ?? ""))) return false;
  const origin = req.headers.origin;
  return origin === undefined || origin === appOrigin;
}

function crossSite(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}


/**
 * Whether this request comes from the same machine the server runs on — the
 * only case where "start a coding agent here" means the person's own laptop.
 *
 * A loopback socket alone is not enough: hosted platforms put a proxy in front
 * that connects over loopback, which would make every visitor to a public
 * deployment look local. So the browser must also be *addressing* it as
 * localhost. FRIDAY_LOCAL_RUNNER=0 forces it off.
 */
function isOwnMachine(req: http.IncomingMessage): boolean {
  if (process.env.FRIDAY_LOCAL_RUNNER === "0") return false;
  // =1 (the desktop app's own server) still needs both: it listens on every interface, so without them anyone on the same
  // network, or a web page that rebinds its own name to 127.0.0.1, could have commands run here (Security AUDIT RUN-2).
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return isLoopback(req) && (host === "localhost" || host === "127.0.0.1" || host === "::1");
}

const isLoopback = (req: http.IncomingMessage) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");


/** An API answer, packed for a client that can read it packed (packJson): a long session's log went out whole on every first read. */
function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const { body: out, encoding, varies } = packJson(JSON.stringify(body), res.req?.headers["accept-encoding"]);
  res.writeHead(status, {
    ...headers,
    "Content-Type": "application/json",
    ...(encoding ? { "Content-Encoding": encoding } : {}),
    ...(varies ? { Vary: withVary(headers.Vary ?? res.getHeader("Vary"), "Accept-Encoding") } : {}),
  });
  res.end(out);
}

async function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) {
      req.destroy();
      throw new Error("Body too large");
    }
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

const JSON_MAX = 256 * 1024;
const BIG_JSON = /(?!)/; // no route here reads JSON bigger than readJson does

/** A page size for the token API: a whole number from 1 to 100, `dflt` for anything else (Testing API-19: 1.5 was a 500). */
export function pageLimit(raw: string | null, dflt: number): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(100, n) : dflt;
}

/** A request's JSON body as an object: anything else (`null`, a number, a list, nonsense) is an empty one (Testing API-11). */
async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const v: unknown = JSON.parse((await readBody(req, JSON_MAX)).toString() || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function deriveTitle(goal: string): string {
  const first = goal.split("\n")[0]!.trim().replace(/\s+/g, " ");
  return first.length > 60 ? first.slice(0, 57).replace(/\s+\S*$/, "") + "…" : first;
}

/**
 * The chunks app.js imports before it can run, and the ones those import: named in the page so the browser fetches them
 * beside app.js. Found by reading app.js, they were only asked for once it had arrived and been parsed, one round trip
 * after it. Static imports only; what the app loads on demand stays on demand.
 */
async function preloadsFor(entry: string): Promise<string[]> {
  const bundle = await bundleClient();
  const seen = new Set<string>();
  const visit = (file: string) => {
    const js = bundle.get(file);
    if (!js) return;
    // `import{a}from"./x.js"` and `import"./x.js"`, never `import("./x.js")`.
    for (const m of Buffer.from(js.body).toString("utf8").matchAll(/\bimport\s*(?:[\w$*{][^;"'()]*?\bfrom\s*)?["'](\.{1,2}\/[^"']+\.js)["']/g)) {
      const dep = new URL(m[1]!, `http://x${file}`).pathname;
      if (!seen.has(dep)) {
        seen.add(dep);
        visit(dep);
      }
    }
  };
  visit(entry);
  return [...seen];
}

const shells = new Map<ShellRoute, { key: string; html: Promise<Buffer> }>();
/**
 * index.html for a first screen (shellRoute), with that screen's code named up front (see preloadsFor): app.js's chunks, or for a
 * recording or watch link, replay.js and its own, a fraction of the app's, in place of app.js. A link into a session gets the
 * app's: naming the session screen's code here too put its first paint 180 ms later at 10 Mbps for 70 ms off the feed (load.md).
 */
function shellHtml(file: string, key: string, route: ShellRoute = "app"): Promise<Buffer> {
  key = `${key}:${hot.gen}`;
  const kept = shells.get(route);
  if (kept?.key === key) return kept.html;
  const html = (async () => {
    const page = await readFile(file, "utf8");
    const bundle = await bundleClient().catch(() => new Map() as Bundle);
    const entry = route === "replay" && bundle.has("/replay.js") ? "/replay.js" : "/app.js";
    const preloads = await preloadsFor(entry).catch(() => []);
    const live = hot.on ? `  <script>${HOT_SCRIPT}</script>\n` : "";
    // A link into a session: the session screen's code, named (not fetched) for the app to ask for all at once when it starts,
    // instead of the screen's chunk and then, once that arrived, the chunks it imports (App.tsx). Not fetched from here: that
    // shared the line with the first paint and put it 180 ms later.
    const screen = route === "session" ? [...bundle.keys()].find((k) => /^\/chunks\/SessionView-[\w-]+\.js$/.test(k)) : undefined;
    const have = new Set(preloads);
    const code = screen ? [screen, ...(await preloadsFor(screen).catch(() => []))].filter((p) => !have.has(p)) : [];
    const named = code.length ? `  <script>window.__sessionCode = ${JSON.stringify(code)};</script>\n` : "";
    return Buffer.from(shellFor(page, entry, preloads, named + live));
  })();
  shells.set(route, { key, html });
  return html;
}

/**
 * Live updates while developing (FRIDAY_HOT=1, the "multiplayer-ai-hot" launch): a change to the client or a stylesheet
 * rebuilds the bundle and reloads every open window, the desktop app's included. A change to the server restarts it (tsx
 * watch), and a window whose line to it dropped reloads once it is back. Never on in production.
 */
const hot = { on: process.env.FRIDAY_HOT === "1", gen: 0, clients: new Set<http.ServerResponse>() };
const HOT_SCRIPT = `(()=>{let lost=false;const s=new EventSource("/__hot");s.onmessage=()=>location.reload();s.onerror=()=>{lost=true};s.onopen=()=>{if(lost)location.reload()}})()`;
if (hot.on) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed = (rebuild: boolean) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (rebuild) clientBundle = null;
      hot.gen++;
      for (const res of hot.clients) res.write("data: reload\n\n");
    }, 120);
  };
  // The client's own folder, and the shared modules beside it that the bundle imports (plans.ts, types.ts and the like).
  watch(here, { recursive: true }, (_e, f) => f && /\.(tsx?|css)$/.test(f) && changed(true));
  watch(PUBLIC_DIR, { recursive: true }, () => changed(false));
  // And by looking, once a second: a server started by a tool that runs it out of the session's file events (the editor's
  // preview launcher) heard nothing from watch, and a change to the sidebar never reached the window (2026-10-19).
  const newest = (dir: string, re: RegExp): number => {
    let at = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) at = Math.max(at, newest(f, re));
      else if (re.test(e.name)) at = Math.max(at, statSync(f).mtimeMs);
    }
    return at;
  };
  let seen = { src: newest(here, /\.(tsx?|css)$/), pub: newest(PUBLIC_DIR, /\.(css|html|js)$/) };
  setInterval(() => {
    try {
      const now = { src: newest(here, /\.(tsx?|css)$/), pub: newest(PUBLIC_DIR, /\.(css|html|js)$/) };
      if (now.src !== seen.src) changed(true);
      else if (now.pub !== seen.pub) changed(false);
      seen = now;
    } catch {
      /* a file gone mid-walk: next second */
    }
  }, 1000).unref();
  console.log("[hot] live updates on: windows reload when the client or its styles change");
}

/** The live-update line a page in development listens on (see hot). */
export function hotStream(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!hot.on || req.url !== "/__hot") return false;
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(": live\n\n");
  hot.clients.add(res);
  req.on("close", () => hot.clients.delete(res));
  return true;
}

/**
 * `preview`: the link preview for "/" (share-meta.ts). A share link's page names its session, so it is made for that request
 * and sent as it is, never cached anywhere and never kept in `packed`, which is keyed by file and length and would hand one
 * session's page to another whose title is as long. The bare address's preview is the same for everyone and is cached as usual.
 */
async function serveStatic(req: http.IncomingMessage, pathname: string, res: http.ServerResponse) {
  // Single-page app: anything that isn't a real asset gets the shell.
  const rel = pathname === "/" || !path.extname(pathname) || pathname === "/session.html" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 404, { error: "Not found" });
  try {
    const info = await stat(file);
    const route: ShellRoute = "app";
    let data = rel === "index.html" ? await shellHtml(file, `${info.mtimeMs}:${info.size}`, route) : await readFile(file);
    // Revalidated every load so a stylesheet can never drift from the freshly bundled client, but a reload that finds nothing changed is a "not modified".
    // The bare address's page carries an absolute address, which without appUrl is the host it was asked on: kept apart by it.
    // A stylesheet the build packed already (src/pack-built.ts) goes as packed.
    const br = rel === "index.html" ? undefined : await readFile(`${file}.br`).catch(() => undefined);
    await sendAsset(req, res, `${file}:${info.mtimeMs}:${info.size}:${data.length}:${route}`, data, TYPES[path.extname(file)] ?? "application/octet-stream", "no-cache", br);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}


function auditLine(e: SessionEvent): string {
  const b = e.body;
  const who = `${e.actor.name} (${e.actor.kind === "human" ? e.actor.id : e.actor.kind})`;
  let detail = "";
  switch (b.type) {
    case "instruction":
    case "suggestion":
      detail =
        JSON.stringify(b.text.slice(0, 160)) +
        ("interrupt" in b && b.interrupt ? " [interrupt]" : "") +
        (b.attachments?.length ? ` [files: ${b.attachments.map((a) => a.name).join(", ")}]` : "");
      break;
    case "instructions.delivered":
      detail = `agent saw #${b.seqs.join(", #")}`;
      break;
    case "agent.message":
      detail =
        [b.text && JSON.stringify(b.text.slice(0, 120)), ...b.toolCalls.map((c) => `${c.name}(${c.arguments.slice(0, 80)})`)].filter(Boolean).join(" ") +
        (b.interrupted ? " [interrupted]" : "");
      break;
    case "tool.result":
      detail = `${b.name} → ${b.interrupted ? "INTERRUPTED" : b.isError ? "ERROR" : "ok"}: ${JSON.stringify(b.output.slice(0, 100))}`;
      break;
    case "control.granted":
      detail = `→ ${b.toName} (${b.reason})`;
      break;
    case "control.released":
      detail = `${b.from} (${b.reason})`;
      break;
    case "run.ended":
      detail = b.outcome + (b.error ? `: ${b.error}` : "");
      break;
    case "agent.question":
      detail = `to ${b.toName}: ${JSON.stringify(b.question)}`;
      break;
    case "member.joined":
      detail = b.role;
      break;
    case "member.role_changed":
      detail = `${b.name} → ${b.role}`;
      break;
    case "member.removed":
      detail = b.name;
      break;
    case "link.updated":
      detail = `${b.role} link ${b.enabled ? "on" : "off"}, v${b.version}`;
      break;
    case "session.created":
      detail = JSON.stringify({ ...b.options, agent: b.options?.agent ? `${b.options.agent.name} v${b.options.agent.version}` : undefined });
      break;
    case "session.updated":
      detail = JSON.stringify({ ...b.options, ...(b.options.agent ? { agent: `${b.options.agent.name} v${b.options.agent.version}` } : {}), ...(b.title ? { title: b.title } : {}) });
      break;
  }
  return `#${String(e.seq).padStart(4)}  ${new Date(e.ts).toISOString()}  ${who.padEnd(28)}  ${b.type.padEnd(22)}  ${detail}`;
}



