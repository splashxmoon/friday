// A recording or watch link's page has nobody signed in (ReplayPage's identity has no id): what reads a person's own
// workspace or computer isn't asked there, where it could only be refused (a 401 for /api/routing and a 403 for
// /api/runner/usage in the console of every signed-out watcher, e2e/viewer.spec.ts).
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("signed out, routing and the coding tools' limits are not asked for; signed in, they are", async () => {
  const asked: string[] = [];
  globalThis.fetch = (async (input: string) => {
    asked.push(String(input));
    return new Response(JSON.stringify({ records: [], perPct: {}, learned: {}, view: [] }), { status: 200 });
  }) as typeof fetch;
  const { readRouting } = await import("../src/client/RouteWhy.js");
  const { refreshToolLimits } = await import("../src/client/toolLimits.js");

  const nobody = { id: "", name: "" } as Parameters<typeof readRouting>[0];
  assert.deepEqual(await readRouting(nobody), { records: [], perPct: {}, learned: {}, view: [] }, "nothing learnt yet");
  refreshToolLimits(nobody);
  await new Promise((r) => setImmediate(r));
  assert.equal(asked.length, 0, `nothing sent: ${asked.join(", ")}`);

  const ada = { id: "u-ada", name: "Ada" } as Parameters<typeof readRouting>[0];
  await readRouting(ada);
  assert.ok(asked.some((u) => u.startsWith("/api/routing")), "signed in, routing is read");
});
