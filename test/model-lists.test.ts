// A coding tool's models before its first conversation here (runner/model-lists.ts): Kilo's and OpenCode's own `models`, and
// any other ACP tool asked by a conversation opened and closed with nothing said in it, as T3 Code and Orca do.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { grouped, isFree, parseProviderModels, probeAcp } from "../src/runner/model-lists.js";

test("`kilo models` is read line by line, free models first under their own heading", () => {
  // As Kilo 7.8.28 printed it signed out (the first lines of 322), with a colour code and a banner line mixed in.
  const out = [
    "██  ██ ██ banner",
    "kilo/~anthropic/claude-sonnet-latest",
    "\x1b[0mkilo/cohere/north-mini-code:free",
    "kilo/kilo-auto/free",
    "kilo/~google/gemini-pro-latest",
    "kilo/~anthropic/claude-sonnet-latest",
    "",
  ].join("\n");
  const list = parseProviderModels(out);
  assert.deepEqual(
    list.map((m) => m.id),
    ["kilo/~anthropic/claude-sonnet-latest", "kilo/cohere/north-mini-code:free", "kilo/kilo-auto/free", "kilo/~google/gemini-pro-latest"],
    "the banner is skipped and nothing is listed twice",
  );
  assert.equal(list[0]!.label, "anthropic/claude-sonnet-latest");
  // Twelve or fewer stay as they are; a long list with free ones is grouped.
  assert.deepEqual(grouped(list), list);
  const long = [...list, ...Array.from({ length: 12 }, (_, i) => ({ id: `kilo/x/m${i}`, label: `x/m${i}` }))];
  const g = grouped(long);
  assert.deepEqual(g.slice(0, 2).map((m) => [m.id, m.group]), [["kilo/cohere/north-mini-code:free", "Free"], ["kilo/kilo-auto/free", "Free"]]);
  assert.ok(g.slice(2).every((m) => m.group === "Other models"));
  assert.equal(g.length, long.length);
  // A long list with nothing free has no headings.
  assert.ok(grouped(long.filter((m) => !isFree(m))).every((m) => !m.group));
  // ACP names say it too (OpenCode Zen: "Big Pickle (free)").
  assert.ok(isFree({ id: "opencode/big-pickle", label: "Big Pickle (free)" }));
  assert.ok(!isFree({ id: "kilo/~openai/gpt-luna-latest", label: "GPT Luna" }));
});

/** A stand-in ACP tool: answers initialize and session/new as `how` says, and writes what it was sent beside itself. */
async function standIn(how: "options" | "older" | "asks" | "silent" | "refuses"): Promise<{ bin: string; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-model-look-test-"));
  const bin = path.join(dir, "agent.mjs");
  await writeFile(
    bin,
    `import { appendFileSync } from "node:fs";
const how = ${JSON.stringify(how)};
let buf = "";
const say = (o) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\\n");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    appendFileSync(${JSON.stringify(path.join(dir, "sent.txt"))}, m.method + " " + JSON.stringify(m.params?.cwd ?? "") + "\\n");
    if (how === "silent") continue;
    if (m.method === "initialize") say({ id: m.id, result: { protocolVersion: 1 } });
    if (m.method === "session/new") {
      if (how === "asks") say({ id: 99, method: "session/request_permission", params: {} });
      else if (how === "refuses") say({ id: m.id, error: { code: -32000, message: "Authentication required" } });
      else if (how === "older") say({ id: m.id, result: { sessionId: "s", models: { currentModelId: "b", availableModels: [{ modelId: "a", name: "A" }, { modelId: "b", name: "B" }] } } });
      else say({ id: m.id, result: { sessionId: "s", configOptions: [{ id: "model", category: "model", type: "select", currentValue: "a", options: [{ value: "a", name: "Model A" }, { value: "b", name: "Model B" }] }] } });
    }
  }
});
`,
  );
  return { bin, dir };
}

test("another ACP tool is asked by a conversation opened in an empty folder of Friday's own, then ended", async () => {
  const { bin, dir } = await standIn("options");
  try {
    const t0 = Date.now();
    assert.deepEqual(await probeAcp("gemini", bin), [{ id: "a", label: "Model A" }, { id: "b", label: "Model B" }]);
    assert.ok(Date.now() - t0 < 10_000, "answered at once, not at the time limit");
    const sent = (await import("node:fs")).readFileSync(path.join(dir, "sent.txt"), "utf8");
    assert.match(sent, /^initialize ""\nsession\/new ".*friday-model-look"\n$/, "nothing said in it: no prompt");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the older `models` list is read the same way", async () => {
  const { bin, dir } = await standIn("older");
  try {
    assert.deepEqual(await probeAcp("gemini", bin), [{ id: "a", label: "A" }, { id: "b", label: "B" }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a tool that asks for something, turns the conversation down, or never answers gives no list, and is ended", async () => {
  for (const how of ["asks", "refuses", "silent"] as const) {
    const { bin, dir } = await standIn(how);
    try {
      const t0 = Date.now();
      assert.deepEqual(await probeAcp("gemini", bin, how === "silent" ? 1_500 : 10_000), [], how);
      if (how !== "silent") assert.ok(Date.now() - t0 < 8_000, `${how}: ended as soon as it said so`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
