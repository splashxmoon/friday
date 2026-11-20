"use strict";
// Finding TODO, FIXME, HACK and XXX comments (Arun, 2026-11-19, wave 4: "TODOs become tasks: Friday finds the TODO and FIXME
// comments in your repo, lists them, and hands any of them to an agent in one click."). Pure functions, no vscode: the matcher
// reads a file's text with a small scanner that knows each language's comment marks and its strings, so a marker only counts
// when it is in a comment (not in a string, not in a variable called todos) and is what the comment starts with (or "TODO:"
// anywhere in it). The scan of a folder (git's file list, the caps, files.exclude) is here too, so a test can run it without an IDE.
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const MARKERS = "TODO|FIXME|HACK|XXX";
/** A comment that starts with the marker in capitals: TODO, FIXME(ann), @TODO. */
// Not "TODO.md" or "XXX-large": a file name or a word with the marker in front is not a task.
const START_UP = new RegExp(`^@?(${MARKERS})(?!\\w)(?!\\.\\w)(?!-[A-Za-z])(?:\\(([^)]{0,60})\\))?[\\s:\\-\u2013\\u2014]*(.*)$`);
/** The same in lower or title case, which only counts with a colon or a name after it ("todo: x", "Todo(ann)"; "todo list" is prose). */
const START_LOW = /^@?(todo|fixme|hack|xxx|Todo|Fixme|Hack)(?:\(([^)]{0,60})\)\s*:?|:)[\s\-\u2013\u2014]*(.*)$/;
/** A doc tag: "@todo finish this" (JSDoc, PHPDoc), which needs no colon because the "@" says it is a tag. */
const START_TAG = /^@(todo|fixme)\s+(.*)$/i;
/** Anywhere in a comment, only the clear form: capitals with a colon ("NOTE: TODO: remove"). */
const INSIDE = new RegExp(`\\b(${MARKERS})(?:\\(([^)]{0,60})\\))?:\\s*(.*)$`);

const C = { line: ["//"], block: [["/*", "*/"]], str: "\"'`", regex: true };
const STYLES = {
  c: C,
  cstr: { line: ["//"], block: [["/*", "*/"]], str: "\"'" },
  css: { line: [], block: [["/*", "*/"]], str: "\"'" },
  php: { line: ["//", "#"], block: [["/*", "*/"]], str: "\"'" },
  hash: { line: ["#"], block: [], str: "\"'", triple: true },
  ps: { line: ["#"], block: [["<#", "#>"]], str: "\"'" },
  ruby: { line: ["#"], block: [["=begin", "=end"]], str: "\"'" },
  html: { line: [], block: [["<!--", "-->"]], str: "" },
  sql: { line: ["--"], block: [["/*", "*/"]], str: "'" },
  lua: { line: ["--"], block: [["--[[", "]]"]], str: "\"'" },
  haskell: { line: ["--"], block: [["{-", "-}"]], str: "\"" },
  lisp: { line: [";"], block: [], str: "\"" },
  tex: { line: ["%"], block: [], str: "" },
  vim: { line: ['"'], block: [], str: "'" },
  generic: { line: ["//", "#"], block: [["/*", "*/"]], str: "" },
};
const EXT = {};
const add = (style, list) => list.split(" ").forEach((e) => (EXT[e] = style));
add("c", "js jsx mjs cjs ts tsx mts cts go dart");
add("cstr", "java c h cc cpp cxx hpp hh cs rs swift kt kts scala groovy gradle m mm zig sol proto v");
add("css", "css scss less styl");
add("php", "php");
add("ps", "ps1 psm1");
add("hash", "py pyw sh bash zsh fish yml yaml toml r pl pm tcl nim cr ex exs conf ini properties tf env cfg txt dockerfile makefile mk cmake coffee jl");
add("ruby", "rb rake gemspec");
add("html", "xml svg md mdx markdown");
add("sql", "sql");
add("lua", "lua");
add("haskell", "hs elm purs");
add("lisp", "lisp el clj cljs scm rkt asm s");
add("tex", "tex");
add("vim", "vim");
// Files with no extension, by name.
const NAMES = { makefile: "hash", dockerfile: "hash", gemfile: "ruby", rakefile: "ruby", jenkinsfile: "c", vagrantfile: "ruby" };
// A .vue, .svelte or .html file has script and style as well as markup; its comments in any of those forms count, and its
// strings hide a "// TODO" as they do anywhere else.
const MIXED = new Set(["vue", "svelte", "astro", "html", "htm", "xhtml"]);
// Markdown prose is full of apostrophes and "# headings": only <!-- --> comments are comments there (html style has no strings or #).

