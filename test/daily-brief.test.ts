// The daily brief and standup (daily-brief.ts): what it collects, what counts as at risk, when it goes in each time zone, and
// that a quiet day makes none (Arun, 2026-10-31: Friday as the intelligence layer for productivity and management).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Redis } from "ioredis";
import { createApp } from "../src/app.js";
import { briefDue, briefSince, cleanSettings, collectBrief, DEFAULT_SETTINGS, wallClock, zonedAt, type BriefInput, type CrewInput } from "../src/daily-brief.js";
import { localKV } from "../src/local/kv.js";
import { NO_MODELS } from "../src/local/no-models.js";
import { SessionStore } from "../src/session/store.js";
import { MAIN_LANE, type EventBody } from "../src/types.js";

const maya = { id: "u-maya", name: "Maya Chen" };
const agent = (name: string) => ({ id: "agent", name, kind: "agent" }) as const;
const person = { ...maya, kind: "human" } as const;
const MIN = 60_000;
const H = 60 * MIN;

async function storeFor(t: test.TestContext) {
  const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  const prefix = `mpatest:${Math.random().toString(36).slice(2, 10)}:`;
  t.after(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  });
  const store = new SessionStore(redis, prefix);
  const add = (sid: string, body: EventBody, lane = MAIN_LANE, who: { id: string; name: string; kind: "agent" | "human" | "system" } = agent("Claude Code")) => store.append(sid, who, body, { lane }).then((r) => (r as { seq: number }).seq);
  /** A turn: what it was given, what it said, how it ended. */
  const turn = async (sid: string, said: string, o: { text?: string; outcome?: "done" | "error"; error?: string; end?: boolean; lane?: string } = {}) => {
    const lane = o.lane ?? MAIN_LANE;
    const given = await add(sid, { type: "instruction", text: o.text ?? "Go on", interrupt: false }, lane, person);
    await add(sid, { type: "run.started", causedBy: given }, lane);
    await add(sid, { type: "instructions.delivered", seqs: [given] }, lane);
    if (said) await add(sid, { type: "agent.message", text: said, toolCalls: [] }, lane);
    if (o.end !== false) await add(sid, { type: "run.ended", outcome: o.outcome ?? "done", ...(o.error ? { error: o.error } : {}) }, lane);
  };
  const session = async (sid: string, title: string, options: Record<string, unknown> = {}) => {
    await store.create(sid, title, { ...maya, role: "owner" }, options, "w1");
    return sid;
  };
  const read = async (...sids: string[]) => Promise.all(sids.map(async (sid) => ({ state: await store.state(sid), events: await store.events(sid) })));
  return { store, add, turn, session, read };
}

const base = (o: Partial<BriefInput> & Pick<BriefInput, "sessions">): BriefInput => ({ me: maya.id, kind: "morning", since: Date.now() - H, until: Date.now() + MIN, tz: "UTC", ...o });

// ── Time ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("times are the person's: Tokyo, New York across the clock change, and the day around midnight", () => {
  assert.equal(zonedAt("2026-11-02", "08:30", "Asia/Tokyo"), Date.UTC(2026, 10, 1, 23, 30), "08:30 in Tokyo is 23:30 UTC the day before");
  assert.equal(zonedAt("2026-10-31", "08:30", "America/New_York"), Date.UTC(2026, 9, 31, 12, 30), "EDT, UTC-4");
  assert.equal(zonedAt("2026-11-02", "08:30", "America/New_York"), Date.UTC(2026, 10, 2, 13, 30), "EST, UTC-5, after the clocks go back");
  assert.equal(wallClock(Date.UTC(2026, 10, 1, 23, 30), "Asia/Tokyo").day, "2026-11-02");
  assert.equal(wallClock(Date.UTC(2026, 10, 1, 23, 30), "Nowhere/Atlantis").day, "2026-11-01", "an unknown zone is UTC");
});

