import assert from "node:assert/strict";
import { test } from "node:test";
import { flatRows, foundNow, mergeSearch, rankChats, rankFiles, rankSessions, splitLine } from "../src/client/ide/search-rank.js";
import { sameFolder } from "../src/client/ide/code-chats.js";

const same = (a: string, b: string) => a === b;

test("splitLine takes a trailing :line off the query", () => {
  assert.deepEqual(splitLine("app.ts:42"), { q: "app.ts", line: 42 });
  assert.deepEqual(splitLine("app.ts"), { q: "app.ts" });
  assert.deepEqual(splitLine("foo:"), { q: "foo:" });
});

test("files: a name that starts with the query beats a deep path, and every letter must be there", () => {
  const files = ["src/deep/nested/appendix/utils.ts", "src/app.ts", "docs/readme.md", "src/client/App.tsx", "lib/a/p/p.ts"];
  const r = rankFiles(files, "app");
  assert.equal(r[0]!.kind, "file");
  assert.equal((r[0] as { path: string }).path, "src/app.ts");
  assert.ok(!r.some((x) => (x as { path: string }).path === "docs/readme.md"), "no match, not listed");
  assert.deepEqual(rankFiles(files, "zzzq"), []);
  assert.deepEqual(rankFiles(files, "   "), []);
});

test("files: the line is kept, and the best few come first in score order", () => {
  const files = Array.from({ length: 50 }, (_, i) => `pkg${i}/src/index.ts`).concat("src/index.ts");
  const r = rankFiles(files, "index.ts:7", 5);
  assert.equal(r.length, 5);
  assert.equal((r[0] as { path: string }).path, "src/index.ts", "the shortest path of equal names is first");
  assert.ok(r.every((x) => (x as { line?: number }).line === 7));
});

test("files: 20 000 paths answer in a few milliseconds, well under 300 ms on any machine", () => {
  const files: string[] = [];
  for (let i = 0; i < 20000; i++) files.push(`packages/pkg${i % 200}/src/feature${i % 37}/component${i}.tsx`);
  files.push("src/client/ide/CodeSearch.tsx");
  rankFiles(files, "warm");
  let best = Infinity;
  for (const q of ["codesearch", "cmp1999", "src/client"]) {
    const t = performance.now();
    const r = rankFiles(files, q);
    best = Math.min(best, performance.now() - t);
    assert.ok(r.length > 0);
  }
  // Here a few ms; a shared Windows CI runner took 123. The bound is for a search gone slow (a sort of everything, a regex per
  // path), not for the machine: still well inside a keystroke's budget.
  assert.ok(best < 300, `took ${best.toFixed(1)} ms`);
  assert.equal((rankFiles(files, "codesearch")[0] as { path: string }).path, "src/client/ide/CodeSearch.tsx");
});

test("chats: every word in the title, this folder's first, then newest; no words lists this folder's", () => {
  const chats = [
    { sid: "a", title: "Fix login bug", folder: "/x", at: 10 },
    { sid: "b", title: "Fix login redirect", folder: "/y", at: 99 },
    { sid: "c", title: "Docs", folder: "/y", at: 50 },
  ];
  const r = rankChats(chats, "fix login", "/x", same);
  assert.deepEqual(r.map((x) => (x as { sid: string }).sid), ["a", "b"]);
  assert.deepEqual(rankChats(chats, "", "/y", same).map((x) => (x as { sid: string }).sid), ["b", "c"]);
  assert.deepEqual(rankChats(chats, "", null, same), []);
});

test("sessions: by title, then by what was said, each once, and never a Code chat's sid", () => {
  const sessions = [
    { sid: "s1", title: "Billing page", at: 5 },
    { sid: "s2", title: "Search work", at: 9 },
  ];
  const found = [
    { sid: "s1", title: "Billing page", at: 5, snippet: "the search box", who: "You" },
    { sid: "s3", title: "Other", at: 7, snippet: "search index", invite: "inv" },
  ];
  const r = rankSessions(sessions, found, "search", new Set(["s2"]));
  assert.deepEqual(r.map((x) => (x as { sid: string }).sid), ["s1", "s3"]);
  assert.equal((r[0] as { snippet?: string }).snippet, "You: the search box");
  assert.equal((r[1] as { invite?: string }).invite, "inv");
});

