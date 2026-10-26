// Addresses a coding tool says, and how one is opened through Friday when the page can't reach the machine (previewBus.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { localUrlsIn, throughFriday } from "../src/client/previewBus.js";

test("the local addresses in what a coding tool printed or said, one per port, with their path", () => {
  const next = "   ▲ Next.js 15.3\n   - Local:        http://localhost:3000\n   - Network:      http://192.168.1.5:3000\n ✓ Ready in 1.2s";
  assert.deepEqual(localUrlsIn(next), ["http://localhost:3000/"]);
  const vite = "  VITE v6  ready in 300 ms\n\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host";
  assert.deepEqual(localUrlsIn(vite), ["http://localhost:5173/"]);
  assert.deepEqual(localUrlsIn("Dev preview is running at localhost:3000."), ["http://localhost:3000/"], "a bare host, and the full stop isn't part of it");
  assert.deepEqual(localUrlsIn("Open http://127.0.0.1:8080/admin?tab=users to check it, or http://127.0.0.1:8080 for the home page"), ["http://127.0.0.1:8080/admin?tab=users"], "one address per port, the first said");
  assert.deepEqual(localUrlsIn("Listening on 0.0.0.0:4000"), ["http://localhost:4000/"], "every interface reads as this computer");
  assert.deepEqual(localUrlsIn("See https://example.com:3000/ and the docs"), [], "not an address on the internet");
  assert.deepEqual(localUrlsIn("Ran the tests: 12 passed"), []);
});

test("through Friday, the ticket's address keeps the page's path and query", () => {
  assert.equal(throughFriday("http://localhost:3000/", "/api/preview/abc123/"), "/api/preview/abc123/");
  assert.equal(throughFriday("http://localhost:3000/admin?tab=users#top", "/api/preview/abc123/"), "/api/preview/abc123/admin?tab=users#top");
});

import { NOT_LISTENING, fetchPreview, previewLocation, previewTrouble } from "../src/runner/preview.js";

test("a dev server's redirect stays inside the preview when it is to the same server", () => {
  const p = "/api/preview/abc123";
  assert.equal(previewLocation("/en", 3000, p), "/api/preview/abc123/en");
  assert.equal(previewLocation("http://localhost:3000/login?next=%2F", 3000, p), "/api/preview/abc123/login?next=%2F");
  assert.equal(previewLocation("http://127.0.0.1:3000/", 3000, p), "/api/preview/abc123/");
  assert.equal(previewLocation("https://github.com/login", 3000, p), "https://github.com/login", "somewhere else stays where it was");
  assert.equal(previewLocation("http://localhost:4000/x", 3000, p), "http://localhost:4000/x", "another port is another server");
  assert.equal(previewLocation("//cdn.example.com/a.js", 3000, p), "//cdn.example.com/a.js");
  assert.equal(previewLocation("next", 3000, p), "next", "relative resolves inside already");
});

test("nothing listening is said at once, in words, not as a timeout", async () => {
  const t0 = Date.now();
  await assert.rejects(fetchPreview(1, "/"), new RegExp(NOT_LISTENING.replace(".", "\.")));
  assert.ok(Date.now() - t0 < 5000);
  assert.match(previewTrouble(NOT_LISTENING), /Nothing is running there/);
  assert.match(previewTrouble("Your machine didn't answer in time (preview.fetch)."), /two minutes/);
  assert.equal(previewTrouble("Something else"), "Something else");
});

import { servedUrlIn } from "../src/client/previewBus.js";

test("the Preview opens by itself only on a site a server says it is serving, never an API, a database or a model server", () => {
  assert.equal(servedUrlIn("  VITE v6  ready in 300 ms\n\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host"), "http://localhost:5173/");
  assert.equal(servedUrlIn("   - Local:        http://localhost:3000\n ✓ Ready in 1.2s"), "http://localhost:3000/");
  assert.equal(servedUrlIn("The site is running at localhost:4321."), "http://localhost:4321/");
  // An agent explaining code that calls Ollama, a database or an API: nothing to look at.
  assert.equal(servedUrlIn("The scorer posts each window to http://localhost:11434/api/generate and parses the reply."), undefined);
  assert.equal(servedUrlIn("Server running on http://localhost:8000/api/v1"), undefined, "an API, even when said to be running");
  assert.equal(servedUrlIn("DATABASE_URL points at localhost:5432"), undefined);
  assert.equal(servedUrlIn("const BASE = 'http://localhost:3000';"), undefined, "an address in code, not a server saying it is up");
  assert.equal(servedUrlIn("Ran the tests: 12 passed"), undefined);
});

test("a server said to be up by its port alone opens the Preview on it, and a database's port still doesn't", () => {
  assert.equal(servedUrlIn("The preview is running on 4174. I'll screenshot each view."), "http://localhost:4174/");
  assert.equal(servedUrlIn("Dev server listening on port 5173"), "http://localhost:5173/");
  assert.equal(servedUrlIn("Postgres is running on 5432"), undefined, "a database isn't a page");
  assert.equal(servedUrlIn("I changed 4174 lines of the server"), undefined, "a number isn't an address");
});
