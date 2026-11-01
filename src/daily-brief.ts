import { rankReady, readyIn } from "./ready.js";
import type { Redis } from "ioredis";
import { goalsIn, rankGoals, type TrackedGoal } from "./goals.js";
import { attentionIn, sortAttention, type Attention } from "./attention.js";
import { limitHit } from "./limit-reset.js";
import { laneName } from "./session/core.js";
import { boardBusy, type SessionState } from "./session/projection.js";
import { briefLine, plainText, runsIn, teamBrief, type Place } from "./team-away.js";
import { isCheckIn, saysNoUpdate, type CheckIn } from "./teammate-checkins.js";
import { ENGINE_NAMES, MAIN_LANE, type EngineTool, type SessionEvent } from "./types.js";

/**
 * The daily brief and standup (Arun, 2026-10-31: Friday as the intelligence layer for productivity and management): a morning
 * brief and an evening wrap-up across everything the person has going, every Code and Work session, every Crew teammate and
 * room. What got done, what is at risk, what each agent is on next, the decisions waiting on them, and each tool's usage.
 *
 * Read from the logs alone, the way the Away brief is (team-away.ts teamBrief): no model call, so it is instant, free, and says
 * nothing the logs don't. Sent at the times the person sets in their own time zone, on opening Friday after a long gap, and on
 * demand (/brief); shown as a card on the home screen and said as a notification.
 */

export type BriefKind = "morning" | "evening" | "now";

/** Where a line came from, so it opens there: a session, a Crew room or the Crew's own room. */
export interface BriefWhere {
  sid: string;
  title: string;
  kind: "code" | "work" | "crew" | "room";
  seq?: number;
  lane?: string;
}

/** A teammate a line is about, for its face. */
export interface BriefMate {
  name: string;
  look?: string;
}

export interface BriefDone {
  who: string;
  text: string;
  where: BriefWhere;
  mate?: BriefMate;
  pr?: { url: string; state: "opened" | "merged" };
  files?: number;
  /** What shows it works: a check that passed on it (board.checked), in a few words. */
  proof?: string;
  /** Turns it took, when more than one. */
  turns?: number;
}

export type RiskKind = "error" | "limit" | "stalled" | "blocked" | "quiet" | "usage" | "goal";
export interface BriefRisk {
  kind: RiskKind;
  who?: string;
  text: string;
  where?: BriefWhere;
  mate?: BriefMate;
}

export interface BriefPlan {
  who: string;
  text: string;
  /** On it now, a board task it has, queued for it, a check-in or wake later today, or what is left on a board. */
  source: "running" | "board" | "queued" | "checkin" | "wake" | "left" | "goal";
  /** "09:00", for a check-in or a wake at a time. */
  at?: string;
  where?: BriefWhere;
  mate?: BriefMate;
}

export type BriefDecision = Pick<Attention, "sid" | "title" | "kind" | "text" | "seq"> & { agent?: string; lane?: string };

export interface BriefUsage {
  tool: string;
  name: string;
  /** Today's, in the person's day: input and output, not cache reads. */
  tokens: number;
  turns: number;
  windows: { label: string; used: number; resetsAt: number | null }[];
}

export interface DailyBrief {
  id: string;
  kind: BriefKind;
  since: number;
  until: number;
  tz: string;
  /** One line that says it all, from the counts. */
  headline: string;
  done: BriefDone[];
  risk: BriefRisk[];
  plan: BriefPlan[];
  decisions: { count: number; top: BriefDecision[] };
  usage: BriefUsage[];
  /** The way into each session a line names, for the page to open one it hasn't yet (a room). */
  invites?: Record<string, string>;
}

/** A coding tool's windows as the router reads them off the person's computer (app.ts toolOptionsFor). */
export interface ToolWindows {
  tool: EngineTool;
  windows: { kind: string; label?: string; usedPercent: number | null; resetsAt?: number | null }[];
}

export interface CrewInput {
  places: Place[];
  mates: { id: string; name: string; lane: string; look?: string; checkins?: CheckIn[] }[];
}

export interface BriefInput {
  me: string;
  kind: BriefKind;
  since: number;
  until: number;
  tz: string;
  sessions: { state: SessionState; events: readonly SessionEvent[] }[];
  crew?: CrewInput | null;
  limits?: ToolWindows[];
  /** Each pull request's state as GitHub has it, by URL, where it could be asked. */
  prs?: Record<string, "open" | "merged" | "closed">;
  /** Pull requests already told as merged in an earlier brief: not again. */
  toldMerged?: ReadonlySet<string>;
}

/** A run quiet this long in the middle of a turn has stalled. */
export const STALL_MS = 30 * 60_000;
/** A Crew room with work left and nothing happening this long has gone quiet. */
export const QUIET_MS = 4 * 3600_000;
/** A usage window this full is at risk. */
export const LIMIT_CLOSE = 80;
/** Away this long, opening Friday brings the brief of the stretch. */
export const LONG_GAP_MS = 6 * 3600_000;
/** How long after its time a scheduled brief still goes: a computer asleep at 08:30 still has its brief at 09:40. */
export const GRACE_MS = 3 * 3600_000;

