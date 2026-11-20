import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LIMITS, closeOthers, closeTab, closeToRight, cmpTab, cycleTab, diffTab, expandTo, fileTab, initialLayout, keepTab, moveTab, openTab, pinTab, removePaths, renamePaths,
  reopenClosed, sanitize, setSideView, toggleExpanded, clampBottom, clampSide, type IdeLayout,
} from "../src/client/ide/store.js";
import { fuzzy } from "../src/client/ide/fuzzy.js";
import { absPath, changedLines, relativeTo, symbolsOf } from "../src/client/ide/util.js";

const open = (s: IdeLayout, ...paths: string[]) => paths.reduce((a, p) => openTab(a, fileTab(p)), s);
const ids = (s: IdeLayout) => s.tabs.map((t) => t.id);

describe("tabs", () => {
  it("a preview is replaced by the next preview, a kept tab stays", () => {
    let s = openTab(initialLayout(), fileTab("a.ts", true));
    s = openTab(s, fileTab("b.ts", true));
    assert.deepEqual(ids(s), ["b.ts"]);
    s = keepTab(s, "b.ts");
    s = openTab(s, fileTab("c.ts", true));
    assert.deepEqual(ids(s), ["b.ts", "c.ts"]);
    assert.equal(s.active, "c.ts");
  });

  it("opening a preview again for real makes it stay; opening it as a preview leaves it", () => {
    let s = openTab(initialLayout(), fileTab("a.ts", true));
    s = openTab(s, fileTab("a.ts", true));
    assert.equal(s.tabs[0]!.preview, true);
    s = openTab(s, fileTab("a.ts", false));
    assert.equal(s.tabs[0]!.preview, false);
  });

  it("a new tab lands beside the active one", () => {
    let s = open(initialLayout(), "a", "b", "c");
    s = { ...s, active: "a" };
    s = openTab(s, fileTab("d"));
    assert.deepEqual(ids(s), ["a", "d", "b", "c"]);
  });

  it("closing the active tab goes to its right neighbour, else the left", () => {
    let s = open(initialLayout(), "a", "b", "c");
    s = { ...s, active: "b" };
    assert.equal(closeTab(s, "b").active, "c");
    s = { ...s, active: "c" };
    assert.equal(closeTab(s, "c").active, "b");
    assert.equal(closeTab(open(initialLayout(), "a"), "a").active, null);
  });

  it("closing others and to the right spares pinned tabs", () => {
    let s = open(initialLayout(), "a", "b", "c", "d");
    s = pinTab(s, "b", true);
    assert.deepEqual(ids(s), ["b", "a", "c", "d"]);
    assert.deepEqual(ids(closeOthers(s, "c")), ["b", "c"]);
    assert.deepEqual(ids(closeToRight(s, "a")), ["b", "a"]);
  });

  it("reopens closed files, newest first, and not diffs", () => {
    let s = open(initialLayout(), "a", "b");
    s = openTab(s, diffTab("a", false));
    s = closeTab(closeTab(closeTab(s, "a"), "b"), "diff:w:a");
    assert.equal(s.closed.length, 2);
    s = reopenClosed(s);
    assert.equal(s.active, "b");
    s = reopenClosed(s);
    assert.equal(s.active, "a");
    assert.equal(reopenClosed(s), s);
  });

  it("cycles round both ways", () => {
    let s = { ...open(initialLayout(), "a", "b", "c"), active: "c" };
    assert.equal(cycleTab(s, 1).active, "a");
    s = { ...s, active: "a" };
    assert.equal(cycleTab(s, -1).active, "c");
  });

  it("moves a tab before another, or to the end", () => {
    const s = open(initialLayout(), "a", "b", "c");
    assert.deepEqual(ids(moveTab(s, "c", "a")), ["c", "a", "b"]);
    assert.deepEqual(ids(moveTab(s, "a", null)), ["b", "c", "a"]);
  });

  it("a diff and a file of the same path are separate tabs", () => {
    let s = openTab(initialLayout(), fileTab("a.ts"));
    s = openTab(s, diffTab("a.ts", false));
    s = openTab(s, diffTab("a.ts", true));
    s = openTab(s, cmpTab("a.ts"));
    assert.equal(s.tabs.length, 4);
  });
});

describe("paths", () => {
  it("renaming a folder moves the tabs and open folders under it", () => {
    let s = open(initialLayout(), "src/a.ts", "src/deep/b.ts", "other.ts");
    s = { ...s, active: "src/a.ts", expanded: ["", "src", "src/deep"] };
    s = renamePaths(s, "src", "lib");
    assert.deepEqual(ids(s), ["lib/a.ts", "lib/deep/b.ts", "other.ts"]);
    assert.equal(s.active, "lib/a.ts");
    assert.deepEqual(s.expanded, ["", "lib", "lib/deep"]);
    assert.equal(s.tabs[0]!.path, "lib/a.ts");
  });

  it("a name that only starts the same is not moved", () => {
    const s = renamePaths(open(initialLayout(), "src2/a.ts"), "src", "lib");
    assert.deepEqual(ids(s), ["src2/a.ts"]);
  });

  it("deleting a folder closes its tabs and forgets them", () => {
    let s = open(initialLayout(), "src/a.ts", "keep.ts");
    s = removePaths(s, "src");
    assert.deepEqual(ids(s), ["keep.ts"]);
    assert.equal(s.closed.length, 0);
  });

  it("expandTo opens every folder on the way", () => {
    const s = expandTo(initialLayout(), "a/b/c.ts");
    assert.deepEqual(s.expanded, ["", "a", "a/b"]);
    assert.equal(expandTo(s, "a/b/c.ts"), s);
    assert.deepEqual(toggleExpanded(s, "a").expanded, ["", "a/b"]);
  });
});

