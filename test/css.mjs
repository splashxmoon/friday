// The client imports CSS modules, which only the bundler understands. Tests
// that import client code get each class name back as itself instead.
import { register } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A test's copies of folders in a folder of its own, never the real ~/.friday/worktrees: tests that made copies without saying
// where left 213 folders there on one computer (Arun, 2026-11-19, storage). Every test process loads this file; a test that
// sets FRIDAY_WORKTREES itself still decides.
if (!process.env.FRIDAY_WORKTREES) process.env.FRIDAY_WORKTREES = mkdtempSync(path.join(tmpdir(), "friday-test-copies-"));

register(
  "data:text/javascript," +
    encodeURIComponent(
      `export async function load(url, context, next) {
        if (url.endsWith(".css")) return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_, k) => String(k) });" };
        return next(url, context);
      }`,
    ),
);
