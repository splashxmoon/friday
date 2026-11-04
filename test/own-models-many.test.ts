import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("own models: several of one server added at once (issue #17): its key and address each, named after itself, none twice, never past the most", async (t) => {
  // runner/own-models.ts keeps them in ~/.friday/models.json: this test's, never the real one (USERPROFILE for Windows).
  const home = await mkdtemp(path.join(tmpdir(), "friday-own-many-"));
  const real = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, { HOME: home, USERPROFILE: home });
  t.after(async () => {
    for (const [k, v] of Object.entries(real)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
    await rm(home, { recursive: true, force: true });
  });
  const { addOwnModels, listOwnModels, saveOwnModel, MAX_OWN_MODELS } = await import("../src/runner/own-models.js");
  const base = "https://openrouter.ai/api/v1/";
  const key = "sk-or-v1-0123456789abcdef";

  await saveOwnModel({ provider: "openrouter", baseUrl: base, model: "anthropic/claude-sonnet-5-5", apiKey: key });
  const r = await addOwnModels({ provider: "openrouter", baseUrl: base, apiKey: key, models: ["anthropic/claude-sonnet-5-5", "openai/gpt-6.1-vision", "meta/llama-5-70b", "meta/llama-5-70b", " "] });
  assert.deepEqual(r.skipped, ["anthropic/claude-sonnet-5-5"], "one already saved for that address is left as it is");
  assert.deepEqual(r.added.map((m) => [m.name, m.model, m.provider, m.baseUrl, m.hasKey]), [
    ["openai/gpt-6.1-vision", "openai/gpt-6.1-vision", "openrouter", "https://openrouter.ai/api/v1", true],
    ["meta/llama-5-70b", "meta/llama-5-70b", "openrouter", "https://openrouter.ai/api/v1", true],
  ]);
  assert.equal(r.added[0]!.sees, true, "seeing pictures guessed from the name, as Add does");
  assert.equal(r.added[0]!.vision, undefined, "and left as a guess");
  assert.equal(new Set(r.added.map((m) => m.id)).size, 2);

  // The same model at another address is another model.
  const elsewhere = await addOwnModels({ baseUrl: "http://localhost:11434/v1", models: ["meta/llama-5-70b"] });
  assert.equal(elsewhere.added.length, 1);
  assert.equal(elsewhere.added[0]!.hasKey, false);
  assert.equal((await listOwnModels()).models.length, 4);

  // Past the most: refused whole, saying how many fit; nothing is dropped.
  const many = Array.from({ length: MAX_OWN_MODELS }, (_, i) => `vendor/model-${i}`);
  await assert.rejects(addOwnModels({ baseUrl: base, apiKey: key, models: many }), /That's 40 new models, and there's room for 36 more \(Friday keeps 40\)\. Untick 4/);
  assert.equal((await listOwnModels()).models.length, 4, "nothing added, nothing dropped");
  await addOwnModels({ baseUrl: base, apiKey: key, models: many.slice(0, 36) });
  assert.equal((await listOwnModels()).models.length, 40);
  await assert.rejects(addOwnModels({ baseUrl: base, apiKey: key, models: ["vendor/one-more"] }), /You have 40 models saved, the most Friday keeps/);
  assert.deepEqual((await addOwnModels({ baseUrl: base, apiKey: key, models: ["vendor/model-0"] })).added, [], "all already saved: nothing to add, and no refusal");

  await assert.rejects(addOwnModels({ baseUrl: base, models: [] }), /Tick the models to add/);
  await assert.rejects(addOwnModels({ baseUrl: "http://example.com/v1", models: ["a"] }), /Use https:\/\//);
  await assert.rejects(addOwnModels({ baseUrl: base, apiKey: "two\nlines here", models: ["a/b"] }), /spaces or line breaks/);
});

test("own models: more from a server already in use go on its saved key, only to that address (issue #17's follow-up)", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-own-more-"));
  const real = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, { HOME: home, USERPROFILE: home });
  t.after(async () => {
    for (const [k, v] of Object.entries(real)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
    await rm(home, { recursive: true, force: true });
  });
  const { readFile } = await import("node:fs/promises");
  const { addOwnModels, listOwnModels } = await import("../src/runner/own-models.js");
  const base = "https://router.example.com/v1";
  const key = "sk-router-0123456789abcdef";
  const { added } = await addOwnModels({ provider: "custom", baseUrl: base, apiKey: key, models: ["a/one"] });
  const first = added[0]!;

  const more = await addOwnModels({ provider: "custom", baseUrl: base, id: first.id, models: ["a/two", "a/three"] });
  assert.deepEqual(more.added.map((m) => [m.model, m.hasKey]), [["a/two", true], ["a/three", true]], "no key typed: the saved one goes with them");
  const file = JSON.parse(await readFile(path.join(home, ".friday", "models.json"), "utf8")) as { models: { model: string; apiKey?: string }[] };
  assert.deepEqual(file.models.map((m) => m.apiKey), [key, key, key], "the very key, kept on this computer");
  assert.ok((await listOwnModels()).models.every((m) => !("apiKey" in m)), "and never listed out");

  await assert.rejects(addOwnModels({ baseUrl: "https://elsewhere.example.com/v1", id: first.id, models: ["b/one"] }), /saved key only goes to the address it was saved for/, "never to another address");
  await assert.rejects(addOwnModels({ baseUrl: base, id: "nope1234", models: ["a/four"] }), /isn't on this computer any more/);
  const typed = await addOwnModels({ baseUrl: base, id: first.id, apiKey: "sk-other-0123456789abcd", models: ["a/five"] });
  assert.equal(typed.added[0]!.hasKey, true, "a key typed wins over the saved one");
});

test("your models listed by server: each address once, in the order first added, with how its keys stand", async () => {
  const { groupOwn } = await import("../src/client/own-groups.js");
  const m = (id: string, baseUrl: string, hasKey: boolean, provider = "custom", local = false) => ({ id, baseUrl, hasKey, provider, local });
  const groups = groupOwn([
    m("1", "https://router.example.com/v1", true),
    m("2", "http://localhost:11434/v1", false, "ollama", true),
    m("3", "https://router.example.com/v1/", true),
    m("4", "https://openrouter.ai/api/v1", true, "openrouter"),
    m("5", "https://router.example.com/v1", false),
  ]);
  assert.deepEqual(groups.map((g) => [g.host, g.models.map((x) => x.id).join(""), g.keyed]), [
    ["router.example.com/v1", "135", "some"],
    ["localhost:11434/v1", "2", "none"],
    ["openrouter.ai/api/v1", "4", "all"],
  ]);
  assert.equal(groups[1]!.local, true);
  assert.equal(groups[2]!.provider, "openrouter");
});
