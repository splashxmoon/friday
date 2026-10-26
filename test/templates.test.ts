import assert from "node:assert/strict";
import test from "node:test";
import type { Redis } from "ioredis";
import { fillSlots, slotsOf } from "../src/template-slots.js";
import { TemplateRegistry } from "../src/templates-store.js";

const fakeRedis = () => {
  const h = new Map<string, string>();
  return {
    hget: async (_k: string, f: string) => h.get(f) ?? null,
    hset: async (_k: string, f: string, v: string) => void h.set(f, v),
    hdel: async (_k: string, f: string) => void h.delete(f),
    hgetall: async () => Object.fromEntries(h),
  } as unknown as Redis;
};
const ann = { id: "ann", name: "Ann" };
const bo = { id: "bo", name: "Bo" };

test("blanks are found once each, in order, and filled by name", () => {
  const p = "Upgrade {{which dependency}} in {{ where }} and check {{which dependency}} again.";
  assert.deepEqual(slotsOf(p), ["which dependency", "where"]);
  assert.equal(fillSlots(p, { "which dependency": "react", where: "web/" }), "Upgrade react in web/ and check react again.");
});

test("a blank left empty stays visible, so it is not lost", () => {
  assert.equal(fillSlots("Fix {{the bug}} now", { "the bug": "  " }), "Fix {{the bug}} now");
  assert.deepEqual(slotsOf("no blanks here"), []);
});

test("shared templates are everyone's, private ones are the saver's, and only the saver deletes", async () => {
  const r = new TemplateRegistry(fakeRedis(), "t:");
  const shared = await r.create(ann, { label: "Release checklist", prompt: "Walk the release checklist for {{version}}", shared: true });
  await r.create(ann, { label: "Mine", prompt: "Only I use this prompt", shared: false });
  assert.deepEqual((await r.listFor("bo")).map((t) => t.label), ["Release checklist"]);
  assert.deepEqual((await r.listFor("ann")).map((t) => t.label), ["Mine", "Release checklist"]);
  await assert.rejects(r.remove(bo.id, shared.id), /Only Ann/);
  await r.remove("ann", shared.id);
  assert.equal((await r.listFor("bo")).length, 0);
});

test("a template needs a name and something to say", async () => {
  const r = new TemplateRegistry(fakeRedis(), "t:");
  await assert.rejects(r.create(ann, { label: " ", prompt: "long enough prompt" }), /name/);
  await assert.rejects(r.create(ann, { label: "x", prompt: "short" }), /prompt/);
});
