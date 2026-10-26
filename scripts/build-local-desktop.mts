/**
 * The open-source edition's desktop app, built into dist/ for Electron (src/local/desktop.ts):
 *   dist/client/   the page, built ahead so the app needs no bundler
 *   dist/main.mjs  Electron's main process: the desktop shell and the whole local server, in one file
 *
 *   npm run desktop        build, then open it
 *   npm run desktop:dist   build, then package installers into release/ (electron-builder)
 */
import { build } from "esbuild";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
process.env.FRIDAY_EDITION = "local";
const { clientBuildOptions } = await import("../src/client-build.js");

await rm(dist, { recursive: true, force: true });
await build(clientBuildOptions(path.join(dist, "client"), true));
await build({
  entryPoints: [path.join(root, "src/local/desktop.ts")],
  outfile: path.join(dist, "main.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Everything bundled, so the app ships one file instead of every dependency (the page's are already in dist/client), but
  // Electron, the terminal's native pty module, which the runner loads by name and the app ships beside this file, and esbuild,
  // which only builds the page when there's no prebuilt one, so a packaged app never loads it.
  external: ["electron", "@homebridge/node-pty-prebuilt-multiarch", "esbuild"],
  // A require() inside an ES module, for the CommonJS packages bundled code reaches for.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
});
// The page's bridge (src/local/preload.ts): CommonJS, which a sandboxed preload has to be.
await build({
  entryPoints: [path.join(root, "src/local/preload.ts")],
  outfile: path.join(dist, "preload.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  logLevel: "warning",
});
console.log("Desktop build ready in dist/");
