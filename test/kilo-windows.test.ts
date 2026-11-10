// Kilo on Windows (splashxmoon/friday#20, #22): its ACP server runs `git config` on every model request with Kilo's own stdin, and
// on Windows that git waits for a line from it, so an instruction never got an answer (Kilo-Org/kilocode#10768). While an instruction
// waits, Friday sends a blank line every half second, and stops once it is answered. Nowhere else: on macOS and Linux nothing changes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ADAPTERS, type TurnSpec } from "../src/runner/adapters.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function turn(platform: NodeJS.Platform) {
  const real = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    const kilo = ADAPTERS.kilo;
    assert.equal(kilo.unavailable?.() ?? null, null, "Kilo runs here");
    const t: TurnSpec = { prompt: "Fix the test", resumeId: null, mode: "edits", system: "" };
    const lines: string[] = [kilo.stdin(t)];
    const parse = kilo.parser(t, { cwd: "/work/repo", write: (l) => void lines.push(l), end: () => {} });
    const say = (o: Record<string, unknown>) => parse(JSON.stringify({ jsonrpc: "2.0", ...o }));
    const last = () => JSON.parse(lines.filter((l) => l.trim()).at(-1)!);
    say({ id: 0, result: { protocolVersion: 1 } });
    say({ id: last().id, result: { sessionId: "s1" } });
    // Through any mode or option it sets, to the instruction itself.
    for (let i = 0; i < 6 && last().method !== "session/prompt"; i++) say({ id: last().id, result: {} });
    assert.equal(last().method, "session/prompt");
    const prompt = last().id;
    const before = lines.length;
    await sleep(1300);
    const blank = lines.slice(before).filter((l) => l === "\n").length;
    say({ id: prompt, result: { stopReason: "end_turn" } });
    const after = lines.length;
    await sleep(800);
    return { blank, more: lines.length - after };
  } finally {
    Object.defineProperty(process, "platform", real);
  }
}

test("on Windows, a blank line goes to Kilo while its instruction waits, and stops once it is answered", async () => {
  const { blank, more } = await turn("win32");
  assert.ok(blank >= 2, `blank lines while it waited: ${blank}`);
  assert.equal(more, 0, "nothing after the answer");
});

test("on macOS and Linux, nothing is sent while Kilo works", async () => {
  for (const p of ["darwin", "linux"] as const) {
    const { blank } = await turn(p);
    assert.equal(blank, 0, p);
  }
});
