import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { ideActionList, withoutIde, type IdeActionState } from "../src/client/ide/palette-actions.js";
import { PAGE_ACTIONS, cleanFeed, isPageAction } from "../src/vscode-palette.js";

const require = createRequire(import.meta.url);
const palette = require("../src/vscode-ext/friday/palette.js");
const dir = path.resolve(import.meta.dirname, "..", "src", "vscode-ext", "friday");

const chats = [{ sid: "a", title: "Fix login", folder: "/work/app", detail: "Running" }, { sid: "b", title: "Add tests", folder: "/work/other" }];
const full = { folder: "/work/app", chat: true, changes: true, editor: true, codeChats: chats, agents: [{ sid: "s", invite: "i", title: "T" }] };
const ids = (state: object, mac = true) => palette.actionList(state, mac).map((a: { id: string }) => a.id);

test("the IDE's list, with everything there: each Friday action in order", () => {
  assert.deepEqual(ids(full), ["new-chat", "ask-codebase", "ask-agent", "race", "review", "self-review", "send-to-agents", "hand-to-mate", "find-break", "refactor", "switch-tool", "open-chat", "open-session", "search", "agents", "toggle-chat", "settings"]);
});

test("no folder: only what needs none (open a folder, the lists, search, Agents, settings)", () => {
  assert.deepEqual(ids({ folder: "", chat: false, editor: false, codeChats: chats, agents: [{}] }), ["open-chat", "open-session", "open-folder", "search", "agents", "toggle-chat", "settings"]);
  assert.deepEqual(ids({ folder: "", codeChats: [], agents: [] }), ["open-folder", "search", "agents", "toggle-chat", "settings"]);
});

test("no chat in the column: no self-review, no send to Agents", () => {
  const got = ids({ ...full, chat: false });
  assert.ok(!got.includes("self-review") && !got.includes("send-to-agents") && !got.includes("hand-to-mate"));
  assert.ok(got.includes("new-chat") && got.includes("review") && got.includes("race"));
});

test("nothing to review: no review and no self-review, the rest stay", () => {
  const got = ids({ ...full, changes: false });
  assert.ok(!got.includes("review") && !got.includes("self-review"));
  assert.ok(got.includes("send-to-agents") && got.includes("find-break"));
  // Not known (undefined) is not "none".
  assert.ok(ids({ ...full, changes: undefined }).includes("review"));
});

test("no file open: no ask about this code; the empty lists leave their rows out", () => {
  assert.ok(!ids({ ...full, editor: false }).includes("ask-agent"));
  const got = ids({ ...full, codeChats: [], agents: [] });
  assert.ok(!got.includes("open-chat") && !got.includes("open-session"));
});

test("chords are said as the keyboard has them, for the actions that have one", () => {
  const mac = Object.fromEntries(palette.actionList(full, true).map((a: { id: string; chord: string }) => [a.id, a.chord]));
  const pc = Object.fromEntries(palette.actionList(full, false).map((a: { id: string; chord: string }) => [a.id, a.chord]));
  assert.equal(mac["ask-codebase"], "⌘⌥A");
  assert.equal(pc["ask-codebase"], "Ctrl+K Ctrl+A");
  assert.equal(mac["ask-agent"], "⌘L");
  assert.equal(mac.agents, "⌘E");
  assert.equal(pc["toggle-chat"], "Ctrl+Alt+B");
  assert.equal(mac["new-chat"], "");
  // The count a pick has shows under its row.
  assert.equal(palette.actionList(full, true).find((a: { id: string }) => a.id === "open-chat").detail, "2 to pick from");
});

