// Auggie's ACP profile: its binary, its `--acp` server, and sign-in by `auggie auth login`.
import assert from "node:assert/strict";
import test from "node:test";
import { ADAPTERS, loginStatus } from "../src/runner/adapters.js";
import { ENGINE_MODEL_INFO, ENGINE_NAMES, ENGINE_TOOLS, TOOL_INFO } from "../src/types.js";

const auggie = ADAPTERS.auggie;

test("Auggie is registered as an ACP tool with its own entry", () => {
  assert.ok(ENGINE_TOOLS.includes("auggie"));
  assert.equal(ENGINE_NAMES.auggie, "Auggie");
  assert.equal(TOOL_INFO.auggie.docs, "https://docs.augmentcode.com/cli/overview");
  assert.equal(TOOL_INFO.auggie.install.npm, "@augmentcode/auggie");
  assert.deepEqual(ENGINE_MODEL_INFO.auggie, []);
  assert.deepEqual(auggie.bins, ["auggie"]);
  assert.deepEqual(auggie.args({ prompt: "Check the tests", system: "", resumeId: null, mode: "edits" }), ["--acp"]);
  assert.deepEqual(auggie.login, ["auth", "login"]);
  assert.deepEqual(auggie.logout, ["auth", "logout"]);
});

test("Auggie's sign-in is its session file or a token, never a guess", async () => {
  const keys = ["AUGMENT_API_TOKEN", "AUGMENT_SESSION_AUTH"];
  const saved = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(await loginStatus("auggie", "unused"), null);
    for (const key of keys) {
      process.env[key] = "test-only-placeholder";
      assert.equal(await loginStatus("auggie", "unused"), true);
      process.env[key] = "";
      assert.equal(await loginStatus("auggie", "unused"), null);
    }
  } finally {
    keys.forEach((key, i) => (saved[i] === undefined ? delete process.env[key] : (process.env[key] = saved[i])));
  }
});
