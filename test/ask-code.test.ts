import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import type { Redis } from "ioredis";
import { aboutText, dirKey, questionById, startQuestion } from "../src/ask-code.js";
import { DeepDives, type Dive } from "../src/deep-dive.js";
import { askFromVscode } from "../src/client/ide/vscode-util.js";

/** "Ask the codebase" (src/ask-code.ts, the IDE's askcode.js; Arun, 2026-11-19, wave 2). */

const require = createRequire(import.meta.url);
const ext = path.resolve(import.meta.dirname, "..", "src", "vscode-ext", "friday");

const fakeRedis = () => {
  const hashes = new Map<string, Map<string, string>>();
  const strings = new Map<string, string>();
  const h = (k: string) => hashes.get(k) ?? hashes.set(k, new Map()).get(k)!;
  return {
    hget: async (k: string, f: string) => h(k).get(f) ?? null,
    hset: async (k: string, f: string, v: string) => void h(k).set(f, v),
    hdel: async (k: string, ...fs: string[]) => void fs.forEach((f) => h(k).delete(f)),
    hgetall: async (k: string) => Object.fromEntries(h(k)),
    get: async (k: string) => strings.get(k) ?? null,
    set: async (k: string, v: string) => void strings.set(k, v),
    del: async (...ks: string[]) => void ks.forEach((k) => (strings.delete(k), hashes.delete(k))),
  } as unknown as Redis;
};
const settle = async (id: string) => {
  for (let i = 0; i < 200; i++) {
    const q = questionById(id)!;
    if (q.status !== "asking") return q;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("never answered");
};
/** The runner's describe, for a folder with no remote: its path, which repoKeyOf names the repo from. */
const describe = (params: Record<string, unknown>, remote?: string) => ({ folder: { path: String(params.path).replace(/[\\/]+$/, ""), ...(remote ? { remote } : {}) } });
const dive = (folder: string, over: Partial<Dive> = {}): Dive => ({ key: "folder:acme", name: "acme", folder, tool: "claude", by: "me", status: "ready", head: "abc", branch: "main", files: 3, lines: 90, started: 1, at: 1, done: 1, total: 1, uncovered: [], ...over });

test("a repo with a Deep Dive is answered through it: the pages named, the selection given, bad citations struck, and the question kept on the Deep Dive", async () => {
  const dives = new DeepDives(fakeRedis(), "t:");
  await dives.saveMeta(dive("/repo/acme"));
  const prompts: string[] = [];
  const host = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === "describe") return describe(params);
    if (method === "dive.lines") return { counts: Object.fromEntries((params.files as string[]).map((f) => [f, f === "src/db.ts" ? 40 : null])) };
    assert.equal(method, "ask");
    assert.equal(params.cwd, "/repo/acme/", "read in the folder the IDE has open");
    prompts.push(String(params.prompt));
    return { text: "Notes are saved in `src/db.ts:3-9`, and listed in `src/gone.ts:1`." };
  };
  const q = await startQuestion({ dives, host, folder: "/repo/acme/", question: "Where are notes saved?", selection: { path: "src/server.ts", from: 4, to: 6, text: "save(note);\n" } });
  assert.equal(q.status, "asking");
  assert.equal(q.source, "dive");
  assert.equal(q.dive, "ready");
  const done = await settle(q.id);
  assert.equal(done.status, "done");
  assert.equal(done.from, "acme");
  assert.deepEqual(done.cites, [{ file: "src/db.ts", start: 3, end: 9 }], "the citation that holds, once; the struck one is no chip");
  assert.deepEqual(done.bad, ["src/gone.ts:1"]);
  assert.match(done.answer, /~~src\/gone\.ts:1~~/);
  assert.ok(prompts[0]!.startsWith("Someone working on acme asks: Where are notes saved?"));
  assert.match(prompts[0]!, /`src\/server\.ts:4-6`/);
  assert.match(prompts[0]!, /save\(note\);/);
  const [kept] = await dives.asks("folder:acme");
  assert.equal(kept!.question, "Where are notes saved? (src/server.ts:4-6)", "the lines it was about stay with it");
  assert.equal(kept!.status, "done");
});

