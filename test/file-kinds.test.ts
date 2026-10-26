import assert from "node:assert/strict";
import test from "node:test";
import { isTextLike, isUsableFile } from "../src/file-kinds.js";

/**
 * What survives a folder upload.
 *
 * This was an allowlist of about forty extensions, and it threw away 82% of
 * an ordinary cross-language project without anybody being able to find out
 * which files. The rule is now a denylist, so the test that matters is the
 * long boring list of things that must come through.
 */

/** Real files from real projects, none of which used to survive. */
const MUST_KEEP = `
Dockerfile docker-compose.yml Makefile Rakefile Gemfile Procfile LICENSE README CHANGELOG AUTHORS NOTICE
.gitignore .gitattributes .dockerignore .editorconfig .npmrc .nvmrc .prettierrc .eslintrc .babelrc .env.example
src/main.mjs src/util.cjs src/types.mts src/legacy.cts src/index.ts src/App.tsx
app/App.vue components/Card.svelte pages/index.astro
styles/main.scss styles/_vars.sass styles/theme.less
schema.graphql queries.gql api.proto
yarn.lock Cargo.lock pnpm-lock.yaml poetry.lock composer.lock go.sum
main.rs Cargo.toml main.go go.mod
app.py setup.cfg pyproject.toml requirements.txt tox.ini Pipfile notebook.ipynb
Main.java build.gradle build.gradle.kts pom.xml App.kt Main.scala core.clj app.ex mix.exs server.erl Main.hs
index.php main.lua script.pl analysis.R analysis.jl main.dart pubspec.yaml
AppDelegate.m ViewController.mm Info.plist project.pbxproj Main.storyboard App.xib app.entitlements MyLib.podspec
main.tf terraform.tfvars config.hcl nginx.conf app.properties
deploy.ps1 run.bat setup.zsh lib.bash fix.patch change.diff
docs/guide.rst docs/manual.adoc paper.tex App.csproj App.sln MainWindow.xaml
contract.sol module.move main.zig app.nim .vimrc init.el logo.svg
`.trim().split(/\s+/);

test("an ordinary project arrives whole", () => {
  const dropped = MUST_KEEP.filter((f) => !isUsableFile(f, ""));
  assert.deepEqual(dropped, [], "these are the files people upload");
});

/** A file with no extension at all is the common case for the most important ones. */
test("no extension means text, because that is where Dockerfile and LICENSE live", () => {
  assert.ok(isTextLike("Dockerfile"));
  assert.ok(isTextLike("Makefile"));
  assert.ok(isTextLike("src/vendor/LICENSE"));
});

test("media, archives and compiled output are still refused", () => {
  for (const f of ["clip.mp4", "song.mp3", "photo.heic", "bundle.zip", "app.dmg", "lib.so", "font.woff2", "Main.class", "cache.sqlite3", "key.p12"]) {
    assert.equal(isTextLike(f), false, `${f} is not text`);
    assert.equal(isUsableFile(f), false, `${f} is not usable`);
  }
});

/** The three the model can be handed as something other than characters. */
test("images and PDFs are usable but are not text", () => {
  for (const f of ["diagram.png", "shot.jpeg", "scan.pdf"]) {
    assert.equal(isUsableFile(f), true);
    assert.equal(isTextLike(f), false, `${f} should not be inlined as characters`);
  }
});

/** SVG is a text format, and the old allowlist lost it in both directions. */
test("svg is text", () => {
  assert.ok(isTextLike("logo.svg"));
  assert.ok(isTextLike("logo.svg", "image/svg+xml"));
});

/**
 * The browser's type wins over the name when it says binary: a .txt the
 * browser reports as video/mp4 is a video with a misleading name.
 */
test("a browser-reported media type beats the extension", () => {
  assert.equal(isTextLike("notes.txt", "video/mp4"), false);
  assert.equal(isTextLike("weird.xyz", "audio/mpeg"), false);
  assert.equal(isTextLike("weird.xyz", ""), true, "unknown extension, no type: assume text");
});

import { looksBinary } from "../src/files.js";

/**
 * Assuming text is right far more often than it is wrong, and this is what
 * catches the times it is wrong. Only the server has the bytes, so only the
 * server can ask.
 */
test("the bytes get the last word on whether something is text", () => {
  assert.equal(looksBinary(Buffer.from("const x = 1\nexport default x\n")), false);
  assert.equal(looksBinary(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])), true, "a NUL means binary");
  // A NUL past the window is not looked for: reading a whole 10 MB file to
  // classify it costs more than the one bad paragraph it would prevent.
  assert.equal(looksBinary(Buffer.concat([Buffer.alloc(9000, 0x41), Buffer.from([0])])), false);
  assert.equal(looksBinary(Buffer.from("")), false, "an empty file is an empty file, not a binary");
});

import { pickable } from "../src/client/Attach.js";

/** Stand-in for a browser File, which is all `pickable` reads. */
const f = (path: string, size = 100, type = "") =>
  ({ name: path.split("/").pop(), size, type, webkitRelativePath: path }) as unknown as File;

/**
 * The pick itself, over a folder shaped like a real one.
 *
 * The point of the test is the ratio: an ordinary project should arrive
 * essentially whole, and what it drops should be things nobody would miss.
 */
test("a picked folder arrives whole apart from what is generated", () => {
  const files = [
    f("app/Dockerfile"),
    f("app/Makefile"),
    f("app/.gitignore"),
    f("app/src/main.mjs"),
    f("app/src/App.vue"),
    f("app/styles/main.scss"),
    f("app/go.mod"),
    f("app/ios/Info.plist"),
    f("app/infra/main.tf"),
    f("app/node_modules/left-pad/index.js"),
    f("app/.git/objects/ab/cdef"),
    f("app/ios/Pods/Alamofire/Source/Alamofire.swift"),
    f("app/target/debug/binary"),
    f("app/assets/hero.mp4", 1000, "video/mp4"),
    f("app/huge.json", 20 * 1024 * 1024),
  ];
  const { keep, skipped, reason, over } = pickable(files);
  // Everything a project is made of comes, images and big data files included:
  // a working copy with the pictures missing does not run. Only what is
  // generated or downloaded stays behind, and the message says so.
  assert.deepEqual(
    keep.map((k) => k.path),
    ["app/Dockerfile", "app/Makefile", "app/.gitignore", "app/src/main.mjs", "app/src/App.vue", "app/styles/main.scss", "app/go.mod", "app/ios/Info.plist", "app/infra/main.tf", "app/assets/hero.mp4", "app/huge.json"],
  );
  assert.equal(over, 0);
  assert.equal(skipped, 4);
  assert.match(reason, /4 from build and dependency folders/);
  // A single file picked on its own still has to be something the agent can read.
  const loose = pickable([f("hero.mp4", 1000, "video/mp4"), f("notes.md")]);
  assert.deepEqual(loose.keep.map((k) => k.path), ["notes.md"]);
  assert.match(loose.reason, /1 media and binaries/);
});

/** Written by hand in plenty of projects, so never skipped as build output. */
test("bin and out are somebody's scripts, not build output", () => {
  const { keep } = pickable([f("app/bin/deploy"), f("app/out/report.md")]);
  assert.equal(keep.length, 2);
});
