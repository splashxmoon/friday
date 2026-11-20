import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { IDE_FS } from "../src/runner/ide.js";

/** Code's files and search (src/runner/ide.ts): folder escapes, line endings, conflicts, the trash, git marks, search with and without ripgrep, replace. */
const H = IDE_FS as Required<typeof IDE_FS>;

// The trash goes to a temp Friday home, never the real one.
const FRIDAY_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ide-fs-home-")));
process.env.FRIDAY_HOME = FRIDAY_HOME;
test.after(() => fs.rmSync(FRIDAY_HOME, { recursive: true, force: true }));

function tmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ide-fs-")));
}
function put(root: string, rel: string, text: string | Buffer) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" });
function repo(): string {
  const r = tmp();
  git(r, "init", "-q");
  git(r, "config", "user.email", "t@t");
  git(r, "config", "user.name", "t");
  return r;
}
const rgOn = (() => {
  try {
    execFileSync("rg", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();
async function rejects(p: Promise<unknown>, re: RegExp) {
  await assert.rejects(p, re);
}

test("the folder must be an absolute, existing folder", async () => {
  await rejects(H.list({ root: "relative/dir", dir: "" }), /absolute/);
  await rejects(H.list({ root: path.join(tmp(), "nope"), dir: "" }), /does not exist/);
  const r = tmp();
  put(r, "f.txt", "x");
  await rejects(H.list({ root: path.join(r, "f.txt"), dir: "" }), /does not exist/);
});

test("paths that leave the folder are refused, by text and by symlink", async () => {
  const root = tmp();
  const outside = tmp();
  put(outside, "secret.txt", "s");
  put(root, "ok.txt", "ok");
  for (const bad of ["../x", "a/../../x", "/etc/passwd", "C:\\Windows\\x", "C:/x", "a/../.."]) {
    await rejects(H.read({ root, path: bad }), /inside the folder/);
    await rejects(H.write({ root, path: bad, text: "x" }), /inside the folder/);
    await rejects(H.delete({ root, path: bad }), /inside the folder/);
  }
  await rejects(H.rename({ root, from: "ok.txt", to: "../moved.txt" }), /inside the folder/);
  await rejects(H.read({ root, path: "a\0b" }), /null/);
  if (process.platform !== "win32") {
    fs.symlinkSync(outside, path.join(root, "out"));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "peek.txt"));
    fs.symlinkSync(path.join(outside, "ghost.txt"), path.join(root, "dangling.txt"));
    await rejects(H.read({ root, path: "out/secret.txt" }), /outside/);
    await rejects(H.read({ root, path: "peek.txt" }), /outside/);
    await rejects(H.write({ root, path: "out/new.txt", text: "x" }), /outside/);
    await rejects(H.write({ root, path: "dangling.txt", text: "x" }), /outside/);
    await rejects(H.create({ root, path: "out/deep/x.txt", kind: "file" }), /outside/);
    assert.equal(fs.existsSync(path.join(outside, "ghost.txt")), false);
    assert.equal(fs.existsSync(path.join(outside, "new.txt")), false);
    // The link itself can be deleted: that touches only the link.
    const d = await H.delete({ root, path: "out" });
    assert.ok(d.trashed);
    assert.ok(fs.existsSync(path.join(outside, "secret.txt")));
  }
});

test("list: folders first, case-insensitive, .git hidden, slash paths, links", async () => {
  const root = tmp();
  put(root, "b.txt", "bb");
  put(root, "A.txt", "a");
  put(root, "src/z.ts", "z");
  put(root, "Docs/readme.md", "r");
  put(root, "file10.txt", "");
  put(root, "file2.txt", "");
  fs.mkdirSync(path.join(root, ".git"));
  const { entries } = await H.list({ root, dir: "" });
  assert.deepEqual(entries.map((e) => e.name), ["Docs", "src", "A.txt", "b.txt", "file2.txt", "file10.txt"]);
  assert.equal(entries.find((e) => e.name === "b.txt")!.size, 2);
  assert.equal(entries.find((e) => e.name === "src")!.kind, "dir");
  const sub = await H.list({ root, dir: "src/" });
  assert.deepEqual(sub.entries.map((e) => e.path), ["src/z.ts"]);
  assert.ok(entries.every((e) => !e.ignored));
  if (process.platform !== "win32") {
    fs.symlinkSync("b.txt", path.join(root, "ln"));
    // A link shows as what it points to (here a file inside the folder), flagged as a link.
    const ln = (await H.list({ root, dir: "" })).entries.find((e) => e.name === "ln")!;
    assert.deepEqual([ln.kind, ln.link], ["file", true]);
    fs.symlinkSync("src", path.join(root, "lndir"));
    fs.symlinkSync(os.tmpdir(), path.join(root, "out"));
    fs.symlinkSync("nowhere", path.join(root, "broken"));
    const all = (await H.list({ root, dir: "" })).entries;
    assert.equal(all.find((e) => e.name === "lndir")!.kind, "dir");
    assert.equal(all.find((e) => e.name === "out")!.kind, "link", "a link leading outside stays a link");
    assert.equal(all.find((e) => e.name === "broken")!.kind, "link");
    assert.deepEqual((await H.list({ root, dir: "lndir" })).entries.map((e) => e.name), ["z.ts"]);
  }

  await rejects(H.list({ root, dir: "b.txt" }), /./);
});

test("list marks what git ignores, and not tracked files", async () => {
  const root = repo();
  put(root, ".gitignore", "node_modules/\n*.log\nbuild\n");
  put(root, "keep.ts", "k");
  put(root, "debug.log", "l");
  put(root, "node_modules/p/i.js", "x");
  put(root, "build/out.js", "x");
  put(root, "tracked.log", "t");
  git(root, "add", "-f", "tracked.log");
  const { entries } = await H.list({ root, dir: "" });
  const flag = Object.fromEntries(entries.map((e) => [e.name, e.ignored]));
  assert.equal(flag["node_modules"], true);
  assert.equal(flag["build"], true);
  assert.equal(flag["debug.log"], true);
  assert.equal(flag["keep.ts"], false);
  assert.equal(flag["tracked.log"], false);
  assert.equal(flag[".gitignore"], false);
  assert.ok(!("" + entries.map((e) => e.name)).includes(".git,"));
  const inner = await H.list({ root, dir: "node_modules/p" });
  assert.equal(inner.entries[0]!.ignored, true);
});

test("list from a subfolder of a repository", async () => {
  const root = repo();
  put(root, ".gitignore", "*.tmp\n");
  put(root, "pkg/a.tmp", "x");
  put(root, "pkg/a.ts", "x");
  const { entries } = await H.list({ root: path.join(root, "pkg"), dir: "" });
  assert.deepEqual(entries.map((e) => [e.name, e.ignored]), [["a.tmp", true], ["a.ts", false]]);
});

test("read: text, binary, too big, line endings, mtime", async () => {
  const root = tmp();
  put(root, "a.txt", "one\ntwo\n");
  put(root, "w.txt", "one\r\ntwo\r\n");
  put(root, "bin.dat", Buffer.from([1, 2, 0, 3]));
  put(root, "big.txt", Buffer.alloc(5 * 1024 * 1024 + 1, 97));
  const a = await H.read({ root, path: "a.txt" });
  assert.deepEqual([a.text, a.binary, a.tooBig, a.eol, a.size], ["one\ntwo\n", false, false, "lf", 8]);
  assert.ok(Math.abs(a.mtime - fs.statSync(path.join(root, "a.txt")).mtimeMs) < 1);
  const w = await H.read({ root, path: "w.txt" });
  assert.deepEqual([w.text, w.eol], ["one\ntwo\n", "crlf"]);
  const b = await H.read({ root, path: "bin.dat" });
  assert.deepEqual([b.binary, b.text], [true, ""]);
  const big = await H.read({ root, path: "big.txt" });
  assert.deepEqual([big.tooBig, big.text, big.size], [true, "", 5 * 1024 * 1024 + 1]);
  await rejects(H.read({ root, path: "missing.txt" }), /ENOENT/);
});

test("write: CRLF round trip keeps the file's endings", async () => {
  const root = tmp();
  put(root, "w.txt", "one\r\ntwo\r\n");
  const r = await H.read({ root, path: "w.txt" });
  const w = await H.write({ root, path: "w.txt", text: r.text + "three\n", mtime: r.mtime, eol: r.eol });
  assert.equal(w.conflict, undefined);
  assert.equal(fs.readFileSync(path.join(root, "w.txt"), "utf8"), "one\r\ntwo\r\nthree\r\n");
  // Already-CRLF text is not doubled, and "lf" converts back.
  await H.write({ root, path: "w.txt", text: "a\r\nb\n", eol: "crlf" });
  assert.equal(fs.readFileSync(path.join(root, "w.txt"), "utf8"), "a\r\nb\r\n");
  await H.write({ root, path: "w.txt", text: "a\r\nb\r\n", eol: "lf" });
  assert.equal(fs.readFileSync(path.join(root, "w.txt"), "utf8"), "a\nb\n");
});

test("write: creates folders, is atomic (no temp left), keeps permissions", async () => {
  const root = tmp();
  const w = await H.write({ root, path: "deep/er/new.txt", text: "hi" });
  assert.ok(w.mtime > 0);
  assert.equal(fs.readFileSync(path.join(root, "deep/er/new.txt"), "utf8"), "hi");
  assert.deepEqual(fs.readdirSync(path.join(root, "deep/er")), ["new.txt"]);
  if (process.platform !== "win32") {
    put(root, "run.sh", "#!/bin/sh\n");
    fs.chmodSync(path.join(root, "run.sh"), 0o755);
    await H.write({ root, path: "run.sh", text: "#!/bin/sh\necho\n" });
    assert.equal(fs.statSync(path.join(root, "run.sh")).mode & 0o777, 0o755);
  }
  await rejects(H.write({ root, path: "deep", text: "x" }), /folder/);
  await rejects(H.write({ root, path: ".git/config", text: "x" }), /git/);
});

test("write: a change on disk since the read is a conflict and nothing is written", async () => {
  const root = tmp();
  put(root, "a.txt", "mine");
  const r = await H.read({ root, path: "a.txt" });
  // An agent edits it meanwhile.
  fs.writeFileSync(path.join(root, "a.txt"), "agent's");
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(root, "a.txt"), later, later);
  const w = await H.write({ root, path: "a.txt", text: "overwrite", mtime: r.mtime });
  assert.equal(w.conflict, true);
  assert.ok(Math.abs(w.mtime - later.getTime()) < 2);
  assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "agent's");
  // Writing with the fresh mtime, or without one, goes through.
  assert.equal((await H.write({ root, path: "a.txt", text: "ok", mtime: w.mtime })).conflict, undefined);
  assert.equal((await H.write({ root, path: "a.txt", text: "forced" })).conflict, undefined);
  assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "forced");
  // Deleted meanwhile: saving brings it back.
  fs.rmSync(path.join(root, "a.txt"));
  await H.write({ root, path: "a.txt", text: "back", mtime: w.mtime });
  assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "back");
});

