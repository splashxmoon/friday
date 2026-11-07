// The coding tools in one order wherever they are listed: Settings, the welcome and the agent picker (engines.ts toolOrder;
// Arun, 2026-11-06: "the ones installed should be at the top").
import assert from "node:assert/strict";
import test from "node:test";
import { splitTools, toolOrder } from "../src/client/engines.js";
import { ENGINE_TOOLS, type EngineTool } from "../src/types.js";

test("ready ones first, then those not signed in, then the rest, A to Z within each, any other ACP agent last", () => {
  // As the picker had it on a Mac with these: Cursor and Muse Code installed and not signed in sat between the ready ones.
  const ready = new Set<EngineTool>(["claude", "codex", "copilot", "antigravity"]);
  const signedOut = new Set<EngineTool>(["cursor", "muse"]);
  const order = toolOrder((t) => (ready.has(t) ? "ready" : signedOut.has(t) ? "signed out" : "absent"));
  const { here, away } = splitTools((t) => ready.has(t) || signedOut.has(t));
  assert.deepEqual([...here].sort(order), ["antigravity", "claude", "codex", "copilot", "cursor", "muse"]);
  const rest = [...away].sort(order);
  assert.equal(rest.at(-1), "acp", "Other ACP agent last");
  assert.deepEqual(rest.slice(0, 3), ["amp", "cline", "devin"]);
  assert.equal(rest.length + here.length, ENGINE_TOOLS.length);
});
