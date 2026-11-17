// Issues that start threads by themselves (issue-intake.ts): which ones, and in what order.
import assert from "node:assert/strict";
import { test } from "node:test";
import { toStart } from "../src/client/issue-intake.js";

const issue = (n: number, labels: string[]) => ({ number: n, title: `Issue ${n}`, url: `https://github.com/a/b/issues/${n}`, labels });

test("only issues with the label start, whatever its case, oldest first, each once", () => {
  const list = [issue(9, ["bug", "Friday"]), issue(7, ["friday"]), issue(5, ["bug"]), issue(3, ["friday"])];
  assert.deepEqual(toStart(list, "friday", new Set()).map((i) => i.number), [3, 7, 9]);
  assert.deepEqual(toStart(list, "friday", new Set(["https://github.com/a/b/issues/7"])).map((i) => i.number), [3, 9], "started before: never again");
  assert.deepEqual(toStart(list, " FRIDAY ", new Set()).length, 3);
  assert.deepEqual(toStart([issue(1, [])], "friday", new Set()), []);
});
