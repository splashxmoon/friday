// The terminal's binary in each packed app (build/pty-arch.cjs): 0.2.6's Linux AppImage shipped without one and stopped before
// its window opened (a report on Ubuntu 24.04, 2026-11-02), since npm on Linux loads the module's own binaries in place and
// leaves build/Release empty. Now it's staged there before a Linux app is packed, and an app packed without it fails the build.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const pty = require("../build/pty-arch.cjs") as { before: (c: unknown) => void; after: (c: unknown) => void };

/** The first bytes of an ELF file for a machine (e_machine at 18), and some more. */
const elf = (machine: number) => {
  const b = Buffer.alloc(64);
  b.writeUInt32BE(0x7f454c46, 0);
  b.writeUInt16LE(machine, 18);
  return b;
};
const X64 = 0x3e;
const ARM64 = 0xb7;

function rig() {
  const root = mkdtempSync(path.join(tmpdir(), "friday-pty-arch-"));
  const mod = path.join(root, "project", "node_modules", "@homebridge", "node-pty-prebuilt-multiarch");
  for (const [dir, machine] of [["linux-x64", X64], ["linux-arm64", ARM64]] as const) {
    mkdirSync(path.join(mod, "prebuilds", dir), { recursive: true });
    for (const abi of [127, 137]) writeFileSync(path.join(mod, "prebuilds", dir, `node.abi${abi}.node`), elf(machine));
    writeFileSync(path.join(mod, "prebuilds", dir, "node.abi137.musl.node"), "musl");
  }
  const out = path.join(root, "out");
  const context = (arch: number, platform = "linux") => ({ electronPlatformName: platform, arch, appOutDir: out, packager: { projectDir: path.join(root, "project"), appInfo: { productFilename: "Friday" } } });
  /** Copies what the app would ship from the module into the packed app, as electron-builder's "files" does. */
  const pack = () => {
    const from = path.join(mod, "build", "Release", "pty.node");
    const to = path.join(out, "resources", "app", "node_modules", "@homebridge", "node-pty-prebuilt-multiarch", "build", "Release");
    rmSync(out, { recursive: true, force: true });
    mkdirSync(to, { recursive: true });
    if (existsSync(from)) writeFileSync(path.join(to, "pty.node"), readFileSync(from));
  };
  return { root, mod, context, pack };
}

test("a Linux app gets its chip's terminal binary where Electron looks, and the packed app is checked for it", (t) => {
  const r = rig();
  t.after(() => rmSync(r.root, { recursive: true, force: true }));
  // x64 (electron-builder's Arch 1): staged from the module's own glibc binary, not the musl one.
  pty.before(r.context(1));
  assert.equal(readFileSync(path.join(r.mod, "build", "Release", "pty.node")).readUInt16LE(18), X64);
  r.pack();
  assert.doesNotThrow(() => pty.after(r.context(1)));
  // arm64 (3) after x64 on the same machine: its own replaces it.
  pty.before(r.context(3));
  r.pack();
  assert.doesNotThrow(() => pty.after(r.context(3)));
  assert.throws(() => pty.after(r.context(1)), /isn't a Linux x64 one/, "an arm64 binary in an x64 app fails the build");
});

test("an app packed without the terminal binary fails the build, as 0.2.6's AppImage should have", (t) => {
  const r = rig();
  t.after(() => rmSync(r.root, { recursive: true, force: true }));
  r.pack();
  assert.throws(() => pty.after(r.context(1)), /no terminal binary/);
  assert.throws(() => pty.after(r.context(1, "win32")), /no terminal binary/, "Windows is checked too, for ConPTY's");
});

test("with no Linux binary for the chip in the module, packing stops before it starts", (t) => {
  const r = rig();
  t.after(() => rmSync(r.root, { recursive: true, force: true }));
  rmSync(path.join(r.mod, "prebuilds"), { recursive: true });
  assert.throws(() => pty.before(r.context(1)), /No Linux x64 binary/);
});