test("create and rename", async () => {
  const root = tmp();
  await H.create({ root, path: "a/b/c.txt", kind: "file" });
  await H.create({ root, path: "d/e", kind: "dir" });
  assert.equal(fs.readFileSync(path.join(root, "a/b/c.txt"), "utf8"), "");
  assert.ok(fs.statSync(path.join(root, "d/e")).isDirectory());
  await rejects(H.create({ root, path: "a/b/c.txt", kind: "file" }), /already exists/);
  await rejects(H.create({ root, path: "d", kind: "dir" }), /already exists/);
  await H.rename({ root, from: "a/b/c.txt", to: "x/y/z.txt" });
  assert.ok(fs.existsSync(path.join(root, "x/y/z.txt")));
  assert.ok(!fs.existsSync(path.join(root, "a/b/c.txt")));
  put(root, "other.txt", "o");
  await rejects(H.rename({ root, from: "other.txt", to: "x/y/z.txt" }), /already exists/);
  await rejects(H.rename({ root, from: "nope.txt", to: "n2.txt" }), /does not exist/);
  await rejects(H.rename({ root, from: "x", to: "x/y/inside" }), /itself/);
  await H.rename({ root, from: "other.txt", to: "Other.txt" });
  assert.ok(fs.readdirSync(root).includes("Other.txt"));
});

