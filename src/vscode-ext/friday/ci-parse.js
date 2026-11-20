"use strict";
// A CI log, read for the places it names (Arun, 2026-11-19, wave 3: "when the log names files and lines (TypeScript/ESLint/Jest/
// Vitest/pytest/go test patterns) ... add them as Problems"). The pure part of the IDE's CI view (ci.js draws it): the log's text in,
// where each failure points out, plus how the status bar words the counts. No vscode in here, so it is tested on its own
// (test/vscode-ci.test.ts).
const fs = require("node:fs");
const path = require("node:path");

/** A file name in a log: an optional drive, then anything with no space, quote, colon or bracket, ending in an extension. */
const FILE = String.raw`((?:[A-Za-z]:[\\/])?[^\s:()"'<>|*?\`]+?\.[A-Za-z][A-Za-z0-9]{0,5})`;
const TS_PAREN = new RegExp(String.raw`^${FILE}\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.*)$`);
// tsc --pretty, gcc, clang, eslint's unix format, mypy and the like: file:line:col - error CODE: message
// eslint's unix format: file:line:col: message [Error/rule]
const UNIX_ESLINT = new RegExp(String.raw`^${FILE}:(\d+):(\d+):\s+(.*?)\s+\[(Error|Warning)(?:/([^\]]+))?\]$`);
const GENERIC = new RegExp(String.raw`^${FILE}:(\d+)(?::(\d+))?\s*[-:]\s*(error|warning)\b[:\s]*(?:(TS\d+)[:\s]+)?(.*)$`, "i");
const ESLINT_HEAD = new RegExp(String.raw`^${FILE}$`);
const ESLINT_ROW = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.*?)(?:\s{2,}([@\w/.-]+))?\s*$/;
const FRAME = new RegExp(String.raw`^\s*(?:at\s+(?:.*?\s\()?|[❯>]\s*(?:[^\s(]+\s+)?\(?)${FILE}:(\d+)(?::(\d+))?\)?\s*$`);
const NODE_LOCATION = new RegExp(String.raw`location:\s*'${FILE}:(\d+):(\d+)'`);
const PYTEST = new RegExp(String.raw`^${FILE}:(\d+):\s+(\S.*)$`);
const PY_FRAME = /^\s*File "(.+?)", line (\d+)(?:, in (.*))?\s*$/;
const PY_ERROR = /^((?:[A-Za-z_][\w.]*\.)?[A-Za-z_]\w*(?:Error|Exception|Exit|Interrupt|Failed)\b.*)$/;
const GO_TEST = new RegExp(String.raw`^\s+${FILE}:(\d+):\s+(.*)$`);
const GO_COMPILE = new RegExp(String.raw`^(\.{0,2}/?[^\s:]*?\.go):(\d+):(\d+):\s+(.*)$`);
const RUST_ARROW = new RegExp(String.raw`^\s*-->\s+${FILE}:(\d+):(\d+)`);
const ERROR_LINE = /^\s*((?:[A-Z]\w*)?Error|AssertionError|Error): (.+)$/;
const NOISE_PATH = /(?:^|[\\/])node_modules[\\/]|^node:|[\\/]site-packages[\\/]|[\\/]lib[\\/]python|^<|[\\/]go[\\/]pkg[\\/]mod[\\/]|[\\/]\.cargo[\\/]|[\\/]rustc[\\/]/;

/**
 * GitHub's own line markers (##[error], ##[group] ...): a problem matcher puts ##[error] before each line it matched, so a tsc or ESLint
 * line arrives as `##[error]src/a.ts(3,5): error TS2322: ...`. Gone, with the indentation after it kept, and a leading `Error: ` some
 * runners print before a path (Arun, 2026-11-19, review of CI in the IDE).
 */
const MARKER = /^##\[(?:error|warning|notice|debug|group|command|section)\]/;
const LEADING_LABEL = /^(?:Error|Warning):\s+(?=[^\s]+?\.[A-Za-z][A-Za-z0-9]{0,5}(?:\(\d+,\d+\)|:\d+))/i;

