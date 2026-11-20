import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { serversOp } from "../src/runner/dev-servers.js";
import { listManaged, readManagedLog, restartManaged, reusableServer, startManaged, stopAllManaged, stopManaged } from "../src/runner/dev-servers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => Promise<boolean> | boolean, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return true;
    await sleep(100);
  }
  return false;
};
const folder = (scripts: Record<string, string>) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "friday-servers-"));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts }));
  writeFileSync(path.join(dir, "serve.js"), 'require("http").createServer((q,r)=>{r.setHeader("content-type","text/html");r.end("<h1>hi</h1>")}).listen(process.env.PORT||0,function(){console.log("up at http://localhost:"+this.address().port)})');
  writeFileSync(path.join(dir, "crash.js"), 'console.log("about to fall over");process.exit(3)');
  return dir;
};
const find = async (dir: string, id: string) => (await listManaged(dir, false)).servers.find((s) => s.id === id)!;

test("a server is started by the runner, answers, is reused, restarted and stopped", async () => {
  const dir = folder({ dev: "node serve.js" });
  try {
    const before = await find(dir, "script:dev");
    assert.equal(before.phase, "stopped");
    assert.equal(before.managed, false);
    await startManaged(dir, "script:dev");
    assert.ok(await until(async () => (await find(dir, "script:dev")).phase === "running"), "it comes up");
    const up = await find(dir, "script:dev");
    assert.ok(up.port && up.pid);
    const res = await fetch(`http://localhost:${up.port}/`);
    assert.match(await res.text(), /hi/);
    // A second start leaves the one that is up.
    const again = await startManaged(dir, "script:dev");
    assert.equal(again.pid, up.pid);
    // An agent run wanting a server gets this one.
    const kept = await reusableServer(dir);
    assert.equal(kept?.port, up.port);
    assert.ok(readManagedLog(dir, "script:dev").lines.some((l) => /up at http/.test(l.text)));
    // Restart: a different process, same folder, up again.
    await restartManaged(dir, "script:dev");
    assert.ok(await until(async () => (await find(dir, "script:dev")).phase === "running"));
    assert.notEqual((await find(dir, "script:dev")).pid, up.pid);
    await stopManaged(dir, "script:dev");
    assert.equal((await find(dir, "script:dev")).phase, "stopped");
    assert.equal(await reusableServer(dir), null);
    assert.ok(await until(async () => !(await fetch(`http://localhost:${up.port}/`).then(() => true, () => false))), "its port is free again");
  } finally {
    stopAllManaged();
  }
});

test("a server that crashes is started again and the log says so; stopping ends the retries", async () => {
  const dir = folder({ start: "node crash.js" });
  try {
    await startManaged(dir, "script:start");
    assert.ok(await until(async () => (await find(dir, "script:start")).phase === "restarting"), "it is waiting to restart");
    const s = await find(dir, "script:start");
    assert.equal(s.tries, 1);
    assert.match(s.note, /try 1 of 3/);
    assert.ok(readManagedLog(dir, "script:start").lines.some((l) => /crashed \(code 3\); restarting in 1s \(try 1 of 3\)/.test(l.text)));
    assert.ok(await until(async () => (await find(dir, "script:start")).tries === 2, 8000), "and a second time");
    await stopManaged(dir, "script:start");
    assert.equal((await find(dir, "script:start")).phase, "stopped");
    await sleep(1500);
    assert.equal((await find(dir, "script:start")).phase, "stopped", "nothing restarts after a stop");
  } finally {
    stopAllManaged();
  }
});

test("only what the folder declares can be started", async () => {
  const dir = folder({ dev: "node serve.js" });
  await assert.rejects(() => startManaged(dir, "script:rm-rf"), /declares no server/);
});

