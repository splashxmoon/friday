import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fetchPreview, previewOptions, previewStatus, startPreview, stopAllPreviews, stopPreview } from "../src/runner/preview.js";

/**
 * The preview runs someone's project on their machine, so what it will and
 * won't start matters as much as that it works.
 */

let dir = "";
let site = "";
let empty = "";

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "friday-preview-"));
  site = path.join(dir, "site");
  empty = path.join(dir, "empty");
  await mkdtemp(site).catch(() => {});
  await rm(site, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  await writeFile(path.join(dir, "ignore"), "");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(site, { recursive: true });
  await mkdir(empty, { recursive: true });
  await writeFile(path.join(site, "index.html"), "<!doctype html><h1>hello preview</h1>");
  await writeFile(path.join(site, "app.css"), "h1 { color: rebeccapurple }");
});
after(async () => {
  stopAllPreviews();
  await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("a folder of HTML previews with no install, and serves its files", async () => {
  const options = await previewOptions(site);
  assert.deepEqual(options, { scripts: [], static: true });

  const info = await startPreview(site);
  assert.equal(info.ready, true);
  assert.equal(info.command, "static files");
  assert.equal(previewStatus(site)?.port, info.port);

  const page = await fetchPreview(info.port, "/");
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.match(Buffer.from(page.body, "base64").toString(), /hello preview/);

  const css = await fetchPreview(info.port, "/app.css");
  assert.match(css.type, /text\/css/);

  // Plain "../" is normalised away by any client before it is sent, so what
  // matters is the encoded form, which reaches the server intact.
  const climbed = await fetchPreview(info.port, "/%2e%2e%2f%2e%2e%2fetc%2fhosts");
  assert.equal(climbed.status, 403, "a path that climbs out of the folder is refused");
  const dotted = await fetchPreview(info.port, "/../../../etc/hosts");
  assert.doesNotMatch(Buffer.from(dotted.body, "base64").toString(), /localhost/, "and never serves a file from outside it");

  // Starting again is the same preview, not a second one.
  assert.equal((await startPreview(site)).port, info.port);
  assert.equal(stopPreview(site), true);
  assert.equal(previewStatus(site), null);
});

test("it only starts what the project already declares, and says so when there's nothing", async () => {
  await assert.rejects(startPreview(empty), /Nothing to preview here/);

  await writeFile(path.join(empty, "package.json"), JSON.stringify({ scripts: { dev: "node server.js", test: "node test.js" } }));
  assert.deepEqual((await previewOptions(empty)).scripts, ["dev"], "only serve-ish scripts are offered");
  // Anything not declared is refused, so nobody can push a command through this.
  await assert.rejects(startPreview(empty, "rm -rf /"), /no "rm -rf \/" script/);
  await assert.rejects(startPreview(empty, "test"), /no "test" script/);
});
