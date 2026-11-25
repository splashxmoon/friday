import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { clientBuildOptions } from "../src/client-build.js";

/**
 * The client is built with its names minified (spec 13, Arun 2026-11-24: "Go all out and fix these problems": 1,984 KB at start,
 * whitespace minified only), and CSS modules keep their class and keyframe names as written, `<file>_<name>`: minified with the
 * rest they were two letters, and "ba" was the class bot-avatars puts on its canvas.
 */
test("names are minified, and a CSS module's classes and keyframes keep their own names, the same in its CSS and its map", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-client-names-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entry = path.join(dir, "entry.tsx");
  const orb = path.join(process.cwd(), "src", "client", "components", "aicss", "Orb.module.css");
  await writeFile(entry, `import styles from ${JSON.stringify(orb)};\nfunction aLongDescriptiveFunctionName(x: number) { const someLongLocalName = x * 2; return styles.root + someLongLocalName; }\n(globalThis as { names?: unknown }).names = { styles, f: aLongDescriptiveFunctionName };\n`);
  const r = await build({ ...clientBuildOptions(path.join(dir, "out"), false), entryPoints: { app: entry }, splitting: false });
  const js = r.outputFiles!.find((f) => f.path.endsWith("app.js"))!.text;
  const css = r.outputFiles!.find((f) => f.path.endsWith(".css"))!.text;
  assert.doesNotMatch(js, /someLongLocalName/, "local names minified");
  assert.match(css, /\.Orb_root\b/, "the class as written, scoped by its file");
  assert.match(css, /@keyframes Orb_orb-wave\b/, "its keyframes too");
  assert.doesNotMatch(css, /\.[a-z]{1,2}\{/, "no two-letter class from the module");
  const box: { names?: { styles: Record<string, string> } } = {};
  new Function("globalThis", js)(box);
  assert.equal(box.names!.styles.root, "Orb_root", "the map the component reads names the same class");
  for (const name of Object.values(box.names!.styles)) for (const one of name.split(" ")) assert.ok(css.includes(`.${one}`) || css.includes(`@keyframes ${one}`), `${one} is in the CSS`);
});
