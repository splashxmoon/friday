import assert from "node:assert/strict";
import test from "node:test";
import type { Redis } from "ioredis";
import { BUILTIN_COMMANDS, CommandError, CommandRegistry, cleanName } from "../src/commands.js";
import { COMMANDS } from "../src/client/Shortcuts.js";

const fakeRedis = () => {
  const hashes = new Map<string, Map<string, string>>();
  const h = (k: string) => hashes.get(k) ?? hashes.set(k, new Map()).get(k)!;
  return {
    hget: async (k: string, f: string) => h(k).get(f) ?? null,
    hset: async (k: string, f: string, v: string) => void h(k).set(f, v),
    hdel: async (k: string, ...fs: string[]) => void fs.forEach((f) => h(k).delete(f)),
    hgetall: async (k: string) => Object.fromEntries(h(k)),
  } as unknown as Redis;
};
const ann = { id: "ann", name: "Ann" };
const bo = { id: "bo", name: "Bo" };
const fails = (p: Promise<unknown>, status: number, re: RegExp) => assert.rejects(p, (e: unknown) => e instanceof CommandError && e.status === status && re.test(e.message));

test("the reserved names are exactly the built-in commands the composer offers", () => {
  assert.deepEqual([...BUILTIN_COMMANDS].sort(), COMMANDS.map((c) => c.name).sort());
});

test("names are made safe to type", () => {
  assert.equal(cleanName("/Release Notes!"), "release-notes");
  assert.equal(cleanName("  --x--  "), "x");
  assert.equal(cleanName("a".repeat(60)).length, 30);
  assert.equal(cleanName("???"), "");
});

test("yours are yours; the workspace's are everyone's", async () => {
  const c = new CommandRegistry(fakeRedis(), "t:");
  await c.save(ann, { name: "mine", text: "Do my thing" });
  await c.save(ann, { name: "release", text: "Write the release notes our way", scope: "workspace" });
  assert.deepEqual((await c.list("ann")).map((x) => x.name), ["mine", "release"]);
  assert.deepEqual((await c.list("bo")).map((x) => x.name), ["release"]);
});

test("it needs a name and words, and cannot take a built-in's name", async () => {
  const c = new CommandRegistry(fakeRedis(), "t:");
  await fails(c.save(ann, { name: "", text: "x" }), 400, /name/);
  await fails(c.save(ann, { name: "x", text: "   " }), 400, /what it should say/);
  await fails(c.save(ann, { name: "/Test", text: "x" }), 400, /built-in/);
});

test("a name is one thing for the person typing it", async () => {
  const c = new CommandRegistry(fakeRedis(), "t:");
  await c.save(ann, { name: "ship", text: "Ship it", scope: "workspace" });
  await fails(c.save(bo, { name: "ship", text: "Other" }), 409, /Ann already shared/);
  await fails(c.save(ann, { name: "ship", text: "Again" }), 409, /already have/);
  // Somebody else's private one doesn't get in the way.
  await c.save(ann, { name: "private", text: "A" });
  await c.save(bo, { name: "private", text: "B" });
});

test("only whoever saved it can change or delete it, and a changed one keeps its place", async () => {
  const c = new CommandRegistry(fakeRedis(), "t:");
  const saved = await c.save(ann, { name: "ship", text: "Ship it", scope: "workspace" });
  await fails(c.save(bo, { id: saved.id, name: "ship", text: "Hijacked", scope: "workspace" }), 403, /Only Ann/);
  await fails(c.remove("bo", saved.id), 403, /Only Ann/);
  const edited = await c.save(ann, { id: saved.id, name: "ship-it", text: "Ship it carefully", scope: "workspace" });
  assert.equal(edited.id, saved.id);
  assert.deepEqual((await c.list("bo")).map((x) => [x.name, x.text]), [["ship-it", "Ship it carefully"]]);
  await c.remove("ann", saved.id);
  assert.deepEqual(await c.list("ann"), []);
  await fails(c.remove("ann", saved.id), 404, /already gone/);
});

test("the list line is the first words when none is given, and there is a limit", async () => {
  const c = new CommandRegistry(fakeRedis(), "t:");
  const s = await c.save(ann, { name: "long", text: "Check the pricing page for typos and broken links, then fix what you find and tell me what changed" });
  assert.ok(s.hint.length <= 80 && s.hint.startsWith("Check the pricing page"));
  for (let i = 0; i < 39; i++) await c.save(ann, { name: `c${i}`, text: "x" });
  await fails(c.save(ann, { name: "one-more", text: "x" }), 400, /40 commands/);
});