test("the scheduled brief: due at its time in the person's zone, within its grace, not when it is off", () => {
  const tokyo = { ...DEFAULT_SETTINGS, tz: "Asia/Tokyo" };
  const at = Date.UTC(2026, 10, 1, 23, 30);
  assert.equal(briefDue(tokyo, at - MIN), null, "a minute early: nothing (yesterday's evening is 14h back, past its grace)");
  assert.deepEqual(briefDue(tokyo, at + 5 * MIN), { kind: "morning", slot: "2026-11-02 morning", at }, "the morning one, in Tokyo's day");
  assert.equal(briefDue(tokyo, at + 3 * H + MIN), null, "three hours late is too late: opening Friday brings it instead");
  assert.equal(briefDue({ ...tokyo, morning: null }, at + 5 * MIN), null, "morning off");
  const evening = zonedAt("2026-11-02", "18:00", "Asia/Tokyo");
  assert.equal(briefDue(tokyo, evening + 2 * MIN)?.kind, "evening");
  assert.equal(briefDue({ ...tokyo, evening: null }, evening + 2 * MIN), null, "evening off");
  // Late in the evening: just after midnight, yesterday's is still the one due.
  const late = { ...DEFAULT_SETTINGS, evening: "23:30", tz: "America/New_York" };
  assert.deepEqual(briefDue(late, zonedAt("2026-11-03", "00:10", late.tz))?.slot, "2026-11-02 evening");
  // New York's morning the day the clocks go back.
  assert.equal(briefDue({ ...DEFAULT_SETTINGS, tz: "America/New_York" }, Date.UTC(2026, 10, 1, 13, 35))?.slot, "2026-11-01 morning");
});

test("where a brief starts: the last one's end, else the evening before or this morning, never more than 36 hours back", () => {
  const s = { ...DEFAULT_SETTINGS, tz: "Europe/London" };
  const morning = zonedAt("2026-11-03", "08:30", s.tz);
  assert.equal(briefSince("morning", morning, null, s), zonedAt("2026-11-02", "18:00", s.tz));
  assert.equal(briefSince("evening", zonedAt("2026-11-03", "18:00", s.tz), null, s), morning);
  assert.equal(briefSince("morning", morning, morning - 2 * H, s), morning - 2 * H, "from the last one");
  assert.equal(briefSince("morning", morning, morning - 5 * 86_400_000, s), morning - 36 * H, "a long weekend: the scheduled one stops at 36h");
  assert.equal(briefSince("now", morning, morning - 3 * 86_400_000, s), morning - 3 * 86_400_000, "on demand: back to the last one, a week at most");
  assert.equal(briefSince("now", morning, null, s), zonedAt("2026-11-03", "00:00", s.tz), "on demand with none before: today");
});

test("settings are checked: a bad time keeps the old one, null turns it off, an unknown zone is UTC", () => {
  const s = cleanSettings({ morning: "7:99", evening: null, tz: "Mars/Olympus", notify: false });
  assert.deepEqual(s, { morning: "08:30", evening: null, tz: "UTC", notify: false });
  assert.equal(cleanSettings({ morning: "07:15" }, s).morning, "07:15");
  assert.equal(cleanSettings({ morning: "07:15" }, s).evening, null, "what wasn't sent stays");
});

// ── What it collects ──────────────────────────────────────────────────────────────────────────────────────────────────────

test("an empty day makes no brief: nothing done, at risk, planned or waiting", async (t) => {
  const { session, turn, read } = await storeFor(t);
  await session("s-old", "Old work");
  await turn("s-old", "Done long ago.");
  // The stretch starts after all of it.
  assert.equal(collectBrief(base({ sessions: await read("s-old"), since: Date.now() + 1, until: Date.now() + 2 })), null);
  // A tool's usage alone isn't a brief, even a window nearly full.
  assert.equal(collectBrief(base({ sessions: [], limits: [{ tool: "claude", windows: [{ kind: "five_hour", usedPercent: 98, resetsAt: null }] }] })), null);
});

