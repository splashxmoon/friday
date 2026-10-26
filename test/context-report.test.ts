import assert from "node:assert/strict";
import test from "node:test";
import { parseContextReport, tokensOf } from "../src/runner/context-report.js";

// Claude Code's /context, as it answers in print mode (2.1.302): no model call, no tokens.
const REPORT = `## Context Usage

**Model:** claude-sonnet-5-5  
**Tokens:** 28.4k / 1m (3%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 2.7k | 0.3% |
| System tools | 12.6k | 1.3% |
| MCP tools | 660 | 0.1% |
| MCP server instructions | 2.4k | 0.2% |
| MCP tools (deferred) | 589k | 58.9% |
| Skills | 10k | 1.0% |
| Messages | 10 | 0.0% |
| Free space | 938.6k | 93.9% |
| Autocompact buffer | 33k | 3.3% |

### MCP Tools

| Tool | Server | Tokens |
|------|--------|--------|
| mcp__claude_ai_Apollo_io__a | claude_ai_Apollo_io | 1.4k |
| mcp__claude_ai_Apollo_io__b | claude_ai_Apollo_io | 1.2k |
| mcp__rea__x | rea | 3.4k |
`;

test("Claude Code's /context report: the model, how full, every category, and the MCP servers by what their tools take", () => {
  const c = parseContextReport(REPORT)!;
  assert.equal(c.model, "claude-sonnet-5-5");
  assert.equal(c.used, 28_400);
  assert.equal(c.window, 1_000_000);
  assert.deepEqual(c.categories.map((x) => [x.name, x.tokens]), [
    ["System prompt", 2700],
    ["System tools", 12_600],
    ["MCP tools", 660],
    ["MCP server instructions", 2400],
    ["MCP tools (deferred)", 589_000],
    ["Skills", 10_000],
    ["Messages", 10],
    ["Free space", 938_600],
    ["Autocompact buffer", 33_000],
  ]);
  assert.deepEqual(c.servers, [{ name: "rea", tokens: 3400 }, { name: "Apollo io", tokens: 2600 }]);
  assert.equal(parseContextReport("Hello"), null, "anything else is no report");
  assert.equal(tokensOf("1.2M"), 1_200_000);
  assert.equal(tokensOf("12,400"), 12_400);
});
