// Code and Crew, connected, on this computer (ported to the open-source edition from Friday Teams test/crew-in-session.test.ts at
// cd68a6b5): a crew mate brought into a coding session as a lane with its role and memory, "@Rex" in the box, and a session's
// decisions offered to a crew mate's memory.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { laneAt } from "../src/client/lane-at.js";
import { roleHint, visitKeep, visitNote, visitRefusal, type Visit } from "../src/crew-code.js";
import { decisionsOf, memoryLine, offerNow, withDecisions } from "../src/decision-memory.js";
import { handedCleared, initialState, type SessionState } from "../src/session/projection.js";
import { MAIN_LANE, type EventBody } from "../src/types.js";

process.env.FRIDAY_TEAMMATES_DRY = "1";
process.env.FRIDAY_EDITION = "local";

// ── The rules ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("decisions: read from the session's memory, offered once a crew mate's run is over, added to a memory once each", () => {
  const memory = [
    { key: "left-off", text: "where we were" },
    { key: "decision:12", text: "Decided (Ada Lovelace): keep the old /cart endpoint." },
    { key: "decision:4", text: "Decided (Bea Barnes): totals come from the server." },
    { key: "decision:9", text: "" },
  ];
  const ds = decisionsOf(memory);
  assert.deepEqual(ds.map((d) => d.key), ["decision:4", "decision:12"], "oldest first; one taken back left out");
  assert.deepEqual(offerNow(ds, [], { running: true, ended: 3 }), []);
  assert.deepEqual(offerNow(ds, [], { running: false, ended: 0 }), []);
  assert.deepEqual(offerNow(ds, ["decision:4"], { running: false, ended: 1 }).map((d) => d.key), ["decision:12"]);
  assert.deepEqual(offerNow(ds, ["decision:4", "decision:12"], { running: false, ended: 1 }), []);
  assert.equal(memoryLine(ds[0]!), "- Decided (Bea Barnes): totals come from the server.");
  const one = withDecisions("Ada likes small PRs.", ds, 6000)!;
  assert.equal(one.added, 2);
  assert.equal(one.next, "Ada likes small PRs.\n- Decided (Bea Barnes): totals come from the server.\n- Decided (Ada Lovelace): keep the old /cart endpoint.\n");
  assert.deepEqual(withDecisions(one.next, ds, 6000), { next: one.next, added: 0 });
  assert.equal(withDecisions("x".repeat(5990), ds, 6000), null);
});

const place = (more: Partial<SessionState> = {}): SessionState => {
  const s = initialState("s1");
  s.ownerId = "local";
  s.members = { local: { name: "Me", role: "owner" } } as unknown as SessionState["members"];
  return Object.assign(s, more);
};