test("a busy day: done across Code and Work sessions with PRs, at risk, today's plan, decisions waiting and today's tokens", async (t) => {
  const { session, turn, add, read } = await storeFor(t);
  const since = Date.now() - MIN;
  // Code: a result and a pull request it opened.
  await session("s-checkout", "Checkout fix");
  await turn("s-checkout", "**Fixed the double charge** on retry.\n\nDetails…");
  await add("s-checkout", { type: "folder.committed", sha: "abc", branch: "fix/charge", message: "Fix the double charge", files: 3, pushed: true, prUrl: "https://github.com/acme/shop/pull/41", prCreated: true });
  await add("s-checkout", { type: "agent.usage", tool: "claude", input: 1200, cached: 90_000, output: 300 });
  // Work: a result, and a second turn the same day (counted as turns, one line).
  await session("s-copy", "Acme launch copy", { work: true });
  await turn("s-copy", "Drafted the launch email.");
  await turn("s-copy", "Tightened the subject line.");
  // A PR opened earlier and merged since: told once.
  await session("s-api", "Rate limiter");
  await add("s-api", { type: "folder.committed", sha: "def", branch: "feat/rl", message: "Rate limiter", files: 2, pushed: true, prUrl: "https://github.com/acme/shop/pull/39", prCreated: true });
  // At risk: a usage limit overnight, and an error.
  await session("s-limit", "Search index");
  await turn("s-limit", "", { outcome: "error", error: "You've hit your usage limit · resets 3pm" });
  await session("s-error", "Migrations");
  await turn("s-error", "", { outcome: "error", error: "ENOENT: no such file, open 'db/schema.sql'" });
  // A blocked board task.
  await session("s-board", "Billing page");
  await add("s-board", { type: "board.posted", fromLane: MAIN_LANE, fromName: "Claude Code", tasks: [{ id: "t1", title: "Wire the invoice API", detail: "", owns: [], after: [] }, { id: "t2", title: "Style the table", detail: "", owns: [], after: [] }] });
  await add("s-board", { type: "board.claimed", id: "t1", lane: MAIN_LANE, name: "Claude Code" });
  await add("s-board", { type: "board.finished", id: "t1", lane: MAIN_LANE, name: "Claude Code", status: "blocked", report: "Needs the Stripe test key" });
  // Running now, and work queued behind it.
  await session("s-run", "Onboarding tour");
  await turn("s-run", "Looking at the tour steps", { text: "Add a skip button to the tour", end: false });
  await add("s-run", { type: "instruction", text: "Then write tests for it", interrupt: false }, MAIN_LANE, person);
  // A question waiting on Maya.
  await session("s-ask", "Pricing page");
  await turn("s-ask", "", { end: false });
  await add("s-ask", { type: "agent.question", callId: "c1", question: "Monthly or yearly first?", to: maya.id, toName: maya.name });
  const sessions = await read("s-checkout", "s-copy", "s-api", "s-limit", "s-error", "s-board", "s-run", "s-ask");
  const b = collectBrief(base({ since, sessions, prs: { "https://github.com/acme/shop/pull/39": "merged", "https://github.com/acme/shop/pull/41": "open" }, limits: [{ tool: "claude", windows: [{ kind: "five_hour", usedPercent: 86, resetsAt: null }, { kind: "seven_day", usedPercent: 40, resetsAt: null }] }] }))!;
  assert.ok(b, "a brief");
  const doneIn = (sid: string) => b.done.filter((d) => d.where.sid === sid);
  assert.equal(doneIn("s-checkout")[0]?.text, "Fixed the double charge on retry.", "its first line, plain");
  assert.deepEqual(doneIn("s-checkout")[0]?.pr, { url: "https://github.com/acme/shop/pull/41", state: "opened" });
  assert.equal(doneIn("s-copy").length, 1, "one line per session");
  assert.equal(doneIn("s-copy")[0]?.turns, 2);
  assert.equal(doneIn("s-copy")[0]?.where.kind, "work");
  assert.equal(doneIn("s-api")[0]?.pr?.state, "merged", "merged since");
  assert.equal(collectBrief(base({ since, sessions, prs: { "https://github.com/acme/shop/pull/39": "merged" }, toldMerged: new Set(["https://github.com/acme/shop/pull/39"]) }))!.done.find((d) => d.where.sid === "s-api")?.pr?.state, "opened", "and not told as merged twice");
  const riskOf = (kind: string) => b.risk.filter((r) => r.kind === kind);
  assert.match(riskOf("limit")[0]?.text ?? "", /hit its usage limit in Search index/);
  assert.match(riskOf("error")[0]?.text ?? "", /Migrations: ENOENT/);
  assert.match(riskOf("blocked")[0]?.text ?? "", /Wire the invoice API.*Stripe test key/);
  assert.match(riskOf("usage")[0]?.text ?? "", /^is at 86% of its 5-hour window/);
  assert.equal(riskOf("usage")[0]?.who, "Claude Code");
  assert.deepEqual(b.plan.find((p) => p.where?.sid === "s-run" && p.source === "running")?.text, "Add a skip button to the tour");
  assert.match(b.plan.find((p) => p.where?.sid === "s-run" && p.source === "queued")?.text ?? "", /Then write tests for it/);
  assert.ok(b.plan.some((p) => p.where?.sid === "s-board" && p.source === "left" && p.who === "Billing page" && p.text === "has 1 more task on the board"), "what is left on a board");
  assert.equal(b.decisions.count, 1);
  assert.equal(b.plan.some((p) => p.where?.sid === "s-ask"), false, "waiting on Maya is a decision, not work under way");
  assert.equal(b.decisions.top[0]?.text.includes("Monthly or yearly first?"), true);
  const claude = b.usage.find((u) => u.tool === "claude")!;
  assert.equal(claude.tokens, 1500, "input and output, not the cache reads");
  assert.deepEqual(claude.windows.map((w) => [w.label, w.used]), [["5-hour", 86], ["weekly", 40]]);
  assert.match(b.headline, /done \(2 PRs\).*at risk.*1 decision waiting/);
});

