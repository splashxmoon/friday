// A video an agent names by its file name shows in the chat wherever in the session's folders it is (work-files.ts findWork;
// Arun, 2026-10-31: Nova named `skit-1-v3.mp4` and the chat said it wasn't on this computer: it was in a renders folder).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { findWork } from "../src/work-files.js";

test("a file named from an agent's folder is found at its top or further in, and nothing outside the folders is", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "find-work-"));
  const a = path.join(base, "a"), b = path.join(base, "b");
  await mkdir(path.join(a, "renders", "final"), { recursive: true });
  await mkdir(b, { recursive: true });
  await writeFile(path.join(a, "renders", "final", "skit-1-v3.mp4"), "x");
  await writeFile(path.join(b, "skit-2.mp4"), "y");
  await writeFile(path.join(base, "outside.mp4"), "z");
  assert.match((await findWork([a, b], "skit-1-v3.mp4")) ?? "", /renders[\\/]final[\\/]skit-1-v3\.mp4$/, "further in");
  assert.match((await findWork([a, b], "skit-2.mp4")) ?? "", /b[\\/]skit-2\.mp4$/, "at the top of another folder");
  assert.match((await findWork([a, b], "final/skit-1-v3.mp4")) ?? "", /skit-1-v3\.mp4$/, "by the end of its path");
  assert.match((await findWork([a, b], "a/renders/final/skit-1-v3.mp4")) ?? "", /skit-1-v3\.mp4$/, "named from the folder above its own");
  assert.equal(await findWork([a, b], "xa/renders/final/skit-1-v3.mp4"), null, "a folder's name matches whole");
  assert.equal(await findWork([a, b], "nope.mp4"), null);
  assert.equal(await findWork([a, b], "../outside.mp4"), null, "never outside the session's folders");
});
