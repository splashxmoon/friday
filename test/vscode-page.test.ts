import { test } from "node:test";
import assert from "node:assert/strict";
import { absoluteIn, plainTrouble, sameRoot, askFromVscode, chooseView, clampChat, editorOf, formatBytes, progressOf, relativeIn, stageWord, statusEvery, type VsStatus } from "../src/client/ide/vscode-util.js";

const base: VsStatus = { supported: true, platform: "macos-arm64", version: "4.145.2", downloadBytes: 215_000_000, installed: null, installing: null, error: null, running: null };

test("sizes read as a person says them", () => {
  assert.equal(formatBytes(null), "");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1_500), "2 KB");
  assert.equal(formatBytes(1_200_000), "1.2 MB");
  assert.equal(formatBytes(84_000_000), "84 MB");
  assert.equal(formatBytes(214_700_000), "215 MB");
  assert.equal(formatBytes(1_230_000_000), "1.2 GB");
  assert.equal(formatBytes(2_000_000_000), "2 GB");
});

test("progress says the stage and how far", () => {
  assert.equal(stageWord("download"), "Downloading");
  assert.equal(stageWord("verify"), "Checking");
  assert.equal(stageWord("unpack"), "Unpacking");
  assert.deepEqual(progressOf({ received: 50_000_000, total: 200_000_000, stage: "download" }), { fraction: 0.25, line: "Downloading · 50 MB of 200 MB" });
  assert.deepEqual(progressOf({ received: 0, total: 0, stage: "download" }), { fraction: null, line: "Downloading…" });
  assert.deepEqual(progressOf({ received: 3_000_000, total: 0, stage: "download" }), { fraction: null, line: "Downloading · 3 MB" });
  assert.equal(progressOf({ received: 9, total: 3, stage: "download" }).fraction, 1);
  assert.deepEqual(progressOf({ received: 1, total: 1, stage: "unpack" }), { fraction: null, line: "Unpacking… step 3 of 3, about a minute" });
  assert.deepEqual(progressOf({ received: 1, total: 1, stage: "verify" }), { fraction: null, line: "Checking… step 2 of 3" });
});

test("the choice defaults to VS Code", () => {
  assert.equal(editorOf(null), "vscode");
  assert.equal(editorOf("nonsense"), "vscode");
  assert.equal(editorOf("friday"), "friday");
});

test("which view fills Code", () => {
  assert.deepEqual(chooseView({ editor: "friday", status: null }), { view: "friday", note: "" });
  assert.equal(chooseView({ editor: "vscode", status: null }).view, "loading");
  assert.equal(chooseView({ editor: "vscode", status: null, failed: true }).view, "friday");
  const un = chooseView({ editor: "vscode", status: { ...base, supported: false, platform: "freebsd-x64" } });
  assert.equal(un.view, "friday");
  assert.match(un.note, /freebsd-x64/);
  assert.equal(chooseView({ editor: "vscode", status: base }).view, "install");
  assert.equal(chooseView({ editor: "vscode", status: { ...base, installing: { received: 1, total: 2, stage: "download" } } }).view, "install");
  assert.equal(chooseView({ editor: "vscode", status: { ...base, installed: { version: "4.145.2", dir: "/x", bytes: 1 } } }).view, "vscode");
});

test("paths go both ways between the folder and the computer", () => {
  assert.equal(absoluteIn("/Users/a/app", "src/x.ts"), "/Users/a/app/src/x.ts");
  assert.equal(absoluteIn("/Users/a/app/", "./src/x.ts"), "/Users/a/app/src/x.ts");
  assert.equal(absoluteIn("C:\\Users\\a\\app", "src/x.ts"), "C:\\Users\\a\\app\\src\\x.ts");
  assert.equal(absoluteIn("C:\\Users\\a\\app", "D:\\other\\y.ts"), "D:\\other\\y.ts");
  assert.equal(relativeIn("/Users/a/app", "/Users/a/app/src/x.ts"), "src/x.ts");
  assert.equal(relativeIn("C:\\Users\\a\\app", "c:\\users\\a\\app\\src\\x.ts"), "src/x.ts");
  assert.equal(relativeIn("/Users/a/app", "/etc/hosts"), "/etc/hosts");
  assert.equal(relativeIn("/Users/a/app", "./src/x.ts"), "src/x.ts");
});

test("an ask from VS Code becomes what the panel takes", () => {
  assert.equal(askFromVscode("/r", null, 1), null);
  assert.equal(askFromVscode("/r", { path: "", from: 1, to: 1, text: "" }, 1), null);
  assert.deepEqual(askFromVscode("/r", { path: "/r/a.ts", from: 5, to: 3, text: "x" }, 9), { path: "a.ts", from: 5, to: 5, text: "x", nonce: 9 });
  assert.deepEqual(askFromVscode("/r", { path: "a.ts", from: 0, to: 2.7, text: "y" }, 2), { path: "a.ts", from: 1, to: 2, text: "y", nonce: 2 });
});

