// Acting on a second review's findings (RunReview.tsx): what the agent is told for "Fix this" and "Ask why".
import assert from "node:assert/strict";
import test from "node:test";

test("a finding handed to the agent says where it is and what is wrong; asking why says not to change anything yet", async () => {
  const { findingText } = await import("../src/client/RunReview.js");
  const f = { severity: "high" as const, title: "Token is logged", detail: "The refresh writes the whole token to the log.", path: "src/auth/session.ts", line: 48 };
  const fix = findingText(f, "fix");
  assert.match(fix, /^The second review found a problem\. Fix it/);
  assert.match(fix, /Token is logged \(src\/auth\/session\.ts:48\): The refresh writes the whole token to the log\./);
  const ask = findingText(f, "ask");
  assert.match(ask, /Is it a real problem here\?/);
  assert.match(ask, /don't change anything yet/);
  assert.equal(findingText({ severity: "low", title: "Naming", detail: "" }, "fix").endsWith("\n\nNaming"), true, "no place, no detail: just the title");
});
