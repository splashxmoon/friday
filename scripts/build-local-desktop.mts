import { execFileSync } from "node:child_process";
/**
 * The open-source edition's desktop app, built into dist/ for Electron (src/local/desktop.ts):
 *   dist/client/   the page, built ahead so the app needs no bundler
 *   dist/public/   index.html, style.css and the rest of public/, the stylesheet minified
 *   dist/main.mjs  Electron's main process: the desktop shell and the whole local server, in one file
 *
 *   npm run desktop        build, then open it
 *   npm run desktop:dist   build, then package installers into release/ (electron-builder)
 */
import { build, transform } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
process.env.FRIDAY_EDITION = "local";
const { clientBuildOptions } = await import("../src/client-build.js");

// Friday's own sign-in apps (src/runner/builtin-apps.ts), from a file on the building computer and never from the source:
// ~/.friday-build/builtin-apps.json, or FRIDAY_BUILTIN_APPS_FILE, as { "GOOGLE": { "id": "…", "secret": "…" } }. None, and the
// app asks for an app of the person's own, as before.
const appsFile = process.env.FRIDAY_BUILTIN_APPS_FILE || path.join(os.homedir(), ".friday-build", "builtin-apps.json");
let builtInApps = "{}";
if (existsSync(appsFile)) {
  const parsed = JSON.parse(readFileSync(appsFile, "utf8"));
  builtInApps = JSON.stringify(parsed);
  console.log(`Built-in sign-in apps: ${Object.keys(parsed).join(", ") || "none"}`);
}

await rm(dist, { recursive: true, force: true });
await build(clientBuildOptions(path.join(dist, "client"), true));
// public/ beside it, its stylesheet without its comments and indentation (whitespace only, as src/css-minify.ts makes the hosted
// build's, which the export leaves out: no rule merged, reordered or rewritten), as the hosted build serves it: 1.33 MB
// as written, every first screen waited for all of it (spec 13). The app serves this copy (PUBLIC_DIR, set in main.mjs's banner);
// the folder as written stays as it is for `npx friday`.
await cp(path.join(root, "public"), path.join(dist, "public"), { recursive: true });
{
  const css = path.join(dist, "public", "style.css");
  await writeFile(css, (await transform(await readFile(css, "utf8"), { loader: "css", minifyWhitespace: true, logLevel: "silent" })).code);
}
// The Friday extension for the optional VS Code (src/vscode-ext/): plain files beside main.mjs, where src/runner/vscode.ts looks.
await cp(path.join(root, "src", "vscode-ext", "friday"), path.join(dist, "vscode-ext", "friday"), { recursive: true });
// VS Code itself, packed per platform into build/code-server for electron-builder's extraResources (scripts/vscode-bundle.mts).
execFileSync(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), path.join(root, "scripts", "vscode-bundle.mts")], { cwd: root, stdio: "inherit" });
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
  define: { __FRIDAY_BUILT_IN_APPS__: builtInApps },
  // A require() inside an ES module, for the CommonJS packages bundled code reaches for. And the page's files from dist/public, the
  // stylesheet minified (above), before anything reads where they are; one set from outside (a test) still decides.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url); import { fileURLToPath as __fu } from 'node:url'; import { existsSync as __ex } from 'node:fs'; { const p = __fu(new URL('./public', import.meta.url)); if (!process.env.PUBLIC_DIR && __ex(p)) process.env.PUBLIC_DIR = p; }",
  },
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
// Linux: npm leaves the terminal's binary in the module's prebuilds/, under Node's names, and Electron looks in build/Release, so
// `npm run desktop` stopped before its window opened. Its own Linux binary (the same Node-API file under every name) is put
// there, as packing does for a release (build/pty-arch.cjs).
if (process.platform === "linux") {
  const pty = path.join(root, "node_modules", "@homebridge", "node-pty-prebuilt-multiarch");
  const release = path.join(pty, "build", "Release", "pty.node");
  const from = path.join(pty, "prebuilds", `linux-${process.arch === "arm" ? "arm" : process.arch}`);
  if (!existsSync(release) && existsSync(from)) {
    const names = readdirSync(from).filter((f) => /^node\.abi\d+\.node$/.test(f)).sort();
    const name = names.includes(`node.abi${process.versions.modules}.node`) ? `node.abi${process.versions.modules}.node` : names.at(-1);
    if (name) {
      mkdirSync(path.dirname(release), { recursive: true });
      copyFileSync(path.join(from, name), release);
    }
  }
}
console.log("Desktop build ready in dist/");
