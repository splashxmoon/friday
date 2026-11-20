"use strict";
// Coverage reports, read (Arun, wave 2: "Test generation from coverage: Friday reads your coverage report and writes tests for what
// isn't covered, starting with what changed."). The pure part of the IDE's coverage view (cover.js draws it): lcov, istanbul's
// coverage-final.json and cobertura xml, as one shape (per file, a line -> hit count map), plus the git diff's changed lines to
// set against it. No vscode in here, so it is tested on its own (test/vscode-cover.test.ts). .coverage (python's) is binary: skipped.
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

/** Where a project's report may be, in the order it is looked for (the first that parses is the one used). */
const REPORTS = [
  { rel: "coverage/lcov.info", kind: "lcov" },
  { rel: "lcov.info", kind: "lcov" },
  { rel: "coverage/coverage-final.json", kind: "istanbul" },
  { rel: "coverage/cobertura-coverage.xml", kind: "cobertura" },
  { rel: "coverage.xml", kind: "cobertura" },
  { rel: "cobertura.xml", kind: "cobertura" },
];

const isAbs = (p) => /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(p);

/** A file's name as a map key: absolute, slashes forward, and lower case on a Windows drive (its paths are not case-sensitive). */
function fileKey(p) {
  const abs = path.resolve(p).replace(/\\/g, "/");
  return /^[a-zA-Z]:\//.test(abs) ? abs.toLowerCase() : abs;
}

function put(files, abs, line, hits) {
  if (!Number.isFinite(line) || line < 1) return;
  const key = fileKey(abs);
  let f = files.get(key);
  if (!f) files.set(key, (f = { file: path.resolve(abs), lines: new Map() }));
  // Two entries for one line (a class's lines and its methods', two runs merged): covered if any was.
  f.lines.set(line, Math.max(f.lines.get(line) || 0, Number(hits) || 0));
}

function parseLcov(text, root) {
  const files = new Map();
  let cur = "";
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      const p = line.slice(3).trim();
      cur = isAbs(p) ? p : path.resolve(root, p);
    } else if (line.startsWith("DA:") && cur) {
      const [n, h] = line.slice(3).split(",");
      put(files, cur, parseInt(n, 10), parseInt(h, 10));
    } else if (line === "end_of_record") cur = "";
  }
  return files;
}

/** Istanbul's per-file statement map: a line is a statement's first line, covered when it ran (istanbul's own line coverage). */
function parseIstanbul(text, root) {
  const files = new Map();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return files;
  }
  if (!data || typeof data !== "object") return files;
  for (const [name, f] of Object.entries(data)) {
    if (!f || !f.statementMap || !f.s) continue;
    const p = f.path || name;
    const abs = isAbs(p) ? p : path.resolve(root, p);
    for (const [id, loc] of Object.entries(f.statementMap)) put(files, abs, loc && loc.start && loc.start.line, f.s[id]);
  }
  return files;
}

function unescapeXml(s) {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Cobertura xml (python's coverage.py, gocover-cobertura, cobertura-maven): classes with a filename, each with its lines. */
function parseCobertura(text, root) {
  const files = new Map();
  const src = String(text);
  const sources = [...src.matchAll(/<source>([^<]*)<\/source>/g)].map((m) => unescapeXml(m[1].trim())).filter(Boolean);
  for (const m of src.matchAll(/<class\b([^>]*?)(?:\/>|>([\s\S]*?)<\/class>)/g)) {
    const fn = /\bfilename="([^"]*)"/.exec(m[1]);
    if (!fn || !m[2]) continue;
    const rel = unescapeXml(fn[1]);
    let abs = "";
    if (isAbs(rel)) abs = rel;
    else {
      // Relative to one of the report's <source> folders (the one that has it), else to the project.
      const hit = sources.filter(isAbs).map((s) => path.join(s, rel)).find((p) => fs.existsSync(p));
      abs = hit || path.resolve(root, rel);
    }
    for (const l of m[2].matchAll(/<line\b([^>]*?)\/?>/g)) {
      const n = /\bnumber="(\d+)"/.exec(l[1]);
      const h = /\bhits="(\d+)"/.exec(l[1]);
      if (n && h) put(files, abs, parseInt(n[1], 10), parseInt(h[1], 10));
    }
  }
  return files;
}

