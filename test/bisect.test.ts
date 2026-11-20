import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { reachForMessage } from "../src/client/smartReach.js";
import { bisectText, byLine, fixForwardText, readBisect, revertText, shortSha } from "../src/client/bisect.js";
import { bisectFromAsk } from "../src/client/ide/AgentPanel.js";
import { askFromVscode, cwdIn } from "../src/client/ide/vscode-util.js";

const require = createRequire(import.meta.url);
const good = { commit: "3f9a1c2b7d", title: "Trim the intro", author: "Ana Ruiz", date: "2026-11-02", files: ["a.ts", "b.ts"], why: "Dropped the line.", check: "npm test" };

test("a bisect report is read, with bad parts made safe", () => {
  assert.deepEqual(readBisect(JSON.stringify(good)), good);
  const c = readBisect(JSON.stringify({ commit: "ABCDEF1", title: " t ", files: ["x", 5, "", "y"], why: 3, author: null }))!;
  assert.deepEqual([c.commit, c.title, c.files, c.why, c.author, c.date, c.check], ["ABCDEF1", "t", ["x", "y"], "", "", "", ""]);
  // Not a commit, no title, not an object, not JSON: drawn as plain code instead.
  assert.equal(readBisect(JSON.stringify({ ...good, commit: "not-a-sha" })), null);
  assert.equal(readBisect(JSON.stringify({ ...good, commit: "abc" })), null);
  assert.equal(readBisect(JSON.stringify({ ...good, title: "" })), null);
  assert.equal(readBisect("[]"), null);
  assert.equal(readBisect("{"), null);
  assert.equal(readBisect(JSON.stringify({ ...good, commit: "a".repeat(41) })), null);
  assert.equal(readBisect(JSON.stringify({ ...good, files: Array.from({ length: 30 }, (_, i) => "f" + i) }))!.files.length, 12);
});

test("short hash and byline", () => {
  assert.equal(shortSha("3f9a1c2b7d"), "3f9a1c2");
  assert.equal(byLine(good), "Ana Ruiz · 2026-11-02");
  assert.equal(byLine({ ...good, date: "" }), "Ana Ruiz");
  assert.equal(byLine({ ...good, author: "", date: "" }), "");
});

