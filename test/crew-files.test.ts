import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { crewFileAt } from "../src/crew-files.js";
import { kindOf, madeFilesOf, namedPaths, withNamed } from "../src/client/made-files.js";

/** A file a crew mate made, found among the crew's folders on this computer (crew-files.ts), and shown as its message's files (made-files.tsx). */
// Paths as this computer writes them (on Windows "/h/Sage" is D:\h\Sage), so the same tests hold there.
const P = (p: string) => path.resolve(p);
const on = (...files: string[]) => async (p: string) => files.map(P).includes(p);

test("a whole path is read from the deepest crew folder that holds it, and nowhere else", async () => {
  const roots = ["/w/shop", "/h/Sage", "/h/Sage/copies/edge"];
  assert.deepEqual(await crewFileAt(roots, "/h/Sage/pricing.md", on("/h/Sage/pricing.md")), { root: P("/h/Sage"), rel: "pricing.md" });
  assert.deepEqual(await crewFileAt(roots, "/h/Sage/copies/edge/a.ts", on("/h/Sage/copies/edge/a.ts")), { root: P("/h/Sage/copies/edge"), rel: "a.ts" });
  assert.equal(await crewFileAt(roots, "/etc/passwd", on("/etc/passwd")), null);
  assert.equal(await crewFileAt(roots, "/h/Sage/../Nova/x.md", on("/h/Nova/x.md")), null);
  assert.equal(await crewFileAt(roots, "/h/Sage/gone.md", on()), null);
});

test("a relative path is looked for in each crew folder in turn, the lane's own first", async () => {
  const roots = ["/w/shop", "/h/Sage", "/h/Nova"];
  assert.deepEqual(await crewFileAt(roots, "announcement.md", on("/h/Nova/announcement.md")), { root: P("/h/Nova"), rel: "announcement.md" });
  assert.deepEqual(await crewFileAt(roots, "./pricing.md", on("/w/shop/pricing.md", "/h/Sage/pricing.md")), { root: P("/w/shop"), rel: "pricing.md" });
  assert.equal(await crewFileAt(roots, "../secret", on("/w/secret")), null);
  assert.equal(await crewFileAt(roots, "nowhere.md", on()), null);
});

test("a turn's files: its diff first, then what it wrote elsewhere, once each, never its memory", () => {
  const made = madeFilesOf(
    [
      { path: "pricing.md", status: "added", additions: 12, deletions: 0 },
      { path: "MEMORY.md", status: "modified", additions: 2, deletions: 0 },
      { path: "src/totals.ts", status: "modified", additions: 9, deletions: 3 },
      { path: "old.md", status: "deleted", additions: 0, deletions: 4 },
    ],
    [
      { path: "/h/Sage/pricing.md", lines: 12 },
      { path: "/h/Sage/notes/plan.md", lines: 30 },
      { path: "/h/Sage/.claude/x.json", lines: 3 },
    ],
  );
  assert.deepEqual(
    made.map((f) => [f.path, f.status]),
    [
      ["pricing.md", "added"],
      ["src/totals.ts", "modified"],
      ["/h/Sage/notes/plan.md", "added"],
    ],
  );
  assert.equal(kindOf("plan.md"), "Markdown");
  assert.equal(kindOf("a.csv"), "Spreadsheet");
  assert.equal(kindOf("Makefile"), "File");
});

test("a room's own folders: whole paths, once each, never with .., up to its limit", async () => {
  const { cleanRoom, MAX_ROOM_FOLDERS } = await import("../src/teammates.js");
  assert.deepEqual(cleanRoom({ folders: ["/w/shop/", "/w/shop", " /h/Nova "] }, []).folders, ["/w/shop", "/h/Nova"]);
  assert.deepEqual(cleanRoom({ folders: [] }, []).folders, []);
  assert.equal(cleanRoom({ purpose: "x" }, []).folders, undefined);
  assert.throws(() => cleanRoom({ folders: ["shop"] }, []), /whole path/);
  assert.throws(() => cleanRoom({ folders: ["/w/../etc"] }, []), /whole path/);
  assert.throws(() => cleanRoom({ folders: Array.from({ length: MAX_ROOM_FOLDERS + 1 }, (_, i) => `/f/${i}`) }, []), /up to/);
});

test("the files a message names: names with an extension in backticks, not commands, links or numbers", () => {
  assert.deepEqual(namedPaths(["Drafted `2026-11-16-codex-handoff-post.md` and `notes/plan.md:12`.", "Ran `npm test`, see `https://x.dev/a.md`, `v1.2` and `pricing.md` again"]), ["2026-11-16-codex-handoff-post.md", "notes/plan.md", "pricing.md"]);
  assert.deepEqual(namedPaths(["`1.5` and `0.2.26` are versions, `README` has no extension"]), []);
});

test("a file named in the message joins what its diff and its steps gave, once, never its memory", () => {
  const made = withNamed([{ path: "pricing.md", status: "added" }], [{ path: "/h/Sage/pricing.md", status: "added", size: 120 }, { path: "/h/Juno/post.md", status: "added", size: 900 }, { path: "/h/Juno/MEMORY.md", status: "added", size: 40 }]);
  assert.deepEqual(made.map((f) => f.path), ["pricing.md", "/h/Juno/post.md"]);
});