const PARSERS = { lcov: parseLcov, istanbul: parseIstanbul, cobertura: parseCobertura };

/** The reports a folder has, newest first. */
function findReports(root) {
  const out = [];
  for (const r of REPORTS) {
    const file = path.join(root, ...r.rel.split("/"));
    try {
      const st = fs.statSync(file);
      if (st.isFile() && st.size > 0) out.push({ file, kind: r.kind, rel: r.rel, mtime: st.mtimeMs });
    } catch {
      // Not there.
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** What the newest readable report of a folder says: { files: Map, report, found, hit, pct } or null when there is none. */
function loadCoverage(root) {
  for (const r of findReports(root)) {
    let files;
    try {
      files = PARSERS[r.kind](fs.readFileSync(r.file, "utf8"), root);
    } catch {
      continue;
    }
    if (!files.size) continue;
    return { files, report: r.rel, mtime: r.mtime, root, ...totals(files.values()) };
  }
  return null;
}

function totals(list) {
  let found = 0;
  let hit = 0;
  for (const f of list) {
    for (const h of f.lines.values()) {
      found++;
      if (h > 0) hit++;
    }
  }
  return { found, hit, pct: found ? Math.round((hit / found) * 100) : 100 };
}

/** The lines of one file's entry that never ran, in order. */
function uncoveredLines(f) {
  return f ? [...f.lines].filter(([, h]) => h === 0).map(([n]) => n).sort((a, b) => a - b) : [];
}

/** Line numbers as runs, [[from, to]], a run being lines next to each other. */
function toRanges(lines) {
  const out = [];
  for (const n of lines) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

/** Runs written the way a person says them: "17, 19-22". Past `max` runs it ends with a count of the rest. */
function formatRanges(ranges, max = 40) {
  const shown = ranges.slice(0, max).map(([a, b]) => (a === b ? String(a) : `${a}-${b}`));
  if (ranges.length > max) shown.push(`and ${ranges.length - max} more`);
  return shown.join(", ");
}

/** Of these lines, the ones inside any of the runs. */
function within(lines, ranges) {
  return lines.filter((n) => ranges.some(([a, b]) => n >= a && n <= b));
}

/** The lines a `git diff -U0` adds or changes, per file (the new side's lines; a pure removal has none): Map<relPath, runs>. */
function parseDiffRanges(diff) {
  const out = new Map();
  let file = "";
  for (const line of String(diff).split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      let p = line.slice(4).replace(/\t.*$/, "");
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      file = p === "/dev/null" ? "" : p.replace(/^b\//, "");
    } else if (line.startsWith("@@") && file) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const start = parseInt(m[1], 10);
      const count = m[2] === undefined ? 1 : parseInt(m[2], 10);
      if (count < 1) continue;
      const runs = out.get(file) || [];
      runs.push([start, start + count - 1]);
      out.set(file, runs);
    }
  }
  return out;
}

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, out) => resolve(err ? null : String(out)));
  });
}

/** The branch a folder's work started from: the merge base with origin's default branch, else main or master; HEAD itself if none. */
async function baseOf(root) {
  for (const b of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
    const mb = await git(root, ["merge-base", b, "HEAD"]);
    if (mb && mb.trim()) return mb.trim();
  }
  return "HEAD";
}

/** Beyond this an untracked file is not read to count its lines (data, build output): it counts as changed from its first line to the cap. */
const MAX_READ = 2 * 1024 * 1024;

/**
 * What changed in a folder against its base, committed or not, as Map<key, { file, runs }> (untracked files are whole changes).
 * `known` (a key -> boolean) names the files whose lines matter, usually the report's: other untracked files are listed with
 * runs null instead of being read. Empty when the folder isn't a git repository.
 */