test("a repo with no Deep Dive is answered by the first tool that can run, read-only, in its folder, and offers to build one", async () => {
  const dives = new DeepDives(fakeRedis(), "t:");
  // A Deep Dive of another folder, and a failed one with no pages, are not this folder's.
  await dives.saveMeta(dive("/repo/other", { key: "folder:other" }));
  await dives.saveMeta(dive("C:\\Work\\acme", { key: "folder:acme", status: "failed" }));
  const calls: { tool: string; model?: string }[] = [];
  const host = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === "describe") return describe(params);
    if (method === "tools") {
      return { tools: [
        { tool: "claude", name: "Claude Code", path: null, loggedIn: null },
        { tool: "cursor", name: "Cursor", path: "/bin/cursor", loggedIn: false },
        { tool: "codex", name: "Codex", path: "/bin/codex", loggedIn: true },
      ] };
    }
    if (method === "dive.lines") return { counts: { "main.go": 20 } };
    assert.equal(method, "ask");
    assert.equal(params.cwd, "C:\\Work\\acme");
    calls.push({ tool: String(params.tool), ...(params.model ? { model: String(params.model) } : {}) });
    return { text: "It starts in `main.go:1-12`." };
  };
  const q = await startQuestion({ dives, host, folder: "C:\\Work\\acme", question: "How does it start?" });
  assert.equal(q.source, "tool");
  const done = await settle(q.id);
  assert.equal(done.status, "done");
  assert.equal(done.tool, "codex");
  assert.equal(done.from, "Codex");
  assert.deepEqual(done.cites, [{ file: "main.go", start: 1, end: 12 }]);
  assert.equal(calls[0]!.tool, "codex");
  assert.equal(done.dive, "none");
  assert.deepEqual(await dives.asks("folder:acme"), [], "nothing is kept on a Deep Dive that isn't ready");
});

test("no tool signed in, or a tool that fails, is said as the question's failure", async () => {
  const dives = new DeepDives(fakeRedis(), "t:");
  const none = await startQuestion({ dives, host: async (m, p) => (m === "describe" ? describe(p) : { tools: [{ tool: "claude", path: null, loggedIn: null }] }), folder: "/repo/x", question: "Why?" });
  const a = await settle(none.id);
  assert.equal(a.status, "failed");
  assert.match(a.error!, /No coding tool/);
  const broke = await startQuestion({ dives, host: async (m, p) => (m === "describe" ? describe(p) : m === "tools" ? { tools: [{ tool: "claude", path: "/bin/claude", loggedIn: true }] } : Promise.reject(new Error("Claude Code exited with code 1."))), folder: "/repo/x", question: "Why?" });
  const b = await settle(broke.id);
  assert.equal(b.status, "failed");
  assert.match(b.error!, /exited with code 1/);
});

test("the selection is told as lines and code, and nothing is told for an empty one", () => {
  assert.match(aboutText({ path: "a/b.ts", from: 3, to: 3, text: "x\n" }), /`a\/b\.ts:3`/);
  assert.match(aboutText({ path: "a/b.ts", from: 3, to: 7, text: "x\n" }), /`a\/b\.ts:3-7`/);
  assert.equal(aboutText(null), "");
  assert.equal(aboutText({ path: "", from: 1, to: 1, text: "x" }), "");
  assert.equal(aboutText({ path: "a.ts", from: 1, to: 1, text: "  \n" }), "");
});

test("folders compare as the IDE's do: slashes either way, no trailing slash, any case on a Windows drive", () => {
  assert.equal(dirKey("C:\\Work\\acme\\"), dirKey("c:/Work/acme"));
  assert.notEqual(dirKey("/repo/Acme"), dirKey("/repo/acme"));
});

