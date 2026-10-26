import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildOptions, Plugin } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CLIENT_ENTRY = path.join(here, "client", "main.tsx");

/**
 * esbuild options for the browser bundle, shared by the dev server (built in
 * memory at startup) and the desktop build (written to disk). Code-split so
 * heavy pieces like syntax highlighting load only when used.
 */
/**
 * `@/…` is src/client/… (tsconfig.json paths). esbuild applies a tsconfig's paths only to files outside node_modules, and run as
 * `npx github:splashxmoon/friday` the whole app is inside node_modules, so every `@/` import failed to resolve there: resolved
 * here instead, wherever the code sits.
 */
const clientAlias: Plugin = {
  name: "client-alias",
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => build.resolve(`./${args.path.slice(2)}`, { resolveDir: path.join(here, "client"), kind: args.kind, importer: args.importer }));
  },
};

export function clientBuildOptions(outdir: string, write: boolean): BuildOptions {
  return {
    plugins: [clientAlias],
    // replay.js: a recording or watch link's page on its own, a fraction of app.js and its chunks (src/fast-load.ts, shellRoute).
    // The open-source edition (FRIDAY_EDITION=local, src/local/main.ts) is the app alone, from its own entry.
    entryPoints:
      { app: path.join(here, "client", "local-main.tsx") },
    bundle: true,
    format: "esm",
    splitting: true,
    target: "es2022",
    jsx: "automatic",
    // Identifiers stay unminified: minified CSS-module class names are two letters, and one of them
    // landed on "ba", the literal class bot-avatars puts on its canvas, which then took the module's
    // position:absolute and flew to the corner of the page.
    minifyWhitespace: true,
    minifySyntax: true,
    outdir,
    entryNames: "[name]",
    chunkNames: "chunks/[name]-[hash]",
    assetNames: "assets/[name]-[hash]",
    // The aicss components style themselves with CSS modules; class names are scoped at build time.
    loader: { ".woff": "file", ".woff2": "file", ".ttf": "file", ".module.css": "local-css" },
    define: { "process.env.NODE_ENV": '"production"' },
    write,
    logLevel: "error",
  };
}
