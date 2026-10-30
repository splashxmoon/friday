// Whether Copilot is signed in (adapters.ts copilotSignedIn): a computer where it never was says so, rather than "can't tell".
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { copilotSignedIn } from "../src/runner/adapters.js";

test("Copilot never signed in here (no config) is not signed in, unless a token is set for it; its users list decides otherwise", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "copilot-"));
  try {
    assert.equal(await copilotSignedIn(home, {}), false, "no config, no token: not signed in");
    assert.equal(await copilotSignedIn(home, { GH_TOKEN: "x" }), null, "a token may sign it in: can't tell");
    await writeFile(path.join(home, "config.json"), '// comment\n{ "loggedInUsers": [{ "login": "maya" }] }');
    assert.equal(await copilotSignedIn(home, {}), true);
    await writeFile(path.join(home, "config.json"), '{ "loggedInUsers": [] }');
    assert.equal(await copilotSignedIn(home, {}), false);
    await writeFile(path.join(home, "config.json"), '{ "theme": "dark" }');
    assert.equal(await copilotSignedIn(home, {}), null, "a config that doesn't say: can't tell");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