test("polling and width", () => {
  assert.equal(statusEvery(null), 30_000);
  assert.equal(statusEvery({ ...base, installing: { received: 0, total: 0, stage: "download" } }), 800);
  // 240px at the narrowest; at the widest, the window less the 360px VS Code keeps (1440 where there is no window).
  assert.equal(clampChat(100), 240);
  assert.equal(clampChat(9999), 1080);
  assert.equal(clampChat(9999, 240, 700), 700);
  assert.equal(clampChat(NaN), 380);
});

test("an ask is for one folder's window, and not an old one", () => {
  const ask = { path: "a.ts", from: 1, to: 1, text: "x", root: "/other" };
  assert.equal(askFromVscode("/r", ask, 5), null);
  assert.ok(askFromVscode("/r", { ...ask, root: "/r/" }, 5));
  assert.ok(askFromVscode("C:\\Users\\a", { ...ask, root: "c:/users/a" }, 5));
  assert.equal(askFromVscode("/r", { ...ask, root: "/r", at: 1000 }, 1000 + 61_000), null);
  assert.ok(askFromVscode("/r", { ...ask, root: "/r", at: 1000 }, 1000 + 5_000));
  assert.ok(askFromVscode("/r", { ...ask, root: "" }, 5));
  assert.equal(sameRoot("/a/b", "/a/B"), false);
});

test("a started VS Code is looked at quickly until it says it is ready", () => {
  const up = { ...base, running: { url: "u", root: "/r", ready: false } };
  assert.equal(statusEvery(up, 0), 500);
  assert.equal(statusEvery(up, 25_000), 30_000);
  assert.equal(statusEvery({ ...up, running: { url: "u", root: "/r", ready: true } }, 0), 30_000);
});

test("trouble reads as a sentence", () => {
  assert.match(plainTrouble("Failed to fetch"), /runner/);
  assert.equal(plainTrouble("No connection."), "No connection.");
});

test("a fix or an explain from the IDE: named by its first line, with the problem and the code", async () => {
  const { fixText, ticketText } = await import("../src/client/ide/AgentPanel.js");
  const fix = fixText({ kind: "fix", path: "src/refunds.ts", from: 21, to: 27, line: 24, text: "return c.curency;\n", problem: "Property 'curency' does not exist", source: "ts(2551)", nonce: 1 });
  assert.equal(fix.split("\n")[0], "Fix refunds.ts:24");
  assert.match(fix, /Reproduce it first/);
  assert.match(fix, /What ts\(2551\) said:\n```\nProperty 'curency' does not exist\n```/);
  assert.match(fix, /`src\/refunds.ts:21–27`\n```\nreturn c.curency;\n```/);
  const term = fixText({ kind: "explain", path: "", from: 1, to: 1, text: "", problem: "FAIL test/a.spec.ts", source: "the terminal · pnpm test refunds", nonce: 2 });
  assert.equal(term.split("\n")[0], "Explain `pnpm test refunds`");
  assert.match(term, /Don't change anything yet/);
  assert.match(ticketText("https://github.com/o/r/issues/12"), /^https:\/\/github.com\/o\/r\/issues\/12\n\nTake this ticket\./);
});

test("a ⌘K edit: named by file and line, held to those lines, and the instruction travels with the ask", async () => {
  const { fixText } = await import("../src/client/ide/AgentPanel.js");
  const edit = fixText({ kind: "edit", path: "src/api.ts", from: 12, to: 14, text: "const r = fetch(u);\n", instruction: "handle the 429", nonce: 1 });
  assert.equal(edit.split("\n")[0], "Edit api.ts:12");
  assert.match(edit, /Change ONLY lines 12–14 of `src\/api.ts`/);
  assert.match(edit, /Leave the commit to me/);
  // Read by the page's smart reach as a change (never "no changes", which put the chat in Plan, or a run), so the chat can edit.
  const { reachForMessage } = await import("../src/client/smartReach.js");
  const reach = reachForMessage(edit);
  assert.ok(!reach || reach.mode === "edits", `an edit is a change, got ${JSON.stringify(reach)}`);
  assert.match(edit, /What to change: handle the 429/);
  // A Windows path is named by its file, not by the whole path.
  assert.equal(fixText({ kind: "edit", path: "C:\\proj\\src\\api.ts", from: 3, to: 3, text: "x", instruction: "y", nonce: 2 }).split("\n")[0], "Edit api.ts:3");
  const a = askFromVscode("/r", { path: "/r/src/api.ts", from: 12, to: 14, text: "x", kind: "edit", instruction: "handle the 429", root: "/r", at: 1000 }, 1000);
  assert.equal(a?.kind, "edit");
  assert.equal(a?.instruction, "handle the 429");
});