async function changedRanges(root, known) {
  const out = new Map();
  if ((await git(root, ["rev-parse", "--is-inside-work-tree"])) === null) return out;
  const base = await baseOf(root);
  // Fixed output, whatever the person's git config says: diff.mnemonicPrefix (w/ and i/), diff.noprefix, core.quotepath (an
  // escaped non-ASCII name) and diff.renames would each change the path or the shape of what is parsed below.
  // --relative: paths from the folder, whether or not it is the repo's top. A repo with no commit yet has no HEAD to diff.
  const diff = (await git(root, ["-c", "core.quotepath=off", "diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", "--relative", base])) || "";
  for (const [rel, runs] of parseDiffRanges(diff)) out.set(fileKey(path.resolve(root, rel)), { file: path.resolve(root, rel), runs });
  const fresh = (await git(root, ["-c", "core.quotepath=off", "ls-files", "--others", "--exclude-standard", "-z"])) || "";
  for (const rel of fresh.split("\0").filter(Boolean)) {
    const file = path.resolve(root, rel);
    const key = fileKey(file);
    if (known && !known(key)) {
      out.set(key, { file, runs: null });
      continue;
    }
    let n = 0;
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      const text = st.size > MAX_READ ? "" : fs.readFileSync(file, "utf8");
      // A trailing newline ends the last line, it doesn't start another.
      n = st.size > MAX_READ ? 1e9 : text.replace(/\r?\n$/, "").split("\n").length;
      if (!text.trim() && st.size <= MAX_READ) n = 0;
    } catch {
      continue;
    }
    if (n) out.set(key, { file, runs: [[1, n]] });
  }
  return out;
}

/** The uncovered lines inside what changed: [{ file, lines }] over the files the report knows, most lines first. */
function uncoveredInChanges(cov, changed) {
  return classifyChanges(cov, changed).rows;
}

const SOURCE = /\.(?:[cm]?[jt]sx?|vue|svelte|py|go|rb|java|kt|rs|php|cs|swift|scala|c|cc|cpp|h|hpp)$/i;
const TESTISH = /(?:^|[\\/])(?:node_modules|dist|build|coverage|vendor|__tests?__|tests?|spec|e2e)[\\/]|\.(?:test|spec)\.|_test\.|(?:^|[\\/])test_[^\\/]*$|\.d\.ts$/i;
/** A file whose coverage is worth asking about: code, not a test, a type file, a build folder or a config. */
function isSource(file) {
  return SOURCE.test(file) && !TESTISH.test(file);
}

/**
 * What changed, split three ways (cov is the report): rows (in the report and not edited since: the exact lines no test runs),
 * stale (changed after the report was made, so its line numbers can't be trusted) and absent (source files the report has no
 * entry for: new, or no test imports them). `isStale(file)` says whether a file was edited after the report.
 */
function classifyChanges(cov, changed, isStale = () => false) {
  const rows = [];
  const stale = [];
  const absent = [];
  for (const [key, c] of changed) {
    const f = cov.files.get(key);
    if (f) {
      if (isStale(c.file)) {
        stale.push(c.file);
        continue;
      }
      const lines = c.runs ? within(uncoveredLines(f), c.runs) : [];
      if (lines.length) rows.push({ file: c.file, lines });
    } else if (isSource(c.file)) absent.push(c.file);
  }
  rows.sort((a, b) => b.lines.length - a.lines.length || a.file.localeCompare(b.file));
  stale.sort();
  absent.sort();
  return { rows, stale, absent };
}

module.exports = { REPORTS, fileKey, parseLcov, parseIstanbul, parseCobertura, findReports, loadCoverage, totals, uncoveredLines, toRanges, formatRanges, within, parseDiffRanges, changedRanges, uncoveredInChanges, classifyChanges, isSource, baseOf };
