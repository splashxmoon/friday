import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { localKV } from "../src/local/kv.js";
import { NO_MODELS } from "../src/local/no-models.js";

// The page's own settings kept beside the data (client/page-keep.ts), so a new address (another app had 4321) starts with them,
// and they outlast a restart of Friday (2026-11-04 end-to-end check: theme, pins and sidebar all lost on a port change).
test("the open-source edition keeps the page's settings beside its data, its own keys only, through a restart", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-page-keep-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const start = async () => {
    const kv = await localKV(home);
    const app = await createApp({ port: 0, redisUrl: "", prefix: "friday:", secret: "s", driverGraceMs: 15_000, llm: NO_MODELS, dataDir: path.join(home, "uploads"), local: { redis: kv.redis, sub: kv.sub, user: { id: "local", name: "Me" } } });
    const call = async (method: string, body?: unknown) => {
      const r = await fetch(`${app.url}/api/local/page`, { method, headers: { "Content-Type": "application/json", "x-friday-local": "1" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: r.status, body: (await r.json()) as { page?: { origin: string; keys: Record<string, string> } | null } };
    };
    return { call, close: async () => (await app.close(), await kv.close()) };
  };
  const a = await start();
  assert.equal((await a.call("GET")).body.page, null);
  const keys = { "mpa.theme": "dark", "mpa.sessions": JSON.stringify([{ sid: "s1", pinned: true }]), "friday.panelWidth": "420", "someone.else": "x" };
  assert.equal((await a.call("PUT", { origin: "http://127.0.0.1:4321", keys })).status, 200);
  assert.equal((await a.call("PUT", { origin: 5, keys })).status, 400);
  await a.close();
  // Friday again, as a new address would find it.
  const b = await start();
  const page = (await b.call("GET")).body.page!;
  assert.equal(page.origin, "http://127.0.0.1:4321");
  assert.deepEqual(Object.keys(page.keys).sort(), ["friday.panelWidth", "mpa.sessions", "mpa.theme"]);
  assert.equal(page.keys["mpa.theme"], "dark");
  await b.close();
});
