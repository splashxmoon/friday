// Friday's own log and Copy diagnostics (src/diagnostics.ts; spec 13, "What can break" 9): a log that keeps to its size, written
// behind the app and never in its way; a process whose stray errors are logged and carried on from; and a report that holds no
// secret and says the home folder as ~.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

process.env.FRIDAY_NO_TELEMETRY = "1";
process.env.FRIDAY_RELAY = "off";
process.env.FRIDAY_NO_TOOL_UPDATES = "1";

const { RotatingLog, redact, redactSecrets, tailLog, logPath, editionLine } = await import("../src/diagnostics.js");

const sandbox = await mkdtemp(path.join(tmpdir(), "friday-diag-"));
test.after(() => rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

/**
 * Secrets in every shape the report must never carry, each in a line of ordinary text. All made up; each provider-shaped one is
 * written in two pieces so no whole token sits in the file for a secret scanner to flag (GitHub flagged the Google one on the
 * public repo, 2026-11-25); the test still sees the joined value.
 */
const fake = (head: string, rest: string) => head + rest;
const SECRETS: [string, string][] = [
  ["an OpenAI key", fake("sk-proj-", "AbCdEf0123456789ghijKLMNopqr")],
  ["an Anthropic key", fake("sk-ant-", "api03-AbCdEf0123456789-ghijKLMNopqrstuvWXyz")],
  ["a GitHub token", fake("ghp_", "AbCdEf0123456789ghijKLMNopqrstuv1234")],
  ["a GitHub OAuth token", fake("gho_", "AbCdEf0123456789ghijKLMNopqrstuv1234")],
  ["a fine-grained GitHub token", fake("github_pat_", "11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz")],
  ["a Slack bot token", fake("xoxb-", "1234567890-0987654321-AbCdEfGhIjKl")],
  ["a Slack user token", fake("xoxp-", "1234567890-abcdefghij")],
  ["a Slack app token", fake("xapp-", "1-A0123456789-1234567890123-abcdef")],
  ["an npm token", fake("npm_", "AbCdEf0123456789ghijKLMNopqrstuv12")],
  ["an AWS key id", fake("AKIA", "IOSFODNN7EXAMPLE")],
  ["a Google key", fake("AIza", "SyA-1234567890abcdefghijklmnopqrstu")],
  ["a signed web token", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
  ["a long hex secret", "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"],
  ["padded base64", "QWxhZGRpbjpvcGVuIHNlc2FtZQ0K0123456789abcdefABCDEF=="],
  ["random base64url", "Zx9_Lk2mQp8RtV3wYb7NcJ5hGd1FsAe4"],
];
/** What the report says with them: a bearer header, a query, JSON, an environment line, keeping the name and losing the value. */
const SHAPED: [string, string, RegExp][] = [
  ["a bearer header", "Authorization: Bearer abcDEF123456.ghi-789", /Authorization: (\[redacted\] ?)+/],
  ["a socket's invite", "ws://127.0.0.1:4321/ws?sid=abc&invite=s3cr3t-invite-value&actor=xyz", /invite=\[redacted\]&actor=\[redacted\]/],
  ["a token in a query", "GET /api/thing?token=hunter2hunter2", /\?token=\[redacted\]/],
  ["JSON", '{"api_key":"plainsecretvalue","name":"ok"}', /"api_key":"\[redacted\]","name":"ok"/],
  ["an environment line", "OPENROUTER_API_KEY=abc123def456ghi", /API_KEY=\[redacted\]/],
  ["a password", "password: correct-horse-battery", /password: \[redacted\]/],
  ["Basic auth", "Authorization: Basic dXNlcjpwYXNzd29yZA==", /\[redacted\]/],
];
/** Ordinary lines that must come out as they went in. */
const ORDINARY = [
  "[runner] claude exited with code 1 after 12.5s",
  "The window's page ran out of memory (oom, exit code 133)",
  "Error: ENOENT: no such file or directory, open 'src/app.ts'",
  "at Object.<anonymous> (src/local/start.ts:141:12)",
  "[stall] the server was held up for 3.2s",
  "tokens: 1520 in, 380 out",
  "Basic authentication isn't set up",
  "friday-worktrees/claude-fix-the-login-page-and-tests",
  "ERR_MODULE_NOT_FOUND_IN_THE_RUNNER_STARTUP_CHECK",
  "session a1b2c3 lane main, branch friday/2026-10-20-1715",
];

test("every shape of secret is taken out, wherever it sits in a line", () => {
  for (const [what, secret] of SECRETS) {
    const out = redactSecrets(`before ${secret} after`);
    assert.ok(!out.includes(secret), `${what} survived: ${out}`);
    assert.match(out, /^before .*\[redacted\].* after$/, `${what}: the rest of the line stays`);
  }
  for (const [what, line, want] of SHAPED) {
    const out = redactSecrets(line);
    assert.match(out, want, `${what}: ${out}`);
  }
});

test("ordinary text is left alone", () => {
  for (const line of ORDINARY) assert.equal(redactSecrets(line), line);
  assert.equal(redactSecrets(redactSecrets("Bearer abcdefghijklmnop")), "Bearer [redacted]", "redacting twice is redacting once");
});

test("the home folder is said as ~, however the path spells it, and only a whole folder name", () => {
  assert.equal(redact("/Users/maya/.friday/diagnostics/friday.log", "/Users/maya"), "~/.friday/diagnostics/friday.log");
  assert.equal(redact("at /home/sam/code/app.ts:3", "/home/sam"), "at ~/code/app.ts:3");
  assert.equal(redact("C:\\Users\\Maya\\.friday\\data.json", "C:\\Users\\Maya"), "~\\.friday\\data.json");
  assert.equal(redact("C:/Users/Maya/.friday", "C:\\Users\\Maya"), "~/.friday", "a Windows home written with forward slashes");
  assert.equal(redact("/tmp/x/sandbox-1/.friday and /tmp/x/sandbox-12", "/tmp/x/sandbox-1"), "~/.friday and /tmp/x/sandbox-12", "not a folder that only starts the same");
  assert.equal(redact("copied from /Users/someone-else/notes", "/Users/maya"), "copied from ~/notes", "anybody's home too");
});

test("the log rotates at its size, keeping three files, oldest dropped", async () => {
  const dir = path.join(sandbox, "rotate");
  const log = new RotatingLog(path.join(dir, "friday.log"), { maxBytes: 1000, keep: 3 });
  for (let i = 0; i < 60; i++) log.line("info", `line ${String(i).padStart(3, "0")} ${"x".repeat(80)}`);
  await log.flush();
  const files = (await readdir(dir)).sort();
  assert.deepEqual(files, ["friday.log", "friday.log.1", "friday.log.2"]);
  for (const f of files) assert.ok((await stat(path.join(dir, f))).size <= 1000, `${f} over its size`);
  const newest = await readFile(path.join(dir, "friday.log"), "utf8");
  assert.match(newest, /line 059/, "the newest line is in friday.log");
  const all = (await Promise.all(files.map((f) => readFile(path.join(dir, f), "utf8")))).join("");
  assert.ok(!all.includes("line 000 "), "the oldest went with the file that rotated out");
  assert.match(newest.split("\n")[0]!, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z info  line \d{3} x+$/, "each line has its time and level");
});

test("lines are written in order, secrets out, and a folder that can't be written loses lines without throwing", async () => {
  const dir = path.join(sandbox, "order");
  const log = new RotatingLog(path.join(dir, "friday.log"));
  log.line("error", `first ${fake("ghp_", "AbCdEf0123456789ghijKLMNopqrstuv1234")}`);
  log.line("warn", "second\r\nwith a second line");
  log.line("info", "third");
  await log.flush();
  const text = await readFile(path.join(dir, "friday.log"), "utf8");
  assert.match(text, /error first \[redacted\]\n.*warn  second\nwith a second line\n.*info  third\n$/);
  // A file where its folder should be: every write fails, and nothing reaches the caller.
  await writeFile(path.join(sandbox, "blocked"), "a file, not a folder");
  const stuck = new RotatingLog(path.join(sandbox, "blocked", "friday.log"));
  assert.doesNotThrow(() => stuck.line("error", "lost"));
  await stuck.flush();
});

test("the tail reaches into the file before when the current one is short", async () => {
  const home = path.join(sandbox, "tail-home");
  await mkdir(path.dirname(logPath(home)), { recursive: true });
  await writeFile(`${logPath(home)}.1`, Array.from({ length: 150 }, (_, i) => `old ${i}`).join("\n") + "\n");
  await writeFile(logPath(home), Array.from({ length: 100 }, (_, i) => `new ${i}`).join("\r\n") + "\r\n");
  const lines = await tailLog(home, 200);
  assert.equal(lines.length, 200);
  assert.equal(lines[0], "old 50");
  assert.equal(lines.at(-1), "new 99");
  assert.deepEqual(await tailLog(path.join(sandbox, "no-log-here")), []);
});

test("the edition is said in words", () => {
  assert.equal(editionLine({ FRIDAY_EDITION: "local" }, { electron: "38.0.0" } as unknown as NodeJS.ProcessVersions), "open source, desktop app");
  assert.equal(editionLine({ FRIDAY_EDITION: "local", FRIDAY_MINE: "1" }, {} as NodeJS.ProcessVersions), "open source, personal build, from the command line");
});

test("a process with the log installed writes its errors there and carries on after an uncaught error and a stray rejection", async () => {
  const home = path.join(sandbox, "process-home");
  const script = path.join(sandbox, "crashy.ts");
  const src = pathToUrl(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "diagnostics.ts"));
  await writeFile(
    script,
    [
      `import { installProcessLog, processLog } from ${JSON.stringify(src)};`,
      `installProcessLog(${JSON.stringify(home)}, { what: "Test" });`,
      `console.error("an error with ${fake("sk-ant-", "api03-AbCdEf0123456789-ghijKLMNopqrstuvWXyz")} in it");`,
      `console.warn("a warning");`,
      `setTimeout(() => { throw new Error("thrown from a timer"); }, 10);`,
      `setTimeout(() => void Promise.reject(new Error("nobody waited on this")), 20);`,
      `setTimeout(async () => { console.log("still running"); await processLog()?.flush(); process.exit(0); }, 150);`,
    ].join("\n"),
  );
  const tsx = fileURLToPath(import.meta.resolve("tsx/cli"));
  const out = execFileSync(process.execPath, [tsx, script], { encoding: "utf8", env: { ...process.env, FRIDAY_NO_TELEMETRY: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  assert.match(out, /still running/, "the process went on after both");
  const log = await readFile(logPath(home), "utf8");
  assert.match(log, /info  Test started: .* pid \d+/);
  assert.match(log, /error an error with \[redacted\] in it/);
  assert.ok(!log.includes("sk-ant-api03"), "the key never reached the file");
  assert.match(log, /warn  a warning/);
  assert.match(log, /error \[friday\] uncaught exception: Error: thrown from a timer/);
  assert.match(log, /error \[friday\] unhandled rejection: Error: nobody waited on this/);
});

test("Copy diagnostics: this computer's own page only, redacted, with the version, sessions and the last of the log", async (t) => {
  // Friday's data in a home of its own, as the e2e harness does: the report says it as ~.
  const fakeHome = path.join(sandbox, "person");
  // HOME, and USERPROFILE for Windows, where the home folder is read from it.
  const real = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  t.after(() => {
    for (const [k, v] of Object.entries(real)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  const home = path.join(fakeHome, ".friday");
  await mkdir(path.dirname(logPath(home)), { recursive: true });
  const planted = fake("ghp_", "PlantedToken0123456789abcdefghijKLMN");
  await writeFile(logPath(home), `2026-11-24T10:00:00.000Z error [runner] push failed with ${planted} for ${home}/worktrees/x\n`);
  const { startLocal } = await import("../src/local/start.js");
  const friday = await startLocal({ home, port: 0 });
  t.after(() => friday.close());

  const r = await fetch(`${friday.url}/api/local/diagnostics`);
  assert.equal(r.status, 200);
  const b = (await r.json()) as { text: string; logFile: string };
  assert.equal(b.logFile, logPath(home), "the page gets the real place, to show it");
  assert.match(b.text, /^Friday diagnostics\n/);
  assert.match(b.text, /Friday \d+\.\d+\.\d+ \(open source, from the command line\)/);
  assert.match(b.text, /System: (macOS|Windows|Linux) /);
  assert.match(b.text, /Data folder: ~[\\/]\.friday/);
  assert.match(b.text, /Sessions: 0/);
  assert.match(b.text, /Log file: ~[\\/]\.friday[\\/]diagnostics[\\/]friday\.log/);
  assert.match(b.text, /push failed with \[redacted\] for ~[\\/]\.friday\/worktrees\/x/);
  assert.ok(!b.text.includes(planted), "the planted token is gone");
  assert.ok(!b.text.includes(fakeHome), "the home folder never appears as it is");

  const where = (await (await fetch(`${friday.url}/api/local/diagnostics?path=1`)).json()) as { logFile: string; exists: boolean };
  assert.deepEqual(where, { logFile: logPath(home), shown: ["~", ".friday", "diagnostics", "friday.log"].join(path.sep), exists: true });

  // Another site's page, or a name that only resolves here (DNS rebinding): refused before anything is read.
  const port = new URL(friday.url).port;
  const other = await fetch(`${friday.url}/api/local/diagnostics`, { headers: { Origin: "https://example.com" } });
  assert.equal(other.status, 403);
  const rebound = await new Promise<number>((resolve, reject) => {
    import("node:http").then(({ request }) => {
      const q = request({ host: "127.0.0.1", port, path: "/api/local/diagnostics", headers: { Host: `evil.example:${port}` } }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
      q.on("error", reject);
      q.end();
    });
  });
  assert.equal(rebound, 403);
  assert.equal((await fetch(`${friday.url}/api/local/diagnostics`, { method: "POST" })).status, 405);
  assert.ok(existsSync(logPath(home)));
});

function pathToUrl(p: string): string {
  return new URL(`file://${p.split(path.sep).join("/").replace(/^([A-Za-z]):/, "/$1:")}`).href;
}
