import assert from "node:assert/strict";
import test from "node:test";
import { errorWords } from "../src/agent/compatible.js";

// Your models › Test showed a server's whole HTML error page as red text (Arun, 2026-10-28: "TEST EVERYTHING… EVERY
// INTERACTION, EVERY VISUAL"): a refusal is said in a few of the server's own words, never its page.
test("a model server's refusal is said in its own words, never as its HTML page", () => {
  const page = "<!DOCTYPE html>\n<html><head><title>Error response</title></head><body><h1>Error response</h1><p>Error code: 501</p></body></html>";
  assert.equal(errorWords(501, "Not Implemented", page), "501 Not Implemented", "a page titled only \"Error response\" says its status");
  assert.equal(errorWords(503, "Service Unavailable", "<html><head><title>Model is loading</title></head></html>"), "503 Service Unavailable: Model is loading");
  assert.equal(errorWords(502, "Bad Gateway", "<html><body>nothing here</body></html>"), "502 Bad Gateway");
  assert.equal(errorWords(404, "", "<html><head><title>404 Not Found</title></head></html>"), "404 Not Found");
  assert.equal(errorWords(400, "Bad Request", JSON.stringify({ error: { message: "model not found" } })), "model not found");
  assert.equal(errorWords(401, "Unauthorized", JSON.stringify({ error: "bad key" })), "bad key");
  assert.equal(errorWords(500, "Internal Server Error", ""), "500 Internal Server Error");
  assert.equal(errorWords(500, "", "plain   words\n here"), "plain words here");
});
