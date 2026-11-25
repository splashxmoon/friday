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

/**
 * CSS modules (the aicss components' `*.module.css`) with their class and keyframe names as `<file>_<name>`, readable and stable,
 * whatever the rest of the bundle's names are minified to. Minified alongside everything else, they were two letters, and one of
 * them landed on "ba", the literal class bot-avatars puts on its canvas, which then took the module's position:absolute and flew to
 * the corner of the page. Each module is scoped on its own (esbuild's own local-css, unminified), and its CSS joins the bundle as
 * ordinary CSS with its names already given; the component gets the same map of names it always did.
 */
const cssModules: Plugin = {
  name: "css-modules-named",
  setup(b) {
    const scoped = new Map<string, string>();
    b.onResolve({ filter: /\.module\.css$/ }, async (args) => {
      if (args.pluginData?.plain) return undefined;
      const r = await b.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, importer: args.importer, pluginData: { plain: true } });
      return r.errors.length ? { errors: r.errors } : { path: r.path, namespace: "css-module" };
    });
    b.onLoad({ filter: /.*/, namespace: "css-module" }, async (args) => {
      // Loaded here, not with the file: the packaged app's server imports this file and ships without esbuild.
      const { build } = await import("esbuild");
      const out = await build({
        stdin: { contents: `import names from ${JSON.stringify(args.path)}; globalThis.__cssNames = names;`, resolveDir: path.dirname(args.path), loader: "js" },
        bundle: true,
        write: false,
        format: "iife",
        outdir: "out",
        loader: { ".module.css": "local-css" },
        minifyWhitespace: true,
        logLevel: "silent",
      });
      const js = out.outputFiles.find((f) => f.path.endsWith(".js"))!.text;
      const css = out.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "";
      const box: { __cssNames?: Record<string, string> } = {};
      new Function("globalThis", js)(box);
      scoped.set(args.path, css);
      return { contents: `import ${JSON.stringify(`${args.path}?scoped`)}; export default ${JSON.stringify(box.__cssNames ?? {})};`, loader: "js", resolveDir: path.dirname(args.path), watchFiles: [args.path] };
    });
    b.onResolve({ filter: /\?scoped$/ }, (args) => ({ path: args.path, namespace: "css-module-scoped" }));
    b.onLoad({ filter: /.*/, namespace: "css-module-scoped" }, (args) => ({ contents: scoped.get(args.path.replace(/\?scoped$/, "")) ?? "", loader: "css", resolveDir: path.dirname(args.path) }));
  },
};

export function clientBuildOptions(outdir: string, write: boolean): BuildOptions {
  return {
    plugins: [clientAlias, cssModules],
    // replay.js: a recording or watch link's page on its own, a fraction of app.js and its chunks (src/fast-load.ts, shellRoute).
    // The open-source edition (FRIDAY_EDITION=local, src/local/main.ts) is the app alone, from its own entry.
    entryPoints:
      // And voice input's worker (voice-worker.ts): Whisper on this computer, loaded only when the mic is first pressed.
      { app: path.join(here, "client", "local-main.tsx"), "voice-worker": path.join(here, "client", "voice-worker.ts") },
    bundle: true,
    format: "esm",
    splitting: true,
    target: "es2022",
    jsx: "automatic",
    // Names minified too (spec 13: 1,984 KB at start, whitespace minified only), with CSS modules' class names kept as they were
    // written (cssModules above): minified with the rest they were two letters, and one of them clashed with a library's own class.
    minifyWhitespace: true,
    minifySyntax: true,
    minifyIdentifiers: true,
    outdir,
    entryNames: "[name]",
    chunkNames: "chunks/[name]-[hash]",
    assetNames: "assets/[name]-[hash]",
    // The aicss components style themselves with CSS modules; class names are scoped at build time (cssModules).
    loader: { ".woff": "file", ".woff2": "file", ".ttf": "file", ".module.css": "local-css" },
    define: { "process.env.NODE_ENV": '"production"' },
    write,
    logLevel: "error",
  };
}
