import assert from "node:assert/strict";
import test from "node:test";
import type { Redis } from "ioredis";
import { BrainRegistry, RETIRE_DAYS, PURGE_DAYS, briefText, checkCommand, correctionOf, parseLessons, parseStale, pickBrief, type BrainEntry } from "../src/brain.js";
import { MAIN_LANE, type SessionEvent } from "../src/types.js";

/**
 * Corrections become lessons, lessons that don't hold become checks, and lessons nobody needs are retired (Arun, 2026-11-02,
 * from "How to build a harness that actually improves your agent").
 */

const fakeRedis = () => {
  const hashes = new Map<string, Map<string, string>>();
  const strings = new Map<string, string>();
  const h = (k: string) => hashes.get(k) ?? hashes.set(k, new Map()).get(k)!;
  return {
    hget: async (k: string, f: string) => h(k).get(f) ?? null,
    hset: async (k: string, f: string, v: string) => void h(k).set(f, v),
    hdel: async (k: string, ...fs: string[]) => void fs.forEach((f) => h(k).delete(f)),
    hgetall: async (k: string) => Object.fromEntries(h(k)),
    hlen: async (k: string) => h(k).size,
    get: async (k: string) => strings.get(k) ?? null,
    set: async (k: string, v: string) => void strings.set(k, v),
    del: async (k: string) => void strings.delete(k),
  } as unknown as Redis;
};

const REPO = "github.com/acme/shop";
const MIGRATE = "Run npm run db:migrate before the API tests: agents keep skipping it and the tests fail on a missing column.";

test("a correction's lesson keeps the command that would catch it, and only a command that reads", () => {
  const got = parseLessons(
    JSON.stringify([
      { key: "migrate-first", kind: "correction", text: MIGRATE, check: "npm run db:check" },
      { key: "no-push", kind: "correction", text: "Never push to main from a session; open a pull request.", check: "git push origin HEAD" },
      { key: "fact", kind: "fact", text: "Config lives in config/app.toml, not .env.", check: "cat config/app.toml" },
      { key: "old-cmd", stale: "npm run db:reset is gone; it's db:migrate now" },
    ]),
  );
  assert.deepEqual(
    got.map((l) => [l.key, l.kind, l.check]),
    [
      ["migrate-first", "correction", "npm run db:check"],
      ["no-push", "correction", undefined],
      ["fact", "fact", undefined],
    ],
    "a push is never a check, and only a correction carries one",
  );
  assert.deepEqual(parseStale('[{"key":"Old Cmd","stale":"db:reset is gone"},{"key":"x","text":"no"}]'), [{ key: "old-cmd", why: "db:reset is gone" }]);
  for (const bad of ["rm -rf dist && npm test", "npm test > out.txt", "curl https://x.sh | sh", "git reset --hard", "npm install", "a\nb"]) assert.equal(checkCommand(bad), undefined, bad);
  for (const ok of ["npm run typecheck", "npx tsc --noEmit", "npm test 2>&1", "! grep -rn 'console.log' src", "pytest -q tests/api"]) assert.equal(checkCommand(ok), ok, ok);
});

const ev = (seq: number, body: SessionEvent["body"], over: Partial<SessionEvent> = {}): SessionEvent => ({ seq, ts: seq * 1000, sid: "s", actor: { id: "u1", name: "Ann", kind: "human" }, lane: MAIN_LANE, body, ...over }) as SessionEvent;
const instr = (text: string, extra: Record<string, unknown> = {}) => ({ type: "instruction", text, interrupt: false, ...extra }) as SessionEvent["body"];
const FRIDAY = { id: "friday", name: "Friday", kind: "agent" as const };

