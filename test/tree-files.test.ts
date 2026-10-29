import assert from "node:assert/strict";
import test from "node:test";
import { foldersOf, treeFiles } from "../src/client/treeFiles.js";

// 2026-10-28 QA (Arun: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL"): "#" and the pin picker read "This session has no
// folder yet…" as a folder with nothing in it, and the pin picker offered no file of a folder that had them.

test("a listing gives its paths", () => {
  assert.deepEqual(treeFiles({ output: "3 files under the repository root:\nREADME.md\nsrc/a.ts\nsrc/b/c.ts\n[and 2 more]" }), { files: ["README.md", "src/a.ts", "src/b/c.ts"], why: "" });
});

test("an answer that is not a listing is the reason, in its first sentence", () => {
  const got = treeFiles({ output: "This session has no folder yet. Attach one with the folder button in the composer and it becomes a working copy." });
  assert.deepEqual(got, { files: [], why: "This session has no folder yet." });
  assert.equal(treeFiles({ error: "Not allowed." }).why, "Not allowed.");
  assert.deepEqual(treeFiles({}), { files: [], why: "" });
});

test("the folders the files are in, each once", () => {
  assert.deepEqual(foldersOf(["README.md", "src/a.ts", "src/b/c.ts", "src/b/d.ts"]), ["src/", "src/b/"]);
});
