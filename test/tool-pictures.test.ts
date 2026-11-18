import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ADAPTERS } from "../src/runner/adapters.js";
import { keepPictures, picturesIn, withoutPictures } from "../src/runner/tool-pictures.js";

/** Pictures a coding tool's step gives back, shown in the chat by where they are kept, never by their bytes (tool-pictures.ts). */
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");

test("each tool's shape of a picture is found, and nothing else is", () => {
  // Claude Code (the Messages API's shape), MCP's (Codex), and ACP's wrapping.
  assert.deepEqual(picturesIn([{ type: "text", text: "hi" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }]), [{ data: PNG, mimeType: "image/png" }]);
  assert.deepEqual(picturesIn({ content: [{ type: "image", data: PNG, mimeType: "image/jpeg" }] }), [{ data: PNG, mimeType: "image/jpeg" }]);
  assert.deepEqual(picturesIn([{ type: "content", content: { type: "image", data: PNG, mimeType: "image/webp" } }]), [{ data: PNG, mimeType: "image/webp" }]);
  // A picture by address, a kind not shown, and plain text: none.
  assert.deepEqual(picturesIn([{ type: "image", source: { type: "url", url: "https://x/a.png" } }, { type: "image", data: PNG, mimeType: "image/tiff" }, "text"]), []);
  assert.deepEqual(picturesIn("a string"), []);
  // Fifty frames: the first six.
  assert.equal(picturesIn(Array.from({ length: 50 }, () => ({ type: "image", data: PNG, mimeType: "image/png" }))).length, 6);
});

test("the words a step keeps lose the picture's bytes, not the rest", () => {
  const r = withoutPictures({ content: [{ type: "text", text: "Took it" }, { type: "image", data: PNG, mimeType: "image/png" }] });
  assert.equal(JSON.stringify(r).includes(PNG), false);
  assert.match(JSON.stringify(r), /Took it/);
});

test("pictures are kept as files named by what is in them: the same twice is one file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pics-"));
  try {
    const a = keepPictures([{ data: PNG, mimeType: "image/png" }], dir);
    const b = keepPictures([{ data: PNG, mimeType: "image/png" }, { data: Buffer.from("<svg/>").toString("base64"), mimeType: "image/svg+xml" }], dir);
    assert.equal(a.length, 1);
    assert.equal(b[0], a[0]);
    assert.match(b[1]!, /tool-[0-9a-f]{20}\.svg$/);
    assert.equal(readdirSync(dir).length, 2);
    assert.equal(readFileSync(a[0]!).toString("base64"), PNG);
    // Empty, or of a kind not shown: not kept.
    assert.deepEqual(keepPictures([{ data: "", mimeType: "image/png" }, { data: PNG, mimeType: "text/html" }], dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude Code's step with a picture in its answer carries it to the runner", () => {
  const parse = ADAPTERS.claude.parser();
  parse(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__playwright__browser_take_screenshot", input: {} }] }, parent_tool_use_id: null }));
  const out = parse(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "Took a screenshot" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] }] }, parent_tool_use_id: null }));
  const r = out.find((o) => o.kind === "result");
  assert.ok(r && r.kind === "result");
  assert.equal(r.output, "Took a screenshot");
  assert.deepEqual(r.pictures, [{ data: PNG, mimeType: "image/png" }]);
});
