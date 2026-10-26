import assert from "node:assert/strict";
import test from "node:test";
import { paintLines } from "../src/client/Editor.js";

test("a file with Windows line endings is still coloured, line by line", () => {
  const tok = (s: string) => [{ content: s, offset: 0, light: "#000" }];
  const lines = paintLines("import json\r\nx = 1\r\n", [tok("import json"), tok("x = 1"), tok("")]);
  assert.equal(lines.length, 3);
  assert.ok(lines[0]!.tokens && lines[1]!.tokens, "every line has its colours");
  assert.equal(paintLines("y = 2", [tok("x = 1")])[0]!.tokens, undefined, "a line that changed is drawn plain until coloured");
});
