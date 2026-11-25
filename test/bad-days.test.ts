// Friday on its bad days, end to end through startLocal and its own API (spec 13, Wave 4; Arun 2026-11-24: "Go all out and fix
// these problems"): what a person did is on disk after each, and Friday carries on. Runs in `npm test`, so on Linux, macOS and
// Windows in the open-source repository's checks.
//
// - Two Fridays on one data folder, in two processes: the second opens the first's address, or, while the first isn't answering,
//   is turned away with FridayAlreadyOpen; the first keeps working, and nothing of the second is written.
// - Quit right after a change: what was changed is there at the next start.
// - A lock left by a Friday whose process is gone: taken over.
// - A session's log cut off mid-line, as a power cut leaves it: the session opens with everything before the cut, and what is added
//   after it is kept, never stuck to the broken line.
// - A full disk while a session's log is added to: the events wait in memory, are written once the disk has room, and are there
//   after a restart.
//
// The unit-level checks of each piece are test/safe-saves.test.ts, test/local-kv-logs.test.ts and test/local-kv-ondemand.test.ts.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Nothing here reaches past this computer, and no coding tool starts: these are Friday's own saves.
process.env.FRIDAY_NO_TELEMETRY = "1";
process.env.FRIDAY_RELAY = "off";
process.env.FRIDAY_NO_TOOL_UPDATES = "1";
process.env.FRIDAY_LOCAL_RUNNER = "0";

// ── The first Friday of "two on one folder", in a process of its own ──────────────────────────────────────────────────────────
// Says READY with its address once it listens; "quit" on its input closes it as the app's quit does, and it says CLOSED.
if (process.env.FRIDAY_BADDAY_CHILD) {
  const { startLocal } = await import("../src/local/start.js");
  const f = await startLocal({ home: process.env.FRIDAY_BADDAY_CHILD, port: 0 });
  process.stdout.write(`READY ${f.url} ${process.pid}\n`);
  for await (const line of createInterface({ input: process.stdin })) {
    if (line.trim() !== "quit") continue;
    await f.close();
    process.stdout.write("CLOSED\n");
    process.exit(0);
  }
  process.exit(0);
}

const { startLocal, FridayAlreadyOpen } = await import("../src/local/start.js");
const { logFile } = await import("../src/local/logs.js");