test("a crew mate into a coding session: one the person may steer, once, never a crew room; its note says where and with whom", () => {
  const kit = { id: "m1", name: "Kit" };
  const s = place();
  assert.equal(visitRefusal(s, "local", kit, [], true), null);
  assert.equal(visitRefusal(null, "local", kit, [], true), "That session isn't there any more.");
  assert.equal(visitRefusal(place({ options: { ...s.options, team: true } }), "local", kit, [], true), "Crew rooms bring crew mates in from their own menu.");
  assert.equal(visitRefusal(s, "someone", kit, [], true), "You can't add agents to this session.");
  assert.equal(visitRefusal(s, "local", kit, [], false), "You can't add agents to this session.");
  const here: Visit = { mate: "m1", sid: "s1", lane: "l1", at: 1 };
  assert.equal(visitRefusal(place({ lanes: [{ id: "l1" } as SessionState["lanes"][number]] }), "local", kit, [here], true), "Kit is already in this session.");
  // Its lane gone (taken out from the session's menu): it may come in again.
  assert.equal(visitRefusal(s, "local", kit, [here], true), null);
  assert.equal(visitKeep("m1", "s1"), "m1.visit.s1");
  const note = visitNote({ name: "Kit", role: "Finishes what's left and gets the tests green." }, "Claude Code", { title: "Checkout rewrite", with: ["Codex", "Rex"] }, { file: "/u/Friday/teammates/Kit/MEMORY.md", text: "Ada likes small PRs.", how: "Add to it as you go" });
  assert.match(note, /^You are Kit, one of the person's AI crew mates in Friday, running on their Claude Code on their own computer\. They brought you into the coding session "Checkout rewrite" with Codex, Rex/);
  assert.match(note, /Your role, in their words: Finishes what's left/);
  assert.match(note, /Work in the session's folder and on its branch/);
  assert.match(note, /Your memory is \/u\/Friday\/teammates\/Kit\/MEMORY\.md/);
  assert.match(note, /What it holds now:\nAda likes small PRs\.$/);
  assert.doesNotMatch(note, /—|–/);
  // Brought in for a hand-off: its own copy, its own branch, never the session's folder.
  const copy = visitNote({ name: "Kit" }, "Codex", { title: "Checkout", with: [], copy: { path: "/w/kit", branch: "friday/kit" } }, { file: "/m", text: "", how: "Add to it as you go" });
  assert.match(copy, /a copy of the session's folder of your own, \/w\/kit, on the branch friday\/kit/);
  assert.match(copy, /It is empty so far\.$/);
  assert.equal(roleHint("Finishes what's left and gets the tests green."), "Finishes what's left…");
});

test("@Rex in a session's box: the agent named first, the longest name, whole names only, then a space or a comma", () => {
  const lanes = [
    { id: MAIN_LANE, name: "Claude Code" },
    { id: "l2", name: "Claude Code 2" },
    { id: "l3", name: "Rex" },
  ];
  assert.deepEqual(laneAt("@Rex review this diff", lanes), { lane: "l3", text: "review this diff" });
  assert.deepEqual(laneAt("  @rex, review this diff", lanes), { lane: "l3", text: "review this diff" });
  assert.deepEqual(laneAt("@Claude Code 2 run the tests", lanes), { lane: "l2", text: "run the tests" });
  assert.deepEqual(laneAt("@Claude Code: run the tests", lanes), { lane: MAIN_LANE, text: "run the tests" });
  assert.deepEqual(laneAt("@Rex ", lanes), { lane: "l3", text: "" });
  assert.equal(laneAt("@Rex", lanes), null);
  assert.equal(laneAt("@Rexford review this", lanes), null);
  assert.equal(laneAt("as @Rex said, review this", lanes), null);
  assert.deepEqual(laneAt("@Rex check:\n- the totals", lanes), { lane: "l3", text: "check:\n- the totals" });
});

// ── On this computer ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function local(t: { after: (f: () => Promise<void>) => void }) {
  const { createApp } = await import("../src/app.js");
  const { localKV } = await import("../src/local/kv.js");
  const { NO_MODELS } = await import("../src/local/no-models.js");
  const home = await mkdtemp(path.join(tmpdir(), "friday-crew-code-"));
  const kv = await localKV(home);
  const app = await createApp({ port: 0, redisUrl: "", prefix: "friday:", secret: "s", driverGraceMs: 15_000, llm: NO_MODELS, dataDir: path.join(home, "uploads"), local: { redis: kv.redis, sub: kv.sub, user: { id: "local", name: "Me" } }, teammatesHome: home });
  t.after(async () => (await app.close(), await kv.close(), await rm(home, { recursive: true, force: true })));
  type Body = { sid: string; teammates: { id: string; name: string; lane: string }[]; visits?: { sid: string; lane: string; mate: string }[]; visit?: { lane: string; started: boolean }; offered?: string[]; added?: number; error?: string };
  const send = async (url: string, method = "GET", body?: unknown) => {
    const r = await fetch(`${app.url}${url}`, { method, headers: { "Content-Type": "application/json", "x-friday-local": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: (await r.json()) as Body };
  };
  // A coding session of the person's, its agent working in a folder of theirs.
  const repo = path.join(home, "shop");
  await mkdir(repo, { recursive: true });
  const me = { id: "local", name: "Me" };
  await app.store.create("code1", "Checkout rewrite", { ...me, role: "owner" }, {}, "");
  await app.store.append("code1", { ...me, kind: "human" }, { type: "engine.attached", engine: { hostId: "local", hostName: "Me", cwd: repo, mode: "full", tool: "codex" } } as EventBody);
  return { app, home, repo, me, send };
}

test("Bring in a crew mate: Kit as a lane of the coding session, in its folder, with its role and memory, the person's to drive; taken out, Kit is untouched", async (t) => {
  const { app, home, repo, send } = await local(t);
  const made = await send("/api/teammates", "POST", { name: "Kit", role: "Finishes what's left.", tool: "claude", folder: path.join(home, "Kit") });
  assert.equal(made.status, 200, made.body.error);
  const kit = made.body.teammates[0]!;
  const r = await send(`/api/teammates/${kit.id}/visit`, "POST", { sid: "code1" });
  assert.equal(r.status, 200, r.body.error);
  const lane = r.body.visit!.lane;
  const st = await app.store.state("code1");
  const l = st.lanes.find((x) => x.id === lane);
  assert.equal(l?.name, "Kit");
  assert.deepEqual(l?.control, { kind: "people", people: ["local"] }, "the person's to drive");
  // Started in the session's folder, with a conversation of its own there, its own folder beside it for its memory.
  const start = app.teammates.starts.at(-1)!;
  assert.deepEqual([start.sid, start.lane, start.keepAs, start.cwd, start.dirs], ["code1", lane, `${kit.id}.visit.code1`, repo, [path.join(home, "Kit")]]);
  assert.deepEqual(r.body.visits, [{ sid: "code1", lane, mate: kit.id }]);
  // Its note there: who, where, with whom, its role and its memory.
  const note = (await app.teammates.note("code1", lane)) ?? "";
  assert.match(note, /brought you into the coding session "Checkout rewrite" with Codex/);
  assert.match(note, /Your role, in their words: Finishes what's left\./);
  // Not twice.
  assert.equal((await send(`/api/teammates/${kit.id}/visit`, "POST", { sid: "code1" })).status, 409);
  // Taken out: its lane goes, Kit and its Crew lane stay.
  const out = await send(`/api/teammates/${kit.id}/visit?sid=code1`, "DELETE");
  assert.equal(out.status, 200, out.body.error);
  assert.equal((await app.store.state("code1")).lanes.some((x) => x.id === lane), false);
  assert.deepEqual(out.body.visits, []);
  assert.equal(out.body.teammates[0]!.id, kit.id);
});

test("a crew mate's lane taken out from the session's own menu takes its record with it", async (t) => {
  const { app, home, me, send } = await local(t);
  const kit = (await send("/api/teammates", "POST", { name: "Kit", tool: "claude", folder: path.join(home, "Kit") })).body.teammates[0]!;
  const lane = (await send(`/api/teammates/${kit.id}/visit`, "POST", { sid: "code1" })).body.visit!.lane;
  assert.equal((await app.core.handle("code1", me, { type: "lane.remove", laneId: lane })).ok, true);
  for (let i = 0; i < 50 && (await send("/api/teammates")).body.visits?.length; i++) await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual((await send("/api/teammates")).body.visits, []);
});

test("Remember these for Kit? on this computer: a decision in a session Kit works in goes into its MEMORY.md on a yes alone, each once", async (t) => {
  const { app, home, me, send } = await local(t);
  const made = (await send("/api/teammates", "POST", { name: "Kit", tool: "claude", folder: path.join(home, "Kit") })).body;
  const kit = made.teammates[0]!;
  const r = await app.core.handle(made.sid, me, { type: "say", text: "Ship the refund fix behind a flag." });
  assert.ok(r.ok);
  assert.equal((await app.core.handle(made.sid, me, { type: "decide", seq: r.seq, on: true })).ok, true);
  const key = `decision:${r.seq}`;
  assert.deepEqual((await send(`/api/teammates/${kit.id}/remember?sid=${made.sid}`)).body.offered, []);
  assert.equal((await send(`/api/teammates/${kit.id}/remember?sid=code1`)).status, 404, "only where Kit works");
  const yes = await send(`/api/teammates/${kit.id}/remember`, "POST", { sid: made.sid, keys: [key], keep: true });
  assert.deepEqual([yes.status, yes.body.added, yes.body.offered], [200, 1, [key]]);
  assert.equal(await readFile(path.join(home, "Kit", "MEMORY.md"), "utf8"), "- Decided (Me): Ship the refund fix behind a flag.\n");
  assert.equal((await send(`/api/teammates/${kit.id}/remember`, "POST", { sid: made.sid, keys: [key], keep: true })).body.added, 0);
  // In a coding session it was brought into, too; a no only marks them offered.
  await send(`/api/teammates/${kit.id}/visit`, "POST", { sid: "code1" });
  const said = await app.core.handle("code1", me, { type: "say", text: "Totals come from the server." });
  assert.ok(said.ok);
  await app.core.handle("code1", me, { type: "decide", seq: said.seq, on: true });
  const no = await send(`/api/teammates/${kit.id}/remember`, "POST", { sid: "code1", keys: [`decision:${said.seq}`], keep: false });
  assert.deepEqual([no.status, no.body.added, no.body.offered], [200, 0, [`decision:${said.seq}`]]);
  assert.doesNotMatch(await readFile(path.join(home, "Kit", "MEMORY.md"), "utf8"), /server/);
});

// ── Keep this going (crew-carry.ts) ──────────────────────────────────────────────────────────────────────────────────────────

test("keep this going: the rules, the line and the brief", async () => {
  const { askLine, carryRows, handBrief, handedSub, laneState, mentionHandOff, progressLine, rankMates, resultLine, cleanAsk, cleanCarry, finisherFrom, prsIn, bringBrief, roomLine, ownOutcome } = await import("../src/crew-carry-rules.js");
  assert.equal(askLine(["pr", "merge"], "Ada Lovelace"), "asks Ada before PR and merge");
  assert.equal(askLine(["pr", "merge", "commands"], "Ada"), "asks Ada before PR, merge and any command");
  assert.deepEqual(cleanAsk(undefined), ["pr", "merge"]);
  assert.deepEqual(cleanAsk(["commands", "pr", "nope"]), ["pr", "commands"]);
  assert.deepEqual(cleanCarry({ conversation: true }), { leftOff: true, branch: true, question: true, conversation: true });
  assert.deepEqual(carryRows({ open: 1, decided: 0, files: 0, turns: 2 }).map((r) => r.line), ["Where we left off: 1 still open", "The whole conversation"]);
  assert.deepEqual(carryRows({ open: 0, decided: 2, branch: "fix/cart", files: 3, question: "Keep it?", turns: 0 }).map((r) => r.line), ["Where we left off: 2 decisions", "The branch and 3 uncommitted files", "The open question: Keep it?"]);
  const brief = handBrief({ title: "Fix the cart total", by: "Ada Lovelace", note: "", leftOff: "## Still open\n- npm test last failed", branch: { name: "fix/cart", files: ["a.ts"], copied: true }, ask: ["pr", "merge"] });
  assert.match(brief, /^Carry on with "Fix the cart total"\./);
  assert.match(brief, /Ada Lovelace handed this on from the session "Fix the cart total"\. Your result goes back there\./);
  assert.match(brief, /Your copy starts from the branch fix\/cart: carry on from there, on your own branch\./);
  assert.match(brief, /The uncommitted changes in 1 file came with it: a\.ts\./);
  assert.match(brief, /Ask Ada before opening a pr, merging\.$/);
  assert.deepEqual(mentionHandOff("@kit finish the tax table", ["Kit", "Checkout"]), { name: "Kit", words: "finish the tax table" });
  assert.equal(mentionHandOff("as @Kit said", ["Kit"]), null);
  assert.equal(mentionHandOff("@Kit", ["Kit"]), null);
  assert.deepEqual(rankMates("review the diff", [{ name: "Kit", role: "Finishes" }, { name: "Rex", role: "Reviews diffs" }]).map((m) => m.name), ["Rex", "Kit"]);
  assert.equal(finisherFrom({ tool: "codex", folder: "/r", taken: ["Finisher"] }).name, "Finisher 2");
  assert.equal(ownOutcome({ connected: true, label: "your computer" }), "Starts now on your computer");
  assert.equal(roomLine("Kit", 3), "Kit takes it, with 2 more");
  // How its work stands, from its lane.
  assert.equal(laneState({ running: false, asks: false, started: false, online: false }), "queued");
  assert.equal(laneState({ running: false, asks: false, started: false, online: true }), "asked");
  assert.equal(laneState({ running: true, asks: false, started: true, online: true }), "running");
  assert.equal(laneState({ running: true, asks: true, started: true, online: true }), "input");
  assert.equal(laneState({ running: false, asks: false, started: true, ended: "done", online: true }), "done");
  assert.equal(laneState({ running: false, asks: false, started: true, ended: "error", online: true }), "ended");
  const h = { mateName: "Kit", state: "running", since: 0, done: 2, of: 3, by: { id: "local", name: "Me" }, carried: ["1 still open"], ask: ["pr", "merge"] };
  assert.equal(progressLine(h, 18 * 60_000, "local"), "Kit working · 2 of 3 done · 18m");
  assert.equal(progressLine({ ...h, state: "queued" }, 0, "local"), "Kit starts when your computer is back");
  assert.equal(progressLine({ ...h, back: "back" as const }, 0, "local"), "Me took this back");
  assert.equal(handedSub(h), "1 still open · asks Me before PR and merge");
  assert.equal(resultLine({ said: "", files: 3, added: 12, removed: 4, prs: [] }), "3 files +12 −4");
  assert.deepEqual(prsIn("Opened https://github.com/a/b/pull/12 and https://github.com/a/b/pull/12."), ["https://github.com/a/b/pull/12"]);
  const bring = bringBrief({ who: "Kit", said: "Tax rounds per line.", branch: "friday/kit-1", files: 2, by: "Me", take: ["a.ts"], conflicts: ["a.ts"], about: "Checkout" });
  assert.match(bring, /^\[Friday\] Me brought Kit's finished work back to this session \(on the branch `friday\/kit-1`, 2 files changed\)\./);
  assert.match(bring, /Bring in these files only, and nothing else from it:\n- a\.ts/);
  assert.match(bring, /These are changed here too/);
});

test("keep this going on this computer: Kit takes the rest in a thread of its own on its page, in a copy of the folder, never a lane here; the line keeps up, its result comes back, Take it back and Bring it in", async (t) => {
  const { app, home, me, send } = await local(t);
  const kit = (await send("/api/teammates", "POST", { name: "Kit", role: "Finishes what a session leaves open.", tool: "claude", folder: path.join(home, "Kit") })).body.teammates[0]!;
  const agent = { id: "engine:local", name: "Codex", kind: "agent" as const };
  await app.store.append("code1", { ...me, kind: "human" }, { type: "instruction", text: "Fix the cart total", interrupt: false, attachments: [] });
  await app.store.append("code1", agent, { type: "run.started", causedBy: 3 } as EventBody);
  await app.store.append("code1", agent, { type: "agent.message", text: "The cart total is fixed. The tax test still fails.", toolCalls: [] } as EventBody);
  await app.store.append("code1", agent, { type: "run.ended", outcome: "done" });
  type Sheet = { lane: string; own: { id: string; name: string; line: string }[]; rooms: unknown[]; carry: { open: number }; finisher: unknown; handed: unknown; error?: string };
  const call = async <T,>(url: string, method = "GET", body?: unknown) => {
    const r = await fetch(`${app.url}${url}`, { method, headers: { "Content-Type": "application/json", "x-friday-local": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: (await r.json()) as T & { error?: string } };
  };
  const sheet = await call<Sheet>("/api/sessions/code1/keep-going");
  assert.equal(sheet.status, 200, sheet.body.error);
  assert.deepEqual([sheet.body.lane, sheet.body.own.map((m) => m.name), sheet.body.own[0]!.line, sheet.body.finisher, sheet.body.handed], [MAIN_LANE, ["Kit"], "Starts now on your computer", null, null]);
  // Handed: a thread of Kit's own on its page, named for the session, in a copy of the session's folder of its own, what's
  // uncommitted carried in; told the work there. This session gets no lane of Kit's (Arun, 2026-11-16).
  const lanesBefore = (await app.store.state("code1")).lanes.length;
  const handed = await call<{ job: { id: string; lane: string; sid: string; thread: string } }>("/api/sessions/code1/keep-going", "POST", { mate: kit.id, note: "finish the tax table", carry: {}, ask: ["pr", "merge"] });
  assert.equal(handed.status, 200, handed.body.error);
  const job = handed.body.job;
  assert.notEqual(job.sid, "code1");
  assert.equal((await app.store.state("code1")).lanes.length, lanesBefore, "no lane of Kit's in the coding session");
  const thread = (await app.teammates.rooms()).find((r) => r.id === job.thread)!;
  assert.deepEqual([thread.thread, thread.sid, thread.lanes[kit.id], thread.name, thread.work?.from, thread.work?.carry], [kit.id, job.sid, job.lane, "Checkout rewrite", "code1", true]);
  const start = app.teammates.starts.at(-1)!;
  assert.deepEqual([start.sid, start.lane, start.worktree, start.copyName, start.carry, start.keepAs], [job.sid, job.lane, "lane", "Kit", true, `${kit.id}.${thread.id}`]);
  assert.equal(start.cwd, thread.work?.cwd, "the session's own folder, copied");
  const told = (await app.store.events(job.sid)).findLast((e) => e.lane === job.lane && e.body.type === "instruction");
  assert.match(told?.body.type === "instruction" ? told.body.text : "", /^finish the tax table\n\n\(Me handed this on from the session "Checkout rewrite"\. Your result goes back there\.\)/);
  let st = await app.store.state("code1");
  const h = st.handed?.[job.id];
  assert.deepEqual([h?.mateName, h?.lane, h?.jobLane, h?.jobSid, h?.thread, h?.ask, h?.note], ["Kit", MAIN_LANE, job.lane, job.sid, job.thread, ["pr", "merge"], "finish the tax table"]);
  // Open goes to that thread.
  const opened = await call<{ sid: string; lane: string; mate: string; thread: string }>(`/api/sessions/code1/keep-going/${job.id}`);
  assert.deepEqual([opened.body.sid, opened.body.lane, opened.body.mate, opened.body.thread], [job.sid, job.lane, kit.id, job.thread]);
  // The line keeps up: Kit working, then done with what it said and changed.
  const kitBot = { id: `engine:local`, name: "Kit", kind: "agent" as const };
  await app.store.append(job.sid, kitBot, { type: "run.started", causedBy: told!.seq } as EventBody, { lane: job.lane });
  const until = async (ok: () => Promise<boolean>, what: string) => {
    for (let i = 0; i < 100; i++, await new Promise((r) => setTimeout(r, 30))) if (await ok()) return;
    throw new Error(`timed out: ${what}`);
  };
  await until(async () => (await app.store.state("code1")).handed?.[job.id]?.state === "running", "running");
  await app.store.append(job.sid, kitBot, { type: "agent.message", text: "The tax table rounds per line now. Tests green: https://github.com/a/b/pull/7", toolCalls: [] } as EventBody, { lane: job.lane });
  await app.store.append(job.sid, kitBot, { type: "run.ended", outcome: "done" }, { lane: job.lane });
  await until(async () => (await app.store.state("code1")).handed?.[job.id]?.state === "done", "done");
  st = await app.store.state("code1");
  assert.match(st.handed![job.id]!.result!.said, /^The tax table rounds per line now/);
  assert.deepEqual(st.handed![job.id]!.result!.prs, ["https://github.com/a/b/pull/7"]);
  // Bring it in: a look first, the piece handed from here first, then into this session's agent's lane.
  type Pieces = { pieces: { key: string; relation: string; from: string; what: string }[] };
  const look = await call<Pieces>(`/api/sessions/code1/keep-going?bringFrom=${encodeURIComponent(`mate:${kit.id}`)}`);
  assert.equal(look.status, 200, look.body.error);
  assert.deepEqual([look.body.pieces[0]!.relation, look.body.pieces[0]!.from], ["handed", "Kit, handed from here"]);
  // Everything finished, from every crew mate and room at once (over the box): the same piece, with whose it is for its mascot.
  type All = { pieces: { key: string; relation: string; who?: { name: string } }[] };
  const everything = await call<All>(`/api/sessions/code1/keep-going?bringFrom=all`);
  assert.equal(everything.status, 200, everything.body.error);
  assert.deepEqual(((p) => [p?.key, p?.relation, p?.who?.name])(everything.body.pieces[0]), [look.body.pieces[0]!.key, "handed", "Kit"]);
  const brought = await call<{ ok: boolean }>(`/api/sessions/code1/keep-going?bringFrom=${encodeURIComponent(`mate:${kit.id}`)}`, "POST", { keys: [look.body.pieces[0]!.key] });
  assert.equal(brought.status, 200, brought.body.error);
  const after = await app.store.events("code1");
  assert.ok(after.some((e) => (e.lane ?? MAIN_LANE) === MAIN_LANE && e.body.type === "instruction" && /brought Kit's finished work back to this session/.test(e.body.text)));
  assert.equal((await app.store.state("code1")).handed![job.id]!.back, "brought");
  // Brought in, it isn't offered again, from Kit or from everything, until there is newer work.
  assert.ok(after.some((e) => e.body.type === "crew.brought" && e.body.pieces[0]?.key === look.body.pieces[0]!.key));
  assert.equal((await call<All>(`/api/sessions/code1/keep-going?bringFrom=all`)).body.pieces.length, 0);
  assert.equal((await call<Pieces>(`/api/sessions/code1/keep-going?bringFrom=${encodeURIComponent(`mate:${kit.id}`)}`)).body.pieces.length, 0);
  // Again: a new thread of its own. Then Take it back: the lane's own again, its line cleared, and the person's words given back.
  const again = await call<{ job: { id: string; lane: string; sid: string; thread: string } }>("/api/sessions/code1/keep-going", "POST", { mate: kit.id, note: "and the receipts" });
  assert.equal(again.status, 200, again.body.error);
  assert.notEqual(again.body.job.thread, job.thread, "a thread of its own for each hand-off");
  assert.equal((await call("/api/sessions/code1/keep-going", "POST", { mate: kit.id })).status, 409, "already on it");
  const back = await call<{ ok: boolean; note: string }>(`/api/sessions/code1/keep-going/${again.body.job.id}/back`, "POST", { how: "back" });
  assert.equal(back.status, 200, back.body.error);
  assert.equal(back.body.note, "and the receipts", "what was written, for the box");
  const cleared = (await app.store.state("code1")).handed![again.body.job.id]!;
  assert.equal(cleared.back, "back");
  assert.ok(handedCleared(cleared), "its line leaves the chat");
  assert.ok(!handedCleared((await app.store.state("code1")).handed![job.id]!), "one brought in keeps its line");
  // Taken back twice is still once.
  assert.equal((await call<{ note: string }>(`/api/sessions/code1/keep-going/${again.body.job.id}/back`, "POST", { how: "back" })).body.note, "and the receipts");
  assert.equal((await app.store.events("code1")).filter((e) => e.body.type === "crew.handed.back" && e.body.job === again.body.job.id).length, 1);

  // Dynamic: a hand-off's thread deleted takes its line away; Kit taken off the crew takes every one of its lines away.
  const third = await call<{ job: { id: string; thread: string } }>("/api/sessions/code1/keep-going", "POST", { mate: kit.id, note: "the refunds" });
  assert.equal((await send(`/api/teammates/rooms/${third.body.job.thread}`, "DELETE")).status, 200);
  assert.equal((await app.store.state("code1")).handed![third.body.job.id]!.back, "gone");
  assert.equal((await call(`/api/sessions/code1/keep-going/${third.body.job.id}`)).status, 404, "nothing to open");
  const fifth = await call<{ job: { id: string } }>("/api/sessions/code1/keep-going", "POST", { mate: kit.id, note: "the invoices" });
  assert.equal(fifth.status, 200, fifth.body.error);
  assert.equal((await send(`/api/teammates/${kit.id}`, "DELETE")).status, 200);
  const st2 = await app.store.state("code1");
  assert.equal(st2.handed![fifth.body.job.id]!.back, "gone");
  assert.equal(st2.handed![job.id]!.back, "gone", "finished and brought in: its line goes too, the work brought in stays in the chat");
  assert.ok((await app.store.events("code1")).some((e) => e.body.type === "instruction" && /brought Kit's finished work back/.test(e.body.text)));
  assert.equal((await call("/api/sessions/code1/keep-going", "POST", { mate: kit.id })).status, 404, "Kit isn't there to hand to");
});

test("keep this going to a crew room: posted there as the person's message to its lead, its line reads how the room stands", async (t) => {
  const { app, home, send } = await local(t);
  const kit = (await send("/api/teammates", "POST", { name: "Kit", tool: "claude", folder: path.join(home, "Kit") })).body.teammates[0]!;
  const room = await fetch(`${app.url}/api/teammates/rooms`, { method: "POST", headers: { "Content-Type": "application/json", "x-friday-local": "1" }, body: JSON.stringify({ name: "Checkout", members: [kit.id] }) }).then((r) => r.json() as Promise<{ room: string; rooms: { id: string; sid: string; lanes: Record<string, string> }[] }>);
  const r = room.rooms.find((x) => x.id === room.room)!;
  const call = async <T,>(url: string, method = "GET", body?: unknown) => {
    const res = await fetch(`${app.url}${url}`, { method, headers: { "Content-Type": "application/json", "x-friday-local": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json()) as T & { error?: string } };
  };
  const sheet = await call<{ rooms: { id: string; name: string; line: string }[] }>("/api/sessions/code1/keep-going");
  assert.deepEqual(sheet.body.rooms.map((x) => [x.name, x.line]), [["Checkout", "Kit takes it there"]]);
  const handed = await call<{ room: { id: string } }>("/api/sessions/code1/keep-going", "POST", { room: r.id, note: "take the rest of the tax work" });
  assert.equal(handed.status, 200, handed.body.error);
  const posted = (await app.store.events(r.sid)).findLast((e) => e.body.type === "instruction" && e.lane === r.lanes[kit.id]);
  assert.match(posted?.body.type === "instruction" ? posted.body.text : "", /^take the rest of the tax work/);
  type Now = { state: string; line: string; said: string; crew: { name: string; lead: boolean }[] };
  assert.deepEqual(((x) => [x.state, x.line])((await call<Now>(`/api/sessions/code1/keep-going?roomStatus=${r.id}`)).body), ["queued", "Kit hasn't started yet"]);
  const kitBot = { id: "engine:local", name: "Kit", kind: "agent" as const };
  await app.store.append(r.sid, kitBot, { type: "run.started", causedBy: posted!.seq } as EventBody, { lane: r.lanes[kit.id]! });
  await app.store.append(r.sid, kitBot, { type: "agent.message", text: "The tax table rounds per line now.\nMore.", toolCalls: [] } as EventBody, { lane: r.lanes[kit.id]! });
  await app.store.append(r.sid, kitBot, { type: "run.ended", outcome: "done" }, { lane: r.lanes[kit.id]! });
  const done = (await call<Now>(`/api/sessions/code1/keep-going?roomStatus=${r.id}`)).body;
  assert.deepEqual([done.state, done.line, done.said, done.crew[0]?.name], ["done", "Kit is done", "The tax table rounds per line now.", "Kit"]);
  // Its work back here, a look first.
  const look = await call<{ pieces: { key: string; relation: string }[] }>(`/api/sessions/code1/keep-going?bringFrom=${encodeURIComponent(`room:${r.id}`)}`);
  assert.equal(look.body.pieces[0]?.relation, "handed");
  assert.equal((await call(`/api/sessions/code1/keep-going?bringFrom=${encodeURIComponent(`room:${r.id}`)}`, "POST", { keys: [look.body.pieces[0]!.key] })).status, 200);
  assert.ok((await app.store.events("code1")).some((e) => e.body.type === "crew.handed.room.brought" && e.body.room === r.id));
  // Not offered twice; newer work from Kit in the room comes back, in everything finished too.
  const all = `/api/sessions/code1/keep-going?bringFrom=all`;
  assert.equal((await call<{ pieces: unknown[] }>(all)).body.pieces.length, 0);
  await new Promise((res) => setTimeout(res, 5));
  await app.store.append(r.sid, kitBot, { type: "run.started" } as EventBody, { lane: r.lanes[kit.id]! });
  await app.store.append(r.sid, kitBot, { type: "agent.message", text: "Receipts print the tax per line too.", toolCalls: [] } as EventBody, { lane: r.lanes[kit.id]! });
  await app.store.append(r.sid, kitBot, { type: "run.ended", outcome: "done" }, { lane: r.lanes[kit.id]! });
  const newer = (await call<{ pieces: { what: string; who?: { name: string } }[] }>(all)).body.pieces;
  assert.deepEqual(newer.map((p) => [p.what, p.who?.name]), [["Receipts print the tax per line too.", "Kit"]]);

  // Take it back before Kit reads it: its message in the room taken back, its line cleared, the words given back.
  const more = await call("/api/sessions/code1/keep-going", "POST", { room: r.id, note: "now the refunds" });
  assert.equal(more.status, 200);
  const morePosted = (await app.store.events(r.sid)).findLast((e) => e.body.type === "instruction" && e.lane === r.lanes[kit.id])!;
  const roomBack = await call<{ note: string }>(`/api/sessions/code1/keep-going?roomBack=${r.id}`, "POST", {});
  assert.equal(roomBack.status, 200, roomBack.body.error);
  assert.equal(roomBack.body.note, "now the refunds");
  assert.ok((await app.store.state(r.sid)).withdrawn.includes(morePosted.seq), "taken back in the room before it was read");
  assert.ok((await app.store.events("code1")).some((e) => e.body.type === "crew.handed.room.back" && e.body.room === r.id && e.body.how === "back"));
  // Handed again, then the room taken away: its line goes with it.
  assert.equal((await call("/api/sessions/code1/keep-going", "POST", { room: r.id, note: "the coupons" })).status, 200);
  assert.equal((await fetch(`${app.url}/api/teammates/rooms/${r.id}`, { method: "DELETE", headers: { "x-friday-local": "1" } })).status, 200);
  const last = (await app.store.events("code1")).findLast((e) => e.body.type === "crew.handed.room.back");
  assert.deepEqual(last?.body.type === "crew.handed.room.back" ? [last.body.room, last.body.how] : [], [r.id, "gone"]);
  assert.equal((await call(`/api/sessions/code1/keep-going?roomStatus=${r.id}`)).status, 404);
});
