import assert from "node:assert/strict";
import http from "node:http";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fetchPreview, reachableAt, startPreview, stopPreview } from "../src/runner/preview.js";

/**
 * Showing the site the agent built: a dev server that listens only on IPv6
 * (what "localhost" is on current Node) must still be found, and a project
 * with dependencies declared but not installed must come up on its own.
 */
test("a server that answers only on ::1 is found, and its pages can be fetched", async (t) => {
  const server = http.createServer((_q, r) => r.end("on six"));
  try {
    await new Promise<void>((res, rej) => (server.once("error", rej), server.listen(0, "::1", res)));
  } catch {
    t.skip("no IPv6 loopback on this machine");
    return;
  }
  t.after(() => void server.close());
  const port = (server.address() as { port: number }).port;
  assert.equal(await reachableAt(port), "::1");
  const got = await fetchPreview(port, "/");
  assert.equal(got.status, 200);
  assert.equal(Buffer.from(got.body, "base64").toString(), "on six");
});

test("a project with missing dependencies gets them installed, then its dev script is started and shown", { timeout: 150_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-site-"));
  t.after(async () => {
    stopPreview(dir);
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
  });
  // A dependency from disk, so the install needs no network.
  await mkdir(path.join(dir, "local-dep"), { recursive: true });
  await writeFile(path.join(dir, "local-dep", "package.json"), JSON.stringify({ name: "local-dep", version: "1.0.0" }));
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "site", version: "1.0.0", private: true, scripts: { dev: "node server.js" }, dependencies: { "local-dep": "file:./local-dep" } }),
  );
  await writeFile(path.join(dir, "server.js"), `require("local-dep/package.json"); require("http").createServer((q, r) => r.end("<h1>site</h1>")).listen(process.env.PORT, "127.0.0.1", () => console.log("Local: http://127.0.0.1:" + process.env.PORT + "/"));\n`);

  const info = await startPreview(dir, undefined, undefined, false, { install: true });
  assert.equal(info.ready, true, info.log.join("\n"));
  await access(path.join(dir, "node_modules", "local-dep"));
  const page = await fetchPreview(info.port, "/");
  assert.match(Buffer.from(page.body, "base64").toString(), /<h1>site<\/h1>/);
});

test("without the install allowance the dependencies are left alone", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-site-"));
  t.after(async () => {
    stopPreview(dir);
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
  });
  await mkdir(path.join(dir, "local-dep"), { recursive: true });
  await writeFile(path.join(dir, "local-dep", "package.json"), JSON.stringify({ name: "local-dep", version: "1.0.0" }));
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "site", version: "1.0.0", scripts: { dev: "node server.js" }, dependencies: { "local-dep": "file:./local-dep" } }));
  await writeFile(path.join(dir, "server.js"), `require("local-dep/package.json");\n`);
  await assert.rejects(() => startPreview(dir), /exited before serving anything/);
  await assert.rejects(() => access(path.join(dir, "node_modules")), "nothing was installed");
});

test("a dev server that colours its address and picks its own port is found where it really is, and its log is plain", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-site-"));
  t.after(async () => {
    stopPreview(dir);
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
  });
  // Vite's habit: the colour codes sit inside the address, and PORT is ignored.
  const ESC = String.fromCharCode(27);
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "site", version: "1.0.0", scripts: { dev: "node server.js" } }));
  await writeFile(
    path.join(dir, "server.js"),
    `const s = require("http").createServer((q, r) => r.end("ok"));
s.listen(0, "127.0.0.1", () => {
  const p = s.address().port;
  console.log(${JSON.stringify(ESC)} + "[32m" + ${JSON.stringify(ESC)} + "[1mVITE" + ${JSON.stringify(ESC)} + "[22m ready");
  console.log("  Local:   " + ${JSON.stringify(ESC)} + "[36mhttp://localhost:" + ${JSON.stringify(ESC)} + "[1m" + p + ${JSON.stringify(ESC)} + "[22m/" + ${JSON.stringify(ESC)} + "[39m");
});
`,
  );
  const info = await startPreview(dir);
  assert.equal(info.ready, true, info.log.join(" | "));
  assert.match(info.url, /:\d+$/);
  assert.notEqual(info.port, Number(new URL(info.url).port) + 1);
  assert.ok(info.log.every((l) => !l.includes(ESC)), "no colour codes are left in what is shown");
  assert.ok(info.log.some((l) => /Local:\s+http:\/\/localhost:\d+\//.test(l)), `the address reads as text: ${info.log.join(" | ")}`);
  const page = await fetchPreview(info.port, "/");
  assert.equal(Buffer.from(page.body, "base64").toString(), "ok");
});