test("delete moves to the trash folder and keeps the content", async () => {
  const root = tmp();
  const home = tmp();
  const prev = process.env.FRIDAY_HOME;
  process.env.FRIDAY_HOME = home;
  try {
    put(root, "gone.txt", "bye");
    put(root, "dir/sub/f.txt", "deep");
    const a = await H.delete({ root, path: "gone.txt" });
    assert.ok(!fs.existsSync(path.join(root, "gone.txt")));
    assert.ok(a.trashed!.startsWith(path.join(home, "trash", "ide")));
    assert.ok(/^\d+-gone\.txt$/.test(path.basename(a.trashed!)));
    assert.equal(fs.readFileSync(a.trashed!, "utf8"), "bye");
    const b = await H.delete({ root, path: "dir" });
    assert.equal(fs.readFileSync(path.join(b.trashed!, "sub/f.txt"), "utf8"), "deep");
    // Same name twice in the same millisecond never overwrites.
    put(root, "gone.txt", "again");
    const c = await H.delete({ root, path: "gone.txt" });
    assert.notEqual(c.trashed, a.trashed);
    assert.equal(fs.readFileSync(a.trashed!, "utf8"), "bye");
    await rejects(H.delete({ root, path: "gone.txt" }), /does not exist/);
    await rejects(H.delete({ root, path: "" }), /path is needed/);
    await rejects(H.delete({ root, path: ".git" }), /git/);
  } finally {
    if (prev === undefined) delete process.env.FRIDAY_HOME;
    else process.env.FRIDAY_HOME = prev;
  }
});

