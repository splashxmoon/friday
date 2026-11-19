// A look before the Preview opens (Activity.tsx pageAppears; Arun, 2026-11-19: "Yes, fix it"): nothing listening there yet is an
// answer, status 0, when the page asks as a probe; it was a failure, which the page logged as a 503 every few seconds while an
// agent's server came up. Asked as a page fetch it still fails, as the Preview's proxy needs.
import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import test from "node:test";
import { callHost } from "../src/runner/local-api.js";
import { NOT_LISTENING } from "../src/runner/preview.js";

const ctx = { serverUrl: "http://127.0.0.1:1", user: { id: "local", name: "You" }, runners: new Map() } as unknown as Parameters<typeof callHost>[2];

/** A port nothing listens on: one handed out, then let go. */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test("a probe of a port nothing listens on answers status 0; a page fetch of it still fails", async () => {
  const port = await freePort();
  assert.deepEqual(await callHost("preview.fetch", { port, path: "/", probe: true }, ctx), { status: 0, type: "", body: "" });
  await assert.rejects(callHost("preview.fetch", { port, path: "/" }, ctx), new RegExp(NOT_LISTENING.replace(".", "\\.")));
});
