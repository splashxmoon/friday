// Project folders for the crew (crew-folders.ts; Arun, 2026-11-15: "placing agents and like crew rooms into prodject folders
// too... like categories"): what the page sends is checked, kept per person, and read back whole.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { cleanFolders, readFolders } from "../src/crew-folders.js";
import { localKV } from "../src/local/kv.js";
import { NO_MODELS } from "../src/local/no-models.js";

process.env.FRIDAY_TEAMMATES_DRY = "1";
process.env.FRIDAY_EDITION = "local";

test("a folders record is checked: names trimmed and short, ids their own, places only into folders that exist", () => {
  assert.deepEqual(cleanFolders({ folders: [{ id: "a1", name: "  edge   app " }], place: { "mate:k1": "a1", "room:r9": "gone", "bad key": "a1" } }), { folders: [{ id: "a1", name: "edge app" }], place: { "mate:k1": "a1" } });
  assert.equal(typeof cleanFolders({ folders: [{ id: "a1", name: "" }] }), "string", "a folder needs a name");
  assert.equal(typeof cleanFolders({ folders: [{ id: "a1", name: "x" }, { id: "a1", name: "y" }] }), "string", "ids are each folder's own");
  assert.equal(typeof cleanFolders({ folders: Array.from({ length: 51 }, (_, i) => ({ id: `f${i}`, name: "x" })) }), "string");
  assert.equal(cleanFolders({ folders: [{ id: "a1", name: "x".repeat(80) }], place: {} }) && (cleanFolders({ folders: [{ id: "a1", name: "x".repeat(80) }], place: {} }) as { folders: { name: string }[] }).folders[0]!.name.length, 40);
  assert.deepEqual(readFolders("not json"), { folders: [], place: {} });
  assert.deepEqual(readFolders(null), { folders: [], place: {} });
});

test("the Agents sidebar's folders are kept on this computer's Friday and read back as they were written", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-crew-folders-"));
  const kv = await localKV(home);
  const app = await createApp({ port: 0, redisUrl: "", prefix: "friday:", secret: "s", driverGraceMs: 15_000, llm: NO_MODELS, dataDir: path.join(home, "uploads"), local: { redis: kv.redis, sub: kv.sub, user: { id: "local", name: "Me" } }, teammatesHome: home });
  t.after(async () => (await app.close(), await kv.close(), await rm(home, { recursive: true, force: true })));
  const headers = { "Content-Type": "application/json", "x-friday-local": "1" };
  const url = `${app.url}/api/teammates/folders`;
  assert.deepEqual(await (await fetch(url, { headers })).json(), { folders: [], place: {} });
  const put = await fetch(url, { method: "PUT", headers, body: JSON.stringify({ folders: [{ id: "f1", name: "edge" }, { id: "f2", name: "friday-site" }], place: { "mate:abc": "f1", "room:crew": "f2" } }) });
  assert.equal(put.status, 200);
  assert.deepEqual(await (await fetch(url, { headers })).json(), { folders: [{ id: "f1", name: "edge" }, { id: "f2", name: "friday-site" }], place: { "mate:abc": "f1", "room:crew": "f2" } });
  // Renamed, and one removed: what was in it is in no folder now.
  await fetch(url, { method: "PUT", headers, body: JSON.stringify({ folders: [{ id: "f1", name: "Edge app" }], place: { "mate:abc": "f1" } }) });
  assert.deepEqual(await (await fetch(url, { headers })).json(), { folders: [{ id: "f1", name: "Edge app" }], place: { "mate:abc": "f1" } });
  assert.equal((await fetch(url, { method: "PUT", headers, body: JSON.stringify({ folders: "x" }) })).status, 400);
});
