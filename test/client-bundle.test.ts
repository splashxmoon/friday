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
const LATER = [/node_modules\/streamdown\//, /node_modules\/parse5\//, /node_modules\/marked\//, /node_modules\/framer-motion\//, /node_modules\/katex\//, /node_modules\/@codemirror\//, /src\/client\/AnswerParts\.tsx$/, /src\/client\/Activity\.tsx$/, /src\/client\/Settings\.tsx$/, /node_modules\/qrcode-generator\//, /src\/client\/(TeammatePage|TeamBrief|CrewSkills|RunReview)\.tsx$/];

for (const edition of ["hosted", "local"] as const) {
  test(`${edition}: the first load has no answer rendering, motion, editor or Settings page in it, a session's has no CodeMirror, and both stay under budget`, async (t) => {
    const { first, session } = await loads(edition);
    const { kb, modules } = first;
    t.diagnostic(`app.js first load: ${kb.toFixed(1)} KB brotli, ${modules.length} modules; with the session screen ${session.kb.toFixed(1)} KB`);
    for (const re of LATER) assert.deepEqual(modules.filter((m) => re.test(m)).slice(0, 3), [], `${re} is in app.js's first load: import it lazily (see lazy-answer.tsx)`);
    // Brotli at the build's quality 11 (src/pack-built.ts). Nov 5 2026: 427 KB hosted and local (443 before the teammate page, team
    // brief, skills and run review left it). Raise it only on purpose. Nov 9 2026: 444.8 hosted, 446.4 local (444.4 before), with
    // voice input's mic and key in the home box (VoiceMic.tsx, ~2 KB; its engine and the model's worker load at the first press):
    // raised to 448 on purpose. Nov 10 2026: 446.8 hosted, 448.7 local (447.9 before), with Qwen's own mark in place of a bot
    // (BrandMarks.tsx, one path of ~1.9 KB, shown wherever a tool is named; Arun: "use this for the qwen code icon"), the sign-in
    // notes and the ACP registry already moved to chunks of their own: raised to 450 on purpose. Nov 11 2026: 449.2 hosted, 450.8
    // local (448.5 and 450.1 before 3A), with the production sidebar's rail and agents list in the open-source build (Sidebar.tsx
    // OssRail, AgentsSection) and a lead's hand-outs as one line (Teammates.tsx TeamTalk); the Agents page, crew setup and the
    // plan are chunks of their own, and the plain words for a teammate's ask stay with the Agents page: raised to 452 on purpose.
    assert.ok(kb < 452, `app.js and its static imports are ${kb.toFixed(0)} KB brotli, over the 452 KB budget`);
    // A session link waits on the session screen too: CodeMirror (~150 KB packed) loads with the first file opened, not here
    // (mirror-editor.tsx). Nov 4 2026, merged with build/e2e-hardening: 890 KB hosted (1,048 KB before; Oct 22: 710 KB).
    assert.deepEqual(session.modules.filter((m) => /node_modules\/@codemirror\//.test(m)).slice(0, 3), [], "CodeMirror is in the session screen's first load: keep it in mirror-editor.tsx, loaded lazily");
    // Nov 8 2026: 922 KB hosted, 919 local, with the folder picker's sources and rows (Workspace.tsx, 0.2.19): raised to 930 on purpose.
    // Nov 11 2026: 934.6 hosted, 931.8 local (930.6 and 927.6 before), with a crew chat's folded steps, result card and plain-words
    // permission card (Activity.tsx; a chunk of their own saved 0.3 KB and flashed the old card while it loaded): raised to 936.
    // Nov 11 2026, later: 936.0 hosted, 933.4 local, with a run's NO_UPDATE said in words and a lead's hand-out lines able to move a
    // piece (Activity.tsx, AgentTalk.tsx); the plan and its actions load on their own: raised to 940 on purpose.
    assert.ok(session.kb < 940, `a session screen's first load is ${session.kb.toFixed(0)} KB brotli, over the 940 KB budget`);
  });
}
