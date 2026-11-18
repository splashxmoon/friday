import assert from "node:assert/strict";
import test from "node:test";
import { liveTasks } from "../src/client/task-count.js";

// A finished team's tasks go, from the Tasks tab and its count (Arun, 2026-11-18: "make sure the team tasks disappear after being
// completed too"); while any is left, all of them show, the done ones included.
test("the team's tasks show while any is left to finish, and go once every one is done or dropped", () => {
  const t = (status: string) => ({ status });
  assert.equal(liveTasks([t("completed"), t("active"), t("cancelled")]).length, 3);
  assert.equal(liveTasks([t("completed"), t("pending")]).length, 2);
  assert.deepEqual(liveTasks([t("completed"), t("cancelled"), t("completed")]), []);
  assert.deepEqual(liveTasks([]), []);
});
