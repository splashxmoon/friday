import assert from "node:assert/strict";
import test from "node:test";
import { isLocalUrl, lookFailed, lookOf, pageAppears, type PageLook } from "../src/client/previewBus.js";

test("only addresses of things running on this computer open in the Preview browser", () => {
  for (const u of ["http://localhost:5174/", "http://localhost:3000", "https://localhost/", "http://127.0.0.1:8080/app?x=1", "http://[::1]:5173/", "HTTP://LOCALHOST:5173/"]) assert.equal(isLocalUrl(u), true, u);
  for (const u of ["https://github.com/o/r", "http://localhost.evil.test/", "http://example.com:5173/", "ftp://localhost/", "http://127.0.0.1.evil.test/", "/relative", ""]) assert.equal(isLocalUrl(u), false, u);
});

/** Arun, 2026-10-20: the coding tools "randomly opening the preview side panel when there is nothing there". */
test("the Preview opens by itself only on a page: not on nothing listening, an error, or an API's JSON", async () => {
  assert.equal(lookOf({ status: 200, type: "text/html; charset=utf-8" }), "page");
  assert.equal(lookOf({ status: 302, type: "text/plain" }), "page", "a redirect to the app's page");
  assert.equal(lookOf({ status: 200, type: "application/json" }), "none", "an API");
  assert.equal(lookOf({ status: 404, type: "text/html" }), "none");
  assert.equal(lookOf({ status: 500, type: "text/html" }), "none");
  assert.equal(lookFailed(new Error("Nothing is listening on that port.")), "none");
  assert.equal(lookFailed(new Error("No machine is connected.")), "unknown");

  const looks = (answers: PageLook[]) => {
    const asked: [number, string][] = [];
    return { asked, look: async (port: number, path: string) => (asked.push([port, path]), answers.shift() ?? "none") };
  };
  const quick = [0, 1, 1, 1];
  const up = looks(["none", "none", "page"]);
  assert.equal(await pageAppears("http://localhost:5173/app?x=1", up.look, quick), true, "a server that gets there in a moment");
  assert.deepEqual(up.asked[0], [5173, "/app?x=1"]);
  assert.equal(up.asked.length, 3, "stops looking once it has a page");
  assert.equal(await pageAppears("http://localhost:8787/", looks([]).look, quick), false, "nothing there, every time: the panel stays shut");
  assert.equal(await pageAppears("http://localhost:3000/", looks(["unknown"]).look, quick), true, "no way to tell: opens as before");
  const thrown = async () => {
    throw new Error("Nothing is listening on that port.");
  };
  assert.equal(await pageAppears("http://localhost:3000/", thrown, quick), false);
});