test("review is ruled out only where git can say so: main, clean, in step, no agent changing files", () => {
  assert.equal(palette.reviewable(null), undefined);
  assert.equal(palette.reviewable({ branch: "main", dirty: false, ahead: 0, taskFiles: 0 }), false);
  assert.equal(palette.reviewable({ branch: "master", dirty: false, ahead: 0, taskFiles: 0 }), false);
  assert.equal(palette.reviewable({ branch: "main", dirty: true, ahead: 0, taskFiles: 0 }), true);
  assert.equal(palette.reviewable({ branch: "main", dirty: false, ahead: 2, taskFiles: 0 }), true);
  assert.equal(palette.reviewable({ branch: "main", dirty: false, ahead: undefined, taskFiles: 0 }), true);
  assert.equal(palette.reviewable({ branch: "main", dirty: false, ahead: 0, taskFiles: 1 }), true);
  assert.equal(palette.reviewable({ branch: "feature/x", dirty: false, ahead: 0, taskFiles: 0 }), true);
});

test("the page's list is the IDE's: the same ids, in the same order, for the same state", () => {
  const page: IdeActionState = { folder: "/work/app", hasChat: true, changes: true, chats: chats.map(({ sid, title, folder }) => ({ sid, title, folder })), agents: 1, where: "ide" };
  const mine = ideActionList(page).map((a) => a.id);
  // The IDE alone has "ask an agent about this code" (it needs an open file).
  assert.deepEqual(mine, ids(full).filter((x: string) => x !== "ask-agent"));
  for (const state of [{ folder: "", chat: false, codeChats: chats, agents: [{}] }, { folder: "/w", chat: false, changes: false, codeChats: [], agents: [] }, { folder: "/w", chat: true, changes: false, codeChats: chats, agents: [] }]) {
    const p = ideActionList({ folder: state.folder || null, hasChat: !!state.chat, changes: state.changes !== false, chats: state.codeChats as never, agents: state.agents.length, where: "ide" }).map((a) => a.id);
    assert.deepEqual(p, ids({ ...state, editor: false }));
  }
});

test("in the page's palette the chats are rows of their own, the folder's first", () => {
  const list = ideActionList({ folder: "/work/app", hasChat: false, changes: true, chats: chats.map(({ sid, title, folder }) => ({ sid, title, folder })), agents: 3, where: "page" });
  assert.ok(!list.some((a) => a.id === "open-chat" || a.id === "open-session"));
  // The page's palette has its own search and Settings.
  assert.ok(!list.some((a) => a.id === "search" || a.id === "settings"));
  const rows = list.filter((a) => a.sid);
  assert.deepEqual(rows.map((a) => [a.id, a.label]), [["chat:a", "Fix login"], ["chat:b", "Add tests"]]);
  // Without a folder, the chats still open (they bring their own folder).
  assert.equal(ideActionList({ folder: null, hasChat: false, changes: true, chats: [chats[0]!], agents: 0, where: "page" }).filter((a) => a.sid).length, 1);
});

test("the ids the IDE sends to the page are the ones the server passes on", () => {
  assert.deepEqual([...palette.PAGE_ACTIONS], [...PAGE_ACTIONS]);
  for (const d of palette.DEFS) if (d.page) assert.ok(isPageAction(d.page), d.id);
  assert.ok(isPageAction("race") && !isPageAction("rm -rf") && !isPageAction(undefined));
  // Everything an action runs in the IDE is a command the extension has.
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const have = new Set(pkg.contributes.commands.map((c: { command: string }) => c.command));
  for (const d of palette.DEFS) if (d.command) assert.ok(have.has(d.command) || d.command === "friday.askAgent", d.command);
  assert.ok(have.has("friday.palette"));
});

// VS Code's key codes and modifier bits (vs/base/common/keyCodes): a default binding is stored as one number, mods + key.
const MOD = { ctrlCmd: 2048, shift: 1024, alt: 512 };
const QUOTE = 95;
// Chords the IDE binds by default that a palette key might be mistaken for (read off the bundled workbench; "Focus Breadcrumbs" is
// Cmd/Ctrl+Shift+; and was Friday's first pick).
const IDE_TAKES = [["ctrl+shift+;", "breadcrumbs.focus"], ["ctrl+shift+.", "breadcrumbs.focusAndSelect"], ["ctrl+shift+,", "the breadcrumbs' neighbour"], ["ctrl+shift+/", "parameter hints"], ["ctrl+shift+\\", "jump to bracket"]];