const TOP_DECISIONS = 3;
const MAX_LINES = 12;

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
/** Its first line with words, as a line to read. */
const firstLine = (s: string) => plainText(s.trim().split("\n").find((l) => l.replace(/[#>*_`\-\s|]/g, "")) ?? "");
const agentOf = (state: SessionState, lane: string) => {
  const n = laneName(state, lane);
  return lane === MAIN_LANE && n === "Main" ? "Friday Code" : n;
};
const kindOf = (state: SessionState): BriefWhere["kind"] => (state.options.team ? "crew" : state.options.work ? "work" : "code");

// ── Time, in the person's zone ─────────────────────────────────────────────────────────────────────────────────────────────

/** A zone this computer knows, else UTC. */
export function cleanZone(tz: unknown): string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** The wall clock in `tz` at `t`: its day ("YYYY-MM-DD"), "HH:MM", minutes into the day and weekday (0 = Sunday). */
export function wallClock(t: number, tz: string): { day: string; hhmm: string; minutes: number; weekday: number } {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: cleanZone(tz), hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(t);
  const get = (k: Intl.DateTimeFormatPartTypes) => p.find((x) => x.type === k)?.value ?? "";
  const hh = get("hour") === "24" ? "00" : get("hour");
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hhmm: `${hh}:${get("minute")}`, minutes: Number(hh) * 60 + Number(get("minute")), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")) };
}

/** How far `tz` is ahead of UTC at `t`, in ms. */
function offsetAt(t: number, tz: string): number {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: cleanZone(tz), hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(t);
  const get = (k: Intl.DateTimeFormatPartTypes) => Number(p.find((x) => x.type === k)?.value ?? 0);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second")) - Math.floor(t / 1000) * 1000;
}

/** The moment it is `hhmm` on `day` in `tz`. A time a clock change skips is the moment after it. */
export function zonedAt(day: string, hhmm: string, tz: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, h!, mi!);
  const first = guess - offsetAt(guess, tz);
  return guess - offsetAt(first, tz);
}

/** The start of the person's day at `t`. */
export const dayStart = (t: number, tz: string) => zonedAt(wallClock(t, tz).day, "00:00", tz);

// ── What the person set ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface BriefSettings {
  /** "HH:MM", or null when off. */
  morning: string | null;
  evening: string | null;
  tz: string;
  /** Said as a notification (the desktop's, and the phone's where it is set up). */
  notify: boolean;
}
export const DEFAULT_SETTINGS: BriefSettings = { morning: "08:30", evening: "18:00", tz: "UTC", notify: true };

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Settings as the page sent them, checked, over what was there. */
export function cleanSettings(v: unknown, had: BriefSettings = DEFAULT_SETTINGS): BriefSettings {
  const c = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const time = (x: unknown, was: string | null) => (x === null || x === false ? null : typeof x === "string" && HHMM.test(x) ? x : was);
  return {
    morning: "morning" in c ? time(c.morning, had.morning) : had.morning,
    evening: "evening" in c ? time(c.evening, had.evening) : had.evening,
    tz: "tz" in c ? cleanZone(c.tz) : had.tz,
    notify: typeof c.notify === "boolean" ? c.notify : had.notify,
  };
}

/**
 * The scheduled brief due at `now`, or null: the latest of the morning and evening times today (or yesterday's evening, just
 * after midnight) that has passed, within GRACE_MS of it. Its slot ("YYYY-MM-DD morning") is claimed once (BriefStore.claim).
 */
export function briefDue(s: BriefSettings, now: number): { kind: "morning" | "evening"; slot: string; at: number } | null {
  const today = wallClock(now, s.tz).day;
  const yesterday = wallClock(zonedAt(today, "00:00", s.tz) - 3600_000, s.tz).day;
  let best: { kind: "morning" | "evening"; slot: string; at: number } | null = null;
  for (const day of [yesterday, today])
    for (const kind of ["morning", "evening"] as const) {
      const hhmm = s[kind];
      if (!hhmm) continue;
      const at = zonedAt(day, hhmm, s.tz);
      if (at > now || now - at > GRACE_MS) continue;
      if (!best || at > best.at) best = { kind, slot: `${day} ${kind}`, at };
    }
  return best;
}

// ── What it says ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The board's checks that passed, by task id: the proof a task works. */
function proofsIn(events: readonly SessionEvent[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of events) if (e.body.type === "board.checked" && e.body.ok && !e.body.skipped) out.set(e.body.id, `${clip(e.body.command, 60)} passed`);
  return out;
}

/** A lane's queued instructions, oldest first. */
function queuedOn(state: SessionState, lane: string): number[] {
  return lane === MAIN_LANE ? state.pendingInstructions : (state.lanePending[lane] ?? []);
}
const runStatus = (state: SessionState, lane: string) => (lane === MAIN_LANE ? state.run.status : state.laneRuns[lane]?.status);

/** Whether a check-in runs later today (after `now`), and at what time. */
function checkInLaterToday(c: CheckIn, now: number): string | null {
  const w = wallClock(now, c.tz);
  if (c.every === "hourly") return "every hour";
  if (c.every === "weekdays" && (w.weekday === 0 || w.weekday === 6)) return null;
  if (c.every === "weekly" && !c.days.includes(w.weekday)) return null;
  const [h, m] = c.at.split(":").map(Number);
  return h! * 60 + m! > w.minutes ? c.at : null;
}

/**
 * The brief over [since, until]: null when there is nothing to say (nothing done, at risk, planned or waiting: usage, a window
 * filling up and check-ins alone are not a brief).
 */
export function collectBrief(i: BriefInput): DailyBrief | null {
  const { since, until } = i;
  const done: BriefDone[] = [];
  const risk: BriefRisk[] = [];
  const plan: BriefPlan[] = [];
  const decisions: BriefDecision[] = [];
  const tokens = new Map<string, { tokens: number; turns: number }>();
  const today = dayStart(until, i.tz);
  const crewSids = new Set((i.crew?.places ?? []).map((p) => p.sid));
  const bySid = new Map(i.sessions.map((s) => [s.state.id, s]));
  /** A Crew room is told by its place (the open-source edition's rooms are team sessions too), anything else by its options. */
  const placeOf = (sid: string) => i.crew?.places.find((p) => p.sid === sid);
  const whereOf = (state: SessionState, extra: Partial<BriefWhere> = {}): BriefWhere => {
    const p = placeOf(state.id);
    return { sid: state.id, title: p?.room ?? state.title, kind: p ? (p.room === null ? "crew" : "room") : kindOf(state), ...extra };
  };
  const mateBy = new Map((i.crew?.mates ?? []).map((m) => [m.id, m]));
  /** The teammate on a lane of a crew place, if one is. */
  const mateAt = (sid: string, lane: string) => {
    const p = i.crew?.places.find((x) => x.sid === sid);
    const id = p && Object.entries(p.lanes).find(([, l]) => l === lane)?.[0];
    const m = id ? mateBy.get(id) : undefined;
    return m ? { name: m.name, ...(m.look ? { look: m.look } : {}) } : undefined;
  };
  const toldPr = new Set<string>();

  for (const { state, events } of i.sessions) {
    const crew = crewSids.has(state.id);
    const lanes = new Set([MAIN_LANE, ...state.lanes.map((l) => l.id)]);
    const runs = runsIn(events, lanes);
    const proofs = proofsIn(events);
    const titles = new Map<string, string>();

    // Usage today: each tool's input and output, cache reads left out (tool-usage.ts spentBefore).
    for (const e of events) {
      if (e.ts < today || e.ts > until) continue;
      const b = e.body;
      const lane = e.lane ?? MAIN_LANE;
      const tool = b.type === "agent.usage" ? (b.tool ?? state.engines[lane]?.tool ?? "friday") : b.type === "agent.message" && b.tokens ? "friday" : null;
      if (!tool) continue;
      const t = b.type === "agent.usage" ? b.input + b.output : b.type === "agent.message" ? (b.tokens ?? 0) : 0;
      const had = tokens.get(tool) ?? { tokens: 0, turns: 0 };
      tokens.set(tool, { tokens: had.tokens + t, turns: had.turns + (b.type === "agent.usage" ? 1 : 0) });
    }

    // Done: board tasks finished (Crew's come from its own brief below), pull requests opened and merged, and otherwise each
    // session's last result in the stretch.
    const boardDone: BriefDone[] = [];
    for (const e of events) {
      const b = e.body;
      if (b.type === "board.posted") for (const t of b.tasks) titles.set(t.id, t.title);
      if (e.ts < since || e.ts > until || crew) continue;
      if (b.type === "board.finished" && b.status === "done") {
        const run = runs.findLast((r) => r.lane === b.lane && r.startSeq < e.seq);
        const proof = proofs.get(b.id);
        boardDone.push({ who: b.name, text: plainText(titles.get(b.id) ?? b.id), where: whereOf(state, { seq: e.seq, lane: b.lane }), ...(run?.files.length ? { files: run.files.length } : {}), ...(proof ? { proof } : {}) });
      }
    }
    const prOpened = events.filter((e) => e.ts >= since && e.ts <= until && e.body.type === "folder.committed" && !e.body.error && !!e.body.prUrl && e.body.prCreated);
    const prMerged = events.filter((e) => e.ts >= since && e.ts <= until && e.body.type === "pr.shepherd.ended" && e.body.outcome === "merged");
    if (!crew) {
      const inStretch = runs.filter((r) => r.endedAt !== null && r.endedAt >= since && r.endedAt <= until);
      const results = inStretch.filter((r) => r.outcome === "done" && r.said && !saysNoUpdate(r.said) && !isCheckIn(r.cause));
      const last = results.at(-1);
      if (boardDone.length) done.push(...boardDone);
      else if (last) {
        const files = new Set(inStretch.flatMap((r) => r.files));
        done.push({ who: agentOf(state, last.lane), text: clip(firstLine(last.said), 140), where: whereOf(state, { seq: last.saidSeq, lane: last.lane }), ...(files.size ? { files: files.size } : {}), ...(results.length > 1 ? { turns: results.length } : {}) });
      }
      const line = done.findLast((d) => d.where.sid === state.id);
      for (const e of prOpened) {
        if (e.body.type !== "folder.committed" || !e.body.prUrl || toldPr.has(e.body.prUrl)) continue;
        toldPr.add(e.body.prUrl);
        const url = e.body.prUrl;
        const merged = i.prs?.[url] === "merged" && !i.toldMerged?.has(url);
        if (line && !line.pr) line.pr = { url, state: merged ? "merged" : "opened" };
        else done.push({ who: agentOf(state, e.lane ?? MAIN_LANE), text: clip(firstLine(e.body.message) || state.title, 140), where: whereOf(state, { seq: e.seq, lane: e.lane ?? MAIN_LANE }), pr: { url, state: merged ? "merged" : "opened" } });
      }
      if (prMerged.length) {
        const url = events.findLast((e) => e.body.type === "folder.committed" && !!e.body.prUrl)?.body;
        const prUrl = url?.type === "folder.committed" ? url.prUrl : undefined;
        if (prUrl && !toldPr.has(prUrl) && !i.toldMerged?.has(prUrl)) {
          toldPr.add(prUrl);
          done.push({ who: agentOf(state, prMerged.at(-1)!.lane ?? MAIN_LANE), text: clip(state.title, 140), where: whereOf(state), pr: { url: prUrl, state: "merged" } });
        }
      }
    }

    // At risk: a lane's last turn stopped on an error (its usage limit, said as such), a turn gone quiet mid-run, board tasks blocked.
    for (const lane of lanes) {
      const mine = runs.filter((r) => r.lane === lane);
      const lastRun = mine.at(-1);
      const who = crew ? (mateAt(state.id, lane)?.name ?? agentOf(state, lane)) : agentOf(state, lane);
      const mate = crew ? mateAt(state.id, lane) : undefined;
      if (lastRun?.outcome === "error" && lastRun.endedAt !== null && lastRun.endedAt >= since && !crew) {
        const hit = limitHit(lastRun.error, lastRun.endedAt, i.tz);
        risk.push({ kind: hit ? "limit" : "error", who, text: hit ? `hit its usage limit in ${state.title}${hit.resetsAt ? ` (resets ${clockIn(hit.resetsAt, i.tz)})` : ""}` : `stopped on an error in ${state.title}: ${clip(lastRun.error ?? "it stopped", 140)}`, where: whereOf(state, { lane, ...(lastRun.endSeq ? { seq: lastRun.endSeq } : {}) }) });
      }
      // Waiting on the person is a decision, not work under way.
      const waits = !!(state.openQuestions[lane] || state.approvals[lane] || state.asks[lane]);
      if (runStatus(state, lane) === "running" && lastRun?.outcome === "running" && !waits) {
        const lastOnLane = events.findLast((e) => (e.lane ?? MAIN_LANE) === lane);
        const quiet = until - (lastOnLane?.ts ?? lastRun.startedAt);
        if (quiet >= STALL_MS && until - lastRun.startedAt >= STALL_MS) risk.push({ kind: "stalled", who, text: `has been quiet for ${span(quiet)} mid-turn in ${state.title}`, where: whereOf(state, { lane }), ...(mate ? { mate } : {}) });
        else plan.push({ who, text: clip(firstLine(lastRun.cause).replace(BOARD_TASK, "") || "its current turn", 120), source: "running", where: whereOf(state, { lane }), ...(mate ? { mate } : {}) });
      }
      // Queued for it: the first of what it will do next.
      const queued = queuedOn(state, lane).filter((q) => !state.withdrawn.includes(q));
      if (queued.length) {
        const first = events.find((e) => e.seq === queued[0] && e.body.type === "instruction");
        const text = first?.body.type === "instruction" ? first.body.text : "";
        if (text && !isCheckIn(text)) plan.push({ who, text: `${clip(firstLine(text.replace(/^\[[^\]]+\]\s*/, "")), 110)}${queued.length > 1 ? ` (+${queued.length - 1} more queued)` : ""}`, source: "queued", where: whereOf(state, { lane }), ...(mate ? { mate } : {}) });
      }
    }
    for (const t of state.board?.tasks ?? []) {
      const mate = crew && t.lane ? mateAt(state.id, t.lane) : undefined;
      if (t.status === "blocked" && !crew) risk.push({ kind: "blocked", who: t.name ?? "", text: `is blocked on “${plainText(t.title)}” in ${state.title}${t.report ? `: ${clip(t.report, 120)}` : ""}`, where: whereOf(state, t.lane ? { lane: t.lane } : {}) });
      if (t.status === "claimed" && t.lane && !plan.some((p) => p.where?.sid === state.id && p.where.lane === t.lane && p.source === "board")) plan.push({ who: mate?.name ?? t.name ?? agentOf(state, t.lane), text: plainText(t.title), source: "board", where: whereOf(state, { lane: t.lane }), ...(mate ? { mate } : {}) });
    }
    const readyNext = (state.board?.tasks ?? []).filter((t) => t.status === "open").length;
    if (readyNext && state.board) plan.push({ who: crewSids.has(state.id) ? (i.crew?.places.find((p) => p.sid === state.id)?.room ?? "The crew") : state.title, text: `has ${readyNext} more task${readyNext === 1 ? "" : "s"} on the board`, source: "left", where: whereOf(state) });
    // Wakes at a time later today.
    for (const w of Object.values(state.wakes ?? {})) {
      if (!w.on.at || w.on.at < until || w.on.at > dayStart(until, i.tz) + 86_400_000) continue;
      plan.push({ who: crew ? (mateAt(state.id, w.lane)?.name ?? agentOf(state, w.lane)) : agentOf(state, w.lane), text: clip(firstLine(w.then), 110), source: "wake", at: clockIn(w.on.at, i.tz), where: whereOf(state, { lane: w.lane }) });
    }

    // Goals this person set (goals.ts): one at risk says why; one on track with a deadline is today's plan, with how far it got.
    for (const g of goalsIn(state, events, until)) {
      if (g.by && g.by !== i.me) continue;
      const progress = g.progress ? `, ${g.progress.done} of ${g.progress.total} done` : "";
      if (g.status === "at-risk") risk.push({ kind: "goal", who: "Goal", text: `“${clip(g.text, 90)}” in ${state.title} is at risk: ${g.why ?? ""}`, where: whereOf(state, { lane: g.where.lane }) });
      else if (g.status === "on-track" && g.due) plan.push({ who: "Goal", text: `“${clip(g.text, 90)}” is due ${g.due - until < 86_400_000 ? `at ${clockIn(g.due, i.tz)}` : wallClock(g.due, i.tz).day}${progress}`, source: "goal", where: whereOf(state, { lane: g.where.lane }) });
    }

    // Decisions waiting: the sidebar's Needs you, read the same way (attention.ts); a stopped run is at risk, not a decision.
    for (const a of attentionIn(state, i.me)) if (a.kind !== "stopped") decisions.push({ sid: a.sid, title: a.title, kind: a.kind, text: a.text, seq: a.seq, ...(a.agent ? { agent: a.agent } : {}), ...(a.lane ? { lane: a.lane } : {}) });
  }

  // The Crew: what each teammate finished and what stopped short, from the Away brief's own reading of its places.
  if (i.crew?.places.length) {
    // An Away brief posted in the stretch (team.brief in the Crew's own room) already told the crew's night: one line pointing at
    // it, and the crew's lines from after it only, so nothing is told twice.
    const home = i.crew.places.find((p) => p.room === null);
    const away = home?.events.findLast((e) => e.body.type === "team.brief" && !e.body.workflow && e.ts >= since && e.ts <= until);
    let crewSince = since;
    if (away?.body.type === "team.brief") {
      crewSince = Math.max(since, away.body.until);
      if (away.body.done.length || away.body.failed.length || away.body.waiting.length) done.push({ who: "Crew", text: briefLine(away.body), where: { sid: home!.sid, title: "Away brief", kind: "crew", seq: away.seq } });
    }
    const tb = teamBrief(i.crew.places, i.crew.mates.map((m) => ({ id: m.id, name: m.name, lane: m.lane })), crewSince, until);
    const look = (name: string) => i.crew!.mates.find((m) => m.name === name)?.look;
    const where = (sid: string | undefined, seq?: number, lane?: string): BriefWhere => {
      const p = sid ? i.crew!.places.find((x) => x.sid === sid) : i.crew!.places.find((x) => x.room === null);
      const s = p ? bySid.get(p.sid)?.state : undefined;
      return { sid: p?.sid ?? sid ?? "", title: p?.room ?? s?.title ?? "Crew", kind: p?.room ? "room" : "crew", ...(seq !== undefined ? { seq } : {}), ...(lane ? { lane } : {}) };
    };
    for (const d of tb.done) {
      const proofs = proofsIn(i.crew.places.find((p) => p.sid === (d.sid ?? i.crew!.places.find((x) => x.room === null)?.sid))?.events ?? []);
      const ids = new Map<string, string>();
      for (const p of i.crew.places) for (const e of p.events) if (e.body.type === "board.posted") for (const t of e.body.tasks) ids.set(plainText(t.title), t.id);
      const proof = ids.get(d.title) ? proofs.get(ids.get(d.title)!) : undefined;
      done.push({ who: d.name, text: d.title, where: where(d.sid, d.seq, d.lane), mate: { name: d.name, ...(look(d.name) ? { look: look(d.name) } : {}) }, ...(d.files?.length ? { files: d.files.length } : {}), ...(d.pr ? { pr: { url: d.pr, state: i.prs?.[d.pr] === "merged" ? "merged" : "opened" } } : {}), ...(proof ? { proof } : {}) });
    }
    for (const f of tb.failed) {
      // Stopped by a person: their own doing, not a risk to tell them about (Arun, 2026-11-01, a brief of six "Arun Dass stopped
      // Kit on it. Kit is free again; reassign or retry it.": "design better too").
      if (/\bstopped \S+ on it\b/.test(f.why)) continue;
      const hit = limitHit(f.why, until, i.tz);
      risk.push({ kind: hit ? "limit" : /block/i.test(f.why) || f.seq === undefined ? "blocked" : "error", who: f.name, text: hit ? `hit its usage limit on “${f.title}”` : `didn't finish “${f.title}”: ${clip(f.why, 90)}`, where: where(f.sid, f.seq, f.lane), mate: { name: f.name, ...(look(f.name) ? { look: look(f.name) } : {}) } });
    }
    // Rooms that went quiet: work left on the board, nobody on it, nothing said for a while.
    for (const p of i.crew.places) {
      if (p.room === null) continue;
      const s = bySid.get(p.sid)?.state;
      const lastAt = p.events.at(-1)?.ts ?? 0;
      const running = s ? Object.values(p.lanes).some((l) => runStatus(s, l) === "running") : false;
      const open = s?.board ? s.board.tasks.filter((t) => t.status !== "done" && t.status !== "cancelled").length : 0;
      if (s && boardBusy(s) && !running && until - lastAt >= QUIET_MS) risk.push({ kind: "quiet", text: `${p.room} went quiet ${span(until - lastAt)} ago with ${open} task${open === 1 ? "" : "s"} not done`, where: where(p.sid) });
    }
    // Check-ins later today.
    for (const m of i.crew.mates)
      for (const c of m.checkins ?? []) {
        const at = checkInLaterToday(c, until);
        if (at) plan.push({ who: m.name, text: clip(c.text, 110), source: "checkin", at, where: where(undefined, undefined, m.lane), mate: { name: m.name, ...(m.look ? { look: m.look } : {}) } });
      }
  }

  // Usage: each tool's windows from the person's computer; a window at LIMIT_CLOSE or over is at risk.
  const usage: BriefUsage[] = [];
  const toolsSeen = new Set<string>([...tokens.keys(), ...(i.limits ?? []).map((l) => l.tool)]);
  for (const tool of toolsSeen) {
    const lim = i.limits?.find((l) => l.tool === tool);
    const windows = (lim?.windows ?? [])
      .filter((w) => w.usedPercent !== null && w.kind !== "overage")
      .map((w) => ({ label: windowLabel(w), used: Math.round(w.resetsAt && w.resetsAt * 1000 <= until ? 0 : w.usedPercent!), resetsAt: w.resetsAt ?? null }));
    const t = tokens.get(tool) ?? { tokens: 0, turns: 0 };
    if (!t.tokens && !windows.length) continue;
    const name = tool === "friday" ? "Friday" : (ENGINE_NAMES[tool as EngineTool] ?? tool);
    usage.push({ tool, name, tokens: t.tokens, turns: t.turns, windows });
    const worst = windows.reduce<(typeof windows)[number] | null>((a, w) => (!a || w.used > a.used ? w : a), null);
    if (worst && worst.used >= LIMIT_CLOSE && !risk.some((r) => r.kind === "limit" && r.who === name))
      risk.push({ kind: "usage", who: name, text: worst.used >= 100 ? `is out of its ${worst.label} window${worst.resetsAt ? ` until ${clockIn(worst.resetsAt * 1000, i.tz)}` : ""}` : `is at ${worst.used}% of its ${worst.label} window${worst.resetsAt ? `, resets ${clockIn(worst.resetsAt * 1000, i.tz)}` : ""}` });
  }
  usage.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));

  const top = sortAttention(decisions as Attention[]).slice(0, TOP_DECISIONS) as BriefDecision[];
  const real = plan.filter((p) => p.source !== "checkin");
  // A window filling up is worth saying beside the day's work, not a brief of its own.
  if (!done.length && !risk.some((r) => r.kind !== "usage") && !decisions.length && !real.length) return null;
  const order: Record<BriefPlan["source"], number> = { goal: -1, running: 0, board: 1, queued: 2, wake: 3, left: 4, checkin: 5 };
  // One line for one thing: a teammate on a board task was said twice, once as its turn and once as its task (Arun, 2026-11-01).
  const said = new Set<string>();
  const lines = plan.filter((p) => {
    const key = `${p.who}|${p.text.toLowerCase()}`;
    return !said.has(key) && !!said.add(key);
  });
  const brief: DailyBrief = {
    id: `${i.kind}:${until}`,
    kind: i.kind,
    since,
    until,
    tz: i.tz,
    headline: "",
    done: done.sort((a, b) => Number(!!b.pr) - Number(!!a.pr)).slice(0, MAX_LINES),
    risk: risk.slice(0, MAX_LINES),
    plan: lines.sort((a, b) => order[a.source] - order[b.source]).slice(0, MAX_LINES),
    decisions: { count: decisions.length, top },
    usage,
  };
  brief.headline = headlineOf(brief);
  return brief;
}

