// An Agents session opened in Code is a linked tab (Arun, 2026-11-19: "ensure code and agent platform can be interconnected and
// streamlined for easy passing of work"): Agents keeps it in its list until "Move to Code", which hands it over.
import assert from "node:assert/strict";
import test from "node:test";

test("a linked chat stays Agents' own until it is moved to Code", async () => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const moved: string[] = [];
  (globalThis as { window?: unknown }).window = {
    addEventListener: () => {},
    dispatchEvent: (e: { type: string; detail?: { sid: string } }) => (e.type === "friday:code-moved" && moved.push(e.detail!.sid), true),
  };
  const m = await import("../src/client/ide/code-chats.js");

  m.linkCodeChat({ sid: "a1", invite: "inv", folder: "/work/app", title: "Fix login" });
  assert.equal(m.isCodeChat("a1"), false, "Agents keeps it");
  assert.equal(m.codeChatFor("/work/app")?.sid, "a1", "shown in its folder's column");
  assert.equal(m.linkedChatFor("/work/app")?.linked, true);
  assert.deepEqual(m.loadCodeChats().map((c) => c.sid), ["a1"]);

  // A chat of Code's own is never linked, and linking a known one only shows it.
  m.addCodeChat({ sid: "c1", invite: "i", folder: "/work/app", title: "New chat", at: 1 });
  assert.equal(m.isCodeChat("c1"), true);
  assert.equal(m.linkedChatFor("/work/app"), null, "the shown one is Code's own");
  m.linkCodeChat({ sid: "a1", invite: "inv", folder: "/work/app", title: "Fix login" });
  assert.equal(m.codeChatFor("/work/app")?.sid, "a1", "shown again, not added twice");
  assert.equal(m.loadCodeChats().filter((c) => c.sid === "a1").length, 1);
  m.linkCodeChat({ sid: "c1", invite: "i", folder: "/work/app", title: "x" });
  assert.equal(m.loadCodeChats().find((c) => c.sid === "c1")?.linked, undefined, "a Code chat stays Code's");

  // Move to Code: Code's now, and Agents is told to drop it. A chat that isn't linked is left alone.
  m.moveToCode("c1");
  assert.deepEqual(moved, []);
  m.moveToCode("a1");
  assert.equal(m.isCodeChat("a1"), true);
  assert.equal(m.linkedChatFor("/work/app"), null);
  assert.deepEqual(moved, ["a1"]);
  assert.ok(JSON.parse(store.get("friday.code.sids")!).includes("a1"), "kept for the next start");
});

test("linking follows a session's folder, closing a link ends it, and a session that leaves Agents loses its link", async () => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const events: string[] = [];
  (globalThis as { window?: unknown }).window = {
    addEventListener: () => {},
    dispatchEvent: (e: { type: string }) => (events.push(e.type), true),
  };
  const m = await import("../src/client/ide/code-chats.js");
  m.linkCodeChat({ sid: "s1", invite: "i", folder: "C:\\work\\app", title: "T" });
  // The session got a worktree: linking again moves it, with its tab, to the folder Code now opens on.
  m.linkCodeChat({ sid: "s1", invite: "i", folder: "C:\\work\\app-wt", title: "T" });
  assert.equal(m.codeChatFor("C:/work/app-wt")?.sid, "s1", "shown in the new folder");
  assert.deepEqual(m.loadCodeChats().filter((c) => c.sid === "s1").map((c) => c.folder), ["C:\\work\\app-wt"]);
  assert.equal(m.codeChatFor("c:/WORK/app")?.sid, undefined, "gone from the old one");

  // Undo of Move to Code: linked again, Agents told.
  m.moveToCode("s1");
  assert.equal(m.isCodeChat("s1"), true);
  m.handBack("s1");
  assert.equal(m.isCodeChat("s1"), false);
  assert.equal(m.linkedChatFor("C:/work/app-wt")?.sid, "s1");
  assert.ok(events.includes("friday:code-handed-back"));

  // Closing the linked tab ends the link; a Code chat's tab close keeps it in the history.
  m.addCodeChat({ sid: "c9", invite: "i", folder: "/p", title: "mine", at: 1 });
  m.linkCodeChat({ sid: "s2", invite: "i", folder: "/p", title: "linked" });
  m.closeCodeTab("/p", "s2");
  assert.deepEqual(m.loadCodeChats().map((c) => c.sid).filter((s) => ["c9", "s2"].includes(s)), ["c9"]);
  m.closeCodeTab("/p", "c9");
  assert.ok(m.loadCodeChats().some((c) => c.sid === "c9"), "Code's own stays in the history");

  // A session removed from Agents: its link goes, Code's own chats do not.
  m.linkCodeChat({ sid: "s3", invite: "i", folder: "/q", title: "x" });
  m.dropLinkedChat("s3");
  m.dropLinkedChat("c9");
  assert.ok(!m.loadCodeChats().some((c) => c.sid === "s3"));
  assert.ok(m.loadCodeChats().some((c) => c.sid === "c9"));
});

test("Review changes is asked for one folder, once, and not when old", async () => {
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const listeners: (() => void)[] = [];
  (globalThis as { window?: unknown }).window = { addEventListener: () => {}, dispatchEvent: () => true };
  void listeners;
  const mode = await import("../src/client/ide/mode.js");
  mode.wantReview("/a");
  assert.equal(mode.takeReviewWanted("/b"), false, "another folder's frame does not take it");
  assert.equal(mode.takeReviewWanted("/a"), true);
  assert.equal(mode.takeReviewWanted("/a"), false, "once");
  mode.wantReview("/a");
  mode.setMode("code");
  mode.setMode("agents");
  assert.equal(mode.takeReviewWanted("/a"), false, "leaving Code withdraws it");
});