test("the key and the status bar button open it; the key is not one the IDE already binds", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const key = pkg.contributes.keybindings.find((k: { command: string }) => k.command === "friday.palette");
  assert.equal(key.key, "ctrl+shift+'");
  assert.equal(key.mac, "cmd+shift+'");
  assert.deepEqual(palette.KEYS.palette, ["⌘⇧'", "Ctrl+Shift+'"]);
  for (const [chord, what] of IDE_TAKES) assert.notEqual(key.key, chord, `${chord} is the IDE's ${what}`);
  const others = pkg.contributes.keybindings.filter((k: { command: string; key: string }) => k.command !== "friday.palette" && k.key === key.key);
  assert.equal(others.length, 0);
  // Against the IDE's own list, when a bundled IDE is at hand (FRIDAY_VSCODE_BUNDLED, or the one the session set up): no default
  // keybinding is Ctrl/Cmd+Shift+' (primary, mac, win, linux or secondary).
  const bundled = [process.env.FRIDAY_VSCODE_BUNDLED, process.env.FRIDAY_IDE_DEFAULTS_FROM].filter(Boolean) as string[];
  for (const b of bundled) {
    const file = path.join(b, "lib", "vscode", "out", "vs", "code", "browser", "workbench", "workbench.js");
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    const taken = new Set<number>();
    for (const m of src.matchAll(/(?:primary|mac|win|linux|secondary):\s*(\d{3,5})\b/g)) taken.add(Number(m[1]));
    assert.ok(taken.has(MOD.ctrlCmd + MOD.shift + 85), "the scan finds the IDE's known Cmd+Shift+; (breadcrumbs)");
    assert.ok(!taken.has(MOD.ctrlCmd + MOD.shift + QUOTE), "Cmd/Ctrl+Shift+' is free in the IDE's defaults");
  }
});

test("the page's list says each chord as the keyboard has it, Mac and elsewhere", () => {
  const list = ideActionList({ folder: "/w", hasChat: true, changes: true, chats: [], agents: 1, where: "ide" });
  const by = Object.fromEntries(list.map((a) => [a.id, a.hint]));
  assert.deepEqual(by["ask-codebase"], ["⌘⌥A", "Ctrl+K Ctrl+A"]);
  assert.deepEqual(by["toggle-chat"], ["⌘⌥B", "Ctrl+Alt+B"]);
  assert.deepEqual(by.agents, ["⌘E", "Ctrl+E"]);
  // The same chords as the IDE's own list gives them.
  const mine = Object.fromEntries(palette.actionList(full, true).map((a: { id: string; chord: string }) => [a.id, a.chord]));
  const pcs = Object.fromEntries(palette.actionList(full, false).map((a: { id: string; chord: string }) => [a.id, a.chord]));
  for (const a of list) if (a.hint && mine[a.id]) assert.deepEqual([mine[a.id], pcs[a.id]], a.hint, a.id);
});

test("while the IDE is not up, the page's palette keeps only what needs none: Agents and the chats", () => {
  const list = ideActionList({ folder: "/work/app", hasChat: true, changes: true, chats: chats.map(({ sid, title, folder }) => ({ sid, title, folder })), agents: 2, where: "page" });
  assert.deepEqual(withoutIde(list).map((a) => a.id), ["agents", "chat:a", "chat:b"]);
  assert.deepEqual(withoutIde(ideActionList({ folder: null, hasChat: false, changes: true, chats: [], agents: 0, where: "page" })).map((a) => a.id), ["agents"]);
});

test("the feed keeps only what is well formed", () => {
  const f = cleanFeed({ agents: [{ sid: "s1", invite: "inv", title: "A", at: 5 }, { sid: "", invite: "x" }, { sid: "s2" }, null, "no"], chat: { sid: "c1", folder: "/f", title: "T" } });
  assert.deepEqual(f.agents, [{ sid: "s1", invite: "inv", title: "A", at: 5 }]);
  assert.deepEqual(f.chat, { sid: "c1", folder: "/f", title: "T" });
  assert.deepEqual(cleanFeed("junk"), { agents: [], chat: null });
  assert.equal(cleanFeed({ chat: { sid: "" } }).chat, null);
  assert.equal(cleanFeed({ agents: Array.from({ length: 50 }, (_, i) => ({ sid: `s${i}`, invite: "i" })) }).agents.length, 20);
});

