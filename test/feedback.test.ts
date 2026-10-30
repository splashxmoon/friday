// Send feedback (feedback.ts): a new issue on the open-source repository, started with this Friday's version and system only.
import test from "node:test";
import assert from "node:assert/strict";
import { feedbackUrl, ISSUES, osName } from "../src/feedback.js";

test("send feedback opens a new GitHub issue with the version and system filled in, and nothing of the person's", () => {
  const url = new URL(feedbackUrl({ version: "0.2.0", os: "macOS", app: true }));
  assert.equal(`${url.origin}${url.pathname}`, ISSUES);
  assert.equal(ISSUES, "https://github.com/splashxmoon/friday/issues/new");
  const body = url.searchParams.get("body") ?? "";
  assert.match(body, /\*\*What happened\*\*/);
  assert.match(body, /Friday 0\.2\.0 · macOS · desktop app$/);
  assert.deepEqual([...url.searchParams.keys()], ["body"], "no title, labels or anything else is set for them");
  assert.match(new URL(feedbackUrl({ version: "", os: "Linux", app: false })).searchParams.get("body")!, /Friday \(version unknown\) · Linux · browser$/);
});

test("the system is named as people say it, from Node's platform or the browser's", () => {
  assert.equal(osName("darwin"), "macOS");
  assert.equal(osName("MacIntel"), "macOS");
  assert.equal(osName("win32"), "Windows");
  assert.equal(osName("Win32"), "Windows");
  assert.equal(osName("linux"), "Linux");
  assert.equal(osName("Linux x86_64"), "Linux");
  assert.equal(osName(""), "unknown");
});
