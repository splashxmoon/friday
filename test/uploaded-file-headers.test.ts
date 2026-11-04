import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadedFileHeaders } from "../src/files.js";

// An attached SVG draws in the chat (audit CODE-7, Arun 2026-11-04): served as a picture, under a policy that runs nothing.
test("an uploaded SVG is served as a picture, sandboxed", () => {
  const h = uploadedFileHeaders("image/svg+xml");
  assert.equal(h["Content-Type"], "image/svg+xml");
  assert.match(h["Content-Security-Policy"] ?? "", /default-src 'none'/);
  assert.match(h["Content-Security-Policy"] ?? "", /sandbox/);
});

test("other markup is still a file to save, never rendered on the app's origin", () => {
  for (const t of ["text/html", "application/xhtml+xml", "text/xml", "application/javascript", "text/javascript"]) assert.equal(uploadedFileHeaders(t)["Content-Type"], "application/octet-stream", t);
});

test("ordinary files keep their own type", () => {
  assert.deepEqual(uploadedFileHeaders("image/png"), { "Content-Type": "image/png" });
  assert.deepEqual(uploadedFileHeaders("text/plain"), { "Content-Type": "text/plain" });
});
