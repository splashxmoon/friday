// The server keeping a computer awake between its teammates' turns (hosted-crew.ts tickAwake): the runner says busy on the line the
// desktop app keeps the computer awake by (desktop/main.ts), for as long as it is held, and lets go by itself.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BUSY_LINE, holdAwake } from "../src/runner/runner.js";

test("held awake, the runner says busy until the hold lapses, then not", async () => {
  const said: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk === "string" && chunk.startsWith(BUSY_LINE)) said.push(chunk.trim());
    return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    holdAwake(150);
    holdAwake(150);
    assert.deepEqual(said, ["[friday] busy 1"], "said once, renewed quietly");
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(said, ["[friday] busy 1", "[friday] busy 0"], "lapsed by itself");
    holdAwake(5000);
    holdAwake(0);
    assert.deepEqual(said.slice(-2), ["[friday] busy 1", "[friday] busy 0"], "let go when told");
  } finally {
    process.stdout.write = write;
  }
});
