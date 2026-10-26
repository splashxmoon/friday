import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { localServers } from "../src/client/Preview.js";
import { listServers, parseLsof, parseNetstat, shortCommand, stopServer } from "../src/runner/ports.js";

/** Dev servers found from the computer's open ports (runner/ports.ts), not only the ones Friday started. */

test("lsof and netstat rows: local listeners only, with their ports and processes", () => {
  const lsof = ["p101", "cnode", "f20", "n*:5173", "f21", "n127.0.0.1:5174", "p202", "cpostgres", "f5", "n[::1]:5432", "p303", "csshd", "n192.168.1.4:2222"].join("\n");
  assert.deepEqual(parseLsof(lsof).map((r) => [r.pid, r.name, r.port]), [[101, "node", 5173], [101, "node", 5174], [202, "postgres", 5432]], "one bound to another address isn't reachable on localhost");
  const netstat = ["  Proto  Local Address          Foreign Address        State           PID", "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4120", "  TCP    127.0.0.1:9229         0.0.0.0:0              LISTENING       4121", "  TCP    10.0.0.2:139           0.0.0.0:0              LISTENING       4", "  TCP    127.0.0.1:3000         127.0.0.1:50000        ESTABLISHED     4120"].join("\r\n");
  assert.deepEqual(parseNetstat(netstat).map((r) => [r.pid, r.port]), [[4120, 3000], [4121, 9229]]);
  assert.equal(shortCommand("/usr/local/bin/node /Users/ada/shop/node_modules/.bin/vite --port 5173"), "node …/node_modules/.bin/vite --port 5173");
  assert.equal(shortCommand('"C:\\Program Files\\nodejs\\node.exe" server.js'), "node server.js");
});

test("a server Friday's list never had: found once it answers HTTP, as this project's when it runs in a folder inside it", { skip: process.platform === "win32" && "Windows has no working folder to read" }, async () => {
  const project = mkdtempSync(path.join(os.tmpdir(), "friday-ports-"));
  mkdirSync(path.join(project, "web"));
  const elsewhere = mkdtempSync(path.join(os.tmpdir(), "friday-ports-other-"));
  const port = await new Promise<number>((r) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => r(p));
    });
  });
  // As an agent's own shell would start it: not through Friday, in a folder below the session's.
  const child = spawn(process.execPath, ["-e", `require("http").createServer((q,s)=>s.end("ok")).listen(${port},"127.0.0.1")`], { cwd: path.join(project, "web"), stdio: "ignore" });
  // And something on a port that doesn't speak HTTP, which isn't a web server at all.
  const raw = spawn(process.execPath, ["-e", `require("net").createServer(()=>{}).listen(0,"127.0.0.1")`], { cwd: project, stdio: "ignore" });
  try {
    let found: Awaited<ReturnType<typeof listServers>> = [];
    for (let i = 0; i < 40 && !found.some((s) => s.port === port); i++) {
      await new Promise((r) => setTimeout(r, 250));
      found = await listServers(project);
    }
    const s = found.find((x) => x.port === port);
    assert.ok(s, "the server is listed");
    assert.equal(s!.here, true, "it runs inside the project");
    assert.equal(s!.url, `http://localhost:${port}`);
    assert.match(s!.command, /^node /);
    assert.equal(found.filter((x) => x.pid === raw.pid).length, 0, "a port that doesn't answer HTTP isn't a server to preview");
    await new Promise((r) => setTimeout(r, 2100));
    const other = (await listServers(elsewhere)).find((x) => x.port === port);
    assert.ok(other, "from another project it is still a dev server on this computer");
    assert.equal(other!.here, false);
  } finally {
    child.kill();
    raw.kill();
    rmSync(project, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("the server menu: the preview, what a task printed, then what was found, once per port, other projects' marked", () => {
  const info = { url: "http://localhost:5173", command: "npm run dev", ready: true, port: 5173 } as never;
  const found = [
    { port: 5173, url: "http://localhost:5173", pid: 1, command: "node vite", cwd: "/p", here: true },
    { port: 3001, url: "http://localhost:3001", pid: 2, command: "node api.js", cwd: "/p/api", here: true },
    { port: 8080, url: "http://localhost:8080", pid: 3, command: "python -m http.server", cwd: "/other", here: false },
  ];
  assert.deepEqual(localServers(info, [], found).map((s) => [s.url, s.preview, !!s.elsewhere]), [
    ["http://localhost:5173", true, false],
    ["http://localhost:3001", false, false],
    ["http://localhost:8080", false, true],
  ]);
});

test("a server stopped from its row in the menu: what listens on that port ends, and a port nobody serves says so", { skip: process.platform === "win32" && "Windows has no working folder to read" }, async () => {
  const project = mkdtempSync(path.join(os.tmpdir(), "friday-ports-stop-"));
  const port = await new Promise<number>((r) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => r(p));
    });
  });
  const child = spawn(process.execPath, ["-e", `require("http").createServer((q,s)=>s.end("ok")).listen(${port},"127.0.0.1")`], { cwd: project, stdio: "ignore" });
  const ended = new Promise((r) => child.once("exit", r));
  try {
    for (let i = 0; i < 40 && !(await listServers(project)).some((s) => s.port === port); i++) await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual(await stopServer(project, port), { stopped: true });
    await ended;
    assert.equal(child.exitCode !== null || child.signalCode !== null, true, "the server's process ended");
    assert.equal((await stopServer(project, port)).stopped, false, "nothing left on it to stop");
  } finally {
    child.kill();
    rmSync(project, { recursive: true, force: true });
  }
});

test("each server in the menu says how it stops: the preview's own, Friday's task, or what listens on the port", () => {
  const info = { url: "http://localhost:5173", command: "npm run dev", ready: true, port: 5173 } as never;
  const tasks = [{ id: "t1", command: "npm run api", running: true, log: ["listening on http://localhost:3001"] }];
  const found = [{ port: 8080, url: "http://localhost:8080", pid: 3, command: "python -m http.server", cwd: "/p", here: true }];
  assert.deepEqual(localServers(info, tasks, found).map((s) => [s.url, s.preview, s.stop ?? null]), [
    ["http://localhost:5173", true, null],
    ["http://localhost:3001", false, { task: "t1" }],
    ["http://localhost:8080", false, { port: 8080 }],
  ]);
});
