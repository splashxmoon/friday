// "Review in the IDE" on the session's own pull request (Arun, 2026-11-20: "Review in the IDE from anywhere"): the folder the IDE has
// open may be named in a review request, with the pull request's base; any other folder still has to be one of Friday's own checkouts.
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { reviewArg, rootKey } from "../src/runner/vscode.js";

test("a review request may name the IDE's own folder, with the base of the pull request and its tab's name", () => {
  const root = path.join(os.homedir(), "Documents", "widgets");
  assert.deepEqual(reviewArg({ dir: root, base: "origin/main", label: "Pull request #7" }, root), { dir: root, base: "origin/main", label: "Pull request #7" });
  // The same folder spelled with a trailing slash or other segments that resolve to it.
  assert.deepEqual(reviewArg({ dir: `${root}${path.sep}.`, base: "origin/release-1.2" }, root), { dir: `${root}${path.sep}.`, base: "origin/release-1.2" });
  // Not the folder the IDE has open: not ours to open as a repository.
  assert.equal(reviewArg({ dir: path.join(os.homedir(), "Documents", "other"), base: "origin/main" }, root), undefined);
  assert.equal(reviewArg({ dir: root, base: "origin/main" }), undefined, "no folder open, nothing to compare with");
  assert.equal(reviewArg({ dir: path.join(root, ".."), base: "origin/main" }, root), undefined, "no way out of it");
  // A base that is no branch name is dropped, as for a racer.
  assert.deepEqual(reviewArg({ dir: root, base: "--upload-pack=x" }, root), { dir: root });
});

test("a review request names the IDE's own folder only as the bridge reads folders, and carries the branch it is for", () => {
  const root = path.join(os.homedir(), "Documents", "widgets");
  // A folder that differs in case is another folder where paths have no drive letter (macOS, Linux), and the same one on a
  // drive or a share, where Windows ignores case: as rootKey, the name the bridge gives a folder, reads it.
  const other = path.join(os.homedir(), "Documents", "Widgets");
  if (process.platform === "win32") assert.deepEqual(reviewArg({ dir: other, base: "origin/main" }, root), { dir: other, base: "origin/main" });
  else assert.equal(reviewArg({ dir: other, base: "origin/main" }, root), undefined);
  assert.equal(rootKey("C:\\Users\\Me\\Documents\\Widgets\\"), rootKey("c:/users/me/documents/widgets"));
  assert.equal(rootKey("\\\\server\\Share\\Widgets"), rootKey("\\\\SERVER\\share\\widgets"));
  assert.notEqual(rootKey("/Users/me/Documents/Widgets"), rootKey("/Users/me/Documents/widgets"));
  // Branch names with # + @ are fine, a reflog spelling or a leading dash is not.
  assert.deepEqual(reviewArg({ dir: root, base: "origin/feat#12+x@y", head: "fix/a@b", strict: true }, root), { dir: root, base: "origin/feat#12+x@y", head: "fix/a@b", strict: true });
  assert.deepEqual(reviewArg({ dir: root, base: "origin/main", head: "@{-1}", strict: "yes" }, root), { dir: root, base: "origin/main" });
  assert.deepEqual(reviewArg({ dir: root, base: "origin/main", head: "-x" }, root), { dir: root, base: "origin/main" });
});

test("isUnder: a file is in a folder by its place in it, slashes either way, case ignored only on drive letters", async () => {
  const { isUnder } = await import("../src/client/ide/mode.js");
  assert.equal(isUnder("/work/widgets/src/a.ts", "/work/widgets"), true);
  assert.equal(isUnder("/work/widgets/src/a.ts", "/work/widgets/"), true);
  assert.equal(isUnder("/work/widgets-old/a.ts", "/work/widgets"), false, "a sibling that starts the same is not inside");
  assert.equal(isUnder("/work/Widgets/a.ts", "/work/widgets"), false);
  assert.equal(isUnder("C:\\Users\\Me\\widgets\\src\\a.ts", "c:/users/me/widgets"), true);
  assert.equal(isUnder("C:\\Users\\Me\\other\\a.ts", "C:\\Users\\Me\\widgets"), false);
  assert.equal(isUnder("/anything", ""), false);
});

test("installFileLinks marks a Shift-click's file event for the IDE, once, and leaves ⌘-clicks, other modes and chips that read their own click alone", async () => {
  const win = new EventTarget() as EventTarget & { localStorage?: unknown };
  Object.assign(globalThis, { window: win, addEventListener: win.addEventListener.bind(win), removeEventListener: win.removeEventListener.bind(win), dispatchEvent: win.dispatchEvent.bind(win) });
  const { setEdition } = await import("../src/client/edition.js");
  const { setMode } = await import("../src/client/ide/mode.js");
  const { installFileLinks, askForIde } = await import("../src/client/ide/file-links.js");
  setEdition("local");
  setMode("agents");
  const off = installFileLinks();
  const click = (shiftKey: boolean) => win.dispatchEvent(Object.assign(new Event("click"), { shiftKey }));
  const fire = (detail: Record<string, unknown>) => {
    win.dispatchEvent(new CustomEvent("friday:open-file", { detail, cancelable: true }));
    return detail;
  };
  try {
    click(true);
    assert.equal(fire({ path: "a.ts" }).ide, true, "Shift held on the click that fired it");
    click(false);
    assert.equal(fire({ path: "a.ts" }).ide, undefined, "a plain click");
    click(true);
    assert.equal(fire({ path: "a.ts", outside: true }).ide, undefined, "⌘-click is the person's own editor");
    click(true);
    assert.equal(fire({ path: "a.ts", ide: false }).ide, false, "a chip that read its own click is not second-guessed");
    // The window is the click's own turn: an event fired later from an async handler is not taken for a Shift-click.
    click(true);
    await new Promise((r) => setTimeout(r, 160));
    assert.equal(fire({ path: "a.ts" }).ide, undefined, "after the window");
    // In Code the mark does nothing: the file opens in the IDE anyway.
    setMode("code");
    click(true);
    assert.equal(fire({ path: "a.ts" }).ide, undefined, "Code mode");
    setMode("agents");
    // askForIde says whether a page opened it: a listener that sets `taken` did, one that only prevents the default did not.
    assert.equal(askForIde({ path: "a.ts" }), false, "nobody there");
    const only = (e: Event) => e.preventDefault();
    win.addEventListener("friday:open-file", only);
    assert.equal(askForIde({ path: "a.ts" }), false, "a viewer took it, the IDE did not open");
    win.removeEventListener("friday:open-file", only);
    const opens = (e: Event) => ((e as CustomEvent).detail.taken = true);
    win.addEventListener("friday:open-file", opens);
    assert.equal(askForIde({ path: "a.ts", line: 7 }), true);
    win.removeEventListener("friday:open-file", opens);
  } finally {
    off();
  }
});
