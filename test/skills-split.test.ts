import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Redis } from "ioredis";
import { SkillRegistry } from "../src/skills.js";

const REDIS = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const ARUN = { id: "u-arun", name: "Arun" };

const skill = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Skill ${id}`,
  description: `Does ${id}`,
  instructions: `Instructions for ${id}`,
  icon: "book",
  keywords: [],
  resources: [{ name: "ref.md", text: "reference" }],
  ownerId: ARUN.id,
  ownerName: ARUN.name,
  sharing: { mode: "private", people: [] },
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

/**
 * Collections used to keep their skills in the same hash as your own, so every
 * visit to the skills page read all of them. The first use after the change
 * moves them out, once, without losing any.
 */
test("a collection saved the old way is moved out of the skills hash, whole, and only once", async (t) => {
  const prefix = `mpatest:${randomUUID().slice(0, 8)}:`;
  const redis = new Redis(REDIS);
  t.after(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });
  await redis.hset(`${prefix}skills`, "mine", JSON.stringify(skill("mine")));
  for (const id of ["a", "b", "c"]) await redis.hset(`${prefix}skills`, id, JSON.stringify(skill(id, { collectionId: "col1", source: { repo: "o/r", path: `x/${id}/SKILL.md` } })));
  await redis.hset(`${prefix}skill-collections`, "col1", JSON.stringify({ id: "col1", ownerId: ARUN.id, ownerName: ARUN.name, name: "o/r", repo: "o/r", path: "", createdAt: 1, updatedAt: 1 }));

  const reg = new SkillRegistry(redis, prefix);
  const list = await reg.listFor(ARUN.id);
  assert.deepEqual(list.map((s) => s.id), ["mine"], "your own skills stay where they were");
  assert.deepEqual((await reg.collectionsFor(ARUN.id)).map((c) => [c.name, c.count]), [["o/r", 3]]);
  assert.deepEqual(Object.keys(await redis.hgetall(`${prefix}skills`)), ["mine"], "the main hash no longer holds the collection's skills");

  const inside = await reg.collectionSkills(ARUN, "col1");
  assert.deepEqual(inside.skills.map((s) => s.path), ["x/a/SKILL.md", "x/b/SKILL.md", "x/c/SKILL.md"]);
  assert.match((await reg.collectionBrief("col1", "b", ARUN.id)) ?? "", /Instructions for b[\s\S]*reference/, "the full skill is still there to be fetched");

  // A second registry on the same data (a restart) changes nothing and loses nothing.
  const again = new SkillRegistry(redis, prefix);
  assert.equal((await again.collectionsFor(ARUN.id))[0]!.count, 3);
  assert.equal((await again.listFor(ARUN.id)).length, 1);
});