const MAX_LINE = 2000;

/** The comment style for a file name, or null for a kind of file that is not scanned. */
function styleFor(file) {
  const base = path.basename(String(file)).toLowerCase();
  if (NAMES[base]) return STYLES[NAMES[base]];
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1) : dot === 0 ? base.slice(1) : "";
  if (/\.min\.(js|css)$/.test(base) || /\.(lock|map|snap)$/.test(base)) return null;
  if (MIXED.has(ext)) return STYLES.c_html || (STYLES.c_html = { line: ["//"], block: [["/*", "*/"], ["<!--", "-->"]], str: "\"'" });
  return STYLES[EXT[ext]] || null;
}

const MAX_STR_LINES = 60;

/** The index just after a regex literal that starts at `p`, or -1 when no closing slash is on the line (then it was division). */
function regexEnd(s, p) {
  let cls = false;
  for (let k = p + 1; k < s.length; k++) {
    const c = s[k];
    if (c === "\\") k++;
    else if (c === "[") cls = true;
    else if (c === "]") cls = false;
    else if (c === "/" && !cls) return k + 1;
  }
  return -1;
}

/** The index just after the "}" that closes a template's ${ hole opened before `at` (nested braces and backticks skipped), or the line's end. */
function skipHole(s, at) {
  let depth = 1;
  for (let k = at; k < s.length; k++) {
    const c = s[k];
    if (c === "`") {
      const e = s.indexOf("`", k + 1);
      if (e < 0) return s.length;
      k = e;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return k + 1;
  }
  return s.length;
}

/** What a comment's words say, as a hit, or null when it is not a TODO. `body` is the comment without its marks. */
function matchBody(body) {
  let t = String(body).replace(/^[\s*!/#=\-]+/, "");
  // "*/" or "-->" left on the end by a comment closed on this line.
  t = t.replace(/\s*(?:\*\/|-->|\]\]|-\}|=end)\s*$/, "");
  let m = START_UP.exec(t) || START_LOW.exec(t) || INSIDE.exec(t);
  if (!m) {
    const d = START_TAG.exec(t);
    if (!d) return null;
    m = [d[0], d[1], "", d[2]];
  }
  const tag = m[1].toUpperCase();
  const who = m[2];
  let text = m[3];
  text = String(text || "").replace(/\s+/g, " ").trim();
  return { tag, who: who ? who.trim() : "", text };
}

/**
 * Every marker comment in a file's text: [{ line (1-based), tag, who, text }], in order. `file` only picks the comment style.
 * A string never counts (`"// TODO"`), nor does `http://x`; a block comment counts on each of its lines, so the marker may sit
 * on any of them.
 */
