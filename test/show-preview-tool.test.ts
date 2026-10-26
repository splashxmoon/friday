import assert from "node:assert/strict";
import test from "node:test";
import { showPreview, type ToolContext } from "../src/agent/tools.js";

const ctx = (output: string, seen: unknown[] = []): ToolContext => ({ readRepo: async (req: unknown) => (seen.push(req), { output }) }) as unknown as ToolContext;

test("the agent is told where the site is running, and the machine is asked for a preview", async () => {
  const seen: unknown[] = [];
  const r = await showPreview.run({ script: "dev" }, ctx(JSON.stringify({ preview: { url: "http://127.0.0.1:5173", command: "npm run dev", ready: true, log: [] } }), seen), "c1");
  assert.deepEqual(seen, [{ op: "preview", query: "dev" }]);
  assert.match(r.output, /Running \(npm run dev\) at http:\/\/127\.0\.0\.1:5173/);
  assert.ok(!r.isError);
});

test("a server that is still coming up is said to be on its way, and a failure carries its reason", async () => {
  const slow = await showPreview.run({}, ctx(JSON.stringify({ preview: { url: "http://127.0.0.1:1", command: "npm run dev", ready: false, log: ["VITE v5 ready soon"] } })), "c2");
  assert.match(slow.output, /Still starting/);
  assert.match(slow.output, /VITE v5 ready soon/);
  const bad = await showPreview.run({}, ctx(JSON.stringify({ error: "npm install failed (exit 1)." })), "c3");
  assert.equal(bad.isError, true);
  assert.match(bad.output, /npm install failed/);
});
