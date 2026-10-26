import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ADAPTERS, codexExec, type AdapterOut, type TurnSpec } from "../src/runner/adapters.js";
import { readRepo } from "../src/runner/repo-read.js";
import { project } from "../src/session/projection.js";
import type { EventBody, SessionEvent } from "../src/types.js";

const spec = (over: Partial<TurnSpec> = {}): TurnSpec => ({ prompt: "p", resumeId: null, mode: "edits", system: "s", ...over });
/** Every tool a Claude Code command line allows, across its --allowedTools flags. */
const allowedIn = (a: string[]) => a.flatMap((x, i) => (x === "--allowedTools" ? a.slice(i + 1, a.findIndex((y, j) => j > i && y.startsWith("--")) >>> 0) : []));
const feed = (tool: "claude" | "codex" | "cursor", lines: object[]): AdapterOut[] => {
  // Codex here is the `exec --json` way of running it, which the sandbox rules below are about.
  const parse = (tool === "codex" ? codexExec : ADAPTERS[tool]).parser();
  return lines.flatMap((l) => parse(JSON.stringify(l)));
};

test("Claude Code: Manual refuses commands, and a yes allows exactly the ones asked about", () => {
  const manual = ADAPTERS.claude.args(spec());
  assert.deepEqual(allowedIn(manual), ["Skill"], "no commands unasked: only the person's skills, which are instructions to read");
  const granted = ADAPTERS.claude.args(spec({ grant: { scope: "commands", items: ["npm test", "ls -la"] } }));
  assert.deepEqual(granted.slice(granted.indexOf("--allowedTools"), granted.indexOf("--allowedTools") + 5), ["--allowedTools", "Bash(npm test)", "PowerShell(npm test)", "Bash(ls -la)", "PowerShell(ls -la)"]);
  const auto = ADAPTERS.claude.args(spec({ mode: "full" }));
  assert.ok(auto.includes("Bash") && auto.includes("PowerShell"), "Auto allows any command, in either shell");
});

test("Claude Code: the commands it was refused come back as something to ask about", () => {
  const out = feed("claude", [{ type: "result", session_id: "x", permission_denials: [{ tool_name: "Bash", tool_input: { command: "npm test" } }, { tool_name: "Bash", tool_input: { command: "npm test" } }, { tool_name: "Edit", tool_input: {} }] }]);
  assert.deepEqual(out.find((o) => o.kind === "blocked"), { kind: "blocked", scope: "commands", items: ["npm test"] });
  assert.equal(feed("claude", [{ type: "result", session_id: "x" }]).some((o) => o.kind === "blocked"), false, "nothing refused, nothing to ask");
  // Windows: Claude Code's PowerShell tool is a shell like Bash, refused and asked about the same way.
  const ps = feed("claude", [{ type: "result", session_id: "x", permission_denials: [{ tool_name: "PowerShell", tool_input: { command: "npm run build" } }] }]);
  assert.deepEqual(ps.find((o) => o.kind === "blocked"), { kind: "blocked", scope: "commands", items: ["npm run build"] });
  const call = feed("claude", [{ type: "assistant", message: { content: [{ type: "tool_use", id: "p1", name: "PowerShell", input: { command: "npm test; git diff" } }] }, parent_tool_use_id: null }]);
  assert.equal((call[0] as { toolCalls: { name: string }[] }).toolCalls[0]!.name, "shell", "and its call is a shell card, so tests and receipts count it");
});

test("Claude Code: Auto can read the web like the other tools, and a refused web or MCP call is asked about, as a turn", () => {
  const allowed = (a: string[]) => allowedIn(a).filter((t) => t !== "Skill");
  const auto = ADAPTERS.claude.args(spec({ mode: "full" }));
  assert.deepEqual(allowed(auto), ["Bash", "PowerShell", "WebFetch", "WebSearch"]);
  assert.equal(auto[auto.indexOf("--permission-mode") + 1], "acceptEdits", "by allowing tools, never by switching permission checks off");
  assert.ok(!auto.some((a) => /bypass|dangerously/i.test(a)));

  const out = feed("claude", [
    {
      type: "result",
      session_id: "x",
      permission_denials: [
        { tool_name: "Bash", tool_input: { command: "npm test" } },
        { tool_name: "WebFetch", tool_input: { url: "https://example.com/docs" } },
        { tool_name: "mcp__github__create_issue", tool_input: { title: "x" } },
      ],
    },
  ]);
  assert.deepEqual(out.find((o) => o.kind === "blocked"), { kind: "blocked", scope: "turn", items: ["npm test", "fetch https://example.com/docs", "mcp__github__create_issue"] });
  // A yes to that turn: what Auto has, and the MCP tool it was refused, by name.
  const yes = ADAPTERS.claude.args(spec({ grant: { scope: "turn", items: ["npm test", "fetch https://example.com/docs", "mcp__github__create_issue"] } }));
  assert.deepEqual(allowed(yes), ["Bash", "PowerShell", "WebFetch", "WebSearch", "mcp__github__create_issue"]);
  assert.deepEqual(allowedIn(ADAPTERS.claude.args(spec())), ["Skill"], "Manual without a yes allows nothing extra");
});

