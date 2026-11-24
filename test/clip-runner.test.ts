import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { changedWords, clipBefore, clipPage } from "../src/runner/preview-check.js";
import { previewStatus, startPreview, stopPreview } from "../src/runner/preview.js";

// Proof clips, the runner's half (Arun, 2026-11-21: "i want this proof clips to be very advanced.... and can be toggled on or off"):
// the words a change added, read from a real repository's diff; a clip that walks through them; and the page before the change, from a
// copy of the code at the last commit, served by a second server and cleaned up after. Chrome through playwright-core records here (the
// desktop app does it in the real Friday), so these run only where its Chromium is installed.

const chromium = await import("playwright-core").then((m) => (m as { chromium: { executablePath(): string } }).chromium.executablePath(), () => "");
const canRecord = !!chromium && existsSync(chromium);

const PAGE = (extra: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Acme</title>
<style>body{margin:0;font:16px system-ui,sans-serif} main{padding:32px} .tall{height:1200px} #more{display:none}</style></head>
<body><main><h1>Dashboard</h1><div class="tall">Chart</div>${extra}</main></body></html>
`;
const NEW = `<section><h2>Weekly report</h2><button type="button" onclick="document.getElementById('more').style.display='block'">Show details</button><p id="more">42 signups</p>
<form><button>Delete everything</button></form></section>`;

function repo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "friday-clip-test-"));
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir });
  writeFileSync(path.join(dir, "index.html"), PAGE(""));
  g("init", "-q", "-b", "main");
  g("add", ".");
  g("commit", "-qm", "init");
  writeFileSync(path.join(dir, "index.html"), PAGE(NEW));
  return dir;
}
const isWebm = (b64: string) => Buffer.from(b64, "base64").subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
const worktrees = (dir: string) => execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: dir }).toString().split("\n").filter((l) => l.startsWith("worktree ")).length;

test("the words an uncommitted change added, from the folder's own diff", async () => {
  const dir = repo();
  try {
    assert.deepEqual((await changedWords(dir, ["index.html"])).map((t) => t.text), ["Weekly report", "Show details", "42 signups"]);
    assert.deepEqual(await changedWords(dir, ["../outside.html"]), [], "nothing outside the folder is read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a clip walks through what changed, presses what may be pressed, and the before clip comes from a copy that is cleaned up", { skip: !canRecord && "playwright-core's Chromium isn't installed", timeout: 240_000 }, async () => {
  const dir = repo();
  try {
    const info = await startPreview(dir, undefined, undefined, true);
    const after = await clipPage({ url: info.url + "/", cwd: dir, files: ["index.html"] });
    assert.ok(!("error" in after), "error" in after ? after.error : "");
    if ("error" in after) return;
    assert.ok(isWebm(after.data), "a WebM");
    assert.equal(Buffer.from(after.gif ?? "", "base64").subarray(0, 6).toString(), "GIF89a", "and the same walk as a GIF");
    assert.ok(Buffer.from(after.gif!, "base64").length < 4_000_000);
    assert.equal(after.label, "after");
    assert.deepEqual([after.width, after.height], [1280, 800]);
    const labels = after.marks.map((m) => m.label);
    assert.ok(labels.includes("New: “Weekly report”"), labels.join(" | "));
    assert.ok(labels.includes("Clicked “Show details”"), "the button that opens something is pressed");
    assert.ok(!labels.some((l) => l.startsWith("Clicked “Delete")), "a form's button that would delete is never pressed");
    assert.ok(after.durationMs >= 5000 && after.durationMs <= 16_000, `${after.durationMs}ms`);
    assert.ok(after.stops.length >= 1 && after.stops[0]! > 0, "it scrolled down to the new section");
    const phone = await clipPage({ url: info.url + "/", cwd: dir, files: ["index.html"], width: "phone" });
    assert.ok(!("error" in phone) && phone.label === "phone" && phone.width === 390);
    // Its own copy, not one an earlier run on this computer left behind (a real before clip of another repo, 2026-11-22).
    const copies = () => readdirSync(os.tmpdir()).filter((f) => f.startsWith("friday-before-") && existsSync(path.join(os.tmpdir(), f, "app")));
    const there = new Set(copies());
    const before = await clipBefore({ url: info.url + "/", cwd: dir, files: ["index.html"], stops: after.stops });
    assert.ok(!("error" in before), "error" in before ? before.error : "");
    if ("error" in before) return;
    assert.ok(isWebm(before.data));
    assert.equal(before.label, "before");
    assert.deepEqual(before.marks, [], "the before page has none of the new words");
    // The copy had a server of its own: the folder's own preview is still the one running, untouched (on a Mac the temp folder is
    // reached through a link, /var to /private/var, which once made the copy's path the folder's own).
    assert.equal(previewStatus(dir)?.url, info.url, "the folder's own preview is left running");
    stopPreview(dir);
    assert.equal(worktrees(dir), 1, "the copy is gone from git's list");
    assert.deepEqual(copies().filter((f) => !there.has(f)), [], "and from the temp folder");
  } finally {
    stopPreview(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("asked for a page that isn't on this computer, or a before with no repository, it says so", async () => {
  const off = await clipPage({ url: "https://example.com/" });
  assert.ok("error" in off && /localhost/.test(off.error));
  const plain = mkdtempSync(path.join(os.tmpdir(), "friday-clip-plain-"));
  try {
    const r = await clipBefore({ url: "http://localhost:9/", cwd: plain, files: ["index.html"] });
    assert.ok("error" in r && /isn't a git repository/.test(r.error));
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});
