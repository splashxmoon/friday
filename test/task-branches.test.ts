import assert from "node:assert/strict";
import test from "node:test";
import { mergeOrder, ownersClash, taskBranch } from "../src/agent-mesh.js";

// A board's tasks each on a branch of their own, as Oh My Hermes' fanout lands its units (Arun, 2026-11-11): files owned by two
// tasks that run side by side are refused at posting, and the branches are merged in the order the tasks build on each other.

const t = (id: string, owns: string[] = [], after: string[] = []) => ({ id, owns, after });

test("two tasks side by side owning the same file, or a folder and a file in it, are a clash; one waiting on the other is not", () => {
  assert.deepEqual(ownersClash([t("api", ["src/api.ts"]), t("ui", ["./src/api.ts"])]), [{ a: "api", b: "ui", path: "src/api.ts" }]);
  assert.deepEqual(ownersClash([t("api", ["src/server/"]), t("auth", ["src/server/auth.ts"])]).map((c) => c.path), ["src/server"]);
  assert.deepEqual(ownersClash([t("api", ["src/api.ts"]), t("ui", ["src/api.ts"], ["api"])]), [], "ui waits on api");
  assert.deepEqual(ownersClash([t("a", ["x.ts"]), t("b", [], ["a"]), t("c", ["x.ts"], ["b"])]), [], "c waits on a through b");
  assert.deepEqual(ownersClash([t("a", ["src/a.ts"]), t("b", ["src/ab.ts"])]), [], "a name that starts the same is another file");
  assert.deepEqual(ownersClash([t("a"), t("b")]), [], "owning nothing clashes with nothing");
});

test("branches merge in the order tasks build on each other, otherwise as posted, each once", () => {
  assert.deepEqual(mergeOrder([t("ui", [], ["api"]), t("api"), t("docs")]).map((x) => x.id), ["api", "ui", "docs"]);
  assert.deepEqual(mergeOrder([t("c", [], ["b"]), t("b", [], ["a"]), t("a")]).map((x) => x.id), ["a", "b", "c"]);
  assert.deepEqual(mergeOrder([t("x", [], ["gone"]), t("y")]).map((x) => x.id), ["x", "y"], "a task it waits on that isn't here is skipped");
  assert.equal(taskBranch("OV2u_zh", 42, "api"), "crew/42-api-ov2u", "a board in another session gets its own");
  assert.notEqual(taskBranch("Ab9xQ", 42, "api"), taskBranch("Zz1pQ", 42, "api"));
});

test("verified: checks passed on a clean commit, nothing committed on its branch since; and the commit read the same in every shell", async () => {
  const { commitOf } = await import("../src/agent-mesh.js");
  const { verifiedAt } = await import("../src/session/projection.js");
  const sha = "a".repeat(40);
  const clean = `$ git status --porcelain=v2 --branch\n(exited 0)\n# branch.oid ${sha}\n# branch.head crew/3-api`;
  assert.deepEqual(commitOf(clean), { sha, dirty: false });
  assert.deepEqual(commitOf(`${clean}\n1 .M N... 100644 100644 100644 x y src/api.js`), { sha, dirty: true });
  assert.deepEqual(commitOf(`${clean.replace(/\n/g, "\r\n")}\r\n? notes.txt`), { sha, dirty: true }, "Windows line ends, an untracked file");
  assert.equal(commitOf("$ git status --porcelain=v2 --branch\n(exited 128)\nfatal: not a git repository"), null);
  assert.equal(commitOf("$ git status --porcelain=v2 --branch\n(exited 0)\n# branch.oid (initial)"), null, "no commit yet");
  assert.equal(verifiedAt({ checks: { command: "npm test", ok: true, sha } }), sha);
  assert.equal(verifiedAt({ checks: { command: "npm test", ok: true, sha, dirty: true } }), null, "uncommitted work beside it");
  assert.equal(verifiedAt({ checks: { command: "npm test", ok: true, sha, stale: true } }), null, "committed on since");
  assert.equal(verifiedAt({ checks: { command: "npm test", ok: false, sha } }), null);
  assert.equal(verifiedAt({ checks: { command: "npm test", ok: true } }), null, "no commit known");
  assert.equal(verifiedAt({}), null);
});
