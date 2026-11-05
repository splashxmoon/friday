// What every first screen downloads before it can draw: app.js and the chunks it imports statically (the eager closure), built
// as the production build builds it. The Markdown and motion stack behind an answer (~300 KB packed) once slipped into it through
// one static import (Teammates.tsx -> message.tsx), doubling the first load between Oct 22 and Nov 4 2026 (327 -> 637 KB
// brotli). These keep it out, and keep the whole first load under a budget. Re-measure in detail: engineering/PERF.md.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { brotliCompressSync, constants } from "node:zlib";
import { build, type Metafile } from "esbuild";
import { clientBuildOptions } from "../src/client-build.js";

type Load = { kb: number; modules: string[] };

/**
 * Brotli KB and modules of app.js's eager closure (`first`), and of that with the session screen's chunk and its static imports
 * (`session`: what a session link waits on), for one edition.
 */
async function loads(edition: "hosted" | "local"): Promise<{ first: Load; session: Load }> {
  const was = process.env.FRIDAY_EDITION;
  if (edition === "local") process.env.FRIDAY_EDITION = "local";
  else delete process.env.FRIDAY_EDITION;
  try {
    const out = path.resolve("desktop/.bundle-test");
    const r = await build({ ...clientBuildOptions(out, false), metafile: true, write: false });
    const rel = (p: string) => path.relative(out, path.resolve(p));
    const outputs = new Map<string, Metafile["outputs"][string]>(Object.entries(r.metafile!.outputs).map(([k, v]) => [rel(k), v]));
    const files = new Map(r.outputFiles!.map((f) => [path.relative(out, f.path), f.contents]));
    const closure = (from: string[]): Load => {
      const seen = new Set<string>();
      const walk = (p: string) => {
        if (seen.has(p)) return;
        seen.add(p);
        for (const i of outputs.get(p)?.imports ?? []) if (i.kind === "import-statement") walk(rel(i.path));
      };
      from.forEach(walk);
      let bytes = 0;
      const modules = new Set<string>();
      for (const p of seen) {
        bytes += brotliCompressSync(files.get(p)!, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
        for (const m of Object.keys(outputs.get(p)!.inputs)) modules.add(m);
      }
      return { kb: bytes / 1024, modules: [...modules] };
    };
    const sessionChunk = [...outputs].find(([k, v]) => k.endsWith(".js") && v.entryPoint?.endsWith("client/SessionView.tsx"))?.[0];
    assert.ok(sessionChunk, "the session screen is a chunk of its own");
    return { first: closure(["app.js"]), session: closure(["app.js", sessionChunk!]) };
  } finally {
    if (was === undefined) delete process.env.FRIDAY_EDITION;
    else process.env.FRIDAY_EDITION = was;
  }
}

// Each loads with the session screen (or later), never with the app itself.
const LATER = [/node_modules\/streamdown\//, /node_modules\/parse5\//, /node_modules\/marked\//, /node_modules\/framer-motion\//, /node_modules\/katex\//, /node_modules\/@codemirror\//, /src\/client\/AnswerParts\.tsx$/, /src\/client\/Activity\.tsx$/, /src\/client\/Settings\.tsx$/, /node_modules\/qrcode-generator\//];

for (const edition of ["hosted", "local"] as const) {
  test(`${edition}: the first load has no answer rendering, motion, editor or Settings page in it, a session's has no CodeMirror, and both stay under budget`, async (t) => {
    const { first, session } = await loads(edition);
    const { kb, modules } = first;
    t.diagnostic(`app.js first load: ${kb.toFixed(1)} KB brotli, ${modules.length} modules; with the session screen ${session.kb.toFixed(1)} KB`);
    for (const re of LATER) assert.deepEqual(modules.filter((m) => re.test(m)).slice(0, 3), [], `${re} is in app.js's first load: import it lazily (see lazy-answer.tsx)`);
    // Brotli at the build's quality 11 (src/pack-built.ts). Nov 4 2026, merged with build/e2e-hardening: 435 KB hosted, 434 KB local (663 KB before). Raise it only on purpose.
    assert.ok(kb < 460, `app.js and its static imports are ${kb.toFixed(0)} KB brotli, over the 460 KB budget`);
    // A session link waits on the session screen too: CodeMirror (~150 KB packed) loads with the first file opened, not here
    // (mirror-editor.tsx). Nov 4 2026, merged with build/e2e-hardening: 890 KB hosted (1,048 KB before; Oct 22: 710 KB).
    assert.deepEqual(session.modules.filter((m) => /node_modules\/@codemirror\//.test(m)).slice(0, 3), [], "CodeMirror is in the session screen's first load: keep it in mirror-editor.tsx, loaded lazily");
    assert.ok(session.kb < 920, `a session screen's first load is ${session.kb.toFixed(0)} KB brotli, over the 920 KB budget`);
  });
}
