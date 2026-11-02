import assert from "node:assert/strict";
import test from "node:test";
import type { Redis } from "ioredis";
import { BrainRegistry, briefText, parseLessons, pickBrief, repoKeyOf, type BrainEntry } from "../src/brain.js";

/** The hash and string commands the brain uses. */
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

test("the project brain: one key per repo, from its GitHub name, its remote, or its folder", () => {
  assert.deepEqual(repoKeyOf({ github: "Acme/Shop" }), { key: "github.com/acme/shop", name: "Acme/Shop" });
  assert.deepEqual(repoKeyOf({ url: "git@gitlab.com:team/api.git" }), { key: "gitlab.com/team/api", name: "team/api" });
  assert.deepEqual(repoKeyOf({ url: "https://user@bitbucket.org/team/web.git" }), { key: "bitbucket.org/team/web", name: "team/web" });
  assert.deepEqual(repoKeyOf(null, "C:\\Users\\a\\code\\shop-3f2a9c1d"), { key: "folder:shop", name: "shop" }, "a separate copy is the same project");
  assert.equal(repoKeyOf(null, ""), null);
});

test("the project brain: a briefing puts pinned first, then what the task's words touch, as far as the budget goes", () => {
  const e = (id: string, text: string, over: Partial<BrainEntry> = {}): BrainEntry => ({ id, key: id, text, kind: "fact", from: { tool: "claude", name: "Ann's Claude Code" }, at: Date.now() - 30 * 86_400_000, uses: 0, ...over });
  const all = [
    e("a", "The billing webhook retries three times before giving up."),
    e("b", "Run tests with npm run test:unit; the full suite needs Redis.", { kind: "convention" }),
    e("c", "Rate limiting in the API gateway was tried with a token bucket and dropped: it double-counted retries.", { kind: "pitfall" }),
    e("d", "Deploys go out from the deploy branch, never main.", { pinned: true }),
  ];
  const chosen = pickBrief(all, "add rate limiting to the gateway");
  assert.equal(chosen.length, 4);
  assert.deepEqual(chosen.map((x) => x.kind), ["pitfall", "convention", "fact", "fact"], "grouped by kind, so it reads as a briefing");
  const tight = pickBrief(all, "add rate limiting to the gateway", 160);
  assert.deepEqual(tight.map((x) => x.id).sort(), ["c", "d"], "pinned, then what the task is about");
  const text = briefText("acme/shop", chosen, 7);
  assert.match(text, /learned working on acme\/shop, from 7 earlier sessions/);
  assert.match(text, /Tried before, and why it didn't work:\n- Rate limiting/);
  assert.match(text, /the code is right/, "background, never above the code");
  assert.equal(briefText("x", [], 3), "");
});

test("the project brain: a run's answer becomes lessons, and only in the shape asked for", () => {
  const got = parseLessons('Here you go: [{"key":"Retry Bug","kind":"pitfall","text":"Retrying inside the transaction deadlocked under load."},{"kind":"weird","text":"Config lives in config/app.toml, not .env."},{"text":"short"}]');
  assert.deepEqual(got, [
    { key: "retry-bug", kind: "pitfall", text: "Retrying inside the transaction deadlocked under load." },
    { key: "config-lives-in-config-app-toml-not-env", kind: "decision", text: "Config lives in config/app.toml, not .env." },
  ]);
  assert.deepEqual(parseLessons("nothing worth keeping"), []);
  assert.deepEqual(parseLessons("[]"), []);
});

test("the project brain: learned twice is one entry kept current, briefings count their uses, and people can tend it", async () => {
  const b = new BrainRegistry(fakeRedis(), "t:");
  const from = { tool: "codex", name: "Bo's Codex", sid: "s1", title: "Fix checkout" };
  await b.learn("github.com/acme/shop", "acme/shop", [{ key: "deploy-branch", kind: "convention", text: "Deploys go out from the deploy branch." }], from);
  await b.learn("github.com/acme/shop", "acme/shop", [{ key: "deploy-branch", kind: "convention", text: "Deploys go out from the deploy branch, never main." }], { ...from, sid: "s2" });
  const list = await b.list("github.com/acme/shop");
  assert.equal(list.length, 1, "the same key is the same lesson");
  assert.equal(list[0]!.text, "Deploys go out from the deploy branch, never main.");
  const repos = await b.repos();
  assert.deepEqual(repos.map((r) => [r.name, r.count, r.sessions]), [["acme/shop", 1, 2]]);

  const brief = await b.brief("github.com/acme/shop", "ship the fix");
  assert.ok(brief && brief.count === 1 && brief.tools.includes("codex"));
  assert.equal((await b.list("github.com/acme/shop"))[0]!.uses, 1, "a briefing counts as a use");

  const mine = await b.add("github.com/acme/shop", "acme/shop", { text: "Never edit generated/ by hand.", kind: "convention" }, { id: "u1", name: "Ann" });
  assert.equal(mine.from.tool, "person");
  await b.update("github.com/acme/shop", mine.id, { pinned: true });
  assert.equal((await b.list("github.com/acme/shop"))[0]!.id, mine.id, "pinned first");
  await b.remove("github.com/acme/shop", mine.id);
  assert.equal((await b.list("github.com/acme/shop")).length, 1);

  assert.equal(await b.enabled(), true);
  await b.setEnabled(false);
  assert.equal(await b.enabled(), false);
  assert.equal(await new BrainRegistry(fakeRedis(), "t:").brief("github.com/none/here", "x"), null, "nothing learned, nothing to say");
});

test("the project brain never keeps a key or password: a run's lesson holding one is dropped, and a person's is refused", async () => {
  const b = new BrainRegistry(fakeRedis(), "t:");
  const key = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const kept = await b.learn("github.com/acme/api", "api", [{ key: "sandbox", kind: "fact", text: `The sandbox key is ${key}` }, { key: "cents", kind: "decision", text: "Money is integer cents." }], { tool: "claude", name: "Maya's Claude Code" });
  assert.deepEqual(kept.map((e) => e.key), ["cents"]);
  await assert.rejects(b.add("github.com/acme/api", "api", { text: `Use ${key} for tests` }, { id: "u", name: "Maya" }), /never keeps secrets/);
  await assert.rejects(b.update("github.com/acme/api", kept[0]!.id, { text: `Money is cents; key ${key}` }), /never keeps secrets/);
  assert.equal((await b.list("github.com/acme/api"))[0]!.text, "Money is integer cents.");
});