function scanText(text, file, limit) {
  const style = styleFor(file);
  if (!style) return [];
  const lines = String(text).split(/\r\n|\r|\n/);
  const hits = [];
  let block = null; // the end mark of the block comment we are inside
  let str = ""; // the quote of a string running over lines (a template, a triple-quoted string)
  let strFrom = 0; // the line it began on
  const max = limit || 500;
  for (let i = 0; i < lines.length && hits.length < max; i++) {
    const s = lines[i];
    // A backtick or triple quote that never closes (one inside a regex or a stray one) must not swallow the rest of the file.
    if (str && i - strFrom > MAX_STR_LINES) str = "";
    if (s.length > MAX_LINE) continue;
    // Quick out: nothing on the line that is a marker word or opens a comment or a string.
    if (!block && !str && !/todo|fixme|hack|xxx/i.test(s) && !/\/\*|<!--|<#|\{-|=begin|--\[\[|`|"""|'''/.test(s)) continue;
    const found = [];
    let at = 0;
    const take = (body) => {
      const h = matchBody(body);
      if (h && !found.length) found.push({ line: i + 1, ...h });
    };
    scan: while (at <= s.length) {
      if (block) {
        const end = s.indexOf(block, at);
        take(end < 0 ? s.slice(at) : s.slice(at, end));
        if (end < 0) break;
        at = end + block.length;
        block = null;
        continue;
      }
      if (str) {
        // To the closing quote, skipping what a backslash escapes.
        for (; at < s.length; at++) {
          if (s[at] === "\\" && str.length === 1) at++;
          else if (str === "`" && s[at] === "$" && s[at + 1] === "{") at = skipHole(s, at + 2) - 1;
          else if (s.startsWith(str, at)) {
            at += str.length;
            str = "";
            continue scan;
          }
        }
        // A plain quote does not run over the line's end (a template's backtick and a triple quote do).
        if (str.length === 1 && str !== "`") str = "";
        break;
      }
      // The next thing that matters, in this order of position.
      let best = null;
      const consider = (pos, kind, mark, end) => {
        if (pos >= 0 && (!best || pos < best.pos || (pos === best.pos && mark.length > best.mark.length))) best = { pos, kind, mark, end };
      };
      for (const m of style.line) {
        let p = s.indexOf(m, at);
        // "http://x" is a link; a hash needs a space (or the line's start) before it, as in shell and Python.
        while (p >= 0 && ((m === "//" && p > 0 && s[p - 1] === ":") || ((m === "#" || m === ";" || m === "%" || m === '"') && p > 0 && !/\s/.test(s[p - 1])) || (m === "--" && p > 0 && s[p - 1] === "-"))) p = s.indexOf(m, p + m.length);
        consider(p, "line", m);
      }
      for (const [a, z] of style.block) {
        let p = s.indexOf(a, at);
        // Ruby's =begin only at the start of a line.
        if (a === "=begin" && p > 0) p = -1;
        consider(p, "block", a, z);
      }
      for (const q of style.str) {
        // An apostrophe right after a word is not a string ("don't", Rust's &'a), so the next one is looked for.
        let p = s.indexOf(q, at);
        while (q === "'" && p > 0 && /[\w<&]/.test(s[p - 1])) p = s.indexOf(q, p + 1);
        consider(p, "str", q);
      }
      // A regex literal (/["']/g): its quotes are not strings. Only after a mark that can't end an operand, so "a / b" is division.
      if (style.regex) {
        for (let p = s.indexOf("/", at); p >= 0; p = s.indexOf("/", p + 1)) {
          if (best && p >= best.pos) break;
          if (s[p + 1] === "/" || s[p + 1] === "*" || (p > 0 && s[p - 1] === "*")) continue;
          if (!/(?:^|[(,=:[!&|?{};+\-*%~^]|\breturn|\btypeof)\s*$/.test(s.slice(0, p))) continue;
          const e = regexEnd(s, p);
          if (e > 0) {
            at = e;
            continue scan;
          }
        }
      }
      if (!best) break;
      if (best.kind === "line") {
        take(s.slice(best.pos + best.mark.length));
        break;
      }
      if (best.kind === "block") {
        block = best.end;
        at = best.pos + best.mark.length;
        continue;
      }
      // A string: a triple quote (Python) runs over lines, a backtick may, a plain quote ends with the line.
      const q = best.mark;
      str = style.triple && s.startsWith(q.repeat(3), best.pos) ? q.repeat(3) : q;
      strFrom = i;
      at = best.pos + str.length;
    }
    // A marker in a plain quote left open at the line's end is not carried to the next line.
    if (str.length === 1 && str !== "`") str = "";
    hits.push(...found);
  }
  return hits;
}

// ---- the folder: which files, how many.

const MAX_FILES = 2000;
const MAX_HITS = 500;
const MAX_BYTES = 1024 * 1024;
const PROSE = /\.(?:md|mdx|markdown|txt|ya?ml|toml|ini|conf|cfg|properties|env|xml|svg)$/i;
const SKIP_DIRS = /(?:^|\/)(?:node_modules|\.git|\.hg|\.svn|dist|build|out|target|vendor|\.next|\.nuxt|\.venv|venv|__pycache__|\.gradle|Pods|DerivedData|coverage|\.friday)\//;

/** A files.exclude key ("**\/node_modules", "*.log", "{a,b}/**") as a test on a slash path relative to the folder. */
function globTest(glob) {
  let re = "";
  const g = String(glob).replace(/\\/g, "/");
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") re += "(?:";
    else if (c === "}") re += ")";
    else if (c === ",") re += re.lastIndexOf("(?:") > re.lastIndexOf(")") ? "|" : ",";
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  // A folder's glob also takes everything under it.
  return new RegExp(`^${re}(?:/.*)?$`);
}

/** The test for a files.exclude setting ({ "**\/x": true, "**\/y": false }): true for a relative slash path it hides. */
function excluder(setting) {
  const tests = Object.entries(setting || {}).filter(([, v]) => v === true).flatMap(([k]) => {
    // A key that makes no pattern (an unpaired brace) hides nothing, and does not stop the scan.
    try {
      return [globTest(k)];
    } catch {
      return [];
    }
  });
  return (rel) => tests.some((t) => t.test(rel));
}

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile("git", ["-c", "core.quotepath=off", ...args], { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 30000 }, (err, out) => resolve(err ? null : String(out)));
  });
}

/** The files of a folder worth reading, as relative slash paths: git's own list (tracked and new, never ignored) or a walk. */
async function listFiles(root, exclude) {
  let rels = null;
  const out = await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (out !== null) rels = out.split("\0").filter(Boolean);
  if (!rels) {
    rels = [];
    const walk = (dir, prefix, depth) => {
      if (depth > 12 || rels.length > MAX_FILES * 4) return;
      let list;
      try {
        list = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of list) {
        const rel = prefix + e.name;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.test(`${rel}/`)) walk(path.join(dir, e.name), `${rel}/`, depth + 1);
        } else if (e.isFile()) rels.push(rel);
      }
    };
    walk(root, "", 0);
  }
  const hide = excluder(exclude);
  const seen = new Set();
  const keep = [];
  for (const r of rels) {
    const rel = r.replace(/\\/g, "/");
    if (seen.has(rel) || !styleFor(rel) || SKIP_DIRS.test(rel) || hide(rel)) continue;
    seen.add(rel);
    keep.push(rel);
  }
  // Code before prose: when a folder has more files than the cap, it is the notes and configs that are left unread, not src/.
  return keep.map((rel) => [PROSE.test(rel) ? 1 : 0, rel]).sort((a, b) => a[0] - b[0]).map((e) => e[1]);
}

