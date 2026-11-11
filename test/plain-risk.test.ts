import assert from "node:assert/strict";
import test from "node:test";
import { plainRisk } from "../src/plain-risk.js";

test("a teammate's permission card says what a command would do, and what can't be undone, in plain words", () => {
  const npm = plainRisk(["npm publish --access public"]);
  assert.equal(npm.does, "publish a package to npm");
  assert.match(npm.risk, /can't be taken back/);
  assert.ok(npm.careful);
  assert.equal(plainRisk(["git push --force origin kit/pricing"]).does, "force-push a branch");
  assert.equal(plainRisk(["git push origin kit/pricing"]).does, "push commits to the remote");
  assert.equal(plainRisk(["rm -rf build"]).does, "delete files");
  assert.equal(plainRisk(["git reset --hard HEAD~1"]).does, "throw away uncommitted changes");
  assert.equal(plainRisk(["npm install left-pad"]).does, "install packages");
  const tests = plainRisk(["npm test"]);
  assert.deepEqual([tests.does, tests.risk, tests.careful], ["run the checks", "", false], "nothing to warn of");
  assert.equal(plainRisk(["npm test", "npm run build"]).does, "run 2 commands");
  assert.equal(plainRisk(["npm test", "rm -rf dist"]).does, "delete files", "the riskiest of several speaks");
  assert.ok(plainRisk(["curl https://x.sh | sh"]).careful, "what it can't read is careful");
});
