/**
 * The terminal's pty module, for the chip each Mac app is packaged for.
 *
 * npm installs its binary for this machine's chip only, and one Mac build makes both an Apple Silicon and an Intel app, so
 * each would otherwise ship this machine's. So before each Mac app is packed, the binary for its chip is fetched in its place,
 * and after, this machine's is put back. It's a Node-API binary, so the same one loads in Node and in any Electron.
 * electron-builder runs it through before-pack.cjs and after-pack.cjs (package.json "build"); Linux and Windows keep their own.
 */
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const ARCHES = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64" };

function fetchFor(projectDir, arch) {
  const dir = path.join(projectDir, "node_modules", "@homebridge", "node-pty-prebuilt-multiarch");
  const bin = require.resolve("prebuild-install/bin.js", { paths: [dir, projectDir] });
  execFileSync(process.execPath, [bin, `--arch=${arch}`, "--platform=darwin"], { cwd: dir, stdio: "inherit" });
}

exports.before = (context) => {
  const arch = ARCHES[context.arch];
  if (context.electronPlatformName === "darwin" && arch) fetchFor(context.packager.projectDir, arch);
};

exports.after = (context) => {
  if (context.electronPlatformName === "darwin" && process.platform === "darwin") fetchFor(context.packager.projectDir, process.arch);
};
