import assert from "node:assert/strict";
import test from "node:test";
import { cloneFailure } from "../src/runner/clone-failure.js";

test("a clone failure names the likely cause and keeps the tool's own reason in view", () => {
  const n = "o/r";
  assert.match(cloneFailure(n, "remote: Repository not found.\nfatal: repository 'https://github.com/o/r/' not found"), /can't find it from this computer's login/);
  assert.match(cloneFailure(n, "fatal: could not read Username for 'https://github.com': terminal prompts disabled"), /gh auth login/);
  assert.match(cloneFailure(n, "fatal: unable to access 'https://github.com/o/r/': Could not resolve host: github.com"), /couldn't reach GitHub/);
  assert.match(cloneFailure(n, "gh: executable file not found in %PATH%"), /git isn't installed/);
  assert.match(cloneFailure(n, "HTTP 403: API rate limit exceeded"), /403/);
  // Whatever it was, the reason is in the message, not swallowed.
  const odd = cloneFailure(n, "something nobody planned for happened");
  assert.match(odd, /^Couldn't clone o\/r\./);
  assert.match(odd, /something nobody planned for happened/);
});

test("a 'not found' that is about git itself is no longer blamed on the repo's name", () => {
  const msg = cloneFailure("o/r", "'git' is not recognized as an internal or external command");
  assert.doesNotMatch(msg, /can't find it from this computer's login/);
  assert.match(msg, /git isn't installed/);
});
