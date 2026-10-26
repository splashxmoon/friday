import assert from "node:assert/strict";
import test from "node:test";
import { localServers } from "../src/client/Preview.js";

/** The Local servers menu: the preview's own server first, then what the agent left running, one per port. */
test("the preview's server, then each running background command that printed a local address", () => {
  const info = { cwd: "/w", command: "npm run dev", port: 3000, url: "http://localhost:3000", startedAt: 1, log: [], ready: true };
  const tasks = [
    { command: "npm run api", running: true, log: ["booting", "API listening on http://0.0.0.0:4000/"] },
    { command: "vite --port 3000", running: true, log: ["  ➜  Local:   http://localhost:3000/"] },
    { command: "npm test -- --watch", running: true, log: ["3 passing"] },
    { command: "storybook", running: false, log: ["http://localhost:6006"] },
  ];
  assert.deepEqual(localServers(info, tasks).map((s) => [s.url, s.command, s.preview]), [
    ["http://localhost:3000", "npm run dev", true],
    ["http://localhost:4000", "npm run api", false],
  ]);
  assert.deepEqual(localServers(null, []), [], "nothing running is an empty list");
});
