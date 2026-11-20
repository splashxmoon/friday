import assert from "node:assert/strict";
import { test } from "node:test";
import { agentsWaiting, codeWhere, folderName, openWaiting, watchedSids } from "../src/client/ide/waiting.js";

test("folder names read from either slash style", () => {
  assert.equal(folderName("/Users/a/app"), "app");
  assert.equal(folderName("C:\\work\\app\\"), "app");
  assert.equal(codeWhere({ folder: "/x/y/proj/" }), "Code · proj");
});

test("Code's chats are asked about once, after Agents' own, newest 40 only", () => {
  const code = Array.from({ length: 50 }, (_, i) => ({ sid: `c${i}` }));
  const got = watchedSids(["a", "b", "c0"], ["t", "a"], code);
  assert.deepEqual(got.slice(0, 4), ["a", "b", "c0", "t"]);
  assert.equal(got.length, 4 + 39);
  assert.ok(!got.includes("c40"));
  assert.deepEqual(watchedSids([], [], []), []);
});

test("the footer counts what waits in Agents, never Code's own chats, reviews or what is put off", () => {
  const isCode = (s: string) => s.startsWith("c");
  const needs = [
    { sid: "a1", kind: "approval" },
    { sid: "c1", kind: "approval" },
    { sid: "a2", kind: "question", putOff: true },
    { kind: "review" },
    { kind: "crew" },
  ];
  assert.equal(agentsWaiting(needs, isCode), 2);
  assert.equal(agentsWaiting([], isCode), 0);
});

test("opening a wait hands the session to the app's one router, with the way in when it has one", () => {
  const seen: { type: string; detail: unknown }[] = [];
  const g = globalThis as unknown as { window?: unknown; CustomEvent?: unknown };
  const had = { window: g.window, CustomEvent: g.CustomEvent };
  g.CustomEvent = class { type: string; detail: unknown; constructor(type: string, init: { detail: unknown }) { this.type = type; this.detail = init.detail; } };
  g.window = { dispatchEvent: (e: { type: string; detail: unknown }) => void seen.push({ type: e.type, detail: e.detail }) };
  try {
    openWaiting("s1");
    openWaiting("s2", "inv");
  } finally {
    g.window = had.window;
    g.CustomEvent = had.CustomEvent;
  }
  assert.deepEqual(seen, [
    { type: "friday:open-session", detail: { sid: "s1" } },
    { type: "friday:open-session", detail: { sid: "s2", invite: "inv" } },
  ]);
});