/** Terminal colours and the prefix GitHub puts before each line, gone. A line that was only a group's end is dropped (null). */
function cleanLine(l) {
  // `gh run view --log` puts the job and the step, tab-separated, before the timestamp.
  const parts = l.split("\t");
  let body = parts.length >= 3 && /^\d{4}-\d\d-\d\dT/.test(parts[2]) ? parts.slice(2).join("\t") : l;
  body = body.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "");
  if (/^##\[endgroup\]\s*$/.test(body)) return null;
  body = body.replace(MARKER, "").replace(LEADING_LABEL, "");
  return body;
}

function clean(text) {
  return String(text)
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, "")
    .replace(/\r(?!\n)/g, "")
    .split(/\r?\n/)
    .map(cleanLine)
    .filter((l) => l !== null);
}

/** A log as the Output channel shows it: the same cleaning, as one text. */
function cleanText(text) {
  return clean(text).join("\n");
}

/**
 * The failures a log points at: [{ file, line, col, message, severity, tool }], in the order the log gives them, the file as the log
 * spelt it (resolveFile finds it in the folder). A failure with no readable place is not here: it stays in the log.
 */
function parseLog(text) {
  const out = [];
  const seen = new Set();
  const add = (d) => {
    const line = Number(d.line);
    if (!d.file || !Number.isFinite(line) || line < 1 || NOISE_PATH.test(d.file)) return;
    const message = String(d.message || "").replace(/\s+/g, " ").trim().slice(0, 400) || "This failed in CI";
    const key = `${d.file}\0${line}\0${message}`;
    if (seen.has(key) || out.length >= 200) return;
    seen.add(key);
    out.push({ file: d.file, line, col: Math.max(1, Number(d.col) || 1), message, severity: d.severity === "warning" ? "warning" : "error", tool: d.tool });
  };
  const lines = clean(text);
  let eslintFile = "";
  // A test runner's failure: what it said, then the stack, of which the first frame in the project's own code is where it points.
  let said = "";
  let used = false;
  let lastE = "";
  let prevE = false;
  let pyFrame = null;
  let rustMsg = "";
  for (const raw of lines) {
    const l = raw.replace(/\s+$/, "");
    const wasE = prevE;
    prevE = false;
    if (!l.trim()) {
      eslintFile = "";
      continue;
    }
    let m = TS_PAREN.exec(l);
    if (m) {
      add({ file: m[1], line: m[2], col: m[3], severity: m[4], message: `${m[5]}: ${m[6]}`, tool: "tsc" });
      continue;
    }
    m = ESLINT_ROW.exec(l);
    if (m && eslintFile) {
      add({ file: eslintFile, line: m[1], col: m[2], severity: m[3], message: m[5] ? `${m[4]} (${m[5]})` : m[4], tool: "eslint" });
      continue;
    }
    m = UNIX_ESLINT.exec(l);
    if (m) {
      add({ file: m[1], line: m[2], col: m[3], severity: m[5].toLowerCase(), message: m[6] ? `${m[4]} (${m[6]})` : m[4], tool: "eslint" });
      continue;
    }
    m = GENERIC.exec(l);
    if (m) {
      add({ file: m[1], line: m[2], col: m[3], severity: m[4].toLowerCase(), message: m[5] ? `${m[5]}: ${m[6]}` : m[6], tool: m[5] ? "tsc" : undefined });
      continue;
    }
    m = ESLINT_HEAD.exec(l.trim());
    // eslint's file header stands alone on its line, with a slash or a dot-slash in it (a bare word with an extension is just a word).
    if (m && /[\\/]/.test(m[1]) && !/^\s/.test(l)) {
      eslintFile = m[1];
      continue;
    }
    m = RUST_ARROW.exec(l);
    if (m) {
      add({ file: m[1], line: m[2], col: m[3], message: rustMsg, tool: "rustc" });
      continue;
    }
    m = /^(error|warning)(?:\[\w+\])?:\s+(.*)$/.exec(l);
    if (m) rustMsg = m[2];
    // go: a compile error, or a test's own log line (indented)
    m = GO_COMPILE.exec(l);
    if (m) {
      add({ file: m[1], line: m[2], col: m[3], message: m[4], tool: "go" });
      continue;
    }
    m = GO_TEST.exec(l);
    if (m && /\.go$/.test(m[1])) {
      add({ file: m[1], line: m[2], message: m[3], tool: "go test" });
      continue;
    }
    // python: the traceback's frames, and the error that closes it
    m = PY_FRAME.exec(l);
    if (m) {
      if (!NOISE_PATH.test(m[1])) pyFrame = { file: m[1], line: m[2] };
      continue;
    }
    if (pyFrame && !/^\s/.test(l)) {
      const e = PY_ERROR.exec(l);
      if (e) {
        add({ ...pyFrame, message: e[1], tool: "python" });
        pyFrame = null;
        continue;
      }
    }
    // pytest's short form, with the "E   ..." line above it saying what
    m = /^E\s+(.*)$/.exec(l);
    if (m) {
      // The first E line of a block says what failed; the ones under it say where it came from.
      if (!wasE) lastE = m[1];
      prevE = true;
      continue;
    }
    m = PYTEST.exec(l);
    if (m && /\.py$/.test(m[1])) {
      add({ file: m[1], line: m[2], message: lastE || m[3], tool: "pytest" });
      lastE = "";
      continue;
    }
    // jest, vitest, node's own runner: a header or an error line starts a failure, the first project frame after it is its place
    m = /^\s*●\s+(.+)$/.exec(l) || /^\s*(?:FAIL|×|✗|✖)\s+(.+)$/.exec(l);
    if (m) {
      said = m[1].trim();
      used = false;
      continue;
    }
    m = ERROR_LINE.exec(l);
    if (m) {
      said = `${m[1]}: ${m[2]}`;
      used = false;
      continue;
    }
    m = NODE_LOCATION.exec(l);
    if (m) {
      add({ file: m[1], line: m[2], col: m[3], message: said || "Test failed", tool: "node test" });
      continue;
    }
    m = FRAME.exec(l);
    if (m && !used && said && !NOISE_PATH.test(m[1])) {
      add({ file: m[1], line: m[2], col: m[3], message: said, tool: "test" });
      used = true;
    }
  }
  return out;
}

