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
import type { MachineTool, SessionOptionsPatch } from "./types.js";
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
import { listWork, namedIn, pathParam, serveWork, shownFile, siteIcon, workPath } from "./work-files.js";
import { FRAME_TTL_MS, frameDir, inFrame, signFrame, verifyFrame } from "./work-frame.js";
import type { PeerNote } from "./types.js";
import { ago as agoOf, LocalPeers, LOOK_AT as SESSIONS_LOOKED_AT, MODE_RANK, newId, placeOf as placeOfSession, scheduleOf } from "./app-tools.js";
import { backupOf, checkInDue, checkInText, quietCheckIns, type CheckIn, cleanRoom, cleanTeammate, MEMORY_FILE, MEMORY_MAX, defaultFolder, makeFolder, MAX_ROOMS, MAX_TEAMMATES, projectsOf, roomKeep, runsOnName, teammateNote, TeammateStore, worktreeHolding, type Room, type Teammate, type TeammateView } from "./teammates.js";
import { limitHit, planLimitHit } from "./limit-reset.js";
import { heldByPerson, runnableQueue } from "./held.js";
import { hopBehind } from "./agent-mesh.js";
import { writeFile as writeFileAt } from "node:fs/promises";
import { ownModelId } from "./own-model-id.js";
import { handoffBrief } from "./handoff.js";
import { ENGINE_MODEL_INFO } from "./types.js";
import { hubOf } from "./agents-hub.js";
import { distinctLook } from "./teammate-look.js";
import { awayAnswer, awayNote, briefLine, briefWorthPosting, clockOf, endsOnQuestion, roomNews, runsIn, teamBrief as awayBrief, usageOf, type LaneRun, type Place } from "./team-away.js";
import { boardBusy } from "./session/projection.js";
import type { MateNote } from "./engine/hub.js";
import type { MateRun, TeamAway } from "./teammates.js";
import type { TeamBrief } from "./types.js";
import { execFile as execFileCb } from "node:child_process";
import { homedir as osHome } from "node:os";
import { TeamWorkflows } from "./team-workflows.js";
import type { Workflow } from "./team-workflow-model.js";
import { localEdition } from "./local-edition.js";

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
  /** Where teammates' own folders go when none is picked (teammates.ts defaultFolder): the home folder unless said, as tests do. */
  teammatesHome?: string;
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
  /** The teammates hearing their sessions' events (set below, with the teammates): away mode, its answers, retries. */
  let teamHear: ((sid: string, ev: SessionEvent) => void) | null = null;
  /** The team's workflows (team-workflows.ts), once the teammates are: their runs follow their boards. */
  let workflows: TeamWorkflows | null = null;
  store.onAppended = (sid, ev) => {
    teamHear?.(sid, ev as SessionEvent);
    workflows?.hear(sid, ev as SessionEvent);
    // Every edition's: the open-source one runs automations too, and with this left out of it its runs stayed "Running" for good
    // and "An agent finishes" never fired (2026-10-27 QA).
    if (ev.body.type === "run.ended") automationsHear?.(sid, ev);
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
        // A teammate's: carried on as Friday, told why (teamResume).
        if (teamResume && (await store.state(sid)).options.team) (await teamResume(sid, lane, due.seq)) && sent.push(sid);
        if (teamResume && (await store.state(sid)).options.team) continue;
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
  /** A teammate's resume (out of usage, a short rate limit, an error while away), carried on as Friday: true when sent. */
  let teamResume: ((sid: string, lane: string, seq: number) => Promise<boolean>) | null = null;
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
  // On someone's own computer, each of their sessions is looked over once the last run's leases are gone: a lane its runner left
  // with that run reads offline in the sidebar and on the Board too, not only once the session is opened (EngineHub.reap). The
  // hosted service does it as each session is opened.
  const reapAtStart = o.local ? hub.reapAfterLeases(async () => (await store.mine(o.local!.user.id)).map((r) => r.sid)) : null;
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
  // ── Teammates (teammates.ts): persistent AI teammates on this computer, in the open-source edition ──────────
  const teammates = o.local && localEdition() ? new TeammateStore(redis, o.prefix) : null;
  /** What was started for them, in a dry run (FRIDAY_TEAMMATES_DRY): for tests. */
  const teammateStarts: Record<string, unknown>[] = [];
  /**
   * For tests, in a dry run: tools whose start fails, the tools this computer has (null: as if it couldn't say), and how long a
   * short rate limit is waited out (teamSwitch). Set through the app's `teammates` hooks.
   */
  const teammateDry: { failing: Set<string>; tools: EngineTool[] | null; retryMs?: number } = { failing: new Set(), tools: null };
  /** Sessions and automation runs agents may start for the person in an hour, all agents together: teammates and rooms too. */
  const AGENT_STARTS_PER_HOUR = 8;
  /** Sessions an agent started: those don't start more (one level only), so sessions can't fan out into sessions. */
  const agentStartedKey = `${o.prefix}agent-started`;
  /**
   * Marked as started by an agent: a key of its own that expires after a month, rather than one more member of a set that only
   * grew (2026-10-28 audit). Read from both, for sessions marked before.
   */
  const markAgentStarted = (sid: string) => redis.set(`${agentStartedKey}:${sid}`, "1", "EX", 30 * 86_400);
  const agentStarted = async (sid: string) => !!(await redis.exists(`${agentStartedKey}:${sid}`)) || !!(await redis.sismember(agentStartedKey, sid));
  const startsLeft = async (owner: string): Promise<boolean> => {
    const k = `${o.prefix}agent-starts:${owner}`;
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, 3600);
    return n <= AGENT_STARTS_PER_HOUR;
  };
  /** The team session, made the first time it is needed: private, links off, its main lane the room (nobody's agent on it). */
  // Made once: two first looks at once each made a Team, and a read that failed made a new one every teammate's lane wasn't in.
  let makingTeam: Promise<string> | null = null;
  // The Team workflow is Crew (Arun, 2026-10-28: "rename team to something else"): a session made as "Team" before is renamed
  // once, by Friday, so the lists and the agents' list_sessions say "Crew" as a new one does. Checked once a run.
  let crewTitled = false;
  const teamSession = async (owner: { id: string; name: string }, workspaceId: string): Promise<string> => {
    const had = await teammates!.team();
    // Kept unless its session is really gone from the store (not merely unread): then a new one, which the teammates re-join.
    if (had && (await store.exists(had))) {
      if (!crewTitled) {
        crewTitled = true;
        if ((await store.state(had)).title === "Team") await store.append(had, FRIDAY, { type: "session.updated", options: {}, title: "Crew" }).catch(() => (crewTitled = false));
      }
      return had;
    }
    makingTeam ??= (async () => {
      const sid = randomBytes(6).toString("base64url");
      await store.create(sid, "Crew", { id: owner.id, name: owner.name, role: "owner" }, { team: true, controlMode: "ask", mcp: true }, workspaceId);
      await teammates!.setTeam(sid);
      // Its log gone (not merely unread), the teammates are still on the team: each joins the new one with a lane of its own, the
      // first leading, and starts there (2026-10-28 audit: they kept lanes of a session that was no more, and nothing reached them).
      const list = had ? await teammates!.list() : [];
      for (const [i, t] of list.entries()) {
        const added = await core.handle(sid, owner, { type: "lane.add", name: t.name, engine: true, control: { kind: "people", people: [owner.id] } });
        const ev = added.ok ? (await store.events(sid)).find((e) => e.seq === added.seq) : undefined;
        const lane = ev?.body.type === "lane.added" ? ev.body.lane.id : "";
        if (!lane) continue;
        const moved = await teammates!.update(t.id, (cur) => ({ ...cur, lane }));
        if (!moved) continue;
        if (i === 0) await core.handle(sid, owner, { type: "lead.set", lane, auto: true });
        if (moved.effort) await setEffort(sid, owner, lane, moved);
        await startTeammate(sid, owner, moved).catch((e: Error) => console.error(`[teammates] ${t.name} didn't start: ${e.message}`));
      }
      return sid;
    })().finally(() => (makingTeam = null));
    return makingTeam;
  };
  /**
   * A teammate's coding tool started (or brought back) on this computer, on its lane, in its own folder, as its own account. One on
   * its own model has no tool to start: its folder is lent to its lane by a runner with nothing behind it, and Friday Code works
   * there (agent/runtime.ts laneOwn), as it does in a folder lent to any session.
   */
  /**
   * Each teammate's own copy (a git worktree) of a repo it shares with other teammates, by teammate id: kept at one place for good,
   * on a branch of its own, so two teammates are never refused for one folder and never edit over each other; the lead merges
   * their branches into one pull request (Arun, 2026-10-28: "Landing work: worktrees, one PR"). The lead (or else the first to
   * join) works in the repo itself.
   */
  const copies = new Map<string, { repo: string; path: string; branch: string }>();
  /** A teammate's MEMORY.md written one at a time, by it (update_memory) or the person: neither undoes the other (2026-10-28 audit). */
  const memoryLock = <T,>(id: string, fn: () => Promise<T>): Promise<T> => teammates!.locked(`memory:${id}`, fn);
  const git = (cwd: string, args: string[]) => new Promise<string>((resolve, reject) => execFileCb("git", ["-C", cwd, ...args], { timeout: 120_000 }, (e, out) => (e ? reject(e) : resolve(String(out)))));
  const copyFor = async (sid: string, t: Teammate): Promise<{ repo: string; path: string; branch: string } | null> => {
    const repo = projectsOf(t)[0];
    if (!repo || t.tool === "friday") return null;
    const list = await teammates!.list();
    const sharers = list.filter((x) => projectsOf(x).some((d) => d.toLowerCase() === repo.toLowerCase()));
    if (sharers.length < 2) return (copies.delete(t.id), null);
    const lead = (await store.state(sid).catch(() => null))?.lead;
    const home = sharers.find((x) => x.lane === lead) ?? sharers[0]!;
    if (home.id === t.id) return (copies.delete(t.id), null);
    const top = (await git(repo, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
    if (!top) return null;
    const name = defaultFolder(t.name, "/").split("/").pop()!.toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "teammate";
    const copy = { repo, path: path.join(o.teammatesHome ?? osHome(), "Friday", "worktrees", `${path.basename(top)}-${name}-${t.id.slice(0, 4)}`), branch: `friday/team-${name}` };
    const there = (dir: string) => stat(path.join(dir, ".git")).then(() => true, () => false);
    // Its branch already out in a worktree somewhere else: that is its copy (teammates.ts worktreeHolding). One whose folder has
    // gone is let go of first, so the branch can be checked out again here.
    const held = !(await there(copy.path)) ? worktreeHolding(await git(top, ["worktree", "list", "--porcelain"]).catch(() => ""), copy.branch) : null;
    if (held && path.resolve(held) !== path.resolve(copy.path) && path.resolve(held) !== path.resolve(top)) {
      if (await there(held)) copy.path = held;
      else await git(top, ["worktree", "prune"]).catch(() => "");
    }
    if (!(await there(copy.path))) {
      const has = (await git(top, ["branch", "--list", copy.branch]).catch(() => "")).trim();
      const made = await git(top, has ? ["worktree", "add", "-q", copy.path, copy.branch] : ["worktree", "add", "-q", "-b", copy.branch, copy.path, "HEAD"]).then(() => true, (e: Error) => (console.error(`[teammates] ${t.name}'s copy of ${repo}: ${e.message}`), false));
      if (!made) return null;
    }
    copies.set(t.id, copy);
    return copy;
  };
  const startTeammate = async (sid: string, owner: { id: string; name: string }, t: Teammate, more: Record<string, unknown> = {}, at?: { lane: string; keepAs: string }) => {
    const tool = t.tool === "friday" ? undefined : t.tool;
    const copy = await copyFor((await teammates!.team()) ?? sid, t).catch(() => null);
    const params = {
      sid,
      invite: signInvite(o.secret, sid, "owner"),
      actorToken: signActor(o.secret, sid, owner.id),
      ...(tool ? { tool } : {}),
      // In the work it was given: its first folder or repo, where its branch, changes and tree are (Arun, 2026-10-27: "make sure
      // they are working within the repo or folder too"); its own folder, for its notes, beside it. Without one, its own folder.
      // A repo it shares with other teammates: its own copy of it (copyFor).
      cwd: copy?.path ?? projectsOf(t)[0] ?? t.folder,
      // As far as it may go: full, unless an agent made it, at no more than that agent may (Teammate.mode).
      mode: t.mode ?? "full",
      lane: at?.lane ?? t.lane,
      // Its conversation, kept whatever port the app opens on and whichever project it is pointed at (Runner keepAs); in a room,
      // the one it has there.
      keepAs: at?.keepAs ?? t.id,
      ...(projectsOf(t).length ? { dirs: [...projectsOf(t).slice(1), t.folder] } : {}),
      // The model is its tool's to run; an own model is Friday Code's, asked for by the lane (laneOwn), never the runner's.
      ...(tool && t.model ? { model: t.model } : {}),
      // Always the account picked: never another one, whatever happens to this one (own-plan.ts).
      ...(tool && t.account ? { account: t.account } : {}),
      ...more,
    };
    // Tests say what would be started rather than start a real coding tool on the machine running them. A folder lent with no
    // tool starts no coding tool, so it is started for real: its lane needs it to run.
    if (process.env.FRIDAY_TEAMMATES_DRY === "1") {
      if (params.tool && teammateDry.failing.has(params.tool)) throw new Error(`${ENGINE_NAMES[params.tool]} didn't start (dry run)`);
      teammateStarts.push(params);
      if (params.tool) return { lane: params.lane };
    }
    return (await callHost("start", params, hostCtx(owner))) as { lane: string };
  };
  /** The person's own models on this computer (Settings › Your models, runner/own-models.ts), as its runner lists them; null when it can't say. */
  const ownModelsHere = (owner: { id: string; name: string }) =>
    (callHost("models.own.list", {}, hostCtx(owner)) as Promise<{ models?: { id: string; name: string; baseUrl: string; local: boolean }[] }>).then((r) => r.models ?? [], () => null);
  /**
   * Why a teammate can't be put on `model`, or null: it has to be one of the team owner's own models (own-plan.ts: their own model
   * runs their work only), and set up on this computer now. An agent picking one for a teammate is held to the same.
   */
  const ownModelRefused = async (owner: { id: string; name: string }, model: string): Promise<string | null> => {
    if (ownModelParts(model)?.owner !== owner.id) return "That model isn't one of yours: a teammate runs only on your own models.";
    const list = await ownModelsHere(owner);
    if (!list) return "Couldn't read your models on this computer. Try again in a moment.";
    return list.some((m) => m.id === ownModelParts(model)!.entry) ? null : "That model isn't set up on this computer. Add it in Settings › Your models first.";
  };
  /**
   * What keeps a teammate on its own model from running now, said to the person, or "": the model gone from Settings, or a
   * model server on this computer that doesn't answer. One on the internet counts as there once it is set up: asking it would
   * spend the person's key for a status dot. Kept for twenty seconds, so a sidebar polling every few seconds asks seldom.
   */
  const ownHealth = new Map<string, { at: number; why: Promise<string> }>();
  const ownModelProblem = (owner: { id: string; name: string }, model: string): Promise<string> => {
    const had = ownHealth.get(model);
    if (had && Date.now() - had.at < 20_000) return had.why;
    const why = (async () => {
      const parts = ownModelParts(model);
      if (!parts || parts.owner !== owner.id) return "Its model isn't one of yours. Pick one of your own models for it.";
      const list = await ownModelsHere(owner);
      // This computer couldn't say: nothing to report, rather than a guess.
      if (!list) return "";
      const m = list.find((x) => x.id === parts.entry);
      if (!m) return "Its model isn't in Settings › Your models any more. Pick another for it, or add it again.";
      if (!m.local) return "";
      const up = await fetch(`${m.baseUrl}/models`, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
      return up ? "" : `Nothing answers at ${m.baseUrl}. Is ${m.name}'s server running?`;
    })();
    ownHealth.set(model, { at: Date.now(), why });
    return why;
  };
  /**
   * A team session as the teammates' views read it: its state, how each agent in it stands, and its last words. Kept until the
   * session has a new event (or half a minute passes, as a usage limit lifting changes how one stands), so a sidebar polling
   * every few seconds from every window, and every turn's rooms brief, doesn't read whole logs again for nothing.
   */
  type Look = { state: SessionState; agents: ReturnType<typeof hubOf>["agents"]; said: { by: string; text: string; at: number } | null; news: number; checking: Set<string>; runs: LaneRun[]; held: Set<string>; events: SessionEvent[] };
  const looks = new Map<string, { seq: number; at: number; look: Look }>();
  const teamLook = async (sid: string): Promise<Look> => {
    const state = await store.state(sid);
    const had = looks.get(sid);
    if (had && had.seq === state.lastSeq && Date.now() - had.at < 30_000) return { ...had.look, state };
    const events = await store.events(sid);
    // A check-in with nothing new is neither news nor the room's last words (teammate-checkins.ts quietCheckIns).
    const { quiet, checking } = quietCheckIns(events);
    const last = events.findLast((e) => e.body.type === "agent.message" && e.body.text.trim() && !quiet.has(e.seq));
    // Read once here for everything a look gives: each lane's runs (usage, activity), and who is on hold (held.ts).
    const lanes = [MAIN_LANE, ...state.lanes.map((l) => l.id)];
    const look: Look = {
      state,
      agents: hubOf(state, events).agents,
      said: last?.body.type === "agent.message" ? { by: last.actor.name, text: last.body.text.trim().slice(0, 400), at: last.ts } : null,
      // What the room would show, not every run that ended (team-away.ts roomNews).
      news: roomNews(events, state.lead, quiet),
      checking,
      runs: runsIn(events, new Set(lanes)),
      held: new Set(lanes.filter((l) => heldByPerson(events, l))),
      events,
    };
    looks.set(sid, { seq: state.lastSeq, at: Date.now(), look });
    // Kept for the sessions looked at lately only: a removed room's look isn't kept for as long as the server runs.
    if (looks.size > 64) for (const [k, v] of looks) if (Date.now() - v.at > 10 * 60_000) looks.delete(k);
    return look;
  };
  /** Whether every lane at work in a team session is on a check-in. */
  const teamOnlyCheckingIn = async (state: SessionState) => {
    const { checking } = await teamLook(state.id);
    const live = Object.entries(state.laneRuns).filter(([, r]) => r.status === "running");
    return live.length > 0 && live.every(([lane]) => checking.has(lane));
  };
  /** Each teammate as the app shows it: its record, how it stands, what it is on, and what waits for it. */
  const teammateViews = async (sid: string): Promise<TeammateView[]> => {
    // How each stands across everywhere it is, the team and its rooms: busy in a room is busy (Arun, 2026-10-27: "the side bar
    // is idle too", while they all worked in one). Working beats needing you beats limited beats idle beats offline.
    const [list, rooms] = await Promise.all([teammates!.list(), teammates!.rooms()]);
    const places = await Promise.all(
      [{ sid, lanes: Object.fromEntries(list.map((t) => [t.id, t.lane])) as Record<string, string> }, ...rooms.map((r) => ({ sid: r.sid, lanes: r.lanes }))].map(async (p) => {
        const { state, agents, runs, held } = await teamLook(p.sid).catch(() => ({ state: null, agents: [], runs: [] as LaneRun[], held: new Set<string>() }));
        return { ...p, state, agents, runs, held };
      }),
    );
    // Its usage today (since this computer's midnight) and over the week, across everywhere it works.
    const midnight = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
    const week = Date.now() - 7 * 86_400_000;
    const usageFor = (id: string, from: number) => {
      const sum = { turns: 0, minutes: 0, tokens: 0 };
      for (const p of places) {
        const lane = p.lanes[id];
        if (!lane) continue;
        const u = usageOf(p.runs.filter((r) => r.lane === lane), from);
        sum.turns += u.turns;
        sum.minutes += u.minutes;
        sum.tokens += u.tokens;
      }
      return { turns: sum.turns, minutes: sum.minutes, ...(sum.tokens ? { tokens: sum.tokens } : {}) };
    };
    const RANK: Record<TeammateView["status"], number> = { working: 5, waiting: 4, stopped: 3, limited: 2, idle: 1, offline: 0 };
    // One on its own model is online only while that model can run: set up in Settings, and its server answering when it is on
    // this computer. The team's owner is the one person in its session.
    const owner = Object.entries((await store.state(sid)).members).find(([, m]) => m.role === "owner");
    const problems = new Map(await Promise.all(list.filter((t) => t.tool === "friday").map(async (t) => [t.id, owner ? await ownModelProblem({ id: owner[0], name: owner[1].name }, t.model ?? "") : ""] as const)));
    return list.map((t) => {
      let best: Pick<TeammateView, "status" | "line"> = { status: "offline", line: "" };
      let queued = 0;
      for (const p of places) {
        const lane = p.lanes[t.id];
        // A room whose session can't be read (gone from the store) counts for nothing.
        if (!lane || !p.state) continue;
        const a = p.agents.find((x) => x.lane === lane);
        const engine = p.state.engines[lane];
        const status: TeammateView["status"] = !engine?.online ? "offline" : a?.status === "working" ? "working" : a?.status === "waiting" ? "waiting" : a?.status === "limited" ? "limited" : a?.status === "failed" ? "stopped" : "idle";
        queued += pendingFor(p.state, lane).length;
        // Offline keeps why (its tool not running, the computer it is on), which the first place said (2026-10-28 QA: a bare "Offline").
        const line = status === "offline" ? (a?.status === "offline" ? a.line : "Offline · their coding tool isn't running") : (a?.line ?? "");
        if (RANK[status] > RANK[best.status] || (status === "offline" && !best.line)) best = { status, line };
      }
      const problem = problems.get(t.id);
      const more = { mode: t.mode ?? ("full" as const), held: places.some((p) => !!p.lanes[t.id] && p.held.has(p.lanes[t.id]!)), usage: { today: usageFor(t.id, midnight), week: usageFor(t.id, week) } };
      // Mid-turn it is working whatever a ping says; otherwise a model that can't run leaves it offline, and says why.
      if (problem) return { ...t, ...(best.status === "working" ? best : { status: "offline" as const, line: problem }), queued, problem, ...more };
      return { ...t, ...best, queued, ...more };
    });
  };
  /** Each room as the app shows it: who is in it (their lanes there) and how many of them are working or need the person. */
  const roomViews = async () =>
    Promise.all(
      (await teammates!.rooms()).map(async (r) => {
        const { state, agents: all, said, news } = await teamLook(r.sid);
        // Renamed from its own page (its title, settings.update): its title is its name. Read, never written here: a write in a
        // read put back lanes or a room just changed or removed.
        r.name = state.title || r.name;
        const lanes = Object.values(r.lanes);
        const agents = all.filter((a) => lanes.includes(a.lane) && state.engines[a.lane]?.online);
        // Its last words and who said them, for the Team room's view of the rooms.
        const last = said;
        const doing = Object.fromEntries(agents.filter((a) => a.status === "working").map((a) => [a.lane, a.line ?? ""]));
        return { id: r.id, name: r.name, sid: r.sid, invite: signInvite(o.secret, r.sid, "owner"), lanes: r.lanes, lead: state.lead ?? null, news, ...(r.purpose ? { purpose: r.purpose } : {}), working: agents.filter((a) => a.status === "working").length, waiting: agents.filter((a) => a.status === "waiting").length, last, doing };
      }),
    );
  /**
   * The Team room's own counts, as each room's are: its teammates at work there and those waiting on the person there (Arun,
   * 2026-10-28: "really iron out bugs and feature problems and gaps"; its sidebar row said "None working" while the lead worked).
   */
  const teamRoomNow = async (sid: string) => {
    const [{ agents, news }, list] = await Promise.all([teamLook(sid), teammates!.list()]);
    const lanes = new Set(list.map((t) => t.lane));
    const here = agents.filter((a) => lanes.has(a.lane));
    const doing = Object.fromEntries(here.filter((a) => a.status === "working").map((a) => [a.lane, a.line ?? ""]));
    return { news, working: Object.keys(doing).length, waiting: here.filter((a) => a.status === "waiting").length, doing };
  };
  /** Puts each switched teammate whose limit has lifted back on its own tool (a timer calls it; tests too). */
  let runBack: () => Promise<void> = async () => {};
  /** Asks each teammate its check-ins that are due at `now` (a timer calls it; tests call it with a time). */
  let runCheckIns: (now?: Date) => Promise<void> = async () => {};
  /** A teammate's effort on one of its lanes (its tool's level, or none for Auto): its record's, set as the lane's own. */
  // A coding tool's alone: Friday Code on an own model takes no level (a teammate's record never has one there).
  const setEffort = async (sid: string, owner: { id: string; name: string }, lane: string, t: Teammate) =>
    t.tool === "friday" ? undefined : store.append(sid, { id: owner.id, name: owner.name, kind: "human" }, { type: "lane.effort", effort: t.effort ?? null, tool: t.tool }, { lane });
  /** The rooms as the Team room's teammates are told them: each one's members, who is working on what, and its last words. */
  const roomsBrief = async (list: Teammate[]): Promise<string> => {
    const rooms = await teammates!.rooms();
    if (!rooms.length) return "";
    const lines = await Promise.all(
      rooms.map(async (r) => {
        const { state, agents, said } = await teamLook(r.sid);
        const who = Object.entries(r.lanes).map(([id, lane]) => {
          const name = list.find((t) => t.id === id)?.name ?? "someone";
          const a = agents.find((x) => x.lane === lane);
          return a?.status === "working" ? `${name} (working${a.line ? `: ${a.line}` : ""})` : a?.status === "waiting" ? `${name} (needs the person)` : name;
        });
        const last = said ? ` Last said, by ${said.by}: "${said.text.replace(/\s+/g, " ").slice(0, 220)}"` : "";
        return `- "${state.title || r.name}" (session ${r.sid}): ${who.join(", ") || "nobody in it"}.${last}`;
      }),
    );
    return [
      "The crew's rooms right now, where some of you work apart on one thing. To read one in full use read_session with its session id; to tell or ask its teammates something, message_session.",
      ...lines,
    ].join("\n");
  };
  /**
   * A teammate's work everywhere else, for its turn in a room (as roomsBrief is for the Team room): how it stands in the Team room
   * and its other rooms, and its last words there, so it neither redoes nor contradicts what it does elsewhere (2026-10-28).
   */
  const elsewhereBrief = async (t: Teammate, here: string): Promise<string> => {
    const team = await teammates!.team();
    const rooms = await teammates!.rooms();
    const places = [...(team && team !== here ? [{ sid: team, name: "the Crew room", lane: t.lane }] : []), ...rooms.filter((r) => r.sid !== here && r.lanes[t.id]).map((r) => ({ sid: r.sid, name: `the room "${r.name}"`, lane: r.lanes[t.id]! }))];
    const lines = (
      await Promise.all(
        places.map(async (p) => {
          const look = await teamLook(p.sid).catch(() => null);
          const run = look?.runs.findLast((r) => r.lane === p.lane);
          if (!look || !run) return "";
          const a = look.agents.find((x) => x.lane === p.lane);
          const how = a?.status === "working" ? `working${a.line ? ` (${a.line})` : ""}` : a?.status === "waiting" ? "waiting on the person" : "not working";
          return `- In ${p.name} (session ${p.sid}) you are ${how}.${run.said ? ` Your last words there: "${run.said.replace(/\s+/g, " ").slice(0, 200)}"` : ""}`;
        }),
      )
    ).filter(Boolean);
    return lines.length ? ["[Friday] Your work elsewhere right now (each place keeps its own conversation; read_session reads one):", ...lines].join("\n") : "";
  };
  /**
   * A folder for a new teammate no other teammate's record has (2026-10-28 audit: renamed, then a new one given the old name, two
   * teammates shared one folder and one MEMORY.md; "O'Neil" and "ONeil" made the same folder): its name's, or that with -2, -3….
   */
  const freeFolder = (name: string, list: readonly Teammate[]): string => {
    const taken = new Set(list.map((t) => t.folder.toLowerCase()));
    const base = defaultFolder(name, o.teammatesHome);
    for (let n = 1; n < 100; n++) {
      const f = n === 1 ? base : `${base}-${n}`;
      if (!taken.has(f.toLowerCase())) return f;
    }
    return `${base}-${randomBytes(3).toString("hex")}`;
  };
  /**
   * A new teammate in the team: checked, its folder made, its lane added, started. The team's own route and the lead's
   * manage_teammate tool both add one this way. The teammate, or what is wrong.
   */
  const addTeammate = async (sid: string, owner: { id: string; name: string }, body: Record<string, unknown>, more: Pick<Teammate, "mode" | "madeBy"> & { /** Asked once every check has passed, just before it is made: what stops it, or null. */ gate?: () => Promise<string | null> } = {}): Promise<Teammate | string> => {
    let c: ReturnType<typeof cleanTeammate>;
    try {
      c = cleanTeammate(body, ENGINE_TOOLS, owner.id);
    } catch (e) {
      return (e as Error).message;
    }
    // On an own model: one the person has set up here, now.
    const refused = c.tool === "friday" ? await ownModelRefused(owner, c.model ?? "") : null;
    if (refused) return refused;
    const gone = await missingDirOf(c.projects);
    if (gone) return `There's no folder at ${gone} on this computer.`;
    return teammates!.locked("team:add", async () => {
      const list = await teammates!.list();
      if (list.length >= MAX_TEAMMATES) return `A crew has up to ${MAX_TEAMMATES} teammates.`;
      if (list.some((t) => t.name.toLowerCase() === c.name.toLowerCase())) return `You already have a teammate called ${c.name}.`;
      // A folder picked that another teammate keeps its things in would give them one memory between them.
      const shared = c.folder && list.find((t) => t.folder.toLowerCase() === c.folder!.toLowerCase());
      if (shared) return `${shared.name} keeps its things in ${c.folder}. Pick another folder for ${c.name}, or leave it empty for one of its own.`;
      const stop = await more.gate?.();
      if (stop) return stop;
      const folder = c.folder ?? freeFolder(c.name, list);
      await makeFolder(folder);
      const added = await core.handle(sid, owner, { type: "lane.add", name: c.name, engine: true, control: { kind: "people", people: [owner.id] } });
      if (!added.ok) return added.error ?? "Couldn't add your teammate.";
      const ev = (await store.events(sid)).find((e) => e.seq === added.seq);
      const lane = ev?.body.type === "lane.added" ? ev.body.lane.id : "";
      if (!lane) return "Couldn't add your teammate.";
      // An agent's is told apart from the others by its face too, and waits for the person to keep it (madeBy). One made without
      // a look gets a colour none of the team has, while one is free (teammate-look.ts distinctLook; 2026-10-28: Lead and QA,
      // made in a row, came out the same pink).
      const look = c.look ?? distinctLook(more.madeBy && list.some((x) => (x.look ?? x.name) === c.name) ? `${c.name}-${randomBytes(2).toString("hex")}` : c.name, list.map((x) => x.look ?? x.name));
      const t: Teammate = { id: randomBytes(5).toString("hex"), ...c, ...(more.mode ? { mode: more.mode } : {}), ...(more.madeBy ? { madeBy: more.madeBy } : {}), look, folder, lane, created: Date.now() };
      await teammates!.put(t);
      if (t.effort) await setEffort(sid, owner, lane, t);
      // The first teammate leads: what is said in the Team room goes to it, and it hands the rest on (agent-mesh.ts).
      if (!list.length) await core.handle(sid, owner, { type: "lead.set", lane, auto: true });
      await startTeammate(sid, owner, t).catch((e: Error) => console.error(`[teammates] ${t.name} didn't start: ${e.message}`));
      return t;
    });
  };
  /** The first of `dirs` not a folder on this computer, or null. */
  const missingDirOf = async (dirs?: string[]) => (dirs ? (await Promise.all(dirs.map(async (d) => ((await stat(d).catch(() => null))?.isDirectory() ? null : d)))).find(Boolean) ?? null : null);
  /** A teammate brought into a room: a lane there, steered by the person alone, its tool started on it with that room's conversation. */
  const joinRoom = async (r: Room, owner: { id: string; name: string }, t: Teammate) => {
    const added = await core.handle(r.sid, owner, { type: "lane.add", name: t.name, engine: true, control: { kind: "people", people: [owner.id] } });
    if (!added.ok) throw new Error(added.error ?? `Couldn't bring ${t.name} into ${r.name}.`);
    const ev = (await store.events(r.sid)).find((e) => e.seq === added.seq);
    const lane = ev?.body.type === "lane.added" ? ev.body.lane.id : "";
    if (!lane) throw new Error(`Couldn't bring ${t.name} into ${r.name}.`);
    r.lanes[t.id] = lane;
    if (t.effort) await setEffort(r.sid, owner, lane, t);
    await startTeammate(r.sid, owner, t, {}, { lane, keepAs: roomKeep(t.id, r.id) }).catch((e: Error) => console.error(`[teammates] ${t.name} didn't start in ${r.name}: ${e.message}`));
  };
  /**
   * A teammate leaving a session it is a lane of (taken off the team, or out of a room): what is open with it settled first (its
   * asks and tasks, AgentMesh.onLaneRemoved), its turn there cancelled so a Stop's settling runs too, then its tool stopped and its
   * lane gone (2026-10-27 audit: its asks and tasks were left open for good, the lead's batch never coming).
   */
  const laneGoes = async (sid: string, owner: { id: string; name: string }, lane: string, why: string) => {
    await mesh.onLaneRemoved(sid, lane, why).catch((e) => closingOr("[teammates] settling", e));
    if (runOf(await store.state(sid), lane).status === "running") await core.handle(sid, owner, { type: "run.cancel", lane });
    await stopOnMachine(sid, owner, lane).catch(() => {});
    await core.handle(sid, owner, { type: "lane.remove", laneId: lane });
    // What it let go of goes to whoever is free now that it is gone (2026-10-28 audit: its review sat until the next sweep).
    await mesh.dispatch(sid).catch((e) => closingOr("[teammates] board", e));
  };
  /** A teammate out of a room: its tool there stopped and its lane gone; its conversation there is kept should it come back. */
  const leaveRoom = async (r: Room, owner: { id: string; name: string }, teammateId: string) => {
    const lane = r.lanes[teammateId];
    if (!lane) return;
    const name = laneName(await store.state(r.sid), lane);
    await laneGoes(r.sid, owner, lane, `${name} left the room "${r.name}", so it won't answer this. Ask someone else, or do it yourself.`);
    delete r.lanes[teammateId];
  };
  /** A room's lead: who is said to when nobody is @-named, the first who joined unless the lead is still in it. */
  const leadRoom = async (r: Room, owner: { id: string; name: string }, first?: string) => {
    const lanes = Object.values(r.lanes);
    const lead = (await store.state(r.sid)).lead;
    // A new room's lead is the first one picked, by name, not whichever lane its record lists first (2026-10-27 audit: the
    // test "the first in it leads" failed now and then).
    if (first && lanes.includes(first)) {
      if (lead !== first) await core.handle(r.sid, owner, { type: "lead.set", lane: first, auto: true });
      return;
    }
    if (lanes[0] && !lanes.includes(lead ?? "")) await core.handle(r.sid, owner, { type: "lead.set", lane: lanes[0], auto: true });
  };
  /**
   * A new room: some of the team, picked, in a session of their own (teammates.ts Room), from the page or an agent's ask. The room
   * made, with what didn't work when someone didn't join (`failed`); or only what is wrong, with no room made.
   */
  const makeRoom = async (owner: { id: string; name: string }, workspaceId: string, body: Record<string, unknown>, gate?: () => Promise<string | null>): Promise<{ room: Room; failed: string } | string> => {
    const list = await teammates!.list();
    let c: ReturnType<typeof cleanRoom>;
    try {
      c = cleanRoom(body, list.map((t) => t.id));
    } catch (e) {
      return (e as Error).message;
    }
    if (!c.name || !c.members) return "Give the room a name and pick who is in it.";
    // Counted and made under one lock: two made at once each found room for one more (2026-10-27 audit).
    const r = await teammates!.locked("rooms:add", async () => {
      if ((await teammates!.rooms()).length >= MAX_ROOMS) return `A crew keeps up to ${MAX_ROOMS} rooms. Take one away first.`;
      const stop = await gate?.();
      if (stop) return stop;
      const made: Room = { id: randomBytes(5).toString("hex"), name: c.name!, sid: randomBytes(6).toString("base64url"), lanes: {}, ...(c.purpose ? { purpose: c.purpose } : {}), created: Date.now() };
      // Kept from the start and after each teammate joins: a join that fails leaves a room to fix, not a session nobody lists
      // with tools running in it.
      await store.create(made.sid, made.name, { id: owner.id, name: owner.name, role: "owner" }, { team: true, controlMode: "ask", mcp: true }, workspaceId);
      await teammates!.putRoom(made);
      return made;
    });
    if (typeof r === "string") return r;
    const failed = await teammates!.locked(`room:${r.id}`, async () => {
      // Everyone picked is tried, one failing or not, and the room gets its lead whatever happened (2026-10-27 audit: the first
      // to fail left the rest out and the room with no lead).
      const failed: string[] = [];
      try {
        for (const id of c.members!) {
          // As it is stored now, under the room's lock: one taken off the team meanwhile isn't brought in.
          const mate = await teammates!.get(id);
          if (!mate) continue;
          try {
            await joinRoom(r, owner, mate);
          } catch (e) {
            failed.push((e as Error).message);
          } finally {
            await teammates!.putRoom(r);
          }
        }
      } finally {
        const first = c.members!.map((id) => r.lanes[id]).find(Boolean);
        await leadRoom(r, owner, first).catch((e) => closingOr("[teammates] room lead", e));
      }
      return failed.join(" ");
    });
    return { room: r, failed };
  };
  /**
   * A teammate's tool started again everywhere it is, after a change: the team and each room it is in. A lane mid-run, or waiting
   * on the person (a question, a command to approve), is started again as that run ends instead (restartLater), so the change
   * doesn't cut its work off (2026-10-28 audit: editing a teammate's role restarted it mid-turn everywhere). Where it waits for
   * that, by the room's name ("the Team room" for the team's).
   */
  const restartEverywhere = async (team: string, owner: { id: string; name: string }, was: Teammate, now: Teammate): Promise<string[]> => {
    const later: string[] = [];
    const busy = async (sid: string, lane: string) => {
      const st = await store.state(sid).catch(() => null);
      return !!st && (runOf(st, lane).status === "running" || runOf(st, lane).status === "waiting_for_human" || !!st.approvals[lane]);
    };
    if (await busy(team, was.lane)) (restartLater.set(`${team} ${was.lane}`, now.id), later.push("the Crew room"));
    else {
      await stopOnMachine(team, owner, was.lane).catch(() => {});
      await startTeammate(team, owner, now).catch((e: Error) => console.error(`[teammates] ${now.name} didn't start: ${e.message}`));
    }
    for (const r of await teammates!.rooms()) {
      const lane = r.lanes[now.id];
      if (!lane) continue;
      if (await busy(r.sid, lane)) {
        restartLater.set(`${r.sid} ${lane}`, now.id);
        later.push(r.name);
        continue;
      }
      await stopOnMachine(r.sid, owner, lane).catch(() => {});
      await startTeammate(r.sid, owner, now, {}, { lane, keepAs: roomKeep(now.id, r.id) }).catch((e: Error) => console.error(`[teammates] ${now.name} didn't start in ${r.name}: ${e.message}`));
    }
    return later;
  };
  /** The teammates' timers (switching back, check-ins), stopped as the app closes. */
  const teamTimers: ReturnType<typeof setInterval>[] = [];
  /** A teammate's turn tried again after a short rate limit (teamSwitch), waiting: cleared as the app closes. */
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Away mode and the team's own care of its work, set below with the teammates (the routes and the desktop app call them). */
  let awake: () => Promise<boolean> = async () => false;
  let runAway: (now?: number) => Promise<void> = async () => {};
  let awayTicking = false;
  let stopAll: (by: { id: string; name: string }) => Promise<string[]> = async () => [];
  let setPaused: (on: boolean) => Promise<void> = async () => {};
  let activityOf: (t: Teammate, days: number) => Promise<MateRun[]> = async () => [];
  let sinceOf: (ts: number) => Promise<TeamBrief> = async (ts) => ({ since: ts, until: Date.now(), done: [], failed: [], waiting: [], assumptions: [], usage: [] });
  let awayOn: (until: number) => Promise<void> = async () => {};
  let awayOff: () => Promise<unknown> = async () => null;
  let restartLater = new Map<string, string>();
  if (teammates) {
    // Out of usage, a teammate switches to its backup tool and carries on (Arun, 2026-10-27: "add a status for the teammate if
    // its coding tool hit its usage limit then switched to another coding tool to continue the work… also add that too"). Not
    // another account of the same tool: that is getting round its maker's limit (own-plan.ts), and switching accounts is the
    // person's call. Back on its own tool once the limit lifts, at its next start.
    /** Who a team session belongs to: its owner, the one person in it. */
    const ownerIn = (state: SessionState) => {
      const o = Object.entries(state.members).find(([, m]) => m.role === "owner");
      return o ? { id: o[0], name: o[1].name } : null;
    };
    /** The teammate on a lane of a team session, and how its tool there keeps its conversation (the team's, or that room's). */
    const placeOf = async (sid: string, lane: string): Promise<{ id: string; keepAs?: string } | null> => {
      const team = await teammates.team();
      if (sid === team) {
        const t = (await teammates.list()).find((x) => x.lane === lane);
        return t ? { id: t.id } : null;
      }
      const r = (await teammates.rooms()).find((x) => x.sid === sid);
      const id = r && Object.entries(r.lanes).find(([, l]) => l === lane)?.[0];
      return r && id ? { id, keepAs: roomKeep(id, r.id) } : null;
    };
    /**
     * Busy on a lane: mid-run, or waiting on the person (a question, a command to approve). Restarting its tool then cut the
     * question off (2026-10-27 audit).
     */
    const busyOn = (state: SessionState, lane: string) => runOf(state, lane).status === "running" || runOf(state, lane).status === "waiting_for_human" || !!state.approvals[lane];
    /** Every lane a teammate has, the team's and each room's, with how to start it and whether it is busy there now. */
    const lanesOfMate = async (t: Teammate) => {
      const team = await teammates.team();
      const out: { sid: string; lane: string; at?: { lane: string; keepAs: string }; busy: boolean }[] = [];
      if (team) out.push({ sid: team, lane: t.lane, busy: busyOn(await store.state(team), t.lane) });
      for (const r of await teammates.rooms()) {
        const lane = r.lanes[t.id];
        if (!lane) continue;
        const state = await store.state(r.sid).catch(() => null);
        if (!state?.lastSeq) continue;
        out.push({ sid: r.sid, lane, at: { lane, keepAs: roomKeep(t.id, r.id) }, busy: busyOn(state, lane) });
      }
      return out;
    };
    /** Friday's own word to a teammate (the switch, a check-in, a retry): said as Friday, never as the person (Friday's notes). */
    const FRIDAY_SAYS = { id: "friday", name: "Friday", kind: "system" as const };
    /**
     * Friday telling a teammate's tool something on its lane, and waking it: as Friday, not the person, so it neither lifts a
     * person's hold, nor counts as the person steering it (autoWake's backoff, the board's sweep) (2026-10-27 audit).
     */
    const tellTeammate = async (sid: string, lane: string, text: string, more: { hop?: number; ownTurn?: true } = {}) => {
      const sent = await store.append(sid, FRIDAY_SAYS, { type: "instruction", text, interrupt: false, ...more }, { lane });
      if (sent.ok) void bus.wake(sid, lane);
      return sent.ok;
    };
    /**
     * Whether this computer has `tool` ready to run, as the runner says (its tools: installed, signed in); null when it can't say,
     * which switches as before.
     */
    const toolReady = async (owner: { id: string; name: string }, tool: EngineTool): Promise<boolean | null> => {
      if (process.env.FRIDAY_TEAMMATES_DRY === "1") return teammateDry.tools ? teammateDry.tools.includes(tool) : null;
      const listed = await (callHost("tools", {}, hostCtx(owner)) as Promise<{ tools?: MachineTool[] }>).then((r) => r.tools ?? null, () => null);
      const t = listed?.find((x) => x.tool === tool);
      return listed ? !!t?.path && t.loggedIn !== false : null;
    };
    /** Short rate limits a lane rode out by waiting, by session and lane: when each retry was set, to give up after a few. */
    const retried = new Map<string, number[]>();
    const RETRIES = 3;
    /** One lane of a teammate started again as `t` says; false when its tool didn't start. */
    const restartLane = async (sid: string, by: { id: string; name: string }, t: Teammate, lane: string, at?: { lane: string; keepAs: string }) => {
      await stopOnMachine(sid, by, lane).catch(() => {});
      return startTeammate(sid, by, t, {}, at).then(
        () => true,
        (e: Error) => (console.error(`[teammates] ${t.name} didn't start on ${runsOnName(t)}: ${e.message}`), false),
      );
    };
    // ── The team while the person is away, and its own care of its work (Arun, 2026-10-28: "we need to ensure teams can work
    // basically while you are away") ───────────────────────────────────────────────────────────────────────────────────────
    /** Every place the team works: the Team room and each room, with each teammate's lane there. */
    const placesNow = async (): Promise<{ sid: string; room: Room | null; lanes: Record<string, string> }[]> => {
      const [team, list, rooms] = await Promise.all([teammates.team(), teammates.list(), teammates.rooms()]);
      return [...(team ? [{ sid: team, room: null, lanes: Object.fromEntries(list.map((t) => [t.id, t.lane])) as Record<string, string> }] : []), ...rooms.map((r) => ({ sid: r.sid, room: r, lanes: r.lanes }))];
    };
    /**
     * A teammate's turn carried on later (a short rate limit, its usage limit, an error while away): a resume in the log and the
     * store's list of them, so a restart in between doesn't lose it, carried on as Friday at its time (teamResume). One due within
     * the minute is fired here at its time as well, not only by the half-minute loop.
     */
    const scheduleTeamResume = async (sid: string, lane: string, at: number) => {
      const r = await store.append(sid, FRIDAY_SAYS, { type: "resume.scheduled", at }, { lane });
      if (r.ok && at - Date.now() < 60_000) {
        const timer = setTimeout(
          () => {
            retryTimers.delete(timer);
            void tickResumes().catch((e) => closingOr("[teammates] resume", e));
          },
          Math.max(0, at - Date.now()) + 10,
        );
        timer.unref?.();
        retryTimers.add(timer);
      }
      return r.ok;
    };
    /**
     * A teammate's resume come due: told to carry on, as Friday and a turn of its own, with why (its limit lifted, a short rate
     * limit waited out, an error tried again). Not when it ran or the person wrote on the lane since: what it was to carry on is
     * in hand already (2026-10-28 audit: a retry fired over a turn the person had started).
     */
    teamResume = async (sid, lane, seq) => {
      const [state, events] = await Promise.all([store.state(sid), store.events(sid)]);
      if (lane !== MAIN_LANE && !state.lanes.some((l) => l.id === lane)) return false;
      if (events.some((e) => e.seq > seq && (e.lane ?? MAIN_LANE) === lane && (e.body.type === "run.started" || (e.body.type === "instruction" && e.actor.kind === "human")))) {
        await store.append(sid, FRIDAY_SAYS, { type: "resume.cancelled", why: "It carried on meanwhile." }, { lane });
        return false;
      }
      const end = events.findLast((e) => e.seq < seq && (e.lane ?? MAIN_LANE) === lane && e.body.type === "run.ended");
      const err = end?.body.type === "run.ended" ? end.body.error : undefined;
      const text = limitHit(err, end?.ts)
        ? planLimitHit(err, end?.ts)
          ? "[Friday] Your usage limit has reset. Carry on with your task where you left off; don't start over."
          : "[Friday] Your tool hit a short rate limit partway through, so Friday waited a moment. Carry on where you left off; don't start over."
        : `[Friday] Your last turn stopped on an error${err ? ` (${err.split("\n")[0]!.slice(0, 200)})` : ""}, so Friday is trying it again. Carry on where you left off; don't start over. If the same thing fails again, work round it, or say in one line what blocks you.`;
      return tellTeammate(sid, lane, text, { hop: 1, ownTurn: true });
    };

    /** The brief over [since, until] across every place the team works (team-away.ts teamBrief). */
    const briefOf = async (since: number, until: number) => {
      const list = await teammates.list();
      const places: Place[] = [];
      for (const p of await placesNow()) {
        const events = await store.events(p.sid).catch(() => null);
        if (events) places.push({ sid: p.sid, room: p.room?.name ?? null, events, lanes: p.lanes });
      }
      return awayBrief(places, list.map((t) => ({ id: t.id, name: t.name, lane: t.lane })), since, until);
    };
    /**
     * The brief posted in the Team room (team.brief), which the page draws as the morning brief and notifies with. Only when it
     * has something to say (Arun, 2026-10-28: "really iron out bugs and feature problems and gaps"; a brief came for a 0-minute
     * absence, and "Nothing to report" ones).
     */
    const postBrief = async (since: number, until: number) => {
      const team = await teammates.team();
      if (!team) return;
      const b = await briefOf(since, until);
      if (!briefWorthPosting(b)) return;
      await store.append(team, FRIDAY_SAYS, { type: "team.brief", ...b }, { lane: MAIN_LANE });
      console.log(`[teammates] ${briefLine(b)}`);
    };
    /**
     * Away mode over: at the time the person set, on "I'm back", or as they write in any team chat. Ended once, under a lock, and
     * the brief of the whole stretch posted then.
     */
    const endAway = async () => {
      const a = await teammates.locked("away", async () => {
        const had = await teammates.away();
        if (had) await teammates.setAway(null);
        return had;
      });
      if (a) await postBrief(a.since, Date.now());
      return a;
    };
    /**
     * Away mode on: until when, from now. Old holds are lifted (an old "everyone stop" would keep the team idle all night), and
     * what was queued meanwhile is started. Said only where a teammate was on hold, naming who (2026-10-28 away run: "Every hold
     * on the team is lifted" in every room on every away, with nobody on hold).
     */
    const startAway = async (until: number) => {
      const had = await teammates.away();
      await teammates.setAway({ until, since: had?.since ?? Date.now() });
      if (!had)
        for (const p of await placesNow()) {
          const events = await store.events(p.sid).catch(() => null);
          const held = events ? Object.values(p.lanes).filter((l) => heldByPerson(events, l)) : [];
          if (held.length) await store.append(p.sid, FRIDAY_SAYS, { type: "holds.lifted", lanes: held, why: "The person is away: the crew carries on by itself." }, { lane: MAIN_LANE }).catch(() => undefined);
        }
      await repump();
    };

    /**
     * Every team lane with work queued that it may start, idle, its tool there and not out of usage: woken, so nothing is left
     * stranded in a queue (a wake lost, a pause lifted, a limit that lifted in the night). The hub decides again what it may run.
     */
    const repump = async () => {
      if (await teammates.paused()) return;
      for (const p of await placesNow()) {
        const [state, events] = await Promise.all([store.state(p.sid).catch(() => null), store.events(p.sid).catch(() => null)]);
        if (!state || !events) continue;
        for (const lane of Object.values(p.lanes)) {
          const run = runOf(state, lane).status;
          if (run === "running" || run === "waiting_for_human" || run === "paused" || !state.engines[lane]?.online) continue;
          if (!runnableQueue(events, lane, pendingFor(state, lane)).length) continue;
          void bus.wake(p.sid, lane);
        }
      }
    };

    /**
     * Whether this computer should be kept awake (local/desktop.ts): away, and the team has work in hand: a lane running or
     * something queued, a resume or wake due within two hours, or a board still being worked on.
     */
    const wantsAwake = async (): Promise<boolean> => {
      if (!(await teammates.away()) || (await teammates.paused())) return false;
      const soon = Date.now() + 2 * 3_600_000;
      for (const p of await placesNow()) {
        const state = await store.state(p.sid).catch(() => null);
        if (!state) continue;
        if (state.board && boardBusy(state)) return true;
        // A resume is spent at its time (teamResume), not taken off: one more than five minutes past is behind it.
        if (Object.values(state.resumes ?? {}).some((r) => r.at > Date.now() - 5 * 60_000 && r.at <= soon)) return true;
        if (Object.values(state.wakes ?? {}).some((w) => (w.on.at ?? Infinity) <= soon)) return true;
        for (const lane of Object.values(p.lanes)) if (runOf(state, lane).status === "running" || pendingFor(state, lane).length) return true;
      }
      return false;
    };
    awake = wantsAwake;

    /**
     * After a teammate's run ends, while the person is away: a turn that ended on a question is answered once, "decide it yourself"
     * (team-away.ts awayAnswer); one that stopped on an error that isn't a usage limit is tried again after 2, 10 and 30 minutes.
     * And a lane whose tool was changed while it worked starts again on it now (restartLater).
     */
    const ERROR_RETRIES = [2, 10, 30];
    const afterTeamRun = async (sid: string, lane: string, end: SessionEvent) => {
      if (end.body.type !== "run.ended") return;
      const later = restartLater.get(`${sid} ${lane}`);
      // Not while it waits on the person (its question, a command to approve): the restart would cut that off; the next end then.
      if (later && end.body.outcome !== "waiting" && !(await store.state(sid)).approvals[lane]) {
        restartLater.delete(`${sid} ${lane}`);
        const t = await teammates.get(later);
        const place = await placeOf(sid, lane);
        const by = ownerIn(await store.state(sid));
        if (t && by) await restartLane(sid, by, t, lane, place?.keepAs ? { lane, keepAs: place.keepAs } : undefined);
      }
      const a = await teammates.away();
      if (!a || end.body.cut) return;
      const [state, events] = await Promise.all([store.state(sid), store.events(sid)]);
      if (end.body.outcome === "error") {
        if (limitHit(end.body.error, end.ts)) return;
        // Counted since its current task began: its turns on one task tried three times at most.
        const from = events.findLast((e) => (e.lane ?? MAIN_LANE) === lane && e.body.type === "instruction" && (e.actor.kind === "human" || e.body.mesh?.kind === "task" || !!e.body.mesh?.board))?.seq ?? 0;
        const tries = events.filter((e) => e.seq > from && (e.lane ?? MAIN_LANE) === lane && e.body.type === "resume.scheduled" && e.actor.id === FRIDAY_SAYS.id).length;
        if (tries < ERROR_RETRIES.length) await scheduleTeamResume(sid, lane, Date.now() + ERROR_RETRIES[tries]! * 60_000 * (teammateDry.retryMs !== undefined ? teammateDry.retryMs / 60_000 : 1));
        return;
      }
      const start = events.findLast((e) => e.seq < end.seq && (e.lane ?? MAIN_LANE) === lane && e.body.type === "run.started");
      const said = events.findLast((e) => e.seq > (start?.seq ?? 0) && e.seq < end.seq && (e.lane ?? MAIN_LANE) === lane && e.body.type === "agent.message" && !!e.body.text.trim());
      const asked = !!state.openQuestions[lane] || !!state.asks[lane] || (said?.body.type === "agent.message" && endsOnQuestion(said.body.text));
      if (!asked) return;
      // Once for each question: claimed by the turn's end, so a second process or a repeat call doesn't answer it again.
      if (!(await redis.set(`${o.prefix}away-answered:${sid}:${lane}:${end.seq}`, "1", "EX", 86_400, "NX"))) return;
      await tellTeammate(sid, lane, awayAnswer(a.until), { hop: 1 });
    };

    teamHear = (sid, ev) => {
      const b = ev.body;
      const person = b.type === "instruction" && ev.actor.kind === "human";
      if (!person && b.type !== "run.ended" && b.type !== "lane.removed") return;
      void (async () => {
        const state = await store.state(sid).catch(() => null);
        if (!state?.options.team) return;
        // The person writing in any team chat is them back.
        if (person) return void (await endAway());
        if (b.type === "lane.removed") {
          mesh.forget(sid, b.laneId);
          noteMemory.delete(`${sid} ${b.laneId}`);
          for (const k of retried.keys()) if (k === `${sid} ${b.laneId}`) retried.delete(k);
          return;
        }
        await afterTeamRun(sid, ev.lane ?? MAIN_LANE, ev);
      })().catch((e) => closingOr("[teammates] hearing", e));
    };

    /**
     * The lead's hand-off when the work it gave out is done while the person is away: the goal again, and how to land it (merge
     * the teammates' branches, run the full tests, open one pull request, write the brief). The brief so far is posted too.
     */
    mesh.teamDone = async (sid, lead) => {
      if (!(await teammates.sessions()).includes(sid)) return null;
      const a = await teammates.away();
      const lt = (await teammates.list()).find((t) => t.lane === lead);
      const repo = lt ? projectsOf(lt)[0] : undefined;
      // The teammates' own copies of the lead's repo (copyFor): their branches are what it merges into one pull request.
      const branches = [...copies.values()].filter((c) => !repo || c.repo.toLowerCase() === repo.toLowerCase());
      if (!a && !branches.length) return null;
      const [now, events] = await Promise.all([store.state(sid), store.events(sid)]);
      const goal = events.findLast((e) => (e.lane ?? MAIN_LANE) === lead && e.body.type === "instruction" && e.actor.kind === "human" && !e.body.approval);
      // The brief so far, once for each board (or goal) and only when all of it is done: a task blocked or sent back is still
      // the lead's to sort out (2026-10-28 away run: two briefs in 12 s, the first as a task came back blocked). The brief at the
      // end of the stretch then takes its place (the page shows the latest of a stretch).
      const settled = !now.board || now.board.tasks.every((t) => t.status === "done" || t.status === "cancelled");
      if (a && settled && (await redis.set(`${o.prefix}away-brief:${sid}:${a.since}:${now.board ? `b${now.board.seq}` : `g${goal?.seq ?? 0}`}`, "1", "EX", 86_400, "NX")))
        void postBrief(a.since, Date.now()).catch((e) => closingOr("[teammates] brief", e));
      const land = `${branches.length ? `merge your teammates' branches (${branches.map((c) => c.branch).join(", ")}) into one branch for this goal in ${branches[0]!.repo}, ` : ""}run the full tests and fix what fails, then open one pull request with gh pr create for the person to review. Don't merge it, push to the default branch or deploy.`;
      if (!a) return `[Friday] Land the work: ${land}`;
      return [
        `[Friday] The person is away until ${clockOf(a.until)}.${goal?.body.type === "instruction" ? ` The goal they gave you: "${goal.body.text.trim().slice(0, 1500)}"` : ""}`,
        `Land it now: ${land}`,
        "Then end with the morning brief, in a few lines: what got done, the pull request, what you assumed, what is blocked, and what needs the person.",
      ].join("\n\n");
    };

    /** Away mode's own clock, every 20 seconds: over at its time, approvals not left waiting all night, nothing stranded. */
    const AWAY_APPROVAL_MS = 10 * 60_000;
    runAway = async (now = Date.now()) => {
      const a = await teammates.away();
      if (a && now >= a.until) await endAway();
      else if (a) {
        // A teammate in plan or edits mode asking to run something while nobody can answer: told no, and to decide for itself,
        // after ten minutes.
        for (const p of await placesNow()) {
          const [state, events] = await Promise.all([store.state(p.sid).catch(() => null), store.events(p.sid).catch(() => null)]);
          if (!state || !events) continue;
          for (const lane of Object.values(p.lanes)) {
            const ask = state.approvals[lane];
            const at = ask && events.find((e) => e.seq === ask.seq)?.ts;
            if (!ask || !at || now - at < AWAY_APPROVAL_MS) continue;
            // As Friday, not the person: the person answering is them back, and this isn't them (it would end away mode).
            const r = await store.append(p.sid, FRIDAY_SAYS, { type: "instruction", text: `[Friday] The person is away until ${clockOf(a.until)} and can't approve that, so it was declined. Do what you can without it, decide the rest yourself (the safest reasonable option), record what you chose with write_note under a key starting "assumption", and carry on.`, interrupt: false, approval: { id: ask.id, approve: false }, hop: 1 }, { lane });
            if (r.ok) void bus.wake(p.sid, lane);
          }
        }
      }
      await repump();
      mesh.pruneTold(now);
      for (const [k, at] of retried) if (!at.some((x) => now - x < 30 * 60_000)) retried.delete(k);
    };
    teamTimers.push(
      setInterval(() => {
        if (awayTicking) return;
        awayTicking = true;
        void runAway()
          .catch((e) => closingOr("[teammates] away", e))
          .finally(() => (awayTicking = false));
      }, 20_000),
    );

    /** Every teammate's running turn stopped, in the Team room and every room, its queue kept (run.pause): who was stopped. */
    stopAll = async (by: { id: string; name: string }) => {
      const list = await teammates.list();
      const stopped: string[] = [];
      for (const p of await placesNow()) {
        const state = await store.state(p.sid).catch(() => null);
        if (!state) continue;
        for (const [id, lane] of Object.entries(p.lanes)) {
          if (runOf(state, lane).status !== "running") continue;
          const r = await core.handle(p.sid, by, { type: "run.pause", lane });
          const name = list.find((t) => t.id === id)?.name;
          if (r.ok && name && !stopped.includes(name)) stopped.push(name);
        }
      }
      return stopped;
    };
    /** The team paused or let go on: held, nothing of the agents' starts; let go, what waited is started. */
    setPaused = async (on: boolean) => {
      await teammates.setPaused(on);
      if (!on) await repump();
    };

    /** A teammate's runs everywhere it works over the last `days`, newest first (GET /api/teammates/:id/activity). */
    activityOf = async (t: Teammate, days: number): Promise<MateRun[]> => {
      const from = Date.now() - days * 86_400_000;
      const out: MateRun[] = [];
      for (const p of await placesNow()) {
        const lane = p.lanes[t.id];
        if (!lane) continue;
        const look = await teamLook(p.sid).catch(() => null);
        for (const r of look?.runs ?? []) {
          if (r.lane !== lane || (r.endedAt ?? Date.now()) < from) continue;
          out.push({ sid: p.sid, room: p.room ? look!.state.title || p.room.name : null, lane, startedAt: r.startedAt, endedAt: r.endedAt, outcome: r.outcome, said: r.said.slice(0, 2000), files: r.files.slice(0, 50) });
        }
      }
      return out.sort((a, b) => b.startedAt - a.startedAt).slice(0, 500);
    };
    sinceOf = (ts: number) => briefOf(ts, Date.now());
    awayOn = startAway;
    awayOff = endAway;
    // The Team room's roster tool (agent-mesh.ts TEAMMATE_TOOL): the teammates there add the teammate the person asks for, or
    // change one's role, each change a line in the room (Arun, 2026-10-27: "needs to be on par with Open Bot if not even better").
    // From any session, not the Team room alone (Arun, 2026-10-27: "everything is full agentic and can be utilized by the coding
    // tools"): a change is said as a line in the Team room, where the roster lives, and answered where it was asked.
    mesh.teammateTool = {
      offered: async () => true,
      call: async (sid, lane, args) => {
        const here = await store.state(sid);
        const owner = ownerIn(here);
        if (!owner) return { output: "This session has nobody to answer to.", isError: true };
        const action = typeof args.action === "string" ? args.action.trim() : "";
        // What an agent may change is what it may do itself, as start_session and manage_automation have it (2026-10-27 audit:
        // a plan-mode agent made a full-mode teammate in a repo and then told it what to do): nothing from plan mode, nothing from
        // a session another agent started (one level of fan-out only), and teammates and rooms started count towards the hour's.
        const askerMode: EngineMode = here.engines[lane]?.mode ?? "edits";
        if (action === "create" || action === "update" || action === "create_room") {
          if (askerMode === "plan") return { output: "You're in plan mode: you can list the crew and its rooms, not add, change or make them. Say what you'd set up, and let the person do it.", isError: true };
          if (await agentStarted(sid)) return { output: "This session was started by another agent, and doesn't change the crew. Tell the agent that started it what you'd set up.", isError: true };
        }
        // The Team room is made only for a change: looking at a team nobody has made yet doesn't make one.
        const teamSid = action === "create" || action === "update" || action === "create_room" ? await teamSession(owner, here.workspaceId ?? LOCAL_WORKSPACE.id) : await teammates.team();
        const inTeam = !!teamSid && teamSid === sid;
        const list = await teammates.list();
        const me = inTeam ? list.find((t) => t.lane === lane) : undefined;
        const by = { id: "agent", name: me?.name ?? (laneName(here, lane) === "Main" ? "An agent" : laneName(here, lane)), kind: "agent" as const };
        // The line goes in the Team room: on the asker's own lane there, or the room's own when it asked from elsewhere.
        const told = { lane: inTeam ? lane : MAIN_LANE };
        const arg = (k: string) => (typeof args[k] === "string" ? (args[k] as string).trim() : "");
        const where = (t: Teammate) => [...projectsOf(t), t.folder].join(", ");
        // Counted once what is asked has passed its own checks, as it is about to start: one turned away for its name or a folder
        // that isn't there spent one of the hour's starts (2026-10-27 audit).
        const startGate = async () => ((await startsLeft(owner.id)) ? null : `Agents have started ${AGENT_STARTS_PER_HOUR} sessions, runs or teammates for the person in the last hour. Say what you'd set up in your reply, and let them decide.`);
        switch (arg("action")) {
          case "list": {
            // The person's own models, by name, for a teammate on one: and which there are to pick for a new one (create's model).
            const mine = (await ownModelsHere(owner)) ?? [];
            const ownNames = new Map(mine.map((m) => [ownModelId(owner.id, m.id), m.name]));
            const models = mine.length ? `\n\nThe person's own models a teammate can run on (create with tool "friday" and model set to one's name): ${mine.map((m) => m.name).join(", ")}.` : "";
            return {
              output: (list.length
                ? list.map((t) => `${t.name}${t.id === me?.id ? " (you)" : ""}: ${t.tool === "friday" ? `own model ${ownNames.get(t.model ?? "") ?? "(not set up here now)"}` : `${ENGINE_NAMES[t.tool]}${t.model ? ` (${t.model})` : ""}`}${t.mode && t.mode !== "full" ? `, ${t.mode} mode` : ""}, works in ${where(t)}.\n  ${t.role || "No role written yet."}`).join("\n")
                : "There are no teammates yet.") + models,
            };
          }
          case "create": {
            const folders = Array.isArray(args.folders) ? args.folders.filter((f): f is string => typeof f === "string") : [];
            const tool = arg("tool").toLowerCase() || me?.tool || here.engines[lane]?.tool || "claude";
            // On one of the person's own models, named as they named it (or its id); none named, the one the asker runs on, or
            // the person's only one. Theirs alone, and set up here now: addTeammate checks it as it does the page's.
            let model = "";
            if (tool === "friday") {
              const mine = (await ownModelsHere(owner)) ?? [];
              const want = arg("model").toLowerCase();
              const m = want ? mine.find((x) => x.name.toLowerCase() === want || x.id === want || ownModelId(owner.id, x.id) === want) : me?.tool !== "friday" && mine.length === 1 ? mine[0] : undefined;
              model = m ? ownModelId(owner.id, m.id) : !want && me?.tool === "friday" ? (me.model ?? "") : "";
              if (!model) return { output: mine.length ? `Say which of the person's own models it runs on, by name: ${mine.map((x) => x.name).join(", ")}.` : "The person has no models of their own set up (Settings › Your models), so a teammate can't run on one. Pick a coding tool, or ask them to add a model.", isError: true };
            }
            // At no more than the agent that made it may go.
            const madeBy = { lane, name: by.name };
            const made = await addTeammate(teamSid!, owner, { name: arg("name"), role: arg("role"), tool, ...(model ? { model } : {}), projects: folders }, { ...(MODE_RANK[askerMode] < MODE_RANK.full ? { mode: askerMode } : {}), madeBy, gate: startGate });
            if (typeof made === "string") return { output: made, isError: true };
            await store.append(teamSid!, by, { type: "teammate.changed", name: made.name, lane: made.lane, added: true, role: made.role }, told);
            // For the person to keep or remove, as news in the Team room; it works meanwhile (2026-10-28).
            await store.append(teamSid!, FRIDAY_SAYS, { type: "teammate.proposed", id: made.id, name: made.name, lane: made.lane, madeBy }, { lane: MAIN_LANE });
            return { output: `${made.name} joined the crew on ${made.tool === "friday" ? "the person's own model" : ENGINE_NAMES[made.tool]}${made.mode ? `, in ${made.mode} mode as you are` : ""}, working in ${where(made)}. It is starting now: brief it with ${inTeam ? "message_agent or assign_task" : `message_session, to "${teamSid}" and agent "${made.name}"`}.` };
          }
          case "update": {
            const t = list.find((x) => x.name.toLowerCase() === arg("name").toLowerCase());
            if (!t) return { output: `There's no teammate called ${arg("name") || "that"}. Call manage_teammate with action list to see the crew.`, isError: true };
            // Another's standing role is the person's to change, or the Team room lead's: a teammate rewriting another's role
            // rewrote what it does on every turn from then on (2026-10-27 audit).
            const lead = teamSid ? (await store.state(teamSid)).lead : null;
            if (t.id !== me?.id && !(inTeam && lead === lane)) {
              const leadName = list.find((x) => x.lane === lead)?.name;
              return { output: `${t.name}'s role is the person's to change${leadName ? `, or ${leadName}'s as the Crew room's lead` : ""}, not yours. Tell ${leadName ? `${leadName} or ` : ""}the person what you'd change it to, and why.`, isError: true };
            }
            if (MODE_RANK[t.mode ?? "full"] > MODE_RANK[askerMode]) return { output: `${t.name} may do more than you may (${t.mode ?? "full"}, you ${askerMode}), so its role is the person's to change.`, isError: true };
            const role = arg("role").slice(0, 4000);
            if (!role) return { output: "Give the new role.", isError: true };
            const next = await teammates.update(t.id, (cur) => ({ ...cur, role }));
            if (!next) return { output: `${t.name} isn't in the crew any more.`, isError: true };
            await store.append(teamSid!, by, { type: "teammate.changed", name: next.name, lane: next.lane, added: false, role }, told);
            return { output: `${next.name}'s role is changed. It reads it from its next turn.` };
          }
          case "rooms": {
            const rooms = await teammates.rooms();
            const name = (id: string) => list.find((t) => t.id === id)?.name ?? "someone gone";
            return {
              output: rooms.length
                ? rooms.map((r) => `"${r.name}" [id ${r.sid}]: ${Object.keys(r.lanes).map(name).join(", ") || "nobody yet"}${r.purpose ? `. For: ${r.purpose}` : ""}`).join("\n")
                : "There are no rooms yet: create_room makes one.",
            };
          }
          case "create_room": {
            const names = Array.isArray(args.members) ? args.members.filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase()) : [];
            const ids = names.map((n) => list.find((t) => t.name.toLowerCase() === n)?.id).filter((x): x is string => !!x);
            if (names.length && ids.length < names.length) return { output: `Not in the crew: ${names.filter((n) => !list.some((t) => t.name.toLowerCase() === n)).join(", ")}. Call manage_teammate with action list.`, isError: true };
            // A room starts its members' tools again: none that may do more than the asker, and it counts towards the hour's starts.
            const stronger = ids.map((id) => list.find((t) => t.id === id)!).filter((t) => MODE_RANK[t.mode ?? "full"] > MODE_RANK[askerMode]);
            if (stronger.length) return { output: `${stronger.map((t) => t.name).join(", ")} may do more than you may (you ${askerMode}), so a room with ${stronger.length === 1 ? "it" : "them"} is the person's to make.`, isError: true };
            const made = await makeRoom(owner, here.workspaceId ?? LOCAL_WORKSPACE.id, { name: arg("name"), purpose: arg("role"), members: ids }, startGate);
            if (typeof made === "string") return { output: made, isError: true };
            const r = made.room;
            // A teammate that didn't join leaves the room made all the same: say so, with its id, so a retry doesn't make a second one.
            if (made.failed) return { output: `Made the room "${r.name}" [id ${r.sid}], but not everyone joined: ${made.failed} Who is in it: ${Object.keys(r.lanes).map((id) => list.find((t) => t.id === id)?.name ?? "").filter(Boolean).join(", ") || "nobody yet"}. The person can add the rest from the room's menu.`, isError: true };
            return { output: `Made the room "${r.name}" [id ${r.sid}] with ${ids.map((id) => list.find((t) => t.id === id)!.name).join(", ")}. Their tools are starting there; message_session it to brief them.` };
          }
          default:
            return { output: "Say which: list, create, update, rooms or create_room.", isError: true };
        }
      },
    };
    mesh.teamSwitch = async (sid, lane) => {
      const place = await placeOf(sid, lane);
      if (!place) return false;
      // On the person's own model there is no plan of a coding tool's to run out of, and no backup to carry on: a busy or
      // unreachable model server is said in its chat as its run's end, and on its row (teammateViews), never a switch.
      if ((await teammates.get(place.id))?.tool === "friday") return false;
      const [events, state] = await Promise.all([store.events(sid), store.state(sid)]);
      const end = events.findLast((e) => e.body.type === "run.ended" && (e.lane ?? MAIN_LANE) === lane);
      if (end?.body.type !== "run.ended" || end.body.outcome !== "error") return false;
      const by = ownerIn(state);
      if (!by || !limitHit(end.body.error, end.ts)) return false;
      // The account's allowance spent switches it; a limit gone in a minute (a per-minute 429, "too many requests") is waited out
      // and the turn tried again, a few times, before the backup is the answer (2026-10-27 audit: a per-minute 429 put a teammate
      // on its backup for five hours).
      let hit = planLimitHit(end.body.error, end.ts);
      if (!hit) {
        const key = `${sid} ${lane}`;
        const recent = (retried.get(key) ?? []).filter((at) => Date.now() - at < 30 * 60_000);
        if (recent.length < RETRIES) {
          retried.set(key, [...recent, Date.now()]);
          // Kept as a resume (the log and the store's list of them), so a restart meanwhile doesn't lose it; at its time it goes
          // only if nothing ran and nobody wrote on the lane since (teamResume) (2026-10-28 audit).
          await scheduleTeamResume(sid, lane, Date.now() + (teammateDry.retryMs ?? 30_000) * 2 ** recent.length);
          return true;
        }
        hit = { resetsAt: null };
      }
      // The tool this lane's run was on: the one that ran out.
      const ran = state.engines[lane]?.tool;
      const switched = await teammates.locked(`t:${place.id}`, async () => {
        const t = await teammates.get(place.id);
        // Put on its own model meanwhile: nothing to switch (see above).
        if (!t || t.tool === "friday") return false;
        let next: Teammate & { tool: EngineTool } = { ...t, tool: t.tool };
        if (!t.switched) {
          // Only its own tool running out switches it; a lane still on something else is left to the usual hand-on.
          if (ran !== t.tool) return false;
          const to = backupOf(t);
          if (to === t.tool) return false;
          // Never to a tool this computer doesn't have ready: the lane was left with no tool at all (2026-10-27 audit).
          if ((await toolReady(by, to)) === false) return false;
          const routes = ENGINE_MODEL_INFO[to].some((m) => m.id === "auto");
          // No account on the backup: the one picked is the first tool's (accounts.ts), never lent to another.
          next = {
            ...t,
            tool: to,
            model: routes ? "auto" : undefined,
            effort: t.effort && (EFFORT_LEVELS[to] ?? []).includes(t.effort) ? t.effort : undefined,
            account: undefined,
            switched: { from: t.tool, ...(t.model ? { fromModel: t.model } : {}), ...(t.account ? { fromAccount: t.account } : {}), ...(t.effort ? { fromEffort: t.effort } : {}), until: hit.resetsAt ?? null, at: Date.now() },
          };
          await teammates.put(next);
        } else if (ran !== t.switched.from) {
          // Its backup ran out too: nothing left to switch to, so no switching back and forth; the usual hand-on follows.
          return false;
        }
        // This lane, now idle on its limit, onto the backup. A start that fails puts the record back and its own tool on the lane
        // again, rather than leaving the lane with none (2026-10-27 audit), and the usual hand-on follows.
        if (!(await restartLane(sid, by, next, lane, place.keepAs ? { lane, keepAs: place.keepAs } : undefined))) {
          if (next.switched !== t.switched) {
            await teammates.put(t);
            await restartLane(sid, by, t, lane, place.keepAs ? { lane, keepAs: place.keepAs } : undefined);
          }
          return false;
        }
        // Its other lanes follow when idle; one mid-run carries on where it is, and switches when it too ends on the limit.
        if (next.switched !== t.switched) for (const l of await lanesOfMate(next)) if (!(l.sid === sid && l.lane === lane) && !l.busy) await restartLane(l.sid, by, next, l.lane, l.at);
        await store.append(sid, FRIDAY_SAYS, { type: "teammate.switched", name: t.name, lane, from: next.switched!.from, to: next.tool, until: next.switched!.until });
        // It carries on: a new tool is a new conversation, so it is given the record of what it did. As the turn that ran out,
        // agent steps and all, not a new start (behindRun).
        const brief = handoffBrief(events, lane, end.seq);
        const text = `[Friday] ${ENGINE_NAMES[next.switched!.from]} ran out of usage partway through your work, so you are on ${ENGINE_NAMES[next.tool]} now. Carry on where you left off and finish it.${brief ? `\n\n${brief}` : ""}`;
        await tellTeammate(sid, lane, text, { hop: hopBehind(state, events, lane) });
        return true;
      });
      return switched;
    };
    // Back on its own tool, account, model and effort once that limit lifts (or five hours on, when it never said), and only when
    // none of its lanes is mid-run, so no turn is cut off: checked each minute, one pass at a time.
    const backAt = (sw: NonNullable<Teammate["switched"]>) => sw.until ?? sw.at + 5 * 3_600_000;
    let backing = false;
    runBack = async () => {
          const team = await teammates.team();
          if (!team) return;
          const by = ownerIn(await store.state(team));
          if (!by) return;
          for (const t of await teammates.list()) {
            if (!t.switched || backAt(t.switched) > Date.now()) continue;
            await teammates.locked(`t:${t.id}`, async () => {
              const cur = await teammates.get(t.id);
              if (!cur?.switched || backAt(cur.switched) > Date.now()) return;
              // Put on its own model while on its backup: it went off the backup then (the edit cleared the switch).
              const was = cur.tool;
              if (was === "friday") return;
              const lanes = await lanesOfMate(cur);
              if (lanes.some((l) => l.busy)) return;
              const sw = cur.switched;
              const next: Teammate = { ...cur, tool: sw.from, model: sw.fromModel, account: sw.fromAccount, effort: sw.fromEffort, switched: undefined };
              await teammates.put(next);
              for (const l of lanes) {
                // What it did on its backup since it switched, for its own tool, whose conversation never saw it (2026-10-27
                // audit): kept with the line that says it is back, and told it with its next turn (hub.teammate), as the
                // switch told the backup where it was. Waking it for that alone would be a turn spent on nothing.
                const events = await store.events(l.sid).catch(() => []);
                const brief = handoffBrief(events.filter((e) => e.ts >= sw.at), l.lane, Infinity);
                await restartLane(l.sid, by, next, l.lane, l.at);
                // Said in the Team room as before, and in a room only when it worked there meanwhile.
                if (l.sid === team || brief) await store.append(l.sid, FRIDAY_SAYS, { type: "teammate.switched", name: cur.name, lane: l.lane, from: was, to: sw.from, until: null, back: true, ...(brief ? { brief } : {}) });
                // Its backup ran out too, and its last turn there ended on that limit: the turn goes again now its own tool is back,
                // with what it was given, unless a resume is set for it already or something waits in its queue (2026-10-28: both
                // tools out in the night left the work where it stopped).
                const st = await store.state(l.sid).catch(() => null);
                const end = events.findLast((e) => (e.lane ?? MAIN_LANE) === l.lane && (e.body.type === "run.ended" || e.body.type === "run.started"));
                if (st && end?.body.type === "run.ended" && end.body.outcome === "error" && limitHit(end.body.error, end.ts) && !pendingFor(st, l.lane).length) {
                  // A resume set for its backup's reset is overtaken: it goes now.
                  if ((st.resumes[l.lane]?.at ?? 0) > Date.now()) await store.append(l.sid, FRIDAY_SAYS, { type: "resume.cancelled", why: "Back on its own tool." }, { lane: l.lane });
                  const start = events.findLast((e) => e.seq < end.seq && (e.lane ?? MAIN_LANE) === l.lane && e.body.type === "run.started");
                  const given = events.filter((e) => e.seq > (start?.seq ?? end.seq) && e.seq < end.seq && (e.lane ?? MAIN_LANE) === l.lane && e.body.type === "instructions.delivered").flatMap((e) => (e.body.type === "instructions.delivered" ? e.body.seqs : []));
                  const first = start?.body.type === "run.started" ? [start.body.causedBy] : [];
                  const texts = [...new Set([...first, ...given])].flatMap((q) => ((x) => (x?.body.type === "instruction" ? [x.body.text.trim().slice(0, 1500)] : []))(events.find((e) => e.seq === q)));
                  await tellTeammate(l.sid, l.lane, `[Friday] Your usage limit has lifted and you are back on ${ENGINE_NAMES[sw.from]}. The turn that ran out goes again: carry on where it stopped; don't start over.${texts.length ? `\n\nWhat it was given:\n${texts.join("\n\n")}` : ""}`, { hop: 1, ownTurn: true });
                }
              }
            });
          }
    };
    teamTimers.push(
      setInterval(() => {
        if (backing) return;
        backing = true;
        void runBack()
          .catch((e) => closingOr("[teammates]", e))
          .finally(() => (backing = false));
      }, 60_000),
    );
    // Check-ins (teammates.ts CheckIn): each due one asked of its teammate in the Team room, once per slot.
    runCheckIns = async (now = new Date()) => {
        const team = await teammates.team();
        if (!team) return;
        // The team paused: nobody is asked, and the slots wait for it to go on.
        if (await teammates.paused()) return;
        const away = await teammates.away();
        const teamEvents = await store.events(team);
        for (const t of await teammates.list()) {
          // On hold as the person said: not asked, and its slot not used, so it is asked once the hold lifts while still due
          // (2026-10-27 audit: a check-in, said as the person, lifted their stop).
          if (heldByPerson(teamEvents, t.lane)) continue;
          // Away, a check-in with nothing to look at since the last one isn't asked: its slot is spent, and no usage on it
          // (Arun, 2026-10-28: "Check-ins while away: skipped while nothing changed").
          const lastAsk = away ? teamEvents.findLast((e) => (e.lane ?? MAIN_LANE) === t.lane && e.body.type === "instruction" && e.body.text.startsWith("[Check-in] ")) : undefined;
          const quietSince = !!lastAsk && !teamEvents.some((e) => e.seq > lastAsk.seq && (e.lane ?? MAIN_LANE) !== t.lane && (e.body.type === "run.started" || (e.body.type === "instruction" && e.actor.kind === "human") || e.body.type === "agent.diff" || e.body.type === "board.posted"));
          // What is due is read and its slot written under the teammate's lock, from the record as it is then: a check-in is
          // asked once a slot however the clock ticks, and never of a teammate removed meanwhile.
          let due: { c: CheckIn; slot: string }[] = [];
          const next = await teammates.update(t.id, (cur) => {
            due = (cur.checkins ?? []).flatMap((c) => ((slot) => (slot && slot !== c.last ? [{ c, slot }] : []))(checkInDue(c, now)));
            return due.length ? { ...cur, checkins: cur.checkins!.map((c) => ({ ...c, ...((d) => (d ? { last: d.slot } : {}))(due.find((x) => x.c.id === c.id)) })) } : null;
          });
          if (!next || !due.length || quietSince) continue;
          // As Friday, on the person's schedule, and a turn of its own: handed into a turn under way, its answer was never read as
          // the check-in's (teammate-checkins.ts quietCheckIns).
          for (const { c } of due) await tellTeammate(team, next.lane, checkInText(c), { ownTurn: true });
        }
    };
    let checking = false;
    teamTimers.push(
      setInterval(() => {
        // One round at a time: a slow one isn't run again over itself.
        if (checking) return;
        checking = true;
        void runCheckIns(new Date())
          .catch((e) => closingOr("[teammates] check-ins", e))
          .finally(() => (checking = false));
      }, 20_000),
    );
    for (const t of teamTimers) t.unref?.();
    // Their notes: who each is, its role and the team, read fresh for every turn (EngineHub.withAgent).
    // A teammate's memory (teammates.ts MEMORY_FILE), its first page, read fresh each turn: nothing when there is none yet.
    const memoryOf = (t: Teammate) => readFile(path.join(t.folder, MEMORY_FILE), "utf8").then((m) => m.slice(0, MEMORY_MAX), () => "");
    /**
     * Back on its own tool, what it did on its backup meanwhile (runBack), with the first turn there since: its own tool's
     * conversation never saw it. Nothing once a turn has started there.
     */
    const backBrief = async (sid: string, lane: string): Promise<string> => {
      const events = await store.events(sid).catch(() => []);
      const back = events.findLast((e) => e.body.type === "teammate.switched" && e.body.lane === lane);
      if (back?.body.type !== "teammate.switched" || !back.body.back || !back.body.brief) return "";
      if (events.some((e) => e.seq > back.seq && e.body.type === "run.started" && (e.lane ?? MAIN_LANE) === lane)) return "";
      return `\nWhile ${ENGINE_NAMES[back.body.from]} stood in for ${ENGINE_NAMES[back.body.to]}, which had run out of usage, this is what you did on it (you are back on ${ENGINE_NAMES[back.body.to]}, whose conversation didn't see it):\n${back.body.brief}`;
    };
    /**
     * Its memory as the note of each of its conversations (by "sid lane") first had it, kept until that conversation is compacted:
     * the note stays the same turn after turn, so its tool keeps its cache, and what it added since leads the turn's prompt
     * instead (2026-10-28 audit: the note changed every turn, and every turn re-read it all).
     */
    const noteMemory = new Map<string, { memory: string; at: number }>();
    const memoryAsOf = async (sid: string, lane: string, t: Teammate): Promise<{ memory: string; now: string }> => {
      const key = `${sid} ${lane}`;
      const now = await memoryOf(t);
      const had = noteMemory.get(key);
      const compacted = had ? ((await store.events(sid)).findLast((e) => (e.lane ?? MAIN_LANE) === lane && e.body.type === "context.compacted")?.seq ?? 0) : 0;
      if (had && compacted <= had.at) return { memory: had.memory, now };
      noteMemory.set(key, { memory: now, at: (await store.state(sid)).lastSeq });
      return { memory: now, now };
    };
    /** What leads a teammate's turn while the person is away (team-away.ts awayNote), every turn: short, and the rule that matters. */
    const awayPart = async (): Promise<MateNote["preamble"]> => {
      const a = await teammates.away();
      return a ? [{ key: "away", text: awayNote(a.until), always: true }] : [];
    };
    /** The teammate on a lane of the team or one of its rooms, its note there, and what leads its turn: null for any other lane. */
    const noteOn = async (sid: string, lane: string): Promise<({ t: Teammate } & MateNote) | null> => {
      const list = await teammates.list();
      const team = await teammates.team();
      const memoryPart = (m: { memory: string; now: string }, t: Teammate) =>
        m.now.trim() !== m.memory.trim() ? [{ key: "memory", text: `[Friday] Your memory (${path.join(t.folder, MEMORY_FILE)}) has changed since this conversation began. What it holds now:\n${m.now.trim() || "(empty)"}` }] : [{ key: "memory", text: "" }];
      if (team === sid) {
        const t = list.find((x) => x.lane === lane);
        if (!t) return null;
        const m = await memoryAsOf(sid, lane, t);
        // In the Team room, what every room is doing now, so the team can follow and steer them (Arun, 2026-10-27: "allow the
        // team room be able to get info from all of the other rooms that are currently running too"): with the turn, when it
        // changes, not in the note.
        const rooms = await roomsBrief(list);
        return { t, note: teammateNote(t, list, undefined, m.memory, copies.get(t.id)), preamble: [{ key: "rooms", text: rooms ? `[Friday] ${rooms}` : "" }, ...memoryPart(m, t), { key: "back", text: (await backBrief(sid, lane)).trim() }, ...(await awayPart())] };
      }
      // In a room: who else is in it, besides who it is.
      const r = (await teammates.rooms()).find((x) => x.sid === sid);
      const id = r && Object.entries(r.lanes).find(([, l]) => l === lane)?.[0];
      const t = id ? list.find((x) => x.id === id) : undefined;
      if (!r || !t) return null;
      const others = Object.keys(r.lanes).filter((x) => x !== t.id).flatMap((x) => list.find((y) => y.id === x)?.name ?? []);
      const m = await memoryAsOf(sid, lane, t);
      const note = teammateNote(t, list, { name: (await store.state(sid).catch(() => null))?.title || r.name, with: others, ...(r.purpose ? { purpose: r.purpose } : {}), ...(team ? { team } : {}) }, m.memory, copies.get(t.id));
      return { t, note, preamble: [{ key: "elsewhere", text: await elsewhereBrief(t, sid) }, ...memoryPart(m, t), { key: "back", text: (await backBrief(sid, lane)).trim() }, ...(await awayPart())] };
    };
    hub.teammate = async (sid, lane) => {
      const on = await noteOn(sid, lane);
      return on ? { note: on.note, preamble: on.preamble } : null;
    };
    hub.teamPaused = async (sid) => (await teammates.sessions()).includes(sid) && (await teammates.paused());
    /**
     * A teammate's memory kept by Friday Code (teammates.ts teammateNote): its MEMORY.md, in its own folder, which its file tools
     * may not reach when it works in a project. Added to, or written anew; a page at most, as the note reads.
     */
    const memoryTool = (t: Teammate): AgentTool => ({
      name: "update_memory",
      description: `Keep what you will want next time in your memory (${path.join(t.folder, MEMORY_FILE)}), read into your instructions with every turn: how the person likes things, where things are, what didn't work. add: one or a few short lines added at the end. replace: the whole memory written anew, under a page, to tidy it.`,
      parameters: { type: "object", properties: { add: { type: "string", description: "Lines to add." }, replace: { type: "string", description: "The whole memory, written anew." } }, additionalProperties: false },
      cancellable: false,
      async run(args) {
        const file = path.join(t.folder, MEMORY_FILE);
        const add = typeof args.add === "string" ? args.add.trim() : "";
        const replace = typeof args.replace === "string" ? args.replace.trim() : null;
        if (!add && replace === null) return { output: "Say what to add, or the whole memory to replace it with.", isError: true };
        // Read and written under its lock: two adds at once each read the file before the other wrote, and one was lost.
        return memoryLock(t.id, async () => {
          const had = await readFile(file, "utf8").catch(() => "");
          const next = replace !== null ? replace : `${had.trimEnd()}${had.trim() ? "\n" : ""}${add}`;
          if (next.length > MEMORY_MAX) return { output: `That makes your memory ${next.length} characters, over the ${MEMORY_MAX} read back to you. Tidy it with replace, keeping what matters.`, isError: true };
          await makeFolder(t.folder);
          await writeFileAt(file, `${next}\n`);
          return { output: replace !== null ? "Your memory is rewritten." : "Added to your memory." };
        });
      },
    });
    // A teammate on one of the person's own models: its lane run by Friday Code on that model, with its note and its memory
    // (Arun, 2026-10-27: "be able to run your own models and stuff for teammates as well"). The runtime holds the model to the
    // session's owner, whose team it is.
    runtime.laneOwn = async (sid, lane) => {
      const on = await noteOn(sid, lane);
      if (!on || on.t.tool !== "friday" || !on.t.model) return null;
      // Friday Code builds its context afresh each step: the note and what leads a coding tool's turn, together.
      return { model: on.t.model, note: [on.note, ...on.preamble.map((p) => p.text).filter(Boolean)].join("\n\n"), tools: [memoryTool(on.t)] };
    };
  }
  // Team workflows (team-workflows.ts): the Team's automations, each run a board in its room that the board machinery works
  // through (Arun, 2026-10-28: "make the automation for the teams platform different it can be like a workflow automation
  // design like we did with the agent tab page a while ago"). Their schedules go off with the automations' tick.
  if (teammates && o.local) {
    const me = o.local.user;
    workflows = new TeamWorkflows({ redis, prefix: o.prefix, teammates, store, teamSid: () => teamSession(me, LOCAL_WORKSPACE.id), dispatch: (sid) => mesh.dispatch(sid), log: closingOr });
    // The lead, told with the reports that a workflow's board is through: which workflow it was, and how to land it.
    const teamsOwn = mesh.teamDone;
    mesh.teamDone = async (sid, lead) => {
      const own = (await teamsOwn?.(sid, lead).catch(() => null)) ?? "";
      const flow = (await workflows?.landing(sid, /pull request/.test(own)).catch(() => null)) ?? "";
      return [own, flow].filter(Boolean).join("\n\n") || null;
    };
  }
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
      if (team.length) await core.handle(sid, owner, { type: "lead.set", lane: MAIN_LANE, auto: true });
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
  // ── The app, for the agents in it (app-tools.ts) ─────────────────────────────────────────────────────────────────────
  // On this computer every coding tool, in any session, reaches the other sessions on this computer (Code, Work and the
  // team's), searches what was said in them, starts new ones, and makes and runs automations (Arun, 2026-10-27: "make the app
  // fully agentic"). It acts for the person at this computer: what it does is what they could do in the app.
  if (o.local && localEdition()) {
    const peers = new LocalPeers(store, bus, async () => (teammates ? await teammates.team() : null), async () => (teammates ? await teammates.gone() : new Set<string>()));
    mesh.peers = peers;
    /**
     * Sessions one agent's run has started (by "sid:lane:run", with when, for pruning): a run that wants more than a few is a plan
     * for the person to see first. Taken before the first await, so calls made at once can't all get past it.
     */
    const startedBy = new Map<string, { n: number; at: number }>();
    const MAX_STARTS = 4;
    // How many sessions and runs agents start in an hour (AGENT_STARTS_PER_HOUR), the sessions an agent started, which start no
    // more, and how much a tool may do (MODE_RANK) are the team's tool's too, said with the teammates above.
    const ownerOf = (s: SessionState) => ({ id: s.ownerId, name: s.members[s.ownerId]?.name ?? "" });
    const findAutomation = (list: Automation[], name: string) => {
      const low = name.trim().toLowerCase();
      return list.find((a) => a.id === name.trim()) ?? list.find((a) => a.name.toLowerCase() === low) ?? (list.filter((a) => low && a.name.toLowerCase().includes(low)).length === 1 ? list.find((a) => a.name.toLowerCase().includes(low)) : undefined);
    };
    const automationLine = (a: Automation) => `- ${a.name} [id ${a.id}] · ${a.on ? "on" : "paused"} · ${describeWhen(a.when)} · ${describeWho(a.who)}${a.folder ? ` · in ${a.folder}` : ""}\n  Does: ${a.does.slice(0, 200)}${a.does.length > 200 ? "…" : ""}`;
    mesh.appTools = {
      call: async (sid, lane, name, args) => {
        const here = await store.state(sid);
        const me = ownerOf(here);
        const arg = (k: string) => (typeof args[k] === "string" ? (args[k] as string).trim() : "");
        const asker = laneName(here, lane);
        const askerMode: EngineMode = here.engines[lane]?.mode ?? "edits";
        const startedByAgent = await agentStarted(sid);
        if (name === "search_sessions") {
          const q = arg("query").slice(0, 120);
          if (q.length < 3 || !wordsOf(q).length) return { output: "Give at least three letters to look for.", isError: true };
          // As the search box is: each search reads every session's log, so a loop of them is held back.
          const rate = `${o.prefix}tool-search:${me.id}`;
          const tries = await redis.incr(rate);
          if (tries === 1) await redis.expire(rate, 60);
          if (tries > 30) return { output: "That's a lot of searching for one minute. Work from what you found, or read_session one of them.", isError: true };
          const from = arg("from") === "people" ? "people" : arg("from") === "agents" ? "agents" : "any";
          const days = Math.min(366, Math.max(0, Math.floor(Number(args.days) || 0)));
          const since = days ? Date.now() - days * 86_400_000 : 0;
          const team = teammates ? await teammates.team() : null;
          const skip = await peers.skipped(me.id);
          const rows = (await store.mine(me.id, SESSIONS_LOOKED_AT)).filter((r) => r.sid !== sid && !skip.has(r.sid));
          const found = (
            await Promise.all(
              rows.map(async ({ sid: other, at }) => {
                const s = await store.state(other).catch(() => null);
                if (!s) return null;
                const hits = searchEvents(await store.events(other).catch(() => []), q, 3, 4000, { from, kind: "any", since, me: me.id, agentName: (l) => laneName(s, l) });
                const titleMatch = titleMatches(s.title, q);
                if (!hits.length && !titleMatch) return null;
                return { s, hits, titleMatch, at: Math.max(at, ...hits.map((h) => h.at)) };
              }),
            )
          )
            .filter((r): r is NonNullable<typeof r> => !!r)
            .sort((a, b) => rankOf(b) - rankOf(a) || b.at - a.at)
            .slice(0, 12);
          if (!found.length) return { output: `Nothing in the other sessions matches "${q}".` };
          return {
            output: found
              .map(({ s, hits }) => `"${s.title}" [id ${s.id}] · ${placeOfSession(s, team)}${hits.length ? `\n${hits.map((h) => `  - ${h.who} (${agoOf(h.at)}): ${h.snippet}`).join("\n")}` : " (its title)"}`)
              .join("\n"),
          };
        }
        if (name === "start_session") {
          const title = arg("title").slice(0, 120);
          const task = arg("task").slice(0, 8000);
          if (!title || !task) return { output: "Give the new session a title and its task.", isError: true };
          if (startedByAgent) return { output: "This session was started by another agent, and doesn't start sessions of its own. Do the work here, or tell the agent that started it what else is needed.", isError: true };
          // Taken now, before any await: calls made at once each see the one before.
          const now = Date.now();
          for (const [k, v] of startedBy) if (now - v.at > 6 * 3600_000) startedBy.delete(k);
          const key = `${sid}:${lane}:${runOf(here, lane).sinceSeq}`;
          const n = startedBy.get(key)?.n ?? 0;
          if (n >= MAX_STARTS) return { output: `This run has started ${n} sessions already. Say what else you'd start in your reply, and let the person decide.`, isError: true };
          startedBy.set(key, { n: n + 1, at: now });
          const giveBack = () => startedBy.set(key, { n, at: now });
          const tool = (ENGINE_TOOLS as string[]).includes(arg("tool").toLowerCase()) ? (arg("tool").toLowerCase() as EngineTool) : (here.engines[lane]?.tool ?? "claude");
          const folder = arg("folder");
          if (folder && !(await stat(folder).then((x) => x.isDirectory(), () => false))) return (giveBack(), { output: `There's no folder at ${folder} on this computer.`, isError: true });
          if (!(await startsLeft(me.id))) return (giveBack(), { output: `Agents have started ${AGENT_STARTS_PER_HOUR} sessions or runs for the person in the last hour. Say what else you'd start in your reply, and let them decide.`, isError: true });
          // A repo gets a copy of its own (a git worktree), as an automation does: two tools in one checkout lose each other's work.
          const repo = !!folder && (await stat(path.join(folder, ".git")).then(() => true, () => false));
          const work = arg("kind") === "work";
          const newSid = newId();
          await store.create(newSid, title, { id: me.id, name: me.name, role: "owner" }, { controlMode: "ask", mcp: true, ...(work ? { work: true, webSearch: true } : {}) }, here.workspaceId ?? LOCAL_WORKSPACE.id);
          await markAgentStarted(newSid);
          await store.append(newSid, { id: me.id, name: me.name, kind: "human" }, { type: "engine.expected", tool, hostId: me.id, hostName: me.name });
          // Its task is the asking agent's, said as that agent's (not as the person's): from the session and agent it came from.
          const from: PeerNote = { fromSid: sid, fromTitle: here.title, fromLane: lane, fromName: asker, by: me };
          await store.append(newSid, { id: "agent", name: asker, kind: "agent" }, { type: "instruction", text: `${task}\n\n(Started by ${asker} from "${here.title}". When you're done or stuck, tell it with message_session, to "${sid}" and agent "${asker}".)`, interrupt: false, peer: from });
          void bus.wake(newSid, MAIN_LANE);
          try {
            await startTool(newSid, me, { tool, cwd: folder, mode: askerMode, copy: repo, project: title });
          } catch (e) {
            return { output: `Made "${title}" [id ${newSid}], but ${ENGINE_NAMES[tool]} didn't start there: ${(e as Error).message}`, isError: true };
          }
          return { output: `Started "${title}" [id ${newSid}], a ${work ? "Work" : "Code"} session, with ${ENGINE_NAMES[tool]} ${folder ? `in ${repo ? "a copy of " : ""}${folder}` : "in a new project folder"}, allowed what you are (${askerMode}). It's in the person's sidebar. read_session it to see how it goes.` };
        }
        if (name === "manage_automation") {
          const ws = here.workspaceId ?? LOCAL_WORKSPACE.id;
          const list = await automations.list(ws);
          const action = arg("action");
          if (action === "list") return { output: list.length ? `Automations on this computer:\n${list.map(automationLine).join("\n")}` : "There are no automations yet." };
          // An automation runs a coding tool on its own: an agent only makes or runs one that may do no more than it may itself,
          // and not from plan mode, nor from a session another agent started (sessions can't fan out that way either).
          if (action !== "runs") {
            if (askerMode === "plan") return { output: "You're in plan mode: you can list automations and their runs, not make, change or run them. Say what you'd set up, and let the person do it.", isError: true };
            if (startedByAgent && (action === "create" || action === "run" || action === "resume")) return { output: "This session was started by another agent, and doesn't start automations. Tell the agent that started it what you'd set up.", isError: true };
          }
          if (action === "create") {
            const schedule = scheduleOf(args.schedule);
            const tool = (ENGINE_TOOLS as string[]).includes(arg("tool").toLowerCase()) ? arg("tool").toLowerCase() : (here.engines[lane]?.tool ?? "claude");
            if (!arg("name") || !arg("does")) return { output: "Give the automation a name and what it does.", isError: true };
            const made: Automation = {
              id: newId(),
              ownerId: me.id,
              ownerName: me.name,
              created: Date.now(),
              ...cleanAutomation({ name: arg("name"), does: arg("does"), folder: arg("folder"), when: schedule ? { kind: "schedule", schedule } : { kind: "manual" }, who: { tool, mode: askerMode }, then: { pr: args.pr === true } }),
            };
            await automations.put(ws, made);
            return { output: `Made the automation "${made.name}" [id ${made.id}]: ${describeWhen(made.when)}, ${describeWho(made.who)}. It shows on the Automations page; run it now with action run.` };
          }
          const a = findAutomation(list, arg("name"));
          if (!a) return { output: `There's no automation called "${arg("name")}".${list.length ? ` There are: ${list.map((x) => `"${x.name}"`).join(", ")}.` : ""}`, isError: true };
          if (a.ownerId !== me.id) return { output: `"${a.name}" is ${a.ownerName}'s: only they can change or run it.`, isError: true };
          if (action !== "runs" && action !== "pause" && MODE_RANK[a.who.mode] > MODE_RANK[askerMode]) return { output: `"${a.name}" runs with more access than you have (${a.who.mode}, you ${askerMode}): only the person changes, resumes or runs it. You can pause it, or see its runs.`, isError: true };
          if (action === "runs") {
            const runs = await automations.runs(ws, a.id, 8);
            return { output: runs.length ? runs.map((r) => `- ${new Date(r.at).toLocaleString()} · ${r.trigger} · ${r.status}${r.note ? ` (${r.note})` : ""}${r.sid ? ` · session id ${r.sid}` : ""}`).join("\n") : `"${a.name}" hasn't run yet.` };
          }
          if (action === "pause" || action === "resume") {
            await automations.put(ws, { ...a, on: action === "resume" }, a);
            return { output: `"${a.name}" is ${action === "resume" ? "on again" : "paused"}.` };
          }
          if (action === "update") {
            const schedule = scheduleOf(args.schedule);
            const input: Record<string, unknown> = {};
            if (arg("does")) input.does = arg("does");
            if (typeof args.folder === "string") input.folder = arg("folder");
            if (schedule) input.when = { kind: "schedule", schedule };
            if (arg("tool")) input.who = { ...a.who, tool: arg("tool").toLowerCase() };
            if (typeof args.pr === "boolean") input.then = { ...a.then, pr: args.pr };
            const next: Automation = { ...a, ...cleanAutomation(input, a) };
            await automations.put(ws, next, a);
            return { output: `Changed "${a.name}": ${describeWhen(next.when)}, ${describeWho(next.who)}.` };
          }
          if (action === "run") {
            if (!(await startsLeft(me.id))) return { output: `Agents have started ${AGENT_STARTS_PER_HOUR} sessions or runs for the person in the last hour. Say what you'd run in your reply, and let them decide.`, isError: true };
            const run = await runAutomation(ws, a, `Run now, by ${asker}`, "");
            return { output: `"${a.name}" ${run.status === "running" ? `is running${run.sid ? ` in session id ${run.sid}` : ""}` : run.status}${run.note ? `: ${run.note}` : ""}.`, isError: run.status === "failed" };
          }
          return { output: "Say which: list, runs, create, update, pause, resume or run.", isError: true };
        }
        return { output: `Unknown tool ${name}.`, isError: true };
      },
    };
  }
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
    // The team's workflows on the same clock (team-workflows.ts).
    await workflows?.tick(now).catch((e) => closingOr("[workflows]", e));
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
      ...(teammates ? { teammates: true } : {}), // the app opens on them (client/Teammates.tsx)
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

    // A team workflow's webhook (team-workflows.ts): whatever is posted is what started the run. The key is the only credential.
    const flowHook = url.pathname.match(/^\/api\/hooks\/workflow\/([\w-]{4,40})$/);
    if (workflows && flowHook && req.method === "POST") {
      const w = await workflows.get(flowHook[1]!);
      const given = Buffer.from(url.searchParams.get("key") ?? "");
      const want = Buffer.from(w?.trigger.kind === "webhook" ? w.trigger.secret : "");
      if (!w || !want.length || given.length !== want.length || !timingSafeEqual(given, want)) return json(res, 404, { error: "Not found" });
      if (!w.on) return json(res, 409, { error: "This workflow is off." });
      let payload = "";
      try {
        payload = (await readBody(req, 200_000)).toString("utf8").slice(0, 8000).trim();
      } catch {
        return json(res, 413, { error: "That payload is too large." });
      }
      const run = await workflows.start(w, "webhook", payload || "(The webhook was called with nothing in it.)");
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
        // Only this computer's Friday (the open-source edition) makes a Work session: the hosted one and anyone else's ignore it (its tools
        // run in auto mode with the person's browser), whatever the request says (Arun, 2026-10-28: "iron everything and ensure we are good… any logic errors").
        ...(o.local && localEdition() && body.work === true ? { work: true, webSearch: true } : {}),
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
      // A Work session with two tools: the first leads, and hands the second its part (agent-mesh.ts assign_task), as an automation's team does.
      if (o.local && localEdition() && body.work === true && body.team === true) await core.handle(sid, owner, { type: "lead.set", lane: MAIN_LANE, auto: true });
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
      // Its coding tools come with it, in the same folders, as far as they may go there (forkTools): a fork that came up on
      // Friday Code with no model in the open-source edition queued every message for good (2026-10-27 QA).
      const source = await store.state(sid);
      const plan = forkTools(source, !!o.local);
      if (typeof plan === "string") return json(res, 409, { error: plan });
      if (plan.length && !computerHere(me.id)) return json(res, 409, { error: `This session's ${ENGINE_NAMES[plan[0]!.tool]} runs on your computer, which isn't connected, so the fork couldn't carry it on. Open Friday there, then fork again.` });
      const owner: Member = { id: me.id, name: me.name, role: "owner" };
      const fork = randomBytes(6).toString("base64url");
      const forkTitle = `Fork of ${title}`.slice(0, 120);
      let mine = false;
      mine = !!o.local && localEdition();
      const kind = forkKind(source, mine);
      await store.create(fork, forkTitle, owner, kind.options, ctx.workspace.id);
      const human = { id: owner.id, name: owner.name, kind: "human" as const };
      // Its agents work as they did: the one that led hands the others their parts again.
      if (kind.lead && plan.length > 1) await core.handle(fork, owner, { type: "lead.set", lane: MAIN_LANE, auto: true });
      await store.append(fork, human, { type: "session.imported", tool: plan[0]?.tool ?? "claude", sourceId: sid, title, turns: turns.slice(-40), total: turns.length, fork: true });
      const left: string[] = [];
      for (const t of plan) {
        if (!t.lane) await store.append(fork, human, { type: "engine.expected", tool: t.tool, hostId: me.id, hostName: me.name });
        // A repo gets a copy of its own, as a new session's does: two tools in one checkout lose each other's work.
        const copy = kind.copy && !!t.cwd && (await stat(path.join(t.cwd, ".git")).then(() => true, () => !localHost()));
        try {
          await startTool(fork, me, { tool: t.tool, cwd: t.cwd, mode: t.mode, copy, project: forkTitle, ...(t.lane ? { newLane: t.lane } : {}) });
        } catch (e) {
          // Its main tool not starting leaves a fork nobody can work in: none is made, and why is said.
          if (!t.lane) {
            await store.bury(fork).catch(() => {});
            await store.forget(me.id, fork).catch(() => {});
            return json(res, 409, { error: `The fork couldn't start ${ENGINE_NAMES[t.tool]}${t.cwd ? ` in ${t.cwd}` : ""}: ${(e as Error).message}` });
          }
          left.push(`${t.lane} (${ENGINE_NAMES[t.tool]})`);
        }
      }
      return json(res, 201, { sessionId: fork, title: forkTitle, invites: { owner: signInvite(o.secret, fork, "owner") }, ...(left.length ? { note: `Not carried over: ${left.join(", ")}. Add them from the fork.` } : {}) });
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

    /**
     * A session's title, renamed from outside it (the sidebar): the same change, and the same say over it, as the header's rename
     * over the session's socket (settings.update, the owner's), so the log has it and every view of the session takes it
     * (2026-10-27 QA: the sidebar's rename was a name in that one list, and the header, the tab, ⌘K, Search and the server kept
     * the old one). With the session's invite, as the other session routes.
     */
    const titleRoute = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/title$/);
    if (req.method === "POST" && titleRoute) {
      const sid = titleRoute[1]!;
      const me = await memberOnly(req, res, sid);
      if (!me) return;
      const title = str((await readJson(req)).title, 200).trim();
      if (!title) return json(res, 400, { error: "Give the session a name." });
      const r = await core.handle(sid, me, { type: "settings.update", title });
      if (!r.ok) return json(res, 403, { error: r.error ?? "Couldn't rename it." });
      return json(res, 200, { title: (await store.state(sid)).title });
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
            const row: Record<string, unknown> = { sid, title: state.title, role: m.role, invite: linkToken(sid, state, m.role), at };
            if (state.options.work) row.work = true; // the sidebar's Work list (client/WorkMode.tsx)
            return row as { sid: string; title: string; role: typeof m.role; invite: string; at: number };
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
            const hits = searchEvents(await store.events(sid).catch(() => []), q, 3, 4000, { from, kind, since, me: me.id, agentName, agentTool: (lane) => state.engines[lane]?.tool });
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
      const sids = listedSids(body.sids);
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
      // Read side by side: one after another was the sum of them, and with a line for each session that adds up. A few dozen at a
      // time, with hundreds of them listed.
      const read = await mapLimit(
        sids,
        READ_AT_ONCE,
        async (sid) => {
          const state = await store.state(str(sid, 200)).catch(() => null);
          if (!state) return null;
          const m = state.members[me.id];
          if (!m || m.removed) return null;
          const line = body.summaries === true ? summaryOf((await cardsFor(state, me.id).catch(() => null))?.cards ?? []) : null;
          return { state, line };
        },
      );
      for (const r of read) {
        if (!r) continue;
        const { state, line } = r;
        mine.push(state);
        // The browser knows this session and the log says they are in it: the server-side list learns it too.
        void store.remember(me.id, state.id).catch(() => {});
        found.push(...attentionIn(state, me.id));
        let busy = workingIn(state);
        // A team whose only work is check-ins isn't working, so nothing says it finished: one with news says so as news (app.ts teamLook).
        if (busy && state.options.team && teammates && (await teamOnlyCheckingIn(state))) busy = null;
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
      const sids = listedSids(body.sids);
      // Sessions are read side by side: the first look at a long list is the slow one, and it is the sum of them otherwise.
      const workspaceOf = new Map<string, string>();
      const weeks: ReturnType<typeof weekOf>[] = [];
      const perSession = await mapLimit(
        sids,
        READ_AT_ONCE,
        async (sid): Promise<BoardCard[]> => {
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
        },
      );
      // The week in three numbers: sessions that began, sessions that shipped something, runs. Over every session listed, up to
      // LISTED_SESSIONS of the newest, so it counts what this week had, not the first sixty the list happened to send.
      const week = { sessions: weeks.filter((w) => w.created).length, shipped: weeks.filter((w) => w.shipped).length, runs: weeks.reduce((n, w) => n + w.runs, 0) };
      const more = listedCount(body.sids) - sids.length;
      // What GitHub says about each pull request, at the same time; a card whose pull request nobody could ask about stays as the log left it.
      const cards = await Promise.all(
        perSession.flat().map(async (c) => {
          const gh = c.pr ? await prStatusSoon(c.sid, c.lane, workspaceOf.get(c.sid) ?? "", c.pr.url) : null;
          return gh ? applyPrStatus(c, gh) : c;
        }),
      );
      // `more`: older sessions past what one look reads, said rather than left out silently.
      return json(res, 200, { cards: sortCards(cards), week, ...(more > 0 ? { more } : {}) });
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
    // Team workflows (team-workflows.ts): the team's automations, drawn as a workflow, the local person's alone (Arun, 2026-10-28:
    // "make the automation for the teams platform different…"). Run now runs one even while it is off, as an automation does.
    if (workflows && (url.pathname === "/api/workflows" || url.pathname.startsWith("/api/workflows/"))) {
      const ctx = await context(req);
      if (!ctx) return json(res, 401, { error: "Sign in first." });
      const flows = workflows;
      const base = (o.appUrl || selfUrl).replace(/\/+$/, "");
      const view = (w: Workflow) => flows.view(w, base);
      try {
        if (req.method === "GET" && url.pathname === "/api/workflows") return json(res, 200, { workflows: await Promise.all((await flows.list()).map(view)) });
        if (req.method === "POST" && url.pathname === "/api/workflows") return json(res, 201, { workflow: await view(await flows.save((await readJson(req)) as Record<string, unknown>, null)) });
        const one = url.pathname.match(/^\/api\/workflows\/([\w-]{4,40})(\/run|\/runs)?$/);
        if (!one) return json(res, 404, { error: "Not found" });
        const w = await flows.get(one[1]!);
        if (!w) return json(res, 404, { error: "That workflow isn't there any more." });
        if (req.method === "GET" && one[2] === "/runs") return json(res, 200, { runs: await flows.runs(w.id, 30) });
        if (req.method === "POST" && one[2] === "/run") {
          const b = (await readJson(req).catch(() => ({}))) as { input?: unknown };
          const run = await flows.start(w, "Run now", typeof b.input === "string" ? b.input.slice(0, 8000) : "");
          return json(res, 202, { run, ...(run.sid ? { invite: signInvite(o.secret, run.sid, "owner") } : {}) });
        }
        if (req.method === "PATCH" && !one[2]) return json(res, 200, { workflow: await view(await flows.save((await readJson(req)) as Record<string, unknown>, w)) });
        if (req.method === "DELETE" && !one[2]) {
          await flows.remove(w.id);
          return json(res, 200, { ok: true });
        }
        return json(res, 404, { error: "Not found" });
      } catch (e) {
        return json(res, 400, { error: (e as Error).message });
      }
    }
    // Teammates (teammates.ts): the person's own AI teammates on this computer. Theirs alone: the local person only.
    if (teammates && (url.pathname === "/api/teammates" || url.pathname.startsWith("/api/teammates/"))) {
      const ctx = await context(req);
      if (!ctx) return json(res, 401, { error: "Sign in first." });
      const owner = { id: ctx.me.id, name: ctx.me.name };
      try {
        const sid = await teamSession(owner, ctx.workspace.id);
        // The team's sessions, for the page to leave out of its lists: a room taken away only while it could still be listed (the
        // sessions looked at lately), not every one for ever (2026-10-28 audit).
        const hidden = async () => {
          const [all, gone, recent] = await Promise.all([teammates.sessions(), teammates.gone(), store.mine(owner.id, SESSIONS_LOOKED_AT * 4).catch(() => [])]);
          const listed = new Set(recent.map((x) => x.sid));
          return all.filter((x) => !gone.has(x) || listed.has(x));
        };
        const team = async (more: Record<string, unknown> = {}) => {
          const away = await teammates.away();
          return json(res, 200, { sid, invite: signInvite(o.secret, sid, "owner"), lead: (await store.state(sid)).lead ?? null, ...(await teamRoomNow(sid)), teammates: await teammateViews(sid), rooms: await roomViews(), hidden: await hidden(), away: away ? { until: away.until, since: away.since } : null, paused: await teammates.paused(), ran: (await workflows?.ended()) ?? [], ...more });
        };
        if (req.method === "GET" && url.pathname === "/api/teammates") return team();
        // A folder it is given has to be on this computer: a typo would start it in nothing.
        if (req.method === "POST" && url.pathname === "/api/teammates") {
          const made = await addTeammate(sid, owner, await readJson(req));
          return typeof made === "string" ? json(res, 400, { error: made }) : team();
        }
        // Away mode (team-away.ts): until when, set or cleared; clearing it, or writing in any team chat, ends it with the brief.
        if (url.pathname === "/api/teammates/away") {
          if (req.method === "GET") {
            const a = await teammates.away();
            return json(res, 200, { until: a?.until ?? null, since: a?.since ?? null } satisfies TeamAway);
          }
          if (req.method !== "POST") return json(res, 405, { error: "Not allowed" });
          const b = (await readJson(req)) as { until?: unknown };
          if (b.until === null) await awayOff();
          else {
            const until = Math.floor(Number(b.until));
            if (!Number.isFinite(until) || until <= Date.now() || until > Date.now() + 7 * 86_400_000) return json(res, 400, { error: "Pick a time in the next week." });
            await awayOn(until);
          }
          const a = await teammates.away();
          return json(res, 200, { until: a?.until ?? null, since: a?.since ?? null } satisfies TeamAway);
        }
        // What the team did since a time, for the "Since you left" card: the brief's shape (types.ts TeamBrief).
        if (req.method === "GET" && url.pathname === "/api/teammates/since") {
          const ts = Number(url.searchParams.get("ts"));
          const from = Number.isFinite(ts) && ts > 0 ? Math.max(ts, Date.now() - 30 * 86_400_000) : Date.now() - 86_400_000;
          return json(res, 200, { type: "team.brief", ...(await sinceOf(from)) });
        }
        // Every teammate's running turn stopped everywhere, their queues kept.
        if (req.method === "POST" && url.pathname === "/api/teammates/stop-all") return json(res, 200, { stopped: await stopAll(owner) });
        // The whole team held, or let go on: queues, check-ins and wakes.
        if (req.method === "POST" && url.pathname === "/api/teammates/pause") {
          const b = (await readJson(req)) as { paused?: unknown };
          await setPaused(b.paused === true);
          return team();
        }
        // Holds lifted: every one, or a teammate's (its lanes everywhere), as the person's one click.
        if (req.method === "POST" && url.pathname === "/api/teammates/lift") {
          const b = (await readJson(req).catch(() => ({}))) as { id?: unknown };
          const t = typeof b.id === "string" ? await teammates.get(b.id) : null;
          if (typeof b.id === "string" && !t) return json(res, 404, { error: "That teammate isn't in your crew any more." });
          const by = { id: owner.id, name: owner.name, kind: "human" as const };
          for (const r of [{ sid, lanes: Object.fromEntries((await teammates.list()).map((x) => [x.id, x.lane])) as Record<string, string> }, ...(await teammates.rooms())]) {
            const lanes = t ? (r.lanes[t.id] ? [r.lanes[t.id]!] : []) : null;
            if (lanes && !lanes.length) continue;
            await store.append(r.sid, by, { type: "holds.lifted", ...(lanes ? { lanes } : {}), why: "The person let them go on." }, { lane: MAIN_LANE });
          }
          await runAway();
          return team();
        }
        // Rooms: some of the team, picked, in a session of their own (teammates.ts Room).
        const roomPath = url.pathname.match(/^\/api\/teammates\/rooms(?:\/([\w-]{4,40}))?$/);
        if (roomPath) {
          const list = await teammates.list();
          const byId = (id: string) => list.find((t) => t.id === id)!;
          if (req.method === "POST" && !roomPath[1]) {
            const r = await makeRoom(owner, ctx.workspace.id, await readJson(req));
            // Made though someone didn't join: the room, to open and fix, with who didn't and why.
            return typeof r === "string" ? json(res, 400, { error: r }) : team({ room: r.room.id, ...(r.failed ? { notJoined: r.failed } : {}) });
          }
          if (!roomPath[1] || (req.method !== "PATCH" && req.method !== "DELETE")) return json(res, 405, { error: "Not allowed" });
          const body = req.method === "PATCH" ? await readJson(req) : {};
          // One change to a room at a time, from what is stored now: two at once each added the same teammate.
          const said = await teammates.locked(`room:${roomPath[1]}`, async (): Promise<string | null> => {
            const r = await teammates.room(roomPath[1]!);
            if (!r) return "That room isn't there any more.";
            if (req.method === "DELETE") {
              for (const id of Object.keys(r.lanes)) await leaveRoom(r, owner, id);
              await teammates.removeRoom(r);
              return null;
            }
            const c = cleanRoom(body, list.map((t) => t.id));
            // Its name as shown: renamed from its own page, its title is (2026-10-28 audit: a rename back to the old name was lost).
            if (c.name && c.name !== ((await store.state(r.sid).catch(() => null))?.title || r.name)) {
              await core.handle(r.sid, owner, { type: "settings.update", title: c.name });
              r.name = c.name;
            }
            if (c.purpose !== undefined) r.purpose = c.purpose || undefined;
            try {
              if (c.members) {
                for (const id of Object.keys(r.lanes)) if (!c.members.includes(id)) await leaveRoom(r, owner, id);
                // Read again here, under the room's lock: one taken off the team since the page asked isn't brought in (2026-10-28
                // audit: a room's edit racing a teammate's removal gave the room a lane for nobody).
                for (const id of c.members) {
                  const mate = r.lanes[id] ? null : await teammates.get(id);
                  if (mate) await joinRoom(r, owner, mate);
                }
              }
            } catch (e) {
              return (e as Error).message;
            } finally {
              await teammates.putRoom(r);
            }
            await leadRoom(r, owner);
            return null;
          });
          return said ? json(res, said.startsWith("That room") ? 404 : 400, { error: said }) : team();
        }
        const one = url.pathname.match(/^\/api\/teammates\/([\w-]{4,40})(\/reconnect|\/stop|\/lead|\/memory|\/activity)?$/);
        if (!one) return json(res, 404, { error: "Not found" });
        const t = await teammates.get(one[1]!);
        if (!t) return json(res, 404, { error: "That teammate isn't in your crew any more." });
        // Its runs everywhere it works, newest first, for its Activity and Results.
        if (req.method === "GET" && one[2] === "/activity") {
          const days = Math.min(90, Math.max(1, Math.floor(Number(url.searchParams.get("days")) || 7)));
          return json(res, 200, { runs: await activityOf(t, days) });
        }
        if (one[2] === "/memory") {
          // Its memory, read or written by the person, in its own folder: with when it last changed, so a save over a change made
          // since it was read (by the teammate itself, or another window) is refused rather than lost (2026-10-28 audit).
          const file = path.join(t.folder, MEMORY_FILE);
          const seen = async () => {
            const st = await stat(file).catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : Promise.reject(e)));
            return st ? st.mtimeMs : 0;
          };
          if (req.method === "GET") {
            // Not there yet is an empty memory; anything else (no permission, a folder gone bad) is an error the page shows.
            const text = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? "" : Promise.reject(e)));
            return json(res, 200, { text, file, mtime: await seen(), exists: (await seen()) > 0 });
          }
          if (req.method === "PUT") {
            const b = (await readJson(req)) as { text?: unknown; mtime?: unknown };
            const text = typeof b.text === "string" ? b.text.slice(0, 50_000) : "";
            return memoryLock(t.id, async () => {
              const now = await seen();
              if (typeof b.mtime === "number" && Math.abs(now - b.mtime) > 1) return json(res, 409, { error: "Its memory changed since you opened it. Reload it to see what changed, then save again.", text: await readFile(file, "utf8").catch(() => ""), mtime: now });
              await makeFolder(t.folder);
              await writeFileAt(file, text);
              return json(res, 200, { text, file, mtime: await seen() });
            });
          }
          return json(res, 405, { error: "Not allowed" });
        }
        if (req.method === "POST" && one[2] === "/stop") {
          // Its work stopped everywhere it is (the Team room and its rooms), as the chat's Stop does: its queue kept, so what others
          // sent it is still there for its next turn (2026-10-28 audit: the sidebar's Stop cancelled, and the queue went with it).
          const places = [{ sid, lane: t.lane }, ...(await teammates.rooms()).flatMap((room) => (room.lanes[t.id] ? [{ sid: room.sid, lane: room.lanes[t.id]! }] : []))];
          for (const p of places) if (runOf(await store.state(p.sid), p.lane).status === "running") await core.handle(p.sid, owner, { type: "run.pause", lane: p.lane });
          return team();
        }
        if (req.method === "POST" && one[2] === "/lead") {
          // Leads the Team room: what is said there without an @name goes to it.
          const r1 = await core.handle(sid, owner, { type: "lead.set", lane: t.lane });
          return r1.ok ? team() : json(res, 400, { error: r1.error ?? "Couldn't make it the lead." });
        }
        if (req.method === "POST" && one[2] === "/reconnect") {
          // One lane (the page bringing back one it found offline: only if it still is), or, asked for, all of them.
          const b = (await readJson(req).catch(() => ({}))) as { sid?: string; lane?: string; quiet?: boolean };
          if (b.sid && b.lane) {
            const r = (await teammates.rooms()).find((x) => x.sid === b.sid);
            const at = r && r.lanes[t.id] === b.lane ? { lane: b.lane, keepAs: roomKeep(t.id, r.id) } : b.sid === sid && b.lane === t.lane ? undefined : null;
            if (at === null) return json(res, 400, { error: "That isn't one of its lanes." });
            await startTeammate(b.sid, owner, t, b.quiet ? { ifOffline: true } : {}, at);
            return team();
          }
          const later = await restartEverywhere(sid, owner, t, t);
          return team(later.length ? { restartLater: later } : {});
        }
        if (req.method === "PATCH" && !one[2]) {
          const body = await readJson(req);
          // Under the teammate's lock, from what is stored now: a usage-limit switch or a check-in in between isn't undone.
          /** Where it was busy, and starts again on the change as that run ends (restartEverywhere): said in the answer. */
          const later: string[] = [];
          const said = await teammates.locked(`t:${t.id}`, async (): Promise<string | null> => {
            const t2 = await teammates.get(t.id);
            if (!t2) return "That teammate isn't in your crew any more.";
            const c = cleanTeammate({ ...t2, ...body }, ENGINE_TOOLS, owner.id);
            // Put on one of the person's own models, or another of them: one set up here now (a model it already ran on is kept as it
            // was, so an edit of its role isn't refused for a model taken out of Settings meanwhile).
            const refused = c.tool === "friday" && (t2.tool !== "friday" || c.model !== t2.model) ? await ownModelRefused(owner, c.model ?? "") : null;
            if (refused) return refused;
            if (c.name.toLowerCase() !== t2.name.toLowerCase() && (await teammates.list()).some((x) => x.id !== t2.id && x.name.toLowerCase() === c.name.toLowerCase())) return `You already have a teammate called ${c.name}.`;
            // On its backup since its tool ran out: back on its own tool, it is given back the model, account and effort it had there
            // unless this edit says others (the dialog never sends the account). Its backup is checked against its own tool, not the
            // backup it is on now, which the dialog sends back as it was.
            const back = t2.switched && c.tool !== t2.tool && c.tool === t2.switched.from ? t2.switched : null;
            const own = t2.switched && c.tool === t2.tool ? t2.switched.from : c.tool;
            const backup = typeof body.backup === "string" && (ENGINE_TOOLS as string[]).includes(body.backup) && body.backup !== own ? (body.backup as EngineTool) : undefined;
            // An account is its tool's: a new tool drops the old one's, unless the edit names one (2026-10-28 audit: Codex started
            // as Claude's account). Back on its own tool, the account it had there.
            const model = c.model ?? back?.fromModel, account = back ? (c.account ?? back.fromAccount) : c.tool !== t2.tool && !("account" in body) ? undefined : c.account, effort = c.effort ?? (back && !("effort" in body) ? back.fromEffort : undefined);
            const next: Teammate = { ...t2, name: c.name, role: c.role, tool: c.tool, model, account, ...(c.mode ? { mode: c.mode === "full" ? undefined : c.mode } : {}), ...(c.look ? { look: c.look } : {}), ...(c.projects ? { projects: c.projects, project: undefined } : {}), ...("effort" in body || c.tool !== t2.tool ? { effort } : {}), ...("backup" in body ? { backup } : {}), ...(c.checkins ? { checkins: c.checkins.map((x) => ({ ...x, ...(t2.checkins?.find((y) => y.id === x.id)?.last ? { last: t2.checkins.find((y) => y.id === x.id)!.last } : {}) })) } : {}), ...(c.tool !== t2.tool ? { switched: undefined } : {}), ...(body.keep === true ? { madeBy: undefined } : {}) };
            const missing = await missingDirOf(c.projects?.filter((d) => !projectsOf(t2).includes(d)));
            if (missing) return `There's no folder at ${missing} on this computer.`;
            if (next.name !== t2.name) {
              const r = await core.handle(sid, owner, { type: "lane.rename", laneId: t2.lane, name: next.name });
              if (!r.ok) return r.error ?? "Couldn't rename your teammate.";
              // Its lane in every room it is in follows.
              for (const room of await teammates.rooms()) if (room.lanes[t2.id]) await core.handle(room.sid, owner, { type: "lane.rename", laneId: room.lanes[t2.id]!, name: next.name });
            }
            await teammates.put(next);
            // Its tool, model, account or project changed: started again so it takes them (a new tool is a new conversation).
            if (next.tool !== t2.tool || next.model !== t2.model || next.account !== t2.account || next.mode !== t2.mode || projectsOf(next).join("\n") !== projectsOf(t2).join("\n")) later.push(...(await restartEverywhere(sid, owner, t2, next)));
            // Its effort, on its lane everywhere it is, when that or its tool changed.
            if (next.effort !== t2.effort || next.tool !== t2.tool) {
              await setEffort(sid, owner, next.lane, next);
              for (const r of await teammates.rooms()) if (r.lanes[next.id]) await setEffort(r.sid, owner, r.lanes[next.id]!, next);
            }
            // What it was given or lost, said where it works: the Team room and each room it is in.
            const had = projectsOf(t2), has = projectsOf(next);
            const added = has.filter((d) => !had.includes(d)), removed = had.filter((d) => !has.includes(d));
            if (added.length || removed.length) {
              const by = { id: owner.id, name: owner.name, kind: "human" as const };
              await store.append(sid, by, { type: "teammate.folders", name: next.name, lane: next.lane, added, removed });
              for (const r of await teammates.rooms()) if (r.lanes[next.id]) await store.append(r.sid, by, { type: "teammate.folders", name: next.name, lane: r.lanes[next.id]!, added, removed });
            }
            return null;
          });
          if (said) return json(res, 400, { error: said });
          return team(later.length ? { restartLater: later } : {});
        }
        if (req.method === "DELETE" && !one[2]) {
          // Under its lock, as an edit, a usage-limit switch or a check-in is: one of those finishing after couldn't write it back.
          const led = await teammates.locked(`t:${t.id}`, async () => {
            if (!(await teammates.get(t.id))) return null;
            const led = (await store.state(sid)).lead === t.lane;
            // The lead goes to whoever is left first, so the Team room still reaches someone: before it goes, so the tasks it
            // handed out report to that one (askerOf).
            const next = (await teammates.list()).find((x) => x.id !== t.id);
            if (led && next) await core.handle(sid, owner, { type: "lead.set", lane: next.lane, auto: true });
            await laneGoes(sid, owner, t.lane, `${t.name} was removed from the crew before it finished this. Ask someone else, or do it yourself.`);
            await teammates.remove(t.id);
            return led;
          });
          if (led === null) return team();
          // Out of every room it was in, each under that room's lock and as it is stored then; a room it was the last one in is
          // kept, empty, for the person to fill or take away.
          for (const r of await teammates.rooms()) {
            if (!r.lanes[t.id]) continue;
            await teammates.locked(`room:${r.id}`, async () => {
              const room = await teammates.room(r.id);
              if (!room?.lanes[t.id]) return;
              await leaveRoom(room, owner, t.id);
              await teammates.putRoom(room);
              await leadRoom(room, owner);
            });
          }
          // Its folder is kept: what it made is the person's.
          return team({ kept: t.folder });
        }
        return json(res, 405, { error: "Not allowed" });
      } catch (e) {
        return json(res, 400, { error: (e as Error).message });
      }
    }
    // A page an agent made, shown working in the reader, reads its own pictures by a pass of its own (work-frame.ts), never the
    // session's invite: asked for by a member, for the one folder the page needs; used by the page's frame, for media only.
    const frameRoute = o.local && url.pathname.match(/^\/api\/sessions\/([\w-]+)\/work\/(frame-token|framed)$/);
    if (req.method === "GET" && frameRoute) {
      const sid = frameRoute[1]!;
      const roots = async () => [...new Set(Object.values((await store.state(sid)).engines).map((e) => e.cwd).filter((c): c is string => !!c))];
      if (frameRoute[2] === "frame-token") {
        if (!(await memberOnly(req, res, sid))) return;
        const root = Number(url.searchParams.get("root") ?? 0);
        const dir = frameDir(pathParam(url.searchParams.get("dir"), 600));
        if (!Number.isInteger(root) || !(await roots())[root]) return json(res, 404, { error: "That folder isn't one of this session's." });
        if (dir === null) return json(res, 400, { error: "That isn't a folder in the session's folder." });
        return json(res, 200, { token: signFrame(o.secret, { sid, root, dir }), ttl: FRAME_TTL_MS });
      }
      const pass = verifyFrame(o.secret, url.searchParams.get("t"), sid);
      if (!pass) return json(res, 403, { error: "That pass has run out or isn't for this session." });
      const rel = pathParam(url.searchParams.get("path"), 600);
      if (!inFrame(pass.dir, rel)) return json(res, 403, { error: "That file isn't one the pass reads." });
      const root = (await roots())[pass.root];
      const file = root ? await workPath(root, rel) : null;
      if (!file) return json(res, 404, { error: "That file isn't in this session's folders." });
      return serveWork(req, res, file);
    }
    // A Work session's pieces (work-files.ts): listed, and each served as itself, from the folders its agents work in.
    const workRoute = o.local && url.pathname.match(/^\/api\/sessions\/([\w-]+)\/work(\/file|\/icon)?$/);
    if (req.method === "GET" && workRoute) {
      const sid = workRoute[1]!;
      if (!(await memberOnly(req, res, sid))) return;
      // The icon of a site the agents read, from the site itself (work-files.ts siteIcon).
      if (workRoute[2] === "/icon") {
        const icon = await siteIcon(str(url.searchParams.get("host") ?? "", 200));
        if (!icon) return json(res, 404, { error: "No icon." });
        res.writeHead(200, { "Content-Type": icon.type, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'" });
        return void res.end(icon.body);
      }
      const roots = [...new Set(Object.values((await store.state(sid)).engines).map((e) => e.cwd).filter((c): c is string => !!c))];
      if (!workRoute[2]) return json(res, 200, { roots, files: await listWork(roots) });
      // A picture an agent shows in the chat, by where it is on this computer (client/LiveBlock.tsx): pictures and video only, in
      // the session's folders or Friday's screenshots, or named in the session's log (Arun, 2026-10-28: "iron everything and
      // ensure we are good… any logic errors"). Paths as sent, never trimmed: a name may start or end with a space.
      const abs = pathParam(url.searchParams.get("abs"), 1000);
      const root = roots[Number(url.searchParams.get("root") ?? 0)];
      const rel = pathParam(url.searchParams.get("path"), 600);
      const named = async (p: string) => namedIn((await store.events(sid)).map((e) => JSON.stringify(e.body)), p);
      let file = abs ? await shownFile(abs, roots, named) : url.searchParams.has("root") ? (root ? await workPath(root, rel) : null) : null;
      // A path an agent named from its own folder, without saying which of the session's folders: the first that has it.
      for (const r of url.searchParams.has("root") || abs ? [] : roots) if (!file) file = await workPath(r, rel);
      if (!file) return json(res, 404, { error: "That file isn't in this session's folders." });
      return serveWork(req, res, file);
    }
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
        // In the person's own days, by the zone their page is in (tool-usage.ts daily).
        return json(res, 200, { days: await toolUsage.daily(LOCAL_WORKSPACE.id, days, url.searchParams.get("tz") ?? undefined) });
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

    // Which Friday this server is, for Settings › About in a browser, where there is no desktop app to say it (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
    if (req.method === "GET" && url.pathname === "/api/version") {
      appVersion ??= readFile(new URL("../package.json", import.meta.url), "utf8").then((t) => String((JSON.parse(t) as { version?: unknown }).version ?? ""), () => "");
      return json(res, 200, { version: await appVersion });
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
        // On someone's own computer the one person there is who every runner acts as, as the open-source edition has it.
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
          ...(q("apiKey", 2) === "1" ? { apiKey: "1" } : {}),
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
    // A session brought back its own way below, left alone here.
    let ownWay = new Set<string>();
    ownWay = new Set(teammates ? await teammates.sessions() : []);
    void reattachAll(me, {
      mine: async (uid, n) => (await store.mine(uid, n)).filter((x) => !ownWay.has(x.sid)),
      state: (sid) => store.state(sid).catch(() => null),
      invite: linkToken,
      actorToken: (sid, uid) => signActor(o.secret, sid, uid),
      start: (params) => callHost("start", params, hostCtx(me)),
      log: (l) => console.log(`[friday] ${l}`),
    }).catch((e) => console.error("[friday] bringing coding tools back:", e));
    // Every teammate, whenever it last worked: they are always there (teammates.ts). Each on its own account, in its own folder,
    // its conversation kept by who it is; one already here is left as it is (ifOffline).
    const team = teammates ? await teammates.team() : null;
    if (teammates && team) {
      void (async () => {
        const rooms = await teammates.rooms();
        const liveRooms = new Set((await Promise.all(rooms.map(async (r) => ((await store.exists(r.sid).catch(() => false)) ? r.sid : "")))).filter(Boolean));
        for (const t of await teammates.list()) {
          await startTeammate(team, me, t, { ifOffline: true })
            .then(() => console.log(`[friday] ${t.name} is back`))
            .catch((e: Error) => console.error(`[friday] ${t.name} didn't come back: ${e.message}`));
          // And in each room it is in, with the conversation it has there.
          // Not in a room whose session is gone from the store: nothing to come back to.
          for (const r of rooms.filter((x) => x.lanes[t.id] && liveRooms.has(x.sid)))
            await startTeammate(r.sid, me, t, { ifOffline: true }, { lane: r.lanes[t.id]!, keepAs: roomKeep(t.id, r.id) }).catch((e: Error) => console.error(`[friday] ${t.name} didn't come back in ${r.name}: ${e.message}`));
        }
      })();
    }
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
    teammates: { starts: teammateStarts, dry: teammateDry, checkIns: (now: Date) => runCheckIns(now), back: () => runBack(), away: (now?: number) => runAway(now), awake: () => awake(), note: async (sid: string, lane: string) => ((n) => (n ? [n.note, ...n.preamble.map((p) => p.text).filter(Boolean)].join("\n\n") : null))(await (hub.teammate?.(sid, lane) ?? Promise.resolve(null))) },
    workflows: { tick: (now?: Date) => workflows?.tick(now) ?? Promise.resolve([]), engine: () => workflows },
    async close() {
      closing = true;
      clearInterval(shepherdLoop);
      clearInterval(resumeLoop);
      clearInterval(wakeLoop);
      if (reapAtStart) clearTimeout(reapAtStart);
      for (const t of teamTimers) clearInterval(t);
      for (const t of retryTimers) clearTimeout(t);
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

/**
 * The coding tools a fork of `state` starts with: each lane's that has one, the main lane's first, in the folder it was given
 * (not the copy it works in) and at the mode it had. Where there are none: none, Friday's own agent carrying the fork; or, in
 * the open-source edition (`local`), which has no Friday agent, why it can't be forked (2026-10-27 QA: such a fork queued every
 * message for good).
 */
/**
 * What a fork of `state` is: the kind of session it came from, its agents leading as they did. A fork is a session of its own,
 * never another team room (Arun, 2026-10-28: "iron everything and ensure we are good… any logic errors and fixes"). `mine` is
 * a build with FRIDAY_MINE set or the open-source edition (localEdition).
 */
export function forkKind(state: SessionState, mine: boolean): { options: SessionOptionsPatch; lead: boolean; copy: boolean } {
  const kind = { options: { webSearch: false, controlMode: "ask", mcp: true, model: "", agent: null } as SessionOptionsPatch, lead: false, copy: true };
  // A Work session's fork is Work too (its rail, its note, listed under Work), its agents leading as they did in the one folder
  // they share: Work's agents never work in copies. It came up as a Code session, under the Code tab.
  if (mine && state.options.work) Object.assign(kind, { options: { ...kind.options, work: true, webSearch: true }, lead: !!state.lead, copy: false });
  return kind;
}

/** This server's version, from its package.json, read once. */
let appVersion: Promise<string> | undefined;

export function forkTools(state: SessionState, local: boolean): { lane?: string; tool: EngineTool; cwd: string; mode: EngineMode }[] | string {
  const lanes = [{ id: MAIN_LANE, name: "" }, ...state.lanes.map((l) => ({ id: l.id, name: laneName(state, l.id) }))];
  const out = lanes.flatMap(({ id, name }) => {
    const e = state.engines[id];
    return e?.tool ? [{ ...(id === MAIN_LANE ? {} : { lane: name }), tool: e.tool, cwd: e.copyOf ?? e.cwd, mode: e.mode }] : [];
  });
  // With no tool on the main lane the first other one takes it: a fork is worked in from its main lane.
  if (out.length && out[0]!.lane) delete out[0]!.lane;
  if (!out.length && local) return "This session has no coding tool to carry on, and Friday's own agent isn't in this edition. Start a new session with Claude Code, Codex or another of your tools instead.";
  return out;
}

/**
 * Sessions one look at the Board or the sidebar's poll reads: the newest the browser lists, first. It was sixty, and a session
 * older than the sixtieth never showed as Needs you, nor counted in the Board's week (2026-10-27 QA). Five hundred is years of
 * someone's sessions; read a few dozen at a time (READ_AT_ONCE), and remembered by their last event, it stays a quick look.
 */
export const LISTED_SESSIONS = 500;
export const READ_AT_ONCE = 32;
const sidsOf = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const listedSids = (v: unknown) => sidsOf(v).slice(0, LISTED_SESSIONS);
const listedCount = (v: unknown) => sidsOf(v).length;

/** `fn` over `items`, `n` at a time, the answers in their order: hundreds read side by side were hundreds of reads at once. */
export async function mapLimit<T, R>(items: readonly T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

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