test("a question from the IDE needs no file: the page takes it with its question as the instruction", () => {
  const a = askFromVscode("/repo/acme", { kind: "question", instruction: "How does login work?", path: "", from: 1, to: 1, text: "", root: "/repo/acme", at: 1000 }, 2000);
  assert.ok(a);
  assert.equal(a!.kind, "question");
  assert.equal(a!.instruction, "How does login work?");
  assert.equal(askFromVscode("/repo/acme", { kind: "question", instruction: "x", path: "", from: 1, to: 1, text: "", root: "/repo/other" }, 2000), null, "another window's");
  assert.equal(askFromVscode("/repo/acme", { path: "", from: 1, to: 1, text: "" }, 2000), null, "a plain ask still needs a file");
});

// ── the extension's half ─────────────────────────────────────────────────────────────────────────────────────────────
type Sel = { empty: boolean; start: { line: number; character: number }; end: { line: number; character: number } };
function fakeVscode(o: { file: string; sel: Sel; lines: string[]; typed: string | undefined; roots: string[] }) {
  const handlers: Record<string, () => Promise<void>> = {};
  const boxes: string[] = [];
  const said: string[] = [];
  const vscode = {
    commands: { registerCommand: (id: string, fn: () => Promise<void>) => ((handlers[id] = fn), { dispose() {} }) },
    Uri: { file: (p: string) => ({ fsPath: p }) },
    Range: class { constructor(public sl: number, public sc: number, public el: number, public ec: number) {} },
    window: {
      activeTextEditor: o.file
        ? { selection: { ...o.sel, isEmpty: o.sel.empty }, document: { uri: { scheme: "file", fsPath: o.file }, getText: (r: { sl: number; el: number }) => o.lines.slice(r.sl, r.el + 1).join("\n"), lineAt: (n: number) => ({ range: { end: { character: o.lines[n]!.length } } }) } }
        : undefined,
      showInputBox: async (b: { title: string }) => (boxes.push(b.title), o.typed),
      showInformationMessage: (m: string) => said.push(m),
      setStatusBarMessage: (m: string) => said.push(m),
    },
  };
  return { vscode, handlers, boxes, said };
}

test("the extension asks in a box, with the selection as context when there is one", async () => {
  const { register } = require(path.join(ext, "askcode.js"));
  const root = path.join("/repo", "acme");
  const file = path.join(root, "src", "db.ts");
  const posted: Record<string, unknown>[] = [];
  const f = fakeVscode({ file, sel: { empty: false, start: { line: 2, character: 3 }, end: { line: 4, character: 0 } }, lines: ["a", "b", "const x = 1;", "save(x);", "tail"], typed: "Why is x saved here?", roots: [root] });
  const subs: unknown[] = [];
  register(f.vscode, { subscriptions: subs }, async (b: Record<string, unknown>) => (posted.push(b), true), () => root, () => [root]);
  await f.handlers["friday.askCodebase"]!();
  assert.equal(subs.length, 2, "the command, and its menu twin");
  assert.deepEqual(f.boxes, ["\u2733 Ask the codebase about lines 3\u20134 of db.ts"], "a selection ending at a line's start doesn't take that line");
  assert.deepEqual(posted, [{ kind: "question", instruction: "Why is x saved here?", path: file, from: 3, to: 4, text: "const x = 1;\nsave(x);", root }]);
  // The menu's entry is the same box.
  await f.handlers["friday.askCodebaseSelection"]!();
  assert.equal(posted.length, 2);
});