test("files: git's files plus untracked not ignored, without deleted ones", async () => {
  const root = repo();
  put(root, ".gitignore", "ignored/\n");
  put(root, "src/a.ts", "a");
  put(root, "src/b.ts", "b");
  put(root, "new.ts", "n");
  put(root, "ignored/x.ts", "x");
  git(root, "add", "src", ".gitignore");
  git(root, "commit", "-qm", "init");
  fs.rmSync(path.join(root, "src/b.ts"));
  const r = await H.files({ root });
  assert.deepEqual(r.files, [".gitignore", "new.ts", "src/a.ts"]);
  assert.equal(r.truncated, false);
});

test("files: a plain folder is walked, skipping node_modules, .git, dist, build, .next", async () => {
  const root = tmp();
  for (const f of ["a.ts", "src/b.ts", "node_modules/x/i.js", ".git/HEAD", "dist/o.js", "build/o.js", ".next/c.js", ".env"]) put(root, f, "x");
  const r = await H.files({ root });
  assert.deepEqual(r.files, [".env", "a.ts", "src/b.ts"]);
});

test("stats: mtime and size, null for missing or outside", async () => {
  const root = tmp();
  put(root, "a.txt", "abc");
  const s = (await H.stats({ root, paths: ["a.txt", "nope.txt", "../x"] })).stats;
  assert.equal(s["a.txt"]!.size, 3);
  assert.ok(Math.abs(s["a.txt"]!.mtime - fs.statSync(path.join(root, "a.txt")).mtimeMs) < 1);
  assert.equal(s["nope.txt"], null);
  assert.equal(s["../x"], null);
});

// ── search, once with ripgrep when it is installed and once with the built-in search ──────────────────