/** True when git says a path (relative to root) is ignored; false when it is not, or the folder is not a repository. */
function isIgnored(root, rel) {
  return new Promise((resolve) => {
    execFile("git", ["check-ignore", "-q", "--", rel], { cwd: root, windowsHide: true, timeout: 10000 }, (err) => resolve(!err));
  });
}

/**
 * Reads files a few at a time, so a big folder doesn't hold the editor's host. Returns [{ file (absolute), rel, hits }] only for
 * files with hits, with `capped` on the array: { files, hits } true when the file cap or the hit cap stopped the reading, so the
 * view can say the list is not the whole truth.
 */
async function scanFolder(root, { exclude, maxFiles = MAX_FILES, maxHits = MAX_HITS } = {}) {
  const all = await listFiles(root, exclude);
  const rels = all.slice(0, maxFiles);
  const out = [];
  out.capped = { files: all.length > maxFiles, hits: false };
  let total = 0;
  for (let i = 0; i < rels.length && total < maxHits; i += 40) {
    await Promise.all(
      rels.slice(i, i + 40).map(async (rel) => {
        const file = path.join(root, ...rel.split("/"));
        try {
          const st = await fs.promises.stat(file);
          if (!st.isFile() || st.size > MAX_BYTES) return;
          const text = await fs.promises.readFile(file, "utf8");
          if (text.indexOf("\0") >= 0) return;
          const hits = scanText(text, rel, maxHits - total);
          if (hits.length) {
            out.push({ file, rel, hits });
            total += hits.length;
          }
        } catch {
          // A file that vanished or can't be read has none.
        }
      }),
    );
    await new Promise((r) => setImmediate(r));
  }
  out.capped.hits = total >= maxHits;
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/** Who wrote a line and how long ago, by git blame of that one line: { author, at (ms) } or null (not in git, not committed yet). */
async function blameLine(file, line) {
  const out = await git(path.dirname(file), ["blame", "-L", `${line},${line}`, "--porcelain", "--", path.basename(file)]);
  if (!out) return null;
  const author = /^author (.*)$/m.exec(out);
  const time = /^author-time (\d+)$/m.exec(out);
  if (!author || /^Not Committed Yet$/i.test(author[1])) return null;
  return { author: author[1], at: time ? Number(time[1]) * 1000 : 0 };
}

/** "3 days ago", "2 months ago": plain and short. */
function ago(ms, now) {
  const s = Math.max(0, ((now || Date.now()) - ms) / 1000);
  const n = (v, w) => `${Math.floor(v)} ${w}${Math.floor(v) === 1 ? "" : "s"} ago`;
  if (s < 3600) return "just now";
  if (s < 86400) return n(s / 3600, "hour");
  if (s < 86400 * 30) return n(s / 86400, "day");
  if (s < 86400 * 365) return n(s / (86400 * 30), "month");
  return n(s / (86400 * 365), "year");
}

module.exports = { scanText, isIgnored, SKIP_DIRS, MAX_BYTES, styleFor, matchBody, scanFolder, listFiles, excluder, globTest, blameLine, ago, MAX_FILES, MAX_HITS };
