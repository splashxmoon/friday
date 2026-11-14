import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { callHost } from "../src/runner/local-api.js";
import { probeTool } from "../src/runner/tool-probe.js";
import { ENGINE_TOOLS } from "../src/types.js";

/**
 * One coding tool whose look on a computer hangs or throws is that tool said as unknown on its row, never the whole list gone
 * (Arun, 2026-11-10): a person with one odd tool installed saw no tools at all, and the page a 400.
 */

test("a tool's look that answers is its row", async () => {
  assert.deepEqual(await probeTool("codex", async () => ({ tool: "codex", path: "/x/codex" })), { tool: "codex", path: "/x/codex" });
});

test("a tool's look that throws is that tool unknown", async () => {
  const row = await probeTool("kilo", async () => {
    throw new Error("bad accounts file");
  });
  assert.deepEqual(row, { tool: "kilo", name: "Kilo", path: null, loggedIn: null, source: null, unknown: true });
});

test("a tool's look that hangs is that tool unknown once its time is up", async () => {
  const t0 = Date.now();
  const row = await probeTool("muse", () => new Promise<never>(() => {}), 50);
  assert.equal((row as { unknown?: true }).unknown, true);
  assert.ok(Date.now() - t0 < 1_000, "not held past its deadline");
});

type Row = { tool: string; path: string | null; loggedIn: boolean | null; unknown?: true; accounts?: { id: string; loggedIn: boolean | null }[] };
const NONE = (dir: string) => {
  process.env.FRIDAY_STATE_DIR = path.join(dir, "state");
  for (const t of ENGINE_TOOLS) process.env[`FRIDAY_${t.toUpperCase()}_BIN`] = path.join(dir, "none", t);
};
async function stub(dir: string, tool: string, script: string): Promise<string> {
  const bin = path.join(dir, tool);
  await writeFile(bin, `#!/bin/sh\n${script}\n`);
  await chmod(bin, 0o755);
  process.env[`FRIDAY_${tool.toUpperCase()}_BIN`] = bin;
  return bin;
}
const look = async () => ((await callHost("tools", {}, { runners: new Map() } as never)) as { tools: Row[] }).tools;

test("the computer's tools list: a tool whose accounts can't be read is still found, and the others still listed", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-tool-probe-"));
  const was = { ...process.env };
  try {
    NONE(dir);
    // Codex and Claude Code here, each saying it is signed out.
    for (const t of ["codex", "claude"]) await stub(dir, t, `echo "Not logged in"\nexit 1`);
    // Codex's accounts, in a file this version can't read as a list.
    await mkdir(path.join(dir, "state"), { recursive: true });
    await writeFile(path.join(dir, "state", "accounts.json"), JSON.stringify({ codex: { main: "not a list" } }));
    const tools = await look();
    assert.equal(tools.length, ENGINE_TOOLS.length, "every tool has its row");
    const codex = tools.find((t) => t.tool === "codex")!;
    assert.equal(codex.path, process.env.FRIDAY_CODEX_BIN, "Codex found, its accounts left off its row");
    assert.equal(codex.unknown, undefined);
    assert.equal(codex.accounts, undefined);
    const claude = tools.find((t) => t.tool === "claude")!;
    assert.equal(claude.path, process.env.FRIDAY_CLAUDE_BIN, "Claude Code still found");
    assert.equal(claude.unknown, undefined);
    assert.equal(tools.find((t) => t.tool === "gemini")?.path, null, "one not installed is still just not installed");
  } finally {
    process.env = was;
  }
});

// The Fable review of build/late-joiner, 1: the sign-in check and each account's ran one after the other, past the look's deadline,
// and a tool someone needed to sign in to said "Couldn't check" and couldn't be picked.
for (const said of [true, false]) {
  test(`a tool with two accounts and a slow sign-in check (${said ? "signed in" : "signed out"}) is found, its sign-in unknown until it answers`, { skip: process.platform === "win32" }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "friday-tool-probe-"));
    const was = { ...process.env };
    try {
      NONE(dir);
      const bin = await stub(dir, "claude", `sleep 2\necho '{"loggedIn":${said}}'`);
      await mkdir(path.join(dir, "state"), { recursive: true });
      await writeFile(path.join(dir, "state", "accounts.json"), JSON.stringify({ claude: [{ id: "work", label: "Work" }] }));
      const t0 = Date.now();
      const claude = (await look()).find((t) => t.tool === "claude")!;
      assert.ok(Date.now() - t0 < 2_500, `the checks side by side, within a sign-in check's budget (${Date.now() - t0}ms)`);
      assert.equal(claude.path, bin, "found");
      assert.equal(claude.unknown, undefined, "never \"Couldn't check\" for a tool that was found");
      assert.equal(claude.loggedIn, null, "its sign-in not known yet");
      assert.equal(claude.accounts?.length, 2, "both accounts on its row");
    } finally {
      process.env = was;
    }
  });
}

test("on the page, a tool that couldn't be checked is said so, never \"not installed\"", async () => {
  const { toolLabel, unchecked } = await import("../src/client/local.js");
  const row = { tool: "kilo" as const, name: "Kilo", path: null, loggedIn: null, source: null };
  assert.equal(toolLabel({ ...row, unknown: true }), "couldn't check");
  assert.equal(unchecked({ ...row, unknown: true }), true);
  assert.equal(toolLabel(row), "not installed");
  assert.equal(unchecked(row), false);
});

// The Fable review of build/late-joiner, 6: a look that ran out of time carried on, and the next look started another beside it.
test("a tool already being looked for is not looked for again beside it: the second look shares the first", async () => {
  const { binScans, findBin } = await import("../src/runner/adapters.js");
  const was = process.env.FRIDAY_GEMINI_BIN;
  delete process.env.FRIDAY_GEMINI_BIN;
  try {
    const before = binScans.count;
    const [a, b] = await Promise.all([findBin("gemini"), findBin("gemini")]);
    assert.equal(a, b);
    assert.equal(binScans.count - before, 1, "one walk of PATH for the two");
  } finally {
    if (was !== undefined) process.env.FRIDAY_GEMINI_BIN = was;
  }
});
