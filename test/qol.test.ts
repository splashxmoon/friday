import assert from "node:assert/strict";
import test from "node:test";
import { markdownFileName, sessionMarkdown } from "../src/session-markdown.js";
import { MAIN_LANE, type EventBody, type SessionEvent } from "../src/types.js";

/**
 * The quality-of-life pieces taken from what the other tools have (Arun, 2026-10-26: "map out more QoL features that our
 * competitors have and add them"): a session as Markdown, the message box's history, themes you make and share, and paths
 * opened in your own editor.
 */

// The client modules keep things in localStorage: a plain one for the test.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

const ev = (seq: number, body: EventBody, actor = "Ana", lane?: string): SessionEvent => ({ seq, ts: Date.UTC(2026, 9, 26, 12, seq), actor: { id: actor.toLowerCase(), name: actor } as SessionEvent["actor"], body, ...(lane ? { lane } : {}) }) as SessionEvent;

test("a session as Markdown: the asks, the answers, the commands run and what failed, and no tool output beyond a failure's tail", () => {
  const md = sessionMarkdown(
    "Fix the login",
    [
      ev(1, { type: "instruction", text: "Fix the login redirect", interrupt: false } as EventBody),
      ev(2, { type: "agent.message", text: "Looking at the router.", toolCalls: [{ id: "c1", name: "run_command", arguments: JSON.stringify({ command: "npm test" }) }, { id: "c2", name: "write_file", arguments: JSON.stringify({ path: "src/login.ts" }) }] } as EventBody, "Claude Code"),
      ev(3, { type: "tool.result", callId: "c1", name: "run_command", output: "lots\nof\noutput\nFAIL login.test.ts", isError: true } as EventBody),
      ev(4, { type: "tool.result", callId: "c2", name: "write_file", output: "SECRET-LOOKING OUTPUT", isError: false } as EventBody),
      ev(5, { type: "agent.message", text: "Fixed: the redirect kept the old path.", toolCalls: [] } as EventBody, "Claude Code", "lane-2"),
    ],
    (lane) => (lane === MAIN_LANE ? "Claude Code" : "Codex"),
  );
  assert.match(md, /^# Fix the login\n/);
  assert.match(md, /## Ana\n\nFix the login redirect/);
  assert.match(md, /### Claude Code\n\nLooking at the router\./);
  assert.match(md, /- ran `npm test`/);
  assert.match(md, /- write file `src\/login\.ts`/);
  assert.match(md, /✗ ran `npm test` failed:[\s\S]*FAIL login\.test\.ts/);
  assert.match(md, /### Codex\n\nFixed: the redirect kept the old path\./);
  assert.doesNotMatch(md, /SECRET-LOOKING OUTPUT/, "a tool's output that didn't fail stays out");
  assert.equal(markdownFileName("Fix the login!", Date.UTC(2026, 9, 26)), "fix-the-login-2026-10-26.md");
});

test("↑ in an empty box walks back through what you asked, ↓ walks forward to an empty box, and your own text is left alone", async () => {
  const { rememberAsk, walkAsks, pastAsks } = await import("../src/client/askHistory.js");
  store.clear();
  rememberAsk("first");
  rememberAsk("second");
  rememberAsk("first");
  assert.deepEqual(pastAsks(), ["first", "second"], "asked again moves up, not in twice");
  const el = { value: "", selectionStart: 0, selectionEnd: 0 } as HTMLTextAreaElement;
  const at = { current: -1 };
  const key = (k: string) => ({ key: k, altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, preventDefault() {} });
  const set = (t: string) => void (el.value = t);
  assert.equal(walkAsks(key("ArrowUp"), el, at, set), true);
  assert.equal(el.value, "first");
  assert.equal(walkAsks(key("ArrowUp"), el, at, set), true);
  assert.equal(el.value, "second");
  assert.equal(walkAsks(key("ArrowUp"), el, at, set), false, "nothing older");
  assert.equal(walkAsks(key("ArrowDown"), el, at, set), true);
  assert.equal(el.value, "first");
  assert.equal(walkAsks(key("ArrowDown"), el, at, set), true);
  assert.equal(el.value, "", "back to an empty box");
  el.value = "my own words";
  assert.equal(walkAsks(key("ArrowUp"), el, at, set), false, "arrows in your own text move the caret");
});

test("a theme made from four colours is a whole theme; a shared file brings back only colours", async () => {
  const { PRESETS, readThemeFile, themeFile, themeFromPalette } = await import("../src/client/theme.js");
  const mine = themeFromPalette({ name: "Forest", dark: true, bg: "#13241d", ink: "#e8f0ea", accent: "#ff6b35" });
  assert.equal(mine.vars["--bg"], "#13241d");
  assert.equal(mine.vars["--accent"], "#ff6b35");
  assert.ok(mine.vars["--sidebar"] && mine.vars["--border"], "the rest is worked out");
  // Round trip through a shared file.
  const back = readThemeFile(JSON.parse(themeFile(mine)));
  assert.equal(back?.name, "Forest");
  assert.equal(back?.vars["--accent"], "#ff6b35");
  // A file that tries to put anything but a colour on the page gets nothing of it.
  const evil = readThemeFile({ friday: "theme", name: "X", dark: true, vars: { "--bg": "#000000", "--ink": "url(https://evil.example/x)", "background-image": "red" }, tokens: { keyword: "expression(alert(1))", string: "#a5d6ff" } });
  assert.deepEqual(evil?.vars, { "--bg": "#000000" });
  assert.deepEqual(evil?.tokens, { string: "#a5d6ff" });
  assert.equal(readThemeFile({ friday: "theme", palette: { bg: "nope", ink: "#fff", accent: "#000" } }), null);
  // VS Code themes still read as before.
  assert.equal(readThemeFile({ name: "VS", type: "dark", colors: { "editor.background": "#1e1e1e", "editor.foreground": "#d4d4d4" } })?.vars["--bg"], "#1e1e1e");
  assert.ok(PRESETS.length >= 10 && PRESETS.every((p) => p.id?.startsWith("preset:") && p.vars["--bg"] && Object.keys(p.tokens).length));
});

test("a file named from the session's folder is a path on its computer; an absolute one is left as it is", async () => {
  const { joinPath } = await import("../src/client/openIn.js");
  assert.equal(joinPath("/Users/ana/app/", "./src/a.ts"), "/Users/ana/app/src/a.ts");
  assert.equal(joinPath("/Users/ana/app", "/etc/hosts"), "/etc/hosts");
  assert.equal(joinPath("C:\\work\\app", "src\\a.ts"), "C:\\work\\app\\src\\a.ts");
  assert.equal(joinPath("C:\\work\\app", "D:\\x.ts"), "D:\\x.ts");
});