describe("panels", () => {
  it("pressing the showing view hides the side bar; another view switches", () => {
    let s = initialLayout();
    s = setSideView(s, "explorer");
    assert.equal(s.side.open, false);
    s = setSideView(s, "git");
    assert.deepEqual([s.side.open, s.side.view], [true, "git"]);
  });

  it("sizes are kept in range", () => {
    assert.equal(clampSide(10), LIMITS.side.min);
    assert.equal(clampSide(9999), LIMITS.side.max);
    assert.equal(clampBottom(NaN as number) || LIMITS.bottom.min, LIMITS.bottom.min);
  });

  it("sanitize survives garbage and drops what can't be restored", () => {
    assert.deepEqual(sanitize(null), initialLayout());
    const s = sanitize({
      tabs: [{ id: "a", path: "a", kind: "file" }, { id: "a", path: "a", kind: "file" }, { id: "cmp:a", path: "a", kind: "cmp" }, { nope: 1 }, 5],
      active: "missing",
      side: { width: 99999, view: "weird" },
      bottom: { height: -5, tab: "output", open: true },
      expanded: ["", 4, "x"],
    });
    assert.deepEqual(ids(s), ["a"]);
    assert.equal(s.active, "a");
    assert.equal(s.side.width, LIMITS.side.max);
    assert.equal(s.side.view, "explorer");
    assert.equal(s.bottom.height, LIMITS.bottom.min);
    assert.equal(s.bottom.tab, "output");
    assert.deepEqual(s.expanded, ["", "x"]);
  });
});

describe("helpers", () => {
  it("fuzzy does not jump to a word start the rest of the query can't follow", () => {
    assert.ok(fuzzy("util", "src/lib/util.ts"));
    assert.deepEqual(fuzzy("util", "src/lib/util.ts")!.at, [8, 9, 10, 11]);
  });
  it("fuzzy prefers the file name, runs and word starts", () => {
    const a = fuzzy("deliv", "src/webhooks/deliver.ts")!;
    const b = fuzzy("deliv", "src/d/e/l/i/v.ts")!;
    assert.ok(a.score > b.score);
    assert.equal(fuzzy("zzz", "src/a.ts"), null);
    assert.deepEqual(fuzzy("", "x")!.at, []);
    assert.ok(fuzzy("wt", "src/webhooks/webhooks.test.ts")!.at.length === 2);
  });

  it("changedLines marks what was added or changed, 1-based", () => {
    assert.deepEqual(changedLines("a\nb\nc", "a\nb\nc"), []);
    assert.deepEqual(changedLines("a\nb\nc", "a\nX\nc"), [{ from: 2, to: 2 }]);
    assert.deepEqual(changedLines("a\nc", "a\nb1\nb2\nc"), [{ from: 2, to: 3 }]);
    assert.deepEqual(changedLines("a\nb\nc", "a\nc"), []);
    assert.deepEqual(changedLines("", "x\ny"), [{ from: 1, to: 2 }]);
    assert.deepEqual(changedLines("a\nb\nc\nd\ne", "a\nb2\nc\nd2\ne"), [{ from: 2, to: 2 }, { from: 4, to: 4 }]);
  });

  it("finds symbols by language", () => {
    const ts = "export async function deliver() {}\nconst x = 1;\nexport class Foo {\n  run() {}\n}\nexport const retry = (a: number) => a;\nexport interface Hook {}\nconst MAX_TRIES = 3;";
    const names = symbolsOf("a.ts", ts).map((s) => s.name);
    assert.deepEqual(names, ["deliver", "Foo", "retry", "Hook", "MAX_TRIES"]);
    assert.deepEqual(symbolsOf("a.py", "def f():\n    pass\nclass C:\n    def m(self): pass").map((s) => s.name), ["f", "C", "m"]);
    assert.deepEqual(symbolsOf("a.go", "func main() {}\nfunc (s *S) Run() {}\ntype S struct{}").map((s) => s.name), ["main", "Run", "S"]);
    assert.deepEqual(symbolsOf("a.rs", "pub fn go() {}\nstruct A;").map((s) => s.name), ["go", "A"]);
    assert.deepEqual(symbolsOf("a.md", "# Title\ntext\n## Part").map((s) => s.name), ["Title", "Part"]);
    assert.deepEqual(symbolsOf("a.bin", "function x(){}"), []);
  });

  it("writes and reads paths the way each computer does", () => {
    assert.equal(absPath("C:\\Users\\a\\app", "src/x.ts"), "C:\\Users\\a\\app\\src\\x.ts");
    assert.equal(absPath("/Users/a/app/", "src/x.ts"), "/Users/a/app/src/x.ts");
    assert.equal(absPath("/r", ""), "/r");
    assert.equal(relativeTo("C:\\Users\\a\\app", "C:\\Users\\a\\app\\src\\x.ts"), "src/x.ts");
    assert.equal(relativeTo("/Users/a/app", "/Users/a/app/src/x.ts"), "src/x.ts");
    assert.equal(relativeTo("/Users/a/app", "/etc/hosts"), null);
    assert.equal(relativeTo("/Users/a/app", "./src/x.ts"), "src/x.ts");
  });
});