function suite(name: string, noRg: boolean) {
  const skip = !noRg && !rgOn ? "ripgrep is not installed" : false;
  const withEngine = async <T>(f: () => Promise<T>): Promise<T> => {
    const prev = process.env.FRIDAY_IDE_NO_RG;
    if (noRg) process.env.FRIDAY_IDE_NO_RG = "1";
    else delete process.env.FRIDAY_IDE_NO_RG;
    try {
      return await f();
    } finally {
      if (prev === undefined) delete process.env.FRIDAY_IDE_NO_RG;
      else process.env.FRIDAY_IDE_NO_RG = prev;
    }
  };
  const proj = () => {
    const root = repo();
    put(root, ".gitignore", "ignored/\n");
    put(root, "src/a.ts", "const Foo = 1;\nfoo(foo);\nfoobar\n");
    put(root, "src/b.js", "// foo here\r\nlet x = 'é foo';\r\n");
    put(root, "docs/n.md", "Foo and foo\n");
    put(root, "ignored/i.ts", "foo ignored\n");
    put(root, "bin.dat", Buffer.concat([Buffer.from("foo"), Buffer.from([0]), Buffer.from("foo")]));
    return root;
  };
  const S = (p: Parameters<typeof H.search>[0]) => withEngine(() => H.search(p));
  const flat = (r: Awaited<ReturnType<typeof H.search>>) => r.files.flatMap((f) => f.matches.map((m) => `${f.path}:${m.line}:${m.col}:${m.length}`));

  test(`${name}: case-insensitive literal by default; skips ignored and binary files`, { skip }, async () => {
    const root = proj();
    const r = await S({ root, query: "foo" });
    assert.deepEqual(flat(r), [
      "docs/n.md:1:0:3",
      "docs/n.md:1:8:3",
      "src/a.ts:1:6:3",
      "src/a.ts:2:0:3",
      "src/a.ts:2:4:3",
      "src/a.ts:3:0:3",
      "src/b.js:1:3:3",
      "src/b.js:2:11:3",
    ]);
    assert.equal(r.total, 8);
    assert.equal(r.truncated, false);
    assert.equal(r.files[2]!.matches[0]!.text, "// foo here", "no carriage return in the line text");
  });

  test(`${name}: case-sensitive, whole word, regex, literal characters`, { skip }, async () => {
    const root = proj();
    assert.deepEqual(flat(await S({ root, query: "Foo", caseSensitive: true })), ["docs/n.md:1:0:3", "src/a.ts:1:6:3"]);
    assert.deepEqual(flat(await S({ root, query: "foo", wholeWord: true, include: "src/a.ts" })), ["src/a.ts:1:6:3", "src/a.ts:2:0:3", "src/a.ts:2:4:3"]);
    assert.deepEqual(flat(await S({ root, query: "fo+b", regex: true })), ["src/a.ts:3:0:4"]);
    assert.deepEqual(flat(await S({ root, query: "foo(", include: "*.ts" })), ["src/a.ts:2:0:4"]);
    assert.deepEqual(flat(await S({ root, query: "foo\\(foo\\)", regex: true })), ["src/a.ts:2:0:8"]);
    await rejects(S({ root, query: "(", regex: true }), /./);
    assert.deepEqual((await S({ root, query: "" })).files, []);
  });

  test(`${name}: include and exclude globs`, { skip }, async () => {
    const root = proj();
    const paths = async (p: Partial<Parameters<typeof H.search>[0]>) => (await S({ root, query: "foo", ...p })).files.map((f) => f.path);
    assert.deepEqual(await paths({ include: "src/**" }), ["src/a.ts", "src/b.js"]);
    assert.deepEqual(await paths({ include: "*.md, *.js" }), ["docs/n.md", "src/b.js"]);
    assert.deepEqual(await paths({ exclude: "src" }), ["docs/n.md"]);
    assert.deepEqual(await paths({ include: "src/**", exclude: "*.js" }), ["src/a.ts"]);
  });

  test(`${name}: columns count characters, not bytes; long lines are cut to 400`, { skip }, async () => {
    const root = tmp();
    put(root, "u.txt", "héllo wörld foo\n" + "x".repeat(600) + " foo\n");
    const r = await S({ root, query: "foo" });
    const [a, b] = r.files[0]!.matches;
    assert.deepEqual([a!.line, a!.col, a!.text], [1, 12, "héllo wörld foo"]);
    assert.equal(b!.text.length, 400);
    assert.equal(b!.col, 601);
  });

  test(`${name}: stops at the cap and says so`, { skip }, async () => {
    const root = tmp();
    put(root, "many.txt", "a\n".repeat(50));
    put(root, "more.txt", "a\n".repeat(50));
    const r = await S({ root, query: "a", max: 70 });
    assert.equal(r.truncated, true);
    assert.equal(r.total, 70);
    assert.equal(r.files.reduce((n, f) => n + f.matches.length, 0), 70);
    assert.equal((await S({ root, query: "a", max: 100 })).truncated, false);
  });

  test(`${name}: works outside a repository, leaving node_modules out`, { skip }, async () => {
    const root = tmp();
    put(root, "a.txt", "needle");
    put(root, "node_modules/m/i.js", "needle");
    put(root, ".hidden", "needle");
    assert.deepEqual((await S({ root, query: "needle" })).files.map((f) => f.path), [".hidden", "a.txt"]);
  });

  test(`${name}: replace, literal and regex, keeping line endings`, { skip }, async () => {
    const root = proj();
    const R = (p: Parameters<typeof H.replace>[0]) => withEngine(() => H.replace(p));
    const lit = await R({ root, query: "foo(", replacement: "bar($1)", include: "*.ts" });
    assert.deepEqual([lit.files, lit.replaced], [1, 1]);
    assert.equal(fs.readFileSync(path.join(root, "src/a.ts"), "utf8"), "const Foo = 1;\nbar($1)foo);\nfoobar\n");
    const rx = await R({ root, query: "(\\w+) here", regex: true, replacement: "$1 there ($&) $$", caseSensitive: true });
    assert.deepEqual([rx.files, rx.replaced], [1, 1]);
    assert.equal(fs.readFileSync(path.join(root, "src/b.js"), "utf8"), "// foo there (foo here) $\r\nlet x = 'é foo';\r\n");
    const all = await R({ root, query: "foo", replacement: "F" });
    assert.equal(all.replaced, 8, "every remaining match counted");
    assert.equal(fs.readFileSync(path.join(root, "ignored/i.ts"), "utf8"), "foo ignored\n", "ignored files are left alone");
    assert.deepEqual(fs.readFileSync(path.join(root, "bin.dat")).subarray(0, 3), Buffer.from("foo"));
    assert.deepEqual(await R({ root, query: "zzz", replacement: "y" }), { files: 0, replaced: 0 });
  });

  test(`${name}: replace in the given files only, and never outside the folder`, { skip }, async () => {
    const root = proj();
    const R = (p: Parameters<typeof H.replace>[0]) => withEngine(() => H.replace(p));
    const r = await R({ root, query: "foo", replacement: "Q", paths: ["docs/n.md"] });
    assert.deepEqual([r.files, r.replaced], [1, 2]);
    assert.equal(fs.readFileSync(path.join(root, "docs/n.md"), "utf8"), "Q and Q\n");
    assert.equal(fs.readFileSync(path.join(r.trashed!, "docs/n.md"), "utf8"), "Foo and foo\n", "the original is in the trash");
    assert.ok(fs.readFileSync(path.join(root, "src/a.ts"), "utf8").includes("foo("));
    await rejects(R({ root, query: "foo", replacement: "Q", paths: ["../x"] }), /inside the folder/);
    await rejects(R({ root, query: "foo", replacement: "Q", paths: [".git/config"] }), /git/);
  });
}
suite("search with ripgrep", false);
suite("search without ripgrep (FRIDAY_IDE_NO_RG=1)", true);

