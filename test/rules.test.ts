// Rules that stick (src/rules.ts, brain.ts offerRule/putRule/rules; Arun, 2026-11-03).
import assert from "node:assert/strict";
import { test } from "node:test";
import { addedLines, breaches, breachText, draftRule, globMatch, parseDraft, ruleWords, STANDING } from "../src/rules.js";
import { BrainRegistry } from "../src/brain.js";
import type { Redis } from "ioredis";

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

test("a person's correction becomes a rule when the words make it plain, and plain asks don't", () => {
  assert.deepEqual(draftRule("use pnpm not npm"), { rule: "Use pnpm, not npm.", check: { how: "runs", pattern: "(?:^|[\\s;&|(])npm(?=\\s|$)" } });
  assert.equal(draftRule("Use dayjs instead of moment")?.check.how, "lines", "a package: the imports, not the commands");
  assert.deepEqual(draftRule("no more console.logs in the code"), { rule: "No `console.log` in the code.", check: { how: "lines", pattern: "\\bconsole\\.log\\b" } });
  assert.equal(draftRule("never use `any`")?.check.pattern, "(?::\\s*|<|\\bas\\s+)any\\b", "the type, not the word");
  assert.deepEqual(draftRule("never edit generated/")?.check, { how: "paths", pattern: "generated/" });
  assert.deepEqual(draftRule("don't touch db/migrations")?.check, { how: "paths", pattern: "db/migrations/" });
  assert.equal(draftRule("please fix the login bug"), null);
  assert.equal(draftRule("always run the tests"), null, "a rule, but not one the words make checkable: a model may draft it");
  assert.ok(STANDING.test("always run the tests") && STANDING.test("from now on use the staging db") && !STANDING.test("fix the login bug"));
});

test("a rule reads lines a change adds, the commands its agent ran, or the files it touched", () => {
  const patch = "@@ -1,3 +1,5 @@\n a\n+console.log(x)\n b\n-gone\n+ok\n+  console.log(y)";
  assert.deepEqual(addedLines(patch), [{ n: 2, text: "console.log(x)" }, { n: 4, text: "ok" }, { n: 5, text: "  console.log(y)" }]);
  const files = [
    { path: "src/a.ts", status: "modified" as const, patch },
    { path: "src/a.test.ts", status: "modified" as const, patch: "@@ -0,0 +1 @@\n+console.log(1)" },
    { path: "generated/api.ts", status: "added" as const, patch: "@@ -0,0 +1 @@\n+x" },
  ];
  const lines = { how: "lines" as const, pattern: "\\bconsole\\.log\\b", except: ["*.test.ts"] };
  assert.deepEqual(breaches(lines, files, []).map((b) => b.where), ["src/a.ts:2", "src/a.ts:5"], "not the test file it leaves out");
  assert.deepEqual(breaches({ how: "paths", pattern: "generated/" }, files, []), [{ where: "generated/api.ts", what: "added" }]);
  assert.deepEqual(breaches({ how: "runs", pattern: "(?:^|[\\s;&|(])npm(?=\\s|$)" }, [], ["pnpm install", "cd web && npm run build", "npm i"]).map((b) => b.what), ["cd web && npm run build", "npm i"]);
  assert.deepEqual(breaches({ how: "lines", pattern: "(" }, files, []), [], "a pattern that isn't one breaks nothing");
  assert.ok(globMatch("*.test.ts", "src/a.test.ts") && globMatch("src/**", "src/x/y.ts") && globMatch("db/migrations", "db/migrations/1.sql") && !globMatch("src/*.ts", "src/x/y.ts"));
  assert.equal(ruleWords(lines), "No line a change adds may match \\bconsole\\.log\\b (except *.test.ts)");
  assert.match(breachText([{ rule: "No `console.log` in the code.", check: lines, breaches: breaches(lines, files, []) }]), /breaks a rule this repo keeps[\s\S]*Rule: No `console\.log`[\s\S]*- src\/a\.ts:2: console\.log\(x\)/);
});

test("a model's draft is taken only in the shape asked for", () => {
  assert.deepEqual(parseDraft('Sure: {"rule": "Never commit .env files.", "how": "paths", "pattern": ".env, .env.*"}'), { rule: "Never commit .env files.", check: { how: "paths", pattern: ".env, .env.*" } });
  assert.equal(parseDraft("{}"), null);
  assert.equal(parseDraft('{"rule": "x", "how": "lines", "pattern": "("}'), null, "not a regular expression");
  assert.equal(parseDraft('{"rule": "x", "how": "shell", "pattern": "rm"}'), null);
});

test("project memory keeps a rule offered once, kept or edited by a person, and lists only kept ones to check", async () => {
  const b = new BrainRegistry(fakeRedis(), "t:");
  const repo = "github.com/ada/shop";
  const offered = await b.offerRule(repo, "shop", { text: "No `console.log` in the code.", check: { how: "lines", pattern: "\\bconsole\\.log\\b" } }, { tool: "person", name: "Ada" }, { sid: "s1", lane: "main" });
  assert.equal(offered?.check?.state, "proposed");
  assert.equal(offered?.check?.command, "No line a change adds may match \\bconsole\\.log\\b");
  assert.equal(await b.offerRule(repo, "shop", { text: "No console.log please.", check: { how: "lines", pattern: "\\bconsole\\.log\\b" } }, { tool: "person", name: "Ada" }, { sid: "s2", lane: "main" }), null, "never offered twice");
  assert.deepEqual(await b.rules(repo), [], "nothing checked until it's kept");
  await b.answerCheck(repo, offered!.id, true, "Ada");
  assert.deepEqual((await b.rules(repo)).map((r) => r.check.pattern), ["\\bconsole\\.log\\b"]);
  assert.deepEqual(await b.checks(repo), [], "and it isn't a command to run");
  const edited = await b.putRule(repo, "shop", { id: offered!.id, text: "No console.log outside scripts.", check: { how: "lines", pattern: "\\bconsole\\.log\\b", except: ["scripts/"] } }, { id: "u", name: "Ada" });
  assert.deepEqual([edited.text, edited.check?.except, edited.check?.state], ["No console.log outside scripts.", ["scripts/"], "added"]);
  await assert.rejects(b.putRule(repo, "shop", { text: "Bad one", check: { how: "lines", pattern: "(" } }, { id: "u", name: "Ada" }), /isn't a regular expression/);
  await b.checkRan(repo, offered!.id, true);
  assert.equal((await b.list(repo)).find((e) => e.id === offered!.id)?.check?.caught, 1, "it says what it caught");
});