test("with nothing selected the box asks about the codebase, and a dismissed box or no folder posts nothing", async () => {
  const { register } = require(path.join(ext, "askcode.js"));
  const root = path.join("/repo", "acme");
  const posted: Record<string, unknown>[] = [];
  const post = async (b: Record<string, unknown>) => (posted.push(b), true);
  const none: Sel = { empty: true, start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
  const a = fakeVscode({ file: path.join(root, "a.ts"), sel: none, lines: ["x"], typed: "How does login work?", roots: [root] });
  register(a.vscode, { subscriptions: [] }, post, () => root, () => [root]);
  await a.handlers["friday.askCodebase"]!();
  assert.deepEqual(a.boxes, ["\u2733 Ask the codebase"]);
  assert.deepEqual(posted[0], { kind: "question", instruction: "How does login work?", path: "", from: 1, to: 1, text: "", root });
  const b = fakeVscode({ file: path.join(root, "a.ts"), sel: none, lines: ["x"], typed: undefined, roots: [root] });
  register(b.vscode, { subscriptions: [] }, post, () => root, () => [root]);
  await b.handlers["friday.askCodebase"]!();
  assert.equal(posted.length, 1, "dismissed");
  const c = fakeVscode({ file: "", sel: none, lines: [], typed: "x", roots: [] });
  register(c.vscode, { subscriptions: [] }, post, () => "", () => []);
  await c.handlers["friday.askCodebase"]!();
  assert.equal(posted.length, 1, "no folder open");
  assert.match(c.said[0]!, /Open a folder/);
});

test("package.json contributes the command, the menu entry, and its shortcut outside the terminal", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ext, "package.json"), "utf8"));
  assert.equal(pkg.contributes.commands.find((c: { command: string }) => c.command === "friday.askCodebase").title, "Friday: Ask the codebase");
  const key = pkg.contributes.keybindings.find((k: { command: string }) => k.command === "friday.askCodebase");
  // Not Ctrl+Alt+A on Windows and Linux: Ctrl+Alt is AltGr there, and AltGr+A types a letter on some layouts (Polish ą). Cmd+Alt+A is free on the Mac.
  assert.deepEqual([key.key, key.mac, key.when], ["ctrl+k ctrl+a", "cmd+alt+a", "!terminalFocus"]);
  assert.ok(!/alt/.test(key.key), "no AltGr chord on Windows and Linux");
  assert.ok(pkg.contributes.menus["editor/context"].some((m: { command: string; when: string }) => m.command === "friday.askCodebaseSelection" && /editorHasSelection/.test(m.when)));
  const palette = pkg.contributes.menus.commandPalette.find((m: { command: string }) => m.command === "friday.askCodebaseSelection");
  assert.equal(palette.when, "false", "one entry in the palette, not two");
});

const tools = (...t: { tool: string; loggedIn?: boolean | null }[]) => ({ tools: t.map((x) => ({ name: x.tool, path: `/bin/${x.tool}`, loggedIn: x.loggedIn ?? true, ...x })) });

test("a worktree of a repo that has a Deep Dive answers through it, in the worktree, and the selection is kept with the question by the one who asked", async () => {
  const dives = new DeepDives(fakeRedis(), "t:");
  await dives.saveMeta(dive("/repo/acme", { key: "github.com/acme/notes" }));
  const cwds: string[] = [];
  const host = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === "describe") return describe(params, "git@github.com:Acme/notes.git");
    if (method === "dive.lines") return { counts: { "a.ts": 10 } };
    cwds.push(String(params.cwd));
    return { text: "See `a.ts:1-2`." };
  };
  const q = await startQuestion({ dives, host, folder: "/work/acme-feature-1234abcd", question: "What is this for?", by: "ada", selection: { path: "src/server.js", from: 14, to: 16, text: "x" } });
  assert.equal(q.source, "dive");
  assert.equal((await settle(q.id)).status, "done");
  assert.deepEqual(cwds, ["/work/acme-feature-1234abcd"], "read in the checkout that is open");
  const [kept] = await dives.asks("github.com/acme/notes");
  assert.equal(kept!.question, "What is this for? (src/server.js:14-16)");
  assert.equal(kept!.by, "ada");
});