// ── Review fixes ────────────────────────────────────────────────────────────────

test("a file that is not UTF-8 is opened as Latin-1 and saved byte for byte", async () => {
  const root = tmp();
  const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x66, 0x6f, 0x6f, 0x0a]); // "café foo\n" in Latin-1
  put(root, "l1.txt", bytes);
  put(root, "ok.txt", "caf\u00e9 foo\n");
  const r = await H.read({ root, path: "l1.txt" });
  assert.equal(r.encoding, "latin1");
  assert.equal(r.text, "caf\u00e9 foo\n");
  assert.equal((await H.read({ root, path: "ok.txt" })).encoding, undefined);
  // Saved unchanged, with and without the page sending the encoding back.
  await H.write({ root, path: "l1.txt", text: r.text, mtime: r.mtime, encoding: "latin1" });
  assert.deepEqual(fs.readFileSync(path.join(root, "l1.txt")), bytes);
  await H.write({ root, path: "l1.txt", text: r.text });
  assert.deepEqual(fs.readFileSync(path.join(root, "l1.txt")), bytes);
  // An edit keeps the other bytes; characters Latin-1 cannot hold are refused, not turned into "?".
  await H.write({ root, path: "l1.txt", text: "caf\u00e9 bar\n", encoding: "latin1" });
  assert.deepEqual(fs.readFileSync(path.join(root, "l1.txt")), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x62, 0x61, 0x72, 0x0a]));
  await rejects(H.write({ root, path: "l1.txt", text: "\u4e2d", encoding: "latin1" }), /Latin-1/);
  // Replace leaves such a file alone and says so.
  put(root, "l2.txt", bytes);
  const rep = await H.replace({ root, query: "foo", replacement: "Q", paths: ["l2.txt", "ok.txt"] });
  assert.deepEqual([rep.files, rep.replaced], [1, 1]);
  assert.deepEqual(rep.failed, [{ path: "l2.txt", reason: "not UTF-8" }]);
  assert.deepEqual(fs.readFileSync(path.join(root, "l2.txt")), bytes);
});

