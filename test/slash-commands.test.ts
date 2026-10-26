import assert from "node:assert/strict";
import test from "node:test";
import { COMMANDS, mcpCommands, tokenAt } from "../src/client/Shortcuts.js";

/**
 * `/` in the composer, and what it offers.
 *
 * The built-in asks are the same everywhere; the connections are whatever this
 * workspace has plugged in. The rules that matter are which connections earn a
 * command and what typing one writes into the box — an instruction that names
 * the connection, because an agent only reaches for one that is named.
 */

const conn = (name: string, over: Partial<{ enabled: boolean; state: string; tools: number }> = {}) => ({
  name,
  enabled: over.enabled ?? true,
  status: {
    state: over.state ?? "connected",
    tools: Array.from({ length: over.tools ?? 3 }, (_, i) => ({ name: `tool${i}` })),
  },
});

test("every connected MCP gets a command, named after it", () => {
  const cmds = mcpCommands([conn("Gmail"), conn("Google Drive"), conn("Linear")]);
  assert.deepEqual(
    cmds.map((c) => c.name),
    ["gmail", "google-drive", "linear"],
  );
  // The instruction names the connection, and stops so the caret lands there.
  assert.equal(cmds[0]!.text, "Use the Gmail connection to ");
  assert.match(cmds[1]!.hint, /Google Drive · 3 tools/);
});

/**
 * Offering one that cannot answer writes an instruction the agent will fail,
 * which is worse than not offering it: the failure looks like the agent's.
 */
test("a connection that can't answer is not offered", () => {
  const cmds = mcpCommands([
    conn("Gmail", { enabled: false }),
    conn("Slack", { state: "error" }),
    conn("Notion", { state: "unknown" }),
    conn("Linear"),
  ]);
  assert.deepEqual(
    cmds.map((c) => c.name),
    ["linear"],
  );
});

test("a name with nothing to slug is dropped rather than offered as /", () => {
  assert.deepEqual(mcpCommands([conn("!!!"), conn("···")]), []);
});

test("one tool reads as one tool", () => {
  assert.match(mcpCommands([conn("Stripe", { tools: 1 })])[0]!.hint, /1 tool$/);
});

/**
 * The built-ins keep their names to themselves: a connection called "Test"
 * would otherwise shadow /test, and the command somebody learned first would
 * quietly start doing something else.
 */
test("the built-in commands are still the first answer for their own names", () => {
  const all = [...COMMANDS, ...mcpCommands([conn("Test"), conn("Review")])];
  for (const name of ["test", "review"]) {
    const first = all.find((c) => c.name === name)!;
    assert.ok(COMMANDS.includes(first), `/${name} still means the built-in`);
  }
});

test("the caret has to be in a command for the list to open", () => {
  assert.deepEqual(tokenAt("/gm", 3), { kind: "command", query: "gm", start: 0 });
  // Only at the start: "/" mid-sentence is a path or a date, not a command.
  assert.equal(tokenAt("fix src/app.ts", 14)?.kind, undefined);
  assert.equal(tokenAt("look at /etc", 12)?.kind, undefined);
});