const free = () =>
  new Promise<number>((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

test("two starts close together run one process, and stop leaves none", async () => {
  const dir = folder({ dev: "node serve.js" });
  try {
    const [a, b] = await Promise.all([startManaged(dir, "script:dev"), startManaged(dir, "script:dev")]);
    assert.equal(a.pid, b.pid);
    assert.ok(await until(async () => (await find(dir, "script:dev")).phase === "running"));
    const up = await find(dir, "script:dev");
    const [c, d] = await Promise.all([restartManaged(dir, "script:dev"), restartManaged(dir, "script:dev")]);
    assert.ok(c.pid && d.pid);
    assert.ok(await until(async () => (await find(dir, "script:dev")).phase === "running"));
    const now = await find(dir, "script:dev");
    assert.ok(await until(() => gone(up.pid!)), "the first process is gone");
    await stopManaged(dir, "script:dev");
    assert.ok(await until(() => gone(now.pid!)), "nothing is left running");
    assert.ok(await until(async () => !(await fetch(`http://localhost:${now.port}/`).then(() => true, () => false))));
  } finally {
    stopAllManaged();
  }
});

test("a process that listens on nothing is running without a port and holds nobody up", async () => {
  const dir = folder({ dev: "node worker.js" });
  writeFileSync(path.join(dir, "worker.js"), "setInterval(()=>{},1000)");
  try {
    await startManaged(dir, "script:dev");
    const t0 = Date.now();
    assert.equal(await reusableServer(dir, 15000), null);
    assert.ok(Date.now() - t0 < 2000, "no waiting for something that serves nothing");
    assert.ok(await until(async () => (await find(dir, "script:dev")).phase === "running", 12000), "it is running, not starting for ever");
    const w = await find(dir, "script:dev");
    assert.equal(w.port, null);
    const t1 = Date.now();
    assert.equal(await reusableServer(dir, 15000), null);
    assert.ok(Date.now() - t1 < 2000);
  } finally {
    stopAllManaged();
  }
});

test("a server on a port of its own, printed or not, gets that port, and a later URL in the log does not move it", async () => {
  const dir = folder({ dev: "node fixed.js" });
  const port = await free();
  writeFileSync(path.join(dir, "fixed.js"), `require("http").createServer((q,r)=>r.end("ok")).listen(${port},()=>setTimeout(()=>console.log("proxying /api to http://localhost:9999"),1500))`);
  try {
    await startManaged(dir, "script:dev");
    assert.ok(await until(async () => (await find(dir, "script:dev")).phase === "running"));
    assert.equal((await find(dir, "script:dev")).port, port);
    await sleep(2500);
    assert.equal((await find(dir, "script:dev")).port, port, "a URL in a later line is only a line");
    assert.ok(!(await listManaged(dir, true)).external.some((x) => x.port === port), "not also listed as started elsewhere");
  } finally {
    stopAllManaged();
  }
});

test("a server slower than the portless wait still ends up running on its port", async () => {
  const dir = folder({ dev: "node slow.js" });
  const port = await free();
  writeFileSync(path.join(dir, "slow.js"), `setTimeout(()=>require("http").createServer((q,r)=>r.end("ok")).listen(${port}),9000)`);
  try {
    await startManaged(dir, "script:dev");
    assert.ok(await until(async () => (await find(dir, "script:dev")).port === port && (await find(dir, "script:dev")).phase === "running", 25000));
  } finally {
    stopAllManaged();
  }
});

test("the folder's own default port is kept, no PORT is handed out, and it is the same after a restart", async () => {
  const dir = folder({ dev: "node app.js" });
  const port = await free();
  writeFileSync(path.join(dir, "app.js"), `require("http").createServer((q,r)=>r.end("ok")).listen(process.env.PORT||${port})`);
  try {
    await startManaged(dir, "script:dev");
    assert.ok(await until(async () => (await find(dir, "script:dev")).phase === "running"));
    assert.equal((await find(dir, "script:dev")).port, port);
    await restartManaged(dir, "script:dev");
    assert.ok(await until(async () => (await find(dir, "script:dev")).phase === "running"));
    assert.equal((await find(dir, "script:dev")).port, port);
  } finally {
    stopAllManaged();
  }
});

test("stopping a managed server from the Preview's Local servers (stop-port) leaves it stopped", async () => {
  const dir = folder({ dev: "node serve.js" });
  try {
    await startManaged(dir, "script:dev");
    assert.ok(await until(async () => (await find(dir, "script:dev")).phase === "running"));
    const up = await find(dir, "script:dev");
    const r = (await serversOp("stop-port", { root: dir, port: up.port! })) as { stopped: boolean };
    assert.equal(r.stopped, true);
    await sleep(3500);
    const after = await find(dir, "script:dev");
    assert.equal(after.phase, "stopped");
    assert.ok(gone(up.pid!));
  } finally {
    stopAllManaged();
  }
});

test("a folder reached by a symlink and by its real path is one folder", { skip: process.platform === "win32" }, async () => {
  const dir = folder({ dev: "node serve.js" });
  const link = `${dir}-link`;
  symlinkSync(dir, link);
  try {
    const a = await startManaged(dir, "script:dev");
    const b = await startManaged(link, "script:dev");
    assert.equal(a.pid, b.pid);
  } finally {
    stopAllManaged();
  }
});
