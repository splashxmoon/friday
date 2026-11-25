// Settings › Updates › Health (spec 13 Wave 4; Arun, 2026-11-24: "Go all out and fix these problems"): what the server reads
// (diagnostics.ts health: the last save, the disk, the data folder, the log and this week's errors), and what the page says of it,
// each with its plain fix when it's off (client/health-line.ts).
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { errorTimes, health, logPath, type Health } from "../src/diagnostics.js";
import { DATA_BIG, DISK_LOW, healthRows } from "../src/client/health-line.js";

const sandbox = await mkdtemp(path.join(tmpdir(), "friday-health-"));
test.after(() => rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;

test("errors are counted from the log's own lines, a stack once, CRLF too; only what was added is read, and a rotated file afresh", async () => {
  const file = path.join(sandbox, "count", "friday.log");
  await mkdir(path.dirname(file), { recursive: true });
  const now = Date.now();
  await writeFile(
    file,
    [
      `${iso(now - 3000)} info  Friday started`,
      `${iso(now - 2000)} error [runner] push failed`,
      "    at Object.<anonymous> (runner.ts:1:1)",
      "    at error (not a line of its own)",
      `${iso(now - 1000)} warn  slow`,
      `${iso(now - 500)} error [ws] dropped\r`,
      "",
    ].join("\n"),
  );
  assert.equal((await errorTimes(file)).length, 2);
  // Added to, the last line still being written: counted once it is whole.
  await appendFile(file, `${iso(now)} error [store] one more\n${iso(now)} err`);
  assert.equal((await errorTimes(file)).length, 3);
  await appendFile(file, "or [store] finished later\n");
  assert.equal((await errorTimes(file)).length, 4);
  // Rotated: a new, shorter file under the same name.
  await rm(file);
  await writeFile(file, `${iso(now)} error [app] after rotating\n`);
  assert.equal((await errorTimes(file)).length, 1);
  assert.deepEqual(await errorTimes(path.join(sandbox, "count", "none.log")), [], "a file that isn't there has none");
});

test("health: the last save and whether it fails, the disk, the folder as measured, the log's files together, this week's errors", async () => {
  const home = path.join(sandbox, "home");
  const file = logPath(home);
  await mkdir(path.dirname(file), { recursive: true });
  const now = Date.now();
  await writeFile(`${file}.2`, `${iso(now - 9 * DAY)} error too old to count\n`);
  await writeFile(`${file}.1`, `${iso(now - 2 * DAY)} error two days ago\n${iso(now - 6 * DAY)} error six days ago\n`);
  await writeFile(file, `${iso(now - 60_000)} error a minute ago\n${iso(now - 30_000)} info  fine\n`);
  const saves = { state: () => ({ failing: { reason: "the disk is full", since: now - 5000 } }), last: () => ({ savedAt: now - 90_000, pending: true }) };
  const h = await health({ home, saves, data: async () => ({ bytes: 123_456, at: now - 1000, measuring: false }), now });
  assert.deepEqual(h.save, { savedAt: now - 90_000, pending: true, failing: { reason: "the disk is full", since: now - 5000 } });
  assert.ok(h.disk && h.disk.free > 0 && h.disk.total >= h.disk.free, `the disk read: ${JSON.stringify(h.disk)}`);
  assert.deepEqual(h.data, { bytes: 123_456, at: now - 1000, measuring: false });
  assert.equal(h.log.most, 15 * 1024 * 1024);
  assert.ok(h.log.bytes > 100, "the three files together");
  assert.deepEqual(h.errors, { week: 3, last: Date.parse(iso(now - 60_000)) });

  // No saves to ask (the hosted edition), and a measurement that fails: said as not known, never thrown.
  const bare = await health({ home: path.join(sandbox, "empty"), data: async () => Promise.reject(new Error("no runner")) });
  assert.deepEqual(bare.save, { savedAt: null, pending: false });
  assert.deepEqual(bare.data, { bytes: null, at: null, measuring: false });
  assert.deepEqual(bare.log, { bytes: 0, most: 15 * 1024 * 1024 });
  assert.deepEqual(bare.errors, { week: 0, last: null });
});

const base = (o: Partial<Health> = {}): Health => ({
  at: Date.now(),
  save: { savedAt: Date.now() - 4 * 60_000, pending: false },
  disk: { free: 200 * 1024 ** 3, total: 500 * 1024 ** 3 },
  data: { bytes: 2.4 * 1024 ** 3, at: Date.now() - 3 * 60_000, measuring: false },
  log: { bytes: 1.2 * 1024 ** 2, most: 15 * 1024 ** 2 },
  errors: { week: 0, last: null },
  ...o,
});
const row = (h: Health, id: string) => healthRows(h).find((r) => r.id === id)!;

test("all well: five rows in plain words, nothing off and nothing to do", () => {
  const rows = healthRows(base());
  assert.deepEqual(
    rows.map((r) => [r.label, r.text]),
    [
      ["Saving", "Everything is saved. Last saved 4m ago."],
      ["Disk space", "200 GB free of 500 GB."],
      ["Data folder", "2.4 GB, measured 3m ago."],
      ["Log size", "1.2 MB, kept under 15 MB."],
      ["Errors", "None this week."],
    ],
  );
  assert.ok(rows.every((r) => !r.off && !r.fix));
});

test("each one off says so, how bad, and its plain fix", () => {
  const full = row(base({ save: { savedAt: Date.now() - 60_000, pending: true, failing: { reason: "the disk is full", since: Date.now() } } }), "save");
  assert.equal(full.text, "Can't save: the disk is full. Friday keeps trying, and holds your changes until it can.");
  assert.deepEqual(full.off, { tone: "danger", word: "Not saving" });
  assert.deepEqual(full.fix, { label: "Free up space", to: "storage" });
  // A reason space won't fix: a report, with diagnostics.
  assert.deepEqual(row(base({ save: { savedAt: null, pending: true, failing: { reason: "Friday isn't allowed to write to its folder", since: Date.now() } } }), "save").fix, { label: "Send feedback", to: "feedback" });

  const low = row(base({ disk: { free: 3.1 * 1024 ** 3, total: 256 * 1024 ** 3 } }), "disk");
  assert.equal(low.text, "Disk nearly full: 3.1 GB free of 256 GB. Storage frees space.");
  assert.deepEqual(low.off, { tone: "needs", word: "Nearly full" });
  assert.deepEqual(low.fix, { label: "Open Storage", to: "storage" });
  assert.ok(!row(base({ disk: { free: DISK_LOW, total: 256 * 1024 ** 3 } }), "disk").off, "at the line, not yet");

  const big = row(base({ data: { bytes: DATA_BIG + 1024 ** 3, at: Date.now(), measuring: false } }), "data");
  assert.equal(big.text, "21 GB in Friday's folder. Storage frees space.");
  assert.deepEqual([big.off?.word, big.fix?.to], ["Large", "storage"]);

  const one = row(base({ errors: { week: 1, last: Date.now() - 2 * 3_600_000 } }), "errors");
  assert.equal(one.text, "1 this week, the last 2h ago. Copy diagnostics below and send it with a report.");
  assert.deepEqual([one.off?.word, one.fix?.label, one.fix?.to], ["1 error", "Send feedback", "feedback"]);
  assert.equal(row(base({ errors: { week: 4, last: Date.now() } }), "errors").off?.word, "4 errors");
});

test("what isn't known yet: a folder being measured is a placeholder, one never measured points to Storage; nothing saved or logged yet", () => {
  assert.equal(row(base({ data: { bytes: null, at: null, measuring: true } }), "data").text, "", "drawn as a placeholder");
  const never = row(base({ data: { bytes: null, at: null, measuring: false } }), "data");
  assert.equal(never.text, "Not measured yet. Storage measures it.");
  assert.deepEqual([never.off, never.fix?.to], [undefined, "storage"]);
  assert.equal(row(base({ disk: null }), "disk").text, "Couldn't be read on this computer.");
  assert.equal(row(base({ save: { savedAt: null, pending: false } }), "save").text, "Nothing to save yet.");
  assert.equal(row(base({ save: { savedAt: null, pending: true } }), "save").text, "Saving your first changes.");
  assert.equal(row(base({ save: { savedAt: Date.now(), pending: true } }), "save").text, "Last saved just now. The newest change is saved in a moment.");
  assert.equal(row(base({ log: { bytes: 0, most: 15 * 1024 ** 2 } }), "log").text, "Nothing logged yet.");
});

test("the local store says when it last saved, and whether a change waits", async () => {
  const { localKV } = await import("../src/local/kv.js");
  const home = path.join(sandbox, "kv");
  let kv = await localKV(home, 60_000);
  assert.deepEqual(kv.saves.last!(), { savedAt: null, pending: false }, "a new folder: nothing saved, nothing waiting");
  await kv.redis.set("friday:k", "v");
  assert.equal(kv.saves.last!().pending, true);
  const before = Date.now();
  await kv.flush();
  const after = kv.saves.last!();
  assert.equal(after.pending, false);
  assert.ok(after.savedAt! >= before, "saved just now");
  await kv.close();
  // Started again: the file's own time, until this Friday saves.
  kv = await localKV(home, 60_000);
  const reopened = kv.saves.last!();
  assert.ok(reopened.savedAt && Math.abs(reopened.savedAt - after.savedAt!) < 5000, `data.json's time: ${JSON.stringify(reopened)}`);
  await kv.close();
});

test("GET /api/local/health: this computer's own page only, the numbers whole", async (t) => {
  process.env.FRIDAY_NO_TELEMETRY = "1";
  process.env.FRIDAY_RELAY = "off";
  const realHome = process.env.HOME;
  process.env.HOME = process.env.USERPROFILE = path.join(sandbox, "person");
  t.after(() => {
    process.env.HOME = realHome;
  });
  const home = path.join(sandbox, "person", ".friday");
  await mkdir(path.dirname(logPath(home)), { recursive: true });
  await writeFile(logPath(home), `${iso(Date.now() - 1000)} error [runner] something went wrong\n`);
  const { startLocal } = await import("../src/local/start.js");
  const friday = await startLocal({ home, port: 0 });
  t.after(() => friday.close());
  const r = await fetch(`${friday.url}/api/local/health`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const h = (await r.json()) as Health;
  assert.equal(typeof h.at, "number");
  assert.equal(h.save.failing, undefined);
  assert.ok(h.disk && h.disk.free > 0);
  assert.equal(typeof h.data.measuring, "boolean");
  assert.ok(h.log.bytes > 0);
  assert.equal(h.errors.week, 1);
  assert.equal((await fetch(`${friday.url}/api/local/health`, { headers: { Origin: "https://example.com" } })).status, 403, "another site's page is refused");
  assert.equal((await fetch(`${friday.url}/api/local/health`, { method: "POST" })).status, 405);
});
