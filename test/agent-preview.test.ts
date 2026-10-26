import assert from "node:assert/strict";
import test from "node:test";
import { showPreview } from "../src/agent/tools.js";
import { SYSTEM_NOTE } from "../src/engine/hub.js";
import { askIosPreview, servedUrlIn, takeIosAsk } from "../src/client/previewBus.js";

/** Agents loading previews (2026-10-18): coding tools say where, Friday Code says so with its tool, and iOS has its own ask. */

test("a coding tool's \"Preview: <address>\" line opens that address, and the note tells every coding tool to write it", () => {
  assert.equal(servedUrlIn("Started the dev server in the background.\nPreview: http://localhost:5173\nTell me what you think."), "http://localhost:5173/");
  assert.equal(servedUrlIn("Preview: http://127.0.0.1:3000/dashboard"), "http://127.0.0.1:3000/dashboard");
  assert.match(SYSTEM_NOTE, /Preview: http:\/\/localhost:PORT/);
  assert.match(SYSTEM_NOTE, /Preview: ios/);
});

test("an iOS ask waits for its own session's panel, is taken once, and says whether the panel should build", () => {
  (globalThis as { dispatchEvent?: (e: Event) => boolean }).dispatchEvent ??= () => true;
  (globalThis as { CustomEvent?: unknown }).CustomEvent ??= class extends Event {
    detail: unknown;
    constructor(type: string, init?: { detail?: unknown }) {
      super(type);
      this.detail = init?.detail;
    }
  };
  askIosPreview("s1", true);
  assert.equal(takeIosAsk("s2"), null, "another session's panel doesn't take it");
  const a = takeIosAsk("s1");
  assert.equal(a?.run, true);
  assert.equal(takeIosAsk("s1"), null, "taken once");
  askIosPreview("s1", false);
  assert.equal(takeIosAsk("s1")?.run, false, "Friday Code's own tool has the build going: the panel only shows it");
});

test("show_preview with a url shows it and starts nothing; a url that isn't one is refused", async () => {
  const calls: unknown[] = [];
  const ctx = { readRepo: async (r: unknown) => (calls.push(r), { output: "{}" }) } as unknown as Parameters<typeof showPreview.run>[1];
  const ok = await showPreview.run({ url: "http://localhost:4000" }, ctx, "c1");
  assert.match(ok.output, /Showing http:\/\/localhost:4000 in the Preview panel/);
  assert.ok(!ok.isError);
  assert.equal(calls.length, 0, "nothing is started on the machine");
  const bad = await showPreview.run({ url: "rm -rf /" }, ctx, "c2");
  assert.equal(bad.isError, true);
});