test("registering: the command opens the pick, choosing a row sends its key; the sparkle is in the status bar", async () => {
  const sent: [string, object | undefined][] = [];
  let shown: { label: string }[] = [];
  const handlers: Record<string, () => unknown> = {};
  const items: { text: string; command: string; shown: boolean }[] = [];
  const vscode = {
    commands: { registerCommand: (id: string, fn: () => unknown) => ((handlers[id] = fn), { dispose() {} }), executeCommand: async () => {} },
    window: {
      activeTextEditor: undefined,
      showQuickPick: async (rows: { label: string }[]) => ((shown = rows), rows.find((r) => r.label.includes("Race this ask"))),
      createStatusBarItem: () => {
        const it = { text: "", command: "", shown: false, show() { this.shown = true; }, dispose() {} };
        items.push(it);
        return it;
      },
    },
    StatusBarAlignment: { Left: 1 },
    extensions: { getExtension: () => undefined },
  };
  const subs: unknown[] = [];
  const api = palette.register(vscode, { subscriptions: subs }, { roots: () => ["/work/app"], sendKey: (k: string, e?: object) => sent.push([k, e]) });
  assert.ok(api && handlers["friday.palette"]);
  assert.equal(items[0]!.text, "$(sparkle)");
  assert.equal(items[0]!.command, "friday.palette");
  assert.ok(items[0]!.shown);
  await api.open();
  assert.ok(shown.some((r) => r.label.includes("New chat")));
  assert.deepEqual(sent, [["action", { action: "race" }]]);
});

test("the pick shows at once, busy, and fills in when Friday answers; a second press while it is open does nothing", async () => {
  const log: string[] = [];
  const hide: (() => void)[] = [];
  let accept: () => void = () => {};
  const picks: object[] = [];
  const mk = () => {
    const qp: Record<string, unknown> = {
      busy: false,
      items: [],
      selectedItems: [],
      onDidAccept: (f: () => void) => (accept = f),
      onDidHide: (f: () => void) => hide.push(f),
      show() { log.push(`show busy=${qp.busy} items=${(qp.items as unknown[]).length}`); },
      hide() { hide.forEach((f) => f()); },
      dispose() {},
    };
    picks.push(qp);
    return qp;
  };
  const handlers: Record<string, () => unknown> = {};
  const vscode = {
    commands: { registerCommand: (id: string, fn: () => unknown) => ((handlers[id] = fn), { dispose() {} }), executeCommand: async () => {} },
    window: { activeTextEditor: undefined, showQuickPick: async () => undefined, createQuickPick: mk },
    extensions: { getExtension: () => undefined },
  };
  const sent: [string, object | undefined][] = [];
  const api = palette.register(vscode, { subscriptions: [] }, { roots: () => ["/work/app"], sendKey: (k: string, e?: object) => sent.push([k, e]) });
  const first = api.open();
  void api.open();
  assert.equal(picks.length, 1, "one pick, not two");
  assert.deepEqual(log, ["show busy=true items=0"], "shown before Friday has answered");
  await new Promise((r) => setTimeout(r, 30));
  const qp = picks[0] as { busy: boolean; items: { label: string; action: object }[]; selectedItems: unknown[] };
  assert.equal(qp.busy, false);
  assert.ok(qp.items.some((i) => i.label.includes("New chat")), "the rows arrive");
  qp.selectedItems = [qp.items.find((i) => i.label.includes("Race this ask"))];
  accept();
  await first;
  assert.deepEqual(sent, [["action", { action: "race" }]]);
  // Once it is closed, the next press opens a new one.
  void api.open();
  assert.equal(picks.length, 2);
  (picks[1] as { hide: () => void }).hide();
});

test("an older IDE without the quick pick API is left alone", () => {
  assert.equal(palette.register({ window: {}, commands: {} }, { subscriptions: [] }, { roots: () => [], sendKey() {} }), null);
});
