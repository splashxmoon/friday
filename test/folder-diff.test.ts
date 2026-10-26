import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { diffSince, dropShadow, repoInfo, shadowSnapshot } from "../src/runner/git.js";

/**
 * Diffs for a folder that isn't a repository.
 *
 * Plenty of folders people lend a session are not git repositories — a scratch
 * directory, an export, a project nobody initialised — and the panel meant to
 * show what changed showed nothing at all for every one of them. Git can keep
 * a repository outside the folder it describes, so it does.
 */

let dir = "";
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "friday-folder-"));
});
after(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

const folder = async (): Promise<string> => {
  const f = await mkdtemp(path.join(dir, "plain-"));
  await mkdir(path.join(f, "src"), { recursive: true });
  await writeFile(path.join(f, "src", "app.ts"), "export const PORT = 8080;\n");
  await writeFile(path.join(f, "README.md"), "# Notes\n");
  return f;
};

test("a plain folder is not a repository, which is why this exists", async () => {
  assert.equal(await repoInfo(await folder()), null);
});

test("changes in a plain folder show up as a diff, and nothing is written into it", async () => {
  const f = await folder();
  const shadow = await shadowSnapshot(f);
  assert.ok(shadow, "the snapshot was taken");
  assert.ok(!shadow.gitDir.startsWith(f), "and it lives outside the folder it describes");
  assert.equal(await repoInfo(f), null, "so the folder is still not a repository afterwards");

  // Nothing has happened yet.
  assert.deepEqual(await diffSince(f, shadow.head, shadow), []);

  // An edit, and a new file.
  await writeFile(path.join(f, "src", "app.ts"), "export const PORT = 9090;\n");
  await writeFile(path.join(f, "src", "added.ts"), "export const hi = 1;\n");
  const files = await diffSince(f, shadow.head, shadow);
  assert.deepEqual(
    files.map((x) => [x.path, x.status]).sort(),
    [["src/added.ts", "added"], ["src/app.ts", "modified"]],
    "both the change and the new file",
  );
  assert.match(files.find((x) => x.path === "src/app.ts")!.patch, /-export const PORT = 8080/);
  assert.match(files.find((x) => x.path === "src/app.ts")!.patch, /\+export const PORT = 9090/);

  await dropShadow(shadow);
});

test("the snapshot leaves out what nobody wants a diff of", async () => {
  const f = await folder();
  await mkdir(path.join(f, "node_modules", "left-pad"), { recursive: true });
  await writeFile(path.join(f, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  await mkdir(path.join(f, "dist"), { recursive: true });
  await writeFile(path.join(f, "dist", "bundle.js"), "console.log(1);\n");

  const shadow = (await shadowSnapshot(f))!;
  await writeFile(path.join(f, "node_modules", "left-pad", "index.js"), "module.exports = 2;\n");
  await writeFile(path.join(f, "dist", "bundle.js"), "console.log(2);\n");
  await writeFile(path.join(f, "README.md"), "# Notes\nchanged\n");

  const files = await diffSince(f, shadow.head, shadow);
  assert.deepEqual(files.map((x) => x.path), ["README.md"], "dependencies and build output are not somebody's work");
  await dropShadow(shadow);
});

test("dropping the snapshot removes it, and dropping nothing is fine", async () => {
  const f = await folder();
  const shadow = (await shadowSnapshot(f))!;
  await dropShadow(shadow);
  await dropShadow(null);
  await assert.rejects(diffSince(f, shadow.head, shadow), "the repository is gone, so the diff cannot be taken");
});