test("Codex: Manual is read-only until a person says yes to the turn, and what the sandbox refused is reported", () => {
  const sandbox = (a: string[]) => a[a.indexOf("--sandbox") + 1];
  assert.equal(sandbox(codexExec.args(spec())), "read-only");
  // On Windows, once it may change things, its commands run as the person (see codex.args).
  const allowed = process.platform === "win32" ? "danger-full-access" : "workspace-write";
  assert.equal(sandbox(codexExec.args(spec({ grant: { scope: "turn", items: ["x"] } }))), allowed);
  assert.equal(sandbox(codexExec.args(spec({ mode: "full" }))), allowed);
  const out = feed("codex", [
    { type: "item.completed", item: { id: "1", type: "command_execution", command: "touch a.txt", aggregated_output: "Access to the path is denied", exit_code: 1, status: "failed" } },
    { type: "item.completed", item: { id: "2", type: "command_execution", command: "node -v", aggregated_output: "v20", exit_code: 0, status: "completed" } },
    { type: "turn.completed" },
  ]);
  assert.deepEqual(out.find((o) => o.kind === "blocked"), { kind: "blocked", scope: "turn", items: ["touch a.txt"] }, "only what was refused, not what simply ran");
});

test("Cursor: Manual proposes until a person says yes to the turn, and a rejected action is reported", () => {
  assert.ok(!ADAPTERS.cursor.args(spec()).includes("--force"));
  assert.ok(ADAPTERS.cursor.args(spec({ grant: { scope: "turn", items: ["x"] } })).includes("--force"));
  assert.ok(ADAPTERS.cursor.args(spec({ mode: "full" })).includes("--force"));
  const out = feed("cursor", [
    { type: "tool_call", subtype: "completed", call_id: "c1", tool_call: { shellToolCall: { args: { command: "npm install" }, result: { rejected: { reason: "needs approval" } } } } },
    { type: "result", session_id: "s" },
  ]);
  assert.deepEqual(out.find((o) => o.kind === "blocked"), { kind: "blocked", scope: "turn", items: ["npm install"] });
});

test("a request for permission waits on its lane until an instruction answers it", () => {
  let seq = 0;
  const ev = (body: EventBody, lane?: string): SessionEvent => ({ seq: ++seq, ts: Date.now(), actor: { id: "a", name: "A", kind: "human" }, body, ...(lane ? { lane } : {}) });
  const created = ev({ type: "session.created", title: "t", ownerId: "a", ownerName: "A", workspaceId: "w", options: { webSearch: false, controlMode: "ask", mcp: true, model: "", agent: null } } as EventBody);
  const asked = ev({ type: "engine.approval", id: "k1", scope: "commands", items: ["npm test"] });
  let s = project("s", [created, asked]);
  assert.equal(s.approvals.main?.id, "k1");
  s = project("s", [created, asked, ev({ type: "instruction", text: "Yes, run it.", interrupt: false, approval: { id: "k1", approve: true } })]);
  assert.equal(s.approvals.main, undefined, "answered, so no longer waiting");
});

test("a command a person approved runs on a Manual machine; without that, or on an uploaded folder, it does not", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manual-"));
  const cmd = "node -v";
  assert.match(await readRepo(dir, { op: "shell", command: cmd, mode: "edits", approved: true }), /v\d+/);
  assert.match(await readRepo(dir, { op: "shell", command: cmd, mode: "edits" }), /can't be run|commands/i, "unasked, it is refused");
  assert.match(await readRepo(dir, { op: "shell", command: cmd, mode: "edits", approved: true, isolate: true }), /can't be run|commands/i, "Friday's own server never takes this road");
  assert.match(await readRepo(dir, { op: "shell", command: cmd, mode: "plan", approved: true }), /can't be (run|changed)/i, "plan mode runs nothing");
});

test("Codex: the command is the one inside the shell it wrapped it in", async () => {
  const { codexCommand } = await import("../src/runner/adapters.js");
  // What Codex 0.159 reports on Windows, backslashes doubled and all.
  assert.equal(codexCommand(String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'npm test'`), "npm test");
  assert.equal(codexCommand(String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -NoProfile -Command 'git status'`), "git status");
  assert.equal(codexCommand("/bin/bash -lc 'npm run build'"), "npm run build");
  assert.equal(codexCommand("bash -lc \"ls -la\""), "ls -la");
  assert.equal(codexCommand("npm test"), "npm test", "nothing to unwrap");
  assert.equal(codexCommand("/usr/bin/ssh -c 'aes' host"), "/usr/bin/ssh -c 'aes' host", "not a shell");
  assert.equal(codexCommand(`bash -lc 'echo '"'"'hi'"'"''`), `bash -lc 'echo '"'"'hi'"'"''`, "quoting inside is left alone");
  const out = feed("codex", [
    { type: "item.completed", item: { id: "1", type: "command_execution", command: "/bin/bash -lc 'npm test'", aggregated_output: "EPERM", exit_code: 1, status: "failed" } },
    { type: "turn.completed" },
  ]);
  assert.deepEqual(out.find((o) => o.kind === "blocked"), { kind: "blocked", scope: "turn", items: ["npm test"] });
});