test("a Deep Dive still being written, or one left building by a quit, is not the answerer and is not named as one", async () => {
  const toolHost = (m: string, p: Record<string, unknown>) => (m === "describe" ? describe(p) : m === "tools" ? tools({ tool: "claude" }) : m === "dive.lines" ? { counts: {} } : { text: "Plain answer." });
  const fresh = new DeepDives(fakeRedis(), "t:");
  await fresh.saveMeta(dive("/repo/acme", { status: "building", at: Date.now() }));
  const a = await startQuestion({ dives: fresh, host: async (m, p) => toolHost(m, p), folder: "/repo/acme", question: "Why?" });
  assert.equal(a.dive, "building");
  const doneA = await settle(a.id);
  assert.equal(doneA.source, "tool");
  assert.deepEqual(await fresh.asks("folder:acme"), []);
  const stale = new DeepDives(fakeRedis(), "t:");
  await stale.saveMeta(dive("/repo/acme", { status: "building", at: Date.now() - 26 * 60_000 }));
  const b = await startQuestion({ dives: stale, host: async (m, p) => toolHost(m, p), folder: "/repo/acme", question: "Why?" });
  assert.equal(b.dive, "none", "a build that stopped is no Deep Dive, so the offer to build stays");
  assert.equal((await settle(b.id)).source, "tool");
});

test("the tool the column is on answers first, and another that can run takes over when it fails; running out of time ends it", async () => {
  const dives = new DeepDives(fakeRedis(), "t:");
  const tried: string[] = [];
  const host = (failing: string[], slow = "") => async (m: string, p: Record<string, unknown>): Promise<unknown> => {
    if (m === "describe") return describe(p);
    if (m === "tools") return tools({ tool: "claude" }, { tool: "codex" }, { tool: "cursor", loggedIn: null });
    if (m === "dive.lines") return { counts: {} };
    tried.push(String(p.tool));
    if (p.tool === slow) throw new Error("Cursor timed out after 600s.");
    if (failing.includes(String(p.tool))) throw new Error(`${p.tool} is out of usage.`);
    return { text: `${p.tool} read it.` };
  };
  const first = await settle((await startQuestion({ dives, host: host([]), folder: "/repo/x", question: "Why?", tool: "codex" })).id);
  assert.deepEqual([first.tool, tried], ["codex", ["codex"]], "the column's tool, not the fixed order's first");
  tried.length = 0;
  const next = await settle((await startQuestion({ dives, host: host(["codex"]), folder: "/repo/x", question: "Why?", tool: "codex" })).id);
  assert.deepEqual([next.status, next.tool, tried], ["done", "claude", ["codex", "claude"]]);
  tried.length = 0;
  const all = await settle((await startQuestion({ dives, host: host(["claude", "codex", "cursor"]), folder: "/repo/x", question: "Why?" })).id);
  assert.equal(all.status, "failed");
  assert.deepEqual(tried, ["claude", "codex", "cursor"]);
  tried.length = 0;
  const slow = await settle((await startQuestion({ dives, host: host([], "claude"), folder: "/repo/x", question: "Why?" })).id);
  assert.equal(slow.status, "failed");
  assert.deepEqual(tried, ["claude"], "out of time: the next tool would take as long");
});

test("a Deep Dive whose own tool can't run falls back to another tool, and its failed question is not left on its page", async () => {
  const dives = new DeepDives(fakeRedis(), "t:");
  await dives.saveMeta(dive("/repo/acme", { tool: "claude" }));
  const host = async (m: string, p: Record<string, unknown>): Promise<unknown> => {
    if (m === "describe") return describe(p);
    if (m === "tools") return tools({ tool: "claude" }, { tool: "codex" });
    if (m === "dive.lines") return { counts: {} };
    if (p.tool === "claude") throw new Error("Claude Code is out of usage.");
    return { text: "Codex read it." };
  };
  const q = await startQuestion({ dives, host, folder: "/repo/acme", question: "Why?" });
  const done = await settle(q.id);
  assert.equal(done.status, "done");
  assert.deepEqual([done.source, done.tool], ["tool", "codex"]);
  assert.deepEqual(await dives.asks("folder:acme"), []);
});