const sandbox = mkdtempSync(path.join(tmpdir(), "friday-bad-days-"));
// A home folder of its own: nothing here reads this computer's settings or sign-ins.
process.env.HOME = process.env.USERPROFILE = path.join(sandbox, "person");
let n = 0;
const freshHome = () => path.join(sandbox, `home-${++n}`, ".friday");
/** startLocal, closed after the tests whatever happens (closing twice is closing once): one left open holds the process up. */
const opened: { close(): Promise<void> }[] = [];
test.after(async () => {
  for (const f of opened) await f.close().catch(() => {});
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const start = async (home: string) => {
  const f = await startLocal({ home, port: 0 });
  opened.push(f);
  return f;
};

async function call<T>(url: string, p: string, method = "GET", json?: unknown): Promise<T> {
  const r = await fetch(`${url}${p}`, { method, headers: { "Content-Type": "application/json", "x-friday-local": "1" }, ...(json === undefined ? {} : { body: JSON.stringify(json) }) });
  const text = await r.text();
  assert.ok(r.ok, `${method} ${p}: ${r.status} ${text}`);
  return JSON.parse(text) as T;
}
interface Session {
  sid: string;
  invite: string;
}
async function newSession(url: string, title: string): Promise<Session> {
  const made = await call<{ sessionId: string; invites: { owner: string } }>(url, "/api/sessions", "POST", { title });
  return { sid: made.sessionId, invite: made.invites.owner };
}
const q = (s: Session) => `invite=${encodeURIComponent(s.invite)}`;
/** A message to the session: one event in its log. */
const say = (url: string, s: Session, text: string) => call<{ seq: number }>(url, `/api/sessions/${s.sid}/instruct?${q(s)}`, "POST", { text });
/** What the session holds of what was said, in order, as the server reads it back from its log. */
async function said(url: string, s: Session): Promise<string[]> {
  const page = await call<{ events: { body: { type: string; text?: string } }[] }>(url, `/api/sessions/${s.sid}/history?${q(s)}&limit=200`);
  return page.events.filter((e) => e.body.type === "instruction").map((e) => e.body.text ?? "");
}
/** The session's log file, as Friday keeps it (local/logs.ts): every line one whole entry. */
const logOf = (home: string, s: Session) => path.join(home, logFile(`friday:{${s.sid}}:events`));
function wholeLines(file: string): number {
  const lines = readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n");
  assert.equal(lines.pop(), "", `${file} ends with a newline`);
  for (const [i, l] of lines.entries()) assert.doesNotThrow(() => JSON.parse(l), `line ${i + 1} of the log is whole: ${l.slice(0, 120)}`);
  return lines.length;
}
const until = async (what: string, ok: () => Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) assert.fail(`${what}: not within ${ms / 1000} s`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

test("two Fridays on one data folder: the second opens the first, or is turned away while the first isn't answering; the first keeps working", { timeout: 120_000 }, async (t) => {
  const home = freshHome();
  // The first, in a process of its own (another pid, as a second app or a second terminal would be).
  const tsx = fileURLToPath(import.meta.resolve("tsx/cli"));
  const first = spawn(process.execPath, [tsx, fileURLToPath(import.meta.url)], { env: { ...process.env, FRIDAY_BADDAY_CHILD: home }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  t.after(() => first.kill());
  let err = "";
  first.stderr.on("data", (d) => (err += String(d)));
  const lines = createInterface({ input: first.stdout });
  const next = (re: RegExp) =>
    new Promise<RegExpExecArray>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the first Friday didn't say ${re} in 60 s:\n${err.slice(-2000)}`)), 60_000);
      const on = (l: string) => {
        const m = re.exec(l);
        if (!m) return;
        clearTimeout(timer);
        lines.off("line", on);
        resolve(m);
      };
      lines.on("line", on);
      first.once("exit", (code) => reject(new Error(`the first Friday exited (${code}):\n${err.slice(-2000)}`)));
    });
  const [, url, pidText] = await next(/^READY (\S+) (\d+)$/);
  const pid = Number(pidText);

  // 1. Answering at its address: a second start opens it, and starts nothing of its own.
  const second = await start(home);
  assert.equal(second.already, true, "the second start found the first");
  assert.equal(second.url, url, "and opens the first's address");
  assert.equal(second.pid, pid);
  await second.close();

  // 2. Not answering yet (still starting, or stuck): turned away by the lock, saying whose it is. Nothing of it is written.
  unlinkSync(path.join(home, "running.json"));
  const data = readFileSync(path.join(home, "friday.lock"), "utf8");
  await assert.rejects(startLocal({ home, port: 0 }), (e: unknown) => e instanceof FridayAlreadyOpen && e.pid === pid && e.home === path.resolve(home) && /already open/.test(e.message));
  assert.equal(readFileSync(path.join(home, "friday.lock"), "utf8"), data, "the first's lock is left as it was");

  // 3. The first keeps working: a session and a message in it, kept when it quits.
  const s = await newSession(url!, "Still the first's");
  await say(url!, s, "Keep the first one's work");
  first.stdin.write("quit\n");
  await next(/^CLOSED$/);
  assert.ok(!existsSync(path.join(home, "friday.lock")), "the first let go of the folder as it closed");

  // 4. Started again: all of it there, and this start holds the folder now.
  const again = await start(home);
  assert.notEqual(again.already, true);
  assert.deepEqual(await said(again.url, s), ["Keep the first one's work"]);
  assert.equal(JSON.parse(readFileSync(path.join(home, "friday.lock"), "utf8")).pid, process.pid);
});

test("quit within 100 ms of a change: the change is on disk at the next start", async (t) => {
  const home = freshHome();
  const f = await start(home);
  const s = await newSession(f.url, "Quit at once");
  await say(f.url, s, "The first thing");
  await call(f.url, `/api/sessions/${s.sid}/title?${q(s)}`, "POST", { title: "Renamed just before quitting" });
  await say(f.url, s, "The last thing, said just before quitting");
  // Well inside the 100 ms: the save every two seconds hasn't come round, so only quitting's own save can have kept it.
  const t0 = performance.now();
  const closing = f.close();
  assert.ok(performance.now() - t0 < 100);
  await closing;

  const again = await start(home);
  assert.deepEqual(await said(again.url, s), ["The first thing", "The last thing, said just before quitting"]);
  const mine = await call<{ sessions: { sid: string; title?: string }[] }>(again.url, "/api/sessions/mine");
  assert.equal(mine.sessions.find((x) => x.sid === s.sid)?.title, "Renamed just before quitting", "the session is in the list, by its new name");
});

test("a lock left by a Friday whose process is gone is taken over, and Friday starts", async () => {
  const home = freshHome();
  // A process that was, and isn't: its pid is free (and on the off chance it was given out again, it is no Friday's).
  const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  const pid = Number(gone.stdout);
  assert.ok(pid > 0);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(home, { recursive: true });
  const os = await import("node:os");
  writeFileSync(path.join(home, "friday.lock"), JSON.stringify({ pid, boot: Math.round(Date.now() / 1000 - os.uptime()), at: Date.now() - 60_000 }));
  const f = await start(home);
  try {
    assert.notEqual(f.already, true);
    assert.equal(JSON.parse(readFileSync(path.join(home, "friday.lock"), "utf8")).pid, process.pid, "the lock is this Friday's now");
    const s = await newSession(f.url, "After a crash");
    await say(f.url, s, "Working again");
    assert.deepEqual(await said(f.url, s), ["Working again"]);
  } finally {
    await f.close();
  }
});

for (const cut of ["half a line added after the last one", "the last line cut in half"] as const)
  test(`a session's log with ${cut} (the power went mid-write): it opens with everything before the cut, and what comes after is kept`, async () => {
    const home = freshHome();
    let f = await start(home);
    const s = await newSession(f.url, "Power cut");
    for (const w of ["one", "two", "three", "four"]) await say(f.url, s, `Step ${w}`);
    await f.close();
    const file = logOf(home, s);
    const text = readFileSync(file, "utf8");
    const last = text.slice(text.lastIndexOf("\n", text.length - 2) + 1);
    if (cut === "half a line added after the last one") appendFileSync(file, last.slice(0, Math.floor(last.length / 2)));
    else truncateSync(file, statSync(file).size - Math.ceil(last.length / 2));
    const before = cut === "the last line cut in half" ? ["Step one", "Step two", "Step three"] : ["Step one", "Step two", "Step three", "Step four"];

    f = await start(home);
    assert.deepEqual(await said(f.url, s), before, "everything before the cut");
    await say(f.url, s, "Step five, after the restart");
    await say(f.url, s, "Step six");
    assert.deepEqual(await said(f.url, s), [...before, "Step five, after the restart", "Step six"]);
    await f.close();
    // On disk: whole lines only, the broken one gone, the new ones after what came before it.
    wholeLines(file);
    f = await start(home);
    try {
      assert.deepEqual(await said(f.url, s), [...before, "Step five, after the restart", "Step six"], "and so after the next start");
    } finally {
      await f.close();
    }
  });

test("a full disk while a session's log is added to: the events wait, are written once there's room, and are there after a restart", { timeout: 60_000 }, async (t) => {
  const home = freshHome();
  let f = await start(home);
  t.after(() => {
    delete process.env.FRIDAY_TEST_WRITE_FAIL;
  });
  const s = await newSession(f.url, "Full disk");
  await say(f.url, s, "Before the disk filled");
  type Saves = { failing?: { reason: string } };
  // Only this session's log can't be written (safe-file.ts FRIDAY_TEST_WRITE_FAIL): every append to it fails as a full disk would.
  process.env.FRIDAY_TEST_WRITE_FAIL = path.basename(logFile(`friday:{${s.sid}}:events`));
  await say(f.url, s, "While it was full");
  await say(f.url, s, "Still full");
  await until("saving says it is failing", async () => !!(await call<Saves>(f.url, "/api/local/saves")).failing);
  assert.match((await call<Saves>(f.url, "/api/local/saves")).failing!.reason, /disk is full|space/i);
  // Meanwhile it reads as it was said: nothing is lost while it waits.
  assert.deepEqual(await said(f.url, s), ["Before the disk filled", "While it was full", "Still full"]);

  // Room again: the next try, by itself, writes it all.
  delete process.env.FRIDAY_TEST_WRITE_FAIL;
  await until("saving works again by itself", async () => !(await call<Saves>(f.url, "/api/local/saves")).failing, 20_000);
  await say(f.url, s, "After there was room");
  await f.close();
  wholeLines(logOf(home, s));

  f = await start(home);
  try {
    assert.deepEqual(await said(f.url, s), ["Before the disk filled", "While it was full", "Still full", "After there was room"]);
  } finally {
    await f.close();
  }
});