test("a turn quiet for half an hour mid-run is stalled; a limit that reset and carried on is no longer at risk", async (t) => {
  const { session, turn, read } = await storeFor(t);
  await session("s1", "Long refactor");
  await turn("s1", "Starting", { text: "Split the router", end: false });
  const [s1] = await read("s1");
  const at = Date.now();
  assert.equal(collectBrief(base({ sessions: [s1!], until: at + 10 * MIN }))?.risk.length, 0, "ten minutes is working");
  const later = collectBrief(base({ sessions: [s1!], since: at - H, until: at + 45 * MIN }))!;
  assert.match(later.risk[0]!.text, /quiet for 45m mid-turn in Long refactor/);
  assert.equal(later.risk[0]!.kind, "stalled");
  await session("s2", "Search index");
  await turn("s2", "", { outcome: "error", error: "You've hit your usage limit" });
  await turn("s2", "Rebuilt the index.");
  const b = collectBrief(base({ sessions: await read("s2") }))!;
  assert.equal(b.risk.length, 0, "it carried on after the reset");
  assert.equal(b.done[0]?.text, "Rebuilt the index.");
});

test("the Crew: teammates' work and proof, a room gone quiet, check-ins later today, and no double-up with the Away brief", async (t) => {
  const { session, turn, add, read } = await storeFor(t);
  const since = Date.now() - MIN;
  await session("s-team", "Crew", { team: true });
  // A room is a team session in the open-source edition: told as a room by its place, not by that.
  await session("s-room", "Acme launch", { team: true });
  // Nova finishes a board task in the room, its check passed.
  await add("s-room", { type: "board.posted", fromLane: "l-nova", fromName: "Nova", tasks: [{ id: "a", title: "Write the FAQ", detail: "", owns: [], after: [] }, { id: "b", title: "Pricing table", detail: "", owns: [], after: [] }] });
  await turn("s-room", "Wrote the FAQ.", { lane: "l-nova" });
  await add("s-room", { type: "board.checked", id: "a", lane: "l-nova", command: "npm test -- faq", ok: true, output: "" });
  await add("s-room", { type: "board.finished", id: "a", lane: "l-nova", name: "Nova", status: "done", report: "Done" });
  // Kit, in the Crew's own room, stopped short.
  await turn("s-team", "", { lane: "l-kit", text: "Fix the Safari bug", outcome: "error", error: "spawn claude ENOENT" });
  const crew = (places: Awaited<ReturnType<typeof read>>): CrewInput => ({
    places: [
      { sid: "s-team", room: null, events: places[0]!.events, lanes: { nova: "l-nova", kit: "l-kit" } },
      { sid: "s-room", room: "Acme launch", events: places[1]!.events, lanes: { nova: "l-nova" } },
    ],
    mates: [
      { id: "nova", name: "Nova", lane: "l-nova", look: "nova-1", checkins: [{ id: "c1", text: "What's left for launch?", every: "daily", at: "23:59", days: [], tz: "UTC" }] },
      { id: "kit", name: "Kit", lane: "l-kit" },
    ],
  });
  let sessions = await read("s-team", "s-room");
  const b = collectBrief(base({ since, sessions, crew: crew(sessions) }))!;
  const nova = b.done.find((d) => d.who === "Nova")!;
  assert.equal(nova.text, "Write the FAQ");
  assert.equal(nova.proof, "npm test -- faq passed", "its check is its proof");
  assert.equal(nova.where.kind, "room");
  assert.equal(b.plan.find((p) => p.source === "left")?.where?.kind, "room");
  assert.deepEqual(nova.mate, { name: "Nova", look: "nova-1" });
  assert.match(b.risk.find((r) => r.who === "Kit")?.text ?? "", /didn't finish “Fix the Safari bug”/);
  if (wallClock(Date.now(), "UTC").hhmm < "23:59") assert.ok(b.plan.some((p) => p.source === "checkin" && p.who === "Nova" && p.at === "23:59"), "Nova's check-in later today");
  // Four hours on, nothing has moved in the room and a task is still open: it went quiet.
  const quiet = collectBrief(base({ since, until: Date.now() + 5 * H, sessions, crew: crew(sessions) }))!;
  assert.match(quiet.risk.find((r) => r.kind === "quiet")?.text ?? "", /Acme launch went quiet 5h ago with 2 tasks not done/);
  // The person was away and the Away brief told the night: one line for it, the crew's lines before it not again.
  const tb = { since, until: Date.now(), done: [{ lane: "l-nova", name: "Nova", title: "Write the FAQ" }], failed: [], waiting: [], assumptions: [], usage: [] };
  await add("s-team", { type: "team.brief", ...tb }, MAIN_LANE, { id: "friday", name: "Friday", kind: "system" });
  sessions = await read("s-team", "s-room");
  const after = collectBrief(base({ since, until: Date.now() + MIN, sessions, crew: crew(sessions) }))!;
  assert.equal(after.done.filter((d) => d.who === "Nova").length, 0, "Nova's FAQ was in the Away brief");
  assert.match(after.done.find((d) => d.who === "Crew")?.text ?? "", /While you were away: 1 done/);
  assert.equal(after.done.find((d) => d.who === "Crew")?.where.seq !== undefined, true, "it opens the Away brief");
});

// ── Both editions, end to end ─────────────────────────────────────────────────────────────────────────────────────────────

test("the open-source edition: /api/brief on demand, settings, and the morning brief at its time", async (t) => {
  process.env.FRIDAY_EDITION = "local";
  // Not this computer's own coding tools: their limits would be in the brief.
  process.env.FRIDAY_LOCAL_RUNNER = "0";
  const home = await mkdtemp(path.join(tmpdir(), "friday-brief-"));
  const kv = await localKV(home);
  const app = await createApp({ port: 0, redisUrl: "", prefix: "friday:", secret: "s", driverGraceMs: 15_000, llm: NO_MODELS, dataDir: path.join(home, "uploads"), local: { redis: kv.redis, sub: kv.sub, user: { id: "local", name: "Maya Chen" } } });
  t.after(async () => (delete process.env.FRIDAY_EDITION, delete process.env.FRIDAY_LOCAL_RUNNER, await app.close(), await kv.close(), await rm(home, { recursive: true, force: true })));
  const send = async (url: string, method = "GET", body?: unknown) => {
    const r = await fetch(`${app.url}${url}`, { method, headers: { "Content-Type": "application/json", "x-friday-local": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return (await r.json()) as Record<string, any>;
  };
  // Nothing yet: no brief, and the defaults in the page's zone.
  const first = await send("/api/brief?tz=Asia/Tokyo");
  assert.equal(first.brief, null);
  assert.deepEqual(first.settings, { morning: "08:30", evening: "18:00", tz: "Asia/Tokyo", notify: true });
  await app.store.create("s1", "Checkout fix", { id: "local", name: "Maya Chen", role: "owner" }, {}, "");
  const me = { id: "local", name: "Maya Chen", kind: "human" } as const;
  const given = (await app.store.append("s1", me, { type: "instruction", text: "Fix it", interrupt: false }) as { seq: number }).seq;
  await app.store.append("s1", agent("Claude Code"), { type: "run.started", causedBy: given });
  await app.store.append("s1", agent("Claude Code"), { type: "agent.message", text: "Fixed the double charge.", toolCalls: [] });
  await app.store.append("s1", agent("Claude Code"), { type: "run.ended", outcome: "done" });
  const now = await send("/api/brief");
  assert.equal(now.brief.done[0].text, "Fixed the double charge.");
  assert.equal(now.brief.kind, "now");
  // The morning brief at its time: a minute ago, in Tokyo.
  const at = Date.now() - MIN;
  const hhmm = wallClock(at, "Asia/Tokyo").hhmm;
  assert.equal((await send("/api/brief/settings", "PUT", { morning: hhmm, evening: null })).settings.morning, hhmm);
  await app.briefs.tick();
  const latest = await send("/api/brief/latest");
  assert.equal(latest.brief?.kind, "morning");
  assert.equal(latest.brief.done[0].text, "Fixed the double charge.");
  await app.briefs.tick();
  assert.equal((await send("/api/brief/latest")).brief.id, latest.brief.id, "once per slot");
});
