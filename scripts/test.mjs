// `npm test`: every test file, or the ones named (`npm test -- test/a.test.ts`).
//
// The files are listed here rather than by a glob in package.json, because npm on Windows hands `test/*.test.ts` over as
// it is and nothing runs. Each file gets a time limit (on Node 20 it caps a whole file as well as each test in it), so a
// test that hangs fails after ten minutes instead of holding up the report for hours, which it once did. At most six files
// run at once: every file starts its own server, Redis connections and runner processes, and with one per core (eleven
// here) about ten tests a run failed only from the load, each passing alone. Six took the same seven and a half minutes
// and failed one, whose own timing was then fixed.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const named = process.argv.slice(2);
const files = named.length ? named : readdirSync("test").filter((f) => f.endsWith(".test.ts")).sort().map((f) => `test/${f}`);
const tsx = fileURLToPath(import.meta.resolve("tsx/cli"));
// The open-source edition's tests run on the in-memory Redis it runs on (test/redis-stand-in.mjs), when it has that file.
const standIn = existsSync("test/redis-stand-in.mjs") ? ["--import", "./test/redis-stand-in.mjs"] : [];
const r = spawnSync(process.execPath, [tsx, "--import", "./test/css.mjs", ...standIn, "--test", "--test-timeout=600000", "--test-concurrency=6", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