/** Whether a path is the folder or inside it (never above it, never on another drive). */
function inside(root, p) {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Where a log's file is in this folder: CI's checkout prefix (/home/runner/work/repo/repo/, D:\a\repo\repo\, /github/workspace/) cut
 * off, then the path under the folder. The log is text anyone can write, so the answer is always inside the folder (`..` is dropped,
 * and a path that still leaves is refused), and a path is not shortened to a name that is likely another file: a relative one is
 * tried whole (then under a package folder of a monorepo, two levels down at most, if exactly one has it), an absolute one from an unknown machine by its tails
 * down to two segments. Empty when the file isn't here.
 */
function resolveFile(root, file, exists = fs.existsSync, list = listDirs) {
  let f = String(file).replace(/\\/g, "/");
  f = f.replace(/^(?:[A-Za-z]:)?\/(?:home\/runner\/work|__w|a|Users\/runner\/work)\/[^/]+\/[^/]+\//, "").replace(/^\/github\/workspace\//, "").replace(/^\.\//, "");
  const here = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const ok = (p) => inside(root, p) && exists(p);
  const absolute = /^(?:[A-Za-z]:)?\//.test(f);
  // A path from this very computer (a local run's log): inside the folder and there.
  if (absolute && (f === here || f.toLowerCase().startsWith(`${here.toLowerCase()}/`))) {
    const own = path.normalize(f);
    if (ok(own)) return own;
  }
  const segs = f.split("/").filter((s) => s && s !== "." && s !== ".." && !/^[A-Za-z]:$/.test(s));
  if (!segs.length) return "";
  if (!absolute) {
    const whole = path.join(root, ...segs);
    if (ok(whole)) return whole;
    // A monorepo job that ran in a package's folder logs paths from there: the one subfolder that has it.
    const hits = list(root).map((d) => path.join(root, d, ...segs)).filter(ok);
    if (hits.length === 1) return hits[0];
    return "";
  }
  for (let i = 0; i < segs.length && segs.length - i >= Math.min(2, segs.length); i++) {
    const cand = path.join(root, ...segs.slice(i));
    if (ok(cand)) return cand;
  }
  return "";
}

/** The folder's own subfolders, two levels (packages/web), without hidden ones and the dependencies'. */
function listDirs(root) {
  const dirs = (d) => {
    try {
      return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules").map((e) => e.name);
    } catch {
      return [];
    }
  };
  const out = [];
  for (const a of dirs(root).slice(0, 100)) {
    out.push(a);
    for (const b of dirs(path.join(root, a)).slice(0, 50)) out.push(path.join(a, b));
  }
  return out.slice(0, 1500);
}

/**
 * The status bar's words for a pull request's checks, from the server's overview (src/runner/ci-checks.ts): failing beats running
 * beats passing, as the board's status reader ranks them. Null when there is no pull request or no check to say anything of.
 */
function statusWords(o) {
  if (!o || !o.pr || !o.counts || o.state === "none") return null;
  const n = (k) => Number(o.counts[k]) || 0;
  if (o.state === "failing") return { icon: "error", text: `${n("fail")} failing`, state: "failing" };
  if (o.state === "running") return { icon: "sync~spin", text: `${n("pending")} running`, state: "running" };
  const total = n("pass");
  return { icon: "check", text: `${total} check${total === 1 ? "" : "s"}`, state: "passing" };
}

/** A signature of what the checks stand at, so a change is told from a look that found the same. */
function signature(o) {
  if (!o || !o.pr) return "";
  return JSON.stringify([o.pr.url, (o.checks || []).map((c) => [c.id || c.name, c.bucket])]);
}

const QUICK = 15_000;
const SLOW = 60_000;

/** When to look next: soon while any check is still running (a failure with others pending is still a run), a minute otherwise. */
function nextDelay(o) {
  return o && o.counts && Number(o.counts.pending) > 0 ? QUICK : SLOW;
}

const FAILED = (c) => c.bucket === "fail" || c.bucket === "cancel";

/** The ids of the failed checks (checks that share a name are told apart by id). */
function failedIds(o) {
  return new Set(((o && o.checks) || []).filter(FAILED).map((c) => c.id || c.name));
}

/**
 * Whether to say "N checks failing" now: once when the set of failed checks changes to something new, not when the window opens onto a
 * red pull request (`armed` is false until a real answer has been seen), and not again after a look that found the same. Returns the
 * new `seen` and the count to say (0 for nothing).
 */
function notice(o, seen, armed) {
  const failed = failedIds(o);
  const now = o && o.state === "failing" ? [...failed].sort().join("\n") : "";
  return { seen: now, say: now && now !== seen && armed ? failed.size : 0 };
}

/** The ids opened that are no longer failing: their Problems go. */
function droppedIds(placedIds, o) {
  const failed = failedIds(o);
  return [...placedIds].filter((id) => !failed.has(id));
}

/** A name for a check's Output channel: the check's name, with its workflow (or its place) only when another check has the same name. */
function channelLabel(checks, check) {
  const same = (checks || []).filter((c) => c.name === check.name);
  if (same.length < 2) return check.name;
  if (check.workflow && same.filter((c) => c.workflow === check.workflow).length === 1) return `${check.name} (${check.workflow})`;
  return `${check.name} (#${same.indexOf(check) + 1})`;
}

module.exports = { parseLog, resolveFile, statusWords, signature, clean, cleanText, nextDelay, failedIds, notice, droppedIds, channelLabel, QUICK, SLOW };