test("mergeSearch: files, chats, sessions, then the two IDE hand-offs last; nothing typed shows only chats and sessions", () => {
  const input = {
    files: ["src/search.ts", "README.md"],
    chats: [{ sid: "c1", title: "Search ranking", folder: "/x", at: 3 }],
    sessions: [{ sid: "s1", title: "Search the web", at: 4 }],
    folder: "/x",
    same,
  };
  const g = mergeSearch({ ...input, query: "search" });
  assert.deepEqual(g.map((x) => x.id), ["files", "chats", "sessions", "ide"]);
  const last = flatRows(g).slice(-2);
  assert.deepEqual(last.map((r) => r.kind), ["symbols", "text"]);
  assert.equal((last[0] as { query: string }).query, "search");
  const none = mergeSearch({ ...input, query: "" });
  assert.deepEqual(none.map((x) => x.id), ["chats", "sessions"]);
  // A thing found by what was said in a Code chat is the chat's row, not a session's.
  const said = mergeSearch({ ...input, query: "zzz", found: [{ sid: "c1", title: "Search ranking", at: 3, snippet: "zzz here", who: "You" }] });
  const rows = flatRows(said);
  assert.ok(rows.some((r) => r.kind === "chat" && r.snippet === "You: zzz here"));
  assert.ok(!rows.some((r) => r.kind === "session"));
});

test("the ide hand-offs keep the whole query for text and drop a :line for symbols", () => {
  const g = mergeSearch({ files: [], chats: [], sessions: [], query: "foo:12", folder: null, same });
  const rows = flatRows(g);
  assert.equal((rows[0] as { query: string }).query, "foo");
  assert.equal((rows[1] as { query: string }).query, "foo:12");
});

test("sameFolder is the one code-chats uses", () => {
  assert.equal(sameFolder("/a/b", "/a/b"), true);
});

test("the extension hands the words to the IDE's symbol quick open and Find in Files", async () => {
  const { createRequire } = await import("node:module");
  const search = createRequire(import.meta.url)("../src/vscode-ext/friday/search.js") as { symbols: (v: unknown, q: string) => Promise<void>; text: (v: unknown, q: string) => Promise<void> };
  const calls: unknown[][] = [];
  const vscode = { commands: { executeCommand: async (...a: unknown[]) => void calls.push(a) } };
  await search.symbols(vscode, "Foo");
  await search.text(vscode, "needle");
  assert.deepEqual(calls[0], ["workbench.action.quickOpen", "#Foo"]);
  assert.equal(calls[1]![0], "workbench.action.findInFiles");
  assert.deepEqual(calls[1]![1], { query: "needle", triggerSearch: true, isRegex: false, isCaseSensitive: false, matchWholeWord: false });
});

test("server hits for other words are not shown under the new ones", () => {
  const sessions = [{ sid: "a", title: "Invoice work", at: 1 }];
  const kept = { q: "refund", rows: [{ sid: "r", title: "Refund work", at: 2 }] };
  const stale = mergeSearch({ query: "invoice", files: [], chats: [], sessions, found: foundNow(kept, "invoice", [], () => false), folder: null, same });
  assert.deepEqual(flatRows(stale).filter((r) => r.kind === "session").map((r) => (r as { sid: string }).sid), ["a"]);
  assert.equal(foundNow(kept, "refund", [], () => false).length, 1, "still shown for the words they were found for");
});

test("a chat off Code's history is not offered as an Agents session, one still in it is", () => {
  const kept = { q: "x", rows: [{ sid: "gone", title: "Gone", at: 1 }, { sid: "kept", title: "Kept", at: 1 }] };
  const chats = [{ sid: "kept", title: "Kept", folder: "/a", at: 1 }];
  const got = foundNow(kept, "x", chats, (sid) => sid === "gone" || sid === "kept");
  assert.deepEqual(got.map((f) => f.sid), ["kept"]);
});

test("a backslash path matches the slash listing, and the IDE's hand-offs wait for the IDE", () => {
  const r = rankFiles(["src/app.ts", "src/lib/other.ts"], "src\\app.ts");
  assert.equal((r[0] as { path: string }).path, "src/app.ts");
  const g = mergeSearch({ query: "app", files: ["src/app.ts"], chats: [], sessions: [], folder: "/a", same, ide: false });
  assert.ok(!g.some((x) => x.id === "ide"));
  assert.ok(mergeSearch({ query: "app", files: ["src/app.ts"], chats: [], sessions: [], folder: "/a", same }).some((x) => x.id === "ide"));
});

test("marks cover the whole stretch of the name that holds the query", () => {
  const r = rankFiles(["src/search.ts"], "search")[0] as { marks: number[] };
  assert.deepEqual(r.marks, [4, 5, 6, 7, 8, 9]);
});