/** "5-hour", "weekly": a window as the brief names it. */
function windowLabel(w: { kind: string; label?: string }): string {
  if (w.label) return w.label;
  const k = w.kind.toLowerCase();
  if (k === "five_hour" || k === "primary" || k === "session") return "5-hour";
  if (k.includes("week") || k.startsWith("seven_day") || k === "secondary") return "weekly";
  if (k === "month" || k === "monthly") return "monthly";
  return k.replace(/_/g, " ");
}

/** A board task's handle at the head of a turn's cause (agent-mesh.ts: `Board task "t1": …`), left out of the plan's line. */
const BOARD_TASK = /^Board task "[^"]*":\s*/;

const span = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h${m % 60 && m < 600 ? ` ${m % 60}m` : ""}` : `${Math.round(m / 1440)} days`;
};
const clockIn = (t: number, tz: string) => wallClock(t, tz).hhmm;

/** The brief in one line: its counts, for the notification and the card's head. */
export function headlineOf(b: Pick<DailyBrief, "done" | "risk" | "plan" | "decisions">): string {
  const prs = b.done.filter((d) => d.pr).length;
  const parts = [
    b.done.length ? `${b.done.length} done${prs ? ` (${prs} PR${prs === 1 ? "" : "s"})` : ""}` : "",
    b.risk.length ? `${b.risk.length} at risk` : "",
    b.decisions.count ? `${b.decisions.count} decision${b.decisions.count === 1 ? "" : "s"} waiting` : "",
    b.plan.length ? `${new Set(b.plan.map((p) => p.who)).size} lined up` : "",
  ].filter(Boolean);
  return parts.length ? `${parts.join(", ")}.` : "Nothing new.";
}

/** Pull requests the brief would mention, for their state to be asked first: opened in the week before `until`. */
export function prsToAsk(sessions: BriefInput["sessions"], crew: CrewInput | null | undefined, until: number, max = 8): { sid: string; lane: string; workspaceId: string; url: string }[] {
  const out = new Map<string, { sid: string; lane: string; workspaceId: string; url: string }>();
  const from = until - 7 * 86_400_000;
  const all = [...sessions.map((s) => ({ sid: s.state.id, ws: s.state.workspaceId, events: s.events })), ...(crew?.places ?? []).map((p) => ({ sid: p.sid, ws: sessions.find((s) => s.state.id === p.sid)?.state.workspaceId ?? "", events: p.events }))];
  for (const s of all)
    for (const e of s.events) {
      if (e.ts < from || e.body.type !== "folder.committed" || !e.body.prUrl || e.body.error) continue;
      out.set(e.body.prUrl, { sid: s.sid, lane: e.lane ?? MAIN_LANE, workspaceId: s.ws, url: e.body.prUrl });
    }
  return [...out.values()].slice(-max);
}

/** The lines a brief's done list counts as merged, to be remembered as told. */
export const mergedIn = (b: DailyBrief) => b.done.flatMap((d) => (d.pr?.state === "merged" ? [d.pr.url] : []));


// ── Kept per person ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Each person's settings, last scheduled brief and the slot it went in, under their workspace: the hosted service has many
 * people in many workspaces, the open-source edition one person in one.
 */
export class BriefStore {
  constructor(
    private redis: Redis,
    private prefix: string,
  ) {}
  private k(wid: string, uid: string, what: string) {
    return `${this.prefix}brief:${what}:${wid}:${uid}`;
  }
  private get people() {
    return `${this.prefix}brief:people`;
  }

  async settings(wid: string, uid: string): Promise<BriefSettings | null> {
    const raw = await this.redis.get(this.k(wid, uid, "settings"));
    return raw ? cleanSettings(JSON.parse(raw) as unknown) : null;
  }
  /** Saved, and the person counted among those the clock looks at. */
  async setSettings(wid: string, uid: string, s: BriefSettings): Promise<void> {
    await this.redis.multi().set(this.k(wid, uid, "settings"), JSON.stringify(s)).sadd(this.people, `${wid}\n${uid}`).exec();
  }
  async everyone(): Promise<{ wid: string; uid: string }[]> {
    return (await this.redis.smembers(this.people)).map((x) => {
      const [wid, uid] = x.split("\n");
      return { wid: wid!, uid: uid! };
    });
  }
  async latest(wid: string, uid: string): Promise<{ brief: DailyBrief; slot?: string } | null> {
    const raw = await this.redis.get(this.k(wid, uid, "latest"));
    return raw ? (JSON.parse(raw) as { brief: DailyBrief; slot?: string }) : null;
  }
  /** A slot taken for this person: true once, false to every later ask (another tab, process or minute). */
  async claim(wid: string, uid: string, slot: string): Promise<boolean> {
    return (await this.redis.set(this.k(wid, uid, `slot:${slot}`), "1", "EX", 2 * 86_400, "NX")) === "OK";
  }
  /** A scheduled brief made: where the next starts, and the brief itself when there was one. */
  async keep(wid: string, uid: string, brief: DailyBrief | null, slot: string, until: number): Promise<void> {
    const m = this.redis.multi().set(this.k(wid, uid, "until"), String(until));
    if (brief) m.set(this.k(wid, uid, "latest"), JSON.stringify({ brief, slot }), "EX", 7 * 86_400);
    await m.exec();
  }
  /** Where the last scheduled brief ended, so the next starts there. */
  async lastUntil(wid: string, uid: string): Promise<number | null> {
    const v = Number(await this.redis.get(this.k(wid, uid, "until")));
    return v > 0 ? v : null;
  }
  async toldMerged(wid: string, uid: string): Promise<Set<string>> {
    return new Set(await this.redis.smembers(this.k(wid, uid, "merged")));
  }
  async tellMerged(wid: string, uid: string, urls: string[]): Promise<void> {
    if (!urls.length) return;
    await this.redis.multi().sadd(this.k(wid, uid, "merged"), ...urls).expire(this.k(wid, uid, "merged"), 30 * 86_400).exec();
  }
}

/** Where a brief starts: the last one's end, else the evening before (a morning) or this morning (an evening), at most 36 hours back. */
export function briefSince(kind: BriefKind, until: number, lastUntil: number | null, s: Pick<BriefSettings, "morning" | "evening" | "tz">): number {
  const floor = until - 36 * 3600_000;
  if (kind === "now") return lastUntil && lastUntil < until ? Math.max(until - 7 * 86_400_000, lastUntil) : dayStart(until, s.tz);
  if (lastUntil && lastUntil < until) return Math.max(floor, lastUntil);
  const today = wallClock(until, s.tz).day;
  if (kind === "evening") return Math.max(floor, zonedAt(today, s.morning ?? "08:30", s.tz));
  const yesterday = wallClock(dayStart(until, s.tz) - 3600_000, s.tz).day;
  return Math.max(floor, zonedAt(yesterday, s.evening ?? "18:00", s.tz));
}

// ── The service: gathering, the routes and the clock ─────────────────────────────────────────────────────────────────────

export interface BriefDeps {
  redis: Redis;
  prefix: string;
  /** The open-source edition: one person, every session theirs. */
  local: boolean;
  store: {
    mine(uid: string, limit?: number): Promise<{ sid: string; at: number }[]>;
    state(sid: string): Promise<SessionState>;
    events(sid: string): Promise<SessionEvent[]>;
  };
  /** Who is asking, and in which workspace. */
  context(req: import("node:http").IncomingMessage): Promise<{ me: { id: string; name: string }; workspace: { id: string } } | null>;
  /** The person's Crew: its places and teammates, and whether they are away (null without one). */
  crew(wid: string, me: { id: string; name: string }): Promise<(CrewInput & { away: boolean }) | null>;
  /** Each coding tool's windows on the person's computer. */
  limits(uid: string): Promise<ToolWindows[]>;
  prState(sid: string, lane: string, wid: string, url: string): Promise<"open" | "merged" | "closed" | null>;
  /** The person's own link into a session they are in. */
  invite(state: SessionState, uid: string): string | null;
  /** A scheduled brief said on the person's phone, where that is set up. */
  push?(uid: string, brief: DailyBrief): Promise<void>;
  json(res: import("node:http").ServerResponse, status: number, body: unknown): void;
  readJson(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>>;
  log?(line: string): void;
}

/** Answers within this long or not at all: the brief never waits on a slow computer or GitHub. */
const SOON_MS = 4000;
const soon = <T,>(p: Promise<T>, fallback: T): Promise<T> => Promise.race([p.catch(() => fallback), new Promise<T>((done) => setTimeout(() => done(fallback), SOON_MS).unref?.())]);

export function dailyBriefs(d: BriefDeps) {
  const kept = new BriefStore(d.redis, d.prefix);

  /** The person's sessions in this workspace that moved since `from`, each with its log. */
  const sessionsFor = async (wid: string, me: { id: string; name: string }, from: number) =>
    (
      await Promise.all(
        (await d.store.mine(me.id, 80))
          .filter((s) => s.at >= from)
          .map(async ({ sid }) => {
            const state = await d.store.state(sid).catch(() => null);
            const m = state?.members[me.id];
            if (!state || !m || m.removed) return null;
            if (!d.local && state.workspaceId && state.workspaceId !== wid) return null;
            return { state, events: await d.store.events(sid) };
          }),
      )
    ).filter((s): s is NonNullable<typeof s> => !!s);

  /** The brief over [since, until] for one person in one workspace. */
  const build = async (wid: string, me: { id: string; name: string }, kind: BriefKind, since: number, until: number, tz: string): Promise<DailyBrief | null> => {
    // What moved in the week, or might still be running or waiting: older sessions have nothing to say.
    const sessions = await sessionsFor(wid, me, Math.min(since, until - 7 * 86_400_000));
    const [crew, limits, told] = await Promise.all([soon(d.crew(wid, me), null), soon(d.limits(me.id), [] as ToolWindows[]), kept.toldMerged(wid, me.id)]);
    const prs: Record<string, "open" | "merged" | "closed"> = {};
    await Promise.all(
      prsToAsk(sessions, crew, until).map(async (p) => {
        const s = await soon(d.prState(p.sid, p.lane, p.workspaceId || wid, p.url), null);
        if (s) prs[p.url] = s;
      }),
    );
    const b = collectBrief({ me: me.id, kind, since, until, tz, sessions, crew, limits, prs, toldMerged: told });
    if (!b) return null;
    await kept.tellMerged(wid, me.id, mergedIn(b));
    const named = new Set([...b.done, ...b.risk, ...b.plan].flatMap((x) => (x.where ? [x.where.sid] : [])).concat(b.decisions.top.map((x) => x.sid)));
    b.invites = Object.fromEntries(sessions.flatMap((s) => (named.has(s.state.id) ? ((t) => (t ? [[s.state.id, t] as const] : []))(d.invite(s.state, me.id)) : [])));
    return b;
  };

  /** Each person's scheduled brief, once per slot, at its time in their zone; held while they are away (the Away brief has it). */
  const tick = async (now = Date.now()) => {
    for (const { wid, uid } of await kept.everyone()) {
      const s = await kept.settings(wid, uid);
      const due = s && briefDue(s, now);
      if (!s || !due) continue;
      const me = { id: uid, name: "" };
      if ((await soon(d.crew(wid, me), null))?.away) continue;
      if (!(await kept.claim(wid, uid, due.slot))) continue;
      const since = briefSince(due.kind, now, await kept.lastUntil(wid, uid), s);
      const b = await build(wid, me, due.kind, since, now, s.tz).catch((e: Error) => (d.log?.(`brief for ${uid}: ${e.message}`), null));
      await kept.keep(wid, uid, b, due.slot, now);
      if (b && s.notify) await d.push?.(uid, b).catch(() => {});
    }
  };

  /** GET /api/brief (on demand, or since a time), GET /api/brief/latest, GET and PUT /api/brief/settings. */
  const handle = async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== "/api/brief" && !url.pathname.startsWith("/api/brief/") && url.pathname !== "/api/goals" && url.pathname !== "/api/ready") return false;
    const ctx = await d.context(req);
    if (!ctx) return d.json(res, 401, { error: "Sign in first." }), true;
    // GET /api/ready: every agent's finished work across this person's sessions of the last two weeks, proven first (ready.ts).
    // Each session's folded state only, never its log: this is asked for on every home screen.
    if (url.pathname === "/api/ready") {
      if (req.method !== "GET") return d.json(res, 405, { error: "Not allowed" }), true;
      const from = Date.now() - 14 * 86_400_000;
      const states = (
        await Promise.all(
          (await d.store.mine(ctx.me.id, 60))
            .filter((s) => s.at >= from)
            .map(async ({ sid, at }) => {
              const state = await d.store.state(sid).catch(() => null);
              const m = state?.members[ctx.me.id];
              if (!state || !m || m.removed || (!d.local && state.workspaceId && state.workspaceId !== ctx.workspace.id)) return null;
              return { state, at };
            }),
        )
      ).filter((s): s is NonNullable<typeof s> => !!s);
      const when = new Map(states.map((s) => [s.state.id, s.at]));
      const items = rankReady(states.flatMap((s) => readyIn(s.state)), (i) => when.get(i.sid) ?? 0).slice(0, 12);
      const named = new Set(items.map((i) => i.sid));
      const invites = Object.fromEntries(states.flatMap((s) => (named.has(s.state.id) ? ((t) => (t ? [[s.state.id, t] as const] : []))(d.invite(s.state, ctx.me.id)) : [])));
      return d.json(res, 200, { items, invites }), true;
    }
    // GET /api/goals: the goals this person set, across their sessions of the last month, at risk first (goals.ts).
    if (url.pathname === "/api/goals") {
      if (req.method !== "GET") return d.json(res, 405, { error: "Not allowed" }), true;
      const now = Date.now();
      const sessions = await sessionsFor(ctx.workspace.id, ctx.me, now - 30 * 86_400_000);
      const goals: TrackedGoal[] = rankGoals(sessions.flatMap((s) => goalsIn(s.state, s.events, now).filter((g) => !g.by || g.by === ctx.me.id)));
      const named = new Set(goals.map((g) => g.where.sid));
      const invites = Object.fromEntries(sessions.flatMap((s) => (named.has(s.state.id) ? ((t) => (t ? [[s.state.id, t] as const] : []))(d.invite(s.state, ctx.me.id)) : [])));
      return d.json(res, 200, { goals, invites }), true;
    }
    const wid = ctx.workspace.id;
    const uid = ctx.me.id;
    const had = await kept.settings(wid, uid);
    const settings = had ?? { ...DEFAULT_SETTINGS, tz: cleanZone(url.searchParams.get("tz")) };
    // Counted among those the clock looks at from their first look, with the defaults in the zone their page is in.
    if (!had) await kept.setSettings(wid, uid, settings);
    if (url.pathname === "/api/brief/settings") {
      if (req.method === "PUT") {
        const next = cleanSettings(await d.readJson(req), settings);
        await kept.setSettings(wid, uid, next);
        return d.json(res, 200, { settings: next }), true;
      }
      return d.json(res, 200, { settings }), true;
    }
    if (url.pathname === "/api/brief/latest" && req.method === "GET") {
      const l = await kept.latest(wid, uid);
      return d.json(res, 200, { brief: l?.brief ?? null, settings }), true;
    }
    if (url.pathname === "/api/brief" && req.method === "GET") {
      const until = Date.now();
      const asked = Number(url.searchParams.get("since"));
      const since = asked > 0 ? Math.max(until - 7 * 86_400_000, Math.min(asked, until)) : briefSince("now", until, await kept.lastUntil(wid, uid), settings);
      const brief = await build(wid, ctx.me, "now", since, until, settings.tz);
      return d.json(res, 200, { brief, since, settings }), true;
    }
    return false;
  };

  return { handle, tick, build, store: kept };
}
