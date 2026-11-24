import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Read when the module loads: a short idle window so the idle stop can be seen, and a short stall guard.
process.env.FRIDAY_VSCODE_IDLE_MS = "2500";
process.env.FRIDAY_VSCODE_STALL_MS = "700";

const plat = (() => {
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  return process.platform === "darwin" ? `macos-${arch}` : process.platform === "linux" ? `linux-${arch}` : `windows-${arch}`;
})();
const VERSION = "4.145.2";
const STAND_IN = readFileSync(path.join(import.meta.dirname, "..", "e2e", "fixtures", "vscode-stand-in.mjs"), "utf8");

async function until(fn: () => boolean | Promise<boolean>, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

function listen(server: Server): Promise<number> {
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port)));
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const reachable = async (origin: string) => {
  try {
    await fetch(origin + "/healthz", { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
};
const vsDir = () => path.join(process.env.FRIDAY_HOME!, "vscode");

/** A fake release: code-server-<v>-<plat>/bin/code-server, a shell script that runs the stand-in. */
function fakeRelease(work: string) {
  const inner = `code-server-${VERSION}-${plat}`;
  const src = path.join(work, "src", inner);
  mkdirSync(path.join(src, "bin"), { recursive: true });
  writeFileSync(path.join(src, "server.mjs"), STAND_IN);
  writeFileSync(path.join(src, "bin", "code-server"), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/../server.mjs" "$@"\n`);
  chmodSync(path.join(src, "bin", "code-server"), 0o755);
  const tgz = path.join(work, "fake.tar.gz");
  execFileSync("tar", ["-czf", tgz, "-C", path.join(work, "src"), inner]);
  const bytes = readFileSync(tgz);
  return { bytes, digest: createHash("sha256").update(bytes).digest("hex") };
}

test("the pinned table covers every platform the runner can name, with real-looking digests", async () => {
  const vs = await import("../src/runner/vscode.js");
  for (const p of ["macos-arm64", "macos-amd64", "linux-amd64", "linux-arm64", "windows-amd64"]) {
    const a = vs.PINNED_ASSETS[p];
    assert.ok(a, p);
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
    assert.ok(a.size > 100_000_000);
  }
  delete process.env.FRIDAY_VSCODE_DOWNLOAD_BASE;
  const a = vs.assetFor("macos-arm64");
  assert.equal(a.url, `https://github.com/coder/code-server/releases/download/v${VERSION}/code-server-${VERSION}-macos-arm64.tar.gz`);
  assert.equal(a.sha256, vs.PINNED_ASSETS["macos-arm64"].sha256);
});

test("the folder address: a Windows drive or UNC path becomes a server path, spaces and # survive", async () => {
  const vs = await import("../src/runner/vscode.js");
  assert.equal(vs.folderParam("C:\\Users\\me\\proj", "win32"), "/C:/Users/me/proj");
  assert.equal(vs.folderParam("\\\\server\\share\\x", "win32"), "//server/share/x");
  assert.equal(vs.folderParam("/home/me/proj", "linux"), "/home/me/proj");
  const u = new URL(vs.urlFor(1234, "C:\\My Docs\\a#b", "win32"));
  assert.equal(u.searchParams.get("folder"), "/C:/My Docs/a#b");
  const l = new URL(vs.loginFor(1234, "C:\\My Docs\\a#b", "win32"));
  assert.equal(l.pathname, "/login");
  const to = new URL(l.searchParams.get("to")!, "http://x");
  assert.equal(to.searchParams.get("folder"), "/C:/My Docs/a#b");
});

test("install downloads, verifies, unpacks, starts behind a password and removes", { skip: process.platform === "win32" }, async () => {
  const work = mkdtempSync(path.join(os.tmpdir(), "vsc-test-"));
  process.env.FRIDAY_HOME = path.join(work, "home");
  const { bytes, digest } = fakeRelease(work);
  let mode: "ok" | "cut" | "hang" = "ok";
  const server = createServer((q, r) => {
    if (!q.url?.startsWith("/dl/")) return void r.end();
    r.setHeader("content-length", bytes.length);
    if (mode === "ok") return void r.end(bytes);
    r.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
    if (mode === "cut") setTimeout(() => r.destroy(), 100);
    // "hang": never ends.
  });
  const port = await listen(server);
  process.env.FRIDAY_VSCODE_DOWNLOAD_BASE = `http://127.0.0.1:${port}/dl`;
  process.env.FRIDAY_VSCODE_SIZE = String(bytes.length);
  process.env.FRIDAY_VSCODE_SHA256 = "0".repeat(64);
  delete process.env.FRIDAY_CODE_SERVER_BIN;
  const vs = await import("../src/runner/vscode.js");
  const settle = async () => {
    await until(async () => (await vs.vscodeStatus()).installing === null);
    return vs.vscodeStatus();
  };
  try {
    // Plant leftovers: a half download, an abandoned staging folder, an older build.
    mkdirSync(vsDir(), { recursive: true });
    writeFileSync(path.join(vsDir(), `code-server-${VERSION}-${plat}.tar.gz.99999.part`), "x");
    mkdirSync(path.join(vsDir(), "u99999", "deep"), { recursive: true });
    mkdirSync(path.join(vsDir(), "code-server-0.0.1", "bin"), { recursive: true });

    let s = await vs.vscodeStatus();
    assert.equal(s.supported, true);
    assert.equal(s.installed, null);
    assert.equal(s.version, VERSION);
    assert.equal(s.downloadBytes, bytes.length);

    // A checksum mismatch is refused and leaves nothing behind.
    await vs.vscodeInstall();
    s = await settle();
    assert.match(s.error ?? "", /checksum/);
    assert.equal(s.installed, null);
    assert.deepEqual(readdirSync(vsDir()), [], "leftovers and the rejected download are gone");

    // A connection that drops midway is an error with Try again, not a stuck bar.
    process.env.FRIDAY_VSCODE_SHA256 = digest;
    mode = "cut";
    await vs.vscodeInstall();
    s = await settle();
    assert.ok(s.error, "the dropped download reports an error");
    assert.equal(s.installing, null);
    assert.equal(s.installed, null);

    // One that stalls ends by itself.
    mode = "hang";
    await vs.vscodeInstall();
    s = await settle();
    assert.match(s.error ?? "", /stalled/);
    assert.deepEqual(readdirSync(vsDir()), []);

    // A cancel (remove while installing) stops it and leaves no error and no files.
    await vs.vscodeInstall();
    await until(async () => ((await vs.vscodeStatus()).installing?.received ?? 0) > 0);
    s = await vs.vscodeCancel();
    assert.equal(s.installing, null);
    assert.equal(s.error, null);
    assert.deepEqual(readdirSync(vsDir()), []);

    mode = "ok";
    await vs.vscodeInstall();
    await until(async () => (await vs.vscodeStatus()).installed !== null);
    s = await vs.vscodeStatus();
    assert.equal(s.error, null);
    assert.ok(s.installed!.bytes > 0);
    assert.deepEqual(readdirSync(vsDir()), [`code-server-${VERSION}`], "only the build is on disk after an install");

    const root = path.join(work, "proj");
    mkdirSync(root);
    const started = await vs.vscodeStart(root, "http://127.0.0.1:1");
    const origin = started.url.split("/?")[0];
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/\?folder=/);
    assert.equal(decodeURIComponent(started.url.split("folder=")[1]), root);
    assert.ok(started.key.length >= 32);
    assert.equal((await fetch(origin + "/healthz")).ok, true);
    assert.ok(vs.vscodeToken());

    // Started behind a password, never open: no cookie gets the login, the wrong key is refused, the right key signs in.
    const info = (await (await fetch(origin + "/started-with")).json()) as { auth: string; password: boolean };
    assert.equal(info.auth, "password");
    assert.equal(info.password, true);
    const bare = await fetch(started.url, { redirect: "manual" });
    assert.equal(bare.status, 302);
    assert.match(bare.headers.get("location") ?? "", /^\/login/);
    const post = (pw: string) => fetch(started.login, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `password=${pw}` });
    assert.equal((await post("wrong")).status, 401);
    const signed = await post(started.key);
    assert.equal(signed.status, 302);
    const cookie = (signed.headers.get("set-cookie") ?? "").split(";")[0];
    const inside = await fetch(started.url, { headers: { cookie } });
    assert.equal(inside.status, 200);
    assert.match(await inside.text(), /VS Code stand-in/);

    // Reused for another folder: same port, same key.
    const again = await vs.vscodeStart(path.join(work, "other"), "http://127.0.0.1:1");
    assert.equal(again.url.split("/?")[0], origin);
    assert.equal(again.key, started.key);
    assert.equal((await vs.vscodeStatus()).running?.root, path.join(work, "other"));

    // The record a crash would leave for the next start to find.
    const rec = JSON.parse(readFileSync(path.join(vsDir(), "server.json"), "utf8"));
    assert.equal(rec.owner, process.pid);
    assert.ok(alive(rec.pid));

    // Default settings written once, never over the person's own.
    const settings = path.join(vsDir(), "data", "User", "settings.json");
    const parsed = JSON.parse(readFileSync(settings, "utf8"));
    assert.equal(parsed["workbench.preferredDarkColorTheme"], "Friday Dark");
    assert.equal(parsed["editor.fontSize"], 13);
    assert.match(parsed["editor.fontFamily"], /ui-monospace/);

    await vs.vscodeOpen("src/a.ts", 12);
    const req = JSON.parse(readFileSync(path.join(vsDir(), "bridge", "open.json"), "utf8"));
    assert.equal(req.path, "src/a.ts");
    assert.equal(req.line, 12);
    await vs.vscodeTheme(true);
    assert.equal(JSON.parse(readFileSync(path.join(vsDir(), "bridge", "theme.json"), "utf8")).theme, "dark");

    await vs.stopVscode();
    assert.equal(vs.vscodeToken(), null);
    await until(async () => !(await reachable(origin)));
    assert.ok(!alive(rec.pid));
    assert.ok(!existsSync(path.join(vsDir(), "server.json")));
    await assert.rejects(vs.vscodeOpen("a", 1), /isn't running/);

    // Remove: every build, partial file and the record go; the person's own settings stay.
    mkdirSync(path.join(vsDir(), "code-server-0.0.2"), { recursive: true });
    writeFileSync(path.join(vsDir(), `x.tar.gz.part`), "x");
    s = await vs.vscodeRemove();
    assert.equal(s.installed, null);
    assert.ok(existsSync(settings), "settings are kept");
    assert.deepEqual(readdirSync(vsDir()).filter((e) => e.startsWith("code-server") || e.endsWith(".part") || e === "server.json"), []);
  } finally {
    await vs.stopVscode();
    server.close();
    delete process.env.FRIDAY_VSCODE_DOWNLOAD_BASE;
    delete process.env.FRIDAY_VSCODE_SHA256;
    delete process.env.FRIDAY_VSCODE_SIZE;
  }
});

test("a server a crash left behind is ended by the next start; one nobody uses ends itself", { skip: process.platform === "win32" }, async () => {
  const work = mkdtempSync(path.join(os.tmpdir(), "vsc-stand-"));
  process.env.FRIDAY_HOME = path.join(work, "home");
  const bin = path.join(work, "stand.mjs");
  writeFileSync(bin, STAND_IN);
  process.env.FRIDAY_CODE_SERVER_BIN = bin;
  const userDir = path.join(work, "home", "vscode", "data", "User");
  mkdirSync(userDir, { recursive: true });
  writeFileSync(path.join(userDir, "settings.json"), JSON.stringify({ "editor.fontSize": 20 }));
  // An orphan: a stand-in with nothing recorded about its parent but its pid and port.
  const orphanPort = await new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });
  const orphan = spawn(process.execPath, [bin, "--bind-addr", `127.0.0.1:${orphanPort}`], { detached: true, stdio: "ignore" });
  orphan.unref();
  const vs = await import("../src/runner/vscode.js");
  try {
    await until(() => reachable(`http://127.0.0.1:${orphanPort}`));
    writeFileSync(path.join(work, "home", "vscode", "server.json"), JSON.stringify({ pid: orphan.pid, port: orphanPort, owner: 999999, startedAt: 1 }));
    const s = await vs.vscodeStatus();
    assert.ok(s.installed);
    const { url, login, key } = await vs.vscodeStart(work, "http://127.0.0.1:1");
    const origin = url.split("/?")[0];
    assert.ok(!alive(orphan.pid!) || (await until(() => !alive(orphan.pid!), 3000), true), "the orphan was ended by the start");
    assert.equal((await fetch(origin + "/healthz")).ok, true);
    assert.ok(login.startsWith(origin + "/login"));
    assert.ok(key);
    const parsed = JSON.parse(readFileSync(path.join(userDir, "settings.json"), "utf8"));
    assert.equal(parsed["editor.fontSize"], 20);
    assert.equal(parsed["telemetry.telemetryLevel"], "off");

    // Nobody calls status: the idle window ends it.
    await until(async () => !(await reachable(origin)), 12000);
    // Its key goes once the stop has waited for the server to end, a moment after it stops answering (v0.4.1's Linux CI caught it
    // in between).
    await until(() => vs.vscodeToken() === null, 5000);
    assert.equal(vs.vscodeToken(), null);
  } finally {
    await vs.stopVscode();
    try {
      process.kill(-orphan.pid!, "SIGKILL");
    } catch {
      // Already gone.
    }
    delete process.env.FRIDAY_CODE_SERVER_BIN;
  }
});

test("a settings.json with comments is left exactly as it is", { skip: process.platform === "win32" }, async () => {
  const work = mkdtempSync(path.join(os.tmpdir(), "vsc-cmt-"));
  process.env.FRIDAY_HOME = path.join(work, "home");
  const bin = path.join(work, "stand.mjs");
  writeFileSync(bin, STAND_IN);
  process.env.FRIDAY_CODE_SERVER_BIN = bin;
  const userDir = path.join(work, "home", "vscode", "data", "User");
  mkdirSync(userDir, { recursive: true });
  const text = '{\n  // my font\n  "editor.fontSize": 20, "x": "a,}"\n}\n';
  writeFileSync(path.join(userDir, "settings.json"), text);
  const vs = await import("../src/runner/vscode.js");
  try {
    await vs.vscodeStart(work, "http://127.0.0.1:1");
    assert.equal(readFileSync(path.join(userDir, "settings.json"), "utf8"), text);
  } finally {
    await vs.stopVscode();
    delete process.env.FRIDAY_CODE_SERVER_BIN;
  }
});

test("a retired default goes, a person's own value stays, and the new defaults are added", { skip: process.platform === "win32" }, async () => {
  const work = mkdtempSync(path.join(os.tmpdir(), "vsc-ret-"));
  process.env.FRIDAY_HOME = path.join(work, "home");
  const bin = path.join(work, "stand.mjs");
  writeFileSync(bin, STAND_IN);
  process.env.FRIDAY_CODE_SERVER_BIN = bin;
  const userDir = path.join(work, "home", "vscode", "data", "User");
  mkdirSync(userDir, { recursive: true });
  writeFileSync(path.join(userDir, "settings.json"), JSON.stringify({ "workbench.activityBar.compact": true, "editor.fontSize": 18 }));
  const vs = await import("../src/runner/vscode.js");
  try {
    await vs.vscodeStart(work, "http://127.0.0.1:1");
    const s = JSON.parse(readFileSync(path.join(userDir, "settings.json"), "utf8")) as Record<string, unknown>;
    assert.equal("workbench.activityBar.compact" in s, false);
    assert.equal(s["editor.fontSize"], 18);
    assert.equal(s["workbench.experimental.modernUI"], false);
    assert.equal(s["window.menuBarVisibility"], "hidden");
    // The window bar's buttons: only the three it has, written for the extension to run.
    await assert.rejects(vs.vscodeCommand("workbench.action.terminal.sendSequence"), /isn't something/);
    await vs.vscodeCommand("panel");
    const cmd = JSON.parse(readFileSync(path.join(work, "home", "vscode", "bridge", "command.json"), "utf8")) as { command: string; root: string };
    assert.equal(cmd.command, "workbench.action.togglePanel");
    assert.equal(cmd.root, work);
  } finally {
    await vs.stopVscode();
    delete process.env.FRIDAY_CODE_SERVER_BIN;
  }
});

test("the extension marketplace: Open VSX by default, https addresses only, and back again", async () => {
  const work = mkdtempSync(path.join(os.tmpdir(), "vsc-mkt-"));
  process.env.FRIDAY_HOME = path.join(work, "home");
  const vs = await import("../src/runner/vscode.js");
  let m = await vs.vscodeMarketplace();
  assert.equal(m.custom, false);
  assert.deepEqual(m.marketplace, vs.OPEN_VSX);
  await assert.rejects(vs.vscodeSetMarketplace({ serviceUrl: "http://example.com/gallery", itemUrl: "https://example.com/item" }), /https/);
  await assert.rejects(vs.vscodeSetMarketplace({ serviceUrl: "https://example.com/gallery", itemUrl: "nope" }), /https/);
  m = await vs.vscodeSetMarketplace({ serviceUrl: "https://example.com/vscode/gallery/", itemUrl: "https://example.com/vscode/item" });
  assert.equal(m.custom, true);
  assert.deepEqual(m.marketplace, { serviceUrl: "https://example.com/vscode/gallery", itemUrl: "https://example.com/vscode/item" });
  m = await vs.vscodeSetMarketplace(null);
  assert.equal(m.custom, false);
});

test("Friday's skin is linked from the workbench page once, and the Accounts default flipped", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vsc-skin-"));
  const wb = path.join(dir, "lib", "vscode", "out", "vs", "code", "browser", "workbench");
  mkdirSync(wb, { recursive: true });
  const link = `<link rel="stylesheet" href="{{WORKBENCH_WEB_BASE_URL}}/out/vs/code/browser/workbench/workbench.css">`;
  writeFileSync(path.join(wb, "workbench.html"), `<head>${link}</head>`);
  writeFileSync(path.join(wb, "workbench.js"), `a.getBoolean(wj.ACCOUNTS_VISIBILITY_PREFERENCE_KEY,0,!0)`);
  const vs = await import("../src/runner/vscode.js");
  await vs.slimBuild(dir);
  await vs.slimBuild(dir);
  const html = readFileSync(path.join(wb, "workbench.html"), "utf8");
  assert.equal(html.split("/workbench/friday.css").length - 1, 1);
  assert.ok(readFileSync(path.join(wb, "friday.css"), "utf8").includes(".activitybar"));
  assert.equal(readFileSync(path.join(wb, "workbench.js"), "utf8"), `a.getBoolean(wj.ACCOUNTS_VISIBILITY_PREFERENCE_KEY,0,!1)`);
});

test("every command the runner may ask for is one the extension will run", async () => {
  const vs = await import("../src/runner/vscode.js");
  const menu = await import("../src/vscode-menu.js");
  const ext = readFileSync(path.join(import.meta.dirname, "..", "src", "vscode-ext", "friday", "extension.js"), "utf8");
  const src = /const ALLOWED = (\/.+\/);/.exec(ext)![1]!;
  const allowed = new Function(`return ${src}`)() as RegExp;
  for (const c of [...Object.values(vs.VSCODE_COMMANDS), ...menu.VSCODE_MENU_COMMANDS]) assert.ok(allowed.test(c), c);
  assert.ok(!allowed.test("workbench.action.terminal.sendSequence;rm"), "nothing but a command id");
  await assert.rejects(vs.vscodeCommand("vscode.open"), /isn't something/);
});
