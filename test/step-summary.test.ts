import assert from "node:assert/strict";
import test from "node:test";
import { stepsSummary } from "../src/step-summary.js";

const run = (cmd: string, state = "done") => ({ mark: "›_", verb: "Ran", target: cmd, state });
const read = (f: string) => ({ mark: "≡", verb: "Read", target: f, state: "done" });
const edit = (f: string) => ({ mark: "±", verb: "Edited", target: f, state: "done" });

test("a stretch of work is one line, kinds in the order they happened", () => {
  assert.equal(stepsSummary([run("npm test"), run("git status")]), "Ran 2 commands");
  assert.equal(stepsSummary([run("ls"), read("a.ts"), read("b.ts"), read("c.ts")]), "Ran a command, read 3 files");
  assert.equal(stepsSummary([read("App.tsx"), edit("App.tsx")]), "Read App.tsx, edited App.tsx");
  // The same file read twice is one file.
  assert.equal(stepsSummary([read("a.ts"), read("a.ts")]), "Read a.ts");
  assert.equal(stepsSummary([{ mark: "⌕", verb: "Searched the web", target: "electron webcontentsview", state: "done" }]), "Searched the web");
  assert.equal(stepsSummary([{ mark: "⌕", verb: "Searched", target: "TODO", state: "done" }, { mark: "⌕", verb: "Searched", target: "FIXME", state: "done" }]), "Searched the code 2 times");
});

test("thinking alone, failures, and long mixed stretches", () => {
  assert.equal(stepsSummary([], 4), "Thought for 4s");
  assert.equal(stepsSummary([], 0), "Thought");
  assert.equal(stepsSummary([run("npm test", "failed"), run("npm test")]), "Ran 2 commands · 1 failed");
  // A step still running is said as such, and left out of what was done.
  assert.equal(stepsSummary([run("npm test", "running")]), "Running npm test");
  assert.equal(stepsSummary([read("a.ts"), run("npm test", "running")]), "Read a.ts");
  // A command still waiting on an approval was never run, so it isn't in the sentence.
  assert.equal(stepsSummary([read("a.ts"), read("b.ts"), run("git status", "waiting")]), "Read 2 files · 1 not run");
  assert.equal(stepsSummary([run("git status", "waiting")]), "A step not run");
  assert.equal(stepsSummary([run("a", "waiting"), run("b", "waiting")]), "2 steps not run");
  assert.equal(
    stepsSummary([read("a.ts"), run("ls"), edit("b.ts"), { mark: "⌕", verb: "Searched", target: "x", state: "done" }, { mark: "↗", verb: "Opened", target: "github.com", state: "done" }]),
    "Read a.ts, ran a command, edited b.ts, 2 more",
  );
});
