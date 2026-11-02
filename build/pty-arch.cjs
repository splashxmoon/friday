/**
 * The terminal's pty module, for the chip and system each app is packaged for.
 *
 * npm installs its binary for this machine's chip only, and one Mac build makes both an Apple Silicon and an Intel app, so
 * each would otherwise ship this machine's. So before each Mac app is packed, the binary for its chip is fetched in its place,
 * and after, this machine's is put back. It's a Node-API binary, so the same one loads in Node and in any Electron.
 *
 * On Linux npm leaves build/Release empty: the module ships its own Linux binaries (prebuilds/linux-<arch>, named for each
 * Node, the same Node-API file under every name) and loads them straight from there, but only under Node's names, so in
 * Electron it looks in build/Release and found nothing: 0.2.6's AppImage stopped before its window opened (a report on
 * Ubuntu 24.04, 2026-11-02). So before each Linux app is packed, its chip's binary is put in build/Release, which the app
 * ships (package.json "build" files). Windows keeps its own: npm fetches it into build/Release there.
 *
 * And after each app is packed, whatever the system, the app must hold the binary (and on Linux, one for its chip), or the
 * build fails rather than ship an app that can't start.
 * electron-builder runs it through before-pack.cjs and after-pack.cjs (package.json "build").
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ARCHES = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64" };
/** The module's folder of Linux binaries for each chip, and the machine each is built for (an ELF file's e_machine). */
const LINUX = { ia32: ["linux-ia32", 0x03], x64: ["linux-x64", 0x3e], armv7l: ["linux-arm", 0x28], arm64: ["linux-arm64", 0xb7] };

const ptyDir = (projectDir) => path.join(projectDir, "node_modules", "@homebridge", "node-pty-prebuilt-multiarch");

function fetchFor(projectDir, arch) {
  const dir = ptyDir(projectDir);
  const bin = require.resolve("prebuild-install/bin.js", { paths: [dir, projectDir] });
  execFileSync(process.execPath, [bin, `--arch=${arch}`, "--platform=darwin"], { cwd: dir, stdio: "inherit" });
}

/** The Linux binary for a chip, from the module's own (glibc, not musl), put where Electron looks. */
function stageLinux(projectDir, arch) {
  const dir = ptyDir(projectDir);
  const from = path.join(dir, "prebuilds", LINUX[arch][0]);
  const names = fs.existsSync(from) ? fs.readdirSync(from).filter((f) => /^node\.abi\d+\.node$/.test(f)) : [];
  if (!names.length) throw new Error(`No Linux ${arch} binary for the terminal in ${from}: reinstall with npm ci.`);
  const name = names.includes(`node.abi${process.versions.modules}.node`) ? `node.abi${process.versions.modules}.node` : names.sort().at(-1);
  fs.mkdirSync(path.join(dir, "build", "Release"), { recursive: true });
  fs.copyFileSync(path.join(from, name), path.join(dir, "build", "Release", "pty.node"));
}

/** Where the packed app keeps the binary it loads (Windows' is ConPTY's). The app isn't an asar (package.json "build"), so it is a file there. */
function packedBinary(context) {
  const name = context.electronPlatformName === "win32" ? "conpty.node" : "pty.node";
  const resources = context.electronPlatformName === "darwin" ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources") : path.join(context.appOutDir, "resources");
  return path.join(resources, "app", "node_modules", "@homebridge", "node-pty-prebuilt-multiarch", "build", "Release", name);
}

function checkPacked(context) {
  const file = packedBinary(context);
  if (!fs.existsSync(file)) throw new Error(`The packed app has no terminal binary (${file}): it would stop before its window opens.`);
  const arch = ARCHES[context.arch];
  if (context.electronPlatformName !== "linux" || !LINUX[arch]) return;
  const head = Buffer.alloc(20);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, head, 0, 20, 0);
  } finally {
    fs.closeSync(fd);
  }
  const elf = head.readUInt32BE(0) === 0x7f454c46;
  if (!elf || head.readUInt16LE(18) !== LINUX[arch][1]) throw new Error(`The packed app's terminal binary (${file}) isn't a Linux ${arch} one.`);
}

exports.before = (context) => {
  const arch = ARCHES[context.arch];
  if (context.electronPlatformName === "darwin" && arch) fetchFor(context.packager.projectDir, arch);
  if (context.electronPlatformName === "linux" && LINUX[arch]) stageLinux(context.packager.projectDir, arch);
};

exports.after = (context) => {
  checkPacked(context);
  if (context.electronPlatformName === "darwin" && process.platform === "darwin") fetchFor(context.packager.projectDir, process.arch);
};