test("the ask keeps the person's checkout safe and asks for the block", () => {
  const t = bisectText();
  assert.match(t, /^Find what broke\n/);
  assert.match(t, /SEPARATE worktree/);
  assert.match(t, /uncommitted work and my branch must stay exactly as they are/);
  assert.match(t, /git bisect reset/);
  assert.match(t, /remove the worktree/);
  assert.match(t, /```friday-bisect/);
  assert.match(t, /ask me/);
  const c = bisectText({ command: "npm test", output: "FAIL checkout\n" });
  assert.match(c, /^Find what broke `npm test`\n/);
  assert.match(c, /Use `npm test` as the check/);
  assert.match(c, /FAIL checkout/);
  assert.match(bisectText({ what: "login 500s" }), /What broke: login 500s\. Find the commit/);
});

test("an ask from the IDE: a failed command is the check, else the person's words", () => {
  const a = { path: "", from: 1, to: 1, text: "", nonce: 1, kind: "bisect" as const };
  assert.match(bisectFromAsk({ ...a, source: "the terminal · pnpm test", problem: "boom" }), /Use `pnpm test` as the check[\s\S]*boom/);
  assert.match(bisectFromAsk({ ...a, source: "the editor", problem: "the page is blank" }), /What broke: the page is blank/);
});

test("the asks run where the agent can work, never in Plan", () => {
  for (const t of [bisectText(), bisectText({ command: "npm test" }), fixForwardText(good), revertText(good)]) {
    const r = reachForMessage(t);
    assert.ok(!r || r.mode !== "plan", t.split("\n")[0] + " " + JSON.stringify(r));
  }
});

test("fix and revert name the commit, and a revert is never pushed or made in the checkout", () => {
  assert.match(fixForwardText(good), /^Fix what 3f9a1c2 broke/);
  assert.match(fixForwardText(good), /Do not push/);
  const r = revertText(good);
  assert.match(r, /^Revert 3f9a1c2/);
  assert.match(r, /git revert/);
  assert.match(r, /separate worktree/);
  assert.match(r, /Do not push/);
});

test("the extension's commit rows pair each file's parent and commit sides", () => {
  const { commitRows, bisectAsk, EMPTY_TREE } = require("../src/vscode-ext/friday/bisect.js");
  const api = { toGitUri: (u: { fsPath: string }, ref: string) => `${u.fsPath}@${ref}` };
  const a = { fsPath: "/r/a.ts" };
  const rows = commitRows(api, null, [{ uri: a }, { uri: a }, { uri: { fsPath: "/r/b.ts" }, originalUri: { fsPath: "/r/old.ts" } }], "P", "C");
  assert.deepEqual(rows, [[a, "/r/a.ts@P", "/r/a.ts@C"], [{ fsPath: "/r/b.ts" }, "/r/old.ts@P", "/r/b.ts@C"]]);
  assert.equal(EMPTY_TREE.length, 40);
  assert.deepEqual(bisectAsk("/r", "it broke"), { kind: "bisect", path: "", from: 1, to: 1, text: "", root: "/r", problem: "it broke", source: "the editor" });
  const t = bisectAsk("/r", "", { cmd: "npm test", output: "x", cwd: "/r" });
  assert.deepEqual([t.source, t.problem, t.cwd], ["the terminal · npm test", "x", "/r"]);
});

test("a multi-line or backticked command goes in a block, and its folder is said", () => {
  const a = { path: "", from: 1, to: 1, text: "", nonce: 1, kind: "bisect" as const };
  const multi = bisectFromAsk({ ...a, source: "the terminal · npm test &&\n echo x", problem: "boom" });
  assert.match(multi, /Use the command below as the check[\s\S]*The command:\n```\nnpm test &&\n echo x\n```/);
  assert.match(multi, /boom/);
  assert.doesNotMatch(multi, /What broke:/);
  assert.match(multi.split("\n")[0], /^Find what broke `npm test &&`$/);
  const tick = bisectText({ command: "echo `date`" });
  assert.match(tick, /Use the command below as the check/);
  assert.match(tick, /```\necho `date`\n```/);
  assert.match(tick.split("\n")[0], /^Find what broke `echo 'date'`$/);
  const sub = bisectFromAsk({ ...a, source: "the terminal · npm test", problem: "x", cwd: "packages/api" });
  assert.match(sub, /Run it in `packages\/api` \(it failed there\)/);
  assert.doesNotMatch(bisectFromAsk({ ...a, source: "the terminal · npm test", problem: "x", cwd: "" }), /Run it in/);
  assert.match(bisectText({ command: "npm test", folder: "packages\\api\\" }), /Run it in `packages\/api`/);
});

test("a failed command's folder reaches the page as a relative one", () => {
  assert.equal(cwdIn("/r", "/r"), "");
  assert.equal(cwdIn("/r", "/r/packages/api"), "packages/api");
  assert.equal(cwdIn("/r", "/other/place"), "");
  assert.equal(cwdIn("C:\\r", "c:\\R\\packages\\api"), "packages/api");
  assert.equal(cwdIn("C:\\r", "C:\\r\\"), "");
  const ask = askFromVscode("/r", { path: "", from: 1, to: 1, text: "", kind: "bisect", problem: "x", source: "the terminal · npm test", cwd: "/r/pkg" }, 1);
  assert.equal(ask?.cwd, "pkg");
});

test("a first commit has rows with only an after side, and git's name-status is read", () => {
  const { commitRows, parseNameStatus, passedMemory } = require("../src/vscode-ext/friday/bisect.js");
  const api = { toGitUri: (u: { fsPath: string }, ref: string) => `${u.fsPath}@${ref}` };
  const u = (p: string) => ({ fsPath: p });
  const rows = commitRows(api, null, [{ uri: u("/r/a"), added: true }, { uri: u("/r/b"), deleted: true }, { uri: u("/r/c"), status: 1 }, { uri: u("/r/d") }], "T", "C");
  assert.deepEqual(rows, [[u("/r/a"), undefined, "/r/a@C"], [u("/r/b"), "/r/b@T", undefined], [u("/r/c"), undefined, "/r/c@C"], [u("/r/d"), "/r/d@T", "/r/d@C"]]);
  assert.deepEqual(parseNameStatus("A\0README.md\0M\0src/a b.ts\0D\0old.ts\0"), [
    { added: true, deleted: false, path: "README.md" },
    { added: false, deleted: false, path: "src/a b.ts" },
    { added: false, deleted: true, path: "old.ts" },
  ]);
  assert.deepEqual(parseNameStatus("R100\0a.ts\0b.ts\0"), [{ deleted: true, path: "a.ts" }, { added: true, path: "b.ts" }]);
  assert.deepEqual(parseNameStatus(""), []);
});

test("the passed-before memory keeps hashes, at most 60, and skips everyday commands", () => {
  const { passedMemory } = require("../src/vscode-ext/friday/bisect.js");
  const m = passedMemory(undefined);
  assert.equal(m.worked("npm test"), false);
  m.remember("npm test");
  m.remember("TOKEN=abc123 npm run deploy");
  assert.equal(m.worked("npm test"), true);
  assert.ok(m.list().every((h: string) => /^[0-9a-f]{16}$/.test(h)), "only hashes are kept");
  assert.ok(!JSON.stringify(m.list()).includes("abc123"));
  m.remember("ls -la");
  m.remember("cd packages");
  assert.equal(m.worked("ls -la"), false);
  for (let i = 0; i < 100; i++) m.remember(`make t${i}`);
  assert.equal(m.list().length, 60);
  assert.equal(m.worked("npm test"), false);
  assert.equal(m.worked("make t99"), true);
  const again = passedMemory(m.list());
  assert.equal(again.worked("make t99"), true);
});

test("the starter ends on a What broke line, and the SCM title has the command", () => {
  const pkg = require("../src/vscode-ext/friday/package.json");
  assert.ok(pkg.contributes.menus["scm/title"].some((m: { command: string }) => m.command === "friday.findBreak"));
});