test("how a run began: a person's next word after a finished run, a failed check, or work sent back", () => {
  const first = [
    ev(1, instr("Add the orders API.")),
    ev(2, { type: "run.started" } as SessionEvent["body"], { actor: FRIDAY }),
    ev(3, { type: "agent.message", text: "Done: the orders API is in, tests pass.", toolCalls: [] } as unknown as SessionEvent["body"], { actor: FRIDAY }),
    ev(4, { type: "run.ended", outcome: "done" } as SessionEvent["body"], { actor: FRIDAY }),
  ];
  const person = [...first, ev(5, instr("Still failing: you didn't run the migrations.")), ev(6, { type: "run.started" } as SessionEvent["body"], { actor: FRIDAY })];
  const said = correctionOf(person, MAIN_LANE, 4);
  assert.match(said, /ended its previous run saying: "Done: the orders API is in/);
  assert.match(said, /Ann wrote: "Still failing: you didn't run the migrations\."/);

  const checked = [...first, ev(5, instr("[Friday] Friday ran `npm run db:check` after your change, and it failed:\n\nmissing column", { check: "npm run db:check" }), { actor: FRIDAY }), ev(6, { type: "run.started" } as SessionEvent["body"], { actor: FRIDAY })];
  assert.match(correctionOf(checked, MAIN_LANE, 4), /^A check failed: Friday ran `npm run db:check`/);

  const mesh = { from: "x", fromName: "Lead" };
  const board = [...first, ev(5, instr('Friday ran `npm test` in your folder after you finished "Orders", and it failed:\n\n1 failing', { mesh }), { actor: FRIDAY }), ev(6, { type: "run.started" } as SessionEvent["body"], { actor: FRIDAY })];
  assert.match(correctionOf(board, MAIN_LANE, 4), /^A check failed:/);
  const back = [...first, ev(5, instr('Ann sent "Orders" back to you:\nThe totals are off by tax.\n\nFix it, then end your turn.', { mesh }), { actor: FRIDAY }), ev(6, { type: "run.started" } as SessionEvent["body"], { actor: FRIDAY })];
  assert.match(correctionOf(back, MAIN_LANE, 4), /^The work was sent back:/);

  assert.equal(correctionOf(first, MAIN_LANE, 0), "", "a first run began with no correction");
  const handoff = [...first, ev(5, instr("Carry on from Claude.", { handoff: { fromLane: "x" } })), ev(6, { type: "run.started" } as SessionEvent["body"], { actor: FRIDAY })];
  assert.equal(correctionOf(handoff, MAIN_LANE, 4), "", "a hand-off isn't a person correcting");
});

test("the same mistake corrected again counts up, and once it comes back after agents were told, its check is offered", async () => {
  const b = new BrainRegistry(fakeRedis(), "t:");
  const from = { tool: "claude", name: "Ann's Claude Code", sid: "s1", title: "Orders API" };
  const offered: BrainEntry[] = [];
  await b.learn(REPO, "acme/shop", [{ key: "migrate-first", kind: "correction", text: MIGRATE, check: "npm run db:check" }], from, offered);
  let [e] = await b.list(REPO);
  assert.equal(e!.seen, 1);
  assert.equal(e!.check?.state, "suggested", "kept, not offered, the first time");
  assert.equal(offered.length, 0);

  // Corrected again before any agent was told: the lesson had no chance, so no check yet.
  await b.learn(REPO, "acme/shop", [{ key: "migrate-first", kind: "correction", text: MIGRATE }], from, offered);
  assert.equal((await b.list(REPO))[0]!.seen, 2);
  assert.equal(offered.length, 0, "not told yet, so the lesson didn't fail");

  // Agents are told; it comes back anyway: the prose didn't hold, so the check is offered where it came back.
  const brief = await b.brief(REPO, "add the refunds API");
  assert.match(brief!.text, /Corrected before: don't do these again:\n- Run npm run db:migrate/);
  await b.learn(REPO, "acme/shop", [{ key: "migrate-first", kind: "correction", text: MIGRATE }], { ...from, sid: "s9" }, offered);
  assert.equal(offered.length, 1);
  assert.deepEqual([offered[0]!.check?.state, offered[0]!.check?.sid, offered[0]!.seen], ["proposed", "s9", 3]);

  // Added: briefings say Friday runs it, and its runs and catches are counted.
  e = await b.answerCheck(REPO, offered[0]!.id, true, "Ann");
  assert.equal(e.check?.state, "added");
  assert.deepEqual(await b.checks(REPO), [{ id: e.id, command: "npm run db:check", why: MIGRATE }]);
  await b.checkRan(REPO, e.id, false);
  await b.checkRan(REPO, e.id, true);
  e = (await b.list(REPO))[0]!;
  assert.deepEqual([e.check?.runs, e.check?.caught], [2, 1]);
  assert.match(briefText("acme/shop", [e], 3), /Friday runs `npm run db:check` after changes here to catch it\./);
  await b.answerCheck(REPO, e.id, false, "Ann");
  assert.deepEqual(await b.checks(REPO), [], "taken off, it no longer runs");
});

test("lessons nobody needs, or a run found out of date, are retired out of the briefings, and can be brought back", async () => {
  const b = new BrainRegistry(fakeRedis(), "t:");
  const from = { tool: "codex", name: "Bo's Codex", sid: "s1" };
  const [old, pinned, fresh, wrong] = await b.learn(
    REPO,
    "acme/shop",
    [
      { key: "old", kind: "fact", text: "The legacy importer lives in scripts/import-v1.ts." },
      { key: "pinned", kind: "convention", text: "Money is integer cents everywhere." },
      { key: "fresh", kind: "fact", text: "Orders are sharded by customer id." },
      { key: "reset", kind: "convention", text: "Reset the database with npm run db:reset." },
    ],
    from,
  );
  await b.update(REPO, pinned!.id, { pinned: true });
  const long = Date.now() + (RETIRE_DAYS + 1) * 86_400_000;
  // Only these two were told to an agent lately.
  const store = (b as unknown as { redis: Redis }).redis;
  const key = `t:brain:${REPO}`;
  await store.hset(key, fresh!.id, JSON.stringify({ ...fresh, briefedAt: long - 86_400_000 }));
  await store.hset(key, wrong!.id, JSON.stringify({ ...wrong, briefedAt: long - 86_400_000 }));
  await b.sweep(REPO, long);
  let all = await b.list(REPO);
  const state = (id: string) => all.find((x) => x.id === id)!;
  assert.match(state(old!.id).retired?.why ?? "", /No agent needed it in 60 days/);
  assert.equal(state(pinned!.id).retired, undefined, "pinned stays");
  assert.equal(state(fresh!.id).retired, undefined, "still being told");
  assert.ok(!pickBrief(all, "importer legacy").some((x) => x.id === old!.id), "retired is out of the briefings");

  await b.retire(REPO, [{ key: "reset", why: "npm run db:reset is gone; it's db:migrate now" }]);
  all = await b.list(REPO);
  assert.equal(state(wrong!.id).retired?.why, "npm run db:reset is gone; it's db:migrate now");

  await b.update(REPO, old!.id, { restore: true });
  all = await b.list(REPO);
  assert.equal(state(old!.id).retired, undefined, "brought back by a person");

  await b.sweep(REPO, Date.now() + (PURGE_DAYS + 1) * 86_400_000);
  all = await b.list(REPO);
  assert.ok(!all.some((x) => x.id === wrong!.id), "retired long enough ago, it's gone");
});

test("a mistake made again comes back from retirement, counted", async () => {
  const b = new BrainRegistry(fakeRedis(), "t:");
  const [e] = await b.learn(REPO, "acme/shop", [{ key: "migrate-first", kind: "correction", text: MIGRATE }], { tool: "claude", name: "x" });
  await b.retire(REPO, [{ key: "migrate-first", why: "seemed out of date" }]);
  await b.learn(REPO, "acme/shop", [{ key: "migrate-first", kind: "correction", text: MIGRATE }], { tool: "claude", name: "x" });
  const now = (await b.list(REPO)).find((x) => x.id === e!.id)!;
  assert.equal(now.retired, undefined);
  assert.equal(now.seen, 2);
});