test("a file with mixed line endings keeps each line's own on a one-line edit", async () => {
  const root = tmp();
  put(root, "m.txt", "a\r\nb\r\nc\nd\r\ne\n");
  const r = await H.read({ root, path: "m.txt" });
  assert.equal(r.mixedEol, true);
  assert.equal(r.text, "a\nb\nc\nd\ne\n");
  await H.write({ root, path: "m.txt", text: "a\nb\nC\nd\ne\n", eol: r.eol });
  assert.equal(fs.readFileSync(path.join(root, "m.txt"), "utf8"), "a\r\nb\r\nC\nd\r\ne\n");
  // A line added in the middle takes the majority ending; the ends keep theirs.
  await H.write({ root, path: "m.txt", text: "a\nb\nC\nnew\nd\ne\n", eol: r.eol });
  assert.equal(fs.readFileSync(path.join(root, "m.txt"), "utf8"), "a\r\nb\r\nC\nnew\r\nd\r\ne\n");
});

test("write: a change of size at the same mtime is a conflict", async () => {
  const root = tmp();
  put(root, "s.txt", "abc");
  const r = await H.read({ root, path: "s.txt" });
  const abs = path.join(root, "s.txt");
  const st = fs.statSync(abs);
  fs.writeFileSync(abs, "abcdef");
  fs.utimesSync(abs, st.atime, st.mtime);
  const w = await H.write({ root, path: "s.txt", text: "mine", mtime: r.mtime, size: r.size });
  assert.equal(w.conflict, true);
  assert.equal(fs.readFileSync(abs, "utf8"), "abcdef");
  const ok = await H.write({ root, path: "s.txt", text: "mine", mtime: w.mtime, size: w.size });
  assert.equal(ok.conflict, undefined);
  assert.equal(ok.size, 4);
});

test(".git is refused in any letter case and at any depth", async () => {
  const root = tmp();
  await rejects(H.write({ root, path: ".GIT/hooks/pre-commit", text: "x" }), /git/);
  await rejects(H.write({ root, path: "sub/.Git/config", text: "x" }), /git/);
  await rejects(H.create({ root, path: "pkg/.git/x", kind: "file" }), /git/);
  assert.equal(fs.existsSync(path.join(root, ".GIT")), false);
});

