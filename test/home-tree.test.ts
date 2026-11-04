import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { callHost } from "../src/runner/local-api.js";
import { treeFiles } from "../src/client/treeFiles.js";

const ctx = { serverUrl: "http://127.0.0.1:1", user: { id: "u", name: "U" }, runners: new Map() };

// "#" in the new-session box names the files of the folder picked, read before there is a session (audit CODE-9).
test("the computer lists a folder's files for the new-session box", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-tree-"));
  try {
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "README.md"), "hi");
    await writeFile(path.join(dir, "src", "app.ts"), "x");
    const got = treeFiles((await callHost("tree", { path: dir }, ctx)) as { output?: string });
    assert.deepEqual(got.files.sort(), ["README.md", "src/app.ts"]);
    assert.deepEqual(treeFiles((await callHost("tree", { path: path.join(dir, "src") }, ctx)) as { output?: string }).files, ["app.ts"]);
    await assert.rejects(callHost("tree", { path: path.join(dir, "nope") }, ctx), /no folder/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
