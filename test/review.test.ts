import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewText } from "../src/client/review.js";

test("a review names every line it points at, in file order, with the code itself", () => {
  const out = reviewText([
    { path: "src/b.ts", line: 3, removed: false, code: "const x = 1;", text: "Use a constant from config." },
    { path: "src/a.ts", line: 40, removed: true, code: "  legacy()", text: "Why was this removed?\nIt's still called." },
    { path: "src/a.ts", line: 12, removed: false, code: "", text: "Rename this." },
  ]);
  const a12 = out.indexOf("src/a.ts:12");
  const a40 = out.indexOf("src/a.ts:40");
  const b3 = out.indexOf("src/b.ts:3");
  assert.ok(a12 > 0 && a12 < a40 && a40 < b3, "sorted by file, then line");
  assert.match(out, /src\/a\.ts:40 \(a line that was removed\) — `legacy\(\)`/);
  assert.match(out, /Why was this removed\?\n  It's still called\./, "multi-line comments stay under their line");
  assert.match(out, /src\/b\.ts:3 — `const x = 1;`\n  Use a constant from config\./);
});

import { rankFiles, tokenAt } from "../src/client/Shortcuts.js";

test("the composer knows when you're typing a command or a file", () => {
  assert.deepEqual(tokenAt("/te", 3), { kind: "command", query: "te", start: 0 });
  assert.equal(tokenAt("run /te", 7), null, "a slash mid-sentence is a slash, not a command");
  assert.deepEqual(tokenAt("look at #src/ap", 15), { kind: "file", query: "src/ap", start: 8 });
  assert.equal(tokenAt("email me@example.com", 20), null, "an email address is not a mention");
  assert.deepEqual(tokenAt("@", 1), { kind: "person", query: "", start: 0 }, "@ is for people");
  assert.deepEqual(tokenAt("ask @may", 8), { kind: "person", query: "may", start: 4 });
  assert.deepEqual(tokenAt("#", 1), { kind: "file", query: "", start: 0 }, "# is for files");
});

test("file matches put the name before the folder, and short paths first", () => {
  const files = ["src/components/apparel/list.tsx", "src/app.ts", "docs/mapping.md", "apps/web/index.ts"];
  const app = rankFiles(files, "app");
  assert.equal(app[0], "src/app.ts", "a file named for it beats folders that contain it");
  assert.ok(app.indexOf("apps/web/index.ts") < app.indexOf("src/components/apparel/list.tsx"), "the shorter path first among equals");
  assert.ok(rankFiles(files, "apweb").includes("apps/web/index.ts"), "letters in order still match");
  assert.deepEqual(rankFiles(files, "zzz"), []);
});

import { failingCommands, fixFailuresText } from "../src/client/Activity.js";

test("only commands still failing when the run stopped are offered for fixing", () => {
  const msg = (calls: [string, string][]) => ({ body: { type: "agent.message", text: "", toolCalls: calls.map(([id, command]) => ({ id, name: "run_command", arguments: JSON.stringify({ command }) })) } }) as never;
  const res = (id: string, isError: boolean, output = "") => [id, { body: { type: "tool.result", callId: id, name: "run_command", output, isError } }] as const;
  const results = new Map([
    res("1", true, "$ npm test\n(exited 1)\nFAIL a.test"),
    res("2", false, "$ npm test\n(exited 0)\nok"),
    res("3", true, "$ npm run lint\n(exited 1)\nlint: 2 errors"),
    res("4", true, "$ npx tsc\n(exited 2)\ntsc: error"),
    res("5", true, "That command needs a person's approval first, and I've asked."),
  ]) as never;
  // npm test failed, then passed after a fix; lint failed; tsc failed; the build never ran, so there is nothing to fix.
  const failing = failingCommands([msg([["1", "npm test"]]), msg([["2", "npm test"], ["3", "npm run lint"]]), msg([["4", "npx tsc"], ["5", "npm run build"]])], results);
  assert.deepEqual(failing.map((f) => f.command), ["npm run lint", "npx tsc"]);
  const text = fixFailuresText(failing);
  assert.match(text, /These commands are still failing/);
  assert.match(text, /\$ npm run lint\n```\n\(exited 1\)\nlint: 2 errors\n```/);
  assert.match(text, /Don't skip or disable anything/);
});

test("the fix instruction doesn't repeat the command line the shell already echoed", () => {
  const text = fixFailuresText([{ command: "npm test", output: "$ npm test\n(exited 1)\nFAIL" }]);
  assert.equal(text.split("$ npm test").length - 1, 1);
});