test("listMany lists several folders, leaving out the ones that fail", async () => {
  const root = tmp();
  put(root, "a/1.txt", "");
  put(root, "b/2.txt", "");
  const r = await H.listMany({ root, dirs: ["a", "b", "missing", "../x", "a"] });
  assert.deepEqual(Object.keys(r.results).sort(), ["a", "b"]);
  assert.deepEqual(r.results.b!.entries.map((e) => e.path), ["b/2.txt"]);
});

test("a runaway regex is stopped at the deadline and the runner stays responsive", async () => {
  const root = tmp();
  put(root, "a.txt", "ok line\n");
  put(root, "evil.txt", "a".repeat(40) + "!\n");
  const prev = [process.env.FRIDAY_IDE_NO_RG, process.env.FRIDAY_IDE_SEARCH_MS];
  process.env.FRIDAY_IDE_NO_RG = "1";
  process.env.FRIDAY_IDE_SEARCH_MS = "800";
  try {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    const t0 = Date.now();
    const r = await H.search({ root, query: "(a+)+$", regex: true });
    clearInterval(timer);
    assert.equal(r.truncated, true, "a timed-out search says it is cut");
    assert.ok(Date.now() - t0 < 5000);
    assert.ok(ticks > 10, "the event loop kept running while the regex spun");
    const rep = await H.replace({ root, query: "(a+)+$", regex: true, replacement: "x" });
    assert.equal(rep.truncated, true);
    assert.equal(fs.readFileSync(path.join(root, "evil.txt"), "utf8").startsWith("aaaa"), true);
  } finally {
    for (const [k, v] of [["FRIDAY_IDE_NO_RG", prev[0]], ["FRIDAY_IDE_SEARCH_MS", prev[1]]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("a newer search of the same folder cancels the one still running", async () => {
  const root = tmp();
  put(root, "evil.txt", "a".repeat(40) + "!\n");
  put(root, "b.txt", "needle\n");
  const prev = [process.env.FRIDAY_IDE_NO_RG, process.env.FRIDAY_IDE_SEARCH_MS];
  process.env.FRIDAY_IDE_NO_RG = "1";
  process.env.FRIDAY_IDE_SEARCH_MS = "20000";
  try {
    const slow = H.search({ root, query: "(a+)+$", regex: true });
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    const fast = await H.search({ root, query: "needle" });
    const old = await slow;
    assert.equal(old.cancelled, true);
    assert.deepEqual(fast.files.map((f) => f.path), ["b.txt"]);
    assert.ok(Date.now() - t0 < 5000, "the newer search did not wait for the older one");
  } finally {
    for (const [k, v] of [["FRIDAY_IDE_NO_RG", prev[0]], ["FRIDAY_IDE_SEARCH_MS", prev[1]]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("replace: files with unsaved edits are skipped, and what changed is kept in the trash", async () => {
  const root = tmp();
  put(root, "a.txt", "foo\n");
  put(root, "b.txt", "foo foo\n");
  const r = await H.replace({ root, query: "foo", replacement: "bar", skipPaths: ["b.txt"] });
  assert.deepEqual([r.files, r.replaced], [1, 1]);
  assert.equal(fs.readFileSync(path.join(root, "b.txt"), "utf8"), "foo foo\n");
  assert.equal(fs.readFileSync(path.join(r.trashed!, "a.txt"), "utf8"), "foo\n");
  assert.ok(r.trashed!.startsWith(FRIDAY_HOME));
});

test("replace: a file that can't be written is reported and the rest are still done", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const root = tmp();
  put(root, "locked/a.txt", "foo\n");
  put(root, "z.txt", "foo\n");
  fs.chmodSync(path.join(root, "locked"), 0o500);
  try {
    const r = await H.replace({ root, query: "foo", replacement: "bar" });
    assert.equal(r.files, 1);
    assert.equal(r.failed?.length, 1);
    assert.equal(r.failed![0]!.path, "locked/a.txt");
  } finally {
    fs.chmodSync(path.join(root, "locked"), 0o700);
  }
});
