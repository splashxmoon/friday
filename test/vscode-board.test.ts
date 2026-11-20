import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { test } from "node:test";
import { agentsInFolder, codeForBoard, dirKey, mergeTasks, sameDir } from "../src/vscode-board.js";

const require = createRequire(import.meta.url);
const label = require("../src/vscode-ext/friday/board-label.js") as {
  whereLabel: (x: unknown) => string;
  contextOf: (x: unknown) => string;
  ownTasks: (x: unknown[]) => { sid: string }[];
  sidOf: (x: unknown) => string;
};

const sess = (sid: string, openedAt: number, repos: { path?: string; worktree?: boolean; cwd?: string }[], title = sid) => ({ sid, title, openedAt, repos });
const never = () => false;

test("folders compare as Code's do", () => {
  assert.equal(dirKey("C:\\Dev\\App\\"), "c:/dev/app");
  assert.ok(sameDir("/a/b/", "/a/b"));
  assert.ok(!sameDir("/a/b", "/a/B"));
  assert.ok(!sameDir("", ""));
});

test("agents in the folder: its own folder, or the folder its worktree copies", () => {
  const list = [
    sess("a", 1, [{ path: "/work/app" }]),
    sess("b", 3, [{ path: "/work/app", worktree: true, cwd: "/tmp/wt/app-1" }]),
    sess("c", 2, [{ path: "/work/other" }]),
    sess("d", 4, [{ path: "/work/other", worktree: true, cwd: "/work/app" }]),
    sess("e", 5, []),
  ];
  const rows = agentsInFolder(list, "/work/app/", never);
  assert.deepEqual(rows.map((r) => r.sid), ["d", "b", "a"], "newest first; a worktree of the folder counts");
  assert.ok(rows.every((r) => r.folder === "/work/app/"));
  assert.deepEqual(agentsInFolder(list, null, never), []);
});

test("agents in the folder: never a Code chat, never one Code already lists, alias wins", () => {
  const list = [sess("a", 1, [{ path: "/x" }], "plain"), sess("b", 2, [{ path: "/x" }]), sess("c", 3, [{ path: "/x" }])];
  (list[0] as { alias?: string }).alias = "named";
  const rows = agentsInFolder(list, "/x", (sid) => sid === "b", new Set(["c"]));
  assert.deepEqual(rows.map((r) => [r.sid, r.title]), [["a", "named"]]);
});

test("the IDE's list: Code's first, Agents' after, each saying where; a session shows once", () => {
  const code = [
    { sid: "c1", title: "Fix login", folder: "/x", tool: "claude", at: 5 },
    { sid: "L", title: "Linked", folder: "/x", tool: "", at: 4, linked: true },
  ];
  const agents = [
    { sid: "a1", title: "Refactor", folder: "/x", tool: "", at: 9 },
    { sid: "L", title: "Linked", folder: "/x", tool: "", at: 4 },
  ];
  const merged = mergeTasks(code, agents);
  assert.deepEqual(merged.map((t) => [t.sid, t.where]), [["c1", "code"], ["L", "agents"], ["a1", "agents"]]);
  assert.equal((merged[1] as { linked?: boolean }).linked, true, "a linked tab stays marked linked");
});

test("Agents' board: Code's own chats in folders it knows, newest first, never a linked tab", () => {
  const chats = [
    { sid: "1", folder: "/work/app", at: 1 },
    { sid: "2", folder: "/work/app/", at: 3 },
    { sid: "3", folder: "/elsewhere", at: 9 },
    { sid: "4", folder: "/work/app", at: 8, linked: true },
    { sid: "5", folder: "/open/now", at: 2 },
  ];
  assert.deepEqual(codeForBoard(chats, ["/work/app"], "/open/now").map((c) => c.sid), ["2", "5", "1"]);
  assert.deepEqual(codeForBoard(chats, ["/work/app"], null, 1).map((c) => c.sid), ["2"]);
  assert.deepEqual(codeForBoard(chats, [], null), []);
  // A session working in a worktree of /work/app names both folders; either one finds the chat.
  assert.deepEqual(codeForBoard(chats, ["/tmp/wt/app", "/work/app"], null).map((c) => c.sid), ["2", "1"]);
});

test("the Tasks view's words and what it passes on", () => {
  assert.equal(label.whereLabel({ where: "code" }), "Code");
  assert.equal(label.whereLabel({ where: "agents" }), "Agents");
  assert.equal(label.whereLabel({ where: "agents", linked: true }), "Agents · open in Code");
  assert.equal(label.whereLabel({}), "Code");
  assert.equal(label.contextOf({ where: "agents" }), "friday.task.agents");
  assert.equal(label.contextOf({ where: "agents", linked: true }), "friday.task.linked");
  assert.equal(label.contextOf({ where: "code" }), "friday.task.code");
  assert.deepEqual(label.ownTasks([{ sid: "a", where: "agents" }, { sid: "b", where: "code" }, { sid: "c", where: "agents", linked: true }]).map((x) => x.sid), ["b", "c"]);
  assert.equal(label.sidOf("s1"), "s1");
  assert.equal(label.sidOf({ task: { sid: "s2" } }), "s2");
  assert.equal(label.sidOf(undefined), "");
});
