/**
 * More signal per step: which tests failed, what an edit changed, and a finished run in one line.
 *
 * All read from what the log already holds: a test command's output names the tests that failed, an edit's arguments
 * carry the lines it took out and put in, and a run's facts fold into a line a long session can be skimmed by.
 */

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Lines that name a failing test, in the runners people use. The name is what comes after the marker. */
const FAIL_LINES: RegExp[] = [
  /^not ok \d+ - (.+)$/, // node:test, tap
  /^\s*[✕×✗]\s+(.+?)(?:\s+\(\d+\s*m?s\))?$/, // jest, vitest
  /^\s*FAIL\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)$/, // jest file banner
  /^FAILED\s+(\S+)/, // pytest
  /^--- FAIL: (\S+)/, // go test
  /^test (\S+) \.\.\. FAILED$/, // cargo test
  /^\s*\d+\)\s+(.+)$/, // mocha
];

/** The failing tests a test command's output names, in order, without repeats, at most eight. */
export function failingTests(output: string): string[] {
  const out: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
    for (const re of FAIL_LINES) {
      const m = re.exec(line);
      if (!m) continue;
      const name = clip(m[1]!.trim(), 120);
      if (name && !out.includes(name)) out.push(name);
      break;
    }
    if (out.length >= 8) break;
  }
  return out;
}

export interface EditPreview {
  old: string[];
  new: string[];
}

const lines = (s: unknown, n: number): string[] => (typeof s === "string" ? s.split(/\r?\n/).filter((l) => l.trim()).slice(0, n) : []);

/** The first lines an edit took out and put in, from the tool call's own arguments; null when there is nothing to show. */
export function editPreview(args: Record<string, unknown>): EditPreview | null {
  const pairs: [string, string][] = [
    ["find", "content"],
    ["old_string", "new_string"],
    ["old", "new"],
    ["search", "replace"],
    ["oldText", "newText"],
  ];
  for (const [a, b] of pairs) {
    if (typeof args[a] === "string" || typeof args[b] === "string") {
      const p = { old: lines(args[a], 3), new: lines(args[b], 3) };
      return p.old.length || p.new.length ? p : null;
    }
  }
  // A file written whole: the first lines of what it now says.
  for (const k of ["content", "text", "body"]) {
    if (typeof args[k] === "string") {
      const fresh = lines(args[k], 4);
      return fresh.length ? { old: [], new: fresh } : null;
    }
  }
  return null;
}

const dur = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`;
};

/** "Edited 3 files · tests passed · 2m": a finished run, folded. */
export function foldLine(i: { changed: number; tests: "pass" | "fail" | null; failed: number; ms: number; answer?: string }): string {
  const parts: string[] = [];
  if (i.changed) parts.push(`Edited ${i.changed} file${i.changed === 1 ? "" : "s"}`);
  else {
    const first = (i.answer ?? "").split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").replace(/[*_`]+/g, "").trim();
    parts.push(first ? clip(first, 64) : "Worked");
  }
  if (i.tests === "pass") parts.push("tests passed");
  else if (i.tests === "fail") parts.push("tests failed");
  if (i.failed) parts.push(`${i.failed} command${i.failed === 1 ? "" : "s"} failing`);
  if (i.ms >= 1000) parts.push(dur(i.ms));
  return parts.join(" · ");
}
